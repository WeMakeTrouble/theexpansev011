/**
 * ============================================================================
 * PhaseAccess.js — Access Control & Gatekeeping (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Phase 2 in the brain pipeline. Determines if this turn is allowed
 * to proceed based on user status and access level.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Logger switched to createModuleLogger (v010 standard).
 * - No logic changes. v009 audit confirmed "Complete — No gaps."
 * - No diagnosticReport consumption needed (confirmed in phase consumer map).
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Validate basic session/user structure
 *  - Block banned/suspended users
 *  - Detect and route god/admin mode (access_level 11)
 *  - Pass through normal requests
 *
 * NON-GOALS
 * ---------
 *  - No intent interpretation
 *  - No session mutation
 *  - No teaching/emotional logic
 *  - No DB access
 *
 * TERMINAL BEHAVIOR
 * -----------------
 *  - Returns terminal: true for denied users (banned/suspended)
 *  - Returns terminal: true for god-mode users (routed separately)
 *  - Normal users pass through to next phase
 *
 * DEPENDENCIES
 * ------------
 * Internal: None (reads only from turnState.user and turnState.session)
 * External: None
 *
 * NAMING CONVENTIONS
 * ------------------
 * Handler: PhaseAccess (PascalCase object with execute method)
 * Constants: BLOCKED_STATUSES, GOD_MODE_ACCESS_LEVEL (UPPER_SNAKE_CASE)
 * Logger: createModuleLogger('PhaseAccess')
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('PhaseAccess');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const BLOCKED_STATUSES = Object.freeze(['banned', 'suspended']);
const GOD_MODE_ACCESS_LEVEL = 11;

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseAccess Handler                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const PhaseAccess = {
  async execute(turnState) {
    const { command, user, session, correlationId } = turnState;

    logger.debug('Executing', { correlationId });

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  1. Basic structural validation                                         */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (!user || !session) {
      logger.error('Missing user or session', {
        correlationId,
        hasUser: !!user,
        hasSession: !!session
      });
      return {
        responseIntent: {
          type: 'access_denied',
          payload: { reason: 'missing_user_or_session' }
        },
        terminal: true
      };
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  2. Hard access blocks                                                  */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (BLOCKED_STATUSES.includes(user.status)) {
      logger.warn('Access denied — blocked status', {
        correlationId,
        userId: user.userId,
        status: user.status
      });
      return {
        responseIntent: {
          type: 'access_denied',
          payload: { reason: 'user_not_authorized' }
        },
        terminal: true
      };
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  3. God/admin mode detection                                            */
    /* ──────────────────────────────────────────────────────────────────────── */

    if (user.access_level === GOD_MODE_ACCESS_LEVEL) {
      logger.info('God mode detected', {
        correlationId,
        userId: user.userId
      });
      return {
        responseIntent: {
          type: 'god_mode',
          payload: { command, user, session }
        },
        terminal: true
      };
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  4. Normal pass-through                                                 */
    /* ──────────────────────────────────────────────────────────────────────── */

    logger.debug('Access granted', { correlationId });

    return {
      accessLevel: 'normal',
      checksPassed: true
    };
  }
};

export default PhaseAccess;
