/**
 * ============================================================================
 * earWigCollation.js — EarWig Collation Engine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Pure function module that takes all 7 EarWig module outputs and produces
 * a single DiagnosticReport. Individual modules give their readings, and
 * the collation engine synthesises them into a consensus with confidence
 * scoring and disagreement tracking.
 *
 * ARCHITECTURE
 * ------------
 * This module is a PURE FUNCTION. It:
 *   - Takes inputs, produces outputs
 *   - Has NO internal state
 *   - Makes NO database calls
 *   - Makes NO external API calls
 *   - Is fully deterministic (same inputs = same outputs)
 *   - Adds negligible latency (<5ms compute)
 *
 * 3-TIER RESOLUTION
 * -----------------
 * Tier 1 — Fast-path agreement: If all modules agree on posture direction,
 *          use it immediately.
 * Tier 2 — Weighted vote: Each module votes for a posture, weighted by
 *          MODULE_WEIGHTS * module confidence. Highest score wins.
 * Tier 3 — Override rules: Safety-critical conditions that override the
 *          vote. Checked FIRST so they always take priority.
 *
 * OVERRIDE RULES
 * --------------
 * 1. Sarcasm override: If intentDetector detects sarcasm with confidence
 *    > 0.7, padEstimator weight is zeroed (sarcastic users often present
 *    positive words with negative intent). Raw PAD flagged as unreliable.
 * 2. Crisis escalation: If consecutiveNegativeTurns >= 3 AND current
 *    pleasure < -0.5, posture forced to 'urgent'.
 * 3. Repair cascade: If repairHandler detects active repair, posture
 *    shifts toward 'empathetic' regardless of other signals.
 *
 * DIAGNOSTIC REPORT SHAPE
 * -----------------------
 * {
 *   rawModules        — All 6 module outputs preserved
 *   compositeEmotionalState — Weighted PAD synthesis
 *   compositeIntent   — Primary/secondary intent with modifiers
 *   postureRecommendation — empathetic/teaching/playful/neutral/urgent
 *   confidence        — 0-1 overall confidence
 *   crossSignalAgreement — 0-1 how much modules agree
 *   flags             — Special conditions detected
 *   disagreementMap   — Which modules disagree and on what
 *   deltaSinceLastTurn — PAD change from stored to current
 * }
 *
 * CONSUMERS
 * ---------
 * - BrainOrchestrator: receives DiagnosticReport as turnState.diagnosticReport
 * - All 7 pipeline phases: read from diagnosticReport
 *
 * DEPENDENCIES
 * ------------
 * Internal: logger.js only
 * External: None
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('EarWigCollation');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const MODULE_WEIGHTS = Object.freeze({
  padEstimator: 0.20,
  learningDetector: 0.10,
  repairHandler: 0.15,
  intentDetector: 0.20,
  drClaudeModule: 0.20,
  conversationStateManager: 0.15
});

const POSTURE = Object.freeze({
  EMPATHETIC: 'empathetic',
  TEACHING: 'teaching',
  PLAYFUL: 'playful',
  NEUTRAL: 'neutral',
  URGENT: 'urgent'
});

const COLLATION_THRESHOLDS = Object.freeze({
  SARCASM_OVERRIDE_CONFIDENCE: 0.7,
  CRISIS_CONSECUTIVE_TURNS: 3,
  CRISIS_PLEASURE: -0.5,
  NEGATIVE_PLEASURE: -0.3,
  POSITIVE_PLEASURE: 0.3,
  LEARNING_SCORE: 0.45,
  AMBIGUITY_MARGIN: 0.05
});

const PAD_PRECISION = 4;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Safe Numeric Helpers                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function _safeNum(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _safePad(pad) {
  if (!pad || typeof pad !== 'object') return { p: 0, a: 0, d: 0 };
  return {
    p: _safeNum(pad.p, _safeNum(pad.pleasure, 0)),
    a: _safeNum(pad.a, _safeNum(pad.arousal, 0)),
    d: _safeNum(pad.d, _safeNum(pad.dominance, 0))
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module Confidence Extraction                                              */
/*                                                                            */
/*  Each module has different confidence signals. This normalises them        */
/*  into 0-1 values for use in confidence-weighted voting.                   */
/* ────────────────────────────────────────────────────────────────────────── */

function _extractModuleConfidences(moduleOutputs) {
  const { padMeta, learning, repair, cognitiveFrame,
    emotionalContext, conversationContext } = moduleOutputs;

  return {
    padEstimator: _safeNum(padMeta?.confidence, 0),
    learningDetector: learning?.shouldAsk ? _safeNum(learning?.score, 0) : 0.5,
    repairHandler: repair?.isRepair ? _safeNum(repair?.confidence, 0.8) : 0.5,
    intentDetector: _safeNum(cognitiveFrame?.confidence, 0),
    drClaudeModule: emotionalContext?.sampleCount > 0 ? 0.8 : 0.3,
    conversationStateManager: conversationContext?.hasHistory ? 0.8 : 0.3
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main Collation Function                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function collate(moduleOutputs, correlationId) {
  if (!moduleOutputs || typeof moduleOutputs !== 'object') {
    logger.error('collate() called with invalid moduleOutputs', { correlationId });
    return _buildFallbackReport(moduleOutputs, correlationId);
  }

  const pad = _safePad(moduleOutputs.pad);
  const padMeta = moduleOutputs.padMeta || {};
  const learning = moduleOutputs.learning || {};
  const repair = moduleOutputs.repair || {};
  const cognitiveFrame = moduleOutputs.cognitiveFrame || {};
  const emotionalContext = moduleOutputs.emotionalContext || {};
  const conversationContext = moduleOutputs.conversationContext || {};
  const reference = moduleOutputs.reference || {};

  const safeOutputs = {
    pad, padMeta, learning, reference, repair, cognitiveFrame,
    emotionalContext, conversationContext
  };

  /* ── Extract per-module confidences ───────────────────────────────────── */

  const moduleConfidences = _extractModuleConfidences(safeOutputs);

  /* ── Detect flags and override conditions ─────────────────────────────── */

  const flags = [];

  const sarcasmOverride = _checkSarcasmOverride(cognitiveFrame);
  if (sarcasmOverride) flags.push('sarcasm_overrides_pad');

  const crisisEscalation = _checkCrisisEscalation(emotionalContext, pad);
  if (crisisEscalation) flags.push('crisis_escalation');

  const repairCascade = _checkRepairCascade(repair, conversationContext);
  if (repairCascade) flags.push('repair_cascade');

  if (repair.isRepair && conversationContext.repairInProgress) {
    flags.push('repair_in_progress_plus_new_repair_detected');
  }

  if (learning.shouldAsk && cognitiveFrame.type === 'emotional') {
    flags.push('learning_during_emotional');
  }

  /* ── Compute derived values ───────────────────────────────────────────── */

  const compositeEmotionalState = _calculateCompositeEmotionalState(
    pad, emotionalContext, sarcasmOverride
  );

  const compositeIntent = _calculateCompositeIntent(
    cognitiveFrame, learning, repair
  );

  const postureVotes = _collectPostureVotes(safeOutputs);
  const crossSignalAgreement = _calculateAgreementScore(postureVotes, moduleConfidences);
  const postureRecommendation = _resolvePosture(postureVotes, moduleConfidences, flags, sarcasmOverride);

  logger.info("Collation votes", {
    vote_padEstimator: postureVotes.padEstimator || "ABSTAIN",
    vote_learningDetector: postureVotes.learningDetector || "ABSTAIN",
    vote_repairHandler: postureVotes.repairHandler || "ABSTAIN",
    vote_intentDetector: postureVotes.intentDetector || "ABSTAIN",
    vote_drClaudeModule: postureVotes.drClaudeModule || "ABSTAIN",
    vote_conversationStateManager: postureVotes.conversationStateManager || "ABSTAIN",
    voterCount: Object.keys(postureVotes).length,
    resolved: postureRecommendation,
    agreement: parseFloat(crossSignalAgreement.toFixed(3)),
    correlationId
  });
  const confidence = _calculateOverallConfidence(padMeta, cognitiveFrame, crossSignalAgreement);
  const disagreementMap = _buildDisagreementMap(postureVotes);
  const deltaSinceLastTurn = _calculateDelta(pad, emotionalContext);

  /* ── Assemble DiagnosticReport ────────────────────────────────────────── */

  const diagnosticReport = {
    rawModules: {
      pad,
      padMeta,
      learning,
      reference,
      repair,
      cognitiveFrame,
      emotionalContext,
      conversationContext
    },
    compositeEmotionalState,
    compositeIntent,
    postureRecommendation,
    confidence: parseFloat(confidence.toFixed(PAD_PRECISION)),
    crossSignalAgreement: parseFloat(crossSignalAgreement.toFixed(PAD_PRECISION)),
    flags,
    disagreementMap,
    deltaSinceLastTurn
  };

  logger.info('DiagnosticReport generated', {
    posture: postureRecommendation,
    confidence: diagnosticReport.confidence,
    agreement: diagnosticReport.crossSignalAgreement,
    flagCount: flags.length,
    flags: flags.length > 0 ? flags : undefined,
    correlationId
  });

  return diagnosticReport;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Fallback Report                                                           */
/*                                                                            */
/*  Returned when collate() receives invalid input. Ensures the pipeline     */
/*  never crashes due to malformed module outputs.                           */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildFallbackReport(moduleOutputs, correlationId) {
  logger.warn('Returning fallback DiagnosticReport', { correlationId });

  return {
    rawModules: {
      pad: { p: 0, a: 0, d: 0 },
      padMeta: {},
      learning: {},
      reference: {},
      repair: {},
      cognitiveFrame: {},
      emotionalContext: {},
      conversationContext: {}
    },
    compositeEmotionalState: {
      p: 0, a: 0, d: 0,
      trajectory: 'stable',
      volatility: 'low',
      sarcasmAdjusted: false
    },
    compositeIntent: {
      primary: 'factual',
      secondary: null,
      confidence: 0,
      blend: null,
      modifiers: []
    },
    postureRecommendation: POSTURE.NEUTRAL,
    confidence: 0,
    crossSignalAgreement: 0,
    flags: ['fallback_report'],
    disagreementMap: {},
    deltaSinceLastTurn: { p: 0, a: 0, d: 0, magnitude: 0 }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Override Rule Checks                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function _checkSarcasmOverride(cognitiveFrame) {
  return cognitiveFrame.meta?.sarcasm?.detected === true &&
    _safeNum(cognitiveFrame.meta.sarcasm.confidence, 0) >
    COLLATION_THRESHOLDS.SARCASM_OVERRIDE_CONFIDENCE;
}

function _checkCrisisEscalation(emotionalContext, pad) {
  return _safeNum(emotionalContext.consecutiveNegativeTurns, 0) >=
    COLLATION_THRESHOLDS.CRISIS_CONSECUTIVE_TURNS &&
    _safeNum(pad.p, 0) < COLLATION_THRESHOLDS.CRISIS_PLEASURE;
}

function _checkRepairCascade(repair, conversationContext) {
  return (repair.isRepair === true) ||
    (conversationContext.repairInProgress === true);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Composite Emotional State                                                 */
/*                                                                            */
/*  Blends raw PAD (what the user just said) with historical decayed PAD     */
/*  (where the user has been). If sarcasm detected, raw PAD is unreliable    */
/*  so historical gets more weight.                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _calculateCompositeEmotionalState(pad, emotionalContext, sarcasmOverride) {
  const rawWeight = sarcasmOverride ? 0.2 : 0.6;
  const historicalWeight = 1 - rawWeight;

  const currentPad = _safePad(emotionalContext.currentPad);

  return {
    p: parseFloat((rawWeight * pad.p + historicalWeight * currentPad.p).toFixed(PAD_PRECISION)),
    a: parseFloat((rawWeight * pad.a + historicalWeight * currentPad.a).toFixed(PAD_PRECISION)),
    d: parseFloat((rawWeight * pad.d + historicalWeight * currentPad.d).toFixed(PAD_PRECISION)),
    trajectory: emotionalContext.trajectory || 'stable',
    volatility: emotionalContext.volatility || 'low',
    sarcasmAdjusted: sarcasmOverride
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Composite Intent                                                          */
/*                                                                            */
/*  Primary intent comes from intentDetector. Repair and learning signals    */
/*  modify it — repair can override primary, learning adds a modifier.       */
/* ────────────────────────────────────────────────────────────────────────── */

function _calculateCompositeIntent(cognitiveFrame, learning, repair) {
  let primary = cognitiveFrame.type || 'factual';
  let secondary = null;
  const modifiers = [];

  if (repair.isRepair === true) {
    modifiers.push('repair_active');
    if (primary !== 'emotional') {
      secondary = primary;
      primary = 'repair';
    }
  }

  if (learning.shouldAsk === true) {
    modifiers.push('learning_opportunity');
  }

  return {
    primary,
    secondary,
    confidence: _safeNum(cognitiveFrame.confidence, 0),
    blend: cognitiveFrame.blend || null,
    modifiers
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Posture Vote Collection                                                   */
/*                                                                            */
/*  Each module casts a vote for a posture based on its output. Votes are    */
/*  later weighted by MODULE_WEIGHTS * moduleConfidence during resolution.   */
/* ────────────────────────────────────────────────────────────────────────── */


function _collectPostureVotes(moduleOutputs) {
  const {
    pad, learning, reference, repair, cognitiveFrame,
    emotionalContext, conversationContext
  } = moduleOutputs;

  const votes = {};

  /* padEstimator — only votes if meaningful signal detected */
  const padIntensity = Math.abs(pad.p) + Math.abs(pad.a) + Math.abs(pad.d);
  if (padIntensity > 0.5) {
    if (pad.p < COLLATION_THRESHOLDS.NEGATIVE_PLEASURE) {
      votes.padEstimator = POSTURE.EMPATHETIC;
    } else if (pad.p > COLLATION_THRESHOLDS.POSITIVE_PLEASURE && pad.a > 0) {
      votes.padEstimator = POSTURE.PLAYFUL;
    } else {
      votes.padEstimator = POSTURE.NEUTRAL;
    }
  }

  /* learningDetector — only votes if learning opportunity found */
  if (learning.shouldAsk === true &&
    _safeNum(learning.score, 0) >= COLLATION_THRESHOLDS.LEARNING_SCORE) {
    votes.learningDetector = POSTURE.TEACHING;
  }

  /* repairHandler — only votes if repair detected */
  if (repair.isRepair === true) {
    votes.repairHandler = POSTURE.EMPATHETIC;
  }

  /* intentDetector — ALWAYS votes, classifies every input */
  const intentType = cognitiveFrame.type || 'factual';
  if (intentType === 'emotional' || intentType === 'social') {
    votes.intentDetector = POSTURE.EMPATHETIC;
  } else if (intentType === 'playful') {
    votes.intentDetector = POSTURE.PLAYFUL;
  } else if (intentType === 'factual' || intentType === 'philosophical') {
    votes.intentDetector = POSTURE.TEACHING;
  } else {
    votes.intentDetector = POSTURE.NEUTRAL;
  }

  /* drClaudeModule — only votes if it has history */
  const hasSamples = _safeNum(emotionalContext.sampleCount, 0) > 0;
  if (hasSamples) {
    const trajectory = emotionalContext.trajectory || 'stable';
    const volatility = emotionalContext.volatility || 'low';
    if (trajectory === 'falling' || volatility === 'high') {
      votes.drClaudeModule = POSTURE.EMPATHETIC;
    } else if (trajectory === 'rising' && volatility === 'low') {
      votes.drClaudeModule = POSTURE.PLAYFUL;
    }
  }

  /* conversationStateManager — only votes if relevant state signal */
  if (conversationContext.repairInProgress === true) {
    votes.conversationStateManager = POSTURE.EMPATHETIC;
  }

  /* referenceDetector — votes TEACHING when unfamiliar entity detected */
  if (reference?.shouldAsk === true) {
    votes.referenceDetector = POSTURE.TEACHING;
  }

  return votes;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  3-Tier Posture Resolution                                                 */
/*                                                                            */
/*  Tier 3 (overrides) checked FIRST — safety-critical conditions always     */
/*  win. Then Tier 1 (fast-path unanimous agreement). Then Tier 2            */
/*  (confidence-weighted vote).                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function _resolvePosture(votes, moduleConfidences, flags, sarcasmOverride) {
  /* Tier 3: Override rules (safety-critical, checked first) */
  if (flags.includes('crisis_escalation')) {
    return POSTURE.URGENT;
  }

  if (flags.includes('repair_cascade')) {
    return POSTURE.EMPATHETIC;
  }

  /* Tier 1: Fast-path — all modules agree */
  const voteValues = Object.values(votes);
  const uniqueVotes = [...new Set(voteValues)];

  if (uniqueVotes.length === 1) {
    return uniqueVotes[0];
  }

  /* Tier 2: Confidence-weighted vote */
  const scores = {};
  for (const posture of Object.values(POSTURE)) {
    scores[posture] = 0;
  }

  for (const [module, posture] of Object.entries(votes)) {
    const baseWeight = MODULE_WEIGHTS[module] || 0;
    const moduleConf = moduleConfidences[module] || 0;

    /* Sarcasm override: zero padEstimator weight */
    const effectiveWeight = (sarcasmOverride && module === 'padEstimator')
      ? 0
      : baseWeight * moduleConf;

    scores[posture] += effectiveWeight;
  }

  let winner = POSTURE.NEUTRAL;
  let highScore = 0;
  let secondScore = 0;

  for (const [posture, score] of Object.entries(scores)) {
    if (score > highScore) {
      secondScore = highScore;
      highScore = score;
      winner = posture;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  return winner;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Agreement Score                                                           */
/*                                                                            */
/*  Measures how consistently modules point toward the same posture.         */
/*  Higher score = more consensus. Weighted by MODULE_WEIGHTS *              */
/*  moduleConfidence so higher-weight, higher-confidence modules count       */
/*  more toward agreement.                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function _calculateAgreementScore(votes, moduleConfidences) {
  const voteEntries = Object.entries(votes);
  if (voteEntries.length === 0) return 0;

  const tallies = {};
  let totalWeight = 0;

  for (const [module, posture] of voteEntries) {
    const weight = (MODULE_WEIGHTS[module] || 0) *
      (moduleConfidences[module] || 0);
    tallies[posture] = (tallies[posture] || 0) + weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;

  let maxTally = 0;
  for (const tally of Object.values(tallies)) {
    if (tally > maxTally) maxTally = tally;
  }

  return maxTally / totalWeight;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Overall Confidence                                                        */
/*                                                                            */
/*  Weighted average of available module confidences, modulated by           */
/*  cross-signal agreement. High agreement boosts confidence.                */
/* ────────────────────────────────────────────────────────────────────────── */

function _calculateOverallConfidence(padMeta, cognitiveFrame, agreementScore) {
  const padConfidence = _safeNum(padMeta.confidence, 0);
  const intentConfidence = _safeNum(cognitiveFrame.confidence, 0);

  const rawConfidence =
    (padConfidence * 0.4) +
    (intentConfidence * 0.4) +
    (agreementScore * 0.2);

  return Math.min(Math.max(rawConfidence, 0), 1);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Disagreement Map                                                          */
/*                                                                            */
/*  Records which modules disagree with the majority posture vote.           */
/*  Empty object when all modules agree.                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildDisagreementMap(votes) {
  const voteValues = Object.values(votes);
  const uniqueVotes = [...new Set(voteValues)];

  if (uniqueVotes.length <= 1) return {};

  const tallies = {};
  for (const vote of voteValues) {
    tallies[vote] = (tallies[vote] || 0) + 1;
  }

  let majority = null;
  let majorityCount = 0;
  for (const [posture, count] of Object.entries(tallies)) {
    if (count > majorityCount) {
      majority = posture;
      majorityCount = count;
    }
  }

  const map = {};
  for (const [module, posture] of Object.entries(votes)) {
    if (posture !== majority) {
      map[module] = { voted: posture, majority };
    }
  }

  return map;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Delta Since Last Turn                                                     */
/*                                                                            */
/*  Difference between raw PAD (this message) and stored decayed PAD         */
/*  (where the user was before this message). Includes magnitude.            */
/* ────────────────────────────────────────────────────────────────────────── */

function _calculateDelta(pad, emotionalContext) {
  const currentPad = _safePad(emotionalContext.currentPad);

  const delta = {
    p: parseFloat((pad.p - currentPad.p).toFixed(PAD_PRECISION)),
    a: parseFloat((pad.a - currentPad.a).toFixed(PAD_PRECISION)),
    d: parseFloat((pad.d - currentPad.d).toFixed(PAD_PRECISION))
  };

  delta.magnitude = parseFloat(Math.sqrt(
    delta.p * delta.p + delta.a * delta.a + delta.d * delta.d
  ).toFixed(PAD_PRECISION));

  return delta;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Export                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

export default collate;
