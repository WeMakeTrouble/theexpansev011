/**
 * ============================================================================
 * CMS Bootstrap — Module Loader & Initialisation Orchestrator
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * The entry point that wires together all CMS admin tool infrastructure.
 * Loaded by index.html via <script type="module" src="js/cmsBootstrap.js">.
 * Imports core modules, initialises the view controller, and dynamically
 * loads available view modules.
 *
 * BOOT SEQUENCE:
 * ---------------------------------------------------------------------------
 * 1. Import apiClient (HTTP communication layer)
 * 2. Import viewController (navigation router)
 * 3. Create AbortController for bootstrap lifecycle
 * 4. Initialise viewController with abort signal
 * 5. Dynamically import available view modules (non-blocking)
 * 6. Log boot status to console (module count, duration)
 *
 * VIEW MODULE LOADING:
 * ---------------------------------------------------------------------------
 * View modules are imported dynamically via import(). Each module is
 * expected to call viewController.register() during its own initialisation.
 * Failed imports are caught individually — one broken module does not
 * prevent the rest from loading.
 *
 * Modules are loaded in priority order (characters first, system last)
 * matching the Phase dependency chain from the build plan.
 *
 * ADDING NEW VIEW MODULES:
 * ---------------------------------------------------------------------------
 * When a new view module is built, add it to the VIEW_MODULES array:
 *
 *   { path: './modules/myNewManager.js', name: 'My New Manager' }
 *
 * The module must call viewController.register() internally.
 * No changes needed to viewController, apiClient, or index.html.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * Version: v010.1
 * ============================================================================
 */

import viewController from './viewController.js';

const BOOTSTRAP_VERSION = 'v010.1';

/**
 * View modules to load, in priority order.
 * Each module must call viewController.register() during import.
 * Failed imports are caught individually and do not block other modules.
 *
 * Add new modules here as they are built in each phase:
 * Phase 1: characterManager
 * Phase 2: knowledgeManager
 * Phase 3: narrativeManager
 * Phase 4: curriculumManager
 * Phase 5: dialogueManager
 * Phase 6: assetManager
 * Phase 7: worldManager
 * Phase 8: tseManager, psychicManager
 * Phase 9: userManager
 * Phase 10: systemManager
 *
 * @type {ReadonlyArray<{path: string, name: string}>}
 */
const VIEW_MODULES = Object.freeze([
  // Phase 1
  { path: './modules/characterManager.js', name: 'Character Manager' },
  // Phase 2
  // { path: './modules/knowledgeManager.js', name: 'Knowledge Manager' },
  // Phase 3
  // { path: './modules/narrativeManager.js', name: 'Narrative Manager' },
  { path: './modules/narrativeBlueprintManager.js', name: 'Narrative Blueprint Manager' },
  // Chaos Engine
  { path: './modules/chaosEngineManager.js', name: 'Chaos Engine Manager' },
  // Phase 4
  // { path: './modules/curriculumManager.js', name: 'Curriculum Manager' },
  // Phase 5
  // { path: './modules/dialogueManager.js', name: 'Dialogue Manager' },
  // Phase 6
  { path: './modules/assetManager.js', name: 'Asset Manager' },
  // Phase 7
  // { path: './modules/worldManager.js', name: 'World Manager' },
  // Phase 8
  // { path: './modules/tseManager.js', name: 'TSE Manager' },
  { path: './modules/ockhamsRazorView.js', name: 'Ockhams Razor' },
  { path: './modules/psychicRadarView.js', name: 'Psychic Radar' },
  { path: './modules/wwddGunsightView.js', name: 'WWDD Gunsight' },
  { path: './modules/merchManager.js', name: 'Merch Manager' },
  { path: './modules/purchaseCodesManager.js', name: 'Purchase Codes Manager' },
  // Phase 9
  // { path: './modules/userManager.js', name: 'User Manager' },
  // Phase 10
  // { path: './modules/systemManager.js', name: 'System Manager' },
]);

/**
 * Boot metrics for diagnostics
 */
const _bootMetrics = {
  startTime: performance.now(),
  endTime: 0,
  modulesAttempted: 0,
  modulesLoaded: 0,
  modulesFailed: 0,
  failures: []
};

/**
 * Load a single view module with error isolation.
 * Each module is imported independently so a failure in one
 * does not prevent others from loading.
 *
 * @param {object} moduleConfig - { path: string, name: string }
 * @returns {Promise<boolean>} True if loaded successfully
 */
async function _loadModule(moduleConfig) {
  _bootMetrics.modulesAttempted++;

  try {
    await import(moduleConfig.path);
    _bootMetrics.modulesLoaded++;
    return true;
  } catch (error) {
    _bootMetrics.modulesFailed++;
    _bootMetrics.failures.push({
      name: moduleConfig.name,
      path: moduleConfig.path,
      error: error.message
    });
    return false;
  }
}

/**
 * Main bootstrap function.
 * Initialises the view controller, loads all available view modules,
 * and reports boot status.
 */
async function bootstrap() {
  const abortController = new AbortController();

  viewController.init(abortController.signal);

  const activeModules = VIEW_MODULES.filter(m => m.path);

  if (activeModules.length > 0) {
    const results = await Promise.allSettled(
      activeModules.map(m => _loadModule(m))
    );

    const loaded = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const failed = results.filter(r => r.status === 'fulfilled' && r.value === false).length;

    if (failed > 0) {
      _bootMetrics.failures.forEach(f => {
        /* eslint-disable-next-line no-console */
        console.warn(
          `[CMS Bootstrap] Failed to load ${f.name}: ${f.error}`
        );
      });
    }
  }

  _bootMetrics.endTime = performance.now();

  const duration = Math.round(_bootMetrics.endTime - _bootMetrics.startTime);
  const registered = viewController.getRegisteredCount();

  /* eslint-disable-next-line no-console */
  console.info(
    `[CMS Bootstrap] ${BOOTSTRAP_VERSION} ready in ${duration}ms` +
    ` | ${registered} view handler(s) registered` +
    ` | ${_bootMetrics.modulesLoaded}/${_bootMetrics.modulesAttempted} modules loaded`
  );
}

/**
 * Get boot metrics for diagnostics (available on window for admin console)
 * @returns {object} Boot metrics snapshot
 */
function getBootMetrics() {
  return {
    version: BOOTSTRAP_VERSION,
    ..._bootMetrics,
    bootDuration: Math.round(_bootMetrics.endTime - _bootMetrics.startTime),
    registeredHandlers: viewController.getRegisteredCount(),
    registeredItems: viewController.getRegisteredItems()
  };
}

window.__CMS_BOOT_METRICS__ = getBootMetrics;

bootstrap();
