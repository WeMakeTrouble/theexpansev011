/**
 * ============================================================================
 * Vignette Effect — Radial Edge Darkening
 * ============================================================================
 *
 * Simulates the luminance falloff at CRT screen edges caused by
 * electron beam spread and tube geometry. On real CRT displays,
 * the electron gun sits behind the centre of the screen. Pixels
 * near the edges receive less beam intensity because the beam
 * travels further and hits the phosphor at a steeper angle.
 *
 * IMPLEMENTATION:
 * ---------------------------------------------------------------------------
 * 1. Precompute a 1024-entry lookup table mapping normalised
 *    squared distance (0.0–1.0) to a darkening factor. This
 *    eliminates Math.sqrt and Math.pow from the inner pixel loop.
 *
 * 2. For each pixel, calculate squared distance from the image
 *    centre. Map the squared-distance ratio to a LUT index using
 *    a single multiply and bitwise OR (integer truncation).
 *
 * 3. Look up the precomputed factor and multiply RGB channels.
 *
 * The power exponent 1.8 was chosen to match measured CRT edge
 * falloff curves — linear falloff (exponent 1.0) looks artificial,
 * while higher exponents (2.5+) create too sharp a boundary.
 *
 * Alpha channel is intentionally untouched — vignette affects
 * emission brightness, not pixel opacity.
 *
 * PERFORMANCE NOTES:
 * ---------------------------------------------------------------------------
 * - Squared distance avoids Math.sqrt entirely in the pixel loop.
 * - 1024-entry LUT avoids Math.pow entirely in the pixel loop.
 * - Per-row dySq precomputed outside the X loop.
 * - Inner loop contains only: multiply, add, multiply, bitwise OR,
 *   array lookup, three multiplies. No heavy math functions.
 * - For a 2160x2700 retina image (5.8M pixels), this eliminates
 *   5.8M Math.sqrt + 5.8M Math.pow calls.
 *
 * AUTHENTICITY NOTES:
 * ---------------------------------------------------------------------------
 * - CRT beam intensity falls off radially from centre.
 * - Power curve exponent 1.8 matches measured P1 phosphor displays.
 * - Smooth gradient prevents visible banding at default strength.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel data
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Object} params - Filter parameters
 * @param {number} params.vignetteStrength - Edge darkening 0.0–1.0
 * @returns {Buffer} Processed RGBA pixel data (alpha preserved)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import { DEFAULT_PARAMS } from './config.js';

/**
 * LUT resolution for vignette falloff curve.
 * 1024 steps provides smooth gradient with no visible banding.
 *
 * @type {number}
 */
const LUT_SIZE = 1024;

/**
 * Apply radial vignette darkening to raw pixel data.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel buffer
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} params - Filter parameters
 * @returns {Buffer} Processed RGBA pixel buffer (alpha preserved)
 */
export function applyVignette(pixelBuffer, width, height, params) {
  const expectedLength = width * height * 4;
  if (pixelBuffer.length !== expectedLength) {
    throw new RangeError(
      `Buffer size ${pixelBuffer.length} does not match ${width}x${height} RGBA (expected ${expectedLength})`
    );
  }

  const strengthRaw = params.vignetteStrength ?? DEFAULT_PARAMS.vignetteStrength;
  const strength = Math.max(0, Math.min(strengthRaw, 1));

  if (strength === 0) {
    return Buffer.from(pixelBuffer);
  }

  const pixels = new Uint8ClampedArray(pixelBuffer);
  const centreX = width / 2;
  const centreY = height / 2;
  const maxDistSq = centreX * centreX + centreY * centreY;
  const invMaxDistSq = 1.0 / maxDistSq;

  const vLUT = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const normalisedDistSq = i / LUT_SIZE;
    const normalisedDist = Math.sqrt(normalisedDistSq);
    const falloff = Math.pow(normalisedDist, 1.8) * strength;
    vLUT[i] = 1.0 - falloff;
  }

  for (let y = 0; y < height; y++) {
    const dySq = (y - centreY) * (y - centreY);
    const rowStart = y * width * 4;

    for (let x = 0; x < width; x++) {
      const dx = x - centreX;
      const distSq = dx * dx + dySq;
      const lutIdx = (distSq * invMaxDistSq * LUT_SIZE) | 0;
      const factor = vLUT[Math.min(lutIdx, LUT_SIZE)];

      const idx = rowStart + x * 4;
      pixels[idx] = pixels[idx] * factor;
      pixels[idx + 1] = pixels[idx + 1] * factor;
      pixels[idx + 2] = pixels[idx + 2] * factor;
    }
  }

  return Buffer.from(pixels);
}
