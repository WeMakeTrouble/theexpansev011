/**
 * ============================================================================
 * referenceDetector.js — Unfamiliar Reference Detector (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Detects unfamiliar NAMES, PLACES, REFERENCES, and CONCEPTS from the
 * user's real world (Max, Bondi, nan, footy, etc.). Runs in parallel
 * with learningDetector inside EarWig.
 *
 * This is the DETECTION half of the User-Taught Entity Discovery System.
 * The CAPTURE half is taughtEntityCapturer.js.
 *
 * learningDetector catches unfamiliar WORDS (slang, abbreviations).
 * referenceDetector catches unfamiliar ENTITIES (people, pets, places).
 * They are siblings — same parent (EarWig), different specialties.
 *
 * HOW IT WORKS
 * ------------
 * 7 signal detectors run against user input, plus 1 stub for Phase 3:
 *
 *   Signal 1: Capitalised non-sentence-initial tokens
 *             "I was with Max yesterday" — Max is capitalised mid-sentence
 *             Handles apostrophe names (O'Connor) and hyphenated (Jean-Luc)
 *
 *   Signal 2: Possessive + capitalised token
 *             "my Max", "our Sarah", "his Bondi"
 *             Requires capitalised token after possessive pronoun.
 *             Filtered via commonWordFilter to prevent "my homework".
 *
 *   Signal 3: Preposition + capitalised token
 *             "going to Bondi", "at Shibuya" — spatial/directional context
 *
 *   Signal 4: Relationship introduction pattern
 *             "Max is my dog", "Sarah is a friend" — explicit introduction
 *             Highest context score because user is explicitly introducing.
 *
 *   Signal 5: Qualified possessive
 *             "my little Max", "my best friend Sarah" — adjective + name
 *             Only fires on capitalised final noun to reduce false positives.
 *
 *   Signal 6: Gazetteer exclusion
 *             Removes candidates that match in-world entities (entities table),
 *             already-taught entities (cotw_user_taught_entities), or
 *             already-learned vocabulary (cotw_user_language).
 *             All three queries run in parallel via Promise.all.
 *
 *   Signal 7: Priority scoring
 *             Deduplicates candidates and assigns final priority based on
 *             context_score. Relationship intros > qualified possessives >
 *             possessives > prepositions > capitalised tokens.
 *
 *   Signal 6a: Lowercase context recovery (STUB — Phase 3)
 *              Placeholder for detecting lowercase proper nouns using
 *              conversation history context. Returns empty array.
 *              Cold-start miss rate ~20% explicitly accepted per spec.
 *
 * VOCABULARY FILTERING
 * --------------------
 * All signal detectors delegate vocabulary checks to commonWordFilter.js,
 * the shared vocabulary filter module. This module does NOT own any
 * vocabulary data — it queries commonWordFilter.isCommon() instead.
 *
 * Signal 1 additionally runs commonWordFilter.isLikelyCommonNounContext()
 * BEFORE the vocabulary check, catching syntactic false positives like
 * "a Person", "not a Country", "PERSON" that vocabulary alone misses.
 * Signals 2-5 skip contextual guards because their regex patterns
 * already provide higher grammatical context.
 *
 * REGEX PATTERNS
 * --------------
 * All regex patterns are pre-compiled at module level to prevent
 * garbage collection churn from runtime compilation. Methods reset
 * lastIndex before each use for global-flag patterns.
 *
 * TOKENIZATION
 * ------------
 * _tokenizeWithOffsets() returns tokens with their character offsets
 * in the original input. This ensures span accuracy when the same
 * word appears multiple times ("I saw Max and Max ran").
 *
 * COLD START LIMITATION
 * ---------------------
 * First-time lowercase proper nouns without possessive/preposition context
 * will be missed (~20% miss rate). This is explicitly accepted per the
 * canonical spec (ADR-001). The consent gate corrects false positives,
 * and users naturally re-introduce important references.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * - Does NOT ask the user anything (detection only, not dialogue)
 * - Does NOT write to the database (read-only gazetteer checks)
 * - Does NOT use external AI APIs or ML models
 * - Does NOT replace learningDetector (sibling, not replacement)
 * - Does NOT handle the consent gate (that is QUD + BrainOrchestrator)
 * - Does NOT detect multi-token entities ("Bondi Beach", "New York")
 *   Multi-token support is a Phase 4 enhancement.
 * - Does NOT own vocabulary data (delegated to commonWordFilter.js)
 *
 * OUTPUT SHAPE
 * ------------
 * {
 *   shouldAsk: boolean,           — true if composite score >= threshold
 *   score: 0-1,                   — highest candidate context_score
 *   signals: { ... },             — per-signal match arrays
 *   candidates: [...],            — top 3 candidates sorted by score
 *   prioritizedCandidate: {},     — single best candidate (or null)
 *   triggeredSignalNames: []      — which signals fired
 * }
 *
 * Matches NEUTRAL_REFERENCE shape in EarWig.js exactly.
 *
 * PERFORMANCE
 * -----------
 * Target: < 20ms for signal detection + < 30ms for gazetteer queries.
 * Total budget: < 50ms within EarWig's parallel execution.
 * Gazetteer queries run in parallel via Promise.all (not sequential).
 * All regex pre-compiled at module level — zero runtime compilation.
 *
 * KNOWN LIMITATIONS
 * -----------------
 * 1. Single-token only — "Bondi Beach" detected as "Bondi" only (Phase 4)
 * 2. Cold-start lowercase miss — "max" without context missed (Phase 3)
 * 3. Sentence boundary — "home." works, "home."" edge case may leak
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: ReferenceDetector (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase
 * Private: _prefix
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';
import pool from '../db/pool.js';
import commonWordFilter from '../utils/commonWordFilter.js';

const logger = createModuleLogger('ReferenceDetector');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Version                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const DETECTOR_VERSION = 'v010.1';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const _envThreshold = Number(process.env.REFERENCE_THRESHOLD);
const REFERENCE_THRESHOLD = Number.isFinite(_envThreshold) ? _envThreshold : 0.50;
const MAX_CANDIDATES = 3;
const MIN_TOKEN_LENGTH = 2;
const MAX_INPUT_LENGTH = 10000;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pre-Compiled Regex — Module Level                                         */
/*                                                                            */
/*  All regex used in signal detectors and tokenization are compiled once    */
/*  at module load. Methods reset lastIndex before use for global-flag      */
/*  patterns. This prevents garbage collection churn and eliminates any     */
/*  ReDoS risk from dynamic pattern construction.                            */
/* ────────────────────────────────────────────────────────────────────────── */

const CAPITALISED_PATTERN = /^[A-Z][a-z]+([-'][A-Z]?[a-z]+)*$/;
const SENTENCE_BOUNDARY_PATTERN = /[.!?]["'\)]*$/;
const TOKEN_SPLIT_REGEX = /\S+/g;
const POSSESSIVE_REGEX = /\b(?:my|our|his|her|their)\s+([A-Z][a-z](?:[-'][A-Za-z]+)*[a-z]*)\b/g;
const PREPOSITION_REGEX = /\b(?:with|at|from|to|in|near|going to|been to|went to|live in|lives in|moved to|came from|back to|off to)\s+([A-Z][a-z](?:[-'][A-Za-z]+)*[a-z]*)\b/g;
const RELATIONSHIP_REGEX = /\b([A-Z][a-z](?:[-'][A-Za-z]+)*[a-z]*)\s+is\s+(?:my|our|a|the|an)\s+/g;
const QUALIFIED_POSSESSIVE_REGEX = /\b(?:my|our|his|her|their)\s+(?:little|big|best|favourite|favorite|new|old|good|dear|lovely|young)\s+([A-Z][a-z](?:[-'][A-Za-z]+)*[a-z]*)\b/g;
const STRIP_LEADING_PUNCT = /^[^a-zA-Z]+/;
const STRIP_TRAILING_PUNCT = /[^a-zA-Z]+$/;

/* ────────────────────────────────────────────────────────────────────────── */
/*  ReferenceDetector Class                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

class ReferenceDetector {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: detectReferences                                                */
  /*                                                                          */
  /*  Primary method. Analyses user input for unfamiliar references.          */
  /*  Called by EarWig.hear() via Promise.allSettled().                       */
  /*                                                                          */
  /*  @param {string} command — User input text                               */
  /*  @param {string} userId — Hex user ID (for gazetteer lookups)           */
  /*  @returns {object} Detection result with candidates and scores          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async detectReferences(command, userId) {
    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return this._neutralResult();
    }

    const input = command.trim().slice(0, MAX_INPUT_LENGTH);
    const tokenData = this._tokenizeWithOffsets(input);

    if (tokenData.length === 0) {
      return this._neutralResult();
    }

    const tokens = tokenData.map(t => t.token);
    const signals = {};
    let candidates = [];

    /* ── Signal 1: Capitalised non-sentence-initial ─────────────────────── */

    signals.capitalised = this._detectCapitalised(tokenData, tokens);
    candidates.push(...signals.capitalised);

    /* ── Signal 2: Possessive + capitalised token ───────────────────────── */

    signals.possessive = this._detectPossessive(input);
    candidates.push(...signals.possessive);

    /* ── Signal 3: Preposition + capitalised token ──────────────────────── */

    signals.preposition = this._detectPreposition(input);
    candidates.push(...signals.preposition);

    /* ── Signal 4: Relationship introduction ────────────────────────────── */

    signals.relationshipIntro = this._detectRelationshipIntro(input);
    candidates.push(...signals.relationshipIntro);

    /* ── Signal 5: Qualified possessive ─────────────────────────────────── */

    signals.qualifiedPossessive = this._detectQualifiedPossessive(input);
    candidates.push(...signals.qualifiedPossessive);

    /* ── Signal 6a: Lowercase context recovery (Phase 3 stub) ───────────── */

    signals.lowercaseRecovery = this._detectLowercaseRecovery(tokens);

    /* ── Deduplicate before gazetteer ───────────────────────────────────── */

    candidates = this._deduplicateCandidates(candidates);

    /* ── Signal 6: Gazetteer exclusion ──────────────────────────────────── */

    if (userId && /^#[0-9A-Fa-f]{6}$/.test(userId) && candidates.length > 0) {
      candidates = await this._applyGazetteerFilter(candidates, userId);
      signals.gazetteerApplied = true;
    } else {
      signals.gazetteerApplied = false;
    }

    /* ── Signal 7: Priority scoring + final selection ───────────────────── */

    const scoredCandidates = candidates
      .sort((a, b) => b.context_score - a.context_score)
      .slice(0, MAX_CANDIDATES);

    const compositeScore = this._calculateCompositeScore(scoredCandidates);
    const prioritizedCandidate = scoredCandidates.length > 0
      ? scoredCandidates[0]
      : null;

    const triggeredSignalNames = Object.keys(signals).filter(key => {
      const val = signals[key];
      if (Array.isArray(val)) return val.length > 0;
      return false;
    });

    const result = {
      shouldAsk: compositeScore >= REFERENCE_THRESHOLD
        && prioritizedCandidate !== null,
      score: compositeScore,
      signals,
      candidates: scoredCandidates,
      prioritizedCandidate,
      triggeredSignalNames
    };

    logger.info('Detection complete', {
      detectorVersion: DETECTOR_VERSION,
      userId: userId || 'unknown',
      inputLength: input.length,
      tokenCount: tokens.length,
      finalCandidates: scoredCandidates.length,
      shouldAsk: result.shouldAsk,
      score: parseFloat(compositeScore.toFixed(3)),
      prioritizedPhrase: prioritizedCandidate?.phrase || null,
      triggeredSignals: triggeredSignalNames
    });

    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Neutral Result                                                 */
  /*                                                                          */
  /*  Returns empty detection result for empty/invalid input.                */
  /*  Shape must match NEUTRAL_REFERENCE in EarWig.js exactly.               */
  /* ──────────────────────────────────────────────────────────────────────── */

  _neutralResult() {
    return {
      shouldAsk: false,
      score: 0,
      signals: {},
      candidates: [],
      prioritizedCandidate: null,
      triggeredSignalNames: []
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Tokenize With Offsets                                          */
  /*                                                                          */
  /*  Splits input into whitespace-delimited tokens AND records the          */
  /*  character offset of each token in the original string. This ensures   */
  /*  span accuracy when the same word appears multiple times.               */
  /*                                                                          */
  /*  "I saw Max and Max ran"                                                */
  /*  → [{ token: "I", startIndex: 0 },                                    */
  /*     { token: "saw", startIndex: 2 },                                   */
  /*     { token: "Max", startIndex: 6 },                                   */
  /*     { token: "and", startIndex: 10 },                                  */
  /*     { token: "Max", startIndex: 14 },                                  */
  /*     { token: "ran", startIndex: 18 }]                                  */
  /*                                                                          */
  /*  Filters tokens shorter than MIN_TOKEN_LENGTH.                          */
  /*  Uses pre-compiled TOKEN_SPLIT_REGEX with lastIndex reset.             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _tokenizeWithOffsets(input) {
    TOKEN_SPLIT_REGEX.lastIndex = 0;
    const results = [];
    let match;

    while ((match = TOKEN_SPLIT_REGEX.exec(input)) !== null) {
      if (match[0].length >= MIN_TOKEN_LENGTH) {
        results.push({
          token: match[0],
          startIndex: match.index
        });
      }
    }

    return results;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Strip Punctuation                                              */
  /*                                                                          */
  /*  Removes trailing and leading punctuation from a token for matching.    */
  /*  Preserves internal apostrophes and hyphens for names like O'Connor    */
  /*  and Jean-Luc.                                                          */
  /*  "Max!" becomes "Max", "Bondi," becomes "Bondi".                        */
  /*  "O'Connor" stays "O'Connor", "Jean-Luc" stays "Jean-Luc".             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _stripPunctuation(token) {
    return token.replace(STRIP_LEADING_PUNCT, '').replace(STRIP_TRAILING_PUNCT, '');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Normalise For Gazetteer                                       */
  /*                                                                          */
  /*  Mirrors taughtEntityCapturer._normaliseName() exactly so gazetteer     */
  /*  comparisons match the stored entity_name_normalized values.             */
  /* ──────────────────────────────────────────────────────────────────────── */

  _normaliseForGazetteer(name) {
    if (typeof name !== 'string') return '';
    return name
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\p{S}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Is Capitalised Name                                            */
  /*                                                                          */
  /*  Tests whether a cleaned token matches the capitalised name pattern.    */
  /*  Handles: Max, Bondi, O'Connor, Jean-Luc, D'Angelo, Anne-Marie.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _isCapitalisedName(clean) {
    return CAPITALISED_PATTERN.test(clean);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Is Sentence Boundary                                           */
  /*                                                                          */
  /*  Checks whether the previous token ends a sentence. Handles:            */
  /*  "word." "word!" "word?" "word.)" "word."" etc.                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _isSentenceBoundary(token) {
    if (!token) return false;
    return SENTENCE_BOUNDARY_PATTERN.test(token);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 1: Capitalised Non-Sentence-Initial                              */
  /*                                                                          */
  /*  Detects tokens that start with uppercase and appear after the first    */
  /*  token in the input, and NOT after a sentence boundary.                 */
  /*  "I was with Max yesterday" catches "Max".                              */
  /*  "I went home. Max came later." does NOT catch "Max" (sentence start). */
  /*                                                                          */
  /*  Handles apostrophe names (O'Connor) and hyphenated (Jean-Luc).        */
  /*                                                                          */
  /*  Two-stage filtering:                                                   */
  /*  1. Contextual guard (isLikelyCommonNounContext) — catches syntactic   */
  /*     false positives like "a Person", "not a Country", "PERSON"         */
  /*  2. Vocabulary check (isCommon) — catches known common English words   */
  /*                                                                          */
  /*  Signals 2-5 skip the contextual guard because their regex patterns    */
  /*  already provide higher grammatical context (possessive, preposition,  */
  /*  relationship intro).                                                   */
  /*                                                                          */
  /*  Uses offset-aware tokenData for accurate span positions even when     */
  /*  the same word appears multiple times in input.                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectCapitalised(tokenData, tokens) {
    const candidates = [];

    for (let i = 1; i < tokenData.length; i++) {
      const { token: raw, startIndex } = tokenData[i];
      const clean = this._stripPunctuation(raw);

      if (clean.length < MIN_TOKEN_LENGTH) continue;
      if (!this._isCapitalisedName(clean)) continue;
      if (this._isSentenceBoundary(tokenData[i - 1].token)) continue;

      /* Contextual guard — catches "a Person", "not a Country", "PERSON" */
      const contextCheck = commonWordFilter.isLikelyCommonNounContext(tokens, i);
      if (contextCheck.rejected) {
        logger.debug('Signal 1 contextual rejection', {
          word: clean,
          reason: contextCheck.reason,
          filterVersion: contextCheck.filterVersion
        });
        continue;
      }

      /* Vocabulary check — catches known common English words */
      if (commonWordFilter.isCommon(clean)) continue;

      candidates.push({
        phrase: clean,
        probable_type: 'PERSON|PET|LOCATION',
        context_score: 0.65,
        signal: 'capitalised',
        span: [startIndex, raw.length]
      });
    }

    return candidates;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 2: Possessive + Capitalised Token                                */
  /*                                                                          */
  /*  Detects patterns like "my Max", "our Sarah", "his Bondi".              */
  /*  The token after the possessive MUST be capitalised.                    */
  /*  Filtered via commonWordFilter to prevent "my School" (rare but        */
  /*  possible if user capitalises common nouns).                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectPossessive(input) {
    POSSESSIVE_REGEX.lastIndex = 0;
    const candidates = [];
    let match;

    while ((match = POSSESSIVE_REGEX.exec(input)) !== null) {
      const phrase = this._stripPunctuation(match[1]);
      if (phrase.length < MIN_TOKEN_LENGTH) continue;
      if (commonWordFilter.isCommon(phrase)) continue;

      candidates.push({
        phrase,
        probable_type: 'PERSON|PET|LOCATION|INSTITUTION',
        context_score: 0.82,
        signal: 'possessive',
        span: [match.index + match[0].indexOf(match[1]), match[1].length]
      });
    }

    return candidates;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 3: Preposition + Capitalised Token                               */
  /*                                                                          */
  /*  Detects spatial/directional references: "going to Bondi",              */
  /*  "at Shibuya", "from Melbourne", "near Coogee", "live in Surry".       */
  /*  Requires capitalised token after preposition phrase.                   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectPreposition(input) {
    PREPOSITION_REGEX.lastIndex = 0;
    const candidates = [];
    let match;

    while ((match = PREPOSITION_REGEX.exec(input)) !== null) {
      const phrase = this._stripPunctuation(match[1]);
      if (phrase.length < MIN_TOKEN_LENGTH) continue;
      if (commonWordFilter.isCommon(phrase)) continue;

      candidates.push({
        phrase,
        probable_type: 'LOCATION|PERSON|INSTITUTION',
        context_score: 0.78,
        signal: 'preposition',
        span: [match.index + match[0].indexOf(match[1]), match[1].length]
      });
    }

    return candidates;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 4: Relationship Introduction                                     */
  /*                                                                          */
  /*  Detects explicit introductions: "Max is my dog",                       */
  /*  "Sarah is a friend", "Bondi is a beach near my house".                 */
  /*  Highest context score (0.88) because user is explicitly introducing.   */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectRelationshipIntro(input) {
    RELATIONSHIP_REGEX.lastIndex = 0;
    const candidates = [];
    let match;

    while ((match = RELATIONSHIP_REGEX.exec(input)) !== null) {
      const phrase = this._stripPunctuation(match[1]);
      if (phrase.length < MIN_TOKEN_LENGTH) continue;
      if (commonWordFilter.isCommon(phrase)) continue;

      candidates.push({
        phrase,
        probable_type: 'PERSON|PET|OBJECT|LOCATION',
        context_score: 0.88,
        signal: 'relationshipIntro',
        span: [match.index + match[0].indexOf(match[1]), match[1].length]
      });
    }

    return candidates;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 5: Qualified Possessive                                          */
  /*                                                                          */
  /*  Detects patterns with adjective between possessive and name:           */
  /*  "my little Max", "my best friend Sarah", "my old dog Rex".             */
  /*  Highest context score (0.91) because adjective adds semantic weight.  */
  /*                                                                          */
  /*  Only fires on capitalised final noun to reduce false positives.        */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectQualifiedPossessive(input) {
    QUALIFIED_POSSESSIVE_REGEX.lastIndex = 0;
    const candidates = [];
    let match;

    while ((match = QUALIFIED_POSSESSIVE_REGEX.exec(input)) !== null) {
      const phrase = this._stripPunctuation(match[1]);
      if (phrase.length < MIN_TOKEN_LENGTH) continue;
      if (commonWordFilter.isCommon(phrase)) continue;

      candidates.push({
        phrase,
        probable_type: 'PERSON|PET',
        context_score: 0.91,
        signal: 'qualifiedPossessive',
        span: [match.index + match[0].indexOf(match[1]), match[1].length]
      });
    }

    return candidates;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 6a: Lowercase Context Recovery (Phase 3 Stub)                    */
  /*                                                                          */
  /*  Placeholder for detecting lowercase proper nouns using prior            */
  /*  conversation context via ConversationStateManager.                     */
  /*                                                                          */
  /*  Full implementation would:                                              */
  /*  1. Check prior messages for capitalised form of lowercase tokens       */
  /*  2. Check possessive/preposition context around lowercase tokens        */
  /*  3. Cross-reference against common dictionary to exclude real words     */
  /*                                                                          */
  /*  Cold-start miss rate ~20% accepted per canonical spec ADR-001.         */
  /*                                                                          */
  /*  @param {string[]} tokens — Tokenized input                             */
  /*  @returns {Array} Empty array (stub)                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _detectLowercaseRecovery(tokens) {
    return [];
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Deduplicate Candidates                                         */
  /*                                                                          */
  /*  Multiple signals can detect the same token. "Max is my dog" fires      */
  /*  both Signal 1 (capitalised) and Signal 4 (relationship intro).         */
  /*  Keep the highest-scoring version of each unique phrase.                */
  /* ──────────────────────────────────────────────────────────────────────── */

  _deduplicateCandidates(candidates) {
    const seen = new Map();

    for (const candidate of candidates) {
      const key = candidate.phrase.toLowerCase();
      const existing = seen.get(key);

      if (!existing || candidate.context_score > existing.context_score) {
        seen.set(key, candidate);
      }
    }

    return Array.from(seen.values());
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Signal 6: Gazetteer Exclusion                                           */
  /*                                                                          */
  /*  Removes candidates that are already known to the system:               */
  /*  - In-world entities (entities table — NPCs, locations, etc.)           */
  /*  - Already-taught entities for this user (cotw_user_taught_entities)    */
  /*  - Already-learned vocabulary for this user (cotw_user_language)        */
  /*                                                                          */
  /*  All three queries run in PARALLEL via Promise.all for performance.     */
  /*  Each query uses its correct column name — no UNION needed.             */
  /*  Fails open on DB error (returns unfiltered candidates).                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _applyGazetteerFilter(candidates, userId) {
    if (!candidates.length || !userId) return candidates;

    const phrases = candidates.map(c => this._normaliseForGazetteer(c.phrase));

    try {
      const [inWorldResult, taughtResult, languageResult] = await Promise.all([
        pool.query(
          'SELECT entity_name_normalized FROM entities WHERE entity_name_normalized = ANY($1)',
          [phrases]
        ),
        pool.query(
          'SELECT entity_name_normalized FROM cotw_user_taught_entities WHERE user_id = $1 AND entity_name_normalized = ANY($2) AND forgotten = false',
          [userId, phrases]
        ),
        pool.query(
          'SELECT normalized_phrase FROM cotw_user_language WHERE user_id = $1 AND normalized_phrase = ANY($2)',
          [userId, phrases]
        )
      ]);

      const knownInWorld = new Set(
        inWorldResult.rows.map(r => r.entity_name_normalized)
      );
      const knownTaught = new Set(
        taughtResult.rows.map(r => r.entity_name_normalized)
      );
      const knownLanguage = new Set(
        languageResult.rows.map(r => r.normalized_phrase)
      );

      const filtered = candidates.filter(c => {
        const norm = this._normaliseForGazetteer(c.phrase);
        if (knownInWorld.has(norm)) return false;
        if (knownTaught.has(norm)) return false;
        if (knownLanguage.has(norm)) return false;
        return true;
      });

      logger.debug('Gazetteer filter applied', {
        userId,
        inputCount: candidates.length,
        outputCount: filtered.length,
        removedInWorld: knownInWorld.size,
        removedTaught: knownTaught.size,
        removedLanguage: knownLanguage.size
      });

      return filtered;
    } catch (error) {
      logger.warn('Gazetteer filter failed, returning unfiltered candidates', {
        userId,
        error: error.message
      });
      return candidates;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Calculate Composite Score                                      */
  /*                                                                          */
  /*  Returns the highest context_score among all candidates.                */
  /*  Simple max — no averaging. One strong signal is enough to trigger.     */
  /* ──────────────────────────────────────────────────────────────────────── */

  _calculateCompositeScore(candidates) {
    if (!candidates.length) return 0;
    return Math.max(...candidates.map(c => c.context_score));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export default new ReferenceDetector();
