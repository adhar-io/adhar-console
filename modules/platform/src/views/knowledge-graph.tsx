import { useEffect, useState } from 'react'
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
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import {
  ALL_KINDS,
  EDGE_PHRASE,
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
import { DepthSummary, GraphCanvas } from './graph-canvas.tsx'

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
  const [selected, setSelectedRaw] = useState<string | null>(null)
  // What the inspector shows: a click inspects without moving the graph.
  const [focused, setFocused] = useState<string | null>(null)
  // Where the graph has been centred, for a back trail.
  const [trail, setTrail] = useState<string[]>([])
  const setSelected = (id: string) => {
    setSelectedRaw((prev) => {
      if (prev && prev !== id) setTrail((t) => [...t.filter((x) => x !== prev), prev].slice(-8))
      return id
    })
    setFocused(null)
  }
  const back = () => {
    const prev = trail[trail.length - 1]
    if (!prev) return
    setTrail((t) => t.slice(0, -1))
    setSelectedRaw(prev)
    setFocused(null)
  }
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
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
              {trail.length ? (
                <button type="button" onClick={back} className="rounded-md px-2 py-0.5 text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content" title="Back to the previous centre">
                  ← Back
                </button>
              ) : null}
              <div className="ml-auto flex items-center gap-1">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Depth</span>
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
              <div className="flex h-[600px] items-center justify-center"><Spinner /></div>
            ) : neighbourhood.data ? (
              <>
                <GraphCanvas
                  root={neighbourhood.data.root}
                  nodes={neighbourhood.data.nodes}
                  edges={neighbourhood.data.edges}
                  truncated={neighbourhood.data.truncated}
                  focusedId={focused}
                  onFocus={setFocused}
                  onRecentre={setSelected}
                />
                <DepthSummary
                  root={neighbourhood.data.root}
                  nodes={neighbourhood.data.nodes}
                  edges={neighbourhood.data.edges}
                  onFocus={setFocused}
                />
              </>
            ) : (
              <div className="p-8"><EmptyState title="Could not load that neighbourhood" /></div>
            )}
          </CardBody>
        </Card>

        <Inspector id={focused ?? selected} centred={!focused || focused === selected} onSelect={setFocused} onCentre={setSelected} />
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

/* ─────────────────────────── inspector ─────────────────────────── */

const STATUS_KIND: Record<string, StatusKind> = {
  healthy: 'healthy',
  degraded: 'degraded',
  progressing: 'progressing',
  failed: 'failed',
  unknown: 'unknown',
}

function Inspector({ id, centred, onSelect, onCentre }: { id: string | null; centred: boolean; onSelect(id: string): void; onCentre(id: string): void }) {
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
        {!centred ? (
          <button type="button" onClick={() => onCentre(node.id)} className="mb-1 mt-1 rounded-md border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
            Centre the graph here
          </button>
        ) : null}
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
