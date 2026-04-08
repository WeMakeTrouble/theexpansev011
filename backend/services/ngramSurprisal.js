/**
 * ============================================================================
 * ngramSurprisal.js — N-gram Surprisal Detection Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Measures how "surprising" user input is relative to the trained LTLM
 * corpus. High surprisal indicates unfamiliar language patterns — slang,
 * cultural references, novel phrases — which signals a learning
 * opportunity for Claude the Tanuki.
 *
 * This is a supporting module for Goal 2: "Claude can detect unfamiliar
 * language." It is called internally by learningDetector, not directly
 * by EarWig.
 *
 * HOW IT WORKS
 * ------------
 * 1. TRAINING (async, called once at boot via warmUp):
 *    - Loads utterance_text from ltlm_training_examples in batches
 *    - Adds sentence boundary tokens (<s>, </s>) to each utterance
 *    - Builds unigram, bigram, and trigram frequency maps
 *    - Builds context counts for per-history Laplace smoothing
 *    - Prunes rare n-grams (below minCount threshold) to save memory
 *    - Pre-computes smoothing denominators for hot-path performance
 *    - Caches trained model to disk with SHA-256 corpus hash
 *    - On subsequent boots, loads from cache if hash matches
 *
 * 2. SURPRISAL (sync, called per user input):
 *    - Tokenizes input text with sentence boundary tokens
 *    - Computes surprisal using Stupid Backoff with Laplace smoothing:
 *      a) Try trigram P(w3|w1,w2) — if count > 0, use it
 *      b) Else backoff to bigram P(w2|w1) scaled by 0.4
 *      c) Else backoff to unigram P(w) scaled by 0.4^2
 *    - Returns average surprisal score and list of novel n-grams
 *
 * SMOOTHING & BACKOFF
 * -------------------
 * Per-history Laplace smoothing:
 *   P(w|context) = (count(context+w) + alpha) / (count(context) + alpha*V)
 *
 * This conditions on the actual context history rather than using
 * global totals, giving more accurate probability estimates especially
 * for rare contexts.
 *
 * Stupid Backoff (Brants et al., 2007):
 *   Score(w|w1,w2) = count(w1,w2,w) > 0 ? P_laplace(w|w1,w2)
 *                  : 0.4 * Score(w|w1)
 *   Score(w|w1)    = count(w1,w) > 0 ? P_laplace(w|w1)
 *                  : 0.4 * P_laplace(w)
 *
 * Simple, fast, no external dependencies, effective with 5000+ examples.
 *
 * SENTENCE BOUNDARIES
 * -------------------
 * Each utterance is wrapped with <s> (start) and </s> (end) tokens
 * during both training and estimation. This gives proper probability
 * to utterance-initial and utterance-final patterns instead of
 * artificially inflating surprisal at edges.
 *
 * RETURN STRUCTURE (from surprisal())
 * ------------------------------------
 * {
 *   score: float,              // average surprisal in bits
 *   coverage: float,           // 0-1, proportion of known n-grams
 *   novelNgrams: string[],     // n-grams not seen in training
 *   totalNgramsEvaluated: int  // total positions checked
 * }
 *
 * CRITICAL NOTE: Returns novelNgrams (single array). learningDetector.js
 * must read this field name exactly. See EarWig brief Bug 1.
 *
 * CACHING
 * -------
 * Trained model is serialised to disk at cache/models/:
 *   - ngram-surprisal-v4.json  (model data)
 *   - ngram-surprisal-v4.hash  (SHA-256 corpus fingerprint)
 *
 * Cache version bumped to v4 due to structural changes (context counts,
 * sentence boundaries, backoff). Old v3 caches will be retrained.
 *
 * INTEGRATION
 * -----------
 * Called by learningDetector.detectLearningOpportunity():
 *   const surprisalResult = ngramSurprisal.surprisal(message);
 *   // Uses: surprisalResult.score, surprisalResult.novelNgrams
 *
 * NOT called directly by EarWig — learningDetector is the consumer.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: NgramSurprisal (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
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
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('NgramSurprisal');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const DEFAULT_N = 3;
const DEFAULT_LAPLACE_ALPHA = 0.01;
const DEFAULT_MIN_COUNT = 2;
const TRAINING_BATCH_SIZE = 1500;
const CACHE_VERSION = 'v4';
const CACHE_FILENAME = `ngram-surprisal-${CACHE_VERSION}.json`;
const HASH_FILENAME = `ngram-surprisal-${CACHE_VERSION}.hash`;

const START_TOKEN = '<s>';
const END_TOKEN = '</s>';
const BACKOFF_WEIGHT = 0.4;

/* ────────────────────────────────────────────────────────────────────────── */
/*  NgramSurprisal Class                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

class NgramSurprisal {
  constructor(options = {}) {
    this.n = options.n ?? DEFAULT_N;
    this.laplaceAlpha = options.laplaceAlpha ?? DEFAULT_LAPLACE_ALPHA;
    this.minCount = options.minCount ?? DEFAULT_MIN_COUNT;

    this.unigramCounts = new Map();
    this.bigramCounts = new Map();
    this.trigramCounts = new Map();

    this.bigramContextCounts = new Map();
    this.trigramContextCounts = new Map();

    this.totalUnigrams = 0;
    this.totalBigrams = 0;
    this.totalTrigrams = 0;
    this.vocabulary = new Set();

    this._alphaTimesV = 0;

    this.trained = false;
    this.cacheDir = path.join(__dirname, '../../cache/models');
    this.corpusHash = null;
    this.trainingStats = null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Tokenizer                                                      */
  /*                                                                          */
  /*  Simple whitespace tokenizer with punctuation stripping.                 */
  /*  Wraps tokens with sentence boundary markers for proper edge             */
  /*  probability estimation.                                                 */
  /*                                                                          */
  /*  Deliberately simpler than padEstimator's tokenizer because              */
  /*  surprisal needs raw token patterns, not emotional stems.                */
  /* ──────────────────────────────────────────────────────────────────────── */

  _tokenize(text) {
    if (typeof text !== 'string' || !text) return [];

    const raw = text
      .toLowerCase()
      .replace(/[\u2018\u2019\u201C\u201D]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (raw.length === 0) return [];

    return [START_TOKEN, ...raw, END_TOKEN];
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Corpus Hash                                                    */
  /*                                                                          */
  /*  Computes a SHA-256 fingerprint of the training corpus to detect         */
  /*  when the database has changed and the cache should be invalidated.      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _computeCorpusHash() {
    try {
      let _hashTimer;
      const _hashQueryPromise = pool.query(`
              SELECT
                COUNT(*) as count,
                MIN(training_example_id) as min_id,
                MAX(training_example_id) as max_id,
                STRING_AGG(MD5(utterance_text), ',' ORDER BY training_example_id) as sample_hashes
              FROM ltlm_training_examples
              WHERE utterance_text IS NOT NULL
      `);
      const result = await Promise.race([
        _hashQueryPromise.then(r => { clearTimeout(_hashTimer); return r; }),
        new Promise((_, reject) => {
          _hashTimer = setTimeout(() => reject(new Error("Corpus hash query timeout")), 15000);
        })
      ]);
      const { count, min_id, max_id, sample_hashes } = result.rows[0];
      if (parseInt(count) === 0) return null;

      const data = `${count}:${min_id ?? ''}:${max_id ?? ''}:${sample_hashes ?? ''}`;
      return crypto.createHash('sha256').update(data).digest('hex');
    } catch (err) {
      logger.error('Corpus hash computation failed', { error: err.message });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Load From Cache                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _loadFromCache() {
    try {
      const cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
      const hashFile = path.join(this.cacheDir, HASH_FILENAME);

      await fs.access(cacheFile);
      await fs.access(hashFile);

      const storedHash = (await fs.readFile(hashFile, 'utf8')).trim();
      const currentHash = await this._computeCorpusHash();

      if (!currentHash || storedHash !== currentHash) {
        logger.info('Cache hash mismatch, will retrain');
        return false;
      }

      const data = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (data.version !== CACHE_VERSION) {
        logger.info('Cache version mismatch, will retrain', {
          cached: data.version,
          expected: CACHE_VERSION
        });
        return false;
      }

      this.unigramCounts = new Map(data.unigramCounts);
      this.bigramCounts = new Map(data.bigramCounts);
      this.trigramCounts = new Map(data.trigramCounts);
      this.bigramContextCounts = new Map(data.bigramContextCounts);
      this.trigramContextCounts = new Map(data.trigramContextCounts);
      this.totalUnigrams = data.totalUnigrams;
      this.totalBigrams = data.totalBigrams;
      this.totalTrigrams = data.totalTrigrams;
      this.vocabulary = new Set(data.vocabulary);
      this.trainingStats = data.trainingStats;
      this.trained = true;
      this.corpusHash = currentHash;

      this._alphaTimesV = this.laplaceAlpha * this.vocabulary.size;

      logger.info('Loaded from cache', {
        vocabSize: this.vocabulary.size,
        trigramCount: this.trigramCounts.size
      });
      return true;
    } catch (err) {
      logger.warn('Cache load failed, will retrain', { error: err.message });
      return false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Save To Cache                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _saveToCache() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cacheFile = path.join(this.cacheDir, CACHE_FILENAME);
      const hashFile = path.join(this.cacheDir, HASH_FILENAME);

      const cacheData = {
        version: CACHE_VERSION,
        timestamp: new Date().toISOString(),
        corpusHash: this.corpusHash,
        unigramCounts: [...this.unigramCounts.entries()],
        bigramCounts: [...this.bigramCounts.entries()],
        trigramCounts: [...this.trigramCounts.entries()],
        bigramContextCounts: [...this.bigramContextCounts.entries()],
        trigramContextCounts: [...this.trigramContextCounts.entries()],
        totalUnigrams: this.totalUnigrams,
        totalBigrams: this.totalBigrams,
        totalTrigrams: this.totalTrigrams,
        vocabulary: [...this.vocabulary],
        trainingStats: this.trainingStats
      };

      const tmpCache = cacheFile + ".tmp";
      await fs.writeFile(tmpCache, JSON.stringify(cacheData));
      await fs.rename(tmpCache, cacheFile);
      const tmpHash = hashFile + ".tmp";
      await fs.writeFile(tmpHash, this.corpusHash);
      await fs.rename(tmpHash, hashFile);

      logger.info('Model cached to disk', {
        file: CACHE_FILENAME,
        vocabSize: this.vocabulary.size
      });
    } catch (err) {
      logger.warn('Cache save failed (non-fatal)', { error: err.message });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Warm Up                                                         */
  /*                                                                          */
  /*  Boot-time entry point. Attempts cache load first, falls back to         */
  /*  fresh training. After training, saves to cache for next boot.           */
  /* ──────────────────────────────────────────────────────────────────────── */

  async warmUp() {
    const start = Date.now();
    logger.info('Starting warm-up');

    if (await this._loadFromCache()) {
      logger.info('Warm-up complete (from cache)', { elapsed: Date.now() - start });
      return this.trainingStats;
    }

    logger.info('Training fresh model');
    await this.train();
    this.corpusHash = await this._computeCorpusHash();
    if (this.corpusHash) await this._saveToCache();

    logger.info('Warm-up complete (fresh training)', { elapsed: Date.now() - start });
    return this.trainingStats;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Ready Check                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  isReady() {
    return this.trained;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Train                                                           */
  /*                                                                          */
  /*  Loads utterances from ltlm_training_examples in batches, wraps          */
  /*  with sentence boundaries, builds frequency maps with context            */
  /*  counts for per-history Laplace smoothing, and prunes rare n-grams.     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async train() {
    const startTime = Date.now();
    let offset = 0;
    let totalUtterances = 0;

    this.unigramCounts.clear();
    this.bigramCounts.clear();
    this.trigramCounts.clear();
    this.bigramContextCounts.clear();
    this.trigramContextCounts.clear();
    this.totalUnigrams = 0;
    this.totalBigrams = 0;
    this.totalTrigrams = 0;
    this.vocabulary.clear();

    logger.info('Training started (batched)', { batchSize: TRAINING_BATCH_SIZE });

    while (true) {
      let _batchTimer;
      const _batchPromise = pool.query(
        `SELECT utterance_text
         FROM ltlm_training_examples
         WHERE utterance_text IS NOT NULL
         ORDER BY training_example_id
         LIMIT $1 OFFSET $2`,
        [TRAINING_BATCH_SIZE, offset]
      );
      const { rows } = await Promise.race([
        _batchPromise.then(r => { clearTimeout(_batchTimer); return r; }),
        new Promise((_, reject) => {
          _batchTimer = setTimeout(() => reject(new Error('Training batch query timeout')), 30000);
        })
      ]);
      
            if (rows.length === 0) break;
      
            for (const { utterance_text } of rows) {
              const tokens = this._tokenize(utterance_text);
              if (tokens.length <= 2) continue;
              totalUtterances++;
      
              /* ── Unigrams ──────────────────────────────────────────────────── */
      
              for (const token of tokens) {
                this.unigramCounts.set(token, (this.unigramCounts.get(token) || 0) + 1);
                this.totalUnigrams++;
                this.vocabulary.add(token);
              }
      
              /* ── Bigrams + context counts ──────────────────────────────────── */
      
              for (let i = 0; i < tokens.length - 1; i++) {
                const context = tokens[i];
                const bigram = context + ' ' + tokens[i + 1];
      
                this.bigramCounts.set(bigram, (this.bigramCounts.get(bigram) || 0) + 1);
                this.bigramContextCounts.set(context, (this.bigramContextCounts.get(context) || 0) + 1);
                this.totalBigrams++;
              }
      
              /* ── Trigrams + context counts ─────────────────────────────────── */
      
              if (this.n >= 3) {
                for (let i = 0; i < tokens.length - 2; i++) {
                  const context = tokens[i] + ' ' + tokens[i + 1];
                  const trigram = context + ' ' + tokens[i + 2];
      
                  this.trigramCounts.set(trigram, (this.trigramCounts.get(trigram) || 0) + 1);
                  this.trigramContextCounts.set(context, (this.trigramContextCounts.get(context) || 0) + 1);
                  this.totalTrigrams++;
                }
              }
            }
      
            offset += TRAINING_BATCH_SIZE;
          }
      
          /* ── Prune rare n-grams ────────────────────────────────────────────── */
      
          let prunedTrigrams = 0;
          let prunedBigrams = 0;
      
          for (const [ngram, count] of this.trigramCounts) {
            if (count < this.minCount) {
              this.trigramCounts.delete(ngram);
              prunedTrigrams++;
            }
          }
      
          for (const [ngram, count] of this.bigramCounts) {
            if (count < this.minCount) {
              this.bigramCounts.delete(ngram);
              prunedBigrams++;
            }
          }
      
          /* ── Recompute context counts from surviving n-grams ──────────────── */
      
          this.trigramContextCounts.clear();
          for (const [trigram, count] of this.trigramCounts) {
            const parts = trigram.split(' ');
            const context = parts[0] + ' ' + parts[1];
            this.trigramContextCounts.set(context, (this.trigramContextCounts.get(context) || 0) + count);
          }
      
          this.bigramContextCounts.clear();
          for (const [bigram, count] of this.bigramCounts) {
            const context = bigram.split(' ')[0];
            this.bigramContextCounts.set(context, (this.bigramContextCounts.get(context) || 0) + count);
          }
      
          /* ── Pre-compute smoothing constant ────────────────────────────────── */
      
          this._alphaTimesV = this.laplaceAlpha * this.vocabulary.size;
          this.trained = true;
      
          const elapsed = Date.now() - startTime;
          this.trainingStats = {
            unigramCount: this.unigramCounts.size,
            bigramCount: this.bigramCounts.size,
            trigramCount: this.trigramCounts.size,
            bigramContextCount: this.bigramContextCounts.size,
            trigramContextCount: this.trigramContextCounts.size,
            vocabularySize: this.vocabulary.size,
            totalUnigrams: this.totalUnigrams,
            totalBigrams: this.totalBigrams,
            totalTrigrams: this.totalTrigrams,
            trainingExamples: totalUtterances,
            trainingTimeMs: elapsed,
            prunedTrigrams,
            prunedBigrams,
            minCountThreshold: this.minCount,
            laplaceAlpha: this.laplaceAlpha
          };
      
          logger.success('Training complete', this.trainingStats);
          return this.trainingStats;
        }
      
        /* ──────────────────────────────────────────────────────────────────────── */
        /*  Private: Per-History Laplace Probability                                */
        /*                                                                          */
        /*  P(w|context) = (count(context+w) + alpha) / (count(context) + alpha*V) */
        /*                                                                          */
        /*  Conditions on the actual context history rather than using global        */
        /*  totals, giving more accurate probability estimates especially for       */
        /*  rare contexts.                                                          */
        /* ──────────────────────────────────────────────────────────────────────── */
      
        _laplaceProb(ngramCount, contextCount) {
          return (ngramCount + this.laplaceAlpha) / (contextCount + this._alphaTimesV);
        }
      
        /* ──────────────────────────────────────────────────────────────────────── */
        /*  Private: Stupid Backoff Score                                           */
        /*                                                                          */
        /*  Brants et al. 2007. Uses trigram if available, backs off to bigram      */
        /*  scaled by 0.4, then to unigram scaled by 0.4^2. Simple, fast,          */
        /*  effective with moderate-sized corpora.                                  */
        /*                                                                          */
        /*  Returns probability estimate (not surprisal — caller converts).         */
        /* ──────────────────────────────────────────────────────────────────────── */
      
        _backoffScore(w1, w2, w3) {
          if (this.n >= 3) {
            const trigramKey = w1 + ' ' + w2 + ' ' + w3;
            const trigramCount = this.trigramCounts.get(trigramKey) || 0;
      
            if (trigramCount > 0) {
              const triContext = w1 + ' ' + w2;
              const triContextCount = this.trigramContextCounts.get(triContext) || 0;
              return this._laplaceProb(trigramCount, triContextCount);
            }
          }
      
          const bigramKey = w2 + ' ' + w3;
          const bigramCount = this.bigramCounts.get(bigramKey) || 0;
      
          if (bigramCount > 0) {
            const biContextCount = this.bigramContextCounts.get(w2) || 0;
            return BACKOFF_WEIGHT * this._laplaceProb(bigramCount, biContextCount);
          }
      
          const unigramCount = this.unigramCounts.get(w3) || 0;
          return BACKOFF_WEIGHT * BACKOFF_WEIGHT * this._laplaceProb(unigramCount, this.totalUnigrams);
        }
      
        /* ──────────────────────────────────────────────────────────────────────── */
        /*  Public: Surprisal                                                       */
        /*                                                                          */
        /*  Synchronous. Computes average surprisal (in bits) for input text        */
        /*  using Stupid Backoff with per-history Laplace smoothing.                */
        /*                                                                          */
        /*  High score = unfamiliar patterns. Low score = common patterns.          */
        /*                                                                          */
        /*  @param {string} text — User input text                                  */
        /*  @returns {object} Surprisal result with score, coverage, novelNgrams   */
        /* ──────────────────────────────────────────────────────────────────────── */
      
        surprisal(text) {
          if (!this.trained) {
            throw new Error('NgramSurprisal: call warmUp() or train() before surprisal()');
          }
      
          const tokens = this._tokenize(text);
          if (tokens.length <= 2) {
            return {
              score: 0,
              coverage: 1.0,
              novelNgrams: [],
              totalNgramsEvaluated: 0
            };
          }
      
          let totalSurprisal = 0;
          let totalPositions = 0;
          const novel = [];
      
          /* ── Walk through token positions ──────────────────────────────────── */
          /*                                                                      */
          /*  Start at index 2 so we always have w1 (i-2) and w2 (i-1) as        */
          /*  context. The sentence boundary <s> at index 0 serves as the         */
          /*  initial context anchor.                                             */
      
          for (let i = 2; i < tokens.length; i++) {
            const w1 = tokens[i - 2];
            const w2 = tokens[i - 1];
            const w3 = tokens[i];
      
            const prob = this._backoffScore(w1, w2, w3);
            const bits = -Math.log2(prob);
      
            totalSurprisal += bits;
            totalPositions++;
      
            const trigramKey = w1 + ' ' + w2 + ' ' + w3;
            const trigramCount = this.trigramCounts.get(trigramKey) || 0;
            const bigramKey = w2 + ' ' + w3;
            const bigramCount = this.bigramCounts.get(bigramKey) || 0;
      
            // NOTE: Novel only when both trigram AND bigram are unseen. A novel trigram with
      // a known bigram is less surprising and intentionally not flagged here.
      if (trigramCount === 0 && bigramCount === 0) {
              novel.push(trigramKey);
            }
          }
      
          const avgSurprisal = totalPositions > 0 ? totalSurprisal / totalPositions : 0;
          const coverage = totalPositions > 0 ? 1 - (novel.length / totalPositions) : 1;
      
          return {
            score: Math.round(avgSurprisal * 1000) / 1000,
            coverage: Math.round(coverage * 1000) / 1000,
            novelNgrams: novel,
            totalNgramsEvaluated: totalPositions
          };
        }
      
        /* ──────────────────────────────────────────────────────────────────────── */
        /*  Public: Stats                                                           */
        /* ──────────────────────────────────────────────────────────────────────── */
      
        getStats() {
          if (!this.trainingStats) return null;
          return { ...this.trainingStats };
        }
      }
      
      /* ────────────────────────────────────────────────────────────────────────── */
      /*  Singleton Export                                                          */
      /* ────────────────────────────────────────────────────────────────────────── */
      
      export default new NgramSurprisal({
        n: DEFAULT_N,
        laplaceAlpha: DEFAULT_LAPLACE_ALPHA,
        minCount: DEFAULT_MIN_COUNT
      });
