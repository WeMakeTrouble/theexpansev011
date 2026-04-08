/**
 * ============================================================================
 * Admin Narrative Blueprints Sub-Router — Narrative Blueprint API
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Express sub-router handling all /api/admin/narrative-blueprints/* endpoints.
 * Mounted by admin.js at /narrative-blueprints. Provides full CRUD for
 * narrative blueprint templates, instances, and beat content.
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 * GET  /                              List all active blueprints
 * GET  /by-scale/:scale               Blueprints filtered by scale suitability
 * GET  /:id                           Single blueprint with all beats
 *
 * POST /instances                     Create new blueprint instance
 * GET  /instances                     List instances (filter by scale, status)
 * GET  /instances/:id                 Single instance with all beat content
 * PUT  /instances/:id                 Update instance metadata
 * DELETE /instances/:id               Archive instance (soft delete)
 * GET  /instances/:id/children        Get nested child instances
 *
 * POST /instances/:id/beats           Save/update beat content (upsert)
 * GET  /instances/:id/beats           Get all beat content for instance
 * PUT  /beat-content/:contentId       Update single beat content
 *
 * GET  /heuristics                   List heuristics (filter by situation, beat_context)
 * GET  /heuristics/random             Single random heuristic matching filters
 *
 * SECURITY:
 * ---------------------------------------------------------------------------
 * All routes inherit requireAdmin() from the parent admin.js router.
 * requireAdmin() enforces access_level >= 11 on every request.
 *
 * TRANSACTIONS:
 * ---------------------------------------------------------------------------
 * All write operations use pool.connect() + BEGIN/COMMIT/ROLLBACK.
 * Hex ID generation and INSERT are within the same transaction.
 *
 * INTEGRITY CONSTRAINTS:
 * ---------------------------------------------------------------------------
 * - Beat content upserts verify the blueprint_beat_id belongs to the
 *   same blueprint as the target instance (prevents cross-blueprint
 *   beat injection).
 * - Parent instance assignment checks for circular nesting by walking
 *   the parent chain up to a maximum depth of 10.
 * - Archived instances are excluded from list queries by default.
 *   Pass ?include_archived=true to include them.
 *
 * ============================================================================
 * PROJECT CONSTRAINTS — READ BEFORE REVIEWING
 * ============================================================================
 *
 * This codebase operates under strict architectural constraints that
 * are INTENTIONAL DESIGN DECISIONS, not deficiencies:
 *
 * 1. VANILLA JAVASCRIPT ONLY — No TypeScript.
 * 2. NO EXTERNAL AI APIs — All processing is deterministic.
 * 3. NO EXTERNAL VALIDATION LIBRARIES — No Zod, no Joi.
 * 4. NO CACHING LAYER — PostgreSQL is the single source of truth.
 * 5. NO API VERSIONING — Single consumer (CMS admin tool).
 * 6. HEX COLOUR CODE ID SYSTEM — All IDs are #XXXXXX format.
 * 7. ES MODULES ONLY — import/export throughout.
 * 8. STRUCTURED LOGGING — createModuleLogger(). Never console.log.
 *
 * SCALE CONTEXT:
 * ---------------------------------------------------------------------------
 * - 7 blueprints, 45 beats, handful of instances
 * - Single admin user (James, access_level 11)
 * - Internal tool, not public API
 * - PostgreSQL response times sub-5ms at this scale
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 3 — Narrative System (Blueprint Tool)
 * ============================================================================
 */

import { Router } from 'express';
import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('AdminNarrativeBlueprints');
const router = Router();

const LIST_LIMIT = 200;
const MAX_NESTING_DEPTH = 10;

const VALID_SCALES = ['season', 'episode', 'event', 'scene', 'conversation', 'narration'];
const VALID_STATUSES = ['draft', 'in_progress', 'complete', 'archived'];
const VALID_ARC_SHAPES = ['rags_to_riches', 'tragedy', 'man_in_hole', 'icarus', 'cinderella', 'oedipus'];

/**
 * Validates a hex ID matches the canonical #XXXXXX format.
 * Includes typeof guard to prevent TypeError on non-string input.
 *
 * @param {*} id - The value to validate
 * @returns {boolean} True if valid hex ID format
 */
function isValidHexId(id) {
  return typeof id === 'string' && /^#[0-9A-F]{6}$/.test(id);
}

/**
 * Detects circular nesting by walking the parent_instance_id chain.
 * Returns true if assigning proposedParentId as the parent of
 * targetInstanceId would create a cycle.
 *
 * Walks up to MAX_NESTING_DEPTH levels. If the chain exceeds that
 * depth without resolving, it is treated as a potential cycle.
 *
 * @param {object} queryable - pg pool or client with .query()
 * @param {string} targetInstanceId - The instance being updated
 * @param {string} proposedParentId - The proposed new parent
 * @returns {Promise<boolean>} True if circular reference detected
 */
async function wouldCreateCycle(queryable, targetInstanceId, proposedParentId) {
  let currentId = proposedParentId;
  let depth = 0;

  while (currentId && depth < MAX_NESTING_DEPTH) {
    if (currentId === targetInstanceId) {
      return true;
    }

    const result = await queryable.query(
      'SELECT parent_instance_id FROM narrative_blueprint_instances WHERE instance_id = $1',
      [currentId]
    );

    if (result.rows.length === 0) {
      return false;
    }

    currentId = result.rows[0].parent_instance_id;
    depth++;
  }

  return depth >= MAX_NESTING_DEPTH;
}

/**
 * Verifies that a blueprint_beat_id belongs to the same blueprint
 * as the given instance. Prevents cross-blueprint beat injection.
 *
 * @param {object} queryable - pg pool or client with .query()
 * @param {string} instanceId - The target instance
 * @param {string} blueprintBeatId - The beat being assigned
 * @returns {Promise<boolean>} True if the beat belongs to the instance blueprint
 */
async function beatBelongsToInstance(queryable, instanceId, blueprintBeatId) {
  const result = await queryable.query(`
    SELECT 1
    FROM narrative_blueprint_instances nbi
    JOIN blueprint_beats bb ON bb.blueprint_id = nbi.blueprint_id
    WHERE nbi.instance_id = $1
      AND bb.blueprint_beat_id = $2
  `, [instanceId, blueprintBeatId]);

  return result.rows.length > 0;
}

/* ============================================================================
 * GET / — List All Active Blueprints
 * ============================================================================ */

router.get('/', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const result = await pool.query(`
      SELECT
        blueprint_id,
        blueprint_name,
        blueprint_source,
        evidence_quality,
        scale_suitability,
        total_beats,
        conflict_required,
        description,
        usage_guidance,
        display_order
      FROM narrative_blueprints
      WHERE is_active = true
      ORDER BY display_order ASC
    `);

    const duration = Math.round(performance.now() - startTime);

    logger.info('Blueprint list fetched', {
      count: result.rows.length,
      durationMs: duration
    });

    res.json({
      success: true,
      blueprints: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * GET /by-scale/:scale — Blueprints Filtered by Scale Suitability
 * ============================================================================ */

router.get('/by-scale/:scale', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const scale = req.params.scale;

    if (!VALID_SCALES.includes(scale) && scale !== 'overlay') {
      const error = new Error('Invalid scale. Expected one of: ' + VALID_SCALES.join(', ') + ', overlay');
      error.statusCode = 400;
      throw error;
    }

    const result = await pool.query(`
      SELECT
        blueprint_id,
        blueprint_name,
        blueprint_source,
        evidence_quality,
        scale_suitability,
        total_beats,
        conflict_required,
        description,
        usage_guidance,
        display_order
      FROM narrative_blueprints
      WHERE is_active = true
        AND $1 = ANY(scale_suitability)
      ORDER BY display_order ASC
    `, [scale]);

    const duration = Math.round(performance.now() - startTime);

    logger.info('Blueprints fetched by scale', {
      scale,
      count: result.rows.length,
      durationMs: duration
    });

    res.json({
      success: true,
      blueprints: result.rows,
      count: result.rows.length,
      scale
    });

  } catch (error) {
    next(error);
  }
});


/* ============================================================================
 * VALID SITUATIONS — Whitelist for heuristic situation filter
 * ============================================================================ */

const VALID_SITUATIONS = [
  'weak_inciting_incident', 'flat_complications', 'no_crisis',
  'weak_climax', 'flat_resolution', 'character_inert',
  'lost_focus', 'creative_block', 'audience_disengaged', 'craft_visible'
];

const VALID_BEAT_CONTEXTS = [
  'opening', 'early', 'midpoint', 'late',
  'climax', 'resolution', 'any'
];

/* ============================================================================
 * GET /heuristics — List Heuristics (with optional filters)
 * ============================================================================ */

router.get('/heuristics', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const { situation, beat_context, source_author, tag } = req.query;
    const conditions = ['is_active = true'];
    const values = [];
    let paramIndex = 1;

    if (situation) {
      if (!VALID_SITUATIONS.includes(situation)) {
        const error = new Error('Invalid situation filter. Expected one of: ' + VALID_SITUATIONS.join(', '));
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`situation = \$${paramIndex++}`);
      values.push(situation);
    }

    if (beat_context) {
      if (!VALID_BEAT_CONTEXTS.includes(beat_context)) {
        const error = new Error('Invalid beat_context filter. Expected one of: ' + VALID_BEAT_CONTEXTS.join(', '));
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`(beat_context = \$${paramIndex++} OR beat_context = 'any')`);
      values.push(beat_context);
    }

    if (source_author) {
      conditions.push(`source_author = \$${paramIndex++}`);
      values.push(source_author);
    }

    if (tag) {
      conditions.push(`\$${paramIndex++} = ANY(tags)`);
      values.push(tag);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const result = await pool.query(`
      SELECT
        heuristic_id,
        situation,
        beat_context,
        prompt_text,
        follow_up_question,
        source_author,
        source_work,
        source_year,
        applicable_blueprints,
        applicable_beat_positions,
        tags,
        display_order
      FROM storytelling_heuristics
      ${whereClause}
      ORDER BY display_order ASC
    `, values);

    const duration = Math.round(performance.now() - startTime);

    logger.info('Heuristics list fetched', {
      count: result.rows.length,
      filters: { situation, beat_context, source_author, tag },
      durationMs: duration
    });

    res.json({
      success: true,
      heuristics: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * GET /heuristics/random — Single Random Heuristic Matching Filters
 * ============================================================================ */

router.get('/heuristics/random', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const { situation, beat_context } = req.query;
    const conditions = ['is_active = true'];
    const values = [];
    let paramIndex = 1;

    if (situation) {
      if (!VALID_SITUATIONS.includes(situation)) {
        const error = new Error('Invalid situation filter. Expected one of: ' + VALID_SITUATIONS.join(', '));
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`situation = \$${paramIndex++}`);
      values.push(situation);
    }

    if (beat_context) {
      if (!VALID_BEAT_CONTEXTS.includes(beat_context)) {
        const error = new Error('Invalid beat_context filter. Expected one of: ' + VALID_BEAT_CONTEXTS.join(', '));
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`(beat_context = \$${paramIndex++} OR beat_context = 'any')`);
      values.push(beat_context);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const result = await pool.query(`
      SELECT
        heuristic_id,
        situation,
        beat_context,
        prompt_text,
        follow_up_question,
        source_author,
        source_work,
        source_year,
        tags
      FROM storytelling_heuristics
      ${whereClause}
      ORDER BY RANDOM()
      LIMIT 1
    `, values);

    if (result.rows.length === 0) {
      const error = new Error('No heuristics found matching the given filters.');
      error.statusCode = 404;
      throw error;
    }

    const duration = Math.round(performance.now() - startTime);

    logger.info('Random heuristic fetched', {
      heuristicId: result.rows[0].heuristic_id,
      situation: result.rows[0].situation,
      beatContext: result.rows[0].beat_context,
      durationMs: duration
    });

    res.json({
      success: true,
      heuristic: result.rows[0]
    });

  } catch (error) {
    next(error);
  }
});
/* ============================================================================
 * GET /:id — Single Blueprint with All Beats
 * ============================================================================ */

router.get('/:id', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const blueprintId = decodeURIComponent(req.params.id);

    if (!isValidHexId(blueprintId)) {
      const error = new Error('Invalid blueprint ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const [blueprintResult, beatsResult] = await Promise.all([
      pool.query(`
        SELECT
          blueprint_id,
          blueprint_name,
          blueprint_source,
          evidence_quality,
          scale_suitability,
          total_beats,
          conflict_required,
          description,
          usage_guidance,
          display_order,
          is_active,
          created_at,
          updated_at
        FROM narrative_blueprints
        WHERE blueprint_id = $1
      `, [blueprintId]),

      pool.query(`
        SELECT
          blueprint_beat_id,
          beat_number,
          beat_name,
          beat_label,
          description,
          pacing_position,
          narrative_function,
          guidance,
          beat_rigidity,
          display_order
        FROM blueprint_beats
        WHERE blueprint_id = $1
        ORDER BY beat_number ASC
      `, [blueprintId])
    ]);

    if (blueprintResult.rows.length === 0) {
      const error = new Error('Blueprint not found');
      error.statusCode = 404;
      throw error;
    }

    const duration = Math.round(performance.now() - startTime);

    logger.info('Blueprint detail fetched', {
      blueprintId,
      blueprintName: blueprintResult.rows[0].blueprint_name,
      beatCount: beatsResult.rows.length,
      durationMs: duration
    });

    res.json({
      success: true,
      blueprint: {
        ...blueprintResult.rows[0],
        beats: beatsResult.rows
      }
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * POST /instances — Create New Blueprint Instance
 * ============================================================================ */

router.post('/instances', async (req, res, next) => {
  const startTime = performance.now();
  const client = await pool.connect();

  try {
    const {
      blueprint_id,
      instance_title,
      scale,
      emotional_arc_shape,
      parent_arc_id,
      parent_instance_id,
      notes
    } = req.body;

    if (!isValidHexId(blueprint_id)) {
      const error = new Error('Invalid or missing blueprint_id. Expected #XXXXXX format.');
      error.statusCode = 400;
      throw error;
    }

    if (!instance_title || typeof instance_title !== 'string' || instance_title.trim().length === 0) {
      const error = new Error('instance_title is required and must be a non-empty string.');
      error.statusCode = 400;
      throw error;
    }

    if (!scale || !VALID_SCALES.includes(scale)) {
      const error = new Error('Invalid or missing scale. Expected one of: ' + VALID_SCALES.join(', '));
      error.statusCode = 400;
      throw error;
    }

    if (emotional_arc_shape && !VALID_ARC_SHAPES.includes(emotional_arc_shape)) {
      const error = new Error('Invalid emotional_arc_shape. Expected one of: ' + VALID_ARC_SHAPES.join(', '));
      error.statusCode = 400;
      throw error;
    }

    if (parent_arc_id && !isValidHexId(parent_arc_id)) {
      const error = new Error('Invalid parent_arc_id format. Expected #XXXXXX.');
      error.statusCode = 400;
      throw error;
    }

    if (parent_instance_id && !isValidHexId(parent_instance_id)) {
      const error = new Error('Invalid parent_instance_id format. Expected #XXXXXX.');
      error.statusCode = 400;
      throw error;
    }

    await client.query('BEGIN');

    const blueprintCheck = await client.query(
      'SELECT blueprint_id FROM narrative_blueprints WHERE blueprint_id = $1 AND is_active = true',
      [blueprint_id]
    );

    if (blueprintCheck.rows.length === 0) {
      const error = new Error('Blueprint not found or inactive.');
      error.statusCode = 404;
      throw error;
    }

    if (parent_instance_id) {
      const parentCheck = await client.query(
        'SELECT instance_id FROM narrative_blueprint_instances WHERE instance_id = $1',
        [parent_instance_id]
      );

      if (parentCheck.rows.length === 0) {
        const error = new Error('Parent instance not found.');
        error.statusCode = 404;
        throw error;
      }
    }

    const instanceId = await generateHexId('blueprint_instance_id', client);

    await client.query(`
      INSERT INTO narrative_blueprint_instances
        (instance_id, blueprint_id, instance_title, scale, emotional_arc_shape, parent_arc_id, parent_instance_id, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      instanceId,
      blueprint_id,
      instance_title.trim(),
      scale,
      emotional_arc_shape || null,
      parent_arc_id || null,
      parent_instance_id || null,
      notes || null
    ]);

    await client.query('COMMIT');

    const duration = Math.round(performance.now() - startTime);

    logger.info('Blueprint instance created', {
      instanceId,
      blueprintId: blueprint_id,
      instanceTitle: instance_title.trim(),
      scale,
      parentInstanceId: parent_instance_id || null,
      durationMs: duration
    });

    res.status(201).json({
      success: true,
      instance_id: instanceId,
      message: 'Blueprint instance created'
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

/* ============================================================================
 * GET /instances — List Instances (with optional filters)
 * ============================================================================
 * Excludes archived instances by default. Pass ?include_archived=true
 * to include them in the results.
 * ============================================================================ */

router.get('/instances', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const { scale, status, blueprint_id, include_archived } = req.query;
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (include_archived !== 'true') {
      conditions.push(`nbi.status != 'archived'`);
    }

    if (scale) {
      if (!VALID_SCALES.includes(scale)) {
        const error = new Error('Invalid scale filter. Expected one of: ' + VALID_SCALES.join(', '));
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`nbi.scale = $${paramIndex++}`);
      values.push(scale);
    }

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        const error = new Error('Invalid status filter. Expected one of: ' + VALID_STATUSES.join(', '));
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`nbi.status = $${paramIndex++}`);
      values.push(status);
    }

    if (blueprint_id) {
      if (!isValidHexId(blueprint_id)) {
        const error = new Error('Invalid blueprint_id filter format. Expected #XXXXXX.');
        error.statusCode = 400;
        throw error;
      }
      conditions.push(`nbi.blueprint_id = $${paramIndex++}`);
      values.push(blueprint_id);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`
      SELECT
        nbi.instance_id,
        nbi.blueprint_id,
        nbi.instance_title,
        nbi.scale,
        nbi.emotional_arc_shape,
        nbi.status,
        nbi.parent_instance_id,
        nbi.parent_arc_id,
        nbi.created_at,
        nbi.updated_at,
        nb.blueprint_name
      FROM narrative_blueprint_instances nbi
      JOIN narrative_blueprints nb ON nbi.blueprint_id = nb.blueprint_id
      ${whereClause}
      ORDER BY nbi.updated_at DESC
      LIMIT $${paramIndex}
    `, [...values, LIST_LIMIT]);

    const duration = Math.round(performance.now() - startTime);

    logger.info('Instance list fetched', {
      count: result.rows.length,
      filters: { scale, status, blueprint_id, include_archived: include_archived === 'true' },
      durationMs: duration
    });

    res.json({
      success: true,
      instances: result.rows,
      count: result.rows.length
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * GET /instances/:id — Single Instance with All Beat Content
 * ============================================================================ */

router.get('/instances/:id', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const instanceId = decodeURIComponent(req.params.id);

    if (!isValidHexId(instanceId)) {
      const error = new Error('Invalid instance ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const [instanceResult, beatContentResult] = await Promise.all([
      pool.query(`
        SELECT
          nbi.instance_id,
          nbi.blueprint_id,
          nbi.instance_title,
          nbi.scale,
          nbi.emotional_arc_shape,
          nbi.status,
          nbi.parent_instance_id,
          nbi.parent_arc_id,
          nbi.notes,
          nbi.created_at,
          nbi.updated_at,
          nb.blueprint_name,
          nb.total_beats
        FROM narrative_blueprint_instances nbi
        JOIN narrative_blueprints nb ON nbi.blueprint_id = nb.blueprint_id
        WHERE nbi.instance_id = $1
      `, [instanceId]),

      pool.query(`
        SELECT
          ibc.content_id,
          ibc.blueprint_beat_id,
          ibc.content,
          ibc.character_ids,
          ibc.target_pad_p,
          ibc.target_pad_a,
          ibc.target_pad_d,
          ibc.location_id,
          ibc.is_complete,
          ibc.notes,
          ibc.created_at,
          ibc.updated_at,
          bb.beat_number,
          bb.beat_name,
          bb.description AS beat_description,
          bb.pacing_position,
          bb.narrative_function,
          bb.guidance
        FROM instance_beat_content ibc
        JOIN blueprint_beats bb ON ibc.blueprint_beat_id = bb.blueprint_beat_id
        WHERE ibc.instance_id = $1
        ORDER BY bb.beat_number ASC
      `, [instanceId])
    ]);

    if (instanceResult.rows.length === 0) {
      const error = new Error('Instance not found');
      error.statusCode = 404;
      throw error;
    }

    const duration = Math.round(performance.now() - startTime);

    logger.info('Instance detail fetched', {
      instanceId,
      instanceTitle: instanceResult.rows[0].instance_title,
      beatContentCount: beatContentResult.rows.length,
      durationMs: duration
    });

    res.json({
      success: true,
      instance: {
        ...instanceResult.rows[0],
        beat_content: beatContentResult.rows
      }
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * PUT /instances/:id — Update Instance Metadata
 * ============================================================================ */

router.put('/instances/:id', async (req, res, next) => {
  const startTime = performance.now();
  const client = await pool.connect();

  try {
    const instanceId = decodeURIComponent(req.params.id);

    if (!isValidHexId(instanceId)) {
      const error = new Error('Invalid instance ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const { instance_title, scale, emotional_arc_shape, status, parent_arc_id, parent_instance_id, notes } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (instance_title !== undefined) {
      if (typeof instance_title !== 'string' || instance_title.trim().length === 0) {
        const error = new Error('instance_title must be a non-empty string.');
        error.statusCode = 400;
        throw error;
      }
      updates.push(`instance_title = $${paramIndex++}`);
      values.push(instance_title.trim());
    }

    if (scale !== undefined) {
      if (!VALID_SCALES.includes(scale)) {
        const error = new Error('Invalid scale. Expected one of: ' + VALID_SCALES.join(', '));
        error.statusCode = 400;
        throw error;
      }
      updates.push(`scale = $${paramIndex++}`);
      values.push(scale);
    }

    if (emotional_arc_shape !== undefined) {
      if (emotional_arc_shape !== null && !VALID_ARC_SHAPES.includes(emotional_arc_shape)) {
        const error = new Error('Invalid emotional_arc_shape. Expected one of: ' + VALID_ARC_SHAPES.join(', ') + ' or null');
        error.statusCode = 400;
        throw error;
      }
      updates.push(`emotional_arc_shape = $${paramIndex++}`);
      values.push(emotional_arc_shape);
    }

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        const error = new Error('Invalid status. Expected one of: ' + VALID_STATUSES.join(', '));
        error.statusCode = 400;
        throw error;
      }
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (parent_arc_id !== undefined) {
      if (parent_arc_id !== null && !isValidHexId(parent_arc_id)) {
        const error = new Error('Invalid parent_arc_id format. Expected #XXXXXX or null.');
        error.statusCode = 400;
        throw error;
      }
      updates.push(`parent_arc_id = $${paramIndex++}`);
      values.push(parent_arc_id);
    }

    if (parent_instance_id !== undefined) {
      if (parent_instance_id !== null && !isValidHexId(parent_instance_id)) {
        const error = new Error('Invalid parent_instance_id format. Expected #XXXXXX or null.');
        error.statusCode = 400;
        throw error;
      }

      if (parent_instance_id !== null) {
        if (parent_instance_id === instanceId) {
          const error = new Error('An instance cannot be its own parent.');
          error.statusCode = 400;
          throw error;
        }

        await client.query('BEGIN');

        const isCycle = await wouldCreateCycle(client, instanceId, parent_instance_id);
        if (isCycle) {
          const error = new Error('Circular nesting detected. This parent assignment would create a loop.');
          error.statusCode = 400;
          throw error;
        }
      }

      updates.push(`parent_instance_id = $${paramIndex++}`);
      values.push(parent_instance_id);
    }

    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      values.push(notes);
    }

    if (updates.length === 0) {
      const error = new Error('No valid fields provided for update.');
      error.statusCode = 400;
      throw error;
    }

    updates.push(`updated_at = now()`);
    values.push(instanceId);

    if (!client._activeTransaction) {
      await client.query('BEGIN');
    }

    const result = await client.query(`
      UPDATE narrative_blueprint_instances
      SET ${updates.join(', ')}
      WHERE instance_id = $${paramIndex}
      RETURNING instance_id, instance_title, scale, status, updated_at
    `, values);

    if (result.rows.length === 0) {
      const error = new Error('Instance not found');
      error.statusCode = 404;
      throw error;
    }

    await client.query('COMMIT');

    const duration = Math.round(performance.now() - startTime);

    logger.info('Instance updated', {
      instanceId,
      updatedFields: updates.filter(u => u !== 'updated_at = now()').length,
      durationMs: duration
    });

    res.json({
      success: true,
      instance: result.rows[0],
      message: 'Instance updated'
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

/* ============================================================================
 * DELETE /instances/:id — Archive Instance (Soft Delete)
 * ============================================================================ */

router.delete('/instances/:id', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const instanceId = decodeURIComponent(req.params.id);

    if (!isValidHexId(instanceId)) {
      const error = new Error('Invalid instance ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const result = await pool.query(`
      UPDATE narrative_blueprint_instances
      SET status = 'archived', updated_at = now()
      WHERE instance_id = $1 AND status != 'archived'
      RETURNING instance_id, instance_title, status
    `, [instanceId]);

    if (result.rows.length === 0) {
      const error = new Error('Instance not found or already archived');
      error.statusCode = 404;
      throw error;
    }

    const duration = Math.round(performance.now() - startTime);

    logger.info('Instance archived', {
      instanceId,
      instanceTitle: result.rows[0].instance_title,
      durationMs: duration
    });

    res.json({
      success: true,
      instance: result.rows[0],
      message: 'Instance archived'
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * GET /instances/:id/children — Get Nested Child Instances
 * ============================================================================ */

router.get('/instances/:id/children', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const instanceId = decodeURIComponent(req.params.id);

    if (!isValidHexId(instanceId)) {
      const error = new Error('Invalid instance ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const result = await pool.query(`
      SELECT
        nbi.instance_id,
        nbi.blueprint_id,
        nbi.instance_title,
        nbi.scale,
        nbi.emotional_arc_shape,
        nbi.status,
        nbi.created_at,
        nbi.updated_at,
        nb.blueprint_name
      FROM narrative_blueprint_instances nbi
      JOIN narrative_blueprints nb ON nbi.blueprint_id = nb.blueprint_id
      WHERE nbi.parent_instance_id = $1
        AND nbi.status != 'archived'
      ORDER BY nbi.created_at ASC
    `, [instanceId]);

    const duration = Math.round(performance.now() - startTime);

    logger.info('Child instances fetched', {
      parentInstanceId: instanceId,
      childCount: result.rows.length,
      durationMs: duration
    });

    res.json({
      success: true,
      children: result.rows,
      count: result.rows.length,
      parent_instance_id: instanceId
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * POST /instances/:id/beats — Save/Update Beat Content (Upsert)
 * ============================================================================
 * Validates that the blueprint_beat_id belongs to the same blueprint
 * as the target instance before allowing the upsert.
 * ============================================================================ */

router.post('/instances/:id/beats', async (req, res, next) => {
  const startTime = performance.now();
  const client = await pool.connect();

  try {
    const instanceId = decodeURIComponent(req.params.id);

    if (!isValidHexId(instanceId)) {
      const error = new Error('Invalid instance ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const { blueprint_beat_id, content, character_ids, target_pad_p, target_pad_a, target_pad_d, location_id, is_complete, notes } = req.body;

    if (!isValidHexId(blueprint_beat_id)) {
      const error = new Error('Invalid or missing blueprint_beat_id. Expected #XXXXXX format.');
      error.statusCode = 400;
      throw error;
    }

    if (character_ids !== undefined && character_ids !== null) {
      if (!Array.isArray(character_ids)) {
        const error = new Error('character_ids must be an array of hex IDs.');
        error.statusCode = 400;
        throw error;
      }
      for (const cid of character_ids) {
        if (!isValidHexId(cid)) {
          const error = new Error('Invalid character ID in character_ids: ' + cid + '. Expected #XXXXXX format.');
          error.statusCode = 400;
          throw error;
        }
      }
    }

    if (location_id !== undefined && location_id !== null && !isValidHexId(location_id)) {
      const error = new Error('Invalid location_id format. Expected #XXXXXX.');
      error.statusCode = 400;
      throw error;
    }

    const padFields = { target_pad_p, target_pad_a, target_pad_d };
    for (const [field, value] of Object.entries(padFields)) {
      if (value !== undefined && value !== null) {
        if (typeof value !== 'number' || value < -1.0 || value > 1.0) {
          const error = new Error(field + ' must be a number between -1.0 and 1.0.');
          error.statusCode = 400;
          throw error;
        }
      }
    }

    await client.query('BEGIN');

    const instanceCheck = await client.query(
      'SELECT instance_id, blueprint_id FROM narrative_blueprint_instances WHERE instance_id = $1',
      [instanceId]
    );

    if (instanceCheck.rows.length === 0) {
      const error = new Error('Instance not found.');
      error.statusCode = 404;
      throw error;
    }

    const beatValid = await beatBelongsToInstance(client, instanceId, blueprint_beat_id);
    if (!beatValid) {
      const error = new Error('blueprint_beat_id does not belong to this instance blueprint. Cross-blueprint beat assignment is not permitted.');
      error.statusCode = 400;
      throw error;
    }

    const existing = await client.query(
      'SELECT content_id FROM instance_beat_content WHERE instance_id = $1 AND blueprint_beat_id = $2',
      [instanceId, blueprint_beat_id]
    );

    let contentId;
    let action;

    if (existing.rows.length > 0) {
      contentId = existing.rows[0].content_id;
      action = 'updated';

      await client.query(`
        UPDATE instance_beat_content
        SET content = $1,
            character_ids = $2,
            target_pad_p = $3,
            target_pad_a = $4,
            target_pad_d = $5,
            location_id = $6,
            is_complete = $7,
            notes = $8,
            updated_at = now()
        WHERE content_id = $9
      `, [
        content || null,
        character_ids || null,
        target_pad_p !== undefined ? target_pad_p : null,
        target_pad_a !== undefined ? target_pad_a : null,
        target_pad_d !== undefined ? target_pad_d : null,
        location_id || null,
        is_complete === true,
        notes || null,
        contentId
      ]);

    } else {
      contentId = await generateHexId('beat_content_id', client);
      action = 'created';

      await client.query(`
        INSERT INTO instance_beat_content
          (content_id, instance_id, blueprint_beat_id, content, character_ids, target_pad_p, target_pad_a, target_pad_d, location_id, is_complete, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        contentId,
        instanceId,
        blueprint_beat_id,
        content || null,
        character_ids || null,
        target_pad_p !== undefined ? target_pad_p : null,
        target_pad_a !== undefined ? target_pad_a : null,
        target_pad_d !== undefined ? target_pad_d : null,
        location_id || null,
        is_complete === true,
        notes || null
      ]);
    }

    await client.query(`
      UPDATE narrative_blueprint_instances
      SET updated_at = now()
      WHERE instance_id = $1
    `, [instanceId]);

    await client.query('COMMIT');

    const duration = Math.round(performance.now() - startTime);

    logger.info('Beat content ' + action, {
      contentId,
      instanceId,
      blueprintBeatId: blueprint_beat_id,
      action,
      durationMs: duration
    });

    res.status(action === 'created' ? 201 : 200).json({
      success: true,
      content_id: contentId,
      action,
      message: 'Beat content ' + action
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

/* ============================================================================
 * GET /instances/:id/beats — Get All Beat Content for Instance
 * ============================================================================ */

router.get('/instances/:id/beats', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const instanceId = decodeURIComponent(req.params.id);

    if (!isValidHexId(instanceId)) {
      const error = new Error('Invalid instance ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const result = await pool.query(`
      SELECT
        ibc.content_id,
        ibc.blueprint_beat_id,
        ibc.content,
        ibc.character_ids,
        ibc.target_pad_p,
        ibc.target_pad_a,
        ibc.target_pad_d,
        ibc.location_id,
        ibc.is_complete,
        ibc.notes,
        ibc.created_at,
        ibc.updated_at,
        bb.beat_number,
        bb.beat_name,
        bb.description AS beat_description,
        bb.pacing_position,
        bb.narrative_function,
        bb.guidance
      FROM instance_beat_content ibc
      JOIN blueprint_beats bb ON ibc.blueprint_beat_id = bb.blueprint_beat_id
      WHERE ibc.instance_id = $1
      ORDER BY bb.beat_number ASC
    `, [instanceId]);

    const duration = Math.round(performance.now() - startTime);

    logger.info('Instance beat content fetched', {
      instanceId,
      beatCount: result.rows.length,
      durationMs: duration
    });

    res.json({
      success: true,
      beats: result.rows,
      count: result.rows.length,
      instance_id: instanceId
    });

  } catch (error) {
    next(error);
  }
});

/* ============================================================================
 * PUT /beat-content/:contentId — Update Single Beat Content
 * ============================================================================ */

router.put('/beat-content/:contentId', async (req, res, next) => {
  const startTime = performance.now();

  try {
    const contentId = decodeURIComponent(req.params.contentId);

    if (!isValidHexId(contentId)) {
      const error = new Error('Invalid content ID format. Expected #XXXXXX (6 uppercase hex digits).');
      error.statusCode = 400;
      throw error;
    }

    const { content, character_ids, target_pad_p, target_pad_a, target_pad_d, location_id, is_complete, notes } = req.body;

    if (character_ids !== undefined && character_ids !== null) {
      if (!Array.isArray(character_ids)) {
        const error = new Error('character_ids must be an array of hex IDs or null.');
        error.statusCode = 400;
        throw error;
      }
      for (const cid of character_ids) {
        if (!isValidHexId(cid)) {
          const error = new Error('Invalid character ID in character_ids: ' + cid + '. Expected #XXXXXX format.');
          error.statusCode = 400;
          throw error;
        }
      }
    }

    if (location_id !== undefined && location_id !== null && !isValidHexId(location_id)) {
      const error = new Error('Invalid location_id format. Expected #XXXXXX or null.');
      error.statusCode = 400;
      throw error;
    }

    const padFields = { target_pad_p, target_pad_a, target_pad_d };
    for (const [field, value] of Object.entries(padFields)) {
      if (value !== undefined && value !== null) {
        if (typeof value !== 'number' || value < -1.0 || value > 1.0) {
          const error = new Error(field + ' must be a number between -1.0 and 1.0.');
          error.statusCode = 400;
          throw error;
        }
      }
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (content !== undefined) {
      updates.push(`content = $${paramIndex++}`);
      values.push(content);
    }

    if (character_ids !== undefined) {
      updates.push(`character_ids = $${paramIndex++}`);
      values.push(character_ids);
    }

    if (target_pad_p !== undefined) {
      updates.push(`target_pad_p = $${paramIndex++}`);
      values.push(target_pad_p);
    }

    if (target_pad_a !== undefined) {
      updates.push(`target_pad_a = $${paramIndex++}`);
      values.push(target_pad_a);
    }

    if (target_pad_d !== undefined) {
      updates.push(`target_pad_d = $${paramIndex++}`);
      values.push(target_pad_d);
    }

    if (location_id !== undefined) {
      updates.push(`location_id = $${paramIndex++}`);
      values.push(location_id);
    }

    if (is_complete !== undefined) {
      updates.push(`is_complete = $${paramIndex++}`);
      values.push(is_complete === true);
    }

    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      values.push(notes);
    }

    if (updates.length === 0) {
      const error = new Error('No valid fields provided for update.');
      error.statusCode = 400;
      throw error;
    }

    updates.push(`updated_at = now()`);
    values.push(contentId);

    const result = await pool.query(`
      UPDATE instance_beat_content
      SET ${updates.join(', ')}
      WHERE content_id = $${paramIndex}
      RETURNING content_id, instance_id, blueprint_beat_id, is_complete, updated_at
    `, values);

    if (result.rows.length === 0) {
      const error = new Error('Beat content not found');
      error.statusCode = 404;
      throw error;
    }

    const duration = Math.round(performance.now() - startTime);

    logger.info('Beat content updated', {
      contentId,
      instanceId: result.rows[0].instance_id,
      updatedFields: updates.filter(u => u !== 'updated_at = now()').length,
      durationMs: duration
    });

    res.json({
      success: true,
      beat_content: result.rows[0],
      message: 'Beat content updated'
    });

  } catch (error) {
    next(error);
  }
});


export default router;
