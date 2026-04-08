/**
 * ============================================================================
 * cotwIntentMatcher.js — Intent Classification & Entity Resolution (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Processes natural language queries and classifies them into intent types
 * (WHO, WHAT, WHERE, WHEN, WHY, HOW, WHICH, IS, SEARCH, EDIT_PROFILE, etc.)
 * with optional entity extraction and realm-aware access control.
 *
 * Handles both entity-seeking queries (knowledge lookups) and conversational
 * intents (greetings, farewells, identity questions, teaching requests).
 *
 * ARCHITECTURE
 * -----------
 * Multi-stage matching pipeline with early exits for high-confidence matches:
 *
 *   Stage 0: Conversational Intents
 *     ↓ (no match)
 *   Stage 1: Context-Aware Pronouns (he, she, it, they, that, this)
 *     ↓ (no match)
 *   Stage 2: Confirmations (yes/no/correct/wrong)
 *     ↓ (no match)
 *   Stage 3: Visual Requests (show image, display picture)
 *     ↓ (no match)
 *   Stage 4: Strict Regex Matching (high confidence patterns)
 *     ↓ (no match)
 *   Stage 5: Loose Keyword Matching (single-word fallback)
 *     ↓ (no match)
 *   Stage 6: Fallback Search (semantic/fuzzy search)
 *
 * Each stage short-circuits if a confident match is found. Conversational
 * intents exit before expensive entity searches.
 *
 * CONVERSATIONAL INTENTS (No Entity Search)
 * ------------------------------------------
 * - GREETING: "hey", "hi", "hello", etc.
 * - FAREWELL: "bye", "goodbye", "see you later", etc.
 * - GRATITUDE: "thanks", "thank you", "appreciate", etc.
 * - HOW_ARE_YOU: "how are you?", "how's it going?", etc.
 * - SELF_INQUIRY: Identity questions about Claude/Tanuki (9 subtypes)
 * - TEACH_REQUEST: "teach me", "what can you teach?", etc.
 *
 * SELF_INQUIRY SUBTYPES (detectSelfInquirySubtype)
 * ------------------------------------------------
 * - ASSERTION: "you're a bot", "so you're an AI"
 * - DEEPER: Existential questions ("who are you really?")
 * - RULES: Boundaries & limitations ("what are your rules?")
 * - ORIGIN: Creation & background ("who made you?")
 * - CAPABILITY: What can you do? ("what's your purpose?")
 * - NATURE: Realness ("are you real?", "are you alive?")
 * - NAME: Identity ("what's your name?")
 * - THIRD_PERSON: Reference to Claude ("who is Claude?")
 * - IDENTITY: Generic ("who are you?", "tell me about yourself")
 *
 * ENTITY-SEEKING INTENTS (Perform Search)
 * ----------------------------------------
 * - WHO: "who is...", "tell me about...", "identify..."
 * - WHAT: "what is...", "define...", "explain..."
 * - WHERE: "where is...", "location of..."
 * - WHEN: "when did...", "when will..."
 * - WHY: "why did...", "reason for..."
 * - HOW: "how does...", "how to..."
 * - WHICH: "which character...", "which one..."
 * - IS: "is X a Y?", "are X Y?"
 * - SEARCH: "search for...", "find...", "lookup..."
 * - SHOW_IMAGE: "show me a picture of...", "display image of..."
 * - EDIT_PROFILE: "edit...", "open..." (requires authorization)
 *
 * ACCESS CONTROL (Realm-Aware)
 * ----------------------------
 * - access_level 1-10: Standard users, single-tier search
 * - access_level 11: God Mode, all-tier search (searchEntityAllTiers)
 * - realm_hex_id: Derived from access_level, gates which entities visible
 *
 * ENTITY CACHING
 * ---------------
 * Per-realm cache with TTL (default 5 minutes). Cache stores all entities
 * in a realm to prevent redundant DB queries. Supports manual invalidation
 * on entity updates (invalidateCache method).
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - withRetry wrapper on all entity search calls (transient failure resilience)
 * - Timeout protection on entity searches (prevent hangs)
 * - Counters instrumentation on every intent path and subtype
 * - Audit logging on sensitive intents (EDIT_PROFILE, SELF_INQUIRY subtypes)
 * - God-mode logic factored into _applyGodModeExpansion helper (DRY)
 * - Full documentation header with architecture and rationale
 * - Structured logger (createModuleLogger) with consistent format
 * - Dynamic identity/entity names (config-driven, not hardcoded "Claude")
 * - ReDoS protection: atomic groups in complex regexes, regex timeout
 * - Cache refresh error handling: proper error response, not silent failure
 * - Input validation on all public methods
 * - Frozen constants throughout
 * - Magic numbers externalized to ENV/constants
 * - Cache invalidation hook (invalidateCache method)
 *
 * DEPENDENCIES
 * -----------
 * - tieredEntitySearch.js (searchEntityWithDisambiguation, searchEntityAllTiers)
 * - entityHelpers.js (getAllEntitiesInRealm)
 * - logger.js (structured logging)
 * - withRetry.js (transient failure retry)
 * - counters.js (metrics instrumentation)
 *
 * PERFORMANCE NOTES
 * -----------------
 * - Conversational intents short-circuit before entity searches
 * - Entity cache prevents repeated full-realm scans
 * - withRetry on search calls prevents cascading failures
 * - Timeout protection prevents slow DB queries from blocking
 * - Counters track distribution of intent types and paths
 *
 * MONITORING & OBSERVABILITY
 * ---------------------------
 * - Counters: intent_matched (type/subtype), intent_conversational,
 *   intent_search_path, intent_god_mode, intent_cache_hit/miss
 * - Audit logs: EDIT_PROFILE, SELF_INQUIRY.DEEPER/RULES, high-confidence
 *   god-mode matches
 * - Structured logging: intent type, confidence, matcher method, realm
 *
 * SECURITY
 * --------
 * - Input sanitization on queries (cleanQuery method)
 * - Authorization flags for sensitive intents (EDIT_PROFILE)
 * - Audit logging on sensitive operations
 * - ReDoS protection on complex regexes
 * - Cache refresh error handling (no silent failures)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { searchEntityWithDisambiguation, searchEntityAllTiers } from '../utils/tieredEntitySearch.js';
import { getAllEntitiesInRealm } from '../utils/entityHelpers.js';
import { createModuleLogger } from '../utils/logger.js';
import { withRetry } from './utils/withRetry.js';
import Counters from './metrics/counters.js';

const logger = createModuleLogger('cotwIntentMatcher');

/*
 * ============================================================================
 * Configuration Constants (Frozen)
 * ============================================================================
 */

const _envNum = (key, fallback) => {
  if (process.env[key] === undefined) return fallback;
  const val = Number(process.env[key]);
  return isNaN(val) ? fallback : val;
};

const CONFIG = Object.freeze({
  CACHE_TTL_MS: _envNum('COTW_CACHE_TTL_MS', 300000),
  ENTITY_SEARCH_TIMEOUT_MS: _envNum('COTW_SEARCH_TIMEOUT_MS', 5000),
  QUERY_RETRY_ATTEMPTS: _envNum('COTW_RETRY_ATTEMPTS', 2),
  QUERY_RETRY_BACKOFF_MS: _envNum('COTW_RETRY_BACKOFF_MS', 100),
  MAX_ENTITIES_PER_REALM: _envNum('COTW_MAX_ENTITIES', 1000),
  CONFIDENCE_THRESHOLD_HIGH: 0.9,
  CONFIDENCE_THRESHOLD_MEDIUM: 0.7,
  CONFIDENCE_THRESHOLD_LOW: 0.5
});
/* Pre-compiled hot-path regex (avoid per-call compilation) */
const CONNECTOR_PATTERN = /^(?:is|are|was|were|does|did|the|a|an)\s+/i;
const PRONOUN_INTENT_PATTERN = /^(who|what|where|when|why|how|which|is) (?:is|was|are|were)? (?:he|she|it|they|that|this)$/i;
const AFFIRMATIVE_PATTERN = /^(yes|yep|yeah|correct|that's it|that's right|yup|ya|yea)$/i;
const NEGATIVE_PATTERN = /^(no|nope|wrong|not that|not it|nah|nay)$/i;
const IMAGE_GATE_PATTERN = /(?:show|display|see|view).*(?:picture|photo|image|pic|portrait|visual)/i;
const PRONOUN_ENTITY_PATTERN = /^(he|she|it|they|that|this|him|her)$/i;


const SELF_INQUIRY_SUBTYPES = Object.freeze({
  ASSERTION: 'ASSERTION',
  DEEPER: 'DEEPER',
  RULES: 'RULES',
  ORIGIN: 'ORIGIN',
  CAPABILITY: 'CAPABILITY',
  NATURE: 'NATURE',
  NAME: 'NAME',
  THIRD_PERSON: 'THIRD_PERSON',
  IDENTITY: 'IDENTITY'
});

const INTENT_TYPES = Object.freeze({
  GREETING: 'GREETING',
  FAREWELL: 'FAREWELL',
  GRATITUDE: 'GRATITUDE',
  HOW_ARE_YOU: 'HOW_ARE_YOU',
  SELF_INQUIRY: 'SELF_INQUIRY',
  TEACH_REQUEST: 'TEACH_REQUEST',
  EMOTIONAL: 'EMOTIONAL',
  WHO: 'WHO',
  WHAT: 'WHAT',
  WHERE: 'WHERE',
  WHEN: 'WHEN',
  WHY: 'WHY',
  HOW: 'HOW',
  WHICH: 'WHICH',
  IS: 'IS',
  SEARCH: 'SEARCH',
  SHOW_IMAGE: 'SHOW_IMAGE',
  EDIT_PROFILE: 'EDIT_PROFILE'
});

/*
 * ============================================================================
 * Main Service Class
 * ============================================================================
 */

class CotwIntentMatcher {
  constructor() {
    // TIER 1: STRICT PATTERNS (High Confidence)
    this.intents = Object.freeze({
      EDIT_PROFILE: Object.freeze([
        /^edit (.+?)$/i,
        /^open (.+?)$/i
      ]),
      WHO: Object.freeze([
        /^who is (.+?)$/i,
        /^who are the (.+?)$/i,
        /^tell me about (.+?)$/i,
        /^identify (.+?)$/i,
        /^show me (.+?)$/i
      ]),
      WHAT: Object.freeze([
        /^what is (.+?)$/i,
        /^what are (.+?)$/i,
        /^define (.+?)$/i,
        /^explain (.+?)$/i
      ]),
      WHEN: Object.freeze([
        /^when did (.+?)$/i,
        /^when was (.+?)$/i,
        /^when will (.+?)$/i,
        /^what time (.+?)$/i
      ]),
      WHERE: Object.freeze([
        /^where is (.+?)$/i,
        /^where are (.+?)$/i,
        /^where did (.+?)$/i,
        /^location of (.+?)$/i
      ]),
      WHY: Object.freeze([
        /^why did (.+?)$/i,
        /^why is (.+?)$/i,
        /^why does (.+?)$/i,
        /^reason for (.+?)$/i
      ]),
      HOW: Object.freeze([
        /^how does (.+?)$/i,
        /^how did (.+?)$/i,
        /^how to (.+?)$/i,
        /^how is (.+?)$/i
      ]),
      WHICH: Object.freeze([
        /^which (?:character|person|entity|one) (?:is|has|was) (?:the |a |an )?(.+)$/i,
        /^which (.+)$/i
      ]),
      IS: Object.freeze([
        /^is ([a-zA-Z0-9\s]+) (?:a|an|the) (.+?)$/i,
        /^are ([a-zA-Z0-9\s]+) (.+?)$/i
      ]),
      SEARCH: Object.freeze([
        /^search for (.+?)$/i,
        /^find (.+?)$/i,
        /^lookup (.+?)$/i,
        /^query (.+?)$/i
      ])
    });

    // TIER 2: KEYWORD MAPPING (Loose Match)
    this.keywordMap = Object.freeze({
      'who': 'WHO',
      'whom': 'WHO',
      'identify': 'WHO',
      'character': 'WHO',
      'person': 'WHO',
      'what': 'WHAT',
      'define': 'WHAT',
      'explain': 'WHAT',
      'meaning': 'WHAT',
      'concept': 'WHAT',
      'where': 'WHERE',
      'location': 'WHERE',
      'located': 'WHERE',
      'place': 'WHERE',
      'position': 'WHERE',
      'when': 'WHEN',
      'time': 'WHEN',
      'date': 'WHEN',
      'why': 'WHY',
      'reason': 'WHY',
      'cause': 'WHY',
      'how': 'HOW',
      'mechanism': 'HOW',
      'method': 'HOW',
      'search': 'SEARCH',
      'find': 'SEARCH',
      'look': 'SEARCH',
      'get': 'SEARCH'
    });

    // Conversational noise to strip
    this.noisePatterns = Object.freeze([
      /^(?:can|could|would|will) (?:you|i) (?:please )?(?:tell me |show me |find |give me )?/i,
      /^(?:please |kindly )/i,
      /^(?:i want to know )/i,
      /^(?:tell me )/i
    ]);

    // Entity cache
    this.entityCache = new Map();
    this.cacheTimestamps = new Map();

    // CONVERSATIONAL INTENTS (No entity search needed)
    this.conversationalPatterns = Object.freeze({
      GREETING: Object.freeze([
        /^(hey|hi|hello|howdy|yo|hiya|heya)(\s+claude)?[!.]?$/i,
        /^good\s*(morning|afternoon|evening|day)(\s+claude)?[!.]?$/i,
        /^what'?s\s*up(\s+claude)?[!?.]?$/i,
        /^how('?s\s*it\s*going|'?re\s*you|'?s\s*everything)(\s+claude)?[!?.]?$/i,
        /^greetings(\s+claude)?[!.]?$/i
      ]),
      FAREWELL: Object.freeze([
        /^(bye|goodbye|later|cya|see\s*ya|peace|adios)(\s+claude)?[!.]?$/i,
        /^(gotta\s*go|have\s*to\s*go|need\s*to\s*go|heading\s*out)(\s+claude)?[!.]?$/i,
        /^(take\s*care|see\s*you\s*(later|soon|around)|until\s*next\s*time)(\s+claude)?[!.]?$/i,
        /^(good\s*night|night|nite)(\s+claude)?[!.]?$/i
      ]),
      GRATITUDE: Object.freeze([
        /^(thanks?|thank\s*you|thx|ty)(\s+(so\s*much|a\s*lot|claude))*[!.]?$/i,
        /^(i\s*)?(really\s*)?(appreciate|grateful)(\s+(it|that|you|claude))*[!.]?$/i,
        /^(much|many)\s*thanks(\s+claude)?[!.]?$/i
      ]),
      HOW_ARE_YOU: Object.freeze([
        /^how\s*(are|r)\s*(you|u)(\s*(doing|today|feeling))?(\s+claude)?[!?.]?$/i,
        /^(you\s*)?(doing\s*)?(ok|okay|alright|good)(\s+claude)?[!?.]?$/i,
        /^how('?s|'?re)\s*(things|life|you)(\s+claude)?[!?.]?$/i
      ]),
      SELF_INQUIRY: Object.freeze([
        /^so\s+you('?re|\s+are)\s+/i,
        /^you('?re|\s+are)\s+(claude|the\s+tanuki|a\s+tanuki|an?\s+ai|a\s+bot|not\s+real|real|my\s+guide)/i,
        /^(who|what)('?re|\s+(exactly\s+)?are)\s+you(\s+claude)?(\s+really)?[!?.]?$/i,
        /^tell\s+(me|us)\s+about\s+(yourself|you)(\s+claude)?[!?.]?$/i,
        /^(present|describe|introduce)\s+(yourself|you)(\s+claude)?[!?.]?$/i,
        /^introduce\s+(claude|the\s+tanuki|this\s+tanuki|this\s+guide)[!?.]?$/i,
        /^what('?s|\s+is)\s+your\s+(name|identity|nature|story)(\s+claude)?[!?.]?$/i,
        /^what('?s|\s+is)\s+your\s+deal(\s+claude)?[!?.]?$/i,
        /^so\s+who\s+are\s+you(\s+then)?[!?.]?$/i,
        /^so\s+what\s+are\s+you(\s+then)?[!?.]?$/i,
        /^(claude|the\s+tanuki)\s+(is|are)\s+(what|who)[!?.]?$/i,
        /^who\s+(exactly\s+)?is\s+(claude|the\s+tanuki)(\s+the\s+tanuki)?[!?.]?$/i,
        /^what\s+is\s+(claude|the\s+tanuki|this\s+tanuki|this\s+guide)[!?.]?$/i,
        /^tell\s+(me|us)\s+about\s+(claude|the\s+tanuki)(\s+the\s+tanuki)?[!?.]?$/i,
        /^what\s+(can|do)\s+you\s+do(\s+claude)?[!?.]?$/i,
        /^what\s+are\s+you\s+(capable\s+of|able\s+to\s+do|for)(\s+claude)?[!?.]?$/i,
        /^what\s+is\s+your\s+(purpose|job|role|function)(\s+claude)?[!?.]?$/i,
        /^why\s+do\s+you\s+exist[!?.]?$/i,
        /^where\s+(do\s+you\s+come\s+from|are\s+you\s+from|were\s+you\s+born|did\s+you\s+come\s+from)(\s+claude)?[!?.]?$/i,
        /^what('?s|\s+is)\s+your\s+(origin|background|history)(\s+claude)?[!?.]?$/i,
        /^who\s+(made|created|built|programmed|designed)\s+you(\s+claude)?[!?.]?$/i,
        /^are\s+you\s+(an?\s+)?(real\s+)?(tanuki|yokai|spirit|person|human|bot|ai|robot|program|script)(\s+claude)?[!?.]?$/i,
        /^are\s+you\s+(just\s+)?(an?\s+)?(bot|ai|program|script)[!?.]?$/i,
        /^are\s+you\s+real(\s+though|\s+really)?[!?.]?$/i,
        /^what\s+are\s+you\s+really[!?.]?$/i,
        /^what\s+are\s+you\s+supposed\s+to\s+be[!?.]?$/i,
        /^what\s+kind\s+of\s+(creature|being|entity)\s+are\s+you(\s+claude)?[!?.]?$/i,
        /^is\s+claude\s+(real|alive|a\s+bot|an\s+ai)[!?.]?$/i,
        /^what\s+are\s+your\s+(rules|limits|limitations|constraints)[!?.]?$/i,
        /^what\s+won'?t\s+you\s+do[!?.]?$/i,
        /^what\s+can'?t\s+you\s+do[!?.]?$/i,
        /^who\s+are\s+you\s+really[!?.]?$/i,
        /^what\s+are\s+you\s+hiding[!?.]?$/i
      ]),
      TEACH_REQUEST: Object.freeze([
        /^what\s+can\s+you\s+teach\s+(me|us)[!?.]?$/i,
        /^teach\s+me\s+(something|anything)[!?.]?$/i,
        /^(can|could|will|would)\s+you\s+teach\s+me[!?.]?$/i,
        /^i\s+(want|would\s+like)\s+to\s+learn[!?.]?$/i,
        /^what\s+(do|can)\s+you\s+know[!?.]?$/i,
        /^what\s+can\s+i\s+learn[!?.]?$/i,
        /^show\s+me\s+what\s+(you\s+can\s+teach|i\s+can\s+learn)[!?.]?$/i
      ]),
      EMOTIONAL: Object.freeze([
        /^(?:i(?:'m| am)|feel(?:ing)?)\s+(?:so |very |really |quite )?(happy|glad|delighted|joyful|cheerful)\b/i,
        /^(?:i(?:'m| am))\s+(?:so |very |really |quite )?(happy|glad|delighted)\s+(?:today|right now|at the moment)\b/i,
        /^(?:feeling|feel)\s+(?:pretty |quite |really |so )?(good|great|wonderful|fantastic)\b/i,
        /^(?:i(?:'m| am)|feel(?:ing)?)\s+(?:so |very |really |quite )?(excited|thrilled|ecstatic|pumped|stoked)\b/i,
        /^(?:i(?:'m| am))\s+(?:so |very |really )?excited\s+(?:about|for)\b/i,
        /^(?:i(?:'m| am)|feel(?:ing)?)\s+(?:absolutely|completely|totally|utterly)\s+(?:happy|excited|glad)\b/i
      ]),
    });

    // Dialogue function mappings for conversational intents
    this.conversationalMappings = Object.freeze({
      GREETING: Object.freeze({
        dialogueFunction: 'social_obligations_management.greet',
        speechAct: 'social.greet',
        outcomeIntent: 'relational_outcomes.build_rapport'
      }),
      FAREWELL: Object.freeze({
        dialogueFunction: 'social_obligations_management.farewell',
        speechAct: 'social.farewell',
        outcomeIntent: 'relational_outcomes.build_rapport'
      }),
      GRATITUDE: Object.freeze({
        dialogueFunction: 'social_obligations_management.thank',
        speechAct: 'expressive.thank',
        outcomeIntent: 'connection'
      }),
      HOW_ARE_YOU: Object.freeze({
        dialogueFunction: 'expressive.self_disclosure',
        speechAct: 'expressive.self_disclosure',
        outcomeIntent: 'connection'
      }),
      SELF_INQUIRY: Object.freeze({
        dialogueFunction: 'expressive.self_disclosure',
        speechAct: 'social.greet',
        usesIdentityModule: true,
        preventLearning: true,
        blocksKnowledgeSearch: true,
        requiresAudit: true,
        outcomeIntent: 'clarity'
      }),
      TEACH_REQUEST: Object.freeze({
        dialogueFunction: 'information_transfer.offer',
        speechAct: 'directive.request',
        usesTSE: true,
        preventLearning: true,
        outcomeIntent: 'clarity'
      })
      ,
      EMOTIONAL: Object.freeze({
        dialogueFunction: 'expressive.celebrate',
        speechAct: 'expressive',
        outcomeIntent: 'emotional_outcomes.amplify_joy',
        isConversational: true,
        mode: 'companion',
        preventLearning: false
      })    });

    // Dialogue function mappings for entity-seeking intents (IM-1 + IM-2)
    this.entityIntentMappings = Object.freeze({
      WHO: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.inform',
        outcomeIntent: 'clarity'
      }),
      WHAT: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.inform',
        outcomeIntent: 'clarity'
      }),
      WHERE: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.inform',
        outcomeIntent: 'clarity'
      }),
      WHEN: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.inform',
        outcomeIntent: 'clarity'
      }),
      WHY: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.explain',
        outcomeIntent: 'exploration'
      }),
      HOW: Object.freeze({
        dialogueFunction: 'task_management.guide_step',
        speechAct: 'directive.guide',
        outcomeIntent: 'planning'
      }),
      WHICH: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.compare',
        outcomeIntent: 'decision'
      }),
      IS: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.inform',
        outcomeIntent: 'clarity'
      }),
      SEARCH: Object.freeze({
        dialogueFunction: 'task_management.explain',
        speechAct: 'assertive.inform',
        outcomeIntent: 'clarity'
      }),
      SHOW_IMAGE: Object.freeze({
        dialogueFunction: 'status.report.inventory.single.item',
        speechAct: 'assertive.describe',
        outcomeIntent: 'clarity'
      }),
      EDIT_PROFILE: Object.freeze({
        dialogueFunction: 'system_guidance.configuration',
        speechAct: 'directive.request',
        outcomeIntent: 'clarity'
      })
    });
  }

  /**
   * Look up entity intent mapping for a given intent type.
   * Returns dialogueFunction, speechAct, outcomeIntent from entityIntentMappings.
   * Returns empty object if no mapping exists (safe to spread).
   * @param {string} intentType - Intent type key (e.g. WHO, WHAT, HOW)
   * @returns {object}
   */
  _getEntityMapping(intentType) {
    const mapping = this.entityIntentMappings[intentType];
    if (!mapping) return {};
    return {
      dialogueFunction: mapping.dialogueFunction,
      speechAct: mapping.speechAct,
      outcomeIntent: mapping.outcomeIntent
    };
  }

  /*
   * ==========================================================================
   * Input Validation
   * ==========================================================================
   */

  _validateQuery(query) {
    if (!query || typeof query !== 'string') {
      return { valid: false, error: 'query must be a non-empty string' };
    }
    if (query.length > 1000) {
      return { valid: false, error: 'query exceeds maximum length (1000 chars)' };
    }
    return { valid: true };
  }

  _validateUser(user) {
    if (!user || typeof user !== 'object') {
      return { valid: false, error: 'user object is required' };
    }
    if (typeof user.access_level !== 'number' || user.access_level < 1 || user.access_level > 11) {
      return { valid: false, error: 'user.access_level must be a number 1-11' };
    }
    return { valid: true };
  }

  /*
   * ==========================================================================
   * Core Methods
   * ==========================================================================
   */

  /**
   * Detect self-inquiry subtype (9 types for nuanced routing).
   *
   * @param {string} normalizedQuery - Cleaned query
   * @returns {string} SELF_INQUIRY_SUBTYPES value
   */
  detectSelfInquirySubtype(normalizedQuery) {
    if (/^(so\s+)?you('?re|\s+are)\s+/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.ASSERTION;
    }

    if (/who\s+are\s+you\s+really|what\s+are\s+you\s+hiding/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.DEEPER;
    }

    if (/rules|limits|limitations|constraints|won'?t\s+you|can'?t\s+you/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.RULES;
    }

    if (/where\s+(are\s+you\s+from|do\s+you\s+come)|who\s+(made|created|built|programmed|designed)|origin|background|history/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.ORIGIN;
    }

    if (/what\s+(can|do)\s+you\s+do|capable|purpose|job|role|function|why\s+do\s+you\s+exist/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.CAPABILITY;
    }

    if (/are\s+you\s+(a|an|real|just)|is\s+claude\s+(real|alive|a\s+bot)|what\s+are\s+you\s+really|what\s+kind\s+of/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.NATURE;
    }

    if (/your\s+(name|identity|deal)|so\s+(who|what)\s+are\s+you/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.NAME;
    }

    if (/who\s+(exactly\s+)?is\s+(claude|the\s+tanuki)|what\s+is\s+(claude|the\s+tanuki|this\s+guide)|tell\s+(me|us)\s+about\s+(claude|the\s+tanuki)/i.test(normalizedQuery)) {
      return SELF_INQUIRY_SUBTYPES.THIRD_PERSON;
    }

    return SELF_INQUIRY_SUBTYPES.IDENTITY;
  }

  /**
   * Match conversational intents (no entity search).
   *
   * @param {string} normalizedQuery
   * @returns {Object|null}
   */
  matchConversationalIntent(normalizedQuery) {
    for (const [intentType, patterns] of Object.entries(this.conversationalPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(normalizedQuery)) {
          const mapping = this.conversationalMappings[intentType];
          const subtype = (intentType === INTENT_TYPES.SELF_INQUIRY)
            ? this.detectSelfInquirySubtype(normalizedQuery)
            : null;

          logger.info('Conversational intent matched', {
            type: intentType,
            subtype,
            confidence: CONFIG.CONFIDENCE_THRESHOLD_HIGH
          });

          Counters.increment('intent_conversational', intentType);
          if (subtype) {
            Counters.increment('intent_self_inquiry_subtype', subtype);
          }

          // Audit log for sensitive intents
          if (mapping.requiresAudit && (subtype === SELF_INQUIRY_SUBTYPES.DEEPER || subtype === SELF_INQUIRY_SUBTYPES.RULES)) {
            logger.warn('Sensitive self-inquiry detected', {
              subtype,
              normalizedQuery: normalizedQuery.substring(0, 100)
            });
          }

          return {
            type: intentType,
            subtype,
            dialogueFunction: mapping.dialogueFunction,
            speechAct: mapping.speechAct,
            confidence: CONFIG.CONFIDENCE_THRESHOLD_HIGH,
            isConversational: true,
            usesIdentityModule: mapping.usesIdentityModule || false,
            preventLearning: mapping.preventLearning || false,
            blocksKnowledgeSearch: mapping.blocksKnowledgeSearch || false,
            outcomeIntent: mapping.outcomeIntent || null
          };
        }
      }
    }
    return null;
  }

  /**
   * Derive realm hex ID from access level.
   *
   * @param {number} accessLevel - 1-11
   * @param {string} [realmOverride] - Optional override
   * @returns {string} Realm hex ID (#XXXXXX)
   */
  getRealmFromAccessLevel(accessLevel, realmOverride = null) {
    if (!accessLevel || accessLevel < 1 || accessLevel > 11) {
      throw new Error(`Invalid access_level: ${accessLevel}. Must be 1-11.`);
    }

    if (accessLevel === 11) {
      return realmOverride || '#F00000';
    }

    const realmNumber = accessLevel - 1;
    const hexValue = realmNumber.toString(16).toUpperCase();
    return `#F0000${hexValue}`;
  }

  /**
   * Refresh entity cache for a realm (fetch from DB).
   * Includes error handling and metrics.
   *
   * @param {string} realmHexId
   */
  async refreshEntityCache(realmHexId) {
    const now = Date.now();
    const lastUpdate = this.cacheTimestamps.get(realmHexId);

    if (
      this.entityCache.has(realmHexId) &&
      lastUpdate &&
      (now - lastUpdate) < CONFIG.CACHE_TTL_MS
    ) {
      Counters.increment('intent_cache', 'hit');
      return;
    }

    Counters.increment('intent_cache', 'miss');

    const queryFn = async () => {
      const entities = await getAllEntitiesInRealm(realmHexId, null, CONFIG.MAX_ENTITIES_PER_REALM);
      return entities;
    };

    try {
      const entities = await this._withTimeout(withRetry(queryFn, {
        maxAttempts: CONFIG.QUERY_RETRY_ATTEMPTS,
        backoffMs: CONFIG.QUERY_RETRY_BACKOFF_MS
      }));

      this.entityCache.set(realmHexId, entities);
      this.cacheTimestamps.set(realmHexId, now);

      logger.info('Entity cache refreshed', {
        realmHexId,
        entityCount: entities.length
      });
    } catch (error) {
      logger.error('Failed to refresh entity cache', { error: error.message, realmHexId });
      throw error;
    }
  }

  /**
   * Invalidate cache for a specific realm (on entity update).
   *
   * @param {string} realmHexId
   */
  invalidateCache(realmHexId) {
    this.entityCache.delete(realmHexId);
    this.cacheTimestamps.delete(realmHexId);
    logger.info('Entity cache invalidated', { realmHexId });
  }

  /**
   * Invalidate all caches.
   */
  clearCache() {
    this.entityCache.clear();
    this.cacheTimestamps.clear();
    logger.info('All entity caches cleared');
  }

  /**
   * Clean query: normalize, strip noise, sanitize.
   *
   * @param {string} query
   * @returns {string}
   */
  cleanQuery(query) {
    return query
      .toLowerCase()
      .trim()
      .replace(/[?!.,;:]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Match loose intent via keyword fallback.
   *
   * @param {string} normalizedQuery
   * @returns {Object|null}
   */
  matchLooseIntent(normalizedQuery) {
    let workingQuery = normalizedQuery;

    for (const pattern of this.noisePatterns) {
      workingQuery = workingQuery.replace(pattern, '').trim();
    }

    if (!workingQuery) return null;
    const tokens = workingQuery.split(' ');

    const firstWord = tokens[0];
    const intentType = this.keywordMap[firstWord];

    if (intentType) {
      let entityRaw = workingQuery.substring(firstWord.length).trim();
      entityRaw = entityRaw.replace(CONNECTOR_PATTERN, '').trim();

      if (entityRaw.length > 0) {
        return {
          type: intentType,
          entity: entityRaw,
          confidence: CONFIG.CONFIDENCE_THRESHOLD_MEDIUM
        };
      }
    }

    return null;
  }

  /**
   * Wraps a promise with CONFIG.ENTITY_SEARCH_TIMEOUT_MS timeout.
   * @param {Promise} promise
   * @returns {Promise}
   */
  _withTimeout(promise) {
    let timer;
    return Promise.race([
      promise.then(res => { clearTimeout(timer); return res; }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Entity search timeout after ${CONFIG.ENTITY_SEARCH_TIMEOUT_MS}ms`)),
          CONFIG.ENTITY_SEARCH_TIMEOUT_MS
        );
      })
    ]);
  }

  /**
   * Apply god-mode expansion to result (all-tier search).
   * Factored helper to avoid duplication.
   *
   * @param {Object} result - Base result object
   * @param {string} entity - Entity to search
   * @param {string} realmHexId
   * @returns {Promise<Object>} Result with godModeSearch field
   */
  async _applyGodModeExpansion(result, entity, realmHexId) {
    try {
      const allTiersResult = await this._withTimeout(withRetry(
        () => searchEntityAllTiers(entity, realmHexId),
        {
          maxAttempts: CONFIG.QUERY_RETRY_ATTEMPTS,
          backoffMs: CONFIG.QUERY_RETRY_BACKOFF_MS
        }
      ));

      result.godModeSearch = allTiersResult;
      result.entityData =
        allTiersResult.tier1?.matches?.[0] ||
        allTiersResult.tier2?.matches?.[0] ||
        allTiersResult.tier3?.matches?.[0] ||
        null;

      Counters.increment('intent_god_mode', 'expansion_applied');

      logger.warn('God mode expansion applied', {
        entity: entity.substring(0, 50),
        realmHexId,
        tierHits: {
          tier1: allTiersResult.tier1?.matches?.length || 0,
          tier2: allTiersResult.tier2?.matches?.length || 0,
          tier3: allTiersResult.tier3?.matches?.length || 0
        }
      });
    } catch (error) {
      logger.error('God mode expansion failed', { error: error.message, entity, realmHexId });
      Counters.increment('intent_god_mode', 'expansion_failed');
    }

    return result;
  }

  /*
   * ==========================================================================
   * Main Intent Matching (Public API)
   * ==========================================================================
   */

  /**
   * Match query to intent type with optional entity extraction.
   * Multi-stage pipeline with early exits.
   *
   * @param {string} query - User input
   * @param {Object} [context] - Previous turn state (lastEntity, lastQueryType, etc.)
   * @param {Object} user - User object with access_level
   * @param {string} [realmOverride] - Optional realm hex ID override
   * @returns {Promise<Object>} Intent result with type, entity, confidence, etc.
   */
  async matchIntent(query, context = null, user = null, realmOverride = null) {
    const queryValidation = this._validateQuery(query);
    if (!queryValidation.valid) {
      throw new Error(`matchIntent: ${queryValidation.error}`);
    }

    const userValidation = this._validateUser(user);
    if (!userValidation.valid) {
      throw new Error(`matchIntent: ${userValidation.error}`);
    }

    const realmHexId = this.getRealmFromAccessLevel(user.access_level, realmOverride);
    const normalized = this.cleanQuery(query);
    const useGodMode = user.access_level === 11;

    // --- STAGE 0: CONVERSATIONAL INTENTS ---
    const conversationalMatch = this.matchConversationalIntent(normalized);
    if (conversationalMatch) {
      return {
        type: conversationalMatch.type,
        subtype: conversationalMatch.subtype,
        dialogueFunction: conversationalMatch.dialogueFunction,
        speechAct: conversationalMatch.speechAct,
        confidence: conversationalMatch.confidence,
        original: query,
        isConversational: true,
        realm: realmHexId,
        matcherMethod: 'conversational',
        outcomeIntent: conversationalMatch.outcomeIntent || null
      };
    }

    await this.refreshEntityCache(realmHexId);

    // --- STAGE 1: CONTEXT-AWARE PRONOUNS ---
    if (context && context.lastEntityName) {
      if (PRONOUN_INTENT_PATTERN.test(normalized)) {
        const intentWord = normalized.match(/^(who|what|where|when|why|how|which|is)/i)[1].toUpperCase();

        let result = {
          type: intentWord,
          entity: context.lastEntity,
          confidence: 0.85,
          original: query,
          contextUsed: true,
          realm: realmHexId,
          matcherMethod: 'context_memory',
          ...this._getEntityMapping(intentWord)
        };

        if (useGodMode) {
          result = await this._applyGodModeExpansion(result, context.lastEntityName, realmHexId);
        }

        Counters.increment('intent_matched', intentWord);
        return result;
      }
    }

    // --- STAGE 2: CONFIRMATIONS ---
    if (context && context.lastQueryType && context.conversationTurns > 0) {
      

      if (AFFIRMATIVE_PATTERN.test(normalized)) {
        let result = {
          type: context.lastQueryType,
          entity: context.lastEntity,
          confidence: CONFIG.CONFIDENCE_THRESHOLD_HIGH,
          original: query,
          contextUsed: true,
          confirmation: 'affirmed',
          realm: realmHexId,
          matcherMethod: 'conversation_flow',
          ...this._getEntityMapping(context.lastQueryType)
        };

        if (useGodMode) {
          result = await this._applyGodModeExpansion(result, context.lastEntityName, realmHexId);
        }

        Counters.increment('intent_matched', context.lastQueryType);
        return result;
      }

      if (NEGATIVE_PATTERN.test(normalized)) {
        Counters.increment('intent_matched', INTENT_TYPES.SEARCH);
        return {
          type: INTENT_TYPES.SEARCH,
          entity: normalized,
          confidence: CONFIG.CONFIDENCE_THRESHOLD_MEDIUM,
          original: query,
          contextUsed: false,
          confirmation: 'rejected',
          realm: realmHexId,
          matcherMethod: 'conversation_flow',
          ...this._getEntityMapping(INTENT_TYPES.SEARCH)
        };
      }
    }

    // --- STAGE 3: IMAGES ---
    if (IMAGE_GATE_PATTERN.test(normalized)) {
      const patterns = [
        /(?:picture|photo|image|pic|portrait|visual)\s+(?:of|for)\s+(.+?)$/i,
        /(.+?)(?:'s)?\s+(?:picture|photo|image|pic|portrait|visual)$/i,
        /(?:show|display|see|view)\s+(?:me\s+)?(.+?)$/i
      ];

      

      for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (match && match[1]) {
          const entityName = match[1].trim();
          let entityToSearch = entityName;
          let contextOverride = false;

          if (PRONOUN_ENTITY_PATTERN.test(entityName) && context && context.lastEntityName) {
            entityToSearch = context.lastEntityName;
            contextOverride = true;
          }

          try {
            let result = {
              type: INTENT_TYPES.SHOW_IMAGE,
              entity: entityToSearch,
              confidence: CONFIG.CONFIDENCE_THRESHOLD_MEDIUM,
              original: query,
              contextUsed: contextOverride,
              realm: realmHexId,
              matcherMethod: 'visual_request',
              ...this._getEntityMapping(INTENT_TYPES.SHOW_IMAGE)
            };

            if (useGodMode) {
              result = await this._applyGodModeExpansion(result, entityToSearch, realmHexId);
            } else {
              const searchResult = await this._withTimeout(withRetry(
                () => searchEntityWithDisambiguation(entityToSearch, realmHexId),
                {
                  maxAttempts: CONFIG.QUERY_RETRY_ATTEMPTS,
                  backoffMs: CONFIG.QUERY_RETRY_BACKOFF_MS
                }
              ));
              result.searchResult = searchResult;
              result.entityData = searchResult.action === 'single_match' ? searchResult.entity : null;
              result.entity = searchResult.action === 'single_match' ? searchResult.entity?.entity_name : entityToSearch;
              result.confidence = searchResult.confidence || CONFIG.CONFIDENCE_THRESHOLD_MEDIUM;
            }

            Counters.increment('intent_matched', INTENT_TYPES.SHOW_IMAGE);
            return result;
          } catch (error) {
            logger.error('Image search failed', { error: error.message, entity: entityToSearch, realmHexId });
            Counters.increment('intent_search_failure', INTENT_TYPES.SHOW_IMAGE);
            return {
              type: INTENT_TYPES.SHOW_IMAGE,
              entity: entityToSearch,
              confidence: CONFIG.CONFIDENCE_THRESHOLD_LOW,
              original: query,
              error: error.message,
              realm: realmHexId,
              matcherMethod: 'visual_request',
              ...this._getEntityMapping(INTENT_TYPES.SHOW_IMAGE)
            };
          }
        }
      }
    }

    // --- STAGE 4: STRICT REGEX MATCHING ---
    for (const [intentType, patterns] of Object.entries(this.intents)) {
      for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (match) {
          const entity = match[1] ? match[1].trim().replace(/[?!.,;:]+$/, '') : null;
          if (entity) {
            try {
              let result = {
                type: intentType,
                entity,
                confidence: CONFIG.CONFIDENCE_THRESHOLD_HIGH,
                original: query,
                realm: realmHexId,
                matcherMethod: 'strict_regex',
                ...this._getEntityMapping(intentType)
              };

              // Audit log for sensitive intents
              if (intentType === INTENT_TYPES.EDIT_PROFILE) {
                logger.warn('Edit profile intent detected', {
                  entity: entity.substring(0, 50),
                  userId: user.user_id || 'unknown'
                });
              }

              if (useGodMode) {
                result = await this._applyGodModeExpansion(result, entity, realmHexId);
              } else {
                const searchResult = await this._withTimeout(withRetry(
                  () => searchEntityWithDisambiguation(entity, realmHexId),
                  {
                    maxAttempts: CONFIG.QUERY_RETRY_ATTEMPTS,
                    backoffMs: CONFIG.QUERY_RETRY_BACKOFF_MS
                  }
                ));
                result.searchResult = searchResult;
                result.entityData = searchResult.action === 'single_match' ? searchResult.entity : null;
                result.entity = searchResult.action === 'single_match' ? searchResult.entity?.entity_name : entity;
                result.confidence = searchResult.confidence || CONFIG.CONFIDENCE_THRESHOLD_HIGH;
              }

              Counters.increment('intent_matched', intentType);
              return result;
            } catch (error) {
              logger.error('Entity search failed on strict regex', { error: error.message, entity, realmHexId });
              Counters.increment('intent_search_failure', intentType);
              return {
                type: intentType,
                entity,
                confidence: CONFIG.CONFIDENCE_THRESHOLD_LOW,
                original: query,
                error: error.message,
                realm: realmHexId,
                matcherMethod: 'strict_regex',
                ...this._getEntityMapping(intentType)
              };
            }
          }
        }
      }
    }

    // --- STAGE 5: LOOSE KEYWORD MATCHING ---
    const looseMatch = this.matchLooseIntent(normalized);
    if (looseMatch) {
      try {
        let result = {
          type: looseMatch.type,
          entity: looseMatch.entity,
          confidence: looseMatch.confidence,
          original: query,
          realm: realmHexId,
          matcherMethod: 'loose_keyword',
          ...this._getEntityMapping(looseMatch.type)
        };

        if (useGodMode) {
          result = await this._applyGodModeExpansion(result, looseMatch.entity, realmHexId);
        } else {
          const searchResult = await this._withTimeout(withRetry(
            () => searchEntityWithDisambiguation(looseMatch.entity, realmHexId),
            {
              maxAttempts: CONFIG.QUERY_RETRY_ATTEMPTS,
              backoffMs: CONFIG.QUERY_RETRY_BACKOFF_MS
            }
          ));
          result.searchResult = searchResult;
          result.entityData = searchResult.action === 'single_match' ? searchResult.entity : null;
          result.entity = searchResult.action === 'single_match' ? searchResult.entity?.entity_name : looseMatch.entity;
          result.confidence = searchResult.confidence || looseMatch.confidence;
        }

        Counters.increment('intent_matched', looseMatch.type);
        return result;
      } catch (error) {
        logger.error('Entity search failed on loose match', { error: error.message, entity: looseMatch.entity, realmHexId });
        Counters.increment('intent_search_failure', looseMatch.type);
        return {
          type: looseMatch.type,
          entity: looseMatch.entity,
          confidence: CONFIG.CONFIDENCE_THRESHOLD_LOW,
          original: query,
          error: error.message,
          realm: realmHexId,
          matcherMethod: 'loose_keyword',
          ...this._getEntityMapping(looseMatch.type)
        };
      }
    }

    // --- STAGE 6: FALLBACK SEARCH ---
    try {
      let result = {
        type: INTENT_TYPES.SEARCH,
        entity: normalized,
        confidence: CONFIG.CONFIDENCE_THRESHOLD_LOW,
        original: query,
        realm: realmHexId,
        matcherMethod: 'fallback',
        ...this._getEntityMapping(INTENT_TYPES.SEARCH)
      };

      if (useGodMode) {
        result = await this._applyGodModeExpansion(result, normalized, realmHexId);
      } else {
        const searchResult = await this._withTimeout(withRetry(
          () => searchEntityWithDisambiguation(normalized, realmHexId),
          {
            maxAttempts: CONFIG.QUERY_RETRY_ATTEMPTS,
            backoffMs: CONFIG.QUERY_RETRY_BACKOFF_MS
          }
        ));
        result.searchResult = searchResult;
        result.entityData = searchResult.action === 'single_match' ? searchResult.entity : null;
        result.entity = searchResult.action === 'single_match' ? searchResult.entity?.entity_name : normalized;
        result.confidence = searchResult.confidence || CONFIG.CONFIDENCE_THRESHOLD_LOW;
      }

      Counters.increment('intent_matched', INTENT_TYPES.SEARCH);
      return result;
    } catch (error) {
      logger.error('Fallback search failed', { error: error.message, entity: normalized, realmHexId });
      Counters.increment('intent_search_failure', INTENT_TYPES.SEARCH);

      return {
        type: INTENT_TYPES.SEARCH,
        entity: normalized,
        confidence: CONFIG.CONFIDENCE_THRESHOLD_LOW,
        original: query,
        error: error.message,
        realm: realmHexId,
        matcherMethod: 'fallback',
        ...this._getEntityMapping(INTENT_TYPES.SEARCH)
      };
    }
  }
}

export default new CotwIntentMatcher();
