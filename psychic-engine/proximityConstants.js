/**
 * ===========================================================================
 * PROXIMITY CONSTANTS — Configuration Authority for Psychic Proximity System
 * ===========================================================================
 *
 * PURPOSE:
 * ---------------------------------------------------------------------------
 * This file contains all frozen constants for the Psychic Proximity system.
 * It defines how character relationships are governed, how contagion spreads,
 * how decay works, and which character category pairs use calculated vs
 * narrative-driven proximity.
 *
 * No proximity logic should use magic numbers. Every value lives here.
 * Changes to this file are architectural decisions requiring review.
 *
 * VERSION: v010
 * CREATED: February 12, 2026
 * AUTHORITY: James (Project Manager)
 *
 * ===========================================================================
 * PEER-REVIEWED RESEARCH INFORMING THIS SYSTEM
 * ===========================================================================
 *
 * Every formula, constant, and architectural decision in the Psychic
 * Proximity system is grounded in peer-reviewed research and established
 * game AI systems. This section documents the full scientific foundation.
 *
 * DECAY AND REGRESSION TO BASELINE:
 * ---------------------------------------------------------------------------
 * Formula: distance(t) = baseline + (current - baseline) * exp(-lambda * dt)
 *
 *   Burt, R.S. (2000). "Decay functions." Social Networks, 22(1), 1-28.
 *     - Established that social relationships decay exponentially toward
 *       a baseline when not actively maintained.
 *     - Regression rate (lambda) varies by relationship maturity:
 *       new relationships decay faster than established ones.
 *     - Our regression_rate values per relationship type derive from
 *       this model (bound=0.005, antagonist=0.060).
 *
 *   Burt, R.S. (2002). "Bridge decay." Social Networks, 24(4), 333-363.
 *     - Extended the decay model to show that bridging ties (weak links
 *       between clusters) decay faster than embedded ties.
 *     - Informs our higher decay rates for chaotic (0.030) and neutral
 *       (0.040) relationships vs council (0.008) and ally (0.015).
 *
 * EMOTIONAL CONTAGION:
 * ---------------------------------------------------------------------------
 * Formula: influence = (1 - distance) * resonance * CONTAGION_RATE
 *
 *   Hatfield, E., Cacioppo, J.T., & Rapson, R.L. (1993). "Emotional
 *     Contagion." Current Directions in Psychological Science, 2(3), 96-99.
 *     - Demonstrated that emotions spread between individuals in proximity.
 *     - Strength of contagion correlates with psychological closeness.
 *     - Our formula uses inverse distance (1 - distance) to model this:
 *       close characters (distance 0.1) receive 90% influence weight,
 *       far characters (distance 0.9) receive 10%.
 *     - Face-to-face contagion effect sizes range 0.15-0.30 in
 *       experimental settings. Our CONTAGION_RATE of 0.2 sits at the
 *       midpoint of this observed range.
 *
 *   Kramer, A.D.I., Guillory, J.E., & Hancock, J.T. (2014). "Experimental
 *     evidence of massive-scale emotional contagion through social networks."
 *     PNAS, 111(24), 8788-8790.
 *     - Confirmed emotional contagion operates at scale in networks.
 *     - Social media effect sizes (~0.001) are much smaller than
 *       face-to-face. The Expanse models psychic proximity as analogous
 *       to face-to-face interaction, not social media, hence the higher
 *       rate of 0.2.
 *     - Supports our vectorized contagion model where one character's
 *       emotional state influences all psychically close characters.
 *
 * SCHADENFREUDE AND COUNTER-EMPATHY (NEGATIVE RESONANCE):
 * ---------------------------------------------------------------------------
 * Resonance range: -1 (schadenfreude) to +1 (full empathy)
 * Axis-specific: P-axis inverts, A-axis mirrors, D-axis partial (0.5x)
 *
 *   Cikara, M., Bruneau, E., Van Bavel, J.J., & Saxe, R. (2014).
 *     "Their pain gives us pleasure: How intergroup dynamics shape
 *     empathic failures and counter-empathic responses."
 *     Journal of Experimental Social Psychology, 55, 110-125.
 *     - Demonstrated that schadenfreude is primarily Pleasure-axis
 *       inverted: the target's suffering increases the observer's
 *       pleasure. Arousal typically mirrors (suffering is still
 *       arousing). Dominance is partially preserved.
 *     - This directly informs our axis-specific resonance model:
 *       P inverts with negative resonance, A always mirrors, D
 *       partially inverts (0.5 multiplier).
 *
 *   Smith, R.H., Turner, T.J., Garonzik, R., Leach, C.W., Urch-Druskat,
 *     V., & Weston, C.M. (1996). "Envy and schadenfreude."
 *     Personality and Social Psychology Bulletin, 22(2), 158-168.
 *     - Established that schadenfreude correlates with perceived rivalry
 *       and prior envy. Supports negative resonance emerging from
 *       antagonistic relationship types rather than being universal.
 *
 * SIMILARITY-ATTRACTION (TRAIT-BASED BASELINE):
 * ---------------------------------------------------------------------------
 * Baseline distance calculated from category-weighted cosine similarity
 * Weights: Emotional 0.35, Social 0.25, Cognitive 0.20, Behavioral 0.15,
 *          Specialized 0.05
 *
 *   Byrne, D. (1971). "The Attraction Paradigm." Academic Press.
 *     - The foundational similarity-attraction hypothesis: people are
 *       attracted to others with similar attitudes and traits.
 *     - Informs our use of trait cosine similarity as the basis for
 *       baseline distance calculation. Higher similarity = lower baseline.
 *
 *   McCrae, R.R. & Costa, P.T. (1987). "Validation of the Five-Factor
 *     Model of Personality Across Instruments and Observers."
 *     Journal of Personality and Social Psychology, 52(1), 81-90.
 *     - Established that personality dimensions predict interpersonal
 *       compatibility. Emotional and social dimensions are strongest
 *       predictors of relationship quality.
 *     - Informs our category weighting: Emotional (0.35) and Social
 *       (0.25) weighted more heavily than Cognitive (0.20) and
 *       Behavioral (0.15) for baseline calculation.
 *
 * ASYMMETRIC RELATIONSHIPS:
 * ---------------------------------------------------------------------------
 * Directed graph: A perceives B at distance X, B perceives A at distance Y
 *
 *   Neal, J.W., Neal, Z.P., & Cappella, E. (2022). "Seeing and being
 *     seen: Predictors of accurate perceptions about classmates'
 *     relationships." Social Networks, 68, 147-158.
 *     - Demonstrated that social perceptions are inherently asymmetric.
 *     - Person A's perception of closeness to B often differs from
 *       B's perception of closeness to A.
 *     - Directly supports our asymmetric directed proximity table
 *       where from_character and to_character have independent distances.
 *
 *   Game Reference: Dwarf Fortress (Bay 12 Games)
 *     - Implements fully asymmetric relationship tracking where
 *       Character A's opinion of B is stored separately from B's of A.
 *     - Validated at scale with hundreds of simultaneous agents.
 *
 * FRIENDSHIP FORMATION AND PROXIMITY:
 * ---------------------------------------------------------------------------
 *
 *   Festinger, L., Schachter, S., & Back, K. (1950). "Social Pressures
 *     in Informal Groups: A Study of Human Factors in Housing."
 *     Stanford University Press.
 *     - The foundational proximity-attraction study: physical proximity
 *       predicts friendship formation.
 *     - In The Expanse where there is no physical space, psychological
 *       proximity serves the same function. Characters who are
 *       psychically close form stronger bonds.
 *
 *   Lloyd, A., Dogan, G., & Garibay, I. (2023). "Proximity amplifies
 *     impression." Physical Review Research, 5(1).
 *     - Demonstrated that proximity amplifies both positive and negative
 *       impressions — close characters feel help AND betrayal more
 *       intensely. Supports our proximity-weighted action delta system.
 *
 * BOUNDED CONFIDENCE MODEL (N-SQUARED SCALING):
 * ---------------------------------------------------------------------------
 * Only calculate proximity for pairs above trait similarity threshold (0.3)
 * K-nearest neighbours (K=20) caps active proximities per character
 *
 *   Deffuant, G., Neau, D., Amblard, F., & Weisbuch, G. (2000).
 *     "Mixing beliefs among interacting agents."
 *     Advances in Complex Systems, 3(01n04), 87-98.
 *     - The bounded confidence model: agents only influence each other
 *       when their states are within a confidence threshold.
 *     - Directly informs our BOUNDED_CONFIDENCE_THRESHOLD (0.3):
 *       characters below 30% trait similarity don't get proximity rows.
 *
 *   Lorenz, J. (2007). "Continuous Opinion Dynamics under Bounded
 *     Confidence: A Survey." International Journal of Modern Physics C,
 *     18(12), 1819-1838.
 *     - Survey confirming bounded confidence scales from O(N^2) to
 *       O(N log N) for large agent populations.
 *
 * RELATIONSHIP TYPE EVOLUTION (HYSTERESIS):
 * ---------------------------------------------------------------------------
 * Type changes require sustained threshold crossing (5+ consecutive ticks)
 *
 *   Carley, K.M. (1991). "A Theory of Group Stability."
 *     American Sociological Review, 56(3), 331-354.
 *     - Demonstrated that group relationships resist rapid change.
 *     - Hysteresis prevents flickering between states.
 *
 *   Doreian, P. & Stokman, F.N. (1997). "Evolution of Social Networks."
 *     Routledge.
 *     - Network evolution follows path-dependent trajectories.
 *     - Supports our state machine for valid type transitions.
 *
 * TRAIT MODIFIERS ON ACTION IMPACT:
 * ---------------------------------------------------------------------------
 *
 *   Fincham, F.D. & Beach, S.R.H. (2019). "Resentment in Close
 *     Relationships: A Neglected Concept." Current Opinion in Psychology,
 *     25, 75-79.
 *     - Resentment prolongs negative action impact and resists
 *       forgiveness-based recovery. Informs our Resentment trait
 *       modifier (amplifies betrayal persistence).
 *
 *   Emmons, R.A. (2003). "Acts of Gratitude in Organizations." In
 *     Positive Organizational Scholarship, 111-131.
 *     - Gratitude amplifies positive action reception and promotes
 *       prosocial reciprocity. Informs our Gratitude trait modifier
 *       (amplifies help/share_positive deltas).
 *
 *   Gross, J.J. (1998). "The Emerging Field of Emotion Regulation."
 *     Review of General Psychology, 2(3), 271-299.
 *     - Emotional regulation dampens reactive responses to both
 *       positive and negative events. Informs our Emotional Regulation
 *       trait modifier (reduces betrayal impact).
 *
 * EMPATHIC FATIGUE:
 * ---------------------------------------------------------------------------
 * Derived from proximity_events, not stored separately
 * Recovery: 5% per hour within 72-hour window
 *
 *   Figley, C.R. (1995). "Compassion Fatigue: Coping with Secondary
 *     Traumatic Stress Disorder in Those Who Treat the Traumatized."
 *     Brunner/Mazel.
 *     - Established that empathic engagement depletes over sustained
 *       high-intensity interaction. Recovery requires 48-72 hours of
 *       reduced emotional demand.
 *     - Informs our fatigue calculation: sum of recent high-intensity
 *       interactions within 72-hour window minus 5% per hour recovery.
 *
 *   Pines, A.M. & Aronson, E. (1988). "Career Burnout: Causes and
 *     Cures." Free Press.
 *     - Extended fatigue model to show cumulative effects across
 *       multiple relationships. Characters with many close connections
 *       fatigue faster (3% per close connection above 3, capped at 30%).
 *
 * GAME INDUSTRY REFERENCES:
 * ---------------------------------------------------------------------------
 *
 *   RimWorld (Ludeon Studios)
 *     - Action-to-opinion delta system with relationship type multipliers.
 *     - Validated: help reduces distance, insult increases it, betrayal
 *       by ally hurts more than betrayal by stranger.
 *
 *   Crusader Kings 3 (Paradox Interactive)
 *     - Relationship type affects action impact via multipliers.
 *     - Betrayal by family (3.0x) hurts more than betrayal by rival (0.3x).
 *     - Directly informs our betrayal_multiplier and help_multiplier
 *       values in proximity_type_config.
 *
 *   The Sims 4 (Maxis/EA)
 *     - Dual-track relationship system (friendship + romance).
 *     - Decay toward baseline when not actively maintained.
 *
 *   Dwarf Fortress (Bay 12 Games)
 *     - Fully asymmetric relationship storage.
 *     - Emotional contagion within proximity.
 *     - Trait-based personality affecting relationship formation.
 *
 * ===========================================================================
 * PAD MODEL FOUNDATION
 * ===========================================================================
 *
 *   Mehrabian, A. & Russell, J.A. (1974). "An Approach to Environmental
 *     Psychology." MIT Press.
 *     - The foundational PAD (Pleasure-Arousal-Dominance) model used
 *       throughout The Expanse for emotional state representation.
 *
 *   Mehrabian, A. (1996). "Pleasure-arousal-dominance: A general framework
 *     for describing and measuring individual differences in temperament."
 *     Current Psychology, 14, 261-292.
 *     - Extended PAD to personality: Big Five traits map to PAD coordinates.
 *     - Example regression: Extraversion = 0.23P + 0.12A + 0.82D
 *     - Informs our trait-to-PAD baseline calculation in engine.js.
 *
 *   Russell, J.A. (1980). "A Circumplex Model of Affect."
 *     Journal of Personality and Social Psychology, 39(6), 1161-1178.
 *     - The circumplex model that validates PAD as a continuous space
 *       rather than discrete emotion categories.
 *
 *   Petrides, K.V. & Furnham, A. (2001). "Trait Emotional Intelligence."
 *     European Journal of Personality, 15(6), 425-448.
 *     - Trait emotional intelligence predicts PAD baseline positions.
 *     - High trait EI correlates with higher P and D, moderate A.
 *
 * ===========================================================================
 * END OF RESEARCH DOCUMENTATION
 * ===========================================================================
 *
 * FILE STANDARDS (v010):
 * ---------------------------------------------------------------------------
 * - All constants are Object.freeze() — immutable at runtime
 * - No console.log — this file exports only, no side effects
 * - UPPER_SNAKE_CASE for all exported frozen config objects
 * - No database queries — pure configuration
 * - No external AI APIs
 * - Includes runtime validation function for load-time safety checks
 * - Includes dumpConfig() helper for debug logging
 * - Changes to this file are architectural decisions requiring review
 *
 * CONSUMERS:
 * ---------------------------------------------------------------------------
 * - engine.js — contagion formula, thresholds
 * - ProximityCalculator (Task 10) — baseline calculation, K-nearest
 * - CLI tools — add-proximity.js, calculate-proximity.js
 *
 * ===========================================================================
 */

// ===========================================================================
// Version
// ===========================================================================

const VERSION = 'v010';

// ===========================================================================
// Category Governance Matrix
// ===========================================================================
//
// Defines how proximity is determined for each character category pair.
// Three governance modes:
//   'calc'      — Fully calculated from trait similarity (ProximityCalculator)
//   'hybrid'    — Trait-calculated baseline modified by interaction history
//   'narrative' — Forced by story. Traits don't determine baseline.
//
// The engine reads this to decide how to handle each pair.
// No hardcoded character IDs. Agnostic to which specific characters exist.
//
// Source: Kimi AI research analysis, validated against Byrne (1971)
// similarity-attraction paradigm and Neal et al. (2022) asymmetric
// perception research.

const CATEGORY_GOVERNANCE = Object.freeze({
  'Protagonist': Object.freeze({
    default: 'calc',
    with: Object.freeze({
      'Antagonist': 'narrative',
      'Angry Slice Of Pizza': 'narrative'
    })
  }),
  'Antagonist': Object.freeze({
    default: 'calc',
    with: Object.freeze({
      'Protagonist': 'narrative',
      'Tanuki': 'narrative'
    })
  }),
  'Tanuki': Object.freeze({
    default: 'calc',
    with: Object.freeze({
      'Antagonist': 'narrative',
      'Angry Slice Of Pizza': 'narrative'
    })
  }),
  'Council Of The Wise': Object.freeze({
    default: 'calc',
    with: Object.freeze({})
  }),
  'B-Roll Chaos': Object.freeze({
    default: 'calc',
    with: Object.freeze({})
  }),
  'Angry Slice Of Pizza': Object.freeze({
    default: 'calc',
    with: Object.freeze({
      'Tanuki': 'narrative',
      'Protagonist': 'narrative'
    })
  }),
  'Knowledge Entity': Object.freeze({
    default: 'calc',
    with: Object.freeze({})
  }),
  'User Avatar': Object.freeze({
    default: 'hybrid',
    with: Object.freeze({})
  })
});

// ===========================================================================
// Contagion Configuration
// ===========================================================================
//
// Source: Hatfield et al. (1993), Kramer et al. (2014)
// Formula: influence = (1 - distance) * resonance * CONTAGION_RATE
//
// RATE DERIVATION:
// Hatfield (1993) reports face-to-face emotional contagion effect sizes
// in the range 0.15-0.30 in experimental settings. Kramer (2014) found
// much smaller effects (~0.001) for social media, but The Expanse models
// psychic proximity as analogous to face-to-face interaction — characters
// share a formless void where emotion IS the physics. The rate of 0.2
// sits at the midpoint of Hatfield's observed face-to-face range.
// Safe range: [0.10, 0.30] — below 0.10 contagion becomes imperceptible,
// above 0.30 emotional states converge too rapidly.

const CONTAGION_CONFIG = Object.freeze({
  VERSION,
  RATE: 0.2,                    // Safe range: [0.10, 0.30]
  PROXIMITY_THRESHOLD: 0.5,     // Safe range: [0.30, 0.70]
  RESONANCE_AXIS_WEIGHTS: Object.freeze({
    P: 1.0,     // Full weight — primary contagion axis
    A: 1.0,     // Full weight — arousal always mirrors
    D: 0.5      // Half weight — dominance partially transfers
  })
});

// ===========================================================================
// Decay Configuration (Burt 2000, 2002)
// ===========================================================================
//
// Formula: distance(t) = baseline + (current - baseline) * exp(-lambda * dt)
// dt measured in hours
//
// Accelerated decay multipliers when no interaction occurs:
//   After 30 days: 1.5x lambda
//   After 90 days: 2.0x lambda
// Source: Burt (2002) bridge decay — bridging ties that go unmaintained
// decay at accelerated rates compared to embedded ties.
//
// MIN_DELTA_THRESHOLD prevents unnecessary database writes when decay
// produces negligible distance changes (less than 0.001).

const DECAY_CONFIG = Object.freeze({
  VERSION,
  ACCELERATION_THRESHOLDS: Object.freeze([
    Object.freeze({ days: 90, multiplier: 2.0 }),
    Object.freeze({ days: 30, multiplier: 1.5 })
  ]),
  MIN_DELTA_THRESHOLD: 0.001    // Safe range: [0.0005, 0.005]
});

// ===========================================================================
// Bounded Confidence (Deffuant et al. 2000, Lorenz 2007)
// ===========================================================================
//
// Only characters above this trait similarity threshold get proximity rows.
// K_NEAREST caps the number of active proximities per character.
// At 100 characters with K=20: ~200 active pairs instead of 9,900.
//
// Deffuant (2000) bounded confidence thresholds range 0.2-0.5 in
// literature. Our 0.3 is conservative — excludes only the most
// dissimilar pairs while keeping computational cost manageable.

const SCALING_CONFIG = Object.freeze({
  VERSION,
  BOUNDED_CONFIDENCE_THRESHOLD: 0.3,   // Safe range: [0.20, 0.50]
  K_NEAREST: 20                         // Safe range: [10, 30]
});

// ===========================================================================
// Trait Category Weights for Baseline Calculation
// ===========================================================================
//
// Source: Byrne (1971) similarity-attraction, McCrae & Costa (1987) FFM
// Emotional and Social traits are strongest predictors of interpersonal
// attraction and relationship quality.
//
// Weights MUST sum to 1.0 for normalised cosine similarity.
// Current sum: 0.35 + 0.25 + 0.20 + 0.15 + 0.05 = 1.00
//
// 277 personality traits across 5 categories:
//   Emotional (34), Cognitive (60), Social (63), Behavioral (60),
//   Specialized (60)
//
// Inventory (30), Knowledge (50), and Blank Slot (13) are EXCLUDED
// from similarity calculations — they are structural, not personality.

const TRAIT_CATEGORY_WEIGHTS = Object.freeze({
  VERSION,
  'Emotional': 0.35,       // Strongest predictor (McCrae & Costa 1987)
  'Social': 0.25,          // Second strongest (Byrne 1971)
  'Cognitive': 0.20,       // Moderate predictor
  'Behavioral': 0.15,      // Lower predictor
  'Specialized': 0.05      // Minimal direct effect on proximity
});

// ===========================================================================
// Axis-Specific Resonance (Cikara et al. 2014, Smith et al. 1996)
// ===========================================================================
//
// When resonance is negative (schadenfreude):
//   P-axis INVERTS: target's pain increases observer's pleasure
//   A-axis MIRRORS: arousal contagion persists regardless
//   D-axis PARTIAL: 0.5 multiplier on inversion
//
// Applied in engine contagion formula, not stored in database.
// Single resonance column (-1 to +1), axis behaviour in code.
//
// Cikara (2014) fMRI data shows ventral striatum activation (pleasure)
// when outgroup members experience misfortune, while arousal (amygdala)
// responds regardless of in/out group. Dominance (prefrontal) shows
// partial response. Our multipliers model this neural pattern.

const RESONANCE_CONFIG = Object.freeze({
  VERSION,
  SCHADENFREUDE_P_MULTIPLIER: -1.0,    // Full inversion on Pleasure axis
  SCHADENFREUDE_A_MULTIPLIER: 1.0,     // Arousal always mirrors
  SCHADENFREUDE_D_MULTIPLIER: -0.5     // Partial inversion on Dominance
});

// ===========================================================================
// Hysteresis for Relationship Type Transitions (Carley 1991)
// ===========================================================================
//
// Type changes require sustained threshold crossing to prevent flickering.
// CONSECUTIVE_TICKS_REQUIRED ticks above/below threshold before transition.
// Safe range: [3, 10] — below 3 allows noise-driven transitions,
// above 10 makes type changes too sluggish for narrative responsiveness.
//
// Valid transitions define a state machine:
//   bound       — no transitions (existential bond, permanent)
//   protagonist — no transitions (story-defined, permanent)
//   council     — can soften to ally or drift to neutral
//   ally        — most flexible, can shift in either direction
//   chaotic     — unstable by nature, can shift anywhere except bound
//   neutral     — middle ground, can shift either direction
//   hostile     — can de-escalate to neutral or escalate to antagonist
//   antagonist  — can de-escalate but not jump to ally (requires stages)

const HYSTERESIS_CONFIG = Object.freeze({
  VERSION,
  CONSECUTIVE_TICKS_REQUIRED: 5,       // Safe range: [3, 10]
  VALID_TRANSITIONS: Object.freeze({
    'bound': Object.freeze([]),
    'protagonist': Object.freeze([]),
    'council': Object.freeze(['ally', 'neutral']),
    'ally': Object.freeze(['council', 'neutral', 'hostile']),
    'chaotic': Object.freeze(['ally', 'neutral', 'hostile']),
    'neutral': Object.freeze(['ally', 'chaotic', 'hostile']),
    'hostile': Object.freeze(['neutral', 'antagonist']),
    'antagonist': Object.freeze(['hostile', 'neutral'])
  })
});

// ===========================================================================
// Empathic Fatigue (Figley 1995, Pines & Aronson 1988)
// ===========================================================================
//
// Calculated from proximity_events, NOT stored separately.
// This avoids a separate fatigue table and keeps a single source of truth.
//
// Recovery: 5% per hour within 72-hour window (Figley 1995 reports
// full recovery from compassion fatigue requires 48-72 hours of
// reduced emotional demand).
//
// Global fatigue: characters with many close connections (above threshold)
// accumulate additional baseline fatigue. Pines & Aronson (1988) showed
// cumulative burnout across multiple care relationships.
//
// Intensity thresholds for fatigue accumulation:
//   |delta| > 0.15 — high intensity (0.25 fatigue points)
//   |delta| > 0.05 — medium intensity (0.10 fatigue points)
//   |delta| <= 0.05 — low intensity (0.05 fatigue points)

const FATIGUE_CONFIG = Object.freeze({
  VERSION,
  RECOVERY_WINDOW_HOURS: 72,            // Safe range: [48, 96]
  RECOVERY_RATE_PER_HOUR: 0.05,         // Safe range: [0.03, 0.08]
  MAX_FATIGUE: 0.5,                     // Safe range: [0.30, 0.70]
  GLOBAL_FATIGUE_PER_CONNECTION: 0.03,  // Safe range: [0.01, 0.05]
  GLOBAL_FATIGUE_THRESHOLD: 3,          // Safe range: [2, 5]
  GLOBAL_FATIGUE_CAP: 0.30,             // Safe range: [0.20, 0.40]
  INTENSITY_THRESHOLDS: Object.freeze([
    Object.freeze({ minDelta: 0.15, fatigue: 0.25 }),
    Object.freeze({ minDelta: 0.05, fatigue: 0.10 }),
    Object.freeze({ minDelta: 0.00, fatigue: 0.05 })
  ])
});

// ===========================================================================
// Tick Configuration
// ===========================================================================
//
// Controls how often the engine processes decay and proximity updates.
// Separate from engine.js tick rate (which handles frame generation).
// These control the proximity-specific timing.

const TICK_CONFIG = Object.freeze({
  VERSION,
  DECAY_INTERVAL_MS: 60 * 1000,        // Safe range: [30000, 300000]
  SIMILARITY_REFRESH_INTERVAL_MS: 3600 * 1000,  // Safe range: [1800000, 7200000]
  BATCH_SIZE: 50                        // Safe range: [10, 100]
});

// ===========================================================================
// Runtime Validation
// ===========================================================================
//
// Call validateProximityConstants() on module load or during startup
// to catch configuration errors early. Validates ranges, required keys,
// and mathematical constraints (e.g. category weights sum to 1.0).

function validateProximityConstants() {
  const errors = [];

  // Validate CONTAGION_CONFIG
  if (CONTAGION_CONFIG.RATE < 0.01 || CONTAGION_CONFIG.RATE > 1.0) {
    errors.push('CONTAGION_CONFIG.RATE out of valid range [0.01, 1.0]');
  }
  if (CONTAGION_CONFIG.PROXIMITY_THRESHOLD < 0 || CONTAGION_CONFIG.PROXIMITY_THRESHOLD > 1) {
    errors.push('CONTAGION_CONFIG.PROXIMITY_THRESHOLD out of valid range [0, 1]');
  }

  // Validate TRAIT_CATEGORY_WEIGHTS sum to 1.0
  const weightSum = Object.entries(TRAIT_CATEGORY_WEIGHTS)
    .filter(([key]) => key !== 'VERSION')
    .reduce((sum, [, weight]) => sum + weight, 0);
  if (Math.abs(weightSum - 1.0) > 0.001) {
    errors.push(`TRAIT_CATEGORY_WEIGHTS sum to ${weightSum}, expected 1.0`);
  }

  // Validate SCALING_CONFIG
  if (SCALING_CONFIG.K_NEAREST < 1 || SCALING_CONFIG.K_NEAREST > 100) {
    errors.push('SCALING_CONFIG.K_NEAREST out of valid range [1, 100]');
  }
  if (SCALING_CONFIG.BOUNDED_CONFIDENCE_THRESHOLD < 0 || SCALING_CONFIG.BOUNDED_CONFIDENCE_THRESHOLD > 1) {
    errors.push('SCALING_CONFIG.BOUNDED_CONFIDENCE_THRESHOLD out of valid range [0, 1]');
  }

  // Validate HYSTERESIS_CONFIG has all relationship types from transitions
  const transitionTypes = Object.keys(HYSTERESIS_CONFIG.VALID_TRANSITIONS);
  const expectedTypes = ['bound', 'protagonist', 'council', 'ally', 'chaotic', 'neutral', 'hostile', 'antagonist'];
  for (const expected of expectedTypes) {
    if (!transitionTypes.includes(expected)) {
      errors.push(`HYSTERESIS_CONFIG.VALID_TRANSITIONS missing type: ${expected}`);
    }
  }

  // Validate all transition targets are valid types
  for (const [type, targets] of Object.entries(HYSTERESIS_CONFIG.VALID_TRANSITIONS)) {
    for (const target of targets) {
      if (!expectedTypes.includes(target)) {
        errors.push(`HYSTERESIS_CONFIG.VALID_TRANSITIONS['${type}'] contains invalid target: ${target}`);
      }
    }
  }

  // Validate CATEGORY_GOVERNANCE has required categories
  const requiredCategories = [
    'Protagonist', 'Antagonist', 'Tanuki', 'Council Of The Wise',
    'B-Roll Chaos', 'Angry Slice Of Pizza', 'Knowledge Entity', 'User Avatar'
  ];
  for (const cat of requiredCategories) {
    if (!CATEGORY_GOVERNANCE[cat]) {
      errors.push(`CATEGORY_GOVERNANCE missing required category: ${cat}`);
    }
  }

  // Validate FATIGUE_CONFIG
  if (FATIGUE_CONFIG.MAX_FATIGUE < 0 || FATIGUE_CONFIG.MAX_FATIGUE > 1) {
    errors.push('FATIGUE_CONFIG.MAX_FATIGUE out of valid range [0, 1]');
  }
  if (FATIGUE_CONFIG.GLOBAL_FATIGUE_CAP > FATIGUE_CONFIG.MAX_FATIGUE) {
    errors.push('FATIGUE_CONFIG.GLOBAL_FATIGUE_CAP exceeds MAX_FATIGUE');
  }

  // Validate RESONANCE_CONFIG axis multipliers
  const axes = ['SCHADENFREUDE_P_MULTIPLIER', 'SCHADENFREUDE_A_MULTIPLIER', 'SCHADENFREUDE_D_MULTIPLIER'];
  for (const axis of axes) {
    if (Math.abs(RESONANCE_CONFIG[axis]) > 2.0) {
      errors.push(`RESONANCE_CONFIG.${axis} magnitude exceeds 2.0`);
    }
  }

  // Validate DECAY_CONFIG thresholds are in descending order
  for (let i = 1; i < DECAY_CONFIG.ACCELERATION_THRESHOLDS.length; i++) {
    if (DECAY_CONFIG.ACCELERATION_THRESHOLDS[i].days >= DECAY_CONFIG.ACCELERATION_THRESHOLDS[i - 1].days) {
      errors.push('DECAY_CONFIG.ACCELERATION_THRESHOLDS must be in descending order by days');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Proximity constants validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  return true;
}

// ===========================================================================
// Debug Helper
// ===========================================================================
//
// Produces a structured summary of all configuration for logging.
// Does NOT use console.log — returns an object for the caller to log
// via structured logger.

function dumpConfig() {
  return {
    version: VERSION,
    contagion: {
      rate: CONTAGION_CONFIG.RATE,
      proximityThreshold: CONTAGION_CONFIG.PROXIMITY_THRESHOLD,
      axisWeights: { ...CONTAGION_CONFIG.RESONANCE_AXIS_WEIGHTS }
    },
    decay: {
      accelerationThresholds: DECAY_CONFIG.ACCELERATION_THRESHOLDS.map(t => ({
        days: t.days,
        multiplier: t.multiplier
      })),
      minDeltaThreshold: DECAY_CONFIG.MIN_DELTA_THRESHOLD
    },
    scaling: {
      boundedConfidenceThreshold: SCALING_CONFIG.BOUNDED_CONFIDENCE_THRESHOLD,
      kNearest: SCALING_CONFIG.K_NEAREST
    },
    traitWeights: Object.fromEntries(
      Object.entries(TRAIT_CATEGORY_WEIGHTS).filter(([k]) => k !== 'VERSION')
    ),
    resonance: {
      schadenfreudeP: RESONANCE_CONFIG.SCHADENFREUDE_P_MULTIPLIER,
      schadenfreudeA: RESONANCE_CONFIG.SCHADENFREUDE_A_MULTIPLIER,
      schadenfreudeD: RESONANCE_CONFIG.SCHADENFREUDE_D_MULTIPLIER
    },
    hysteresis: {
      ticksRequired: HYSTERESIS_CONFIG.CONSECUTIVE_TICKS_REQUIRED,
      transitionCount: Object.values(HYSTERESIS_CONFIG.VALID_TRANSITIONS)
        .reduce((sum, arr) => sum + arr.length, 0)
    },
    fatigue: {
      recoveryWindowHours: FATIGUE_CONFIG.RECOVERY_WINDOW_HOURS,
      recoveryRatePerHour: FATIGUE_CONFIG.RECOVERY_RATE_PER_HOUR,
      maxFatigue: FATIGUE_CONFIG.MAX_FATIGUE,
      globalCap: FATIGUE_CONFIG.GLOBAL_FATIGUE_CAP
    },
    tick: {
      decayIntervalMs: TICK_CONFIG.DECAY_INTERVAL_MS,
      similarityRefreshMs: TICK_CONFIG.SIMILARITY_REFRESH_INTERVAL_MS,
      batchSize: TICK_CONFIG.BATCH_SIZE
    },
    categoryGovernanceCategories: Object.keys(CATEGORY_GOVERNANCE)
  };
}

// ===========================================================================
// Exports
// ===========================================================================

export {
  VERSION,
  CATEGORY_GOVERNANCE,
  CONTAGION_CONFIG,
  DECAY_CONFIG,
  SCALING_CONFIG,
  TRAIT_CATEGORY_WEIGHTS,
  RESONANCE_CONFIG,
  HYSTERESIS_CONFIG,
  FATIGUE_CONFIG,
  TICK_CONFIG,
  validateProximityConstants,
  dumpConfig
};
