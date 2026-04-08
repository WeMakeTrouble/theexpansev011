/**
 * ============================================================================
 * entityExplanationParser.js — Rule-Based Entity Explanation Parser (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Parses user explanations of unfamiliar references into structured entity
 * data. Pure function — no DB calls, no side effects, no external APIs.
 *
 * Called by PhaseTeaching when qudActivation.type === 'entity_explanation'.
 * Output feeds directly into taughtEntityCapturer.captureEntity().
 *
 * PARSING PIPELINE
 * ----------------
 * Two-pass deterministic pattern cascade:
 *
 * Pass 1 — Phrase-anchored patterns (highest precision):
 *   Require the target phrase to appear in the explanation. Prevents parsing
 *   explanations about the wrong subject.
 *   a. RELATIONSHIP (multi-word): "[NAME] is my best friend"
 *   b. RELATIONSHIP (single):    "[NAME] is my dog"
 *   c. LOCATION (full):          "[NAME] is a beach near Sydney"
 *   d. LOCATION (simple):        "[NAME] is a park"
 *   e. ACTIVITY:                  "[NAME] is a sport"
 *   f. INSTITUTION:               "[NAME] is a school"
 *
 * Pass 2 — Generic patterns (pronoun-based, lower precision):
 *   Match explanations using pronouns instead of the target phrase.
 *   a. RELATIONSHIP (pronoun):    "that's my dog" / "my brother"
 *   b. LOCATION (pronoun):        "it's a beach" / "it's a place"
 *
 * Additional fallback:
 *   - Question type hint (who → PERSON, where → LOCATION)
 *   - Raw fallback with explanation preserved for admin review
 *
 * NOTE: SLANG handling has been removed from this parser.
 * All "X means Y" / "it's slang for Y" patterns are handled exclusively
 * by vocabExplanationParser.js. Routing is determined by QUD type in
 * BrainOrchestrator (entity_explanation → here, vocab_explanation → vocab).
 *
 * CONFIDENCE MODEL
 * ----------------
 * Every result includes both numeric score (0.30-0.99) and categorical tier:
 *   high   (>= 0.80) — direct consent gate
 *   medium (0.60-0.79) — confirmation sub-QUD
 *   low    (< 0.60) — store raw, flag needs_clarification
 *
 * Numeric scores enable admin dashboards, confidence ramp analysis, and
 * finer-grained routing decisions.
 *
 * Base confidence per pattern + additive bonuses:
 *   - Vocabulary hit bonus (+0.05): relationship word found in lookup table
 *   - Multi-word bonus (+0.03): multi-word relationship matched
 *   - Location area bonus (+0.04): full location with area specified
 *
 * PARSING FLAGS
 * -------------
 * parsed:              High-confidence structured extraction
 * needs_clarification: Pattern matched but ambiguous vocabulary
 * unparsed_raw:        No pattern matched, stored verbatim for admin review
 *
 * PERFORMANCE
 * -----------
 * - All static regex precompiled at module load
 * - Phrase-specific regex built once per call via _buildAnchoredPatterns()
 * - Vocabulary lookups via frozen Sets and Objects (O(1))
 * - Single toLowerCase pass in main function
 * - Clause count capped to prevent pathological splitting
 *
 * DEPENDENCIES
 * ------------
 * Internal: createModuleLogger only
 * External: None
 *
 * EXPORTS
 * -------
 * default: parseExplanation(explanation, phrase, questionType)
 * named:   requiresConfirmation(parsed)
 *          getStats()
 *          resetMetrics()
 *          RELATIONSHIP_VOCABULARY
 *          MULTI_WORD_RELATIONSHIPS
 *          LOCATION_WORDS
 *          ACTIVITY_WORDS
 *          INSTITUTION_WORDS
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('EntityExplanationParser');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const PARSER_VERSION = 'v010.2';
const MAX_INPUT_LENGTH = 500;
const MAX_PHRASE_LENGTH = 100;
const MAX_CLAUSE_COUNT = 5;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Confidence Tier Boundaries                                                */
/* ────────────────────────────────────────────────────────────────────────── */

const HIGH_CONFIDENCE_THRESHOLD = 0.80;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.60;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Confidence Bonuses — Additive Adjustments                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const VOCAB_HIT_BONUS = 0.05;
const MULTI_WORD_BONUS = 0.03;
const LOCATION_AREA_BONUS = 0.04;

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
  }

  recordClarification() {
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
/*  Precompiled Static Regex (built once at module load)                      */
/* ────────────────────────────────────────────────────────────────────────── */

const CLAUSE_SPLITTER = /\s+(?:but|and|who|which|where|that)\s+/i;
const TRAILING_PUNCTUATION = /[.!?,;:]+$/;
const PRONOUN_GROUP = '(?:my|our|his|her|their)';
const PRONOUN_SUBJECT = '(?:that\'s|thats|it\'s|its|he\'s|hes|she\'s|shes|they\'re|theyre)';
const IS_VARIANTS = '(?:\'s|\\s+is)';

const NEGATION_PATTERNS = Object.freeze([
  /(?:'s|\s+is)\s+not\b/i,
  /\s+isn't\b/i,
  /\s+isnt\b/i,
  /(?:that's|it's|he's|she's)\s+not\b/i,
  /^(?:no|nah|nope),?\s+/i
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  False Positive Guards                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const FALSE_POSITIVE_MY_WORDS = Object.freeze(new Set([
  'god', 'goodness', 'gosh', 'word', 'bad', 'fault',
  'favourite', 'favorite', 'pleasure', 'honour', 'honor',
  'opinion', 'guess', 'way', 'turn', 'problem', 'mistake',
  'point', 'dear', 'love', 'life', 'self', 'own', 'man',
  'dude', 'guy', 'girl', 'lord', 'oh', 'head', 'heart',
  'mind', 'thing', 'stuff', 'business', 'time', 'day'
]));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Vocabulary Lookups (frozen Sets and Objects for O(1))                     */
/* ────────────────────────────────────────────────────────────────────────── */

const RELATIONSHIP_VOCABULARY = Object.freeze({
  dog:         { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'dog' } },
  dogs:        { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'dog' } },
  puppy:       { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'dog' } },
  pup:         { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'dog' } },
  cat:         { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'cat' } },
  cats:        { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'cat' } },
  kitten:      { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'cat' } },
  bird:        { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'bird' } },
  fish:        { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'fish' } },
  hamster:     { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'hamster' } },
  rabbit:      { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'rabbit' } },
  bunny:       { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'rabbit' } },
  horse:       { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'horse' } },
  turtle:      { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'turtle' } },
  lizard:      { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'lizard' } },
  snake:       { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'snake' } },
  parrot:      { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'parrot' } },
  pet:         { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: {} },
  friend:      { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: {} },
  bestie:      { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: {} },
  bff:         { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: {} },
  mate:        { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: {} },
  pal:         { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: {} },
  buddy:       { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: {} },
  mum:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'mother' } },
  mom:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'mother' } },
  mother:      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'mother' } },
  dad:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'father' } },
  father:      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'father' } },
  brother:     { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'brother' } },
  bro:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'brother' } },
  sister:      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'sister' } },
  sis:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'sister' } },
  nan:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandmother' } },
  nana:        { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandmother' } },
  grandma:     { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandmother' } },
  grandmother: { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandmother' } },
  grandpa:     { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandfather' } },
  grandfather: { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandfather' } },
  pop:         { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'grandfather' } },
  uncle:       { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'uncle' } },
  aunt:        { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'aunt' } },
  auntie:      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'aunt' } },
  cousin:      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'cousin' } },
  niece:       { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'niece' } },
  nephew:      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'nephew' } },
  teacher:     { entity_type: 'PERSON', relationship_type: 'ACADEMIC', attributes: { role: 'teacher' } },
  coach:       { entity_type: 'PERSON', relationship_type: 'ACADEMIC', attributes: { role: 'coach' } },
  tutor:       { entity_type: 'PERSON', relationship_type: 'ACADEMIC', attributes: { role: 'tutor' } },
  principal:   { entity_type: 'PERSON', relationship_type: 'ACADEMIC', attributes: { role: 'principal' } },
  boss:        { entity_type: 'PERSON', relationship_type: 'WORK',     attributes: { role: 'boss' } },
  colleague:   { entity_type: 'PERSON', relationship_type: 'WORK',     attributes: { role: 'colleague' } },
  neighbour:   { entity_type: 'PERSON', relationship_type: 'SOCIAL',   attributes: { role: 'neighbour' } },
  neighbor:    { entity_type: 'PERSON', relationship_type: 'SOCIAL',   attributes: { role: 'neighbor' } },
  boyfriend:   { entity_type: 'PERSON', relationship_type: 'PARTNER',  attributes: {} },
  girlfriend:  { entity_type: 'PERSON', relationship_type: 'PARTNER',  attributes: {} },
  partner:     { entity_type: 'PERSON', relationship_type: 'PARTNER',  attributes: {} },
  husband:     { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'husband' } },
  wife:        { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'wife' } }
});

const MULTI_WORD_RELATIONSHIPS = Object.freeze({
  'best friend':   { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: { closeness: 'best' } },
  'best mate':     { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: { closeness: 'best' } },
  'good friend':   { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: { closeness: 'close' } },
  'close friend':  { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: { closeness: 'close' } },
  'old friend':    { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: { closeness: 'longstanding' } },
  'guinea pig':    { entity_type: 'PET',    relationship_type: 'OWNER',    attributes: { species: 'guinea pig' } },
  'step mum':      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'stepmother' } },
  'step mom':      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'stepmother' } },
  'step dad':      { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'stepfather' } },
  'step brother':  { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'stepbrother' } },
  'step sister':   { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'stepsister' } },
  'half brother':  { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'halfbrother' } },
  'half sister':   { entity_type: 'PERSON', relationship_type: 'FAMILY',   attributes: { familyRole: 'halfsister' } },
  'work mate':     { entity_type: 'PERSON', relationship_type: 'WORK',     attributes: { role: 'colleague' } },
  'team mate':     { entity_type: 'PERSON', relationship_type: 'SOCIAL',   attributes: { role: 'teammate' } },
  'class mate':    { entity_type: 'PERSON', relationship_type: 'ACADEMIC', attributes: { role: 'classmate' } },
  'pen pal':       { entity_type: 'PERSON', relationship_type: 'FRIEND',   attributes: { closeness: 'remote' } }
});

const LOCATION_WORDS = Object.freeze(new Set([
  'beach', 'park', 'shop', 'store', 'cafe', 'restaurant', 'school',
  'place', 'spot', 'town', 'city', 'village', 'suburb', 'area',
  'street', 'road', 'hill', 'mountain', 'lake', 'river', 'creek',
  'field', 'oval', 'court', 'pool', 'gym', 'club', 'bar', 'pub',
  'mall', 'centre', 'center', 'station', 'airport', 'harbour',
  'harbor', 'island', 'bay', 'point', 'valley', 'forest', 'woods',
  'cove', 'glen', 'meadow', 'quay', 'wharf', 'pier', 'plaza',
  'reserve', 'gardens', 'garden', 'track', 'trail', 'ridge',
  'headland', 'lookout', 'dam', 'falls', 'waterfall', 'bridge',
  'market', 'arcade', 'precinct', 'estate', 'campus', 'ground'
]));

const ACTIVITY_WORDS = Object.freeze(new Set([
  'sport', 'game', 'hobby', 'class', 'lesson', 'practice', 'training',
  'footy', 'football', 'soccer', 'cricket', 'basketball', 'netball',
  'tennis', 'swimming', 'surfing', 'skating', 'dancing', 'singing',
  'coding', 'gaming', 'reading', 'drawing', 'painting', 'cooking',
  'rugby', 'hockey', 'volleyball', 'athletics', 'gymnastics',
  'karate', 'judo', 'boxing', 'wrestling', 'yoga', 'pilates',
  'running', 'cycling', 'hiking', 'fishing', 'climbing', 'rowing'
]));

const INSTITUTION_WORDS = Object.freeze(new Set([
  'school', 'uni', 'university', 'college', 'tafe', 'academy',
  'company', 'firm', 'business', 'office', 'hospital', 'church',
  'temple', 'mosque', 'team', 'band', 'group', 'organisation',
  'organization', 'charity', 'clinic', 'studio', 'lab', 'library',
  'institute', 'foundation', 'council', 'committee', 'society'
]));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Precompiled Vocabulary Alternations (built once at module load)           */
/* ────────────────────────────────────────────────────────────────────────── */

const LOCATION_ALTERNATION = [...LOCATION_WORDS].join('|');
const ACTIVITY_ALTERNATION = [...ACTIVITY_WORDS].join('|');
const INSTITUTION_ALTERNATION = [...INSTITUTION_WORDS].join('|');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Generic Patterns (Pass 2 — pronoun-based, no phrase anchoring)           */
/*                                                                            */
/*  These match explanations like "that's my dog" or "my brother" where     */
/*  the user doesn't repeat the entity name.                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const GENERIC_RELATIONSHIP_PATTERNS = Object.freeze([
  {
    name: 'generic_pronoun_subject_rel',
    re: new RegExp(`${PRONOUN_SUBJECT}\\s+${PRONOUN_GROUP}\\s+(\\w+)`, 'i'),
    baseConf: 0.78
  },
  {
    name: 'generic_possessive_rel',
    re: new RegExp(`${PRONOUN_GROUP}\\s+(\\w+)`, 'i'),
    baseConf: 0.72
  }
]);

const GENERIC_LOCATION_PATTERN = {
  name: 'generic_location',
  re: new RegExp(
    `(?:${PRONOUN_SUBJECT}|it${IS_VARIANTS})\\s+(?:a|an|the|this)\\s+(${LOCATION_ALTERNATION})\\b`,
    'i'
  ),
  baseConf: 0.70
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _escapeRegex                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function _escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _buildAnchoredPatterns                                           */
/*                                                                            */
/*  Constructs phrase-specific regex patterns that require the target        */
/*  phrase to appear in the explanation. Built fresh per call.               */
/*  These are Pass 1 (highest precision).                                    */
/*                                                                            */
/*  @param {string} phraseEscaped — Regex-escaped target phrase              */
/*  @returns {object} Pattern collections for each entity type               */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildAnchoredPatterns(phraseEscaped) {
  const p = phraseEscaped;
  const is = IS_VARIANTS;

  return Object.freeze({
    relationship: [
      {
        name: 'anchored_possessive_rel',
        re: new RegExp(`${p}${is}\\s+${PRONOUN_GROUP}\\s+(\\w+)`, 'i'),
        baseConf: 0.88
      }
    ],
    multiWordRelationship: Object.entries(MULTI_WORD_RELATIONSHIPS).map(([mw, mwLookup]) => ({
      name: `anchored_multiword_${mw.replace(/\s+/g, '_')}`,
      pattern: new RegExp(`(?:${p}${is}|${PRONOUN_SUBJECT})\\s+${PRONOUN_GROUP}\\s+${_escapeRegex(mw)}\\b`, 'i'),
      lookup: mwLookup,
      baseConf: 0.92
    })),
    locationFull: {
      name: 'anchored_location_full',
      re: new RegExp(
        `${p}${is}\\s+(?:a|an|the|this)\\s+(\\w+)\\s+(?:in|near|at|by|close to|next to|around|outside|off)\\s+(.+)`,
        'i'
      ),
      baseConf: 0.88
    },
    locationSimple: {
      name: 'anchored_location_simple',
      re: new RegExp(
        `${p}${is}\\s+(?:a|an|the|this)\\s+(${LOCATION_ALTERNATION})\\b`,
        'i'
      ),
      baseConf: 0.78
    },
    activity: {
      name: 'anchored_activity',
      re: new RegExp(
        `${p}${is}\\s+(?:a|an|my|our|this)\\s+(${ACTIVITY_ALTERNATION})\\b`,
        'i'
      ),
      baseConf: 0.80
    },
    institution: {
      name: 'anchored_institution',
      re: new RegExp(
        `${p}${is}\\s+(?:a|an|my|our|the|this)\\s+(${INSTITUTION_ALTERNATION})\\b`,
        'i'
      ),
      baseConf: 0.80
    },
    negation: [
      new RegExp(`${p}${is}\\s+not\\b`, 'i'),
      new RegExp(`${p}\\s+isn't\\b`, 'i'),
      new RegExp(`${p}\\s+isnt\\b`, 'i')
    ]
  });
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
/*  Private: _parsingFlag                                                     */
/*                                                                            */
/*  Maps confidence tier to parsing flag.                                    */
/*  Aligned with vocabExplanationParser taxonomy.                            */
/*                                                                            */
/*  @param {string} tier — 'high' | 'medium' | 'low'                        */
/*  @returns {string} 'parsed' | 'needs_clarification' | 'unparsed_raw'     */
/* ────────────────────────────────────────────────────────────────────────── */

function _parsingFlag(tier) {
  if (tier === 'high') return 'parsed';
  if (tier === 'medium') return 'needs_clarification';
  return 'unparsed_raw';
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: _buildResult                                                     */
/*                                                                            */
/*  Centralised result builder. Constructs all successful parse results     */
/*  in one pass. No post-hoc object mutation.                                */
/*                                                                            */
/*  @param {object} entityData — Core entity fields                          */
/*  @param {string} patternName — Name of matching pattern                   */
/*  @param {number} confidenceScore — Numeric confidence 0-0.99             */
/*  @param {string} originalInput — Original explanation (original casing)  */
/*  @returns {object} Complete parse result                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildResult(entityData, patternName, confidenceScore, originalInput) {
  const cappedScore = Math.min(confidenceScore, 0.99);
  const confidence = _confidenceTier(cappedScore);

  metrics.recordSuccess(patternName, cappedScore);

  const result = {
    entity_name: entityData.entity_name,
    entity_type: entityData.entity_type,
    relationship_type: entityData.relationship_type || null,
    attributes: entityData.attributes || {},
    original_explanation: originalInput,
    confidence,
    confidenceScore: parseFloat(cappedScore.toFixed(4)),
    pattern: patternName,
    parsing_flag: _parsingFlag(confidence),
    version: PARSER_VERSION
  };

  logger.info('explanation.parsed', {
    phrase: entityData.entity_name,
    pattern: patternName,
    entityType: result.entity_type,
    relationshipType: result.relationship_type,
    confidence,
    confidenceScore: result.confidenceScore
  });

  return result;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Main Parser                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Parses a user explanation into structured entity data.
 *
 * Two-pass cascade:
 *   Pass 1: Phrase-anchored patterns (highest precision)
 *   Pass 2: Generic pronoun-based patterns (lower precision)
 *   Fallback: Question type hint, then raw fallback
 *
 * @param {string} explanation - Raw user text (e.g., "Max is my dog")
 * @param {string} phrase - The entity phrase asked about (e.g., "Max")
 * @param {string} questionType - The question type used (who/what/where)
 * @returns {object} Parsed entity data ready for taughtEntityCapturer
 */
function parseExplanation(explanation, phrase, questionType) {
  metrics.parseCalls++;

  /* ── Input validation ──────────────────────────────────────────────── */

  if (!explanation || typeof explanation !== 'string' || explanation.trim().length === 0) {
    logger.debug('explanation.parse.empty', { phrase: phrase || null });
    metrics.recordFailure();
    return _rawFallback(null, phrase, questionType);
  }

  if (!phrase || typeof phrase !== 'string' || phrase.trim().length === 0) {
    logger.debug('explanation.parse.no_phrase', { explanationLength: explanation.length });
    metrics.recordFailure();
    return _rawFallback(explanation, null, questionType);
  }

  /* ── Normalisation (single pass, both casings preserved for logs) ─── */

  const input = explanation.trim().slice(0, MAX_INPUT_LENGTH);
  const inputLower = input.toLowerCase();
  const cleanPhrase = phrase.trim().slice(0, MAX_PHRASE_LENGTH);
  const phraseLower = cleanPhrase.toLowerCase();
  const phraseEscaped = _escapeRegex(phraseLower);

  /* ── Build phrase-specific patterns (once per call) ────────────────── */

  const anchored = _buildAnchoredPatterns(phraseEscaped);

  /* ── Negation check ────────────────────────────────────────────────── */

  if (_isNegated(inputLower, anchored)) {
    logger.info('explanation.parse.negated', {
      phrase: cleanPhrase,
      inputLength: input.length,
      originalPreview: input.slice(0, 60)
    });
    metrics.recordFailure();
    return _rawFallback(input, cleanPhrase, questionType);
  }

  /* ── Multi-clause splitting with count guard ───────────────────────── */

  const clauses = _splitClauses(inputLower);

  for (const clause of clauses) {
    if (clause.length === 0) continue;

    /* ════════════════════════════════════════════════════════════════ */
    /*  PASS 1: Phrase-Anchored Patterns (Highest Precision)           */
    /* ════════════════════════════════════════════════════════════════ */

    /* ── 1a. Multi-word relationships (highest specificity) ─────── */

    const mwResult = _matchMultiWordRelationship(clause, cleanPhrase, anchored);
    if (mwResult) return _buildResult(mwResult.data, mwResult.name, mwResult.conf, input);

    /* ── 1b. Single-word relationships (phrase-anchored) ────────── */

    const anchoredRelResult = _matchAnchoredRelationship(clause, cleanPhrase, anchored);
    if (anchoredRelResult) return _buildResult(anchoredRelResult.data, anchoredRelResult.name, anchoredRelResult.conf, input);

    /* ── 1c. Location full (phrase + place + area) ──────────────── */

    const locFullResult = _matchAnchoredLocationFull(clause, cleanPhrase, anchored);
    if (locFullResult) return _buildResult(locFullResult.data, locFullResult.name, locFullResult.conf, input);

    /* ── 1d. Location simple (phrase + place type) ──────────────── */

    const locSimpleResult = _matchAnchoredLocationSimple(clause, cleanPhrase, anchored);
    if (locSimpleResult) return _buildResult(locSimpleResult.data, locSimpleResult.name, locSimpleResult.conf, input);

    /* ── 1e. Activity (phrase + activity word) ──────────────────── */

    const actResult = _matchAnchoredActivity(clause, cleanPhrase, anchored);
    if (actResult) return _buildResult(actResult.data, actResult.name, actResult.conf, input);

    /* ── 1f. Institution (phrase + institution word) ─────────────── */

    const instResult = _matchAnchoredInstitution(clause, cleanPhrase, anchored);
    if (instResult) return _buildResult(instResult.data, instResult.name, instResult.conf, input);

    /* ════════════════════════════════════════════════════════════════ */
    /*  PASS 2: Generic Patterns (Pronoun-Based, Lower Precision)      */
    /* ════════════════════════════════════════════════════════════════ */

    /* ── 2a. Generic relationship ("that's my dog" / "my brother") ─ */

    const genRelResult = _matchGenericRelationship(clause, cleanPhrase);
    if (genRelResult) return _buildResult(genRelResult.data, genRelResult.name, genRelResult.conf, input);

    /* ── 2b. Generic location ("it's a beach") ─────────────────── */

    const genLocResult = _matchGenericLocation(clause, cleanPhrase);
    if (genLocResult) return _buildResult(genLocResult.data, genLocResult.name, genLocResult.conf, input);
  }

  /* ── Question type hint fallback ───────────────────────────────────── */

  if (questionType === 'who') {
    metrics.recordClarification();
    return _buildResult(
      { entity_name: cleanPhrase, entity_type: 'PERSON', relationship_type: null, attributes: {} },
      'question_type_hint_who',
      0.45,
      input
    );
  }

  if (questionType === 'where') {
    metrics.recordClarification();
    return _buildResult(
      { entity_name: cleanPhrase, entity_type: 'LOCATION', relationship_type: null, attributes: {} },
      'question_type_hint_where',
      0.45,
      input
    );
  }

  /* ── Raw Fallback ───────────────────────────────────────────────────── */

  metrics.recordFailure();

  logger.info('explanation.parse.no_match', {
    phrase: cleanPhrase,
    inputLength: input.length,
    inputPreview: inputLower.slice(0, 60),
    originalPreview: input.slice(0, 60),
    clauseCount: clauses.length
  });

  return _rawFallback(input, cleanPhrase, questionType);
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pass 1 Matchers — Phrase-Anchored                                         */
/* ────────────────────────────────────────────────────────────────────────── */

function _matchMultiWordRelationship(clauseLower, phrase, anchored) {
  for (const mw of anchored.multiWordRelationship) {
    if (mw.pattern.test(clauseLower)) {
      return {
        data: {
          entity_name: phrase,
          entity_type: mw.lookup.entity_type,
          relationship_type: mw.lookup.relationship_type,
          attributes: { ...mw.lookup.attributes }
        },
        name: mw.name,
        conf: mw.baseConf + MULTI_WORD_BONUS
      };
    }
  }
  return null;
}

function _matchAnchoredRelationship(clauseLower, phrase, anchored) {
  for (const pat of anchored.relationship) {
    const match = clauseLower.match(pat.re);
    if (match) {
      const relWordRaw = (match[1] || '').replace(TRAILING_PUNCTUATION, '').trim();
      if (!relWordRaw || relWordRaw.length === 0) continue;

      const relWord = relWordRaw.toLowerCase();
      if (FALSE_POSITIVE_MY_WORDS.has(relWord)) continue;

      const normalised = _normalisePlural(relWord);
      const lookup = RELATIONSHIP_VOCABULARY[relWord] || RELATIONSHIP_VOCABULARY[normalised];

      if (lookup) {
        return {
          data: {
            entity_name: phrase,
            entity_type: lookup.entity_type,
            relationship_type: lookup.relationship_type,
            attributes: { ...lookup.attributes }
          },
          name: pat.name,
          conf: pat.baseConf + VOCAB_HIT_BONUS
        };
      }

      return {
        data: {
          entity_name: phrase,
          entity_type: 'PERSON',
          relationship_type: relWord.toUpperCase(),
          attributes: {}
        },
        name: pat.name + '_unknown_rel',
        conf: 0.65
      };
    }
  }
  return null;
}

function _matchAnchoredLocationFull(clauseLower, phrase, anchored) {
  const match = clauseLower.match(anchored.locationFull.re);
  if (match && match[1] && match[2]) {
    const placeType = match[1].toLowerCase();
    const area = match[2].replace(TRAILING_PUNCTUATION, '').trim();

    if (LOCATION_WORDS.has(placeType)) {
      return {
        data: {
          entity_name: phrase,
          entity_type: 'LOCATION',
          relationship_type: 'FREQUENTS',
          attributes: { placeType, area }
        },
        name: anchored.locationFull.name,
        conf: anchored.locationFull.baseConf + LOCATION_AREA_BONUS
      };
    }
  }
  return null;
}

function _matchAnchoredLocationSimple(clauseLower, phrase, anchored) {
  const match = clauseLower.match(anchored.locationSimple.re);
  if (match && match[1]) {
    return {
      data: {
        entity_name: phrase,
        entity_type: 'LOCATION',
        relationship_type: 'FREQUENTS',
        attributes: { placeType: match[1].toLowerCase() }
      },
      name: anchored.locationSimple.name,
      conf: anchored.locationSimple.baseConf
    };
  }
  return null;
}

function _matchAnchoredActivity(clauseLower, phrase, anchored) {
  const match = clauseLower.match(anchored.activity.re);
  if (match && match[1]) {
    return {
      data: {
        entity_name: phrase,
        entity_type: 'ACTIVITY',
        relationship_type: 'PARTICIPATES',
        attributes: { activityType: match[1].toLowerCase() }
      },
      name: anchored.activity.name,
      conf: anchored.activity.baseConf
    };
  }
  return null;
}

function _matchAnchoredInstitution(clauseLower, phrase, anchored) {
  const match = clauseLower.match(anchored.institution.re);
  if (match && match[1]) {
    return {
      data: {
        entity_name: phrase,
        entity_type: 'INSTITUTION',
        relationship_type: 'ATTENDS',
        attributes: { institutionType: match[1].toLowerCase() }
      },
      name: anchored.institution.name,
      conf: anchored.institution.baseConf
    };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pass 2 Matchers — Generic (Pronoun-Based)                                 */
/* ────────────────────────────────────────────────────────────────────────── */

function _matchGenericRelationship(clauseLower, phrase) {
  for (const pat of GENERIC_RELATIONSHIP_PATTERNS) {
    const match = clauseLower.match(pat.re);
    if (match) {
      const relWordRaw = (match[2] || match[1] || '').replace(TRAILING_PUNCTUATION, '').trim();
      if (!relWordRaw || relWordRaw.length === 0) continue;

      const relWord = relWordRaw.toLowerCase();
      if (FALSE_POSITIVE_MY_WORDS.has(relWord)) continue;

      const normalised = _normalisePlural(relWord);
      const lookup = RELATIONSHIP_VOCABULARY[relWord] || RELATIONSHIP_VOCABULARY[normalised];

      if (lookup) {
        return {
          data: {
            entity_name: phrase,
            entity_type: lookup.entity_type,
            relationship_type: lookup.relationship_type,
            attributes: { ...lookup.attributes }
          },
          name: pat.name,
          conf: pat.baseConf + VOCAB_HIT_BONUS
        };
      }

      return {
        data: {
          entity_name: phrase,
          entity_type: 'PERSON',
          relationship_type: relWord.toUpperCase(),
          attributes: {}
        },
        name: pat.name + '_unknown_rel',
        conf: 0.58
      };
    }
  }
  return null;
}

function _matchGenericLocation(clauseLower, phrase) {
  const match = clauseLower.match(GENERIC_LOCATION_PATTERN.re);
  if (match && match[1]) {
    return {
      data: {
        entity_name: phrase,
        entity_type: 'LOCATION',
        relationship_type: 'FREQUENTS',
        attributes: { placeType: match[1].toLowerCase() }
      },
      name: GENERIC_LOCATION_PATTERN.name,
      conf: GENERIC_LOCATION_PATTERN.baseConf
    };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function _rawFallback(explanation, phrase, questionType) {
  let fallbackType = 'OBJECT';
  if (questionType === 'who') fallbackType = 'PERSON';
  if (questionType === 'where') fallbackType = 'LOCATION';

  return {
    entity_name: phrase || null,
    entity_type: fallbackType,
    relationship_type: null,
    attributes: {},
    original_explanation: explanation || null,
    confidence: 'low',
    confidenceScore: 0.30,
    pattern: null,
    parsing_flag: 'unparsed_raw',
    version: PARSER_VERSION
  };
}

function _isNegated(inputLower, anchored) {
  for (const pattern of anchored.negation) {
    if (pattern.test(inputLower)) return true;
  }
  for (const pattern of NEGATION_PATTERNS) {
    if (pattern.test(inputLower)) return true;
  }
  return false;
}

function _splitClauses(textLower) {
  const parts = textLower.split(CLAUSE_SPLITTER);
  if (parts.length > MAX_CLAUSE_COUNT) {
    return parts.slice(0, MAX_CLAUSE_COUNT);
  }
  return parts.length > 0 ? parts : [textLower];
}

function _normalisePlural(word) {
  if (word.length <= 2) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Public: requiresConfirmation                                              */
/*                                                                            */
/*  Determines whether the parsed result needs a confirmation sub-QUD       */
/*  before proceeding to consent gate.                                       */
/*                                                                            */
/*  high confidence   -> false (go straight to consent)                     */
/*  medium confidence -> true  (ask "So Max is your dog?")                  */
/*  low confidence    -> false (store raw, flag needs_clarification)         */
/*                                                                            */
/*  Mirrors vocabExplanationParser.requiresConfirmation() exactly.          */
/*                                                                            */
/*  @param {object} parsed — Output from parseExplanation                    */
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
/*  Module Initialisation Log                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

logger.info('EntityExplanationParser initialised', {
  version: PARSER_VERSION,
  relationshipVocabSize: Object.keys(RELATIONSHIP_VOCABULARY).length,
  multiWordRelSize: Object.keys(MULTI_WORD_RELATIONSHIPS).length,
  locationWords: LOCATION_WORDS.size,
  activityWords: ACTIVITY_WORDS.size,
  institutionWords: INSTITUTION_WORDS.size,
  highConfThreshold: HIGH_CONFIDENCE_THRESHOLD,
  medConfThreshold: MEDIUM_CONFIDENCE_THRESHOLD
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export default parseExplanation;

export {
  requiresConfirmation,
  getStats,
  resetMetrics,
  RELATIONSHIP_VOCABULARY,
  MULTI_WORD_RELATIONSHIPS,
  LOCATION_WORDS,
  ACTIVITY_WORDS,
  INSTITUTION_WORDS
};
