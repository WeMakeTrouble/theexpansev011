TASK LIST — cotwIntentMatcher.js Audit
Thread Date: March 21, 2026
Status: AUDIT COMPLETE — Tasks pending implementation
Audited by: Claude (line-by-line) + Kimi (independent review, 86/100)
File: backend/councilTerminal/cotwIntentMatcher.js (1063 lines)

CORE FINDING
Only Stage 0 (6 conversational patterns) returns dialogueFunction and
speechAct. Stages 1-6 (entity-seeking, pronouns, confirmations, images,
strict regex, loose keyword, fallback) return null for both fields.
No stage returns outcomeIntent at all.

This means the LTLM selector is ONLY invoked for greetings, farewells,
gratitude, how-are-you, self-inquiry, and teach-request. Every other
user input — questions, searches, image requests, confirmations — gets
zero LTLM involvement because PhaseVoice line 630 requires dialogueFunction.

AGREED FINDINGS AND TASKS

TASK IM-1: Add entityIntentMappings for all entity-seeking intents
Priority: CRITICAL
Problem: Stages 1-6 return no dialogueFunction or speechAct. PhaseVoice
line 630 requires dialogueFunction to trigger LTLM lookup. All entity-seeking
intents (WHO, WHAT, WHERE, WHEN, WHY, HOW, WHICH, IS, SEARCH, SHOW_IMAGE,
EDIT_PROFILE) produce null dialogueFunction, blocking LTLM conversational
framing for knowledge responses.
Fix: Add entityIntentMappings object (like conversationalMappings) that
maps each entity-seeking intent type to appropriate dialogueFunction,
speechAct, and outcomeIntent values. Apply mapping in Stages 1-6 return
objects.
Example mappings:
  WHO -> dialogueFunction: task_management.explain, outcomeIntent: knowledge_seeking
  WHAT -> dialogueFunction: task_management.explain, outcomeIntent: knowledge_seeking
  SHOW_IMAGE -> dialogueFunction: status.report.inventory.single.item, outcomeIntent: clarity
Lines affected: New constant after line 421, return objects in Stages 1-6

TASK IM-2: Add outcomeIntent to all return paths
Priority: CRITICAL
Problem: No stage returns outcomeIntent. PhaseVoice defaults to 'clarity'
for every turn. LTLM selector T1 and T2 matching is degraded because
outcome_intent_code is always 'clarity' regardless of actual user intent.
Fix: Add outcomeIntent field to conversationalMappings (line 389-421) and
to entityIntentMappings (from IM-1). Include in all return objects.
Example values:
  GREETING -> social_connection
  FAREWELL -> social_connection
  GRATITUDE -> social_connection
  HOW_ARE_YOU -> emotional_outcomes.share_joy
  SELF_INQUIRY -> clarity
  TEACH_REQUEST -> knowledge_seeking
  WHO/WHAT/HOW -> knowledge_seeking
Lines affected: 389-421 (conversationalMappings), all return objects

TASK IM-3: Inherit dialogue mappings for pronoun and confirmation stages
Priority: HIGH
Problem: Stage 1 (pronoun resolution, lines 781-802) resolves the entity
from context but returns a bare result with no dialogueFunction. Stage 2
(confirmations, lines 805-841) similarly returns bare results. These should
inherit the dialogue mapping from their parent intent type.
Fix: When Stage 1 resolves a pronoun, look up the intent type (e.g. WHO)
in entityIntentMappings and include dialogueFunction/speechAct/outcomeIntent.
When Stage 2 handles yes/no, map to allo_feedback.positive_feedback or
allo_feedback.negative_feedback respectively.
Lines affected: 785-800, 809-840

TASK IM-4: Add LTLM transition mapping for SHOW_IMAGE
Priority: MEDIUM
Problem: SHOW_IMAGE (Stage 3, lines 843-908) returns no dialogueFunction.
Images appear without any LTLM transition text like "Here is what X looks
like..." Claude shows an image silently with no tanuki voice.
Fix: Add SHOW_IMAGE to entityIntentMappings with appropriate dialogue
function for visual presentation transitions.
Lines affected: 866-874 (return object)

TASK IM-5: Expand conversational patterns for social intents
Priority: MEDIUM
Problem: Only 6 conversational intent types are detected (GREETING, FAREWELL,
GRATITUDE, HOW_ARE_YOU, SELF_INQUIRY, TEACH_REQUEST). Missing patterns for:
  OPINION ("what do you think?")
  SMALLTALK ("how's the weather?", casual chat)
  COMPLIMENT ("you're so helpful")
  JOKE/HUMOR ("tell me a joke")
  STORY ("tell me a story")
  EMOTIONAL_SUPPORT ("I'm feeling down")
These inputs fall through to Stage 4-6 entity search, potentially matching
weak entities instead of triggering conversational LTLM responses.
Fix: Add new conversational patterns and mappings for social intent types.
Requires corresponding LTLM training examples to exist in the database.
Lines affected: 319-387 (conversationalPatterns), 389-421 (conversationalMappings)
Dependency: Requires LTLM utterances authored for these new dialogue functions

TASK IM-6: Add confidence field to searchResult for PhaseIntent gating
Priority: MEDIUM
Problem: searchEntityWithDisambiguation returns searchResult.confidence in
some paths (line 948) but PhaseIntent does not use it for gating knowledge
retrieval. Combined with PI-2, a confidence value from the matcher would
allow PhaseIntent to skip knowledge retrieval for weak entity matches.
Fix: Ensure all search result paths propagate confidence consistently.
Verify searchEntityWithDisambiguation always returns a confidence field.
Lines affected: 886-888, 945-948, 993-997, 1038-1041

REJECTED RECOMMENDATIONS
- TypeScript interfaces for return types: Not compatible with vanilla JS stack
- Abstract factory for stage handlers: Over-engineering for current scale

DEPENDENCIES AND SEQUENCING
IM-1 and IM-2 should be done together (same mapping table, same return objects)
IM-3 depends on IM-1 (needs entityIntentMappings to exist)
IM-5 depends on LTLM training examples being authored first
IM-6 relates to PI-2 (confidence threshold in PhaseIntent)

CROSS-FILE IMPACT
IM-1 + IM-2 directly fix PI-1 (missing outcomeIntent in PhaseIntent)
IM-1 directly enables PV-1 (PhaseVoice LTLM gate can fire for all intents)
IM-3 ensures pronoun/confirmation turns get LTLM coverage
IM-5 + corresponding LTLM content reduces hard_fallback frequency

THE FULL CHAIN (now understood)
cotwIntentMatcher produces dialogueFunction + speechAct + outcomeIntent
  -> PhaseIntent passes them through in intentContext
    -> PhaseVoice line 630 checks dialogueFunction to gate LTLM
      -> ltlmUtteranceSelector uses all three for T1/T2 matching
        -> Storyteller styles the result with blendedMood

Currently broken at step 1: matcher only provides these fields for 6 out
of 17+ intent types. Everything else returns null, killing the chain.
