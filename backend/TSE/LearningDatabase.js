/**
 * =============================================================================
 * LearningDatabase — Data Access Layer for TSE Learning Tables
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Pure data access layer for the Teaching Session Engine (TSE). Handles all
 * database operations for learning cycles, task attempts, teacher records,
 * student records, and due item retrieval.
 *
 * This is NOT a business logic layer. It runs SQL and returns results.
 *
 * PROTECTION CONTRACT:
 * ---------------------------------------------------------------------------
 * This module has NO internal human-only guards. All callers MUST enforce
 * human-only checks BEFORE calling these methods. TSELoopManager provides
 * this guard via runOrContinueTseSession().
 *
 * FSRS data accessed here must remain mathematically pure. No B-Roll
 * character data may flow through these methods.
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TSELoopManager.js — instantiates at line 190, calls:
 *     - createTseCycle (line 703)
 *     - createTeacherRecord (line 773)
 *     - createStudentRecord (line 811)
 *     - completeCycle (lines 1031, 1064)
 *
 *   TeacherComponent.js, StudentComponent.js — expected to call:
 *     - getDueItems
 *     - saveTaskAttempt
 *
 * TRANSACTION SUPPORT:
 * ---------------------------------------------------------------------------
 * Every public method accepts an optional { client } parameter. When a
 * caller passes a transactional client, the method uses it instead of
 * the pool. This allows atomic multi-step operations (e.g. create cycle +
 * teacher record + student record in one transaction).
 *
 * When no client is passed, methods use the pool directly (auto-commit).
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger with createModuleLogger (no console.log)
 *   - Counters on every public method (.success and .error variants)
 *   - Input validation on all hex IDs via isValidHexId
 *   - Positive integer validation on sequence parameters
 *   - Frozen constants
 *   - Correlation ID threading via options parameter (null when absent)
 *   - Score normalization clamped to 0-1 range
 *   - Query execution via _query helper with labeled timeout protection
 *
 * METHODS:
 * ---------------------------------------------------------------------------
 *   saveTaskAttempt({ characterId, knowledgeId, taskId, attemptText,
 *                     taskType, taskPhase, score }, opts)
 *   getDueItems(characterId, limit, focusDomain, opts)
 *   createTseCycle(characterId, query, domainId, opts)
 *   createTeacherRecord({ cycleId, teacherSequence, algorithmId,
 *                         algorithmVersion, inputParameters }, opts)
 *   createStudentRecord({ cycleId, teacherRecordId, studentSequence }, opts)
 *   completeCycle({ cycleId, evaluations }, opts)
 *
 * =============================================================================
 */

import generateHexId, { isValidHexId } from '../utils/hexIdGenerator.js';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import Counters from '../councilTerminal/metrics/counters.js';

/* ==========================================================================
 * Constants
 * ========================================================================== */

const MODULE_NAME = 'LearningDatabase';

const DEFAULTS = Object.freeze({
  TASK_TYPE: 'unknown',
  TASK_PHASE: 'practice',
  TEACHER_SEQUENCE: 1,
  STUDENT_SEQUENCE: 1,
  ALGORITHM_ID: 'TeacherComponent',
  ALGORITHM_VERSION: 'v010',
  DUE_ITEMS_LIMIT: 5,
  QUERY_TIMEOUT_MS: 8000
});

const CYCLE_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed'
});

const logger = createModuleLogger(MODULE_NAME);

/* ==========================================================================
 * LearningDatabase Class
 * ========================================================================== */

export default class LearningDatabase {

  /**
   * @param {object} dbPool — PostgreSQL pool instance
   */
  constructor(dbPool = pool) {
    this.pool = dbPool;
  }

  /* ========================================================================
   * Internal: Query Helper
   * ======================================================================== */

  /**
   * Execute a query with optional client and labeled timeout protection.
   * If opts.client is provided, uses it (for transactions).
   * Otherwise uses pool directly (auto-commit).
   *
   * @param {string} sql — parameterised SQL string
   * @param {Array} params — query parameters
   * @param {object} opts — { client, correlationId }
   * @param {string} methodLabel — calling method name for timeout diagnostics
   * @returns {object} query result
   */
  async _query(sql, params = [], opts = {}, methodLabel = 'unknown') {
    const executor = opts.client || this.pool;
    const timeoutMs = DEFAULTS.QUERY_TIMEOUT_MS;

    const queryPromise = executor.query(sql, params);
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `${MODULE_NAME}.${methodLabel}: query timeout after ${timeoutMs}ms`
        ));
      }, timeoutMs);
      queryPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
    });

    return Promise.race([queryPromise, timeoutPromise]);
  }

  /* ========================================================================
   * Input Validation
   * ======================================================================== */

  /**
   * Validate a hex ID parameter. Throws if invalid.
   * @param {string} value — the hex ID to validate
   * @param {string} name — parameter name for error messages
   */
  _validateHexId(value, name) {
    if (!value || !isValidHexId(value)) {
      throw new Error(
        `${MODULE_NAME}: invalid ${name} — expected #XXXXXX hex format, got: ${value}`
      );
    }
  }

  /**
   * Validate a positive integer parameter. Throws if invalid.
   * @param {number} value — the value to validate
   * @param {string} name — parameter name for error messages
   */
  _validatePositiveInt(value, name) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `${MODULE_NAME}: ${name} must be a positive integer, got: ${value}`
      );
    }
  }

  /* ========================================================================
   * Public Methods
   * ======================================================================== */

  /**
   * Save a task attempt (teacher -> student).
   *
   * @param {object} params
   * @param {string} params.characterId — hex character ID (required)
   * @param {string|null} params.knowledgeId — hex knowledge ID (optional)
   * @param {string|null} params.taskId — hex task ID (optional)
   * @param {string|null} params.attemptText — student's response text
   * @param {string} params.taskType — type of task (default: 'unknown')
   * @param {string} params.taskPhase — phase of task (default: 'practice')
   * @param {number|null} params.score — evaluation score
   * @param {object} opts — { client, correlationId }
   * @returns {string} attempt_id (hex)
   */
  async saveTaskAttempt({
    characterId,
    knowledgeId = null,
    taskId = null,
    attemptText = null,
    taskType = DEFAULTS.TASK_TYPE,
    taskPhase = DEFAULTS.TASK_PHASE,
    score = null
  }, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.learningdb.save_task_attempt');

    this._validateHexId(characterId, 'characterId');
    if (knowledgeId) this._validateHexId(knowledgeId, 'knowledgeId');
    if (taskId) this._validateHexId(taskId, 'taskId');

    try {
      const attemptId = await generateHexId('tse_attempt_id');

      await this._query(
        `INSERT INTO tse_task_attempts (
          attempt_id, character_id, knowledge_id, task_id,
          attempt_text, task_type, task_phase, score, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [attemptId, characterId, knowledgeId, taskId,
         attemptText, taskType, taskPhase, score],
        opts,
        'saveTaskAttempt'
      );

      Counters.increment('tse.learningdb.save_task_attempt.success');
      logger.debug('Task attempt saved', {
        attemptId, characterId, taskType, correlationId
      });

      return attemptId;

    } catch (error) {
      Counters.increment('tse.learningdb.save_task_attempt.error');
      logger.error('saveTaskAttempt failed', error, {
        characterId, taskType, correlationId
      });
      throw error;
    }
  }

  /**
   * Fetch due FSRS items for a character.
   * Optional focusDomain restricts to items in that domain only.
   *
   * @param {string} characterId — hex character ID (required)
   * @param {number} limit — max items to return (default: 5)
   * @param {string|null} focusDomain — hex domain ID filter (optional)
   * @param {object} opts — { client, correlationId }
   * @returns {Array} rows of due knowledge items
   */
  async getDueItems(characterId, limit = DEFAULTS.DUE_ITEMS_LIMIT, focusDomain = null, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.learningdb.get_due_items');

    this._validateHexId(characterId, 'characterId');
    if (focusDomain) this._validateHexId(focusDomain, 'focusDomain');

    try {
      let sql = `
        SELECT
          uks.knowledge_id,
          ki.content,
          ki.domain_id,
          uks.next_review_timestamp,
          uks.difficulty,
          uks.stability,
          uks.current_retrievability
        FROM user_knowledge_state uks
        JOIN knowledge_items ki ON uks.knowledge_id = ki.knowledge_id
        WHERE uks.user_id = $1
          AND (uks.next_review_timestamp IS NULL OR uks.next_review_timestamp <= NOW())
      `;
      const params = [characterId];

      if (focusDomain) {
        sql += ` AND ki.domain_id = $${params.length + 1}`;
        params.push(focusDomain);
      }

      sql += `
        ORDER BY
          uks.next_review_timestamp ASC NULLS FIRST,
          ki.complexity_score ASC
        LIMIT $${params.length + 1}
      `;
      params.push(limit);

      const result = await this._query(sql, params, opts, 'getDueItems');

      Counters.increment('tse.learningdb.get_due_items.success');
      logger.debug('Due items fetched', {
        characterId, count: result.rows.length, focusDomain, correlationId
      });

      return result.rows;

    } catch (error) {
      Counters.increment('tse.learningdb.get_due_items.error');
      logger.error('getDueItems failed', error, {
        characterId, focusDomain, correlationId
      });
      throw error;
    }
  }

  /**
   * Create a new TSE cycle record.
   *
   * @param {string} characterId — hex character ID (required)
   * @param {string|null} query — user message that triggered the cycle
   * @param {string|null} domainId — hex domain ID (optional)
   * @param {object} opts — { client, correlationId }
   * @returns {object} { cycle_id, character_id, created_at }
   */
  async createTseCycle(characterId, query = null, domainId = null, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.learningdb.create_tse_cycle');

    this._validateHexId(characterId, 'characterId');
    if (domainId) this._validateHexId(domainId, 'domainId');

    try {
      const cycleId = await generateHexId('tse_cycle_id');

      const result = await this._query(
        `INSERT INTO tse_cycles (
          cycle_id, character_id, user_message, domain_id,
          status, cycle_type, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'standard', NOW())
        RETURNING cycle_id, character_id, created_at`,
        [cycleId, characterId, query, domainId, CYCLE_STATUS.RUNNING],
        opts,
        'createTseCycle'
      );

      Counters.increment('tse.learningdb.create_tse_cycle.success');
      logger.debug('TSE cycle created', {
        cycleId, characterId, domainId, correlationId
      });

      return result.rows[0];

    } catch (error) {
      Counters.increment('tse.learningdb.create_tse_cycle.error');
      logger.error('createTseCycle failed', error, {
        characterId, domainId, correlationId
      });
      throw error;
    }
  }

  /**
   * Create a teacher record for a TSE cycle.
   *
   * @param {object} params
   * @param {string} params.cycleId — hex cycle ID (required)
   * @param {number} params.teacherSequence — positive integer (default: 1)
   * @param {string} params.algorithmId — algorithm name (default: 'TeacherComponent')
   * @param {string} params.algorithmVersion — version (default: 'v010')
   * @param {object} params.inputParameters — JSON parameters
   * @param {object} opts — { client, correlationId }
   * @returns {object} { record_id }
   */
  async createTeacherRecord({
    cycleId,
    teacherSequence = DEFAULTS.TEACHER_SEQUENCE,
    algorithmId = DEFAULTS.ALGORITHM_ID,
    algorithmVersion = DEFAULTS.ALGORITHM_VERSION,
    inputParameters = {}
  }, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.learningdb.create_teacher_record');

    this._validateHexId(cycleId, 'cycleId');
    this._validatePositiveInt(teacherSequence, 'teacherSequence');

    try {
      const recordId = await generateHexId('tse_teacher_record_id');

      const result = await this._query(
        `INSERT INTO tse_teacher_records (
          record_id, cycle_id, teacher_sequence,
          algorithm_id, algorithm_version, input_parameters, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING record_id`,
        [recordId, cycleId, teacherSequence,
         algorithmId, algorithmVersion, inputParameters],
        opts,
        'createTeacherRecord'
      );

      if (result.rows.length === 0) {
        throw new Error(
          `${MODULE_NAME}.createTeacherRecord: INSERT returned no rows`
        );
      }

      Counters.increment('tse.learningdb.create_teacher_record.success');
      logger.debug('Teacher record created', {
        recordId, cycleId, correlationId
      });

      return { record_id: result.rows[0].record_id };

    } catch (error) {
      Counters.increment('tse.learningdb.create_teacher_record.error');
      logger.error('createTeacherRecord failed', error, {
        cycleId, correlationId
      });
      throw error;
    }
  }

  /**
   * Create a student record for a TSE cycle.
   *
   * @param {object} params
   * @param {string} params.cycleId — hex cycle ID (required)
   * @param {string} params.teacherRecordId — hex teacher record ID (required)
   * @param {number} params.studentSequence — positive integer (default: 1)
   * @param {object} opts — { client, correlationId }
   * @returns {object} { record_id }
   */
  async createStudentRecord({
    cycleId,
    teacherRecordId,
    studentSequence = DEFAULTS.STUDENT_SEQUENCE
  }, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.learningdb.create_student_record');

    this._validateHexId(cycleId, 'cycleId');
    this._validateHexId(teacherRecordId, 'teacherRecordId');
    this._validatePositiveInt(studentSequence, 'studentSequence');

    try {
      const recordId = await generateHexId('tse_student_record_id');

      const result = await this._query(
        `INSERT INTO tse_student_records (
          record_id, cycle_id, teacher_record_id,
          student_sequence, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
        RETURNING record_id`,
        [recordId, cycleId, teacherRecordId, studentSequence],
        opts,
        'createStudentRecord'
      );

      if (result.rows.length === 0) {
        throw new Error(
          `${MODULE_NAME}.createStudentRecord: INSERT returned no rows`
        );
      }

      Counters.increment('tse.learningdb.create_student_record.success');
      logger.debug('Student record created', {
        recordId, cycleId, teacherRecordId, correlationId
      });

      return { record_id: result.rows[0].record_id };

    } catch (error) {
      Counters.increment('tse.learningdb.create_student_record.error');
      logger.error('createStudentRecord failed', error, {
        cycleId, teacherRecordId, correlationId
      });
      throw error;
    }
  }

  /**
   * Complete a TSE cycle with aggregated metrics.
   *
   * Effectiveness is normalized to 0-1 from evaluation scores (assumed 0-5).
   * Optimization is averaged from communication efficiency scores.
   * Both values are clamped to 0-1 to prevent overflow from unexpected inputs.
   *
   * @param {object} params
   * @param {string} params.cycleId — hex cycle ID (required)
   * @param {Array} params.evaluations — array of evaluation objects
   * @param {object} opts — { client, correlationId }
   * @returns {object|null} { cycle_id, status, learning_effectiveness }
   */
  async completeCycle({ cycleId, evaluations = [] }, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.learningdb.complete_cycle');

    this._validateHexId(cycleId, 'cycleId');

    try {
      const count = evaluations.length;
      let effectiveness = 0;
      let optimization = 0.5;

      if (count > 0) {
        const sumScores = evaluations.reduce((a, b) => a + (b.score ?? 0), 0);
        effectiveness = Math.min(1, Math.max(0, sumScores / count / 5));

        const sumComm = evaluations.reduce(
          (a, b) => a + (b.communicationScores?.efficiency ?? 0.5),
          0
        );
        optimization = Math.min(1, Math.max(0, sumComm / count));
      }

      const result = await this._query(
        `UPDATE tse_cycles
         SET
           status = $1,
           completed_at = NOW(),
           learning_effectiveness = $2,
           optimization_score = $3,
           updated_at = NOW()
         WHERE cycle_id = $4
         RETURNING cycle_id, status, learning_effectiveness`,
        [CYCLE_STATUS.COMPLETED, effectiveness, optimization, cycleId],
        opts,
        'completeCycle'
      );

      if (result.rows.length === 0) {
        logger.warn('completeCycle: no rows updated — cycle may not exist', {
          cycleId, correlationId
        });
        Counters.increment('tse.learningdb.complete_cycle.not_found');
        return null;
      }

      Counters.increment('tse.learningdb.complete_cycle.success');
      logger.debug('TSE cycle completed', {
        cycleId, effectiveness, optimization, evaluationCount: count, correlationId
      });

      return result.rows[0];

    } catch (error) {
      Counters.increment('tse.learningdb.complete_cycle.error');
      logger.error('completeCycle failed', error, {
        cycleId, evaluationCount: evaluations.length, correlationId
      });
      throw error;
    }
  }
}
