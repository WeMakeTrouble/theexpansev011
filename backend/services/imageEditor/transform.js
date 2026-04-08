/**
 * ============================================================================
 * Image Editor — Geometric Transforms
 * ============================================================================
 *
 * Crop, rotate, and flip operations.
 * All functions take a Buffer and return a Buffer.
 * No filesystem access, no side effects.
 *
 * SHARP METHOD MAPPING:
 * ---------------------------------------------------------------------------
 * crop   → sharp.extract({ left, top, width, height })
 * rotate → sharp.rotate(angle)  — 90/180/270 only (lossless)
 * flip   → sharp.flip()  = vertical mirror   (Y axis)
 *          sharp.flop()  = horizontal mirror  (X axis)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management — Image Editor Service
 * ============================================================================
 */

import sharp from 'sharp';
import { VALID_ROTATION_ANGLES, VALID_FLIP_AXES } from './config.js';

/**
 * Crop a rectangular region from the image.
 *
 * @param {Buffer} inputBuffer - Raw image data
 * @param {Object} params - Crop parameters
 * @param {number} params.x - Left offset in pixels
 * @param {number} params.y - Top offset in pixels
 * @param {number} params.width - Crop width in pixels
 * @param {number} params.height - Crop height in pixels
 * @returns {Promise<Buffer>}
 */
export async function crop(inputBuffer, { x, y, width, height }) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError('Input must be a Buffer');
  }

  const left = Math.round(x);
  const top = Math.round(y);
  const w = Math.round(width);
  const h = Math.round(height);

  if (left < 0 || top < 0 || w <= 0 || h <= 0) {
    throw new Error('Crop dimensions must be positive and offsets non-negative');
  }

  const metadata = await sharp(inputBuffer).metadata();

  if (left + w > metadata.width || top + h > metadata.height) {
    throw new Error(
      `Crop region (${left},${top} ${w}x${h}) exceeds image bounds (${metadata.width}x${metadata.height})`
    );
  }

  return sharp(inputBuffer)
    .extract({ left, top, width: w, height: h })
    .toBuffer();
}

/**
 * Rotate the image by a fixed angle.
 * Only 90, 180, and 270 degrees are supported (lossless).
 * 0 degrees returns the buffer unchanged.
 *
 * @param {Buffer} inputBuffer - Raw image data
 * @param {Object} params - Rotation parameters
 * @param {number} params.angle - Degrees clockwise (0, 90, 180, 270)
 * @returns {Promise<Buffer>}
 */
export async function rotate(inputBuffer, { angle }) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError('Input must be a Buffer');
  }

  const normalised = ((angle % 360) + 360) % 360;

  if (!VALID_ROTATION_ANGLES.includes(normalised)) {
    throw new Error(
      `Invalid rotation angle: ${angle}. Must be one of: ${VALID_ROTATION_ANGLES.join(', ')}`
    );
  }

  if (normalised === 0) {
    return inputBuffer;
  }

  return sharp(inputBuffer)
    .rotate(normalised)
    .toBuffer();
}

/**
 * Mirror the image along an axis.
 *
 * horizontal → sharp.flop() (left becomes right)
 * vertical   → sharp.flip() (top becomes bottom)
 *
 * @param {Buffer} inputBuffer - Raw image data
 * @param {Object} params - Flip parameters
 * @param {string} params.axis - 'horizontal' or 'vertical'
 * @returns {Promise<Buffer>}
 */
export async function flip(inputBuffer, { axis }) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError('Input must be a Buffer');
  }

  if (!VALID_FLIP_AXES.includes(axis)) {
    throw new Error(
      `Invalid flip axis: ${axis}. Must be one of: ${VALID_FLIP_AXES.join(', ')}`
    );
  }

  const pipeline = sharp(inputBuffer);

  if (axis === 'horizontal') {
    return pipeline.flop().toBuffer();
  }

  return pipeline.flip().toBuffer();
}
