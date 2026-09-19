import type { Contribution, GraphEdge, GraphNode, NodeKind } from './model.ts'

/**
 * The in-memory graph index.
 *
 * Holds every node and edge, keeps the adjacency current as objects come and
 * go, and answers the three questions everything else is built on: find a
 * node, walk its neighbourhood, and project a filtered subgraph.
 *
 * ---------------------------------------------------------------------------
 * WHY CONTRIBUTIONS ARE OWNED BY THEIR SOURCE
 * ---------------------------------------------------------------------------
 * Several objects legitimately produce the same node. A namespace's `org`
 * label and ten other namespaces' labels all produce `org:acme`; a pod and
 * its Deployment both produce the same image node. If deleting any one of
 * them deleted the shared node, the graph would develop holes as ordinary
 * churn happened.
 *
 * So every node and edge is recorded against the source object that
 * contributed it, and removal withdraws only that source's contribution. A
 * node survives while anything still refers to it and disappears when the
 * last contributor goes. This is refcounting, and it is the part that makes
 * the difference between a graph that is live and one that rots.
 */

export interface Neighbour {
  node: GraphNode
  edge: GraphEdge
  /** 'out' when the edge points away from the node you asked about. */
  direction: 'out' | 'in'
}

export interface GraphStats {
  nodes: number
  edges: number
  byKind: Record<string, number>
  /** When the last change landed — how fresh an answer is. */
  updatedAt: string
  /** Sources that have completed their first list. */
  ready: string[]
}

const edgeKey = (e: GraphEdge) => `${e.from}|${e.kind}|${e.to}`

export class GraphIndex {
  /** Every node currently contributed by at least one source. */
  private nodes = new Map<string, GraphNode>()
  private edges = new Map<string, GraphEdge>()

  /** node id → the source keys that contributed it. */
  private nodeContributors = new Map<string, Set<string>>()
  private edgeContributors = new Map<string, Set<string>>()

  /** source key → what it contributed, so a withdrawal is exact. */
  private bySource = new Map<string, { nodes: string[]; edges: string[] }>()

  private lastChange = new Date().toISOString()
  private readySources = new Set<string>()

  /**
   * Record what one object contributes, replacing whatever it contributed
   * before. Idempotent: applying the same object twice is a no-op, which is
   * what makes a resync free.
   */
  apply(sourceKey: string, contribution: Contribution): void {
    const previous = this.bySource.get(sourceKey)
    const nextNodes = contribution.nodes.map((n) => n.id)
    const nextEdges = contribution.edges.map(edgeKey)

    // Withdraw first, so a node this object no longer contributes is released
    // before the new set is added — otherwise a workload that dropped an image
    // would keep it forever.
    if (previous) {
      for (const id of previous.nodes) {
        if (!nextNodes.includes(id)) this.releaseNode(sourceKey, id)
      }
      for (const key of previous.edges) {
        if (!nextEdges.includes(key)) this.releaseEdge(sourceKey, key)
      }
    }

    for (const node of contribution.nodes) {
      const existing = this.nodes.get(node.id)
      // A richer contribution wins: a pod and its Deployment both produce an
      // image node, and only one of them knows the digest. Merging rather
      // than overwriting stops the graph flickering between two descriptions
      // of the same thing depending on which watch fired last.
      this.nodes.set(node.id, existing ? mergeNodes(existing, node) : node)
      addTo(this.nodeContributors, node.id, sourceKey)
    }
    for (const edge of contribution.edges) {
      const key = edgeKey(edge)
      this.edges.set(key, edge)
      addTo(this.edgeContributors, key, sourceKey)
    }

    this.bySource.set(sourceKey, { nodes: nextNodes, edges: nextEdges })
    this.lastChange = new Date().toISOString()
  }

  /** Withdraw everything one object contributed. */
  remove(sourceKey: string): void {
    const previous = this.bySource.get(sourceKey)
    if (!previous) return
    for (const id of previous.nodes) this.releaseNode(sourceKey, id)
    for (const key of previous.edges) this.releaseEdge(sourceKey, key)
    this.bySource.delete(sourceKey)
    this.lastChange = new Date().toISOString()
  }

  /**
   * Drop every source under `prefix` that is not in `keep`.
   *
   * Called after a resync list: objects deleted while the watch was
   * disconnected produced no DELETED frame, and without this they would
   * linger in the graph indefinitely, which is the specific way a live graph
   * becomes a lying graph.
   */
  reconcile(prefix: string, keep: Set<string>): number {
    let dropped = 0
    for (const key of [...this.bySource.keys()]) {
      if (key.startsWith(prefix) && !keep.has(key)) {
        this.remove(key)
        dropped++
      }
    }
    return dropped
  }

  private releaseNode(sourceKey: string, id: string): void {
    const holders = this.nodeContributors.get(id)
    if (!holders) return
    holders.delete(sourceKey)
    if (holders.size === 0) {
      this.nodeContributors.delete(id)
      this.nodes.delete(id)
    }
  }

  private releaseEdge(sourceKey: string, key: string): void {
    const holders = this.edgeContributors.get(key)
    if (!holders) return
    holders.delete(sourceKey)
    if (holders.size === 0) {
      this.edgeContributors.delete(key)
      this.edges.delete(key)
    }
  }

  markReady(source: string): void {
    this.readySources.add(source)
  }

  /* ─────────── reads ─────────── */

  get(id: string): GraphNode | undefined {
    return this.nodes.get(id)
  }

  has(id: string): boolean {
    return this.nodes.has(id)
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()]
  }

  allEdges(): GraphEdge[] {
    return [...this.edges.values()]
  }

  stats(): GraphStats {
    const byKind: Record<string, number> = {}
    for (const n of this.nodes.values()) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      byKind,
      updatedAt: this.lastChange,
      ready: [...this.readySources].sort(),
    }
  }

  /**
   * One hop out from a node, in both directions.
   *
   * Bidirectional because edge direction encodes meaning, not navigability:
   * "what runs on this node" and "what node does this run on" are the same
   * edge asked from opposite ends, and an agent should not have to know which
   * way it was written.
   */
  neighbours(id: string, opts: { kinds?: NodeKind[]; limit?: number } = {}): Neighbour[] {
    const out: Neighbour[] = []
    const kinds = opts.kinds ? new Set(opts.kinds) : null
    for (const edge of this.edges.values()) {
      let otherId: string | null = null
      let direction: 'out' | 'in' = 'out'
      if (edge.from === id) {
        otherId = edge.to
        direction = 'out'
      } else if (edge.to === id) {
        otherId = edge.from
        direction = 'in'
      }
      if (!otherId) continue
      const node = this.nodes.get(otherId)
      if (!node) continue
      if (kinds && !kinds.has(node.kind)) continue
      out.push({ node, edge, direction })
    }
    return opts.limit ? out.slice(0, opts.limit) : out
  }

  /**
   * Breadth-first neighbourhood to `depth` hops.
   *
   * Bounded by `maxNodes` as well as depth, because depth alone does not
   * bound anything useful here: two hops from a namespace is most of the
   * cluster. The cap is what makes this safe to hand to a model.
   */
  subgraph(rootId: string, depth: number, maxNodes = 200): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const root = this.nodes.get(rootId)
    if (!root) return { nodes: [], edges: [], truncated: false }

    const keep = new Map<string, GraphNode>([[rootId, root]])
    let frontier = [rootId]
    let truncated = false

    for (let d = 0; d < depth && frontier.length && !truncated; d++) {
      const next: string[] = []
      for (const id of frontier) {
        for (const { node } of this.neighbours(id)) {
          if (keep.has(node.id)) continue
          if (keep.size >= maxNodes) {
            truncated = true
            break
          }
          keep.set(node.id, node)
          next.push(node.id)
        }
        if (truncated) break
      }
      frontier = next
    }

    const edges = this.allEdges().filter((e) => keep.has(e.from) && keep.has(e.to))
    return { nodes: [...keep.values()], edges, truncated }
  }

  /**
   * Shortest path between two nodes, as a list of nodes and the edges taken.
   *
   * This is the query that makes a graph worth building: "how is this pod
   * related to that Argo CD application" has an answer nobody can get from a
   * list API, and it is usually three hops that cross three different
   * subsystems.
   */
  path(fromId: string, toId: string, maxDepth = 6): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null
    if (fromId === toId) return { nodes: [this.nodes.get(fromId)!], edges: [] }

    const prev = new Map<string, { id: string; edge: GraphEdge }>()
    const seen = new Set([fromId])
    let frontier = [fromId]

    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = []
      for (const id of frontier) {
        for (const { node, edge } of this.neighbours(id)) {
          if (seen.has(node.id)) continue
          seen.add(node.id)
          prev.set(node.id, { id, edge })
          if (node.id === toId) {
            return this.rebuildPath(fromId, toId, prev)
          }
          next.push(node.id)
        }
      }
      frontier = next
    }
    return null
  }

  private rebuildPath(
    fromId: string,
    toId: string,
    prev: Map<string, { id: string; edge: GraphEdge }>,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    let cursor = toId
    while (cursor !== fromId) {
      nodes.unshift(this.nodes.get(cursor)!)
      const step = prev.get(cursor)!
      edges.unshift(step.edge)
      cursor = step.id
    }
    nodes.unshift(this.nodes.get(fromId)!)
    return { nodes, edges }
  }

  /**
   * Substring search over name, id and props.
   *
   * Ranked so an exact name match beats a props match — an agent searching
   * "checkout" wants the workload called checkout before every pod that
   * mentions it in an annotation.
   */
  search(query: string, opts: { kinds?: NodeKind[]; namespace?: string; limit?: number } = {}): GraphNode[] {
    const q = query.trim().toLowerCase()
    const kinds = opts.kinds ? new Set(opts.kinds) : null
    const scored: Array<{ node: GraphNode; score: number }> = []

    for (const node of this.nodes.values()) {
      if (kinds && !kinds.has(node.kind)) continue
      if (opts.namespace && node.namespace !== opts.namespace) continue
      if (!q) {
        scored.push({ node, score: 0 })
        continue
      }
      const name = node.name.toLowerCase()
      let score = -1
      if (name === q) score = 100
      else if (name.startsWith(q)) score = 80
      else if (name.includes(q)) score = 60
      else if (node.id.toLowerCase().includes(q)) score = 40
      else if (Object.values(node.props ?? {}).some((v) => String(v).toLowerCase().includes(q))) score = 20
      if (score >= 0) scored.push({ node, score })
    }

    scored.sort((a, b) =>
      b.score - a.score ||
      a.node.kind.localeCompare(b.node.kind) ||
      a.node.name.localeCompare(b.node.name)
    )
    return scored.slice(0, opts.limit ?? 50).map((s) => s.node)
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key)
  if (set) set.add(value)
  else map.set(key, new Set([value]))
}

/**
 * Merge two descriptions of the same node.
 *
 * Later wins per-field, but a field that the newer contribution does not have
 * is kept rather than erased — the pod knows the image digest, the Deployment
 * does not, and whichever watch fires last should not delete what the other
 * one learned.
 */
function mergeNodes(existing: GraphNode, incoming: GraphNode): GraphNode {
  return {
    ...existing,
    ...incoming,
    props: { ...(existing.props ?? {}), ...(incoming.props ?? {}) },
    // `unknown` is the absence of an opinion; never let it overwrite one.
    status: incoming.status && incoming.status !== 'unknown' ? incoming.status : existing.status,
  }
}
