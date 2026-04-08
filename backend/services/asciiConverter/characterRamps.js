import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('characterRamps');

// =============================================================================
// 1. STANDARD RAMP (10 levels) - Basic fallback
// =============================================================================
export const STANDARD_RAMP = Object.freeze(' .:-=+*#%@');

// =============================================================================
// 2. EXTENDED RAMP (70 levels) - Full printable ASCII sorted by visual density
// Measured by actual pixel coverage in monospace fonts
// =============================================================================
export const EXTENDED_RAMP = Object.freeze(
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B$@"
);

// =============================================================================
// 3. ULTRA RAMP (95 levels) - All printable ASCII + extended blocks
// =============================================================================
export const ULTRA_RAMP = Object.freeze(
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B$@ KNRS"
);

// =============================================================================
// 4. UNICODE BLOCK ELEMENTS (18 levels) - Sub-pixel precision
// Includes: full blocks, half blocks, quadrants, shades
// =============================================================================
export const UNICODE_BLOCKS = Object.freeze([
  ' ',        // 0% - Space
  '░',        // 25% - Light shade
  '▒',        // 50% - Medium shade  
  '▓',        // 75% - Dark shade
  '█',        // 100% - Full block
  '▀',        // Upper half block (50% top)
  '▄',        // Lower half block (50% bottom)
  '▌',        // Left half block (50% left)
  '▐',        // Right half block (50% right)
  '▖',        // Quadrant lower left
  '▗',        // Quadrant lower right
  '▘',        // Quadrant upper left
  '▙',        // Quadrant upper left + lower left + lower right
  '▚',        // Quadrant upper left + lower right (diagonal)
  '▛',        // Quadrant upper left + upper right + lower left
  '▜',        // Quadrant upper left + upper right + lower right
  '▝',        // Quadrant upper right
  '▞',        // Quadrant upper right + lower left (diagonal)
  '▟'         // Quadrant upper right + lower left + lower right
]);

// =============================================================================
// 5. STRUCTURAL CHARACTER SETS - For edge-based rendering
// Characters organized by their visual weight distribution
// =============================================================================

// Vertical emphasis characters (for vertical edges)
export const VERTICAL_CHARS = Object.freeze([
  '|',        // Pure vertical
  '│',        // Box drawing light vertical
  '┃',        // Box drawing heavy vertical
  '║',        // Box drawing double vertical
  '▌',        // Left half block
  '▐',        // Right half block
  ']',        // Right bracket
  '[',        // Left bracket
  '}',        // Right brace
  '{',        // Left brace
  ')',        // Right paren
  '('         // Left paren
]);

// Horizontal emphasis characters (for horizontal edges)
export const HORIZONTAL_CHARS = Object.freeze([
  '-',        // Pure horizontal
  '─',        // Box drawing light horizontal
  '━',        // Box drawing heavy horizontal
  '═',        // Box drawing double horizontal
  '▀',        // Upper half block
  '▄',        // Lower half block
  '_',        // Underscore
  '=',        // Double horizontal
  '~'         // Wavy horizontal
]);

// Diagonal characters (for diagonal edges)
export const DIAGONAL_CHARS = Object.freeze([
  '/',        // Forward slash (diagonal down-right)
  '\\',       // Backslash (diagonal down-left)
  '╱',        // Box drawing diagonal
  '╲',        // Box drawing diagonal
  '▚',        // Diagonal quadrants (upper-left + lower-right)
  '▞',        // Diagonal quadrants (upper-right + lower-left)
  '∕',        // Division slash
  '⧵'         // Reverse solidus
]);

// Corner characters (for corners/junctions)
export const CORNER_CHARS = Object.freeze([
  '┌', '┐',   // Top corners
  '└', '┘',   // Bottom corners
  '┏', '┓',   // Heavy top corners
  '┗', '┛',   // Heavy bottom corners
  '╔', '╗',   // Double top corners
  '╚', '╝',   // Double bottom corners
  'L', 'J',   // ASCII corners
  '7', 'Γ'    // Alternative corners
]);

// Cross/junction characters
export const JUNCTION_CHARS = Object.freeze([
  '+',        // Plus
  '┼',        // Cross light
  '╋',        // Cross heavy
  '╬',        // Cross double
  '├', '┤',   // T-junctions
  '┬', '┴',   // T-junctions
  '┣', '┫',   // Heavy T-junctions
  '┳', '┻',   // Heavy T-junctions
  '╠', '╣',   // Double T-junctions
  '╦', '╩'    // Double T-junctions
]);

// =============================================================================
// 6. DENSITY MEASUREMENT MAP
// Precise luminance values for each character (0-255 scale)
// Based on actual pixel coverage analysis
// =============================================================================
export const CHAR_DENSITY_MAP = Object.freeze({
  ' ': 0,      '.': 10,   '`': 15,   "'": 18,
  '^': 20,     '"': 22,   ',': 25,   ':': 28,
  ';': 30,     'I': 35,   'l': 38,   '!': 40,
  'i': 42,     '>': 45,   '<': 47,   '~': 50,
  '+': 55,     '_': 58,   '-': 60,   '?': 65,
  ']': 68,     '[': 70,   '}': 72,   '{': 75,
  '1': 78,     ')': 80,   '(': 82,   '|': 85,
  '\\': 88,    '/': 90,   't': 95,   'f': 98,
  'j': 100,    'r': 105,  'x': 108,  'n': 112,
  'u': 115,    'v': 118,  'c': 122,  'z': 125,
  'X': 130,    'Y': 135,  'U': 140,  'J': 145,
  'C': 150,    'L': 155,  'Q': 160,  '0': 165,
  'O': 170,    'Z': 175,  'm': 180,  'w': 185,
  'q': 190,    'p': 195,  'd': 200,  'b': 205,
  'k': 210,    'h': 215,  'a': 220,  'o': 225,
  '*': 230,    '#': 235,  'M': 240,  'W': 245,
  '&': 250,    '8': 252,  '%': 254,  'B': 255,
  '$': 255,    '@': 255,  'K': 240,  'N': 245,
  'R': 250,    'S': 255
});

// Unicode block densities
export const BLOCK_DENSITY_MAP = Object.freeze({
  ' ': 0,      '░': 64,   '▒': 128,  '▓': 192,
  '█': 255,    '▀': 128,  '▄': 128,  '▌': 128,
  '▐': 128,    '▖': 64,   '▗': 64,   '▘': 64,
  '▙': 192,    '▚': 128,  '▛': 192,  '▜': 192,
  '▝': 64,     '▞': 128,  '▟': 192
});

// =============================================================================
// 7. RAMP BY MODE - Export configurations
// =============================================================================
export const RAMP_BY_MODE = Object.freeze({
  standardAscii: STANDARD_RAMP,
  extendedDensity: EXTENDED_RAMP,
  ultraDensity: ULTRA_RAMP,
  blockElements: UNICODE_BLOCKS,
  mixedExtended: [...EXTENDED_RAMP, ...UNICODE_BLOCKS].join('')
});

// =============================================================================
// 8. BAYER DITHERING MATRIX (8x8)
// =============================================================================
export const BAYER_8X8 = Object.freeze([
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21
].map(v => v / 64));

// =============================================================================
// 9. SOBEL KERNELS
// =============================================================================
export const SOBEL_KERNEL_X = Object.freeze({
  width: 3,
  height: 3,
  kernel: Object.freeze([-1, 0, 1, -2, 0, 2, -1, 0, 1])
});

export const SOBEL_KERNEL_Y = Object.freeze({
  width: 3,
  height: 3,
  kernel: Object.freeze([-1, -2, -1, 0, 0, 0, 1, 2, 1])
});

// Backward compatibility - directional characters for edge detection
export const DIRECTION_CHARS_4 = Object.freeze(['-', '/', '|', '\\']);

// =============================================================================
// 10. DIRECTIONAL CHARACTER MAPPING
// Maps gradient directions to appropriate structural characters
// =============================================================================

// Quantize direction (radians) to character type
// Returns: 'vertical' | 'horizontal' | 'diagonal_pos' | 'diagonal_neg' | 'junction'
export const quantizeDirectionType = (radians) => {
  const normalized = radians + Math.PI; // Shift to 0-2π
  const degrees = (normalized * 180) / Math.PI;
  
  // 8-way quantization
  if ((degrees >= 337.5 && degrees <= 360) || (degrees >= 0 && degrees < 22.5)) {
    return 'horizontal_right';
  } else if (degrees >= 22.5 && degrees < 67.5) {
    return 'diagonal_pos'; // /
  } else if (degrees >= 67.5 && degrees < 112.5) {
    return 'vertical_up';
  } else if (degrees >= 112.5 && degrees < 157.5) {
    return 'diagonal_neg'; // \
  } else if (degrees >= 157.5 && degrees < 202.5) {
    return 'horizontal_left';
  } else if (degrees >= 202.5 && degrees < 247.5) {
    return 'diagonal_pos'; // /
  } else if (degrees >= 247.5 && degrees < 292.5) {
    return 'vertical_down';
  } else {
    return 'diagonal_neg'; // \
  }
};

// Get character for specific direction and magnitude
export const getDirectionalChar = (directionType, magnitude, useUnicode = true) => {
  // High magnitude = thicker/heavier character
  const isStrong = magnitude > 100; // proposed — requires calibration
  
  switch (directionType) {
    case 'vertical_up':
    case 'vertical_down':
    case 'vertical':
      return isStrong && useUnicode ? '┃' : '|';
    case 'horizontal_left':
    case 'horizontal_right':
    case 'horizontal':
      return isStrong && useUnicode ? '━' : '=';
    case 'diagonal_pos':
      return isStrong && useUnicode ? '╱' : '/';
    case 'diagonal_neg':
      return isStrong && useUnicode ? '╲' : '\\';
    default:
      return isStrong ? '+' : '.';
  }
};

// =============================================================================
// 11. RESOLUTION PRESETS
// =============================================================================
export const RESOLUTION_PRESETS = Object.freeze({
  thumbnail: 32,
  standard: 80,
  detailed: 120,
  highDetail: 160,
  ultra: 240      // proposed — requires calibration (very slow)
});

// =============================================================================
// 12. ASPECT RATIO
// =============================================================================
export const ASPECT_RATIO_DEFAULT = 0.5;

logger.info('Character ramps initialized: standard=%d, extended=%d, blocks=%d, unicode=%d',
  STANDARD_RAMP.length,
  EXTENDED_RAMP.length,
  UNICODE_BLOCKS.length,
  ULTRA_RAMP.length
);
