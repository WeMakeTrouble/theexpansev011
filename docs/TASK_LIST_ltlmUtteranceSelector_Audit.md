TASK LIST — ltlmUtteranceSelector.js Audit
Thread Date: March 21, 2026
Status: AUDIT COMPLETE — Tasks pending implementation
Audited by: Claude (line-by-line) + Kimi (independent review, 84/100)
File: backend/services/ltlmUtteranceSelector.js (466 lines)

AGREED FINDINGS AND TASKS

TASK US-1: Fix deterministic hash variety failure (LINE 326)
Priority: CRITICAL
Problem: _deterministicIndex uses speakerCharacterId + dialogueFunctionCode +
speechActCode + outcomeIntentCode as hash input. Same input parameters always
select the same utterance from top 10. If a user says hello twice in the same
emotional state, Claude says the exact same thing every time.
Fix: Mix turn index or timestamp into the hash salt to introduce variety
while keeping the selection deterministic (no Math.random).
Lines affected: 326, 408-415

TASK US-2: Fix candidate pool truncation destroying semantic results (LINES 283-285)
Priority: HIGH
Problem: Semantic results are pushed to the END of the candidates array (line 261).
If T1-T5 already returned 150 exact candidates, the slice at line 284 cuts off
all semantic results before scoring ever runs. Semantic enhancement is silently
discarded in high-coverage scenarios.
Fix: Move truncation to after scoring (after line 323), or interleave semantic
results into the array before truncation.
Lines affected: 261, 283-285

TASK US-3: Fix connection timeout stacking (LINE 145)
Priority: HIGH
Problem: SET statement_timeout = 3000 per query. With 5 tiers that is 15s max.
PhaseVoice RETRIEVAL_TIMEOUT_MS = 5000. PhaseVoice abandons the call after 5s
but the DB connection remains held until the selector finishes or errors.
Resource leak confirmed.
Fix: Add an overall timeout to the selectLtlmUtteranceForBeat function
(e.g. 4500ms AbortController or Promise.race) so it always returns before
PhaseVoice kills the call. Ensures connection is released cleanly.
Lines affected: 124-353 (whole function needs wrapping)

TASK US-4: Fix NULL PAD values penalised unfairly (LINES 296-303)
Priority: HIGH
Problem: Candidates with NULL PAD coordinates are treated as (0,0,0) via
the || 0 fallback. This maps them to extreme negative affect regardless of
target mood. Semantically perfect utterances with unscored PAD will always
rank last.
Fix: Default NULL PAD to neutral (0.5, 0.5, 0.5) instead of (0,0,0), or
exclude NULL-PAD candidates from PAD scoring and score them on other factors
only.
Lines affected: 298-300

TASK US-5: Add dialogueFunctionCode validation logging (LINES 287-293)
Priority: MEDIUM
Problem: If a nonexistent dialogueFunctionCode is passed, all tiers silently
return zero rows. The warning at line 288 logs speaker and codes but does not
distinguish between "function exists but has no utterances" and "function code
is not in the database schema at all."
Fix: Log the specific dialogueFunctionCode that yielded zero results. Consider
a DB check against the dialogue_functions table to distinguish missing vs empty.
Lines affected: 287-293

TASK US-6: Document tier overwrite as intentional (LINE 231)
Priority: LOW
Problem: candidates = tierResult.rows at line 231 overwrites previous tier
results. T1 matches are lost when falling through to T2. This is intentional
(precision over recall) but not documented.
Fix: Add comment at line 231 explaining the design choice.
Lines affected: 231, 240-242

TASK US-7: Fix intent bonus asymmetry for semantic candidates (LINES 310-312)
Priority: LOW
Problem: Exact candidates get a 0.2 intent bonus when outcome_intent_code
matches. Semantic candidates do not get any intent bonus even when they also
have a matching outcome_intent_code. This unfairly penalises semantic results.
Fix: Add intent bonus component to SEMANTIC_SOURCE scoring.
Lines affected: 100-103, 310-312

REJECTED RECOMMENDATIONS (incompatible with architecture)
- Redis for novelty persistence: No Redis in stack. In-memory is adequate.
- UNION ALL query rewrite: Sequential early-break is intentional.
- A/B testing scoring weights: No A/B infrastructure. Weights labelled proposed.
- Math.sqrt optimisation: Premature. DB query is the bottleneck not CPU.

DEPENDENCIES AND SEQUENCING
US-1 is standalone and can be done immediately
US-2 and US-7 relate to semantic scoring and should be done together
US-3 should be done before any production load increase
US-4 depends on knowing how many NULL PAD utterances exist in DB (need query)

CRITICAL OPEN QUESTIONS (require DB investigation)
1. How many LTLM training examples exist total?
2. How many per dialogue_function_code?
3. How many have NULL PAD values?
4. Does SemanticEmbedder.js exist in the current deployment?
5. What tier distribution is hitting in production?

DB INVESTIGATION RESULTS (March 21, 2026)

Total utterances: 5,079
Speaker: All assigned to #700002 (Claude the Tanuki)
NULL PAD values: 0 (all scored — US-4 deprioritised)
Outcome intents mapped: 4,594 (90.5%)
Dialogue functions: 154 distinct codes

CORPUS SKEW IDENTIFIED
Top 5 functions (task_management + auto_feedback): 1,081 utterances (21%)
Social/greeting functions: 10-16 utterances each
Relational/curiosity functions: 8-12 each
system_guidance functions: 4-8 each

AGREED DIAGNOSIS (Claude + Kimi aligned)
1. Corpus is adequate in size but skewed toward instructional content
2. Primary bottleneck is PhaseVoice gate at line 630 (not selector, not DB)
3. Secondary problem is thin social/relational coverage + deterministic hash
4. Fix priority confirmed:
   (a) PhaseVoice gate PV-1 + PV-2 (architectural blocker)
   (b) Deterministic hash US-1 (trivial fix, large variety impact)
   (c) Author more social/relational utterances (long-term quality)

PRE-IMPLEMENTATION NOTE (from Kimi)
When PhaseVoice gate is opened to allow LTLM alongside knowledge,
verify that PhaseIntent maps to appropriate framing functions
(e.g. discourse_structuring.introduce_knowledge or similar).
If intent classification maps to greeting/social functions when
knowledge is present, the LTLM utterance will mismatch the context.
Check dialogue function taxonomy supports knowledge-framing use case.

TASK PRIORITY REORDER BASED ON DB EVIDENCE
US-4 (NULL PAD fix): Deprioritised from HIGH to LOW (zero NULL values in DB)
US-1 (deterministic hash): Elevated — can ship as standalone hotfix
US-2 (truncation): Still HIGH but less urgent than PhaseVoice gate
