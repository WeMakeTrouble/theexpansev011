/**
 * =============================================================================
 * OCKHAM'S RAZOR ENGINE — Deterministic Parsimony Instrument
 * =============================================================================
 *
 * PURPOSE:
 *   Evaluates competing explanations for observed character state changes
 *   using Structural Parsimony Scoring (SPS). The simplest hypothesis that
 *   adequately explains the data wins — unless the data says otherwise.
 *
 * PHILOSOPHY:
 *   Fills the gap between WHAT is happening (Psychic Radar) and WHY
 *   characters persist (Ikigai Engine) by evaluating COMPETING EXPLANATIONS
 *   for observed changes. User-as-observer metaphor: Scully evaluating
 *   theories about evidence.
 *
 * ARCHITECTURE:
 *   1. Context Gathering   — Reads production tables (contextGatherer.js)
 *   2. Hypothesis Generation — Matches templates to available data
 *   3. SPS Scoring          — Calculates parsimony per hypothesis (spsScorer.js)
 *   4. Ranking              — Lowest SPS wins, ties broken by fit
 *   5. Compound Generation  — Pairs hypotheses when top fit < 70%
 *   6. Anomaly Detection    — Flags unreliable top hypotheses
 *   7. Evaluation Logging   — Writes to razor_evaluations table
 *
 * CROSS-LAYER ARBITRATION:
 *   L1 (Current)   — Hypotheses from current observation data
 *   L2 (Historical) — Hypotheses from trajectory/trend data
 *   Consistency: Same PAD direction = CONSISTENT
 *   Disagreement: L2 overrides L1 (established patterns more reliable)
 *   Confidence: min(L1 fit, L2 fit) — conservative conjunction
 *
 * CITATIONS:
 *   Rissanen, J. (1978). "Modeling by shortest data description."
 *     Automatica, 14(5), 465-471. DOI: 10.1016/0005-1098(78)90005-5
 *
 *   Naugle, A., Verzi, S., Lakkaraju, K., et al. (2023).
 *     "Feedback density and causal complexity of simulation model structure."
 *     Journal of Simulation, 17(3), 229-239.
 *     DOI: 10.1080/17477778.2021.1982653
 *
 *   Kelly, J. (2021). "The diagnostic approach in complex patients:
 *     parsimony or plenitude?" The American Journal of Medicine,
 *     134(3), 293-295. DOI: 10.1016/j.amjmed.2020.08.022
 *
 *   Aberegg, S.K., Poole, B.R., & Locke, B.W. (2024). "Hickam's dictum:
 *     an analysis of multiple diagnoses." Journal of General Internal
 *     Medicine, 39(4), 744-750. DOI: 10.1007/s11606-024-09120-y
 *
 * SPEC REFERENCE:
 *   V010_RESEARCH_BRIEF_Ockhams_Razor_Engine.md
 *   Final corrections documented in project knowledge base
 *
 * DETERMINISTIC:
 *   Same inputs always produce same evaluation. No randomness. No ML.
 *   No external AI APIs.
 *
 * =============================================================================
 */

import pool from '../../db/pool.js';
import { createModuleLogger } from '../../utils/logger.js';
import { isValidHexId } from '../../utils/hexIdGenerator.js';
import generateHexId from '../../utils/hexIdGenerator.js';
import { getActiveTemplates, getCompoundConfig } from './hypothesisTemplates.js';
import { calculateSPS, calculateCompoundSPS, rankBySPS, detectAnomaly } from './spsScorer.js';
import gatherCharacterContext from './contextGatherer.js';

const logger = createModuleLogger('OckhamsRazorEngine');

// =============================================================================
// HYPOTHESIS GENERATION — Match templates to available context
// =============================================================================

/**
 * Generate hypotheses by matching active templates against gathered context.
 * Only generates hypotheses where sufficient data exists.
 *
 * @param {Object} context - Output of gatherCharacterContext
 * @param {Object} observation - The observed state change to explain
 *   @param {string} observation.characterId - Who changed
 *   @param {string} observation.dimension - 'PLEASURE', 'AROUSAL', or 'DOMINANCE'
 *   @param {number} observation.oldValue - Previous PAD value
 *   @param {number} observation.newValue - New PAD value
 *   @param {number} observation.timestamp - When the change was observed
 * @returns {Array<Object>} Array of hypothesis objects ready for SPS scoring
 */
function generateHypotheses(context, observation) {
    if (!context || !observation) {
        logger.warn('generateHypotheses called with missing input');
        return [];
    }

    const templates = getActiveTemplates();
    const hypotheses = [];
    const magnitude = Math.abs(observation.newValue - observation.oldValue);
    const direction = observation.newValue > observation.oldValue ? 'positive' : 'negative';

    for (const template of templates) {
        if (template.status === 'dynamic') {
            continue;
        }

        const hypothesis = _instantiateTemplate(template, context, observation, magnitude, direction);
        if (hypothesis) {
            hypotheses.push(hypothesis);
        }
    }

    logger.debug('Hypotheses generated', {
        characterId: observation.characterId,
        templateCount: templates.length,
        hypothesisCount: hypotheses.length
    });

    return hypotheses;
}

/**
 * Attempt to instantiate a single template against available context.
 * Returns null if insufficient data exists for this template.
 *
 * @param {Object} template - Template definition from hypothesisTemplates
 * @param {Object} context - Gathered character context
 * @param {Object} observation - The observed change
 * @param {number} magnitude - Absolute magnitude of observed change
 * @param {string} direction - 'positive' or 'negative'
 * @returns {Object|null} Hypothesis object or null
 */
function _instantiateTemplate(template, context, observation, magnitude, direction) {
    switch (template.id) {

        case 'PAD_DIRECT':
            return _generatePadDirect(template, context, observation, magnitude, direction);

        case 'PROX_CONTAGION':
            return _generateProxContagion(template, context, observation, magnitude, direction);

        case 'TRANSITIVE_CONTAGION':
            return _generateTransitiveContagion(template, context, observation, magnitude, direction);

        case 'IKIGAI_DRAIN':
            return _generateIkigaiDrain(template, context, observation, magnitude, direction);

        case 'IKIGAI_DIVERSITY_COLLAPSE':
            return _generateIkigaiDiversityCollapse(template, context, observation, magnitude, direction);

        case 'MOAI_WEAKEN':
            return _generateMoaiWeaken(template, context, observation, magnitude, direction);

        case 'OCEAN_FACET_VULN':
            return _generateOceanFacetVuln(template, context, observation, magnitude, direction);

        case 'PAD_DECAY_BASELINE':
            return _generatePadDecayBaseline(template, context, observation, magnitude, direction);

        default:
            logger.debug('No generator for template', { templateId: template.id });
            return null;
    }
}

// =============================================================================
// TEMPLATE GENERATORS — One per active template
// =============================================================================

/**
 * PAD_DIRECT: A narrative beat directly assigned a PAD value.
 */
function _generatePadDirect(template, context, observation, magnitude, direction) {
    if (!context.availability.hasRecentBeats) return null;

    const dimensionKey = observation.dimension === 'PLEASURE' ? 'p'
        : observation.dimension === 'AROUSAL' ? 'a' : 'd';

    for (const beat of context.recentBeats) {
        if (!beat.targetPad || typeof beat.targetPad[dimensionKey] === 'undefined') continue;

        const targetValue = parseFloat(beat.targetPad[dimensionKey]);
        const expectedMagnitude = Math.abs(targetValue - observation.oldValue);
        const expectedDirection = targetValue > observation.oldValue ? 'positive' : 'negative';

        return {
            templateId: template.id,
            description: template.description
                .replace('[CHARACTER]', observation.characterId)
                .replace('[BEAT]', beat.beatTitle || beat.beatId)
                .replace('[DIMENSION]', observation.dimension)
                .replace('[VALUE]', String(targetValue)),
            causalChain: [{ source: beat.beatId, timestamp: beat.playedAt }],
            mechanisms: [...template.mechanisms],
            assumptions: [],
            expectedMagnitude,
            expectedDirection,
            layer: 'L1',
            evidence: { beat }
        };
    }

    return null;
}

/**
 * PROX_CONTAGION: Nearby character's PAD influenced this character.
 */
function _generateProxContagion(template, context, observation, magnitude, direction) {
    if (!context.availability.hasProximity || !context.availability.hasPadHistory) return null;

    const allRelationships = [...context.proximity.inbound, ...context.proximity.outbound];
    if (allRelationships.length === 0) return null;

    const closest = allRelationships[0];
    const otherCharId = closest.fromCharacter === observation.characterId
        ? closest.toCharacter : closest.fromCharacter;

    const resonanceFactor = closest.emotionalResonance || 0;
    const distanceFactor = 1.0 - Math.min(closest.currentDistance / 100, 1.0);
    const expectedMagnitude = magnitude * distanceFactor * (resonanceFactor > 0 ? resonanceFactor : 0.5);

    return {
        templateId: template.id,
        description: template.description
            .replace('[CHARACTER_A]', observation.characterId)
            .replace('[CHARACTER_B]', otherCharId)
            .replace('[DIMENSION]', observation.dimension),
        causalChain: [{ source: otherCharId, timestamp: closest.lastInteraction }],
        mechanisms: [...template.mechanisms],
        assumptions: [],
        expectedMagnitude,
        expectedDirection: direction,
        layer: 'L1',
        evidence: { proximity: closest }
    };
}

/**
 * TRANSITIVE_CONTAGION: Chain contagion through two proximity links.
 */
function _generateTransitiveContagion(template, context, observation, magnitude, direction) {
    if (!context.availability.hasProximity) return null;

    const allRelationships = [...context.proximity.inbound, ...context.proximity.outbound];
    if (allRelationships.length < 2) return null;

    const link1 = allRelationships[0];
    const link2 = allRelationships[1];

    const midCharId = link1.fromCharacter === observation.characterId
        ? link1.toCharacter : link1.fromCharacter;
    const sourceCharId = link2.fromCharacter === observation.characterId
        ? link2.toCharacter : link2.fromCharacter;

    if (midCharId === sourceCharId) return null;

    return {
        templateId: template.id,
        description: template.description
            .replace('[CHAR_A]', sourceCharId)
            .replace('[CHAR_B]', midCharId)
            .replace('[CHAR_C]', observation.characterId)
            .replace('[DIMENSION]', observation.dimension),
        causalChain: [
            { source: sourceCharId, timestamp: link2.lastInteraction },
            { source: midCharId, timestamp: link1.lastInteraction }
        ],
        mechanisms: [...template.mechanisms],
        assumptions: [],
        expectedMagnitude: magnitude * 0.5,
        expectedDirection: direction,
        layer: 'L1',
        evidence: { link1, link2 }
    };
}

/**
 * IKIGAI_DRAIN: A specific ikigai need dropped, reducing resilience.
 */
function _generateIkigaiDrain(template, context, observation, magnitude, direction) {
    if (!context.availability.hasIkigaiNeeds) return null;
    if (direction !== 'negative') return null;

    const lowestNeed = context.ikigaiNeeds.reduce((min, need) =>
        need.fulfillmentScore < min.fulfillmentScore ? need : min,
        context.ikigaiNeeds[0]
    );

    if (!lowestNeed || lowestNeed.fulfillmentScore > 0.5) return null;

    return {
        templateId: template.id,
        description: template.description
            .replace('[CHARACTER]', observation.characterId)
            .replace('[NEED]', lowestNeed.needCode)
            .replace('[DIMENSION]', observation.dimension),
        causalChain: [
            { source: 'ikigai_' + lowestNeed.needCode, timestamp: lowestNeed.lastUpdated },
            { source: 'resilience_model' },
            { source: 'pad_vulnerability' }
        ],
        mechanisms: [...template.mechanisms],
        assumptions: [],
        expectedMagnitude: magnitude,
        expectedDirection: 'negative',
        layer: 'L1',
        evidence: { lowestNeed }
    };
}

/**
 * IKIGAI_DIVERSITY_COLLAPSE: Need fulfillment too concentrated (high HHI).
 */
function _generateIkigaiDiversityCollapse(template, context, observation, magnitude, direction) {
    if (!context.availability.hasIkigaiNeeds) return null;
    if (context.ikigaiNeeds.length < 2) return null;

    const totalScore = context.ikigaiNeeds.reduce((sum, n) => sum + n.fulfillmentScore, 0);
    if (totalScore === 0) return null;

    const hhi = context.ikigaiNeeds.reduce((sum, n) => {
        const share = n.fulfillmentScore / totalScore;
        return sum + (share * share);
    }, 0);

    if (hhi < 0.5) return null;

    return {
        templateId: template.id,
        description: template.description
            .replace('[CHARACTER]', observation.characterId),
        causalChain: [
            { source: 'ikigai_diversity' },
            { source: 'hhi_model' },
            { source: 'pad_instability' }
        ],
        mechanisms: [...template.mechanisms],
        assumptions: [],
        expectedMagnitude: magnitude,
        expectedDirection: direction,
        layer: 'L1',
        evidence: { hhi: Math.round(hhi * 1000) / 1000, needCount: context.ikigaiNeeds.length }
    };
}

/**
 * MOAI_WEAKEN: Bond with another character weakened.
 */
function _generateMoaiWeaken(template, context, observation, magnitude, direction) {
    if (!context.availability.hasProximity || !context.availability.hasIkigaiNeeds) return null;
    if (direction !== 'negative') return null;

    const allRelationships = [...context.proximity.inbound, ...context.proximity.outbound];
    const weakenedBond = allRelationships.find(r =>
        r.currentDistance > r.baselineDistance * 1.2
    );

    if (!weakenedBond) return null;

    const connectionNeed = context.ikigaiNeeds.find(n => n.needCode === 'CONNECTION');

    const otherCharId = weakenedBond.fromCharacter === observation.characterId
        ? weakenedBond.toCharacter : weakenedBond.fromCharacter;

    return {
        templateId: template.id,
        description: template.description
            .replace('[CHARACTER]', observation.characterId)
            .replace('[CHARACTER_B]', otherCharId),
        causalChain: [
            { source: otherCharId, timestamp: weakenedBond.lastInteraction },
            { source: 'ikigai_connection' },
            { source: 'resilience_model' }
        ],
        mechanisms: [...template.mechanisms],
        assumptions: [],
        expectedMagnitude: magnitude,
        expectedDirection: 'negative',
        layer: 'L1',
        evidence: { weakenedBond, connectionNeed }
    };
}

/**
 * OCEAN_FACET_VULN: Character facet makes them vulnerable to this event type.
 */
function _generateOceanFacetVuln(template, context, observation, magnitude, direction) {
    if (!context.availability.hasOceanFacets || !context.availability.hasRecentBeats) return null;

    const neuroticism = context.oceanFacets.find(f => f.domain === 'NEUROTICISM');
    if (!neuroticism || neuroticism.score < 0.6) return null;

    const recentBeat = context.recentBeats[0];
    if (!recentBeat) return null;

    return {
        templateId: template.id,
        description: template.description
            .replace('[EVENT]', recentBeat.beatTitle || recentBeat.beatId)
            .replace('[CHARACTER]', observation.characterId)
            .replace('[FACET]', neuroticism.facetCode),
        causalChain: [
            { source: recentBeat.beatId, timestamp: recentBeat.playedAt },
            { source: 'facet_' + neuroticism.facetCode }
        ],
        mechanisms: [...template.mechanisms],
        assumptions: ['facet sensitivity threshold assumed from OCEAN score'],
        expectedMagnitude: magnitude * neuroticism.score,
        expectedDirection: direction,
        layer: 'L1',
        evidence: { facet: neuroticism, beat: recentBeat }
    };
}

/**
 * PAD_DECAY_BASELINE: PAD drifting back toward archetype default.
 */
function _generatePadDecayBaseline(template, context, observation, magnitude, direction) {
    if (!context.availability.hasPadBaseline || !context.availability.hasPadHistory) return null;

    const baseline = context.padBaseline;
    const dimensionKey = observation.dimension === 'PLEASURE' ? 'p'
        : observation.dimension === 'AROUSAL' ? 'a' : 'd';

    const baselineValue = baseline[dimensionKey];
    const movingTowardBaseline =
        (observation.oldValue > baselineValue && observation.newValue < observation.oldValue) ||
        (observation.oldValue < baselineValue && observation.newValue > observation.oldValue);

    if (!movingTowardBaseline) return null;

    return {
        templateId: template.id,
        description: template.description
            .replace('[CHARACTER]', observation.characterId)
            .replace('[DIMENSION]', observation.dimension),
        causalChain: [
            { source: 'ocean_baseline' },
            { source: 'pad_decay' }
        ],
        mechanisms: [...template.mechanisms],
        assumptions: [],
        expectedMagnitude: Math.abs(baselineValue - observation.oldValue) * 0.1,
        expectedDirection: baselineValue > observation.oldValue ? 'positive' : 'negative',
        layer: 'L2',
        evidence: { baselineValue, currentValue: observation.oldValue, targetValue: baselineValue }
    };
}

// =============================================================================
// COMPOUND HYPOTHESIS GENERATION
// =============================================================================

/**
 * Generate compound hypotheses when the top simple hypothesis has poor fit.
 *
 * Compound generation constraints:
 *   - Only when top simple hypothesis fit < 70%
 *   - Only pairs mechanisms with > 50% individual fit
 *   - Maximum 6 compound hypotheses per evaluation
 *   - SPS = sum of constituent SPS values + crossing penalty
 *
 * @param {Array} scoredHypotheses - Already scored and ranked simple hypotheses
 * @param {Object} observation - The observed state change
 * @returns {Array} Compound hypotheses (may be empty)
 */
function generateCompounds(scoredHypotheses, observation) {
    const config = getCompoundConfig();

    if (scoredHypotheses.length < 2) return [];
    if (scoredHypotheses[0].fit >= config.fitThresholdToGenerate) return [];

    const viable = scoredHypotheses.filter(h => h.fit >= config.minConstituentFit);
    if (viable.length < 2) return [];

    const compounds = [];

    for (let i = 0; i < viable.length && compounds.length < config.maxCompounds; i++) {
        for (let j = i + 1; j < viable.length && compounds.length < config.maxCompounds; j++) {
            const a = viable[i];
            const b = viable[j];

            if (a.hypothesis.templateId === b.hypothesis.templateId) continue;

            const result = calculateCompoundSPS(
                a.hypothesis, b.hypothesis, observation, config.crossingPenalty
            );

            compounds.push({
                hypothesis: {
                    templateId: 'COMPOUND_2WAY',
                    description: `${a.hypothesis.templateId} + ${b.hypothesis.templateId} converged`,
                    constituentA: a.hypothesis.templateId,
                    constituentB: b.hypothesis.templateId,
                    layer: 'L1'
                },
                spsScore: result.spsScore,
                fit: result.fit,
                components: result.components
            });
        }
    }

    return compounds;
}

// =============================================================================
// CROSS-LAYER ARBITRATION
// =============================================================================

/**
 * Determine if two hypotheses from different layers are consistent.
 *
 * CONSISTENT: Both imply same PAD direction
 * CONTRADICTORY: One implies negative, other implies positive/stable
 * ORTHOGONAL: Address different dimensions, cannot compare
 *
 * @param {Object} h1 - Hypothesis from one layer
 * @param {Object} h2 - Hypothesis from another layer
 * @returns {string} 'consistent', 'contradictory', 'orthogonal', or 'absent'
 */
function areConsistent(h1, h2) {
    if (!h1 || !h2) return 'absent';

    const dir1 = h1.hypothesis ? h1.hypothesis.expectedDirection : h1.expectedDirection;
    const dir2 = h2.hypothesis ? h2.hypothesis.expectedDirection : h2.expectedDirection;

    if (!dir1 || !dir2) return 'orthogonal';
    if (dir1 === dir2) return 'consistent';

    return 'contradictory';
}

/**
 * Arbitrate between layer winners.
 * L2 (historical/trajectory) overrides L1 (current) when contradictory.
 * Confidence = min(L1 fit, L2 fit) when consistent.
 *
 * @param {Object|null} l1Winner - Best L1 hypothesis (scored)
 * @param {Object|null} l2Winner - Best L2 hypothesis (scored)
 * @returns {Object} Arbitration result
 */
function arbitrateLayers(l1Winner, l2Winner) {
    if (!l1Winner && !l2Winner) {
        return { winner: null, source: 'none', confidence: 0, consistency: 'absent' };
    }

    if (!l2Winner) {
        return {
            winner: l1Winner,
            source: 'L1',
            confidence: l1Winner.fit,
            consistency: 'absent'
        };
    }

    if (!l1Winner) {
        return {
            winner: l2Winner,
            source: 'L2',
            confidence: l2Winner.fit,
            consistency: 'absent'
        };
    }

    const consistency = areConsistent(l1Winner, l2Winner);

    if (consistency === 'consistent') {
        return {
            winner: l1Winner,
            source: 'L1+L2',
            confidence: Math.min(l1Winner.fit, l2Winner.fit),
            consistency,
            supporting: [l1Winner, l2Winner]
        };
    }

    if (consistency === 'contradictory') {
        return {
            winner: l2Winner,
            source: 'L2_override',
            confidence: l2Winner.fit,
            consistency,
            overridden: l1Winner,
            reason: 'Historical trajectory contradicts current message interpretation'
        };
    }

    return {
        winner: l1Winner,
        source: 'L1_default',
        confidence: Math.max(l1Winner.fit, l2Winner.fit),
        consistency,
        candidates: [l1Winner, l2Winner]
    };
}

// =============================================================================
// EVALUATION LOGGING — Writes to razor_evaluations table
// =============================================================================

/**
 * Log a completed evaluation to the razor_evaluations table.
 * Uses transaction discipline: hex ID generation and INSERT are atomic.
 *
 * @param {Object} evaluationData - Evaluation result to log
 * @param {Object} [queryable=pool] - DB client or pool
 * @returns {Promise<string|null>} evaluation_id hex or null on failure
 */
async function _logEvaluation(evaluationData, queryable = pool) {
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const evaluationId = await generateHexId('razor_evaluation_id', client);

            await client.query({
                text: `INSERT INTO razor_evaluations (
                           evaluation_id, character_id, observation_type,
                           dimension, old_value, new_value,
                           top_hypothesis_type, top_hypothesis_sps,
                           was_overridden, user_selected_hypothesis,
                           user_belt_level, full_result
                       ) VALUES (
                           $1, $2, $3, $4, $5, $6, $7, $8,
                           $9, $10, $11, $12
                       )`,
                values: [
                    evaluationId,
                    evaluationData.characterId,
                    evaluationData.observationType,
                    evaluationData.dimension || null,
                    evaluationData.oldValue || null,
                    evaluationData.newValue || null,
                    evaluationData.topHypothesisType,
                    evaluationData.topHypothesisSps,
                    false,
                    null,
                    evaluationData.userBeltLevel || null,
                    JSON.stringify(evaluationData.fullResult)
                ],
                timeout: 5000
            });

            await client.query('COMMIT');

            logger.debug('Evaluation logged', {
                evaluationId,
                characterId: evaluationData.characterId,
                topHypothesis: evaluationData.topHypothesisType
            });

            return evaluationId;

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

    } catch (err) {
        logger.error('Failed to log evaluation', {
            characterId: evaluationData.characterId,
            error: err.message
        });
        return null;
    }
}

// =============================================================================
// MAIN EVALUATION — The public entry point
// =============================================================================

/**
 * Evaluate competing explanations for an observed character state change.
 *
 * This is the primary entry point for the Ockham's Razor Engine.
 *
 * @param {Object} observation - The observed state change
 *   @param {string} observation.characterId - Who changed (hex ID)
 *   @param {string} observation.observationType - Category of change
 *   @param {string} [observation.dimension] - PAD dimension
 *   @param {number} [observation.oldValue] - Previous value
 *   @param {number} [observation.newValue] - New value
 *   @param {number} observation.timestamp - When observed
 *   @param {string} [observation.userBeltLevel] - Current user belt
 * @param {Object} [options={}] - Configuration overrides
 *   @param {boolean} [options.logEvaluation=true] - Whether to write to DB
 *   @param {Object} [options.weights] - Custom SPS weights
 * @returns {Promise<Object>} Complete evaluation result
 */
async function evaluate(observation, options = {}) {
    const startTime = Date.now();

    if (!observation || !observation.characterId) {
        logger.warn('evaluate called with missing observation');
        return { success: false, error: 'Missing observation or characterId' };
    }

    if (!isValidHexId(observation.characterId)) {
        logger.warn('evaluate called with invalid characterId', {
            characterId: observation.characterId
        });
        return { success: false, error: 'Invalid characterId format' };
    }

    const context = await gatherCharacterContext(observation.characterId);

    if (!context) {
        return { success: false, error: 'Failed to gather character context' };
    }

    const hypotheses = generateHypotheses(context, observation);

    if (hypotheses.length === 0) {
        const durationMs = Date.now() - startTime;
        logger.debug('No hypotheses generated', {
            characterId: observation.characterId, durationMs
        });
        return {
            success: true,
            characterId: observation.characterId,
            hypothesisCount: 0,
            ranked: [],
            winner: null,
            anomaly: { isAnomaly: false, conditionCount: 0, recommendation: 'No hypotheses to evaluate.' },
            arbitration: null,
            durationMs
        };
    }

    const scored = hypotheses.map(hypothesis => {
        const result = calculateSPS(hypothesis, observation, options.weights);
        return {
            hypothesis,
            spsScore: result.spsScore,
            fit: result.fit,
            components: result.components
        };
    });

    const ranked = rankBySPS(scored);

    const compounds = generateCompounds(ranked, observation);
    const allRanked = rankBySPS([...ranked, ...compounds]);

    const l1Hypotheses = allRanked.filter(h =>
        h.hypothesis.layer === 'L1'
    );
    const l2Hypotheses = allRanked.filter(h =>
        h.hypothesis.layer === 'L2'
    );

    const l1Winner = l1Hypotheses.length > 0 ? l1Hypotheses[0] : null;
    const l2Winner = l2Hypotheses.length > 0 ? l2Hypotheses[0] : null;

    const arbitration = arbitrateLayers(l1Winner, l2Winner);
    const anomaly = detectAnomaly(allRanked);
    const durationMs = Date.now() - startTime;

    const winner = arbitration.winner || allRanked[0] || null;

    const result = {
        success: true,
        characterId: observation.characterId,
        observation,
        hypothesisCount: allRanked.length,
        simpleCount: ranked.length,
        compoundCount: compounds.length,
        ranked: allRanked,
        winner,
        arbitration,
        anomaly,
        context: {
            availability: context.availability,
            errors: context.errors
        },
        durationMs
    };

    if (options.logEvaluation !== false && winner) {
        await _logEvaluation({
            characterId: observation.characterId,
            observationType: observation.observationType || 'pad_change',
            dimension: observation.dimension,
            oldValue: observation.oldValue,
            newValue: observation.newValue,
            topHypothesisType: winner.hypothesis.templateId,
            topHypothesisSps: winner.spsScore,
            userBeltLevel: observation.userBeltLevel,
            fullResult: result
        });
    }

    logger.info('Razor evaluation complete', {
        characterId: observation.characterId,
        hypothesisCount: allRanked.length,
        winner: winner ? winner.hypothesis.templateId : 'none',
        winnerSps: winner ? winner.spsScore : null,
        winnerFit: winner ? winner.fit : null,
        isAnomaly: anomaly.isAnomaly,
        arbitrationSource: arbitration.source,
        durationMs
    });

    return result;
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
    evaluate,
    generateHypotheses,
    generateCompounds,
    areConsistent,
    arbitrateLayers
};

export default evaluate;
