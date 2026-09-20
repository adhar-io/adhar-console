import { assertEquals } from 'jsr:@std/assert'
import { chartMax, chartPeak } from './chart-scale.ts'

/**
 * One expression, but every line chart in the console scales by it — and it
 * was wrong for a whole class of data in a way nothing failed on: the chart
 * still drew, it just drew the wrong shape under the wrong label.
 */

Deno.test('a series below 1 scales to its own peak, not to 1', () => {
  // The bug: `Math.max(1, ...)` returned 1 here, so a throttling ratio
  // peaking at 35% was drawn at a third of the height and the axis said
  // "100%". Ratios and fractional cores are most of a performance report.
  assertEquals(chartMax([0, 0.1, 0.35, 0.2]), 0.35)
  assertEquals(chartMax([0.004, 0.009]), 0.009)
})

Deno.test('an all-zero series gets a nominal 1 rather than dividing by zero', () => {
  // It draws as a flat line along the bottom, which is the honest picture of
  // a metric that never moved.
  assertEquals(chartMax([0, 0, 0]), 1)
  assertEquals(chartMax([]), 1)
})

Deno.test('ordinary series are unaffected', () => {
  assertEquals(chartMax([1, 5, 3]), 5)
  assertEquals(chartMax([100, 20]), 100)
})

Deno.test('non-finite values cannot become the scale', () => {
  // A NaN peak makes every point NaN and the path disappears silently.
  assertEquals(chartMax([1, NaN, 3]), 3)
  assertEquals(chartMax([1, Infinity, 2]), 2)
  assertEquals(chartMax([NaN, NaN]), 1)
})

Deno.test('negative values do not produce a negative scale', () => {
  // Dividing by a negative max flips the chart upside down.
  assertEquals(chartMax([-5, -1]), 1)
  assertEquals(chartMax([-5, 2]), 2)
})

Deno.test('the axis peak is what was measured, not the drawing scale', () => {
  // A series that never moved must not claim a peak of 1 just because the
  // drawing needs a non-zero divisor.
  assertEquals(chartPeak([0, 0, 0]), 0)
  assertEquals(chartMax([0, 0, 0]), 1)
  // Everywhere else the two agree.
  assertEquals(chartPeak([0.35, 0.1]), chartMax([0.35, 0.1]))
})
