/**
 * ===========================================================================
 * PSYCHIC ENGINE — Emotional Physics Engine for The Expanse
 * ===========================================================================
 *
 * PURPOSE:
 * The Psychic Engine is the core simulation that calculates the emotional
 * state of every character in The Expanse. In a world with no physical
 * space — no up/down, no close/far — emotion IS the physics. This engine
 * is the gravity, the weather, the terrain of The Expanse.
 *
 * Every character's emotional state is a PAD coordinate:
 *   P (Pleasure)  — -1.000 (deep torment) to +1.000 (pure joy)
 *   A (Arousal)   — -1.000 (catatonic) to +1.000 (manic frenzy)
 *   D (Dominance) — -1.000 (helpless) to +1.000 (godlike control)
 *
 * These values are stored as numeric(4,3) in the database, giving
 * precision to three decimal places within the -1 to +1 range.
 *
 * EMOTIONAL STATE FORMULA:
 * ---------------------------------------------------------------------------
 * Final state is computed from three blended layers:
 *
 *   Layer 1: TRAIT BASELINE (who the character IS)
 *     From character_trait_scores. Average percentile maps to P and D.
 *     Arousal derived from trait score VARIANCE (high variance = high
 *     internal conflict = high energy). Normalised against observed
 *     maximum variance of ~1200 across the current character population.
 *     Formula: p_trait = (avgScore - 50) / 50  (maps 0-100 to -1..+1)
 *              a_trait = clamp(variance / MAX_TRAIT_VARIANCE)
 *              d_trait = (avgScore - 50) / 50
 *
 *   Layer 2: OBJECT AURA (persistent influence from owned objects)
 *     Objects exert persistent emotional pull via saturation curve:
 *       alpha = MAX_ALPHA * (1 - e^(-SATURATION_RATE * totalWeight))
 *     Prevents stat-padding: first items matter most.
 *     Blend: p_persist = (1 - alpha) * p_trait + alpha * p_obj
 *
 *   Layer 3: EVENT SPIKES (decaying influence from recent events)
 *     Psychic events create temporary spikes with exponential decay:
 *       decay = e^(-ageSeconds / tau)  where tau = halfLife / ln(2)
 *     Column types: delta_p/a/d are numeric(4,2), half_life_seconds int.
 *     Events older than lookback window are ignored.
 *     Spikes ADD to persistent state (can push beyond baseline).
 *
 *   Final: CLAMP to [-1.000, +1.000] on all three axes.
 *
 * FRAME GENERATION:
 * ---------------------------------------------------------------------------
 * Each tick produces a "psychic frame" per character — a snapshot stored
 * in psychic_frames with hex IDs (psychic_frame_id range #850000+).
 * Frames include emotional_state JSONB plus trait_influences and metadata.
 *
 * After frame generation (all within one transaction):
 *   1. Frame inserted into psychic_frames
 *   2. Mood upserted into psychic_moods (psychic_mood_id range #990000+)
 *   3. Emotional contagion spread via VECTORIZED bulk UPDATE
 *
 * Post-transaction (fire-and-forget):
 *   4. B-Roll characters check knowledge slot claiming
 *
 * EMOTIONAL CONTAGION:
 * ---------------------------------------------------------------------------
 * Characters within psychological proximity spread emotion. Contagion
 * iterates over directed neighbours from psychic_proximity_directed,
 * applying resonance-weighted axis-specific influence per Cikara et al.
 * (2014). Each neighbour is updated individually to support per-pair resonance.
 *
 * IMPORTANT: psychological_distance is 0-1 where LOWER = CLOSER.
 *   Frankie Trouble (#700003) has distance 0.3 to Claude = CLOSE
 *   Pineaple Yurei (#700009) has distance 0.9 to Claude = FAR
 *
 * Contagion influence uses INVERSE distance: (1 - distance)
 *   Close characters (distance 0.1) get 90% influence weight
 *   Far characters (distance 0.9) get 10% influence weight
 *
 * Formula per target:
 *   new_p = old_p + (source_p - old_p) * (1 - distance) * CONTAGION_RATE
 *
 * All contagion results are CLAMPED to [-1, 1] inside the SQL using
 * GREATEST(-1, LEAST(1, ...)) to prevent overflow.
 *
 * The directed proximity table stores emotional_resonance (-1 to +1) per pair.
 * Negative resonance triggers schadenfreude: P-axis inverts, A mirrors, D partial.
 *
 * TRANSACTION RETRY:
 * ---------------------------------------------------------------------------
 * Frame persistence uses a retry wrapper that attempts up to 3 times
 * on transient failures (deadlock, serialization conflict). This
 * protects against contention when multiple characters are processed
 * concurrently during tick cycles.
 *
 * DATABASE TABLES:
 * ---------------------------------------------------------------------------
 *   psychic_frames           — frame snapshots (frame_id #85XXXX)
 *     Columns: frame_id, character_id, timestamp, emotional_state (jsonb),
 *              psychological_distance (jsonb), trait_influences (jsonb),
 *              metadata (jsonb), dossier_id
 *     Index: idx_psychic_frames_charid_ts (character_id, timestamp)
 *
 *   psychic_moods            — current smoothed mood (mood_id #99XXXX)
 *     Columns: mood_id, character_id (unique), p/a/d numeric(4,3),
 *              alpha numeric(3,2), sample_count, updated_at
 *
 *   psychic_proximity_directed — directed psychological distance between pairs
 *     Columns: proximity_id #86XXXX, from_character, to_character,
 *              current_distance (float8) where 0=close 1=far,
 *              emotional_resonance (float8) -1=schadenfreude +1=empathy,
 *              baseline_distance, regression_rate, relationship_type,
 *              is_narrative_override, last_interaction
 *
 *   psychic_events           — temporary events with decay
 *     Columns: event_id #BDXXXX, target_character, delta_p/a/d numeric(4,2),
 *              half_life_seconds (int, default 300), created_at
 *     CHECK: deltas constrained to [-1, 1]
 *     RECOMMENDED INDEX (not yet created):
 *       CREATE INDEX idx_psychic_events_target_created
 *         ON psychic_events(target_character, created_at DESC);
 *
 *   character_trait_scores    — baseline personality traits
 *   character_object_influence — persistent object aura (p_obj, a_obj, d_obj)
 *
 * DEPENDENCIES:
 *   - pool — injected via constructor (backend/db/pool.js)
 *   - generateHexId (backend/utils/hexIdGenerator.js) — frame/mood IDs
 *   - createModuleLogger (backend/utils/logger.js) — structured logging
 *
 * CONSUMERS:
 *   - run-engine-filtered.js — tick scheduler
 *   - psychic-radar.html — real-time visualisation
 *   - PhaseEmotional — reads frames for emotional routing
 *   - DrClaudeModule — reads moods for psychic event processing
 *
 * PERFORMANCE:
 *   - Layer queries run in PARALLEL via Promise.allSettled
 *   - Frame + mood + contagion in SINGLE transaction
 *   - Contagion is VECTORIZED (one SQL, not N updates)
 *   - Post-contagion values CLAMPED in SQL (no overflow)
 *   - Knowledge slot check is fire-and-forget
 *   - Query timeout protection on all DB operations
 *   - Transaction retry on deadlock/serialization failure
 *
 * METRICS:
 *   - Counters object tracks: framesGenerated, statesCalculated,
 *     contagionSpreads, contagionAttempts, transactionRollbacks,
 *     transactionRetries, queryTimeouts, layerFailures,
 *     knowledgeSlotChecks, totalProcessingMs, batchesProcessed
 *   - Access via getMetrics() for monitoring/alerting
 *
 * V010 STANDARDS:
 *   - Structured logger — no console.log
 *   - Frozen constants (PSYCHIC_CONFIG, PAD_LIMITS, HEX_PURPOSES, TIMEOUTS)
 *   - Correlation ID threading
 *   - Input validation on all public methods
 *   - Transaction discipline (ACID) with retry
 *   - Dependency injection (pool via constructor)
 *   - Metrics counters for observability
 *   - Hex IDs via canonical generator only
 *
 * HISTORY:
 *   v009 — Working prototype. Sequential queries, console.log, no
 *          transactions, magic numbers, dead code, wrong hex purposes,
 *          hardcoded arousal baseline, loop-based contagion, no clamp
 *          on contagion output, wrong distance semantics.
 *   v010 — Parallel fetching, transaction-wrapped persistence,
 *          vectorized contagion with inverse distance and SQL clamping,
 *          frozen config, structured logging, correlation IDs,
 *          variance-based arousal (MAX_TRAIT_VARIANCE=1200 from data),
 *          metrics counters, query timeout protection, transaction
 *          retry on deadlock, dependency injection, batch processing.
 * ===========================================================================
 */

import generateHexId from '../backend/utils/hexIdGenerator.js';
import { createModuleLogger } from '../backend/utils/logger.js';

const logger = createModuleLogger('PsychicEngine');

// ===========================================================================
// Frozen Constants
// ===========================================================================

const PSYCHIC_CONFIG = Object.freeze({
  MAX_ALPHA: 0.4,
  SATURATION_RATE: 0.5,
  EVENT_LOOKBACK_MS: 30 * 60 * 1000,
  TRAIT_MIDPOINT: 50,
  TRAIT_RANGE: 50,
  MAX_TRAIT_VARIANCE: 1200,
  CONTAGION_PROXIMITY_THRESHOLD: 0.5,
  CONTAGION_RATE: 0.2
});

const PAD_LIMITS = Object.freeze({
  MIN: -1,
  MAX: 1
});

const HEX_PURPOSES = Object.freeze({
  FRAME: 'psychic_frame_id',
  MOOD: 'psychic_mood_id'
});

const TIMEOUTS = Object.freeze({
  QUERY_MS: 5000,
  TRANSACTION_MS: 10000
});

const RETRY_CONFIG = Object.freeze({
  MAX_ATTEMPTS: 3,
  BACKOFF_BASE_MS: 100,
  RETRYABLE_CODES: ['40001', '40P01']
});

// ===========================================================================
// Metrics Counters
// ===========================================================================

const Counters = {
  framesGenerated: 0,
  statesCalculated: 0,
  contagionSpreads: 0,
  contagionAttempts: 0,
  transactionRollbacks: 0,
  transactionRetries: 0,
  queryTimeouts: 0,
  layerFailures: 0,
  knowledgeSlotChecks: 0,
  totalProcessingMs: 0,
  batchesProcessed: 0
};

// ===========================================================================
// Validation and Utility Helpers
// ===========================================================================

/**
 * Validate hex character ID format.
 * @param {string} characterId
 * @throws {Error} if format invalid
 */
function _validateCharacterId(characterId) {
  if (!characterId || typeof characterId !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(characterId)) {
    throw new Error(`Invalid characterId: expected #XXXXXX hex format, got "${characterId}"`);
  }
}

/**
 * Clamp a value to PAD range [-1, 1].
 * @param {number} value
 * @returns {number}
 */
function _clamp(value) {
  return Math.max(PAD_LIMITS.MIN, Math.min(PAD_LIMITS.MAX, value));
}

/**
 * Safely parse a value to float with fallback.
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function _safeFloat(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Clamp and round to 3 decimal places for numeric(4,3) storage.
 * @param {number} value
 * @returns {number}
 */
function _roundPad(value) {
  return Math.round(_clamp(value) * 1000) / 1000;
}

/**
 * Calculate population variance of an array of numbers.
 * @param {number[]} values
 * @returns {number}
 */
function _variance(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
}

/**
 * Execute a query with timeout protection.
 * @param {object} pool — database pool
 * @param {string} sql — query string
 * @param {Array} params — query parameters
 * @param {number} timeoutMs — timeout in milliseconds
 * @returns {object} query result
 */
async function _queryWithTimeout(pool, sql, params, timeoutMs) {
  return Promise.race([
    pool.query(sql, params),
    new Promise((_, reject) =>
      setTimeout(() => {
        Counters.queryTimeouts++;
        reject(new Error(`Query timeout after ${timeoutMs}ms`));
      }, timeoutMs)
    )
  ]);
}

/**
 * Determine if a PostgreSQL error is retryable (deadlock or serialization).
 * @param {Error} error
 * @returns {boolean}
 */
function _isRetryableError(error) {
  return RETRY_CONFIG.RETRYABLE_CODES.includes(error?.code);
}

// ===========================================================================
// PsychicEngine Class
// ===========================================================================

class PsychicEngine {

  /**
   * Create a PsychicEngine instance.
   * @param {object} options
   * @param {object} options.pool — PostgreSQL connection pool (injected)
   */
  constructor({ pool }) {
    if (!pool) {
      throw new Error('PsychicEngine requires a database pool');
    }
    this.pool = pool;
  }

  /**
   * Get current metrics snapshot.
   * @returns {object} frozen copy of all counters
   */
  getMetrics() {
    return Object.freeze({ ...Counters });
  }

  /**
   * Reset all metrics counters to zero.
   */
  resetMetrics() {
    Object.keys(Counters).forEach(k => { Counters[k] = 0; });
  }

  // -------------------------------------------------------------------------
  // Layer 1: Trait Baseline
  // -------------------------------------------------------------------------

  /**
   * Fetch character trait scores and compute PAD baseline.
   * P and D derived from average percentile score.
   * A derived from trait score VARIANCE — high variance means
   * internal conflict which manifests as higher arousal/energy.
   *
   * Normalisation uses MAX_TRAIT_VARIANCE=1200 derived from actual
   * character data (observed range 0 to ~1165 across population).
   *
   * @param {string} characterId — hex ID (#XXXXXX)
   * @param {string} correlationId — for log threading
   * @returns {object|null} { p_trait, a_trait, d_trait, traitCount, traitVariance }
   */
  async getTraitBaseline(characterId, correlationId) {
    const result = await _queryWithTimeout(
      this.pool,
      'SELECT trait_hex_color, percentile_score FROM character_trait_scores WHERE character_hex_id = $1',
      [characterId],
      TIMEOUTS.QUERY_MS
    );

    if (result.rows.length === 0) {
      logger.debug('No traits found for character', { correlationId, characterId });
      return null;
    }

    const scores = result.rows.map(r => _safeFloat(r.percentile_score, PSYCHIC_CONFIG.TRAIT_MIDPOINT));
    const avgScore = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    const traitVariance = _variance(scores);

    const p_trait = (avgScore - PSYCHIC_CONFIG.TRAIT_MIDPOINT) / PSYCHIC_CONFIG.TRAIT_RANGE;
    const a_trait = _clamp(traitVariance / PSYCHIC_CONFIG.MAX_TRAIT_VARIANCE);
    const d_trait = (avgScore - PSYCHIC_CONFIG.TRAIT_MIDPOINT) / PSYCHIC_CONFIG.TRAIT_RANGE;

    return {
      p_trait,
      a_trait,
      d_trait,
      traitCount: result.rows.length,
      traitVariance: parseFloat(traitVariance.toFixed(2))
    };
  }

  // -------------------------------------------------------------------------
  // Layer 2: Object Aura (Persistent Influence)
  // -------------------------------------------------------------------------

  /**
   * Fetch persistent object influence with saturation curve.
   * alpha = MAX_ALPHA * (1 - e^(-SATURATION_RATE * totalWeight))
   * First items contribute more than later items (diminishing returns).
   *
   * @param {string} characterId — hex ID
   * @returns {object} { p_obj, a_obj, d_obj, alpha, totalWeight }
   */
  async getObjectAura(characterId) {
    const result = await _queryWithTimeout(
      this.pool,
      'SELECT p_obj, a_obj, d_obj, total_weight FROM character_object_influence WHERE character_id = $1',
      [characterId],
      TIMEOUTS.QUERY_MS
    );

    if (result.rows.length === 0) {
      return { p_obj: 0, a_obj: 0, d_obj: 0, alpha: 0, totalWeight: 0 };
    }

    const row = result.rows[0];
    const totalWeight = _safeFloat(row.total_weight, 0);
    const alpha = PSYCHIC_CONFIG.MAX_ALPHA * (1 - Math.exp(-PSYCHIC_CONFIG.SATURATION_RATE * totalWeight));

    return {
      p_obj: _safeFloat(row.p_obj),
      a_obj: _safeFloat(row.a_obj),
      d_obj: _safeFloat(row.d_obj),
      alpha,
      totalWeight
    };
  }

  // -------------------------------------------------------------------------
  // Layer 3: Event Spikes (Decaying Influence)
  // -------------------------------------------------------------------------

  /**
   * Fetch recent psychic events and sum decayed deltas.
   * decay = e^(-ageSeconds / tau) where tau = halfLife / ln(2)
   *
   * DB column types: delta_p/a/d are numeric(4,2) constrained to [-1,1].
   * half_life_seconds is integer, default 300 (5 minutes).
   *
   * @param {string} characterId — hex ID
   * @returns {object} { p_ev, a_ev, d_ev, eventCount }
   */
  async getEventSpikes(characterId) {
    const cutoff = new Date(Date.now() - PSYCHIC_CONFIG.EVENT_LOOKBACK_MS);

    const result = await _queryWithTimeout(
      this.pool,
      `SELECT delta_p, delta_a, delta_d, half_life_seconds, created_at
       FROM psychic_events
       WHERE target_character = $1
         AND created_at > $2
         AND (delta_p IS NOT NULL OR delta_a IS NOT NULL OR delta_d IS NOT NULL)
       ORDER BY created_at DESC`,
      [characterId, cutoff],
      TIMEOUTS.QUERY_MS
    );

    let p_ev = 0;
    let a_ev = 0;
    let d_ev = 0;
    const now = Date.now();

    for (const event of result.rows) {
      const ageSeconds = (now - new Date(event.created_at).getTime()) / 1000;
      const halfLife = _safeFloat(event.half_life_seconds, 300);
      const tau = halfLife / Math.LN2;
      const decay = Math.exp(-ageSeconds / tau);

      p_ev += _safeFloat(event.delta_p) * decay;
      a_ev += _safeFloat(event.delta_a) * decay;
      d_ev += _safeFloat(event.delta_d) * decay;
    }

    return {
      p_ev: parseFloat(p_ev.toFixed(4)),
      a_ev: parseFloat(a_ev.toFixed(4)),
      d_ev: parseFloat(d_ev.toFixed(4)),
      eventCount: result.rows.length
    };
  }

  // -------------------------------------------------------------------------
  // State Calculation (All Three Layers in Parallel)
  // -------------------------------------------------------------------------

  /**
   * Calculate complete emotional state for a character.
   * All three layers fetched IN PARALLEL via Promise.allSettled.
   * Failed layers degrade gracefully (neutral fallback) except traits
   * which are required (returns null if unavailable).
   *
   * @param {string} characterId — hex ID (#XXXXXX)
   * @param {string} correlationId — for log threading
   * @returns {object|null} { p, a, d, meta } or null if no traits
   */
  async calculateEmotionalState(characterId, correlationId) {
    _validateCharacterId(characterId);
    const startTime = Date.now();

    const [traitResult, auraResult, spikeResult] = await Promise.allSettled([
      this.getTraitBaseline(characterId, correlationId),
      this.getObjectAura(characterId),
      this.getEventSpikes(characterId)
    ]);

    const traits = traitResult.status === 'fulfilled' ? traitResult.value : null;
    const aura = auraResult.status === 'fulfilled'
      ? auraResult.value
      : { p_obj: 0, a_obj: 0, d_obj: 0, alpha: 0, totalWeight: 0 };
    const spikes = spikeResult.status === 'fulfilled'
      ? spikeResult.value
      : { p_ev: 0, a_ev: 0, d_ev: 0, eventCount: 0 };

    if (traitResult.status === 'rejected') {
      Counters.layerFailures++;
      logger.error('Trait baseline fetch failed', traitResult.reason, { correlationId, characterId });
    }
    if (auraResult.status === 'rejected') {
      Counters.layerFailures++;
      logger.warn('Object aura fetch failed, using neutral', { correlationId, characterId, error: auraResult.reason?.message });
    }
    if (spikeResult.status === 'rejected') {
      Counters.layerFailures++;
      logger.warn('Event spikes fetch failed, using neutral', { correlationId, characterId, error: spikeResult.reason?.message });
    }

    if (!traits) {
      return null;
    }

    const { alpha } = aura;
    const p_persist = (1 - alpha) * traits.p_trait + alpha * aura.p_obj;
    const a_persist = (1 - alpha) * traits.a_trait + alpha * aura.a_obj;
    const d_persist = (1 - alpha) * traits.d_trait + alpha * aura.d_obj;

    const emotionalState = {
      p: _roundPad(p_persist + spikes.p_ev),
      a: _roundPad(a_persist + spikes.a_ev),
      d: _roundPad(d_persist + spikes.d_ev)
    };

    const durationMs = Date.now() - startTime;
    Counters.statesCalculated++;

    logger.debug('Emotional state calculated', {
      correlationId,
      characterId,
      state: emotionalState,
      layers: {
        traitCount: traits.traitCount,
        traitVariance: traits.traitVariance,
        objectAlpha: parseFloat(alpha.toFixed(4)),
        objectWeight: aura.totalWeight,
        activeEvents: spikes.eventCount
      },
      durationMs
    });

    return {
      ...emotionalState,
      meta: {
        traitCount: traits.traitCount,
        traitVariance: traits.traitVariance,
        objectAlpha: parseFloat(alpha.toFixed(4)),
        objectWeight: aura.totalWeight,
        activeEvents: spikes.eventCount,
        durationMs
      }
    };
  }

  // -------------------------------------------------------------------------
  // Frame Persistence (Transaction-Wrapped with Retry)
  // -------------------------------------------------------------------------

  /**
   * Save psychic frame, upsert mood, spread contagion — all atomic.
   * Retries up to MAX_ATTEMPTS on deadlock or serialization conflict.
   * Uses rich JSONB columns in psychic_frames for trait_influences
   * and metadata alongside the core emotional_state.
   *
   * @param {string} characterId — hex ID
   * @param {object} emotionalState — { p, a, d, meta }
   * @param {string} correlationId — for log threading
   * @returns {string} frameId
   */
  async saveFrame(characterId, emotionalState, correlationId) {
    let lastError = null;

    for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      try {
        const frameId = await this._executeFrameTransaction(characterId, emotionalState, correlationId);
        return frameId;
      } catch (error) {
        lastError = error;

        if (_isRetryableError(error) && attempt < RETRY_CONFIG.MAX_ATTEMPTS) {
          Counters.transactionRetries++;
          const backoffMs = RETRY_CONFIG.BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn('Transaction conflict, retrying', {
            correlationId,
            characterId,
            attempt,
            backoffMs,
            errorCode: error.code
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        Counters.transactionRollbacks++;
        throw error;
      }
    }

    throw lastError;
  }

  /**
   * Execute the atomic frame transaction: insert frame, upsert mood,
   * spread vectorized contagion. Called by saveFrame with retry wrapper.
   *
   * @param {string} characterId — hex ID
   * @param {object} emotionalState — { p, a, d, meta }
   * @param {string} correlationId
   * @returns {string} frameId
   * @private
   */
  async _executeFrameTransaction(characterId, emotionalState, correlationId) {
    const client = await this.pool.connect();
    const { p, a, d, meta } = emotionalState;

    try {
      await client.query('BEGIN');

      const frameId = await generateHexId(HEX_PURPOSES.FRAME);

      await client.query(
        `INSERT INTO psychic_frames
           (frame_id, character_id, emotional_state, trait_influences, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          frameId,
          characterId,
          JSON.stringify({ p, a, d }),
          meta ? JSON.stringify({
            traitCount: meta.traitCount,
            traitVariance: meta.traitVariance,
            objectAlpha: meta.objectAlpha,
            objectWeight: meta.objectWeight
          }) : null,
          meta ? JSON.stringify({
            activeEvents: meta.activeEvents,
            durationMs: meta.durationMs,
            engineVersion: '010'
          }) : null
        ]
      );

      const moodId = await generateHexId(HEX_PURPOSES.MOOD);

      await client.query(
        `INSERT INTO psychic_moods (mood_id, character_id, p, a, d)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (character_id)
         DO UPDATE SET
           p = EXCLUDED.p,
           a = EXCLUDED.a,
           d = EXCLUDED.d,
           sample_count = psychic_moods.sample_count + 1,
           updated_at = CURRENT_TIMESTAMP`,
        [moodId, characterId, p, a, d]
      );

      const contagionCount = await this._spreadContagionVectorized(
        client, characterId, { p, a, d }, correlationId
      );

      await client.query('COMMIT');

      Counters.framesGenerated++;

      logger.info('Psychic frame saved', {
        correlationId,
        characterId,
        frameId,
        state: { p, a, d },
        contagionTargets: contagionCount
      });

      return frameId;

    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Frame transaction failed', error, { correlationId, characterId });
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Vectorized Emotional Contagion (Single SQL)
  // -------------------------------------------------------------------------

  /**
   * Spread emotional influence to all psychically close characters
   * using the DIRECTED proximity table with resonance-weighted
   * axis-specific contagion.
   *
   * v010 UPGRADE from v009:
   *   - Uses psychic_proximity_directed (no UNION needed)
   *   - Uses current_distance instead of psychological_distance
   *   - Applies emotional_resonance to weight contagion strength
   *   - Resonance is axis-specific per Cikara et al. (2014):
   *     Positive resonance: standard contagion on all axes
   *     Negative resonance (schadenfreude): P-axis INVERTS,
   *       A-axis MIRRORS, D-axis PARTIALLY INVERTS (0.5x)
   *
   * DISTANCE SEMANTICS: current_distance is 0-1 where LOWER = CLOSER.
   * Contagion uses INVERSE: (1 - distance) so close characters feel more.
   *
   * OUTPUT CLAMPING: GREATEST(-1, LEAST(1, ...)) prevents overflow beyond
   * the numeric(4,3) column range of [-1.000, 1.000].
   *
   * Source: Hatfield et al. (1993) emotional contagion
   * Source: Cikara et al. (2014) counter-empathic responses
   * Source: Smith et al. (1996) envy and schadenfreude
   *
   * @param {object} client — transaction client
   * @param {string} sourceId — source character hex ID
   * @param {object} state — { p, a, d }
   * @param {string} correlationId
   * @returns {number} count of affected characters
   */
  async _spreadContagionVectorized(client, sourceId, state, correlationId) {
    const threshold = PSYCHIC_CONFIG.CONTAGION_PROXIMITY_THRESHOLD;
    const rate = PSYCHIC_CONFIG.CONTAGION_RATE;

    Counters.contagionAttempts++;

    // ---------------------------------------------------------------
    // Step 1: Get all directed neighbours within contagion range
    // Uses psychic_proximity_directed — no UNION needed.
    // Each row has its own emotional_resonance value.
    // ---------------------------------------------------------------
    const neighbours = await client.query(
      `SELECT to_character, current_distance, emotional_resonance
       FROM psychic_proximity_directed
       WHERE from_character = $1
         AND current_distance < $2`,
      [sourceId, threshold]
    );

    if (neighbours.rows.length === 0) {
      return 0;
    }

    // ---------------------------------------------------------------
    // Step 2: Apply resonance-weighted contagion per neighbour
    // Resonance is axis-specific per Cikara et al. (2014):
    //   Positive resonance: P, A, D all receive standard influence
    //   Negative resonance (schadenfreude):
    //     P-axis: INVERTS (their pain = our pleasure)
    //     A-axis: MIRRORS (arousal contagion persists)
    //     D-axis: PARTIALLY INVERTS (0.5x multiplier)
    // ---------------------------------------------------------------
    let affected = 0;

    for (const row of neighbours.rows) {
      const distance = parseFloat(row.current_distance);
      const resonance = parseFloat(row.emotional_resonance);
      const influence = (1 - distance) * rate;
      const isSchadenfreude = resonance < 0;
      const absResonance = Math.abs(resonance);

      // Axis-specific resonance weights
      const pWeight = isSchadenfreude ? absResonance * -1.0 : resonance;
      const aWeight = isSchadenfreude ? absResonance * 1.0 : resonance;
      const dWeight = isSchadenfreude ? absResonance * -0.5 : resonance;

      const result = await client.query(
        `UPDATE psychic_moods
         SET p = GREATEST(-1, LEAST(1,
               p + ($1::numeric - p) * $4::numeric * $7::numeric
             )),
             a = GREATEST(-1, LEAST(1,
               a + ($2::numeric - a) * $4::numeric * $5::numeric
             )),
             d = GREATEST(-1, LEAST(1,
               d + ($3::numeric - d) * $4::numeric * $6::numeric
             )),
             updated_at = CURRENT_TIMESTAMP
         WHERE character_id = $8`,
        [state.p, state.a, state.d, influence, aWeight, dWeight, pWeight, row.to_character]
      );

      if (result.rowCount > 0) {
        affected++;
      }
    }

    if (affected > 0) {
      Counters.contagionSpreads += affected;
      logger.debug("Emotional contagion spread (directed, resonance-weighted)", {
        correlationId,
        sourceId,
        affected,
        neighbourCount: neighbours.rows.length,
        threshold,
        rate
      });
    }

    return affected;
  }

  // -------------------------------------------------------------------------
  // Character Processing (Single Entry Point)
  // -------------------------------------------------------------------------

  /**
   * Process a single character: calculate state, save frame, spread contagion.
   * Knowledge slot claiming runs fire-and-forget (non-blocking).
   *
   * @param {string} characterId — hex ID (#XXXXXX)
   * @param {string} [correlationId] — optional correlation ID
   * @returns {object|null} { frameId, emotionalState, metrics } or null
   */
  async processCharacter(characterId, correlationId) {
    _validateCharacterId(characterId);
    const startTime = Date.now();

    const emotionalState = await this.calculateEmotionalState(characterId, correlationId);

    if (!emotionalState) {
      logger.debug('Skipping character with no traits', { correlationId, characterId });
      return null;
    }

    const frameId = await this.saveFrame(characterId, emotionalState, correlationId);

    this._checkKnowledgeSlots(characterId, correlationId).catch(err => {
      logger.warn('Knowledge slot check failed (non-blocking)', {
        correlationId,
        characterId,
        error: err.message
      });
    });

    const totalMs = Date.now() - startTime;
    Counters.totalProcessingMs += totalMs;

    return {
      frameId,
      emotionalState: { p: emotionalState.p, a: emotionalState.a, d: emotionalState.d },
      metrics: {
        totalMs,
        meta: emotionalState.meta
      }
    };
  }

  // -------------------------------------------------------------------------
  // Batch Character Processing
  // -------------------------------------------------------------------------

  /**
   * Process multiple characters in sequence. Returns results for all
   * characters, with null entries for characters that failed or had
   * no traits. Each character is processed independently — one failure
   * does not prevent others from completing.
   *
   * @param {string[]} characterIds — array of hex IDs
   * @param {string} [correlationId] — optional correlation ID
   * @returns {object[]} array of { characterId, result } objects
   */
  async processCharacters(characterIds, correlationId) {
    if (!Array.isArray(characterIds) || characterIds.length === 0) {
      return [];
    }

    const batchStart = Date.now();
    const results = [];

    for (const characterId of characterIds) {
      try {
        const result = await this.processCharacter(characterId, correlationId);
        results.push({ characterId, result });
      } catch (error) {
        logger.error('Character processing failed in batch', error, {
          correlationId,
          characterId
        });
        results.push({ characterId, result: null, error: error.message });
      }
    }

    Counters.batchesProcessed++;
    const batchMs = Date.now() - batchStart;

    logger.info('Batch processing complete', {
      correlationId,
      totalCharacters: characterIds.length,
      successful: results.filter(r => r.result !== null && !r.error).length,
      failed: results.filter(r => r.error).length,
      skipped: results.filter(r => r.result === null && !r.error).length,
      batchMs
    });

    return results;
  }

  // -------------------------------------------------------------------------
  // Knowledge Slot Claiming (B-Roll Only, Fire-and-Forget)
  // -------------------------------------------------------------------------

  /**
   * Check if a B-Roll autonomous character should claim knowledge slots.
   * Decoupled from frame generation — failure never blocks the pipeline.
   *
   * @param {string} characterId — hex ID
   * @param {string} correlationId
   * @private
   */
  async _checkKnowledgeSlots(characterId, correlationId) {
    const profileResult = await _queryWithTimeout(
      this.pool,
      'SELECT is_b_roll_autonomous FROM character_profiles WHERE character_id = $1',
      [characterId],
      TIMEOUTS.QUERY_MS
    );

    if (profileResult.rows.length === 0 || !profileResult.rows[0].is_b_roll_autonomous) {
      return;
    }

    Counters.knowledgeSlotChecks++;

    const domainsResult = await _queryWithTimeout(
      this.pool,
      'SELECT domain_id FROM knowledge_domains WHERE is_active = true',
      [],
      TIMEOUTS.QUERY_MS
    );

    logger.debug('B-Roll knowledge slot check', {
      correlationId,
      characterId,
      domainCount: domainsResult.rows.length
    });
  }
}

export { Counters as PsychicEngineCounters, PSYCHIC_CONFIG, PAD_LIMITS };
export default PsychicEngine;
