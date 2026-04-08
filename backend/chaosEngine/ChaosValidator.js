/**
 * ===========================================================================
 * ChaosValidator.js — Quality Assurance and Bad Seed Detection
 * ===========================================================================
 *
 * PURPOSE:
 * Validates the output of ChaosSolver.solveEpisode() against quality
 * thresholds and determines whether a distribution should be accepted,
 * re-seeded, or flagged for admin review.
 *
 * This module is the gatekeeper between the solver and the distributor.
 * The solver produces a distribution. The validator decides if it's good
 * enough. The distributor writes it to the database or retries.
 *
 * VALIDATION CHECKS:
 *   1. Density minimum — asset count >= MIN_ASSETS_PER_EPISODE
 *   2. Quality score — solver quality >= QUALITY_MINIMUM threshold
 *   3. Empty slot ratio — unfilled slots <= 30% of total
 *
 * RE-SEED LOGIC:
 *   If validation fails, shouldReseed() returns true (up to
 *   MAX_RESEED_ATTEMPTS). The distributor increments the base seed
 *   by 1 and retries. After max attempts, accepts best effort and
 *   logs a warning. Never blocks user onboarding.
 *
 * QUALITY SCORE:
 *   The quality score is computed by ChaosSolver._calculateQuality():
 *     0.4 * fill_rate + 0.3 * spine_coverage + 0.2 * tier_variety
 *     + 0.1 * capstone_presence
 *   All weights and thresholds are proposed — requires calibration.
 *
 * BAD SEED DETECTION:
 *   A "bad seed" is any distribution that fails validation after all
 *   re-seed attempts. These are logged to chaos_generation_errors for
 *   admin review. Bad seeds indicate insufficient asset variety for
 *   the constraint set — an authoring problem, not an engine problem.
 *
 * DEPENDENCIES:
 *   - SOLVER_THRESHOLDS (chaosConfig.js)
 *
 * EXPORTS:
 *   ChaosValidator class (named export)
 *     validateDistribution(result, episodeNumber, beltLevel)
 *       → { valid: boolean, issues: string[], score: number }
 *     shouldReseed(validationResult, attemptCount)
 *       → boolean
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Quality Assurance
 * ===========================================================================
 */

import { SOLVER_THRESHOLDS } from './chaosConfig.js';

export class ChaosValidator {
    validateDistribution(result, episodeNumber, beltLevel) {
        const issues = [];

        if (result.usedCount < SOLVER_THRESHOLDS.MIN_ASSETS_PER_EPISODE) {
            issues.push(`Density below minimum: ${result.usedCount} assets`);
        }

        if (result.quality < SOLVER_THRESHOLDS.QUALITY_MINIMUM) {
            issues.push(`Quality score below threshold: ${result.quality.toFixed(3)}`);
        }

        const emptyRatio = result.emptySlots / (result.distributions.size + result.emptySlots);
        if (emptyRatio > 0.3) {
            issues.push(`High empty slot ratio: ${(emptyRatio * 100).toFixed(1)}%`);
        }

        return {
            valid: issues.length === 0,
            issues,
            score: result.quality
        };
    }

    shouldReseed(validationResult, attemptCount) {
        if (attemptCount >= SOLVER_THRESHOLDS.MAX_RESEED_ATTEMPTS) {
            return false;
        }
        return !validationResult.valid;
    }
}
