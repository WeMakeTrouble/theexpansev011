/**
 * =============================================================================
 * TraitManager — Character & User Personality Trait Service
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Singleton service that manages personality trait scores. Each entity
 * (character or user) has trait scores stored in character_trait_scores,
 * keyed by hex colour IDs from the characteristics table.
 *
 * Traits are organized by category (Emotional, Cognitive, Social,
 * Behavioral, Specialized, Inventory, Knowledge, Blank Slot) and each
 * has a percentile_score from 0.00 to 100.00.
 *
 * DATABASE TABLES:
 * ---------------------------------------------------------------------------
 *   characteristics — trait definitions (hex_color PK, trait_name, category)
 *   character_trait_scores — scores per entity (character_hex_id, trait_hex_color, percentile_score)
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TeacherComponent.js — getTraitVector() for difficulty computation
 *   EvaluatorComponent.js — getTraitVector() for evaluation context
 *
 * FUTURE: USER TRAIT ONBOARDING
 * ---------------------------------------------------------------------------
 * Currently only characters have trait scores. When Claude the Tanuki
 * onboarding is built, users will be seeded with DEFAULT_STARTING_PERCENTILE
 * (70) across all traits, then adjusted through interaction assessment.
 * The getTraitVector() method already works for user hex IDs — it will
 * return results as soon as rows exist in character_trait_scores.
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger with createModuleLogger (no console.log)
 *   - Counters on every public method (.success and .error variants)
 *   - Input validation via isValidHexId
 *   - Query timeout protection via _query helper
 *   - Frozen constants
 *   - Correlation ID threading via opts parameter
 *   - Score clamping on updates (0-100)
 *
 * EXPORT:
 * ---------------------------------------------------------------------------
 *   Default export: singleton instance (not the class)
 *
 * =============================================================================
 */

import pool from '../db/pool.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';
import Counters from '../councilTerminal/metrics/counters.js';

/* ==========================================================================
 * Constants
 * ========================================================================== */

const MODULE_NAME = 'TraitManager';

const DEFAULTS = Object.freeze({
  QUERY_TIMEOUT_MS: 8000,
  STARTING_PERCENTILE: 70,
  MIN_SCORE: 0,
  MAX_SCORE: 100,
  FALLBACK_SCORE: 50
});

const TRAIT_CATEGORIES = Object.freeze({
  EMOTIONAL: 'Emotional',
  COGNITIVE: 'Cognitive',
  SOCIAL: 'Social',
  BEHAVIORAL: 'Behavioral',
  SPECIALIZED: 'Specialized',
  INVENTORY: 'Inventory',
  KNOWLEDGE: 'Knowledge',
  BLANK_SLOT: 'Blank Slot'
});

const logger = createModuleLogger(MODULE_NAME);

/* ==========================================================================
 * TraitManager Class
 * ========================================================================== */

class TraitManager {

  constructor() {
    this.pool = pool;
  }

  /* ========================================================================
   * Internal: Query Helper
   * ======================================================================== */

  /**
   * Execute a query with timeout protection.
   * @param {string} sql — parameterised SQL string
   * @param {Array} params — query parameters
   * @param {string} methodLabel — calling method name for timeout diagnostics
   * @returns {object} query result
   */
  async _query(sql, params = [], methodLabel = 'unknown') {
    const timeoutMs = DEFAULTS.QUERY_TIMEOUT_MS;

    const queryPromise = this.pool.query(sql, params);
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `${MODULE_NAME}.${methodLabel}: query timeout after ${timeoutMs}ms`
        ));
      }, timeoutMs);
      queryPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
    });

    return Promise.race([queryPromise, timeoutPromise]);
  }

  /* ========================================================================
   * Input Validation
   * ======================================================================== */

  /**
   * Validate a hex ID parameter. Throws if invalid.
   * @param {string} value — the hex ID to validate
   * @param {string} name — parameter name for error messages
   */
  _validateHexId(value, name) {
    if (!value || !isValidHexId(value)) {
      throw new Error(
        `${MODULE_NAME}: invalid ${name} — expected #XXXXXX hex format, got: ${value}`
      );
    }
  }

  /* ========================================================================
   * Public Methods
   * ======================================================================== */

  /**
   * Retrieve all trait scores for an entity as a map.
   * Returns { '#XXXXXX': percentileScore, ... } keyed by trait hex colour.
   *
   * Returns empty object if entity has no trait scores (e.g. users before
   * onboarding seeds their traits).
   *
   * @param {string} entityId — hex ID of character or user
   * @param {object} opts — { correlationId }
   * @returns {object} map of trait_hex_color to percentile_score
   */
  async getTraitVector(entityId, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('traits.get_trait_vector');

    this._validateHexId(entityId, 'entityId');

    try {
      const result = await this._query(
        `SELECT trait_hex_color, percentile_score
         FROM character_trait_scores
         WHERE character_hex_id = $1`,
        [entityId],
        'getTraitVector'
      );

      const traitScores = {};
      for (const row of result.rows) {
        traitScores[row.trait_hex_color] = parseFloat(row.percentile_score);
      }

      Counters.increment('traits.get_trait_vector.success');
      logger.debug('Trait vector fetched', {
        entityId, traitCount: result.rows.length, correlationId
      });

      return traitScores;

    } catch (error) {
      Counters.increment('traits.get_trait_vector.error');
      logger.error('getTraitVector failed', error, {
        entityId, correlationId
      });
      return {};
    }
  }

  /**
   * Retrieve trait scores filtered by category.
   * Joins character_trait_scores with characteristics to filter by category.
   *
   * @param {string} entityId — hex ID of character or user
   * @param {string} category — trait category (must be valid TRAIT_CATEGORIES value)
   * @param {object} opts — { correlationId }
   * @returns {object} map of trait_hex_color to percentile_score
   */
  async getTraitsByCategory(entityId, category, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('traits.get_traits_by_category');

    this._validateHexId(entityId, 'entityId');

    const validCategories = Object.values(TRAIT_CATEGORIES);
    if (!validCategories.includes(category)) {
      throw new Error(
        `${MODULE_NAME}: invalid category — expected one of ${validCategories.join(', ')}, got: ${category}`
      );
    }

    try {
      const result = await this._query(
        `SELECT cts.trait_hex_color, cts.percentile_score
         FROM character_trait_scores cts
         JOIN characteristics c ON cts.trait_hex_color = c.hex_color
         WHERE cts.character_hex_id = $1
           AND c.category = $2`,
        [entityId, category],
        'getTraitsByCategory'
      );

      const traitScores = {};
      for (const row of result.rows) {
        traitScores[row.trait_hex_color] = parseFloat(row.percentile_score);
      }

      Counters.increment('traits.get_traits_by_category.success');
      logger.debug('Traits by category fetched', {
        entityId, category, traitCount: result.rows.length, correlationId
      });

      return traitScores;

    } catch (error) {
      Counters.increment('traits.get_traits_by_category.error');
      logger.error('getTraitsByCategory failed', error, {
        entityId, category, correlationId
      });
      return {};
    }
  }

  /**
   * Compute average percentile across a trait category.
   * Useful for deriving difficulty from Cognitive traits, empathy from
   * Emotional traits, etc.
   *
   * Returns null if entity has no traits in the given category.
   *
   * @param {string} entityId — hex ID of character or user
   * @param {string} category — trait category
   * @param {object} opts — { correlationId }
   * @returns {number|null} average percentile (0-100) or null if no data
   */
  async getCategoryAverage(entityId, category, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('traits.get_category_average');

    this._validateHexId(entityId, 'entityId');

    const validCategories = Object.values(TRAIT_CATEGORIES);
    if (!validCategories.includes(category)) {
      throw new Error(
        `${MODULE_NAME}: invalid category — expected one of ${validCategories.join(', ')}, got: ${category}`
      );
    }

    try {
      const result = await this._query(
        `SELECT AVG(cts.percentile_score) AS avg_score
         FROM character_trait_scores cts
         JOIN characteristics c ON cts.trait_hex_color = c.hex_color
         WHERE cts.character_hex_id = $1
           AND c.category = $2`,
        [entityId, category],
        'getCategoryAverage'
      );

      const avg = result.rows[0]?.avg_score;
      if (avg === null || avg === undefined) {
        Counters.increment('traits.get_category_average.empty');
        logger.debug('No traits found for category average', {
          entityId, category, correlationId
        });
        return null;
      }

      const score = parseFloat(avg);

      Counters.increment('traits.get_category_average.success');
      logger.debug('Category average computed', {
        entityId, category, average: score, correlationId
      });

      return score;

    } catch (error) {
      Counters.increment('traits.get_category_average.error');
      logger.error('getCategoryAverage failed', error, {
        entityId, category, correlationId
      });
      return null;
    }
  }

  /**
   * Update a specific trait score for an entity.
   * Applies delta to current score, clamped to 0-100.
   * Uses UPSERT — creates row if it doesn't exist (defaults to FALLBACK_SCORE + delta).
   *
   * @param {string} entityId — hex ID of character or user
   * @param {string} traitHexId — hex ID of the trait to update
   * @param {number} delta — amount to change the score by
   * @param {object} opts — { correlationId }
   * @returns {number|null} new score after update, or null on failure
   */
  async updateTrait(entityId, traitHexId, delta, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('traits.update_trait');

    this._validateHexId(entityId, 'entityId');
    this._validateHexId(traitHexId, 'traitHexId');

    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      throw new Error(
        `${MODULE_NAME}: delta must be a finite number, got: ${delta}`
      );
    }

    try {
      const currentResult = await this._query(
        `SELECT percentile_score
         FROM character_trait_scores
         WHERE character_hex_id = $1 AND trait_hex_color = $2`,
        [entityId, traitHexId],
        'updateTrait.select'
      );

      const currentScore = currentResult.rows[0]
        ? parseFloat(currentResult.rows[0].percentile_score)
        : DEFAULTS.FALLBACK_SCORE;

      const newScore = Math.min(
        DEFAULTS.MAX_SCORE,
        Math.max(DEFAULTS.MIN_SCORE, currentScore + delta)
      );

      await this._query(
        `INSERT INTO character_trait_scores (character_hex_id, trait_hex_color, percentile_score)
         VALUES ($1, $2, $3)
         ON CONFLICT (character_hex_id, trait_hex_color)
         DO UPDATE SET percentile_score = EXCLUDED.percentile_score, updated_at = NOW()`,
        [entityId, traitHexId, newScore],
        'updateTrait.upsert'
      );

      Counters.increment('traits.update_trait.success');
      logger.debug('Trait updated', {
        entityId, traitHexId, previousScore: currentScore,
        delta, newScore, correlationId
      });

      return newScore;

    } catch (error) {
      Counters.increment('traits.update_trait.error');
      logger.error('updateTrait failed', error, {
        entityId, traitHexId, delta, correlationId
      });
      return null;
    }
  }
}

/* ==========================================================================
 * Singleton Export
 * ========================================================================== */

const traitManager = new TraitManager();

export default traitManager;
export { DEFAULTS as TRAIT_DEFAULTS, TRAIT_CATEGORIES };
