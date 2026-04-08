/**
 * ============================================================================
 * ConversationStateManager.js — Conversation State Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages persistent conversation state in PostgreSQL. Tracks QUD (Questions
 * Under Discussion) stacks, sequence position, repair state, common ground,
 * and dialogue move history for each active conversation.
 *
 * This is the foundational state layer that BrainOrchestrator, RepairHandler,
 * and the pipeline phases use to understand "where we are" in a conversation.
 *
 * QUD (QUESTIONS UNDER DISCUSSION)
 * --------------------------------
 * The QUD stack tracks what Claude has asked the user and is awaiting answers
 * for. Based on Ginzburg (2012) — "The Interactive Stance." When Claude asks
 * a question, it pushes onto the stack. When the user answers, it resolves.
 *
 * Stack invariant: oldest at index 0, newest at end.
 * Max depth: 5. When exceeded, oldest QUD merges into sub_questions of the
 * next oldest, preserving context without unbounded growth.
 *
 * SEQUENCE POSITION
 * -----------------
 * Tracks conversation phase: opening → first_topic → middle → pre_closing
 * → closing. Used by pipeline phases to adjust tone and behaviour.
 *
 * REPAIR STATE
 * ------------
 * Tracks whether a conversational repair is in progress. Set by
 * RepairHandler when a misunderstanding is detected, cleared when resolved.
 * All repair mutations use transactions for atomicity.
 *
 * COMMON GROUND
 * -------------
 * JSONB accumulator of shared knowledge established during conversation.
 * Append-only — facts agreed upon by both parties.
 *
 * MOVE HISTORY
 * ------------
 * Rolling window of last MAX_LAST_MOVES dialogue moves with timestamps.
 * Used by BrainOrchestrator for context and by future analysis.
 *
 * DATABASE TABLES
 * ---------------
 * conversation_states — One row per conversation. Contains qud_stack,
 *   sequence_position, repair state, common_ground, last_moves.
 * conversation_qud — One row per QUD entry. Contains question text,
 *   speaker, topic, entities, status, resolution data, sub_questions.
 *
 * TRANSACTION DISCIPLINE
 * ----------------------
 * ALL mutation methods use _withTransaction() for consistent safety.
 * Read-only methods (getState, getOpenQUDs) use pool.query directly
 * with error handling. Multi-query reads (getTopQUD) use transactions
 * to ensure atomicity.
 *
 * EARWIG INTEGRATION
 * ------------------
 * RepairHandler reads repair state via getState(). EarWig does not call
 * this service directly — it is consumed by pipeline phases and the
 * orchestrator.
 *
 * CHANGES FROM v009
 * -----------------
 * - Full v010 documentation header
 * - _withTransaction() helper eliminates transaction boilerplate
 * - ALL mutation methods now use _withTransaction() consistently
 * - getOrCreateState now uses transaction (was race-prone)
 * - getTopQUD now uses transaction (was non-atomic two-query read)
 * - addToCommonGround now uses transaction with error handling
 * - pushQUD validates qudData fields before DB operations
 * - Move limit re-enabled as MAX_LAST_MOVES constant (was commented out)
 * - SEQUENCE_POSITIONS frozen at module level
 * - Input validation on all public methods
 * - Redundant module name prefix removed from logger messages
 * - Consistent conversationId context in all log entries
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: ConversationStateManager (PascalCase)
 * Export: singleton instance (matches RepairHandler pattern)
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

const logger = createModuleLogger('ConversationStateManager');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const SEQUENCE_POSITIONS = Object.freeze([
  'opening', 'first_topic', 'middle', 'pre_closing', 'closing'
]);

const MAX_QUD_DEPTH = 5;
const MAX_LAST_MOVES = 20;

/* ────────────────────────────────────────────────────────────────────────── */
/*  ConversationStateManager Class                                            */
/* ────────────────────────────────────────────────────────────────────────── */

class ConversationStateManager {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Transaction Helper                                             */
  /*                                                                          */
  /*  Wraps a callback in BEGIN/COMMIT/ROLLBACK with guaranteed               */
  /*  client.release(). Eliminates transaction boilerplate across all         */
  /*  mutation methods.                                                       */
  /*                                                                          */
  /*  @param {function} callback — async (client) => result                   */
  /*  @returns {*} Result of callback                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _withTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Input Validation                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _validateId(id, name) {
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`${name} is required and must be a non-empty string`);
    }
  }

  _validateQudData(qudData) {
    if (!qudData || typeof qudData !== 'object') {
      throw new Error('qudData is required and must be an object');
    }
    if (!qudData.actCode || typeof qudData.actCode !== 'string') {
      throw new Error('qudData.actCode is required and must be a string');
    }
    if (!qudData.questionText || typeof qudData.questionText !== 'string') {
      throw new Error('qudData.questionText is required and must be a string');
    }
    if (qudData.turnIndex === undefined || qudData.turnIndex === null) {
      throw new Error('qudData.turnIndex is required');
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Get Or Create State                                                     */
  /*                                                                          */
  /*  Returns existing conversation state or creates a new one. Uses a        */
  /*  transaction with FOR UPDATE to prevent race conditions on concurrent    */
  /*  logins where two requests might both see no existing state and create   */
  /*  duplicates.                                                             */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} userId — Hex user ID                                    */
  /*  @returns {object} conversation_states row                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getOrCreateState(conversationId, userId) {
    this._validateId(conversationId, 'conversationId');
    this._validateId(userId, 'userId');

    return this._withTransaction(async (client) => {
      const result = await client.query(
        'SELECT * FROM conversation_states WHERE conversation_id = $1 FOR UPDATE',
        [conversationId]
      );

      if (result.rows.length > 0) {
        return result.rows[0];
      }

      const stateId = await generateHexId('conversation_state_id');
      const insertResult = await client.query(`
        INSERT INTO conversation_states (state_id, conversation_id, user_id)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [stateId, conversationId, userId]);

      logger.info('Created new conversation state', {
        stateId,
        conversationId
      });

      return insertResult.rows[0];
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Push QUD                                                                */
  /*                                                                          */
  /*  Adds a new Question Under Discussion to the stack. If stack exceeds     */
  /*  MAX_QUD_DEPTH, oldest QUD is merged into sub_questions of the next      */
  /*  oldest to preserve context without unbounded growth.                    */
  /*                                                                          */
  /*  Stack invariant: oldest at index 0, newest at end.                      */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} userId — Hex user ID                                    */
  /*  @param {object} qudData — Question data                                 */
  /*  @param {string} qudData.actCode — Dialogue act code (required)          */
  /*  @param {string} qudData.questionText — Question text (required)         */
  /*  @param {number} qudData.turnIndex — Turn number (required)              */
  /*  @param {string} [qudData.speaker] — Speaker (default: 'user')           */
  /*  @param {string} [qudData.topic] — Topic of question                     */
  /*  @param {array}  [qudData.entities] — Relevant entities                  */
  /*  @returns {string} New QUD hex ID                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async pushQUD(conversationId, userId, qudData) {
    this._validateId(conversationId, 'conversationId');
    this._validateId(userId, 'userId');
    this._validateQudData(qudData);

    return this._withTransaction(async (client) => {
      const qudId = await generateHexId('qud_id');

      await client.query(`
        INSERT INTO conversation_qud (
          qud_id, conversation_id, user_id, act_code, question_text,
          speaker, topic, entities, turn_index, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')
      `, [
        qudId,
        conversationId,
        userId,
        qudData.actCode,
        qudData.questionText,
        qudData.speaker || 'user',
        qudData.topic || null,
        JSON.stringify(qudData.entities || []),
        qudData.turnIndex
      ]);

      const stateResult = await client.query(
        'SELECT qud_stack FROM conversation_states WHERE conversation_id = $1 FOR UPDATE',
        [conversationId]
      );

      let qudStack = stateResult.rows[0]?.qud_stack || [];

      if (qudStack.length >= MAX_QUD_DEPTH) {
        const overflowId = qudStack[0];
        await this._mergeOverflowToSubQuestions(client, overflowId, qudStack.slice(1));
        qudStack = qudStack.slice(1);
      }

      qudStack.push(qudId);

      await client.query(`
        UPDATE conversation_states
        SET qud_stack = $1, current_topic = $2, updated_at = NOW()
        WHERE conversation_id = $3
      `, [JSON.stringify(qudStack), qudData.topic, conversationId]);

      logger.info('Pushed QUD to stack', {
        qudId,
        conversationId,
        depth: qudStack.length
      });

      return qudId;
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Merge Overflow QUDs To Sub-Questions                           */
  /*                                                                          */
  /*  When stack exceeds MAX_QUD_DEPTH, oldest QUD absorbs overflow IDs       */
  /*  as sub_questions. Preserves context without unbounded stack growth.     */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _mergeOverflowToSubQuestions(client, targetQudId, overflowIds) {
    if (overflowIds.length === 0) return;

    const subQuestionObjects = overflowIds.map(id => ({ qud_id: id }));

    await client.query(`
      UPDATE conversation_qud
      SET sub_questions = sub_questions || $1::jsonb
      WHERE qud_id = $2
    `, [JSON.stringify(subQuestionObjects), targetQudId]);

    logger.debug('Merged overflow QUDs', {
      count: overflowIds.length,
      targetQudId
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Resolve QUD                                                             */
  /*                                                                          */
  /*  Marks a QUD as resolved and removes it from the active stack.           */
  /*  Logs a warning if the QUD is not found in the current stack (data       */
  /*  inconsistency — continues safely but signals investigation needed).     */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} qudId — Hex QUD ID to resolve                          */
  /*  @param {object} resolutionData — Resolution details                     */
  /*  @returns {boolean} true on success                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async resolveQUD(conversationId, qudId, resolutionData) {
    this._validateId(conversationId, 'conversationId');
    this._validateId(qudId, 'qudId');

    return this._withTransaction(async (client) => {
      await client.query(`
        UPDATE conversation_qud
        SET status = 'resolved',
            resolution_type = $1,
            resolved_by_act_id = $2,
            resolution_summary = $3,
            resolved_at = NOW()
        WHERE qud_id = $4
      `, [
        resolutionData.type || 'full',
        resolutionData.resolvedByActId || null,
        resolutionData.summary || null,
        qudId
      ]);

      const stateResult = await client.query(
        'SELECT qud_stack FROM conversation_states WHERE conversation_id = $1 FOR UPDATE',
        [conversationId]
      );

      let qudStack = stateResult.rows[0]?.qud_stack || [];

      if (!qudStack.includes(qudId)) {
        logger.warn('Resolving QUD not found in active stack', {
          qudId,
          conversationId,
          stackContents: qudStack
        });
      }

      qudStack = qudStack.filter(id => id !== qudId);

      await client.query(`
        UPDATE conversation_states
        SET qud_stack = $1, updated_at = NOW()
        WHERE conversation_id = $2
      `, [JSON.stringify(qudStack), conversationId]);

      logger.info('Resolved QUD', {
        qudId,
        conversationId,
        type: resolutionData.type || 'full'
      });

      return true;
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Abandon QUD                                                             */
  /*                                                                          */
  /*  Marks a QUD as abandoned (user did not answer) and removes from stack.  */
  /*  Sets resolved_at for timing metrics.                                    */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} qudId — Hex QUD ID to abandon                          */
  /*  @returns {boolean} true on success                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  async abandonQUD(conversationId, qudId) {
    this._validateId(conversationId, 'conversationId');
    this._validateId(qudId, 'qudId');

    return this._withTransaction(async (client) => {
      await client.query(`
        UPDATE conversation_qud
        SET status = 'abandoned', resolved_at = NOW()
        WHERE qud_id = $1
      `, [qudId]);

      const stateResult = await client.query(
        'SELECT qud_stack FROM conversation_states WHERE conversation_id = $1 FOR UPDATE',
        [conversationId]
      );

      let qudStack = stateResult.rows[0]?.qud_stack || [];
      qudStack = qudStack.filter(id => id !== qudId);

      await client.query(`
        UPDATE conversation_states
        SET qud_stack = $1, updated_at = NOW()
        WHERE conversation_id = $2
      `, [JSON.stringify(qudStack), conversationId]);

      logger.info('Abandoned QUD', {
        qudId,
        conversationId
      });

      return true;
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Get Top QUD                                                             */
  /*                                                                          */
  /*  Returns the most recent open QUD (top of stack). Uses a transaction     */
  /*  to ensure atomic read of state + QUD row.                               */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @returns {object|null} QUD row or null if stack empty                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getTopQUD(conversationId) {
    this._validateId(conversationId, 'conversationId');

    return this._withTransaction(async (client) => {
      const result = await client.query(
        'SELECT qud_stack FROM conversation_states WHERE conversation_id = $1',
        [conversationId]
      );

      const qudStack = result.rows[0]?.qud_stack || [];
      if (qudStack.length === 0) return null;

      const topQudId = qudStack[qudStack.length - 1];

      const qudResult = await client.query(
        'SELECT * FROM conversation_qud WHERE qud_id = $1',
        [topQudId]
      );

      return qudResult.rows[0] || null;
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Get Open QUDs                                                           */
  /*                                                                          */
  /*  Returns all open (unresolved) QUDs for a conversation, ordered by       */
  /*  turn index ascending (oldest first).                                    */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @returns {array} QUD rows                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getOpenQUDs(conversationId) {
    this._validateId(conversationId, 'conversationId');

    try {
      const result = await pool.query(`
        SELECT * FROM conversation_qud
        WHERE conversation_id = $1 AND status = 'open'
        ORDER BY turn_index ASC
      `, [conversationId]);

      return result.rows;
    } catch (error) {
      logger.error('Failed to get open QUDs', error, { conversationId });
      return [];
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Update Sequence Position                                                */
  /*                                                                          */
  /*  Sets the conversation phase. Valid positions: opening, first_topic,     */
  /*  middle, pre_closing, closing.                                           */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} newPosition — One of SEQUENCE_POSITIONS                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async updateSequencePosition(conversationId, newPosition) {
    this._validateId(conversationId, 'conversationId');

    if (!SEQUENCE_POSITIONS.includes(newPosition)) {
      throw new Error(`Invalid sequence position: ${newPosition}. Must be one of: ${SEQUENCE_POSITIONS.join(', ')}`);
    }

    return this._withTransaction(async (client) => {
      await client.query(`
        UPDATE conversation_states
        SET sequence_position = $1, updated_at = NOW()
        WHERE conversation_id = $2
      `, [newPosition, conversationId]);

      logger.info('Updated sequence position', {
        conversationId,
        newPosition
      });
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Set Repair In Progress                                                  */
  /*                                                                          */
  /*  Marks that a conversational repair is active. Called by RepairHandler    */
  /*  when a misunderstanding is detected.                                    */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} repairType — Type of repair (open_class, wh_question)   */
  /*  @param {object} repairSource — Detection source metadata                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async setRepairInProgress(conversationId, repairType, repairSource) {
    this._validateId(conversationId, 'conversationId');

    return this._withTransaction(async (client) => {
      await client.query(`
        UPDATE conversation_states
        SET repair_in_progress = true,
            repair_type = $1,
            repair_source = $2,
            updated_at = NOW()
        WHERE conversation_id = $3
      `, [repairType, JSON.stringify(repairSource), conversationId]);

      logger.info('Repair started', {
        conversationId,
        repairType
      });
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Clear Repair                                                            */
  /*                                                                          */
  /*  Clears the repair state after resolution.                               */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  async clearRepair(conversationId) {
    this._validateId(conversationId, 'conversationId');

    return this._withTransaction(async (client) => {
      await client.query(`
        UPDATE conversation_states
        SET repair_in_progress = false,
            repair_type = NULL,
            repair_source = NULL,
            updated_at = NOW()
        WHERE conversation_id = $1
      `, [conversationId]);

      logger.info('Repair cleared', { conversationId });
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Add To Common Ground                                                    */
  /*                                                                          */
  /*  Appends a key-value pair to the conversation's shared knowledge.        */
  /*  JSONB merge — existing keys with the same name will be overwritten.     */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {string} key — Knowledge key                                     */
  /*  @param {*} value — Knowledge value (must be JSON-serialisable)          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async addToCommonGround(conversationId, key, value) {
    this._validateId(conversationId, 'conversationId');

    if (!key || typeof key !== 'string') {
      throw new Error('Common ground key is required and must be a string');
    }

    return this._withTransaction(async (client) => {
      await client.query(`
        UPDATE conversation_states
        SET common_ground = common_ground || $1::jsonb,
            updated_at = NOW()
        WHERE conversation_id = $2
      `, [JSON.stringify({ [key]: value }), conversationId]);
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Record Move                                                             */
  /*                                                                          */
  /*  Appends a dialogue move to the conversation's move history.             */
  /*  Rolling window: keeps last MAX_LAST_MOVES entries to prevent            */
  /*  unbounded growth over long conversations.                               */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @param {object} move — Dialogue move data                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  async recordMove(conversationId, move) {
    this._validateId(conversationId, 'conversationId');

    return this._withTransaction(async (client) => {
      const result = await client.query(
        'SELECT last_moves FROM conversation_states WHERE conversation_id = $1 FOR UPDATE',
        [conversationId]
      );

      let lastMoves = result.rows[0]?.last_moves || [];
      lastMoves.push({
        ...move,
        timestamp: new Date().toISOString()
      });

      if (lastMoves.length > MAX_LAST_MOVES) {
        lastMoves = lastMoves.slice(-MAX_LAST_MOVES);
      }

      await client.query(`
        UPDATE conversation_states
        SET last_moves = $1, updated_at = NOW()
        WHERE conversation_id = $2
      `, [JSON.stringify(lastMoves), conversationId]);
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Get State                                                               */
  /*                                                                          */
  /*  Returns the full conversation state row. Returns null if not found.     */
  /*                                                                          */
  /*  @param {string} conversationId — Hex conversation ID                    */
  /*  @returns {object|null} conversation_states row or null                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getState(conversationId) {
    this._validateId(conversationId, 'conversationId');

    try {
      const result = await pool.query(
        'SELECT * FROM conversation_states WHERE conversation_id = $1',
        [conversationId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to get conversation state', error, { conversationId });
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Get Conversation Context for EarWig (read-only)                */
  /*                                                                        */
  /*  Lightweight wrapper around getState() that returns a standardised     */
  /*  context object for EarWig consumption. No DB writes.                  */
  /*                                                                        */
  /*  @param {string} conversationId — Hex conversation ID                  */
  /*  @returns {object} Standardised conversation context                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getConversationContext(conversationId) {
    const state = await this.getState(conversationId);

    if (!state) {
      return {
        sequencePosition: 'opening',
        turnCount: 0,
        qudDepth: 0,
        repairInProgress: false,
        repairType: null,
        currentTopic: null,
        commonGroundSize: 0,
        hasHistory: false
      };
    }

    const qudStack = state.qud_stack || [];
    const lastMoves = state.last_moves || [];
    const commonGround = state.common_ground || {};

    return {
      sequencePosition: state.sequence_position || 'opening',
      turnCount: lastMoves.length,
      qudDepth: qudStack.length,
      repairInProgress: state.repair_in_progress || false,
      repairType: state.repair_type || null,
      currentTopic: state.current_topic || null,
      commonGroundSize: Object.keys(commonGround).length,
      hasHistory: lastMoves.length > 0
    };
  }

}

export default new ConversationStateManager();
