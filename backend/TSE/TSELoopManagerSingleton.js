/**
 * ============================================================================
 * TSELoopManagerSingleton.js — Shared TSELoopManager Instance
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Provides a single shared instance of TSELoopManager across the system.
 * BrainOrchestrator and any future consumers import getTSELoopManager()
 * to access the same instance, ensuring consistent session state.
 *
 * PATTERN
 * -------
 * Lazy singleton: instance created on first call to getTSELoopManager().
 * Matches IntentDetectorSingleton.js pattern used elsewhere in v010.
 *
 * CONSUMERS
 * ---------
 * - BrainOrchestrator.js (TSE resume logic, post-phase signal resolution)
 *
 * DEPENDENCIES
 * ------------
 * - TSELoopManager (backend/TSE/TSELoopManager.js)
 *
 * External: None
 * ============================================================================
 */

import TSELoopManager from './TSELoopManager.js';
import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('TSELoopManagerSingleton');

let instance = null;

/**
 * Returns the shared TSELoopManager instance.
 * Creates it on first call (lazy initialisation).
 * @returns {TSELoopManager}
 */
export function getTSELoopManager() {
  if (!instance) {
    instance = new TSELoopManager();
    logger.info('TSELoopManager singleton created');
  }
  return instance;
}
