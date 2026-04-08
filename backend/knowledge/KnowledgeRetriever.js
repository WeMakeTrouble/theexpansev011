/**
 * ============================================================================
 * KnowledgeRetriever.js — BM25 Knowledge Retrieval Engine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Retrieves relevant knowledge entries from the knowledge_items table
 * using BM25 scoring — the industry-standard upgrade over raw TF-IDF.
 * All tokenization, stemming, and scoring is built in-house. No
 * external NLP libraries.
 *
 * HOW BM25 DIFFERS FROM RAW TF-IDF
 * ----------------------------------
 * Raw TF-IDF: score = sum(TF * IDF)
 *   Problem: longer documents accumulate higher scores simply by
 *   having more terms, not by being more relevant.
 *
 * BM25: score = sum(IDF * (TF * (k1 + 1)) / (TF + k1 * (1 - b + b * dl/avgdl)))
 *   k1 = term frequency saturation (1.2 default, diminishing returns)
 *   b  = document length normalization (0.75 default)
 *   dl = document length (term count)
 *   avgdl = average document length across corpus
 *
 * This means a term appearing 10 times in a short document scores
 * higher than the same term appearing 10 times in a long document.
 *
 * QUERY TF WEIGHTING
 * ------------------
 * If a user types a word twice in their query, it scores double.
 * Standard practice: multiply BM25 doc score by query term frequency.
 *
 * RETRIEVAL CACHE
 * ---------------
 * LRU cache on (normalised query → topK results) with 5-minute TTL.
 * Prevents redundant DB hits for repeated queries (concierge, helpdesk).
 * Cache is invalidated on any indexing operation.
 *
 * STEMMER LIMITATIONS
 * -------------------
 * The in-house Porter-subset stemmer collapses some distinct words:
 *   stem('university') → 'univers'
 *   stem('universe')   → 'univers'
 * This is a known limitation of suffix-stripping stemmers. Acceptable
 * for The Expanse's retrieval precision requirements. For v011,
 * consider adding n-gram overlap scoring or part-of-speech filtering.
 *
 * The PROTECTED_TERMS set prevents stemming of Expanse-specific terms
 * that would be destroyed by suffix removal (e.g. 'mutai', 'tanuki').
 *
 * DATA FLOW
 * ---------
 * User query → tokenize → BM25 score against index → return ranked results
 * Knowledge items → tokenize → index into knowledge_retrieval_index
 *
 * CONSUMERS
 * ---------
 * - ClaudeBrain.js: instantiates and passes as KnowledgeLayer
 * - PhaseIntent: uses for knowledge retrieval on matched intents
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js, Counters
 * External: None
 *
 * SCHEMA
 * ------
 * Tables: knowledge_items, knowledge_retrieval_index
 * Columns: knowledge_id, content, concept, answer_statement, entry_type,
 *          term, term_frequency, inverse_document_frequency, doc_length
 *
 * NOTE: Ensure doc_length column exists on knowledge_retrieval_index.
 * If not, add: ALTER TABLE knowledge_retrieval_index ADD COLUMN doc_length INT;
 *
 * SECURITY
 * --------
 * BM25 constants (K1, B) are frozen module-level constants, not user
 * input. avgDl is calculated from the database or cached as a float.
 * These values are interpolated into SQL for readability but are never
 * derived from user input. All user-derived values (tokens, topK) are
 * fully parameterised.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('KnowledgeRetriever');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const BM25 = Object.freeze({
  K1: 1.2,
  B: 0.75
});

const RETRIEVAL = Object.freeze({
  DEFAULT_TOP_K: 5,
  MIN_TOP_K: 1,
  MAX_TOP_K: 100,
  BATCH_SIZE: 10,
  MAX_TERM_LENGTH: 100,
  MIN_TOKEN_LENGTH: 3,
  CACHE_MAX_SIZE: 200,
  CACHE_TTL_MS: 5 * 60 * 1000,
  QUERY_TIMEOUT_MS: 8000,
  DEFAULT_AVG_DOC_LENGTH: 50
});

const STOPWORDS = Object.freeze(new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'dare', 'ought', 'used', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'what', 'which', 'who', 'whom',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here',
  'there', 'then', 'once', 'if', 'unless', 'until', 'while', 'about',
  'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'further', 'any', 'because', 'being', 'her', 'him', 'his', 'me', 'my',
  'our', 'them', 'their', 'your', 'get', 'got', 'go', 'goes', 'going',
  'itself', 'herself', 'ourselves', 'yourselves'
]));

const PROTECTED_TERMS = Object.freeze(new Set([
  'mutai', 'tanuki', 'yurei', 'piza', 'sukeruton', 'pineaple',
  'expanse', 'omiyage', 'dossier', 'fsrs', 'cotw', 'ltlm',
  'slicifer', 'frankie'
]));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _guardHexId(value, name, correlationId) {
  if (!value || typeof value !== 'string' || !isValidHexId(value)) {
    logger.warn('Invalid hex ID', { field: name, value, correlationId });
    return false;
  }
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  KnowledgeRetriever Class                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

class KnowledgeRetriever {

  constructor() {
    this._cache = new Map();
    this._cacheMeta = new Map();
    this._cacheOrder = [];
    this._avgDocLength = null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Pool Connection With Timeout                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _getClient(correlationId) {
    let timer;
    const clientPromise = pool.connect();
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Pool connection timeout')), RETRIEVAL.QUERY_TIMEOUT_MS);
    });
    try {
      const client = await Promise.race([clientPromise, timeoutPromise]);
      clearTimeout(timer);
      return client;
    } catch (err) {
      clearTimeout(timer);
      logger.error('Pool connection failed', { error: err.message, correlationId });
      throw err;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Retrieve Knowledge (BM25)                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Retrieve relevant knowledge entries for a query using BM25 scoring.
   *
   * @param {string} query - User query text
   * @param {number} [topK=5] - Number of results to return
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<Array<{knowledgeId, score, content, concept, answerStatement, entryType}>>}
   */
  async retrieve(query, topK = RETRIEVAL.DEFAULT_TOP_K, correlationId) {
    const start = Date.now();

    if (!query || typeof query !== 'string' || query.trim() === '') {
      logger.debug('Empty query, returning no results', { correlationId });
      return [];
    }

    if (topK < RETRIEVAL.MIN_TOP_K || topK > RETRIEVAL.MAX_TOP_K) {
      logger.warn('topK out of range, clamping', { topK, correlationId });
      topK = Math.max(RETRIEVAL.MIN_TOP_K, Math.min(RETRIEVAL.MAX_TOP_K, topK));
    }

    const tokens = this.tokenize(query);
    if (tokens.length === 0) {
      logger.debug('No tokens after filtering, returning no results', { correlationId });
      return [];
    }

    const cacheKey = JSON.stringify({ tokens, topK });
    const cached = this._cacheGet(cacheKey, correlationId);
    if (cached) {
      Counters.increment('knowledge_retrieve', 'cache_hit');
      return cached;
    }

    const queryTf = this._calculateTermFrequency(tokens);

    const client = await this._getClient(correlationId);
    try {
      const results = await this._executeRetrieval(client, tokens, queryTf, topK, correlationId);

      const elapsed = Date.now() - start;

      if (results.length === 0) {
        Counters.increment('knowledge_retrieve', 'zero_results');
        logger.debug('No results for query', { tokenCount: tokens.length, elapsedMs: elapsed, correlationId });
        return [];
      }

      Counters.increment('knowledge_retrieve', 'success');
      logger.debug('Retrieval complete', {
        tokenCount: tokens.length,
        resultCount: results.length,
        topScore: results[0]?.score,
        elapsedMs: elapsed,
        correlationId
      });

      this._cachePut(cacheKey, results, correlationId);

      return results;

    } catch (err) {
      Counters.increment('knowledge_retrieve', 'failure');
      logger.error('Retrieval failed', { error: err.message, correlationId });
      return [];
    } finally {
      if (client) client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Index Single Knowledge Item                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Index a single knowledge item into knowledge_retrieval_index.
   *
   * @param {string} knowledgeId - Knowledge item hex ID
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<{indexed: boolean, termCount: number, error?: string}>}
   */
  async indexKnowledgeItem(knowledgeId, correlationId) {
    if (!_guardHexId(knowledgeId, 'knowledgeId', correlationId)) {
      Counters.increment('knowledge_index', 'invalid_id');
      return { indexed: false, termCount: 0, error: 'Invalid knowledge hex ID' };
    }

    const client = await this._getClient(correlationId);
    try {
      await client.query('BEGIN');

      const itemResult = await client.query(
        'SELECT knowledge_id, content, concept, answer_statement ' +
        'FROM knowledge_items ' +
        'WHERE knowledge_id = $1',
        [knowledgeId]
      );

      if (itemResult.rows.length === 0) {
        await client.query('COMMIT');
        logger.debug('Knowledge item not found for indexing', { knowledgeId, correlationId });
        return { indexed: false, termCount: 0, error: 'Knowledge item not found' };
      }

      const item = itemResult.rows[0];
      const fullText = [
        item.content || '',
        item.concept || '',
        item.answer_statement || ''
      ].join(' ');

      const tokens = this.tokenize(fullText);
      const termFrequency = this._calculateTermFrequency(tokens);
      const docLength = tokens.length;

      await client.query(
        'DELETE FROM knowledge_retrieval_index WHERE knowledge_id = $1',
        [knowledgeId]
      );

      const terms = [];
      const knowledgeIds = [];
      const frequencies = [];
      const docLengths = [];

      for (const [term, freq] of termFrequency) {
        if (term.length > RETRIEVAL.MAX_TERM_LENGTH) {
          logger.warn('Term truncated during indexing', {
            originalLength: term.length,
            knowledgeId,
            correlationId
          });
        }
        terms.push(term.substring(0, RETRIEVAL.MAX_TERM_LENGTH));
        knowledgeIds.push(knowledgeId);
        frequencies.push(freq);
        docLengths.push(docLength);
      }

      if (terms.length > 0) {
        await client.query(
          'INSERT INTO knowledge_retrieval_index (term, knowledge_id, term_frequency, doc_length) ' +
          'SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[], $4::int[])',
          [terms, knowledgeIds, frequencies, docLengths]
        );
      }

      await client.query('COMMIT');

      this._invalidateCache(correlationId);
      this._avgDocLength = null;

      Counters.increment('knowledge_index', 'success');
      logger.debug('Knowledge item indexed', { knowledgeId, termCount: termFrequency.size, correlationId });

      return { indexed: true, termCount: termFrequency.size };

    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      Counters.increment('knowledge_index', 'failure');
      logger.error('Indexing failed', {
        knowledgeId,
        correlationId,
        error: error.message
      });
      return { indexed: false, termCount: 0, error: error.message };
    } finally {
      if (client) client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Build Full Index                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Rebuild index for all knowledge items. Batched with parallelism.
   *
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<{totalItems: number, totalTerms: number, errors: string[]}>}
   */
  async buildIndex(correlationId) {
    const start = Date.now();
    const errors = [];
    let client = await this._getClient(correlationId);

    try {
      const itemsResult = await client.query(
        'SELECT knowledge_id FROM knowledge_items'
      );

      const itemIds = itemsResult.rows;
      if (client) client.release();
      client = null;

      let totalTerms = 0;

      for (let i = 0; i < itemIds.length; i += RETRIEVAL.BATCH_SIZE) {
        const batch = itemIds.slice(i, i + RETRIEVAL.BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(row => this.indexKnowledgeItem(row.knowledge_id, correlationId))
        );
        for (const result of batchResults) {
          if (result.indexed) {
            totalTerms += result.termCount;
          } else if (result.error) {
            errors.push(result.error);
          }
        }
      }

      client = await this._getClient(correlationId);
      try {
        await this._updateIdfValues(client, correlationId);
      } finally {
        if (client) client.release();
        client = null;
      }

      this._invalidateCache(correlationId);
      this._avgDocLength = null;

      const elapsed = Date.now() - start;
      logger.info('Full index build complete', {
        totalItems: itemIds.length,
        totalTerms,
        errorCount: errors.length,
        elapsedMs: elapsed,
        correlationId
      });

      Counters.increment('knowledge_build_index', 'success');

      return { totalItems: itemIds.length, totalTerms, errors };

    } catch (error) {
      Counters.increment('knowledge_build_index', 'failure');
      logger.error('Full index build failed', {
        correlationId,
        error: error.message
      });
      errors.push(error.message);
      return { totalItems: 0, totalTerms: 0, errors };
    } finally {
      if (client) client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Index Statistics                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Get index statistics for observability.
   *
   * @param {string} [correlationId] - Request correlation ID
   * @returns {Promise<{uniqueTerms, totalEntries, indexedDocs, cacheSize}>}
   */
  async getIndexStats(correlationId) {
    const client = await this._getClient(correlationId);
    try {
      const result = await client.query(
        'SELECT ' +
        '  COUNT(DISTINCT term) as unique_terms, ' +
        '  COUNT(*) as total_entries, ' +
        '  COUNT(DISTINCT knowledge_id) as indexed_docs ' +
        'FROM knowledge_retrieval_index'
      );

      const stats = {
        uniqueTerms: parseInt(result.rows[0].unique_terms, 10),
        totalEntries: parseInt(result.rows[0].total_entries, 10),
        indexedDocs: parseInt(result.rows[0].indexed_docs, 10),
        cacheSize: this._cache.size,
        avgDocLength: this._avgDocLength
      };

      logger.debug('Index stats retrieved', { ...stats, correlationId });

      return stats;

    } finally {
      if (client) client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Tokenize (exposed for testing and external use)                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Tokenize text into lowercase stemmed terms, filtering stopwords.
   *
   * @param {string} text - Raw text to tokenize
   * @returns {string[]} Array of filtered, stemmed tokens
   */
  tokenize(text) {
    if (!text || typeof text !== 'string') return [];

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(token =>
        token.length > RETRIEVAL.MIN_TOKEN_LENGTH &&
        !STOPWORDS.has(token) &&
        !/^\d+$/.test(token)
      )
      .map(token => this._stem(token));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Execute BM25 Retrieval                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _executeRetrieval(client, tokens, queryTf, topK, correlationId) {
    const avgDl = await this._getAverageDocLength(client, correlationId);

    const placeholders = tokens.map((_, i) => '$' + (i + 1)).join(', ');

    // SECURITY NOTE: BM25.K1, BM25.B, and avgDl are frozen module-level
    // constants or internally-computed floats — never user input.
    // All user-derived values (tokens, topK) are fully parameterised.
    const scoreQuery =
      'SELECT ' +
      '  kri.knowledge_id, ' +
      '  SUM( ' +
      '    COALESCE(kri.inverse_document_frequency, 1) * ' +
      '    (kri.term_frequency * (' + BM25.K1 + ' + 1)) / ' +
      '    (kri.term_frequency + ' + BM25.K1 + ' * (1 - ' + BM25.B + ' + ' + BM25.B + ' * ' +
      '      COALESCE(kri.doc_length, ' + avgDl + ') / GREATEST(' + avgDl + ', 1))) ' +
      '  ) as score ' +
      'FROM knowledge_retrieval_index kri ' +
      'WHERE kri.term IN (' + placeholders + ') ' +
      'GROUP BY kri.knowledge_id ' +
      'ORDER BY score DESC ' +
      'LIMIT $' + (tokens.length + 1);

    let queryTimer;
    const queryPromise = client.query(scoreQuery, [...tokens, topK]);
    const timeoutPromise = new Promise((_, reject) => {
      queryTimer = setTimeout(() => reject(new Error('BM25 query timeout')), RETRIEVAL.QUERY_TIMEOUT_MS);
    });

    const scoreResult = await Promise.race([queryPromise, timeoutPromise]).finally(() => clearTimeout(queryTimer));

    if (scoreResult.rows.length === 0) {
      return [];
    }

    return this._hydrateResults(client, scoreResult.rows, queryTf, correlationId);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Hydrate Results With Full Knowledge Items                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _hydrateResults(client, scoreRows, queryTf, correlationId) {
    const knowledgeIds = scoreRows.map(r => r.knowledge_id);

    if (knowledgeIds.length === 0) {
      return [];
    }

    const idPlaceholders = knowledgeIds.map((_, i) => '$' + (i + 1)).join(', ');

    const itemsResult = await client.query(
      'SELECT knowledge_id, content, concept, answer_statement, entry_type ' +
      'FROM knowledge_items ' +
      'WHERE knowledge_id IN (' + idPlaceholders + ')',
      knowledgeIds
    );

    const itemMap = new Map();
    for (const item of itemsResult.rows) {
      itemMap.set(item.knowledge_id, item);
    }

    return scoreRows.map(row => {
      const item = itemMap.get(row.knowledge_id) || {};
      const rawScore = parseFloat(row.score);

      const docTokens = new Set(this.tokenize(
        (item.content || '') + ' ' + (item.concept || '')
      ));
      let queryBoost = 0;
      for (const [term, count] of queryTf) {
        if (docTokens.has(term)) {
          queryBoost += count - 1;
        }
      }

      return {
        knowledgeId: row.knowledge_id,
        score: Math.round((rawScore + rawScore * queryBoost * 0.1) * 10000) / 10000,
        content: item.content || '',
        concept: item.concept || '',
        answerStatement: item.answer_statement || '',
        entryType: item.entry_type || 'fact'
      };
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Porter-Subset Stemmer                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Simple Porter-subset stemmer for basic English morphology.
   *
   * KNOWN LIMITATIONS:
   * - Collapses some distinct words: university/universe → 'univers'
   * - Does not handle irregular forms: better ≠ good, ran ≠ run
   * - Acceptable for The Expanse's retrieval precision requirements
   * - Protected terms (Expanse-specific) bypass stemming entirely
   *
   * @param {string} word - Word to stem
   * @returns {string} Stemmed word
   */
  _stem(word) {
    if (PROTECTED_TERMS.has(word)) return word;
    if (word.length < 4) return word;

    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
    if (word.endsWith('sses')) return word.slice(0, -2);
    if (word.endsWith('ness')) return word.slice(0, -4);
    if (word.endsWith('ment') && word.length > 6) return word.slice(0, -4);
    if (word.endsWith('tion')) return word.slice(0, -4) + 't';
    if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
    if (word.endsWith('ated')) return word.slice(0, -4) + 'ate';
    if (word.endsWith('ized')) return word.slice(0, -4) + 'ize';
    if (word.endsWith('ful')) return word.slice(0, -3);
    if (word.endsWith('ous')) return word.slice(0, -3);
    if (word.endsWith('ive')) return word.slice(0, -3);
    if (word.endsWith('ble')) return word.slice(0, -3);
    if (word.endsWith('ly') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('er') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);

    return word;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Term Frequency                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateTermFrequency(tokens) {
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    return tf;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Average Document Length                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _getAverageDocLength(client, correlationId) {
    if (this._avgDocLength !== null) return this._avgDocLength;

    const result = await client.query(
      'SELECT AVG(doc_length) as avg_dl FROM (' +
      '  SELECT DISTINCT knowledge_id, doc_length ' +
      '  FROM knowledge_retrieval_index ' +
      '  WHERE doc_length IS NOT NULL' +
      ') sub'
    );

    const avgDl = parseFloat(result.rows[0]?.avg_dl);
    this._avgDocLength = (avgDl != null && !isNaN(avgDl) && avgDl > 0)
      ? avgDl
      : RETRIEVAL.DEFAULT_AVG_DOC_LENGTH;
    logger.debug('Average doc length computed', { avgDocLength: this._avgDocLength, correlationId });
    return this._avgDocLength;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Update IDF Values                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _updateIdfValues(client, correlationId) {
    const countResult = await client.query(
      'SELECT COUNT(DISTINCT knowledge_id) as doc_count FROM knowledge_retrieval_index'
    );
    const totalDocs = parseInt(countResult.rows[0].doc_count, 10) || 1;

    await client.query(
      'WITH term_docs AS ( ' +
      '  SELECT term, COUNT(DISTINCT knowledge_id) AS doc_freq ' +
      '  FROM knowledge_retrieval_index ' +
      '  GROUP BY term ' +
      ') ' +
      'UPDATE knowledge_retrieval_index kri ' +
      'SET inverse_document_frequency = LOG(10, CAST($1 AS NUMERIC) / GREATEST(td.doc_freq, 1)) ' +
      'FROM term_docs td ' +
      'WHERE kri.term = td.term',
      [totalDocs]
    );

    logger.debug('IDF values updated', { totalDocs, correlationId });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: LRU Cache With TTL                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  _cacheGet(key, correlationId) {
    if (!this._cache.has(key)) return null;

    const storedAt = this._cacheMeta.get(key);
    if (storedAt && (Date.now() - storedAt > RETRIEVAL.CACHE_TTL_MS)) {
      this._cacheDelete(key);
      Counters.increment('knowledge_retrieve', 'cache_expired');
      logger.debug('Cache entry expired', { correlationId });
      return null;
    }

    const idx = this._cacheOrder.indexOf(key);
    if (idx > -1) {
      this._cacheOrder.splice(idx, 1);
      this._cacheOrder.push(key);
    }

    return this._cache.get(key);
  }

  _cachePut(key, value, correlationId) {
    if (this._cache.has(key)) {
      this._cacheDelete(key);
    }

    this._cache.set(key, value);
    this._cacheMeta.set(key, Date.now());
    this._cacheOrder.push(key);

    while (this._cacheOrder.length > RETRIEVAL.CACHE_MAX_SIZE) {
      const evicted = this._cacheOrder.shift();
      this._cacheDelete(evicted);
      Counters.increment('knowledge_retrieve', 'cache_eviction');
    }
  }

  _cacheDelete(key) {
    this._cache.delete(key);
    this._cacheMeta.delete(key);
    const idx = this._cacheOrder.indexOf(key);
    if (idx > -1) this._cacheOrder.splice(idx, 1);
  }

  _invalidateCache(correlationId) {
    const size = this._cache.size;
    this._cache.clear();
    this._cacheMeta.clear();
    this._cacheOrder = [];
    if (size > 0) {
      logger.debug('Cache invalidated', { evictedEntries: size, correlationId });
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Class Export (ClaudeBrain instantiates with new)                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default KnowledgeRetriever;
