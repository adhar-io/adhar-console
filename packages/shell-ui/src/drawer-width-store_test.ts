import { assert, assertEquals } from 'jsr:@std/assert'
import {
  DRAWER_WIDE_CLASS,
  DRAWER_WIDE_PREFIX,
  type DrawerStorage,
  drawerWidthClass,
  isTypingTarget,
  readDrawerWide,
  resetDrawerWideMemory,
  subscribeDrawerWide,
  writeDrawerWide,
} from './drawer-width-store.ts'

function fakeStorage(): DrawerStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  }
}

const throwing: DrawerStorage = {
  getItem() {
    throw new DOMException('blocked', 'SecurityError')
  },
  setItem() {
    throw new DOMException('quota', 'QuotaExceededError')
  },
}

Deno.test('drawer width: nothing saved reads as undefined', () => {
  resetDrawerWideMemory()
  assertEquals(readDrawerWide('a', fakeStorage()), undefined)
})

Deno.test('drawer width: a saved preference persists per drawer id', () => {
  resetDrawerWideMemory()
  const s = fakeStorage()
  writeDrawerWide('deliver.argo-app', true, s)
  writeDrawerWide('workspace.audit', false, s)
  assertEquals(s.data.get(DRAWER_WIDE_PREFIX + 'deliver.argo-app'), '1')
  assertEquals(s.data.get(DRAWER_WIDE_PREFIX + 'workspace.audit'), '0')
  // A fresh page load (memory gone) reads it back from storage.
  resetDrawerWideMemory()
  assertEquals(readDrawerWide('deliver.argo-app', s), true)
  assertEquals(readDrawerWide('workspace.audit', s), false)
  assertEquals(readDrawerWide('other', s), undefined)
})

Deno.test('drawer width: works without storage (throwing or missing)', () => {
  resetDrawerWideMemory()
  assertEquals(readDrawerWide('x', throwing), undefined)
  writeDrawerWide('x', true, throwing) // must not throw
  assertEquals(readDrawerWide('x', throwing), true)
  writeDrawerWide('y', true, undefined)
  assertEquals(readDrawerWide('y', undefined), true)
})

Deno.test('drawer width: writes notify subscribers so every instance stays in sync', () => {
  resetDrawerWideMemory()
  let calls = 0
  const off = subscribeDrawerWide(() => calls++)
  writeDrawerWide('z', true, fakeStorage())
  writeDrawerWide('z', false, fakeStorage())
  off()
  writeDrawerWide('z', true, fakeStorage())
  assertEquals(calls, 2)
})

Deno.test('drawer width: class keeps the standard width and adds the wide override only when wide', () => {
  const std = drawerWidthClass('max-w-3xl', false)
  const wide = drawerWidthClass('max-w-3xl', true)
  assert(std.includes('max-w-3xl') && !std.includes(DRAWER_WIDE_CLASS))
  assert(wide.includes('max-w-3xl') && wide.includes(DRAWER_WIDE_CLASS))
  assert(std.includes('motion-safe:transition-[max-width]'))
  // The wide override is lg-only: phones keep their full-width drawer.
  assert(DRAWER_WIDE_CLASS.startsWith('lg:'))
})

Deno.test('drawer width: the shortcut ignores typing targets', () => {
  assertEquals(isTypingTarget(null), false)
  assertEquals(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget), true)
  assertEquals(isTypingTarget({ tagName: 'textarea' } as unknown as EventTarget), true)
  assertEquals(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true)
  assertEquals(isTypingTarget({ tagName: 'BUTTON', closest: () => null } as unknown as EventTarget), false)
})
