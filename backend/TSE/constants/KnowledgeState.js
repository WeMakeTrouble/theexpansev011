/**
 * =============================================================================
 * KnowledgeState — TSE Knowledge State Constants
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Canonical constants for knowledge acquisition categories and knowledge
 * state classifications within the Teaching Session Engine.
 *
 * TASK_CATEGORY_ACQUISITION is the default category for knowledge-based
 * teaching tasks (recall, teaching, lore comprehension).
 *
 * KnowledgeState defines the progression stages a knowledge item passes
 * through during the learning process. These are distinct from the
 * LEARNING_STATE enum (which tracks FSRS scheduling state).
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TeacherComponent.js — imports TASK_CATEGORY_ACQUISITION
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Object.freeze for immutability
 *   - Named exports for tree-shaking
 *   - No console.log
 *
 * =============================================================================
 */

export const TASK_CATEGORY_ACQUISITION = "acquisition";

export const KnowledgeState = Object.freeze({
  UNSEEN: "UNSEEN",
  INTRODUCED: "INTRODUCED",
  ANCHORED: "ANCHORED",
  PRACTICED: "PRACTICED",
  REINFORCED: "REINFORCED"
});
