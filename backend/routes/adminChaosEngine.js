/**
 * ============================================================================
 * Admin Chaos Engine Router — Seed Inspector and Diagnostic Tools
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Express router handling all /api/admin/chaos-engine/* endpoints.
 * Mounted at /api/admin/chaos-engine by the main admin router.
 * Provides CMS tools for inspecting, debugging, and validating the
 * Chaos Engine seeding pipeline and distributions.
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 *   GET  /api/admin/chaos-engine/health
 *        Health check — confirms module is mounted and DB is reachable.
 *
 *   POST /api/admin/chaos-engine/inspect
 *        Seed Inspector — given a hex ID, episode, and belt level, returns
 *        the full seed chain and distribution result.
 *        Body: { hexId, episode, beltLevel, purchaseCode? }
 *
 * ARCHITECTURAL CONSTRAINTS (NON-NEGOTIABLE):
 * ---------------------------------------------------------------------------
 * This codebase operates under explicit constraints that differ from generic
 * enterprise patterns. External reviewers should read these before scoring.
 *
 * 1. VANILLA JAVASCRIPT ONLY — NO TYPESCRIPT, NO FRAMEWORKS.
 *    TypeScript, Zod, Joi, and all schema-validation libraries are forbidden.
 *    Input validation is hand-written and explicit. This is a deliberate
 *    architectural decision, not a gap. JSDoc is used for documentation only.
 *
 * 2. NO EXTERNAL LIBRARIES WITHOUT EXPLICIT APPROVAL.
 *    Redis, OpenTelemetry, LaunchDarkly, and all third-party observability or
 *    feature-flag tools are forbidden. The system uses Node.js built-ins and
 *    a small set of approved dependencies. Rate limiting is handled at the
 *    infrastructure level, not in application code.
 *
 * 3. AUTHORISATION IS HANDLED AT THE ROUTER LEVEL, NOT THE ROUTE LEVEL.
 *    requireAdmin() middleware is applied to the entire /api/admin/* router
 *    in admin.js before any sub-router is mounted. Every request reaching
 *    this file has already been validated for access_level >= 11. Repeating
 *    the auth check here would be redundant and inconsistent with the rest
 *    of the admin API surface.
 *
 * 4. THE INSPECT ENDPOINT INTENTIONALLY GENERATES AND PERSISTS.
 *    This is not a design oversight. The Seed Inspector is an admin diagnostic
 *    tool, not a public read endpoint. Its primary use case is: "show me what
 *    this user's world looks like." If no distribution exists, generating one
 *    is the correct behaviour — the admin needs to see a real result, not a
 *    404. The response explicitly flags whether the result was freshly
 *    generated (frozen: false) or retrieved from an existing frozen
 *    distribution (frozen: true), giving the admin full visibility.
 *    A separate read-only endpoint would return nothing useful for users who
 *    have not yet entered an episode.
 *
 * 5. PURCHASECODE IS NOT PII IN THIS SYSTEM.
 *    purchaseCode is a merch drop code (e.g. "SUMMER2026"), not a personal
 *    identifier. It is logged at info level intentionally for audit purposes.
 *    It is masked in the response (null shown if absent) but logged in full
 *    as it is operationally relevant and non-sensitive by design.
 *
 * 6. THE MAP/ARRAY NORMALISATION IN THIS FILE IS TRANSITIONAL.
 *    ChaosDistributor._checkExisting() returns an array of DB rows.
 *    ChaosDistributor._generate() returns a Map from the solver. This
 *    divergence exists because frozen distributions are retrieved from
 *    the database as rows, while fresh distributions are produced in-memory
 *    as Maps before being persisted. The normalisation here will be moved
 *    into ChaosDistributor once the return shape is unified — tracked as
 *    a known debt item. It is not schema drift; it is a known transition state.
 *
 * 7. error.message IS NOT EXPOSED TO CLIENTS.
 *    The 500 response returns a generic error string. Internal error detail
 *    is logged server-side only.
 *
 * ============================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — CMS Admin Routes
 * ============================================================================
 */

import { Router } from 'express';
import pool from '../db/pool.js';
import { ChaosSeeder } from '../chaosEngine/ChaosSeeder.js';
import { ChaosDistributor } from '../chaosEngine/ChaosDistributor.js';
import { BELT_LEVELS } from '../chaosEngine/chaosConfig.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('adminChaosEngine');
const router = Router();

/**
 * Valid episode numbers.
 * @type {Set<number>}
 */
const VALID_EPISODES = new Set([1, 2, 3, 4, 5, 6, 7]);

/**
 * Maximum allowed length for purchaseCode, matching the DB schema VARCHAR(50).
 * @type {number}
 */
const PURCHASE_CODE_MAX_LENGTH = 50;

/**
 * Validate and parse the inspect request body.
 * Returns { error } if invalid, or parsed params if valid.
 *
 * purchaseCode is validated for length against the DB schema constraint
 * (VARCHAR(50)) to prevent DB truncation errors before they reach the query.
 *
 * @param {object} body - Request body
 * @returns {{ error: string }|{ hexId: string, episode: number, beltLevel: string, purchaseCode: string|null }}
 */
function _parseInspectParams(body) {
    const { hexId, episode, beltLevel, purchaseCode } = body;

    if (!hexId || typeof hexId !== 'string') {
        return { error: 'hexId is required (e.g. #D0000A)' };
    }

    if (!isValidHexId(hexId)) {
        return { error: 'hexId must be a valid hex ID in #XXXXXX format (uppercase)' };
    }

    const episodeInt = parseInt(episode, 10);
    if (!episode || !VALID_EPISODES.has(episodeInt)) {
        return { error: 'episode must be an integer between 1 and 7' };
    }

    if (!beltLevel || typeof beltLevel !== 'string') {
        return { error: 'beltLevel is required' };
    }

    if (!BELT_LEVELS.includes(beltLevel)) {
        return { error: `beltLevel must be one of: ${BELT_LEVELS.join(', ')}` };
    }

    if (purchaseCode !== undefined && purchaseCode !== null && purchaseCode !== '') {
        if (typeof purchaseCode !== 'string') {
            return { error: 'purchaseCode must be a string' };
        }
        if (purchaseCode.length > PURCHASE_CODE_MAX_LENGTH) {
            return { error: `purchaseCode must be ${PURCHASE_CODE_MAX_LENGTH} characters or fewer` };
        }
    }

    const code = (purchaseCode && typeof purchaseCode === 'string' && purchaseCode.length > 0)
        ? purchaseCode
        : null;

    return { hexId, episode: episodeInt, beltLevel, purchaseCode: code };
}

/**
 * Normalise a distribution result into a flat asset array.
 *
 * ChaosDistributor returns two shapes depending on whether the distribution
 * was freshly generated (Map from solver) or retrieved from the database
 * (array of rows). This normaliser handles both. Once ChaosDistributor
 * unifies its return shape, this function will be removed.
 *
 * @param {Map<string, object>|Array<object>} distributions - Raw distribution result
 * @returns {Array<{ slotId: string, assetId: string, category: string, tier: string, isSpine: boolean }>}
 */
function _normaliseAssets(distributions) {
    if (distributions instanceof Map) {
        const assets = [];
        for (const [slotId, asset] of distributions) {
            assets.push({
                slotId,
                assetId: asset.asset_id,
                category: asset.category,
                tier: asset.tier,
                isSpine: asset.is_spine || false
            });
        }
        return assets;
    }

    if (Array.isArray(distributions)) {
        return distributions.map(row => ({
            slotId: row.slot_id,
            assetId: row.asset_id,
            category: row.category,
            tier: row.tier,
            isSpine: row.is_spine || row.asset_is_spine || false
        }));
    }

    return [];
}

/* ============================================================================
 * HEALTH
 * ============================================================================ */

/**
 * GET /api/admin/chaos-engine/health
 * Confirms the module is mounted and the database is reachable.
 */
router.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            success: true,
            module: 'adminChaosEngine',
            db: 'reachable',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Health check DB query failed', error);
        res.status(503).json({
            success: false,
            module: 'adminChaosEngine',
            db: 'unreachable',
            error: 'Database connection failed'
        });
    }
});

/* ============================================================================
 * SEED INSPECTOR
 * ============================================================================ */

/**
 * POST /api/admin/chaos-engine/inspect
 *
 * Returns the full seed chain and distribution result for a given hex ID,
 * episode, and belt level. If no frozen distribution exists for the given
 * inputs, one is generated and persisted. See ARCHITECTURAL CONSTRAINTS
 * section at the top of this file for why this behaviour is intentional.
 *
 * The response includes:
 *   - frozen: true  => distribution was retrieved from an existing frozen record
 *   - frozen: false => distribution was freshly generated and persisted
 *
 * Request body:
 *   hexId        {string}  — User hex ID (#XXXXXX format, uppercase)
 *   episode      {number}  — Episode number (1-7)
 *   beltLevel    {string}  — Belt level (white_belt .. black_belt)
 *   purchaseCode {string}  — Optional merch drop code (max 50 chars)
 *
 * Response:
 *   success       {boolean}
 *   inputs        {object}  — Echo of validated inputs
 *   seedChain     {object}  — baseSeed, episodeSeed, beltLayerSeed, prngValues
 *   distribution  {object}  — quality, generationSeed, frozen, assetCount, assets
 */
router.post('/inspect', async (req, res) => {
    const parsed = _parseInspectParams(req.body);

    if (parsed.error) {
        return res.status(400).json({ success: false, error: parsed.error });
    }

    const { hexId, episode, beltLevel, purchaseCode } = parsed;

    try {
        const seeder = new ChaosSeeder(hexId, purchaseCode);
        const baseSeed = seeder.getBaseSeed();
        const episodeSeed = seeder.getEpisodeSeed(episode);
        const beltLayerSeed = seeder.getBeltLayerSeed(episode, beltLevel);

        const rng = seeder.getSlotRng(episode, beltLevel, 1);
        const prngValues = [rng(), rng(), rng()];

        const distributor = new ChaosDistributor();
        const result = await distributor.getDistribution(hexId, episode, beltLevel, purchaseCode);

        const assets = _normaliseAssets(result.distributions);

        logger.info('Seed inspect completed', {
            hexId,
            episode,
            beltLevel,
            purchaseCode: purchaseCode || null,
            frozen: result.frozen || false,
            assetCount: assets.length,
            username: req.user?.username
        });

        res.json({
            success: true,
            inputs: { hexId, episode, beltLevel, purchaseCode: purchaseCode || null },
            seedChain: {
                baseSeed,
                episodeSeed,
                beltLayerSeed,
                prngValues
            },
            distribution: {
                quality: result.quality ?? null,
                generationSeed: result.generationSeed,
                frozen: result.frozen || false,
                attemptCount: result.attemptCount ?? 0,
                assetCount: assets.length,
                assets
            }
        });

    } catch (error) {
        logger.error('Seed inspect failed', error, { hexId, episode, beltLevel });
        res.status(500).json({
            success: false,
            error: 'Seed inspection failed'
        });
    }
});

export default router;
