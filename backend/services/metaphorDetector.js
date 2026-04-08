/**
 * ============================================================================
 * metaphorDetector.js — Figurative Language Detection Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Detects metaphorical and figurative language in user input. This is one
 * of the 6 weighted signals in learningDetector's unfamiliar language
 * detection system (weight: 0.15, signal name: "metaphor").
 *
 * When a user speaks figuratively ("drowning in grief", "the void consumed
 * my joy"), Claude needs to know this is not literal language. Metaphor
 * detection helps learningDetector distinguish between genuinely unfamiliar
 * language and figurative expressions that PAD/n-gram analysis might
 * misclassify as "unknown".
 *
 * HOW IT WORKS
 * ------------
 * Two complementary detection methods run in sequence:
 *
 * 1. SYNTACTIC PATTERN MATCHING (high precision, limited recall)
 *    37 regex patterns targeting known metaphor constructions, heavily
 *    weighted toward The Expanse universe (yokai, grief, retro gaming,
 *    konbini, bosozoku, tanuki, yurei feeding). If any pattern matches,
 *    detection returns immediately with high confidence.
 *
 * 2. SEMANTIC INCONGRUITY via CONCRETENESS MISMATCH (broader recall)
 *    Based on Lakoff & Johnson's Conceptual Metaphor Theory and
 *    operationalised via Turney et al. (2011) concreteness scoring.
 *    Trains on the LTLM corpus to build a domain-specific concreteness
 *    map (physical vs abstract word contexts). When a concrete verb
 *    meets an abstract object with a delta > 0.6, flags as metaphor.
 *    This catches novel metaphors the regex patterns miss.
 *
 * TRAINING
 * --------
 * Must call train() at startup. Queries ltlm_training_examples for
 * utterances with tags, builds concreteness scores from physical vs
 * abstract context co-occurrence. Results are cached in memory.
 * If train() fails or has not been called, detect() returns a neutral
 * (non-metaphor) result for concreteness phase — pattern matching still
 * works without training.
 *
 * INPUT SAFETY
 * ------------
 * Inputs exceeding MAX_INPUT_LENGTH (10000 chars) are truncated before
 * processing. Truncation events are logged for observability.
 *
 * All simile regex patterns use bounded quantifiers ({1,50}) instead of
 * lazy/greedy quantifiers (+?) to guarantee linear-time matching and
 * prevent catastrophic backtracking on adversarial input.
 *
 * CACHING
 * -------
 * Two cache layers:
 * - patternCache: Full detection results keyed by normalised input (FIFO)
 * - concretenessCache: Individual word lookups from concreteness map
 *
 * EARWIG INTEGRATION
 * ------------------
 * learningDetector imports this singleton and calls detect() as part of
 * its 6-signal analysis. The metaphor signal (weight 0.15) fires when
 * isMetaphor === true, helping distinguish figurative language from
 * genuinely unknown phrases.
 *
 * CHANGES FROM v009
 * -----------------
 * - Structured logger replaces console.log
 * - Full v010 documentation header
 * - detect() returns neutral result when untrained (no throw)
 * - Input length cap prevents DoS on pathological input
 * - Truncation events logged for observability
 * - Bounded regex quantifiers prevent catastrophic backtracking
 * - Error handling on train() DB query
 * - Patterns frozen after construction
 * - extractObjects filters stop words and known verbs
 * - Expanded common verbs set for better verb extraction
 * - Dead getWordConcreteness method removed (duplicate of cached version)
 * - clearCache() method added for memory management
 * - Confidence scales smoothly with concreteness delta
 * - Cache key uses full normalised input (no truncation)
 *
 * NAMING CONVENTIONS
 * ------------------
 * Export: singleton instance (camelCase) — matches padEstimator pattern
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('MetaphorDetector');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const MAX_CACHE_SIZE = 5000;
const MAX_INPUT_LENGTH = 10000;
const MAX_SIMILE_CAPTURE_LENGTH = 50;
const CONCRETENESS_DELTA_THRESHOLD = 0.6;
const MIN_CONCRETENESS_CONFIDENCE = 3;
const PATTERN_CONFIDENCE = 0.90;
const MIN_INCONGRUITY_CONFIDENCE = 0.55;
const MAX_INCONGRUITY_CONFIDENCE = 0.85;
const INCONGRUITY_SCALE_FACTOR = 0.625;
const MIN_WORD_LENGTH = 3;
const MIN_TOKEN_LENGTH = 2;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Stop Words (shared with tokeniser for object filtering)                   */
/* ────────────────────────────────────────────────────────────────────────── */

const STOP_WORDS = Object.freeze(new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'me', 'my',
  'your', 'we', 'us', 'our', 'they', 'them', 'their', 'he',
  'she', 'him', 'her', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'not', 'no', 'but', 'or', 'and', 'if', 'then', 'so',
  'just', 'very', 'really', 'too', 'also', 'much', 'more',
  'some', 'any', 'all', 'each', 'every', 'both', 'few',
  'many', 'most', 'other', 'another', 'such', 'what', 'which',
  'who', 'whom', 'how', 'when', 'where', 'why', 'here', 'there',
  'now', 'then', 'than', 'about', 'up', 'out', 'down', 'off'
]));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Known Verbs Set (expanded for The Expanse domain)                         */
/* ────────────────────────────────────────────────────────────────────────── */

const KNOWN_VERBS = Object.freeze(new Set([
  'is', 'are', 'was', 'were', 'am',
  'feel', 'feels', 'felt', 'feeling',
  'seem', 'seems', 'seemed', 'seeming',
  'become', 'becomes', 'became', 'becoming',
  'bleed', 'bleeds', 'bled', 'bleeding',
  'drown', 'drowns', 'drowned', 'drowning',
  'fracture', 'fractures', 'fractured', 'fracturing',
  'shatter', 'shatters', 'shattered', 'shattering',
  'fill', 'fills', 'filled', 'filling',
  'press', 'presses', 'pressed', 'pressing',
  'consume', 'consumes', 'consumed', 'consuming',
  'devour', 'devours', 'devoured', 'devouring',
  'drain', 'drains', 'drained', 'draining',
  'fade', 'fades', 'faded', 'fading',
  'vanish', 'vanishes', 'vanished', 'vanishing',
  'crush', 'crushes', 'crushed', 'crushing',
  'burn', 'burns', 'burned', 'burning',
  'haunt', 'haunts', 'haunted', 'haunting',
  'engulf', 'engulfs', 'engulfed', 'engulfing',
  'swallow', 'swallows', 'swallowed', 'swallowing',
  'pull', 'pulls', 'pulled', 'pulling',
  'sink', 'sinks', 'sank', 'sinking',
  'weigh', 'weighs', 'weighed', 'weighing',
  'burden', 'burdens', 'burdened', 'burdening',
  'crack', 'cracks', 'cracked', 'cracking',
  'split', 'splits', 'splitting',
  'break', 'breaks', 'broke', 'broken', 'breaking',
  'steal', 'steals', 'stole', 'stolen', 'stealing',
  'extinguish', 'extinguishes', 'extinguished',
  'vanquish', 'vanquishes', 'vanquished',
  'feed', 'feeds', 'fed', 'feeding',
  'lure', 'lures', 'lured', 'luring',
  'ensnare', 'ensnares', 'ensnared',
  'trick', 'tricks', 'tricked', 'tricking',
  'transform', 'transforms', 'transformed',
  'shapeshift', 'shapeshifts', 'shapeshifted'
]));

const VERB_SUFFIXES = Object.freeze(['ing', 'ed', 'es']);
const MIN_VERB_SUFFIX_LENGTH = 5;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Metaphor Patterns (Frozen — Domain-Specific)                              */
/*                                                                            */
/*  REGEX SAFETY: Simile patterns use bounded quantifiers {1,50} instead     */
/*  of lazy quantifiers +? to guarantee linear-time matching and prevent     */
/*  catastrophic backtracking on adversarial input.                           */
/* ────────────────────────────────────────────────────────────────────────── */

const METAPHOR_PATTERNS = Object.freeze([
  /* ── Generic Simile Structures (bounded quantifiers) ───────────────── */
  { regex: /\blike\s+([a-zA-Z\s]{1,50})(?=\s|$|[.,])/i, name: 'simile_like' },
  { regex: /\bas\s+(if|though)\s+([a-zA-Z\s]{1,50})(?=\s|$|[.,])/i, name: 'simile_as_if' },
  { regex: /\bfeels?\s+like\s+([a-zA-Z\s]{1,50})(?=\s|$|[.,])/i, name: 'simile_feels' },
  { regex: /\b(as|like)\s+a\s+([a-zA-Z\s]{1,50})(?=\s|$|[.,])/i, name: 'simile_as_a' },

  /* ── Yokai / Spirit World ──────────────────────────────────────────── */
  { regex: /\b(as|like)\s+(a|an)\s+(tanuki|kitsune|yokai|ghost|pineapple spirit)/i, name: 'yokai_simile' },
  { regex: /\b(shapeshift|shapeshifting|transform|transformed)\s+(into|like)\s+(tanuki|kitsune|yokai|yurei|ghost|spirit)/i, name: 'yokai_shapeshift' },
  { regex: /\b(tengu|long nose|red face)\s+(arrogant|proud|strutting|high nose)/i, name: 'tengu_arrogance' },
  { regex: /\b(onryo|vengeful spirit|yurei)\s+(rage|burning|haunting|draining)/i, name: 'onryo_vengeance' },
  { regex: /\b(kappa|turtle demon|water imp)\s+(trick|prank|pull under)/i, name: 'kappa_trick' },
  { regex: /\b(jorogumo|spider woman)\s+(lure|ensnare|web of deceit)/i, name: 'jorogumo_seduction' },

  /* ── Grief / Torment / Void ────────────────────────────────────────── */
  { regex: /\b(weigh|weighing|weighed|burden|burdened|crushed|crushing)\s+(down|by|under|with)\s+(grief|loss|pain|torment|sorrow|mutai)/i, name: 'grief_weight' },
  { regex: /\b(heart|soul|mind)\s+(shatter|shattered|shattering|broken|fractured|cracked|split|fragmented)/i, name: 'fractured_soul' },
  { regex: /\b(drown|drowning|drowned|sinking|submerged)\s+in\s+(grief|sorrow|pain|torment|loss|void|expanse)/i, name: 'grief_drowning' },
  { regex: /\b(storm|tsunami|wave|waves)\s+of\s+(grief|pain|loss|torment|rage|yurei)/i, name: 'grief_storm' },
  { regex: /\b(shadow|darkness|void|emptiness|vacuum|white void)\s+of\s+(loss|grief|absence|joylessness|malevolence)/i, name: 'void_of_loss' },
  { regex: /\b(consume|consumed|devour|devoured|eaten|drain|drained|draining|mined)\s+by\s+(grief|pain|malevolence|torment|void|yurei)/i, name: 'torment_consume' },

  /* ── Joy Drain / Pineaple Yurei ────────────────────────────────────── */
  { regex: /\b(void|vacuum|emptiness|absence|drain|drained|draining|sucked|pulled|devoured)\s+(of|from|away)\s+(joy|light|warmth|life|soul|cheese soul)/i, name: 'joy_vacuum' },
  { regex: /\b(darkness|black|void|white void|formless)\s+(swallow|swallowing|engulf|engulfing|consume|consuming)/i, name: 'joy_devouring_dark' },
  { regex: /\b(joy|light|warmth|cheese soul)\s+(fade|fading|drained|stolen|vanish|vanished|extinguished|vanquished)/i, name: 'joy_extinguished' },
  { regex: /\b(feed|feeding|fuel|mined|drain|draining)\s+on\s+(joy|emotion|pain|torment|cheese soul)/i, name: 'yurei_feeding' },

  /* ── Retro Gaming / Arcade ─────────────────────────────────────────── */
  { regex: /\b(level up|power up|glitch|pixelated|boss battle|final boss)\s+(in|of|against)\s+(pain|torment|void|expanse|cheese war)/i, name: 'retro_level_up' },
  { regex: /\b(insert coin|extra life|game over|continue)\s+(for|to)\s+(joy|hope|fight|yurei)/i, name: 'arcade_joy_coin' },
  { regex: /\b(high score|record breaker|cheat code)\s+in\s+(torment|grief|malevolence)/i, name: 'retro_high_score' },

  /* ── Konbini / Vending Machine ─────────────────────────────────────── */
  { regex: /\b(konbini|convenience store|bright light|glowing sign)\s+in\s+(darkness|night|void|expanse)/i, name: 'konbini_beacon' },
  { regex: /\b(always open|24-hour glow|instant comfort|onigiri soul)\s+(amid|against)\s+(torment|emptiness|joy drain)/i, name: 'konbini_reliable' },
  { regex: /\b(vending machine|\u81EA\u52D5\u8CA9\u58F2\u6A5F)\s+(glow|glowing|shining|alone)\s+in\s+(snow|darkness|void|expanse)/i, name: 'vending_glow_isolation' },
  { regex: /\b(coin drop|button press|dispense joy|dispense hope)\s+(from|into)\s+(void|emptiness|malevolence)/i, name: 'vending_dispense' },

  /* ── Bosozoku / Rebel ──────────────────────────────────────────────── */
  { regex: /\b(roar|revving|thunder)\s+of\s+(bosozoku|bike gang|rebel tribe|violent run)/i, name: 'bosozoku_roar' },
  { regex: /\b(flame|fire|speed demon|rebel)\s+through\s+(night|darkness|void|cheese war)/i, name: 'bosozoku_rebel' },
  { regex: /\b(tokko fuku|special attack suit|kanji jacket)\s+(ride|charge|defy)\s+(conformity|malevolence|yurei)/i, name: 'bosozoku_defiance' },

  /* ── Tanuki Mischief ───────────────────────────────────────────────── */
  { regex: /\b(tanuki|mischief|prank|trickster|chaotic fun)\s+(spark|gleam|twinkle|grin)\s+in\s+(darkness|void|torment)/i, name: 'tanuki_mischief_light' },
  { regex: /\b(laugh|smile|grin|playful chaos)\s+through\s+(pain|grief|torment|void|expanse)/i, name: 'mischief_through_pain' }
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  MetaphorDetector Class                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

class MetaphorDetector {

  constructor() {
    this._concretenessMap = new Map();
    this._concretenessCache = new Map();
    this._patternCache = new Map();
    this._trained = false;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Training                                                                */
  /*                                                                          */
  /*  Queries LTLM corpus for tagged utterances and builds a per-word         */
  /*  concreteness score based on physical vs abstract context co-occurrence. */
  /*  Must be called at startup before detect() will produce concreteness     */
  /*  mismatch results (pattern matching works without training).             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async train() {
    try {
      const queryPromise = pool.query(`
        SELECT utterance_text, tags
        FROM ltlm_training_examples
        WHERE tags IS NOT NULL
      `);
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Training query timeout after 15000ms")), 15000);
      });
      const result = await Promise.race([queryPromise, timeoutPromise]);
      clearTimeout(timeoutId);

      const wordContexts = new Map();

      for (const row of result.rows) {
        const words = this._tokenise(row.utterance_text);
        const tags = row.tags || [];

        const hasPhysical = tags.some(t =>
          t.includes('physical') ||
          t.includes('sensory') ||
          t.includes('body') ||
          t.includes('concrete')
        );

        const hasAbstract = tags.some(t =>
          t.includes('emotional') ||
          t.includes('cognitive') ||
          t.includes('abstract') ||
          t.includes('conceptual')
        );

        for (const word of words) {
          if (!wordContexts.has(word)) {
            wordContexts.set(word, { physical: 0, abstract: 0, total: 0 });
          }

          const context = wordContexts.get(word);
          if (hasPhysical) context.physical++;
          if (hasAbstract) context.abstract++;
          context.total++;
        }
      }

      for (const [word, context] of wordContexts.entries()) {
        const total = context.physical + context.abstract;
        if (total > 0) {
          this._concretenessMap.set(word, {
            score: (context.physical - context.abstract) / total,
            confidence: total,
            physicalCount: context.physical,
            abstractCount: context.abstract
          });
        }
      }

      this._trained = true;

      logger.info('Metaphor detector trained', {
        vocabularySize: this._concretenessMap.size,
        trainingExamples: result.rows.length,
        patternsActive: METAPHOR_PATTERNS.length
      });

      return {
        vocabularySize: this._concretenessMap.size,
        trainingExamples: result.rows.length,
        patternsActive: METAPHOR_PATTERNS.length
      };

    } catch (error) {
      logger.error('Metaphor detector training failed', { error: error.message });
      this._trained = false;
      return {
        vocabularySize: 0,
        trainingExamples: 0,
        patternsActive: METAPHOR_PATTERNS.length,
        error: error.message
      };
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Detection                                                               */
  /*                                                                          */
  /*  Runs pattern matching first (high precision), then concreteness         */
  /*  mismatch (broader recall). Returns on first match.                      */
  /*                                                                          */
  /*  If untrained, only pattern matching runs. Concreteness mismatch         */
  /*  requires training data.                                                 */
  /*                                                                          */
  /*  Inputs exceeding MAX_INPUT_LENGTH are truncated before processing       */
  /*  to prevent pathological regex backtracking and O(n^2) verb-object       */
  /*  loop performance. Truncation events are logged.                         */
  /*                                                                          */
  /*  @param {string} text — User input text                                  */
  /*  @returns {object} Detection result with isMetaphor, pattern, etc.       */
  /* ──────────────────────────────────────────────────────────────────────── */

  detect(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return this._noMetaphorResult();
    }

    let safeText = text;
    if (text.length > MAX_INPUT_LENGTH) {
      safeText = text.slice(0, MAX_INPUT_LENGTH);
      logger.warn('Input truncated for metaphor detection', {
        originalLength: text.length,
        truncatedTo: MAX_INPUT_LENGTH
      });
    }

    const normalised = safeText.trim().toLowerCase();

    if (this._patternCache.has(normalised)) {
      return this._patternCache.get(normalised);
    }

    /* ── Phase 1: Syntactic Pattern Matching ───────────────────────────── */

    for (const pattern of METAPHOR_PATTERNS) {
      const match = normalised.match(pattern.regex);
      if (match) {
        const result = {
          isMetaphor: true,
          pattern: pattern.name,
          phrase: match[1] || match[0],
          matchedText: match[0],
          method: 'syntactic_pattern',
          confidence: PATTERN_CONFIDENCE
        };
        this._cacheResult(normalised, result);
        return result;
      }
    }

    /* ── Phase 2: Concreteness Mismatch (requires training) ────────────── */

    if (this._trained) {
      const words = this._tokenise(safeText);
      const verbs = this._extractVerbs(words);
      const objects = this._extractObjects(words, verbs);

      for (const verb of verbs) {
        const verbScore = this._getConcretenessCached(verb);
        if (!verbScore || verbScore.confidence < MIN_CONCRETENESS_CONFIDENCE) continue;

        for (const obj of objects) {
          const objScore = this._getConcretenessCached(obj);
          if (!objScore || objScore.confidence < MIN_CONCRETENESS_CONFIDENCE) continue;

          const delta = Math.abs(verbScore.score - objScore.score);

          if (delta > CONCRETENESS_DELTA_THRESHOLD && verbScore.score > objScore.score) {
            const confidence = Math.min(
              MIN_INCONGRUITY_CONFIDENCE + (delta - CONCRETENESS_DELTA_THRESHOLD) * INCONGRUITY_SCALE_FACTOR,
              MAX_INCONGRUITY_CONFIDENCE
            );

            const result = {
              isMetaphor: true,
              pattern: 'concreteness_mismatch',
              phrase: `${verb} ${obj}`,
              delta: Math.round(delta * 1000) / 1000,
              verbConcreteness: Math.round(verbScore.score * 1000) / 1000,
              objectConcreteness: Math.round(objScore.score * 1000) / 1000,
              method: 'semantic_incongruity',
              confidence: Math.round(confidence * 100) / 100
            };
            this._cacheResult(normalised, result);
            return result;
          }
        }
      }
    }

    /* ── No metaphor detected ──────────────────────────────────────────── */

    const result = this._noMetaphorResult();
    this._cacheResult(normalised, result);
    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Concreteness Lookup (Cached)                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _getConcretenessCached(word) {
    const key = word.toLowerCase();
    if (this._concretenessCache.has(key)) {
      return this._concretenessCache.get(key);
    }
    const data = this._concretenessMap.get(key) || null;
    if (this._concretenessCache.size >= MAX_CACHE_SIZE) {
      const firstKey = this._concretenessCache.keys().next().value;
      this._concretenessCache.delete(firstKey);
    }
    this._concretenessCache.set(key, data);
    return data;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Result Cache (FIFO)                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _cacheResult(key, result) {
    if (this._patternCache.size >= MAX_CACHE_SIZE) {
      const firstKey = this._patternCache.keys().next().value;
      this._patternCache.delete(firstKey);
    }
    this._patternCache.set(key, result);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Verb Extraction                                                */
  /*                                                                          */
  /*  Uses expanded known verbs set plus suffix heuristic as fallback.        */
  /*  Known verbs cover The Expanse domain (grief, torment, yokai actions).   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _extractVerbs(words) {
    const verbs = words.filter(w => {
      if (KNOWN_VERBS.has(w)) return true;
      return VERB_SUFFIXES.some(suffix =>
        w.endsWith(suffix) && w.length >= MIN_VERB_SUFFIX_LENGTH
      );
    });
    return [...new Set(verbs)];
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Object Extraction                                              */
  /*                                                                          */
  /*  v009 returned all words > 3 chars (including verbs). v010 filters       */
  /*  out stop words and identified verbs to reduce false verb-verb           */
  /*  comparisons in concreteness mismatch detection.                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _extractObjects(words, verbs) {
    const verbSet = new Set(verbs);
    return words.filter(w =>
      w.length > MIN_WORD_LENGTH &&
      !STOP_WORDS.has(w) &&
      !verbSet.has(w)
    );
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Tokeniser                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  _tokenise(text) {
    return text
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, '')
      .replace(/['']/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > MIN_TOKEN_LENGTH);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: No-Metaphor Result                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _noMetaphorResult() {
    return {
      isMetaphor: false,
      method: 'none',
      confidence: 0
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Cache Management                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  clearCache() {
    this._patternCache.clear();
    this._concretenessCache.clear();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Status                                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  getStatus() {
    return {
      trained: this._trained,
      vocabularySize: this._concretenessMap.size,
      patternCount: METAPHOR_PATTERNS.length,
      cacheSize: this._patternCache.size,
      concretenessCacheSize: this._concretenessCache.size
    };
  }
}

export default new MetaphorDetector();
