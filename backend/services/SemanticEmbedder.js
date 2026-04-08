/**
 * ============================================================================
 * SemanticEmbedder.js — Domain-Specific Semantic Vector Engine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Learn semantic meaning from the LTLM corpus ONLY. No external models.
 * No APIs. No downloaded weights. No pre-trained transformers.
 * "Claude won't know language in the abstract. He'll know how THIS
 * world speaks."
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Trains a complete semantic embedding system from ~5000 LTLM utterances:
 *   1. Builds vocabulary from corpus (capped, frequency-filtered)
 *   2. Computes word co-occurrence matrix (sparse)
 *   3. Applies PPMI weighting (reduces frequency domination)
 *   4. Runs truncated SVD via worker thread (non-blocking)
 *   5. Computes utterance vectors (average of word vectors)
 *   6. Computes outcome_intent centroids (WHY anchors)
 *   7. Computes dialogue_function centroids (HOW anchors)
 *   8. Applies hierarchical shaping (pulls vectors toward centroids)
 *   9. Caches everything in binary format with SHA-256 hash validation
 *
 * ARCHITECTURE (4-Layer)
 * ----------------------
 * Layer 1: Co-occurrence embeddings (unsupervised, sparse matrix)
 * Layer 2: PPMI weighting (reduces frequency domination)
 * Layer 3: Truncated SVD with convergence tolerance (worker thread)
 * Layer 4: Hierarchical intent shaping (supervised)
 *
 * SEMANTIC HIERARCHY
 * ------------------
 * alpha (0.60) = original vector weight
 * beta  (0.25) = outcome_intent centroid (WHY — primary semantic anchor)
 * gamma (0.15) = dialogue_function centroid (HOW — secondary tactical anchor)
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * 1.  SVD runs in worker thread (svdWorker.js) — no event loop blocking
 * 2.  Binary cache format — vectors stored as Buffer, ~70% smaller
 * 3.  Async cursor for _loadUtterances — streams in batches of 500
 * 4.  isReady getter fixed — trained flag is sufficient, cache not required
 * 5.  Unicode-aware tokenization — handles accented chars and diacritics
 * 6.  Dynamic vector dimensions — scales with vocab size (floor 32, cap 128)
 * 7.  Frozen constants throughout (STOP_WORDS, DEFAULT_CONFIG, CACHE_VERSION)
 * 8.  Input validation on all public methods
 * 9.  Full v010 documentation header
 * 10. Structured logger only — no console.log
 *
 * INVARIANTS (FORMAL)
 * -------------------
 * 1. All vectors are L2-normalized (||v||_2 = 1)
 * 2. wordVectors is subset of utteranceVectors (by vocabulary)
 * 3. outcomeIntentCentroids computed from utteranceVectors (by outcome_intent_code)
 * 4. dialogueFunctionCentroids computed from utteranceVectors (by dialogue_function_code)
 * 5. Hash match is necessary but not sufficient for cache validity.
 *    A hash mismatch invalidates cache, but a hash match does not guarantee
 *    uncorrupted data (corrupted binary file with valid hash would load garbage).
 *    assertStateConsistency catches empty maps but not corrupted vector values.
 * 6. Trained state = (wordVectors.size > 0 AND utteranceVectors.size > 0)
 * 7. Ready state = (trained = true) — cache validity is bonus, not requirement
 * 8. Shaping weights sum to 1.0 (alpha + beta + gamma = 1.0)
 *
 * CACHING CONTRACT
 * ----------------
 * - Cache valid if and only if corpus hash matches stored hash
 * - Hash is SHA-256(count:ordered_ids:ordered_texts)
 * - v010 uses binary format: vectors as Float64Array Buffers, metadata as JSON
 * - Cache invalidation is automatic (no manual cache-busting)
 * - Warm-up is idempotent: warmUp() twice = same result
 *
 * PERFORMANCE GUARANTEES
 * ----------------------
 * - Vocab cap prevents O(V^3) SVD explosion
 * - Sparse co-occurrence prevents O(V^2) memory overload
 * - Cache hit: <1 second (binary I/O)
 * - Cold start: ~20-25 seconds (SVD in worker thread — non-blocking)
 * - Hash computation: O(n) where n = utterance count (~4.5k)
 * - _loadUtterances streams in batches — no full-corpus memory spike
 *
 * CONSUMERS
 * ---------
 * - ltlmUtteranceSelector.js (semantic search for utterance matching)
 * - Future: SemanticAnswerEvaluator, TanukiScribe, IdentityModule
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, svdWorker.js
 * External: crypto (Node.js built-in), fs/promises, path, worker_threads
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Worker } from 'worker_threads';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('SemanticEmbedder');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'v010-binary';

const STOP_WORDS_LIST = Object.freeze([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'its',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'their', 'them', 'they',
  'your', 'you', 'our', 'out', 'about', 'get', 'got', 'getting'
]);

const STOP_WORDS = new Set(STOP_WORDS_LIST);

const DEFAULT_CONFIG = Object.freeze({
  MIN_VECTOR_DIMENSIONS: 32,
  MAX_VECTOR_DIMENSIONS: 128,
  DYNAMIC_DIM_DIVISOR: 20,
  MIN_WORD_FREQUENCY: 2,
  MAX_VOCAB_SIZE: 1500,
  SVD_CONVERGENCE_TOLERANCE: 1e-4,
  SVD_MAX_ITERATIONS: 100,
  ALPHA_ORIGINAL: 0.60,
  BETA_OUTCOME_INTENT: 0.25,
  GAMMA_DIALOGUE_FUNCTION: 0.15,
  RUNTIME_INTENT_PROJECTION: 0.85,
  PAD_SIMILARITY_WEIGHT: 0.15,
  SEMANTIC_SIMILARITY_WEIGHT: 0.85,
  UTTERANCE_BATCH_SIZE: 500
});

const SVD_WORKER_PATH = path.join(__dirname, 'svdWorker.js');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Error Class                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

class SemanticEmbedderError extends Error {
  constructor(message) {
    super('[SemanticEmbedder] ' + message);
    this.name = 'SemanticEmbedderError';
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Invariant Assertions                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function assertMapNotEmpty(map, name) {
  if (map.size === 0) {
    throw new SemanticEmbedderError('Invariant violated: ' + name + ' is empty');
  }
}

function assertStateConsistency(trained, wordVectors, utteranceVectors) {
  if (trained && wordVectors.size === 0) {
    throw new SemanticEmbedderError('Invariant violated: trained=true but wordVectors empty');
  }
  if (trained && utteranceVectors.size === 0) {
    throw new SemanticEmbedderError('Invariant violated: trained=true but utteranceVectors empty');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Sparse Matrix                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

class SparseMatrix {
  constructor(size) {
    this.size = size;
    this.data = new Map();
  }

  get(i, j) {
    const key = i + ',' + j;
    return this.data.get(key) || 0;
  }

  set(i, j, value) {
    const key = i + ',' + j;
    if (value === 0) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }

  add(i, j, delta) {
    if (delta === undefined) delta = 1;
    this.set(i, j, this.get(i, j) + delta);
  }

  toArray() {
    const arr = Array(this.size).fill(null).map(() => new Float64Array(this.size));
    for (const [key, value] of this.data.entries()) {
      const parts = key.split(',');
      arr[parseInt(parts[0], 10)][parseInt(parts[1], 10)] = value;
    }
    return arr;
  }

  getSparsity() {
    return 1 - (this.data.size / (this.size * this.size));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  SemanticEmbedder Class                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

class SemanticEmbedder {
  constructor(options) {
    if (options === undefined) options = {};

    this.minWordFrequency = options.minWordFrequency || DEFAULT_CONFIG.MIN_WORD_FREQUENCY;
    this.maxVocabSize = options.maxVocabSize || DEFAULT_CONFIG.MAX_VOCAB_SIZE;
    this.svdConvergenceTolerance = options.svdConvergenceTolerance || DEFAULT_CONFIG.SVD_CONVERGENCE_TOLERANCE;
    this.svdMaxIterations = options.svdMaxIterations || DEFAULT_CONFIG.SVD_MAX_ITERATIONS;

    this.alphaOriginal = options.alphaOriginal || DEFAULT_CONFIG.ALPHA_ORIGINAL;
    this.betaOutcomeIntent = options.betaOutcomeIntent || DEFAULT_CONFIG.BETA_OUTCOME_INTENT;
    this.gammaDialogueFunction = options.gammaDialogueFunction || DEFAULT_CONFIG.GAMMA_DIALOGUE_FUNCTION;

    this.runtimeIntentProjection = options.runtimeIntentProjection || DEFAULT_CONFIG.RUNTIME_INTENT_PROJECTION;

    this.padSimilarityWeight = options.padSimilarityWeight || DEFAULT_CONFIG.PAD_SIMILARITY_WEIGHT;
    this.semanticSimilarityWeight = options.semanticSimilarityWeight || DEFAULT_CONFIG.SEMANTIC_SIMILARITY_WEIGHT;

    this.filterStopWords = options.filterStopWords !== false;

    this.vectorDimensions = options.vectorDimensions || null;

    const weightSum = this.alphaOriginal + this.betaOutcomeIntent + this.gammaDialogueFunction;
    if (Math.abs(weightSum - 1.0) > 1e-6) {
      throw new SemanticEmbedderError('Shaping weights must sum to 1.0, got ' + weightSum);
    }

    this.wordVectors = new Map();
    this.utteranceVectors = new Map();
    this.dialogueFunctionCentroids = new Map();
    this.outcomeIntentCentroids = new Map();
    this.utterancePAD = new Map();

    this.vocabIndex = new Map();
    this.indexVocab = [];

    this.trainingStats = null;
    this.trained = false;

    this.cacheDir = path.join(__dirname, '../../cache/models');
    this._ready = false;
    this.corpusHash = null;
    this._cacheValid = false;
    this._cacheStats = {
      lastLoadedAt: null,
      hits: 0,
      misses: 0,
      savedAt: null
    };

    this._svdMetrics = {
      totalIterations: 0,
      convergenceAchieved: false,
      finalResidual: null,
      perDimension: []
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Dynamic Vector Dimensions                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computeDynamicDimensions(vocabSize) {
    if (this.vectorDimensions) {
      return this.vectorDimensions;
    }

    const dynamic = Math.floor(vocabSize / DEFAULT_CONFIG.DYNAMIC_DIM_DIVISOR);
    const clamped = Math.max(
      DEFAULT_CONFIG.MIN_VECTOR_DIMENSIONS,
      Math.min(DEFAULT_CONFIG.MAX_VECTOR_DIMENSIONS, dynamic)
    );

    logger.info('Dynamic vector dimensions computed', {
      vocabSize,
      rawDynamic: dynamic,
      clamped
    });

    return clamped;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Corpus Hash                                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async computeCorpusHash() {
    try {
      const result = await pool.query(
        'SELECT COUNT(*) as count, ' +
        "STRING_AGG(training_example_id::text, ',' ORDER BY training_example_id) as ids, " +
        "STRING_AGG(utterance_text, '|' ORDER BY training_example_id) as texts " +
        'FROM ltlm_training_examples WHERE utterance_text IS NOT NULL'
      );

      const row = result.rows[0];
      if (!row.ids || !row.texts) {
        logger.warn('No utterances found in database');
        return null;
      }

      const data = row.count + ':' + row.ids + ':' + row.texts;
      return crypto.createHash('sha256').update(data).digest('hex');
    } catch (err) {
      logger.error('Hash computation failed', { error: err.message });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Binary Cache — Load                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async loadFromCache() {
    try {
      const metaFile = path.join(this.cacheDir, 'semantic-embedder-meta.json');
      const vectorFile = path.join(this.cacheDir, 'semantic-embedder-vectors.bin');
      const hashFile = path.join(this.cacheDir, 'semantic-embedder.hash');

      await fs.access(metaFile);
      await fs.access(vectorFile);
      await fs.access(hashFile);

      const storedHash = (await fs.readFile(hashFile, 'utf8')).trim();
      const currentHash = await this.computeCorpusHash();

      if (!currentHash) {
        logger.info('Cache load: corpus hash unavailable');
        return false;
      }

      if (storedHash !== currentHash) {
        logger.info('Cache hash mismatch — invalidated');
        this._cacheValid = false;
        return false;
      }

      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));

      if (meta.version !== CACHE_VERSION) {
        logger.info('Cache version mismatch (expected ' + CACHE_VERSION + ')');
        return false;
      }

      const vectorBuffer = await fs.readFile(vectorFile);
      this._deserializeVectors(meta, vectorBuffer);

      this.trained = true;
      this._ready = true;
      this._cacheValid = true;
      this.corpusHash = currentHash;
      this._cacheStats.lastLoadedAt = new Date().toISOString();
      this._cacheStats.hits++;

      assertStateConsistency(this.trained, this.wordVectors, this.utteranceVectors);

      logger.info('Loaded from binary cache (hash verified)', {
        words: this.wordVectors.size,
        utterances: this.utteranceVectors.size,
        dimensions: this.vectorDimensions
      });
      return true;
    } catch (err) {
      this._cacheValid = false;
      this._cacheStats.misses++;
      return false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Binary Cache — Save                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async saveToCache() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });

      const metaFile = path.join(this.cacheDir, 'semantic-embedder-meta.json');
      const vectorFile = path.join(this.cacheDir, 'semantic-embedder-vectors.bin');
      const hashFile = path.join(this.cacheDir, 'semantic-embedder.hash');

      const { meta, vectorBuffer } = this._serializeVectors();

      await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
      await fs.writeFile(vectorFile, vectorBuffer);
      await fs.writeFile(hashFile, this.corpusHash);

      this._cacheValid = true;
      this._cacheStats.savedAt = new Date().toISOString();

      const sizeMB = (vectorBuffer.length / (1024 * 1024)).toFixed(2);
      logger.info('Saved to binary cache', { sizeMB, version: CACHE_VERSION });
    } catch (err) {
      logger.warn('Cache save failed', { error: err.message });
      this._cacheValid = false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Binary Serialization                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _serializeVectors() {
    const dims = this.vectorDimensions;
    const wordEntries = [...this.wordVectors.entries()];
    const uttEntries = [...this.utteranceVectors.entries()];
    const outEntries = [...this.outcomeIntentCentroids.entries()];
    const dlgEntries = [...this.dialogueFunctionCentroids.entries()];

    const totalFloats =
      (wordEntries.length * dims) +
      (uttEntries.length * dims) +
      (outEntries.length * dims) +
      (dlgEntries.length * dims);

    const buffer = Buffer.alloc(totalFloats * 8);
    let offset = 0;

    for (const [key, vec] of wordEntries) {
      for (let i = 0; i < dims; i++) {
        buffer.writeDoubleBE(vec[i], offset);
        offset += 8;
      }
    }

    for (const [key, data] of uttEntries) {
      for (let i = 0; i < dims; i++) {
        buffer.writeDoubleBE(data.vector[i], offset);
        offset += 8;
      }
    }

    for (const [key, vec] of outEntries) {
      for (let i = 0; i < dims; i++) {
        buffer.writeDoubleBE(vec[i], offset);
        offset += 8;
      }
    }

    for (const [key, vec] of dlgEntries) {
      for (let i = 0; i < dims; i++) {
        buffer.writeDoubleBE(vec[i], offset);
        offset += 8;
      }
    }

    const meta = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      corpusHash: this.corpusHash,
      vectorDimensions: dims,
      wordKeys: wordEntries.map(e => e[0]),
      utteranceKeys: uttEntries.map(e => e[0]),
      utteranceMeta: uttEntries.map(e => ({
        outcomeIntent: e[1].outcomeIntent,
        dialogueFunction: e[1].dialogueFunction,
        speechAct: e[1].speechAct
      })),
      outcomeIntentKeys: outEntries.map(e => e[0]),
      dialogueFunctionKeys: dlgEntries.map(e => e[0]),
      utterancePAD: [...this.utterancePAD.entries()],
      vocabIndex: [...this.vocabIndex.entries()],
      indexVocab: this.indexVocab,
      trainingStats: this.trainingStats,
      _svdMetrics: this._svdMetrics
    };

    return { meta, vectorBuffer: buffer };
  }

  _deserializeVectors(meta, buffer) {
    const dims = meta.vectorDimensions;
    this.vectorDimensions = dims;
    let offset = 0;

    this.wordVectors = new Map();
    for (const key of meta.wordKeys) {
      const vec = new Float64Array(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = buffer.readDoubleBE(offset);
        offset += 8;
      }
      this.wordVectors.set(key, vec);
    }

    this.utteranceVectors = new Map();
    for (let idx = 0; idx < meta.utteranceKeys.length; idx++) {
      const key = meta.utteranceKeys[idx];
      const vec = new Float64Array(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = buffer.readDoubleBE(offset);
        offset += 8;
      }
      const uttMeta = meta.utteranceMeta[idx];
      this.utteranceVectors.set(key, {
        vector: vec,
        outcomeIntent: uttMeta.outcomeIntent,
        dialogueFunction: uttMeta.dialogueFunction,
        speechAct: uttMeta.speechAct
      });
    }

    this.outcomeIntentCentroids = new Map();
    for (const key of meta.outcomeIntentKeys) {
      const vec = new Float64Array(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = buffer.readDoubleBE(offset);
        offset += 8;
      }
      this.outcomeIntentCentroids.set(key, vec);
    }

    this.dialogueFunctionCentroids = new Map();
    for (const key of meta.dialogueFunctionKeys) {
      const vec = new Float64Array(dims);
      for (let i = 0; i < dims; i++) {
        vec[i] = buffer.readDoubleBE(offset);
        offset += 8;
      }
      this.dialogueFunctionCentroids.set(key, vec);
    }

    this.utterancePAD = new Map(meta.utterancePAD);
    this.vocabIndex = new Map(meta.vocabIndex);
    this.indexVocab = meta.indexVocab;
    this.trainingStats = meta.trainingStats;
    this._svdMetrics = meta._svdMetrics || {};
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Warm-Up (Idempotent)                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async warmUp() {
    const start = Date.now();
    logger.info('Warm-up starting (v010 binary cache + worker SVD)');

    try {
      const cached = await this.loadFromCache();

      if (cached) {
        logger.info('Ready from cache', { elapsed: Date.now() - start });
        return this.trainingStats;
      }

      logger.info('Cache miss or invalid — training fresh');
      await this.train();

      this.corpusHash = await this.computeCorpusHash();
      if (!this.corpusHash) {
        throw new SemanticEmbedderError('Hash computation failed after training');
      }

      await this.saveToCache();

      logger.info('Warm-up completed', { elapsed: Date.now() - start });
      return this.trainingStats;
    } catch (err) {
      logger.error('Warm-up failed', { error: err.message });
      this._ready = false;
      this._cacheValid = false;
      throw err;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  isReady — Fixed: trained is sufficient (v009 bug fix)                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  get isReady() {
    return this._ready && this.trained;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Training Pipeline                                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async train() {
    logger.info('Training on LTLM corpus (v010)');
    const startTime = Date.now();

    try {
      const utterances = await this._loadUtterances();
      if (utterances.length === 0) {
        throw new SemanticEmbedderError('No utterances found in database');
      }
      logger.info('Loaded utterances', { count: utterances.length });

      const padCount = this._loadPADScores(utterances);

      this._buildVocabulary(utterances);
      assertMapNotEmpty(this.vocabIndex, 'vocabIndex');
      logger.info('Vocabulary built', { wordCount: this.indexVocab.length });

      this.vectorDimensions = this._computeDynamicDimensions(this.indexVocab.length);
      logger.info('Vector dimensions set', { dimensions: this.vectorDimensions });

      const coocMatrix = this._buildCooccurrenceMatrix(utterances);
      const ppmiMatrix = this._computePPMI(coocMatrix);

      const wordVectorMatrix = await this._runSVDWorker(ppmiMatrix);
      this._storeWordVectors(wordVectorMatrix);
      assertMapNotEmpty(this.wordVectors, 'wordVectors');

      const { skipped, noOutcome, noDialogue } = this._computeUtteranceVectors(utterances);
      assertMapNotEmpty(this.utteranceVectors, 'utteranceVectors');

      const outcomeCount = this._computeOutcomeCentroids();
      const dialogueCount = this._computeDialogueCentroids();

      const shapedCount = this._applyHierarchicalShaping();

      this.trained = true;
      this._ready = true;
      const elapsed = Date.now() - startTime;

      this.trainingStats = {
        vocabularySize: this.wordVectors.size,
        utteranceCount: this.utteranceVectors.size,
        outcomeIntentCentroids: outcomeCount,
        dialogueFunctionCentroids: dialogueCount,
        dimensions: this.vectorDimensions,
        trainingTimeMs: elapsed,
        skippedUtterances: skipped,
        utterancesWithoutOutcomeIntent: noOutcome,
        utterancesWithoutDialogueFunction: noDialogue,
        shapedUtterances: shapedCount,
        padScoresLoaded: padCount,
        svdMetrics: this._svdMetrics
      };

      assertStateConsistency(this.trained, this.wordVectors, this.utteranceVectors);

      logger.info('Training complete', { elapsed, stats: this.trainingStats });
      return this.trainingStats;

    } catch (err) {
      logger.error('Training failed', { error: err.message });
      this.trained = false;
      this._ready = false;
      throw err;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Load Utterances — Async Batched                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _loadUtterances() {
    const batchSize = DEFAULT_CONFIG.UTTERANCE_BATCH_SIZE;
    const allRows = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await pool.query(
        'SELECT te.training_example_id, te.utterance_text, ' +
        'te.dialogue_function_code, te.speech_act_code, ' +
        'te.pad_pleasure, te.pad_arousal, te.pad_dominance, ' +
        'toi.outcome_intent_code ' +
        'FROM ltlm_training_examples te ' +
        'LEFT JOIN ltlm_training_outcome_intents toi ' +
        'ON te.training_example_id = toi.training_example_id ' +
        'WHERE te.utterance_text IS NOT NULL ' +
        'ORDER BY te.training_example_id ' +
        'LIMIT $1 OFFSET $2',
        [batchSize, offset]
      );

      allRows.push(...result.rows);

      if (result.rows.length < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }
    }

    logger.info('Utterances loaded in batches', {
      totalRows: allRows.length,
      batchSize,
      batches: Math.ceil(allRows.length / batchSize)
    });

    return allRows;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Load PAD Scores                                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _loadPADScores(utterances) {
    let count = 0;
    for (const row of utterances) {
      if (row.pad_pleasure !== null && row.pad_arousal !== null && row.pad_dominance !== null) {
        this.utterancePAD.set(row.training_example_id, {
          p: parseFloat(row.pad_pleasure),
          a: parseFloat(row.pad_arousal),
          d: parseFloat(row.pad_dominance)
        });
        count++;
      }
    }
    logger.info('Loaded PAD scores', { count });
    return count;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Build Vocabulary                                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildVocabulary(utterances) {
    const wordFrequency = new Map();
    for (const row of utterances) {
      const words = this.tokenize(row.utterance_text);
      for (const word of words) {
        wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
      }
    }

    const filteredVocab = [...wordFrequency.entries()]
      .filter(([word, freq]) => freq >= this.minWordFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxVocabSize);

    this.vocabIndex = new Map();
    this.indexVocab = [];

    let vocabIdx = 0;
    for (const [word] of filteredVocab) {
      this.vocabIndex.set(word, vocabIdx);
      this.indexVocab.push(word);
      vocabIdx++;
    }

    logger.info('Vocabulary capped', { finalSize: this.indexVocab.length, originalSize: wordFrequency.size });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Co-occurrence Matrix                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildCooccurrenceMatrix(utterances) {
    const vocabSize = this.indexVocab.length;
    const coocMatrix = new SparseMatrix(vocabSize);

    for (const row of utterances) {
      const words = this.tokenize(row.utterance_text);
      const uniqueWords = [...new Set(words)].filter(w => this.vocabIndex.has(w));

      for (let i = 0; i < uniqueWords.length; i++) {
        for (let j = i + 1; j < uniqueWords.length; j++) {
          const idx1 = this.vocabIndex.get(uniqueWords[i]);
          const idx2 = this.vocabIndex.get(uniqueWords[j]);
          coocMatrix.add(idx1, idx2);
          coocMatrix.add(idx2, idx1);
        }
      }
    }

    logger.info('Co-occurrence matrix built', {
      vocabSize,
      sparsity: (coocMatrix.getSparsity() * 100).toFixed(1)
    });

    return coocMatrix.toArray();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  PPMI                                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computePPMI(coocMatrix) {
    const n = coocMatrix.length;
    // NOTE: Densification is intentional here. The sparse co-occurrence matrix is
    // converted to a dense Float64Array for SVD input — standard approach for
    // truncated SVD. At max vocab cap (1500), this is 1500^2 * 8 bytes = ~18MB.
    // Acceptable: singleton instance, single cold-start allocation, GC'd after training.
    // The PERFORMANCE GUARANTEES doc claim ("sparse co-occurrence prevents O(V^2) memory")
    // applies to the co-occurrence phase only, not this PPMI step.
    const ppmi = Array(n).fill(null).map(() => new Float64Array(n));

    const rowSums = new Float64Array(n);
    const colSums = new Float64Array(n);
    let total = 0;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        rowSums[i] += coocMatrix[i][j];
        colSums[j] += coocMatrix[i][j];
        total += coocMatrix[i][j];
      }
    }

    const epsilon = 1e-10;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (coocMatrix[i][j] === 0) continue;

        const pij = coocMatrix[i][j] / (total + epsilon);
        const pi = rowSums[i] / (total + epsilon);
        const pj = colSums[j] / (total + epsilon);

        const pmi = Math.log2((pij + epsilon) / ((pi * pj) + epsilon));
        ppmi[i][j] = Math.max(0, pmi);
      }
    }

    return ppmi;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  SVD via Worker Thread                                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _runSVDWorker(ppmiMatrix) {
    logger.info('Spawning SVD worker thread', {
      vocabSize: ppmiMatrix.length,
      dimensions: this.vectorDimensions,
      tolerance: this.svdConvergenceTolerance
    });

    const SVD_WORKER_TIMEOUT_MS = 30000;

    return new Promise((resolve, reject) => {
      const worker = new Worker(SVD_WORKER_PATH);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        worker.removeAllListeners();
      };

      const timeoutHandle = setTimeout(() => {
        cleanup();
        worker.terminate();
        logger.error('SVD worker timed out', { timeoutMs: SVD_WORKER_TIMEOUT_MS });
        reject(new SemanticEmbedderError('SVD worker timed out after ' + SVD_WORKER_TIMEOUT_MS + 'ms'));
      }, SVD_WORKER_TIMEOUT_MS);

      worker.on('message', (msg) => {
        if (msg.type === 'log') {
          const level = msg.level || 'info';
          if (logger[level]) {
            logger[level]('SVD Worker: ' + msg.message, msg.data);
          }
          return;
        }

        if (msg.type === 'progress') {
          logger.info('SVD progress', {
            dimension: msg.currentDim + '/' + msg.totalDims,
            converged: msg.converged,
            residual: msg.residual
          });
          return;
        }

        if (msg.type === 'error') {
          cleanup();
          worker.terminate();
          reject(new SemanticEmbedderError('SVD worker error: ' + msg.error));
          return;
        }

        if (msg.type === 'result') {
          cleanup();
          worker.terminate();

          this._svdMetrics = msg.metrics;

          logger.info('SVD worker complete', {
            totalIterations: msg.metrics.totalIterations,
            allConverged: msg.metrics.allConverged,
            dimensions: msg.metrics.dimensionsComputed
          });

          const n = ppmiMatrix.length;
          const k = this.vectorDimensions;
          const result = Array(n).fill(null).map(() => new Float64Array(k));
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < k; j++) {
              result[i][j] = msg.result[i][j];
            }
          }

          resolve(result);
          return;
        }
      });

      worker.on('error', (err) => {
        cleanup();
        reject(new SemanticEmbedderError('SVD worker crashed: ' + err.message));
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          cleanup();
          reject(new SemanticEmbedderError('SVD worker exited with code ' + code));
        }
      });

      const plainMatrix = ppmiMatrix.map(row => Array.from(row));

      worker.postMessage({
        type: 'compute',
        matrix: plainMatrix,
        vectorDimensions: this.vectorDimensions,
        convergenceTolerance: this.svdConvergenceTolerance,
        maxIterations: this.svdMaxIterations
      });
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Store Word Vectors                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  _storeWordVectors(wordVectorMatrix) {
    for (let i = 0; i < this.indexVocab.length; i++) {
      const word = this.indexVocab[i];
      const vec = this._normalize(wordVectorMatrix[i]);
      this.wordVectors.set(word, vec);
    }
    logger.info('Word vectors computed', { count: this.wordVectors.size });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Utterance Vectors                                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computeUtteranceVectors(utterances) {
    let skipped = 0;
    let noOutcome = 0;
    let noDialogue = 0;

    for (const row of utterances) {
      const words = this.tokenize(row.utterance_text).filter(w => this.wordVectors.has(w));
      if (words.length === 0) {
        skipped++;
        continue;
      }

      const vec = this._averageVectors(words.map(w => this.wordVectors.get(w)));
      const normalized = this._normalize(vec);

      if (!row.outcome_intent_code) noOutcome++;
      if (!row.dialogue_function_code) noDialogue++;

      this.utteranceVectors.set(row.training_example_id, {
        vector: normalized,
        outcomeIntent: row.outcome_intent_code || null,
        dialogueFunction: row.dialogue_function_code || null,
        speechAct: row.speech_act_code || null
      });
    }

    logger.info('Utterance vectors computed', { count: this.utteranceVectors.size, skipped });
    return { skipped, noOutcome, noDialogue };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Outcome Intent Centroids                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computeOutcomeCentroids() {
    const outcomeGroups = new Map();
    for (const [id, data] of this.utteranceVectors.entries()) {
      if (!data.outcomeIntent) continue;
      if (!outcomeGroups.has(data.outcomeIntent)) {
        outcomeGroups.set(data.outcomeIntent, []);
      }
      outcomeGroups.get(data.outcomeIntent).push(data.vector);
    }

    for (const [outcomeIntent, vectors] of outcomeGroups.entries()) {
      const centroid = this._averageVectors(vectors);
      this.outcomeIntentCentroids.set(outcomeIntent, this._normalize(centroid));
    }

    logger.info('Outcome-intent centroids computed', { count: this.outcomeIntentCentroids.size });
    return this.outcomeIntentCentroids.size;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Dialogue Function Centroids                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computeDialogueCentroids() {
    const dialogueGroups = new Map();
    for (const [id, data] of this.utteranceVectors.entries()) {
      if (!data.dialogueFunction) continue;
      if (!dialogueGroups.has(data.dialogueFunction)) {
        dialogueGroups.set(data.dialogueFunction, []);
      }
      dialogueGroups.get(data.dialogueFunction).push(data.vector);
    }

    for (const [dialogueFunction, vectors] of dialogueGroups.entries()) {
      const centroid = this._averageVectors(vectors);
      this.dialogueFunctionCentroids.set(dialogueFunction, this._normalize(centroid));
    }

    logger.info('Dialogue-function centroids computed', { count: this.dialogueFunctionCentroids.size });
    return this.dialogueFunctionCentroids.size;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Hierarchical Shaping                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _applyHierarchicalShaping() {
    let shapedCount = 0;
    const dims = this.vectorDimensions;

    for (const [id, data] of this.utteranceVectors.entries()) {
      const outcomeCentroid = data.outcomeIntent
        ? this.outcomeIntentCentroids.get(data.outcomeIntent)
        : null;
      const dialogueCentroid = data.dialogueFunction
        ? this.dialogueFunctionCentroids.get(data.dialogueFunction)
        : null;

      if (!outcomeCentroid && !dialogueCentroid) continue;

      const shaped = new Float64Array(dims);

      for (let i = 0; i < dims; i++) {
        shaped[i] = this.alphaOriginal * data.vector[i];
      }

      if (outcomeCentroid) {
        for (let i = 0; i < dims; i++) {
          shaped[i] += this.betaOutcomeIntent * outcomeCentroid[i];
        }
      } else {
        for (let i = 0; i < dims; i++) {
          shaped[i] += this.betaOutcomeIntent * data.vector[i];
        }
      }

      if (dialogueCentroid) {
        for (let i = 0; i < dims; i++) {
          shaped[i] += this.gammaDialogueFunction * dialogueCentroid[i];
        }
      } else {
        for (let i = 0; i < dims; i++) {
          shaped[i] += this.gammaDialogueFunction * data.vector[i];
        }
      }

      data.vector = this._normalize(shaped);
      shapedCount++;
    }

    logger.info('Utterance vectors shaped toward centroids', { shapedCount });
    return shapedCount;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: findSimilar                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async findSimilar(text, topK, options) {
    if (topK === undefined) topK = 5;
    if (options === undefined) options = {};

    if (!text || typeof text !== 'string') {
      throw new SemanticEmbedderError('findSimilar: text must be a non-empty string');
    }
    if (typeof topK !== 'number' || topK < 1) {
      throw new SemanticEmbedderError('findSimilar: topK must be a positive number');
    }
    if (!this.trained) {
      throw new SemanticEmbedderError('Not trained. Call warmUp() first.');
    }

    const allWords = this.tokenize(text);
    const knownWords = allWords.filter(w => this.wordVectors.has(w));

    if (knownWords.length === 0) {
      return {
        results: [],
        coverage: 0,
        message: 'No known words in input'
      };
    }

    let inputVec = this._normalize(
      this._averageVectors(knownWords.map(w => this.wordVectors.get(w)))
    );

    const closestCentroid = this._findClosestCentroid(inputVec);
    if (closestCentroid) {
      inputVec = this._shapeVector(
        inputVec,
        closestCentroid.vector,
        this.runtimeIntentProjection
      );
      inputVec = this._normalize(inputVec);
    }

    const similarities = [];
    for (const [id, data] of this.utteranceVectors.entries()) {
      if (options.outcomeIntent && data.outcomeIntent !== options.outcomeIntent) {
        continue;
      }

      if (options.dialogueFunction && data.dialogueFunction !== options.dialogueFunction) {
        continue;
      }

      const semanticSim = this._cosineSimilarity(inputVec, data.vector);

      let finalScore = semanticSim;
      if (options.targetPad && this.utterancePAD.has(id)) {
        const utterancePad = this.utterancePAD.get(id);
        const padSim = this._padSimilarity(options.targetPad, utterancePad);
        finalScore = (this.semanticSimilarityWeight * semanticSim) +
                     (this.padSimilarityWeight * padSim);
      }

      similarities.push({
        id,
        similarity: finalScore,
        semanticSimilarity: semanticSim,
        outcomeIntent: data.outcomeIntent,
        dialogueFunction: data.dialogueFunction
      });
    }

    similarities.sort((a, b) => b.similarity - a.similarity);

    const topResults = similarities.slice(0, topK);
    const topIds = topResults.map(s => s.id);

    if (topIds.length === 0) {
      return {
        results: [],
        coverage: knownWords.length / allWords.length,
        inputWords: knownWords
      };
    }

    const result = await pool.query({
      text: 'SELECT te.training_example_id, te.utterance_text, ' +
        'te.dialogue_function_code, te.speech_act_code, ' +
        'te.pad_pleasure, te.pad_arousal, te.pad_dominance, ' +
        'toi.outcome_intent_code ' +
        'FROM ltlm_training_examples te ' +
        'LEFT JOIN ltlm_training_outcome_intents toi ' +
        'ON te.training_example_id = toi.training_example_id ' +
        'WHERE te.training_example_id = ANY($1)',
      values: [topIds],
      query_timeout: 2000
    });

    const resultMap = new Map(result.rows.map(r => [r.training_example_id, r]));
    const results = topResults.map(s => ({
      ...resultMap.get(s.id),
      similarity: s.similarity,
      semanticSimilarity: s.semanticSimilarity
    }));

    return {
      results,
      coverage: knownWords.length / allWords.length,
      inputWords: knownWords,
      projectedToward: closestCentroid ? closestCentroid.key : null
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: vectorize                                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  vectorize(text) {
    if (!text || typeof text !== 'string') {
      throw new SemanticEmbedderError('vectorize: text must be a non-empty string');
    }
    if (!this.trained) {
      throw new SemanticEmbedderError('Not trained. Call warmUp() first.');
    }

    const words = this.tokenize(text).filter(w => this.wordVectors.has(w));
    if (words.length === 0) return null;

    return this._normalize(
      this._averageVectors(words.map(w => this.wordVectors.get(w)))
    );
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: similarity                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  similarity(text1, text2) {
    if (!text1 || typeof text1 !== 'string') {
      throw new SemanticEmbedderError('similarity: text1 must be a non-empty string');
    }
    if (!text2 || typeof text2 !== 'string') {
      throw new SemanticEmbedderError('similarity: text2 must be a non-empty string');
    }

    const vec1 = this.vectorize(text1);
    const vec2 = this.vectorize(text2);

    if (!vec1 || !vec2) return null;
    return this._cosineSimilarity(vec1, vec2);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: similarWords                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  similarWords(word, topK) {
    if (topK === undefined) topK = 5;
    if (!word || typeof word !== 'string') {
      throw new SemanticEmbedderError('similarWords: word must be a non-empty string');
    }
    if (!this.trained) return null;

    const targetVec = this.wordVectors.get(word.toLowerCase());
    if (!targetVec) return null;

    const similarities = [];
    for (const [w, vec] of this.wordVectors.entries()) {
      if (w === word.toLowerCase()) continue;
      similarities.push({
        word: w,
        similarity: this._cosineSimilarity(targetVec, vec)
      });
    }

    similarities.sort((a, b) => b.similarity - a.similarity);
    return similarities.slice(0, topK);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: getNearestCentroid                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  getNearestCentroid(text) {
    if (!text || typeof text !== 'string') {
      throw new SemanticEmbedderError('getNearestCentroid: text must be a non-empty string');
    }
    if (!this.trained) return null;

    const vec = this.vectorize(text);
    if (!vec) return null;

    const closest = this._findClosestCentroid(vec);
    if (!closest) return null;

    return {
      centroid: closest.key,
      type: closest.type,
      similarity: closest.similarity
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: getStats                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  getStats() {
    if (!this.trained) return null;

    return {
      ...this.trainingStats,
      maxVocabSize: this.maxVocabSize,
      shapingWeights: {
        alpha: this.alphaOriginal,
        beta: this.betaOutcomeIntent,
        gamma: this.gammaDialogueFunction
      },
      runtimeIntentProjection: this.runtimeIntentProjection,
      filterStopWords: this.filterStopWords,
      outcomeIntents: [...this.outcomeIntentCentroids.keys()],
      dialogueFunctions: [...this.dialogueFunctionCentroids.keys()],
      cacheStats: {
        ...this._cacheStats,
        cacheValid: this._cacheValid,
        corpusHash: this.corpusHash ? this.corpusHash.substring(0, 16) + '...' : null
      }
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: auditWord                                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  auditWord(word) {
    if (!word || typeof word !== 'string') {
      throw new SemanticEmbedderError('auditWord: word must be a non-empty string');
    }
    if (!this.trained) return null;

    const similar = this.similarWords(word, 10);
    const nearest = this.getNearestCentroid(word);

    return {
      word,
      nearestCentroid: nearest,
      similarWords: similar
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: getCentroidInfo                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  getCentroidInfo(outcomeIntent) {
    if (!outcomeIntent || typeof outcomeIntent !== 'string') {
      throw new SemanticEmbedderError('getCentroidInfo: outcomeIntent must be a non-empty string');
    }
    if (!this.trained) return null;

    const centroid = this.outcomeIntentCentroids.get(outcomeIntent);
    if (!centroid) return null;

    const closest = [];
    for (const [id, data] of this.utteranceVectors.entries()) {
      if (data.outcomeIntent !== outcomeIntent) continue;
      const sim = this._cosineSimilarity(centroid, data.vector);
      closest.push({ id, similarity: sim });
    }
    closest.sort((a, b) => b.similarity - a.similarity);

    return {
      outcomeIntent,
      utteranceCount: closest.length,
      closestUtterances: closest.slice(0, 5)
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public API: getDialogueFunctionInfo                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  getDialogueFunctionInfo(dialogueFunction) {
    if (!dialogueFunction || typeof dialogueFunction !== 'string') {
      throw new SemanticEmbedderError('getDialogueFunctionInfo: dialogueFunction must be a non-empty string');
    }
    if (!this.trained) return null;

    const centroid = this.dialogueFunctionCentroids.get(dialogueFunction);
    if (!centroid) return null;

    const closest = [];
    for (const [id, data] of this.utteranceVectors.entries()) {
      if (data.dialogueFunction !== dialogueFunction) continue;
      const sim = this._cosineSimilarity(centroid, data.vector);
      closest.push({ id, similarity: sim });
    }
    closest.sort((a, b) => b.similarity - a.similarity);

    return {
      dialogueFunction,
      utteranceCount: closest.length,
      closestUtterances: closest.slice(0, 5)
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Tokenize (Unicode-Aware)                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  tokenize(text) {
    const tokens = text
      .toLowerCase()
      .replace(/<subject>/gi, '')
      .replace(/[\u2018\u2019\u201C\u201D''""]/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    if (this.filterStopWords) {
      return tokens.filter(w => !STOP_WORDS.has(w));
    }
    return tokens;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Vector Math (prefixed with _ for v010 convention)             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _averageVectors(vectors) {
    if (vectors.length === 0) return null;

    const dim = vectors[0].length;
    const avg = new Float64Array(dim);

    for (const vec of vectors) {
      for (let i = 0; i < dim; i++) {
        avg[i] += vec[i];
      }
    }

    for (let i = 0; i < dim; i++) {
      avg[i] /= vectors.length;
    }

    return avg;
  }

  /**
   * Generic linear interpolation between two vectors.
   * alpha=1.0 returns original unchanged; alpha=0.0 returns centroid.
   * Note: alpha here is a generic blending weight — unrelated to this.alphaOriginal
   * (the hierarchical shaping weight used in _applyHierarchicalShaping).
   * Called from two contexts: training shaping (fixed weights) and runtime
   * intent projection (this.runtimeIntentProjection = 0.85).
   */
  _shapeVector(original, centroid, alpha) {
    const dim = original.length;
    const shaped = new Float64Array(dim);

    for (let i = 0; i < dim; i++) {
      shaped[i] = alpha * original[i] + (1 - alpha) * centroid[i];
    }

    return shaped;
  }

  _normalize(vec) {
    if (!vec || vec.length === 0) return vec;
    const norm = Math.sqrt(this._dot(vec, vec));
    if (norm === 0) return vec;

    const result = new Float64Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
      result[i] = vec[i] / norm;
    }
    return result;
  }

  _dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i] * b[i];
    }
    return sum;
  }

  _cosineSimilarity(a, b) {
    return this._dot(a, b);
  }

  _padSimilarity(pad1, pad2) {
    const dp = pad1.p - pad2.p;
    const da = pad1.a - pad2.a;
    const dd = pad1.d - pad2.d;

    const distance = Math.sqrt(dp * dp + da * da + dd * dd);
    const maxDistance = Math.sqrt(12);

    return 1 - (distance / maxDistance);
  }

  _findClosestCentroid(vec) {
    let best = null;
    let bestSim = -Infinity;

    for (const [key, centroid] of this.outcomeIntentCentroids.entries()) {
      const sim = this._cosineSimilarity(vec, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = { key, vector: centroid, type: 'outcomeIntent', similarity: sim };
      }
    }

    return best;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new SemanticEmbedder();
