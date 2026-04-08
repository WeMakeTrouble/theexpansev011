/**
 * ============================================================================
 * Mulberry32 — Deterministic Pseudo-Random Number Generator
 * ============================================================================
 *
 * Returns a function that produces deterministic random floats (0–1)
 * from a given integer seed. Same seed always produces the same
 * sequence, guaranteeing identical CRT noise across runs.
 *
 * Used by the noise effect to add analog signal grain to processed
 * images. The seed is either provided explicitly or derived from
 * the input image hash (see imageProcessor.js).
 *
 * No external dependencies. No Math.random(). Pure determinism.
 *
 * WARNING: This is NOT cryptographically secure. Use strictly for
 * visual noise generation. Never use for IDs, tokens, or auth.
 *
 * @param {number} inputSeed - Integer seed value
 * @returns {function(): number} Generator returning floats 0–1
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Image Support)
 * ============================================================================
 */

export function mulberry32(inputSeed) {
  let seed = inputSeed >>> 0;
  return function() {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
