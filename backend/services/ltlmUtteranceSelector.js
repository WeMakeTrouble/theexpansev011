/**
 * ============================================================================
 * ltlmUtteranceSelector.js — LTLM Utterance Selection Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Selects LTLM training example utterances for Claude the Tanuki to
 * speak. Uses tiered constraint relaxation to find the best match,
 * enhanced by semantic search when SemanticEmbedder is available.
 *
 * STRATEGY (Tiered Constraint Relaxation)
 * ----------------------------------------
 * T1: speaker + speech_act + dialogue_function + outcome_intent
 * T2: speaker + dialogue_function + outcome_intent
 * T3: speaker + dialogue_function
 * T4: speaker + speech_act
 * T5: speaker only
 *
 * Each tier progressively relaxes constraints until MIN_CANDIDATES
 * (10) are found. Results are then scored by:
 *   - PAD similarity (Euclidean distance, inverted)
 *   - Semantic similarity (when SemanticEmbedder trained)
 *   - Novelty penalty (recently used utterances penalised)
 *
 * Final selection is random from top 10 scored candidates for variety.
 *
 * EXPORTS
 * -------
 * selectLtlmUtteranceForBeat({...}) — Main utterance selector
 * findSemanticUtterances(text, opts) — Direct semantic search (Goal 4)
 * getNoveltyStats() — Debug/monitoring for novelty tracking
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Documentation header
 * - Frozen constants (MIN_CANDIDATES, NOVELTY_WINDOW, etc.)
 * - Input validation on selectLtlmUtteranceForBeat params
 * - Redundant logger prefixes removed (createModuleLogger handles)
 * - Structured logger for all log calls
 * - Defensive SemanticEmbedder import (graceful if missing)
 *
 * DEPENDENCIES
 * ------------
 * - pool.js (PostgreSQL)
 * - SemanticEmbedder.js (optional — degrades gracefully)
 * - logger.js (structured logging)
 *
 * DB TABLES
 * ---------
 * - ltlm_training_examples
 * - ltlm_training_outcome_intents
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('ltlmUtteranceSelector');

/*
 * ============================================================================
 * SemanticEmbedder — Optional Import
 * ============================================================================
 * SemanticEmbedder is a 33KB module that may not be present in v010 yet.
 * Import defensively so the selector works without it.
 * ============================================================================
 */
let semanticEmbedder = null;
try {
  let importTimer;
  const mod = await Promise.race([
    import('./SemanticEmbedder.js'),
    new Promise((_, reject) => {
      importTimer = setTimeout(() => reject(new Error('SemanticEmbedder import timeout')), 3000);
    })
  ]);
  clearTimeout(importTimer);
  semanticEmbedder = mod.default;
} catch (_importErr) {
  logger.info('SemanticEmbedder not available, proceeding without semantic enhancement');
}

/*
 * ============================================================================
 * Constants
 * ============================================================================
 */
const MIN_CANDIDATES = 10;
const MAX_CANDIDATES = 150;
const TOP_K_SELECTION = 10;
const SEMANTIC_RESULTS_COUNT = 15;
const NOVELTY_WINDOW = 50;
const NOVELTY_DECAY = 0.95;
const NOVELTY_MIN_THRESHOLD = 0.1;

/*
 * ============================================================================
 * Scoring Weights
 * ============================================================================
 */
const WEIGHTS = Object.freeze({
  SEMANTIC_SOURCE: Object.freeze({ pad: 0.4, semantic: 0.3, novelty: 0.2, intentBonus: 0.1 }),
  EXACT_SOURCE: Object.freeze({ pad: 0.6, novelty: 0.2, intentBonus: 0.2 })
});

/*
 * ============================================================================
 * Novelty Tracking (in-memory, resets on process restart)
 * ============================================================================
 */
const recentUtterances = new Map();

/**
 * Select an LTLM utterance for a narrative beat.
 *
 * @param {object} params
 * @param {string} params.speakerCharacterId - Who is speaking (#XXXXXX)
 * @param {string} params.speechActCode - The speech act type
 * @param {string} params.dialogueFunctionCode - The dialogue function
 * @param {string} params.outcomeIntentCode - The intended outcome
 * @param {object} params.targetPad - Target emotional state {pleasure, arousal, dominance}
 * @param {string} [params.contextText] - Optional context for semantic matching
 * @returns {Promise<object|null>} Selected utterance or null
 */
export async function selectLtlmUtteranceForBeat({
  speakerCharacterId,
  speechActCode,
  dialogueFunctionCode,
  outcomeIntentCode,
  targetPad,
  contextText = null
}) {
  if (!speakerCharacterId || !targetPad) {
    logger.warn('Missing required params', {
      hasSpeaker: !!speakerCharacterId,
      hasTargetPad: !!targetPad
    });
    return null;
  }

  const { pleasure, arousal, dominance } = targetPad;
  if (![pleasure, arousal, dominance].every(v => typeof v === 'number' && !isNaN(v))) {
    logger.warn('Invalid PAD values in targetPad', { targetPad });
    return null;
  }
  const client = await pool.connect();

  try {
    let candidates = [];
    await client.query('SET statement_timeout = 800');

    let tierUsed = 0;

    const tiers = [
      {
        name: 'T1: Full Match',
        conditions: `
          e.speaker_character_id = $1
          AND e.speech_act_code = $2
          AND e.dialogue_function_code = $3
          AND oi.outcome_intent_code = $4
        `,
        params: [speakerCharacterId, speechActCode, dialogueFunctionCode, outcomeIntentCode],
        padStartIndex: 5
      },
      {
        name: 'T2: Drop Speech Act',
        conditions: `
          e.speaker_character_id = $1
          AND e.dialogue_function_code = $2
          AND oi.outcome_intent_code = $3
        `,
        params: [speakerCharacterId, dialogueFunctionCode, outcomeIntentCode],
        padStartIndex: 4
      },
      {
        name: 'T3: Speaker + Dialogue Function',
        conditions: `
          e.speaker_character_id = $1
          AND e.dialogue_function_code = $2
        `,
        params: [speakerCharacterId, dialogueFunctionCode],
        padStartIndex: 3
      },
      {
        name: 'T4: Speaker + Speech Act',
        conditions: `
          e.speaker_character_id = $1
          AND e.speech_act_code = $2
        `,
        params: [speakerCharacterId, speechActCode],
        padStartIndex: 3
      },
      {
        name: 'T5: Speaker Only',
        conditions: `
          e.speaker_character_id = $1
        `,
        params: [speakerCharacterId],
        padStartIndex: 2
      }
    ];

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      tierUsed = i + 1;

      if (tier.params.some(p => p === null || p === undefined)) {
        continue;
      }

      const pIdx = tier.padStartIndex;
      const tierSql = `
        SELECT
          e.training_example_id,
          e.utterance_text,
          e.pad_pleasure,
          e.pad_arousal,
          e.pad_dominance,
          e.dialogue_function_code,
          e.speech_act_code,
          oi.outcome_intent_code
        FROM ltlm_training_examples e
        LEFT JOIN ltlm_training_outcome_intents oi
          ON oi.training_example_id = e.training_example_id
        WHERE ${tier.conditions}
        ORDER BY
          (e.pad_pleasure - $${pIdx}) * (e.pad_pleasure - $${pIdx})
          + (e.pad_arousal - $${pIdx + 1}) * (e.pad_arousal - $${pIdx + 1})
          + (e.pad_dominance - $${pIdx + 2}) * (e.pad_dominance - $${pIdx + 2})
        LIMIT 50
      `;

      const tierParams = [...tier.params, pleasure, arousal, dominance];
      const tierResult = await client.query(tierSql, tierParams);
      // Intentional overwrite: each tier replaces previous candidates by design.
      // Progressive constraint relaxation — if this tier reaches MIN_CANDIDATES
      // it breaks early; otherwise the next (broader) tier overwrites and tries again.
      candidates = tierResult.rows;

      const seen = new Set();
      candidates = candidates.filter(row => {
        if (seen.has(row.training_example_id)) return false;
        seen.add(row.training_example_id);
        return true;
      });

      if (candidates.length >= MIN_CANDIDATES) {
        break;
      }
    }

    if (semanticEmbedder && semanticEmbedder.trained) {
      try {
        const searchText = contextText || _buildSearchText(dialogueFunctionCode, outcomeIntentCode, speechActCode);

        if (searchText) {
          let semTimer;
          const semanticResults = await Promise.race([
            semanticEmbedder.findSimilar(searchText, SEMANTIC_RESULTS_COUNT, {
              outcomeIntent: outcomeIntentCode || undefined,
              dialogueFunction: dialogueFunctionCode || undefined,
              targetPad: { p: pleasure, a: arousal, d: dominance }
            }),
            new Promise((_, reject) => {
              semTimer = setTimeout(() => reject(new Error('Semantic search timeout')), 5000);
            })
          ]).finally(() => clearTimeout(semTimer));
          if (semanticResults.results && semanticResults.results.length > 0) {
            const existingIds = new Set(candidates.map(c => c.training_example_id));

            for (const semResult of semanticResults.results) {
              if (!existingIds.has(semResult.training_example_id)) {
                candidates.push({
                  training_example_id: semResult.training_example_id,
                  utterance_text: semResult.utterance_text,
                  pad_pleasure: semResult.pad_pleasure,
                  pad_arousal: semResult.pad_arousal,
                  pad_dominance: semResult.pad_dominance,
                  dialogue_function_code: semResult.dialogue_function_code,
                  speech_act_code: semResult.speech_act_code,
                  outcome_intent_code: semResult.outcome_intent_code,
                  semantic_similarity: semResult.similarity,
                  source: 'semantic'
                });
                existingIds.add(semResult.training_example_id);
              }
            }
          }
        }
      } catch (semError) {
        logger.warn('Semantic enhancement failed', { error: semError.message });
      }
    }


    if (candidates.length === 0) {
      logger.warn('No candidates found at any tier', {
        speakerCharacterId,
        dialogueFunctionCode,
        speechActCode
      });
      return null;
    }

    const scoredCandidates = candidates.map(row => {
      const padDistance = Math.sqrt(
        Math.pow((row.pad_pleasure || 0) - pleasure, 2) +
        Math.pow((row.pad_arousal || 0) - arousal, 2) +
        Math.pow((row.pad_dominance || 0) - dominance, 2)
      );
      const maxPadDistance = Math.sqrt(12);
      const padScore = 1 - (padDistance / maxPadDistance);

      const semanticScore = row.semantic_similarity || 0;

      const usage = recentUtterances.get(speakerCharacterId + ':' + row.training_example_id);
      const noveltyScore = usage ? 1 / (1 + usage.count) : 1;

      const combinedScore = row.source === 'semantic'
        ? (WEIGHTS.SEMANTIC_SOURCE.pad * padScore) + (WEIGHTS.SEMANTIC_SOURCE.semantic * semanticScore) + (WEIGHTS.SEMANTIC_SOURCE.novelty * noveltyScore) + (WEIGHTS.SEMANTIC_SOURCE.intentBonus * (row.outcome_intent_code ? 1 : 0.5))
        : (WEIGHTS.EXACT_SOURCE.pad * padScore) + (WEIGHTS.EXACT_SOURCE.novelty * noveltyScore) + (WEIGHTS.EXACT_SOURCE.intentBonus * (row.outcome_intent_code ? 1 : 0.5));

      return {
        ...row,
        padScore,
        semanticScore,
        noveltyScore,
        combinedScore
      };
    });

    scoredCandidates.sort((a, b) => b.combinedScore - a.combinedScore);

    const topCandidates = scoredCandidates.slice(0, Math.min(TOP_K_SELECTION, scoredCandidates.length));
    const timeSalt = String(Math.floor(Date.now() / 60000));
    const selected = topCandidates[_deterministicIndex(speakerCharacterId + dialogueFunctionCode + speechActCode + outcomeIntentCode + timeSalt, topCandidates.length)];

    _updateNoveltyTracking(speakerCharacterId + ':' + selected.training_example_id);

    return {
      trainingExampleId: selected.training_example_id,
      utteranceText: selected.utterance_text,
      pad: {
        pleasure: selected.pad_pleasure,
        arousal: selected.pad_arousal,
        dominance: selected.pad_dominance
      },
      dialogueFunction: selected.dialogue_function_code,
      speechAct: selected.speech_act_code,
      outcomeIntent: selected.outcome_intent_code,
      scores: {
        pad: selected.padScore,
        semantic: selected.semanticScore,
        novelty: selected.noveltyScore,
        combined: selected.combinedScore
      },
      source: selected.source || 'exact',
      tierUsed,
      candidatePoolSize: candidates.length
    };
  } finally {
    client.release();
  }
}

/**
 * Direct semantic search for utterances (Goal 4: fallback chain).
 *
 * @param {string} inputText - Text to search for similar utterances
 * @param {object} [options] - Search options
 * @param {number} [options.topK=5] - Number of results
 * @param {string} [options.outcomeIntentCode] - Filter by outcome intent
 * @param {string} [options.dialogueFunctionCode] - Filter by dialogue function
 * @param {object} [options.targetPad] - Target PAD for ranking
 * @returns {Promise<object>} Search results with coverage
 */
export async function findSemanticUtterances(inputText, options = {}) {
  if (!semanticEmbedder || !semanticEmbedder.trained) {
    logger.warn('SemanticEmbedder not available for semantic search');
    return { results: [], coverage: 0 };
  }

  return semanticEmbedder.findSimilar(inputText, options.topK || 5, {
    outcomeIntent: options.outcomeIntentCode,
    dialogueFunction: options.dialogueFunctionCode,
    targetPad: options.targetPad
  });
}

/**
 * Get novelty tracking stats (for debugging/monitoring).
 *
 * @returns {object} Current novelty tracking state
 */
export function getNoveltyStats() {
  return {
    trackedUtterances: recentUtterances.size,
    windowSize: NOVELTY_WINDOW,
    decayFactor: NOVELTY_DECAY,
    entries: [...recentUtterances.entries()].map(([id, data]) => ({
      id,
      count: data.count.toFixed(2),
      lastUsed: new Date(data.lastUsed).toISOString()
    }))
  };
}

/*
 * ============================================================================
 * Private Helpers
 * ============================================================================
 */

/**
 * Update novelty tracking for a selected utterance.
 * @private
 */
function _deterministicIndex(str, len) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) % len;
}

function _updateNoveltyTracking(trainingExampleId) {
  for (const [id, data] of recentUtterances.entries()) {
    data.count *= NOVELTY_DECAY;
    if (data.count < NOVELTY_MIN_THRESHOLD) {
      recentUtterances.delete(id);
    }
  }

  const existing = recentUtterances.get(trainingExampleId);
  if (existing) {
    existing.count += 1;
    existing.lastUsed = Date.now();
  } else {
    recentUtterances.set(trainingExampleId, { count: 1, lastUsed: Date.now() });
  }

  if (recentUtterances.size > NOVELTY_WINDOW * 2) {
    const oldest = [...recentUtterances.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, recentUtterances.size - NOVELTY_WINDOW);
    oldest.forEach(([id]) => recentUtterances.delete(id));
  }
}

/**
 * Build search text from parameters for semantic matching.
 * @private
 */
function _buildSearchText(dialogueFunctionCode, outcomeIntentCode, speechActCode) {
  const parts = [];

  if (dialogueFunctionCode) {
    const func = dialogueFunctionCode.split('.').pop();
    parts.push(func);
  }

  if (outcomeIntentCode) {
    const outcome = outcomeIntentCode.split('.').pop().replace(/_/g, ' ');
    parts.push(outcome);
  }

  if (speechActCode) {
    const act = speechActCode.split('.').pop();
    if (!parts.includes(act)) {
      parts.push(act);
    }
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
