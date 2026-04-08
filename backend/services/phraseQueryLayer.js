/**
 * ============================================================================
 * phraseQueryLayer.js — LTLM Phrase Database Query Layer (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Fetches voice phrases from the conversational_phrases table for the
 * LTLM voice system. This is the lowest layer in the voice pipeline:
 *
 *   phraseQueryLayer → phraseChainer → StorytellerBridge → PhaseVoice
 *
 * Phrases are the building blocks of Claude the Tanuki's voice. Each
 * phrase has a role (opener, connector, hedge, closer), an outcome
 * intent (clarity, validation, reassurance), a strategy (info, question,
 * affirmation), and tone/formality modifiers.
 *
 * QUERY CONSTRUCTION
 * ------------------
 * Queries are built dynamically with parameterised placeholders. All
 * user-derived values go through $N parameters — no string interpolation.
 * The hexList filter (for safe connector enforcement) uses PostgreSQL
 * ANY($N) array comparison.
 *
 * CONSUMERS
 * ---------
 * - phraseChainer.js: fetches openers, connectors, hedges, closers
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js, Counters
 * External: None
 *
 * SCHEMA
 * ------
 * Table: conversational_phrases
 * Columns: phrase_hex_id, text, role, outcome_intent, strategy,
 *          tone, formality, language, tags, created_by, is_canonical,
 *          created_at
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('phraseQueryLayer');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const QUERY = Object.freeze({
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 50,
  MIN_LIMIT: 1,
  TIMEOUT_MS: 5000,
  VALID_ROLES: Object.freeze(['opener', 'connector', 'closer', 'hedge']),
  VALID_FORMALITIES: Object.freeze(['casual', 'formal']),
  BASE_COLUMNS: 'phrase_hex_id, text, role, outcome_intent, strategy, ' +
    'tone, formality, language, tags, created_by, is_canonical, created_at, ' +
    'pad_pleasure, pad_arousal, pad_dominance'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pool Connection With Timeout                                              */
/* ────────────────────────────────────────────────────────────────────────── */

async function _getClient(correlationId) {
  try {
    return await pool.connect();
  } catch (err) {
    logger.error('Pool connection failed', { error: err.message, correlationId });
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Query With Timeout                                               */
/* ────────────────────────────────────────────────────────────────────────── */

async function _queryWithTimeout(client, query, params, correlationId) {
  let timer;
  const queryPromise = client.query(query, params);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Query execution timeout')), QUERY.TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([queryPromise, timeoutPromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: Get Phrases                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Fetches phrases from the conversational_phrases table.
 *
 * @param {string} outcomeIntent - e.g. 'clarity', 'validation', 'reassurance'
 * @param {string} strategy - e.g. 'info', 'question', 'affirmation'
 * @param {object} [options] - Query options
 * @param {string} [options.role] - 'opener', 'connector', 'closer', 'hedge'
 * @param {string} [options.tone] - 'neutral', 'playful', 'factual', 'warm'
 * @param {string} [options.formality] - 'casual', 'formal'
 * @param {number} [options.limit=10] - Max results (1-50)
 * @param {boolean} [options.randomOrder=false] - Randomise results
 * @param {string[]} [options.hexList] - Filter to only these phrase hex IDs
 * @param {string} [options.correlationId] - Request correlation ID
 * @returns {Promise<{found, phrases, count, outcomeIntent, strategy, filters}>}
 */
async function getPhrases(outcomeIntent, strategy, options = {}) {
  const {
    role = null,
    tone = null,
    formality = null,
    limit = QUERY.DEFAULT_LIMIT,
    randomOrder = false,
    hexList = null,
    correlationId = null
  } = options;

  if (!outcomeIntent || typeof outcomeIntent !== 'string') {
    logger.warn('Invalid outcomeIntent', { outcomeIntent, correlationId });
    return { found: false, phrases: [], count: 0, outcomeIntent, strategy, filters: {} };
  }

  if (!strategy || typeof strategy !== 'string') {
    logger.warn('Invalid strategy', { strategy, correlationId });
    return { found: false, phrases: [], count: 0, outcomeIntent, strategy, filters: {} };
  }

  if (role && !QUERY.VALID_ROLES.includes(role)) {
    logger.warn('Invalid role', { role, correlationId });
    return { found: false, phrases: [], count: 0, outcomeIntent, strategy, filters: { role } };
  }

  if (formality && !QUERY.VALID_FORMALITIES.includes(formality)) {
    logger.warn('Invalid formality', { formality, correlationId });
    return { found: false, phrases: [], count: 0, outcomeIntent, strategy, filters: { formality } };
  }

  const clampedLimit = Math.max(QUERY.MIN_LIMIT, Math.min(QUERY.MAX_LIMIT, limit));

  const validHexList = hexList && Array.isArray(hexList)
    ? hexList.filter(h => isValidHexId(h))
    : null;

  if (hexList && Array.isArray(hexList) && validHexList.length < hexList.length) {
    logger.warn('Invalid hex IDs in hexList filtered out', {
      invalidCount: hexList.length - validHexList.length,
      correlationId
    });
  }

  const client = await _getClient(correlationId);
  try {
    let query = 'SELECT ' + QUERY.BASE_COLUMNS + ' ' +
      'FROM conversational_phrases ' +
      'WHERE outcome_intent = $1 AND strategy = $2 AND is_canonical = true';

    const params = [outcomeIntent, strategy];
    let i = 3;

    if (role) {
      query += ' AND role = $' + i;
      params.push(role);
      i++;
    }

    if (tone) {
      query += ' AND tone = $' + i;
      params.push(tone);
      i++;
    }

    if (formality) {
      query += ' AND formality = $' + i;
      params.push(formality);
      i++;
    }

    if (validHexList && validHexList.length > 0) {
      query += ' AND phrase_hex_id = ANY($' + i + ')';
      params.push(validHexList);
      i++;
    }

    if (randomOrder) {
      const timeSalt = String(Math.floor(Date.now() / 60000));
      query += ' ORDER BY md5(phrase_hex_id || $' + i + ')';
      params.push(timeSalt);
      i++;
    } else {
      query += ' ORDER BY created_at ASC';
    }
    query += ' LIMIT $' + i;
    params.push(clampedLimit);

    const result = await _queryWithTimeout(client, query, params, correlationId);

    Counters.increment('phrase_query', result.rows.length > 0 ? 'found' : 'not_found');
    logger.debug('Phrases queried', {
      outcomeIntent,
      strategy,
      role,
      resultCount: result.rows.length,
      correlationId
    });

    return {
      found: result.rows.length > 0,
      phrases: result.rows,
      count: result.rows.length,
      outcomeIntent,
      strategy,
      filters: {
        role,
        tone,
        formality,
        hexList: validHexList ? validHexList.length : null
      }
    };

  } catch (error) {
    Counters.increment('phrase_query', 'failure');
    logger.error('Phrase query failed', {
      outcomeIntent,
      strategy,
      role,
      error: error.message,
      correlationId
    });
    return { found: false, phrases: [], count: 0, outcomeIntent, strategy, filters: {} };
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: Get Phrase By ID                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Fetches a single phrase by its hex ID.
 *
 * @param {string} hexId - Phrase hex ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object|null>} Phrase row or null
 */
async function getPhraseById(hexId, correlationId) {
  if (!hexId || !isValidHexId(hexId)) {
    logger.warn('Invalid phrase hex ID', { hexId, correlationId });
    return null;
  }

  const client = await _getClient(correlationId);
  try {
    const result = await _queryWithTimeout(client,
      'SELECT ' + QUERY.BASE_COLUMNS + ' FROM conversational_phrases WHERE phrase_hex_id = $1',
      [hexId], correlationId
    );

    Counters.increment('phrase_query_by_id', result.rows.length > 0 ? 'found' : 'not_found');
    return result.rows[0] || null;

  } catch (error) {
    Counters.increment('phrase_query_by_id', 'failure');
    logger.error('Phrase by ID query failed', { hexId, error: error.message, correlationId });
    return null;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: Get Filter Options (Admin/Debug)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Gets available filter options for debugging and admin tools.
 *
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{outcome_intents, strategies, roles, tones, formalities}>}
 */
async function getFilterOptions(correlationId) {
  const client = await _getClient(correlationId);
  try {
    const result = await _queryWithTimeout(client,
      'SELECT ' +
      '  ARRAY_AGG(DISTINCT outcome_intent) as outcome_intents, ' +
      '  ARRAY_AGG(DISTINCT strategy) as strategies, ' +
      '  ARRAY_AGG(DISTINCT role) as roles, ' +
      '  ARRAY_AGG(DISTINCT tone) as tones, ' +
      '  ARRAY_AGG(DISTINCT formality) as formalities ' +
      'FROM conversational_phrases ' +
      'WHERE is_canonical = true',
      [], correlationId
    );

    const emptyShape = { outcome_intents: [], strategies: [], roles: [], tones: [], formalities: [] };
    return result.rows[0] || emptyShape;

  } catch (error) {
    logger.error('Filter options query failed', { error: error.message, correlationId });
    return { outcome_intents: [], strategies: [], roles: [], tones: [], formalities: [] };
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export { getPhrases, getPhraseById, getFilterOptions };
