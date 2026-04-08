/**
 * ============================================================================
 * loginHandler.js — COTW Login Form Controller (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Handles the login form submission for Council of the Wise terminal access.
 * Authenticates via POST /auth/login, redirects on success.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Check existing session on page load (auto-redirect if authenticated)
 *  - Submit credentials to /auth/login
 *  - Display error messages on failure with screen reader announcement
 *  - Manage button loading state (prevent double-submit)
 *  - Client-side rate limiting (5 attempts, 5-minute lockout)
 *  - Per-request timeout via AbortController
 *  - Clean up event listeners via AbortController on unload
 *
 * SECURITY
 * --------
 *  - No inline scripts (loaded as ES module)
 *  - credentials: 'include' on all fetch calls (session cookie)
 *  - No password logging
 *  - Generic error messages only (no server message passthrough)
 *  - CSRF token included if meta tag present
 *  - Rate limiting to prevent brute force
 *  - Request timeout (10s) to prevent hanging
 *
 * ACCESSIBILITY (WCAG 2.2 AA+)
 * -----------------------------
 *  - Error region uses role="alert" aria-live="assertive"
 *  - Focus moves to first invalid field on error
 *  - aria-busy on submit button during loading
 *  - Class-based visibility toggling (no inline style mutation)
 *
 * FRONTEND LOGGING
 * ----------------
 *  - console.info/warn/error with [LoginHandler] prefix
 *  - No console.log (matches v010 frontend standard)
 *
 * CONSUMERS
 * ---------
 *  - public/cotw/cotw-login.html
 *
 * EXPORTS
 * -------
 *  - init, destroy, handleLogin, checkExistingSession (named)
 *  - default: { init, destroy }
 *
 * ============================================================================
 * Project: The Expanse v010
 * Author: James (Project Manager)
 * Date: February 13, 2026
 * ============================================================================
 */

const MODULE = '[LoginHandler]';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants (Frozen)                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const CONSTANTS = Object.freeze({
  REDIRECT_TARGET: '/cotw/cotw-dossier.html',
  AUTH_LOGIN_URL: '/auth/login',
  AUTH_CHECK_URL: '/auth/check',
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
  ERROR_MISSING_FIELDS: 'Username and password required.'
});

const CSS_CLASSES = Object.freeze({
  ERROR_VISIBLE: 'login-error--visible',
  BUTTON_LOADING: 'login-submit--loading'
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  Module State (Sealed)                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

const state = Object.seal({
  isInitialized: false,
  attemptCount: 0,
  lockoutUntil: 0,
  lifecycleController: new AbortController()
});

/* ────────────────────────────────────────────────────────────────────────── */
/*  DOM References (cached on init)                                          */
/* ────────────────────────────────────────────────────────────────────────── */

let formEl = null;
let usernameEl = null;
let passwordEl = null;
let submitEl = null;
let errorEl = null;

/**
 * Cache DOM references. Called once during init.
 *
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

/* ────────────────────────────────────────────────────────────────────────── */
/*  CSRF                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Get CSRF token from meta tag if present.
 *
 * @returns {string|null} CSRF token or null
 */
function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Rate Limiting                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Check if rate limit allows another attempt.
 *
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

/* ────────────────────────────────────────────────────────────────────────── */
/*  Error Display (Class-Based, Accessible)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Show error message with screen reader announcement.
 *
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

/* ────────────────────────────────────────────────────────────────────────── */
/*  Loading State                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Set button loading state.
 *
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

/* ────────────────────────────────────────────────────────────────────────── */
/*  Session Check                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Check if user is already authenticated. Redirect if so.
 *
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

    if (data.authenticated) {
      console.info(MODULE, 'Existing session found, redirecting');
      window.location.href = CONSTANTS.REDIRECT_TARGET;
    }
  } catch (err) {
    console.warn(MODULE, 'Session check failed', err.message);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Login Handler                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle login form submission.
 *
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

    const response = await fetch(CONSTANTS.AUTH_LOGIN_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username, password }),
      credentials: 'include',
      signal: requestController.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      recordFailedAttempt();
      if (response.status === 401) {
        showError(CONSTANTS.ERROR_GENERIC_AUTH);
      } else if (response.status >= 500) {
        showError(CONSTANTS.ERROR_GENERIC_SERVER);
      } else {
        showError(CONSTANTS.ERROR_GENERIC_AUTH);
      }
      usernameEl.focus();
      setLoading(false);
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.error(MODULE, 'Login response not valid JSON');
      showError(CONSTANTS.ERROR_GENERIC_SERVER);
      setLoading(false);
      return;
    }

    if (data.success) {
      resetAttempts();
      console.info(MODULE, 'Login successful, redirecting');
      window.location.href = CONSTANTS.REDIRECT_TARGET;
    } else {
      recordFailedAttempt();
      console.warn(MODULE, 'Login returned success:false');
      showError(CONSTANTS.ERROR_GENERIC_AUTH);
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

/* ────────────────────────────────────────────────────────────────────────── */
/*  Lifecycle                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Initialize login handler. Idempotent — safe to call multiple times.
 *
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
 * Destroy login handler. Cleans up all event listeners.
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

window.addEventListener('unload', destroy, { once: true });

init();

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports (for testability)                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export { init, destroy, handleLogin, checkExistingSession };
export default { init, destroy };
