/**
 * ============================================================================
 * API Client — HTTP Communication Layer for CMS Admin Tool
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * A fetch wrapper that every view module uses to talk to the backend.
 * Handles auth, hex ID URL encoding, error states, request cancellation,
 * timeouts, retry with backoff, request deduplication, and observability.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import apiClient from './apiClient.js';
 *
 *   const characters = await apiClient.get('/characters');
 *   await apiClient.put('/characters/#700002', { character_name: 'Claude' });
 *   await apiClient.upload('/assets/upload', file, { description: 'Portrait' });
 *
 * ALL ENDPOINTS ARE RELATIVE TO /api/admin (configurable via API_BASE).
 *
 * HEX ID ENCODING:
 * ---------------------------------------------------------------------------
 * Hex IDs contain '#' which is invalid in URLs. This client encodes them
 * automatically when found in endpoint paths. Callers can pass either:
 *   apiClient.get('/characters/#700002')   — auto-encoded
 *   apiClient.get('/characters/%23700002') — already encoded
 *
 * TIMEOUT:
 * ---------------------------------------------------------------------------
 * All requests have a default timeout of 15 seconds. Uploads default to
 * 120 seconds. Callers can override via options.timeoutMs.
 *
 * RETRY:
 * ---------------------------------------------------------------------------
 * Idempotent requests (GET, PUT, DELETE) retry up to 2 times on 5xx errors
 * with exponential backoff (1s, 2s). POST and uploads do NOT retry.
 * Callers can override via options.retries (set to 0 to disable).
 *
 * DEDUPLICATION:
 * ---------------------------------------------------------------------------
 * Identical concurrent GET requests share a single in-flight promise.
 * If two view modules request GET /characters at the same time, only one
 * HTTP request is made. Both callers receive the same resolved data.
 *
 * OBSERVABILITY:
 * ---------------------------------------------------------------------------
 * Every request logs timing data via an internal metrics collector.
 * Access metrics via apiClient.getMetrics() for diagnostics.
 *
 * ERROR HANDLING:
 * ---------------------------------------------------------------------------
 * - 401 → Redirects to /cms/cms-login.html (session expired)
 * - 403 → Throws 'Insufficient privileges'
 * - 400 → Throws with server-provided error details
 * - 5xx → Retries (if idempotent), then throws 'Server error'
 * - Timeout → Throws 'Request timed out'
 * - AbortError → Returns null (view changed, request cancelled)
 *
 * AUTH:
 * ---------------------------------------------------------------------------
 * Uses cookie-based session auth (express-session with httpOnly cookie).
 * The browser sends the session cookie automatically on every fetch.
 * No manual token management needed.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * ============================================================================
 */

const API_BASE = '/api/admin';

const DEFAULT_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 120000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;

const _pending = new Map();

const _metrics = {
  totalRequests: 0,
  totalErrors: 0,
  totalRetries: 0,
  totalDeduped: 0,
  totalTimeouts: 0,
  latencySum: 0,
  latencyMax: 0,
  lastError: null,
  statusCounts: {}
};

/**
 * Record metrics for a completed request
 * @param {number} startTime - performance.now() start value
 * @param {number} status - HTTP status code (0 for network error)
 * @param {boolean} isError - Whether this request ended in error
 */
function _recordMetrics(startTime, status, isError) {
  const latency = performance.now() - startTime;
  _metrics.totalRequests++;
  _metrics.latencySum += latency;
  if (latency > _metrics.latencyMax) {
    _metrics.latencyMax = latency;
  }
  _metrics.statusCounts[status] = (_metrics.statusCounts[status] || 0) + 1;
  if (isError) {
    _metrics.totalErrors++;
  }
}

const apiClient = {

  /**
   * Internal fetch handler with timeout enforcement
   * @param {string} endpoint - Path relative to API_BASE (e.g., '/characters')
   * @param {object} options - Fetch options (method, body, headers, signal, timeoutMs)
   * @returns {Promise<object|null>} Parsed JSON response, or null if aborted
   */
  async _fetch(endpoint, options = {}) {
    const encodedEndpoint = endpoint.replace(/#/g, '%23');
    const url = `${API_BASE}${encodedEndpoint}`;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    const headers = {
      'Accept': 'application/json',
      ...options.headers
    };

    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

    const externalSignal = options.signal;

    let combinedSignal;
    if (externalSignal) {
      const combined = new AbortController();
      externalSignal.addEventListener('abort', () => combined.abort(), { once: true });
      timeoutController.signal.addEventListener('abort', () => combined.abort(), { once: true });
      combinedSignal = combined.signal;
    } else {
      combinedSignal = timeoutController.signal;
    }

    const startTime = performance.now();

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body || undefined,
        credentials: 'same-origin',
        signal: combinedSignal
      });

      clearTimeout(timeoutId);
      _recordMetrics(startTime, response.status, !response.ok);

      if (response.status === 401) {
        window.location.href = '/cms/cms-login.html';
        throw new Error('Session expired');
      }

      if (response.status === 403) {
        throw new Error('Insufficient privileges');
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: 'Unknown error' }));
        const error = new Error(errorBody.error || `HTTP ${response.status}`);
        error.statusCode = response.status;
        error.details = errorBody.details || null;
        throw error;
      }

      return await response.json();

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        if (externalSignal && externalSignal.aborted) {
          return null;
        }
        _metrics.totalTimeouts++;
        _recordMetrics(startTime, 0, true);
        const timeoutError = new Error('Request timed out');
        timeoutError.statusCode = 0;
        timeoutError.isTimeout = true;
        throw timeoutError;
      }

      _recordMetrics(startTime, error.statusCode || 0, true);
      throw error;
    }
  },

  /**
   * Fetch with retry logic for idempotent requests
   * Retries on 5xx errors with exponential backoff
   * @param {string} endpoint - Path relative to API_BASE
   * @param {object} options - Fetch options + retries count
   * @returns {Promise<object|null>}
   */
  async _fetchWithRetry(endpoint, options = {}) {
    const maxRetries = options.retries !== undefined ? options.retries : DEFAULT_RETRIES;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._fetch(endpoint, options);
      } catch (error) {
        lastError = error;

        if (error.statusCode === 401 || error.statusCode === 403) {
          throw error;
        }

        if (error.name === 'AbortError' || error.statusCode === 400) {
          throw error;
        }

        if (attempt < maxRetries && (error.statusCode >= 500 || error.isTimeout)) {
          _metrics.totalRetries++;
          const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  },

  /**
   * GET request (deduplicated, retryable)
   * @param {string} endpoint - Path relative to API_BASE
   * @param {object} options - Optional: { signal, timeoutMs, retries }
   * @returns {Promise<object|null>}
   */
  get(endpoint, options = {}) {
    const dedupeKey = `GET:${endpoint}`;

    if (_pending.has(dedupeKey)) {
      _metrics.totalDeduped++;
      return _pending.get(dedupeKey);
    }

    const promise = this._fetchWithRetry(endpoint, { ...options, method: 'GET' })
      .finally(() => _pending.delete(dedupeKey));

    _pending.set(dedupeKey, promise);
    return promise;
  },

  /**
   * POST request (no retry — not idempotent)
   * @param {string} endpoint - Path relative to API_BASE
   * @param {object} body - Request payload
   * @param {object} options - Optional: { signal, timeoutMs }
   * @returns {Promise<object|null>}
   */
  post(endpoint, body, options = {}) {
    return this._fetch(endpoint, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  /**
   * PUT request (retryable — idempotent)
   * @param {string} endpoint - Path relative to API_BASE
   * @param {object} body - Request payload
   * @param {object} options - Optional: { signal, timeoutMs, retries }
   * @returns {Promise<object|null>}
   */
  put(endpoint, body, options = {}) {
    return this._fetchWithRetry(endpoint, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body)
    });
  },

  patch(endpoint, body, options = {}) {
    return this._fetchWithRetry(endpoint, {
      ...options,
      method: 'PATCH',
      body: JSON.stringify(body)
    });
  },

  /**
   * DELETE request (retryable — idempotent)
   * @param {string} endpoint - Path relative to API_BASE
   * @param {object} options - Optional: { signal, timeoutMs, retries }
   * @returns {Promise<object|null>}
   */
  delete(endpoint, options = {}) {
    return this._fetchWithRetry(endpoint, { ...options, method: 'DELETE' });
  },

  /**
   * File upload via multipart/form-data (no retry — not idempotent)
   * Uses extended timeout (120s default) for large files
   * Content-Type is NOT set manually — browser sets it with boundary
   * @param {string} endpoint - Path relative to API_BASE
   * @param {File} file - File object from input or drag-and-drop
   * @param {object} metadata - Optional fields: { description, tags }
   * @param {object} options - Optional: { signal, timeoutMs }
   * @returns {Promise<object|null>}
   */
  upload(endpoint, file, metadata = {}, options = {}) {
    const formData = new FormData();
    formData.append('file', file);

    for (const [key, value] of Object.entries(metadata)) {
      formData.append(key, value);
    }

    return this._fetch(endpoint, {
      ...options,
      method: 'POST',
      body: formData,
      headers: {},
      timeoutMs: options.timeoutMs || UPLOAD_TIMEOUT_MS
    });
  },

  /**
   * Returns current request metrics for diagnostics
   * @returns {object} Metrics snapshot including counts, latency, status codes
   */
  getMetrics() {
    return {
      ..._metrics,
      latencyAvg: _metrics.totalRequests > 0
        ? Math.round(_metrics.latencySum / _metrics.totalRequests)
        : 0,
      pendingRequests: _pending.size
    };
  },

  /**
   * Resets all metrics counters (useful for testing)
   */
  resetMetrics() {
    _metrics.totalRequests = 0;
    _metrics.totalErrors = 0;
    _metrics.totalRetries = 0;
    _metrics.totalDeduped = 0;
    _metrics.totalTimeouts = 0;
    _metrics.latencySum = 0;
    _metrics.latencyMax = 0;
    _metrics.lastError = null;
    _metrics.statusCounts = {};
  }
};

export default apiClient;
