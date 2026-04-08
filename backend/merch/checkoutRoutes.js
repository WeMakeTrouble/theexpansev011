import express from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId from '../utils/hexIdGenerator.js';
import configService from './configService.js';
import stripeLib from 'stripe';

const logger = createModuleLogger('merch:checkout');

const CHECKOUT_EXPIRY_SECONDS = Number(process.env.CHECKOUT_EXPIRY_SECONDS) || 900;
const CHECKOUT_EXPIRY_MINUTES = Math.floor(CHECKOUT_EXPIRY_SECONDS / 60);
const STRIPE_TIMEOUT_MS = 10000;

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────────────────────────────────────

const USER_ERRORS = {
    'Drop not available or sold out': 'This drop is no longer available.',
    'Just sold out': 'Sold out — inventory changed while processing.',
    'Region not available': 'Shipping region not available for this drop.',
    'Invalid selections': 'Some options are invalid or missing.',
    'Payment processor not configured': 'Checkout temporarily unavailable.',
    'Payment processor error': 'Payment service error. Please try again.',
    'Authentication required': 'Please log in to purchase.',
    'default': 'Checkout failed. Please try again or contact support.'
};

function normalizeError(err) {
    const msg = err.message || '';
    for (const [key, val] of Object.entries(USER_ERRORS)) {
        if (msg.includes(key)) return val;
    }
    logger.warn('Unknown error type in checkout', { errorMessage: msg });
    return USER_ERRORS.default;
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
}

const checkoutLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.user_id || getClientIp(req),
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many checkout attempts. Please wait.',
            retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
    }
});

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function validateAndCalculate(client, dropId, selections) {
    const groupList = await client.query(
        `SELECT og.id, og.group_name, og.is_required
         FROM merch_option_groups og
         WHERE og.drop_id = $1`,
        [dropId]
    );

    let totalUpcharge = 0;
    const validatedSelections = {};

    for (const group of groupList.rows) {
        const submittedValue = selections[group.group_name];

        if (group.is_required && !submittedValue) {
            throw new Error(`Invalid selections: ${group.group_name} is required`);
        }

        if (submittedValue) {
            const validOption = await client.query(
                `SELECT upcharge_cents FROM merch_options
                 WHERE group_id = $1 AND option_value = $2`,
                [group.id, submittedValue]
            );
            if (!validOption.rows[0]) {
                throw new Error(`Invalid selections: ${group.group_name} = ${submittedValue}`);
            }
            totalUpcharge += validOption.rows[0].upcharge_cents;
            validatedSelections[group.group_name] = submittedValue;
        }
    }

    return { totalUpcharge, validatedSelections };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────────────────────────────────────

router.post('/create-session', checkoutLimiter, async (req, res) => {
    if (!req.user?.user_id) {
        logger.warn('Checkout attempted without authentication', { ip: getClientIp(req) });
        return res.status(401).json({ error: USER_ERRORS['Authentication required'] });
    }

    const { drop_id, region_code, selections } = req.body;

    if (!drop_id || !region_code || !selections || typeof selections !== 'object') {
        logger.info('Invalid checkout payload', {
            user_id: req.user.user_id,
            ip: getClientIp(req),
            body: req.body
        });
        return res.status(400).json({ error: 'Invalid request: drop_id, region_code, and selections required' });
    }

    const client = await pool.connect();
    let reservedInventory = false;
    let drop, newRemaining, basePrice, pricing, validatedSelections, totalUpcharge;

    try {
        // ─────────────────────────────────────────────────────────────────
        // PHASE 1: Atomic Inventory Reservation (Fast Lock)
        // ─────────────────────────────────────────────────────────────────
        await client.query('BEGIN');

        const dropResult = await client.query(
            `SELECT * FROM merch_drops
             WHERE id = $1 AND status = 'live' AND units_remaining > 0
             FOR UPDATE`,
            [drop_id]
        );
        if (!dropResult.rows[0]) {
            throw new Error('Drop not available or sold out');
        }
        drop = dropResult.rows[0];

        ({ totalUpcharge, validatedSelections } = await validateAndCalculate(client, drop_id, selections));

        const pricingResult = await client.query(
            `SELECT dp.*, r.id as region_id, r.code, r.name
             FROM merch_drop_pricing dp
             JOIN regions r ON r.id = dp.region_id
             WHERE dp.drop_id = $1 AND r.code = $2
             FOR UPDATE`,
            [drop_id, region_code]
        );
        if (!pricingResult.rows[0]) {
            throw new Error('Region not available');
        }
        pricing = pricingResult.rows[0];
        basePrice = pricing.price_cents;

        const updateResult = await client.query(
            `UPDATE merch_drops
             SET units_remaining = units_remaining - 1,
                 status = CASE WHEN units_remaining - 1 = 0 THEN 'sold_out' ELSE status END,
                 updated_at = NOW()
             WHERE id = $1 AND units_remaining > 0
             RETURNING units_remaining`,
            [drop_id]
        );
        if (updateResult.rowCount === 0) {
            throw new Error('Just sold out');
        }
        newRemaining = updateResult.rows[0].units_remaining;
        reservedInventory = true;

        await client.query('COMMIT');

        logger.info('Inventory reserved', {
            drop_id,
            user_id: req.user.user_id,
            remaining: newRemaining,
            region: region_code,
            ip: getClientIp(req)
        });

        // ─────────────────────────────────────────────────────────────────
        // PHASE 2: External API Call (No DB Lock)
        // ─────────────────────────────────────────────────────────────────

        const stripeConfig = await configService.getIntegration('stripe', region_code);
        if (!stripeConfig) {
            throw new Error('Payment processor not configured');
        }

        const stripeInstance = stripeLib(stripeConfig.secret_key, {
            timeout: STRIPE_TIMEOUT_MS,
            maxNetworkRetries: 1
        });

        const totalAmount = basePrice + totalUpcharge;
        const idempotencyKey = `checkout-${drop_id}-${req.user.user_id}-${Date.now()}`;

        let session;
        try {
            session = await stripeInstance.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: stripeConfig.currency || 'aud',
                        product: pricing.stripe_product_id,
                        unit_amount: totalAmount,
                    },
                    quantity: 1,
                }],
                mode: 'payment',
                success_url: `${process.env.FRONTEND_URL}/merch/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.FRONTEND_URL}/merch/cancel`,
                metadata: {
                    drop_id: drop_id.toString(),
                    region_code: region_code,
                    selections: JSON.stringify(validatedSelections),
                    user_id: req.user.user_id,
                    internal_total_cents: totalAmount.toString(),
                    idempotency_key: idempotencyKey
                },
                expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRY_SECONDS,
            }, {
                idempotencyKey: idempotencyKey
            });
        } catch (stripeErr) {
            logger.error('Stripe session creation failed', {
                drop_id,
                user_id: req.user.user_id,
                stripeError: stripeErr.message,
                code: stripeErr.code,
                type: stripeErr.type
            });
            throw new Error('Payment processor error');
        }

        // ─────────────────────────────────────────────────────────────────
        // PHASE 2.5: Placeholder Row (Prevents Orphaned Sessions)
        // ─────────────────────────────────────────────────────────────────

        await client.query('BEGIN');
        try {
            const orderId = await generateHexId('merch_order_id', client);
            await client.query(
                `INSERT INTO merch_orders
                 (id, user_id, drop_id, selections, stripe_checkout_session_id, status, base_price_cents, total_upcharge_cents, total_paid_cents, created_at)
                 VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, NOW())
                 ON CONFLICT (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING`,
                [orderId, req.user.user_id, drop_id, JSON.stringify(validatedSelections), session.id, basePrice, totalUpcharge, totalAmount]
            );
            await client.query('COMMIT');
        } catch (placeholderErr) {
            await client.query('ROLLBACK');
            logger.error('Failed to insert placeholder order row', {
                drop_id,
                user_id: req.user.user_id,
                session_id: session.id,
                error: placeholderErr.message
            });
        }

        // ─────────────────────────────────────────────────────────────────
        // PHASE 3: Full Order Update (Fill in remaining fields)
        // ─────────────────────────────────────────────────────────────────

        await client.query('BEGIN');

        try {
            await client.query(
                `UPDATE merch_orders
                 SET region_id = $1,
                     expires_at = NOW() + INTERVAL '${CHECKOUT_EXPIRY_MINUTES} minutes'
                 WHERE stripe_checkout_session_id = $2`,
                [
                    pricing.region_id,
                    session.id
                ]
            );
            await client.query('COMMIT');

            logger.info('Order record updated', {
                drop_id,
                user_id: req.user.user_id,
                session_id: session.id,
                amount: totalAmount
            });

        } catch (insertErr) {
            await client.query('ROLLBACK');

            logger.error('Order update failed but placeholder exists for webhook reconciliation', {
                event: 'ORDER_UPDATE_FAILED',
                drop_id,
                user_id: req.user.user_id,
                session_id: session.id,
                amount: totalAmount,
                placeholderExists: true,
                error: insertErr.message
            });

            res.json({
                session_id: session.id,
                url: session.url,
                expires_at: session.expires_at,
                warning: 'Payment session created. Refresh if status does not update shortly.'
            });
            return;
        }

        // ─────────────────────────────────────────────────────────────────
        // PHASE 4: Side Effects
        // ─────────────────────────────────────────────────────────────────

        const io = req.app.get('io');
        if (io) {
            io.emit('merch_inventory_update', {
                drop_id: drop_id,
                remaining: newRemaining,
                total: drop.total_units,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            session_id: session.id,
            url: session.url,
            expires_at: session.expires_at
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        if (reservedInventory && !err.message.includes('Just sold out')) {
            logger.warn('Lost slot: inventory reserved but checkout failed - slot remains reserved', {
                drop_id,
                user_id: req.user.user_id,
                ip: getClientIp(req),
                error: err.message,
                stage: 'post-reservation-failure'
            });
        }

        const statusCode = err.message.includes('sold out') ? 409 : 400;
        const errorMessage = normalizeError(err);

        logger.error('Checkout failed', {
            drop_id,
            user_id: req.user.user_id,
            ip: getClientIp(req),
            error: err.message,
            statusCode
        });

        res.status(statusCode).json({ error: errorMessage });

    } finally {
        client.release();
    }
});

export default router;
