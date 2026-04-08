/**
 * ============================================================================
 * withRetry.js — Async Retry Utility (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Retries an async function with configurable max attempts, backoff delay,
 * and an optional predicate to decide whether a given error is retryable.
 *
 * USAGE
 * -----
 *   import { withRetry } from '../utils/withRetry.js';
 *
 *   const result = await withRetry(
 *     () => fetchSomething(),
 *     { maxAttempts: 3, backoffMs: 100 }
 *   );
 *
 * PARAMETERS
 * ----------
 * fn           — Async function to execute (required, must be a function)
 * maxAttempts  — Maximum number of tries (default: 3)
 * backoffMs    — Milliseconds to wait between retries (default: 100)
 * shouldRetry  — Predicate function receiving the error, returns boolean
 *                (default: () => true, meaning all errors are retryable)
 *
 * BEHAVIOUR
 * ---------
 * - Returns the result of fn() on first success
 * - On failure, waits backoffMs then retries
 * - Stops retrying when maxAttempts reached or shouldRetry returns false
 * - Throws the last error if all attempts fail
 *
 * NAMING CONVENTIONS
 * ------------------
 * Export: named function (camelCase)
 * File: camelCase utility
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

export async function withRetry(
  fn,
  {
    maxAttempts = 3,
    backoffMs = 100,
    shouldRetry = () => true
  } = {}
) {
  if (typeof fn !== 'function') {
    throw new TypeError('withRetry: fn must be a function');
  }

  let attempt = 0;
  let lastError;

  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      lastError = err;

      if (attempt >= maxAttempts) {
        break;
      }

      if (!shouldRetry(err)) {
        break;
      }

      if (backoffMs > 0) {
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  throw lastError;
}
