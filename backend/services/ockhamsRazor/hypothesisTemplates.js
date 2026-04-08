/**
 * =============================================================================
 * HYPOTHESIS TEMPLATES — Ockham's Razor Engine
 * =============================================================================
 *
 * PURPOSE:
 *   Defines the 13 hypothesis templates used by the Razor to generate
 *   competing explanations for observed character state changes.
 *
 * ARCHITECTURE:
 *   Each template describes a causal pattern:
 *     - What mechanism(s) are involved
 *     - How many causal links the chain contains
 *     - Which database tables are read to instantiate it
 *     - Whether its dependencies are currently available
 *
 * RESEARCH BASIS:
 *   Template library design informed by MYCIN-style expert systems
 *   (Buchanan & Shortliffe, 1984) and agent-based simulation literature
 *   (Manzo, 2022; Millington et al., 2012).
 *
 * SPEC REFERENCE:
 *   V010_RESEARCH_BRIEF_Ockhams_Razor_Engine.md
 *   3 rounds of independent review (scored 95/100)
 *
 * GRACEFUL DEGRADATION:
 *   Templates whose database dependencies do not yet exist are marked
 *   status: 'pending'. The engine skips pending templates during
 *   hypothesis generation rather than crashing.
 *
 * DETERMINISTIC:
 *   Same inputs always produce same template matches. No randomness.
 *
 * =============================================================================
 */
import { createModuleLogger } from '../../utils/logger.js';
const logger = createModuleLogger('hypothesisTemplates');
// =============================================================================
// TEMPLATE DEFINITIONS
// =============================================================================
/**
 * All 13 hypothesis templates.
 *
 * Each template contains:
 *   id            - Unique template identifier (matches CHECK constraint in razor_evaluations)
 *   description   - Human-readable explanation pattern
 *   mechanisms    - Array of mechanism types invoked
 *   baseLinkCount - Number of causal links in the chain
 *   assumptions   - Number of unobserved states assumed (0 for most)
 *   dataSources   - Object mapping table names to columns read
 *   status        - 'active' if dependencies exist, 'pending' if not yet built
 *   dependencyDoc - Reference document for pending dependencies (null if active)
 */
const HYPOTHESIS_TEMPLATES = Object.freeze([
    // =========================================================================
    // ACTIVE TEMPLATES (8) — All data sources exist in production
    // =========================================================================
    {
        id: 'PAD_DIRECT',
        description: '[CHARACTER] experienced [BEAT] which directly assigned [DIMENSION] = [VALUE]',
        mechanisms: ['narrative_direct'],
        baseLinkCount: 1,
        assumptions: 0,
        dataSources: {
            narrative_beat_play_log: ['beat_id', 'character_id', 'played_at'],
            narrative_beats: ['beat_id', 'target_pad_p', 'target_pad_a', 'target_pad_d']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'PROX_CONTAGION',
        description: '[CHARACTER_A] proximity to [CHARACTER_B] caused emotional contagion in [DIMENSION]',
        mechanisms: ['proximity_contagion'],
        baseLinkCount: 1,
        assumptions: 0,
        dataSources: {
            psychic_proximity_directed: ['from_character', 'to_character', 'current_distance'],
            psychic_frames: ['character_id', 'pleasure', 'arousal', 'dominance', 'recorded_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'TRANSITIVE_CONTAGION',
        description: '[CHAR_A] affected [CHAR_B] who affected [CHAR_C] via chain contagion in [DIMENSION]',
        mechanisms: ['proximity_contagion', 'proximity_contagion'],
        baseLinkCount: 2,
        assumptions: 0,
        dataSources: {
            psychic_proximity_directed: ['from_character', 'to_character', 'current_distance'],
            psychic_frames: ['character_id', 'pleasure', 'arousal', 'dominance', 'recorded_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'IKIGAI_DRAIN',
        description: '[CHARACTER] [NEED] ikigai dropped, reducing resilience, triggering [DIMENSION] vulnerability',
        mechanisms: ['ikigai_drain', 'resilience_model', 'pad_vulnerability'],
        baseLinkCount: 3,
        assumptions: 0,
        dataSources: {
            character_need_fulfillments: ['character_id', 'need_code', 'fulfillment_score', 'updated_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'IKIGAI_DIVERSITY_COLLAPSE',
        description: '[CHARACTER] ikigai sources concentrated (HHI increased), raising instability',
        mechanisms: ['ikigai_diversity', 'hhi_model', 'pad_instability'],
        baseLinkCount: 3,
        assumptions: 0,
        dataSources: {
            character_need_fulfillments: ['character_id', 'need_code', 'fulfillment_score', 'updated_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'MOAI_WEAKEN',
        description: '[CHARACTER] bond with [CHARACTER_B] weakened, reducing connection ikigai and resilience',
        mechanisms: ['moai_decay', 'ikigai_drain', 'resilience_model'],
        baseLinkCount: 3,
        assumptions: 0,
        dataSources: {
            psychic_proximity_directed: ['from_character', 'to_character', 'current_distance'],
            character_need_fulfillments: ['character_id', 'need_code', 'fulfillment_score', 'updated_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'OCEAN_FACET_VULN',
        description: '[EVENT] triggered [CHARACTER] [FACET] vulnerability response',
        mechanisms: ['narrative_event', 'ocean_facet', 'facet_response'],
        baseLinkCount: 2,
        assumptions: 1,
        dataSources: {
            character_neo_pi_r_facets: ['character_id', 'facet_code', 'score'],
            narrative_beat_play_log: ['beat_id', 'character_id', 'played_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    {
        id: 'PAD_DECAY_BASELINE',
        description: '[CHARACTER] PAD drifting back toward OCEAN archetype baseline in [DIMENSION]',
        mechanisms: ['ocean_baseline', 'pad_decay'],
        baseLinkCount: 2,
        assumptions: 0,
        dataSources: {
            character_profiles: ['character_id', 'archetype_id'],
            ocean_archetypes: ['archetype_id', 'pad_pleasure_default', 'pad_arousability_default', 'pad_dominance_default'],
            psychic_frames: ['character_id', 'pleasure', 'arousal', 'dominance', 'recorded_at']
        },
        status: 'active',
        dependencyDoc: null
    },
    // =========================================================================
    // PENDING TEMPLATES (4) — Dependencies not yet built
    // =========================================================================
    {
        id: 'BURNOUT_STAGE_TRANSITION',
        description: '[CHARACTER] crossed Maslach burnout stage threshold',
        mechanisms: ['burnout_model', 'threshold_breach'],
        baseLinkCount: 2,
        assumptions: 0,
        dataSources: {
            character_burnout_stages: ['character_id', 'stage', 'score', 'updated_at']
        },
        status: 'pending',
        dependencyDoc: 'V010_MASTER_SPEC_Narrative_System.md Section 4.2 (Maslach Burnout Model). Activate after Ikigai Engine Phase 3.'
    },
    {
        id: 'INTERVENTION_EFFECT',
        description: 'User intervention on [CHARACTER] caused [DIMENSION] change',
        mechanisms: ['user_intervention'],
        baseLinkCount: 1,
        assumptions: 0,
        dataSources: {
            intervention_log: ['character_id', 'intervention_type', 'created_at']
        },
        status: 'pending',
        dependencyDoc: 'Intervention logging system not yet specified. Requires new table definition.'
    },
    {
        id: 'INTERVENTION_SIDE_EFFECT',
        description: 'User intervention on [CHARACTER_A] cascaded to [CHARACTER_B] via proximity',
        mechanisms: ['user_intervention', 'proximity_cascade'],
        baseLinkCount: 2,
        assumptions: 0,
        dataSources: {
            intervention_log: ['character_id', 'intervention_type', 'created_at'],
            psychic_proximity_directed: ['from_character', 'to_character', 'current_distance']
        },
        status: 'pending',
        dependencyDoc: 'Intervention logging system not yet specified. Requires new table definition.'
    },
    {
        id: 'OVER_INTERVENTION',
        description: 'Unnecessary intervention on [CHARACTER] lowered dominance',
        mechanisms: ['over_intervention', 'dominance_drain'],
        baseLinkCount: 2,
        assumptions: 0,
        dataSources: {
            intervention_log: ['character_id', 'intervention_type', 'created_at'],
            psychic_frames: ['character_id', 'dominance', 'recorded_at']
        },
        status: 'pending',
        dependencyDoc: 'Intervention logging system not yet specified. Requires new table definition.'
    },

    // =========================================================================
    // DYNAMIC TEMPLATE (1) — Generated procedurally, not from fixed pattern
    // =========================================================================

    {
        id: 'COMPOUND_2WAY',
        description: '[TEMPLATE_A] and [TEMPLATE_B] converged to cause [OUTCOME]',
        mechanisms: ['compound_convergence'],
        baseLinkCount: 0,
        assumptions: 0,
        dataSources: {},
        status: 'dynamic',
        dependencyDoc: 'Generated procedurally when top simple hypothesis fit < 70%. See COMPOUND_CONFIG.'
    }
]);
// =============================================================================
// COMPOUND TEMPLATE DEFINITION
// =============================================================================
/**
 * COMPOUND_2WAY is not a fixed template — it is generated dynamically
 * by pairing two simple hypotheses that both partially explain the
 * observed data.
 *
 * Generation rules (from research specification):
 *   - Only generated when top simple hypothesis fit < 70%
 *   - Only pairs mechanisms with > 50% individual fit
 *   - Both must affect same PAD dimension
 *   - Both must occur within 30-second window
 *   - Maximum 6 compound hypotheses per evaluation
 *   - SPS = sum of constituent SPS values + 1.0 (crossing penalty)
 */
const COMPOUND_CONFIG = Object.freeze({
    id: 'COMPOUND_2WAY',
    fitThresholdToGenerate: 0.70,
    minConstituentFit: 0.50,
    temporalWindowMs: 30000,
    maxCompounds: 6,
    crossingPenalty: 1.0
});
// =============================================================================
// PUBLIC API
// =============================================================================
/**
 * Returns all active templates (dependencies satisfied).
 * Pending templates are logged at debug level and excluded.
 *
 * @returns {Array<Object>} Active template definitions.
 */
function getActiveTemplates() {
    const active = [];
    const pending = [];
    for (const template of HYPOTHESIS_TEMPLATES) {
        if (!template.id || !template.status) {
            logger.warn('Malformed hypothesis template skipped', { template });
            continue;
        }
        if (template.status === 'active') {
            active.push(template);
        } else {
            pending.push(template.id);
        }
    }
    if (pending.length > 0) {
        logger.debug('Hypothesis templates skipped (dependencies pending)', {
            pendingTemplates: pending,
            activeCount: active.length,
            totalCount: HYPOTHESIS_TEMPLATES.length
        });
    }
    return active;
}
/**
 * Returns all templates regardless of status.
 * Used for admin inspection and documentation.
 *
 * @returns {Array<Object>} All 13 template definitions.
 */
function getAllTemplates() {
    return [...HYPOTHESIS_TEMPLATES];
}
/**
 * Returns the compound generation configuration.
 *
 * @returns {Object} Compound hypothesis generation rules.
 */
function getCompoundConfig() {
    return { ...COMPOUND_CONFIG };
}
/**
 * Look up a template by ID.
 *
 * @param {string} templateId - Template ID (e.g. 'PROX_CONTAGION')
 * @returns {Object|null} Template definition or null if not found.
 */
function getTemplateById(templateId) {
    return HYPOTHESIS_TEMPLATES.find(t => t.id === templateId) || null;
}
export {
    getActiveTemplates,
    getAllTemplates,
    getCompoundConfig,
    getTemplateById,
    HYPOTHESIS_TEMPLATES,
    COMPOUND_CONFIG
};
export default getActiveTemplates;
