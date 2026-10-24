import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { UserTtlCache } from './user-cache.ts'

Deno.test('UserTtlCache serves within ttl, recomputes after', async () => {
  let t = 0
  let calls = 0
  const c = new UserTtlCache<number>(30_000, 10, () => t)
  const f = () => Promise.resolve(++calls)
  assertEquals(await c.get('u1', f), 1)
  t = 29_999
  assertEquals(await c.get('u1', f), 1)
  t = 30_000
  assertEquals(await c.get('u1', f), 2)
})

Deno.test('UserTtlCache keys per user', async () => {
  const c = new UserTtlCache<string>(30_000)
  assertEquals(await c.get('a', () => Promise.resolve('A')), 'A')
  assertEquals(await c.get('b', () => Promise.resolve('B')), 'B')
  assertEquals(await c.get('a', () => Promise.resolve('X')), 'A')
})

Deno.test('UserTtlCache single-flights concurrent misses', async () => {
  let calls = 0
  let release!: (v: number) => void
  const c = new UserTtlCache<number>(30_000)
  const f = () => {
    calls++
    return new Promise<number>((r) => (release = r))
  }
  const a = c.get('u', f)
  const b = c.get('u', f)
  release(7)
  assertEquals([await a, await b], [7, 7])
  assertEquals(calls, 1)
})

Deno.test('UserTtlCache does not keep rejected or unkept values', async () => {
  let calls = 0
  const c = new UserTtlCache<number>(30_000)
  await assertRejects(() => c.get('u', () => Promise.reject(new Error('x'))))
  assertEquals(await c.get('u', () => Promise.resolve(++calls), (v) => v > 1), 1)
  assertEquals(await c.get('u', () => Promise.resolve(++calls), (v) => v > 1), 2)
  assertEquals(await c.get('u', () => Promise.resolve(++calls)), 2)
})

Deno.test('UserTtlCache evicts oldest beyond max and invalidates', async () => {
  const c = new UserTtlCache<number>(30_000, 2)
  await c.get('a', () => Promise.resolve(1))
  await c.get('b', () => Promise.resolve(2))
  await c.get('c', () => Promise.resolve(3))
  assertEquals(await c.get('a', () => Promise.resolve(9)), 9)
  c.invalidate('c')
  assertEquals(await c.get('c', () => Promise.resolve(8)), 8)
})
