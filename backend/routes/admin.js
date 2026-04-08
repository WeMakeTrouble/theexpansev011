/**
 * ============================================================================
 * Admin API Router — Central Gateway for CMS Admin Endpoints
 * ============================================================================
 *
 * WHAT THIS MODULE IS:
 * ---------------------------------------------------------------------------
 * The Express router that handles all /api/admin/* requests. Every admin
 * endpoint in the CMS flows through this file. It applies requireAdmin()
 * middleware to enforce access_level 11 on every route, provides a
 * router-level error boundary, tracks metrics, then delegates to
 * phase-specific sub-routers as they are built.
 *
 * MOUNTING:
 * ---------------------------------------------------------------------------
 * In server.js:
 *   import adminRoutes from './backend/routes/admin.js';
 *   app.use('/api/admin', adminRoutes);
 *
 * All endpoints below are relative to /api/admin:
 *   GET  /api/admin/health        → Admin API health check
 *   GET  /api/admin/status        → Mounted routes and metrics
 *   GET  /api/admin/characters    → Character list (Phase 1)
 *   PUT  /api/admin/characters/:id → Update character (Phase 1)
 *   ...etc
 *
 * SECURITY:
 * ---------------------------------------------------------------------------
 * - requireAdmin() runs on EVERY route (applied at router level)
 * - Checks req.user.access_level >= 11
 * - Returns 401 if no session, 403 if insufficient level
 * - All responses are JSON
 *
 * ERROR BOUNDARY:
 * ---------------------------------------------------------------------------
 * A router-level error handler catches any unhandled errors from sub-routes.
 * This ensures:
 *   - Consistent JSON error format (never HTML error pages)
 *   - Structured error logging with path and method context
 *   - Internal error details masked from the client
 *   - Sub-route bugs cannot crash the entire server
 *
 * METRICS:
 * ---------------------------------------------------------------------------
 * Tracks total requests, errors, and per-path counts. Access via the
 * /status endpoint or programmatically via the exported getMetrics().
 *
 * STRUCTURE:
 * ---------------------------------------------------------------------------
 * Sub-routes are mounted as they are built in each phase:
 *   Phase 1:  /characters    Character Management
 *   Phase 2:  /knowledge     Knowledge Management
 *   Phase 3:  /narratives    Narrative System
 *   Phase 4:  /curricula     Curriculum & Teaching
 *   Phase 5:  /dialogue      Dialogue & LTLM
 *   Phase 6:  /assets        Asset Management
 *   Phase 7:  /world         World Management
 *   Phase 8:  /tse           TSE Monitoring
 *   Phase 9:  /psychic       Psychic Monitoring
 *   Phase 10: /users         User & Dossier Management
 *   Phase 11: /system        System Administration
 *
 * Each phase adds its own sub-router file (e.g., adminCharacters.js)
 * which is imported and mounted here.
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: 0 — Foundation
 * Version: v010.1
 * ============================================================================
 */

import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { createModuleLogger } from '../utils/logger.js';
import adminCharacters from './adminCharacters.js';
import adminNarrativeBlueprints from './adminNarrativeBlueprints.js';
import adminAssets from './adminAssets.js';
import adminRazor from './adminRazor.js';
import adminChaosEngine from './adminChaosEngine.js';
import adminPurchaseCodes from './adminPurchaseCodes.js';

const logger = createModuleLogger('AdminRouter');
const router = Router();

const ADMIN_ROUTER_VERSION = 'v010.1';

/**
 * Metrics collector for admin API diagnostics
 */
const _metrics = {
  totalRequests: 0,
  totalErrors: 0,
  startedAt: new Date().toISOString(),
  pathCounts: {},
  lastError: null
};

/**
 * Track which phase sub-routes have been mounted.
 * @type {Array<{phase: number, path: string, name: string}>}
 */
const _mountedRoutes = [];

/**
 * Get the list of mounted sub-routes (read-only copy)
 * @returns {Array<object>}
 */
function _getMountedRoutes() {
  return [..._mountedRoutes];
}

/**
 * Get admin API metrics snapshot
 * @returns {object}
 */
function getMetrics() {
  return {
    version: ADMIN_ROUTER_VERSION,
    ..._metrics,
    mountedRoutes: _mountedRoutes.length,
    uptime: Math.round((Date.now() - new Date(_metrics.startedAt).getTime()) / 1000)
  };
}

/**
 * Apply requireAdmin() to ALL routes on this router.
 * Every request must have access_level >= 11.
 */
router.use(requireAdmin());

/**
 * Request counting middleware.
 * Tracks total requests and per-path counts for diagnostics.
 */
router.use((req, res, next) => {
  _metrics.totalRequests++;
  const pathKey = `${req.method} ${req.path}`;
  _metrics.pathCounts[pathKey] = (_metrics.pathCounts[pathKey] || 0) + 1;
  next();
});

/**
 * GET /api/admin/health
 * Admin-specific health check. Confirms the admin API is mounted,
 * the session is valid, and the user has admin access.
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    version: ADMIN_ROUTER_VERSION,
    admin: {
      username: req.user.username,
      accessLevel: req.user.access_level
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/admin/status
 * Returns which sub-routes are currently mounted, plus metrics.
 * Useful for the frontend to know which phases are live.
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    version: ADMIN_ROUTER_VERSION,
    mountedRoutes: _getMountedRoutes(),
    metrics: getMetrics(),
    timestamp: new Date().toISOString()
  });
});

/* ============================================================================
 * Phase Sub-Route Mounting
 * ============================================================================
 *
 * As each phase is built, import its sub-router and mount it here.
 * Follow this pattern:
 *
 *   import adminCharacters from './adminCharacters.js';
 *   router.use('/characters', adminCharacters);
 *   _mountedRoutes.push({ phase: 1, path: '/characters', name: 'Character Management' });
 *   logger.info('Mounted /characters (Phase 1)');
 *
 * ============================================================================ */

// Phase 1: Character Management
router.use('/characters', adminCharacters);
_mountedRoutes.push({ phase: 1, path: '/characters', name: 'Character Management' });
logger.info('Mounted /characters (Phase 1)');

// Phase 2: Knowledge Management
// import adminKnowledge from './adminKnowledge.js';
// router.use('/knowledge', adminKnowledge);
// _mountedRoutes.push({ phase: 2, path: '/knowledge', name: 'Knowledge Management' });

// Phase 3: Narrative System (Blueprint Tool)
router.use('/narrative-blueprints', adminNarrativeBlueprints);
_mountedRoutes.push({ phase: 3, path: '/narrative-blueprints', name: 'Narrative Blueprint Tool' });
logger.info('Mounted /narrative-blueprints (Phase 3)');

// Phase 4: Curriculum & Teaching
// import adminCurricula from './adminCurricula.js';
// router.use('/curricula', adminCurricula);
// _mountedRoutes.push({ phase: 4, path: '/curricula', name: 'Curriculum & Teaching' });

// Phase 5: Dialogue & LTLM
// import adminDialogue from './adminDialogue.js';
// router.use('/dialogue', adminDialogue);
// _mountedRoutes.push({ phase: 5, path: '/dialogue', name: 'Dialogue & LTLM' });

// Phase 6: Asset Management
router.use('/assets', adminAssets);
_mountedRoutes.push({ phase: 6, path: '/assets', name: 'Asset Management' });

// Phase 7: World Management
// import adminWorld from './adminWorld.js';
// router.use('/world', adminWorld);
// _mountedRoutes.push({ phase: 7, path: '/world', name: 'World Management' });

// Phase 8: TSE Monitoring
// import adminTse from './adminTse.js';
// router.use('/tse', adminTse);
// _mountedRoutes.push({ phase: 8, path: '/tse', name: 'TSE Monitoring' });

// Phase 9: Psychic Monitoring
// import adminPsychic from './adminPsychic.js';
// router.use('/psychic', adminPsychic);
// _mountedRoutes.push({ phase: 9, path: '/psychic', name: 'Psychic Monitoring' });

// Phase 9b: Ockham's Razor Diagnostic
router.use('/razor', adminRazor);
_mountedRoutes.push({ phase: 9, path: '/razor', name: 'Ockham\x27s Razor Diagnostic' });
logger.info('Mounted /razor (Phase 9b)');

// Chaos Engine — Seed Inspector and Diagnostic Tools
router.use('/chaos-engine', adminChaosEngine);
_mountedRoutes.push({ phase: 12, path: '/chaos-engine', name: 'Chaos Engine Tools' });
logger.info('Mounted /chaos-engine (Chaos Engine)');
router.use('/purchase-codes', adminPurchaseCodes);
_mountedRoutes.push({ phase: 13, path: '/purchase-codes', name: 'Purchase Code Management' });
logger.info('Mounted /purchase-codes (Purchase Codes)');

// Phase 10: User & Dossier Management
// import adminUsers from './adminUsers.js';
// router.use('/users', adminUsers);
// _mountedRoutes.push({ phase: 10, path: '/users', name: 'User & Dossier Management' });

// Phase 11: System Administration
// import adminSystem from './adminSystem.js';
// router.use('/system', adminSystem);
// _mountedRoutes.push({ phase: 11, path: '/system', name: 'System Administration' });

/* ============================================================================
 * Router-Level Error Boundary
 * ============================================================================
 * Catches any unhandled errors from sub-route handlers.
 * MUST be defined AFTER all routes (Express error handlers require 4 args).
 * Ensures:
 *   - Consistent JSON error responses (never HTML)
 *   - Internal details masked from the client
 *   - Structured logging with request context
 * ============================================================================ */

router.use((err, req, res, _next) => {
  _metrics.totalErrors++;
  _metrics.lastError = {
    message: err.message,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  };

  const correlationId = req.correlationId || req.headers?.['x-correlation-id'] || null;

  logger.error('Admin route error', err, {
    correlationId,
    path: req.originalUrl,
    method: req.method,
    username: req.user?.username || 'unknown',
    statusCode: err.statusCode || 500
  });

  const statusCode = err.statusCode || 500;
  const isClientError = statusCode >= 400 && statusCode < 500;

  res.status(statusCode).json({
    success: false,
    error: isClientError ? err.message : 'Internal server error',
    details: isClientError ? (err.details || null) : null
  });
});

logger.info('Admin API router initialised', {
  version: ADMIN_ROUTER_VERSION,
  mountedRoutes: _mountedRoutes.length
});

export { getMetrics };
export default router;
