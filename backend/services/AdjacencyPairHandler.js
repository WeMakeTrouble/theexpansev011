/**
 * ============================================================================
 * AdjacencyPairHandler.js — Conversational Expectation Manager (v010 r2)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages conversational adjacency pairs — the social contracts of dialogue.
 * When Claude performs a First Pair Part (FPP) such as asking a question,
 * this handler creates an expectation for a corresponding Second Pair Part
 * (SPP) such as an answer. It tracks whether expectations are satisfied
 * (preferred or dispreferred response), violated, or expired.
 *
 * ADJACENCY PAIR THEORY
 * ---------------------
 * Conversation analysis identifies paired speech acts:
 *   Question → Answer (preferred) / Refusal (dispreferred)
 *   Greeting → Greeting (preferred) / Silence (violation)
 *   Offer → Accept (preferred) / Decline (dispreferred)
 *   Request → Comply (preferred) / Refuse (dispreferred)
 *
 * This handler implements the expectation lifecycle:
 *   1. FPP occurs → expectation created with preferred/dispreferred SPP codes
 *   2. Turns pass → relevance decays exponentially
 *   3. SPP occurs → expectation resolved (satisfied/violated/expired)
 *
 * OBSERVE MODE
 * ------------
 * Default: OBSERVE_MODE = true. The handler detects and logs expectation
 * events but does NOT clear expectations or enforce responses. This allows
 * data gathering on conversational patterns before enabling enforcement.
 * When OBSERVE_MODE is false, satisfied and expired expectations are
 * automatically cleared from conversation state.
 *
 * RELEVANCE DECAY
 * ---------------
 * Expectations lose relevance over turns via exponential decay:
 *   decayedStrength = baseStrength * (decayFactor ^ excessTurns)
 * where excessTurns = max(0, turnsElapsed - expectationTimeout)
 *
 * The decay factor defaults to CONFIG.DEFAULT_DECAY_FACTOR (0.7) but
 * individual pairs can override this via their decay_factor column.
 *
 * Turn elapsed is always computed from createdAtTurn, never stored
 * separately, to prevent drift between computed and stored values.
 *
 * CACHING
 * -------
 * Adjacency pair definitions are cached in memory with a TTL.
 * Cache refresh uses a mutex flag to prevent thundering herd when
 * multiple concurrent requests trigger refresh simultaneously.
 * Refresh failures are non-fatal — stale cache is used until next
 * successful refresh.
 *
 * CORRELATION ID THREADING
 * ------------------------
 * All public methods accept an optional correlationId parameter.
 * This is threaded through all log entries and event records to
 * enable end-to-end trace continuity across the pipeline.
 *
 * INTEGRATION POINTS
 * ------------------
 * - ConversationStateManager: reads/writes conversation state
 * - BrainOrchestrator: calls checkExpectation after intent matching
 *   (needs candidateSppCode which is only known after PhaseIntent)
 * - EarWig does NOT call this handler (see EarWig brief Part 2.3)
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, ConversationStateManager.js
 * External: None
 *
 * V010 R2 CHANGES
 * ---------------
 * - Correlation ID threading on all public methods and log entries
 * - Cache refresh mutex prevents thundering herd under concurrency
 * - Per-pair decay factor override (falls back to default)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import ConversationStateManager from './ConversationStateManager.js';

const logger = createModuleLogger('AdjacencyPairHandler');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const CONFIG = Object.freeze({
  CACHE_TTL_MS: 300000,
  DEFAULT_DECAY_FACTOR: 0.7,
  DEFAULT_OBSERVE_MODE: true
});

const EXPECTATION_STATUS = Object.freeze({
  SATISFIED_PREFERRED: 'satisfied_preferred',
  SATISFIED_DISPREFERRED: 'satisfied_dispreferred',
  VIOLATED: 'violated',
  EXPIRED: 'expired'
});

const CACHE_COLUMNS = Object.freeze([
  'pair_id',
  'fpp_act_code',
  'preferred_spp_code',
  'dispreferred_spp_codes',
  'relevance_strength',
  'expectation_timeout',
  'decay_factor'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _validateNonEmptyString(value, name) {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new Error('AdjacencyPairHandler: ' + name + ' must be a non-empty string, got: ' + typeof value);
  }
}

function _validateNonNegativeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('AdjacencyPairHandler: ' + name + ' must be a non-negative integer, got: ' + value);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  AdjacencyPairHandler Class                                                */
/* ────────────────────────────────────────────────────────────────────────── */

class AdjacencyPairHandler {
  constructor() {
    this._observeMode = CONFIG.DEFAULT_OBSERVE_MODE;
    this._pairCache = new Map();
    this._lastCacheRefresh = 0;
    this._isRefreshing = false;
    this._refreshPromise = null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Cache Management (mutex-protected)                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async refreshCache() {
    const now = Date.now();
    if (now - this._lastCacheRefresh < CONFIG.CACHE_TTL_MS && this._pairCache.size > 0) {
      return;
    }

    if (this._isRefreshing && this._refreshPromise) {
      await this._refreshPromise;
      return;
    }

    this._isRefreshing = true;
    this._refreshPromise = this._doRefresh(now);

    try {
      await this._refreshPromise;
    } finally {
      this._isRefreshing = false;
      this._refreshPromise = null;
    }
  }

  async _doRefresh(now) {
    try {
      const query = 'SELECT ' + CACHE_COLUMNS.join(', ') + ' FROM adjacency_pairs';
      const result = await pool.query(query);

      this._pairCache.clear();
      for (const row of result.rows) {
        this._pairCache.set(row.fpp_act_code, {
          pairId: row.pair_id,
          fppActCode: row.fpp_act_code,
          preferredSppCode: row.preferred_spp_code,
          dispreferredSppCodes: row.dispreferred_spp_codes || [],
          relevanceStrength: parseFloat(row.relevance_strength),
          expectationTimeout: row.expectation_timeout,
          decayFactor: row.decay_factor !== null && row.decay_factor !== undefined
            ? parseFloat(row.decay_factor)
            : CONFIG.DEFAULT_DECAY_FACTOR
        });
      }

      this._lastCacheRefresh = now;
      logger.info('Cache refreshed', { pairsLoaded: this._pairCache.size });
    } catch (err) {
      logger.warn('Cache refresh failed — using stale cache', { error: err.message });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Get Expectation Definition                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getExpectation(fppActCode, correlationId) {
    _validateNonEmptyString(fppActCode, 'fppActCode');
    await this.refreshCache();
    return this._pairCache.get(fppActCode) || null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Create Expectation                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async createExpectation(conversationId, fppActCode, turnIndex, correlationId) {
    _validateNonEmptyString(conversationId, 'conversationId');
    _validateNonEmptyString(fppActCode, 'fppActCode');
    _validateNonNegativeInteger(turnIndex, 'turnIndex');

    await this.refreshCache();

    const pair = this._pairCache.get(fppActCode);
    if (!pair) {
      logger.info('No adjacency pair defined', { fppActCode, correlationId });
      return null;
    }

    const expectation = {
      pairId: pair.pairId,
      fppActCode: pair.fppActCode,
      preferredSppCode: pair.preferredSppCode,
      dispreferredSppCodes: pair.dispreferredSppCodes,
      relevanceStrength: pair.relevanceStrength,
      expectationTimeout: pair.expectationTimeout,
      decayFactor: pair.decayFactor,
      createdAtTurn: turnIndex
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE conversation_states ' +
        'SET pending_fpp = $1, expected_spp = $2, updated_at = NOW() ' +
        'WHERE conversation_id = $3',
        [JSON.stringify(expectation), pair.preferredSppCode, conversationId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to create expectation', {
        conversationId,
        fppActCode,
        correlationId,
        error: err.message
      });
      throw err;
    } finally {
      client.release();
    }

    logger.info('Created expectation', {
      fppActCode,
      preferredSpp: pair.preferredSppCode,
      createdAtTurn: turnIndex,
      decayFactor: pair.decayFactor,
      correlationId
    });

    return expectation;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Check Expectation                                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async checkExpectation(conversationId, candidateSppCode, currentTurnIndex, correlationId) {
    _validateNonEmptyString(conversationId, 'conversationId');
    _validateNonEmptyString(candidateSppCode, 'candidateSppCode');
    _validateNonNegativeInteger(currentTurnIndex, 'currentTurnIndex');

    const state = await ConversationStateManager.getState(conversationId);

    if (!state || !state.pending_fpp) {
      return { hasExpectation: false };
    }

    const expectation = state.pending_fpp;
    const turnsElapsed = Math.max(0, currentTurnIndex - expectation.createdAtTurn);
    const decayFactor = expectation.decayFactor || CONFIG.DEFAULT_DECAY_FACTOR;

    if (turnsElapsed >= expectation.expectationTimeout) {
      const result = {
        hasExpectation: true,
        status: EXPECTATION_STATUS.EXPIRED,
        expectation,
        turnsElapsed,
        decayedStrength: this._calculateDecayedStrength(
          expectation.relevanceStrength, turnsElapsed,
          expectation.expectationTimeout, decayFactor
        )
      };

      await this._logExpectationEvent(
        conversationId, EXPECTATION_STATUS.EXPIRED,
        expectation, candidateSppCode, turnsElapsed, correlationId
      );

      if (!this._observeMode) {
        await this._clearExpectation(conversationId, correlationId);
      }

      return result;
    }

    if (candidateSppCode === expectation.preferredSppCode) {
      const result = {
        hasExpectation: true,
        status: EXPECTATION_STATUS.SATISFIED_PREFERRED,
        expectation,
        turnsElapsed
      };

      await this._logExpectationEvent(
        conversationId, EXPECTATION_STATUS.SATISFIED_PREFERRED,
        expectation, candidateSppCode, turnsElapsed, correlationId
      );

      if (!this._observeMode) {
        await this._clearExpectation(conversationId, correlationId);
      }

      return result;
    }

    if (expectation.dispreferredSppCodes &&
        expectation.dispreferredSppCodes.includes(candidateSppCode)) {
      const result = {
        hasExpectation: true,
        status: EXPECTATION_STATUS.SATISFIED_DISPREFERRED,
        expectation,
        turnsElapsed,
        dispreferredUsed: candidateSppCode
      };

      await this._logExpectationEvent(
        conversationId, EXPECTATION_STATUS.SATISFIED_DISPREFERRED,
        expectation, candidateSppCode, turnsElapsed, correlationId
      );

      if (!this._observeMode) {
        await this._clearExpectation(conversationId, correlationId);
      }

      return result;
    }

    const result = {
      hasExpectation: true,
      status: EXPECTATION_STATUS.VIOLATED,
      expectation,
      turnsElapsed,
      expectedCode: expectation.preferredSppCode,
      actualCode: candidateSppCode
    };

    await this._logExpectationEvent(
      conversationId, EXPECTATION_STATUS.VIOLATED,
      expectation, candidateSppCode, turnsElapsed, correlationId
    );

    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Decay Calculation (per-pair configurable)                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateDecayedStrength(baseStrength, turnsElapsed, timeout, decayFactor) {
    const excessTurns = Math.max(0, turnsElapsed - timeout);
    return baseStrength * Math.pow(decayFactor, excessTurns);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Clear Expectation (Internal — used when OBSERVE_MODE is off)            */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _clearExpectation(conversationId, correlationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE conversation_states ' +
        'SET pending_fpp = NULL, expected_spp = NULL, updated_at = NOW() ' +
        'WHERE conversation_id = $1',
        [conversationId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to clear expectation', {
        conversationId,
        correlationId,
        error: err.message
      });
    } finally {
      client.release();
    }

    logger.info('Cleared expectation', { conversationId, correlationId });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Event Logging                                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _logExpectationEvent(conversationId, eventType, expectation, actualCode, turnsElapsed, correlationId) {
    const logEntry = {
      eventType,
      fppActCode: expectation.fppActCode,
      expectedSppCode: expectation.preferredSppCode,
      actualSppCode: actualCode,
      turnsElapsed,
      relevanceStrength: expectation.relevanceStrength,
      decayFactor: expectation.decayFactor || CONFIG.DEFAULT_DECAY_FACTOR,
      timestamp: new Date().toISOString(),
      observeMode: this._observeMode,
      correlationId
    };

    logger.info('Expectation event', { eventType, correlationId, logEntry });

    try {
      await ConversationStateManager.recordMove(conversationId, {
        type: 'adjacency_event',
        ...logEntry
      });
    } catch (err) {
      logger.warn('Failed to record adjacency event move', {
        conversationId,
        eventType,
        correlationId,
        error: err.message
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Get Pending Expectation                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getPendingExpectation(conversationId, correlationId) {
    _validateNonEmptyString(conversationId, 'conversationId');
    const state = await ConversationStateManager.getState(conversationId);
    return (state && state.pending_fpp) ? state.pending_fpp : null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Observe Mode Control                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  setObserveMode(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new Error('AdjacencyPairHandler: setObserveMode requires a boolean');
    }
    this._observeMode = enabled;
    logger.info('Observe mode changed', { enabled });
  }

  isObserveMode() {
    return this._observeMode;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Violation Statistics                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getViolationStats(conversationId, correlationId) {
    _validateNonEmptyString(conversationId, 'conversationId');

    const state = await ConversationStateManager.getState(conversationId);
    if (!state || !state.last_moves) {
      return {
        total: 0,
        violations: 0,
        expirations: 0,
        satisfiedPreferred: 0,
        satisfiedDispreferred: 0
      };
    }

    const adjacencyEvents = state.last_moves.filter(m => m.type === 'adjacency_event');

    return {
      total: adjacencyEvents.length,
      violations: adjacencyEvents.filter(
        e => e.eventType === EXPECTATION_STATUS.VIOLATED
      ).length,
      expirations: adjacencyEvents.filter(
        e => e.eventType === EXPECTATION_STATUS.EXPIRED
      ).length,
      satisfiedPreferred: adjacencyEvents.filter(
        e => e.eventType === EXPECTATION_STATUS.SATISFIED_PREFERRED
      ).length,
      satisfiedDispreferred: adjacencyEvents.filter(
        e => e.eventType === EXPECTATION_STATUS.SATISFIED_DISPREFERRED
      ).length
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new AdjacencyPairHandler();
