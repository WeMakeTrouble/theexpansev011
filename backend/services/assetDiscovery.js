/**
 * ============================================================================
 * Asset Discovery — User Image Awareness Tracking
 * ============================================================================
 *
 * Tracks when users encounter images for the first time and
 * progresses their awareness state through repeated encounters.
 *
 * AWARENESS PROGRESSION:
 * ---------------------------------------------------------------------------
 *   glimpsed     → Image appeared in thumbnail or list context
 *   encountered   → Full resolution viewed or modal opened
 *   familiar      → Viewed 3+ times across separate sessions
 *   understood    → User accessed image metadata or heard Claude commentary
 *
 * Each level is reached by repeated encounters. The progression
 * is one-directional — awareness never decreases.
 *
 * VALID DISCOVERY SOURCES FOR IMAGES:
 * ---------------------------------------------------------------------------
 *   claude_reveal      → Claude the Tanuki reveals a character portrait
 *   user_exploration   → User browses gallery or opens image detail
 *   tse_lesson         → Image referenced in a teaching cycle
 *   narrative_beat     → Scene art loaded during narrative progression
 *   omiyage_gift       → Image received as a gift/reward
 *   prerequisite_unlock → Image unlocked by meeting a requirement
 *   belt_promotion     → Image unlocked via belt progression
 *   system_unlock      → System-triggered image reveal
 *
 * TRANSACTION SUPPORT:
 * ---------------------------------------------------------------------------
 * Pass a transaction client to couple discovery logging with other
 * operations (e.g., narrative beat progression + image discovery
 * in the same transaction).
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management
 * ============================================================================
 */

import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('assetDiscovery');

/**
 * Awareness states in progression order.
 * Index position determines rank. Progression is one-directional.
 *
 * @type {ReadonlyArray<string>}
 */
const AWARENESS_PROGRESSION = Object.freeze([
  'glimpsed',
  'encountered',
  'familiar',
  'understood'
]);

/**
 * Valid discovery sources from the database CHECK constraint.
 *
 * @type {ReadonlyArray<string>}
 */
const VALID_SOURCES = Object.freeze([
  'claude_reveal',
  'user_exploration',
  'tse_lesson',
  'narrative_beat',
  'omiyage_gift',
  'prerequisite_unlock',
  'belt_promotion',
  'system_unlock'
]);

/**
 * Entity type string used for image discoveries.
 *
 * @type {string}
 */
const ENTITY_TYPE = 'multimedia_asset';

/**
 * Determine the next awareness state.
 * Returns the next level up, or the current level if already at max.
 *
 * @param {string} currentState - Current awareness state
 * @returns {string} Next awareness state
 */
function _progressAwareness(currentState) {
  const idx = AWARENESS_PROGRESSION.indexOf(currentState);
  if (idx === -1) {
    return AWARENESS_PROGRESSION[0];
  }
  if (idx < AWARENESS_PROGRESSION.length - 1) {
    return AWARENESS_PROGRESSION[idx + 1];
  }
  return currentState;
}

/**
 * Asset discovery service.
 * Plain object export per naming conventions.
 *
 * @type {Object}
 */
const assetDiscovery = Object.freeze({

  /**
   * Record that a user encountered an image asset.
   * Creates a new discovery if first encounter, or progresses
   * awareness and increments encounter count if already known.
   *
   * @param {Object} params
   * @param {string} params.userId - User hex ID
   * @param {string} params.assetId - Multimedia asset hex ID
   * @param {string} params.source - Discovery source (must be valid)
   * @param {Object} [params.metadata=null] - Optional JSONB metadata
   * @param {Object} [params.queryable=pool] - DB client or pool
   * @returns {Promise<{discoveryId: string, awarenessState: string, isNew: boolean, encounterCount: number}>}
   */
  async recordDiscovery({ userId, assetId, source, metadata = null, queryable = pool }) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('userId must be a non-empty string');
    }

    if (!assetId || typeof assetId !== 'string') {
      throw new Error('assetId must be a non-empty string');
    }

    if (!VALID_SOURCES.includes(source)) {
      throw new Error(
        `Invalid discovery source: ${source}. Valid: ${VALID_SOURCES.join(', ')}`
      );
    }

    const existing = await queryable.query(`
      SELECT discovery_id, awareness_state, encounter_count
      FROM user_entity_discoveries
      WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
    `, [userId, ENTITY_TYPE, assetId]);

    if (existing.rows.length === 0) {
      const discoveryId = await generateHexId('discovery_id', queryable);

      await queryable.query(`
        INSERT INTO user_entity_discoveries (
          discovery_id, user_id, entity_type, entity_id,
          awareness_state, encounter_count, discovery_source,
          discovery_metadata, first_discovered_at, last_encountered_at
        ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, now(), now())
      `, [
        discoveryId,
        userId,
        ENTITY_TYPE,
        assetId,
        AWARENESS_PROGRESSION[0],
        source,
        metadata ? JSON.stringify(metadata) : null
      ]);

      logger.info(`New discovery ${discoveryId}`, {
        userId, assetId, source, state: AWARENESS_PROGRESSION[0]
      });

      return {
        discoveryId,
        awarenessState: AWARENESS_PROGRESSION[0],
        isNew: true,
        encounterCount: 1
      };
    }

    const row = existing.rows[0];
    const newState = _progressAwareness(row.awareness_state);
    const newCount = row.encounter_count + 1;

    await queryable.query(`
      UPDATE user_entity_discoveries
      SET awareness_state = $1,
          encounter_count = $2,
          last_encountered_at = now()
      WHERE discovery_id = $3
    `, [newState, newCount, row.discovery_id]);

    logger.info(`Discovery updated ${row.discovery_id}`, {
      userId, assetId, source,
      previousState: row.awareness_state,
      newState,
      encounterCount: newCount
    });

    return {
      discoveryId: row.discovery_id,
      awarenessState: newState,
      isNew: false,
      encounterCount: newCount
    };
  },

  /**
   * Check a user's current awareness of an image asset.
   * Returns null if the user has never encountered this asset.
   *
   * @param {string} userId - User hex ID
   * @param {string} assetId - Multimedia asset hex ID
   * @param {Object} [queryable=pool] - DB client or pool
   * @returns {Promise<{discoveryId: string, awarenessState: string, encounterCount: number, firstDiscoveredAt: Date}|null>}
   */
  async getAwareness(userId, assetId, queryable = pool) {
    const result = await queryable.query(`
      SELECT discovery_id, awareness_state, encounter_count, first_discovered_at
      FROM user_entity_discoveries
      WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
    `, [userId, ENTITY_TYPE, assetId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      discoveryId: row.discovery_id,
      awarenessState: row.awareness_state,
      encounterCount: row.encounter_count,
      firstDiscoveredAt: row.first_discovered_at
    };
  },

  /**
   * Get all image discoveries for a user, optionally filtered by awareness state.
   *
   * @param {string} userId - User hex ID
   * @param {Object} [options={}]
   * @param {string} [options.awarenessState] - Filter by specific state
   * @param {number} [options.limit=50] - Maximum results
   * @param {Object} [options.queryable=pool] - DB client or pool
   * @returns {Promise<Array<{discoveryId: string, assetId: string, awarenessState: string, encounterCount: number, firstDiscoveredAt: Date}>>}
   */
  async getUserImageDiscoveries(userId, { awarenessState, limit = 50, queryable = pool } = {}) {
    let query = `
      SELECT discovery_id, entity_id, awareness_state, encounter_count, first_discovered_at
      FROM user_entity_discoveries
      WHERE user_id = $1 AND entity_type = $2
    `;
    const params = [userId, ENTITY_TYPE];

    if (awarenessState) {
      if (!AWARENESS_PROGRESSION.includes(awarenessState)) {
        throw new Error(
          `Invalid awareness state: ${awarenessState}. Valid: ${AWARENESS_PROGRESSION.join(', ')}`
        );
      }
      query += ` AND awareness_state = $${params.length + 1}`;
      params.push(awarenessState);
    }

    query += ` ORDER BY last_encountered_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await queryable.query(query, params);

    return result.rows.map(row => ({
      discoveryId: row.discovery_id,
      assetId: row.entity_id,
      awarenessState: row.awareness_state,
      encounterCount: row.encounter_count,
      firstDiscoveredAt: row.first_discovered_at
    }));
  }
});

export default assetDiscovery;
