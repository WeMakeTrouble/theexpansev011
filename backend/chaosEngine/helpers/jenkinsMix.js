/**
 * ===========================================================================
 * jenkinsMix.js — Jenkins Lookup3 Hash Mixing Function
 * ===========================================================================
 *
 * PURPOSE:
 * Combines three 32-bit integer values into a single 32-bit unsigned
 * integer with strong avalanche properties. Used by the Chaos Engine
 * seeding pipeline to derive isolated sub-seeds at each level:
 *
 *   base_seed + episode number  → episode_seed
 *   episode_seed + belt enum   → belt_layer_seed
 *   belt_layer_seed + slot seq → slot_seed
 *
 * ALGORITHM:
 * Bob Jenkins' lookup3 mixing function. Nine rounds of subtraction,
 * XOR, and bit shifting across three accumulators (a, b, c). Returns
 * accumulator c as the mixed 32-bit unsigned result.
 *
 * Each round uses different shift widths (13, 8, 13, 12, 16, 5, 3,
 * 10, 15) chosen by Jenkins to maximise bit diffusion. After nine
 * rounds, every input bit has influenced every output bit.
 *
 * ISOLATION PROPERTY:
 * The third parameter (c) is a salt constant that changes at each
 * pipeline level. This ensures:
 *   - Episode seeds are independent (changing Ep1 doesn't affect Ep7)
 *   - Belt layers are independent (Blue generated Day 30 = Blue Day 90)
 *   - Slot PRNG streams are independent (no shared state between slots)
 *
 * USAGE IN CHAOS ENGINE (via ChaosSeeder.js):
 *   Episode seed:    jenkinsMix(baseSeed, episodeNumber, 0x9e3779b9)
 *   Belt layer seed: jenkinsMix(episodeSeed, beltEnum, 0xdeadbeef)
 *   Slot seed:       jenkinsMix(layerSeed, slotSequence, 0x85ebca6b)
 *
 * SALT CONSTANTS:
 *   0x9e3779b9 — Golden ratio fractional part. Classic hash constant.
 *   0xdeadbeef — Widely used mixing constant in hash literature.
 *   0x85ebca6b — From MurmurHash3 finaliser. Strong bit diffusion.
 *
 * REFERENCE:
 *   Jenkins, Bob. "lookup3.c" (2006).
 *   http://burtleburtle.net/bob/hash/doobs.html
 *
 * WARNING: Not cryptographically secure. Never use for auth, tokens,
 * or security-sensitive operations.
 *
 * DEPENDENCIES: None. Pure function. No imports.
 *
 * EXPORTS:
 *   jenkinsMix(a, b, c) → 32-bit unsigned integer
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Seeding Pipeline
 * ===========================================================================
 */

/**
 * Jenkins one-at-a-time hash mixing.
 * Combines three 32-bit values into one with good avalanche properties.
 *
 * @param {number} a - First value (e.g., base seed)
 * @param {number} b - Second value (e.g., episode number)
 * @param {number} c - Third value (salt/constant)
 * @returns {number} 32-bit unsigned mixed result
 */
export function jenkinsMix(a, b, c) {
    a = (a - b - c) ^ (c >>> 13);
    b = (b - c - a) ^ (a << 8);
    c = (c - a - b) ^ (b >>> 13);
    a = (a - b - c) ^ (c >>> 12);
    b = (b - c - a) ^ (a << 16);
    c = (c - a - b) ^ (b >>> 5);
    a = (a - b - c) ^ (c >>> 3);
    b = (b - c - a) ^ (a << 10);
    c = (c - a - b) ^ (b >>> 15);

    return c >>> 0;
}
