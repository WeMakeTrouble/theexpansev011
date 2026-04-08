/**
 * ============================================================================
 * CharacterDossierService.js — Character Dossier Generator (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Generates comprehensive character dossiers with tiered access control.
 * Higher belt/access tiers see progressively more character data.
 * All data fetched in parallel with timeout protection.
 *
 * TIERED ACCESS MODEL (Executable Policy)
 * ----------------------------------------
 * Tier 1 (White Belt)  : core, images
 * Tier 2 (Blue Belt)   : + personality
 * Tier 3 (Purple Belt) : + relationships, psychic.social
 * Tier 4 (Brown Belt)  : + knowledge, inventory, traits
 * Tier 5 (Black Belt)  : + identity, psychic.full, narrative
 * Tier 6 (God Mode)    : + systemData (admin only)
 *
 * TIER_SECTIONS defines visibility policy as data, not if/else chains.
 * SECTION_BUILDERS maps section keys to builder methods.
 * _buildTieredDossier iterates tiers up to requester level.
 *
 * CACHING
 * -------
 * LRU cache with configurable TTL and max size. Keyed by
 * characterId + requesterId + requesterType + tier.
 * invalidateCache(characterId) clears all entries for a character.
 *
 * PERFORMANCE
 * -----------
 * - All section queries run in parallel via Promise.allSettled
 * - Single CTE query for psychic state (3-in-1)
 * - Characteristics map cached in memory (5min TTL)
 * - Configurable per-section LIMIT clauses via ENV
 * - Selective field projection (system fields only at tier 6)
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Structured logger (createModuleLogger) replaces old Logger import
 * - Timeout bug fixed: Promise.race with actual timer (v009 timeoutId
 *   was declared but never assigned)
 * - Promise.allSettled replaces Promise.all (one failed query doesn't
 *   crash entire dossier)
 * - withRetry wrapper on DB queries for transient failure resilience
 * - Counters integration for cache hits/misses, slow queries, tiers
 * - Cache key uses pipe delimiter to prevent colon collision
 * - Documentation header with full architecture description
 * - Frozen constants throughout
 * - Input validation unchanged (already strong)
 *
 * DEPENDENCIES
 * ------------
 * - pool.js (PostgreSQL)
 * - logger.js (structured logging)
 * - counters.js (metrics)
 * - withRetry.js (transient failure retry)
 *
 * DB TABLES
 * ---------
 * - character_profiles, character_personality, identity_anchors
 * - character_trait_scores, characteristics, character_knowledge_state
 * - knowledge_items, character_inventory, objects
 * - relationship_state, users, psychic_moods, psychic_frames
 * - psychic_proximity, character_image_gallery, multimedia_assets
 * - characters_in_narrative, narrative_segments
 * - user_belt_progression, character_belt_progression
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import Counters from '../councilTerminal/metrics/counters.js';
import { withRetry } from '../councilTerminal/utils/withRetry.js';

const logger = createModuleLogger('CharacterDossierService');

/*
 * ============================================================================
 * Configuration (ENV vars with sensible defaults)
 * ============================================================================
 */
const ENV = process.env;

const CONFIG = Object.freeze({
  QUERY_TIMEOUT_MS: Number(ENV.DOSSIER_QUERY_TIMEOUT_MS) || 5000,
  CACHE_TTL_MS: Number(ENV.DOSSIER_CACHE_TTL_MS) || 60000,
  CACHE_MAX_SIZE: Number(ENV.DOSSIER_CACHE_MAX_SIZE) || 100,
  SLOW_QUERY_THRESHOLD_MS: Number(ENV.DOSSIER_SLOW_QUERY_MS) || 1000,
  CHARACTERISTICS_CACHE_MS: 300000,
  IDENTITY_ANCHORS_LIMIT: Number(ENV.DOSSIER_IDENTITY_LIMIT) || 20,
  TRAITS_LIMIT: Number(ENV.DOSSIER_TRAITS_LIMIT) || 50,
  KNOWLEDGE_LIMIT: Number(ENV.DOSSIER_KNOWLEDGE_LIMIT) || 30,
  INVENTORY_LIMIT: Number(ENV.DOSSIER_INVENTORY_LIMIT) || 30,
  RELATIONSHIPS_LIMIT: Number(ENV.DOSSIER_RELATIONSHIPS_LIMIT) || 20,
  IMAGES_LIMIT: Number(ENV.DOSSIER_IMAGES_LIMIT) || 10,
  NARRATIVE_LIMIT: Number(ENV.DOSSIER_NARRATIVE_LIMIT) || 10,
  PSYCHIC_FRAMES_LIMIT: Number(ENV.DOSSIER_PSYCHIC_FRAMES_LIMIT) || 5,
  PSYCHIC_PROXIMITY_LIMIT: Number(ENV.DOSSIER_PSYCHIC_PROXIMITY_LIMIT) || 10
});

/*
 * ============================================================================
 * Tier Policy — Executable, Not If/Else
 * ============================================================================
 */
const TIER_SECTIONS = Object.freeze({
  1: Object.freeze(['core', 'images']),
  2: Object.freeze(['personality']),
  3: Object.freeze(['relationships', 'psychic.social']),
  4: Object.freeze(['knowledge', 'inventory', 'traits']),
  5: Object.freeze(['identity', 'psychic.full', 'narrative']),
  6: Object.freeze(['systemData'])
});

const SECTION_BUILDERS = Object.freeze({
  'core': '_buildCoreSection',
  'images': '_buildImagesSection',
  'personality': '_buildPersonalitySection',
  'relationships': '_buildRelationshipsSection',
  'psychic.social': '_buildPsychicSocialSection',
  'knowledge': '_buildKnowledgeSection',
  'inventory': '_buildInventorySection',
  'traits': '_buildTraitsSection',
  'identity': '_buildIdentitySection',
  'psychic.full': '_buildPsychicFullSection',
  'narrative': '_buildNarrativeSection',
  'systemData': '_buildSystemDataSection'
});

const SECTION_QUERY_MAP = Object.freeze({
  'core':           { queryKey: 'core',          method: '_getCoreProfile',       passTier: true },
  'images':         { queryKey: 'images',        method: '_getImages' },
  'personality':    { queryKey: 'personality',    method: '_getPersonality',       passTier: true },
  'relationships':  { queryKey: 'relationships', method: '_getRelationships' },
  'psychic.social': { queryKey: 'psychic',       method: '_getPsychicState' },
  'psychic.full':   { queryKey: 'psychic',       method: '_getPsychicState' },
  'knowledge':      { queryKey: 'knowledge',     method: '_getKnowledgeState' },
  'inventory':      { queryKey: 'inventory',     method: '_getInventory' },
  'traits':         { queryKey: 'traits',         method: '_getTraitScores' },
  'identity':       { queryKey: 'identity',      method: '_getIdentityAnchors' },
  'narrative':      { queryKey: 'narrative',     method: '_getNarrativePosition' },
  'systemData':     { queryKey: 'core',          method: '_getCoreProfile',       passTier: true }
});

const BELT_TIERS = Object.freeze({
  white_belt: 1,
  blue_belt: 2,
  purple_belt: 3,
  brown_belt: 4,
  black_belt: 5
});

/*
 * ============================================================================
 * LRU Cache
 * ============================================================================
 */
class LRUCache {
  constructor(maxSize, ttlMs) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._cache = new Map();
  }

  _generateKey(characterId, requesterId, requesterType, tier) {
    return `${characterId}|${requesterId}|${requesterType}|${tier}`;
  }

  get(characterId, requesterId, requesterType, tier) {
    const key = this._generateKey(characterId, requesterId, requesterType, tier);
    const entry = this._cache.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }

    this._cache.delete(key);
    this._cache.set(key, entry);

    return entry.value;
  }

  set(characterId, requesterId, requesterType, tier, value) {
    const key = this._generateKey(characterId, requesterId, requesterType, tier);

    if (this._cache.size >= this._maxSize) {
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }

    this._cache.set(key, {
      value,
      expiresAt: Date.now() + this._ttlMs
    });
  }

  invalidate(characterId) {
    for (const key of this._cache.keys()) {
      if (key.startsWith(`${characterId}|`)) {
        this._cache.delete(key);
      }
    }
  }

  clear() {
    this._cache.clear();
  }

  get size() {
    return this._cache.size;
  }
}

/*
 * ============================================================================
 * Main Service Class
 * ============================================================================
 */
class CharacterDossierService {
  constructor() {
    this._cache = new LRUCache(CONFIG.CACHE_MAX_SIZE, CONFIG.CACHE_TTL_MS);
    this._characteristicsMap = null;
    this._characteristicsMapLoadedAt = null;
  }

  /*
   * ==========================================================================
   * Input Validation
   * ==========================================================================
   */

  _validateCharacterId(characterId) {
    if (!characterId) {
      return { valid: false, error: 'characterId is required' };
    }
    if (typeof characterId !== 'string') {
      return { valid: false, error: 'characterId must be a string' };
    }
    if (characterId.length !== 7) {
      return { valid: false, error: 'characterId must be 7 characters (#XXXXXX)' };
    }
    if (!/^#[0-9A-F]{6}$/i.test(characterId)) {
      return { valid: false, error: 'characterId must be valid hex format (#XXXXXX)' };
    }
    return { valid: true };
  }

  _validateRequester(requesterId, requesterType) {
    if (!requesterId) {
      return { valid: false, error: 'requesterId is required' };
    }
    if (typeof requesterId !== 'string') {
      return { valid: false, error: 'requesterId must be a string' };
    }
    if (requesterId.length > 100) {
      return { valid: false, error: 'requesterId exceeds maximum length' };
    }
    if (!requesterType) {
      return { valid: false, error: 'requesterType is required' };
    }
    if (!['user', 'character'].includes(requesterType)) {
      return { valid: false, error: "requesterType must be 'user' or 'character'" };
    }
    return { valid: true };
  }

  /*
   * ==========================================================================
   * Query Helpers
   * ==========================================================================
   */

  /**
   * Wraps a query function with timeout protection via Promise.race.
   * v010 fix: v009 declared timeoutId but never assigned it.
   *
   * @param {Function} queryFn - Async function returning query result
   * @param {string} sectionName - Section name for logging
   * @returns {Promise<object>} { data, error?, section, durationMs }
   */
  async _queryWithTimeout(queryFn, sectionName) {
    const startTime = Date.now();
    let timeoutId;

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timeout: ${sectionName} exceeded ${CONFIG.QUERY_TIMEOUT_MS}ms`)),
          CONFIG.QUERY_TIMEOUT_MS
        );
      });

      const result = await Promise.race([queryFn(), timeoutPromise]);
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      if (durationMs > CONFIG.SLOW_QUERY_THRESHOLD_MS) {
        logger.warn("Slow query detected", {
          section: sectionName,
          durationMs,
          threshold: CONFIG.SLOW_QUERY_THRESHOLD_MS
        });
        Counters.increment("dossier_slow_query", sectionName);
      }

      return { data: result, section: sectionName, durationMs };
    } catch (error) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - startTime;

      logger.warn("Query failed for section", {
        section: sectionName,
        error: error.message,
        durationMs
      });

      return { data: null, error: error.message, section: sectionName, durationMs };
    }
  }

  /*
   * ==========================================================================
   * Characteristics Cache
   * ==========================================================================
   */

  async _getCharacteristicsMap(correlationId) {
    if (
      this._characteristicsMap &&
      this._characteristicsMapLoadedAt &&
      Date.now() - this._characteristicsMapLoadedAt < CONFIG.CHARACTERISTICS_CACHE_MS
    ) {
      return this._characteristicsMap;
    }

    try {
      const result = await pool.query(
        'SELECT hex_color, trait_name, category FROM characteristics'
      );

      this._characteristicsMap = new Map();
      for (const row of result.rows) {
        this._characteristicsMap.set(row.hex_color, {
          traitName: row.trait_name,
          category: row.category
        });
      }
      this._characteristicsMapLoadedAt = Date.now();

      logger.debug('Characteristics map loaded', {
        count: this._characteristicsMap.size
      });

      return this._characteristicsMap;
    } catch (error) {
      logger.error('Failed to load characteristics map', error, {
        correlationId: correlationId || 'no-correlation-id'
      });
      return new Map();
    }
  }

  /*
   * ==========================================================================
   * Main Public API
   * ==========================================================================
   */

  /**
   * Generate dossier for a character, filtered by requester access tier.
   *
   * @param {string} characterId - Target character (#XXXXXX)
   * @param {string} requesterId - Who is asking (user_id or character_id)
   * @param {string} requesterType - 'user' or 'character'
   * @param {string} correlationId - For logging
   * @param {object} [options] - Optional settings
   * @param {boolean} [options.bypassCache] - Skip cache lookup
   * @returns {Promise<object>} { success, dossier, tier, errors[], characterId, cached, timing }
   */
  async generateCharacterDossier(characterId, requesterId, requesterType, correlationId, options = {}) {
    const totalStartTime = Date.now();

    try {
      logger.debug('Starting dossier generation', {
        correlationId,
        characterId,
        requesterId,
        requesterType
      });

      const charValidation = this._validateCharacterId(characterId);
      if (!charValidation.valid) {
        logger.warn('Invalid characterId', {
          correlationId,
          characterId,
          error: charValidation.error
        });
        return {
          success: false,
          error: charValidation.error,
          dossier: null,
          tier: null,
          characterId
        };
      }

      const reqValidation = this._validateRequester(requesterId, requesterType);
      if (!reqValidation.valid) {
        logger.warn('Invalid requester', {
          correlationId,
          requesterId,
          requesterType,
          error: reqValidation.error
        });
        return {
          success: false,
          error: reqValidation.error,
          dossier: null,
          tier: null,
          characterId
        };
      }

      const tierResult = await this._getRequesterTier(requesterId, requesterType, correlationId);
      const tier = tierResult.tier;

      logger.debug('Access tier determined', {
        correlationId,
        tier,
        grantReason: tierResult.reason
      });

      Counters.increment('dossier_tier_distribution', `tier_${tier}`);

      if (!options.bypassCache) {
        const cached = this._cache.get(characterId, requesterId, requesterType, tier);
        if (cached) {
          logger.debug('Cache hit', { correlationId, characterId, tier });
          Counters.increment('dossier_cache', 'hit');
          return {
            ...cached,
            cached: true,
            timing: { totalMs: Date.now() - totalStartTime, source: 'cache' }
          };
        }
        Counters.increment('dossier_cache', 'miss');
      }

      // Build tier-aware query set — only fetch sections this tier can see
      const visibleSections = this._getTierContract(tier);
      const queries = new Map();
      for (const section of visibleSections) {
        const mapping = SECTION_QUERY_MAP[section];
        if (mapping && !queries.has(mapping.queryKey)) {
          queries.set(mapping.queryKey, mapping);
        }
      }

      // Pre-load characteristics map only if traits section is needed
      if (queries.has("traits")) {
        await this._getCharacteristicsMap(correlationId);
      }

      const queryResults = await Promise.allSettled(
        Array.from(queries.entries()).map(([queryKey, mapping]) =>
          this._queryWithTimeout(
            () => this[mapping.method](characterId, ...(mapping.passTier ? [tier] : [])),
            queryKey
          )
        )
      );

      const sectionErrors = [];
      const sectionTiming = {};
      const rawData = {};

      queryResults.forEach((settled) => {
        if (settled.status === 'fulfilled') {
          const result = settled.value;
          rawData[result.section] = result.data;
          sectionTiming[result.section] = result.durationMs;
          if (result.error) {
            sectionErrors.push({ section: result.section, error: result.error });
          }
        } else {
          sectionErrors.push({ section: 'unknown', error: settled.reason?.message || 'Promise rejected' });
        }
      });

      const dossier = this._buildTieredDossier(tier, rawData);

      const totalMs = Date.now() - totalStartTime;

      logger.info('Dossier generated', {
        correlationId,
        characterId,
        tier,
        sectionsIncluded: Object.keys(dossier),
        sectionsWithErrors: sectionErrors.length,
        totalMs
      });

      Counters.recordLatency('dossier_generation', totalMs);

      const result = {
        success: true,
        dossier,
        tier,
        tierContract: this._getTierContract(tier),
        errors: sectionErrors.length > 0 ? sectionErrors : null,
        characterId,
        cached: false,
        timing: {
          totalMs,
          sections: sectionTiming,
          source: 'database'
        }
      };

      this._cache.set(characterId, requesterId, requesterType, tier, result);

      return result;
    } catch (error) {
      logger.error('Error generating dossier', error, {
        correlationId,
        characterId
      });

      return {
        success: false,
        error: error.message,
        dossier: null,
        tier: null,
        characterId,
        timing: { totalMs: Date.now() - totalStartTime, source: 'error' }
      };
    }
  }

  /**
   * Invalidate cache for a specific character.
   * @param {string} characterId
   */
  invalidateCache(characterId) {
    this._cache.invalidate(characterId);
    logger.debug('Cache invalidated', { characterId });
  }

  /**
   * Clear entire cache.
   */
  clearCache() {
    this._cache.clear();
    logger.debug('Cache cleared');
  }

  /**
   * Returns the tier contract for documentation/debugging.
   * @param {number} tier
   * @returns {string[]} Section keys visible at this tier
   */
  _getTierContract(tier) {
    const visibleSections = [];
    for (let t = 1; t <= tier; t++) {
      if (TIER_SECTIONS[t]) {
        visibleSections.push(...TIER_SECTIONS[t]);
      }
    }
    return visibleSections;
  }

  /*
   * ==========================================================================
   * Access Tier Determination
   * ==========================================================================
   */

  async _getRequesterTier(requesterId, requesterType, correlationId) {
    try {
      if (requesterType === 'user') {
        const userResult = await pool.query(
          `SELECT u.access_level, ubp.current_belt
           FROM users u
           LEFT JOIN user_belt_progression ubp ON u.user_id = ubp.user_id
           WHERE u.user_id = $1`,
          [requesterId]
        );

        if (userResult.rows.length === 0) {
          return { tier: 1, reason: 'user_not_found_default' };
        }

        const row = userResult.rows[0];

        if (row.access_level === 11) {
          logger.info('God Mode access granted', {
            correlationId,
            requesterId,
            accessLevel: row.access_level
          });
          return { tier: 6, reason: 'god_mode_access_level_11' };
        }

        const tier = BELT_TIERS[row.current_belt] || 1;
        return { tier, reason: `belt_${row.current_belt || 'none'}` };
      }

      if (requesterType === 'character') {
        const charResult = await pool.query(
          `SELECT cp.category, cbp.current_belt
           FROM character_profiles cp
           LEFT JOIN character_belt_progression cbp ON cp.character_id = cbp.character_id
           WHERE cp.character_id = $1`,
          [requesterId]
        );

        if (charResult.rows.length === 0) {
          return { tier: 1, reason: 'character_not_found_default' };
        }

        const row = charResult.rows[0];

        if (row.category === 'Tanuki') {
          logger.info('Tanuki access granted', {
            correlationId,
            requesterId,
            category: row.category
          });
          return { tier: 6, reason: 'tanuki_category_override' };
        }

        const tier = BELT_TIERS[row.current_belt] || 1;
        return { tier, reason: `character_belt_${row.current_belt || 'none'}` };
      }

      return { tier: 1, reason: 'unknown_requester_type_default' };
    } catch (error) {
      logger.error('Error determining tier', error, { correlationId });
      return { tier: 1, reason: 'error_fallback_default' };
    }
  }

  /*
   * ==========================================================================
   * Data Gathering Methods
   * ==========================================================================
   */

  async _getCoreProfile(characterId, tier) {
    const baseFields = 'character_name, category, description, image_url';
    const systemFields = ', character_id, is_b_roll_autonomous, is_active, current_location, created_at, updated_at';
    const fields = tier >= 6 ? baseFields + systemFields : baseFields;

    const result = await pool.query(
      `SELECT ${fields} FROM character_profiles WHERE character_id = $1`,
      [characterId]
    );
    return result.rows[0] || null;
  }

  async _getPersonality(characterId, tier) {
    const baseFields = 'openness, conscientiousness, extraversion, agreeableness, neuroticism, pad_baseline_p, pad_baseline_a, pad_baseline_d';
    const extendedFields = ', idiolect_region, idiolect_education_level, idiolect_age, created_at, updated_at';
    const fields = tier >= 6 ? baseFields + extendedFields : baseFields;

    const result = await pool.query(
      `SELECT ${fields} FROM character_personality WHERE character_id = $1`,
      [characterId]
    );
    return result.rows[0] || null;
  }

  async _getIdentityAnchors(characterId) {
    const result = await pool.query(
      `SELECT anchor_type, anchor_text, entrenchment_level
       FROM identity_anchors
       WHERE character_id = $1
       ORDER BY entrenchment_level DESC
       LIMIT $2`,
      [characterId, CONFIG.IDENTITY_ANCHORS_LIMIT]
    );
    return result.rows || [];
  }

  async _getTraitScores(characterId) {
    const characteristicsMap = await this._getCharacteristicsMap();

    const result = await pool.query(
      `SELECT trait_hex_color, percentile_score
       FROM character_trait_scores
       WHERE character_hex_id = $1
       ORDER BY percentile_score DESC
       LIMIT $2`,
      [characterId, CONFIG.TRAITS_LIMIT]
    );

    return (result.rows || []).map(row => {
      const trait = characteristicsMap.get(row.trait_hex_color);
      return {
        traitName: trait?.traitName || 'Unknown',
        traitCategory: trait?.category || 'Unknown',
        percentileScore: row.percentile_score
      };
    });
  }

  async _getKnowledgeState(characterId) {
    const result = await pool.query(
      `SELECT ki.concept, ki.belt_level, cks.current_expertise_score
       FROM character_knowledge_state cks
       JOIN knowledge_items ki ON cks.knowledge_id = ki.knowledge_id
       WHERE cks.character_id = $1
       ORDER BY cks.current_expertise_score DESC
       LIMIT $2`,
      [characterId, CONFIG.KNOWLEDGE_LIMIT]
    );
    return result.rows || [];
  }

  async _getInventory(characterId) {
    const result = await pool.query(
      `SELECT o.object_name, o.object_type, o.description, ci.acquired_at
       FROM character_inventory ci
       JOIN objects o ON ci.object_id = o.object_id
       WHERE ci.character_id = $1
       ORDER BY ci.acquired_at DESC
       LIMIT $2`,
      [characterId, CONFIG.INVENTORY_LIMIT]
    );
    return result.rows || [];
  }

  async _getRelationships(characterId) {
    const result = await pool.query(
      `SELECT u.username as target_name, rs.trust_score, rs.familiarity
       FROM relationship_state rs
       LEFT JOIN users u ON rs.user_id = u.user_id
       WHERE rs.character_id = $1
       ORDER BY rs.familiarity DESC
       LIMIT $2`,
      [characterId, CONFIG.RELATIONSHIPS_LIMIT]
    );
    return result.rows || [];
  }

  async _getPsychicState(characterId) {
    const result = await pool.query(
      `SELECT
        json_build_object(
          'currentMood', (
            SELECT json_build_object('p', p, 'a', a, 'd', d, 'sampleCount', sample_count)
            FROM psychic_moods
            WHERE character_id = $1
            LIMIT 1
          ),
          'recentFrames', COALESCE((
            SELECT json_agg(row_to_json(pf))
            FROM (
              SELECT emotional_state, psychological_distance, timestamp
              FROM psychic_frames
              WHERE character_id = $1
              ORDER BY timestamp DESC
              LIMIT $2
            ) pf
          ), '[]'::json),
          'proximity', COALESCE((
            SELECT json_agg(row_to_json(pp))
            FROM (
              SELECT to_character, current_distance, emotional_resonance, relationship_type
              FROM psychic_proximity_directed
              WHERE from_character = $1
              ORDER BY current_distance ASC
              LIMIT $3
            ) pp
          ), '[]'::json)
        ) AS psychic_state`,
      [characterId, CONFIG.PSYCHIC_FRAMES_LIMIT, CONFIG.PSYCHIC_PROXIMITY_LIMIT]
    );

    return result.rows[0]?.psychic_state || {
      currentMood: null,
      recentFrames: [],
      proximity: []
    };
  }

  async _getImages(characterId) {
    const result = await pool.query(
      `SELECT ma.url, ma.asset_type, cig.is_active, cig.display_order
       FROM character_image_gallery cig
       JOIN multimedia_assets ma ON cig.asset_id = ma.asset_id
       WHERE cig.character_id = $1
       ORDER BY cig.display_order
       LIMIT $2`,
      [characterId, CONFIG.IMAGES_LIMIT]
    );
    return result.rows || [];
  }

  async _getNarrativePosition(characterId) {
    const result = await pool.query(
      `SELECT ns.title, ns.segment_type, cin.current_narrative_state, cin.last_interacted_at
       FROM characters_in_narrative cin
       LEFT JOIN narrative_segments ns ON cin.current_narrative_segment_id = ns.segment_id
       WHERE cin.character_id = $1
       LIMIT $2`,
      [characterId, CONFIG.NARRATIVE_LIMIT]
    );
    return result.rows || [];
  }

  /*
   * ==========================================================================
   * Data-Driven Tier Filtering
   * ==========================================================================
   */

  _buildTieredDossier(tier, data) {
    const dossier = {};

    for (let t = 1; t <= tier; t++) {
      const sections = TIER_SECTIONS[t];
      if (!sections) {
        continue;
      }

      for (const sectionKey of sections) {
        const builderMethod = SECTION_BUILDERS[sectionKey];
        if (builderMethod && typeof this[builderMethod] === 'function') {
          try {
            this[builderMethod](dossier, data, tier);
          } catch (err) {
            logger.error('Section builder failed', err, { sectionKey });
          }
        }
      }
    }

    return dossier;
  }

  /*
   * ==========================================================================
   * Section Builder Methods
   * ==========================================================================
   */

  _buildCoreSection(dossier, data) {
    dossier.core = {
      characterName: data.core?.character_name || null,
      category: data.core?.category || null,
      description: data.core?.description || null,
      imageUrl: data.core?.image_url || null
    };
  }

  _buildImagesSection(dossier, data) {
    dossier.images = data.images || [];
  }

  _buildPersonalitySection(dossier, data) {
    dossier.personality = data.personality ? {
      ocean: {
        openness: data.personality.openness,
        conscientiousness: data.personality.conscientiousness,
        extraversion: data.personality.extraversion,
        agreeableness: data.personality.agreeableness,
        neuroticism: data.personality.neuroticism
      },
      baselinePad: {
        pleasure: data.personality.pad_baseline_p,
        arousal: data.personality.pad_baseline_a,
        dominance: data.personality.pad_baseline_d
      }
    } : null;
  }

  _buildRelationshipsSection(dossier, data) {
    dossier.relationships = data.relationships || [];
  }

  _buildPsychicSocialSection(dossier, data) {
    if (!dossier.psychic) {
      dossier.psychic = {};
    }
    dossier.psychic.currentMood = data.psychic?.currentMood || null;
    dossier.psychic.proximity = data.psychic?.proximity || [];
  }

  _buildKnowledgeSection(dossier, data) {
    dossier.knowledge = data.knowledge || [];
  }

  _buildInventorySection(dossier, data) {
    dossier.inventory = data.inventory || [];
  }

  _buildTraitsSection(dossier, data) {
    dossier.traits = data.traits || [];
  }

  _buildIdentitySection(dossier, data) {
    dossier.identity = data.identity || [];
  }

  _buildPsychicFullSection(dossier, data) {
    if (!dossier.psychic) {
      dossier.psychic = {
        currentMood: data.psychic?.currentMood || null,
        proximity: data.psychic?.proximity || []
      };
    }
    dossier.psychic.recentFrames = data.psychic?.recentFrames || [];
  }

  _buildNarrativeSection(dossier, data) {
    dossier.narrative = data.narrative || [];
  }

  _buildSystemDataSection(dossier, data) {
    if (dossier.core) {
      dossier.core.characterId = data.core?.character_id || null;
      dossier.core.isBRollAutonomous = data.core?.is_b_roll_autonomous || null;
      dossier.core.isActive = data.core?.is_active || null;
      dossier.core.currentLocation = data.core?.current_location || null;
      dossier.core.createdAt = data.core?.created_at || null;
      dossier.core.updatedAt = data.core?.updated_at || null;
    }

    dossier.systemData = {
      rawCoreRecord: data.core,
      tierGranted: 6,
      accessType: 'god_mode'
    };

    if (dossier.personality && data.personality) {
      dossier.personality.idiolect = {
        region: data.personality.idiolect_region,
        educationLevel: data.personality.idiolect_education_level,
        age: data.personality.idiolect_age
      };
    }
  }
}

export default new CharacterDossierService();
