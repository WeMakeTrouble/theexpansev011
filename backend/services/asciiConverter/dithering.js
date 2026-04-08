import { createModuleLogger } from '../../utils/logger.js';
import { BAYER_8X8 } from './characterRamps.js';

const logger = createModuleLogger('dithering');

/**
 * Applies Bayer ordered dithering to luminance value
 * @param {number} luminance - Normalized luminance (0-1)
 * @param {number} x - Pixel x coordinate
 * @param {number} y - Pixel y coordinate
 * @param {number} rampLength - Number of levels in character ramp
 * @returns {number} Adjusted luminance (0-1)
 */
export const applyBayerDithering = (luminance, x, y, rampLength) => {
  const threshold = BAYER_8X8[(y % 8) * 8 + (x % 8)];
  const adjustment = (threshold - 0.5) * (1 / rampLength);
  const adjusted = luminance + adjustment;
  
  // Clamp to valid range
  return Math.max(0, Math.min(1, adjusted));
};

/**
 * No-op dithering function for bypass mode
 */
export const applyNoDithering = (luminance) => luminance;

logger.info('Dithering module initialized (Bayer 8x8 matrix)');
