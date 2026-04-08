/**
 * ============================================================================
 * RepairHandler.js — Conversation Repair Detection Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Detects when communication has broken down between the user and Claude
 * the Tanuki. This is the foundation of Goal 5: "Claude can recover from
 * misunderstandings."
 *
 * When a user says "huh?", "what do you mean?", or echoes back part of
 * Claude's message with a question mark, that is a REPAIR INITIATION —
 * the user is signalling that something went wrong and Claude needs to
 * fix it.
 *
 * OBSERVE MODE
 * ------------
 * This module operates in OBSERVE MODE by default. It detects repair
 * sequences but does not enforce them. Detection results are signals
 * for downstream phases to act on, not commands.
 *
 * THEORETICAL FOUNDATION
 * ----------------------
 * Based on Schegloff, Jefferson, & Sacks (1977):
 * "The Preference for Self-Correction in the Organization of Repair
 * in Conversation"
 *
 * Repair preference hierarchy (lower = more preferred):
 *   1. self_initiated_self_repair    — Claude catches own mistake
 *   2. other_initiated_self_repair   — User flags, Claude fixes
 *   3. self_initiated_other_repair   — Claude asks user to clarify
 *   4. other_initiated_other_repair  — User corrects Claude directly
 *
 * DETECTION CATEGORIES
 * --------------------
 * Category               Confidence  Example
 * ---------------------------------------------------------------
 * open_class              0.95       "huh?", "what?", "pardon?"
 * wh_question             0.85       "what do you mean?", "who?"
 * partial_repeat          0.75       "the cheese wars??"
 * candidate_understanding 0.70       "so you mean...", "are you saying..."
 *
 * Confidence values are HEURISTIC WEIGHTS representing relative pattern
 * strength, NOT empirical probabilities. They should not be thresholded
 * as truth.
 *
 * FALSE POSITIVES
 * ---------------
 * These patterns are intentionally broad and WILL produce false positives
 * on sarcasm, fragments, stylistic replies, and poetic language. This is
 * acceptable in OBSERVE mode — downstream phases use the signal alongside
 * other context (PAD, intent, QUD) to make final decisions.
 *
 * EARWIG INTEGRATION
 * ------------------
 * EarWig calls: repairHandler.detectOtherInitiatedRepair(userMessage)
 * Result populates: hearingReport.repair
 *
 * EarWig does NOT call state management methods (initiateRepair,
 * completeRepair, etc). Those are for pipeline phases that act on
 * repair signals.
 *
 * RETURN STRUCTURE (detectOtherInitiatedRepair)
 * ---------------------------------------------
 * When repair detected:
 * {
 *   isRepair: true,
 *   repairType: 'other_initiated_self_repair',
 *   category: 'open_class'|'wh_question'|'partial_repeat'|'candidate_understanding',
 *   confidence: 0.70-0.95,
 *   originalMessage: string,
 *   interpretationNote: 'heuristic_signal_not_truth'
 * }
 *
 * When no repair detected:
 * {
 *   isRepair: false,
 *   repairType: null,
 *   category: null,
 *   confidence: null,
 *   originalMessage: string,
 *   interpretationNote: null
 * }
 *
 * DIALOGUE FUNCTION MAPPING
 * -------------------------
 * When a repair IS detected, getRecommendedDialogueFunction() maps
 * the repair category to an LTLM dialogue function code:
 *
 *   open_class              → own_communication_management.self_repair
 *   wh_question             → allo_feedback.request_clarification
 *   partial_repeat          → own_communication_management.self_correction
 *   candidate_understanding → partner_communication_management.confirm_partner_state
 *
 * STATE MANAGEMENT
 * ----------------
 * initiateRepair(), completeRepair(), isRepairInProgress(), and
 * getRepairContext() manage repair state via ConversationStateManager.
 * These are called by pipeline phases, not by EarWig.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: RepairHandler (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import ConversationStateManager from './ConversationStateManager.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('RepairHandler');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const CONFIDENCE = Object.freeze({
  OPEN_CLASS:              0.95,
  WH_QUESTION:             0.85,
  PARTIAL_REPEAT:          0.75,
  CANDIDATE_UNDERSTANDING: 0.70,
  SELF_REPAIR:             0.90
});

const REPAIR_PREFERENCE_HIERARCHY = Object.freeze([
  'self_initiated_self_repair',
  'other_initiated_self_repair',
  'self_initiated_other_repair',
  'other_initiated_other_repair'
]);

const CATEGORY_TO_DIALOGUE_FUNCTION = Object.freeze({
  open_class:              'own_communication_management.self_repair',
  wh_question:             'allo_feedback.request_clarification',
  partial_repeat:          'own_communication_management.self_correction',
  candidate_understanding: 'partner_communication_management.confirm_partner_state'
});

const CATEGORY_TO_SPEECH_ACT = Object.freeze({
  open_class:              'assertive.explain',
  wh_question:             'assertive.inform',
  partial_repeat:          'assertive.correction_acceptance',
  candidate_understanding: 'feedback_elicitation.elicit_confirmation'
});

const INTERPRETATION_NOTE = 'heuristic_signal_not_truth';

const DETECTION_CATEGORIES = Object.freeze([
  { key: 'openClass',             name: 'open_class',              conf: CONFIDENCE.OPEN_CLASS },
  { key: 'whQuestion',            name: 'wh_question',             conf: CONFIDENCE.WH_QUESTION },
  { key: 'partialRepeat',         name: 'partial_repeat',          conf: CONFIDENCE.PARTIAL_REPEAT },
  { key: 'candidateUnderstanding', name: 'candidate_understanding', conf: CONFIDENCE.CANDIDATE_UNDERSTANDING }
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Repair Pattern Definitions                                                */
/*                                                                            */
/*  Ordered from most general (open class) to most specific (candidate        */
/*  understanding). Detection stops at first match.                           */
/*                                                                            */
/*  WARNING: These are intentionally broad. False positives are expected      */
/*  and acceptable in OBSERVE mode.                                           */
/* ────────────────────────────────────────────────────────────────────────── */

const OTHER_INITIATED_PATTERNS = Object.freeze({
  openClass: Object.freeze([
    /^(?:huh|what|sorry|pardon|excuse me|come again)\??$/i,
    /^(?:i(?:'m| am) sorry|beg your pardon)\??$/i,
    /^what(?:'s| is) that\??$/i,
    /^say (?:that )?again\??$/i
  ]),

  whQuestion: Object.freeze([
    /^(?:who|what|where|when|why|how|which)\??$/i,
    //  ^ Schegloff et al. (1977) Category 2: bare interrogative word only.
    //    Full wh-questions ("who are you?") are information-seeking, not repair.
    //    Confirmed: Frontiers in Robotics and AI (2024) virtual assistant repair analysis.
    /^what do you mean/i,
    /^what did you (?:say|mean)/i,
    /^who(?:'s| is) that\??$/i,
    /^where(?:'s| is) that\??$/i
  ]),

  partialRepeat: Object.freeze([
    /^the .{1,30}\??$/i,
    /^.{1,20} what\??$/i,
    /^you (?:said|mean) .{1,30}\??$/i
  ]),

  candidateUnderstanding: Object.freeze([
    /^(?:so |oh |wait ).{5,}/i,
    /^you mean .{5,}/i,
    /^do you mean .{5,}/i,
    /^are you saying .{5,}/i,
    /^is that .{5,}/i
  ])
});

const SELF_REPAIR_PATTERNS = Object.freeze([
  /^(?:i mean|that is|rather|actually|well|sorry|correction)/i,
  /^(?:let me (?:rephrase|clarify|try again))/i,
  /^(?:what i meant (?:was|to say))/i
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  RepairHandler Class                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

class RepairHandler {
  constructor() {
    this._observeMode = true;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Match Against Pattern Category                                 */
  /*                                                                          */
  /*  Tests a message against an array of regex patterns.                     */
  /*  Returns the matched pattern string or null.                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _matchCategory(message, patterns) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        return true;
      }
    }
    return null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Detect Other-Initiated Repair                                   */
  /*                                                                          */
  /*  Primary detection method called by EarWig. Analyses user message        */
  /*  for repair initiation signals.                                          */
  /*                                                                          */
  /*  Detection priority (first match wins):                                  */
  /*    1. open_class       — "huh?", "what?" (most general)                 */
  /*    2. wh_question      — "what do you mean?" (specific request)         */
  /*    3. partial_repeat   — "the cheese wars??" (echo + question)          */
  /*    4. candidate_understanding — "so you mean..." (proposing reading)    */
  /*                                                                          */
  /*  @param {string} userMessage — Raw user input                            */
  /*  @returns {object} Repair detection result                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  detectOtherInitiatedRepair(userMessage) {
    const trimmed = (typeof userMessage === 'string') ? userMessage.trim() : '';
    if (!trimmed) {
      return this._noRepairResult(userMessage);
    }


    for (const { key, name, conf } of DETECTION_CATEGORIES) {

      const matchedSource = this._matchCategory(trimmed, OTHER_INITIATED_PATTERNS[key]);
      if (matchedSource) {
        return {
          isRepair: true,
          repairType: 'other_initiated_self_repair',
          category: name,
          confidence: conf,
          originalMessage: userMessage,
          interpretationNote: INTERPRETATION_NOTE
        };
      }
    }

    return this._noRepairResult(userMessage);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: No Repair Result                                               */
  /*                                                                          */
  /*  Consistent return structure when no repair is detected.                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  _noRepairResult(userMessage) {
    return {
      isRepair: false,
      repairType: null,
      category: null,
      confidence: null,
      originalMessage: userMessage,
      interpretationNote: null
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Detect Self-Repair Opportunity                                  */
  /*                                                                          */
  /*  Detects when Claude's own message contains self-correction markers.     */
  /*                                                                          */
  /*  WARNING: Over-inclusive. Flags stylistic hedges like "well", "actually" */
  /*  which may not be true self-repairs.                                     */
  /*                                                                          */
  /*  @param {string} claudeMessage — Claude's current message               */
  /*  @param {string} _previousMessage — UNUSED. Reserved for future         */
  /*                   retrospective comparison.                              */
  /*  @returns {object} Self-repair detection result                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  detectSelfRepairOpportunity(claudeMessage, _previousMessage) {
    if (typeof claudeMessage !== 'string' || !claudeMessage.trim()) {
      return { isSelfRepair: false };
    }

    const trimmed = claudeMessage.trim();

    for (const pattern of SELF_REPAIR_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          isSelfRepair: true,
          repairType: 'self_initiated_self_repair',
          patternSource: pattern.source,
          confidence: CONFIDENCE.SELF_REPAIR,
          interpretationNote: 'heuristic_signal_not_truth_may_be_stylistic_hedge'
        };
      }
    }

    return { isSelfRepair: false };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Initiate Repair                                                 */
  /*                                                                          */
  /*  Records repair initiation in conversation state.                        */
  /*  Called by pipeline phases when acting on a repair signal, NOT by EarWig. */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                   */
  /*  @param {object} repairData — Detection result from above               */
  /*  @returns {object} Repair action descriptor                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  async initiateRepair(conversationId, repairData, correlationId) {
    if (!conversationId || !repairData) {
      logger.warn('initiateRepair called with missing params', {
        hasConversationId: !!conversationId,
        hasRepairData: !!repairData,
        correlationId
      });
      return null;
    }

    try {
      await ConversationStateManager.setRepairInProgress(
        conversationId,
        repairData.repairType,
        {
          category: repairData.category,
          originalMessage: repairData.originalMessage,
          confidence: repairData.confidence,
          initiatedAt: new Date().toISOString(),
          interpretationNote: INTERPRETATION_NOTE
        }
      );

      await ConversationStateManager.recordMove(conversationId, {
        type: 'repair_initiated',
        repairType: repairData.repairType,
        category: repairData.category,
        confidence: repairData.confidence,
        observeMode: this._observeMode,
        interpretationNote: INTERPRETATION_NOTE
      });

      logger.debug('Repair initiated', {
        conversationId,
        repairType: repairData.repairType,
        category: repairData.category,
        correlationId
      });

      return {
        actCode: CATEGORY_TO_DIALOGUE_FUNCTION[repairData.category]
              || 'own_communication_management.self_repair',
        requiresRepair: true,
        repairData
      };
    } catch (error) {
      logger.error('Failed to initiate repair', {
        conversationId,
        error: error.message,
        correlationId
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Complete Repair                                                 */
  /*                                                                          */
  /*  Records repair completion in conversation state.                        */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                   */
  /*  @param {object} completionData — Completion details                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async completeRepair(conversationId, completionData = {}, correlationId) {
    if (!conversationId) return null;

    try {
      await ConversationStateManager.clearRepair(conversationId);

      await ConversationStateManager.recordMove(conversationId, {
        type: 'repair_completed',
        completionMethod: completionData.method || 'clarification',
        success: completionData.success !== false,
        observeMode: this._observeMode,
        interpretationNote: INTERPRETATION_NOTE
      });

      logger.debug('Repair completed', {
        conversationId,
        method: completionData.method || 'clarification',
        correlationId
      });
    } catch (error) {
      logger.error('Failed to complete repair', {
        conversationId,
        error: error.message,
        correlationId
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Is Repair In Progress                                           */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                   */
  /*  @returns {boolean}                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async isRepairInProgress(conversationId) {
    if (!conversationId) return false;

    try {
      const state = await ConversationStateManager.getState(conversationId);
      return state?.repair_in_progress || false;
    } catch (error) {
      logger.error('Failed to check repair state', {
        conversationId,
        error: error.message
      });
      return false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Repair Context                                              */
  /*                                                                          */
  /*  Returns the current repair context if a repair is in progress.          */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                   */
  /*  @returns {object|null}                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getRepairContext(conversationId) {
    if (!conversationId) return null;

    try {
      const state = await ConversationStateManager.getState(conversationId);

      if (!state?.repair_in_progress) return null;

      return {
        repairType: state.repair_type,
        repairSource: state.repair_source,
        inProgress: true
      };
    } catch (error) {
      logger.error('Failed to get repair context', {
        conversationId,
        error: error.message
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Recommended Dialogue Function                               */
  /*                                                                          */
  /*  Maps a repair category to the appropriate LTLM dialogue function        */
  /*  code. Used by response generation to pick the right repair strategy.    */
  /*                                                                          */
  /*  @param {object} repairData — Detection result                          */
  /*  @returns {string} LTLM dialogue function code                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  getRecommendedDialogueFunction(repairData) {
    if (!repairData?.category) return 'own_communication_management.self_repair';
    return CATEGORY_TO_DIALOGUE_FUNCTION[repairData.category]
        || 'own_communication_management.self_repair';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Recommended Speech Act                                      */
  /*                                                                          */
  /*  @param {object} repairData — Detection result                          */
  /*  @returns {string} Speech act code                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  getRecommendedSpeechAct(repairData) {
    if (!repairData?.category) return 'assertive.explain';
    return CATEGORY_TO_SPEECH_ACT[repairData.category]
        || 'assertive.explain';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Observe Mode Control                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  setObserveMode(enabled) {
    this._observeMode = enabled === true;
    logger.info('Observe mode changed', { observeMode: this._observeMode });
  }

  isObserveMode() {
    return this._observeMode;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Repair Statistics                                               */
  /*                                                                          */
  /*  Returns repair event counts for a conversation.                         */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                   */
  /*  @returns {object} Repair stats                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getRepairStats(conversationId) {
    if (!conversationId) {
      return { totalRepairs: 0, completed: 0, categories: {} };
    }

    try {
      const state = await ConversationStateManager.getState(conversationId);

      if (!state?.last_moves) {
        return { totalRepairs: 0, completed: 0, categories: {} };
      }

      if (!Array.isArray(state.last_moves)) return { totalRepairs: 0, completed: 0, categories: {} };

      const repairEvents = state.last_moves.filter(
        m => m.type === 'repair_initiated' || m.type === 'repair_completed'
      );

      const initiated = repairEvents.filter(e => e.type === 'repair_initiated');
      const completed = repairEvents.filter(e => e.type === 'repair_completed');

      const categories = {};
      for (const event of initiated) {
        const cat = event.category || 'unknown';
        categories[cat] = (categories[cat] || 0) + 1;
      }

      return {
        totalRepairs: initiated.length,
        completed: completed.length,
        categories
      };
    } catch (error) {
      logger.error('Failed to get repair stats', {
        conversationId,
        error: error.message
      });
      return { totalRepairs: 0, completed: 0, categories: {} };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Repair Preference Hierarchy                                     */
  /*                                                                          */
  /*  Returns the Schegloff et al. (1977) preference ordering.               */
  /*  Lower index = more preferred repair type.                               */
  /*                                                                          */
  /*  @returns {string[]} Ordered repair types                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  getRepairPreferenceHierarchy() {
    return [...REPAIR_PREFERENCE_HIERARCHY];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new RepairHandler();
