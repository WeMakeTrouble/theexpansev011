/**
 * ===========================================================================
 * KamiyaCalculator.js — Kamiya Layer: Seven Existential Needs
 * ===========================================================================
 *
 * PURPOSE:
 * Computes the inward-facing layer of the Ikigai Engine. Derives scores
 * for Kamiya's seven existential needs from three signal sources:
 *   1. SDT satisfaction/frustration state (personality-derived)
 *   2. EarWig DiagnosticReport signals (per-turn, live)
 *   3. Behavioral baselines (EMA-smoothed, from DB)
 *
 * THEORETICAL FOUNDATION — KAMIYA (1966):
 * Kamiya Michiko's clinical framework identifies seven needs that an
 * individual requires to feel their life has value. These are inward-facing
 * structural needs, not community contribution metrics:
 *
 *   1. life_satisfaction     — General hedonic wellbeing
 *   2. change_growth         — Engagement with novelty and learning
 *   3. bright_future         — Hope and positive future orientation
 *   4. community_connection  — Belonging and being known by others
 *   5. freedom_choice        — Autonomy and sense of agency
 *   6. self_actualisation    — Becoming what one is capable of becoming
 *   7. meaning_value         — Sense that one's existence matters
 *
 * SDT DERIVATION:
 * Need scores are partially derived from SDT satisfaction/frustration
 * dimensions, which are themselves derived from Big Five personality
 * domains (see StateManager.js). The causal chain is:
 *   personality → SDT satisfaction/frustration → Kamiya needs
 *
 * Domain-level derivation (not facet-level) was chosen because:
 *   - Bratko et al. (2022) found substantial phenotypic overlap between
 *     Big Five domains and SDT needs at domain level in a twin study
 *     (N=668 Croatian twins).
 *   - Prentice et al. (2019) proposed Big Five traits as functional tools
 *     for SDT need satisfaction at the domain grain.
 *   - No peer-reviewed mapping matrix exists for all 30 NEO-PI-R facets
 *     to 6 SDT dimensions. Facet-level derivation would be overfitting
 *     to an architecture the data cannot support.
 *
 * EARWIG SIGNAL SOURCES (per-turn, live):
 *   - PAD pleasure  → life_satisfaction (hedonic)
 *   - PAD arousal   → change_growth (activation/novelty)
 *   - PAD dominance → bright_future, freedom_choice (agency)
 *   - intent frame: social → community_connection
 *   - intent frame: philosophical → bright_future, meaning_value
 *   - surprisal score → change_growth (exploration)
 *   - QUD depth → self_actualisation (depth-seeking, normalised /10,
 *     cap 1.0 — assumes EarWig qudDepth max ~10)
 *   - DrClaude volatility (inverse) → freedom_choice (stability)
 *
 * DIVERSITY INDEX (HHI):
 * Herfindahl-Hirschman Index applied to need score distribution.
 * Measures resilience — a character fulfilling needs through diverse
 * sources is more resilient than one relying on a single source.
 *   HHI = sum(share_i^2)
 *   diversity = 1 - HHI  (higher = more diverse = more resilient)
 *
 * BELT NORMALISATION:
 * Belt level is read from character_belt_progression and normalised to
 * 0.0–1.0 range (white=0.0, blue=0.25, purple=0.5, brown=0.75, black=1.0).
 * Used as a signal for self_actualisation — progression reflects
 * developmental achievement within the system.
 *
 * CLAMPING:
 * All need scores are clamped to [0.001, 1.0] before harmonic mean
 * computation. The 0.001 floor prevents division-by-zero in the harmonic
 * mean while preserving the suppression effect — a near-zero need still
 * drags the composite down severely.
 *
 * DB QUERIES:
 * Three independent reads (reciprocal proximity, teaching ratio, belt
 * level) are executed in parallel via Promise.all for latency reduction.
 *
 * DEPENDENCIES:
 *   - harmonicMean (helpers/harmonicMean.js)
 *   - safeFloat (backend/utils/safeFloat.js)
 *   - IKIGAI_CONFIG.KAMIYA_DERIVATION (config/ikigaiConfig.js)
 *
 * EXPORTS:
 *   KamiyaCalculator class (named export)
 *     compute(sdtState, diagnostic, characterId, db)
 *       → { composite, breakdown, diversity, rawNeeds }
 *
 * CALIBRATION STATUS:
 *   All need derivation weights are tagged 'theoretical' in ikigaiConfig.js.
 *   Validation requires cross-correlation with self-report ikigai instruments
 *   administered alongside in-engine behavioral data. Target collaborator:
 *   Dr. Daniel Johnson, QUT GRIDLab.
 *
 * RESEARCH CITATIONS:
 *   [1]  Kamiya, M. (1966). Ikigai ni tsuite [On ikigai]. Tokyo: Misuzu Shobo.
 *   [2]  Ryan, R. M., & Deci, E. L. (2000). Self-determination theory and
 *        the facilitation of intrinsic motivation, social development, and
 *        well-being. American Psychologist, 55(1), 68–78.
 *   [3]  Bratko, D., Butković, A., Vukasović Hlupić, T., & Pocrnić, D. (2022).
 *        Etiology of basic psychological needs and their association with
 *        personality: A twin study. Journal of Research in Personality, 97,
 *        104201.
 *   [4]  Prentice, M., Jayawickreme, E., & Fleeson, W. (2019). Integrating
 *        whole trait theory and self-determination theory. Journal of
 *        Personality, 87(1), 56–69.
 *   [5]  Johnson, D., Zhao, X., White, K. M., & Wickramasinghe, V. (2021).
 *        Need satisfaction, passion, empathy and helping behaviour in
 *        videogame play. Computers in Human Behavior, 122, 106817.
 *        [FEP-gamers scored significantly lower on SDT Competence satisfaction]
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Kamiya Layer Calculator
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
import { safeFloat } from '../../utils/safeFloat.js';
import { harmonicMean } from '../helpers/harmonicMean.js';

export class KamiyaCalculator {
  constructor(config) {
    this.config = config;
  }

  async compute(sdtState, diagnostic, characterId, db) {
    const needs = {};
    const cfg = this.config.KAMIYA_DERIVATION;

    const [proximity, teaching, beltLevel] = await Promise.all([
      this.getReciprocalProximity(characterId, db),
      this.getTeachingRatio(characterId, db),
      this.getBeltNormalized(characterId, db)
    ]);

    // Need 1: Life Satisfaction
    needs.life_satisfaction = (
      safeFloat(sdtState.competence_satisfaction)       * cfg.life_satisfaction.weights[0] +
      safeFloat(sdtState.relatedness_satisfaction)      * cfg.life_satisfaction.weights[1] +
      ((safeFloat(diagnostic.pad?.pleasure) + 1) / 2)   * cfg.life_satisfaction.weights[2]
    );

    // Need 2: Change and Growth
    needs.change_growth = (
      safeFloat(sdtState.autonomy_satisfaction)         * cfg.change_growth.weights[0] +
      ((safeFloat(diagnostic.pad?.arousal) + 1) / 2)    * cfg.change_growth.weights[1] +
      safeFloat(diagnostic.learning?.surprisalScore)    * cfg.change_growth.weights[2]
    );

    // Need 3: Bright Future
    const lowAutFrustration = 1 - safeFloat(sdtState.autonomy_frustration);
    needs.bright_future = (
      lowAutFrustration                                * cfg.bright_future.weights[0] +
      ((safeFloat(diagnostic.pad?.dominance) + 1) / 2) * cfg.bright_future.weights[1] +
      (diagnostic.intent?.frame === 'philosophical' ? 1.0 : 0.0) * cfg.bright_future.weights[2]
    );

    // Need 4: Community Connection
    needs.community_connection = (
      safeFloat(sdtState.relatedness_satisfaction)              * cfg.community_connection.weights[0] +
      (diagnostic.intent?.blendProbabilities?.social || 0)      * cfg.community_connection.weights[1] +
      safeFloat(proximity)                                      * cfg.community_connection.weights[2]
    );

    // Need 5: Freedom of Choice
    const lowVolatility = 1 - Math.min(safeFloat(diagnostic.drClaude?.volatility) || 0, 1);
    needs.freedom_choice = (
      safeFloat(sdtState.autonomy_satisfaction)                 * cfg.freedom_choice.weights[0] +
      ((safeFloat(diagnostic.pad?.dominance) + 1) / 2)          * cfg.freedom_choice.weights[1] +
      lowVolatility                                             * cfg.freedom_choice.weights[2]
    );

    // Need 6: Self-Actualisation
    const qudDepth = Math.min(safeFloat(diagnostic.csm?.qudDepth) / 10, 1.0);
    needs.self_actualisation = (
      safeFloat(sdtState.competence_satisfaction) * cfg.self_actualisation.weights[0] +
      qudDepth                                   * cfg.self_actualisation.weights[1] +
      beltLevel                                  * cfg.self_actualisation.weights[2]
    );

    // Need 7: Meaning & Value (sdt weight is 0.0 — meaning maps to
    // eudaimonic/philosophical signals, not basic psychological needs)
    needs.meaning_value = (
      (diagnostic.intent?.blendProbabilities?.philosophical || 0) * cfg.meaning_value.weights[1] +
      safeFloat(teaching)                                         * cfg.meaning_value.weights[2]
    );

    const clamped = Object.values(needs).map(v =>
      Math.max(0.001, Math.min(1.0, safeFloat(v)))
    );

    const diversity = this.computeDiversity(clamped);

    return {
      composite: harmonicMean(clamped),
      breakdown: needs,
      diversity,
      rawNeeds: clamped
    };
  }

  async getReciprocalProximity(characterId, db) {
    const result = await db.query(
      'SELECT reciprocal_proximity_ema FROM behavioral_baselines WHERE character_id = $1',
      [characterId]
    );
    return result.rows[0]?.reciprocal_proximity_ema ?? 0.5;
  }

  async getTeachingRatio(characterId, db) {
    const result = await db.query(
      'SELECT teaching_ratio_ema FROM behavioral_baselines WHERE character_id = $1',
      [characterId]
    );
    return result.rows[0]?.teaching_ratio_ema ?? 0.0;
  }

  async getBeltNormalized(characterId, db) {
    const result = await db.query(
      `SELECT current_belt FROM character_belt_progression WHERE character_id = $1`,
      [characterId]
    );
    const levels = ['white_belt', 'blue_belt', 'purple_belt', 'brown_belt', 'black_belt'];
    const belt = result.rows[0]?.current_belt;
    const idx = levels.indexOf(belt);
    return idx >= 0 ? idx / 4 : 0.0;
  }

  computeDiversity(needScores) {
    const total = needScores.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    const shares = needScores.map(n => n / total);
    const hhi = shares.reduce((sum, s) => sum + s * s, 0);
    return 1 - hhi;
  }
}
