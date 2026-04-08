/**
 * =============================================================================
 * fsrs_core — FSRS Algorithm Pure Functions
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Direct, verbatim port of fsrs4anki scheduler math.
 * Source: https://github.com/open-spaced-repetition/fsrs4anki
 * Version: v6.1.3 (aligned with FSRSConstants.js FSRS_VERSION)
 *
 * RULES (DO NOT VIOLATE):
 * ---------------------------------------------------------------------------
 *   1. No refactors of math — this is a verified port
 *   2. No DB access — pure functions only
 *   3. No traits — scoring adjustments happen in EvaluatorComponent
 *   4. No dates — callers compute elapsed days before calling
 *   5. No side effects — every function is deterministic
 *   6. No logger needed — pure math has no observable side effects
 *
 * PARAMETER CONVENTIONS:
 * ---------------------------------------------------------------------------
 *   w       — FSRS_WEIGHTS array (21 floats, from FSRSConstants.js)
 *   ratings — FSRS_RATINGS object ({ again: 1, hard: 2, good: 3, easy: 4 })
 *   rating  — string label ("again", "hard", "good", "easy")
 *   s       — stability (days until retention drops to requestRetention)
 *   d       — difficulty (1-10 scale, 5 = neutral)
 *   r       — retrievability (0-1, from forgettingCurve)
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   EvaluatorComponent.js — evaluateReview(), initializeNewItem()
 *   TSELoopManager.js — FSRS scheduling decisions
 *
 * NUMERIC PRECISION:
 * ---------------------------------------------------------------------------
 *   All outputs use toFixed(2) to mirror fsrs4anki precision.
 *
 * =============================================================================
 */

/* ==========================================================================
 * Constants / Utilities
 * ========================================================================== */

/**
 * Compute decay constant from weight vector.
 * @param {readonly number[]} w — FSRS weight vector
 * @returns {number} Negative decay value
 */
export function computeDecay(w) {
  return -w[20];
}

/**
 * Compute power factor from decay constant.
 * Used in forgettingCurve and nextInterval calculations.
 * @param {number} decay — From computeDecay()
 * @returns {number} Power factor
 */
export function computeFactor(decay) {
  return Math.pow(0.9, 1 / decay) - 1;
}

/**
 * Calculate retrievability (probability of recall) after elapsed time.
 * Core FSRS memory model: power-law forgetting curve.
 * @param {number} elapsedDays — Days since last review
 * @param {number} stability — Current stability in days
 * @param {number} factor — From computeFactor()
 * @param {number} decay — From computeDecay()
 * @returns {number} Retrievability (0-1)
 */
export function forgettingCurve(elapsedDays, stability, factor, decay) {
  return Math.pow(1 + factor * elapsedDays / stability, decay);
}

/* ==========================================================================
 * Interval
 * ========================================================================== */

/**
 * Calculate next review interval from stability and target retention.
 * @param {number} stability — Current stability in days
 * @param {number} requestRetention — Target retention (e.g. 0.9)
 * @param {number} factor — From computeFactor()
 * @param {number} decay — From computeDecay()
 * @param {number} maximumInterval — Cap in days (e.g. 36500)
 * @returns {number} Next interval in days (integer, clamped to [1, max])
 */
export function nextInterval(
  stability,
  requestRetention,
  factor,
  decay,
  maximumInterval
) {
  const newInterval = stability / factor * (Math.pow(requestRetention, 1 / decay) - 1);
  return Math.min(Math.max(Math.round(newInterval), 1), maximumInterval);
}

/* ==========================================================================
 * Difficulty
 * ========================================================================== */

/**
 * Constrain difficulty to valid range [1, 10].
 * @param {number} d — Raw difficulty value
 * @returns {number} Clamped difficulty (2 decimal places)
 */
export function constrainDifficulty(d) {
  return Math.min(Math.max(+d.toFixed(2), 1), 10);
}

/**
 * Linear damping to prevent difficulty oscillation.
 * @param {number} deltaD — Difficulty change
 * @param {number} oldD — Current difficulty
 * @returns {number} Damped change
 */
export function linearDamping(deltaD, oldD) {
  return deltaD * (10 - oldD) / 9;
}

/**
 * Mean reversion toward initial difficulty (prevents runaway values).
 * @param {number} init — Initial difficulty (from initDifficulty)
 * @param {number} current — Current difficulty
 * @param {number} w7 — Mean reversion weight (w[7])
 * @returns {number} Reverted difficulty
 */
export function meanReversion(init, current, w7) {
  return w7 * init + (1 - w7) * current;
}

/**
 * Calculate next difficulty after a review.
 * @param {number} d — Current difficulty
 * @param {string} rating — Rating label ("again"|"hard"|"good"|"easy")
 * @param {readonly number[]} w — Weight vector
 * @param {Readonly<Object>} ratings — Rating label-to-number map
 * @param {number} initDifficultyEasy — Initial difficulty for mean reversion
 * @returns {number} Next difficulty (1-10, 2 decimal places)
 */
export function nextDifficulty(d, rating, w, ratings, initDifficultyEasy) {
  const deltaD = -w[6] * (ratings[rating] - 3);
  const nextD = d + linearDamping(deltaD, d);
  return constrainDifficulty(meanReversion(initDifficultyEasy, nextD, w[7]));
}

/* ==========================================================================
 * Stability (Recall)
 * ========================================================================== */

/**
 * Calculate next stability after successful recall.
 * Applies hard penalty (w[15]) and easy bonus (w[16]).
 * @param {number} d — Current difficulty
 * @param {number} s — Current stability
 * @param {number} r — Current retrievability
 * @param {string} rating — "hard"|"good"|"easy"
 * @param {readonly number[]} w — Weight vector
 * @returns {number} Next stability in days (2 decimal places)
 */
export function nextRecallStability(d, s, r, rating, w) {
  const hardPenalty = rating === "hard" ? w[15] : 1;
  const easyBonus = rating === "easy" ? w[16] : 1;
  return +(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus)).toFixed(2);
}

/* ==========================================================================
 * Stability (Forget / Lapse)
 * ========================================================================== */

/**
 * Calculate next stability after a lapse (failed recall).
 * Uses forget stability parameters w[11-14] and short-term cap w[17-18].
 * @param {number} d — Current difficulty
 * @param {number} s — Current stability
 * @param {number} r — Current retrievability
 * @param {readonly number[]} w — Weight vector
 * @returns {number} Next stability in days (2 decimal places, capped)
 */
export function nextForgetStability(d, s, r, w) {
  const sMin = s / Math.exp(w[17] * w[18]);
  return +Math.min(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), sMin).toFixed(2);
}

/* ==========================================================================
 * Short-Term Stability
 * ========================================================================== */

/**
 * Calculate stability adjustment for same-day reviews (short-term memory).
 * For ratings >= 3 (good/easy), ensures stability never decreases.
 * @param {number} s — Current stability
 * @param {number} rating — Numeric rating (1-4)
 * @param {readonly number[]} w — Weight vector
 * @returns {number} Adjusted stability (2 decimal places)
 */
export function nextShortTermStability(s, rating, w) {
  let sinc = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(s, -w[19]);
  if (rating >= 3) {
    sinc = Math.max(sinc, 1);
  }
  return +(s * sinc).toFixed(2);
}

/* ==========================================================================
 * Initial State
 * ========================================================================== */

/**
 * Calculate initial difficulty for a new item based on first rating.
 * @param {string} rating — Rating label ("again"|"hard"|"good"|"easy")
 * @param {readonly number[]} w — Weight vector
 * @param {Readonly<Object>} ratings — Rating label-to-number map
 * @returns {number} Initial difficulty (1-10, 2 decimal places)
 */
export function initDifficulty(rating, w, ratings) {
  return +constrainDifficulty(w[4] - Math.exp(w[5] * (ratings[rating] - 1)) + 1).toFixed(2);
}

/**
 * Calculate initial stability for a new item based on first rating.
 * Uses w[0-3] indexed by rating number. Minimum 0.1 days.
 * @param {string} rating — Rating label ("again"|"hard"|"good"|"easy")
 * @param {readonly number[]} w — Weight vector
 * @param {Readonly<Object>} ratings — Rating label-to-number map
 * @returns {number} Initial stability in days (2 decimal places, min 0.1)
 */
export function initStability(rating, w, ratings) {
  return +Math.max(w[ratings[rating] - 1], 0.1).toFixed(2);
}
