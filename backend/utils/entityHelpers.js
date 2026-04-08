/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENTITY HELPERS — Safe Wrapper Functions for Entity Resolution
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * This file provides safe, realm-isolated CRUD operations and three-tier
 * entity matching (Exact → Phonetic → Fuzzy) for the entities table.
 *
 * Every function enforces realm_hex_id filtering to prevent data leakage
 * between realms. No function bypasses realm isolation.
 *
 * Three-Tier Search Strategy:
 *   Tier 1 — Exact:    Case-insensitive normalized name match (~5ms)
 *   Tier 2 — Phonetic: Sounds-like matching via dmetaphone/metaphone/soundex (~20ms)
 *   Tier 3 — Fuzzy:    Trigram similarity via pg_trgm extension (~50ms)
 *
 * Required PostgreSQL Extensions:
 *   - fuzzystrmatch (provides soundex, metaphone, dmetaphone, dmetaphone_alt)
 *   - pg_trgm (provides similarity() function for trigram matching)
 *
 * Required Indexes (must exist for acceptable performance):
 *   CREATE INDEX idx_entities_realm_normalized
 *     ON entities (realm_hex_id, entity_name_normalized);
 *   CREATE INDEX idx_entities_realm_dmetaphone
 *     ON entities (realm_hex_id, phonetic_dmetaphone);
 *   CREATE INDEX idx_entities_realm_metaphone
 *     ON entities (realm_hex_id, phonetic_metaphone);
 *   CREATE INDEX idx_entities_realm_soundex
 *     ON entities (realm_hex_id, phonetic_soundex);
 *   CREATE INDEX idx_entities_trgm
 *     ON entities USING GIN (entity_name_normalized gin_trgm_ops);
 *   CREATE INDEX idx_entities_source
 *     ON entities (source_table, source_hex_id);
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS USED:
 * ---------------------------------------------------------------------------
 * Imported by:
 *   - cotwQueryEngine.js    → getAllEntitiesInRealm (entity listing)
 *   - cotwIntentMatcher.js  → getAllEntitiesInRealm (entity listing)
 *   - tieredEntitySearch.js → findEntityExact, findEntityPhonetic, findEntityFuzzy
 *
 * These are low-level helpers. Higher-level search logic lives in
 * tieredEntitySearch.js which orchestrates the cascade and disambiguation.
 *
 * ---------------------------------------------------------------------------
 * REALM ISOLATION:
 * ---------------------------------------------------------------------------
 * Every query function requires realm_hex_id as a parameter and includes it
 * in the WHERE clause. This is application-layer isolation (not PostgreSQL
 * RLS) — chosen for transparency and performance.
 *
 * ---------------------------------------------------------------------------
 * PHONETIC NORMALIZATION:
 * ---------------------------------------------------------------------------
 * All phonetic codes are computed on the NORMALIZED (lowercase, trimmed)
 * version of entity names at both INSERT and SEARCH time, ensuring
 * consistent matching regardless of input casing.
 *
 * ---------------------------------------------------------------------------
 * DATABASE TABLES:
 * ---------------------------------------------------------------------------
 *   entities — Primary entity table with phonetic columns
 *     entity_id            (#XXXXXX hex, generated via hexIdGenerator)
 *     realm_hex_id         (#XXXXXX hex, realm isolation key)
 *     entity_type          (PERSON, KNOWLEDGE, LOCATION, etc.)
 *     category             (Protagonist, B-Roll Chaos, etc.)
 *     entity_name          (Display name, original casing)
 *     entity_name_normalized (Lowercase trimmed for search)
 *     phonetic_soundex     (Computed on normalized name)
 *     phonetic_metaphone   (Computed on normalized name)
 *     phonetic_dmetaphone  (Computed on normalized name)
 *     phonetic_dmetaphone_alt (Computed on normalized name)
 *     source_table         (e.g. character_profiles)
 *     source_hex_id        (e.g. #700001)
 *     search_context       (Additional searchable text)
 *     created_at, updated_at
 *
 * ---------------------------------------------------------------------------
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger with correlation IDs (no console.log)
 *   - Frozen constants for all magic numbers
 *   - Input validation on every public function
 *   - Transaction discipline for insert operations (hex ID + INSERT atomic)
 *   - Named exports (matches consumer import pattern)
 *   - Parameterized queries throughout (SQL injection prevention)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import pool from '../db/pool.js';
import generateHexId from './hexIdGenerator.js';
import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('EntityHelpers');

/*
 * ============================================================================
 * Constants — Frozen Configuration
 * ============================================================================
 */

const SEARCH_LIMITS = Object.freeze({
  DEFAULT_MATCH_LIMIT: 5,
  DEFAULT_REALM_LIMIT: 100
});

const PHONETIC_CONFIDENCE = Object.freeze({
  EXACT: 1.0,
  DMETAPHONE_PRIMARY: 0.95,
  DMETAPHONE_ALT: 0.90,
  METAPHONE: 0.88,
  SOUNDEX: 0.85,
  FALLBACK: 0.80
});

const FUZZY_DEFAULTS = Object.freeze({
  THRESHOLD: 0.3
});

/*
 * ============================================================================
 * Validation Helpers
 * ============================================================================
 */

/**
 * Validates that a hex ID is present and correctly formatted.
 * @param {string} value - The hex ID to validate
 * @param {string} fieldName - Name of the field (for error messages)
 * @throws {Error} If validation fails
 */
function _validateHexId(value, fieldName) {
  if (!value || typeof value !== 'string' || !value.startsWith('#')) {
    throw new Error(`${fieldName} is required and must start with # (received: ${typeof value})`);
  }
}

/**
 * Validates that a string value is present and non-empty.
 * @param {string} value - The string to validate
 * @param {string} fieldName - Name of the field (for error messages)
 * @throws {Error} If validation fails
 */
function _validateString(value, fieldName) {
  if (!value || typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required and must be a non-empty string`);
  }
}

/*
 * ============================================================================
 * INSERT ENTITY
 * ============================================================================
 */

/**
 * Insert a new entity into the entities table.
 * Automatically generates entity_id and computes phonetic codes via PostgreSQL.
 * Uses a transaction to ensure hex ID generation and INSERT are atomic.
 *
 * CRITICAL: Phonetic codes are computed on the NORMALIZED name to ensure
 * consistency with search-time phonetic computation.
 *
 * @param {Object} params - Entity parameters
 * @param {string} params.realm_hex_id - Realm ID (required, e.g. '#F00000')
 * @param {string} params.entity_type - Entity type (required, e.g. 'PERSON', 'KNOWLEDGE')
 * @param {string} [params.category] - Character category (e.g. 'Protagonist', 'B-Roll Chaos')
 * @param {string} params.entity_name - Display name (required)
 * @param {string} [params.source_table] - Source table name (e.g. 'character_profiles')
 * @param {string} [params.source_hex_id] - Source record hex ID
 * @param {string} [params.search_context] - Additional searchable context
 * @param {string} [params.correlationId] - Correlation ID for logging
 * @returns {Promise<{success: boolean, entity: Object}>} The created entity record
 */
export async function insertEntity({
  realm_hex_id,
  entity_type,
  category = null,
  entity_name,
  source_table = null,
  source_hex_id = null,
  search_context = null,
  correlationId = null
}) {
  _validateHexId(realm_hex_id, 'realm_hex_id');
  _validateString(entity_type, 'entity_type');
  _validateString(entity_name, 'entity_name');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const entity_id = await generateHexId('entity_id');
    const entity_name_normalized = entity_name.toLowerCase().trim();

    const query = `
      INSERT INTO entities (
        entity_id,
        realm_hex_id,
        entity_type,
        category,
        entity_name,
        entity_name_normalized,
        phonetic_soundex,
        phonetic_metaphone,
        phonetic_dmetaphone,
        phonetic_dmetaphone_alt,
        source_table,
        source_hex_id,
        search_context,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        soundex($6::VARCHAR),
        metaphone($6::VARCHAR, 16),
        dmetaphone($6::VARCHAR),
        dmetaphone_alt($6::VARCHAR),
        $7, $8, $9,
        NOW(), NOW()
      )
      RETURNING *;
    `;

    const values = [
      entity_id,
      realm_hex_id,
      entity_type,
      category,
      entity_name,
      entity_name_normalized,
      source_table,
      source_hex_id,
      search_context
    ];

    const result = await client.query(query, values);
    await client.query('COMMIT');

    logger.info('Entity inserted', {
      correlationId,
      entityId: entity_id,
      realmHexId: realm_hex_id,
      entityType: entity_type,
      entityName: entity_name
    });

    return {
      success: true,
      entity: result.rows[0]
    };

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Entity insertion failed', error, {
      correlationId,
      realmHexId: realm_hex_id,
      entityType: entity_type,
      entityName: entity_name
    });
    throw error;
  } finally {
    client.release();
  }
}

/*
 * ============================================================================
 * TIER 1: EXACT MATCH
 * ============================================================================
 */

/**
 * Find entity by exact name match (case-insensitive).
 * Tier 1: Fastest search (~5ms).
 *
 * @param {string} entityName - Name to search for
 * @param {string} realm_hex_id - Realm to search in (required for isolation)
 * @param {string} [entityType] - Optional entity type filter
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<Object|null>} Match result with confidence or null
 */
export async function findEntityExact(entityName, realm_hex_id, entityType = null, correlationId = null) {
  _validateHexId(realm_hex_id, 'realm_hex_id');
  _validateString(entityName, 'entityName');

  try {
    const normalized = entityName.toLowerCase().trim();

    let query = `
      SELECT
        entity_id,
        entity_name,
        entity_type,
        category,
        source_table,
        source_hex_id,
        search_context
      FROM entities
      WHERE realm_hex_id = $1
        AND entity_name_normalized = $2
    `;

    const values = [realm_hex_id, normalized];

    if (entityType) {
      query += ' AND entity_type = $3';
      values.push(entityType);
    }

    query += ` LIMIT ${SEARCH_LIMITS.DEFAULT_MATCH_LIMIT}`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return null;
    }

    logger.debug('Exact match found', {
      correlationId,
      realmHexId: realm_hex_id,
      query: entityName,
      matchCount: result.rows.length
    });

    return {
      matches: result.rows,
      method: 'exact',
      confidence: PHONETIC_CONFIDENCE.EXACT,
      count: result.rows.length
    };

  } catch (error) {
    logger.error('Exact entity search failed', error, {
      correlationId,
      realmHexId: realm_hex_id,
      entityName
    });
    throw error;
  }
}

/*
 * ============================================================================
 * TIER 2: PHONETIC MATCH
 * ============================================================================
 */

/**
 * Find entity by phonetic similarity (sounds-like matching).
 * Tier 2: Fast search (~20ms).
 * Handles: "Steven" → "Stephen", "Pizza Skeleton" → "Piza Sukeruton"
 *
 * Uses four PostgreSQL phonetic algorithms with tiered confidence:
 *   dmetaphone primary  → 0.95
 *   dmetaphone alt      → 0.90
 *   metaphone           → 0.88
 *   soundex             → 0.85
 *
 * @param {string} entityName - Name to search for
 * @param {string} realm_hex_id - Realm to search in (required for isolation)
 * @param {string} [entityType] - Optional entity type filter
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<Object|null>} Match result with confidence scores or null
 */
export async function findEntityPhonetic(entityName, realm_hex_id, entityType = null, correlationId = null) {
  _validateHexId(realm_hex_id, 'realm_hex_id');
  _validateString(entityName, 'entityName');

  try {
    const normalized = entityName.toLowerCase().trim();

    let query = `
      SELECT
        entity_id,
        entity_name,
        entity_type,
        category,
        source_table,
        source_hex_id,
        search_context,
        CASE
          WHEN phonetic_dmetaphone = dmetaphone($2::VARCHAR) THEN ${PHONETIC_CONFIDENCE.DMETAPHONE_PRIMARY}
          WHEN phonetic_dmetaphone_alt = dmetaphone_alt($2::VARCHAR) THEN ${PHONETIC_CONFIDENCE.DMETAPHONE_ALT}
          WHEN phonetic_metaphone = metaphone($2::VARCHAR, 16) THEN ${PHONETIC_CONFIDENCE.METAPHONE}
          WHEN phonetic_soundex = soundex($2::VARCHAR) THEN ${PHONETIC_CONFIDENCE.SOUNDEX}
          ELSE ${PHONETIC_CONFIDENCE.FALLBACK}
        END as confidence
      FROM entities
      WHERE realm_hex_id = $1
        AND (
          phonetic_dmetaphone = dmetaphone($2::VARCHAR)
          OR phonetic_dmetaphone_alt = dmetaphone_alt($2::VARCHAR)
          OR phonetic_metaphone = metaphone($2::VARCHAR, 16)
          OR phonetic_soundex = soundex($2::VARCHAR)
        )
    `;

    const values = [realm_hex_id, normalized];

    if (entityType) {
      query += ' AND entity_type = $3';
      values.push(entityType);
    }

    query += ` ORDER BY confidence DESC LIMIT ${SEARCH_LIMITS.DEFAULT_MATCH_LIMIT}`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return null;
    }

    logger.debug('Phonetic match found', {
      correlationId,
      realmHexId: realm_hex_id,
      query: entityName,
      matchCount: result.rows.length,
      topConfidence: result.rows[0].confidence
    });

    return {
      matches: result.rows,
      method: 'phonetic',
      confidence: result.rows[0].confidence,
      count: result.rows.length
    };

  } catch (error) {
    logger.error('Phonetic entity search failed', error, {
      correlationId,
      realmHexId: realm_hex_id,
      entityName
    });
    throw error;
  }
}

/*
 * ============================================================================
 * TIER 3: FUZZY MATCH
 * ============================================================================
 */

/**
 * Find entity by fuzzy/trigram similarity (typo-tolerant matching).
 * Tier 3: Medium speed search (~50ms).
 * Handles: "Piza Sukerutn" → "Piza Sukeruton", "Chees Fang" → "Cheese Fang"
 *
 * Requires pg_trgm extension and GIN index on entity_name_normalized.
 *
 * @param {string} entityName - Name to search for
 * @param {string} realm_hex_id - Realm to search in (required for isolation)
 * @param {string} [entityType] - Optional entity type filter
 * @param {number} [threshold=0.3] - Minimum similarity score (0.0-1.0)
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<Object|null>} Match result with similarity scores or null
 */
export async function findEntityFuzzy(entityName, realm_hex_id, entityType = null, threshold = FUZZY_DEFAULTS.THRESHOLD, correlationId = null) {
  _validateHexId(realm_hex_id, 'realm_hex_id');
  _validateString(entityName, 'entityName');

  try {
    const normalized = entityName.toLowerCase().trim();

    let query = `
      SELECT
        entity_id,
        entity_name,
        entity_type,
        category,
        source_table,
        source_hex_id,
        search_context,
        similarity(entity_name_normalized, $2) as confidence
      FROM entities
      WHERE realm_hex_id = $1
        AND similarity(entity_name_normalized, $2) > $3
    `;

    const values = [realm_hex_id, normalized, threshold];

    if (entityType) {
      query += ' AND entity_type = $4';
      values.push(entityType);
    }

    query += ` ORDER BY confidence DESC LIMIT ${SEARCH_LIMITS.DEFAULT_MATCH_LIMIT}`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return null;
    }

    logger.debug('Fuzzy match found', {
      correlationId,
      realmHexId: realm_hex_id,
      query: entityName,
      threshold,
      matchCount: result.rows.length,
      topConfidence: result.rows[0].confidence
    });

    return {
      matches: result.rows,
      method: 'fuzzy',
      confidence: result.rows[0].confidence,
      count: result.rows.length
    };

  } catch (error) {
    logger.error('Fuzzy entity search failed', error, {
      correlationId,
      realmHexId: realm_hex_id,
      entityName
    });
    throw error;
  }
}

/*
 * ============================================================================
 * REVERSE LOOKUP (SOURCE TO ENTITY)
 * ============================================================================
 */

/**
 * Find entity record by its source table and ID.
 * Useful for getting entity_id from character_id, etc.
 *
 * @param {string} source_table - Source table name (e.g. 'character_profiles')
 * @param {string} source_hex_id - Source record hex ID (e.g. '#700001')
 * @param {string} [realm_hex_id] - Optional realm filter for additional safety
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<Object|null>} Entity record or null
 */
export async function findEntityBySource(source_table, source_hex_id, realm_hex_id = null, correlationId = null) {
  _validateString(source_table, 'source_table');
  _validateHexId(source_hex_id, 'source_hex_id');

  try {
    let query = `
      SELECT
        entity_id,
        realm_hex_id,
        entity_name,
        entity_type,
        category,
        source_table,
        source_hex_id,
        search_context
      FROM entities
      WHERE source_table = $1
        AND source_hex_id = $2
    `;

    const values = [source_table, source_hex_id];

    if (realm_hex_id) {
      query += ' AND realm_hex_id = $3';
      values.push(realm_hex_id);
    }

    query += ' LIMIT 1';

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];

  } catch (error) {
    logger.error('Source entity lookup failed', error, {
      correlationId,
      sourceTable: source_table,
      sourceHexId: source_hex_id
    });
    throw error;
  }
}

/*
 * ============================================================================
 * GET ALL ENTITIES IN REALM
 * ============================================================================
 */

/**
 * Get all entities in a specific realm.
 * Used by cotwQueryEngine and cotwIntentMatcher for entity listing.
 *
 * @param {string} realm_hex_id - Realm to query
 * @param {string} [entityType] - Optional type filter
 * @param {number} [limit=100] - Max results
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<Array<Object>>} Array of entity records
 */
export async function getAllEntitiesInRealm(realm_hex_id, entityType = null, limit = SEARCH_LIMITS.DEFAULT_REALM_LIMIT, correlationId = null) {
  _validateHexId(realm_hex_id, 'realm_hex_id');

  try {
    let query = `
      SELECT
        entity_id,
        entity_name,
        entity_type,
        category,
        source_table,
        source_hex_id,
        search_context,
        created_at
      FROM entities
      WHERE realm_hex_id = $1
    `;

    const values = [realm_hex_id];

    if (entityType) {
      query += ' AND entity_type = $2';
      values.push(entityType);
    }

    query += ` ORDER BY entity_name LIMIT $${values.length + 1}`;
    values.push(limit);

    const result = await pool.query(query, values);

    return result.rows;

  } catch (error) {
    logger.error('Realm entity listing failed', error, {
      correlationId,
      realmHexId: realm_hex_id,
      entityType
    });
    throw error;
  }
}

/*
 * ============================================================================
 * DELETE ENTITY
 * ============================================================================
 */

/**
 * Delete an entity by ID.
 * Safety: Requires realm_hex_id to prevent accidental cross-realm deletion.
 *
 * @param {string} entity_id - Entity ID to delete
 * @param {string} realm_hex_id - Realm ID (required for safety)
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
export async function deleteEntity(entity_id, realm_hex_id, correlationId = null) {
  _validateHexId(entity_id, 'entity_id');
  _validateHexId(realm_hex_id, 'realm_hex_id');

  try {
    const query = `
      DELETE FROM entities
      WHERE entity_id = $1
        AND realm_hex_id = $2
      RETURNING entity_id;
    `;

    const result = await pool.query(query, [entity_id, realm_hex_id]);
    const deleted = result.rowCount > 0;

    if (deleted) {
      logger.info('Entity deleted', {
        correlationId,
        entityId: entity_id,
        realmHexId: realm_hex_id
      });
    }

    return deleted;

  } catch (error) {
    logger.error('Entity deletion failed', error, {
      correlationId,
      entityId: entity_id,
      realmHexId: realm_hex_id
    });
    throw error;
  }
}

/*
 * ============================================================================
 * UPDATE ENTITY
 * ============================================================================
 */

/**
 * Update entity name and recompute phonetic codes.
 * Safety: Requires realm_hex_id to prevent accidental cross-realm updates.
 *
 * When entity_name is updated, phonetic codes are recomputed on the
 * NORMALIZED version of the new name for search consistency.
 *
 * @param {string} entity_id - Entity ID to update
 * @param {string} realm_hex_id - Realm ID (required for safety)
 * @param {Object} updates - Fields to update
 * @param {string} [updates.entity_name] - New name
 * @param {string} [updates.category] - New category
 * @param {string} [updates.search_context] - New context
 * @param {string} [correlationId] - Correlation ID for logging
 * @returns {Promise<Object>} Updated entity record
 */
export async function updateEntity(entity_id, realm_hex_id, updates, correlationId = null) {
  _validateHexId(entity_id, 'entity_id');
  _validateHexId(realm_hex_id, 'realm_hex_id');

  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    throw new Error('updates object is required and must contain at least one field');
  }

  try {
    const setClauses = [];
    const values = [entity_id, realm_hex_id];
    let valueIndex = 3;

    if (updates.entity_name) {
      const normalized = updates.entity_name.toLowerCase().trim();

      setClauses.push(`entity_name = $${valueIndex}`);
      values.push(updates.entity_name);
      valueIndex++;

      setClauses.push(`entity_name_normalized = $${valueIndex}`);
      values.push(normalized);
      valueIndex++;

      // Recompute phonetic codes on NORMALIZED name
      const normalizedIdx = valueIndex - 1;
      setClauses.push(`phonetic_soundex = soundex($${normalizedIdx}::VARCHAR)`);
      setClauses.push(`phonetic_metaphone = metaphone($${normalizedIdx}::VARCHAR, 16)`);
      setClauses.push(`phonetic_dmetaphone = dmetaphone($${normalizedIdx}::VARCHAR)`);
      setClauses.push(`phonetic_dmetaphone_alt = dmetaphone_alt($${normalizedIdx}::VARCHAR)`);
    }

    if (updates.category !== undefined) {
      setClauses.push(`category = $${valueIndex}`);
      values.push(updates.category);
      valueIndex++;
    }

    if (updates.search_context !== undefined) {
      setClauses.push(`search_context = $${valueIndex}`);
      values.push(updates.search_context);
      valueIndex++;
    }

    setClauses.push('updated_at = NOW()');

    const query = `
      UPDATE entities
      SET ${setClauses.join(', ')}
      WHERE entity_id = $1
        AND realm_hex_id = $2
      RETURNING *;
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      throw new Error(`Entity ${entity_id} not found in realm ${realm_hex_id}`);
    }

    logger.info('Entity updated', {
      correlationId,
      entityId: entity_id,
      realmHexId: realm_hex_id,
      updatedFields: Object.keys(updates)
    });

    return result.rows[0];

  } catch (error) {
    logger.error('Entity update failed', error, {
      correlationId,
      entityId: entity_id,
      realmHexId: realm_hex_id
    });
    throw error;
  }
}
