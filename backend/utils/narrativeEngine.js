/**
 * ============================================================================
 * narrativeEngine.js — Narrative Progression State Machine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Core narrative progression engine for The Expanse. Manages character
 * movement through the branching story graph, evaluates path conditions,
 * processes user choices, applies consequences, and queries narrative lore.
 *
 * This module contains BUSINESS LOGIC only. All database CRUD operations
 * are delegated to narrativeAccess.js (the data access layer). This module
 * never executes raw SQL for operations that narrativeAccess already provides.
 *
 * STATE MACHINE FLOW
 * ------------------
 * 1. Character enters narrative via initializeCharacterNarrative()
 * 2. getNextNarrativeStep() evaluates current position:
 *    - Fetches outgoing paths from current segment
 *    - Filters paths by evaluating conditions via pluggable registry
 *    - Logs evaluation result for every path (accepted/rejected + reason)
 *    - Returns: linear progression (auto-advance), choices (user picks), or ending
 * 3. processUserChoice() handles user selection:
 *    - Validates chosen path belongs to current segment
 *    - Appends to narrative history (append-only audit trail)
 *    - Archives old history entries when threshold exceeded
 *    - Applies consequences via pluggable registry
 *    - Updates current segment to target
 * 4. queryNarrativeLore() answers lore questions via keyword search
 * 5. previewConsequences() dry-run mode for debugging/testing
 *
 * PATH TYPES
 * ----------
 * - linear_progression: Auto-advance, first valid wins
 * - choice_option: Presented to user, requires explicit selection
 * - conditional_branch: Evaluated like linear but requires conditions met
 *
 * CONDITION EVALUATION (Pluggable Registry)
 * ------------------------------------------
 * Conditions are JSONB objects on narrative_paths. Each key maps to a
 * registered evaluator function. Built-in evaluators:
 *
 *   'character_trait_id' + 'min_percentile':
 *     Single trait check: { character_trait_id: "#XXXXXX", min_percentile: 70 }
 *
 *   'trait_checks':
 *     Multi-trait check: { trait_checks: [{ trait_id: "#XX", min_percentile: 50 }] }
 *
 *   'flag_*':
 *     Flag equality: { flag_met_yurei: true }
 *
 * Custom evaluators can be registered at startup:
 *   registerConditionEvaluator('inventory_has', (value, ctx) => { ... })
 *
 * CONSEQUENCE APPLICATION (Pluggable Registry)
 * ----------------------------------------------
 * Consequences are JSONB objects on narrative_paths. Each key maps to a
 * registered applier function. Built-in appliers:
 *
 *   'alter_trait_id' + 'change_value':
 *     Single trait delta: { alter_trait_id: "#XXXXXX", change_value: 5 }
 *
 *   'trait_changes':
 *     Multi-trait: { trait_changes: [{ trait_id: "#XX", delta: 5 }] }
 *
 *   'set_flag' + 'value':
 *     Single flag: { set_flag: "met_yurei", value: true }
 *
 *   'flag_changes':
 *     Multi-flag: { flag_changes: [{ flag: "met_yurei", value: true }] }
 *
 * Custom appliers can be registered at startup:
 *   registerConsequenceApplier('add_inventory', (value, ctx) => { ... })
 *
 * RESILIENCE
 * ----------
 * - Deadlock retry: Transactional methods retry on Postgres 40001/40P01
 *   errors with exponential backoff (3 attempts, 100ms base delay)
 * - Circuit breaker: _getClient tracks consecutive failures. After
 *   CIRCUIT_BREAKER.THRESHOLD consecutive failures, fails fast for
 *   CIRCUIT_BREAKER.COOLDOWN_MS before retrying
 * - Timeout protection: All connections and queries timeout at 5s
 * - Safe rollback: .catch(() => {}) prevents rollback errors masking originals
 *
 * CONSUMERS
 * ---------
 * - StorytellerBridge.js (narrative beat synthesis for TSE)
 * - PhaseIntent.js (narrative-related user intents)
 * - socketHandler.js (real-time narrative progression events)
 *
 * SCHEMA DEPENDENCIES (Verified 2026-02-10)
 * ------------------------------------------
 * characters_in_narrative: character_id(7), current_narrative_segment_id(7),
 *   narrative_history(jsonb), current_narrative_state(jsonb),
 *   last_interacted_at, created_at, updated_at
 *
 * character_trait_scores: character_hex_id(7), trait_hex_color(7),
 *   percentile_score numeric(5,2)
 *   PK: (character_hex_id, trait_hex_color)
 *   CHECK: percentile_score >= 0.00 AND <= 100.00
 *
 * narrative_segments: segment_id(7), title(255), content(text),
 *   segment_type(50), associated_character_ids[], ...
 *
 * narrative_paths: path_id(7), source_segment_id(7), target_segment_id(7),
 *   path_type(50), conditions(jsonb), consequences(jsonb), is_active(bool), ...
 *
 * knowledge_items: knowledge_id, content(text), domain_id
 *
 * narrative_history_archive: character_id(7), archived_entries(jsonb),
 *   archived_at, entry_count
 *   (Created on first archive — see _archiveOldHistory)
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js (isValidHexId),
 *           narrativeAccess.js, counters.js
 * External: None
 *
 * SECURITY
 * --------
 * All queries parameterised. ILIKE patterns escaped via _escapeLikePattern.
 * Trait scores clamped 0-100. Batch upserts prevent N+1 round-trips.
 * Pagination on lore queries prevents unbounded result sets.
 * All locked data fetched in single scope to prevent deadlock ordering issues.
 *
 * EXTENDING CONDITIONS/CONSEQUENCES
 * -----------------------------------
 * To add a new condition type (e.g. inventory check):
 *   1. Call registerConditionEvaluator('inventory_has', (value, ctx) => {
 *        return { passed: ctx.state.inventory?.includes(value), reason: '...' };
 *      });
 *   2. Use in path conditions: { inventory_has: "sword_of_truth" }
 *
 * To add a new consequence type (e.g. add inventory item):
 *   1. Call registerConsequenceApplier('add_inventory', (value, ctx) => {
 *        ctx.state.inventory = ctx.state.inventory || [];
 *        ctx.state.inventory.push(value);
 *      });
 *   2. Use in path consequences: { add_inventory: "sword_of_truth" }
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from './logger.js';
import { isValidHexId } from './hexIdGenerator.js';
import {
  characterExists,
  getNarrativeSegmentById,
  getOutgoingPaths,
  narrativeSegmentExists
} from './narrativeAccess.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('NarrativeEngine');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const TIMEOUTS = Object.freeze({
  CONNECT_MS: 5000,
  QUERY_MS: 5000
});

const TRAIT_BOUNDS = Object.freeze({
  MIN: 0,
  MAX: 100
});

const LORE_DEFAULTS = Object.freeze({
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  MIN_LIMIT: 1
});

const HISTORY_LIMITS = Object.freeze({
  MAX_ENTRIES: 10000,
  ARCHIVE_THRESHOLD: 8000,
  ARCHIVE_BATCH_SIZE: 2000
});

const START_SEGMENT = Object.freeze({
  TYPE: 'narration',
  TITLE_PATTERN: '%awakening%'
});

const RETRY = Object.freeze({
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 100,
  DEADLOCK_CODES: ['40001', '40P01']
});

const CIRCUIT_BREAKER = Object.freeze({
  THRESHOLD: 5,
  COOLDOWN_MS: 10000
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Circuit Breaker State                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const _circuitState = {
  consecutiveFailures: 0,
  lastFailureTime: 0,
  isOpen: false
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pluggable Registries                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * @type {Map<string, function>}
 * Condition evaluator registry. Key = condition field name.
 * Each evaluator receives (value, context) and returns { passed: boolean, reason: string }.
 * Context: { characterState, traitScores, conditions }
 */
const _conditionEvaluators = new Map();

/**
 * @type {Map<string, function>}
 * Consequence applier registry. Key = consequence field name.
 * Each applier receives (value, context) and mutates context in place.
 * Context: { state, modifiedTraits, traitsChanged, consequences }
 */
const _consequenceAppliers = new Map();

/**
 * Registers a custom condition evaluator.
 * @param {string} key - Condition field name to match
 * @param {function} evaluator - (value, ctx) => { passed: boolean, reason: string }
 */
function registerConditionEvaluator(key, evaluator) {
  if (typeof key !== 'string' || typeof evaluator !== 'function') {
    throw new Error('registerConditionEvaluator requires a string key and function evaluator.');
  }
  _conditionEvaluators.set(key, evaluator);
  logger.info('Condition evaluator registered', { key });
}

/**
 * Registers a custom consequence applier.
 * @param {string} key - Consequence field name to match
 * @param {function} applier - (value, ctx) => void (mutates ctx)
 */
function registerConsequenceApplier(key, applier) {
  if (typeof key !== 'string' || typeof applier !== 'function') {
    throw new Error('registerConsequenceApplier requires a string key and function applier.');
  }
  _consequenceAppliers.set(key, applier);
  logger.info('Consequence applier registered', { key });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Built-in Condition Evaluators                                             */
/* ────────────────────────────────────────────────────────────────────────── */

_conditionEvaluators.set('character_trait_id', (value, ctx) => {
  const traitHex = _normalizeHexId(value);
  const minRequired = parseFloat(ctx.conditions.min_percentile ?? 0);
  if (isNaN(minRequired)) return { passed: true, reason: `Trait ${traitHex}: min_percentile not numeric — skip` };
  const actual = ctx.traitScores[traitHex] ?? 0;
  const passed = actual >= minRequired;
  return {
    passed,
    reason: `Trait ${traitHex}: ${actual} ${passed ? '>=' : '<'} required ${minRequired}${passed ? ' — pass' : ''}`
  };
});

_conditionEvaluators.set('trait_checks', (value, ctx) => {
  if (!Array.isArray(value)) return { passed: true, reason: 'trait_checks not an array — skip' };
  const reasons = [];
  let allPassed = true;
  for (const check of value) {
    if (!check || !check.trait_id) continue;
    const traitHex = _normalizeHexId(check.trait_id);
    const minRequired = parseFloat(check.min_percentile ?? 0);
    const actual = ctx.traitScores[traitHex] ?? 0;
    const passed = actual >= minRequired;
    if (!passed) allPassed = false;
    reasons.push(`Trait ${traitHex}: ${actual} ${passed ? '>=' : '<'} required ${minRequired}${passed ? ' — pass' : ''}`);
  }
  return { passed: allPassed, reason: reasons.join('; ') };
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Built-in Consequence Appliers                                             */
/* ────────────────────────────────────────────────────────────────────────── */

_consequenceAppliers.set('alter_trait_id', (value, ctx) => {
  const traitHex = _normalizeHexId(value);
  const delta = parseFloat(ctx.consequences.change_value ?? 0);
  if (isValidHexId(traitHex) && !isNaN(delta)) {
    const current = ctx.modifiedTraits[traitHex] ?? 0;
    ctx.modifiedTraits[traitHex] = _clamp(current + delta, TRAIT_BOUNDS.MIN, TRAIT_BOUNDS.MAX);
    ctx.traitsChanged = true;
  }
});

_consequenceAppliers.set('trait_changes', (value, ctx) => {
  if (!Array.isArray(value)) return;
  for (const change of value) {
    if (!change || !change.trait_id) continue;
    const traitHex = _normalizeHexId(change.trait_id);
    const delta = parseFloat(change.delta ?? 0);
    if (isValidHexId(traitHex) && !isNaN(delta)) {
      const current = ctx.modifiedTraits[traitHex] ?? 0;
      ctx.modifiedTraits[traitHex] = _clamp(current + delta, TRAIT_BOUNDS.MIN, TRAIT_BOUNDS.MAX);
      ctx.traitsChanged = true;
    }
  }
});

_consequenceAppliers.set('set_flag', (value, ctx) => {
  if (typeof value === 'string' && value.trim() !== '') {
    ctx.state[`flag_${value.replace(/^flag_/, '')}`] = ctx.consequences.value;
  }
});

_consequenceAppliers.set('flag_changes', (value, ctx) => {
  if (!Array.isArray(value)) return;
  for (const fc of value) {
    if (!fc || !fc.flag) continue;
    if (typeof fc.flag === 'string' && fc.flag.trim() !== '') {
      ctx.state[`flag_${fc.flag.replace(/^flag_/, '')}`] = fc.value;
    }
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Internal Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Normalises a hex ID to uppercase #XXXXXX format.
 * @param {string} hex - Raw hex string
 * @returns {string} Normalised hex ID
 */
function _normalizeHexId(hex) {
  if (typeof hex !== 'string') return hex;
  const v = hex.trim();
  return v.startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
}

/**
 * Validates a hex ID and throws if invalid.
 * @param {string} id - Hex ID to validate
 * @param {string} [fieldName='hex id'] - Field name for error message
 * @throws {Error} If hex ID is invalid
 */
function _assertHexId(id, fieldName = 'hex id') {
  if (!isValidHexId(id)) {
    throw new Error(`Invalid ${fieldName} format. Expected #XXXXXX.`);
  }
}

/**
 * Escapes special characters in LIKE/ILIKE patterns.
 * @param {string} pattern - Raw search string
 * @returns {string} Escaped pattern safe for LIKE/ILIKE
 */
function _escapeLikePattern(pattern) {
  if (typeof pattern !== 'string') return '';
  return pattern.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Clamps a numeric value between min and max.
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum bound
 * @param {number} max - Maximum bound
 * @returns {number} Clamped value
 */
function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamps pagination limit to safe bounds.
 * @param {number} [limit] - Requested limit
 * @returns {number} Clamped limit
 */
function _clampLoreLimit(limit) {
  if (typeof limit !== 'number') return LORE_DEFAULTS.DEFAULT_LIMIT;
  return _clamp(limit, LORE_DEFAULTS.MIN_LIMIT, LORE_DEFAULTS.MAX_LIMIT);
}

/**
 * Gets a pool client with timeout protection and circuit breaker.
 * After CIRCUIT_BREAKER.THRESHOLD consecutive failures, fails fast
 * for COOLDOWN_MS before retrying.
 *
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object>} Database client
 * @throws {Error} On timeout, connection failure, or circuit open
 */
async function _getClient(correlationId) {
  if (_circuitState.isOpen) {
    const elapsed = Date.now() - _circuitState.lastFailureTime;
    if (elapsed < CIRCUIT_BREAKER.COOLDOWN_MS) {
      Counters.increment('narrative_engine', 'circuit_breaker_rejected');
      throw new Error(`Circuit breaker open. DB connections failing. Retry in ${CIRCUIT_BREAKER.COOLDOWN_MS - elapsed}ms.`);
    }
    _circuitState.isOpen = false;
    _circuitState.consecutiveFailures = 0;
    logger.info('Circuit breaker reset, attempting reconnection', { correlationId });
  }

  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), TIMEOUTS.CONNECT_MS)
      )
    ]);
    _circuitState.consecutiveFailures = 0;
    return client;
  } catch (err) {
    _circuitState.consecutiveFailures++;
    _circuitState.lastFailureTime = Date.now();
    if (_circuitState.consecutiveFailures >= CIRCUIT_BREAKER.THRESHOLD) {
      _circuitState.isOpen = true;
      logger.error('Circuit breaker OPENED — DB connections failing', {
        consecutiveFailures: _circuitState.consecutiveFailures, correlationId
      });
      Counters.increment('narrative_engine', 'circuit_breaker_opened');
    }
    logger.error('Failed to get DB client', { error: err.message, correlationId });
    Counters.increment('narrative_engine', 'connection_timeout');
    throw new Error('Failed to connect to database.');
  }
}

/**
 * Runs a query with timeout protection using the shared pool.
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object>} Query result
 * @throws {Error} On timeout or query failure
 */
async function _queryWithTimeout(sql, params, correlationId) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Query timeout')), TIMEOUTS.QUERY_MS)
    )
  ]);
}

/**
 * Retries a transactional operation on deadlock/serialization errors.
 * Uses exponential backoff with jitter.
 *
 * @param {function} operation - Async function(client) to execute within transaction
 * @param {string} operationName - Name for logging
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<*>} Result of the operation
 * @throws {Error} After all retry attempts exhausted
 */
async function _withDeadlockRetry(operation, operationName, correlationId) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt++) {
    const client = await _getClient(correlationId);
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      if (attempt > 1) {
        logger.info('Deadlock retry succeeded', { operationName, attempt, correlationId });
      }
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      lastError = err;

      if (RETRY.DEADLOCK_CODES.includes(err.code) && attempt < RETRY.MAX_ATTEMPTS) {
        const delay = RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 50);
        logger.warn('Deadlock detected, retrying', {
          operationName, attempt, maxAttempts: RETRY.MAX_ATTEMPTS,
          delayMs: delay, errorCode: err.code, correlationId
        });
        Counters.increment('narrative_engine', 'deadlock_retry');
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  throw lastError;
}

/**
 * Fetches all data needed for progression in a single locked scope.
 * Prevents deadlock by acquiring all locks upfront in consistent order.
 *
 * @param {string} characterId - Normalised hex character ID
 * @param {object} client - Database client within transaction
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{charNarrative: object|null, traitScores: Object.<string, number>}>}
 */
async function _fetchLockedCharacterData(characterId, client, correlationId) {
  const charResult = await client.query(
    `SELECT character_id, current_narrative_segment_id, narrative_history,
            current_narrative_state, last_interacted_at
     FROM characters_in_narrative WHERE character_id = $1 FOR UPDATE`,
    [characterId]
  );

  const traitResult = await client.query(
    'SELECT trait_hex_color, percentile_score FROM character_trait_scores WHERE character_hex_id = $1',
    [characterId]
  );
  const traitScores = {};
  for (const row of traitResult.rows) {
    traitScores[row.trait_hex_color] = parseFloat(row.percentile_score);
  }

  return {
    charNarrative: charResult.rows[0] ?? null,
    traitScores
  };
}

/**
 * Batch upserts trait scores in a single query. Eliminates N+1 round-trips.
 * @param {string} characterId - Normalised hex character ID
 * @param {Object.<string, number>} traitScores - Map of trait hex → new score
 * @param {object} client - Database client within transaction
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<void>}
 */
async function _batchUpsertTraitScores(characterId, traitScores, client, correlationId) {
  const entries = Object.entries(traitScores);
  if (entries.length === 0) return;

  const values = [];
  const placeholders = [];
  let paramIndex = 1;

  for (const [traitHex, score] of entries) {
    if (!isValidHexId(traitHex)) {
      logger.warn('Skipping invalid trait hex', { traitHex, correlationId });
      continue;
    }
    const clampedScore = _clamp(score, TRAIT_BOUNDS.MIN, TRAIT_BOUNDS.MAX);
    placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2})`);
    values.push(characterId, _normalizeHexId(traitHex), clampedScore);
    paramIndex += 3;
  }

  if (placeholders.length === 0) return;

  await client.query(
    `INSERT INTO character_trait_scores (character_hex_id, trait_hex_color, percentile_score)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (character_hex_id, trait_hex_color)
     DO UPDATE SET percentile_score = EXCLUDED.percentile_score`,
    values
  );
}

/**
 * Archives oldest history entries when narrative history exceeds threshold.
 * @param {string} characterId - Normalised hex character ID
 * @param {object[]} narrativeHistory - Full history array
 * @param {object} client - Database client within transaction
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object[]>} Trimmed history array
 */
async function _archiveOldHistory(characterId, narrativeHistory, client, correlationId) {
  if (narrativeHistory.length < HISTORY_LIMITS.ARCHIVE_THRESHOLD) {
    return narrativeHistory;
  }

  const entriesToArchive = narrativeHistory.slice(0, HISTORY_LIMITS.ARCHIVE_BATCH_SIZE);
  const remainingHistory = narrativeHistory.slice(HISTORY_LIMITS.ARCHIVE_BATCH_SIZE);

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS narrative_history_archive (
         archive_id SERIAL PRIMARY KEY,
         character_id VARCHAR(7) NOT NULL,
         archived_entries JSONB NOT NULL,
         entry_count INTEGER NOT NULL,
         archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    );

    await client.query(
      `INSERT INTO narrative_history_archive (character_id, archived_entries, entry_count)
       VALUES ($1, $2::jsonb, $3)`,
      [characterId, JSON.stringify(entriesToArchive), entriesToArchive.length]
    );

    Counters.increment('narrative_engine', 'history_archived');
    logger.info('Narrative history archived', {
      characterId, archivedCount: entriesToArchive.length,
      remainingCount: remainingHistory.length, correlationId
    });
  } catch (archiveErr) {
    logger.warn('Failed to archive history, continuing with full history', {
      error: archiveErr.message, characterId, correlationId
    });
    return narrativeHistory;
  }

  return remainingHistory;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Condition Evaluation (Pluggable Registry)                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Evaluates conditions for a narrative path using the pluggable registry.
 * Each condition key is looked up in _conditionEvaluators. Flag conditions
 * (key starts with 'flag_') use built-in flag equality check.
 * Unregistered non-flag keys are logged and skipped.
 *
 * @param {object} conditions - JSONB conditions from narrative_paths
 * @param {object} characterState - current_narrative_state of the character
 * @param {Object.<string, number>} characterTraitScores - trait hex → percentile_score
 * @returns {{ passed: boolean, reasons: string[] }} Evaluation result with diagnostics
 */
function evaluatePathConditions(conditions, characterState, characterTraitScores) {
  const result = { passed: true, reasons: [] };

  if (!conditions || typeof conditions !== 'object' || Object.keys(conditions).length === 0) {
    result.reasons.push('No conditions — auto-pass');
    return result;
  }

  const ctx = { characterState, traitScores: characterTraitScores, conditions };

  for (const key in conditions) {
    if (key === 'min_percentile' || key === 'value') continue;

    if (_conditionEvaluators.has(key)) {
      const evalResult = _conditionEvaluators.get(key)(conditions[key], ctx);
      if (evalResult && !evalResult.passed) {
        result.passed = false;
      }
      if (evalResult && evalResult.reason) {
        result.reasons.push(evalResult.reason);
      }
      continue;
    }

    if (key.startsWith('flag_')) {
      const requiredValue = conditions[key];
      const currentValue = characterState[key];
      const flagPassed = currentValue === requiredValue;
      if (!flagPassed) result.passed = false;
      result.reasons.push(
        `Flag ${key}: current=${JSON.stringify(currentValue)} ${flagPassed ? '===' : '!=='} required=${JSON.stringify(requiredValue)}${flagPassed ? ' — pass' : ''}`
      );
      continue;
    }

    result.reasons.push(`Unknown condition key '${key}' — skipped`);
  }

  return result;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Core Engine: Initialization                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Initializes a character's narrative progression record if one does not exist.
 *
 * @param {string} characterId - Hex character ID
 * @param {string} [initialSegmentId=null] - Starting segment ID (auto-detects if null)
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{character_id: string, current_narrative_segment_id: string, narrative_history: object[], current_narrative_state: object, last_interacted_at: string|null, created_at: string, updated_at: string}>}
 * @throws {Error} On validation failure, missing character, or database error
 */
async function initializeCharacterNarrative(characterId, initialSegmentId = null, correlationId) {
  _assertHexId(characterId, 'character_id');
  const charId = _normalizeHexId(characterId);

  if (!(await characterExists(charId, correlationId))) {
    throw new Error(`Character ${charId} not found.`);
  }

  return _withDeadlockRetry(async (client) => {
    const existing = await client.query(
      `SELECT character_id, current_narrative_segment_id, narrative_history,
              current_narrative_state, last_interacted_at, created_at, updated_at
       FROM characters_in_narrative WHERE character_id = $1 FOR UPDATE`,
      [charId]
    );

    if (existing.rows[0]) {
      Counters.increment('narrative_engine', 'init_already_exists');
      logger.debug('Character already initialized', { characterId: charId, correlationId });
      return existing.rows[0];
    }

    let effectiveSegmentId = initialSegmentId;
    if (effectiveSegmentId) {
      _assertHexId(effectiveSegmentId, 'initial_segment_id');
      effectiveSegmentId = _normalizeHexId(effectiveSegmentId);
    } else {
      const startResult = await client.query(
        `SELECT segment_id FROM narrative_segments
         WHERE segment_type = $1 AND title ILIKE $2
         ORDER BY created_at ASC LIMIT 1`,
        [START_SEGMENT.TYPE, START_SEGMENT.TITLE_PATTERN]
      );
      if (startResult.rows.length > 0) {
        effectiveSegmentId = startResult.rows[0].segment_id;
      } else {
        throw new Error('No initial segment provided and no default start segment found.');
      }
    }

    if (!(await narrativeSegmentExists(effectiveSegmentId, correlationId))) {
      throw new Error(`Initial narrative segment ${effectiveSegmentId} not found.`);
    }

    const insertResult = await client.query(
      `INSERT INTO characters_in_narrative
         (character_id, current_narrative_segment_id, narrative_history, current_narrative_state)
       VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb)
       RETURNING character_id, current_narrative_segment_id, narrative_history,
                 current_narrative_state, last_interacted_at, created_at, updated_at`,
      [charId, effectiveSegmentId]
    );

    Counters.increment('narrative_engine', 'init_created');
    logger.info('Character narrative initialized', {
      characterId: charId, segmentId: effectiveSegmentId, correlationId
    });
    return insertResult.rows[0];

  }, 'initializeCharacterNarrative', correlationId);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Core Engine: State Retrieval                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Retrieves a character's current narrative state.
 *
 * @param {string} characterId - Hex character ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{character_id: string, current_narrative_segment_id: string, narrative_history: object[], current_narrative_state: object, last_interacted_at: string|null, created_at: string, updated_at: string}|null>}
 */
async function getCharacterCurrentNarrativeState(characterId, correlationId) {
  _assertHexId(characterId, 'character_id');
  const charId = _normalizeHexId(characterId);
  try {
    const result = await _queryWithTimeout(
      `SELECT character_id, current_narrative_segment_id, narrative_history,
              current_narrative_state, last_interacted_at, created_at, updated_at
       FROM characters_in_narrative WHERE character_id = $1`,
      [charId], correlationId
    );
    Counters.increment('narrative_engine', result.rows[0] ? 'state_found' : 'state_not_found');
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error('Failed to get character narrative state', {
      error: err.message, characterId: charId, correlationId
    });
    Counters.increment('narrative_engine', 'state_query_failure');
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Core Engine: Progression                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Determines the next narrative segment(s) a character can access.
 *
 * @param {string} characterId - Hex character ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{segment: object|null, choices: Array<{path_id: string, choice_text: string, target_segment_id: string, order_in_choices: number|null}>, pathLog: Array<{path_id: string, path_type: string, target: string, passed: boolean, reasons: string[]}>, message?: string}>}
 * @throws {Error} On validation failure or database error
 */
async function getNextNarrativeStep(characterId, correlationId) {
  _assertHexId(characterId, 'character_id');
  const charId = _normalizeHexId(characterId);

  return _withDeadlockRetry(async (client) => {
    const { charNarrative, traitScores } = await _fetchLockedCharacterData(charId, client, correlationId);
    let effectiveNarrative = charNarrative;

    if (!effectiveNarrative) {
      await client.query('COMMIT');
      effectiveNarrative = await initializeCharacterNarrative(charId, null, correlationId);
      await client.query('BEGIN');
      const reFetch = await _fetchLockedCharacterData(charId, client, correlationId);
      effectiveNarrative = reFetch.charNarrative;
      if (!effectiveNarrative) {
        throw new Error(`Failed to retrieve or initialize narrative for ${charId}.`);
      }
    }

    const currentSegmentId = effectiveNarrative.current_narrative_segment_id;
    const currentState = effectiveNarrative.current_narrative_state || {};

    const outgoingPaths = await getOutgoingPaths(currentSegmentId, correlationId);

    const pathLog = [];
    const validPaths = [];
    const availableChoices = [];

    for (const path of outgoingPaths) {
      const evalResult = evaluatePathConditions(path.conditions, currentState, traitScores);
      pathLog.push({
        path_id: path.path_id,
        path_type: path.path_type,
        target: path.target_segment_id,
        passed: evalResult.passed,
        reasons: evalResult.reasons
      });
      if (evalResult.passed) {
        validPaths.push(path);
      }
    }

    logger.debug('Path evaluation complete', {
      characterId: charId, segmentId: currentSegmentId,
      totalPaths: outgoingPaths.length, validPaths: validPaths.length,
      pathLog, correlationId
    });

    for (const path of validPaths) {
      if (path.path_type === 'linear_progression') {
        const nextSegment = await getNarrativeSegmentById(path.target_segment_id, correlationId);
        Counters.increment('narrative_engine', 'progression_linear');
        return { segment: nextSegment, choices: [], pathLog };
      } else if (path.path_type === 'choice_option') {
        availableChoices.push({
          path_id: path.path_id,
          choice_text: path.choice_text,
          target_segment_id: path.target_segment_id,
          order_in_choices: path.order_in_choices
        });
      } else if (path.path_type === 'conditional_branch') {
        if (availableChoices.length === 0) {
          const branchSegment = await getNarrativeSegmentById(path.target_segment_id, correlationId);
          if (branchSegment) {
            Counters.increment('narrative_engine', 'progression_conditional');
            return { segment: branchSegment, choices: [], pathLog };
          }
        }
      }
    }

    const currentSegment = await getNarrativeSegmentById(currentSegmentId, correlationId);

    if (availableChoices.length > 0) {
      availableChoices.sort((a, b) => (a.order_in_choices ?? Infinity) - (b.order_in_choices ?? Infinity));
      Counters.increment('narrative_engine', 'progression_choice_point');
      return { segment: currentSegment, choices: availableChoices, pathLog };
    }

    Counters.increment('narrative_engine', 'progression_end');
    return { segment: currentSegment, choices: [], pathLog, message: 'End of narrative path.' };

  }, 'getNextNarrativeStep', correlationId);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Core Engine: Choice Processing                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Processes a user's choice, updates narrative state, and applies consequences.
 *
 * @param {string} characterId - Hex character ID
 * @param {string} choicePathId - Hex path ID of the chosen path
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{character_id: string, current_narrative_segment_id: string, narrative_history: object[], current_narrative_state: object, last_interacted_at: string, created_at: string, updated_at: string}>}
 * @throws {Error} On validation failure, invalid path, or database error
 */
async function processUserChoice(characterId, choicePathId, correlationId) {
  _assertHexId(characterId, 'character_id');
  _assertHexId(choicePathId, 'choice_path_id');
  const charId = _normalizeHexId(characterId);
  const pathId = _normalizeHexId(choicePathId);

  return _withDeadlockRetry(async (client) => {
    const { charNarrative, traitScores } = await _fetchLockedCharacterData(charId, client, correlationId);
    if (!charNarrative) {
      throw new Error(`Narrative record not found for character ${charId}.`);
    }

    const pathResult = await client.query(
      `SELECT path_id, source_segment_id, target_segment_id, path_type,
              choice_text, conditions, consequences, is_active
       FROM narrative_paths WHERE path_id = $1 AND is_active = TRUE`,
      [pathId]
    );
    const chosenPath = pathResult.rows[0];

    if (!chosenPath) {
      throw new Error(`Path ${pathId} not found or inactive.`);
    }
    if (chosenPath.source_segment_id !== charNarrative.current_narrative_segment_id) {
      throw new Error(`Path ${pathId} does not originate from current segment ${charNarrative.current_narrative_segment_id}.`);
    }

    let narrativeHistory = Array.isArray(charNarrative.narrative_history)
      ? [...charNarrative.narrative_history] : [];

    narrativeHistory = await _archiveOldHistory(charId, narrativeHistory, client, correlationId);

    narrativeHistory.push({
      segment_id: chosenPath.source_segment_id,
      choice_made_path_id: pathId,
      timestamp: new Date().toISOString()
    });

    let updatedState = charNarrative.current_narrative_state || {};

    if (chosenPath.consequences && typeof chosenPath.consequences === 'object'
        && Object.keys(chosenPath.consequences).length > 0) {
      updatedState = await _applyConsequences(
        charId, chosenPath.consequences, updatedState, traitScores, client, correlationId
      );
    }

    const updateResult = await client.query(
      `UPDATE characters_in_narrative
       SET current_narrative_segment_id = $1,
           narrative_history = $2::jsonb,
           current_narrative_state = $3::jsonb,
           last_interacted_at = CURRENT_TIMESTAMP
       WHERE character_id = $4
       RETURNING character_id, current_narrative_segment_id, narrative_history,
                 current_narrative_state, last_interacted_at, created_at, updated_at`,
      [
        chosenPath.target_segment_id,
        JSON.stringify(narrativeHistory),
        JSON.stringify(updatedState),
        charId
      ]
    );

    Counters.increment('narrative_engine', 'choice_processed');
    logger.info('User choice processed', {
      characterId: charId, pathId, from: chosenPath.source_segment_id,
      to: chosenPath.target_segment_id, correlationId
    });
    return updateResult.rows[0];

  }, 'processUserChoice', correlationId);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Consequence Application (Pluggable Registry)                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Applies consequences using the pluggable registry.
 *
 * @param {string} characterId - Normalised hex character ID
 * @param {object} consequences - JSONB consequences from narrative_paths
 * @param {object} currentState - Current narrative_state to mutate
 * @param {Object.<string, number>} existingTraitScores - Pre-fetched trait scores
 * @param {object} client - Database client within active transaction
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object>} Updated narrative state
 */
async function _applyConsequences(characterId, consequences, currentState, existingTraitScores, client, correlationId) {
  const ctx = {
    state: { ...currentState },
    modifiedTraits: { ...existingTraitScores },
    traitsChanged: false,
    consequences
  };

  for (const key in consequences) {
    if (key === 'change_value' || key === 'value') continue;

    if (_consequenceAppliers.has(key)) {
      try {
        _consequenceAppliers.get(key)(consequences[key], ctx);
      } catch (applierErr) {
        logger.warn('Consequence applier failed', { key, error: applierErr.message, correlationId });
      }
      continue;
    }

    logger.debug('Unknown consequence key, skipped', { key, correlationId });
  }

  if (ctx.traitsChanged) {
    await _batchUpsertTraitScores(characterId, ctx.modifiedTraits, client, correlationId);
    Counters.increment('narrative_engine', 'traits_modified');
    logger.debug('Trait scores modified', { characterId, correlationId });
  }

  Counters.increment('narrative_engine', 'consequences_applied');
  logger.debug('Consequences applied', { characterId, correlationId });
  return ctx.state;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Consequence Preview (Dry Run)                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Previews what consequences WOULD be applied without persisting changes.
 *
 * @param {string} characterId - Hex character ID
 * @param {string} pathId - Hex path ID to preview
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{traitChanges: Array<{trait_id: string, before: number, after: number, delta: number}>, flagChanges: Array<{flag: string, before: *, after: *}>, valid: boolean, reasons: string[]}>}
 */
async function previewConsequences(characterId, pathId, correlationId) {
  _assertHexId(characterId, 'character_id');
  _assertHexId(pathId, 'path_id');
  const charId = _normalizeHexId(characterId);
  const normalizedPathId = _normalizeHexId(pathId);

  const client = await _getClient(correlationId);
  try {
    await client.query('BEGIN');

    const { charNarrative, traitScores } = await _fetchLockedCharacterData(charId, client, correlationId);
    if (!charNarrative) {
      await client.query('ROLLBACK').catch(() => {});
      return { traitChanges: [], flagChanges: [], valid: false, reasons: ['Character narrative not found'] };
    }

    const pathResult = await client.query(
      `SELECT path_id, source_segment_id, conditions, consequences, is_active
       FROM narrative_paths WHERE path_id = $1`,
      [normalizedPathId]
    );
    const path = pathResult.rows[0];

    if (!path) {
      await client.query('ROLLBACK').catch(() => {});
      return { traitChanges: [], flagChanges: [], valid: false, reasons: ['Path not found'] };
    }

    const conditionEval = evaluatePathConditions(
      path.conditions, charNarrative.current_narrative_state || {}, traitScores
    );

    const consequences = path.consequences || {};
    const currentState = charNarrative.current_narrative_state || {};

    const previewCtx = {
      state: { ...currentState },
      modifiedTraits: { ...traitScores },
      traitsChanged: false,
      consequences
    };

    for (const key in consequences) {
      if (key === 'change_value' || key === 'value') continue;
      if (_consequenceAppliers.has(key)) {
        try {
          _consequenceAppliers.get(key)(consequences[key], previewCtx);
        } catch (e) {
          // skip in preview
        }
      }
    }

    const traitChanges = [];
    for (const [traitHex, newScore] of Object.entries(previewCtx.modifiedTraits)) {
      const before = traitScores[traitHex] ?? 0;
      if (Math.abs(newScore - before) > 0.001) {
        traitChanges.push({
          trait_id: traitHex,
          before: parseFloat(before.toFixed(2)),
          after: parseFloat(newScore.toFixed(2)),
          delta: parseFloat((newScore - before).toFixed(2))
        });
      }
    }

    const flagChanges = [];
    for (const [flagKey, newValue] of Object.entries(previewCtx.state)) {
      if (flagKey.startsWith('flag_')) {
        const before = currentState[flagKey];
        if (before !== newValue) {
          flagChanges.push({ flag: flagKey, before, after: newValue });
        }
      }
    }

    await client.query('ROLLBACK').catch(() => {});

    Counters.increment('narrative_engine', 'consequence_preview');
    logger.debug('Consequence preview generated', { characterId: charId, pathId: normalizedPathId, correlationId });

    return {
      traitChanges,
      flagChanges,
      valid: conditionEval.passed && path.is_active,
      reasons: conditionEval.reasons
    };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to preview consequences', {
      error: err.message, characterId: charId, pathId: normalizedPathId, correlationId
    });
    return { traitChanges: [], flagChanges: [], valid: false, reasons: [err.message] };
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Lore Query                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Queries narrative segments and knowledge items for lore matching a search term.
 *
 * @param {string} userQuery - Search term
 * @param {object} [opts={}] - Query options
 * @param {number} [opts.limit=20] - Max results (1-100)
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<Array<{id: string, type: string, title: string|null, content: string, segment_type: string|null, domain_id: string|null}>>}
 */
async function queryNarrativeLore(userQuery, opts = {}, correlationId) {
  if (typeof userQuery !== 'string' || userQuery.trim() === '') {
    return [];
  }

  const limit = _clampLoreLimit(opts.limit);
  const escapedQuery = _escapeLikePattern(userQuery.trim().toLowerCase());
  const searchPattern = `%${escapedQuery}%`;

  try {
    const segmentResult = await _queryWithTimeout(
      `SELECT segment_id AS id, 'segment' AS type, title, content, segment_type, NULL AS domain_id
       FROM narrative_segments
       WHERE title ILIKE $1 OR keywords ILIKE $1 OR content ILIKE $1
       LIMIT $2`,
      [searchPattern, limit], correlationId
    );

    const knowledgeResult = await _queryWithTimeout(
      `SELECT knowledge_id AS id, 'knowledge' AS type, NULL AS title, content, NULL AS segment_type, domain_id
       FROM knowledge_items
       WHERE content ILIKE $1
       LIMIT $2`,
      [searchPattern, limit], correlationId
    );

    const combined = [...segmentResult.rows, ...knowledgeResult.rows];
    const seen = new Set();
    const deduplicated = combined.filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    Counters.increment('narrative_engine', 'lore_queried');
    logger.debug('Lore query executed', {
      query: userQuery.substring(0, 100), resultCount: deduplicated.length, correlationId
    });
    return deduplicated.slice(0, limit);

  } catch (err) {
    logger.error('Failed to query narrative lore', {
      error: err.message, query: userQuery.substring(0, 100), correlationId
    });
    Counters.increment('narrative_engine', 'lore_query_failure');
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export {
  initializeCharacterNarrative,
  getCharacterCurrentNarrativeState,
  getNextNarrativeStep,
  processUserChoice,
  evaluatePathConditions,
  queryNarrativeLore,
  previewConsequences,
  registerConditionEvaluator,
  registerConsequenceApplier
};

export default {
  initializeCharacterNarrative,
  getCharacterCurrentNarrativeState,
  getNextNarrativeStep,
  processUserChoice,
  evaluatePathConditions,
  queryNarrativeLore,
  previewConsequences,
  registerConditionEvaluator,
  registerConsequenceApplier
};
