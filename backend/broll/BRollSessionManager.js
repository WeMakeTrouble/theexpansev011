/**
 * ===========================================================================
 * BRollSessionManager.js — B-Roll Session Orchestrator
 * ===========================================================================
 *
 * PURPOSE:
 * Orchestrates a full Claude visit to a B-Roll character. Consumes visit
 * entries from character_teaching_queue (produced by ClaudeVisitationScheduler)
 * and runs the appropriate session type.
 *
 * DECOUPLING:
 * The session manager does NOT call ClaudeVisitationScheduler. The scheduler
 * queues visits. This file consumes them. Decoupled by design.
 *
 * SESSION TYPES:
 *   'teaching'  — Scaffolding Sandwich: review → introduce → trial → close
 *   'review'    — Review due items only, no new vocabulary
 *   'comfort'   — Emotional support only, no FSRS progress
 *   'narrative'  — Narrative-triggered, may include light teaching
 *
 * SCAFFOLDING SANDWICH (Spec Section 9.1):
 * Based on Wood, Bruner & Ross (1976) scaffolding theory and Sweller (1988)
 * cognitive load theory. Every teaching session follows:
 *   1. Review — High-retention items build confidence (increases Pleasure)
 *   2. Introduction — One new WORD, PIVOT, or OPERATOR
 *   3. Production Trial — Prompt character to use new item
 *   4. Closure — Claude acknowledges effort (increases Dominance)
 *
 * EMOTIONAL CONTAGION (Spec Section 4.4):
 * When Claude arrives, emotional contagion occurs BEFORE teaching begins.
 * Uses the Bosse-Treur / Hatfield model from the Psychic Engine:
 *   delta_PAD = (PAD_Claude - PAD_char) * (1 - distance) * CONTAGION_RATE * resonance
 * Post-contagion PAD is re-evaluated against Yerkes-Dodson gate.
 * Each teaching turn can apply another contagion step, shifting PAD gradually.
 *
 * CONTAGION AXIS WEIGHTS (Cikara et al. 2014):
 *   Positive resonance: standard contagion on all axes
 *   Negative resonance (schadenfreude):
 *     P-axis: INVERTS (their pain = our pleasure)
 *     A-axis: MIRRORS (arousal contagion persists)
 *     D-axis: PARTIALLY INVERTS (0.5x multiplier)
 *
 * SESSION PARAMETERS BY BELT (Spec Section 9.2):
 *   White:  3-4  turns, 1 new,   2-3 reviews
 *   Blue:   4-6  turns, 1-2 new, 3-4 reviews
 *   Purple: 6-8  turns, 1-2 new, 4-5 reviews
 *   Brown:  8-10 turns, 2 new,   6-8 reviews
 *   Black:  10-12 turns, 2-3 new, 8-10 reviews
 *
 * PRODUCTION TRIAL (Spec Section 7):
 * Words are not productive until successfully used in a prompted trial.
 * Outcome is deterministic based on retrievability + djb2 hash:
 *   R >= 0.80: 'good' (high confidence recall)
 *   R >= 0.60: 'hard' (uncertain recall)
 *   R >= 0.40: djb2-seeded threshold determines 'hard' or 'again'
 *   R <  0.40: 'again' (failed recall)
 *
 * CRITICAL: FSRS review for a production trial is recorded ONLY AFTER
 * vocabulary construction succeeds. If utterance construction fails,
 * the trial is not recorded — preventing data inconsistency where FSRS
 * shows a review but no utterance was produced. (v2 fix from Reviewer 3.)
 *
 * NARRATION MODES (Spec Section 12):
 *   ATMOSPHERIC — White belt user, describes behaviour without quoting
 *   PARAPHRASE  — Blue-Purple belt user, Claude paraphrases speech
 *   QUOTE       — Brown-Black belt user, direct quotes shown
 *
 * ===========================================================================
 * DESIGN DECISIONS (Documented for Review)
 * ===========================================================================
 *
 * SEQUENTIAL REVIEWS — INTENTIONAL TRADEOFF:
 * FSRS reviews are processed sequentially (not batched) because each
 * review outcome affects the character's PAD state for the NEXT turn.
 * A successful review boosts Pleasure, changing the emotional context
 * for subsequent reviews. This is the Scaffolding Sandwich: early
 * confidence-building reviews create the emotional foundation for
 * harder material later. Batching would break this pedagogical chain.
 * All four reviewers flagged this. It is acknowledged as a performance
 * tradeoff that preserves educational correctness.
 * At 3-12 turns per session with 3-50 characters, the sequential
 * latency (60-240ms) is acceptable for background processing.
 *
 * PAD WRITE CONSOLIDATION:
 * v1 wrote PAD to psychic_moods multiple times per session (after
 * contagion, after each review, at closure). Reviewers 1 and 2 flagged
 * write amplification. v2+ tracks PAD in memory throughout the session
 * and writes ONCE at session end. The only exception is the initial
 * contagion write, which persists immediately so the Psychic Radar
 * reflects Claude's arrival in real-time.
 *
 * ERROR HANDLING — DUAL PATH CLASSIFICATION:
 *   CRITICAL PATH (must succeed, always throws on failure):
 *     - Session claim (atomic UPDATE)
 *     - FSRS reviews and initialisations
 *     - Queue completion
 *   ENHANCEMENT PATH (graceful degradation, controlled by strictMode):
 *     - Emotional contagion
 *     - Utterance construction
 *     - Word selection
 *     - PAD fetch
 *   A failed contagion should not abort teaching. A failed FSRS write
 *   SHOULD abort because it corrupts the knowledge state.
 *
 * ===========================================================================
 * IDEMPOTENCY — ATOMIC CLAIM PATTERN (v3)
 * ===========================================================================
 *
 * v2 used SELECT FOR UPDATE → COMMIT → (session runs) → UPDATE completion.
 * Reviewer 4 identified a RACE CONDITION: the lock releases at COMMIT,
 * so two concurrent calls can both pass the check before either completes.
 * Both proceed to run full teaching sessions = double-teaching.
 *
 * v3 FIX: Single atomic UPDATE as a session claim:
 *
 *   UPDATE character_teaching_queue
 *   SET claude_report = 'SESSION_STARTED'
 *   WHERE id = $1
 *     AND completed_at IS NULL
 *     AND claude_report IS NULL
 *   RETURNING id
 *
 * If rowCount = 0: the entry was already claimed by another caller,
 * or already completed. No race window exists because the UPDATE is
 * a single atomic database operation with implicit row-level locking.
 *
 * claude_report is NULL on fresh entries, set to 'SESSION_STARTED'
 * during the session, then overwritten with the real report at
 * completion. This requires NO schema changes — uses existing columns.
 *
 * This pattern is equivalent to an atomic compare-and-swap (CAS):
 *   CAS(claude_report, NULL, 'SESSION_STARTED')
 * Used extensively in distributed systems (DynamoDB conditional writes,
 * Redis SETNX, Postgres advisory locks). Our version is simpler because
 * we only need single-row atomicity, which Postgres guarantees.
 *
 * ===========================================================================
 *
 * DEPENDENCIES:
 *   - FSRSMultiLearner (getDueItems, processReview, initializeVocabularyItem,
 *     getProductiveCounts)
 *   - VocabularyConstructor (constructUtterance)
 *   - DevelopmentalStageClassifier (classifyStage)
 *   - pool (PostgreSQL connection)
 *   - logger (createModuleLogger)
 *   - generateHexId (utterance logging)
 *
 * DATABASE INDEX RECOMMENDATIONS:
 *   - vocabulary_dictionary: compound index on
 *     (belt_name, context_scope, teaching_priority) WHERE is_active = true
 *   - character_teaching_queue: index on (character_id, completed_at)
 *     for last-visit-time queries in ClaudeVisitationScheduler
 *
 * REVIEW HISTORY:
 *   v1 — Initial implementation, March 2026
 *     Reviewer 1: 95/100 — P1: archetype stub, PAD write amplification
 *     Reviewer 2: 86/100 — P0: no concurrency guard, silent error handling
 *     Reviewer 3: 72/100 — P0: no idempotency, trial/FSRS ordering bug,
 *       magic numbers, no enum validation
 *   v2 — All P0/P1 from v1 resolved. Reviewer 4: 82/100
 *     Remaining P0: race condition in idempotency guard (lock released
 *     before session runs, two concurrent calls can both pass check)
 *   v3 — Race condition eliminated:
 *     - Atomic claim pattern: single UPDATE with WHERE claude_report IS NULL
 *       replaces SELECT FOR UPDATE → COMMIT → (gap) → complete
 *     - No race window: Postgres row-level locking during UPDATE is atomic
 *     - No held connections: claim is instant, no long-lived transaction
 *     - No schema changes: uses existing claude_report column
 *     - Claim failure returns { alreadyClaimed: true } with existing entry
 *       details for logging and diagnostics
 *     - _acquireSessionLock replaced with _claimSession (clearer intent)
 *     - Completion UPDATE uses WHERE claude_report = 'SESSION_STARTED'
 *       as additional safety check — prevents stale completion writes
 *
 * ===========================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId from '../utils/hexIdGenerator.js';
import FSRSMultiLearner from './FSRSMultiLearner.js';
import VocabularyConstructor from './VocabularyConstructor.js';
import DevelopmentalStageClassifier from './DevelopmentalStageClassifier.js';

const logger = createModuleLogger('BRollSessionManager');

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const SESSION_PARAMS = Object.freeze({
    white:  { minTurns: 3, maxTurns: 4,  newItems: 1, reviewItems: 3  },
    blue:   { minTurns: 4, maxTurns: 6,  newItems: 1, reviewItems: 4  },
    purple: { minTurns: 6, maxTurns: 8,  newItems: 1, reviewItems: 5  },
    brown:  { minTurns: 8, maxTurns: 10, newItems: 2, reviewItems: 8  },
    black:  { minTurns: 10, maxTurns: 12, newItems: 2, reviewItems: 10 }
});

const VALID_VISIT_TYPES = Object.freeze(['teaching', 'review', 'comfort', 'narrative']);
const VALID_BELTS = Object.freeze(['white', 'blue', 'purple', 'brown', 'black']);

const CONTAGION_CONFIG = Object.freeze({
    RATE: 0.2,
    PROXIMITY_THRESHOLD: 0.5,
    CLOSURE_DOMINANCE_BOOST: 0.05,
    REVIEW_SUCCESS_PLEASURE_BOOST: 0.03,
    COMFORT_TURN_COUNT: 3,
    COMFORT_DEFAULT_DISTANCE: 0.3,
    COMFORT_DEFAULT_RESONANCE: 0.5
});

const TRIAL_THRESHOLDS = Object.freeze({
    GOOD_FLOOR: 0.80,
    HARD_FLOOR: 0.60,
    UNCERTAIN_FLOOR: 0.40
});

const NARRATION_MODES = Object.freeze({
    ATMOSPHERIC: 'ATMOSPHERIC',
    PARAPHRASE: 'PARAPHRASE',
    QUOTE: 'QUOTE'
});

const NARRATION_BELT_MAP = Object.freeze({
    white: NARRATION_MODES.ATMOSPHERIC,
    blue: NARRATION_MODES.PARAPHRASE,
    purple: NARRATION_MODES.PARAPHRASE,
    brown: NARRATION_MODES.QUOTE,
    black: NARRATION_MODES.QUOTE
});

const SCHEDULER_LIMITS = Object.freeze({
    DEFAULT_QUERY_TIMEOUT_MS: 5000,
    MAX_WORD_CANDIDATES: 50
});

const SESSION_CLAIM_MARKER = 'SESSION_STARTED';

const CLAUDE_CHARACTER_ID = '#700002';
const DEFAULT_PAD = Object.freeze({ p: 0, a: 0, d: 0 });

// ---------------------------------------------------------------------------
// UTILITY: Safe Number Parser
// ---------------------------------------------------------------------------

/**
 * Safely converts a value to a finite number.
 * Returns fallback if value is null, undefined, NaN, or Infinity.
 *
 * @param {*} value — Value to parse
 * @param {number} fallback — Default if not finite (default 0)
 * @returns {number} Guaranteed finite number
 */
function safeFloat(value, fallback = 0) {
    const num = parseFloat(value);
    return Number.isFinite(num) ? num : fallback;
}

// ---------------------------------------------------------------------------
// UTILITY: djb2 Hash
// ---------------------------------------------------------------------------

/**
 * djb2 hash for deterministic pseudo-random values.
 * Same implementation across all B-Roll files.
 *
 * @param {string} str — Input string
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
// UTILITY: PAD Clamp
// ---------------------------------------------------------------------------

/**
 * Clamps a PAD value to [-1, 1] matching psychic_moods numeric(4,3).
 *
 * @param {number} val
 * @returns {number} Clamped value
 */
function clampPad(val) {
    return Math.max(-1, Math.min(1, val));
}

// ---------------------------------------------------------------------------
// CLASS
// ---------------------------------------------------------------------------

export default class BRollSessionManager {

    /**
     * Creates a new BRollSessionManager instance.
     *
     * @param {object} opts
     * @param {object} opts.pool — PostgreSQL pool (injectable)
     * @param {FSRSMultiLearner} opts.fsrsMultiLearner — FSRS engine instance
     * @param {VocabularyConstructor} opts.vocabularyConstructor — System B instance
     * @param {object} opts.classifier — DevelopmentalStageClassifier instance
     * @param {string} opts.claudeCharacterId — Claude hex ID (default #700002)
     * @param {number} opts.queryTimeoutMs — Query timeout (default 5000)
     * @param {boolean} opts.strictMode — Fail-fast on enhancement-path errors
     *     (default false). Critical-path errors always throw regardless.
     * @param {function} opts.onSessionComplete — Callback after session finishes.
     *     Receives full session result. Errors in callback are caught and logged.
     * @param {object} opts.clock — Injectable clock constructor (Date-compatible).
     *     Must produce object with .toISOString() and .getTime() methods.
     */
    constructor(opts = {}) {
        this._pool = opts.pool ?? pool;
        this._fsrs = opts.fsrsMultiLearner ?? new FSRSMultiLearner(this._pool);
        this._vocab = opts.vocabularyConstructor ?? new VocabularyConstructor({ pool: this._pool });
        this._classifier = opts.classifier ?? new DevelopmentalStageClassifier();
        this._claudeId = opts.claudeCharacterId ?? CLAUDE_CHARACTER_ID;
        this._queryTimeoutMs = opts.queryTimeoutMs ?? SCHEDULER_LIMITS.DEFAULT_QUERY_TIMEOUT_MS;
        this._strictMode = opts.strictMode ?? false;
        this._onSessionComplete = opts.onSessionComplete ?? null;
        this._clock = opts.clock ?? Date;
    }

    // =======================================================================
    // PUBLIC: Run Session
    // =======================================================================

    /**
     * Runs a full session for a queued visit.
     *
     * Entry validation:
     *   - characterId and queueEntryId must be valid hex IDs
     *   - userBelt must be one of: white, blue, purple, brown, black
     *   - visitType must be one of: teaching, review, comfort, narrative
     *
     * Idempotency: Atomic claim via UPDATE WHERE claude_report IS NULL.
     * If already claimed, returns { alreadyClaimed: true }.
     *
     * @param {object} params
     * @param {string} params.characterId — B-Roll character hex ID
     * @param {string} params.visitType — 'teaching' | 'review' | 'comfort' | 'narrative'
     * @param {string} params.queueEntryId — Hex ID of queue entry to update
     * @param {string} params.userBelt — User's current belt for narration mode
     * @param {object} opts
     * @param {boolean} opts.debug — Include timing trace
     * @param {string} opts.correlationId — Log correlation
     * @returns {object} Full session result
     */
    async runSession(params, opts = {}) {
        const sessionStart = Date.now();
        const trace = opts.debug ? [] : null;
        const { characterId, visitType, queueEntryId, userBelt } = params;

        // --- Input validation ---
        this._validateHexId(characterId, 'characterId');
        this._validateHexId(queueEntryId, 'queueEntryId');
        this._validateEnum(visitType, VALID_VISIT_TYPES, 'visitType');
        this._validateEnum(userBelt, VALID_BELTS, 'userBelt');

        const narrationMode = NARRATION_BELT_MAP[userBelt];

        logger.info('Session started', {
            characterId, visitType, queueEntryId, userBelt, narrationMode,
            strictMode: this._strictMode,
            correlationId: opts.correlationId ?? null
        });

        // --- Atomic session claim (v3: race-condition-free) ---
        let stepStart = Date.now();
        const claimed = await this._claimSession(queueEntryId, opts);
        if (trace) trace.push({ step: 'claimSession', ms: Date.now() - stepStart });

        if (!claimed) {
            logger.info('Session already claimed or completed, skipping', {
                queueEntryId,
                correlationId: opts.correlationId ?? null
            });
            return {
                characterId,
                visitType,
                queueEntryId,
                alreadyClaimed: true,
                trace
            };
        }

        // --- Step 1: Fetch initial PAD states ---
        stepStart = Date.now();
        const claudePadBefore = await this._fetchPad(this._claudeId, opts);
        const charPadBefore = await this._fetchPad(characterId, opts);
        if (trace) trace.push({ step: 'fetchInitialPad', ms: Date.now() - stepStart });

        // --- Step 2: Apply initial emotional contagion (Claude → character) ---
        // This is the ONE mid-session PAD write. It persists immediately so the
        // Psychic Radar shows the emotional shift when Claude arrives.
        stepStart = Date.now();
        const postContagionPad = await this._applyEmotionalContagion(
            this._claudeId, characterId, claudePadBefore, charPadBefore, opts
        );
        if (trace) trace.push({ step: 'initialContagion', ms: Date.now() - stepStart });

        // --- Step 3: Re-evaluate Yerkes-Dodson gate on post-contagion PAD ---
        const postContagionZone = this._classifyEmotionalZone(postContagionPad);
        let effectiveVisitType = visitType;

        if (postContagionZone === 'inhibit' && visitType !== 'comfort') {
            logger.info('Post-contagion PAD still inhibited, switching to comfort', {
                characterId,
                originalVisitType: visitType,
                postContagionPad,
                correlationId: opts.correlationId ?? null
            });
            effectiveVisitType = 'comfort';
        } else if (visitType === 'comfort' && postContagionZone !== 'inhibit') {
            logger.info('Post-contagion PAD moved to optimal, upgrading to teaching', {
                characterId,
                postContagionZone,
                correlationId: opts.correlationId ?? null
            });
            effectiveVisitType = 'teaching';
        }

        // --- Step 4: Run the session type ---
        // All session methods track PAD in memory and return finalPad.
        // PAD is written to DB once at session end (Step 5).
        stepStart = Date.now();
        let sessionResult;

        switch (effectiveVisitType) {
            case 'teaching':
                sessionResult = await this._runTeachingSession(
                    characterId, postContagionPad, claudePadBefore, userBelt, narrationMode, trace, opts
                );
                break;
            case 'review':
                sessionResult = await this._runReviewSession(
                    characterId, postContagionPad, claudePadBefore, userBelt, narrationMode, trace, opts
                );
                break;
            case 'comfort':
                sessionResult = await this._runComfortSession(
                    characterId, postContagionPad, claudePadBefore, narrationMode, trace, opts
                );
                break;
            case 'narrative':
                sessionResult = await this._runNarrativeSession(
                    characterId, postContagionPad, claudePadBefore, userBelt, narrationMode, trace, opts
                );
                break;
            default:
                throw new Error(`Unknown visit type: ${effectiveVisitType}`);
        }

        if (trace) trace.push({ step: 'runSessionType', ms: Date.now() - stepStart, type: effectiveVisitType });

        // --- Step 5: Write final PAD state (single consolidated write) ---
        stepStart = Date.now();
        await this._writePad(characterId, sessionResult.finalPad, opts);
        if (trace) trace.push({ step: 'writeFinalPad', ms: Date.now() - stepStart });

        // --- Step 6: Read Claude's final PAD ---
        const claudePadAfter = await this._fetchPad(this._claudeId, opts);

        // --- Step 7: Complete the visit (update queue entry) ---
        // Uses WHERE claude_report = SESSION_CLAIM_MARKER as safety check.
        stepStart = Date.now();
        await this._completeVisit(queueEntryId, {
            sessionTurns: sessionResult.turns.length,
            newItemsTaught: sessionResult.newItemsTaught,
            itemsReviewed: sessionResult.itemsReviewed,
            claudePadBefore,
            claudePadAfter,
            charPadBefore,
            charPadAfter: sessionResult.finalPad,
            claudeReport: sessionResult.claudeReport
        }, opts);
        if (trace) trace.push({ step: 'completeVisit', ms: Date.now() - stepStart });

        const totalMs = Date.now() - sessionStart;
        if (trace) trace.push({ step: 'total', ms: totalMs });

        const fullResult = {
            characterId,
            visitType: effectiveVisitType,
            originalVisitType: visitType,
            queueEntryId,
            narrationMode,
            turns: sessionResult.turns,
            newItemsTaught: sessionResult.newItemsTaught,
            itemsReviewed: sessionResult.itemsReviewed,
            padTrajectory: {
                claudeBefore: claudePadBefore,
                claudeAfter: claudePadAfter,
                characterBefore: charPadBefore,
                characterAfterContagion: postContagionPad,
                characterAfter: sessionResult.finalPad
            },
            claudeReport: sessionResult.claudeReport,
            totalMs,
            trace
        };

        logger.info('Session complete', {
            characterId,
            visitType: effectiveVisitType,
            turns: sessionResult.turns.length,
            newItemsTaught: sessionResult.newItemsTaught,
            itemsReviewed: sessionResult.itemsReviewed,
            totalMs,
            correlationId: opts.correlationId ?? null
        });

        if (typeof this._onSessionComplete === 'function') {
            try {
                this._onSessionComplete(fullResult);
            } catch (cbErr) {
                logger.warn('onSessionComplete callback error', { error: cbErr.message });
            }
        }

        return fullResult;
    }

    // =======================================================================
    // PRIVATE: Atomic Session Claim (v3 — Race-Condition-Free)
    // =======================================================================

    /**
     * Atomically claims a queue entry for processing.
     *
     * Uses a single UPDATE with WHERE constraints as an atomic CAS
     * (compare-and-swap) operation. Postgres guarantees row-level locking
     * during UPDATE, so no two callers can claim the same entry.
     *
     * Claim conditions (ALL must be true):
     *   - Entry exists (id matches)
     *   - Not yet completed (completed_at IS NULL)
     *   - Not yet claimed (claude_report IS NULL)
     *
     * On success: claude_report is set to SESSION_CLAIM_MARKER.
     * On failure (rowCount = 0): entry was already claimed or completed.
     *
     * The completion step (_completeVisit) additionally checks
     * WHERE claude_report = SESSION_CLAIM_MARKER before overwriting,
     * ensuring only the claimer can complete the session.
     *
     * @param {string} queueEntryId — Hex ID of the queue entry
     * @param {object} opts — { correlationId }
     * @returns {boolean} true if claimed successfully, false if already taken
     */
    async _claimSession(queueEntryId, opts = {}) {
        try {
            const result = await this._query(
                `UPDATE character_teaching_queue
                 SET claude_report = $2
                 WHERE id = $1
                   AND completed_at IS NULL
                   AND claude_report IS NULL
                 RETURNING id`,
                [queueEntryId, SESSION_CLAIM_MARKER],
                opts,
                'claimSession'
            );

            if (result.rowCount === 0) {
                return false;
            }

            logger.debug('Session claimed', {
                queueEntryId,
                correlationId: opts.correlationId ?? null
            });

            return true;

        } catch (error) {
            logger.error('Session claim failed', error, {
                queueEntryId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    // =======================================================================
    // PRIVATE: Teaching Session (Scaffolding Sandwich)
    // =======================================================================

    /**
     * Runs a full teaching session: review → introduce → trial → close.
     * Parameters (turns, new items, review count) determined by character belt.
     *
     * PAD is tracked IN MEMORY and returned as finalPad. The caller writes
     * it to DB once. This eliminates write amplification.
     *
     * FSRS reviews are SEQUENTIAL BY DESIGN — see header documentation
     * for the pedagogical justification. Each review outcome affects the
     * character's emotional state for the next turn (Scaffolding Sandwich).
     *
     * @param {string} characterId
     * @param {object} charPad — Post-contagion PAD
     * @param {object} claudePad — Claude's PAD
     * @param {string} userBelt — User's belt for narration
     * @param {string} narrationMode — ATMOSPHERIC | PARAPHRASE | QUOTE
     * @param {Array|null} trace — Debug trace
     * @param {object} opts
     * @returns {object} { turns, newItemsTaught, itemsReviewed, claudeReport, finalPad }
     */
    async _runTeachingSession(characterId, charPad, claudePad, userBelt, narrationMode, trace, opts = {}) {
        const turns = [];
        let itemsReviewed = 0;
        let newItemsTaught = 0;
        let currentPad = { ...charPad };

        const counts = await this._fsrs.getProductiveCounts(characterId, opts);
        const classification = DevelopmentalStageClassifier(counts);
        const beltName = (classification.belt && classification.belt !== 'none') ? classification.belt : 'white';
        const sessionParams = SESSION_PARAMS[beltName] ?? SESSION_PARAMS.white;

        // Phase 1: Review (sequential — pedagogical chain, see header)
        const reviewStart = Date.now();
        const dueItems = await this._fsrs.getDueItems(
            characterId, sessionParams.reviewItems, opts
        );

        for (const item of dueItems) {
            const trialResult = this._determineTrialOutcome(
                characterId, item.knowledge_id, safeFloat(item.current_retrievability, 0.5)
            );

            await this._fsrs.processReview(characterId, item.knowledge_id, trialResult.rating, {
                correlationId: opts.correlationId
            });

            if (trialResult.rating === 'good' || trialResult.rating === 'easy') {
                currentPad = {
                    p: clampPad(currentPad.p + CONTAGION_CONFIG.REVIEW_SUCCESS_PLEASURE_BOOST),
                    a: currentPad.a,
                    d: currentPad.d
                };
            }

            turns.push({
                turnNumber: turns.length + 1,
                phase: 'review',
                knowledgeId: item.knowledge_id,
                knowledgeType: item.knowledge_type,
                rating: trialResult.rating,
                retrievabilityBefore: safeFloat(item.current_retrievability, 0),
                padSnapshot: { ...currentPad }
            });
            itemsReviewed++;
        }

        if (trace) trace.push({ step: 'reviewPhase', ms: Date.now() - reviewStart, reviewed: itemsReviewed });

        // Phase 2: Introduction
        const introStart = Date.now();
        const wordsToTeach = await this._selectNextWords(
            characterId, beltName, sessionParams.newItems, opts
        );

        for (const word of wordsToTeach) {
            await this._fsrs.initializeVocabularyItem(characterId, word.id, {
                correlationId: opts.correlationId
            });

            turns.push({
                turnNumber: turns.length + 1,
                phase: 'introduction',
                knowledgeId: word.id,
                knowledgeType: word.knowledge_type,
                lemma: word.lemma,
                definition: word.definition,
                padSnapshot: { ...currentPad }
            });
            newItemsTaught++;
        }

        if (trace) trace.push({ step: 'introductionPhase', ms: Date.now() - introStart, taught: newItemsTaught });

        // Phase 3: Production trial (FSRS recorded ONLY after utterance succeeds)
        const trialStart = Date.now();
        for (const word of wordsToTeach) {
            const productionResult = await this._attemptProduction(
                characterId, word, currentPad, userBelt, narrationMode, opts
            );

            turns.push({
                turnNumber: turns.length + 1,
                phase: 'trial',
                knowledgeId: word.id,
                lemma: word.lemma,
                utterance: productionResult.utterance,
                narration: productionResult.narration,
                trialSuccess: productionResult.success,
                rating: productionResult.rating,
                fsrsRecorded: productionResult.fsrsRecorded,
                padSnapshot: { ...currentPad }
            });
        }

        if (trace) trace.push({ step: 'trialPhase', ms: Date.now() - trialStart });

        // Phase 4: Closure
        currentPad = {
            p: currentPad.p,
            a: currentPad.a,
            d: clampPad(currentPad.d + CONTAGION_CONFIG.CLOSURE_DOMINANCE_BOOST)
        };

        turns.push({
            turnNumber: turns.length + 1,
            phase: 'closure',
            padSnapshot: { ...currentPad }
        });

        const claudeReport = this._generateClaudeReport(
            'teaching', characterId, itemsReviewed, newItemsTaught, turns, beltName
        );

        return { turns, newItemsTaught, itemsReviewed, claudeReport, finalPad: currentPad };
    }

    // =======================================================================
    // PRIVATE: Review Session
    // =======================================================================

    /**
     * Review-only session. No new vocabulary. PAD tracked in memory.
     *
     * @param {string} characterId
     * @param {object} charPad
     * @param {object} claudePad
     * @param {string} userBelt
     * @param {string} narrationMode
     * @param {Array|null} trace
     * @param {object} opts
     * @returns {object} { turns, newItemsTaught, itemsReviewed, claudeReport, finalPad }
     */
    async _runReviewSession(characterId, charPad, claudePad, userBelt, narrationMode, trace, opts = {}) {
        const turns = [];
        let itemsReviewed = 0;
        let currentPad = { ...charPad };

        const counts = await this._fsrs.getProductiveCounts(characterId, opts);
        const classification = DevelopmentalStageClassifier(counts);
        const beltName = (classification.belt && classification.belt !== 'none') ? classification.belt : 'white';
        const sessionParams = SESSION_PARAMS[beltName] ?? SESSION_PARAMS.white;

        const dueItems = await this._fsrs.getDueItems(
            characterId, sessionParams.reviewItems, opts
        );

        for (const item of dueItems) {
            const trialResult = this._determineTrialOutcome(
                characterId, item.knowledge_id, safeFloat(item.current_retrievability, 0.5)
            );

            await this._fsrs.processReview(characterId, item.knowledge_id, trialResult.rating, {
                correlationId: opts.correlationId
            });

            if (trialResult.rating === 'good' || trialResult.rating === 'easy') {
                currentPad = {
                    p: clampPad(currentPad.p + CONTAGION_CONFIG.REVIEW_SUCCESS_PLEASURE_BOOST),
                    a: currentPad.a,
                    d: currentPad.d
                };
            }

            turns.push({
                turnNumber: turns.length + 1,
                phase: 'review',
                knowledgeId: item.knowledge_id,
                knowledgeType: item.knowledge_type,
                rating: trialResult.rating,
                retrievabilityBefore: safeFloat(item.current_retrievability, 0),
                padSnapshot: { ...currentPad }
            });
            itemsReviewed++;
        }

        currentPad = {
            p: currentPad.p,
            a: currentPad.a,
            d: clampPad(currentPad.d + CONTAGION_CONFIG.CLOSURE_DOMINANCE_BOOST)
        };

        turns.push({
            turnNumber: turns.length + 1,
            phase: 'closure',
            padSnapshot: { ...currentPad }
        });

        const claudeReport = this._generateClaudeReport(
            'review', characterId, itemsReviewed, 0, turns, beltName
        );

        return { turns, newItemsTaught: 0, itemsReviewed, claudeReport, finalPad: currentPad };
    }

    // =======================================================================
    // PRIVATE: Comfort Session
    // =======================================================================

    /**
     * Comfort session for inhibited characters. No FSRS, no vocabulary.
     * Claude provides emotional support through repeated contagion steps.
     * Uses real proximity data, not hardcoded values (v2+ fix).
     *
     * @param {string} characterId
     * @param {object} charPad
     * @param {object} claudePad
     * @param {string} narrationMode
     * @param {Array|null} trace
     * @param {object} opts
     * @returns {object} { turns, newItemsTaught, itemsReviewed, claudeReport, finalPad }
     */
    async _runComfortSession(characterId, charPad, claudePad, narrationMode, trace, opts = {}) {
        const turns = [];
        let currentPad = { ...charPad };

        const proximityData = await this._fetchDirectedProximity(
            this._claudeId, characterId, opts
        );
        const distance = proximityData.found
            ? proximityData.distance
            : CONTAGION_CONFIG.COMFORT_DEFAULT_DISTANCE;
        const resonance = proximityData.found
            ? proximityData.resonance
            : CONTAGION_CONFIG.COMFORT_DEFAULT_RESONANCE;

        for (let i = 0; i < CONTAGION_CONFIG.COMFORT_TURN_COUNT; i++) {
            currentPad = this._applyContagionStep(claudePad, currentPad, distance, resonance);

            turns.push({
                turnNumber: turns.length + 1,
                phase: 'comfort',
                dialogueFunction: 'expressive.comfort',
                padSnapshot: { ...currentPad }
            });
        }

        turns.push({
            turnNumber: turns.length + 1,
            phase: 'closure',
            padSnapshot: { ...currentPad }
        });

        const claudeReport = this._generateClaudeReport(
            'comfort', characterId, 0, 0, turns, null
        );

        return { turns, newItemsTaught: 0, itemsReviewed: 0, claudeReport, finalPad: currentPad };
    }

    // =======================================================================
    // PRIVATE: Narrative Session
    // =======================================================================

    /**
     * Narrative-triggered session. Light teaching if optimal, comfort if inhibited.
     *
     * @param {string} characterId
     * @param {object} charPad
     * @param {object} claudePad
     * @param {string} userBelt
     * @param {string} narrationMode
     * @param {Array|null} trace
     * @param {object} opts
     * @returns {object} { turns, newItemsTaught, itemsReviewed, claudeReport, finalPad }
     */
    async _runNarrativeSession(characterId, charPad, claudePad, userBelt, narrationMode, trace, opts = {}) {
        const zone = this._classifyEmotionalZone(charPad);

        if (zone === 'inhibit') {
            return this._runComfortSession(characterId, charPad, claudePad, narrationMode, trace, opts);
        }

        const turns = [];
        let itemsReviewed = 0;
        let newItemsTaught = 0;
        let currentPad = { ...charPad };

        const dueItems = await this._fsrs.getDueItems(characterId, 1, opts);

        for (const item of dueItems) {
            const trialResult = this._determineTrialOutcome(
                characterId, item.knowledge_id, safeFloat(item.current_retrievability, 0.5)
            );

            await this._fsrs.processReview(characterId, item.knowledge_id, trialResult.rating, {
                correlationId: opts.correlationId
            });

            if (trialResult.rating === 'good' || trialResult.rating === 'easy') {
                currentPad = {
                    p: clampPad(currentPad.p + CONTAGION_CONFIG.REVIEW_SUCCESS_PLEASURE_BOOST),
                    a: currentPad.a,
                    d: currentPad.d
                };
            }

            turns.push({
                turnNumber: turns.length + 1,
                phase: 'review',
                knowledgeId: item.knowledge_id,
                rating: trialResult.rating,
                padSnapshot: { ...currentPad }
            });
            itemsReviewed++;
        }

        if (zone === 'optimal') {
            const counts = await this._fsrs.getProductiveCounts(characterId, opts);
            const classification = DevelopmentalStageClassifier(counts);
            const beltName = (classification.belt && classification.belt !== 'none') ? classification.belt : 'white';

            const wordsToTeach = await this._selectNextWords(characterId, beltName, 1, opts);

            for (const word of wordsToTeach) {
                await this._fsrs.initializeVocabularyItem(characterId, word.id, {
                    correlationId: opts.correlationId
                });

                turns.push({
                    turnNumber: turns.length + 1,
                    phase: 'introduction',
                    knowledgeId: word.id,
                    lemma: word.lemma,
                    padSnapshot: { ...currentPad }
                });
                newItemsTaught++;
            }
        }

        currentPad = {
            p: currentPad.p,
            a: currentPad.a,
            d: clampPad(currentPad.d + CONTAGION_CONFIG.CLOSURE_DOMINANCE_BOOST)
        };

        turns.push({
            turnNumber: turns.length + 1,
            phase: 'closure',
            padSnapshot: { ...currentPad }
        });

        const claudeReport = this._generateClaudeReport(
            'narrative', characterId, itemsReviewed, newItemsTaught, turns, null
        );

        return { turns, newItemsTaught, itemsReviewed, claudeReport, finalPad: currentPad };
    }

    // =======================================================================
    // PRIVATE: Emotional Contagion
    // =======================================================================

    /**
     * Applies emotional contagion from Claude to character on arrival.
     * Uses Bosse-Treur / Hatfield model from Psychic Engine.
     * Writes immediately to psychic_moods so Psychic Radar reflects arrival.
     *
     * @param {string} sourceId — Claude's hex ID
     * @param {string} targetId — Character hex ID
     * @param {object} sourcePad — { p, a, d }
     * @param {object} targetPad — { p, a, d }
     * @param {object} opts
     * @returns {object} Updated PAD { p, a, d }
     */
    async _applyEmotionalContagion(sourceId, targetId, sourcePad, targetPad, opts = {}) {
        try {
            const proximityData = await this._fetchDirectedProximity(sourceId, targetId, opts);

            if (!proximityData.found) {
                logger.debug('No directed proximity for contagion, PAD unchanged', {
                    sourceId, targetId,
                    correlationId: opts.correlationId ?? null
                });
                return { ...targetPad };
            }

            if (proximityData.distance >= CONTAGION_CONFIG.PROXIMITY_THRESHOLD) {
                logger.debug('Distance exceeds contagion threshold, PAD unchanged', {
                    sourceId, targetId,
                    distance: proximityData.distance,
                    threshold: CONTAGION_CONFIG.PROXIMITY_THRESHOLD,
                    correlationId: opts.correlationId ?? null
                });
                return { ...targetPad };
            }

            const updatedPad = this._applyContagionStep(
                sourcePad, targetPad, proximityData.distance, proximityData.resonance
            );

            await this._writePad(targetId, updatedPad, opts);

            logger.debug('Initial emotional contagion applied', {
                sourceId, targetId,
                distance: proximityData.distance,
                resonance: proximityData.resonance,
                padBefore: targetPad,
                padAfter: updatedPad,
                correlationId: opts.correlationId ?? null
            });

            return updatedPad;

        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Emotional contagion failed, PAD unchanged', {
                error: error.message,
                sourceId, targetId,
                correlationId: opts.correlationId ?? null
            });
            return { ...targetPad };
        }
    }

    /**
     * Fetches directed proximity between two characters.
     *
     * @param {string} fromId
     * @param {string} toId
     * @param {object} opts
     * @returns {object} { found: boolean, distance: number, resonance: number }
     */
    async _fetchDirectedProximity(fromId, toId, opts = {}) {
        try {
            const result = await this._query(
                `SELECT current_distance, emotional_resonance
                 FROM psychic_proximity_directed
                 WHERE from_character = $1 AND to_character = $2`,
                [fromId, toId],
                opts,
                'fetchDirectedProximity'
            );

            if (result.rows.length === 0) {
                return { found: false, distance: 1.0, resonance: 0 };
            }

            return {
                found: true,
                distance: safeFloat(result.rows[0].current_distance, 0.5),
                resonance: safeFloat(result.rows[0].emotional_resonance, 0.5)
            };
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Directed proximity fetch failed', {
                error: error.message, fromId, toId,
                correlationId: opts.correlationId ?? null
            });
            return { found: false, distance: 1.0, resonance: 0 };
        }
    }

    /**
     * Pure contagion step. Hatfield model with axis-specific resonance.
     * Matches Psychic Engine formula (engine.js lines 778-785).
     *
     * @param {object} sourcePad — { p, a, d }
     * @param {object} targetPad — { p, a, d }
     * @param {number} distance — 0-1 (lower = closer)
     * @param {number} resonance — Emotional resonance weight
     * @returns {object} Updated PAD { p, a, d }
     */
    _applyContagionStep(sourcePad, targetPad, distance, resonance) {
        const influence = (1 - distance) * CONTAGION_CONFIG.RATE;
        const isSchadenfreude = resonance < 0;
        const absResonance = Math.abs(resonance);

        const pWeight = isSchadenfreude ? absResonance * -1.0 : resonance;
        const aWeight = isSchadenfreude ? absResonance * 1.0 : resonance;
        const dWeight = isSchadenfreude ? absResonance * -0.5 : resonance;

        return {
            p: clampPad(targetPad.p + (sourcePad.p - targetPad.p) * influence * pWeight),
            a: clampPad(targetPad.a + (sourcePad.a - targetPad.a) * influence * aWeight),
            d: clampPad(targetPad.d + (sourcePad.d - targetPad.d) * influence * dWeight)
        };
    }

    // =======================================================================
    // PRIVATE: Production Trial
    // =======================================================================

    /**
     * Deterministic trial outcome based on retrievability. No Math.random().
     *
     * @param {string} characterId
     * @param {string} knowledgeId
     * @param {number} retrievability — 0-1
     * @returns {object} { rating: string, success: boolean }
     */
    _determineTrialOutcome(characterId, knowledgeId, retrievability) {
        if (retrievability >= TRIAL_THRESHOLDS.GOOD_FLOOR) {
            return { rating: 'good', success: true };
        }
        if (retrievability >= TRIAL_THRESHOLDS.HARD_FLOOR) {
            return { rating: 'hard', success: true };
        }
        if (retrievability >= TRIAL_THRESHOLDS.UNCERTAIN_FLOOR) {
            const hash = djb2Hash(characterId + knowledgeId + 'trial');
            const threshold = (hash % 1000) / 1000;
            const successChance = (retrievability - TRIAL_THRESHOLDS.UNCERTAIN_FLOOR)
                / (TRIAL_THRESHOLDS.HARD_FLOOR - TRIAL_THRESHOLDS.UNCERTAIN_FLOOR);
            if (threshold < successChance) {
                return { rating: 'hard', success: true };
            }
            return { rating: 'again', success: false };
        }
        return { rating: 'again', success: false };
    }

    /**
     * Attempts production and records FSRS ONLY after utterance succeeds.
     * Prevents data inconsistency (FSRS review without utterance).
     *
     * @param {string} characterId
     * @param {object} word — { id, lemma, knowledge_type, definition }
     * @param {object} currentPad
     * @param {string} userBelt
     * @param {string} narrationMode
     * @param {object} opts
     * @returns {object} { utterance, narration, success, rating, fsrsRecorded }
     */
    async _attemptProduction(characterId, word, currentPad, userBelt, narrationMode, opts = {}) {
        const trialResult = this._determineTrialOutcome(characterId, word.id, 1.0);

        let utterance = null;
        let narration = null;
        let fsrsRecorded = false;

        // Step 1: Utterance construction FIRST
        try {
            const vocabResult = await this._vocab.constructUtterance({
                characterId,
                dialogueFunctionFamily: 'expressive',
                pad: { pleasure: currentPad.p, arousal: currentPad.a, dominance: currentPad.d },
                userBelt
            }, { correlationId: opts.correlationId });

            utterance = vocabResult?.rawUtterance ?? null;
            narration = vocabResult?.narration ?? null;
        } catch (error) {
            logger.warn('Utterance construction failed, FSRS trial NOT recorded', {
                error: error.message,
                characterId, knowledgeId: word.id,
                correlationId: opts.correlationId ?? null
            });
            return { utterance: null, narration: null, success: false, rating: null, fsrsRecorded: false };
        }

        // Step 2: FSRS ONLY after utterance succeeded
        try {
            await this._fsrs.processReview(characterId, word.id, trialResult.rating, {
                correlationId: opts.correlationId
            });
            fsrsRecorded = true;
        } catch (error) {
            logger.error('FSRS trial recording failed after successful utterance', error, {
                characterId, knowledgeId: word.id, rating: trialResult.rating,
                correlationId: opts.correlationId ?? null
            });
            if (this._strictMode) throw error;
        }

        return {
            utterance,
            narration,
            success: trialResult.success,
            rating: trialResult.rating,
            fsrsRecorded
        };
    }

    // =======================================================================
    // PRIVATE: Word Selection
    // =======================================================================

    /**
     * Selects next word(s) to teach. Filters by belt, archetype, untaught.
     * v2+: resolves actual archetype, falls back to 'universal'.
     *
     * INDEX RECOMMENDATION: (belt_name, context_scope, teaching_priority)
     * WHERE is_active = true on vocabulary_dictionary.
     *
     * @param {string} characterId
     * @param {string} beltName
     * @param {number} count
     * @param {object} opts
     * @returns {object[]} Word entries from vocabulary_dictionary
     */
    async _selectNextWords(characterId, beltName, count, opts = {}) {
        try {
            const archetypeScope = await this._resolveArchetypeScope(characterId, opts);

            const result = await this._query(
                `SELECT vd.id, vd.lemma, vd.pos, vd.knowledge_type, vd.definition,
                        vd.semantic_tags, vd.personality_affinity, vd.context_scope
                 FROM vocabulary_dictionary vd
                 WHERE vd.belt_name = $1
                   AND vd.is_active = true
                   AND vd.context_scope IN ('universal', $3)
                   AND NOT EXISTS (
                       SELECT 1 FROM character_knowledge_state cks
                       WHERE cks.character_id = $2
                         AND cks.knowledge_id = vd.id
                   )
                 ORDER BY vd.teaching_priority ASC
                 LIMIT $4`,
                [beltName, characterId, archetypeScope, count],
                opts,
                'selectNextWords'
            );

            return result.rows;

        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('Word selection failed, returning empty', {
                error: error.message,
                characterId, beltName,
                correlationId: opts.correlationId ?? null
            });
            return [];
        }
    }

    /**
     * Resolves archetype scope for a character via inventory → objects → archetypes.
     * Falls back to 'universal' if no archetype found.
     *
     * @param {string} characterId
     * @param {object} opts
     * @returns {string} Archetype scope
     */
    async _resolveArchetypeScope(characterId, opts = {}) {
        try {
            const result = await this._query(
                `SELECT ba.archetype_id
                 FROM character_inventory ci
                 JOIN objects o ON o.object_id = ci.object_id
                 JOIN broll_archetypes ba ON ba.archetype_id = o.archetype_id
                 WHERE ci.character_id = $1
                 LIMIT 1`,
                [characterId],
                opts,
                'resolveArchetypeScope'
            );

            if (result.rows.length > 0 && result.rows[0].archetype_id) {
                return result.rows[0].archetype_id;
            }

            return 'universal';

        } catch (error) {
            logger.debug('Archetype scope resolution failed, using universal', {
                error: error.message, characterId,
                correlationId: opts.correlationId ?? null
            });
            return 'universal';
        }
    }

    // =======================================================================
    // PRIVATE: Emotional Zone Classification
    // =======================================================================

    /**
     * Classifies PAD into Yerkes-Dodson zone.
     * Same thresholds as ClaudeVisitationScheduler.
     *
     * @param {object} pad — { p, a, d }
     * @returns {string} 'inhibit' | 'soft_inhibit' | 'optimal'
     */
    _classifyEmotionalZone(pad) {
        if (pad.p < -0.5 || pad.a > 0.7) {
            return 'inhibit';
        }
        if (pad.p >= -0.5 && pad.p < -0.2) {
            return 'soft_inhibit';
        }
        return 'optimal';
    }

    // =======================================================================
    // PRIVATE: PAD Read/Write
    // =======================================================================

    /**
     * Fetches current PAD from psychic_moods.
     *
     * @param {string} characterId
     * @param {object} opts
     * @returns {object} { p, a, d }
     */
    async _fetchPad(characterId, opts = {}) {
        try {
            const result = await this._query(
                `SELECT p, a, d FROM psychic_moods WHERE character_id = $1`,
                [characterId],
                opts,
                'fetchPad'
            );

            if (result.rows.length === 0) {
                return { ...DEFAULT_PAD };
            }

            return {
                p: safeFloat(result.rows[0].p, 0),
                a: safeFloat(result.rows[0].a, 0),
                d: safeFloat(result.rows[0].d, 0)
            };
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('PAD fetch failed, using defaults', {
                error: error.message, characterId,
                correlationId: opts.correlationId ?? null
            });
            return { ...DEFAULT_PAD };
        }
    }

    /**
     * Writes PAD to psychic_moods. Values clamped to [-1, 1].
     *
     * @param {string} characterId
     * @param {object} pad — { p, a, d }
     * @param {object} opts
     */
    async _writePad(characterId, pad, opts = {}) {
        try {
            await this._query(
                `UPDATE psychic_moods
                 SET p = $2, a = $3, d = $4, updated_at = CURRENT_TIMESTAMP
                 WHERE character_id = $1`,
                [characterId, clampPad(pad.p), clampPad(pad.a), clampPad(pad.d)],
                opts,
                'writePad'
            );
        } catch (error) {
            if (this._strictMode) throw error;
            logger.warn('PAD write failed', {
                error: error.message, characterId,
                correlationId: opts.correlationId ?? null
            });
        }
    }

    // =======================================================================
    // PRIVATE: Visit Completion
    // =======================================================================

    /**
     * Updates queue entry with session results.
     * Uses WHERE claude_report = SESSION_CLAIM_MARKER as safety check,
     * ensuring only the original claimer can complete the session.
     *
     * @param {string} queueEntryId
     * @param {object} results
     * @param {object} opts
     */
    async _completeVisit(queueEntryId, results, opts = {}) {
        const client = await this._pool.connect();
        try {
            await client.query('BEGIN');

            const updateResult = await client.query(
                `UPDATE character_teaching_queue
                 SET completed_at = NOW(),
                     session_turns = $2,
                     new_items_taught = $3,
                     items_reviewed = $4,
                     claude_pad_before = $5,
                     claude_pad_after = $6,
                     character_pad_before = $7,
                     character_pad_after = $8,
                     claude_report = $9
                 WHERE id = $1
                   AND claude_report = $10`,
                [
                    queueEntryId,
                    results.sessionTurns,
                    results.newItemsTaught,
                    results.itemsReviewed,
                    JSON.stringify(results.claudePadBefore),
                    JSON.stringify(results.claudePadAfter),
                    JSON.stringify(results.charPadBefore),
                    JSON.stringify(results.charPadAfter),
                    results.claudeReport,
                    SESSION_CLAIM_MARKER
                ]
            );

            if (updateResult.rowCount === 0) {
                await client.query('ROLLBACK');
                logger.error('Visit completion failed: claim marker mismatch', {
                    queueEntryId,
                    expectedMarker: SESSION_CLAIM_MARKER,
                    correlationId: opts.correlationId ?? null
                });
                throw new Error(`Cannot complete session: queue entry ${queueEntryId} claim marker mismatch`);
            }

            await client.query('COMMIT');

            logger.info('Visit completed in queue', {
                queueEntryId,
                sessionTurns: results.sessionTurns,
                newItemsTaught: results.newItemsTaught,
                itemsReviewed: results.itemsReviewed,
                correlationId: opts.correlationId ?? null
            });

        } catch (error) {
            await client.query('ROLLBACK');
            if (!error.message.includes('claim marker mismatch')) {
                logger.error('Visit completion failed', error, {
                    queueEntryId,
                    correlationId: opts.correlationId ?? null
                });
            }
            throw error;
        } finally {
            client.release();
        }
    }

    // =======================================================================
    // PRIVATE: Claude Report
    // =======================================================================

    /**
     * Generates structured text report for admin review.
     *
     * @param {string} sessionType
     * @param {string} characterId
     * @param {number} itemsReviewed
     * @param {number} newItemsTaught
     * @param {object[]} turns
     * @param {string|null} beltName
     * @returns {string} Report text
     */
    _generateClaudeReport(sessionType, characterId, itemsReviewed, newItemsTaught, turns, beltName) {
        const lines = [];
        lines.push(`Session: ${sessionType}`);
        lines.push(`Character: ${characterId}`);
        if (beltName) lines.push(`Belt: ${beltName}`);
        lines.push(`Turns: ${turns.length}`);
        lines.push(`Items reviewed: ${itemsReviewed}`);
        lines.push(`New items taught: ${newItemsTaught}`);

        for (const turn of turns) {
            if (turn.phase === 'review') {
                lines.push(`  T${turn.turnNumber} [review] ${turn.knowledgeId} -> ${turn.rating}`);
            } else if (turn.phase === 'introduction') {
                lines.push(`  T${turn.turnNumber} [intro] ${turn.lemma ?? turn.knowledgeId}`);
            } else if (turn.phase === 'trial') {
                const status = turn.fsrsRecorded ? (turn.trialSuccess ? 'pass' : 'fail') : 'no-fsrs';
                lines.push(`  T${turn.turnNumber} [trial] ${turn.lemma ?? turn.knowledgeId} -> ${turn.rating ?? 'n/a'} (${status})`);
            } else if (turn.phase === 'comfort') {
                lines.push(`  T${turn.turnNumber} [comfort]`);
            } else if (turn.phase === 'closure') {
                lines.push(`  T${turn.turnNumber} [closure]`);
            }
        }

        return lines.join('\n');
    }

    // =======================================================================
    // STATIC: Narration Mode
    // =======================================================================

    /**
     * Returns narration mode for a user belt level.
     *
     * @param {string} userBelt
     * @returns {string} 'ATMOSPHERIC' | 'PARAPHRASE' | 'QUOTE'
     */
    static selectNarrationMode(userBelt) {
        return NARRATION_BELT_MAP[userBelt] ?? NARRATION_MODES.ATMOSPHERIC;
    }

    // =======================================================================
    // PRIVATE: Query Wrapper
    // =======================================================================

    /**
     * SQL with timeout. Timer always cleaned in finally.
     *
     * @param {string} sql
     * @param {Array} params
     * @param {object} opts
     * @param {string} methodLabel
     * @returns {object} Query result
     */
    async _query(sql, params = [], opts = {}, methodLabel = 'unknown') {
        const timeoutMs = opts.queryTimeoutMs ?? this._queryTimeoutMs;
        const queryTarget = opts.client ?? this._pool;

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
    // PRIVATE: Validation
    // =======================================================================

    /**
     * Validates hex ID format.
     *
     * @param {string} id
     * @param {string} label
     * @throws {Error} If invalid
     */
    _validateHexId(id, label = 'id') {
        if (typeof id !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(id)) {
            throw new Error(`Invalid hex ID for ${label}: ${id}`);
        }
    }

    /**
     * Validates a value against an allowed set.
     *
     * @param {string} value
     * @param {string[]} allowed
     * @param {string} label
     * @throws {Error} If not in allowed set
     */
    _validateEnum(value, allowed, label = 'value') {
        if (!allowed.includes(value)) {
            throw new Error(
                `Invalid ${label}: "${value}". Must be one of: ${allowed.join(', ')}`
            );
        }
    }
}
