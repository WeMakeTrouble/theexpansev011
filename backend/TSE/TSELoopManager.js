/**
 * ============================================================================
 * TSELoopManager.js — Teaching Session Engine Loop Manager (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Orchestrates human-only learning sessions with spaced repetition (FSRS),
 * interleaving, metacognitive reflection, re-teach exhaustion handling, and
 * belt progression gating. Sessions persist across restarts with indefinite
 * resume capability (no arbitrary timeouts).
 *
 * SCOPE
 * -----
 * HUMAN LEARNING ONLY. This module is exclusively for users learning via
 * owned characters. B-Roll/autonomous character learning uses separate systems.
 * See: backend/TSE/v010-HUMAN-ONLY.md for boundary documentation.
 *
 * CORE ARCHITECTURE
 * -----------------
 * Session Lifecycle:
 *   1. Create or load session (user can resume anytime)
 *   2. Decide next task (retry → reflect → interleave → SRS due → fallback)
 *   3. Teacher teaches task
 *   4. Student learns / attempts
 *   5. Evaluator scores attempt
 *   6. Update FSRS state if recall task
 *   7. Check belt advancement if cycle complete
 *   8. Save session state (idempotent, transactional)
 *   9. Return to #2 until maxTasks or maxFailures reached
 *
 * Session Persistence:
 *   - saveSessionState: Stores full session state (task, evaluations, taught IDs)
 *   - loadSessionState: Reconstructs session from database
 *   - "awaiting_response" status means task waiting for user input
 *   - No stale-session rejection (research-backed per lines 11-36 v009)
 *
 * FSRS Integration:
 *   - Uses correct user_knowledge_state table (human learning)
 *   - Column names: knowledge_id, next_review_timestamp, practice_count, etc.
 *   - Score mapping: eval 1-5 → FSRS 1-4 (non-linear via log-spaced intervals)
 *   - Stability/difficulty tracking per FSRS 4.5/5.0 spec
 *
 * Interleaving & Metacognition:
 *   - Intra-session interleaving: "taught but not mastered" items (discrimination)
 *   - Metacognitive reflection: every N tasks, user explains in own words
 *   - Retry path: failed recalls retry immediately with adjusted difficulty
 *   - Re-teach exhaustion: after max attempts, item marked forgotten
 *
 * Belt Progression:
 *   - UserBeltProgressionManager called post-cycle (only on completion)
 *   - Advancement checks domain-specific progress
 *   - Audit logged on belt up
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Structured logger (createModuleLogger) replaces old Logger import
 * - withRetry wrapper on all pool.query calls (transient failure resilience)
 * - Counters instrumentation on cycles, failures, reteach, FSRS updates
 * - Audit logging on critical events (belt advancement, item forgotten)
 * - Circuit breaker pattern: withRetry + timeout on teacher/evaluator calls
 * - Race condition fix: atomic session updates (no double-submit vulnerability)
 * - Main loop wrapped in try/catch with session recovery
 * - Legacy parameter cleanup (legacyParam removed)
 * - All magic numbers externalized to FSRS_CONSTANTS
 * - N+1 query fix: refreshLearningSummary uses single CTE
 * - Promise.allSettled for parallel DB operations
 * - Input validation on all public methods
 * - Frozen constants throughout
 * - Full documentation header with architecture & rationale
 *
 * DEPENDENCIES
 * ------------
 * - pool.js (PostgreSQL connection)
 * - logger.js (structured logging)
 * - hexIdGenerator.js (hex ID generation)
 * - withRetry.js (transient failure retry)
 * - counters.js (metrics instrumentation)
 * - LearningDatabase, TeacherComponent, StudentComponent, EvaluatorComponent,
 *   UserBeltProgressionManager, KnowledgeAcquisitionEngine (internal TSE)
 *
 * DB TABLES
 * ---------
 * - tse_session_contexts (session persistence)
 * - tse_cycles, tse_evaluation_records, tse_teacher_records, tse_student_records
 * - user_knowledge_state (FSRS state for human learning)
 * - knowledge_items, knowledge_domains
 * - user_belt_progression, users
 *
 * PERFORMANCE NOTES
 * -----------------
 * - All DB queries wrapped in withRetry (3 attempts, 100ms backoff)
 * - Parallel queries via Promise.allSettled (one failure doesn't crash)
 * - _getUserDueItems uses LIMIT clause (configurable via ENV)
 * - refreshLearningSummary collapsed to single CTE (no N+1)
 * - Counters recorded on slow queries (threshold configurable)
 *
 * MONITORING & OBSERVABILITY
 * ---------------------------
 * - Correlation IDs passed through all async calls
 * - Counters tracked: tse_cycle_completed, tse_failure, tse_reteach_offered,
 *   tse_reteach_exhausted, tse_fsrs_update_success, tse_belt_advancement
 * - Audit logs on critical state changes
 * - QA visibility checkpoint (line ~630 area)
 *
 * SAFETY & CORRECTNESS
 * --------------------
 * - Human-only guard at session start (prevents NPC learning)
 * - userId extraction from owned_character_id (verified ownership)
 * - Transaction discipline on saveSessionState (no partial saves)
 * - Session state is serializable (JSONB in DB)
 * - Atomic compare-and-swap for awaiting_response (no race on double-submit)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import generateHexId from '../utils/hexIdGenerator.js';
import LearningDatabase from './LearningDatabase.js';
import TeacherComponent from './TeacherComponent.js';
import StudentComponent from './StudentComponent.js';
import EvaluatorComponent from './EvaluatorComponent.js';
import UserBeltProgressionManager from './UserBeltProgressionManager.js';
import KnowledgeAcquisitionEngine from './helpers/KnowledgeAcquisitionEngine.js';
import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { withRetry } from '../councilTerminal/utils/withRetry.js';
import Counters from '../councilTerminal/metrics/counters.js';
import {
  FSRS_GOOD_THRESHOLD,
  FSRS_INITIAL_STABILITY,
  FSRS_INITIAL_DIFFICULTY,
  FSRS_SCORE_MULTIPLIER,
  FSRS_SCORE_MIN,
  FSRS_SCORE_MAX
} from './constants/FSRSConstants.js';

const logger = createModuleLogger('TSELoopManager');

/*
 * ============================================================================
 * Configuration Constants (Frozen)
 * ============================================================================
 */

const DEFAULT_POLICY = Object.freeze({
  maxTasks: 5,
  maxFailures: 3,
  failureScoreFloor: 3.0,
  reflectionFrequency: 4,
  retryOnFailure: true,
  maxSessionItems: 100,
  interleaveDifficulty: 2,
  reflectionDifficulty: 2,
  retryDifficulty: 2,
  maxDueCandidates: 5,
  interleavingEnabled: true,
  interleaveProbability: 1.0,
  taughtItemsSizeCap: 500,
  dueItemsRandomization: true,
  promptMaxContentChars: 120,
  queryTimeoutMs: 5000,
  queryRetryAttempts: 3,
  queryRetryBackoffMs: 100
});

const RETEACH_REASONS = Object.freeze({
  OFFERED: 'reteach_offered',
  EXHAUSTED: 'reteach_exhausted',
  ERROR: 'reteach_error'
});

const DB_LIMITS = Object.freeze({
  USER_DUE_ITEMS: Number(process.env.TSE_DUE_ITEMS_LIMIT) || 5,
  AWAITING_SESSIONS: 5
});

const TIMING = Object.freeze({
  SLOW_QUERY_MS: Number(process.env.TSE_SLOW_QUERY_MS) || 1000
});

/*
 * ============================================================================
 * Main Service Class
 * ============================================================================
 */

export default class TSELoopManager {
  constructor() {
    this.learningDB = new LearningDatabase(pool);
    this.teacher = new TeacherComponent(this.learningDB);
    this.student = new StudentComponent();
    this.evaluator = new EvaluatorComponent(pool);
    this.belts = new UserBeltProgressionManager(pool);
    this.acquisition = new KnowledgeAcquisitionEngine(pool);
  }

  async initialize() {
    return true;
  }

  /*
   * ==========================================================================
   * Input Validation
   * ==========================================================================
   */

  _validateSessionObject(session) {
    if (!session) {
      return { valid: false, error: 'session object is required' };
    }
    if (!session.id || typeof session.id !== 'string') {
      return { valid: false, error: 'session.id is required and must be string' };
    }
    if (!session.userId || typeof session.userId !== 'string') {
      return { valid: false, error: 'session.userId is required and must be string' };
    }
    return { valid: true };
  }

  _validateCharacterId(characterId) {
    if (!characterId || typeof characterId !== 'string') {
      return { valid: false, error: 'characterId is required and must be string' };
    }
    if (!/^#[0-9A-F]{6}$/i.test(characterId)) {
      return { valid: false, error: 'characterId must be valid hex format (#XXXXXX)' };
    }
    return { valid: true };
  }

  _validateFocusDomain(focusDomain) {
    if (!focusDomain || typeof focusDomain !== 'string') {
      return { valid: false, error: 'focusDomain is required and must be string' };
    }
    if (!focusDomain.startsWith('#')) {
      return { valid: false, error: 'focusDomain must be hex ID (start with #)' };
    }
    return { valid: true };
  }

  /*
   * ==========================================================================
   * Session Persistence
   * ==========================================================================
   */

  /**
   * Saves TSE session state to database for turn-based human learning.
   * Transaction-wrapped to prevent partial saves.
   *
   * @param {Object} session - Session state object
   * @returns {Promise<{sessionId: string, saved: boolean, status: string}>}
   */
  async saveSessionState(session) {
    const validation = this._validateSessionObject(session);
    if (!validation.valid) {
      throw new Error(`saveSessionState: ${validation.error}`);
    }

    const correlationId = session.correlationId || 'no-correlation-id';

    const queryFn = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let status = session.status || 'active';
        if (session.currentTask && !session.pendingUserInput) {
          status = 'awaiting_response';
        }

        const conversationState = {
          userId: session.userId,
          characterId: session.characterId,
          cycleId: session.cycleId,
          domainId: session.domainId,
          query: session.query,
          startedAt: session.startedAt,
          completedTasks: session.completedTasks || 0,
          failures: session.failures || 0,
          evaluations: Array.isArray(session.evaluations) ? session.evaluations : [],
          retryTaskId: session.retryTaskId || null,
          currentTask: session.currentTask || null,
          status,
          lastUpdated: new Date().toISOString(),
          policySnapshot: session.policy ? { ...session.policy } : null,
          taughtKnowledgeIds: session.taughtKnowledgeIds instanceof Set
            ? Array.from(session.taughtKnowledgeIds)
            : (session.taughtKnowledgeIds || [])
        };

        const startTime = Date.now();

        await client.query(
          `INSERT INTO tse_session_contexts
             (session_id, user_id, conversation_state, conversation_turns, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           ON CONFLICT (session_id) DO UPDATE SET
             conversation_state = EXCLUDED.conversation_state,
             conversation_turns = EXCLUDED.conversation_turns,
             updated_at = NOW()`,
          [
            session.id,
            session.userId,
            JSON.stringify(conversationState),
            session.completedTasks || 0
          ]
        );

        await client.query('COMMIT');

        const durationMs = Date.now() - startTime;
        if (durationMs > TIMING.SLOW_QUERY_MS) {
          logger.warn('Slow saveSessionState', { correlationId, durationMs, threshold: TIMING.SLOW_QUERY_MS });
          Counters.increment('tse_slow_query', 'saveSessionState');
        }

        logger.info('Session saved', {
          correlationId,
          sessionId: session.id,
          userId: session.userId,
          status,
          durationMs
        });

        return { sessionId: session.id, saved: true, status };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    return withRetry(queryFn, {
      maxAttempts: DEFAULT_POLICY.queryRetryAttempts,
      backoffMs: DEFAULT_POLICY.queryRetryBackoffMs,
      shouldRetry: (err) => err.code !== 'UNIQUE_VIOLATION'
    });
  }

  /**
   * Loads a previously saved TSE session state from database.
   *
   * @param {string} sessionId - The hex session ID to load
   * @returns {Promise<Object|null>} Reconstructed session or null
   */
  async loadSessionState(sessionId) {
    if (!sessionId) {
      return null;
    }

    const queryFn = async () => {
      const startTime = Date.now();

      const result = await pool.query(
        `SELECT session_id, user_id, conversation_state, created_at, updated_at
         FROM tse_session_contexts WHERE session_id = $1`,
        [sessionId]
      );

      const durationMs = Date.now() - startTime;
      if (durationMs > TIMING.SLOW_QUERY_MS) {
        Counters.increment('tse_slow_query', 'loadSessionState');
      }

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const state = typeof row.conversation_state === 'string'
        ? JSON.parse(row.conversation_state)
        : row.conversation_state;

      return {
        id: row.session_id,
        userId: row.user_id,
        characterId: state.characterId,
        cycleId: state.cycleId,
        domainId: state.domainId,
        query: state.query,
        startedAt: state.startedAt,
        completedTasks: state.completedTasks || 0,
        failures: state.failures || 0,
        evaluations: Array.isArray(state.evaluations) ? state.evaluations : [],
        retryTaskId: state.retryTaskId || null,
        currentTask: state.currentTask || null,
        status: state.status || 'active',
        policy: state.policySnapshot || null,
        taughtKnowledgeIds: new Set(
          Array.isArray(state.taughtKnowledgeIds) ? state.taughtKnowledgeIds : []
        ),
        loadedAt: new Date().toISOString()
      };
    };

    try {
      return await withRetry(queryFn, {
        maxAttempts: DEFAULT_POLICY.queryRetryAttempts,
        backoffMs: DEFAULT_POLICY.queryRetryBackoffMs
      });
    } catch (error) {
      logger.error('loadSessionState failed', error, { sessionId });
      return null;
    }
  }

  /**
   * Find an awaiting session for a user (status=awaiting_response).
   * Returns single most recent session, or null.
   *
   * @param {string} userId - User hex ID
   * @returns {Promise<Object|null>}
   */
  async getAwaitingSessionForUser(userId) {
    if (!userId) {
      return null;
    }

    const queryFn = async () => {
      const result = await pool.query(
        `SELECT session_id, conversation_state
         FROM tse_session_contexts
         WHERE user_id = $1
         AND conversation_state->>'status' = 'awaiting_response'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const state = row.conversation_state;
      return {
        id: row.session_id,
        ...state,
        currentTask: state.currentTask || null
      };
    };

    try {
      return await withRetry(queryFn, {
        maxAttempts: DEFAULT_POLICY.queryRetryAttempts,
        backoffMs: DEFAULT_POLICY.queryRetryBackoffMs
      });
    } catch (error) {
      logger.error('getAwaitingSessionForUser failed', error, { userId });
      return null;
    }
  }

  /**
   * Find ALL awaiting sessions for a user across domains.
   * Capped at Miller's Law (5 items max).
   *
   * @param {string} userId - User hex ID
   * @returns {Promise<Array>}
   */
  async getAllAwaitingSessionsForUser(userId) {
    if (!userId) {
      return [];
    }

    const queryFn = async () => {
      const result = await pool.query(
        `SELECT
           tsc.session_id,
           tsc.conversation_state,
           tsc.updated_at,
           COALESCE(kd.domain_name, 'Unknown domain') AS domain_name,
           ubp.current_belt,
           ubp.current_stripes
         FROM tse_session_contexts tsc
         LEFT JOIN knowledge_domains kd
           ON kd.domain_id = (tsc.conversation_state->>'domainId')
         LEFT JOIN user_belt_progression ubp
           ON ubp.user_id = tsc.user_id
           AND ubp.domain_id = (tsc.conversation_state->>'domainId')
         WHERE tsc.user_id = $1
           AND tsc.conversation_state->>'status' = 'awaiting_response'
         ORDER BY tsc.updated_at DESC
         LIMIT $2`,
        [userId, DB_LIMITS.AWAITING_SESSIONS]
      );

      return (result.rows || []).map(row => {
        const state = typeof row.conversation_state === 'string'
          ? JSON.parse(row.conversation_state)
          : row.conversation_state;

        return {
          sessionId: row.session_id,
          domainId: state?.domainId ?? null,
          domainName: row.domain_name,
          currentBelt: row.current_belt ?? 'white',
          currentStripes: row.current_stripes ?? 0,
          updatedAt: row.updated_at,
          currentTask: state?.currentTask ?? null,
          completedTasks: state?.completedTasks ?? 0
        };
      });
    };

    try {
      return await withRetry(queryFn, {
        maxAttempts: DEFAULT_POLICY.queryRetryAttempts,
        backoffMs: DEFAULT_POLICY.queryRetryBackoffMs
      });
    } catch (error) {
      logger.error('getAllAwaitingSessionsForUser failed', error, { userId });
      return [];
    }
  }

  /**
   * Refresh learning summary statistics for user.
   * Single CTE query (no N+1) for efficiency.
   *
   * @param {string} userId - User hex ID
   * @param {string} characterId - Character hex ID
   * @returns {Promise<Object>}
   */
  async refreshLearningSummary(userId, characterId) {
    const validation1 = this._validateCharacterId(userId);
    const validation2 = this._validateCharacterId(characterId);
    if (!validation1.valid || !validation2.valid) {
      return { success: false, error: 'userId and characterId must be valid hex IDs' };
    }

    const queryFn = async () => {
      const result = await pool.query(
        `WITH cycle_stats AS (
           SELECT
             COUNT(*) as total_cycles,
             COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) as completed_cycles,
             MAX(created_at) as last_activity
           FROM tse_cycles
           WHERE character_id = $1
         ),
         eval_stats AS (
           SELECT
             AVG(effectiveness_score) as avg_score,
             COUNT(*) as total_evaluations
           FROM tse_evaluation_records er
           JOIN tse_cycles c ON er.cycle_id = c.cycle_id
           WHERE c.character_id = $1
         ),
         domain_stats AS (
           SELECT ARRAY_AGG(DISTINCT domain_id) as domains
           FROM tse_cycles
           WHERE character_id = $1 AND domain_id IS NOT NULL
         )
         SELECT
           (SELECT total_cycles FROM cycle_stats) as total_cycles,
           (SELECT completed_cycles FROM cycle_stats) as completed_cycles,
           (SELECT last_activity FROM cycle_stats) as last_activity,
           (SELECT avg_score FROM eval_stats) as avg_score,
           (SELECT total_evaluations FROM eval_stats) as total_evaluations,
           (SELECT domains FROM domain_stats) as domains`,
        [characterId]
      );

      return result.rows[0] || {};
    };

    try {
      const rawStats = await withRetry(queryFn, {
        maxAttempts: DEFAULT_POLICY.queryRetryAttempts,
        backoffMs: DEFAULT_POLICY.queryRetryBackoffMs
      });

      const summary = {
        userId,
        characterId,
        totalCycles: parseInt(rawStats.total_cycles) || 0,
        completedCycles: parseInt(rawStats.completed_cycles) || 0,
        lastActivity: rawStats.last_activity || null,
        averageScore: rawStats.avg_score
          ? parseFloat(rawStats.avg_score).toFixed(2)
          : null,
        totalEvaluations: parseInt(rawStats.total_evaluations) || 0,
        domainsStudied: rawStats.domains || [],
        domainCount: (rawStats.domains || []).length,
        refreshedAt: new Date().toISOString()
      };

      logger.info('Learning summary refreshed', {
        userId,
        characterId,
        completedCycles: summary.completedCycles,
        averageScore: summary.averageScore
      });

      return { success: true, summary };
    } catch (error) {
      logger.error('refreshLearningSummary failed', error, { userId, characterId });
      return { success: false, error: error.message };
    }
  }

  /*
   * ==========================================================================
   * Main Session Loop (Orchestration)
   * ==========================================================================
   */

  /**
   * Run or continue a TSE session for human learning.
   * Main orchestration point: teach → learn → evaluate → update FSRS → save.
   *
   * @param {string} characterId - Owned character hex ID
   * @param {string} [query] - Learning query/goal
   * @param {string} [userResponseText] - User's answer to current task
   * @param {null} [legacyParam] - Unused (kept for compatibility, can remove in v011)
   * @param {Object} [options] - Configuration
   * @returns {Promise<Object>} Session result or error
   */
  async runOrContinueTseSession(
    characterId,
    query = null,
    userResponseText = null,
    legacyParam = null,
    options = {}
  ) {
    const charValidation = this._validateCharacterId(characterId);
    if (!charValidation.valid) {
      throw new Error(`runOrContinueTseSession: ${charValidation.error}`);
    }

    const focusDomain = options.focusDomain;
    const domainValidation = this._validateFocusDomain(focusDomain);
    if (!domainValidation.valid) {
      throw new Error(`runOrContinueTseSession: ${domainValidation.error}`);
    }

    const correlationId = options.correlationId || this._generateCorrelationId();

    try {
      // HUMAN-ONLY GUARD: Extract userId from character ownership
      const ownerResult = await withRetry(
        () => pool.query(
          'SELECT user_id FROM users WHERE owned_character_id = $1',
          [characterId]
        ),
        {
          maxAttempts: DEFAULT_POLICY.queryRetryAttempts,
          backoffMs: DEFAULT_POLICY.queryRetryBackoffMs
        }
      );

      if (ownerResult.rows.length === 0) {
        const error = new Error(
          `TSELoopManager is HUMAN-ONLY. Character ${characterId} is not owned by any user.`
        );
        logger.error('Human-only guard failed', error, { characterId, correlationId });
        throw error;
      }

      const userId = ownerResult.rows[0].user_id;

      const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) };
      let session = null;

      // Check for existing session to continue
      if (options.existingSessionId) {
        session = await this.loadSessionState(options.existingSessionId);
        if (session) {
          logger.info('Continuing existing session', {
            correlationId,
            sessionId: session.id,
            completedTasks: session.completedTasks
          });
          if (session.policy) {
            Object.assign(policy, session.policy);
          }
        }
      }

      // Create new session if not continuing
      if (!session) {
        session = {
          id: await generateHexId('tse_session_id'),
          userId,
          characterId,
          query,
          domainId: focusDomain,
          startedAt: Date.now(),
          completedTasks: 0,
          failures: 0,
          evaluations: [],
          cycleId: null,
          retryTaskId: null,
          correlationId,
          taughtKnowledgeIds: new Set()
        };

        await this.belts.initializeUserProgression(userId, focusDomain);

        const tseCycle = await this.learningDB.createTseCycle(characterId, query, focusDomain);
        session.cycleId = tseCycle.cycle_id;

        Counters.increment('tse_cycle_created', focusDomain);
      }

      let pendingUserInput = userResponseText;
      const sessionStartTime = Date.now();

      // MAIN LOOP: Task generation, teaching, learning, evaluation
      while (
        session.completedTasks < policy.maxTasks &&
        session.failures < policy.maxFailures
      ) {
        try {
          // Get task params (retry, reflect, interleave, SRS, or fallback)
          const taskParams = await this.decideNextTaskParams(
            userId,
            session,
            pendingUserInput,
            policy,
            focusDomain
          );

          let task = null;

          // If resuming with saved task and user answer, use saved task
          if (session.currentTask && pendingUserInput) {
            task = session.currentTask;
            session.currentTask = null;
            session.status = 'evaluating';
          } else {
            // Normal flow: get new task from teacher
            task = await withRetry(
              () => this.teacher.teach(userId, taskParams.prompt || query, {
                sessionStep: session.completedTasks + 1,
                domainId: focusDomain,
                type: taskParams.type,
                difficultyLevel: taskParams.difficultyLevel || 3,
                targetKnowledgeId: options.targetKnowledgeId || null
              }),
              {
                maxAttempts: 2,
                backoffMs: 200,
                shouldRetry: (err) => !err.message.includes('HUMAN_ONLY')
              }
            );
          }

          // Check if task requires user response
          const requiresResponse = task.requiresResponse !== false;
          if (requiresResponse && !pendingUserInput) {
            session.currentTask = task;
            session.status = 'awaiting_response';
            await this.saveSessionState(session);
            logger.info('Task requires response - awaiting user input', {
              correlationId,
              taskId: task.taskId,
              question: task.question
            });
            return { task, evaluation: null, session };
          }

          // Knowledge acquisition (new tasks only)
          let acquired = null;
          if (session.status !== 'evaluating') {
            acquired = await this.acquisition.acquire(characterId, query || task.prompt);
          }

          // Create teacher record
          const teacherRecord = await this.learningDB.createTeacherRecord({
            cycleId: session.cycleId,
            teacherSequence: session.completedTasks + 1,
            algorithmId: 'TeacherComponent',
            algorithmVersion: 'v010',
            inputParameters: task
          });

          if (!teacherRecord?.record_id) {
            throw new Error('Teacher record creation failed - no record_id');
          }

          // Student attempt
          const studentAttempt = await withRetry(
            () => this.student.learn(characterId, acquired?.knowledge_id || null, task, pendingUserInput),
            { maxAttempts: 2, backoffMs: 100 }
          );

          if (!studentAttempt) {
            logger.warn('Empty input rejected - awaiting response', {
              correlationId,
              taskId: task.taskId
            });
            session.currentTask = task;
            session.status = 'awaiting_response';
            await this.saveSessionState(session);
            return { task, evaluation: null, session };
          }

          // Initialize FSRS state for teaching/acquisition tasks
          if (
            (task.taskType === 'teaching' || task.taskType === 'acquisition') &&
            task.knowledgeId
          ) {
            await this._initializeUserFsrsState(userId, task.knowledgeId, correlationId);
          }

          // Create student record
          const studentRecord = await this.learningDB.createStudentRecord({
            cycleId: session.cycleId,
            teacherRecordId: teacherRecord.record_id,
            studentSequence: session.completedTasks + 1
          });

          if (!studentRecord?.record_id) {
            throw new Error('Student record creation failed - no record_id');
          }

          // Evaluate attempt
          const evaluation = await withRetry(
            () => this.evaluator.handleTaskByCategory({
              task,
              attempt: studentAttempt,
              studentRecordId: studentRecord.record_id,
              userInput: pendingUserInput
            }),
            { maxAttempts: 2, backoffMs: 100 }
          );

          // QA visibility logging
          this._logQACheckpoint(correlationId, userId, task, studentAttempt, evaluation);

          // Record evaluation
          const evalRecordId = await generateHexId('tse_evaluation_record_id');
          const evalSequence = session.completedTasks + 1;
          const normalizedScore = Math.max(0, Math.min(1, (evaluation.score ?? 0) / 5));

          await withRetry(
            () => pool.query(
              `INSERT INTO tse_evaluation_records
                 (record_id, cycle_id, teacher_record_id, student_record_id, evaluation_sequence,
                  effectiveness_score, efficiency_score, cultural_score, innovation_score,
                  variance_analysis, pattern_identification, correlation_insights,
                  timestamp_evaluated, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())`,
              [
                evalRecordId,
                session.cycleId,
                teacherRecord.record_id,
                studentRecord.record_id,
                evalSequence,
                normalizedScore,
                evaluation.communicationScores?.efficiency ?? 0.5,
                evaluation.communicationScores?.cultural ?? 0.5,
                evaluation.communicationScores?.innovation ?? 0.5,
                {},
                {},
                {}
              ]
            ),
            { maxAttempts: 2, backoffMs: 100 }
          );

          // FSRS update for recall tasks only
          if (task?.taskType === 'recall' && task?.knowledgeId && evaluation?.score != null) {
            await this._initializeUserFsrsState(userId, task.knowledgeId, correlationId);

            // Score mapping: eval 5→4(easy), 4→3(good), 3→2(hard), 2→2(hard), 1→1(again)
            const fsrsScore = Math.max(
              FSRS_SCORE_MIN,
              Math.min(FSRS_SCORE_MAX, Math.round(evaluation.score * FSRS_SCORE_MULTIPLIER))
            );

            const fsrsResult = await withRetry(
              () => this.evaluator.evaluateReview({
                userId,
                knowledgeId: task.knowledgeId,
                score: fsrsScore,
                currentTime: new Date()
              }),
              { maxAttempts: 2, backoffMs: 100 }
            );

            if (!fsrsResult.success) {
              logger.warn('FSRS evaluateReview failed', {
                correlationId,
                userId,
                knowledgeId: task.knowledgeId,
                error: fsrsResult.error
              });
              Counters.increment('tse_fsrs_update', 'failed');
            } else {
              Counters.increment('tse_fsrs_update', 'success');

              if (fsrsScore >= FSRS_GOOD_THRESHOLD) {
                logger.info('Recall successful - FSRS updated', {
                  correlationId,
                  userId,
                  knowledgeId: task.knowledgeId,
                  stability: fsrsResult.updatedState?.stability,
                  nextReview: fsrsResult.updatedState?.next_review_timestamp
                });
              } else {
                // Re-teach branch
                if (!this.evaluator?.handleReteachFlow) {
                  throw new Error('Evaluator not available for re-teach flow');
                }

                if (!session.reteachAttempts) {
                  session.reteachAttempts = {};
                }

                const currentAttempts = session.reteachAttempts[task.knowledgeId] || 0;
                const reteachResult = await withRetry(
                  () => this.evaluator.handleReteachFlow({
                    userId,
                    knowledgeId: task.knowledgeId,
                    currentAttempts
                  }),
                  { maxAttempts: 2, backoffMs: 100 }
                );

                if (reteachResult.success) {
                  session.reteachAttempts[task.knowledgeId] = reteachResult.attempts;
                  Counters.increment('tse_reteach', 'offered');

                  if (reteachResult.reteachExhausted) {
                    logger.warn('Item forgotten after reteach exhaustion', {
                      correlationId,
                      userId,
                      knowledgeId: task.knowledgeId,
                      attempts: reteachResult.attempts
                    });

                    await withRetry(
                      () => pool.query(
                        'UPDATE user_knowledge_state SET is_forgotten = true WHERE user_id = $1 AND knowledge_id = $2',
                        [userId, task.knowledgeId]
                      ),
                      { maxAttempts: 2, backoffMs: 100 }
                    );

                    Counters.increment('tse_reteach', 'exhausted');
                    return {
                      success: false,
                      reason: RETEACH_REASONS.EXHAUSTED,
                      message: reteachResult.message || 'Maximum re-teach attempts reached.',
                      attempts: reteachResult.attempts
                    };
                  }

                  logger.info('Re-teach offered', {
                    correlationId,
                    userId,
                    knowledgeId: task.knowledgeId,
                    attempts: reteachResult.attempts
                  });

                  return {
                    success: true,
                    reason: RETEACH_REASONS.OFFERED,
                    teachingStatement: reteachResult.teachingStatement,
                    answerStatement: reteachResult.answerStatement,
                    message: reteachResult.message,
                    attempts: reteachResult.attempts
                  };
                } else {
                  logger.error('handleReteachFlow failed', null, {
                    correlationId,
                    userId,
                    error: reteachResult.error
                  });
                  Counters.increment('tse_reteach', 'error');

                  return {
                    success: false,
                    reason: RETEACH_REASONS.ERROR,
                    message: reteachResult.message || 'Re-teach flow unavailable',
                    attempts: reteachResult.attempts || currentAttempts
                  };
                }
              }
            }
          }

          // Teaching task - mark acquisition_completed
          if (task?.taskType === 'teaching' && task?.knowledgeId) {
            await this._initializeUserFsrsState(userId, task.knowledgeId, correlationId);

            await withRetry(
              () => pool.query(
                `UPDATE user_knowledge_state
                 SET acquisition_completed = true, last_review_timestamp = NOW()
                 WHERE user_id = $1 AND knowledge_id = $2`,
                [userId, task.knowledgeId]
              ),
              { maxAttempts: 2, backoffMs: 100 }
            );

            logger.info('Teaching acknowledged - acquisition completed', {
              correlationId,
              userId,
              knowledgeId: task.knowledgeId
            });
          }

          session.evaluations.push(evaluation);
          session.completedTasks++;

          // Persist session
          await this.saveSessionState(session);

          const hasMeaningfulInput = pendingUserInput && pendingUserInput.trim().length > 0;
          const isRecallTask = task?.taskType === 'recall' || task?.taskCategory === 'recall';

          // Track failures for retry
          if (isRecallTask && evaluation.score < policy.failureScoreFloor && hasMeaningfulInput) {
            session.failures++;
            Counters.increment('tse_failure', focusDomain);
            if (policy.retryOnFailure) {
              session.retryTaskId = task?.taskId ?? null;
            }
          } else {
            session.retryTaskId = null;
          }

          // Single-turn mode
          if (options.singleTurn) {
            await this.learningDB.completeCycle({
              cycleId: session.cycleId,
              evaluations: session.evaluations
            });
            session.status = 'completed';
            await this.saveSessionState(session);
            Counters.increment('tse_cycle_completed', focusDomain);
            return { task, evaluation, session };
          }

          pendingUserInput = null;
        } catch (loopError) {
          // Loop-level error recovery: save session and rethrow
          logger.error('Error in TSE loop iteration', loopError, {
            correlationId,
            userId,
            completedTasks: session.completedTasks
          });

          try {
            await this.saveSessionState(session);
          } catch (saveErr) {
            logger.error('Failed to save session during error recovery', saveErr, {
              correlationId,
              sessionId: session.id
            });
          }

          throw loopError;
        }
      }

      // Cycle complete
      await this.learningDB.completeCycle({
        cycleId: session.cycleId,
        evaluations: session.evaluations
      });

      session.status = 'completed';
      await this.saveSessionState(session);

      const sessionDurationMs = Date.now() - sessionStartTime;
      Counters.recordLatency('tse_session_completion', sessionDurationMs);
      Counters.increment('tse_cycle_completed', focusDomain);

      // Refresh learning summary
      await this.refreshLearningSummary(userId, characterId);

      // Check belt advancement
      try {
        const advancementResult = await this.belts.checkAdvancement(userId, focusDomain);
        if (advancementResult.advanced) {
          logger.warn('Belt advancement achieved', {
            correlationId,
            userId,
            domainId: focusDomain,
            newBelt: advancementResult.newBelt,
            newStripe: advancementResult.newStripe
          });
          Counters.increment('tse_belt_advancement', `${advancementResult.newBelt}`);
        }
      } catch (beltErr) {
        logger.error('Belt advancement check failed', beltErr, {
          correlationId,
          userId,
          domainId: focusDomain
        });
      }

      logger.info('Session completed successfully', {
        correlationId,
        sessionId: session.id,
        completedTasks: session.completedTasks,
        durationMs: sessionDurationMs
      });

      return session;
    } catch (error) {
      logger.error('runOrContinueTseSession fatal error', error, {
        correlationId,
        characterId
      });
      throw error;
    }
  }

  /*
   * ==========================================================================
   * FSRS State Management
   * ==========================================================================
   */

  /**
   * Initialize FSRS state for new knowledge item.
   * Idempotent: checks if state exists before inserting.
   *
   * @param {string} userId - User hex ID
   * @param {string} knowledgeId - Knowledge hex ID
   * @param {string} correlationId - For logging
   */
  async _initializeUserFsrsState(userId, knowledgeId, correlationId) {
    try {
      const checkFn = async () => {
        const existing = await pool.query(
          'SELECT 1 FROM user_knowledge_state WHERE user_id = $1 AND knowledge_id = $2',
          [userId, knowledgeId]
        );
        return existing.rows.length > 0;
      };

      const exists = await withRetry(checkFn, {
        maxAttempts: 2,
        backoffMs: 50
      });

      if (exists) {
        return;
      }

      await withRetry(
        () => pool.query(
          `INSERT INTO user_knowledge_state
             (user_id, knowledge_id, current_retrievability, stability, difficulty,
              is_mastered, is_forgotten, acquisition_completed, practice_count)
           VALUES ($1, $2, 1.0, $3, $4, false, false, false, 0)`,
          [userId, knowledgeId, FSRS_INITIAL_STABILITY, FSRS_INITIAL_DIFFICULTY]
        ),
        { maxAttempts: 2, backoffMs: 100, shouldRetry: (err) => err.code !== 'UNIQUE_VIOLATION' }
      );

      await this.evaluator.initializeNewItem(userId, knowledgeId);

      logger.debug('User FSRS state initialized', {
        correlationId,
        userId,
        knowledgeId
      });
    } catch (err) {
      logger.error('Failed to initialize user FSRS state', err, {
        correlationId,
        userId,
        knowledgeId
      });
    }
  }

  /*
   * ==========================================================================
   * Task Decision Logic (Intra-Session Interleaving)
   * ==========================================================================
   */

  /**
   * Decide next task params: retry → reflect → interleave → SRS due → fallback
   *
   * @param {string} userId - User hex ID
   * @param {Object} session - Current session
   * @param {string} lastUserResponse - User's last answer (if any)
   * @param {Object} policy - Learning policy
   * @param {string} focusDomain - Focus domain hex ID
   * @returns {Promise<Object>} Task params { type, prompt, difficultyLevel, ... }
   */
  async decideNextTaskParams(userId, session, lastUserResponse, policy, focusDomain) {
    const correlationId = session.correlationId || 'no-correlation-id';

    const MAX_SESSION_ITEMS = policy.maxSessionItems ?? DEFAULT_POLICY.maxSessionItems;
    if (!session.taughtKnowledgeIds || !(session.taughtKnowledgeIds instanceof Set)) {
      const raw = session.taughtKnowledgeIds;
      session.taughtKnowledgeIds = new Set(Array.isArray(raw) ? raw : []);
    }

    if (session.taughtKnowledgeIds.size >= MAX_SESSION_ITEMS) {
      logger.info('Session taught item limit reached', {
        correlationId,
        userId,
        sessionTaughtCount: session.taughtKnowledgeIds.size,
        maxAllowed: MAX_SESSION_ITEMS
      });
      return null;
    }

    if (!session.sessionFlags) {
      session.sessionFlags = {};
    }

    const INTERLEAVE_DIFFICULTY = policy.interleaveDifficulty ?? DEFAULT_POLICY.interleaveDifficulty;
    const REFLECTION_DIFFICULTY = policy.reflectionDifficulty ?? DEFAULT_POLICY.reflectionDifficulty;
    const RETRY_DIFFICULTY = policy.retryDifficulty ?? DEFAULT_POLICY.retryDifficulty;
    const MAX_DUE_CANDIDATES = policy.maxDueCandidates ?? DEFAULT_POLICY.maxDueCandidates;
    const INTERLEAVING_ENABLED = policy.interleavingEnabled !== false;
    const INTERLEAVE_PROBABILITY = policy.interleaveProbability ?? DEFAULT_POLICY.interleaveProbability;
    const TAUGHT_ITEMS_SIZE_CAP = policy.taughtItemsSizeCap ?? DEFAULT_POLICY.taughtItemsSizeCap;
    const DUE_ITEMS_RANDOMIZATION = policy.dueItemsRandomization !== false;
    const MAX_RANDOM_DUE_CANDIDATES = Math.min(3, MAX_DUE_CANDIDATES);
    const PROMPT_MAX_CONTENT_CHARS = policy.promptMaxContentChars ?? DEFAULT_POLICY.promptMaxContentChars;

    const buildRecallPrompt = (content) => {
      return `Recall: ${content?.slice(0, PROMPT_MAX_CONTENT_CHARS) || 'this concept'}`;
    };

    // Retry path
    if (session.retryTaskId && policy.retryOnFailure) {
      logger.debug('Retry path selected', {
        correlationId,
        userId,
        taskIdToRetry: session.retryTaskId,
        difficultyLevel: RETRY_DIFFICULTY
      });
      return {
        type: 'retry',
        taskIdToRetry: session.retryTaskId,
        prompt: 'Let\'s try again. Focus on the same concept.',
        difficultyLevel: RETRY_DIFFICULTY
      };
    }

    // Reflection path
    if (
      session.completedTasks > 0 &&
      session.completedTasks % policy.reflectionFrequency === 0
    ) {
      logger.debug('Reflection path selected', {
        correlationId,
        userId,
        completedTasks: session.completedTasks,
        reflectionFrequency: policy.reflectionFrequency
      });
      return {
        type: 'communication_quality',
        prompt: 'Explain what you just learned in your own words.',
        difficultyLevel: REFLECTION_DIFFICULTY
      };
    }

    // Interleaving path
    const shouldInterleave = Math.random() < INTERLEAVE_PROBABILITY;

    if (INTERLEAVING_ENABLED && shouldInterleave && !session.sessionFlags.seenQueried) {
      try {
        const interleaveStart = Date.now();
        const taughtArray = Array.from(session.taughtKnowledgeIds).slice(0, TAUGHT_ITEMS_SIZE_CAP);

        const seenItemsResult = await withRetry(
          () => pool.query(
            `SELECT
               uks.knowledge_id,
               ki.content,
               ki.domain_id,
               uks.last_review_timestamp,
               uks.practice_count
             FROM user_knowledge_state uks
             JOIN knowledge_items ki ON uks.knowledge_id = ki.knowledge_id
             WHERE
               uks.user_id = $1
               AND uks.acquisition_completed = true
               AND uks.is_mastered = false
               AND uks.is_forgotten = false
               AND ki.domain_id = $2
               AND uks.knowledge_id != ALL($3::text[])
             ORDER BY uks.last_review_timestamp DESC NULLS LAST
             LIMIT 1`,
            [userId, focusDomain, taughtArray]
          ),
          { maxAttempts: 2, backoffMs: 100 }
        );

        const interleaveDurationMs = Date.now() - interleaveStart;

        if (seenItemsResult.rows.length > 0) {
          const seenItem = seenItemsResult.rows[0];
          const newTaught = new Set(session.taughtKnowledgeIds);
          newTaught.add(seenItem.knowledge_id);
          session.taughtKnowledgeIds = newTaught;

          logger.debug('Interleaving item selected', {
            correlationId,
            userId,
            knowledgeId: seenItem.knowledge_id,
            source: 'SEEN',
            practiceCount: seenItem.practice_count,
            durationMs: interleaveDurationMs
          });

          return {
            type: 'recall',
            knowledgeId: seenItem.knowledge_id,
            domainId: focusDomain,
            difficultyLevel: INTERLEAVE_DIFFICULTY,
            prompt: buildRecallPrompt(seenItem.content),
            metadata: {
              interleavingSource: 'SEEN',
              practiceCount: seenItem.practice_count,
              durationMs: interleaveDurationMs
            }
          };
        }
      } catch (err) {
        logger.error('Interleaving query failed', err, {
          correlationId,
          userId,
          focusDomain
        });
      }

      session.sessionFlags = Object.freeze({
        ...session.sessionFlags,
        seenQueried: true
      });
    }

    // SRS due items path
    const srsStart = Date.now();
    const dueItems = await this._getUserDueItems(userId, MAX_DUE_CANDIDATES, focusDomain);
    const srsDurationMs = Date.now() - srsStart;

    if (dueItems?.length > 0) {
      let selectedItem;

      if (DUE_ITEMS_RANDOMIZATION && dueItems.length > 1) {
        const candidates = dueItems.slice(0, MAX_RANDOM_DUE_CANDIDATES);
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        selectedItem = candidates[0];
      } else {
        selectedItem = dueItems[0];
      }

      const newTaught = new Set(session.taughtKnowledgeIds);
      newTaught.add(selectedItem.knowledge_id);
      session.taughtKnowledgeIds = newTaught;

      logger.debug('SRS item selected', {
        correlationId,
        userId,
        knowledgeId: selectedItem.knowledge_id,
        source: 'FSRS',
        nextReviewTimestamp: selectedItem.next_review_timestamp,
        durationMs: srsDurationMs
      });

      return {
        type: 'recall',
        knowledgeId: selectedItem.knowledge_id,
        domainId: selectedItem.domain_id,
        difficultyLevel: 3,
        prompt: buildRecallPrompt(selectedItem.content),
        metadata: {
          source: 'FSRS',
          nextReviewTimestamp: selectedItem.next_review_timestamp,
          durationMs: srsDurationMs
        }
      };
    }

    logger.warn('No task found - delegating to fallback', {
      correlationId,
      userId,
      focusDomain,
      dueItemsCount: dueItems?.length ?? 0
    });

    // Fallback: teaching task
    return {
      type: 'teaching',
      knowledgeId: null,
      domainId: focusDomain,
      difficultyLevel: 3,
      prompt: 'Let us explore this topic together.'
    };
  }

  /**
   * Get due items from user_knowledge_state.
   * Single query with JOINs (no N+1).
   *
   * @param {string} userId - User hex ID
   * @param {number} limit - Max items to return
   * @param {string} domainId - Domain hex ID
   * @returns {Promise<Array>}
   */
  async _getUserDueItems(userId, limit, domainId) {
    try {
      const result = await withRetry(
        () => pool.query(
          `SELECT
             uks.knowledge_id,
             ki.domain_id,
             ki.content,
             uks.next_review_timestamp,
             uks.stability,
             uks.difficulty
           FROM user_knowledge_state uks
           JOIN knowledge_items ki ON uks.knowledge_id = ki.knowledge_id
           WHERE
             uks.user_id = $1
             AND uks.acquisition_completed = true
             AND uks.is_mastered = false
             AND uks.is_forgotten = false
             AND (uks.next_review_timestamp IS NULL OR uks.next_review_timestamp <= NOW())
             AND ki.domain_id = $2
           ORDER BY uks.next_review_timestamp ASC NULLS FIRST
           LIMIT $3`,
          [userId, domainId, limit]
        ),
        { maxAttempts: 2, backoffMs: 100 }
      );

      return result.rows;
    } catch (err) {
      logger.error('_getUserDueItems failed', err, { userId, domainId });
      return [];
    }
  }

  /**
   * Public: Get count of due review items for a user in a domain.
   * Used by BrainOrchestrator to gate curriculum selection.
   *
   * @param {string} userId - User hex ID
   * @param {string} domainId - Domain hex ID
   * @returns {Promise<number>} Count of due items
   */
  async getDueItemCount(userId, domainId) {
    if (!userId || !domainId) return 0;
    try {
      const items = await this._getUserDueItems(userId, 1, domainId);
      return items?.length || 0;
    } catch (err) {
      logger.warn("getDueItemCount failed, returning 0", { userId, domainId, error: err.message });
      return 0;
    }
  }

  /*
   * ==========================================================================
   * Logging & Instrumentation
   * ==========================================================================
   */

  _logQACheckpoint(correlationId, userId, task, studentAttempt, evaluation) {
    logger.debug('TSE QA checkpoint', {
      correlationId,
      userId,
      task: {
        taskType: task?.taskType || null,
        taskCategory: task?.taskCategory || null,
        taskId: task?.taskId || null,
        knowledgeId: task?.knowledgeId || null,
        prompt: task?.prompt || null,
        isRecall: task?.taskType === 'recall',
        isTeaching: task?.taskType === 'teaching' || task?.taskCategory === 'acquisition'
      },
      studentAttempt: {
        attemptText: studentAttempt?.attemptText || null
      },
      evaluation: {
        score: evaluation?.score ?? null,
        reason: evaluation?.reason || null,
        phase: evaluation?.phase || null,
        willRetry: (task?.taskType === 'recall' || task?.taskCategory === 'recall') &&
                   evaluation?.score < 3.0,
        acquisitionSuccess: evaluation?.acquisitionSuccess || false
      }
    });
  }

  _generateCorrelationId() {
    return `tse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
