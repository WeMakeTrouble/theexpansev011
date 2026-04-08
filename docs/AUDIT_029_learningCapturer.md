# AUDIT 029 — learningCapturer.js

**File:** `backend/services/learningCapturer.js` (506 lines)
**Date:** 2026-03-03
**Auditors:** Claude (Initial), Kimi (Independent)
**Consensus Score:** 84/100
**Status:** LOCKED

---

## Purpose

Stores what Claude learns from users — phrases, slang, explanations. Capture half of the vocabulary learning pipeline (sibling to learningDetector). Includes bidirectional confidence progression (1 to 5) based on usage success rates. Foundation of Goal 3: "Claude can learn from users."

---

## Executive Score

| Category | Points | Score | Notes |
|---|---|---|---|
| Code Quality | 20 | 16/20 | Missing input validation limits, transaction boundary issues |
| Functional Correctness | 25 | 20/25 | PostgreSQL stale read in UPDATE, race condition on duplicates |
| Architectural Fitness | 20 | 19/20 | Clean sibling design to taughtEntityCapturer |
| Performance | 20 | 18/20 | No hot path concerns |
| Edge Case Handling | 15 | 11/15 | i18n stripping, error/empty ambiguity, no length caps |
| **TOTAL** | **100** | **84/100** | |

---

## Score Reconciliation

| Category | Kimi | Claude | Consensus |
|---|---|---|---|
| Code Quality | 16/20 | 16/20 | 16/20 |
| Functional Correctness | 20/25 | 20/25 | 20/25 |
| Architectural Fitness | 19/20 | 19/20 | 19/20 |
| Performance | 18/20 | 18/20 | 18/20 |
| Edge Case Handling | 11/15 | 11/15 | 11/15 |
| **TOTAL** | **84** | **84** | **84** |

Both independent reviews identical. No adjustments needed.

---

## Database Verification

- cotw_user_language_id hex range: CONFIRMED in hex_id_ranges (#E30000 to #E361A7, status active)
- UNIQUE constraints on cotw_user_language: NONE (only 3 CHECK constraints found)
- Total assignments: 0 (hex range unused so far)

---

## MAJOR Findings (2)

### M1 — No UNIQUE Constraint on (user_id, normalized_phrase) — Race Condition (Line 192)

Same pattern as AUDIT_027. The duplicate check on line 192 calls _findByNormalisedPhrase which is a SELECT using pool.query (line 269) outside any transaction. The transaction does not start until line 205. Two concurrent captureTeaching calls with the same phrase can both pass the SELECT and both INSERT. The database has only 3 CHECK constraints and zero UNIQUE constraints.

Fix: CREATE UNIQUE INDEX idx_cotw_user_language_user_norm ON cotw_user_language(user_id, normalized_phrase)

### M2 — Confidence Adjustment Uses Stale Row Values (Lines 426-440)

In PostgreSQL, all SET expressions in a single UPDATE statement see the OLD row values. The confidence check on lines 435-437 checks the OLD times_successful (before the +1 on line 427) and the OLD avg_score (before the recalculation on lines 428-431). After the 5th successful use with avg_score >= 4.0, the confidence will not promote until the 6th call because the check sees pre-update count of 4. Same one-behind lag applies to demotion. The avg_score comparison also uses the pre-update average, not the newly calculated one.

Fix: Either split into two queries (UPDATE counts first, then UPDATE confidence based on new values), or use times_successful + 1 in the WHEN clause to account for the current increment.

---

## MINOR Findings (4)

### m1 — Duplicate Check Runs Outside Transaction (Lines 192 vs 205)

Same pattern as AUDIT_027 m1. _findByNormalisedPhrase uses pool.query (non-transactional) while INSERT uses transaction client. Even with a UNIQUE constraint added per M1, the check-then-act gap allows stale reads.

### m2 — International Character Stripping (Line 158)

Same pattern as AUDIT_027 m3. /[^a-z0-9\s]/g strips all non-ASCII characters. "cafe" becomes "caf", any CJK input becomes empty string. Japanese users (target audience) cannot store native-language slang properly.

### m3 — Error Returns Indistinguishable From Empty Results

Same pattern as AUDIT_027 m5:

- getUserLearnedPhrases returns [] on error (line 360) — same as "no phrases"
- getLearnedPhraseCount returns 0 on error (line 391) — same as "zero phrases"

Callers cannot distinguish successful empty results from database failures.

### m4 — No Input Length Limit on phrase or baseConcept (Line 226)

captureTeaching trims the phrase (line 226) but does not enforce a maximum length. A 10MB string would be sent directly to the INSERT. taughtEntityCapturer has MAX_ENTITY_NAME_LENGTH = 100 and MAX_EXPLANATION_LENGTH = 500 — this module has no equivalent guards.

Fix: Add MAX_PHRASE_LENGTH and MAX_CONCEPT_LENGTH constants with validation before INSERT.

---

## Cross-File Pattern Check

| Pattern | Status |
|---|---|
| 1: Falsy Zero | ABSENT — hardcoded constants only |
| 2: No Query Timeout | ABSENT — uses pool.query and pool.connect without custom timeout |
| 3: Timer Leak | ABSENT |
| 4: Non-Deterministic | ABSENT |
| 5: Speaker Hardcoding | ABSENT — fully parameterised by userId |
| 6: PAD Shape | N/A — stores PAD as opaque JSONB, no validation (appropriate for this layer) |

---

## B-Roll Readiness: READY

Fully parameterised by userId. No character-specific logic. Any entity (NPC or user) could teach vocabulary through this module.

---

## Positive Findings

- Transaction discipline on captureTeaching — hex ID generation and INSERT in same transaction (lines 204-236)
- Bidirectional confidence progression with explicit thresholds (lines 132-136, 434-440)
- Running average score calculation in SQL (lines 428-431)
- Usage context stored for debugging (line 433, truncated to 500 chars at line 451)
- Parameterized pagination with clamped limits (lines 323-327)
- Normalised phrase stored alongside original for duplicate detection
- Clean separation: capture vs detection in sibling modules
- Structured logging on all operations
- getConfidenceLabel mirrors taughtEntityCapturer exactly (lines 490-499) — consistent API
- Singleton export per naming conventions (line 506)
- Hex range confirmed in database: #E30000 to #E361A7 (active, zero assignments)

---

## Wave 5 Progress (5 of 6)

| No | File | Score |
|---|---|---|
| 25 | KnowledgeRetriever.js | 89 |
| 26 | cotwIntentMatcher.js | 84 |
| 27 | taughtEntityCapturer.js | 87 |
| 28 | referenceDetector.js | 89 |
| 29 | learningCapturer.js | 84 |

1 remaining.

---

*Generated from consensus review. Claude initial: 84. Kimi independent: 84. Consensus: 84. Perfect alignment, no adjustments.*
