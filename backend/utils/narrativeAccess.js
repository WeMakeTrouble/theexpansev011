/**
 * ============================================================================
 * narrativeAccess.js — Narrative Data Access Layer (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * CRUD gateway for the narrative system's four core entities:
 *   1. Multimedia Assets — images, audio, video for segments
 *   2. Locations — named places within The Expanse
 *   3. Narrative Segments — story content nodes (narration, dialogue,
 *      choice points, endings, character intros)
 *   4. Narrative Paths — connections between segments (linear, choice,
 *      conditional branch)
 *
 * This is a pure data access layer. It handles validation, normalisation,
 * existence checks, and parameterised queries. It does NOT contain
 * business logic — narrative progression, consequence application, and
 * path evaluation live in narrativeEngine.js.
 *
 * API PATTERN
 * -----------
 * Every entity follows the same contract:
 *   createX(data, correlationId) → row object
 *   getXById(id, correlationId) → row object | null
 *   listX({ limit, offset }, correlationId) → row[]
 *
 * All list methods support cursor-based pagination via limit/offset
 * with frozen defaults (DEFAULT_LIMIT: 50, MAX_LIMIT: 200).
 *
 * All string inputs are validated against database column limits
 * before query execution to provide clean error messages instead
 * of raw Postgres varchar overflow errors.
 *
 * CONSUMERS
 * ---------
 * - narrativeEngine.js (state machine — progression, choices, consequences)
 * - StorytellerBridge.js (narrative beat retrieval)
 * - Admin routes (content management)
 *
 * SCHEMA (Verified Against Actual Database 2026-02-10)
 * -----------------------------------------------------
 * multimedia_assets: asset_id(50), asset_type, url, description,
 *   duration_seconds, thumbnail_url, tags[], asset_data, original_filename,
 *   upload_date, file_size, mime_type, uploaded_at, created_at, updated_at
 *   CHECK: asset_type IN (video, image, audio), duration_seconds >= 0
 *
 * locations: location_id(7), name(100), description, realm(50),
 *   associated_asset_id(7), created_at, updated_at
 *   CHECK: location_id ~ '^#[0-9A-F]{6}$'
 *   UNIQUE: name
 *   FK: associated_asset_id → multimedia_assets
 *
 * narrative_segments: segment_id(7), title(255), content(text), summary(text),
 *   keywords(text), segment_type(50), associated_character_ids[](7),
 *   associated_location_id(7), sentiment_tags(jsonb),
 *   multimedia_asset_id(7), created_at, updated_at
 *   CHECK: segment_id ~ '^#[0-9A-F]{6}$'
 *   CHECK: segment_type IN (narration, dialogue, choice_point, ending,
 *          character_intro_point)
 *   FK: associated_location_id → locations, multimedia_asset_id → multimedia_assets
 *
 * narrative_paths: path_id(7), source_segment_id(7), target_segment_id(7),
 *   path_type(50), choice_text(text), conditions(jsonb), consequences(jsonb),
 *   order_in_choices(int), is_active(bool), created_at, updated_at
 *   CHECK: path_id ~ '^#[0-9A-F]{6}$'
 *   CHECK: path_type IN (linear_progression, choice_option, conditional_branch)
 *   CHECK: source_segment_id <> target_segment_id (no self-loops)
 *   FK: source/target → narrative_segments
 *
 * characters_in_narrative: character_id(7), current_narrative_segment_id(7),
 *   narrative_history(jsonb), current_narrative_state(jsonb),
 *   last_interacted_at, created_at, updated_at
 *   FK: character_id → character_profiles,
 *       current_narrative_segment_id → narrative_segments
 *
 * character_trait_scores: character_hex_id(7), trait_hex_color(7),
 *   percentile_score numeric(5,2), created_at, updated_at
 *   CHECK: percentile_score >= 0.00 AND <= 100.00
 *   PK: (character_hex_id, trait_hex_color)
 *   FK: character_hex_id → character_profiles, trait_hex_color → characteristics
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js (isValidHexId, generateHexId),
 *           counters.js
 * External: None
 *
 * SECURITY
 * --------
 * All queries parameterised with $N placeholders. No string interpolation.
 * Hex IDs validated and normalised before any query. URL validation on
 * asset creation. Pagination limits clamped to prevent resource exhaustion.
 * String lengths validated against DB column limits before query execution.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from './logger.js';
import { isValidHexId } from './hexIdGenerator.js';
import generateHexId from './hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('NarrativeAccess');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const VALID_ASSET_TYPES = Object.freeze(['video', 'image', 'audio']);

const VALID_SEGMENT_TYPES = Object.freeze([
  'narration', 'dialogue', 'choice_point', 'ending', 'character_intro_point'
]);

const VALID_PATH_TYPES = Object.freeze([
  'linear_progression', 'choice_option', 'conditional_branch'
]);

const TIMEOUTS = Object.freeze({
  QUERY_MS: 5000,
  CONNECT_MS: 5000
});

const PAGINATION = Object.freeze({
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 200,
  MIN_LIMIT: 1
});

const STRING_LIMITS = Object.freeze({
  SEGMENT_TITLE: 255,
  LOCATION_NAME: 100,
  REALM: 50,
  CHOICE_TEXT: 2000,
  KEYWORDS: 2000,
  CONTENT: 100000,
  SUMMARY: 10000,
  DESCRIPTION: 10000,
  URL: 2048
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Internal Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Normalises a hex ID to uppercase #XXXXXX format.
 * @param {string} hex - Raw hex string
 * @returns {string} Normalised hex ID
 */
function _normalizeHexId(hex) {
  if (typeof hex !== 'string') return hex;
  const v = hex.trim();
  return v.startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
}

/**
 * Validates a hex ID and throws if invalid.
 * Uses isValidHexId from hexIdGenerator (single source of truth).
 * @param {string} id - Hex ID to validate
 * @param {string} [fieldName='hex id'] - Field name for error message
 * @throws {Error} If hex ID is invalid
 */
function _assertHexId(id, fieldName = 'hex id') {
  if (!isValidHexId(id)) {
    throw new Error(`Invalid ${fieldName} format. Expected #XXXXXX.`);
  }
}

/**
 * Validates string length against a column limit.
 * @param {string} value - String to validate
 * @param {number} maxLength - Maximum allowed length
 * @param {string} fieldName - Field name for error message
 * @throws {Error} If string exceeds limit
 */
function _assertMaxLength(value, maxLength, fieldName) {
  if (typeof value === 'string' && value.trim().length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters.`);
  }
}

/**
 * @param {*} s - Value to check
 * @returns {boolean} True if non-empty string
 */
function _isNonEmptyString(s) {
  return typeof s === 'string' && s.trim() !== '';
}

/**
 * @param {*} s - Value to check
 * @returns {boolean} True if valid HTTP(S) URL within length limit
 */
function _isHttpUrl(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length > STRING_LIMITS.URL) return false;
  return /^https?:\/\//i.test(trimmed);
}

/**
 * Safely serialises a value to JSONB string.
 * @param {*} value - Value to serialise
 * @returns {string} JSON string
 */
function _toJsonb(value) {
  return JSON.stringify(value ?? {});
}

/**
 * Clamps pagination parameters to safe bounds.
 * @param {object} [opts={}] - Pagination options
 * @param {number} [opts.limit] - Requested limit
 * @param {number} [opts.offset] - Requested offset
 * @returns {{ limit: number, offset: number }} Clamped values
 */
function _clampPagination(opts = {}) {
  let limit = typeof opts.limit === 'number' ? opts.limit : PAGINATION.DEFAULT_LIMIT;
  limit = Math.max(PAGINATION.MIN_LIMIT, Math.min(PAGINATION.MAX_LIMIT, limit));
  let offset = typeof opts.offset === 'number' ? opts.offset : 0;
  offset = Math.max(0, offset);
  return { limit, offset };
}

/**
 * Gets a pool client with timeout protection.
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object|null>} Database client or null on timeout
 */
async function _getClient(correlationId) {
  try {
    const client = await Promise.race([
      pool.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout')), TIMEOUTS.CONNECT_MS)
      )
    ]);
    return client;
  } catch (err) {
    logger.error('Failed to get DB client', { error: err.message, correlationId });
    Counters.increment('narrative_access', 'connection_timeout');
    return null;
  }
}

/**
 * Runs a query with timeout protection.
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<object>} Query result
 * @throws {Error} On timeout or query failure
 */
async function _queryWithTimeout(sql, params, correlationId) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Query timeout')), TIMEOUTS.QUERY_MS)
    )
  ]);
}

/**
 * Checks if a row exists in a table.
 * @param {string} sql - SQL query (should SELECT 1 FROM ...)
 * @param {Array} params - Query parameters
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<boolean>} True if row exists
 */
async function _exists(sql, params, correlationId) {
  try {
    const res = await _queryWithTimeout(`${sql} LIMIT 1`, params, correlationId);
    return res.rows.length > 0;
  } catch (err) {
    logger.error('Existence check failed', { error: err.message, correlationId });
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Existence Checks                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Checks if a character profile exists.
 * @param {string} characterId - Hex character ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<boolean>} True if character exists
 */
async function characterExists(characterId, correlationId) {
  _assertHexId(characterId, 'character_id');
  const id = _normalizeHexId(characterId);
  return _exists('SELECT 1 FROM character_profiles WHERE character_id = $1', [id], correlationId);
}

/**
 * Checks if a multimedia asset exists.
 * @param {string} assetId - Hex asset ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<boolean>} True if asset exists
 */
async function multimediaAssetExists(assetId, correlationId) {
  _assertHexId(assetId, 'asset_id');
  const id = _normalizeHexId(assetId);
  return _exists('SELECT 1 FROM multimedia_assets WHERE asset_id = $1', [id], correlationId);
}

/**
 * Checks if a location exists.
 * @param {string} locationId - Hex location ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<boolean>} True if location exists
 */
async function locationExists(locationId, correlationId) {
  _assertHexId(locationId, 'location_id');
  const id = _normalizeHexId(locationId);
  return _exists('SELECT 1 FROM locations WHERE location_id = $1', [id], correlationId);
}

/**
 * Checks if a narrative segment exists.
 * @param {string} segmentId - Hex segment ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<boolean>} True if segment exists
 */
async function narrativeSegmentExists(segmentId, correlationId) {
  _assertHexId(segmentId, 'segment_id');
  const id = _normalizeHexId(segmentId);
  return _exists('SELECT 1 FROM narrative_segments WHERE segment_id = $1', [id], correlationId);
}

/**
 * Batch existence check for multiple character IDs using a single query.
 * Eliminates N+1 problem when validating associated_character_ids.
 * @param {string[]} characterIds - Array of normalised hex character IDs
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<string[]>} Array of IDs that do NOT exist
 */
async function _findMissingCharacters(characterIds, correlationId) {
  if (!characterIds.length) return [];
  try {
    const result = await _queryWithTimeout(
      `SELECT unnest($1::varchar[]) AS requested_id
       EXCEPT
       SELECT character_id FROM character_profiles WHERE character_id = ANY($1)`,
      [characterIds], correlationId
    );
    return result.rows.map(r => r.requested_id);
  } catch (err) {
    logger.error('Batch character existence check failed', { error: err.message, correlationId });
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Multimedia Assets                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a new multimedia asset.
 * @param {object} assetData - Asset properties
 * @param {string} assetData.asset_type - 'video' | 'image' | 'audio'
 * @param {string} assetData.url - HTTP(S) URL (max 2048 chars)
 * @param {string} [assetData.description] - Asset description (max 10000 chars)
 * @param {number} [assetData.duration_seconds] - Duration (non-negative)
 * @param {string} [assetData.thumbnail_url] - Thumbnail HTTP(S) URL (max 2048 chars)
 * @param {string[]} [assetData.tags] - Tag array
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{asset_id: string, asset_type: string, url: string, description: string|null, duration_seconds: number|null, thumbnail_url: string|null, tags: string[], created_at: string}>}
 * @throws {Error} On validation failure or database error
 */
async function createMultimediaAsset(assetData, correlationId) {
  const {
    asset_type, url, description = null, duration_seconds = null,
    thumbnail_url = null, tags = []
  } = assetData ?? {};

  if (!VALID_ASSET_TYPES.includes(asset_type)) {
    throw new Error(`Invalid asset_type. Must be one of: ${VALID_ASSET_TYPES.join(', ')}.`);
  }
  if (!_isHttpUrl(url)) {
    throw new Error('Asset URL must be a valid http:// or https:// URL under 2048 characters.');
  }
  if (thumbnail_url !== null && !_isHttpUrl(thumbnail_url)) {
    throw new Error('thumbnail_url must be a valid http:// or https:// URL under 2048 characters (or null).');
  }
  if (description !== null) {
    _assertMaxLength(description, STRING_LIMITS.DESCRIPTION, 'description');
  }
  if (duration_seconds !== null && (typeof duration_seconds !== 'number' || duration_seconds < 0)) {
    throw new Error('duration_seconds must be a non-negative number when provided.');
  }
  if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
    throw new Error('tags must be an array of strings.');
  }

  const assetId = _normalizeHexId(await generateHexId('multimedia_asset_id'));

  const client = await _getClient(correlationId);
  if (!client) throw new Error('Failed to connect to database.');

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO multimedia_assets
         (asset_id, asset_type, url, description, duration_seconds, thumbnail_url, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING asset_id, asset_type, url, description, duration_seconds, thumbnail_url, tags, created_at`,
      [assetId, asset_type, url.trim(), description, duration_seconds, thumbnail_url, tags]
    );
    await client.query('COMMIT');
    Counters.increment('narrative_asset', 'created');
    logger.info('Multimedia asset created', { assetId, assetType: asset_type, correlationId });
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      throw new Error('A multimedia asset with this ID already exists.');
    }
    logger.error('Failed to create multimedia asset', { error: err.message, correlationId });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves a multimedia asset by ID.
 * @param {string} assetId - Hex asset ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{asset_id: string, asset_type: string, url: string, description: string|null, duration_seconds: number|null, thumbnail_url: string|null, tags: string[], created_at: string, updated_at: string}|null>}
 */
async function getMultimediaAssetById(assetId, correlationId) {
  _assertHexId(assetId, 'asset_id');
  const id = _normalizeHexId(assetId);
  try {
    const result = await _queryWithTimeout(
      `SELECT asset_id, asset_type, url, description, duration_seconds,
              thumbnail_url, tags, created_at, updated_at
       FROM multimedia_assets WHERE asset_id = $1`,
      [id], correlationId
    );
    Counters.increment('narrative_asset', result.rows[0] ? 'found' : 'not_found');
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error('Failed to get multimedia asset', { error: err.message, assetId: id, correlationId });
    Counters.increment('narrative_asset', 'query_failure');
    return null;
  }
}

/**
 * Lists multimedia assets with pagination.
 * @param {object} [opts={}] - Pagination options
 * @param {number} [opts.limit=50] - Max results (1-200)
 * @param {number} [opts.offset=0] - Offset for pagination
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<Array<{asset_id: string, asset_type: string, url: string, description: string|null, thumbnail_url: string|null, created_at: string}>>}
 */
async function listMultimediaAssets(opts, correlationId) {
  const { limit, offset } = _clampPagination(opts);
  try {
    const result = await _queryWithTimeout(
      `SELECT asset_id, asset_type, url, description, thumbnail_url, created_at
       FROM multimedia_assets ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset], correlationId
    );
    Counters.increment('narrative_asset', 'listed');
    return result.rows;
  } catch (err) {
    logger.error('Failed to list multimedia assets', { error: err.message, correlationId });
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Locations                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a new location.
 * @param {object} locationData - Location properties
 * @param {string} locationData.name - Location name (required, unique, max 100 chars)
 * @param {string} [locationData.description] - Location description (max 10000 chars)
 * @param {string} [locationData.realm] - Realm name (max 50 chars)
 * @param {string} [locationData.associated_asset_id] - Hex asset ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{location_id: string, name: string, description: string|null, realm: string|null, associated_asset_id: string|null, created_at: string}>}
 * @throws {Error} On validation failure or database error
 */
async function createLocation(locationData, correlationId) {
  const {
    name, description = null, realm = null, associated_asset_id = null
  } = locationData ?? {};

  if (!_isNonEmptyString(name)) throw new Error('Location name is required.');
  _assertMaxLength(name, STRING_LIMITS.LOCATION_NAME, 'Location name');
  if (description !== null) {
    _assertMaxLength(description, STRING_LIMITS.DESCRIPTION, 'description');
  }
  if (realm !== null) {
    _assertMaxLength(realm, STRING_LIMITS.REALM, 'realm');
  }

  let assocAssetId = null;
  if (associated_asset_id) {
    _assertHexId(associated_asset_id, 'associated_asset_id');
    assocAssetId = _normalizeHexId(associated_asset_id);
    if (!(await multimediaAssetExists(assocAssetId, correlationId))) {
      throw new Error(`Multimedia asset ${assocAssetId} not found.`);
    }
  }

  const locationId = _normalizeHexId(await generateHexId('location_id'));

  const client = await _getClient(correlationId);
  if (!client) throw new Error('Failed to connect to database.');

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO locations (location_id, name, description, realm, associated_asset_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING location_id, name, description, realm, associated_asset_id, created_at`,
      [locationId, name.trim(), description, realm, assocAssetId]
    );
    await client.query('COMMIT');
    Counters.increment('narrative_location', 'created');
    logger.info('Location created', { locationId, name: name.trim(), correlationId });
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      throw new Error(`Location with name "${name.trim()}" already exists.`);
    }
    logger.error('Failed to create location', { error: err.message, correlationId });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves a location by ID.
 * @param {string} locationId - Hex location ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{location_id: string, name: string, description: string|null, realm: string|null, associated_asset_id: string|null, created_at: string, updated_at: string}|null>}
 */
async function getLocationById(locationId, correlationId) {
  _assertHexId(locationId, 'location_id');
  const id = _normalizeHexId(locationId);
  try {
    const result = await _queryWithTimeout(
      `SELECT location_id, name, description, realm, associated_asset_id, created_at, updated_at
       FROM locations WHERE location_id = $1`,
      [id], correlationId
    );
    Counters.increment('narrative_location', result.rows[0] ? 'found' : 'not_found');
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error('Failed to get location', { error: err.message, locationId: id, correlationId });
    Counters.increment('narrative_location', 'query_failure');
    return null;
  }
}

/**
 * Lists locations with pagination.
 * @param {object} [opts={}] - Pagination options
 * @param {number} [opts.limit=50] - Max results (1-200)
 * @param {number} [opts.offset=0] - Offset for pagination
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<Array<{location_id: string, name: string, description: string|null, realm: string|null, created_at: string}>>}
 */
async function listLocations(opts, correlationId) {
  const { limit, offset } = _clampPagination(opts);
  try {
    const result = await _queryWithTimeout(
      `SELECT location_id, name, description, realm, created_at
       FROM locations ORDER BY name LIMIT $1 OFFSET $2`,
      [limit, offset], correlationId
    );
    Counters.increment('narrative_location', 'listed');
    return result.rows;
  } catch (err) {
    logger.error('Failed to list locations', { error: err.message, correlationId });
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Narrative Segments                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a new narrative segment.
 * @param {object} segmentData - Segment properties
 * @param {string} segmentData.title - Segment title (required, max 255 chars)
 * @param {string} segmentData.content - Segment content (required, max 100000 chars)
 * @param {string} [segmentData.summary] - Segment summary (max 10000 chars)
 * @param {string} [segmentData.keywords] - Comma-separated keywords (max 2000 chars)
 * @param {string} segmentData.segment_type - One of VALID_SEGMENT_TYPES
 * @param {string[]} [segmentData.associated_character_ids] - Hex character IDs
 * @param {string} [segmentData.associated_location_id] - Hex location ID
 * @param {object} [segmentData.sentiment_tags] - JSONB sentiment data
 * @param {string} [segmentData.multimedia_asset_id] - Hex asset ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{segment_id: string, title: string, segment_type: string, created_at: string}>}
 * @throws {Error} On validation failure or database error
 */
async function createNarrativeSegment(segmentData, correlationId) {
  const {
    title, content, summary = null, keywords = null, segment_type,
    associated_character_ids = [], associated_location_id = null,
    sentiment_tags = {}, multimedia_asset_id = null
  } = segmentData ?? {};

  if (!_isNonEmptyString(title)) throw new Error('Narrative segment title is required.');
  _assertMaxLength(title, STRING_LIMITS.SEGMENT_TITLE, 'Segment title');
  if (!_isNonEmptyString(content)) throw new Error('Narrative segment content is required.');
  _assertMaxLength(content, STRING_LIMITS.CONTENT, 'Segment content');
  if (summary !== null) {
    _assertMaxLength(summary, STRING_LIMITS.SUMMARY, 'summary');
  }
  if (keywords !== null) {
    _assertMaxLength(keywords, STRING_LIMITS.KEYWORDS, 'keywords');
  }
  if (!VALID_SEGMENT_TYPES.includes(segment_type)) {
    throw new Error(`Invalid segment_type. Must be one of: ${VALID_SEGMENT_TYPES.join(', ')}.`);
  }
  if (!Array.isArray(associated_character_ids) || !associated_character_ids.every(id => isValidHexId(id))) {
    throw new Error('associated_character_ids must be an array of valid hex IDs.');
  }
  if (typeof sentiment_tags !== 'object' || sentiment_tags === null) {
    throw new Error('sentiment_tags must be a valid JSON object.');
  }

  const normalizedCharIds = [...new Set(associated_character_ids.map(_normalizeHexId))];

  if (normalizedCharIds.length > 0) {
    const missing = await _findMissingCharacters(normalizedCharIds, correlationId);
    if (missing.length > 0) {
      throw new Error(`Associated character(s) not found: ${missing.join(', ')}.`);
    }
  }

  let assocLocId = null;
  if (associated_location_id) {
    _assertHexId(associated_location_id, 'associated_location_id');
    assocLocId = _normalizeHexId(associated_location_id);
    if (!(await locationExists(assocLocId, correlationId))) {
      throw new Error(`Associated location ${assocLocId} not found.`);
    }
  }

  let mediaId = null;
  if (multimedia_asset_id) {
    _assertHexId(multimedia_asset_id, 'multimedia_asset_id');
    mediaId = _normalizeHexId(multimedia_asset_id);
    if (!(await multimediaAssetExists(mediaId, correlationId))) {
      throw new Error(`Multimedia asset ${mediaId} not found.`);
    }
  }

  const segmentId = _normalizeHexId(await generateHexId('narrative_segment_id'));

  const client = await _getClient(correlationId);
  if (!client) throw new Error('Failed to connect to database.');

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO narrative_segments
         (segment_id, title, content, summary, keywords, segment_type,
          associated_character_ids, associated_location_id, sentiment_tags, multimedia_asset_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING segment_id, title, segment_type, created_at`,
      [
        segmentId, title.trim(), content, summary, keywords, segment_type,
        normalizedCharIds, assocLocId, _toJsonb(sentiment_tags), mediaId
      ]
    );
    await client.query('COMMIT');
    Counters.increment('narrative_segment', 'created');
    logger.info('Narrative segment created', { segmentId, title: title.trim(), segmentType: segment_type, correlationId });
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      throw new Error('A narrative segment with this ID already exists.');
    }
    logger.error('Failed to create narrative segment', { error: err.message, correlationId });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves a narrative segment by ID.
 * @param {string} segmentId - Hex segment ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{segment_id: string, title: string, content: string, summary: string|null, keywords: string|null, segment_type: string, associated_character_ids: string[], associated_location_id: string|null, sentiment_tags: object, multimedia_asset_id: string|null, created_at: string, updated_at: string}|null>}
 */
async function getNarrativeSegmentById(segmentId, correlationId) {
  _assertHexId(segmentId, 'segment_id');
  const id = _normalizeHexId(segmentId);
  try {
    const result = await _queryWithTimeout(
      `SELECT segment_id, title, content, summary, keywords, segment_type,
              associated_character_ids, associated_location_id, sentiment_tags,
              multimedia_asset_id, created_at, updated_at
       FROM narrative_segments WHERE segment_id = $1`,
      [id], correlationId
    );
    Counters.increment('narrative_segment', result.rows[0] ? 'found' : 'not_found');
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error('Failed to get narrative segment', { error: err.message, segmentId: id, correlationId });
    Counters.increment('narrative_segment', 'query_failure');
    return null;
  }
}

/**
 * Lists narrative segments with pagination.
 * @param {object} [opts={}] - Pagination options
 * @param {number} [opts.limit=50] - Max results (1-200)
 * @param {number} [opts.offset=0] - Offset for pagination
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<Array<{segment_id: string, title: string, segment_type: string, created_at: string}>>}
 */
async function listNarrativeSegments(opts, correlationId) {
  const { limit, offset } = _clampPagination(opts);
  try {
    const result = await _queryWithTimeout(
      `SELECT segment_id, title, segment_type, created_at
       FROM narrative_segments ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset], correlationId
    );
    Counters.increment('narrative_segment', 'listed');
    return result.rows;
  } catch (err) {
    logger.error('Failed to list narrative segments', { error: err.message, correlationId });
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Narrative Paths                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a new narrative path connecting two segments.
 * @param {object} pathData - Path properties
 * @param {string} pathData.source_segment_id - Hex source segment ID
 * @param {string} pathData.target_segment_id - Hex target segment ID
 * @param {string} pathData.path_type - One of VALID_PATH_TYPES
 * @param {string} [pathData.choice_text] - Required for 'choice_option' type (max 2000 chars)
 * @param {object} [pathData.conditions] - JSONB path conditions
 * @param {object} [pathData.consequences] - JSONB path consequences
 * @param {number} [pathData.order_in_choices] - Display order (non-negative)
 * @param {boolean} [pathData.is_active=true] - Whether path is active
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{path_id: string, source_segment_id: string, target_segment_id: string, path_type: string, choice_text: string|null, created_at: string}>}
 * @throws {Error} On validation failure or database error
 */
async function createNarrativePath(pathData, correlationId) {
  const {
    source_segment_id, target_segment_id, path_type,
    choice_text: rawChoiceText = null, conditions: rawConditions = {},
    consequences: rawConsequences = {}, order_in_choices = null, is_active = true
  } = pathData ?? {};

  _assertHexId(source_segment_id, 'source_segment_id');
  _assertHexId(target_segment_id, 'target_segment_id');

  const sourceId = _normalizeHexId(source_segment_id);
  const targetId = _normalizeHexId(target_segment_id);

  if (sourceId === targetId) {
    throw new Error('Source and target segment IDs cannot be the same (no self-loops).');
  }

  const [srcOk, tgtOk] = await Promise.all([
    narrativeSegmentExists(sourceId, correlationId),
    narrativeSegmentExists(targetId, correlationId)
  ]);
  if (!srcOk) throw new Error(`Source narrative segment ${sourceId} not found.`);
  if (!tgtOk) throw new Error(`Target narrative segment ${targetId} not found.`);

  if (!VALID_PATH_TYPES.includes(path_type)) {
    throw new Error(`Invalid path_type. Must be one of: ${VALID_PATH_TYPES.join(', ')}.`);
  }

  let choiceText = null;
  if (path_type === 'choice_option') {
    if (!_isNonEmptyString(rawChoiceText)) {
      throw new Error('choice_text is required for path_type "choice_option".');
    }
    _assertMaxLength(rawChoiceText, STRING_LIMITS.CHOICE_TEXT, 'choice_text');
    choiceText = rawChoiceText.trim();
  }

  const conditions = (rawConditions && typeof rawConditions === 'object') ? rawConditions : {};
  const consequences = (rawConsequences && typeof rawConsequences === 'object') ? rawConsequences : {};

  if (order_in_choices !== null && (typeof order_in_choices !== 'number' || order_in_choices < 0)) {
    throw new Error('order_in_choices must be a non-negative number when provided.');
  }

  const pathId = _normalizeHexId(await generateHexId('narrative_path_id'));

  const client = await _getClient(correlationId);
  if (!client) throw new Error('Failed to connect to database.');

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO narrative_paths
         (path_id, source_segment_id, target_segment_id, path_type,
          choice_text, conditions, consequences, order_in_choices, is_active)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING path_id, source_segment_id, target_segment_id, path_type, choice_text, created_at`,
      [
        pathId, sourceId, targetId, path_type, choiceText,
        _toJsonb(conditions), _toJsonb(consequences), order_in_choices, Boolean(is_active)
      ]
    );
    await client.query('COMMIT');
    Counters.increment('narrative_path', 'created');
    logger.info('Narrative path created', { pathId, sourceId, targetId, pathType: path_type, correlationId });
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      throw new Error('A narrative path with this ID already exists.');
    }
    logger.error('Failed to create narrative path', { error: err.message, correlationId });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves a narrative path by ID.
 * @param {string} pathId - Hex path ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<{path_id: string, source_segment_id: string, target_segment_id: string, path_type: string, choice_text: string|null, conditions: object, consequences: object, order_in_choices: number|null, is_active: boolean, created_at: string, updated_at: string}|null>}
 */
async function getNarrativePathById(pathId, correlationId) {
  _assertHexId(pathId, 'path_id');
  const id = _normalizeHexId(pathId);
  try {
    const result = await _queryWithTimeout(
      `SELECT path_id, source_segment_id, target_segment_id, path_type,
              choice_text, conditions, consequences, order_in_choices,
              is_active, created_at, updated_at
       FROM narrative_paths WHERE path_id = $1`,
      [id], correlationId
    );
    Counters.increment('narrative_path', result.rows[0] ? 'found' : 'not_found');
    return result.rows[0] ?? null;
  } catch (err) {
    logger.error('Failed to get narrative path', { error: err.message, pathId: id, correlationId });
    Counters.increment('narrative_path', 'query_failure');
    return null;
  }
}

/**
 * Retrieves all active outgoing paths from a segment, ordered by choice position.
 * @param {string} sourceSegmentId - Hex source segment ID
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<Array<{path_id: string, source_segment_id: string, target_segment_id: string, path_type: string, choice_text: string|null, conditions: object, consequences: object, order_in_choices: number|null, is_active: boolean}>>}
 */
async function getOutgoingPaths(sourceSegmentId, correlationId) {
  _assertHexId(sourceSegmentId, 'source_segment_id');
  const id = _normalizeHexId(sourceSegmentId);
  try {
    const result = await _queryWithTimeout(
      `SELECT path_id, source_segment_id, target_segment_id, path_type,
              choice_text, conditions, consequences, order_in_choices, is_active
       FROM narrative_paths
       WHERE source_segment_id = $1 AND is_active = TRUE
       ORDER BY order_in_choices ASC NULLS LAST, path_id ASC`,
      [id], correlationId
    );
    return result.rows;
  } catch (err) {
    logger.error('Failed to get outgoing paths', { error: err.message, sourceSegmentId: id, correlationId });
    return [];
  }
}

/**
 * Lists narrative paths with pagination.
 * @param {object} [opts={}] - Pagination options
 * @param {number} [opts.limit=50] - Max results (1-200)
 * @param {number} [opts.offset=0] - Offset for pagination
 * @param {string} [correlationId] - Request correlation ID
 * @returns {Promise<Array<{path_id: string, source_segment_id: string, target_segment_id: string, path_type: string, choice_text: string|null, created_at: string}>>}
 */
async function listNarrativePaths(opts, correlationId) {
  const { limit, offset } = _clampPagination(opts);
  try {
    const result = await _queryWithTimeout(
      `SELECT path_id, source_segment_id, target_segment_id, path_type, choice_text, created_at
       FROM narrative_paths ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset], correlationId
    );
    Counters.increment('narrative_path', 'listed');
    return result.rows;
  } catch (err) {
    logger.error('Failed to list narrative paths', { error: err.message, correlationId });
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export {
  characterExists,
  multimediaAssetExists,
  locationExists,
  narrativeSegmentExists,
  createMultimediaAsset,
  getMultimediaAssetById,
  listMultimediaAssets,
  createLocation,
  getLocationById,
  listLocations,
  createNarrativeSegment,
  getNarrativeSegmentById,
  listNarrativeSegments,
  createNarrativePath,
  getNarrativePathById,
  getOutgoingPaths,
  listNarrativePaths
};

export default {
  characterExists,
  multimediaAssetExists,
  locationExists,
  narrativeSegmentExists,
  createMultimediaAsset,
  getMultimediaAssetById,
  listMultimediaAssets,
  createLocation,
  getLocationById,
  listLocations,
  createNarrativeSegment,
  getNarrativeSegmentById,
  listNarrativeSegments,
  createNarrativePath,
  getNarrativePathById,
  getOutgoingPaths,
  listNarrativePaths
};
