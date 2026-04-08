/**
 * =============================================================================
 * OCKHAM'S RAZOR ENGINE — Public API
 * =============================================================================
 *
 * PURPOSE:
 *   Single import point for all Razor engine functionality.
 *   Other codebase modules import from this file, not from internals.
 *
 * USAGE:
 *   import { evaluate } from '../services/ockhamsRazor/index.js';
 *
 *   const result = await evaluate({
 *       characterId: targetCharacterId,
 *       observationType: 'pad_change',
 *       dimension: 'PLEASURE',
 *       oldValue: previousPadValue,
 *       newValue: currentPadValue,
 *       timestamp: Date.now(),
 *       userBeltLevel: currentBeltLevel
 *   });
 *
 * MODULE ARCHITECTURE:
 *   hypothesisTemplates.js — 13 causal pattern definitions
 *   spsScorer.js           — Structural Parsimony Score calculator
 *   contextGatherer.js     — Read-only database context collection
 *   OckhamsRazorEngine.js  — Orchestrator (generation, scoring, arbitration)
 *
 * SPEC REFERENCE:
 *   V010_RESEARCH_BRIEF_Ockhams_Razor_Engine.md
 *
 * =============================================================================
 */

import evaluate, {
    generateHypotheses,
    generateCompounds,
    areConsistent,
    arbitrateLayers
} from './OckhamsRazorEngine.js';

import {
    getActiveTemplates,
    getAllTemplates,
    getCompoundConfig,
    getTemplateById,
    HYPOTHESIS_TEMPLATES
} from './hypothesisTemplates.js';

import {
    calculateSPS,
    calculateDataFit,
    calculateCompoundSPS,
    rankBySPS,
    detectAnomaly,
    DEFAULT_WEIGHTS
} from './spsScorer.js';

import {
    gatherCharacterContext,
    getRecentPadFrames,
    getProximityContext,
    getIkigaiNeeds,
    getOceanFacets,
    getPadBaseline,
    getRecentBeatPlays
} from './contextGatherer.js';

// =============================================================================
// PRIMARY API — What most callers need
// =============================================================================

export { evaluate };
export default evaluate;

// =============================================================================
// ENGINE INTERNALS — For admin tools, testing, and advanced usage
// =============================================================================

export {
    generateHypotheses,
    generateCompounds,
    areConsistent,
    arbitrateLayers,

    getActiveTemplates,
    getAllTemplates,
    getCompoundConfig,
    getTemplateById,
    HYPOTHESIS_TEMPLATES,

    calculateSPS,
    calculateDataFit,
    calculateCompoundSPS,
    rankBySPS,
    detectAnomaly,
    DEFAULT_WEIGHTS,

    gatherCharacterContext,
    getRecentPadFrames,
    getProximityContext,
    getIkigaiNeeds,
    getOceanFacets,
    getPadBaseline,
    getRecentBeatPlays
};
