/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HEX ID GENERATOR v010 — Canonical ID Authority for The Expanse
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Thin wrapper around the PostgreSQL generate_hex_id() function.
 * Single point of entry for generating and inspecting semantic hex IDs
 * across The Expanse codebase.
 *
 * Every important row uses a PURPOSED HEX ID — never UUIDs, never integers,
 * never random strings.
 *
 * Examples:
 *   #700002  → Character (Claude)
 *   #D00006  → User
 *   #DB8000  → Dossier
 *   #DE0001  → Narrative Arc
 *
 * ---------------------------------------------------------------------------
 * ARCHITECTURE (v010):
 * ---------------------------------------------------------------------------
 * v009: JavaScript managed counters via hex_id_counters table.
 *       HEX_RANGES hardcoded in this file. Read-increment-write in JS.
 *
 * v010: Database manages everything via hex_id_ranges table.
 *       Atomic generate_hex_id() PostgreSQL function handles:
 *         - Range existence validation
 *         - Atomic counter increment (no race conditions)
 *         - Exhaustion detection and status transition
 *         - Overlap prevention (GiST exclusion constraint)
 *         - Allotment cap enforcement (25,000 default)
 *         - Warning threshold monitoring (21,000 default)
 *         - Metrics tracking (total_assignments, last_assigned_at)
 *
 * This file NO LONGER:
 *   - Defines HEX_RANGES
 *   - Manages counters
 *   - Performs read-increment-write logic
 *   - Opens manual transactions for ID generation
 *
 * The database is the single source of truth.
 *
 * ---------------------------------------------------------------------------
 * HOW IDS ARE GENERATED:
 * ---------------------------------------------------------------------------
 * 1. Caller invokes: await generateHexId('known_purpose')
 *    — or within a transaction: await generateHexId('known_purpose', client)
 * 2. Input is validated (non-empty string, no whitespace padding)
 * 3. PostgreSQL function generate_hex_id(id_type) is called:
 *      - Increments counter atomically
 *      - Enforces allotment caps and range bounds
 *      - Updates metrics and status (active → exhausted)
 *      - Returns '#XXXXXX' (6 uppercase hex digits)
 * 4. The formatted hex ID is returned to the caller
 *
 * ---------------------------------------------------------------------------
 * TRANSACTION DISCIPLINE:
 * ---------------------------------------------------------------------------
 * IDs MUST be generated and INSERTed inside the SAME DATABASE TRANSACTION.
 *
 * To achieve this, pass the transaction client as the second argument:
 *
 *   const client = await pool.connect();
 *   try {
 *       await client.query('BEGIN');
 *       const id = await generateHexId('character_id', client);
 *       await client.query('INSERT INTO characters (id, name) VALUES ($1, $2)', [id, name]);
 *       await client.query('COMMIT');
 *   } catch (err) {
 *       await client.query('ROLLBACK');
 *       throw err;
 *   } finally {
 *       client.release();
 *   }
 *
 * If called without a client (pool.query), the ID is auto-committed.
 * This means if the subsequent INSERT fails, the ID is consumed (gap).
 * Gaps are acceptable in The Expanse — IDs are identity markers, not
 * sequential counters.
 *
 * ---------------------------------------------------------------------------
 * CORE RULES (DO NOT VIOLATE):
 * ---------------------------------------------------------------------------
 * 1. SINGLE SOURCE OF TRUTH
 *    - All purposes and ranges live in the hex_id_ranges table
 *    - No ad-hoc hex logic anywhere else in the codebase
 *
 * 2. PURPOSE-DRIVEN ONLY
 *    - Always call generateHexId('known_purpose')
 *    - Invalid or mistyped purposes THROW
 *
 * 3. TRANSACTION DISCIPLINE
 *    - ID generation and INSERT should be atomic where possible
 *    - Pass transaction client to generateHexId for strict coupling
 *
 * 4. DB-ENFORCED FORMAT
 *    - Tables MUST enforce: CHECK (id_column ~ '^#[0-9A-F]{6}$')
 *
 * 5. NO EXTERNAL IDS — EVER
 *    - No UUIDs
 *    - No integers
 *    - No random strings
 *
 * ---------------------------------------------------------------------------
 * EXPORTS:
 * ---------------------------------------------------------------------------
 *   default: generateHexId(idType, queryable?)
 *     → Generates a new hex ID. Async. Accepts optional client for tx.
 *
 *   isValidHexId(hexId)
 *     → Validates '#XXXXXX' format. Synchronous. No DB access.
 *
 *   getIdType(hexId)
 *     → ASYNC (changed from sync in v009). Returns id_type string from
 *       hex_id_ranges, 'unknown' if no match, or null if invalid format.
 *
 *   validateDependencies()
 *     → ASYNC. Call at server startup to verify the generate_hex_id()
 *       PostgreSQL function exists and hex_id_ranges table is accessible.
 *       Throws if infrastructure is missing.
 *
 * ---------------------------------------------------------------------------
 * FORMAT GUARANTEE:
 * ---------------------------------------------------------------------------
 *   #XXXXXX  (6 uppercase hexadecimal digits with leading '#')
 *
 * ⚠️ BACKEND-ONLY MODULE
 * Requires PostgreSQL connection. Do NOT import into frontend or shared code.
 *
 * This file is infrastructure. Treat changes as schema-level decisions.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

// ═══════════════════════════════════════════════════════════════════════════
// MODULE SETUP
// ═══════════════════════════════════════════════════════════════════════════

const logger = createModuleLogger('hexIdGenerator');


// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY RANGE CACHE (for synchronous ID type lookups)
// ═══════════════════════════════════════════════════════════════════════════

let idTypeCache = [];
let cacheLoaded = false;

export async function loadIdTypeCache() {
    try {
        const result = await pool.query({
            text: `SELECT id_type, range_start, range_end
                   FROM hex_id_ranges
                   WHERE status IN ('active', 'exhausted', 'reserved')
                   ORDER BY range_start`,
            timeout: HEX_ID_CONFIG.QUERY_TIMEOUT_MS
        });

        idTypeCache = result.rows;
        cacheLoaded = true;

        logger.info('ID type cache loaded for synchronous lookup', {
            count: idTypeCache.length
        });

        return idTypeCache.length;
    } catch (err) {
        logger.error('Failed to load ID type cache', { error: err.message });
        throw err;
    }
}

export function getIdTypeSync(hexId) {
    if (!isValidHexId(hexId)) {
        return null;
    }

    if (!cacheLoaded) {
        logger.warn('getIdTypeSync called before cache loaded', { hexId });
        return 'unknown';
    }

    const numericValue = parseInt(hexId.slice(1), 16);

    for (const range of idTypeCache) {
        if (numericValue >= range.range_start && numericValue <= range.range_end) {
            return range.id_type;
        }
    }

    return 'unknown';
}
/**
 * Frozen configuration constants.
 * HEX_ID_PATTERN accepts both upper and lowercase for validation
 * (backward compatibility with existing callers), but the generator
 * always produces uppercase via the database function.
 */
const HEX_ID_CONFIG = Object.freeze({
    PATTERN: /^#[0-9A-Fa-f]{6}$/,
    MAX_ID_TYPE_LENGTH: 50,
    QUERY_TIMEOUT_MS: 5000
});

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates that a queryable object has a .query() method.
 * Prevents silent runtime errors if caller passes wrong argument.
 *
 * @param {object} queryable - Expected to be pool or pg client.
 * @throws {TypeError} If queryable does not have a query method.
 */
function _assertQueryable(queryable) {
    if (!queryable || typeof queryable.query !== 'function') {
        throw new TypeError(
            'generateHexId: queryable must be a pg pool or client with a .query() method'
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE ID GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a new hex ID for the given purpose.
 *
 * @param {string} idType - Purpose string, must exist in hex_id_ranges.
 *   Must be an exact match — no whitespace trimming is performed.
 * @param {object} [queryable=pool] - Database client or pool.
 *   Pass a transaction client to couple ID generation with INSERT.
 *   Pass pool (default) for auto-committed standalone generation.
 * @returns {Promise<string>} Hex ID in '#XXXXXX' format.
 * @throws {Error} If idType is invalid, range is exhausted/inactive/missing,
 *   or database connection fails.
 * @throws {TypeError} If queryable does not have a .query() method.
 */
async function generateHexId(idType, queryable = pool) {
    if (typeof idType !== 'string' || idType.length === 0) {
        const error = new Error(
            `generateHexId: idType must be a non-empty string. Received: ${String(idType)}`
        );
        logger.error('Hex ID generation failed: invalid idType', {
            idType: String(idType)
        });
        throw error;
    }

    if (idType !== idType.trim()) {
        const error = new Error(
            `generateHexId: idType must not contain leading or trailing whitespace. Received: "${idType}"`
        );
        logger.error('Hex ID generation failed: idType has whitespace padding', {
            idType
        });
        throw error;
    }

    if (idType.length > HEX_ID_CONFIG.MAX_ID_TYPE_LENGTH) {
        const error = new Error(
            `generateHexId: idType exceeds maximum length of ${HEX_ID_CONFIG.MAX_ID_TYPE_LENGTH}. Received length: ${idType.length}`
        );
        logger.error('Hex ID generation failed: idType too long', {
            idType,
            length: idType.length
        });
        throw error;
    }

    _assertQueryable(queryable);

    const startTime = Date.now();

    try {
        const result = await queryable.query({
            text: 'SELECT generate_hex_id($1) AS hex_id',
            values: [idType],
            timeout: HEX_ID_CONFIG.QUERY_TIMEOUT_MS
        });

        const hexId = result.rows[0]?.hex_id;

        if (!hexId || !HEX_ID_CONFIG.PATTERN.test(hexId)) {
            const error = new Error(
                `generateHexId: database returned invalid hex ID "${hexId}" for idType "${idType}"`
            );
            logger.error('Hex ID generation failed: invalid format from database', {
                idType,
                hexId
            });
            throw error;
        }

        const durationMs = Date.now() - startTime;
        logger.debug('Hex ID generated', { idType, hexId, durationMs });
        return hexId;

    } catch (err) {
        if (!err.message.startsWith('generateHexId:')) {
            const durationMs = Date.now() - startTime;
            logger.error('Hex ID generation failed', {
                idType,
                durationMs,
                error: err.message,
                sqlState: err.code
            });
        }
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMAT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate whether a string matches the canonical hex ID format: '#XXXXXX'.
 * Pure function — no database access.
 *
 * Accepts both upper and lowercase hex digits for backward compatibility.
 * The generator always produces uppercase.
 *
 * @param {string} hexId - The string to validate.
 * @returns {boolean} True if valid '#XXXXXX' format.
 */
export function isValidHexId(hexId) {
    if (typeof hexId !== 'string') {
        return false;
    }
    return HEX_ID_CONFIG.PATTERN.test(hexId);
}

// ═══════════════════════════════════════════════════════════════════════════
// REVERSE LOOKUP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine which id_type range contains a given hex ID.
 *
 * ⚠️ BREAKING CHANGE from v009: This function is now ASYNC.
 * Callers that used `const type = getIdType(id)` must update to
 * `const type = await getIdType(id)`.
 *
 * Queries hex_id_ranges table. Excludes retired ranges — a retired
 * range's IDs are no longer considered part of the active system.
 * Active, exhausted, and reserved ranges are all valid for lookup
 * because their IDs still exist in the database.
 *
 * On database error, returns 'unknown' rather than throwing.
 * This preserves backward compatibility — callers expect a string
 * return and use it for logging/debugging, not critical branching.
 * Database errors are logged at warn level for operational visibility.
 *
 * @param {string} hexId - e.g. '#700002'
 * @returns {Promise<string|null>} id_type string, 'unknown' if no match,
 *   or null if hexId format is invalid.
 */
export async function getIdType(hexId) {
    if (!isValidHexId(hexId)) {
        return null;
    }

    const numericValue = parseInt(hexId.slice(1), 16);

    try {
        const result = await pool.query({
            text: `SELECT id_type
                   FROM hex_id_ranges
                   WHERE range_start <= $1
                     AND range_end >= $1
                     AND status IN ('active', 'exhausted', 'reserved')
                   LIMIT 1`,
            values: [numericValue],
            timeout: HEX_ID_CONFIG.QUERY_TIMEOUT_MS
        });

        if (result.rows.length === 0) {
            return 'unknown';
        }

        return result.rows[0].id_type;

    } catch (err) {
        logger.warn('getIdType lookup failed, returning unknown', {
            hexId,
            error: err.message,
            sqlState: err.code
        });
        return 'unknown';
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify that the hex ID infrastructure is available.
 * Call this ONCE at server startup to catch configuration errors early.
 *
 * Checks:
 *   1. hex_id_ranges table is accessible
 *   2. generate_hex_id() PostgreSQL function exists
 *   3. At least one active range is registered
 *
 * @returns {Promise<{ rangeCount: number, activeCount: number }>}
 *   Summary of registered ranges for startup logging.
 * @throws {Error} If infrastructure is missing or inaccessible.
 */
export async function validateDependencies() {
    try {
        const rangeCheck = await pool.query({
            text: `SELECT
                       COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                       COUNT(*) FILTER (WHERE status = 'exhausted')::int AS exhausted
                   FROM hex_id_ranges`,
            timeout: HEX_ID_CONFIG.QUERY_TIMEOUT_MS
        });

        const { total, active, exhausted } = rangeCheck.rows[0];

        if (total === 0) {
            throw new Error('hex_id_ranges table is empty — no ranges registered');
        }

        if (active === 0) {
            throw new Error(
                `hex_id_ranges has ${total} ranges but none are active (${exhausted} exhausted)`
            );
        }

        const fnCheck = await pool.query({
            text: `SELECT proname FROM pg_proc WHERE proname = 'generate_hex_id' LIMIT 1`,
            timeout: HEX_ID_CONFIG.QUERY_TIMEOUT_MS
        });

        if (fnCheck.rows.length === 0) {
            throw new Error('generate_hex_id() PostgreSQL function does not exist');
        }

        logger.info('Hex ID infrastructure validated', {
            totalRanges: total,
            activeRanges: active,
            exhaustedRanges: exhausted
        });

        return { rangeCount: total, activeCount: active };

    } catch (err) {
        logger.error('Hex ID infrastructure validation failed', {
            error: err.message
        });
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export default generateHexId;
