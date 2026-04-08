/**
 * =============================================================================
 * EvaluatorComponent — FSRS Scoring and Task Evaluation Engine
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Scores student attempts via multiple evaluation paths:
 *   1. FSRS review — spaced repetition state updates (stability, difficulty)
 *   2. Acquisition/teaching — engagement-based scoring (first exposure)
 *   3. Communication quality — PAD distance + intent matching
 *   4. Rewrite tasks — length ratio, connectors, clarity checks
 *
 * Handles re-teach flow when recall scores fall below threshold.
 * Initialises FSRS state for newly acquired knowledge items.
 *
 * PROTECTION CONTRACT:
 * ---------------------------------------------------------------------------
 * This component has NO internal human-only guard.
 * Protection is enforced by TSELoopManager.runOrContinueTseSession() which
 * verifies users.owned_character_id BEFORE calling any methods here.
 * Do NOT add redundant guards — single enforcement point is intentional.
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TSELoopManager.js — calls handleTaskByCategory, evaluateReview,
 *                        handleReteachFlow, initializeNewItem
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 *   fsrs_core.js — FSRS algorithm pure functions
 *   FSRSConstants.js — weights, ratings, thresholds
 *   LearningStateEnum.js — learning state transitions
 *   SemanticAnswerEvaluator.js — recall task scoring
 *   hexIdGenerator.js — hex ID generation for evaluation records
 *   logger.js — structured logging with correlation IDs
 *
 * PUBLIC METHODS (TSELoopManager interface):
 * ---------------------------------------------------------------------------
 *   handleTaskByCategory({ task, attempt, padSnapshot }, opts)
 *   evaluateReview({ userId, knowledgeId, score, currentTime }, opts)
 *   handleReteachFlow({ userId, knowledgeId, currentAttempts }, opts)
 *   initializeNewItem(userId, knowledgeId, opts)
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Structured logger (no console.log, no string concatenation)
 *   - Counters on all evaluation paths
 *   - _query helper with labeled timeout protection
 *   - Hex ID validation on public method inputs
 *   - correlationId threading via opts parameter
 *   - Frozen constants for all magic numbers
 *   - Named export alongside default
 *   - Single pool source via constructor (no module-level pool import)
 *
 * =============================================================================
 */

import {
  computeDecay,
  computeFactor,
  forgettingCurve,
  nextInterval,
  nextDifficulty,
  nextRecallStability,
  nextForgetStability,
  initDifficulty,
  initStability
} from './fsrs/fsrs_core.js';
import semanticAnswerEvaluator from './helpers/SemanticAnswerEvaluator.js';
import { createModuleLogger } from '../utils/logger.js';
import { LEARNING_STATE } from './constants/LearningStateEnum.js';
import {
  MAX_RETEACH_ATTEMPTS,
  FSRS_GOOD_THRESHOLD,
  FSRS_WEIGHTS,
  FSRS_RATINGS,
  FSRS_REQUEST_RETENTION,
  FSRS_MAXIMUM_INTERVAL
} from './constants/FSRSConstants.js';
import generateHexId from '../utils/hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('EvaluatorComponent');

/* ==========================================================================
 * Frozen Constants
 * ========================================================================== */

const FSRS_DECAY = computeDecay(FSRS_WEIGHTS);
const FSRS_FACTOR = computeFactor(FSRS_DECAY);

const DEFAULTS = Object.freeze({
  MS_PER_DAY: 86400000,
  QUERY_TIMEOUT_MS: 8000,
  RETEACH_QUERY_TIMEOUT_MS: 5000,
  MAX_CONTENT_LENGTH: 2000,
  TEACHING_THRESHOLDS: Object.freeze({
    MINIMAL: 5,
    BRIEF: 30
  }),
  SCORE_RATING_MAP: Object.freeze({
    1: 'again',
    2: 'hard',
    3: 'good',
    4: 'easy'
  })
});

/* ==========================================================================
 * Counters
 * ========================================================================== */

/* ==========================================================================
 * EvaluatorComponent CLASS
 * ========================================================================== */

class EvaluatorComponent {

  /**
   * @param {object} dbPool — PostgreSQL pool instance (single source)
   */
  constructor(dbPool) {
    this.pool = dbPool;
  }

  /* ═══════════════════════════════════════════════
     QUERY HELPER — labeled timeout protection
  ═══════════════════════════════════════════════ */

  async _query(label, sql, params, opts = {}) {
    const timeout = opts.timeout || DEFAULTS.QUERY_TIMEOUT_MS;
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
    if (!value || typeof value !== 'string' || !value.startsWith('#')) {
      return false;
    }
    return /^#[0-9A-Fa-f]{6}$/.test(value);
  }

  /* ═══════════════════════════════════════════════
     CATEGORY ROUTER
  ═══════════════════════════════════════════════ */

  async handleTaskByCategory({ task, attempt, padSnapshot }, opts = {}) {
    const correlationId = opts.correlationId || null;
    const category = task.taskCategory || 'unknown';

    logger.debug('Routing evaluation by category', {
      correlationId,
      category,
      phase: task.taskPhase || 'n/a',
      type: task.taskType || task.task_type || 'n/a'
    });

    switch (category) {
      case 'acquisition':
        Counters.increment('handleTaskByCategory.acquisition');
        return this.evaluateTaskAttempt({ task, attempt, padSnapshot }, opts);

      case 'communication_quality':
        Counters.increment('handleTaskByCategory.communication_quality');
        return this.evaluateCommunicationQuality(task, attempt, opts);

      case 'rewrite':
      case 'clarity':
      case 'summary':
        Counters.increment('handleTaskByCategory.rewrite');
        return this.evaluateRewriteTask(task.taskType || task.task_type, task, attempt, opts);

      default:
        Counters.increment('handleTaskByCategory.unknown');
        logger.warn('No handler for evaluation category', { correlationId, category });
        return {
          score: 1,
          reason: 'category_not_implemented_yet',
          category,
          taskType: task?.taskType || null,
          taskCategory: task?.taskCategory || null
        };
    }
  }

  /* ═══════════════════════════════════════════════
     FSRS REVIEW — Core spaced repetition evaluation
  ═══════════════════════════════════════════════ */

  async evaluateReview({ userId, knowledgeId, score, currentTime }, opts = {}) {
    const correlationId = opts.correlationId || null;

    logger.debug('evaluateReview called', { correlationId, userId, knowledgeId, score });

    if (!userId || !knowledgeId || score === undefined) {
      Counters.increment('evaluateReview.invalid_params');
      throw new Error('Missing required parameters for review');
    }

    const learningState = await this._getLearningState(userId, knowledgeId, opts);
    if (learningState === LEARNING_STATE.UNSEEN || learningState === LEARNING_STATE.SEEN) {
      Counters.increment('evaluateReview.blocked_teaching');
      logger.debug('FSRS blocked: teaching not retrieval', {
        correlationId, learningState
      });
      return { success: false, blocked: true, reason: 'teaching_not_retrieval', learningState };
    }

    const rating = this._mapScoreToRating(score);
    const now = currentTime ? new Date(currentTime) : new Date();

    const state = await this._loadState(userId, knowledgeId, opts);
    const updatedState = this._applyFSRS(state, rating, now);

    await this._persistState(userId, knowledgeId, updatedState, score, opts);
    await this._logRetrievability(userId, knowledgeId, state, updatedState, score, rating, now, opts);

    Counters.increment('evaluateReview.success');

    return {
      success: true,
      nextReview: updatedState.next_review_timestamp,
      updatedState
    };
  }

  /* ═══════════════════════════════════════════════
     LEARNING STATE CHECK
  ═══════════════════════════════════════════════ */

  async _getLearningState(userId, knowledgeId, opts = {}) {
    const correlationId = opts.correlationId || null;

    try {
      const res = await this._query('getLearningState',
        'SELECT is_mastered, is_forgotten, acquisition_completed, next_review_timestamp FROM user_knowledge_state WHERE user_id = $1 AND knowledge_id = $2',
        [userId, knowledgeId],
        { correlationId }
      );

      if (res.rows.length === 0) {
        return LEARNING_STATE.UNSEEN;
      }

      const row = res.rows[0];
      if (!row.acquisition_completed) return LEARNING_STATE.SEEN;
      if (row.next_review_timestamp) return LEARNING_STATE.SCHEDULED;
      return LEARNING_STATE.RETRIEVABLE;
    } catch (err) {
      logger.error('_getLearningState failed', err, { correlationId, userId, knowledgeId });
      return LEARNING_STATE.UNSEEN;
    }
  }

  /* ═══════════════════════════════════════════════
     SCORE TO RATING MAPPING
  ═══════════════════════════════════════════════ */

  _mapScoreToRating(score) {
    const clamped = Math.max(1, Math.min(4, Math.round(score)));
    return DEFAULTS.SCORE_RATING_MAP[clamped];
  }

  /* ═══════════════════════════════════════════════
     FSRS STATE LOADING
  ═══════════════════════════════════════════════ */

  async _loadState(userId, knowledgeId, opts = {}) {
    const correlationId = opts.correlationId || null;

    const res = await this._query('loadState',
      `SELECT difficulty, stability,
              last_review_timestamp, next_review_timestamp,
              grade_history, practice_count,
              is_mastered, is_forgotten, acquisition_completed, current_retrievability
       FROM user_knowledge_state
       WHERE user_id = $1 AND knowledge_id = $2`,
      [userId, knowledgeId],
      { correlationId }
    );

    if (res.rows.length === 0) {
      return {
        difficulty: initDifficulty('good', FSRS_WEIGHTS, FSRS_RATINGS),
        stability: initStability('good', FSRS_WEIGHTS, FSRS_RATINGS),
        last_review_timestamp: null,
        next_review_timestamp: null,
        grade_history: [],
        practice_count: 0,
        isNew: true
      };
    }

    const state = res.rows[0];
    state.grade_history = state.grade_history || [];
    state.practice_count = state.practice_count || 0;
    state.isNew = false;
    return state;
  }

  /* ═══════════════════════════════════════════════
     FSRS CORE APPLICATION
  ═══════════════════════════════════════════════ */

  _applyFSRS(state, rating, now) {
    const nowMs = now.getTime();

    let elapsedDays = 0;
    if (state.last_review_timestamp) {
      const lastMs = new Date(state.last_review_timestamp).getTime();
      elapsedDays = (nowMs - lastMs) / DEFAULTS.MS_PER_DAY;
    }

    let retrievability = 1.0;
    if (elapsedDays > 0 && state.stability > 0) {
      retrievability = forgettingCurve(elapsedDays, state.stability, FSRS_FACTOR, FSRS_DECAY);
    }

    const initDiffEasy = initDifficulty('easy', FSRS_WEIGHTS, FSRS_RATINGS);

    const newDifficulty = nextDifficulty(
      state.difficulty,
      rating,
      FSRS_WEIGHTS,
      FSRS_RATINGS,
      initDiffEasy
    );

    let newStability;
    if (rating === 'again') {
      newStability = nextForgetStability(
        state.difficulty,
        state.stability,
        retrievability,
        FSRS_WEIGHTS
      );
    } else {
      newStability = nextRecallStability(
        state.difficulty,
        state.stability,
        retrievability,
        rating,
        FSRS_WEIGHTS
      );
    }

    const intervalDays = nextInterval(
      newStability,
      FSRS_REQUEST_RETENTION,
      FSRS_FACTOR,
      FSRS_DECAY,
      FSRS_MAXIMUM_INTERVAL
    );

    const nextReviewMs = nowMs + intervalDays * DEFAULTS.MS_PER_DAY;

    return {
      difficulty: newDifficulty,
      stability: newStability,
      last_review_timestamp: now.toISOString(),
      next_review_timestamp: new Date(nextReviewMs).toISOString(),
      grade_history: [
        ...(state.grade_history || []),
        { score: FSRS_RATINGS[rating], rating, timestamp: now.toISOString() }
      ],
      practice_count: (state.practice_count || 0) + 1,
      _meta: {
        elapsedDays,
        retrievabilityBefore: retrievability,
        intervalDays
      }
    };
  }

  /* ═══════════════════════════════════════════════
     FSRS STATE PERSISTENCE
  ═══════════════════════════════════════════════ */

  async _persistState(userId, knowledgeId, updatedState, score, opts = {}) {
    const correlationId = opts.correlationId || null;

    try {
      const retrievability = updatedState._meta?.retrievabilityBefore ?? 1.0;
      const sql = `
        INSERT INTO user_knowledge_state (
          user_id, knowledge_id, difficulty, stability,
          grade_history, practice_count,
          last_review_timestamp, next_review_timestamp,
          current_retrievability, acquisition_completed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
        ON CONFLICT (user_id, knowledge_id)
        DO UPDATE SET
          difficulty = EXCLUDED.difficulty,
          stability = EXCLUDED.stability,
          grade_history = EXCLUDED.grade_history,
          practice_count = EXCLUDED.practice_count,
          last_review_timestamp = EXCLUDED.last_review_timestamp,
          next_review_timestamp = EXCLUDED.next_review_timestamp,
          current_retrievability = EXCLUDED.current_retrievability,
          acquisition_completed = true
      `;

      await this._query('persistState', sql, [
        userId,
        knowledgeId,
        updatedState.difficulty,
        updatedState.stability,
        JSON.stringify(updatedState.grade_history || []),
        updatedState.practice_count,
        updatedState.last_review_timestamp,
        updatedState.next_review_timestamp,
        retrievability
      ], { correlationId });

      Counters.increment('_persistState.success');
      logger.debug('FSRS state persisted', {
        correlationId, userId, knowledgeId, score,
        stability: updatedState.stability,
        interval: updatedState._meta?.intervalDays
      });
      return { success: true };
    } catch (err) {
      Counters.increment('_persistState.error');
      logger.error('_persistState failed', err, { correlationId, userId, knowledgeId });
      return { success: false, error: err.message };
    }
  }

  /* ═══════════════════════════════════════════════
     RETRIEVABILITY LOGGING (Analytics)
  ═══════════════════════════════════════════════ */

  async _logRetrievability(userId, knowledgeId, stateBefore, stateAfter, score, rating, timestamp, opts = {}) {
    const correlationId = opts.correlationId || null;

    try {
      const nextDate = stateAfter.next_review_timestamp
        ? stateAfter.next_review_timestamp.split('T')[0]
        : 'N/A';

      logger.debug('FSRS audit', {
        correlationId,
        knowledgeId,
        score,
        rating,
        stabilityBefore: stateBefore.stability?.toFixed(1) || '0',
        stabilityAfter: stateAfter.stability?.toFixed(1) || '0',
        difficultyBefore: stateBefore.difficulty?.toFixed(1) || '5',
        difficultyAfter: stateAfter.difficulty?.toFixed(1) || '5',
        intervalDays: stateAfter._meta?.intervalDays?.toFixed(0) || '?',
        nextReview: nextDate,
        retrievabilityBefore: stateAfter._meta?.retrievabilityBefore || null,
        elapsedDays: stateAfter._meta?.elapsedDays || null
      });

      return { success: true };
    } catch (err) {
      logger.error('FSRS analytics logging failed', err, { correlationId, userId, knowledgeId });
      return { success: false };
    }
  }

  /* ═══════════════════════════════════════════════
     TASK ATTEMPT EVALUATION (Acquisition + Recall)
  ═══════════════════════════════════════════════ */

  async evaluateTaskAttempt({ task, attempt, padSnapshot }, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!task || !attempt) {
      Counters.increment('evaluateTaskAttempt.invalid_params');
      throw new Error('Missing task or attempt in evaluateTaskAttempt');
    }

    logger.debug('Evaluating task attempt', {
      correlationId,
      taskPhase: task.taskPhase || 'undefined',
      taskType: task.taskType || task.task_type || 'unknown',
      category: task.taskCategory || 'unknown'
    });

    if (task.taskType === 'recall' && task.required_terms) {
      Counters.increment('evaluateTaskAttempt.recall');
      logger.debug('Semantic recall evaluation', {
        correlationId,
        attemptTextLength: attempt.attemptText?.length || 0,
        requiredTermsCount: Array.isArray(task.required_terms) ? task.required_terms.length : 0
      });
      return semanticAnswerEvaluator.evaluate(attempt.attemptText, {
        required_terms: task.required_terms,
        answer_statement: task.answer_statement || '',
        belt_level: task.belt_level || 'white_belt',
        semantic_anchors: task.semantic_anchors || null
      });
    }

    if (task.taskType !== 'teaching' && task.taskCategory !== 'acquisition') {
      logger.warn('Teaching scoring path reached for non-teaching task', {
        correlationId,
        taskType: task?.taskType,
        taskCategory: task?.taskCategory,
        taskId: task?.taskId
      });
    }

    Counters.increment('evaluateTaskAttempt.teaching');

    const responseText = (attempt.attemptText || '').trim();
    const responseLength = responseText.length;

    let score = 4;
    let explanation = 'Good engagement - thinking actively helps the concept stick.';

    if (responseLength < DEFAULTS.TEACHING_THRESHOLDS.MINIMAL) {
      score = 3;
      explanation = 'Short response noted. Next time try explaining in your own words - it strengthens memory.';
    } else if (responseLength < DEFAULTS.TEACHING_THRESHOLDS.BRIEF) {
      score = 4;
      explanation = 'Solid start. Expanding your thoughts deepens understanding - keep going!';
    } else {
      score = 5;
      explanation = 'Excellent - active processing builds strong memory.';
    }

    logger.debug('Teaching task scored', { correlationId, responseLength, score, taskId: task?.taskId });

    return {
      score,
      phase: 'acquisition',
      reason: 'acknowledgment_length_based',
      explanation,
      acquisitionSuccess: true,
      taskType: task.taskType,
      taskCategory: task.taskCategory
    };
  }

  /* ═══════════════════════════════════════════════
     COMMUNICATION QUALITY EVALUATION
  ═══════════════════════════════════════════════ */

  evaluateCommunicationQuality(task, attempt, opts = {}) {
    const correlationId = opts.correlationId || null;
    const scores = {
      effectiveness: 0,
      efficiency: 0,
      cultural: 0,
      innovation: 0
    };

    const targetPad = task.metadata?.target_pad;
    const usedPad = attempt.metadata?.pad_used;

    if (targetPad && usedPad) {
      const deltaP = targetPad.p - usedPad.pleasure;
      const deltaA = targetPad.a - usedPad.arousal;
      const deltaD = targetPad.d - usedPad.dominance;
      const padDistance = Math.sqrt(deltaP * deltaP + deltaA * deltaA + deltaD * deltaD);
      const maxDistance = 2 * Math.sqrt(3);

      let effectiveness = 0;
      if (maxDistance > 0) {
        effectiveness = Math.max(0, 1 - (padDistance / maxDistance));
      } else {
        effectiveness = 1;
      }

      scores.effectiveness = effectiveness;
    }

    const targetIntent = task.metadata?.target_outcome_intent;
    const usedIntent = attempt.metadata?.outcome_intent;
    scores.cultural = (targetIntent === usedIntent) ? 1.0 : 0.5;

    const targetVerbosity = task.metadata?.target_verbosity || 'moderate';
    const verbosityLimits = { brief: 150, moderate: 500, detailed: 1000 };
    const targetLength = verbosityLimits[targetVerbosity] || 500;
    const attemptText = attempt.attemptText || '';
    const actualLength = attemptText.length;
    scores.efficiency = Math.max(0, 1 - Math.abs(actualLength - targetLength) / targetLength);

    scores.innovation = attempt.metadata?.storyteller_meta?.usedStoryteller ? 1.0 : 0.7;

    if (attemptText.includes('pretty neat') || attemptText.includes('love to hear')) {
      scores.innovation += 0.3;
    }

    const overallScore = (
      scores.effectiveness * 0.4 +
      scores.efficiency * 0.2 +
      scores.cultural * 0.2 +
      scores.innovation * 0.2
    );

    const mappedScore = Math.ceil(overallScore * 5);

    Counters.increment('evaluateCommunicationQuality.success');

    return {
      score: Math.max(1, Math.min(5, mappedScore)),
      forbiddenPhraseUsed: false,
      connectors: [],
      communicationScores: scores,
      taskType: task.taskType || task.task_type || null,
      taskCategory: task.taskCategory || 'communication_quality'
    };
  }

  /* ═══════════════════════════════════════════════
     REWRITE TASK EVALUATION
  ═══════════════════════════════════════════════ */

  evaluateRewriteTask(taskType, task, attempt, opts = {}) {
    const correlationId = opts.correlationId || null;
    const text = attempt.attemptText || '';
    const orig = task.input || '';

    logger.debug('Evaluating rewrite task', {
      correlationId,
      taskType,
      attemptLength: text.length
    });

    let score = 2;
    let reasons = [];

    if (text.includes('pretty neat') || text.includes('love to hear')) {
      score += 0.5;
      reasons.push('Warm/friendly tone detected');
    }

    const lengthRatio = orig.length > 0 ? text.length / orig.length : 1;

    if (taskType === 'sentence_clarity_rewrite') {
      if (lengthRatio < 0.9) {
        score += 1.5;
        reasons.push(`Reduced length: ${Math.round(lengthRatio * 100)}%`);
      }
      if (text.includes('. ')) {
        score += 1.0;
        reasons.push('Added sentence breaks');
      }
    }

    if (taskType === 'cause_effect_rewrite') {
      const connectors = (text.match(/because|so|therefore|as a result|→/gi) || []).length;
      logger.debug('Causal connector analysis', {
        correlationId, connectors, textSample: text.substring(0, 100)
      });
      score += Math.min(3, connectors * 0.8);
      reasons.push(`${connectors} causal connectors used`);
    }

    if (taskType === 'summarize_core_point') {
      if (lengthRatio < 0.6) {
        score += 2.0;
        reasons.push(`Summary brevity: ${Math.round(lengthRatio * 100)}%`);
      }
      const keyTerms = (text.match(/because|dragon|village|sacred|destroyed|therefore/gi) || []).length;
      if (keyTerms > 0) {
        score += 0.5;
        reasons.push(`${keyTerms} key terms retained`);
      }
    }

    const normalize = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const targetIntent = task.metadata?.target_outcome_intent || 'explain warmly and clearly';
    const usedIntent = attempt.metadata?.outcome_intent || 'explain warmly and clearly';
    const cultural = normalize(targetIntent) === normalize(usedIntent) ? 1.0 : 0.5;

    Counters.increment('evaluateRewriteTask.success');

    return {
      score: Math.round(Math.max(1, Math.min(5, score))),
      reason: reasons.join('; ') || 'Rewrite evaluated',
      lengthRatio: Math.round(lengthRatio * 100),
      connectors: (text.match(/because|so|therefore|→/gi) || []).length,
      communicationScores: {
        cultural,
        effectiveness: score / 5,
        efficiency: task.metadata?.originalLength
          ? Math.max(0, Math.min(1, 1 - text.length / task.metadata.originalLength))
          : 0.5
      },
      taskType: task.taskType || task.task_type || null,
      taskCategory: task.taskCategory || null
    };
  }

  /* ═══════════════════════════════════════════════
     INITIALISE NEW KNOWLEDGE ITEM
  ═══════════════════════════════════════════════ */

  async initializeNewItem(userId, knowledgeId, opts = {}) {
    const correlationId = opts.correlationId || null;

    if (!this._validateHexId(userId, 'userId') || !this._validateHexId(knowledgeId, 'knowledgeId')) {
      Counters.increment('initializeNewItem.invalid_hex');
      logger.error('initializeNewItem: invalid hex ID', { correlationId, userId, knowledgeId });
      return { success: false, error: 'invalid_hex_id' };
    }

    const initD = initDifficulty('good', FSRS_WEIGHTS, FSRS_RATINGS);
    const initS = initStability('good', FSRS_WEIGHTS, FSRS_RATINGS);
    const firstInterval = nextInterval(initS, FSRS_REQUEST_RETENTION, FSRS_FACTOR, FSRS_DECAY, FSRS_MAXIMUM_INTERVAL);

    try {
      const result = await this._query('initializeNewItem',
        `UPDATE user_knowledge_state SET
           stability = $3,
           difficulty = $4,
           last_review_timestamp = NOW(),
           next_review_timestamp = NOW() + ($5 || ' days')::interval,
           grade_history = COALESCE(grade_history, '[]'),
           practice_count = COALESCE(practice_count, 0)
         WHERE user_id = $1 AND knowledge_id = $2`,
        [userId, knowledgeId, initS, initD, firstInterval],
        { correlationId }
      );

      if (result.rowCount === 0) {
        Counters.increment('initializeNewItem.not_found');
        logger.warn('initializeNewItem: no row found', { correlationId, userId, knowledgeId });
        return { success: false, error: 'no_row_found' };
      }

      Counters.increment('initializeNewItem.success');
      logger.debug('FSRS state initialised', {
        correlationId, userId, knowledgeId,
        stability: initS, difficulty: initD, intervalDays: firstInterval
      });
      return { success: true };
    } catch (err) {
      Counters.increment('initializeNewItem.error');
      logger.error('initializeNewItem failed', err, { correlationId, userId, knowledgeId });
      return { success: false, error: err.message };
    }
  }

  /* ═══════════════════════════════════════════════
     RE-TEACH FLOW
  ═══════════════════════════════════════════════ */

  async handleReteachFlow({ userId, knowledgeId, currentAttempts }, opts = {}) {
    const correlationId = opts.correlationId || null;
    const attempts = (currentAttempts || 0) + 1;
    const maxAttempts = MAX_RETEACH_ATTEMPTS || 3;

    if (!this._validateHexId(userId, 'userId')) {
      Counters.increment('handleReteachFlow.invalid_userId');
      logger.error('handleReteachFlow: invalid userId', { correlationId, userId });
      return {
        success: false, reteachExhausted: false, attempts: 0,
        teachingStatement: null, answerStatement: null,
        error: 'invalid_user_id', message: 'Invalid user identifier.'
      };
    }

    if (!this._validateHexId(knowledgeId, 'knowledgeId')) {
      Counters.increment('handleReteachFlow.invalid_knowledgeId');
      logger.error('handleReteachFlow: invalid knowledgeId', { correlationId, knowledgeId });
      return {
        success: false, reteachExhausted: false, attempts,
        teachingStatement: null, answerStatement: null,
        error: 'invalid_knowledge_id', message: 'Invalid knowledge identifier.'
      };
    }

    if (attempts >= maxAttempts) {
      Counters.increment('handleReteachFlow.exhausted');
      logger.info('Re-teach exhausted', { correlationId, userId, knowledgeId, attempts });
      return {
        success: true, reteachExhausted: true, attempts,
        teachingStatement: null, answerStatement: null,
        error: null, message: 'Maximum re-teach attempts reached. This item will appear again in your scheduled reviews.'
      };
    }

    let result;
    try {
      result = await this._query('reteachFetch',
        'SELECT content, answer_statement, concept FROM knowledge_items WHERE knowledge_id = $1',
        [knowledgeId],
        { correlationId, timeout: DEFAULTS.RETEACH_QUERY_TIMEOUT_MS }
      );
    } catch (err) {
      const errorType = err.message.includes('timeout') ? 'timeout' : 'database_error';
      Counters.increment('handleReteachFlow.fetch_error');
      logger.error('handleReteachFlow fetch failed', err, { correlationId, errorType, userId, knowledgeId });
      return {
        success: false, reteachExhausted: false, attempts,
        teachingStatement: 'Let us review this concept again.', answerStatement: null,
        error: errorType,
        message: errorType === 'timeout'
          ? 'Teaching content is taking too long to load. Please try again.'
          : 'Unable to fetch teaching content. Please try again.'
      };
    }

    if (!result || result.rows.length === 0) {
      Counters.increment('handleReteachFlow.not_found');
      logger.warn('handleReteachFlow: knowledge item not found', { correlationId, userId, knowledgeId });
      return {
        success: false, reteachExhausted: false, attempts,
        teachingStatement: 'Let us review this concept again.', answerStatement: null,
        error: 'knowledge_item_not_found', message: 'Teaching content not found.'
      };
    }

    const item = result.rows[0];
    let teachingStatement = item.content || 'Let us review this concept again.';
    let answerStatement = item.answer_statement || null;

    if (typeof teachingStatement === 'string' && teachingStatement.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(teachingStatement);
        teachingStatement = parsed.teaching_statement || parsed.statement || teachingStatement;
        if (!answerStatement && parsed.answer_statement) {
          answerStatement = parsed.answer_statement;
        }
      } catch (e) {
        logger.debug('Content JSON parse failed, using raw', { correlationId, knowledgeId });
      }
    }

    if (teachingStatement.length > DEFAULTS.MAX_CONTENT_LENGTH) {
      teachingStatement = teachingStatement.substring(0, DEFAULTS.MAX_CONTENT_LENGTH - 3) + '...';
      logger.debug('Teaching content truncated', {
        correlationId, knowledgeId, originalLength: item.content.length
      });
    }

    Counters.increment('handleReteachFlow.success');
    logger.info('Re-teach flow initiated', {
      correlationId, userId, knowledgeId,
      attempt: attempts, maxAttempts,
      contentLength: teachingStatement.length
    });

    return {
      success: true, reteachExhausted: false, attempts,
      teachingStatement, answerStatement,
      error: null,
      message: `Re-teach attempt ${attempts} of ${maxAttempts}. Please study the material carefully.`
    };
  }

  /* ═══════════════════════════════════════════════
     DIAGNOSTICS
  ═══════════════════════════════════════════════ */

  getCounters() {
    return Counters.getAll();
  }
}

export { EvaluatorComponent };
export default EvaluatorComponent;
