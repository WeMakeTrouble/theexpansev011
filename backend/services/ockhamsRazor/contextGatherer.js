/**
 * =============================================================================
 * CONTEXT GATHERER — Ockham's Razor Engine Data Layer
 * =============================================================================
 *
 * PURPOSE:
 *   Reads from existing production tables to collect the evidence the Razor
 *   needs to generate and evaluate hypotheses. READ-ONLY — never writes.
 *
 * DATA SOURCES (verified against production schema 2026-03-01):
 *   psychic_frames              — PAD emotional states (JSONB: {p, a, d})
 *   psychic_proximity_directed  — Character proximity and bond strength
 *   character_need_fulfillments — Ikigai need scores
 *   character_facet_scores      — OCEAN facet scores per character
 *       NOTE: Original research spec references 'character_neo_pi_r_facets' which does
 *       not exist in production. character_facet_scores is the correct
 *       table, verified via information_schema 2026-03-01.
 *   character_personality       — Archetype link, PAD baselines
 *       NOTE: Original research spec references 'character_profiles.archetype_id' but
 *       archetype_id lives on character_personality. PAD baselines are also
 *       stored directly as pad_baseline_p/a/d on this table, eliminating
 *       the need to join through ocean_archetypes.
 *   narrative_beats             — Beat definitions with target PAD (JSONB)
 *   narrative_beat_play_log     — Beat play history
 *
 * ERROR PROPAGATION:
 *   Each query function returns { data, error } rather than raw arrays.
 *   This allows downstream consumers to distinguish between "no data exists"
 *   (data: [], error: false) and "query failed" (data: [], error: true).
 *   The gatherCharacterContext function aggregates error states into a
 *   top-level errors object for full observability.
 *
 * ARCHITECTURE:
 *   Each function gathers context for one template family.
 *   Returns plain objects — no DB handles leak outside this module.
 *   All queries use parameterised values to prevent injection.
 *   Timeouts set to prevent long-running queries blocking the pipeline.
 *
 * SPEC REFERENCE:
 *   V010_RESEARCH_BRIEF_Ockhams_Razor_Engine.md
 *   Final research review (scored 95/100)
 *
 * DETERMINISTIC:
 *   Same database state always produces same context. No randomness.
 *
 * =============================================================================
 */

import pool from '../../db/pool.js';
import { createModuleLogger } from '../../utils/logger.js';
import { isValidHexId } from '../../utils/hexIdGenerator.js';

const logger = createModuleLogger('razorContextGatherer');

const QUERY_TIMEOUT_MS = 5000;

// =============================================================================
// INTERNAL HELPER — Timed query wrapper
// =============================================================================

/**
 * Wraps a query function with timing and structured error handling.
 * Returns { data, error, durationMs } consistently.
 *
 * @param {string} queryName - Name for logging
 * @param {Function} queryFn - Async function that returns query data
 * @param {string} characterId - For log context
 * @returns {Promise<{data: *, error: boolean, durationMs: number}>}
 */
async function _timedQuery(queryName, queryFn, characterId) {
    const startTime = Date.now();
    try {
        const data = await queryFn();
        const durationMs = Date.now() - startTime;
        logger.debug('Query completed', { queryName, characterId, durationMs });
        return { data, error: false, durationMs };
    } catch (err) {
        const durationMs = Date.now() - startTime;
        logger.error('Query failed', {
            queryName, characterId, durationMs,
            error: err.message, sqlState: err.code
        });
        return { data: null, error: true, durationMs };
    }
}

// =============================================================================
// PAD HISTORY — Used by PAD_DIRECT, PAD_DECAY_BASELINE, PROX_CONTAGION
// =============================================================================

/**
 * Get recent PAD frames for a character.
 * Returns most recent N frames sorted newest first.
 *
 * @param {string} characterId - Hex ID e.g. '#700002'
 * @param {number} [limit=10] - Max frames to return
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<{data: Array|null, error: boolean, durationMs: number}>}
 */
async function getRecentPadFrames(characterId, limit = 10, queryable = pool) {
    return _timedQuery('getRecentPadFrames', async () => {
        const result = await queryable.query({
            text: `SELECT
                       frame_id,
                       character_id,
                       (emotional_state->>'p')::NUMERIC AS p,
                       (emotional_state->>'a')::NUMERIC AS a,
                       (emotional_state->>'d')::NUMERIC AS d,
                       timestamp
                   FROM psychic_frames
                   WHERE character_id = $1
                   ORDER BY timestamp DESC
                   LIMIT $2`,
            values: [characterId, limit],
            timeout: QUERY_TIMEOUT_MS
        });

        return result.rows.map(row => ({
            frameId: row.frame_id,
            characterId: row.character_id,
            p: parseFloat(row.p),
            a: parseFloat(row.a),
            d: parseFloat(row.d),
            timestamp: row.timestamp
        }));
    }, characterId);
}

// =============================================================================
// PROXIMITY — Used by PROX_CONTAGION, TRANSITIVE_CONTAGION, MOAI_WEAKEN
// =============================================================================

/**
 * Get all directed proximity relationships for a character.
 * Returns both inbound (others -> character) and outbound (character -> others).
 *
 * @param {string} characterId - Hex ID
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<{data: {inbound: Array, outbound: Array}|null, error: boolean, durationMs: number}>}
 */
async function getProximityContext(characterId, queryable = pool) {
    return _timedQuery('getProximityContext', async () => {
        const result = await queryable.query({
            text: `SELECT
                       proximity_id,
                       from_character,
                       to_character,
                       current_distance,
                       baseline_distance,
                       emotional_resonance,
                       relationship_type,
                       last_interaction
                   FROM psychic_proximity_directed
                   WHERE from_character = $1 OR to_character = $1
                   ORDER BY current_distance ASC`,
            values: [characterId],
            timeout: QUERY_TIMEOUT_MS
        });

        const inbound = [];
        const outbound = [];

        for (const row of result.rows) {
            const record = {
                proximityId: row.proximity_id,
                fromCharacter: row.from_character,
                toCharacter: row.to_character,
                currentDistance: parseFloat(row.current_distance),
                baselineDistance: parseFloat(row.baseline_distance),
                emotionalResonance: parseFloat(row.emotional_resonance),
                relationshipType: row.relationship_type,
                lastInteraction: row.last_interaction
            };

            if (row.to_character === characterId) {
                inbound.push(record);
            } else {
                outbound.push(record);
            }
        }

        return { inbound, outbound };
    }, characterId);
}

// =============================================================================
// IKIGAI NEEDS — Used by IKIGAI_DRAIN, IKIGAI_DIVERSITY_COLLAPSE, MOAI_WEAKEN
// =============================================================================

/**
 * Get all ikigai need fulfillment scores for a character.
 *
 * @param {string} characterId - Hex ID
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<{data: Array|null, error: boolean, durationMs: number}>}
 */
async function getIkigaiNeeds(characterId, queryable = pool) {
    return _timedQuery('getIkigaiNeeds', async () => {
        const result = await queryable.query({
            text: `SELECT
                       fulfillment_id,
                       character_id,
                       need_code,
                       fulfillment_score,
                       last_updated
                   FROM character_need_fulfillments
                   WHERE character_id = $1
                   ORDER BY need_code`,
            values: [characterId],
            timeout: QUERY_TIMEOUT_MS
        });

        return result.rows.map(row => ({
            fulfillmentId: row.fulfillment_id,
            characterId: row.character_id,
            needCode: row.need_code,
            fulfillmentScore: parseFloat(row.fulfillment_score),
            lastUpdated: row.last_updated
        }));
    }, characterId);
}

// =============================================================================
// OCEAN FACETS — Used by OCEAN_FACET_VULN
// =============================================================================

/**
 * Get OCEAN facet scores for a character.
 * Table: character_facet_scores (NOT character_neo_pi_r_facets from original research spec)
 *
 * @param {string} characterId - Hex ID
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<{data: Array|null, error: boolean, durationMs: number}>}
 */
async function getOceanFacets(characterId, queryable = pool) {
    return _timedQuery('getOceanFacets', async () => {
        const result = await queryable.query({
            text: `SELECT
                       character_id,
                       facet_code,
                       domain,
                       score
                   FROM character_facet_scores
                   WHERE character_id = $1
                   ORDER BY domain, facet_code`,
            values: [characterId],
            timeout: QUERY_TIMEOUT_MS
        });

        return result.rows.map(row => ({
            characterId: row.character_id,
            facetCode: row.facet_code,
            domain: row.domain,
            score: parseFloat(row.score)
        }));
    }, characterId);
}

// =============================================================================
// PAD BASELINE — Used by PAD_DECAY_BASELINE
// =============================================================================

/**
 * Get the PAD baseline values for a character from their personality record.
 * Table: character_personality (NOT character_profiles from original research spec)
 * PAD baselines stored directly — no join through ocean_archetypes needed.
 *
 * @param {string} characterId - Hex ID
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<{data: Object|null, error: boolean, durationMs: number}>}
 */
async function getPadBaseline(characterId, queryable = pool) {
    return _timedQuery('getPadBaseline', async () => {
        const result = await queryable.query({
            text: `SELECT
                       pad_baseline_p,
                       pad_baseline_a,
                       pad_baseline_d,
                       archetype_id
                   FROM character_personality
                   WHERE character_id = $1`,
            values: [characterId],
            timeout: QUERY_TIMEOUT_MS
        });

        if (result.rows.length === 0) {
            return null;
        }

        const row = result.rows[0];
        return {
            p: parseFloat(row.pad_baseline_p),
            a: parseFloat(row.pad_baseline_a),
            d: parseFloat(row.pad_baseline_d),
            archetypeId: row.archetype_id
        };
    }, characterId);
}

// =============================================================================
// NARRATIVE BEAT CONTEXT — Used by PAD_DIRECT
// =============================================================================

/**
 * Get recent beat plays for a character with their target PAD values.
 *
 * @param {string} characterId - Hex ID
 * @param {number} [limit=5] - Max recent beats to return
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<{data: Array|null, error: boolean, durationMs: number}>}
 */
async function getRecentBeatPlays(characterId, limit = 5, queryable = pool) {
    return _timedQuery('getRecentBeatPlays', async () => {
        const result = await queryable.query({
            text: `SELECT
                       bpl.log_id,
                       bpl.beat_id,
                       bpl.character_id,
                       bpl.played_at,
                       bpl.pad_at_play,
                       nb.target_pad,
                       nb.title AS beat_title
                   FROM narrative_beat_play_log bpl
                   JOIN narrative_beats nb ON nb.beat_id = bpl.beat_id
                   WHERE bpl.character_id = $1
                   ORDER BY bpl.played_at DESC
                   LIMIT $2`,
            values: [characterId, limit],
            timeout: QUERY_TIMEOUT_MS
        });

        return result.rows.map(row => ({
            logId: row.log_id,
            beatId: row.beat_id,
            characterId: row.character_id,
            playedAt: row.played_at,
            padAtPlay: row.pad_at_play,
            targetPad: row.target_pad,
            beatTitle: row.beat_title
        }));
    }, characterId);
}

// =============================================================================
// FULL CONTEXT GATHER — Collects everything the Razor needs for one character
// =============================================================================

/**
 * Gather all available context for a single character evaluation.
 * Runs queries in parallel for performance.
 * Returns structured error state so downstream can distinguish
 * "no data" from "query failed".
 *
 * Example:
 *   const context = await gatherCharacterContext('#700002');
 *   if (context.errors.padFrames) { ... handle partial failure ... }
 *   if (context.availability.hasPadHistory) { ... use data ... }
 *
 * @param {string} characterId - Hex ID
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<Object|null>} Complete context bundle with error tracking
 */
async function gatherCharacterContext(characterId, queryable = pool) {
    if (!characterId || typeof characterId !== 'string') {
        logger.warn('gatherCharacterContext called with invalid characterId', {
            characterId: String(characterId)
        });
        return null;
    }

    if (!isValidHexId(characterId)) {
        logger.warn('gatherCharacterContext called with non-hex characterId', {
            characterId
        });
        return null;
    }

    const startTime = Date.now();

    const [padResult, proxResult, ikigaiResult, oceanResult, baselineResult, beatsResult] =
        await Promise.all([
            getRecentPadFrames(characterId, 10, queryable),
            getProximityContext(characterId, queryable),
            getIkigaiNeeds(characterId, queryable),
            getOceanFacets(characterId, queryable),
            getPadBaseline(characterId, queryable),
            getRecentBeatPlays(characterId, 5, queryable)
        ]);

    const durationMs = Date.now() - startTime;

    const padFrames = padResult.data || [];
    const proximity = proxResult.data || { inbound: [], outbound: [] };
    const ikigaiNeeds = ikigaiResult.data || [];
    const oceanFacets = oceanResult.data || [];
    const padBaseline = baselineResult.data || null;
    const recentBeats = beatsResult.data || [];

    const context = {
        characterId,
        gatheredAt: new Date().toISOString(),
        durationMs,
        padFrames,
        proximity,
        ikigaiNeeds,
        oceanFacets,
        padBaseline,
        recentBeats,
        availability: {
            hasPadHistory: padFrames.length > 0,
            hasProximity: proximity.inbound.length > 0 || proximity.outbound.length > 0,
            hasIkigaiNeeds: ikigaiNeeds.length > 0,
            hasOceanFacets: oceanFacets.length > 0,
            hasPadBaseline: padBaseline !== null,
            hasRecentBeats: recentBeats.length > 0
        },
        errors: {
            padFrames: padResult.error,
            proximity: proxResult.error,
            ikigaiNeeds: ikigaiResult.error,
            oceanFacets: oceanResult.error,
            padBaseline: baselineResult.error,
            recentBeats: beatsResult.error,
            hasAnyError: padResult.error || proxResult.error || ikigaiResult.error ||
                oceanResult.error || baselineResult.error || beatsResult.error
        },
        queryTimings: {
            padFrames: padResult.durationMs,
            proximity: proxResult.durationMs,
            ikigaiNeeds: ikigaiResult.durationMs,
            oceanFacets: oceanResult.durationMs,
            padBaseline: baselineResult.durationMs,
            recentBeats: beatsResult.durationMs
        }
    };

    logger.debug('Character context gathered', {
        characterId,
        durationMs,
        availability: context.availability,
        hasAnyError: context.errors.hasAnyError
    });

    return context;
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
    getRecentPadFrames,
    getProximityContext,
    getIkigaiNeeds,
    getOceanFacets,
    getPadBaseline,
    getRecentBeatPlays,
    gatherCharacterContext
};

export default gatherCharacterContext;
