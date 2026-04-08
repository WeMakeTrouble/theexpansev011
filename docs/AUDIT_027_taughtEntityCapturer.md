# AUDIT 027 — taughtEntityCapturer.js

**File:** `backend/services/taughtEntityCapturer.js` (844 lines)
**Date:** 2026-03-03
**Auditors:** Claude (Initial), Kimi (Independent)
**Consensus Score:** 87/100
**Status:** LOCKED

---

## Purpose

User-taught entity capture, recall, reconfirmation, and memory budget management for the User-Taught Entity Discovery System (Goal 3). Handles PERSON, PET, LOCATION, INSTITUTION, ACTIVITY, SLANG, and OBJECT entity types with fuzzy phonetic recall and 50-entity memory budget.

---

## Executive Score

| Category | Points | Score | Notes |
|---|---|---|---|
| Code Quality | 20 | 17/20 | Transaction boundary issues, SLANG bridge orphan risk |
| Functional Correctness | 25 | 22/25 | Race condition on duplicate detection, i18n name corruption |
| Architectural Fitness | 20 | 19/20 | Clean service separation, B-Roll agnostic |
| Performance | 20 | 18/20 | Phonetic indices efficient, no hot path concerns |
| Edge Case Handling | 15 | 11/15 | Error/empty indistinguishable, PAD partial validation |
| **TOTAL** | **100** | **87/100** | |

---

## Score Reconciliation

| Category | Kimi | Claude | Consensus |
|---|---|---|---|
| Code Quality | 17/20 | 17/20 | 17/20 |
| Functional Correctness | 22/25 | 22/25 | 22/25 |
| Architectural Fitness | 19/20 | 19/20 | 19/20 |
| Performance | 18/20 | 18/20 | 18/20 |
| Edge Case Handling | 11/15 | 11/15 | 11/15 |
| **TOTAL** | **87** | **87** | **87** |

Both independent reviews identical. No adjustments needed.

---

## MAJOR Findings (2)

### M1 — No UNIQUE Constraint on (user_id, entity_name_normalized) — Race Condition (Line 328)

The duplicate check on line 328 calls _findByNormalisedName which is a SELECT query not protected by any transaction or row lock. The transaction does not start until line 341. Two concurrent captureEntity calls with the same name (e.g. "Max" and "max") can both pass the SELECT check and both INSERT duplicates. The database has 13 constraints but zero UNIQUE constraints to prevent this.

Fix: Add partial unique index: CREATE UNIQUE INDEX idx_user_entity_normalized ON cotw_user_taught_entities(user_id, entity_name_normalized) WHERE forgotten = false

### M2 — International Character Stripping (Line 149)

_normaliseName uses /[^a-z0-9\s]/g which strips all non-ASCII characters. "Jose" becomes "jos", "cafe" becomes "caf", any CJK name becomes an empty string. Japanese users (project target audience) cannot store native names properly. Distinct names collapse to the same normalized form creating false duplicate detection.

Fix: Use Unicode-aware normalization. Preserve CJK/Japanese characters, normalize to NFKC, or use PostgreSQL unaccent extension for accent-only stripping.

---

## NOTED (Not Scored — Cross-File Infrastructure)

### N1 — pool.connect() Missing Timeout (Line 338)

pool.connect() on line 338 lacks a timeout. Can hang indefinitely on pool exhaustion. This is a pool-level concern that applies to every file in the codebase that calls pool.connect(). Needs to be addressed at pool configuration level rather than per-module.

Identified by: Kimi (classified as MAJOR for this file). Reclassified to cross-file infrastructure note during reconciliation.

---

## MINOR Findings (4)

### m1 — Duplicate Check Runs Outside Transaction (Lines 328 vs 341)

_findByNormalisedName on line 328 uses pool.query (line 255), not a transaction client. The transaction does not begin until line 341. Even with a UNIQUE constraint added per M1, the check-then-act gap means the duplicate path (return existing) could race with the insert path.

Fix: Move duplicate check inside the transaction with FOR SHARE lock, or rely solely on database constraint catching violations.

### m2 — SLANG Bridge Creates Orphan Risk on Rollback (Lines 361-376)

learningCapturer.captureTeaching() on line 363 runs inside the captureEntity transaction block but almost certainly acquires its own database connection and transaction internally. If the main INSERT on line 378 fails and rolls back, the SLANG entry in cotw_user_language persists orphaned. The vocabulary entry would exist without a parent entity.

Fix: Move SLANG bridge outside transaction: capture entity first then bridge, or use two-phase commit pattern.

### m3 — Error Returns Indistinguishable From Empty Results

Several methods return the same value for "no results" and "database error":

- getUserEntities returns [] on error (line 530) — same as "user has no entities"
- getEntityCount returns 0 on error (line 561) — same as "zero entities"
- findByName returns null on error (line 703) — same as "no match"
- findStaleEntities returns null on error (line 745) — same as "nothing stale"

Callers cannot distinguish a successful empty result from a database failure.

### m4 — PAD Shape Partial Validation (Line 163)

Only checks padCoordinates.p exists. Does not validate a and d coordinates or numeric ranges. Potential NaN propagation if partial PAD objects are passed.

---

## Documentation Discrepancy

Header on line 88 says "33 columns" but the database schema returned 34 rows.

---

## Cross-File Pattern Check

| Pattern | Status |
|---|---|
| 1: Falsy Zero | ABSENT — hardcoded constants only, no ENV values |
| 2: No Query Timeout | NOTED — pool.connect() relies on pool defaults (N1) |
| 3: Timer Leak | ABSENT |
| 4: Non-Deterministic | ABSENT — deterministic phonetic matching |
| 5: Speaker Hardcoding | ABSENT — fully parameterised by userId |
| 6: PAD Shape | PARTIAL — line 163 validates p only, not full {p, a, d} |

---

## B-Roll Readiness: READY

All methods are parameterised by userId. No character-specific logic, no hardcoded identities. Fully B-Roll compatible. Entity capture/recall pattern could extend to NPC memory systems.

---

## Positive Findings

- Transaction discipline on captureEntity — hex ID generation and INSERT in same transaction (lines 341-430)
- Memory budget enforcement with eviction policy (lines 204-242) — oldest zero-reference, lowest-confidence entity evicted first
- Soft delete pattern preserves audit trail for GDPR compliance (lines 627-658)
- Fuzzy recall using trigram similarity + phonetic matching across 4 algorithms (lines 677-694)
- Reconfirmation system with staleness detection and emotional weight boost (lines 720-800)
- Emotional weight calculated from PAD pleasure coordinate with proper clamping (lines 162-168)
- SLANG bridge to learningCapturer with graceful degradation on failure (lines 361-376)
- Input validation on all public methods with appropriate error types (throw vs return)
- Paginated retrieval with clamped limits (lines 489-495)
- Preferred name fallback pattern (lines 812-815)
- Comprehensive INSERT with phonetic indices generated server-side via soundex/metaphone/dmetaphone (lines 399-400)
- 14 structured log events across all operations
- All constants frozen at module level (lines 115-130)
- Singleton export pattern per naming conventions (line 844)
- Context field truncated to 500 chars (line 414)
- Confidence level to human-readable label mapping (lines 828-837)

---

## Wave 5 Progress (3 of 6)

| No | File | Score |
|---|---|---|
| 25 | KnowledgeRetriever.js | 89 |
| 26 | cotwIntentMatcher.js | 84 |
| 27 | taughtEntityCapturer.js | 87 |

3 remaining.

---

*Generated from consensus review. Claude initial: 87. Kimi independent: 87. Consensus: 87. pool.connect() timeout noted as cross-file infrastructure issue per Kimi.*
