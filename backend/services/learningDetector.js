/**
 * ============================================================================
 * learningDetector.js — Learning Opportunity Detection Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Detects when a user says something Claude the Tanuki does not understand.
 * This is the foundation of Goal 2: "Claude can detect unfamiliar language."
 *
 * When a user uses new slang, cultural references, or unfamiliar phrases,
 * this module produces a learning signal that triggers Claude to ask the
 * user about it. The explanation is then stored in the user's COTW dossier
 * via learningCapturer (Goal 3).
 *
 * HOW IT WORKS
 * ------------
 * Uses 6 weighted signals to produce a composite learning score (0-1).
 * If the score exceeds the threshold (0.45), shouldAsk is true and Claude
 * should inquire about the unfamiliar input.
 *
 * SIGNALS (6 total, deliberately tuned — do NOT simplify to 3)
 * -----------------------------------------------------------------
 * Signal          Weight  Source              What It Detects
 * -----------------------------------------------------------------
 * padCoverage     0.20    padEstimator        Low word recognition in PAD lexicon
 * padNovelty      0.15    padEstimator        Neutral emotion + low coverage (no affect signal)
 * padSparsity     0.10    padEstimator        PAD region with few training examples nearby
 * ngramCoverage   0.20    ngramSurprisal      Novel word combinations not in corpus
 * surprisal       0.20    ngramSurprisal      Statistically unexpected phrasing
 * metaphor        0.15    metaphorDetector    Figurative language that may confuse literal parsing
 * -----------------------------------------------------------------
 * Total weights = 1.00    Threshold = 0.45
 *
 * The previous brief suggested simplifying to 3 signals. This was rejected
 * after code examination — the 6-signal system is deliberately tuned.
 * (V010 Goals Brief, Decision 5; EarWig Brief, Part 3.2)
 *
 * BUG FIXES IN THIS VERSION
 * -------------------------
 * Bug 1: ngramSurprisal returns novelNgrams (single array).
 *        v009 expected novelTrigrams/novelBigrams (separate fields).
 *        The try/catch silently fell back to empty arrays every time.
 *        FIXED: reads surprisalResult.novelNgrams directly.
 *
 * Bug 2: padEstimator never returns a 'novelty' field.
 *        v009 checked padResult.novelty === 'no_known_lexical_affect'.
 *        This signal (weight 0.15) never fired.
 *        FIXED: checks dominantEmotion === 'neutral' AND coverage < 0.35.
 *        This captures the same semantic meaning — "no known emotional
 *        words" — using fields padEstimator actually returns.
 *
 * RETURN STRUCTURE
 * ----------------
 * {
 *   shouldAsk: boolean,          // true if score >= 0.45
 *   score: float,                // 0-1 composite learning pressure
 *   signals: {                   // 6 boolean flags
 *     padNovelty: boolean,
 *     ngramNovelty: boolean,
 *     metaphorDetected: boolean,
 *     padSparse: boolean,
 *     lowCoverage: boolean,
 *     highSurprisal: boolean
 *   },
 *   pressures: object,           // 6 scalar values (0-1 each)
 *   phrase: string|null,         // original input
 *   pad: object,                 // PAD coordinates
 *   coverage: float,             // PAD lexicon coverage
 *   unknownWords: string[],      // words not in PAD lexicon
 *   metaphor: object|undefined,  // metaphor detection result
 *   novelNgrams: string[],       // up to 3 novel n-grams
 *   surprisalScore: float,       // raw surprisal in bits
 *   triggeredSignalNames: string[]
 * }
 *
 * PAD SPARSITY CHECK
 * ------------------
 * v009 ran an async DB query every turn to count nearby training
 * examples in PAD space. This has been replaced with an in-memory
 * heuristic: if the PAD estimate is in the neutral/low-intensity zone
 * AND coverage is moderate (0.35-0.60), the region is likely sparse.
 * This avoids hitting the database on every user message.
 *
 * INTEGRATION
 * -----------
 * Called by EarWig.hear() to populate hearingReport.learning.
 * Internally calls padEstimator.estimate() and ngramSurprisal.surprisal().
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: LearningDetector (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import padEstimator from './padEstimator.js';
import ngramSurprisal from './ngramSurprisal.js';
import metaphorDetector from './metaphorDetector.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('LearningDetector');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const _envLearningThreshold = Number(process.env.LEARNING_THRESHOLD);
const LEARNING_THRESHOLD = Number.isFinite(_envLearningThreshold) ? _envLearningThreshold : 0.45;

const SIGNAL_WEIGHTS = Object.freeze({
  padCoverage:  0.20,
  padNovelty:   0.15,
  padSparsity:  0.10,
  ngramCoverage: 0.20,
  surprisal:    0.20,
  metaphor:     0.15
});

const PAD_LOW_COVERAGE_THRESHOLD = 0.60;
const PAD_NOVELTY_COVERAGE_THRESHOLD = 0.35;
const NGRAM_NOVELTY_COVERAGE_THRESHOLD = 0.50;
const SURPRISAL_HIGH_THRESHOLD = 6.0;
const SURPRISAL_NORMALISER = 10.0;
const PAD_SPARSITY_INTENSITY_THRESHOLD = 0.15;
const PAD_SPARSITY_COVERAGE_LOW = 0.35;
const PAD_SPARSITY_COVERAGE_HIGH = 0.60;
const MAX_NOVEL_NGRAMS_RETURNED = 3;
const MAX_INPUT_LENGTH = 10000;

/* ────────────────────────────────────────────────────────────────────────── */
/*  LearningDetector Class                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

class LearningDetector {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Safe PAD Estimation                                            */
  /*                                                                          */
  /*  Wraps padEstimator.estimate() with error handling.                      */
  /*  Returns neutral result on failure instead of crashing.                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  _estimatePAD(message) {
    try {
      return padEstimator.estimate(message);
    } catch (err) {
      logger.warn('PAD estimation failed, using neutral fallback', {
        error: err.message
      });
      return {
        pad: { pleasure: 0, arousal: 0, dominance: 0 },
        coverage: 0,
        confidence: 0,
        knownWords: 0,
        totalWords: 0,
        unknownWords: [],
        labels: ['neutral'],
        dominantEmotion: 'neutral',
        intensity: 0,
        lowCoverage: true
      };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Safe Surprisal Estimation                                      */
  /*                                                                          */
  /*  Wraps ngramSurprisal.surprisal() with error handling.                  */
  /*  Returns safe defaults on failure.                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _estimateSurprisal(message) {
    try {
      return ngramSurprisal.surprisal(message);
    } catch (err) {
      logger.warn('Surprisal estimation failed, using safe fallback', {
        error: err.message
      });
      return {
        score: 0,
        coverage: 1.0,
        novelNgrams: [],
        totalNgramsEvaluated: 0
      };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Safe Metaphor Detection                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectMetaphor(message) {
    try {
      return metaphorDetector.detect(message);
    } catch (err) {
      logger.warn('Metaphor detection failed, using safe fallback', {
        error: err.message
      });
      return {
        isMetaphor: false,
        confidence: 0
      };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: PAD Sparsity Check (In-Memory)                                 */
  /*                                                                          */
  /*  Replaces the v009 async DB query with an in-memory heuristic.           */
  /*  A PAD region is considered sparse when:                                 */
  /*    - Intensity is very low (near neutral origin) AND                     */
  /*    - Coverage is moderate (some words known, but weak signal)            */
  /*                                                                          */
  /*  This captures the case where padEstimator "sort of" recognises the      */
  /*  words but the resulting PAD position is in a poorly-populated           */
  /*  region of the emotional space — a gray zone where Claude should         */
  /*  be less confident about the emotional interpretation.                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _isPADSparse(padResult) {
    if (padResult.coverage <= 0) return false;

    const isLowIntensity = padResult.intensity < PAD_SPARSITY_INTENSITY_THRESHOLD;
    const isModCoverage = padResult.coverage >= PAD_SPARSITY_COVERAGE_LOW
                       && padResult.coverage < PAD_SPARSITY_COVERAGE_HIGH;

    return isLowIntensity && isModCoverage;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Compute Scalar Pressures                                       */
  /*                                                                          */
  /*  Converts each detection result into a normalised 0-1 scalar.            */
  /*  These are then combined with weights to produce the final score.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computePressures(padResult, surprisalResult, metaphorResult, signals) {
    return {
      padCoverage: Math.max(0, Math.min(1, 1 - padResult.coverage)),
      padNovelty: signals.padNovelty ? 1 : 0,
      padSparsity: signals.padSparse ? 1 : 0,
      ngramCoverage: Math.max(0, Math.min(1, 1 - surprisalResult.coverage)),
      surprisal: Math.max(0, Math.min(1, surprisalResult.score / SURPRISAL_NORMALISER)),
      metaphor: metaphorResult.isMetaphor ? (metaphorResult.confidence ?? 1) : 0
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Compute Weighted Score                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computeScore(pressures) {
    let score = 0;
    for (const key of Object.keys(SIGNAL_WEIGHTS)) {
      score += SIGNAL_WEIGHTS[key] * (pressures[key] || 0);
    }
    return parseFloat(score.toFixed(4));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Detect Learning Opportunity                                     */
  /*                                                                          */
  /*  Main entry point. Analyses a user message for unfamiliar language        */
  /*  using 6 weighted signals and returns a composite learning score.         */
  /*                                                                          */
  /*  @param {string} message — User input text                               */
  /*  @param {string} userId — User hex ID (for future per-user tuning)      */
  /*  @returns {object} Learning detection result (see header for structure)  */
  /* ──────────────────────────────────────────────────────────────────────── */

  detectLearningOpportunity(message, userId) {
    if (typeof message !== 'string' || !message.trim()) {
      return this._emptyResult(message);
    }

    const input = message.trim().slice(0, MAX_INPUT_LENGTH);

    /* ── Run all detectors ─────────────────────────────────────────────── */

    const padResult = this._estimatePAD(input);
    const surprisalResult = this._estimateSurprisal(input);
    const metaphorResult = this._detectMetaphor(input);

    /* ── Build signal flags ────────────────────────────────────────────── */

    const signals = {
      lowCoverage: padResult.coverage < PAD_LOW_COVERAGE_THRESHOLD,
      padNovelty: padResult.dominantEmotion === 'neutral'
                  && padResult.coverage < PAD_NOVELTY_COVERAGE_THRESHOLD,
      padSparse: this._isPADSparse(padResult),
      ngramNovelty: surprisalResult.coverage < NGRAM_NOVELTY_COVERAGE_THRESHOLD,
      highSurprisal: surprisalResult.score > SURPRISAL_HIGH_THRESHOLD,
      metaphorDetected: metaphorResult.isMetaphor
    };

    /* ── Compute pressures and weighted score ──────────────────────────── */

    const pressures = this._computePressures(padResult, surprisalResult, metaphorResult, signals);
    const score = this._computeScore(pressures);
    const shouldAsk = score >= LEARNING_THRESHOLD;

    /* ── Build result ──────────────────────────────────────────────────── */

    const result = {
      shouldAsk,
      score,
      signals,
      pressures,
      phrase: message,
      pad: padResult.pad,
      coverage: padResult.coverage,
      unknownWords: padResult.unknownWords || [],
      metaphor: metaphorResult.isMetaphor ? metaphorResult : undefined,
      novelNgrams: surprisalResult.novelNgrams?.slice(0, MAX_NOVEL_NGRAMS_RETURNED) || [],
      surprisalScore: surprisalResult.score,
      triggeredSignalNames: Object.keys(signals).filter(k => signals[k])
    };

    if (shouldAsk) {
      logger.debug('Learning opportunity detected', {
        score,
        triggered: result.triggeredSignalNames,
        userId
      });
    }

    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Empty Result                                                   */
  /*                                                                          */
  /*  Safe return for null/empty input.                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _emptyResult(message) {
    return {
      shouldAsk: false,
      score: 0,
      signals: {
        padNovelty: false,
        ngramNovelty: false,
        metaphorDetected: false,
        padSparse: false,
        lowCoverage: false,
        highSurprisal: false
      },
      pressures: {
        padCoverage: 0,
        padNovelty: 0,
        padSparsity: 0,
        ngramCoverage: 0,
        surprisal: 0,
        metaphor: 0
      },
      phrase: message || null,
      pad: { pleasure: 0, arousal: 0, dominance: 0 },
      coverage: 0,
      unknownWords: [],
      metaphor: undefined,
      novelNgrams: [],
      surprisalScore: 0,
      triggeredSignalNames: []
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Signal Explanations                                             */
  /*                                                                          */
  /*  Translates boolean signal flags into human-readable explanations.       */
  /*  Used by Claude's response generation to explain WHY he is asking        */
  /*  about unfamiliar language.                                              */
  /*                                                                          */
  /*  @param {object} signals — The signals object from detection result      */
  /*  @returns {string[]} Human-readable explanations                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  getSignalExplanations(signals) {
    if (!signals || typeof signals !== 'object') return [];

    const explanations = [];

    if (signals.padNovelty) {
      explanations.push('no known emotional words detected');
    }
    if (signals.padSparse) {
      explanations.push('emotional signal is in an ambiguous region');
    }
    if (signals.lowCoverage) {
      explanations.push('many words are not in the known lexicon');
    }
    if (signals.ngramNovelty) {
      explanations.push('word combinations are unfamiliar');
    }
    if (signals.highSurprisal) {
      explanations.push('phrasing is statistically unexpected');
    }
    if (signals.metaphorDetected) {
      explanations.push('figurative or metaphorical language detected');
    }

    return explanations;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new LearningDetector();
