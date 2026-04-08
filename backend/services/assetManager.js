/**
 * ============================================================================
 * Asset Manager — Unified Image Upload & Processing Service
 * ============================================================================
 *
 * Single entry point for the complete image asset lifecycle:
 *   1. Validate input (buffer type, size, image format)
 *   2. Generate hex ID (within transaction)
 *   3. Save original to disk
 *   4. Apply optional edits (crop, rotate, flip, adjust, focalCrop)
 *   5. For each blueprint: focal crop (if set) → CRT pipeline → save variant
 *   6. Insert database record into multimedia_assets
 *   7. Return hex ID and metadata
 *
 * FOCAL POINT INTEGRATION:
 * ---------------------------------------------------------------------------
 * When a focal point is provided, each blueprint variant is pre-cropped
 * to the correct aspect ratio centred on the focal point BEFORE entering
 * the CRT pipeline. This means processImage() receives an image already
 * framed correctly, so its internal centre-crop resize is a no-op.
 *
 * This fixes the banner head-chopping problem: a portrait with focal
 * point at y:0.25 will have the face centred in the 3:1 banner strip
 * instead of showing the chest.
 *
 * FILE STORAGE CONVENTION:
 * ---------------------------------------------------------------------------
 *   uploads/assets/{hex_digits}/
 *     original.png
 *     profile.png          (1080x1350)
 *     profile_hd.png       (2160x2700)
 *     gallery.png          (1080x810)
 *     thumbnail.png        (128x128)
 *     banner.png           (1200x400)
 *     radar.png            (512x512)
 *     card_mobile.png      (1080x1920)
 *
 * Directory names use hex digits WITHOUT the leading hash.
 * The hash is part of the database value, not the filesystem.
 * Example: hex ID #C20001 → directory uploads/assets/C20001/
 *
 * TRANSACTION SAFETY:
 * ---------------------------------------------------------------------------
 * Hex ID generation and database INSERT happen inside the same
 * transaction via the client parameter. If the INSERT fails,
 * the hex counter rolls back. Disk files are cleaned up in the
 * catch block.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management
 * ============================================================================
 */

import { performance } from 'node:perf_hooks';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { imageEditor } from './imageEditor/index.js';
import { focalCrop } from './imageEditor/focalCrop.js';
import { processImage } from './imageProcessor/imageProcessor.js';
import { BLUEPRINTS } from './imageProcessor/config.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('assetManager');

/**
 * Base directory for all asset storage.
 * Each asset gets a subdirectory named by its hex digits.
 *
 * @type {string}
 */
const ASSET_BASE_PATH = 'uploads/assets';

/**
 * Maximum input buffer size in bytes (50MB).
 *
 * @type {number}
 */
const MAX_BUFFER_SIZE = 50 * 1024 * 1024;

/**
 * PNG magic number: first 4 bytes of any valid PNG file.
 *
 * @type {Buffer}
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47]);

/**
 * JPEG magic number: first 3 bytes of any valid JPEG file.
 *
 * @type {Buffer}
 */
const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF]);

/**
 * WEBP magic number: bytes 8-11 of any valid WEBP file.
 *
 * @type {Buffer}
 */
const WEBP_MAGIC = Buffer.from([0x57, 0x45, 0x42, 0x50]);

/**
 * Validate that a buffer contains a real image by checking magic numbers.
 * Accepts PNG, JPEG, and WEBP formats.
 *
 * @param {Buffer} buffer - Raw file data
 * @throws {Error} If buffer does not match any supported image format
 */
function _validateImageFormat(buffer) {
  if (buffer.length < 12) {
    throw new Error('Buffer too small to be a valid image');
  }

  const isPng = buffer.subarray(0, 4).equals(PNG_MAGIC);
  const isJpeg = buffer.subarray(0, 3).equals(JPEG_MAGIC);
  const isWebp = buffer.subarray(8, 12).equals(WEBP_MAGIC);

  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('Invalid image format. Only PNG, JPEG, and WEBP are accepted');
  }
}

/**
 * Strip the leading hash from a hex ID for filesystem use.
 * #C20001 → C20001
 *
 * @param {string} hexId - Hex ID with leading hash
 * @returns {string} Hex digits without hash
 */
function _hexToDir(hexId) {
  return hexId.slice(1);
}

/**
 * Asset manager service.
 * Plain object export per naming conventions.
 *
 * @type {Object}
 */
const assetManager = Object.freeze({

  /**
   * Create a new image asset with full processing pipeline.
   *
   * @param {Object} params
   * @param {Buffer} params.buffer - Raw image buffer (max 50MB, PNG/JPEG/WEBP)
   * @param {string} params.originalFilename - Original filename from upload
   * @param {Array} [params.edits=[]] - Edit stack for imageEditor
   * @param {Object|string|null} [params.focalPoint=null] - Focal point for crops
   * @param {boolean} [params.generateVariants=true] - Process all 7 blueprints
   * @param {boolean} [params.applyCrt=true] - Apply CRT effects to variants
   * @returns {Promise<{assetId: string, assetDir: string, variants: Object, metadata: Object}>}
   */
  async createAsset({
    buffer,
    originalFilename,
    edits = [],
    focalPoint = null,
    generateVariants = true,
    applyCrt = true
  }) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('buffer must be a Buffer');
    }

    if (buffer.length === 0) {
      throw new Error('Buffer is empty');
    }

    if (buffer.length > MAX_BUFFER_SIZE) {
      throw new Error(
        `Buffer (${Math.round(buffer.length / 1024 / 1024)}MB) exceeds ${MAX_BUFFER_SIZE / 1024 / 1024}MB limit`
      );
    }

    _validateImageFormat(buffer);

    if (!originalFilename || typeof originalFilename !== 'string') {
      throw new Error('originalFilename must be a non-empty string');
    }

    const totalStart = performance.now();
    let assetId = null;
    let assetDir = null;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      assetId = await generateHexId('multimedia_asset_id', client);
      const hexDigits = _hexToDir(assetId);
      assetDir = path.join(ASSET_BASE_PATH, hexDigits);

      logger.info(`Creating asset ${assetId}`, { originalFilename });

      await fs.mkdir(assetDir, { recursive: true });

      const originalPath = path.join(assetDir, 'original.png');
      await fs.writeFile(originalPath, buffer);

      let processedBuffer = buffer;
      let editMetadata = [];

      if (edits.length > 0) {
        const editResult = await imageEditor.applyEdits(buffer, edits);
        processedBuffer = editResult.buffer;
        editMetadata = editResult.appliedEdits;
        logger.info(`Applied ${editMetadata.length} edits to ${assetId}`);
      }

      const originalMeta = await sharp(buffer).metadata();

      const variants = {};

      if (generateVariants) {
        const blueprintNames = Object.keys(BLUEPRINTS);

        for (const blueprintName of blueprintNames) {
          const variantStart = performance.now();

          let variantInput = processedBuffer;

          if (focalPoint) {
            const bp = BLUEPRINTS[blueprintName];
            variantInput = await focalCrop(processedBuffer, {
              targetWidth: bp.width,
              targetHeight: bp.height,
              focalPoint,
              blueprintName
            });
          }

          let variantBuffer;

          if (applyCrt) {
            const result = await processImage(variantInput, { blueprint: blueprintName });
            variantBuffer = result.buffer;
          } else {
            const bp = BLUEPRINTS[blueprintName];
            variantBuffer = await sharp(variantInput)
              .resize(bp.width, bp.height, { fit: 'cover', position: 'center' })
              .png({ compressionLevel: 9 })
              .toBuffer();
          }

          const variantPath = path.join(assetDir, `${blueprintName}.png`);
          await fs.writeFile(variantPath, variantBuffer);

          variants[blueprintName] = {
            path: variantPath,
            fileSize: variantBuffer.length,
            durationMs: Math.round(performance.now() - variantStart)
          };
        }
      }

      const profileVariant = variants.profile || null;
      const primaryUrl = profileVariant
        ? `/assets/${hexDigits}/profile.png`
        : `/assets/${hexDigits}/original.png`;

      await client.query(`
        INSERT INTO multimedia_assets (
          asset_id, asset_type, url, original_filename,
          file_size, mime_type, focal_point, edit_metadata
        ) VALUES ($1, 'image', $2, $3, $4, $5, $6, $7)
      `, [
        assetId,
        primaryUrl,
        originalFilename,
        buffer.length,
        'image/png',
        focalPoint ? JSON.stringify(focalPoint) : null,
        editMetadata.length > 0 ? JSON.stringify(editMetadata) : null
      ]);

      await client.query('COMMIT');

      const totalMs = Math.round(performance.now() - totalStart);

      logger.info(`Asset ${assetId} created in ${totalMs}ms`, {
        variants: Object.keys(variants).length,
        edits: editMetadata.length,
        originalSize: buffer.length,
        hasFocalPoint: focalPoint !== null
      });

      return {
        assetId,
        assetDir,
        variants,
        metadata: {
          originalFilename,
          originalWidth: originalMeta.width,
          originalHeight: originalMeta.height,
          originalFormat: originalMeta.format,
          fileSize: buffer.length,
          editsApplied: editMetadata,
          focalPoint,
          variantCount: Object.keys(variants).length,
          totalProcessingMs: totalMs
        }
      };

    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});

      if (assetDir) {
        await fs.rm(assetDir, { recursive: true, force: true }).catch((cleanupError) => {
          logger.warn(`Failed to clean up ${assetDir}`, cleanupError);
        });
      }

      logger.error(`Asset creation failed for ${assetId || 'unknown'}`, error);
      throw error;

    } finally {
      client.release();
    }
  }
});

export default assetManager;
