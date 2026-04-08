/**
 * ============================================================================
 * userInteractionMemoryService.js — User Interaction Memory System (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Tracks every meaningful user interaction with content in The Expanse.
 * Enables Claude the Tanuki to remember what users have encountered,
 * what was recommended, what needs follow-up, and what counts toward
 * belt progression outside formal TSE cycles (coal face learning).
 *
 * DESIGN PHILOSOPHY
 * -----------------
 * Entity-agnostic. Any content with a hex ID can be tracked: characters,
 * locations, objects, knowledge items, curricula, narrative segments,
 * music tracks, images, etc. entityType and interactionSource are
 * deliberately free strings (validated against safe pattern), NOT enums.
 * This allows new content types to work automatically as The Expanse
 * grows, without code changes.
 *
 * TABLE: user_interaction_memory
 * HEX RANGE: user_interaction_id (0x140000 - 0x14FFFF)
 * UNIQUE CONSTRAINT: uq_user_entity (user_id, entity_type, entity_id)
 *
 * INDEXES
 * -------
 * idx_uim_user_id           — covers getUserInteractions
 * idx_uim_entity            — covers hasUserEncountered
 * idx_uim_source            — covers source filtering
 * idx_uim_last_interacted   — covers getSessionInteractions
 * idx_uim_follow_up         — partial WHERE follow_up_pending=TRUE
 * idx_uim_belt_credit       — partial WHERE belt_credit_awarded=TRUE
 * idx_uim_user_entity       — covers unique constraint lookups
 *
 * SCHEMA DEPENDENCIES
 * -------------------
 * - uq_user_entity constraint must exist (used by ON CONFLICT)
 * - interaction_count column defaults to 1
 * - first_encountered_at defaults to NOW()
 * - created_at, updated_at, last_interacted_at default to NOW()
 *
 * JSONB MERGE NOTE
 * ----------------
 * The context column uses PostgreSQL || operator on upsert.
 * This is SHALLOW merge: new keys added, existing keys overwritten,
 * keys not in the new context are preserved. Nested objects are
 * replaced wholesale, NOT deep-merged. If you need nested data
 * preserved, flatten your context keys before passing.
 *
 * UPSERT DETECTION
 * ----------------
 * Uses PostgreSQL xmax system column: (xmax = 0) means the row was
 * just inserted (no previous version). This is a single-roundtrip
 * atomic detection of insert vs update — no SELECT-then-INSERT race.
 *
 * RATE LIMITING
 * -------------
 * Write rate limiting is handled externally by the calling service
 * or middleware layer, not within this module.
 *
 * CONSUMERS
 * ---------
 * - ConciergeStatusReportService: calls getInteractionSummary
 * - PhaseIntent: may use hasUserEncountered for novelty detection
 * - socketHandler: records interactions during gameplay
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js
 * External: None
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';

const logger = createModuleLogger('UserInteractionMemory');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const LIMITS = Object.freeze({
  DEFAULT_QUERY: 50,
  DEFAULT_DISCOVERY: 10,
  DEFAULT_FOLLOW_UP: 50,
  MAX_QUERY: 200,
  MAX_STRING_LENGTH: 100,
  MAX_BATCH_SIZE: 500
});

/**
 * Safe pattern for entityType and interactionSource.
 * Only lowercase letters and underscores allowed.
 * Prevents SQL injection risk in dynamic query building.
 */
const SAFE_STRING_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _guardHexId(hexId, fieldName) {
  if (!hexId || !isValidHexId(hexId)) {
    logger.warn('Hex ID validation failed', { field: fieldName, received: hexId || 'empty' });
    return { success: false, error: 'Invalid or missing ' + fieldName + '. Must be #XXXXXX format.' };
  }
  return null;
}

function _validateStringField(value, fieldName) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Invalid or missing ' + fieldName + '.' };
  }
  if (value.length > LIMITS.MAX_STRING_LENGTH) {
    return { valid: false, error: fieldName + ' exceeds maximum length of ' + LIMITS.MAX_STRING_LENGTH + ' characters.' };
  }
  return { valid: true, error: null };
}

function _validateSafeString(value, fieldName) {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Invalid or missing ' + fieldName + '.' };
  }
  if (!SAFE_STRING_PATTERN.test(value)) {
    return { valid: false, error: fieldName + ' must match pattern [a-z][a-z0-9_]*, got: ' + value.slice(0, 30) };
  }
  return { valid: true, error: null };
}

function _validateInteractionInput(data) {
  const userCheck = _guardHexId(data.userId, 'userId');
  if (userCheck) return { valid: false, error: userCheck.error };

  const entityCheck = _guardHexId(data.entityId, 'entityId');
  if (entityCheck) return { valid: false, error: entityCheck.error };

  const typeCheck = _validateSafeString(data.entityType, 'entityType');
  if (!typeCheck.valid) return typeCheck;

  const sourceCheck = _validateSafeString(data.interactionSource, 'interactionSource');
  if (!sourceCheck.valid) return sourceCheck;

  if (data.entityName !== undefined && data.entityName !== null) {
    const nameCheck = _validateStringField(data.entityName, 'entityName');
    if (!nameCheck.valid) return nameCheck;
  }

  if (data.userAccessLevel === undefined || data.userAccessLevel === null || typeof data.userAccessLevel !== 'number') {
    return { valid: false, error: 'Invalid or missing userAccessLevel. Must be a number.' };
  }

  return { valid: true, error: null };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  recordInteraction                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

async function recordInteraction({
  userId,
  entityType,
  entityId,
  entityName,
  interactionSource,
  userAccessLevel,
  userBeltLevel,
  context,
  isFollowUpPending,
  followUpContext,
  isBeltCreditAwarded,
  beltCreditDomainId,
  correlationId
}) {
  const validation = _validateInteractionInput({
    userId, entityType, entityId, entityName, interactionSource, userAccessLevel
  });
  if (!validation.valid) {
    logger.warn('Interaction validation failed', { error: validation.error, correlationId });
    return { success: false, interactionId: null, isNew: false, error: validation.error };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const interactionId = await generateHexId('user_interaction_id');
    const contextJson = context ? JSON.stringify(context) : '{}';

    const sql =
      'INSERT INTO user_interaction_memory (' +
      'interaction_id, user_id, entity_type, entity_id, ' +
      'entity_name, interaction_source, user_access_level, ' +
      'user_belt_level, context, follow_up_pending, ' +
      'follow_up_context, belt_credit_awarded, ' +
      'belt_credit_domain_id, first_encountered_at, updated_at' +
      ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13, NOW(), NOW()) ' +
      'ON CONFLICT ON CONSTRAINT uq_user_entity DO UPDATE SET ' +
      'last_interacted_at = NOW(), ' +
      'updated_at = NOW(), ' +
      'interaction_count = user_interaction_memory.interaction_count + 1, ' +
      'context = user_interaction_memory.context || EXCLUDED.context, ' +
      'user_access_level = EXCLUDED.user_access_level, ' +
      'user_belt_level = EXCLUDED.user_belt_level ' +
      'RETURNING interaction_id, (xmax = 0) AS is_new_row';

    const result = await client.query(sql, [
      interactionId,
      userId,
      entityType,
      entityId,
      entityName || null,
      interactionSource,
      userAccessLevel,
      userBeltLevel ? JSON.stringify(userBeltLevel) : null,
      contextJson,
      isFollowUpPending || false,
      followUpContext ? JSON.stringify(followUpContext) : null,
      isBeltCreditAwarded || false,
      beltCreditDomainId || null
    ]);

    await client.query('COMMIT');

    const returnedId = result.rows[0].interaction_id;
    const isNew = result.rows[0].is_new_row;

    logger.info(isNew ? 'Interaction recorded' : 'Interaction updated', {
      interactionId: returnedId,
      userId,
      entityType,
      entityId,
      source: interactionSource,
      correlationId
    });

    return { success: true, interactionId: returnedId, isNew, error: null };

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to record interaction', { correlationId, error: error.message });
    return { success: false, interactionId: null, isNew: false, error: error.message };
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  recordInteractionsBatch                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

async function recordInteractionsBatch(interactions, correlationId) {
  if (!interactions || interactions.length === 0) {
    return { success: true, results: [], error: null };
  }

  if (interactions.length > LIMITS.MAX_BATCH_SIZE) {
    logger.warn('Batch size exceeds maximum', {
      received: interactions.length,
      max: LIMITS.MAX_BATCH_SIZE,
      correlationId
    });
    return {
      success: false,
      results: [],
      error: 'Batch size ' + interactions.length + ' exceeds maximum of ' + LIMITS.MAX_BATCH_SIZE
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = [];
    for (const interaction of interactions) {
      const validation = _validateInteractionInput(interaction);
      if (!validation.valid) {
        logger.warn('Batch item validation failed', {
          error: validation.error,
          correlationId,
          entityId: interaction.entityId
        });
        results.push({
          success: false,
          entityId: interaction.entityId,
          isNew: false,
          error: validation.error
        });
        continue;
      }

      const interactionId = await generateHexId('user_interaction_id');
      const contextJson = interaction.context ? JSON.stringify(interaction.context) : '{}';

      const sql =
        'INSERT INTO user_interaction_memory (' +
        'interaction_id, user_id, entity_type, entity_id, ' +
        'entity_name, interaction_source, user_access_level, ' +
        'user_belt_level, context, follow_up_pending, ' +
        'follow_up_context, belt_credit_awarded, ' +
        'belt_credit_domain_id, first_encountered_at, updated_at' +
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13, NOW(), NOW()) ' +
        'ON CONFLICT ON CONSTRAINT uq_user_entity DO UPDATE SET ' +
        'last_interacted_at = NOW(), ' +
        'updated_at = NOW(), ' +
        'interaction_count = user_interaction_memory.interaction_count + 1, ' +
        'context = user_interaction_memory.context || EXCLUDED.context, ' +
        'user_access_level = EXCLUDED.user_access_level, ' +
        'user_belt_level = EXCLUDED.user_belt_level ' +
        'RETURNING interaction_id, (xmax = 0) AS is_new_row';

      const result = await client.query(sql, [
        interactionId,
        interaction.userId,
        interaction.entityType,
        interaction.entityId,
        interaction.entityName || null,
        interaction.interactionSource,
        interaction.userAccessLevel,
        interaction.userBeltLevel ? JSON.stringify(interaction.userBeltLevel) : null,
        contextJson,
        interaction.isFollowUpPending || false,
        interaction.followUpContext ? JSON.stringify(interaction.followUpContext) : null,
        interaction.isBeltCreditAwarded || false,
        interaction.beltCreditDomainId || null
      ]);

      results.push({
        success: true,
        interactionId: result.rows[0].interaction_id,
        entityId: interaction.entityId,
        isNew: result.rows[0].is_new_row
      });
    }

    await client.query('COMMIT');

    const newCount = results.filter(r => r.isNew).length;
    const successCount = results.filter(r => r.success).length;
    logger.info('Batch interactions recorded', {
      total: interactions.length,
      successful: successCount,
      newDiscoveries: newCount,
      correlationId
    });

    return { success: true, results, error: null };

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Batch recording failed', { correlationId, error: error.message });
    return { success: false, results: [], error: error.message };
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  hasUserEncountered                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

async function hasUserEncountered(userId, entityType, entityId, correlationId) {
  const userCheck = _guardHexId(userId, 'userId');
  if (userCheck) return { encountered: false, invalid: true, error: userCheck.error };

  const entityCheck = _guardHexId(entityId, 'entityId');
  if (entityCheck) return { encountered: false, invalid: true, error: entityCheck.error };

  try {
    const result = await pool.query(
      'SELECT interaction_id, interaction_count, first_encountered_at, ' +
      'last_interacted_at, context ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3',
      [userId, entityType, entityId]
    );

    if (result.rows.length === 0) {
      return { encountered: false };
    }

    const row = result.rows[0];
    return {
      encountered: true,
      interactionId: row.interaction_id,
      count: row.interaction_count,
      firstEncountered: row.first_encountered_at,
      lastInteracted: row.last_interacted_at,
      context: row.context
    };
  } catch (error) {
    logger.error('Failed to check encounter', { userId, entityId, correlationId, error: error.message });
    return { encountered: false, error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  getUserInteractions (with safe string validation on filters)              */
/* ────────────────────────────────────────────────────────────────────────── */

async function getUserInteractions(userId, options = {}) {
  const userCheck = _guardHexId(userId, 'userId');
  if (userCheck) return { success: false, interactions: [], error: userCheck.error };

  try {
    const conditions = ['user_id = $1'];
    const params = [userId];
    let paramIndex = 2;

    if (options.entityType) {
      const typeCheck = _validateSafeString(options.entityType, 'entityType');
      if (!typeCheck.valid) {
        return { success: false, interactions: [], error: typeCheck.error };
      }
      conditions.push('entity_type = $' + paramIndex);
      params.push(options.entityType);
      paramIndex++;
    }

    if (options.source) {
      const sourceCheck = _validateSafeString(options.source, 'source');
      if (!sourceCheck.valid) {
        return { success: false, interactions: [], error: sourceCheck.error };
      }
      conditions.push('interaction_source = $' + paramIndex);
      params.push(options.source);
      paramIndex++;
    }

    const limit = Math.min(parseInt(options.limit, 10) || LIMITS.DEFAULT_QUERY, LIMITS.MAX_QUERY);
    const offset = parseInt(options.offset, 10) || 0;

    params.push(limit);
    const limitIndex = paramIndex;
    paramIndex++;

    params.push(offset);
    const offsetIndex = paramIndex;

    const sql =
      'SELECT interaction_id, entity_type, entity_id, entity_name, ' +
      'interaction_source, user_access_level, user_belt_level, ' +
      'first_encountered_at, last_interacted_at, interaction_count, ' +
      'context, follow_up_pending, follow_up_context, ' +
      'belt_credit_awarded, belt_credit_domain_id, updated_at ' +
      'FROM user_interaction_memory ' +
      'WHERE ' + conditions.join(' AND ') + ' ' +
      'ORDER BY last_interacted_at DESC ' +
      'LIMIT $' + limitIndex + ' OFFSET $' + offsetIndex;

    const result = await pool.query(sql, params);
    return { success: true, interactions: result.rows, error: null };
  } catch (error) {
    logger.error('Failed to get user interactions', { correlationId: options.correlationId, error: error.message });
    return { success: false, interactions: [], error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  getSessionInteractions                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

async function getSessionInteractions(userId, sessionStartedAt, limit, correlationId) {
  const userCheck = _guardHexId(userId, 'userId');
  if (userCheck) return { success: false, interactions: [], error: userCheck.error };

  const queryLimit = Math.min(parseInt(limit, 10) || LIMITS.DEFAULT_QUERY, LIMITS.MAX_QUERY);

  try {
    const result = await pool.query(
      'SELECT interaction_id, entity_type, entity_id, entity_name, ' +
      'interaction_source, first_encountered_at, last_interacted_at, ' +
      'interaction_count, context ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND last_interacted_at >= $2 ' +
      'ORDER BY last_interacted_at DESC LIMIT $3',
      [userId, sessionStartedAt, queryLimit]
    );

    return { success: true, interactions: result.rows, error: null };
  } catch (error) {
    logger.error('Failed to get session interactions', { correlationId, error: error.message });
    return { success: false, interactions: [], error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  getInteractionSummary (parallel queries in read-only transaction)         */
/* ────────────────────────────────────────────────────────────────────────── */

async function getInteractionSummary(userId, correlationId) {
  const userCheck = _guardHexId(userId, 'userId');
  if (userCheck) return { success: false, summary: null, error: userCheck.error };

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const countsByType = await client.query(
      'SELECT entity_type, COUNT(*) AS total, ' +
      'SUM(interaction_count) AS total_interactions ' +
      'FROM user_interaction_memory WHERE user_id = $1 ' +
      'GROUP BY entity_type ORDER BY total DESC',
      [userId]
    );

    const recentDiscoveries = await client.query(
      'SELECT entity_type, entity_id, entity_name, interaction_source, ' +
      'first_encountered_at ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND interaction_count = 1 ' +
      'ORDER BY first_encountered_at DESC LIMIT $2',
      [userId, LIMITS.DEFAULT_DISCOVERY]
    );

    const pendingFollowUps = await client.query(
      'SELECT interaction_id, entity_type, entity_id, entity_name, ' +
      'follow_up_context ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND follow_up_pending = TRUE ' +
      'ORDER BY last_interacted_at DESC',
      [userId]
    );

    const beltCredits = await client.query(
      'SELECT belt_credit_domain_id, COUNT(*) AS credits ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND belt_credit_awarded = TRUE ' +
      'GROUP BY belt_credit_domain_id',
      [userId]
    );



    await client.query('COMMIT');

    return {
      success: true,
      summary: {
        entityCounts: countsByType.rows,
        recentDiscoveries: recentDiscoveries.rows,
        pendingFollowUps: pendingFollowUps.rows,
        beltCredits: beltCredits.rows,
        totalEntitiesEncountered: countsByType.rows.reduce(
          (sum, r) => sum + parseInt(r.total, 10), 0
        )
      },
      error: null
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to build interaction summary', { correlationId, error: error.message });
    return { success: false, summary: null, error: error.message };
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  getPendingFollowUps                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function getPendingFollowUps(userId, limit, correlationId) {
  const userCheck = _guardHexId(userId, 'userId');
  if (userCheck) return { success: false, followUps: [], error: userCheck.error };

  const queryLimit = Math.min(parseInt(limit, 10) || LIMITS.DEFAULT_FOLLOW_UP, LIMITS.MAX_QUERY);

  try {
    const result = await pool.query(
      'SELECT interaction_id, entity_type, entity_id, entity_name, ' +
      'follow_up_context, first_encountered_at, last_interacted_at ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND follow_up_pending = TRUE ' +
      'ORDER BY last_interacted_at DESC LIMIT $2',
      [userId, queryLimit]
    );

    return { success: true, followUps: result.rows, error: null };
  } catch (error) {
    logger.error('Failed to get pending follow-ups', { correlationId, error: error.message });
    return { success: false, followUps: [], error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  resolveFollowUp                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

async function resolveFollowUp(interactionId, correlationId) {
  const idCheck = _guardHexId(interactionId, 'interactionId');
  if (idCheck) return { success: false, error: idCheck.error };

  try {
    await pool.query(
      'UPDATE user_interaction_memory ' +
      'SET follow_up_pending = FALSE, follow_up_resolved_at = NOW(), updated_at = NOW() ' +
      'WHERE interaction_id = $1',
      [interactionId]
    );

    logger.info('Follow-up resolved', { interactionId, correlationId });
    return { success: true, error: null };
  } catch (error) {
    logger.error('Failed to resolve follow-up', { correlationId, error: error.message });
    return { success: false, error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  setFollowUp                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

async function setFollowUp(interactionId, followUpContext, correlationId) {
  const idCheck = _guardHexId(interactionId, 'interactionId');
  if (idCheck) return { success: false, error: idCheck.error };

  try {
    await pool.query(
      'UPDATE user_interaction_memory ' +
      'SET follow_up_pending = TRUE, follow_up_context = $1::jsonb, updated_at = NOW() ' +
      'WHERE interaction_id = $2',
      [JSON.stringify(followUpContext), interactionId]
    );

    logger.info('Follow-up set', { interactionId, correlationId });
    return { success: true, error: null };
  } catch (error) {
    logger.error('Failed to set follow-up', { correlationId, error: error.message });
    return { success: false, error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  awardBeltCredit                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

async function awardBeltCredit(interactionId, domainId, correlationId) {
  const idCheck = _guardHexId(interactionId, 'interactionId');
  if (idCheck) return { success: false, error: idCheck.error };

  const domainCheck = _guardHexId(domainId, 'domainId');
  if (domainCheck) return { success: false, error: domainCheck.error };

  try {
    const result = await pool.query(
      'UPDATE user_interaction_memory ' +
      'SET belt_credit_awarded = TRUE, belt_credit_domain_id = $1, updated_at = NOW() ' +
      'WHERE interaction_id = $2 AND belt_credit_awarded = FALSE ' +
      'RETURNING interaction_id',
      [domainId, interactionId]
    );

    if (result.rows.length === 0) {
      logger.warn('Belt credit already awarded or interaction not found', {
        interactionId, domainId, correlationId
      });
      return { success: false, error: 'Already awarded or not found.' };
    }

    logger.info('Belt credit awarded', { interactionId, domainId, correlationId });
    return { success: true, error: null };
  } catch (error) {
    logger.error('Failed to award belt credit', { correlationId, error: error.message });
    return { success: false, error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  getRecentDiscoveries                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function getRecentDiscoveries(userId, limit, correlationId) {
  const userCheck = _guardHexId(userId, 'userId');
  if (userCheck) return { success: false, discoveries: [], error: userCheck.error };

  const queryLimit = Math.min(parseInt(limit, 10) || LIMITS.DEFAULT_DISCOVERY, LIMITS.MAX_QUERY);

  try {
    const result = await pool.query(
      'SELECT entity_type, entity_id, entity_name, ' +
      'interaction_source, first_encountered_at, context ' +
      'FROM user_interaction_memory ' +
      'WHERE user_id = $1 AND interaction_count = 1 ' +
      'ORDER BY first_encountered_at DESC LIMIT $2',
      [userId, queryLimit]
    );

    return { success: true, discoveries: result.rows, error: null };
  } catch (error) {
    logger.error('Failed to get recent discoveries', { correlationId, error: error.message });
    return { success: false, discoveries: [], error: error.message };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export {
  recordInteraction,
  recordInteractionsBatch,
  hasUserEncountered,
  getUserInteractions,
  getSessionInteractions,
  getInteractionSummary,
  getPendingFollowUps,
  resolveFollowUp,
  setFollowUp,
  awardBeltCredit,
  getRecentDiscoveries
};
