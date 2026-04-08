/**
 * ============================================================================
 * counters.js — Phase & System Metrics (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Lightweight in-process metrics collection for phase execution,
 * EarWig detection, intent matching, voice assembly, and latency.
 *
 * V010 CHANGES FROM V009
 * ----------------------
 * - Dynamic metric registration: any metric name auto-creates on first
 *   increment. v009 hardcoded 5 metrics and silently dropped unknown ones.
 * - Latency buffer capped at MAX_LATENCY_ENTRIES to prevent unbounded
 *   memory growth in long-running processes.
 * - Structured logger integration.
 * - Documentation header.
 * - Frozen export singleton.
 *
 * USAGE
 * -----
 *   import Counters from '../metrics/counters.js';
 *
 *   Counters.increment('phase_executed', 'emotional');
 *   Counters.increment('intent_match_success', 'GREETING');
 *   Counters.recordLatency('emotional', 42);
 *   Counters.recordConfidence(0.87);
 *   const snapshot = Counters.dump();
 *   Counters.reset();
 *
 * DESIGN
 * ------
 * - All counter Maps are created dynamically on first use
 * - increment() accepts any metric/label pair
 * - recordLatency() uses a bounded circular buffer
 * - dump() serialises all Maps to plain objects for JSON transport
 * - reset() clears everything
 * - Thread-safe for single-process Node.js (no mutex needed)
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

import { createModuleLogger } from '../../utils/logger.js';

const logger = createModuleLogger('Counters');

const MAX_LATENCY_ENTRIES = 1000;

class Counters {
  constructor() {
    this._metrics = new Map();
    this._latency = [];
    this._confidenceDistribution = new Map();
  }

  /**
   * Increment a named metric by label.
   * Auto-creates the metric Map if it does not exist.
   *
   * @param {string} metric - Metric name (e.g. 'phase_executed')
   * @param {string} label - Label within metric (e.g. 'emotional')
   * @param {number} [value=1] - Amount to increment
   */
  increment(metric, label, value = 1) {
    if (!metric || !label) {
      return;
    }

    if (!this._metrics.has(metric)) {
      this._metrics.set(metric, new Map());
    }

    const metricMap = this._metrics.get(metric);
    const current = metricMap.get(label) || 0;
    metricMap.set(label, current + value);
  }

  /**
   * Record phase latency in milliseconds.
   * Bounded to MAX_LATENCY_ENTRIES (oldest entries dropped).
   *
   * @param {string} phase - Phase name
   * @param {number} durationMs - Duration in milliseconds
   */
  recordLatency(phase, durationMs) {
    if (this._latency.length >= MAX_LATENCY_ENTRIES) {
      this._latency.shift();
    }

    this._latency.push({
      phase,
      seconds: durationMs / 1000,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Record confidence value into distribution histogram.
   * Bins to nearest 0.1.
   *
   * @param {number} value - Confidence value 0-1
   */
  recordConfidence(value) {
    const bin = Math.floor(value * 10) / 10;
    const current = this._confidenceDistribution.get(bin) || 0;
    this._confidenceDistribution.set(bin, current + 1);
  }

  /**
   * Get a specific metric's current counts.
   *
   * @param {string} metric - Metric name
   * @returns {object|null} Plain object of label:count pairs or null
   */
  get(metric) {
    const metricMap = this._metrics.get(metric);
    if (!metricMap) {
      return null;
    }
    return Object.fromEntries(metricMap);
  }

  /**
   * Dump all metrics as a JSON-serialisable snapshot.
   *
   * @returns {object} Full metrics snapshot
   */
  dump() {
    const metricsSnapshot = {};
    for (const [name, map] of this._metrics) {
      metricsSnapshot[name] = Object.fromEntries(map);
    }

    return {
      timestamp: new Date().toISOString(),
      metrics: metricsSnapshot,
      latency: {
        entries: this._latency.length,
        maxEntries: MAX_LATENCY_ENTRIES,
        recent: this._latency.slice(-10)
      },
      confidenceDistribution: Object.fromEntries(this._confidenceDistribution)
    };
  }

  /**
   * Reset all metrics. Used between test runs or admin commands.
   */
  reset() {
    const metricCount = this._metrics.size;
    const latencyCount = this._latency.length;

    this._metrics.clear();
    this._latency = [];
    this._confidenceDistribution.clear();

    logger.info('Counters reset', { metricCount, latencyCount });
  }
}

export default new Counters();
