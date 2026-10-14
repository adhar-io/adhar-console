import { assertEquals } from 'jsr:@std/assert@^1'
import { pathEdgeKeys, reachable, shortestPath, tallyHealth } from './graph-lens.ts'

// app → deploy → pod → image ; svc → pod ; pod → node
const E = [
  { from: 'app', to: 'deploy' },
  { from: 'deploy', to: 'pod' },
  { from: 'pod', to: 'image' },
  { from: 'svc', to: 'pod' },
  { from: 'pod', to: 'node' },
]

Deno.test('upstream of a pod is everything that acts on it', () => {
  assertEquals([...reachable('pod', E, 'upstream')].sort(), ['app', 'deploy', 'pod', 'svc'])
})

Deno.test('downstream of a pod is what it relies on', () => {
  assertEquals([...reachable('pod', E, 'downstream')].sort(), ['image', 'node', 'pod'])
})

Deno.test('shortest path ignores direction', () => {
  assertEquals(shortestPath('app', 'node', E), ['app', 'deploy', 'pod', 'node'])
  assertEquals(shortestPath('svc', 'image', E), ['svc', 'pod', 'image'])
  assertEquals(shortestPath('app', 'app', E), ['app'])
  assertEquals(shortestPath('app', 'nowhere', E), null)
})

Deno.test('path edge keys cover both orientations', () => {
  const k = pathEdgeKeys(['a', 'b', 'c'])
  assertEquals(k.has('a|b') && k.has('b|a') && k.has('c|b'), true)
  assertEquals(k.size, 4)
})

Deno.test('health tally and score', () => {
  const t = tallyHealth([{ status: 'healthy' }, { status: 'healthy' }, { status: 'failed' }, { status: 'degraded' }, {}])
  assertEquals([t.healthy, t.failed, t.degraded, t.unknown], [2, 1, 1, 1])
  assertEquals(t.score, 50)
  assertEquals(tallyHealth([{}]).score, null)
})
