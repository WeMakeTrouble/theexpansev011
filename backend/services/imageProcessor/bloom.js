/**
 * ============================================================================
 * Bloom Effect — Phosphor Glow Bleed Simulation
 * ============================================================================
 *
 * Simulates the characteristic glow that CRT phosphors produce when
 * excited by a strong electron beam. On real P1 monitors, bright
 * screen regions emit light that bleeds into surrounding dark areas
 * due to phosphor persistence, electron beam spread, and glass
 * diffusion.
 *
 * IMPLEMENTATION:
 * ---------------------------------------------------------------------------
 * 1. Extract a brightness mask from the green channel (post-phosphor,
 *    the green channel carries all luminance information).
 *
 * 2. Apply luminance threshold — only pixels above bloomThreshold
 *    contribute to the glow. This prevents dark areas from blooming
 *    and preserves contrast.
 *
 * 3. Gaussian blur the thresholded mask using Sharp. The blur radius
 *    controls how far the glow spreads.
 *
 * 4. Additively composite the blurred glow back onto the original
 *    pixels, scaled by bloomAmount. Uint8ClampedArray handles
 *    overflow clamping natively at the C++ level.
 *
 * NOTE: This effect uses Sharp for the Gaussian blur stage because
 * implementing a high-quality separable Gaussian kernel in pure JS
 * would be significantly slower. All other pixel operations are
 * hand-written for precision.
 *
 * Alpha channel is intentionally untouched — bloom affects emission
 * brightness, not pixel opacity.
 *
 * PERFORMANCE NOTES:
 * ---------------------------------------------------------------------------
 * - Blue tint precomputed via 256-entry LUT (eliminates per-pixel
 *   float multiplication and rounding in the mask loop).
 * - Buffer.alloc zero-fills memory — no redundant zeroing needed.
 * - Uint8ClampedArray natively clamps 0–255, so Math.min is not
 *   required in the composite loop.
 *
 * AUTHENTICITY NOTES:
 * ---------------------------------------------------------------------------
 * - P1 phosphor has medium persistence (~60ms decay), creating a
 *   subtle afterglow halo around bright elements.
 * - Bloom radius 3.5px at 1080w simulates ~0.3% screen width bleed,
 *   consistent with measured CRT glow spread.
 * - Threshold at 60% luminance ensures only genuinely bright areas
 *   produce glow, matching real phosphor excitation curves.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel data (post-phosphor)
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Object} params - Filter parameters
 * @param {number} params.bloomAmount - Glow intensity 0.0–1.0
 * @param {number} params.bloomThreshold - Luminance cutoff 0.0–1.0
 * @param {number} params.bloomRadius - Blur spread in pixels 1.0–20.0
 * @returns {Promise<Buffer>} Processed RGBA pixel data (alpha preserved)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import sharp from 'sharp';
import { DEFAULT_PARAMS, BLUE_RATIO } from './config.js';

/**
 * Precomputed blue tint lookup table.
 * Maps excess luminance (0–255) to blue channel value using
 * BLUE_RATIO (0.459 from brand colour #00FF75).
 * Eliminates per-pixel float multiplication in the mask loop.
 *
 * @type {Uint8Array}
 */
const BLUE_TINT_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  BLUE_TINT_LUT[i] = Math.round(i * BLUE_RATIO);
}

/**
 * Apply phosphor bloom glow to raw pixel data.
 * This is the only effect that is async (due to Sharp blur).
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel buffer (post-phosphor)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} params - Filter parameters
 * @returns {Promise<Buffer>} Processed RGBA pixel buffer (alpha preserved)
 */
export async function applyBloom(pixelBuffer, width, height, params) {
  const expectedLength = width * height * 4;
  if (pixelBuffer.length !== expectedLength) {
    throw new RangeError(
      `Buffer size ${pixelBuffer.length} does not match ${width}x${height} RGBA (expected ${expectedLength})`
    );
  }

  const amount = params.bloomAmount ?? DEFAULT_PARAMS.bloomAmount;
  const threshold = params.bloomThreshold ?? DEFAULT_PARAMS.bloomThreshold;
  const radius = params.bloomRadius ?? DEFAULT_PARAMS.bloomRadius;

  if (amount === 0) {
    return Buffer.from(pixelBuffer);
  }

  const pixelCount = width * height;
  const thresholdValue = threshold * 255;

  const bloomMask = Buffer.alloc(width * height * 4);

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const greenValue = pixelBuffer[idx + 1];

    if (greenValue > thresholdValue) {
      const excess = greenValue - thresholdValue;
      bloomMask[idx + 1] = excess;
      bloomMask[idx + 2] = BLUE_TINT_LUT[excess];
      bloomMask[idx + 3] = 255;
    }
  }

  const blurredMask = await sharp(bloomMask, {
    raw: { width, height, channels: 4 }
  })
    .blur(Math.max(0.3, radius))
    .raw()
    .toBuffer();

  const output = new Uint8ClampedArray(pixelBuffer);

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    output[idx] += blurredMask[idx] * amount;
    output[idx + 1] += blurredMask[idx + 1] * amount;
    output[idx + 2] += blurredMask[idx + 2] * amount;
  }

  return Buffer.from(output);
}
