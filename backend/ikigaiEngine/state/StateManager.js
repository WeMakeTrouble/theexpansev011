/**
 * ===========================================================================
 * StateManager.js — SDT Derivation, State Persistence, and Alert System
 * ===========================================================================
 *
 * PURPOSE:
 * Manages the full state lifecycle for the Ikigai Engine:
 *   1. SDT Derivation — personality → SDT satisfaction/frustration
 *   2. State Persistence — ikigai_state UPSERT with derivation hash
 *   3. Alert Creation — ikigai_alerts for narrative integration
 *   4. Cache Management — in-memory Map for per-turn reads
 *
 * SDT DERIVATION (computeSDTFromPersonality):
 * Derives Self-Determination Theory satisfaction/frustration scores from
 * Big Five personality domains. Two data sources in priority order:
 *   Primary: character_personality table (pre-aggregated domain scores,
 *            already normalised 0–1)
 *   Fallback: character_facet_scores table (tall EAV, scores 0–100,
 *             aggregated via GROUP BY domain with AVG(score)/100.0)
 *
 * The mapping uses SDT_PRIORS from ikigaiConfig.js:
 *   Neuroticism → autonomy_frustration, competence_frustration,
 *                 relatedness_frustration
 *   Extraversion → autonomy_satisfaction, relatedness_satisfaction
 *   Openness → autonomy_satisfaction, competence_satisfaction
 *   Agreeableness → relatedness_satisfaction
 *   Conscientiousness → competence_satisfaction
 *
 * Domain-level derivation chosen over facet-level because:
 *   - Bratko et al. (2022): phenotypic overlap confirmed at domain level
 *     in a twin study (N=668 Croatian twins)
 *   - Prentice et al. (2019): Big Five traits function as tools for SDT
 *     need satisfaction at the domain grain
 *   - No consolidated peer-reviewed mapping exists for all 30 NEO-PI-R
 *     facets to 6 SDT dimensions
 *
 * DERIVATION HASH AND IDEMPOTENCY:
 * A hash of domain scores is computed and stored as
 * derived_from_personality_hash. The UPSERT uses ON CONFLICT (character_id)
 * DO NOTHING — if the personality data hasn't changed, no new SDT row is
 * written. This prevents redundant recomputation and provides a determinism
 * audit trail.
 *
 * POLICY LOGGING:
 * Every SDT derivation writes to ikigai_policy_log with mapping_version
 * and sdt_prior_hash. This allows retrospective analysis if mapping
 * weights are updated after GRIDLab validation — all historical derivations
 * can be traced to their weight version.
 *
 * STATE PERSISTENCE (saveIkigaiState):
 * Uses UPSERT (INSERT ... ON CONFLICT DO UPDATE) on ikigai_state with
 * character_id as conflict target. Stores the full computation breakdown
 * in metadata JSONB (kamiya breakdown, okinawan breakdown, derivation hash,
 * insufficient_data flag). The cache Map is updated after every write to
 * ensure subsequent per-turn reads return fresh data.
 *
 * ALERT SYSTEM:
 * Creates ikigai_alerts when critical conditions are detected:
 *   - maslach_critical: Maslach stage is 'critical' (severity: critical)
 *   - obsessive_extractive: Huot-Lavoie pattern detected (severity: warning)
 *   - ikigai_collapse: Disengaged quadrant + vulnerable stage (severity: warning)
 *
 * Alerts are de-duplicated — if an unhandled alert of the same type already
 * exists for the character, no new alert is created. The BrainOrchestrator
 * reads unhandled alerts each turn via getUnhandledAlerts(). Narrative beats
 * call markAlertsHandled() post-trigger to prevent spam.
 *
 * DEPENDENCIES:
 *   - generateHexId (backend/utils/hexIdGenerator.js)
 *   - safeFloat (backend/utils/safeFloat.js)
 *   - createModuleLogger (backend/utils/logger.js)
 *
 * DB TABLES (read/write):
 *   - character_sdt_state (write: SDT derivation, ON CONFLICT DO NOTHING)
 *   - character_personality (read: domain scores, primary source)
 *   - character_facet_scores (read: fallback aggregation, tall EAV 0–100)
 *   - ikigai_state (write: UPSERT current snapshot)
 *   - ikigai_policy_log (write: audit trail)
 *   - ikigai_alerts (read/write: alert lifecycle)
 *
 * EXPORTS:
 *   StateManager class (named export)
 *     getCachedSnapshot(characterId)
 *     getCurrentState(characterId)
 *     getOrComputeSDT(characterId)
 *     saveIkigaiState({...})
 *     createIkigaiAlert(characterId, stability, okinawan)
 *     getUnhandledAlerts(characterId)
 *     markAlertsHandled(characterId, alertTypes)
 *
 * CALIBRATION STATUS:
 *   SDT_PRIORS weights in ikigaiConfig.js drive the personality → SDT
 *   derivation. All weights tagged 'peer_reviewed' or 'indirect_support'.
 *   The mapping version system (MAPPING_VERSION + policy log) ensures that
 *   when GRIDLab validation produces updated weights, all prior derivations
 *   remain traceable.
 *
 * RESEARCH CITATIONS:
 *   [1]  Bratko, D., Butković, A., Vukasović Hlupić, T., & Pocrnić, D. (2022).
 *        Etiology of basic psychological needs and their association with
 *        personality: A twin study. Journal of Research in Personality, 97,
 *        104201.
 *   [2]  Prentice, M., Jayawickreme, E., & Fleeson, W. (2019). Integrating
 *        whole trait theory and self-determination theory. Journal of
 *        Personality, 87(1), 56–69.
 *   [3]  Ryan, R. M., & Deci, E. L. (2000). Self-determination theory and
 *        the facilitation of intrinsic motivation, social development, and
 *        well-being. American Psychologist, 55(1), 68–78.
 *   [4]  Sheldon, K. M., & Schüler, J. (2011). Wanting, having, and needing:
 *        Integrating motive disposition theory and self-determination theory.
 *        Journal of Personality and Social Psychology, 101(5), 1106–1123.
 *   [5]  Huot-Lavoie, M., et al. (2026). Gaming disorder in first episode
 *        psychosis: Prevalence and impact on symptomatology and functioning
 *        in a prospective cohort study. Schizophrenia Bulletin, 52(2),
 *        sbaf232. [Alert system: obsessive_extractive named after this pattern]
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — State Manager
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
import { createModuleLogger } from '../../utils/logger.js';
import { safeFloat } from '../../utils/safeFloat.js';
import hexIdGen from '../../utils/hexIdGenerator.js';const { generateHexId } = hexIdGen;

const logger = createModuleLogger('ikigai-state-manager');

export class StateManager {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.cache = new Map();
  }

  async getCachedSnapshot(characterId) {
    return this.cache.get(characterId) || this.getCurrentState(characterId);
  }

  async getCurrentState(characterId) {
    const result = await this.db.query(
      `SELECT overall_ikigai, diversity_index, stability_flag, okinawan_confidence, metadata
       FROM ikigai_state 
       WHERE character_id = $1 
       ORDER BY recorded_at DESC 
       LIMIT 1`,
      [characterId]
    );
    const state = result.rows[0] || { 
      overall_ikigai: 0.5, 
      diversity_index: null,
      stability_flag: 'stable',
      okinawan_confidence: 'low',
      metadata: {}
    };
    this.cache.set(characterId, state);
    return state;
  }

  async getOrComputeSDT(characterId) {
    const existing = await this.db.query(
      'SELECT * FROM character_sdt_state WHERE character_id = $1',
      [characterId]
    );
    if (existing.rows.length > 0) {
      return existing.rows[0];
    }
    return this.computeSDTFromPersonality(characterId);
  }

  async computeSDTFromPersonality(characterId) {
    let domains = {
      neuroticism: 0.5,
      extraversion: 0.5,
      openness: 0.5,
      agreeableness: 0.5,
      conscientiousness: 0.5
    };

    const domResult = await this.db.query(
      `SELECT neuroticism, extraversion, openness, agreeableness, conscientiousness
       FROM character_personality 
       WHERE character_id = $1`,
      [characterId]
    );
    if (domResult.rows.length > 0) {
      const row = domResult.rows[0];
      domains = {
        neuroticism:      safeFloat(row.neuroticism),
        extraversion:     safeFloat(row.extraversion),
        openness:         safeFloat(row.openness),
        agreeableness:    safeFloat(row.agreeableness),
        conscientiousness:safeFloat(row.conscientiousness)
      };
    } else {
      const facets = await this.db.query(
        `SELECT domain, AVG(score / 100.0) as mean_score 
         FROM character_facet_scores 
         WHERE character_id = $1 
         GROUP BY domain`,
        [characterId]
      );
      for (const row of facets.rows) {
        domains[row.domain] = safeFloat(row.mean_score);
      }
    }

    const cfg = this.config.SDT_PRIORS;
    const sdt = {};

    for (const [dimension, prior] of Object.entries(cfg)) {
      let val = prior.baseline;
      for (const [domain, weight] of Object.entries(prior.domains)) {
        val += (domains[domain] ?? 0.5) * weight;
      }
      sdt[dimension] = Math.max(0.001, Math.min(1.0, val));
    }

    const hash = this.hashDomains(domains);
    const id = await generateHexId('character_sdt_state', this.db);

    await this.db.query(
      `INSERT INTO character_sdt_state 
       (sdt_state_id, character_id, autonomy_satisfaction, autonomy_frustration,
        competence_satisfaction, competence_frustration, relatedness_satisfaction, 
        relatedness_frustration, derived_from_personality_hash, computation_version,
        created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (character_id) DO NOTHING`,
      [
        id,
        characterId,
        sdt.autonomy_satisfaction,
        sdt.autonomy_frustration,
        sdt.competence_satisfaction,
        sdt.competence_frustration,
        sdt.relatedness_satisfaction,
        sdt.relatedness_frustration,
        hash,
        this.config.MAPPING_VERSION
      ]
    );

    await this.db.query(
      `INSERT INTO ikigai_policy_log (log_id, mapping_version, sdt_prior_hash, applied_at)
       VALUES ($1, $2, $3, NOW())`,
      [
        await generateHexId('ikigai_policy_log', this.db),
        this.config.MAPPING_VERSION,
        hash
      ]
    );

    const { rows } = await this.db.query(
      'SELECT * FROM character_sdt_state WHERE character_id = $1',
      [characterId]
    );
    return rows[0];
  }

  async saveIkigaiState({
    characterId, overallIkigai, diversityIndex, stabilityFlag,
    kamiyaBreakdown, okinawanBreakdown, okinawanConfidence,
    derivationHash
  }) {
    const id = await generateHexId('ikigai_state', this.db);
    const metadata = {
      kamiyaBreakdown,
      okinawanBreakdown,
      derivationHash,
      okinawan_insufficient_data: okinawanConfidence === 'low'
    };

    await this.db.query(
      `INSERT INTO ikigai_state 
       (state_id, character_id, overall_ikigai, diversity_index, stability_flag, 
        okinawan_confidence, metadata, recorded_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
       ON CONFLICT (character_id) 
       DO UPDATE SET
         overall_ikigai      = EXCLUDED.overall_ikigai,
         diversity_index     = EXCLUDED.diversity_index,
         stability_flag      = EXCLUDED.stability_flag,
         okinawan_confidence = EXCLUDED.okinawan_confidence,
         metadata            = EXCLUDED.metadata,
         recorded_at         = EXCLUDED.recorded_at,
         updated_at          = NOW()`,
      [
        id,
        characterId,
        overallIkigai,
        diversityIndex,
        stabilityFlag,
        okinawanConfidence,
        JSON.stringify(metadata)
      ]
    );

    this.cache.set(characterId, {
      overall_ikigai: overallIkigai,
      diversity_index: diversityIndex,
      stability_flag: stabilityFlag,
      okinawan_confidence: okinawanConfidence,
      metadata
    });
  }

  async createIkigaiAlert(characterId, stability, okinawan) {
    let alertType = null;
    let severity = 'warning';

    if (stability.stage === 'critical') {
      alertType = 'maslach_critical';
      severity = 'critical';
    } else if (okinawan.quadrant === 'obsessive_extractive') {
      alertType = 'obsessive_extractive';
    } else if (okinawan.quadrant === 'disengaged' && stability.stage === 'vulnerable') {
      alertType = 'ikigai_collapse';
    }

    if (!alertType) return;

    const existing = await this.db.query(
      `SELECT 1 FROM ikigai_alerts
       WHERE character_id = $1 AND alert_type = $2 AND handled = false
       LIMIT 1`,
      [characterId, alertType]
    );
    if (existing.rows.length) return;

    const id = await generateHexId('ikigai_alerts', this.db);
    await this.db.query(
      `INSERT INTO ikigai_alerts 
       (alert_id, character_id, alert_type, severity, details, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [
        id,
        characterId,
        alertType,
        severity,
        JSON.stringify({
          quadrant: okinawan.quadrant,
          passion: okinawan.passionDetails
        })
      ]
    );
  }

  async getUnhandledAlerts(characterId) {
    const result = await this.db.query(
      `SELECT alert_type, severity, details, created_at
       FROM ikigai_alerts
       WHERE character_id = $1 AND handled = false
       ORDER BY created_at DESC
       LIMIT 5`,
      [characterId]
    );
    return result.rows;
  }

  async markAlertsHandled(characterId, alertTypes) {
    if (!alertTypes || !alertTypes.length) return;
    await this.db.query(
      `UPDATE ikigai_alerts 
       SET handled = true, updated_at = NOW()
       WHERE character_id = $1 AND alert_type = ANY($2)`,
      [characterId, alertTypes]
    );
  }

  hashDomains(domains) {
    return Object.entries(domains)
      .sort()
      .map(([k, v]) => `${k}:${v.toFixed(4)}`)
      .join('|');
  }
}
