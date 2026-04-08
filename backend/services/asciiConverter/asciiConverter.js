import sharp from 'sharp';
import { createModuleLogger } from '../../utils/logger.js';
import { safeFloat } from '../../utils/safeFloat.js';
import { mulberry32 } from '../imageProcessor/prng.js';
import {
  RESOLUTION_PRESETS,
  RAMP_BY_MODE,
  ASPECT_RATIO_DEFAULT,
  STANDARD_RAMP,
  EXTENDED_RAMP,
  ULTRA_RAMP,
  UNICODE_BLOCKS,
  CHAR_DENSITY_MAP,
  BLOCK_DENSITY_MAP,
  quantizeDirectionType,
  getDirectionalChar
} from './characterRamps.js';
import { applyBayerDithering, applyNoDithering } from './dithering.js';
import { computeSobelEdges, convolve2D } from './edgeDetector.js';

const logger = createModuleLogger('asciiConverter');

const djb2 = (buffer) => {
  let hash = 5381;
  for (let i = 0; i < buffer.length; i++) {
    hash = ((hash << 5) + hash) + (buffer[i] ?? 0);
  }
  return hash >>> 0;
};

const getDeterministicSeed = (inputBuffer) => {
  const sampleSize = Math.min(1024, inputBuffer.length);
  const sample = inputBuffer.subarray(0, sampleSize);
  return djb2(sample);
};

/**
 * Maps luminance value to character using precise density matching
 * Uses binary search for efficiency with large ramps
 * 
 * @param {number} luminance - 0-1 normalized luminance
 * @param {string[]} ramp - Character array sorted by density
 * @param {boolean} usePreciseMap - Use CHAR_DENSITY_MAP if available
 * @returns {string} Best matching character
 */
const mapLuminanceToChar = (luminance, ramp, usePreciseMap = false) => {
  if (!usePreciseMap || ramp.length <= 10) {
    // Simple index mapping for small ramps
    const charIdx = Math.floor(luminance * (ramp.length - 1));
    return ramp[charIdx] ?? ' ';
  }
  
  // Precise density matching for extended ramps
  const targetDensity = luminance * 255;
  let bestChar = ramp[0];
  let bestDiff = Math.abs((CHAR_DENSITY_MAP[ramp[0]] ?? 0) - targetDensity);
  
  // Binary search would be faster, but linear is fine for <100 chars
  for (const char of ramp) {
    const density = CHAR_DENSITY_MAP[char] ?? 128;
    const diff = Math.abs(density - targetDensity);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestChar = char;
    }
  }
  
  return bestChar;
};

/**
 * Main conversion function with structure matching
 */
const convert = async (inputBuffer, options = {}) => {
  const startTime = performance.now();
  
  const {
    resolutionMode = 'standard',
    charSetMode = 'extendedDensity', // Default to extended for better quality
    edgeMode = 'hybrid',
    ditherMode = 'bayer',
    seed = getDeterministicSeed(inputBuffer),
    aspectRatio = ASPECT_RATIO_DEFAULT,
    useUnicode = true,
    structureStrength = 0.7 // proposed — requires calibration (0-1, higher = more edges)
  } = options;
  
  const targetWidth = RESOLUTION_PRESETS[resolutionMode] ?? RESOLUTION_PRESETS.standard;
  const targetHeight = Math.floor(targetWidth * aspectRatio);
  
  // Process image
  const processed = await sharp(inputBuffer)
    .greyscale()
    .resize(targetWidth * 2, targetHeight * 2, { kernel: 'lanczos3' }) // 2x for edge detection
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const { data: luminanceBuffer, info } = processed;
  const { width: procWidth, height: procHeight } = info;
  
  logger.debug('Processing at %dx%d for output %dx%d', procWidth, procHeight, targetWidth, targetHeight);
  
  // Select ramp
  let ramp;
  if (charSetMode === 'blockElements') {
    ramp = Array.from(UNICODE_BLOCKS);
  } else {
    ramp = Array.from(RAMP_BY_MODE[charSetMode] ?? EXTENDED_RAMP);
  }
  
  const usePreciseMap = charSetMode !== 'blockElements' && ramp.length > 10;
  const ditherFn = ditherMode === 'bayer' ? applyBayerDithering : applyNoDithering;
  
  let outputChars = [];
  let metadata = {
    resolutionMode,
    charSetMode,
    edgeMode,
    ditherMode,
    seed,
    width: targetWidth,
    height: targetHeight,
    rampLength: ramp.length
  };
  
  // Compute edges if needed
  let edgeData = null;
  if (edgeMode !== 'none') {
    const { magnitude, direction } = await computeSobelEdges(
      luminanceBuffer, 
      procWidth, 
      procHeight
    );
    
    // Downsample edges to target resolution
    edgeData = {
      magnitude: new Float32Array(targetWidth * targetHeight),
      direction: new Float32Array(targetWidth * targetHeight)
    };
    
    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const srcY = Math.min(y * 2, procHeight - 1);
        const srcX = Math.min(x * 2, procWidth - 1);
        const srcIdx = srcY * procWidth + srcX;
        const dstIdx = y * targetWidth + x;
        
        edgeData.magnitude[dstIdx] = magnitude[srcIdx] ?? 0;
        edgeData.direction[dstIdx] = direction[srcIdx] ?? 0;
      }
    }
    
    metadata.edgeDetection = {
      maxMagnitude: Math.max(...edgeData.magnitude),
      meanMagnitude: edgeData.magnitude.reduce((a, b) => a + b, 0) / edgeData.magnitude.length
    };
  }
  
  // Convert pixels to ASCII
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const srcY = Math.min(y * 2, procHeight - 1);
      const srcX = Math.min(x * 2, procWidth - 1);
      const srcIdx = srcY * procWidth + srcX;
      const dstIdx = y * targetWidth + x;
      
      const rawLum = safeFloat(luminanceBuffer[srcIdx] ?? 0) / 255;
      const adjustedLum = ditherFn(rawLum, x, y, ramp.length);
      
      let char;
      
      if (edgeMode === 'none' || !edgeData) {
        // Pure tone-based
        char = mapLuminanceToChar(adjustedLum, ramp, usePreciseMap);
      } else {
        const mag = safeFloat(edgeData.magnitude[dstIdx] ?? 0);
        const dir = edgeData.direction[dstIdx] ?? 0;
        
        // Threshold for edge detection (proposed — requires calibration)
        const edgeThreshold = 30 * (1 - structureStrength) + 10;
        
        if (edgeMode === 'edgesOnly') {
          // Only show edges
          if (mag > edgeThreshold) {
            const dirType = quantizeDirectionType(dir);
            char = getDirectionalChar(dirType, mag, useUnicode);
          } else {
            char = ' ';
          }
        } else {
          // Hybrid: edges override tone
          if (mag > edgeThreshold) {
            const dirType = quantizeDirectionType(dir);
            char = getDirectionalChar(dirType, mag, useUnicode);
          } else {
            char = mapLuminanceToChar(adjustedLum, ramp, usePreciseMap);
          }
        }
      }
      
      outputChars.push(char);
    }
  }
  
  // Convert to string with newlines
  let asciiData = '';
  for (let y = 0; y < targetHeight; y++) {
    let row = '';
    for (let x = 0; x < targetWidth; x++) {
      row += outputChars[y * targetWidth + x] ?? ' ';
    }
    asciiData += row + '\n';
  }
  asciiData = asciiData.trimEnd();
  
  const duration = performance.now() - startTime;
  logger.info('ASCII conversion complete: %dx%d (%d chars) in %.2fms',
    targetWidth, targetHeight, targetWidth * targetHeight, duration);
  
  metadata.durationMs = duration;
  
  return {
    asciiData,
    widthChars: targetWidth,
    heightChars: targetHeight,
    metadata
  };
};

/**
 * Advanced conversion with structure-based matching
 * Uses character shapes to match local image structure, not just density
 */
const convertWithStructure = async (inputBuffer, options = {}) => {
  logger.warn('convertWithStructure: Full AISS implementation not yet complete, using hybrid mode');
  return convert(inputBuffer, { ...options, edgeMode: 'hybrid', structureStrength: 0.8 });
};

const convertWithCrt = async (inputBuffer, options = {}) => {
  logger.warn('convertWithCrt: CRT preprocessing not yet integrated');
  return convert(inputBuffer, options);
};

export const asciiConverter = Object.freeze({
  convert,
  convertWithStructure,
  convertWithCrt,
  presets: RESOLUTION_PRESETS,
  aspectRatioDefault: ASPECT_RATIO_DEFAULT
});

logger.info('ASCII Converter service initialized with structure matching');
