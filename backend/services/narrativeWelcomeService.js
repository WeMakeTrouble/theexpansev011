/**
 * ============================================================================
 * narrativeWelcomeService.js — First Login Welcome Beat Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Fetches and activates the first-login welcome narrative beat for new
 * users. This is the opening moment of the user's journey into The Expanse
 * — Claude the Tanuki's first words to them.
 *
 * FLOW
 * ----
 *   1. Find the onboarding_welcome narrative arc (read-only)
 *   2. Check if user has already seen it (read-only)
 *   3. Fetch the entry beat from narrative_beats (read-only)
 *   4. Select an LTLM utterance matching the beat's speech act
 *   5. Acquire client, upsert user_arc_state to mark arc as active
 *   6. Return the beat data for socketHandler to deliver
 *
 * CONNECTION POOL DISCIPLINE
 * --------------------------
 * Steps 1-4 are read-only and use pool.query() (no client hold).
 * Step 5 acquires a client only for the upsert write, then releases
 * immediately. This minimises connection hold time and reduces pool
 * pressure under load.
 *
 * CONSUMERS
 * ---------
 *   - socketHandler.js (called during onboarding welcome flow)
 *
 * DEPENDENCIES
 * ------------
 *   Internal: pool.js, logger.js, ltlmUtteranceSelector.js, constants.js,
 *             counters.js
 *   External: None
 *
 * SCHEMA DEPENDENCIES
 * -------------------
 *   narrative_arcs: arc_id, arc_type, created_at
 *   narrative_beats: beat_id, parent_arc_id, is_entry_beat, title,
 *                    content_template(jsonb), target_pad(jsonb), created_at
 *   user_arc_state: user_id, arc_id, character_id, status, current_beat_id,
 *                   updated_at (unique on user_id, arc_id, character_id)
 *
 * MIGRATION FROM v009
 * -------------------
 *   - 2 console.log debug debris removed, replaced with structured logger
 *   - Fixed missing # prefix on speakerCharacterId (was '700002', now uses
 *     CLAUDE_CHARACTER_ID constant '#700002')
 *   - Added try/catch error handling (v009 only had finally)
 *   - correlationId threaded through
 *   - Counters added on every outcome path
 *   - Query timeout protection with labelled errors
 *   - Restructured to minimise DB client hold time
 *   - Full documentation header added
 *
 * EXPORTS
 * -------
 *   named: getFirstLoginWelcomeBeat(userId, characterId, correlationId)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { selectLtlmUtteranceForBeat } from './ltlmUtteranceSelector.js';
import { CLAUDE_CHARACTER_ID } from '../councilTerminal/config/constants.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('NarrativeWelcomeService');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const TIMEOUTS = Object.freeze({
  QUERY_MS: 5000
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Internal Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _poolQueryWithTimeout(sql, params, label) {
  let timer;
  return Promise.race([
    pool.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Query timeout: ${label}`)), TIMEOUTS.QUERY_MS);
    })
  ]);
}

function _clientQueryWithTimeout(client, sql, params, label) {
  let timer;
  return Promise.race([
    client.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Query timeout: ${label}`)), TIMEOUTS.QUERY_MS);
    })
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main Export                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Fetch the first-login welcome beat for a user.
 * Returns null if no welcome arc exists, user already completed it,
 * or no entry beat is found. Safe to call multiple times (idempotent upsert).
 *
 * @param {string} userId - User hex ID
 * @param {string} characterId - Character hex ID receiving the welcome
 * @param {string} correlationId - Correlation ID for tracing
 * @returns {object|null} Welcome beat data or null
 */
export async function getFirstLoginWelcomeBeat(userId, characterId, correlationId) {
  try {
    // 1. Find the onboarding welcome arc (read-only, no client needed)
    const arcRes = await _poolQueryWithTimeout(
      `SELECT arc_id
       FROM narrative_arcs
       WHERE arc_type = 'onboarding_welcome'
       ORDER BY created_at DESC, arc_id ASC
       LIMIT 1`,
      [],
      'fetch_welcome_arc'
    );

    if (arcRes.rows.length === 0) {
      logger.warn('No onboarding_welcome arc found', { correlationId });
      Counters.increment('welcome', 'no_arc_found');
      return null;
    }

    const arcId = arcRes.rows[0].arc_id;

    // 2. Check if user has already seen this arc (read-only)
    const stateRes = await _poolQueryWithTimeout(
      `SELECT status
       FROM user_arc_state
       WHERE user_id = $1
         AND character_id = $2
         AND arc_id = $3`,
      [userId, characterId, arcId],
      'check_arc_state'
    );

    if (stateRes.rows.length > 0 && stateRes.rows[0].status !== 'available') {
      logger.debug('Welcome arc already active or completed', {
        userId,
        arcId,
        status: stateRes.rows[0].status,
        correlationId
      });
      Counters.increment('welcome', 'already_seen');
      return null;
    }

    // 3. Fetch the entry beat (read-only)
    const beatRes = await _poolQueryWithTimeout(
      `SELECT beat_id,
              title,
              content_template,
              target_pad
       FROM narrative_beats
       WHERE parent_arc_id = $1
         AND is_entry_beat = TRUE
       ORDER BY created_at ASC, beat_id ASC
       LIMIT 1`,
      [arcId],
      'fetch_entry_beat'
    );

    if (beatRes.rows.length === 0) {
      logger.warn('No entry beat found for welcome arc', {
        arcId,
        correlationId
      });
      Counters.increment('welcome', 'no_entry_beat');
      return null;
    }

    const beat = beatRes.rows[0];
    const contentTemplate = beat.content_template || {};
    const targetPad = beat.target_pad || { pleasure: 0, arousal: 0, dominance: 0 };

    // 4. Select LTLM utterance for the beat (no DB client needed)
    const ltlmSelection = await selectLtlmUtteranceForBeat({
      // speakerCharacterId: CLAUDE_CHARACTER_ID — onboarding welcome is always delivered by Claude the Tanuki.
      // The characterId parameter is the recipient. Architectural intent, not hardcoding debt.
      speakerCharacterId: CLAUDE_CHARACTER_ID,
      speechActCode: contentTemplate.ltlm_speech_act || null,
      dialogueFunctionCode: contentTemplate.ltlm_dialogue_function || null,
      outcomeIntentCode: contentTemplate.ltlm_outcome_intent || null,
      targetPad
    });

    // 5. Acquire client ONLY for the upsert write
    const client = await pool.connect();
    try {
      await _clientQueryWithTimeout(client,
        `INSERT INTO user_arc_state (
           user_id, arc_id, character_id, status, current_beat_id
         )
         VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (user_id, arc_id, character_id) DO UPDATE
           SET status = 'active',
               current_beat_id = EXCLUDED.current_beat_id,
               updated_at = NOW()`,
        [userId, arcId, characterId, beat.beat_id],
        'upsert_arc_state'
      );
    } finally {
      client.release();
    }

    logger.info('Welcome beat delivered', {
      userId,
      arcId,
      beatId: beat.beat_id,
      hasLtlm: !!ltlmSelection,
      correlationId
    });
    Counters.increment('welcome', 'beat_delivered');

    // 6. Return beat data for socketHandler
    return {
      beatId: beat.beat_id,
      arcId,
      title: beat.title,
      contentTemplate,
      targetPad,
      ltlmUtterance: ltlmSelection
        ? {
            trainingExampleId: ltlmSelection.trainingExampleId,
            text: ltlmSelection.utteranceText,
            pad: ltlmSelection.pad
          }
        : null
    };

  } catch (err) {
    logger.error('Failed to get welcome beat', {
      userId,
      characterId,
      error: err.message,
      correlationId
    });
    Counters.increment('welcome', 'beat_failure');
    throw err;
  }
}
