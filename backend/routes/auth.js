/**
 * ===========================================================================
 * AUTH ROUTES — HTTP Authentication Endpoints
 * ===========================================================================
 *
 * PURPOSE:
 * Provides HTTP-based authentication for The Expanse. Four endpoints:
 *   POST /auth/register — Create new user account, optionally claim purchase code
 *   POST /auth/login    — Authenticate user, create session
 *   POST /auth/logout   — Destroy session, clear cookie
 *   GET  /auth/check    — Check if current session is authenticated
 *
 * AUTHENTICATION FLOW:
 * 1. User submits username + password to /auth/login
 * 2. UserManager.verifyUser validates credentials against database
 * 3. On success: session created with userId, username, accessLevel
 * 4. Session cookie (expanse.sid) set automatically by express-session
 * 5. Subsequent requests authenticated via session cookie
 *
 * REGISTRATION FLOW:
 * 1. User submits username + email + password + optional purchase_code
 * 2. If purchase_code present: validated against purchase_codes table
 *    (must exist, must be unclaimed, format: XXXXXXXX or VIP-XXXXXX)
 * 3. UserManager.createUser creates user with access_level=1, user_tier=1
 * 4. If code valid: atomically claimed and linked to new user
 *    If VIP code: users.is_vip set to true
 * 5. Session created identically to login flow
 * 6. Response includes has_purchase_code flag for frontend routing
 *
 * DEPENDENCIES:
 *   - UserManager (backend/auth/UserManager.js) — user creation + verification
 *   - pool (backend/db/pool.js) — purchase code validation + dossier updates
 *   - logger (backend/utils/logger.js) — structured logging
 *
 * SESSION FIELDS SET:
 *   - req.session.userId      — user's hex ID (#D0XXXX)
 *   - req.session.username    — display username
 *   - req.session.accessLevel — numeric access level (1-11)
 *
 * COOKIE:
 *   - Name: expanse.sid
 *   - HttpOnly: true
 *   - SameSite: lax
 *
 * SECURITY NOTES:
 *   - Login returns generic "Invalid credentials" for both bad username
 *     and bad password (prevents user enumeration)
 *   - Invalid purchase codes return generic error (prevents code enumeration)
 *   - No rate limiting on this route file — apply authLimiter in server.js
 *     when mounting: app.use('/auth', authLimiter, authRoutes)
 *   - Session destruction clears server-side session AND client cookie
 *   - Purchase code claim is atomic: user creation + code claim in one transaction
 *
 * CONSUMERS:
 *   - Frontend login form (public/cotw/cotw-login.html)
 *   - Frontend register form (public/cotw/cotw-register.html)
 *   - CMS login page
 *   - Session check on page load
 *
 * V011 STANDARDS:
 *   - Structured logger (createModuleLogger) — no console.log
 *   - Frozen constants
 *   - Correlation ID threading
 *   - Input validation
 *   - Single export default router
 *
 * HISTORY:
 *   v009 — Direct bcrypt + pool queries, duplicate logout routes,
 *          code after export, wrong import path for dossier service
 *   v010 — Uses UserManager, single clean export, structured logging,
 *          dossier upsert deferred to future user dossier service
 *   v011 — Added POST /auth/register with purchase code validation
 * ===========================================================================
 */

import express from 'express';
import pool from '../db/pool.js';
import UserManager from '../auth/UserManager.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('AuthRoutes');

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const HTTP_STATUS = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  SERVER_ERROR: 500
});

const COOKIE_NAME = 'expanse.sid';

const COOKIE_OPTIONS = Object.freeze({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: false
});

const PURCHASE_CODE_REGEX = /^([A-Z0-9]{8}|VIP-[A-Z0-9]{6})$/;

// ═══════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════

const router = express.Router();

/**
 * POST /auth/register
 * Create new user account, optionally claim a purchase code.
 *
 * Body: { username, email, password, purchase_code? }
 *
 * On success: session created, returns user object + has_purchase_code flag.
 * purchase_code is optional — absence creates account without COTW access.
 */
router.post('/register', async (req, res) => {
  const correlationId = req.correlationId || req.headers['x-correlation-id'] || null;

  try {
    const { username, email, password } = req.body;
    const rawCode = req.body.purchase_code
      ? String(req.body.purchase_code).trim().toUpperCase()
      : null;

    // ── Basic field validation ──────────────────────────────────────────────
    if (!username || !email || !password) {
      logger.warn('Registration attempt with missing fields', {
        correlationId,
        hasUsername: !!username,
        hasEmail: !!email,
        hasPassword: !!password,
        ip: req.ip
      });
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Username, email and password are required'
      });
    }

    // ── Purchase code format validation (before any DB query) ───────────────
    if (rawCode !== null && !PURCHASE_CODE_REGEX.test(rawCode)) {
      logger.warn('Registration with malformed purchase code', {
        correlationId,
        ip: req.ip
      });
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Invalid purchase code format'
      });
    }

    // ── Purchase code DB validation (if code provided) ──────────────────────
    if (rawCode !== null) {
      const codeCheck = await pool.query(
        'SELECT code_id, is_claimed, code_type FROM purchase_codes WHERE code = $1',
        [rawCode]
      );

      if (codeCheck.rows.length === 0 || codeCheck.rows[0].is_claimed) {
        logger.warn('Registration with invalid or claimed purchase code', {
          correlationId,
          ip: req.ip
        });
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          message: 'Purchase code is invalid or has already been used'
        });
      }
    }

    // ── Create user ─────────────────────────────────────────────────────────
    const createResult = await UserManager.createUser(
      username, email, password, correlationId
    );

    if (!createResult.success) {
      const isConflict = createResult.error?.includes('already exists');
      logger.warn('User creation failed', {
        correlationId,
        error: createResult.error,
        ip: req.ip
      });
      return res.status(isConflict ? HTTP_STATUS.CONFLICT : HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: createResult.error
      });
    }

    const user = createResult.user;
    let hasPurchaseCode = false;
    let isVip = false;

    // ── Claim purchase code atomically ──────────────────────────────────────
    if (rawCode !== null) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const claimResult = await client.query(
          `UPDATE purchase_codes
           SET is_claimed = true,
               claimed_by = $1,
               claimed_at = NOW(),
               updated_at = NOW()
           WHERE code = $2
             AND is_claimed = false
           RETURNING code_type`,
          [user.user_id, rawCode]
        );

        if (claimResult.rows.length === 0) {
          await client.query('ROLLBACK');
          logger.warn('Purchase code claim race condition — code already claimed', {
            correlationId,
            userId: user.user_id,
            ip: req.ip
          });
          return res.status(HTTP_STATUS.CONFLICT).json({
            success: false,
            message: 'Purchase code was just claimed by another user. Please contact support.'
          });
        }

        const codeType = claimResult.rows[0].code_type;
        isVip = codeType === 'vip';

        await client.query(
          `UPDATE users
           SET purchase_code = $1,
               is_vip = $2,
               updated_at = NOW()
           WHERE user_id = $3`,
          [rawCode, isVip, user.user_id]
        );

        await client.query('COMMIT');
        hasPurchaseCode = true;

        logger.info('Purchase code claimed', {
          correlationId,
          userId: user.user_id,
          codeType,
          isVip,
          ip: req.ip
        });

      } catch (claimError) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Purchase code claim failed', claimError, {
          correlationId,
          userId: user.user_id
        });
        return res.status(HTTP_STATUS.SERVER_ERROR).json({
          success: false,
          message: 'Account created but code claim failed. Please contact support.'
        });
      } finally {
        client.release();
      }
    }

    // ── Create session ──────────────────────────────────────────────────────
    req.session.userId = user.user_id;
    req.session.username = user.username;
    req.session.accessLevel = user.access_level;

    logger.info('Registration successful', {
      correlationId,
      userId: user.user_id,
      username: user.username,
      hasPurchaseCode,
      isVip,
      ip: req.ip
    });

    return res.json({
      success: true,
      user: {
        user_id: user.user_id,
        username: user.username,
        access_level: user.access_level
      },
      has_purchase_code: hasPurchaseCode,
      is_vip: isVip
    });

  } catch (error) {
    logger.error('Registration error', error, {
      correlationId,
      ip: req.ip
    });
    return res.status(HTTP_STATUS.SERVER_ERROR).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * POST /auth/login
 * Authenticate user and create session
 */
router.post('/login', async (req, res) => {
  const correlationId = req.correlationId || req.headers['x-correlation-id'] || null;

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      logger.warn('Login attempt with missing credentials', {
        correlationId,
        hasUsername: !!username,
        hasPassword: !!password,
        ip: req.ip
      });
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        message: 'Username and password required'
      });
    }

    const result = await UserManager.verifyUser(username, password, correlationId);

    if (!result.success) {
      logger.warn('Login failed', {
        correlationId,
        username,
        reason: result.error,
        ip: req.ip
      });
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = result.user;

    req.session.userId = user.user_id;
    req.session.username = user.username;
    req.session.accessLevel = user.access_level;

    logger.info('Login successful', {
      correlationId,
      userId: user.user_id,
      username: user.username,
      accessLevel: user.access_level,
      ip: req.ip
    });

    try {
      await pool.query(
        `UPDATE cotw_dossiers
         SET previous_login = last_login,
             last_login = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND dossier_type = 'user'`,
        [user.user_id]
      );
    } catch (dossierErr) {
      logger.warn('Dossier login timestamp update failed', {
        correlationId,
        userId: user.user_id,
        error: dossierErr.message
      });
    }

    return res.json({
      success: true,
      user: {
        user_id: user.user_id,
        username: user.username,
        access_level: user.access_level
      }
    });

  } catch (error) {
    logger.error('Login error', error, {
      correlationId,
      ip: req.ip
    });
    return res.status(HTTP_STATUS.SERVER_ERROR).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * POST /auth/logout
 * Destroy session and clear cookie
 */
router.post('/logout', (req, res) => {
  const correlationId = req.correlationId || req.headers['x-correlation-id'] || null;
  const userId = req.session?.userId || null;

  req.session.destroy((err) => {
    if (err) {
      logger.error('Logout session destroy failed', err, {
        correlationId,
        userId
      });
      return res.status(HTTP_STATUS.SERVER_ERROR).json({
        success: false,
        message: 'Logout failed'
      });
    }

    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);

    logger.info('Logout successful', {
      correlationId,
      userId
    });

    return res.json({ success: true });
  });
});

/**
 * GET /auth/check
 * Check if current session is authenticated
 */
router.get('/check', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      authenticated: true,
      user: {
        user_id: req.session.userId,
        username: req.session.username,
        access_level: req.session.accessLevel
      }
    });
  }
  return res.json({ authenticated: false });
});

export default router;
