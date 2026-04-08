TASK LIST — phraseChainer.js Audit
Thread Date: March 21, 2026
Status: AUDIT COMPLETE — Contains SECOND ROOT CAUSE blocking styling layer
Audited by: Claude (line-by-line) + Kimi (independent review, 92/100)
File: backend/services/phraseChainer.js (426 lines)

CRITICAL FINDING
validatedTone is referenced at lines 354 and 361 but never defined.
chainPhrases() throws ReferenceError on every invocation. Even if
StorytellerBridge SB-1 is fixed, the sandwich still fails because
this function crashes before it can fetch any phrases.

TWO INDEPENDENT BUGS BLOCK THE ENTIRE STYLING LAYER:
  1. StorytellerBridge line 350 (SB-1): content block type mismatch
  2. phraseChainer line 354 (PC-1): validatedTone undefined
Both must be fixed together for the LTLM sandwich to execute.

AGREED FINDINGS AND TASKS

TASK PC-1: Define validatedTone variable (LINES 354, 361)
Priority: CRITICAL — SECOND ROOT CAUSE BLOCKING STYLING LAYER
Problem: validatedTone is used at lines 354 and 361 but is never
defined anywhere in the function. The variable tone is destructured
at line 318 but never validated into validatedTone. chainPhrases()
throws ReferenceError on every call. StorytellerBridge catches
this at line 430 and returns usedStoryteller: false.
Fix: Add after line 327:
  const validatedTone = CHAIN.VALID_TONES.includes(tone) ? tone : 'neutral';
Lines affected: After 327 (new line), referenced at 354, 361

TASK PC-2: Replace Math.random() with deterministic hash (LINE 235)
Priority: HIGH
Problem: Math.random() used for hedge probability at line 235.
Violates project rule: no Math.random() anywhere. Must use
deterministic djb2 hash or seeded PRNG.
Fix: Use djb2 hash of correlationId or outcomeIntent+strategy to
produce a deterministic probability value. Replace Math.random()
with the hash-derived probability.
Lines affected: 235

TASK PC-3: Add mood/PAD parameter to chainPhrases (LINES 299-314)
Priority: MEDIUM
Problem: chainPhrases does not accept mood or PAD parameters. Phrase
selection is driven entirely by outcomeIntent, strategy, tone, and
formality. The emotional state (pleasure, arousal, dominance) from
EarWig is never used in phrase selection. The header claims
"emotionally-aware" speech but PAD does not reach the query layer.
Fix: Add targetPad option to chainPhrases. Pass to getPhrases.
Implement PAD-distance scoring in phrase selection similar to
ltlmUtteranceSelector.js lines 296-303.
Lines affected: 299-314 (function signature), 100-116 (fetch calls)
Dependency: Requires examining phraseQueryLayer.js to see if it
accepts PAD parameters, and conversational_phrases table schema

TASK PC-4: Add formality validation (LINE 319)
Priority: LOW
Problem: formality is destructured at line 319 and used directly
without validation against VALID_FORMALITIES (line 80). Invalid
values pass through to the query layer.
Fix: Add after validatedTone definition:
  const validatedFormality = CHAIN.VALID_FORMALITIES.includes(formality) ? formality : 'casual';
Update references at lines 354 and 361.
Lines affected: After 327 (new line), 354, 361

REJECTED RECOMMENDATIONS
- Refactor fetchMap pattern to object-mapped: Works correctly as-is,
  not worth the churn
- Reduce MAX_CONNECTOR_COUNT from 5: Current clamping is safe,
  StorytellerBridge controls actual count via content block count

DEPENDENCIES AND SEQUENCING
PC-1 must be deployed WITH SB-1 (both block the styling layer)
PC-2 is standalone (Math.random replacement)
PC-3 depends on phraseQueryLayer.js and conversational_phrases schema
PC-4 is standalone and can ship with PC-1

CRITICAL FIX BUNDLE (minimum viable for styling layer)
These two fixes MUST ship together:
  SB-1: StorytellerBridge line 350 content block type extraction
  PC-1: phraseChainer validatedTone definition
Without both, the LTLM sandwich remains completely disabled.
