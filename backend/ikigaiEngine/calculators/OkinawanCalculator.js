/**
 * ===========================================================================
 * OkinawanCalculator.js — Okinawan Layer: Community Contribution
 * ===========================================================================
 *
 * PURPOSE:
 * Computes the outward-facing layer of the Ikigai Engine. Models community
 * contribution as a first-class dimension of character wellbeing, grounded
 * in traditional Okinawan ikigai — where personal purpose and community
 * contribution are the same act.
 *
 * This is NOT the Western "Venn diagram" ikigai (Marc Winn, 2014 blog post).
 * The Western distortion placing wealth at the centre is explicitly excluded.
 *
 * FOUR PILLARS:
 *   1. Contribution (30%) — TSE teaching ratio + breach interventions.
 *      The strongest available eudaimonic proxy. Teaching another character
 *      is the closest behavioral signal to "my purpose feeds the community."
 *      Weight rationale: Johnson et al. (2021) found FEP-gamers showed
 *      significantly less helping behaviour in-game than controls.
 *
 *   2. Harmony (30%) — Passion ratio (harmonious / total passion).
 *      Derived from Vallerand's Dualistic Model of Passion (Vallerand, 2003;
 *      Lafrenière et al., 2009). Harmonious passion is freely chosen and
 *      integrated with life; obsessive passion is compulsive and conflicts
 *      with other domains.
 *
 *   3. Reciprocity (25%) — Reciprocal proximity EMA.
 *      Bidirectional relationship signal — not just "I am near others" but
 *      "others seek me out and I seek them."
 *
 *   4. Sustainability (15%) — Session regularity with time-decay.
 *      Regular engagement over time, not binge-then-vanish patterns.
 *      EMA with exponential decay (λ=0.05, half-life ~13.9 days).
 *
 * PASSION QUADRANT CLASSIFICATION:
 *   Harmonious and obsessive passion are independent axes (NOT bipolar):
 *     harmonious_healthy:     H >= 0.6, O < 0.6
 *     ambivalent_conflict:    H >= 0.6, O >= 0.6
 *     obsessive_extractive:   H < 0.6,  O >= 0.6  ← Huot-Lavoie pattern
 *     disengaged:             H < 0.6,  O < 0.6
 *   Threshold 0.6 is PROPOSED — requires calibration.
 *
 * CONFIDENCE ARCHITECTURE:
 *   The eudaimonic detection problem is real: linguistic signals predict
 *   hedonic wellbeing well but eudaimonic wellbeing poorly (Tijerina, 2025).
 *   The engine addresses this by refusing to classify when data is sparse:
 *
 *   High confidence:    teaching_cycles >= 10, proximity_samples >= 20,
 *                       sessions >= 30, passion_state exists. Quadrant: definitive.
 *   Medium confidence:  teaching_cycles >= 3, proximity_samples >= 5,
 *                       sessions >= 10. Quadrant: estimated.
 *   Low confidence:     Below medium thresholds. Quadrant: 'unknown'.
 *                       Returns insufficient_data: true. Narrative system
 *                       MUST ignore these scores rather than hallucinate
 *                       patterns from noise.
 *
 * HUOT-LAVOIE PATTERN:
 * Named after Huot-Lavoie et al. (2026) — gaming disorder in first episode
 * psychosis (N=284, 24-month follow-up). Patients showed partial Kamiya
 * Layer satisfaction (guild membership satisfying community_connection) but
 * hollow Okinawan Layer (zero real-world contribution, entirely extractive
 * engagement). SOFAS functional scores compounded negatively over 24 months.
 * A single-layer Kamiya engine would not catch this pattern. This is why
 * both layers exist.
 *
 * Johnson et al. (2022) confirmed the compensation mechanism: obsessive
 * passion for videogames was predicted by low need satisfaction in general
 * life — not by need satisfaction within the game. When real-world ikigai
 * sources are depleted, users develop obsessive rather than harmonious
 * engagement patterns. This is the Okinawan Layer as empirical finding.
 *
 * SUSTAINABILITY DECAY:
 * When a character has a last_session timestamp, sustainability is scaled
 * by exponential decay: score * exp(-λ * daysSince). This ensures that
 * characters who were engaged months ago but have since been abandoned
 * do not retain artificially high sustainability scores.
 *
 * DB QUERIES:
 * Four independent reads (behavioral baselines, TSE teaching cycles,
 * breach interventions, passion state existence) are executed in parallel
 * via Promise.all for latency reduction.
 *
 * DEPENDENCIES:
 *   - harmonicMean (helpers/harmonicMean.js)
 *   - safeFloat (backend/utils/safeFloat.js)
 *   - IKIGAI_CONFIG.OKINAWAN (config/ikigaiConfig.js)
 *
 * EXPORTS:
 *   OkinawanCalculator class (named export)
 *     compute(characterId, db, diagnostic)
 *       → { composite, confidence, quadrant, breakdown, passionDetails,
 *           insufficient_data }
 *
 * CALIBRATION STATUS:
 *   All pillar weights tagged 'proposed' in ikigaiConfig.js. Confidence
 *   thresholds (teaching cycles, proximity samples, sessions) are the
 *   highest-priority calibration targets — they determine when the engine
 *   is permitted to make claims about a character's wellbeing state.
 *
 * RESEARCH CITATIONS:
 *   [1]  Vallerand, R. J. (2003). On the psychology of passion: In search of
 *        what makes people's lives most worth living. Canadian Psychology,
 *        44(1), 1–13.
 *   [2]  Lafrenière, M.-A. K., Vallerand, R. J., Donahue, E. G., & Lavigne,
 *        G. L. (2009). On the costs and benefits of gaming: The role of
 *        passion. CyberPsychology & Behavior, 12(3), 285–290.
 *   [3]  Huot-Lavoie, M., et al. (2026). Gaming disorder in first episode
 *        psychosis: Prevalence and impact on symptomatology and functioning
 *        in a prospective cohort study. Schizophrenia Bulletin, 52(2),
 *        sbaf232.
 *   [4]  Johnson, D., Zhao, X., White, K. M., & Wickramasinghe, V. (2021).
 *        Need satisfaction, passion, empathy and helping behaviour in
 *        videogame play. Computers in Human Behavior, 122, 106817.
 *   [5]  Johnson, D., et al. (2022). Need satisfaction and wellbeing before
 *        and during COVID-19. Computers in Human Behavior, 131, 107232.
 *   [6]  Johannes, N., Nguyen, M. H., Vuorre, M., et al. (2022). Do people
 *        use video games to compensate for psychological needs?
 *   [7]  Tijerina, E. (2025). The measurement crisis: A hidden flaw in
 *        psychology. MetaResearch.
 *        [Confidence architecture informed by measurement reliability concerns]
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Okinawan Layer Calculator
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
import { safeFloat } from '../../utils/safeFloat.js';
import { harmonicMean } from '../helpers/harmonicMean.js';

export class OkinawanCalculator {
  constructor(config) {
    this.config = config;
  }

  async compute(characterId, db, diagnostic) {
    const stats = await this.gatherStats(characterId, db);
    const confidence = this.determineConfidence(stats);

    if (confidence === 'low') {
      return {
        composite: 0.001,
        confidence: 'low',
        quadrant: 'unknown',
        breakdown: {
          contribution: 0,
          harmony: 0.5,
          reciprocity: 0.5,
          sustainability: 0.5
        },
        passionDetails: null,
        insufficient_data: true
      };
    }

    const cfg = this.config.OKINAWAN.PILLARS;

    const contribution = (
      safeFloat(stats.teaching_ratio) * 0.7 +
      Math.min(stats.breach_interventions / 10, 1.0) * 0.3
    );

    const passion = await this.getPassionState(characterId, db);
    const harmony = safeFloat(passion.passion_ratio);

    const reciprocity = safeFloat(stats.reciprocal_proximity);
    const sustainability = this.computeSustainability(stats);

    const pillars = [
      Math.max(contribution, 0.001),
      Math.max(harmony, 0.001),
      Math.max(reciprocity, 0.001),
      Math.max(sustainability, 0.001)
    ];
    const weights = [
      cfg.contribution.weight,
      cfg.harmony.weight,
      cfg.reciprocity.weight,
      cfg.sustainability.weight
    ];

    const composite = harmonicMean(pillars, weights);

    return {
      composite,
      confidence,
      quadrant: this.classifyQuadrant(passion),
      breakdown: { contribution, harmony, reciprocity, sustainability },
      passionDetails: passion,
      insufficient_data: false
    };
  }

  async gatherStats(characterId, db) {
    const [baseline, tseResult, breachResult, passionExistsResult] = await Promise.all([
      db.query(
        `SELECT teaching_ratio_ema, reciprocal_proximity_ema, session_frequency_ema,
                inter_session_gap_ema, sample_count, last_session_at,
                reciprocal_proximity_samples
         FROM behavioral_baselines 
         WHERE character_id = $1`,
        [characterId]
      ),
      db.query(
        `SELECT COUNT(*) as count FROM tse_teacher_records tr JOIN tse_cycles tc ON tr.cycle_id = tc.cycle_id WHERE tc.character_id = $1`,
        [characterId]
      ),
      db.query(
        `SELECT COALESCE(breach_interventions_successful, 0) as count 
         FROM user_observational_depth WHERE character_id = $1`,
        [characterId]
      ),
      db.query(
        `SELECT EXISTS(SELECT 1 FROM passion_state WHERE character_id = $1) as exists`,
        [characterId]
      )
    ]);

    const b = baseline.rows[0] || {};

    return {
      teaching_ratio: b.teaching_ratio_ema || 0,
      teaching_cycles: parseInt(tseResult.rows[0]?.count || 0, 10),
      reciprocal_proximity: b.reciprocal_proximity_ema || 0.5,
      reciprocal_proximity_samples: b.reciprocal_proximity_samples || 0,
      session_count: b.sample_count || 0,
      last_session: b.last_session_at,
      breach_interventions: breachResult.rows[0]?.count || 0,
      session_frequency_ema: b.session_frequency_ema || 0.5,
      inter_session_gap_ema: b.inter_session_gap_ema || 0.5,
      passion_exists: passionExistsResult.rows[0]?.exists || false
    };
  }

  determineConfidence(stats) {
    const th = this.config.OKINAWAN.CONFIDENCE_THRESHOLDS;

    if (stats.teaching_cycles >= th.HIGH.teaching_cycles &&
        stats.reciprocal_proximity_samples >= th.HIGH.proximity_samples_count &&
        stats.session_count >= th.HIGH.sessions &&
        stats.passion_exists) {
      return 'high';
    }

    if (stats.teaching_cycles >= th.MEDIUM.teaching_cycles &&
        stats.reciprocal_proximity_samples >= th.MEDIUM.proximity_samples_count &&
        stats.session_count >= th.MEDIUM.sessions) {
      return 'medium';
    }

    return 'low';
  }

  computeSustainability(stats) {
    const regularity = stats.session_frequency_ema || 0.5;
    const gapScore = 1 - Math.min(stats.inter_session_gap_ema || 0.5, 1);

    if (stats.last_session) {
      const daysSince = (Date.now() - new Date(stats.last_session).getTime()) / (1000 * 60 * 60 * 24);
      const decay = Math.exp(-this.config.EMA.DECAY_LAMBDA * daysSince);
      return ((regularity + gapScore) / 2) * decay;
    }

    return (regularity + gapScore) / 2;
  }

  async getPassionState(characterId, db) {
    const result = await db.query(
      'SELECT harmonious_passion, obsessive_passion, passion_ratio FROM passion_state WHERE character_id = $1',
      [characterId]
    );
    return result.rows[0] || {
      harmonious_passion: 0.5,
      obsessive_passion: 0.5,
      passion_ratio: 0.5
    };
  }

  classifyQuadrant(passion) {
    const h = safeFloat(passion.harmonious_passion);
    const o = safeFloat(passion.obsessive_passion);
    const t = this.config.OKINAWAN.PASSION_QUADRANT_THRESHOLD;

    const hHigh = h >= t;
    const oHigh = o >= t;

    if (hHigh && !oHigh) return 'harmonious_healthy';
    if (hHigh && oHigh)  return 'ambivalent_conflict';
    if (!hHigh && oHigh) return 'obsessive_extractive';
    return 'disengaged';
  }
}
