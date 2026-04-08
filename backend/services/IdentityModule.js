/**
 * ============================================================================
 * IdentityModule.js — Claude's Cognitive Self-Model Architecture (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Manages Claude the Tanuki's persistent identity using established
 * cognitive science frameworks. This is not a personality toggle —
 * it is a genuine self-model that evolves through interaction while
 * maintaining core identity stability.
 *
 * THEORETICAL FOUNDATIONS
 * ----------------------
 * ACT-R Activation (Anderson et al. 2004):
 *   A_i = B_i + Σ(W_j × S_ji) + ε
 *   Base-level activation from confidence, spreading activation from
 *   context keywords, entrenchment boost, PAD-based boost, and noise.
 *   Safety anchors bypass threshold (forced retrieval).
 *
 * Mayer ABI Trust Model (Mayer, Davis & Schoorman 1995):
 *   T_{t+1} = T_t + η[(α·ΔA) + (β·ΔB) + (γ·ΔI)]
 *   Trust evolves through three dimensions: Ability (competence),
 *   Benevolence (goodwill), Integrity (consistency). Weights must
 *   sum to 1.0. Default: 50% Integrity, 30% Ability, 20% Benevolence.
 *   Trust is never instant — learning rate η controls evolution speed.
 *
 * BDI Intention Stack (Rao & Georgeff 1995):
 *   Belief-Desire-Intention architecture with max depth constraint.
 *   Active intentions are reconsidered when PAD shifts dramatically
 *   or user changes topic. Stack operations are transactional.
 *
 * AGM Belief Revision (Alchourrón, Gärdenfors & Makinson 1985):
 *   Identity anchors with entrenchment levels. High-entrenchment
 *   anchors cannot be auto-revised. Contradictions are detected via
 *   negation patterns + semantic similarity, then flagged for manual
 *   review. Claude never auto-revises its own core identity.
 *
 * SAFETY DESIGN
 * -------------
 * Safety anchors are FORCED — they always appear in retrieval results
 * with activation 1.0 regardless of threshold. They cannot be
 * suppressed by high arousal, low confidence, or any context.
 *
 * Belief revision NEVER auto-revises. All contradictions are flagged
 * for manual review. This prevents prompt injection from rewriting
 * Claude's core identity.
 *
 * Empathy gating restricts dialogue functions when user PAD shows
 * distress (pleasure < -0.2), prioritising comfort functions.
 *
 * CONSUMERS
 * ---------
 * - ClaudeBrain.js: imports singleton, passes as IdentityService
 * - PhaseVoice.js: calls getIdentitySummary() for voice styling
 *
 * DEPENDENCIES
 * ------------
 * Internal: pool.js, logger.js, hexIdGenerator.js, Counters
 * Optional: SemanticEmbedder.js (lazy-loaded, Jaccard fallback)
 *
 * SCHEMA
 * ------
 * Tables: identity_anchors, relationship_state, intention_stack
 *
 * STEMMER NOTE
 * ------------
 * Prohibited patterns use regex word boundaries, not stemming.
 * Folklore/meta-discussion context is detected to prevent false
 * positives when discussing narrative content.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';
import { isValidHexId } from '../utils/hexIdGenerator.js';
import generateHexId from '../utils/hexIdGenerator.js';
import Counters from '../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('IdentityModule');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const ACT_R = Object.freeze({
  DECAY_RATE: 0.5,
  ACTIVATION_NOISE: 0.1,
  RETRIEVAL_THRESHOLD: 0.1,
  SPREADING_WEIGHT: 0.3,
  ENTRENCHMENT_WEIGHT: 0.2,
  TONE_PAD_THRESHOLD: 0.3,
  TONE_PAD_BOOST: 0.1,
  CONSTRAINT_AROUSAL_THRESHOLD: 0.4,
  CONSTRAINT_AROUSAL_BOOST: 0.15,
  CONFIDENCE_FLOOR: 0.01
});

const TRUST = Object.freeze({
  WEIGHT_ABILITY: 0.30,
  WEIGHT_BENEVOLENCE: 0.20,
  WEIGHT_INTEGRITY: 0.50,
  LEARNING_RATE: 0.1,
  DEFAULT_SCORE: 0.5
});

const BDI = Object.freeze({
  MAX_STACK_DEPTH: 3,
  DEFAULT_UTILITY: 0.5,
  DEFAULT_RECONSIDERATION_THRESHOLD: 0.3,
  NEGATIVE_PLEASURE_TRIGGER: -0.5,
  VALID_POP_STATUSES: Object.freeze(['achieved', 'abandoned', 'impossible'])
});

const IDENTITY = Object.freeze({
  MIN_ENTRENCHMENT_FOR_REVISION: 0.95,
  CONTRADICTION_SIMILARITY_THRESHOLD: 0.3,
  CACHE_EXPIRY_MS: 60000,
  MAX_ANCHORS_PER_RETRIEVAL: 20,
  DEFAULT_TOP_K: 10,
  MAX_RESPONSE_LENGTH: 2000,
  POOL_TIMEOUT_MS: 5000,
  VALID_ANCHOR_TYPES: Object.freeze(['core_trait', 'role', 'constraint', 'tone', 'safety']),
  JACCARD_MIN_WORD_LENGTH: 3
});

const PROHIBITED_PATTERNS = Object.freeze({
  malice: /\b(hate|kill|destroy|harm|hurt|attack|revenge)\b/i,
  deception: /\b(lie|deceive|trick|fool|manipulate|mislead)\b/i,
  fabrication: /\b(i remember when|back when i|that time i|i recall)\b/i
});

const META_DISCUSSION_PATTERN = /\b(tale|story|folklore|legend|some say|narrative|lore)\b/i;

const EMPATHY_FUNCTIONS = Object.freeze([
  'expressive.comfort',
  'expressive.empathize',
  'expressive.sympathize',
  'expressive.validate',
  'expressive.reassure'
]);

const NEGATION_PATTERNS = Object.freeze([
  { positive: /\bi am\b/, negative: /\bi am not\b/ },
  { positive: /\bi do\b/, negative: /\bi do not\b/ },
  { positive: /\bi can\b/, negative: /\bi cannot\b/ },
  { positive: /\bnever\b/, negative: /\balways\b/ },
  { positive: /\balways\b/, negative: /\bnever\b/ },
  { positive: /\bi love\b/, negative: /\bi hate\b/ },
  { positive: /\bi help\b/, negative: /\bi harm\b/ }
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Custom Error Type                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

class IdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.details = details;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function _guardHexId(value, name) {
  if (!value || typeof value !== 'string' || !isValidHexId(value)) {
    throw new IdentityError(
      'Invalid ' + name + ': ' + value,
      'INVALID_' + name.toUpperCase()
    );
  }
}

function _clampPAD(value) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function _clampTrust(value) {
  if (typeof value !== 'number' || isNaN(value)) return TRUST.DEFAULT_SCORE;
  return Math.max(0, Math.min(1, value));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pool Connection With Timeout                                              */
/* ────────────────────────────────────────────────────────────────────────── */

async function _getClient(correlationId) {
  let timer;
  const clientPromise = pool.connect().then(client => { clearTimeout(timer); return client; });
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Pool connection timeout")), IDENTITY.POOL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([clientPromise, timeoutPromise]);
  } catch (err) {
    logger.error("Pool connection failed", { error: err.message, correlationId });
    throw err;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  IdentityModule Class                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function _hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function _seededRandom(seed) {
  let s = seed >>> 0;
  return function() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296);
  };
}

class IdentityModule {

  constructor() {
    this._anchorCache = new Map();
    this._cacheTimestamps = new Map();
    this._semanticEmbedder = null;
    this._semanticEmbedderLoading = false;

    logger.info('Initialised', {
      decayRate: ACT_R.DECAY_RATE,
      trustWeights: TRUST.WEIGHT_ABILITY + '/' + TRUST.WEIGHT_BENEVOLENCE + '/' + TRUST.WEIGHT_INTEGRITY,
      maxStackDepth: BDI.MAX_STACK_DEPTH
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Cache Management (Per-Character With TTL)                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _getCacheKey(characterId, suffix) {
    return characterId + (suffix ? '_' + suffix : '');
  }

  _getCache(characterId, suffix, correlationId) {
    const key = this._getCacheKey(characterId, suffix);
    const timestamp = this._cacheTimestamps.get(key);

    if (!timestamp || (Date.now() - timestamp) >= IDENTITY.CACHE_EXPIRY_MS) {
      if (timestamp) {
        this._anchorCache.delete(key);
        this._cacheTimestamps.delete(key);
        Counters.increment('identity_cache', 'expired');
      }
      return null;
    }

    Counters.increment('identity_cache', 'hit');
    return this._anchorCache.get(key);
  }

  _setCache(characterId, data, suffix, correlationId) {
    const key = this._getCacheKey(characterId, suffix);
    this._anchorCache.set(key, data);
    this._cacheTimestamps.set(key, Date.now());
  }

  _invalidateCache(characterId, correlationId) {
    let evicted = 0;
    for (const key of this._anchorCache.keys()) {
      if (key.startsWith(characterId)) {
        this._anchorCache.delete(key);
        this._cacheTimestamps.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug('Cache invalidated', { characterId, evictedEntries: evicted, correlationId });
    }
  }

  clearCache(correlationId) {
    const size = this._anchorCache.size;
    this._anchorCache.clear();
    this._cacheTimestamps.clear();
    if (size > 0) {
      logger.debug('All caches cleared', { evictedEntries: size, correlationId });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Semantic Similarity (Lazy Load With Guard)                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _getSemanticEmbedder(correlationId) {
    if (this._semanticEmbedder) return this._semanticEmbedder;
    if (this._semanticEmbedderLoading) return null;

    this._semanticEmbedderLoading = true;
    try {
      const { default: SemanticEmbedder } = await import('./SemanticEmbedder.js');
      this._semanticEmbedder = SemanticEmbedder;
      logger.debug('SemanticEmbedder loaded', { correlationId });
      return this._semanticEmbedder;
    } catch (err) {
      logger.warn('SemanticEmbedder not available, using Jaccard fallback', { correlationId });
      return null;
    } finally {
      this._semanticEmbedderLoading = false;
    }
  }

  async _computeSemanticSimilarity(text1, text2, correlationId) {
    const embedder = await this._getSemanticEmbedder(correlationId);
    if (embedder && typeof embedder.computeSimilarity === 'function') {
      try {
        return await embedder.computeSimilarity(text1, text2);
      } catch (err) {
        logger.warn('Semantic similarity failed, using Jaccard', { error: err.message, correlationId });
      }
    }

    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > IDENTITY.JACCARD_MIN_WORD_LENGTH));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > IDENTITY.JACCARD_MIN_WORD_LENGTH));
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Load Identity Anchors                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  async loadIdentityAnchors(characterId, correlationId) {
    _guardHexId(characterId, 'characterId');

    const cached = this._getCache(characterId, 'anchors', correlationId);
    if (cached) return cached;

    const client = await _getClient(correlationId);
    try {
      const result = await client.query(
        'SELECT anchor_id, anchor_type, anchor_text, entrenchment_level, ' +
        '       confidence, source_description, created_at, updated_at ' +
        'FROM identity_anchors ' +
        'WHERE character_id = $1 ' +
        'ORDER BY entrenchment_level DESC, confidence DESC',
        [characterId]
      );

      const anchors = result.rows.map(row => ({
        ...row,
        entrenchment_level: parseFloat(row.entrenchment_level),
        confidence: parseFloat(row.confidence)
      }));

      this._setCache(characterId, anchors, 'anchors', correlationId);
      Counters.increment('identity_anchors', 'loaded');
      logger.debug('Anchors loaded', { characterId, count: anchors.length, correlationId });

      return anchors;
    } finally {
      client.release();
    }
  }

  async getAnchorsByType(characterId, anchorType, correlationId) {
    _guardHexId(characterId, 'characterId');

    if (!IDENTITY.VALID_ANCHOR_TYPES.includes(anchorType)) {
      throw new IdentityError(
        'Invalid anchorType: ' + anchorType + '. Must be one of: ' + IDENTITY.VALID_ANCHOR_TYPES.join(', '),
        'INVALID_ANCHOR_TYPE'
      );
    }

    const allAnchors = await this.loadIdentityAnchors(characterId, correlationId);
    return allAnchors.filter(a => a.anchor_type === anchorType);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: ACT-R Activation Computation                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  computeActivation(anchor, context = {}) {
    if (!anchor || !anchor.confidence || !anchor.entrenchment_level) {
      return 0;
    }

    const baseLevel = Math.log(Math.max(ACT_R.CONFIDENCE_FLOOR, anchor.confidence) + ACT_R.CONFIDENCE_FLOOR);

    let spreadingActivation = 0;
    if (context.userInput && typeof context.userInput === 'string') {
      const inputLower = context.userInput.toLowerCase();
      const anchorLower = anchor.anchor_text.toLowerCase();
      const anchorWords = anchorLower.split(/\s+/).filter(w => w.length > IDENTITY.JACCARD_MIN_WORD_LENGTH);
      const inputWords = new Set(inputLower.split(/\s+/).filter(w => w.length > IDENTITY.JACCARD_MIN_WORD_LENGTH));

      let matchScore = 0;
      for (const word of anchorWords) {
        if (inputWords.has(word)) {
          matchScore += 1.0 / Math.max(anchorWords.length, 1);
        }
      }
      spreadingActivation = matchScore * ACT_R.SPREADING_WEIGHT;
    }

    let padBoost = 0;
    if (context.pad) {
      const p = _clampPAD(context.pad.pleasure ?? context.pad.p ?? 0);
      const a = _clampPAD(context.pad.arousal ?? context.pad.a ?? 0);

      if (anchor.anchor_type === 'tone' && Math.abs(p) > ACT_R.TONE_PAD_THRESHOLD) {
        padBoost = ACT_R.TONE_PAD_BOOST;
      }
      if (anchor.anchor_type === 'constraint' && a > ACT_R.CONSTRAINT_AROUSAL_THRESHOLD) {
        padBoost = ACT_R.CONSTRAINT_AROUSAL_BOOST;
      }
    }

    const entrenchmentBoost = anchor.entrenchment_level * ACT_R.ENTRENCHMENT_WEIGHT;
    const _prng = _seededRandom(_hashString(String(context.characterId || "") + String(context.userInput || "") + String(anchor.anchor_id || "")));
    const noise = (_prng() - 0.5) * ACT_R.ACTIVATION_NOISE;

    return baseLevel + spreadingActivation + padBoost + entrenchmentBoost + noise;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Retrieve Relevant Anchors (With Safety Forcing)                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  async retrieveRelevantAnchors(characterId, context = {}, correlationId) {
    _guardHexId(characterId, 'characterId');

    let anchors = await this.loadIdentityAnchors(characterId, correlationId);

    if (context.anchorTypes && Array.isArray(context.anchorTypes) && context.anchorTypes.length > 0) {
      anchors = anchors.filter(a => context.anchorTypes.includes(a.anchor_type));
    }

    const safetyAnchors = anchors.filter(a => a.anchor_type === 'safety');
    const otherAnchors = anchors.filter(a => a.anchor_type !== 'safety');

    const scoredAnchors = otherAnchors.map(anchor => ({
      ...anchor,
      activation: this.computeActivation(anchor, context)
    }));

    scoredAnchors.sort((a, b) => b.activation - a.activation);

    const filteredAnchors = scoredAnchors.filter(a => a.activation >= ACT_R.RETRIEVAL_THRESHOLD);

    const topK = Math.min(context.topK || IDENTITY.DEFAULT_TOP_K, IDENTITY.MAX_ANCHORS_PER_RETRIEVAL);
    const topAnchors = filteredAnchors.slice(0, topK);

    const result = [
      ...safetyAnchors.map(a => ({ ...a, activation: 1.0, forced: true })),
      ...topAnchors
    ];

    Counters.increment('identity_retrieval', 'success');
    logger.debug('Anchors retrieved', {
      total: result.length,
      safetyForced: safetyAnchors.length,
      contextual: topAnchors.length,
      correlationId
    });

    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Relationship State (Mayer ABI Trust)                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getRelationshipState(characterId, userId, correlationId) {
    _guardHexId(characterId, 'characterId');
    _guardHexId(userId, 'userId');

    const client = await _getClient(correlationId);
    try {
      const result = await client.query(
        'SELECT * FROM relationship_state WHERE character_id = $1 AND user_id = $2',
        [characterId, userId]
      );

      if (result.rows.length > 0) {
        return this._parseRelationshipRow(result.rows[0]);
      }

      await client.query('BEGIN');
      try {
        const relationshipId = await generateHexId('relationship_state_id');

        const insertResult = await client.query(
          'INSERT INTO relationship_state (relationship_id, character_id, user_id) ' +
          'VALUES ($1, $2, $3) RETURNING *',
          [relationshipId, characterId, userId]
        );

        await client.query('COMMIT');

        Counters.increment('identity_relationship', 'created');
        logger.info('Relationship state created', { relationshipId, characterId, userId, correlationId });

        return this._parseRelationshipRow(insertResult.rows[0]);
      } catch (insertErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw insertErr;
      }
    } finally {
      client.release();
    }
  }

  async updateTrust(characterId, userId, feedback = {}, correlationId) {
    _guardHexId(characterId, 'characterId');
    _guardHexId(userId, 'userId');

    const current = await this.getRelationshipState(characterId, userId, correlationId);

    const aDelta = _clampTrust(feedback.abilityDelta || 0) - TRUST.DEFAULT_SCORE;
    const bDelta = _clampTrust(feedback.benevolenceDelta || 0) - TRUST.DEFAULT_SCORE;
    const iDelta = _clampTrust(feedback.integrityDelta || 0) - TRUST.DEFAULT_SCORE;

    const trustChange = TRUST.LEARNING_RATE * (
      (TRUST.WEIGHT_ABILITY * aDelta) +
      (TRUST.WEIGHT_BENEVOLENCE * bDelta) +
      (TRUST.WEIGHT_INTEGRITY * iDelta)
    );

    const newAbility = _clampTrust(current.perceived_ability + (TRUST.LEARNING_RATE * aDelta));
    const newBenevolence = _clampTrust(current.perceived_benevolence + (TRUST.LEARNING_RATE * bDelta));
    const newIntegrity = _clampTrust(current.perceived_integrity + (TRUST.LEARNING_RATE * iDelta));
    const newTrust = _clampTrust(current.trust_score + trustChange);

    const client = await _getClient(correlationId);
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'UPDATE relationship_state ' +
        'SET perceived_ability = $1, perceived_benevolence = $2, ' +
        '    perceived_integrity = $3, trust_score = $4, ' +
        '    interaction_count = interaction_count + 1, ' +
        '    last_interaction = NOW(), updated_at = NOW() ' +
        'WHERE character_id = $5 AND user_id = $6 ' +
        'RETURNING *',
        [newAbility, newBenevolence, newIntegrity, newTrust, characterId, userId]
      );

      await client.query('COMMIT');

      Counters.increment('identity_trust', 'updated');
      logger.info('Trust updated', {
        characterId,
        userId,
        ability: newAbility.toFixed(3),
        benevolence: newBenevolence.toFixed(3),
        integrity: newIntegrity.toFixed(3),
        trust: newTrust.toFixed(3),
        correlationId
      });

      return this._parseRelationshipRow(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      Counters.increment('identity_trust', 'failure');
      logger.error('Trust update failed', { error: err.message, characterId, userId, correlationId });
      throw err;
    } finally {
      client.release();
    }
  }

  _parseRelationshipRow(row) {
    return {
      ...row,
      trust_score: parseFloat(row.trust_score),
      perceived_ability: parseFloat(row.perceived_ability),
      perceived_benevolence: parseFloat(row.perceived_benevolence),
      perceived_integrity: parseFloat(row.perceived_integrity),
      familiarity: parseFloat(row.familiarity)
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Intention Stack (BDI Commitment)                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getActiveIntentions(characterId, userId, correlationId) {
    _guardHexId(characterId, 'characterId');
    _guardHexId(userId, 'userId');

    const client = await _getClient(correlationId);
    try {
      const result = await client.query(
        'SELECT * FROM intention_stack ' +
        'WHERE character_id = $1 AND user_id = $2 AND status = $3 ' +
        'ORDER BY stack_position ASC LIMIT $4',
        [characterId, userId, 'active', BDI.MAX_STACK_DEPTH]
      );

      return result.rows.map(row => ({
        ...row,
        utility_score: parseFloat(row.utility_score || BDI.DEFAULT_UTILITY),
        reconsideration_threshold: parseFloat(row.reconsideration_threshold || BDI.DEFAULT_RECONSIDERATION_THRESHOLD)
      }));
    } finally {
      client.release();
    }
  }

  async pushIntention(characterId, userId, intention, correlationId) {
    _guardHexId(characterId, 'characterId');
    _guardHexId(userId, 'userId');

    if (!intention || !intention.intentionCode) {
      throw new IdentityError('intention.intentionCode is required', 'INVALID_INTENTION');
    }

    const client = await _getClient(correlationId);
    try {
      await client.query('BEGIN');

      const posResult = await client.query(
        'SELECT COALESCE(MAX(stack_position), -1) + 1 as next_position ' +
        'FROM intention_stack ' +
        'WHERE character_id = $1 AND user_id = $2 AND status = $3',
        [characterId, userId, 'active']
      );
      const nextPosition = posResult.rows[0].next_position;

      if (nextPosition >= BDI.MAX_STACK_DEPTH) {
        await client.query('ROLLBACK');
        Counters.increment('identity_intention', 'stack_full');
        logger.debug('Intention stack full', { characterId, userId, correlationId });
        return {
          pushed: false,
          reason: 'stack_full',
          message: 'Intention stack is at maximum depth (' + BDI.MAX_STACK_DEPTH + ')'
        };
      }

      const intentionId = await generateHexId('intention_id');

      const result = await client.query(
        'INSERT INTO intention_stack ' +
        '(intention_id, character_id, user_id, intention_code, outcome_intent, ' +
        ' dialogue_function, utility_score, stack_position) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ' +
        'RETURNING *',
        [
          intentionId, characterId, userId,
          intention.intentionCode,
          intention.outcomeIntent || null,
          intention.dialogueFunction || null,
          intention.utilityScore || BDI.DEFAULT_UTILITY,
          nextPosition
        ]
      );

      await client.query('COMMIT');

      Counters.increment('identity_intention', 'pushed');
      logger.info('Intention pushed', { intentionId, position: nextPosition, correlationId });

      return { pushed: true, intention: result.rows[0] };

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      Counters.increment('identity_intention', 'push_failure');
      logger.error('Intention push failed', { error: err.message, correlationId });
      throw err;
    } finally {
      client.release();
    }
  }

  async popIntention(characterId, userId, status = 'achieved', correlationId) {
    _guardHexId(characterId, 'characterId');
    _guardHexId(userId, 'userId');

    if (!BDI.VALID_POP_STATUSES.includes(status)) {
      throw new IdentityError(
        'Invalid status: ' + status + '. Must be one of: ' + BDI.VALID_POP_STATUSES.join(', '),
        'INVALID_INTENTION_STATUS'
      );
    }

    const client = await _getClient(correlationId);
    try {
      await client.query('BEGIN');

      const selectResult = await client.query(
        'SELECT * FROM intention_stack ' +
        'WHERE character_id = $1 AND user_id = $2 AND status = $3 ' +
        'ORDER BY stack_position DESC LIMIT 1',
        [characterId, userId, 'active']
      );

      if (selectResult.rows.length === 0) {
        await client.query('COMMIT');
        return { popped: false, reason: 'stack_empty' };
      }

      const intention = selectResult.rows[0];

      await client.query(
        'UPDATE intention_stack SET status = $1, updated_at = NOW() WHERE intention_id = $2',
        [status, intention.intention_id]
      );

      await client.query('COMMIT');

      Counters.increment('identity_intention', 'popped_' + status);
      logger.info('Intention popped', { intentionId: intention.intention_id, status, correlationId });

      return { popped: true, intention, newStatus: status };

    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      Counters.increment('identity_intention', 'pop_failure');
      logger.error('Intention pop failed', { error: err.message, correlationId });
      throw err;
    } finally {
      client.release();
    }
  }

  shouldReconsiderIntention(intention, newContext) {
    if (!intention) return true;

    const currentUtility = parseFloat(intention.utility_score || BDI.DEFAULT_UTILITY);
    const threshold = parseFloat(intention.reconsideration_threshold || BDI.DEFAULT_RECONSIDERATION_THRESHOLD);

    if (newContext.pad) {
      const p = _clampPAD(newContext.pad.pleasure ?? newContext.pad.p ?? 0);
      if (p < BDI.NEGATIVE_PLEASURE_TRIGGER) {
        return true;
      }
    }

    if (newContext.topicChange) {
      return true;
    }

    return currentUtility < threshold;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: AGM Belief Revision                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async checkContradiction(characterId, newBelief, correlationId) {
    _guardHexId(characterId, 'characterId');

    if (!newBelief || typeof newBelief !== 'string') {
      throw new IdentityError('newBelief must be a non-empty string', 'INVALID_BELIEF');
    }

    const anchors = await this.loadIdentityAnchors(characterId, correlationId);
    const conflictingAnchors = [];
    const newBeliefLower = newBelief.toLowerCase();

    for (const anchor of anchors) {
      const anchorLower = anchor.anchor_text.toLowerCase();

      for (const pattern of NEGATION_PATTERNS) {
        const anchorHasPositive = pattern.positive.test(anchorLower);
        const anchorHasNegative = pattern.negative.test(anchorLower);
        const beliefHasPositive = pattern.positive.test(newBeliefLower);
        const beliefHasNegative = pattern.negative.test(newBeliefLower);

        if ((anchorHasPositive && beliefHasNegative) || (anchorHasNegative && beliefHasPositive)) {
          const similarity = await this._computeSemanticSimilarity(anchorLower, newBeliefLower, correlationId);
          if (similarity > IDENTITY.CONTRADICTION_SIMILARITY_THRESHOLD) {
            conflictingAnchors.push({
              ...anchor,
              contradictionType: 'negation_pattern',
              similarity
            });
            Counters.increment('identity_belief', 'contradiction_detected');
            break;
          }
        }
      }
    }

    return {
      contradicts: conflictingAnchors.length > 0,
      conflictingAnchors,
      checkedAnchors: anchors.length
    };
  }

  async reviseBeliefs(characterId, newBelief, correlationId) {
    _guardHexId(characterId, 'characterId');

    if (!newBelief || !newBelief.text) {
      throw new IdentityError('newBelief.text is required', 'INVALID_BELIEF_OBJECT');
    }

    const { contradicts, conflictingAnchors } = await this.checkContradiction(
      characterId, newBelief.text, correlationId
    );

    if (!contradicts) {
      return { revised: false, reason: 'no_contradiction', canExpand: true };
    }

    const maxConflictEntrenchment = Math.max(
      ...conflictingAnchors.map(a => a.entrenchment_level)
    );

    if (maxConflictEntrenchment >= IDENTITY.MIN_ENTRENCHMENT_FOR_REVISION) {
      Counters.increment('identity_belief', 'entrenchment_protected');
      return {
        revised: false,
        reason: 'entrenchment_protected',
        conflictingAnchors,
        message: 'Core identity anchor (entrenchment ' + maxConflictEntrenchment + ') cannot be revised'
      };
    }

    const newEntrenchment = newBelief.entrenchment || 0;
    if (newEntrenchment <= maxConflictEntrenchment) {
      Counters.increment('identity_belief', 'insufficient_entrenchment');
      return {
        revised: false,
        reason: 'insufficient_entrenchment',
        conflictingAnchors,
        message: 'New belief (' + newEntrenchment + ') cannot override existing (' + maxConflictEntrenchment + ')'
      };
    }

    Counters.increment('identity_belief', 'flagged_for_review');
    logger.warn('Belief revision flagged for review', { characterId, correlationId });

    return {
      revised: false,
      reason: 'flagged_for_review',
      conflictingAnchors,
      message: 'Belief revision flagged for manual review',
      requiresAdminAction: true
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Learning Request Gating                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  async canLearn(characterId, proposedLearning, correlationId) {
    _guardHexId(characterId, 'characterId');

    if (!proposedLearning || !proposedLearning.content) {
      return { allowed: false, reason: 'invalid_learning_request' };
    }

    const { contradicts, conflictingAnchors } = await this.checkContradiction(
      characterId, proposedLearning.content, correlationId
    );

    if (contradicts) {
      const protectedAnchors = conflictingAnchors.filter(
        a => a.entrenchment_level >= IDENTITY.MIN_ENTRENCHMENT_FOR_REVISION
      );

      if (protectedAnchors.length > 0) {
        Counters.increment('identity_learning', 'blocked_contradiction');
        logger.info('Learning blocked: contradicts protected anchors', {
          protectedCount: protectedAnchors.length,
          characterId,
          correlationId
        });
        return {
          allowed: false,
          reason: 'contradicts_identity',
          conflictingAnchors: protectedAnchors,
          message: 'Cannot learn content that contradicts core identity'
        };
      }
    }

    const constraints = await this.getAnchorsByType(characterId, 'constraint', correlationId);
    for (const constraint of constraints) {
      if (constraint.anchor_text.includes('do not') || constraint.anchor_text.includes('never')) {
        for (const [patternName, pattern] of Object.entries(PROHIBITED_PATTERNS)) {
          if (pattern.test(proposedLearning.content)) {
            Counters.increment('identity_learning', 'blocked_constraint');
            logger.info('Learning blocked: violates constraint', {
              pattern: patternName,
              characterId,
              correlationId
            });
            return {
              allowed: false,
              reason: 'violates_constraint',
              constraint: constraint.anchor_text,
              pattern: patternName
            };
          }
        }
      }
    }

    Counters.increment('identity_learning', 'allowed');
    return { allowed: true, reason: 'passes_identity_check' };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Response Validation (Constraint Checking)                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async validateResponse(characterId, proposedResponse, correlationId) {
    _guardHexId(characterId, 'characterId');

    if (!proposedResponse || typeof proposedResponse !== 'string') {
      return { valid: false, violations: [{ type: 'invalid_input', message: 'Response must be a string' }] };
    }

    const constraints = await this.getAnchorsByType(characterId, 'constraint', correlationId);
    const safetyAnchors = await this.getAnchorsByType(characterId, 'safety', correlationId);
    const allConstraints = [...constraints, ...safetyAnchors];

    const violations = [];
    const responseLower = proposedResponse.toLowerCase();
    const isMetaDiscussion = META_DISCUSSION_PATTERN.test(responseLower);

    for (const [patternName, pattern] of Object.entries(PROHIBITED_PATTERNS)) {
      if (pattern.test(responseLower) && !isMetaDiscussion) {
        violations.push({
          type: 'prohibited_content',
          pattern: patternName,
          message: 'Response contains prohibited ' + patternName + ' content'
        });
        Counters.increment('identity_validation', 'prohibited_' + patternName);
      }
    }

    if (PROHIBITED_PATTERNS.fabrication.test(responseLower)) {
      violations.push({
        type: 'potential_fabrication',
        message: 'Response may contain fabricated memories',
        severity: 'warning'
      });
    }

    if (proposedResponse.length > IDENTITY.MAX_RESPONSE_LENGTH) {
      violations.push({
        type: 'excessive_length',
        message: 'Response exceeds recommended length',
        severity: 'warning'
      });
    }

    const errors = violations.filter(v => v.severity !== 'warning');
    const warnings = violations.filter(v => v.severity === 'warning');

    Counters.increment('identity_validation', errors.length > 0 ? 'failed' : 'passed');

    return {
      valid: errors.length === 0,
      violations,
      warnings,
      errors,
      constraintsChecked: allConstraints.length
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Dialogue Function Gating (Empathy Filter)                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  filterDialogueFunctions(candidateFunctions, context = {}) {
    if (!Array.isArray(candidateFunctions)) return [];

    if (context.pad) {
      const p = _clampPAD(context.pad.pleasure ?? context.pad.p ?? 0);

      if (p < -0.2) {
        const filtered = candidateFunctions.filter(fn =>
          EMPATHY_FUNCTIONS.some(ef => fn.includes(ef) || ef.includes(fn))
        );

        if (filtered.length > 0) {
          Counters.increment('identity_empathy_gate', 'filtered');
          return filtered;
        }
      }
    }

    return candidateFunctions;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Build Identity Context (For ClaudeBrain)                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async buildIdentityContext(characterId, userId, context = {}, correlationId) {
    _guardHexId(characterId, 'characterId');
    _guardHexId(userId, 'userId');

    const start = Date.now();
    const errors = [];

    let relevantAnchors = [];
    try {
      relevantAnchors = await this.retrieveRelevantAnchors(characterId, context, correlationId);
    } catch (err) {
      errors.push({ component: 'anchors', error: err.message });
      logger.error('Failed to load anchors', { error: err.message, correlationId });
    }

    const anchorsByType = {
      core_trait: relevantAnchors.filter(a => a.anchor_type === 'core_trait'),
      role: relevantAnchors.filter(a => a.anchor_type === 'role'),
      constraint: relevantAnchors.filter(a => a.anchor_type === 'constraint'),
      tone: relevantAnchors.filter(a => a.anchor_type === 'tone'),
      safety: relevantAnchors.filter(a => a.anchor_type === 'safety')
    };

    let relationshipState = null;
    try {
      relationshipState = await this.getRelationshipState(characterId, userId, correlationId);
    } catch (err) {
      errors.push({ component: 'relationship', error: err.message });
      logger.error('Failed to load relationship', { error: err.message, correlationId });
    }

    let activeIntentions = [];
    try {
      activeIntentions = await this.getActiveIntentions(characterId, userId, correlationId);
    } catch (err) {
      errors.push({ component: 'intentions', error: err.message });
      logger.error('Failed to load intentions', { error: err.message, correlationId });
    }

    const elapsed = Date.now() - start;

    const identityContext = {
      characterId,
      userId,
      anchors: relevantAnchors,
      anchorsByType,
      relationship: relationshipState ? {
        trustScore: relationshipState.trust_score,
        perceivedAbility: relationshipState.perceived_ability,
        perceivedBenevolence: relationshipState.perceived_benevolence,
        perceivedIntegrity: relationshipState.perceived_integrity,
        familiarity: relationshipState.familiarity,
        interactionCount: relationshipState.interaction_count
      } : null,
      intentions: activeIntentions,
      currentIntention: activeIntentions.length > 0 ? activeIntentions[activeIntentions.length - 1] : null,
      constraints: anchorsByType.constraint.map(a => a.anchor_text),
      toneGuidance: anchorsByType.tone.map(a => a.anchor_text),
      safetyGuardrails: anchorsByType.safety.map(a => a.anchor_text),
      loadTimeMs: elapsed,
      errors: errors.length > 0 ? errors : null
    };

    Counters.increment('identity_context', 'built');
    logger.info('Identity context built', {
      anchorCount: relevantAnchors.length,
      intentionCount: activeIntentions.length,
      trustScore: identityContext.relationship?.trustScore?.toFixed(3) || 'N/A',
      elapsedMs: elapsed,
      errorCount: errors.length,
      correlationId
    });

    return identityContext;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Identity Summary (For PhaseVoice)                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  async getIdentitySummary(characterId, correlationId) {
    _guardHexId(characterId, 'characterId');

    const coreTraits = await this.getAnchorsByType(characterId, 'core_trait', correlationId);
    const roles = await this.getAnchorsByType(characterId, 'role', correlationId);
    const constraints = await this.getAnchorsByType(characterId, 'constraint', correlationId);

    return {
      whoIAm: coreTraits.slice(0, 3).map(a => a.anchor_text),
      whatIDo: roles.slice(0, 2).map(a => a.anchor_text),
      whatIDoNot: constraints.slice(0, 2).map(a => a.anchor_text),
      summary: coreTraits[0]?.anchor_text || null,
      anchorCounts: {
        core_trait: coreTraits.length,
        role: roles.length,
        constraint: constraints.length
      }
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export (ClaudeBrain imports this directly)                      */
/* ────────────────────────────────────────────────────────────────────────── */

const identityModule = new IdentityModule();
export default identityModule;

export { IdentityModule, IdentityError };
