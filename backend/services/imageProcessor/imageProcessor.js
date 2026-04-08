/**
 * ============================================================================
 * Image Processor — Main CRT Processing Pipeline
 * ============================================================================
 *
 * Orchestrates the complete image processing pipeline for The Expanse.
 * Takes a raw image buffer, resizes to blueprint dimensions, applies
 * CRT effects in the correct physical order, and returns a PNG buffer
 * with structured metadata.
 *
 * PIPELINE ORDER:
 * ---------------------------------------------------------------------------
 * 1. Resize        — Scale to blueprint dimensions (Sharp, Lanczos3)
 * 2. Phosphor      — Greyscale + gamma curve + green channel tinting
 * 3. Bloom         — Threshold-based phosphor glow (async, uses Sharp)
 * 4. Scanlines     — Horizontal CRT line simulation
 * 5. Vignette      — Radial edge darkening
 * 6. Noise         — Deterministic analog grain (Mulberry32 PRNG)
 * 7. Distortion    — Barrel distortion pixel remap (optional, off by default)
 * 8. Sharpen       — Final unsharp mask to restore detail (Sharp)
 * 9. Encode        — Output as PNG (compression level 9, no interlacing)
 *
 * The order matters physically:
 * - Phosphor must come first (converts RGB to green monochrome)
 * - Bloom must follow phosphor (needs green channel luminance data)
 * - Scanlines after bloom (bloom should bleed across scanline gaps)
 * - Vignette after scanlines (edge darkening affects everything)
 * - Noise after vignette (noise should be visible even in dark edges)
 * - Distortion last of the pixel effects (warps the final composite)
 * - Sharpen at the end (restores detail lost by bloom/noise)
 *
 * DUAL MODE:
 * ---------------------------------------------------------------------------
 * - Programmatic: import { processImage } from './imageProcessor.js'
 *   Returns { buffer, metadata } — no filesystem access.
 * - CLI: will be wrapped by cli.js (separate file, not here).
 *
 * DETERMINISM:
 * ---------------------------------------------------------------------------
 * Same input buffer + same parameters = identical SHA-256 hash.
 * All effects are deterministic. Noise seed derived from input hash
 * when noiseSeed is null (default).
 *
 * @param {Buffer} inputBuffer - Raw image buffer (PNG/JPG/WEBP)
 * @param {Object} options - Processing options (merged with defaults)
 * @param {string} options.blueprint - Blueprint preset name
 * @returns {Promise<{buffer: Buffer, metadata: Object}>}
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

import sharp from 'sharp';
import crypto from 'crypto';
import { BLUEPRINTS, DEFAULT_PARAMS, MAX_UPSCALE_RATIO } from './config.js';
import { applyPhosphor } from './phosphor.js';
import { applyBloom } from './bloom.js';
import { applyScanlines } from './scanlines.js';
import { applyVignette } from './vignette.js';
import { applyNoise } from './noise.js';
import { applyDistortion } from './distortion.js';

/**
 * Process an image through the complete CRT pipeline.
 *
 * @param {Buffer} inputBuffer - Raw image data (PNG/JPG/WEBP)
 * @param {Object} [userOptions={}] - Override any DEFAULT_PARAMS values
 * @param {string} [userOptions.blueprint='profile'] - Blueprint preset
 * @returns {Promise<{buffer: Buffer, metadata: Object}>}
 */
export async function processImage(inputBuffer, userOptions = {}) {
  if (!Buffer.isBuffer(inputBuffer)) {
    throw new TypeError('Input must be a Buffer');
  }
  if (inputBuffer.length === 0) {
    throw new Error('Input buffer is empty');
  }
  if (inputBuffer.length > 50 * 1024 * 1024) {
    throw new Error('Input image exceeds 50MB limit');
  }

  const startTime = performance.now();

  const blueprintName = userOptions.blueprint ?? 'profile';
  const blueprint = BLUEPRINTS[blueprintName];
  if (!blueprint) {
    throw new Error(
      `Unknown blueprint: ${blueprintName}. Available: ${Object.keys(BLUEPRINTS).join(', ')}`
    );
  }

  const params = { ...DEFAULT_PARAMS, ...userOptions };

  const originalMeta = await sharp(inputBuffer).metadata();

  const widthRatio = blueprint.width / originalMeta.width;
  const heightRatio = blueprint.height / originalMeta.height;
  const maxRatio = Math.max(widthRatio, heightRatio);

  let resizeOptions = {
    width: blueprint.width,
    height: blueprint.height,
    fit: blueprint.fit,
    position: blueprint.position,
    kernel: sharp.kernel.lanczos3
  };

  if (maxRatio > MAX_UPSCALE_RATIO) {
    resizeOptions.fit = 'contain';
    resizeOptions.background = { r: 0, g: 0, b: 0, alpha: 1 };
  }

  const resized = await sharp(inputBuffer)
    .resize(resizeOptions)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const width = resized.info.width;
  const height = resized.info.height;
  let pixelBuffer = resized.data;

  const pipelineSteps = ['resize'];

  pixelBuffer = applyPhosphor(pixelBuffer, width, height, params);
  pipelineSteps.push('phosphor');

  pixelBuffer = await applyBloom(pixelBuffer, width, height, params);
  pipelineSteps.push('bloom');

  pixelBuffer = applyScanlines(pixelBuffer, width, height, params);
  pipelineSteps.push('scanlines');

  pixelBuffer = applyVignette(pixelBuffer, width, height, params);
  pipelineSteps.push('vignette');

  if (params.noiseSeed === null) {
    params.noiseSeed = parseInt(
      crypto.createHash('md5').update(inputBuffer).digest('hex').slice(0, 8),
      16
    ) >>> 0;
  }

  pixelBuffer = applyNoise(pixelBuffer, width, height, params);
  pipelineSteps.push('noise');

  if (params.barrelAmount > 0) {
    pixelBuffer = applyDistortion(pixelBuffer, width, height, params);
    pipelineSteps.push('distortion');
  }

  let outputSharp = sharp(pixelBuffer, {
    raw: { width, height, channels: 4 }
  });

  if (params.sharpenAmount > 0) {
    outputSharp = outputSharp.sharpen({
      sigma: params.sharpenRadius,
      m1: params.sharpenAmount,
      m2: params.sharpenAmount
    });
    pipelineSteps.push('sharpen');
  }

  const outputBuffer = await outputSharp
    .png({ compressionLevel: 9, adaptiveFiltering: true, force: true })
    .toBuffer();

  pipelineSteps.push('encode');

  const durationMs = Math.round(performance.now() - startTime);
  const outputHash = crypto.createHash('sha256').update(outputBuffer).digest('hex');

  const metadata = {
    original: {
      width: originalMeta.width,
      height: originalMeta.height,
      format: originalMeta.format,
      hasAlpha: originalMeta.hasAlpha ?? false,
      channels: originalMeta.channels
    },
    output: {
      width,
      height,
      format: 'png',
      mimeType: 'image/png',
      fileSizeBytes: outputBuffer.length,
      channels: 4
    },
    blueprint: blueprintName,
    parameters: {
      scanlineIntensity: params.scanlineIntensity,
      scanlineThickness: params.scanlineThickness,
      bloomAmount: params.bloomAmount,
      bloomThreshold: params.bloomThreshold,
      bloomRadius: params.bloomRadius,
      noiseLevel: params.noiseLevel,
      noiseSeed: params.noiseSeed,
      vignetteStrength: params.vignetteStrength,
      barrelAmount: params.barrelAmount,
      brightness: params.brightness,
      contrast: params.contrast,
      gamma: params.gamma,
      greenIntensity: params.greenIntensity,
      sharpenAmount: params.sharpenAmount,
      sharpenRadius: params.sharpenRadius
    },
    processing: {
      durationMs,
      pipelineSteps
    },
    hash: {
      algorithm: 'sha256',
      value: outputHash
    },
    timestamp: new Date().toISOString()
  };

  return { buffer: outputBuffer, metadata };
}
