import express from 'express';
import pool from '../db/pool.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('merch:public');


// Cache: 30s TTL for /current (tunable for hype drops)
const dropCache = new NodeCache({ 
    stdTTL: 30, 
    checkperiod: 60,
    useClones: false 
});

// Rate limiter: 100 req/min per IP (public-friendly but bot-resistant)
const publicLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded');
        res.status(429).json({ error: 'Too many requests' });
    }
});

const router = express.Router();
router.use(publicLimiter);

// DRY helper: Fetch pricing + options with COALESCE to prevent [null]
const getDropDetails = async (dropId) => {
    const start = Date.now();
    
    try {
        const [pricing, groups] = await Promise.all([
            pool.query(`
                SELECT r.code as region_code, r.name as region_name, 
                       dp.price_cents, dp.stripe_product_id
                FROM merch_drop_pricing dp
                JOIN regions r ON r.id = dp.region_id
                WHERE dp.drop_id = $1
            `, [dropId]),
            
            pool.query(`
                SELECT og.id, og.group_name, og.is_required,
                       COALESCE(json_agg(
                           json_build_object(
                               'value', o.option_value,
                               'upcharge_cents', o.upcharge_cents,
                               'metadata', o.metadata
                           ) ORDER BY o.display_order
                       ) FILTER (WHERE o.id IS NOT NULL), '[]') as options
                FROM merch_option_groups og
                LEFT JOIN merch_options o ON o.group_id = og.id
                WHERE og.drop_id = $1
                GROUP BY og.id, og.group_name, og.is_required
                ORDER BY og.display_order
            `, [dropId])
        ]);

        logger.debug({ 
            dropId, 
            ms: Date.now() - start,
            pricing: pricing.rowCount, 
            groups: groups.rowCount 
        }, 'Drop details fetched');
        
        return { pricing: pricing.rows, option_groups: groups.rows };
    } catch (err) {
        logger.error({ err, dropId }, 'getDropDetails failed');
        throw err;
    }
};

// IMPORTANT: /current MUST come before /:id
router.get('/current', async (req, res) => {
    const cacheKey = 'current_drop';
    
    try {
        // Cache hit
        const cached = dropCache.get(cacheKey);
        if (cached) {
            res.set('X-Cache', 'HIT');
            res.set('Cache-Control', 'public, max-age=30');
            return res.json(cached);
        }

        // Fetch live drop (single query, no double-fetch)
        const result = await pool.query(
            `SELECT * FROM merch_drops 
             WHERE status = 'live' 
             ORDER BY created_at DESC 
             LIMIT 1`
        );

        if (!result.rows[0]) {
            const response = { active: false };
            dropCache.set(cacheKey, response);
            res.set('Cache-Control', 'public, max-age=30');
            return res.json(response);
        }

        const drop = result.rows[0];
        const details = await getDropDetails(drop.id);
        
        const response = {
            active: true,
            ...drop,
            ...details
        };

        dropCache.set(cacheKey, response);
        res.set('X-Cache', 'MISS');
        res.set('Cache-Control', 'public, max-age=30');
        
        logger.info({ dropId: drop.id }, 'Current drop served');
        res.json(response);

    } catch (err) {
        logger.error({ err }, '/current error');
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/:id', async (req, res) => {
    // Input validation (prevent SQL type errors)
    const dropId = req.params.id;
    if (!isValidHexId(dropId)) {
        return res.status(400).json({ error: 'Invalid drop ID' });
    }

    try {
        // Security: Only expose live/upcoming (no drafts/archives)
        const dropResult = await pool.query(
            `SELECT * FROM merch_drops 
             WHERE id = $1 
             AND status IN ('live', 'upcoming')`,
            [dropId]
        );

        if (!dropResult.rows[0]) {
            logger.info({ dropId }, 'Drop not found or unavailable');
            return res.status(404).json({ error: 'Drop not found' });
        }

        const drop = dropResult.rows[0];
        const details = await getDropDetails(dropId);
        
        // Longer cache for specific drops (immutable once published)
        res.set('Cache-Control', 'public, max-age=300');
        logger.info({ dropId, status: drop.status }, 'Drop served');
        
        res.json({ ...drop, ...details });

    } catch (err) {
        logger.error({ err, dropId }, '/:id error');
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Cache invalidation helper (call from admin/webhook when drop changes)
export const invalidateCurrentDrop = () => {
    dropCache.del('current_drop');
    logger.info('Current drop cache invalidated');
};

export default router;
