/**
 * ===========================================================================
 * harmonicMean.js — Weighted Harmonic Mean Utility
 * ===========================================================================
 *
 * PURPOSE:
 * Pure mathematical function implementing weighted harmonic mean. Used
 * throughout the Ikigai Engine at three levels:
 *   1. Within Kamiya Layer — composite of seven need scores
 *   2. Within Okinawan Layer — composite of four pillar scores
 *   3. Integration Layer — 2ko/(k+o) overall composite
 *
 * WHY HARMONIC MEAN:
 * The harmonic mean penalises neglected dimensions more severely than
 * arithmetic or geometric means. A character cannot score high by maxing
 * one need and ignoring six — a single near-zero input suppresses the
 * entire composite toward zero. This is the intended behaviour.
 *
 * This property is the mathematical foundation of the compensation
 * detection architecture (Johannes et al., 2022). A high Kamiya score
 * cannot mask a hollow Okinawan score because the harmonic mean of
 * (0.8, 0.001) ≈ 0.002, not 0.4.
 *
 * FORMULA:
 *   H = sum(w_i) / sum(w_i / v_i)
 *   where v_i = max(value_i, 0.0001) to prevent division by zero.
 *
 * If no weights are provided, all values are equally weighted (1.0 each).
 *
 * CONSTRAINTS:
 *   - No external dependencies
 *   - No Math.random()
 *   - Deterministic for identical inputs
 *   - Floor at 0.0001 prevents division-by-zero without masking
 *     legitimately near-zero scores
 *
 * EXPORTS:
 *   harmonicMean(values, weights?) → number
 *
 * RESEARCH CITATIONS:
 *   [1]  Johannes, N., Nguyen, M. H., Vuorre, M., et al. (2022). Do people
 *        use video games to compensate for psychological needs?
 *        [Harmonic mean rationale — compensation detection]
 *
 * ===========================================================================
 * Project: The Expanse v011
 * System: Ikigai Engine — Pure Math Utility
 * Licence: Intended MIT (pending GRIDLab validation)
 * ===========================================================================
 */
export function harmonicMean(values, weights = null) {
  const w = weights || values.map(() => 1.0);
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < values.length; i++) {
    const v = Math.max(values[i], 0.0001);
    numerator += w[i];
    denominator += w[i] / v;
  }

  return numerator / denominator;
}
