/**
 * ============================================================================
 * logger.js — Structured Logging Service (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Centralised structured logging for The Expanse v010.
 * Replaces all console.log/warn/error throughout the codebase.
 * Every log entry carries a correlation ID for request tracing.
 *
 * DESIGN
 * ------
 * - Singleton ExpanseLogger instance exported as default
 * - createModuleLogger(name) factory for per-module loggers
 * - Structured JSON entries in production, colour-coded in development
 * - Sensitive field redaction by key name AND nested path
 * - Circular reference safe sanitisation with depth limiting
 * - Ring buffer for recent log retrieval (lightweight summaries only)
 * - Optional file output with one-time failure alerting
 * - Async file writes to avoid blocking
 * - Monotonic counter log IDs to prevent collisions
 * - Production-guarded diagnostic methods
 *
 * CALLING PATTERNS
 * ----------------
 * Pattern 1 — Module logger (preferred for all v010 code):
 *   import { createModuleLogger } from '../utils/logger.js';
 *   const logger = createModuleLogger('EarWig');
 *   logger.info('Hearing analysis complete', { correlationId, userId });
 *   logger.error('PAD estimation failed', { correlationId, error: err });
 *
 * Pattern 2 — Direct logger (legacy v009 compatibility):
 *   import Logger from '../utils/logger.js';
 *   Logger.info('[PhaseAccess] Executing', { correlationId });
 *
 * Pattern 3 — Explicit three-arg (original v009 design):
 *   Logger.info('PhaseAccess', 'Executing', { correlationId });
 *
 * All patterns produce identical structured output.
 *
 * LOG LEVELS
 * ----------
 * ERROR   (0) — Fatal or breaking failures
 * WARN    (1) — Degraded but recoverable
 * INFO    (2) — Normal operational events
 * SUCCESS (3) — Completed operations worth noting
 * DEBUG   (4) — Verbose diagnostic detail
 *
 * REDACTION
 * ---------
 * Two redaction strategies work together:
 *
 * Key-based: Any object key containing a REDACTED_KEY substring is masked.
 *   { password: '123', userToken: 'abc' } → { password: '[REDACTED]', userToken: '[REDACTED]' }
 *
 * Path-based: Specific nested paths are masked regardless of key name.
 *   { headers: { authorization: 'Bearer ...' } } → { headers: { authorization: '[REDACTED]' } }
 *
 * ENVIRONMENT VARIABLES
 * ---------------------
 * LOG_LEVEL    — Minimum level to output (default: INFO)
 * LOG_TO_FILE  — Write to logs/ directory (default: false)
 * NODE_ENV     — production = JSON output, else colour-coded
 *
 * NAMING CONVENTIONS
 * ------------------
 * Class: ExpanseLogger (PascalCase)
 * Export: logger singleton (camelCase default)
 * Factory: createModuleLogger (camelCase named export)
 * Private: _method (underscore prefix)
 * Constants: UPPER_SNAKE_CASE
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const LOG_LEVELS = Object.freeze({
  ERROR:   { value: 0, color: '\x1b[31m', symbol: '✗' },
  WARN:    { value: 1, color: '\x1b[33m', symbol: '⚠' },
  INFO:    { value: 2, color: '\x1b[36m', symbol: 'ℹ' },
  SUCCESS: { value: 3, color: '\x1b[32m', symbol: '✓' },
  DEBUG:   { value: 4, color: '\x1b[37m', symbol: '·' }
});

const RESET_COLOR = '\x1b[0m';
const DIM_COLOR = '\x1b[2m';
const BOLD_COLOR = '\x1b[1m';

const MAX_BUFFER_SIZE = 200;
const MAX_SANITIZE_DEPTH = 8;
const MAX_DATA_PREVIEW_LENGTH = 500;

/**
 * Key-based redaction: any object key whose lowercase form
 * contains one of these substrings will be masked.
 */
const REDACTED_KEYS = Object.freeze([
  'password', 'token', 'secret', 'authorization',
  'cookie', 'credential', 'apikey', 'api_key'
]);

/**
 * Path-based redaction: specific dot-notation paths that should
 * always be redacted regardless of key name matching.
 * Handles cases like headers.authorization where 'authorization'
 * would match key-based too, but also covers paths where the
 * final key name alone is not sensitive.
 */
const REDACTED_PATHS = Object.freeze([
  'headers.authorization',
  'headers.cookie',
  'body.password',
  'body.token',
  'body.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'session.secret'
]);

/* ────────────────────────────────────────────────────────────────────────── */
/*  ExpanseLogger Class                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

class ExpanseLogger {
  constructor() {
    this.currentLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
    this.logToFile = process.env.LOG_TO_FILE === 'true';
    this.logDir = path.join(__dirname, '../../logs');
    this.logBuffer = [];
    this._counter = 0;
    this._fileWriteWarned = false;

    if (this.logToFile && !fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Log ID Generator                                               */
  /*                                                                          */
  /*  Monotonic counter with hex encoding. Guaranteed unique within a single  */
  /*  process lifetime. Resets on restart which is acceptable for log IDs.    */
  /*  Format: L + 6 hex chars (e.g. L00004F)                                 */
  /*  NOT part of the hex ID system — log IDs do not use hexIdGenerator.     */
  /* ──────────────────────────────────────────────────────────────────────── */

  _generateLogId() {
    this._counter += 1;
    return 'L' + this._counter.toString(16).toUpperCase().padStart(6, '0');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Level Check                                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _shouldLog(level) {
    const requested = LOG_LEVELS[level];
    const current = LOG_LEVELS[this.currentLevel];
    if (!requested || !current) return true;
    return requested.value <= current.value;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Path Redaction Check                                           */
  /*                                                                          */
  /*  Checks if the current traversal path matches any REDACTED_PATHS entry. */
  /*  Path is built by joining parent keys with dots during recursion.        */
  /*  Example: sanitising { headers: { authorization: 'Bearer ...' } }       */
  /*  When at key 'authorization', currentPath = 'headers.authorization'     */
  /*  which matches REDACTED_PATHS, so the value is redacted.                */
  /* ──────────────────────────────────────────────────────────────────────── */

  _isRedactedPath(currentPath) {
    return REDACTED_PATHS.some(rp => currentPath.endsWith(rp));
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Sanitisation                                                   */
  /*                                                                          */
  /*  Circular reference safe via WeakSet tracking.                           */
  /*  Depth limited to MAX_SANITIZE_DEPTH to prevent stack overflow.          */
  /*  Supports both key-based and path-based redaction.                       */
  /*  Handles Error objects, Arrays, and plain objects.                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  _sanitize(data, seen = new WeakSet(), depth = 0, currentPath = '') {
    if (data === null || data === undefined) return data;
    if (typeof data !== 'object') return data;

    if (depth > MAX_SANITIZE_DEPTH) return '[MAX_DEPTH]';

    if (seen.has(data)) return '[CIRCULAR]';
    seen.add(data);

    if (data instanceof Error) {
      return {
        message: data.message,
        code: data.code || undefined,
        stack: process.env.NODE_ENV === 'development' ? data.stack : undefined
      };
    }

    if (Array.isArray(data)) {
      return data.map((item, i) =>
        this._sanitize(item, seen, depth + 1, `${currentPath}[${i}]`)
      );
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;

      if (REDACTED_KEYS.some(k => key.toLowerCase().includes(k))) {
        sanitized[key] = '[REDACTED]';
      } else if (this._isRedactedPath(fieldPath)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this._sanitize(value, seen, depth + 1, fieldPath);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Argument Parser                                                */
  /*                                                                          */
  /*  Resolves three calling patterns into { module, message, data }:         */
  /*                                                                          */
  /*  Pattern 1 — Two args, first is bracket-prefixed string:                 */
  /*    ('[EarWig] Analysis complete', { correlationId })                      */
  /*    → { module: 'EarWig', message: 'Analysis complete', data: {...} }     */
  /*                                                                          */
  /*  Pattern 2 — Two args, first is plain string:                            */
  /*    ('Analysis complete', { correlationId })                               */
  /*    → { module: 'system', message: 'Analysis complete', data: {...} }     */
  /*                                                                          */
  /*  Pattern 3 — Three args, explicit module:                                */
  /*    ('EarWig', 'Analysis complete', { correlationId })                     */
  /*    → { module: 'EarWig', message: 'Analysis complete', data: {...} }     */
  /* ──────────────────────────────────────────────────────────────────────── */

  _parseArgs(first, second, third) {
    if (third !== undefined) {
      return {
        module: String(first),
        message: String(second),
        data: typeof third === 'object' ? third : null
      };
    }

    if (second === undefined || second === null) {
      return { module: 'system', message: String(first), data: null };
    }

    if (typeof first === 'string' && typeof second === 'object') {
      const bracketMatch = first.match(/^\[([^\]]+)\]\s*(.*)/);
      if (bracketMatch) {
        return {
          module: bracketMatch[1],
          message: bracketMatch[2] || first,
          data: second
        };
      }
      return { module: 'system', message: first, data: second };
    }

    if (typeof first === 'string' && typeof second === 'string') {
      return { module: first, message: second, data: null };
    }

    return { module: 'system', message: String(first), data: null };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Entry Builder                                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  _buildEntry(level, module, message, data) {
    const sanitizedData = this._sanitize(data);
    return {
      timestamp: new Date().toISOString(),
      logId: this._generateLogId(),
      level,
      module,
      message,
      correlationId: sanitizedData?.correlationId || 'NO_CORRELATION',
      conversationId: sanitizedData?.conversationId || undefined,
      userId: sanitizedData?.userId || undefined,
      data: sanitizedData,
      environment: process.env.NODE_ENV || 'development'
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Console Output                                                 */
  /*                                                                          */
  /*  Production: single-line JSON for log aggregators                        */
  /*  Development: colour-coded with optional data preview                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _writeConsole(level, entry) {
    const config = LOG_LEVELS[level];

    if (process.env.NODE_ENV === 'production') {
      console.log(JSON.stringify(entry));
      return;
    }

    const time = new Date().toLocaleTimeString();
    const mod = entry.module !== 'system'
      ? `${BOLD_COLOR}[${entry.module}]${RESET_COLOR} `
      : '';
    const corrId = entry.correlationId !== 'NO_CORRELATION'
      ? ` ${DIM_COLOR}(${entry.correlationId})${RESET_COLOR}`
      : '';

    let dataPreview = '';
    if (entry.data && level !== 'ERROR') {
      const keys = Object.keys(entry.data).filter(
        k => k !== 'correlationId' && k !== 'conversationId' && k !== 'userId'
      );
      if (keys.length > 0) {
        const preview = keys.map(k => {
          const v = entry.data[k];
          if (typeof v === 'string') return `${k}="${v}"`;
          if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
          return `${k}={...}`;
        }).join(' ');
        if (preview.length <= MAX_DATA_PREVIEW_LENGTH) {
          dataPreview = ` ${DIM_COLOR}${preview}${RESET_COLOR}`;
        }
      }
    }

    if (level === 'ERROR' && entry.data) {
      console.log(
        `${config.color}${config.symbol} [${time}] ${mod}${entry.message}${corrId}${RESET_COLOR}`
      );
      const errorData = entry.data.error || entry.data.message || entry.data;
      if (errorData) {
        console.log(`  ${config.color}↳ ${typeof errorData === 'object' ? JSON.stringify(errorData) : errorData}${RESET_COLOR}`);
      }
      return;
    }

    console.log(
      `${config.color}${config.symbol}${RESET_COLOR} [${time}] ${mod}${entry.message}${corrId}${dataPreview}`
    );
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: File Output                                                    */
  /*                                                                          */
  /*  Async, best-effort. Warns to stdout once on first failure so the        */
  /*  developer knows file logging has broken, then suppresses further        */
  /*  warnings to prevent log spam.                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  async _writeFile(entry) {
    if (!this.logToFile) return;
    try {
      const date = entry.timestamp.split('T')[0];
      const filepath = path.join(this.logDir, `expanse-${date}.log`);
      await fsp.appendFile(filepath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      if (!this._fileWriteWarned) {
        this._fileWriteWarned = true;
        console.warn(
          `[logger] File logging failed: ${err.message}. Further file write errors will be suppressed.`
        );
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Private: Ring Buffer                                                    */
  /*                                                                          */
  /*  Stores lightweight summaries only — no full data objects.               */
  /*  Prevents memory growth in high-throughput scenarios.                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  _addToBuffer(entry) {
    this.logBuffer.push({
      timestamp: entry.timestamp,
      logId: entry.logId,
      level: entry.level,
      module: entry.module,
      message: entry.message,
      correlationId: entry.correlationId
    });
    if (this.logBuffer.length > MAX_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Core: Log Dispatch                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  _log(level, module, message, data) {
    if (!this._shouldLog(level)) return;

    const entry = this._buildEntry(level, module, message, data);
    this._addToBuffer(entry);
    this._writeConsole(level, entry);
    this._writeFile(entry);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Level Methods                                                   */
  /*                                                                          */
  /*  Each supports all three calling patterns via _parseArgs.                */
  /* ──────────────────────────────────────────────────────────────────────── */

  error(moduleOrMessage, messageOrData, dataOrCtx) {
    const { module, message, data } = this._parseArgs(moduleOrMessage, messageOrData, dataOrCtx);
    this._log('ERROR', module, message, data);
  }

  warn(moduleOrMessage, messageOrData, dataOrCtx) {
    const { module, message, data } = this._parseArgs(moduleOrMessage, messageOrData, dataOrCtx);
    this._log('WARN', module, message, data);
  }

  info(moduleOrMessage, messageOrData, dataOrCtx) {
    const { module, message, data } = this._parseArgs(moduleOrMessage, messageOrData, dataOrCtx);
    this._log('INFO', module, message, data);
  }

  success(moduleOrMessage, messageOrData, dataOrCtx) {
    const { module, message, data } = this._parseArgs(moduleOrMessage, messageOrData, dataOrCtx);
    this._log('SUCCESS', module, message, data);
  }

  debug(moduleOrMessage, messageOrData, dataOrCtx) {
    const { module, message, data } = this._parseArgs(moduleOrMessage, messageOrData, dataOrCtx);
    this._log('DEBUG', module, message, data);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Module Logger Factory                                           */
  /*                                                                          */
  /*  Creates a frozen scoped logger that automatically tags every entry      */
  /*  with the module name. Frozen to prevent accidental method overwriting.  */
  /*  This is the preferred pattern for all v010 code.                        */
  /*                                                                          */
  /*  Usage:                                                                  */
  /*    const logger = createModuleLogger('EarWig');                          */
  /*    logger.info('Analysis complete', { correlationId, userId });          */
  /* ──────────────────────────────────────────────────────────────────────── */

  createModuleLogger(moduleName) {
    return Object.freeze({
      error: (message, data) => this._log('ERROR', moduleName, message, data),
      warn: (message, data) => this._log('WARN', moduleName, message, data),
      info: (message, data) => this._log('INFO', moduleName, message, data),
      success: (message, data) => this._log('SUCCESS', moduleName, message, data),
      debug: (message, data) => this._log('DEBUG', moduleName, message, data)
    });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Public: Diagnostics                                                     */
  /*                                                                          */
  /*  getRecentLogs    — returns lightweight buffer entries                   */
  /*  getLogsByCorrelation — filters buffer by correlation ID                 */
  /*  clearBuffer      — guarded in production to prevent accidental wipes   */
  /* ──────────────────────────────────────────────────────────────────────── */

  getRecentLogs(count = 50) {
    return this.logBuffer.slice(-count);
  }

  getLogsByCorrelation(correlationId) {
    return this.logBuffer.filter(e => e.correlationId === correlationId);
  }

  clearBuffer(confirm = false) {
    if (process.env.NODE_ENV === 'production' && !confirm) {
      this._log('WARN', 'logger', 'clearBuffer() blocked in production — pass confirm=true to override', null);
      return false;
    }
    this.logBuffer = [];
    return true;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Singleton Export                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

const logger = new ExpanseLogger();

export default logger;
export const createModuleLogger = (moduleName) => logger.createModuleLogger(moduleName);
