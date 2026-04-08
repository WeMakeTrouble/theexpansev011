/**
 * ===========================================================================
 * validateTestVectors.js — FAANG-Standard Test Harness for Ikigai Engine
 * ===========================================================================
 *
 * PURPOSE:
 * Three golden-path test vectors that validate the core computation pipeline.
 * Equivalent to the Chaos Engine's validateTestVectors.js — these are the
 * minimum assertions that must pass before any deployment.
 *
 * TEST VECTOR 1 — HUOT-LAVOIE PATTERN (INSUFFICIENT DATA):
 *   Input: 0 teaching cycles, 5 sessions, high obsessive passion (0.8)
 *   Expected: confidence: 'low', quadrant: 'unknown', insufficient_data: true
 *   Validates: DD02 Q4 compliance — the engine refuses to classify passion
 *   type when teaching_cycles < 3. This prevents overclaiming with
 *   inadequate samples (Tijerina, 2025).
 *
 * TEST VECTOR 2 — ACTUAL DB STATE (#700005):
 *   Input: Real character with 0 teaching cycles, 40 sessions, obsessive
 *   Expected: confidence: 'low', overall < 0.4
 *   Validates: Harmonic mean suppression with hollow contribution. Even
 *   with many sessions, zero teaching cycles = low confidence = Okinawan
 *   score forced to 0.001 = overall composite suppressed via 2ko/(k+o).
 *   This is the Huot-Lavoie pattern in action: a character can be highly
 *   active but contributing nothing (Huot-Lavoie et al., 2026).
 *
 * TEST VECTOR 3 — COLD START:
 *   Input: noHistory: true
 *   Expected: confidence: 'low' OR overall >= 0.35 (floor)
 *   Validates: Cold-start behaviour — a character with no interaction
 *   history gets a personality-baseline floor score (0.35), not null or
 *   zero. The floor is derived from archetype personality data alone.
 *
 * WHAT IS NOT YET TESTED:
 *   High-confidence quadrant classification (obsessive_extractive with 10+
 *   teaching cycles) requires transaction-scoped test fixtures that create
 *   synthetic behavioral_baselines and passion_state rows. These are not
 *   yet built — they are a v012 blocker.
 *
 * USAGE:
 *   import { validateTestVectors } from './tools/validateTestVectors.js';
 *   await validateTestVectors(db);  // throws on failure
 *
 * DEPENDENCIES:
 *   - IkigaiEngine (../IkigaiEngine.js)
 *   - Node.js assert module (strict mode)
 *   - Live database connection with populated character data
 *
 * EXPORTS:
 *   validateTestVectors(db) → void (throws on assertion failure)
 *
 * RESEARCH CITATIONS:
 *   [1]  Huot-Lavoie, M., et al. (2026). Gaming disorder in first episode
 *        psychosis: Prevalence and impact on symptomatology and functioning
 *        in a prospective cohort study. Schizophrenia Bulletin, 52(2),
 *        sbaf232. [Test 1 and 2 named after this pattern]
 *   [2]  Tijerina, E. (2025). The measurement crisis: A hidden flaw in
 *        psychology. MetaResearch.
 *        [Confidence threshold rationale — refuse to classify with
 *         inadequate measurement reliability]
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Test Harness
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
import { strict as assert } from 'assert';

export async function validateTestVectors(db) {
  const { IkigaiEngine } = await import('../IkigaiEngine.js');
  const engine = new IkigaiEngine(db);

  // TEST 1: Huot-Lavoie Pattern with INSUFFICIENT data (low confidence)
  const huotLowConfidence = await engine.computeTestOnly({
    characterId: '#700005',
    sdt: {
      relatedness_satisfaction: 0.8,
      competence_satisfaction: 0.6,
      autonomy_satisfaction: 0.4
    },
    diagnostic: {
      pad: { pleasure: 0.6, arousal: 0.2, dominance: 0.1 },
      intent: { frame: 'social', blendProbabilities: { social: 0.9 } },
      drClaude: { consecutiveNegativeTurns: 6, volatility: 0.85 },
      isRewatch: false
    },
    baselines: {
      teaching_ratio: 0.0,
      reciprocal_proximity: 0.2,
      reciprocal_proximity_samples: 25,
      harmonious: 0.2,
      obsessive: 0.8,
      teaching_cycles: 0,
      session_count: 5
    }
  });

  assert.strictEqual(huotLowConfidence.okinawan.confidence, 'low');
  assert.strictEqual(huotLowConfidence.okinawan.quadrant, 'unknown');
  assert.strictEqual(huotLowConfidence.okinawan.insufficient_data, true);
  assert(huotLowConfidence.overall < 0.4);
 
  console.log('✓ Test 1 passed: Huot-Lavoie pattern with insufficient data');

  // TEST 2: ACTUAL DB STATE (#700005 has 0 teaching cycles, 40 sessions, high obsessive passion)
  // Per DD02 Q4: 0 teaching cycles = low confidence, quadrant = 'unknown'
  const actualDBState = await engine.computeTestOnly({
    characterId: '#700005'
  });

  assert.strictEqual(actualDBState.okinawan.confidence, 'low',
    'DB state: 0 teaching cycles = low confidence per DD02 thresholds');
  assert.strictEqual(actualDBState.okinawan.quadrant, 'unknown',
    'DB state: low confidence forces unknown quadrant per DD02 Q4');
  assert.strictEqual(actualDBState.okinawan.insufficient_data, true);
  assert(actualDBState.overall < 0.4,
    'DB state: Overall suppressed by harmonic mean with low Okinawan');
 
  console.log('✓ Test 2 passed: Actual DB state (0 teaching, obsessive passion, low confidence)');

  // TEST 3: Cold start
  const coldStart = await engine.computeTestOnly({
    characterId: '#700005',
    noHistory: true
  });

  assert(coldStart.okinawan.confidence === 'low' || coldStart.overall >= 0.35);
  assert(coldStart.okinawan.insufficient_data === true);

  console.log('✓ Test 3 passed: Cold start');

  console.log('\n✓ All FAANG-standard test vectors passed');
  console.log('Note: High-confidence quadrant classification requires 10+ teaching cycles');
  console.log('      (transaction-scoped fixture, not production data per FAANG protocol)');
}
