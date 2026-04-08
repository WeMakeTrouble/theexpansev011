/**
 * ============================================================================
 * Image Editor — Configuration
 * ============================================================================
 *
 * Focal point defaults, named position shortcuts, and editor constants.
 * Config-driven: add new named positions or change defaults here only.
 *
 * FOCAL POINT SYSTEM:
 * ---------------------------------------------------------------------------
 * Every image can have a focal point (x, y) expressed as percentages
 * from 0.0 to 1.0. The focal point tells blueprint-aware cropping
 * where the "important part" of the image is.
 *
 *   x: 0.0 = left edge,   0.5 = centre,  1.0 = right edge
 *   y: 0.0 = top edge,    0.5 = centre,  1.0 = bottom edge
 *
 * When no focal point is set, each blueprint uses its own default
 * from FOCAL_DEFAULTS below.
 *
 * IMMUTABILITY:
 * ---------------------------------------------------------------------------
 * All exported constants are Object.freeze'd to prevent accidental
 * mutation. Consuming modules must spread into new objects before
 * applying overrides.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management — Image Editor Service
 * ============================================================================
 */

/**
 * Per-blueprint focal point defaults.
 * Used when no explicit focal point is set on the image.
 * Banner defaults to y:0.3 (above centre) to keep heads in frame.
 * All others default to dead centre.
 *
 * @type {Object.<string, {x: number, y: number}>}
 */
export const FOCAL_DEFAULTS = Object.freeze({
  profile:     { x: 0.5, y: 0.4 },
  profile_hd:  { x: 0.5, y: 0.4 },
  gallery:     { x: 0.5, y: 0.5 },
  thumbnail:   { x: 0.5, y: 0.3 },
  banner:      { x: 0.5, y: 0.3 },
  radar:       { x: 0.5, y: 0.3 },
  card_mobile: { x: 0.5, y: 0.4 },
  _default:    { x: 0.5, y: 0.5 }
});

/**
 * Named position shortcuts.
 * Admin can select "face" or "top" instead of typing XY values.
 * Each maps to an XY percentage pair.
 *
 * @type {Object.<string, {x: number, y: number}>}
 */
export const NAMED_POSITIONS = Object.freeze({
  'top-left':     { x: 0.0, y: 0.0 },
  'top':          { x: 0.5, y: 0.0 },
  'top-right':    { x: 1.0, y: 0.0 },
  'left':         { x: 0.0, y: 0.5 },
  'center':       { x: 0.5, y: 0.5 },
  'right':        { x: 1.0, y: 0.5 },
  'bottom-left':  { x: 0.0, y: 1.0 },
  'bottom':       { x: 0.5, y: 1.0 },
  'bottom-right': { x: 1.0, y: 1.0 },
  'face':         { x: 0.5, y: 0.25 }
});

/**
 * Valid editing operations.
 * The editor orchestrator rejects any operation not in this list.
 *
 * @type {ReadonlyArray<string>}
 */
export const VALID_OPERATIONS = Object.freeze([
  'crop',
  'focalCrop',
  'rotate',
  'flip',
  'adjust'
]);

/**
 * Valid rotation angles (degrees clockwise).
 * Arbitrary angles excluded — only lossless 90-degree increments.
 *
 * @type {ReadonlyArray<number>}
 */
export const VALID_ROTATION_ANGLES = Object.freeze([0, 90, 180, 270]);

/**
 * Valid flip axes.
 *
 * @type {ReadonlyArray<string>}
 */
export const VALID_FLIP_AXES = Object.freeze(['horizontal', 'vertical']);

/**
 * Focal point value constraints.
 * Both x and y must be within this range.
 *
 * @type {{min: number, max: number}}
 */
export const FOCAL_RANGE = Object.freeze({
  min: 0.0,
  max: 1.0
});

/**
 * Adjustment parameter constraints.
 * Brightness and contrast multipliers must stay within these bounds
 * to prevent destructive over-adjustment.
 *
 * @type {Object}
 */
export const ADJUSTMENT_LIMITS = Object.freeze({
  brightness: { min: 0.2, max: 3.0, default: 1.0 },
  contrast:   { min: 0.2, max: 3.0, default: 1.0 }
});
