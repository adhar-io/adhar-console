import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button, EmptyState } from '@adhar/shell-ui'
import { isPlatformNamespace, cn } from '@adhar/utils'
import { lokiSelector } from '../data/golden-signals.ts'
import { discoverHref } from '../data/discover-links.ts'
import {
  type FeedRow,
  type FlowsFrame,
  formatMs,
  formatPct,
  formatRate,
  KIND_LABEL,
  type MapEdge,
  mapEdgeHealth,
  type MapGraph,
  type MapNode,
  mapNodeHealth,
  primaryRate,
  type Proto,
  type SeriesPoint,
} from '../data/live-flows.ts'
import { Sparkline } from './sparkline.tsx'
import { KindGlyph } from './service-map-glyphs.tsx'
import { DLink, HealthTag } from './viz.tsx'

/* ─────────────────────────── hooks ─────────────────────────── */

export function useMediaQuery(q: string): boolean {
  const get = () => typeof matchMedia !== 'undefined' && matchMedia(q).matches
  const [m, setM] = useState(get)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    on()
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

/** Eases a number toward its new value (instant under reduced motion). */
export function useTweenedNumber(value: number, ms = 600): number {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const shownRef = useRef(value)
  useEffect(() => {
    if (!Number.isFinite(value)) return
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      shownRef.current = value
      setShown(value)
      return
    }
    from.current = shownRef.current
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const v = from.current + (value - from.current) * (1 - (1 - t) ** 3)
      shownRef.current = v
      setShown(v)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return shown
}

/* ─────────────────────────── header strip ─────────────────────────── */

function Counter({ value, format }: { value: number; format(v: number): string }) {
  const v = useTweenedNumber(value)
  return <>{format(v)}</>
}

function Tile({ label, children, hint, tone }: { label: string; children: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5 shadow-sm sm:px-4">
      <div className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{label}</div>
      <div
        className={cn(
          'mt-0.5 truncate font-mono text-xl font-semibold tabular-nums tracking-tight sm:text-2xl',
          tone === 'bad' ? 'text-rose-700 dark:text-rose-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : 'text-content',
        )}
      >
        {children}
      </div>
      {hint ? <div className="truncate text-[11px] text-content-muted">{hint}</div> : null}
    </div>
  )
}

export function HeaderStats({ totals, live, windowLabel }: { totals: FlowsFrame['totals'] | null; live: boolean; windowLabel: string }) {
  const t = totals ?? { rps: 0, cps: 0, fps: 0, err: null, drops: 0, services: 0, edges: 0 }
  const r = primaryRate(t)
  const errTone = t.err == null ? undefined : t.err >= 5 ? 'bad' : t.err >= 1 ? 'warn' : undefined
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4" aria-live="off">
      <Tile label={r.unit === 'req/s' ? 'Requests' : r.unit === 'conn/s' ? 'New connections' : 'Flow events'} hint={`per second · ${windowLabel}${live ? '' : ' avg'}`}>
        <Counter value={r.value} format={formatRate} />
        <span className="ml-1 text-xs font-normal text-content-subtle">{r.unit}</span>
      </Tile>
      <Tile label="Error rate" tone={errTone} hint={t.err == null ? 'no L7 responses seen' : '5xx / failed responses'}>
        {t.err == null ? '—' : <Counter value={t.err} format={(v) => formatPct(v)} />}
      </Tile>
      <Tile label="Active services" hint={`${t.edges} connections`}>
        <Counter value={t.services} format={(v) => String(Math.round(v))} />
      </Tile>
      <Tile label="Drops" tone={t.drops > 0 ? 'bad' : undefined} hint={t.drops > 0 ? 'denied or failed packets' : 'nothing dropped'}>
        <Counter value={t.drops} format={formatRate} />
        <span className="ml-1 text-xs font-normal text-content-subtle">/s</span>
      </Tile>
    </div>
  )
}

/* ─────────────────────────── source badge ─────────────────────────── */

export type SourceMode = 'live' | 'paused' | 'connecting' | 'reconnecting' | 'metrics' | 'none'

export function SourceBadge({ mode, label }: { mode: SourceMode; label: string }) {
  const dot = mode === 'live'
    ? 'bg-emerald-500'
    : mode === 'reconnecting' || mode === 'connecting'
    ? 'bg-amber-500'
    : mode === 'metrics'
    ? 'bg-brand-500'
    : 'bg-content-subtle'
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content-muted" role="status">
      <span className="relative flex h-2 w-2">
        {mode === 'live' ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60 motion-reduce:hidden" /> : null}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', dot)} />
      </span>
      {label}
    </span>
  )
}

/* ─────────────────────────── chips & selects ─────────────────────────── */

export function Chip({ on, onClick, children, title }: { on: boolean; onClick(): void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11.5px] font-medium transition-colors',
        on
          ? 'border-brand-400/60 bg-brand-50 text-brand-700 dark:border-brand-400/40 dark:bg-brand-500/15 dark:text-brand-200'
          : 'border-edge-default bg-surface-raised text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

export function NamespacePicker({ all, value, onChange, scope, onScope }: {
  all: string[]
  value: string[]
  onChange(v: string[]): void
  /** With nothing picked: application namespaces only, or everything. */
  scope: 'apps' | 'all'
  onScope(s: 'apps' | 'all'): void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const options = [...new Set([...all, ...value])].sort().filter((n) => n.includes(q.trim().toLowerCase()))
  const label = value.length === 0 ? (scope === 'apps' ? 'Applications' : 'All namespaces') : value.length === 1 ? value[0] : `${value.length} namespaces`
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-7 max-w-[11rem] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium',
          value.length ? 'border-brand-400/60 text-brand-700 dark:text-brand-200' : 'border-edge-default text-content-muted',
          'bg-surface-raised hover:text-content',
        )}
      >
        <span className="truncate">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-60 rounded-lg border border-edge-default bg-surface-raised p-1.5 shadow-xl">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter namespaces…"
            aria-label="Filter namespaces"
            className="mb-1 h-7 w-full rounded-md border border-edge-default bg-surface-sunken px-2 text-[11.5px] text-content focus:border-brand-400 focus:outline-none"
          />
          <div role="radiogroup" aria-label="Default scope" className="mb-1 border-b border-edge-subtle pb-1">
            {([
              ['apps', 'Applications', 'Platform namespaces hidden'],
              ['all', 'All namespaces', 'Including adhar-system, kube-system…'],
            ] as const).map(([id, title, hint]) => {
              const on = value.length === 0 && scope === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    onScope(id)
                    onChange([])
                  }}
                  className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken', on && 'bg-surface-sunken')}
                >
                  <span className={cn('mt-1 h-2.5 w-2.5 shrink-0 rounded-full border', on ? 'border-brand-500 bg-brand-500' : 'border-edge-strong')} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-content">{title}</span>
                    <span className="block truncate text-[10.5px] text-content-subtle">{hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto">
            {options.length === 0 ? <div className="px-2 py-3 text-center text-[11px] text-content-subtle">No namespaces with traffic</div> : null}
            {options.map((n) => {
              const on = value.includes(n)
              return (
                <label key={n} role="option" aria-selected={on} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-content hover:bg-surface-sunken">
                  <input type="checkbox" className="accent-brand-600" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== n) : [...value, n])} />
                  <span className="truncate">{n}</span>
                  {isPlatformNamespace(n) ? <span className="ml-auto shrink-0 rounded bg-surface-sunken px-1 text-[9.5px] font-medium uppercase tracking-wide text-content-subtle">platform</span> : null}
                </label>
              )
            })}
          </div>
          {value.length ? (
            <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[11.5px] font-medium text-brand-700 hover:bg-surface-sunken dark:text-brand-300">
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export const PROTO_LABEL: Record<Proto, string> = { http: 'HTTP', grpc: 'gRPC', dns: 'DNS', kafka: 'Kafka', tcp: 'TCP', udp: 'UDP', icmp: 'ICMP', other: 'Other' }

/* ─────────────────────────── shared bits ─────────────────────────── */

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-edge-subtle bg-surface-raised px-2.5 py-2">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-content-subtle">{label}</div>
      <div className="truncate font-mono text-sm font-semibold tabular-nums text-content">{value}</div>
      {sub ? <div className="truncate text-[10px] text-content-subtle">{sub}</div> : null}
    </div>
  )
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

function Spark({ series, pick, color, label, fmt }: { series: SeriesPoint[]; pick(p: SeriesPoint): number | null; color: string; label: string; fmt(v: number): string }) {
  const pts = series.map((p) => ({ t: p.t, v: pick(p) ?? Number.NaN }))
  const vals = pts.map((p) => p.v).filter(Number.isFinite)
  // The window average — a single second of bursty traffic is usually 0.
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  const peak = vals.length ? Math.max(...vals) : null
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-raised px-2.5 pb-1.5 pt-2">
      <div className="flex items-baseline justify-between gap-2 text-[10.5px]">
        <span className="font-medium text-content-muted">{label}</span>
        <span className="font-mono tabular-nums text-content">
          {avg == null ? '—' : <>avg {fmt(avg)}<span className="text-content-subtle"> · peak {fmt(peak!)}</span></>}
        </span>
      </div>
      <Sparkline points={pts} width={300} height={34} color={color} label={`${label} trend`} />
    </div>
  )
}

function Links({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(([label, href]) => (
        <DLink key={label} href={href} className="inline-flex h-7 items-center rounded-md border border-edge-default bg-surface-raised px-2.5 text-[11.5px] font-medium text-content-muted hover:border-brand-400/50 hover:text-brand-700 dark:hover:text-brand-200">
          {label}
        </DLink>
      ))}
    </div>
  )
}

function EdgeRows({ edges, other, byId, onEdge }: { edges: MapEdge[]; other(e: MapEdge): string; byId: Map<string, MapNode>; onEdge(id: string): void }) {
  if (!edges.length) return <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-[11px] text-content-subtle">None in this window</div>
  return (
    <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle bg-surface-raised">
      {edges.slice(0, 12).map((e) => {
        const n = byId.get(other(e))
        const r = primaryRate(e)
        return (
          <li key={e.id}>
            <button type="button" onClick={() => onEdge(e.id)} className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] hover:bg-surface-sunken">
              <HealthTag health={mapEdgeHealth(e)} compact />
              <span className="text-content-subtle"><KindGlyph kind={n?.kind ?? 'workload'} size={13} /></span>
              <span className="min-w-0 flex-1 truncate text-content">{n?.name ?? other(e)}</span>
              <span className="shrink-0 font-mono tabular-nums text-content-muted">
                {formatRate(r.value)} {r.unit}
                {e.err != null ? ` · ${formatPct(e.err)}` : ''}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/* ─────────────────────────── node panel ─────────────────────────── */

export function NodePanel({
  node,
  graph,
  frame,
  feed,
  metricsMode,
  embedded = false,
  onEdge,
  onClose,
}: {
  node: MapNode
  graph: MapGraph
  frame: FlowsFrame | null
  feed: FeedRow[]
  metricsMode: boolean
  /** Inside a drawer that already shows the name and a close button. */
  embedded?: boolean
  onEdge(id: string): void
  onClose(): void
}) {
  const h = mapNodeHealth(node)
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes])
  const inbound = graph.edges.filter((e) => e.d === node.id).sort((a, b) => b.rps + b.fps - (a.rps + a.fps))
  const outbound = graph.edges.filter((e) => e.s === node.id).sort((a, b) => b.rps + b.fps - (a.rps + a.fps))
  const series = frame?.focus?.id === node.id ? frame.focus.series : []
  const pods = frame?.focus?.id === node.id ? frame.focus.pods : []
  const rows = feed.filter((r) => r.s === node.id || r.d === node.id).slice(0, 12)
  const served = primaryRate(node)
  const workload = node.ns && node.kind !== 'namespace' && node.kind !== 'restricted'
  const scope = { namespace: node.ns ?? null, service: node.name }
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-edge-default bg-surface-sunken text-content-muted">
          <KindGlyph kind={node.kind} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          {embedded ? null : <div className="truncate text-sm font-semibold text-content">{node.name}</div>}
          <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content-subtle', embedded ? 'mt-2.5' : 'mt-0.5')}>
            {node.ns ? <span>{node.ns}</span> : null}
            <span>{KIND_LABEL[node.kind]}</span>
            <HealthTag health={h} label={node.idle ? 'Idle' : h === 'none' && node.rps + node.cps + node.fps + node.orps + node.ofps > 0 ? 'L4 only' : undefined} />
          </div>
        </div>
        {embedded ? null : <CloseButton onClose={onClose} />}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {node.rps + node.cps + node.fps === 0 && node.orps + node.ofps > 0 ? (
          <Stat label="Sends" value={`${formatRate(node.orps || node.ofps)} ${node.orps ? 'req/s' : 'flows/s'}`} sub="a client only — nothing inbound" />
        ) : (
          <Stat label="Served" value={`${formatRate(served.value)} ${served.unit}`} sub={node.orps + node.ofps > 0 ? `${formatRate(node.orps || node.ofps)} ${node.orps ? 'req/s' : 'flows/s'} out` : 'nothing outbound'} />
        )}
        <Stat label="Errors" value={formatPct(node.err)} sub={node.err == null ? 'no L7 responses' : 'of served requests'} />
        <Stat label="p95 latency" value={formatMs(node.p95)} sub="served" />
        <Stat label="Drops" value={`${formatRate(node.drops)}/s`} sub={node.drops > 0 ? 'inbound, denied or failed' : 'none'} />
      </div>

      {!metricsMode ? (
        <Section title="Live">
          {series.length > 1 ? (
            <div className="grid gap-1.5">
              <Spark series={series} pick={(p) => (p.rps > 0 ? p.rps : p.fps)} color="var(--color-brand-500)" label={series.some((p) => p.rps > 0) ? 'Requests/s' : 'Flow events/s'} fmt={formatRate} />
              {series.some((p) => p.err != null) ? <Spark series={series} pick={(p) => p.err} color="var(--color-rose-500)" label="Errors" fmt={formatPct} /> : null}
              {series.some((p) => p.p95 != null) ? <Spark series={series} pick={(p) => p.p95} color="var(--color-amber-500)" label="p95" fmt={formatMs} /> : null}
              {series.every((p) => p.err == null) ? <div className="text-[11px] text-content-subtle">Errors and latency need L7 visibility on this workload (an L7-aware CiliumNetworkPolicy).</div> : null}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-[11px] text-content-subtle">Trend appears as traffic arrives.</div>
          )}
        </Section>
      ) : null}

      {workload ? (
        <Links
          items={[
            ['Logs', discoverHref('logs', { q: lokiSelector(scope), range: '1h' })],
            ['Traces', discoverHref('traces', { service: node.name, range: '1h' })],
            ['Error traces', discoverHref('traces', { service: node.name, status: 'error', range: '1h' })],
            ['Metrics', discoverHref('metrics', { q: `sum(rate(container_cpu_usage_seconds_total{namespace="${node.ns}", pod=~"${node.name}-.*"}[5m]))`, range: '1h' })],
            ['Grafana boards', discoverHref('dashboards')],
            ['Alerts', discoverHref('alerts', { service: node.name, namespace: node.ns })],
            ['Catalog', `/catalog?q=${encodeURIComponent(node.name)}`],
          ]}
        />
      ) : null}

      <Section title={`Inbound · ${inbound.length}`}>
        <EdgeRows edges={inbound} other={(e) => e.s} byId={byId} onEdge={onEdge} />
      </Section>
      <Section title={`Outbound · ${outbound.length}`}>
        <EdgeRows edges={outbound} other={(e) => e.d} byId={byId} onEdge={onEdge} />
      </Section>

      {pods.length ? (
        <Section title={`Pods in traffic · ${pods.length}`}>
          <ul className="flex flex-wrap gap-1.5">
            {pods.map((p) => (
              <li key={p} className="rounded-md border border-edge-subtle bg-surface-raised px-2 py-1 font-mono text-[10.5px] text-content-muted">{p}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!metricsMode ? (
        <Section title="Recent flows">
          {rows.length ? <FeedList rows={rows} compact /> : <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-[11px] text-content-subtle">No sampled flows yet.</div>}
        </Section>
      ) : null}
    </div>
  )
}

/* ─────────────────────────── edge panel ─────────────────────────── */

export function EdgePanel({
  edge,
  graph,
  frame,
  feed,
  metricsMode,
  embedded = false,
  onNode,
  onClose,
}: {
  edge: MapEdge
  graph: MapGraph
  frame: FlowsFrame | null
  feed: FeedRow[]
  metricsMode: boolean
  embedded?: boolean
  onNode(id: string): void
  onClose(): void
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const s = byId.get(edge.s)
  const d = byId.get(edge.d)
  const detail = frame?.edge?.id === edge.id ? frame.edge : null
  const r = primaryRate(edge)
  const rows = feed.filter((x) => x.s === edge.s && x.d === edge.d).slice(0, 15)
  const st = detail?.status
  const total = st ? st.c2 + st.c3 + st.c4 + st.c5 : 0
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-content-subtle">Connection</div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold text-content">
            <button type="button" onClick={() => onNode(edge.s)} className="truncate hover:text-brand-700 dark:hover:text-brand-300">{s?.name ?? edge.s}</button>
            <span className="text-content-subtle" aria-label="to">→</span>
            <button type="button" onClick={() => onNode(edge.d)} className="truncate hover:text-brand-700 dark:hover:text-brand-300">{d?.name ?? edge.d}</button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-content-subtle">
            <HealthTag health={mapEdgeHealth(edge)} label={edge.idle ? 'Idle' : mapEdgeHealth(edge) === 'none' ? 'L4 only' : undefined} />
            {edge.protos.map((p) => <span key={p} className="rounded bg-surface-sunken px-1.5 py-0.5 font-medium text-content-muted">{PROTO_LABEL[p]}</span>)}
            {(detail?.ports ?? edge.ports).length ? <span className="font-mono">:{(detail?.ports ?? edge.ports).join(', :')}</span> : null}
          </div>
          {(detail?.svcs ?? (edge.svc ? [edge.svc] : [])).length ? (
            <div className="mt-1 truncate text-[11px] text-content-subtle">via Service {(detail?.svcs ?? [edge.svc!]).join(', ')}</div>
          ) : null}
        </div>
        {embedded ? null : <CloseButton onClose={onClose} />}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Rate" value={`${formatRate(r.value)} ${r.unit}`} sub={edge.fps > 0 && r.unit !== 'flows/s' ? `${formatRate(edge.fps)} flow events/s` : undefined} />
        <Stat label="Errors" value={formatPct(edge.err)} sub={edge.e4 != null ? `${formatPct(edge.e4)} 4xx` : 'no L7 responses'} />
        <Stat label="Latency p50 / p95" value={`${formatMs(detail?.p50 ?? edge.p50)} / ${formatMs(detail?.p95 ?? edge.p95)}`} sub={detail?.p99 != null ? `p99 ${formatMs(detail.p99)}` : undefined} />
        <Stat label="Drops" value={`${formatRate(edge.drops)}/s`} sub={edge.drops > 0 ? 'see reasons below' : 'none'} />
      </div>

      {!metricsMode && detail?.series && detail.series.length > 1 ? (
        <Section title="Live">
          <div className="grid gap-1.5">
            <Spark series={detail.series} pick={(p) => (p.rps > 0 ? p.rps : p.fps)} color="var(--color-brand-500)" label={detail.series.some((p) => p.rps > 0) ? 'Requests/s' : 'Flow events/s'} fmt={formatRate} />
            {detail.series.some((p) => p.p95 != null) ? <Spark series={detail.series} pick={(p) => p.p95} color="var(--color-amber-500)" label="p95" fmt={formatMs} /> : null}
          </div>
        </Section>
      ) : null}

      {st && total > 0 ? (
        <Section title="Status codes">
          <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`2xx ${st.c2}, 3xx ${st.c3}, 4xx ${st.c4}, 5xx or failed ${st.c5}`}>
            {[
              [st.c2, 'bg-emerald-500'],
              [st.c3, 'bg-brand-400'],
              [st.c4, 'bg-amber-500'],
              [st.c5, 'bg-rose-500'],
            ].map(([n, c], i) => (n as number) > 0 ? <span key={i} className={c as string} style={{ width: `${(100 * (n as number)) / total}%` }} /> : null)}
          </div>
          <div className="grid grid-cols-4 gap-1 text-center text-[10.5px]">
            {[['2xx', st.c2], ['3xx', st.c3], ['4xx', st.c4], ['5xx', st.c5]].map(([l, n]) => (
              <div key={l as string}>
                <div className="font-mono font-semibold tabular-nums text-content">{n}</div>
                <div className="text-content-subtle">{l}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {detail?.dropReasons.length ? (
        <Section title="Drop reasons">
          <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle bg-surface-raised">
            {detail.dropReasons.map((d) => (
              <li key={d.reason} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11.5px]">
                <span className="text-rose-700 dark:text-rose-300">{d.reason}</span>
                <span className="font-mono tabular-nums text-content-muted">{d.count}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!metricsMode ? (
        <Section title="Sample flows">
          {rows.length ? <FeedList rows={rows} compact /> : <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-[11px] text-content-subtle">No sampled flows yet.</div>}
        </Section>
      ) : null}
    </div>
  )
}

function CloseButton({ onClose }: { onClose(): void }) {
  return (
    <button type="button" onClick={onClose} aria-label="Close panel" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  )
}

/* ─────────────────────────── flow feed ─────────────────────────── */

const pad2 = (n: number) => String(n).padStart(2, '0')
function clock(t: number): string {
  const d = new Date(t)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function Verdict({ r }: { r: FeedRow }) {
  if (r.v === 'drop') return <span className="rounded bg-rose-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">DROP</span>
  if (r.code !== undefined && (r.p === 'http' || r.p === 'grpc')) {
    const c = r.code
    const cls = c >= 500 ? 'bg-rose-500/12 text-rose-700 dark:text-rose-300' : c >= 400 ? 'bg-amber-500/14 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
    return <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold', cls)}>{c}</span>
  }
  if (r.p === 'dns' && r.code !== undefined) {
    return <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', r.code === 0 ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/14 text-amber-700 dark:text-amber-300')}>{r.code === 0 ? 'OK' : r.code === 3 ? 'NX' : `RC${r.code}`}</span>
  }
  return <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold text-content-muted">{r.newConn ? 'SYN' : 'FWD'}</span>
}

function describe(r: FeedRow): string {
  if (r.v === 'drop') return r.dr ?? 'dropped'
  if (r.m || r.path) return [r.m, r.path].filter(Boolean).join(' ')
  if (r.q) return r.q
  return `${PROTO_LABEL[r.p]}${r.port ? ` :${r.port}` : ''}${r.newConn ? ' new connection' : ''}`
}

function FeedRowView({ r, compact }: { r: FeedRow; compact?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-start gap-2 px-2.5 py-1.5 text-[11px]', !compact && 'h-[52px]')}>
      <span className="mt-0.5 w-12 shrink-0 font-mono text-[10px] tabular-nums text-content-subtle">{clock(r.t)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1 text-content">
          <span className="truncate font-medium" title={r.sns ? `${r.sns}/${r.sn}` : r.sn}>{r.sn}</span>
          <span className="shrink-0 text-content-subtle">→</span>
          <span className="truncate font-medium" title={r.dns ? `${r.dns}/${r.dn}` : r.dn}>{r.dn}</span>
        </div>
        <div className="truncate font-mono text-[10.5px] text-content-muted" title={describe(r)}>{describe(r)}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Verdict r={r} />
        {r.lat !== undefined ? <span className="font-mono text-[10px] tabular-nums text-content-subtle">{formatMs(r.lat)}</span> : null}
      </div>
    </div>
  )
}

export function FeedList({ rows, compact }: { rows: FeedRow[]; compact?: boolean }) {
  return (
    <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-subtle bg-surface-raised">
      {rows.map((r) => <li key={r.seq}><FeedRowView r={r} compact={compact} /></li>)}
    </ul>
  )
}

/**
 * The live feed: virtualised, newest on top. Hovering (or focusing) freezes
 * it so a row can be read; new rows queue behind a "N new" pill.
 */
export function FlowFeed({ rows, height, paused }: { rows: FeedRow[]; height: number; paused: boolean }) {
  const [hold, setHold] = useState<FeedRow[] | null>(null)
  const shown = hold ?? rows
  const pending = hold ? rows.findIndex((r) => r.seq === hold[0]?.seq) : 0
  const ref = useRef<HTMLDivElement | null>(null)
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => ref.current, estimateSize: () => 52, overscan: 8 })
  return (
    <div
      className="relative"
      onMouseEnter={() => setHold(rows)}
      onMouseLeave={() => setHold(null)}
      onFocus={() => setHold(rows)}
      onBlur={() => setHold(null)}
    >
      {hold && pending > 0 ? (
        <button type="button" onClick={() => setHold(null)} className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-medium text-white shadow-md">
          {pending > 99 ? '99+' : pending} new
        </button>
      ) : null}
      <div ref={ref} style={{ height }} className="overflow-y-auto" tabIndex={0} aria-label={paused ? 'Recent flows (paused)' : 'Recent flows, live'}>
        {shown.length === 0 ? (
          <EmptyState compact bare title="Waiting for flows" description="Requests, new connections and drops appear here as they happen." />
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((it) => (
              <div key={shown[it.index].seq} className="absolute left-0 right-0 border-b border-edge-subtle" style={{ top: it.start, height: it.size }}>
                <FeedRowView r={shown[it.index]} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────── services list ─────────────────────────── */

export function ServiceList({ graph, onNode, height }: { graph: MapGraph; onNode(id: string): void; height: number }) {
  const [sort, setSort] = useState<'rate' | 'errors' | 'latency'>('rate')
  const key = (n: MapNode) => (sort === 'rate' ? n.rps + n.cps + n.fps : sort === 'errors' ? n.err ?? -1 : n.p95 ?? -1)
  const list = graph.nodes.filter((n) => !n.idle).sort((a, b) => key(b) - key(a))
  return (
    <div>
      <div className="flex items-center justify-end gap-1 px-3 py-2">
        {(['rate', 'errors', 'latency'] as const).map((s) => (
          <Chip key={s} on={sort === s} onClick={() => setSort(s)}>{s === 'rate' ? 'Rate' : s === 'errors' ? 'Errors' : 'p95'}</Chip>
        ))}
      </div>
      <ul className="divide-y divide-edge-subtle overflow-y-auto" style={{ maxHeight: height }}>
        {list.map((n) => {
          const r = primaryRate(n.rps + n.cps + n.fps > 0 ? n : { rps: n.orps, cps: 0, fps: n.ofps })
          return (
            <li key={n.id}>
              <button type="button" onClick={() => onNode(n.id)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[11.5px] hover:bg-surface-sunken">
                <HealthTag health={mapNodeHealth(n)} compact />
                <span className="text-content-subtle"><KindGlyph kind={n.kind} size={14} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-content">{n.name}</span>
                  <span className="block truncate text-[10px] text-content-subtle">{n.ns ?? KIND_LABEL[n.kind]}</span>
                </span>
                <span className="shrink-0 text-right font-mono tabular-nums">
                  <span className="block text-content">{formatRate(r.value)} <span className="text-content-subtle">{r.unit}</span></span>
                  <span className="block text-[10px] text-content-subtle">{formatPct(n.err)} · {formatMs(n.p95)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ─────────────────────────── honest states ─────────────────────────── */

const MapIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="5" cy="6" r="2.5" />
    <circle cx="19" cy="6" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <path d="M7.5 6h9M6.3 8.2l4.4 7.6M17.7 8.2l-4.4 7.6" />
  </svg>
)

export function NoLiveSource({ reason, message, onRetry }: { reason?: string; message?: string; onRetry(): void }) {
  const [open, setOpen] = useState(false)
  return (
    <EmptyState
      icon={<MapIcon />}
      title="No live traffic source"
      description={
        <span>
          {reason === 'not-configured'
            ? 'This console is not connected to Hubble Relay, and Prometheus has no caller → callee request metrics to fall back on.'
            : `Hubble Relay could not be reached${message ? ` (${message})` : ''}, and Prometheus has no caller → callee request metrics to fall back on.`}
          {open ? (
            <span className="mt-3 block space-y-2 text-left text-[12px]">
              <span className="block">
                <span className="font-semibold text-content">Live (recommended):</span> Cilium with Hubble Relay. In-cluster the console dials{' '}
                <code className="font-mono">hubble-relay.adhar-system:80</code>; set <code className="font-mono">HUBBLE_RELAY_ADDR</code> (and{' '}
                <code className="font-mono">HUBBLE_RELAY_TLS=1</code> for a TLS relay) to point elsewhere. Request rates, errors and latency need L7 visibility (an L7-aware CiliumNetworkPolicy).
              </span>
              <span className="block">
                <span className="font-semibold text-content">1-minute metrics:</span> Tempo metrics-generator service graphs, Istio, or Hubble{' '}
                <code className="font-mono">httpV2</code> metrics with <code className="font-mono">labelsContext=source_namespace,source_workload,destination_namespace,destination_workload</code>.
              </span>
            </span>
          ) : null}
        </span>
      }
      action={
        <>
          <Button variant="primary" size="sm" onClick={onRetry}>Retry connection</Button>
          <Button size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide setup' : 'How to enable'}</Button>
        </>
      }
    />
  )
}

export function NoTraffic({ window, filtered, appsOnly, onShowAll, onWiden, onClear }: {
  window: string
  filtered: boolean
  /** The default Applications scope is on (no namespace picked). */
  appsOnly?: boolean
  onShowAll?(): void
  onWiden?(): void
  onClear(): void
}) {
  // Only the platform is talking right now: say so, and offer the platform view.
  if (appsOnly && !filtered && onShowAll) {
    return (
      <EmptyState
        bare
        icon={<MapIcon />}
        title={`No application traffic in the last ${window}`}
        description="Applications are shown by default; platform namespaces such as adhar-system and kube-system are hidden. Traffic there is still visible under All namespaces."
        action={
          <>
            <Button variant="primary" size="sm" onClick={onShowAll}>Show all namespaces</Button>
            {onWiden ? <Button size="sm" onClick={onWiden}>Widen to 5 minutes</Button> : null}
          </>
        }
      />
    )
  }
  return (
    <EmptyState
      bare
      icon={<MapIcon />}
      title={filtered ? 'Nothing matches these filters' : `No traffic you can see in the last ${window}`}
      description={
        filtered
          ? 'Traffic is flowing, but none of it matches the current namespace, protocol or search filters.'
          : 'Only namespaces you may list pods in are shown. Idle workloads appear once you pick a namespace with “Idle” on.'
      }
      action={
        <>
          {filtered ? <Button variant="primary" size="sm" onClick={onClear}>Clear filters</Button> : null}
          {!filtered && onWiden ? <Button variant="primary" size="sm" onClick={onWiden}>Widen to 5 minutes</Button> : null}
        </>
      }
    />
  )
}
