/**
 * =============================================================================
 * LearningStateEnum — Canonical FSRS Learning State Machine
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Sourced from PostgreSQL ENUM type learning_state_enum.
 * Database query: SELECT enum_range(NULL::learning_state_enum)
 * Result: {unseen, seen, retrievable, scheduled}
 *
 * Pedagogical Flow:
 *   unseen → (teaching phase) → seen → (retrieval attempt) → retrievable → scheduled
 *
 * State Machine Rules:
 *   - UNSEEN can only transition to SEEN (teaching required before testing)
 *   - SEEN can only transition to RETRIEVABLE (after successful first recall)
 *   - RETRIEVABLE can transition to SCHEDULED (after FSRS parameters initialized)
 *   - SCHEDULED can transition back to RETRIEVABLE (after review/retrieval attempt)
 *   - SCHEDULED can loop to SCHEDULED (interval updated, stays in review rotation)
 *   - No backward transitions (no SEEN → UNSEEN)
 *   - No skipping phases (no UNSEEN → RETRIEVABLE)
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TeacherComponent.js — learning state checks for task generation
 *   StudentComponent.js — state transitions after learning events
 *   EvaluatorComponent.js — state-aware evaluation
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Object.freeze for immutability
 *   - Named exports for tree-shaking
 *   - Validation helpers included
 *   - No console.log
 *
 * @typedef {"unseen" | "seen" | "retrievable" | "scheduled"} LearningState
 *
 * =============================================================================
 */

/**
 * Learning state enumeration
 * @type {Readonly<{UNSEEN: "unseen", SEEN: "seen", RETRIEVABLE: "retrievable", SCHEDULED: "scheduled"}>}
 */
export const LEARNING_STATE = Object.freeze({
  UNSEEN: "unseen",
  SEEN: "seen",
  RETRIEVABLE: "retrievable",
  SCHEDULED: "scheduled"
});

/**
 * Valid state transitions
 * @type {Readonly<Record<string, string[]>>}
 */
export const LEARNING_STATE_TRANSITIONS = Object.freeze({
  [LEARNING_STATE.UNSEEN]: [LEARNING_STATE.SEEN],
  [LEARNING_STATE.SEEN]: [LEARNING_STATE.RETRIEVABLE],
  [LEARNING_STATE.RETRIEVABLE]: [LEARNING_STATE.SCHEDULED],
  [LEARNING_STATE.SCHEDULED]: [LEARNING_STATE.RETRIEVABLE, LEARNING_STATE.SCHEDULED]
});

/**
 * Validate if a value is a valid learning state
 * @param {string} value — value to validate
 * @returns {boolean} true if value is valid learning state
 */
export function isValidLearningState(value) {
  return Object.values(LEARNING_STATE).includes(value);
}

/**
 * Check if transition from one state to another is allowed
 * @param {string} fromState — current state
 * @param {string} toState — target state
 * @returns {boolean} true if transition is valid
 */
export function isValidTransition(fromState, toState) {
  if (!isValidLearningState(fromState) || !isValidLearningState(toState)) {
    return false;
  }
  const allowed = LEARNING_STATE_TRANSITIONS[fromState];
  return allowed && allowed.includes(toState);
}

/**
 * Get human-readable state name from state value
 * @param {string} stateValue — state value (e.g. "unseen")
 * @returns {string|undefined} state key (e.g. "UNSEEN") or undefined
 */
export function getStateName(stateValue) {
  return Object.entries(LEARNING_STATE).find(([key, value]) => value === stateValue)?.[0];
}

export default LEARNING_STATE;
