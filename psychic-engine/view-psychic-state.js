/**
 * ===========================================================================
 * VIEW PSYCHIC STATE — Diagnostic Display for The Expanse
 * ===========================================================================
 *
 * PURPOSE:
 * CLI diagnostic tool that displays the current emotional state of all
 * characters in The Expanse. Shows latest psychic frame, current smoothed
 * mood, and proximity relationships in a human-readable terminal format.
 *
 * USAGE:
 *   node view-psychic-state.js
 *   node view-psychic-state.js --character #700002
 *
 * FLAGS:
 *   --character <id>  — filter to a single character
 *
 * WHAT IT DISPLAYS:
 *   1. CURRENT MOODS — from psychic_moods (smoothed, up-to-date)
 *   2. LATEST FRAMES — most recent psychic_frame per character
 *   3. PROXIMITY MAP — all psychological distance relationships
 *   4. SUMMARY — counts of characters, relationships, total frames
 *
 * OUTPUT:
 *   Display text goes to stdout (not structured logger). This is a
 *   human-readable diagnostic tool, not a service. Errors and operational
 *   messages use the structured logger.
 *
 * V009 COMPARISON:
 *   v009 queried ALL frames (not latest), had syntax errors on template
 *   literals, no filtering, no moods table, SELECT * on proximity,
 *   no pool cleanup.
 *
 * DEPENDENCIES:
 *   - pool (backend/db/pool.js) — database connection
 *   - createModuleLogger (backend/utils/logger.js) — error logging
 *
 * V010 STANDARDS:
 *   - Structured logger for errors only
 *   - stdout for display output (appropriate for CLI diagnostic)
 *   - Pool drainage on exit
 *   - Optional character filter
 *   - Latest-per-character queries (not full history)
 *
 * HISTORY:
 *   v009 — All frames not latest, syntax errors, no moods, SELECT *,
 *          no pool cleanup, no filtering.
 *   v010 — Latest per character, moods table, proper columns,
 *          pool cleanup, character filter, clean stdout formatting.
 * ===========================================================================
 */

import pool from '../backend/db/pool.js';
import { createModuleLogger } from '../backend/utils/logger.js';

const logger = createModuleLogger('ViewPsychicState');

// ===========================================================================
// Display Helpers
// ===========================================================================

/**
 * Write a line to stdout.
 * @param {string} [text='']
 */
function out(text = '') {
  process.stdout.write(text + '\n');
}

/**
 * Format a PAD value to fixed 3 decimal places with sign.
 * @param {number} value
 * @returns {string}
 */
function _formatPad(value) {
  const num = parseFloat(value) || 0;
  const sign = num >= 0 ? '+' : '';
  return sign + num.toFixed(3);
}

// ===========================================================================
// Main
// ===========================================================================

async function viewPsychicState(characterFilter) {
  try {
    out('');
    out('=== PSYCHIC RADAR STATE ===');
    out('');

    // -----------------------------------------------------------------------
    // Section 1: Current Moods (from psychic_moods)
    // -----------------------------------------------------------------------

    let moodQuery = `
      SELECT pm.character_id, cp.character_name, cp.category,
             pm.p, pm.a, pm.d, pm.sample_count, pm.updated_at
      FROM psychic_moods pm
      JOIN character_profiles cp ON pm.character_id = cp.character_id`;
    const moodParams = [];

    if (characterFilter) {
      moodQuery += ' WHERE pm.character_id = $1';
      moodParams.push(characterFilter);
    }

    moodQuery += ' ORDER BY cp.character_name';

    const moods = await pool.query(moodQuery, moodParams);

    out('CURRENT MOODS (psychic_moods):');
    out('');

    if (moods.rows.length === 0) {
      out('  No moods recorded yet.');
    } else {
      for (const mood of moods.rows) {
        out('  ' + mood.character_name + ' (' + mood.character_id + ') [' + mood.category + ']');
        out('    P: ' + _formatPad(mood.p) + '  A: ' + _formatPad(mood.a) + '  D: ' + _formatPad(mood.d));
        out('    Samples: ' + mood.sample_count + '  Updated: ' + new Date(mood.updated_at).toISOString());
        out('');
      }
    }

    // -----------------------------------------------------------------------
    // Section 2: Latest Frames (most recent per character)
    // -----------------------------------------------------------------------

    let frameQuery = `
      SELECT DISTINCT ON (pf.character_id)
             pf.frame_id, pf.character_id, cp.character_name,
             pf.emotional_state, pf.trait_influences, pf.metadata,
             pf.timestamp
      FROM psychic_frames pf
      JOIN character_profiles cp ON pf.character_id = cp.character_id`;
    const frameParams = [];

    if (characterFilter) {
      frameQuery += ' WHERE pf.character_id = $1';
      frameParams.push(characterFilter);
    }

    frameQuery += ' ORDER BY pf.character_id, pf.timestamp DESC';

    const frames = await pool.query(frameQuery, frameParams);

    out('LATEST FRAMES (psychic_frames):');
    out('');

    if (frames.rows.length === 0) {
      out('  No frames recorded yet.');
    } else {
      for (const frame of frames.rows) {
        const state = frame.emotional_state || {};
        out('  ' + frame.character_name + ' (' + frame.character_id + ')');
        out('    P: ' + _formatPad(state.p) + '  A: ' + _formatPad(state.a) + '  D: ' + _formatPad(state.d));
        out('    Frame: ' + frame.frame_id + '  At: ' + new Date(frame.timestamp).toISOString());

        if (frame.metadata) {
          const meta = frame.metadata;
          if (meta.engineVersion) {
            out('    Engine: v' + meta.engineVersion + '  Events: ' + (meta.activeEvents || 0));
          }
        }

        out('');
      }
    }

    // -----------------------------------------------------------------------
    // Section 3: Proximity Map
    // -----------------------------------------------------------------------

    if (!characterFilter) {
      const proximity = await pool.query(`
        SELECT ppd.from_character, ppd.to_character,
               ppd.current_distance, ppd.emotional_resonance,
               ppd.baseline_distance, ppd.relationship_type,
               ppd.is_narrative_override,
               cp1.character_name AS name_from,
               cp2.character_name AS name_to
        FROM psychic_proximity_directed ppd
        JOIN character_profiles cp1 ON ppd.from_character = cp1.character_id
        JOIN character_profiles cp2 ON ppd.to_character = cp2.character_id
        ORDER BY ppd.current_distance ASC`);

      out("PROXIMITY MAP (directed, closest first):");
      out("");

      if (proximity.rows.length === 0) {
        out("  No proximity relationships recorded.");
      } else {
        for (const rel of proximity.rows) {
          const dist = parseFloat(rel.current_distance) || 0;
          const base = parseFloat(rel.baseline_distance) || 0;
          const res = parseFloat(rel.emotional_resonance) || 0;
          const label = dist < 0.3 ? "CLOSE" : dist < 0.6 ? "MODERATE" : "DISTANT";
          const override = rel.is_narrative_override ? " [NARRATIVE]" : "";

          out("  " + rel.name_from + " -> " + rel.name_to + override);
          out("    Distance: " + dist.toFixed(3) + " (" + label + ")  Baseline: " + base.toFixed(3) + "  Resonance: " + res.toFixed(3));

          if (rel.relationship_type) {
            out("    Type: " + rel.relationship_type);
          }

          out("");
        }
      }
    } else {
      const proximityFrom = await pool.query(`
        SELECT ppd.to_character, ppd.current_distance,
               ppd.emotional_resonance, ppd.baseline_distance,
               ppd.relationship_type, ppd.is_narrative_override,
               cp.character_name AS name_to
        FROM psychic_proximity_directed ppd
        JOIN character_profiles cp ON ppd.to_character = cp.character_id
        WHERE ppd.from_character = $1
        ORDER BY ppd.current_distance ASC`,
        [characterFilter]);

      const proximityTo = await pool.query(`
        SELECT ppd.from_character, ppd.current_distance,
               ppd.emotional_resonance, ppd.baseline_distance,
               ppd.relationship_type, ppd.is_narrative_override,
               cp.character_name AS name_from
        FROM psychic_proximity_directed ppd
        JOIN character_profiles cp ON ppd.from_character = cp.character_id
        WHERE ppd.to_character = $1
        ORDER BY ppd.current_distance ASC`,
        [characterFilter]);

      out("PROXIMITY FROM " + characterFilter + " (how this character sees others):");
      out("");

      if (proximityFrom.rows.length === 0) {
        out("  No outgoing proximity relationships.");
      } else {
        for (const rel of proximityFrom.rows) {
          const dist = parseFloat(rel.current_distance) || 0;
          const res = parseFloat(rel.emotional_resonance) || 0;
          const label = dist < 0.3 ? "CLOSE" : dist < 0.6 ? "MODERATE" : "DISTANT";
          const override = rel.is_narrative_override ? " [NARRATIVE]" : "";
          out("  -> " + rel.name_to + ": " + dist.toFixed(3) + " (" + label + ")  Resonance: " + res.toFixed(3) + override);
        }
      }
      out("");

      out("PROXIMITY TO " + characterFilter + " (how others see this character):");
      out("");

      if (proximityTo.rows.length === 0) {
        out("  No incoming proximity relationships.");
      } else {
        for (const rel of proximityTo.rows) {
          const dist = parseFloat(rel.current_distance) || 0;
          const res = parseFloat(rel.emotional_resonance) || 0;
          const label = dist < 0.3 ? "CLOSE" : dist < 0.6 ? "MODERATE" : "DISTANT";
          const override = rel.is_narrative_override ? " [NARRATIVE]" : "";
          out("  " + rel.name_from + " ->: " + dist.toFixed(3) + " (" + label + ")  Resonance: " + res.toFixed(3) + override);
        }
      }
      out("");
    }

    // -----------------------------------------------------------------------
    // Section 4: Summary
    // -----------------------------------------------------------------------

    const totalFrames = await pool.query('SELECT COUNT(*) FROM psychic_frames');
    const totalEvents = await pool.query('SELECT COUNT(*) FROM psychic_events');

    out('SUMMARY:');
    out('  Characters with moods: ' + moods.rows.length);
    out('  Total frames: ' + parseInt(totalFrames.rows[0].count, 10));
    out('  Total events: ' + parseInt(totalEvents.rows[0].count, 10));
    out('');

  } catch (error) {
    logger.error('Failed to view psychic state', error);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ===========================================================================
// CLI Argument Parsing
// ===========================================================================

const args = process.argv.slice(2);
let characterFilter = null;

const charFlagIndex = args.indexOf('--character');
if (charFlagIndex !== -1 && args[charFlagIndex + 1]) {
  characterFilter = args[charFlagIndex + 1];

  if (!/^#[0-9A-Fa-f]{6}$/.test(characterFilter)) {
    process.stderr.write('Invalid character ID format: expected #XXXXXX\n');
    process.exit(1);
  }
}

viewPsychicState(characterFilter);
