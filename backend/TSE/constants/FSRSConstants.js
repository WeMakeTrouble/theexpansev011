/**
 * =============================================================================
 * FSRSConstants â€” Canonical FSRS Configuration (v6.1.3)
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Single source of truth for all Free Spaced Repetition Scheduler (FSRS)
 * parameters used by the Teaching Session Engine. Every constant is
 * research-backed, versioned, and frozen.
 *
 * FSRS VERSION:
 * ---------------------------------------------------------------------------
 * Version: FSRS v6.1.3 defaults (fsrs4anki, Sept 2025+)
 * Source: https://github.com/open-spaced-repetition/fsrs4anki
 * Weights: June 17, 2025 commit (FSRS-6 optimized), verified Jan 2026
 *
 * FSRS-6 IMPROVEMENTS (June 2025 update):
 * ---------------------------------------------------------------------------
 *   - Better short-term memory handling
 *   - Refined recency effects
 *   - Optimized for modern spacing patterns
 *   - Updated default weights for production use
 *   - 21-parameter weight vector (up from 17 in FSRS-5)
 *
 * SOURCED FROM:
 * ---------------------------------------------------------------------------
 *   1. Research consensus (4/4 reviews): Initial stability 1-2 days,
 *      difficulty 5-6
 *   2. FSRS specification (v6.1.3): Rating scale 1-4, 21-parameter vector
 *   3. System design: Thresholds for success/failure, re-teach limits
 *
 * UPGRADE PROCEDURE:
 * ---------------------------------------------------------------------------
 *   1. Check upstream repo for latest FSRS versions
 *   2. Update FSRS_WEIGHTS array with new defaults
 *   3. Update FSRS_VERSION constant
 *   4. Verify FSRS_WEIGHT_COUNT matches new vector length
 *   5. Run validateWeights() at startup to confirm
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   EvaluatorComponent.js â€” FSRS scoring, state persistence, review scheduling
 *   TSELoopManager.js â€” threshold checks, re-teach flow decisions
 *   fsrs_core.js â€” algorithm functions receive these as parameters
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - All constants frozen via Object.freeze
 *   - Structured logger for validation failures (no console.log/error)
 *   - Named exports for tree-shaking + default bundle for convenience
 *   - Version string exported for telemetry and audit logging
 *   - Weight count as named constant (not magic number)
 *
 * =============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('FSRSConstants');

/* ==========================================================================
 * Version
 * ========================================================================== */

/**
 * FSRS algorithm version string for telemetry and audit logging.
 * Update this when upgrading the weight vector.
 * @type {string}
 */
export const FSRS_VERSION = '6.1.3-defaults-jun2025';

/* ==========================================================================
 * Initial Parameters
 * ========================================================================== */

/**
 * Initial stability for newly-learned items (days).
 * Research consensus: 1.0 day minimum for stable new knowledge.
 * Source: fsrs4anki spec + learning science consensus.
 * @type {number}
 */
export const FSRS_INITIAL_STABILITY = 1.0;

/**
 * Initial difficulty for newly-learned items.
 * Research consensus: 5.0 (neutral/medium difficulty).
 * Range: 1-10, where 5 is perfectly balanced.
 * Source: fsrs4anki spec + system design.
 * @type {number}
 */
export const FSRS_INITIAL_DIFFICULTY = 5.0;

/* ==========================================================================
 * Thresholds
 * ========================================================================== */

/**
 * Threshold for "successful" recall (triggers FSRS update, RETRIEVABLE transition).
 * FSRS Rating scale: 1=again, 2=hard, 3=good, 4=easy.
 * Scores >= 3 (good or easy) are considered successful.
 * @type {number}
 */
export const FSRS_GOOD_THRESHOLD = 3;

/* ==========================================================================
 * Rating Constants
 * ========================================================================== */

/**
 * FSRS Rating: User answer was incorrect, lapse occurred.
 * Score: 1. Triggers forget stability calculation, re-teach flow.
 * @type {number}
 */
export const FSRS_RATING_AGAIN = 1;

/**
 * FSRS Rating: User answer was correct but with difficulty.
 * Score: 2. Triggers hard recall stability calculation.
 * @type {number}
 */
export const FSRS_RATING_HARD = 2;

/**
 * FSRS Rating: User answer was correct with normal ease.
 * Score: 3. Triggers recall stability calculation.
 * @type {number}
 */
export const FSRS_RATING_GOOD = 3;

/**
 * FSRS Rating: User answer was correct with ease.
 * Score: 4. Triggers extended recall stability calculation.
 * @type {number}
 */
export const FSRS_RATING_EASY = 4;

/**
 * Rating label-to-number mapping for fsrs_core.js functions.
 * @type {Readonly<Object>}
 */
export const FSRS_RATINGS = Object.freeze({
  again: 1,
  hard: 2,
  good: 3,
  easy: 4
});

/* ==========================================================================
 * Algorithm Parameters
 * ========================================================================== */

/**
 * Target retention rate for FSRS calculations.
 * 0.9 = 90% chance of recall at next review.
 * Used in interval calculation: longer intervals = lower retention.
 * Source: fsrs4anki standard parameter.
 * @type {number}
 */
export const FSRS_REQUEST_RETENTION = 0.9;

/**
 * Maximum review interval in days (100 years).
 * Prevents arithmetic overflow and caps extremely long intervals.
 * Source: fsrs4anki spec.
 * @type {number}
 */
export const FSRS_MAXIMUM_INTERVAL = 36500;

/**
 * Maximum re-teach attempts per item per session.
 * After this many failures (score < GOOD_THRESHOLD), defer item to next session.
 * Research consensus: 2-3 attempts before deferring.
 * Purpose: Prevent frustration spirals, preserve learning state.
 * @type {number}
 */
export const MAX_RETEACH_ATTEMPTS = 3;

/* ==========================================================================
 * Weight Vector
 * ========================================================================== */

/**
 * Expected number of parameters in the FSRS weight vector.
 * FSRS-6 uses 21 parameters (up from 17 in FSRS-5).
 * Used by validateWeights() to catch truncation or corruption.
 * @type {number}
 */
export const FSRS_WEIGHT_COUNT = 21;

/**
 * Score conversion multiplier: maps 5-point evaluation scale to 4-point FSRS ratings.
 * eval 5 .8=4(easy), 4 .8=3.2’good, 3 .8=2.4’hard, 1 .8=0.8,lamped to 1
 * @type {number}
 */
export const FSRS_SCORE_MULTIPLIER = 0.8;

/**
 * Minimum FSRS rating (Again). Floor for score clamping.
 * @type {number}
 */
export const FSRS_SCORE_MIN = 1;

/**
 * Maximum FSRS rating (Easy). Ceiling for score clamping.
 * @type {number}
 */
export const FSRS_SCORE_MAX = 4;

/**
 * Canonical weight vector from fsrs4anki v6.1.3 (June 2025, verified Jan 2026).
 * 21 parameters for FSRS algorithm.
 * Structure: [initial stability, difficulty, recall stability,
 *             forget stability, hard/easy bonuses, decay]
 *
 * Recommended: Call validateWeights() at backend startup to fail-fast.
 * @type {readonly number[]}
 */
export const FSRS_WEIGHTS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956,     // w[0-3]: initial stability per rating
  6.4133, 0.8334, 3.0194, 0.001,     // w[4-7]: difficulty mean reversion + forgetting curve
  1.8722, 0.1666, 0.796,             // w[8-10]: recall stability growth
  1.4835, 0.0614, 0.2629, 1.6483,    // w[11-14]: forget stability (lapse recovery)
  0.6014, 1.8729,                    // w[15-16]: hard penalty, easy bonus
  0.5425, 0.0912, 0.0658,            // w[17-19]: short-term stability special cases
  0.1542                             // w[20]: decay constant
]);

/* ==========================================================================
 * Validation Helpers
 * ========================================================================== */

/**
 * Validate FSRS rating is in valid range.
 * @param {number} rating â€” Rating value (must be integer 1-4)
 * @returns {boolean} True if valid rating
 */
export function isValidFSRSRating(rating) {
  return Number.isInteger(rating) && rating >= FSRS_RATING_AGAIN && rating <= FSRS_RATING_EASY;
}

/**
 * Check if rating represents successful recall (meets good threshold).
 * @param {number} rating â€” FSRS rating (1-4)
 * @returns {boolean} True if rating >= FSRS_GOOD_THRESHOLD
 */
export function isSuccessfulRecall(rating) {
  return rating >= FSRS_GOOD_THRESHOLD;
}

/**
 * Get human-readable rating label.
 * @param {number} rating â€” FSRS rating (1-4)
 * @returns {string} Label or "Unknown"
 */
export function getRatingLabel(rating) {
  const labels = Object.freeze({
    [FSRS_RATING_AGAIN]: 'Again',
    [FSRS_RATING_HARD]: 'Hard',
    [FSRS_RATING_GOOD]: 'Good',
    [FSRS_RATING_EASY]: 'Easy'
  });
  return labels[rating] || 'Unknown';
}

/**
 * Clamp review interval to safe bounds.
 * @param {number} days â€” Proposed interval in days
 * @returns {number} Clamped interval [1, FSRS_MAXIMUM_INTERVAL]
 */
export function clampInterval(days) {
  return Math.max(1, Math.min(days, FSRS_MAXIMUM_INTERVAL));
}

/**
 * Validate FSRS weights array structure at startup.
 * Logs structured error on failure. Call during server initialisation.
 * @returns {boolean} True if weights array has correct length
 */
export function validateWeights() {
  if (FSRS_WEIGHTS.length !== FSRS_WEIGHT_COUNT) {
    logger.error('FSRS weight array length mismatch', {
      actual: FSRS_WEIGHTS.length,
      expected: FSRS_WEIGHT_COUNT,
      version: FSRS_VERSION
    });
    return false;
  }
  return true;
}

/* ==========================================================================
 * Configuration Bundle
 * ========================================================================== */

/**
 * All FSRS constants in a single frozen bundle.
 * Convenience export for modules that need the full configuration.
 * @type {Readonly<Object>}
 */
export const FSRS = Object.freeze({
  FSRS_VERSION,
  FSRS_INITIAL_STABILITY,
  FSRS_INITIAL_DIFFICULTY,
  FSRS_GOOD_THRESHOLD,
  FSRS_RATING_AGAIN,
  FSRS_RATING_HARD,
  FSRS_RATING_GOOD,
  FSRS_RATING_EASY,
  FSRS_REQUEST_RETENTION,
  FSRS_MAXIMUM_INTERVAL,
  MAX_RETEACH_ATTEMPTS,
  FSRS_WEIGHT_COUNT,
  FSRS_SCORE_MULTIPLIER,
  FSRS_SCORE_MIN,
  FSRS_SCORE_MAX,
  FSRS_WEIGHTS,
  FSRS_RATINGS,
  isValidFSRSRating,
  isSuccessfulRecall,
  getRatingLabel,
  clampInterval,
  validateWeights
});

export default FSRS;
