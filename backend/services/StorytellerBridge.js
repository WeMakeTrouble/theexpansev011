/**
 * ============================================================================
 * StorytellerBridge.js — Unified Narrative + Voice Synthesis Bridge (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Bridges the narrative state engine (narrativeEngine.js) with the LTLM
 * phrase assembly system (phraseChainer.js) and NLG voice synthesis
 * (NaturalLanguageGenerator.js) to create fully-voiced, emotionally-aware
 * story experiences.
 *
 * This is a CLASS export instantiated by ClaudeBrain and passed to pipeline
 * phases as the `Storyteller` dependency. It provides two primary interfaces:
 *
 *   1. getNextStoryBeat(characterId, correlationId)
 *      - Narrative progression: gets next segment, enriches with media,
 *        personality, PAD state, and NLG narration
 *
 *   2. buildStorytellerResponse({ intentResult, emotionalSignal, ... })
 *      - LTLM phrase assembly: the "sandwich" builder used by PhaseVoice
 *        to style Claude's responses with LTLM openers, connectors,
 *        hedges, and closers
 *
 * HISTORY
 * -------
 * v009 had these as two separate systems:
 *   - StorytellerBridge.js (TSE/systems/) — narrative beats only
 *   - storytellerWrapper.js (services/) — LTLM sandwich only
 *
 * PhaseVoice called Storyteller.buildStorytellerResponse() but the v009
 * StorytellerBridge class had no such method — making the call dead code.
 * v010 unifies both systems into this single class so all storyteller
 * functionality is available through one interface.
 *
 * THE SANDWICH (LTLM Assembly Order)
 * ------------------------------------
 * Opener → Content1 → (Connector → Content2)* → Hedge → Closer
 *
 *   - Opener: greeting, scene-setting phrase from LTLM
 *   - Content: knowledge/narrative blocks passed by caller (order preserved)
 *   - Connector: playful/additive transition phrases (NEVER causal)
 *   - Hedge: epistemic softener before closing
 *   - Closer: farewell, invitation to continue
 *
 * INTENT → LTLM MAPPING
 * ----------------------
 * The bridge maps cognitive intent + emotional signal to LTLM outcome/strategy:
 *   - crisis → reassurance/affirmation
 *   - highArousal → reassurance/reflection
 *   - negative → validation/reflection
 *   - WHY intent → exploration/question
 *   - HOW intent → planning/suggestion
 *   - GREETING → relational_outcomes.build_rapport/greeting
 *   - FAREWELL → relational_outcomes.build_rapport/farewell
 *   - GRATITUDE → connection/affirmation
 *   - HOW_ARE_YOU → connection/question
 *   - default → clarity/info
 *
 * Override parameters (outcomeIntent, strategy) allow callers like
 * omiyageService to force specific LTLM paths.
 *
 * CONSUMERS
 * ---------
 * - ClaudeBrain.js (instantiates, passes as Storyteller dependency)
 * - PhaseVoice.js (calls buildStorytellerResponse for LTLM styling)
 * - PhaseIntent.js (could call getNextStoryBeat for narrative progression)
 * - socketHandler.js (narrative progression events)
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js, narrativeEngine.js,
 *           narrativeAccess.js, phraseChainer.js,
 *           NaturalLanguageGeneratorSingleton.js, counters.js
 * External: None
 *
 * SCHEMA DEPENDENCIES (Verified 2026-02-10)
 * ------------------------------------------
 * character_profiles: character_id(7), character_name, category, description
 * psychic_moods: character_id(7), p(numeric), a(numeric), d(numeric), updated_at
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import narrativeEngine from '../utils/narrativeEngine.js';
import { getMultimediaAssetById, getLocationById } from '../utils/narrativeAccess.js';
import { chainPhrases } from './phraseChainer.js';
import { getNaturalLanguageGenerator } from '../TSE/helpers/NaturalLanguageGeneratorSingleton.js';
import Counters from '../councilTerminal/metrics/counters.js';
import { withRetry } from '../councilTerminal/utils/withRetry.js';

const logger = createModuleLogger('StorytellerBridge');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const TIMEOUTS = Object.freeze({
  QUERY_MS: 5000,
  CONNECT_MS: 5000,
  NLG_MS: 10000,
  CHAIN_MS: 5000
});

const DEFAULT_PAD = Object.freeze({
  pleasure: 0.5,
  arousal: 0.5,
  dominance: 0.5
});

/**
 * Safe LTLM connector hex IDs. These are additive/playful connectors only.
 * NO causality connectors. Curated from database audit 2025-12-17.
 */
const SAFE_CONNECTOR_HEX = Object.freeze([
  '#56002D', '#560153',
  '#56029C',
  '#56029E',
  '#560281',
  '#560029', '#56014F',
  '#56002C', '#560152',
  '#5600C6', '#5601EC'
]);


/**
 * Safe float parser — returns fallback when value is null, undefined, or NaN.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function safeFloat(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? fallback : n;
}
const EMOTIONAL_OVERRIDES = Object.freeze({
  crisis: { outcomeIntent: 'reassurance', strategy: 'affirmation' },
  highArousal: { outcomeIntent: 'reassurance', strategy: 'reflection' },
  negative: { outcomeIntent: 'validation', strategy: 'reflection' }
});

const DEFAULT_INTENT_MAP = Object.freeze({
  WHY: { outcomeIntent: 'exploration', strategy: 'question' },
  HOW: { outcomeIntent: 'planning', strategy: 'suggestion' },
  GREETING: { outcomeIntent: 'relational_outcomes.build_rapport', strategy: 'greeting' },
  FAREWELL: { outcomeIntent: 'relational_outcomes.build_rapport', strategy: 'farewell' },
  GRATITUDE: { outcomeIntent: 'connection', strategy: 'affirmation' },
  HOW_ARE_YOU: { outcomeIntent: 'connection', strategy: 'question' }
});

const DEFAULT_STORY_PLAN = Object.freeze({
  outcomeIntent: 'clarity',
  strategy: 'info'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Internal Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Runs a query with timeout protection.
 * @param {string} sql - SQL string
 * @param {Array} params - Query parameters
 * @returns {Promise<object>} Query result
 */
function _queryWithTimeout(sql, params) {
  let timer;
  return Promise.race([
    pool.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Query timeout")), TIMEOUTS.QUERY_MS);
    })
  ]);
}

/**
 * Wraps an async operation with a timeout.
 * @param {Promise} promise - The async operation
 * @param {number} ms - Timeout in milliseconds
 * @param {string} label - Label for error message
 * @returns {Promise<*>} Result of the operation
 */
function _withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    })
  ]);
}

/**
 * Normalises a hex ID to uppercase #XXXXXX format.
 * @param {string} hex - Raw hex string
 * @returns {string} Normalised hex ID
 */
function _normalizeHexId(hex) {
  if (typeof hex !== 'string') return hex;
  const v = hex.trim();
  return v.startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
}

/**
 * Validates a hex ID and throws if invalid.
 * @param {string} id - Hex ID to validate
 * @param {string} [fieldName='hex id'] - Field name for error message
 * @throws {Error} If hex ID is invalid
 */
function _assertHexId(id, fieldName = 'hex id') {
  if (!isValidHexId(id)) {
    throw new Error(`Invalid ${fieldName} format. Expected #XXXXXX.`);
  }
}

/**
 * Maps intent type + emotional signal to LTLM outcome/strategy pair.
 * Emotional overrides take priority, then intent-based mapping, then default.
 *
 * @param {object} intentResult - Parsed intent from cotwIntentMatcher
 * @param {string} emotionalSignal - 'neutral', 'crisis', 'highArousal', 'negative'
 * @returns {{ outcomeIntent: string, strategy: string }}
 */
function _mapIntentToStoryPlan(intentResult, emotionalSignal) {
  if (emotionalSignal && EMOTIONAL_OVERRIDES[emotionalSignal]) {
    return { ...EMOTIONAL_OVERRIDES[emotionalSignal] };
  }

  const baseType = intentResult?.type || 'WHAT';
  if (DEFAULT_INTENT_MAP[baseType]) {
    return { ...DEFAULT_INTENT_MAP[baseType] };
  }

  return { ...DEFAULT_STORY_PLAN };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  StorytellerBridge Class                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export class StorytellerBridge {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  1. Narrative Beat Progression                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Gets the next narrative story beat for a character.
   * Enriches raw narrative step with media, personality profile,
   * PAD emotional state, location, and NLG-synthesized narration.
   *
   * @param {string} characterId - Hex character ID
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<{status: string, segment_id?: string, title?: string, narrative_text?: string, original_content?: string, media?: object|null, mood?: object|null, location?: object|null, choices?: Array, character_context?: object, pathLog?: Array, message?: string}>}
   */
  async getNextStoryBeat(characterId, correlationId) {
    _assertHexId(characterId, 'character_id');
    const charId = _normalizeHexId(characterId);

    try {
      const rawStep = await _withTimeout(narrativeEngine.getNextNarrativeStep(charId, correlationId), TIMEOUTS.QUERY_MS, "narrativeEngine.getNextNarrativeStep");

      if (!rawStep.segment) {
        Counters.increment('storyteller_bridge', 'beat_end_of_story');
        return { status: 'end_of_story', pathLog: rawStep.pathLog };
      }

      const [mediaAsset, personalityProfile, padState, location] = await Promise.all([
        this._resolveMedia(rawStep.segment.multimedia_asset_id, correlationId),
        this._buildCharacterProfile(charId, correlationId),
        this._getCurrentPadState(charId, correlationId),
        rawStep.segment.associated_location_id
          ? this._resolveLocation(rawStep.segment.associated_location_id, correlationId)
          : null
      ]);

      const narratedContent = await this._synthesizeNarration(
        rawStep.segment, personalityProfile, padState, correlationId
      );

      Counters.increment('storyteller_bridge', 'beat_success');
      logger.info('Story beat generated', {
        characterId: charId, segmentId: rawStep.segment.segment_id,
        hasMedia: !!mediaAsset, hasChoices: rawStep.choices.length > 0,
        correlationId
      });

      return {
        status: 'success',
        segment_id: rawStep.segment.segment_id,
        title: rawStep.segment.title,
        narrative_text: narratedContent,
        original_content: rawStep.segment.content,
        media: mediaAsset,
        mood: rawStep.segment.sentiment_tags,
        location,
        choices: rawStep.choices,
        pathLog: rawStep.pathLog,
        character_context: {
          personality_profile: personalityProfile,
          emotional_state: padState
        }
      };

    } catch (error) {
      logger.error('Failed to get next story beat', {
        error: error.message, characterId: charId, correlationId
      });
      Counters.increment('storyteller_bridge', 'beat_failure');
      return { status: 'error', message: error.message };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  2. LTLM Phrase Assembly (The Sandwich)                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Builds a storyteller-styled response using LTLM phrase assembly.
   * This is the method PhaseVoice calls to style Claude's responses.
   *
   * Assembly order (The Sandwich):
   *   Opener → Content1 → (Connector → Content2)* → Hedge → Closer
   *
   * @param {object} params
   * @param {object} [params.intentResult] - Parsed intent from cotwIntentMatcher
   * @param {string} [params.emotionalSignal='neutral'] - Emotional signal
   * @param {string} [params.identitySignal] - Identity mode signal
   * @param {string[]} [params.contentBlocks] - Array of content strings (preferred)
   * @param {string} [params.knowledgeText] - Single content string (legacy fallback)
   * @param {object} [params.mood] - Blended mood object
   * @param {string} [params.tone='neutral'] - Tone hint
   * @param {string} [params.formality='casual'] - Formality level
   * @param {string} [params.verbosity] - Verbosity hint
   * @param {string} [params.styleHint] - Style hint from response style
   * @param {string} [params.outcomeIntent] - Override LTLM outcome intent
   * @param {string} [params.strategy] - Override LTLM strategy
   * @param {string} [params.correlationId] - Request correlation ID
   * @returns {Promise<{output: string, storytellerMeta: object}>}
   */
  async buildStorytellerResponse({
    intentResult,
    emotionalSignal = 'neutral',
    identitySignal,
    contentBlocks,
    knowledgeText,
    mood,
    tone = 'neutral',
    formality = 'casual',
    verbosity,
    styleHint,
    outcomeIntent: overrideOutcomeIntent,
    strategy: overrideStrategy,
    correlationId
  } = {}) {

    let blocks = [];
    if (Array.isArray(contentBlocks) && contentBlocks.length > 0) {
      blocks = contentBlocks;
    } else if (knowledgeText) {
      blocks = [knowledgeText];
    } else {
      Counters.increment('storyteller_bridge', 'response_no_content');
      return {
        output: '',
        storytellerMeta: { usedStoryteller: false, reason: 'no_content' }
      };
    }


    /* ──────────────────────────────────────────────────────────────────── */
    /*  Gate: detect self-contained content blocks that need no closer     */
    /*                                                                      */
    /*  When content already contains a teaching offer, system feature,     */
    /*  or teaching activation, the response is complete — appending        */
    /*  generic LTLM closer/hedge sentences adds irrelevant filler.         */
    /* ──────────────────────────────────────────────────────────────────── */

    const SELF_CONTAINED_BLOCK_TYPES = new Set([
      'teaching_offer', 'system_feature', 'teaching_activation',
      'entity', 'knowledge'
    ]);
    const _hasTerminalBlock = Array.isArray(contentBlocks) && contentBlocks.some(
      b => b?.type && SELF_CONTAINED_BLOCK_TYPES.has(b.type)
    );

    blocks = blocks.map(b => (typeof b === 'string' ? b.trim() : (b?.content || '').trim())).filter(b => b.length > 0);

    if (blocks.length === 0) {
      Counters.increment('storyteller_bridge', 'response_empty_content');
      return {
        output: '',
        storytellerMeta: { usedStoryteller: false, reason: 'empty_content' }
      };
    }

    const derived = _mapIntentToStoryPlan(intentResult, emotionalSignal);
    const outcomeIntent = overrideOutcomeIntent || derived.outcomeIntent;
    const strategy = overrideStrategy || derived.strategy;

    try {
      const numConnectorsNeeded = Math.max(0, blocks.length - 1);
      const skipConnectors = numConnectorsNeeded === 0;

      const chainResult = await _withTimeout(
        withRetry(
          () => chainPhrases(outcomeIntent, strategy, {
          tone,
          formality,
          connectorCount: numConnectorsNeeded,
          skipConnectors,
          safeConnectorHex: SAFE_CONNECTOR_HEX,
          targetPad: mood,
          correlationId
          }),
          { maxAttempts: 2, backoffMs: 100 }
        ),
        TIMEOUTS.CHAIN_MS,
        'chainPhrases'
      );

      const chain = chainResult.chain;

      let finalOutput = '';

      if (chain.opener) {
        finalOutput += `${chain.opener} `;
      }

      blocks.forEach((block, index) => {
        finalOutput += block;
        if (index < blocks.length - 1) {
          if (chain.connectors && chain.connectors[index]) {
            finalOutput += ` ${chain.connectors[index]} `;
          } else {
            finalOutput += ' ';
          }
        }
      });

      if (chain.hedge && !_hasTerminalBlock) {
        finalOutput += ` ${chain.hedge}`;
      }

      if (chain.closer && !_hasTerminalBlock) {
        const lastChar = finalOutput.trim().slice(-1);
        if (!['.', '!', '?'].includes(lastChar)) {
          finalOutput += '.';
        }
        finalOutput += ` ${chain.closer}`;
      }

      Counters.increment('storyteller_bridge', 'response_success');
      logger.debug('Storyteller response built', {
        outcomeIntent, strategy, blockCount: blocks.length, correlationId
      });

      return {
        output: finalOutput.trim(),
        storytellerMeta: {
          usedStoryteller: true,
          outcomeIntent,
          strategy,
          tone,
          formality,
          blockCount: blocks.length,
          phraseIds: chainResult?.metadata?.phraseIds,
          structureCode: chain.structureCode
        }
      };

    } catch (err) {
      logger.error('Phrase chain assembly failed, returning raw content', {
        error: err.message, outcomeIntent, strategy, correlationId
      });
      Counters.increment('storyteller_bridge', 'response_chain_error');
      return {
        output: blocks.join('\n\n'),
        storytellerMeta: {
          usedStoryteller: false,
          reason: 'chainPhrases_error',
          error: err.message
        }
      };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Media Resolution                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Resolves a multimedia asset by ID.
   * @param {string} assetId - Hex asset ID
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<object|null>}
   */
  async _resolveMedia(assetId, correlationId) {
    if (!assetId) return null;
    try {
      return await _withTimeout(getMultimediaAssetById(assetId, correlationId), TIMEOUTS.QUERY_MS, "getMultimediaAssetById");
    } catch (error) {
      logger.warn('Failed to resolve media asset', {
        assetId, error: error.message, correlationId
      });
      return null;
    }
  }

  /**
   * Resolves a location by ID.
   * @param {string} locationId - Hex location ID
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<object|null>}
   */
  async _resolveLocation(locationId, correlationId) {
    if (!locationId) return null;
    try {
      return await _withTimeout(getLocationById(locationId, correlationId), TIMEOUTS.QUERY_MS, "getLocationById");
    } catch (error) {
      logger.warn('Failed to resolve location', {
        locationId, error: error.message, correlationId
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Character Profile                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Builds a character personality profile for NLG narration.
   * @param {string} characterId - Normalised hex character ID
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<{character_id: string, name: string|null, category: string|null, description: string|null, traits: object}>}
   */
  async _buildCharacterProfile(characterId, correlationId) {
    try {
      const charResult = await _queryWithTimeout(
        `SELECT character_id, character_name, category, description
         FROM character_profiles WHERE character_id = $1`,
        [characterId]
      );

      const charData = charResult.rows[0];
      if (!charData) {
        logger.debug("No character profile found", { characterId, correlationId });
        return { character_id: characterId, name: null, category: null, description: null };
      }

      const facetResult = await _queryWithTimeout(
        `SELECT cfs.facet_code, cfs.score, cpp.working_memory_capacity
         FROM character_facet_scores cfs
         LEFT JOIN character_personality cpp ON cpp.character_id = cfs.character_id
         WHERE cfs.character_id = $1
           AND cfs.facet_code IN (
             'C1_Competence', 'O5_Ideas', 'N1_Anxiety',
             'E1_Warmth', 'A6_Tender_Mindedness', 'A3_Altruism',
             'O4_Actions', 'C4_Achievement_Striving'
           )`,
        [characterId]
      );

      const facets = {};
      let workingMemory = 7;
      facetResult.rows.forEach(row => {
        facets[row.facet_code] = safeFloat(row.score, 50);
        if (row.working_memory_capacity) workingMemory = row.working_memory_capacity;
      });

      return {
        character_id: characterId,
        name: charData.character_name,
        category: charData.category,
        description: charData.description,
        emotional: {
          confidence:  facets["C1_Competence"]          ?? 50,
          curiosity:   facets["O5_Ideas"]               ?? 50,
          anxiety:     facets["N1_Anxiety"]             ?? 50
        },
        social: {
          communication: facets["E1_Warmth"]            ?? 50,
          empathy:       facets["A6_Tender_Mindedness"] ?? 50,
          collaboration: facets["A3_Altruism"]          ?? 50,
          independence:  facets["O4_Actions"]           ?? 50
        },
        cognitive: {
          analyticalThinking: facets["C4_Achievement_Striving"] ?? 50
        },
        overallLearningCapacity: Math.round((workingMemory / 9.0) * 100)
      };

    } catch (error) {
      logger.warn("Failed to build character profile", {
        characterId, error: error.message, correlationId
      });
      return { character_id: characterId, name: null, category: null, description: null };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: PAD Emotional State                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Fetches the current PAD emotional state for a character.
   * Returns defaults if no mood record exists.
   *
   * @param {string} characterId - Normalised hex character ID
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<{pleasure: number, arousal: number, dominance: number, timestamp?: string}>}
   */
  async _getCurrentPadState(characterId, correlationId) {
    try {
      const moodResult = await _queryWithTimeout(
        `SELECT p AS pleasure, a AS arousal, d AS dominance, updated_at
         FROM psychic_moods WHERE character_id = $1
         ORDER BY updated_at DESC LIMIT 1`,
        [characterId]
      );

      if (moodResult.rows.length > 0) {
        const mood = moodResult.rows[0];
        return {
          pleasure: safeFloat(mood.pleasure, DEFAULT_PAD.pleasure),
          arousal: safeFloat(mood.arousal, DEFAULT_PAD.arousal),
          dominance: safeFloat(mood.dominance, DEFAULT_PAD.dominance),
          timestamp: mood.updated_at
        };
      }

      return { ...DEFAULT_PAD };

    } catch (error) {
      logger.warn('Failed to fetch PAD state', {
        characterId, error: error.message, correlationId
      });
      return { ...DEFAULT_PAD };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: NLG Narration Synthesis                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Synthesizes narration for a narrative segment using NLG.
   * Falls back to raw segment content on failure or timeout.
   *
   * @param {object} segment - Narrative segment object
   * @param {object} personalityProfile - Character profile
   * @param {object} padState - Current PAD emotional state
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<string>} Narrated text or raw content fallback
   */
  async _synthesizeNarration(segment, personalityProfile, padState, correlationId) {
    try {
      const nlg = getNaturalLanguageGenerator();
      const result = await _withTimeout(
        nlg.generate(
          [{ content: segment.content, type: 'narrative_segment' }],
          personalityProfile,
          {
            detailLevel: 'high',
            tone: segment.sentiment_tags?.mood || 'balanced',
            format: 'narrative_prose'
          },
          segment.title,
          padState
        ),
        TIMEOUTS.NLG_MS,
        'NLG synthesis'
      );

      if (result) {
        Counters.increment('storyteller_bridge', 'nlg_synthesis_success');
        return result;
      }

      Counters.increment('storyteller_bridge', 'nlg_synthesis_empty');
      return segment.content;

    } catch (error) {
      logger.warn('NLG narration synthesis failed, using raw content', {
        segmentId: segment.segment_id, error: error.message, correlationId
      });
      Counters.increment('storyteller_bridge', 'nlg_synthesis_failure');
      return segment.content;
    }
  }
}

export default new StorytellerBridge();
