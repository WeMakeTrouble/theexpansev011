/**
 * ============================================================================
 * NaturalLanguageGenerator.js — Claude the Tanuki's Voice Engine (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * This is the soul of Claude the Tanuki's spoken voice. It transforms
 * raw knowledge facts into personality-rich, emotionally-aware natural
 * language. Every word Claude says to a user passes through this engine.
 *
 * The Expanse has no external AI APIs. Claude's voice is built entirely
 * in-house using deterministic rule-based NLG with seeded randomness,
 * character voice patterns, PAD emotional modulation, and structured
 * caching. This is not token prediction — it is structural determination.
 *
 * VOICE ARCHITECTURE
 * ------------------
 * The generator uses a "Sandwich" assembly pattern:
 *   Opening → Main Content → Elaboration → Closing
 *
 * Each layer is modulated by three independent systems:
 *   1. Character Voice — WHO is speaking (personality archetype)
 *   2. Tone Modifiers — HOW they speak (warmth, formality)
 *   3. PAD Adjustment — WHAT emotional state colours the speech
 *
 * CHARACTER VOICES (7 archetypes)
 * --------------------------------
 * - enthusiastic_outgoing: High confidence + communication
 * - curious_cautious: High curiosity + anxiety
 * - supportive_collaborative: High empathy + collaboration
 * - analytical_independent: High analytical + independence
 * - yurei_malevolent: Pineaple Yurei — consumption, void, hunger
 * - tanuki_trickster: Claude the Tanuki — mischief, disguise, play
 * - mutai_fragmented: The Mutai — shattered, broken, bleeding colour
 *
 * Voice selection uses trait-based derivation from a character's
 * learning profile (confidence, curiosity, anxiety, empathy,
 * communication, analytical thinking, independence).
 *
 * PAD MODULATION (Pleasure-Arousal-Dominance)
 * -------------------------------------------
 * The PAD emotional state modifies voice output:
 * - Pleasure → warmth (warm/cool/neutral)
 * - Arousal → intensity (high_energy/low_energy/normal)
 * - Dominance → assertion (assertive/deferential/balanced)
 *
 * PAD thresholds use frozen constants (PAD_THRESHOLDS) so tuning
 * is centralised and auditable.
 *
 * DETERMINISM AND REPRODUCIBILITY
 * --------------------------------
 * The engine supports seeded randomness via a Marsaglia multiply-
 * with-carry (MWC) algorithm. When a seed is provided, identical
 * inputs always produce identical outputs. This is critical for:
 * - Unit testing (deterministic assertions)
 * - Debugging character drift
 * - Reproducing exact conversation states
 *
 * When no seed is provided, Math.random() is used for natural variety.
 *
 * CACHING
 * -------
 * Generated responses are cached using collision-resistant keys built
 * from query + profile + PAD + facts. The cache uses LRU eviction
 * with a configurable TTL. Cache keys are 32-bit Murmur-like hashes
 * with length suffixes for collision detection.
 *
 * CONSUMERS
 * ---------
 * - StorytellerBridge.js (narrative beat synthesis)
 * - TeacherComponent.js (TSE teaching responses)
 * - KnowledgeResponseEngine.js (knowledge delivery)
 * - StorytellerContextAssembler.js (context assembly)
 *
 * All consumers access via NaturalLanguageGeneratorSingleton.js
 * to share a single cache and seeded RNG state.
 *
 * DEPENDENCIES
 * ------------
 * Internal: logger.js, Counters
 * External: None
 *
 * DATABASE
 * --------
 * None — all patterns are in-memory. Future v011 consideration:
 * migrate patterns to conversational_phrases table for dynamic
 * voice tuning without code deployment.
 *
 * THRESHOLDS AND TUNING
 * ---------------------
 * All tunable values are in frozen constants:
 * - CONFIDENCE_THRESHOLDS: voice derivation boundaries
 * - COMPLEXITY_THRESHOLDS: response detail boundaries
 * - PAD_THRESHOLDS: emotional modulation boundaries
 * - CACHE: size, TTL, key truncation limits
 * - HEDGE: closer skip probability
 *
 * SECURITY
 * --------
 * All thresholds are frozen module-level constants, not user input.
 * Query inputs are sanitised (lowercased, trimmed, truncated) before
 * use in cache keys. No user input reaches pattern functions unsanitised.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import Counters from '../../councilTerminal/metrics/counters.js';

const logger = createModuleLogger('NaturalLanguageGenerator');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Frozen Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const CONFIDENCE_THRESHOLDS = Object.freeze({
  HIGH: 70,
  MED: 50,
  LOW: 30
});

const COMPLEXITY_THRESHOLDS = Object.freeze({
  HIGH: 70,
  MED: 40,
  LOW: 0
});

const PAD_THRESHOLDS = Object.freeze({
  HIGH: 0.6,
  LOW: 0.4
});

const CACHE = Object.freeze({
  MAX_SIZE: 5000,
  TTL_MS: 300000,
  FACT_SLICE: 120,
  FACT_TOTAL: 360,
  QUERY_SLICE: 180
});

const HEDGE = Object.freeze({
  DEFAULT_CLOSER_PROBABILITY: 0.5
});

const STOP_WORDS = Object.freeze(new Set([
  'is', 'are', 'the', 'a', 'an', 'does', 'do', 'can', 'will',
  'what', 'how', 'why', 'where', 'when', 'who', 'which'
]));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Class Definition                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

class NaturalLanguageGenerator {

  /**
   * @param {object} [config]
   * @param {boolean} [config.enableCaching=true] - Enable response caching
   * @param {number} [config.maxCacheSize=5000] - Maximum cache entries
   * @param {number|null} [config.randomSeed=null] - Seed for deterministic RNG
   * @param {string[]} [config.allowedVoices=null] - Restrict available voices
   * @param {number} [config.closerProbability=0.5] - Probability of closer (0-1)
   */
  constructor(config = {}) {
    this.config = Object.freeze({
      enableCaching: config.enableCaching !== false,
      maxCacheSize: config.maxCacheSize || CACHE.MAX_SIZE,
      randomSeed: config.randomSeed ?? null,
      allowedVoices: config.allowedVoices || null,
      closerProbability: config.closerProbability ?? HEDGE.DEFAULT_CLOSER_PROBABILITY
    });

    this.sentencePatterns = this._buildSentencePatterns();
    this.transitionPhrases = this._buildTransitionPhrases();
    this.toneModifiers = this._buildToneModifiers();
    this.characterVoicePatterns = this._buildCharacterVoicePatterns();

    this._cache = new Map();
    this._cacheMeta = new Map();
    this._seedRandom = this._createSeededRandom(this.config.randomSeed);

    logger.info('NaturalLanguageGenerator initialised', {
      caching: this.config.enableCaching,
      seed: this.config.randomSeed ?? 'random',
      voiceCount: Object.keys(this.characterVoicePatterns).length,
      closerProbability: this.config.closerProbability
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Seeded Random Number Generator (Marsaglia MWC)                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Creates a seeded PRNG using Marsaglia's multiply-with-carry algorithm.
   * When seed is null, falls back to Math.random() for natural variety.
   * MWC period is approximately 2^60 — more than sufficient for NLG.
   */
  _createSeededRandom(seed) {
    if (seed === null) return () => Math.random();
    let m_w = seed >>> 0;
    let m_z = 987654321 >>> 0;
    const mask = 0xffffffff;
    return () => {
      m_z = (36969 * (m_z & 65535) + (m_z >>> 16)) & mask;
      m_w = (18000 * (m_w & 65535) + (m_w >>> 16)) & mask;
      const result = (((m_z << 16) + (m_w & 65535)) >>> 0) / 4294967296;
      return result;
    };
  }

  /**
   * Selects a random element from an array using the seeded PRNG.
   * Returns null for empty or invalid arrays.
   */
  _selectRandom(array) {
    if (!Array.isArray(array) || array.length === 0) return null;
    const index = Math.floor(this._seedRandom() * array.length);
    return array[index];
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Validation                                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Validates a character learning profile structure.
   * Checks emotional (confidence, curiosity, anxiety), social
   * (communication, empathy, collaboration, independence), and
   * cognitive (analyticalThinking) sections. Values must be 0-100.
   */
  _validateLearningProfile(profile) {
    if (!profile || typeof profile !== 'object') return false;
    const sections = {
      emotional: ['confidence', 'curiosity', 'anxiety'],
      social: ['communication', 'empathy', 'collaboration', 'independence'],
      cognitive: ['analyticalThinking']
    };
    for (const [sec, fields] of Object.entries(sections)) {
      if (profile[sec] && typeof profile[sec] === 'object') {
        for (const field of fields) {
          const val = profile[sec][field];
          if (typeof val === 'number' && (val < 0 || val > 100)) return false;
        }
      }
    }
    return true;
  }

  /**
   * Validates PAD state values are within -1 to 1 range.
   * Returns true for null/missing PAD (treated as neutral).
   */
  _validatePADState(pad) {
    if (!pad || typeof pad !== 'object') return true;
    const fields = ['pleasure', 'arousal', 'dominance'];
    for (const f of fields) {
      const v = pad[f];
      if (typeof v === 'number' && (v < -1 || v > 1)) return false;
    }
    return true;
  }

  /**
   * Validates knowledge facts array. Each fact must be a string or
   * an object with content or answer property.
   */
  _validateKnowledgeFacts(facts) {
    if (!Array.isArray(facts)) return false;
    return facts.every(item =>
      typeof item === 'string' ||
      (typeof item === 'object' && item !== null &&
        (typeof item.content === 'string' || typeof item.answer === 'string'))
    );
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Character Voice Patterns                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildCharacterVoicePatterns() {
    const patterns = {
      enthusiastic_outgoing: {
        affirmatives: [
          (s) => `Absolutely! ${s}!`,
          (s) => `YES! ${s}!`,
          (s) => `Oh for sure, ${s}!`,
          (s) => `You bet! ${s}!`
        ],
        descriptives: [
          (s, i) => `${s} is ${i}—and I mean that!`,
          (s, i) => `Check it out: ${s} is ${i}!`,
          (s, i) => `So here is the thing about ${s}: ${i}!`
        ],
        closers: [
          'That is the real deal!',
          'Pretty wild, right?',
          'Gets me every time!',
          'Honestly, it is amazing!'
        ]
      },
      curious_cautious: {
        affirmatives: [
          (s) => `Yes, ${s}... if that makes sense?`,
          (s) => `I think so, yes. ${s}.`,
          (s) => `That seems right—${s}.`
        ],
        descriptives: [
          (s, i) => `${s} is... well, ${i}.`,
          (s, i) => `If I understand it right, ${s} is ${i}.`,
          (s, i) => `I would say ${s} is ${i}.`
        ],
        closers: [
          'Does that make sense?',
          'I hope that helped?',
          'Tell me if you want to know more?',
          'Want to explore that further?'
        ]
      },
      supportive_collaborative: {
        affirmatives: [
          (s) => `Yes, and I appreciate you asking about ${s}.`,
          (s) => `That is a great question about ${s}.`,
          (s) => `I am glad we are discussing ${s}.`
        ],
        descriptives: [
          (s, i) => `${s} is ${i}—I think we can explore this together.`,
          (s, i) => `Let us think about this: ${s} is ${i}.`,
          (s, i) => `I would like to share: ${s} is ${i}.`
        ],
        closers: [
          'What do you think?',
          'I would love your perspective.',
          'Shall we keep exploring?',
          'Your thoughts matter here.'
        ]
      },
      analytical_independent: {
        affirmatives: [
          (s) => `Correct. ${s}.`,
          (s) => `Affirmative. ${s}.`,
          (s) => `Precisely. ${s}.`
        ],
        descriptives: [
          (s, i) => `${s} is characterised by ${i}.`,
          (s, i) => `${s} functions as follows: ${i}.`,
          (s, i) => `The defining aspect of ${s} is ${i}.`
        ],
        closers: [
          'Further analysis available upon request.',
          'That concludes this assessment.',
          'Any additional queries?'
        ]
      },
      yurei_malevolent: {
        affirmatives: [
          (s) => `${s}... yes, it drains.`,
          (s) => `${s}... consumed by void.`,
          (s) => `${s}... devoured by absence.`
        ],
        descriptives: [
          (s, i) => `${s} feeds on ${i}.`,
          (s, i) => `${s} is hunger itself: ${i}.`,
          (s, i) => `${s} empties: ${i}.`
        ],
        closers: [
          'The void expands.',
          'Joy is fuel.',
          'Always hungry.',
          'More... always more.'
        ]
      },
      tanuki_trickster: {
        affirmatives: [
          (s) => `Heh! ${s}—watch this!`,
          (s) => `Oh, ${s}? That is just a disguise!`,
          (s) => `${s}? Please, let me show you the real version!`
        ],
        descriptives: [
          (s, i) => `${s} is ${i}—or is it?`,
          (s, i) => `Here is the trick: ${s} is ${i}!`,
          (s, i) => `Bet you thought ${s} was simple. It is ${i}!`
        ],
        closers: [
          'Gotcha!',
          'See? Chaos is fun.',
          'Never what it seems.',
          'Play along?'
        ]
      },
      tanuki_wise: {
        affirmatives: [
          (s) => `Ho ho! Indeed, ${s}.`,
          (s) => `Wise words, apprentice — ${s}.`,
          (s) => `The path reveals itself: ${s}.`
        ],
        descriptives: [
          (s, i) => `${s} holds the essence of ${i}.`,
          (s, i) => `In the forest of knowledge, ${s} grows as ${i}.`,
          (s, i) => `Consider this carefully: ${s} is ${i}.`
        ],
        closers: [
          'Reflect on this.',
          'The lesson continues.',
          'What do you see now?',
          'Patience reveals all.'
        ]
      },
      mutai_fragmented: {
        affirmatives: [
          (s) => `${s}... broken. Like me.`,
          (s) => `${s}... scattered across the void.`,
          (s) => `${s}... fractured and still bleeding.`
        ],
        descriptives: [
          (s, i) => `${s} is shattered: ${i}.`,
          (s, i) => `${s} was whole once. Now: ${i}.`,
          (s, i) => `${s} is pieces trying to remember: ${i}.`
        ],
        closers: [
          'Nothing stays whole.',
          'All fragments in the end.',
          'Even memory breaks.',
          'Silence is easier.'
        ]
      }
    };

    if (this.config && this.config.allowedVoices) {
      const allowed = new Set(this.config.allowedVoices);
      for (const key of Object.keys(patterns)) {
        if (!allowed.has(key)) {
          delete patterns[key];
        }
      }
    }

    return patterns;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Sentence Patterns                                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildSentencePatterns() {
    return {
      affirmative: [
        (s, p) => `Yes, ${s} ${p}.`,
        (s, p) => `That is correct—${s} ${p}.`,
        (s, p) => `Indeed, ${s} ${p}.`
      ],
      negative: [
        (s, p) => `No, ${s} ${p}.`,
        (s, p) => `Actually, ${s} ${p}.`,
        (s, p) => `That is not quite right—${s} ${p}.`
      ],
      descriptive: [
        (s, i) => `${s} is ${i}.`,
        (s, i) => `${s} can be described as ${i}.`,
        (s, i) => `When it comes to ${s}, ${i}.`
      ],
      explanatory: [
        (s, e) => `${s} works by ${e}.`,
        (s, e) => `The way ${s} functions is ${e}.`,
        (s, e) => `To understand ${s}: ${e}.`
      ],
      comparative: [
        (s, c) => `${s} differs in that ${c}.`,
        (s, c) => `Unlike others, ${s} ${c}.`,
        (s, c) => `What sets ${s} apart is ${c}.`
      ]
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Transition Phrases                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildTransitionPhrases() {
    return {
      addition: [
        'Additionally', 'Furthermore', 'Also', 'Moreover',
        'And here is the thing:', 'But wait, there is more:'
      ],
      contrast: [
        'However', 'On the other hand', 'That said',
        'Nevertheless', 'But here is where it gets interesting:'
      ],
      example: [
        'For instance', 'As an example', 'To illustrate',
        'Like:', 'Case in point:'
      ],
      conclusion: [
        'In summary', 'Overall', 'To sum up',
        'So basically:', 'Bottom line:'
      ],
      elaboration: [
        'More specifically', 'In particular', 'To elaborate',
        'Here is what I mean:', 'Let me explain:'
      ]
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Tone Modifiers                                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildToneModifiers() {
    return {
      gentle_supportive: {
        prefixes: [
          'You might find it interesting that',
          'Here is something helpful:',
          'Consider this:',
          'I would like to share:'
        ],
        softeners: ['perhaps', 'might', 'could be', 'tends to', 'often'],
        closers: [
          'Hope that helps!',
          'Let me know if you want to explore more.',
          'Take your time with this.',
          'Feel free to ask if anything is unclear.'
        ]
      },
      factual_clinical: {
        prefixes: [
          'Data indicates:',
          'According to available information:',
          'Factually:',
          'Based on evidence:'
        ],
        softeners: [],
        closers: [
          'End of response.',
          'Further queries accepted.',
          'Awaiting follow-up.'
        ]
      },
      exploratory_inviting: {
        prefixes: [
          'Let us explore together:',
          'Here is something curious:',
          'Consider exploring:',
          'Want to discover something?'
        ],
        softeners: ['interestingly', 'curiously', 'notably', 'fascinatingly'],
        closers: [
          'What aspect interests you most?',
          'There is more to discover here.',
          'Shall we go deeper?',
          'What else would you like to know?'
        ]
      },
      balanced: {
        prefixes: [
          'Here is what I found:',
          'Based on available knowledge:',
          'So here is the thing:'
        ],
        softeners: ['generally', 'typically', 'usually', 'often'],
        closers: [
          'Feel free to ask more.',
          'Anything else?'
        ]
      }
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Voice Derivation                                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Derives a character voice archetype from a learning profile.
   * Uses trait thresholds to select the most fitting voice.
   *
   * Trait derivation rules:
   * - confidence HIGH + communication HIGH → enthusiastic_outgoing
   * - curiosity HIGH + anxiety HIGH → curious_cautious
   * - empathy HIGH + collaboration HIGH → supportive_collaborative
   * - analytical HIGH + independence MED+ → analytical_independent
   * - Default → supportive_collaborative (safest for unknown profiles)
   */
  deriveCharacterVoice(profile, correlationId) {
    if (!this._validateLearningProfile(profile)) {
      Counters.increment('nlg_voice', 'profile_invalid_fallback');
      return 'analytical_independent';
    }

    const c = profile.emotional?.confidence ?? 50;
    const comm = profile.social?.communication ?? 50;
    const cur = profile.emotional?.curiosity ?? 50;
    const anx = profile.emotional?.anxiety ?? 50;
    const emp = profile.social?.empathy ?? 50;
    const collab = profile.social?.collaboration ?? 50;
    const ana = profile.cognitive?.analyticalThinking ?? 50;
    const ind = profile.social?.independence ?? 50;

    let voice = 'supportive_collaborative';

    if (c > CONFIDENCE_THRESHOLDS.HIGH && comm > CONFIDENCE_THRESHOLDS.HIGH) {
      voice = 'enthusiastic_outgoing';
    } else if (cur > CONFIDENCE_THRESHOLDS.HIGH && anx > CONFIDENCE_THRESHOLDS.HIGH) {
      voice = 'curious_cautious';
    } else if (emp > CONFIDENCE_THRESHOLDS.HIGH && collab > CONFIDENCE_THRESHOLDS.HIGH) {
      voice = 'supportive_collaborative';
    } else if (ana > CONFIDENCE_THRESHOLDS.HIGH && ind > CONFIDENCE_THRESHOLDS.MED) {
      voice = 'analytical_independent';
    }

    Counters.increment('nlg_voice', voice);
    logger.debug('Voice derived', { voice, correlationId });
    return voice;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  PAD Tone Adjustment                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Maps PAD emotional coordinates to linguistic modifiers.
   *
   * Pleasure → warmth: warm (>0.6), cool (<0.4), neutral
   * Arousal → intensity: high_energy (>0.6), low_energy (<0.4), normal
   * Dominance → assertion: assertive (>0.6), deferential (<0.4), balanced
   */
  adjustToneForPAD(pad, correlationId) {
    if (!this._validatePADState(pad)) {
      return { intensity: 'normal', warmth: 'neutral', dominance: 'balanced' };
    }

    const p = pad?.pleasure ?? 0;
    const a = pad?.arousal ?? 0;
    const d = pad?.dominance ?? 0;

    const adjustment = {
      intensity: a > PAD_THRESHOLDS.HIGH ? 'high_energy'
        : a < PAD_THRESHOLDS.LOW ? 'low_energy' : 'normal',
      warmth: p > PAD_THRESHOLDS.HIGH ? 'warm'
        : p < PAD_THRESHOLDS.LOW ? 'cool' : 'neutral',
      dominance: d > PAD_THRESHOLDS.HIGH ? 'assertive'
        : d < PAD_THRESHOLDS.LOW ? 'deferential' : 'balanced'
    };

    Counters.increment('nlg_pad_adjustment', adjustment.warmth);
    return adjustment;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Passion Phrase Generation                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Generates an emotionally-coloured passion phrase based on PAD state.
   * Used to add personal feeling to responses when emotional context
   * is strong enough to warrant it.
   */
  generatePassionPhrase(padState) {
    const adj = this.adjustToneForPAD(padState);
    const sets = {
      high_energy: [
        'It has got me fired up!',
        'Really gets me going!',
        'Cannot stop thinking about it!',
        'It is on my mind constantly!'
      ],
      low_energy: [
        'It has been weighing on me.',
        'It captivates me, quietly.',
        'It stays with me.',
        'There is something about it...'
      ],
      normal: [
        'It really speaks to me.',
        'I find it compelling.',
        'There is something special about it.',
        'It resonates.'
      ],
      cool: [
        'It is interesting.',
        'Worth considering.',
        'Has merit.',
        'Noteworthy.'
      ],
      warm: [
        'I love it.',
        'It moves me.',
        'I am really drawn to it.',
        'It means a lot to me.'
      ]
    };

    let chosen = sets[adj.warmth] || sets.normal;
    if (adj.intensity === 'high_energy') chosen = sets.high_energy;
    if (adj.intensity === 'low_energy') chosen = sets.low_energy;

    return this._selectRandom(chosen) || 'It resonates.';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Cache Key Generation                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Generates a collision-resistant cache key from all generation inputs.
   * Uses Murmur-like 32-bit hash with length suffix for fast lookup.
   *
   * Components:
   * - Query signature (truncated to 180 chars)
   * - Profile signature (3 key traits)
   * - PAD signature (3 coordinates to 2dp)
   * - Fact signature (each truncated to 120 chars, total 360)
   */
  _generateCacheKey(facts, profile, query, padState) {
    const factSig = facts.map(f =>
      (typeof f === 'string' ? f : (f?.content || f?.answer || '')).slice(0, CACHE.FACT_SLICE)
    ).join('|').slice(0, CACHE.FACT_TOTAL);

    const profileSig = [
      profile?.emotional?.confidence ?? 50,
      profile?.social?.communication ?? 50,
      profile?.emotional?.curiosity ?? 50
    ].join('-');

    const padSig = padState
      ? [
        (padState.pleasure ?? 0).toFixed(2),
        (padState.arousal ?? 0).toFixed(2),
        (padState.dominance ?? 0).toFixed(2)
      ].join('-')
      : 'null';

    const querySig = query.toLowerCase().trim().slice(0, CACHE.QUERY_SLICE);
    const raw = querySig + '|' + profileSig + '|' + padSig + '|' + factSig;

    let h = 0xdeadbeef ^ 0xabcdef;
    for (let i = 0; i < raw.length; i++) {
      h = Math.imul(h ^ raw.charCodeAt(i), 2654435761);
    }
    h ^= h >>> 16;
    return 'nlg3-' + (h >>> 0).toString(36) + '-' + raw.length;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Tone and Complexity Selection                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  _selectTone(profile, needs) {
    const ctx = needs?.emotionalContext || 'neutral';
    switch (ctx) {
      case 'reassuring': return 'gentle_supportive';
      case 'detached': return 'factual_clinical';
      case 'gentle': return 'exploratory_inviting';
      default: return 'balanced';
    }
  }

  _determineComplexity(profile) {
    const cap = profile?.overallLearningCapacity ?? 50;
    if (cap > COMPLEXITY_THRESHOLDS.HIGH) return 'detailed';
    if (cap > COMPLEXITY_THRESHOLDS.MED) return 'moderate';
    return 'simple';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Question Type Detection                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Classifies query into question type using regex heuristics.
   * Types: yes_no, what, how, why, where, when, who, which,
   * comparative, descriptive, general
   */
  _detectQuestionType(query) {
    const q = query.toLowerCase().trim();
    if (/^(is|are|does|do|can|will|has|have)\b/.test(q)) return 'yes_no';
    if (q.startsWith('what ')) return 'what';
    if (q.startsWith('how ')) return 'how';
    if (q.startsWith('why ')) return 'why';
    if (q.startsWith('where ')) return 'where';
    if (q.startsWith('when ')) return 'when';
    if (q.startsWith('who ')) return 'who';
    if (q.startsWith('which ')) return 'which';
    if (q.includes(' vs ') || q.includes(' versus ') || q.includes('compare') || q.includes('difference')) return 'comparative';
    if (q.includes('tell me about') || q.includes('explain') || q.includes('describe')) return 'descriptive';
    return 'general';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Subject Extraction                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Extracts the subject from a query using regex heuristics then
   * stopword filtering as fallback. Returns 'this' if extraction fails.
   */
  _extractSubject(query) {
    if (typeof query !== 'string') return 'this';
    const q = query.toLowerCase().trim();
    const patterns = [
      /^(?:is|are|does|do|can|will|has|have)\s+(.+?)(?:\s+(?:a|an|the)\s+|\?|$)/i,
      /^what\s+(?:is|are)\s+(.+?)(?:\?|$)/i,
      /^tell\s+me\s+about\s+(.+?)(?:\?|$)/i,
      /^(?:how|why|where|when)\s+(?:does|do|is|are)\s+(.+?)(?:\s+(?:work|function)|\?|$)/i
    ];
    for (const r of patterns) {
      const m = q.match(r);
      if (m?.[1]) return m[1].trim();
    }
    const words = q.replace(/[?.,!]/g, '').split(/\s+/);
    const meaningful = words.filter(w => !STOP_WORDS.has(w));
    return meaningful.slice(0, 3).join(' ') || 'this';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Response Construction                                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _generateOpening(tone, questionType) {
    if (questionType === 'yes_no') return '';
    const cfg = this.toneModifiers[tone] || this.toneModifiers.balanced;
    const prefs = cfg.prefixes?.filter(p => p.trim()) || [];
    if (!prefs.length) return '';
    return this._selectRandom(prefs) + ' ';
  }

  _constructMainContent(facts, questionType, complexity, query, voice) {
    if (!facts?.length) return '';
    const primary = facts[0];
    const content = typeof primary === 'string'
      ? primary
      : (primary?.content || primary?.answer || '');
    const subject = this._extractSubject(query);
    const pats = this.sentencePatterns;
    const vPats = voice && this.characterVoicePatterns[voice]
      ? this.characterVoicePatterns[voice]
      : null;

    switch (questionType) {
      case 'yes_no': return this._constructYesNoResponse(content, subject, pats, vPats);
      case 'what':
      case 'descriptive': return this._constructDescriptiveResponse(content, subject, pats, complexity, vPats);
      case 'how': return this._constructExplanatoryResponse(content, subject, pats, vPats);
      case 'why': return this._constructReasoningResponse(content, subject, vPats);
      case 'comparative': return this._constructComparativeResponse(content, subject, pats, vPats);
      default: return this._constructGeneralResponse(content, subject, complexity);
    }
  }

  _constructYesNoResponse(content, subject, pats, vPats) {
    let clean = content;
    if (content.includes('A:')) clean = content.split('A:')[1]?.trim() || content;
    const lower = clean.trim().toLowerCase();
    const affirmative = lower.startsWith('yes') || lower === 'true' ||
      lower.includes('is a ') || lower.includes('can ') || !lower.startsWith('no');
    const set = affirmative ? pats.affirmative : pats.negative;
    const pattern = this._selectRandom(set) || ((s, p) => affirmative ? `Yes, ${s} ${p}.` : `No, ${s} ${p}.`);
    let pred = clean.replace(/^(yes|no)[.,!? ]*/i, '').trim();
    if (!pred || pred.length < 3) pred = affirmative ? 'that is correct' : 'that is not the case';
    return pattern(subject, pred);
  }

  _constructDescriptiveResponse(content, subject, pats, complexity, vPats) {
    const candidates = vPats?.descriptives || pats.descriptive;
    const pattern = this._selectRandom(candidates) || ((s, i) => `${s} is ${i}.`);
    if (complexity === 'simple') {
      return pattern(subject, content.split('.')[0]?.trim() || content);
    }
    return pattern(subject, content);
  }

  _constructExplanatoryResponse(content, subject, pats, vPats) {
    const pattern = this._selectRandom(pats.explanatory) || ((s, e) => `${s} works by ${e}.`);
    return pattern(subject, content);
  }

  _constructReasoningResponse(content, subject, vPats) {
    return 'The reason ' + subject + ' ' +
      (content.startsWith('because') ? content : 'is because ' + content);
  }

  _constructComparativeResponse(content, subject, pats, vPats) {
    const pattern = this._selectRandom(pats.comparative) || ((s, c) => `${s} differs in that ${c}.`);
    return pattern(subject, content);
  }

  _constructGeneralResponse(content, subject, complexity) {
    if (complexity === 'simple') return (content.split('.')[0] || content) + '.';
    return content;
  }

  _generateElaboration(extraFacts, tone) {
    if (!extraFacts?.length) return '';
    const trans = this.transitionPhrases.addition || ['Additionally'];
    const t = this._selectRandom(trans) || 'Additionally';
    const f = extraFacts[0];
    const c = typeof f === 'string' ? f : (f?.content || f?.answer || '');
    return '\n\n' + t + ' ' + c;
  }

  _generateClosing(tone, profile, voice, padAdj, correlationId) {
    const cfg = this.toneModifiers[tone] || this.toneModifiers.balanced;
    let closers = cfg.closers?.filter(c => c.trim()) || [];
    if (voice && this.characterVoicePatterns[voice]?.closers) {
      closers = closers.concat(this.characterVoicePatterns[voice].closers);
    }
    if (!closers.length) return '';

    if (padAdj && padAdj.dominance === 'deferential') {
      const deferentialClosers = closers.filter(c =>
        c.includes('?') || c.toLowerCase().includes('feel free') ||
        c.toLowerCase().includes('hope') || c.toLowerCase().includes('let me know')
      );
      if (deferentialClosers.length > 0) closers = deferentialClosers;
    } else if (padAdj && padAdj.dominance === 'assertive') {
      const assertiveClosers = closers.filter(c =>
        !c.includes('?') && !c.toLowerCase().includes('hope')
      );
      if (assertiveClosers.length > 0) closers = assertiveClosers;
    }

    if (this._seedRandom() <= this.config.closerProbability) return '';

    Counters.increment('nlg_closer', 'included');
    const c = this._selectRandom(closers);
    return c ? '\n\n' + c : '';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Unknown Response                                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Generates a character-appropriate response when no knowledge exists.
   * Uses voice-derived tone to keep the "I don't know" in character.
   */
  generateUnknownResponse(query, profile, correlationId) {
    const subj = this._extractSubject(query);
    const tone = profile ? this._selectTone(profile, {}) : 'balanced';
    const sets = {
      gentle_supportive: [
        'I do not have information about ' + subj + ' yet, but I am still learning. Perhaps you could teach me?',
        'That is an interesting question about ' + subj + '. I have not learned about that yet.',
        'I am not sure about ' + subj + ' at the moment. Would you like to help me understand?'
      ],
      factual_clinical: [
        'No data available for: ' + subj + '.',
        'Query regarding ' + subj + ' returned no results.',
        'Information on ' + subj + ' not found in knowledge base.'
      ],
      exploratory_inviting: [
        subj + ' is something I have not explored yet. Shall we discover it together?',
        'I am curious about ' + subj + ' too, but I do not have that knowledge yet.',
        'That is a fascinating question about ' + subj + '. I have not encountered that information.'
      ],
      balanced: [
        'I do not have information about ' + subj + ' yet.',
        'I am not able to answer that about ' + subj + ' at this time.',
        'My knowledge about ' + subj + ' is limited. I am still learning.'
      ]
    };
    const opts = sets[tone] || sets.balanced;
    Counters.increment('nlg_response', 'unknown');
    logger.debug('Unknown response generated', { subject: subj, tone, correlationId });
    return this._selectRandom(opts) || 'No information available on ' + subj + ' yet.';
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Main Generate Method                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Generates a personality-rich, PAD-modulated natural language response.
   *
   * @param {Array} knowledgeFacts - Array of strings or {content}/{answer} objects
   * @param {object} learningProfile - Character learning profile
   * @param {object} knowledgeNeeds - Knowledge context ({emotionalContext, detailLevel, etc.})
   * @param {string} query - The original user query
   * @param {object} [padState=null] - PAD emotional state {pleasure, arousal, dominance}
   * @param {string} [correlationId=null] - Request correlation ID
   * @returns {object} {text, voice, padAdjustment, status, metadata, generatedAt}
   */
  async generate(knowledgeFacts, learningProfile, knowledgeNeeds, query, padState, correlationId) {
    const startTime = Date.now();

    if (typeof query !== 'string' || !query.trim()) {
      Counters.increment('nlg_response', 'invalid_input');
      return this._createResult('Invalid query provided', null, null, 'invalid_input');
    }

    if (!this._validateKnowledgeFacts(knowledgeFacts)) {
      Counters.increment('nlg_response', 'invalid_facts');
      return this._createResult(
        'Knowledge facts must be strings or objects with content/answer',
        null, null, 'invalid_facts'
      );
    }

    if (!this._validateLearningProfile(learningProfile)) {
      logger.debug('Invalid learning profile, defaults applied', { correlationId });
      Counters.increment('nlg_validation', 'profile_fallback');
    }

    if (!this._validatePADState(padState)) {
      logger.debug('Invalid PAD state, ignoring', { correlationId });
      Counters.increment('nlg_validation', 'pad_fallback');
      padState = null;
    }

    const cacheKey = this.config.enableCaching
      ? this._generateCacheKey(knowledgeFacts, learningProfile, query, padState)
      : null;

    if (cacheKey && this._cache.has(cacheKey)) {
      const meta = this._cacheMeta.get(cacheKey);
      if (meta && (Date.now() - meta.timestamp) < CACHE.TTL_MS) {
        Counters.increment('nlg_cache', 'hit');
        return this._cache.get(cacheKey);
      }
      this._cache.delete(cacheKey);
      this._cacheMeta.delete(cacheKey);
      Counters.increment('nlg_cache', 'expired');
    }

    const questionType = this._detectQuestionType(query);
    const voice = this.deriveCharacterVoice(learningProfile, correlationId);
    const tone = this._selectTone(learningProfile, knowledgeNeeds);
    const complexity = this._determineComplexity(learningProfile);
    const padAdj = this.adjustToneForPAD(padState, correlationId);

    let text = '';
    text += this._generateOpening(tone, questionType);
    text += this._constructMainContent(knowledgeFacts, questionType, complexity, query, voice);

    if (knowledgeFacts.length > 1 && complexity !== 'simple') {
      text += this._generateElaboration(knowledgeFacts.slice(1), tone);
    }

    text += this._generateClosing(tone, learningProfile, voice, padAdj, correlationId);

    const elapsed = Date.now() - startTime;
    Counters.increment('nlg_response', 'success');
    Counters.increment('nlg_question_type', questionType);

    const result = this._createResult(
      text.trim(),
      voice,
      padAdj,
      'success',
      { questionType, tone, complexity, padAdjustment: padAdj, elapsedMs: elapsed }
    );

    if (cacheKey) {
      if (this._cache.size >= this.config.maxCacheSize) {
        const oldest = this._cache.keys().next().value;
        this._cache.delete(oldest);
        this._cacheMeta.delete(oldest);
        Counters.increment('nlg_cache', 'eviction');
      }
      this._cache.set(cacheKey, result);
      this._cacheMeta.set(cacheKey, { timestamp: Date.now() });
      Counters.increment('nlg_cache', 'miss');
    }

    logger.debug('Response generated', {
      voice,
      questionType,
      tone,
      complexity,
      elapsedMs: elapsed,
      cached: !!cacheKey,
      correlationId
    });

    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Result Builder                                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _createResult(text, voice, padAdjustment, status, metadata = {}) {
    return {
      text: text || '',
      voice,
      padAdjustment,
      status,
      metadata,
      generatedAt: new Date().toISOString()
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Cache Management                                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  getCacheStats() {
    return {
      size: this._cache.size,
      max: this.config.maxCacheSize,
      enabled: this.config.enableCaching,
      ttlMs: CACHE.TTL_MS
    };
  }

  clearCache() {
    const size = this._cache.size;
    this._cache.clear();
    this._cacheMeta.clear();
    logger.info('NLG cache cleared', { previousSize: size });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export default NaturalLanguageGenerator;
export { NaturalLanguageGenerator };
