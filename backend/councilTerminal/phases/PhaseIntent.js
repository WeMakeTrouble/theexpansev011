/**
 * ============================================================================
 * PhaseIntent.js — Intent Classification & Knowledge Routing (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Matches user intent and conditionally retrieves knowledge.
 * Integrates upstream phase context and EarWig diagnosticReport for
 * smarter routing decisions.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Cognitive frame now read from turnState.diagnosticReport.rawModules.cognitiveFrame
 *   (produced by EarWig) instead of running a separate IntentDetector
 *   instance. This eliminates duplicate detection and preserves the
 *   shared singleton's temporal memory across the system.
 * - Bug 11 fixed: helpdeskContext path corrected from
 *   turnState.helpdeskContext?.strength to
 *   turnState.claudesHelpDeskResult?.helpdeskContext?.strength.
 *   Hybrid gating was dead code in v009 due to this wrong path.
 * - Character dossier and system feature retrieval parallelised
 *   via Promise.all (independent operations, no dependency chain).
 * - All retrieval calls wrapped in withTimeout (5s) to prevent
 *   slow queries from stalling the phase.
 * - Intent matching wrapped in withRetry (2 attempts, 150ms backoff)
 *   for transient failure resilience.
 * - Counters integration for intent match type tracking, retrieval
 *   success/failure rates, and curriculum selection events.
 * - Upstream signals enhanced with confidence weighting from
 *   cognitiveFrame — downstream phases can use numeric weights
 *   rather than bare booleans for more nuanced decisions.
 * - Logger switched to createModuleLogger (structured, correlation IDs).
 * - IntentDetector import removed (no longer instantiated here).
 * - v010 documentation header.
 * - Curriculum selection logic extracted to helper function.
 * - All intent matching, knowledge retrieval, dossier generation,
 *   system feature facts, image URL logic preserved exactly.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Read upstream phase results (teaching, emotional, identity)
 *  - Read EarWig diagnosticReport for cognitive frame and composite intent
 *  - Read helpdeskContext from PhaseClaudesHelpDesk for hybrid gating
 *  - Match intent via IntentMatcher dependency (cotwIntentMatcher)
 *  - Route knowledge retrieval when entity found
 *  - Generate character dossiers for character_profiles entities
 *  - Retrieve system feature facts for system_features entities
 *  - Fetch image URLs for SHOW_IMAGE intents
 *  - Detect curriculum selection from pending choices
 *  - Track metrics via Counters
 *  - Expose rich intent context for downstream phases
 *
 * NON-GOALS
 * ---------
 *  - No response formatting/generation
 *  - No session or DB mutation
 *  - No turn termination
 *  - No emotional/teaching logic (classification only)
 *  - No cognitive frame detection (EarWig handles via singleton)
 *
 * INVARIANTS
 * ----------
 *  - Knowledge retrieval only on explicit entity_found + entity
 *  - Upstream signals preserved for downstream influence
 *  - Never returns terminal:true (enrichment phase only)
 *  - Cognitive frame comes from EarWig, not a local IntentDetector
 *  - Hybrid gating reads correct helpdeskContext path
 *  - All retrieval calls bounded by 5s timeout
 *  - Retrieval failures never crash the phase
 *
 * DEPENDENCIES
 * ------------
 *  - createModuleLogger (utils/logger.js)
 *  - CharacterDossierService (services/)
 *  - pool (db/)
 *  - cotwQueryEngine (councilTerminal/)
 *  - withRetry (councilTerminal/utils/)
 *  - Counters (councilTerminal/metrics/)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import CharacterDossierService from '../../services/CharacterDossierService.js';
import pool from '../../db/pool.js';
import cotwQueryEngine from '../cotwQueryEngine.js';
import { withRetry } from '../utils/withRetry.js';
import Counters from '../metrics/counters.js';
import ContextManager from '../core/ContextManager.js';

const logger = createModuleLogger('PhaseIntent');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

const INTENT_TO_MODE_MAP = Object.freeze({
  WHO: 'retrieval',
  WHAT: 'retrieval',
  WHERE: 'retrieval',
  WHEN: 'retrieval',
  WHY: 'retrieval',
  HOW: 'retrieval',
  WHICH: 'retrieval',
  IS: 'retrieval',
  SEARCH: 'retrieval',
  SHOW_IMAGE: 'retrieval',
  GREETING: 'companion',
  FAREWELL: 'companion',
  GRATITUDE: 'companion',
  HOW_ARE_YOU: 'companion',
  SELF_INQUIRY: 'identity',
  TEACH_REQUEST: 'teaching',
  EDIT_PROFILE: 'retrieval'
});

const WORD_NUMBERS = Object.freeze({
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
  'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19, 'twenty': 20,
  'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24, 'twenty-five': 25,
  'twenty-six': 26, 'twenty-seven': 27, 'twenty-eight': 28, 'twenty-nine': 29, 'thirty': 30,
  'thirty-one': 31, 'thirty-two': 32, 'thirty-three': 33, 'thirty-four': 34, 'thirty-five': 35,
  'thirty-six': 36, 'thirty-seven': 37, 'thirty-eight': 38, 'thirty-nine': 39, 'forty': 40,
  'forty-one': 41, 'forty-two': 42, 'forty-three': 43, 'forty-four': 44, 'forty-five': 45,
  'forty-six': 46, 'forty-seven': 47, 'forty-eight': 48, 'forty-nine': 49, 'fifty': 50
});

const CURRICULUM_AFFIRMATIVES = Object.freeze([
  'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'y'
]);

const HYBRID_GATE_HELPDESK_THRESHOLD = 0.65;
const HYBRID_GATE_COTW_CONFIDENCE = 0.85;
const RETRIEVAL_TIMEOUT_MS = 5000;
const KNOWLEDGE_RETRIEVAL_CONFIDENCE = 0.7;  // proposed — requires calibration
const INTENT_MATCH_MAX_ATTEMPTS = 2;
const INTENT_MATCH_BACKOFF_MS = 150;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Timeout Utility                                                            */
/*                                                                            */
/*  Wraps a promise with a timeout. If the promise does not resolve within   */
/*  the given milliseconds, rejects with a TimeoutError.                     */
/* ────────────────────────────────────────────────────────────────────────── */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helper Functions                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Detects curriculum selection from user input when pending choices exist.
 * Supports affirmative ("yes"), name match, and numeric/word-number selection.
 *
 * @param {string} command - Raw user input
 * @param {object[]} pendingChoices - Array of curriculum objects
 * @param {string} correlationId - For logging
 * @returns {object|null} Selection result or null
 */
function detectCurriculumSelection(command, pendingChoices, correlationId) {
  const normalizedCommand = command.trim().toLowerCase();

  if (CURRICULUM_AFFIRMATIVES.includes(normalizedCommand)) {
    logger.debug('Curriculum selected via affirmative', {
      correlationId,
      curriculum: pendingChoices[0]?.curriculum_name
    });
    return {
      type: 'affirmative',
      selectedIndex: 0,
      curriculum: pendingChoices[0]
    };
  }

  const matchedCurriculum = pendingChoices.find(c => {
    const name = (c.curriculum_name || '').toLowerCase();
    return name.length >= 3 && normalizedCommand.includes(name);
  });

  if (matchedCurriculum) {
    logger.debug('Curriculum selected via name match', {
      correlationId,
      curriculum: matchedCurriculum.curriculum_name
    });
    return {
      type: 'name_match',
      selectedIndex: pendingChoices.indexOf(matchedCurriculum),
      curriculum: matchedCurriculum
    };
  }

  let selectedIndex = null;
  const numericMatch = normalizedCommand.match(/^[0-9]+$/);
  if (numericMatch) {
    selectedIndex = parseInt(normalizedCommand, 10) - 1;
  } else if (WORD_NUMBERS[normalizedCommand]) {
    selectedIndex = WORD_NUMBERS[normalizedCommand] - 1;
  }

  if (selectedIndex !== null && selectedIndex >= 0 && selectedIndex < pendingChoices.length) {
    logger.debug('Curriculum selected via numeric', {
      correlationId,
      curriculum: pendingChoices[selectedIndex]?.curriculum_name
    });
    return {
      type: 'numeric',
      selectedIndex,
      curriculum: pendingChoices[selectedIndex]
    };
  }

  if (selectedIndex !== null) {
    logger.debug('Invalid curriculum selection - out of range', {
      correlationId,
      attemptedIndex: selectedIndex
    });
    return {
      type: 'out_of_range',
      invalid: true,
      attemptedIndex: selectedIndex,
      maxIndex: pendingChoices.length - 1
    };
  }

  return null;
}

/**
 * Retrieves character dossier for character_profiles entities.
 * Includes hard failure check, partial success check, and integrity check.
 * Bounded by RETRIEVAL_TIMEOUT_MS.
 *
 * @param {object} entity - Entity with source_table and source_hex_id
 * @param {object} session - Session object
 * @param {string} correlationId - For logging
 * @returns {Promise<object|null>} Dossier result or null
 */
async function retrieveCharacterDossier(entity, session, correlationId) {
  if (!entity || entity.source_table !== 'character_profiles' || !entity.source_hex_id) {
    return null;
  }

  try {
    const dossierResult = await withTimeout(
      CharacterDossierService.generateCharacterDossier(
        entity.source_hex_id,
        session?.userId,
        'user',
        correlationId
      ),
      RETRIEVAL_TIMEOUT_MS,
      'CharacterDossierService.generateCharacterDossier'
    );

    if (!dossierResult?.success) {
      throw new Error(dossierResult?.error || 'Unknown Dossier Service Error');
    }

    if (dossierResult.errors?.length > 0) {
      logger.warn('Partial dossier retrieved with section errors', {
        correlationId,
        characterId: entity.source_hex_id,
        failedSections: dossierResult.errors.map(e => e.section),
        errorDetails: dossierResult.errors
      });
    }

    const tier = dossierResult.tier || 0;
    const hasCoreData = tier >= 5
      ? !!dossierResult.dossier
      : !!dossierResult.dossier?.core;

    if (!hasCoreData) {
      logger.error('Integrity check failed: dossier contains no core data', {
        correlationId,
        characterId: entity.source_hex_id,
        returnedSections: Object.keys(dossierResult.dossier || {})
      });
      Counters.increment('intent_retrieval_failure', 'character_dossier_integrity');
      return null;
    }

    logger.debug('Character dossier successfully integrated', {
      correlationId,
      tier: dossierResult.tier,
      sections: Object.keys(dossierResult.dossier)
    });

    Counters.increment('intent_retrieval_success', 'character_dossier');
    return dossierResult;
  } catch (err) {
    logger.error('Character dossier integration failure', {
      correlationId,
      characterId: entity.source_hex_id,
      error: err.message
    });
    Counters.increment('intent_retrieval_failure', 'character_dossier');
    return null;
  }
}

/**
 * Retrieves system feature facts for system_features entities.
 * Admin users see all layers; regular users see 'user' layer only.
 * Bounded by RETRIEVAL_TIMEOUT_MS.
 *
 * @param {object} entity - Entity with source_table and source_hex_id
 * @param {object} session - Session object
 * @param {string} correlationId - For logging
 * @returns {Promise<object|null>} Feature result or null
 */
async function retrieveSystemFeature(entity, session, correlationId) {
  if (!entity || entity.source_table !== 'system_features' || !entity.source_hex_id) {
    return null;
  }

  const isAdmin = (session?.access_level || 1) >= 11;
  const featureFactsQuery = `
    SELECT
      ff.fact_id,
      ff.fact_type,
      ff.fact_content,
      ff.voice_hint,
      ff.display_order,
      ff.layer,
      sf.feature_name,
      sf.feature_code
    FROM feature_facts ff
    JOIN system_features sf ON ff.feature_id = sf.feature_id
    WHERE ff.feature_id = $1
      AND ff.is_active = true
      AND ($2 = true OR ff.layer = 'user')
    ORDER BY ff.fact_type, ff.display_order
  `;

  try {
    const factsResult = await withTimeout(
      pool.query(featureFactsQuery, [entity.source_hex_id, isAdmin]),
      RETRIEVAL_TIMEOUT_MS,
      'system_feature_facts_query'
    );

    if (factsResult.rows.length > 0) {
      logger.debug('System feature facts retrieved', {
        correlationId,
        featureId: entity.source_hex_id,
        factCount: factsResult.rows.length
      });
      Counters.increment('intent_retrieval_success', 'system_feature');
      return {
        success: true,
        featureId: entity.source_hex_id,
        featureName: factsResult.rows[0].feature_name,
        featureCode: factsResult.rows[0].feature_code,
        layer: isAdmin ? 'admin' : 'user',
        facts: factsResult.rows
      };
    }

    const fallbackResult = await withTimeout(
      pool.query(featureFactsQuery, [entity.source_hex_id, false]),
      RETRIEVAL_TIMEOUT_MS,
      'system_feature_facts_fallback'
    );

    if (fallbackResult.rows.length > 0) {
      Counters.increment('intent_retrieval_success', 'system_feature_fallback');
      return {
        success: true,
        featureId: entity.source_hex_id,
        featureName: fallbackResult.rows[0].feature_name,
        featureCode: fallbackResult.rows[0].feature_code,
        layer: 'user',
        facts: fallbackResult.rows
      };
    }

    return null;
  } catch (err) {
    logger.error('System feature facts retrieval failed', {
      correlationId,
      featureId: entity.source_hex_id,
      error: err.message
    });
    Counters.increment('intent_retrieval_failure', 'system_feature');
    return null;
  }
}

/**
 * Fetches image URL for SHOW_IMAGE intent type.
 * Bounded by RETRIEVAL_TIMEOUT_MS.
 *
 * @param {string|null} intentType - The matched intent type
 * @param {object|null} entity - Entity with source_table and source_hex_id
 * @param {string} correlationId - For logging
 * @returns {Promise<string|null>} Image URL or null
 */
async function fetchImageUrl(intentType, entity, correlationId) {
  if (intentType !== 'SHOW_IMAGE' || !entity?.source_table || !entity?.source_hex_id) {
    return null;
  }

  try {
    const fullEntityData = await withTimeout(
      cotwQueryEngine.fetchSourceRow(entity, { correlationId }),
      RETRIEVAL_TIMEOUT_MS,
      'cotwQueryEngine.fetchSourceRow'
    );

    if (fullEntityData) {
      logger.debug('Image URL from fetchSourceRow', {
        correlationId,
        imageUrl: fullEntityData.image_url || null
      });
      return fullEntityData.image_url || null;
    }
    return null;
  } catch (err) {
    logger.error('fetchSourceRow failed', {
      correlationId,
      error: err.message
    });
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseIntent Handler                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

const PhaseIntent = {
  async execute(turnState) {
    const { command, session, user, correlationId, dependencies } = turnState;

    logger.debug('Executing', { correlationId });

    const IntentMatcher = dependencies?.IntentMatcher;
    const KnowledgeLayer = dependencies?.KnowledgeLayer;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  1. Validate dependencies                                            */
    /* ──────────────────────────────────────────────────────────────────── */

    if (!IntentMatcher?.matchIntent) {
      logger.warn('IntentMatcher missing or invalid', { correlationId });
    }

    if (!KnowledgeLayer?.retrieve) {
      logger.warn('KnowledgeLayer missing or invalid', { correlationId });
    }

    const context = session?.context ?? {};

    /* ──────────────────────────────────────────────────────────────────── */
    /*  2. Read upstream phase results                                      */
    /* ──────────────────────────────────────────────────────────────────── */

    const teachingContext = turnState.teachingResult?.teachingContext ?? {};
    const emotionalContext = turnState.emotionalResult?.emotionalContext ?? {};
    const identityContext = turnState.identityResult?.identityContext ?? {};
    const cognitiveFrame = turnState.diagnosticReport?.rawModules?.cognitiveFrame ?? null;
    const cognitiveConfidence = cognitiveFrame?.confidence ?? 0;

    /* ──────────────────────────────────────────────────────────────────── */
    /*  3. Build upstream dominance signals (confidence-weighted)            */
    /*                                                                      */
    /*  Boolean flags retained for backward compatibility. Numeric          */
    /*  weights added from cognitiveFrame.confidence so downstream          */
    /*  phases can make more nuanced decisions.                             */
    /* ──────────────────────────────────────────────────────────────────── */

    const upstreamSignals = {
      teachingActive: teachingContext.mode === 'active_lesson',
      teachingPending: teachingContext.mode === 'pending_curriculum_choice',
      selfInquiry: identityContext.mode === 'self_inquiry',
      emotionalDistress: emotionalContext.mode === 'distressed' || emotionalContext.mode === 'overwhelmed',
      emotionalSupport: emotionalContext.mode === 'supportive',
      cognitiveFrameType: cognitiveFrame?.type ?? null,
      cognitiveConfidence,
      cognitiveInfluence: cognitiveConfidence >= 0.7 ? 'strong' : cognitiveConfidence >= 0.4 ? 'moderate' : 'weak'
    };

    if (cognitiveFrame) {
      logger.debug('Cognitive frame from EarWig', {
        correlationId,
        type: cognitiveFrame.type,
        confidence: cognitiveConfidence,
        influence: upstreamSignals.cognitiveInfluence,
        sarcasm: cognitiveFrame.meta?.sarcasm?.detected,
        compoundIntent: cognitiveFrame.meta?.compoundIntent?.type
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  3b. Curriculum selection detection                                   */
    /* ──────────────────────────────────────────────────────────────────── */

    if (upstreamSignals.teachingPending && context.pendingCurriculumChoice) {
      const selectionResult = detectCurriculumSelection(
        command,
        context.pendingCurriculumChoice,
        correlationId
      );

      if (selectionResult) {
        if (selectionResult.invalid) {
          upstreamSignals.invalidCurriculumSelection = selectionResult;
        } else {
          upstreamSignals.curriculumSelection = selectionResult;
          Counters.increment('curriculum_selected', selectionResult.type);
        }
      }

      if (upstreamSignals.curriculumSelection) {
        logger.debug('Curriculum selection — skipping intent matching', {
          correlationId,
          type: upstreamSignals.curriculumSelection.type
        });
        Counters.increment('intent_phase_early_return', 'curriculum_selection');
        return {
          intentContext: {
            mode: 'teaching',
            type: null,
            subtype: null,
            confidence: 0,
            isConversational: false,
            speechAct: null,
            dialogueFunction: null,
            outcomeIntent: null,
            entity: null,
            searchResult: { action: 'not_found', entity: null, options: null, message: null },
            knowledgeResult: null,
            characterDossier: null,
            systemFeature: null,
            upstreamSignals,
            error: null,
            imageUrl: null,
            cognitiveFrame
          }
        };
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4. Match intent via cotwIntentMatcher (with retry)                   */
    /* ──────────────────────────────────────────────────────────────────── */

    let intentResult = null;
    let intentError = null;

    if (IntentMatcher?.matchIntent) {
      try {
        intentResult = await withRetry(
          () => withTimeout(
            IntentMatcher.matchIntent(command, context, user),
            RETRIEVAL_TIMEOUT_MS,
            'IntentMatcher.matchIntent'
          ),
          {
            maxAttempts: INTENT_MATCH_MAX_ATTEMPTS,
            backoffMs: INTENT_MATCH_BACKOFF_MS,
            shouldRetry: (err) => !err.message.includes('Timeout')
          }
        );
        Counters.increment('intent_match_success', intentResult?.type || 'unknown');
      } catch (err) {
        logger.error('Intent matching failed', {
          correlationId,
          error: err.message
        });
        intentError = err.message;
        Counters.increment('intent_match_failure', 'error');
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4a. Validate dialogueFunction presence (PI-3 safety net)            */
    /* ──────────────────────────────────────────────────────────────────── */

    if (intentResult && intentResult.type && !intentResult.dialogueFunction) {
      logger.warn('Intent result missing dialogueFunction — LTLM gate will not fire', {
        correlationId,
        intentType: intentResult.type,
        matcherMethod: intentResult.matcherMethod || 'unknown',
        confidence: intentResult.confidence
      });
      Counters.increment('intent_missing_dialogueFunction', intentResult.type);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  4b. Hybrid gating — cotwIntentMatcher + helpdesk strength            */
    /*                                                                      */
    /*  Bug 11 fix: v009 read turnState.helpdeskContext?.strength which     */
    /*  was always undefined. BrainOrchestrator stores the result as        */
    /*  turnState.claudesHelpDeskResult.helpdeskContext.strength.           */
    /* ──────────────────────────────────────────────────────────────────── */

    const helpdeskStrength = parseFloat(
      turnState.claudesHelpDeskResult?.helpdeskContext?.strength ?? '1.0'
    );

    if (intentResult && helpdeskStrength < HYBRID_GATE_HELPDESK_THRESHOLD) {
      if (intentResult.isConversational && intentResult.confidence >= HYBRID_GATE_COTW_CONFIDENCE) {
        turnState.cotwConversationalSignal = {
          active: true,
          type: intentResult.type,
          subtype: intentResult.subtype || null,
          confidence: intentResult.confidence,
          dialogueFunction: intentResult.dialogueFunction || null,
          matcherMethod: intentResult.matcherMethod || null,
          timestamp: Date.now()
        };

        logger.debug('Cotw conversational gate activated', {
          correlationId,
          helpdeskStrength: helpdeskStrength.toFixed(2),
          cotwType: intentResult.type,
          cotwSubtype: intentResult.subtype || 'none',
          cotwConfidence: intentResult.confidence.toFixed(2),
          matcherMethod: intentResult.matcherMethod
        });
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  5. Extract search result                                            */
    /* ──────────────────────────────────────────────────────────────────── */

    const searchResult = intentResult?.searchResult ?? null;
    const searchAction = searchResult?.action ?? 'not_found';
    const entity = searchResult?.entity ?? null;

    const resolvedEntity = intentResult?.entityData ?? entity ?? null;
    if (resolvedEntity && session) {
      ContextManager.recordLastEntity(session, resolvedEntity);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  6. Retrieve knowledge (conditional, with timeout)                    */
    /* ──────────────────────────────────────────────────────────────────── */

    let knowledgeResult = null;

    if (KnowledgeLayer?.retrieve && (searchAction === 'entity_found' || searchAction === 'single_match') && entity && (intentResult?.confidence ?? 0) >= KNOWLEDGE_RETRIEVAL_CONFIDENCE) {
      try {
        knowledgeResult = await withTimeout(
          KnowledgeLayer.retrieve(entity.entity_name || entity),
          RETRIEVAL_TIMEOUT_MS,
          'KnowledgeLayer.retrieve'
        );
        Counters.increment('intent_retrieval_success', 'knowledge');
      } catch (err) {
        logger.error('Knowledge retrieval failed', {
          correlationId,
          entity,
          error: err.message
        });
        Counters.increment('intent_retrieval_failure', 'knowledge');
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  6b. Parallel retrieval: character dossier + system feature            */
    /*                                                                      */
    /*  These are independent operations — run in parallel.                 */
    /*  Each has its own timeout and error handling.                        */
    /* ──────────────────────────────────────────────────────────────────── */

    const [characterDossierResult, systemFeatureResult] = await Promise.all([
      retrieveCharacterDossier(entity, session, correlationId),
      retrieveSystemFeature(entity, session, correlationId)
    ]);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  7. Derive intent mode                                               */
    /* ──────────────────────────────────────────────────────────────────── */

    const intentType = intentResult?.type ?? null;
    const intentMode = INTENT_TO_MODE_MAP[intentType] || 'retrieval';

    if (intentType) {
      Counters.increment('intent_mode_resolved', intentMode);
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  7b. Fetch image URL for SHOW_IMAGE intent (with timeout)            */
    /* ──────────────────────────────────────────────────────────────────── */

    const imageUrl = await fetchImageUrl(intentType, entity, correlationId);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  8. Return intent context                                            */
    /* ──────────────────────────────────────────────────────────────────── */

    return {
      intentContext: {
        mode: intentMode,
        type: intentType,
        subtype: intentResult?.subtype ?? null,
        confidence: intentResult?.confidence ?? 0,
        isConversational: intentResult?.isConversational ?? false,
        speechAct: intentResult?.speechAct ?? null,
        dialogueFunction: intentResult?.dialogueFunction ?? null,
        outcomeIntent: intentResult?.outcomeIntent ?? null,
        entity: intentResult?.entity ?? null,
        searchResult: {
          action: searchAction,
          entity,
          options: searchResult?.options ?? null,
          message: searchResult?.message ?? null
        },
        knowledgeResult,
        characterDossier: characterDossierResult,
        systemFeature: systemFeatureResult,
        upstreamSignals,
        error: intentError,
        imageUrl,
        cognitiveFrame
      }
    };
  }
};

export default PhaseIntent;
