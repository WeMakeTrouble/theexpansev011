/**
 * ============================================================================
 * vocabExplanationParser.js — Vocabulary Explanation Parser (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Parses natural language vocabulary explanations from users into structured
 * data for storage in cotw_user_language. Pure function — no DB calls, no
 * side effects, no external APIs.
 *
 * When Claude the Tanuki asks "What does 'mid' mean?" and the user replies
 * "mid means average, like boring", this module extracts:
 *   - definition: "average, like boring"
 *   - baseConcept: "average/boring"
 *   - category: "slang"
 *   - confidence: "high" (0.92)
 *   - pattern: "direct_means"
 *
 * PARSING STRATEGY
 * ----------------
 * Two-pass deterministic pattern cascade (Hearst Patterns, 1992).
 *
 * Pass 1: Word-anchored patterns that require the target word to appear
 *         in the explanation (highest precision).
 * Pass 2: Generic patterns for pronoun-based explanations ("it means...",
 *         "it's like...", "basically...").
 *
 * All regex pre-compiled at module load. Tested in descending confidence
 * order within each pass. First successful match wins.
 *
 * 9 pattern tiers across 2 passes:
 *
 * PASS 1 — Word-anchored:
 *   1. anchored_means      (0.95) — "{word} means average"
 *   2. anchored_equals      (0.93) — "{word} = not gonna lie"
 *   3. anchored_is_slang    (0.90) — "{word} is slang for boring"
 *
 * PASS 2 — Generic (pronoun / implicit subject):
 *   4. generic_means         (0.88) — "it means average"
 *   5. abbrev_expansion      (0.86) — "stands for not gonna lie"
 *   6. slang_for             (0.82) — "it's slang for boring"
 *   7. contextual_when       (0.75) — "it's when something is average"
 *   8. synonym_like          (0.70) — "it's like boring"
 *   9. contrast_pattern      (0.68) — "opposite of good" / "more like X than Y"
 *  10. negation_frame        (0.62) — "not a compliment, it means boring"
 *  11. example_based         (0.52) — "like if food is mid it's not good"
 *
 * If no pattern matches: returns unparsed_raw with confidence 'low' (0.30).
 * Raw explanation is always preserved for admin review.
 *
 * CONFIDENCE TIERS
 * ----------------
 *   high   (>= 0.80) — go straight to consent ("Want me to remember?")
 *   medium (0.60-0.79) — confirmation sub-QUD ("So 'mid' means average?")
 *   low    (< 0.60) — store raw, flag needs_clarification
 *
 * CATEGORY DETECTION
 * ------------------
 * Abbreviation: zero vowels (strict acronym: ngl, brb, tbh)
 *               OR length <= 4 AND consonant-heavy AND not in common
 *               short words exclusion list (sus, mid, cap, bet, etc.)
 * Phrase: word contains spaces (multi-word expression)
 * Slang: default for short informal words
 * Unknown: fallback
 *
 * BASE CONCEPT EXTRACTION
 * -----------------------
 * Strips filler words (basically, kinda, just, pretty, sorta),
 * removes punctuation, takes first 3 significant words, joins with '/'.
 * Max 100 chars.
 *
 * Examples:
 *   "average, like boring"          -> "average/boring"
 *   "not gonna lie"                 -> "gonna/lie" (note: 'not' is a function word)
 *   "very good or excellent"        -> "good/excellent"
 *   "when something is just okay"   -> "something/okay"
 *
 * DEPENDENCIES
 * ------------
 * Internal: createModuleLogger only
 * External: None
 *
 * EXPORTS
 * -------
 * default: parseVocabExplanation(explanation, word, novelNgrams)
 * named:   requiresConfirmation(parsed)
 *          detectWordCategory(word, novelNgrams)
 *          extractBaseConcept(definition)
 *          getStats()
 *          resetMetrics()
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: VocabExplanationParser (metrics encapsulation)
 * Functions: camelCase public, _prefixed private
 * Constants: UPPER_SNAKE_CASE
 * Logger: createModuleLogger('VocabExplanationParser')
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('VocabExplanationParser');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const PARSER_VERSION = 'v010.2';
const MAX_INPUT_LENGTH = 500;
const MAX_WORD_LENGTH = 50;
const MAX_BASE_CONCEPT_LENGTH = 100;
const MAX_SIGNIFICANT_WORDS = 3;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pre-Compiled Regex — Module Level                                         */
/*                                                                            */
/*  All regex used in parsing are compiled once at module load.              */
/*  Prevents garbage collection churn and eliminates ReDoS risk from        */
/*  dynamic pattern construction.                                            */
/*                                                                            */
/*  Word-anchored patterns are built dynamically per call using             */
/*  _escapeRegex() but cached nowhere — they exist only for the duration   */
/*  of a single parseVocabExplanation() invocation.                         */
/* ────────────────────────────────────────────────────────────────────────── */

const ARTICLE_STRIP = /^(?:a|an)\s+/i;

const GENERIC_PATTERNS = [

  /* ── Tier 4: Generic Means (0.88) ───────────────────────────────────── */
  /*  "it means average"                                                   */
  /*  "means average or boring"                                            */
  {
    name: 'generic_means',
    re: /^(?:it\s+)?(?:means?|is)\s+(?:(?:a|an)\s+)?(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[1].trim(),
    baseConf: 0.88
  },

  /* ── Tier 5: Abbreviation Expansion (0.86) ──────────────────────────── */
  /*  "stands for not gonna lie"                                           */
  /*  "it's short for be right back"                                       */
  {
    name: 'abbrev_expansion',
    re: /^(?:it\s+)?(?:stands\s+for|is\s+short\s+for|is\s+shortened?\s+(?:form\s+)?(?:of|for))\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[1].trim(),
    baseConf: 0.86
  },

  /* ── Tier 6: Slang/Category Assignment (0.82) ──────────────────────── */
  /*  "it's slang for boring"                                              */
  /*  "that's slang for very good"                                         */
  {
    name: 'slang_for',
    re: /^(?:it(?:'s|s|\s+is)|that(?:'s|s|\s+is))?\s*(?:a\s+|an\s+)?(?:slang|abbreviation|shorthand|short)\s+(?:for|of)\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[1].trim(),
    baseConf: 0.82
  },

  /* ── Tier 7: Contextual When (0.75) ─────────────────────────────────── */
  /*  "it's when something is just okay"                                   */
  /*  "it means like when you're upset"                                    */
  {
    name: 'contextual_when',
    re: /^(?:it(?:'s|s|\s+is|\s+means))?\s*(?:like\s+)?(?:when|for\s+when|used\s+when)\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[1].trim(),
    baseConf: 0.75
  },

  /* ── Tier 8: Synonym / Comparison (0.70) ────────────────────────────── */
  /*  "it's like boring"                                                   */
  /*  "basically average"                                                  */
  /*  "similar to okay"                                                    */
  {
    name: 'synonym_like',
    re: /^(?:it(?:'s|s|\s+is))?\s*(?:like|basically|similar\s+to|pretty\s+much|kind\s*a?\s+like|sort\s*a?\s+like)\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[1].trim(),
    baseConf: 0.70
  },

  /* ── Tier 9: Contrast Pattern (0.68) ────────────────────────────────── */
  /*  "opposite of good"                                                   */
  /*  "more like boring than bad"                                          */
  /*  "kind of the opposite of cool"                                       */
  {
    name: 'contrast_pattern',
    re: /^(?:it(?:'s|s|\s+is))?\s*(?:(?:kind\s+of\s+)?(?:the\s+)?opposite\s+of|more\s+like\s+(.+?)\s+than)\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => {
      if (match[1] && match[2]) {
        return `more like ${match[1].trim()} than ${match[2].trim()}`;
      }
      return `opposite of ${(match[2] || match[1] || '').trim()}`;
    },
    baseConf: 0.68
  },

  /* ── Tier 10: Negation Frame (0.62) ─────────────────────────────────── */
  /*  "not a compliment, it means boring"                                  */
  /*  "it's not good, it means average"                                    */
  {
    name: 'negation_frame',
    re: /^(?:it(?:'s|s|\s+is))?\s*not\s+(?:a\s+|an\s+)?(.+?),\s*(?:it\s+)?(?:means?|is)\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[2].trim(),
    baseConf: 0.62
  },

  /* ── Tier 11: Example Based (0.52) ──────────────────────────────────── */
  /*  "like if food is mid it's not good or bad"                           */
  /*  "you say it when something is average"                               */
  {
    name: 'example_based',
    re: /^(?:like\s+)?(?:if|when|for\s+example|you\s+(?:say|use)\s+it\s+(?:when|if))\s+(.+?)(?:\.|!|$)/i,
    extractDef: (match) => match[1].trim(),
    baseConf: 0.52
  }
];

/* ────────────────────────────────────────────────────────────────────────── */
/*  Filler Words — Stripped During Base Concept Extraction                    */
/*                                                                            */
/*  Common hedging and filler words that add no semantic value to a          */
/*  definition. Removed before extracting the core meaning.                  */
/*                                                                            */
/*  Note: No overlap with FUNCTION_WORDS_FILTER. Each set has a distinct    */
/*  purpose — fillers are hedge/intensifier words, function words are       */
/*  grammatical structure words.                                             */
/* ────────────────────────────────────────────────────────────────────────── */

const FILLER_WORDS = new Set([
  'basically', 'kinda', 'sorta', 'just', 'pretty',
  'really', 'very', 'super', 'totally', 'literally', 'actually',
  'honestly', 'much', 'means', 'mean'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Function Words — For Significant Word Filtering                          */
/*                                                                            */
/*  Pronouns, determiners, and auxiliary verbs excluded from base concept    */
/*  extraction. Only content words (nouns, adjectives, verbs) survive.       */
/*                                                                            */
/*  Note: No overlap with FILLER_WORDS above.                               */
/* ────────────────────────────────────────────────────────────────────────── */

const FUNCTION_WORDS_FILTER = new Set([
  'i', 'me', 'my', 'you', 'your', 'he', 'she', 'it', 'its',
  'we', 'us', 'they', 'them', 'their', 'this', 'that', 'these',
  'those', 'the', 'a', 'an', 'some', 'any', 'no', 'every',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'would', 'should', 'could', 'can', 'will', 'might', 'not',
  'and', 'but', 'or', 'so', 'if', 'when', 'then',
  'to', 'for', 'with', 'from', 'at', 'in', 'on', 'of', 'by',
  'up', 'down', 'out', 'off', 'like', 'kind', 'sort'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Abbreviation Detection Constants                                          */
/*                                                                            */
/*  Two-tier heuristic:                                                      */
/*  Tier A (strict): Zero vowels = acronym (ngl, brb, tbh, fr)             */
/*  Tier B (soft): Length <= 4, no consecutive vowels, NOT in common        */
/*         short words exclusion list                                        */
/*                                                                            */
/*  The exclusion list prevents common short slang words from being         */
/*  misclassified as abbreviations. These are real words, not acronyms.     */
/* ────────────────────────────────────────────────────────────────────────── */

const ABBREV_MAX_LENGTH = 4;
const HAS_VOWEL = /[aeiou]/i;
const CONSECUTIVE_VOWELS = /[aeiou]{2}/i;

const SHORT_COMMON_WORDS = new Set([
  'sus', 'mid', 'cap', 'bet', 'yep', 'nah', 'duh', 'meh',
  'bruh', 'fam', 'lit', 'bro', 'sis', 'vibe', 'hype',
  'sick', 'dope', 'fire', 'woke', 'slay', 'flex', 'stan',
  'tea', 'mood', 'bop', 'yeet', 'glow', 'drip', 'sip',
  'cop', 'dub', 'ace', 'bum', 'chill', 'clap', 'diss',
  'gig', 'hit', 'jam', 'kick', 'peep', 'plug', 'rip',
  'run', 'trip', 'vex', 'zen'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Confidence Tier Boundaries                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const HIGH_CONFIDENCE_THRESHOLD = 0.80;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.60;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Confidence Bonuses — Additive Adjustments                                 */
/*                                                                            */
/*  Applied after base confidence from pattern match.                        */
/*  Abbreviation signal and explicit "means" keyword increase confidence.    */
/* ────────────────────────────────────────────────────────────────────────── */

const ABBREV_BONUS = 0.05;
const EXPLICIT_MEANS_BONUS = 0.03;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Metrics Encapsulation                                                     */
/*                                                                            */
/*  Class-based metrics avoid module-level mutable state anti-pattern.       */
/*  Single instance created at module load. Resettable for session           */
/*  boundaries or periodic snapshots.                                        */
/* ────────────────────────────────────────────────────────────────────────── */

class ParserMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.parseCalls = 0;
    this.parseSuccesses = 0;
    this.parseFailures = 0;
    this.patternHits = {};
    this.clarificationsNeeded = 0;
    this.totalConfidence = 0;
  }

  recordSuccess(patternName, confidenceScore) {
    this.parseSuccesses++;
    this.patternHits[patternName] = (this.patternHits[patternName] || 0) + 1;
    this.totalConfidence += confidenceScore;
  }

  recordFailure() {
    this.parseFailures++;
    this.clarificationsNeeded++;
  }

  getSnapshot() {
    const avgConf = this.parseSuccesses > 0
      ? parseFloat((this.totalConfidence / this.parseSuccesses).toFixed(4))
      : 0;

    return {
      version: PARSER_VERSION,
      parseCalls: this.parseCalls,
      parseSuccesses: this.parseSuccesses,
      parseFailures: this.parseFailures,
      clarificationsNeeded: this.clarificationsNeeded,
      averageConfidence: avgConf,
      patternHits: { ...this.patternHits }
    };
  }
}

const metrics = new ParserMetrics();

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _escapeRegex                                                     */
/*                                                                            */
/*  Escapes special regex characters in a string for safe interpolation      */
/*  into dynamically constructed patterns. Used by word-anchored patterns.   */
/*                                                                            */
/*  @param {string} str — Raw string to escape                               */
/*  @returns {string} Regex-safe string                                      */
/* ────────────────────────────────────────────────────────────────────────── */

function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _buildAnchoredPatterns                                           */
/*                                                                            */
/*  Constructs word-specific regex patterns that require the target word     */
/*  to appear in the explanation. These are highest-confidence because       */
/*  they verify the user is defining the word Claude asked about, not       */
/*  something else entirely.                                                 */
/*                                                                            */
/*  Built fresh per call using _escapeRegex(). Not cached — patterns are   */
/*  ephemeral and cheap to construct.                                        */
/*                                                                            */
/*  @param {string} wordEscaped — Regex-escaped target word                  */
/*  @returns {Array} Pattern objects matching GENERIC_PATTERNS shape         */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildAnchoredPatterns(wordEscaped) {
  return [

    /* ── Tier 1: Anchored Means (0.95) ──────────────────────────────── */
    /*  "mid means average"                                              */
    /*  "mid is average or boring"                                       */
    {
      name: 'anchored_means',
      re: new RegExp(
        `^'?${wordEscaped}'?\\s+(?:means?|is)\\s+(?:(?:a|an)\\s+)?(.+?)(?:\\.|!|$)`, 'i'
      ),
      extractDef: (match) => match[1].trim(),
      baseConf: 0.95
    },

    /* ── Tier 2: Anchored Equals (0.93) ─────────────────────────────── */
    /*  "ngl = not gonna lie"                                            */
    /*  "ngl stands for not gonna lie"                                   */
    {
      name: 'anchored_equals',
      re: new RegExp(
        `^'?${wordEscaped}'?\\s*(?:=|stands\\s+for|is\\s+short\\s+for)\\s+(.+?)(?:\\.|!|$)`, 'i'
      ),
      extractDef: (match) => match[1].trim(),
      baseConf: 0.93
    },

    /* ── Tier 3: Anchored Slang For (0.90) ──────────────────────────── */
    /*  "mid is slang for average"                                       */
    /*  "ngl is an abbreviation for not gonna lie"                       */
    {
      name: 'anchored_is_slang',
      re: new RegExp(
        `^'?${wordEscaped}'?\\s+(?:is|'s)\\s+(?:a\\s+|an\\s+)?(?:slang|abbreviation|shorthand|short)\\s+(?:for|of)\\s+(.+?)(?:\\.|!|$)`, 'i'
      ),
      extractDef: (match) => match[1].trim(),
      baseConf: 0.90
    }
  ];
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _applyConfidenceBonuses                                          */
/*                                                                            */
/*  Applies additive confidence adjustments based on word properties and     */
/*  explanation content. Caps at 0.99 to never claim certainty.              */
/*                                                                            */
/*  @param {number} baseConf — Pattern's base confidence                     */
/*  @param {string} wordLower — Lowercase target word                        */
/*  @param {string} inputLower — Lowercase explanation text                  */
/*  @returns {number} Adjusted confidence score (0-0.99)                     */
/* ────────────────────────────────────────────────────────────────────────── */

function _applyConfidenceBonuses(baseConf, wordLower, inputLower) {
  let score = baseConf;

  if (!HAS_VOWEL.test(wordLower)) {
    score += ABBREV_BONUS;
  }

  if (/\bmeans?\b/.test(inputLower)) {
    score += EXPLICIT_MEANS_BONUS;
  }

  return Math.min(score, 0.99);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _confidenceTier                                                  */
/*                                                                            */
/*  Maps numeric confidence score to categorical tier.                       */
/*                                                                            */
/*  @param {number} score — Confidence score 0-1                             */
/*  @returns {string} 'high' | 'medium' | 'low'                             */
/* ────────────────────────────────────────────────────────────────────────── */

function _confidenceTier(score) {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return 'high';
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) return 'medium';
  return 'low';
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: parseVocabExplanation                                             */
/*                                                                            */
/*  Main entry point. Takes user's explanation, the word being defined,      */
/*  and optional novel n-grams from learningDetector.                        */
/*                                                                            */
/*  Two-pass cascade:                                                        */
/*  Pass 1: Word-anchored patterns (highest precision)                      */
/*  Pass 2: Generic patterns (pronoun-based explanations)                   */
/*                                                                            */
/*  Returns structured parse result with definition, base concept,           */
/*  confidence, and category.                                                */
/*                                                                            */
/*  @param {string} explanation — User's natural language explanation         */
/*  @param {string} word — The word Claude asked about                       */
/*  @param {string[]} novelNgrams — Optional novel n-grams from learner     */
/*  @returns {object} Structured parse result                                */
/* ────────────────────────────────────────────────────────────────────────── */

function parseVocabExplanation(explanation, word, novelNgrams = []) {
  metrics.parseCalls++;

  /* ── Input validation ──────────────────────────────────────────────── */

  if (!explanation || typeof explanation !== 'string' || explanation.trim().length === 0) {
    logger.debug('vocab.parse.empty', { word: word || null });
    metrics.recordFailure();
    return _rawFallback(null, word, novelNgrams);
  }

  if (!word || typeof word !== 'string' || word.trim().length === 0) {
    logger.debug('vocab.parse.no_word', { explanationLength: explanation.length });
    metrics.recordFailure();
    return _rawFallback(explanation, null, novelNgrams);
  }

  /* ── Normalisation (single pass, both casings preserved for logs) ─── */

  const input = explanation.trim().slice(0, MAX_INPUT_LENGTH);
  const inputLower = input.toLowerCase();
  const cleanWord = word.trim().slice(0, MAX_WORD_LENGTH);
  const wordLower = cleanWord.toLowerCase();
  const wordEscaped = _escapeRegex(wordLower);

  /* ── Pass 1: Word-anchored patterns ────────────────────────────────── */

  const anchoredPatterns = _buildAnchoredPatterns(wordEscaped);

  for (const pattern of anchoredPatterns) {
    const match = inputLower.match(pattern.re);

    if (match) {
      const definition = pattern.extractDef(match);
      if (!definition || definition.length < 2) continue;

      const confidenceScore = _applyConfidenceBonuses(pattern.baseConf, wordLower, inputLower);

      return _buildResult(cleanWord, definition, confidenceScore, pattern.name, input, novelNgrams);
    }
  }

  /* ── Pass 2: Generic patterns ──────────────────────────────────────── */

  for (const pattern of GENERIC_PATTERNS) {
    const match = inputLower.match(pattern.re);

    if (match) {
      const definition = pattern.extractDef(match);
      if (!definition || definition.length < 2) continue;

      const confidenceScore = _applyConfidenceBonuses(pattern.baseConf, wordLower, inputLower);

      return _buildResult(cleanWord, definition, confidenceScore, pattern.name, input, novelNgrams);
    }
  }

  /* ── No pattern matched ────────────────────────────────────────────── */

  metrics.recordFailure();

  logger.info('vocab.parse.no_match', {
    word: cleanWord,
    inputLength: input.length,
    inputPreview: inputLower.slice(0, 60),
    originalPreview: input.slice(0, 60)
  });

  return _rawFallback(input, cleanWord, novelNgrams);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _buildResult                                                     */
/*                                                                            */
/*  Constructs the successful parse result object. Centralises result        */
/*  building to avoid duplication between Pass 1 and Pass 2.                */
/*                                                                            */
/*  @param {string} cleanWord — Cleaned target word                          */
/*  @param {string} definition — Extracted definition text                   */
/*  @param {number} confidenceScore — Adjusted confidence 0-0.99            */
/*  @param {string} patternName — Name of matching pattern                   */
/*  @param {string} originalInput — Original explanation (original casing)  */
/*  @param {string[]} novelNgrams — Novel n-grams from learningDetector     */
/*  @returns {object} Structured parse result                                */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildResult(cleanWord, definition, confidenceScore, patternName, originalInput, novelNgrams) {
  const confidence = _confidenceTier(confidenceScore);
  const baseConcept = extractBaseConcept(definition);
  const category = detectWordCategory(cleanWord, novelNgrams);

  metrics.recordSuccess(patternName, confidenceScore);

  const result = {
    word: cleanWord,
    definition,
    baseConcept,
    category,
    confidence,
    confidenceScore: parseFloat(confidenceScore.toFixed(4)),
    pattern: patternName,
    original_explanation: originalInput,
    parsing_flag: 'parsed',
    version: PARSER_VERSION
  };

  logger.info('vocab.parse.success', {
    word: cleanWord,
    pattern: patternName,
    confidence,
    confidenceScore: result.confidenceScore,
    category,
    baseConcept,
    definitionLength: definition.length
  });

  return result;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: extractBaseConcept                                                */
/*                                                                            */
/*  Strips filler words from a definition and extracts the first 3          */
/*  significant content words. Joins with '/'. Max 100 chars.               */
/*                                                                            */
/*  Examples (verified against code, not assumptions):                       */
/*    "average, like boring"          -> "average/boring"                    */
/*    "not gonna lie"                 -> "gonna/lie"                         */
/*    "very good or excellent"        -> "good/excellent"                    */
/*    "when something is just okay"   -> "something/okay"                   */
/*    "average"                       -> "average"                           */
/*                                                                            */
/*  Note: single-word results are valid. Downstream consumers must handle   */
/*  split('/') returning an array of length 1.                              */
/*                                                                            */
/*  @param {string} definition — Cleaned definition text                     */
/*  @returns {string|null} Normalised base concept or null                   */
/* ────────────────────────────────────────────────────────────────────────── */

function extractBaseConcept(definition) {
  if (!definition || typeof definition !== 'string') return null;

  const cleaned = definition.toLowerCase()
    .replace(/[.,;:!?'"()]/g, '')
    .trim();

  const words = cleaned.split(/\s+/).filter(w =>
    w.length > 1 &&
    !FILLER_WORDS.has(w) &&
    !FUNCTION_WORDS_FILTER.has(w)
  );

  if (words.length === 0) return null;

  const significant = words.slice(0, MAX_SIGNIFICANT_WORDS);
  const concept = significant.join('/');

  if (concept.length > MAX_BASE_CONCEPT_LENGTH) {
    return concept.slice(0, MAX_BASE_CONCEPT_LENGTH);
  }

  return concept;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: detectWordCategory                                                */
/*                                                                            */
/*  Classifies a word as abbreviation, phrase, slang, or unknown based on   */
/*  surface-level heuristics. No ML required.                                */
/*                                                                            */
/*  Two-tier abbreviation detection:                                         */
/*  Tier A (strict): Zero vowels = acronym (ngl, brb, tbh, fr, bc)         */
/*  Tier B (soft): Length <= 4, no consecutive vowels, NOT in               */
/*         SHORT_COMMON_WORDS exclusion list                                 */
/*                                                                            */
/*  Phrase: contains spaces (multi-word expression) or detected in          */
/*          novelNgrams from learningDetector.                               */
/*                                                                            */
/*  @param {string} word — The word to categorise                            */
/*  @param {string[]} novelNgrams — Optional novel n-grams from learner     */
/*  @returns {string} 'abbreviation' | 'phrase' | 'slang' | 'unknown'       */
/* ────────────────────────────────────────────────────────────────────────── */

function detectWordCategory(word, novelNgrams) {
  if (!word || typeof word !== 'string') return 'unknown';

  const clean = word.trim();

  if (clean.includes(' ')) {
    return 'phrase';
  }

  const lower = clean.toLowerCase();

  if (!HAS_VOWEL.test(lower)) {
    return 'abbreviation';
  }

  if (lower.length <= ABBREV_MAX_LENGTH &&
      !CONSECUTIVE_VOWELS.test(lower) &&
      !SHORT_COMMON_WORDS.has(lower)) {
    return 'abbreviation';
  }

  if (Array.isArray(novelNgrams) && novelNgrams.length > 0) {
    const isPartOfPhrase = novelNgrams.some(ng =>
      ng.toLowerCase().includes(lower) && ng.includes(' ')
    );
    if (isPartOfPhrase) return 'phrase';
  }

  return 'slang';
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: requiresConfirmation                                              */
/*                                                                            */
/*  Determines whether the parsed result needs a confirmation sub-QUD       */
/*  before proceeding to consent gate.                                       */
/*                                                                            */
/*  high confidence   -> false (go straight to consent)                     */
/*  medium confidence -> true  (ask "So 'mid' means average?")              */
/*  low confidence    -> false (store raw, flag needs_clarification)         */
/*                                                                            */
/*  Mirrors entityExplanationParser.requiresConfirmation() exactly.         */
/*                                                                            */
/*  @param {object} parsed — Output from parseVocabExplanation               */
/*  @returns {boolean} Whether a confirmation question should be asked       */
/* ────────────────────────────────────────────────────────────────────────── */

function requiresConfirmation(parsed) {
  return parsed?.confidence === 'medium';
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: getStats                                                          */
/*                                                                            */
/*  Returns parsing metrics snapshot for observability and admin dashboards. */
/* ────────────────────────────────────────────────────────────────────────── */

function getStats() {
  return metrics.getSnapshot();
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: resetMetrics                                                      */
/*                                                                            */
/*  Zeroes all runtime counters. Useful for session-boundary resets or       */
/*  periodic metric snapshots. Does NOT affect parsing behaviour.            */
/* ────────────────────────────────────────────────────────────────────────── */

function resetMetrics() {
  metrics.reset();
  logger.debug('Metrics reset', { version: PARSER_VERSION });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _rawFallback                                                     */
/*                                                                            */
/*  Returns a low-confidence result when no pattern matches or input is     */
/*  invalid. Preserves raw explanation for admin review.                     */
/*                                                                            */
/*  @param {string|null} explanation — Raw user input                        */
/*  @param {string|null} word — The word being defined                       */
/*  @param {string[]} novelNgrams — Novel n-grams for category detection    */
/*  @returns {object} Low-confidence parse result                            */
/* ────────────────────────────────────────────────────────────────────────── */

function _rawFallback(explanation, word, novelNgrams = []) {
  return {
    word: word || null,
    definition: null,
    baseConcept: null,
    category: word ? detectWordCategory(word, novelNgrams) : 'unknown',
    confidence: 'low',
    confidenceScore: 0.30,
    pattern: null,
    original_explanation: explanation || null,
    parsing_flag: explanation ? 'needs_clarification' : 'unparsed_raw',
    version: PARSER_VERSION
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module Initialisation Log                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

logger.info('VocabExplanationParser initialised', {
  version: PARSER_VERSION,
  anchoredPatternCount: 3,
  genericPatternCount: GENERIC_PATTERNS.length,
  totalPatternCount: 3 + GENERIC_PATTERNS.length,
  fillerWords: FILLER_WORDS.size,
  functionWords: FUNCTION_WORDS_FILTER.size,
  shortCommonWords: SHORT_COMMON_WORDS.size,
  highConfThreshold: HIGH_CONFIDENCE_THRESHOLD,
  medConfThreshold: MEDIUM_CONFIDENCE_THRESHOLD
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export default parseVocabExplanation;

export {
  requiresConfirmation,
  detectWordCategory,
  extractBaseConcept,
  getStats,
  resetMetrics
};
