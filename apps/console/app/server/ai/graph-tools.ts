import type { K8sIdentity } from '../k8s/gateway.ts'
import type { ToolDef } from './provider.ts'
import { graph, graphStatus } from '../graph/builder.ts'
import { canSee, filterGraph, setNamespaceOrgs, visibleNamespaces } from '../graph/access.ts'
import type { GraphNode, NodeKind } from '../graph/model.ts'

/**
 * The knowledge-graph tools — how Adhar AI gets depth without drowning.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE EXIST WHEN THERE ARE ALREADY LIST TOOLS
 * ---------------------------------------------------------------------------
 * `k8s_list` can fetch anything, and that is precisely the problem: to answer
 * "why is checkout degraded" from lists, the model must fetch pods, guess
 * which of 400 matter, fetch their workloads, fetch the Argo CD applications,
 * and correlate by naming convention — spending most of its context on
 * material it will discard, and inferring relationships that are sometimes
 * wrong.
 *
 * The graph already holds those relationships, computed once from what the
 * objects actually say. `graph_node` answers in a few hundred tokens what
 * costs several thousand and a guess otherwise, and `graph_path` answers a
 * question — "how are these two things related" — that list tools cannot
 * answer at all.
 *
 * ---------------------------------------------------------------------------
 * ACCESS
 * ---------------------------------------------------------------------------
 * The index is built by the console's ServiceAccount and sees the whole
 * cluster. Every tool here filters to what the ASKING USER may see, checked
 * against the apiserver (see graph/access.ts). The agents promise reads never
 * exceed the signed-in user's RBAC, and that promise has to survive the
 * introduction of a cache.
 */

export const GRAPH_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'graph_search',
      description:
        'Find things on the platform by name across every kind at once — workloads, pods, services, namespaces, Argo CD applications, images, nodes. Start here when the user names something without saying what kind of thing it is.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or fragment. Empty lists everything of the given kinds.' },
          kinds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Restrict to these node kinds: cluster, node, namespace, org, workload, pod, container, image, service, ingress, config, secret, volume, application, pipelinerun, workflow, repository',
          },
          namespace: { type: 'string' },
          limit: { type: 'number', description: 'Default 25, cap 100' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_node',
      description:
        'Get one node with everything directly connected to it — its workload, pods, node, images, services, the Argo CD application that manages it. This is the fastest way to understand one thing in context; prefer it over several k8s_get calls.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id from graph_search, e.g. `workload:payments/api`' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_neighbourhood',
      description:
        'Walk out from a node several hops — the blast radius of a thing. Use depth 2 to see what a namespace or application really contains. Results are capped; the reply says when it truncated.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          depth: { type: 'number', description: 'Hops, 1-3. Default 2.' },
          limit: { type: 'number', description: 'Max nodes, default 60, cap 200' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_path',
      description:
        'Explain how two things on the platform are related, as the shortest chain of relationships between them. Answers questions no list API can — "is this pod part of that application", "what connects this image to that ingress".',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Node id' },
          to: { type: 'string', description: 'Node id' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_overview',
      description:
        'The shape of the platform in one call: how many of each kind of thing exist, and everything currently unhealthy with what it belongs to. Use this first for "what is wrong right now" rather than scanning events.',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'Restrict to one namespace' },
        },
      },
    },
  },
]

export const GRAPH_TOOL_NAMES: string[] = GRAPH_TOOL_DEFS.map((d) => d.function.name)

/* ─────────────────────────── rendering ─────────────────────────── */

/**
 * A node as the model should see it.
 *
 * Compact on purpose: the whole point is that a neighbourhood fits in a few
 * hundred tokens. Anything needing the full object should call `k8s_get`, and
 * `gvk` is included so it can.
 */
function render(n: GraphNode) {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    ...(n.namespace ? { namespace: n.namespace } : {}),
    ...(n.status && n.status !== 'unknown' ? { status: n.status } : {}),
    ...(n.props && Object.keys(n.props).length ? { props: n.props } : {}),
    ...(n.gvk ? { gvk: `${n.gvk.group || 'core'}/${n.gvk.version} ${n.gvk.kind}` } : {}),
  }
}

/** Phrase an edge the way a person would read it. */
function phrase(kind: string, direction: 'out' | 'in'): string {
  const out: Record<string, string> = {
    contains: 'contains',
    owns: 'owns',
    'runs-on': 'runs on',
    'uses-image': 'uses image',
    selects: 'selects',
    'routes-to': 'routes to',
    mounts: 'mounts',
    manages: 'manages',
    builds: 'builds',
    'belongs-to': 'belongs to',
    'sources-from': 'sources from',
  }
  const inbound: Record<string, string> = {
    contains: 'is contained by',
    owns: 'is owned by',
    'runs-on': 'hosts',
    'uses-image': 'is used by',
    selects: 'is selected by',
    'routes-to': 'is routed to by',
    mounts: 'is mounted by',
    manages: 'is managed by',
    builds: 'is built by',
    'belongs-to': 'owns namespace',
    'sources-from': 'is the source of',
  }
  return (direction === 'out' ? out : inbound)[kind] ?? kind
}

/** Namespaces the graph knows about, as SSAR candidates. */
function candidateNamespaces(): string[] {
  return graph.allNodes().filter((n) => n.kind === 'namespace').map((n) => n.name)
}

/** Keep the access layer's namespace→org map current for org visibility. */
function syncOrgMap(): void {
  const map = new Map<string, string>()
  for (const n of graph.allNodes()) {
    if (n.kind === 'namespace' && typeof n.props?.org === 'string') map.set(n.name, n.props.org)
  }
  setNamespaceOrgs(map)
}

const notReady = () =>
  JSON.stringify({
    error: 'The platform knowledge graph is not available.',
    reason: graphStatus().reason ?? 'still building',
    hint: 'Fall back to the k8s_* tools for this question.',
  })

/* ─────────────────────────── execution ─────────────────────────── */

/**
 * Run one graph tool. Returns null for anything it does not own, so the
 * caller can fall through without a second dispatch table.
 */
export async function executeGraphTool(
  name: string,
  args: Record<string, unknown>,
  identity: K8sIdentity | string,
): Promise<string | null> {
  if (!GRAPH_TOOL_NAMES.includes(name)) return null

  const status = graphStatus()
  if (!status.running) return notReady()

  syncOrgMap()
  const { namespaces: visible } = await visibleNamespaces(identity, candidateNamespaces())
  if (visible.size === 0) {
    return JSON.stringify({
      error: 'You do not have access to any namespace on this cluster, so the graph is empty for you.',
    })
  }

  // A graph that is still priming can answer, but an answer from a partial
  // index reads as authoritative unless it says otherwise.
  const partial = status.ready ? {} : { partial: true, note: 'The graph is still loading; this view may be incomplete.' }

  switch (name) {
    case 'graph_search': {
      const limit = Math.min(Math.max(Number(args.limit ?? 25) || 25, 1), 100)
      const kinds = Array.isArray(args.kinds) ? (args.kinds as NodeKind[]) : undefined
      const hits = graph
        .search(String(args.query ?? ''), {
          kinds,
          namespace: args.namespace ? String(args.namespace) : undefined,
          // Over-fetch so the access filter cannot leave a short page.
          limit: limit * 4,
        })
        .filter((n) => canSee(n, visible))
        .slice(0, limit)
      return JSON.stringify({ ...partial, count: hits.length, nodes: hits.map(render) })
    }

    case 'graph_node': {
      const id = String(args.id ?? '')
      const node = graph.get(id)
      if (!node) return JSON.stringify({ error: `No node ${id}. Use graph_search to find the right id.` })
      // 404 rather than 403: whether a node exists is itself information.
      if (!canSee(node, visible)) {
        return JSON.stringify({ error: `No node ${id}. Use graph_search to find the right id.` })
      }
      const neighbours = graph
        .neighbours(id)
        .filter((n) => canSee(n.node, visible))
        .map((n) => ({ relation: phrase(n.edge.kind, n.direction), ...render(n.node) }))
      return JSON.stringify({ ...partial, node: render(node), related: neighbours })
    }

    case 'graph_neighbourhood': {
      const id = String(args.id ?? '')
      const root = graph.get(id)
      if (!root || !canSee(root, visible)) {
        return JSON.stringify({ error: `No node ${id}. Use graph_search to find the right id.` })
      }
      const depth = Math.min(Math.max(Number(args.depth ?? 2) || 2, 1), 3)
      const limit = Math.min(Math.max(Number(args.limit ?? 60) || 60, 1), 200)
      const sub = filterGraph(graph.subgraph(id, depth, limit), visible)
      return JSON.stringify({
        ...partial,
        root: render(root),
        depth,
        truncated: sub.truncated,
        ...(sub.truncated
          ? { warning: `Stopped at ${limit} nodes — this is part of the neighbourhood, not all of it.` }
          : {}),
        nodes: sub.nodes.map(render),
        relationships: sub.edges.map((e) => `${e.from} ${phrase(e.kind, 'out')} ${e.to}`),
      })
    }

    case 'graph_path': {
      const from = String(args.from ?? '')
      const to = String(args.to ?? '')
      const a = graph.get(from)
      const b = graph.get(to)
      if (!a || !canSee(a, visible)) return JSON.stringify({ error: `No node ${from}.` })
      if (!b || !canSee(b, visible)) return JSON.stringify({ error: `No node ${to}.` })
      const p = graph.path(from, to)
      if (!p) {
        return JSON.stringify({
          ...partial,
          related: false,
          explanation: `Nothing in the graph connects ${from} to ${to} within 6 hops. They are not related through anything the platform records.`,
        })
      }
      // A path crossing a node the user cannot see would leak it by name.
      if (!p.nodes.every((n) => canSee(n, visible))) {
        return JSON.stringify({ ...partial, related: false, explanation: 'The connection between these runs through something you do not have access to.' })
      }
      const steps = p.edges.map((e, i) => `${p.nodes[i].name} ${phrase(e.kind, 'out')} ${p.nodes[i + 1].name}`)
      return JSON.stringify({ ...partial, related: true, hops: p.edges.length, steps, nodes: p.nodes.map(render) })
    }

    case 'graph_overview': {
      const ns = args.namespace ? String(args.namespace) : undefined
      if (ns && !visible.has(ns)) return JSON.stringify({ error: `No namespace ${ns}.` })

      const all = graph.allNodes().filter((n) => canSee(n, visible) && (!ns || n.namespace === ns || n.name === ns))
      const byKind: Record<string, number> = {}
      for (const n of all) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1

      // Unhealthy things WITH their context — the point of asking a graph
      // rather than a list is that "api is failing" arrives already attached
      // to the application that owns it.
      const unhealthy = all
        .filter((n) => n.status === 'failed' || n.status === 'degraded')
        .slice(0, 40)
        .map((n) => ({
          ...render(n),
          partOf: graph
            .neighbours(n.id, { kinds: ['workload', 'application', 'namespace'] })
            .filter((x) => canSee(x.node, visible))
            .map((x) => x.node.id)
            .slice(0, 4),
        }))

      return JSON.stringify({
        ...partial,
        ...(ns ? { namespace: ns } : { namespaces: [...visible].length }),
        counts: byKind,
        unhealthyCount: all.filter((n) => n.status === 'failed' || n.status === 'degraded').length,
        unhealthy,
        freshness: graph.stats().updatedAt,
      })
    }

    default:
      return JSON.stringify({ error: `unknown graph tool ${name}` })
  }
}
