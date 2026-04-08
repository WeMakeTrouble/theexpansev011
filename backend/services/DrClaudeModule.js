/**
 * ============================================================================
 * DrClaudeModule.js — Psychic Engine Emotional Processor (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Processes user and character messages to track emotional state over time.
 * This is the core of Goal 1: "Claude can feel emotional temperature."
 * Without this module, session.context.userPad is always {p:0, a:0, d:0}
 * and all emotional routing in PhaseEmotional is dead code.
 *
 * PSYCHOLOGICAL MODEL
 * -------------------
 * PAD (Pleasure-Arousal-Dominance) is a validated dimensional model of
 * affect from Mehrabian & Russell (1974). Each dimension ranges [-1, 1]:
 *   P (Pleasure): happy/content (+) vs sad/angry (-)
 *   A (Arousal): excited/alert (+) vs calm/sleepy (-)
 *   D (Dominance): in-control/confident (+) vs helpless/submissive (-)
 *
 * PROCESSING PIPELINE
 * -------------------
 * 1. SENSE   — padEstimator.estimate(text) extracts raw PAD from input
 * 2. GATE    — Skip if coverage=0 (no emotional words) or confidence<0.3
 * 3. DECAY   — Apply time-based decay to current stored PAD (Verduyn et al.)
 * 4. SMOOTH  — EMA blending of detected PAD with decayed current state
 * 5. FILTER  — Skip if delta magnitude below jitter threshold
 * 6. ROUND   — Round to 4 decimal places to prevent float drift
 * 7. STORE   — Atomic DB write: mood upsert + psychic frame + psychic event
 *
 * TEMPORAL DECAY (Verduyn et al. 2015)
 * -------------------------------------
 * Emotions decay toward neutral over time. Different emotions persist
 * at different rates:
 *   - Negative emotions (sadness, anger) persist longer than positive
 *   - High arousal states (fear, excitement) persist longer
 *   - Low dominance states (helplessness) persist longer
 *
 * Half-life is computed per PAD state:
 *   halfLife = BASE * pleasureFactor * arousalFactor * dominanceFactor
 *   decayedValue = rawValue * 0.5^(elapsedSeconds / halfLife)
 *
 * Decay is applied on READ (not on a background timer). This means:
 *   - No cron jobs or background processes needed
 *   - Decay is always fresh when read
 *   - Stored values are post-decay, post-EMA (not raw)
 *
 * EMA SMOOTHING
 * -------------
 * Exponential Moving Average prevents emotional whiplash. Alpha controls
 * how reactive the system is to new input:
 *   newPad = alpha * detected + (1 - alpha) * current
 *
 * Alpha adapts based on sample count (how many messages seen):
 *   < 20 samples: alpha=0.70 (reactive — learning the user)
 *   < 50 samples: alpha=0.50 (moderate — building history)
 *   >= 50 samples: alpha=0.30 (stable — veteran user)
 *
 * SUBJECT SEPARATION
 * ------------------
 * Users and characters are tracked separately:
 *   - Users: user_psychic_moods table (processUserMessage)
 *   - Characters: psychic_moods table (processCharacterMessage)
 * This prevents character emotional state from contaminating user data.
 *
 * CONSUMERS
 * ---------
 * - PhaseEmotional: reads user PAD for emotional routing
 * - PhaseVoice: reads PAD for mood blending in response generation
 * - EarWig: provides PAD via HearingReport (from padEstimator directly)
 * - BrainOrchestrator: calls processUserMessage per turn
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, padEstimator.js, hexIdGenerator.js
 * External: None
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import padEstimator from './padEstimator.js';
import { createModuleLogger } from '../utils/logger.js';
import dossierUpdater from './DossierUpdater.js';
import { CLAUDE_CHARACTER_ID } from '../councilTerminal/config/constants.js';

const logger = createModuleLogger('DrClaudeModule');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */


const CONFIDENCE_GATE = 0.3;
const JITTER_THRESHOLD = 0.01;
const PAD_PRECISION = 4;

const HALF_LIFE_BASE_SECONDS = 300;

const HALF_LIFE_FACTORS = Object.freeze({
  NEGATIVE_PLEASURE_THRESHOLD: -0.2,
  NEGATIVE_PLEASURE_FACTOR: 2.0,
  POSITIVE_PLEASURE_THRESHOLD: 0.3,
  POSITIVE_PLEASURE_FACTOR: 0.8,
  HIGH_AROUSAL_THRESHOLD: 0.5,
  HIGH_AROUSAL_FACTOR: 1.8,
  MODERATE_AROUSAL_THRESHOLD: 0.2,
  MODERATE_AROUSAL_FACTOR: 1.3,
  LOW_DOMINANCE_THRESHOLD: -0.3,
  LOW_DOMINANCE_FACTOR: 1.5,
  HIGH_DOMINANCE_THRESHOLD: 0.3,
  HIGH_DOMINANCE_FACTOR: 0.9
});

const EMA_TIERS = Object.freeze([
  { maxSamples: 20, alpha: 0.70 },
  { maxSamples: 50, alpha: 0.50 },
  { maxSamples: Infinity, alpha: 0.30 }
]);

const SUBJECT_TYPE = Object.freeze({
  USER: 'user',
  CHARACTER: 'character'
});

const EMOTIONAL_CONTEXT_THRESHOLDS = Object.freeze({
  TRAJECTORY: 0.05,
  VOLATILITY_MODERATE: 0.1,
  VOLATILITY_HIGH: 0.3
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _validateNonEmptyString(value, name) {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new Error('DrClaudeModule: ' + name + ' must be a non-empty string, got: ' + typeof value);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Utility: Round PAD to fixed precision                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function _roundPad(pad) {
  return {
    p: Math.round(pad.p * 10000) / 10000,
    a: Math.round(pad.a * 10000) / 10000,
    d: Math.round(pad.d * 10000) / 10000
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  DrClaudeModule Class                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function _poolQueryWithTimeout(sql, params) {
  let timer;
  return Promise.race([
    pool.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Query timeout")), 5000);
    })
  ]);
}

class DrClaudeModule {
  constructor() {
    this._stats = {
      totalMessages: 0,
      skippedLowConfidence: 0,
      skippedNoContent: 0,
      skippedNegligible: 0,
      processed: 0,
      totalCoverage: 0,
      totalKnownWords: 0,
      totalDeltaMagnitude: 0,
      decayEventsTriggered: 0
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Process User Message                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  async processUserMessage(userInput, userId, correlationId) {
    _validateNonEmptyString(userInput, 'userInput');
    _validateNonEmptyString(userId, 'userId');

    const currentPadResult = await this._getCurrentUserPad(userId);
    const emaAlpha = this._getEmaAlpha(currentPadResult.sampleCount);

    const result = await this._processMessage(userInput, currentPadResult, emaAlpha, {
      subjectType: SUBJECT_TYPE.USER,
      subjectId: userId,
      correlationId
    });

    if (result.skipped) return result;

    const frameId = await this._storeUserMood(userId, result.newPad, result.delta, result.padResult, correlationId);

    try {
      await dossierUpdater.processUpdate(userId, frameId, result.newPad, result.delta, correlationId);
    } catch (dossierErr) {
      logger.warn('DossierUpdater failed, non-fatal', {
        userId,
        frameId,
        correlationId,
        error: dossierErr.message
      });
    }
    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Process Character Message                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async processCharacterMessage(input, characterId, sourceCharacterId, correlationId) {
    _validateNonEmptyString(input, 'input');
    _validateNonEmptyString(characterId, 'characterId');

    const currentPad = await this._getCharacterCurrentPad(characterId);
    const emaAlpha = this._getEmaAlpha(currentPad.sampleCount || 0);

    const result = await this._processMessage(input, currentPad, emaAlpha, {
      subjectType: SUBJECT_TYPE.CHARACTER,
      subjectId: characterId,
      correlationId
    });

    if (result.skipped) return result;

    const halfLife = this._calculateHalfLife(result.newPad);

    await this._storeCharacterMoodAtomically(
      characterId,
      sourceCharacterId || (logger.warn("sourceCharacterId not provided, defaulting to Claude", { characterId, correlationId }), CLAUDE_CHARACTER_ID),
      result.newPad,
      result.delta,
      result.padResult,
      halfLife,
      correlationId
    );

    return {
      ...result,
      halfLife
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Emotional Context for EarWig (read-only)                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getEmotionalContext(userId, rawPad) {
    const result = await _poolQueryWithTimeout(
      'SELECT p, a, d, previous_p, previous_a, previous_d, ' +
      'sample_count, ema_alpha, updated_at, consecutive_negative_turns ' +
      'FROM user_psychic_moods WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return {
        currentPad: { p: 0, a: 0, d: 0 },
        trajectory: 'stable',
        sampleCount: 0,
        timeSinceLastUpdate: null,
        baselineDeviation: 0,
        volatility: 'low',
        emaAlpha: EMA_TIERS[0].alpha,
        decayApplied: false,
        consecutiveNegativeTurns: 0
      };
    }

    const row = result.rows[0];
    const storedPad = {
      p: parseFloat(row.p),
      a: parseFloat(row.a),
      d: parseFloat(row.d)
    };

    const halfLife = this._calculateHalfLife(storedPad);
    const decayedPad = this._applyTimeDecay(storedPad, row.updated_at, halfLife);
    const timeSinceLastUpdate = (Date.now() - new Date(row.updated_at).getTime()) / 1000;

    const hasPrevious = row.previous_p !== null &&
      row.previous_a !== null && row.previous_d !== null;

    let trajectory = 'stable';
    let volatility = 'low';

    if (hasPrevious) {
      const previousPad = {
        p: parseFloat(row.previous_p),
        a: parseFloat(row.previous_a),
        d: parseFloat(row.previous_d)
      };

      const pleasureDelta = decayedPad.p - previousPad.p;

      if (pleasureDelta > EMOTIONAL_CONTEXT_THRESHOLDS.TRAJECTORY) {
        trajectory = 'rising';
      } else if (pleasureDelta < -EMOTIONAL_CONTEXT_THRESHOLDS.TRAJECTORY) {
        trajectory = 'falling';
      }

      const changeMagnitude = Math.sqrt(
        Math.pow(decayedPad.p - previousPad.p, 2) +
        Math.pow(decayedPad.a - previousPad.a, 2) +
        Math.pow(decayedPad.d - previousPad.d, 2)
      );

      if (changeMagnitude > EMOTIONAL_CONTEXT_THRESHOLDS.VOLATILITY_HIGH) {
        volatility = 'high';
      } else if (changeMagnitude > EMOTIONAL_CONTEXT_THRESHOLDS.VOLATILITY_MODERATE) {
        volatility = 'moderate';
      }
    }

    let baselineDeviation = 0;
    if (rawPad && typeof rawPad.p === 'number') {
      baselineDeviation = parseFloat(Math.sqrt(
        Math.pow(rawPad.p - decayedPad.p, 2) +
        Math.pow(rawPad.a - decayedPad.a, 2) +
        Math.pow(rawPad.d - decayedPad.d, 2)
      ).toFixed(PAD_PRECISION));
    }

    return {
      currentPad: decayedPad,
      trajectory,
      sampleCount: row.sample_count || 0,
      timeSinceLastUpdate: parseFloat(timeSinceLastUpdate.toFixed(1)),
      baselineDeviation,
      volatility,
      emaAlpha: this._getEmaAlpha(row.sample_count || 0),
      decayApplied: timeSinceLastUpdate > 0,
      consecutiveNegativeTurns: row.consecutive_negative_turns || 0
    };
  }

  /*  Internal: Shared Processing Pipeline                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _processMessage(input, currentPad, emaAlpha, context) {
    this._stats.totalMessages++;

    const padResult = padEstimator.estimate(input);
    this._stats.totalCoverage += padResult.coverage || 0;
    this._stats.totalKnownWords += padResult.knownWords || 0;

    if (padResult.coverage === 0) {
      this._stats.skippedNoContent++;
      return { skipped: true, reason: 'no_emotional_content' };
    }

    if (padResult.confidence < CONFIDENCE_GATE) {
      this._stats.skippedLowConfidence++;
      return {
        skipped: true,
        reason: 'low_confidence',
        confidence: padResult.confidence
      };
    }

    const detectedPad = {
      p: padResult.pad.pleasure,
      a: padResult.pad.arousal,
      d: padResult.pad.dominance
    };

    const newPad = _roundPad({
      p: (emaAlpha * detectedPad.p) + ((1 - emaAlpha) * currentPad.p),
      a: (emaAlpha * detectedPad.a) + ((1 - emaAlpha) * currentPad.a),
      d: (emaAlpha * detectedPad.d) + ((1 - emaAlpha) * currentPad.d)
    });

    const delta = {
      p: newPad.p - currentPad.p,
      a: newPad.a - currentPad.a,
      d: newPad.d - currentPad.d
    };

    const deltaMagnitude = Math.sqrt(
      delta.p * delta.p + delta.a * delta.a + delta.d * delta.d
    );
    this._stats.totalDeltaMagnitude += deltaMagnitude;

    if (Math.abs(delta.p) < JITTER_THRESHOLD &&
        Math.abs(delta.a) < JITTER_THRESHOLD &&
        Math.abs(delta.d) < JITTER_THRESHOLD) {
      this._stats.skippedNegligible++;
      return { skipped: true, reason: 'negligible_change', currentPad };
    }

    this._stats.processed++;

    logger.info('PAD updated', {
      subjectType: context.subjectType,
      subjectId: context.subjectId,
      p: newPad.p,
      a: newPad.a,
      d: newPad.d,
      deltaMagnitude: parseFloat(deltaMagnitude.toFixed(PAD_PRECISION)),
      correlationId: context.correlationId
    });

    return {
      success: true,
      subjectType: context.subjectType,
      subjectId: context.subjectId,
      newPad,
      delta,
      padResult
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Store User Mood (transaction-wrapped)                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _storeUserMood(userId, pad, delta, padResult, correlationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const moodId = await generateHexId('user_mood_id');

      await client.query(
        'INSERT INTO user_psychic_moods (user_mood_id, user_id, p, a, d, sample_count, ' +
        'consecutive_negative_turns, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, 1, CASE WHEN $3::NUMERIC < 0 THEN 1 ELSE 0 END, NOW()) ' +
        'ON CONFLICT (user_id) DO UPDATE SET ' +
        'previous_p = user_psychic_moods.p, ' +
        'previous_a = user_psychic_moods.a, ' +
        'previous_d = user_psychic_moods.d, ' +
        'p = $3, a = $4, d = $5, ' +
        'sample_count = user_psychic_moods.sample_count + 1, ' +
        'consecutive_negative_turns = CASE WHEN $3::NUMERIC < 0 ' +
        'THEN user_psychic_moods.consecutive_negative_turns + 1 ELSE 0 END, ' +
        'updated_at = NOW()',
        [moodId, userId, pad.p, pad.a, pad.d]
      );

      const frameId = await generateHexId('psychic_frame_id');
      const emotionalState = JSON.stringify({
        pad: { p: pad.p, a: pad.a, d: pad.d },
        confidence: padResult.confidence ?? null,
        coverage: padResult.coverage ?? null
      });
      const psychologicalDistance = delta ? JSON.stringify({
        delta_from_previous: delta,
        magnitude: parseFloat(Math.sqrt(
          delta.p * delta.p + delta.a * delta.a + delta.d * delta.d
        ).toFixed(4))
      }) : null;
      const frameMetadata = JSON.stringify({
        source: 'user_message',
        userId: userId
      });

      await client.query(
        'INSERT INTO psychic_frames (frame_id, character_id, dossier_id, timestamp, emotional_state, psychological_distance, metadata) ' +
        'VALUES ($1, NULL, NULL, NOW(), $2, $3, $4)',
        [frameId, emotionalState, psychologicalDistance, frameMetadata]
      );

      await client.query('COMMIT');
      return frameId;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to store user mood', {
        userId,
        correlationId,
        error: err.message
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Store Character Mood Atomically                               */
  /*  (mood upsert + psychic frame + psychic event in one transaction)        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _storeCharacterMoodAtomically(characterId, sourceCharacterId, pad, delta, padResult, halfLife, correlationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const moodId = await generateHexId('psychic_mood_id');
      await client.query(
        'INSERT INTO psychic_moods (mood_id, character_id, p, a, d, sample_count, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, 1, NOW()) ' +
        'ON CONFLICT (character_id) DO UPDATE SET ' +
        'p = $3, a = $4, d = $5, ' +
        'sample_count = psychic_moods.sample_count + 1, ' +
        'updated_at = NOW()',
        [moodId, characterId, pad.p, pad.a, pad.d]
      );

      const frameId = await generateHexId('psychic_frame_id');
      const emotionalState = JSON.stringify({
        pad: { p: pad.p, a: pad.a, d: pad.d },
        confidence: padResult.confidence ?? null,
        coverage: padResult.coverage ?? null
      });
      const psychologicalDistance = delta ? JSON.stringify({
        delta_from_previous: delta,
        magnitude: parseFloat(Math.sqrt(
          delta.p * delta.p + delta.a * delta.a + delta.d * delta.d
        ).toFixed(PAD_PRECISION))
      }) : null;
      const metadata = JSON.stringify({
        source: 'character_action',
        half_life: halfLife
      });

      await client.query(
        'INSERT INTO psychic_frames (frame_id, character_id, timestamp, emotional_state, psychological_distance, metadata) ' +
        'VALUES ($1, $2, NOW(), $3, $4, $5)',
        [frameId, characterId, emotionalState, psychologicalDistance, metadata]
      );

      const eventId = await generateHexId('psychic_event_id');
      const influenceData = JSON.stringify({ delta });
      await client.query(
        'INSERT INTO psychic_events ' +
        '(event_id, event_type, source_character, target_character, delta_p, delta_a, delta_d, half_life_seconds, frame_id, influence_data, created_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())',
        [eventId, 'character_action', sourceCharacterId, characterId,
         delta.p, delta.a, delta.d, halfLife, frameId, influenceData]
      );

      await client.query('COMMIT');

      logger.info('Character mood stored atomically', {
        characterId,
        moodId,
        frameId,
        eventId,
        correlationId
      });

    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to store character mood atomically', {
        characterId,
        correlationId,
        error: err.message
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Half-Life Calculator (Verduyn et al. 2015)                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateHalfLife(pad) {
    let pleasureFactor = 1.0;
    if (pad.p < HALF_LIFE_FACTORS.NEGATIVE_PLEASURE_THRESHOLD) {
      pleasureFactor = HALF_LIFE_FACTORS.NEGATIVE_PLEASURE_FACTOR;
    } else if (pad.p > HALF_LIFE_FACTORS.POSITIVE_PLEASURE_THRESHOLD) {
      pleasureFactor = HALF_LIFE_FACTORS.POSITIVE_PLEASURE_FACTOR;
    }

    let arousalFactor = 1.0;
    if (Math.abs(pad.a) > HALF_LIFE_FACTORS.HIGH_AROUSAL_THRESHOLD) {
      arousalFactor = HALF_LIFE_FACTORS.HIGH_AROUSAL_FACTOR;
    } else if (Math.abs(pad.a) > HALF_LIFE_FACTORS.MODERATE_AROUSAL_THRESHOLD) {
      arousalFactor = HALF_LIFE_FACTORS.MODERATE_AROUSAL_FACTOR;
    }

    let dominanceFactor = 1.0;
    if (pad.d < HALF_LIFE_FACTORS.LOW_DOMINANCE_THRESHOLD) {
      dominanceFactor = HALF_LIFE_FACTORS.LOW_DOMINANCE_FACTOR;
    } else if (pad.d > HALF_LIFE_FACTORS.HIGH_DOMINANCE_THRESHOLD) {
      dominanceFactor = HALF_LIFE_FACTORS.HIGH_DOMINANCE_FACTOR;
    }

    return Math.round(HALF_LIFE_BASE_SECONDS * pleasureFactor * arousalFactor * dominanceFactor);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Decay-on-Read (Verduyn et al. 2015)                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  _applyTimeDecay(pad, updatedAt, halfLife) {
    const elapsedSeconds = (Date.now() - new Date(updatedAt).getTime()) / 1000;
    if (elapsedSeconds <= 0) return pad;

    const decayFactor = Math.pow(0.5, elapsedSeconds / halfLife);
    this._stats.decayEventsTriggered++;

    return _roundPad({
      p: pad.p * decayFactor,
      a: pad.a * decayFactor,
      d: pad.d * decayFactor
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: EMA Alpha Selection                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  _getEmaAlpha(sampleCount) {
    for (const tier of EMA_TIERS) {
      if (sampleCount < tier.maxSamples) {
        return tier.alpha;
      }
    }
    return EMA_TIERS[EMA_TIERS.length - 1].alpha;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Get Current PAD (with decay applied)                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _getCharacterCurrentPad(characterId) {
    const result = await _poolQueryWithTimeout(
      'SELECT p, a, d, sample_count, updated_at FROM psychic_moods WHERE character_id = $1',
      [characterId]
    );

    if (result.rows.length === 0) return { p: 0, a: 0, d: 0, sampleCount: 0 };

    const row = result.rows[0];
    const rawPad = {
      p: parseFloat(row.p),
      a: parseFloat(row.a),
      d: parseFloat(row.d)
    };
    const halfLife = this._calculateHalfLife(rawPad);
    const decayed = this._applyTimeDecay(rawPad, row.updated_at, halfLife);
    return { ...decayed, sampleCount: row.sample_count || 0 };
  }

  async _getCurrentUserPad(userId) {
    const result = await _poolQueryWithTimeout(
      'SELECT p, a, d, updated_at, sample_count FROM user_psychic_moods WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) return { p: 0, a: 0, d: 0, sampleCount: 0 };

    const row = result.rows[0];
    const rawPad = {
      p: parseFloat(row.p),
      a: parseFloat(row.a),
      d: parseFloat(row.d)
    };
    const halfLife = this._calculateHalfLife(rawPad);
    const decayed = this._applyTimeDecay(rawPad, row.updated_at, halfLife);
    return { ...decayed, sampleCount: row.sample_count || 0 };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Observability                                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  getStats() {
    const s = this._stats;
    const total = s.totalMessages || 1;
    const processed = s.processed || 1;
    const totalSkipped = s.skippedNoContent + s.skippedLowConfidence + s.skippedNegligible;

    return {
      totalMessages: s.totalMessages,
      processed: s.processed,
      skipped: {
        noContent: s.skippedNoContent,
        lowConfidence: s.skippedLowConfidence,
        negligible: s.skippedNegligible,
        total: totalSkipped,
        pct: parseFloat((totalSkipped / total * 100).toFixed(1))
      },
      averages: {
        coverage: parseFloat((s.totalCoverage / total).toFixed(3)),
        knownWords: parseFloat((s.totalKnownWords / total).toFixed(1)),
        deltaMagnitude: parseFloat((s.totalDeltaMagnitude / processed).toFixed(PAD_PRECISION))
      },
      decayEventsTriggered: s.decayEventsTriggered
    };
  }

  logStats(correlationId) {
    const stats = this.getStats();
    logger.info('Stats summary', {
      total: stats.totalMessages,
      processed: stats.processed,
      skippedPct: stats.skipped.pct,
      avgCoverage: stats.averages.coverage,
      avgDelta: stats.averages.deltaMagnitude,
      decayEvents: stats.decayEventsTriggered,
      correlationId
    });
  }

  resetStats() {
    this._stats = {
      totalMessages: 0,
      skippedLowConfidence: 0,
      skippedNoContent: 0,
      skippedNegligible: 0,
      processed: 0,
      totalCoverage: 0,
      totalKnownWords: 0,
      totalDeltaMagnitude: 0,
      decayEventsTriggered: 0
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new DrClaudeModule();
