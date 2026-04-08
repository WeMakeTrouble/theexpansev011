/**
 * ============================================================================
 * findSemanticUtterances.js — Semantic Utterance Search Facade (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Finds semantically similar utterances from the LTLM corpus. This is the
 * fallback chain entry point used by PhaseIntent when searchAction is
 * "not_found" — it ensures Claude always has something to say.
 *
 * V010 ARCHITECTURE CHANGE
 * ------------------------
 * In v009, this module implemented its own TF-IDF vectorisation and cosine
 * similarity on every call, loading the entire canonical corpus into memory
 * each time. This was O(N) per query with no caching.
 *
 * In v010, this module is a thin facade over SemanticEmbedder.findSimilar(),
 * which uses pre-trained hierarchical embeddings (co-occurrence -> PPMI ->
 * SVD -> centroid shaping) with binary cache and worker-thread SVD. The
 * function signature is preserved so callers (PhaseIntent, fallback chains)
 * do not need to change.
 *
 * WHY A FACADE INSTEAD OF DIRECT CALLS
 * -------------------------------------
 * 1. PhaseIntent and fallback logic expect findSemanticUtterances() — keeping
 *    the same name and signature avoids cascading changes across phases.
 * 2. The facade adds fallback-specific defaults (topK=3) that are appropriate
 *    for the "Claude never goes silent" use case. Speaker filtering is not
 *    implemented — all corpus utterances are searched regardless of speaker.
 * 3. If SemanticEmbedder is not ready (cold start, training failure), the
 *    facade returns graceful empty results instead of throwing.
 *
 * FUNCTION SIGNATURE
 * ------------------
 * findSemanticUtterances(inputText, options?) -> Promise<{results, coverage, inputLength}>
 *
 * Options:
 *   topK       — number of results to return (default: 3)
 *   targetPad  — { p, a, d } emotional target for PAD-weighted ranking
 *   outcomeIntent     — filter by outcome_intent_code
 *   dialogueFunction  — filter by dialogue_function_code
 *
 * Returns:
 *   results    — array of { utterance_text, similarity, semanticSimilarity,
 *                pad, training_example_id, outcomeIntent, dialogueFunction }
 *   coverage   — fraction of input tokens known to the embedder (0-1)
 *   inputLength — token count of input after tokenisation
 *
 * FALLBACK BEHAVIOUR
 * ------------------
 * If SemanticEmbedder is not trained or not ready, returns empty results
 * with coverage 0. This ensures the caller can proceed to the next tier
 * in the fallback chain (generic LTLM response, then hard fallback)
 * without crashing.
 *
 * DEPENDENCIES
 * ------------
 * Internal: SemanticEmbedder.js (singleton), logger.js
 * External: None
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import semanticEmbedder from './SemanticEmbedder.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('findSemanticUtterances');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const DEFAULTS = Object.freeze({
  TOP_K: 3,
  NEUTRAL_PAD: Object.freeze({ p: 0, a: 0, d: 0 }),
  PAD_MIN: -1,
  PAD_MAX: 1
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _validatePad(pad) {
  if (!pad || typeof pad !== 'object') return false;
  if (typeof pad.p !== 'number' || typeof pad.a !== 'number' || typeof pad.d !== 'number') return false;
  if (pad.p < DEFAULTS.PAD_MIN || pad.p > DEFAULTS.PAD_MAX) return false;
  if (pad.a < DEFAULTS.PAD_MIN || pad.a > DEFAULTS.PAD_MAX) return false;
  if (pad.d < DEFAULTS.PAD_MIN || pad.d > DEFAULTS.PAD_MAX) return false;
  return true;
}

function _emptyResult(inputLength) {
  return {
    results: [],
    coverage: 0,
    inputLength: inputLength || 0
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main Export                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

export async function findSemanticUtterances(inputText, options) {
  if (options === undefined) options = {};

  if (!inputText || typeof inputText !== 'string' || inputText.trim() === '') {
    logger.info('Empty or invalid input — returning empty results');
    return _emptyResult(0);
  }

  const topK = (typeof options.topK === 'number' && options.topK > 0)
    ? options.topK
    : DEFAULTS.TOP_K;

  const targetPad = _validatePad(options.targetPad)
    ? options.targetPad
    : DEFAULTS.NEUTRAL_PAD;

  try {
    if (!semanticEmbedder.isReady) {
      logger.warn('SemanticEmbedder not ready — attempting warm-up');
      try {
        const WARMUP_TIMEOUT_MS = 15000;
        await Promise.race([
          semanticEmbedder.warmUp(),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("warmUp timed out after " + WARMUP_TIMEOUT_MS + "ms")),
            WARMUP_TIMEOUT_MS
          ))
        ]);
      } catch (warmUpErr) {
        logger.error('SemanticEmbedder warm-up failed in fallback', {
          error: warmUpErr.message
        });
        // Naive whitespace split — embedder not ready so tokenize() unavailable. Documented approximation.
        return _emptyResult(inputText.split(/\s+/).length);
      }
    }

    const searchOptions = {
      targetPad
    };

    if (options.outcomeIntent && typeof options.outcomeIntent === 'string') {
      searchOptions.outcomeIntent = options.outcomeIntent;
    }

    if (options.dialogueFunction && typeof options.dialogueFunction === 'string') {
      searchOptions.dialogueFunction = options.dialogueFunction;
    }

    const FIND_SIMILAR_TIMEOUT_MS = 5000;
    const result = await Promise.race([
      semanticEmbedder.findSimilar(inputText, topK, searchOptions),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("findSimilar timed out after " + FIND_SIMILAR_TIMEOUT_MS + "ms")),
        FIND_SIMILAR_TIMEOUT_MS
      ))
    ]);

    const inputTokenCount = semanticEmbedder.tokenize(inputText).length;

    logger.info('Semantic search complete', {
      inputLength: inputTokenCount,
      coverage: result.coverage,
      resultCount: result.results.length,
      topSimilarity: result.results.length > 0
        ? result.results[0].similarity.toFixed(3)
        : 'N/A',
      projectedToward: result.projectedToward || 'none'
    });

    return {
      results: result.results.map(r => ({
        utterance_text: r.utterance_text,
        similarity: r.similarity,
        semanticSimilarity: r.semanticSimilarity,
        pad: r.pad_pleasure !== undefined ? {
          p: parseFloat(r.pad_pleasure),
          a: parseFloat(r.pad_arousal),
          d: parseFloat(r.pad_dominance)
        } : null,
        training_example_id: r.training_example_id,
        outcomeIntent: r.outcome_intent_code || null,
        dialogueFunction: r.dialogue_function_code || null
      })),
      coverage: result.coverage,
      inputLength: inputTokenCount
    };

  } catch (err) {
    logger.error('Semantic utterance search failed', { error: err.message });
    // Naive whitespace split — embedder unavailable in catch path. Documented approximation.
    return _emptyResult(inputText.split(/\s+/).length);
  }
}

export default findSemanticUtterances;
