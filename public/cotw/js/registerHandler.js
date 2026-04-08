/**
 * ============================================================================
 * registerHandler.js — COTW Registration Form Controller (v011)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Handles the registration form submission for Council of the Wise terminal
 * access. Registers via POST /auth/register, redirects on success based on
 * whether a purchase code was claimed.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Check existing session on page load (auto-redirect if authenticated)
 *  - Submit credentials + optional purchase code to /auth/register
 *  - Redirect to cotw-dossier.html if has_purchase_code = true
 *  - Redirect to cotw-holding.html if has_purchase_code = false
 *  - Display error messages on failure with screen reader announcement
 *  - Manage button loading state (prevent double-submit)
 *  - Client-side rate limiting (5 attempts, 5-minute lockout)
 *  - Per-request timeout via AbortController
 *  - Clean up event listeners via AbortController on unload
 *  - Normalise purchase code to uppercase before submission
 *
 * SECURITY
 * --------
 *  - No inline scripts (loaded as ES module)
 *  - credentials: 'include' on all fetch calls (session cookie)
 *  - No password logging
 *  - Generic error messages only — server messages passed through only for
 *    safe field conflict errors (duplicate username/email)
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
 *  - console.info/warn/error with [RegisterHandler] prefix
 *  - No console.log (matches v011 frontend standard)
 *
 * CONSUMERS
 * ---------
 *  - public/cotw/cotw-register.html
 *
 * EXPORTS
 * -------
 *  - init, destroy, handleRegister, checkExistingSession (named)
 *  - default: { init, destroy }
 *
 * ============================================================================
 * Project: The Expanse v011
 * Author: James (Project Manager)
 * Date: March 31, 2026
 * ============================================================================
 */

const MODULE = '[RegisterHandler]';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants (Frozen)                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const CONSTANTS = Object.freeze({
  REDIRECT_CODE_HOLDER: '/cotw/cotw-dossier.html',
  REDIRECT_NO_CODE:     '/cotw/cotw-holding.html',
  AUTH_REGISTER_URL:    '/auth/register',
  AUTH_CHECK_URL:       '/auth/check',
  BUTTON_TEXT_DEFAULT:  'REGISTER',
  BUTTON_TEXT_LOADING:  'REGISTERING...',
  REQUEST_TIMEOUT_MS:   10000,
  MAX_ATTEMPTS:         5,
  LOCKOUT_DURATION_MS:  300000,
  ERROR_GENERIC_SERVER: 'Server error. Please try again later.',
  ERROR_CONNECTION:     'Connection error. Please check your network.',
  ERROR_TIMEOUT:        'Request timed out. Please try again.',
  ERROR_RATE_LIMITED:   'Too many attempts. Please wait before trying again.',
  ERROR_MISSING_FIELDS: 'Username, email and password are required.'
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

let formEl       = null;
let usernameEl   = null;
let emailEl      = null;
let passwordEl   = null;
let codeEl       = null;
let submitEl     = null;
let errorEl      = null;

/**
 * Cache DOM references. Called once during init.
 *
 * @returns {boolean} True if all required elements found
 */
function cacheDomRefs() {
  formEl     = document.getElementById('register-form');
  usernameEl = document.querySelector('[data-testid="register-username"]');
  emailEl    = document.querySelector('[data-testid="register-email"]');
  passwordEl = document.querySelector('[data-testid="register-password"]');
  codeEl     = document.querySelector('[data-testid="register-code"]');
  submitEl   = document.querySelector('[data-testid="register-submit"]');
  errorEl    = document.getElementById('error-message');

  if (!formEl || !usernameEl || !emailEl || !passwordEl || !submitEl || !errorEl) {
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
 * @returns {string|null}
 */
function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Rate Limiting                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * @returns {{ allowed: boolean, message: string|null }}
 */
function checkRateLimit() {
  const now = Date.now();

  if (state.lockoutUntil > now) {
    const remainingMs  = state.lockoutUntil - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    return {
      allowed: false,
      message: CONSTANTS.ERROR_RATE_LIMITED + ' Try again in ' +
               remainingMin + ' minute' + (remainingMin !== 1 ? 's' : '') + '.'
    };
  }

  if (state.lockoutUntil > 0 && state.lockoutUntil <= now) {
    state.attemptCount = 0;
    state.lockoutUntil = 0;
  }

  return { allowed: true, message: null };
}

function recordFailedAttempt() {
  state.attemptCount++;
  if (state.attemptCount >= CONSTANTS.MAX_ATTEMPTS) {
    state.lockoutUntil = Date.now() + CONSTANTS.LOCKOUT_DURATION_MS;
    console.warn(MODULE, 'Rate limit triggered, lockout active');
  }
}

function resetAttempts() {
  state.attemptCount = 0;
  state.lockoutUntil = 0;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Error Display (Class-Based, Accessible)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.add(CSS_CLASSES.ERROR_VISIBLE);
  errorEl.setAttribute('aria-hidden', 'false');
}

function hideError() {
  if (!errorEl) return;
  errorEl.textContent = '';
  errorEl.classList.remove(CSS_CLASSES.ERROR_VISIBLE);
  errorEl.setAttribute('aria-hidden', 'true');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Loading State                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function setLoading(isLoading) {
  if (!submitEl) return;
  submitEl.disabled     = isLoading;
  submitEl.textContent  = isLoading
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
      window.location.href = CONSTANTS.REDIRECT_CODE_HOLDER;
    }
  } catch (err) {
    console.warn(MODULE, 'Session check failed', err.message);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Register Handler                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle registration form submission.
 *
 * @param {SubmitEvent} event
 * @returns {Promise<void>}
 */
async function handleRegister(event) {
  event.preventDefault();

  const username     = usernameEl.value.trim();
  const email        = emailEl.value.trim();
  const password     = passwordEl.value;
  const purchaseCode = codeEl ? codeEl.value.trim().toUpperCase() : '';

  hideError();

  if (!username || !email || !password) {
    showError(CONSTANTS.ERROR_MISSING_FIELDS);
    const focusTarget = !username ? usernameEl : !email ? emailEl : passwordEl;
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
  const timeoutId = setTimeout(
    () => requestController.abort(),
    CONSTANTS.REQUEST_TIMEOUT_MS
  );

  try {
    const headers = { 'Content-Type': 'application/json' };
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const body = { username, email, password };
    if (purchaseCode) {
      body.purchase_code = purchaseCode;
    }

    const response = await fetch(CONSTANTS.AUTH_REGISTER_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'include',
      signal: requestController.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      recordFailedAttempt();

      let errorMessage = CONSTANTS.ERROR_GENERIC_SERVER;

      if (response.status === 400 || response.status === 409) {
        try {
          const errData = await response.json();
          if (errData.message) {
            errorMessage = errData.message;
          }
        } catch (_) { /* use generic */ }
      }

      showError(errorMessage);
      usernameEl.focus();
      setLoading(false);
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      console.error(MODULE, 'Register response not valid JSON');
      showError(CONSTANTS.ERROR_GENERIC_SERVER);
      setLoading(false);
      return;
    }

    if (data.success) {
      resetAttempts();
      const redirect = data.has_purchase_code
        ? CONSTANTS.REDIRECT_CODE_HOLDER
        : CONSTANTS.REDIRECT_NO_CODE;
      console.info(MODULE, 'Registration successful, redirecting', redirect);
      window.location.href = redirect;
    } else {
      recordFailedAttempt();
      console.warn(MODULE, 'Registration returned success:false');
      showError(data.message || CONSTANTS.ERROR_GENERIC_SERVER);
      usernameEl.focus();
      setLoading(false);
    }

  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      console.warn(MODULE, 'Registration request timed out');
      showError(CONSTANTS.ERROR_TIMEOUT);
    } else {
      console.error(MODULE, 'Registration request failed', err.message);
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
 * Initialize register handler. Idempotent — safe to call multiple times.
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

  formEl.addEventListener('submit', handleRegister, {
    signal: state.lifecycleController.signal
  });

  state.isInitialized = true;
  console.info(MODULE, 'Initialized');

  checkExistingSession();
  return true;
}

/**
 * Destroy register handler. Cleans up all event listeners.
 */
function destroy() {
  state.lifecycleController.abort();
  state.isInitialized = false;
  formEl     = null;
  usernameEl = null;
  emailEl    = null;
  passwordEl = null;
  codeEl     = null;
  submitEl   = null;
  errorEl    = null;
  console.info(MODULE, 'Destroyed');
}

window.addEventListener('unload', destroy, { once: true });

init();

/* ────────────────────────────────────────────────────────────────────────── */
/*  Exports (for testability)                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export { init, destroy, handleRegister, checkExistingSession };
export default { init, destroy };
