import { assertEquals } from 'jsr:@std/assert@1'
import { isTopOverlay, pushOverlay } from './overlay-stack.ts'

Deno.test('only the most recently opened overlay is on top', () => {
  const drawer = Symbol('drawer')
  const dialog = Symbol('dialog')
  const popDrawer = pushOverlay(drawer)
  assertEquals(isTopOverlay(drawer), true)
  const popDialog = pushOverlay(dialog)
  // ESC now belongs to the dialog only — the drawer stays open.
  assertEquals(isTopOverlay(dialog), true)
  assertEquals(isTopOverlay(drawer), false)
  popDialog()
  assertEquals(isTopOverlay(drawer), true)
  popDrawer()
  assertEquals(isTopOverlay(drawer), false)
})

Deno.test('closing an overlay out of order leaves the others in place', () => {
  const a = Symbol('a')
  const b = Symbol('b')
  const popA = pushOverlay(a)
  const popB = pushOverlay(b)
  popA()
  assertEquals(isTopOverlay(b), true)
  popA() // idempotent
  popB()
  assertEquals(isTopOverlay(b), false)
})
