/**
 * Vertical scale for the line charts.
 *
 * Extracted so it can be tested: the charts themselves need React and a DOM,
 * and this one expression is where they were quietly wrong.
 *
 * The rule is simply "scale to the data", with one exception — a series that
 * is entirely zero has no peak to scale to and would divide by zero, so it
 * gets a nominal 1 and draws as a flat line along the bottom.
 *
 * The version this replaces was `Math.max(1, ...values)`, which looks like the
 * same guard but is not: it made 1 the FLOOR of the maximum, so every series
 * whose values sit below one was compressed into the bottom fraction of the
 * chart and labelled with an axis maximum it never reached. Ratios (CPU
 * throttling, error rate) and fractional cores — which is most of what a
 * performance report draws — were all affected.
 */
export function chartMax(values: number[]): number {
  return chartPeak(values) || 1
}

/**
 * The highest value actually observed — 0 for a series that never moved.
 *
 * Kept separate from `chartMax` because the two answer different questions.
 * `chartMax` scales the drawing and must never be zero; the AXIS LABEL
 * reports what was measured, and an all-zero series that says "peak 1.00"
 * is claiming a value it never reached.
 */
export function chartPeak(values: number[]): number {
  let peak = 0
  for (const v of values) {
    if (Number.isFinite(v) && v > peak) peak = v
  }
  return peak
}
