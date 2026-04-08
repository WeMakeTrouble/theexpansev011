/**
 * ============================================================================
 * PhaseClaudesHelpDesk.js — Tri-Mode World Break Detection & Routing (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Detects when users "step out" of their current reality and need assistance:
 *
 * 1. HUMAN stepping into real-world helpdesk (commerce, business, support)
 * 2. B-ROLL character asking genuine realm questions (learning, paradox, social)
 * 3. GRONK anonymous visitor discovering the project
 *
 * Routes to appropriate helpdesk mode with full metadata for downstream
 * decision-making (handoffs, escalations, conversational tone, funnel stage).
 *
 * CONCEPT: MULTIPLE WORLDS
 * -------------------------
 * Users operate in ONE of three contexts simultaneously:
 *   - In-World (Multiverse): Claude is Narrator/Guide
 *   - Real-World (HelpDesk): Claude is Shopkeeper/Support
 *   - Realm-Inquiry (B-Roll): Claude is Mentor/Witness
 *   - Discovery (GRONK): Claude is Ambassador
 *
 * This phase detects which context is active and provides the signal.
 *
 * ESCALATION MODEL
 * -----------------
 * HUMAN escalations are immediate:
 *   - LEGAL_RISK always escalates (no conversation)
 *   - VIP/BUSINESS go to handoff (high priority)
 *
 * B-ROLL escalations are repetition-based:
 *   - Tracked in dossier.helpdeskContext.repetitionCount
 *   - Escalates when count >= repeatedThreshold from metadata
 *   - Optional: decay/time-window logic in HelpdeskDossierService
 *   - Allows observation of stuck loops before intervention
 *
 * WORLD BREAK TYPE PRIORITY
 * --------------------------
 * When multiple world breaks detected, type acts as tiebreaker:
 *   - EPISTEMIC (B-Roll paradox/existential) overrides TRANSACTIONAL
 *   - TRANSACTIONAL (commerce/business) overrides DISCOVERY
 *   - DISCOVERY (GRONK) is baseline
 *
 * Epistemic override is dynamic: routes to the highest-priority epistemic
 * intent's mode (e.g. NARRATIVE_PARADOX -> b_roll_paradox, not hardcoded
 * to b_roll_identity).
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - detectUserType() rewritten: uses user.userId for HUMAN, DB lookup of
 *   character_profiles.category against B_ROLL_AUTONOMOUS_CATEGORIES for
 *   B_ROLL, fallback to GRONK. The v009 version checked a dead
 *   identityContext.characterId field that was never populated.
 * - B_ROLL signals.hasCharacter now reads session.owned_character_id.
 * - GRONK signals.isLoggedOut now reads session.owned_character_id.
 * - 6 if/else helper functions consolidated into CONFIG_BY_USER_TYPE map.
 * - Logger switched to createModuleLogger (structured, correlation IDs).
 * - v010 documentation header.
 * - All scoring, dampening, priority, escalation logic preserved exactly.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Determine user type (logged-in human, B-Roll character, anonymous)
 *  - Detect helpdesk intents across all three modes
 *  - Calculate weighted & normalized intent strength per mode
 *  - Distinguish world break TYPE (transactional vs epistemic vs discovery)
 *  - Apply world break type priority when conflicts exist (dynamically)
 *  - Flag critical repeating signals (escalation candidates)
 *  - Expose full helpdesk context for PhaseVoice + downstream services
 *
 * NON-GOALS
 * ---------
 *  - No response generation (PhaseVoice handles)
 *  - No transaction processing (Services handle)
 *  - No session mutation
 *  - No turn termination
 *  - No repetition counting (dossier layer handles)
 *
 * INVARIANTS
 * ----------
 *  - Never mutates session
 *  - Returns safe defaults on missing inputs
 *  - Never returns terminal:true (enrichment only)
 *  - LEGAL_RISK always escalates (human only)
 *  - Repeated critical signals flag escalation candidate
 *  - Weighted score and normalized strength are always in sync
 *  - Epistemic override mode is determined by actual detected intent,
 *    not hardcoded
 *  - DB lookup for B_ROLL detection only runs when user.userId is absent
 *    (most turns skip it entirely)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import pool from '../../db/pool.js';
import helpdeskDossierService from '../../services/HelpdeskDossierService.js';
import {
  HUMAN_HELPDESK_INTENTS,
  B_ROLL_REALM_INTENTS,
  GRONK_INTENTS,
  HUMAN_HELPDESK_WEIGHTS,
  B_ROLL_REALM_WEIGHTS,
  GRONK_WEIGHTS,
  HELPDESK_MODES,
  HUMAN_INTENT_TO_MODE_MAP,
  B_ROLL_INTENT_TO_MODE_MAP,
  GRONK_INTENT_TO_MODE_MAP,
  HUMAN_HELPDESK_METADATA,
  B_ROLL_REALM_METADATA,
  GRONK_METADATA,
  STRENGTH_THRESHOLDS,
  B_ROLL_AUTONOMOUS_CATEGORIES
} from '../config/helpdeskIntents.js';

const logger = createModuleLogger('PhaseClaudesHelpDesk');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const USER_TYPES = Object.freeze({
  HUMAN: 'human',
  B_ROLL: 'b_roll',
  GRONK: 'gronk'
});

const WORLD_BREAK_TYPES = Object.freeze({
  TRANSACTIONAL: 'transactional',
  EPISTEMIC: 'epistemic',
  DISCOVERY: 'discovery'
});

const WORLD_BREAK_TYPE_PRIORITY = Object.freeze({
  discovery: 1,
  transactional: 2,
  epistemic: 3
});

const EPISTEMIC_INTENTS = Object.freeze([
  'NARRATIVE_PARADOX',
  'EXISTENTIAL_CRISIS',
  'RELATIONSHIP_CONFLICT',
  'SOCIAL_REASONING',
  'EMOTIONAL_STATE',
  'SYSTEM_MECHANICS'
]);

const LONG_PROMPT_THRESHOLD = 4000;
const LONG_PROMPT_DAMPENING = 0.7;

const PRIORITY_ORDER_HUMAN = Object.freeze([
  'LEGAL_RISK',
  'VIP',
  'BUSINESS',
  'ORDER_SUPPORT',
  'COMMERCE',
  'TECH_SUPPORT',
  'FEEDBACK',
  'SIGNUP',
  'INQUIRY'
]);

const PRIORITY_ORDER_B_ROLL = Object.freeze([
  'NARRATIVE_PARADOX',
  'EXISTENTIAL_CRISIS',
  'RELATIONSHIP_CONFLICT',
  'SOCIAL_REASONING',
  'EMOTIONAL_STATE',
  'SYSTEM_MECHANICS',
  'LORE_CONFUSION',
  'IDENTITY_INQUIRY',
  'BELT_UNDERSTANDING',
  'RELATIONSHIP_INQUIRY'
]);

const PRIORITY_ORDER_GRONK = Object.freeze([
  'PRODUCT_CURIOSITY',
  'HOW_TO_START',
  'CREATOR_INTEREST',
  'WHAT_IS_THIS',
  'GENERAL_INTEREST'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Per-User-Type Configuration Map                                           */
/*                                                                            */
/*  Replaces 6 separate if/else helper functions from v009.                  */
/*  Single lookup for all mode-specific config per user type.                */
/* ────────────────────────────────────────────────────────────────────────── */

const CONFIG_BY_USER_TYPE = Object.freeze({
  [USER_TYPES.HUMAN]: {
    intents: HUMAN_HELPDESK_INTENTS,
    weights: HUMAN_HELPDESK_WEIGHTS,
    priorityOrder: PRIORITY_ORDER_HUMAN,
    maxWeightedScore: STRENGTH_THRESHOLDS.MAX_WEIGHTED_SCORE_HUMAN,
    modeMap: HUMAN_INTENT_TO_MODE_MAP,
    metadata: HUMAN_HELPDESK_METADATA,
    worldBreakType: WORLD_BREAK_TYPES.TRANSACTIONAL
  },
  [USER_TYPES.B_ROLL]: {
    intents: B_ROLL_REALM_INTENTS,
    weights: B_ROLL_REALM_WEIGHTS,
    priorityOrder: PRIORITY_ORDER_B_ROLL,
    maxWeightedScore: STRENGTH_THRESHOLDS.MAX_WEIGHTED_SCORE_B_ROLL,
    modeMap: B_ROLL_INTENT_TO_MODE_MAP,
    metadata: B_ROLL_REALM_METADATA,
    worldBreakType: WORLD_BREAK_TYPES.EPISTEMIC
  },
  [USER_TYPES.GRONK]: {
    intents: GRONK_INTENTS,
    weights: GRONK_WEIGHTS,
    priorityOrder: PRIORITY_ORDER_GRONK,
    maxWeightedScore: STRENGTH_THRESHOLDS.MAX_WEIGHTED_SCORE_GRONK,
    modeMap: GRONK_INTENT_TO_MODE_MAP,
    metadata: GRONK_METADATA,
    worldBreakType: WORLD_BREAK_TYPES.DISCOVERY
  }
});

const DEFAULT_CONFIG = Object.freeze({
  intents: {},
  weights: {},
  priorityOrder: [],
  maxWeightedScore: 5.0,
  modeMap: {},
  metadata: {},
  worldBreakType: null
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helper Functions                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Extracts raw text from command (string, object with content, or messages array).
 * @param {string|object} command - The raw command input
 * @returns {string} Extracted text
 */
function extractText(command) {
  if (typeof command === 'string') {
    return command;
  }
  if (command?.content) {
    return command.content;
  }
  if (Array.isArray(command?.messages)) {
    return command.messages.map(m => m.content || '').join('\n');
  }
  return '';
}

/**
 * Normalizes text for intent matching: lowercase, strip diacritics.
 * @param {string} text - Raw text
 * @returns {string} Normalized text
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Determines user type from session context.
 *
 * HUMAN: user.userId exists (logged-in user with account).
 * B_ROLL: No user.userId, but session.owned_character_id matches a character
 *         whose category is in B_ROLL_AUTONOMOUS_CATEGORIES.
 *         Requires single-row DB lookup by primary key (fast, rare path).
 * GRONK: Neither — anonymous visitor.
 *
 * @param {object} user - User object from turnState
 * @param {object} session - Session object from turnState
 * @param {string} correlationId - For logging
 * @returns {Promise<string>} USER_TYPES.HUMAN | B_ROLL | GRONK
 */
async function detectUserType(user, session, correlationId) {
  if (user?.userId) {
    return USER_TYPES.HUMAN;
  }

  const characterId = session?.owned_character_id;
  if (characterId) {
    try {
      const result = await pool.query({
        text: 'SELECT category FROM character_profiles WHERE character_id = $1',
        values: [characterId],
        query_timeout: 2000
      });

      if (result.rows.length > 0) {
        const category = result.rows[0].category;
        if (B_ROLL_AUTONOMOUS_CATEGORIES.includes(category)) {
          logger.debug('B_ROLL character detected via category lookup', {
            correlationId,
            characterId,
            category
          });
          return USER_TYPES.B_ROLL;
        }
      }
    } catch (dbError) {
      logger.warn('Character category lookup failed, defaulting to GRONK', {
        correlationId,
        characterId,
        error: dbError.message
      });
    }
  }

  return USER_TYPES.GRONK;
}

/**
 * Detects intents from normalized text using regex patterns and weights.
 * @param {string} normalized - Normalized input text
 * @param {object} intentSet - Frozen regex patterns keyed by intent name
 * @param {object} weightSet - Frozen weights keyed by intent name
 * @returns {{ detected: string[], weightedScore: number }}
 */
function detectIntentsWithScoring(normalized, intentSet, weightSet) {
  const detected = [];
  let weightedScore = 0;

  for (const [intentName, pattern] of Object.entries(intentSet)) {
    if (pattern.test(normalized)) {
      detected.push(intentName);
      weightedScore += weightSet[intentName] || 1.0;
    }
  }

  return { detected, weightedScore };
}

/**
 * Selects the highest-priority intent from detected intents.
 * @param {string[]} detectedIntents - All matched intents
 * @param {string[]} priorityOrder - Intents ordered by priority (highest first)
 * @returns {string|null} Highest-priority detected intent, or null
 */
function determinePrimaryIntent(detectedIntents, priorityOrder) {
  for (const priority of priorityOrder) {
    if (detectedIntents.includes(priority)) {
      return priority;
    }
  }
  return null;
}

/**
 * Finds the highest-priority epistemic intent from detected intents.
 * Used for epistemic override when HUMAN has transactional + epistemic signals.
 * @param {string[]} detectedIntents - All matched intents
 * @returns {string|null} Highest-priority epistemic intent, or null
 */
function getHighestPriorityEpistemicIntent(detectedIntents) {
  for (const epistemic of EPISTEMIC_INTENTS) {
    if (detectedIntents.includes(epistemic)) {
      return epistemic;
    }
  }
  return null;
}

/**
 * Applies world break type priority override.
 * When a HUMAN user has both transactional and epistemic signals,
 * epistemic overrides transactional (deeper inquiry needed).
 * Mode is set dynamically to the highest-priority epistemic intent's mode.
 *
 * @param {string} primaryMode - Current primary mode
 * @param {string} worldBreakType - Current world break type
 * @param {string[]} detectedIntents - All matched intents
 * @param {string} userType - USER_TYPES value
 * @param {object} modeMap - Intent-to-mode mapping
 * @returns {string} Final mode (may be overridden)
 */
function applyWorldBreakTypePriority(primaryMode, worldBreakType, detectedIntents, userType, modeMap) {
  // Defensive future-proofing: redundant with current WORLD_BREAK_TYPE_PRIORITY config
  // (epistemic = 3, transactional = 2), but guards against silent breakage if
  // priority values are ever changed without updating this logic.
  if (worldBreakType === WORLD_BREAK_TYPES.EPISTEMIC &&
      WORLD_BREAK_TYPE_PRIORITY[WORLD_BREAK_TYPES.EPISTEMIC] >
      WORLD_BREAK_TYPE_PRIORITY[WORLD_BREAK_TYPES.TRANSACTIONAL]) {

    const hasEpistemicSignal = detectedIntents.some(i => EPISTEMIC_INTENTS.includes(i));

    if (hasEpistemicSignal && userType === USER_TYPES.HUMAN) {
      const highestEpistemicIntent = getHighestPriorityEpistemicIntent(detectedIntents);

      if (highestEpistemicIntent && modeMap[highestEpistemicIntent]) {
        return modeMap[highestEpistemicIntent];
      }
    }
  }

  return primaryMode;
}

/**
 * Checks if a B-Roll intent should flag an escalation candidate.
 * Only B-Roll intents can escalate (repetition-based, not immediate).
 *
 * @param {string|null} primaryIntent - The primary detected intent
 * @param {string} userType - USER_TYPES value
 * @param {object} metadata - Intent metadata
 * @param {boolean} escalationCandidate - Whether critical + repeatable
 * @returns {object} Escalation context
 */
function checkEscalation(primaryIntent, userType, metadata, escalationCandidate) {
  if (userType !== USER_TYPES.B_ROLL) {
    return { requiresEscalation: false };
  }

  const escalateIfRepeated = metadata?.escalateIfRepeated || false;
  const repeatedThreshold = metadata?.repeatedThreshold || 0;
  const escalationReason = metadata?.escalationReason || null;

  return {
    requiresEscalation: escalateIfRepeated,
    repeatedThreshold,
    escalationReason,
    trackingMethod: 'helpdeskContext.repetitionCount in dossier',
    decayStrategy: 'optional — implement in HelpdeskDossierService (time-window, exponential decay)',
    description: 'Escalate when repetitionCount >= repeatedThreshold',
    escalationCandidate
  };
}

/**
 * Builds mode-specific signals object based on user type and detected intents.
 *
 * @param {string} userType - USER_TYPES value
 * @param {object} session - Session object
 * @param {object} user - User object
 * @param {string[]} detectedIntents - All matched intents
 * @param {object} metadata - Intent metadata
 * @returns {object} Signals for downstream consumers
 */
function buildSignals(userType, session, user, detectedIntents, metadata) {
  if (userType === USER_TYPES.HUMAN) {
    return {
      hasDossier: !!session?.dossier,
      isVipUser: session?.access_level >= 10,
      isBusinessLead: detectedIntents.includes('BUSINESS'),
      isLegalRisk: detectedIntents.includes('LEGAL_RISK'),
      isOrderSupport: detectedIntents.includes('ORDER_SUPPORT'),
      hasCommerceIntent: detectedIntents.includes('COMMERCE'),
      hasSupportIntent: detectedIntents.includes('TECH_SUPPORT'),
      hasSignupIntent: detectedIntents.includes('SIGNUP'),
      hasFeedbackIntent: detectedIntents.includes('FEEDBACK'),
      hasInquiryIntent: detectedIntents.includes('INQUIRY')
    };
  }

  if (userType === USER_TYPES.B_ROLL) {
    return {
      hasCharacter: !!session?.owned_character_id,
      isParadoxLoop: detectedIntents.includes('NARRATIVE_PARADOX'),
      isExistentialCrisis: detectedIntents.includes('EXISTENTIAL_CRISIS'),
      isSocialConflict: detectedIntents.includes('RELATIONSHIP_CONFLICT'),
      isCollaborativeReasoning: detectedIntents.includes('SOCIAL_REASONING'),
      isMetaQuestionable: detectedIntents.includes('SYSTEM_MECHANICS'),
      loggingImportance: metadata?.loggingImportance || 'medium',
      feedsTSE: metadata?.feedsTSE || false,
      requiresNarrationUpdate: metadata?.requiresNarrationUpdate || false
    };
  }

  if (userType === USER_TYPES.GRONK) {
    return {
      isLoggedOut: !user?.userId && !session?.owned_character_id,
      conversionReady: detectedIntents.includes('PRODUCT_CURIOSITY') || detectedIntents.includes('HOW_TO_START'),
      funnel_stage: metadata?.funnel_stage || 'awareness',
      canOfferNewsletter: metadata?.canOfferNewsletter || false,
      shouldDirectToPurchase: metadata?.shouldDirectToPurchase || false
    };
  }

  return {};
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseClaudesHelpDesk Handler                                               */
/* ────────────────────────────────────────────────────────────────────────── */

const PhaseClaudesHelpDesk = {
  async execute(turnState) {
    const { session, command, correlationId, user, diagnosticReport } = turnState;

    logger.debug('Executing', { correlationId });

    const repairSignals = diagnosticReport?.rawModules?.repair ?? null;
    const emotionalContext = diagnosticReport?.rawModules?.emotionalContext ?? null;
    const postureRecommendation = diagnosticReport?.postureRecommendation ?? 'unknown';
    const diagnosticConfidence = diagnosticReport?.confidence ?? 0;

    logger.debug('DiagnosticReport received', {
      correlationId,
      hasReport: !!diagnosticReport,
      posture: postureRecommendation,
      confidence: diagnosticConfidence,
      repairDetected: repairSignals?.isRepair ?? false,
      consecutiveNegativeTurns: emotionalContext?.consecutiveNegativeTurns ?? 0
    });

    const diagnosticSummary = {
      posture: postureRecommendation,
      confidence: diagnosticConfidence,
      repairDetected: repairSignals?.isRepair ?? false,
      repairType: repairSignals?.repairType ?? null,
      consecutiveNegativeTurns: emotionalContext?.consecutiveNegativeTurns ?? 0,
      emotionalTrajectory: emotionalContext?.trajectory ?? 'unknown'
    };

    /* ──────────────────────────────────────────────────────────────────── */
    /*  1. Extract and normalize text                                       */
    /* ──────────────────────────────────────────────────────────────────── */

    const rawText = extractText(command);
    const normalized = normalizeText(rawText);
    const isLongPrompt = normalized.length > LONG_PROMPT_THRESHOLD;

    if (normalized.length === 0) {
      logger.debug('Empty command, skipping', { correlationId });
      return {
        helpdeskContext: {
          userType: USER_TYPES.GRONK,
          worldBreakDetected: false,
          worldBreakType: null,
          mode: HELPDESK_MODES.NONE,
          detectedIntents: [],
          primaryIntent: null,
          rawWeightedScore: '0.00',
          normalizedWeightedScore: '0.00',
          strength: '0.00',
          strongSignal: false,
          criticalSignal: false,
          signals: {},
          metadata: {},
          escalation: { requiresEscalation: false },
          isLongPrompt: false,
          diagnosticSummary
        }
      };
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  2. Determine user type (HUMAN, B_ROLL, GRONK)                       */
    /* ──────────────────────────────────────────────────────────────────── */

    const userType = await detectUserType(user, session, correlationId);

    logger.debug('User type detected', {
      correlationId,
      userType
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  3. Load mode-specific config from lookup map                        */
    /* ──────────────────────────────────────────────────────────────────── */

    const config = CONFIG_BY_USER_TYPE[userType] || DEFAULT_CONFIG;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4. Detect intents with weighted scoring                             */
    /* ──────────────────────────────────────────────────────────────────── */

    const { detected: detectedIntents, weightedScore: rawWeightedScore } =
      detectIntentsWithScoring(normalized, config.intents, config.weights);

    let normalizedWeightedScore = rawWeightedScore;
    let helpdeskStrength = Math.min(1, normalizedWeightedScore / config.maxWeightedScore);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  5. Apply long-prompt dampening (reduce false positives)             */
    /* ──────────────────────────────────────────────────────────────────── */

    if (isLongPrompt && helpdeskStrength > 0) {
      const originalStrength = helpdeskStrength;
      helpdeskStrength *= LONG_PROMPT_DAMPENING;
      normalizedWeightedScore *= LONG_PROMPT_DAMPENING;

      logger.debug('Long prompt dampening applied', {
        correlationId,
        originalStrength: originalStrength.toFixed(2),
        dampenedStrength: helpdeskStrength.toFixed(2)
      });
    }

    const worldBreakDetected = helpdeskStrength >= STRENGTH_THRESHOLDS.WORLD_BREAK_THRESHOLD;
    const strongSignal = helpdeskStrength >= STRENGTH_THRESHOLDS.STRONG_SIGNAL_THRESHOLD;
    const criticalSignal = helpdeskStrength >= STRENGTH_THRESHOLDS.CRITICAL_SIGNAL_THRESHOLD;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  6. Determine primary intent (with priority rules)                   */
    /* ──────────────────────────────────────────────────────────────────── */

    const primaryIntent = worldBreakDetected
      ? determinePrimaryIntent(detectedIntents, config.priorityOrder)
      : null;

    let primaryMode = primaryIntent
      ? config.modeMap[primaryIntent] || HELPDESK_MODES.NONE
      : HELPDESK_MODES.NONE;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  7. Determine world break type                                       */
    /* ──────────────────────────────────────────────────────────────────── */

    const worldBreakType = worldBreakDetected
      ? config.worldBreakType
      : null;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  8. Apply world break type priority (epistemic > transactional)       */
    /* ──────────────────────────────────────────────────────────────────── */

    if (worldBreakDetected && worldBreakType) {
      primaryMode = applyWorldBreakTypePriority(
        primaryMode,
        worldBreakType,
        detectedIntents,
        userType,
        config.modeMap
      );
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  9. Get intent metadata                                              */
    /* ──────────────────────────────────────────────────────────────────── */

    const metadata = primaryIntent
      ? (config.metadata[primaryIntent] || {})
      : {};

    /* ──────────────────────────────────────────────────────────────────── */
    /*  10. Check for escalation signals (B-Roll only)                      */
    /* ──────────────────────────────────────────────────────────────────── */

    const escalationCandidate = criticalSignal && !!metadata?.escalateIfRepeated;
    const escalation = checkEscalation(primaryIntent, userType, metadata, escalationCandidate);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  10b. Persist helpdesk signal to dossier (if world break detected)  */
    /* ──────────────────────────────────────────────────────────────────── */

    if (worldBreakDetected && primaryIntent && user?.userId) {
      try {
        const dossierResult = await pool.query(
          'SELECT dossier_id FROM cotw_dossiers WHERE user_id = $1 AND dossier_type = $2',
          [user.userId, 'user']
        );
        if (dossierResult.rows.length > 0) {
          const dossierId = dossierResult.rows[0].dossier_id;
          await helpdeskDossierService.recordSignal(
            dossierId, primaryIntent, userType, parseFloat(helpdeskStrength.toFixed(2)), correlationId
          );
        }
      } catch (dossierErr) {
        logger.warn('HelpdeskDossierService recordSignal failed, non-fatal', {
          correlationId,
          primaryIntent,
          error: dossierErr.message
        });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  11. Build mode-specific signals                                     */
    /* ──────────────────────────────────────────────────────────────────── */

    const signals = buildSignals(userType, session, user, detectedIntents, metadata);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  12. Log world break and critical signals                            */
    /* ──────────────────────────────────────────────────────────────────── */

    if (worldBreakDetected) {
      if (userType === USER_TYPES.HUMAN && detectedIntents.includes('LEGAL_RISK')) {
        logger.warn('LEGAL_RISK detected - ESCALATION REQUIRED', {
          correlationId,
          userType,
          worldBreakType,
          mode: primaryMode,
          intents: detectedIntents,
          strength: helpdeskStrength.toFixed(2)
        });
      } else if (userType === USER_TYPES.B_ROLL && escalation.requiresEscalation) {
        logger.warn('B-Roll escalation candidate detected', {
          correlationId,
          worldBreakType,
          primaryIntent,
          escalationReason: escalation.escalationReason,
          repeatedThreshold: escalation.repeatedThreshold,
          strength: helpdeskStrength.toFixed(2)
        });
      } else {
        logger.info('World break detected', {
          correlationId,
          userType,
          worldBreakType,
          mode: primaryMode,
          primaryIntent,
          intents: detectedIntents,
          strength: helpdeskStrength.toFixed(2)
        });
      }
    } else {
      logger.debug('Staying in-world', {
        correlationId,
        userType
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  13. Return helpdesk context with full metadata                      */
    /* ──────────────────────────────────────────────────────────────────── */

    return {
      helpdeskContext: {
        userType,
        worldBreakDetected,
        worldBreakType,
        mode: primaryMode,
        detectedIntents,
        primaryIntent,
        rawWeightedScore: rawWeightedScore.toFixed(2),
        normalizedWeightedScore: normalizedWeightedScore.toFixed(2),
        strength: helpdeskStrength.toFixed(2),
        strongSignal,
        criticalSignal,
        signals,
        metadata,
        escalation,
        isLongPrompt,
        diagnosticSummary
      }
    };
  }
};

export default PhaseClaudesHelpDesk;
