import { useQuery } from '@tanstack/react-query'

/**
 * The platform knowledge graph, for the browser.
 *
 * Reads `/api/graph/*`, which serves the same server-side index Adhar AI
 * queries and applies the same access filter — so the page and the agent can
 * never disagree about what exists, or about what this user is allowed to
 * know exists.
 */

export type NodeKind =
  | 'cluster'
  | 'node'
  | 'namespace'
  | 'org'
  | 'workload'
  | 'pod'
  | 'container'
  | 'image'
  | 'service'
  | 'ingress'
  | 'route'
  | 'config'
  | 'secret'
  | 'volume'
  | 'application'
  | 'pipelinerun'
  | 'workflow'
  | 'repository'

export type EdgeKind =
  | 'contains'
  | 'owns'
  | 'runs-on'
  | 'uses-image'
  | 'selects'
  | 'routes-to'
  | 'mounts'
  | 'manages'
  | 'builds'
  | 'belongs-to'
  | 'sources-from'

export interface GraphNode {
  id: string
  kind: NodeKind
  name: string
  namespace?: string
  status?: 'healthy' | 'degraded' | 'progressing' | 'failed' | 'unknown'
  props?: Record<string, string | number | boolean>
  gvk?: { group: string; version: string; kind: string }
  updatedAt?: string
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
}

export interface Related {
  node: GraphNode
  edge: GraphEdge
  direction: 'out' | 'in'
}

export interface GraphStatusResponse {
  running: boolean
  ready: boolean
  reason?: string
  stats: {
    nodes: number
    edges: number
    byKind: Record<string, number>
    updatedAt: string
    ready: string[]
  } | null
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/graph${path}`, { credentials: 'include' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error((body as { error?: string }).error ?? `graph request failed (${res.status})`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  return await res.json() as T
}

export function useGraphStatus() {
  return useQuery({
    queryKey: ['graph', 'status'],
    queryFn: () => get<GraphStatusResponse>('/status'),
    // The graph changes as the cluster does; this drives the "updated Xs ago"
    // chip and the still-building banner.
    refetchInterval: 15_000,
    retry: false,
  })
}

export function useGraphSearch(query: string, kinds: NodeKind[], namespace?: string) {
  const params = new URLSearchParams({ q: query, limit: '80' })
  for (const k of kinds) params.append('kind', k)
  if (namespace) params.set('namespace', namespace)
  return useQuery({
    queryKey: ['graph', 'search', query, kinds.join(','), namespace ?? ''],
    queryFn: () => get<{ nodes: GraphNode[]; ready: boolean }>(`/search?${params}`),
    // Results stay usable while the next query runs, so the list does not
    // blank out on every keystroke.
    placeholderData: (prev) => prev,
    retry: false,
  })
}

export function useGraphNeighbourhood(id: string | null, depth: number) {
  return useQuery({
    queryKey: ['graph', 'neighbourhood', id, depth],
    queryFn: () =>
      get<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; root: GraphNode }>(
        `/neighbourhood?id=${encodeURIComponent(id!)}&depth=${depth}&limit=160`,
      ),
    enabled: Boolean(id),
    retry: false,
  })
}

export function useGraphNode(id: string | null) {
  return useQuery({
    queryKey: ['graph', 'node', id],
    queryFn: () => get<{ node: GraphNode; related: Related[] }>(`/node?id=${encodeURIComponent(id!)}`),
    enabled: Boolean(id),
    retry: false,
  })
}

export function useGraphOverview() {
  return useQuery({
    queryKey: ['graph', 'overview'],
    queryFn: () =>
      get<{
        ready: boolean
        counts: Record<string, number>
        namespaces: string[]
        unhealthy: GraphNode[]
        updatedAt: string
      }>('/overview'),
    refetchInterval: 30_000,
    retry: false,
  })
}

/* ─────────── presentation vocabulary ─────────── */

/**
 * Literal classes, never interpolated.
 *
 * Tailwind only emits what it can see in source: `bg-${kind}-500` produces
 * nothing and the node renders colourless. The kind vocabulary is closed, so
 * a static map is both correct and complete.
 *
 * Hues are chosen for the pairs that actually appear side by side. Namespace,
 * workload, pod and application are on screen together constantly, so they
 * must be unmistakable — workload was indigo, a near-twin of the brand blue
 * used for namespaces, and the two were indistinguishable at dot size.
 */
export const KIND_COLOR: Record<NodeKind, { dot: string; fill: string; ring: string; text: string }> = {
  cluster: { dot: 'bg-slate-500', fill: 'fill-slate-500', ring: 'ring-slate-400/40', text: 'text-slate-700 dark:text-slate-300' },
  node: { dot: 'bg-slate-500', fill: 'fill-slate-500', ring: 'ring-slate-400/40', text: 'text-slate-700 dark:text-slate-300' },
  namespace: { dot: 'bg-brand-500', fill: 'fill-brand-500', ring: 'ring-brand-400/40', text: 'text-brand-700 dark:text-brand-300' },
  org: { dot: 'bg-fuchsia-600', fill: 'fill-fuchsia-600', ring: 'ring-fuchsia-400/40', text: 'text-fuchsia-700 dark:text-fuchsia-300' },
  workload: { dot: 'bg-violet-600', fill: 'fill-violet-600', ring: 'ring-violet-400/40', text: 'text-violet-700 dark:text-violet-300' },
  pod: { dot: 'bg-sky-500', fill: 'fill-sky-500', ring: 'ring-sky-400/40', text: 'text-sky-700 dark:text-sky-300' },
  container: { dot: 'bg-sky-400', fill: 'fill-sky-400', ring: 'ring-sky-400/40', text: 'text-sky-700 dark:text-sky-300' },
  image: { dot: 'bg-amber-500', fill: 'fill-amber-500', ring: 'ring-amber-400/40', text: 'text-amber-700 dark:text-amber-300' },
  service: { dot: 'bg-teal-500', fill: 'fill-teal-500', ring: 'ring-teal-400/40', text: 'text-teal-700 dark:text-teal-300' },
  ingress: { dot: 'bg-cyan-500', fill: 'fill-cyan-500', ring: 'ring-cyan-400/40', text: 'text-cyan-700 dark:text-cyan-300' },
  route: { dot: 'bg-cyan-500', fill: 'fill-cyan-500', ring: 'ring-cyan-400/40', text: 'text-cyan-700 dark:text-cyan-300' },
  config: { dot: 'bg-stone-500', fill: 'fill-stone-500', ring: 'ring-stone-400/40', text: 'text-stone-700 dark:text-stone-300' },
  secret: { dot: 'bg-rose-500', fill: 'fill-rose-500', ring: 'ring-rose-400/40', text: 'text-rose-700 dark:text-rose-300' },
  volume: { dot: 'bg-lime-600', fill: 'fill-lime-600', ring: 'ring-lime-400/40', text: 'text-lime-700 dark:text-lime-300' },
  application: { dot: 'bg-emerald-500', fill: 'fill-emerald-500', ring: 'ring-emerald-400/40', text: 'text-emerald-700 dark:text-emerald-300' },
  pipelinerun: { dot: 'bg-pink-500', fill: 'fill-pink-500', ring: 'ring-pink-400/40', text: 'text-pink-700 dark:text-pink-300' },
  workflow: { dot: 'bg-pink-500', fill: 'fill-pink-500', ring: 'ring-pink-400/40', text: 'text-pink-700 dark:text-pink-300' },
  repository: { dot: 'bg-orange-500', fill: 'fill-orange-500', ring: 'ring-orange-400/40', text: 'text-orange-700 dark:text-orange-300' },
}

export const KIND_LABEL: Record<NodeKind, string> = {
  cluster: 'Cluster',
  node: 'Node',
  namespace: 'Namespace',
  org: 'Organisation',
  workload: 'Workload',
  pod: 'Pod',
  container: 'Container',
  image: 'Image',
  service: 'Service',
  ingress: 'Ingress',
  route: 'Route',
  config: 'ConfigMap',
  secret: 'Secret',
  volume: 'Volume',
  application: 'Argo CD App',
  pipelinerun: 'Pipeline run',
  workflow: 'Workflow',
  repository: 'Repository',
}

/** How an edge reads, from each end. */
export const EDGE_PHRASE: Record<EdgeKind, { out: string; in: string }> = {
  contains: { out: 'contains', in: 'in' },
  owns: { out: 'owns', in: 'owned by' },
  'runs-on': { out: 'runs on', in: 'hosts' },
  'uses-image': { out: 'uses image', in: 'used by' },
  selects: { out: 'selects', in: 'selected by' },
  'routes-to': { out: 'routes to', in: 'routed to by' },
  mounts: { out: 'mounts', in: 'mounted by' },
  manages: { out: 'manages', in: 'managed by' },
  builds: { out: 'builds', in: 'built by' },
  'belongs-to': { out: 'belongs to', in: 'owns' },
  'sources-from': { out: 'sources from', in: 'source of' },
}

export const STATUS_STROKE: Record<string, string> = {
  healthy: 'stroke-emerald-500',
  degraded: 'stroke-amber-500',
  progressing: 'stroke-sky-500',
  failed: 'stroke-rose-500',
  unknown: 'stroke-slate-400',
}

/** Every kind, in the order the filter chips should appear. */
export const ALL_KINDS: NodeKind[] = [
  'application',
  'workload',
  'pod',
  'service',
  'ingress',
  'namespace',
  'node',
  'image',
  'repository',
  'org',
  'config',
  'secret',
  'volume',
  'pipelinerun',
]
