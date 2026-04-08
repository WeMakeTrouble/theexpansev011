/**
 * ============================================================================
 * requireAdmin.js — Admin Access Level Gate Middleware (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Express middleware factory that enforces minimum access level requirements
 * on protected routes. Returns a middleware function that checks the
 * authenticated user's access_level against a configurable threshold.
 *
 * USAGE
 * -----
 *   import { requireAdmin } from '../middleware/requireAdmin.js';
 *
 *   // God mode only (level 11)
 *   router.get('/admin/dashboard', requireAdmin(), handler);
 *
 *   // Custom level
 *   router.get('/mod/tools', requireAdmin(5), handler);
 *
 * PREREQUISITES
 * -------------
 * Requires auth middleware to have already run and populated req.user with
 * at minimum { username, access_level }. If req.user is missing, returns 401.
 *
 * ACCESS LEVELS (The Expanse)
 * ---------------------------
 *   1    = Standard user (white belt)
 *   5    = Moderator
 *   11   = God mode (James)
 *
 * CONSUMERS
 * ---------
 * - backend/routes/admin.js
 * - backend/routes/god-mode.js
 * - backend/routes/adminCharacters.js
 * - Any route requiring elevated access
 *
 * v010 STANDARDS
 * --------------
 * - Structured logger (createModuleLogger) — no console.log
 * - Frozen constants
 * - Correlation ID threading
 * - Documentation header
 * - Input validation
 *
 * HISTORY
 * -------
 * v009: 46 lines, already had structured logger. No constants, no correlationId.
 * v010: Added frozen constants, correlationId, documentation header.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('RequireAdmin');

/*
 * ============================================================================
 * Constants
 * ============================================================================
 */
const ADMIN_DEFAULTS = Object.freeze({
  MIN_LEVEL: 11,
  GOD_MODE: 11
});

const HTTP_STATUS = Object.freeze({
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  SERVER_ERROR: 500
});

/*
 * ============================================================================
 * Middleware Factory
 * ============================================================================
 */

/**
 * Creates an Express middleware that enforces minimum access level.
 *
 * @param {number} [minLevel=11] - Minimum access_level required.
 * @returns {Function} Express middleware (req, res, next).
 */
export const requireAdmin = (minLevel = ADMIN_DEFAULTS.MIN_LEVEL) => {
  if (typeof minLevel !== 'number' || minLevel < 1) {
    throw new Error(`requireAdmin: minLevel must be a positive number, got ${minLevel}`);
  }

  return async (req, res, next) => {
    const correlationId = req.correlationId || req.headers?.['x-correlation-id'] || 'no-correlation-id';

    try {
      if (!req.user || typeof req.user.access_level === 'undefined') {
        logger.warn('Admin access denied: no user context', {
          correlationId,
          ip: req.ip,
          path: req.originalUrl
        });
        return res.status(HTTP_STATUS.UNAUTHORIZED).json({
          success: false,
          error: 'Authentication required'
        });
      }

      if (req.user.access_level < minLevel) {
        logger.warn('Admin access denied: insufficient access level', {
          correlationId,
          username: req.user.username,
          accessLevel: req.user.access_level,
          required: minLevel,
          ip: req.ip,
          path: req.originalUrl
        });
        return res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: 'Admin access required'
        });
      }

      logger.debug('Admin access granted', {
        correlationId,
        username: req.user.username,
        accessLevel: req.user.access_level
      });
      next();
    } catch (error) {
      logger.error('Admin middleware error', error, {
        correlationId,
        ip: req.ip,
        path: req.originalUrl
      });
      return res.status(HTTP_STATUS.SERVER_ERROR).json({
        success: false,
        error: 'Server error'
      });
    }
  };
};

export default requireAdmin;
