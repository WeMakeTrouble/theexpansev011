/**
 * ============================================================================
 * COTW Bootstrap — Module Loader & Initialisation Orchestrator
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * The entry point that wires together all COTW user terminal infrastructure.
 * Loaded by cotw-dossier.html via <script type="module" src="js/cotwBootstrap.js">.
 * Imports core modules, initialises the view controller, and dynamically
 * loads available view modules.
 *
 * BOOT SEQUENCE:
 * ---------------------------------------------------------------------------
 * 1. Import cotwApiClient (HTTP communication layer)
 * 2. Import cotwViewController (navigation router)
 * 3. Create AbortController for bootstrap lifecycle
 * 4. Initialise cotwViewController with abort signal
 * 5. Dynamically import available view modules (non-blocking)
 * 6. Log boot status to console (module count, duration)
 *
 * VIEW MODULE LOADING:
 * ---------------------------------------------------------------------------
 * View modules are imported dynamically via import(). Each module is
 * expected to call cotwViewController.register() during its own initialisation.
 * Failed imports are caught individually — one broken module does not
 * prevent the rest from loading.
 *
 * ADDING NEW VIEW MODULES:
 * ---------------------------------------------------------------------------
 * When a new view module is built, add it to the VIEW_MODULES array:
 *
 *   { path: './modules/myNewView.js', name: 'My New View' }
 *
 * The module must call cotwViewController.register() internally.
 * No changes needed to cotwViewController, cotwApiClient, or cotw-dossier.html.
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * - cotwViewController.js (navigation router)
 * - cotwApiClient.js (HTTP layer, used by view modules)
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Created: March 8, 2026
 * ============================================================================
 */

import cotwViewController from './cotwViewController.js';

const BOOTSTRAP_VERSION = 'v010.1';

/**
 * View modules to load, in priority order.
 * Each module must call cotwViewController.register() during import.
 * Failed imports are caught individually and do not block other modules.
 *
 * Add new modules here as they are built:
 *   Dossier views
 *   Language views
 *   Progression views
 *   Discovery views
 *   Session views
 *   Psychic views (Radar, Moods)
 *   Ockham's Razor view
 *   Tanuki view
 *
 * @type {ReadonlyArray<{path: string, name: string}>}
 */
const VIEW_MODULES = Object.freeze([
    // Dossier
    // { path: './modules/dossierView.js', name: 'Dossier View' },
    // Language
    // { path: './modules/languageView.js', name: 'Language View' },
    // Progression
    // { path: './modules/progressionView.js', name: 'Progression View' },
    // Discovery
    // { path: './modules/discoveryView.js', name: 'Discovery View' },
    // Sessions
    // { path: './modules/sessionsView.js', name: 'Sessions View' },
    // Psychic
    // { path: './modules/psychicView.js', name: 'Psychic View' },
    { path: './modules/cotwPsychicRadarView.js', name: 'Psychic Radar' },
    // Ockham's Razor
    // { path: './modules/ockhamsRazorView.js', name: 'Ockhams Razor View' },
    { path: './modules/cotwOckhamsRazorView.js', name: 'Ockhams Razor' },
    // Tanuki
    // { path: './modules/tanukiView.js', name: 'Tanuki View' },
    // WWDD
    { path: './modules/cotwWwddView.js', name: 'WWDD Gunsight' },
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

    cotwViewController.init(abortController.signal);

    const activeModules = VIEW_MODULES.filter(m => m.path);

    if (activeModules.length > 0) {
        const results = await Promise.allSettled(
            activeModules.map(m => _loadModule(m))
        );

        const failed = results.filter(r => r.status === 'fulfilled' && r.value === false).length;

        if (failed > 0) {
            _bootMetrics.failures.forEach(f => {
                console.warn(
                    `[COTW Bootstrap] Failed to load ${f.name}: ${f.error}`
                );
            });
        }
    }

    _bootMetrics.endTime = performance.now();

    const duration = Math.round(_bootMetrics.endTime - _bootMetrics.startTime);
    const registered = cotwViewController.getRegisteredCount();

    console.info(
        `[COTW Bootstrap] ${BOOTSTRAP_VERSION} ready in ${duration}ms` +
        ` | ${registered} view handler(s) registered` +
        ` | ${_bootMetrics.modulesLoaded}/${_bootMetrics.modulesAttempted} modules loaded`
    );
}

/**
 * Get boot metrics for diagnostics
 * @returns {object} Boot metrics snapshot
 */
function getBootMetrics() {
    return {
        version: BOOTSTRAP_VERSION,
        ..._bootMetrics,
        bootDuration: Math.round(_bootMetrics.endTime - _bootMetrics.startTime),
        registeredHandlers: cotwViewController.getRegisteredCount(),
        registeredItems: cotwViewController.getRegisteredItems()
    };
}

window.__COTW_BOOT_METRICS__ = getBootMetrics;

bootstrap();
