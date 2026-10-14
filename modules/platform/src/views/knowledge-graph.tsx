import { useEffect, useRef, useState } from 'react'
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
  useToast,
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
import { DepthSummary, GraphCanvas, KIND_HEX } from './graph-canvas.tsx'
import { tallyHealth } from '../data/graph-lens.ts'

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
  // Target of the shortest-path trace from the centre (shift-click / inspector).
  const [traceTo, setTraceTo] = useState<string | null>(null)
  const [recents, setRecents] = useState<GraphNode[]>(readRecents)
  const setSelected = (id: string) => {
    setSelectedRaw((prev) => {
      if (prev && prev !== id) setTrail((t) => [...t.filter((x) => x !== prev), prev].slice(-8))
      return id
    })
    setFocused(null)
  }
  const remember = (n: GraphNode) =>
    setRecents((r) => {
      const next = [n, ...r.filter((x) => x.id !== n.id)].slice(0, RECENTS_MAX)
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      } catch {
        // private mode — recents just don't persist
      }
      return next
    })
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

  // Remember every node the graph has been centred on, for the finder's recents.
  useEffect(() => {
    if (detail.data?.node && detail.data.node.id === selected) remember(detail.data.node)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.node.id, selected])

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
      <Overview onCentre={setSelected} onKind={(k) => setKinds([k])} />

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
          recents={recents}
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
                  traceTo={traceTo}
                  onTraceTo={setTraceTo}
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

        <Inspector
          id={focused ?? selected}
          centred={!focused || focused === selected}
          onSelect={setFocused}
          onCentre={setSelected}
          onTrace={(id) => setTraceTo(id)}
          tracing={traceTo}
        />
      </div>
    </div>
  )
}

/* ─────────────────────────── overview ─────────────────────────── */

const RECENTS_KEY = 'adhar.platform.graph.recents'
const RECENTS_MAX = 8

function readRecents(): GraphNode[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(raw) ? (raw as GraphNode[]).slice(0, RECENTS_MAX) : []
  } catch {
    return []
  }
}

const HEALTH_HEX = { healthy: '#10b981', progressing: '#0ea5e9', degraded: '#f59e0b', failed: '#f43f5e' }

/** A ring of the health tally — healthy, progressing, degraded, failed — with the score inside. */
function HealthRing({ tally }: { tally: ReturnType<typeof tallyHealth> }) {
  const parts = (['healthy', 'progressing', 'degraded', 'failed'] as const).map((k) => [k, tally[k]] as const)
  const total = parts.reduce((a, [, n]) => a + n, 0)
  const R = 30
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="relative size-24 shrink-0">
      <svg viewBox="0 0 80 80" className="size-24 -rotate-90">
        <circle cx="40" cy="40" r={R} fill="none" stroke="var(--color-surface-sunken)" strokeWidth="9" />
        {total
          ? parts.map(([k, n]) => {
            const len = (n / total) * C
            const el = n ? (
              <circle key={k} cx="40" cy="40" r={R} fill="none" stroke={HEALTH_HEX[k]} strokeWidth="9" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
            ) : null
            offset += len
            return el
          })
          : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-lg font-semibold tabular-nums text-content">{tally.score == null ? '—' : `${tally.score}%`}</span>
        <span className="-mt-0.5 text-[9px] uppercase tracking-wide text-content-subtle">healthy</span>
      </div>
    </div>
  )
}

function Overview({ onCentre, onKind }: { onCentre(id: string): void; onKind(kind: NodeKind): void }) {
  const q = useGraphOverview()
  const status = useGraphStatus()
  const counts = q.data?.counts ?? {}
  const unhealthy = q.data?.unhealthy ?? []
  const stats = status.data?.stats

  const headline: NodeKind[] = ['application', 'workload', 'pod', 'service', 'image', 'node', 'namespace', 'volume']
  // The overview reports unhealthy nodes, not a full status census, so the
  // ring counts every pod/workload/application it knows as reporting and the
  // unhealthy list as the not-healthy share of them.
  const reporting = (counts.pod ?? 0) + (counts.workload ?? 0) + (counts.application ?? 0)
  const failed = unhealthy.filter((n) => n.status === 'failed').length
  const degraded = unhealthy.filter((n) => n.status === 'degraded').length
  const progressing = unhealthy.filter((n) => n.status === 'progressing').length
  const tally = reporting
    ? { healthy: Math.max(0, reporting - unhealthy.length), progressing, degraded, failed, unknown: 0, score: Math.floor((Math.max(0, reporting - unhealthy.length) / reporting) * 100) }
    : tallyHealth([])

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="relative overflow-hidden rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07] dark:opacity-[0.12]"
          style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, var(--color-brand-500) 1px, transparent 0)', backgroundSize: '18px 18px' }}
        />
        <div className="relative flex flex-wrap items-center gap-4">
          <HealthRing tally={tally} />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Platform graph</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-mono text-2xl font-semibold tabular-nums text-content">{stats?.nodes?.toLocaleString() ?? '—'}</span>
              <span className="text-[12px] text-content-muted">things</span>
              <span className="font-mono text-2xl font-semibold tabular-nums text-content">{stats?.edges?.toLocaleString() ?? '—'}</span>
              <span className="text-[12px] text-content-muted">relationships</span>
            </div>
            {q.data ? (
              <div className="mt-0.5 text-[11px] text-content-subtle">
                {q.data.namespaces.length} namespaces visible to you · updated {formatRelative(q.data.updatedAt)}
              </div>
            ) : null}
          </div>
        </div>
        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          {headline.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onKind(kind)}
              title={`Show only ${KIND_LABEL[kind].toLowerCase()}s in the finder`}
              className="group rounded-xl border border-edge-subtle bg-surface-raised/80 px-2.5 py-2 text-left transition-colors hover:border-edge-strong"
            >
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: KIND_HEX[kind] }} />
                <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-content-subtle group-hover:text-content-muted">{KIND_LABEL[kind]}</span>
              </div>
              <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-content">{counts[kind] ?? 0}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-col rounded-2xl border border-edge-default bg-surface-raised p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Needs attention</span>
          {unhealthy.length ? (
            <span className="rounded-full bg-rose-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{unhealthy.length}</span>
          ) : null}
        </div>
        {unhealthy.length === 0 ? (
          <div className="flex flex-1 items-center gap-2 py-3 text-[12px] text-content-muted">
            {q.isLoading ? 'Checking…' : (
              <>
                <span className="size-2 rounded-full bg-emerald-500" />
                Nothing in the graph is degraded or failing.
              </>
            )}
          </div>
        ) : (
          <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
            {unhealthy.slice(0, 20).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onCentre(n.id)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-sunken"
                  title="Centre the graph here"
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: HEALTH_HEX[(n.status as keyof typeof HEALTH_HEX) ?? 'degraded'] ?? '#f59e0b' }} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content">{n.name}</span>
                  <span className="shrink-0 text-[10px] text-content-subtle">{KIND_LABEL[n.kind]}{n.namespace ? ` · ${n.namespace}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
  recents,
}: {
  query: string
  onQuery(q: string): void
  kinds: NodeKind[]
  onKinds(k: NodeKind[]): void
  results: GraphNode[]
  loading: boolean
  selected: string | null
  onSelect(id: string): void
  recents: GraphNode[]
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  // "/" jumps to search from anywhere on the page that isn't already a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])
  const toggle = (kind: NodeKind) =>
    onKinds(kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind])

  return (
    <Card className="flex max-h-[620px] flex-col overflow-hidden">
      <CardHeader className="space-y-2">
        <div className="relative">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search everything…"
            aria-label="Search the graph"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-edge-default bg-surface-sunken px-1.5 font-mono text-[10px] text-content-subtle">/</kbd>
        </div>
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
        {!query && recents.length ? (
          <div className="border-b border-edge-subtle px-3 pb-2 pt-2.5">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Recent</div>
            <div className="flex flex-wrap gap-1">
              {recents.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                    selected === n.id ? 'border-brand-400 bg-brand-50 text-brand-800 dark:border-brand-500/50 dark:bg-brand-500/10 dark:text-brand-200' : 'border-edge-default text-content-muted hover:border-edge-strong hover:text-content',
                  )}
                >
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: KIND_HEX[n.kind] }} />
                  <span className="truncate">{n.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
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

function Inspector({
  id,
  centred,
  onSelect,
  onCentre,
  onTrace,
  tracing,
}: {
  id: string | null
  centred: boolean
  onSelect(id: string): void
  onCentre(id: string): void
  onTrace(id: string | null): void
  tracing: string | null
}) {
  const q = useGraphNode(id)
  const toast = useToast()

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
        <div className="mb-1 mt-1.5 flex flex-wrap gap-1.5">
          {!centred ? (
            <button type="button" onClick={() => onCentre(node.id)} className="rounded-md border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              Centre here
            </button>
          ) : null}
          {!centred ? (
            <button
              type="button"
              onClick={() => onTrace(tracing === node.id ? null : node.id)}
              aria-pressed={tracing === node.id}
              className={cn(
                'rounded-md border px-2 py-0.5 text-[11px] font-medium',
                tracing === node.id
                  ? 'border-brand-500 bg-brand-600 text-white'
                  : 'border-edge-default text-content-muted hover:border-edge-strong hover:text-content',
              )}
              title="Light the shortest path from the centre to this node (or shift-click it)"
            >
              {tracing === node.id ? 'Tracing path' : 'Trace path'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              navigator.clipboard?.writeText(node.namespace ? `${node.namespace}/${node.name}` : node.name).then(
                () => toast.success('Name copied'),
                () => toast.error('Clipboard is not available here'),
              )}
            className="rounded-md border border-edge-default px-2 py-0.5 text-[11px] font-medium text-content-muted hover:border-edge-strong hover:text-content"
          >
            Copy name
          </button>
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
