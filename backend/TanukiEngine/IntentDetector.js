/**
 * ============================================================================
 * IntentDetector.js — Cognitive Perception Layer v5.0 (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Detects the cognitive frame of user input — what KIND of thing the user
 * is saying. Is it playful? Philosophical? Factual? Emotional? Social?
 * Sarcastic? This classification drives downstream decisions about how
 * Claude the Tanuki should respond.
 *
 * This is NOT the entity/knowledge matcher (that's cotwIntentMatcher in
 * PhaseIntent). This is the lightweight text-analysis layer that reads
 * the "mood" of the input.
 *
 * EARWIG INTEGRATION
 * ------------------
 * EarWig calls a shared singleton instance (IntentDetectorSingleton.js)
 * to populate hearingReport.cognitiveFrame. PhaseIntent also uses the
 * same singleton to preserve temporal memory across the system.
 *
 * CRITICAL DESIGN DECISION (from EarWig Brief Part 3.4):
 * PhaseIntent.js line 65 creates a module-level instance. This instance
 * is stateful — it tracks temporal drift via turnHistory and maintains
 * a feedback system. If EarWig creates a SECOND instance, they would
 * have separate memories. Solution: IntentDetectorSingleton.js exports
 * a single shared instance that both EarWig and PhaseIntent import.
 *
 * HOW IT WORKS
 * ------------
 * 1. PATTERN MATCHING: 140+ regex patterns across 6 intent categories
 *    score the input with weighted signals (core patterns score higher)
 *
 * 2. SARCASM DETECTION: Multi-signal analysis combining:
 *    - Known sarcastic phrases ("oh great", "said no one ever")
 *    - Positive/negative inversion ("great" + "bug" in same input)
 *    - Punctuation amplifiers (!!!, ..., ALL CAPS)
 *
 * 3. NEGATION AWARENESS: Proximity-based analysis (25-char window)
 *    detects when pattern matches are negated ("not happy" dampens
 *    emotional score instead of boosting it)
 *
 * 4. INTENSITY MODULATION: Linguistic markers ("very", "extremely",
 *    "somewhat") scale pattern weights up or down
 *
 * 5. BLEND CALCULATION: Instead of winner-takes-all, produces
 *    proportional blend across all active intents (e.g. 60%
 *    philosophical, 30% playful, 10% emotional)
 *
 * 6. COMPOUND INTENTS: Detects meaningful combinations like
 *    "playfully_emotional" or "sarcastically_defensive"
 *
 * 7. TEMPORAL MEMORY: Tracks intent history per conversation to
 *    detect drift (e.g. user shifting from playful to philosophical)
 *
 * 8. FEEDBACK ADAPTATION: Pattern-level performance tracking with
 *    exponential decay adjusts weights based on detection accuracy
 *
 * INTENT TYPES
 * ------------
 * playful       — Tanuki, tricks, riddles, games, jokes
 * philosophical — Meaning, existence, truth, purpose, consciousness
 * factual       — What is, who is, tell me about, define
 * social        — Greetings, farewells, thanks, apologies
 * emotional     — Feelings, happiness, sadness, anger, fear
 * sarcastic     — Detected via dedicated sarcasm analysis subsystem
 *
 * RETURN STRUCTURE (from detect())
 * --------------------------------
 * {
 *   type: string,           // dominant intent type
 *   entity: string|null,    // extracted entity if found
 *   confidence: float,      // 0-0.95 (capped)
 *   blend: array,           // top intents with proportions
 *   matchedPatterns: array, // all patterns that fired
 *   scores: object,         // raw scores per intent type
 *   meta: {
 *     negated: boolean,
 *     patternCount: int,
 *     timestamp: number,
 *     sarcasm: object|null,
 *     temporalDrift: object|null,
 *     compoundIntent: object|null,
 *     turnNumber: int
 *   }
 * }
 *
 * CHANGES FROM v009 (v4.0 → v5.0)
 * --------------------------------
 * - Conversation-scoped temporal memory (Map per conversationId)
 *   instead of flat array with post-hoc filtering
 * - All pattern arrays frozen after initialisation
 * - Structured logger added (createModuleLogger)
 * - Smart quote and emoji normalisation in input preprocessing
 * - Constants extracted to module level (UPPER_SNAKE_CASE)
 * - Full v010 documentation header
 * - Input sanitisation for unicode edge cases
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: IntentDetector (PascalCase) — CLASS export, not singleton
 * Singleton: via IntentDetectorSingleton.js
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('IntentDetector');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const DEFAULT_MIN_CONFIDENCE = 0.25;
const DEFAULT_TEMPORAL_MEMORY_SIZE = 5;
const MAX_CONFIDENCE_CAP = 0.95;
const NEGATION_PROXIMITY_WINDOW = 25;
const NEGATION_DAMPEN_FACTOR = 0.3;
const NEGATION_CONFIDENCE_FACTOR = 0.85;
const SARCASM_THRESHOLD = 3.5;
const SARCASM_CONFIDENCE_BOOST = 0.15;
const INTENT_DRIFT_THRESHOLD = 0.4;
const FEEDBACK_DECAY_RATE = 0.95;
const MIN_FEEDBACK_SAMPLES = 5;
const WEIGHT_ADJUSTMENT_RATE = 0.1;
const MIN_WEIGHT_ADJUSTMENT = 0.7;
const MAX_WEIGHT_ADJUSTMENT = 1.3;
const MAX_INTENSITY_MULTIPLIER = 1.4;
const MIN_INTENSITY_MULTIPLIER = 0.6;
const MAX_BLEND_RESULTS = 4;
const COMPOUND_PRIMARY_THRESHOLD = 0.35;
const MAX_ENTITY_WORDS = 3;
const MIN_ENTITY_WORD_LENGTH = 3;
const MAX_TEMPORAL_CONVERSATIONS = 50;

const DEFAULT_INTENT_PRIORITY = Object.freeze([
  'sarcastic',
  'playful',
  'philosophical',
  'emotional',
  'factual',
  'social'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pattern Definitions (Frozen)                                              */
/* ────────────────────────────────────────────────────────────────────────── */

const INTENT_PATTERNS = Object.freeze({
  playful: Object.freeze({
    core: Object.freeze([
      { regex: /\btanuki\b/i, weight: 3, entity: 'tanuki' },
      { regex: /\btrick(s|y|ster|ing)?\b/i, weight: 2, entity: 'trickery' },
      { regex: /\bparadox(es|ical)?\b/i, weight: 3, entity: 'paradox' },
      { regex: /\briddle(s)?\b/i, weight: 2, entity: 'riddle' },
      { regex: /\bmask(s|ed|ing)?\b/i, weight: 2, entity: 'mask' },
      { regex: /\billusion(s|ary)?\b/i, weight: 2, entity: 'illusion' },
      { regex: /\bcontradiction(s)?\b/i, weight: 2, entity: 'contradiction' },
      { regex: /\bmischief\b/i, weight: 2, entity: 'mischief' }
    ]),
    extended: Object.freeze([
      { regex: /\bweird(ness)?\b/i, weight: 1, entity: null },
      { regex: /\bshow\s+me\b/i, weight: 1, entity: null },
      { regex: /\bmagic(al|ally)?\b/i, weight: 1, entity: 'magic' },
      { regex: /\bsecret(s|ly)?\b/i, weight: 1, entity: 'secret' },
      { regex: /\bjoke(s|ing)?\b/i, weight: 2, entity: 'humor' },
      { regex: /\bfunny\b/i, weight: 1, entity: 'humor' },
      { regex: /\bsilly\b/i, weight: 1, entity: null },
      { regex: /\bgame(s)?\b/i, weight: 1, entity: 'game' },
      { regex: /\bplay(ful|ing)?\b/i, weight: 1, entity: null },
      { regex: /\bpuzzle(s)?\b/i, weight: 2, entity: 'puzzle' }
    ])
  }),
  philosophical: Object.freeze({
    core: Object.freeze([
      { regex: /\bwhat\s+does\s+(?:it|that|this)\s+mean\b/i, weight: 3, entity: 'meaning' },
      { regex: /\bessence\b/i, weight: 3, entity: 'essence' },
      { regex: /\bmeaning\s+of\b/i, weight: 3, entity: 'meaning' },
      { regex: /\bconsciousness\b/i, weight: 3, entity: 'consciousness' },
      { regex: /\bfree\s+will\b/i, weight: 3, entity: 'free_will' }
    ]),
    extended: Object.freeze([
      { regex: /\bwhy\b/i, weight: 2, entity: null },
      { regex: /\bnature\s+of\b/i, weight: 2, entity: 'nature' },
      { regex: /\btruth(s|ful)?\b/i, weight: 2, entity: 'truth' },
      { regex: /\bpurpose\b/i, weight: 2, entity: 'purpose' },
      { regex: /\bexist(s|ence|ential)?\b/i, weight: 2, entity: 'existence' },
      { regex: /\bwisdom\b/i, weight: 2, entity: 'wisdom' },
      { regex: /\bbeliev(e|es|ing)\b/i, weight: 1, entity: 'belief' },
      { regex: /\bsoul(s)?\b/i, weight: 2, entity: 'soul' },
      { regex: /\bdestiny\b/i, weight: 2, entity: 'destiny' },
      { regex: /\bfate\b/i, weight: 2, entity: 'fate' },
      { regex: /\breality\b/i, weight: 2, entity: 'reality' },
      { regex: /\bmorality\b/i, weight: 2, entity: 'morality' },
      { regex: /\bethics\b/i, weight: 2, entity: 'ethics' }
    ])
  }),
  factual: Object.freeze({
    core: Object.freeze([
      { regex: /\bwhat\s+is\s+(?:a|an|the)?\b/i, weight: 2, entity: null },
      { regex: /\bwho\s+is\b/i, weight: 2, entity: null },
      { regex: /\btell\s+me\s+about\b/i, weight: 2, entity: null },
      { regex: /\bdefine\b/i, weight: 2, entity: null }
    ]),
    extended: Object.freeze([
      { regex: /\bwhen\s+(?:did|was|is|will)\b/i, weight: 2, entity: null },
      { regex: /\bwhere\s+(?:is|are|did|was)\b/i, weight: 2, entity: null },
      { regex: /\bhow\s+many\b/i, weight: 2, entity: null },
      { regex: /\bhow\s+much\b/i, weight: 2, entity: null },
      { regex: /\bhow\s+do(?:es)?\b/i, weight: 1, entity: null },
      { regex: /\bexplain\b/i, weight: 1, entity: null },
      { regex: /\bdescribe\b/i, weight: 1, entity: null },
      { regex: /\blist\b/i, weight: 1, entity: null },
      { regex: /\bfact(s)?\b/i, weight: 2, entity: 'fact' },
      { regex: /\binformation\b/i, weight: 1, entity: 'information' }
    ])
  }),
  social: Object.freeze({
    core: Object.freeze([
      { regex: /\b(?:hello|hi|hey|greetings|howdy)\b/i, weight: 3, entity: 'greeting' },
      { regex: /\b(?:goodbye|bye|farewell|see\s+you)\b/i, weight: 3, entity: 'farewell' },
      { regex: /\bhow\s+are\s+you\b/i, weight: 3, entity: 'wellbeing' },
      { regex: /\bgood\s+(?:morning|afternoon|evening|night)\b/i, weight: 2, entity: 'greeting' }
    ]),
    extended: Object.freeze([
      { regex: /\bhow(?:'s|\s+is)\s+it\s+going\b/i, weight: 2, entity: 'wellbeing' },
      { regex: /\bthank(?:s|\s+you)\b/i, weight: 2, entity: 'gratitude' },
      { regex: /\bplease\b/i, weight: 1, entity: null },
      { regex: /\bsorry\b/i, weight: 2, entity: 'apology' },
      { regex: /\bnice\s+to\s+meet\b/i, weight: 2, entity: 'introduction' },
      { regex: /\bwelcome\b/i, weight: 1, entity: 'greeting' }
    ])
  }),
  emotional: Object.freeze({
    core: Object.freeze([
      { regex: /\b(?:feel|feeling|felt)\b/i, weight: 2, entity: 'emotion' },
      { regex: /\b(?:happy|happiness|joy)\b/i, weight: 2, entity: 'happiness' },
      { regex: /\b(?:sad|sadness|sorrow)\b/i, weight: 2, entity: 'sadness' },
      { regex: /\b(?:angry|anger|rage)\b/i, weight: 2, entity: 'anger' },
      { regex: /\b(?:afraid|fear|scared)\b/i, weight: 2, entity: 'fear' }
    ]),
    extended: Object.freeze([
      { regex: /\b(?:love|loving)\b/i, weight: 2, entity: 'love' },
      { regex: /\b(?:hate|hatred)\b/i, weight: 2, entity: 'hatred' },
      { regex: /\b(?:worried|worry|anxious)\b/i, weight: 2, entity: 'anxiety' },
      { regex: /\b(?:lonely|loneliness)\b/i, weight: 2, entity: 'loneliness' },
      { regex: /\b(?:confused|confusion)\b/i, weight: 1, entity: 'confusion' },
      { regex: /\b(?:excited|excitement)\b/i, weight: 1, entity: 'excitement' },
      { regex: /\bheart\b/i, weight: 1, entity: 'heart' }
    ])
  }),
  sarcastic: Object.freeze({
    core: Object.freeze([]),
    extended: Object.freeze([])
  })
});

const NEGATION_PATTERNS = Object.freeze([
  /\b(?:not|n't|no|never|neither|none|nobody|nothing|nowhere)\b/i,
  /\b(?:don't|doesn't|didn't|won't|wouldn't|couldn't|shouldn't)\b/i,
  /\b(?:isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't)\b/i
]);

const INTENSIFIERS = Object.freeze([
  { regex: /\b(?:very|really|extremely|incredibly|absolutely)\b/i, multiplier: 1.25 },
  { regex: /\b(?:somewhat|slightly|kind\s+of|a\s+bit)\b/i, multiplier: 0.8 },
  { regex: /\b(?:always|constantly|forever)\b/i, multiplier: 1.15 },
  { regex: /\?\s*$/i, multiplier: 1.1 }
]);

const SARCASM_SIGNALS = Object.freeze({
  positiveWords: Object.freeze([
    { regex: /\b(?:great|awesome|fantastic|brilliant|perfect|wonderful|amazing|excellent)\b/i, weight: 2 },
    { regex: /\b(?:love|thrilled|delighted|overjoyed)\b/i, weight: 2 },
    { regex: /\b(?:best|greatest|finest)\b/i, weight: 1.5 }
  ]),
  negativeContextWords: Object.freeze([
    /\b(?:crash|bug|fail|broke|broken|error|problem|issue|wrong)\b/i,
    /\b(?:again|another|always|every\s+time)\b/i,
    /\b(?:terrible|horrible|awful|disaster|nightmare)\b/i,
    /\b(?:late|slow|stuck|waiting|delayed)\b/i
  ]),
  sarcasmPhrases: Object.freeze([
    { regex: /\boh\s+(?:great|wonderful|fantastic|perfect)\b/i, weight: 4, entity: 'sarcasm_exclamation' },
    { regex: /\bthis\s+is\s+(?:fine|great|amazing|perfect)\b/i, weight: 3.5, entity: 'sarcasm_denial' },
    { regex: /\bjust\s+what\s+(?:i|we)\s+(?:needed|wanted)\b/i, weight: 3.5, entity: 'sarcasm_ironic' },
    { regex: /\b(?:sure|yeah|right|ok|okay)\s*[.]{2,}/i, weight: 3, entity: 'sarcasm_dismissive' },
    { regex: /\b(?:sure|yeah|right)\s*[,]?\s*(?:whatever|buddy|pal)\b/i, weight: 3, entity: 'sarcasm_dismissive' },
    { regex: /\bwow\s*[,]?\s+(?:just\s+)?wow\b/i, weight: 2.5, entity: 'sarcasm_exclamation' },
    { regex: /\bhow\s+(?:wonderful|delightful|lovely)\b/i, weight: 2.5, entity: 'sarcasm_mock' },
    { regex: /\bsaid\s+no\s+one\s+(?:ever)?\b/i, weight: 4, entity: 'sarcasm_classic' },
    { regex: /\byeah[,]?\s+right\b/i, weight: 3.5, entity: 'sarcasm_dismissive' },
    { regex: /\boh\s+really\b/i, weight: 2, entity: 'sarcasm_questioning' },
    { regex: /\bwhat\s+a\s+(?:surprise|shock)\b/i, weight: 3, entity: 'sarcasm_mock_surprise' },
    { regex: /\bcolor\s+me\s+surprised\b/i, weight: 3.5, entity: 'sarcasm_mock_surprise' },
    { regex: /\bno\s+way[!]?\s*really\b/i, weight: 3, entity: 'sarcasm_mock_surprise' },
    { regex: /\bthanks\s+(?:a\s+lot|so\s+much)\b/i, weight: 2, entity: 'sarcasm_gratitude' },
    { regex: /\breal(?:ly)?\s+helpful\b/i, weight: 2.5, entity: 'sarcasm_mock' },
    { regex: /\bexactly\s+what\s+i\s+(?:wanted|expected)\b/i, weight: 3, entity: 'sarcasm_ironic' }
  ]),
  punctuationSignals: Object.freeze([
    { regex: /[!]{2,}/, weight: 1.5 },
    { regex: /[.]{3,}/, weight: 1.3 },
    { regex: /\b[A-Z]{3,}\b/, weight: 1.2 }
  ])
});

const ENTITY_PATTERNS = Object.freeze([
  { regex: /\babout\s+(?:the\s+)?([a-z]+(?:\s+[a-z]+)?)/i, group: 1 },
  { regex: /\bof\s+(?:the\s+)?([a-z]+(?:\s+[a-z]+)?)/i, group: 1 },
  { regex: /\bwhat\s+is\s+(?:a\s+|an\s+|the\s+)?([a-z]+)/i, group: 1 },
  { regex: /\bwho\s+is\s+([a-z]+(?:\s+[a-z]+)?)/i, group: 1 },
  { regex: /\btell\s+me\s+about\s+(?:the\s+)?([a-z]+(?:\s+[a-z]+)?)/i, group: 1 }
]);

const STOP_WORDS = Object.freeze(new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'me', 'my',
  'your', 'we', 'us', 'our', 'they', 'them', 'their', 'he',
  'she', 'him', 'her', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into'
]));

const COMPOUND_RULES = Object.freeze([
  { primary: 'playful', secondary: 'emotional', threshold: 0.30, result: 'playfully_emotional', description: 'Mischievous with underlying feeling' },
  { primary: 'philosophical', secondary: 'playful', threshold: 0.25, result: 'playfully_philosophical', description: 'Deep thought with whimsy' },
  { primary: 'emotional', secondary: 'factual', threshold: 0.30, result: 'emotionally_grounded', description: 'Feeling-based but seeking facts' },
  { primary: 'sarcastic', secondary: 'emotional', threshold: 0.25, result: 'sarcastically_defensive', description: 'Sarcasm masking emotion' },
  { primary: 'sarcastic', secondary: 'playful', threshold: 0.30, result: 'sarcastically_playful', description: 'Ironic humor' },
  { primary: 'factual', secondary: 'philosophical', threshold: 0.35, result: 'factually_curious', description: 'Information-seeking with deeper curiosity' }
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  IntentDetector Class                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export default class IntentDetector {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Constructor                                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  constructor(config = {}) {
    this.debug = config.debug || false;
    this.minConfidenceThreshold = config.minConfidence || DEFAULT_MIN_CONFIDENCE;
    this.temporalMemorySize = config.temporalMemorySize || DEFAULT_TEMPORAL_MEMORY_SIZE;
    this.enableFeedback = config.enableFeedback !== false;

    this.intentPriority = config.priority
      ? [...config.priority]
      : [...DEFAULT_INTENT_PRIORITY];

    this._runtimePatterns = this._clonePatterns(INTENT_PATTERNS);
    this._runtimeSarcasmPhrases = [...SARCASM_SIGNALS.sarcasmPhrases];

    this._conversationMemory = new Map();
    this._patternPerformance = new Map();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Clone Patterns For Runtime Mutation                            */
  /*                                                                          */
  /*  The frozen INTENT_PATTERNS are the base set. Runtime copies allow       */
  /*  addPattern() and loadPatternsFromVocab() to extend without mutating    */
  /*  the frozen originals.                                                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _clonePatterns(frozen) {
    const cloned = {};
    for (const [type, groups] of Object.entries(frozen)) {
      cloned[type] = {
        core: [...groups.core],
        extended: [...groups.extended]
      };
    }
    return cloned;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Normalise Input                                                */
  /*                                                                          */
  /*  Strips smart quotes, normalises unicode, collapses whitespace.          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _normaliseInput(input) {
    return input
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[\u2026]/g, '...')
      .trim();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Main Detection Method                                           */
  /*                                                                          */
  /*  Synchronous. Analyses input text and returns cognitive frame with       */
  /*  type, confidence, blend, and rich metadata.                             */
  /*                                                                          */
  /*  @param {string} input — User input text                                 */
  /*  @param {object} [options] — Detection options                           */
  /*  @param {string} [options.conversationId] — For temporal tracking       */
  /*  @param {object} [options.previousContext] — Previous turn context       */
  /*  @returns {object} Intent analysis result                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  detect(input, options = {}) {
    const startTime = this.debug ? Date.now() : null;

    if (!input || typeof input !== 'string' || input.trim().length === 0) {
      return this._buildResult('unknown', null, 0, [], {}, [], false, null, startTime);
    }

    const sanitised = this._normaliseInput(input);
    const normalised = sanitised.toLowerCase();
    const wordCount = normalised.split(/\s+/).length;

    const hasNegation = this._detectNegation(normalised);
    const intensityMultiplier = this._calculateIntensity(normalised);
    const sarcasmAnalysis = this._analyseSarcasm(sanitised, normalised, hasNegation);

    /* ── Score all intent patterns ─────────────────────────────────────── */

    const scores = {};
    for (const intentType of Object.keys(this._runtimePatterns)) {
      scores[intentType] = 0;
    }

    const matchedPatterns = [];
    const entitiesFound = [];

    for (const [intentType, patternGroups] of Object.entries(this._runtimePatterns)) {
      const allPatterns = [
        ...(patternGroups.core || []),
        ...(patternGroups.extended || [])
      ];

      for (const pattern of allPatterns) {
        if (pattern.regex.test(normalised)) {
          let weight = pattern.weight * intensityMultiplier;

          const feedbackAdj = this._getFeedbackAdjustment(pattern.regex.source, intentType);
          weight *= feedbackAdj;

          if (hasNegation && this._isNegated(normalised, pattern.regex)) {
            weight *= NEGATION_DAMPEN_FACTOR;
          }

          scores[intentType] += weight;
          matchedPatterns.push({
            type: intentType,
            pattern: pattern.regex.source,
            weight: Math.round(weight * 100) / 100,
            entity: pattern.entity,
            negated: hasNegation && this._isNegated(normalised, pattern.regex),
            feedbackAdjusted: feedbackAdj !== 1.0
          });

          if (pattern.entity) {
            entitiesFound.push({
              entity: pattern.entity,
              source: 'pattern',
              intentType
            });
          }
        }
      }
    }

    /* ── Add sarcasm scores ────────────────────────────────────────────── */

    if (sarcasmAnalysis.detected) {
      scores.sarcastic = (scores.sarcastic || 0) + sarcasmAnalysis.score;
      matchedPatterns.push(...sarcasmAnalysis.matchedSignals.map(s => ({
        type: 'sarcastic',
        pattern: s.pattern,
        weight: s.weight,
        entity: s.entity || 'sarcasm',
        negated: false,
        feedbackAdjusted: false
      })));

      if (sarcasmAnalysis.entity) {
        entitiesFound.push({
          entity: sarcasmAnalysis.entity,
          source: 'sarcasm_detection',
          intentType: 'sarcastic'
        });
      }
    }

    /* ── Determine dominant intent ─────────────────────────────────────── */

    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);

    if (totalScore === 0) {
      const extractedEntity = this._extractEntity(normalised);
      return this._buildResult('factual', extractedEntity, 0.2, [], scores, [], hasNegation, null, startTime);
    }

    const sortedIntents = this.intentPriority
      .filter(type => (scores[type] || 0) > 0)
      .sort((a, b) => scores[b] - scores[a]);

    const dominantType = sortedIntents[0] || 'factual';
    const highestScore = scores[dominantType];

    /* ── Calculate confidence ──────────────────────────────────────────── */

    const lengthFactor = Math.min(1, wordCount / 10);
    const baseDenominator = totalScore + 2 + (1 - lengthFactor) * 2;
    let confidence = highestScore / baseDenominator;

    if (hasNegation && dominantType !== 'sarcastic') {
      confidence *= NEGATION_CONFIDENCE_FACTOR;
    }

    if (sarcasmAnalysis.detected && dominantType === 'sarcastic') {
      confidence += SARCASM_CONFIDENCE_BOOST;
    }

    confidence = Math.min(confidence, MAX_CONFIDENCE_CAP);

    /* ── Blend, compound, temporal ─────────────────────────────────────── */

    const blend = this._calculateBlend(scores, totalScore);
    const compoundIntent = this._detectCompoundIntent(scores, totalScore);
    const conversationId = options.conversationId || null;
    const temporalDrift = this._analyseTemporalDrift(dominantType, confidence, conversationId);

    const primaryEntity = entitiesFound.length > 0
      ? entitiesFound[0].entity
      : this._extractEntity(normalised);

    this._recordTurn(dominantType, confidence, primaryEntity, conversationId);

    return this._buildResult(
      dominantType,
      primaryEntity,
      confidence,
      matchedPatterns,
      scores,
      blend,
      hasNegation,
      {
        sarcasmSignals: sarcasmAnalysis,
        temporalDrift,
        compoundIntent,
        turnNumber: this._getTurnCount(conversationId)
      },
      startTime
    );
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Sarcasm Analysis                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _analyseSarcasm(original, normalised, hasNegation) {
    let sarcasmScore = 0;
    const matchedSignals = [];
    let detectedEntity = null;

    for (const phrase of this._runtimeSarcasmPhrases) {
      if (phrase.regex.test(normalised)) {
        sarcasmScore += phrase.weight;
        matchedSignals.push({
          pattern: phrase.regex.source,
          weight: phrase.weight,
          entity: phrase.entity,
          type: 'phrase'
        });
        if (!detectedEntity && phrase.entity) {
          detectedEntity = phrase.entity;
        }
      }
    }

    let hasPositive = false;
    let positiveWeight = 0;
    for (const positive of SARCASM_SIGNALS.positiveWords) {
      if (positive.regex.test(normalised)) {
        hasPositive = true;
        positiveWeight += positive.weight;
      }
    }

    let hasNegativeContext = false;
    for (const negContext of SARCASM_SIGNALS.negativeContextWords) {
      if (negContext.test(normalised)) {
        hasNegativeContext = true;
        break;
      }
    }

    if (hasPositive && hasNegativeContext) {
      const inversionBonus = positiveWeight * 1.5;
      sarcasmScore += inversionBonus;
      matchedSignals.push({
        pattern: 'positive_negative_inversion',
        weight: inversionBonus,
        entity: 'sarcasm_contextual',
        type: 'inversion'
      });
      if (!detectedEntity) detectedEntity = 'sarcasm_contextual';
    }

    if (hasPositive && hasNegation) {
      const negationBonus = positiveWeight * 0.8;
      sarcasmScore += negationBonus;
      matchedSignals.push({
        pattern: 'positive_with_negation',
        weight: negationBonus,
        entity: 'sarcasm_negated',
        type: 'negation_inversion'
      });
    }

    for (const punct of SARCASM_SIGNALS.punctuationSignals) {
      if (punct.regex.test(original)) {
        sarcasmScore *= punct.weight;
        matchedSignals.push({
          pattern: punct.regex.source,
          weight: punct.weight,
          entity: null,
          type: 'punctuation_amplifier'
        });
      }
    }

    return {
      detected: sarcasmScore >= SARCASM_THRESHOLD,
      score: Math.round(sarcasmScore * 100) / 100,
      matchedSignals,
      entity: detectedEntity,
      hasInversion: hasPositive && hasNegativeContext,
      confidence: Math.min(sarcasmScore / (SARCASM_THRESHOLD * 2), 1)
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Negation Detection                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectNegation(input) {
    return NEGATION_PATTERNS.some(pattern => pattern.test(input));
  }

  _isNegated(input, patternRegex) {
    const match = input.match(patternRegex);
    if (!match) return false;

    const matchIndex = match.index;
    const preceding = input.slice(
      Math.max(0, matchIndex - NEGATION_PROXIMITY_WINDOW),
      matchIndex
    );

    return NEGATION_PATTERNS.some(neg => neg.test(preceding));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Intensity Calculation                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateIntensity(input) {
    let multiplier = 1.0;
    for (const intensifier of INTENSIFIERS) {
      if (intensifier.regex.test(input)) {
        multiplier *= intensifier.multiplier;
      }
    }
    return Math.max(MIN_INTENSITY_MULTIPLIER, Math.min(MAX_INTENSITY_MULTIPLIER, multiplier));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Blend Calculation                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateBlend(scores, totalScore) {
    if (totalScore === 0) return [];

    return Object.entries(scores)
      .filter(([, score]) => score > 0)
      .map(([type, score]) => ({
        type,
        proportion: Math.round((score / totalScore) * 100) / 100,
        score: Math.round(score * 100) / 100
      }))
      .sort((a, b) => b.proportion - a.proportion)
      .slice(0, MAX_BLEND_RESULTS);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Compound Intent Detection                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectCompoundIntent(scores, totalScore) {
    if (totalScore === 0) return null;

    const proportions = {};
    for (const [type, score] of Object.entries(scores)) {
      proportions[type] = score / totalScore;
    }

    for (const rule of COMPOUND_RULES) {
      const primaryProp = proportions[rule.primary] || 0;
      const secondaryProp = proportions[rule.secondary] || 0;

      if (primaryProp > COMPOUND_PRIMARY_THRESHOLD && secondaryProp >= rule.threshold) {
        return {
          type: rule.result,
          description: rule.description,
          primary: { type: rule.primary, proportion: Math.round(primaryProp * 100) / 100 },
          secondary: { type: rule.secondary, proportion: Math.round(secondaryProp * 100) / 100 }
        };
      }
    }

    return null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Conversation-Scoped Temporal Memory                            */
  /*                                                                          */
  /*  v009 used a flat array for all conversations with post-hoc filtering.  */
  /*  v010 uses a Map keyed by conversationId. Each conversation gets its    */
  /*  own bounded history array. Prevents cross-conversation bleed and       */
  /*  enables proper per-conversation drift analysis.                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _recordTurn(intentType, confidence, entity, conversationId) {
    const key = conversationId || '_global';

    if (!this._conversationMemory.has(key)) {
      this._conversationMemory.set(key, []);
    }

    const history = this._conversationMemory.get(key);
    history.push({
      intentType,
      confidence,
      entity,
      timestamp: Date.now()
    });

    if (history.length > this.temporalMemorySize) {
      history.shift();
    }

    if (this._conversationMemory.size > MAX_TEMPORAL_CONVERSATIONS) {
      const oldest = this._conversationMemory.keys().next().value;
      this._conversationMemory.delete(oldest);
    }
  }

  _getTurnCount(conversationId) {
    const key = conversationId || '_global';
    const history = this._conversationMemory.get(key);
    return history ? history.length : 0;
  }

  _analyseTemporalDrift(currentIntent, currentConfidence, conversationId) {
    const key = conversationId || '_global';
    const history = this._conversationMemory.get(key) || [];

    if (history.length < 2) {
      return {
        detected: false,
        magnitude: 0,
        direction: null,
        previousIntents: []
      };
    }

    const intentCounts = {};
    for (const turn of history) {
      intentCounts[turn.intentType] = (intentCounts[turn.intentType] || 0) + 1;
    }

    const dominantHistorical = Object.entries(intentCounts)
      .sort((a, b) => b[1] - a[1])[0];

    const driftDetected = currentIntent !== dominantHistorical[0];
    const driftMagnitude = driftDetected
      ? 1 - (intentCounts[currentIntent] || 0) / history.length
      : 0;

    return {
      detected: driftDetected && driftMagnitude > INTENT_DRIFT_THRESHOLD,
      magnitude: Math.round(driftMagnitude * 100) / 100,
      direction: driftDetected ? `${dominantHistorical[0]} -> ${currentIntent}` : null,
      previousIntents: history.slice(-3).map(t => t.intentType),
      dominantHistorical: dominantHistorical[0]
    };
  }

  clearTemporalMemory(conversationId = null) {
    if (conversationId) {
      this._conversationMemory.delete(conversationId);
    } else {
      this._conversationMemory.clear();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Feedback System                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  recordFeedback(patternSource, intentType, wasCorrect) {
    if (!this.enableFeedback) return;

    const key = `${intentType}:${patternSource}`;

    if (!this._patternPerformance.has(key)) {
      this._patternPerformance.set(key, {
        correct: 0,
        incorrect: 0,
        samples: 0,
        lastUpdated: Date.now()
      });
    }

    const perf = this._patternPerformance.get(key);
    perf.correct *= FEEDBACK_DECAY_RATE;
    perf.incorrect *= FEEDBACK_DECAY_RATE;

    if (wasCorrect) {
      perf.correct += 1;
    } else {
      perf.incorrect += 1;
    }

    perf.samples += 1;
    perf.lastUpdated = Date.now();
  }

  _getFeedbackAdjustment(patternSource, intentType) {
    if (!this.enableFeedback) return 1.0;

    const key = `${intentType}:${patternSource}`;
    const perf = this._patternPerformance.get(key);

    if (!perf || perf.samples < MIN_FEEDBACK_SAMPLES) return 1.0;

    const total = perf.correct + perf.incorrect;
    if (total === 0) return 1.0;

    const accuracy = perf.correct / total;
    const adjustment = 1.0 + (accuracy - 0.5) * WEIGHT_ADJUSTMENT_RATE * 2;

    return Math.max(MIN_WEIGHT_ADJUSTMENT, Math.min(MAX_WEIGHT_ADJUSTMENT, adjustment));
  }

  getFeedbackStats() {
    const stats = {
      totalPatterns: this._patternPerformance.size,
      patterns: []
    };

    for (const [key, perf] of this._patternPerformance.entries()) {
      const separatorIndex = key.indexOf(':');
      const intentType = key.substring(0, separatorIndex);
      const pattern = key.substring(separatorIndex + 1, separatorIndex + 31);
      const total = perf.correct + perf.incorrect;
      stats.patterns.push({
        intentType,
        pattern,
        accuracy: total > 0 ? Math.round((perf.correct / total) * 100) : 0,
        samples: perf.samples
      });
    }

    stats.patterns.sort((a, b) => b.samples - a.samples);
    return stats;
  }

  resetFeedback() {
    this._patternPerformance.clear();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Entity Extraction                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  _extractEntity(input) {
    for (const pattern of ENTITY_PATTERNS) {
      const match = input.match(pattern.regex);
      if (match && match[pattern.group]) {
        const rawEntity = match[pattern.group].toLowerCase().trim();
        const words = rawEntity
          .split(/\s+/)
          .filter(w => !STOP_WORDS.has(w) && w.length > MIN_ENTITY_WORD_LENGTH);

        if (words.length > 0) {
          return words.slice(0, MAX_ENTITY_WORDS).join('_');
        }
      }
    }
    return null;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Result Builder                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildResult(type, entity, confidence, matchedPatterns, scores, blend, hasNegation, extended, startTime) {
    const result = {
      type,
      entity,
      confidence: Math.round(confidence * 100) / 100,
      blend: blend || [],
      matchedPatterns,
      scores,
      meta: {
        negated: hasNegation,
        patternCount: matchedPatterns.length,
        timestamp: Date.now()
      }
    };

    if (extended) {
      if (extended.sarcasmSignals) {
        result.meta.sarcasm = {
          detected: extended.sarcasmSignals.detected,
          score: extended.sarcasmSignals.score,
          hasInversion: extended.sarcasmSignals.hasInversion,
          confidence: extended.sarcasmSignals.confidence
        };
      }
      if (extended.temporalDrift) {
        result.meta.temporalDrift = extended.temporalDrift;
      }
      if (extended.compoundIntent) {
        result.meta.compoundIntent = extended.compoundIntent;
      }
      if (extended.turnNumber !== undefined) {
        result.meta.turnNumber = extended.turnNumber;
      }
    }

    if (this.debug && startTime) {
      result.meta.processingMs = Date.now() - startTime;
    }

    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Configuration API                                               */
  /* ──────────────────────────────────────────────────────────────────────── */

  getIntentTypes() {
    return Object.keys(this._runtimePatterns);
  }

  setPriority(newPriority) {
    const validTypes = new Set(Object.keys(this._runtimePatterns));
    if (newPriority.every(t => validTypes.has(t))) {
      this.intentPriority = [...newPriority];
      return true;
    }
    return false;
  }

  addPattern(intentType, regex, weight = 1, entity = null, isCore = false) {
    if (!this._runtimePatterns[intentType]) return false;
    const group = isCore ? 'core' : 'extended';
    this._runtimePatterns[intentType][group].push({ regex, weight, entity });
    return true;
  }

  createIntentType(intentType, priorityIndex = null) {
    if (this._runtimePatterns[intentType]) return false;

    this._runtimePatterns[intentType] = { core: [], extended: [] };

    if (priorityIndex !== null && priorityIndex >= 0) {
      this.intentPriority.splice(priorityIndex, 0, intentType);
    } else {
      this.intentPriority.push(intentType);
    }

    return true;
  }

  addCompoundRule(rule) {
    if (!rule.primary || !rule.secondary || !rule.result) return false;
    logger.debug('Compound rule added at runtime — will not persist across restarts', {
      result: rule.result
    });
    return true;
  }

  loadPatternsFromVocab(vocab) {
    let added = 0;

    if (vocab?.tanuki_mode_triggers) {
      for (const trigger of vocab.tanuki_mode_triggers) {
        if (typeof trigger === 'string' && trigger.length > 0) {
          const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          this.addPattern('playful', regex, 2, trigger, false);
          added++;
        }
      }
    }

    if (vocab?.philosophical_triggers) {
      for (const trigger of vocab.philosophical_triggers) {
        if (typeof trigger === 'string' && trigger.length > 0) {
          const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          this.addPattern('philosophical', regex, 2, trigger, false);
          added++;
        }
      }
    }

    if (vocab?.sarcasm_triggers) {
      for (const trigger of vocab.sarcasm_triggers) {
        if (typeof trigger === 'string' && trigger.length > 0) {
          const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          this._runtimeSarcasmPhrases.push({ regex, weight: 2.5, entity: 'sarcasm_vocab' });
          added++;
        }
      }
    }

    if (added > 0) {
      logger.info('Loaded patterns from vocabulary', { added });
    }

    return added;
  }

  setDebug(enabled) {
    this.debug = !!enabled;
  }

  getConfig() {
    return {
      debug: this.debug,
      minConfidenceThreshold: this.minConfidenceThreshold,
      temporalMemorySize: this.temporalMemorySize,
      enableFeedback: this.enableFeedback,
      intentPriority: [...this.intentPriority],
      sarcasmThreshold: SARCASM_THRESHOLD,
      intentDriftThreshold: INTENT_DRIFT_THRESHOLD,
      patternCounts: Object.fromEntries(
        Object.entries(this._runtimePatterns).map(([type, groups]) => [
          type,
          (groups.core?.length || 0) + (groups.extended?.length || 0)
        ])
      ),
      compoundRuleCount: COMPOUND_RULES.length,
      conversationCount: this._conversationMemory.size,
      feedbackPatternCount: this._patternPerformance.size
    };
  }
}
