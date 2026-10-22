import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { BoundedQueue } from './queue.ts'

Deno.test('queue: one worker, in order, push never blocks', async () => {
  const seen: number[] = []
  let active = 0
  let maxActive = 0
  const q = new BoundedQueue<number>(async (n) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 1))
    seen.push(n)
    active--
  }, 10)
  for (let i = 0; i < 5; i++) q.push(i)
  await q.idle()
  assertEquals(seen, [0, 1, 2, 3, 4])
  assertEquals(maxActive, 1)
})

Deno.test('queue: overflow drops the OLDEST waiting job', async () => {
  const seen: number[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const q = new BoundedQueue<number>(async (n) => {
    if (n === 0) await gate
    seen.push(n)
  }, 2)
  q.push(0) // running, blocked on the gate
  q.push(1)
  q.push(2)
  q.push(3) // queue full (1, 2) → 1 is dropped
  release()
  await q.idle()
  assertEquals(seen, [0, 2, 3])
  assertEquals(q.dropped, 1)
})

Deno.test('queue: a failing job is logged once per distinct error and the worker carries on', async () => {
  const logs: string[] = []
  const q = new BoundedQueue<number>((n) => (n < 3 ? Promise.reject(new Error(`Plane 503 on /issues/${'a1b2c3d4e5'}${n}`)) : Promise.resolve()), 10, (m) => logs.push(m))
  for (let i = 0; i < 4; i++) q.push(i)
  await q.idle()
  assertEquals(q.failed, 3)
  assertEquals(q.processed, 1)
  assertEquals(logs.length, 1)
})

Deno.test('queue: run() resolves with the job result or rejects with its error', async () => {
  const q = new BoundedQueue<number>((n) => (n < 0 ? Promise.reject(new Error('nope')) : Promise.resolve(n * 2)), 10, () => {})
  assertEquals(await q.run<number>(21), 42)
  await assertRejects(() => q.run(-1), Error, 'nope')
})
