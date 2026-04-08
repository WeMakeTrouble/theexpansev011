/**
 * ============================================================================
 * User Characters Sub-Router — Read-Only Character Data for User Features
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Express sub-router handling /api/user/characters/* endpoints.
 * Provides read-only access to character profiles and personality data
 * for user-facing features (Fracture Monitor, Psychic Radar, etc.).
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 * GET  /                      List all characters with OCEAN personality
 *
 * SECURITY:
 * ---------------------------------------------------------------------------
 * All routes require verifyUserAuth (access_level >= 1).
 * Read-only. No write endpoints. No sensitive admin data exposed.
 *
 * ============================================================================
 * Project: The Expanse v010
 * ============================================================================
 */

import { Router } from 'express';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('UserCharacters');
const router = Router();

const LIST_LIMIT = 200;

/* ============================================================================
 * GET / — List All Characters with OCEAN Personality
 * ============================================================================
 * Returns character profiles with personality data for user-facing
 * visualizations (Fracture Monitor, Psychic Radar, etc.).
 * Excludes sensitive admin fields (degradation rules, trait generation, etc.)
 * ============================================================================ */

router.get('/', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const result = await pool.query(`
      SELECT
        cp.character_id,
        cp.character_name,
        cp.category,
        cp.description,
        cp.is_active,
        cper.openness,
        cper.conscientiousness,
        cper.extraversion,
        cper.agreeableness,
        cper.neuroticism,
        oa.archetype_code,
        oa.archetype_name,
        ma.url AS profile_image_url
      FROM character_profiles cp
      LEFT JOIN character_personality cper
        ON cp.character_id = cper.character_id
      LEFT JOIN ocean_archetypes oa
        ON cper.archetype_id = oa.archetype_id
      LEFT JOIN entity_media_attachments ema
        ON ema.entity_type = 'character'
        AND ema.entity_id = cp.character_id
        AND ema.attachment_role = 'primary'
      LEFT JOIN multimedia_assets ma
        ON ema.asset_id = ma.asset_id
      WHERE cp.is_active = true
      ORDER BY cp.character_name ASC
      LIMIT $1
    `, [LIST_LIMIT]);

    const duration = Math.round(performance.now() - startTime);

    logger.info('User character list fetched', {
      count: result.rows.length,
      userId: req.user?.user_id,
      durationMs: duration
    });

    res.json({
      success: true,
      characters: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    next(error);
  }
});

export default router;
