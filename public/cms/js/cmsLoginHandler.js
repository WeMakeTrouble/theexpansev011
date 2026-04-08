/**
 * ============================================================================
 * CMS Login Handler — Admin Authentication Controller
 * File: public/cms/js/cmsLoginHandler.js
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * Handles the CMS admin login form submission. Authenticates via
 * POST /auth/login, verifies the returned access_level >= 11 (admin),
 * and redirects to /cms/ on success.
 *
 * This is separate from the COTW loginHandler.js because:
 * - Different redirect target (/cms/ vs /cotw/cotw-dossier.html)
 * - Admin access level verification (access_level >= 11)
 * - Different page title and error messaging
 *
 * RESPONSIBILITIES:
 * ---------------------------------------------------------------------------
 * - Check existing session on page load (auto-redirect if admin)
 * - Submit credentials to /auth/login
 * - Verify access_level >= 11 in auth/check response
 * - Display error messages on failure with screen reader announcement
 * - Manage button loading state (prevent double-submit)
 * - Client-side rate limiting (5 attempts, 5-minute lockout)
 * - Per-request timeout via AbortController
 * - Clean up event listeners via AbortController on unload
 *
 * FLOW:
 * ---------------------------------------------------------------------------
 * 1. init() called on page load (auto-init at bottom of file)
 * 2. checkExistingSession() calls GET /auth/check
 *    - If authenticated AND access_level >= 11 -> redirect to /cms/
 *    - If authenticated but access_level < 11 -> stay on login page
 *    - If not authenticated -> stay on login page
 * 3. User submits form -> handleLogin()
 *    - POST /auth/login with { username, password }
 *    - On success -> GET /auth/check to verify access_level
 *    - If access_level >= 11 -> redirect to /cms/
 *    - If access_level < 11 -> show "Insufficient privileges" error
 *    - On auth failure -> show generic error
 *
 * SECURITY:
 * ---------------------------------------------------------------------------
 * - No inline scripts (loaded as ES module)
 * - credentials: 'include' on all fetch calls (session cookie)
 * - No password logging
 * - Generic error messages only (no server message passthrough)
 * - CSRF token included if meta tag present
 * - Rate limiting to prevent brute force (5 attempts, 5-min lockout)
 * - Request timeout (10s) to prevent hanging
 *
 * ACCESSIBILITY (WCAG 2.2 AA+):
 * ---------------------------------------------------------------------------
 * - Error region uses role="alert" aria-live="assertive"
 * - Focus moves to first invalid field on error
 * - aria-busy on submit button during loading
 * - Class-based visibility toggling (no inline style mutation)
 *
 * CONSUMERS:
 * ---------------------------------------------------------------------------
 * public/cms/cms-login.html
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 1 — Character Management (Admin Access)
 * Author: James (Project Manager)
 * Created: February 23, 2026
 * ============================================================================
 */

const MODULE = '[CmsLoginHandler]';

/* ============================================================================
 * CONSTANTS
 * ============================================================================ */

const CONSTANTS = Object.freeze({
  REDIRECT_TARGET: '/cms/',
  AUTH_LOGIN_URL: '/auth/login',
  AUTH_CHECK_URL: '/auth/check',
  ADMIN_ACCESS_LEVEL: 11,
  BUTTON_TEXT_DEFAULT: 'AUTHENTICATE',
  BUTTON_TEXT_LOADING: 'AUTHENTICATING...',
  REQUEST_TIMEOUT_MS: 10000,
  MAX_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 300000,
  ERROR_GENERIC_AUTH: 'Authentication failed. Check your credentials.',
  ERROR_GENERIC_SERVER: 'Server error. Please try again later.',
  ERROR_CONNECTION: 'Connection error. Please check your network.',
  ERROR_TIMEOUT: 'Request timed out. Please try again.',
  ERROR_RATE_LIMITED: 'Too many attempts. Please wait before trying again.',
  ERROR_MISSING_FIELDS: 'Username and password required.',
  ERROR_INSUFFICIENT: 'Insufficient privileges. Admin access (level 11) required.'
});

const CSS_CLASSES = Object.freeze({
  ERROR_VISIBLE: 'login-error--visible',
  BUTTON_LOADING: 'login-submit--loading'
});

/* ============================================================================
 * MODULE STATE
 * ============================================================================ */

const state = Object.seal({
  isInitialized: false,
  attemptCount: 0,
  lockoutUntil: 0,
  lifecycleController: new AbortController()
});

/* ============================================================================
 * DOM REFERENCES
 * ============================================================================ */

let formEl = null;
let usernameEl = null;
let passwordEl = null;
let submitEl = null;
let errorEl = null;

/**
 * Cache DOM references. Called once during init.
 * @returns {boolean} True if all elements found
 */
function cacheDomRefs() {
  formEl = document.getElementById('login-form');
  usernameEl = document.querySelector('[data-testid="login-username"]');
  passwordEl = document.querySelector('[data-testid="login-password"]');
  submitEl = document.querySelector('[data-testid="login-submit"]');
  errorEl = document.getElementById('error-message');

  if (!formEl || !usernameEl || !passwordEl || !submitEl || !errorEl) {
    console.error(MODULE, 'Required DOM elements not found');
    return false;
  }
  return true;
}

/* ============================================================================
 * CSRF
 * ============================================================================ */

/**
 * Get CSRF token from meta tag if present.
 * @returns {string|null} CSRF token or null
 */
function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : null;
}

/* ============================================================================
 * RATE LIMITING
 * ============================================================================ */

/**
 * Check if rate limit allows another attempt.
 * @returns {{ allowed: boolean, message: string|null }}
 */
function checkRateLimit() {
  const now = Date.now();

  if (state.lockoutUntil > now) {
    const remainingMs = state.lockoutUntil - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    return {
      allowed: false,
      message: CONSTANTS.ERROR_RATE_LIMITED + ' Try again in ' + remainingMin + ' minute' + (remainingMin !== 1 ? 's' : '') + '.'
    };
  }

  if (state.lockoutUntil > 0 && state.lockoutUntil <= now) {
    state.attemptCount = 0;
    state.lockoutUntil = 0;
  }

  return { allowed: true, message: null };
}

/**
 * Record a failed login attempt. Triggers lockout after MAX_ATTEMPTS.
 */
function recordFailedAttempt() {
  state.attemptCount++;
  if (state.attemptCount >= CONSTANTS.MAX_ATTEMPTS) {
    state.lockoutUntil = Date.now() + CONSTANTS.LOCKOUT_DURATION_MS;
    console.warn(MODULE, 'Rate limit triggered, lockout active');
  }
}

/**
 * Reset attempt counter (on successful login).
 */
function resetAttempts() {
  state.attemptCount = 0;
  state.lockoutUntil = 0;
}

/* ============================================================================
 * ERROR DISPLAY
 * ============================================================================ */

/**
 * Show error message with screen reader announcement.
 * @param {string} message - Error text to display
 */
function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.add(CSS_CLASSES.ERROR_VISIBLE);
  errorEl.setAttribute('aria-hidden', 'false');
}

/**
 * Hide error message.
 */
function hideError() {
  if (!errorEl) return;
  errorEl.textContent = '';
  errorEl.classList.remove(CSS_CLASSES.ERROR_VISIBLE);
  errorEl.setAttribute('aria-hidden', 'true');
}

/* ============================================================================
 * LOADING STATE
 * ============================================================================ */

/**
 * Set button loading state.
 * @param {boolean} isLoading - Whether button should show loading state
 */
function setLoading(isLoading) {
  if (!submitEl) return;
  submitEl.disabled = isLoading;
  submitEl.textContent = isLoading
    ? CONSTANTS.BUTTON_TEXT_LOADING
    : CONSTANTS.BUTTON_TEXT_DEFAULT;
  submitEl.setAttribute('aria-busy', String(isLoading));

  if (isLoading) {
    submitEl.classList.add(CSS_CLASSES.BUTTON_LOADING);
  } else {
    submitEl.classList.remove(CSS_CLASSES.BUTTON_LOADING);
  }
}

/* ============================================================================
 * SESSION CHECK — Verifies admin access level
 * ============================================================================ */

/**
 * Check if user is already authenticated with admin privileges.
 * Redirects to /cms/ if access_level >= 11.
 * @returns {Promise<void>}
 */
async function checkExistingSession() {
  try {
    const response = await fetch(CONSTANTS.AUTH_CHECK_URL, {
      credentials: 'include'
    });

    if (!response.ok) return;

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.warn(MODULE, 'Session check response not JSON');
      return;
    }

    if (data.authenticated && data.user && data.user.access_level >= CONSTANTS.ADMIN_ACCESS_LEVEL) {
      console.info(MODULE, 'Existing admin session found, redirecting');
      window.location.href = CONSTANTS.REDIRECT_TARGET;
    }
  } catch (err) {
    console.warn(MODULE, 'Session check failed', err.message);
  }
}

/* ============================================================================
 * LOGIN HANDLER — Authenticates and verifies admin level
 * ============================================================================ */

/**
 * Handle login form submission.
 * POSTs credentials, then verifies admin access level via /auth/check.
 * @param {SubmitEvent} event - Form submit event
 * @returns {Promise<void>}
 */
async function handleLogin(event) {
  event.preventDefault();

  const username = usernameEl.value.trim();
  const password = passwordEl.value;

  hideError();

  if (!username || !password) {
    showError(CONSTANTS.ERROR_MISSING_FIELDS);
    const focusTarget = !username ? usernameEl : passwordEl;
    focusTarget.focus();
    return;
  }

  const rateCheck = checkRateLimit();
  if (!rateCheck.allowed) {
    showError(rateCheck.message);
    return;
  }

  setLoading(true);

  const requestController = new AbortController();
  const timeoutId = setTimeout(() => requestController.abort(), CONSTANTS.REQUEST_TIMEOUT_MS);

  try {
    const headers = { 'Content-Type': 'application/json' };
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const loginResponse = await fetch(CONSTANTS.AUTH_LOGIN_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username, password }),
      credentials: 'include',
      signal: requestController.signal
    });

    clearTimeout(timeoutId);

    if (!loginResponse.ok) {
      recordFailedAttempt();
      if (loginResponse.status === 401) {
        showError(CONSTANTS.ERROR_GENERIC_AUTH);
      } else if (loginResponse.status >= 500) {
        showError(CONSTANTS.ERROR_GENERIC_SERVER);
      } else {
        showError(CONSTANTS.ERROR_GENERIC_AUTH);
      }
      usernameEl.focus();
      setLoading(false);
      return;
    }

    let loginData;
    try {
      loginData = await loginResponse.json();
    } catch (parseErr) {
      console.error(MODULE, 'Login response not valid JSON');
      showError(CONSTANTS.ERROR_GENERIC_SERVER);
      setLoading(false);
      return;
    }

    if (!loginData.success) {
      recordFailedAttempt();
      console.warn(MODULE, 'Login returned success:false');
      showError(CONSTANTS.ERROR_GENERIC_AUTH);
      usernameEl.focus();
      setLoading(false);
      return;
    }

    const checkResponse = await fetch(CONSTANTS.AUTH_CHECK_URL, {
      credentials: 'include'
    });

    if (!checkResponse.ok) {
      console.error(MODULE, 'Auth check failed after login');
      showError(CONSTANTS.ERROR_GENERIC_SERVER);
      setLoading(false);
      return;
    }

    let checkData;
    try {
      checkData = await checkResponse.json();
    } catch (parseErr) {
      console.error(MODULE, 'Auth check response not valid JSON');
      showError(CONSTANTS.ERROR_GENERIC_SERVER);
      setLoading(false);
      return;
    }

    if (checkData.authenticated && checkData.user && checkData.user.access_level >= CONSTANTS.ADMIN_ACCESS_LEVEL) {
      resetAttempts();
      console.info(MODULE, 'Admin login successful, redirecting');
      window.location.href = CONSTANTS.REDIRECT_TARGET;
    } else {
      recordFailedAttempt();
      console.warn(MODULE, 'Login succeeded but insufficient access level', {
        level: checkData.user ? checkData.user.access_level : 'unknown'
      });
      showError(CONSTANTS.ERROR_INSUFFICIENT);
      usernameEl.focus();
      setLoading(false);
    }

  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      console.warn(MODULE, 'Login request timed out');
      showError(CONSTANTS.ERROR_TIMEOUT);
    } else {
      console.error(MODULE, 'Login request failed', err.message);
      showError(CONSTANTS.ERROR_CONNECTION);
    }
    recordFailedAttempt();
    setLoading(false);
  }
}

/* ============================================================================
 * LIFECYCLE
 * ============================================================================ */

/**
 * Initialize CMS login handler. Idempotent.
 * @returns {boolean} True if initialization succeeded
 */
function init() {
  if (state.isInitialized) {
    console.warn(MODULE, 'Already initialized');
    return true;
  }

  if (!cacheDomRefs()) {
    return false;
  }

  formEl.addEventListener('submit', handleLogin, {
    signal: state.lifecycleController.signal
  });

  state.isInitialized = true;
  console.info(MODULE, 'Initialized');

  checkExistingSession();
  return true;
}

/**
 * Destroy CMS login handler. Cleans up all event listeners.
 */
function destroy() {
  state.lifecycleController.abort();
  state.isInitialized = false;
  formEl = null;
  usernameEl = null;
  passwordEl = null;
  submitEl = null;
  errorEl = null;
  console.info(MODULE, 'Destroyed');
}

/* ============================================================================
 * AUTO-INIT
 * ============================================================================ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

window.addEventListener('unload', destroy, { once: true });

/* ============================================================================
 * EXPORTS
 * ============================================================================ */

export { init, destroy, handleLogin, checkExistingSession };
export default { init, destroy };
