import { resolveIdentity } from '../k8s/gateway.ts'
import { graph, graphStatus } from './builder.ts'
import { canSee, filterGraph, setNamespaceOrgs, visibleNamespaces } from './access.ts'
import type { NodeKind } from './model.ts'

/**
 * `/api/graph/*` — the knowledge graph for the browser.
 *
 * Same index and the same access filter the AI tools use, so the page and the
 * agent can never disagree about what exists or about what this user is
 * allowed to know exists.
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function candidateNamespaces(): string[] {
  return graph.allNodes().filter((n) => n.kind === 'namespace').map((n) => n.name)
}

function syncOrgMap(): void {
  const map = new Map<string, string>()
  for (const n of graph.allNodes()) {
    if (n.kind === 'namespace' && typeof n.props?.org === 'string') map.set(n.name, n.props.org)
  }
  setNamespaceOrgs(map)
}

export async function handleGraph(req: Request, path: string): Promise<Response> {
  const identity = await resolveIdentity(req)
  if (!identity) return json(401, { error: 'unauthenticated' })

  const status = graphStatus()
  if (path === '/status' || path === '') {
    return json(200, { ...status, stats: status.running ? graph.stats() : null })
  }
  if (!status.running) {
    return json(503, { error: 'graph_unavailable', reason: status.reason ?? 'not running' })
  }

  syncOrgMap()
  const { namespaces: visible } = await visibleNamespaces(identity, candidateNamespaces())
  const url = new URL(req.url)

  if (path === '/search') {
    const kinds = url.searchParams.getAll('kind') as NodeKind[]
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
    const nodes = graph
      .search(url.searchParams.get('q') ?? '', {
        kinds: kinds.length ? kinds : undefined,
        namespace: url.searchParams.get('namespace') ?? undefined,
        limit: limit * 4,
      })
      .filter((n) => canSee(n, visible))
      .slice(0, limit)
    return json(200, { nodes, ready: status.ready })
  }

  if (path === '/node') {
    const id = url.searchParams.get('id') ?? ''
    const node = graph.get(id)
    // Absent and forbidden answer the same way: whether a node exists is
    // itself information about the cluster.
    if (!node || !canSee(node, visible)) return json(404, { error: 'not_found' })
    const related = graph
      .neighbours(id)
      .filter((n) => canSee(n.node, visible))
      .map((n) => ({ node: n.node, edge: n.edge, direction: n.direction }))
    return json(200, { node, related, ready: status.ready })
  }

  if (path === '/neighbourhood') {
    const id = url.searchParams.get('id') ?? ''
    const root = graph.get(id)
    if (!root || !canSee(root, visible)) return json(404, { error: 'not_found' })
    const depth = Math.min(Math.max(Number(url.searchParams.get('depth') ?? 2) || 2, 1), 3)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 120) || 120, 1), 400)
    return json(200, { ...filterGraph(graph.subgraph(id, depth, limit), visible), root, ready: status.ready })
  }

  if (path === '/path') {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const a = graph.get(from)
    const b = graph.get(to)
    if (!a || !b || !canSee(a, visible) || !canSee(b, visible)) return json(404, { error: 'not_found' })
    const p = graph.path(from, to)
    if (!p || !p.nodes.every((n) => canSee(n, visible))) return json(200, { related: false })
    return json(200, { related: true, ...p })
  }

  if (path === '/overview') {
    const nodes = graph.allNodes().filter((n) => canSee(n, visible))
    const byKind: Record<string, number> = {}
    for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1
    return json(200, {
      ready: status.ready,
      counts: byKind,
      namespaces: [...visible].sort(),
      unhealthy: nodes.filter((n) => n.status === 'failed' || n.status === 'degraded').slice(0, 100),
      updatedAt: graph.stats().updatedAt,
    })
  }

  return json(404, { error: 'unknown_graph_route', path })
}
