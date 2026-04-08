/**
 * =============================================================================
 * KnowledgeAcquisitionEngine — Concept Lookup and Acquisition Packaging
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * When the teaching system (TSE) needs to teach a concept, this engine
 * checks if that concept already exists in the knowledge_items table.
 * If found, it returns the existing item to avoid duplication.
 * If not found, it packages the concept for new insertion downstream.
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TSELoopManager.js — calls acquire(characterId, query)
 *
 * PUBLIC METHODS:
 * ---------------------------------------------------------------------------
 *   acquire(characterId, query, opts) — main entry point
 *   lookupExisting(concept, opts) — search for existing knowledge item
 *   normalizeConcept(text) — strip noise words and punctuation
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 *   logger.js — structured logging with correlation IDs
 *   pool (via constructor) — PostgreSQL connection pool
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger (no console.log)
 *   - Constructor requires dbPool (no module-level fallback)
 *   - _query helper with labeled timeout
 *   - Hex ID validation on characterId
 *   - correlationId threading via opts parameter
 *   - Counters on all paths
 *   - Error handling on all async operations
 *   - Named export alongside default
 *
 * =============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('KnowledgeAcquisitionEngine');

/* ==========================================================================
 * Frozen Constants
 * ========================================================================== */

const DEFAULTS = Object.freeze({
  QUERY_TIMEOUT_MS: 8000,
  NOISE_WORDS: /\b(what|is|the|a|an|explain|define)\b/g,
  ALLOWED_CHARS: /[^a-z0-9\s]/g
});

/* ==========================================================================
 * Counters
 * ========================================================================== */

const Counters = {
  _counts: {},
  increment(name) {
    this._counts[name] = (this._counts[name] || 0) + 1;
  },
  getAll() {
    return { ...this._counts };
  }
};

/* ==========================================================================
 * KnowledgeAcquisitionEngine CLASS
 * ========================================================================== */

class KnowledgeAcquisitionEngine {

  /**
   * @param {object} dbPool — PostgreSQL pool instance (required)
   */
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error('KnowledgeAcquisitionEngine requires a database pool');
    }
    this.pool = dbPool;
    logger.info('KnowledgeAcquisitionEngine initialised');
  }

  /* ═══════════════════════════════════════════════
     QUERY HELPER — labeled timeout protection
  ═══════════════════════════════════════════════ */

  async _query(label, sql, params, opts = {}) {
    const timeout = opts.timeout || DEFAULTS.QUERY_TIMEOUT_MS;
    const correlationId = opts.correlationId || null;

    const queryPromise = this.pool.query(sql, params);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), timeout)
    );

    try {
      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (err) {
      logger.error('Query failed', err, { label, correlationId, timeout });
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════
     INPUT VALIDATION
  ═══════════════════════════════════════════════ */

  _validateHexId(value) {
    if (!value || typeof value !== 'string') return false;
    return /^#[0-9A-Fa-f]{6}$/.test(value);
  }

  /* ═══════════════════════════════════════════════
     NORMALIZE CONCEPT
  ═══════════════════════════════════════════════ */

  normalizeConcept(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(DEFAULTS.ALLOWED_CHARS, '')
      .replace(DEFAULTS.NOISE_WORDS, '')
      .trim();
  }

  /* ═══════════════════════════════════════════════
     LOOKUP EXISTING KNOWLEDGE
  ═══════════════════════════════════════════════ */

  async lookupExisting(concept, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!concept) {
      Counters.increment('lookupExisting.empty_concept');
      return null;
    }

    try {
      const result = await this._query('lookupExisting',
        `SELECT *
         FROM knowledge_items
         WHERE LOWER(concept) = LOWER($1)
            OR LOWER(content) LIKE '%' || LOWER($1) || '%'
         ORDER BY acquisition_timestamp DESC
         LIMIT 1`,
        [concept],
        { correlationId }
      );

      if (result.rows.length) {
        Counters.increment('lookupExisting.found');
        logger.debug('Existing knowledge item found', {
          correlationId, concept, knowledgeId: result.rows[0].knowledge_id
        });
        return result.rows[0];
      }

      Counters.increment('lookupExisting.not_found');
      return null;
    } catch (err) {
      Counters.increment('lookupExisting.error');
      logger.error('lookupExisting failed', err, { correlationId, concept });
      return null;
    }
  }

  /* ═══════════════════════════════════════════════
     ACQUIRE — Main entry point
  ═══════════════════════════════════════════════ */

  async acquire(characterId, query, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!this._validateHexId(characterId)) {
      Counters.increment('acquire.invalid_hex');
      logger.warn('acquire: invalid characterId', { correlationId, characterId });
    }

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      Counters.increment('acquire.empty_query');
      logger.warn('acquire: empty or invalid query', { correlationId, characterId });
      return {
        characterId,
        concept: '',
        domainId: null,
        content: '',
        sourceType: 'tse_cycle',
        reused: false
      };
    }

    const concept = this.normalizeConcept(query);

    const existing = await this.lookupExisting(concept, opts);
    if (existing) {
      Counters.increment('acquire.reused');
      logger.debug('Knowledge item reused', {
        correlationId, characterId, concept,
        knowledgeId: existing.knowledge_id
      });
      return {
        ...existing,
        reused: true,
        characterId,
        knowledge_id: existing.knowledge_id
      };
    }

    Counters.increment('acquire.new');
    logger.debug('New acquisition package created', {
      correlationId, characterId, concept
    });

    return {
      characterId,
      concept,
      domainId: null,
      content: query,
      sourceType: 'tse_cycle',
      reused: false
    };
  }

  /* ═══════════════════════════════════════════════
     DIAGNOSTICS
  ═══════════════════════════════════════════════ */

  getCounters() {
    return Counters.getAll();
  }
}

export { KnowledgeAcquisitionEngine };
export default KnowledgeAcquisitionEngine;
