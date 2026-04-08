/**
 * ============================================================================
 * constants.js — Council Terminal Global Constants (v010)
 * ============================================================================
 *
 * PURPOSE
 * -------
 * Single source of truth for fixed IDs and values used across the
 * council terminal pipeline. Prevents hardcoding in phase handlers.
 *
 * RULES
 * -----
 * - All values must be frozen (immutable)
 * - Character IDs must be valid hex format (#XXXXXX)
 * - No generated IDs here — only fixed, known constants
 * - Add new constants alphabetically within their section
 *
 * If documentation conflicts with code, CODE WINS.
 * ============================================================================
 */

export const CLAUDE_CHARACTER_ID = '#700002';
