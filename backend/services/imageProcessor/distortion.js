/**
 * ============================================================================
 * Distortion Effect — CRT Barrel Distortion Pixel Remap
 * ============================================================================
 *
 * Simulates the visual warping caused by the curved glass front of
 * a CRT monitor. CRT tubes use a convex glass faceplate which bends
 * the displayed image outward at the edges — straight lines appear
 * to bow outward (barrel distortion).
 *
 * IMPLEMENTATION:
 * ---------------------------------------------------------------------------
 * For each pixel in the OUTPUT image, calculate where it should
 * sample from in the INPUT image using the radial distortion
 * formula (Brown-Conrady model):
 *
 *   r_distorted = r * (1 + k * r^2)
 *
 * Where:
 *   r = normalized distance from center (0.0–1.0)
 *   k = barrelAmount parameter (0.0–0.15)
 *   r_distorted = the source sampling radius
 *
 * This is a reverse mapping: we iterate output pixels and look up
 * where each one comes from in the source. This avoids holes in
 * the output that forward mapping would create.
 *
 * Nearest-neighbor sampling is used for speed and simplicity.
 * At our target resolutions (1080–2160px) the visual difference
 * from bilinear interpolation is negligible given the CRT aesthetic
 * is intentionally lo-fi.
 *
 * Alpha channel is preserved from source for mapped pixels.
 * Out-of-bounds pixels are set to opaque black (RGBA 0,0,0,255)
 * matching the appearance of a CRT bezel border.
 *
 * PERFORMANCE NOTES:
 * ---------------------------------------------------------------------------
 * - Normalized X coordinates precomputed into Float32Array (xMap)
 *   to eliminate redundant per-pixel division.
 * - Per-row ny precomputed outside the X loop.
 * - No Math.sqrt required — r^2 computed directly from nx/ny.
 * - Bitwise OR rounding replaces Math.round for integer truncation.
 * - Bit-shift indexing (x << 2) for 4-byte RGBA stride.
 *
 * AUTHENTICITY NOTES:
 * ---------------------------------------------------------------------------
 * - Default barrelAmount is 0.00 (disabled). Typical CRT glass
 *   curvature produces k values in the range 0.02–0.08.
 * - Values above 0.10 create exaggerated "fishbowl" effects.
 * - Maximum 0.15 matches extreme early 1970s CRT curvature.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel data
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Object} params - Filter parameters
 * @param {number} params.barrelAmount - Distortion strength 0.0–0.15
 * @returns {Buffer} Processed RGBA pixel data (alpha preserved)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import { DEFAULT_PARAMS } from './config.js';

/**
 * Apply barrel distortion pixel remapping to raw pixel data.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel buffer
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} params - Filter parameters
 * @returns {Buffer} Processed RGBA pixel buffer (alpha preserved)
 */
export function applyDistortion(pixelBuffer, width, height, params) {
  const expectedLength = width * height * 4;
  if (pixelBuffer.length !== expectedLength) {
    throw new RangeError(
      `Buffer size ${pixelBuffer.length} does not match ${width}x${height} RGBA (expected ${expectedLength})`
    );
  }

  const amountRaw = params.barrelAmount ?? DEFAULT_PARAMS.barrelAmount;
  const amount = Math.max(0, Math.min(amountRaw, 0.15));

  if (amount === 0) {
    return Buffer.from(pixelBuffer);
  }

  const source = new Uint8ClampedArray(pixelBuffer);
  const output = new Uint8ClampedArray(expectedLength);
  const halfW = width / 2;
  const halfH = height / 2;
  const invHalfW = 1.0 / halfW;
  const invHalfH = 1.0 / halfH;

  const xMap = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    xMap[x] = (x - halfW) * invHalfW;
  }

  for (let y = 0; y < height; y++) {
    const ny = (y - halfH) * invHalfH;
    const nySq = ny * ny;
    const outRowOffset = y * width * 4;

    for (let x = 0; x < width; x++) {
      const nx = xMap[x];
      const rSq = nx * nx + nySq;
      const f = 1.0 + amount * rSq;

      const srcX = (nx * f * halfW + halfW + 0.5) | 0;
      const srcY = (ny * f * halfH + halfH + 0.5) | 0;

      const outIdx = outRowOffset + (x << 2);

      if (srcX >= 0 && srcX < width && srcY >= 0 && srcY < height) {
        const srcIdx = (srcY * width + srcX) << 2;
        output[outIdx] = source[srcIdx];
        output[outIdx + 1] = source[srcIdx + 1];
        output[outIdx + 2] = source[srcIdx + 2];
        output[outIdx + 3] = source[srcIdx + 3];
      } else {
        output[outIdx + 3] = 255;
      }
    }
  }

  return Buffer.from(output);
}
