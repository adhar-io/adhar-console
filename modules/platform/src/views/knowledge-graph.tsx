import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Input,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import {
  ALL_KINDS,
  EDGE_PHRASE,
  type GraphEdge,
  type GraphNode,
  KIND_COLOR,
  KIND_LABEL,
  type NodeKind,
  useGraphNeighbourhood,
  useGraphNode,
  useGraphOverview,
  useGraphSearch,
  useGraphStatus,
} from '../data/graph.ts'

/**
 * Knowledge Graph — the platform and everything it runs, and how it all
 * connects.
 *
 * The page is organised around one question at a time: pick a thing, see what
 * it is connected to, walk. That is deliberately not a "show me the whole
 * cluster" picture — a hairball of two thousand nodes is a screensaver, not a
 * tool, and nobody has ever debugged anything with one.
 *
 * The layout is radial and deterministic rather than force-directed: the
 * selected node sits in the middle, its direct relations ring it grouped by
 * relationship, and the second hop forms an outer ring. Deterministic matters
 * more than pretty here — a graph that rearranges itself every render is one
 * you cannot point at during an incident.
 */
export function KnowledgeGraph({ namespace }: { namespace?: string }) {
  const status = useGraphStatus()
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<NodeKind[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  // Two hops by default: one hop shows a thing's immediate relations, which
  // for an application is four nodes on a mostly empty canvas. Two is where
  // the picture starts answering questions — app → workloads → pods/images.
  const [depth, setDepth] = useState(2)

  const search = useGraphSearch(query, kinds, namespace)
  const neighbourhood = useGraphNeighbourhood(selected, depth)
  const detail = useGraphNode(selected)

  const results = search.data?.nodes ?? []

  // Land on something real rather than an empty canvas: the first result is
  // almost always what someone typing meant.
  useEffect(() => {
    if (!selected && results.length) setSelected(results[0].id)
  }, [results, selected])

  if (status.isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }

  if (!status.data?.running) {
    return (
      <EmptyState
        title="The knowledge graph is not running"
        description={
          status.data?.reason === 'no ServiceAccount token'
            ? 'The console has no ServiceAccount token, so it cannot watch the cluster. Set K8S_SA_TOKEN, or run the console in-cluster.'
            : `The graph is unavailable: ${status.data?.reason ?? 'unknown reason'}.`
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <Overview />

      {!status.data.ready ? (
        <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-[12px] text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200">
          Still building the graph from the cluster — what you see may be incomplete.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[300px_1fr_320px]">
        <Finder
          query={query}
          onQuery={setQuery}
          kinds={kinds}
          onKinds={setKinds}
          results={results}
          loading={search.isLoading}
          selected={selected}
          onSelect={setSelected}
        />

        <Card className="overflow-hidden">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-content">
                {detail.data?.node.name ?? 'Select something'}
              </div>
              {detail.data ? <Badge>{KIND_LABEL[detail.data.node.kind]}</Badge> : null}
              <div className="ml-auto flex items-center gap-1">
                {[1, 2, 3].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDepth(d)}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-[11px] font-medium',
                      depth === d
                        ? 'bg-brand-600 text-white'
                        : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                    )}
                  >
                    {d} hop{d > 1 ? 's' : ''}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {!selected ? (
              <div className="p-8">
                <EmptyState
                  title="Nothing selected"
                  description="Search for a workload, application, pod or image on the left and the graph will centre on it."
                />
              </div>
            ) : neighbourhood.isLoading ? (
              <div className="flex h-[440px] items-center justify-center"><Spinner /></div>
            ) : neighbourhood.data ? (
              <RadialGraph
                root={neighbourhood.data.root}
                nodes={neighbourhood.data.nodes}
                edges={neighbourhood.data.edges}
                truncated={neighbourhood.data.truncated}
                onSelect={setSelected}
              />
            ) : (
              <div className="p-8"><EmptyState title="Could not load that neighbourhood" /></div>
            )}
          </CardBody>
        </Card>

        <Inspector id={selected} onSelect={setSelected} />
      </div>
    </div>
  )
}

/* ─────────────────────────── overview ─────────────────────────── */

function Overview() {
  const q = useGraphOverview()
  const counts = q.data?.counts ?? {}
  const unhealthy = q.data?.unhealthy ?? []

  const headline: NodeKind[] = ['application', 'workload', 'pod', 'service', 'image', 'node']

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {headline.map((kind) => (
            <div key={kind}>
              <div className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', KIND_COLOR[kind].dot)} />
                <span className="text-[11px] uppercase tracking-wide text-content-subtle">{KIND_LABEL[kind]}</span>
              </div>
              <div className="text-xl font-semibold tabular-nums text-content">{counts[kind] ?? 0}</div>
            </div>
          ))}
          {q.data ? (
            <div className="ml-auto text-[11px] text-content-subtle">
              {q.data.namespaces.length} namespaces visible · updated {formatRelative(q.data.updatedAt)}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="text-[11px] uppercase tracking-wide text-content-subtle">Unhealthy</div>
          {unhealthy.length === 0 ? (
            <div className="mt-1 text-[12px] text-content-muted">
              {q.isLoading ? 'Checking…' : 'Nothing in the graph is degraded or failing.'}
            </div>
          ) : (
            <div className="mt-1 space-y-0.5">
              <div className="text-xl font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                {unhealthy.length}
              </div>
              <div className="truncate text-[11px] text-content-subtle">
                {unhealthy.slice(0, 3).map((n) => n.name).join(', ')}
                {unhealthy.length > 3 ? ` +${unhealthy.length - 3} more` : ''}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

/* ─────────────────────────── finder ─────────────────────────── */

function Finder({
  query,
  onQuery,
  kinds,
  onKinds,
  results,
  loading,
  selected,
  onSelect,
}: {
  query: string
  onQuery(q: string): void
  kinds: NodeKind[]
  onKinds(k: NodeKind[]): void
  results: GraphNode[]
  loading: boolean
  selected: string | null
  onSelect(id: string): void
}) {
  const toggle = (kind: NodeKind) =>
    onKinds(kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind])

  return (
    <Card className="flex max-h-[620px] flex-col overflow-hidden">
      <CardHeader className="space-y-2">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search everything…"
        />
        <div className="flex flex-wrap gap-1">
          {ALL_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => toggle(kind)}
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium ring-1',
                kinds.includes(kind)
                  ? cn('bg-surface-sunken text-content', KIND_COLOR[kind].ring)
                  : 'text-content-subtle ring-edge-default hover:text-content',
              )}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardBody className="min-h-0 flex-1 overflow-y-auto p-0">
        {loading && !results.length ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : results.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-content-muted">
            Nothing matches “{query}”.
          </div>
        ) : (
          <ul>
            {results.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-sunken',
                    selected === n.id && 'bg-surface-sunken',
                  )}
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', KIND_COLOR[n.kind].dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-content">{n.name}</span>
                    <span className="block truncate text-[10px] text-content-subtle">
                      {KIND_LABEL[n.kind]}
                      {n.namespace ? ` · ${n.namespace}` : ''}
                    </span>
                  </span>
                  {n.status && n.status !== 'unknown' && n.status !== 'healthy' ? (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        n.status === 'failed' ? 'bg-rose-500' : n.status === 'degraded' ? 'bg-amber-500' : 'bg-sky-500',
                      )}
                    />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── the canvas ─────────────────────────── */

const WIDTH = 760
const HEIGHT = 460
const CX = WIDTH / 2
const CY = HEIGHT / 2

interface Placed {
  node: GraphNode
  x: number
  y: number
  ring: 0 | 1 | 2
}

/**
 * Radial layout: root centred, first hop on an inner ring, second hop outside.
 *
 * Deterministic by construction — positions come from the node's index within
 * its ring, which is sorted by kind then name. The same graph draws the same
 * way every time, which is what makes it possible to say "the red one on the
 * left" to a colleague.
 */
function layout(root: GraphNode, nodes: GraphNode[], edges: GraphEdge[]): Placed[] {
  const direct = new Set<string>()
  for (const e of edges) {
    if (e.from === root.id) direct.add(e.to)
    if (e.to === root.id) direct.add(e.from)
  }

  const inner = nodes.filter((n) => n.id !== root.id && direct.has(n.id))
  const outer = nodes.filter((n) => n.id !== root.id && !direct.has(n.id))
  const byKindName = (a: GraphNode, b: GraphNode) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
  inner.sort(byKindName)
  outer.sort(byKindName)

  const placed: Placed[] = [{ node: root, x: CX, y: CY, ring: 0 }]

  // Elliptical rather than circular: the canvas is wider than it is tall, and
  // a circle wastes the sides while crowding the top and bottom.
  const at = (angle: number, rx: number, ry: number) => ({
    x: CX + rx * Math.cos(angle),
    y: CY + ry * Math.sin(angle),
  })

  const innerAngle = new Map<string, number>()
  inner.forEach((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(inner.length, 1)
    innerAngle.set(node.id, angle)
    placed.push({ node, ...at(angle, 190, 130), ring: 1 })
  })

  // Second-hop nodes sit in an arc around the first-hop node they hang off,
  // rather than spread evenly around the whole ellipse. Spreading them evenly
  // is what produced a canvas full of long crossing lines: an image belonging
  // to the workload on the left would be placed on the right purely because
  // of its alphabetical position.
  const parentOf = (id: string): string | undefined => {
    for (const e of edges) {
      if (e.from === id && innerAngle.has(e.to)) return e.to
      if (e.to === id && innerAngle.has(e.from)) return e.from
    }
    return undefined
  }

  const groups = new Map<string, GraphNode[]>()
  const orphans: GraphNode[] = []
  for (const node of outer) {
    const parent = parentOf(node.id)
    if (!parent) {
      orphans.push(node)
      continue
    }
    const list = groups.get(parent)
    if (list) list.push(node)
    else groups.set(parent, [node])
  }

  // The arc each group may occupy, so neighbouring groups do not overlap.
  const slice = (2 * Math.PI) / Math.max(inner.length, 1)
  for (const [parent, children] of groups) {
    const base = innerAngle.get(parent)!
    const span = Math.min(slice * 0.8, (Math.PI / 6) * children.length)
    children.forEach((node, i) => {
      const t = children.length === 1 ? 0 : i / (children.length - 1) - 0.5
      placed.push({ node, ...at(base + t * span, 330, 205), ring: 2 })
    })
  }

  orphans.forEach((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(orphans.length, 1)
    placed.push({ node, ...at(angle, 345, 215), ring: 2 })
  })

  return placed
}

function RadialGraph({
  root,
  nodes,
  edges,
  truncated,
  onSelect,
}: {
  root: GraphNode
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
  onSelect(id: string): void
}) {
  const placed = useMemo(() => layout(root, nodes, edges), [root, nodes, edges])
  const at = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed])
  const [hover, setHover] = useState<string | null>(null)

  const touching = (id: string) =>
    hover === null || hover === id || edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id))

  return (
    <div className="relative">
      {/* A wide graph must scroll inside its own box, never the page. */}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-[460px] w-full min-w-[640px]"
          role="img"
          aria-label={`Relationships around ${root.name}`}
        >
          {edges.map((e) => {
            const a = at.get(e.from)
            const b = at.get(e.to)
            if (!a || !b) return null
            const lit = hover === null || hover === e.from || hover === e.to
            return (
              <g key={`${e.from}|${e.kind}|${e.to}`} opacity={lit ? 1 : 0.15}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="stroke-edge-strong"
                  strokeWidth={a.ring === 0 || b.ring === 0 ? 1.5 : 1}
                />
                {lit && hover !== null ? (
                  <text
                    x={(a.x + b.x) / 2}
                    y={(a.y + b.y) / 2 - 3}
                    textAnchor="middle"
                    className="fill-content-subtle text-[9px]"
                  >
                    {EDGE_PHRASE[e.kind]?.out ?? e.kind}
                  </text>
                ) : null}
              </g>
            )
          })}

          {placed.map((p) => {
            const dim = !touching(p.node.id)
            const r = p.ring === 0 ? 9 : p.ring === 1 ? 6 : 4.5
            return (
              <g
                key={p.node.id}
                transform={`translate(${p.x},${p.y})`}
                opacity={dim ? 0.25 : 1}
                onMouseEnter={() => setHover(p.node.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelect(p.node.id)}
                className="cursor-pointer"
              >
                <circle
                  r={r + 3}
                  className={cn(
                    'fill-surface-raised',
                    p.node.status === 'failed'
                      ? 'stroke-rose-500'
                      : p.node.status === 'degraded'
                      ? 'stroke-amber-500'
                      : p.node.status === 'progressing'
                      ? 'stroke-sky-500'
                      : 'stroke-transparent',
                  )}
                  strokeWidth={2}
                />
                {/* A literal class from the map — deriving one with
                    `.replace('bg-','fill-')` would produce a class Tailwind
                    never sees in source, and every node would render black. */}
                <circle r={r} className={KIND_COLOR[p.node.kind].fill} />
                {p.ring <= 1 || nodes.length < 40 ? (
                  <text
                    y={r + 12}
                    textAnchor="middle"
                    className={cn('fill-content text-[10px]', p.ring === 0 && 'font-semibold')}
                  >
                    {p.node.name.length > 22 ? `${p.node.name.slice(0, 21)}…` : p.node.name}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-edge-default px-3 py-1.5 text-[11px] text-content-subtle">
        <span>{nodes.length} nodes · {edges.length} relationships</span>
        {truncated ? (
          <span className="text-amber-700 dark:text-amber-400">
            capped — this is part of the neighbourhood, not all of it
          </span>
        ) : null}
        <span className="ml-auto">hover to trace · click to recentre</span>
      </div>
    </div>
  )
}

/* ─────────────────────────── inspector ─────────────────────────── */

const STATUS_KIND: Record<string, StatusKind> = {
  healthy: 'healthy',
  degraded: 'degraded',
  progressing: 'progressing',
  failed: 'failed',
  unknown: 'unknown',
}

function Inspector({ id, onSelect }: { id: string | null; onSelect(id: string): void }) {
  const q = useGraphNode(id)

  if (!id) return null
  if (q.isLoading) {
    return <Card><CardBody className="flex justify-center py-8"><Spinner /></CardBody></Card>
  }
  if (!q.data) {
    return <Card><CardBody className="text-[12px] text-content-muted">Nothing to show.</CardBody></Card>
  }

  const { node, related } = q.data

  // Grouped by how the relationship reads, so the panel is a sentence list
  // rather than an undifferentiated pile of links.
  const groups = new Map<string, typeof related>()
  for (const r of related) {
    const phrase = EDGE_PHRASE[r.edge.kind]?.[r.direction] ?? r.edge.kind
    const list = groups.get(phrase)
    if (list) list.push(r)
    else groups.set(phrase, [r])
  }

  return (
    <Card className="max-h-[620px] overflow-y-auto">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full', KIND_COLOR[node.kind].dot)} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-content">{node.name}</span>
          {node.status && node.status !== 'unknown' ? (
            <StatusBadge kind={STATUS_KIND[node.status] ?? 'unknown'}>{node.status}</StatusBadge>
          ) : null}
        </div>
        <div className="text-[11px] text-content-subtle">
          {KIND_LABEL[node.kind]}
          {node.namespace ? ` · ${node.namespace}` : ''}
          {node.gvk ? ` · ${node.gvk.group || 'core'}/${node.gvk.version}` : ''}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {node.props && Object.keys(node.props).length ? (
          <div className="space-y-0.5">
            {Object.entries(node.props).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[11px]">
                <span className="w-24 shrink-0 text-content-subtle">{k}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-content">{String(v)}</span>
              </div>
            ))}
          </div>
        ) : null}

        {[...groups.entries()].map(([phrase, list]) => (
          <div key={phrase}>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-content-subtle">{phrase}</div>
            <div className="space-y-0.5">
              {list.map((r) => (
                <button
                  key={`${r.edge.kind}|${r.node.id}`}
                  type="button"
                  onClick={() => onSelect(r.node.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-sunken"
                >
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', KIND_COLOR[r.node.kind].dot)} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content">{r.node.name}</span>
                  <span className="shrink-0 text-[10px] text-content-subtle">{KIND_LABEL[r.node.kind]}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        {related.length === 0 ? (
          <div className="text-[12px] text-content-muted">Nothing is connected to this yet.</div>
        ) : null}
      </CardBody>
    </Card>
  )
}
