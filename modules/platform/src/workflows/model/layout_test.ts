import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { layers, layoutGraph } from './layout.ts'

/** §6.8: longest-path layers, barycentric order, name tie-breaks, the exit lane below — deterministic. */

const NODES = [{ id: 'build' }, { id: 'lint' }, { id: 'test' }, { id: 'ship' }, { id: 'notify', lane: 'exit' as const }]
const EDGES = [
  { source: 'build', target: 'test' },
  { source: 'lint', target: 'ship' },
  { source: 'test', target: 'ship' },
]

Deno.test('a task sits one column after its deepest dependency', () => {
  const l = layers(NODES.filter((n) => n.lane !== 'exit'), EDGES)
  assertEquals(Object.fromEntries(l), { build: 0, lint: 0, test: 1, ship: 2 })
})

Deno.test('the same graph always lays out the same way, whatever order it arrives in', () => {
  const a = layoutGraph(NODES, EDGES)
  const b = layoutGraph([...NODES].reverse(), [...EDGES].reverse())
  assertEquals(a, b)
  assert(a.build.x < a.test.x && a.test.x < a.ship.x)
})

Deno.test('the exit lane is laid out below the whole main graph', () => {
  const p = layoutGraph(NODES, EDGES)
  const lowest = Math.max(p.build.y, p.lint.y, p.test.y, p.ship.y)
  assert(p.notify.y > lowest)
  assertEquals(p.notify.x, 0)
})

Deno.test('a cycle still terminates (validation reports it; layout must not hang)', () => {
  const p = layoutGraph([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }])
  assertEquals(Object.keys(p).sort(), ['a', 'b'])
})

Deno.test('only a running step\'s card follows the clock; finished and unstarted cards stay put between ticks', async () => {
  const { clockFor } = await import('./layout.ts')
  assertEquals(clockFor({ startedAt: '2026-11-25T01:00:00Z' }, 1000), 1000)
  assertEquals(clockFor({ startedAt: '2026-11-25T01:00:00Z' }, 2000), 2000)
  assertEquals(clockFor({ startedAt: '2026-11-25T01:00:00Z', finishedAt: '2026-11-25T01:01:00Z' }, 1000), clockFor({ startedAt: '2026-11-25T01:00:00Z', finishedAt: '2026-11-25T01:01:00Z' }, 2000))
  assertEquals(clockFor({}, 1000), clockFor({}, 2000))
})
