/**
 * ============================================================================
 * NewsletterService.js — Gronk Mode Newsletter Subscription Service (v011)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Handles the complete newsletter subscription lifecycle for Gronk Mode:
 * subscribe (with double opt-in), confirm, unsubscribe, and SendGrid sync.
 *
 * Gronk Mode is the public-facing email capture surface at pizasukeruton.com.
 * It is entirely separate from COTW user accounts. Newsletter subscribers
 * are stored in `newsletter_subscribers`, never in `users`.
 *
 * FLOW
 * ----
 * 1. User submits email → subscribe() → pending row + confirmation email
 * 2. User clicks email link → confirm() → status confirmed + SendGrid sync
 * 3. User unsubscribes → unsubscribe() → status unsubscribed + SendGrid remove
 *
 * SECURITY
 * --------
 * - Confirmation tokens: crypto.randomBytes(32), stored as SHA-256 hash
 * - Token expiry: 48 hours
 * - No email enumeration: subscribe returns same response for new/existing
 * - Rate limiting handled at route level, not here
 *
 * DEPENDENCIES
 * ------------
 * - @sendgrid/mail — transactional confirmation emails
 * - @sendgrid/client — Contacts API for list management
 * - PostgreSQL pool — newsletter_subscribers table
 * - hexIdGenerator — subscriber_id generation
 *
 * ARCHITECTURAL CONSTRAINTS
 * -------------------------
 * - No external AI APIs
 * - No Math.random() — crypto.randomBytes only
 * - Hex IDs as VARCHAR(7) CHECK (column ~ '^#[0-9A-F]{6}$')
 * - TIMESTAMPTZ with created_at and updated_at on every table
 *
 * LICENCE INTENT: MIT
 * ============================================================================
 */

import crypto from 'crypto';
import sgMail from '@sendgrid/mail';
import sgClient from '@sendgrid/client';
import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';

// ── Initialise SendGrid ────────────────────────────────────────────────────

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
    sgClient.setApiKey(SENDGRID_API_KEY);
} else {
    console.warn('[NewsletterService] SENDGRID_API_KEY not set — emails will not send');
}

const TOKEN_EXPIRY_HOURS = 48;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random token and its SHA-256 hash.
 * Raw token goes in the email link. Hash goes in the DB.
 * @returns {{ raw: string, hash: string }}
 */
function generateConfirmationToken() {
    const raw = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}

/**
 * Hash a raw token for DB comparison.
 * @param {string} rawToken
 * @returns {string}
 */
function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ── Core Methods ───────────────────────────────────────────────────────────

/**
 * Subscribe a new email to the newsletter.
 * Idempotent: returns success for both new and existing emails (no enumeration).
 *
 * @param {string} email
 * @param {string|null} ipAddress
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function subscribe(email, ipAddress = null) {
    const normalised = email.trim().toLowerCase();

    // Check for existing subscriber
    const existing = await pool.query(
        'SELECT subscriber_id, status FROM newsletter_subscribers WHERE email = $1',
        [normalised]
    );

    if (existing.rows.length > 0) {
        const row = existing.rows[0];

        // If unsubscribed, allow re-subscription with new token
        if (row.status === 'unsubscribed') {
            const { raw, hash } = generateConfirmationToken();
            const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

            await pool.query(
                `UPDATE newsletter_subscribers
                 SET status = 'pending',
                     confirmation_token_hash = $1,
                     confirmation_token_expires = $2,
                     confirmed_at = NULL,
                     sendgrid_synced = false,
                     sendgrid_contact_id = NULL,
                     updated_at = NOW()
                 WHERE subscriber_id = $3`,
                [hash, expiresAt, row.subscriber_id]
            );

            sendConfirmationEmail(normalised, raw).catch(err => {
                console.error("[NewsletterService] Email send failed (re-sub), token for dev:", raw);
            });
        }

        // For pending or confirmed, return same generic message (no enumeration)
        return { success: true, message: 'Check your inbox to confirm your subscription.' };
    }

    // New subscriber
    const subscriberId = await generateHexId('newsletter_subscriber_id');
    const { raw, hash } = generateConfirmationToken();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    await pool.query(
        `INSERT INTO newsletter_subscribers
         (subscriber_id, email, status, confirmation_token_hash, confirmation_token_expires, ip_address, source, created_at, updated_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, 'gronk_mode', NOW(), NOW())`,
        [subscriberId, normalised, hash, expiresAt, ipAddress]
    );

    sendConfirmationEmail(normalised, raw).catch(err => {
        console.error("[NewsletterService] Email send failed (new sub), token for dev:", raw);
    });

    return { success: true, message: 'Check your inbox to confirm your subscription.' };
}

/**
 * Confirm a subscription via token from email link.
 *
 * @param {string} rawToken
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function confirm(rawToken) {
    const tokenHash = hashToken(rawToken);

    const result = await pool.query(
        `SELECT subscriber_id, email, status, confirmation_token_expires
         FROM newsletter_subscribers
         WHERE confirmation_token_hash = $1`,
        [tokenHash]
    );

    if (result.rows.length === 0) {
        return { success: false, message: 'Invalid or expired confirmation link.' };
    }

    const row = result.rows[0];

    // Already confirmed
    if (row.status === 'confirmed') {
        return { success: true, message: 'Your subscription is already confirmed.' };
    }

    // Token expired
    if (row.confirmation_token_expires && new Date(row.confirmation_token_expires) < new Date()) {
        return { success: false, message: 'This confirmation link has expired. Please subscribe again.' };
    }

    // Confirm the subscription
    await pool.query(
        `UPDATE newsletter_subscribers
         SET status = 'confirmed',
             confirmed_at = NOW(),
             confirmation_token_hash = NULL,
             confirmation_token_expires = NULL,
             updated_at = NOW()
         WHERE subscriber_id = $1`,
        [row.subscriber_id]
    );

    // Sync to SendGrid contacts list (non-blocking — don't fail confirmation if sync fails)
    syncToSendGrid(row.subscriber_id, row.email).catch(err => {
        console.error('[NewsletterService] SendGrid sync failed for', row.subscriber_id, err.message);
    });

    return { success: true, message: 'You are on the list.' };
}

/**
 * Unsubscribe by email address.
 *
 * @param {string} email
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function unsubscribe(email) {
    const normalised = email.trim().toLowerCase();

    const result = await pool.query(
        `UPDATE newsletter_subscribers
         SET status = 'unsubscribed',
             confirmation_token_hash = NULL,
             confirmation_token_expires = NULL,
             updated_at = NOW()
         WHERE email = $1 AND status != 'unsubscribed'
         RETURNING subscriber_id, sendgrid_contact_id`,
        [normalised]
    );

    if (result.rows.length > 0 && result.rows[0].sendgrid_contact_id) {
        removeFromSendGrid(result.rows[0].sendgrid_contact_id).catch(err => {
            console.error('[NewsletterService] SendGrid removal failed:', err.message);
        });
    }

    // Always return success (no enumeration)
    return { success: true, message: 'You have been unsubscribed.' };
}

// ── Email Sending ──────────────────────────────────────────────────────────

/**
 * Send the double opt-in confirmation email.
 *
 * @param {string} toEmail
 * @param {string} rawToken
 */
async function sendConfirmationEmail(toEmail, rawToken) {
    if (!SENDGRID_API_KEY) {
        console.warn('[NewsletterService] No API key — skipping confirmation email to', toEmail);
        console.log('[NewsletterService] Confirmation token (dev only):', rawToken);
        return;
    }

    const confirmUrl = `${BASE_URL}/api/newsletter/confirm?token=${rawToken}`;

    const msg = {
        to: toEmail,
        from: {
            email: SENDGRID_FROM_EMAIL,
            name: 'Piza Sukeruton'
        },
        subject: 'Confirm your place on the list',
        text: [
            'You requested to join the Piza Sukeruton mailing list.',
            '',
            'Confirm your subscription:',
            confirmUrl,
            '',
            'This link expires in 48 hours.',
            '',
            'If you did not request this, ignore this email.',
            '',
            '— ピザスケルトン'
        ].join('\n'),
        html: [
            '<div style="background:#000;color:#00ff75;font-family:monospace;padding:40px;max-width:600px;">',
            '<p>You requested to join the Piza Sukeruton mailing list.</p>',
            '<p>&nbsp;</p>',
            `<p><a href="${confirmUrl}" style="color:#00ff75;text-decoration:underline;">CONFIRM YOUR SUBSCRIPTION</a></p>`,
            '<p>&nbsp;</p>',
            '<p style="color:#666;">This link expires in 48 hours.</p>',
            '<p style="color:#666;">If you did not request this, ignore this email.</p>',
            '<p>&nbsp;</p>',
            '<p>— ピザスケルトン</p>',
            '</div>'
        ].join('\n')
    };

    try {
        await sgMail.send(msg);
        console.log('[NewsletterService] Confirmation email sent to', toEmail);
    } catch (err) {
        console.error('[NewsletterService] Failed to send confirmation email:', err.message);
        if (err.response) {
            console.error('[NewsletterService] SendGrid response body:', JSON.stringify(err.response.body));
        }
        throw err;
    }
}

// ── SendGrid Contacts Sync ────────────────────────────────────────────────

/**
 * Add a confirmed subscriber to the SendGrid contacts list.
 *
 * @param {string} subscriberId
 * @param {string} email
 */
async function syncToSendGrid(subscriberId, email) {
    if (!SENDGRID_API_KEY) {
        console.warn('[NewsletterService] No API key — skipping SendGrid sync');
        return;
    }

    try {
        const [response] = await sgClient.request({
            method: 'PUT',
            url: '/v3/marketing/contacts',
            body: {
                contacts: [{ email }]
            }
        });

        // SendGrid returns a job_id for async processing — contact_id comes later
        // For now, mark as synced; contact_id can be retrieved via search if needed
        await pool.query(
            `UPDATE newsletter_subscribers
             SET sendgrid_synced = true,
                 updated_at = NOW()
             WHERE subscriber_id = $1`,
            [subscriberId]
        );

        console.log('[NewsletterService] Synced to SendGrid:', email);
    } catch (err) {
        console.error('[NewsletterService] SendGrid contacts sync failed:', err.message);
        throw err;
    }
}

/**
 * Remove a contact from SendGrid by contact_id.
 *
 * @param {string} contactId
 */
async function removeFromSendGrid(contactId) {
    if (!SENDGRID_API_KEY) return;

    try {
        await sgClient.request({
            method: 'DELETE',
            url: '/v3/marketing/contacts',
            qs: { ids: contactId }
        });
        console.log('[NewsletterService] Removed from SendGrid:', contactId);
    } catch (err) {
        console.error('[NewsletterService] SendGrid removal failed:', err.message);
        throw err;
    }
}

// ── Exports ────────────────────────────────────────────────────────────────

export default {
    subscribe,
    confirm,
    unsubscribe
};
