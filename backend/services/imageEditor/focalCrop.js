/**
 * ============================================================================
 * Image Editor — Focal Point Cropping
 * ============================================================================
 *
 * Blueprint-aware cropping that respects a focal point.
 * Instead of always cropping from dead centre, the crop region
 * is centred on the focal point coordinates.
 *
 * HOW IT WORKS:
 * ---------------------------------------------------------------------------
 * 1. Read source image dimensions
 * 2. Calculate the largest region at the target aspect ratio
 *    that fits within the source image
 * 3. Centre that region on the focal point (x%, y%)
 * 4. Clamp to image bounds (focal point near an edge pushes
 *    the crop region inward rather than going out of bounds)
 * 5. Extract the region and resize to exact target dimensions
 *
 * EXAMPLE:
 * ---------------------------------------------------------------------------
 * Source: 1080x1350 portrait
 * Target: 1200x400 banner (3:1)
 * Focal: { x: 0.5, y: 0.25 } (face near top)
 *
 * The crop region will be a wide strip near the top of the image,
 * centred on the face, rather than the default centre strip that
 * would show the character's chest.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management — Image Editor Service
 * ============================================================================
 */

import sharp from 'sharp';
import { FOCAL_DEFAULTS, NAMED_POSITIONS, FOCAL_RANGE } from './config.js';

/**
 * Resolve a focal point value.
 * Accepts XY coordinates, a named position string, or falls back
 * to the blueprint default.
 *
 * @param {Object|string|null} focalInput - Focal point data
 * @param {string} [blueprintName] - Blueprint name for default lookup
 * @returns {{x: number, y: number}}
 */
function resolveFocalPoint(focalInput, blueprintName) {
  if (typeof focalInput === 'string') {
    const named = NAMED_POSITIONS[focalInput];
    if (!named) {
      throw new Error(
        `Unknown named position: ${focalInput}. Valid: ${Object.keys(NAMED_POSITIONS).join(', ')}`
      );
    }
    return { ...named };
  }

  if (focalInput && typeof focalInput.x === 'number' && typeof focalInput.y === 'number') {
    const x = Math.max(FOCAL_RANGE.min, Math.min(FOCAL_RANGE.max, focalInput.x));
    const y = Math.max(FOCAL_RANGE.min, Math.min(FOCAL_RANGE.max, focalInput.y));
    return { x, y };
  }

  if (blueprintName && FOCAL_DEFAULTS[blueprintName]) {
    return { ...FOCAL_DEFAULTS[blueprintName] };
  }

  return { ...FOCAL_DEFAULTS._default };
}

/**
 * Crop an image using a focal point and target dimensions.
 *
 * @param {Buffer} inputBuffer - Raw image data
 * @param {Object} params - Focal crop parameters
 * @param {number} params.targetWidth - Desired output width in pixels
 * @param {number} params.targetHeight - Desired output height in pixels
 * @param {Object|string} [params.focalPoint] - XY object or named position
 * @param {string} [params.blueprintName] - Blueprint name for default lookup
 * @returns {Promise<Buffer>}
 */
export async function focalCrop(inputBuffer, { targetWidth, targetHeight, focalPoint, blueprintName }) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError('Input must be a Buffer');
  }

  if (!targetWidth || !targetHeight || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('targetWidth and targetHeight must be positive numbers');
  }

  const metadata = await sharp(inputBuffer).metadata();
  const srcW = metadata.width;
  const srcH = metadata.height;

  const focal = resolveFocalPoint(focalPoint, blueprintName);

  const targetAspect = targetWidth / targetHeight;
  const srcAspect = srcW / srcH;

  let cropW;
  let cropH;

  if (srcAspect > targetAspect) {
    cropH = srcH;
    cropW = Math.round(srcH * targetAspect);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  cropW = Math.min(cropW, srcW);
  cropH = Math.min(cropH, srcH);

  let left = Math.round((focal.x * srcW) - (cropW / 2));
  let top = Math.round((focal.y * srcH) - (cropH / 2));

  left = Math.max(0, Math.min(left, srcW - cropW));
  top = Math.max(0, Math.min(top, srcH - cropH));

  return sharp(inputBuffer)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(targetWidth, targetHeight)
    .toBuffer();
}
