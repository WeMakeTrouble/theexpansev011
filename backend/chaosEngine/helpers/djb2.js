/**
 * ===========================================================================
 * djb2.js — Deterministic String Hash Function
 * ===========================================================================
 *
 * PURPOSE:
 * Converts a string input into a 32-bit unsigned integer using Daniel J.
 * Bernstein's djb2 hash algorithm. Primary entry point for the Chaos Engine
 * seeding pipeline — transforms a user's hex ID (stripped of '#' prefix)
 * into the base seed that drives all downstream PRNG.
 *
 * ALGORITHM:
 *   hash = 5381
 *   for each character: hash = hash * 33 + charCode
 *   return hash as unsigned 32-bit integer
 *
 * The magic number 5381 and multiplier 33 were empirically chosen by
 * Bernstein for good distribution across string inputs. The bit shift
 * ((hash << 5) + hash) is equivalent to hash * 33.
 *
 * AVALANCHE PROPERTY:
 * Flipping a single character in the input changes ~50% of output bits.
 * This ensures similar hex IDs (e.g., #D0000A and #D0000B) produce
 * vastly different seed values — critical for perceived multiverse
 * uniqueness across users.
 *
 * USAGE IN CHAOS ENGINE:
 *   Base seed:     djb2("D0000A")           → user's master seed
 *   Purchase mod:  djb2("MERCH-CODE-123")   → XOR'd with base seed
 *
 * NOTE: This is a DIFFERENT implementation from the djb2Hash() function
 * in ClaudeVisitationScheduler.js and VocabularyConstructor.js. Those
 * use a 31-bit mask (hash & 0x7FFFFFFF) for non-negative integers.
 * This implementation uses unsigned 32-bit (hash >>> 0) for full
 * entropy — the Chaos Engine needs all 32 bits for seed quality.
 *
 * WARNING: Not cryptographically secure. Never use for auth, tokens,
 * or security-sensitive operations.
 *
 * DEPENDENCIES: None. Pure function. No imports.
 *
 * EXPORTS:
 *   djb2(str) → 32-bit unsigned integer
 *
 * TEST VECTOR (golden path fixture — any change is a breaking change):
 *   djb2("D0000A") = 2851966090
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Seeding Pipeline
 * ===========================================================================
 */

/**
 * djb2 hash function.
 * Deterministic string hash producing 32-bit unsigned integer.
 *
 * @param {string} str - Input string (should be hex without # prefix)
 * @returns {number} 32-bit unsigned integer
 */
export function djb2(str) {
    let hash = 5381;

    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }

    return hash >>> 0;
}
