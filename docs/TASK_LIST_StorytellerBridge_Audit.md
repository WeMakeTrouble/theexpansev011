TASK LIST — StorytellerBridge.js Audit
Thread Date: March 21, 2026
Status: AUDIT COMPLETE — Contains ROOT CAUSE of mechanical Claude
Audited by: Claude (line-by-line) + Kimi (independent review, 90/100 + bug confirmation)
File: backend/services/StorytellerBridge.js (652 lines)

ROOT CAUSE IDENTIFIED
The content block type mismatch at line 350 completely disables the
Storyteller sandwich. PhaseVoice passes objects, Storyteller expects
strings, every block is silently coerced to empty string, and the
function returns usedStoryteller: false on every single call.
The LTLM opener/connector/hedge/closer sandwich has NEVER executed
in production. Claude has always spoken raw knowledge text.

AGREED FINDINGS AND TASKS

TASK SB-1: Fix content block type mismatch (LINE 350)
Priority: CRITICAL — ROOT CAUSE OF MECHANICAL CLAUDE
Problem: PhaseVoice pushes content blocks as objects with properties
{ type, content, rank, source }. StorytellerBridge line 350 checks
typeof b === 'string' which is false for objects. Every block maps to
empty string, gets filtered out, and the function returns
{ usedStoryteller: false, reason: 'empty_content' } immediately.
The LTLM sandwich (opener, connector, hedge, closer) never executes.
Fix: Change line 350 from:
  blocks = blocks.map(b => (typeof b === 'string' ? b.trim() : '')).filter(b => b.length > 0);
To:
  blocks = blocks.map(b => (typeof b === 'string' ? b.trim() : (b?.content || '').trim())).filter(b => b.length > 0);
Lines affected: 350
Impact: Immediately enables the entire LTLM styling layer

TASK SB-2: Fix emotional override key mismatch (LINES 122-125)
Priority: HIGH
Problem: EMOTIONAL_OVERRIDES keys are 'anxious' and 'frustrated'.
PhaseVoice passes emotionalSignal from emotionalContext.paramKey which
uses 'crisis', 'negative', 'highArousal', 'neutral'. None of these
match the override keys. The emotional routing at line 205 NEVER fires.
All emotional signals fall through to DEFAULT_STORY_PLAN (clarity/info).
Fix: Align keys with PhaseEmotional/PhaseVoice taxonomy:
  highArousal -> { outcomeIntent: 'reassurance', strategy: 'affirmation' }
  negative -> { outcomeIntent: 'validation', strategy: 'reflection' }
  crisis -> { outcomeIntent: 'reassurance', strategy: 'containment' }
  distressed -> { outcomeIntent: 'validation', strategy: 'reflection' }
  supportive -> { outcomeIntent: 'encouragement', strategy: 'affirmation' }
  celebratory -> { outcomeIntent: 'celebration', strategy: 'affirmation' }
Lines affected: 122-125

TASK SB-3: Pass blendedMood to chainPhrases (LINE 369)
Priority: HIGH
Problem: PhaseVoice calculates blendedMood from real EarWig PAD data
and passes it as the mood parameter. StorytellerBridge destructures it
at line 327 but never uses it. It is not passed to chainPhrases (line
369) and not used in _mapIntentToStoryPlan (line 360). All the PAD
mood blending work in PhaseVoice is wasted.
Fix: Pass mood to chainPhrases options object so phrase selection can
use PAD coordinates for emotional tone matching. Also update
_mapIntentToStoryPlan to use PAD quadrants for strategy selection.
Lines affected: 360, 369
Dependency: Requires examining phraseChainer.js to see if it accepts mood

TASK SB-4: Expand DEFAULT_INTENT_MAP (LINES 127-129)
Priority: MEDIUM
Problem: Only WHY intent type has explicit LTLM mapping. All other
intents (WHO, WHAT, WHERE, HOW, SEARCH, etc.) fall through to
DEFAULT_STORY_PLAN (clarity/info). This limits LTLM specificity.
Fix: Add intent-specific strategies:
  WHO -> { outcomeIntent: 'knowledge_seeking', strategy: 'identification' }
  WHAT -> { outcomeIntent: 'knowledge_seeking', strategy: 'explanation' }
  HOW -> { outcomeIntent: 'knowledge_seeking', strategy: 'instruction' }
  WHERE -> { outcomeIntent: 'knowledge_seeking', strategy: 'location' }
  GREETING -> { outcomeIntent: 'social_connection', strategy: 'warmth' }
  FAREWELL -> { outcomeIntent: 'social_connection', strategy: 'closure' }
Lines affected: 127-129

TASK SB-5: Add retry logic to chainPhrases call (LINE 368)
Priority: LOW
Problem: chainPhrases uses only timeout protection. PhaseEmotional uses
withRetry for parity. Transient LTLM failures immediately fall back to
raw content blocks.
Fix: Wrap chainPhrases in withRetry (2 attempts, 100ms backoff).
Lines affected: 368-378

REJECTED RECOMMENDATIONS
- Caching character profiles: Profiles change with personality updates.
  Cache would need invalidation hooks. Not worth complexity now.
- Template/join approach for sandwich assembly: Current string
  concatenation is readable and correct. Not a priority refactor.

DEPENDENCIES AND SEQUENCING
SB-1 is standalone and can be done IMMEDIATELY (one-line fix)
SB-2 is standalone (constant update only)
SB-3 depends on examining phraseChainer.js to confirm it accepts mood
SB-4 depends on IM-1 (intent mappings from cotwIntentMatcher)

THE FULL ROOT CAUSE CHAIN (now complete)

1. cotwIntentMatcher returns no dialogueFunction for entity-seeking
   intents (IM-1) -> PhaseVoice LTLM gate at line 630 never fires
   for knowledge queries

2. PhaseIntent never sets outcomeIntent (PI-1) -> LTLM selector
   always uses 'clarity' default, degrading T1/T2 matching

3. PhaseIntent has no confidence threshold on knowledge retrieval
   (PI-2) -> weak entity matches block LTLM conversational path

4. StorytellerBridge silently discards all content blocks due to
   type mismatch (SB-1) -> LTLM sandwich NEVER executes

5. StorytellerBridge emotional overrides use wrong key names (SB-2)
   -> emotional routing always defaults to clarity/info

6. StorytellerBridge ignores blendedMood (SB-3) -> PAD emotional
   data from EarWig is wasted

7. ltlmUtteranceSelector deterministic hash (US-1) -> same inputs
   always select same utterance, reducing variety

Result: Claude speaks raw knowledge dumps with no conversational
framing, no emotional tone, no variety, and falls to hard_fallback
when content blocks are empty.
