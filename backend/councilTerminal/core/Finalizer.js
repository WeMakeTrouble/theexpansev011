/**
 * ============================================================================
 * Finalizer.js — Single Finalization Barrier (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * The sole exit point for all character responses. Enforces hard invariants,
 * normalizes output shape, validates completeness, and freezes state.
 *
 * RESPONSIBILITIES
 * ----------------
 *  - Enforce one character move per turn (INV-2)
 *  - Validate output is non-empty (INV-4a, Goal 4 compliance)
 *  - Clamp confidence to [0,1] (INV-6, with violation tracking)
 *  - Standardize response shape (INV-4)
 *  - Deep freeze context in development (INV-3)
 *  - Instrument metrics (Counters)
 *  - Provide structured error codes
 *
 * INVARIANTS ENFORCED
 * -------------------
 *  INV-2: Exactly one character move per turn (persisted to session)
 *  INV-3: Context is immutable after finalize (dev-mode deep freeze)
 *  INV-4: Output schema is stable and standardized
 *  INV-4a: Output is non-empty (never silent)
 *  INV-6: Confidence is always in range [0, 1] (with violation tracking)
 *
 * NON-GOALS
 * ---------
 *  - No business logic
 *  - No transport or phase handling
 *  - No external calls
 *
 * V010 CHANGES FROM V008
 * ----------------------
 * - Migrated to createModuleLogger (structured logging with correlation IDs)
 * - Added Counters instrumentation (finalization count, violations, sources)
 * - Added input validation with explicit error codes (_validateInputs)
 * - Added deep freeze using structuredClone (dev mode, prevents nested mutation)
 * - Added output non-empty validation (INV-4a, aligns with Goal 4)
 * - Added structured error codes (FinalizerError class)
 * - Added graceful degradation option (throwOnInvariantViolation)
 * - Added defensive session handling (try-catch around mutations)
 * - Added performance timing instrumentation
 * - Removed legacy function syntax (arrow functions throughout)
 * - Externalized all magic strings to constants
 * - Added full JSDoc with types (Record<string, any>)
 * - Added per-violation audit logging
 * - Fixed move count persistence bug with try-catch wrapper
 * - Added perf_hooks import for cross-env compatibility
 * - Fixed source validation (strict allowlist, no fallthrough)
 * - Added robust image format validation with length limits & padding rules
 * - Added INV-6 violation tracking (confidence clamping detection)
 * - Improved structuredClone error handling with pre-checks
 *
 * DEPENDENCIES
 * -----------
 * - logger.js (createModuleLogger)
 * - counters.js (Counters.increment, Counters.recordLatency)
 *
 * PERFORMANCE NOTES
 * -----------------
 * - structuredClone only in development (production uses shallow copy)
 * - No external calls, pure transformation
 * - Finalization should complete in <1ms
 * - Counters recorded after response constructed (non-blocking)
 * - Source validation via frozen allowlist (O(1) lookup)
 *
 * MONITORING & OBSERVABILITY
 * ---------------------------
 * - Counters: finalizer_success, finalizer_error (validation_failed, 
 *   invariant_violation, empty_output), finalizer_violation (INV-2, INV-4a, 
 *   INV-6), finalizer_source (count by source)
 * - Audit logs: Invariant violations with details (confidence clamps, move overages)
 * - Structured logging: Finalization events with context & timing
 *
 * SECURITY
 * --------
 * - Input validation prevents malformed responses
 * - Deep freeze (dev) prevents accidental mutations
 * - Audit logging on violations for traceability
 * - Graceful degradation prevents cascade failures
 * - Strict source allowlist (no open-ended fallthrough)
 * - Robust image format validation (base64 padding rules, URL structure)
 * - Safe mutation wrapper (try-catch on session context updates)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';
import Counters from '../metrics/counters.js';
import { performance } from 'perf_hooks';

const logger = createModuleLogger('Finalizer');

/*
 * ============================================================================
 * Configuration Constants (Frozen)
 * ============================================================================
 */

const CONSTANTS = Object.freeze({
  CONVERSATION_PHASE_COMPLETED: 'COMPLETED',
  DEFAULT_CONFIDENCE: 0,
  DEFAULT_OUTPUT: '',
  DEFAULT_SOURCE: 'unknown',
  MIN_CONFIDENCE: 0,
  MAX_CONFIDENCE: 1,
  MIN_OUTPUT_LENGTH: 1,
  NODE_ENV_DEVELOPMENT: 'development',
  MAX_MOVE_COUNT: 1,
  MIN_IMAGE_BASE64_LENGTH: 100,
  MAX_IMAGE_URL_LENGTH: 2048
});

const INVARIANTS = Object.freeze({
  INV_2: 'INV-2',
  INV_3: 'INV-3',
  INV_4: 'INV-4',
  INV_4A: 'INV-4a',
  INV_6: 'INV-6'
});

const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVARIANT_VIOLATION_MOVE_COUNT: 'INVARIANT_VIOLATION_MOVE_COUNT',
  INVARIANT_VIOLATION_EMPTY_OUTPUT: 'INVARIANT_VIOLATION_EMPTY_OUTPUT',
  INVARIANT_VIOLATION_CONFIDENCE: 'INVARIANT_VIOLATION_CONFIDENCE'
});

const ALLOWED_SOURCES = Object.freeze({
  'unknown': true,
  'pipeline': true,
  'fallback': true,
  'cache': true,
  'test': true,
  'raw': true,
  'hard_fallback': true,
  'ltlm': true,
  'LTLM': true,
  'character_dossier': true,
  'teaching_activation': true,
  'feature_facts': true,
  'system_feature_offer': true,
  'identity_anchors': true,
  'tse_curricula': true,
  'tse_error': true,
  'qud_activation': true,
  'curriculum_selection': true,
  'validation_error': true,
  'rate_limiter': true,
  'error_handler': true,
  'emotional_safety_override': true,
  'PhaseTeaching.entityCuriosity': true,
  'PhaseTeaching.entityCuriosity.didYouMean': true,
  'PhaseTeaching.vocabCuriosity': true,
  'PhaseTeaching.entityExplanation': true,
  'PhaseTeaching.vocabExplanation': true
});

// Strict image validation: base64 with proper padding, or HTTPS URLs with valid extensions
const IMAGE_FORMAT_PATTERN = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/]{100,}={0,2}$|^https:\/\/[^\s<>{}|\\^`\[\]"]+\.(jpg|jpeg|png|gif|webp)(\?[^\s<>{}|\\^`\[\]"]*)?$/i;

/*
 * ============================================================================
 * Custom Error Class
 * ============================================================================
 */

class FinalizerError extends Error {
  /**
   * @param {string} code - Error code constant
   * @param {string} message - Human-readable message
   * @param {Record<string, any>} context - Error context
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'FinalizerError';
    this.code = code;
    this.context = context;
  }
}

/*
 * ============================================================================
 * Input Validation
 * ============================================================================
 */

/**
 * Validate responseIntent parameter.
 *
 * @param {Record<string, any>} responseIntent
 * @returns {Record<string, any>} { valid: boolean, error?: string }
 */
function _validateResponseIntent(responseIntent) {
  if (!responseIntent || typeof responseIntent !== 'object') {
    return { valid: false, error: 'responseIntent must be a non-null object' };
  }
  return { valid: true };
}

/**
 * Validate session parameter.
 *
 * @param {Record<string, any>} session
 * @returns {Record<string, any>} { valid: boolean, error?: string }
 */
function _validateSession(session) {
  if (!session || typeof session !== 'object') {
    return { valid: false, error: 'session must be a non-null object' };
  }
  return { valid: true };
}

/**
 * Validate options parameter.
 *
 * @param {Record<string, any>} options
 * @returns {Record<string, any>} { valid: boolean, error?: string }
 */
function _validateOptions(options) {
  if (!options || typeof options !== 'object') {
    return { valid: false, error: 'options must be a non-null object' };
  }
  if (options.throwOnInvariantViolation !== undefined && typeof options.throwOnInvariantViolation !== 'boolean') {
    return { valid: false, error: 'options.throwOnInvariantViolation must be boolean' };
  }
  if (options.source !== undefined && typeof options.source !== 'string') {
    return { valid: false, error: 'options.source must be string' };
  }
  return { valid: true };
}

/**
 * Validate all inputs.
 *
 * @param {Record<string, any>} responseIntent
 * @param {Record<string, any>} session
 * @param {Record<string, any>} options
 * @returns {Record<string, any>} { valid: boolean, error?: string }
 */
function _validateInputs(responseIntent, session, options) {
  const responseCheck = _validateResponseIntent(responseIntent);
  if (!responseCheck.valid) return responseCheck;

  const sessionCheck = _validateSession(session);
  if (!sessionCheck.valid) return sessionCheck;

  const optionsCheck = _validateOptions(options);
  if (!optionsCheck.valid) return optionsCheck;

  return { valid: true };
}

/*
 * ============================================================================
 * Helper Functions
 * ============================================================================
 */

/**
 * Validate source is in strict allowlist (no fallthrough).
 *
 * @param {string} source
 * @returns {boolean}
 */
function _isValidSource(source) {
  return typeof source === 'string' && ALLOWED_SOURCES[source] === true;
}

/**
 * Validate image format (base64 data URI or HTTPS URL).
 * Strict: base64 requires 100+ chars minimum + proper padding,
 * URLs require HTTPS and valid extensions.
 *
 * @param {string} image
 * @returns {boolean}
 */
function _isValidImage(image) {
  if (!image) return true;
  if (typeof image !== 'string') return false;
  if (image.length > CONSTANTS.MAX_IMAGE_URL_LENGTH) return false;
  if (/^\/uploads\/[^\s<>{}|\\^`\[\]"]+\.(jpg|jpeg|png|gif|webp)$/i.test(image)) return true;
  return IMAGE_FORMAT_PATTERN.test(image);
}


/**
 * Deep freeze an object recursively in place (development only).
 * Walks the object tree using WeakSet to handle circular references.
 * Does not clone. Safe because context and phaseTrace are already copies.
 *
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>} Frozen object (same reference)
 */
function _deepFreeze(obj) {
  if (process.env.NODE_ENV !== CONSTANTS.NODE_ENV_DEVELOPMENT) {
    return obj;
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const seen = new WeakSet();

  function freeze(target) {
    if (target === null || typeof target !== 'object') return;
    if (seen.has(target)) return;
    seen.add(target);

    try {
      Object.freeze(target);
    } catch (e) {
      return;
    }

    Object.values(target).forEach(value => freeze(value));
  }

  freeze(obj);
  return obj;
}

/**
 * Safely get correlation ID from session.
 *
 * @param {Record<string, any>} session
 * @returns {string}
 */
function _getCorrelationId(session) {
  return session?.context?.correlationId || 'no-correlation-id';
}

/**
 * Create a safe copy of session context without mutating original.
 *
 * @param {Record<string, any>} session
 * @returns {Record<string, any>}
 */
function _getSafeContext(session) {
  if (!session || !session.context) {
    return {};
  }

  try {
    const filtered = Object.fromEntries(
      Object.entries(session.context).filter(([key]) => !key.startsWith('__') && key !== 'constructor' && key !== 'prototype')
    );
    return JSON.parse(JSON.stringify(filtered));
  } catch (error) {
    logger.warn('Failed to create safe context copy', error);
    return JSON.parse(JSON.stringify(session.context));
  }
}

/**
 * Track and persist character move count per speaker.
 * CRITICAL: Actually mutates session.context.speakerMoveCounts[speakerId].
 * Wrapped in try-catch to handle frozen contexts gracefully.
 *
 * @param {Record<string, any>} session
 * @param {string} [speakerId='default'] - Character hex ID of current speaker
 * @returns {Record<string, any>} { count: number, isViolation: boolean }
 */
function _trackCharacterMove(session, speakerId = 'default') {
  try {
    // Ensure context exists
    if (!session.context) {
      session.context = {};
    }

    // Increment and persist to session
    if (!session.context.speakerMoveCounts) {
      session.context.speakerMoveCounts = {};
    }
    const currentCount = (session.context.speakerMoveCounts[speakerId] || 0) + 1;
    session.context.speakerMoveCounts[speakerId] = currentCount;

    return {
      count: currentCount,
      isViolation: currentCount > CONSTANTS.MAX_MOVE_COUNT
    };
  } catch (error) {
    logger.error('Failed to track move count (context may be frozen)', error);
    // Return conservative values: assume count=1 and no violation
    return {
      count: 1,
      isViolation: false
    };
  }
}

/**
 * Normalize and copy phase trace array.
 *
 * @param {any} phaseTrace
 * @returns {Array}
 */
function _normalizePhaseTrace(phaseTrace) {
  if (Array.isArray(phaseTrace)) {
    return phaseTrace.map(entry => ({ ...entry }));
  }

  const now = new Date().toISOString();
  return [
    {
      phase: 'finalize',
      startedAt: now,
      completedAt: now
    }
  ];
}

/*
 * ============================================================================
 * Main Finalization Function
 * ============================================================================
 */

/**
 * Finalize a response: enforce invariants, normalize shape, freeze state.
 *
 * @param {Record<string, any>} responseIntent - Response from pipeline
 * @param {Record<string, any>} session - Session object (contains context)
 * @param {Record<string, any>} options - Options (source, terminal, throwOnInvariantViolation)
 * @returns {Record<string, any>} Finalized, frozen response object
 * @throws {FinalizerError} On invariant violation (if throwOnInvariantViolation not false)
 */
export function finalize(responseIntent = {}, session = {}, options = {}) {
  const startTime = performance.now();
  const correlationId = _getCorrelationId(session);

  // --- INPUT VALIDATION ---
  const validation = _validateInputs(responseIntent, session, options);
  if (!validation.valid) {
    const error = new FinalizerError(
      ERROR_CODES.VALIDATION_FAILED,
      `Input validation failed: ${validation.error}`,
      { correlationId }
    );
    logger.error('Finalization input validation failed', error, { correlationId });
    Counters.increment('finalizer_error', 'validation_failed');
    throw error;
  }

  // Determine throw behavior (default: throw on violation)
  const throwOnViolation = options.throwOnInvariantViolation !== false;

  // --- INV-2: ONE CHARACTER MOVE PER TURN ---
  const moveTracking = _trackCharacterMove(session, options.speakerId);
  if (moveTracking.isViolation) {
    const violationMsg = `INVARIANT VIOLATION [${INVARIANTS.INV_2}]: Multiple character moves in single turn (speaker=${options.speakerId || 'default'}, count=${moveTracking.count})`;
    logger.warn('Invariant violation detected', {
      invariant: INVARIANTS.INV_2,
      moveCount: moveTracking.count,
      correlationId
    });
    Counters.increment('finalizer_violation', INVARIANTS.INV_2);

    if (throwOnViolation) {
      const error = new FinalizerError(ERROR_CODES.INVARIANT_VIOLATION_MOVE_COUNT, violationMsg, { correlationId });
      throw error;
    }
  }

  // --- INV-6: CONFIDENCE CLAMPING [0, 1] WITH VIOLATION TRACKING ---
  const rawConfidence = Number(responseIntent.confidence) || CONSTANTS.DEFAULT_CONFIDENCE;
  let confidence = Math.max(CONSTANTS.MIN_CONFIDENCE, Math.min(CONSTANTS.MAX_CONFIDENCE, rawConfidence));

  // Track if confidence was out of bounds (violation)
  if (confidence !== rawConfidence) {
    logger.warn('Confidence clamped (INV-6 violation)', {
      invariant: INVARIANTS.INV_6,
      rawConfidence,
      clamped: confidence,
      correlationId
    });
    Counters.increment('finalizer_violation', INVARIANTS.INV_6);
  }

  // --- INV-4: STANDARDIZED RESPONSE SHAPE ---
  const output = (responseIntent.output || CONSTANTS.DEFAULT_OUTPUT).trim();

  // --- INV-4a: OUTPUT NON-EMPTY (GOAL 4: NEVER SILENT) ---
  if (output.length < CONSTANTS.MIN_OUTPUT_LENGTH) {
    const violationMsg = `INVARIANT VIOLATION [${INVARIANTS.INV_4A}]: Empty output (Goal 4: never silent)`;
    logger.warn('Empty output violation detected', {
      invariant: INVARIANTS.INV_4A,
      outputLength: output.length,
      correlationId
    });
    Counters.increment('finalizer_violation', INVARIANTS.INV_4A);

    if (throwOnViolation) {
      const error = new FinalizerError(ERROR_CODES.INVARIANT_VIOLATION_EMPTY_OUTPUT, violationMsg, { correlationId });
      throw error;
    }
  }

  // --- VALIDATE SOURCE (STRICT ALLOWLIST) ---
  let source = options.source || responseIntent.source;
  if (!_isValidSource(source)) {
    logger.warn('Invalid source, falling back to default', { source, correlationId });
    source = CONSTANTS.DEFAULT_SOURCE;
  }

  // --- VALIDATE IMAGE ---
  let image = responseIntent.image || null;
  if (image && !_isValidImage(image)) {
    logger.warn('Invalid image format, dropping image', { imageLength: image.length, correlationId });
    image = null;
  }

  // --- BUILD RESPONSE OBJECT ---
  const context = _getSafeContext(session);
  if (options.terminal || responseIntent.terminal) {
    context.conversationPhase = CONSTANTS.CONVERSATION_PHASE_COMPLETED;
  }

  const phaseTrace = _normalizePhaseTrace(responseIntent.phase_trace);

  const response = {
    success: responseIntent.success !== false,
    output,
    source,
    confidence,
    context,
    phase_trace: phaseTrace,
    image,
    diagnosticReport: responseIntent.diagnosticReport || null,
    _tseDirectEmit: responseIntent._tseDirectEmit || null,
    _tseReviewGateDomain: responseIntent._tseReviewGateDomain || null,
    queryType: responseIntent.queryType || responseIntent.intentType || null,
    tseSession: responseIntent.tseSession || null,
    entity: responseIntent.entity || null,
    wwddState: responseIntent.wwddState || null,
    _meta: responseIntent._meta || null
  };

  // --- INV-3: DEEP FREEZE (DEVELOPMENT) ---
  if (process.env.NODE_ENV === CONSTANTS.NODE_ENV_DEVELOPMENT) {
    try {
      const frozenContext = _deepFreeze(JSON.parse(JSON.stringify(context)));
      const frozenPhaseTrace = _deepFreeze(JSON.parse(JSON.stringify(phaseTrace)));
      response.context = frozenContext;
      response.phase_trace = frozenPhaseTrace;
      Object.freeze(response);

      logger.debug('Response deeply frozen (development mode)', {
        phase: 'finalize',
        correlationId
      });
    } catch (error) {
      logger.warn('Failed to deep freeze response', error, { correlationId });
      Object.freeze(response);
    }
  } else {
    Object.freeze(response);
  }

  // --- INSTRUMENTATION ---
  const duration = performance.now() - startTime;
  Counters.increment('finalizer_success');
  Counters.increment('finalizer_source', source);
  Counters.recordLatency('finalizer_duration', duration);

  logger.info('Response finalized', {
    success: response.success,
    source,
    confidence,
    outputLength: output.length,
    moveCount: moveTracking.count,
    duration: `${duration.toFixed(2)}ms`,
    correlationId
  });

  return response;
}

export default { finalize };
