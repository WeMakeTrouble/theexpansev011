/**
 * ===========================================================================
 * IkigaiEngine.js — Core Orchestrator for Character Wellbeing Computation
 * ===========================================================================
 *
 * PURPOSE:
 * Central entry point for the Ikigai Engine — a deterministic, dual-layer
 * wellbeing computation system that tracks character "soul health" via
 * Self-Determination Theory (SDT) and Okinawan community contribution
 * metrics. Hooks into the BrainOrchestrator as a parallel accumulator
 * (identical pattern to the verified WWDD Engine).
 *
 * WHAT THIS ENGINE DOES:
 * Prevents "Huot-Lavoie Pattern" detection failures — where characters
 * appear socially connected (high Kamiya Layer) but are actually in
 * compulsive, non-contributive states (hollow Okinawan Layer). The
 * harmonic mean composite 2ko/(k+o) ensures a high score on one layer
 * cannot mask a hollow score on the other. This is the engine's primary
 * design rationale (Johannes et al., 2022).
 *
 * DUAL-LAYER ARCHITECTURE:
 *   Layer 1 — Kamiya (inward, structural):
 *     Tracks seven existential needs per character (Kamiya, 1966).
 *     Scores derived from SDT satisfaction/frustration states via
 *     personality-to-SDT mapping (Bratko et al., 2022).
 *     Composite: weighted harmonic mean of all seven needs.
 *
 *   Layer 2 — Okinawan (outward, contributory):
 *     Models community contribution as a first-class dimension.
 *     Four pillars: Contribution (30%), Harmony (30%), Reciprocity (25%),
 *     Sustainability (15%). Passion classified via Vallerand's Dualistic
 *     Model (Lafrenière et al., 2009).
 *     Composite: weighted harmonic mean of four pillars.
 *
 *   Integration: harmonic mean of the two layer composites.
 *
 * INTEGRATION PATTERN:
 *   Non-blocking parallel accumulator above BrainOrchestrator pipeline.
 *   accumulate() reads the EarWig DiagnosticReport each turn and returns
 *   immediately with cached state + lightweight turn signals. Full
 *   recomputation fires every N turns (configurable) or on trigger events
 *   (breach, mutai, belt progression). Heavy computation and DB writes
 *   are deferred and non-blocking via fire-and-forget Promise.
 *   Target overhead: <5ms on main pipeline.
 *
 * MASLACH STAGING:
 *   stable:     composite >= 0.60
 *   vulnerable: composite 0.30–0.60
 *   critical:   composite < 0.30 OR (consecutiveNegativeTurns > 5
 *               AND volatility > 0.8)
 *   All thresholds are PROPOSED — requires calibration via GRIDLab
 *   validation study (see CALIBRATION STATUS below).
 *
 * SOCKET EVENT:
 *   Emits 'ikigai:update' via Socket.io on significant state changes
 *   (stability shift, quadrant change, critical alert). Frontend
 *   displacement effects trigger on receipt.
 *
 * DERIVATION HASH:
 *   djb2 hash of the full computation inputs (SDT state, Kamiya breakdown,
 *   Okinawan breakdown). Used for idempotency — if inputs haven't changed,
 *   the UPSERT is a no-op. Prevents redundant DB writes.
 *
 * DEPENDENCIES:
 *   - KamiyaCalculator (calculators/KamiyaCalculator.js)
 *   - OkinawanCalculator (calculators/OkinawanCalculator.js)
 *   - StateManager (state/StateManager.js)
 *   - BehavioralBaselineManager (state/BehavioralBaselineManager.js)
 *   - IKIGAI_CONFIG (config/ikigaiConfig.js)
 *   - safeFloat (backend/utils/safeFloat.js)
 *   - createModuleLogger (backend/utils/logger.js)
 *
 * EXPORTS:
 *   IkigaiEngine class (named export)
 *     accumulate(diagnosticReport, characterId)
 *       → { overall_ikigai, stability_flag, okinawan_confidence,
 *           quadrant, turnBasedSignal, unhandledAlerts }
 *     computeTestOnly(testInput)
 *       → deterministic test output (no DB writes, no alerts)
 *
 * CALIBRATION STATUS — PROPOSED (REQUIRES GRIDLAB VALIDATION):
 *   This engine is intended to be released under MIT licence as open-source
 *   wellbeing detection tooling for the games research community. All numeric
 *   weights and thresholds are currently theoretical. The following parameters
 *   require empirical validation before production deployment:
 *
 *   - RECOMPUTE_INTERVAL_TURNS (currently 10)
 *   - MASLACH staging thresholds (0.30, 0.60)
 *   - MASLACH volatility/consecutive negative turn thresholds
 *   - All Kamiya need derivation weights
 *   - All Okinawan pillar weights
 *   - Passion quadrant threshold (0.6)
 *   - EMA decay parameters
 *   - Confidence tier thresholds
 *
 *   Validation study design: BiAffect methodology (personal baseline
 *   principle, Stange et al., 2018) with longitudinal SDT measurement
 *   (Johnson et al., 2021, 2022).
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
 *   [4]  Johannes, N., Nguyen, M. H., Vuorre, M., et al. (2022). Do people
 *        use video games to compensate for psychological needs?
 *        [Self-determination theory approach].
 *   [5]  Huot-Lavoie, M., et al. (2026). Gaming disorder in first episode
 *        psychosis: Prevalence and impact on symptomatology and functioning
 *        in a prospective cohort study. Schizophrenia Bulletin, 52(2),
 *        sbaf232.
 *   [6]  Stange, J. P., Zulueta, J., Langenecker, S. A., Ryan, K. A.,
 *        Piscitello, A., Duffecy, J., McInnis, M. G., Nelson, P.,
 *        Ajilore, O., & Leow, A. (2018). Let your fingers do the talking:
 *        Passive typing instability predicts future mood outcomes. Bipolar
 *        Disorders, 20(3), 285–288. [BiAffect personal baseline methodology]
 *   [7]  Johnson, D., Zhao, X., White, K. M., & Wickramasinghe, V. (2021).
 *        Need satisfaction, passion, empathy and helping behaviour in
 *        videogame play. Computers in Human Behavior, 122, 106817.
 *   [8]  Johnson, D., et al. (2022). Need satisfaction and wellbeing before
 *        and during COVID-19. Computers in Human Behavior, 131, 107232.
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Core Orchestrator
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
import { createModuleLogger } from '../utils/logger.js';
import { safeFloat } from '../utils/safeFloat.js';
import { IKIGAI_CONFIG } from './config/ikigaiConfig.js';
import { KamiyaCalculator } from './calculators/KamiyaCalculator.js';
import { OkinawanCalculator } from './calculators/OkinawanCalculator.js';
import { StateManager } from './state/StateManager.js';
import { BehavioralBaselineManager } from './state/BehavioralBaselineManager.js';

const logger = createModuleLogger('ikigai-engine');

export class IkigaiEngine {
  constructor(db, options = {}) {
    this.db = db;
    this.turnCounters = new Map();
    this.emaQueues = new Map();

    this.config = { ...IKIGAI_CONFIG, ...options };

    this.kamiyaCalc = new KamiyaCalculator(this.config);
    this.okinawanCalc = new OkinawanCalculator(this.config);
    this.stateManager = new StateManager(db, this.config);
    this.baselineManager = new BehavioralBaselineManager(db, this.emaQueues);

    this.metrics = {
      recomputeCount: 0,
      recomputeErrorCount: 0
    };
  }

  async accumulate(diagnosticReport, characterId) {
    if (diagnosticReport.isRewatch || diagnosticReport.context?.isRewatch) {
      logger.debug({ characterId }, 'Skipping rewatch session for ikigai');
      const cached = await this.stateManager.getCachedSnapshot(characterId);
      return {
        ...cached,
        skipped: true,
        unhandledAlerts: [],
        turnBasedSignal: this.computeTurnSignal(diagnosticReport)
      };
    }

    const turnCount = this.incrementTurnCounter(characterId);
    this.baselineManager.accumulateTurn(characterId, diagnosticReport);

    const shouldCompute = this.checkTriggers(turnCount, diagnosticReport);

    if (shouldCompute) {
      this.computeAndPersist(characterId, diagnosticReport).catch(err => {
        this.metrics.recomputeErrorCount++;
        logger.error({ err, characterId }, 'Ikigai computation failed');
      });
    }

    const cached = await this.stateManager.getCachedSnapshot(characterId);
    const unhandledAlerts = await this.stateManager.getUnhandledAlerts(characterId);

    return {
      ...cached,
      unhandledAlerts,
      turnBasedSignal: this.computeTurnSignal(diagnosticReport)
    };
  }

  computeTurnSignal(diagnostic) {
    return {
      hedonic_now: (safeFloat(diagnostic.pad?.pleasure) + 1) / 2,
      autonomy_now: (safeFloat(diagnostic.pad?.dominance) + 1) / 2,
      social_now: diagnostic.intent?.blendProbabilities?.social || 0,
      teaching_now: diagnostic.tse?.isTeachingTurn ? 1 : 0
    };
  }

  incrementTurnCounter(characterId) {
    const current = this.turnCounters.get(characterId) || 0;
    const next = current + 1;
    this.turnCounters.set(characterId, next);
    return next;
  }

  checkTriggers(turnCount, diagnostic) {
    if (turnCount % this.config.RECOMPUTE_INTERVAL_TURNS === 0) return true;
    if (diagnostic.triggerType === 'breach_event') return true;
    if (diagnostic.triggerType === 'mutai_event') return true;
    if (diagnostic.triggerType === 'belt_progression') return true;
    return false;
  }

  async computeAndPersist(characterId, diagnostic) {
    const start = Date.now();
    this.metrics.recomputeCount++;

    await this.baselineManager.flushEMAUpdate(characterId, true);

    const sdtState = await this.stateManager.getOrComputeSDT(characterId);
    const kamiya = await this.kamiyaCalc.compute(sdtState, diagnostic, characterId, this.db);
    const okinawan = await this.okinawanCalc.compute(characterId, this.db, diagnostic);

    let okScore = okinawan.composite;
    if (okinawan.confidence === 'low') {
      okScore = 0.001;
    }

    const overall = this.computeOverallIkigai(kamiya.composite, okScore);
    const stability = this.determineMaslachStage(overall, diagnostic, okinawan.confidence);

    await this.stateManager.saveIkigaiState({
      characterId,
      overallIkigai: overall,
      diversityIndex: kamiya.diversity,
      stabilityFlag: stability.stage,
      okinawanConfidence: okinawan.confidence,
      kamiyaBreakdown: kamiya.breakdown,
      okinawanBreakdown: okinawan.breakdown,
      derivationHash: this.computeDerivationHash(sdtState, kamiya, okinawan)
    });

    // Fix 3 (April 2nd review): Skip alerts when Okinawan confidence is low —
    // firing alerts on insufficient data violates Tijerina (2025) measurement reliability
    if (okinawan.confidence !== 'low' &&
        (stability.stage === 'critical' || okinawan.quadrant === 'obsessive_extractive')) {
      await this.stateManager.createIkigaiAlert(characterId, stability, okinawan);
    }

    this.emitUpdate(characterId, {
      overall,
      stability: stability.stage,
      okinawanConfidence: okinawan.confidence,
      quadrant: okinawan.quadrant
    });

    const duration = Date.now() - start;
    logger.debug({ characterId, duration }, 'Ikigai recompute complete');
  }

  computeOverallIkigai(kamiyaScore, okinawanScore) {
    const k = Math.max(safeFloat(kamiyaScore), 0.001);
    const o = Math.max(safeFloat(okinawanScore), 0.001);
    return (2 * k * o) / (k + o);
  }

  determineMaslachStage(composite, diagnostic, okinawanConfidence) {
    const cfg = this.config.MASLACH;

    if (
      composite < cfg.VULNERABLE_THRESHOLD ||
      (diagnostic.drClaude?.consecutiveNegativeTurns > cfg.CRITICAL_CONSECUTIVE_NEGATIVE &&
       diagnostic.drClaude?.volatility > cfg.CRITICAL_VOLATILITY)
    ) {
      return { stage: 'critical', confidence: okinawanConfidence };
    }

    if (composite < cfg.STABLE_THRESHOLD) {
      return { stage: 'vulnerable', confidence: okinawanConfidence };
    }

    return { stage: 'stable', confidence: okinawanConfidence };
  }

  computeDerivationHash(sdt, kamiya, okinawan) {
    let hash = 5381;
    const data = JSON.stringify({ sdt, k: kamiya.breakdown, o: okinawan.breakdown });
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) + hash) + data.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }

  emitUpdate(characterId, payload) {
    if (global.io) {
      global.io.emit('ikigai:update', {
        characterId,
        ...payload,
        timestamp: new Date().toISOString()
      });
    }
  }
  async computeTestOnly(testInput) {
    const characterId = testInput.characterId || '#700005';

    const sdtState = await this.stateManager.getOrComputeSDT(characterId);
    const kamiya = await this.kamiyaCalc.compute(sdtState, testInput.diagnostic || {}, characterId, this.db);
    const okinawan = await this.okinawanCalc.compute(characterId, this.db, testInput.diagnostic || {});

    let okScore = okinawan.composite;
    if (okinawan.confidence === 'low') {
      okScore = 0.001;
    }

    const overall = this.computeOverallIkigai(kamiya.composite, okScore);

    return {
      overall,
      kamiya: {
        composite: kamiya.composite,
        diversity: kamiya.diversity
      },
      okinawan: {
        composite: okinawan.composite,
        confidence: okinawan.confidence,
        quadrant: okinawan.quadrant,
        insufficient_data: okinawan.confidence === 'low'
      },
      stability: { stage: 'stable' }
    };
  }
}
