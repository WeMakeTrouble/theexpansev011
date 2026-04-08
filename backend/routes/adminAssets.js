/**
 * ============================================================================
 * Admin Assets Router — Phase 6: Asset Management
 * ============================================================================
 *
 * Handles image upload, processing, asset management, and entity attachment
 * endpoints. Mounted at /api/admin/assets by the main admin router.
 *
 * ENDPOINTS:
 * ---------------------------------------------------------------------------
 *   POST   /api/admin/assets/upload                    Upload and process image
 *   GET    /api/admin/assets/:id                       Get asset metadata
 *   GET    /api/admin/assets                           List assets (paginated)
 *   POST   /api/admin/assets/attach                    Link asset to entity
 *   DELETE /api/admin/assets/attach/:id                Remove attachment
 *   GET    /api/admin/assets/attachments/:type/:id     List entity attachments
 *
 * ATTACHMENT MODEL:
 * ---------------------------------------------------------------------------
 * Assets are linked to entities via entity_media_attachments. Each link has
 * a role (primary, gallery, thumbnail, background, audio, video, document).
 * Only one primary per entity is enforced: assigning a new primary atomically
 * demotes the old one to gallery in a single CTE statement.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 6 — Asset Management
 * ============================================================================
 */

import { Router } from 'express';
import multer from 'multer';
import pool from '../db/pool.js';
import assetManager from '../services/assetManager.js';
import { imageEditor } from '../services/imageEditor/index.js';
import { NAMED_POSITIONS } from '../services/imageEditor/config.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('adminAssets');
const router = Router();

/**
 * Multer configuration.
 * Memory storage keeps the file as a Buffer (no temp files on disk).
 * 50MB limit matches assetManager and imageProcessor limits.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/**
 * Valid entity types for media attachments.
 *
 * @type {Set<string>}
 */
const VALID_ENTITY_TYPES = new Set([
  'character', 'location', 'object', 'narrative_arc',
  'narrative_beat', 'curriculum', 'user'
]);

/**
 * Valid attachment roles (must match DB check constraint).
 *
 * @type {Set<string>}
 */
const VALID_ROLES = new Set([
  'primary', 'gallery', 'thumbnail', 'background',
  'audio', 'video', 'document'
]);

/**
 * Parse a focal point from request body.
 * Accepts either a JSON object string or a named preset string.
 *
 * @param {string|undefined} focalPointJson - JSON string of {x, y}
 * @param {string|undefined} focalPreset - Named position string
 * @returns {Object|string|null} Focal point or null
 */
function _parseFocalPoint(focalPointJson, focalPreset) {
  if (focalPointJson) {
    try {
      const parsed = JSON.parse(focalPointJson);
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return parsed;
      }
      logger.warn('Invalid focalPoint JSON, ignoring', { focalPointJson });
    } catch {
      logger.warn('Failed to parse focalPoint JSON, ignoring', { focalPointJson });
    }
  }

  if (focalPreset && typeof focalPreset === 'string') {
    if (NAMED_POSITIONS[focalPreset]) {
      return focalPreset;
    }
    logger.warn(`Unknown focal preset: ${focalPreset}, ignoring`);
  }

  return null;
}

/**
 * Parse an edit stack from request body.
 *
 * @param {string|undefined} editsJson - JSON string of edit stack array
 * @returns {Array} Edit stack or empty array
 */
function _parseEdits(editsJson) {
  if (!editsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(editsJson);
    if (!Array.isArray(parsed)) {
      logger.warn('edits is not an array, ignoring');
      return [];
    }

    const errors = imageEditor.validateEditStack(parsed);
    if (errors.length > 0) {
      logger.warn('Invalid edit stack', { errors });
      return [];
    }

    return parsed;
  } catch {
    logger.warn('Failed to parse edits JSON, ignoring', { editsJson });
    return [];
  }
}

/* ============================================================================
 * UPLOAD
 * ============================================================================ */

/**
 * POST /api/admin/assets/upload
 * Upload and process a new image asset.
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No image file provided. Use field name "file".'
    });
  }

  try {
    const focalPoint = _parseFocalPoint(req.body.focalPoint, req.body.focalPreset);
    const edits = _parseEdits(req.body.edits);
    const applyCrt = req.body.applyCrt !== 'false';

    const result = await assetManager.createAsset({
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      edits,
      focalPoint,
      generateVariants: true,
      applyCrt
    });

    logger.info(`Asset uploaded by ${req.user?.username || 'unknown'}`, {
      assetId: result.assetId,
      originalFilename: req.file.originalname
    });

    res.status(201).json({
      success: true,
      assetId: result.assetId,
      url: result.metadata.originalFilename,
      variants: Object.keys(result.variants),
      metadata: result.metadata
    });

  } catch (error) {
    logger.error('Asset upload failed', error);

    const statusCode = error.message.includes('Invalid image format') ? 400
      : error.message.includes('exceeds') ? 413
      : error.message.includes('must be') ? 400
      : 500;

    res.status(statusCode).json({
      success: false,
      error: statusCode < 500 ? error.message : 'Asset upload failed'
    });
  }
});

/* ============================================================================
 * ASSET QUERIES
 * ============================================================================ */

/**
 * GET /api/admin/assets/:id
 * Get asset metadata by hex ID.
 */
router.get('/:id', async (req, res) => {
  const assetId = req.params.id;

  try {
    const result = await pool.query(`
      SELECT asset_id, asset_type, url, original_filename,
             file_size, mime_type, focal_point, edit_metadata,
             dominant_color, created_at, updated_at
      FROM multimedia_assets
      WHERE asset_id = $1
    `, [assetId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Asset ${assetId} not found`
      });
    }

    res.json({
      success: true,
      asset: result.rows[0]
    });

  } catch (error) {
    logger.error(`Failed to fetch asset ${assetId}`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch asset'
    });
  }
});

/**
 * GET /api/admin/assets
 * List assets with pagination.
 */
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;
  const assetType = req.query.type || null;

  try {
    let query = `
      SELECT asset_id, asset_type, url, original_filename,
             file_size, dominant_color, created_at
      FROM multimedia_assets
    `;
    const params = [];

    if (assetType) {
      query += ` WHERE asset_type = $1`;
      params.push(assetType);
    }

    query += ` ORDER BY created_at DESC`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const countQuery = assetType
      ? `SELECT COUNT(*) FROM multimedia_assets WHERE asset_type = $1`
      : `SELECT COUNT(*) FROM multimedia_assets`;
    const countParams = assetType ? [assetType] : [];
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      success: true,
      assets: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count, 10),
        limit,
        offset
      }
    });

  } catch (error) {
    logger.error('Failed to list assets', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list assets'
    });
  }
});

/* ============================================================================
 * ATTACHMENTS
 * ============================================================================ */

/**
 * POST /api/admin/assets/attach
 * Link an asset to an entity with a role.
 *
 * If role is 'primary', any existing primary for that entity is atomically
 * demoted to 'gallery' in a single CTE statement (no race condition).
 */
router.post('/attach', async (req, res) => {
  const { entityType, entityId, assetId, role, sortOrder } = req.body;

  if (!entityType || !VALID_ENTITY_TYPES.has(entityType)) {
    return res.status(400).json({
      success: false,
      error: `Invalid entityType. Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}`
    });
  }

  if (!entityId || typeof entityId !== 'string') {
    return res.status(400).json({ success: false, error: 'entityId is required' });
  }

  if (!isValidHexId(entityId)) {
    return res.status(400).json({ success: false, error: 'entityId must be a valid hex ID (#XXXXXX)' });
  }

  if (!assetId || typeof assetId !== 'string') {
    return res.status(400).json({ success: false, error: 'assetId is required' });
  }

  if (!isValidHexId(assetId)) {
    return res.status(400).json({ success: false, error: 'assetId must be a valid hex ID (#XXXXXX)' });
  }

  const attachmentRole = role || 'gallery';
  if (!VALID_ROLES.has(attachmentRole)) {
    return res.status(400).json({
      success: false,
      error: `Invalid role. Must be one of: ${[...VALID_ROLES].join(', ')}`
    });
  }

  const order = Number.isInteger(sortOrder) && sortOrder >= 0 ? sortOrder : 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const assetCheck = await client.query(
      'SELECT asset_id FROM multimedia_assets WHERE asset_id = $1',
      [assetId]
    );
    if (assetCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: `Asset ${assetId} not found` });
    }

    const attachmentId = await generateHexId('attachment_id', client);

    const insertResult = await client.query(`
      WITH demote_primary AS (
        UPDATE entity_media_attachments
        SET attachment_role = 'gallery'
        WHERE entity_type = $2
          AND entity_id = $3
          AND attachment_role = 'primary'
          AND $5 = 'primary'
        RETURNING attachment_id
      )
      INSERT INTO entity_media_attachments
        (attachment_id, entity_type, entity_id, asset_id, attachment_role, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING attachment_id
    `, [attachmentId, entityType, entityId, assetId, attachmentRole, order]);

    await client.query('COMMIT');

    logger.info(`Attached ${assetId} to ${entityType}/${entityId} as ${attachmentRole}`, {
      attachmentId, username: req.user?.username
    });

    res.status(201).json({
      success: true,
      attachmentId: insertResult.rows[0].attachment_id,
      entityType,
      entityId,
      assetId,
      role: attachmentRole,
      sortOrder: order
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'This asset is already attached with that role'
      });
    }

    logger.error('Failed to attach asset', error);
    res.status(500).json({ success: false, error: 'Failed to attach asset' });
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/admin/assets/attach/:id
 * Remove an attachment by its hex ID.
 */
router.delete('/attach/:id', async (req, res) => {
  const attachmentId = req.params.id;

  if (!isValidHexId(attachmentId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid attachment ID format'
    });
  }

  try {
    const result = await pool.query(
      'DELETE FROM entity_media_attachments WHERE attachment_id = $1 RETURNING *',
      [attachmentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Attachment ${attachmentId} not found`
      });
    }

    logger.info(`Removed attachment ${attachmentId}`, {
      removed: result.rows[0], username: req.user?.username
    });

    res.json({ success: true, removed: result.rows[0] });

  } catch (error) {
    logger.error(`Failed to remove attachment ${attachmentId}`, error);
    res.status(500).json({ success: false, error: 'Failed to remove attachment' });
  }
});

/**
 * GET /api/admin/assets/attachments/:entityType/:entityId
 * List all attachments for an entity with pagination.
 */
router.get('/attachments/:entityType/:entityId', async (req, res) => {
  const { entityType, entityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const result = await pool.query(`
      SELECT
        ema.attachment_id,
        ema.attachment_role,
        ema.sort_order,
        ema.created_at,
        ma.asset_id,
        ma.url,
        ma.original_filename,
        ma.file_size,
        ma.mime_type,
        ma.dominant_color
      FROM entity_media_attachments ema
      JOIN multimedia_assets ma ON ema.asset_id = ma.asset_id
      WHERE ema.entity_type = $1 AND ema.entity_id = $2
      ORDER BY
        CASE WHEN ema.attachment_role = 'primary' THEN 0 ELSE 1 END,
        ema.sort_order,
        ema.created_at
      LIMIT $3 OFFSET $4
    `, [entityType, entityId, limit, offset]);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM entity_media_attachments WHERE entity_type = $1 AND entity_id = $2',
      [entityType, entityId]
    );

    res.json({
      success: true,
      entityType,
      entityId,
      attachments: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count, 10),
        limit,
        offset
      }
    });

  } catch (error) {
    logger.error(`Failed to list attachments for ${entityType}/${entityId}`, error);
    res.status(500).json({ success: false, error: 'Failed to list attachments' });
  }
});

export default router;
