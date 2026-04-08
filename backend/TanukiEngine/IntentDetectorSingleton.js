/**
 * ============================================================================
 * IntentDetectorSingleton.js — Shared IntentDetector Instance (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Exports a single shared IntentDetector instance so that EarWig and
 * PhaseIntent use the same temporal memory and feedback system.
 *
 * Without this, EarWig and PhaseIntent would each create their own
 * IntentDetector instance with separate turnHistory maps, meaning
 * temporal drift detection would not work across the system.
 *
 * USAGE
 * -----
 * import intentDetector from './IntentDetectorSingleton.js';
 * const result = intentDetector.detect(input, { conversationId });
 *
 * CRITICAL DESIGN DECISION (EarWig Brief Part 3.4):
 * PhaseIntent.js line 65 creates a module-level IntentDetector instance.
 * That must be replaced with an import of this singleton. Both EarWig
 * and PhaseIntent must import from this file, not create their own.
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import IntentDetector from './IntentDetector.js';

const intentDetector = new IntentDetector({
  debug: false,
  enableFeedback: true
});

export default intentDetector;
