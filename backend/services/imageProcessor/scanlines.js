/**
 * ============================================================================
 * Scanlines Effect — Horizontal CRT Line Simulation
 * ============================================================================
 *
 * Simulates the visible horizontal scan gaps of a CRT electron beam.
 * On real CRT displays, the electron gun scans left-to-right in
 * horizontal lines. Between active lines there are dark gaps where
 * the phosphor is not excited. At close viewing distance these gaps
 * are clearly visible as thin dark horizontal stripes.
 *
 * IMPLEMENTATION:
 * ---------------------------------------------------------------------------
 * Darkens alternating horizontal rows of pixels. The pattern is:
 *   - scanlineThickness rows at reduced brightness (dark lines)
 *   - scanlineThickness rows at full brightness (active lines)
 *   - Repeat
 *
 * The intensity parameter controls how much the dark rows are dimmed:
 *   0.0 = no effect (dark rows same as active rows)
 *   1.0 = maximum effect (dark rows are pure black)
 *
 * Alpha channel is intentionally untouched — scanlines affect
 * emission brightness, not pixel opacity.
 *
 * AUTHENTICITY NOTES:
 * ---------------------------------------------------------------------------
 * - At 1080px height, 1px thickness produces ~540 visible scanlines,
 *   which closely matches a 525-line NTSC CRT signal.
 * - At 2700px retina height, 2px thickness is more appropriate.
 * - The effect is purely deterministic (row position only, no noise).
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel data
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Object} params - Filter parameters
 * @param {number} params.scanlineIntensity - Dimming amount 0.0–1.0
 * @param {number} params.scanlineThickness - Pixel height of dark rows 1–4
 * @returns {Buffer} Processed RGBA pixel data (alpha preserved)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import { DEFAULT_PARAMS } from './config.js';

/**
 * Apply horizontal scanline darkening to raw pixel data.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel buffer
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} params - Filter parameters
 * @returns {Buffer} Processed RGBA pixel buffer (alpha preserved)
 */
export function applyScanlines(pixelBuffer, width, height, params) {
  const expectedLength = width * height * 4;
  if (pixelBuffer.length !== expectedLength) {
    throw new RangeError(
      `Buffer size ${pixelBuffer.length} does not match ${width}x${height} RGBA (expected ${expectedLength})`
    );
  }

  const intensity = params.scanlineIntensity ?? DEFAULT_PARAMS.scanlineIntensity;
  const thickness = Math.max(1, params.scanlineThickness ?? DEFAULT_PARAMS.scanlineThickness);

  if (intensity === 0) {
    return Buffer.from(pixelBuffer);
  }

  const pixels = new Uint8ClampedArray(pixelBuffer);
  const dimFactor = 1.0 - intensity;
  const period = thickness * 2;

  for (let y = 0; y < height; y++) {
    const positionInPeriod = y % period;
    const isDarkRow = positionInPeriod < thickness;

    if (!isDarkRow) {
      continue;
    }

    const rowStart = y * width * 4;

    for (let x = 0; x < width; x++) {
      const idx = rowStart + x * 4;
      pixels[idx] = pixels[idx] * dimFactor;
      pixels[idx + 1] = pixels[idx + 1] * dimFactor;
      pixels[idx + 2] = pixels[idx + 2] * dimFactor;
    }
  }

  return Buffer.from(pixels);
}
