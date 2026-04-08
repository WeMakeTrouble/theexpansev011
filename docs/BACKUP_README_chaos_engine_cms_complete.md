# THE EXPANSE v011 — BACKUP README
# Backup: chaos-engine-cms-complete
# Date: March 28, 2026
# Author: James (Project Manager) via Claude (Internal Architecture Lead)

## WHAT THIS BACKUP REPRESENTS

This backup captures the completion of the first CMS integration phase for the
Chaos Engine. The Seed Inspector is fully operational and tested in production.
All four Chaos Engine CMS menu items are registered and navigable.

## WHAT WAS BUILT IN THIS SESSION

### 1. backend/routes/adminChaosEngine.js (NEW FILE)
Express router mounted at /api/admin/chaos-engine.
Two endpoints:
  - GET  /health — DB reachability check
  - POST /inspect — Seed Inspector: accepts hexId, episode, beltLevel,
    returns full seed chain (baseSeed, episodeSeed, beltLayerSeed, PRNG values)
    and distribution result (quality, frozen state, asset list).
    Intentionally generates and persists a distribution if none exists —
    this is correct behaviour for an admin diagnostic tool, not a bug.
    See ARCHITECTURAL CONSTRAINTS block in the file header for full rationale.

Scored 87-94/100 across three external reviewers after two rounds of review.
Constraint pushback documented in file header.

### 2. backend/routes/admin.js (MODIFIED)
Added import and mount for adminChaosEngine at /chaos-engine (Phase 12).
No other changes.

### 3. public/cms/js/adminMenu.js (MODIFIED)
Added Chaos Engine section between Narratives and Curricula.
Four items:
  - chaos-engine-inspect  → Seed Inspector (functional)
  - chaos-engine-slots    → Slot Visualiser (stub — next build phase)
  - chaos-engine-batch    → Bad Seed Detector (stub — next build phase)
  - chaos-engine-dependencies → Dependency Graph (stub — next build phase)

### 4. public/cms/js/modules/chaosEngineManager.js (NEW FILE)
Frontend CMS module. Registers all four view handlers.

Seed Inspector implements a two-level drill-down pattern matching
characterManager.js — the established CMS pattern:
  Level 1: Form (Hex ID, Episode, Belt Level) + INSPECT button.
           After successful inspection, shows four section buttons.
  Level 2: Selected section content (stacked info-row pattern) + Back button.

Four drill-down sections:
  - INPUTS: echoes the validated inputs sent to the API
  - SEED CHAIN: baseSeed, episodeSeed, beltLayerSeed, PRNG[0-2]
  - DISTRIBUTION: frozen state, quality score, generation seed, attempt count
  - ASSETS: one card per asset showing slot ID, asset ID, category, tier, spine

Uses info-row / info-row__label / info-row__value CSS classes throughout —
matching the character manager pattern exactly. No tables. No grids.
All labels above values, stacked vertically.

Accessibility: htmlFor/id label associations via _labelledField() helper,
focus management after inspection (resultsArea.focus()), aria-live status.

Scored 84-92/100 across three external reviewers.

### 5. public/cms/js/cmsBootstrap.js (MODIFIED)
Added chaosEngineManager.js to VIEW_MODULES array after narrativeBlueprintManager.

## WHAT WAS REMOVED / DECIDED AGAINST

- purchaseCode field removed from Seed Inspector form.
  Rationale: purchase_code is the login gate (every user already has one),
  not a variable input to the inspector. The easter egg discount code idea
  (hiding codes in the narrative for Claude to reveal) is a separate mechanic
  living in the narrative layer, not the seed layer. Architecture supports it
  but it is not in v011 scope.

## VERIFIED PRODUCTION STATE

- npm start: clean, no errors
- Seed Inspector tested with #D00006 (James), Episode 1, white_belt
- Fresh distribution generated and persisted on first run
- Subsequent runs correctly return frozen: true
- All four section drill-downs functional
- Back button returns to Level 1 correctly
- Three stub views show correct placeholder messages

## WHAT COMES NEXT

Before engine testing:
  1. Slot Visualiser CMS tool (chaos-engine-slots)
  2. Bad Seed Detector batch processor (chaos-engine-batch)
  3. Insert representative test data: ~50 assets, ~20 slots across episodes
  4. Run validateTestVectors.js to confirm determinism
  5. Run verifyBuild.js to confirm database connectivity

Before content authoring:
  6. Dependency Graph Inspector (chaos-engine-dependencies)
  7. Calibrate solver thresholds with test data
  8. Calibrate Shichifukujin multiplier values
  9. Define belt advancement thresholds for CE domain

## KEY FILES (CHAOS ENGINE — COMPLETE AS OF THIS BACKUP)

backend/chaosEngine/
  ChaosSeeder.js        — Seeding pipeline (djb2 → Jenkins → Mulberry32)
  ChaosSolver.js        — 5-phase constraint solver
  ChaosDistributor.js   — Orchestrator: seed → solve → validate → persist
  ChaosValidator.js     — Quality scoring and re-seed logic
  chaosConfig.js        — Frozen constants (god weights, belt enums, thresholds)
  helpers/djb2.js       — djb2 hash function
  helpers/jenkinsMix.js — Jenkins one-at-a-time hash mixing
  tools/seedInspector.js      — CLI seed inspector
  tools/validateTestVectors.js — Golden path regression test
  tools/verifyBuild.js         — System health check

backend/routes/adminChaosEngine.js  — CMS API routes (NEW)
public/cms/js/modules/chaosEngineManager.js — CMS frontend module (NEW)

## GOLDEN PATH TEST VECTORS (DO NOT CHANGE)

Input: #D0000A, no purchase code
  Base seed:               2851966090
  Episode 1 seed:          2175316142
  Episode 7 seed:          2327456351
  Ep1 white_belt seed:     3842356132
  Ep1 white_belt slot0:    3199615010
  PRNG[0]:                 0.8110810071229935
  PRNG[1]:                 0.6401743933092803
  PRNG[2]:                 0.6965343763586134

Any change to these values is a breaking change to the seeding pipeline.

