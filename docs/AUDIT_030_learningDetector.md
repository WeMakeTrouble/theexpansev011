# AUDIT 030 — learningDetector.js

**File:** `backend/services/learningDetector.js` (412 lines)
**Date:** 2026-03-03
**Auditors:** Claude (Initial), Kimi (Independent)
**Consensus Score:** 94/100
**Status:** LOCKED

---

## Purpose

Detects unfamiliar language in user input using 6 weighted signals (PAD coverage, PAD novelty, PAD sparsity, n-gram coverage, surprisal, metaphor). Detection half of the vocabulary learning pipeline. Foundation of Goal 2: "Claude can detect unfamiliar language." Pure computation — zero database queries.

---

## Executive Score

| Category | Points | Score | Notes |
|---|---|---|---|
| Code Quality | 20 | 18/20 | Async without await, hardcoded threshold |
| Functional Correctness | 25 | 24/25 | 6-signal weights sum correctly, logic sound |
| Architectural Fitness | 20 | 19/20 | Clean integration, async misleading |
| Performance | 20 | 19/20 | Zero DB queries, missing input length cap |
| Edge Case Handling | 15 | 14/15 | Graceful degradation on all failures, one missing guard |
| **TOTAL** | **100** | **94/100** | |

---

## Score Reconciliation

| Category | Kimi | Claude | Consensus |
|---|---|---|---|
| Code Quality | 18/20 | 18/20 | 18/20 |
| Functional Correctness | 24/25 | 23/25 | 24/25 |
| Architectural Fitness | 20/20 | 19/20 | 19/20 |
| Performance | 20/20 | 19/20 | 19/20 |
| Edge Case Handling | 15/15 | 13/15 | 14/15 |
| **TOTAL** | **97** | **92** | **94** |

Kimi missed async-without-await (m1) and missing input length limit (m3). Claude PAD shape concern (m2) reclassified as cross-module observation — internally consistent within this file per Kimi assessment. Consensus splits the difference on Edge Case and adopts Functional Correctness from Kimi.

---

## MAJOR Findings

None.

---

## MINOR Findings (3)

### m1 — Async Method Without Await (Line 275)

detectLearningOpportunity is declared async but all three detector calls on lines 282-284 are synchronous. _estimatePAD, _estimateSurprisal, and _detectMetaphor are all wrapped in try/catch and none return promises. The method never uses await. It works correctly (returns a promise-wrapped result) but misleads about the method nature and adds unnecessary microtask overhead. Callers must await it unnecessarily.

### m2 — Hardcoded Threshold (Line 113)

LEARNING_THRESHOLD = 0.45 is hardcoded. Same pattern as referenceDetector (AUDIT_028 m4). Cannot tune detection sensitivity via environment variables without code change.

Fix: Move to ENV with nullish coalescing: Number(process.env.LEARNING_THRESHOLD) ?? 0.45

### m3 — No Input Length Limit on Message (Line 276)

detectLearningOpportunity validates that message is a non-empty string but does not cap length. A very long input string would be passed to padEstimator, ngramSurprisal, and metaphorDetector without truncation. referenceDetector caps at MAX_INPUT_LENGTH = 10000 — this module has no equivalent.

Fix: Add MAX_INPUT_LENGTH constant matching referenceDetector.

---

## Cross-Module Observation (Not Scored)

### PAD Fallback Shape Convention

The fallback PAD object on line 155 uses long-form keys: {pleasure: 0, arousal: 0, dominance: 0}. Other modules in the codebase (taughtEntityCapturer line 163) check padCoordinates.p (short-form). This is a system-wide naming convention question rather than a bug in this file — learningDetector is internally consistent. Noting for future standardisation.

---

## Cross-File Pattern Check

| Pattern | Status |
|---|---|
| 1: Falsy Zero | ABSENT — pressures[key] or 0 on line 259 is safe, 0 is correct default |
| 2: No Query Timeout | N/A — no database queries |
| 3: Timer Leak | ABSENT |
| 4: Non-Deterministic | ABSENT — deterministic signal computation |
| 5: Speaker Hardcoding | ABSENT — fully parameterised by userId |
| 6: PAD Shape | OBSERVATION — internally consistent, cross-module convention difference noted |

---

## B-Roll Readiness: READY

Fully parameterised. No character-specific logic. Any text input from any entity can be analysed. userId parameter exists but is unused beyond logging (line 325) — ready for future per-user tuning.

---

## Positive Findings

- 6 deliberate signals with documented weights summing to exactly 1.00 (lines 115-122)
- Frozen SIGNAL_WEIGHTS object prevents runtime mutation (line 115)
- All three external detector calls wrapped in individual try/catch with safe fallbacks (lines 147-208)
- Fallback values are comprehensive — coverage, intensity, dominantEmotion all present
- Bug fixes from v009 documented in header with root cause analysis (lines 39-52)
- PAD sparsity replaced from async DB query to in-memory heuristic — eliminates per-turn DB hit (lines 77-83)
- Normalised pressures clamped to 0-1 range with Math.max/Math.min (lines 243-248)
- Nullish coalescing on metaphor confidence (line 248) — correctly handles confidence of 0
- Empty result shape matches full result shape exactly (lines 338-367)
- Signal explanations method for human-readable output (lines 380-405)
- Comprehensive return structure documented in header (lines 54-75)
- Singleton export per naming conventions (line 412)
- No database interaction — pure computation, no I/O concerns
- Clean separation of concerns — detection only, no capture or storage
- Highest score in the entire 30-file audit series

---

## Wave 5 Final (6 of 6)

| No | File | Score |
|---|---|---|
| 25 | KnowledgeRetriever.js | 89 |
| 26 | cotwIntentMatcher.js | 84 |
| 27 | taughtEntityCapturer.js | 87 |
| 28 | referenceDetector.js | 89 |
| 29 | learningCapturer.js | 84 |
| 30 | learningDetector.js | 94 |

**Wave 5 Average: 87.8/100**

---

## COMPLETE AUDIT SERIES — ALL 30 FILES

### Wave 1 (Files 1-6)

| No | File | Score |
|---|---|---|
| 1 | PhaseVoice.js | 82 |
| 2 | ltlmUtteranceSelector.js | 78 |
| 3 | BrainOrchestrator.js | 77 |
| 4 | Finalizer.js | 88 |
| 5 | PhaseIntent.js | 85 |
| 6 | PhaseTeaching.js | 81 |

### Wave 2 (Files 7-12)

| No | File | Score |
|---|---|---|
| 7 | PhaseEmotional.js | 86 |
| 8 | PhaseClaudesHelpDesk.js | 90 |
| 9 | SemanticEmbedder.js | 90 |
| 10 | findSemanticUtterances.js | 87 |
| 11 | SocialDialogueManager.js | 89 |
| 12 | narrativeWelcomeService.js | 91 |

### Wave 3 (Files 13-18)

| No | File | Score |
|---|---|---|
| 13 | StorytellerBridge.js | 89 |
| 14 | ConciergeStatusReportService.js | 91 |
| 15 | IdentityModule.js | 86 |
| 16 | omiyageService.js | 88 |
| 17 | padEstimator.js | 93 |
| 18 | DrClaudeModule.js | 89 |

### Wave 4 (Files 19-24)

| No | File | Score |
|---|---|---|
| 19 | RepairHandler.js | 87 |
| 20 | ngramSurprisal.js | 90 |
| 21 | metaphorDetector.js | 91 |
| 22 | phraseChainer.js | 87 |
| 23 | phraseQueryLayer.js | 73 |
| 24 | commonWordFilter.js | 91 |

### Wave 5 (Files 25-30)

| No | File | Score |
|---|---|---|
| 25 | KnowledgeRetriever.js | 89 |
| 26 | cotwIntentMatcher.js | 84 |
| 27 | taughtEntityCapturer.js | 87 |
| 28 | referenceDetector.js | 89 |
| 29 | learningCapturer.js | 84 |
| 30 | learningDetector.js | 94 |

### Series Statistics

- **Total Files:** 30
- **Overall Average:** 86.6/100
- **Highest Score:** 94 (learningDetector.js)
- **Lowest Score:** 73 (phraseQueryLayer.js)
- **90+ (Production Ready):** 10 files
- **80-89 (Production Ready with Remediation):** 17 files
- **70-79 (Requires Attention):** 3 files

### Critical Cross-File Patterns

| Pattern | Files Affected | Severity |
|---|---|---|
| Falsy Zero (or instead of ??) | 8 files | MAJOR across codebase |
| Missing Query Timeouts | 6 files | MAJOR at pool level |
| Timer Leaks | 3 files | MAJOR per file |
| i18n Character Stripping | 2 files | MAJOR for Japanese users |
| Missing UNIQUE Constraints | 2 files | MAJOR data integrity |
| PAD Shape Inconsistency | 3 files | MINOR cross-module |

---

*Generated from consensus review. Claude initial: 92. Kimi independent: 97. Consensus: 94. Series complete — 30 of 30 files audited.*
