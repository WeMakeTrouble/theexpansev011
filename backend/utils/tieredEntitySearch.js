/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TIERED ENTITY SEARCH — Cascading Search Orchestration & Disambiguation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * This file orchestrates cascading entity search through three tiers:
 *   Tier 1: Exact Match   — Case-insensitive normalized name (~5ms)
 *   Tier 2: Phonetic      — Sounds-like via dmetaphone/metaphone/soundex (~20ms)
 *   Tier 3: Fuzzy         — Trigram similarity via pg_trgm (~50ms)
 *
 * Implements early stopping: returns immediately when a match is found.
 * Based on research from Intent-Matching-System-2025-Updated:
 *   - 60% of queries resolve at Tier 1
 *   - 25% at Tier 2
 *   - 12% at Tier 3
 *   - 3% no match
 *
 * ---------------------------------------------------------------------------
 * FUNCTIONS:
 * ---------------------------------------------------------------------------
 *   searchEntity(name, realm, opts)
 *     → Primary cascade: exact → phonetic → fuzzy with early stopping
 *
 *   searchEntityWithDisambiguation(name, realm, opts)
 *     → Wraps searchEntity with action recommendations for UI/pipeline:
 *       single_match (≥0.85), confirm (≥0.65), clarify (<0.65),
 *       disambiguate (2-3 matches), refine (>3 matches), not_found (0)
 *
 *   batchSearchEntities(names[], realm, opts)
 *     → Parallel search via Promise.allSettled with partial failure handling
 *
 *   getSearchStatistics(results[])
 *     → Tier usage analytics from historical search results
 *
 *   validateSearchConfidence(result)
 *     → Confidence assessment helper (proceed/confirm/clarify)
 *
 *   formatSearchResult(result)
 *     → Human-readable search result formatting
 *
 *   searchEntityAllTiers(name, realm, opts)
 *     → GOD MODE: Runs all three tiers without early stopping,
 *       reports per-tier latency for debugging and tuning
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS USED:
 * ---------------------------------------------------------------------------
 * Imported by:
 *   - cotwIntentMatcher.js → searchEntityWithDisambiguation, searchEntityAllTiers
 *
 * This module depends on:
 *   - entityHelpers.js → findEntityExact, findEntityPhonetic, findEntityFuzzy
 *
 * ---------------------------------------------------------------------------
 * REALM ISOLATION:
 * ---------------------------------------------------------------------------
 * Every function requires realm_hex_id and passes it to entityHelpers.
 * No cross-realm data leakage is possible.
 *
 * ---------------------------------------------------------------------------
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger with correlation IDs (no console.log)
 *   - Frozen constants for all thresholds and magic numbers
 *   - Input validation on every public function
 *   - Promise.allSettled for batch operations (partial failure resilience)
 *   - Named exports matching consumer import patterns
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  findEntityExact,
  findEntityPhonetic,
  findEntityFuzzy
} from './entityHelpers.js';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('TieredEntitySearch');

/*
 * ============================================================================
 * Constants — Frozen Configuration
 * ============================================================================
 */

const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 0.85,
  MEDIUM: 0.65
});

const SEARCH_DEFAULTS = Object.freeze({
  FUZZY_THRESHOLD: 0.3,
  MAX_DISAMBIGUATION_OPTIONS: 3,
  TOP_MATCHES_DISPLAY: 3
});

/*
 * ============================================================================
 * Validation Helpers
 * ============================================================================
 */

/**
 * Validates that a hex ID is present and correctly formatted.
 * @param {string} value - The hex ID to validate
 * @param {string} fieldName - Name of the field (for error messages)
 * @throws {Error} If validation fails
 */
function _validateHexId(value, fieldName) {
  if (!value || typeof value !== 'string' || !value.startsWith('#')) {
    throw new Error(`${fieldName} is required and must start with # (received: ${typeof value})`);
  }
}

/**
 * Validates that a string value is present and non-empty.
 * @param {string} value - The string to validate
 * @param {string} fieldName - Name of the field (for error messages)
 * @throws {Error} If validation fails
 */
function _validateString(value, fieldName) {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required and must be a non-empty string`);
  }
}

/*
 * ============================================================================
 * Internal Helpers
 * ============================================================================
 */

/**
 * Attaches telemetry metadata to a search result.
 * DRYs up the repeated latency/metadata calculation across tiers.
 *
 * @param {Object} result - Raw result from entityHelpers
 * @param {number} tiersSearched - How many tiers were attempted
 * @param {number} startTime - Date.now() from search start
 * @param {string} query - Original search query
 * @param {string} realm - Realm hex ID
 * @returns {Object} Result with telemetry attached
 */
function _finalizeResult(result, tiersSearched, startTime, query, realm) {
  return {
    ...result,
    latency_ms: Date.now() - startTime,
    tiers_searched: tiersSearched,
    query,
    realm
  };
}

/*
 * ============================================================================
 * PRIMARY SEARCH ORCHESTRATOR
 * ============================================================================
 */

/**
 * Search for entity using cascading tier strategy.
 * Stops at first tier that returns results (early stopping).
 *
 * @param {string} entityName - Name to search for
 * @param {string} realm_hex_id - Realm to search in (required for isolation)
 * @param {Object} [options] - Search options
 * @param {string} [options.entityType] - Optional entity type filter
 * @param {number} [options.fuzzyThreshold] - Minimum similarity for fuzzy (default 0.3)
 * @param {boolean} [options.skipPhonetic] - Skip tier 2 (default false)
 * @param {boolean} [options.skipFuzzy] - Skip tier 3 (default false)
 * @param {string} [options.correlationId] - Correlation ID for logging
 * @returns {Promise<Object>} Search result with matches and telemetry
 */
export async function searchEntity(entityName, realm_hex_id, options = {}) {
  _validateString(entityName, 'entityName');
  _validateHexId(realm_hex_id, 'realm_hex_id');

  const {
    entityType = null,
    fuzzyThreshold = SEARCH_DEFAULTS.FUZZY_THRESHOLD,
    skipPhonetic = false,
    skipFuzzy = false,
    correlationId = null
  } = options;

  const startTime = Date.now();
  let result = null;
  let tiersActuallySearched = 0;

  try {
    // TIER 1: EXACT MATCH (fastest)
    tiersActuallySearched = 1;
    result = await findEntityExact(entityName, realm_hex_id, entityType, correlationId);
    if (result) {
      return _finalizeResult(result, 1, startTime, entityName, realm_hex_id);
    }

    // TIER 2: PHONETIC MATCH (handles sound-alikes)
    if (!skipPhonetic) {
      tiersActuallySearched = 2;
      result = await findEntityPhonetic(entityName, realm_hex_id, entityType, correlationId);
      if (result) {
        return _finalizeResult(result, 2, startTime, entityName, realm_hex_id);
      }
    }

    // TIER 3: FUZZY MATCH (handles typos)
    if (!skipFuzzy) {
      tiersActuallySearched = 3;
      result = await findEntityFuzzy(entityName, realm_hex_id, entityType, fuzzyThreshold, correlationId);
      if (result) {
        return _finalizeResult(result, 3, startTime, entityName, realm_hex_id);
      }
    }

    // NO MATCH FOUND
    return _finalizeResult(
      { matches: [], method: 'none', confidence: 0.0, count: 0 },
      tiersActuallySearched,
      startTime,
      entityName,
      realm_hex_id
    );

  } catch (error) {
    logger.error('Tiered search orchestration failed', error, {
      correlationId,
      entityName,
      realmHexId: realm_hex_id,
      tiersSearched: tiersActuallySearched
    });
    throw error;
  }
}

/*
 * ============================================================================
 * DISAMBIGUATION ORCHESTRATOR
 * ============================================================================
 */

/**
 * Search with disambiguation handling.
 * Returns structured response with action recommendations for the pipeline/UI.
 *
 * Actions:
 *   not_found    — Zero results
 *   single_match — One result with high confidence (≥0.85), use directly
 *   confirm      — One result with medium confidence (≥0.65), ask user to confirm
 *   clarify      — One result with low confidence (<0.65), ask for clarification
 *   disambiguate — 2-3 results, show numbered options
 *   refine       — >3 results, ask user for more specific query
 *
 * @param {string} entityName - Name to search for
 * @param {string} realm_hex_id - Realm to search in
 * @param {Object} [options] - Search options (same as searchEntity)
 * @returns {Promise<Object>} Result with action recommendation
 */
export async function searchEntityWithDisambiguation(entityName, realm_hex_id, options = {}) {
  const result = await searchEntity(entityName, realm_hex_id, options);

  // No matches
  if (result.count === 0) {
    return {
      action: 'not_found',
      message: `No entity found matching "${entityName}" in this realm.`,
      query: entityName,
      realm: realm_hex_id,
      latency_ms: result.latency_ms
    };
  }

  // Single match with high confidence — proceed directly
  if (result.count === 1 && result.confidence >= CONFIDENCE_THRESHOLDS.HIGH) {
    return {
      action: 'single_match',
      entity: result.matches[0],
      confidence: result.confidence,
      method: result.method,
      query: entityName,
      realm: realm_hex_id,
      latency_ms: result.latency_ms
    };
  }

  // Single match with medium confidence — confirm with user
  if (result.count === 1 && result.confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    return {
      action: 'confirm',
      message: `Did you mean "${result.matches[0].entity_name}"?`,
      entity: result.matches[0],
      confidence: result.confidence,
      method: result.method,
      query: entityName,
      realm: realm_hex_id,
      latency_ms: result.latency_ms
    };
  }

  // Single match with low confidence — ask for clarification
  if (result.count === 1 && result.confidence < CONFIDENCE_THRESHOLDS.MEDIUM) {
    return {
      action: 'clarify',
      message: `I found "${result.matches[0].entity_name}" but I'm not very confident. Is that what you meant?`,
      entity: result.matches[0],
      confidence: result.confidence,
      method: result.method,
      query: entityName,
      realm: realm_hex_id,
      latency_ms: result.latency_ms
    };
  }

  // Multiple matches (2-3) — show numbered options
  if (result.count >= 2 && result.count <= SEARCH_DEFAULTS.MAX_DISAMBIGUATION_OPTIONS) {
    return {
      action: 'disambiguate',
      message: `I found ${result.count} entities. Which did you mean?`,
      options: result.matches.map((m, idx) => ({
        number: idx + 1,
        entity_id: m.entity_id,
        entity_name: m.entity_name,
        entity_type: m.entity_type,
        confidence: m.confidence || result.confidence
      })),
      method: result.method,
      query: entityName,
      realm: realm_hex_id,
      latency_ms: result.latency_ms
    };
  }

  // Too many matches (>3) — ask for more specific query
  if (result.count > SEARCH_DEFAULTS.MAX_DISAMBIGUATION_OPTIONS) {
    return {
      action: 'refine',
      message: `I found ${result.count} possible matches. Can you be more specific?`,
      top_matches: result.matches.slice(0, SEARCH_DEFAULTS.TOP_MATCHES_DISPLAY).map(m => ({
        entity_name: m.entity_name,
        entity_type: m.entity_type
      })),
      method: result.method,
      query: entityName,
      realm: realm_hex_id,
      latency_ms: result.latency_ms
    };
  }

  // Fallback (should not reach here, but safety)
  return {
    action: 'single_match',
    entity: result.matches[0],
    confidence: result.confidence,
    method: result.method,
    query: entityName,
    realm: realm_hex_id,
    latency_ms: result.latency_ms
  };
}

/*
 * ============================================================================
 * BATCH SEARCH
 * ============================================================================
 */

/**
 * Batch search multiple entities at once.
 * Uses Promise.allSettled for partial failure resilience.
 * If one search fails, the others still return results.
 *
 * @param {Array<string>} entityNames - Array of names to search
 * @param {string} realm_hex_id - Realm to search in
 * @param {Object} [options] - Search options (same as searchEntity)
 * @returns {Promise<Array>} Array of search results (with status for failures)
 */
export async function batchSearchEntities(entityNames, realm_hex_id, options = {}) {
  if (!Array.isArray(entityNames) || entityNames.length === 0) {
    throw new Error('entityNames must be a non-empty array');
  }
  _validateHexId(realm_hex_id, 'realm_hex_id');

  const { correlationId = null } = options;

  try {
    const settled = await Promise.allSettled(
      entityNames.map(name => searchEntity(name, realm_hex_id, options))
    );

    return settled.map((outcome, idx) => {
      if (outcome.status === 'fulfilled') {
        return {
          status: 'success',
          query: entityNames[idx],
          ...outcome.value
        };
      }
      logger.warn('Batch search partial failure', {
        correlationId,
        query: entityNames[idx],
        error: outcome.reason?.message || 'Unknown error'
      });
      return {
        status: 'error',
        query: entityNames[idx],
        error: outcome.reason?.message || 'Search failed',
        matches: [],
        method: 'none',
        confidence: 0.0,
        count: 0
      };
    });

  } catch (error) {
    logger.error('Batch search orchestration failed', error, {
      correlationId,
      entityCount: entityNames.length,
      realmHexId: realm_hex_id
    });
    throw error;
  }
}

/*
 * ============================================================================
 * SEARCH STATISTICS
 * ============================================================================
 */

/**
 * Get search statistics for monitoring.
 * Tracks which tiers are being used most.
 *
 * @param {Array<Object>} searchResults - Array of previous search results
 * @returns {Object} Statistics about tier usage
 */
export function getSearchStatistics(searchResults) {
  if (!Array.isArray(searchResults) || searchResults.length === 0) {
    return {
      total_searches: 0,
      tier1_hits: 0,
      tier2_hits: 0,
      tier3_hits: 0,
      no_match: 0,
      avg_latency_ms: 0,
      tier1_percentage: 0,
      tier2_percentage: 0,
      tier3_percentage: 0,
      no_match_percentage: 0
    };
  }

  const stats = {
    total_searches: searchResults.length,
    tier1_hits: 0,
    tier2_hits: 0,
    tier3_hits: 0,
    no_match: 0,
    total_latency: 0
  };

  for (const result of searchResults) {
    if (result.count > 0) {
      if (result.tiers_searched === 1) stats.tier1_hits++;
      else if (result.tiers_searched === 2) stats.tier2_hits++;
      else if (result.tiers_searched === 3) stats.tier3_hits++;
    } else {
      stats.no_match++;
    }
    stats.total_latency += result.latency_ms || 0;
  }

  return {
    total_searches: stats.total_searches,
    tier1_hits: stats.tier1_hits,
    tier2_hits: stats.tier2_hits,
    tier3_hits: stats.tier3_hits,
    no_match: stats.no_match,
    avg_latency_ms: Math.round(stats.total_latency / stats.total_searches),
    tier1_percentage: Math.round((stats.tier1_hits / stats.total_searches) * 100),
    tier2_percentage: Math.round((stats.tier2_hits / stats.total_searches) * 100),
    tier3_percentage: Math.round((stats.tier3_hits / stats.total_searches) * 100),
    no_match_percentage: Math.round((stats.no_match / stats.total_searches) * 100)
  };
}

/*
 * ============================================================================
 * CONFIDENCE VALIDATION
 * ============================================================================
 */

/**
 * Validate search result confidence.
 * Helps determine if result should be used directly or needs confirmation.
 *
 * @param {Object} searchResult - Result from searchEntity
 * @returns {Object} Validation assessment with action recommendation
 */
export function validateSearchConfidence(searchResult) {
  if (!searchResult || searchResult.count === 0) {
    return {
      valid: false,
      action: 'not_found',
      message: 'No matches found'
    };
  }

  const confidence = searchResult.confidence;

  if (confidence >= CONFIDENCE_THRESHOLDS.HIGH) {
    return {
      valid: true,
      action: 'proceed',
      message: 'High confidence match - proceed directly'
    };
  }

  if (confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    return {
      valid: true,
      action: 'confirm',
      message: 'Medium confidence - ask user to confirm'
    };
  }

  return {
    valid: false,
    action: 'clarify',
    message: 'Low confidence - ask user for clarification'
  };
}

/*
 * ============================================================================
 * RESULT FORMATTING
 * ============================================================================
 */

/**
 * Format search result for display to user.
 * Creates human-readable response for Claude the Tanuki.
 *
 * @param {Object} searchResult - Result from searchEntity
 * @returns {string} Formatted message
 */
export function formatSearchResult(searchResult) {
  if (!searchResult || searchResult.count === 0) {
    return `I couldn't find anything matching "${searchResult?.query || 'unknown'}".`;
  }

  const match = searchResult.matches[0];
  const methodDescription = {
    exact: 'found exactly',
    phonetic: 'found (sounds like)',
    fuzzy: 'found (close match)'
  };

  if (searchResult.count === 1) {
    const desc = methodDescription[searchResult.method] || 'found';
    return `I ${desc}: ${match.entity_name} (${match.entity_type})`;
  }

  const names = searchResult.matches
    .slice(0, SEARCH_DEFAULTS.TOP_MATCHES_DISPLAY)
    .map(m => m.entity_name)
    .join(', ');
  return `I found ${searchResult.count} matches: ${names}`;
}

/*
 * ============================================================================
 * GOD MODE: ALL TIERS (No Early Stopping)
 * ============================================================================
 */

/**
 * GOD MODE: Search all three tiers independently.
 * Returns results from ALL tiers (no early stopping).
 * Used for Level 11 debugging to see what each tier found.
 * Reports per-tier latency for performance tuning.
 *
 * @param {string} entityName - Name to search for
 * @param {string} realm_hex_id - Realm to search in
 * @param {Object} [options] - Search options
 * @param {string} [options.entityType] - Optional entity type filter
 * @param {number} [options.fuzzyThreshold] - Minimum similarity for fuzzy
 * @param {string} [options.correlationId] - Correlation ID for logging
 * @returns {Promise<Object>} Results from all three tiers with per-tier latency
 */
export async function searchEntityAllTiers(entityName, realm_hex_id, options = {}) {
  _validateString(entityName, 'entityName');
  _validateHexId(realm_hex_id, 'realm_hex_id');

  const {
    entityType = null,
    fuzzyThreshold = SEARCH_DEFAULTS.FUZZY_THRESHOLD,
    correlationId = null
  } = options;

  const startTime = Date.now();
  const results = {
    query: entityName,
    realm: realm_hex_id,
    tier1: null,
    tier2: null,
    tier3: null,
    tier1_latency_ms: 0,
    tier2_latency_ms: 0,
    tier3_latency_ms: 0,
    total_latency_ms: 0
  };

  try {
    // Run ALL three tiers (no early stopping)
    const tier1Start = Date.now();
    results.tier1 = await findEntityExact(entityName, realm_hex_id, entityType, correlationId);
    results.tier1_latency_ms = Date.now() - tier1Start;

    const tier2Start = Date.now();
    results.tier2 = await findEntityPhonetic(entityName, realm_hex_id, entityType, correlationId);
    results.tier2_latency_ms = Date.now() - tier2Start;

    const tier3Start = Date.now();
    results.tier3 = await findEntityFuzzy(entityName, realm_hex_id, entityType, fuzzyThreshold, correlationId);
    results.tier3_latency_ms = Date.now() - tier3Start;

    results.total_latency_ms = Date.now() - startTime;

    logger.debug('God mode search complete', {
      correlationId,
      entityName,
      realmHexId: realm_hex_id,
      tier1Matches: results.tier1?.count || 0,
      tier2Matches: results.tier2?.count || 0,
      tier3Matches: results.tier3?.count || 0,
      totalLatencyMs: results.total_latency_ms
    });

    return results;

  } catch (error) {
    logger.error('God mode search failed', error, {
      correlationId,
      entityName,
      realmHexId: realm_hex_id
    });
    throw error;
  }
}
