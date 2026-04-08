/**
 * ===========================================================================
 * BehavioralBaselineManager.js — EMA Behavioral Baseline Tracking
 * ===========================================================================
 *
 * PURPOSE:
 * Accumulates per-turn behavioral signals and persists them as Exponential
 * Moving Averages (EMAs) to the behavioral_baselines table. Provides the
 * Okinawan Layer with smoothed longitudinal signals that capture engagement
 * patterns over time rather than single-turn snapshots.
 *
 * DESIGN PRINCIPLE — PERSONAL BASELINE:
 * Following the BiAffect methodology (Stange et al., 2018), all baseline
 * metrics are computed relative to the individual character's own history.
 * There is no global norm. A character who teaches frequently has a high
 * teaching_ratio_ema; their Okinawan contribution score reflects whether
 * their current behaviour matches their own established pattern.
 *
 * This addresses a core SDT finding: obsessive passion for videogames is
 * predicted by low need satisfaction in general life — not by need
 * satisfaction within the game (Johnson et al., 2022). Deviations from
 * personal baseline are more meaningful than absolute scores.
 *
 * EMA PARAMETERS:
 *   Adaptive alpha based on sample count:
 *     samples < 10:  alpha = 0.7  (high learning rate, few observations)
 *     samples < 30:  alpha = 0.5  (moderate, approaching stability)
 *     samples >= 30: alpha = 0.3  (stable, trusts history)
 *   Inflection points align with OKINAWAN.CONFIDENCE_THRESHOLDS:
 *     MEDIUM confidence at 10 sessions, HIGH at 30 sessions.
 *   All alpha values PROPOSED — requires calibration.
 *
 * CONCURRENCY — PER-CHARACTER SERIALISATION:
 * Concurrent EMA updates for the same character would corrupt the running
 * average (each update depends on the previous value). This is solved via:
 *   1. Promise-chain queue (emaQueues Map) — one queue per character,
 *      updates execute sequentially via .then() chaining.
 *   2. SELECT FOR UPDATE — row-level lock during the actual DB write.
 *   3. finally() cleanup — removes queue entry when chain completes,
 *      preventing memory leak.
 *
 * This pattern was proposed by Perplexity (external reviewer) and accepted
 * in Deep Dive 02. It guarantees serial EMA writes per character while
 * allowing parallel writes across different characters.
 *
 * SIGNALS ACCUMULATED:
 *   - teaching turns (from diagnostic.tse.isTeachingTurn)
 *   - social intent frames (from diagnostic.intent.frame === 'social')
 *   - session boundaries (sessionEnd flag triggers session_frequency_ema)
 *   - reciprocal proximity sample count (incremented each flush)
 *
 * TRANSACTION PATTERN:
 * Each EMA update runs inside a BEGIN/COMMIT transaction with SELECT FOR
 * UPDATE row-level locking. On failure, ROLLBACK is issued and the error
 * propagates to the Promise-chain .catch() handler. The client connection
 * is always released via finally() to prevent pool exhaustion.
 *
 * DEPENDENCIES:
 *   - generateHexId (backend/utils/hexIdGenerator.js)
 *   - safeFloat (backend/utils/safeFloat.js)
 *   - createModuleLogger (backend/utils/logger.js)
 *
 * DB TABLES:
 *   - behavioral_baselines (read/write: EMA state per character)
 *
 * EXPORTS:
 *   BehavioralBaselineManager class (named export)
 *     accumulateTurn(characterId, diagnostic)   — buffer signals in memory
 *     flushEMAUpdate(characterId, sessionEnd?)  — persist to DB (queued)
 *
 * CALIBRATION STATUS:
 *   EMA alpha progression (0.7 → 0.5 → 0.3) and decay lambda (0.05) are
 *   tagged 'proposed' in ikigaiConfig.js. Validation requires longitudinal
 *   data to determine optimal smoothing parameters for the teaching ratio
 *   and session regularity signals in a gaming context.
 *
 * RESEARCH CITATIONS:
 *   [1]  Stange, J. P., Zulueta, J., Langenecker, S. A., Ryan, K. A.,
 *        Piscitello, A., Duffecy, J., McInnis, M. G., Nelson, P.,
 *        Ajilore, O., & Leow, A. (2018). Let your fingers do the talking:
 *        Passive typing instability predicts future mood outcomes. Bipolar
 *        Disorders, 20(3), 285–288. [BiAffect personal baseline EMA methodology]
 *   [2]  Johnson, D., et al. (2022). Need satisfaction and wellbeing before
 *        and during COVID-19. Computers in Human Behavior, 131, 107232.
 *        [Personal baseline deviation more meaningful than absolute scores]
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Behavioral Baseline Manager
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
import { createModuleLogger } from '../../utils/logger.js';
import { safeFloat } from '../../utils/safeFloat.js';
import hexIdGen from '../../utils/hexIdGenerator.js';const { generateHexId } = hexIdGen;

const logger = createModuleLogger('behavioral-baseline-manager');

export class BehavioralBaselineManager {
  constructor(db, emaQueues) {
    this.db = db;
    this.emaQueues = emaQueues; // Map<characterId, Promise>
    this.pendingTurns = new Map();
  }

  accumulateTurn(characterId, diagnostic) {
    if (!this.pendingTurns.has(characterId)) {
      this.pendingTurns.set(characterId, { count: 0, signals: [], socialFrames: 0 });
    }
    const buffer = this.pendingTurns.get(characterId);
    buffer.count++;
    if (diagnostic.tse?.isTeachingTurn) {
      buffer.signals.push({ teaching: true });
    }
    if (diagnostic.intent?.frame === 'social') {
      buffer.socialFrames++;
    }
  }

  async flushEMAUpdate(characterId, sessionEnd = false) {
    const prev = this.emaQueues.get(characterId) || Promise.resolve();

    const next = prev.then(async () => {
      await this.updateEMAWithLock(characterId, sessionEnd);
    }).catch(err => {
      logger.error({ characterId, err }, 'EMA update failed');
    });

    this.emaQueues.set(characterId, next);

    next.finally(() => {
      if (this.emaQueues.get(characterId) === next) {
        this.emaQueues.delete(characterId);
      }
    });

    return next;
  }

  async updateEMAWithLock(characterId, sessionEnd) {
    const buffer = this.pendingTurns.get(characterId) || { count: 0, signals: [], socialFrames: 0 };
    this.pendingTurns.delete(characterId);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        'SELECT * FROM behavioral_baselines WHERE character_id = $1 FOR UPDATE',
        [characterId]
      );

      let baseline = rows[0];
      if (!baseline) {
        const id = await generateHexId('behavioral_baselines', this.db);
        await client.query(
          `INSERT INTO behavioral_baselines 
           (baseline_id, character_id, created_at, updated_at, reciprocal_proximity_samples)
           VALUES ($1, $2, NOW(), NOW(), 0)`,
          [id, characterId]
        );
        baseline = { sample_count: 0, current_alpha: 0.7, reciprocal_proximity_samples: 0 };
      }

      const teachingTurns = buffer.signals.filter(s => s.teaching).length;
      const teachingRatio = buffer.count > 0 ? teachingTurns / buffer.count : 0;

      const sampleCount = baseline.sample_count || 0;
      const alpha = sampleCount < 10 ? 0.7 :
                    sampleCount < 30 ? 0.5 : 0.3;

      const newTeachingEMA =
        alpha * teachingRatio +
        (1 - alpha) * safeFloat(baseline.teaching_ratio_ema);

      // Fix 1 (April 2nd review): Only update session_frequency_ema on actual session end
      // Previously dragged toward zero on every non-session-end flush
      let newFreqEMA = safeFloat(baseline.session_frequency_ema);
      if (sessionEnd) {
        newFreqEMA = alpha * 1 + (1 - alpha) * newFreqEMA;
      }

      const newProximitySamples = (baseline.reciprocal_proximity_samples || 0) + 1;

      // Fix 2 (April 2nd review): Compute inter_session_gap_ema (was never persisted,
      // OkinawanCalculator.computeSustainability was always reading fallback 0.5)
      const lastSession = baseline.last_session_at ? new Date(baseline.last_session_at).getTime() : Date.now();
      const gapDays = (Date.now() - lastSession) / (1000 * 60 * 60 * 24);
      const normalizedGap = Math.min(gapDays / 14, 1.0);
      const newGapEMA = alpha * normalizedGap + (1 - alpha) * safeFloat(baseline.inter_session_gap_ema);

      await client.query(
        `UPDATE behavioral_baselines
         SET teaching_ratio_ema = $1,
             session_frequency_ema = $2,
             current_alpha = $3,
             sample_count = $4,
             reciprocal_proximity_samples = $5,
             inter_session_gap_ema = $6,
             last_session_at = NOW(),
             updated_at = NOW()
         WHERE character_id = $7`,
        [
          newTeachingEMA,
          newFreqEMA,
          alpha,
          sampleCount + 1,
          newProximitySamples,
          newGapEMA,
          characterId
        ]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
