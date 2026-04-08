/**
 * ============================================================================
 * Image Editor — Orchestrator
 * ============================================================================
 *
 * Single entry point for all pre-CRT image editing operations.
 * Takes a buffer and an ordered array of edit operations, applies
 * them sequentially, and returns the final buffer with an audit
 * trail of what was applied.
 *
 * USAGE:
 * ---------------------------------------------------------------------------
 *   import { imageEditor } from './imageEditor/index.js';
 *
 *   const { buffer, appliedEdits } = await imageEditor.applyEdits(
 *     rawBuffer,
 *     [
 *       { operation: 'rotate', params: { angle: 90 } },
 *       { operation: 'focalCrop', params: { targetWidth: 1200, targetHeight: 400, focalPoint: 'face' } },
 *       { operation: 'adjust', params: { brightness: 1.2 } }
 *     ]
 *   );
 *
 * EDIT STACK ORDER:
 * ---------------------------------------------------------------------------
 * Operations run in the order provided. Recommended sequence:
 *   1. rotate/flip (orientation first)
 *   2. crop/focalCrop (region selection)
 *   3. adjust (colour correction last)
 *
 * RESOURCE LIMITS:
 * ---------------------------------------------------------------------------
 * - Maximum input buffer size: 50MB (matches CRT pipeline limit)
 * - Maximum edit stack depth: 20 operations
 * - Both enforced before any processing begins
 *
 * ============================================================================
 * Project: The Expanse v010
 * Phase: Asset Management — Image Editor Service
 * ============================================================================
 */

import { crop, rotate, flip } from './transform.js';
import { adjust } from './adjust.js';
import { focalCrop } from './focalCrop.js';
import { VALID_OPERATIONS } from './config.js';
import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('imageEditor');

/**
 * Maximum input buffer size in bytes (50MB).
 * Matches the CRT pipeline limit in imageProcessor.js.
 * Prevents memory exhaustion from oversized inputs.
 *
 * @type {number}
 */
const MAX_BUFFER_SIZE = 50 * 1024 * 1024;

/**
 * Maximum number of operations in a single edit stack.
 * Prevents resource exhaustion from excessively long chains.
 *
 * @type {number}
 */
const MAX_EDIT_STEPS = 20;

/**
 * Map of operation names to their handler functions.
 * Each handler accepts (buffer, params) and returns a Promise<Buffer>.
 *
 * @type {Object.<string, Function>}
 */
const OPERATION_HANDLERS = Object.freeze({
  crop,
  rotate,
  flip,
  adjust,
  focalCrop
});

/**
 * Image editor service.
 * Plain object export per naming conventions (not a class).
 *
 * @type {Object}
 */
export const imageEditor = Object.freeze({

  /**
   * Apply a sequence of editing operations to an image buffer.
   *
   * @param {Buffer} inputBuffer - Raw image data (max 50MB)
   * @param {Array<{operation: string, params: Object}>} editStack - Ordered operations (max 20)
   * @returns {Promise<{buffer: Buffer, appliedEdits: Array}>}
   */
  async applyEdits(inputBuffer, editStack = []) {
    if (!Buffer.isBuffer(inputBuffer)) {
      throw new TypeError('Input must be a Buffer');
    }

    if (inputBuffer.length === 0) {
      throw new Error('Input buffer is empty');
    }

    if (inputBuffer.length > MAX_BUFFER_SIZE) {
      throw new Error(
        `Input buffer (${Math.round(inputBuffer.length / 1024 / 1024)}MB) exceeds ${MAX_BUFFER_SIZE / 1024 / 1024}MB limit`
      );
    }

    if (!Array.isArray(editStack) || editStack.length === 0) {
      return { buffer: inputBuffer, appliedEdits: [] };
    }

    if (editStack.length > MAX_EDIT_STEPS) {
      throw new Error(
        `Edit stack has ${editStack.length} operations, maximum is ${MAX_EDIT_STEPS}`
      );
    }

    const validationErrors = this.validateEditStack(editStack);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid edit stack: ${validationErrors.join('; ')}`);
    }

    const totalStart = performance.now();
    let currentBuffer = inputBuffer;
    const applied = [];

    for (let i = 0; i < editStack.length; i++) {
      const { operation, params } = editStack[i];
      const handler = OPERATION_HANDLERS[operation];
      const stepStart = performance.now();

      try {
        currentBuffer = await handler(currentBuffer, params);

        applied.push({
          operation,
          params,
          stepIndex: i,
          durationMs: Math.round(performance.now() - stepStart)
        });
      } catch (error) {
        logger.error(`Edit step ${i} failed: ${operation}`, error);
        throw new Error(
          `Edit step ${i} (${operation}) failed: ${error.message}`
        );
      }
    }

    const totalMs = Math.round(performance.now() - totalStart);
    logger.info(`Applied ${applied.length} edits in ${totalMs}ms`);

    return { buffer: currentBuffer, appliedEdits: applied };
  },

  /**
   * Validate an edit stack without applying it.
   * Returns an array of error strings. Empty array means valid.
   *
   * @param {Array} editStack - Operations to validate
   * @returns {Array<string>}
   */
  validateEditStack(editStack) {
    const errors = [];

    if (!Array.isArray(editStack)) {
      errors.push('Edit stack must be an array');
      return errors;
    }

    if (editStack.length > MAX_EDIT_STEPS) {
      errors.push(`Edit stack has ${editStack.length} operations, maximum is ${MAX_EDIT_STEPS}`);
    }

    for (let i = 0; i < editStack.length; i++) {
      const edit = editStack[i];

      if (!edit || typeof edit !== 'object') {
        errors.push(`Step ${i}: must be an object`);
        continue;
      }

      if (!edit.operation || typeof edit.operation !== 'string') {
        errors.push(`Step ${i}: missing or invalid operation name`);
        continue;
      }

      if (!VALID_OPERATIONS.includes(edit.operation)) {
        errors.push(
          `Step ${i}: unknown operation '${edit.operation}'. Valid: ${VALID_OPERATIONS.join(', ')}`
        );
        continue;
      }

      if (!edit.params || typeof edit.params !== 'object') {
        errors.push(`Step ${i} (${edit.operation}): missing or invalid params object`);
      }
    }

    return errors;
  }
});

export default imageEditor;
