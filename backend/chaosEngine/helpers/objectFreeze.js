/**
 * ===========================================================================
 * objectFreeze.js — LEGACY / UNUSED
 * ===========================================================================
 *
 * STATUS: NOT IMPORTED BY ANY MODULE.
 *
 * This file was created during the Kimi test build but is not used.
 * chaosConfig.js defines its own inline freeze() function and does not
 * import from this file. No other Chaos Engine module references it.
 *
 * Retained for reference only. Safe to delete.
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Chaos Engine — Helpers (unused)
 * ===========================================================================
 */

export function freeze(obj) {
    Object.keys(obj).forEach(key => {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            freeze(obj[key]);
        }
    });
    return Object.freeze(obj);
}
