/**
 * ===========================================================================
 * ChaosDistributor.js — Main Orchestrator for Chaos Engine Generation
 * ===========================================================================
 *
 * PURPOSE:
 * Entry point for generating and retrieving a user's frozen distribution.
 * Coordinates the full pipeline: check for existing distribution → seed →
 * solve → validate → re-seed if needed → persist to database.
 *
 * This is the module that episode loaders call. One method does everything:
 *   ChaosDistributor.getDistribution(userId, episode, belt, purchaseCode)
 *
 * FLOW:
 *   1. Check chaos_user_distributions for existing frozen distribution
 *      → If found, return it immediately (distributions are immutable)
 *   2. Create ChaosSeeder from user hex ID + optional purchase code
 *   3. Load slots and assets from database for episode/belt
 *   4. Run ChaosSolver.solveEpisode() to generate distribution
 *   5. Validate via ChaosValidator
 *   6. If validation fails: increment seed modifier, retry (up to 5 attempts)
 *   7. Persist frozen distribution to chaos_user_distributions
 *   8. Return distribution with metadata
 *
 * FROZEN DISTRIBUTION PRINCIPLE:
 *   Once written to chaos_user_distributions, a distribution is NEVER
 *   modified. Belt upgrades generate NEW rows (new belt layer on top of
 *   existing frozen layers). The UNIQUE(user_id, slot_id) constraint
 *   prevents duplicate assignments.
 *
 * RE-SEED STRATEGY:
 *   On validation failure, the seed modifier is appended to the user hex
 *   before hashing: "#D0000A" → "#D0000A:1" → "#D0000A:2" etc.
 *   This produces a deterministic alternative universe. After max attempts,
 *   accepts best effort and persists. Never blocks user onboarding.
 *
 * EPISODE LOCK:
 *   recordEpisodeLock() snapshots the user's belt level at episode entry.
 *   Called by the episode loader before getDistribution(). The locked belt
 *   is used for all distribution queries during that episode session.
 *
 * BELT COMPARISON:
 *   PostgreSQL text comparison of belt values is alphabetical, not ordinal
 *   ('black_belt' < 'blue_belt' < 'brown_belt' < 'purple_belt' < 'white_belt').
 *   Asset queries use a CASE expression to convert belt strings to ordinal
 *   integers for correct range comparison (white=1 .. black=5).
 *
 * DEPENDENCIES:
 *   - ChaosSeeder (ChaosSeeder.js)
 *   - ChaosSolver (ChaosSolver.js)
 *   - ChaosValidator (ChaosValidator.js)
 *   - generateHexId (backend/utils/hexIdGenerator.js)
 *   - pool (backend/db/pool.js)
 *   - SOLVER_THRESHOLDS (chaosConfig.js)
 *
 * EXPORTS:
 *   ChaosDistributor class (named export)
 *     getDistribution(userId, episodeNumber, beltLevel, purchaseCode?)
 *       → { distributions, quality, generationSeed, attemptCount, frozen? }
 *     recordEpisodeLock(userId, episode, beltLevel)
 *       → void
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Orchestrator
 * ===========================================================================
 */

import { ChaosSeeder } from './ChaosSeeder.js';
import { ChaosSolver } from './ChaosSolver.js';
import { ChaosValidator } from './ChaosValidator.js';
import generateHexId from '../utils/hexIdGenerator.js';
import pool from '../db/pool.js';
import { SOLVER_THRESHOLDS } from './chaosConfig.js';

export class ChaosDistributor {
    constructor() {
        this.validator = new ChaosValidator();
    }

    async getDistribution(userId, episodeNumber, beltLevel, purchaseCode = null) {
        const existing = await this._checkExisting(userId, episodeNumber, beltLevel);
        if (existing) {
            return existing;
        }

        let attempt = 0;
        let result = null;
        let seeder = null;

        while (attempt < SOLVER_THRESHOLDS.MAX_RESEED_ATTEMPTS) {
            const seedModifier = attempt > 0 ? `:${attempt}` : '';
            seeder = new ChaosSeeder(userId + seedModifier, purchaseCode);

            result = await this._generate(userId, episodeNumber, beltLevel, seeder);

            const validation = this.validator.validateDistribution(
                result, episodeNumber, beltLevel
            );

            if (validation.valid || attempt === SOLVER_THRESHOLDS.MAX_RESEED_ATTEMPTS - 1) {
                break;
            }

            attempt++;
        }

        await this._persistDistribution(userId, episodeNumber, beltLevel, seeder, result);

        return {
            distributions: result.distributions,
            quality: result.quality,
            generationSeed: seeder.getBaseSeed(),
            attemptCount: attempt
        };
    }

    async _checkExisting(userId, episode, beltLevel) {
        const query = `
            SELECT d.distribution_id, d.slot_id, d.asset_id, d.episode,
                   d.belt_level_at_generation, d.is_spine, d.generation_seed,
                   a.category, a.tier, a.base_weight, a.tone_tags,
                   a.complexity_rating, a.is_spine AS asset_is_spine
            FROM chaos_user_distributions d
            JOIN chaos_asset_registry a ON d.asset_id = a.asset_id
            WHERE d.user_id = $1 AND d.episode = $2 AND d.belt_level_at_generation = $3
        `;
        const result = await pool.query(query, [userId, episode, beltLevel]);

        if (result.rows.length > 0) {
            return {
                frozen: true,
                distributions: result.rows,
                generationSeed: result.rows[0].generation_seed
            };
        }

        return null;
    }

    async _generate(userId, episodeNumber, beltLevel, seeder) {
        const slotQuery = `
            SELECT * FROM chaos_slot_definitions
            WHERE episode = $1 AND belt_level = $2
            ORDER BY scene_sequence
        `;
        const slotResult = await pool.query(slotQuery, [episodeNumber, beltLevel]);

        // Belt comparison uses CASE for ordinal ordering (not alphabetical)
        const assetQuery = `
            SELECT * FROM chaos_asset_registry
            WHERE (CASE min_belt
                    WHEN 'white_belt' THEN 1 WHEN 'blue_belt' THEN 2
                    WHEN 'purple_belt' THEN 3 WHEN 'brown_belt' THEN 4
                    WHEN 'black_belt' THEN 5 END)
                  <= (CASE $1
                    WHEN 'white_belt' THEN 1 WHEN 'blue_belt' THEN 2
                    WHEN 'purple_belt' THEN 3 WHEN 'brown_belt' THEN 4
                    WHEN 'black_belt' THEN 5 END)
              AND (CASE max_belt
                    WHEN 'white_belt' THEN 1 WHEN 'blue_belt' THEN 2
                    WHEN 'purple_belt' THEN 3 WHEN 'brown_belt' THEN 4
                    WHEN 'black_belt' THEN 5 END)
                  >= (CASE $1
                    WHEN 'white_belt' THEN 1 WHEN 'blue_belt' THEN 2
                    WHEN 'purple_belt' THEN 3 WHEN 'brown_belt' THEN 4
                    WHEN 'black_belt' THEN 5 END)
              AND ($2 = ANY(allowed_episodes) OR allowed_episodes IS NULL)
        `;
        const assetResult = await pool.query(assetQuery, [beltLevel, episodeNumber]);

        const solver = new ChaosSolver(seeder, pool);
        return await solver.solveEpisode(
            userId, episodeNumber, beltLevel,
            assetResult.rows, slotResult.rows
        );
    }

    async _persistDistribution(userId, episode, beltLevel, seeder, result) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            for (const [slotId, asset] of result.distributions) {
                const distId = await generateHexId('chaos_distribution', client);

                await client.query(`
                    INSERT INTO chaos_user_distributions (
                        distribution_id, user_id, slot_id, asset_id, episode,
                        belt_level_at_generation, is_spine, generation_seed, generated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                `, [
                    distId, userId, slotId, asset.asset_id, episode,
                    beltLevel, asset.is_spine, seeder.getBaseSeed()
                ]);
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async recordEpisodeLock(userId, episode, beltLevel) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const lockId = await generateHexId('chaos_ep_lock', client);

            await client.query(`
                INSERT INTO chaos_episode_locks (lock_id, user_id, episode, belt_level)
                VALUES ($1, $2, $3, $4)
            `, [lockId, userId, episode, beltLevel]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
