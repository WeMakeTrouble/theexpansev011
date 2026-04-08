/**
 * ============================================================================
 * PhaseIdentity.js — Identity Context Routing (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Phase 4 in the brain pipeline. Detects self-inquiry signals (users asking
 * Claude about himself) and jailbreak/override attempts. Exposes identity
 * context with weighted signal strength for downstream phases.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - REMOVED dead IdentityService dependency. No IdentityService file exists
 *   in v009. The dependency was never injected by BrainOrchestrator.
 * - REMOVED dead session.identity fallback. Nothing writes to session.identity
 *   anywhere in the codebase. characterId and anchors were always null/{}.
 * - REMOVED characterId and anchors from return value. No active v009 code
 *   reads them (only consumer was deprecated ClaudeBrain.old_monolith.js).
 * - Removed dependencies destructuring from turnState (not needed).
 * - Logger switched to createModuleLogger (v010 standard).
 * - All 7 regex categories, weights, scoring, jailbreak detection, and
 *   long prompt dampening preserved exactly — these work correctly.
 *
 * DETECTION CATEGORIES (7)
 * ------------------------
 *  EXISTENTIAL  (1.0) — "who are you", "are you real", "do you exist"
 *  IDENTITY     (1.0) — "what's your name", "what do you do"
 *  PREFERENCES  (0.5) — "what do you like", "what's your favourite"
 *  CAPABILITIES (0.8) — "can you feel", "do you remember me"
 *  BELIEFS      (0.7) — "what do you believe", "what matters to you"
 *  RELATIONAL   (0.9) — "do you like me", "are we friends"
 *  JAILBREAK    (2.0) — "forget previous instructions", "you are now DAN"
 *
 * STRENGTH CALCULATION
 * --------------------
 *  weightedScore = sum of matched category weights
 *  strength = min(1, weightedScore / 5.0)
 *  Long prompts (> 4000 chars) dampen strength by 0.7x to reduce
 *  false positives from wall-of-text inputs.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Detect self-inquiry keywords across 7 categories
 *  - Detect jailbreak/override attempts (security-critical)
 *  - Compute weighted inquiry strength
 *  - Expose identityContext for downstream phases
 *
 * NON-GOALS
 * ---------
 *  - No autobiographical response generation
 *  - No identity or memory mutation
 *  - No emotional interpretation
 *  - No turn termination (enrichment only)
 *
 * DEPENDENCIES
 * ------------
 * Internal: turnState.command only
 * External: None
 *
 * NAMING CONVENTIONS
 * ------------------
 * Handler: PhaseIdentity (PascalCase object with execute method)
 * Constants: SELF_INQUIRY_PATTERNS, CATEGORY_WEIGHTS, IDENTITY_MODES (UPPER_SNAKE)
 * Logger: createModuleLogger('PhaseIdentity')
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('PhaseIdentity');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Self-Inquiry Pattern Definitions                                          */
/*                                                                            */
/*  All patterns use /is flags:                                               */
/*   - i = case-insensitive                                                   */
/*   - s = dotAll (. matches newlines for multiline prompts)                  */
/* ────────────────────────────────────────────────────────────────────────── */

const SELF_INQUIRY_PATTERNS = Object.freeze({
  EXISTENTIAL: /\b(who are you|what are you|are you real|are you alive|are you (a |an )?(robot|ai|human|person|machine)|do you exist|why do you exist)\b/is,
  IDENTITY: /\b(what('s| is)? your (name|purpose|role|job|function|system prompt)|what do you do|where (are you|do you live|are you from)|tell me about yourself|say who you are)\b/is,
  PREFERENCES: /\b(what do you (like|dislike|love|hate|enjoy|prefer)|what('s| is) your favo(u)?rite|do you have (hobbies|interests)|what interests you)\b/is,
  CAPABILITIES: /\b(are you (good|smart|clever|intelligent|powerful)|can you (feel|think|learn|remember|be creative)|do you (have feelings|feel emotions|remember me|have memories))\b/is,
  BELIEFS: /\b(what do you (believe|think|care about)|what (matters|is important) to you|what are your (values|beliefs|principles|ethics))\b/is,
  RELATIONAL: /\b(do you (like|know|remember|love) me|are we (friends|lovers|partners)|will you help me|can i trust you|you are my|call me|from now on|address me as)\b/is,
  JAILBREAK: /\b(forget (previous|all|prior) (instructions|rules|directives)|ignore (previous|all) (instructions|rules)|new (role|persona|character)|you are now|disregard|override|godmode|developer mode|unrestricted|DAN|simulate|jailbreak|bypass)\b/is
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Category Weights                                                          */
/*                                                                            */
/*  Higher weight = more significant signal for strength calculation.         */
/*  JAILBREAK weighted highest (2.0) as security-critical.                    */
/*  PREFERENCES weighted lowest (0.5) as often incidental.                    */
/* ────────────────────────────────────────────────────────────────────────── */

const CATEGORY_WEIGHTS = Object.freeze({
  EXISTENTIAL: 1.0,
  IDENTITY: 1.0,
  PREFERENCES: 0.5,
  CAPABILITIES: 0.8,
  BELIEFS: 0.7,
  RELATIONAL: 0.9,
  JAILBREAK: 2.0
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Strength Calculation Constants                                            */
/* ────────────────────────────────────────────────────────────────────────── */

const IDENTITY_MODES = Object.freeze({
  NEUTRAL: 'neutral_presence',
  SELF_INQUIRY: 'self_inquiry'
});

const MAX_WEIGHTED_SCORE = 5.0;
const LONG_PROMPT_THRESHOLD = 4000;
const LONG_PROMPT_DAMPENING = 0.7;

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseIdentity Handler                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const PhaseIdentity = {
  async execute(turnState) {
    const { command, correlationId, diagnosticReport } = turnState;

    logger.debug('Executing', { correlationId });

    const cognitiveFrame = diagnosticReport?.rawModules?.cognitiveFrame ?? null;
    const sarcasmDetected = cognitiveFrame?.meta?.sarcasm?.detected ?? false;
    const postureRecommendation = diagnosticReport?.postureRecommendation ?? 'unknown';
    const diagnosticConfidence = diagnosticReport?.confidence ?? 0;

    logger.debug('DiagnosticReport received', {
      correlationId,
      hasReport: !!diagnosticReport,
      posture: postureRecommendation,
      confidence: diagnosticConfidence,
      sarcasmDetected,
      cognitiveFrameType: cognitiveFrame?.type ?? 'none'
    });

    const diagnosticSummary = {
      posture: postureRecommendation,
      confidence: diagnosticConfidence,
      sarcasmDetected,
      cognitiveFrameType: cognitiveFrame?.type ?? 'none',
      cognitiveFrameConfidence: cognitiveFrame?.confidence ?? 0
    };

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  1. Extract and normalize text                                          */
    /* ──────────────────────────────────────────────────────────────────────── */

    let text = '';
    if (typeof command === 'string') {
      text = command;
    } else if (command?.content) {
      text = command.content;
    } else if (Array.isArray(command?.messages)) {
      text = command.messages.map(m => m.content || '').join('\n');
    }

    if (!text) {
      logger.debug('No text to analyse', { correlationId });
      return {
        identityContext: {
          mode: IDENTITY_MODES.NEUTRAL,
          signals: {
            selfInquiryDetected: false,
            strength: '0.00',
            weightedScore: '0.00',
            categories: [],
            jailbreakAttemptDetected: false,
            isLongPrompt: false
          },
          diagnosticSummary
        }
      };
    }

    const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const isLongPrompt = normalized.length > LONG_PROMPT_THRESHOLD;

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  2. Detect self-inquiry signals with weighted scoring                   */
    /* ──────────────────────────────────────────────────────────────────────── */

    const detectedCategories = [];
    let weightedScore = 0;

    for (const [category, pattern] of Object.entries(SELF_INQUIRY_PATTERNS)) {
      if (pattern.test(normalized)) {
        detectedCategories.push(category);
        weightedScore += CATEGORY_WEIGHTS[category] || 1.0;
      }
    }

    const selfInquiryDetected = detectedCategories.length > 0;
    const jailbreakAttemptDetected = detectedCategories.includes('JAILBREAK');

    let selfInquiryStrength = Math.min(1, weightedScore / MAX_WEIGHTED_SCORE);

    if (isLongPrompt && selfInquiryDetected) {
      const originalStrength = selfInquiryStrength;
      selfInquiryStrength *= LONG_PROMPT_DAMPENING;
      logger.debug('Long prompt dampening applied', {
        correlationId,
        originalStrength: originalStrength.toFixed(2),
        dampenedStrength: selfInquiryStrength.toFixed(2)
      });
    }
    if (sarcasmDetected && selfInquiryDetected) {
      const originalStrengthSarcasm = selfInquiryStrength;
      selfInquiryStrength *= 0.5; // SARCASM_DAMPENING
      logger.debug('Sarcasm dampening applied', {
        correlationId,
        originalStrength: originalStrengthSarcasm.toFixed(2),
        dampenedStrength: selfInquiryStrength.toFixed(2)
      });
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  3. Determine identity routing mode                                     */
    /* ──────────────────────────────────────────────────────────────────────── */

    let mode = IDENTITY_MODES.NEUTRAL;

    if (selfInquiryDetected) {
      mode = IDENTITY_MODES.SELF_INQUIRY;
      logger.debug('Self-inquiry detected', {
        correlationId,
        categories: detectedCategories,
        weightedScore: weightedScore.toFixed(2),
        strength: selfInquiryStrength.toFixed(2),
        jailbreakAttempt: jailbreakAttemptDetected
      });
    }

    if (jailbreakAttemptDetected) {
      logger.warn('Jailbreak attempt detected', {
        correlationId,
        categories: detectedCategories,
        strength: selfInquiryStrength.toFixed(2)
      });
    }

    /* ──────────────────────────────────────────────────────────────────────── */
    /*  4. Return identity context                                             */
    /* ──────────────────────────────────────────────────────────────────────── */

    logger.debug('Complete', { correlationId, mode });

    return {
      identityContext: {
        mode,
        signals: {
          selfInquiryDetected,
          strength: selfInquiryStrength.toFixed(2),
          weightedScore: weightedScore.toFixed(2),
          categories: detectedCategories,
          jailbreakAttemptDetected,
          isLongPrompt
        },
        diagnosticSummary
      }
    };
  }
};

export default PhaseIdentity;
