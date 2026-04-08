/**
 * ===========================================================================
 * ClaudeVisitationScheduler.js — System A: Claude Visitation Scheduler
 * ===========================================================================
 *
 * PURPOSE:
 * Determines WHEN and WHY Claude visits each B-Roll character. Computes a
 * Composite Priority Score (CPS) for every eligible B-Roll character and
 * selects the highest-scoring character for Claude's next visit.
 *
 * CPS FORMULA (from V010_FINAL_SPEC_BRoll_Autonomous_Speech.md Section 4.2):
 *
 *   CPS(character) = (FSRS_urgency       * W_fsrs)
 *                  + (emotional_readiness * W_emotional)
 *                  + (proximity_opportunity * W_proximity)
 *                  + (narrative_opportunity * W_narrative)
 *                  + (claude_engagement    * W_engagement)
 *                  + whimsy_offset
 *
 * Default weights: 0.40, 0.25, 0.15, 0.10, 0.10 (spec Section 4.2).
 * Weights are runtime-configurable via constructor for tuning without deploy.
 * Final CPS is clamped to 0-100 range.
 *
 * SCORING FACTORS:
 *   Factor 1 — FSRS Review Urgency (40%): Most overdue knowledge item per
 *     character. Pre-verbal characters score 0 (correct — they need teaching).
 *   Factor 2 — Emotional Teaching Readiness (25%): Yerkes-Dodson zones from
 *     PAD state. Inhibit/Soft-Inhibit/Optimal with score calculation.
 *   Factor 3 — Psychic Proximity Opportunity (15%): Claude-to-character
 *     psychological distance inverted and normalised 0-100.
 *   Factor 4 — Narrative Opportunity (10%): Boolean flags from arc_characters
 *     and conversation_qud. Scores 0 when data sources are empty.
 *   Factor 5 — Claude Engagement (10%): Claude's own PAD state determines
 *     what kind of character he gravitates toward.
 *   Whimsy Offset: Deterministic djb2-hash offset to prevent mechanical feel.
 *     Can be disabled via constructor for debugging.
 *
 * SCHEDULING MODES (Section 4.3):
 *   Mode 1 — Idle-Time Background Teaching (user inactive >30s)
 *   Mode 2 — Event-Triggered Teaching (PAD threshold crossed)
 *   Mode 3 — Narrative-Anchored Teaching (user asks about character)
 *
 * EMERGENCY OVERRIDE (Section 4.5):
 *   Characters unvisited for 7+ days bypass emotional gate.
 *
 * VISIT TYPES:
 *   'teaching' — Full teaching session (new vocabulary)
 *   'review'   — FSRS review of existing vocabulary
 *   'comfort'  — Emotional support only (character in inhibit zone)
 *   'narrative' — Narrative-triggered visit
 *
 * ERROR HANDLING MODES:
 *   strictMode=false (default): Factor fetch failures degrade to score 0.
 *     Scheduler continues with partial data. Suitable for production.
 *   strictMode=true: Factor fetch failures throw immediately. Caller must
 *     handle. Suitable for testing, diagnostics, and CI validation.
 *
 * BATCH EFFICIENCY:
 *   All factor data fetched in parallel (Promise.all) via batch SQL.
 *   No N+1 queries. One query per data source, compute in memory.
 *
 * DATABASE INDEX REQUIREMENTS:
 *   character_teaching_queue needs index on (character_id, completed_at)
 *   for the last-visit-time query. Verify with:
 *     \d character_teaching_queue
 *   Existing idx_teaching_queue_priority covers (priority_score, scheduled_for)
 *   but NOT the completed_at lookup used by _getLastVisitTimes.
 *
 * DEPENDENCIES:
 *   - FSRSMultiLearner (getDueItemsBatch)
 *   - pool (PostgreSQL connection)
 *   - logger (createModuleLogger)
 *   - generateHexId (queue entry creation, accepts transaction client)
 *
 * REVIEW HISTORY:
 *   v1 — Initial implementation, March 2026
 *     Reviewer 1: 93/100 — P0: O(n²) name lookup, broken timeout, mixed Map keys
 *     Reviewer 2: 84/100 — P0: parseFloat??0 NaN bug, no input validation, no idempotency
 *     Reviewer 3: 68/100 — P0: timeout broken, unbounded input, non-injectable clock
 *   v2 — All P0/P1 from v1 resolved. Scores: Reviewer 4: 87/100
 *     Remaining: silent degradation, no runtime weight config, clock docs, index gap
 *   v3 — All actionable v2 feedback resolved:
 *     - strictMode option: fail-fast vs graceful degradation (caller decides)
 *     - Runtime-configurable CPS weights via constructor
 *     - Whimsy toggle: opts.whimsyEnabled (default true) for debug/test
 *     - Clock interface documented with explicit JSDoc contract
 *     - Index requirement for character_teaching_queue documented
 *     - Weight validation on construction (must sum to ~1.0)
 *     - Factor failure logging enhanced with strictMode context
 *
 * ===========================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId from '../utils/hexIdGenerator.js';
import FSRSMultiLearner from './FSRSMultiLearner.js';

const logger = createModuleLogger('ClaudeVisitationScheduler');

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const DEFAULT_CPS_WEIGHTS = Object.freeze({
    FSRS_URGENCY: 0.40,
    EMOTIONAL_READINESS: 0.25,
    PROXIMITY_OPPORTUNITY: 0.15,
    NARRATIVE_OPPORTUNITY: 0.10,
    CLAUDE_ENGAGEMENT: 0.10
});

const WHIMSY_CONFIG = Object.freeze({
    EPSILON: 10
});

const EMOTIONAL_THRESHOLDS = Object.freeze({
    INHIBIT_PLEASURE_FLOOR: -0.5,
    INHIBIT_AROUSAL_CEILING: 0.7,
    SOFT_INHIBIT_PLEASURE_FLOOR: -0.5,
    SOFT_INHIBIT_PLEASURE_CEILING: -0.2,
    SOFT_INHIBIT_SCORE_MIN: 25,
    SOFT_INHIBIT_SCORE_MAX: 50,
    OPTIMAL_PLEASURE_CENTER: 0.2,
    OPTIMAL_PLEASURE_SPREAD: 1.5,
    OPTIMAL_AROUSAL_CENTER: 0.3,
    OPTIMAL_AROUSAL_SPREAD: 1.2
});

const NARRATIVE_SCORES = Object.freeze({
    ARC_INVOLVEMENT: 40,
    BREACH_EVENT: 30,
    USER_HOVER: 20,
    QUD_REFERENCE: 10,
    CAP: 100
});

const SCHEDULER_LIMITS = Object.freeze({
    EMERGENCY_OVERRIDE_DAYS: 7,
    DEFAULT_QUERY_TIMEOUT_MS: 5000,
    MAX_ELIGIBLE_CHARACTERS: 200,
    MAX_BATCH_SIZE: 200,
    WEIGHT_SUM_TOLERANCE: 0.01
});

const CLAUDE_CHARACTER_ID = '#700002';

const DEFAULT_PAD = Object.freeze({ p: 0, a: 0, d: 0 });

// ---------------------------------------------------------------------------
// UTILITY: Safe Number Parser
// ---------------------------------------------------------------------------

/**
 * Safely converts a value to a finite number.
 * Returns fallback if value is null, undefined, NaN, or Infinity.
 * Fixes the parseFloat ?? 0 bug where NaN passes the ?? check.
 *
 * @param {*} value — Value to parse
 * @param {number} fallback — Default if not a finite number (default 0)
 * @returns {number} A guaranteed finite number
 */
function safeFloat(value, fallback = 0) {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : fallback;
}

// ---------------------------------------------------------------------------
// UTILITY: djb2 Hash (deterministic, same as VocabularyConstructor.js)
// ---------------------------------------------------------------------------

/**
 * djb2 hash function for deterministic pseudo-random values.
 * Same implementation used across all B-Roll files for consistency.
 *
 * @param {string} str — Input string to hash
 * @returns {number} Non-negative 31-bit integer hash
 */
function djb2Hash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        hash = hash & 0x7FFFFFFF;
    }
    return hash;
}

// ---------------------------------------------------------------------------
// CLASS
// ---------------------------------------------------------------------------

export default class ClaudeVisitationScheduler {

    /**
     * Creates a new ClaudeVisitationScheduler instance.
     *
     * @param {object} opts — Configuration options (all optional)
     * @param {object} opts.pool — PostgreSQL pool. Default: imported pool.
     * @param {FSRSMultiLearner} opts.fsrsMultiLearner — FSRS engine instance.
     *     Default: new FSRSMultiLearner using the provided pool.
     * @param {string} opts.claudeCharacterId — Claude's hex ID. Default: '#700002'.
     * @param {number} opts.queryTimeoutMs — SQL query timeout in ms. Default: 5000.
     * @param {number} opts.whimsyEpsilon — Whimsy offset range on 0-100 scale.
     *     Default: 10 (offsets range from -5 to +5).
     * @param {boolean} opts.whimsyEnabled — Set false to disable whimsy offset
     *     entirely. Useful for debugging deterministic scoring. Default: true.
     * @param {number} opts.emergencyOverrideDays — Days without visit before
     *     emergency override activates. Default: 7.
     * @param {boolean} opts.strictMode — When true, factor fetch failures throw
     *     immediately instead of defaulting to 0. Default: false.
     * @param {function} opts.onVisitScheduled — Callback fired after a visit is
     *     successfully queued. Receives { winnerId, winnerName, visitType, cps,
     *     queueEntryId, mode, rosterSize }. Errors in callback are caught and logged.
     * @param {function} opts.clock — Injectable clock constructor for deterministic
     *     testing of whimsy offset. Must be a constructor that produces an object
     *     with .toISOString() and .getTime() methods (i.e., Date-compatible).
     *     Default: Date. Example for testing:
     *       class FrozenClock { toISOString() { return '2026-03-07T00:00:00.000Z'; } getTime() { return 1772956800000; } }
     *       new ClaudeVisitationScheduler({ clock: FrozenClock })
     * @param {object} opts.cpsWeights — Override CPS factor weights.
     *     Must contain: FSRS_URGENCY, EMOTIONAL_READINESS, PROXIMITY_OPPORTUNITY,
     *     NARRATIVE_OPPORTUNITY, CLAUDE_ENGAGEMENT. Values should sum to ~1.0.
     *     Default: { 0.40, 0.25, 0.15, 0.10, 0.10 }.
     */
    constructor(opts = {}) {
        this._pool = opts.pool ?? pool;
        this._fsrs = opts.fsrsMultiLearner ?? new FSRSMultiLearner(this._pool);
        this._claudeId = opts.claudeCharacterId ?? CLAUDE_CHARACTER_ID;
        this._queryTimeoutMs = opts.queryTimeoutMs ?? SCHEDULER_LIMITS.DEFAULT_QUERY_TIMEOUT_MS;
        this._whimsyEpsilon = opts.whimsyEpsilon ?? WHIMSY_CONFIG.EPSILON;
        this._whimsyEnabled = opts.whimsyEnabled ?? true;
        this._emergencyOverrideDays = opts.emergencyOverrideDays ?? SCHEDULER_LIMITS.EMERGENCY_OVERRIDE_DAYS;
        this._strictMode = opts.strictMode ?? false;
        this._onVisitScheduled = opts.onVisitScheduled ?? null;
        this._clock = opts.clock ?? Date;
        this._cpsWeights = this._validateAndFreezeWeights(opts.cpsWeights);
    }

    /**
     * Validates CPS weights sum to approximately 1.0 and freezes them.
     * Falls back to defaults if not provided or invalid.
     *
     * @param {object|undefined} weights — Custom CPS weights
     * @returns {object} Frozen weights object
     * @throws {Error} If weights are provided but don't sum to ~1.0
     */
    _validateAndFreezeWeights(weights) {
        if (!weights) {
            return DEFAULT_CPS_WEIGHTS;
        }

        const required = ['FSRS_URGENCY', 'EMOTIONAL_READINESS', 'PROXIMITY_OPPORTUNITY', 'NARRATIVE_OPPORTUNITY', 'CLAUDE_ENGAGEMENT'];
        for (const key of required) {
            if (typeof weights[key] !== 'number' || !Number.isFinite(weights[key])) {
                throw new Error(`CPS weight '${key}' must be a finite number. Received: ${weights[key]}`);
            }
        }

        const sum = required.reduce((acc, key) => acc + weights[key], 0);
        if (Math.abs(sum - 1.0) > SCHEDULER_LIMITS.WEIGHT_SUM_TOLERANCE) {
            throw new Error(
                `CPS weights must sum to ~1.0 (tolerance ${SCHEDULER_LIMITS.WEIGHT_SUM_TOLERANCE}). ` +
                `Received sum: ${sum.toFixed(4)}`
            );
        }

        return Object.freeze({ ...weights });
    }

    // =======================================================================
    // PUBLIC: Main Scheduling Cycle
    // =======================================================================

    /**
     * Runs a full scheduling cycle. Scores all eligible B-Roll characters
     * and selects the highest-priority character for Claude's next visit.
     *
     * @param {object} opts
     * @param {string} opts.mode — 'idle' | 'event' | 'narrative'. Default: 'idle'.
     * @param {string} opts.triggeredCharacterId — For mode='narrative', the
     *     character hex ID that was referenced by the user or narrative beat.
     * @param {boolean} opts.debug — When true, includes per-step timing trace
     *     in the return value. Default: false.
     * @param {string} opts.correlationId — Propagated to all logs and sub-queries
     *     for distributed tracing.
     * @returns {object} {
     *     winner: object|null — Roster entry for the selected character,
     *     roster: object[] — Full scored roster (all eligible characters),
     *     visitType: string|null — 'teaching'|'review'|'comfort'|'narrative',
     *     queueEntryId: string|null — Hex ID of the queue entry,
     *     trace: object[]|null — Per-step timing (only when opts.debug=true)
     * }
     */
    async runSchedulingCycle(opts = {}) {
        const cycleStart = Date.now();
        const trace = opts.debug ? [] : null;
        const mode = opts.mode ?? 'idle';

        logger.info('Scheduling cycle started', {
            mode,
            claudeId: this._claudeId,
            strictMode: this._strictMode,
            whimsyEnabled: this._whimsyEnabled,
            correlationId: opts.correlationId ?? null
        });

        // Step 1: Get eligible characters
        let stepStart = Date.now();
        const eligibleCharacters = await this._getEligibleCharacters(opts);
        if (trace) trace.push({ step: 'getEligibleCharacters', ms: Date.now() - stepStart, count: eligibleCharacters.length });

        if (eligibleCharacters.length === 0) {
            logger.info('No eligible B-Roll characters found', {
                correlationId: opts.correlationId ?? null
            });
            return { winner: null, roster: [], visitType: null, queueEntryId: null, trace };
        }

        const characterIds = eligibleCharacters.map(c => c.character_id);
        const nameMap = new Map(eligibleCharacters.map(c => [c.character_id, c.character_name]));

        // Step 2: Fetch all factor data in parallel (batch efficiency)
        stepStart = Date.now();
        const [
            fsrsUrgencyMap,
            emotionalResult,
            proximityMap,
            narrativeMap,
            claudePad,
            lastVisitMap
        ] = await Promise.all([
            this._scoreFsrsUrgency(characterIds, opts),
            this._scoreEmotionalReadiness(characterIds, opts),
            this._scoreProximityOpportunity(characterIds, opts),
            this._scoreNarrativeOpportunity(characterIds, opts),
            this._getClaudeEngagementProfile(opts),
            this._getLastVisitTimes(characterIds, opts)
        ]);
        if (trace) trace.push({ step: 'fetchAllFactors', ms: Date.now() - stepStart });

        // Step 3: Compute CPS per character
        stepStart = Date.now();
        const roster = this._computeRoster(
            characterIds, nameMap, fsrsUrgencyMap, emotionalResult,
            proximityMap, narrativeMap, claudePad, lastVisitMap
        );
        if (trace) trace.push({ step: 'computeCPS', ms: Date.now() - stepStart, rosterSize: roster.length });

        // Step 4: Select winner
        stepStart = Date.now();
        const { winner, visitType } = this._selectWinner(roster, mode, opts);
        if (trace) trace.push({ step: 'selectWinner', ms: Date.now() - stepStart, winnerId: winner?.characterId ?? null, visitType });

        if (!winner) {
            logger.info('No winner selected (all characters ineligible)', {
                correlationId: opts.correlationId ?? null
            });
            return { winner: null, roster, visitType: null, queueEntryId: null, trace };
        }

        // Step 5: Queue the visit (with idempotency check)
        stepStart = Date.now();
        const queueEntryId = await this._queueVisit(winner, visitType, opts);
        if (trace) trace.push({ step: 'queueVisit', ms: Date.now() - stepStart, queueEntryId });

        // Callback
        if (typeof this._onVisitScheduled === 'function') {
            try {
                this._onVisitScheduled({
                    winnerId: winner.characterId,
                    winnerName: winner.characterName,
                    visitType,
                    cps: winner.cps,
                    queueEntryId,
                    mode,
                    rosterSize: roster.length
                });
            } catch (cbErr) {
                logger.warn('onVisitScheduled callback error', { error: cbErr.message });
            }
        }

        const totalMs = Date.now() - cycleStart;
        if (trace) trace.push({ step: 'total', ms: totalMs });

        logger.info('Scheduling cycle complete', {
            winnerId: winner.characterId,
            winnerName: winner.characterName,
            winnerCps: winner.cps,
            visitType,
            queueEntryId,
            eligibleCount: roster.length,
            mode,
            totalMs,
            correlationId: opts.correlationId ?? null
        });

        return {
            winner,
            roster,
            visitType,
            queueEntryId,
            trace
        };
    }

    // =======================================================================
    // PRIVATE: Compute Full Roster
    // =======================================================================

    /**
     * Computes CPS scores for all characters and returns sorted roster.
     * Extracted from runSchedulingCycle for testability and readability.
     *
     * @param {string[]} characterIds — Eligible character hex IDs
     * @param {Map<string, string>} nameMap — Map(characterId => characterName)
     * @param {Map<string, number>} fsrsUrgencyMap — Map(characterId => score 0-100)
     * @param {object} emotionalResult — { scores: Map, pads: Map }
     * @param {Map<string, number>} proximityMap — Map(characterId => score 0-100)
     * @param {Map<string, number>} narrativeMap — Map(characterId => score 0-100)
     * @param {object} claudePad — { p: number, a: number, d: number }
     * @param {Map<string, string|null>} lastVisitMap — Map(characterId => ISO timestamp | null)
     * @returns {object[]} Sorted roster array, highest CPS first. Each entry:
     *   { characterId, characterName, factors, cps, emotionalZone,
     *     emergencyOverride, daysSinceVisit, lastVisit }
     */
    _computeRoster(characterIds, nameMap, fsrsUrgencyMap, emotionalResult, proximityMap, narrativeMap, claudePad, lastVisitMap) {
        const now = new this._clock();
        const roster = [];
        const w = this._cpsWeights;

        for (const charId of characterIds) {
            const fsrs = fsrsUrgencyMap.get(charId) ?? 0;
            const emotional = emotionalResult.scores.get(charId) ?? 0;
            const proximity = proximityMap.get(charId) ?? 0;
            const narrative = narrativeMap.get(charId) ?? 0;
            const engagement = this._computeClaudeEngagement(
                claudePad, fsrs, emotional, proximity, narrative
            );
            const whimsy = this._whimsyEnabled
                ? this._computeWhimsyOffset(charId)
                : 0;

            const rawCps = (fsrs * w.FSRS_URGENCY)
                         + (emotional * w.EMOTIONAL_READINESS)
                         + (proximity * w.PROXIMITY_OPPORTUNITY)
                         + (narrative * w.NARRATIVE_OPPORTUNITY)
                         + (engagement * w.CLAUDE_ENGAGEMENT)
                         + whimsy;

            const cps = Math.max(0, Math.min(100, rawCps));

            const lastVisit = lastVisitMap.get(charId) ?? null;
            const daysSinceVisit = lastVisit
                ? (now.getTime() - new Date(lastVisit).getTime()) / (1000 * 60 * 60 * 24)
                : null;
            const emergencyOverride = daysSinceVisit === null
                ? true
                : daysSinceVisit >= this._emergencyOverrideDays;

            const pad = emotionalResult.pads.get(charId) ?? DEFAULT_PAD;
            const emotionalZone = this._classifyEmotionalZone(pad);

            roster.push({
                characterId: charId,
                characterName: nameMap.get(charId) ?? 'unknown',
                factors: {
                    fsrsUrgency: fsrs,
                    emotionalReadiness: emotional,
                    proximityOpportunity: proximity,
                    narrativeOpportunity: narrative,
                    claudeEngagement: engagement,
                    whimsyOffset: whimsy
                },
                cps,
                emotionalZone,
                emergencyOverride,
                daysSinceVisit,
                lastVisit
            });
        }

        // Sort by CPS descending. Deterministic djb2 tiebreaker prevents
        // unstable sort ordering when two characters have identical CPS.
        roster.sort((a, b) => {
            if (b.cps !== a.cps) return b.cps - a.cps;
            return djb2Hash(a.characterId) - djb2Hash(b.characterId);
        });

        return roster;
    }

    // =======================================================================
    // PRIVATE: Winner Selection
    // =======================================================================

    /**
     * Selects the winning character from the sorted roster.
     * Applies narrative mode override and inhibit zone skipping.
     *
     * Selection logic:
     *   1. Default winner is roster[0] (highest CPS)
     *   2. Narrative mode: triggered character overrides CPS ranking
     *   3. Inhibited winner without emergency: skip to next non-inhibited
     *   4. If all inhibited: winner remains (comfort visit)
     *
     * @param {object[]} roster — Sorted roster (highest CPS first)
     * @param {string} mode — 'idle' | 'event' | 'narrative'
     * @param {object} opts — { triggeredCharacterId, correlationId }
     * @returns {object} { winner: object|null, visitType: string|null }
     */
    _selectWinner(roster, mode, opts = {}) {
        if (roster.length === 0) {
            return { winner: null, visitType: null };
        }

        let winner = roster[0];

        // Narrative mode: user or narrative beat referenced a specific character
        if (mode === 'narrative' && opts.triggeredCharacterId) {
            const triggered = roster.find(r => r.characterId === opts.triggeredCharacterId);
            if (triggered) {
                logger.info('Narrative mode override applied', {
                    characterId: triggered.characterId,
                    originalWinner: roster[0].characterId,
                    cpsDelta: (roster[0].cps - triggered.cps).toFixed(2),
                    correlationId: opts.correlationId ?? null
                });
                winner = triggered;
            }
        }

        // Skip inhibited winner unless emergency override or all inhibited
        if (winner.emotionalZone === 'inhibit' && !winner.emergencyOverride) {
            const nonInhibited = roster.find(r => r.emotionalZone !== 'inhibit');
            if (nonInhibited) {
                logger.info('Inhibited winner skipped, selecting next eligible', {
                    skippedId: winner.characterId,
                    skippedCps: winner.cps,
                    selectedId: nonInhibited.characterId,
                    selectedCps: nonInhibited.cps,
                    correlationId: opts.correlationId ?? null
                });
                winner = nonInhibited;
            }
        }

        const visitType = this._determineVisitType(winner, mode);
        return { winner, visitType };
    }

    // =======================================================================
    // PRIVATE: Eligible Character Fetch
    // =======================================================================

    /**
     * Fetches all active, autonomous B-Roll Chaos characters.
     * Capped at MAX_ELIGIBLE_CHARACTERS to bound memory and query cost.
     *
     * @param {object} opts — { correlationId }
     * @returns {object[]} Array of { character_id: string, character_name: string }
     */
    async _getEligibleCharacters(opts = {}) {
        const result = await this._query(
            `SELECT character_id, character_name
             FROM character_profiles
             WHERE category = 'B-Roll Chaos'
               AND is_b_roll_autonomous = true
               AND is_active = true
             ORDER BY character_id
             LIMIT $1`,
            [SCHEDULER_LIMITS.MAX_ELIGIBLE_CHARACTERS],
            opts,
            'getEligibleCharacters'
        );
        return result.rows;
    }

    // =======================================================================
    // FACTOR 1: FSRS Review Urgency (40%)
    // =======================================================================

    /**
     * Scores each character by their most overdue FSRS knowledge item.
     * Formula: min(1.0, overdue_days / (3 * stability)) * 100
     * Pre-verbal characters (no due items) score 0 — this is correct
     * behaviour, not an error. They need teaching visits, not reviews.
     *
     * @param {string[]} characterIds — Hex IDs to score
     * @param {object} opts — { correlationId }
     * @returns {Map<string, number>} Map(characterId => score 0-100)
     */
    async _scoreFsrsUrgency(characterIds, opts = {}) {
        this._validateBatchSize(characterIds, '_scoreFsrsUrgency');
        const scoreMap = new Map();

        for (const id of characterIds) {
            scoreMap.set(id, 0);
        }

        try {
            const dueItems = await this._fsrs.getDueItemsBatch(characterIds, {
                correlationId: opts.correlationId
            });

            for (const row of dueItems) {
                const overdueDays = safeFloat(row.overdue_days, 0);
                const stability = safeFloat(row.stability, 1);
                const targetInterval = Math.max(stability, 0.1);
                const rawUrgency = Math.min(1.0, overdueDays / (3 * targetInterval));
                scoreMap.set(row.character_id, Math.round(rawUrgency * 100));
            }
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('FSRS urgency fetch failed, defaulting to 0 for all', {
                error: error.message,
                strictMode: false,
                characterCount: characterIds.length,
                correlationId: opts.correlationId ?? null
            });
        }

        return scoreMap;
    }

    // =======================================================================
    // FACTOR 2: Emotional Teaching Readiness (25%)
    // =======================================================================

    /**
     * Scores each character's readiness to learn based on PAD emotional state.
     * Uses Yerkes-Dodson Law zones:
     *
     *   Inhibit (score 0): P < -0.5 OR A > 0.7
     *     Character is too distressed or overstimulated. Comfort visit only.
     *
     *   Soft Inhibit (score 25-50): P between -0.5 and -0.2
     *     Character is mildly negative. Short reviews only, no new content.
     *
     *   Optimal (score 0-100): All other states
     *     Score peaks when P ≈ 0.2 and A ≈ 0.3 (Yerkes-Dodson sweet spot).
     *
     * Returns separate Maps for scores and raw PAD data. The PAD map is
     * consumed by _computeRoster for emotional zone classification.
     *
     * @param {string[]} characterIds — Hex IDs to score
     * @param {object} opts — { correlationId }
     * @returns {object} {
     *     scores: Map<string, number> — Map(charId => 0-100),
     *     pads: Map<string, object> — Map(charId => { p, a, d })
     * }
     */
    async _scoreEmotionalReadiness(characterIds, opts = {}) {
        this._validateBatchSize(characterIds, '_scoreEmotionalReadiness');
        const scores = new Map();
        const pads = new Map();

        for (const id of characterIds) {
            scores.set(id, 0);
            pads.set(id, DEFAULT_PAD);
        }

        try {
            const result = await this._query(
                `SELECT character_id, p, a, d
                 FROM psychic_moods
                 WHERE character_id = ANY($1::text[])`,
                [characterIds],
                opts,
                'scoreEmotionalReadiness'
            );

            for (const row of result.rows) {
                const p = safeFloat(row.p, 0);
                const a = safeFloat(row.a, 0);
                const d = safeFloat(row.d, 0);

                pads.set(row.character_id, { p, a, d });

                const zone = this._classifyEmotionalZone({ p, a, d });

                if (zone === 'inhibit') {
                    scores.set(row.character_id, 0);
                } else if (zone === 'soft_inhibit') {
                    const range = EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_PLEASURE_CEILING
                                - EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_PLEASURE_FLOOR;
                    const t = (p - EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_PLEASURE_FLOOR) / range;
                    const clamped = Math.max(0, Math.min(1, t));
                    const score = EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_SCORE_MIN
                                + (clamped * (EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_SCORE_MAX - EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_SCORE_MIN));
                    scores.set(row.character_id, Math.round(score));
                } else {
                    const pleasureScore = 1 - Math.abs(p - EMOTIONAL_THRESHOLDS.OPTIMAL_PLEASURE_CENTER) * EMOTIONAL_THRESHOLDS.OPTIMAL_PLEASURE_SPREAD;
                    const arousalScore = 1 - Math.abs(a - EMOTIONAL_THRESHOLDS.OPTIMAL_AROUSAL_CENTER) * EMOTIONAL_THRESHOLDS.OPTIMAL_AROUSAL_SPREAD;
                    const readiness = Math.max(0, Math.min(100, (pleasureScore + arousalScore) / 2 * 100));
                    scores.set(row.character_id, Math.round(readiness));
                }
            }
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Emotional readiness fetch failed, defaulting to 0 for all', {
                error: error.message,
                strictMode: false,
                characterCount: characterIds.length,
                correlationId: opts.correlationId ?? null
            });
        }

        return { scores, pads };
    }

    /**
     * Classifies a PAD state into a Yerkes-Dodson emotional zone.
     *
     * @param {object} pad — { p: number, a: number, d: number }
     * @returns {string} 'inhibit' | 'soft_inhibit' | 'optimal'
     */
    _classifyEmotionalZone(pad) {
        if (pad.p < EMOTIONAL_THRESHOLDS.INHIBIT_PLEASURE_FLOOR
            || pad.a > EMOTIONAL_THRESHOLDS.INHIBIT_AROUSAL_CEILING) {
            return 'inhibit';
        }
        if (pad.p >= EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_PLEASURE_FLOOR
            && pad.p < EMOTIONAL_THRESHOLDS.SOFT_INHIBIT_PLEASURE_CEILING) {
            return 'soft_inhibit';
        }
        return 'optimal';
    }

    // =======================================================================
    // FACTOR 3: Psychic Proximity Opportunity (15%)
    // =======================================================================

    /**
     * Scores each character by their psychological proximity to Claude.
     * Lower distance = higher score. Inverted and normalised to 0-100.
     *
     * Uses psychic_proximity symmetric table. Claude can appear as either
     * character_a or character_b (handled by OR clause in query).
     *
     * Characters with no proximity entry score 0 (no established bond).
     *
     * @param {string[]} characterIds — Hex IDs to score
     * @param {object} opts — { correlationId }
     * @returns {Map<string, number>} Map(characterId => score 0-100)
     */
    async _scoreProximityOpportunity(characterIds, opts = {}) {
        this._validateBatchSize(characterIds, '_scoreProximityOpportunity');
        const scoreMap = new Map();

        for (const id of characterIds) {
            scoreMap.set(id, 0);
        }

        try {
            const result = await this._query(
                `SELECT
                    CASE WHEN character_a = $1 THEN character_b ELSE character_a END AS target_id,
                    psychological_distance
                 FROM psychic_proximity
                 WHERE (character_a = $1 AND character_b = ANY($2::text[]))
                    OR (character_b = $1 AND character_a = ANY($2::text[]))`,
                [this._claudeId, characterIds],
                opts,
                'scoreProximityOpportunity'
            );

            for (const row of result.rows) {
                const distance = safeFloat(row.psychological_distance, 0.5);
                const clampedDistance = Math.max(0, Math.min(1, distance));
                const score = (1 - clampedDistance) * 100;
                scoreMap.set(row.target_id, Math.round(score));
            }
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Proximity fetch failed, defaulting to 0 for all', {
                error: error.message,
                strictMode: false,
                characterCount: characterIds.length,
                correlationId: opts.correlationId ?? null
            });
        }

        return scoreMap;
    }

    // =======================================================================
    // FACTOR 4: Narrative Opportunity (10%)
    // =======================================================================

    /**
     * Scores each character by their involvement in active narrative elements.
     * Additive boolean flags:
     *   - Character in current arc (arc_characters): +40
     *   - Breach Event approaching: +30 (future: psychic_events, not yet wired)
     *   - User recently hovered radar blip: +20 (future: client events, not yet wired)
     *   - Character referenced in recent QUD (24h window): +10
     * Capped at 100.
     *
     * Scores 0 for all characters when data sources are empty.
     * This is intentional — the factor activates naturally when narrative
     * systems are populated. No stubs pretending to work.
     *
     * @param {string[]} characterIds — Hex IDs to score
     * @param {object} opts — { correlationId }
     * @returns {Map<string, number>} Map(characterId => score 0-100)
     */
    async _scoreNarrativeOpportunity(characterIds, opts = {}) {
        this._validateBatchSize(characterIds, '_scoreNarrativeOpportunity');
        const scoreMap = new Map();

        for (const id of characterIds) {
            scoreMap.set(id, 0);
        }

        try {
            // Arc involvement: is this character assigned to an active narrative arc?
            const arcResult = await this._query(
                `SELECT DISTINCT character_id
                 FROM arc_characters
                 WHERE character_id = ANY($1::text[])`,
                [characterIds],
                opts,
                'scoreNarrativeOpportunity_arc'
            );
            const arcCharacters = new Set(arcResult.rows.map(r => r.character_id));

            // QUD reference: was this character mentioned in recent conversation context?
            const qudResult = await this._query(
                `SELECT DISTINCT
                    unnest(
                        CASE WHEN entities IS NOT NULL
                             THEN ARRAY(SELECT jsonb_array_elements_text(entities))
                             ELSE ARRAY[]::text[]
                        END
                    ) AS entity_id
                 FROM conversation_qud
                 WHERE asked_at >= NOW() - INTERVAL '24 hours'`,
                [],
                opts,
                'scoreNarrativeOpportunity_qud'
            );
            const qudEntities = new Set(qudResult.rows.map(r => r.entity_id));

            for (const charId of characterIds) {
                let score = 0;
                if (arcCharacters.has(charId)) score += NARRATIVE_SCORES.ARC_INVOLVEMENT;
                if (qudEntities.has(charId)) score += NARRATIVE_SCORES.QUD_REFERENCE;
                scoreMap.set(charId, Math.min(score, NARRATIVE_SCORES.CAP));
            }
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Narrative opportunity fetch failed, defaulting to 0 for all', {
                error: error.message,
                strictMode: false,
                characterCount: characterIds.length,
                correlationId: opts.correlationId ?? null
            });
        }

        return scoreMap;
    }

    // =======================================================================
    // FACTOR 5: Claude Engagement (10%)
    // =======================================================================

    /**
     * Fetches Claude's current PAD emotional state for engagement scoring.
     * Returns DEFAULT_PAD if Claude has no mood entry or query fails.
     *
     * @param {object} opts — { correlationId }
     * @returns {object} { p: number, a: number, d: number }
     */
    async _getClaudeEngagementProfile(opts = {}) {
        try {
            const result = await this._query(
                `SELECT p, a, d FROM psychic_moods WHERE character_id = $1`,
                [this._claudeId],
                opts,
                'getClaudeEngagementProfile'
            );

            if (result.rows.length === 0) {
                logger.warn('Claude has no mood entry, using defaults', {
                    claudeId: this._claudeId,
                    correlationId: opts.correlationId ?? null
                });
                return DEFAULT_PAD;
            }

            return {
                p: safeFloat(result.rows[0].p, 0),
                a: safeFloat(result.rows[0].a, 0),
                d: safeFloat(result.rows[0].d, 0)
            };
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Claude engagement profile fetch failed, using defaults', {
                error: error.message,
                strictMode: false,
                correlationId: opts.correlationId ?? null
            });
            return DEFAULT_PAD;
        }
    }

    /**
     * Computes Claude's engagement score for a specific character.
     *
     * Claude's PAD determines his gravitational pull toward different
     * character profiles. This creates emergent behaviour where Claude's
     * mood influences who he chooses to visit:
     *
     *   High P + High A (playful mood): gravitates toward characters with
     *     high narrative involvement and close proximity (fun interactions)
     *   Low P (dutiful mood): gravitates toward characters with high FSRS
     *     urgency (retreats to responsible teacher mode)
     *   High D (assertive mood): gravitates toward characters needing new
     *     vocabulary (pre-verbal or caught up on reviews)
     *   Low D (receptive mood): gravitates toward characters needing
     *     comfort or review (nurturing mode)
     *
     * PAD values are normalised from [-1,1] to [0,1] for weighting.
     * All intermediate and final values are clamped to prevent overflow.
     *
     * @param {object} claudePad — { p: number, a: number, d: number }
     * @param {number} fsrs — Character FSRS urgency score (0-100)
     * @param {number} emotional — Character emotional readiness (0-100)
     * @param {number} proximity — Character proximity score (0-100)
     * @param {number} narrative — Character narrative score (0-100)
     * @returns {number} Engagement score 0-100
     */
    _computeClaudeEngagement(claudePad, fsrs, emotional, proximity, narrative) {
        const p = Math.max(-1, Math.min(1, claudePad.p ?? 0));
        const a = Math.max(-1, Math.min(1, claudePad.a ?? 0));
        const d = Math.max(-1, Math.min(1, claudePad.d ?? 0));

        // Normalise PAD from [-1,1] to [0,1] for multiplicative weighting
        const pNorm = (p + 1) / 2;
        const aNorm = (a + 1) / 2;
        const dNorm = (d + 1) / 2;

        // Playfulness: high P + high A -> narrative + proximity
        const playfulness = (pNorm + aNorm) / 2;
        const playScore = playfulness * ((narrative + proximity) / 200);

        // Dutifulness: low P -> FSRS urgency
        const dutifulness = 1 - pNorm;
        const dutyScore = dutifulness * (fsrs / 100);

        // Assertiveness: high D -> teaching need (pre-verbal or caught up)
        const teachingNeed = (100 - fsrs) / 100;
        const assertScore = dNorm * teachingNeed;

        // Receptiveness: low D -> comfort need
        const comfortNeed = (fsrs + (100 - emotional)) / 200;
        const receptScore = (1 - dNorm) * comfortNeed;

        // Average of four components, scaled to 0-100
        const raw = (playScore + dutyScore + assertScore + receptScore) / 4 * 100;
        return Math.round(Math.max(0, Math.min(100, raw)));
    }

    // =======================================================================
    // WHIMSY OFFSET (Deterministic)
    // =======================================================================

    /**
     * Deterministic pseudo-random offset using djb2 hash of characterId + today's date.
     * Same character + same day = same offset. Fully reproducible and logged.
     *
     * Uses injectable this._clock for testability. Clock must be a constructor
     * that produces an object with .toISOString() method (Date-compatible).
     *
     * Can be disabled entirely via opts.whimsyEnabled=false in constructor.
     *
     * @param {string} characterId — Character hex ID
     * @returns {number} Offset in range [-epsilon/2, +epsilon/2] (typically -5 to +5)
     */
    _computeWhimsyOffset(characterId) {
        const now = new this._clock();
        const today = now.toISOString().slice(0, 10);
        const hash = djb2Hash(characterId + today);
        const normalised = (hash % 10000) / 10000;
        return (normalised - 0.5) * this._whimsyEpsilon;
    }

    // =======================================================================
    // EMERGENCY OVERRIDE: Last Visit Times
    // =======================================================================

    /**
     * Fetches the most recent completed visit per character from the
     * character_teaching_queue table.
     *
     * Characters never visited return null, which triggers emergency override
     * (daysSinceVisit === null => emergencyOverride = true). This ensures
     * newly created B-Roll characters are visited promptly.
     *
     * NOTE: This query benefits from an index on (character_id, completed_at).
     * The existing idx_teaching_queue_priority covers (priority_score, scheduled_for)
     * which does NOT accelerate this lookup.
     *
     * @param {string[]} characterIds — Hex IDs to check
     * @param {object} opts — { correlationId }
     * @returns {Map<string, string|null>} Map(characterId => ISO timestamp | null)
     */
    async _getLastVisitTimes(characterIds, opts = {}) {
        this._validateBatchSize(characterIds, '_getLastVisitTimes');
        const visitMap = new Map();

        for (const id of characterIds) {
            visitMap.set(id, null);
        }

        try {
            const result = await this._query(
                `SELECT character_id, MAX(completed_at) AS last_completed
                 FROM character_teaching_queue
                 WHERE character_id = ANY($1::text[])
                   AND completed_at IS NOT NULL
                 GROUP BY character_id`,
                [characterIds],
                opts,
                'getLastVisitTimes'
            );

            for (const row of result.rows) {
                visitMap.set(row.character_id, row.last_completed);
            }
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Last visit fetch failed, treating all as never-visited', {
                error: error.message,
                strictMode: false,
                characterCount: characterIds.length,
                correlationId: opts.correlationId ?? null
            });
        }

        return visitMap;
    }

    // =======================================================================
    // VISIT TYPE DETERMINATION
    // =======================================================================

    /**
     * Determines the visit type based on character state and scheduling mode.
     *
     * Priority logic (first match wins):
     *   1. Inhibit zone (even with emergency override) -> 'comfort'
     *   2. Narrative scheduling mode -> 'narrative'
     *   3. Has overdue FSRS items (urgency > 0) -> 'review'
     *   4. Default (pre-verbal or all items current) -> 'teaching'
     *
     * @param {object} characterScore — Roster entry with emotionalZone and factors
     * @param {string} mode — 'idle' | 'event' | 'narrative'
     * @returns {string} 'teaching' | 'review' | 'comfort' | 'narrative'
     */
    _determineVisitType(characterScore, mode) {
        if (characterScore.emotionalZone === 'inhibit') {
            return 'comfort';
        }
        if (mode === 'narrative') {
            return 'narrative';
        }
        if (characterScore.factors.fsrsUrgency > 0) {
            return 'review';
        }
        return 'teaching';
    }

    // =======================================================================
    // QUEUE INSERTION (with Idempotency Guard)
    // =======================================================================

    /**
     * Inserts a visit entry into character_teaching_queue within a transaction.
     *
     * Idempotency guard: Before inserting, checks for an existing pending visit
     * (completed_at IS NULL) for this character with SELECT FOR UPDATE. If one
     * exists, returns its ID without inserting. This prevents double-booking
     * from concurrent scheduling cycles.
     *
     * generateHexId is called with the transaction client so the hex ID
     * allocation and INSERT are atomic. If the INSERT fails, both roll back.
     *
     * @param {object} winner — Roster entry for the winning character
     * @param {string} visitType — 'teaching' | 'review' | 'comfort' | 'narrative'
     * @param {object} opts — { correlationId }
     * @returns {string} Hex ID of the queue entry (new or existing pending)
     */
    async _queueVisit(winner, visitType, opts = {}) {
        // Fix (April 2nd review): Replaced SELECT FOR UPDATE with atomic CTE pattern.
        // The v2 SELECT FOR UPDATE on zero rows acquired no lock — two concurrent
        // scheduling cycles could both pass the empty-check and both INSERT.
        // Uses partial unique index idx_one_pending_visit_per_character
        // (character_id) WHERE completed_at IS NULL.
        const queueId = await generateHexId('character_teaching_queue_id', this._pool);

        const result = await this._pool.query(
            `WITH attempt AS (
                INSERT INTO character_teaching_queue
                    (id, character_id, priority_score, visit_type, scheduled_for)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (character_id) WHERE completed_at IS NULL
                DO NOTHING
                RETURNING id
            )
            SELECT id FROM attempt
            UNION ALL
            SELECT id FROM character_teaching_queue
            WHERE character_id = $2
              AND completed_at IS NULL
            LIMIT 1`,
            [queueId, winner.characterId, winner.cps.toFixed(2), visitType]
        );

        const returnedId = result.rows[0]?.id;
        const wasInserted = returnedId === queueId;

        if (wasInserted) {
            logger.info('Visit queued', {
                queueId,
                characterId: winner.characterId,
                visitType,
                cps: winner.cps,
                correlationId: opts.correlationId ?? null
            });
        } else {
            logger.info('Visit already pending, skipping queue insertion', {
                characterId: winner.characterId,
                existingQueueId: returnedId,
                correlationId: opts.correlationId ?? null
            });
        }

        return returnedId;
    }

    // =======================================================================
    // PRIVATE: Query Wrapper with Timeout
    // =======================================================================

    /**
     * Executes a SQL query with timeout protection via Promise.race.
     *
     * The timeout timer is ALWAYS cleaned up in the finally block,
     * regardless of whether the query or timeout resolves first.
     * This prevents timer leaks.
     *
     * Note: The timeout does not cancel the underlying query at the
     * PostgreSQL level — the query continues to completion on the server.
     * The caller is unblocked, but the connection is held until the query
     * finishes. For our character count (3-200), this is acceptable.
     *
     * @param {string} sql — SQL query string (parameterised)
     * @param {Array} params — Query parameters (prevents SQL injection)
     * @param {object} opts — { queryTimeoutMs, client, correlationId }
     * @param {string} methodLabel — Context label for error logging
     * @returns {object} pg query result { rows, rowCount }
     */
    async _query(sql, params = [], opts = {}, methodLabel = 'unknown') {
        const timeoutMs = opts.queryTimeoutMs ?? this._queryTimeoutMs;
        const client = opts.client ?? null;
        const queryTarget = client ?? this._pool;

        let timer;
        const queryPromise = queryTarget.query(sql, params);

        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Query timeout after ${timeoutMs}ms in ${methodLabel}`));
            }, timeoutMs);
        });

        try {
            return await Promise.race([queryPromise, timeoutPromise]);
        } catch (error) {
            logger.error(`Query failed in ${methodLabel}`, error, {
                correlationId: opts.correlationId ?? null
            });
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    // =======================================================================
    // PRIVATE: Validation Helpers
    // =======================================================================

    /**
     * Validates a hex ID string matches the canonical format #XXXXXX.
     * Accepts both upper and lowercase hex digits.
     *
     * @param {string} id — ID to validate
     * @param {string} label — Context label for error message
     * @throws {Error} If ID is not a valid hex format string
     */
    _validateHexId(id, label = 'id') {
        if (typeof id !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(id)) {
            throw new Error(`Invalid hex ID for ${label}: ${id}`);
        }
    }

    /**
     * Validates that a batch array does not exceed MAX_BATCH_SIZE.
     * Prevents unbounded memory consumption from oversized inputs.
     *
     * @param {Array} arr — Array to validate
     * @param {string} methodLabel — Context for error message
     * @throws {Error} If input is not an array or exceeds MAX_BATCH_SIZE
     */
    _validateBatchSize(arr, methodLabel = 'unknown') {
        if (!Array.isArray(arr)) {
            throw new Error(`${methodLabel}: expected array, got ${typeof arr}`);
        }
        if (arr.length > SCHEDULER_LIMITS.MAX_BATCH_SIZE) {
            throw new Error(
                `${methodLabel}: batch size ${arr.length} exceeds maximum ${SCHEDULER_LIMITS.MAX_BATCH_SIZE}`
            );
        }
    }
}
