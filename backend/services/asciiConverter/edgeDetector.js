import { createModuleLogger } from '../../utils/logger.js';
import { safeFloat } from '../../utils/safeFloat.js';
import {
  SOBEL_KERNEL_X,
  SOBEL_KERNEL_Y,
  DIRECTION_CHARS_4
} from './characterRamps.js';

const logger = createModuleLogger('edgeDetector');

/**
 * Applies 3x3 convolution to Float32Array with given kernel
 * Border pixels are left as 0 (zero-padding)
 * 
 * @param {Float32Array} input - Input pixel data
 * @param {number[]} kernel - 3x3 kernel array
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Float32Array} Convolved output
 */
export const convolve2D = (input, kernel, width, height) => {
  const output = new Float32Array(width * height);
  const [k00, k01, k02, k10, k11, k12, k20, k21, k22] = kernel;
  
  // Process interior pixels (1 to height-1, 1 to width-1)
  // Border pixels remain 0 (initialized by Float32Array)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      output[i] =
        input[i - width - 1] * k00 + input[i - width] * k01 + input[i - width + 1] * k02 +
        input[i - 1] * k10 + input[i] * k11 + input[i + 1] * k12 +
        input[i + width - 1] * k20 + input[i + width] * k21 + input[i + width + 1] * k22;
    }
  }
  
  return output;
};

/**
 * Computes Sobel edge magnitude and direction
 * Uses manual float convolution to preserve signed gradients (Sharp clamps to uint8)
 * 
 * @param {Buffer} imageBuffer - Raw image buffer from Sharp
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Object} { magnitude: Float32Array, direction: Float32Array, width, height }
 */
export const computeSobelEdges = async (imageBuffer, width, height) => {
  const startTime = performance.now();
  
  // Convert uint8 buffer to Float32Array for signed arithmetic
  const pixels = new Float32Array(imageBuffer.length);
  for (let i = 0; i < imageBuffer.length; i++) {
    pixels[i] = safeFloat(imageBuffer[i] ?? 0);
  }
  
  // Apply Sobel kernels
  const gx = convolve2D(pixels, SOBEL_KERNEL_X.kernel, width, height);
  const gy = convolve2D(pixels, SOBEL_KERNEL_Y.kernel, width, height);
  
  // Compute magnitude and direction
  const magnitude = new Float32Array(width * height);
  const direction = new Float32Array(width * height);
  
  for (let i = 0; i < pixels.length; i++) {
    const gX = safeFloat(gx[i]);
    const gY = safeFloat(gy[i]);
    
    magnitude[i] = Math.sqrt(gX * gX + gY * gY);
    direction[i] = Math.atan2(gY, gX); // Range: -π to π
  }
  
  const duration = performance.now() - startTime;
  logger.debug('Sobel edges computed: %dx%d in %.2fms', width, height, duration);
  
  return { magnitude, direction, width, height };
};

/**
 * Quantizes gradient direction into 4-way ASCII line character
 * 
 * @param {number} radians - Direction from Math.atan2 (range -π to π)
 * @returns {string} One of: '-', '/', '|', '\'
 */
export const quantizeDirection4 = (radians) => {
  // Shift to 0-2π range
  const normalized = radians + Math.PI;
  // Add π/8 offset (22.5°) to center buckets, divide by π/4 (45°) for 4 sectors
  const sector = Math.floor((normalized + Math.PI / 8) / (Math.PI / 4)) % 4;
  return DIRECTION_CHARS_4[sector] ?? '-';
};

/**
 * Maps edge information to ASCII characters
 * 
 * @param {Object} params
 * @param {Float32Array} params.magnitude - Edge magnitude array
 * @param {Float32Array} params.direction - Edge direction array
 * @param {string[]} params.luminanceChars - Characters from density mapping
 * @param {number} params.width - Grid width
 * @param {number} params.height - Grid height
 * @param {number} params.magnitudeThreshold - Threshold for edge detection (0-255 scale)
 * @returns {string[][]} 2D array of characters
 */
export const mapEdgesToChars = ({
  magnitude,
  direction,
  luminanceChars,
  width,
  height,
  magnitudeThreshold = 30 // proposed — requires calibration
}) => {
  const result = [];
  
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const mag = safeFloat(magnitude[idx] ?? 0);
      
      // If edge magnitude exceeds threshold, use directional character
      // Otherwise, use luminance-based character
      if (mag > magnitudeThreshold) {
        row.push(quantizeDirection4(direction[idx] ?? 0));
      } else {
        row.push(luminanceChars[idx] ?? ' ');
      }
    }
    result.push(row);
  }
  
  return result;
};

logger.info('Edge detector initialized (manual float convolution)');
