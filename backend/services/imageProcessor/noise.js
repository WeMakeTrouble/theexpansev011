/**
 * ============================================================================
 * Noise Effect — Deterministic Analog Signal Grain
 * ============================================================================
 *
 * Simulates analog signal interference between the video source and
 * the CRT display. On real terminals, electrical noise in cables,
 * power supplies, and the electron gun itself creates subtle random
 * brightness variations across the phosphor surface.
 *
 * IMPLEMENTATION:
 * ---------------------------------------------------------------------------
 * 1. Initialise Mulberry32 PRNG with the provided seed (or a seed
 *    derived from the input image hash if noiseSeed is null).
 *
 * 2. For each pixel, generate a noise value in the range
 *    [-0.5 * noiseLevel * 255, +0.5 * noiseLevel * 255].
 *
 * 3. Apply noise to the green channel only. On a P1 phosphor
 *    display, noise manifests as brightness fluctuations in the
 *    single phosphor colour — not as multi-colour static. The blue
 *    channel (cyan tint from #00FF75) receives proportional noise
 *    via the BLUE_RATIO to maintain colour consistency.
 *
 * 4. Uint8ClampedArray handles overflow/underflow clamping natively.
 *
 * DETERMINISM:
 * ---------------------------------------------------------------------------
 * Same seed + same image dimensions = identical noise pattern.
 * Uses Mulberry32 from prng.js — zero external dependencies,
 * no Math.random(), cross-platform consistent.
 *
 * Alpha channel is intentionally untouched — noise affects
 * emission brightness, not pixel opacity.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel data
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Object} params - Filter parameters
 * @param {number} params.noiseLevel - Noise intensity 0.0–1.0
 * @param {number|null} params.noiseSeed - PRNG seed (null = use default)
 * @returns {Buffer} Processed RGBA pixel data (alpha preserved)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import { DEFAULT_PARAMS, BLUE_RATIO } from './config.js';
import { mulberry32 } from './prng.js';

/**
 * Apply deterministic analog noise to raw pixel data.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel buffer
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} params - Filter parameters
 * @returns {Buffer} Processed RGBA pixel buffer (alpha preserved)
 */
export function applyNoise(pixelBuffer, width, height, params) {
  const expectedLength = width * height * 4;
  if (pixelBuffer.length !== expectedLength) {
    throw new RangeError(
      `Buffer size ${pixelBuffer.length} does not match ${width}x${height} RGBA (expected ${expectedLength})`
    );
  }

  const levelRaw = params.noiseLevel ?? DEFAULT_PARAMS.noiseLevel;
  const level = Math.max(0, Math.min(levelRaw, 1));

  if (level === 0) {
    return Buffer.from(pixelBuffer);
  }

  const seed = params.noiseSeed ?? DEFAULT_PARAMS.noiseSeed ?? 12345;
  const rng = mulberry32(seed);
  const pixels = new Uint8ClampedArray(pixelBuffer);
  const pixelCount = width * height;
  const noiseRange = level * 255;

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const noise = (rng() - 0.5) * noiseRange;
    const blueNoise = noise * BLUE_RATIO;

    pixels[idx + 1] += noise;
    pixels[idx + 2] += blueNoise;
  }

  return Buffer.from(pixels);
}
