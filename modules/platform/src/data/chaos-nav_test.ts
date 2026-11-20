import { assertEquals } from 'jsr:@std/assert@1'
import { drawerOf, mergeParams, navMode, opensInPlace } from './chaos-nav.ts'

/**
 * The drawer history rules: Back must close a drawer the page opened, X must
 * close it without leaving a dead Back press behind, and moving between
 * drawers must not stack one entry per click.
 */

Deno.test('drawerOf names the open drawer, and nothing for tabs and filters', () => {
  assertEquals(drawerOf({ tab: 'reports', commit: 'abc1234' }), undefined)
  assertEquals(drawerOf({ tab: 'experiments', run: 'cart-pod-delete' }), 'run=cart-pod-delete')
  assertEquals(drawerOf({ compare: 'a~b' }), 'compare=a~b')
})

Deno.test('mergeParams applies a patch and drops cleared keys', () => {
  assertEquals(mergeParams({ tab: 'reports', report: 'r1' }, { report: undefined, compare: 'r0~r1' }), { tab: 'reports', compare: 'r0~r1' })
  assertEquals(mergeParams({ tab: 'reports', commit: 'abc' }, { commit: '' }), { tab: 'reports' })
})

Deno.test('opening a drawer pushes, so Back closes it', () => {
  assertEquals(navMode({ tab: 'experiments' }, { run: 'kill-cart' }, false), 'push')
  assertEquals(navMode({}, { gameday: 'friday' }, false), 'push')
})

Deno.test('moving from one drawer to another replaces the entry', () => {
  // A re-run opening the new run in place; a report opening its comparison.
  assertEquals(navMode({ run: 'kill-cart' }, { run: 'kill-cart-r2' }, true), 'replace')
  assertEquals(navMode({ report: 'r1' }, { report: undefined, compare: 'r0~r1' }, true), 'replace')
})

Deno.test('closing a drawer this page pushed goes back; one that came with the URL is replaced', () => {
  assertEquals(navMode({ tab: 'experiments', run: 'kill-cart' }, { run: undefined }, true), 'back')
  // A pasted link or a reload: there is no entry beneath to go back to.
  assertEquals(navMode({ tab: 'experiments', run: 'kill-cart' }, { run: undefined }, false), 'replace')
})

Deno.test('a close that also changes the tab lands where it asked, not one step back', () => {
  assertEquals(navMode({ job: 'gate-cart-1' }, { job: undefined, tab: 'reports' }, true), 'replace')
})

Deno.test('tabs and filters never add history entries', () => {
  assertEquals(navMode({}, { tab: 'library' }, false), 'replace')
  assertEquals(navMode({ tab: 'reports' }, { commit: 'abc1234' }, false), 'replace')
  // With a drawer open, too.
  assertEquals(navMode({ run: 'x' }, { tab: 'reports' }, true), 'replace')
})

Deno.test('a drawer opened together with a tab change is not closed by going back', () => {
  // A game day started from the Library opens on Game days; closing it must
  // stay on Game days, so that push is not one the close may undo.
  assertEquals(opensInPlace({ tab: 'library' }, { gameday: 'friday', tab: 'gamedays' }), false)
  assertEquals(opensInPlace({ tab: 'experiments' }, { run: 'kill-cart' }), true)
})
