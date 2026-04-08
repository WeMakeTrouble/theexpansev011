/**
 * =============================================================================
 * SPS SCORER — Structural Parsimony Score Calculator
 * =============================================================================
 *
 * PURPOSE:
 *   Calculates the Structural Parsimony Score (SPS) for hypothesis objects.
 *   Lower SPS = more parsimonious (simpler) explanation.
 *
 * MATHEMATICAL FOUNDATION:
 *   Adapted from Minimum Description Length (Rissanen, 1978) for
 *   deterministic narrative causal chains.
 *
 *   SPS(H,D) = alpha * |C(H)| + beta * |M(H)| + gamma * |A(H)| + delta * (1.0 - fit(H,D))
 *
 *   Where:
 *     |C(H)| = Number of causal links in hypothesis chain
 *     |M(H)| = Number of distinct mechanisms invoked
 *     |A(H)| = Number of assumptions about unobserved states
 *     fit(H,D) = Data fit score (1.0 = perfect, 0.0 = no fit)
 *     alpha, beta, gamma, delta = Weighting coefficients
 *
 * WEIGHT JUSTIFICATION:
 *   alpha = 1.0  — Baseline unit. No direct citation. (1 link = 1.0 complexity)
 *   beta  = 2.0  — Inferred from Naugle et al. (2023): crossing subsystem
 *                   boundaries increases complexity non-linearly.
 *   gamma = 3.0  — Inferred from Kelly (2021): unobserved variables are
 *                   primary source of diagnostic error.
 *   delta = 5.0  — No direct citation. Calibrated: ensures 3-link perfect-fit
 *                   outranks 1-link poor-fit.
 *
 * CITATIONS:
 *   Rissanen, J. (1978). "Modeling by shortest data description."
 *     Automatica, 14(5), 465-471. DOI: 10.1016/0005-1098(78)90005-5
 *
 *   Naugle, A., Verzi, S., Lakkaraju, K., et al. (2023).
 *     "Feedback density and causal complexity of simulation model structure."
 *     Journal of Simulation, 17(3), 229-239.
 *     DOI: 10.1080/17477778.2021.1982653 (online-first 2021, print 2023)
 *
 *   Kelly, J. (2021). "The diagnostic approach in complex patients:
 *     parsimony or plenitude?" The American Journal of Medicine,
 *     134(3), 293-295. DOI: 10.1016/j.amjmed.2020.08.022
 *
 *   Harbecke, J., Grunau, J., & Samanek, P. (2024). "Are the BIC and
 *     AIC applicable in determining optimal fit and simplicity of
 *     mechanistic models?" International Studies in the Philosophy of
 *     Science, 37(1), 1-25. DOI: 10.1080/02698595.2024.2304487
 *
 *   Aberegg, S.K., Poole, B.R., & Locke, B.W. (2024). "Hickam's dictum:
 *     an analysis of multiple diagnoses." Journal of General Internal
 *     Medicine, 39(4), 744-750. DOI: 10.1007/s11606-024-09120-y
 *
 *   Autzen, B. (2022). "Diagnostic Parsimony: Ockham Meets Bayes."
 *     Philosophy of Medicine, 3(1). DOI: 10.5195/pom.2022.123
 *
 * SPEC REFERENCE:
 *   V010_RESEARCH_BRIEF_Ockhams_Razor_Engine.md
 *   Final research review (scored 95/100)
 *
 * DETERMINISTIC:
 *   Same inputs always produce same scores. No randomness. No state.
 *
 * =============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('spsScorer');

// =============================================================================
// DEFAULT WEIGHTS
// =============================================================================

/**
 * Default SPS weighting coefficients.
 * Frozen to prevent accidental mutation.
 * Can be overridden per-call for belt-level tuning.
 */
const DEFAULT_WEIGHTS = Object.freeze({
    alpha: 1.0,
    beta: 2.0,
    gamma: 3.0,
    delta: 5.0
});

// =============================================================================
// DATA FIT CALCULATION
// =============================================================================

/**
 * Calculate how well a hypothesis explains the observed data.
 *
 * Returns a score from 0.0 (no fit) to 1.0 (perfect fit).
 * Deterministic — same inputs always produce same score.
 *
 * Penalties:
 *   - Temporal ordering violation (effect before cause): -0.30
 *     No direct citation. Calibrated: 30% reduction preserves hypothesis
 *     if no alternative exists but penalises causality violation.
 *
 *   - Magnitude mismatch: up to -0.20
 *     No direct citation. Calibrated: 50% magnitude mismatch yields
 *     10% fit reduction, preserving viability for individual variation.
 *
 *   - Direction mismatch (hypothesis predicts wrong PAD direction): -0.50
 *     No direct citation. Calibrated: predicting wrong direction is a
 *     fundamental explanatory failure.
 *
 * @param {Object} hypothesis - Must contain:
 *   @param {Array} hypothesis.causalChain - Array of chain links with optional timestamps
 *   @param {number} [hypothesis.expectedMagnitude] - Predicted change magnitude
 *   @param {string} [hypothesis.expectedDirection] - 'positive' or 'negative'
 * @param {Object} observation - Must contain:
 *   @param {number} observation.timestamp - When the change was observed
 *   @param {number} [observation.magnitude] - Observed change magnitude (absolute)
 *   @param {string} [observation.direction] - 'positive' or 'negative'
 * @returns {number} Fit score between 0.0 and 1.0
 */
function calculateDataFit(hypothesis, observation) {
    if (!hypothesis || !observation) {
        logger.warn('calculateDataFit called with missing input', {
            hasHypothesis: !!hypothesis,
            hasObservation: !!observation
        });
        return 0.0;
    }

    let fitScore = 1.0;

    // --- Temporal ordering penalty ---
    // If any cause in the chain occurred AFTER the observed effect,
    // the causal direction is wrong.
    if (Array.isArray(hypothesis.causalChain)) {
        for (const link of hypothesis.causalChain) {
            if (link.timestamp && observation.timestamp &&
                link.timestamp > observation.timestamp) {
                fitScore -= 0.30;
                break;
            }
        }
    }

    // --- Magnitude mismatch penalty ---
    // If hypothesis predicts a magnitude and observed magnitude exists,
    // penalise proportionally to the mismatch ratio.
    if (typeof hypothesis.expectedMagnitude === 'number' &&
        typeof observation.magnitude === 'number' &&
        hypothesis.expectedMagnitude > 0 &&
        observation.magnitude > 0) {

        const ratio = Math.min(
            hypothesis.expectedMagnitude / observation.magnitude,
            observation.magnitude / hypothesis.expectedMagnitude
        );
        fitScore -= (1.0 - ratio) * 0.20;
    }

    // --- Direction mismatch penalty ---
    // If hypothesis predicts a PAD direction and it contradicts
    // the observed direction, heavy penalty.
    if (hypothesis.expectedDirection && observation.direction &&
        hypothesis.expectedDirection !== observation.direction) {
        fitScore -= 0.50;
    }

    return Math.max(0.0, Math.min(1.0, fitScore));
}

// =============================================================================
// SPS CALCULATION
// =============================================================================

/**
 * Calculate the Structural Parsimony Score for a hypothesis.
 *
 * Lower SPS = more parsimonious (simpler, preferred by Ockham's Razor).
 *
 * @param {Object} hypothesis - Must contain:
 *   @param {Array}  hypothesis.causalChain   - Array of causal links
 *   @param {Array}  hypothesis.mechanisms    - Array of mechanism strings
 *   @param {Array}  hypothesis.assumptions   - Array of assumption descriptions
 *   @param {number} [hypothesis.expectedMagnitude] - For fit calculation
 *   @param {string} [hypothesis.expectedDirection] - For fit calculation
 * @param {Object} observation - Must contain:
 *   @param {number} observation.timestamp - When the change was observed
 *   @param {number} [observation.magnitude] - Observed change magnitude
 *   @param {string} [observation.direction] - 'positive' or 'negative'
 * @param {Object} [weights=DEFAULT_WEIGHTS] - Optional weight overrides
 * @returns {Object} { spsScore, components, fit }
 */
function calculateSPS(hypothesis, observation, weights = DEFAULT_WEIGHTS) {
    if (!hypothesis) {
        logger.warn('calculateSPS called with null hypothesis');
        return { spsScore: Infinity, components: null, fit: 0.0 };
    }

    const w = { ...DEFAULT_WEIGHTS, ...weights };

    const linkCount = Array.isArray(hypothesis.causalChain)
        ? hypothesis.causalChain.length
        : 0;

    const uniqueMechanisms = Array.isArray(hypothesis.mechanisms)
        ? new Set(hypothesis.mechanisms).size
        : 0;

    const assumptionCount = Array.isArray(hypothesis.assumptions)
        ? hypothesis.assumptions.length
        : 0;

    const fit = calculateDataFit(hypothesis, observation);
    const fitPenalty = 1.0 - fit;

    const linkComponent = w.alpha * linkCount;
    const mechComponent = w.beta * uniqueMechanisms;
    const assumeComponent = w.gamma * assumptionCount;
    const fitComponent = w.delta * fitPenalty;

    const spsScore = linkComponent + mechComponent + assumeComponent + fitComponent;

    return {
        spsScore: Math.round(spsScore * 100) / 100,
        components: {
            links: { count: linkCount, weighted: Math.round(linkComponent * 100) / 100 },
            mechanisms: { count: uniqueMechanisms, weighted: Math.round(mechComponent * 100) / 100 },
            assumptions: { count: assumptionCount, weighted: Math.round(assumeComponent * 100) / 100 },
            fit: { score: Math.round(fit * 100) / 100, penalty: Math.round(fitComponent * 100) / 100 }
        },
        fit: Math.round(fit * 100) / 100
    };
}

// =============================================================================
// COMPOUND SPS CALCULATION
// =============================================================================

/**
 * Calculate SPS for a compound hypothesis (two simple hypotheses combined).
 *
 * Per research specification:
 *   Compound SPS = SPS(constituent A) + SPS(constituent B) + crossingPenalty
 *
 * @param {Object} hypothesisA - First constituent hypothesis
 * @param {Object} hypothesisB - Second constituent hypothesis
 * @param {Object} observation - The observed state change
 * @param {number} [crossingPenalty=1.0] - Penalty for combining mechanisms
 * @param {Object} [weights=DEFAULT_WEIGHTS] - Optional weight overrides
 * @returns {Object} { spsScore, components, fit, constituents }
 */
function calculateCompoundSPS(hypothesisA, hypothesisB, observation, crossingPenalty = 1.0, weights = DEFAULT_WEIGHTS) {
    const resultA = calculateSPS(hypothesisA, observation, weights);
    const resultB = calculateSPS(hypothesisB, observation, weights);

    const compoundScore = resultA.spsScore + resultB.spsScore + crossingPenalty;

    const combinedFit = Math.max(resultA.fit, resultB.fit);

    return {
        spsScore: Math.round(compoundScore * 100) / 100,
        components: {
            constituentA: resultA.components,
            constituentB: resultB.components,
            crossingPenalty: crossingPenalty
        },
        fit: combinedFit,
        constituents: [resultA, resultB]
    };
}

// =============================================================================
// HYPOTHESIS RANKING
// =============================================================================

/**
 * Rank an array of scored hypotheses by SPS (ascending — lowest is best).
 * Ties broken by fit score (descending — higher fit preferred).
 *
 * @param {Array<Object>} scoredHypotheses - Array of { hypothesis, spsScore, fit }
 * @returns {Array<Object>} Sorted array (best first)
 */
function rankBySPS(scoredHypotheses) {
    if (!Array.isArray(scoredHypotheses)) {
        logger.warn('rankBySPS called with non-array input');
        return [];
    }

    return [...scoredHypotheses].sort((a, b) => {
        if (a.spsScore !== b.spsScore) {
            return a.spsScore - b.spsScore;
        }
        return (b.fit || 0) - (a.fit || 0);
    });
}

// =============================================================================
// ANOMALY DETECTION
// =============================================================================

/**
 * Detect when the Razor's top hypothesis may be unreliable.
 *
 * Anomaly conditions (from research specification):
 *   - Top hypothesis has poor data fit (< 70%)
 *   - Top two hypotheses have close SPS (difference < 1.0)
 *   - Top hypothesis requires unobserved assumptions
 *   - Top hypothesis is already complex (3+ mechanisms)
 *
 * An anomaly is flagged when 2 or more conditions are met.
 *
 * @param {Array<Object>} rankedHypotheses - Output of rankBySPS
 * @returns {Object} { isAnomaly, conditions, conditionCount, recommendation }
 */
function detectAnomaly(rankedHypotheses) {
    if (!Array.isArray(rankedHypotheses) || rankedHypotheses.length === 0) {
        return {
            isAnomaly: false,
            conditions: {},
            conditionCount: 0,
            recommendation: 'No hypotheses to evaluate.'
        };
    }

    const top = rankedHypotheses[0];
    const runnerUp = rankedHypotheses.length > 1 ? rankedHypotheses[1] : null;

    const conditions = {
        poorFit: (top.fit || 0) < 0.70,
        closeRace: runnerUp !== null && (runnerUp.spsScore - top.spsScore) < 1.0,
        hasAssumptions: top.components &&
            top.components.assumptions &&
            top.components.assumptions.count > 0,
        highComplexity: top.components &&
            top.components.mechanisms &&
            top.components.mechanisms.count >= 3
    };

    const conditionCount = Object.values(conditions).filter(Boolean).length;
    const isAnomaly = conditionCount >= 2;

    let recommendation;
    if (!isAnomaly) {
        recommendation = 'Razor is confident. Top hypothesis is well-supported.';
    } else if (conditions.poorFit) {
        recommendation = 'The simplest explanation does not fit well. Consider deeper investigation.';
    } else if (conditions.closeRace) {
        recommendation = 'Multiple plausible explanations. Information asymmetry likely.';
    } else {
        recommendation = 'Hypothesis requires complex causal chain. Verify assumptions.';
    }

    return { isAnomaly, conditions, conditionCount, recommendation };
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
    calculateSPS,
    calculateDataFit,
    calculateCompoundSPS,
    rankBySPS,
    detectAnomaly,
    DEFAULT_WEIGHTS
};

export default calculateSPS;
