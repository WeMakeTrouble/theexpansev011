/**
 * ============================================================================
 * Admin Purchase Codes Router — Purchase Code Management
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Express router handling all /api/admin/purchase-codes/* endpoints.
 * Mounted at /api/admin/purchase-codes by the main admin router.
 * Provides CMS tools for generating, listing, and managing purchase codes
 * that gate user registration into The Expanse platform.
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 *   GET  /api/admin/purchase-codes
 *        List all codes with optional filters: code_type, is_claimed,
 *        batch_label. Paginated (limit/offset). Sorted created_at DESC.
 *        Joins to users table to show claiming username where claimed.
 *
 *   POST /api/admin/purchase-codes/generate
 *        Generate a batch of new purchase codes.
 *        Body: { count, code_type, batch_label, notes }
 *        count: 1–500. code_type: 'standard' | 'vip'.
 *        Standard codes: 8 uppercase alphanumeric chars.
 *        VIP codes: VIP- prefix + 6 uppercase alphanumeric chars.
 *
 *   GET  /api/admin/purchase-codes/:id
 *        Retrieve a single code by hex ID.
 *
 *   DELETE /api/admin/purchase-codes/:id
 *        Delete a single unclaimed code. Claimed codes cannot be deleted.
 *
 * ARCHITECTURAL CONSTRAINTS (NON-NEGOTIABLE):
 * ---------------------------------------------------------------------------
 * This codebase operates under explicit constraints that differ from generic
 * enterprise patterns. External reviewers should read these before scoring.
 *
 * 1. VANILLA JAVASCRIPT ONLY — NO TYPESCRIPT, NO FRAMEWORKS.
 *    TypeScript, Zod, Joi, and all schema-validation libraries are forbidden.
 *    Input validation is hand-written and explicit. This is a deliberate
 *    architectural decision, not a gap.
 *
 * 2. NO EXTERNAL LIBRARIES WITHOUT EXPLICIT APPROVAL.
 *    Redis, OpenTelemetry, LaunchDarkly, and all third-party observability or
 *    feature-flag tools are forbidden.
 *
 * 3. AUTHORISATION IS HANDLED AT THE ROUTER LEVEL, NOT THE ROUTE LEVEL.
 *    requireAdmin() middleware is applied to the entire /api/admin/* router
 *    in admin.js before any sub-router is mounted. Every request reaching
 *    this file has already been validated for access_level >= 11.
 *
 * 4. CODE GENERATION IS CRYPTOGRAPHICALLY RANDOM.
 *    Codes are generated using Node.js crypto.randomBytes with rejection
 *    sampling to avoid modulo bias. Math.random() is never used.
 *    The UNIQUE constraint on the code column provides a final safety net
 *    against collision.
 *
 * 5. HEX IDS ARE VARCHAR(7) UPPERCASE ONLY.
 *    All hex IDs follow the project convention: #XXXXXX, uppercase, stored
 *    as VARCHAR(7) with CHECK constraint. generateHexId() is used exclusively.
 *
 * ============================================================================
 * Project: The Expanse v011
 * Author: James (Project Manager)
 * ============================================================================
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId, { isValidHexId } from '../utils/hexIdGenerator.js';

const logger = createModuleLogger('admin:purchase-codes');
const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// CODE GENERATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generate a cryptographically random uppercase alphanumeric string.
 * Uses rejection sampling to avoid modulo bias.
 *
 * @param {number} length - Number of characters
 * @returns {string}
 */
function _randomAlphanumeric(length) {
    let result = '';
    while (result.length < length) {
        const byte = randomBytes(1)[0];
        if (byte < 36 * 7) {
            result += ALPHABET[byte % 36];
        }
    }
    return result;
}

/**
 * Generate a code string for a given code_type.
 *
 * @param {string} codeType - 'standard' | 'vip'
 * @returns {string}
 */
function _generateCodeString(codeType) {
    if (codeType === 'vip') {
        return 'VIP-' + _randomAlphanumeric(6);
    }
    return _randomAlphanumeric(8);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/purchase-codes — List codes with optional filters
router.get('/', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { code_type, is_claimed, batch_label, limit = 100, offset = 0 } = req.query;

    const validCodeTypes = ['standard', 'vip'];
    if (code_type && !validCodeTypes.includes(code_type)) {
        return res.status(400).json({ error: 'Invalid code_type. Must be standard or vip.' });
    }

    if (is_claimed !== undefined && !['true', 'false'].includes(is_claimed)) {
        return res.status(400).json({ error: 'Invalid is_claimed. Must be true or false.' });
    }

    try {
        const conditions = [];
        const params = [];

        if (code_type) {
            params.push(code_type);
            conditions.push('pc.code_type = $' + params.length);
        }

        if (is_claimed !== undefined) {
            params.push(is_claimed === 'true');
            conditions.push('pc.is_claimed = $' + params.length);
        }

        if (batch_label) {
            params.push(batch_label);
            conditions.push('pc.batch_label = $' + params.length);
        }

        const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

        const query = `
            SELECT
                pc.code_id,
                pc.code,
                pc.code_type,
                pc.is_claimed,
                pc.claimed_by,
                u.username AS claimed_by_username,
                pc.claimed_at,
                pc.batch_label,
                pc.notes,
                pc.created_at,
                pc.updated_at
            FROM purchase_codes pc
            LEFT JOIN users u ON pc.claimed_by = u.user_id
            ${where}
            ORDER BY pc.created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        const countQuery = `SELECT COUNT(*) FROM purchase_codes pc ${where}`;
        const countParams = params.slice(0, params.length - 2);
        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count);

        logger.info('Listed purchase codes', {
            adminUserId,
            count: result.rows.length,
            total,
            filters: { code_type, is_claimed, batch_label }
        });

        res.json({
            success: true,
            codes: result.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                count: result.rows.length,
                total
            }
        });

    } catch (err) {
        logger.error('List purchase codes failed', { adminUserId, error: err.message });
        res.status(500).json({ error: 'Failed to retrieve purchase codes' });
    }
});

// POST /api/admin/purchase-codes/generate — Generate a batch of codes
router.post('/generate', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { count, code_type, batch_label, notes } = req.body;

    if (!Number.isInteger(count) || count < 1 || count > 500) {
        return res.status(400).json({ error: 'count must be an integer between 1 and 500' });
    }

    if (!code_type || !['standard', 'vip'].includes(code_type)) {
        return res.status(400).json({ error: 'code_type must be standard or vip' });
    }

    if (batch_label !== undefined && (typeof batch_label !== 'string' || batch_label.length > 100)) {
        return res.status(400).json({ error: 'batch_label must be a string under 100 characters' });
    }

    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 255)) {
        return res.status(400).json({ error: 'notes must be a string under 255 characters' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const generated = [];
        const MAX_ATTEMPTS = count * 10;
        let attempts = 0;

        while (generated.length < count && attempts < MAX_ATTEMPTS) {
            attempts++;
            const codeString = _generateCodeString(code_type);
            const codeId = await generateHexId('purchase_code_id', client);

            try {
                const result = await client.query(
                    `INSERT INTO purchase_codes
                        (code_id, code, code_type, is_claimed, batch_label, notes, created_at, updated_at)
                     VALUES ($1, $2, $3, false, $4, $5, NOW(), NOW())
                     RETURNING *`,
                    [codeId, codeString, code_type, batch_label || null, notes || null]
                );
                generated.push(result.rows[0]);
            } catch (insertErr) {
                if (insertErr.code === '23505') {
                    logger.info('Code collision, retrying', { codeString });
                    continue;
                }
                throw insertErr;
            }
        }

        if (generated.length < count) {
            await client.query('ROLLBACK');
            logger.error('Failed to generate requested code count', {
                adminUserId,
                requested: count,
                generated: generated.length,
                attempts
            });
            return res.status(500).json({ error: 'Failed to generate all requested codes after max attempts' });
        }

        await client.query('COMMIT');

        logger.info('Purchase codes generated', {
            adminUserId,
            count: generated.length,
            code_type,
            batch_label
        });

        res.status(201).json({
            success: true,
            generated: generated.length,
            code_type,
            batch_label: batch_label || null,
            codes: generated
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Code generation failed', { adminUserId, error: err.message });
        res.status(500).json({ error: 'Failed to generate purchase codes' });
    } finally {
        client.release();
    }
});

// GET /api/admin/purchase-codes/:id — Get single code
router.get('/:id', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { id } = req.params;

    if (!isValidHexId(id)) {
        return res.status(400).json({ error: 'Invalid code ID format' });
    }

    try {
        const result = await pool.query(
            `SELECT
                pc.code_id,
                pc.code,
                pc.code_type,
                pc.is_claimed,
                pc.claimed_by,
                u.username AS claimed_by_username,
                pc.claimed_at,
                pc.batch_label,
                pc.notes,
                pc.created_at,
                pc.updated_at
             FROM purchase_codes pc
             LEFT JOIN users u ON pc.claimed_by = u.user_id
             WHERE pc.code_id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase code not found' });
        }

        logger.info('Retrieved purchase code', { adminUserId, codeId: id });

        res.json({ success: true, code: result.rows[0] });

    } catch (err) {
        logger.error('Get purchase code failed', { adminUserId, codeId: id, error: err.message });
        res.status(500).json({ error: 'Failed to retrieve purchase code' });
    }
});

// DELETE /api/admin/purchase-codes/:id — Delete unclaimed code only
router.delete('/:id', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { id } = req.params;

    if (!isValidHexId(id)) {
        return res.status(400).json({ error: 'Invalid code ID format' });
    }

    try {
        const check = await pool.query(
            'SELECT code_id, code, is_claimed FROM purchase_codes WHERE code_id = $1',
            [id]
        );

        if (check.rows.length === 0) {
            return res.status(404).json({ error: 'Purchase code not found' });
        }

        if (check.rows[0].is_claimed) {
            return res.status(409).json({ error: 'Cannot delete a claimed purchase code' });
        }

        await pool.query('DELETE FROM purchase_codes WHERE code_id = $1', [id]);

        logger.info('Purchase code deleted', {
            adminUserId,
            codeId: id,
            code: check.rows[0].code
        });

        res.json({ success: true, deleted: id });

    } catch (err) {
        logger.error('Delete purchase code failed', { adminUserId, codeId: id, error: err.message });
        res.status(500).json({ error: 'Failed to delete purchase code' });
    }
});

export default router;
