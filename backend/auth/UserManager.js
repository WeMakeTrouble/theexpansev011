/**
 * ============================================================================
 * UserManager.js — User Authentication & Management (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Handles user authentication (login verification), password management,
 * and user lookup. This is the core auth module — it does NOT handle
 * registration (see utils/registrationHandler.js) or session management
 * (see middleware/auth.js).
 *
 * METHODS
 * -------
 *   UserManager.createUser(username, email, password)
 *     → Creates a new user with hex ID and hashed password.
 *
 *   UserManager.verifyUser(username, password)
 *     → Authenticates a user by username. Checks active + approved status.
 *        Updates last_login on success. Returns user object sans password.
 *
 *   UserManager.changePassword(userId, oldPassword, newPassword)
 *     → Validates old password, hashes and stores new password.
 *
 *   UserManager.getUserById(userId)
 *     → Retrieves user profile by hex user_id. No password returned.
 *
 * SECURITY
 * --------
 * - Passwords hashed with bcrypt (configurable salt rounds)
 * - Password hash NEVER returned to callers
 * - Account must be is_active AND approval_status = 'approved' to log in
 * - Unique constraint violations handled gracefully (23505)
 *
 * DATABASE
 * --------
 * Table: users
 * Key columns: user_id (hex), username, email, password_hash,
 *              access_level, approval_status, is_active, last_login
 *
 * CONSUMERS
 * ---------
 * - backend/routes/auth.js (login, password change)
 * - backend/councilTerminal/socketHandler.js (socket auth)
 * - backend/routes/admin.js (user management)
 *
 * v010 STANDARDS
 * --------------
 * - Structured logger (createModuleLogger) — no console.log
 * - Frozen constants
 * - Correlation ID threading
 * - Documentation header
 * - Input validation
 * - Hex ID generation for new users
 *
 * HISTORY
 * -------
 * v009: 164 lines. Static class with structured logger. No constants,
 *       no correlationId, no input validation, no hex ID on createUser.
 * v010: Frozen constants, correlationId, input validation, hex ID
 *       generation, documentation header.
 * ============================================================================
 */

import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('UserManager');

/*
 * ============================================================================
 * Constants
 * ============================================================================
 */
const USER_CONFIG = Object.freeze({
  BCRYPT_SALT_ROUNDS: 10,
  DEFAULT_ACCESS_LEVEL: 1,
  DEFAULT_USER_TIER: 1,
  APPROVAL_STATUS_APPROVED: 'approved',
  USERNAME_MIN: 3,
  USERNAME_MAX: 50,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 128,
  EMAIL_MAX: 255
});

const DB_ERROR_CODES = Object.freeze({
  UNIQUE_VIOLATION: '23505'
});

const USER_SELECT_FIELDS = 'user_id, username, email, access_level, approval_status, is_active, user_tier, created_at, last_login, account_created_at';

/*
 * ============================================================================
 * Validation Helpers
 * ============================================================================
 */

/**
 * @param {string} val
 * @param {string} name
 * @private
 */
function _validateString(val, name) {
  if (!val || typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(`${name} is required and must be a non-empty string`);
  }
}

/*
 * ============================================================================
 * UserManager Class
 * ============================================================================
 */
class UserManager {

  /**
   * Creates a new user with hex ID and hashed password.
   *
   * @param {string} username - Unique username.
   * @param {string} email - Unique email address.
   * @param {string} password - Plain text password (will be hashed).
   * @param {string} [correlationId] - Optional correlation ID.
   * @returns {Promise<{success: boolean, user?: Object, error?: string}>}
   */
  static async createUser(username, email, password, correlationId = 'no-correlation-id') {
    try {
      _validateString(username, 'username');
      _validateString(email, 'email');
      _validateString(password, 'password');

      if (username.length < USER_CONFIG.USERNAME_MIN || username.length > USER_CONFIG.USERNAME_MAX) {
        return { success: false, error: `Username must be ${USER_CONFIG.USERNAME_MIN}-${USER_CONFIG.USERNAME_MAX} characters` };
      }

      if (password.length < USER_CONFIG.PASSWORD_MIN || password.length > USER_CONFIG.PASSWORD_MAX) {
        return { success: false, error: `Password must be ${USER_CONFIG.PASSWORD_MIN}-${USER_CONFIG.PASSWORD_MAX} characters` };
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const userId = await generateHexId('user_id');
        const salt = await bcrypt.genSalt(USER_CONFIG.BCRYPT_SALT_ROUNDS);
        const passwordHash = await bcrypt.hash(password, salt);

        const query = `
          INSERT INTO users (user_id, username, email, password_hash, access_level, user_tier, approval_status, is_active, account_created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
          RETURNING ${USER_SELECT_FIELDS}
        `;

        const result = await client.query(query, [
          userId,
          username.trim(),
          email.trim().toLowerCase(),
          passwordHash,
          USER_CONFIG.DEFAULT_ACCESS_LEVEL,
          USER_CONFIG.DEFAULT_USER_TIER,
          USER_CONFIG.APPROVAL_STATUS_APPROVED
        ]);

        await client.query('COMMIT');

        const user = result.rows[0];
        logger.info('User created', { correlationId, userId, username });
        return { success: true, user };

      } catch (innerError) {
        await client.query('ROLLBACK').catch(() => {});
        throw innerError;
      } finally {
        client.release();
      }

    } catch (error) {
      if (error.code === DB_ERROR_CODES.UNIQUE_VIOLATION) {
        if (error.constraint?.includes('username')) {
          return { success: false, error: 'Username already exists' };
        }
        if (error.constraint?.includes('email')) {
          return { success: false, error: 'Email already exists' };
        }
        return { success: false, error: 'Username or email already exists' };
      }
      logger.error('Error creating user', error, { correlationId });
      return { success: false, error: error.message };
    }
  }

  /**
   * Verifies user credentials for login.
   *
   * @param {string} username - Username to look up.
   * @param {string} password - Plain text password to verify.
   * @param {string} [correlationId] - Optional correlation ID.
   * @returns {Promise<{success: boolean, user?: Object, error?: string}>}
   */
  static async verifyUser(username, password, correlationId = 'no-correlation-id') {
    try {
      _validateString(username, 'username');
      _validateString(password, 'password');

      const query = `
        SELECT user_id, username, email, password_hash, access_level,
               approval_status, is_active, user_tier, created_at, last_login
        FROM users
        WHERE username = $1
      `;

      const result = await pool.query(query, [username.trim()]);

      if (result.rows.length === 0) {
        return { success: false, error: 'User not found' };
      }

      const user = result.rows[0];

      if (!user.is_active) {
        logger.warn('Login attempt on disabled account', { correlationId, username });
        return { success: false, error: 'Account is disabled' };
      }

      if (user.approval_status !== USER_CONFIG.APPROVAL_STATUS_APPROVED) {
        logger.warn('Login attempt on unapproved account', { correlationId, username });
        return { success: false, error: 'Account pending approval' };
      }

      const isValid = await bcrypt.compare(password, user.password_hash);

      if (!isValid) {
        return { success: false, error: 'Invalid password' };
      }

      await pool.query(
        'UPDATE users SET last_login = NOW() WHERE user_id = $1',
        [user.user_id]
      );

      delete user.password_hash;

      logger.info('User authenticated', { correlationId, userId: user.user_id, username });
      return { success: true, user };

    } catch (error) {
      logger.error('Error verifying user', error, { correlationId });
      return { success: false, error: error.message };
    }
  }

  /**
   * Changes a user's password after verifying their current password.
   *
   * @param {string} userId - Hex user ID.
   * @param {string} oldPassword - Current password.
   * @param {string} newPassword - New password.
   * @param {string} [correlationId] - Optional correlation ID.
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  static async changePassword(userId, oldPassword, newPassword, correlationId = 'no-correlation-id') {
    try {
      _validateString(userId, 'userId');
      _validateString(oldPassword, 'oldPassword');
      _validateString(newPassword, 'newPassword');

      if (newPassword.length < USER_CONFIG.PASSWORD_MIN || newPassword.length > USER_CONFIG.PASSWORD_MAX) {
        return { success: false, error: `Password must be ${USER_CONFIG.PASSWORD_MIN}-${USER_CONFIG.PASSWORD_MAX} characters` };
      }

      const result = await pool.query(
        'SELECT password_hash FROM users WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return { success: false, error: 'User not found' };
      }

      const isValid = await bcrypt.compare(oldPassword, result.rows[0].password_hash);

      if (!isValid) {
        return { success: false, error: 'Current password is incorrect' };
      }

      const salt = await bcrypt.genSalt(USER_CONFIG.BCRYPT_SALT_ROUNDS);
      const passwordHash = await bcrypt.hash(newPassword, salt);

      await pool.query(
        'UPDATE users SET password_hash = $1, password_set_at = NOW() WHERE user_id = $2',
        [passwordHash, userId]
      );

      logger.info('Password changed', { correlationId, userId });
      return { success: true, message: 'Password updated successfully' };

    } catch (error) {
      logger.error('Error changing password', error, { correlationId });
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieves a user by hex ID. No password hash returned.
   *
   * @param {string} userId - Hex user ID.
   * @param {string} [correlationId] - Optional correlation ID.
   * @returns {Promise<Object|null>} User object or null.
   */
  static async getUserById(userId, correlationId = 'no-correlation-id') {
    try {
      _validateString(userId, 'userId');

      const result = await pool.query(
        `SELECT ${USER_SELECT_FIELDS} FROM users WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];

    } catch (error) {
      logger.error('Error getting user', error, { correlationId });
      return null;
    }
  }
}

export default UserManager;
