/**
 * =============================================================================
 * TaskCategories — Authoritative TSE Task Category Registry
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Single source of truth for all allowed task categories in the TSE loop.
 * Every task.taskCategory MUST be exactly one of these values.
 *
 * No dotted values (e.g. rewrite.summarize), no null, no empty string.
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   TeacherComponent.js — task category assignment
 *   EvaluatorComponent.js — category-based evaluation routing
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - Object.freeze for immutability
 *   - Named exports for tree-shaking
 *   - Derived VALID_CATEGORIES array for runtime validation
 *   - No console.log
 *
 * =============================================================================
 */

export const TASK_CATEGORIES = Object.freeze({
  ACQUISITION: "acquisition",
  RECALL: "recall",
  COMMUNICATION_QUALITY: "communication_quality",
  REWRITE: "rewrite",
  REVIEW: "review",
  APPLICATION: "application"
});

export const VALID_CATEGORIES = Object.freeze(Object.values(TASK_CATEGORIES));
