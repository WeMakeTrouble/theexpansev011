/**
 * ============================================================================
 * rateLimiter.js — In-Memory Rate Limiting Middleware (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Provides request rate limiting for Express HTTP routes and WebSocket
 * connections. Uses an in-memory sliding window counter per client
 * identifier (IP + userId). Automatically blocks IPs that exceed limits.
 *
 * RATE LIMIT TIERS
 * ----------------
 *   general    : 100 requests / 60 seconds  (default for all routes)
 *   auth       : 5 requests / 300 seconds   (login, registration)
 *   api        : 30 requests / 60 seconds   (API endpoints)
 *   admin      : 20 requests / 60 seconds   (admin panel)
 *   websocket  : 50 requests / 60 seconds   (socket connections)
 *
 * USAGE
 * -----
 *   import rateLimiter, { authLimiter, apiLimiter } from '../middleware/rateLimiter.js';
 *
 *   // Pre-exported middleware
 *   router.post('/login', authLimiter, loginHandler);
 *   router.get('/api/data', apiLimiter, dataHandler);
 *
 *   // Custom type
 *   router.use(rateLimiter.middleware('admin'));
 *
 *   // WebSocket
 *   rateLimiter.wsMiddleware(ws, req);
 *
 * BLOCKING BEHAVIOUR
 * ------------------
 * When a client exceeds their rate limit, their IP is blocked for
 * BLOCK_DURATION_MS (default 15 minutes). Blocked IPs receive 429
 * responses on all request types. Blocks are automatically cleared
 * by the cleanup interval.
 *
 * CONSUMERS
 * ---------
 * - server.js (global middleware)
 * - backend/routes/auth.js (authLimiter)
 * - backend/routes/admin.js (adminLimiter)
 * - backend/councilTerminal/socketHandler.js (wsMiddleware)
 *
 * LIMITATIONS
 * -----------
 * In-memory only — does not persist across server restarts and does not
 * share state across multiple server instances. For multi-instance
 * deployments, replace with Redis-backed rate limiting.
 *
 * v010 STANDARDS
 * --------------
 * - Structured logger (createModuleLogger) — no console.log
 * - Frozen constants
 * - Correlation ID threading
 * - Documentation header
 * - Input validation
 *
 * HISTORY
 * -------
 * v009: 177 lines. Functional with structured logger. Magic numbers,
 *       no frozen constants, deprecated req.connection.remoteAddress.
 * v010: Frozen constants, correlationId, documentation header, fixed
 *       deprecated API, input validation on type parameter.
 * ============================================================================
 */

import { createModuleLogger } from '../utils/logger.js';

const logger = createModuleLogger('RateLimiter');

/*
 * ============================================================================
 * Constants
 * ============================================================================
 */
const RATE_LIMITS = Object.freeze({
  general:   Object.freeze({ requests: 100, window: 60000 }),
  auth:      Object.freeze({ requests: 5,   window: 300000 }),
  api:       Object.freeze({ requests: 30,  window: 60000 }),
  admin:     Object.freeze({ requests: 20,  window: 60000 }),
  websocket: Object.freeze({ requests: 50,  window: 60000 })
});

const VALID_TYPES = Object.freeze(Object.keys(RATE_LIMITS));

const TIMING = Object.freeze({
  BLOCK_DURATION_MS: 900000,
  CLEANUP_INTERVAL_MS: 60000
});

const HTTP_STATUS = Object.freeze({
  TOO_MANY_REQUESTS: 429
});

/*
 * ============================================================================
 * RateLimiter Class
 * ============================================================================
 */
class RateLimiter {
  constructor() {
    this.requests = new Map();
    this.blockedIPs = new Map();

    setInterval(() => this._cleanup(), TIMING.CLEANUP_INTERVAL_MS);
  }

  /**
   * Removes expired request counters and unblocks IPs past their block time.
   * @private
   */
  _cleanup() {
    const now = Date.now();
    const maxWindow = Math.max(...Object.values(RATE_LIMITS).map(l => l.window));

    for (const [key, data] of this.requests.entries()) {
      if (now - data.firstRequest > maxWindow) {
        this.requests.delete(key);
      }
    }

    for (const [ip, blockTime] of this.blockedIPs.entries()) {
      if (now > blockTime) {
        this.blockedIPs.delete(ip);
        logger.info('IP unblocked after rate limit expiry', { ip });
      }
    }
  }

  /**
   * Extracts a unique client identifier from the request.
   * @param {Object} req - Express or HTTP request.
   * @returns {string} Identifier in format "ip-userId".
   */
  _getClientIdentifier(req) {
    const ip = req.headers['x-forwarded-for'] ||
               req.socket?.remoteAddress ||
               'unknown';

    const userId = req.user?.id || req.user?.user_id || 'anonymous';
    return `${ip}-${userId}`;
  }

  /**
   * Checks if an IP is currently blocked.
   * @param {string} identifier - Client identifier.
   * @returns {boolean} True if blocked.
   */
  _isBlocked(identifier) {
    const ip = identifier.split('-')[0];
    return this.blockedIPs.has(ip);
  }

  /**
   * Blocks an IP for the configured duration.
   * @param {string} identifier - Client identifier.
   * @param {number} [duration] - Block duration in ms.
   */
  _blockIP(identifier, duration = TIMING.BLOCK_DURATION_MS) {
    const ip = identifier.split('-')[0];
    const unblockTime = Date.now() + duration;
    this.blockedIPs.set(ip, unblockTime);
    logger.warn('IP blocked for rate limit violation', {
      ip,
      durationSeconds: duration / 1000
    });
  }

  /**
   * Checks whether a request is within rate limits.
   * @param {string} identifier - Client identifier.
   * @param {string} [type='general'] - Rate limit tier.
   * @returns {boolean} True if allowed.
   */
  checkLimit(identifier, type = 'general') {
    if (this._isBlocked(identifier)) {
      return false;
    }

    const limit = RATE_LIMITS[type] || RATE_LIMITS.general;
    const now = Date.now();
    const key = `${identifier}-${type}`;

    if (!this.requests.has(key)) {
      this.requests.set(key, {
        count: 1,
        firstRequest: now,
        lastRequest: now
      });
      return true;
    }

    const requestData = this.requests.get(key);
    const timePassed = now - requestData.firstRequest;

    if (timePassed > limit.window) {
      this.requests.set(key, {
        count: 1,
        firstRequest: now,
        lastRequest: now
      });
      return true;
    }

    if (requestData.count >= limit.requests) {
      if (requestData.count === limit.requests) {
        this._blockIP(identifier);
      }
      return false;
    }

    requestData.count++;
    requestData.lastRequest = now;
    return true;
  }

  /**
   * Creates Express middleware for the specified rate limit tier.
   * @param {string} [type='general'] - Rate limit tier.
   * @returns {Function} Express middleware (req, res, next).
   */
  middleware(type = 'general') {
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`rateLimiter.middleware: invalid type '${type}'. Valid: ${VALID_TYPES.join(', ')}`);
    }

    return (req, res, next) => {
      const identifier = this._getClientIdentifier(req);
      const correlationId = req.correlationId || req.headers?.['x-correlation-id'] || 'no-correlation-id';

      if (!this.checkLimit(identifier, type)) {
        const ip = identifier.split('-')[0];
        logger.warn('Rate limit exceeded', {
          correlationId,
          ip,
          type,
          path: req.path
        });

        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          success: false,
          error: 'Too many requests. Please try again later.',
          retryAfter: RATE_LIMITS[type].window / 1000
        });
      }

      next();
    };
  }

  /**
   * Checks rate limit for a WebSocket connection.
   * @param {Object} ws - WebSocket instance.
   * @param {Object} req - HTTP upgrade request.
   * @returns {boolean} True if allowed, false if closed.
   */
  wsMiddleware(ws, req) {
    const identifier = this._getClientIdentifier(req);

    if (!this.checkLimit(identifier, 'websocket')) {
      logger.warn('WebSocket rate limit exceeded', {
        identifier,
        path: req.url
      });
      ws.close(1008, 'Rate limit exceeded');
      return false;
    }

    return true;
  }

  /**
   * Resets rate limit counters and blocks for a specific client or all.
   * @param {string|null} [identifier=null] - Client identifier, or null for all.
   */
  reset(identifier = null) {
    if (identifier) {
      for (const [key] of this.requests.entries()) {
        if (key.startsWith(identifier)) {
          this.requests.delete(key);
        }
      }
      const ip = identifier.split('-')[0];
      this.blockedIPs.delete(ip);
    } else {
      this.requests.clear();
      this.blockedIPs.clear();
    }

    logger.info('Rate limiter reset', { identifier: identifier || 'all' });
  }

  /**
   * Returns current rate limiter status for monitoring.
   * @returns {Object} Status with activeRequests, blockedIPs, limits.
   */
  getStatus() {
    return {
      activeRequests: this.requests.size,
      blockedIPs: this.blockedIPs.size,
      limits: RATE_LIMITS
    };
  }
}

/*
 * ============================================================================
 * Singleton + Pre-exported Middleware
 * ============================================================================
 */
const rateLimiter = new RateLimiter();

export default rateLimiter;
export const authLimiter = rateLimiter.middleware('auth');
export const apiLimiter = rateLimiter.middleware('api');
export const adminLimiter = rateLimiter.middleware('admin');
export const generalLimiter = rateLimiter.middleware('general');
