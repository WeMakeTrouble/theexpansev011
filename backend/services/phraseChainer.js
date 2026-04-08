/**
 * ============================================================================
 * phraseChainer.js — LTLM Phrase Assembly Engine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Orchestrates retrieval and assembly of voice phrase components for
 * Claude the Tanuki's speech. Sits between the phrase database layer
 * and the StorytellerBridge:
 *
 *   phraseQueryLayer → [phraseChainer] → StorytellerBridge → PhaseVoice
 *
 * Produces a structured "sandwich" chain:
 *   Opener → Content1 → Connector → Content2 → Hedge → Closer
 *
 * The sandwich pattern gives Claude natural conversational flow.
 * The opener sets the stage, connectors link ideas, hedges soften
 * certainty, and closers wrap up. Content blocks are NOT produced
 * here — they come from the knowledge/intent layer and are
 * interleaved by the StorytellerBridge.
 *
 * GATING RULES (NON-NEGOTIABLE)
 * ----------------------------
 * 1. skipConnectors overrides connectorCount — always. If true,
 *    connectors are never fetched regardless of other settings.
 * 2. Hedge inclusion is probabilistic (configurable via
 *    hedgeProbability, default 0.5). Can be forced with forceHedge.
 * 3. Safe connector hex list restricts which connectors are
 *    eligible. Invalid hex IDs are filtered before query.
 *
 * FALLBACK CASCADE (OPENER)
 * -------------------------
 * 1. Specific tone + formality match
 * 2. Neutral tone fallback
 * 3. Hardcoded generic fallback (FALLBACK_PHRASES.opener)
 * This guarantees the chain ALWAYS has an opener.
 *
 * ASSEMBLY RULES
 * --------------
 * phraseChainer returns STRUCTURED PARTS, not pre-assembled text.
 * Assembly into final output is the responsibility of
 * StorytellerBridge.buildStorytellerResponse().
 *
 * CONSUMERS
 * ---------
 * - StorytellerBridge.js (buildStorytellerResponse)
 *
 * DEPENDENCIES
 * ------------
 * Internal: phraseQueryLayer.js, logger.js, hexIdGenerator.js, Counters
 * External: None
 *
 * DATABASE
 * --------
 * Reads from: conversational_phrases (via phraseQueryLayer)
 * Writes to: None
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { getPhrases } from './phraseQueryLayer.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('phraseChainer');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const CHAIN = Object.freeze({
  DEFAULT_CONNECTOR_COUNT: 1,
  MAX_CONNECTOR_COUNT: 5,
  DEFAULT_HEDGE_PROBABILITY: 0.5,
  PHRASE_TIMEOUT_MS: 4000,
  VALID_TONES: Object.freeze(['neutral', 'playful', 'factual', 'warm']),
  VALID_FORMALITIES: Object.freeze(['casual', 'formal'])
});

const FALLBACK_PHRASES = Object.freeze({
  opener: Object.freeze({
    text: "Here's what I found:",
    phrase_hex_id: 'FALLBACK_OPENER',
    role: 'opener',
    isFallback: true
  })
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Fetch With Timeout                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Wraps a getPhrases call with timeout protection.
 * Returns { found: false, phrases: [] } on timeout rather than crashing.
 */
/**
 * djb2 hash producing a float between 0 and 1.
 * Deterministic replacement for Math.random().
 * @param {string} str - Input string to hash
 * @returns {number} Value between 0 and 1
 */
function _djb2Float(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) / 2147483647;
}

/**
 * Scores and sorts phrases by PAD emotional distance.
 * Uses Euclidean distance in 3D PAD space, normalised to 0-1.
 * Lower distance = better match = higher score.
 * When targetPad is null, returns phrases unchanged.
 * @param {Array} phrases - Array of phrase objects with pad_pleasure, pad_arousal, pad_dominance
 * @param {object|null} targetPad - { pleasure, arousal, dominance }
 * @returns {Array} Phrases sorted by PAD proximity (best match first)
 */
function _scorePhrasesByPad(phrases, targetPad) {
  if (!targetPad || !phrases || phrases.length <= 1) return phrases;

  const { pleasure = 0.5, arousal = 0.5, dominance = 0.5 } = targetPad;
  const maxDistance = Math.sqrt(3);

  return phrases
    .map(p => {
      const dist = Math.sqrt(
        Math.pow((Number.isNaN(Number.parseFloat(p.pad_pleasure)) ? 0.5 : Number.parseFloat(p.pad_pleasure)) - pleasure, 2) +
        Math.pow((Number.isNaN(Number.parseFloat(p.pad_arousal)) ? 0.5 : Number.parseFloat(p.pad_arousal)) - arousal, 2) +
        Math.pow((Number.isNaN(Number.parseFloat(p.pad_dominance)) ? 0.5 : Number.parseFloat(p.pad_dominance)) - dominance, 2)
      );
      return { ...p, padScore: 1 - (dist / maxDistance) };
    })
    .sort((a, b) => b.padScore - a.padScore);
}

async function _fetchWithTimeout(outcomeIntent, strategy, options, correlationId) {
  let timer;
  const fetchPromise = getPhrases(outcomeIntent, strategy, options);
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger.warn('Phrase fetch timeout', {
        outcomeIntent,
        strategy,
        role: options.role,
        correlationId
      });
      Counters.increment('phrase_chain', 'fetch_timeout');
      resolve({ found: false, phrases: [], count: 0 });
    }, CHAIN.PHRASE_TIMEOUT_MS);
  });
  return Promise.race([fetchPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Fetch Opener (Sequential Fallback Cascade)                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function _fetchOpener(outcomeIntent, strategy, validatedTone, formality, randomOrder, correlationId, targetPad) {
  const baseOptions = { role: 'opener', formality, limit: 5, randomOrder, correlationId };

  const specificResult = await _fetchWithTimeout(
    outcomeIntent, strategy,
    { ...baseOptions, tone: validatedTone },
    correlationId
  );

  if (specificResult.found) {
    return { phrase: _scorePhrasesByPad(specificResult.phrases, targetPad)[0], fallbackLevel: 0 };
  }

  if (validatedTone && validatedTone !== 'neutral') {
    const neutralResult = await _fetchWithTimeout(
      outcomeIntent, strategy,
      { ...baseOptions, tone: 'neutral' },
      correlationId
    );

    if (neutralResult.found) {
      Counters.increment('phrase_chain', 'opener_neutral_fallback');
      logger.debug('Opener fell back to neutral tone', {
        originalTone: validatedTone, outcomeIntent, strategy, correlationId
      });
      return { phrase: _scorePhrasesByPad(neutralResult.phrases, targetPad)[0], fallbackLevel: 1 };
    }
  }

  Counters.increment('phrase_chain', 'opener_generic_fallback');
  logger.warn('Opener fell back to hardcoded generic', {
    outcomeIntent, strategy, tone: validatedTone, correlationId
  });
  return { phrase: FALLBACK_PHRASES.opener, fallbackLevel: 2 };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Fetch Remaining Parts (Parallel)                                 */
/* ────────────────────────────────────────────────────────────────────────── */

async function _fetchRemainingParts(outcomeIntent, strategy, options, correlationId) {
  const {
    tone, formality, randomOrder,
    skipConnectors, connectorCount, safeConnectorHex,
    hedgeProbability, forceHedge, targetPad
  } = options;

  const clampedConnectorCount = skipConnectors
    ? 0
    : Math.max(0, Math.min(CHAIN.MAX_CONNECTOR_COUNT, connectorCount ?? CHAIN.DEFAULT_CONNECTOR_COUNT));

  const validSafeHex = safeConnectorHex && Array.isArray(safeConnectorHex)
    ? safeConnectorHex.filter(h => isValidHexId(h))
    : null;

  if (safeConnectorHex && validSafeHex && validSafeHex.length < safeConnectorHex.length) {
    logger.warn('Invalid hex IDs filtered from safeConnectorHex', {
      original: safeConnectorHex.length,
      valid: validSafeHex.length,
      correlationId
    });
  }

  const fetches = [];
  const fetchMap = [];

  if (clampedConnectorCount > 0) {
    fetches.push(_fetchWithTimeout(outcomeIntent, strategy, {
      role: 'connector',
      tone,
      formality,
      limit: clampedConnectorCount,
      randomOrder,
      hexList: validSafeHex,
      correlationId
    }, correlationId));
    fetchMap.push('connector');
  }

  fetches.push(_fetchWithTimeout(outcomeIntent, strategy, {
    role: 'closer',
    tone,
    formality,
    limit: 5,
    randomOrder,
    correlationId
  }, correlationId));
  fetchMap.push('closer');

  fetches.push(_fetchWithTimeout(outcomeIntent, strategy, {
    role: 'hedge',
    tone,
    formality,
    limit: 5,
    randomOrder,
    correlationId
  }, correlationId));
  fetchMap.push('hedge');

  const results = await Promise.all(fetches);

  const parts = { connectors: [], closer: null, hedge: null };

  for (let idx = 0; idx < results.length; idx++) {
    const type = fetchMap[idx];
    const result = results[idx];

    if (type === 'connector' && result.found) {
      parts.connectors = _scorePhrasesByPad(result.phrases, targetPad).slice(0, clampedConnectorCount);
    } else if (type === 'closer' && result.found) {
      parts.closer = _scorePhrasesByPad(result.phrases, targetPad)[0];
    } else if (type === 'hedge' && result.found) {
      const probability = forceHedge ? 1.0 : (hedgeProbability ?? CHAIN.DEFAULT_HEDGE_PROBABILITY);
      if (_djb2Float(outcomeIntent + strategy + String(Date.now())) < probability) {
        parts.hedge = _scorePhrasesByPad(result.phrases, targetPad)[0];
        Counters.increment('phrase_chain', 'hedge_included');
      } else {
        Counters.increment('phrase_chain', 'hedge_skipped');
      }
    }
  }

  if (skipConnectors) {
    Counters.increment('phrase_chain', 'connectors_skipped');
  }

  return parts;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Build Chain Structure                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Builds the chain structure from phrase components.
 * Returns STRUCTURED PARTS for assembly — not pre-assembled text.
 *
 * The 'text' field is LEGACY ONLY. New code MUST use the structured
 * parts (opener, connectors, hedge, closer).
 */
function _buildChain(opener, connectors, closer, hedge) {
  return {
    opener: opener ? opener.text.trim() : null,
    connectors: connectors.map(c => c.text.trim()),
    hedge: hedge ? hedge.text.trim() : null,
    closer: closer ? closer.text.trim() : null,
    text: [
      opener?.text,
      ...connectors.map(c => c.text),
      hedge?.text,
      closer?.text
    ].filter(Boolean).join(' ').trim(),
    structureCode: _generateStructureCode(opener, connectors, closer, hedge)
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Generate Structure Code                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Generates a debug code showing the chain structure.
 * e.g. "O-C-H-CL" = Opener, Connector, Hedge, Closer
 */
function _generateStructureCode(opener, connectors, closer, hedge) {
  const codes = [];
  if (opener) codes.push('O');
  connectors.forEach(() => codes.push('C'));
  if (hedge) codes.push('H');
  if (closer) codes.push('CL');
  return codes.join('-');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: Chain Phrases                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Orchestrates retrieval and assembly of phrase components for voice styling.
 *
 * @param {string} outcomeIntent - e.g. 'clarity', 'validation', 'reassurance'
 * @param {string} strategy - e.g. 'info', 'question', 'affirmation'
 * @param {object} [options] - Configuration options
 * @param {string} [options.tone] - 'neutral', 'playful', 'factual', 'warm'
 * @param {string} [options.formality='casual'] - 'casual' or 'formal'
 * @param {number} [options.connectorCount] - How many connectors to fetch
 * @param {boolean} [options.skipConnectors=false] - Hard gate: no connectors
 * @param {string[]} [options.safeConnectorHex] - Allowlist of connector hex IDs
 * @param {boolean} [options.randomOrder=true] - Randomise phrase selection
 * @param {number} [options.hedgeProbability=0.5] - Probability of hedge (0-1)
 * @param {boolean} [options.forceHedge] - Force hedge inclusion
 * @param {string} [options.correlationId] - Request correlation ID
 * @returns {Promise<{success, chain, metadata}>}
 */
async function chainPhrases(outcomeIntent, strategy, options = {}) {
  const {
    tone = null,
    formality = 'casual',
    connectorCount = null,
    skipConnectors = false,
    safeConnectorHex = null,
    randomOrder = true,
    hedgeProbability = null,
    forceHedge = false,
    correlationId = null,
    targetPad = null
  } = options;

  const validatedTone = CHAIN.VALID_TONES.includes(tone) ? tone : 'neutral';
  const validatedFormality = CHAIN.VALID_FORMALITIES.includes(formality) ? formality : 'casual';

  if (!correlationId) {
    logger.warn('chainPhrases called without correlationId', { outcomeIntent, strategy });
  }

  if (!outcomeIntent || typeof outcomeIntent !== 'string') {
    logger.warn('Invalid outcomeIntent', { outcomeIntent, correlationId });
    Counters.increment('phrase_chain', 'invalid_input');
    return {
      success: false,
      chain: _buildChain(FALLBACK_PHRASES.opener, [], null, null),
      metadata: { outcomeIntent, strategy, error: 'invalid_outcome_intent' }
    };
  }

  if (!strategy || typeof strategy !== 'string') {
    logger.warn('Invalid strategy', { strategy, correlationId });
    Counters.increment('phrase_chain', 'invalid_input');
    return {
      success: false,
      chain: _buildChain(FALLBACK_PHRASES.opener, [], null, null),
      metadata: { outcomeIntent, strategy, error: 'invalid_strategy' }
    };
  }

  try {
    const openerResult = await _fetchOpener(
      outcomeIntent, strategy, validatedTone, validatedFormality, randomOrder, correlationId, targetPad
    );
    const opener = openerResult.phrase;

    const remainingParts = await _fetchRemainingParts(
      outcomeIntent, strategy,
      { tone: validatedTone, formality: validatedFormality, randomOrder, skipConnectors, connectorCount, safeConnectorHex, hedgeProbability, forceHedge, targetPad },
      correlationId
    );

    const chain = _buildChain(
      opener,
      remainingParts.connectors,
      remainingParts.closer,
      remainingParts.hedge
    );

    Counters.increment('phrase_chain', 'success');
    logger.debug('Phrase chain assembled', {
      outcomeIntent,
      strategy,
      structureCode: chain.structureCode,
      openerFallbackLevel: openerResult.fallbackLevel,
      connectorCount: remainingParts.connectors.length,
      hasHedge: !!remainingParts.hedge,
      hasCloser: !!remainingParts.closer,
      correlationId
    });

    return {
      success: true,
      chain,
      metadata: {
        outcomeIntent,
        strategy,
        tone: validatedTone || 'any',
        validatedFormality,
        openerFallbackLevel: openerResult.fallbackLevel,
        phraseIds: {
          opener: opener.phrase_hex_id,
          connectors: remainingParts.connectors.map(c => c.phrase_hex_id),
          closer: remainingParts.closer ? remainingParts.closer.phrase_hex_id : null,
          hedge: remainingParts.hedge ? remainingParts.hedge.phrase_hex_id : null
        }
      }
    };

  } catch (error) {
    Counters.increment('phrase_chain', 'failure');
    logger.error('Phrase chaining failed', {
      outcomeIntent,
      strategy,
      error: error.message,
      correlationId
    });
    return {
      success: false,
      chain: _buildChain(FALLBACK_PHRASES.opener, [], null, null),
      metadata: {
        outcomeIntent,
        strategy,
        error: error.message
      }
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export { chainPhrases, _buildChain as buildChain };
