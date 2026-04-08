#!/usr/bin/env node
/**
 * ===========================================================================
 * validateTestVectors.js — Golden Path Regression Test
 * ===========================================================================
 *
 * PURPOSE:
 * Validates that the Chaos Engine seeding pipeline produces identical
 * output across runs. If any value in this test changes, something in
 * djb2, jenkinsMix, ChaosSeeder, or the salt constants has been altered.
 * That is a BREAKING CHANGE — all stored distributions become invalid.
 *
 * USAGE:
 *   node validateTestVectors.js
 *
 * EXIT CODES:
 *   0 — All vectors match. Determinism intact.
 *   1 — Mismatch detected. Pipeline is broken.
 *
 * GOLDEN PATH VECTORS (computed and verified March 27, 2026):
 *   Input: "#D0000A", no purchase code
 *   djb2("D0000A")           = 2851966090
 *   Base seed                = 2851966090
 *   Episode 1 seed           = 2175316142
 *   Episode 7 seed           = 2327456351
 *   Ep1 white_belt seed      = 3842356132
 *   Ep1 white_belt slot0     = 3199615010
 *   PRNG[0] (slot0)          = 0.8110810071229935
 *   PRNG[1] (slot0)          = 0.6401743933092803
 *   PRNG[2] (slot0)          = 0.6965343763586134
 *
 * WHAT THIS TESTS:
 *   1. djb2 hash produces correct base seed
 *   2. ChaosSeeder base seed matches djb2 output
 *   3. Episode seeds are correct and isolated
 *   4. Belt layer seeds are correct and isolated
 *   5. Slot seeds produce correct PRNG streams
 *   6. Same seed + same slot = identical PRNG values (determinism)
 *   7. Different slots produce different PRNG streams (isolation)
 *
 * DEPENDENCIES:
 *   - ChaosSeeder (../ChaosSeeder.js)
 *   - djb2 (../helpers/djb2.js)
 *   - No database connection required. Pure computation only.
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Regression Testing
 * ===========================================================================
 */

import { ChaosSeeder } from '../ChaosSeeder.js';
import { djb2 } from '../helpers/djb2.js';

// ---------------------------------------------------------------------------
// GOLDEN PATH FIXTURES — DO NOT CHANGE
// These values are the verified output of the seeding pipeline.
// Any deviation means the pipeline has been altered.
// ---------------------------------------------------------------------------

const TEST_HEX = '#D0000A';

const GOLDEN = Object.freeze({
    djb2:            2851966090,
    baseSeed:        2851966090,
    episode1Seed:    2175316142,
    episode7Seed:    2327456351,
    ep1WhiteLayer:   3842356132,
    ep1WhiteSlot0:   3199615010,
    prng0:           0.8110810071229935,
    prng1:           0.6401743933092803,
    prng2:           0.6965343763586134
});

// ---------------------------------------------------------------------------
// TEST EXECUTION
// ---------------------------------------------------------------------------

let failures = 0;

function assert(label, actual, expected) {
    if (actual === expected) {
        console.log(`  ✅ ${label}: ${actual}`);
    } else {
        console.error(`  ❌ ${label}: got ${actual}, expected ${expected}`);
        failures++;
    }
}

console.log(`\n🧪 Golden Path Regression Test for ${TEST_HEX}\n`);

// Test 1: djb2 hash
console.log('--- djb2 Hash ---');
const cleanHex = TEST_HEX.replace('#', '');
assert('djb2("D0000A")', djb2(cleanHex), GOLDEN.djb2);

// Test 2: ChaosSeeder base seed
console.log('\n--- Seeder Chain ---');
const seeder = new ChaosSeeder(TEST_HEX);
assert('Base seed', seeder.getBaseSeed(), GOLDEN.baseSeed);

// Test 3: Episode seeds
assert('Episode 1 seed', seeder.getEpisodeSeed(1), GOLDEN.episode1Seed);
assert('Episode 7 seed', seeder.getEpisodeSeed(7), GOLDEN.episode7Seed);

// Test 4: Belt layer seed
assert('Ep1 white_belt layer', seeder.getBeltLayerSeed(1, 'white_belt'), GOLDEN.ep1WhiteLayer);

// Test 5: Slot PRNG values
console.log('\n--- PRNG Stream (Ep1, white_belt, slot 0) ---');
const rng = seeder.getSlotRng(1, 'white_belt', 0);
assert('PRNG[0]', rng(), GOLDEN.prng0);
assert('PRNG[1]', rng(), GOLDEN.prng1);
assert('PRNG[2]', rng(), GOLDEN.prng2);

// Test 6: Determinism — same inputs produce same outputs
console.log('\n--- Determinism Verification ---');
const rngA = seeder.getSlotRng(1, 'white_belt', 0);
const rngB = seeder.getSlotRng(1, 'white_belt', 0);
const valA = rngA();
const valB = rngB();
assert('Same seed same value', valA === valB, true);

// Test 7: Isolation — different slots produce different streams
console.log('\n--- Slot Isolation ---');
const rngSlot1 = seeder.getSlotRng(1, 'white_belt', 1);
const slot1Val = rngSlot1();
assert('Slot 0 ≠ Slot 1', valA !== slot1Val, true);

// Test 8: Episode isolation — different episodes produce different seeds
console.log('\n--- Episode Isolation ---');
assert('Ep1 ≠ Ep7', seeder.getEpisodeSeed(1) !== seeder.getEpisodeSeed(7), true);

// Test 9: Belt isolation — different belts produce different layer seeds
console.log('\n--- Belt Isolation ---');
const blueSeed = seeder.getBeltLayerSeed(1, 'blue_belt');
assert('White ≠ Blue', seeder.getBeltLayerSeed(1, 'white_belt') !== blueSeed, true);

// ---------------------------------------------------------------------------
// RESULT
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(50));
if (failures === 0) {
    console.log('✅ ALL VECTORS VALIDATED — Chaos Engine is deterministic');
    process.exit(0);
} else {
    console.error(`❌ ${failures} FAILURE(S) DETECTED — Pipeline is broken`);
    process.exit(1);
}
