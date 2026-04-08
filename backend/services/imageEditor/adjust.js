/**
 * ============================================================================
 * Image Editor — Colour Adjustments
 * ============================================================================
 *
 * Brightness and contrast adjustments applied to source images
 * before CRT pipeline processing.
 *
 * SHARP METHOD MAPPING:
 * ---------------------------------------------------------------------------
 * brightness → sharp.modulate({ brightness })
 *              Multiplier: 1.0 = unchanged, <1 = darker, >1 = brighter
 *
 * contrast   → sharp.linear(a, b)
 *              Output = (a * input) + b
 *              Midpoint-stable: b = -(128 * (a - 1))
 *              This keeps mid-grey at 128 while stretching/compressing
 *              the tonal range around it.
 *
 * NOTE: sharp.modulate() does NOT accept a contrast parameter.
 *       That is a common misconception from the Sharp docs.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management — Image Editor Service
 * ============================================================================
 */

import sharp from 'sharp';
import { ADJUSTMENT_LIMITS } from './config.js';

/**
 * Adjust brightness and/or contrast of the image.
 * Either parameter can be omitted to leave that axis unchanged.
 *
 * @param {Buffer} inputBuffer - Raw image data
 * @param {Object} params - Adjustment parameters
 * @param {number} [params.brightness=1.0] - Brightness multiplier (0.2–3.0)
 * @param {number} [params.contrast=1.0] - Contrast multiplier (0.2–3.0)
 * @returns {Promise<Buffer>}
 */
export async function adjust(inputBuffer, { brightness, contrast } = {}) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError('Input must be a Buffer');
  }

  const br = brightness ?? ADJUSTMENT_LIMITS.brightness.default;
  const ct = contrast ?? ADJUSTMENT_LIMITS.contrast.default;

  if (br < ADJUSTMENT_LIMITS.brightness.min || br > ADJUSTMENT_LIMITS.brightness.max) {
    throw new Error(
      `Brightness ${br} out of range (${ADJUSTMENT_LIMITS.brightness.min}–${ADJUSTMENT_LIMITS.brightness.max})`
    );
  }

  if (ct < ADJUSTMENT_LIMITS.contrast.min || ct > ADJUSTMENT_LIMITS.contrast.max) {
    throw new Error(
      `Contrast ${ct} out of range (${ADJUSTMENT_LIMITS.contrast.min}–${ADJUSTMENT_LIMITS.contrast.max})`
    );
  }

  const noChange = br === 1.0 && ct === 1.0;
  if (noChange) {
    return inputBuffer;
  }

  let pipeline = sharp(inputBuffer);

  if (br !== 1.0) {
    pipeline = pipeline.modulate({ brightness: br });
  }

  if (ct !== 1.0) {
    const a = ct;
    const b = -(128 * (a - 1));
    pipeline = pipeline.linear(a, b);
  }

  return pipeline.toBuffer();
}
