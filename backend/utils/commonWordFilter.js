/**
 * ============================================================================
 * commonWordFilter.js — Shared Vocabulary Filter (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Single source of truth for "is this word a common English word?"
 * Owns all vocabulary data used to filter false positives in entity
 * detection. Follows the spaCy shared-Vocab pattern: one module owns
 * the vocabulary, all consumers import and query it.
 *
 * VOCABULARY SOURCES (merged at boot)
 * ------------------------------------
 * 1. COMMON_NOUNS  — Hand-curated nouns that appear in possessive/
 *                    preposition positions ("my homework", "at school")
 * 2. FUNCTION_WORDS — Pronouns, determiners, conjunctions, prepositions,
 *                     auxiliary verbs, common adverbs
 * 3. AMBIGUOUS_NAMES — Words that are both names AND common English
 *                      (mark, grace, will, etc.) — NEVER filtered
 * 4. LTLM_VOCABULARY — Corpus-derived frequency set from 5,079 LTLM
 *                      training utterances. Words appearing >=
 *                      frequencyThreshold times are common English.
 *                      Loaded by warmUp(). Null until called.
 *
 * API
 * ---
 * isCommon(word)                        — true if common English (not a name)
 * isAmbiguous(word)                     — true if name-word (mark, grace)
 * isLikelyCommonNounContext(tokens, i)  — object with rejected, reason, version
 * async warmUp(dbPool)                  — loads LTLM corpus, builds freq set
 * getStats()                            — vocabulary sizes + runtime metrics
 * resetMetrics()                        — zeroes all runtime counters
 *
 * DEPENDENCY INJECTION
 * --------------------
 * This module lives in utils/ and does NOT import pool.js directly.
 * The database pool is passed into warmUp(dbPool) by the caller at
 * boot time. This keeps the dependency direction clean: services and
 * boot code depend on utils, not the other way around.
 *
 * CONFIGURATION
 * -------------
 * Constructor accepts an options object for threshold tuning:
 *   new CommonWordFilter({ frequencyThreshold: 5 })
 * Default: frequencyThreshold = 3 (words appearing 3+ times in LTLM
 * corpus are treated as common English).
 *
 * RUNTIME METRICS
 * ---------------
 * Every call to isCommon() and isLikelyCommonNounContext() increments
 * internal counters. getStats() exposes these for observability:
 *   isCommonCalls, isCommonHits, isCommonMisses
 *   ambiguousRescues, contextChecks, contextRejections
 *   rejectionReasons: { all_caps_emphasis: N, negation_article: N, ... }
 *
 * CORPUS LOADING
 * --------------
 * warmUp() uses a PostgreSQL server-side cursor (DECLARE/FETCH) to
 * stream rows from ltlm_training_examples without loading the entire
 * result set into memory. This handles unbounded corpus growth safely.
 * Rows are fetched in batches of 500 and processed incrementally.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * - Does NOT detect entities (that is referenceDetector)
 * - Does NOT import the database pool (injected via warmUp)
 * - Does NOT use external AI APIs or ML models
 * - Does NOT own detection thresholds or scoring
 *
 * PERFORMANCE
 * -----------
 * All lookups are O(1) Set.has() — under 0.1ms per check.
 * Contextual guards add ~0.5ms per candidate (5 pre-compiled tests).
 * warmUp() runs once at boot — cursor-streamed, ~50-80ms.
 * Total runtime impact per turn: < 2ms.
 *
 * GRACEFUL DEGRADATION
 * --------------------
 * Before warmUp() is called, isCommon() works using COMMON_NOUNS and
 * FUNCTION_WORDS only. The system never fails — it just has a smaller
 * vocabulary until the LTLM corpus loads.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: CommonWordFilter (PascalCase)
 * Export: singleton instance (camelCase default)
 * Methods: camelCase public, _prefix private
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('CommonWordFilter');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Version & Defaults                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

const FILTER_VERSION = 'v010.3';
const MIN_WORD_LENGTH = 2;
const DEFAULT_FREQUENCY_THRESHOLD = 3;
const CURSOR_BATCH_SIZE = 500;
const WARMUP_CONNECT_TIMEOUT_MS = 5000;
const WARMUP_STATEMENT_TIMEOUT_MS = 15000;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Pre-Compiled Regex — Module Level                                         */
/*                                                                            */
/*  All regex used in hot-path methods are compiled once at module load.     */
/*  This prevents garbage collection churn from runtime compilation and      */
/*  eliminates any ReDoS risk from dynamic pattern construction.             */
/* ────────────────────────────────────────────────────────────────────────── */

const WORD_EXTRACT_PATTERN = /\b[a-z]{2,}\b/g;
const STRIP_NON_ALPHA = /[^a-z]/g;
const STRIP_NON_ALPHA_APOS = /[^a-z']/g;
const NEGATION_PATTERN = /^(not|no|never|isn't|isnt|wasn't|wasnt|aren't|arent|ain't|aint)$/;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Common English Nouns — False Positive Filter                              */
/*                                                                            */
/*  Curated set of nouns that commonly follow possessives and prepositions   */
/*  in normal speech. Without this filter, "my homework" or "at school"      */
/*  would fire as unfamiliar references.                                     */
/*                                                                            */
/*  This is NOT a stopword list. It is a precision filter for noun-position  */
/*  false positives. Maintained manually — add words as false positives      */
/*  are discovered in production.                                             */
/* ────────────────────────────────────────────────────────────────────────── */

const COMMON_NOUNS = new Set([
  'house', 'home', 'place', 'room', 'bed', 'door', 'window', 'table',
  'chair', 'car', 'bike', 'bus', 'train', 'plane', 'boat',
  'phone', 'computer', 'laptop', 'tablet', 'screen',
  'homework', 'work', 'job', 'class', 'lesson', 'test', 'exam',
  'school', 'college', 'university', 'office', 'shop', 'store',
  'question', 'answer', 'problem', 'issue', 'idea', 'plan', 'goal',
  'name', 'age', 'birthday', 'life', 'day', 'night', 'morning',
  'afternoon', 'evening', 'week', 'month', 'year', 'time',
  'food', 'lunch', 'dinner', 'breakfast', 'snack', 'drink', 'water',
  'money', 'bag', 'book', 'pen', 'paper', 'clothes', 'shoes',
  'head', 'hand', 'face', 'eye', 'heart', 'mind', 'body',
  'family', 'friend', 'friends', 'mum', 'mom', 'dad', 'brother',
  'sister', 'parents', 'kids', 'children', 'baby', 'son', 'daughter',
  'teacher', 'boss', 'team', 'group', 'people',
  'game', 'music', 'movie', 'show', 'song', 'video', 'photo',
  'story', 'thing', 'things', 'stuff', 'way', 'part', 'side',
  'world', 'country', 'city', 'town', 'street', 'park', 'beach',
  'garden', 'kitchen', 'bathroom', 'bedroom', 'yard',
  'dog', 'cat', 'pet', 'fish', 'bird', 'horse', 'rabbit',
  'turn', 'help', 'point', 'opinion', 'guess',
  'fault', 'mistake', 'best', 'worst', 'favourite', 'favorite',
  'everything', 'nothing', 'something', 'anything',
  'everyone', 'nobody', 'someone', 'anyone',
  'today', 'tomorrow', 'yesterday', 'tonight', 'weekend',
  'end', 'start', 'beginning', 'middle', 'top', 'bottom',
  'number', 'letter', 'word', 'sentence', 'page',
  'project', 'assignment', 'report', 'essay', 'presentation',
  'feeling', 'thought', 'dream', 'wish', 'fear',
  'foot', 'arm', 'leg', 'back', 'stomach',
  'hair', 'skin', 'teeth', 'nose', 'mouth', 'ear',
  'hat', 'shirt', 'jacket', 'dress', 'coat', 'pants',
  'person', 'man', 'woman', 'boy', 'girl', 'guy', 'kid',
  'type', 'kind', 'sort', 'lot', 'bit', 'couple'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Function Words — Never Candidates                                         */
/*                                                                            */
/*  Pronouns, determiners, conjunctions, prepositions, auxiliary verbs,      */
/*  and common adverbs that should never be treated as entity candidates     */
/*  regardless of capitalisation or position.                                */
/* ────────────────────────────────────────────────────────────────────────── */

const FUNCTION_WORDS = new Set([
  'i', 'me', 'my', 'mine', 'myself',
  'you', 'your', 'yours', 'yourself',
  'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself',
  'we', 'us', 'our', 'ours', 'ourselves',
  'they', 'them', 'their', 'theirs', 'themselves',
  'this', 'that', 'these', 'those',
  'the', 'a', 'an', 'some', 'any', 'no', 'every', 'each', 'all',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'for',
  'in', 'on', 'at', 'to', 'from', 'with', 'by', 'about', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'over', 'up', 'down', 'out', 'off', 'near', 'of',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing',
  'would', 'shall', 'should', 'might', 'can', 'could',
  'must', 'need', 'dare', 'ought',
  'not', 'yes', 'yeah', 'yep', 'nah', 'nope', 'ok', 'okay',
  'just', 'also', 'too', 'very', 'really', 'quite', 'pretty',
  'here', 'there', 'where', 'when', 'how', 'what', 'which', 'who',
  'why', 'then', 'than', 'now', 'still', 'already', 'always', 'never',
  'going', 'got', 'get', 'went', 'come', 'came', 'know', 'knew',
  'think', 'thought', 'want', 'wanted', 'like', 'liked',
  'said', 'say', 'says', 'tell', 'told', 'ask', 'asked',
  'see', 'saw', 'look', 'looked', 'make', 'made',
  'done', 'gone', 'taken', 'given', 'left',
  'much', 'many', 'more', 'most', 'less', 'least',
  'well', 'even', 'only', 'again', 'ever',
  'away', 'right', 'sure', 'though', 'because', 'since', 'until',
  'while', 'if', 'unless', 'whether', 'although', 'however'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  Ambiguous Names — Words That Are Both Names And Common English            */
/*                                                                            */
/*  These words appear as common English but are also real names.             */
/*  They are NEVER filtered by isCommon() so they remain detectable          */
/*  by all signal detectors. The higher-context signals (possessive,         */
/*  preposition, relationship intro) rescue them when used as names.         */
/*                                                                            */
/*  Source: Cross-referenced against LTLM corpus — these 33 words           */
/*  appear in both name databases and common English vocabulary.             */
/* ────────────────────────────────────────────────────────────────────────── */

const AMBIGUOUS_NAMES = new Set([
  'mark', 'grace', 'will', 'hope', 'faith', 'joy', 'dawn', 'rose',
  'holly', 'lily', 'pat', 'sue', 'ray', 'lee', 'art', 'bill',
  'bob', 'rob', 'jean', 'june', 'april', 'iris', 'violet',
  'ruby', 'pearl', 'ivy', 'penny', 'glen', 'dale', 'cliff', 'heath',
  'frank', 'jack'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  CommonWordFilter Class                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

class CommonWordFilter {

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Constructor                                                             */
  /*                                                                          */
  /*  Accepts optional configuration for threshold tuning.                   */
  /*  Default frequencyThreshold = 3.                                        */
  /*                                                                          */
  /*  @param {object} options — Configuration overrides                       */
  /*  @param {number} options.frequencyThreshold — Min corpus frequency      */
  /* ──────────────────────────────────────────────────────────────────────── */

  constructor(options = {}) {
    this._frequencyThreshold = options.frequencyThreshold ?? DEFAULT_FREQUENCY_THRESHOLD;
    this._ltlmVocabulary = null;
    this._isWarmedUp = false;
    this._warmingUp = false;

    this._metrics = {
      isCommonCalls: 0,
      isCommonHits: 0,
      isCommonMisses: 0,
      ambiguousRescues: 0,
      contextChecks: 0,
      contextRejections: 0,
      rejectionReasons: {}
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: _normalizeToken                                                */
  /*                                                                          */
  /*  Strips non-alpha characters from a token for comparison.               */
  /*  Preserves apostrophes when keepApostrophe is true (for names          */
  /*  like O'Connor). Uses pre-compiled regex constants.                     */
  /*                                                                          */
  /*  @param {string} token — Raw token from input                           */
  /*  @param {boolean} keepApostrophe — Preserve internal apostrophes       */
  /*  @returns {string} Cleaned lowercase token                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  _normalizeToken(token, keepApostrophe = false) {
    if (!token) return '';
    const pattern = keepApostrophe ? STRIP_NON_ALPHA_APOS : STRIP_NON_ALPHA;
    return token.toLowerCase().replace(pattern, '');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: _trackRejection                                                */
  /*                                                                          */
  /*  Increments rejection counter for a specific reason string.             */
  /*  Creates the key if first occurrence.                                   */
  /*                                                                          */
  /*  @param {string} reason — Rejection reason code                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  _trackRejection(reason) {
    this._metrics.contextRejections++;
    this._metrics.rejectionReasons[reason] =
      (this._metrics.rejectionReasons[reason] || 0) + 1;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: isCommon                                                        */
  /*                                                                          */
  /*  Returns true if the word is a common English word that should NOT      */
  /*  be treated as an entity candidate. Checks all vocabulary sources.      */
  /*                                                                          */
  /*  Check order matters:                                                   */
  /*  1. Length gate — too short = common (true)                             */
  /*  2. AMBIGUOUS_NAMES — rescue name-words (false)                        */
  /*  3. FUNCTION_WORDS — grammatical words (true)                          */
  /*  4. COMMON_NOUNS — curated nouns (true)                                */
  /*  5. LTLM_VOCABULARY — corpus frequency (true)                          */
  /*  6. Default — not found in any source (false)                          */
  /*                                                                          */
  /*  @param {string} word — Word to check (any casing)                      */
  /*  @returns {boolean} true if common word, false if potential entity      */
  /* ──────────────────────────────────────────────────────────────────────── */

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: _extractWords                                                  */
  /*                                                                          */
  /*  Encapsulates global regex WORD_EXTRACT_PATTERN usage. Resets lastIndex */
  /*  before each call to prevent stateful regex bugs.                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _extractWords(text) {
    WORD_EXTRACT_PATTERN.lastIndex = 0;
    return text.toLowerCase().match(WORD_EXTRACT_PATTERN);
  }

  isCommon(word) {
    this._metrics.isCommonCalls++;

    if (!word || word.length < MIN_WORD_LENGTH) {
      this._metrics.isCommonHits++;
      return true;
    }

    const lower = word.toLowerCase();

    if (AMBIGUOUS_NAMES.has(lower)) {
      this._metrics.ambiguousRescues++;
      this._metrics.isCommonMisses++;
      return false;
    }

    if (FUNCTION_WORDS.has(lower)) {
      this._metrics.isCommonHits++;
      return true;
    }

    if (COMMON_NOUNS.has(lower)) {
      this._metrics.isCommonHits++;
      return true;
    }

    if (this._ltlmVocabulary && this._ltlmVocabulary.has(lower)) {
      this._metrics.isCommonHits++;
      return true;
    }

    this._metrics.isCommonMisses++;
    return false;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: isAmbiguous                                                     */
  /*                                                                          */
  /*  Returns true if the word is in the ambiguous names set — words that   */
  /*  are both real names and common English. Callers can use this to        */
  /*  apply extra caution or lower confidence on these candidates.           */
  /*                                                                          */
  /*  @param {string} word — Word to check (any casing)                      */
  /*  @returns {boolean} true if ambiguous name-word                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  isAmbiguous(word) {
    if (!word) return false;
    return AMBIGUOUS_NAMES.has(word.toLowerCase());
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: isLikelyCommonNounContext                                       */
  /*                                                                          */
  /*  Syntactic rejection guards. Detects grammatical contexts where a       */
  /*  capitalised word is categorically NOT a proper noun regardless of      */
  /*  vocabulary status.                                                     */
  /*                                                                          */
  /*  5 high-precision rules:                                                */
  /*  1. All-caps emphasis — "PERSON" (mobile/autocorrect)                  */
  /*  2. Indefinite article — "a Person", "an Animal"                       */
  /*  3. Negation + article — "not a Country", "its not a Person"           */
  /*  4. Definition pattern — "Person means human"                          */
  /*  5. Correction pattern — "said Country not Person"                     */
  /*                                                                          */
  /*  Called BEFORE isCommon() in Signal 1 (capitalised detector).           */
  /*  Signals 2-5 have higher grammatical context and skip this.            */
  /*                                                                          */
  /*  Returns object with rejected flag, reason string, and filter          */
  /*  version for full auditability in logs and admin review.               */
  /*                                                                          */
  /*  @param {string[]} tokens — Whitespace-split input tokens               */
  /*  @param {number} idx — Index of the capitalised token to check         */
  /*  @returns {{ rejected: boolean, reason: string|null,                   */
  /*             filterVersion: string }}                                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  isLikelyCommonNounContext(tokens, idx) {
    this._metrics.contextChecks++;

    if (!Array.isArray(tokens) || typeof idx !== 'number' ||
        idx < 0 || idx >= tokens.length) {
      return { rejected: false, reason: null, filterVersion: FILTER_VERSION };
    }

    const word = tokens[idx];
    if (!word) return { rejected: false, reason: null, filterVersion: FILTER_VERSION };

    /* Rule 1: All-caps emphasis — "PERSON", "COUNTRY" */
    if (word.length > 2 && word === word.toUpperCase()) {
      this._trackRejection('all_caps_emphasis');
      return { rejected: true, reason: 'all_caps_emphasis', filterVersion: FILTER_VERSION };
    }

    /* Rule 2: Indefinite article — "a Person", "an Country" */
    if (idx > 0) {
      const prev = this._normalizeToken(tokens[idx - 1]);
      if (prev === 'a' || prev === 'an') {
        this._trackRejection('indefinite_article');
        return { rejected: true, reason: 'indefinite_article', filterVersion: FILTER_VERSION };
      }
    }

    /* Rule 3: Negation + article — "not a Person", "its not a Country" */
    if (idx >= 2) {
      const prev1 = this._normalizeToken(tokens[idx - 1]);
      const prev2 = this._normalizeToken(tokens[idx - 2], true);

      if ((prev1 === 'a' || prev1 === 'an' || prev1 === 'the') &&
          NEGATION_PATTERN.test(prev2)) {
        this._trackRejection('negation_article');
        return { rejected: true, reason: 'negation_article', filterVersion: FILTER_VERSION };
      }
    }

    /* Rule 4: Definition — "Person means ...", "Country refers to" */
    if (idx < tokens.length - 1) {
      const next = this._normalizeToken(tokens[idx + 1]);
      if (next === 'means' || next === 'refers' || next === 'defines') {
        this._trackRejection('definition_pattern');
        return { rejected: true, reason: 'definition_pattern', filterVersion: FILTER_VERSION };
      }
    }

    /* Rule 5: Correction — "said Person not Place" */
    if (idx >= 2 && idx < tokens.length - 1) {
      const prev2 = this._normalizeToken(tokens[idx - 2]);
      if (prev2 === 'said' || prev2 === 'meant' || prev2 === 'called') {
        const next = this._normalizeToken(tokens[idx + 1]);
        if (next === 'not' || next === 'but' || next === 'instead') {
          this._trackRejection('correction_pattern');
          return { rejected: true, reason: 'correction_pattern', filterVersion: FILTER_VERSION };
        }
      }
    }

    return { rejected: false, reason: null, filterVersion: FILTER_VERSION };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: warmUp                                                          */
  /*                                                                          */
  /*  Builds LTLM vocabulary from the training corpus stored in              */
  /*  ltlm_training_examples.utterance_text. Uses a PostgreSQL server-side  */
  /*  cursor (DECLARE/FETCH) to stream rows in batches of 500 without       */
  /*  loading the entire result set into memory. This handles unbounded     */
  /*  corpus growth safely.                                                  */
  /*                                                                          */
  /*  Extracts all words, counts frequency, keeps words appearing >=        */
  /*  frequencyThreshold times as common English.                            */
  /*                                                                          */
  /*  Accepts the database pool as a parameter (dependency injection).       */
  /*  This keeps commonWordFilter in utils/ without importing pool.js.       */
  /*                                                                          */
  /*  Call once at boot time after database pool is ready.                   */
  /*  Idempotent — second call is a no-op.                                  */
  /*  Concurrent-safe — _warmingUp flag prevents double DB queries.         */
  /*                                                                          */
  /*  On failure: logs error and sets empty vocabulary. isCommon() still     */
  /*  works using COMMON_NOUNS and FUNCTION_WORDS (graceful degradation).   */
  /*                                                                          */
  /*  @param {object} dbPool — PostgreSQL pool instance                      */
  /*  @returns {Promise<void>}                                                */
  /* ──────────────────────────────────────────────────────────────────────── */

  async warmUp(dbPool) {
    if (this._isWarmedUp || this._warmingUp) {
      logger.warn('warmUp already called, skipping');
      return;
    }

    this._warmingUp = true;

    if (!dbPool) {
      logger.error('warmUp requires dbPool parameter');
      this._ltlmVocabulary = new Set();
      this._isWarmedUp = true;
      this._warmingUp = false;
      return;
    }

    const startTime = Date.now();
    let client = null;

    try {
      let connectTimer;
      const connectPromise = dbPool.connect();
      const connectTimeout = new Promise((_, reject) => {
        connectTimer = setTimeout(() => reject(new Error('warmUp connection timeout')), WARMUP_CONNECT_TIMEOUT_MS);
      });
      client = await Promise.race([connectPromise, connectTimeout]);
      clearTimeout(connectTimer);
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${WARMUP_STATEMENT_TIMEOUT_MS}`);
      await client.query(
        'DECLARE ltlm_vocab_cursor CURSOR FOR SELECT utterance_text FROM ltlm_training_examples'
      );

      const freq = new Map();
      let utterancesProcessed = 0;
      let hasMore = true;

      while (hasMore) {
        const batch = await client.query(
          // FETCH count cannot be parameterized in PostgreSQL — CURSOR_BATCH_SIZE is a module constant
          `FETCH ${CURSOR_BATCH_SIZE} FROM ltlm_vocab_cursor`
        );

        if (!batch.rows || batch.rows.length === 0) {
          hasMore = false;
          break;
        }

        for (const row of batch.rows) {
          if (!row.utterance_text) continue;
          utterancesProcessed++;
          const words = this._extractWords(row.utterance_text);
          if (!words) continue;
          for (const w of words) {
            freq.set(w, (freq.get(w) || 0) + 1);
          }
        }

        if (batch.rows.length < CURSOR_BATCH_SIZE) {
          hasMore = false;
        }
      }

      await client.query('CLOSE ltlm_vocab_cursor');
      await client.query('COMMIT');

      this._ltlmVocabulary = new Set();

      for (const [word, count] of freq) {
        if (count >= this._frequencyThreshold && !AMBIGUOUS_NAMES.has(word)) {
          this._ltlmVocabulary.add(word);
        }
      }

      this._isWarmedUp = true;

      const duration = Date.now() - startTime;

      logger.info('LTLM frequency vocabulary loaded', {
        version: FILTER_VERSION,
        utterancesProcessed,
        uniqueWords: freq.size,
        commonAdded: this._ltlmVocabulary.size,
        threshold: this._frequencyThreshold,
        batchSize: CURSOR_BATCH_SIZE,
        durationMs: duration
      });

    } catch (error) {
      logger.error('warmUp failed, using static sets only', {
        error: error.message
      });

      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error('warmUp rollback failed', {
            error: rollbackError.message
          });
        }
      }

      this._ltlmVocabulary = new Set();
      this._isWarmedUp = true;
    } finally {
      if (client) {
        client.release();
      }
      this._warmingUp = false;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: isWarmedUp                                                      */
  /*                                                                          */
  /*  Returns whether the LTLM vocabulary has been loaded. Before warmUp()  */
  /*  is called, isCommon() still works using COMMON_NOUNS and              */
  /*  FUNCTION_WORDS only — graceful degradation.                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  get isWarmedUp() {
    return this._isWarmedUp;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: getStats                                                        */
  /*                                                                          */
  /*  Returns vocabulary sizes and runtime metrics for observability.        */
  /*  Includes all counter values and rejection reason distribution.         */
  /* ──────────────────────────────────────────────────────────────────────── */

  getStats() {
    return {
      version: FILTER_VERSION,
      frequencyThreshold: this._frequencyThreshold,
      commonNouns: COMMON_NOUNS.size,
      functionWords: FUNCTION_WORDS.size,
      ambiguousNames: AMBIGUOUS_NAMES.size,
      ltlmVocabulary: this._ltlmVocabulary ? this._ltlmVocabulary.size : 0,
      isWarmedUp: this._isWarmedUp,
      metrics: {
        isCommonCalls: this._metrics.isCommonCalls,
        isCommonHits: this._metrics.isCommonHits,
        isCommonMisses: this._metrics.isCommonMisses,
        ambiguousRescues: this._metrics.ambiguousRescues,
        contextChecks: this._metrics.contextChecks,
        contextRejections: this._metrics.contextRejections,
        rejectionReasons: { ...this._metrics.rejectionReasons }
      }
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: resetMetrics                                                    */
  /*                                                                          */
  /*  Zeroes all runtime counters. Useful for session-boundary resets or     */
  /*  periodic metric snapshots. Does NOT affect vocabulary data.            */
  /* ──────────────────────────────────────────────────────────────────────── */

  resetMetrics() {
    this._metrics = {
      isCommonCalls: 0,
      isCommonHits: 0,
      isCommonMisses: 0,
      ambiguousRescues: 0,
      contextChecks: 0,
      contextRejections: 0,
      rejectionReasons: {}
    };
    logger.debug('Metrics reset', { version: FILTER_VERSION });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const commonWordFilter = new CommonWordFilter();

logger.info('CommonWordFilter initialised', {
  version: FILTER_VERSION,
  commonNouns: COMMON_NOUNS.size,
  functionWords: FUNCTION_WORDS.size,
  ambiguousNames: AMBIGUOUS_NAMES.size,
  frequencyThreshold: DEFAULT_FREQUENCY_THRESHOLD,
  ltlmLoaded: false
});

export default commonWordFilter;
