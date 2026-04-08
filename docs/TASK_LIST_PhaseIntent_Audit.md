TASK LIST — PhaseIntent.js Audit
Thread Date: March 21, 2026
Status: AUDIT COMPLETE — Tasks pending implementation
Audited by: Claude (line-by-line) + Kimi (independent review, 92/100 general + 84/100 targeted)
File: backend/councilTerminal/phases/PhaseIntent.js (687 lines)

AGREED FINDINGS AND TASKS

TASK PI-1: Add outcomeIntent to intentContext return object (LINES 659-683)
Priority: CRITICAL
Problem: PhaseIntent never sets outcomeIntent in the returned intentContext.
PhaseVoice defaults to 'clarity' on every turn (line 637 in PhaseVoice).
This degrades LTLM T1 and T2 matching because the selector searches for
outcome_intent_code = 'clarity' regardless of actual user intent.
Fix: Create an INTENT_TO_OUTCOME_MAP that maps intent types to outcome
intents (e.g. GREETING -> social_connection, TEACH_REQUEST -> knowledge_seeking,
WHO/WHAT/HOW -> clarity). Pass through from IntentMatcher if available,
otherwise derive from the map. Add outcomeIntent field to intentContext return.
Lines affected: 659-683 (return object), new constant map needed

TASK PI-2: Add confidence threshold to knowledge retrieval (LINE 608)
Priority: CRITICAL
Problem: Knowledge retrieval fires on ANY entity match regardless of
confidence. searchAction entity_found or single_match with confidence 0.2
still sets knowledgeResult to a truthy object. This blocks the LTLM
conversational path in PhaseVoice line 630 even when the entity match
is weak or irrelevant.
Example: User says "I'm feeling blue today" -> weak match on "Blue (color)"
-> knowledge dumps instead of empathy utterance.
Fix: Add confidence threshold check. Only retrieve knowledge when
searchResult confidence >= 0.7 (proposed — requires calibration).
Lines affected: 608

TASK PI-3: Validate and log missing dialogueFunction (AFTER LINE 547)
Priority: HIGH
Problem: If IntentMatcher returns an intent with type but no
dialogueFunction field, the LTLM path in PhaseVoice line 630 is silently
disabled. No warning, no fallback, no log.
Fix: Add validation after intent matching (after line 547). Log a warning
when dialogueFunction is null for conversational intent types. Optionally
derive a default dialogueFunction from intent type as fallback.
Lines affected: After 547, before 559

TASK PI-4: Expand INTENT_TO_MODE_MAP for conversational intents (LINES 98-115)
Priority: HIGH
Problem: Only 4 companion mode intents mapped (GREETING, FAREWELL,
GRATITUDE, HOW_ARE_YOU). Social intents like OPINION, SMALLTALK, JOKE,
STORY, COMPLIMENT, EMOTIONAL_SUPPORT are not mapped and default to
'unknown' mode. PhaseVoice has no specific handling for unknown mode.
Fix: Add conversational intent types to the map. Either expand the
existing map or add a 'conversational' default mode for social intents
so PhaseVoice can prioritise LTLM over knowledge retrieval.
Lines affected: 98-115
Dependency: Requires knowing what intent types IntentMatcher actually returns.
Need to audit cotwIntentMatcher to see its output types.

TASK PI-5: Handle unknown mode explicitly downstream
Priority: MEDIUM
Problem: When intentType is not in INTENT_TO_MODE_MAP, mode defaults
to 'unknown' (line 643). PhaseVoice does not handle unknown mode
explicitly. If dialogueFunction is also missing, the system falls
through to empty content blocks and hard_fallback.
Fix: Either prevent unknown from reaching downstream by assigning a
default dialogueFunction in PhaseIntent, or add unknown mode handling
in PhaseVoice that triggers a generic LTLM lookup.
Lines affected: 643, and PhaseVoice fallback chain

TASK PI-6: Gate curriculum detection to avoid unnecessary processing
Priority: LOW
Problem: Curriculum selection check (lines 510-525) runs before intent
matching on every turn. After detection, intent matching still runs
even when we already know the intent is curriculum acceptance. No early
return after successful curriculum detection.
Fix: Add early return or skip intent matching when curriculum selection
is successfully detected. Minor performance improvement.
Lines affected: 510-525, 534-557

REJECTED RECOMMENDATIONS
- Splitting detectCurriculumSelection further: Function is 67 lines but
  cohesive. No split needed.
- Moving curriculum logic to PhaseTeaching: Already noted in PhaseVoice
  task PV-5. Will be addressed there.

DEPENDENCIES AND SEQUENCING
PI-1 is standalone and should be done first (highest impact on LTLM matching)
PI-2 depends on knowing what confidence values IntentMatcher returns
PI-3 and PI-4 depend on auditing cotwIntentMatcher output types
PI-5 depends on PI-4 (need to know the full intent type set first)

CROSS-FILE IMPACT
PI-1 (outcomeIntent) directly fixes LTLM T1/T2 matching degradation
PI-2 (confidence threshold) directly reduces false knowledge retrieval
  blocking the PhaseVoice LTLM gate (PV-1/PV-2)
PI-3 + PI-4 together ensure the LTLM selector receives valid inputs

NEXT FILE TO EXAMINE
cotwIntentMatcher — need to see what intent types, dialogueFunctions,
speechActs, and confidence values it actually returns. This determines
how much of PI-2, PI-3, and PI-4 are IntentMatcher gaps vs PhaseIntent gaps.
