/**
 * ============================================================================
 * jwtUtil.js — JWT Token Generation and Verification (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Provides JWT token generation and verification for The Expanse auth system.
 * Tokens encode user_id, username, and access_level with 24-hour expiry.
 *
 * USAGE
 * -----
 *   import { generateToken, verifyToken } from '../utils/jwtUtil.js';
 *
 *   const token = generateToken(user);   // returns signed JWT string
 *   const decoded = verifyToken(token);  // returns payload or throws
 *
 * SECURITY
 * --------
 * JWT_SECRET sourced from environment variable. Falls back to crypto random
 * bytes if not set (development only — production MUST set JWT_SECRET).
 *
 * CONSUMERS
 * ---------
 * - backend/middleware/auth.js (verifyToken)
 * - backend/routes/auth.js (generateToken on login)
 * - backend/utils/registrationHandler.js (future)
 *
 * v010 STANDARDS
 * --------------
 * - Structured logger (createModuleLogger) — no console.log
 * - Frozen constants
 * - Documentation header
 *
 * HISTORY
 * -------
 * v009: 25 lines, functional but no logger, no constants.
 * v010: Added structured logger, frozen constants, documentation header.
 * ============================================================================
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('JwtUtil');

/*
 * ============================================================================
 * Constants
 * ============================================================================
 */
const JWT_CONFIG = Object.freeze({
  EXPIRY: '24h',
  ALGORITHM: 'HS256'
});

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const fallback = crypto.randomBytes(64).toString('hex');
  logger.warn('JWT_SECRET not set in environment, using random fallback (development only)');
  return fallback;
})();

/*
 * ============================================================================
 * Public API
 * ============================================================================
 */

/**
 * Generates a signed JWT token for a user.
 *
 * @param {Object} user - User object with user_id, username, access_level.
 * @returns {string} Signed JWT token.
 */
export const generateToken = (user) => {
  if (!user || !user.user_id) {
    throw new Error('generateToken: user object with user_id is required');
  }

  return jwt.sign(
    {
      user_id: user.user_id,
      username: user.username,
      access_level: user.access_level
    },
    JWT_SECRET,
    { expiresIn: JWT_CONFIG.EXPIRY }
  );
};

/**
 * Verifies and decodes a JWT token.
 *
 * @param {string} token - JWT token string.
 * @returns {Object} Decoded payload { user_id, username, access_level }.
 * @throws {Error} If token is invalid or expired.
 */
export const verifyToken = (token) => {
  if (!token || typeof token !== 'string') {
    throw new Error('Invalid or expired token');
  }

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
};

export default { generateToken, verifyToken };
