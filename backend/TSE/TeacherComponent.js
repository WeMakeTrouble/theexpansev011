/**
 * =============================================================================
 * TeacherComponent — TSE Task Generation Engine (Human Users Only)
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Generates learning tasks for human users within the Teaching Session
 * Engine. Selects knowledge items based on FSRS scheduling, user belt
 * level, domain focus, and adaptive difficulty. Produces structured task
 * objects that StudentComponent presents and EvaluatorComponent scores.
 *
 * HUMAN-ONLY BOUNDARY:
 * ---------------------------------------------------------------------------
 * This module is used ONLY for human user learning via owned avatar.
 * NO autonomous/B-Roll/NPC learning occurs here.
 * All callers MUST enforce human-only checks BEFORE calling teach().
 * TSELoopManager provides this guard via runOrContinueTseSession().
 *
 * QUERIES USER TABLES:
 *   - user_belt_progression (belt level per domain)
 *   - user_knowledge_state (FSRS scheduling state)
 *   - knowledge_items (content, concepts, answers)
 *   - tse_task_attempts (recent scores for adaptive difficulty)
 *
 * PEDAGOGICAL QUERY STRATEGY:
 * ---------------------------------------------------------------------------
 * TeacherComponent has its own _query helper for read-only pedagogical
 * queries (belt lookup, knowledge selection, lore search, adaptive
 * difficulty). These are teaching-specific reads distinct from the TSE
 * cycle lifecycle operations in LearningDatabase.
 *
 * LearningDatabase is used for cycle/record creation (via this.learningDB)
 * but NOT for pedagogical reads.
 *
 * TASK GENERATION FLOW:
 * ---------------------------------------------------------------------------
 *   1. Compute difficulty (trait-based + adaptive from recent scores)
 *   2. Check for explicit task type request (recall, communication, retry)
 *   3. Check for communication keyword in query
 *   4. Generate domain task (QUD-targeted → due recall → knowledge review)
 *   5. Check for lore fact match
 *   6. Safe teaching fallback (always returns a task)
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TSELoopManager.js — instantiates with learningDB, calls teach()
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 *   LearningDatabase — cycle/record operations (injected via constructor)
 *   TraitManager — cognitive trait averages for difficulty computation
 *   KnowledgeState — TASK_CATEGORY_ACQUISITION constant
 *   TaskCategories — TASK_CATEGORIES enum
 *   LearningStateEnum — LEARNING_STATE enum
 *   hexIdGenerator — task ID generation
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger with createModuleLogger (no console.log)
 *   - Counters on every public and lookup method (.success/.error variants)
 *   - Input validation on all hex IDs via isValidHexId
 *   - Difficulty range validation and clamping (1-5)
 *   - Query timeout protection via _query helper with labeled timeouts
 *   - Frozen constants (belt order, task type map, expected formats)
 *   - Correlation ID threading via opts parameter
 *   - No direct pool queries outside _query helper
 *   - SQL NOW() for timestamps (no client-side clock skew)
 *   - Standardized error logging: warn for degraded, error for failures
 *   - Named export alongside default for tree-shaking compatibility
 *
 * =============================================================================
 */

import generateHexId, { isValidHexId } from '../utils/hexIdGenerator.js';
import traitManager, { TRAIT_CATEGORIES } from '../traits/TraitManager.js';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import Counters from '../councilTerminal/metrics/counters.js';

import { TASK_CATEGORY_ACQUISITION } from './constants/KnowledgeState.js';
import { TASK_CATEGORIES as CATEGORIES } from './constants/TaskCategories.js';
import { LEARNING_STATE } from './constants/LearningStateEnum.js';

/* ==========================================================================
 * Constants
 * ========================================================================== */

const MODULE_NAME = 'TeacherComponent';

const DEFAULTS = Object.freeze({
  DIFFICULTY: 2,
  MIN_DIFFICULTY: 1,
  MAX_DIFFICULTY: 5,
  HIGH_DIFFICULTY_THRESHOLD: 4,
  MID_DIFFICULTY_THRESHOLD: 2,
  ADAPTIVE_HIGH_THRESHOLD: 0.8,
  ADAPTIVE_LOW_THRESHOLD: 0.4,
  ADAPTIVE_SAMPLE_SIZE: 10,
  DEFAULT_BELT: 'white_belt',
  QUERY_TIMEOUT_MS: 8000,
  COGNITIVE_DIFFICULTY_DIVISOR: 20,
  FOLLOW_UP_SCORE_THRESHOLD: 4
});

const BELT_ORDER = Object.freeze([
  'white_belt',
  'blue_belt',
  'purple_belt',
  'brown_belt',
  'black_belt'
]);

const TASK_TYPE_MAP = Object.freeze({
  recall: CATEGORIES.ACQUISITION,
  retrieval: CATEGORIES.ACQUISITION,
  retry: CATEGORIES.ACQUISITION,
  communication_quality: CATEGORIES.COMMUNICATION_QUALITY,
  reflection: CATEGORIES.COMMUNICATION_QUALITY,
  cause_effect_rewrite: CATEGORIES.REWRITE,
  sentence_clarity_rewrite: CATEGORIES.REWRITE,
  summarize_core_point: CATEGORIES.ACQUISITION,
  lore_comprehension: CATEGORIES.ACQUISITION,
  fallback: CATEGORIES.ACQUISITION,
  clarification: CATEGORIES.COMMUNICATION_QUALITY,
  teaching: CATEGORIES.ACQUISITION
});

const EXPECTED_FORMATS = Object.freeze({
  cause_effect_rewrite: 'Rewrite using causal language: because, therefore, as a result, etc.',
  sentence_clarity_rewrite: 'Break into short, clear sentences.',
  summarize_core_point: 'Summarize the main idea in about half the length.',
  communication_quality: 'Explain warmly and clearly in your own words.',
  lore_comprehension: 'Connect this fact to the broader world and your understanding.',
  clarification: 'Expand on your previous answer with more detail and examples.'
});

const PRACTICE_TASK_TYPES = Object.freeze([
  'cause_effect_rewrite',
  'sentence_clarity_rewrite',
  'summarize_core_point',
  'communication_quality'
]);

const logger = createModuleLogger(MODULE_NAME);

/* ==========================================================================
 * TeacherComponent Class
 * ========================================================================== */

class TeacherComponent {

  /**
   * @param {object} learningDB — LearningDatabase instance for cycle operations
   */
  constructor(learningDB) {
    this.learningDB = learningDB;
    this.pool = pool;
  }

  /* ========================================================================
   * Internal: Query Helper
   * ======================================================================== */

  /**
   * Execute a read-only pedagogical query with labeled timeout protection.
   * Used for belt lookups, knowledge selection, lore search, adaptive
   * difficulty — teaching-specific reads that don't belong in LearningDatabase.
   *
   * @param {string} sql — parameterised SQL string
   * @param {Array} params — query parameters
   * @param {string} methodLabel — calling method name for timeout diagnostics
   * @returns {object} query result
   */
  async _query(sql, params = [], methodLabel = 'unknown') {
    const timeoutMs = DEFAULTS.QUERY_TIMEOUT_MS;

    const queryPromise = this.pool.query(sql, params);
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

  _validateHexId(value, name) {
    if (!value || !isValidHexId(value)) {
      throw new Error(
        `${MODULE_NAME}: invalid ${name} — expected #XXXXXX hex format, got: ${value}`
      );
    }
  }

  /* ========================================================================
   * Difficulty Computation
   * ======================================================================== */

  /**
   * Compute difficulty from cognitive trait average.
   * Maps 0-100 percentile to 1-5 difficulty scale.
   * Returns DEFAULTS.DIFFICULTY (2) if no trait data available.
   *
   * @param {string} userId — hex user ID
   * @param {object} opts — { correlationId }
   * @returns {number} difficulty 1-5
   */
  async _computeTraitDifficulty(userId, opts = {}) {
    const correlationId = opts.correlationId || null;

    try {
      const cognitiveAvg = await traitManager.getCategoryAverage(
        userId,
        TRAIT_CATEGORIES.COGNITIVE,
        { correlationId }
      );

      if (cognitiveAvg === null) {
        logger.debug('No cognitive traits found, using default difficulty', {
          userId, default: DEFAULTS.DIFFICULTY, correlationId
        });
        return DEFAULTS.DIFFICULTY;
      }

      const difficulty = Math.max(
        DEFAULTS.MIN_DIFFICULTY,
        Math.min(
          DEFAULTS.MAX_DIFFICULTY,
          Math.ceil(cognitiveAvg / DEFAULTS.COGNITIVE_DIFFICULTY_DIVISOR)
        )
      );

      logger.debug('Trait difficulty computed', {
        userId, cognitiveAvg, difficulty, correlationId
      });

      return difficulty;

    } catch (error) {
      logger.warn('Trait difficulty lookup failed, using default', {
        userId, correlationId, error: error.message
      });
      return DEFAULTS.DIFFICULTY;
    }
  }

  /**
   * Apply adaptive difficulty adjustment based on recent performance.
   * Checks last N task attempt scores. If average is high, increase
   * difficulty. If average is low, decrease difficulty.
   *
   * @param {string} userId — hex user ID
   * @param {number} baseDifficulty — starting difficulty to adjust
   * @param {object} opts — { correlationId }
   * @returns {number} adjusted difficulty 1-5
   */
  async _applyAdaptiveDifficulty(userId, baseDifficulty, opts = {}) {
    const correlationId = opts.correlationId || null;

    try {
      const result = await this._query(
        `SELECT AVG(score) AS avg_score FROM (
          SELECT CAST(score AS NUMERIC) AS score
          FROM tse_task_attempts
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        ) AS recent`,
        [userId, DEFAULTS.ADAPTIVE_SAMPLE_SIZE],
        '_applyAdaptiveDifficulty'
      );

      const avg = parseFloat(result.rows[0]?.avg_score) || 0.5;

      if (avg > DEFAULTS.ADAPTIVE_HIGH_THRESHOLD) {
        return Math.min(DEFAULTS.MAX_DIFFICULTY, baseDifficulty + 1);
      }
      if (avg < DEFAULTS.ADAPTIVE_LOW_THRESHOLD) {
        return Math.max(DEFAULTS.MIN_DIFFICULTY, baseDifficulty - 1);
      }

      return baseDifficulty;

    } catch (error) {
      logger.warn('Adaptive difficulty query failed, using base', {
        userId, baseDifficulty, correlationId, error: error.message
      });
      return baseDifficulty;
    }
  }

  /* ========================================================================
   * Belt & Knowledge Lookups
   * ======================================================================== */

  /**
   * Get user's current belt for a specific domain.
   * Queries user_belt_progression table (NOT character_belt_progression).
   * Returns 'white_belt' if no progression found or on error.
   *
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {object} opts — { correlationId }
   * @returns {string} belt level string
   */
  async _getUserBelt(userId, domainId, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.get_user_belt');

    try {
      const result = await this._query(
        `SELECT current_belt
         FROM user_belt_progression
         WHERE user_id = $1 AND domain_id = $2`,
        [userId, domainId],
        '_getUserBelt'
      );

      if (result.rows.length === 0) {
        Counters.increment('tse.teacher.get_user_belt.not_found');
        logger.debug('No belt progression found, defaulting to white_belt', {
          userId, domainId, correlationId
        });
        return DEFAULTS.DEFAULT_BELT;
      }

      const belt = result.rows[0].current_belt;
      Counters.increment('tse.teacher.get_user_belt.success');
      logger.debug('User belt fetched', {
        userId, domainId, belt, correlationId
      });
      return belt;

    } catch (error) {
      Counters.increment('tse.teacher.get_user_belt.error');
      logger.warn('Belt lookup failed, defaulting to white_belt', {
        userId, domainId, correlationId, error: error.message
      });
      return DEFAULTS.DEFAULT_BELT;
    }
  }

  /**
   * Get knowledge item for review — belt-aware, FSRS-scheduled.
   * Returns unseen items first, then items due for review.
   * Uses SQL NOW() for timestamp comparison to avoid clock skew.
   *
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {number} difficulty — current difficulty level
   * @param {object} opts — { correlationId }
   * @returns {object|null} knowledge item row or null
   */
  async _getKnowledgeItemForReview(userId, domainId, difficulty, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.get_knowledge_item');

    try {
      const currentBelt = await this._getUserBelt(userId, domainId, opts);

      const result = await this._query(
        `SELECT
          ki.knowledge_id,
          ki.content,
          ki.concept,
          ki.complexity_score,
          ki.domain_id,
          ki.answer_statement,
          ki.required_terms,
          uks.next_review_timestamp,
          uks.difficulty AS fsrs_difficulty,
          CASE
            WHEN uks.is_mastered = true THEN 'mastered'
            WHEN uks.is_forgotten = true THEN 'forgotten'
            WHEN uks.acquisition_completed = true THEN 'acquired'
            WHEN uks.practice_count > 0 THEN 'learning'
            ELSE 'unseen'
          END AS learning_state
        FROM knowledge_items ki
        LEFT JOIN user_knowledge_state uks
          ON ki.knowledge_id = uks.knowledge_id
          AND uks.user_id = $1
        WHERE ki.domain_id = $2
          AND ki.source_type IN ('admin_entry', 'tse_cycle')
          AND (ki.belt_level IS NULL OR ki.belt_level = $3)
          AND (uks.next_review_timestamp IS NULL OR uks.next_review_timestamp <= NOW())
        ORDER BY
          uks.next_review_timestamp ASC NULLS FIRST,
          ki.complexity_score ASC
        LIMIT 1`,
        [userId, domainId, currentBelt],
        '_getKnowledgeItemForReview'
      );

      const item = result.rows[0] || null;

      if (item) {
        Counters.increment('tse.teacher.get_knowledge_item.success');
        logger.debug('Knowledge item found for review', {
          knowledgeId: item.knowledge_id, belt: currentBelt,
          learningState: item.learning_state, correlationId
        });
      } else {
        Counters.increment('tse.teacher.get_knowledge_item.empty');
        logger.debug('No knowledge item found for review', {
          userId, domainId, belt: currentBelt, correlationId
        });
      }

      return item;

    } catch (error) {
      Counters.increment('tse.teacher.get_knowledge_item.error');
      logger.warn('Knowledge item review selection failed', {
        userId, domainId, correlationId, error: error.message
      });
      return null;
    }
  }

  /**
   * Get due recall item — items with completed acquisition that need review.
   *
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {object} opts — { correlationId }
   * @returns {object|null} due item row or null
   */
  async _getDueRecallItem(userId, domainId, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.get_due_recall');

    try {
      const currentBelt = await this._getUserBelt(userId, domainId, opts);

      const result = await this._query(
        `SELECT uks.knowledge_id, ki.required_terms, ki.concept
         FROM user_knowledge_state uks
         JOIN knowledge_items ki ON uks.knowledge_id = ki.knowledge_id
         WHERE uks.user_id = $1
           AND ki.domain_id = $2
           AND uks.acquisition_completed = true
           AND uks.next_review_timestamp <= NOW()
           AND (ki.belt_level IS NULL OR ki.belt_level = $3)
         ORDER BY uks.next_review_timestamp
         LIMIT 1`,
        [userId, domainId, currentBelt],
        '_getDueRecallItem'
      );

      const item = result.rows[0] || null;

      if (item) {
        Counters.increment('tse.teacher.get_due_recall.success');
        logger.debug('Due recall item found', {
          knowledgeId: item.knowledge_id, correlationId
        });
      } else {
        Counters.increment('tse.teacher.get_due_recall.empty');
      }

      return item;

    } catch (error) {
      Counters.increment('tse.teacher.get_due_recall.error');
      logger.warn('Due recall item query failed', {
        userId, domainId, correlationId, error: error.message
      });
      return null;
    }
  }

  /**
   * Get a specific knowledge item by its hex ID.
   * Used for QUD-targeted teaching when user accepts a specific topic.
   *
   * @param {string} knowledgeId — hex knowledge ID
   * @param {object} opts — { correlationId }
   * @returns {object|null} knowledge item row or null
   */
  async _getKnowledgeById(knowledgeId, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.get_knowledge_by_id');

    try {
      const result = await this._query(
        `SELECT knowledge_id, content, concept, complexity_score,
                domain_id, answer_statement, required_terms, belt_level
         FROM knowledge_items
         WHERE knowledge_id = $1`,
        [knowledgeId],
        '_getKnowledgeById'
      );

      const item = result.rows[0] || null;

      if (item) {
        Counters.increment('tse.teacher.get_knowledge_by_id.success');
        logger.debug('Knowledge item fetched by ID', {
          knowledgeId, correlationId
        });
      } else {
        Counters.increment('tse.teacher.get_knowledge_by_id.not_found');
      }

      return item;

    } catch (error) {
      Counters.increment('tse.teacher.get_knowledge_by_id.error');
      logger.warn('Knowledge item fetch by ID failed', {
        knowledgeId, correlationId, error: error.message
      });
      return null;
    }
  }

  /* ========================================================================
   * Knowledge Content Parsing
   * ======================================================================== */

  /**
   * Parse knowledge content JSON to extract teaching/testing/answer statements.
   * Handles string (JSON or raw), object, and null inputs gracefully.
   *
   * @param {*} content — raw content from knowledge_items table
   * @returns {object} { teaching, question, answer } — all string|null
   */
  _parseKnowledgeContent(content) {
    if (!content) return { teaching: null, question: null, answer: null };

    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content);
        return {
          teaching: parsed.teaching_statement || null,
          question: parsed.testing_statement || null,
          answer: parsed.answer_statement || null
        };
      } catch (e) {
        return { teaching: content, question: null, answer: null };
      }
    }

    if (typeof content === 'object') {
      return {
        teaching: content.teaching_statement || null,
        question: content.testing_statement || null,
        answer: content.answer_statement || null
      };
    }

    return { teaching: null, question: null, answer: null };
  }

  /* ========================================================================
   * Task Type Selection
   * ======================================================================== */

  /**
   * Maps taskType string to evaluator category.
   * @param {string} type — task type string
   * @returns {string} category from TASK_TYPE_MAP or 'unknown'
   */
  _mapTypeToCategory(type) {
    return TASK_TYPE_MAP[type] || 'unknown';
  }

  /**
   * Select practice task type based on difficulty level.
   * Higher difficulty favours communication quality tasks.
   *
   * @param {number} difficulty — current difficulty 1-5
   * @returns {string} task type string
   */
  _selectTaskType(difficulty) {
    if (difficulty >= DEFAULTS.HIGH_DIFFICULTY_THRESHOLD) {
      return 'communication_quality';
    }
    if (difficulty >= DEFAULTS.MID_DIFFICULTY_THRESHOLD) {
      return PRACTICE_TASK_TYPES[
        Math.floor(Math.random() * (PRACTICE_TASK_TYPES.length - 1))
      ];
    }
    return PRACTICE_TASK_TYPES[Math.floor(Math.random() * 2)];
  }

  /**
   * Get expected format string for a task type.
   * @param {string} taskType — task type string
   * @returns {string} expected format description
   */
  _getExpectedFormat(taskType) {
    return EXPECTED_FORMATS[taskType] || 'Provide a thoughtful response.';
  }

  /* ========================================================================
   * Main Entry Point
   * ======================================================================== */

  /**
   * Generate next learning task for a user.
   *
   * @param {string} userId — hex user ID (e.g. #D00006)
   * @param {string} query — user's query/input
   * @param {object} context — must include domainId for belt-aware selection
   * @param {object} opts — { correlationId }
   * @returns {object} task object with taskId, taskType, taskCategory, input, etc.
   */
  async teach(userId, query, context = {}, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.teach');

    this._validateHexId(userId, 'userId');

    const domainId = context?.domainId;
    if (!domainId) {
      throw new Error(
        `${MODULE_NAME}.teach(): context.domainId is required`
      );
    }
    this._validateHexId(domainId, 'domainId');

    const targetKnowledgeId = context?.targetKnowledgeId || null;
    if (targetKnowledgeId) {
      this._validateHexId(targetKnowledgeId, 'targetKnowledgeId');
    }

    let difficulty = DEFAULTS.DIFFICULTY;
    if (context.difficultyLevel) {
      difficulty = Math.max(
        DEFAULTS.MIN_DIFFICULTY,
        Math.min(DEFAULTS.MAX_DIFFICULTY, context.difficultyLevel)
      );
    }

    if (!context.difficultyLevel) {
      const base = await this._computeTraitDifficulty(userId, opts);
      difficulty = await this._applyAdaptiveDifficulty(userId, base, opts);
    }

    let task = null;

    /* ------------------------------------------------------------------
     * Step 0: QUD-targeted knowledge item (highest priority)
     * ------------------------------------------------------------------ */
    if (targetKnowledgeId) {
      task = await this._buildQudTargetedTask(
        userId, domainId, targetKnowledgeId, difficulty, context, opts
      );
      if (task) {
        Counters.increment('tse.teacher.teach.qud_targeted');
        Counters.increment('tse.teacher.teach.success');
        return task;
      }
    }

    /* ------------------------------------------------------------------
     * Step 1: Explicit task type request
     * ------------------------------------------------------------------ */
    const requestedType = context?.type?.toLowerCase();
    if (requestedType) {
      task = await this._handleExplicitType(
        requestedType, userId, domainId, difficulty, context, opts
      );
      if (task) {
        Counters.increment('tse.teacher.teach.explicit_type');
        Counters.increment('tse.teacher.teach.success');
        return task;
      }
    }

    /* ------------------------------------------------------------------
     * Step 2: Communication keyword in query
     * ------------------------------------------------------------------ */
    if (query?.toLowerCase().includes('communication')) {
      task = await this._generateCommunicationQualityTask(
        userId, difficulty, context, opts
      );
      if (task) {
        Counters.increment('tse.teacher.teach.communication_keyword');
        Counters.increment('tse.teacher.teach.success');
        return task;
      }
    }

    /* ------------------------------------------------------------------
     * Step 3: Domain task (QUD-targeted → due recall → knowledge review)
     * ------------------------------------------------------------------ */
    if (domainId) {
      task = await this._generateDomainTask(
        userId, domainId, difficulty, context, opts
      );
      if (task) {
        Counters.increment('tse.teacher.teach.domain');
        Counters.increment('tse.teacher.teach.success');
        return task;
      }
    }

    /* ------------------------------------------------------------------
     * Step 4: Lore fact match
     * ------------------------------------------------------------------ */
    if (query && (query.toLowerCase().includes('piza') || query.toLowerCase().includes('expanse'))) {
      task = await this._teachLoreFact(userId, query, difficulty, context, opts);
      if (task) {
        Counters.increment('tse.teacher.teach.lore');
        Counters.increment('tse.teacher.teach.success');
        return task;
      }
    }

    /* ------------------------------------------------------------------
     * Step 5: Safe teaching fallback (always returns a task)
     * ------------------------------------------------------------------ */
    Counters.increment('tse.teacher.teach.fallback');
    Counters.increment('tse.teacher.teach.success');
    logger.warn('Using safe teaching fallback', {
      userId, domainId, correlationId
    });

    return {
      taskId: await generateHexId('tse_task_id'),
      taskType: 'teaching',
      taskCategory: TASK_CATEGORY_ACQUISITION,
      input: query || 'Let us begin learning about this topic.',
      instructions: 'Study this material and acknowledge understanding.',
      expectedFormat: 'Acknowledge understanding of the material.',
      difficulty,
      userId,
      requiresResponse: true,
      metadata: {
        difficulty,
        context,
        domainId,
        fallback: true,
        correlationId
      }
    };
  }

  /* ========================================================================
   * Task Generation — Explicit Type
   * ======================================================================== */

  /**
   * Handle explicit task type requests (recall, communication, retry).
   * When recall is requested but nothing is due, falls through to domain
   * task generation rather than returning null silently.
   *
   * @param {string} requestedType — lowercase task type
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {number} difficulty — current difficulty
   * @param {object} context — full context object
   * @param {object} opts — { correlationId }
   * @returns {object|null} task or null if type not handled
   */
  async _handleExplicitType(requestedType, userId, domainId, difficulty, context, opts = {}) {
    const correlationId = opts.correlationId || null;

    switch (requestedType) {
      case 'recall':
      case 'retrieval': {
        const dueItem = await this._getDueRecallItem(userId, domainId, opts);
        if (dueItem) {
          return {
            taskId: await generateHexId('tse_task_id'),
            taskType: 'recall',
            taskCategory: this._mapTypeToCategory('recall'),
            input: 'Recall what you learned about this concept.',
            knowledgeId: dueItem.knowledge_id,
            concept: dueItem.concept,
            required_terms: dueItem.required_terms,
            difficulty,
            userId,
            requiresResponse: true,
            metadata: { difficulty, context, domainId, correlationId }
          };
        }
        /* Nothing due for recall — fall through to domain task
         * instead of returning null silently */
        logger.debug('Recall requested but nothing due, falling through to domain task', {
          userId, domainId, correlationId
        });
        return this._generateDomainTask(userId, domainId, difficulty, context, opts);
      }

      case 'communication_quality':
      case 'reflection':
        return this._generateCommunicationQualityTask(
          userId, difficulty, context, opts
        );

      case 'retry':
        return {
          taskId: await generateHexId('tse_task_id'),
          taskType: 'retry',
          taskCategory: this._mapTypeToCategory('retry'),
          input: context.prompt || 'Let\'s try this again with more care.',
          difficulty: Math.max(DEFAULTS.MIN_DIFFICULTY, difficulty - 1),
          userId,
          requiresResponse: true,
          metadata: { retry: true, context, correlationId }
        };

      default:
        logger.warn('Unknown explicit task type requested', {
          requestedType, correlationId
        });
        return null;
    }
  }

  /* ========================================================================
   * Task Generation — Communication Quality
   * ======================================================================== */

  async _generateCommunicationQualityTask(userId, difficulty, context, opts = {}) {
    const correlationId = opts.correlationId || null;

    return {
      taskId: await generateHexId('tse_task_id'),
      taskType: 'communication_quality',
      taskCategory: this._mapTypeToCategory('communication_quality'),
      input: 'Explain what you\'ve learned so far with warmth and clarity. What stands out to you?',
      instructions: 'Share your understanding in a natural, friendly way.',
      expectedFormat: 'A thoughtful, personal explanation.',
      difficulty,
      userId,
      requiresResponse: true,
      metadata: {
        difficulty,
        context,
        target_outcome_intent: 'explain warmly and clearly',
        correlationId
      }
    };
  }

  /* ========================================================================
   * Task Generation — Domain Task
   * ======================================================================== */

  /**
   * Generate a domain-specific task. Priority order:
   *   1. QUD-targeted knowledge item (if targetKnowledgeId in context)
   *   2. Due recall item (FSRS-scheduled review)
   *   3. Knowledge item for review (unseen or due)
   *
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {number} difficulty — current difficulty
   * @param {object} context — full context including targetKnowledgeId
   * @param {object} opts — { correlationId }
   * @returns {object|null} task or null
   */
  async _generateDomainTask(userId, domainId, difficulty, context, opts = {}) {
    const correlationId = opts.correlationId || null;

    /* --- QUD-targeted teaching --- */
    const targetKnowledgeId = context?.targetKnowledgeId || null;
    if (targetKnowledgeId) {
      const targetTask = await this._buildQudTargetedTask(
        userId, domainId, targetKnowledgeId, difficulty, context, opts
      );
      if (targetTask) return targetTask;
    }

    /* --- Due recall item --- */
    const dueItem = await this._getDueRecallItem(userId, domainId, opts);
    if (dueItem) {
      return {
        taskId: await generateHexId('tse_task_id'),
        taskType: 'recall',
        taskCategory: TASK_CATEGORY_ACQUISITION,
        knowledgeId: dueItem.knowledge_id,
        concept: dueItem.concept,
        required_terms: dueItem.required_terms,
        input: `Recall what you learned about ${dueItem.concept || 'this concept'}.`,
        instructions: 'Retrieve from memory what you previously learned.',
        expectedFormat: 'A clear explanation from memory.',
        difficulty,
        userId,
        requiresResponse: true,
        metadata: {
          difficulty, context, domainId,
          isRecall: true, correlationId
        }
      };
    }

    /* --- Knowledge item for review (unseen or due) --- */
    const knowledgeItem = await this._getKnowledgeItemForReview(
      userId, domainId, difficulty, opts
    );
    if (!knowledgeItem) {
      return null;
    }

    return this._buildKnowledgeTask(
      knowledgeItem, userId, domainId, difficulty, context, opts
    );
  }

  /**
   * Build a QUD-targeted teaching task for a specific knowledge item.
   * Returns null if item not found or above user belt level.
   *
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {string} targetKnowledgeId — hex knowledge ID
   * @param {number} difficulty — current difficulty
   * @param {object} context — full context
   * @param {object} opts — { correlationId }
   * @returns {object|null} task or null
   */
  async _buildQudTargetedTask(userId, domainId, targetKnowledgeId, difficulty, context, opts = {}) {
    const correlationId = opts.correlationId || null;

    const targetItem = await this._getKnowledgeById(targetKnowledgeId, opts);
    if (!targetItem) {
      logger.warn('QUD-targeted knowledge item not found, falling back', {
        knowledgeId: targetKnowledgeId, correlationId
      });
      return null;
    }

    const userBelt = await this._getUserBelt(userId, domainId, opts);
    const itemBelt = targetItem.belt_level || null;
    const userRank = BELT_ORDER.indexOf(userBelt);
    const itemRank = itemBelt ? BELT_ORDER.indexOf(itemBelt) : -1;

    if (itemRank > userRank && userRank !== -1) {
      logger.warn('QUD-targeted item above user belt level, skipping', {
        knowledgeId: targetKnowledgeId, itemBelt, userBelt, correlationId
      });
      return null;
    }

    logger.debug('QUD-targeted knowledge item accepted', {
      knowledgeId: targetKnowledgeId, userBelt, itemBelt, correlationId
    });

    const parsed = this._parseKnowledgeContent(targetItem.content);

    return {
      taskId: await generateHexId('tse_task_id'),
      taskType: 'teaching',
      taskCategory: TASK_CATEGORY_ACQUISITION,
      knowledgeId: targetItem.knowledge_id,
      concept: targetItem.concept,
      input: parsed.teaching || targetItem.content || 'Learn this concept',
      question: parsed.question || null,
      expectedAnswer: parsed.answer || targetItem.answer_statement || null,
      instructions: parsed.question
        ? 'Answer this question based on what you just learned.'
        : 'Study and understand this material.',
      expectedFormat: parsed.question
        ? 'A clear answer demonstrating understanding.'
        : 'Acknowledge understanding of the material.',
      requiresResponse: true,
      difficulty,
      userId,
      metadata: {
        difficulty, context, domainId,
        sourceKnowledge: targetItem.knowledge_id,
        source: 'qud_targeted_teaching',
        correlationId
      }
    };
  }

  /**
   * Build a task from a knowledge item based on its learning state.
   * Unseen items get a teaching task. Previously seen items get a
   * practice task selected by difficulty.
   *
   * @param {object} knowledgeItem — row from _getKnowledgeItemForReview
   * @param {string} userId — hex user ID
   * @param {string} domainId — hex domain ID
   * @param {number} difficulty — current difficulty
   * @param {object} context — full context
   * @param {object} opts — { correlationId }
   * @returns {object} task object
   */
  async _buildKnowledgeTask(knowledgeItem, userId, domainId, difficulty, context, opts = {}) {
    const correlationId = opts.correlationId || null;
    const learningState = knowledgeItem.learning_state || LEARNING_STATE.UNSEEN;

    if (learningState === LEARNING_STATE.UNSEEN || learningState === 'unseen') {
      const parsed = this._parseKnowledgeContent(knowledgeItem.content);
      const teachingContent = parsed.teaching || knowledgeItem.content || 'Learn this concept';
      const questionText = parsed.question || null;
      const expectedAnswer = parsed.answer || knowledgeItem.answer_statement || null;

      return {
        taskId: await generateHexId('tse_task_id'),
        taskType: 'teaching',
        taskCategory: TASK_CATEGORY_ACQUISITION,
        knowledgeId: knowledgeItem.knowledge_id,
        concept: knowledgeItem.concept,
        input: teachingContent,
        question: questionText,
        expectedAnswer,
        required_terms: knowledgeItem.required_terms || [],
        instructions: questionText
          ? 'Answer this question based on what you just learned.'
          : 'Study and understand this material.',
        expectedFormat: questionText
          ? 'A clear answer demonstrating understanding.'
          : 'Acknowledge understanding of the material.',
        requiresResponse: true,
        difficulty,
        userId,
        metadata: {
          difficulty, context, domainId,
          sourceKnowledge: knowledgeItem.knowledge_id,
          learningState: LEARNING_STATE.UNSEEN,
          complexityScore: knowledgeItem.complexity_score || 0.5,
          hasQuestion: !!questionText,
          correlationId
        }
      };
    }

    /* --- Previously seen: practice task --- */
    const taskType = this._selectTaskType(difficulty);

    return {
      taskId: await generateHexId('tse_task_id'),
      taskType,
      taskCategory: this._mapTypeToCategory(taskType),
      knowledgeId: knowledgeItem.knowledge_id,
      input: `Learn: ${knowledgeItem.content?.split('\n')[0] || ''}`,
      instructions: `Practice ${taskType.replace('_', ' ')} on this concept.`,
      expectedFormat: this._getExpectedFormat(taskType),
      difficulty,
      userId,
      requiresResponse: true,
      metadata: {
        difficulty, context, domainId,
        sourceKnowledge: knowledgeItem.knowledge_id,
        complexityScore: knowledgeItem.complexity_score || 0.5,
        correlationId
      }
    };
  }

  /* ========================================================================
   * Task Generation — Lore
   * ======================================================================== */

  /**
   * Search for and generate a lore comprehension task.
   *
   * @param {string} userId — hex user ID
   * @param {string} query — user's query text
   * @param {number} difficulty — current difficulty
   * @param {object} context — full context
   * @param {object} opts — { correlationId }
   * @returns {object|null} task or null if no lore found
   */
  async _teachLoreFact(userId, query, difficulty, context, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.lore_search');

    try {
      const result = await this._query(
        `SELECT knowledge_id, content
         FROM knowledge_items
         WHERE source_type = 'admin_entry'
           AND content::text ILIKE ANY (ARRAY[$1, $2])
         LIMIT 1`,
        [`%${query}%`, '%piza%'],
        '_teachLoreFact'
      );

      if (result.rows.length === 0) {
        Counters.increment('tse.teacher.lore_search.empty');
        logger.debug('No lore fact found for query', {
          query, correlationId
        });
        return null;
      }

      const fact = result.rows[0];
      let contentObj = fact.content;

      if (typeof fact.content === 'string') {
        try {
          contentObj = JSON.parse(fact.content);
        } catch (e) {
          contentObj = { statement: fact.content };
        }
      }

      const statement = typeof contentObj === 'object'
        ? (contentObj.statement || fact.content)
        : fact.content;

      Counters.increment('tse.teacher.lore_search.success');

      return {
        taskId: await generateHexId('tse_task_id'),
        taskType: 'lore_comprehension',
        taskCategory: this._mapTypeToCategory('lore_comprehension'),
        input: `Question: ${statement}`,
        instructions: 'Answer thoughtfully, connecting to the broader Piza Sukeruton Multiverse.',
        expectedFormat: this._getExpectedFormat('lore_comprehension'),
        difficulty,
        userId,
        requiresResponse: true,
        knowledgeId: fact.knowledge_id,
        metadata: {
          difficulty, context,
          sourceKnowledge: fact.knowledge_id,
          correlationId
        }
      };

    } catch (error) {
      Counters.increment('tse.teacher.lore_search.error');
      logger.warn('Lore task generation failed', {
        query, correlationId, error: error.message
      });
      return null;
    }
  }

  /* ========================================================================
   * Follow-Up Task
   * ======================================================================== */

  /**
   * Generate a follow-up task when the previous evaluation score was low.
   * Returns null if score was adequate (>= FOLLOW_UP_SCORE_THRESHOLD).
   *
   * @param {object} previousTask — the task that was just evaluated
   * @param {object} evaluation — evaluation result with score and feedback
   * @param {object} opts — { correlationId }
   * @returns {object|null} follow-up task or null
   */
  async generateFollowUpTask(previousTask, evaluation, opts = {}) {
    const correlationId = opts.correlationId || null;
    Counters.increment('tse.teacher.follow_up');

    if (!evaluation || evaluation.score >= DEFAULTS.FOLLOW_UP_SCORE_THRESHOLD) {
      Counters.increment('tse.teacher.follow_up.not_needed');
      return null;
    }

    try {
      const task = {
        taskId: await generateHexId('tse_task_id'),
        taskType: 'clarification',
        taskCategory: this._mapTypeToCategory('clarification'),
        input: previousTask.input,
        instructions: 'Let\'s go deeper. Can you expand on your answer with more detail?',
        expectedFormat: 'A more detailed and reflective response.',
        difficulty: previousTask.difficulty,
        userId: previousTask.userId,
        requiresResponse: true,
        metadata: {
          chainFrom: previousTask.taskId,
          previousScore: evaluation.score,
          feedback: evaluation.feedback || 'Try adding more detail.',
          correlationId
        }
      };

      Counters.increment('tse.teacher.follow_up.success');
      return task;

    } catch (error) {
      Counters.increment('tse.teacher.follow_up.error');
      logger.warn('Follow-up task generation failed', {
        previousTaskId: previousTask?.taskId, correlationId,
        error: error.message
      });
      return null;
    }
  }
}

export { TeacherComponent };
export default TeacherComponent;
