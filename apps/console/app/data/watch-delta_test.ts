import { assert, assertEquals, assertStrictEquals } from 'jsr:@std/assert'
import { applyWatchEvents, createThrottle, watchKey } from './watch-delta.ts'

const o = (name: string, v = 1, namespace = 'ns') => ({ metadata: { name, namespace }, v })

Deno.test('watchKey is namespace/name', () => {
  assertEquals(watchKey(o('a')), 'ns/a')
  assertEquals(watchKey({ metadata: { name: 'n' } }), '/n')
})

Deno.test('applyWatchEvents adds, modifies and deletes in order', () => {
  const list = [o('a'), o('b')]
  const r = applyWatchEvents(list, [
    { type: 'MODIFIED', object: o('a', 2) },
    { type: 'ADDED', object: o('c') },
    { type: 'DELETED', object: o('b') },
    { type: 'BOOKMARK', object: o('zz') },
  ])
  assert(r.changed)
  assertEquals(r.unknown, false)
  assertEquals(r.next, [o('a', 2), o('c')])
  // input untouched
  assertEquals(list, [o('a'), o('b')])
})

Deno.test('applyWatchEvents: delete then re-add the same name', () => {
  const r = applyWatchEvents([o('a')], [{ type: 'DELETED', object: o('a') }, { type: 'ADDED', object: o('a', 3) }])
  assertEquals(r.next, [o('a', 3)])
})

Deno.test('applyWatchEvents mergeOnly never adds, reports unknown', () => {
  const r = applyWatchEvents([o('a')], [{ type: 'ADDED', object: o('x') }, { type: 'MODIFIED', object: o('a', 5) }], { mergeOnly: true })
  assertEquals(r.next, [o('a', 5)])
  assert(r.unknown)
})

Deno.test('applyWatchEvents maps objects and keeps identity when nothing changed', () => {
  const list = [{ metadata: { name: 'a', namespace: 'ns' }, kind: 'X' }]
  const same = applyWatchEvents(list, [{ type: 'DELETED', object: o('missing') }])
  assertStrictEquals(same.next, list)
  assertEquals(same.changed, false)
  const mapped = applyWatchEvents(list, [{ type: 'MODIFIED', object: o('a') }], { map: (x) => ({ ...(x as object), kind: 'X' }) as typeof list[0] })
  assertEquals(mapped.next[0].kind, 'X')
})

Deno.test('createThrottle coalesces bursts and spaces runs by minGap', () => {
  let t = 0
  const timers: Array<{ at: number; cb: () => void }> = []
  const clock = {
    now: () => t,
    set: (cb: () => void, ms: number) => {
      const h = { at: t + ms, cb }
      timers.push(h)
      return h
    },
    clear: (h: unknown) => timers.splice(timers.indexOf(h as typeof timers[0]), 1),
  }
  const advance = (to: number) => {
    t = to
    for (;;) {
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      due.cb()
    }
  }
  let runs = 0
  const th = createThrottle(() => runs++, 10_000, 500, clock)
  th.call()
  th.call()
  th.call()
  advance(499)
  assertEquals(runs, 0)
  advance(500)
  assertEquals(runs, 1)
  th.call() // within the gap → trailing run at 10_500
  advance(5_000)
  assertEquals(runs, 1)
  advance(10_500)
  assertEquals(runs, 2)
  th.call()
  th.cancel()
  advance(30_000)
  assertEquals(runs, 2)
})
