import { useMemo } from 'react'
import { AreaChart, StatusBadge } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { Generic } from '@adhar/api-clients/k8s'
import { useClusterSignals } from '~/data/cluster-signals.ts'
import { useDiscoverSlos, useGiteaFlow, useGoldenSignals } from '~/data/cross-module-signals.ts'
import {
  cnpgCluster,
  useCnpgPoolMetrics,
  useFalcoMetrics,
  useHubbleLatencyBuckets,
  useHubbleTraffic,
  useHubbleTrafficStream,
  useMeshSecurityMetrics,
  useRedisMetrics,
  useTetragonMetrics,
} from '~/data/overview-metrics.ts'
import {
  useCiliumClusterPolicies,
  useCiliumNodes,
  useCiliumPolicies,
  useEventListeners,
  useGateways,
  useHttpRoutes,
  useKafkas,
  useKafkaTopics,
  usePipelineRuns,
} from '~/data/platform-signals.ts'
import { type PromSample, scalar } from '~/data/prom-instant.ts'
import { PanelCard, PanelEmpty, PanelError, PanelHead, PanelLoading, SignalTile, Stat } from './_overview-panels.tsx'

/**
 * Overview panels backed by the signals the platform stack really emits.
 *
 * The service mesh is Cilium, so traffic and mesh security come from Hubble
 * metrics and CiliumNodes. CI is Tekton, so build and
 * pipeline panels read PipelineRuns. Delivery flow comes from Gitea. Runtime
 * security is Falco + Tetragon. Every panel shows loading, a named failure,
 * or an empty state that says which source it needs — never invented numbers.
 */

/* ─────────── small helpers ─────────── */

const fin = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

function fmtRate(v: number | null): string {
  if (!fin(v)) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`
  if (v >= 10) return `${v.toFixed(0)}/s`
  if (v > 0 && v < 0.01) return '<0.01/s'
  return `${v.toFixed(v >= 1 ? 1 : 2)}/s`
}

function fmtMs(v: number | null): string {
  if (!fin(v)) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`
}

function fmtPct(v: number | null, digits = 1): string {
  return fin(v) ? `${v.toFixed(digits)}%` : '—'
}

function fmtBytes(b: number | null): string {
  if (!fin(b)) return '—'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let v = b
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function fmtDuration(ms: number | null): string {
  if (!fin(ms)) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(0)}s`
  const m = s / 60
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${(h / 24).toFixed(1)}d`
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Map a vector to `{key → value}` by one label. */
function byLabel(v: PromSample[] | undefined, label: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of v ?? []) m.set(s.labels[label] ?? '', (m.get(s.labels[label] ?? '') ?? 0) + s.value)
  return m
}

/** Join two vectors on a composite key built from labels. */
function keyed(v: PromSample[] | undefined, key: (l: Record<string, string>) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of v ?? []) m.set(key(s.labels), s.value)
  return m
}

function Bar({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' }) {
  const color = {
    brand: 'bg-brand-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    violet: 'bg-violet-500',
    sky: 'bg-sky-500',
  }[tone]
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', color)}
        style={{ width: `${max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0}%` }}
      />
    </div>
  )
}

/** Uniform "can't show this" body for a query result. */
function gate(q: { isLoading: boolean; isError: boolean; error?: unknown }, emptyWhen: boolean, emptyMessage: string) {
  if (q.isLoading) return <PanelLoading />
  if (q.isError) return <PanelError message={q.error instanceof Error ? q.error.message : undefined} />
  if (emptyWhen) return <PanelEmpty message={emptyMessage} />
  return null
}

const HUBBLE_L7_HINT =
  'Hubble records HTTP (L7) only for traffic through a Cilium L7 policy or the Gateway API proxy.'

/* ═════════════════════ Discover · golden signals (Hubble L7) ═════════════════════ */

export function GoldenSignalsPanel() {
  const { rps, errors, p95 } = useGoldenSignals()
  const series = (d?: Array<{ values: Array<[number, string]> }>) =>
    (d?.[0]?.values ?? []).map(([, v]) => Number(v)).filter(Number.isFinite)
  const last = (d?: Array<{ values: Array<[number, string]> }>) => {
    const s = series(d)
    return s.length ? s[s.length - 1] : null
  }
  const head = <PanelHead title="Golden signals" subtitle="Cilium Hubble L7 · last hour" to="/discover?section=metrics" />
  const blocked = gate(rps, !(rps.data ?? []).length, `No L7 traffic observed. ${HUBBLE_L7_HINT}`)
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SignalTile label="Requests" value={fmtRate(last(rps.data))} series={series(rps.data)} color="var(--color-brand-500)" />
        <SignalTile label="5xx" value={fmtPct(last(errors.data), 2)} series={series(errors.data)} color="var(--color-rose-500)" />
        <SignalTile label="p95" value={fmtMs(last(p95.data))} series={series(p95.data)} color="var(--color-amber-500)" />
      </div>
    </PanelCard>
  )
}

export function TopErrorSourcesPanel() {
  const { errorsByWorkload } = useGoldenSignals()
  const rows = useMemo(() => {
    return (errorsByWorkload.data ?? [])
      .map((s) => {
        const v = Number(s.values[s.values.length - 1]?.[1])
        const ns = s.metric.destination_namespace
        const wl = s.metric.destination_workload
        return { name: wl ? `${ns ? `${ns}/` : ''}${wl}` : '', rate: Number.isFinite(v) ? v : 0 }
      })
      .sort((a, b) => b.rate - a.rate)
  }, [errorsByWorkload.data])
  const head = <PanelHead title="Top error sources" subtitle="5xx share by workload · Hubble L7" to="/discover?section=metrics" />
  const blocked = gate(errorsByWorkload, rows.length === 0, `No L7 responses observed. ${HUBBLE_L7_HINT}`)
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  // Without Hubble's context labels the query collapses to one mesh-wide row.
  if (rows.length === 1 && !rows[0].name) {
    return (
      <PanelCard>
        {head}
        <div className="mb-3">
          <Stat label="Mesh-wide 5xx" value={fmtPct(rows[0].rate, 2)} tone={rows[0].rate >= 1 ? 'rose' : 'emerald'} />
        </div>
        <PanelEmpty message="Per-workload breakdown needs Hubble's httpV2 metric with labelsContext=destination_namespace,destination_workload." />
      </PanelCard>
    )
  }
  const max = Math.max(0.01, ...rows.map((r) => r.rate))
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-2.5">
        {rows.slice(0, 6).map((r) => {
          const tone = r.rate >= 3 ? 'rose' : r.rate >= 1 ? 'amber' : 'emerald'
          return (
            <li key={r.name}>
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate font-mono font-medium text-content">{r.name}</span>
                <span className={cn('font-mono tabular-nums', tone === 'rose' ? 'text-rose-700 dark:text-rose-300' : tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300')}>
                  {fmtPct(r.rate, 2)}
                </span>
              </div>
              <div className="mt-1"><Bar value={r.rate} max={max} tone={tone} /></div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ═════════════════════ SLO health ═════════════════════ */

export function SloPanel() {
  const q = useDiscoverSlos()
  const list = q.data ?? []
  const head = <PanelHead title="SLO health" subtitle={list.length ? `${list.length} objectives` : 'Service-level objectives'} to="/discover?section=slos" />
  const blocked = gate(q, list.length === 0, 'No SLOs defined yet. Define objectives under Discover → SLOs to track error budgets here.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const meeting = list.filter((s) => s.current >= s.objective).length
  const burning = list.filter((s) => s.errorBudgetRemaining < 0.5).length
  const minBudget = Math.min(...list.map((s) => s.errorBudgetRemaining * 100))
  return (
    <PanelCard>
      {head}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Meeting" value={`${meeting}/${list.length}`} tone={meeting === list.length ? 'emerald' : 'amber'} />
        <Stat label="Burning" value={burning} tone={burning ? 'rose' : 'slate'} />
        <Stat label="Min budget" value={fmtPct(minBudget, 0)} tone={minBudget < 30 ? 'rose' : minBudget < 70 ? 'amber' : 'emerald'} />
      </div>
      <ul className="mt-3 space-y-1.5">
        {list.slice(0, 4).map((s) => {
          const ok = s.current >= s.objective
          return (
            <li key={s.name} className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-2 py-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-content">{s.name}</span>
                <span className={cn('font-mono tabular-nums', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300')}>
                  {s.current.toFixed(2)}% / {s.objective}%
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ═════════════════════ Runtime security · Falco ═════════════════════ */

const FALCO_CRIT = new Set(['emergency', 'alert', 'critical'])
const FALCO_WARN = new Set(['error', 'warning'])

export function RuntimePanel() {
  const q = useFalcoMetrics()
  const pr = byLabel(q.data?.byPriority, 'priority_raw')
  const sensors = scalar(q.data?.sensors)
  let crit = 0
  let warn = 0
  let info = 0
  for (const [p, n] of pr) {
    if (FALCO_CRIT.has(p)) crit += n
    else if (FALCO_WARN.has(p)) warn += n
    else info += n
  }
  const rules = (q.data?.topRules ?? []).map((s) => ({ rule: s.labels.rule ?? 'unknown', priority: s.labels.priority_raw ?? 'notice', n: s.value }))
  const head = <PanelHead title="Runtime threats" subtitle={`Falco · last 24h${fin(sensors) ? ` · ${sensors} sensors` : ''}`} to="/platform" />
  const blocked = gate(q, !fin(sensors) && pr.size === 0, 'Falco is not reporting. Runtime threat detection needs the Falco DaemonSet and falcosidekick metrics.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Critical" value={fmtCount(crit)} tone={crit ? 'rose' : 'slate'} />
        <Stat label="Warning" value={fmtCount(warn)} tone={warn ? 'amber' : 'slate'} />
        <Stat label="Notice" value={fmtCount(info)} tone="brand" />
      </div>
      {rules.length ? (
        <ul className="mt-3 space-y-1">
          {rules.map((r) => (
            <li key={`${r.rule}/${r.priority}`} className="flex items-center gap-2 rounded-md border border-edge-subtle bg-surface-sunken/40 px-2 py-1.5 text-[11px]">
              <StatusBadge kind={FALCO_CRIT.has(r.priority) ? 'failed' : FALCO_WARN.has(r.priority) ? 'degraded' : 'progressing'}>{r.priority}</StatusBadge>
              <span className="min-w-0 flex-1 truncate font-medium text-content">{r.rule}</span>
              <span className="font-mono tabular-nums text-content-muted">{fmtCount(r.n)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <PanelEmpty message="No rule fired in the last 24 hours." />
      )}
    </PanelCard>
  )
}

/* ═════════════════════ Runtime enforcement · Tetragon (new) ═════════════════════ */

export function TetragonPanel() {
  const q = useTetragonMetrics()
  const agents = scalar(q.data?.agents)
  const states = byLabel(q.data?.policies, 'state')
  const enabled = states.get('enabled') ?? 0
  const broken = (states.get('error') ?? 0) + (states.get('load_error') ?? 0)
  const ev = byLabel(q.data?.eventsByType, 'type')
  const hits = (q.data?.topPolicyHits ?? []).map((s) => ({
    policy: s.labels.policy ?? '—',
    target: [s.labels.namespace, s.labels.workload].filter(Boolean).join('/') || '—',
    n: s.value,
  }))
  const head = <PanelHead title="Runtime enforcement" subtitle={`Tetragon eBPF · last 24h${fin(agents) ? ` · ${agents} agents` : ''}`} to="/platform" />
  const blocked = gate(q, !fin(agents), 'Tetragon is not reporting. Install the Tetragon DaemonSet to observe and enforce process and file activity.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Policies" value={enabled} tone="brand" />
        <Stat label="Failed load" value={broken} tone={broken ? 'rose' : 'slate'} />
        <Stat label="Execs" value={fmtCount(ev.get('PROCESS_EXEC') ?? 0)} tone="violet" />
        <Stat label="Kprobe hits" value={fmtCount(ev.get('PROCESS_KPROBE') ?? 0)} tone={(ev.get('PROCESS_KPROBE') ?? 0) ? 'amber' : 'slate'} />
      </div>
      {hits.length ? (
        <ul className="mt-3 space-y-1">
          {hits.map((h) => (
            <li key={`${h.policy}/${h.target}`} className="flex items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1.5 text-[11px]">
              <span className="truncate font-mono text-content">{h.policy}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[10px] text-content-subtle">{h.target}</span>
              <span className="font-mono tabular-nums text-amber-700 dark:text-amber-300">{fmtCount(h.n)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <PanelEmpty message="No TracingPolicy matched a workload in the last 24 hours." />
      )}
    </PanelCard>
  )
}

/* ═════════════════════ Latency distribution (Hubble histogram) ═════════════════════ */

export function LatencyDistributionPanel() {
  const q = useHubbleLatencyBuckets()
  const t = useHubbleTraffic()
  const bars = useMemo(() => {
    const cum = (q.data?.buckets ?? [])
      .map((s) => ({ le: s.labels.le === '+Inf' ? Infinity : Number(s.labels.le), n: s.value }))
      .filter((b) => !Number.isNaN(b.le))
      .sort((a, b) => a.le - b.le)
    return cum.map((b, i) => ({
      label: b.le === Infinity ? `>${fmtMs((cum[i - 1]?.le ?? 0) * 1000)}` : `≤${fmtMs(b.le * 1000)}`,
      n: Math.max(0, b.n - (cum[i - 1]?.n ?? 0)),
    }))
  }, [q.data])
  const totalReq = bars.reduce((a, b) => a + b.n, 0)
  const head = <PanelHead title="Latency distribution" subtitle="HTTP via Hubble · last hour" to="/discover?section=metrics" />
  const blocked = gate(q, totalReq === 0, `No L7 requests in the last hour. ${HUBBLE_L7_HINT}`)
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const max = Math.max(...bars.map((b) => b.n))
  return (
    <PanelCard>
      {head}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="p50" value={fmtMs(scalar(t.data?.p50))} tone="emerald" />
        <Stat label="p95" value={fmtMs(scalar(t.data?.p95))} tone="amber" />
        <Stat label="p99" value={fmtMs(scalar(t.data?.p99))} tone="rose" />
      </div>
      <ul className="flex-1 space-y-1.5">
        {bars.filter((b) => b.n > 0).map((b) => (
          <li key={b.label} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-2 text-[11px]">
            <span className="font-mono text-content-muted">{b.label}</span>
            <Bar value={b.n} max={max} tone="violet" />
            <span className="text-right font-mono tabular-nums text-content-muted">{((b.n / totalReq) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ═════════════════════ Traffic stream (status classes over time) ═════════════════════ */

const CLASS_COLOR: Record<string, string> = {
  '2xx': 'var(--color-emerald-500)',
  '3xx': 'var(--color-sky-500)',
  '4xx': 'var(--color-amber-500)',
  '5xx': 'var(--color-rose-500)',
  '1xx': 'var(--color-violet-500)',
}

export function TrafficStreamPanel() {
  const q = useHubbleTrafficStream()
  const series = useMemo(
    () =>
      (q.data ?? [])
        .map((s) => ({
          cls: s.metric.class ?? '?',
          points: s.values.map(([t, v]) => ({ t: t * 1000, v: Number(v) || 0 })),
        }))
        .filter((s) => s.points.some((p) => p.v > 0))
        .sort((a, b) => a.cls.localeCompare(b.cls)),
    [q.data],
  )
  const head = <PanelHead title="Traffic stream" subtitle="HTTP responses by status · Hubble · 1h" to="/discover?section=metrics" />
  const blocked = gate(q, series.length === 0, `No L7 responses in the last hour. ${HUBBLE_L7_HINT}`)
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <div className="space-y-2">
        {series.map((s) => {
          const lastV = s.points[s.points.length - 1]?.v ?? 0
          return (
            <div key={s.cls}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="font-mono font-semibold" style={{ color: CLASS_COLOR[s.cls] }}>{s.cls}</span>
                <span className="font-mono tabular-nums text-content-muted">{fmtRate(lastV)}</span>
              </div>
              <AreaChart points={s.points} color={CLASS_COLOR[s.cls] ?? 'var(--color-brand-500)'} height={36} showAxis={false} />
            </div>
          )
        })}
      </div>
    </PanelCard>
  )
}

/* ═════════════════════ Service health grid (workload readiness) ═════════════════════ */

export function ServiceHealthGridPanel() {
  const { deployments } = useClusterSignals()
  const cells = useMemo(
    () =>
      (deployments.data ?? [])
        .map((d) => {
          const want = d.spec.replicas ?? 0
          const ready = d.status.readyReplicas ?? 0
          const state = want === 0 ? 'idle' : ready >= want ? 'ok' : ready === 0 ? 'down' : 'partial'
          return { key: `${d.metadata.namespace}/${d.metadata.name}`, name: d.metadata.name, ns: d.metadata.namespace ?? '', want, ready, state }
        })
        .sort((a, b) => {
          const rank = { down: 0, partial: 1, ok: 2, idle: 3 } as const
          return rank[a.state as keyof typeof rank] - rank[b.state as keyof typeof rank] || a.name.localeCompare(b.name)
        }),
    [deployments.data],
  )
  const head = <PanelHead title="Service health grid" subtitle="Every Deployment · ready vs desired replicas" to="/platform?section=deployments" />
  const blocked = gate(deployments, cells.length === 0, 'No Deployments in the cluster.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const count = (s: string) => cells.filter((c) => c.state === s).length
  const tone = { ok: 'bg-emerald-500', partial: 'bg-amber-500', down: 'bg-rose-500', idle: 'bg-surface-sunken ring-1 ring-inset ring-edge-default' } as const
  return (
    <PanelCard>
      {head}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-content-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />{count('ok')} healthy</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500" />{count('partial')} degraded</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-500" />{count('down')} down</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-surface-sunken ring-1 ring-inset ring-edge-default" />{count('idle')} scaled to 0</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14px,1fr))] gap-1">
        {cells.map((c) => (
          <span
            key={c.key}
            title={`${c.key} · ${c.ready}/${c.want} ready`}
            className={cn('aspect-square rounded-[3px]', tone[c.state as keyof typeof tone])}
          />
        ))}
      </div>
    </PanelCard>
  )
}

/* ═════════════════════ Delivery flow · Gitea ═════════════════════ */

export function EngineeringVelocityPanel() {
  const q = useGiteaFlow(30)
  const f = q.data
  const head = <PanelHead title="Engineering velocity" subtitle="Gitea · last 30 days" to="/develop?section=prs" />
  const blocked = gate(q, !f || (f.merged.length === 0 && f.commits.length === 0), 'No merged pull requests or commits in the last 30 days.')
  if (blocked || !f) return <PanelCard>{head}{blocked}</PanelCard>
  const cycle = median(f.merged.map((p) => Date.parse(p.merged_at ?? '') - Date.parse(p.created_at)).filter((n) => n >= 0))
  const authors = new Set(f.commits.map((c) => c.author.login)).size
  const closedTotal = f.merged.length + f.closedUnmerged
  return (
    <PanelCard>
      {head}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="PRs merged" value={f.merged.length} tone="brand" />
        <Stat label="Median cycle" value={fmtDuration(cycle)} tone={cycle != null && cycle > 3 * 86_400_000 ? 'amber' : 'emerald'} />
        <Stat label="Commits / wk" value={(f.commits.length / (30 / 7)).toFixed(1)} tone="violet" />
        <Stat label="Contributors" value={authors} tone="slate" />
      </div>
      <div className="mt-3 text-[11px] text-content-muted">
        {closedTotal ? (
          <>
            Merge rate <span className="font-mono text-content">{Math.round((f.merged.length / closedTotal) * 100)}%</span> of {closedTotal} closed PRs ·{' '}
          </>
        ) : (
          'No pull requests closed · '
        )}
        {f.repos} repositories
      </div>
    </PanelCard>
  )
}

export function PrThroughputPanel() {
  const q = useGiteaFlow(56)
  const weeks = useMemo(() => {
    const now = Date.now()
    const buckets = Array.from({ length: 8 }, (_, i) => ({ start: now - (8 - i) * 7 * 86_400_000, n: 0, cycle: [] as number[] }))
    for (const p of q.data?.merged ?? []) {
      const t = Date.parse(p.merged_at ?? '')
      const b = buckets.findLast((x) => t >= x.start)
      if (b) {
        b.n++
        b.cycle.push(t - Date.parse(p.created_at))
      }
    }
    return buckets
  }, [q.data])
  const head = <PanelHead title="PR throughput" subtitle="Merged per week · Gitea · 8 weeks" to="/develop?section=prs" />
  const totalMerged = weeks.reduce((a, w) => a + w.n, 0)
  const blocked = gate(q, totalMerged === 0, 'No pull requests merged in the last 8 weeks.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const max = Math.max(...weeks.map((w) => w.n))
  return (
    <PanelCard>
      {head}
      <div className="flex h-24 items-end gap-1.5">
        {weeks.map((w, i) => (
          <div key={w.start} className="flex flex-1 flex-col items-center gap-1" title={`${w.n} merged · median cycle ${fmtDuration(median(w.cycle))}`}>
            <span className="font-mono text-[10px] tabular-nums text-content-muted">{w.n || ''}</span>
            <div className={cn('w-full rounded-t', i === weeks.length - 1 ? 'bg-brand-500' : 'bg-brand-300 dark:bg-brand-500/50')} style={{ height: `${max ? Math.max(4, (w.n / max) * 64) : 4}px` }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-content-subtle">
        <span>8 wks ago</span>
        <span>this week</span>
      </div>
      <div className="mt-2 text-[11px] text-content-muted">
        {totalMerged} merged · median cycle time{' '}
        <span className="font-mono text-content">{fmtDuration(median(weeks.flatMap((w) => w.cycle)))}</span>
      </div>
    </PanelCard>
  )
}

export function TeamActivityPanel() {
  const q = useGiteaFlow(30)
  const rows = useMemo(() => {
    const m = new Map<string, { commits: number; repos: Set<string> }>()
    for (const c of q.data?.commits ?? []) {
      const r = m.get(c.author.login) ?? { commits: 0, repos: new Set<string>() }
      r.commits++
      r.repos.add(c.repo)
      m.set(c.author.login, r)
    }
    return [...m.entries()].map(([who, r]) => ({ who, commits: r.commits, repos: r.repos.size })).sort((a, b) => b.commits - a.commits)
  }, [q.data])
  const head = <PanelHead title="Team activity" subtitle="Commits by author · Gitea · 30 days" to="/develop?section=commits" />
  const blocked = gate(q, rows.length === 0, 'No commits in the last 30 days.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const max = rows[0]?.commits ?? 1
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-2">
        {rows.slice(0, 7).map((r) => (
          <li key={r.who}>
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate font-medium text-content">{r.who}</span>
              <span className="font-mono tabular-nums text-content-muted">
                {r.commits} · {r.repos} repo{r.repos === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-1"><Bar value={r.commits} max={max} tone="sky" /></div>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ═════════════════════ CI · Tekton PipelineRuns ═════════════════════ */

interface RunRow {
  pipeline: string
  ns: string
  state: 'succeeded' | 'failed' | 'running' | 'cancelled'
  startMs: number
  durationMs: number | null
  trigger: string | null
}

function toRuns(items: Generic[] | undefined): RunRow[] {
  return (items ?? []).map((r) => {
    const status = (r.status ?? {}) as { conditions?: Array<{ type?: string; status?: string; reason?: string }>; startTime?: string; completionTime?: string }
    const cond = status.conditions?.find((c) => c.type === 'Succeeded')
    const reason = cond?.reason ?? ''
    const state: RunRow['state'] =
      cond?.status === 'True' ? 'succeeded' : cond?.status === 'False' ? (/cancel/i.test(reason) ? 'cancelled' : 'failed') : 'running'
    const start = Date.parse(status.startTime ?? r.metadata.creationTimestamp ?? '')
    const end = Date.parse(status.completionTime ?? '')
    const labels = r.metadata.labels ?? {}
    const specRef = ((r.spec ?? {}) as { pipelineRef?: { name?: string } }).pipelineRef?.name
    return {
      pipeline: labels['tekton.dev/pipeline'] ?? specRef ?? r.metadata.name,
      ns: r.metadata.namespace ?? '',
      state,
      startMs: Number.isFinite(start) ? start : 0,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
      trigger: labels['triggers.tekton.dev/eventlistener'] ?? null,
    }
  })
}

export function BuildRuntimePanel() {
  const q = usePipelineRuns()
  const rows = useMemo(() => {
    const m = new Map<string, { durations: number[]; last: RunRow }>()
    for (const r of toRuns(q.data as Generic[] | undefined)) {
      const e = m.get(r.pipeline) ?? { durations: [], last: r }
      if (r.state === 'succeeded' && r.durationMs != null) e.durations.push(r.durationMs)
      if (r.startMs >= e.last.startMs) e.last = r
      m.set(r.pipeline, e)
    }
    return [...m.entries()]
      .map(([pipeline, e]) => ({ pipeline, p50: median(e.durations), runs: e.durations.length, last: e.last }))
      .sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0))
  }, [q.data])
  const head = <PanelHead title="CI build duration" subtitle="Tekton · median of successful runs" to="/develop?section=pipelines" />
  const blocked = gate(q, rows.length === 0, 'No Tekton PipelineRuns yet.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const max = Math.max(1, ...rows.map((r) => r.p50 ?? 0))
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-2.5">
        {rows.slice(0, 6).map((r) => (
          <li key={r.pipeline}>
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 flex-none rounded-full', r.last.state === 'succeeded' ? 'bg-emerald-500' : r.last.state === 'running' ? 'bg-sky-500' : 'bg-rose-500')} title={`Last run ${r.last.state}`} />
                <span className="truncate font-mono font-medium text-content">{r.pipeline}</span>
              </span>
              <span className="font-mono tabular-nums text-content-muted">{fmtDuration(r.p50)} · {r.runs} ok</span>
            </div>
            <div className="mt-1"><Bar value={r.p50 ?? 0} max={max} tone="violet" /></div>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

export function PipelineSuccessTrendPanel() {
  const q = usePipelineRuns()
  const days = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const out = Array.from({ length: 14 }, (_, i) => ({ start: today.getTime() - (13 - i) * 86_400_000, ok: 0, failed: 0 }))
    for (const r of toRuns(q.data as Generic[] | undefined)) {
      if (r.state !== 'succeeded' && r.state !== 'failed') continue
      const d = out.findLast((x) => r.startMs >= x.start)
      if (d) d[r.state === 'succeeded' ? 'ok' : 'failed']++
    }
    return out
  }, [q.data])
  const ok = days.reduce((a, d) => a + d.ok, 0)
  const failed = days.reduce((a, d) => a + d.failed, 0)
  const head = <PanelHead title="Pipeline success" subtitle="Tekton PipelineRuns · 14 days" to="/develop?section=pipelines" />
  const blocked = gate(q, ok + failed === 0, 'No finished PipelineRuns in the last 14 days.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  const rate = (ok / (ok + failed)) * 100
  const max = Math.max(1, ...days.map((d) => d.ok + d.failed))
  return (
    <PanelCard>
      {head}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Success" value={fmtPct(rate, 0)} tone={rate >= 90 ? 'emerald' : rate >= 70 ? 'amber' : 'rose'} />
        <Stat label="Passed" value={ok} tone="emerald" />
        <Stat label="Failed" value={failed} tone={failed ? 'rose' : 'slate'} />
      </div>
      <div className="flex h-16 items-end gap-1">
        {days.map((d) => (
          <div key={d.start} className="flex flex-1 flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${Math.max(2, ((d.ok + d.failed) / max) * 64)}px` }} title={`${new Date(d.start).toLocaleDateString()} · ${d.ok} passed, ${d.failed} failed`}>
            <div className="bg-emerald-500" style={{ flex: d.ok }} />
            <div className="bg-rose-500" style={{ flex: d.failed }} />
            {d.ok + d.failed === 0 ? <div className="flex-1 bg-surface-sunken" /> : null}
          </div>
        ))}
      </div>
    </PanelCard>
  )
}

export function WorkflowTriggersPanel() {
  const els = useEventListeners()
  const runs = usePipelineRuns()
  const rows = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000
    const fired = new Map<string, number>()
    for (const r of toRuns(runs.data as Generic[] | undefined)) {
      if (r.trigger && r.startMs >= weekAgo) fired.set(r.trigger, (fired.get(r.trigger) ?? 0) + 1)
    }
    return ((els.data ?? []) as Generic[]).map((el) => {
      const spec = (el.spec ?? {}) as { triggers?: Array<{ name?: string; template?: { ref?: string } }> }
      const status = (el.status ?? {}) as { conditions?: Array<{ type?: string; status?: string }>; address?: { url?: string } }
      const ready = status.conditions?.find((c) => c.type === 'Ready')?.status === 'True'
      return {
        name: el.metadata.name,
        ns: el.metadata.namespace ?? '',
        triggers: spec.triggers?.length ?? 0,
        templates: [...new Set((spec.triggers ?? []).map((t) => t.template?.ref).filter(Boolean))] as string[],
        ready,
        fired: fired.get(el.metadata.name) ?? 0,
      }
    })
  }, [els.data, runs.data])
  const head = <PanelHead title="Pipeline triggers" subtitle="Tekton EventListeners · runs fired in 7 days" to="/develop?section=pipelines" />
  const blocked = gate(els, rows.length === 0, 'No Tekton EventListeners. Webhook-driven CI needs Tekton Triggers.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-1.5">
        {rows.map((r) => (
          <li key={`${r.ns}/${r.name}`} className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-2.5 py-2 text-[11px]">
            <div className="flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 flex-none rounded-full', r.ready ? 'bg-emerald-500' : 'bg-rose-500')} title={r.ready ? 'Ready' : 'Not ready'} />
              <span className="truncate font-mono font-medium text-content">{r.name}</span>
              <span className="ml-auto font-mono tabular-nums text-content-muted">{r.fired} run{r.fired === 1 ? '' : 's'}</span>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-content-subtle">
              {r.triggers} trigger{r.triggers === 1 ? '' : 's'}{r.templates.length ? ` → ${r.templates.join(', ')}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ═════════════════════ Data services ═════════════════════ */

export function CachePerformancePanel() {
  const q = useRedisMetrics()
  const rows = useMemo(() => {
    const k = (l: Record<string, string>) => `${l.namespace ?? ''}/${l.service ?? ''}`
    const ops = keyed(q.data?.ops, k)
    const hits = keyed(q.data?.hits, k)
    const misses = keyed(q.data?.misses, k)
    const used = keyed(q.data?.memUsed, k)
    const maxB = keyed(q.data?.memMax, k)
    const clients = keyed(q.data?.clients, k)
    const evicted = keyed(q.data?.evicted, k)
    return [...used.keys()].map((key) => {
      const h = hits.get(key) ?? 0
      const m = misses.get(key) ?? 0
      return {
        key,
        name: key.split('/').pop() || key,
        ops: ops.get(key) ?? 0,
        hitRatio: h + m > 0 ? (h / (h + m)) * 100 : null,
        used: used.get(key) ?? 0,
        max: maxB.get(key) || null,
        clients: clients.get(key) ?? 0,
        evicted: evicted.get(key) ?? 0,
      }
    })
  }, [q.data])
  const head = <PanelHead title="Cache performance" subtitle="Valkey / Redis · redis_exporter" to="/platform" />
  const blocked = gate(q, rows.length === 0, 'No cache exporter is reporting. Caches need redis_exporter scraped by Prometheus.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-2">
        {rows.map((r) => (
          <li key={r.key} className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="truncate font-mono font-medium text-content">{r.name}</span>
              <span className="font-mono tabular-nums text-content-muted">{fmtRate(r.ops)} ops</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
              <div><div className="text-[10px] uppercase tracking-wider text-content-subtle">Hit ratio</div><div className={cn('font-mono tabular-nums', r.hitRatio == null ? 'text-content-muted' : r.hitRatio >= 90 ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>{r.hitRatio == null ? 'no reads' : fmtPct(r.hitRatio, 1)}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-content-subtle">Memory</div><div className="font-mono tabular-nums text-content">{fmtBytes(r.used)}{r.max ? ` / ${fmtBytes(r.max)}` : ''}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-content-subtle">Clients</div><div className="font-mono tabular-nums text-content">{r.clients}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-content-subtle">Evicted 1h</div><div className={cn('font-mono tabular-nums', r.evicted ? 'text-amber-700 dark:text-amber-300' : 'text-content')}>{fmtCount(r.evicted)}</div></div>
            </div>
            {!r.max ? <div className="mt-1.5 text-[10px] text-content-subtle">No maxmemory limit set — eviction policy never triggers.</div> : null}
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

export function DatabasePoolPanel() {
  const q = useCnpgPoolMetrics()
  const rows = useMemo(() => {
    const k = (l: Record<string, string>) => l.job ?? ''
    const backends = keyed(q.data?.backends, k)
    const maxC = keyed(q.data?.maxConnections, k)
    const waiting = keyed(q.data?.waiting, k)
    const lag = keyed(q.data?.lagSeconds, k)
    const replicas = keyed(q.data?.replicas, k)
    const longest = keyed(q.data?.longestTx, k)
    return (q.data?.backends ?? [])
      .map((s) => {
        const key = k(s.labels)
        const used = backends.get(key) ?? 0
        const cap = maxC.get(key) ?? 0
        return {
          key,
          name: cnpgCluster(s.labels),
          used,
          cap,
          ratio: cap ? (used / cap) * 100 : 0,
          waiting: waiting.get(key) ?? 0,
          lag: lag.get(key) ?? 0,
          replicas: replicas.get(key) ?? 0,
          longest: longest.get(key) ?? 0,
        }
      })
      .sort((a, b) => b.ratio - a.ratio)
  }, [q.data])
  const head = <PanelHead title="Database connections" subtitle="CloudNativePG · backends vs max_connections" to="/platform" />
  const blocked = gate(q, rows.length === 0, 'No CloudNativePG cluster is exporting metrics.')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-2.5 overflow-y-auto">
        {rows.map((r) => {
          const tone = r.ratio >= 85 ? 'rose' : r.ratio >= 60 ? 'amber' : 'emerald'
          return (
            <li key={r.key}>
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate font-mono font-medium text-content">{r.name}</span>
                <span className="font-mono tabular-nums text-content-muted">
                  {r.used}/{r.cap}
                  {r.waiting ? <span className="ml-1.5 text-amber-700 dark:text-amber-300">{r.waiting} waiting</span> : null}
                  {r.replicas ? <span className="ml-1.5" title="Streaming replicas · replication lag">{r.replicas}× · {r.lag.toFixed(1)}s lag</span> : null}
                </span>
              </div>
              <div className="mt-1"><Bar value={r.used} max={r.cap || 1} tone={tone} /></div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

export function QueueDepthPanel() {
  const kafkas = useKafkas()
  const topics = useKafkaTopics()
  const topicList = (topics.data ?? []) as Generic[]
  const head = <PanelHead title="Queue depth" subtitle="Kafka (Strimzi) · consumer lag" to="/platform" />
  const blocked = gate(kafkas, false, '')
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  // Consumer lag only exists once Strimzi's Kafka Exporter is enabled on the
  // Kafka resource; until then the honest answer is the topic inventory.
  return (
    <PanelCard>
      {head}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Stat label="Kafka clusters" value={((kafkas.data ?? []) as Generic[]).length} tone="brand" />
        <Stat label="Topics" value={topicList.length} tone="violet" />
      </div>
      <PanelEmpty message="Consumer-group lag needs Strimzi's Kafka Exporter — set spec.kafkaExporter on the Kafka resource and scrape kafka_consumergroup_lag." />
    </PanelCard>
  )
}

/* ═════════════════════ Cilium · network & mesh ═════════════════════ */

export function CiliumNetworkFlowPanel() {
  const nsPolQ = useCiliumPolicies()
  const cwPolQ = useCiliumClusterPolicies()
  const h = useHubbleTraffic()
  const nsPolicies = (nsPolQ.data ?? []) as Generic[]
  const cwPolicies = (cwPolQ.data ?? []) as Generic[]
  const verdict = byLabel(h.data?.flowsByVerdict, 'verdict')
  const forwarded = verdict.get('FORWARDED') ?? 0
  const dropped = verdict.get('DROPPED') ?? 0
  const drops = (h.data?.dropsByReason ?? []).map((s) => ({ reason: s.labels.reason ?? '?', v: s.value }))
  const head = <PanelHead title="Cilium network flows" subtitle="Hubble flows · CiliumNetworkPolicy posture" to="/discover?section=servicemap" />
  const blocked = gate(nsPolQ, false, '')
  if (blocked) return <PanelCard>{head}{nsPolQ.isError ? <PanelEmpty message="Cilium (cilium.io) is not installed on this cluster." /> : blocked}</PanelCard>
  const flowTotal = forwarded + dropped
  return (
    <PanelCard>
      {head}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Flows" value={fmtRate(verdict.size ? flowTotal : null)} tone="brand" />
        <Stat label="Dropped" value={fmtRate(verdict.size ? dropped : null)} tone={dropped > 0.1 ? 'amber' : 'slate'} />
        <Stat label="Policies" value={nsPolicies.length} tone="violet" />
        <Stat label="Cluster-wide" value={cwPolicies.length} tone="emerald" />
      </div>
      {drops.length ? (
        <>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Drop reasons</div>
          <ul className="space-y-1.5">
            {drops.map((d) => (
              <li key={d.reason} className="grid grid-cols-[1fr_4rem] items-center gap-2 text-[11px]">
                <div>
                  <div className="truncate font-mono text-content">{d.reason.toLowerCase().replaceAll('_', ' ')}</div>
                  <div className="mt-0.5"><Bar value={d.v} max={drops[0].v} tone={d.reason === 'POLICY_DENIED' ? 'rose' : 'amber'} /></div>
                </div>
                <span className="text-right font-mono tabular-nums text-content-muted">{fmtRate(d.v)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <PanelEmpty message={h.isError ? 'Hubble metrics are not reachable in Prometheus.' : 'No dropped flows in the last 5 minutes.'} />
      )}
    </PanelCard>
  )
}

export function ServiceMeshTrafficPanel() {
  const q = useHubbleTraffic()
  const rps = scalar(q.data?.l7Rps)
  const cls = byLabel(q.data?.statusClass, 'class')
  const methods = [...byLabel(q.data?.methods, 'method').entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const totalResp = [...cls.values()].reduce((a, b) => a + b, 0)
  const head = <PanelHead title="Service mesh traffic" subtitle="Cilium L7 (Envoy) · Hubble · 5m rate" to="/discover?section=servicemap" />
  const blocked = gate(q, !fin(rps), `No L7 traffic observed. ${HUBBLE_L7_HINT}`)
  if (blocked) return <PanelCard>{head}{blocked}</PanelCard>
  return (
    <PanelCard>
      {head}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Requests" value={fmtRate(rps)} tone="brand" />
        <Stat label="p50" value={fmtMs(scalar(q.data?.p50))} tone="emerald" />
        <Stat label="p95" value={fmtMs(scalar(q.data?.p95))} tone="amber" />
        <Stat label="p99" value={fmtMs(scalar(q.data?.p99))} tone="rose" />
      </div>
      {totalResp > 0 ? (
        <>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Responses by status</div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            {['2xx', '3xx', '4xx', '5xx', '1xx'].map((c) => (cls.get(c) ?? 0) > 0 ? (
              <div key={c} style={{ width: `${((cls.get(c) ?? 0) / totalResp) * 100}%`, background: CLASS_COLOR[c] }} title={`${c} · ${fmtRate(cls.get(c) ?? 0)}`} />
            ) : null)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-content-muted">
            {['2xx', '3xx', '4xx', '5xx'].map((c) => (
              <span key={c}><span className="font-mono" style={{ color: CLASS_COLOR[c] }}>{c}</span> {(((cls.get(c) ?? 0) / totalResp) * 100).toFixed(1)}%</span>
            ))}
          </div>
        </>
      ) : null}
      {methods.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {methods.slice(0, 6).map(([m, v]) => (
            <span key={m} className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
              {m} <span className="text-content">{fmtRate(v)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </PanelCard>
  )
}

/**
 * Cilium's two encryption layers, read from where Cilium records them:
 * transparent encryption (WireGuard or IPsec) shows on every CiliumNode — a
 * WireGuard public-key annotation or a non-zero IPsec key index — and mutual
 * authentication (SPIFFE identities issued by SPIRE) is a Cilium feature gauge.
 * Policy coverage is how many endpoints have ingress/egress enforcement on.
 */
export function MeshSecurityPanel() {
  const nodesQ = useCiliumNodes()
  const m = useMeshSecurityMetrics()
  const nodes = (nodesQ.data ?? []) as Generic[]
  const wg = nodes.filter((n) => !!n.metadata.annotations?.['network.cilium.io/wg-pub-key']).length
  const ipsec = nodes.filter((n) => Number(((n.spec ?? {}) as { encryption?: { key?: number } }).encryption?.key ?? 0) > 0).length
  const encrypted = Math.max(wg, ipsec)
  const mode = wg ? 'WireGuard' : ipsec ? 'IPsec' : null
  const mutualAuth = scalar(m.data?.mutualAuth)
  const enf = byLabel(m.data?.enforcement, 'enforcement')
  const enforced = (enf.get('both') ?? 0) + (enf.get('ingress') ?? 0) + (enf.get('egress') ?? 0)
  const audit = (enf.get('audit-both') ?? 0) + (enf.get('audit-ingress') ?? 0) + (enf.get('audit-egress') ?? 0)
  const open = enf.get('none') ?? 0
  const endpoints = enforced + audit + open
  const policyDrops = scalar(m.data?.policyDrops)
  const head = <PanelHead title="Mesh security" subtitle="Cilium · encryption, identity, policy enforcement" to="/platform" />
  if (nodesQ.isLoading) return <PanelCard>{head}<PanelLoading /></PanelCard>
  if (nodesQ.isError) return <PanelCard>{head}<PanelEmpty message="Cilium (cilium.io) is not installed on this cluster." /></PanelCard>
  const row = (label: string, ok: boolean | null, value: string, note: string) => (
    <li className="flex items-start gap-2 rounded-md border border-edge-subtle bg-surface-sunken/40 px-2.5 py-2 text-[11px]">
      <span className={cn('mt-1 h-2 w-2 flex-none rounded-full', ok == null ? 'bg-slate-400' : ok ? 'bg-emerald-500' : 'bg-amber-500')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-content">{label}</span>
          <span className={cn('font-mono tabular-nums', ok ? 'text-emerald-700 dark:text-emerald-300' : ok === false ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted')}>{value}</span>
        </div>
        <div className="mt-0.5 text-[10px] leading-relaxed text-content-subtle">{note}</div>
      </div>
    </li>
  )
  return (
    <PanelCard>
      {head}
      <ul className="flex-1 space-y-1.5">
        {row(
          'Transparent encryption',
          nodes.length ? encrypted === nodes.length : null,
          mode ? `${mode} · ${encrypted}/${nodes.length} nodes` : `off · 0/${nodes.length} nodes`,
          mode ? 'Pod-to-pod traffic is encrypted between nodes.' : 'Pod traffic crosses nodes in clear text. Enable encryption.enabled with type wireguard in the Cilium values.',
        )}
        {row(
          'Mutual authentication',
          mutualAuth == null ? null : mutualAuth > 0,
          mutualAuth == null ? 'unknown' : mutualAuth > 0 ? 'on' : 'off',
          mutualAuth == null
            ? 'Cilium agent metrics are not in Prometheus.'
            : mutualAuth > 0
              ? 'Workloads prove SPIFFE identity (SPIRE) before policy allows traffic.'
              : 'No SPIFFE identity check. Enable authentication.mutual.spire and require it in policies.',
        )}
        {row(
          'Policy enforcement',
          endpoints ? open === 0 : null,
          endpoints ? `${enforced}/${endpoints} endpoints` : '—',
          endpoints
            ? `${open} endpoint${open === 1 ? '' : 's'} allow all traffic${audit ? `, ${audit} in audit mode` : ''}${fin(policyDrops) && policyDrops > 0 ? ` · ${fmtRate(policyDrops)} denied` : ''}.`
            : 'Endpoint enforcement metrics are not available.',
        )}
      </ul>
    </PanelCard>
  )
}

/* ═════════════════════ Gateway API routes ═════════════════════ */

export function GatewayRoutesPanel() {
  const routesQ = useHttpRoutes()
  const gwQ = useGateways()
  const routes = (routesQ.data ?? []) as Generic[]
  const gateways = (gwQ.data ?? []) as Generic[]
  const rows = useMemo(
    () =>
      routes.map((r) => {
        const spec = (r.spec ?? {}) as { hostnames?: string[]; parentRefs?: Array<{ name?: string }>; rules?: unknown[] }
        const status = (r.status ?? {}) as { parents?: Array<{ conditions?: Array<{ type?: string; status?: string }> }> }
        const accepted = (status.parents ?? []).every((p) => p.conditions?.find((c) => c.type === 'Accepted')?.status === 'True') && (status.parents ?? []).length > 0
        const resolved = (status.parents ?? []).every((p) => p.conditions?.find((c) => c.type === 'ResolvedRefs')?.status !== 'False')
        return {
          key: `${r.metadata.namespace}/${r.metadata.name}`,
          host: spec.hostnames?.[0] ?? '*',
          extraHosts: Math.max(0, (spec.hostnames?.length ?? 0) - 1),
          gateway: spec.parentRefs?.[0]?.name ?? '—',
          ok: accepted && resolved,
          created: r.metadata.creationTimestamp,
        }
      }).sort((a, b) => Number(a.ok) - Number(b.ok) || a.host.localeCompare(b.host)),
    [routes],
  )
  const head = <PanelHead title="Gateway routes" subtitle="Gateway API · HTTPRoutes on Cilium" to="/platform?section=gateway" />
  const blocked = gate(routesQ, rows.length === 0, 'No HTTPRoutes. Services are exposed through Gateway API HTTPRoutes.')
  if (blocked) return <PanelCard>{head}{routesQ.isError ? <PanelEmpty message="Gateway API (gateway.networking.k8s.io) is not installed." /> : blocked}</PanelCard>
  const failing = rows.filter((r) => !r.ok).length
  return (
    <PanelCard>
      {head}
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Routes" value={rows.length} tone="brand" />
        <Stat label="Not accepted" value={failing} tone={failing ? 'rose' : 'emerald'} />
        <Stat label="Gateways" value={gateways.length} tone="violet" />
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto">
        {rows.slice(0, 8).map((r) => (
          <li key={r.key} className="flex items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1.5 text-[11px]">
            <span className={cn('h-1.5 w-1.5 flex-none rounded-full', r.ok ? 'bg-emerald-500' : 'bg-rose-500')} title={r.ok ? 'Accepted' : 'Not accepted / unresolved refs'} />
            <span className="min-w-0 flex-1 truncate font-mono text-content">
              {r.host}
              {r.extraHosts ? <span className="text-content-subtle"> +{r.extraHosts}</span> : null}
            </span>
            <span className="flex-none text-[10px] text-content-subtle">{r.gateway}</span>
            {r.created ? <span className="hidden flex-none text-[10px] text-content-subtle sm:inline">{formatRelative(r.created)}</span> : null}
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

