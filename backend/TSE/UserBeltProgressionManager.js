/**
 * =============================================================================
 * UserBeltProgressionManager — Belt Advancement Engine
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Manages belt progression for HUMAN USERS (not characters).
 * Uses stability-based thresholds from fsrs_belt_calibration table.
 * Queries user_knowledge_state and user_belt_progression tables.
 *
 * Progression follows a strictly gated state machine:
 *   1. Time gate — minimum days at current belt level
 *   2. Stability gate — MIN stability across all domain items
 *   3. Practice gate — average practice count threshold
 *
 * All three gates must pass before stripe or belt advancement.
 * 4 stripes per belt, then promotion to next belt.
 *
 * BELT ORDER:
 * ---------------------------------------------------------------------------
 *   white_belt → blue_belt → purple_belt → brown_belt → black_belt
 *
 * PROTECTION CONTRACT:
 * ---------------------------------------------------------------------------
 * Human-only guard is enforced by TSELoopManager.runOrContinueTseSession()
 * which verifies users.owned_character_id BEFORE calling methods here.
 * Do NOT add redundant guards — single enforcement point is intentional.
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TSELoopManager.js — calls initializeUserProgression, checkAdvancement
 *   ConciergeStatusReportService.js — may call getProgressionStatus
 *
 * CONCURRENCY:
 * ---------------------------------------------------------------------------
 *   Uses SELECT FOR UPDATE row locking on all write paths.
 *   Optimistic locking via version column on UPDATE statements.
 *   Transaction discipline: BEGIN/COMMIT/ROLLBACK with finally release.
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger (no console.log, no string concatenation)
 *   - Counters on all progression paths
 *   - correlationId threading via opts parameter
 *   - Frozen constants for belt order, magic numbers
 *   - Hex ID validation on public method inputs
 *   - Constructor requires dbPool (no module-level fallback)
 *   - Named export alongside default
 *   - _query helper with labeled timeout for read-only methods
 *
 * =============================================================================
 */

import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('UserBeltProgressionManager');

/* ==========================================================================
 * Frozen Constants
 * ========================================================================== */

const BELT_CONFIG = Object.freeze({
  ORDER: Object.freeze([
    'white_belt',
    'blue_belt',
    'purple_belt',
    'brown_belt',
    'black_belt'
  ]),
  MAX_STRIPES: 4,
  MS_PER_DAY: 86400000,
  QUERY_TIMEOUT_MS: 8000
});

/* ==========================================================================
 * Counters
 * ========================================================================== */

const Counters = {
  _counts: {},
  increment(name) {
    this._counts[name] = (this._counts[name] || 0) + 1;
  },
  getAll() {
    return { ...this._counts };
  }
};

/* ==========================================================================
 * UserBeltProgressionManager CLASS
 * ========================================================================== */

class UserBeltProgressionManager {

  /**
   * @param {object} dbPool — PostgreSQL pool instance (required)
   */
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error('UserBeltProgressionManager requires a database pool');
    }
    this.pool = dbPool;
  }

  /* ═══════════════════════════════════════════════
     QUERY HELPER — labeled timeout for read-only paths
  ═══════════════════════════════════════════════ */

  async _query(label, sql, params, opts = {}) {
    const timeout = opts.timeout || BELT_CONFIG.QUERY_TIMEOUT_MS;
    const correlationId = opts.correlationId || null;

    const queryPromise = this.pool.query(sql, params);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), timeout)
    );

    try {
      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (err) {
      logger.error('Query failed', err, { label, correlationId, timeout });
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════
     INPUT VALIDATION
  ═══════════════════════════════════════════════ */

  _validateHexId(value, fieldName) {
    if (!value || typeof value !== 'string') {
      return false;
    }
    return /^#[0-9A-Fa-f]{6}$/.test(value);
  }

  /* ═══════════════════════════════════════════════
     INITIALIZE USER PROGRESSION
  ═══════════════════════════════════════════════ */

  async initializeUserProgression(userId, domainId, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!this._validateHexId(userId, 'userId') || !this._validateHexId(domainId, 'domainId')) {
      Counters.increment('initializeUserProgression.invalid_hex');
      logger.error('initializeUserProgression: invalid hex ID', { correlationId, userId, domainId });
      throw new Error('Invalid hex ID format for userId or domainId');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        'SELECT * FROM user_belt_progression WHERE user_id = $1 AND domain_id = $2 FOR UPDATE',
        [userId, domainId]
      );

      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        Counters.increment('initializeUserProgression.existing');
        return existing.rows[0];
      }

      const progressionId = await generateHexId('belt_progression_id');

      const insertRes = await client.query(
        `INSERT INTO user_belt_progression (
            progression_id, user_id, domain_id, current_belt, current_stripes,
            stripe_level, status_rusty, promoted_at, version,
            total_tse_cycles, successful_cycles, current_success_rate,
            advancement_progress, belt_history, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, NOW(), NOW())
        RETURNING *`,
        [
          progressionId,
          userId,
          domainId,
          BELT_CONFIG.ORDER[0],
          0,
          0,
          false,
          1,
          0,
          0,
          0.0,
          '{}',
          '[]'
        ]
      );

      await client.query('COMMIT');
      Counters.increment('initializeUserProgression.created');
      logger.info('Initialized user belt progression', {
        correlationId, userId, domainId, progressionId
      });
      return insertRes.rows[0];

    } catch (err) {
      await client.query('ROLLBACK');
      Counters.increment('initializeUserProgression.error');
      logger.error('Failed to initialize user belt progression', err, {
        correlationId, userId, domainId
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /* ═══════════════════════════════════════════════
     CHECK ADVANCEMENT
  ═══════════════════════════════════════════════ */

  async checkAdvancement(userId, domainId, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!this._validateHexId(userId, 'userId') || !this._validateHexId(domainId, 'domainId')) {
      Counters.increment('checkAdvancement.invalid_hex');
      logger.error('checkAdvancement: invalid hex ID', { correlationId, userId, domainId });
      return { can_advance: false, reason: 'Invalid hex ID format' };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const progression = await client.query(
        'SELECT * FROM user_belt_progression WHERE user_id = $1 AND domain_id = $2 FOR UPDATE',
        [userId, domainId]
      );

      if (!progression.rows.length) {
        await client.query('ROLLBACK');
        Counters.increment('checkAdvancement.no_record');
        return { can_advance: false, reason: 'No progression record found for this domain' };
      }

      const current = progression.rows[0];
      const {
        current_belt, current_stripes, status_rusty,
        promoted_at, version: currentVersion
      } = current;

      if (status_rusty === true) {
        await client.query('ROLLBACK');
        Counters.increment('checkAdvancement.rusty');
        return {
          can_advance: false,
          reason: 'Status is rusty - knowledge retention has decayed',
          next_action: 'Review items from this belt to recover status'
        };
      }

      const daysSincePromotion = Math.floor(
        (Date.now() - new Date(promoted_at).getTime()) / BELT_CONFIG.MS_PER_DAY
      );

      const calibration = await client.query(
        'SELECT * FROM fsrs_belt_calibration WHERE domain_id = $1 AND belt_level = $2',
        [domainId, current_belt]
      );

      if (!calibration.rows.length) {
        await client.query('ROLLBACK');
        Counters.increment('checkAdvancement.no_calibration');
        return { can_advance: false, reason: 'No calibration thresholds found for this belt level' };
      }

      const thresholds = calibration.rows[0];

      if (daysSincePromotion < thresholds.days_min) {
        await client.query('ROLLBACK');
        Counters.increment('checkAdvancement.time_gate');
        return {
          can_advance: false,
          reason: 'Insufficient time at current level',
          gates: {
            time: {
              achieved: daysSincePromotion,
              required: thresholds.days_min,
              pass: false
            }
          },
          ready_at: new Date(
            new Date(promoted_at).getTime() + thresholds.days_min * BELT_CONFIG.MS_PER_DAY
          )
        };
      }

      const stats = await this._calculateDomainMastery(userId, domainId, current_belt, client);

      const meetsStability = stats.min_stability >= thresholds.stability_min;
      const meetsPractice = stats.avg_practice_count >= thresholds.practice_min;
      const meetsTime = daysSincePromotion >= thresholds.days_min;

      const allGatesPass = meetsStability && meetsPractice && meetsTime;

      if (!allGatesPass) {
        await client.query('ROLLBACK');
        Counters.increment('checkAdvancement.gates_failed');
        return {
          can_advance: false,
          reason: 'Not ready for advancement',
          gates: {
            stability: {
              achieved: stats.min_stability.toFixed(2),
              required: thresholds.stability_min,
              pass: meetsStability,
              note: 'Using MIN stability - one weak item blocks advancement'
            },
            practice: {
              achieved: stats.avg_practice_count.toFixed(1),
              required: thresholds.practice_min,
              pass: meetsPractice
            },
            time: {
              achieved: daysSincePromotion,
              required: thresholds.days_min,
              pass: meetsTime
            }
          }
        };
      }

      const nextStripe = current_stripes + 1;
      const isBeltChange = nextStripe > BELT_CONFIG.MAX_STRIPES;

      if (isBeltChange) {
        const result = await this._promoteToBelt(
          userId, domainId, current_belt, currentVersion, client, opts
        );
        await client.query('COMMIT');
        return result;
      } else {
        const result = await this._advanceStripe(
          userId, domainId, current_belt, nextStripe, currentVersion, client, opts
        );
        await client.query('COMMIT');
        return result;
      }

    } catch (err) {
      await client.query('ROLLBACK');
      Counters.increment('checkAdvancement.error');
      logger.error('Advancement check failed', err, { correlationId, userId, domainId });
      throw err;
    } finally {
      client.release();
    }
  }

  /* ═══════════════════════════════════════════════
     DOMAIN MASTERY CALCULATION (private)
  ═══════════════════════════════════════════════ */

  async _calculateDomainMastery(userId, domainId, belt, client) {
    const result = await client.query(
      `SELECT
          MIN(stability) as min_stability,
          AVG(stability) as avg_stability,
          AVG(practice_count) as avg_practice_count,
          COUNT(*) as item_count
       FROM user_knowledge_state uks
       JOIN knowledge_items ki ON uks.knowledge_id = ki.knowledge_id
       WHERE uks.user_id = $1
         AND ki.domain_id = $2
         AND uks.acquisition_completed = true`,
      [userId, domainId]
    );

    return result.rows[0] || {
      min_stability: 0,
      avg_stability: 0,
      avg_practice_count: 0,
      item_count: 0
    };
  }

  /* ═══════════════════════════════════════════════
     BELT PROMOTION (private)
  ═══════════════════════════════════════════════ */

  async _promoteToBelt(userId, domainId, currentBelt, currentVersion, client, opts = {}) {
    const correlationId = opts.correlationId || null;
    const idx = BELT_CONFIG.ORDER.indexOf(currentBelt);
    const nextBelt = BELT_CONFIG.ORDER[idx + 1];

    if (!nextBelt) {
      Counters.increment('_promoteToBelt.max_belt');
      return { can_advance: false, reason: 'Already at black belt mastery' };
    }

    const updateResult = await client.query(
      `UPDATE user_belt_progression
       SET current_belt = $1, current_stripes = 0, stripe_level = 0,
           promoted_at = NOW(), status_rusty = false, version = version + 1,
           updated_at = NOW()
       WHERE user_id = $2 AND domain_id = $3 AND version = $4
       RETURNING *`,
      [nextBelt, userId, domainId, currentVersion]
    );

    if (updateResult.rows.length === 0) {
      throw new Error('Progression was updated elsewhere - retry required');
    }

    Counters.increment('_promoteToBelt.success');
    logger.info('User promoted to new belt', {
      correlationId, userId, domainId, newBelt: nextBelt
    });

    const beltLabel = nextBelt.replace('_', ' ');

    return {
      can_advance: true,
      advancement_type: 'belt_promotion',
      belt_level: nextBelt,
      stripe_level: 0,
      version: updateResult.rows[0].version,
      narrative: `Congratulations! You have achieved mastery and promoted to ${beltLabel}.`
    };
  }

  /* ═══════════════════════════════════════════════
     STRIPE ADVANCEMENT (private)
  ═══════════════════════════════════════════════ */

  async _advanceStripe(userId, domainId, belt, nextStripe, currentVersion, client, opts = {}) {
    const correlationId = opts.correlationId || null;

    const updateResult = await client.query(
      `UPDATE user_belt_progression
       SET current_stripes = $1, stripe_level = $1,
           promoted_at = NOW(), status_rusty = false, version = version + 1,
           updated_at = NOW()
       WHERE user_id = $2 AND domain_id = $3 AND version = $4
       RETURNING *`,
      [nextStripe, userId, domainId, currentVersion]
    );

    if (updateResult.rows.length === 0) {
      throw new Error('Progression was updated elsewhere - retry required');
    }

    Counters.increment('_advanceStripe.success');
    logger.info('User advanced stripe', {
      correlationId, userId, domainId, belt, stripe: nextStripe
    });

    const beltLabel = belt.replace('_', ' ');

    return {
      can_advance: true,
      advancement_type: 'stripe_advancement',
      belt_level: belt,
      stripe_level: nextStripe,
      version: updateResult.rows[0].version,
      narrative: `You have advanced to ${beltLabel} stripe ${nextStripe}.`
    };
  }

  /* ═══════════════════════════════════════════════
     PROGRESSION STATUS (read-only)
  ═══════════════════════════════════════════════ */

  async getProgressionStatus(userId, domainId, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!this._validateHexId(userId, 'userId') || !this._validateHexId(domainId, 'domainId')) {
      Counters.increment('getProgressionStatus.invalid_hex');
      logger.warn('getProgressionStatus: invalid hex ID', { correlationId, userId, domainId });
      return null;
    }

    const result = await this._query('getProgressionStatus',
      'SELECT * FROM user_belt_progression WHERE user_id = $1 AND domain_id = $2',
      [userId, domainId],
      { correlationId }
    );

    if (!result.rows.length) {
      Counters.increment('getProgressionStatus.not_found');
      return null;
    }

    const prog = result.rows[0];
    Counters.increment('getProgressionStatus.success');

    return {
      user_id: userId,
      domain_id: domainId,
      current_belt: prog.current_belt,
      current_stripes: prog.current_stripes,
      status_rusty: prog.status_rusty,
      promoted_at: prog.promoted_at,
      total_tse_cycles: prog.total_tse_cycles,
      successful_cycles: prog.successful_cycles,
      success_rate: ((prog.current_success_rate || 0) * 100).toFixed(1) + '%',
      version: prog.version
    };
  }

  /* ═══════════════════════════════════════════════
     DIAGNOSTICS
  ═══════════════════════════════════════════════ */

  getCounters() {
    return Counters.getAll();
  }
}

export { UserBeltProgressionManager };
export default UserBeltProgressionManager;
