/**
 * =============================================================================
 * WWDD ENGINE — Public API
 * =============================================================================
 *
 * PURPOSE:
 *   Single import point for all WWDD engine functionality.
 *   Other codebase modules import from this file, not from internals.
 *
 * USAGE:
 *   import { initSession, processTurn, getState } from '../services/wwdd/index.js';
 *
 *   // At session start (BrainOrchestrator or socketHandler):
 *   initSession(sessionId, userId);
 *
 *   // After EarWig collation, before phase loop:
 *   const wwddState = await processTurn(
 *       sessionId,
 *       turnCount,
 *       diagnosticReport,
 *       drClaudeOutput,
 *       convState
 *   );
 *
 *   // Emit to frontend via Socket.io:
 *   io.to('session:' + sessionId).emit('wwdd_update', wwddState);
 *
 *   // User-initiated outcome reveal (surfacing state only):
 *   const outcome = surfaceOutcome(sessionId);
 *
 *   // At session end:
 *   await endSession(sessionId);
 *
 * MODULE ARCHITECTURE:
 *   WwddEngine.js — Core engine (signals, hypotheses, clarity, alignment,
 *                   state persistence, TTL eviction, public API)
 *
 * SPEC REFERENCE:
 *   BLUEPRINT_WWDDEngine_v1.1.md
 *   V010_RESEARCH_BRIEF_Danique_Engine.md
 *
 * =============================================================================
 */

import processTurn, {
    initSession,
    getState,
    surfaceOutcome,
    endSession,
    getConfig,
    __test__
} from './WwddEngine.js';

// =============================================================================
// PRIMARY API — What most callers need
// =============================================================================

export { processTurn };
export default processTurn;

// =============================================================================
// SESSION LIFECYCLE — Required for BrainOrchestrator integration
// =============================================================================

export {
    initSession,
    getState,
    surfaceOutcome,
    endSession,
    getConfig
};

// =============================================================================
// TEST HOOKS — For unit testing without DB or pipeline mocks
// =============================================================================

export { __test__ };
