/**
 * ============================================================================
 * learningCapturer.js — User Language Learning Capture Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Stores what Claude the Tanuki learns from users. When learningDetector
 * flags unfamiliar language and Claude asks the user about it, this
 * module captures the user's explanation into their COTW (Council Of
 * The Wise) dossier.
 *
 * This is the foundation of Goal 3: "Claude can learn from users."
 * Without it, every conversation is forgotten.
 *
 * HOW IT WORKS
 * ------------
 * 1. CAPTURE (captureTeaching):
 *    - Claude detects unfamiliar phrase via learningDetector
 *    - Claude asks the user: "What does that mean?"
 *    - User explains
 *    - This module stores the phrase, explanation, context, and PAD
 *      coordinates in cotw_user_language table
 *    - Also stores a normalised version of the phrase for fuzzy matching
 *    - Hex ID generated within a database transaction (mandatory)
 *
 * 2. DUPLICATE DETECTION (hasLearnedPhrase):
 *    - Checks normalised phrase for fuzzy matching
 *    - Normalisation: lowercase, strip punctuation, collapse whitespace
 *    - "The Expanse!" and "the expanse" match as duplicates
 *
 * 3. RETRIEVE (getUserLearnedPhrases):
 *    - Returns phrases a user has taught Claude
 *    - Filterable by base concept
 *    - Paginated with configurable limit and offset
 *    - Ordered by confidence and average score
 *
 * 4. RECORD USAGE (recordUsage):
 *    - When Claude uses a learned phrase in conversation
 *    - Stores the usage context sentence for debugging
 *    - Updates usage count, success rate, running average score
 *    - Confidence progresses (1→5) on sustained success
 *    - Confidence demotes (→1 minimum) on sustained failure
 *
 * CONFIDENCE PROGRESSION
 * ----------------------
 * Confidence starts at 1 (just learned) and can reach 5 (fully trusted).
 *
 * Promotion: times_successful >= 5 AND avg_score >= 4.0
 *   → confidence = MIN(confidence + 1, 5)
 *
 * Demotion: times_used >= 10 AND avg_score < 2.5
 *   → confidence = MAX(confidence - 1, 1)
 *
 * This ensures Claude doesn't over-trust untested phrases AND can
 * lose confidence in phrases that consistently underperform.
 *
 * PHRASE NORMALISATION
 * --------------------
 * Stored alongside the original phrase for fuzzy duplicate detection:
 *   "The Expanse!!" → "the expanse"
 *   "y33t"          → "y33t"
 *   "Don't stop"    → "dont stop"
 *
 * Normalisation: lowercase → strip non-alphanumeric except spaces →
 * collapse multiple spaces → trim. Simple but catches most casual
 * duplicates without needing pg_trgm or Levenshtein.
 *
 * TRANSACTION DISCIPLINE
 * ----------------------
 * Hex ID generation and INSERT happen inside the SAME database
 * transaction per the hexIdGenerator.js contract. If the INSERT fails,
 * the transaction rolls back and the hex counter is not consumed.
 *
 * DATABASE TABLE: cotw_user_language
 * ----------------------------------
 * language_id        — Hex ID (#E3XXXX range)
 * user_id            — User hex ID
 * learned_phrase     — Original phrase as taught
 * normalized_phrase  — Lowercased, stripped version for matching
 * base_concept       — What it means (user's explanation)
 * context            — Conversational context when learned
 * pad_coordinates    — JSON PAD values at time of learning
 * confidence_level   — 1-5 trust level (can increase or decrease)
 * times_used         — Total usage count
 * times_successful   — Successful uses
 * avg_score          — Running average quality score (0-5)
 * last_usage_context — Sentence context from most recent usage
 * promoted_to_core   — Whether James has promoted to core knowledge
 * date_learned       — When first captured
 * last_used          — Most recent use timestamp
 *
 * RECOMMENDED INDEXES
 * -------------------
 * CREATE INDEX idx_cotw_user_language_user ON cotw_user_language(user_id);
 * CREATE INDEX idx_cotw_user_language_norm ON cotw_user_language(user_id, normalized_phrase);
 *
 * INTEGRATION
 * -----------
 * Called after learningDetector.shouldAsk === true AND the user responds
 * with an explanation. The capture happens in the conversation flow,
 * not in EarWig itself.
 *
 * Flow: learningDetector → Claude asks → user explains → learningCapturer
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: LearningCapturer (PascalCase)
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

const logger = createModuleLogger('LearningCapturer');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const INITIAL_CONFIDENCE = 1;
const MAX_CONFIDENCE = 5;
const MIN_CONFIDENCE = 1;

const PROMOTE_SUCCESS_THRESHOLD = 5;
const PROMOTE_SCORE_THRESHOLD = 4.0;

const DEMOTE_USAGE_THRESHOLD = 10;
const DEMOTE_SCORE_THRESHOLD = 2.5;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const MAX_PHRASE_LENGTH = 200;
const MAX_CONCEPT_LENGTH = 500;

/* ────────────────────────────────────────────────────────────────────────── */
/*  LearningCapturer Class                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

class LearningCapturer {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Normalise Phrase                                               */
  /*                                                                          */
  /*  Produces a canonical form for duplicate detection.                      */
  /*  Lowercase, strip non-alphanumeric (keep spaces), collapse whitespace.  */
  /* ──────────────────────────────────────────────────────────────────────── */

  _normalisePhrase(phrase) {
    if (typeof phrase !== 'string') return '';
    return phrase
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Capture Teaching                                                */
  /*                                                                          */
  /*  Stores a user-taught phrase in the cotw_user_language table.            */
  /*  Hex ID generation and INSERT are wrapped in a single transaction        */
  /*  per the hexIdGenerator contract.                                        */
  /*                                                                          */
  /*  Checks for duplicates before inserting. Returns existing row if         */
  /*  the normalised phrase already exists for this user.                     */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {object} teachingData — Teaching details                         */
  /*  @param {string} teachingData.phrase — The phrase being taught           */
  /*  @param {string} [teachingData.baseConcept] — User's explanation        */
  /*  @param {string} [teachingData.context] — Conversational context        */
  /*  @param {object} [teachingData.padCoordinates] — PAD at capture time    */
  /*  @returns {object} Inserted or existing row data                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async captureTeaching(userId, teachingData) {
    if (!userId || typeof userId !== 'string') {
      throw new Error('LearningCapturer: userId is required');
    }
    if (!teachingData?.phrase || typeof teachingData.phrase !== 'string') {
      throw new Error('LearningCapturer: teachingData.phrase is required');
    }

    const normalised = this._normalisePhrase(teachingData.phrase);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await this._findByNormalisedPhrase(userId, normalised, client);
      if (existing) {
        await client.query('ROLLBACK');
        logger.debug('Phrase already learned, skipping duplicate', {
          userId,
          languageId: existing.language_id,
          phrase: teachingData.phrase.slice(0, 50)
        });
        return existing;
      }

      const languageId = await generateHexId('cotw_user_language_id');

      const result = await client.query(`
        INSERT INTO cotw_user_language (
          language_id,
          user_id,
          learned_phrase,
          normalized_phrase,
          base_concept,
          context,
          pad_coordinates,
          confidence_level,
          date_learned
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING language_id, user_id, learned_phrase, normalized_phrase,
                  base_concept, confidence_level, date_learned
      `, [
        languageId,
        userId,
        teachingData.phrase.trim().slice(0, MAX_PHRASE_LENGTH),
        normalised,
        teachingData.baseConcept ? String(teachingData.baseConcept).slice(0, MAX_CONCEPT_LENGTH) : null,
        teachingData.context || null,
        teachingData.padCoordinates
          ? JSON.stringify(teachingData.padCoordinates)
          : null,
        INITIAL_CONFIDENCE
      ]);

      await client.query('COMMIT');

      logger.info('Stored user teaching', {
        userId,
        languageId,
        phrase: teachingData.phrase.slice(0, 50)
      });

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to capture teaching', {
        userId,
        phrase: teachingData.phrase?.slice(0, 50),
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Find By Normalised Phrase                                      */
  /*                                                                          */
  /*  Internal lookup using the normalised_phrase column.                     */
  /*  Returns the existing row or null.                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _findByNormalisedPhrase(userId, normalised, client = null) {
    if (!userId || !normalised) return null;

    try {
      const db = client || pool;
      const result = await db.query(`
        SELECT language_id, user_id, learned_phrase, normalized_phrase,
               base_concept, confidence_level, times_used, avg_score,
               date_learned, last_used
        FROM cotw_user_language
        WHERE user_id = $1
          AND normalized_phrase = $2
        LIMIT 1
      `, [userId, normalised]);

      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to check normalised phrase', {
        userId,
        error: error.message
      });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Check If Phrase Already Learned                                 */
  /*                                                                          */
  /*  Public interface for duplicate detection using normalised phrase.        */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {string} phrase — Phrase to check                                */
  /*  @returns {boolean} true if already learned                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  async hasLearnedPhrase(userId, phrase) {
    if (!userId || !phrase) return false;
    const normalised = this._normalisePhrase(phrase);
    const existing = await this._findByNormalisedPhrase(userId, normalised);
    return existing !== null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get User Learned Phrases                                        */
  /*                                                                          */
  /*  Retrieves phrases a user has taught Claude, ordered by confidence       */
  /*  and average score. Paginated with configurable limit and offset.        */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @param {object} [options] — Query options                               */
  /*  @param {string} [options.baseConcept] — Filter by concept              */
  /*  @param {number} [options.limit=50] — Max rows (1-200)                  */
  /*  @param {number} [options.offset=0] — Pagination offset                 */
  /*  @returns {Array} Learned phrase rows                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getUserLearnedPhrases(userId, options = {}) {
    if (!userId || typeof userId !== 'string') return [];

    const limit = Math.max(1, Math.min(
      typeof options.limit === 'number' ? options.limit : DEFAULT_PAGE_LIMIT,
      MAX_PAGE_LIMIT
    ));
    const offset = Math.max(0, typeof options.offset === 'number' ? options.offset : 0);

    try {
      const values = [userId];
      let paramIndex = 2;

      let query = `
        SELECT language_id, user_id, learned_phrase, normalized_phrase,
               base_concept, context, pad_coordinates, confidence_level,
               times_used, times_successful, avg_score,
               promoted_to_core, date_learned, last_used
        FROM cotw_user_language
        WHERE user_id = $1
          AND promoted_to_core = false
      `;

      if (options.baseConcept) {
        query += ` AND base_concept = $${paramIndex}`;
        values.push(options.baseConcept);
        paramIndex++;
      }

      query += ` ORDER BY confidence_level DESC, avg_score DESC NULLS LAST`;
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      values.push(limit, offset);

      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      logger.error('Failed to retrieve learned phrases', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Learned Phrase Count                                        */
  /*                                                                          */
  /*  Returns total count of learned phrases for a user.                      */
  /*  Useful for pagination controls and diagnostics.                         */
  /*                                                                          */
  /*  @param {string} userId — User hex ID                                    */
  /*  @returns {number} Total phrase count                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getLearnedPhraseCount(userId) {
    if (!userId) return 0;

    try {
      const result = await pool.query(`
        SELECT COUNT(*) as count
        FROM cotw_user_language
        WHERE user_id = $1
          AND promoted_to_core = false
      `, [userId]);

      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error('Failed to count learned phrases', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Record Usage                                                    */
  /*                                                                          */
  /*  Records when Claude uses a learned phrase in conversation.              */
  /*  Stores the usage context sentence for debugging and review.             */
  /*  Updates running average and adjusts confidence bidirectionally:         */
  /*                                                                          */
  /*  Promotion: times_successful >= 5 AND avg_score >= 4.0                  */
  /*    → confidence = MIN(confidence + 1, 5)                                */
  /*                                                                          */
  /*  Demotion: times_used >= 10 AND avg_score < 2.5                         */
  /*    → confidence = MAX(confidence - 1, 1)                                */
  /*                                                                          */
  /*  @param {string} languageId — Hex ID of the learned phrase              */
  /*  @param {boolean} wasSuccessful — Whether the usage was correct         */
  /*  @param {number} score — Quality score for this usage (0-5)             */
  /*  @param {string} [usageContext] — Sentence where phrase was used        */
  /*  @returns {object|null} Updated row or null if not found                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async recordUsage(languageId, wasSuccessful, score, usageContext) {
    if (!languageId || typeof languageId !== 'string') {
      throw new Error('LearningCapturer: languageId is required');
    }
    if (typeof score !== 'number' || score < 0 || score > 5) {
      throw new Error('LearningCapturer: score must be a number between 0 and 5');
    }

    try {
      const result = await pool.query(`
        UPDATE cotw_user_language
        SET times_used = times_used + 1,
            times_successful = times_successful + CASE WHEN $2 THEN 1 ELSE 0 END,
            avg_score = CASE
              WHEN avg_score IS NULL THEN $3
              ELSE (avg_score * times_used + $3) / (times_used + 1)
            END,
            last_used = NOW(),
            last_usage_context = $7,
            confidence_level = CASE
              WHEN (times_successful + CASE WHEN $2 THEN 1 ELSE 0 END) >= $4
                AND COALESCE(CASE WHEN avg_score IS NULL THEN $3 ELSE (avg_score * times_used + $3) / (times_used + 1) END, 0) >= $5
                THEN LEAST(confidence_level + 1, $6)
              WHEN (times_used + 1) >= $8
                AND COALESCE(CASE WHEN avg_score IS NULL THEN $3 ELSE (avg_score * times_used + $3) / (times_used + 1) END, 0) < $9
                THEN GREATEST(confidence_level - 1, $10)
              ELSE confidence_level
            END
        WHERE language_id = $1
        RETURNING language_id, learned_phrase, confidence_level,
                  times_used, times_successful, avg_score, last_used
      `, [
        languageId,
        wasSuccessful,
        score,
        PROMOTE_SUCCESS_THRESHOLD,
        PROMOTE_SCORE_THRESHOLD,
        MAX_CONFIDENCE,
        usageContext ? String(usageContext).slice(0, 500) : null,
        DEMOTE_USAGE_THRESHOLD,
        DEMOTE_SCORE_THRESHOLD,
        MIN_CONFIDENCE
      ]);

      if (result.rows.length === 0) {
        logger.warn('Recording usage for unknown language_id', { languageId });
        return null;
      }

      logger.debug('Recorded phrase usage', {
        languageId,
        wasSuccessful,
        score,
        newConfidence: result.rows[0].confidence_level
      });

      return result.rows[0];
    } catch (error) {
      logger.error('Failed to record usage', {
        languageId,
        error: error.message
      });
      throw error;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Signal Explanations                                             */
  /*                                                                          */
  /*  Translates a confidence level into a human-readable trust label.        */
  /*  Used by Claude's response generation to calibrate how he uses           */
  /*  learned phrases.                                                        */
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

export default new LearningCapturer();
