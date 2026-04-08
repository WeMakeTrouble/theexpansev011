/**
 * ============================================================================
 * View Controller — Navigation Router for COTW User Terminal
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Listens to cotw:navigate events dispatched by cotwMenu.js and routes
 * them to the correct view module. Manages view lifecycle including cleanup
 * of previous views via AbortController, loading states, and error display.
 *
 * HOW IT WORKS:
 * ---------------------------------------------------------------------------
 * 1. View modules register themselves:
 *      cotwViewController.register('dossier-profile', handler)
 *
 * 2. cotwMenu.js dispatches cotw:navigate with { section, item, label }
 *
 * 3. cotwViewController catches the event, looks up the registered handler,
 *    aborts the previous view, and calls the new handler with:
 *      { container, params, signal, api, navigateTo }
 *
 * REGISTRATION:
 * ---------------------------------------------------------------------------
 * View modules register by item ID (not section). This gives each menu
 * item its own handler. Example:
 *
 *   cotwViewController.register('dossier-profile', async (ctx) => {
 *     const data = await ctx.api.get('/dossier/profile');
 *     ctx.container.textContent = data.username;
 *   });
 *
 * The item ID comes directly from cotwMenu.js MENU_SECTIONS data.
 *
 * LIFECYCLE:
 * ---------------------------------------------------------------------------
 * - Previous view's AbortController is aborted (cancels in-flight requests)
 * - New AbortController created for the incoming view
 * - Handler receives { container, params, signal, api, navigateTo }
 * - If handler throws, error is displayed in the container (sanitised)
 * - Post-handler abort guard prevents stale DOM writes
 *
 * DEDUPLICATION:
 * ---------------------------------------------------------------------------
 * If the user clicks the same menu item that is already active, the
 * navigation is skipped. This prevents unnecessary abort-and-reload
 * cycles during rapid clicking.
 *
 * UNREGISTERED VIEWS:
 * ---------------------------------------------------------------------------
 * If no handler is registered for an item ID, the controller displays a
 * placeholder message. This allows incremental development — we build one
 * view module at a time and unbuilt sections show a friendly message.
 *
 * METRICS:
 * ---------------------------------------------------------------------------
 * Tracks navigation count, handler duration, error count, and per-item
 * load times. Access via cotwViewController.getMetrics().
 *
 * DEPENDENCIES:
 * ---------------------------------------------------------------------------
 * - cotwApiClient.js (passed to handlers as ctx.api)
 * - cotwMenu.js (dispatches cotw:navigate events)
 * - cotw-dossier.html #content-display container
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Created: March 8, 2026
 * ============================================================================
 */

import cotwApiClient from './cotwApiClient.js';

const VIEW_CONTROLLER_VERSION = 'v010.1';

/**
 * Registry of item ID to handler function
 * @type {Map<string, function>}
 */
const _handlers = new Map();

/**
 * Current active AbortController for the displayed view
 * @type {AbortController|null}
 */
let _activeController = null;

/**
 * Current active item ID for duplicate navigation detection
 * @type {string|null}
 */
let _activeItem = null;

/**
 * Reference to the content display container
 * @type {HTMLElement|null}
 */
let _container = null;

/**
 * Reference to the content status indicator
 * @type {HTMLElement|null}
 */
let _statusEl = null;

/**
 * Navigation history stack (internal record, not browser history)
 * @type {Array<{section: string, item: string, label: string, timestamp: number}>}
 */
const _history = [];

/**
 * Maximum history entries to retain
 * @type {number}
 */
const MAX_HISTORY = 50;

/**
 * Metrics collector for navigation diagnostics
 */
const _metrics = {
  totalNavigations: 0,
  totalErrors: 0,
  totalSkipped: 0,
  totalUnregistered: 0,
  handlerDurationSum: 0,
  handlerDurationMax: 0,
  itemLoadCounts: {},
  lastError: null
};

/**
 * Sanitise a string for safe insertion into innerHTML.
 * Escapes HTML entities to prevent XSS via error messages.
 *
 * @param {string} str - Raw string to sanitise
 * @returns {string} HTML-safe string
 */
function _sanitise(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Register a view handler for a menu item ID
 *
 * @param {string} itemId - The item ID from cotwMenu.js (e.g., 'dossier-profile')
 * @param {function} handler - Async function receiving { container, params, signal, api, navigateTo }
 */
function register(itemId, handler) {
  if (typeof handler !== 'function') {
    throw new Error(`View handler for '${itemId}' must be a function`);
  }
  if (_handlers.has(itemId)) {
    throw new Error(`View handler for '${itemId}' already registered`);
  }
  _handlers.set(itemId, handler);
}

/**
 * Navigate to a specific item view programmatically.
 * Used by view modules to trigger sub-navigation.
 *
 * @param {string} section - Section ID (e.g., 'dossier')
 * @param {string} item - Item ID (e.g., 'dossier-profile')
 * @param {string} label - Display label (e.g., 'Profile')
 */
function navigateTo(section, item, label) {
  document.dispatchEvent(new CustomEvent('cotw:navigate', {
    detail: Object.freeze({
      section,
      item,
      label,
      returnFocus: () => {}
    })
  }));
}

/**
 * Handle incoming cotw:navigate events.
 * Called by the event listener attached during init().
 *
 * @param {CustomEvent} event - The cotw:navigate event
 */
async function _handleNavigate(event) {
  const { section, item, label } = event.detail;

  if (!_container) {
    _container = document.getElementById('content-display');
    _statusEl = document.getElementById('content-status');
  }

  if (!_container) {
    return;
  }

  if (_activeItem === item && _activeController && !_activeController.signal.aborted) {
    _metrics.totalSkipped++;
    return;
  }

  if (_activeController) {
    _activeController.abort();
    _activeController = null;
  }

  _activeItem = item;
  _activeController = new AbortController();
  const { signal } = _activeController;

  _metrics.totalNavigations++;
  _metrics.itemLoadCounts[item] = (_metrics.itemLoadCounts[item] ?? 0) + 1;

  _history.push({
    section,
    item,
    label,
    timestamp: Date.now()
  });
  if (_history.length > MAX_HISTORY) {
    _history.shift();
  }

  const handler = _handlers.get(item);

  if (!handler) {
    _metrics.totalUnregistered++;
    _container.innerHTML = [
      '<div class="content-placeholder">',
      '  <div class="content-placeholder__icon" aria-hidden="true">&#x25C9;</div>',
      '  <div class="content-placeholder__text">',
      '    ' + _sanitise(label) + '<br>',
      '    View module not yet built.<br>',
      '    This feature is coming soon.',
      '  </div>',
      '</div>'
    ].join('\n');

    if (_statusEl) {
      _statusEl.textContent = label;
    }
    return;
  }

  _container.innerHTML = [
    '<div class="content-placeholder">',
    '  <div class="content-placeholder__icon" aria-hidden="true">&#x25C9;</div>',
    '  <div class="content-placeholder__text">Loading...</div>',
    '</div>'
  ].join('\n');

  if (_statusEl) {
    _statusEl.textContent = 'Loading...';
  }

  const startTime = performance.now();

  try {
    await handler({
      container: _container,
      params: {
        section,
        item,
        label
      },
      signal,
      api: cotwApiClient,
      navigateTo
    });

    if (signal.aborted) {
      return;
    }

    const duration = performance.now() - startTime;
    _metrics.handlerDurationSum += duration;
    if (duration > _metrics.handlerDurationMax) {
      _metrics.handlerDurationMax = duration;
    }

    if (_statusEl && _activeItem === item) {
      _statusEl.textContent = label;
    }

  } catch (error) {
    if (error.name === 'AbortError' || signal.aborted) {
      return;
    }

    const duration = performance.now() - startTime;
    _metrics.totalErrors++;
    _metrics.lastError = {
      item,
      message: error.message,
      timestamp: Date.now(),
      duration
    };

    if (_activeItem === item && !signal.aborted) {
      _container.innerHTML = [
        '<div class="content-placeholder">',
        '  <div class="content-placeholder__icon" aria-hidden="true">&#x2716;</div>',
        '  <div class="content-placeholder__text">',
        '    Error loading ' + _sanitise(label) + '<br>',
        '    ' + _sanitise(error.message),
        '  </div>',
        '</div>'
      ].join('\n');

      if (_statusEl) {
        _statusEl.textContent = 'Error';
      }
    }
  }
}

/**
 * Get the internal navigation history (read-only copy)
 * @returns {Array<object>}
 */
function getHistory() {
  return [..._history];
}

/**
 * Get the count of registered view handlers
 * @returns {number}
 */
function getRegisteredCount() {
  return _handlers.size;
}

/**
 * Get all registered item IDs
 * @returns {Array<string>}
 */
function getRegisteredItems() {
  return [..._handlers.keys()];
}

/**
 * Get navigation metrics for diagnostics
 * @returns {object} Metrics snapshot including counts, durations, errors
 */
function getMetrics() {
  return {
    version: VIEW_CONTROLLER_VERSION,
    ..._metrics,
    handlerDurationAvg: _metrics.totalNavigations > 0
      ? Math.round(_metrics.handlerDurationSum / _metrics.totalNavigations)
      : 0,
    registeredHandlers: _handlers.size,
    historyDepth: _history.length
  };
}

/**
 * Initialise the view controller.
 * Attaches the cotw:navigate listener.
 *
 * @param {AbortSignal} signal - Optional abort signal for cleanup
 */
function init(signal) {
  document.addEventListener('cotw:navigate', _handleNavigate, { signal });
}

const cotwViewController = Object.freeze({
  register,
  navigateTo,
  init,
  getHistory,
  getRegisteredCount,
  getRegisteredItems,
  getMetrics
});

export default cotwViewController;
