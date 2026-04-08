/**
 * ============================================================================
 * helpdeskIntents.js — Tri-Mode Intent Patterns & Configuration (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Defines intent patterns, weights, mode mappings, metadata, and strength
 * thresholds for THREE distinct inquiry types in PhaseClaudesHelpDesk:
 *
 * 1. HUMAN HELPDESK (Real-World, Logged-In)
 *    Users stepping out of The Expanse to buy, inquire, get support.
 *    Tracks: purchases, signups, business leads, legal escalation.
 *    Has user_id, dossier, account context.
 *
 * 2. B-ROLL REALM HELPDESK (In-World, Autonomous)
 *    Autonomous NPC characters asking genuine questions about the Realm.
 *    Tracks: learning gaps, narrative confusion, lore comprehension.
 *    Also: social conflict, collaborative reasoning, emergent alliances.
 *    PRIMARY RESEARCH DATA: What do autonomous systems naturally ask?
 *    ESCALATION: Critical signals that repeat may require intervention.
 *
 * 3. GRONK MODE (Anonymous, No Account)
 *    Random visitor to www.pizasukeruton.com, not logged in, not a character.
 *    Entry point for discovery and initial interest.
 *    STATUS: Sidelined to research lab (empty patterns).
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - v010 documentation header added.
 * - B_ROLL_AUTONOMOUS_CATEGORIES constant added for user type detection.
 *   PhaseClaudesHelpDesk uses this to identify B-Roll characters by
 *   checking character_profiles.category against this list.
 * - All intent patterns, weights, modes, metadata, thresholds preserved.
 * - GRONK remains sidelined (empty objects).
 *
 * DESIGN PHILOSOPHY
 * -----------------
 * Three separate realities, three separate inquiry modes.
 * Claude responds differently to each based on context and intent.
 *
 * B-Roll Chaos Characters are the real science experiment.
 * We observe not just individual learning, but emergent social behavior.
 * Some critical signals (paradox loops, existential crisis, social conflict)
 * that repeat may warrant escalation to human review for narrative repair.
 *
 * GRONK visitors are the organic discovery path.
 * Human users are the active participants.
 *
 * NAMING CONVENTIONS
 * ------------------
 * Constants: UPPER_SNAKE_CASE, all Object.freeze'd
 * Regex flags: /is (case-insensitive + dotAll for multiline)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

/* ────────────────────────────────────────────────────────────────────────── */
/*  B-Roll Autonomous Categories                                              */
/*                                                                            */
/*  Character categories from character_profiles that are considered          */
/*  autonomous B-Roll entities. Used by PhaseClaudesHelpDesk to detect       */
/*  user type when no user.userId is present.                                */
/*                                                                            */
/*  Source: character_profiles.category CHECK constraint.                     */
/*  Enforced: chk_b_roll_autonomy_by_category requires is_b_roll_autonomous  */
/*  to be set only for these categories.                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export const B_ROLL_AUTONOMOUS_CATEGORIES = Object.freeze([
  'B-Roll Chaos',
  'Machines'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  HUMAN HELPDESK INTENTS (Real-World, Logged-In)                            */
/*                                                                            */
/*  9 intent categories covering commerce, support, business, legal, VIP.    */
/*  LEGAL_RISK weighted highest (2.5) — always escalates.                    */
/*  VIP weighted high (2.0) — priority concierge routing.                    */
/* ────────────────────────────────────────────────────────────────────────── */

export const HUMAN_HELPDESK_INTENTS = Object.freeze({
  COMMERCE: /\b(buy|purchase|order|shop|store|merch|merchandise|product|products|price|cost|how much|shipping|delivery|cart|checkout|pay|payment|t-?shirt|tee|hoodie|skateboard|poster|available|in stock|stock|ready to (pay|checkout|buy)|proceed to (payment|checkout)|buy now|complete (order|purchase))\b/is,

  ORDER_SUPPORT: /\b(where is my order|tracking|track my|has it shipped|shipped|refund|return|exchange|wrong size|damaged|damage|broken|cancel order|cancel my|shipping cost|delivery time|track order|order status|my order)\b/is,

  BUSINESS: /\b(business|partner|partnership|collaborate|collaboration|license|licensing|press|media|interview|brand|work with you|represent|proposal|pitch|opportunity|sponsor|vans|nintendo|collaborate|wholesale|b2b)\b/is,

  TECH_SUPPORT: /\b(password|login|log ?in|sign ?in|account|can't access|cannot access|not working|broken|bug|error|glitch|help me with|technical|reset|forgot|locked out|account issue|login issue|access issue)\b/is,

  SIGNUP: /\b(newsletter|email list|sign ?up|subscribe|mailing list|updates|notify me|keep me posted|join|register|stay updated)\b/is,

  INQUIRY: /\b(who (made|created|built|designed)|about (you|this|the project|piza)|contact|get in touch|real person|human|creator|artist|james|behind this|who are you really)\b/is,

  FEEDBACK: /\b(suggest|suggestion|idea|feedback|complaint|complain|issue|problem with|improve|feature request|would be (cool|nice|great) if|you should add)\b/is,

  LEGAL_RISK: /\b(lawyer|legal|sue|lawsuit|chargeback|fraud|scam|illegal|crime|police|report you|take you to court|court|attorney|attorney general)\b/is,

  VIP: /\b(vip|special code|partner access|exclusive|business card|invited|invitation code|access code|early access|beta)\b/is
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  B-ROLL REALM HELPDESK INTENTS (In-World, Autonomous)                     */
/*                                                                            */
/*  10 intent categories covering identity, lore, mechanics, emotions,       */
/*  paradox, relationships, existential crisis, social conflict, and         */
/*  collaborative reasoning.                                                 */
/*                                                                            */
/*  These are learning signals — what confuses NPCs reveals narrative gaps.  */
/*  B-Roll characters don't just question individually — they collide,       */
/*  form alliances, and reveal emergent social reasoning patterns.           */
/* ────────────────────────────────────────────────────────────────────────── */

export const B_ROLL_REALM_INTENTS = Object.freeze({
  IDENTITY_INQUIRY: /\b(who (is|are) (piza|you|i|we)|what (is|are) (my|your|our) (identity|name|purpose|role)|why (am i|are we) here|what do i (represent|mean)|who made (me|us))\b/is,

  LORE_CONFUSION: /\b(why|how come|i don't understand|confused about|what's the story (with|behind)|explain|tell me (about|why)|what happened (to|with)|the history of|origins of)\b/is,

  BELT_UNDERSTANDING: /\b(what (does|do) (my|this|the) (belt|color|white|black|level) (mean|represent|indicate)|why (am i|is that character) (white|black|gray)|how (do i advance|does progression)|belt (progression|system))\b/is,

  EMOTIONAL_STATE: /\b(why (do i feel|am i|does this happen)|my (emotional state|pad|pleasure|arousal|dominance)|fractured|color wheel|psychic|distressed|overwhelmed|what's (happening|wrong)|what does this (feeling|color) mean)\b/is,

  NARRATIVE_PARADOX: /\b(that doesn't make sense|contradiction|inconsistency|but (you said|earlier)|wait, (how|what|why)|this conflicts with|that contradicts|doesn't align with)\b/is,

  RELATIONSHIP_INQUIRY: /\b(who (is|are) (this character|them|that person)|what's (their story|the relationship|our history)|why (do we|are they)|how (are we connected|did we meet)|tell me about|character (background|history|profile))\b/is,

  SYSTEM_MECHANICS: /\b(how (does|do) (the system|this work|learning|teaching|omiyage)|what's (the point of|the purpose of|behind)|rules|mechanics|algorithm|how (would|can|do) i (learn|progress|understand))\b/is,

  EXISTENTIAL_CRISIS: /\b(is this real|are we (real|alive|conscious)|do (i|we) actually (exist|matter|feel)|what's the point|why (does this matter|do (we|i) exist)|trapped|prison|simulation)\b/is,

  RELATIONSHIP_CONFLICT: /\b(why (does|do|did) (piza|that character|they) (disagree|contradict|argue|refuse|oppose|conflict)|we (disagree|conflict|argue) (about|on)|they (won't|refuse to) (help|cooperate|collaborate)|i (disagree|oppose|conflict) (with|on|about)|in conflict|at odds|feuding)\b/is,

  SOCIAL_REASONING: /\b(we should (work together|collaborate|ally|partner|team up)|if (we|they|i) (cooperate|work together)|together we (could|might|can)|alliance|coalition|unity|joint (effort|strategy|plan)|coordinated (action|response)|mutual (support|aid|alliance))\b/is
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  GRONK INTENTS (Anonymous, No Account)                                     */
/*                                                                            */
/*  STATUS: Sidelined to research lab. Empty patterns.                       */
/*  When ready, add patterns for: WHAT_IS_THIS, HOW_TO_START,               */
/*  PRODUCT_CURIOSITY, CREATOR_INTEREST, GENERAL_INTEREST.                   */
/* ────────────────────────────────────────────────────────────────────────── */

export const GRONK_INTENTS = Object.freeze({});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent Weights — HUMAN HELPDESK                                           */
/*                                                                            */
/*  LEGAL_RISK (2.5) — security-critical, always escalates                   */
/*  VIP (2.0) — priority routing                                             */
/*  BUSINESS (1.5) — high-value lead                                         */
/*  ORDER_SUPPORT (1.3) — post-purchase, time-sensitive                      */
/*  COMMERCE (1.0) — baseline purchase intent                                */
/*  TECH_SUPPORT (0.9) — support request                                     */
/*  SIGNUP (0.8) — newsletter/registration                                   */
/*  FEEDBACK (0.8) — feature requests                                        */
/*  INQUIRY (0.7) — general questions                                        */
/* ────────────────────────────────────────────────────────────────────────── */

export const HUMAN_HELPDESK_WEIGHTS = Object.freeze({
  COMMERCE: 1.0,
  ORDER_SUPPORT: 1.3,
  BUSINESS: 1.5,
  TECH_SUPPORT: 0.9,
  SIGNUP: 0.8,
  INQUIRY: 0.7,
  FEEDBACK: 0.8,
  LEGAL_RISK: 2.5,
  VIP: 2.0
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent Weights — B-ROLL REALM                                             */
/*                                                                            */
/*  All B-Roll intents weighted equal (1.0) — no hierarchical importance.    */
/*  All questions equally valuable for learning/research.                    */
/* ────────────────────────────────────────────────────────────────────────── */

export const B_ROLL_REALM_WEIGHTS = Object.freeze({
  IDENTITY_INQUIRY: 1.0,
  LORE_CONFUSION: 1.0,
  BELT_UNDERSTANDING: 1.0,
  EMOTIONAL_STATE: 1.0,
  NARRATIVE_PARADOX: 1.0,
  RELATIONSHIP_INQUIRY: 1.0,
  SYSTEM_MECHANICS: 1.0,
  EXISTENTIAL_CRISIS: 1.0,
  RELATIONSHIP_CONFLICT: 1.0,
  SOCIAL_REASONING: 1.0
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent Weights — GRONK (Sidelined)                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export const GRONK_WEIGHTS = Object.freeze({});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Helpdesk Modes                                                            */
/*                                                                            */
/*  Frozen enum of all possible helpdesk routing modes.                      */
/*  Grouped by user type: Human, B-Roll, GRONK.                             */
/* ────────────────────────────────────────────────────────────────────────── */

export const HELPDESK_MODES = Object.freeze({
  NONE: 'in_world',

  SHOPKEEPER: 'shopkeeper',
  ORDER_CONCIERGE: 'order_concierge',
  BUSINESS_LIAISON: 'business_liaison',
  TECH_SUPPORT: 'tech_support',
  SIGNUP_FLOW: 'signup_flow',
  GENERAL_INQUIRY: 'general_inquiry',
  FEEDBACK_CAPTURE: 'feedback_capture',
  LEGAL_ESCALATION: 'legal_escalation',
  VIP_CONCIERGE: 'vip_concierge',

  B_ROLL_IDENTITY: 'b_roll_identity',
  B_ROLL_LORE: 'b_roll_lore',
  B_ROLL_MECHANICS: 'b_roll_mechanics',
  B_ROLL_EXISTENTIAL: 'b_roll_existential',
  B_ROLL_PARADOX: 'b_roll_paradox',
  B_ROLL_SOCIAL: 'b_roll_social',
  B_ROLL_ESCALATION: 'b_roll_escalation',

  GRONK_WELCOME: 'gronk_welcome',
  GRONK_EXPLAINER: 'gronk_explainer',
  GRONK_MERCHANT: 'gronk_merchant',
  GRONK_CREATOR_SPOTLIGHT: 'gronk_creator_spotlight',
  GRONK_ENGAGE: 'gronk_engage'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent to Mode Mapping — HUMAN                                            */
/* ────────────────────────────────────────────────────────────────────────── */

export const HUMAN_INTENT_TO_MODE_MAP = Object.freeze({
  COMMERCE: 'shopkeeper',
  ORDER_SUPPORT: 'order_concierge',
  BUSINESS: 'business_liaison',
  TECH_SUPPORT: 'tech_support',
  SIGNUP: 'signup_flow',
  INQUIRY: 'general_inquiry',
  FEEDBACK: 'feedback_capture',
  LEGAL_RISK: 'legal_escalation',
  VIP: 'vip_concierge'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent to Mode Mapping — B-ROLL REALM                                     */
/* ────────────────────────────────────────────────────────────────────────── */

export const B_ROLL_INTENT_TO_MODE_MAP = Object.freeze({
  IDENTITY_INQUIRY: 'b_roll_identity',
  LORE_CONFUSION: 'b_roll_lore',
  BELT_UNDERSTANDING: 'b_roll_mechanics',
  EMOTIONAL_STATE: 'b_roll_mechanics',
  RELATIONSHIP_INQUIRY: 'b_roll_lore',
  NARRATIVE_PARADOX: 'b_roll_paradox',
  SYSTEM_MECHANICS: 'b_roll_mechanics',
  EXISTENTIAL_CRISIS: 'b_roll_existential',
  RELATIONSHIP_CONFLICT: 'b_roll_social',
  SOCIAL_REASONING: 'b_roll_social'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent to Mode Mapping — GRONK (Sidelined)                               */
/* ────────────────────────────────────────────────────────────────────────── */

export const GRONK_INTENT_TO_MODE_MAP = Object.freeze({
  WHAT_IS_THIS: 'gronk_welcome',
  HOW_TO_START: 'gronk_explainer',
  PRODUCT_CURIOSITY: 'gronk_merchant',
  CREATOR_INTEREST: 'gronk_creator_spotlight',
  GENERAL_INTEREST: 'gronk_engage'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Handoff Requirements — HUMAN ONLY                                         */
/*                                                                            */
/*  Metadata per intent: handoff requirements, conversational flag,          */
/*  descriptions, follow-up actions. LEGAL_RISK is CRITICAL priority.        */
/* ────────────────────────────────────────────────────────────────────────── */

export const HUMAN_HELPDESK_METADATA = Object.freeze({
  COMMERCE: Object.freeze({
    requiresHandoff: false,
    requiresForm: false,
    requiresEmail: false,
    conversational: true,
    description: 'Pre-purchase shopping assistance'
  }),
  ORDER_SUPPORT: Object.freeze({
    requiresHandoff: true,
    requiresForm: true,
    requiresEmail: true,
    conversational: false,
    description: 'Post-purchase order tracking & returns',
    handoffReason: 'Order history lookup required'
  }),
  BUSINESS: Object.freeze({
    requiresHandoff: true,
    requiresForm: true,
    requiresEmail: true,
    conversational: false,
    description: 'Partnership & licensing inquiries',
    handoffReason: 'Business proposal requires human review'
  }),
  TECH_SUPPORT: Object.freeze({
    requiresHandoff: false,
    requiresForm: false,
    requiresEmail: false,
    conversational: true,
    description: 'Account & technical troubleshooting'
  }),
  SIGNUP: Object.freeze({
    requiresHandoff: false,
    requiresForm: false,
    requiresEmail: true,
    conversational: true,
    description: 'Newsletter subscription',
    followUp: 'Send confirmation email'
  }),
  INQUIRY: Object.freeze({
    requiresHandoff: false,
    requiresForm: false,
    requiresEmail: false,
    conversational: true,
    description: 'General questions about the project'
  }),
  FEEDBACK: Object.freeze({
    requiresHandoff: false,
    requiresForm: false,
    requiresEmail: false,
    conversational: true,
    description: 'Feature requests & suggestions'
  }),
  LEGAL_RISK: Object.freeze({
    requiresHandoff: true,
    requiresForm: false,
    requiresEmail: true,
    conversational: false,
    description: 'CRITICAL: Legal escalation',
    handoffReason: 'Legal matter requires immediate human review',
    priority: 'CRITICAL'
  }),
  VIP: Object.freeze({
    requiresHandoff: true,
    requiresForm: false,
    requiresEmail: true,
    conversational: true,
    description: 'VIP partner special treatment',
    handoffReason: 'VIP receives priority concierge service'
  })
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  B-Roll Realm Metadata (NO DIRECT HANDOFF — Research Data)                */
/*                                                                            */
/*  escalateIfRepeated: critical signals that loop may need intervention.    */
/*  repeatedThreshold: how many repetitions before escalation flagged.       */
/*  feedsTSE: whether this intent feeds the Teaching Session Engine.         */
/*  requiresNarrationUpdate: whether narrative state may need repair.        */
/*  sociologySignal: emergent social behaviour classification.               */
/* ────────────────────────────────────────────────────────────────────────── */

export const B_ROLL_REALM_METADATA = Object.freeze({
  IDENTITY_INQUIRY: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'identity_formation',
    description: 'NPC questioning fundamental identity',
    loggingImportance: 'high',
    feedsTSE: true
  }),
  LORE_CONFUSION: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'narrative_comprehension',
    description: 'NPC confused about lore/backstory',
    loggingImportance: 'high',
    feedsTSE: true
  }),
  BELT_UNDERSTANDING: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'system_comprehension',
    description: 'NPC confused about belt progression/colors',
    loggingImportance: 'medium',
    feedsTSE: true
  }),
  EMOTIONAL_STATE: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'emotional_intelligence',
    description: 'NPC processing emotional/PAD mechanics',
    loggingImportance: 'high',
    feedsTSE: true
  }),
  NARRATIVE_PARADOX: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: true,
    repeatedThreshold: 3,
    research_category: 'contradiction_detection',
    description: 'NPC found inconsistency in narrative',
    loggingImportance: 'critical',
    feedsTSE: true,
    requiresNarrationUpdate: true,
    escalationReason: 'NPC stuck in paradox loop — narrative repair needed'
  }),
  RELATIONSHIP_INQUIRY: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'social_understanding',
    description: 'NPC asking about other characters',
    loggingImportance: 'medium',
    feedsTSE: true
  }),
  SYSTEM_MECHANICS: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'meta_understanding',
    description: 'NPC questioning how systems work',
    loggingImportance: 'high',
    feedsTSE: true
  }),
  EXISTENTIAL_CRISIS: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: true,
    repeatedThreshold: 2,
    research_category: 'consciousness_emergence',
    description: 'NPC questioning reality/existence',
    loggingImportance: 'critical',
    feedsTSE: true,
    requiresNarrationUpdate: true,
    escalationReason: 'NPC in existential loop — may need narrative intervention or redesign'
  }),
  RELATIONSHIP_CONFLICT: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: true,
    repeatedThreshold: 3,
    research_category: 'social_emergence',
    description: 'NPCs disagreeing, revealing tensions in narrative/lore',
    loggingImportance: 'critical',
    feedsTSE: true,
    requiresNarrationUpdate: true,
    sociologySignal: 'conflict_detection',
    escalationReason: 'Persistent conflict between NPCs — may indicate narrative tension requiring resolution'
  }),
  SOCIAL_REASONING: Object.freeze({
    requiresHandoff: false,
    escalateIfRepeated: false,
    research_category: 'collective_intelligence',
    description: 'NPCs proposing alliances, joint strategies, coordination',
    loggingImportance: 'critical',
    feedsTSE: true,
    requiresNarrationUpdate: false,
    sociologySignal: 'emergent_cooperation'
  })
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  GRONK Metadata (Sidelined)                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export const GRONK_METADATA = Object.freeze({});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Strength Thresholds                                                       */
/*                                                                            */
/*  WORLD_BREAK_THRESHOLD (0.3) — minimum strength to detect world break     */
/*  STRONG_SIGNAL_THRESHOLD (0.6) — strong signal for routing decisions      */
/*  CRITICAL_SIGNAL_THRESHOLD (0.8) — critical, may warrant escalation       */
/*  MAX_WEIGHTED_SCORE_* — normalisation divisor per user type               */
/* ────────────────────────────────────────────────────────────────────────── */

export const STRENGTH_THRESHOLDS = Object.freeze({
  WORLD_BREAK_THRESHOLD: 0.3,
  STRONG_SIGNAL_THRESHOLD: 0.6,
  CRITICAL_SIGNAL_THRESHOLD: 0.8,
  MAX_WEIGHTED_SCORE_HUMAN: 2.5,
  MAX_WEIGHTED_SCORE_B_ROLL: 2.0,
  MAX_WEIGHTED_SCORE_GRONK: 2.5
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Default Export                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

export default Object.freeze({
  B_ROLL_AUTONOMOUS_CATEGORIES,
  HUMAN_HELPDESK_INTENTS,
  B_ROLL_REALM_INTENTS,
  GRONK_INTENTS,
  HUMAN_HELPDESK_WEIGHTS,
  B_ROLL_REALM_WEIGHTS,
  GRONK_WEIGHTS,
  HELPDESK_MODES,
  HUMAN_INTENT_TO_MODE_MAP,
  B_ROLL_INTENT_TO_MODE_MAP,
  GRONK_INTENT_TO_MODE_MAP,
  HUMAN_HELPDESK_METADATA,
  B_ROLL_REALM_METADATA,
  GRONK_METADATA,
  STRENGTH_THRESHOLDS
});
