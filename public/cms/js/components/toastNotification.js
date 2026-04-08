/**
 * ============================================================================
 * Toast Notification — Temporary Status Messages for CMS Admin Tool
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * A lightweight notification system that displays temporary success, error,
 * warning, and info messages. Messages appear at the bottom of the screen,
 * stack if multiple fire, and auto-dismiss after a configurable duration.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import toast from '../components/toastNotification.js';
 *
 *   toast.success('Character saved');
 *   toast.error('Failed to save character');
 *   toast.warn('Unsaved changes will be lost');
 *   toast.info('Loading 42 knowledge items...');
 *
 * OPTIONS:
 * ---------------------------------------------------------------------------
 *   toast.success('Saved', { duration: 5000 });  // 5 second display
 *   toast.error('Failed', { persistent: true });  // stays until dismissed
 *
 * CONTAINER:
 * ---------------------------------------------------------------------------
 * Renders into the #toast-container element defined in index.html (line 183).
 * The container has role="alert" and aria-live="assertive" for screen readers.
 *
 * STYLING:
 * ---------------------------------------------------------------------------
 * Uses CSS classes defined in cms-styles.css:
 *   .toast               Base toast styles
 *   .toast--success       Green (#00ff75)
 *   .toast--error         Red (#ff4444)
 *   .toast--warn          Amber (#ffaa00)
 *   .toast--info          Blue (#4488ff)
 *   .toast--exiting       Fade-out animation class
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * Version: v010.1
 * ============================================================================
 */

const TOAST_VERSION = 'v010.1';

const DEFAULTS = Object.freeze({
  DURATION_MS: 3000,
  MAX_VISIBLE: 5,
  EXIT_ANIMATION_MS: 300
});

const _metrics = {
  totalShown: 0,
  totalDismissed: 0,
  countByType: { success: 0, error: 0, warn: 0, info: 0 }
};

/**
 * Active toast elements for cleanup and stacking
 * @type {Set<HTMLElement>}
 */
const _activeToasts = new Set();

/**
 * Reference to the toast container element
 * @type {HTMLElement|null}
 */
let _container = null;

/**
 * Get or cache the toast container element
 * @returns {HTMLElement|null}
 */
function _getContainer() {
  if (!_container) {
    _container = document.getElementById('toast-container');
  }
  return _container;
}

/**
 * Sanitise text for safe innerHTML insertion
 * @param {string} str - Raw string
 * @returns {string} HTML-safe string
 */
function _sanitise(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Dismiss a toast element with exit animation
 * @param {HTMLElement} el - Toast element to dismiss
 */
function _dismiss(el) {
  if (!_activeToasts.has(el)) return;

  el.classList.add('toast--exiting');
  _metrics.totalDismissed++;

  setTimeout(() => {
    _activeToasts.delete(el);
    el.remove();
  }, DEFAULTS.EXIT_ANIMATION_MS);
}

/**
 * Enforce maximum visible toasts by dismissing oldest
 */
function _enforceMax() {
  while (_activeToasts.size >= DEFAULTS.MAX_VISIBLE) {
    const oldest = _activeToasts.values().next().value;
    if (oldest) _dismiss(oldest);
  }
}

/**
 * Show a toast notification
 *
 * @param {string} message - Text to display
 * @param {string} type - One of: success, error, warn, info
 * @param {object} options - Optional: { duration, persistent }
 * @returns {HTMLElement} The toast element (for programmatic dismiss)
 */
function _show(message, type, options = {}) {
  const container = _getContainer();
  if (!container) return null;

  _enforceMax();

  const duration = options.persistent ? 0 : (options.duration || DEFAULTS.DURATION_MS);

  const el = document.createElement('div');
  el.classList.add('toast', `toast--${type}`);
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const messageSpan = document.createElement('span');
  messageSpan.classList.add('toast__message');
  messageSpan.innerHTML = _sanitise(message);
  el.appendChild(messageSpan);

  const dismissBtn = document.createElement('button');
  dismissBtn.classList.add('toast__dismiss');
  dismissBtn.setAttribute('aria-label', 'Dismiss notification');
  dismissBtn.textContent = '\u00D7';
  dismissBtn.addEventListener('click', () => _dismiss(el), { once: true });
  el.appendChild(dismissBtn);

  container.appendChild(el);
  _activeToasts.add(el);

  _metrics.totalShown++;
  _metrics.countByType[type] = (_metrics.countByType[type] || 0) + 1;

  if (duration > 0) {
    setTimeout(() => _dismiss(el), duration);
  }

  return el;
}

const toast = Object.freeze({

  /**
   * Show a success toast (green)
   * @param {string} message
   * @param {object} options - Optional: { duration, persistent }
   * @returns {HTMLElement|null}
   */
  success(message, options) {
    return _show(message, 'success', options);
  },

  /**
   * Show an error toast (red)
   * @param {string} message
   * @param {object} options - Optional: { duration, persistent }
   * @returns {HTMLElement|null}
   */
  error(message, options) {
    return _show(message, 'error', { duration: 5000, ...options });
  },

  /**
   * Show a warning toast (amber)
   * @param {string} message
   * @param {object} options - Optional: { duration, persistent }
   * @returns {HTMLElement|null}
   */
  warn(message, options) {
    return _show(message, 'warn', options);
  },

  /**
   * Show an info toast (blue)
   * @param {string} message
   * @param {object} options - Optional: { duration, persistent }
   * @returns {HTMLElement|null}
   */
  info(message, options) {
    return _show(message, 'info', options);
  },

  /**
   * Dismiss all active toasts immediately
   */
  dismissAll() {
    for (const el of _activeToasts) {
      _dismiss(el);
    }
  },

  /**
   * Get toast metrics for diagnostics
   * @returns {object}
   */
  getMetrics() {
    return {
      version: TOAST_VERSION,
      ..._metrics,
      activeCount: _activeToasts.size
    };
  }
});

export default toast;
