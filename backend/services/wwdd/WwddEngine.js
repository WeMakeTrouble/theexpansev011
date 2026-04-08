/**
 * =============================================================================
 * WWDD ENGINE — What Would Danique Do
 * Session-Level Outcome Inference Instrument
 * Version: 1.3
 * =============================================================================
 *
 * PURPOSE:
 *   Infers a user's expected session outcome by accumulating conversational
 *   signals across turns. Tracks two constructs simultaneously:
 *
 *   CLARITY   — How confident the system is that it has correctly identified
 *               the user's session outcome. Starts at 0.0, rises as signals
 *               accumulate, may drop on strong repair or topic shift.
 *               Computed as the EMA-smoothed instantaneous dominance of the
 *               top hypothesis over competing hypotheses.
 *
 *   ALIGNMENT — How well the current session is tracking toward the inferred
 *               outcome. Only computed when Clarity >= 0.70 (commitment
 *               required to process feedback — Locke & Latham, 2002).
 *               Null below threshold — enforced structurally, not optionally.
 *
 * PHILOSOPHY:
 *   Named after Danique — a real person whose most powerful question is:
 *   "What is your expected outcome?"
 *
 *   The engine sits ABOVE the existing EarWig → BrainOrchestrator pipeline
 *   as a parallel per-session accumulator. It does not interrupt or modify
 *   the response pipeline. It reads the DiagnosticReport produced by EarWig
 *   each turn and updates its internal session model silently.
 *
 *   The user can open the gauge instrument at any time to see both readings
 *   live. The gauge does not tell you what to do. It reflects the session
 *   back to you.
 *
 * ARCHITECTURE:
 *   1. Input Validation     — Hex ID format + DiagnosticReport/convState guards
 *   2. Signal Extraction    — Reads EarWig DiagnosticReport fields
 *   3. Hypothesis Scoring   — Scores six outcome categories per turn
 *   4. Recency Weighting    — Blends current turn with weighted history
 *   5. Clarity Calculation  — Instantaneous hypothesis dominance, EMA-smoothed
 *   6. Alignment Calculation — Direction match vs active hypothesis, EMA-smoothed
 *   7. State Assembly       — Immutable frozen state object
 *   8. State Persistence    — UPSERT to wwdd_session_state once per turn
 *   9. Gauge State          — warming / tracking / surfacing
 *
 * GAUGE STATES:
 *   warming   — Clarity < 0.70. Not yet calibrated. Gauge shows warming animation.
 *   tracking  — Clarity >= 0.70. Both dials live. No outcome text surfaced.
 *   surfacing — Clarity >= 0.85. User may request inferred outcome text.
 *               Surfacing is ALWAYS user-initiated — never automatic.
 *
 * MODULE-LEVEL SINGLETON STATE:
 *   _globalSessionStates (Map) persists for the lifetime of the Node.js
 *   process. Survives panel mount/unmount in frontend. Explicitly reset on
 *   session end — NOT on panel close. TTL eviction runs every
 *   TTL_CLEANUP_INTERVAL_MS to prevent unbounded memory growth on sessions
 *   that never call endSession() (e.g. dropped connections, browser close).
 *
 * INTEGRATION POINT:
 *   Called by BrainOrchestrator after EarWig collation, before phase loop.
 *   Receives diagnosticReport, drClaudeOutput, convState.
 *   Does NOT modify turnState or response pipeline.
 *   Returns state snapshot for Socket.io emission by caller.
 *
 * DETERMINISTIC:
 *   Same inputs always produce same outputs. No ML. No external AI APIs.
 *   No Math.random() anywhere.
 *
 * =============================================================================
 *
 * REVIEW HISTORY:
 *
 *   v1.0 — Initial implementation. Five external reviewers, FAANG 2026 standards.
 *     Reviewer 1: 91/100 — EMA variable bug, recency decay bug
 *     Reviewer 2: 88/100 — Idempotency gap, hex validation gap
 *     Reviewer 3: 68/100 — processTurn decomposition, test hooks
 *     Reviewer 4: 94/100 — Architecture and research grounding praised
 *     Reviewer 5: 92/100 — Operational concerns, singleton scaling
 *     Average: 86.6/100 — Below threshold. Full rewrite required.
 *
 *   v1.1 — Full rewrite. All blocking v1.0 findings addressed.
 *     Reviewer 1: 84/100 — updateHypotheses density, test examples, clarity delta
 *     Reviewer 2: 93/100 — All fixes verified. Approved for production.
 *     Average: 88.5/100 — Below threshold. Rewrite required.
 *
 *   v1.2 — Targeted rewrite. All blocking v1.1 findings addressed.
 *     Reviewer 1: 91/100 — Four optional polish items identified
 *     Reviewer 2: 94/100 — At threshold. Approved for production.
 *     Average: 92.5/100 — At threshold but below target. One more rewrite.
 *
 *   PUSHBACKS ON REVIEW FINDINGS (established across all rounds, final):
 *
 *   TypeScript (all rounds, multiple reviewers):
 *     REJECTED. Vanilla JavaScript ES modules only. Reviewer 2 v1.2 accepted:
 *     "acceptable for vanilla JS codebase."
 *
 *   Metrics/observability instrumentation (all rounds):
 *     REJECTED for this version. Single-tenant narrative platform. Structured
 *     logging is our standard. Reviewer 2 v1.2 accepted: "risk acceptable
 *     for 75-100 users; revisit at 1000+." Future TODO noted in code.
 *
 *   Horizontal scaling / Redis / distributed state (all rounds):
 *     REJECTED. Explicitly single-tenant by design. Module-level singleton
 *     is correct for our architecture.
 *
 *   Config dynamism / runtime-configurable OUTCOME_CATEGORIES (all rounds):
 *     DEFERRED. Future calibration task. Noted in CONFIG comments.
 *
 *   Circuit breaker for DB pool (all rounds):
 *     DEFERRED. DB timeout (3000ms) + pool sizing sufficient at current scale.
 *
 *   ACCEPTED CORRECTIONS IN v1.3:
 *
 *   1. convState shape guard added (Reviewer 1, v1.2):
 *      Added typeof check on convState?.position to prevent silent string
 *      coercion failures from unexpected upstream shapes. Lightweight —
 *      matches isValidDiagnosticReport pattern established in v1.2.
 *
 *   2. Future metric TODO comment added (Reviewer 1, v1.2):
 *      One-line TODO in processTurn acknowledges future observability hook
 *      for clarity < 0.3 after turn 8. Does not implement metrics
 *      infrastructure — honest signal about scaling path.
 *
 *   3. Future calibration service comment added (Reviewer 1, v1.2):
 *      One-line Future comment in CONFIG acknowledges that OUTCOME_CATEGORIES
 *      and SIGNAL_WEIGHTS should eventually load from a calibration service.
 *      Does not implement — marks the architectural intent clearly.
 *
 *   4. Conditional clarity delta logging (Reviewer 1, v1.2):
 *      Delta only logged at debug level when |clarityDelta| > 0.05.
 *      Reduces log noise on stable sessions. High-signal-only pattern.
 *
 *   5. v1.3 review history section added to header.
 *
 * =============================================================================
 *
 * PEER-REVIEWED CITATIONS:
 *
 *   Bordin, E.S. (1979). "The generalizability of the psychoanalytic concept
 *     of the working alliance." Psychotherapy: Theory, Research & Practice,
 *     16(3), 252-260. DOI: 10.1037/h0085885
 *     USE: Theoretical foundation for Clarity (goal consensus) and Alignment
 *     (task agreement) as distinct but correlated constructs.
 *
 *   Horvath, A.O. & Greenberg, L.S. (1989). "Development and validation of
 *     the Working Alliance Inventory." Journal of Counseling Psychology,
 *     36(2), 223-233. DOI: 10.1037/0022-0167.36.2.223
 *     USE: WAI operationalises goal consensus. Goal subscale Cronbach's
 *     alpha = 0.93 (adolescent), 0.89 (clinician). Validates two-construct
 *     model of Clarity and Alignment.
 *
 *   Kiresuk, T.J. & Sherman, R.E. (1968). "Goal attainment scaling: A general
 *     method for evaluating comprehensive community mental health programs."
 *     Community Mental Health Journal, 4(6), 443-453.
 *     DOI: 10.1007/BF01530764
 *     USE: Goal Attainment Scaling as conceptual anchor for Clarity.
 *     Computational adaptation: Clarity = instantaneous hypothesis dominance
 *     smoothed by EMA. Novel adaptation — not direct GAS operationalisation.
 *     Requires validation.
 *
 *   Locke, E.A. & Latham, G.P. (2002). "Building a practically useful theory
 *     of goal setting and task motivation: A 35-year odyssey." American
 *     Psychologist, 57(9), 705-717. DOI: 10.1037/0003-066X.57.9.705
 *     USE: Goal commitment required for feedback to be effective. Structural
 *     constraint: Alignment = null when Clarity < 0.70. Note: the 0.70
 *     threshold is a design decision — not specified by Locke & Latham.
 *     Labelled: proposed — requires calibration.
 *     Also: showing inferred goal creates reactance if wrong. Surfacing is
 *     therefore always user-initiated.
 *
 *   Verduyn, P., Delvaux, E., Van Coillie, H., Tuerlinckx, F., & Van
 *     Mechelen, I. (2009). "Predicting the duration of emotional experience:
 *     Two experience sampling studies." Emotion, 9(1), 83-91.
 *     DOI: 10.1037/a0014610
 *     USE: EMA smoothing for trajectory tracking. Alpha decay constant reused
 *     from existing DrClaudeModule implementation.
 *
 *   Finger, R. & Bisantz, A.M. (2002). "Utilizing graphical formats to convey
 *     uncertainty in a decision-making task." Theoretical Issues in Ergonomics
 *     Science, 3(1), 1-25. DOI: 10.1080/14639220110110324
 *     USE: Analog needle gauges outperform numeric readouts for uncertainty.
 *     NOTE: Cited via Gemini research response — requires direct verification
 *     against original paper before production use.
 *
 *   Lee, J.D. & See, K.A. (2004). "Trust in automation: Designing for
 *     appropriate reliance." Human Factors, 46(1), 50-80.
 *     DOI: 10.1518/hfes.46.1.50_30392
 *     USE: Transparency of process more important than accuracy of outcome
 *     for trust calibration.
 *
 *   Jurafsky, D. & Martin, J.H. (2023). Speech and Language Processing
 *     (3rd ed. draft). Stanford University.
 *     https://web.stanford.edu/~jurafsky/slp3/
 *     USE: Dialogue Acts as core predictors of conversational goals.
 *
 *   Google People + AI Research (PAIR). (2019). People + AI Guidebook.
 *     https://pair.withgoogle.com/guidebook
 *     USE: Graded confidence displays preferred over binary or numeric.
 *     Surfacing inferred goals respects user agency — always user-initiated.
 *
 *   Traum, D. (1999). "Speech acts for dialogue agents." In Foundations of
 *     Rational Agency. Springer. DOI: 10.1007/978-94-015-9204-8_19
 *     USE: Intent inference stabilisation across turns. Suggests 5-8 turns.
 *     Conflicts with Kimi synthesis (4 turns). MAX_TURN_HISTORY = 6 is
 *     a compromise — proposed, requires calibration.
 *
 *   Henderson, M., Thomson, B., & Young, S. (2014). "Word-based dialog state
 *     tracking with recurrent neural networks." Proceedings of SIGDIAL.
 *     USE: Dialogue state tracking. Cited alongside Traum (1999) as evidence
 *     for 5-8 turn stabilisation window.
 *
 * =============================================================================
 *
 * MIT-LICENSED REFERENCE IMPLEMENTATIONS:
 *
 *   gauge.js (bernii/gauge.js)
 *     Repository: https://github.com/bernii/gauge.js
 *     License: MIT (confirmed in README and package metadata)
 *     USE: Canvas-based analog gauge rendering reference for frontend.
 *
 *   Substate (tamb/substate)
 *     Repository: https://github.com/tamb/substate
 *     License: MIT
 *     USE: Pub/Sub pattern with immutable updates — reference for singleton
 *     state architecture pattern.
 *
 * =============================================================================
 *
 * CALIBRATION STATUS:
 *   All weights, thresholds, and decay constants in CONFIG are labelled
 *   "proposed — requires calibration" unless explicitly marked evidence-backed.
 *
 *   Recommended calibration path (Reviewer 4, v1.0 methodology):
 *   1. Collect anonymised session logs (target: 1000+ sessions)
 *   2. Have human experts label actual session outcome per session
 *   3. Run WwddEngine in dry-run mode against logs
 *   4. Compare activeHypothesis at turn 4-8 against human labels
 *   5. Adjust SIGNAL_WEIGHTS based on delta
 *   6. Re-evaluate CLARITY_DISPLAY_THRESHOLD and CLARITY_SURFACE_THRESHOLD
 *      against false-positive and false-negative rates
 *
 * SPEC REFERENCE:
 *   BLUEPRINT_WWDDEngine_v1.1.md
 *   V010_RESEARCH_BRIEF_Danique_Engine.md
 *
 * =============================================================================
 */

import pool from '../../db/pool.js';
import { createModuleLogger } from '../../utils/logger.js';
import { isValidHexId } from '../../utils/hexIdGenerator.js';

const logger = createModuleLogger('WwddEngine');

// =============================================================================
// MODULE-LEVEL SINGLETON STATE
// Persists for the lifetime of the Node.js process.
// Survives panel mount/unmount. Reset on session end via endSession().
// Never exported — private to this module only (prevents hidden dependencies).
// TTL eviction handles dropped connections and missed endSession() calls.
// =============================================================================

const _globalSessionStates = new Map();

// =============================================================================
// FROZEN CONFIGURATION
// All weights and thresholds are proposed unless marked evidence-backed.
// No magic numbers inline — all constants defined here.
//
// Future: load OUTCOME_CATEGORIES and SIGNAL_WEIGHTS from a calibration
// service or DB table to allow tuning without code redeploy. Deferred
// until ground truth session data exists to calibrate against.
// =============================================================================

const CONFIG = Object.freeze({

    // Turn history depth
    // Literature conflict: Kimi synthesis (4 turns) vs Traum (1999) and
    // Henderson et al. (2014) suggesting 5-8 turns for stabilisation.
    // Set to 6 as compromise — proposed, requires calibration.
    MAX_TURN_HISTORY: 6,

    // EMA decay constants (proposed — requires calibration)
    // Pattern: Verduyn et al. (2009), reused from DrClaudeModule
    CLARITY_ALPHA: 0.3,
    ALIGNMENT_BETA: 0.4,

    // Display and surfacing thresholds (proposed — requires calibration)
    // Note: numeric values are design decisions — not specified by
    // Locke & Latham (2002). Require calibration against session ground truth.
    CLARITY_DISPLAY_THRESHOLD: 0.70,
    CLARITY_SURFACE_THRESHOLD: 0.85,

    // Competition penalty: if top two hypotheses gap < this, Clarity penalised
    // Proposed — requires calibration
    HYPOTHESIS_COMPETITION_PENALTY: 0.15,

    // Recency decay: turnWeight(age) = RECENCY_DECAY ^ age
    // age 0 = current turn  → weight 1.0
    // age 1 = last turn     → weight 0.75
    // age 2 = two turns ago → weight 0.5625
    // Evidence-backed pattern: Kimi research synthesis (verified)
    RECENCY_DECAY: 0.75,

    // Session TTL — evict stale sessions from Map automatically
    // Handles dropped connections, browser close, missed endSession() calls
    SESSION_TTL_MS:          4 * 60 * 60 * 1000,   // 4 hours (proposed)
    TTL_CLEANUP_INTERVAL_MS: 5 * 60 * 1000,         // Check every 5 minutes

    // Signal weights — proposed, requires calibration
    // Recommended: collect 1000+ sessions, human-label outcomes, compare
    // activeHypothesis at turn 4-8, adjust weights based on delta.
    // Future: load from calibration service without code redeploy.
    SIGNAL_WEIGHTS: Object.freeze({
        COGNITIVE_FRAME:       0.25,
        REPAIR_SIGNAL:         0.20,
        CONVERSATION_POSITION: 0.15,
        PAD_TRAJECTORY:        0.15,
        LEARNING_SIGNAL:       0.10,
        QUD_DEPTH:             0.08,
        VOLATILITY:            0.05,
        CONSECUTIVE_NEGATIVE:  0.02
    }),

    // Outcome category definitions
    // Proposed taxonomy — requires validation against real session data.
    // Cognitive frame → outcome mapping is heuristic, not evidence-backed.
    // Future: load from calibration service to allow PM/research tuning
    // without code redeploy.
    OUTCOME_CATEGORIES: Object.freeze([
        {
            id: 'knowledge_seeking',
            name: 'Knowledge Seeking',
            frameMatch: ['factual'],
            requiresLearning: true,
            repairExpected: false
        },
        {
            id: 'emotional_processing',
            name: 'Emotional Processing',
            frameMatch: ['emotional'],
            padTrajectory: 'negative',
            repairExpected: true
        },
        {
            id: 'exploration',
            name: 'Exploration',
            frameMatch: ['philosophical'],
            qudDepthExpected: 'deep',
            repairExpected: false
        },
        {
            id: 'social_connection',
            name: 'Social Connection',
            frameMatch: ['social'],
            requiresLearning: false,
            repairExpected: false
        },
        {
            id: 'problem_resolution',
            name: 'Problem Resolution',
            frameMatch: ['factual', 'emotional'],
            repairExpected: true,
            padTrajectory: 'dominance_rising_pleasure_falling'
            // NOTE: PAD trajectory pattern proposed — requires verification
            // against Picard (1997) or alternative peer-reviewed source
        },
        {
            id: 'creative_play',
            name: 'Creative Play',
            frameMatch: ['playful'],
            repairExpected: false,
            padPleasureExpected: 'positive_stable'
        }
    ])
});

// =============================================================================
// TTL EVICTION — Prevent unbounded Map growth
// Runs on interval. Evicts sessions idle longer than SESSION_TTL_MS.
// unref() prevents interval from blocking clean Node.js process exit.
// =============================================================================

const _ttlCleanupInterval = setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [conversationId, state] of _globalSessionStates) {
        if (now - state.lastUpdate > CONFIG.SESSION_TTL_MS) {
            _globalSessionStates.delete(conversationId);
            evicted++;
            logger.info('WWDD: TTL eviction', {
                conversationId,
                idleMs: now - state.lastUpdate
            });
        }
    }
    if (evicted > 0) {
        logger.info('WWDD: TTL cleanup complete', {
            evicted,
            remaining: _globalSessionStates.size
        });
    }
}, CONFIG.TTL_CLEANUP_INTERVAL_MS);

if (_ttlCleanupInterval.unref) _ttlCleanupInterval.unref();

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * safeFloat — safe numeric extraction with explicit fallback
 * Prevents falsy-zero bugs. 0 is a valid PAD value — explicit check required.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function safeFloat(value, fallback = 0) {
    const n = parseFloat(value);
    return isFinite(n) ? n : fallback;
}

/**
 * deepFreeze — recursively freeze an object for immutability
 *
 * @param {Object} obj
 * @returns {Object}
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'object') deepFreeze(obj[key]);
    });
    return Object.freeze(obj);
}

/**
 * initUniformHypotheses — equal distribution across all categories
 *
 * @returns {Object} Frozen hypothesis scores
 */
function initUniformHypotheses() {
    const uniform = 1 / CONFIG.OUTCOME_CATEGORIES.length;
    const h = {};
    CONFIG.OUTCOME_CATEGORIES.forEach(cat => { h[cat.id] = uniform; });
    return Object.freeze(h);
}

/**
 * isValidDiagnosticReport — lightweight shape guard
 * Guards against null/non-object pipeline output that would otherwise
 * silently produce all-zero signals.
 *
 * @param {*} report
 * @returns {boolean}
 */
function isValidDiagnosticReport(report) {
    return report !== null && report !== undefined && typeof report === 'object';
}

/**
 * isValidConvState — lightweight shape guard on ConversationStateManager output
 * Guards against unexpected upstream shapes causing silent string coercion.
 * Checks position is a string — the field most likely to cause downstream issues.
 *
 * @param {*} convState
 * @returns {boolean}
 */
function isValidConvState(convState) {
    if (convState === null || convState === undefined) return true; // null is handled via fallbacks
    return typeof convState === 'object' &&
           (convState.position === undefined || typeof convState.position === 'string');
}

// =============================================================================
// SIGNAL EXTRACTION
// All DiagnosticReport field access is defensive with explicit fallbacks.
// Centralised here — one place to update if upstream schema changes.
// =============================================================================

/**
 * extractSignals — pull relevant fields from EarWig DiagnosticReport
 *
 * @param {Object} diagnosticReport - EarWig collation output
 * @param {Object} drClaudeOutput - DrClaudeModule output
 * @param {Object} convState - ConversationStateManager output
 * @returns {Object} Frozen normalised signal object
 */
function extractSignals(diagnosticReport, drClaudeOutput, convState) {
    return Object.freeze({
        cognitiveFrame: diagnosticReport?.rawModules?.cognitiveFrame?.classification
                     ?? diagnosticReport?.cognitiveFrame?.classification
                     ?? 'unknown',
        repairTriggered: !!(
            diagnosticReport?.rawModules?.repair?.repairTriggered
            ?? diagnosticReport?.repairHandler?.repairTriggered
        ),
        conversationPosition: convState?.position ?? 'opening',
        padTrajectory:        drClaudeOutput?.trajectory ?? 'stable',
        padPleasure:          safeFloat(diagnosticReport?.rawModules?.pad?.pleasure, 0),
        padDominance:         safeFloat(diagnosticReport?.rawModules?.pad?.dominance, 0),
        learningActive:       !!(diagnosticReport?.rawModules?.learning?.shouldAsk),
        qudDepth:             safeFloat(convState?.qudStack?.length, 0),
        volatility:           safeFloat(drClaudeOutput?.volatility, 0),
        consecutiveNegative:  safeFloat(drClaudeOutput?.consecutiveNegativeTurns, 0)
    });
}

// =============================================================================
// HYPOTHESIS SCORING
// =============================================================================

/**
 * scoreCategory — score one outcome category against current signals
 * Returns 0.0 to 1.0. All category definitions proposed — requires calibration.
 *
 * @param {Object} category - From CONFIG.OUTCOME_CATEGORIES
 * @param {Object} signals - From extractSignals()
 * @returns {number} 0.0 to 1.0
 */
function scoreCategory(category, signals) {
    let matches = 0;
    let factors = 0;

    if (category.frameMatch) {
        factors++;
        if (category.frameMatch.includes(signals.cognitiveFrame)) matches++;
    }

    if (typeof category.requiresLearning === 'boolean') {
        factors++;
        if (category.requiresLearning === signals.learningActive) matches++;
    }

    if (typeof category.repairExpected === 'boolean') {
        factors++;
        if (category.repairExpected === signals.repairTriggered) matches++;
    }

    if (category.padTrajectory === 'negative') {
        factors++;
        if (signals.padTrajectory === 'falling') matches++;
    } else if (category.padTrajectory === 'dominance_rising_pleasure_falling') {
        factors++;
        // Proposed affective pattern — requires verification (Picard 1997)
        if (signals.padDominance > 0.5 && signals.padPleasure < 0.5) matches++;
    }

    if (category.qudDepthExpected === 'deep') {
        factors++;
        if (signals.qudDepth >= 3) matches++;
    }

    return factors > 0 ? matches / factors : 0;
}

/**
 * computeWeightedCategoryScore — weighted sum for one category across turns
 * Single responsibility: recency-weighted scoring for one category only.
 * Extracted from updateHypotheses for readability and independent testability.
 *
 * Recency decay applied across turnHistory:
 *   current turn:  weight = RECENCY_DECAY^0 = 1.0
 *   one turn ago:  weight = RECENCY_DECAY^1 = 0.75
 *   two turns ago: weight = RECENCY_DECAY^2 = 0.5625
 *
 * @param {Object} category - From CONFIG.OUTCOME_CATEGORIES
 * @param {Object} currentSignals - Signals for this turn
 * @param {Array}  turnHistory - Previous turns [{signals, turnCount}]
 * @returns {number} Weighted score for this category
 */
function computeWeightedCategoryScore(category, currentSignals, turnHistory) {
    let weightedSum = scoreCategory(category, currentSignals);
    let totalWeight = 1.0;

    turnHistory.forEach((historicalTurn, index) => {
        if (!historicalTurn?.signals) return;
        const age    = index + 1;
        const weight = Math.pow(CONFIG.RECENCY_DECAY, age);
        weightedSum += scoreCategory(category, historicalTurn.signals) * weight;
        totalWeight += weight;
    });

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * updateHypotheses — update belief distribution with recency weighting
 * Delegates per-category computation to computeWeightedCategoryScore.
 * Normalises result to sum = 1. Returns new frozen belief distribution.
 * Immutable: never mutates existing hypotheses object.
 *
 * @param {Object} currentHypotheses - Current frozen belief distribution
 * @param {Object} currentSignals - Signals for this turn
 * @param {Array}  turnHistory - Previous turns
 * @returns {Object} New frozen belief distribution
 */
function updateHypotheses(currentHypotheses, currentSignals, turnHistory) {
    const rawScores = {};

    CONFIG.OUTCOME_CATEGORIES.forEach(cat => {
        rawScores[cat.id] = computeWeightedCategoryScore(
            cat, currentSignals, turnHistory
        );
    });

    const total = Object.values(rawScores).reduce((a, b) => a + b, 0);
    const normalised = {};

    CONFIG.OUTCOME_CATEGORIES.forEach(cat => {
        normalised[cat.id] = total > 0
            ? rawScores[cat.id] / total
            : 1 / CONFIG.OUTCOME_CATEGORIES.length;
    });

    return Object.freeze(normalised);
}

// =============================================================================
// CLARITY CALCULATION
// =============================================================================

/**
 * calculateInstantaneousClarity — hypothesis dominance score
 *
 * Clarity = how much the top hypothesis dominates competing ones.
 * High when one category is clearly dominant.
 * Low when two or more categories are closely competitive.
 *
 * This is the correct EMA input — NOT signalStrength (corrected from v1.0).
 * Clarity is confidence in the inferred outcome — derived from hypothesis
 * dominance, not signal volume.
 *
 * Research anchor: computational adaptation of GAS principles
 * (Kiresuk & Sherman, 1968) — requires validation.
 *
 * @param {Object} hypotheses - Frozen belief distribution
 * @returns {number} 0.0 to 1.0
 */
function calculateInstantaneousClarity(hypotheses) {
    const scores      = Object.entries(hypotheses).sort((a, b) => b[1] - a[1]);
    const topScore    = safeFloat(scores[0]?.[1], 0);
    const secondScore = safeFloat(scores[1]?.[1], 0);

    let clarity = topScore;

    const gap = topScore - secondScore;
    if (gap < CONFIG.HYPOTHESIS_COMPETITION_PENALTY) {
        const penaltyRatio = (CONFIG.HYPOTHESIS_COMPETITION_PENALTY - gap) /
                              CONFIG.HYPOTHESIS_COMPETITION_PENALTY;
        clarity *= (1 - (penaltyRatio * 0.5));
    }

    return Math.min(Math.max(clarity, 0), 1);
}

/**
 * updateClarityEMA — smooth instantaneous clarity with EMA
 *
 * Clarity(t) = α · instantaneousClarity(t) + (1 - α) · Clarity(t-1)
 *
 * Input is instantaneousClarity (hypothesis dominance), NOT signalStrength.
 * Clarity measures hypothesis dominance, not signal volume.
 * This corrects the comment error in v1.0. Implementation was always correct.
 * Pattern: Verduyn et al. (2009), reused from DrClaudeModule.
 *
 * @param {number} currentClarity
 * @param {number} instantaneousClarity
 * @returns {number} 0.0 to 1.0
 */
function updateClarityEMA(currentClarity, instantaneousClarity) {
    const alpha = CONFIG.CLARITY_ALPHA;
    return Math.min(Math.max(
        (alpha * instantaneousClarity) + ((1 - alpha) * currentClarity),
        0
    ), 1);
}

// =============================================================================
// ALIGNMENT CALCULATION
// =============================================================================

/**
 * calculateDirectionMatch — consistency of this turn with active hypothesis
 *
 * @param {string|null} activeHypothesisId
 * @param {Object} signals
 * @returns {number} 0.0 to 1.0 (0.5 neutral when no active hypothesis)
 */
function calculateDirectionMatch(activeHypothesisId, signals) {
    if (!activeHypothesisId) return 0.5;
    const cat = CONFIG.OUTCOME_CATEGORIES.find(c => c.id === activeHypothesisId);
    if (!cat) return 0.5;
    return scoreCategory(cat, signals);
}

/**
 * updateAlignmentEMA — smooth direction match with EMA
 *
 * Alignment(t) = β · DirectionMatch(t) + (1 - β) · Alignment(t-1)
 *
 * STRUCTURAL CONSTRAINT (Locke & Latham, 2002):
 * Alignment CANNOT be computed when Clarity < CLARITY_DISPLAY_THRESHOLD.
 * Returns null — enforced structurally, not a soft check.
 * Note: 0.70 is a design decision, not specified by Locke & Latham.
 *
 * @param {number|null} currentAlignment
 * @param {number} directionMatch
 * @param {number} currentClarity
 * @returns {number|null}
 */
function updateAlignmentEMA(currentAlignment, directionMatch, currentClarity) {
    if (currentClarity < CONFIG.CLARITY_DISPLAY_THRESHOLD) return null;
    const beta = CONFIG.ALIGNMENT_BETA;
    const prev = safeFloat(currentAlignment, 0.5);
    return Math.min(Math.max(
        (beta * directionMatch) + ((1 - beta) * prev),
        0
    ), 1);
}

/**
 * determineGaugeState — derive UI state from clarity value
 *
 * @param {number} clarity
 * @returns {'warming'|'tracking'|'surfacing'}
 */
function determineGaugeState(clarity) {
    if (clarity >= CONFIG.CLARITY_SURFACE_THRESHOLD)  return 'surfacing';
    if (clarity >= CONFIG.CLARITY_DISPLAY_THRESHOLD)  return 'tracking';
    return 'warming';
}

/**
 * deriveActiveHypothesis — id of the top scoring category
 *
 * @param {Object} hypotheses - Frozen belief distribution
 * @returns {string|null}
 */
function deriveActiveHypothesis(hypotheses) {
    const sorted = Object.entries(hypotheses).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] ?? null;
}

// =============================================================================
// STATE ASSEMBLY
// =============================================================================

/**
 * assembleTurnState — build immutable state from computed values
 * Stores signals in turnHistory for recency weighting on next turn.
 *
 * @param {Object} currentState - Previous state
 * @param {Object} computed - Computed values for this turn
 * @param {Object} signals - Extracted signals (stored in history)
 * @returns {Object} Frozen state
 */
function assembleTurnState(currentState, computed, signals) {
    const turnHistory = [
        { signals, turnCount: computed.turnCount, timestamp: Date.now() },
        ...currentState.turnHistory.slice(0, CONFIG.MAX_TURN_HISTORY - 1)
    ];

    return deepFreeze({
        conversationId:        currentState.conversationId,
        userId:           currentState.userId,
        clarity:          computed.clarity,
        alignment:        computed.alignment,
        hypotheses:       computed.hypotheses,
        turnHistory,
        gaugeState:       computed.gaugeState,
        activeHypothesis: computed.activeHypothesis,
        turnCount:        computed.turnCount,
        lastUpdate:       Date.now()
    });
}

// =============================================================================
// DATABASE OPERATIONS
// =============================================================================

/**
 * persistSessionState — UPSERT to wwdd_session_state
 * Enhancement path: DB failure is logged but does not break pipeline.
 *
 * @param {Object} state
 * @returns {Promise<void>}
 */
async function persistSessionState(state) {
    try {
        await pool.query({
            text: `
                INSERT INTO wwdd_session_state (
                    conversation_id, user_id, clarity, alignment,
                    gauge_state, active_hypothesis, hypothesis_scores,
                    turn_count, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                ON CONFLICT (conversation_id)
                DO UPDATE SET
                    clarity           = EXCLUDED.clarity,
                    alignment         = EXCLUDED.alignment,
                    gauge_state       = EXCLUDED.gauge_state,
                    active_hypothesis = EXCLUDED.active_hypothesis,
                    hypothesis_scores = EXCLUDED.hypothesis_scores,
                    turn_count        = EXCLUDED.turn_count,
                    updated_at        = NOW()
            `,
            values: [
                state.conversationId,
                state.userId,
                state.clarity,
                state.alignment,
                state.gaugeState,
                state.activeHypothesis,
                JSON.stringify(state.hypotheses),
                state.turnCount
            ],
            timeout: 3000
        });
    } catch (err) {
        logger.error('WWDD: DB persist failed', {
            conversationId: state.conversationId,
            error:     err.message
        });
    }
}

/**
 * loadSessionState — recover state from DB after server restart
 *
 * @param {string} conversationId
 * @returns {Promise<Object|null>}
 */
async function loadSessionState(conversationId) {
    try {
        const result = await pool.query({
            text:    'SELECT * FROM wwdd_session_state WHERE conversation_id = $1',
            values:  [conversationId],
            timeout: 3000
        });

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            conversationId:        row.conversation_id,
            userId:           row.user_id,
            clarity:          safeFloat(row.clarity, 0),
            alignment:        row.alignment !== null
                                ? safeFloat(row.alignment, null)
                                : null,
            gaugeState:       row.gauge_state,
            activeHypothesis: row.active_hypothesis,
            hypotheses:       row.hypothesis_scores ?? initUniformHypotheses(),
            turnHistory:      [],
            turnCount:        safeFloat(row.turn_count, 0),
            lastUpdate:       Date.now()
        };
    } catch (err) {
        logger.error('WWDD: DB load failed', { conversationId, error: err.message });
        return null;
    }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * initSession — initialise state for a new session
 *
 * @param {string} conversationId - Session hex ID (#XXXXXX)
 * @param {string} userId - User hex ID (#XXXXXX)
 * @returns {Object|null} Initial state snapshot or null on validation failure
 */
function initSession(conversationId, userId) {
    if (!isValidHexId(conversationId)) {
        logger.warn('WWDD: initSession — invalid conversationId', { conversationId });
        return null;
    }
    if (!isValidHexId(userId)) {
        logger.warn('WWDD: initSession — invalid userId', { userId });
        return null;
    }

    const initialState = deepFreeze({
        conversationId,
        userId,
        clarity:          0.0,
        alignment:        null,
        hypotheses:       initUniformHypotheses(),
        turnHistory:      [],
        gaugeState:       'warming',
        activeHypothesis: null,
        turnCount:        0,
        lastUpdate:       Date.now()
    });

    _globalSessionStates.set(conversationId, initialState);

    logger.info('WWDD: Session initialised', { conversationId, userId });

    return getState(conversationId);
}

/**
 * processTurn — core update loop (orchestration layer)
 *
 * Called by BrainOrchestrator after EarWig collation, before phase loop.
 * Each step is a named function call — no inline logic in this function.
 * Idempotency guard prevents double-processing on BrainOrchestrator retry.
 *
 * @param {string} conversationId - Session hex ID
 * @param {number} turnCount - Turn number from BrainOrchestrator
 * @param {Object} diagnosticReport - EarWig collation output
 * @param {Object} drClaudeOutput - DrClaudeModule output
 * @param {Object} convState - ConversationStateManager output
 * @returns {Promise<Object|null>} New state snapshot or null on error
 */
async function processTurn(
    conversationId,
    turnCount,
    diagnosticReport,
    drClaudeOutput,
    convState
) {
    // --- Input validation ---
    if (!isValidHexId(conversationId)) {
        logger.warn('WWDD: processTurn — invalid conversationId', { conversationId });
        return null;
    }
    if (!isValidDiagnosticReport(diagnosticReport)) {
        logger.warn('WWDD: processTurn — null or invalid diagnosticReport', { conversationId });
        return null;
    }
    if (!isValidConvState(convState)) {
        logger.warn('WWDD: processTurn — invalid convState shape', { conversationId });
        return null;
    }

    // --- State retrieval / recovery ---
    let currentState = _globalSessionStates.get(conversationId);

    if (!currentState) {
        logger.warn('WWDD: No in-memory state — attempting DB recovery', { conversationId });
        const recovered = await loadSessionState(conversationId);
        if (recovered) {
            _globalSessionStates.set(conversationId, deepFreeze(recovered));
            currentState = _globalSessionStates.get(conversationId);
            logger.info('WWDD: State recovered from DB', { conversationId });
        } else {
            logger.error('WWDD: No state found — call initSession first', { conversationId });
            return null;
        }
    }

    // --- Idempotency guard ---
    if (turnCount <= currentState.turnCount) {
        logger.debug('WWDD: Duplicate turn — returning current state', {
            conversationId,
            receivedTurn: turnCount,
            currentTurn:  currentState.turnCount
        });
        return getState(conversationId);
    }

    // --- Step 1: Extract signals ---
    const signals = extractSignals(diagnosticReport, drClaudeOutput, convState);

    // --- Step 2: Update hypothesis belief distribution ---
    const newHypotheses = updateHypotheses(
        currentState.hypotheses,
        signals,
        currentState.turnHistory
    );

    // --- Step 3: Calculate instantaneous clarity ---
    const instantaneousClarity = calculateInstantaneousClarity(newHypotheses);

    // --- Step 4: EMA-smooth clarity ---
    const newClarity = updateClarityEMA(currentState.clarity, instantaneousClarity);

    // --- Step 5: Derive active hypothesis ---
    const activeHypothesis = deriveActiveHypothesis(newHypotheses);

    // --- Step 6: Calculate alignment ---
    const directionMatch = calculateDirectionMatch(activeHypothesis, signals);
    const newAlignment   = updateAlignmentEMA(
        currentState.alignment,
        directionMatch,
        newClarity
    );

    // --- Step 7: Determine gauge state ---
    const gaugeState = determineGaugeState(newClarity);

    // --- Step 8: Assemble immutable state ---
    const newState = assembleTurnState(
        currentState,
        {
            turnCount,
            clarity:          newClarity,
            alignment:        newAlignment,
            hypotheses:       newHypotheses,
            gaugeState,
            activeHypothesis
        },
        signals
    );

    // --- Step 9: Update singleton ---
    _globalSessionStates.set(conversationId, newState);

    // --- Step 10: Persist to DB (enhancement path) ---
    await persistSessionState(newState);

    // --- Conditional debug log — high-signal changes only ---
    const clarityDelta = newClarity - currentState.clarity;
    if (Math.abs(clarityDelta) > 0.05) {
        logger.debug('WWDD: Significant clarity change', {
            conversationId,
            turnCount,
            clarity:         newClarity.toFixed(3),
            clarityDelta:    clarityDelta >= 0
                               ? '+' + clarityDelta.toFixed(3)
                               : clarityDelta.toFixed(3),
            alignment:       newAlignment !== null
                               ? newAlignment.toFixed(3)
                               : 'null',
            gaugeState,
            activeHypothesis,
            cognitiveFrame:  signals.cognitiveFrame,
            repairTriggered: signals.repairTriggered
        });
    }

    // TODO: emit metric event when clarity < 0.3 after turn 8 — anomaly signal
    // indicating the session may be too ambiguous to infer outcome reliably.
    // Implement when metrics infrastructure is available at scale.

    logger.debug('WWDD: Turn processed', {
        conversationId,
        turnCount,
        gaugeState,
        activeHypothesis
    });

    return getState(conversationId);
}

/**
 * getState — public state snapshot for UI and pipeline consumers
 * Sanitised view — internal turnHistory excluded from payload.
 *
 * @param {string} conversationId
 * @returns {Object|null}
 */
function getState(conversationId) {
    const state = _globalSessionStates.get(conversationId);
    if (!state) return null;

    return {
        conversationId:        state.conversationId,
        clarity:          state.clarity,
        alignment:        state.alignment,
        gaugeState:       state.gaugeState,
        activeHypothesis: state.activeHypothesis,
        hypotheses:       state.hypotheses,
        turnCount:        state.turnCount,
        lastUpdate:       state.lastUpdate
    };
}

/**
 * surfaceOutcome — user-initiated outcome reveal
 * Only permitted when gaugeState === 'surfacing'.
 * NEVER called automatically — user must request explicitly.
 *
 * Research: Locke & Latham (2002) — showing inferred goal creates reactance
 * if wrong. Surfacing is always user-initiated. (Google PAIR Guidebook, 2019)
 *
 * @param {string} conversationId
 * @returns {Object}
 */
function surfaceOutcome(conversationId) {
    const state = _globalSessionStates.get(conversationId);

    if (!state) {
        return { success: false, error: 'Session not found' };
    }

    if (state.gaugeState !== 'surfacing') {
        return {
            success: false,
            error: `Cannot surface: clarity ${state.clarity.toFixed(2)} below threshold ${CONFIG.CLARITY_SURFACE_THRESHOLD}`
        };
    }

    const category = CONFIG.OUTCOME_CATEGORIES.find(
        c => c.id === state.activeHypothesis
    );

    logger.info('WWDD: Outcome surfaced by user request', {
        conversationId,
        outcomeId: state.activeHypothesis,
        clarity:   state.clarity
    });

    return {
        success:       true,
        outcomeId:     state.activeHypothesis,
        outcomeName:   category?.name ?? 'Unknown',
        confidence:    state.clarity,
        allHypotheses: state.hypotheses
    };
}

/**
 * endSession — cleanup session state
 * Called when session ends — NOT when panel closes.
 *
 * @param {string} conversationId
 * @returns {Promise<Object>}
 */
async function endSession(conversationId) {
    if (_globalSessionStates.has(conversationId)) {
        _globalSessionStates.delete(conversationId);

        try {
            await pool.query({
                text:    'DELETE FROM wwdd_session_state WHERE conversation_id = $1',
                values:  [conversationId],
                timeout: 3000
            });
        } catch (err) {
            logger.error('WWDD: DB cleanup failed on endSession', {
                conversationId,
                error: err.message
            });
        }

        logger.info('WWDD: Session ended', { conversationId });
    }

    return { ended: true, conversationId };
}

/**
 * getConfig — expose CONFIG for admin tools and calibration displays
 *
 * @returns {Object} Frozen CONFIG
 */
function getConfig() {
    return CONFIG;
}

// =============================================================================
// TEST HOOKS — Pure function exports for unit testing
// No side effects. Testable without mocking DB or pipeline.
// Pattern: recommended by Reviewers 2, 3, 5 across both review rounds.
//
// Example usage:
//
//   import { __test__ } from './WwddEngine.js';
//
//   // Example 1: scoreCategory with known signals
//   const signals = {
//     cognitiveFrame: 'factual', learningActive: true,
//     repairTriggered: false, padTrajectory: 'stable',
//     padDominance: 0, padPleasure: 0, qudDepth: 0,
//     volatility: 0, consecutiveNegative: 0,
//     conversationPosition: 'middle'
//   };
//   const cat = {
//     id: 'knowledge_seeking', name: 'Knowledge Seeking',
//     frameMatch: ['factual'], requiresLearning: true,
//     repairExpected: false
//   };
//   const score = __test__.scoreCategory(cat, signals);
//   // Expected: 1.0 — all three factors match
//
//   // Example 2: determineGaugeState boundary conditions
//   assert(__test__.determineGaugeState(0.50) === 'warming');
//   assert(__test__.determineGaugeState(0.72) === 'tracking');
//   assert(__test__.determineGaugeState(0.87) === 'surfacing');
//
//   // Example 3: updateClarityEMA convergence toward dominant signal
//   const c1 = __test__.updateClarityEMA(0.0, 0.8);  // 0.3*0.8 = 0.240
//   const c2 = __test__.updateClarityEMA(c1,  0.8);  // 0.3*0.8 + 0.7*0.24 = 0.408
//   const c3 = __test__.updateClarityEMA(c2,  0.8);  // Continues toward 0.8
//   // Verify: c1 < c2 < c3 (convergence toward 0.8 over multiple turns)
//
//   // Example 4: isValidConvState guards
//   assert(__test__.isValidConvState(null) === true);          // null is handled via fallbacks
//   assert(__test__.isValidConvState({ position: 'middle' }) === true);
//   assert(__test__.isValidConvState({ position: 42 }) === false);  // number not string
//
// =============================================================================

export const __test__ = Object.freeze({
    extractSignals,
    scoreCategory,
    computeWeightedCategoryScore,
    updateHypotheses,
    calculateInstantaneousClarity,
    updateClarityEMA,
    calculateDirectionMatch,
    updateAlignmentEMA,
    determineGaugeState,
    deriveActiveHypothesis,
    assembleTurnState,
    isValidDiagnosticReport,
    isValidConvState,
    safeFloat,
    deepFreeze,
    initUniformHypotheses
});

// =============================================================================
// EXPORTS
// =============================================================================

export {
    initSession,
    processTurn,
    getState,
    surfaceOutcome,
    endSession,
    getConfig
};

export default processTurn;
