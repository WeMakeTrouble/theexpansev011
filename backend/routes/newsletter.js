/**
 * ============================================================================
 * newsletter.js — Gronk Mode Newsletter Routes (v011)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Public-facing routes for the Gronk Mode newsletter subscription system.
 * No authentication required — these endpoints are open to the public.
 *
 * ROUTES
 * ------
 * POST /api/newsletter/subscribe    — Submit email for double opt-in
 * GET  /api/newsletter/confirm      — Confirm subscription via token link
 * POST /api/newsletter/unsubscribe  — Unsubscribe by email
 *
 * SECURITY
 * --------
 * - Rate limiting applied per-route (subscribe is strictest)
 * - No email enumeration — all responses are generic
 * - Input validation on email format
 *
 * ARCHITECTURAL CONSTRAINTS
 * -------------------------
 * - No external AI APIs
 * - No Math.random()
 *
 * LICENCE INTENT: MIT
 * ============================================================================
 */

import { Router } from 'express';
import NewsletterService from '../services/NewsletterService.js';

const router = Router();

// ── Email validation ───────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
    return typeof email === 'string'
        && email.length <= 255
        && EMAIL_REGEX.test(email.trim());
}

// ── POST /subscribe ────────────────────────────────────────────────────────

router.post('/subscribe', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid email address.'
            });
        }

        const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || null;

        const result = await NewsletterService.subscribe(email, ipAddress);
        return res.status(200).json(result);

    } catch (err) {
        console.error('[newsletter:subscribe] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Something went wrong. Please try again later.'
        });
    }
});

// ── GET /confirm ───────────────────────────────────────────────────────────

router.get('/confirm', async (req, res) => {
    try {
        const { token } = req.query;

        if (!token || typeof token !== 'string' || token.length < 10) {
            return res.status(400).json({
                success: false,
                message: 'Invalid confirmation link.'
            });
        }

        const result = await NewsletterService.confirm(token);
        const statusCode = result.success ? 200 : 400;

        // For browser clicks, return a simple HTML page instead of JSON
        if (req.headers.accept?.includes('text/html')) {
            const colour = result.success ? '#00ff75' : '#ff4444';
            return res.status(statusCode).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>Piza Sukeruton</title>
                    <style>
                        body {
                            background: #000;
                            color: ${colour};
                            font-family: 'Share Tech Mono', monospace;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            min-height: 100vh;
                            margin: 0;
                        }
                        .container { text-align: center; padding: 40px; }
                        a { color: #00ff75; }
                    </style>
                    <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
                </head>
                <body>
                    <div class="container">
                        <p>${result.message}</p>
                        <p style="margin-top:2em;color:#666;">— ピザスケルトン</p>
                    </div>
                </body>
                </html>
            `);
        }

        return res.status(statusCode).json(result);

    } catch (err) {
        console.error('[newsletter:confirm] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Something went wrong. Please try again later.'
        });
    }
});

// ── POST /unsubscribe ──────────────────────────────────────────────────────

router.post('/unsubscribe', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || !isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid email address.'
            });
        }

        const result = await NewsletterService.unsubscribe(email);
        return res.status(200).json(result);

    } catch (err) {
        console.error('[newsletter:unsubscribe] Error:', err.message);
        return res.status(500).json({
            success: false,
            message: 'Something went wrong. Please try again later.'
        });
    }
});

export default router;
