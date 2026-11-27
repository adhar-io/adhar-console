import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { compareRuns } from './compare.ts'
import type { Workflow } from './nodes.ts'

/** History's "Compare two runs" (design 0026 §6.9): parameters that differ, per-step duration delta, outcome. */

const run = (name: string, phase: string, ticket: string, buildSecs: number, retried = false): Workflow => ({
  metadata: { name },
  spec: { arguments: { parameters: [{ name: 'ticket', value: ticket }, { name: 'target', value: 'dev' }] } },
  status: {
    phase,
    startedAt: '2026-11-25T01:00:00Z',
    finishedAt: '2026-11-25T01:10:00Z',
    nodes: {
      ...(retried ? { b0: { id: 'b0', name: `${name}.build(0)`, displayName: 'build(0)', type: 'Pod', phase: 'Failed', startedAt: '2026-11-25T00:59:00Z', finishedAt: '2026-11-25T00:59:30Z' } } : {}),
      b: { id: 'b', name: `${name}.build`, displayName: retried ? 'build(1)' : 'build', type: 'Pod', phase: 'Succeeded', startedAt: '2026-11-25T01:00:00Z', finishedAt: new Date(Date.parse('2026-11-25T01:00:00Z') + buildSecs * 1000).toISOString() },
      t: { id: 't', name: `${name}.test`, displayName: 'test', type: 'Pod', phase: phase === 'Failed' ? 'Failed' : 'Succeeded', startedAt: '2026-11-25T01:05:00Z', finishedAt: '2026-11-25T01:06:00Z' },
    },
  },
})

Deno.test('parameters that differ, step deltas by name (the last attempt of a retry counts), outcomes', () => {
  const c = compareRuns(run('a', 'Succeeded', 'OPS-1', 60), run('b', 'Failed', 'OPS-2', 90, true))
  assertEquals(c.params, [{ name: 'ticket', a: 'OPS-1', b: 'OPS-2' }])
  assertEquals(c.steps.map((s) => [s.step, s.deltaMs]), [['build', 30_000], ['test', 0]])
  assertEquals(c.steps[1].bPhase, 'Failed')
  assertEquals([c.a.phase, c.b.phase], ['Succeeded', 'Failed'])
  assertEquals(c.a.durationMs, 600_000)
})
