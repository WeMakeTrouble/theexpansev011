TASK LIST — PhaseVoice.js Audit
Thread Date: March 21, 2026
Status: AUDIT COMPLETE — Tasks pending implementation
Audited by: Claude (line-by-line) + Kimi (independent review)
File: backend/councilTerminal/phases/PhaseVoice.js (890 lines)

AGREED FINDINGS AND TASKS

TASK PV-1: Fix LTLM conversational gate (LINE 630)
Priority: CRITICAL
Problem: Line 630 requires both knowledgeResult AND entity to be falsy before
LTLM conversational utterances are fetched. This forces a binary choice between
knowledge content and natural speech. Claude either dumps facts or chats but
never both.
Fix: Decouple content retrieval from utterance retrieval. Always allow LTLM
to provide conversational framing as a content block type (LTLM_FRAME) even
when knowledge or entity blocks exist. Insert as section 4.6b before Storyteller
(section 5) so Storyteller can blend LTLM framing with knowledge content.
Lines affected: 630-657

TASK PV-2: Fix knowledgeResult truthiness bug (LINE 630)
Priority: HIGH
Problem: !knowledgeResult fails when knowledgeResult is an object with
found: false or items: []. The object is truthy so the LTLM path is blocked
even though no actual knowledge content exists.
Fix: Change !knowledgeResult to !knowledgeResult?.items?.length
Lines affected: 630

TASK PV-3: Build missing LTLM generic fallback tier (LINES 816-829)
Priority: HIGH
Problem: File header (line 17) documents fallback chain as
"styled -> raw blocks -> LTLM generic -> hard fallback" but the LTLM generic
tier does not exist in code. System jumps directly from empty raw blocks to
four hardcoded hard_fallback strings.
Fix: Insert an LTLM generic query (e.g. dialogueFunction:
responsive.acknowledge or expressive.thinking) between lines 817 and 820,
before the hard_fallback check.
Lines affected: 816-829

TASK PV-4: Fix positive emotion gate (LINES 667-670)
Priority: MEDIUM
Problem: Celebratory LTLM utterance only fires when contentBlocks is empty.
If knowledge blocks exist, positive emotion is ignored even though the user
expressed joy or excitement.
Fix: Make conditional on Storyteller failure rather than empty content blocks.
Change to: if (!styledOutput && isPositiveEmotion && dependencies?.LtlmUtteranceSelector)
This fills the emotional gap only when Storyteller drops the ball.
Lines affected: 667-702 (move to after section 5, Storyteller)

TASK PV-5: Move curricula SQL to dedicated PhaseTeaching handler (LINES 584-624)
Priority: MEDIUM
Problem: PhaseVoice contains direct SQL queries for curriculum listing. This
violates single responsibility. PhaseVoice should be pure assembly and styling.
Fix: Create PhaseTeaching handler that runs after PhaseIntent but before
PhaseVoice. It checks intentContext.type === TEACH_REQUEST, queries curricula,
stores result in turnState.teachingResult. PhaseVoice then renders from
turnState.teachingResult using LTLM utterances instead of hardcoded strings.
Lines affected: 584-624

TASK PV-6: Replace hardcoded dialogue paths with LTLM queries
Priority: MEDIUM
Problem: Three major dialogue paths bypass LTLM entirely:
  a) Teaching activation (lines 431-440): hardcoded "Great! Let us begin..."
  b) Curriculum selection (lines 596-613): hardcoded course list formatting
  c) Helpdesk world break (lines 718-764): 14 hardcoded placeholder strings
These produce mechanical output that does not use Claude the Tanuki voice.
Fix: Replace each with LtlmUtteranceSelector calls matching appropriate
dialogue functions. Helpdesk comment already identifies target categories
(commissive.offer_help, responsive.acknowledge_request, etc).
Lines affected: 431-440, 596-613, 718-764

TASK PV-7: Route dossier content through LTLM styling (LINES 257-363)
Priority: LOW
Problem: formatDossierBlock produces raw database dumps (OCEAN scores, trait
percentiles, inventory lists) that read like spreadsheet output, not a tanuki
speaking. This content bypasses LTLM styling.
Fix: Either route dossier blocks through Storyteller with a flag indicating
they need heavy voice transformation, or create LTLM utterance templates
for dossier presentation that wrap raw data in conversational framing.
Lines affected: 257-363

TASK PV-8: Audit negative rank values for content block ordering
Priority: LOW
Problem: Teaching activation uses rank: -1, helpdesk uses rank: -2,
standard blocks use rank: 0. The sort at line 232 handles this but the
negative values create implicit priority assumptions that are not documented.
Fix: Document the rank priority system or use named constants
(e.g. RANK_HELPDESK_PRIORITY = -2, RANK_TEACHING_PRIORITY = -1).
Lines affected: 232, 434, 744

DEPENDENCIES AND SEQUENCING
PV-1 and PV-2 should be done together (same line, same gate logic)
PV-3 requires LTLM training examples for generic dialogue functions to exist in DB
PV-5 requires creating a new PhaseTeaching.js file and modifying BrainOrchestrator
PV-6 requires LTLM training examples for helpdesk and teaching dialogue functions
PV-4 should wait until Storyteller is audited (need to confirm if blendedMood works)

OPEN QUESTIONS FOR NEXT FILES
1. Is ltlmUtteranceSelector.js returning good utterances when called?
2. Is Storyteller.buildStorytellerResponse actually applying blendedMood?
3. Is PhaseIntent setting dialogueFunction reliably?
4. How many LTLM training examples exist per dialogue function category?
