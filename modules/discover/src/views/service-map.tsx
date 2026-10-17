import { useEffect, useMemo, useState } from 'react'
import { Card } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type Health, lokiSelector } from '../data/golden-signals.ts'
import {
  buildGraph,
  edgeWidth,
  filterGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
  GRAPH_SOURCES,
  layoutGraph,
  NODE_H,
  NODE_W,
  nodeHealth,
  nodeQueries,
} from '../data/service-graph.ts'
import { useInstantSet, useMetricNames, useRangeSet } from '../data/prom.ts'
import { discoverHref, readParams, replaceParams } from '../data/discover-links.ts'
import { formatValue } from '../data/promql-lite.ts'
import {
  DLink,
  HealthTag,
  healthStroke,
  Loading,
  MiniSelect,
  NoData,
  QueryError,
  Segmented,
  seriesColor,
  SignalChart,
  VizStyle,
  Widget,
} from './viz.tsx'

/**
 * Service map — a live graph built from real edge metrics (Tempo service
 * graphs, Istio, or Cilium Hubble with source/destination context), laid out
 * in left-to-right layers so callers sit before callees.
 *
 * Nodes show served requests/s, 5xx % and p95; health is shape + colour + the
 * word (in tooltips, the list and the panel) — never colour alone. Click a node
 * for its RED panel with callers/callees and links into Logs, Traces and
 * Metrics. Search, namespace and "errors only" filters keep the 1-hop
 * neighbourhood of matches so edges stay meaningful.
 *
 * URL: `?section=servicemap&focus=<id>&ns=<ns>&win=5m&src=<source>`.
 */

const WINDOWS = [
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '1h', label: '1h' },
] as const
type Win = (typeof WINDOWS)[number]['id']

export function ServiceMap() {
  const boot = useMemo(readParams, [])
  const [win, setWin] = useState<Win>(WINDOWS.some((w) => w.id === boot.win) ? (boot.win as Win) : '5m')
  const [ns, setNs] = useState(boot.ns ?? '')
  const [search, setSearch] = useState(boot.q ?? '')
  const [errorsOnly, setErrorsOnly] = useState(boot.errors === '1')
  const [focus, setFocus] = useState<string | null>(boot.focus ?? null)
  const [srcId, setSrcId] = useState(boot.src ?? '')
  const [zoom, setZoom] = useState<'fit' | '100'>('fit')

  useEffect(() => {
    replaceParams({ win: win === '5m' ? null : win, ns, q: search, errors: errorsOnly ? '1' : null, focus, src: srcId })
  }, [win, ns, search, errorsOnly, focus, srcId])

  const names = useMetricNames()
  const available = useMemo(() => GRAPH_SOURCES.filter((s) => names.data?.includes(s.probe)), [names.data])
  const src = available.find((s) => s.id === srcId) ?? available[0] ?? null
  const queries = src ? src.queries(win) : { rps: null, err: null, p95: null }
  const q = useInstantSet({ rps: queries.rps, err: queries.err, p95: queries.p95 }, { refreshMs: 30_000 })

  const graph: Graph = useMemo(
    () => (src ? buildGraph(src, q.rps.data ?? [], q.err.data ?? [], q.p95.data ?? []) : { nodes: [], edges: [] }),
    [src, q.rps.data, q.err.data, q.p95.data],
  )
  const namespaces = useMemo(() => [...new Set(graph.nodes.map((n) => n.namespace).filter(Boolean) as string[])].sort(), [graph])
  const shown = useMemo(() => filterGraph(graph, { search, namespace: ns || null, errorsOnly }), [graph, search, ns, errorsOnly])
  const layout = useMemo(() => layoutGraph(shown), [shown])
  const selected = graph.nodes.find((n) => n.id === focus) ?? null

  if (names.isLoading) return <Loading height={240} />
  if (names.isError) return <Card className="p-4"><QueryError error={names.error} /></Card>
  if (!src) {
    return (
      <Card className="p-4">
        <NoData
          title="No service-graph metrics are scraped"
          height={220}
          hint={
            <span>
              The map is drawn from caller → callee request metrics. Prometheus has none of:{' '}
              {GRAPH_SOURCES.map((s) => (
                <span key={s.id} className="block">
                  <span className="font-mono text-content">{s.probe}</span> — {s.hint}
                </span>
              ))}
            </span>
          }
        />
      </Card>
    )
  }

  const neighbours = new Set<string>()
  if (focus) {
    for (const e of shown.edges) {
      if (e.from === focus) neighbours.add(e.to)
      if (e.to === focus) neighbours.add(e.from)
    }
  }
  const dim = (id: string) => !!focus && id !== focus && !neighbours.has(id)
  const labelEdges = shown.edges.length <= 16 || !!focus

  return (
    <div className="space-y-3">
      <VizStyle />
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
        <Segmented value={win} onChange={setWin} ariaLabel="Rate window" options={WINDOWS.map((w) => ({ id: w.id, label: w.label, title: `rate over the last ${w.label}` }))} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a service…"
          aria-label="Search services"
          className="h-7 w-44 min-w-0 rounded-md border border-edge-default bg-surface-raised px-2 text-[11px] text-content focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        {namespaces.length ? (
          <MiniSelect ariaLabel="Namespace" value={ns} onChange={setNs} options={[{ value: '', label: 'All namespaces' }, ...namespaces.map((n) => ({ value: n, label: n }))]} />
        ) : null}
        <label className="inline-flex items-center gap-1.5 text-[11px] text-content-muted">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} className="accent-brand-600" />
          Errors ≥ 1% only
        </label>
        {available.length > 1 ? (
          <MiniSelect ariaLabel="Graph source" value={src.id} onChange={setSrcId} options={available.map((s) => ({ value: s.id, label: s.label }))} />
        ) : null}
        <span className="ml-auto text-[11px] text-content-subtle">
          {src.label} · {shown.nodes.length}/{graph.nodes.length} services · {shown.edges.length} edges
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0 self-start overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-edge-subtle px-4 py-2">
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-content-muted">
              <HealthTag health="ok" label="< 1% 5xx" />
              <HealthTag health="warn" label="1–5%" />
              <HealthTag health="crit" label="≥ 5%" />
              <HealthTag health="none" label="client only" />
              <span className="text-content-subtle">edge width ∝ log(req/s)</span>
            </div>
            <Segmented value={zoom} onChange={setZoom} ariaLabel="Zoom" options={[{ id: 'fit', label: 'Fit' }, { id: '100', label: '100%' }]} />
          </div>
          {q.rps.isLoading ? <Loading height={320} /> : q.rps.isError ? <div className="p-4"><QueryError error={q.rps.error} /></div> : graph.nodes.length === 0 ? (
            <div className="p-4">
              <NoData
                height={260}
                title="No traffic between services in this window"
                hint={`${src.label} is scraped but reported no caller → callee requests over the last ${win}.${src.id === 'hubble' ? ' Hubble needs source_* and destination_* labelsContext on its httpV2 metric to attribute both ends.' : ''}`}
              />
            </div>
          ) : shown.nodes.length === 0 ? (
            <div className="p-4"><NoData height={200} title="No services match the filters" /></div>
          ) : (
            <div className={cn('overflow-auto bg-surface-sunken/30', zoom === 'fit' ? 'max-h-[70vh]' : 'max-h-[75vh]')}>
              <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                width={zoom === 'fit' ? '100%' : layout.width}
                height={zoom === 'fit' ? undefined : layout.height}
                style={zoom === 'fit' ? { maxHeight: '70vh', minHeight: 240 } : undefined}
                role="img"
                aria-label={`Service map: ${shown.nodes.length} services, ${shown.edges.length} edges`}
                className="block"
                onClick={() => setFocus(null)}
              >
                <defs>
                  <marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 Z" fill="var(--color-content-subtle)" />
                  </marker>
                </defs>
                {shown.edges.map((e) => (
                  <EdgePath key={e.id} edge={e} layout={layout} dimmed={!!focus && e.from !== focus && e.to !== focus} label={labelEdges} />
                ))}
                {shown.nodes.map((n) => {
                  const p = layout.pos.get(n.id)
                  if (!p) return null
                  return (
                    <NodeBox
                      key={n.id}
                      node={n}
                      x={p.x}
                      y={p.y}
                      active={focus === n.id}
                      dimmed={dim(n.id)}
                      onPick={() => setFocus(focus === n.id ? null : n.id)}
                    />
                  )
                })}
              </svg>
            </div>
          )}
        </Card>

        {selected ? (
          <NodePanel node={selected} graph={graph} src={src} win={win} onClose={() => setFocus(null)} onPick={setFocus} />
        ) : (
          <NodeList nodes={shown.nodes} onPick={setFocus} />
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────── graph marks ─────────────────────────── */

function EdgePath({ edge, layout, dimmed, label }: { edge: GraphEdge; layout: ReturnType<typeof layoutGraph>; dimmed: boolean; label: boolean }) {
  const a = layout.pos.get(edge.from)
  const b = layout.pos.get(edge.to)
  if (!a || !b) return null
  const h = nodeHealth({ errorPct: edge.errorPct })
  const bad = h === 'warn' || h === 'crit'
  let d: string
  let mx: number
  let my: number
  if (b.layer > a.layer) {
    const sx = a.x + NODE_W
    const sy = a.y + NODE_H / 2
    const ex = b.x - 2
    const ey = b.y + NODE_H / 2
    const c = Math.max(40, (ex - sx) / 2)
    d = `M${sx},${sy} C${sx + c},${sy} ${ex - c},${ey} ${ex},${ey}`
    mx = (sx + ex) / 2
    my = (sy + ey) / 2
  } else {
    // Back edge or same layer: loop underneath, entering the callee from below.
    const sx = a.x + NODE_W / 2
    const sy = a.y + NODE_H
    const ex = b.x + NODE_W / 2
    const ey = b.y + NODE_H + 2
    const dip = Math.max(sy, ey) + 36
    d = `M${sx},${sy} C${sx},${dip} ${ex},${dip} ${ex},${ey}`
    mx = (sx + ex) / 2
    my = dip - 9
  }
  const text = `${formatValue(edge.rps, 'rps')}${edge.errorPct != null && edge.errorPct > 0 ? ` · ${formatValue(edge.errorPct, 'percent')}` : ''}${edge.p95Ms != null ? ` · ${formatValue(edge.p95Ms, 'ms')}` : ''}`
  return (
    <g opacity={dimmed ? 0.15 : 1}>
      <title>{`${edge.from} → ${edge.to}: ${text}${bad ? ` (${h === 'crit' ? 'critical' : 'warning'})` : ''}`}</title>
      <path
        d={d}
        fill="none"
        stroke={bad ? healthStroke(h) : 'var(--color-content-subtle)'}
        strokeOpacity={bad ? 0.9 : 0.55}
        strokeWidth={edgeWidth(edge.rps)}
        strokeDasharray={h === 'crit' ? '6 3' : undefined}
        markerEnd="url(#sm-arrow)"
      />
      {label ? (
        <g transform={`translate(${mx},${my})`}>
          <rect x={-text.length * 2.6 - 6} y={-8} width={text.length * 5.2 + 12} height={16} rx={8} fill="var(--color-surface-raised)" stroke="var(--color-edge-default)" />
          <text y={3.5} textAnchor="middle" fontSize="9.5" fontFamily="var(--font-mono)" fill="var(--color-content-muted)">{text}</text>
        </g>
      ) : null}
    </g>
  )
}

function HealthGlyph({ h, x, y }: { h: Health; x: number; y: number }) {
  const stroke = healthStroke(h)
  return (
    <g transform={`translate(${x},${y})`} fill="none" stroke={stroke} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {h === 'ok' ? <><circle r={6} /><path d="M-2.8,0 L-0.6,2.3 L3,-2.4" /></> : null}
      {h === 'warn' ? <><path d="M0,-6.5 L6.5,5.5 L-6.5,5.5 Z" /><path d="M0,-2 L0,1.6" /></> : null}
      {h === 'crit' ? <><path d="M-2.8,-6.5 L2.8,-6.5 L6.5,-2.8 L6.5,2.8 L2.8,6.5 L-2.8,6.5 L-6.5,2.8 L-6.5,-2.8 Z" /><path d="M-2.4,-2.4 L2.4,2.4 M2.4,-2.4 L-2.4,2.4" /></> : null}
      {h === 'none' ? <><circle r={6} strokeDasharray="2.5 2.5" /><path d="M-2.8,0 L2.8,0" /></> : null}
    </g>
  )
}

const HEALTH_WORD: Record<Health, string> = { ok: 'Healthy', warn: 'Warning', crit: 'Critical', none: 'Client only' }

function NodeBox({ node, x, y, active, dimmed, onPick }: { node: GraphNode; x: number; y: number; active: boolean; dimmed: boolean; onPick(): void }) {
  const h = nodeHealth(node)
  const name = node.name.length > 20 ? `${node.name.slice(0, 19)}…` : node.name
  const stats = node.clientOnly
    ? `${formatValue(node.rps, 'rps')} out`
    : `${formatValue(node.rps, 'rps')} · ${formatValue(node.errorPct, 'percent')}${node.p95Ms != null ? ` · ${formatValue(node.p95Ms, 'ms')}` : ''}`
  return (
    <g
      transform={`translate(${x},${y})`}
      opacity={dimmed ? 0.3 : 1}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      aria-label={`${node.name}${node.namespace ? ` in ${node.namespace}` : ''}: ${HEALTH_WORD[h]}, ${stats}`}
      onClick={(e) => {
        e.stopPropagation()
        onPick()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
    >
      <title>{`${node.namespace ? `${node.namespace}/` : ''}${node.name} — ${HEALTH_WORD[h]}\n${stats}`}</title>
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={8}
        fill="var(--color-surface-raised)"
        stroke={active ? 'var(--color-brand-500)' : healthStroke(h)}
        strokeWidth={active ? 2.5 : h === 'ok' || h === 'none' ? 1 : 1.75}
      />
      <HealthGlyph h={h} x={16} y={NODE_H / 2} />
      <text x={30} y={20} fontSize="11.5" fontWeight={600} fill="var(--color-content)">{name}</text>
      <text x={30} y={36} fontSize="9.5" fontFamily="var(--font-mono)" fill="var(--color-content-muted)">{stats}</text>
      {node.namespace ? <text x={NODE_W - 6} y={11} fontSize="8" textAnchor="end" fill="var(--color-content-subtle)">{node.namespace.length > 16 ? `${node.namespace.slice(0, 15)}…` : node.namespace}</text> : null}
    </g>
  )
}

/* ─────────────────────────── side panels ─────────────────────────── */

function NodeList({ nodes, onPick }: { nodes: GraphNode[]; onPick(id: string): void }) {
  const [sort, setSort] = useState<'traffic' | 'errors' | 'latency'>('errors')
  const key = (n: GraphNode) => (sort === 'traffic' ? n.rps : sort === 'errors' ? n.errorPct : n.p95Ms) ?? -1
  const list = nodes.slice().sort((a, b) => key(b) - key(a))
  return (
    <Widget
      title="Services"
      subtitle="Click a service for its RED panel"
      actions={<Segmented value={sort} onChange={setSort} ariaLabel="Sort" options={[{ id: 'errors', label: 'Errors' }, { id: 'latency', label: 'p95' }, { id: 'traffic', label: 'Rate' }]} />}
      bodyClassName="p-0!"
    >
      <ul className="max-h-[70vh] divide-y divide-edge-subtle overflow-y-auto">
        {list.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onPick(n.id)} className="flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-[11px] hover:bg-surface-sunken">
              <HealthTag health={nodeHealth(n)} compact />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-content">{n.name}</span>
                <span className="block truncate text-[10px] text-content-subtle">{n.namespace ?? HEALTH_WORD[nodeHealth(n)]}</span>
              </span>
              <span className="shrink-0 text-right font-mono tabular-nums">
                <span className="block text-content">{formatValue(n.rps, 'rps')}</span>
                <span className="block text-content-subtle">{n.clientOnly ? 'client' : `${formatValue(n.errorPct, 'percent')} · ${formatValue(n.p95Ms, 'ms')}`}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Widget>
  )
}

function NodePanel({
  node,
  graph,
  src,
  win,
  onClose,
  onPick,
}: {
  node: GraphNode
  graph: Graph
  src: (typeof GRAPH_SOURCES)[number]
  win: Win
  onClose(): void
  onPick(id: string): void
}) {
  const nq = nodeQueries(src, node, '5m')
  const r = useRangeSet({ rps: nq.rps, err: nq.errPct, p95: nq.p95 }, { windowMs: 3_600_000, stepSec: 60, refreshMs: 30_000 })
  const callers = graph.edges.filter((e) => e.to === node.id).sort((a, b) => b.rps - a.rps)
  const callees = graph.edges.filter((e) => e.from === node.id).sort((a, b) => b.rps - a.rps)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const h = nodeHealth(node)
  const scope = { namespace: node.namespace ?? null, service: node.name }
  const chart = (k: 'rps' | 'err' | 'p95', name: string, unit: 'rps' | 'percent' | 'ms', slot: number) => {
    const s = r[k]
    if (s.isLoading) return <Loading height={90} />
    if (s.isError) return <QueryError error={s.error} />
    const pts = s.data?.[0]?.points ?? []
    if (pts.length < 2) return <NoData title="No samples" />
    return <SignalChart series={[{ name, points: pts, color: seriesColor(slot) }]} unit={unit} height={110} />
  }
  return (
    <Card className="min-w-0">
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-content">{node.name}</div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-subtle">
              {node.namespace ? <span>{node.namespace}</span> : null}
              <HealthTag health={h} label={HEALTH_WORD[h]} />
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close panel" className="rounded px-1.5 text-[15px] leading-none text-content-subtle hover:bg-surface-sunken hover:text-content">×</button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ['Rate', formatValue(node.rps, 'rps')],
            ['5xx', node.clientOnly ? '—' : formatValue(node.errorPct, 'percent')],
            ['p95', formatValue(node.p95Ms, 'ms')],
          ].map(([l, v]) => (
            <div key={l} className="rounded-md border border-edge-subtle py-1.5">
              <div className="font-mono text-sm font-semibold tabular-nums text-content">{v}</div>
              <div className="text-[10px] text-content-subtle">{l} · {win}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-medium text-brand-700 dark:text-brand-300">
          <DLink className="hover:underline" href={discoverHref('logs', { q: lokiSelector(scope), range: '1h' })}>Logs →</DLink>
          <DLink className="hover:underline" href={discoverHref('traces', { service: node.name, range: '1h' })}>Traces →</DLink>
          <DLink className="hover:underline" href={discoverHref('traces', { service: node.name, status: 'error', range: '1h' })}>Error traces →</DLink>
          <DLink className="hover:underline" href={discoverHref('metrics', { q: nq.rps, q2: nq.p95, range: '1h' })}>Metrics →</DLink>
          <DLink className="hover:underline" href={discoverHref('alerts', { service: node.name, namespace: node.namespace })}>Alerts →</DLink>
        </div>
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">Rate · last hour</div>
          {chart('rps', 'requests/s', 'rps', 0)}
          <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">5xx share</div>
          {chart('err', '5xx %', 'percent', 7)}
          <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">p95 latency</div>
          {chart('p95', 'p95', 'ms', 2)}
        </div>
        <EdgeList title={`Callers (${callers.length})`} edges={callers} other={(e) => byId.get(e.from)} onPick={onPick} />
        <EdgeList title={`Calls (${callees.length})`} edges={callees} other={(e) => byId.get(e.to)} onPick={onPick} />
      </div>
    </Card>
  )
}

function EdgeList({ title, edges, other, onPick }: { title: string; edges: GraphEdge[]; other(e: GraphEdge): GraphNode | undefined; onPick(id: string): void }) {
  if (!edges.length) return null
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">{title}</div>
      <ul className="divide-y divide-edge-subtle rounded-md border border-edge-subtle">
        {edges.slice(0, 10).map((e) => {
          const n = other(e)
          return (
            <li key={e.id}>
              <button type="button" onClick={() => n && onPick(n.id)} className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-surface-sunken">
                <HealthTag health={nodeHealth({ errorPct: e.errorPct })} compact />
                <span className="min-w-0 flex-1 truncate text-content">{n?.name ?? e.from}</span>
                <span className="shrink-0 font-mono tabular-nums text-content-muted">
                  {formatValue(e.rps, 'rps')} · {formatValue(e.errorPct, 'percent')}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

