/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FRACTURE ENGINE — Deterministic Trauma Algorithm for B-Roll Character Birth
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * This engine implements the psychological "birth trauma" algorithm for The
 * Expanse v010, transforming source entity PAD (Pleasure-Arousal-Dominance)
 * states into fractured neonatal states for newly born B-Roll characters.
 *
 * CLASSIFICATION: Theoretical computational model.
 * The algorithm is deterministic (seeded PRNG) and informed by established
 * psychological research, but the specific implementation (coefficients,
 * sigmoid scaling, neonatal blending, trajectory thresholds) has not been
 * empirically validated. All thresholds labeled as proposed.
 * psychological literature:
 *
 *   • Mehrabian & Russell (1974) — PAD Model of Emotional State
 *   • Mehrabian (1996) - Big Five to PAD temperament baseline mapping
 *   • Bowlby (1969/1982) — Attachment Theory & separation trauma
 *   • van der Hart et al. (2006) — Structural Dissociation Theory
 *   • Bonanno (2004) — Resilience trajectories in grief/trauma recovery
 *   • Sroufe (1979, 1996) — Infant emotional development (precursor emotions)
 *
 *   CORRECTION NOTES (March 2026 - Claude + James review):
 *   ---------------------------------------------------------------
 *   The original implementation used coefficients labeled as
 *   "Gebhard (2005)" for the OCEAN-to-PAD mapping. This was
 *   incorrect. Gebhard ALMA model maps OCC emotions to PAD,
 *   not Big Five personality to PAD. The correct source is
 *   Mehrabian (1996) - Australian J. Psychology, 48(2), 86-92.
 *
 *   Two sign errors were identified in the original formula:
 *     Pleasure: used +0.19*N (should be negative - high N = unpleasant)
 *     Arousal:  used -0.57*N (should be positive - high N = arousable)
 *
 *   Corrected formula uses Mehrabian Set 1 regression coefficients
 *   converted from Emotional_Stability to Neuroticism.
 *   Coefficient magnitudes as reported by external consultant (Kimi).
 *   Directions verified against Mehrabian abstract + secondary sources.
 *   Exact magnitudes NOT independently verified (paper behind paywall).
 *   Label: proposed - if plausible calibration via collaboration with GridLab / Dr Daniel Johnson QUT against original Table 3.
 *
 * Deterministic Randomness:
 *   Uses djb2 hashing (Bernstein, 1990) and Mulberry32 PRNG to ensure that
 *   identical inputs (entityId + objectId + objectType) always produce
 *   identical outputs. No Math.random() is used anywhere.
 *
 * Archetype System:
 *   Five object types based on object relations theory (Winnicott, Fairbairn):
 *   - universal:        Generic objects (0.6x trauma multiplier)
 *   - confined_object:  Enclosed spaces (0.8x trauma multiplier)
 *   - worn_object:      Body-worn items (0.9x trauma multiplier)
 *   - consumed_object:  Food/drink (0.7x trauma multiplier)
 *   - companion_object: Transitional objects (1.2x trauma multiplier)
 *
 * Mathematical Pipeline:
 *   1. Generate deterministic seed from entityId + objectId + objectType
 *   2. Calculate trauma severity based on attachment strength and source PAD
 *   3. Apply sigmoid scaling for non-linear severity response
 *   4. Transform PAD dimensions (P↓, A±, D↓ or Fight-spike)
 *   5. Apply structural dissociation fragmentation
 *   6. Blend with neonatal baseline (Sroufe's precursor emotions)
 *   7. Output final fractured PAD + trajectory prediction
 *
 * Recovery Modeling:
 *   Implements Bonanno's four trajectories (resilient, recovery, chronic,
 *   depressed-improved) using exponential decay toward OCEAN-derived baselines.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS USED:
 * ---------------------------------------------------------------------------
 * Imported by:
 *   - brollSocketHandler.js  → computeFracture() on character birth
 *   - Recovery tick worker   → computeRecovery() for emotional evolution
 *   - Omiyage gift handler   → applyOmiyage() for comfort shifts
 *
 * Usage Example:
 *   const engine = new FractureEngine();
 *   const fracture = engine.computeFracture({
 *     sourceP: 0.7,
 *     sourceA: -0.2,
 *     sourceD: 0.3,
 *     attachmentStrength: 0.9,
 *     objectType: 'companion_object',
 *     entityId: '#700001',
 *     objectId: '#700002',
 *     ocean: { openness: 80, conscientiousness: 60, extraversion: 70, ... }
 *   });
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM CONSTRAINTS:
 * ---------------------------------------------------------------------------
 *   - No Math.random() — only Mulberry32 seeded PRNG
 *   - No external AI APIs — pure algorithmic implementation
 *   - No Date-based randomness — timestamps are for logging only
 *   - Seed derived from hex IDs ensures reproducibility across sessions
 *
 * ---------------------------------------------------------------------------
 * PAD SCALE REFERENCE:
 * ---------------------------------------------------------------------------
 *   Pleasure (P):    -1.0 (miserable)  to  +1.0 (ecstatic)
 *   Arousal (A):     -1.0 (comatose)   to  +1.0 (frantic)
 *   Dominance (D):   -1.0 (helpless)   to  +1.0 (omnipotent)
 *
 * Neonatal Baseline (Sroufe's precursor emotions):
 *   P: 0.0  (neutral pleasure)
 *   A: 0.3  (alert but not frantic)
 *   D: -0.4 (helpless/dependent)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createModuleLogger } from '../backend/utils/logger.js';

const logger = createModuleLogger('FractureEngine');

/*
 * ============================================================================
 * Constants — Frozen Configuration
 * ============================================================================
 */

const FRACTURE_CONFIG = Object.freeze({
  SEVERITY_THRESHOLD: 0.3,
  SEVERITY_STEEPNESS: 6,
  FRAGMENTATION_FACTOR: 0.3,
  NEONATAL_BLEND_BASE: 0.3,
  VARIATION_P: 0.3,
  VARIATION_A: 0.4,
  VARIATION_D: 0.5,
  FIGHT_CHANCE: 0.3,
  FIGHT_DOMINANCE_BOOST: 0.4,
  OVERWHELM_AROUSAL_DROP: 0.3,
  AROUSAL_ACTIVATION: 0.6,
  DOMINANCE_DROP_BASE: 0.5,
  PLEASURE_DROP_BASE: 1.0
});

const ARCHETYPES = Object.freeze({
  universal:        { pMod: 0.3, aMod: 0.4, dMod: 0.2, traumaMultiplier: 0.6 },
  confined_object:  { pMod: 0.5, aMod: 0.6, dMod: 0.3, traumaMultiplier: 0.8 },
  worn_object:      { pMod: 0.6, aMod: 0.5, dMod: 0.4, traumaMultiplier: 0.9 },
  consumed_object:  { pMod: 0.4, aMod: 0.7, dMod: 0.2, traumaMultiplier: 0.7 },
  companion_object: { pMod: 0.8, aMod: 0.5, dMod: 0.6, traumaMultiplier: 1.2 }
});

const NEONATAL = Object.freeze({ P: 0.0, A: 0.3, D: -0.4 });

const TRAJECTORIES = Object.freeze({
  RESILIENT: 'resilient',
  RECOVERY: 'recovery',
  CHRONIC: 'chronic',
  DEPRESSED_IMPROVED: 'depressed-improved'
});

/*
 * ============================================================================
 * Deterministic Algorithms
 * ============================================================================
 */

/**
 * djb2 hash function (Bernstein, 1990)
 * Creates deterministic 32-bit unsigned integer from string.
 * @param {string} str - Input string to hash
 * @returns {number} 32-bit unsigned integer seed
 */
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Mulberry32 deterministic PRNG
 * Generates reproducible pseudo-random numbers 0-1 from seed.
 * @param {number} seed - 32-bit integer seed
 * @returns {function} PRNG function returning numbers [0, 1)
 */
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * OCEAN Big Five to PAD baseline mapping
 * Source: Mehrabian, A. (1996). Analysis of the Big-five Personality
 * Factors in Terms of the PAD Temperament Model.
 * Australian Journal of Psychology, 48(2), 86-92.
 *
 * Uses Set 1 regression coefficients (statistically significant
 * predictors only), converted from Emotional Stability to
 * Neuroticism (N = 100 - ES). Coefficient magnitudes as reported
 * by external consultant; directions verified against Mehrabian
 * abstract and secondary sources.
 *
 * Qualitative verification:
 *   Extraversion -> primarily dominant, secondarily pleasant
 *   Agreeableness -> pleasant, arousable, submissive
 *   Neuroticism -> unpleasant, arousable
 *
 * Variables absent from Pleasure (O, C) and Arousal (O, C, E)
 * were not statistically significant in Mehrabian original analysis.
 *
 * @param {Object} ocean - OCEAN scores (0-100 scale)
 * @returns {Object} Baseline PAD {P, A, D} (-1 to 1 scale)
 */
function oceanToBaselinePAD(ocean) {
  if (!ocean) {
    return { P: 0.0, A: 0.1, D: -0.2 };
  }
  
  const E = ocean.extraversion / 100;
  const A = ocean.agreeableness / 100;
  const N = ocean.neuroticism / 100;
  const O = ocean.openness / 100;
  
  return {
    P: (0.19 * E + 0.39 * A - 0.25 * N),
    A: (0.42 * A + 0.65 * N),
    D: (0.75 * E - 0.27 * A + 0.21 * O)
  };
}

/*
 * ============================================================================
 * Validation Helpers
 * ============================================================================
 */

function _validateRange(value, fieldName, min, max) {
  if (typeof value !== 'number' || value < min || value > max) {
    throw new Error(fieldName + ' must be a number between ' + min + ' and ' + max + ' (received: ' + value + ')');
  }
}

function _validateHexId(value, fieldName) {
  if (!value || typeof value !== 'string' || !value.startsWith('#')) {
    throw new Error(fieldName + ' is required and must start with # (received: ' + typeof value + ')');
  }
}

function _validateObjectType(type) {
  if (!ARCHETYPES[type]) {
    throw new Error('Invalid objectType: ' + type + '. Must be one of: ' + Object.keys(ARCHETYPES).join(', '));
  }
}

/*
 * ============================================================================
 * Research-Backed Helper Functions
 * ============================================================================
 * Sources:
 *   Luxford, Turkay, Frommel, Tobin, Mandryk, Formosa, Johnson (2022)
 *     Self-regulation mediates passion orientation and wellbeing outcomes
 *   Bonanno (2004, 2023)
 *     Four recovery trajectories; depressed-improved = caregiver relief
 *   Perez-Fuentes et al. (2023)
 *     Big Five as differential predictors of self-regulation
 * ============================================================================
 */

/**
 * Derive self-regulation capacity from OCEAN personality scores.
 *
 * Conscientiousness is the strongest positive predictor (r ~ 0.50),
 * Neuroticism is the strongest negative predictor (r ~ -0.37).
 * Extraversion and Openness show weaker positive associations.
 * Agreeableness shows marginal negative association.
 *
 * Source: Perez-Fuentes et al. (2023) BMC Psychology 11(1), 142.
 * Validated by: Luxford et al. (2022) - self-regulation mediates
 * the passion-wellbeing relationship in game contexts.
 *
 * Weights: proposed - if plausible calibration via collaboration with GridLab / Dr Daniel Johnson QUT
 *
 * @param {Object} ocean - OCEAN scores (0-100 scale)
 * @returns {number} Self-regulation capacity (0-100, >60 = high)
 */
function deriveSelfRegulation(ocean) {
  if (!ocean) {
    return 50;
  }

  const raw = (ocean.conscientiousness * 0.50)
            + (ocean.extraversion * 0.15)
            + (ocean.openness * 0.10)
            - (ocean.neuroticism * 0.35)
            - (ocean.agreeableness * 0.05);

  return Math.max(0, Math.min(100, raw + 35));
}

/**
 * Calculate source entity burden score.
 *
 * Models Bonanno (2004, 2023) caregiver relief mechanism:
 * High Neuroticism in source entity = emotional volatility burden
 * Low Agreeableness in source entity = interpersonal friction burden
 *
 * When burden is high, separation can trigger the depressed_improved
 * trajectory: initial distress followed by relief-based recovery.
 *
 * Source: Bonanno, G.A. et al. (2023) Nature Reviews Psychology 2(12).
 * Application: Johnson, Formosa et al. (2022) - unsatisfied needs
 * predict obsessive (compensatory) passion orientation.
 *
 * Weights: proposed - if plausible calibration via collaboration with GridLab / Dr Daniel Johnson QUT
 *
 * @param {Object} sourceOcean - Source entity OCEAN scores (0-100)
 * @returns {number} Source burden score (0-100, >65 = high burden)
 */
function calculateSourceBurden(sourceOcean) {
  if (!sourceOcean) {
    return 50;
  }

  const raw = (sourceOcean.neuroticism * 0.60)
            - (sourceOcean.agreeableness * 0.40)
            + 50;

  return Math.max(0, Math.min(100, raw));
}

/*
 * ============================================================================
 * FractureEngine Class
 * ============================================================================
 */

export class FractureEngine {
  constructor(configOverrides = {}) {
    this.config = Object.freeze({ ...FRACTURE_CONFIG, ...configOverrides });
    logger.info('FractureEngine initialized', { config: this.config });
  }

  /**
   * Compute fractured PAD state for B-Roll character birth.
   * Core trauma algorithm implementing structural dissociation theory.
   *
   * @param {Object} params
   * @param {number} params.sourceP - Source entity Pleasure (-1.0 to +1.0)
   * @param {number} params.sourceA - Source entity Arousal (-1.0 to +1.0)
   * @param {number} params.sourceD - Source entity Dominance (-1.0 to +1.0)
   * @param {number} params.attachmentStrength - 0.0 to 1.0
   * @param {string} params.objectType - One of 5 archetypes
   * @param {string} params.entityId - Hex ID (e.g., "#700001")
   * @param {string} params.objectId - Hex ID (e.g., "#700002")
   * @param {Object} [params.ocean] - Optional OCEAN scores for target
   * @returns {Object} Fracture result with PAD, severity, trajectory
   */
  computeFracture(params) {
    this._validateFractureParams(params);
    
    const {
      sourceP, sourceA, sourceD,
      attachmentStrength,
      objectType,
      entityId,
      objectId,
      ocean,
      sourceOcean
    } = params;

    const seedString = entityId + objectId + objectType;
    const seed = djb2(seedString);
    const prng = mulberry32(seed);
    
    const profile = ARCHETYPES[objectType];
    
    let severity = attachmentStrength * (1.0 - Math.abs(sourceP) * 0.5) * profile.traumaMultiplier;
    severity = Math.max(0, Math.min(1, severity));
    
    const severityFactor = 1 / (1 + Math.exp(
      -this.config.SEVERITY_STEEPNESS * (severity - this.config.SEVERITY_THRESHOLD)
    ));
    
    const variationP = (prng() - 0.5) * this.config.VARIATION_P;
    const variationA = (prng() - 0.5) * this.config.VARIATION_A;
    const variationD = (prng() - 0.5) * this.config.VARIATION_D;
    
    const pleasureDrop = (this.config.PLEASURE_DROP_BASE + sourceP) * 
                         attachmentStrength * profile.pMod;
    let fracturedP = sourceP - pleasureDrop * severityFactor + variationP;
    
    let arousalShift;
    if (sourceA > 0.5) {
      arousalShift = -this.config.OVERWHELM_AROUSAL_DROP * severityFactor;
    } else {
      arousalShift = this.config.AROUSAL_ACTIVATION * severityFactor;
    }
    let fracturedA = sourceA + arousalShift * profile.aMod + variationA;
    
    const dominanceDrop = this.config.DOMINANCE_DROP_BASE * 
                          attachmentStrength * profile.dMod;
    let fracturedD;
    let fightTriggered = false;
    
    if (sourceD > 0.3 && severity > 0.5 && prng() < this.config.FIGHT_CHANCE) {
      fracturedD = sourceD + this.config.FIGHT_DOMINANCE_BOOST * severityFactor + variationD;
      fightTriggered = true;
    } else {
      fracturedD = sourceD - dominanceDrop * severityFactor + variationD;
    }
    
    const fragmentation = severityFactor * this.config.FRAGMENTATION_FACTOR;
    fracturedP += (prng() - 0.5) * fragmentation;
    fracturedA += (prng() - 0.5) * fragmentation;
    fracturedD += (prng() - 0.5) * fragmentation;
    
    fracturedP = Math.max(-1, Math.min(1, fracturedP));
    fracturedA = Math.max(-1, Math.min(1, fracturedA));
    fracturedD = Math.max(-1, Math.min(1, fracturedD));
    
    const blendFactor = this.config.NEONATAL_BLEND_BASE + 
                        (1 - this.config.NEONATAL_BLEND_BASE) * severityFactor;
    
    const finalP = NEONATAL.P * (1 - blendFactor) + fracturedP * blendFactor;
    const finalA = NEONATAL.A * (1 - blendFactor) + fracturedA * blendFactor;
    const finalD = NEONATAL.D * (1 - blendFactor) + fracturedD * blendFactor;
    
    // --- Research-backed trajectory classification ---
    // Sources: Luxford et al. (2022), Formosa et al. (2022, 2024),
    // Johnson et al. (2022), Bonanno (2004, 2023)
    // All thresholds: proposed - if plausible calibration via collaboration with GridLab / Dr Daniel Johnson QUT

    const selfRegulation = deriveSelfRegulation(ocean);
    const sourceBurden = calculateSourceBurden(sourceOcean);
    const baselinePAD = oceanToBaselinePAD(ocean);

    let trajectory;
    let trajectoryRationale;
    let recoveryRate;

    // DEPRESSED_IMPROVED: High severity BUT separation relieves source burden
    // Mechanism: Bonanno (2023) caregiver relief / pre-event anxiety discharge
    // Application: Johnson et al. (2022) unsatisfied needs predict obsessive passion;
    // separation from high-burden source relieves that compensatory dynamic
    if (severityFactor > 0.7 && sourceBurden > 65 && ocean && ocean.conscientiousness > 50) {
      trajectory = TRAJECTORIES.DEPRESSED_IMPROVED;
      trajectoryRationale = 'High severity + high source burden + adequate conscientiousness = relief-based recovery';
      recoveryRate = 0.08 + (ocean.conscientiousness / 100) * 0.04;

    // CHRONIC: Low self-regulation + high neuroticism
    // Mechanism: Luxford et al. (2022) low self-regulation mediates poor wellbeing
    // Application: Formosa et al. (2024) maladaptive emotion regulation predicts chronic distress
    } else if (selfRegulation < 35 && ocean && ocean.neuroticism > 60) {
      trajectory = TRAJECTORIES.CHRONIC;
      trajectoryRationale = 'Low self-regulation + high neuroticism predicts persistent distress';
      recoveryRate = 0.02;

    // RESILIENT: Low severity OR high extraversion + strong self-regulation
    // Mechanism: Luxford et al. (2022) high self-regulation + harmonious passion = positive outcomes
    // Application: Bonanno (2004) minimal-impact resilience is the most common trajectory
    } else if (severityFactor < 0.3 || (ocean && ocean.extraversion > 65 && selfRegulation > 60)) {
      trajectory = TRAJECTORIES.RESILIENT;
      trajectoryRationale = 'Low severity or high extraversion with strong self-regulation = minimal impact';
      recoveryRate = 0.12;

    // RECOVERY: Gradual return to baseline (default path)
    // Mechanism: Formosa et al. (2022) adequate need satisfaction + harmonious engagement
    } else {
      trajectory = TRAJECTORIES.RECOVERY;
      trajectoryRationale = 'Moderate severity with mixed personality factors = gradual recovery';
      recoveryRate = ocean
        ? (0.04
          + (ocean.conscientiousness / 100) * 0.04
          + (ocean.extraversion / 100) * 0.02
          - (ocean.neuroticism / 100) * 0.05
          + (ocean.openness / 100) * 0.02)
        : 0.04;
    }
    
    const result = {
      P: Math.round(finalP * 1000) / 1000,
      A: Math.round(finalA * 1000) / 1000,
      D: Math.round(finalD * 1000) / 1000,
      severityFactor: Math.round(severityFactor * 1000) / 1000,
      severity: Math.round(severity * 1000) / 1000,
      trajectory,
      trajectoryRationale,
      recoveryRate: Math.round(recoveryRate * 1000) / 1000,
      selfRegulation: Math.round(selfRegulation * 100) / 100,
      sourceBurden: Math.round(sourceBurden * 100) / 100,
      fightTriggered,
      targetBaseline: {
        P: Math.round(baselinePAD.P * 1000) / 1000,
        A: Math.round(baselinePAD.A * 1000) / 1000,
        D: Math.round(baselinePAD.D * 1000) / 1000
      },
      seed,
      timestamp: new Date().toISOString()
    };
    
    logger.info('Fracture computed', {
      entityId,
      objectId,
      objectType,
      ...result
    });
    
    return result;
  }

  /**
   * Calculate recovery trajectory at given time point.
   * Implements Bonanno's exponential decay model toward baseline.
   *
   * @param {Object} fractureResult - Output from computeFracture()
   * @param {Object} ocean - OCEAN scores for recovery rate calculation
   * @param {number} hoursElapsed - Hours since birth
   * @returns {Object} Current PAD state and decay information
   */
  computeRecovery(fractureResult, ocean, hoursElapsed) {
    _validateRange(hoursElapsed, 'hoursElapsed', 0, 87600);
    
    const daysElapsed = hoursElapsed / 24;
    const { targetBaseline, recoveryRate, severityFactor, trajectory } = fractureResult;
    
    let decay;
    if (trajectory === TRAJECTORIES.CHRONIC) {
      decay = Math.exp(-recoveryRate * 0.3 * daysElapsed);
    } else if (trajectory === TRAJECTORIES.RESILIENT) {
      decay = Math.exp(-recoveryRate * 2.0 * daysElapsed);
    } else if (trajectory === TRAJECTORIES.DEPRESSED_IMPROVED) {
      // Bonanno (2023): Initial distress followed by relief-based rapid improvement
      // Delayed onset: first 2 days show chronic-like decay, then accelerates
      // proposed - if plausible calibration via collaboration with GridLab / Dr Daniel Johnson QUT
      const delayDays = 2.0;
      if (daysElapsed < delayDays) {
        decay = Math.exp(-recoveryRate * 0.3 * daysElapsed);
      } else {
        const adjustedDays = daysElapsed - delayDays;
        const delayedDecay = Math.exp(-recoveryRate * 0.3 * delayDays);
        decay = delayedDecay * Math.exp(-recoveryRate * 1.8 * adjustedDays);
      }
    } else {
      decay = Math.exp(-recoveryRate * daysElapsed);
    }
    
    const wobble = 0.05 * Math.sin(daysElapsed * 0.5) * decay;
    
    const currentP = targetBaseline.P + (fractureResult.P - targetBaseline.P) * decay + wobble;
    const currentA = targetBaseline.A + (fractureResult.A - targetBaseline.A) * decay + (wobble * 0.7);
    const currentD = targetBaseline.D + (fractureResult.D - targetBaseline.D) * decay + (wobble * 0.5);
    
    return {
      P: Math.round(Math.max(-1, Math.min(1, currentP)) * 1000) / 1000,
      A: Math.round(Math.max(-1, Math.min(1, currentA)) * 1000) / 1000,
      D: Math.round(Math.max(-1, Math.min(1, currentD)) * 1000) / 1000,
      decay: Math.round(decay * 1000) / 1000,
      hoursElapsed,
      trajectory
    };
  }

  /**
   * Apply Omiyage comfort shift to fractured state.
   * Models transitional object comfort (Winnicott, 1953).
   *
   * @param {Object} currentPAD - Current {P, A, D} state
   * @param {number} comfortLevel - 0.0 to 1.0 (gift quality/appropriateness)
   * @param {number} [durationHours=0.5] - Duration of comfort effect onset
   * @param {number} [elapsedHours=0] - Time since gift given
   * @returns {Object} Shifted PAD state
   */
  applyOmiyage(currentPAD, comfortLevel, durationHours = 0.5, elapsedHours = durationHours) {
    _validateRange(comfortLevel, 'comfortLevel', 0, 1);
    _validateRange(currentPAD.P, 'currentPAD.P', -1, 1);
    _validateRange(currentPAD.A, 'currentPAD.A', -1, 1);
    _validateRange(currentPAD.D, 'currentPAD.D', -1, 1);
    
    const progress = Math.min(1, elapsedHours / durationHours);
    
    const comfortShiftP = comfortLevel * 0.4 * progress;
    const comfortShiftA = -comfortLevel * 0.3 * progress;
    const comfortShiftD = comfortLevel * 0.2 * progress;
    
    return {
      P: Math.round(Math.max(-1, Math.min(1, currentPAD.P + comfortShiftP)) * 1000) / 1000,
      A: Math.round(Math.max(-1, Math.min(1, currentPAD.A + comfortShiftA)) * 1000) / 1000,
      D: Math.round(Math.max(-1, Math.min(1, currentPAD.D + comfortShiftD)) * 1000) / 1000,
      comfortApplied: progress >= 1,
      progress: Math.round(progress * 100) / 100
    };
  }

  _validateFractureParams(params) {
    _validateRange(params.sourceP, 'sourceP', -1, 1);
    _validateRange(params.sourceA, 'sourceA', -1, 1);
    _validateRange(params.sourceD, 'sourceD', -1, 1);
    _validateRange(params.attachmentStrength, 'attachmentStrength', 0, 1);
    _validateHexId(params.entityId, 'entityId');
    _validateHexId(params.objectId, 'objectId');
    _validateObjectType(params.objectType);
    if (params.sourceOcean && typeof params.sourceOcean === 'object') {
      const so = params.sourceOcean;
      if (so.neuroticism !== undefined) _validateRange(so.neuroticism, 'sourceOcean.neuroticism', 0, 100);
      if (so.agreeableness !== undefined) _validateRange(so.agreeableness, 'sourceOcean.agreeableness', 0, 100);
      if (so.conscientiousness !== undefined) _validateRange(so.conscientiousness, 'sourceOcean.conscientiousness', 0, 100);
      if (so.extraversion !== undefined) _validateRange(so.extraversion, 'sourceOcean.extraversion', 0, 100);
      if (so.openness !== undefined) _validateRange(so.openness, 'sourceOcean.openness', 0, 100);
    }
  }
}

export default FractureEngine;
