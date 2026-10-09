/**
 * How tall a pane can be if it is to end at the bottom of the viewport.
 *
 * The Logs explorer used to size itself with `h-[calc(100vh-14rem)]` — 224px
 * of assumed chrome above it. Nothing kept that number true: the query band
 * wraps at narrow widths, the severity row grows when a level is added, and
 * the shell's own padding differs between content widths. Measured at 1600×1000
 * the page came to 1007px inside a 943px `main`, so the WHOLE PAGE scrolled:
 * the toolbar slid away as you read, and the log list never owned a stable
 * viewport of its own — the opposite of what a log reader needs.
 *
 * Measuring the pane's own `top` removes the guess. Whatever sits above it —
 * one toolbar row or three — the pane ends exactly at its container's bottom.
 *
 * JSX-free so it can be unit-tested; the Deno test runner has no React.
 */

/** Space below the pane, so it does not sit flush against its container's edge. */
export const BOTTOM_GAP = 8

/**
 * Below this a log pane is not worth rendering — at ~8 rows you are scrolling
 * a porthole. Short windows scroll the page instead, which is the honest
 * trade: the alternative is a pane too small to read.
 */
export const MIN_PANE = 320

/**
 * @param top    the pane's own `getBoundingClientRect().top`.
 * @param bottom where the pane must END — the CONTENT bottom of whatever
 *   scrolls it, not the window. Measuring to the window was the first fix and
 *   it was still wrong: the app shell wraps the page in `py-8`, so a pane that
 *   stopped at the viewport edge pushed 32px of padding past it and the page
 *   kept a scrollbar. The caller subtracts the padding and margins between the
 *   pane and its container, which is what makes this self-correcting.
 */
export function availableHeight(
  top: number,
  bottom: number,
  gap: number = BOTTOM_GAP,
  min: number = MIN_PANE,
): number {
  // `top` arrives from getBoundingClientRect and is fractional on HiDPI and at
  // non-integer zoom. Flooring keeps the pane a whole pixel short of the edge
  // rather than a hair past it, which is what produces a 1px page scrollbar.
  const fits = Math.floor(bottom - top - gap)
  return Math.max(min, fits)
}
