/**
 * Safe float parsing with nullish coalescing
 * Replaces unsafe parseFloat(str) || 0 patterns
 * 
 * @param {any} value - Input to convert
 * @returns {number} Parsed float or 0
 */
export const safeFloat = (value) => {
  if (value === null || value === undefined) return 0;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Safe integer parsing
 * 
 * @param {any} value - Input to convert
 * @returns {number} Parsed integer or 0
 */
export const safeInt = (value) => {
  if (value === null || value === undefined) return 0;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};
