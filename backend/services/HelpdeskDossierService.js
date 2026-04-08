/**
 * ============================================================================
 * HelpdeskDossierService.js — Helpdesk Context Persistence Layer (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages the helpdesk_context JSONB column in cotw_dossiers.
 * This is the persistence layer for PhaseClaudesHelpDesk — it tracks
 * repetition counts, escalation history, and user type transitions
 * with exponential time-decay so old signals naturally cool down.
 *
 * HOW IT WORKS
 * ------------
 * 1. LOAD (loadHelpdeskContext):
 *    - Reads helpdesk_context JSONB from cotw_dossiers for a dossier_id
 *    - Returns safe defaults if dossier not found or data malformed
 *    - Defensive: ensureHelpdeskContext normalises any legacy/partial data
 *
 * 2. RECORD SIGNAL (recordSignal):
 *    - Called when PhaseClaudesHelpDesk detects a helpdesk intent
 *    - Applies time-decay to existing count BEFORE incrementing
 *    - Adds to intent history (capped at MAX_INTENT_HISTORY)
 *    - Tracks user type transitions (human, b_roll, gronk)
 *    - Updates atomically inside a transaction with row-level locking
 *    - Load happens INSIDE the transaction to prevent lost updates
 *
 * 3. RECORD ESCALATION (recordEscalation):
 *    - Records when a helpdesk issue is escalated
 *    - Maintains full escalation history with timestamps and reasons
 *    - Status tracking: pending / resolved
 *
 * 4. RECORD HUMAN ACTION (recordHumanAction):
 *    - Tracks purchases, signups, VIP status changes
 *    - Separated from B-Roll tracking to keep data clean
 *
 * 5. RECORD B-ROLL SIGNAL (recordBRollSignal):
 *    - Tracks learning gaps and narrative issues for B-Roll characters
 *    - Deduplicates learning gaps by name
 *
 * 6. GET REPETITION COUNT (getRepetitionCount):
 *    - Returns raw or decayed count for a specific intent
 *    - Decay is pre-computed and stored for auditability
 *
 * DECAY STRATEGY
 * --------------
 * Counts decay exponentially over a 30-day window:
 *   decayed = count * (DECAY_FACTOR ^ (days_elapsed / DECAY_WINDOW_DAYS))
 *
 * After 30 days, the count reaches zero (expired).
 * This allows:
 *   - Fresh concerns to escalate properly
 *   - Old issues to naturally cool down
 *   - Full audit trail (both raw and decayed counts preserved)
 *
 * PRECISION
 * ---------
 * All decimal values use consistent toFixed(DECIMAL_PRECISION) rounding.
 * Prevents floating-point drift over time in JSONB storage.
 *
 * TRANSACTION SAFETY
 * ------------------
 * All mutations use explicit transaction blocks with row-level locking
 * (SELECT ... FOR UPDATE). The context load happens inside the
 * transaction to prevent lost updates under concurrency.
 *
 * JSONB DATA STRUCTURE (helpdesk_context column)
 * -----------------------------------------------
 * {
 *   "lastUpdated": "2025-01-16T12:34:56Z",
 *   "userTypeHistory": ["human", "b_roll"],
 *   "currentUserType": "b_roll",
 *   "repetitionCounts": { "NARRATIVE_PARADOX": 3 },
 *   "decayedRepetitionCounts": { "NARRATIVE_PARADOX": 2.50 },
 *   "escalationHistory": [{
 *     "intent": "NARRATIVE_PARADOX",
 *     "escalatedAt": "2025-01-16T10:00:00Z",
 *     "reason": "NPC stuck in paradox loop",
 *     "status": "pending"
 *   }],
 *   "intentHistory": [{
 *     "intent": "EXISTENTIAL_CRISIS",
 *     "detectedAt": "2025-01-16T11:45:00Z",
 *     "strength": 0.85,
 *     "userType": "b_roll"
 *   }],
 *   "humanHelpdesk": {
 *     "lastPurchaseAt": null,
 *     "purchaseCount": 0,
 *     "emailSignedUp": false,
 *     "vipStatus": null
 *   },
 *   "b_rollHelpdesk": {
 *     "learningGapsIdentified": [],
 *     "narrativeIssuesFound": 0,
 *     "lastQuestionAt": null
 *   }
 * }
 *
 * INVARIANTS
 * ----------
 * - Always returns safe defaults on error (never throws to caller)
 * - Never loses escalation history
 * - User type transitions are tracked and deduplicated
 * - Timestamps are ISO 8601
 * - Decay is deterministic, auditable, and precise
 * - All decimal precision is consistent
 * - Never mutates input parameters
 * - All DB operations are transactional with row-level locking
 * - No console.log — structured logger only
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js
 *
 * DATABASE TABLE: cotw_dossiers (helpdesk_context JSONB column)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('HelpdeskDossierService');

/* ========================================================================== */
/*  Constants                                                                  */
/* ========================================================================== */

const DECAY_WINDOW_DAYS = 30;
const DECAY_FACTOR = 0.5;
const MAX_INTENT_HISTORY = 50;
const DECIMAL_PRECISION = 2;
const MS_PER_DAY = 86400000;

const VALID_USER_TYPES = Object.freeze(['human', 'b_roll', 'gronk']);
const VALID_HUMAN_ACTIONS = Object.freeze(['purchase', 'signup', 'vip']);
const VALID_BROLL_SIGNALS = Object.freeze(['learning_gap', 'narrative_issue']);
const VALID_ESCALATION_STATUSES = Object.freeze(['pending', 'resolved']);

const DEFAULT_HELPDESK_CONTEXT = Object.freeze({
  lastUpdated: null,
  userTypeHistory: [],
  currentUserType: null,
  repetitionCounts: {},
  decayedRepetitionCounts: {},
  escalationHistory: [],
  intentHistory: [],
  humanHelpdesk: {
    lastPurchaseAt: null,
    purchaseCount: 0,
    emailSignedUp: false,
    vipStatus: null
  },
  b_rollHelpdesk: {
    learningGapsIdentified: [],
    narrativeIssuesFound: 0,
    lastQuestionAt: null
  }
});

/* ========================================================================== */
/*  Helper Functions (pure, stateless)                                         */
/* ========================================================================== */

function _getTimestamp() {
  return new Date().toISOString();
}

function _daysSince(isoTimestamp) {
  if (!isoTimestamp) return Infinity;
  const then = new Date(isoTimestamp);
  const now = new Date();
  const ms = now - then;
  return ms / MS_PER_DAY;
}

function _toFixedPrecision(value) {
  return Number(value.toFixed(DECIMAL_PRECISION));
}

function _applyTimeDecay(count, timestamp) {
  const days = _daysSince(timestamp);

  if (days > DECAY_WINDOW_DAYS) {
    return 0;
  }

  if (days <= 0) {
    return count;
  }

  const normalized = days / DECAY_WINDOW_DAYS;
  return _toFixedPrecision(count * Math.pow(DECAY_FACTOR, normalized));
}

function _ensureHelpdeskContext(dossierHelpdesk) {
  if (!dossierHelpdesk || typeof dossierHelpdesk !== 'object') {
    return _deepCopyDefault();
  }

  return {
    lastUpdated: dossierHelpdesk.lastUpdated || null,
    userTypeHistory: Array.isArray(dossierHelpdesk.userTypeHistory)
      ? [...dossierHelpdesk.userTypeHistory]
      : [],
    currentUserType: dossierHelpdesk.currentUserType || null,
    repetitionCounts: dossierHelpdesk.repetitionCounts
      ? { ...dossierHelpdesk.repetitionCounts }
      : {},
    decayedRepetitionCounts: dossierHelpdesk.decayedRepetitionCounts
      ? { ...dossierHelpdesk.decayedRepetitionCounts }
      : {},
    escalationHistory: Array.isArray(dossierHelpdesk.escalationHistory)
      ? [...dossierHelpdesk.escalationHistory]
      : [],
    intentHistory: Array.isArray(dossierHelpdesk.intentHistory)
      ? [...dossierHelpdesk.intentHistory]
      : [],
    humanHelpdesk: {
      lastPurchaseAt: dossierHelpdesk.humanHelpdesk?.lastPurchaseAt || null,
      purchaseCount: dossierHelpdesk.humanHelpdesk?.purchaseCount || 0,
      emailSignedUp: dossierHelpdesk.humanHelpdesk?.emailSignedUp || false,
      vipStatus: dossierHelpdesk.humanHelpdesk?.vipStatus || null
    },
    b_rollHelpdesk: {
      learningGapsIdentified: Array.isArray(dossierHelpdesk.b_rollHelpdesk?.learningGapsIdentified)
        ? [...dossierHelpdesk.b_rollHelpdesk.learningGapsIdentified]
        : [],
      narrativeIssuesFound: dossierHelpdesk.b_rollHelpdesk?.narrativeIssuesFound || 0,
      lastQuestionAt: dossierHelpdesk.b_rollHelpdesk?.lastQuestionAt || null
    }
  };
}

function _deepCopyDefault() {
  return {
    lastUpdated: null,
    userTypeHistory: [],
    currentUserType: null,
    repetitionCounts: {},
    decayedRepetitionCounts: {},
    escalationHistory: [],
    intentHistory: [],
    humanHelpdesk: {
      lastPurchaseAt: null,
      purchaseCount: 0,
      emailSignedUp: false,
      vipStatus: null
    },
    b_rollHelpdesk: {
      learningGapsIdentified: [],
      narrativeIssuesFound: 0,
      lastQuestionAt: null
    }
  };
}

function _updateUserTypeHistory(context, newUserType) {
  if (!newUserType) return context;

  if (context.currentUserType !== newUserType) {
    if (!context.userTypeHistory.includes(newUserType)) {
      context.userTypeHistory.push(newUserType);
    }
    context.currentUserType = newUserType;
  }

  return context;
}

function _computeDecayedCounts(context) {
  const decayed = {};

  for (const [intent, count] of Object.entries(context.repetitionCounts)) {
    const lastRecord = context.intentHistory
      .filter(h => h.intent === intent)
      .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))[0];

    if (lastRecord) {
      decayed[intent] = _applyTimeDecay(count, lastRecord.detectedAt);
    } else {
      decayed[intent] = count;
    }
  }

  return decayed;
}

/* ========================================================================== */
/*  HelpdeskDossierService                                                     */
/* ========================================================================== */

class HelpdeskDossierService {

  /**
   * Load helpdesk context for a dossier.
   *
   * @param {string} dossierId - dossier_id from cotw_dossiers
   * @param {string} correlationId - for structured logging
   * @returns {Promise<object>} helpdesk context (safe defaults on error)
   */
  async loadHelpdeskContext(dossierId, correlationId) {
    if (!dossierId || typeof dossierId !== 'string') {
      logger.warn('loadHelpdeskContext called with invalid dossierId', {
        correlationId, dossierId
      });
      return _deepCopyDefault();
    }

    try {
      const result = await pool.query(
        'SELECT helpdesk_context FROM cotw_dossiers WHERE dossier_id = $1',
        [dossierId]
      );

      if (result.rows.length === 0) {
        logger.warn('Dossier not found', { dossierId, correlationId });
        return _deepCopyDefault();
      }

      const context = _ensureHelpdeskContext(result.rows[0].helpdesk_context);

      logger.debug('Context loaded', {
        dossierId,
        correlationId,
        repetitionIntents: Object.keys(context.repetitionCounts).length,
        escalationCount: context.escalationHistory.length
      });

      return context;
    } catch (err) {
      logger.error('loadHelpdeskContext failed', err, {
        dossierId, correlationId
      });
      return _deepCopyDefault();
    }
  }

  /**
   * Record a helpdesk signal and update repetition count.
   * Applies time-decay before incrementing. Load and update happen
   * inside the same transaction to prevent lost updates.
   *
   * @param {string} dossierId - dossier_id
   * @param {string} primaryIntent - detected intent name
   * @param {string} userType - "human", "b_roll", or "gronk"
   * @param {number} strength - signal strength 0-1
   * @param {string} correlationId - for structured logging
   * @returns {Promise<object>} updated context + computed counts
   */
  async recordSignal(dossierId, primaryIntent, userType, strength, correlationId) {
    if (!dossierId || typeof dossierId !== 'string') {
      logger.warn('recordSignal called with invalid dossierId', { correlationId });
      return { context: _deepCopyDefault(), repetitionCount: 0, decayedRepetitionCount: 0 };
    }

    if (!primaryIntent || typeof primaryIntent !== 'string') {
      logger.warn('recordSignal called with invalid primaryIntent', { correlationId, dossierId });
      return { context: _deepCopyDefault(), repetitionCount: 0, decayedRepetitionCount: 0 };
    }

    if (userType && !VALID_USER_TYPES.includes(userType)) {
      logger.warn('recordSignal called with invalid userType', {
        correlationId, dossierId, userType
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT 1 FROM cotw_dossiers WHERE dossier_id = $1 FOR UPDATE',
        [dossierId]
      );

      const loadResult = await client.query(
        'SELECT helpdesk_context FROM cotw_dossiers WHERE dossier_id = $1',
        [dossierId]
      );

      if (loadResult.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn('recordSignal — dossier not found', { dossierId, correlationId });
        return { context: _deepCopyDefault(), repetitionCount: 0, decayedRepetitionCount: 0 };
      }

      const context = _ensureHelpdeskContext(loadResult.rows[0].helpdesk_context);

      _updateUserTypeHistory(context, userType);

      const lastRecord = context.intentHistory
        .filter(h => h.intent === primaryIntent)
        .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))[0];

      let currentCount = context.repetitionCounts[primaryIntent] || 0;
      if (lastRecord && currentCount > 0) {
        currentCount = _applyTimeDecay(currentCount, lastRecord.detectedAt);
      }

      context.repetitionCounts[primaryIntent] = _toFixedPrecision(currentCount + 1);

      context.intentHistory.push({
        intent: primaryIntent,
        detectedAt: _getTimestamp(),
        strength: typeof strength === 'number' ? strength : 0,
        userType: userType || null
      });

      if (context.intentHistory.length > MAX_INTENT_HISTORY) {
        context.intentHistory = context.intentHistory.slice(-MAX_INTENT_HISTORY);
      }

      context.decayedRepetitionCounts = _computeDecayedCounts(context);
      context.lastUpdated = _getTimestamp();

      await client.query(
        'UPDATE cotw_dossiers SET helpdesk_context = $1, updated_at = NOW() WHERE dossier_id = $2',
        [JSON.stringify(context), dossierId]
      );

      await client.query('COMMIT');

      const repetitionCount = context.repetitionCounts[primaryIntent];

      logger.debug('Signal recorded', {
        dossierId,
        primaryIntent,
        repetitionCount,
        decayedCount: context.decayedRepetitionCounts[primaryIntent],
        correlationId
      });

      return {
        context,
        repetitionCount,
        decayedRepetitionCount: context.decayedRepetitionCounts[primaryIntent] || 0,
        lastRecordedAt: context.lastUpdated
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('recordSignal failed', err, { dossierId, correlationId });
      return { context: _deepCopyDefault(), repetitionCount: 0, decayedRepetitionCount: 0 };
    } finally {
      client.release();
    }
  }

  /**
   * Record an escalation event.
   *
   * @param {string} dossierId - dossier_id
   * @param {string} primaryIntent - intent being escalated
   * @param {string} reason - escalation reason
   * @param {string} correlationId - for structured logging
   * @returns {Promise<object>} updated context
   */
  async recordEscalation(dossierId, primaryIntent, reason, correlationId) {
    if (!dossierId || typeof dossierId !== 'string') {
      logger.warn('recordEscalation called with invalid dossierId', { correlationId });
      return _deepCopyDefault();
    }

    if (!primaryIntent || typeof primaryIntent !== 'string') {
      logger.warn('recordEscalation called with invalid primaryIntent', { correlationId, dossierId });
      return _deepCopyDefault();
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT 1 FROM cotw_dossiers WHERE dossier_id = $1 FOR UPDATE',
        [dossierId]
      );

      const loadResult = await client.query(
        'SELECT helpdesk_context FROM cotw_dossiers WHERE dossier_id = $1',
        [dossierId]
      );

      if (loadResult.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn('recordEscalation — dossier not found', { dossierId, correlationId });
        return _deepCopyDefault();
      }

      const context = _ensureHelpdeskContext(loadResult.rows[0].helpdesk_context);

      context.escalationHistory.push({
        intent: primaryIntent,
        escalatedAt: _getTimestamp(),
        reason: reason || 'No reason provided',
        status: 'pending'
      });

      context.lastUpdated = _getTimestamp();

      await client.query(
        'UPDATE cotw_dossiers SET helpdesk_context = $1, updated_at = NOW() WHERE dossier_id = $2',
        [JSON.stringify(context), dossierId]
      );

      await client.query('COMMIT');

      logger.info('Escalation recorded', {
        dossierId,
        primaryIntent,
        escalationCount: context.escalationHistory.length,
        correlationId
      });

      return context;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('recordEscalation failed', err, { dossierId, correlationId });
      return _deepCopyDefault();
    } finally {
      client.release();
    }
  }

  /**
   * Record a human action (purchase, signup, VIP status).
   *
   * @param {string} dossierId - dossier_id
   * @param {object} humanAction - { type: "purchase"|"signup"|"vip", data: {...} }
   * @param {string} correlationId - for structured logging
   * @returns {Promise<object>} updated context
   */
  async recordHumanAction(dossierId, humanAction, correlationId) {
    if (!dossierId || typeof dossierId !== 'string') {
      logger.warn('recordHumanAction called with invalid dossierId', { correlationId });
      return _deepCopyDefault();
    }

    if (!humanAction || !VALID_HUMAN_ACTIONS.includes(humanAction.type)) {
      logger.warn('recordHumanAction called with invalid action type', {
        correlationId, dossierId, type: humanAction?.type
      });
      return _deepCopyDefault();
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT 1 FROM cotw_dossiers WHERE dossier_id = $1 FOR UPDATE',
        [dossierId]
      );

      const loadResult = await client.query(
        'SELECT helpdesk_context FROM cotw_dossiers WHERE dossier_id = $1',
        [dossierId]
      );

      if (loadResult.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn('recordHumanAction — dossier not found', { dossierId, correlationId });
        return _deepCopyDefault();
      }

      const context = _ensureHelpdeskContext(loadResult.rows[0].helpdesk_context);

      _updateUserTypeHistory(context, 'human');

      if (humanAction.type === 'purchase') {
        context.humanHelpdesk.purchaseCount += 1;
        context.humanHelpdesk.lastPurchaseAt = _getTimestamp();
      } else if (humanAction.type === 'signup') {
        context.humanHelpdesk.emailSignedUp = true;
      } else if (humanAction.type === 'vip') {
        context.humanHelpdesk.vipStatus = humanAction.data?.status || 'active';
      }

      context.lastUpdated = _getTimestamp();

      await client.query(
        'UPDATE cotw_dossiers SET helpdesk_context = $1, updated_at = NOW() WHERE dossier_id = $2',
        [JSON.stringify(context), dossierId]
      );

      await client.query('COMMIT');

      logger.info('Human action recorded', {
        dossierId,
        actionType: humanAction.type,
        correlationId
      });

      return context;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('recordHumanAction failed', err, { dossierId, correlationId });
      return _deepCopyDefault();
    } finally {
      client.release();
    }
  }

  /**
   * Record a B-Roll learning gap or narrative issue.
   *
   * @param {string} dossierId - dossier_id
   * @param {object} bRollSignal - { type: "learning_gap"|"narrative_issue", data: {...} }
   * @param {string} correlationId - for structured logging
   * @returns {Promise<object>} updated context
   */
  async recordBRollSignal(dossierId, bRollSignal, correlationId) {
    if (!dossierId || typeof dossierId !== 'string') {
      logger.warn('recordBRollSignal called with invalid dossierId', { correlationId });
      return _deepCopyDefault();
    }

    if (!bRollSignal || !VALID_BROLL_SIGNALS.includes(bRollSignal.type)) {
      logger.warn('recordBRollSignal called with invalid signal type', {
        correlationId, dossierId, type: bRollSignal?.type
      });
      return _deepCopyDefault();
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT 1 FROM cotw_dossiers WHERE dossier_id = $1 FOR UPDATE',
        [dossierId]
      );

      const loadResult = await client.query(
        'SELECT helpdesk_context FROM cotw_dossiers WHERE dossier_id = $1',
        [dossierId]
      );

      if (loadResult.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn('recordBRollSignal — dossier not found', { dossierId, correlationId });
        return _deepCopyDefault();
      }

      const context = _ensureHelpdeskContext(loadResult.rows[0].helpdesk_context);

      _updateUserTypeHistory(context, 'b_roll');

      if (bRollSignal.type === 'learning_gap') {
        const gap = bRollSignal.data?.gap;
        if (gap && typeof gap === 'string' && !context.b_rollHelpdesk.learningGapsIdentified.includes(gap)) {
          context.b_rollHelpdesk.learningGapsIdentified.push(gap);
        }
      } else if (bRollSignal.type === 'narrative_issue') {
        context.b_rollHelpdesk.narrativeIssuesFound += 1;
      }

      context.b_rollHelpdesk.lastQuestionAt = _getTimestamp();
      context.lastUpdated = _getTimestamp();

      await client.query(
        'UPDATE cotw_dossiers SET helpdesk_context = $1, updated_at = NOW() WHERE dossier_id = $2',
        [JSON.stringify(context), dossierId]
      );

      await client.query('COMMIT');

      logger.info('B-Roll signal recorded', {
        dossierId,
        signalType: bRollSignal.type,
        gapCount: context.b_rollHelpdesk.learningGapsIdentified.length,
        narrativeIssues: context.b_rollHelpdesk.narrativeIssuesFound,
        correlationId
      });

      return context;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('recordBRollSignal failed', err, { dossierId, correlationId });
      return _deepCopyDefault();
    } finally {
      client.release();
    }
  }

  /**
   * Get repetition count for an intent, optionally with time decay applied.
   *
   * @param {string} dossierId - dossier_id
   * @param {string} primaryIntent - intent to check
   * @param {boolean} applyDecay - whether to return decayed count
   * @param {string} correlationId - for structured logging
   * @returns {Promise<number>} current repetition count
   */
  async getRepetitionCount(dossierId, primaryIntent, applyDecay = false, correlationId) {
    if (!dossierId || typeof dossierId !== 'string' || !primaryIntent) {
      return 0;
    }

    try {
      const context = await this.loadHelpdeskContext(dossierId, correlationId);

      if (applyDecay) {
        return context.decayedRepetitionCounts[primaryIntent] || 0;
      }

      return context.repetitionCounts[primaryIntent] || 0;
    } catch (err) {
      logger.error('getRepetitionCount failed', err, {
        dossierId, primaryIntent, correlationId
      });
      return 0;
    }
  }
}

/* ========================================================================== */
/*  Singleton Export                                                            */
/* ========================================================================== */

const helpdeskDossierService = new HelpdeskDossierService();
export default helpdeskDossierService;
