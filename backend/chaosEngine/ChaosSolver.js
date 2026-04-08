/**
 * ===========================================================================
 * ChaosSolver.js — Five-Phase Constraint Solver for the Chaos Engine
 * ===========================================================================
 *
 * PURPOSE:
 * Assigns discoverable assets to authored slots for a given user, episode,
 * and belt level. The solver is deterministic — same inputs always produce
 * the same distribution. It is the mechanical core of the Chaos Engine:
 * the thing that makes each user's multiverse unique while maintaining
 * narrative coherence.
 *
 * FIVE-PHASE ALGORITHM:
 *
 *   Phase 1 — SPINE PLACEMENT (Mandatory Slots)
 *     Filter all mandatory slots for the current episode.
 *     Sort by scene_sequence for deterministic ordering.
 *     Assign the first compatible Spine asset to each.
 *     If a mandatory slot cannot be filled: CRITICAL ERROR.
 *     This is an authoring problem, not a runtime problem.
 *
 *   Phase 2 — DEPENDENCY CHAIN RESOLUTION
 *     For assets with prerequisite_asset_ids: verify all prerequisites
 *     are already placed (in earlier episodes or earlier slots).
 *     If prerequisites are satisfied, asset becomes eligible.
 *     If prerequisites are missing: skip the payoff asset.
 *     NOTE: Cross-episode dependency resolution is not yet implemented.
 *     Current logic handles intra-episode prereqs only.
 *
 *   Phase 3 — RIBS PLACEMENT (Weighted Shuffle)
 *     For each remaining unfilled slot:
 *       - Filter compatible assets (category, belt, episode, tone, conflicts)
 *       - Apply Shichifukujin multiplicative weighting via god multipliers
 *       - Select via cumulative weighted random using slot-specific PRNG
 *       - Remove selected asset from candidate pool (no duplicates)
 *
 *   Phase 4 — PROGRESSIVE RELAXATION (Inline with Phase 3)
 *     When no compatible asset exists for a slot:
 *       Step 1: Try fallback categories (slot-defined)
 *       Step 2: Allow any non-capstone asset
 *     NOTE: The build spec defines five relaxation steps (tone → complexity
 *     → category → episode window → belt max). Current implementation uses
 *     two steps. Remaining three are deferred to v2.
 *
 *   Phase 5 — QUALITY CHECK
 *     Compute quality score from: fill rate (0.4), Spine coverage (0.3),
 *     tier variety (0.2), capstone presence (0.1).
 *     Returns score with distribution. Re-seed logic lives in
 *     ChaosDistributor.js, not here.
 *
 * WEIGHTED SELECTION (Shichifukujin):
 *   effective_weight = asset.base_weight * god_multiplier[category]
 *   Unlisted categories default to 1.0 (no bias).
 *   Selection uses cumulative weight distribution with PRNG float.
 *   Each slot gets its own PRNG instance — no shared state.
 *
 * MUTUAL EXCLUSIVITY:
 *   Assets with conflicts_with_assets arrays are checked during filtering.
 *   If any conflicting asset is already placed, the candidate is rejected.
 *   Performance: O(1) per check via Set.has(). Negligible cost.
 *
 * KNOWN LIMITATIONS (v1):
 *   - Cross-episode dependency resolution not implemented
 *   - Relaxation uses 2 of 5 specified steps
 *   - _filterCompatible has redundant fallback category check (lines 104-106)
 *   - _logEmptySlot uses console.warn instead of createModuleLogger
 *   - Quality score formula weights are proposed — requires calibration
 *
 * PERFORMANCE TARGET: Under 100ms per episode on MacBook Air M4 16GB.
 *
 * DEPENDENCIES:
 *   - GOD_MULTIPLIERS, EPISODE_GODS, SOLVER_THRESHOLDS (chaosConfig.js)
 *   - ChaosSeeder instance (passed via constructor)
 *   - Database pool (passed via constructor, used for error logging)
 *
 * EXPORTS:
 *   ChaosSolver class (named export)
 *     constructor(seeder, dbPool)
 *     solveEpisode(userId, episodeNumber, beltLevel, assetPool, slotPool)
 *       → { distributions: Map, quality: number, usedCount, emptySlots }
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Constraint Solver
 * ===========================================================================
 */

import { GOD_MULTIPLIERS, EPISODE_GODS, SOLVER_THRESHOLDS, TIERS } from './chaosConfig.js';

export class ChaosSolver {
    constructor(seeder, dbPool) {
        this.seeder = seeder;
        this.db = dbPool;
    }

    async solveEpisode(userId, episodeNumber, beltLevel, assetPool, slotPool) {
        const distributions = new Map();
        const usedAssets = new Set();
        const god = EPISODE_GODS[episodeNumber];

        // Phase 1: Spine Placement (Mandatory)
        const spineSlots = slotPool.filter(s => s.is_mandatory);
        for (const slot of spineSlots.sort((a,b) => a.scene_sequence - b.scene_sequence)) {
            const compatible = this._filterCompatible(
                assetPool, slot, usedAssets, distributions, true
            );

            if (compatible.length === 0) {
                throw new Error(`CRITICAL: Unsatisfiable mandatory slot ${slot.slot_id} in episode ${episodeNumber}`);
            }

            const asset = compatible[0];
            distributions.set(slot.slot_id, asset);
            usedAssets.add(asset.asset_id);
        }

        // Phase 2: Dependency Resolution
        const depSlots = slotPool.filter(s => !s.is_mandatory && s.belt_level === beltLevel);
        for (const slot of depSlots) {
            const candidates = assetPool.filter(a =>
                !usedAssets.has(a.asset_id) &&
                this._slotAcceptsAsset(slot, a) &&
                a.prerequisite_asset_ids?.length > 0
            );

            for (const asset of candidates) {
                const prereqs = asset.prerequisite_asset_ids || [];
                const hasPrereqs = prereqs.every(pid => usedAssets.has(pid));

                if (hasPrereqs) {
                    const compatible = this._filterCompatible(
                        assetPool, slot, usedAssets, distributions, false
                    );
                    if (compatible.length > 0) {
                        const rng = this.seeder.getSlotRng(episodeNumber, beltLevel, slot.scene_sequence);
                        const selected = this._weightedSelect(compatible, rng, god);
                        distributions.set(slot.slot_id, selected);
                        usedAssets.add(selected.asset_id);
                        break;
                    }
                }
            }
        }

        // Phase 3: Ribs Placement (Weighted Shuffle)
        const remainingSlots = slotPool.filter(s =>
            s.belt_level === beltLevel && !distributions.has(s.slot_id)
        );

        for (const slot of remainingSlots) {
            let compatible = this._filterCompatible(assetPool, slot, usedAssets, distributions, false);

            // Phase 4: Progressive Relaxation if empty
            if (compatible.length === 0) {
                compatible = this._relaxConstraints(assetPool, slot, usedAssets);
            }

            if (compatible.length > 0) {
                const rng = this.seeder.getSlotRng(episodeNumber, beltLevel, slot.scene_sequence);
                const asset = this._weightedSelect(compatible, rng, god);
                distributions.set(slot.slot_id, asset);
                usedAssets.add(asset.asset_id);
            } else {
                await this._logEmptySlot(userId, episodeNumber, slot);
            }
        }

        // Phase 5: Quality Check
        const quality = this._calculateQuality(distributions, slotPool.length);
        return {
            distributions,
            quality,
            usedCount: usedAssets.size,
            emptySlots: remainingSlots.length - (distributions.size - spineSlots.length)
        };
    }

    _filterCompatible(pool, slot, used, distributions, spineOnly) {
        return pool.filter(asset => {
            if (used.has(asset.asset_id)) return false;
            if (spineOnly && !asset.is_spine) return false;

            if (!slot.allowed_categories.includes(asset.category)) return false;
            if (slot.fallback_categories && !slot.allowed_categories.includes(asset.category) &&
                !slot.fallback_categories.includes(asset.category)) return false;

            if (asset.allowed_episodes && !asset.allowed_episodes.includes(slot.episode)) return false;

            if (asset.conflicts_with_assets?.length > 0) {
                const hasConflict = asset.conflicts_with_assets.some(cid => used.has(cid));
                if (hasConflict) return false;
            }

            if (slot.tone_tags?.length > 0 && asset.tone_tags?.length > 0) {
                const toneMatch = slot.tone_tags.some(t => asset.tone_tags.includes(t));
                if (!toneMatch) return false;
            }

            return true;
        });
    }

    _slotAcceptsAsset(slot, asset) {
        if (!slot.allowed_categories.includes(asset.category)) return false;
        if (asset.excluded_episodes?.includes(slot.episode)) return false;
        return true;
    }

    _relaxConstraints(pool, slot, used) {
        let relaxed = pool.filter(a => {
            if (used.has(a.asset_id)) return false;
            return slot.allowed_categories.includes(a.category) ||
                   slot.fallback_categories?.includes(a.category);
        });

        if (relaxed.length === 0) {
            relaxed = pool.filter(a => {
                if (used.has(a.asset_id)) return false;
                return a.tier !== 'capstone';
            });
        }

        return relaxed;
    }

    _weightedSelect(assets, rng, god) {
        const multipliers = GOD_MULTIPLIERS[god] || {};

        const weights = assets.map(a => {
            const mult = multipliers[a.category] || 1.0;
            return a.base_weight * mult;
        });

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let target = rng() * totalWeight;

        for (let i = 0; i < assets.length; i++) {
            target -= weights[i];
            if (target <= 0) return assets[i];
        }

        return assets[assets.length - 1];
    }

    _calculateQuality(distributions, totalSlots) {
        const items = Array.from(distributions.values());
        const fillRate = items.length / totalSlots;

        const tierCounts = { texture: 0, beat: 0, capstone: 0 };
        items.forEach(a => tierCounts[a.tier]++);

        const total = items.length || 1;
        const spineCount = items.filter(a => a.is_spine).length;

        const fillScore = fillRate * 0.4;
        const spineScore = (spineCount / total) * 0.3;
        const varietyScore = (tierCounts.beat / total) * 0.2;
        const tier3Score = (tierCounts.capstone > 0 ? 0.1 : 0);

        return fillScore + spineScore + varietyScore + tier3Score;
    }

    async _logEmptySlot(userId, episode, slot) {
        console.warn(`Empty slot: ${slot.slot_id} in episode ${episode} for user ${userId}`);
    }
}
