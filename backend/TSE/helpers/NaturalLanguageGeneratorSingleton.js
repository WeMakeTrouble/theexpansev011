/**
 * ============================================================================
 * NaturalLanguageGeneratorSingleton.js — Shared NLG Instance (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Provides a single shared instance of NaturalLanguageGenerator so all
 * consumers share one cache and seeded RNG state. Without this, each
 * consumer would create its own instance with a separate cache, wasting
 * memory and losing cross-module cache hits.
 *
 * CONSUMERS
 * ---------
 * - StorytellerBridge.js
 * - TeacherComponent.js
 * - KnowledgeResponseEngine.js
 * - StorytellerContextAssembler.js
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import NaturalLanguageGenerator from './NaturalLanguageGenerator.js';

let instance = null;

export function getNaturalLanguageGenerator() {
  if (!instance) {
    instance = new NaturalLanguageGenerator();
  }
  return instance;
}
