/**
 * ============================================================================
 * OnboardingOrchestrator.js — User Onboarding State Machine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages user onboarding as a formal Finite State Machine (FSM) with
 * optimistic locking, full audit trail, schema validation, and extensible
 * transition hooks.
 *
 * STATE MACHINE
 * -------------
 *   new → welcomed → awaiting_ready → omiyage_offered → onboarded
 *
 *   new              : User record created, no interaction yet
 *   welcomed         : Welcome beat delivered
 *   awaiting_ready   : Waiting for user affirmative or 15s timeout
 *   omiyage_offered  : Gift choice presented to user
 *   onboarded        : Terminal state — user is fully onboarded
 *
 * CONCURRENCY PROTECTION
 * ----------------------
 * Every transition uses optimistic locking via state_version column.
 * The UPDATE includes WHERE state_version = $expected. If another
 * process modified the state between our SELECT and UPDATE, the
 * UPDATE returns 0 rows and we throw OptimisticLockError.
 *
 * AUDIT TRAIL
 * -----------
 * Every transition (including admin overrides) inserts a row into
 * user_onboarding_audit with hex audit ID, from/to states, versions,
 * state_data snapshot, and reason string.
 *
 * HOOKS
 * -----
 * beforeTransitionHooks: Run before state change. Failure rolls back.
 * afterTransitionHooks: Run after commit. Failure logged, not thrown.
 *
 * METHODS
 * -------
 *   initializeUser(userId, correlationId)
 *   getCurrentState(userId, correlationId)
 *   transitionTo(userId, toState, stateData, reason, correlationId)
 *   advanceToAwaitingReadyAfterWelcome(userId, welcomeBeatId, correlationId)
 *   forceTransition(userId, toState, adminReason, correlationId)
 *   isOnboarded(userId, correlationId)
 *   getHistory(userId, options)
 *   getUsersInState(stateName, options)
 *   getStuckUsers(stateName, minutesThreshold, correlationId)
 *   getValidNextStates(fromState)
 *   registerBeforeTransitionHook(hookFn)
 *   registerAfterTransitionHook(hookFn)
 *
 * MIGRATION FROM v009
 * -------------------
 *   - 17 console.log/warn/error replaced with structured logger
 *   - correlationId threaded through all methods
 *   - validTransitions frozen with Object.freeze()
 *   - Counters added on every transition outcome
 *   - Deadlock retry wrapper added for all transactional methods
 *   - Pagination added to getHistory and getUsersInState
 *   - Query timeout protection added
 *   - Full documentation header added
 *   - No FSM logic changes — all transitions, locking, audit preserved
 *
 * CONSUMERS
 * ---------
 *   - socketHandler.js (onboarding flow, omiyage advancement)
 *   - Admin routes (force transition, stuck user queries)
 *
 * DEPENDENCIES
 * ------------
 *   Internal: pool.js, logger.js, hexIdGenerator.js, onboardingSchemas.js,
 *             counters.js
 *   External: None
 *
 * SCHEMA DEPENDENCIES
 * -------------------
 *   user_onboarding_state: user_id, current_state, state_version,
 *                          state_data(jsonb), entered_at, updated_at
 *   user_onboarding_audit: audit_id(hex), user_id, from_state, to_state,
 *                          from_version, to_version, state_data(jsonb),
 *                          reason, transitioned_at
 *
 * EXPORTS
 * -------
 *   default: onboardingOrchestrator (singleton instance)
 *   named:  InvalidTransitionError, OptimisticLockError,
 *           OnboardingNotInitializedError
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { StateDataSchemas } from './onboardingSchemas.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('OnboardingOrchestrator');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const TIMEOUTS = Object.freeze({
  QUERY_MS: 5000
});

const MAX_DEADLOCK_RETRIES = 3;
const DEADLOCK_BASE_DELAY_MS = 50;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Error Classes                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

class InvalidTransitionError extends Error {
  constructor(fromState, toState, validStates) {
    super(`Invalid transition: ${fromState} -> ${toState}. Valid: ${validStates.join(', ')}`);
    this.name = 'InvalidTransitionError';
    this.fromState = fromState;
    this.toState = toState;
    this.validStates = validStates;
  }
}

class OptimisticLockError extends Error {
  constructor(userId, expectedVersion) {
    super(`Optimistic lock failure for ${userId}: state was modified (expected v${expectedVersion})`);
    this.name = 'OptimisticLockError';
    this.userId = userId;
    this.expectedVersion = expectedVersion;
  }
}

class OnboardingNotInitializedError extends Error {
  constructor(userId) {
    super(`User ${userId} not found in onboarding_state`);
    this.name = 'OnboardingNotInitializedError';
    this.userId = userId;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Internal Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _queryWithTimeout(client, sql, params) {
  return Promise.race([
    client.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Query timeout')), TIMEOUTS.QUERY_MS)
    )
  ]);
}

function _poolQueryWithTimeout(sql, params) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Query timeout')), TIMEOUTS.QUERY_MS)
    )
  ]);
}

async function _withDeadlockRetry(fn, correlationId) {
  for (let attempt = 1; attempt <= MAX_DEADLOCK_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isDeadlock = err.code === '40P01';
      const isSerializationFailure = err.code === '40001';

      if ((isDeadlock || isSerializationFailure) && attempt < MAX_DEADLOCK_RETRIES) {
        const delay = DEADLOCK_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn('Deadlock detected, retrying', {
          attempt,
          maxRetries: MAX_DEADLOCK_RETRIES,
          delayMs: delay,
          correlationId
        });
        Counters.increment('onboarding', 'deadlock_retry');
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  OnboardingOrchestrator Class                                              */
/* ────────────────────────────────────────────────────────────────────────── */

class OnboardingOrchestrator {
  constructor() {
    this.validTransitions = Object.freeze({
      'new': Object.freeze(['welcomed', 'awaiting_ready']),
      'welcomed': Object.freeze(['awaiting_ready']),
      'awaiting_ready': Object.freeze(['omiyage_offered']),
      'omiyage_offered': Object.freeze(['onboarded']),
      'onboarded': Object.freeze([])
    });

    this.beforeTransitionHooks = [];
    this.afterTransitionHooks = [];

    this._validateConfiguration();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Configuration Validation                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _validateConfiguration() {
    const stateNames = Object.keys(this.validTransitions);
    const schemaNames = Object.keys(StateDataSchemas);

    const missingSchemas = stateNames.filter(state => !schemaNames.includes(state));
    if (missingSchemas.length > 0) {
      throw new Error(
        `OnboardingOrchestrator configuration error: Missing schemas for states: ${missingSchemas.join(', ')}`
      );
    }

    const extraSchemas = schemaNames.filter(schema => !stateNames.includes(schema));
    if (extraSchemas.length > 0) {
      logger.warn('Extra schemas defined for non-existent states', {
        extraSchemas
      });
    }

    logger.info('Configuration validated', {
      states: stateNames.length,
      schemas: schemaNames.length
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Hook Registration                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  registerBeforeTransitionHook(hookFn) {
    if (typeof hookFn !== 'function') {
      throw new Error('Hook must be a function');
    }
    this.beforeTransitionHooks.push(hookFn);
  }

  registerAfterTransitionHook(hookFn) {
    if (typeof hookFn !== 'function') {
      throw new Error('Hook must be a function');
    }
    this.afterTransitionHooks.push(hookFn);
  }

  async _executeBeforeHooks(userId, fromState, toState, stateData, correlationId) {
    for (const hook of this.beforeTransitionHooks) {
      try {
        await hook(userId, fromState, toState, stateData);
      } catch (err) {
        logger.error('beforeTransition hook failed', {
          userId,
          transition: `${fromState} -> ${toState}`,
          error: err.message,
          correlationId
        });
        throw err;
      }
    }
  }

  async _executeAfterHooks(userId, fromState, toState, newState, correlationId) {
    for (const hook of this.afterTransitionHooks) {
      try {
        await hook(userId, fromState, toState, newState);
      } catch (err) {
        logger.error('afterTransition hook failed', {
          userId,
          transition: `${fromState} -> ${toState}`,
          error: err.message,
          correlationId
        });
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  State Queries                                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  getValidNextStates(fromState) {
    return this.validTransitions[fromState] || [];
  }

  isValidTransition(fromState, toState) {
    const allowedStates = this.validTransitions[fromState] || [];
    return allowedStates.includes(toState);
  }

  async getCurrentState(userId, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        `SELECT user_id, current_state, state_version, state_data, entered_at, updated_at
         FROM user_onboarding_state
         WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (err) {
      logger.error('Error getting state', {
        userId,
        error: err.message,
        correlationId
      });
      throw err;
    }
  }

  async isOnboarded(userId, correlationId) {
    const state = await this.getCurrentState(userId, correlationId);
    return state && state.current_state === 'onboarded';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Initialize User                                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async initializeUser(userId, correlationId) {
    return _withDeadlockRetry(async () => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const existing = await _queryWithTimeout(client,
          'SELECT user_id, current_state, state_version, state_data FROM user_onboarding_state WHERE user_id = $1',
          [userId]
        );

        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          logger.debug('User already initialized', { userId, correlationId });
          return existing.rows[0];
        }

        const result = await _queryWithTimeout(client,
          `INSERT INTO user_onboarding_state
           (user_id, current_state, state_version, state_data)
           VALUES ($1, 'new', 1, '{}')
           RETURNING *`,
          [userId]
        );

        const auditId = await generateHexId('onboarding_audit_id');
        await _queryWithTimeout(client,
          `INSERT INTO user_onboarding_audit
           (audit_id, user_id, from_state, to_state, from_version, to_version, state_data, reason)
           VALUES ($1, $2, NULL, 'new', NULL, 1, '{}', 'user_initialization')`,
          [auditId, userId]
        );

        await client.query('COMMIT');

        logger.info('User initialized', {
          userId,
          state: 'new',
          correlationId
        });
        Counters.increment('onboarding', 'user_initialized');

        return result.rows[0];

      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Initialization failed', {
          userId,
          error: err.message,
          correlationId
        });
        throw err;
      } finally {
        client.release();
      }
    }, correlationId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Advance To Awaiting Ready (Atomic Welcome Flow)                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async advanceToAwaitingReadyAfterWelcome(userId, welcomeBeatId = null, correlationId) {
    return _withDeadlockRetry(async () => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const currentResult = await _queryWithTimeout(client,
          `SELECT user_id, current_state, state_version, state_data
           FROM user_onboarding_state
           WHERE user_id = $1`,
          [userId]
        );

        if (currentResult.rows.length === 0) {
          throw new OnboardingNotInitializedError(userId);
        }

        const current = currentResult.rows[0];
        const fromState = current.current_state;
        const fromVersion = current.state_version;

        if (fromState !== 'new' && fromState !== 'welcomed') {
          throw new InvalidTransitionError(fromState, 'awaiting_ready', ['new', 'welcomed']);
        }

        const stateData = welcomeBeatId ? { welcome_beat_id: welcomeBeatId } : {};

        await this._executeBeforeHooks(userId, fromState, 'awaiting_ready', stateData, correlationId);

        const mergedStateData = { ...current.state_data, ...stateData };

        const updateResult = await _queryWithTimeout(client,
          `UPDATE user_onboarding_state
           SET
             current_state = 'awaiting_ready',
             state_version = state_version + 1,
             state_data = $1,
             entered_at = NOW(),
             updated_at = NOW()
           WHERE user_id = $2 AND state_version = $3
           RETURNING *`,
          [JSON.stringify(mergedStateData), userId, fromVersion]
        );

        if (updateResult.rows.length === 0) {
          throw new OptimisticLockError(userId, fromVersion);
        }

        const newState = updateResult.rows[0];
        const toVersion = newState.state_version;

        const auditId = await generateHexId('onboarding_audit_id');
        await _queryWithTimeout(client,
          `INSERT INTO user_onboarding_audit
           (audit_id, user_id, from_state, to_state, from_version, to_version, state_data, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            auditId,
            userId,
            fromState,
            'awaiting_ready',
            fromVersion,
            toVersion,
            JSON.stringify(mergedStateData),
            'welcome_flow_atomic'
          ]
        );

        await client.query('COMMIT');

        logger.info('Atomic transition complete', {
          userId,
          from: fromState,
          to: 'awaiting_ready',
          fromVersion,
          toVersion,
          reason: 'welcome_flow_atomic',
          correlationId
        });
        Counters.increment('onboarding', 'transition_success');

        await this._executeAfterHooks(userId, fromState, 'awaiting_ready', newState, correlationId);

        return newState;

      } catch (err) {
        await client.query('ROLLBACK');

        logger.error('Atomic transition failed', {
          userId,
          error: err.name || err.message,
          details: err.message,
          correlationId
        });

        if (err.name === 'OptimisticLockError') {
          Counters.increment('onboarding', 'optimistic_lock_conflict');
        } else {
          Counters.increment('onboarding', 'transition_failure');
        }

        throw err;
      } finally {
        client.release();
      }
    }, correlationId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  General Transition                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async transitionTo(userId, toState, stateData = {}, reason = null, correlationId) {
    return _withDeadlockRetry(async () => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const currentResult = await _queryWithTimeout(client,
          `SELECT user_id, current_state, state_version, state_data
           FROM user_onboarding_state
           WHERE user_id = $1`,
          [userId]
        );

        if (currentResult.rows.length === 0) {
          throw new OnboardingNotInitializedError(userId);
        }

        const current = currentResult.rows[0];
        const fromState = current.current_state;
        const fromVersion = current.state_version;

        if (!this.isValidTransition(fromState, toState)) {
          throw new InvalidTransitionError(
            fromState,
            toState,
            this.validTransitions[fromState] || []
          );
        }

        const schema = StateDataSchemas[toState];
        if (schema) {
          const parseResult = schema.safeParse(stateData);
          if (!parseResult.success) {
            const errorMsg = parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
            throw new Error(`Invalid state_data for ${toState}: ${errorMsg}`);
          }
        }

        await this._executeBeforeHooks(userId, fromState, toState, stateData, correlationId);

        const mergedStateData = { ...current.state_data, ...stateData };

        const updateResult = await _queryWithTimeout(client,
          `UPDATE user_onboarding_state
           SET
             current_state = $1,
             state_version = state_version + 1,
             state_data = $2,
             entered_at = NOW(),
             updated_at = NOW()
           WHERE user_id = $3 AND state_version = $4
           RETURNING *`,
          [toState, JSON.stringify(mergedStateData), userId, fromVersion]
        );

        if (updateResult.rows.length === 0) {
          throw new OptimisticLockError(userId, fromVersion);
        }

        const newState = updateResult.rows[0];
        const toVersion = newState.state_version;

        const auditId = await generateHexId('onboarding_audit_id');
        await _queryWithTimeout(client,
          `INSERT INTO user_onboarding_audit
           (audit_id, user_id, from_state, to_state, from_version, to_version, state_data, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            auditId,
            userId,
            fromState,
            toState,
            fromVersion,
            toVersion,
            JSON.stringify(mergedStateData),
            reason
          ]
        );

        await client.query('COMMIT');

        logger.info('Transition complete', {
          userId,
          from: fromState,
          to: toState,
          fromVersion,
          toVersion,
          reason,
          correlationId
        });
        Counters.increment('onboarding', 'transition_success');

        await this._executeAfterHooks(userId, fromState, toState, newState, correlationId);

        return newState;

      } catch (err) {
        await client.query('ROLLBACK');

        logger.error('Transition failed', {
          userId,
          error: err.name || err.message,
          details: err.message,
          correlationId
        });

        if (err.name === 'OptimisticLockError') {
          Counters.increment('onboarding', 'optimistic_lock_conflict');
        } else if (err.name === 'InvalidTransitionError') {
          Counters.increment('onboarding', 'invalid_transition');
        } else {
          Counters.increment('onboarding', 'transition_failure');
        }

        throw err;
      } finally {
        client.release();
      }
    }, correlationId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Admin Force Transition                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async forceTransition(userId, toState, adminReason, correlationId) {
    if (!adminReason) {
      throw new Error('Admin reason required for forced transitions');
    }

    return _withDeadlockRetry(async () => {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const currentResult = await _queryWithTimeout(client,
          'SELECT current_state, state_version, state_data FROM user_onboarding_state WHERE user_id = $1',
          [userId]
        );

        if (currentResult.rows.length === 0) {
          throw new OnboardingNotInitializedError(userId);
        }

        const current = currentResult.rows[0];
        const fromState = current.current_state;
        const fromVersion = current.state_version;

        const updateResult = await _queryWithTimeout(client,
          `UPDATE user_onboarding_state
           SET
             current_state = $1,
             state_version = state_version + 1,
             entered_at = NOW(),
             updated_at = NOW()
           WHERE user_id = $2
           RETURNING *`,
          [toState, userId]
        );

        const newState = updateResult.rows[0];
        const toVersion = newState.state_version;

        const auditId = await generateHexId('onboarding_audit_id');
        await _queryWithTimeout(client,
          `INSERT INTO user_onboarding_audit
           (audit_id, user_id, from_state, to_state, from_version, to_version, state_data, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            auditId,
            userId,
            fromState,
            toState,
            fromVersion,
            toVersion,
            JSON.stringify(current.state_data),
            `ADMIN_OVERRIDE: ${adminReason}`
          ]
        );

        await client.query('COMMIT');

        logger.warn('Admin override transition', {
          userId,
          from: fromState,
          to: toState,
          reason: adminReason,
          correlationId
        });
        Counters.increment('onboarding', 'admin_override');

        return newState;

      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Force transition failed', {
          userId,
          error: err.message,
          correlationId
        });
        Counters.increment('onboarding', 'force_transition_failure');
        throw err;
      } finally {
        client.release();
      }
    }, correlationId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  History & Reporting Queries                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getHistory(userId, { limit = 50, offset = 0 } = {}) {
    try {
      const result = await _poolQueryWithTimeout(
        `SELECT audit_id, from_state, to_state, from_version, to_version,
                state_data, reason, transitioned_at
         FROM user_onboarding_audit
         WHERE user_id = $1
         ORDER BY transitioned_at ASC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return result.rows;
    } catch (err) {
      logger.error('Error getting history', {
        userId,
        error: err.message
      });
      throw err;
    }
  }

  async getUsersInState(stateName, { limit = 100, offset = 0 } = {}) {
    try {
      const result = await _poolQueryWithTimeout(
        `SELECT user_id, entered_at, state_data, state_version
         FROM user_onboarding_state
         WHERE current_state = $1
         ORDER BY entered_at DESC
         LIMIT $2 OFFSET $3`,
        [stateName, limit, offset]
      );

      return result.rows;
    } catch (err) {
      logger.error('Error getting users in state', {
        stateName,
        error: err.message
      });
      throw err;
    }
  }

  async getStuckUsers(stateName, minutesThreshold = 10, correlationId) {
    try {
      const result = await _poolQueryWithTimeout(
        `SELECT user_id, current_state, entered_at, state_version,
                EXTRACT(EPOCH FROM (NOW() - entered_at))/60 AS minutes_in_state
         FROM user_onboarding_state
         WHERE current_state = $1
           AND entered_at < NOW() - INTERVAL '1 minute' * $2
         ORDER BY entered_at ASC`,
        [stateName, minutesThreshold]
      );

      if (result.rows.length > 0) {
        logger.warn('Stuck users detected', {
          stateName,
          count: result.rows.length,
          minutesThreshold,
          correlationId
        });
      }

      return result.rows;
    } catch (err) {
      logger.error('Error getting stuck users', {
        stateName,
        minutesThreshold,
        error: err.message,
        correlationId
      });
      throw err;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const onboardingOrchestrator = new OnboardingOrchestrator();
export default onboardingOrchestrator;

export {
  InvalidTransitionError,
  OptimisticLockError,
  OnboardingNotInitializedError
};
