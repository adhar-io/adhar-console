/**
 * Graph lenses — the questions the Knowledge Graph canvas can answer about a
 * loaded neighbourhood, as pure functions over its nodes and edges.
 *
 * Edges point from the thing that acts to the thing acted on: a workload
 * `owns` its pods, a service `selects` pods, an application `manages`
 * workloads, a pod `uses-image` and `runs-on` a node. So:
 *   - "impacted by" (upstream) follows edges BACKWARD from the centre —
 *     everything that owns, selects, routes to or manages it, transitively.
 *     If the centre breaks, these notice.
 *   - "depends on" (downstream) follows edges FORWARD — what the centre owns,
 *     runs on, mounts or pulls. If one of these breaks, the centre notices.
 * Both are bounded by what the neighbourhood query returned; the canvas says
 * so when the neighbourhood was capped.
 *
 * No I/O; `graph-lens_test.ts` covers them.
 */

export interface LensEdge {
  from: string
  to: string
}

export type Direction = 'upstream' | 'downstream'

/** Nodes reachable from `rootId` following edges in one direction (root included). */
export function reachable(rootId: string, edges: LensEdge[], direction: Direction): Set<string> {
  const next = new Map<string, string[]>()
  for (const e of edges) {
    const [a, b] = direction === 'downstream' ? [e.from, e.to] : [e.to, e.from]
    next.set(a, [...(next.get(a) ?? []), b])
  }
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()!
    for (const n of next.get(id) ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return seen
}

/**
 * Shortest path between two nodes ignoring direction (BFS, so fewest hops),
 * as the node ids in order. Null when they aren't connected in this
 * neighbourhood. Ties break by edge order, which is stable per response.
 */
export function shortestPath(fromId: string, toId: string, edges: LensEdge[]): string[] | null {
  if (fromId === toId) return [fromId]
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
  }
  const prev = new Map<string, string>()
  const seen = new Set([fromId])
  const queue = [fromId]
  while (queue.length) {
    const id = queue.shift()!
    for (const n of adj.get(id) ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      prev.set(n, id)
      if (n === toId) {
        const path = [toId]
        let cur = toId
        while (prev.has(cur)) {
          cur = prev.get(cur)!
          path.unshift(cur)
        }
        return path
      }
      queue.push(n)
    }
  }
  return null
}

/** Edge ids (`from|to`, either orientation) along a node path. */
export function pathEdgeKeys(path: string[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < path.length; i++) {
    out.add(`${path[i]}|${path[i + 1]}`)
    out.add(`${path[i + 1]}|${path[i]}`)
  }
  return out
}

export type Health = 'healthy' | 'degraded' | 'progressing' | 'failed' | 'unknown'

export interface HealthTally {
  healthy: number
  progressing: number
  degraded: number
  failed: number
  unknown: number
  /** Share of status-bearing nodes that are healthy, 0–100; null if none report. */
  score: number | null
}

export function tallyHealth(nodes: Array<{ status?: Health }>): HealthTally {
  const t: HealthTally = { healthy: 0, progressing: 0, degraded: 0, failed: 0, unknown: 0, score: null }
  for (const n of nodes) t[n.status ?? 'unknown']++
  const reporting = t.healthy + t.progressing + t.degraded + t.failed
  t.score = reporting ? Math.round((t.healthy / reporting) * 100) : null
  return t
}

export const isProblem = (status?: Health) => status === 'failed' || status === 'degraded'
