/**
 * ============================================================================
 * EarWig.js — Unified Input Interpretation Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * EarWig is Claude the Tanuki's ears. It runs ONCE before the pipeline
 * phases and produces a single HearingReport that all phases can consume.
 *
 * Before EarWig, each phase ran its own detection systems independently,
 * causing scattered analysis, duplicated work, and inconsistent results.
 * EarWig centralises all input interpretation into one pre-phase step.
 *
 * The name "EarWig" is a play on the insect — it gets into your ear.
 * Claude listens first, then the pipeline decides what to do.
 *
 * WHERE EARWIG FITS
 * -----------------
 * BrainOrchestrator.dispatchTurn() sequence:
 *   1. Create turnState object
 *   2. QUD check (is user responding to Claude's question?)
 *   3. Record user move
 *   4. TSE resume check (handle active teaching sessions)
 *   5. >>> EARWIG RUNS HERE <
 *   6. Phase loop (emotional, access, teaching, identity, helpdesk,
 *      intent, voice)
 *   7. Post-phase signal resolution
 *   8. Record Claude move, return responseIntent
 *
 * EarWig runs after TSE resume check because TSE can terminate the turn
 * early (no point analysing input if resuming a teaching session).
 * It runs before the phase loop so all 7 phases can read the report.
 *
 * THE HEARING REPORT
 * ------------------
 * EarWig produces turnState.hearingReport with these sections:
 *
 *   pad          — Pleasure-Arousal-Dominance coordinates from user input.
 *                  Includes both { pleasure, arousal, dominance } and
 *                  { p, a, d } aliases (Bug 8 fix — PhaseEmotional uses
 *                  short names).
 *
 *   padMeta      — Coverage, confidence, emotion labels, dominant emotion,
 *                  intensity, unknown words. From padEstimator metadata.
 *
 *   learning     — Whether Claude should ask about unfamiliar language.
 *                  Score, 6 signals, unknown words, novel ngrams, phrase.
 *                  From learningDetector.
 *
 *   repair       — Whether user input is a conversational repair attempt
 *                  (e.g. "what?", "I meant...", "no, the other one").
 *                  Type, category, confidence. From RepairHandler.
 *
 *   cognitiveFrame — User's cognitive intent type (playful, philosophical,
 *                  factual, social, emotional, sarcastic). Confidence,
 *                  entity, blend. Sarcasm, compound intent, temporal drift
 *                  metadata. From IntentDetector.
 *
 *   timestamp    — ISO string of when analysis ran.
 *   inputLength  — Character count of input.
 *
 * EXECUTION MODEL
 * ---------------
 * All four detection modules run in parallel via Promise.allSettled().
 * Each module is independently fault-isolated — if one fails, the others
 * still produce results. Failed modules return neutral defaults.
 *
 * WHAT EARWIG DOES NOT DO
 * -----------------------
 * - Does NOT run cotwIntentMatcher (requires DB entity searches and user
 *   access_level — stays in PhaseIntent)
 * - Does NOT run AdjacencyPairHandler.checkExpectation() (requires
 *   candidateSppCode which is only known after intent matching)
 * - Does NOT terminate turns (enrichment only)
 * - Does NOT mutate session
 * - Does NOT touch FSRS learning data
 *
 * DEFENSIVE DESIGN
 * ----------------
 * Every module call is wrapped in its own try/catch via Promise.allSettled.
 * If padEstimator fails, learning detection still runs. If learningDetector
 * fails, repair detection still runs. A complete module failure produces
 * neutral defaults for that section — the pipeline continues.
 *
 * NULL/EMPTY HANDLING
 * -------------------
 * If command is null, undefined, or empty string, EarWig returns a
 * neutral HearingReport immediately without calling any modules. This
 * handles edge cases like empty socket messages.
 *
 * MODULE DEPENDENCIES
 * -------------------
 * padEstimator.js        — estimate(text) → PAD coordinates + metadata
 * learningDetector.js    — detectLearningOpportunity(msg, userId) →
 *                          learning signals
 * RepairHandler.js       — detectOtherInitiatedRepair(msg) → repair info
 * IntentDetectorSingleton.js — detect(input, opts) → cognitive frame
 *
 * All four must be imported. All four run in parallel. Failure of any
 * one does not prevent the others from completing.
 *
 * CHANGES FROM v009
 * -----------------
 * This file is new in v010. There is no v009 equivalent. Previously,
 * detection was scattered across individual pipeline phases.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: EarWig (PascalCase)
 * Export: singleton instance (camelCase import name)
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import padEstimator from './padEstimator.js';
import learningDetector from './learningDetector.js';
import repairHandler from './RepairHandler.js';
import intentDetector from '../TanukiEngine/IntentDetectorSingleton.js';
import { createModuleLogger } from '../utils/logger.js';
import drClaudeModule from './DrClaudeModule.js';
import conversationStateManager from './ConversationStateManager.js';
import referenceDetector from './referenceDetector.js';
import collate from './earWigCollation.js';

const logger = createModuleLogger('EarWig');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const MAX_INPUT_LENGTH = 10000;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Neutral Defaults                                                          */
/*                                                                            */
/*  Used when a module fails or when input is empty. Each section has its     */
/*  own neutral default so partial failures produce partial results, not      */
/*  total failure. All frozen to prevent accidental mutation.                 */
/* ────────────────────────────────────────────────────────────────────────── */

const NEUTRAL_PAD = Object.freeze({
  pleasure: 0,
  arousal: 0,
  dominance: 0,
  p: 0,
  a: 0,
  d: 0
});

const NEUTRAL_PAD_META = Object.freeze({
  coverage: 0,
  confidence: 0,
  labels: [],
  dominantEmotion: 'neutral',
  intensity: 0,
  lowCoverage: true,
  knownWords: 0,
  totalWords: 0,
  unknownWords: undefined
});

const NEUTRAL_LEARNING = Object.freeze({
  shouldAsk: false,
  score: 0,
  signals: {},
  phrase: null,
  unknownWords: [],
  novelNgrams: [],
  surprisalScore: 0,
  triggeredSignalNames: []
});

const NEUTRAL_REPAIR = Object.freeze({
  isRepair: false,
  repairType: null,
  category: null,
  confidence: null,
  interpretationNote: null
});

const NEUTRAL_COGNITIVE_FRAME = Object.freeze({
  type: 'factual',
  confidence: 0,
  entity: null,
  blend: null,
  meta: Object.freeze({
    sarcasm: null,
    compoundIntent: null,
    temporalDrift: null
  })
});

const NEUTRAL_EMOTIONAL_CONTEXT = Object.freeze({
  currentPad: Object.freeze({ p: 0, a: 0, d: 0 }),
  trajectory: 'stable',
  sampleCount: 0,
  timeSinceLastUpdate: null,
  baselineDeviation: 0,
  volatility: 'low',
  emaAlpha: 0.70,
  decayApplied: false,
  consecutiveNegativeTurns: 0
});

const NEUTRAL_CONVERSATION_CONTEXT = Object.freeze({
  sequencePosition: 'opening',
  turnCount: 0,
  qudDepth: 0,
  repairInProgress: false,
  repairType: null,
  currentTopic: null,
  commonGroundSize: 0,
  hasHistory: false
});

const NEUTRAL_REFERENCE = Object.freeze({
  shouldAsk: false,
  score: 0,
  signals: {},
  candidates: [],
  prioritizedCandidate: null,
  triggeredSignalNames: []
});
/* ────────────────────────────────────────────────────────────────────────── */
/*  EarWig Class                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

class EarWig {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  hear()                                                                  */
  /*                                                                          */
  /*  Primary method. Analyses user input through all detection modules       */
  /*  in parallel and returns a unified HearingReport.                        */
  /*                                                                          */
  /*  @param {string} command — User input text                               */
  /*  @param {object} options                                                  */
  /*  @param {string} options.userId — Hex user ID                            */
  /*  @param {string} options.conversationId — Hex conversation ID            */
  /*  @param {object} options.session — Session object (read only)            */
  /*  @returns {object} HearingReport                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async hear(command, { userId, conversationId, session } = {}) {
    const timestamp = new Date().toISOString();

    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      logger.debug('Empty input received, returning neutral report', {
        conversationId
      });
      return this._buildNeutralReport(timestamp, 0);
    }

    let input = command.trim();
    if (input.length > MAX_INPUT_LENGTH) {
      logger.warn('Input exceeds maximum length, truncating', {
        conversationId,
        originalLength: input.length,
        maxLength: MAX_INPUT_LENGTH
      });
      input = input.slice(0, MAX_INPUT_LENGTH);
    }

    const inputLength = input.length;

    /* ── Run All Detection Modules In Parallel ──────────────────────────── */

    const [padSettled, learningSettled, referenceSettled, repairSettled, intentSettled, emotionalSettled, conversationSettled] =
      await Promise.allSettled([
        this._estimatePad(input),
        this._detectLearning(input, userId),
        this._detectReferences(input, userId),
        this._detectRepair(input),
        this._detectCognitiveFrame(input, conversationId),
        this._getEmotionalContext(input, userId, conversationId),
        this._getConversationContext(conversationId)
      ]);

    /* ── Process PAD Result ─────────────────────────────────────────────── */

    let pad = { ...NEUTRAL_PAD };
    let padMeta = { ...NEUTRAL_PAD_META };

    if (padSettled.status === 'fulfilled' && padSettled.value) {
      const padResult = padSettled.value;
      pad = {
        pleasure: padResult.pad.pleasure || 0,
        arousal: padResult.pad.arousal || 0,
        dominance: padResult.pad.dominance || 0,
        p: padResult.pad.pleasure || 0,
        a: padResult.pad.arousal || 0,
        d: padResult.pad.dominance || 0
      };
      padMeta = {
        coverage: padResult.coverage || 0,
        confidence: padResult.confidence || 0,
        labels: padResult.labels || [],
        dominantEmotion: padResult.dominantEmotion || 'neutral',
        intensity: padResult.intensity || 0,
        lowCoverage: padResult.lowCoverage || false,
        knownWords: padResult.knownWords || 0,
        totalWords: padResult.totalWords || 0,
        unknownWords: padResult.unknownWords
      };
    } else if (padSettled.status === 'rejected') {
      logger.warn('PAD estimation failed, using neutral defaults', {
        conversationId,
        error: padSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: padEstimator', {
      conversationId,
      status: padSettled.status,
      dominantEmotion: padMeta.dominantEmotion,
      confidence: padMeta.confidence,
      coverage: padMeta.coverage,
      lowCoverage: padMeta.lowCoverage
    });

    /* ── Process Learning Result ────────────────────────────────────────── */

    let learning = { ...NEUTRAL_LEARNING };

    if (learningSettled.status === 'fulfilled' && learningSettled.value) {
      const learningResult = learningSettled.value;
      learning = {
        shouldAsk: learningResult.shouldAsk || false,
        score: learningResult.score || 0,
        signals: learningResult.signals || {},
        phrase: learningResult.phrase || null,
        unknownWords: learningResult.unknownWords || [],
        novelNgrams: learningResult.novelNgrams || [],
        surprisalScore: learningResult.surprisalScore || 0,
        triggeredSignalNames: learningResult.triggeredSignalNames || []
      };
    } else if (learningSettled.status === 'rejected') {
      logger.warn('Learning detection failed, using neutral defaults', {
        conversationId,
        error: learningSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: learningDetector', {
      conversationId,
      status: learningSettled.status,
      shouldAsk: learning.shouldAsk,
      score: learning.score,
      unknownWordCount: learning.unknownWords.length,
      triggeredSignals: learning.triggeredSignalNames
    });

    /* ── Process Reference Result ──────────────────────────────────────── */

    let reference = {
      shouldAsk: false,
      score: 0,
      signals: {},
      candidates: [],
      prioritizedCandidate: null,
      triggeredSignalNames: []
    };

    if (referenceSettled.status === 'fulfilled' && referenceSettled.value) {
      reference = referenceSettled.value;
    } else if (referenceSettled.status === 'rejected') {
      logger.warn('Reference detection failed, using neutral defaults', {
        conversationId,
        error: referenceSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: referenceDetector', {
      conversationId,
      status: referenceSettled.status,
      shouldAsk: reference.shouldAsk,
      score: reference.score,
      candidateCount: reference.candidates.length,
      prioritizedPhrase: reference.prioritizedCandidate?.phrase || null,
      triggeredSignals: reference.triggeredSignalNames
    });

    /* ── Process Repair Result ──────────────────────────────────────────── */

    let repair = { ...NEUTRAL_REPAIR };

    if (repairSettled.status === 'fulfilled' && repairSettled.value) {
      const repairResult = repairSettled.value;
      repair = {
        isRepair: repairResult.isRepair || false,
        repairType: repairResult.repairType || null,
        category: repairResult.category || null,
        confidence: repairResult.confidence || null,
        interpretationNote: repairResult.interpretationNote || null
      };
    } else if (repairSettled.status === 'rejected') {
      logger.warn('Repair detection failed, using neutral defaults', {
        conversationId,
        error: repairSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: repairHandler', {
      conversationId,
      status: repairSettled.status,
      isRepair: repair.isRepair,
      repairType: repair.repairType,
      category: repair.category,
      confidence: repair.confidence
    });

    /* ── Process Cognitive Frame Result ─────────────────────────────────── */

    let cognitiveFrame = {
      type: NEUTRAL_COGNITIVE_FRAME.type,
      confidence: NEUTRAL_COGNITIVE_FRAME.confidence,
      entity: NEUTRAL_COGNITIVE_FRAME.entity,
      blend: NEUTRAL_COGNITIVE_FRAME.blend,
      meta: {
        sarcasm: NEUTRAL_COGNITIVE_FRAME.meta.sarcasm,
        compoundIntent: NEUTRAL_COGNITIVE_FRAME.meta.compoundIntent,
        temporalDrift: NEUTRAL_COGNITIVE_FRAME.meta.temporalDrift
      }
    };

    if (intentSettled.status === 'fulfilled' && intentSettled.value) {
      const intentResult = intentSettled.value;
      cognitiveFrame = {
        type: intentResult.type || 'factual',
        confidence: intentResult.confidence || 0,
        entity: intentResult.entity || null,
        blend: intentResult.blend || null,
        meta: {
          sarcasm: intentResult.meta?.sarcasm || null,
          compoundIntent: intentResult.meta?.compoundIntent || null,
          temporalDrift: intentResult.meta?.temporalDrift || null
        }
      };
    } else if (intentSettled.status === 'rejected') {
      logger.warn('Cognitive frame detection failed, using neutral defaults', {
        conversationId,
        error: intentSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: intentDetector', {
      conversationId,
      status: intentSettled.status,
      type: cognitiveFrame.type,
      confidence: cognitiveFrame.confidence,
      sarcasmDetected: cognitiveFrame.meta.sarcasm?.detected ?? false,
      compoundIntent: cognitiveFrame.meta.compoundIntent
    });


    /* ── Process Emotional Context Result ───────────────────────────────── */

    let emotionalContext = { ...NEUTRAL_EMOTIONAL_CONTEXT };

    if (emotionalSettled.status === 'fulfilled' && emotionalSettled.value) {
      emotionalContext = emotionalSettled.value;
    } else if (emotionalSettled.status === 'rejected') {
      logger.warn('Emotional context fetch failed, using neutral defaults', {
        conversationId,
        error: emotionalSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: DrClaudeModule', {
      conversationId,
      status: emotionalSettled.status,
      trajectory: emotionalContext.trajectory ?? 'unknown',
      volatility: emotionalContext.volatility ?? 'unknown',
      consecutiveNegativeTurns: emotionalContext.consecutiveNegativeTurns ?? 0,
      baselineDeviation: emotionalContext.baselineDeviation ?? 0
    });

    /* ── Process Conversation Context Result ─────────────────────────────── */

    let conversationContext = { ...NEUTRAL_CONVERSATION_CONTEXT };

    if (conversationSettled.status === 'fulfilled' && conversationSettled.value) {
      conversationContext = conversationSettled.value;
    } else if (conversationSettled.status === 'rejected') {
      logger.warn('Conversation context fetch failed, using neutral defaults', {
        conversationId,
        error: conversationSettled.reason?.message || 'Unknown error'
      });
    }

    logger.info('Module report: ConversationStateManager', {
      conversationId,
      status: conversationSettled.status,
      sequencePosition: conversationContext.sequence_position ?? 'unknown',
      qudDepth: conversationContext.qud_stack?.length ?? 0,
      repairInProgress: conversationContext.repair_in_progress ?? false
    });
    /* ── Build Final Report ─────────────────────────────────────────────── */

    const hearingReport = {
      pad,
      padMeta,
      learning,
      reference,
      repair,
      cognitiveFrame,
      emotionalContext,
      conversationContext,
      timestamp,
      inputLength
    };

    logger.info('HearingReport generated', {
      conversationId,
      inputLength,
      padEmotion: padMeta.dominantEmotion,
      learningTriggered: learning.shouldAsk,
      referenceTriggered: reference.shouldAsk,
      repairDetected: repair.isRepair,
      cognitiveType: cognitiveFrame.type,
      cognitiveConfidence: cognitiveFrame.confidence
    });

    return collate(hearingReport, conversationId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Module Wrappers                                                */
  /*                                                                          */
  /*  Each module call is wrapped in its own method with try/catch.           */
  /*  Promise.allSettled handles rejection, but these wrappers provide        */
  /*  additional safety and consistent error context.                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _estimatePad(input) {
    try {
      return padEstimator.estimate(input);
    } catch (error) {
      throw new Error(`PAD estimation error: ${error.message}`);
    }
  }

  async _detectLearning(input, userId) {
    try {
      return await learningDetector.detectLearningOpportunity(input, userId);
    } catch (error) {
      throw new Error(`Learning detection error: ${error.message}`);
    }
  }

  async _detectRepair(input) {
    try {
      return repairHandler.detectOtherInitiatedRepair(input);
    } catch (error) {
      throw new Error(`Repair detection error: ${error.message}`);
    }
  }

  async _detectCognitiveFrame(input, conversationId) {
    try {
      return intentDetector.detect(input, {
        conversationId: conversationId || undefined,
        previousContext: undefined
      });
    } catch (error) {
      throw new Error(`Cognitive frame detection error: ${error.message}`);
    }
  }


  async _getEmotionalContext(input, userId, correlationId) {
    try {
      const processResult = await drClaudeModule.processUserMessage(input, userId, correlationId);
      const rawPad = processResult?.newPad || null;
      return await drClaudeModule.getEmotionalContext(userId, rawPad);
    } catch (error) {
      throw new Error(`Emotional context error: ${error.message}`);
    }
  }

  async _detectReferences(input, userId) {
    try {
      return await referenceDetector.detectReferences(input, userId);
    } catch (error) {
      throw new Error(`Reference detection error: ${error.message}`);
    }
  }

  async _getConversationContext(conversationId) {
    try {
      return await conversationStateManager.getConversationContext(conversationId);
    } catch (error) {
      throw new Error(`Conversation context error: ${error.message}`);
    }
  }
  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Build Neutral Report                                           */
  /*                                                                          */
  /*  Returns a complete HearingReport with all neutral defaults.             */
  /*  Used for empty input or complete system failure.                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildNeutralReport(timestamp, inputLength) {
    return {
      pad: { ...NEUTRAL_PAD },
      padMeta: { ...NEUTRAL_PAD_META },
      learning: { ...NEUTRAL_LEARNING },
      reference: { ...NEUTRAL_REFERENCE },
      repair: { ...NEUTRAL_REPAIR },
      cognitiveFrame: {
        type: NEUTRAL_COGNITIVE_FRAME.type,
        confidence: NEUTRAL_COGNITIVE_FRAME.confidence,
        entity: NEUTRAL_COGNITIVE_FRAME.entity,
        blend: NEUTRAL_COGNITIVE_FRAME.blend,
        meta: {
          sarcasm: NEUTRAL_COGNITIVE_FRAME.meta.sarcasm,
          compoundIntent: NEUTRAL_COGNITIVE_FRAME.meta.compoundIntent,
          temporalDrift: NEUTRAL_COGNITIVE_FRAME.meta.temporalDrift
        }
      },
      emotionalContext: { ...NEUTRAL_EMOTIONAL_CONTEXT },
      conversationContext: { ...NEUTRAL_CONVERSATION_CONTEXT },
      timestamp,
      inputLength
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  getStatus()                                                             */
  /*                                                                          */
  /*  Returns current status of all detection modules including trained       */
  /*  state and availability. Used for observability and health checks.       */
  /*                                                                          */
  /*  @returns {object} Module status summary                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  getStatus() {
    return {
      padEstimator: {
        available: typeof padEstimator?.estimate === 'function',
        trained: padEstimator?.trained || false,
        lexiconSize: padEstimator?.lexicon?.size || 0
      },
      learningDetector: {
        available: typeof learningDetector?.detectLearningOpportunity === 'function',
        threshold: learningDetector?.LEARNING_THRESHOLD || null
      },
      repairHandler: {
        available: typeof repairHandler?.detectOtherInitiatedRepair === 'function',
        observeMode: repairHandler?.OBSERVE_MODE !== undefined ? repairHandler.OBSERVE_MODE : null
      },
      intentDetector: {
        available: typeof intentDetector?.detect === 'function',
        feedbackEnabled: intentDetector?.config?.enableFeedback || false
      },
      drClaudeModule: {
        available: typeof drClaudeModule?.getEmotionalContext === 'function'
      },
      referenceDetector: {
        available: typeof referenceDetector?.detectReferences === 'function'
      },
      conversationStateManager: {
        available: typeof conversationStateManager?.getConversationContext === 'function'
      }
    };
  }
}

export default new EarWig();
