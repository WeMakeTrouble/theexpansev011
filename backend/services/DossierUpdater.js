/**
 * ============================================================================
 * DossierUpdater.js — Long-Term Temperament Tracker (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Updates a user's psychological dossier (cotw_dossiers) based on new
 * emotional events. Tracks long-term temperament through exponential
 * moving averages and volatility scoring.
 *
 * This is how Claude builds understanding of WHO a user is over time.
 * Individual emotional events are momentary — this module turns them
 * into lasting personality profiles: "generally cheerful," "emotionally
 * stable," "tends toward intensity."
 *
 * PSYCHOLOGICAL MODEL
 * -------------------
 * Rolling EMA with alpha=0.1 (very sticky history):
 *   newAvg = oldAvg * 0.9 + currentPad * 0.1
 *
 * This means recent events have small influence. It takes ~22
 * interactions to shift 90% toward a new value. This is intentional —
 * temperament is stable by definition.
 *
 * Cold start: First sample uses alpha=1.0 so the user starts at their
 * actual emotional state, not blended with zeroes.
 *
 * Volatility is tracked separately as a rolling average of event
 * magnitudes (Euclidean distance of PAD deltas):
 *   newVolatility = oldVolatility * 0.95 + eventMagnitude * 0.05
 *
 * Maximum theoretical delta magnitude is sqrt(12) ≈ 3.465 (full
 * diagonal of the [-1,1] PAD cube). Deltas exceeding this are logged
 * as warnings but still processed.
 *
 * LABEL GENERATION
 * ----------------
 * Human-readable labels are generated from long-term averages:
 *   Pleasure:   Cheerful (>0.3) / Melancholic (<-0.3)
 *   Arousal:    Intense (>0.4) / Calm (<-0.2)
 *   Dominance:  Dominant (>0.3) / Submissive (<-0.3)
 *   Volatility: Volatile (>0.15) / Stable (<0.05, 10+ samples)
 *
 * These labels feed into ConciergeStatusReportService for login
 * greetings and into the COTW dossier for Claude's long-term memory.
 *
 * DATA FLOW
 * ---------
 * padEstimator → DrClaudeModule → DossierUpdater → cotw_dossiers
 *
 * DrClaudeModule calls processUpdate() after storing the immediate
 * mood. DossierUpdater reads the existing dossier, blends in the
 * new data, generates labels, and writes back atomically.
 *
 * CONSUMERS
 * ---------
 * - DrClaudeModule: calls processUpdate after mood storage
 * - ConciergeStatusReportService: reads psychological_profile
 * - PhaseClaudesHelpDesk: reads dossier for helpdesk context
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, Counters
 * External: None
 *
 * SCHEMA
 * ------
 * Table: cotw_dossiers
 * Columns used: dossier_id, user_id, dossier_type, pad_snapshot,
 *               psychological_profile, last_psychic_frame_id, updated_at
 *
 * NOTE ON updated_at: Currently set manually with NOW() in the UPDATE
 * query. This should be replaced with a database trigger:
 *   CREATE TRIGGER cotw_dossiers_updated_at
 *   BEFORE UPDATE ON cotw_dossiers
 *   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
 * Once that trigger exists, remove the manual NOW() from the UPDATE.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('DossierUpdater');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const EMA = Object.freeze({
  HISTORY_ALPHA: 0.1,
  HISTORY_ALPHA_COLD_START: 1.0,
  VOLATILITY_ALPHA: 0.05
});

const LABEL_THRESHOLDS = Object.freeze({
  PLEASURE_CHEERFUL: 0.3,
  PLEASURE_MELANCHOLIC: -0.3,
  AROUSAL_INTENSE: 0.4,
  AROUSAL_CALM: -0.2,
  DOMINANCE_DOMINANT: 0.3,
  DOMINANCE_SUBMISSIVE: -0.3
});

const VOLATILITY_THRESHOLDS = Object.freeze({
  VOLATILE: 0.15,
  STABLE: 0.05,
  MIN_SAMPLES_FOR_STABLE: 10
});

const PAD_PRECISION = 4;

const MAX_REASONABLE_DELTA_MAGNITUDE = 3.465;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _guardHexId(value, name, correlationId) {
  if (!value || typeof value !== 'string' || !isValidHexId(value)) {
    logger.warn('Invalid hex ID', { field: name, value, correlationId });
    return false;
  }
  return true;
}

function _validatePadObject(pad, name) {
  if (!pad || typeof pad !== 'object') {
    throw new Error('DossierUpdater: ' + name + ' must be an object, got: ' + typeof pad);
  }
  if (typeof pad.p !== 'number' || typeof pad.a !== 'number' || typeof pad.d !== 'number') {
    throw new Error('DossierUpdater: ' + name + ' must have numeric p, a, d fields');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  DossierUpdater Class                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

class DossierUpdater {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Process Emotional Update                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Updates the user's long-term psychological profile based on a new
   * emotional event. Reads existing dossier, blends in new data,
   * generates temperament labels, writes back atomically.
   *
   * @param {string} userId - User hex ID
   * @param {string} frameId - Psychic frame ID (audit trail)
   * @param {object} currentPad - New PAD state { p, a, d }
   * @param {object} delta - Change that occurred { p, a, d }
   * @param {string} correlationId - Request correlation ID
   * @returns {object} { success, updated, dossierId?, labels?, reason? }
   */
  async processUpdate(userId, frameId, currentPad, delta, correlationId) {
    try {
      if (!_guardHexId(userId, 'userId', correlationId)) {
        Counters.increment('dossier_validation_error', 'userId');
        return { success: false, reason: 'invalid_userId' };
      }
      if (!_guardHexId(frameId, 'frameId', correlationId)) {
        Counters.increment('dossier_validation_error', 'frameId');
        return { success: false, reason: 'invalid_frameId' };
      }
      _validatePadObject(currentPad, 'currentPad');
      _validatePadObject(delta, 'delta');
    } catch (validationErr) {
      Counters.increment('dossier_validation_error', 'pad_object');
      logger.warn('Validation failed', { error: validationErr.message, correlationId });
      return { success: false, reason: validationErr.message };
    }

    this._warnIfDeltaUnreasonable(delta, correlationId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(
        'SELECT dossier_id, pad_snapshot, psychological_profile ' +
        'FROM cotw_dossiers ' +
        'WHERE user_id = $1 AND dossier_type = $2 FOR UPDATE',
        [userId, 'user']
      );

      if (res.rows.length === 0) {
        await client.query('COMMIT');
        logger.info('No dossier found, skipping trend analysis', { userId, correlationId });
        return { success: true, updated: false, reason: 'no_dossier' };
      }

      const dossier = res.rows[0];
      const history = dossier.psychological_profile || {
        avg_p: 0, avg_a: 0, avg_d: 0,
        volatility: 0,
        sample_count: 0
      };

      const isFirstSample = (history.sample_count || 0) === 0;
      const oldLabels = history.labels || [];
      const newHistory = this._blendHistory(history, currentPad, delta, isFirstSample);

      await client.query(
        'UPDATE cotw_dossiers ' +
        'SET pad_snapshot = $1, ' +
        '    psychological_profile = $2, ' +
        '    last_psychic_frame_id = $3, ' +
        '    updated_at = NOW() ' +
        'WHERE dossier_id = $4',
        [currentPad, newHistory, frameId, dossier.dossier_id]
      );

      await client.query('COMMIT');

      Counters.increment('dossier_update', 'success');

      if (this._labelsChanged(oldLabels, newHistory.labels)) {
        Counters.increment('dossier_labels_changed');
      }

      const hadStableHistory = !isFirstSample && (history.volatility || 0) <= VOLATILITY_THRESHOLDS.VOLATILE;
      if (hadStableHistory && newHistory.volatility > VOLATILITY_THRESHOLDS.VOLATILE) {
        Counters.increment('dossier_volatility_spike');
      }

      logger.info('Dossier updated', {
        dossierId: dossier.dossier_id,
        avgP: newHistory.avg_p,
        volatility: newHistory.volatility,
        labels: newHistory.labels,
        sampleCount: newHistory.sample_count,
        isFirstSample,
        correlationId
      });

      return {
        success: true,
        updated: true,
        dossierId: dossier.dossier_id,
        labels: newHistory.labels
      };

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      Counters.increment('dossier_update', 'failure');
      logger.error('Failed to update dossier', {
        userId,
        correlationId,
        error: err.message
      });
      return { success: false, reason: err.message };
    } finally {
      client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Blend New Event Into History                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  _blendHistory(history, currentPad, delta, isFirstSample) {
    const alpha = isFirstSample ? EMA.HISTORY_ALPHA_COLD_START : EMA.HISTORY_ALPHA;

    const newHistory = {
      avg_p: parseFloat(((history.avg_p || 0) * (1 - alpha) + currentPad.p * alpha).toFixed(PAD_PRECISION)),
      avg_a: parseFloat(((history.avg_a || 0) * (1 - alpha) + currentPad.a * alpha).toFixed(PAD_PRECISION)),
      avg_d: parseFloat(((history.avg_d || 0) * (1 - alpha) + currentPad.d * alpha).toFixed(PAD_PRECISION)),
      sample_count: (history.sample_count || 0) + 1,
      last_update: new Date().toISOString()
    };

    const eventMagnitude = Math.sqrt(delta.p ** 2 + delta.a ** 2 + delta.d ** 2);
    newHistory.volatility = parseFloat(
      ((history.volatility || 0) * (1 - EMA.VOLATILITY_ALPHA) + eventMagnitude * EMA.VOLATILITY_ALPHA).toFixed(PAD_PRECISION)
    );

    newHistory.labels = this._generateLabels(newHistory);

    return newHistory;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Generate Temperament Labels                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _generateLabels(history) {
    const labels = [];

    if (history.avg_p > LABEL_THRESHOLDS.PLEASURE_CHEERFUL) labels.push('Cheerful');
    if (history.avg_p < LABEL_THRESHOLDS.PLEASURE_MELANCHOLIC) labels.push('Melancholic');
    if (history.avg_a > LABEL_THRESHOLDS.AROUSAL_INTENSE) labels.push('Intense');
    if (history.avg_a < LABEL_THRESHOLDS.AROUSAL_CALM) labels.push('Calm');
    if (history.avg_d > LABEL_THRESHOLDS.DOMINANCE_DOMINANT) labels.push('Dominant');
    if (history.avg_d < LABEL_THRESHOLDS.DOMINANCE_SUBMISSIVE) labels.push('Submissive');

    if (history.volatility > VOLATILITY_THRESHOLDS.VOLATILE) labels.push('Volatile');
    if (history.volatility < VOLATILITY_THRESHOLDS.STABLE &&
        history.sample_count > VOLATILITY_THRESHOLDS.MIN_SAMPLES_FOR_STABLE) {
      labels.push('Stable');
    }

    return labels;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Delta Sanity Check                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  _warnIfDeltaUnreasonable(delta, correlationId) {
    const magnitude = Math.sqrt(delta.p ** 2 + delta.a ** 2 + delta.d ** 2);
    if (magnitude > MAX_REASONABLE_DELTA_MAGNITUDE) {
      logger.warn('Delta magnitude exceeds theoretical max', {
        magnitude: parseFloat(magnitude.toFixed(PAD_PRECISION)),
        maxExpected: MAX_REASONABLE_DELTA_MAGNITUDE,
        delta,
        correlationId
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Internal: Label Change Detection                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _labelsChanged(oldLabels, newLabels) {
    if (!Array.isArray(oldLabels) || !Array.isArray(newLabels)) return true;
    if (oldLabels.length !== newLabels.length) return true;
    const oldSet = new Set(oldLabels);
    return newLabels.some(label => !oldSet.has(label));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new DossierUpdater();
