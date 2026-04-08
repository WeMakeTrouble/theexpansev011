/**
 * ============================================================================
 * Phosphor Effect — Greyscale + Gamma Curve + Green Channel Tinting
 * ============================================================================
 *
 * Converts a source image into a P1 green phosphor CRT appearance.
 * This is the foundation effect — all other CRT effects (scanlines,
 * bloom, noise, vignette) are applied on top of this output.
 *
 * PROCESSING PIPELINE:
 * ---------------------------------------------------------------------------
 * 1. Convert each pixel to luminance using ITU-R BT.709 formula:
 *    Y = 0.2126*R + 0.7152*G + 0.0722*B
 *
 * 2. Apply nonlinear gamma curve to simulate phosphor response:
 *    adjustedY = pow(Y / 255, 1 / gamma) * 255
 *    CRT phosphors do not respond linearly to electron beam
 *    intensity. Gamma 1.8 is the historical CRT standard.
 *    A precomputed 256-entry lookup table eliminates per-pixel
 *    Math.pow calls for performance on retina images.
 *
 * 3. Apply brightness and contrast adjustments:
 *    finalY = ((adjustedY - 128) * contrast + 128) * brightness
 *
 * 4. Map luminance to green phosphor colour:
 *    R = 0 (P1 phosphor emits no red)
 *    G = finalY * greenIntensity
 *    B = finalY * greenIntensity * 0.459 (117/255 blue ratio
 *        from brand colour #00FF75 gives the cyan-green tint)
 *
 * PHOSPHOR RESEARCH:
 * ---------------------------------------------------------------------------
 * P1 green phosphor (Zn2SiO4:Mn) emits at peak ~525nm.
 * Historical terminal values: #41FF00, #33FF33, #4AFF00.
 * Our brand #00FF75 is a brighter neon variant — intentionally
 * more saturated for readability on modern displays.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel data
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Object} params - Filter parameters
 * @param {number} params.gamma - Phosphor response curve (default 1.8)
 * @param {number} params.brightness - Brightness multiplier (default 1.0)
 * @param {number} params.contrast - Contrast multiplier (default 1.1)
 * @param {number} params.greenIntensity - Green saturation (default 1.0)
 * @returns {Buffer} Processed RGBA pixel data
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import { DEFAULT_PARAMS, BLUE_RATIO } from './config.js';


/**
 * Build a 256-entry gamma lookup table.
 * Eliminates per-pixel Math.pow calls. For a 2160x2700 retina image
 * (5.8 million pixels), this replaces 5.8M Math.pow calls with
 * 5.8M array lookups — significantly faster.
 *
 * @param {number} gamma - Gamma exponent value
 * @returns {Uint8ClampedArray} 256-entry lookup table
 */
function buildGammaTable(gamma) {
  const table = new Uint8ClampedArray(256);
  const inverseGamma = 1.0 / gamma;
  for (let i = 0; i < 256; i++) {
    table[i] = Math.pow(i / 255, inverseGamma) * 255;
  }
  return table;
}

/**
 * Apply P1 green phosphor effect to raw pixel data.
 *
 * @param {Buffer} pixelBuffer - Raw RGBA pixel buffer
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} params - Filter parameters
 * @returns {Buffer} Processed RGBA pixel buffer
 */
export function applyPhosphor(pixelBuffer, width, height, params) {
  const expectedLength = width * height * 4;
  if (pixelBuffer.length !== expectedLength) {
    throw new RangeError(
      `Buffer size ${pixelBuffer.length} does not match ${width}x${height} RGBA (expected ${expectedLength})`
    );
  }

  const pixels = new Uint8ClampedArray(pixelBuffer);
  const pixelCount = width * height;

  const gamma = params.gamma ?? DEFAULT_PARAMS.gamma;
  const brightness = params.brightness ?? DEFAULT_PARAMS.brightness;
  const contrast = params.contrast ?? DEFAULT_PARAMS.contrast;
  const greenIntensity = params.greenIntensity ?? DEFAULT_PARAMS.greenIntensity;
  const blueIntensity = greenIntensity * BLUE_RATIO;

  const gammaTable = buildGammaTable(gamma);

  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;

    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];

    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    const gammaCorrected = gammaTable[Math.round(luminance)];

    const contrasted = (gammaCorrected - 128) * contrast + 128;
    const final = Math.max(0, Math.min(255, contrasted * brightness));

    pixels[idx] = 0;
    pixels[idx + 1] = Math.min(255, final * greenIntensity);
    pixels[idx + 2] = Math.min(255, final * blueIntensity);
    pixels[idx + 3] = a;
  }

  return Buffer.from(pixels);
}
