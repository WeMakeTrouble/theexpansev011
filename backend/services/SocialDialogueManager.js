/**
 * ============================================================================
 * SocialDialogueManager.js — Cooldown-Aware Utterance Selection (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages social and relational utterance selection with per-user,
 * per-character cooldowns to prevent repetition. Complements
 * ltlmUtteranceSelector.js — that handles PAD/speech act matching,
 * this handles social variety and relationship progression gating.
 *
 * HOW IT WORKS
 * ------------
 * 1. GET AVAILABLE (getAvailableUtterances):
 *    - Queries ltlm_training_examples joined with social_dialogue_usage
 *    - Filters by dialogue function category, character, canonical status
 *    - Phase-gates: only returns utterances where phase_minimum <= userPhase
 *    - Orders by least-used first, then random for variety
 *
 * 2. FILTER BY COOLDOWN (filterByCooldown):
 *    - Checks hours elapsed since each utterance was last used
 *    - Removes utterances still within their cooldown window
 *    - Uses per-utterance cooldown_turns or DEFAULT_COOLDOWN_HOURS
 *
 * 3. SELECT (selectUtterance):
 *    - Gets available utterances for category
 *    - Filters by cooldown
 *    - If pool drops below MIN_POOL_SIZE, relaxes to LRU (least recently used)
 *    - Optionally ranks by PAD similarity (Euclidean distance)
 *    - Selects from top N candidates with randomness for natural variation
 *
 * 4. RECORD USAGE (recordUsage):
 *    - Upserts into social_dialogue_usage with hex ID
 *    - Tracks use_count and last_used_at per user/character/utterance
 *    - Transaction-safe with row-level locking
 *
 * 5. SELECT AND RECORD (selectAndRecord):
 *    - Convenience: selects an utterance and records usage atomically
 *
 * 6. USAGE STATS (getUsageStats):
 *    - Returns aggregate stats for a user-character pair
 *
 * 7. RESET COOLDOWNS (resetCooldowns):
 *    - Admin/debug: resets all cooldowns for a user-character pair
 *
 * PAD SIMILARITY
 * --------------
 * Uses 3D Euclidean distance across Pleasure, Arousal, Dominance axes:
 *   distance = sqrt((p1-p2)^2 + (a1-a2)^2 + (d1-d2)^2)
 * Lower distance = better emotional match.
 *
 * COOLDOWN RELAXATION
 * -------------------
 * When fewer than MIN_POOL_SIZE utterances pass cooldown filtering,
 * the system falls back to least-recently-used ordering to ensure
 * the NPC always has something to say. Prevents "silent NPC syndrome."
 *
 * SOCIAL CATEGORY DETECTION
 * -------------------------
 * Categories starting with these prefixes are considered social:
 *   social_obligations_management, relational, expressive.self_disclosure,
 *   expressive.empathize, expressive.encourage, narrative.invite_wonder
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js
 *
 * DATABASE TABLES:
 *   ltlm_training_examples — source utterances
 *   social_dialogue_usage  — per-user cooldown and usage tracking
 *
 * INVARIANTS
 * ----------
 * - Never returns stale data (cooldown computed at query time)
 * - Usage recording is transaction-safe with row-level locking
 * - Phase gating is enforced at the SQL level
 * - Falls back gracefully when pool is exhausted
 * - Never mutates input parameters
 * - No console.log — structured logger only
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('SocialDialogueManager');

/* ========================================================================== */
/*  Constants                                                                  */
/* ========================================================================== */

const DEFAULT_COOLDOWN_HOURS = 24;
const MIN_POOL_SIZE = 5;
const TOP_N_CANDIDATES = 3;
const MS_PER_HOUR = 3600000;

const SOCIAL_PREFIXES = Object.freeze([
  'social_obligations_management',
  'relational',
  'expressive.self_disclosure',
  'expressive.empathize',
  'expressive.encourage',
  'narrative.invite_wonder'
]);

/* ========================================================================== */
/*  Helper Functions (pure, stateless)                                         */
/* ========================================================================== */

/**
 * Calculate hours elapsed since a timestamp.
 * @param {string|Date} timestamp - ISO timestamp or Date object
 * @returns {number} hours since timestamp, or Infinity if null/invalid
 */
function _hoursSince(timestamp) {
  if (!timestamp) return Infinity;
  const then = new Date(timestamp);
  const now = new Date();
  return (now - then) / MS_PER_HOUR;
}

/**
 * Calculate 3D Euclidean distance between two PAD vectors.
 * @param {object} pad1 - { pleasure, arousal, dominance }
 * @param {object} pad2 - { pleasure, arousal, dominance }
 * @returns {number} distance (lower = closer emotional match)
 */
function _padDistance(pad1, pad2) {
  const dp = (pad1.pleasure || 0) - (pad2.pleasure || 0);
  const da = (pad1.arousal || 0) - (pad2.arousal || 0);
  const dd = (pad1.dominance || 0) - (pad2.dominance || 0);
  return Math.sqrt(dp * dp + da * da + dd * dd);
}

/* ========================================================================== */
/*  SocialDialogueManager                                                      */
/* ========================================================================== */

class SocialDialogueManager {

  /**
   * Check if a dialogue function category is social/relational.
   *
   * @param {string} category - Dialogue function category code
   * @returns {boolean} true if category matches a social prefix
   */
  isSocialCategory(category) {
    if (!category || typeof category !== 'string') return false;
    return SOCIAL_PREFIXES.some(prefix => category.startsWith(prefix));
  }

  /**
   * Get available utterances for a category with cooldown and phase filtering.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @param {string} category - Dialogue function category
   * @param {number} userPhase - User's relationship phase (0-10)
   * @returns {Promise<Array>} available utterances
   */
  async getAvailableUtterances(userId, characterId, category, userPhase = 0) {
    if (!userId || !characterId || !category) {
      logger.warn('getAvailableUtterances called with missing params', {
        userId, characterId, category
      });
      return [];
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
          lte.training_example_id,
          lte.utterance_text,
          lte.dialogue_function_code,
          lte.speech_act_code,
          lte.pad_pleasure,
          lte.pad_arousal,
          lte.pad_dominance,
          lte.phase_minimum,
          lte.cooldown_hours,
          sdu.last_used_at,
          sdu.use_count
         FROM ltlm_training_examples lte
         LEFT JOIN social_dialogue_usage sdu
           ON lte.training_example_id = sdu.training_example_id
           AND sdu.user_id = $1
           AND sdu.character_id = $2
         WHERE lte.dialogue_function_code LIKE $3
           AND lte.speaker_character_id = $2
           AND lte.is_canonical = true
           AND (lte.phase_minimum IS NULL OR lte.phase_minimum <= $4)
         ORDER BY sdu.use_count ASC NULLS FIRST, lte.training_example_id ASC`,
        [userId, characterId, category + '%', userPhase]
      );

      return result.rows.map(row => ({
        trainingExampleId: row.training_example_id,
        text: row.utterance_text,
        dialogueFunction: row.dialogue_function_code,
        speechAct: row.speech_act_code,
        pad: {
          pleasure: row.pad_pleasure,
          arousal: row.pad_arousal,
          dominance: row.pad_dominance
        },
        phaseMinimum: row.phase_minimum || 0,
        cooldownHours: row.cooldown_hours || 0,
        lastUsedAt: row.last_used_at,
        useCount: row.use_count || 0
      }));
    } catch (err) {
      logger.error('getAvailableUtterances failed', err, {
        userId, characterId, category
      });
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Check if a specific utterance is on cooldown.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @param {string} trainingExampleId - Training example hex ID
   * @param {number} cooldownHours - Cooldown period in hours
   * @returns {Promise<{onCooldown: boolean, hoursRemaining: number}>}
   */
  async checkCooldown(userId, characterId, trainingExampleId, cooldownHours = null) {
    if (!userId || !characterId || !trainingExampleId) {
      return { onCooldown: false, hoursRemaining: 0 };
    }

    const hours = cooldownHours ?? DEFAULT_COOLDOWN_HOURS;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT last_used_at
         FROM social_dialogue_usage
         WHERE user_id = $1
           AND character_id = $2
           AND training_example_id = $3`,
        [userId, characterId, trainingExampleId]
      );

      if (result.rows.length === 0) {
        return { onCooldown: false, hoursRemaining: 0 };
      }

      const hoursSince = _hoursSince(result.rows[0].last_used_at);

      if (hoursSince >= hours) {
        return { onCooldown: false, hoursRemaining: 0 };
      }

      return {
        onCooldown: true,
        hoursRemaining: Number((hours - hoursSince).toFixed(1))
      };
    } catch (err) {
      logger.error('checkCooldown failed', err, {
        userId, characterId, trainingExampleId
      });
      return { onCooldown: false, hoursRemaining: 0 };
    } finally {
      client.release();
    }
  }

  /**
   * Filter utterances by cooldown window.
   *
   * @param {Array} utterances - Utterance objects with lastUsedAt and cooldownTurns
   * @returns {Array} utterances that have passed their cooldown
   */
  filterByCooldown(utterances) {
    if (!Array.isArray(utterances)) return [];

    return utterances.filter(u => {
      if (!u.lastUsedAt) return true;

      const hoursSince = _hoursSince(u.lastUsedAt);
      const cooldownHours = u.cooldownHours > 0
        ? u.cooldownTurns
        : DEFAULT_COOLDOWN_HOURS;

      return hoursSince >= cooldownHours;
    });
  }

  /**
   * Rank utterances by PAD similarity to a target emotional state.
   *
   * @param {Array} utterances - Utterance objects with pad field
   * @param {object} targetPad - { pleasure, arousal, dominance }
   * @returns {Array} sorted by ascending PAD distance (closest first)
   */
  rankByPadSimilarity(utterances, targetPad) {
    if (!Array.isArray(utterances) || !targetPad) return utterances || [];

    return utterances
      .map(u => ({
        ...u,
        padDistance: _padDistance(u.pad || {}, targetPad)
      }))
      .sort((a, b) => a.padDistance - b.padDistance);
  }

  /**
   * Select an utterance with cooldown awareness and optional PAD matching.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @param {string} category - Dialogue function category
   * @param {object} options - { userPhase, targetPad }
   * @returns {Promise<object|null>} selected utterance or null
   */
  async selectUtterance(userId, characterId, category, options = {}) {
    if (!userId || !characterId || !category) {
      logger.warn('selectUtterance called with missing params', {
        userId, characterId, category
      });
      return null;
    }

    const { userPhase = 0, targetPad = null } = options;

    const utterances = await this.getAvailableUtterances(
      userId, characterId, category, userPhase
    );

    if (utterances.length === 0) {
      logger.debug('No utterances available', { userId, characterId, category });
      return null;
    }

    let available = this.filterByCooldown(utterances);

    if (available.length < MIN_POOL_SIZE && utterances.length >= MIN_POOL_SIZE) {
      logger.debug('Cooldown relaxation triggered', {
        available: available.length,
        total: utterances.length,
        category
      });

      available = utterances
        .sort((a, b) => {
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        })
        .slice(0, MIN_POOL_SIZE);
    }

    if (available.length === 0) {
      logger.debug('No utterances after cooldown filter', {
        userId, characterId, category
      });
      return null;
    }

    if (targetPad) {
      available = this.rankByPadSimilarity(available, targetPad);
    }

    const topN = Math.min(TOP_N_CANDIDATES, available.length);
    // EXCEPTION TO DETERMINISM CONSTRAINT: Social dialogue selection uses non-deterministic
    // randomization for natural variety in greetings and relational exchanges.
    // Intentional architectural exception — reproducibility is less critical than
    // perceived spontaneity for social content.
    const selected = available[Math.floor(Math.random() * topN)];

    logger.debug('Utterance selected', {
      category,
      trainingExampleId: selected.trainingExampleId,
      useCount: selected.useCount,
      hasPadRanking: !!targetPad
    });

    return selected;
  }

  /**
   * Record usage of an utterance. Upserts into social_dialogue_usage.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @param {string} trainingExampleId - Training example hex ID
   * @returns {Promise<{recorded: boolean, usageId: string|null, error: string|null}>}
   */
  async recordUsage(userId, characterId, trainingExampleId) {
    if (!userId || !characterId || !trainingExampleId) {
      logger.warn('recordUsage called with missing params', {
        userId, characterId, trainingExampleId
      });
      return { recorded: false, usageId: null, error: 'Missing required parameters' };
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT usage_id, use_count
         FROM social_dialogue_usage
         WHERE user_id = $1 AND character_id = $2 AND training_example_id = $3
         FOR UPDATE`,
        [userId, characterId, trainingExampleId]
      );

      let usageId;

      if (existing.rows.length > 0) {
        usageId = existing.rows[0].usage_id;
        await client.query(
          `UPDATE social_dialogue_usage
           SET last_used_at = NOW(),
               use_count = use_count + 1
           WHERE usage_id = $1`,
          [usageId]
        );
      } else {
        usageId = await generateHexId('social_dialogue_usage_id');
        await client.query(
          `INSERT INTO social_dialogue_usage (
            usage_id, user_id, character_id, training_example_id,
            last_used_at, use_count
          ) VALUES ($1, $2, $3, $4, NOW(), 1)`,
          [usageId, userId, characterId, trainingExampleId]
        );
      }

      await client.query('COMMIT');

      logger.debug('Usage recorded', {
        usageId, userId, characterId, trainingExampleId
      });

      return { recorded: true, usageId, error: null };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('recordUsage failed', err, {
        userId, characterId, trainingExampleId
      });
      return { recorded: false, usageId: null, error: err.message };
    } finally {
      client.release();
    }
  }

  /**
   * Select an utterance and record its usage in one operation.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @param {string} category - Dialogue function category
   * @param {object} options - { userPhase, targetPad }
   * @returns {Promise<object|null>} selected utterance with usage info, or null
   */
  async selectAndRecord(userId, characterId, category, options = {}) {
    const selected = await this.selectUtterance(userId, characterId, category, options);

    if (!selected) {
      return null;
    }

    const usage = await this.recordUsage(userId, characterId, selected.trainingExampleId);

    return {
      ...selected,
      usageRecorded: usage.recorded,
      usageId: usage.usageId
    };
  }

  /**
   * Get usage statistics for a user-character pair.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @returns {Promise<object>} usage statistics
   */
  async getUsageStats(userId, characterId) {
    if (!userId || !characterId) {
      return { totalUtterancesUsed: 0, totalUses: 0, lastInteraction: null, avgUseCount: 0 };
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
          COUNT(*) as total_utterances_used,
          SUM(use_count) as total_uses,
          MAX(last_used_at) as last_interaction,
          AVG(use_count) as avg_use_count
         FROM social_dialogue_usage
         WHERE user_id = $1 AND character_id = $2`,
        [userId, characterId]
      );

      const row = result.rows[0];
      return {
        totalUtterancesUsed: parseInt(row.total_utterances_used) || 0,
        totalUses: parseInt(row.total_uses) || 0,
        lastInteraction: row.last_interaction || null,
        avgUseCount: Number(parseFloat(row.avg_use_count || 0).toFixed(2))
      };
    } catch (err) {
      logger.error('getUsageStats failed', err, { userId, characterId });
      return { totalUtterancesUsed: 0, totalUses: 0, lastInteraction: null, avgUseCount: 0 };
    } finally {
      client.release();
    }
  }

  /**
   * Reset cooldowns for a user-character pair (admin/debug).
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @returns {Promise<{reset: boolean, count: number}>}
   */
  async resetCooldowns(userId, characterId) {
    if (!userId || !characterId) {
      logger.warn('resetCooldowns called with missing params', { userId, characterId });
      return { reset: false, count: 0 };
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE social_dialogue_usage
         SET last_used_at = NULL  -- NULL signals never-used; avoids magic time offset
         WHERE user_id = $1 AND character_id = $2`,
        [userId, characterId]
      );

      logger.info('Cooldowns reset', {
        userId, characterId, count: result.rowCount
      });

      return { reset: true, count: result.rowCount };
    } catch (err) {
      logger.error('resetCooldowns failed', err, { userId, characterId });
      return { reset: false, count: 0 };
    } finally {
      client.release();
    }
  }
}

/* ========================================================================== */
/*  Singleton Export                                                            */
/* ========================================================================== */

const socialDialogueManager = new SocialDialogueManager();
export default socialDialogueManager;
