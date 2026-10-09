import { assertEquals } from 'jsr:@std/assert'
import { availableHeight, BOTTOM_GAP, MIN_PANE } from './fill-height.ts'

/**
 * The number this replaces was `14rem` — 224px of assumed chrome, hardcoded in
 * a Tailwind `calc()`. Measured at 1600×1000 the Logs page rendered 1007px of
 * content inside a 943px `main`, so the page scrolled instead of the log list.
 */

Deno.test('the pane ends at the bottom of the viewport, whatever is above it', () => {
  assertEquals(availableHeight(180, 1000), 812) // 1000 - 180 - 8
})

Deno.test('a taller toolbar takes from the pane, not from the page', () => {
  // Two toolbar rows instead of one: the pane shrinks by exactly that much,
  // which is the thing the fixed 14rem could not do.
  const oneRow = availableHeight(180, 1000)
  const twoRows = availableHeight(224, 1000)
  assertEquals(oneRow - twoRows, 44)
})

Deno.test('a short window falls back to a readable minimum', () => {
  // Better to scroll the page than to render a pane too small to read.
  assertEquals(availableHeight(300, 500), MIN_PANE)
})

Deno.test('the floor applies exactly at the boundary, not one pixel early', () => {
  // 728 - 400 - 8 = 320, which IS the minimum and must not be clamped past.
  assertEquals(availableHeight(400, 728), 320)
  assertEquals(availableHeight(401, 728), 320)
})

/**
 * `getBoundingClientRect().top` is fractional on a HiDPI display and at
 * non-integer browser zoom. Rounding up leaves the pane a hair past the
 * viewport edge, which renders as a 1px page scrollbar over the whole shell.
 */
Deno.test('a fractional top floors, so no 1px page scrollbar appears', () => {
  assertEquals(availableHeight(180.4, 1000), 811)
  assertEquals(availableHeight(180.9, 1000), 811)
  assertEquals(Number.isInteger(availableHeight(180.4, 1000)), true)
})

Deno.test('a pane pushed off-screen still reports the minimum, never a negative', () => {
  assertEquals(availableHeight(1400, 1000), MIN_PANE)
})

Deno.test('the gap is what keeps the pane off the window edge', () => {
  assertEquals(availableHeight(100, 1000, 0) - availableHeight(100, 1000, BOTTOM_GAP), BOTTOM_GAP)
})

Deno.test('fullscreen starts at the top, so it gets nearly the whole window', () => {
  assertEquals(availableHeight(16, 1000), 976)
})
