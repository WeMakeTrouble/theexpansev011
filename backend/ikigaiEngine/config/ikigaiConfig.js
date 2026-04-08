/**
 * ===========================================================================
 * ikigaiConfig.js — Frozen Configuration for Ikigai Engine
 * ===========================================================================
 *
 * PURPOSE:
 * Single source of truth for all Ikigai Engine thresholds, weights, and
 * derivation parameters. Every numeric value is tagged with an evidence
 * level to distinguish peer-reviewed findings from theoretical proposals.
 *
 * EVIDENCE LEVELS:
 *   'peer_reviewed'    — Direct citation from a specific finding with
 *                        reported effect sizes.
 *   'indirect_support' — Supported by related research but not directly
 *                        measured in the cited study's specific context.
 *   'proposed'         — Theoretically motivated but lacks direct empirical
 *                        validation. REQUIRES CALIBRATION via GRIDLab study.
 *   'theoretical'      — Derived from theoretical framework without any
 *                        direct empirical measurement. Highest priority
 *                        for calibration.
 *
 * STRUCTURE:
 *   MAPPING_VERSION     — Integer version for policy audit trail. Increment
 *                         when any weight or mapping changes.
 *   RECOMPUTE_INTERVAL  — Turns between full recomputations (proposed: 10).
 *   EVIDENCE            — Cold-start blending parameters. FULL_TRANSITION_SESSIONS
 *                         (30) and BLEND_SLOPE (5) control the sigmoid transition
 *                         from personality-baseline to interaction-derived scoring
 *                         as evidence accumulates per character (DD02 Q2).
 *   SDT_PRIORS          — Big Five domain → SDT dimension mappings with
 *                         baselines. Domain-level derivation confirmed as
 *                         more defensible than facet-level (Bratko et al.,
 *                         2022; Prentice, Jayawickreme & Fleeson, 2019).
 *   KAMIYA_DERIVATION   — Seven Kamiya needs with SDT + EarWig signal
 *                         sources and weights (Kamiya, 1966). Each need
 *                         maps to a combination of SDT dimensions, EarWig
 *                         per-turn signals, and behavioral baselines.
 *                         meaning_value has sdt: [] with weight 0.0 because
 *                         meaning maps primarily to eudaimonic/philosophical
 *                         signals rather than basic psychological needs
 *                         (consistent with Kamiya's distinction between
 *                         structural needs and existential purpose).
 *   OKINAWAN            — Four pillars, confidence thresholds, passion
 *                         quadrant boundary (Vallerand, 2003; Lafrenière
 *                         et al., 2009).
 *   MASLACH             — Burnout staging thresholds. STABLE_THRESHOLD (0.60)
 *                         and VULNERABLE_THRESHOLD (0.30) define the three-stage
 *                         model: stable (>= 0.60), vulnerable (0.30–0.60),
 *                         critical (< 0.30). Adapted from Maslach & Leiter
 *                         (2016) burnout continuum; specific numeric thresholds
 *                         are PROPOSED and require GRIDLab calibration.
 *   EMA                 — Exponential moving average parameters for
 *                         behavioral baseline tracking (Stange et al., 2018).
 *                         INITIAL_ALPHA (0.70) gives high learning rate with
 *                         few observations; STABLE_ALPHA (0.30) trusts history
 *                         after 30+ samples. Inflection points align with
 *                         CONFIDENCE_THRESHOLDS (MEDIUM at 10, HIGH at 30).
 *
 * CALIBRATION STATUS — ALL WEIGHTS REQUIRE GRIDLAB VALIDATION:
 *   This file is the primary target for the proposed validation study with
 *   Dr. Daniel Johnson (QUT GRIDLab). Every parameter tagged 'proposed' or
 *   'theoretical' needs empirical grounding before the engine can move from
 *   theoretical-only mode to production scoring.
 *
 *   Priority calibration targets:
 *   1. Okinawan pillar weights (contribution 0.30, harmony 0.30,
 *      reciprocity 0.25, sustainability 0.15)
 *      → GRIDLab: TSE teaching ratio vs. self-report correlation
 *   2. PASSION_QUADRANT_THRESHOLD (0.6)
 *      → Vallerand DMP operationalization validation in gaming context
 *   3. MASLACH staging thresholds (0.30, 0.60)
 *      → GRIDLab: DrClaude volatility correlation with burnout instruments
 *   4. SDT_PRIORS domain weights
 *      → Longitudinal Big Five → SDT need satisfaction tracking
 *   5. KAMIYA_DERIVATION signal weights
 *      → Cross-validation against self-report ikigai instruments
 *
 *   Intended release: MIT licence, open-source wellbeing detection tooling
 *   for the games research community. If validated, these weights become a
 *   reusable calibration dataset for any system implementing SDT-based
 *   character or player wellbeing tracking.
 *
 * RESEARCH CITATIONS:
 *   [1]  Ryan, R. M., & Deci, E. L. (2000). Self-determination theory and
 *        the facilitation of intrinsic motivation, social development, and
 *        well-being. American Psychologist, 55(1), 68–78.
 *   [2]  Kamiya, M. (1966). Ikigai ni tsuite [On ikigai]. Tokyo: Misuzu Shobo.
 *   [3]  Bratko, D., Butković, A., Vukasović Hlupić, T., & Pocrnić, D. (2022).
 *        Etiology of basic psychological needs and their association with
 *        personality: A twin study. Journal of Research in Personality, 97,
 *        104201.
 *   [4]  Prentice, M., Jayawickreme, E., & Fleeson, W. (2019). Integrating
 *        whole trait theory and self-determination theory. Journal of
 *        Personality, 87(1), 56–69.
 *   [5]  Sheldon, K. M., & Schüler, J. (2011). Wanting, having, and needing:
 *        Integrating motive disposition theory and self-determination theory.
 *        Journal of Personality and Social Psychology, 101(5), 1106–1123.
 *   [6]  Vallerand, R. J. (2003). On the psychology of passion: In search of
 *        what makes people's lives most worth living. Canadian Psychology,
 *        44(1), 1–13.
 *   [7]  Lafrenière, M.-A. K., Vallerand, R. J., Donahue, E. G., & Lavigne,
 *        G. L. (2009). On the costs and benefits of gaming: The role of
 *        passion. CyberPsychology & Behavior, 12(3), 285–290.
 *   [8]  Stange, J. P., Zulueta, J., Langenecker, S. A., Ryan, K. A.,
 *        Piscitello, A., Duffecy, J., McInnis, M. G., Nelson, P.,
 *        Ajilore, O., & Leow, A. (2018). Let your fingers do the talking:
 *        Passive typing instability predicts future mood outcomes. Bipolar
 *        Disorders, 20(3), 285–288.
 *   [9]  Tijerina, E. (2025). The measurement crisis: A hidden flaw in
 *        psychology. MetaResearch.
 *        [Confidence thresholds informed by measurement reliability concerns]
 *   [10] Johnson, D., Zhao, X., White, K. M., & Wickramasinghe, V. (2021).
 *        Need satisfaction, passion, empathy and helping behaviour in
 *        videogame play. Computers in Human Behavior, 122, 106817.
 *   [11] Johnson, D., et al. (2022). Need satisfaction and wellbeing before
 *        and during COVID-19. Computers in Human Behavior, 131, 107232.
 *   [12] Maslach, C., & Leiter, M. P. (2016). Understanding the burnout
 *        experience: Recent research and its implications for psychiatry.
 *        World Psychiatry, 15(2), 103–111.
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Configuration
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
export const IKIGAI_CONFIG = {
  MAPPING_VERSION: 1,

  RECOMPUTE_INTERVAL_TURNS: 10,

  EVIDENCE: {
    FULL_TRANSITION_SESSIONS: 30,
    BLEND_SLOPE: 5,
    COLD_START_FLOOR: 0.35
  },

  SDT_PRIORS: {
    autonomy_satisfaction: { 
      domains: { openness: 0.25, extraversion: 0.15 }, 
      baseline: 0.45,
      evidence: 'indirect_support'
    },
    autonomy_frustration: { 
      domains: { neuroticism: 0.30 }, 
      baseline: 0.20,
      evidence: 'peer_reviewed'
    },
    competence_satisfaction: { 
      domains: { conscientiousness: 0.25, openness: 0.10 }, 
      baseline: 0.30,
      evidence: 'peer_reviewed'
    },
    competence_frustration: { 
      domains: { neuroticism: 0.25, conscientiousness: -0.10 }, 
      baseline: 0.25,
      evidence: 'indirect_support'
    },
    relatedness_satisfaction: { 
      domains: { extraversion: 0.30, agreeableness: 0.25 }, 
      baseline: 0.30,
      evidence: 'peer_reviewed'
    },
    relatedness_frustration: { 
      domains: { neuroticism: 0.25, agreeableness: -0.15, extraversion: -0.10 }, 
      baseline: 0.25,
      evidence: 'indirect_support'
    }
  },

  KAMIYA_DERIVATION: {
    life_satisfaction: { 
      sdt: ['competence_satisfaction', 'relatedness_satisfaction'], 
      earwig: ['pleasure'], 
      weights: [0.35, 0.35, 0.30],
      evidence: 'theoretical'
    },
    change_growth: { 
      sdt: ['autonomy_satisfaction'], 
      earwig: ['arousal', 'surprisal'], 
      weights: [0.4, 0.3, 0.3],
      evidence: 'theoretical'
    },
    bright_future: { 
      sdt: ['autonomy_frustration'], 
      earwig: ['dominance', 'philosophical_frame'], 
      weights: [0.4, 0.3, 0.3],
      evidence: 'theoretical'
    },
    community_connection: { 
      sdt: ['relatedness_satisfaction'], 
      earwig: ['social_frame'], 
      baseline: ['reciprocal_proximity'], 
      weights: [0.4, 0.3, 0.3],
      evidence: 'theoretical'
    },
    freedom_choice: { 
      sdt: ['autonomy_satisfaction'], 
      earwig: ['dominance', 'low_volatility'], 
      weights: [0.5, 0.3, 0.2],
      evidence: 'theoretical'
    },
    self_actualisation: { 
      sdt: ['competence_satisfaction'], 
      earwig: ['qud_depth'], 
      baseline: ['belt_level'], 
      weights: [0.4, 0.3, 0.3],
      evidence: 'theoretical'
    },
    meaning_value: { 
      sdt: [], 
      earwig: ['philosophical_frame'], 
      baseline: ['teaching_ratio'], 
      weights: [0.0, 0.5, 0.5],
      evidence: 'theoretical'
    }
  },

  OKINAWAN: {
    PILLARS: {
      contribution:  { weight: 0.30, signals: ['teaching_ratio', 'breach_interventions'], evidence: 'proposed' },
      harmony:       { weight: 0.30, signal: 'passion_ratio',                          evidence: 'proposed' },
      reciprocity:   { weight: 0.25, signal: 'reciprocal_proximity',                   evidence: 'proposed' },
      sustainability:{ weight: 0.15, signal: 'session_regularity',                     evidence: 'proposed' }
    },
    CONFIDENCE_THRESHOLDS: {
      HIGH: { 
        teaching_cycles: 10, 
        proximity_samples_count: 20,
        sessions: 30, 
        passion_updates: 3,
        evidence: 'proposed'
      },
      MEDIUM: { 
        teaching_cycles: 3, 
        proximity_samples_count: 5,
        sessions: 10, 
        passion_exists: true,
        evidence: 'proposed'
      },
      MINIMUM: { 
        teaching_cycles: 1, 
        proximity_samples_count: 3,
        sessions: 5,
        evidence: 'proposed'
      }
    },
    PASSION_QUADRANT_THRESHOLD: 0.6
  },

  MASLACH: {
    STABLE_THRESHOLD: 0.60,
    VULNERABLE_THRESHOLD: 0.30,
    CRITICAL_CONSECUTIVE_NEGATIVE: 5,
    CRITICAL_VOLATILITY: 0.8,
    evidence: 'indirect_support'
  },

  EMA: {
    INITIAL_ALPHA: 0.70,
    STABLE_ALPHA:  0.30,
    DECAY_LAMBDA:  0.05,
    STALENESS_DAYS: 7,
    evidence: 'proposed'
  }
};
