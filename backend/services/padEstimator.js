/**
 * ============================================================================
 * padEstimator.js — Pleasure-Arousal-Dominance Estimation Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Estimates emotional coordinates (Pleasure, Arousal, Dominance) from
 * user input text. This is Claude the Tanuki's emotional hearing —
 * the foundation of Goal 1: "Claude can feel emotional temperature."
 *
 * PAD MODEL
 * ---------
 * The PAD model represents emotion in three continuous dimensions:
 *   Pleasure  (-1 to +1): unhappy  to  happy
 *   Arousal   (-1 to +1): calm  to  excited
 *   Dominance (-1 to +1): submissive  to  dominant
 *
 * Together these map the full emotional space. Research supports gated
 * computation: only run PAD when emotional keywords are detected.
 * (Kimi Research Brief, 44 sources)
 *
 * HOW IT WORKS
 * ------------
 * 1. TRAINING (async, called once at boot):
 *    - Loads utterances with PAD values from ltlm_training_examples
 *      and pad_training_examples tables
 *    - Tokenizes each utterance (contraction expansion, stemming)
 *    - Builds word-level PAD map with TF-IDF weighting
 *    - Records document frequency for IDF calculation
 *
 * 2. ESTIMATION (sync, called per user input):
 *    - Checks phrase-level overrides first (lore-specific terms)
 *    - Tokenizes input text
 *    - Detects negation with scoped window (3 words after negator)
 *    - Looks up each token's PAD values with TF-IDF weighting
 *    - Applies scoped negation (flips and dampens affected words only)
 *    - Computes weighted average across all known tokens
 *    - Calculates coverage (known/total words) and confidence
 *    - Computes intensity via Euclidean distance from neutral origin
 *    - Interprets PAD into Expanse lore labels
 *    - Caches result for repeated inputs
 *
 * 3. INTERPRETATION:
 *    - Maps PAD coordinates to Expanse-specific emotional labels
 *    - Labels are lore-driven: deep_torment, tanuki_mischief,
 *      void_calm, helpless_mutai, etc.
 *    - Detects lore combo states (onryo_rage, expanse_drain)
 *    - Returns dominantEmotion, intensity, and lowCoverage flag
 *
 * RETURN STRUCTURE (from estimate())
 * -----------------------------------
 * {
 *   pad: { pleasure: float, arousal: float, dominance: float },
 *   coverage: float,         // 0-1, proportion of known words
 *   confidence: float,       // 0-1, coverage-weighted confidence
 *   knownWords: int,
 *   totalWords: int,
 *   unknownWords: string[]|undefined,
 *   labels: string[],        // Expanse lore labels
 *   dominantEmotion: string, // e.g. 'neutral', 'deep_torment'
 *   intensity: float,        // 0-1, Euclidean distance from origin
 *   lowCoverage: boolean     // true if coverage < 0.35
 * }
 *
 * NEGATION HANDLING
 * -----------------
 * Uses scoped negation rather than global sentence-level detection.
 * Negation words (not, no, never, n't, etc.) affect only the next
 * NEGATION_WINDOW_SIZE tokens (default 3), matching how negation
 * works in natural language. "I am not happy but I am excited"
 * correctly flips "happy" without affecting "excited".
 *
 * INTENSITY CALCULATION
 * ---------------------
 * Uses Euclidean distance from the PAD origin (0,0,0):
 *   intensity = sqrt(P^2 + A^2 + D^2) / sqrt(3)
 * Normalised by sqrt(3) so the maximum possible value (corners of
 * the PAD cube at |1,1,1|) maps to 1.0. This is the mathematically
 * correct way to measure distance from neutral in 3D space.
 *
 * CACHING
 * -------
 * Two-tier cache with FIFO eviction on both tiers:
 *   - estimateCache: full estimate results keyed by normalised input
 *   - wordPADCache: individual word lookups
 * Max cache size configurable (default 10000 entries each).
 *
 * INTEGRATION
 * -----------
 * Called by EarWig.hear() to populate hearingReport.pad and
 * hearingReport.padMeta. PhaseEmotional reads from hearingReport
 * instead of the always-zero session.context.userPad.
 *
 * Also called internally by learningDetector.detectLearningOpportunity()
 * to assess emotional coverage of user input.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: PADEstimator (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase (estimate, train, interpretPAD)
 * Private: _prefix (underscore prefix)
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import pool from '../db/pool.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('PADEstimator');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const MAX_CACHE_SIZE = 10000;
const LOW_COVERAGE_THRESHOLD = 0.35;
const CACHE_KEY_MAX_LENGTH = 150;

const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'without', 'neither', 'nor',
  'nowhere', 'nothing', 'nobody', 'none', 'hardly', 'barely', 'scarcely'
]);
const CONTRACTION_NEGATION = /n't$/;
const NEGATION_WINDOW_SIZE = 3;
const NEGATION_DAMPEN_FACTOR = 0.7;

const SQRT_3 = Math.sqrt(3);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Phrase Overrides                                                          */
/*                                                                            */
/*  Lore-specific multi-word phrases that should bypass word-level            */
/*  estimation. These carry precise emotional meaning in The Expanse.         */
/*  Checked before tokenisation — if a phrase matches, its PAD values         */
/*  are blended into the final estimate with high weight.                     */
/* ────────────────────────────────────────────────────────────────────────── */

const PHRASE_OVERRIDES = Object.freeze({
  'cheese soul':      { pleasure: -0.65, arousal:  0.25, dominance: -0.45 },
  'white void':       { pleasure: -0.75, arousal: -0.55, dominance: -0.65 },
  'joy vacuum':       { pleasure: -0.80, arousal: -0.40, dominance: -0.50 },
  'mutai fragment':   { pleasure: -0.60, arousal:  0.15, dominance: -0.70 },
  'tanuki mischief':  { pleasure:  0.45, arousal:  0.60, dominance:  0.35 },
  'pineaple yurei':   { pleasure: -0.70, arousal:  0.50, dominance: -0.60 },
  'piza sukeruton':   { pleasure:  0.30, arousal:  0.20, dominance:  0.10 },
  'angry pizza':      { pleasure: -0.40, arousal:  0.55, dominance: -0.30 },
  'colour wheel':     { pleasure: -0.35, arousal: -0.10, dominance: -0.50 },
  'expanse drain':    { pleasure: -0.85, arousal: -0.60, dominance: -0.70 }
});

const PHRASE_OVERRIDE_WEIGHT = 3.0;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Affect Short Words                                                        */
/*                                                                            */
/*  Words under 3 characters that carry emotional signal.                     */
/*  Normally filtered by length threshold, these are whitelisted.             */
/* ────────────────────────────────────────────────────────────────────────── */

const AFFECT_SHORTS = Object.freeze(new Set([
  'no', 'yes', 'ok', 'bad', 'sad', 'mad', 'joy',
  'ow', 'ah', 'uh', 'eh', 'oh', 'hi', 'so', 'aw'
]));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Contractions                                                              */
/*                                                                            */
/*  Expanded before tokenisation to improve word-level PAD matching.          */
/*  Includes both apostrophe and no-apostrophe forms for robustness.          */
/* ────────────────────────────────────────────────────────────────────────── */

const CONTRACTIONS = Object.freeze({
  "don't": "do not", "dont": "do not",
  "can't": "cannot", "cant": "cannot",
  "won't": "will not", "wont": "will not",
  "isn't": "is not", "isnt": "is not",
  "aren't": "are not", "arent": "are not",
  "wasn't": "was not", "wasnt": "was not",
  "weren't": "were not", "werent": "were not",
  "haven't": "have not", "havent": "have not",
  "hasn't": "has not", "hasnt": "has not",
  "hadn't": "had not", "hadnt": "had not",
  "wouldn't": "would not", "wouldnt": "would not",
  "couldn't": "could not", "couldnt": "could not",
  "shouldn't": "should not", "shouldnt": "should not",
  "i'm": "i am", "im": "i am",
  "you're": "you are", "youre": "you are",
  "it's": "it is",
  "he's": "he is", "hes": "he is",
  "she's": "she is", "shes": "she is",
  "we're": "we are",
  "they're": "they are", "theyre": "they are",
  "i've": "i have", "ive": "i have",
  "you've": "you have", "youve": "you have",
  "we've": "we have", "weve": "we have",
  "they've": "they have", "theyve": "they have",
  "i'll": "i will",
  "you'll": "you will", "youll": "you will",
  "he'll": "he will",
  "she'll": "she will",
  "we'll": "we will",
  "they'll": "they will", "theyll": "they will",
  "i'd": "i would",
  "you'd": "you would", "youd": "you would",
  "he'd": "he would", "hed": "he would",
  "she'd": "she would",
  "we'd": "we would",
  "they'd": "they would", "theyd": "they would"
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  PADEstimator Class                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

class PADEstimator {
  constructor() {
    this.wordPADMap = new Map();
    this.documentFrequency = new Map();
    this.totalDocuments = 0;
    this.trained = false;
    this.trainingTimestamp = null;

    this.estimateCache = new Map();
    this.wordPADCache = new Map();

    this._contractionRegex = this._buildContractionRegex();
    this._phraseKeys = Object.keys(PHRASE_OVERRIDES);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Contraction Regex Builder                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildContractionRegex() {
    const keys = Object.keys(CONTRACTIONS)
      .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    return new RegExp(`\\b(${keys})\\b`, 'gi');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Suffix Stripping (Light Stemmer)                               */
  /*                                                                          */
  /*  Reduces words to approximate stems to improve PAD map matching.         */
  /*  Deliberately conservative — only strips common suffixes where the       */
  /*  stem retains meaning. Not a full Porter/Lancaster stemmer.              */
  /* ──────────────────────────────────────────────────────────────────────── */

  _stripSuffix(word) {
    if (typeof word !== 'string' || word.length < 4) return word;
    if (word.endsWith('ing') && word.length > 5)  return word.slice(0, -3);
    if (word.endsWith('ed') && word.length > 4)   return word.slice(0, -2);
    if (word.endsWith('ly') && word.length > 4)   return word.slice(0, -2);
    if (word.endsWith('ness') && word.length > 6) return word.slice(0, -4);
    if (word.endsWith('ment') && word.length > 6) return word.slice(0, -4);
    if (word.endsWith('ful') && word.length > 5)  return word.slice(0, -3);
    if (word.endsWith('less') && word.length > 6) return word.slice(0, -4);
    return word;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Tokenizer                                                      */
  /*                                                                          */
  /*  Normalises text, expands contractions, strips punctuation,              */
  /*  splits into tokens, stems, and filters by length (with affect           */
  /*  shorts whitelist).                                                       */
  /*                                                                          */
  /*  Returns array of stemmed tokens in order (preserving position           */
  /*  for scoped negation detection).                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _tokenize(text) {
    if (typeof text !== 'string' || !text) return [];

    let normalized = text
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/['']/g, "'")
      .replace(/[^a-z0-9\s'-]/g, ' ');

    normalized = normalized.replace(this._contractionRegex, (m) =>
      CONTRACTIONS[m.toLowerCase()] || m
    );

    normalized = normalized.replace(/['-]/g, ' ');

    const rawTokens = normalized.split(/\s+/).filter(Boolean);

    return rawTokens
      .map(w => this._stripSuffix(w))
      .filter(w => w.length > 2 || AFFECT_SHORTS.has(w));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Scoped Negation Detection                                      */
  /*                                                                          */
  /*  Builds a Set of token indices that fall within the negation scope.      */
  /*  A negation word (not, no, never, n't, etc.) affects the next            */
  /*  NEGATION_WINDOW_SIZE tokens only.                                       */
  /*                                                                          */
  /*  Example: "I am not happy but I am excited"                              */
  /*  Tokens:   [am, not, happi, but, excit]                                  */
  /*  Negated:  {2} (happi is within window of "not")                         */
  /*  Result:   "happi" gets flipped, "excit" does not                        */
  /*                                                                          */
  /*  Works on pre-stemmed tokens because contraction expansion turns         */
  /*  "don't" → "do not" before stemming, so "not" is always explicit.       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildNegationScope(tokens) {
    const negatedIndices = new Set();

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // NOTE: CONTRACTION_NEGATION.test() is dead code — contractions are expanded
      // to "do not" etc. before tokenisation, so n't forms never reach this point.
      // Retained as safety net for future tokeniser changes.
      const isNegator = NEGATION_WORDS.has(token) || CONTRACTION_NEGATION.test(token);

      if (isNegator) {
        const windowEnd = Math.min(i + NEGATION_WINDOW_SIZE + 1, tokens.length);
        for (let j = i + 1; j < windowEnd; j++) {
          if (!NEGATION_WORDS.has(tokens[j])) {
            negatedIndices.add(j);
          }
        }
      }
    }

    return negatedIndices;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Phrase Override Detection                                       */
  /*                                                                          */
  /*  Scans normalised input for known multi-word phrases.                    */
  /*  Returns array of matched phrase PAD values with weights.                */
  /*  Applied before word-level estimation to ensure lore terms               */
  /*  have strong influence on the final PAD result.                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectPhraseOverrides(normalizedText) {
    const lower = normalizedText.toLowerCase();
    const matches = [];

    for (const phrase of this._phraseKeys) {
      if (lower.includes(phrase)) {
        matches.push({
          phrase,
          pad: PHRASE_OVERRIDES[phrase],
          weight: PHRASE_OVERRIDE_WEIGHT
        });
      }
    }

    return matches;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Word PAD Lookup with FIFO Cache                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  _getWordPAD(word) {
    if (typeof word !== 'string') return null;
    const normalized = word.toLowerCase();

    if (this.wordPADCache.has(normalized)) {
      return this.wordPADCache.get(normalized);
    }

    const data = this.wordPADMap.get(normalized) || null;

    if (data) {
      if (this.wordPADCache.size >= MAX_CACHE_SIZE) {
        const first = this.wordPADCache.keys().next().value;
        this.wordPADCache.delete(first);
      }
      this.wordPADCache.set(normalized, data);
    }

    return data;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Result Cache with FIFO Eviction                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  _cacheResult(key, result) {
    if (typeof key !== 'string' || !key) return;
    if (this.estimateCache.size >= MAX_CACHE_SIZE) {
      const first = this.estimateCache.keys().next().value;
      this.estimateCache.delete(first);
    }
    this.estimateCache.set(key, result);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Neutral Result                                                 */
  /*                                                                          */
  /*  Returns a safe default when estimation cannot proceed.                  */
  /*  Reason field enables callers to understand why.                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _neutralResult(reason = 'unknown') {
    return {
      pad: { pleasure: 0, arousal: 0, dominance: 0 },
      coverage: 0,
      confidence: 0,
      knownWords: 0,
      totalWords: 0,
      labels: ['neutral'],
      dominantEmotion: 'neutral',
      intensity: 0,
      lowCoverage: true,
      reason
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Euclidean Intensity                                            */
  /*                                                                          */
  /*  Computes emotional intensity as Euclidean distance from the             */
  /*  PAD origin (0,0,0), normalised by sqrt(3) so the maximum               */
  /*  possible value (corners of the PAD cube at |1,1,1|) maps to 1.0.       */
  /*                                                                          */
  /*  This is the mathematically correct way to measure distance from         */
  /*  a neutral emotional state in 3D space, as opposed to averaging          */
  /*  absolute values which underweights extreme single-axis states.          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _computeIntensity(pad) {
    const distance = Math.sqrt(
      pad.pleasure * pad.pleasure +
      pad.arousal * pad.arousal +
      pad.dominance * pad.dominance
    );
    return parseFloat((distance / SQRT_3).toFixed(3));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Train                                                           */
  /*                                                                          */
  /*  Loads PAD-annotated utterances from the database, tokenizes them,       */
  /*  and builds a word-level PAD map with TF-IDF weighting.                  */
  /*  Must be called before estimate() will produce real results.             */
  /*  Safe to call multiple times — clears previous model on re-train.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  async train() {
    logger.info('Training on LTLM corpus and PAD training examples');

    if (this.trained) {
      logger.info('Re-training: clearing previous model');
      this.wordPADMap.clear();
      this.documentFrequency.clear();
      this.estimateCache.clear();
      this.wordPADCache.clear();
    }

    let result;
    try {
      const trainingQueryPromise = pool.query(`
              SELECT utterance_text, pad_pleasure, pad_arousal, pad_dominance, 'ltlm' as source_table
              FROM ltlm_training_examples
              WHERE pad_pleasure IS NOT NULL
                AND pad_arousal IS NOT NULL
                AND pad_dominance IS NOT NULL
              UNION ALL
              SELECT utterance_text, pad_pleasure, pad_arousal, pad_dominance, 'pad_training' as source_table
              FROM pad_training_examples
              WHERE pad_pleasure IS NOT NULL
                AND pad_arousal IS NOT NULL
                AND pad_dominance IS NOT NULL
      `);
      let timer;
      result = await Promise.race([
        trainingQueryPromise.then(res => { clearTimeout(timer); return res; }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Training query timeout")), 30000);
        })
      ]);
    } catch (error) {
      logger.error('Training query failed', { error: error.message });
      throw error;
    }

    if (!result?.rows?.length) {
      throw new Error('No valid PAD training data found in ltlm_training_examples or pad_training_examples');
    }

    const ltlmCount = result.rows.filter(r => r.source_table === 'ltlm').length;
    const padCount = result.rows.filter(r => r.source_table === 'pad_training').length;
    logger.info('Training sources loaded', { ltlmCount, padCount });

    this.totalDocuments = result.rows.length;
    const wordContributions = new Map();

    for (const row of result.rows) {
      const words = this._tokenize(row.utterance_text);
      if (!words.length) continue;

      const uniqueWords = new Set(words);
      const pad = {
        p: parseFloat(row.pad_pleasure),
        a: parseFloat(row.pad_arousal),
        d: parseFloat(row.pad_dominance)
      };

      if (isNaN(pad.p) || isNaN(pad.a) || isNaN(pad.d)) {
        logger.warn('Skipping row with invalid PAD values', {
          text: row.utterance_text?.slice(0, 50)
        });
        continue;
      }

      for (const word of uniqueWords) {
        this.documentFrequency.set(word, (this.documentFrequency.get(word) || 0) + 1);
      }

      for (const word of words) {
        if (!wordContributions.has(word)) {
          wordContributions.set(word, { pSum: 0, aSum: 0, dSum: 0, count: 0 });
        }
        const contrib = wordContributions.get(word);
        contrib.pSum += pad.p;
        contrib.aSum += pad.a;
        contrib.dSum += pad.d;
        contrib.count += 1;
      }
    }

    for (const [word, contrib] of wordContributions.entries()) {
      const df = this.documentFrequency.get(word) || 1;
      const idf = Math.log((this.totalDocuments + 1) / (df + 1)) + 1;
      this.wordPADMap.set(word, {
        pleasure: contrib.pSum / contrib.count,
        arousal: contrib.aSum / contrib.count,
        dominance: contrib.dSum / contrib.count,
        idf,
        confidence: contrib.count,
        documentFrequency: df
      });
    }

    this.trained = true;
    this.trainingTimestamp = new Date().toISOString();

    const stats = {
      vocabularySize: this.wordPADMap.size,
      trainingExamples: this.totalDocuments,
      ltlmExamples: ltlmCount,
      padTrainingExamples: padCount,
      avgDocFreq: parseFloat((this.totalDocuments / (this.wordPADMap.size || 1)).toFixed(2)),
      trainingTimestamp: this.trainingTimestamp
    };

    logger.success('Training complete', stats);
    return stats;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Warm Up                                                         */
  /*                                                                          */
  /*  Alias for train(). Exists because server.js boot sequence calls         */
  /*  padEstimator.warmUp?.() providing a consistent startup interface.       */
  /* ──────────────────────────────────────────────────────────────────────── */

  async warmUp() {
    return this.train();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Ready Check                                                     */
  /*                                                                          */
  /*  Returns true if the model has been trained.                             */
  /*  Used by health endpoint: padEstimator.isReady()                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  isReady() {
    return this.trained;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Estimate                                                        */
  /*                                                                          */
  /*  Synchronous. Analyses input text and returns PAD coordinates            */
  /*  with coverage, confidence, lore labels, and dominant emotion.           */
  /*                                                                          */
  /*  Called by EarWig.hear() and learningDetector.detectLearningOpportunity. */
  /*                                                                          */
  /*  @param {string} text — User input text                                  */
  /*  @returns {object} PAD estimation result (see header for structure)      */
  /* ──────────────────────────────────────────────────────────────────────── */

  estimate(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return this._neutralResult('invalid_input');
    }

    if (!this.trained) {
      return this._neutralResult('untrained');
    }

    const normalizedText = text.trim();
    const cacheKey = normalizedText.toLowerCase().slice(0, CACHE_KEY_MAX_LENGTH);

    if (this.estimateCache.has(cacheKey)) {
      return this.estimateCache.get(cacheKey);
    }

    const words = this._tokenize(normalizedText);
    if (!words.length) {
      return this._neutralResult('no_tokens');
    }

    /* ── Phrase overrides ──────────────────────────────────────────────── */

    const phraseMatches = this._detectPhraseOverrides(normalizedText);

    /* ── Scoped negation detection ─────────────────────────────────────── */

    const negatedIndices = this._buildNegationScope(words);

    /* ── Word-level PAD accumulation ───────────────────────────────────── */

    let pleasureSum = 0, arousalSum = 0, dominanceSum = 0;
    let totalWeight = 0;
    let knownWords = 0;
    const unknownWords = [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const padData = this._getWordPAD(word);
      if (!padData) {
        if (!unknownWords.includes(word)) unknownWords.push(word);
        continue;
      }

      const baseWeight = Math.log(1 + padData.confidence) * padData.idf;

      let p = padData.pleasure;
      let a = padData.arousal;
      // NOTE: Dominance excluded from negation intentionally -- dominance reflects
      // the topic's inherent quality, not the speaker's assertion about it.
      const d = padData.dominance;

      if (negatedIndices.has(i)) {
        p = -p * NEGATION_DAMPEN_FACTOR;
        a = a * NEGATION_DAMPEN_FACTOR;
      }

      pleasureSum += p * baseWeight;
      arousalSum += a * baseWeight;
      dominanceSum += d * baseWeight;
      totalWeight += baseWeight;
      knownWords++;
    }

    /* ── Blend phrase overrides ────────────────────────────────────────── */

    for (const match of phraseMatches) {
      pleasureSum += match.pad.pleasure * match.weight;
      arousalSum += match.pad.arousal * match.weight;
      dominanceSum += match.pad.dominance * match.weight;
      totalWeight += match.weight;
      knownWords += 2;
    }

    /* ── Compute final PAD ─────────────────────────────────────────────── */

    let pad;
    if (knownWords === 0) {
      pad = { pleasure: 0, arousal: 0, dominance: 0 };
    } else {
      pad = {
        pleasure: Math.max(-1, Math.min(1, pleasureSum / totalWeight)),
        arousal: Math.max(-1, Math.min(1, arousalSum / totalWeight)),
        dominance: Math.max(-1, Math.min(1, dominanceSum / totalWeight))
      };
    }

    const coverage = Math.min(1, knownWords / words.length);
    const confidence = Math.min(1, coverage * Math.log(1 + knownWords) / 2);

    /* ── Interpret into lore labels ────────────────────────────────────── */

    const interpretation = this._interpretPAD(pad, coverage);

    /* ── Build result ──────────────────────────────────────────────────── */

    const result = {
      pad: {
        pleasure: Math.round(pad.pleasure * 1000) / 1000,
        arousal: Math.round(pad.arousal * 1000) / 1000,
        dominance: Math.round(pad.dominance * 1000) / 1000
      },
      coverage: Math.round(coverage * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      knownWords,
      totalWords: words.length,
      unknownWords: unknownWords.length > 0 ? unknownWords : undefined,
      ...interpretation
    };

    this._cacheResult(cacheKey, result);
    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Interpret PAD                                                  */
  /*                                                                          */
  /*  Maps PAD coordinates to Expanse-specific emotional labels.              */
  /*  Labels are lore-driven, not clinical. They describe the emotional       */
  /*  landscape of The Expanse realm.                                         */
  /*                                                                          */
  /*  Intensity uses Euclidean distance from origin normalised to 0-1.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _interpretPAD(pad, coverage) {
    const labels = [];
    let dominantEmotion = 'neutral';

    /* ── Pleasure axis ─────────────────────────────────────────────────── */

    if (pad.pleasure <= -0.50) {
      labels.push('deep_torment', 'joy_vacuum', 'yurei_feeding');
      dominantEmotion = 'deep_torment';
    } else if (pad.pleasure <= -0.25) {
      labels.push('heavy_sorrow', 'mutai_fragmented', 'expanse_dread');
      dominantEmotion = 'heavy_sorrow';
    } else if (pad.pleasure >= 0.40) {
      labels.push('spark_of_joy', 'hopeful_glow', 'tanuki_mischief');
      dominantEmotion = 'spark_of_joy';
    } else if (pad.pleasure >= 0.15) {
      labels.push('faint_warmth', 'konbini_beacon');
      dominantEmotion = 'faint_warmth';
    }

    /* ── Arousal axis ──────────────────────────────────────────────────── */

    if (pad.arousal >= 0.55) {
      labels.push('high_chaos', 'bosozoku_roar', 'b_roll_frenzy');
      if (dominantEmotion === 'neutral' || dominantEmotion.includes('torment')) {
        dominantEmotion = 'high_chaos';
      }
    } else if (pad.arousal <= -0.40) {
      labels.push('void_calm', 'adrift_silence');
      dominantEmotion = 'void_calm';
    }

    /* ── Dominance axis ────────────────────────────────────────────────── */

    if (pad.dominance <= -0.50) {
      labels.push('helpless_mutai', 'fractured_victim');
      if (dominantEmotion === 'neutral' || dominantEmotion.includes('sorrow')) {
        dominantEmotion = 'helpless_mutai';
      }
    } else if (pad.dominance >= 0.45) {
      labels.push('defiant_rebel', 'tanuki_spirit');
      dominantEmotion = 'defiant_rebel';
    }

    /* ── Lore combo states ─────────────────────────────────────────────── */

    if (labels.includes('deep_torment') && labels.includes('high_chaos')) {
      labels.push('onryo_rage');
    }
    if (labels.includes('joy_vacuum') && labels.includes('void_calm')) {
      labels.push('expanse_drain');
    }
    if (labels.includes('spark_of_joy') && labels.includes('defiant_rebel')) {
      labels.push('tanuki_awakening');
    }

    return {
      labels: [...new Set(labels)],
      dominantEmotion,
      intensity: this._computeIntensity(pad),
      lowCoverage: coverage < LOW_COVERAGE_THRESHOLD
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Word PAD Lookup                                                 */
  /*                                                                          */
  /*  Direct word lookup for diagnostics and debugging.                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  getWordPAD(word) {
    const normalized = (typeof word === 'string') ? word.toLowerCase() : '';
    return this.wordPADMap.get(normalized) || null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Vocabulary Stats                                                */
  /*                                                                          */
  /*  Returns training statistics for diagnostics and health endpoint.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  getVocabularyStats() {
    if (!this.trained) return null;

    const entries = Array.from(this.wordPADMap.values());
    if (!entries.length) return null;

    const idfValues = entries.map(w => w.idf);
    const confValues = entries.map(w => w.confidence);

    return {
      vocabularySize: this.wordPADMap.size,
      totalDocuments: this.totalDocuments,
      avgIDF: parseFloat((idfValues.reduce((a, b) => a + b, 0) / idfValues.length).toFixed(3)),
      avgConfidence: parseFloat((confValues.reduce((a, b) => a + b, 0) / confValues.length).toFixed(2)),
      maxConfidence: Math.max(...confValues),
      minConfidence: Math.min(...confValues),
      phraseOverrides: this._phraseKeys.length,
      trainingTimestamp: this.trainingTimestamp,
      cacheStats: {
        estimateCacheSize: this.estimateCache.size,
        wordPADCacheSize: this.wordPADCache.size,
        maxCacheSize: MAX_CACHE_SIZE
      }
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Clear Cache                                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  clearCache() {
    const estimateCount = this.estimateCache.size;
    const wordCount = this.wordPADCache.size;
    this.estimateCache.clear();
    this.wordPADCache.clear();
    logger.debug('Cache cleared', { estimateCount, wordCount });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new PADEstimator();
