/**
 * ============================================================================
 * auth.js — Hybrid Authentication Middleware (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Express middleware that authenticates requests via two methods:
 *
 *   1. SESSION-BASED (CMS UI): Checks req.session for userId and
 *      accessLevel. Used by the browser-based CMS terminal.
 *
 *   2. JWT BEARER TOKEN (API): Checks Authorization header for a
 *      Bearer token. Used by external tools, curl, Postman.
 *
 * On success, populates req.user with { user_id, username, access_level,
 * auth_type } and calls next(). On failure, returns 401 or 403 JSON.
 *
 * USAGE
 * -----
 *   import { verifyAdminAuth } from '../middleware/auth.js';
 *
 *   router.use(verifyAdminAuth);
 *   // or
 *   router.get('/admin/data', verifyAdminAuth, handler);
 *
 * PREREQUISITES
 * -------------
 * - Session middleware must be configured (config/session.js)
 * - JWT_SECRET must be set in environment (see utils/jwtUtil.js)
 *
 * CONSUMERS
 * ---------
 * - backend/routes/admin.js
 * - backend/routes/adminCharacters.js
 * - backend/routes/god-mode.js
 * - Any route requiring authentication
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
 * v009: 74 lines. Hybrid session+JWT. Hardcoded access_level 11.
 * v010: Frozen constants, correlationId, documentation header.
 * ============================================================================
 */

import { verifyToken as verifyTokenUtil } from '../utils/jwtUtil.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('AuthMiddleware');

/*
 * ============================================================================
 * Constants
 * ============================================================================
 */
const AUTH_CONFIG = Object.freeze({
  MIN_ADMIN_LEVEL: 11,
  BEARER_PREFIX: 'Bearer '
});

const HTTP_STATUS = Object.freeze({
  UNAUTHORIZED: 401,
  FORBIDDEN: 403
});

/*
 * ============================================================================
 * Middleware
 * ============================================================================
 */

/**
 * Hybrid authentication middleware.
 * Checks session first, then JWT Bearer token.
 *
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Express next.
 */
export const verifyAdminAuth = (req, res, next) => {
  const correlationId = req.correlationId || req.headers?.['x-correlation-id'] || 'no-correlation-id';

  try {
    /*
     * 1. SESSION-BASED AUTH (CMS UI)
     */
    if (
      req.session &&
      req.session.userId &&
      req.session.accessLevel >= AUTH_CONFIG.MIN_ADMIN_LEVEL
    ) {
      req.user = {
        user_id: req.session.userId,
        username: req.session.username,
        access_level: req.session.accessLevel,
        auth_type: 'session'
      };
      logger.debug('Session auth granted', {
        correlationId,
        username: req.session.username,
        accessLevel: req.session.accessLevel
      });
      return next();
    }

    /*
     * 2. JWT BEARER TOKEN AUTH (API tools)
     */
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn('Auth denied: no session or token', {
        correlationId,
        ip: req.ip,
        path: req.originalUrl
      });
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: 'Access denied. No session or token provided.'
      });
    }

    const token = authHeader.startsWith(AUTH_CONFIG.BEARER_PREFIX)
      ? authHeader.slice(AUTH_CONFIG.BEARER_PREFIX.length)
      : authHeader;

    const decoded = verifyTokenUtil(token);

    if (!decoded.access_level || decoded.access_level < AUTH_CONFIG.MIN_ADMIN_LEVEL) {
      logger.warn('Auth denied: insufficient access level via JWT', {
        correlationId,
        username: decoded.username,
        accessLevel: decoded.access_level,
        required: AUTH_CONFIG.MIN_ADMIN_LEVEL,
        ip: req.ip
      });
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'Admin access required.'
      });
    }

    req.user = {
      ...decoded,
      auth_type: 'jwt'
    };

    logger.debug('JWT auth granted', {
      correlationId,
      username: decoded.username,
      accessLevel: decoded.access_level
    });
    return next();

  } catch (error) {
    logger.error('Auth middleware error', error, {
      correlationId,
      ip: req.ip,
      path: req.originalUrl
    });
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: 'Invalid or expired token.'
    });
  }
};


/**
 * User-level authentication middleware.
 * Checks session first, then JWT Bearer token.
 * Requires any valid login (access_level >= 1).
 * Used by user-facing API routes (fracture monitor, psychic radar, etc.).
 *
 * @param {Object} req - Express request.
 * @param {Object} res - Express response.
 * @param {Function} next - Express next.
 */
export const verifyUserAuth = (req, res, next) => {
  const correlationId = req.correlationId || req.headers?.['x-correlation-id'] || 'no-correlation-id';

  try {
    if (
      req.session &&
      req.session.userId &&
      req.session.accessLevel >= 1
    ) {
      req.user = {
        user_id: req.session.userId,
        username: req.session.username,
        access_level: req.session.accessLevel,
        auth_type: 'session'
      };
      logger.debug('User session auth granted', {
        correlationId,
        username: req.session.username,
        accessLevel: req.session.accessLevel
      });
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn('User auth denied: no session or token', {
        correlationId,
        ip: req.ip,
        path: req.originalUrl
      });
      return res.status(401).json({
        success: false,
        error: 'Access denied. Please log in.'
      });
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    const decoded = verifyTokenUtil(token);

    if (!decoded.access_level || decoded.access_level < 1) {
      logger.warn('User auth denied: invalid access level via JWT', {
        correlationId,
        username: decoded.username,
        accessLevel: decoded.access_level,
        ip: req.ip
      });
      return res.status(403).json({
        success: false,
        error: 'Valid user account required.'
      });
    }

    req.user = {
      ...decoded,
      auth_type: 'jwt'
    };

    logger.debug('User JWT auth granted', {
      correlationId,
      username: decoded.username,
      accessLevel: decoded.access_level
    });
    return next();

  } catch (error) {
    logger.error('User auth middleware error', error, {
      correlationId,
      ip: req.ip,
      path: req.originalUrl
    });
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token.'
    });
  }
};

export const verifyToken = verifyAdminAuth;

export default verifyAdminAuth;
