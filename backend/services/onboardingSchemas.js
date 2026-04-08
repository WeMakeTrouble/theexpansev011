/**
 * =============================================================================
 * OnboardingSchemas — Zod Validation Schemas for Onboarding State Data
 * =============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Defines strict zod schemas for each onboarding state. When a user
 * transitions between onboarding states, OnboardingOrchestrator validates
 * the state_data payload against the corresponding schema here.
 *
 * Each state has a .strict() schema — no extra fields allowed.
 *
 * STATES:
 * ---------------------------------------------------------------------------
 *   new              — Fresh user, no data needed
 *   welcomed         — Welcome beat shown, optional beat ID
 *   awaiting_ready   — Waiting for user confirmation
 *   omiyage_offered  — Gift offered, optional hex choice ID
 *   onboarded        — Complete, tracks choice/declined/deferred/override
 *
 * CONSUMED BY:
 * ---------------------------------------------------------------------------
 *   OnboardingOrchestrator.js — imports StateDataSchemas for transition
 *                               validation (lines 99, 220, 543)
 *
 * v010 STANDARDS:
 * ---------------------------------------------------------------------------
 *   - No console.log (no logging needed — pure schema definitions)
 *   - Frozen export to prevent runtime mutation
 *   - Hex ID format enforced via startsWith('#')
 * =============================================================================
 */

import { z } from 'zod';

/**
 * Validation schemas for onboarding state_data payloads.
 * Keys match onboarding state names exactly.
 * All schemas use .strict() to reject unexpected fields.
 */
export const StateDataSchemas = Object.freeze({

  new: z.object({}).strict(),

  welcomed: z.object({
    welcome_beat_id: z.string().optional()
  }).strict(),

  awaiting_ready: z.object({}).strict(),

  omiyage_offered: z.object({
    choice_id: z.string().startsWith('#').optional()
  }).strict(),

  onboarded: z.object({
    choice_id: z.string().startsWith('#').optional(),
    declined: z.boolean().optional(),
    deferred: z.boolean().optional(),
    admin_override: z.boolean().optional()
  }).strict()

});
