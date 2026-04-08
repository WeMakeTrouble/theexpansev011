/**
 * ============================================================================
 * Image Processor — Configuration
 * ============================================================================
 *
 * Blueprint definitions and default CRT filter parameters.
 * Config-driven: add new blueprints or change defaults here only.
 * No code changes required elsewhere when adding presets.
 *
 * BLUEPRINT RATIONALE (2026 FAANG Mobile-First Standards):
 * ---------------------------------------------------------------------------
 * - 4:5 portrait ratio dominates mobile feeds (Instagram, Facebook,
 *   LinkedIn, Threads) — maximises screen real estate on phones
 * - 9:16 full-screen ratio for character reveals and immersive content
 * - 1:1 square for avatars, thumbnails, and radar (universal)
 * - 1080px width is the 2026 industry standard baseline
 * - 2x retina variants at 2160px for high-density displays
 * - 16:9 landscape for desktop banners and headers
 *
 * NOTE: Blueprints upgraded from original brief dimensions (512/1024)
 * to 1080-base mobile-first per 2026 FAANG standards.
 *
 * IMMUTABILITY:
 * ---------------------------------------------------------------------------
 * All exported constants are Object.freeze'd to prevent accidental
 * mutation. The processor must spread DEFAULT_PARAMS into a new
 * object before applying overrides.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

/**
 * Standard image dimension presets.
 * Each blueprint defines target width, height, and resize behaviour.
 * Adding new presets requires only adding entries here.
 *
 * @type {Object.<string, {width: number, height: number, fit: string, position: string, description: string}>}
 */
export const BLUEPRINTS = Object.freeze({
  profile: {
    width: 1080,
    height: 1350,
    fit: 'cover',
    position: 'center',
    description: 'Character portrait card (4:5 mobile-first)'
  },
  profile_hd: {
    width: 2160,
    height: 2700,
    fit: 'cover',
    position: 'center',
    description: 'Retina character portrait (4:5 at 2x density)'
  },
  gallery: {
    width: 1080,
    height: 810,
    fit: 'cover',
    position: 'center',
    description: 'Scene art and lore images (4:3 landscape)'
  },
  thumbnail: {
    width: 128,
    height: 128,
    fit: 'cover',
    position: 'center',
    description: 'Small icon for lists and menus (1:1 square)'
  },
  banner: {
    width: 1200,
    height: 400,
    fit: 'cover',
    position: 'center',
    description: 'Wide header banner (3:1 landscape)'
  },
  radar: {
    width: 512,
    height: 512,
    fit: 'cover',
    position: 'center',
    description: 'Psychic radar character portrait (1:1 square)'
  },
  card_mobile: {
    width: 1080,
    height: 1920,
    fit: 'cover',
    position: 'center',
    description: 'Full-screen character reveal (9:16 vertical)'
  }
});

/**
 * Default CRT filter parameters.
 * Every value is overridable at call time.
 * Defaults tuned for authentic early 1980s P1 green phosphor look.
 *
 * The processor MUST spread these into a new object before applying
 * overrides. Never mutate DEFAULT_PARAMS directly.
 *
 * PARAMETER RANGES:
 * ---------------------------------------------------------------------------
 * scanlineIntensity : 0.0–1.0  (0 = off, 1 = maximum darkness)
 * scanlineThickness : 1–4      (pixel height of dark rows)
 * bloomAmount       : 0.0–1.0  (0 = off, 1 = heavy glow)
 * bloomThreshold    : 0.0–1.0  (luminance cutoff for bloom)
 * bloomRadius       : 1.0–20.0 (gaussian blur radius in pixels)
 * noiseLevel        : 0.0–1.0  (0 = clean, 1 = heavy static)
 * noiseSeed         : null or int (null = derive from input hash)
 * vignetteStrength  : 0.0–1.0  (0 = off, 1 = heavy edge darkening)
 * barrelAmount      : 0.0–0.15 (CRT glass curvature, 0 = off)
 * brightness        : 0.5–2.0  (multiplier, 1.0 = unchanged)
 * contrast          : 0.5–2.0  (multiplier, 1.0 = unchanged)
 * gamma             : 1.0–3.0  (phosphor response curve, 1.8 = CRT)
 * greenIntensity    : 0.0–2.0  (brand green saturation)
 * sharpenAmount     : 0.0–1.0  (final sharpening pass)
 * sharpenRadius     : 0.3–3.0  (sharpening kernel radius)
 *
 * @type {Object}
 */
export const DEFAULT_PARAMS = Object.freeze({
  scanlineIntensity: 0.30,
  scanlineThickness: 1,
  bloomAmount: 0.25,
  bloomThreshold: 0.60,
  bloomRadius: 3.5,
  noiseLevel: 0.05,
  noiseSeed: null,
  vignetteStrength: 0.35,
  barrelAmount: 0.00,
  brightness: 1.0,
  contrast: 1.1,
  gamma: 1.8,
  greenIntensity: 1.0,
  sharpenAmount: 0.3,
  sharpenRadius: 0.5
});

/**
 * Brand colour palette for The Expanse.
 * Primary green #00FF75 broken into RGB components for pixel math.
 *
 * @type {Object}
 */
export const BRAND_COLOURS = Object.freeze({
  primary: { r: 0, g: 255, b: 117 },
  background: { r: 0, g: 0, b: 0 }
});


/**
 * Blue-to-green ratio derived from brand colour #00FF75.
 * 117 (blue component) / 255 (green component) = 0.459
 * This gives the characteristic cyan-green tint of our phosphor.
 * Used by phosphor.js and bloom.js for consistent colour mapping.
 *
 * @type {number}
 */
export const BLUE_RATIO = BRAND_COLOURS.primary.b / BRAND_COLOURS.primary.g;
/**
 * Maximum upscale ratio before switching from cover to contain+pad.
 * If a source image requires enlargement beyond this ratio to fill
 * the blueprint dimensions, the processor switches to contain mode
 * and pads with black (#000000) instead.
 *
 * @type {number}
 */
export const MAX_UPSCALE_RATIO = 1.5;
