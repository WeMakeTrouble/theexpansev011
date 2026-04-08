/**
 * ============================================================================
 * userAccess.js — User Access Status Endpoint (v011)
 * ============================================================================
 *
 * PURPOSE:
 * Provides a single endpoint for the frontend to determine what a logged-in
 * user has access to. Called on page load by cotw-dossier.html to decide
 * whether to allow terminal access or redirect to the holding page.
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 * GET /api/user/access-status
 *   Returns: { has_purchase_code, is_vip, user_tier, access_level }
 *
 * SECURITY:
 * ---------------------------------------------------------------------------
 * Requires verifyUserAuth (access_level >= 1). Applied in server.js at mount.
 * Read-only. No sensitive data exposed — purchase code value never returned.
 *
 * CONSUMERS:
 * ---------------------------------------------------------------------------
 * - public/cotw/cotw-dossier.html (terminal access gate)
 * - public/cotw/js/registerHandler.js (post-registration redirect logic)
 *
 * ============================================================================
 * Project: The Expanse v011
 * ============================================================================
 */

import { Router } from 'express';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('UserAccess');
const router = Router();

/* ============================================================================
 * GET / — User Access Status
 * ============================================================================
 * Returns the access flags for the currently authenticated user.
 * has_purchase_code: true if users.purchase_code IS NOT NULL
 * is_vip: true if users.is_vip = true
 * user_tier: integer (1-3)
 * access_level: integer (1-11)
 * ============================================================================ */

router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const result = await pool.query(
      `SELECT
         (purchase_code IS NOT NULL) AS has_purchase_code,
         is_vip,
         user_tier,
         access_level
       FROM users
       WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      logger.warn('Access status query — user not found', { userId });
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const row = result.rows[0];

    logger.debug('Access status fetched', {
      userId,
      hasPurchaseCode: row.has_purchase_code,
      isVip: row.is_vip,
      userTier: row.user_tier
    });

    return res.json({
      success: true,
      has_purchase_code: row.has_purchase_code,
      is_vip: row.is_vip,
      user_tier: row.user_tier,
      access_level: row.access_level
    });

  } catch (error) {
    next(error);
  }
});

export default router;
