/**
 * ============================================================================
 * Validate Payload — Input Validation for Admin API Endpoints
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * A lightweight validation utility that checks incoming request bodies
 * before they reach SQL queries. Returns structured error messages
 * listing every field that failed and why.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import { validatePayload } from '../utils/validatePayload.js';
 *
 *   // In an Express route handler:
 *   try {
 *     validatePayload({
 *       character_name: { required: true, type: 'string', maxLength: 100 },
 *       openness: { type: 'number', min: 0, max: 100 },
 *       belt_level: { type: 'beltLevel' }
 *     }, req.body);
 *   } catch (error) {
 *     return res.status(400).json({ error: error.message, details: error.details });
 *   }
 *
 * VALIDATOR TYPES:
 * ---------------------------------------------------------------------------
 *   hexId       — Matches #XXXXXX (6 uppercase hex digits with leading #)
 *   string      — typeof string + maxLength enforcement
 *   text        — typeof string, no length limit (for TEXT columns)
 *   number      — Numeric value within min/max range
 *   integer     — Whole number within min/max range
 *   boolean     — Strict true/false
 *   beltLevel   — One of the 5 canonical belt levels
 *   jsonArray   — Array where all items are strings
 *   jsonObject  — Valid object (not null, not array)
 *   padValue    — Number between -1.0 and 1.0 (PAD coordinates)
 *   bigFive     — Number between 0 and 100 (Big Five personality traits)
 *
 * DESIGN:
 * ---------------------------------------------------------------------------
 * - Collects ALL errors before throwing (not fail-on-first)
 * - Error object has statusCode (400) and details array
 * - Does not modify or coerce data — only validates
 * - No external dependencies
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * ============================================================================
 */

import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('ValidatePayload');

/**
 * Canonical belt levels for The Expanse.
 * Order: white -> blue -> purple -> brown -> black
 * Source: Database CHECK constraints on knowledge_items and user_belt_progression
 * @type {ReadonlyArray<string>}
 */
const VALID_BELT_LEVELS = Object.freeze([
  'white_belt',
  'blue_belt',
  'purple_belt',
  'brown_belt',
  'black_belt'
]);

/**
 * Individual field validators.
 * Each returns true if valid, false if invalid.
 */
const _validators = {

  hexId(value) {
    return typeof value === 'string' && /^#[0-9A-F]{6}$/.test(value);
  },

  string(value, maxLength) {
    if (typeof value !== 'string') return false;
    if (maxLength !== undefined && value.length > maxLength) return false;
    return true;
  },

  text(value) {
    return typeof value === 'string';
  },

  number(value, min, max) {
    if (typeof value !== 'number' || Number.isNaN(value)) return false;
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
  },

  integer(value, min, max) {
    if (!Number.isInteger(value)) return false;
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
  },

  boolean(value) {
    return typeof value === 'boolean';
  },

  beltLevel(value) {
    return typeof value === 'string' && VALID_BELT_LEVELS.includes(value);
  },

  jsonArray(value) {
    if (!Array.isArray(value)) return false;
    return value.every(item => typeof item === 'string');
  },

  jsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  },

  padValue(value) {
    return typeof value === 'number' && !Number.isNaN(value) && value >= -1.0 && value <= 1.0;
  },

  bigFive(value) {
    return typeof value === 'number' && !Number.isNaN(value) && value >= 0 && value <= 100;
  }
};

/**
 * Human-readable error messages for each validator type.
 *
 * @param {string} field - Field name
 * @param {object} rules - Validation rules for this field
 * @returns {string} Error message
 */
function _errorMessage(field, rules) {
  switch (rules.type) {
    case 'hexId':
      return `${field} must be a valid hex ID (e.g., #700001)`;
    case 'string':
      return `${field} must be a string` + (rules.maxLength ? `, max ${rules.maxLength} characters` : '');
    case 'text':
      return `${field} must be a string`;
    case 'number':
      return `${field} must be a number` + _rangeHint(rules.min, rules.max);
    case 'integer':
      return `${field} must be a whole number` + _rangeHint(rules.min, rules.max);
    case 'boolean':
      return `${field} must be true or false`;
    case 'beltLevel':
      return `${field} must be one of: ${VALID_BELT_LEVELS.join(', ')}`;
    case 'jsonArray':
      return `${field} must be an array of strings`;
    case 'jsonObject':
      return `${field} must be a JSON object`;
    case 'padValue':
      return `${field} must be a number between -1.0 and 1.0`;
    case 'bigFive':
      return `${field} must be a number between 0 and 100`;
    default:
      return `${field} failed validation`;
  }
}

/**
 * Format a min/max range hint for error messages
 *
 * @param {number|undefined} min
 * @param {number|undefined} max
 * @returns {string}
 */
function _rangeHint(min, max) {
  if (min !== undefined && max !== undefined) return ` between ${min} and ${max}`;
  if (min !== undefined) return ` (minimum ${min})`;
  if (max !== undefined) return ` (maximum ${max})`;
  return '';
}

/**
 * Validate a request payload against a schema definition.
 * Collects all errors before throwing.
 *
 * @param {object} schema - Field definitions: { fieldName: { required, type, maxLength, min, max } }
 * @param {object} data - The request body to validate
 * @throws {Error} With statusCode 400 and details array listing all validation failures
 * @returns {true} If validation passes
 *
 * @example
 *   validatePayload({
 *     character_name: { required: true, type: 'string', maxLength: 100 },
 *     openness: { type: 'bigFive' },
 *     pad_baseline_p: { type: 'padValue' },
 *     belt_level: { type: 'beltLevel' }
 *   }, req.body);
 */
export function validatePayload(schema, data) {
  if (!data || typeof data !== 'object') {
    const error = new Error('Request body must be a JSON object');
    error.statusCode = 400;
    error.details = ['Expected JSON object, received: ' + typeof data];
    throw error;
  }

  const errors = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field} is required`);
      continue;
    }

    if (value === undefined || value === null) {
      continue;
    }

    const validator = _validators[rules.type];

    if (!validator) {
      errors.push(`${field} has unknown validation type: ${rules.type}`);
      continue;
    }

    let isValid;

    switch (rules.type) {
      case 'string':
        isValid = validator(value, rules.maxLength);
        break;
      case 'number':
      case 'integer':
        isValid = validator(value, rules.min, rules.max);
        break;
      default:
        isValid = validator(value);
        break;
    }

    if (!isValid) {
      errors.push(_errorMessage(field, rules));
    }
  }

  if (errors.length > 0) {
    logger.warn('Validation failed', { fieldCount: errors.length, errors });

    const error = new Error('Validation failed');
    error.statusCode = 400;
    error.details = errors;
    throw error;
  }

  return true;
}

/**
 * Export belt levels for use by other modules (e.g., route handlers, view modules)
 * @type {ReadonlyArray<string>}
 */
export const BELT_LEVELS = VALID_BELT_LEVELS;

export default validatePayload;
