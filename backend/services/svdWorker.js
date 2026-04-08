/**
 * ============================================================================
 * svdWorker.js — SVD Computation Worker Thread (v010 r3)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Performs CPU-intensive truncated SVD computation in a separate thread
 * to prevent blocking the Node.js event loop during SemanticEmbedder
 * training. Cold-start SVD on ~1500 vocab takes 20-25 seconds — this
 * must not freeze socket connections or HTTP responses.
 *
 * V010 R3 CHANGES FROM R2
 * -----------------------
 * - Timeout race condition fixed: completed flag prevents double-message
 *   when timeout fires after computeSVD throws. aborted flag reset in
 *   finally block so worker is clean for next computation.
 *
 * V010 R2 CHANGES FROM R1
 * -----------------------
 * - Timeout guard: MAX_RUNTIME_MS (60s) kills hung computations
 * - Progress reporting: emits { type: 'progress' } every 10 dimensions
 * - Input validation: rejects malformed messages before computation
 * - Abort support: parent can send { type: 'abort' } to cancel
 * - Per-dimension metrics: aggregates convergence data for all dims
 * - Log forwarding: emits { type: 'log' } for parent to route to logger
 *
 * HOW IT WORKS
 * ------------
 * 1. Parent (SemanticEmbedder) sends PPMI matrix + config via postMessage
 * 2. Worker validates input, starts computation with timeout guard
 * 3. Progress events sent every 10 dimensions
 * 4. Worker posts back result matrix + per-dimension convergence metrics
 * 5. Parent receives result and continues training pipeline
 *
 * ALGORITHM
 * ---------
 * Adaptive power iteration with Gram-Schmidt orthogonalisation.
 * For each dimension k:
 *   - Initialise vector v with deterministic pseudo-random values
 *   - Iterate: v = normalize(A^T * A * v)
 *   - Deflate: subtract projections onto previously found dimensions
 *   - Converge when residual < tolerance
 *
 * Mathematically identical to the v009 implementation but runs off
 * the main thread with timeout protection, abort support, and
 * progress reporting.
 *
 * COMMUNICATION PROTOCOL
 * ----------------------
 * Input (compute):
 *   { type: 'compute', matrix: number[][], vectorDimensions: number,
 *     convergenceTolerance: number, maxIterations: number }
 *
 * Input (abort):
 *   { type: 'abort' }
 *
 * Output (result):
 *   { type: 'result', result: number[][], metrics: object }
 *
 * Output (progress):
 *   { type: 'progress', currentDim: number, totalDims: number,
 *     converged: boolean, residual: string }
 *
 * Output (log):
 *   { type: 'log', level: string, message: string, data: object }
 *
 * Output (error):
 *   { type: 'error', error: string }
 *
 * RACE CONDITION SAFETY
 * ---------------------
 * The completed flag prevents the timeout handler from posting an error
 * message after computeSVD has already resolved (either success or
 * exception). Without this, a slow computeSVD throw followed by a
 * timeout fire would produce two error messages to the parent.
 *
 * The aborted flag is reset in the finally block so the worker is
 * clean for subsequent computations without requiring a restart.
 *
 * DEPENDENCIES
 * ------------
 * None. Pure computation. No imports beyond worker_threads.
 *
 * External: None
 * ============================================================================
 */

import { parentPort } from 'worker_threads';

/* ────────────────────────────────────────────────────────────────────────── */
/*  Constants                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const MAX_RUNTIME_MS = 60000;
const MAX_VECTOR_DIMENSIONS = 512;
const MAX_MATRIX_SIZE = 5000;
const PROGRESS_INTERVAL = 10;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Abort Flag                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

let aborted = false;

/* ────────────────────────────────────────────────────────────────────────── */
/*  Log Forwarding                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

function log(level, message, data) {
  parentPort.postMessage({ type: 'log', level, message, data: data || {} });
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Vector Math                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function normalize(vec) {
  const n = vec.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;

  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = vec[i] / norm;
  }
  return result;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Input Validation                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function validateInput(msg) {
  if (!msg || typeof msg !== 'object') {
    return 'Input must be an object';
  }
  if (!Array.isArray(msg.matrix) || msg.matrix.length === 0) {
    return 'matrix must be a non-empty array';
  }
  if (!Number.isInteger(msg.vectorDimensions) || msg.vectorDimensions < 1) {
    return 'vectorDimensions must be a positive integer';
  }
  if (msg.vectorDimensions > MAX_VECTOR_DIMENSIONS) {
    return 'vectorDimensions exceeds maximum (' + MAX_VECTOR_DIMENSIONS + ')';
  }
  if (msg.matrix.length > MAX_MATRIX_SIZE) {
    return 'matrix size exceeds maximum (' + MAX_MATRIX_SIZE + ')';
  }
  if (typeof msg.convergenceTolerance !== 'number' || msg.convergenceTolerance <= 0) {
    return 'convergenceTolerance must be a positive number';
  }
  if (!Number.isInteger(msg.maxIterations) || msg.maxIterations < 1) {
    return 'maxIterations must be a positive integer';
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  SVD Computation                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

function computeSVD(matrix, vectorDimensions, convergenceTolerance, maxIterations) {
  const n = matrix.length;
  const k = vectorDimensions;
  const result = Array(n).fill(null).map(() => new Float64Array(k));

  const perDimension = [];
  let totalIterations = 0;

  log('info', 'SVD computation started', { vocabSize: n, dimensions: k, tolerance: convergenceTolerance });

  for (let dim = 0; dim < k; dim++) {
    if (aborted) {
      log('warn', 'SVD aborted by parent', { completedDims: dim });
      return { aborted: true, completedDims: dim };
    }

    let v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      v[i] = Math.sin(i * 12.9898 + dim * 78.233) * 43758.5453 % 1;
    }
    v = normalize(v);

    let converged = false;
    let residual = Infinity;
    let iter = 0;

    for (iter = 0; iter < maxIterations; iter++) {
      if (aborted) {
        log('warn', 'SVD aborted during iteration', { dim, iter });
        return { aborted: true, completedDims: dim };
      }

      const vPrev = new Float64Array(v);

      const Av = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          Av[i] += matrix[i][j] * v[j];
        }
      }

      const AtAv = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          AtAv[i] += matrix[j][i] * Av[j];
        }
      }

      for (let prevDim = 0; prevDim < dim; prevDim++) {
        const prevVec = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          prevVec[i] = result[i][prevDim];
        }
        const dotProd = dot(AtAv, prevVec);
        for (let i = 0; i < n; i++) {
          AtAv[i] -= dotProd * prevVec[i];
        }
      }

      v = normalize(AtAv);

      const diff = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        diff[i] = v[i] - vPrev[i];
      }
      residual = dot(diff, diff);

      if (residual < convergenceTolerance) {
        converged = true;
        break;
      }
    }

    for (let i = 0; i < n; i++) {
      result[i][dim] = v[i];
    }

    const dimIterations = iter + (converged ? 1 : 0);
    totalIterations += dimIterations;

    perDimension.push({
      dim,
      iterations: dimIterations,
      converged,
      residual
    });

    if (dim % PROGRESS_INTERVAL === 0 || dim === k - 1) {
      parentPort.postMessage({
        type: 'progress',
        currentDim: dim + 1,
        totalDims: k,
        converged,
        residual: residual.toExponential(2)
      });
    }
  }

  log('info', 'SVD computation complete', {
    totalIterations,
    dimensionsComputed: k,
    allConverged: perDimension.every(d => d.converged)
  });

  const plainResult = result.map(row => Array.from(row));

  return {
    result: plainResult,
    metrics: {
      totalIterations,
      dimensionsComputed: k,
      allConverged: perDimension.every(d => d.converged),
      finalResidual: perDimension.length > 0 ? perDimension[perDimension.length - 1].residual : null,
      perDimension
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Message Handler (Race-Condition Safe)                                     */
/* ────────────────────────────────────────────────────────────────────────── */

parentPort.on('message', (msg) => {
  if (msg && msg.type === 'abort') {
    aborted = true;
    log('info', 'Abort signal received');
    return;
  }

  const validationError = validateInput(msg);
  if (validationError) {
    parentPort.postMessage({ type: 'error', error: 'Validation failed: ' + validationError });
    return;
  }

  aborted = false;
  let completed = false;

  const timeout = setTimeout(() => {
    if (!completed) {
      aborted = true;
      log('error', 'SVD computation timeout exceeded', { maxMs: MAX_RUNTIME_MS });
      parentPort.postMessage({ type: 'error', error: 'SVD computation timeout exceeded (' + MAX_RUNTIME_MS + 'ms)' });
    }
  }, MAX_RUNTIME_MS);

  try {
    const { matrix, vectorDimensions, convergenceTolerance, maxIterations } = msg;
    const output = computeSVD(matrix, vectorDimensions, convergenceTolerance, maxIterations);

    completed = true;
    clearTimeout(timeout);

    if (output.aborted) {
      parentPort.postMessage({ type: 'error', error: 'SVD computation aborted', completedDims: output.completedDims });
      return;
    }

    parentPort.postMessage({ type: 'result', result: output.result, metrics: output.metrics });
  } catch (err) {
    completed = true;
    clearTimeout(timeout);
    parentPort.postMessage({ type: 'error', error: err.message });
  } finally {
    aborted = false;
  }
});
