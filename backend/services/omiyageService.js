/**
 * ============================================================================
 * omiyageService.js — Gift Ritual Orchestrator (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages the Omiyage (gift) ritual where Claude the Tanuki offers items
 * from his inventory to users during the onboarding flow. This is the
 * "blind bag" gift system — users pick a number, Claude reveals the item.
 *
 * GIFT LIFECYCLE
 * --------------
 *   1. checkAndInitiateOmiyage  — Entry point on socket connect
 *   2. createOmiyageOffer       — Create offer record with FOR UPDATE lock
 *   3. buildOfferNarrative      — LTLM narrative for the offer
 *   4. resolveChoice            — User picks a number, resolve to object
 *   5. fulfilOmiyage            — Transfer item, write audit, update status
 *   6. buildFulfilmentNarrative — LTLM narrative for the reveal
 *   7. declineOmiyage           — User declines the gift
 *
 * STATUS PROGRESSION
 * ------------------
 *   chosen_unresolved -> resolved -> fulfilled
 *                     -> declined
 *
 * CONCURRENCY PROTECTION
 * ----------------------
 * All state-mutating operations use FOR UPDATE locks to prevent concurrent
 * socket reconnects from creating duplicate offers or double-fulfilling.
 * Resolution and fulfilment are idempotent — safe to retry on reconnect.
 *
 * ITEM RESOLUTION
 * ---------------
 * Items are resolved deterministically using ROW_NUMBER ordered by
 * inventory_entry_id ASC. This means the same number always maps to
 * the same item as long as Claude's inventory is not mutated between
 * offer and resolution.
 *
 * INTEGRATION WITH ONBOARDING
 * ---------------------------
 * This service is called by socketHandler.js during the onboarding flow.
 * The OnboardingOrchestrator manages the FSM state transitions
 * (omiyage_offered -> onboarded). This service manages the gift-specific
 * state in omiyage_choice_state. socketHandler coordinates both.
 *
 * COUNTER NAMING
 * --------------
 * All counters use British spelling to match function names:
 *   fulfil_success, fulfil_failure, fulfil_idempotent
 *
 * MIGRATION FROM v009
 * -------------------
 *   - 4 console.log/error replaced with structured logger
 *   - Hardcoded CLAUDE_ID replaced with constants import
 *   - storytellerWrapper import replaced with StorytellerBridge
 *   - correlationId threaded through all functions
 *   - Counters on every outcome
 *   - Query timeout protection added
 *   - declineOmiyage idempotency fix (returns status)
 *   - Error messages include choiceId context
 *   - Hardcoded slot_trait_hex_id extracted to constant
 *   - No logic changes to transactions, locks, or state flow
 *
 * CONSUMERS
 * ---------
 *   - socketHandler.js (omiyage:accept, omiyage:decline, omiyage:deferral)
 *
 * DEPENDENCIES
 * ------------
 *   Internal: pool.js, logger.js, hexIdGenerator.js, StorytellerBridge.js,
 *             constants.js, counters.js
 *   External: None
 *
 * SCHEMA DEPENDENCIES
 * -------------------
 *   omiyage_choice_state: choice_id, user_id, character_id, offer_count,
 *                         chosen_number, status, source, resolved_object_id,
 *                         giver_inventory_entry_id, resolved_at, fulfilled_at
 *   omiyage_fulfilment_audit: audit_id, choice_id, giver_character_id,
 *                             receiver_character_id, object_id,
 *                             inventory_entry_id, fulfilment_method, source
 *   character_inventory: inventory_entry_id, character_id, object_id,
 *                        binding_type, slot_trait_hex_id
 *   objects: object_id, object_name, object_type, description, rarity, p, a, d
 *
 * EXPORTS (all named, no default)
 * -------
 *   hasCompletedFirstOmiyage(userId, correlationId)
 *   getPendingOmiyage(userId, correlationId)
 *   getOfferableCount(correlationId)
 *   createOmiyageOffer(userId, offerCount, correlationId)
 *   buildOfferNarrative(offerCount)
 *   resolveChoice(choiceId, chosenNumber, correlationId)
 *   fulfilOmiyage(choiceId, receiverCharacterId, correlationId)
 *   buildFulfilmentNarrative(object)
 *   declineOmiyage(choiceId, correlationId)
 *   checkAndInitiateOmiyage(userId, correlationId)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import generateHexId from '../utils/hexIdGenerator.js';
import storytellerBridge from './StorytellerBridge.js';
import { CLAUDE_CHARACTER_ID } from '../councilTerminal/config/constants.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('OmiyageService');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const TIMEOUTS = Object.freeze({
  QUERY_MS: 5000
});

// Default slot trait for gifted items — extracted from v009 hardcoded value
// This is the "omiyage gift" slot trait in the trait system
const DEFAULT_GIFT_SLOT_TRAIT = Object.freeze({
  HEX_ID: '#00010E'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Internal Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _queryWithTimeout(client, sql, params) {
  let timer;
  return Promise.race([
    client.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Query timeout")), TIMEOUTS.QUERY_MS);
    })
  ]);
}

function _poolQueryWithTimeout(sql, params) {
  let timer;
  return Promise.race([
    pool.query(sql, params).then(res => { clearTimeout(timer); return res; }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Query timeout")), TIMEOUTS.QUERY_MS);
    })
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  State Queries                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Check if user has already completed first-login Omiyage
 */
export async function hasCompletedFirstOmiyage(userId, correlationId) {
  const result = await _poolQueryWithTimeout(`
    SELECT status FROM omiyage_choice_state
    WHERE user_id = $1
      AND source = 'first_login'
      AND status IN ('fulfilled', 'declined')
    LIMIT 1
  `, [userId]);

  const completed = result.rows.length > 0;
  if (completed) {
    logger.debug('First omiyage already completed', { userId, correlationId });
  }
  return completed;
}

/**
 * Check if user has a pending (mid-ritual) Omiyage
 */
export async function getPendingOmiyage(userId, correlationId) {
  const result = await _poolQueryWithTimeout(`
    SELECT choice_id, offer_count, status, resolved_object_id
    FROM omiyage_choice_state
    WHERE user_id = $1
      AND source = 'first_login'
      AND status IN ('chosen_unresolved', 'resolved')
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);

  const pending = result.rows[0] || null;
  if (pending) {
    logger.debug('Pending omiyage found', {
      userId,
      choiceId: pending.choice_id,
      status: pending.status,
      correlationId
    });
  }
  return pending;
}

/**
 * Get Claude's offerable inventory count
 */
export async function getOfferableCount(correlationId) {
  const result = await _poolQueryWithTimeout(`
    SELECT COUNT(*) as count
    FROM character_inventory
    WHERE character_id = $1
      AND (binding_type IS NULL OR binding_type <> 'soulbound')
  `, [CLAUDE_CHARACTER_ID]);
  return parseInt(result.rows[0].count, 10);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Offer Creation                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Create a new Omiyage offer for first-login.
 * Uses transaction with FOR UPDATE to prevent concurrent duplicate offers.
 */
export async function createOmiyageOffer(userId, offerCount, correlationId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check for existing active offer (concurrent socket protection)
    const existing = await _queryWithTimeout(client, `
      SELECT choice_id FROM omiyage_choice_state
      WHERE user_id = $1 AND status IN ('chosen_unresolved', 'resolved')
      FOR UPDATE
    `, [userId]);

    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      logger.debug('Existing active offer found', {
        userId,
        choiceId: existing.rows[0].choice_id,
        correlationId
      });
      return existing.rows[0].choice_id;
    }

    // NOTE: Using omiyage_event_id for choice IDs
    // Future: Consider distinct omiyage_choice_id range
    // NOTE: generateHexId commits independently. If outer transaction rolls back,
    // hex counter is permanently incremented, creating ID gaps (acceptable by design).
    const choiceId = await generateHexId('omiyage_event_id');

    await _queryWithTimeout(client, `
      INSERT INTO omiyage_choice_state (
        choice_id, user_id, character_id, offer_count,
        chosen_number, status, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [choiceId, userId, CLAUDE_CHARACTER_ID, offerCount, 0, 'chosen_unresolved', 'first_login']);

    await client.query('COMMIT');

    Counters.increment('omiyage', 'offer_created');

    return choiceId;

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create offer', {
      userId,
      error: err.message,
      correlationId
    });
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Narrative Generation                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the offer narrative using LTLM
 */
export async function buildOfferNarrative(offerCount, correlationId) {
  const result = await storytellerBridge.buildStorytellerResponse({
    intentResult: { type: 'SYSTEM_OMIYAGE_OFFER' },
    contentBlocks: [`I have ${offerCount} treasures from my journeys. Pick a number, 1 to ${offerCount}.`],
    tone: 'playful',
    formality: 'casual',
    outcomeIntent: 'connection',
    strategy: 'gift_offer',
    correlationId
  });
  return result.output;
}

/**
 * Build the fulfilment narrative using LTLM
 */
export async function buildFulfilmentNarrative(object, correlationId) {
  const rarityFlair = object.rarity === 'legendary' ? 'A legendary find!' :
                      object.rarity === 'rare' ? 'Quite rare, this one.' : '';
  const contentBlocks = [
    `You receive the **${object.object_name}**.`,
    rarityFlair,
    object.description
  ].filter(Boolean);
  const result = await storytellerBridge.buildStorytellerResponse({
    intentResult: { type: 'SYSTEM_OMIYAGE_REVEAL' },
    contentBlocks,
    tone: 'playful',
    formality: 'casual',
    outcomeIntent: 'connection',
    strategy: 'gift_reveal',
    correlationId
  });
  return result.output;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Choice Resolution                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Record user's choice and resolve to specific object.
 * NOTE: Inventory ordering assumes Claude's inventory is static during resolution.
 * Do not mutate Claude's inventory concurrently.
 */
export async function resolveChoice(choiceId, chosenNumber, correlationId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verify choice exists and is unresolved
    const choiceResult = await _queryWithTimeout(client, `
      SELECT offer_count, status
      FROM omiyage_choice_state
      WHERE choice_id = $1
      FOR UPDATE
    `, [choiceId]);

    if (!choiceResult.rows.length) {
      throw new Error(`Invalid choice ID: ${choiceId}`);
    }

    const { offer_count, status } = choiceResult.rows[0];

    // Idempotent: Already resolved — return current state
    if (status !== 'chosen_unresolved') {
      await client.query('ROLLBACK');
      Counters.increment('omiyage', 'resolve_idempotent');
      return { alreadyResolved: true, status };
    }

    if (chosenNumber < 1 || chosenNumber > offer_count) {
      throw new Error(`Choice must be between 1 and ${offer_count} (choiceId: ${choiceId})`);
    }

    // 2. Resolve to specific object using deterministic ROW_NUMBER
    const inventoryResult = await _queryWithTimeout(client, `
      WITH ordered_inventory AS (
        SELECT
          inventory_entry_id,
          object_id,
          ROW_NUMBER() OVER (ORDER BY inventory_entry_id ASC) AS position
        FROM character_inventory
        WHERE character_id = $1
          AND (binding_type IS NULL OR binding_type <> 'soulbound')
      )
      SELECT inventory_entry_id, object_id
      FROM ordered_inventory
      WHERE position = $2
    `, [CLAUDE_CHARACTER_ID, chosenNumber]);

    if (!inventoryResult.rows.length) {
      throw new Error(`Failed to resolve object at position ${chosenNumber} (choiceId: ${choiceId})`);
    }

    const { inventory_entry_id, object_id } = inventoryResult.rows[0];

    // 3. Update choice state to resolved
    await _queryWithTimeout(client, `
      UPDATE omiyage_choice_state
      SET status = 'resolved',
          chosen_number = $2,
          resolved_object_id = $3,
          giver_inventory_entry_id = $4,
          resolved_at = NOW()
      WHERE choice_id = $1
    `, [choiceId, chosenNumber, object_id, inventory_entry_id]);

    await client.query('COMMIT');

    Counters.increment('omiyage', 'choice_resolved');
    logger.info('Choice resolved', {
      choiceId,
      chosenNumber,
      objectId: object_id,
      correlationId
    });

    return {
      alreadyResolved: false,
      objectId: object_id,
      inventoryEntryId: inventory_entry_id
    };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Resolution failed', {
      choiceId,
      chosenNumber,
      error: err.message,
      correlationId
    });
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Fulfilment                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Complete the fulfilment: transfer item, write audit, update status
 */
export async function fulfilOmiyage(choiceId, receiverCharacterId, correlationId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Get resolved choice
    const choiceResult = await _queryWithTimeout(client, `
      SELECT resolved_object_id, giver_inventory_entry_id, character_id, status
      FROM omiyage_choice_state
      WHERE choice_id = $1
      FOR UPDATE
    `, [choiceId]);

    if (!choiceResult.rows.length) {
      throw new Error(`No choice found: ${choiceId}`);
    }

    const { resolved_object_id, giver_inventory_entry_id, character_id, status } = choiceResult.rows[0];

    // Idempotent: Already fulfilled
    if (status === 'fulfilled') {
      await client.query('ROLLBACK');
      Counters.increment('omiyage', 'fulfil_idempotent');

      // Fetch object details for response (outside transaction)
      const objectResult = await _poolQueryWithTimeout(`
        SELECT object_name, object_type, description, rarity, p, a, d
        FROM objects WHERE object_id = $1
      `, [resolved_object_id]);

      return {
        success: true,
        alreadyFulfilled: true,
        object: objectResult.rows[0]
      };
    }

    if (status !== 'resolved') {
      throw new Error(`Cannot fulfil choice with status: ${status} (choiceId: ${choiceId})`);
    }

    // 2. Delete from giver's inventory
    const deleteResult = await _queryWithTimeout(client, `
      DELETE FROM character_inventory
      WHERE inventory_entry_id = $1 AND character_id = $2
      RETURNING inventory_entry_id
    `, [giver_inventory_entry_id, character_id]);

    if (!deleteResult.rows.length) {
      throw new Error(`Failed to remove item from giver inventory (choiceId: ${choiceId})`);
    }

    // 3. Insert into receiver's inventory
    // NOTE: generateHexId commits independently. ID gaps on rollback are acceptable by design.
    const newInventoryEntryId = await generateHexId('inventory_entry_id');

    await _queryWithTimeout(client, `
      INSERT INTO character_inventory (
        inventory_entry_id, character_id, object_id, binding_type, slot_trait_hex_id
      ) VALUES ($1, $2, $3, NULL, $4)
    `, [newInventoryEntryId, receiverCharacterId, resolved_object_id, DEFAULT_GIFT_SLOT_TRAIT.HEX_ID]);

    // 4. Write audit record
    // NOTE: generateHexId commits independently. ID gaps on rollback are acceptable by design.
    const auditId = await generateHexId('omiyage_event_id');

    await _queryWithTimeout(client, `
      INSERT INTO omiyage_fulfilment_audit (
        audit_id, choice_id, giver_character_id, receiver_character_id,
        object_id, inventory_entry_id, fulfilment_method, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [auditId, choiceId, character_id, receiverCharacterId,
        resolved_object_id, newInventoryEntryId, 'blind_bag', 'omiyageService_v010']);

    // 5. Update choice state to fulfilled
    await _queryWithTimeout(client, `
      UPDATE omiyage_choice_state
      SET status = 'fulfilled', fulfilled_at = NOW()
      WHERE choice_id = $1
    `, [choiceId]);

    await client.query('COMMIT');

    Counters.increment('omiyage', 'fulfil_success');
    logger.info('Omiyage fulfilled', {
      choiceId,
      auditId,
      objectId: resolved_object_id,
      receiverCharacterId,
      correlationId
    });

    // 6. Get object details for narrative (non-critical, safe outside transaction)
    const objectResult = await _poolQueryWithTimeout(`
      SELECT object_name, object_type, description, rarity, p, a, d
      FROM objects WHERE object_id = $1
    `, [resolved_object_id]);

    return {
      success: true,
      alreadyFulfilled: false,
      auditId,
      object: objectResult.rows[0],
      newInventoryEntryId
    };

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Fulfilment failed', {
      choiceId,
      receiverCharacterId,
      error: err.message,
      correlationId
    });
    Counters.increment('omiyage', 'fulfil_failure');
    throw err;
  } finally {
    client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Decline                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle decline — idempotent, returns status.
 * If already declined/fulfilled, returns current status without narrative.
 * Caller must handle the asymmetry: declined=true includes narrative,
 * declined=false does not.
 */
export async function declineOmiyage(choiceId, correlationId) {
  const result = await _poolQueryWithTimeout(`
    UPDATE omiyage_choice_state
    SET status = 'declined'
    WHERE choice_id = $1 AND status = 'chosen_unresolved'
    RETURNING status
  `, [choiceId]);

  if (result.rows.length === 0) {
    // Either already declined/fulfilled or invalid ID — check current status
    const current = await _poolQueryWithTimeout(
      'SELECT status FROM omiyage_choice_state WHERE choice_id = $1',
      [choiceId]
    );

    if (current.rows.length === 0) {
      throw new Error(`Invalid choice ID: ${choiceId}`);
    }

    logger.debug('Decline idempotent — already processed', {
      choiceId,
      currentStatus: current.rows[0].status,
      correlationId
    });
    Counters.increment('omiyage', 'decline_idempotent');

    return { declined: false, currentStatus: current.rows[0].status };
  }

  Counters.increment('omiyage', 'declined');
  logger.info('Omiyage declined', { choiceId, correlationId });

  const narrative = await storytellerBridge.buildStorytellerResponse({
    intentResult: { type: 'SYSTEM_OMIYAGE_DECLINE' },
    contentBlocks: ['Your choice is respected.'],
    tone: 'warm',
    formality: 'casual',
    outcomeIntent: 'validation',
    strategy: 'gift_decline'
  });

  return { declined: true, narrative: narrative.output };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main Entry Point                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Check and initiate Omiyage on socket connect.
 * Called by socketHandler.js during onboarding flow.
 */
export async function checkAndInitiateOmiyage(userId, correlationId) {
  // 1. Already completed?
  if (await hasCompletedFirstOmiyage(userId, correlationId)) {
    return null;
  }

  // 2. Pending offer to resume?
  const pending = await getPendingOmiyage(userId, correlationId);
  if (pending) {
    logger.info('Resuming pending offer', {
      userId,
      choiceId: pending.choice_id,
      status: pending.status,
      correlationId
    });
    Counters.increment('omiyage', 'offer_resumed');

    // If already resolved, skip to fulfilment
    if (pending.status === 'resolved') {
      return {
        type: 'resume_resolved',
        choiceId: pending.choice_id,
        status: 'resolved'
      };
    }

    const narrative = await buildOfferNarrative(pending.offer_count, correlationId);
    return {
      type: 'resume',
      choiceId: pending.choice_id,
      offerCount: pending.offer_count,
      narrative
    };
  }

  // 3. Check inventory
  const offerCount = await getOfferableCount(correlationId);
  if (offerCount === 0) {
    logger.error('Claude has no giftable items — skipping offer', {
      userId,
      correlationId
    });
    Counters.increment('omiyage', 'no_inventory_alert');
    return null;
  }

  // 4. Create new offer (with concurrent socket protection)
  const choiceId = await createOmiyageOffer(userId, offerCount, correlationId);
  const narrative = await buildOfferNarrative(offerCount, correlationId);

  logger.info('New offer created', {
    userId,
    choiceId,
    offerCount,
    correlationId
  });
  Counters.increment('omiyage', 'new_offer_flow');

  return {
    type: 'new',
    choiceId,
    offerCount,
    narrative
  };
}
