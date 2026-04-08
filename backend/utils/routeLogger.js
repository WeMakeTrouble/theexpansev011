/**
 * ============================================================================
 * routeLogger.js — Route Registration Registry (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Centralised registry for all Express routes mounted during boot.
 * Tracks route metadata including HTTP methods, categories, handler
 * references, source files, route parameters, mount order, and timing
 * for boot reporting, health diagnostics, and runtime introspection.
 *
 * DESIGN
 * ------
 * - Routes registered during server.js composition phase
 * - Supports HTTP method tracking per route
 * - Optional handler name and source file for code traceability
 * - Mount prefix tracking with computed fullPath for nested routers
 * - Route parameter detection (e.g. /users/:id → params: ['id'])
 * - Optional auto-discovery from Express app._router.stack
 * - Registry deep-frozen after boot to prevent all runtime mutation
 * - Integrates with structured logger (createModuleLogger)
 * - Categorises routes by type (api, auth, admin, static, health, websocket)
 * - Records mount order and timing relative to server.listen()
 * - Summary cached on finalisation for O(1) health endpoint queries
 * - Slowest mount detection for boot performance analysis
 * - Queryable by path, category, method, handler, and params
 * - Display at DEBUG level with optional INFO override
 * - Text table output for documentation and diagnostics
 *
 * USAGE
 * -----
 * import {
 *   registerRoute, finaliseRegistry, showAllRoutes,
 *   setServerStartTime, autoDiscover, getRegistrySummary
 * } from '../utils/routeLogger.js';
 *
 * During boot:
 *   registerRoute('/api/auth', 'Authentication', {
 *     category: 'auth',
 *     methods: ['POST', 'GET'],
 *     handler: 'authRoutes',
 *     file: 'backend/routes/auth.js'
 *   });
 *
 *   registerRoute('/api/users/:id', 'User Detail', {
 *     category: 'api',
 *     methods: ['GET', 'PUT'],
 *     prefix: '/api',
 *     handler: 'userRouter',
 *     file: 'backend/routes/users.js'
 *   });
 *
 * After httpServer.listen():
 *   setServerStartTime();
 *   autoDiscover(app);       // optional: merge Express stack routes
 *   finaliseRegistry();      // deep-freezes, caches summary, logs report
 *
 * During boot report:
 *   showAllRoutes();         // structured logger at DEBUG level
 *   showAllRoutes(true);     // force display at INFO level
 *
 * For diagnostics:
 *   getRouteCount();                   // total routes
 *   getRoutesByCategory('api');        // filtered list
 *   getRoutesByMethod('POST');         // all POST routes
 *   getRouteByPath('/api/auth');       // find specific route
 *   getParameterisedRoutes();          // routes with :params
 *   getRegistrySummary();              // cached stats for /health
 *   getRouteTable();                   // text table for docs
 *
 * ROUTE ENTRY STRUCTURE
 * ---------------------
 * {
 *   path: '/api/users/:id',          // mount path (raw, with params)
 *   fullPath: '/api/users/:id',      // prefix + path combined
 *   name: 'User Detail',             // human label
 *   category: 'api',                 // route category
 *   methods: ['GET', 'PUT'],         // HTTP methods
 *   params: ['id'],                  // detected route parameters
 *   handler: 'userRouter',           // handler module name (optional)
 *   file: 'backend/routes/users.js', // source file (optional)
 *   prefix: '/api',                  // mount prefix (optional)
 *   mountOrder: 3,                   // registration order
 *   mountedAt: 12,                   // ms after listen (or boot)
 *   source: 'manual'                 // 'manual' or 'auto-discovered'
 * }
 *
 * CATEGORIES
 * ----------
 * api       — Core business logic endpoints
 * auth      — Authentication and session routes
 * admin     — Admin panel and management routes
 * static    — Static file mounts
 * health    — Health check and diagnostics
 * websocket — WebSocket namespaces
 * other     — Uncategorised routes
 *
 * NAMING CONVENTIONS
 * ------------------
 * Functions: camelCase (registerRoute, showAllRoutes)
 * Constants: UPPER_SNAKE_CASE
 * Private: _prefix (underscore prefix)
 * Module: singleton registry pattern
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from './logger.js';

const logger = createModuleLogger('RouteRegistry');

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const VALID_CATEGORIES = Object.freeze([
  'api', 'auth', 'admin', 'static', 'health', 'websocket', 'other'
]);

const VALID_METHODS = Object.freeze([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'
]);

const PARAM_REGEX = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Registry State                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

let registeredRoutes = [];
let isFinalised = false;
let cachedSummary = null;
let cachedTable = null;
let moduleLoadTime = Date.now();
let serverStartTime = null;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Timing                                                           */
/*                                                                            */
/*  Mount timestamps are relative to server.listen() when available,          */
/*  falling back to module load time during early boot.                       */
/* ────────────────────────────────────────────────────────────────────────── */

function _getElapsed() {
  const reference = serverStartTime || moduleLoadTime;
  return Date.now() - reference;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Parameter Extraction                                             */
/*                                                                            */
/*  Detects Express-style route parameters from path strings.                 */
/*  e.g. '/users/:id/posts/:postId' → ['id', 'postId']                      */
/* ────────────────────────────────────────────────────────────────────────── */

function _extractParams(routePath) {
  const params = [];
  let match;
  const regex = new RegExp(PARAM_REGEX.source, 'g');
  while ((match = regex.exec(routePath)) !== null) {
    params.push(match[1]);
  }
  return params;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Full Path Computation                                            */
/*                                                                            */
/*  Combines prefix and path, normalising double slashes.                     */
/*  '/api' + '/users/:id' → '/api/users/:id'                                */
/*  null + '/health' → '/health'                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function _computeFullPath(prefix, routePath) {
  if (!prefix) return routePath;
  const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const cleanPath = routePath.startsWith('/') ? routePath : '/' + routePath;
  return cleanPrefix + cleanPath;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Deep Freeze                                                      */
/*                                                                            */
/*  Recursively freezes an object and all nested objects/arrays.              */
/*  Ensures route entries and their properties cannot be mutated              */
/*  after finalisation.                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function _deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      _deepFreeze(value);
    }
  }
  return obj;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Build Summary                                                    */
/*                                                                            */
/*  Computed once during finaliseRegistry() and cached for O(1) queries.     */
/*  Prevents repeated iteration over the registry on every /health call.     */
/*  Includes slowest mount detection and parameterised route count.          */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildSummary() {
  const byCategory = {};
  const byMethod = {};
  let totalEndpoints = 0;
  let parameterisedCount = 0;
  let slowestMount = { name: null, ms: 0 };

  for (const route of registeredRoutes) {
    if (!byCategory[route.category]) byCategory[route.category] = 0;
    byCategory[route.category] += 1;

    if (route.params.length > 0) parameterisedCount += 1;

    if (route.mountedAt > slowestMount.ms) {
      slowestMount = { name: route.name, ms: route.mountedAt };
    }

    for (const method of route.methods) {
      if (!byMethod[method]) byMethod[method] = 0;
      byMethod[method] += 1;
      totalEndpoints += 1;
    }
  }

  return Object.freeze({
    total: registeredRoutes.length,
    totalEndpoints,
    parameterisedRoutes: parameterisedCount,
    byCategory,
    byMethod,
    slowestMount: slowestMount.name ? slowestMount : null,
    finalised: true,
    finalisedAt: new Date().toISOString()
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Private: Build Text Table                                                 */
/*                                                                            */
/*  Creates a formatted text table of all routes for documentation,           */
/*  diagnostics, or log output. Cached on finalisation.                       */
/* ────────────────────────────────────────────────────────────────────────── */

function _buildTable() {
  const header = 'Order | Category  | Methods              | Path                          | Name                    | Handler          | File';
  const sep    = '------+-----------+----------------------+-------------------------------+-------------------------+------------------+-----------------------------';
  const rows = registeredRoutes.map(r => {
    const order = String(r.mountOrder).padStart(5);
    const cat = r.category.padEnd(9);
    const methods = (r.methods.join(',') || '-').padEnd(20);
    const fullPath = r.fullPath.padEnd(29);
    const name = r.name.padEnd(23);
    const handler = (r.handler || '-').padEnd(16);
    const file = r.file || '-';
    return `${order} | ${cat} | ${methods} | ${fullPath} | ${name} | ${handler} | ${file}`;
  });

  return [sep, header, sep, ...rows, sep].join('\n');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Timing                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Record the actual server.listen() time so mount timestamps
 * are relative to when the server became ready, not when the
 * module was first imported.
 * Call from within the httpServer.listen() callback.
 */
export function setServerStartTime() {
  serverStartTime = Date.now();
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Registration                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Register a route path with metadata.
 * Must be called during boot before finaliseRegistry().
 *
 * @param {string} routePath — Express mount path (e.g. '/api/auth', '/users/:id')
 * @param {string} name — Human-readable label (e.g. 'Authentication')
 * @param {object} [options] — Optional metadata
 * @param {string} [options.category='other'] — Route category
 * @param {string[]} [options.methods=[]] — HTTP methods this route handles
 * @param {string} [options.handler=null] — Handler module or function name
 * @param {string} [options.file=null] — Source file path for traceability
 * @param {string} [options.prefix=null] — Mount prefix for nested routers
 */
export function registerRoute(routePath, name, options = {}) {
  if (isFinalised) {
    logger.warn('Attempted to register route after registry finalised', {
      routePath, name
    });
    return;
  }

  const category = VALID_CATEGORIES.includes(options.category)
    ? options.category
    : 'other';

  const methods = Array.isArray(options.methods)
    ? options.methods
        .map(m => String(m).toUpperCase())
        .filter(m => VALID_METHODS.includes(m))
    : [];

  const prefix = options.prefix || null;
  const fullPath = _computeFullPath(prefix, routePath);
  const params = _extractParams(fullPath);

  registeredRoutes.push({
    path: routePath,
    fullPath,
    name,
    category,
    methods,
    params,
    handler: options.handler || null,
    file: options.file || null,
    prefix,
    mountOrder: registeredRoutes.length + 1,
    mountedAt: _getElapsed(),
    source: 'manual'
  });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Auto-Discovery                                                            */
/*                                                                            */
/*  Scans the Express app._router.stack for mounted routes that were not     */
/*  manually registered. Merges them into the registry with source:          */
/*  'auto-discovered'. Call before finaliseRegistry().                        */
/*                                                                            */
/*  This is additive — manually registered routes take priority.             */
/*  Auto-discovered routes get category 'other' and no handler/file.         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Scan Express app router stack and register any routes not already
 * in the registry. Safe to call — only adds missing routes.
 *
 * @param {object} app — Express app instance
 */
export function autoDiscover(app) {
  if (isFinalised) {
    logger.warn('autoDiscover() called after registry finalised — skipping');
    return;
  }

  if (!app || !app._router || !app._router.stack) {
    logger.debug('autoDiscover() — no router stack found, skipping');
    return;
  }

  const knownPaths = new Set(registeredRoutes.map(r => r.path));
  let discovered = 0;

  for (const layer of app._router.stack) {
    if (!layer.route) continue;

    const routePath = layer.route.path;
    if (knownPaths.has(routePath)) continue;

    const methods = Object.keys(layer.route.methods)
      .filter(m => layer.route.methods[m])
      .map(m => m.toUpperCase())
      .filter(m => VALID_METHODS.includes(m));

    const params = _extractParams(routePath);

    registeredRoutes.push({
      path: routePath,
      fullPath: routePath,
      name: `Auto: ${routePath}`,
      category: 'other',
      methods,
      params,
      handler: null,
      file: null,
      prefix: null,
      mountOrder: registeredRoutes.length + 1,
      mountedAt: _getElapsed(),
      source: 'auto-discovered'
    });

    knownPaths.add(routePath);
    discovered += 1;
  }

  if (discovered > 0) {
    logger.info(`Auto-discovered ${discovered} unregistered routes`, { discovered });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Finalisation                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Deep-freeze the registry after all routes are mounted.
 * Caches summary and text table for O(1) queries.
 * Prevents all runtime mutation of registry and route objects.
 * Call once in server.js after all app.use() and autoDiscover() calls.
 */
export function finaliseRegistry() {
  if (isFinalised) return;
  isFinalised = true;
  cachedSummary = _buildSummary();
  cachedTable = _buildTable();
  _deepFreeze(registeredRoutes);
  logger.success(
    `Registry finalised: ${cachedSummary.total} routes, ${cachedSummary.totalEndpoints} endpoints`,
    { summary: cachedSummary }
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Display                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Log all registered routes via structured logger, grouped by category.
 * Default level is DEBUG to avoid verbose CI/boot logs.
 * Pass forceInfo=true to log at INFO level (useful for boot report).
 *
 * @param {boolean} [forceInfo=false] — Log at INFO instead of DEBUG
 */
export function showAllRoutes(forceInfo = false) {
  const logFn = forceInfo ? logger.info : logger.debug;

  if (registeredRoutes.length === 0) {
    logFn('No routes registered');
    return;
  }

  const grouped = {};
  for (const route of registeredRoutes) {
    if (!grouped[route.category]) grouped[route.category] = [];
    grouped[route.category].push(route);
  }

  for (const [category, routes] of Object.entries(grouped)) {
    const lines = routes.map(r => {
      const methods = r.methods.length > 0 ? ` [${r.methods.join(',')}]` : '';
      const params = r.params.length > 0 ? ` {${r.params.join(',')}}` : '';
      const handler = r.handler ? ` → ${r.handler}` : '';
      const file = r.file ? ` (${r.file})` : '';
      const src = r.source === 'auto-discovered' ? ' [auto]' : '';
      return `${r.name}: ${r.fullPath}${methods}${params}${handler}${file}${src}`;
    });

    logFn(`${category.toUpperCase()} (${routes.length})`, {
      category,
      count: routes.length,
      routes: lines
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Query Methods                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Total number of registered routes.
 * @returns {number}
 */
export function getRouteCount() {
  return registeredRoutes.length;
}

/**
 * Filter routes by category.
 * @param {string} category — One of VALID_CATEGORIES
 * @returns {Array} Matching route objects (frozen after finalisation)
 */
export function getRoutesByCategory(category) {
  return registeredRoutes.filter(r => r.category === category);
}

/**
 * Filter routes by HTTP method.
 * @param {string} method — HTTP method (e.g. 'GET', 'POST')
 * @returns {Array} Routes that handle the specified method
 */
export function getRoutesByMethod(method) {
  const upper = String(method).toUpperCase();
  return registeredRoutes.filter(r => r.methods.includes(upper));
}

/**
 * Find a specific route by its mount path or fullPath.
 * @param {string} routePath — The path to search for
 * @returns {object|null} Route object or null if not found
 */
export function getRouteByPath(routePath) {
  return registeredRoutes.find(
    r => r.path === routePath || r.fullPath === routePath
  ) || null;
}

/**
 * Get all routes that have Express-style parameters.
 * @returns {Array} Routes with params.length > 0
 */
export function getParameterisedRoutes() {
  return registeredRoutes.filter(r => r.params.length > 0);
}

/**
 * Cached text table of all routes for documentation or diagnostics.
 * Formatted with columns: Order, Category, Methods, Path, Name, Handler, File
 *
 * @returns {string} Formatted text table, or empty message if not finalised
 */
export function getRouteTable() {
  if (cachedTable) return cachedTable;
  return '(registry not yet finalised — call finaliseRegistry() first)';
}

/**
 * Cached registry summary for health endpoint and diagnostics.
 * Computed once during finaliseRegistry() — O(1) retrieval.
 *
 * Returns:
 * {
 *   total: 15,
 *   totalEndpoints: 42,
 *   parameterisedRoutes: 3,
 *   byCategory: { api: 8, auth: 2, admin: 3, health: 1, other: 1 },
 *   byMethod: { GET: 20, POST: 12, PUT: 6, DELETE: 4 },
 *   slowestMount: { name: 'Expanse API', ms: 45 },
 *   finalised: true,
 *   finalisedAt: '2026-02-09T...'
 * }
 *
 * @returns {object} Frozen summary, or minimal live stats if not yet finalised
 */
export function getRegistrySummary() {
  if (cachedSummary) return cachedSummary;

  return {
    total: registeredRoutes.length,
    totalEndpoints: 0,
    parameterisedRoutes: 0,
    byCategory: {},
    byMethod: {},
    slowestMount: null,
    finalised: false,
    finalisedAt: null
  };
}

export default {
  registerRoute,
  autoDiscover,
  finaliseRegistry,
  setServerStartTime,
  showAllRoutes,
  getRouteCount,
  getRoutesByCategory,
  getRoutesByMethod,
  getRouteByPath,
  getParameterisedRoutes,
  getRouteTable,
  getRegistrySummary
};
