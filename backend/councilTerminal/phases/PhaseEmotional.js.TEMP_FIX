/**
 * ============================================================================
 * PhaseEmotional.js — Emotional Safety Override (v010 FAANG Gold Standard)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Early-phase emotional safety interrupt.
 * Detects distress/support signals and short-circuits with immediate LTLM
 * empathy response. When triggered, it terminates the turn — no downstream
 * phases run.
 *
 * V010 FAANG GOLD STANDARD REWRITE (Feb 16, 2026)
 * -------------------------------------------------
 * Combined build from two sources:
 *
 * SOURCE A: Three independent external reviewers scored the original keyword
 * taxonomy and provided consensus recommendations grounded in peer-reviewed
 * emotion research:
 *   Ekman, P. (1992) — Basic emotions. All 6 primitives now covered.
 *   Plutchik, R. (2001) — Emotion intensity gradients.
 *   Russell, J.A. (1980) — Circumplex model (valence x arousal).
 *   Coppersmith, G. et al. (2018) — Lexical suicide detection methodology.
 *   Choudhury & Kiciman (2017) — First-person self-reference importance.
 *
 * SOURCE B: v012-TNS external review contributed additional keywords
 * (shame/distress/social pain clusters) and the gaming context suppression
 * concept. Architecture, sigmoid scoring, telemetry, abuse heuristics,
 * and class-based structure from v012-TNS were rejected — see rationale
 * in REJECTED FEATURES section below.
 *
 * KEYWORD CHANGES (final combined totals):
 *   CRISIS INHERENT:    4 phrases  -> 15 phrases
 *   CRISIS CONTEXTUAL:  6 phrases  -> 24 phrases
 *   HIGH NEGATIVE:      8 words    -> 22 words
 *   STANDARD NEGATIVE:  16 words   -> 57 words/phrases
 *   POSITIVE:           12 words   -> 37 words
 *   FIRST-PERSON:       9 patterns -> 21 patterns
 *   INTENSIFIERS:       10 words   -> 18 words
 *   NEGATION:           21 patterns-> 24 patterns
 *   SARCASM:            7 phrases  -> 11 phrases
 *   EMOJI MAP:          14 entries -> 35 entries
 *
 * NEW FEATURES:
 *   - Temporal persistence booster: "lately", "for weeks" -> +1 score
 *   - Positive negation check: "I'm not happy" does not flag positive
 *   - Sarcasm emoji detection: upside-down face suppresses triggers
 *   - Crisis keywords bypass negation ("I'm not suicidal" still triggers)
 *   - Gaming context suppression: STANDARD-level only. Prevents "my
 *     character died" false positives. NEVER suppresses crisis or HIGH.
 *   - Latency tracking in logger output for operational visibility
 *
 * RECLASSIFICATIONS:
 *   - "furious" STANDARD -> HIGH (Plutchik high-intensity anger)
 *   - "desperate" STANDARD -> HIGH (crisis-adjacent intensity)
 *
 * REJECTED FEATURES FROM V012-TNS (with rationale):
 *   - Sigmoid probability mapping: no calibration data exists to tune it.
 *     Hard threshold (score >= 2) is deterministic, auditable, works.
 *   - AbuseHeuristics class: premature, mutates session state directly,
 *     violates phase invariant (flags only, no session mutation).
 *   - Telemetry emitter: no streaming infrastructure exists yet.
 *   - Class-based architecture: unnecessary complexity for a stateless
 *     phase. The current object-with-execute pattern is our standard.
 *   - Single-word tokenization: breaks multi-word phrases ("kill myself",
 *     "not okay", "in a bad place"). Regex on full text is correct.
 *   - Fabricated precision numbers: presented as "empirically calibrated
 *     from production telemetry" but we have zero production data.
 *   - Spread operator: does not handle null safely. Object.assign is
 *     deliberate defensive coding.
 *   - Gaming context blocking crisis: "I want to kill myself" with any
 *     gaming word present would NOT trigger. Safety failure. Redesigned
 *     to suppress STANDARD only.
 *
 * V010 PRECISION UPDATE (Feb 14, 2026)
 * -------------------------------------
 * - Score-based multi-signal gating replaces single-keyword triggering.
 * - CRISIS keywords split into INHERENT and CONTEXTUAL.
 * - Negation handling with 3-word window.
 * - Sarcasm suppression.
 * - Emoji normalization.
 * - Repetition intensity scoring.
 * - Positive emotion is NON-TERMINAL.
 * - Cooldown, crisis escalation, circuit breaker, LTLM timeout.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Reads PAD from turnState.diagnosticReport.rawModules.pad
 * - PAD thresholds extracted to frozen constant.
 * - Logger switched to createModuleLogger.
 * - Falls back gracefully if diagnosticReport is null.
 *
 * ARCHITECTURAL NOTE
 * ------------------
 * This phase is an explicit override of normal pipeline sequencing.
 * Emotional safety takes precedence. When triggered, it speaks directly
 * and terminates the turn with terminal: true.
 *
 * Because this phase TERMINATES the entire pipeline, precision > recall
 * for STANDARD and HIGH tiers. False negatives are acceptable. False
 * positives are catastrophic to narrative immersion.
 *
 * EXCEPTION: CRISIS tier biases toward recall. Missing a genuine crisis
 * is worse than a false positive empathy response. Crisis keywords
 * intentionally bypass negation checks — even "I'm not suicidal"
 * is worth checking in on.
 *
 * Positive emotions do NOT terminate. They are flagged on turnState.flags
 * for downstream phases to use (PhaseVoice tone selection, etc).
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Detect emotional distress (keywords + first-person + PAD + negation)
 *  - Select targeted LTLM utterance for negative distress
 *  - Flag positive emotions for downstream phases (non-terminal)
 *  - Short-circuit with terminal emotional response (negative only)
 *  - Escalate repeated crisis signals for review
 *  - Provide hardcoded safe response when LTLM unavailable during crisis
 *
 * NON-GOALS
 * ---------
 *  - No intent classification
 *  - No knowledge retrieval
 *  - No mutation of session (signals via turnState.flags only)
 *  - No positive emotion termination (celebration handled downstream)
 *  - No ML classification (deterministic rules only)
 *  - No PII scrubbing (system-wide concern, not phase-level)
 *
 * INVARIANTS
 * ----------
 *  - Triggers only on clear negative emotional signal (multi-signal)
 *  - Uses internal LTLM only (no external AI APIs)
 *  - terminal: true prevents downstream dilution (negative only)
 *  - At least one lexical signal required (PAD alone never triggers)
 *  - Negated emotions do not trigger (STANDARD/HIGH only — NOT crisis)
 *  - Cooldown prevents consecutive triggers
 *  - Crisis path NEVER returns null (circuit breaker fallback)
 *  - Sarcasm-flagged inputs suppress low-intensity triggers
 *  - Gaming context suppresses STANDARD only (NEVER crisis or HIGH)
 *
 * DEPENDENCIES
 * ------------
 * Internal:
 *   - turnState.diagnosticReport (from EarWig collation) — PAD + composite
 *   - ltlmUtteranceSelector — LTLM utterance retrieval
 *   - withRetry — retry wrapper for LTLM calls
 *   - Counters — emotional trigger rate tracking
 *   - CLAUDE_CHARACTER_ID — Claude's hex character ID (#700002)
 *
 * External: None
 *
 * NAMING CONVENTIONS
 * ------------------
 * Handler: PhaseEmotional (PascalCase object with execute method)
 * Constants: CRISIS_*, NEGATIVE_KEYWORDS_*, PAD_THRESHOLDS (UPPER_SNAKE)
 * Logger: createModuleLogger('PhaseEmotional')
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import { withRetry } from '../utils/withRetry.js';
import { selectLtlmUtteranceForBeat } from '../../services/ltlmUtteranceSelector.js';
import { CLAUDE_CHARACTER_ID } from '../config/constants.js';
import Counters from '../metrics/counters.js';

const logger = createModuleLogger('PhaseEmotional');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Minimum input length to process. Inputs shorter than this are skipped
 * as they cannot contain meaningful emotional content.
 */
const MIN_INPUT_LENGTH = 3;

/**
 * CRISIS keywords — INHERENT first-person.
 * These phrases are grammatically self-referential ("kill myself",
 * "i wish i was dead"). No additional first-person gate needed.
 * Score 4. No negation check — even "I didn't kill myself" is
 * safety-relevant.
 *
 * Source A (3 reviewers): passive death wish, "take my own life",
 *   "cut myself", "i wish i was dead", "i don't want to live".
 * Source B (v012-TNS): "overdose", "hang myself".
 *
 * 15 phrases (was 4).
 */
const CRISIS_INHERENT = /\b(kill myself|hurt myself|end my life|harm myself|take my own life|off myself|cut myself|cutting myself|overdose|hang myself|i wish i was dead|i wish i were dead|i don't want to live|i dont want to live|i should be dead)\b/i;

/**
 * CRISIS keywords — CONTEXTUAL, require first-person gate.
 * "Suicidal" and "want to die" CAN appear in narrative context
 * ("the character was suicidal"). First-person gate prevents that.
 * Score 4 when combined with first-person. No negation check.
 *
 * Source A (3 reviewers): contemporary ideation, contraction variants.
 * Source B (v012-TNS): "give up on everything", "end the pain".
 *
 * Note: "give up" alone excluded — too FP-prone in gaming context
 * ("I give up on this puzzle"). "Give up on everything" is specific.
 *
 * 24 phrases (was 6).
 */
const CRISIS_CONTEXTUAL = /\b(suicidal|want to die|end it all|self.?harm|can't go on|cant go on|can't take it anymore|cant take it anymore|better off dead|don't want to live anymore|dont want to live anymore|tired of living|life's not worth living|lifes not worth living|nothing to live for|no reason to live|done with everything|can't do this anymore|cant do this anymore|thinking about suicide|no point in living|give up on everything|giving up on everything|end the pain)\b/i;

/**
 * HIGH INTENSITY negative keywords — require first-person gate.
 * Score 3 when combined with first-person.
 * These ARE used in narrative contexts ("the kingdom was devastated")
 * so first-person requirement prevents those false positives.
 *
 * Clusters (Plutchik intensity gradient):
 *   Despair: hopeless, devastated, heartbroken, worthless, helpless,
 *            shattered, crushed, broken, destroyed
 *   Trauma: traumatized, numb, empty
 *   Rage: furious, enraged, livid, seething (reclassified from standard)
 *   Shame: ashamed, humiliated, useless (Source B)
 *   Grief: grief, grieving
 *   Crisis-adjacent: desperate (reclassified from standard)
 *
 * 22 words (was 8).
 */
const NEGATIVE_KEYWORDS_HIGH = /\b(hopeless|devastated|heartbroken|worthless|traumatized|numb|empty|helpless|furious|desperate|enraged|livid|seething|ashamed|shattered|crushed|broken|grief|grieving|destroyed|humiliated|useless)\b/i;

/**
 * STANDARD negative keywords — require first-person gate.
 * Score 2 when combined with first-person.
 * Common emotional terms that need self-referential context.
 *
 * Clusters (Ekman primitives + common colloquial):
 *   Sadness (Ekman): sad, depressed, miserable, upset, down,
 *     disappointed, blue, low, bummed, unhappy, crying, wrecked (B)
 *   Anger (Ekman): angry, mad, annoyed, irritated, frustrated,
 *     fed up, resentful, bitter (B)
 *   Fear/Anxiety (Ekman): anxious, afraid, scared, worried, nervous,
 *     overwhelmed, stressed, on edge, freaked out, freaking out,
 *     panicking, terrified, frightened, horrified, petrified,
 *     paranoid (B), losing it (B)
 *   Exhaustion: exhausted, drained
 *   Social pain (B): lonely, isolated, abandoned, rejected, betrayed
 *   Distress: hurt, hurting (B), struggling, suffering (B),
 *     tormented (B), trapped (B), not okay, not alright,
 *     falling apart, breaking down, can't cope, cant cope,
 *     gutted, in a bad place, anguish, despair
 *
 * Note: "furious" and "desperate" moved to HIGH.
 * Note: "not okay" / "not alright" are phrase units — negation check
 *   looks at words BEFORE the matched phrase, so "I'm not okay"
 *   works correctly: keyword = "not okay", words before = "I'm".
 * Note: Gaming context suppresses STANDARD (not HIGH or CRISIS).
 *
 * 57 words/phrases (was 16).
 */
const NEGATIVE_KEYWORDS_STANDARD = /\b(sad|depressed|miserable|upset|down|disappointed|blue|low|bummed|unhappy|crying|wrecked|angry|mad|annoyed|irritated|frustrated|fed up|resentful|bitter|anxious|afraid|scared|worried|nervous|overwhelmed|stressed|on edge|freaked out|freaking out|panicking|terrified|frightened|horrified|petrified|paranoid|losing it|exhausted|drained|lonely|isolated|abandoned|rejected|betrayed|hurt|hurting|struggling|suffering|tormented|trapped|not okay|not alright|falling apart|breaking down|can't cope|cant cope|gutted|in a bad place|anguish|despair)\b/i;

/**
 * POSITIVE keywords — NON-TERMINAL. Flagged for downstream phases.
 * Positive emotions do not terminate the pipeline.
 *
 * Clusters (Russell circumplex — high and low arousal):
 *   High arousal joy: ecstatic, overjoyed, elated, euphoric, thrilled,
 *     excited, stoked, buzzing, pumped, joyful
 *   Core joy (Ekman): happy, glad, cheerful, delighted, pleased (B)
 *   Achievement (B): proud, accomplished, confident
 *   Gratitude: grateful, blessed, thankful (B), appreciative (B)
 *   Hope/Growth (B): hopeful, optimistic, encouraged, inspired
 *   Low arousal positive: content, calm, relaxed, at peace, satisfied,
 *     comfortable, serene (B), secure (B), at ease (B), relieved
 *
 * EXCLUDED: "good", "great" — too ambiguous even with first-person gate.
 * EXCLUDED: "awesome", "amazing" — high sarcasm risk.
 * EXCLUDED: "strong", "capable" — too context-dependent.
 *
 * 37 words (was 12).
 */
const POSITIVE_KEYWORDS = /\b(ecstatic|overjoyed|elated|euphoric|blissful|thrilled|grateful|blessed|delighted|cheerful|proud|relieved|happy|excited|glad|content|calm|relaxed|at peace|hopeful|confident|satisfied|comfortable|stoked|buzzing|pumped|joyful|pleased|accomplished|optimistic|encouraged|inspired|thankful|appreciative|serene|secure|at ease)\b/i;

/**
 * First-person self-referential patterns.
 * Tightened to psychological self-disclosure only.
 * "I feel sad" triggers. "My life quest" does not.
 *
 * Source A: colloquial (im, been feeling, makes me feel).
 * Source B: "i m" (space variant from mobile keyboards), "having me".
 *
 * 21 patterns (was 9).
 */
const FIRST_PERSON_PATTERN = /\b(i am|i'm|im|i m|i feel|i felt|i feel like|i've been|i have been|i'm feeling|im feeling|i was feeling|i've been feeling|i just feel|been feeling|makes me feel|made me feel|got me feeling|it makes me|this makes me|having me)\b/i;

/**
 * Emotional intensifiers — boost signal score by 1.
 * Only applied to non-negated keyword matches.
 *
 * 18 words (was 10).
 */
const INTENSIFIER_PATTERN = /\b(very|really|so|extremely|deeply|incredibly|utterly|absolutely|completely|totally|super|insanely|hella|bloody|dead|damn|lowkey|highkey)\b/i;

/**
 * Temporal persistence markers — boost signal score by 1.
 * Indicates chronic distress vs acute reaction.
 * "I've been sad lately" scores higher than "I'm sad".
 * Only applied when lexical signal is already present.
 *
 * Source A (recommended by 2/3 reviewers).
 */
const TEMPORAL_PERSISTENCE = /\b(lately|for days|for weeks|for months|every day|all the time|constantly|nonstop|for a while|for so long)\b/i;

/**
 * Negation patterns — checked within NEGATION_WINDOW words before keyword.
 * "I'm not sad" -> negated, does not trigger.
 * Crisis keywords intentionally bypass negation checking.
 *
 * 24 patterns (was 21).
 */
const NEGATION_PATTERN = /\b(not|no|never|nothing|none|dont|doesnt|didnt|isnt|arent|wasnt|werent|havent|hasnt|hadnt|cant|cannot|couldnt|wouldnt|shouldnt|aint|barely|hardly)\b|n't/i;

const NEGATION_WINDOW = 3;

/**
 * Sarcasm suppression patterns.
 * Suppress emotional triggering for sarcastic inputs.
 * "Oh great, just what I needed" -> sarcasm, not genuine positive.
 *
 * 11 phrases (was 7).
 */
const SARCASM_HINTS = /\b(oh great|oh wonderful|oh fantastic|oh amazing|yeah right|sure thing|how lovely|love that for me|just great|just perfect|what a treat)\b|[""\u201C\u201D].+[""\u201C\u201D]\s*$/i;

/**
 * Sarcasm emoji — the upside-down face is a near-universal
 * sarcasm marker. Checked separately from text-based sarcasm hints.
 */
const SARCASM_EMOJI = '\u{1F643}';

/**
 * Gaming context detection — suppresses STANDARD-level triggers only.
 * "My character died, I'm so sad" should NOT trigger emotional safety.
 * "I want to kill myself, I can't do this quest" MUST still trigger
 * crisis detection. Therefore gaming context NEVER suppresses crisis
 * or HIGH — only STANDARD.
 *
 * Source B (v012-TNS concept). Implementation redesigned for safety.
 * Original v012-TNS implementation blocked ALL crisis detection when
 * gaming words were present — that was a safety failure.
 *
 * Kept tight — only unambiguous gaming phrases, not generic words
 * like "player" or "level" that could appear in educational contexts.
 */
const GAMING_CONTEXT = /\b(my character|the character|in the game|in this game|this level|the level|the quest|this quest|the boss|this boss|npc|rpg|dnd|d&d|respawn|my avatar)\b/i;

/**
 * Emoji to keyword mapping for normalization.
 * Applied to input before pattern matching so emotional emoji
 * contribute to detection. Keyword targets MUST exist in keyword
 * lists above.
 *
 * Source A: core negative/positive mappings.
 * Source B: additional faces (scared, empty, frowning).
 *
 * 35 entries (was 14).
 */
const EMOJI_MAP = Object.freeze({
  // Negative — High intensity targets
  '\u{1F62D}': ' crying ',       // loudly crying face
  '\u{1F494}': ' heartbroken ',  // broken heart
  '\u{1F621}': ' furious ',      // pouting / rage face
  '\u{1F92C}': ' furious ',      // face with symbols on mouth (cursing)
  '\u{1F631}': ' terrified ',    // face screaming in fear
  '\u{1F62B}': ' exhausted ',    // tired face
  '\u{1F629}': ' overwhelmed ',  // weary face
  '\u{1F92F}': ' overwhelmed ',  // exploding head
  '\u{1F610}': ' numb ',         // neutral face (in emotional context)
  '\u{1F611}': ' numb ',         // expressionless face
  '\u{1F636}': ' empty ',        // no mouth face (Source B)

  // Negative — Standard intensity targets
  '\u{1F622}': ' crying ',       // crying face
  '\u{1F625}': ' sad ',          // sad but relieved face
  '\u{1F61E}': ' disappointed ', // disappointed face
  '\u{1F614}': ' sad ',          // pensive face
  '\u{1F979}': ' sad ',          // face holding back tears
  '\u{1F97A}': ' sad ',          // pleading face
  '\u{1F641}': ' sad ',          // slightly frowning face (Source B)
  '\u{1F620}': ' angry ',        // angry face
  '\u{1F624}': ' frustrated ',   // face with steam from nose
  '\u{1F630}': ' anxious ',      // anxious face with sweat
  '\u{1F628}': ' scared ',       // fearful face (Source B)
  '\u{1F61F}': ' worried ',      // worried face
  '\u{1F613}': ' stressed ',     // downcast face with sweat
  '\u{1F623}': ' stressed ',     // persevering face
  '\u{1F616}': ' stressed ',     // confounded face
  '\u{1F62A}': ' exhausted ',    // sleepy face
  '\u{1F4A5}': ' overwhelmed ',  // collision / explosion
  '\u{2639}': ' sad ',           // frowning face (text style)
  '\u{2639}\u{FE0F}': ' sad ',   // frowning face (with variation selector)

  // Positive targets
  '\u{1F60A}': ' happy ',        // smiling face with smiling eyes
  '\u{1F604}': ' happy ',        // grinning face with smiling eyes
  '\u{1F601}': ' happy ',        // beaming face with smiling eyes
  '\u{1F973}': ' excited ',      // partying face
  '\u{1F929}': ' excited '       // star-struck face
});

/**
 * PAD reliability thresholds.
 * PAD is a booster only — cannot trigger alone.
 */
const PAD_THRESHOLDS = Object.freeze({
  COVERAGE: 0.35,
  CONFIDENCE: 0.3,
  NEGATIVE_PLEASURE: -0.3,
  HIGH_AROUSAL: 0.7,
  LOW_DOMINANCE: 0.3
});

/**
 * Score threshold for triggering emotional safety override.
 *
 * CRISIS inherent:                     4 (always triggers)
 * CRISIS contextual + first-person:    4 (triggers)
 * HIGH + first-person:                 3 (triggers)
 * STANDARD + first-person:             2 (triggers)
 * Repetition bonus:                    1 per extra occurrence
 * PAD extreme:                         1 (booster only)
 * Intensifier (non-negated keyword):   1 (booster only)
 * Temporal persistence:                1 (booster only)
 *
 * Threshold = 2. At least one lexical signal always required.
 */
const TRIGGER_THRESHOLD = 2;

/**
 * Cooldown: minimum turns between emotional safety triggers.
 */
const SAFETY_COOLDOWN_TURNS = 3;

/**
 * Crisis escalation: number of crisis signals before flagging for review.
 */
const CRISIS_ESCALATION_THRESHOLD = 2;

/**
 * LTLM call timeout in milliseconds.
 */
const LTLM_TIMEOUT_MS = 3000;

/**
 * Circuit breaker: hardcoded safe response when LTLM is unavailable
 * during crisis detection. Safety-critical path must NEVER return null.
 */
const CRISIS_FALLBACK_RESPONSE = 'I hear you, and what you are feeling matters. You do not have to go through this alone. If you are in crisis, please reach out to a trusted person or a crisis helpline in your area.';

/**
 * Frozen lookup for emotional response parameters.
 */
const EMOTIONAL_PARAMS = Object.freeze({
  crisis: Object.freeze({
    speechActCode: 'expressive.comfort',
    dialogueFunctionCode: 'expressive.comfort',
    outcomeIntentCode: 'emotional_outcomes.reduce_distress'
  }),
  negative: Object.freeze({
    speechActCode: 'expressive.empathize',
    dialogueFunctionCode: 'expressive.empathize',
    outcomeIntentCode: 'emotional_outcomes.validate_experience'
  }),
  highArousal: Object.freeze({
    speechActCode: 'expressive.sympathize',
    dialogueFunctionCode: 'expressive.sympathize',
    outcomeIntentCode: 'emotional_outcomes.contain_affect'
  })
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Normalize emoji in input text to keyword equivalents.
 *
 * @param {string} text - Raw user input
 * @returns {string} Text with emoji replaced by keyword strings
 */
function _normalizeEmoji(text) {
  let result = text;
  for (const [emoji, replacement] of Object.entries(EMOJI_MAP)) {
    result = result.replaceAll(emoji, replacement);
  }
  return result;
}

/**
 * Check if a keyword match is negated by a preceding word.
 * Scans a NEGATION_WINDOW-word window before the keyword position.
 *
 * @param {string} text - Full input text (lowercase)
 * @param {RegExp} keywordPattern - Pattern to find keyword position
 * @returns {boolean} True if keyword is preceded by negation
 */
function _isKeywordNegated(text, keywordPattern) {
  var globalPattern = new RegExp(keywordPattern.source, 'gi');
  var match;
  var anyNonNegated = false;

  while ((match = globalPattern.exec(text)) !== null) {
    var beforeMatch = text.substring(0, match.index);
    var wordsBefore = beforeMatch.trim().split(/\s+/).filter(Boolean);
    var window = wordsBefore.slice(-NEGATION_WINDOW);
    var windowText = window.join(' ');

    NEGATION_PATTERN.lastIndex = 0;
    if (!NEGATION_PATTERN.test(windowText)) {
      anyNonNegated = true;
      break;
    }
  }

  return !anyNonNegated;
}
/**
 * Count occurrences of keywords matching a pattern in the input.
 * Used for repetition intensity scoring.
 *
 * @param {string} text - Input text
 * @param {RegExp} pattern - Keyword pattern (will be made global)
 * @returns {number} Number of matches found
 */
function _countKeywordOccurrences(text, pattern) {
  var globalPattern = new RegExp(pattern.source, 'gi');
  var matches = text.match(globalPattern);
  return matches ? matches.length : 0;
}

/**
 * Detect sarcasm hints that should suppress emotional triggering.
 * Checks text patterns and upside-down face emoji.
 *
 * @param {string} originalText - Original input (for emoji check)
 * @param {string} lowerText - Lowercased text (for pattern matching)
 * @returns {boolean} True if sarcasm is detected
 */
function _hasSarcasmHints(originalText, lowerText) {
  SARCASM_HINTS.lastIndex = 0;
  return SARCASM_HINTS.test(lowerText) || originalText.includes(SARCASM_EMOJI);
}

/**
 * Create a timeout promise for LTLM calls.
 *
 * @param {number} ms - Timeout in milliseconds
 * @returns {Promise} Promise that rejects after timeout
 */
function _createTimeout(ms) {
  return new Promise(function(resolve, reject) {
    setTimeout(function() {
      reject(new Error('LTLM call timed out after ' + ms + 'ms'));
    }, ms);
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PhaseEmotional Handler                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

var PhaseEmotional = {
  async execute(turnState) {
    var command = turnState.command;
    var session = turnState.session;
    var user = turnState.user;
    var correlationId = turnState.correlationId;
    var startTime = Date.now();

    logger.debug('Executing', { correlationId });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  1. Early guards                                                    */
    /* ──────────────────────────────────────────────────────────────────── */

    if (!command || command.length < MIN_INPUT_LENGTH) {
      logger.debug('Skipped — empty or too short', {
        correlationId,
        length: command ? command.length : 0
      });
      return null;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  2. Cooldown check                                                  */
    /*  Prevent emotional safety from firing every turn.                   */
    /* ──────────────────────────────────────────────────────────────────── */

    var currentTurn = session?.context?.turn_index || 0;
    var lastSafetyTurn = session?.context?.lastSafetyTurn || -99;

    if (currentTurn - lastSafetyTurn < SAFETY_COOLDOWN_TURNS) {
      logger.debug('In cooldown', {
        correlationId,
        currentTurn,
        lastSafetyTurn,
        cooldown: SAFETY_COOLDOWN_TURNS
      });
      return null;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  3. Normalize input (emoji -> keyword text)                         */
    /* ──────────────────────────────────────────────────────────────────── */

    var normalizedCommand = _normalizeEmoji(command);
    var lowerCommand = normalizedCommand.toLowerCase();


    /* ──────────────────────────────────────────────────────────────────── */
    /*  4. Read PAD from diagnosticReport (EarWig collation output)       */
    /*  Raw PAD from rawModules, composite from collation engine.         */
    /*  Falls back to neutral if diagnosticReport is null.                */
    /* ──────────────────────────────────────────────────────────────────── */

    var diagnosticReport = turnState.diagnosticReport;
    var rawModules = diagnosticReport?.rawModules || null;
    var padData = rawModules?.pad || { p: 0, a: 0, d: 0 };
    var padMeta = rawModules?.padMeta || null;
    var compositeEmotional = diagnosticReport?.compositeEmotionalState || null;

    var isPadReliable = padMeta
      ? padMeta.coverage >= PAD_THRESHOLDS.COVERAGE
        && padMeta.confidence >= PAD_THRESHOLDS.CONFIDENCE
      : false;

    logger.debug('PAD state', {
      correlationId,
      p: padData.p,
      a: padData.a,
      d: padData.d,
      coverage: padMeta?.coverage,
      confidence: padMeta?.confidence,
      isPadReliable,
      posture: diagnosticReport?.postureRecommendation,
      trajectory: compositeEmotional?.trajectory,
      volatility: compositeEmotional?.volatility,
      source: diagnosticReport ? 'diagnosticReport' : 'fallback'
    });

    /* ──────────────────────────────────────────────────────────────────── */
    /*  5. Detect positive emotion (non-terminal, flag only)               */
    /*                                                                     */
    /*  Positive emotions do NOT terminate the pipeline. They are flagged  */
    /*  on turnState.flags for downstream phases. Sarcasm check prevents   */
    /*  "oh great" from being flagged. Negation check prevents "I'm not   */
    /*  happy" from being flagged.                                         */
    /* ──────────────────────────────────────────────────────────────────── */

    var hasFirstPerson = FIRST_PERSON_PATTERN.test(lowerCommand);
    var hasPositive = POSITIVE_KEYWORDS.test(lowerCommand);
    var hasSarcasm = _hasSarcasmHints(normalizedCommand, lowerCommand);
    var positiveNegated = hasPositive
      ? _isKeywordNegated(lowerCommand, POSITIVE_KEYWORDS)
      : false;

    if (hasPositive && hasFirstPerson && !hasSarcasm && !positiveNegated) {
      turnState.flags = Object.assign({}, turnState.flags || {}, {
        positiveEmotionDetected: true
      });

      logger.debug('Positive emotion flagged (non-terminal)', {
        correlationId,
        hasFirstPerson,
        hasSarcasm,
        positiveNegated
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  6. Multi-signal negative detection with scoring                    */
    /*                                                                     */
    /*  CRISIS inherent:    score 4 (bypass first-person. NO negation.)   */
    /*  CRISIS contextual + first-person: score 4 (NO negation check)     */
    /*  HIGH + first-person:     score 3 (negation-checked)               */
    /*  STANDARD + first-person: score 2 (negation + sarcasm + gaming)    */
    /*  Repetition bonus:        +1 per extra keyword occurrence           */
    /*  PAD extreme:             score 1 (booster only)                    */
    /*  Intensifier:             score 1 (booster, non-negated only)       */
    /*  Temporal persistence:    score 1 (booster, lexical signal req.)    */
    /*                                                                     */
    /*  Gaming context: suppresses STANDARD only. NEVER crisis or HIGH.   */
    /*  At least one LEXICAL signal required — PAD alone never triggers.   */
    /* ──────────────────────────────────────────────────────────────────── */

    var hasIntensifier = INTENSIFIER_PATTERN.test(lowerCommand);
    var hasTemporalPersistence = TEMPORAL_PERSISTENCE.test(lowerCommand);
    var hasGamingContext = GAMING_CONTEXT.test(lowerCommand);

    var signals = {
      crisisInherent: CRISIS_INHERENT.test(lowerCommand),
      crisisContextual: CRISIS_CONTEXTUAL.test(lowerCommand),
      negativeHigh: NEGATIVE_KEYWORDS_HIGH.test(lowerCommand),
      negativeHighNegated: false,
      negativeStandard: NEGATIVE_KEYWORDS_STANDARD.test(lowerCommand),
      negativeStandardNegated: false,
      hasFirstPerson: hasFirstPerson,
      hasIntensifier: hasIntensifier,
      hasTemporalPersistence: hasTemporalPersistence,
      hasGamingContext: hasGamingContext,
      hasSarcasm: hasSarcasm,
      padNegative: isPadReliable && padData.p < PAD_THRESHOLDS.NEGATIVE_PLEASURE,
      padDistressArousal: isPadReliable
        && padData.a > PAD_THRESHOLDS.HIGH_AROUSAL
        && padData.d < PAD_THRESHOLDS.LOW_DOMINANCE
    };

    if (signals.negativeHigh) {
      signals.negativeHighNegated = _isKeywordNegated(lowerCommand, NEGATIVE_KEYWORDS_HIGH);
    }
    if (signals.negativeStandard) {
      signals.negativeStandardNegated = _isKeywordNegated(lowerCommand, NEGATIVE_KEYWORDS_STANDARD);
    }

    var score = 0;
    var hasLexicalSignal = false;
    var isCrisis = false;

    if (signals.crisisInherent) {
      score += 4;
      hasLexicalSignal = true;
      isCrisis = true;
    }

    if (signals.crisisContextual && hasFirstPerson) {
      score += 4;
      hasLexicalSignal = true;
      isCrisis = true;
    }

    if (signals.negativeHigh && !signals.negativeHighNegated && hasFirstPerson) {
      score += 3;
      hasLexicalSignal = true;
    }

    if (signals.negativeStandard && !signals.negativeStandardNegated && hasFirstPerson) {
      if (!hasSarcasm && !hasGamingContext) {
        score += 2;
        hasLexicalSignal = true;
      }
    }

    if (hasLexicalSignal) {
      var repetitionCount = _countKeywordOccurrences(lowerCommand, NEGATIVE_KEYWORDS_STANDARD)
        + _countKeywordOccurrences(lowerCommand, NEGATIVE_KEYWORDS_HIGH);
      if (repetitionCount > 1) {
        score += repetitionCount - 1;
      }
    }

    if (signals.padNegative) {
      score += 1;
    }

    if (signals.padDistressArousal) {
      score += 1;
    }

    if (hasIntensifier && hasLexicalSignal) {
      score += 1;
    }

    if (hasTemporalPersistence && hasLexicalSignal) {
      score += 1;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  7. Gate check                                                      */
    /*  Require score >= threshold AND at least one lexical signal.        */
    /*  PAD alone cannot trigger. Negated keywords do not count.           */
    /*  Sarcasm and gaming context suppress standard-level triggers.       */
    /* ──────────────────────────────────────────────────────────────────── */

    if (score < TRIGGER_THRESHOLD || !hasLexicalSignal) {
      logger.debug('Below threshold or no lexical signal', {
        correlationId,
        score: score,
        threshold: TRIGGER_THRESHOLD,
        hasLexicalSignal: hasLexicalSignal,
        signals: signals,
        latencyMs: Date.now() - startTime
      });
      return null;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  8. Crisis escalation tracking                                      */
    /*  After CRISIS_ESCALATION_THRESHOLD crisis signals in a session,     */
    /*  flag for review. Does NOT prevent the response — adds a flag.      */
    /* ──────────────────────────────────────────────────────────────────── */

    var crisisEscalation = false;

    if (isCrisis) {
      var previousCrisisCount = session?.context?.crisisSignalCount || 0;
      var newCrisisCount = previousCrisisCount + 1;

      session.context = session.context || {};
      session.context.crisisSignalCount = newCrisisCount;

      if (newCrisisCount >= CRISIS_ESCALATION_THRESHOLD) {
        crisisEscalation = true;
        session.context.crisisEscalationRequired = true;

        logger.warn('Crisis escalation threshold reached', {
          correlationId,
          crisisCount: newCrisisCount,
          threshold: CRISIS_ESCALATION_THRESHOLD
        });

        Counters.increment('crisis_escalation_flagged');
      }
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  9. Select emotional params                                         */
    /* ──────────────────────────────────────────────────────────────────── */

    var paramKey = null;

    if (isCrisis) {
      paramKey = 'crisis';
    } else if (signals.padDistressArousal && hasLexicalSignal) {
      paramKey = 'highArousal';
    } else {
      paramKey = 'negative';
    }

    var params = EMOTIONAL_PARAMS[paramKey];

    logger.info('Triggered', {
      correlationId,
      paramKey: paramKey,
      score: score,
      isCrisis: isCrisis,
      crisisEscalation: crisisEscalation,
      speechAct: params.speechActCode,
      signals: signals,
      padReliable: isPadReliable,
      latencyMs: Date.now() - startTime
    });

    Counters.increment('emotional_safety_triggered', paramKey);

    /* ──────────────────────────────────────────────────────────────────── */
    /*  10. Get LTLM utterance with timeout                                */
    /*                                                                     */
    /*  Promise.race ensures LTLM cannot hang the pipeline.                */
    /*  Circuit breaker: if LTLM fails AND this is a crisis detection,     */
    /*  return hardcoded safe response. Crisis path NEVER returns null.     */
    /* ──────────────────────────────────────────────────────────────────── */

    var utteranceText = null;

    try {
      var ltlmPromise = withRetry(
        function() {
          return selectLtlmUtteranceForBeat({
            speakerCharacterId: turnState.speakerCharacterId || CLAUDE_CHARACTER_ID,
            speechActCode: params.speechActCode,
            dialogueFunctionCode: params.dialogueFunctionCode,
            outcomeIntentCode: params.outcomeIntentCode,
            targetPad: {
              pleasure: padData.p || 0,
              arousal: padData.a || 0,
              dominance: padData.d || 0
            }
          });
        },
        { maxAttempts: 3, backoffMs: 100 }
      );

      var utterance = await Promise.race([
        ltlmPromise,
        _createTimeout(LTLM_TIMEOUT_MS)
      ]);

      if (utterance?.utteranceText) {
        utteranceText = utterance.utteranceText.replace(
          /<SUBJECT>/g,
          user?.username || 'friend'
        );
      }
    } catch (err) {
      logger.error('LTLM failed or timed out', {
        correlationId,
        error: err.message,
        isCrisis: isCrisis
      });
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  11. Circuit breaker — crisis path must NEVER return null           */
    /* ──────────────────────────────────────────────────────────────────── */

    if (!utteranceText && isCrisis) {
      utteranceText = CRISIS_FALLBACK_RESPONSE;

      logger.warn('Circuit breaker activated — using hardcoded crisis response', {
        correlationId
      });

      Counters.increment('emotional_crisis_circuit_breaker');
    }

    if (!utteranceText) {
      logger.debug('No utterance found, falling through', { correlationId });
      return null;
    }

    /* ──────────────────────────────────────────────────────────────────── */
    /*  12. Build terminal response                                        */
    /* ──────────────────────────────────────────────────────────────────── */

    turnState.flags = Object.assign({}, turnState.flags || {}, {
      emotionalSafetyTriggered: true,
      emotionalParamKey: paramKey,
      emotionalScore: score
    });
    session.context = session.context || {};
    session.context.lastSafetyTurn = currentTurn;

    logger.info('Emotional response selected', {
      correlationId,
      paramKey: paramKey,
      score: score,
      isCrisis: isCrisis,
      crisisEscalation: crisisEscalation,
      dialogueFunction: params.dialogueFunctionCode,
      circuitBreaker: utteranceText === CRISIS_FALLBACK_RESPONSE,
      latencyMs: Date.now() - startTime
    });

    return {
      responseIntent: {
        success: true,
        output: utteranceText,
        source: 'emotional_safety_override',
        confidence: 0.85,
        emotional: true,
        _meta: {
          paramKey: paramKey,
          score: score,
          isCrisis: isCrisis,
          crisisEscalation: crisisEscalation,
          signals: signals,
          padReliable: isPadReliable,
          padCoverage: padMeta?.coverage,
          padConfidence: padMeta?.confidence,
          circuitBreaker: utteranceText === CRISIS_FALLBACK_RESPONSE
        }
      },
      terminal: true,
      requestTermination: true
    };
  }
};

export default PhaseEmotional;
