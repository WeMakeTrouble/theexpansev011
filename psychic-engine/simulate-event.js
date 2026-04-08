/**
 * ===========================================================================
 * SIMULATE EVENT — Psychic Event Injector for The Expanse
 * ===========================================================================
 *
 * PURPOSE:
 * CLI utility that injects a psychic event into a character's emotional
 * timeline. The event is stored in psychic_events with delta_p/a/d values
 * and a half_life_seconds decay rate. The Psychic Engine's event spike
 * layer will automatically pick it up on the next tick and blend it
 * into the character's emotional state with exponential decay.
 *
 * USAGE:
 *   node simulate-event.js <character_id> <event_type> [intensity] [half_life]
 *
 *   character_id  — hex ID (#XXXXXX) of target character
 *   event_type    — one of: trauma, joy, threat, victory, calm, grief
 *   intensity     — 0 to 1, default 0.5 (scales the delta magnitudes)
 *   half_life     — seconds until effect halves, default 300 (5 minutes)
 *
 * FLAGS:
 *   --process     — re-run engine on character after event injection
 *   --dry-run     — preview deltas without writing to database
 *
 * EXAMPLES:
 *   node simulate-event.js #700002 joy 0.8
 *   node simulate-event.js #700009 trauma 1.0 600
 *   node simulate-event.js #700003 calm 0.3 120 --process
 *   node simulate-event.js #700004 grief 0.5 --dry-run
 *
 * HOW IT WORKS:
 *   1. Validates inputs (hex format, known event type, numeric ranges)
 *   2. Scales event preset deltas by intensity
 *   3. Checks that scaled deltas are non-zero (warns on noop events)
 *   4. Inserts row into psychic_events with delta_p, delta_a, delta_d,
 *      half_life_seconds, and target_character
 *   5. Optionally re-processes the character through the engine to
 *      see immediate effect (--process flag)
 *
 * EVENT PRESETS:
 *   Each event type has base delta_p, delta_a, delta_d values that
 *   are scaled by the intensity parameter:
 *
 *   trauma  — p: -0.50, a: +0.30, d: -0.40 (pain, stress, helpless)
 *   joy     — p: +0.60, a: +0.20, d: +0.10 (happy, energised, slight control)
 *   threat  — p: -0.30, a: +0.50, d: -0.20 (fear, high alert, reduced control)
 *   victory — p: +0.40, a: -0.10, d: +0.50 (satisfied, calming, powerful)
 *   calm    — p: +0.10, a: -0.40, d: +0.10 (gentle peace, relaxation)
 *   grief   — p: -0.60, a: -0.20, d: -0.30 (deep numb sorrow, low energy,
 *             helpless — this models sustained grief not acute shock;
 *             acute grief would use trauma preset with high arousal)
 *
 *   All deltas are clamped to [-1, 1] after scaling (matching DB CHECK
 *   constraints on psychic_events.delta_p/a/d).
 *
 * V009 COMPARISON:
 *   v009 manually computed new emotional state and saved a frame directly,
 *   bypassing the engine's decay system. v010 inserts an event and lets
 *   the engine's event spike layer handle blending with exponential decay.
 *   This is architecturally correct — events decay naturally over time
 *   instead of being permanent state mutations.
 *
 * DEPENDENCIES:
 *   - pool (backend/db/pool.js) — database connection
 *   - generateHexId (backend/utils/hexIdGenerator.js) — event ID
 *   - PsychicEngine (./engine.js) — optional reprocessing
 *   - createModuleLogger (backend/utils/logger.js) — structured logging
 *
 * V010 STANDARDS:
 *   - Structured logger — no console.log (except _printUsage to stdout)
 *   - Frozen constants (EVENT_PRESETS, DEFAULTS)
 *   - Input validation on all parameters with specific error context
 *   - Hex IDs via canonical generator
 *   - Correlation ID threading
 *   - Clean pool drainage on exit
 *   - Dry-run support for safe testing
 *
 * HISTORY:
 *   v009 — Hardcoded deltas applied directly to state, bypassed decay
 *          system, console.log, no validation, no pool cleanup.
 *   v010 — Event injection into psychic_events table, exponential decay
 *          via engine, frozen presets, validation, structured logging,
 *          optional reprocessing, dry-run, noop detection, pool cleanup.
 * ===========================================================================
 */

import pool from '../backend/db/pool.js';
import generateHexId from '../backend/utils/hexIdGenerator.js';
import PsychicEngine from './engine.js';
import { createModuleLogger } from '../backend/utils/logger.js';
import crypto from 'crypto';

const logger = createModuleLogger('SimulateEvent');

// ===========================================================================
// Frozen Constants
// ===========================================================================

const EVENT_PRESETS = Object.freeze({
  trauma:  Object.freeze({ delta_p: -0.50, delta_a:  0.30, delta_d: -0.40 }),
  joy:     Object.freeze({ delta_p:  0.60, delta_a:  0.20, delta_d:  0.10 }),
  threat:  Object.freeze({ delta_p: -0.30, delta_a:  0.50, delta_d: -0.20 }),
  victory: Object.freeze({ delta_p:  0.40, delta_a: -0.10, delta_d:  0.50 }),
  calm:    Object.freeze({ delta_p:  0.10, delta_a: -0.40, delta_d:  0.10 }),
  grief:   Object.freeze({ delta_p: -0.60, delta_a: -0.20, delta_d: -0.30 })
});

const VALID_EVENT_TYPES = Object.keys(EVENT_PRESETS);

const DEFAULTS = Object.freeze({
  INTENSITY: 0.5,
  HALF_LIFE_SECONDS: 300
});

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Clamp value to [-1, 1] range.
 * @param {number} value
 * @returns {number}
 */
function _clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Clamp and round to 2 decimal places for numeric(4,2) storage.
 * @param {number} value
 * @returns {number}
 */
function _roundDelta(value) {
  return Math.round(_clamp(value) * 100) / 100;
}

/**
 * Validate hex ID format (#XXXXXX).
 * @param {string} id
 * @returns {boolean}
 */
function _validateHexId(id) {
  return id && typeof id === 'string' && /^#[0-9A-Fa-f]{6}$/.test(id);
}

/**
 * Check if all deltas round to zero (noop event).
 * @param {number} delta_p
 * @param {number} delta_a
 * @param {number} delta_d
 * @returns {boolean}
 */
function _isNoopEvent(delta_p, delta_a, delta_d) {
  return delta_p === 0 && delta_a === 0 && delta_d === 0;
}

/**
 * Print usage text to stdout (not through structured logger).
 * CLI help text should go directly to stdout for shell consumption.
 */
function _printUsage() {
  process.stdout.write([
    '',
    'Usage: node simulate-event.js <character_id> <event_type> [intensity] [half_life]',
    '',
    'Arguments:',
    '  character_id  hex ID (#XXXXXX)',
    '  event_type    one of: ' + VALID_EVENT_TYPES.join(', '),
    '  intensity     0 to 1, default ' + DEFAULTS.INTENSITY,
    '  half_life     seconds, default ' + DEFAULTS.HALF_LIFE_SECONDS,
    '',
    'Flags:',
    '  --process     re-run engine on character after event injection',
    '  --dry-run     preview deltas without writing to database',
    '',
    'Examples:',
    '  node simulate-event.js #700002 joy 0.8',
    '  node simulate-event.js #700009 trauma 1.0 600',
    '  node simulate-event.js #700003 calm 0.3 120 --process',
    '  node simulate-event.js #700004 grief 0.5 --dry-run',
    ''
  ].join('\n'));
}

// ===========================================================================
// Main
// ===========================================================================

/**
 * Inject a psychic event into a character's emotional timeline.
 *
 * @param {string} characterId — hex ID (#XXXXXX)
 * @param {string} eventType — preset name (trauma, joy, etc.)
 * @param {number} intensity — 0 to 1, scales preset deltas
 * @param {number} halfLifeSeconds — decay half-life in seconds
 * @param {boolean} shouldProcess — re-run engine after injection
 * @param {boolean} dryRun — preview only, no database write
 */
async function simulateEvent(characterId, eventType, intensity, halfLifeSeconds, shouldProcess, dryRun) {
  const correlationId = crypto.randomUUID();

  logger.info('Simulating psychic event', {
    correlationId,
    characterId,
    eventType,
    intensity,
    halfLifeSeconds,
    shouldProcess,
    dryRun
  });

  if (!_validateHexId(characterId)) {
    logger.error('Invalid character ID format: expected #XXXXXX', null, {
      characterId,
      provided: String(characterId)
    });
    process.exitCode = 1;
    return;
  }

  if (!VALID_EVENT_TYPES.includes(eventType)) {
    logger.error('Unknown event type', null, {
      eventType,
      provided: String(eventType),
      valid: VALID_EVENT_TYPES
    });
    process.exitCode = 1;
    return;
  }

  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    logger.error('Intensity must be a number between 0 and 1', null, {
      provided: intensity
    });
    process.exitCode = 1;
    return;
  }

  if (!Number.isFinite(halfLifeSeconds) || halfLifeSeconds <= 0) {
    logger.error('Half-life must be a positive number of seconds', null, {
      provided: halfLifeSeconds
    });
    process.exitCode = 1;
    return;
  }

  const preset = EVENT_PRESETS[eventType];
  const delta_p = _roundDelta(preset.delta_p * intensity);
  const delta_a = _roundDelta(preset.delta_a * intensity);
  const delta_d = _roundDelta(preset.delta_d * intensity);

  if (_isNoopEvent(delta_p, delta_a, delta_d)) {
    logger.warn('All deltas round to zero at this intensity — event would have no effect', {
      correlationId,
      eventType,
      intensity,
      deltas: { delta_p, delta_a, delta_d }
    });
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    logger.info('DRY RUN — event preview (no database write)', {
      correlationId,
      characterId,
      eventType,
      intensity,
      deltas: { delta_p, delta_a, delta_d },
      halfLifeSeconds,
      preset: EVENT_PRESETS[eventType]
    });
    return;
  }

  try {
    const charResult = await pool.query(
      'SELECT character_id, character_name FROM character_profiles WHERE character_id = $1',
      [characterId]
    );

    if (charResult.rows.length === 0) {
      logger.error('Character not found in database', null, {
        correlationId,
        characterId
      });
      process.exitCode = 1;
      return;
    }

    const characterName = charResult.rows[0].character_name;

    const eventId = await generateHexId('psychic_event_id');

    await pool.query(
      `INSERT INTO psychic_events
         (event_id, event_type, target_character, delta_p, delta_a, delta_d, half_life_seconds, influence_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        eventType,
        characterId,
        delta_p,
        delta_a,
        delta_d,
        halfLifeSeconds,
        JSON.stringify({
          source: 'simulate-event',
          intensity,
          preset: eventType,
          correlationId
        })
      ]
    );

    logger.info('Psychic event injected', {
      correlationId,
      eventId,
      characterId,
      characterName,
      eventType,
      deltas: { delta_p, delta_a, delta_d },
      halfLifeSeconds
    });

    if (shouldProcess) {
      logger.info('Re-processing character through engine', {
        correlationId,
        characterId
      });

      const engine = new PsychicEngine({ pool });
      const result = await engine.processCharacter(characterId, correlationId);

      if (result) {
        logger.info('Character reprocessed', {
          correlationId,
          characterId,
          characterName,
          frameId: result.frameId,
          emotionalState: result.emotionalState,
          metrics: result.metrics
        });
      } else {
        logger.warn('Character has no traits, could not reprocess', {
          correlationId,
          characterId
        });
      }
    }

  } catch (error) {
    logger.error('Event simulation failed', error, { correlationId, characterId });
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ===========================================================================
// CLI Argument Parsing
// ===========================================================================

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));

const characterId = args[0];
const eventType = args[1];
const intensity = parseFloat(args[2] || String(DEFAULTS.INTENSITY));
const halfLifeSeconds = parseInt(args[3] || String(DEFAULTS.HALF_LIFE_SECONDS), 10);
const shouldProcess = flags.includes('--process');
const dryRun = flags.includes('--dry-run');

if (!characterId || !eventType) {
  _printUsage();
  process.exit(1);
}

simulateEvent(characterId, eventType, intensity, halfLifeSeconds, shouldProcess, dryRun);
