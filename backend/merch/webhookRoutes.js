import express from 'express';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import configService from './configService.js';
import stripeLib from 'stripe';

const logger = createModuleLogger('merch:webhook');

const isDev = process.env.NODE_ENV !== 'production';

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK SECURITY
// ─────────────────────────────────────────────────────────────────────────────

const STRIPE_IP_RANGES = [
    '3.18.12.63',
    '3.69.109.8',
    '3.120.168.93',
    '3.130.192.231',
    '13.235.14.237',
    '13.235.122.149',
    '18.211.135.69',
    '35.154.171.200',
    '35.157.207.129',
    '52.15.183.38',
    '54.88.130.119',
    '54.88.130.237',
    '54.187.174.169',
    '54.187.205.235',
    '54.187.216.72'
];

function verifyStripeIp(req, res, next) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const normalizedIp = clientIp?.replace('::ffff:', '') || clientIp;

    if (isDev) {
        if (!STRIPE_IP_RANGES.includes(normalizedIp)) {
            logger.warn('Webhook from non-Stripe IP (dev mode - allowed)', { clientIp: normalizedIp });
        }
        return next();
    }

    if (!STRIPE_IP_RANGES.includes(normalizedIp)) {
        logger.error('Webhook rejected: unauthorized source IP', {
            clientIp: normalizedIp,
            path: req.path
        });
        return res.status(403).send('Unauthorized source');
    }

    next();
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG CACHING (Performance optimization)
// ─────────────────────────────────────────────────────────────────────────────

let cachedStripeConfigs = null;
let configCacheTime = null;
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadStripeConfigs() {
    if (cachedStripeConfigs && configCacheTime && (Date.now() - configCacheTime) < CONFIG_CACHE_TTL_MS) {
        return cachedStripeConfigs;
    }

    const regions = await configService.getAllRegions();
    cachedStripeConfigs = {};

    for (const region of regions) {
        const config = await configService.getIntegration('stripe', region.code);
        if (config?.webhook_secret && config?.secret_key) {
            cachedStripeConfigs[region.code] = {
                ...config,
                regionCode: region.code,
                stripe: stripeLib(config.secret_key)
            };
        }
    }

    configCacheTime = Date.now();
    logger.info('Stripe configs cached', { regions: Object.keys(cachedStripeConfigs).length });
    return cachedStripeConfigs;
}

// ─────────────────────────────────────────────────────────────────────────────
// FULFILLMENT STUB (async fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

async function triggerFulfillment(order, session) {
    try {
        logger.info('Fulfillment triggered (async)', {
            orderId: order.id,
            userId: order.user_id,
            dropId: order.drop_id,
            amount: order.total_paid_cents
        });
    } catch (fulfillErr) {
        logger.error('Fulfillment failed - manual action required', {
            orderId: order.id,
            error: fulfillErr.message
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();

router.post('/stripe', verifyStripeIp, express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    if (!sig) {
        logger.error('Missing stripe-signature header', { ip: clientIp });
        return res.status(400).send('Missing signature');
    }

    let configs;
    try {
        configs = await loadStripeConfigs();
    } catch (cacheErr) {
        logger.error('Failed to load Stripe configs', { error: cacheErr.message });
        return res.status(500).send('Config error');
    }

    let event = null;
    let verifiedConfig = null;
    const WEBHOOK_TOLERANCE = 300;

    for (const [regionCode, config] of Object.entries(configs)) {
        try {
            event = config.stripe.webhooks.constructEvent(
                req.body,
                sig,
                config.webhook_secret,
                { tolerance: WEBHOOK_TOLERANCE }
            );
            verifiedConfig = config;
            break;
        } catch (err) {
            continue;
        }
    }

    if (!event) {
        logger.error('Webhook verification failed for all regions', {
            ip: clientIp,
            bodyLength: req.body?.length
        });
        return res.status(400).send('Webhook Error: Invalid signature or expired');
    }

    logger.info('Webhook verified', {
        eventId: event.id,
        type: event.type,
        region: verifiedConfig.regionCode,
        ip: clientIp
    });

    // ─────────────────────────────────────────────────────────────────
    // IDEMPOTENCY CHECK
    // ─────────────────────────────────────────────────────────────────

    try {
        const existing = await pool.query(
            'SELECT processed_at FROM processed_events WHERE event_id = $1',
            [event.id]
        );

        if (existing.rows.length > 0) {
            logger.info('Duplicate event - already processed', {
                eventId: event.id,
                firstProcessed: existing.rows[0].processed_at
            });
            return res.json({ received: true, idempotency: 'skipped' });
        }
    } catch (dbErr) {
        logger.error('Idempotency check failed', { eventId: event.id, error: dbErr.message });
        return res.status(500).send('Database error');
    }

    // ─────────────────────────────────────────────────────────────────
    // EVENT PROCESSING
    // ─────────────────────────────────────────────────────────────────

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const metadata = session.metadata || {};

            logger.info('Processing successful payment', {
                eventId: event.id,
                sessionId: session.id,
                paymentIntent: session.payment_intent,
                amount: session.amount_total,
                currency: session.currency,
                customerEmail: session.customer_details?.email,
                region: metadata.region_code,
                userId: metadata.user_id,
                dropId: metadata.drop_id
            });

            const result = await client.query(
                `UPDATE merch_orders
                 SET status = 'paid',
                     paid_at = NOW(),
                     stripe_payment_intent_id = $1,
                     total_paid_cents = $2,
                     user_id = COALESCE(user_id, $3),
                     drop_id = COALESCE(drop_id, $4),
                     selections = COALESCE(selections, $5::jsonb),
                     region_id = COALESCE(region_id, (SELECT id FROM regions WHERE code = $6))
                 WHERE stripe_checkout_session_id = $7
                 AND status != 'paid'
                 RETURNING id, user_id, total_paid_cents, drop_id`,
                [
                    session.payment_intent,
                    session.amount_total,
                    metadata.user_id,
                    metadata.drop_id,
                    metadata.selections,
                    metadata.region_code,
                    session.id
                ]
            );

            if (result.rowCount === 0) {
                const alreadyPaid = await client.query(
                    'SELECT id FROM merch_orders WHERE stripe_checkout_session_id = $1 AND status = $2',
                    [session.id, 'paid']
                );

                if (alreadyPaid.rowCount > 0) {
                    logger.info('Order already paid - idempotent success', { eventId: event.id, sessionId: session.id });
                } else {
                    logger.error('CRITICAL: Payment received but no matching order found - manual reconciliation required', {
                        eventId: event.id,
                        sessionId: session.id,
                        metadata,
                        amount: session.amount_total
                    });
                }
            } else {
                const order = result.rows[0];
                logger.info('Order marked as paid', {
                    eventId: event.id,
                    orderId: order.id,
                    userId: order.user_id,
                    dropId: order.drop_id,
                    amount: order.total_paid_cents
                });

                const io = req.app.get('io');
                if (io) {
                    io.emit('merch_payment_confirmed', {
                        event_id: event.id,
                        session_id: session.id,
                        order_id: order.id,
                        user_id: order.user_id,
                        drop_id: order.drop_id,
                        amount: order.total_paid_cents,
                        timestamp: new Date().toISOString()
                    });
                }

                triggerFulfillment(order, session);
            }
        }

        else if (event.type === 'checkout.session.expired') {
            const session = event.data.object;
            const metadata = session.metadata || {};

            logger.info('Checkout expired (lost slot)', {
                eventId: event.id,
                sessionId: session.id,
                userId: metadata.user_id,
                dropId: metadata.drop_id,
                reason: 'timeout'
            });

            const io = req.app.get('io');
            if (io) {
                io.emit('merch_checkout_expired', {
                    event_id: event.id,
                    session_id: session.id,
                    drop_id: metadata.drop_id,
                    user_id: metadata.user_id
                });
            }
        }

        else if (event.type === 'payment_intent.payment_failed') {
            const paymentIntent = event.data.object;

            logger.warn('Payment failed', {
                eventId: event.id,
                paymentIntentId: paymentIntent.id,
                error: paymentIntent.last_payment_error?.message,
                code: paymentIntent.last_payment_error?.code
            });
        }

        else if (event.type === 'charge.refunded') {
            const charge = event.data.object;
            const paymentIntentId = charge.payment_intent;

            logger.info('Refund processed', {
                eventId: event.id,
                chargeId: charge.id,
                paymentIntentId,
                amount: charge.amount_refunded,
                reason: charge.refund_reason
            });

            if (paymentIntentId) {
                const result = await client.query(
                    `UPDATE merch_orders
                     SET status = 'refunded',
                         refunded_at = NOW(),
                         refund_amount_cents = $1,
                         refund_reason = $2
                     WHERE stripe_payment_intent_id = $3
                     AND status = 'paid'
                     RETURNING id, user_id, drop_id`,
                    [charge.amount_refunded, charge.refund_reason, paymentIntentId]
                );

                if (result.rowCount > 0) {
                    const order = result.rows[0];
                    logger.info('Order marked as refunded - fulfill reversal required', {
                        eventId: event.id,
                        orderId: order.id,
                        userId: order.user_id,
                        amount: charge.amount_refunded
                    });

                    const io = req.app.get('io');
                    if (io) {
                        io.emit('merch_refund_processed', {
                            event_id: event.id,
                            order_id: order.id,
                            user_id: order.user_id,
                            amount: charge.amount_refunded,
                            requires_cancellation: true
                        });
                    }
                }
            }
        }

        else if (event.type === 'checkout.session.async_payment_succeeded') {
            logger.info('Async payment succeeded - processing', { eventId: event.id });
        }

        else {
            logger.debug('Unhandled event type (ok)', { eventId: event.id, type: event.type });
        }

        await client.query(
            `INSERT INTO processed_events (event_id, event_type, session_id, processed_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (event_id) DO NOTHING`,
            [event.id, event.type, event.data.object?.id]
        );

        await client.query('COMMIT');
        res.json({ received: true, processed: true, region: verifiedConfig.regionCode });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        logger.error('Webhook processing failed', {
            eventId: event?.id,
            type: event?.type,
            error: err.message,
            ip: clientIp
        });

        res.status(500).send('Processing error - will retry');
    } finally {
        client.release();
    }
});

export default router;
