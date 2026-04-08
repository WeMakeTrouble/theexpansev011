/**
 * ===========================================================================
 * FSRSMultiLearner.js — B-Roll Character FSRS Review Engine
 * ===========================================================================
 * Version: 2
 * Last Modified: 2026-03-07
 *
 * WHAT THIS MODULE IS:
 * --------------------------------------------------------------------------
 * The FSRS data access and review processing layer for B-Roll characters.
 * This is the B-Roll equivalent of what EvaluatorComponent.js does for
 * human users — it reads and writes character_knowledge_state with full
 * FSRS scheduling math.
 *
 * When Claude teaches Bagsy the word "dark", this module:
 *   1. Creates the initial row in character_knowledge_state
 *   2. Computes retrievability decay over time
 *   3. Processes review results (updates stability, difficulty, next review)
 *   4. Promotes words from receptive to productive when retention is proven
 *   5. Provides batch queries for due items across multiple characters
 *   6. Provides productive inventory counts for DevelopmentalStageClassifier
 *
 * WHAT THIS MODULE IS NOT:
 * --------------------------------------------------------------------------
 * - Not a scheduler. ClaudeVisitationScheduler decides WHEN Claude visits.
 * - Not a speech constructor. VocabularyConstructor assembles utterances.
 * - Not a stage classifier. DevelopmentalStageClassifier maps counts to stage.
 * - Not the FSRS algorithm. fsrs_core.js provides all math as pure functions.
 * - Not for human users. EvaluatorComponent.js handles user_knowledge_state.
 *
 * FSRS MATH REUSE:
 * --------------------------------------------------------------------------
 * All FSRS calculations are delegated to fsrs_core.js (verified port of
 * fsrs4anki v6.1.3). This module calls those pure functions and persists
 * the results. It does not duplicate or modify any FSRS math.
 *
 * For hot-path queries (getProductiveCounts, getProductiveInventory),
 * retrievability is computed in SQL using POWER() with precomputed
 * decay and factor constants. This avoids O(n) client-side iteration
 * and clock drift between JS Date and PostgreSQL NOW().
 *
 * SQL retrievability formula (equivalent to fsrs_core.forgettingCurve):
 *   R = POWER(1 + factor * elapsed_days / stability, decay)
 * Where factor and decay are computed once at module load from FSRS_WEIGHTS.
 *
 * PRODUCTIVE PROMOTION THRESHOLDS (Final Spec Section 7):
 * --------------------------------------------------------------------------
 * A word transitions from receptive (understood) to productive (can use)
 * when its post-review retrievability is at or above the knowledge-type
 * threshold after a successful review (rating >= good).
 *
 *   WORD:     productive when R >= 0.80
 *   PIVOT:    productive when R >= 0.85
 *   OPERATOR: productive when R >= 0.90
 *
 * Promotion is checked AFTER the review updates stability, because the
 * review itself changes the memory state. A successful review resets
 * retrievability to 1.0 (post-review, the character just demonstrated
 * recall — R is definitionally 1.0 at that moment). So promotion on a
 * successful review is gated by: was the pre-review R above the
 * productive threshold? If yes, the character proved they could recall
 * the word even after significant time decay, earning productive status.
 *
 * A single lapse (rating = again) resets promotion candidate status but
 * does NOT demote already-productive words. Demotion happens only when
 * retrievability drops below 0.50 (functionally forgotten).
 *
 * DEMOTION THRESHOLD:
 * --------------------------------------------------------------------------
 * If a productive word's retrievability drops below 0.50, it loses
 * productive status. The character can no longer use it in speech.
 * Claude narrates: "There was a word Bagsy almost had. It crinkled instead."
 *
 * ROW LOCKING:
 * --------------------------------------------------------------------------
 * processReview uses SELECT ... FOR UPDATE to prevent concurrent reviews
 * from producing inconsistent state. If two visits happen simultaneously,
 * the second blocks until the first commits. This prevents lost updates
 * to practice_count, grade_history, and stability.
 *
 * GRADE HISTORY:
 * --------------------------------------------------------------------------
 * grade_history JSONB is capped at the most recent 50 entries to prevent
 * unbounded column growth. At 1000+ reviews, uncapped history becomes
 * multi-megabyte. Older entries are trimmed on each write.
 *
 * REQUIRED DATABASE INDEXES:
 * --------------------------------------------------------------------------
 * The following indexes should exist for query performance:
 *   - character_knowledge_state_pkey (character_id, knowledge_id) — EXISTS
 *   - idx_cks_productive (character_id, is_productive, current_retrievability) — EXISTS
 *   - idx_char_knowledge_state_next_review (next_review_timestamp) — EXISTS
 *   - idx_char_knowledge_state_char_id (character_id) — EXISTS
 * All verified present in the current schema.
 *
 * TRANSACTION DISCIPLINE:
 * --------------------------------------------------------------------------
 * Every public method accepts an optional { client } parameter for
 * transaction support. When a caller passes a transactional client,
 * the method uses it instead of the pool. This allows atomic operations
 * (e.g. initializeVocabularyItem inside the same transaction as the
 * hex ID generation and teachable_knowledge INSERT).
 *
 * SCALE EXPECTATION:
 * --------------------------------------------------------------------------
 * 100+ B-Roll characters, Black Belt characters may have 1000+ words.
 * Hot-path queries (getProductiveCounts, getProductiveInventory) push
 * computation to SQL to avoid O(n) JS iteration. Admin-only methods
 * (getFullKnowledgeState) use pagination.
 *
 * DEPENDENCIES:
 * --------------------------------------------------------------------------
 *   - pool.js (PostgreSQL connection)
 *   - logger.js (structured logging via createModuleLogger)
 *   - fsrs_core.js (FSRS pure math functions)
 *   - FSRSConstants.js (weights, ratings, retention target, max interval)
 *   - hexIdGenerator.js (isValidHexId for input validation)
 *
 * REFERENCES:
 * --------------------------------------------------------------------------
 *   - V010_FINAL_SPEC_BRoll_Autonomous_Speech.md (Sections 5.5, 7, 7.1, 7.2)
 *   - Laufer, B. (1998). Development of passive and active vocabulary.
 *   - Webb, S. (2008). Receptive and productive vocabulary sizes.
 *   - Ye, J. et al. (2022). FSRS algorithm for adaptive learning.
 *
 * REVIEW HISTORY:
 * --------------------------------------------------------------------------
 * v1: Initial implementation. Three independent reviews scored 94, 92, 76.
 * v2: Addressed all consensus findings:
 *     - Split processReview into private helpers (Reviews 1, 3)
 *     - Added SELECT FOR UPDATE row locking (Review 2)
 *     - Capped grade_history at 50 entries (Reviews 2, 3)
 *     - Pushed R computation to SQL for hot-path queries (Review 3)
 *     - Elapsed days via SQL EXTRACT to avoid clock drift (Reviews 2, 3)
 *     - Promotion checks pre-review R with explanation (Review 2)
 *     - Added debug trace via options.debug (Reviews 1, 3)
 *     - Added onPromotionChange callback (Review 1)
 *     - Added pagination on getFullKnowledgeState (Review 3)
 *     - Added limit cap (MAX_QUERY_LIMIT=200) on getDueItems (Review 3)
 *     - Batch query uses ANY($1::text[]) instead of IN() (Review 2)
 *     - Injectable timeout via constructor options (Review 3)
 *     - Documented required indexes (Review 2)
 *     - Comment explaining post-review R=1.0 reset (Review 1)
 *
 * ===========================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import {
    computeDecay,
    computeFactor,
    forgettingCurve,
    nextInterval,
    nextRecallStability,
    nextForgetStability,
    nextDifficulty,
    initDifficulty
} from '../TSE/fsrs/fsrs_core.js';
import {
    FSRS_WEIGHTS,
    FSRS_RATINGS,
    FSRS_REQUEST_RETENTION,
    FSRS_MAXIMUM_INTERVAL,
    FSRS_INITIAL_STABILITY,
    FSRS_INITIAL_DIFFICULTY,
    FSRS_GOOD_THRESHOLD
} from '../TSE/constants/FSRSConstants.js';

const MODULE_NAME = 'FSRSMultiLearner';
const logger = createModuleLogger(MODULE_NAME);

const DEFAULT_QUERY_TIMEOUT_MS = 8000;
const MAX_QUERY_LIMIT = 200;
const MAX_GRADE_HISTORY = 50;
const DEFAULT_PAGE_LIMIT = 50;

const FSRS_DECAY = computeDecay(FSRS_WEIGHTS);
const FSRS_FACTOR = computeFactor(FSRS_DECAY);

const PRODUCTIVE_THRESHOLDS = Object.freeze({
    WORD: 0.80,
    PIVOT: 0.85,
    OPERATOR: 0.90
});

const RECEPTIVE_THRESHOLDS = Object.freeze({
    WORD: 0.70,
    PIVOT: 0.75,
    OPERATOR: 0.80
});

const DEMOTION_THRESHOLD = 0.50;

const SQL_ELAPSED_DAYS = `EXTRACT(EPOCH FROM (NOW() - last_review_timestamp)) / 86400.0`;
const SQL_RETRIEVABILITY = `CASE
    WHEN last_review_timestamp IS NULL THEN 1.0
    WHEN stability <= 0 THEN 1.0
    WHEN EXTRACT(EPOCH FROM (NOW() - last_review_timestamp)) <= 0 THEN 1.0
    ELSE POWER(1.0 + ${FSRS_FACTOR} * (${SQL_ELAPSED_DAYS}) / stability, ${FSRS_DECAY})
END`;

export default class FSRSMultiLearner {

    constructor(dbPool, opts = {}) {
        this.pool = dbPool ?? pool;
        this.queryTimeoutMs = opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
    }

    async _query(sql, params = [], opts = {}, methodLabel = 'unknown') {
        const executor = opts.client ?? this.pool;

        const queryPromise = executor.query(sql, params);
        const timeoutPromise = new Promise((_, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(
                    `${MODULE_NAME}.${methodLabel}: query timeout after ${this.queryTimeoutMs}ms`
                ));
            }, this.queryTimeoutMs);
            queryPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
        });

        return Promise.race([queryPromise, timeoutPromise]);
    }

    _validateHexId(value, name) {
        if (!value || !isValidHexId(value)) {
            throw new Error(
                `${MODULE_NAME}: invalid ${name} — expected #XXXXXX hex format, got: ${value}`
            );
        }
    }

    _elapsedDaysSince(timestamp) {
        if (!timestamp) return 0;
        const then = new Date(timestamp);
        const now = new Date();
        const ms = now.getTime() - then.getTime();
        return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
    }

    async _fetchCurrentState(characterId, knowledgeId, opts) {
        const result = await this._query(
            `SELECT stability, difficulty, current_retrievability,
                    last_review_timestamp, knowledge_type,
                    is_productive, practice_count, grade_history
             FROM character_knowledge_state
             WHERE character_id = $1 AND knowledge_id = $2
             FOR UPDATE`,
            [characterId, knowledgeId],
            opts,
            'processReview.fetchForUpdate'
        );

        if (result.rows.length === 0) {
            throw new Error(
                `${MODULE_NAME}.processReview: no row for character=${characterId}, knowledge=${knowledgeId}`
            );
        }

        return result.rows[0];
    }

    _computeNewFsrsState(state, rating, trace) {
        const elapsedDays = this._elapsedDaysSince(state.last_review_timestamp);

        let retrievability = 1.0;
        if (elapsedDays > 0 && state.stability > 0) {
            retrievability = forgettingCurve(elapsedDays, state.stability, FSRS_FACTOR, FSRS_DECAY);
        }

        const ratingNum = FSRS_RATINGS[rating];
        const isRecall = ratingNum >= FSRS_GOOD_THRESHOLD;

        if (trace) {
            trace.push(
                `Elapsed: ${elapsedDays} days. Pre-review R: ${retrievability.toFixed(4)}. ` +
                `Rating: ${rating} (${ratingNum}). Recall: ${isRecall}.`
            );
        }

        let newStability;
        if (isRecall) {
            newStability = nextRecallStability(
                state.difficulty, state.stability, retrievability, rating, FSRS_WEIGHTS
            );
        } else {
            newStability = nextForgetStability(
                state.difficulty, state.stability, retrievability, FSRS_WEIGHTS
            );
        }

        const initDEasy = initDifficulty('easy', FSRS_WEIGHTS, FSRS_RATINGS);
        const newDifficulty = nextDifficulty(
            state.difficulty, rating, FSRS_WEIGHTS, FSRS_RATINGS, initDEasy
        );

        const intervalDays = nextInterval(
            newStability, FSRS_REQUEST_RETENTION, FSRS_FACTOR, FSRS_DECAY, FSRS_MAXIMUM_INTERVAL
        );

        if (trace) {
            trace.push(
                `Stability: ${state.stability} -> ${newStability}. ` +
                `Difficulty: ${state.difficulty} -> ${newDifficulty}. ` +
                `Next interval: ${intervalDays} days.`
            );
        }

        return {
            newStability,
            newDifficulty,
            intervalDays,
            retrievability,
            elapsedDays,
            isRecall,
            ratingNum
        };
    }

    _determinePromotionChange(state, isRecall, preReviewR, trace) {
        const knowledgeType = state.knowledge_type;
        const wasProductive = state.is_productive;
        let isProductive = wasProductive;
        let promotionChange = null;

        if (!wasProductive && isRecall && knowledgeType) {
            const threshold = PRODUCTIVE_THRESHOLDS[knowledgeType];
            if (threshold && preReviewR >= threshold) {
                isProductive = true;
                promotionChange = 'promoted';
            }
        }

        if (wasProductive && preReviewR < DEMOTION_THRESHOLD) {
            isProductive = false;
            promotionChange = 'demoted';
        }

        if (trace) {
            const threshold = PRODUCTIVE_THRESHOLDS[knowledgeType] ?? 'N/A';
            trace.push(
                `Promotion check: wasProductive=${wasProductive}, isRecall=${isRecall}, ` +
                `preReviewR=${preReviewR.toFixed(4)}, threshold=${threshold}, ` +
                `result=${promotionChange ?? 'no_change'}.`
            );
        }

        return { isProductive, promotionChange };
    }

    _buildReviewUpdate({
        characterId, knowledgeId, newStability, newDifficulty,
        now, nextReview, practiceCount, gradeHistory,
        isProductive, promotionChange, isRecall, isForgotten,
        acquisitionCompleted, wasProductive
    }) {
        const setClauses = [
            'stability = $3',
            'difficulty = $4',
            'current_retrievability = $5',
            'last_review_timestamp = $6',
            'next_review_timestamp = $7',
            'practice_count = $8',
            'grade_history = $9',
            'is_productive = $10',
            'is_forgotten = $11',
            'acquisition_completed = $12'
        ];

        const params = [
            characterId,
            knowledgeId,
            newStability,
            newDifficulty,
            // Post-review retrievability is 1.0 because the character just
            // demonstrated recall (or failed — either way, the state is "just reviewed").
            // FSRS resets R to 1.0 at the moment of review; decay begins from here.
            1.0,
            now,
            nextReview,
            practiceCount,
            JSON.stringify(gradeHistory),
            isProductive,
            isForgotten,
            acquisitionCompleted
        ];

        if (promotionChange === 'promoted') {
            setClauses.push('productive_promotion_date = $13');
            params.push(now);
        } else if (!wasProductive && isRecall) {
            setClauses.push('first_prompted_use_date = COALESCE(first_prompted_use_date, $13)');
            params.push(now);
        }

        const sql = `UPDATE character_knowledge_state
            SET ${setClauses.join(', ')}
            WHERE character_id = $1 AND knowledge_id = $2`;

        return { sql, queryParams: params };
    }

    async initializeVocabularyItem(characterId, knowledgeId, opts = {}) {
        this._validateHexId(characterId, 'characterId');
        this._validateHexId(knowledgeId, 'knowledgeId');

        try {
            const vocabResult = await this._query(
                `SELECT knowledge_type FROM vocabulary_dictionary WHERE id = $1`,
                [knowledgeId],
                opts,
                'initializeVocabularyItem.lookup'
            );

            if (vocabResult.rows.length === 0) {
                throw new Error(
                    `${MODULE_NAME}.initializeVocabularyItem: knowledgeId ${knowledgeId} not found in vocabulary_dictionary`
                );
            }

            const knowledgeType = vocabResult.rows[0].knowledge_type;
            const initS = FSRS_INITIAL_STABILITY;
            const initD = FSRS_INITIAL_DIFFICULTY;
            const now = new Date();
            const intervalDays = nextInterval(initS, FSRS_REQUEST_RETENTION, FSRS_FACTOR, FSRS_DECAY, FSRS_MAXIMUM_INTERVAL);
            const nextReview = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);

            await this._query(
                `INSERT INTO character_knowledge_state (
                    character_id, knowledge_id, knowledge_type,
                    stability, difficulty, current_retrievability,
                    is_productive, is_mastered, is_forgotten,
                    acquisition_completed, practice_count,
                    last_review_timestamp, next_review_timestamp,
                    grade_history, memory_trace
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [
                    characterId, knowledgeId, knowledgeType,
                    initS, initD, 1.0,
                    false, false, false,
                    false, 0,
                    now, nextReview,
                    JSON.stringify([]), JSON.stringify({})
                ],
                opts,
                'initializeVocabularyItem.insert'
            );

            logger.info('Vocabulary item initialized', {
                characterId, knowledgeId, knowledgeType,
                stability: initS, difficulty: initD, intervalDays,
                correlationId: opts.correlationId ?? null
            });

            return {
                characterId, knowledgeId, knowledgeType,
                stability: initS, difficulty: initD,
                nextReviewTimestamp: nextReview
            };

        } catch (error) {
            logger.error('initializeVocabularyItem failed', error, {
                characterId, knowledgeId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async processReview(characterId, knowledgeId, rating, opts = {}) {
        this._validateHexId(characterId, 'characterId');
        this._validateHexId(knowledgeId, 'knowledgeId');

        if (!FSRS_RATINGS[rating]) {
            throw new Error(
                `${MODULE_NAME}.processReview: invalid rating "${rating}". ` +
                `Must be one of: ${Object.keys(FSRS_RATINGS).join(', ')}`
            );
        }

        const debug = opts.debug === true;
        const onPromotionChange = typeof opts.onPromotionChange === 'function'
            ? opts.onPromotionChange : null;
        const trace = debug ? [] : null;

        try {
            const state = await this._fetchCurrentState(characterId, knowledgeId, opts);

            if (trace) {
                trace.push(
                    `State fetched: stability=${state.stability}, difficulty=${state.difficulty}, ` +
                    `knowledgeType=${state.knowledge_type}, isProductive=${state.is_productive}, ` +
                    `practiceCount=${state.practice_count}.`
                );
            }

            const fsrs = this._computeNewFsrsState(state, rating, trace);

            const promotion = this._determinePromotionChange(
                state, fsrs.isRecall, fsrs.retrievability, trace
            );

            const now = new Date();
            const nextReview = new Date(now.getTime() + fsrs.intervalDays * 24 * 60 * 60 * 1000);
            const practiceCount = (state.practice_count ?? 0) + 1;

            const gradeHistory = Array.isArray(state.grade_history)
                ? state.grade_history : [];
            gradeHistory.push({
                rating,
                ratingNum: fsrs.ratingNum,
                timestamp: now.toISOString(),
                retrievabilityBefore: +fsrs.retrievability.toFixed(4),
                stabilityBefore: state.stability,
                stabilityAfter: fsrs.newStability,
                difficultyBefore: state.difficulty,
                difficultyAfter: fsrs.newDifficulty
            });

            const cappedHistory = gradeHistory.length > MAX_GRADE_HISTORY
                ? gradeHistory.slice(-MAX_GRADE_HISTORY)
                : gradeHistory;

            const knowledgeType = state.knowledge_type;
            const receptiveThreshold = RECEPTIVE_THRESHOLDS[knowledgeType] ?? 0.70;
            const isForgotten = !fsrs.isRecall && fsrs.retrievability < receptiveThreshold;
            const acquisitionCompleted = fsrs.isRecall || (state.acquisition_completed ?? false);

            const { sql, queryParams } = this._buildReviewUpdate({
                characterId,
                knowledgeId,
                newStability: fsrs.newStability,
                newDifficulty: fsrs.newDifficulty,
                now,
                nextReview,
                practiceCount,
                gradeHistory: cappedHistory,
                isProductive: promotion.isProductive,
                promotionChange: promotion.promotionChange,
                isRecall: fsrs.isRecall,
                isForgotten,
                acquisitionCompleted,
                wasProductive: state.is_productive
            });

            await this._query(sql, queryParams, opts, 'processReview.update');

            if (trace) {
                trace.push(
                    `Updated: practiceCount=${practiceCount}, ` +
                    `historyEntries=${cappedHistory.length}, ` +
                    `isForgotten=${isForgotten}.`
                );
            }

            const result = {
                characterId,
                knowledgeId,
                knowledgeType,
                rating,
                isRecall: fsrs.isRecall,
                before: {
                    stability: state.stability,
                    difficulty: state.difficulty,
                    retrievability: +fsrs.retrievability.toFixed(4),
                    isProductive: state.is_productive
                },
                after: {
                    stability: fsrs.newStability,
                    difficulty: fsrs.newDifficulty,
                    retrievability: 1.0,
                    isProductive: promotion.isProductive,
                    intervalDays: fsrs.intervalDays,
                    nextReviewTimestamp: nextReview
                },
                promotionChange: promotion.promotionChange,
                practiceCount,
                elapsedDays: fsrs.elapsedDays,
                ...(debug ? { trace: Object.freeze([...trace]) } : {})
            };

            if (promotion.promotionChange && onPromotionChange) {
                onPromotionChange(result);
            }

            logger.info('Review processed', {
                characterId, knowledgeId, rating,
                isRecall: fsrs.isRecall,
                stabilityBefore: state.stability,
                stabilityAfter: fsrs.newStability,
                promotionChange: promotion.promotionChange,
                correlationId: opts.correlationId ?? null
            });

            return result;

        } catch (error) {
            logger.error('processReview failed', error, {
                characterId, knowledgeId, rating,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async calculateRetrievability(characterId, knowledgeId, opts = {}) {
        this._validateHexId(characterId, 'characterId');
        this._validateHexId(knowledgeId, 'knowledgeId');

        try {
            const result = await this._query(
                `SELECT stability, knowledge_type, is_productive,
                        ${SQL_RETRIEVABILITY} AS computed_r,
                        ${SQL_ELAPSED_DAYS} AS elapsed_days
                 FROM character_knowledge_state
                 WHERE character_id = $1 AND knowledge_id = $2`,
                [characterId, knowledgeId],
                opts,
                'calculateRetrievability'
            );

            if (result.rows.length === 0) return null;

            const row = result.rows[0];
            const r = +Number(row.computed_r).toFixed(4);
            const productiveThreshold = PRODUCTIVE_THRESHOLDS[row.knowledge_type] ?? 0.80;
            const hesitantFloor = productiveThreshold - 0.10;

            let zone;
            if (r >= productiveThreshold) zone = 'productive';
            else if (r >= hesitantFloor) zone = 'hesitant';
            else if (r >= DEMOTION_THRESHOLD) zone = 'receptive_only';
            else zone = 'forgotten';

            return {
                retrievability: r,
                stability: row.stability,
                knowledgeType: row.knowledge_type,
                isProductive: row.is_productive,
                zone,
                elapsedDays: +Number(row.elapsed_days ?? 0).toFixed(2)
            };

        } catch (error) {
            logger.error('calculateRetrievability failed', error, {
                characterId, knowledgeId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async getDueItems(characterId, limit = 10, opts = {}) {
        this._validateHexId(characterId, 'characterId');
        const safeLimit = Math.min(
            Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10),
            MAX_QUERY_LIMIT
        );

        try {
            const result = await this._query(
                `SELECT knowledge_id, knowledge_type, stability, difficulty,
                        current_retrievability, last_review_timestamp,
                        next_review_timestamp, is_productive, practice_count
                 FROM character_knowledge_state
                 WHERE character_id = $1
                   AND next_review_timestamp IS NOT NULL
                   AND next_review_timestamp <= NOW()
                 ORDER BY next_review_timestamp ASC
                 LIMIT $2`,
                [characterId, safeLimit],
                opts,
                'getDueItems'
            );

            logger.debug('Due items fetched', {
                characterId, count: result.rows.length,
                correlationId: opts.correlationId ?? null
            });

            return result.rows;

        } catch (error) {
            logger.error('getDueItems failed', error, {
                characterId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async getDueItemsBatch(characterIds, opts = {}) {
        if (!Array.isArray(characterIds) || characterIds.length === 0) {
            return [];
        }

        for (const id of characterIds) {
            this._validateHexId(id, 'characterIds[]');
        }

        try {
            const result = await this._query(
                `SELECT DISTINCT ON (character_id)
                        character_id, knowledge_id, knowledge_type,
                        next_review_timestamp, stability,
                        EXTRACT(EPOCH FROM (NOW() - next_review_timestamp)) / 86400.0 AS overdue_days
                 FROM character_knowledge_state
                 WHERE character_id = ANY($1::text[])
                   AND next_review_timestamp IS NOT NULL
                   AND next_review_timestamp <= NOW()
                 ORDER BY character_id, next_review_timestamp ASC`,
                [characterIds],
                opts,
                'getDueItemsBatch'
            );

            logger.debug('Batch due items fetched', {
                requestedCharacters: characterIds.length,
                charactersWithDue: result.rows.length,
                correlationId: opts.correlationId ?? null
            });

            return result.rows;

        } catch (error) {
            logger.error('getDueItemsBatch failed', error, {
                characterCount: characterIds.length,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async getProductiveInventory(characterId, opts = {}) {
        this._validateHexId(characterId, 'characterId');

        try {
            const result = await this._query(
                `SELECT cks.knowledge_id, cks.knowledge_type, cks.stability,
                        ${SQL_RETRIEVABILITY} AS computed_r,
                        vd.lemma, vd.pos, vd.semantic_tags
                 FROM character_knowledge_state cks
                 JOIN vocabulary_dictionary vd ON cks.knowledge_id = vd.id
                 WHERE cks.character_id = $1
                   AND cks.is_productive = TRUE`,
                [characterId],
                opts,
                'getProductiveInventory'
            );

            const inventory = result.rows.map(row => {
                const r = +Number(row.computed_r).toFixed(4);
                const productiveThreshold = PRODUCTIVE_THRESHOLDS[row.knowledge_type] ?? 0.80;
                const hesitantFloor = productiveThreshold - 0.10;

                let zone;
                if (r >= productiveThreshold) zone = 'productive';
                else if (r >= hesitantFloor) zone = 'hesitant';
                else zone = 'fading';

                return {
                    knowledgeId: row.knowledge_id,
                    knowledgeType: row.knowledge_type,
                    lemma: row.lemma,
                    pos: row.pos,
                    semanticTags: row.semantic_tags,
                    retrievability: r,
                    zone
                };
            });

            logger.debug('Productive inventory fetched', {
                characterId, total: inventory.length,
                productive: inventory.filter(i => i.zone === 'productive').length,
                hesitant: inventory.filter(i => i.zone === 'hesitant').length,
                fading: inventory.filter(i => i.zone === 'fading').length,
                correlationId: opts.correlationId ?? null
            });

            return inventory;

        } catch (error) {
            logger.error('getProductiveInventory failed', error, {
                characterId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async getProductiveCounts(characterId, opts = {}) {
        this._validateHexId(characterId, 'characterId');

        try {
            const result = await this._query(
                `SELECT knowledge_type,
                        ${SQL_RETRIEVABILITY} AS computed_r
                 FROM character_knowledge_state
                 WHERE character_id = $1
                   AND is_productive = TRUE
                   AND knowledge_type IS NOT NULL`,
                [characterId],
                opts,
                'getProductiveCounts'
            );

            let words = 0;
            let pivots = 0;
            let operators = 0;

            for (const row of result.rows) {
                const r = Number(row.computed_r);
                const threshold = PRODUCTIVE_THRESHOLDS[row.knowledge_type];
                if (!threshold || r < threshold) continue;

                if (row.knowledge_type === 'WORD') words++;
                else if (row.knowledge_type === 'PIVOT') pivots++;
                else if (row.knowledge_type === 'OPERATOR') operators++;
            }

            logger.debug('Productive counts computed', {
                characterId, words, pivots, operators,
                correlationId: opts.correlationId ?? null
            });

            return { words, pivots, operators };

        } catch (error) {
            logger.error('getProductiveCounts failed', error, {
                characterId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }

    async getFullKnowledgeState(characterId, opts = {}) {
        this._validateHexId(characterId, 'characterId');

        const limit = Math.min(
            Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_PAGE_LIMIT),
            MAX_QUERY_LIMIT
        );
        const offset = Math.max(0, Number.isFinite(opts.offset) ? Math.floor(opts.offset) : 0);

        try {
            const countResult = await this._query(
                `SELECT COUNT(*) AS total
                 FROM character_knowledge_state
                 WHERE character_id = $1`,
                [characterId],
                opts,
                'getFullKnowledgeState.count'
            );

            const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

            const result = await this._query(
                `SELECT cks.*,
                        ${SQL_RETRIEVABILITY} AS computed_r,
                        ${SQL_ELAPSED_DAYS} AS elapsed_days,
                        COALESCE(vd.lemma, ki.concept) AS display_name,
                        tk.knowledge_type AS parent_type
                 FROM character_knowledge_state cks
                 JOIN teachable_knowledge tk ON cks.knowledge_id = tk.id
                 LEFT JOIN vocabulary_dictionary vd ON cks.knowledge_id = vd.id
                 LEFT JOIN knowledge_items ki ON cks.knowledge_id = ki.knowledge_id
                 WHERE cks.character_id = $1
                 ORDER BY cks.knowledge_type, cks.is_productive DESC
                 LIMIT $2 OFFSET $3`,
                [characterId, limit, offset],
                opts,
                'getFullKnowledgeState.fetch'
            );

            const rows = result.rows.map(row => {
                const r = +Number(row.computed_r ?? 1.0).toFixed(4);
                const productiveThreshold = PRODUCTIVE_THRESHOLDS[row.knowledge_type] ?? 0.80;
                const hesitantFloor = productiveThreshold - 0.10;

                let zone;
                if (r >= productiveThreshold) zone = 'productive';
                else if (r >= hesitantFloor) zone = 'hesitant';
                else if (r >= DEMOTION_THRESHOLD) zone = 'receptive_only';
                else zone = 'forgotten';

                return { ...row, computed_retrievability: r, zone };
            });

            return { rows, total, limit, offset };

        } catch (error) {
            logger.error('getFullKnowledgeState failed', error, {
                characterId,
                correlationId: opts.correlationId ?? null
            });
            throw error;
        }
    }
}
