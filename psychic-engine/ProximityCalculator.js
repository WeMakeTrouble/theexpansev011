/**
 * ===========================================================================
 * PROXIMITY CALCULATOR — Core Service for Psychic Proximity System
 * ===========================================================================
 *
 * PURPOSE:
 * ---------------------------------------------------------------------------
 * This is the central service that calculates, creates, updates, and
 * maintains all psychic proximity relationships between characters in
 * The Expanse. It is the single authority for proximity mutations.
 *
 * No other file should directly INSERT, UPDATE, or DELETE rows in
 * psychic_proximity_directed, trait_similarity_cache, or proximity_events.
 * All proximity changes flow through this service.
 *
 * VERSION: v010
 * CREATED: February 12, 2026
 * AUTHORITY: James (Project Manager)
 *
 * ===========================================================================
 * WHAT THIS SERVICE DOES
 * ===========================================================================
 *
 * 1. TRAIT SIMILARITY CALCULATION
 *    Computes category-weighted cosine similarity between character trait
 *    vectors. Uses 277 personality traits across 5 categories (Emotional,
 *    Social, Cognitive, Behavioral, Specialized). Inventory, Knowledge,
 *    and Blank Slot categories are excluded — they are structural, not
 *    personality.
 *
 *    Source: Byrne (1971) similarity-attraction paradigm.
 *    Source: McCrae & Costa (1987) FFM personality dimensions.
 *    Weights: Emotional 0.35, Social 0.25, Cognitive 0.20,
 *             Behavioral 0.15, Specialized 0.05.
 *
 * 2. PROXIMITY ROW CREATION (K-NEAREST NEIGHBOURS)
 *    For each character, creates directed proximity rows to their K
 *    most similar characters (K=20). Uses bounded confidence threshold
 *    (0.3) to exclude very dissimilar pairs.
 *
 *    Source: Deffuant et al. (2000) bounded confidence model.
 *    Source: Lorenz (2007) scaling analysis.
 *
 * 3. ACTION DELTA APPLICATION
 *    When an action occurs between characters (help, betray, attack,
 *    etc.), looks up the base delta from proximity_action_deltas,
 *    applies relationship type multipliers from proximity_type_config,
 *    applies trait modifiers, and updates the distance.
 *
 *    Source: RimWorld action-to-opinion delta system.
 *    Source: Crusader Kings 3 relationship type multipliers.
 *    Source: Lloyd et al. (2023) proximity amplifies impression.
 *
 * 4. BURT DECAY
 *    Regresses current_distance toward baseline_distance using
 *    exponential decay: d(t) = baseline + (current - baseline) * e^(-λt)
 *    Accelerated decay after 30 days (1.5x) and 90 days (2.0x).
 *
 *    Source: Burt (2000) decay functions.
 *    Source: Burt (2002) bridge decay.
 *
 * 5. EMPATHIC FATIGUE
 *    Calculates fatigue from proximity_events within a 72-hour window.
 *    High-intensity interactions accumulate fatigue, recovery is 5%/hour.
 *    Characters with many close connections have additional baseline
 *    fatigue (3% per connection above 3, capped at 30%).
 *
 *    Source: Figley (1995) compassion fatigue.
 *    Source: Pines & Aronson (1988) career burnout.
 *
 * 6. CATEGORY GOVERNANCE
 *    Reads CATEGORY_GOVERNANCE matrix to determine whether each pair
 *    uses calculated (trait-based), hybrid, or narrative-forced proximity.
 *
 *    Source: Kimi AI research analysis.
 *    Source: Neal et al. (2022) asymmetric perception.
 *
 * 7. RESONANCE-WEIGHTED CONTAGION SUPPORT
 *    Provides axis-specific resonance data for engine.js contagion.
 *    Negative resonance inverts P-axis (schadenfreude), mirrors A-axis,
 *    partially inverts D-axis (0.5x).
 *
 *    Source: Cikara et al. (2014) counter-empathic responses.
 *    Source: Smith et al. (1996) envy and schadenfreude.
 *
 * ===========================================================================
 * WHAT THIS SERVICE DOES NOT DO
 * ===========================================================================
 *
 * - Does NOT run emotional contagion (engine.js handles that)
 * - Does NOT generate psychic frames (engine.js handles that)
 * - Does NOT manage PAD coordinates (padEstimator / engine.js)
 * - Does NOT touch FSRS learning data (mathematically pure, separate)
 * - Does NOT use external AI APIs (all calculations in-house)
 * - Does NOT hardcode character IDs (fully agnostic)
 *
 * ===========================================================================
 * DATABASE TABLES CONSUMED
 * ===========================================================================
 *
 * READ:
 *   character_profiles        — character_id, category
 *   character_trait_scores    — character_hex_id, trait_hex_color, percentile_score
 *   characteristics           — hex_color, category
 *   proximity_type_config     — relationship type defaults
 *   proximity_action_deltas   — action base deltas and trait modifiers
 *
 * READ/WRITE:
 *   psychic_proximity_directed — proximity relationships (directed)
 *   trait_similarity_cache     — pre-calculated similarity scores
 *   proximity_events           — audit log of all proximity changes
 *
 * ===========================================================================
 * FILE STANDARDS (v010):
 * ---------------------------------------------------------------------------
 * - Structured logger via createModuleLogger (no console.log)
 * - All constants imported from proximityConstants.js
 * - Input validation on all public methods
 * - Defensive error handling (try/catch per operation)
 * - Transaction discipline for multi-table mutations
 * - Hex IDs via generateHexId() only
 * - PascalCase class name, camelCase methods
 * - UPPER_SNAKE_CASE for imported frozen constants
 * - ON DELETE CASCADE handles character removal cleanup
 *
 * ===========================================================================
 */

import pool from '../backend/db/pool.js';
import generateHexId from '../backend/utils/hexIdGenerator.js';
import { createModuleLogger } from '../backend/utils/logger.js';
import {
  CATEGORY_GOVERNANCE,
  CONTAGION_CONFIG,
  DECAY_CONFIG,
  SCALING_CONFIG,
  TRAIT_CATEGORY_WEIGHTS,
  RESONANCE_CONFIG,
  FATIGUE_CONFIG,
  TICK_CONFIG,
  validateProximityConstants
} from './proximityConstants.js';

const logger = createModuleLogger('ProximityCalculator');

// ===========================================================================
// Excluded trait categories (structural, not personality)
// ===========================================================================

const EXCLUDED_CATEGORIES = Object.freeze(['Inventory', 'Knowledge', 'Blank Slot']);

// ===========================================================================
// ProximityCalculator Class
// ===========================================================================

class ProximityCalculator {

  constructor() {
    this._validated = false;
  }

  // =========================================================================
  // Initialisation
  // =========================================================================

  /**
   * Validates constants and prepares the calculator for use.
   * Call once at startup before any other method.
   * @returns {boolean} true if validation passed
   */
  async initialise() {
    try {
      validateProximityConstants();
      this._validated = true;
      logger.info('ProximityCalculator initialised, constants validated');
      return true;
    } catch (error) {
      logger.error('ProximityCalculator initialisation failed', error);
      throw error;
    }
  }

  /**
   * Guard method — throws if initialise() was not called.
   * @private
   */
  _ensureInitialised() {
    if (!this._validated) {
      throw new Error('ProximityCalculator not initialised. Call initialise() first.');
    }
  }

  // =========================================================================
  // 1. TRAIT SIMILARITY CALCULATION
  // =========================================================================
  //
  // Computes category-weighted cosine similarity between two characters.
  //
  // Formula per category:
  //   cosine_sim = dot(A, B) / (||A|| * ||B||)
  //
  // Overall similarity:
  //   weighted_sim = sum(category_weight * category_cosine_sim)
  //
  // Source: Byrne (1971), McCrae & Costa (1987)
  // =========================================================================

  /**
   * Loads trait vectors for a character, grouped by category.
   * Returns { category: [{ traitHex, score }] }
   * @param {string} characterId — hex ID from character_profiles
   * @returns {Promise<Object>} trait vectors grouped by category
   * @private
   */
  async _loadTraitVector(characterId) {
    const result = await pool.query(`
      SELECT cts.trait_hex_color, cts.percentile_score, c.category
      FROM character_trait_scores cts
      JOIN characteristics c ON c.hex_color = cts.trait_hex_color
      WHERE cts.character_hex_id = $1
        AND c.category NOT IN ('Inventory', 'Knowledge', 'Blank Slot')
      ORDER BY c.category, cts.trait_hex_color
    `, [characterId]);

    const vector = {};
    for (const row of result.rows) {
      if (!vector[row.category]) {
        vector[row.category] = [];
      }
      vector[row.category].push({
        traitHex: row.trait_hex_color,
        score: parseFloat(row.percentile_score)
      });
    }
    return vector;
  }

  /**
   * Computes cosine similarity between two score arrays.
   * Both arrays must be aligned by trait (same order, same traits).
   * Returns value in range [-1, 1].
   * @param {number[]} vecA — scores for character A
   * @param {number[]} vecB — scores for character B
   * @returns {number} cosine similarity
   * @private
   */
  _cosineSimilarity(vecA, vecB) {
    if (vecA.length === 0 || vecB.length === 0) return 0;
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      magnitudeA += vecA[i] * vecA[i];
      magnitudeB += vecB[i] * vecB[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);

    if (magnitudeA === 0 || magnitudeB === 0) return 0;

    return dotProduct / (magnitudeA * magnitudeB);
  }

  /**
   * Computes the category-weighted cosine similarity between two characters.
   *
   * For each category (Emotional, Social, Cognitive, Behavioral, Specialized):
   *   1. Extract aligned score arrays for both characters
   *   2. Compute cosine similarity
   *   3. Multiply by category weight from TRAIT_CATEGORY_WEIGHTS
   *
   * Returns the weighted sum as overall similarity [-1, 1].
   *
   * @param {string} characterA — hex ID
   * @param {string} characterB — hex ID
   * @returns {Promise<{similarity: number, breakdown: Object}>}
   */
  async calculateSimilarity(characterA, characterB) {
    this._ensureInitialised();

    if (!characterA || !characterB) {
      throw new Error('calculateSimilarity requires two character hex IDs');
    }
    if (characterA === characterB) {
      return { similarity: 1.0, breakdown: {} };
    }

    const vectorA = await this._loadTraitVector(characterA);
    const vectorB = await this._loadTraitVector(characterB);

    let weightedSum = 0;
    const breakdown = {};

    for (const [category, weight] of Object.entries(TRAIT_CATEGORY_WEIGHTS)) {
      if (category === 'VERSION') continue;

      const traitsA = vectorA[category] || [];
      const traitsB = vectorB[category] || [];

      // Align vectors by trait hex — only include traits both characters have
      const traitMapB = new Map(traitsB.map(t => [t.traitHex, t.score]));
      const alignedA = [];
      const alignedB = [];

      for (const traitA of traitsA) {
        if (traitMapB.has(traitA.traitHex)) {
          alignedA.push(traitA.score);
          alignedB.push(traitMapB.get(traitA.traitHex));
        }
      }

      const categorySimilarity = this._cosineSimilarity(alignedA, alignedB);
      const weightedContribution = categorySimilarity * weight;
      weightedSum += weightedContribution;

      breakdown[category] = {
        similarity: parseFloat(categorySimilarity.toFixed(4)),
        weight,
        contribution: parseFloat(weightedContribution.toFixed(4)),
        traitCount: alignedA.length
      };
    }

    return {
      similarity: parseFloat(weightedSum.toFixed(4)),
      breakdown
    };
  }

  // =========================================================================
  // 2. TRAIT SIMILARITY CACHE
  // =========================================================================
  //
  // Pre-calculates and caches similarity scores for all character pairs.
  // Refreshed when traits change (is_stale flag).
  //
  // Source: Deffuant et al. (2000) bounded confidence — only pairs above
  // threshold get proximity rows.
  // =========================================================================

  /**
   * Refreshes the entire trait similarity cache.
   * Calculates similarity for all character pairs and upserts into cache.
   * @returns {Promise<{pairs: number, duration: number}>}
   */
  async refreshSimilarityCache() {
    this._ensureInitialised();
    const startTime = Date.now();

    const characters = await pool.query(`
      SELECT character_id FROM character_profiles ORDER BY character_id
    `);

    const characterIds = characters.rows.map(r => r.character_id);
    let pairsCalculated = 0;

    for (let i = 0; i < characterIds.length; i++) {
      for (let j = i + 1; j < characterIds.length; j++) {
        const charA = characterIds[i];
        const charB = characterIds[j];

        try {
          const result = await this.calculateSimilarity(charA, charB);

          await pool.query(`
            INSERT INTO trait_similarity_cache
              (character_a, character_b, similarity_score, is_stale, calculated_at)
            VALUES ($1, $2, $3, false, NOW())
            ON CONFLICT (character_a, character_b)
            DO UPDATE SET
              similarity_score = $3,
              is_stale = false,
              calculated_at = NOW()
          `, [charA, charB, result.similarity]);

          pairsCalculated++;
        } catch (error) {
          logger.warn('Similarity calculation failed for pair', {
            characterA: charA,
            characterB: charB,
            error: error.message
          });
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info('Similarity cache refreshed', {
      pairs: pairsCalculated,
      characters: characterIds.length,
      durationMs: duration
    });

    return { pairs: pairsCalculated, duration };
  }

  /**
   * Marks all cache entries involving a character as stale.
   * Called when a character's traits are updated.
   * @param {string} characterId — hex ID of changed character
   * @returns {Promise<number>} count of rows marked stale
   */
  async markStale(characterId) {
    this._ensureInitialised();

    const result = await pool.query(`
      UPDATE trait_similarity_cache
      SET is_stale = true
      WHERE character_a = $1 OR character_b = $1
    `, [characterId]);

    logger.info('Similarity cache marked stale', {
      characterId,
      rowsAffected: result.rowCount
    });

    return result.rowCount;
  }

  // =========================================================================
  // 3. PROXIMITY ROW CREATION (K-NEAREST NEIGHBOURS)
  // =========================================================================
  //
  // For each character, creates directed proximity rows to their K most
  // similar characters. Uses bounded confidence threshold to exclude
  // very dissimilar pairs.
  //
  // Governance check: CATEGORY_GOVERNANCE determines whether each pair
  // uses 'calc', 'hybrid', or 'narrative' mode.
  //
  // Source: Deffuant et al. (2000), Neal et al. (2022)
  // =========================================================================

  /**
   * Determines governance mode for a character pair based on categories.
   * @param {string} categoryA — category of character A
   * @param {string} categoryB — category of character B
   * @returns {string} 'calc', 'hybrid', or 'narrative'
   * @private
   */
  _getGovernanceMode(categoryA, categoryB) {
    const govA = CATEGORY_GOVERNANCE[categoryA];
    if (!govA) return 'calc';

    if (govA.with[categoryB]) {
      return govA.with[categoryB];
    }

    return govA.default;
  }

  /**
   * Converts similarity score to baseline distance.
   * Higher similarity = lower distance.
   * Formula: baseline = 1 - similarity (clamped to [0.05, 0.95])
   * @param {number} similarity — cosine similarity [-1, 1]
   * @returns {number} baseline distance [0.05, 0.95]
   * @private
   */
  _similarityToBaseline(similarity) {
    const raw = 1 - similarity;
    return Math.max(0.05, Math.min(0.95, raw));
  }

  /**
   * Builds proximity rows for all characters using K-nearest neighbours.
   * Reads from trait_similarity_cache (must be populated first).
   *
   * For each character:
   *   1. Get top K most similar characters above threshold
   *   2. Check governance mode for each pair
   *   3. Create directed proximity rows (A→B and B→A)
   *   4. Set baseline from similarity, defaults from proximity_type_config
   *
   * @returns {Promise<{created: number, skippedNarrative: number}>}
   */
  async buildProximityRows() {
    this._ensureInitialised();

    const characters = await pool.query(`
      SELECT character_id, category FROM character_profiles ORDER BY character_id
    `);

    const categoryMap = new Map(
      characters.rows.map(r => [r.character_id, r.category])
    );

    // Load type config defaults
    const typeConfigResult = await pool.query(
      'SELECT * FROM proximity_type_config'
    );
    const typeDefaults = new Map(
      typeConfigResult.rows.map(r => [r.relationship_type, r])
    );

    let created = 0;
    let skippedNarrative = 0;

    for (const charRow of characters.rows) {
      const charId = charRow.character_id;
      const charCategory = charRow.category;

      // Get K-nearest from cache (both directions since cache is symmetric)
      const neighbours = await pool.query(`
        SELECT
          CASE WHEN character_a = $1 THEN character_b ELSE character_a END AS neighbour_id,
          similarity_score
        FROM trait_similarity_cache
        WHERE (character_a = $1 OR character_b = $1)
          AND similarity_score >= $2
          AND is_stale = false
        ORDER BY similarity_score DESC
        LIMIT $3
      `, [charId, SCALING_CONFIG.BOUNDED_CONFIDENCE_THRESHOLD, SCALING_CONFIG.K_NEAREST]);

      for (const neighbour of neighbours.rows) {
        const neighbourId = neighbour.neighbour_id;
        const similarity = parseFloat(neighbour.similarity_score);
        const neighbourCategory = categoryMap.get(neighbourId);

        if (!neighbourCategory) continue;

        // Check governance
        const governance = this._getGovernanceMode(charCategory, neighbourCategory);

        if (governance === 'narrative') {
          skippedNarrative++;
          continue;
        }

        // Calculate baseline from similarity
        const baseline = this._similarityToBaseline(similarity);

        // Determine initial relationship type from distance
        const relationshipType = this._distanceToType(baseline);
        const typeConfig = typeDefaults.get(relationshipType);

        const regressionRate = typeConfig ? typeConfig.regression_rate : 0.04;
        const defaultResonance = typeConfig ? typeConfig.default_resonance : 0.5;

        // Check if row already exists
        const existing = await pool.query(`
          SELECT proximity_id FROM psychic_proximity_directed
          WHERE from_character = $1 AND to_character = $2
        `, [charId, neighbourId]);

        if (existing.rows.length > 0) continue;

        // Generate hex ID and create directed row
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const proximityId = await generateHexId('psychic_proximity_id');

          await client.query(`
            INSERT INTO psychic_proximity_directed (
              proximity_id, from_character, to_character,
              current_distance, baseline_distance,
              emotional_resonance, regression_rate,
              relationship_type, is_narrative_override
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
          `, [
            proximityId, charId, neighbourId,
            baseline, baseline,
            defaultResonance, regressionRate,
            relationshipType
          ]);

          await client.query('COMMIT');
          created++;
        } catch (error) {
          await client.query('ROLLBACK');
          logger.warn('Failed to create proximity row', {
            from: charId,
            to: neighbourId,
            error: error.message
          });
        } finally {
          client.release();
        }
      }
    }

    logger.info('Proximity rows built', {
      created,
      skippedNarrative,
      characters: characters.rows.length
    });

    return { created, skippedNarrative };
  }

  /**
   * Maps a distance value to a relationship type.
   * Uses proximity_type_config default_baseline ranges.
   * @param {number} distance — current or baseline distance
   * @returns {string} relationship type
   * @private
   */
  _distanceToType(distance) {
    if (distance <= 0.12) return 'bound';
    if (distance <= 0.17) return 'council';
    if (distance <= 0.26) return 'protagonist';
    if (distance <= 0.39) return 'ally';
    if (distance <= 0.50) return 'chaotic';
    if (distance <= 0.65) return 'neutral';
    if (distance <= 0.82) return 'hostile';
    return 'antagonist';
  }

  // =========================================================================
  // 4. ACTION DELTA APPLICATION
  // =========================================================================
  //
  // When an action occurs between characters, this method:
  //   1. Looks up base delta from proximity_action_deltas
  //   2. Looks up relationship type multipliers from proximity_type_config
  //   3. Applies trait modifiers
  //   4. Updates current_distance (clamped to [min_distance, max_distance])
  //   5. Logs the event to proximity_events
  //
  // Source: RimWorld, CK3, Lloyd et al. (2023)
  // =========================================================================

  /**
   * Applies an action between two characters, updating their proximity.
   *
   * @param {Object} params
   * @param {string} params.fromCharacter — character performing the action
   * @param {string} params.toCharacter — character receiving the action
   * @param {string} params.actionType — action type (must exist in proximity_action_deltas)
   * @param {string} [params.correlationId] — optional correlation ID for tracing
   * @param {Object} [params.narrativeContext] — optional narrative metadata
   * @returns {Promise<{previousDistance: number, newDistance: number, delta: number}>}
   */
  async applyAction({ fromCharacter, toCharacter, actionType, correlationId, narrativeContext }) {
    this._ensureInitialised();

    if (!fromCharacter || !toCharacter || !actionType) {
      throw new Error('applyAction requires fromCharacter, toCharacter, and actionType');
    }

    // Load action delta
    const actionResult = await pool.query(
      'SELECT base_delta, trait_modifiers FROM proximity_action_deltas WHERE action_type = $1',
      [actionType]
    );

    if (actionResult.rows.length === 0) {
      throw new Error(`Unknown action type: ${actionType}`);
    }

    const baseDelta = parseFloat(actionResult.rows[0].base_delta);
    const traitModifiers = actionResult.rows[0].trait_modifiers || {};

    // Load current proximity
    const proximityResult = await pool.query(`
      SELECT proximity_id, current_distance, baseline_distance,
             relationship_type, is_narrative_override
      FROM psychic_proximity_directed
      WHERE from_character = $1 AND to_character = $2
    `, [fromCharacter, toCharacter]);

    if (proximityResult.rows.length === 0) {
      throw new Error(`No proximity row for ${fromCharacter} → ${toCharacter}`);
    }

    const proximity = proximityResult.rows[0];

    if (proximity.is_narrative_override) {
      logger.info('Action skipped — narrative override active', {
        fromCharacter, toCharacter, actionType
      });
      return {
        previousDistance: parseFloat(proximity.current_distance),
        newDistance: parseFloat(proximity.current_distance),
        delta: 0
      };
    }

    // Load relationship type config
    const typeResult = await pool.query(
      'SELECT * FROM proximity_type_config WHERE relationship_type = $1',
      [proximity.relationship_type]
    );

    let typeMultiplier = 1.0;
    let minDistance = 0.1;
    let maxDistance = 0.95;

    if (typeResult.rows.length > 0) {
      const typeConfig = typeResult.rows[0];
      minDistance = parseFloat(typeConfig.min_distance);
      maxDistance = parseFloat(typeConfig.max_distance);

      // Apply relationship-specific multiplier
      if (baseDelta > 0) {
        typeMultiplier = parseFloat(typeConfig.betrayal_multiplier);
      } else {
        typeMultiplier = parseFloat(typeConfig.help_multiplier);
      }
    }

    // Apply trait modifiers
    let traitDeltaAdjustment = 0;
    if (Object.keys(traitModifiers).length > 0) {
      traitDeltaAdjustment = await this._calculateTraitModifiers(
        toCharacter, traitModifiers
      );
    }

    // Calculate final delta
    const finalDelta = (baseDelta * typeMultiplier) + traitDeltaAdjustment;
    const previousDistance = parseFloat(proximity.current_distance);
    const newDistance = Math.max(minDistance, Math.min(maxDistance, previousDistance + finalDelta));

    // Update proximity and log event
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        UPDATE psychic_proximity_directed
        SET current_distance = $1, last_interaction = NOW()
        WHERE proximity_id = $2
      `, [newDistance, proximity.proximity_id]);

      const eventId = await generateHexId('psychic_event_id');

      await client.query(`
        INSERT INTO proximity_events (
          event_id, proximity_id, event_type, action_type,
          delta_distance, previous_distance, new_distance,
          performed_by, trait_modifiers, narrative_context,
          correlation_id
        ) VALUES ($1, $2, 'action', $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        eventId, proximity.proximity_id,
        actionType, finalDelta, previousDistance, newDistance,
        fromCharacter,
        JSON.stringify({ baseDelta, typeMultiplier, traitDeltaAdjustment }),
        narrativeContext ? JSON.stringify(narrativeContext) : null,
        correlationId
      ]);

      await client.query('COMMIT');

      logger.info('Action applied', {
        fromCharacter, toCharacter, actionType,
        previousDistance: previousDistance.toFixed(4),
        newDistance: newDistance.toFixed(4),
        delta: finalDelta.toFixed(4),
        correlationId
      });

      return { previousDistance, newDistance, delta: finalDelta };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to apply action', error, {
        fromCharacter, toCharacter, actionType
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Calculates trait modifier adjustments for a character.
   * Reads the character's traits and checks against modifier keys.
   *
   * Modifier keys follow the pattern "high_<trait_name>" or "low_<trait_name>".
   * "high" triggers when trait score > 70, "low" when < 30.
   *
   * Source: Fincham & Beach (2019) resentment, Emmons (2003) gratitude,
   *         Gross (1998) emotion regulation.
   *
   * @param {string} characterId — hex ID
   * @param {Object} modifiers — { "high_gratitude": -0.05, ... }
   * @returns {Promise<number>} total adjustment
   * @private
   */
  async _calculateTraitModifiers(characterId, modifiers) {
    let totalAdjustment = 0;

    for (const [modifierKey, adjustmentValue] of Object.entries(modifiers)) {
      const parts = modifierKey.split('_');
      const threshold = parts[0];
      const traitName = parts.slice(1).join('_');

      // Look up trait by name
      const traitResult = await pool.query(`
        SELECT cts.percentile_score
        FROM character_trait_scores cts
        JOIN characteristics c ON c.hex_color = cts.trait_hex_color
        WHERE cts.character_hex_id = $1
          AND LOWER(c.trait_name) = LOWER($2)
      `, [characterId, traitName]);

      if (traitResult.rows.length === 0) continue;

      const score = parseFloat(traitResult.rows[0].percentile_score);

      if (threshold === 'high' && score > 70) {
        totalAdjustment += adjustmentValue;
      } else if (threshold === 'low' && score < 30) {
        totalAdjustment += adjustmentValue;
      }
    }

    return totalAdjustment;
  }

  // =========================================================================
  // 5. BURT DECAY
  // =========================================================================
  //
  // Regresses current_distance toward baseline_distance for all
  // non-narrative-override proximity rows.
  //
  // Formula: d(t) = baseline + (current - baseline) * exp(-lambda * dt)
  // where dt = hours since last_decay_calculation
  //
  // Accelerated decay after 30 days (1.5x lambda) and 90 days (2.0x).
  //
  // Source: Burt (2000, 2002)
  // =========================================================================

  /**
   * Runs decay on all non-narrative proximity rows.
   * Updates current_distance toward baseline and logs events.
   *
   * @returns {Promise<{processed: number, updated: number, skipped: number}>}
   */
  async runDecay() {
    this._ensureInitialised();

    const rows = await pool.query(`
      SELECT proximity_id, from_character, to_character,
             current_distance, baseline_distance,
             regression_rate, last_interaction, last_decay_calculation
      FROM psychic_proximity_directed
      WHERE is_narrative_override = false
      ORDER BY proximity_id
    `);

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    const now = new Date();

    for (const row of rows.rows) {
      processed++;

      const currentDistance = parseFloat(row.current_distance);
      const baseline = parseFloat(row.baseline_distance);
      const lambda = parseFloat(row.regression_rate);
      const lastDecay = new Date(row.last_decay_calculation);
      const lastInteraction = new Date(row.last_interaction);

      // Calculate hours since last decay
      const dtHours = (now - lastDecay) / (1000 * 60 * 60);
      if (dtHours < 0.1) {
        skipped++;
        continue;
      }

      // Check for accelerated decay based on time since last interaction
      const daysSinceInteraction = (now - lastInteraction) / (1000 * 60 * 60 * 24);
      let effectiveLambda = lambda;

      for (const threshold of DECAY_CONFIG.ACCELERATION_THRESHOLDS) {
        if (daysSinceInteraction >= threshold.days) {
          effectiveLambda = lambda * threshold.multiplier;
          break;
        }
      }

      // Burt decay formula: d(t) = baseline + (current - baseline) * exp(-lambda * dt)
      const decayFactor = Math.exp(-effectiveLambda * dtHours);
      const newDistance = baseline + (currentDistance - baseline) * decayFactor;

      // Skip if change is negligible
      const delta = Math.abs(newDistance - currentDistance);
      if (delta < DECAY_CONFIG.MIN_DELTA_THRESHOLD) {
        skipped++;
        continue;
      }

      try {
        await pool.query(`
          UPDATE psychic_proximity_directed
          SET current_distance = $1, last_decay_calculation = NOW()
          WHERE proximity_id = $2
        `, [newDistance, row.proximity_id]);

        updated++;
      } catch (error) {
        logger.warn('Decay update failed', {
          proximityId: row.proximity_id,
          error: error.message
        });
      }
    }

    logger.info('Decay cycle complete', { processed, updated, skipped });
    return { processed, updated, skipped };
  }

  // =========================================================================
  // 6. EMPATHIC FATIGUE
  // =========================================================================
  //
  // Calculates current fatigue level for a character based on recent
  // high-intensity proximity events within the recovery window.
  //
  // Interaction fatigue: sum of intensity-weighted events minus recovery
  // Global fatigue: 3% per close connection above threshold, capped
  //
  // Source: Figley (1995), Pines & Aronson (1988)
  // =========================================================================

  /**
   * Calculates current empathic fatigue for a character.
   *
   * @param {string} characterId — hex ID
   * @returns {Promise<{interactionFatigue: number, globalFatigue: number, totalFatigue: number}>}
   */
  async calculateFatigue(characterId) {
    this._ensureInitialised();

    if (!characterId) {
      throw new Error('calculateFatigue requires a character hex ID');
    }

    const windowStart = new Date(
      Date.now() - FATIGUE_CONFIG.RECOVERY_WINDOW_HOURS * 60 * 60 * 1000
    );

    // Get recent events involving this character
    const events = await pool.query(`
      SELECT pe.delta_distance, pe.performed_at
      FROM proximity_events pe
      JOIN psychic_proximity_directed ppd ON ppd.proximity_id = pe.proximity_id
      WHERE (ppd.from_character = $1 OR ppd.to_character = $1)
        AND pe.performed_at >= $2
      ORDER BY pe.performed_at DESC
    `, [characterId, windowStart]);

    // Calculate interaction fatigue
    let interactionFatigue = 0;
    const now = new Date();

    for (const event of events.rows) {
      const absDelta = Math.abs(parseFloat(event.delta_distance || 0));
      const hoursSinceEvent = (now - new Date(event.performed_at)) / (1000 * 60 * 60);

      // Determine intensity tier
      let fatigueCost = 0;
      for (const tier of FATIGUE_CONFIG.INTENSITY_THRESHOLDS) {
        if (absDelta >= tier.minDelta) {
          fatigueCost = tier.fatigue;
          break;
        }
      }

      // Apply recovery: reduce fatigue cost by recovery rate per hour elapsed
      const recovered = hoursSinceEvent * FATIGUE_CONFIG.RECOVERY_RATE_PER_HOUR;
      const effectiveCost = Math.max(0, fatigueCost - recovered);

      interactionFatigue += effectiveCost;
    }

    interactionFatigue = Math.min(interactionFatigue, FATIGUE_CONFIG.MAX_FATIGUE);

    // Calculate global fatigue from close connections count
    const closeConnections = await pool.query(`
      SELECT COUNT(*) as count
      FROM psychic_proximity_directed
      WHERE from_character = $1
        AND current_distance < ${CONTAGION_CONFIG.PROXIMITY_THRESHOLD}
    `, [characterId]);

    const connectionCount = parseInt(closeConnections.rows[0].count);
    const excessConnections = Math.max(0, connectionCount - FATIGUE_CONFIG.GLOBAL_FATIGUE_THRESHOLD);
    const globalFatigue = Math.min(
      excessConnections * FATIGUE_CONFIG.GLOBAL_FATIGUE_PER_CONNECTION,
      FATIGUE_CONFIG.GLOBAL_FATIGUE_CAP
    );

    const totalFatigue = Math.min(
      interactionFatigue + globalFatigue,
      FATIGUE_CONFIG.MAX_FATIGUE
    );

    return {
      interactionFatigue: parseFloat(interactionFatigue.toFixed(4)),
      globalFatigue: parseFloat(globalFatigue.toFixed(4)),
      totalFatigue: parseFloat(totalFatigue.toFixed(4))
    };
  }

  // =========================================================================
  // 7. CONTAGION SUPPORT
  // =========================================================================
  //
  // Provides proximity data and resonance weights for engine.js contagion.
  // Engine calls this to get neighbours and their resonance-weighted
  // influence for the contagion formula.
  //
  // Source: Hatfield et al. (1993), Cikara et al. (2014)
  // =========================================================================

  /**
   * Gets all characters within contagion range of a source character,
   * with their distances, resonance values, and axis-specific weights.
   *
   * @param {string} characterId — source character hex ID
   * @returns {Promise<Array<{characterId, distance, resonance, axisWeights}>>}
   */
  async getContagionNeighbours(characterId) {
    this._ensureInitialised();

    if (!characterId) {
      throw new Error('getContagionNeighbours requires a character hex ID');
    }

    const result = await pool.query(`
      SELECT to_character, current_distance, emotional_resonance
      FROM psychic_proximity_directed
      WHERE from_character = $1
        AND current_distance < $2
      ORDER BY current_distance ASC
    `, [characterId, CONTAGION_CONFIG.PROXIMITY_THRESHOLD]);

    return result.rows.map(row => {
      const resonance = parseFloat(row.emotional_resonance);
      const isSchadenfreude = resonance < 0;

      // Axis-specific weights per Cikara et al. (2014)
      const axisWeights = {
        P: isSchadenfreude
          ? Math.abs(resonance) * RESONANCE_CONFIG.SCHADENFREUDE_P_MULTIPLIER
          : resonance * CONTAGION_CONFIG.RESONANCE_AXIS_WEIGHTS.P,
        A: isSchadenfreude
          ? Math.abs(resonance) * RESONANCE_CONFIG.SCHADENFREUDE_A_MULTIPLIER
          : resonance * CONTAGION_CONFIG.RESONANCE_AXIS_WEIGHTS.A,
        D: isSchadenfreude
          ? Math.abs(resonance) * RESONANCE_CONFIG.SCHADENFREUDE_D_MULTIPLIER
          : resonance * CONTAGION_CONFIG.RESONANCE_AXIS_WEIGHTS.D
      };

      return {
        characterId: row.to_character,
        distance: parseFloat(row.current_distance),
        resonance,
        axisWeights
      };
    });
  }

  // =========================================================================
  // 8. NARRATIVE OVERRIDE
  // =========================================================================
  //
  // Allows narrative-driven proximity to be set directly, bypassing
  // trait calculation. Used for story-critical relationships (e.g.
  // Protagonist-Antagonist bond).
  //
  // These rows are exempt from decay and type transitions.
  // =========================================================================

  /**
   * Sets a narrative-override proximity between two characters.
   * Creates the row if it doesn't exist, updates if it does.
   *
   * @param {Object} params
   * @param {string} params.fromCharacter — hex ID
   * @param {string} params.toCharacter — hex ID
   * @param {number} params.distance — forced distance [0, 1]
   * @param {number} params.resonance — forced resonance [-1, 1]
   * @param {string} params.relationshipType — type from proximity_type_config
   * @param {Object} [params.narrativeContext] — optional story metadata
   * @returns {Promise<{proximityId: string, created: boolean}>}
   */
  async setNarrativeOverride({
    fromCharacter, toCharacter, distance, resonance,
    relationshipType, narrativeContext
  }) {
    this._ensureInitialised();

    if (!fromCharacter || !toCharacter) {
      throw new Error('setNarrativeOverride requires fromCharacter and toCharacter');
    }
    if (distance < 0 || distance > 1) {
      throw new Error('distance must be between 0 and 1');
    }
    if (resonance < -1 || resonance > 1) {
      throw new Error('resonance must be between -1 and 1');
    }

    const existing = await pool.query(`
      SELECT proximity_id FROM psychic_proximity_directed
      WHERE from_character = $1 AND to_character = $2
    `, [fromCharacter, toCharacter]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let proximityId;
      let created;

      if (existing.rows.length > 0) {
        proximityId = existing.rows[0].proximity_id;
        created = false;

        await client.query(`
          UPDATE psychic_proximity_directed
          SET current_distance = $1, baseline_distance = $2,
              emotional_resonance = $3, relationship_type = $4,
              is_narrative_override = true,
              narrative_context = $5,
              last_interaction = NOW()
          WHERE proximity_id = $6
        `, [
          distance, distance, resonance,
          relationshipType,
          narrativeContext ? JSON.stringify(narrativeContext) : null,
          proximityId
        ]);
      } else {
        proximityId = await generateHexId('psychic_proximity_id');
        created = true;

        await client.query(`
          INSERT INTO psychic_proximity_directed (
            proximity_id, from_character, to_character,
            current_distance, baseline_distance,
            emotional_resonance, regression_rate,
            relationship_type, is_narrative_override,
            narrative_context
          ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, true, $8)
        `, [
          proximityId, fromCharacter, toCharacter,
          distance, distance, resonance,
          relationshipType,
          narrativeContext ? JSON.stringify(narrativeContext) : null
        ]);
      }

      // Log event
      const eventId = await generateHexId('psychic_event_id');
      await client.query(`
        INSERT INTO proximity_events (
          event_id, proximity_id, event_type,
          new_distance, narrative_context
        ) VALUES ($1, $2, 'narrative_override', $3, $4)
      `, [
        eventId, proximityId, distance,
        narrativeContext ? JSON.stringify(narrativeContext) : null
      ]);

      await client.query('COMMIT');

      logger.info('Narrative override set', {
        fromCharacter, toCharacter,
        distance, resonance, relationshipType,
        created
      });

      return { proximityId, created };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to set narrative override', error, {
        fromCharacter, toCharacter
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // 9. PROXIMITY QUERY HELPERS
  // =========================================================================

  /**
   * Gets all proximity relationships FROM a character.
   * @param {string} characterId — hex ID
   * @returns {Promise<Array>} proximity rows ordered by distance
   */
  async getRelationshipsFrom(characterId) {
    this._ensureInitialised();

    const result = await pool.query(`
      SELECT ppd.*, cp.character_name, cp.category
      FROM psychic_proximity_directed ppd
      JOIN character_profiles cp ON cp.character_id = ppd.to_character
      WHERE ppd.from_character = $1
      ORDER BY ppd.current_distance ASC
    `, [characterId]);

    return result.rows;
  }

  /**
   * Gets all proximity relationships TO a character.
   * (Who perceives this character as close?)
   * @param {string} characterId — hex ID
   * @returns {Promise<Array>} proximity rows ordered by distance
   */
  async getRelationshipsTo(characterId) {
    this._ensureInitialised();

    const result = await pool.query(`
      SELECT ppd.*, cp.character_name, cp.category
      FROM psychic_proximity_directed ppd
      JOIN character_profiles cp ON cp.character_id = ppd.from_character
      WHERE ppd.to_character = $1
      ORDER BY ppd.current_distance ASC
    `, [characterId]);

    return result.rows;
  }

  /**
   * Gets the specific proximity between two characters.
   * @param {string} fromCharacter — hex ID
   * @param {string} toCharacter — hex ID
   * @returns {Promise<Object|null>} proximity row or null
   */
  async getProximity(fromCharacter, toCharacter) {
    this._ensureInitialised();

    const result = await pool.query(`
      SELECT * FROM psychic_proximity_directed
      WHERE from_character = $1 AND to_character = $2
    `, [fromCharacter, toCharacter]);

    return result.rows.length > 0 ? result.rows[0] : null;
  }
}

// ===========================================================================
// Singleton Export
// ===========================================================================

const proximityCalculator = new ProximityCalculator();
export default proximityCalculator;
