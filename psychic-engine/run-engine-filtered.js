/**
 * ===========================================================================
 * RUN ENGINE FILTERED — Psychic Engine Tick Scheduler
 * ===========================================================================
 *
 * PURPOSE:
 * Standalone script that runs a single tick of the Psychic Engine.
 * Fetches all narrative characters (excludes Knowledge Entities),
 * processes them through the engine in batch, and reports results.
 *
 * This is the entry point for scheduled emotional state recalculation.
 * Can be run manually, via cron, or triggered by game events.
 *
 * WHAT IT DOES:
 *   1. Connects to the database via pool
 *   2. Queries active narrative characters (excluding Knowledge Entity)
 *   3. Passes all character IDs to engine.processCharacters() (batch)
 *   4. Logs summary metrics (successful, failed, skipped, timing)
 *   5. Exits cleanly
 *
 * WHAT IT DOES NOT DO:
 *   - Does not run on a timer/interval (caller's responsibility)
 *   - Does not process Knowledge Entities (they have no emotional state)
 *   - Does not modify character data (engine handles all persistence)
 *
 * DEPENDENCIES:
 *   - pool (backend/db/pool.js) — database connection
 *   - PsychicEngine (./engine.js) — emotional physics engine
 *   - createModuleLogger (backend/utils/logger.js) — structured logging
 *
 * V010 STANDARDS:
 *   - Structured logger — no console.log
 *   - Correlation ID for entire tick cycle
 *   - Uses engine.processCharacters() batch method
 *   - Dependency injection (pool into engine constructor)
 *   - Clean exit with proper pool drainage
 *
 * HISTORY:
 *   v009 — console.log, syntax errors on template literals, no batch,
 *          no correlation ID, SELECT * for count, no pool injection.
 *   v010 — Structured logging, batch processing, correlation ID,
 *          pool injection, proper cleanup, metrics reporting.
 * ===========================================================================
 */

import pool from '../backend/db/pool.js';
import PsychicEngine from './engine.js';
import { createModuleLogger } from '../backend/utils/logger.js';
import crypto from 'crypto';

const logger = createModuleLogger('PsychicEngineTick');

async function runEngine() {
  const correlationId = crypto.randomUUID();
  const startTime = Date.now();

  logger.info('Psychic engine tick started', { correlationId });

  const engine = new PsychicEngine({ pool });

  try {
    const result = await pool.query(
      `SELECT character_id, character_name, category
       FROM character_profiles
       WHERE category != 'Knowledge Entity'
       ORDER BY character_id`
    );

    const characterIds = result.rows.map(r => r.character_id);

    logger.info('Characters loaded for processing', {
      correlationId,
      characterCount: characterIds.length,
      categories: [...new Set(result.rows.map(r => r.category))]
    });

    if (characterIds.length === 0) {
      logger.warn('No characters found to process', { correlationId });
      return;
    }

    const results = await engine.processCharacters(characterIds, correlationId);

    const successful = results.filter(r => r.result !== null && !r.error).length;
    const failed = results.filter(r => r.error).length;
    const skipped = results.filter(r => r.result === null && !r.error).length;

    const countResult = await pool.query('SELECT COUNT(*) FROM psychic_frames');
    const totalFrames = parseInt(countResult.rows[0].count, 10);

    const totalMs = Date.now() - startTime;
    const metrics = engine.getMetrics();

    logger.info('Psychic engine tick complete', {
      correlationId,
      successful,
      failed,
      skipped,
      totalFrames,
      totalMs,
      engineMetrics: metrics
    });

  } catch (error) {
    logger.error('Psychic engine tick failed', error, { correlationId });
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    const totalMs = Date.now() - startTime;
    logger.info('Pool drained, exiting', { correlationId, totalMs });
  }
}

runEngine();
