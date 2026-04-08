import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId, { isValidHexId } from '../utils/hexIdGenerator.js';
import multer from 'multer';
import assetManager from '../services/assetManager.js';

const logger = createModuleLogger('merch:admin');

// ─────────────────────────────────────────────────────────────────────────────
// ZOD SCHEMAS (Reusable, declarative validation)
// ─────────────────────────────────────────────────────────────────────────────

const pricingSchema = z.object({
    region_code: z.string().min(2).max(10),
    price_cents: z.number().int().min(100, 'Price must be at least $1.00'),
    stripe_product_id: z.string().min(3),
    stripe_price_id: z.string().min(3)
});

const optionSchema = z.object({
    value: z.string().min(1).max(100),
    upcharge_cents: z.number().int().min(0).default(0),
    metadata: z.record(z.any()).default({})
});

const optionGroupSchema = z.object({
    group_name: z.string().min(1).max(100),
    is_required: z.boolean().default(true),
    options: z.array(optionSchema).min(1, 'Each group must have at least one option')
});

const createDropSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    total_units: z.number().int().min(1).max(1000).default(75),
    status: z.enum(['draft', 'upcoming', 'live', 'sold_out', 'closed']).default('draft'),
    pricing: z.array(pricingSchema).min(1, 'At least one pricing entry required'),
    option_groups: z.array(optionGroupSchema).optional(),
    metadata: z.record(z.any()).optional()
}).refine((data) => {
    if (data.option_groups && data.option_groups.length > 0) {
        const names = data.option_groups.map(g => g.group_name.toLowerCase());
        return new Set(names).size === names.length;
    }
    return true;
}, {
    message: 'Duplicate option group names not allowed',
    path: ['option_groups']
}).refine((data) => {
    const codes = data.pricing.map(p => p.region_code.toLowerCase());
    return new Set(codes).size === codes.length;
}, {
    message: 'Duplicate region codes in pricing not allowed',
    path: ['pricing']
});

const updateDropSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    metadata: z.record(z.any()).optional()
}).strict();

const statusUpdateSchema = z.object({
    status: z.enum(['draft', 'upcoming', 'live', 'sold_out', 'closed'])
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS TRANSITION RULES (State machine enforcement)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
    'draft': ['upcoming', 'closed'],
    'upcoming': ['live', 'closed'],
    'live': ['sold_out', 'closed'],
    'sold_out': ['closed'],
    'closed': []
};

function isValidTransition(fromStatus, toStatus) {
    return VALID_TRANSITIONS[fromStatus]?.includes(toStatus) || false;
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER (Admin endpoints)
// ─────────────────────────────────────────────────────────────────────────────

const adminRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    keyGenerator: (req) => req.user?.user_id || ipKeyGenerator(req),
    handler: (req, res) => {
        res.status(429).json({
            error: 'Too many admin requests',
            retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH & AUDIT HELPERS
// ─────────────────────────────────────────────────────────────────────────────


async function auditLog(client, adminUserId, action, dropId, details, ipAddress) {
    try {
        const auditId = await generateHexId('merch_audit_log_id', client);
        await client.query(
            `INSERT INTO merch_audit_log (id, admin_user_id, action, drop_id, details, ip_address, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [auditId, adminUserId, action, dropId, JSON.stringify(details), ipAddress]
        );
    } catch (err) {
        logger.error('Audit log failed', { adminUserId, action, dropId, error: err.message });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();


// GET /api/merch/admin/drops - List drops with filtering
router.get('/drops', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { status, limit = 20, offset = 0 } = req.query;

    try {
        let query = 'SELECT * FROM merch_drops';
        const params = [];

        if (status && ['draft', 'upcoming', 'live', 'sold_out', 'closed'].includes(status)) {
            query += ' WHERE status = $1';
            params.push(status);
        }

        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        logger.info('Listed drops', { adminUserId, count: result.rows.length, filter: status });

        res.json({
            drops: result.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                count: result.rows.length
            }
        });
    } catch (err) {
        logger.error('List drops failed', { adminUserId, error: err.message });
        res.status(500).json({ error: 'Failed to retrieve drops' });
    }
});

// POST /api/merch/admin/drops - Create new drop
router.post('/drops', async (req, res) => {
    const adminUserId = req.user.user_id;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;

    const parseResult = createDropSchema.safeParse(req.body);
    if (!parseResult.success) {
        const formatted = parseResult.error.format();
        logger.info('Drop creation validation failed', { adminUserId, errors: formatted });
        return res.status(400).json({
            error: 'Validation failed',
            details: formatted
        });
    }

    const data = parseResult.data;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        logger.info('Creating drop', { adminUserId, title: data.title, status: data.status });

        const dropId = await generateHexId('merch_drop_id', client);
        const dropResult = await client.query(
            `INSERT INTO merch_drops (id, title, description, total_units, units_remaining, status, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $4, $5, $6, NOW(), NOW())
             RETURNING *`,
            [
                dropId,
                data.title,
                data.description || '',
                data.total_units,
                data.status,
                JSON.stringify(data.metadata || {})
            ]
        );

        const regionCodes = data.pricing.map(p => p.region_code);
        const regionsResult = await client.query(
            'SELECT id, code FROM regions WHERE code = ANY($1)',
            [regionCodes]
        );
        const regionMap = new Map(regionsResult.rows.map(r => [r.code, r.id]));

        for (const p of data.pricing) {
            const regionId = regionMap.get(p.region_code);
            if (!regionId) {
                throw new Error(`Invalid region code: ${p.region_code}`);
            }
            const pricingId = await generateHexId('merch_drop_pricing_id', client);
            await client.query(
                `INSERT INTO merch_drop_pricing (id, drop_id, region_id, price_cents, stripe_product_id, stripe_price_id)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [pricingId, dropId, regionId, p.price_cents, p.stripe_product_id, p.stripe_price_id]
            );
        }

        if (data.option_groups && data.option_groups.length > 0) {
            for (let i = 0; i < data.option_groups.length; i++) {
                const g = data.option_groups[i];
                const groupId = await generateHexId('merch_option_group_id', client);
                await client.query(
                    `INSERT INTO merch_option_groups (id, drop_id, group_name, display_order, is_required)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [groupId, dropId, g.group_name, i, g.is_required]
                );

                for (let j = 0; j < g.options.length; j++) {
                    const o = g.options[j];
                    const optionId = await generateHexId('merch_option_id', client);
                    await client.query(
                        `INSERT INTO merch_options (id, group_id, option_value, upcharge_cents, metadata, display_order)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [
                            optionId,
                            groupId,
                            o.value,
                            o.upcharge_cents,
                            JSON.stringify(o.metadata),
                            j
                        ]
                    );
                }
            }
        }

        await client.query('COMMIT');

        const auditClient = await pool.connect();
        try {
            await auditClient.query('BEGIN');
            await auditLog(auditClient, adminUserId, 'create_drop', dropId, {
                title: data.title,
                total_units: data.total_units,
                status: data.status,
                pricing_regions: data.pricing.map(p => p.region_code),
                pricing_count: data.pricing.length,
                option_groups_count: data.option_groups?.length || 0
            }, clientIp);
            await auditClient.query('COMMIT');
        } catch (auditErr) {
            await auditClient.query('ROLLBACK').catch(() => {});
            logger.error('Audit log failed after drop creation', { error: auditErr.message });
        } finally {
            auditClient.release();
        }

        logger.info('Drop created successfully', { adminUserId, dropId, title: data.title });

        if (data.status === 'live') {
            logger.warn('DROP CREATED AS LIVE - Immediate sales active', { adminUserId, dropId, title: data.title });
        }

        res.status(201).json({
            id: dropId,
            ...dropResult.rows[0],
            message: 'Drop created successfully'
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Drop creation failed', { adminUserId, error: err.message });
        res.status(500).json({ error: 'Failed to create drop. Please try again.' });
    } finally {
        client.release();
    }
});

// PATCH /api/merch/admin/drops/:id - Full update (title, description, metadata)
router.patch('/drops/:id', async (req, res) => {
    const adminUserId = req.user.user_id;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const { id } = req.params;

    const parseResult = updateDropSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({
            error: 'Validation failed',
            details: parseResult.error.format()
        });
    }

    const updates = parseResult.data;
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const currentResult = await client.query('SELECT * FROM merch_drops WHERE id = $1', [id]);
        if (currentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Drop not found' });
        }
        const before = currentResult.rows[0];

        const fields = [];
        const values = [];
        let paramCount = 1;

        if (updates.title) {
            fields.push(`title = $${paramCount++}`);
            values.push(updates.title);
        }
        if (updates.description !== undefined) {
            fields.push(`description = $${paramCount++}`);
            values.push(updates.description);
        }
        if (updates.metadata) {
            fields.push(`metadata = $${paramCount++}`);
            values.push(JSON.stringify(updates.metadata));
        }
        fields.push(`updated_at = NOW()`);

        values.push(id);
        const query = `UPDATE merch_drops SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`;

        const result = await client.query(query, values);
        const after = result.rows[0];

        const changedFields = {};
        for (const key of Object.keys(updates)) {
            changedFields[key] = { before: before[key], after: after[key] };
        }

        await auditLog(client, adminUserId, 'update_drop', id, {
            changed_fields: changedFields,
            updated_fields: Object.keys(updates)
        }, clientIp);

        await client.query('COMMIT');

        logger.info('Drop updated', { adminUserId, dropId: id, fields: Object.keys(updates) });

        res.json({
            ...after,
            message: 'Drop updated successfully',
            changes: Object.keys(updates)
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Drop update failed', { adminUserId, dropId: id, error: err.message });
        res.status(500).json({ error: 'Failed to update drop' });
    } finally {
        client.release();
    }
});

// PATCH /api/merch/admin/drops/:id/status - Status change with transition rules
router.patch('/drops/:id/status', async (req, res) => {
    const adminUserId = req.user.user_id;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const { id } = req.params;

    const parseResult = statusUpdateSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({
            error: 'Invalid status',
            valid_statuses: ['draft', 'upcoming', 'live', 'sold_out', 'closed']
        });
    }

    const newStatus = parseResult.data.status;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const currentResult = await client.query(
            'SELECT * FROM merch_drops WHERE id = $1 FOR UPDATE',
            [id]
        );

        if (currentResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Drop not found' });
        }

        const drop = currentResult.rows[0];
        const oldStatus = drop.status;

        if (!isValidTransition(oldStatus, newStatus)) {
            await client.query('ROLLBACK');
            logger.warn('Invalid status transition blocked', {
                adminUserId,
                dropId: id,
                from: oldStatus,
                to: newStatus
            });

            return res.status(400).json({
                error: `Invalid status transition: cannot go from ${oldStatus} to ${newStatus}`,
                valid_transitions: VALID_TRANSITIONS[oldStatus] || []
            });
        }

        const result = await client.query(
            'UPDATE merch_drops SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [newStatus, id]
        );

        const updatedDrop = result.rows[0];

        await auditLog(client, adminUserId, 'update_status', id, {
            status_transition: { from: oldStatus, to: newStatus },
            drop_title: updatedDrop.title
        }, clientIp);

        await client.query('COMMIT');

        logger.info('Status updated', {
            adminUserId,
            dropId: id,
            fromStatus: oldStatus,
            toStatus: newStatus,
            title: updatedDrop.title
        });

        if (newStatus === 'live') {
            logger.warn('DROP IS NOW LIVE - Sales active', {
                adminUserId,
                dropId: id,
                title: updatedDrop.title,
                units: updatedDrop.total_units
            });
        }

        if (newStatus === 'sold_out') {
            logger.info('Drop marked as sold out', {
                adminUserId,
                dropId: id,
                title: updatedDrop.title
            });
        }

        res.json({
            ...updatedDrop,
            message: `Status updated from ${oldStatus} to ${newStatus}`,
            transition: { from: oldStatus, to: newStatus }
        });

    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Status update failed', { adminUserId, dropId: id, error: err.message });
        res.status(500).json({ error: 'Failed to update status' });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA ROUTES
// ─────────────────────────────────────────────────────────────────────────────

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

router.get('/drops/:id/media', async (req, res) => {
    const dropId = decodeURIComponent(req.params.id);
    if (!isValidHexId(dropId)) return res.status(400).json({ error: 'Invalid drop ID' });
    try {
        const result = await pool.query(
            'SELECT * FROM merch_drop_media WHERE drop_id = $1 ORDER BY display_order ASC',
            [dropId]
        );
        res.json({ success: true, media: result.rows });
    } catch (err) {
        logger.error('List media failed', { dropId, error: err.message });
        res.status(500).json({ error: 'Failed to list media' });
    }
});

router.post('/drops/:id/media/image', upload.single('file'), async (req, res) => {
    const dropId = decodeURIComponent(req.params.id);
    if (!isValidHexId(dropId)) return res.status(400).json({ error: 'Invalid drop ID' });
    if (!req.file) return res.status(400).json({ error: 'No image file provided. Use field name "file"' });
    const adminUserId = req.user?.user_id;
    const client = await pool.connect();
    try {
        const dropCheck = await client.query('SELECT id FROM merch_drops WHERE id = $1', [dropId]);
        if (dropCheck.rows.length === 0) return res.status(404).json({ error: 'Drop not found' });
        const asset = await assetManager.createAsset({
            buffer: req.file.buffer,
            originalFilename: req.file.originalname,
            applyCrt: false,
            generateVariants: true
        });
        await client.query('BEGIN');
        const mediaId = await generateHexId('merch_drop_media_id');
        const orderResult = await client.query(
            'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM merch_drop_media WHERE drop_id = $1',
            [dropId]
        );
        const displayOrder = orderResult.rows[0].next_order;
        const primaryResult = await client.query(
            'SELECT id FROM merch_drop_media WHERE drop_id = $1 AND is_primary = true',
            [dropId]
        );
        const isPrimary = primaryResult.rows.length === 0;
        const insertResult = await client.query(
            'INSERT INTO merch_drop_media (id, drop_id, asset_id, media_type, display_order, is_primary) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [mediaId, dropId, asset.assetId, 'image', displayOrder, isPrimary]
        );
        await client.query('COMMIT');
        logger.info('Merch image uploaded', { adminUserId, dropId, mediaId, assetId: asset.assetId });
        res.status(201).json({ success: true, media: insertResult.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Merch image upload failed', { dropId, error: err.message });
        res.status(500).json({ error: 'Image upload failed' });
    } finally {
        client.release();
    }
});

router.post('/drops/:id/media/video', async (req, res) => {
    const dropId = decodeURIComponent(req.params.id);
    if (!isValidHexId(dropId)) return res.status(400).json({ error: 'Invalid drop ID' });
    const { external_url, external_platform } = req.body;
    if (!external_url || !external_platform) return res.status(400).json({ error: 'external_url and external_platform required' });
    if (!['youtube', 'vimeo'].includes(external_platform)) return res.status(400).json({ error: 'Platform must be youtube or vimeo' });
    const adminUserId = req.user?.user_id;
    const client = await pool.connect();
    try {
        const dropCheck = await client.query('SELECT id FROM merch_drops WHERE id = $1', [dropId]);
        if (dropCheck.rows.length === 0) return res.status(404).json({ error: 'Drop not found' });
        await client.query('BEGIN');
        const mediaId = await generateHexId('merch_drop_media_id');
        const orderResult = await client.query(
            'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM merch_drop_media WHERE drop_id = $1',
            [dropId]
        );
        const displayOrder = orderResult.rows[0].next_order;
        const insertResult = await client.query(
            'INSERT INTO merch_drop_media (id, drop_id, media_type, external_url, external_platform, display_order, is_primary) VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *',
            [mediaId, dropId, 'video', external_url, external_platform, displayOrder]
        );
        await client.query('COMMIT');
        logger.info('Merch video added', { adminUserId, dropId, mediaId, external_platform });
        res.status(201).json({ success: true, media: insertResult.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Merch video add failed', { dropId, error: err.message });
        res.status(500).json({ error: 'Video add failed' });
    } finally {
        client.release();
    }
});

router.patch('/drops/:id/media/:mediaId/primary', async (req, res) => {
    const dropId = decodeURIComponent(req.params.id);
    const mediaId = decodeURIComponent(req.params.mediaId);
    if (!isValidHexId(dropId) || !isValidHexId(mediaId)) return res.status(400).json({ error: 'Invalid ID' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE merch_drop_media SET is_primary = false WHERE drop_id = $1', [dropId]);
        const result = await client.query(
            'UPDATE merch_drop_media SET is_primary = true WHERE id = $1 AND drop_id = $2 AND media_type = $3 RETURNING *',
            [mediaId, dropId, 'image']
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Media item not found or not an image' });
        }
        await client.query('COMMIT');
        res.json({ success: true, media: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Set primary failed', { dropId, mediaId, error: err.message });
        res.status(500).json({ error: 'Failed to set primary' });
    } finally {
        client.release();
    }
});

router.patch('/drops/:id/media/reorder', async (req, res) => {
    const dropId = decodeURIComponent(req.params.id);
    if (!isValidHexId(dropId)) return res.status(400).json({ error: 'Invalid drop ID' });
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) return res.status(400).json({ error: 'order must be a non-empty array of media IDs' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (let i = 0; i < order.length; i++) {
            await client.query(
                'UPDATE merch_drop_media SET display_order = $1 WHERE id = $2 AND drop_id = $3',
                [i, order[i], dropId]
            );
        }
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error('Reorder failed', { dropId, error: err.message });
        res.status(500).json({ error: 'Reorder failed' });
    } finally {
        client.release();
    }
});

router.delete('/drops/:id/media/:mediaId', async (req, res) => {
    const dropId = decodeURIComponent(req.params.id);
    const mediaId = decodeURIComponent(req.params.mediaId);
    if (!isValidHexId(dropId) || !isValidHexId(mediaId)) return res.status(400).json({ error: 'Invalid ID' });
    const client = await pool.connect();
    try {
        const result = await client.query(
            'DELETE FROM merch_drop_media WHERE id = $1 AND drop_id = $2 RETURNING *',
            [mediaId, dropId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Media item not found' });
        logger.info('Merch media deleted', { dropId, mediaId });
        res.json({ success: true });
    } catch (err) {
        logger.error('Delete media failed', { dropId, mediaId, error: err.message });
        res.status(500).json({ error: 'Delete failed' });
    } finally {
        client.release();
    }
});



// GET /api/merch/admin/orders - List orders with optional status filter
router.get('/orders', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { status, limit = 50, offset = 0 } = req.query;

    const validStatuses = ['pending', 'paid', 'fulfilled', 'cancelled', 'expired', 'refunded'];

    if (status && !validStatuses.includes(status)) {
        return res.status(400).json({
            error: 'Invalid status filter',
            valid_statuses: validStatuses
        });
    }

    try {
        let query = `
            SELECT
                o.id,
                o.user_id,
                u.username,
                o.drop_id,
                d.title AS drop_title,
                o.status,
                o.base_price_cents,
                o.total_upcharge_cents,
                o.total_paid_cents,
                o.paid_at,
                o.created_at,
                o.expires_at,
                o.refunded_at,
                o.refund_amount_cents,
                o.stripe_payment_intent_id
            FROM merch_orders o
            LEFT JOIN users u ON o.user_id = u.user_id
            LEFT JOIN merch_drops d ON o.drop_id = d.id
        `;
        const params = [];

        if (status) {
            query += ' WHERE o.status = $1';
            params.push(status);
        }

        query += ' ORDER BY o.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        logger.info('Listed orders', { adminUserId, count: result.rows.length, filter: status });

        res.json({
            orders: result.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                count: result.rows.length
            }
        });
    } catch (err) {
        logger.error('List orders failed', { adminUserId, error: err.message });
        res.status(500).json({ error: 'Failed to retrieve orders' });
    }
});


// GET /api/merch/admin/audit - List audit log entries with optional drop filter
router.get('/audit', async (req, res) => {
    const adminUserId = req.user.user_id;
    const { drop_id, limit = 50, offset = 0 } = req.query;

    if (drop_id && !isValidHexId(drop_id)) {
        return res.status(400).json({ error: 'Invalid drop_id format' });
    }

    try {
        let query = `
            SELECT
                a.id,
                a.admin_user_id,
                u.username AS admin_username,
                a.action,
                a.drop_id,
                d.title AS drop_title,
                a.details,
                a.ip_address,
                a.created_at
            FROM merch_audit_log a
            LEFT JOIN users u ON a.admin_user_id = u.user_id
            LEFT JOIN merch_drops d ON a.drop_id = d.id
        `;
        const params = [];

        if (drop_id) {
            query += ' WHERE a.drop_id = $1';
            params.push(drop_id);
        }

        query += ' ORDER BY a.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        logger.info('Listed audit log', { adminUserId, count: result.rows.length, filter: drop_id });

        res.json({
            entries: result.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                count: result.rows.length
            }
        });
    } catch (err) {
        logger.error('List audit log failed', { adminUserId, error: err.message });
        res.status(500).json({ error: 'Failed to retrieve audit log' });
    }
});

export { adminRateLimit, router as default };
