/**
 * ============================================================================
 * taughtEntityCapturer.js — User-Taught Entity Capture Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * General service for capturing anything the user teaches Claude about
 * their real world (PERSON, PET, LOCATION, INSTITUTION, ACTIVITY, SLANG,
 * OBJECT). This is the core engine for the User-Taught Entity Discovery
 * System (Goal 3).
 *
 * Mirrors learningCapturer.js exactly for consistency and maintainability.
 *
 * HOW IT WORKS
 * ------------
 * 1. CAPTURE (captureEntity):
 *    - Called after referenceDetector + consent gate
 *    - Enforces 50-entity hard cap with eviction
 *    - Calculates emotional_weight from PAD coordinates
 *    - Bridges SLANG to learningCapturer via language_id FK
 *    - Sets moderation_flag, parsing_flag, last_confirmed_at
 *    - Records question_template_id for A/B testing
 *    - Hex ID generated inside transaction (mandatory)
 *
 * 2. DUPLICATE DETECTION (hasEntity):
 *    - Normalised name lookup (lowercase, strip punctuation, collapse whitespace)
 *    - "Max!" and "max" match as duplicates
 *
 * 3. RETRIEVE (getUserEntities):
 *    - Returns entities a user has taught Claude
 *    - Filterable by entity_type
 *    - Paginated with configurable limit and offset
 *    - Ordered by confidence and reference count
 *
 * 4. RECALL SUPPORT (findByName, recordReference):
 *    - Fuzzy trigram + phonetic matching for natural recall
 *    - Updates times_referenced and last_referenced_at
 *
 * 5. FORGET (forgetEntity):
 *    - Soft delete (forgotten = true, forgotten_at = NOW())
 *    - Preserves audit trail — never hard deletes
 *
 * 6. RECONFIRMATION (findStaleEntities, confirmEntity):
 *    - Finds entities not confirmed in 90+ days
 *    - Updates last_confirmed_at with slight emotional_weight boost
 *    - Enables gentle reconfirmation dialogue
 *
 * MEMORY BUDGET
 * -------------
 * MAX_ENTITIES_PER_USER = 50
 * Eviction: oldest entity with times_referenced = 0 AND confidence_level = 1
 * If no eviction candidates: system warns user via PhaseVoice
 *
 * SLANG BRIDGE
 * ------------
 * If entity_type === 'SLANG', automatically calls learningCapturer.captureTeaching
 * and populates language_id FK. This keeps vocabulary data in cotw_user_language
 * while entity metadata lives in cotw_user_taught_entities.
 * FSRS data is never contaminated.
 *
 * PREFERRED NAME
 * --------------
 * preferred_name stores user-preferred nicknames (e.g., "Maxy" for
 * entity_name "Max"). Used in recall phrasing and falls back to
 * entity_name when NULL. Enables rename without breaking the
 * uniqueness constraint on (user_id, entity_name_normalized).
 *
 * EMOTIONAL WEIGHT
 * ----------------
 * Calculated from PAD pleasure coordinate at capture time.
 * Range: 1.0 (neutral/negative) to 1.3 (high pleasure).
 * Used in freshness scoring for recall priority.
 *
 * OBSERVABILITY
 * -------------
 * 14 structured events via createModuleLogger('TaughtEntityCapturer')
 * See canonical spec Section 10 for full event catalog.
 *
 * TRANSACTION DISCIPLINE
 * ----------------------
 * Hex ID generation and INSERT happen inside the SAME database
 * transaction per the hexIdGenerator.js contract. If the INSERT fails,
 * the transaction rolls back and the hex counter is not consumed.
 *
 * DATABASE TABLE: cotw_user_taught_entities
 * -----------------------------------------
 * 33 columns, 11 indexes, 7 CHECK constraints, 2 foreign keys.
 * Hex range: #F10000 to #F1FFFF (user_taught_entity_id)
 * See canonical spec Section 7 for full column documentation.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: TaughtEntityCapturer (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import generateHexId from '../utils/hexIdGenerator.js';
import { createModuleLogger } from '../utils/logger.js';
import learningCapturer from './learningCapturer.js';

const logger = createModuleLogger('TaughtEntityCapturer');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const MAX_ENTITIES_PER_USER = 50;
const INITIAL_CONFIDENCE = 1;
const MAX_CONFIDENCE = 5;
const MIN_CONFIDENCE = 1;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const MAX_ENTITY_NAME_LENGTH = 100;
const MAX_EXPLANATION_LENGTH = 500;

const EMOTIONAL_WEIGHT_MIN = 1.0;
const EMOTIONAL_WEIGHT_MAX = 1.3;
const EMOTIONAL_WEIGHT_BOOST = 0.1;

const STALE_DAYS_DEFAULT = 90;

/* ────────────────────────────────────────────────────────────────────────── */
/*  TaughtEntityCapturer Class                                                */
/* ────────────────────────────────────────────────────────────────────────── */

class TaughtEntityCapturer {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Normalise Name                                                 */
  /*                                                                          */
  /*  Produces a canonical form for duplicate detection.                      */
  /*  Lowercase, strip non-alphanumeric (keep spaces), collapse whitespace.  */
  /* ──────────────────────────────────────────────────────────────────────── */

  _normaliseName(name) {
    if (typeof name !== 'string') return '';
    return name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Calculate Emotional Weight                                     */
  /*                                                                          */
  /*  Derives recall priority weight from PAD pleasure coordinate.            */
  /*  Higher pleasure at capture time = stronger recall priority.             */
  /*  Range: 1.0 (neutral/negative) to 1.3 (high pleasure).                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateEmotionalWeight(padCoordinates) {
    if (!padCoordinates || typeof padCoordinates.p !== 'number' || typeof padCoordinates.a !== 'number' || typeof padCoordinates.d !== 'number') {
      return EMOTIONAL_WEIGHT_MIN;
    }
    const raw = EMOTIONAL_WEIGHT_MIN + (padCoordinates.p * 0.3);
    return Math.min(Math.max(raw, EMOTIONAL_WEIGHT_MIN), EMOTIONAL_WEIGHT_MAX);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Validate Entity Name                                           */
  /*                                                                          */
  /*  Enforces length limit and basic sanitisation.                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  _validateEntityName(name) {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ENTITY_NAME_LENGTH) return null;
    return trimmed;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Validate Explanation                                           */
  /*                                                                          */
  /*  Enforces length limit on user explanation text.                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _validateExplanation(explanation) {
    if (!explanation || typeof explanation !== 'string') return null;
    const trimmed = explanation.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, MAX_EXPLANATION_LENGTH);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Enforce Memory Budget                                          */
  /*                                                                          */
  /*  Checks entity count for user. If at or above cap, evicts the            */
  /*  oldest entity with zero references and lowest confidence.               */
  /*  Returns true if space was made, false if no eviction candidates.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _enforceMemoryBudget(userId, client) {
    const countResult = await client.query(
      'SELECT COUNT(*) as count FROM cotw_user_taught_entities WHERE user_id = $1 AND forgotten = false',
      [userId]
    );
    const count = parseInt(countResult.rows[0].count, 10);

    if (count < MAX_ENTITIES_PER_USER) return true;

    const evicted = await client.query(`
      UPDATE cotw_user_taught_entities
      SET forgotten = true, forgotten_at = NOW()
      WHERE entity_id = (
        SELECT entity_id FROM cotw_user_taught_entities
        WHERE user_id = $1 AND forgotten = false
          AND times_referenced = 0 AND confidence_level = 1
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING entity_id, entity_name
    `, [userId]);

    if (evicted.rows.length > 0) {
      logger.info('entity.cap_reached', {
        userId,
        entityCount: count,
        evictedId: evicted.rows[0].entity_id,
        evictedName: evicted.rows[0].entity_name
      });
      return true;
    }

    logger.warn('entity.cap_reached', {
      userId,
      entityCount: count,
      evictionFailed: true
    });
    return false;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Find By Normalised Name                                        */
  /*                                                                          */
  /*  Internal lookup using the entity_name_normalized column.                */
  /*  Returns the existing row or null. Excludes forgotten entities.          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _findByNormalisedName(userId, normalised, client = null) {
    if (!userId || !normalised) return null;

    try {
      const db = client || pool;
      const result = await db.query(`
        SELECT entity_id, dossier_id, user_id, entity_name,
               entity_name_normalized, entity_type, relationship_type,
               attributes, preferred_name, confidence_level,
               times_referenced, last_referenced_at, created_at
        FROM cotw_user_taught_entities
        WHERE user_id = $1
          AND entity_name_normalized = $2
          AND forgotten = false
        LIMIT 1
      `, [userId, normalised]);

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to check normalised name', {
        userId,
        error: error.message
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Capture Entity                                                  */
  /*                                                                          */
  /*  Stores a user-taught entity in cotw_user_taught_entities.               */
  /*  Hex ID generation and INSERT are wrapped in a single transaction        */
  /*  per the hexIdGenerator contract.                                        */
  /*                                                                          */
  /*  Checks for duplicates before inserting. Returns existing row if         */
  /*  the normalised name already exists for this user.                       */
  /*                                                                          */
  /*  If entity_type is SLANG, bridges to learningCapturer to also            */
  /*  populate cotw_user_language with the vocabulary entry.                  */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {string} dossierId — User's COTW Dossier hex ID                 */
  /*  @param {object} entityData — Entity details                             */
  /*  @param {string} entityData.entity_name — Name of the entity            */
  /*  @param {string} entityData.entity_type — PERSON/PET/LOCATION/etc       */
  /*  @param {string} [entityData.relationship_type] — OWNER/FRIEND/etc      */
  /*  @param {object} [entityData.attributes] — Type-specific JSONB          */
  /*  @param {string} [entityData.original_explanation] — User's words       */
  /*  @param {string} [entityData.context] — Conversational context          */
  /*  @param {object} [entityData.padCoordinates] — PAD at capture time      */
  /*  @param {string} [entityData.parsing_flag] — Parse quality flag         */
  /*  @param {string} [entityData.discovery_source] — How entity was found   */
  /*  @param {string} [entityData.moderation_flag] — Content flag            */
  /*  @param {string} [entityData.preferred_name] — User nickname            */
  /*  @param {string} [entityData.question_template_id] — A/B template ID   */
  /*  @param {string} [entityData.entity_origin] — user_world or in_world   */
  /*  @returns {object} Inserted or existing row data                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async captureEntity(userId, dossierId, entityData) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('TaughtEntityCapturer: userId is required');
    }
    if (!dossierId || typeof dossierId !== 'string') {
      throw new Error('TaughtEntityCapturer: dossierId is required');
    }

    const validName = this._validateEntityName(entityData?.entity_name);
    if (!validName) {
      throw new Error('TaughtEntityCapturer: entity_name is required (1-100 chars)');
    }

    if (!entityData?.entity_type) {
      throw new Error('TaughtEntityCapturer: entity_type is required');
    }

    const normalised = this._normaliseName(validName);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await this._findByNormalisedName(userId, normalised, client);
      if (existing) {
        await client.query('ROLLBACK');
        logger.debug('Entity already taught, skipping duplicate', {
          userId,
          entityId: existing.entity_id,
          name: validName.slice(0, 50)
        });

      if (entityData.entity_type === 'SLANG') {
        try {
          const slangResult = await learningCapturer.captureTeaching(userId, {
            phrase: validName,
            baseConcept: validExplanation,
            context: entityData.context || null,
            padCoordinates: entityData.padCoordinates || null
          });
          if (slangResult?.language_id) {
            await pool.query(
              'UPDATE cotw_user_taught_entities SET language_id = $1, updated_at = NOW() WHERE entity_id = $2',
              [slangResult.language_id, entityId]
            );
            result.rows[0].language_id = slangResult.language_id;
          }
        } catch (slangError) {
          logger.warn('SLANG bridge failed, entity stored without language_id', {
            userId,
            entityId,
            error: slangError.message
          });
        }
      }
        return existing;
      }

      const budgetOk = await this._enforceMemoryBudget(userId, client);
      if (!budgetOk) {
        await client.query('ROLLBACK');
        logger.warn('Memory budget full, no eviction candidates', { userId });
        return null;
      }

      const entityId = await generateHexId('user_taught_entity_id');

      const emotionalWeight = this._calculateEmotionalWeight(
        entityData.padCoordinates
      );

      const validExplanation = this._validateExplanation(
        entityData.original_explanation
      );

      const result = await client.query(`
        INSERT INTO cotw_user_taught_entities (
          entity_id, dossier_id, user_id,
          entity_name, entity_name_normalized,
          entity_type, relationship_type, attributes, entity_origin,
          original_explanation, context, pad_coordinates,
          emotional_weight, parsing_flag, confidence_level,
          consent_given, consent_timestamp, last_confirmed_at,
          discovery_source, moderation_flag,
          language_id, preferred_name, question_template_id,
          phonetic_soundex, phonetic_metaphone,
          phonetic_dmetaphone, phonetic_dmetaphone_alt
        ) VALUES (
          $1, $2, $3,
          $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14, $15,
          true, NOW(), NOW(),
          $16, $17,
          $18, $19, $20,
          soundex($4), metaphone($4, 10),
          dmetaphone($4), dmetaphone_alt($4)
        )
        RETURNING entity_id, dossier_id, user_id, entity_name,
                  entity_name_normalized, entity_type, relationship_type,
                  attributes, preferred_name, confidence_level,
                  emotional_weight, consent_given, created_at
      `, [
        entityId, dossierId, userId,
        validName, normalised,
        entityData.entity_type,
        entityData.relationship_type || null,
        JSON.stringify(entityData.attributes || {}),
        entityData.entity_origin || 'user_world',
        validExplanation,
        entityData.context ? String(entityData.context).slice(0, 500) : null,
        entityData.padCoordinates
          ? JSON.stringify(entityData.padCoordinates)
          : null,
        emotionalWeight,
        entityData.parsing_flag || 'clean',
        INITIAL_CONFIDENCE,
        entityData.discovery_source || 'user_taught',
        entityData.moderation_flag || 'clean',
        null,
        entityData.preferred_name
          ? String(entityData.preferred_name).trim().slice(0, 200)
          : null,
        entityData.question_template_id || null
      ]);

      await client.query('COMMIT');

      logger.info('entity.stored', {
        userId,
        entityId,
        entityType: entityData.entity_type,
        confidence: INITIAL_CONFIDENCE,
        moderationFlag: entityData.moderation_flag || 'clean',
        name: validName.slice(0, 50)
      });

      if (entityData.entity_type === 'SLANG') {
        try {
          const slangResult = await learningCapturer.captureTeaching(userId, {
            phrase: validName,
            baseConcept: validExplanation,
            context: entityData.context || null,
            padCoordinates: entityData.padCoordinates || null
          });
          if (slangResult?.language_id) {
            await pool.query(
              'UPDATE cotw_user_taught_entities SET language_id = $1, updated_at = NOW() WHERE entity_id = $2',
              [slangResult.language_id, entityId]
            );
            result.rows[0].language_id = slangResult.language_id;
          }
        } catch (slangError) {
          logger.warn('SLANG bridge failed, entity stored without language_id', {
            userId,
            entityId,
            error: slangError.message
          });
        }
      }

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to capture entity', {
        userId,
        name: entityData?.entity_name?.slice(0, 50),
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Check If Entity Already Taught                                  */
  /*                                                                          */
  /*  Public interface for duplicate detection using normalised name.          */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {string} entityName — Entity name to check                      */
  /*  @returns {boolean} true if already taught                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  async hasEntity(userId, entityName) {
    if (!userId || !entityName) return false;
    const normalised = this._normaliseName(entityName);
    const existing = await this._findByNormalisedName(userId, normalised);
    return existing !== null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get User Entities                                               */
  /*                                                                          */
  /*  Retrieves entities a user has taught Claude, ordered by confidence      */
  /*  and reference count. Paginated with configurable limit and offset.      */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {object} [options] — Query options                               */
  /*  @param {string} [options.entityType] — Filter by type                  */
  /*  @param {number} [options.limit=50] — Max rows (1-200)                  */
  /*  @param {number} [options.offset=0] — Pagination offset                 */
  /*  @returns {Array} Entity rows                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getUserEntities(userId, options = {}) {
    if (!userId || typeof userId !== 'string') return [];

    const limit = Math.max(1, Math.min(
      typeof options.limit === 'number' ? options.limit : DEFAULT_PAGE_LIMIT,
      MAX_PAGE_LIMIT
    ));
    const offset = Math.max(0,
      typeof options.offset === 'number' ? options.offset : 0
    );

    try {
      const values = [userId];
      let paramIndex = 2;

      let query = `
        SELECT entity_id, dossier_id, user_id, entity_name,
               entity_name_normalized, entity_type, relationship_type,
               attributes, entity_origin, preferred_name,
               confidence_level, emotional_weight,
               times_referenced, last_referenced_at, last_confirmed_at,
               consent_given, created_at
        FROM cotw_user_taught_entities
        WHERE user_id = $1
          AND forgotten = false
      `;

      if (options.entityType) {
        query += ` AND entity_type = $${paramIndex}`;
        values.push(options.entityType);
        paramIndex++;
      }

      query += ` ORDER BY confidence_level DESC, times_referenced DESC NULLS LAST`;
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      values.push(limit, offset);

      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      logger.error('Failed to retrieve user entities', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Entity Count                                                */
  /*                                                                          */
  /*  Returns total count of taught entities for a user (non-forgotten).      */
  /*  Used for memory budget checks and admin diagnostics.                    */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @returns {number} Total entity count                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getEntityCount(userId) {
    if (!userId) return 0;

    try {
      const result = await pool.query(`
        SELECT COUNT(*) as count
        FROM cotw_user_taught_entities
        WHERE user_id = $1
          AND forgotten = false
      `, [userId]);

      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error('Failed to count user entities', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Record Reference                                                */
  /*                                                                          */
  /*  Records when Claude references a taught entity in conversation.         */
  /*  Updates reference count and timestamp for freshness scoring.            */
  /*                                                                          */
  /*  @param {string} entityId — Hex ID of the taught entity                 */
  /*  @returns {object|null} Updated row or null if not found                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async recordReference(entityId) {
    if (!entityId || typeof entityId !== 'string') {
      throw new Error('TaughtEntityCapturer: entityId is required');
    }

    try {
      const result = await pool.query(`
        UPDATE cotw_user_taught_entities
        SET times_referenced = times_referenced + 1,
            last_referenced_at = NOW(),
            updated_at = NOW()
        WHERE entity_id = $1
          AND forgotten = false
        RETURNING entity_id, entity_name, preferred_name,
                  times_referenced, last_referenced_at
      `, [entityId]);

      if (result.rows.length === 0) {
        logger.warn('Recording reference for unknown entity_id', { entityId });
        return null;
      }

      logger.debug('entity.recalled', {
        entityId,
        timesReferenced: result.rows[0].times_referenced
      });

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to record reference', {
        entityId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Forget Entity                                                   */
  /*                                                                          */
  /*  Soft deletes an entity (sets forgotten = true, forgotten_at = NOW()).   */
  /*  Never hard deletes — preserves audit trail for GDPR compliance.        */
  /*                                                                          */
  /*  @param {string} entityId — Hex ID of the taught entity                 */
  /*  @returns {object|null} Forgotten entity name or null                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async forgetEntity(entityId) {
    if (!entityId || typeof entityId !== 'string') {
      throw new Error('TaughtEntityCapturer: entityId is required');
    }

    try {
      const result = await pool.query(`
        UPDATE cotw_user_taught_entities
        SET forgotten = true,
            forgotten_at = NOW(),
            updated_at = NOW()
        WHERE entity_id = $1
          AND forgotten = false
        RETURNING entity_id, entity_name
      `, [entityId]);

      if (result.rows.length === 0) {
        logger.warn('Forget requested for unknown or already forgotten entity', {
          entityId
        });
        return null;
      }

      logger.info('entity.forgotten', {
        entityId,
        entityName: result.rows[0].entity_name
      });

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to forget entity', {
        entityId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Find By Name (Fuzzy — for Recall)                               */
  /*                                                                          */
  /*  Fuzzy lookup for entity recall during conversation. Uses trigram        */
  /*  similarity and phonetic matching. Returns best match or null.           */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {string} name — Name token from user input                      */
  /*  @returns {object|null} Best matching entity or null                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async findByName(userId, name) {
    if (!userId || !name) return null;
    const normalised = this._normaliseName(name);
    if (!normalised) return null;

    try {
      const result = await pool.query(`
        SELECT entity_id, dossier_id, user_id, entity_name,
               entity_name_normalized, entity_type, relationship_type,
               attributes, preferred_name, confidence_level,
               emotional_weight, times_referenced, last_referenced_at,
               similarity(entity_name_normalized, $2) as match_score
        FROM cotw_user_taught_entities
        WHERE user_id = $1
          AND forgotten = false
          AND (
            entity_name_normalized = $2
            OR entity_name_normalized % $2
            OR phonetic_soundex = soundex($3)
            OR phonetic_metaphone = metaphone($3, 10)
          )
        ORDER BY similarity(entity_name_normalized, $2) DESC
        LIMIT 1
      `, [userId, normalised, name]);

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to fuzzy find entity', {
        userId,
        name: name.slice(0, 50),
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Find Stale Entities                                             */
  /*                                                                          */
  /*  Finds entities that have not been confirmed in a given number of        */
  /*  days. Used to trigger gentle reconfirmation dialogue.                   */
  /*  Only returns entities that have been referenced at least once           */
  /*  (no point reconfirming entities Claude never mentioned).               */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {number} [daysThreshold=90] — Days since last confirmation      */
  /*  @returns {object|null} Oldest stale entity or null                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async findStaleEntities(userId, daysThreshold = STALE_DAYS_DEFAULT) {
    if (!userId) return null;

    try {
      const result = await pool.query(`
        SELECT entity_id, entity_name, preferred_name, entity_type,
               relationship_type, last_confirmed_at, times_referenced
        FROM cotw_user_taught_entities
        WHERE user_id = $1
          AND forgotten = false
          AND times_referenced > 0
          AND (
            last_confirmed_at IS NULL
            OR last_confirmed_at < NOW() - make_interval(days => $2)
          )
        ORDER BY last_confirmed_at ASC NULLS FIRST
        LIMIT 1
      `, [userId, daysThreshold]);

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to find stale entities', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Confirm Entity                                                  */
  /*                                                                          */
  /*  Updates last_confirmed_at when user reconfirms an entity is still       */
  /*  valid. Provides a slight emotional_weight boost for the bond            */
  /*  strengthening signal.                                                   */
  /*                                                                          */
  /*  @param {string} entityId — Hex ID of the taught entity                 */
  /*  @returns {object|null} Updated row or null                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  async confirmEntity(entityId) {
    if (!entityId || typeof entityId !== 'string') {
      throw new Error('TaughtEntityCapturer: entityId is required');
    }

    try {
      const result = await pool.query(`
        UPDATE cotw_user_taught_entities
        SET last_confirmed_at = NOW(),
            emotional_weight = LEAST(
              emotional_weight + $2,
              $3
            ),
            updated_at = NOW()
        WHERE entity_id = $1
          AND forgotten = false
        RETURNING entity_id, entity_name, preferred_name,
                  last_confirmed_at, emotional_weight
      `, [entityId, EMOTIONAL_WEIGHT_BOOST, EMOTIONAL_WEIGHT_MAX]);

      if (result.rows.length === 0) {
        logger.warn('Confirm requested for unknown or forgotten entity', {
          entityId
        });
        return null;
      }

      logger.debug('Entity confirmed', {
        entityId,
        newWeight: result.rows[0].emotional_weight
      });

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to confirm entity', {
        entityId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Display Name                                                */
  /*                                                                          */
  /*  Returns preferred_name if set, otherwise entity_name.                   */
  /*  Used by recall phrasing in PhaseVoice.                                  */
  /*                                                                          */
  /*  @param {object} entity — Entity row from database                      */
  /*  @returns {string} Display name for Claude to use                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  getDisplayName(entity) {
    if (!entity) return '';
    return entity.preferred_name || entity.entity_name || '';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Confidence Label                                            */
  /*                                                                          */
  /*  Translates a confidence level into a human-readable trust label.        */
  /*  Used by Claude's response generation to calibrate how he references    */
  /*  taught entities.                                                        */
  /*                                                                          */
  /*  @param {number} confidenceLevel — 1-5                                   */
  /*  @returns {string} Trust label                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  getConfidenceLabel(confidenceLevel) {
    switch (confidenceLevel) {
      case 1: return 'just learned';
      case 2: return 'tentatively understood';
      case 3: return 'reasonably confident';
      case 4: return 'well understood';
      case 5: return 'fully trusted';
      default: return 'unknown';
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new TaughtEntityCapturer();
