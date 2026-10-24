import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Sparkline } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { lgtm } from '@adhar/api-clients'
import {
  DEFAULT_RANGE,
  TIME_RANGES,
  type TimeRangeId,
  useAlerts,
  useAnalyticsEvents,
  useSessions,
  useSlos,
} from '../data/observability.ts'
import {
  detectSources,
  errorHealth,
  type HttpSource,
  HTTP_SOURCES_V2,
  httpQueries,
  joinRed,
  lastOf,
  lokiSelector,
  pickSource,
  podHealthQueries,
  type RedRow,
  saturationQueries,
  type Scope,
  serviceBy,
  utilHealth,
  withResponsesResolved,
} from '../data/golden-signals.ts'
import { autoStep, promLabelValues, rangeMs, rateWindow, type RangeSeries, useInstantSet, useMetricNames, useRangeSet } from '../data/prom.ts'
import { deployEvents, shortRev, useArgoApps } from '../data/deploys.ts'
import { discoverHref, readParams, replaceParams } from '../data/discover-links.ts'
import { formatValue, type Unit } from '../data/promql-lite.ts'
import {
  type Annotation,
  DLink,
  HealthTag,
  IconRefresh,
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
import {
  CapacityWidget,
  type DashCtx,
  IngressWidget,
  LogErrorsWidget,
  needs,
  PodHealthWidget,
  TraceErrorsWidget,
  UseNodesWidget,
} from './dashboard-widgets.tsx'

/**
 * Discover Dashboard — golden signals, RED, USE and platform health in one
 * scrollable page.
 *
 * One filter row (time range · namespace · service · telemetry source ·
 * auto-refresh) scopes every widget, and its state lives in the URL so a
 * scoped view can be shared. Every widget links into the detail page with the
 * same context (Metrics with the widget's PromQL, Logs with a matching LogQL
 * selector, Traces filtered to the service, Alerts / SLOs filtered).
 *
 * All numbers come from the live Prometheus / Loki / Argo CD / Alertmanager /
 * PostHog backends. A widget whose exporter is missing says which one
 * ("needs kube-state-metrics") instead of drawing an empty chart that reads as
 * zero.
 */

const REFRESH_OPTIONS = [
  { value: '0', label: 'Auto-refresh off' },
  { value: '60', label: 'Every 1m' },
  { value: '300', label: 'Every 5m' },
  { value: '900', label: 'Every 15m' },
]

function isRange(v: string | undefined): v is TimeRangeId {
  return !!v && TIME_RANGES.some((r) => r.id === v)
}

export function Dashboard() {
  const boot = useMemo(readParams, [])
  const [range, setRange] = useState<TimeRangeId>(isRange(boot.range) ? boot.range : DEFAULT_RANGE)
  const [ns, setNs] = useState(boot.ns ?? '')
  const [svc, setSvc] = useState(boot.svc ?? '')
  const [srcId, setSrcId] = useState(boot.src ?? '')
  const [refresh, setRefresh] = useState(boot.refresh && REFRESH_OPTIONS.some((o) => o.value === boot.refresh) ? boot.refresh : '60')
  const qc = useQueryClient()

  useEffect(() => {
    replaceParams({ range: range === DEFAULT_RANGE ? null : range, ns, svc, src: srcId, refresh: refresh === '60' ? null : refresh })
  }, [range, ns, svc, srcId, refresh])

  const namesQ = useMetricNames()
  const names = useMemo(() => (namesQ.data ? new Set(namesQ.data) : undefined), [namesQ.data])
  const detected = useMemo(() => detectSources(namesQ.data ?? []), [namesQ.data])
  const src = useMemo(() => {
    const s = pickSource(detected, srcId)
    return s ? withResponsesResolved(s, namesQ.data ?? []) : null
  }, [detected, srcId, namesQ.data])

  const windowMs = rangeMs(range)
  const stepSec = autoStep(windowMs)
  const win = rateWindow(stepSec)
  const refreshMs = refresh === '0' ? false : Number(refresh) * 1000
  const scope: Scope = useMemo(() => ({ namespace: ns || null, service: svc || null }), [ns, svc])

  const apps = useArgoApps()
  const deploys = useMemo(() => deployEvents(apps.data ?? [], Date.now() - windowMs, ns || null), [apps.data, windowMs, ns])
  const annotations: Annotation[] = useMemo(
    () => deploys.map((d) => ({ t: d.t, label: d.app, detail: [shortRev(d.revision), d.phase !== 'Succeeded' ? d.phase : ''].filter(Boolean).join(' · ') })),
    [deploys],
  )

  const nsList = useQuery({
    queryKey: ['prom', 'namespaces', names?.has('kube_pod_info')],
    queryFn: () => promLabelValues('namespace', names?.has('kube_pod_info') ? 'kube_pod_info' : 'container_cpu_usage_seconds_total'),
    enabled: !!names,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const svcList = useQuery({
    queryKey: ['prom', 'services', src?.id, ns],
    queryFn: () =>
      promLabelValues(
        src!.serviceLabel,
        ns && src!.namespaceLabel ? `${src!.requests}{${src!.namespaceLabel}="${ns}"}` : src!.requests,
      ),
    enabled: !!src,
    staleTime: 2 * 60_000,
    retry: false,
  })

  const ctx: DashCtx = { range, windowMs, stepSec, win, scope, names, refreshMs, deploys: annotations }

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['prom'] })
    void qc.invalidateQueries({ queryKey: ['lgtm'] })
    void qc.invalidateQueries({ queryKey: ['discover'] })
  }

  return (
    <div className="space-y-5">
      <VizStyle />
      {/* Filters — one row above every chart. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
        <Segmented value={range} onChange={setRange} ariaLabel="Time range" options={TIME_RANGES.map((r) => ({ id: r.id, label: r.label }))} />
        <MiniSelect
          ariaLabel="Namespace"
          value={ns}
          onChange={(v) => {
            setNs(v)
            setSvc('')
          }}
          options={[{ value: '', label: 'All namespaces' }, ...(nsList.data ?? []).map((n) => ({ value: n, label: n })), ...(ns && !(nsList.data ?? []).includes(ns) ? [{ value: ns, label: ns }] : [])]}
        />
        <MiniSelect
          ariaLabel="Service"
          value={svc}
          onChange={setSvc}
          options={[
            { value: '', label: src ? 'All services' : 'Services (no HTTP source)' },
            ...(svcList.data ?? []).filter(Boolean).map((n) => ({ value: n, label: n })),
            ...(svc && !(svcList.data ?? []).includes(svc) ? [{ value: svc, label: svc }] : []),
          ]}
        />
        {detected.length > 1 ? (
          <MiniSelect
            ariaLabel="Request-metrics source"
            value={src?.id ?? ''}
            onChange={(v) => {
              setSrcId(v)
              setSvc('')
            }}
            options={detected.map((s) => ({ value: s.id, label: s.label }))}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <MiniSelect ariaLabel="Auto-refresh" value={refresh} onChange={setRefresh} options={REFRESH_OPTIONS} />
          <Button size="sm" onClick={refreshAll} leading={<IconRefresh />} aria-label="Refresh now">
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      <SourceLine names={namesQ} src={src} detected={detected} deploys={deploys.length} argoError={apps.isError} />

      <KpiStrip ctx={ctx} src={src} deploysState={apps.isLoading ? 'loading' : apps.isError ? 'error' : 'ok'} />

      <GoldenSignals ctx={ctx} src={src} />

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <RedWidget ctx={ctx} src={src} className="xl:col-span-2" onPickService={(s, n) => {
          if (n && src?.namespaceLabel) setNs(n)
          setSvc(s)
        }} />
        <TopServicesWidget ctx={ctx} src={src} />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <UseNodesWidget ctx={ctx} />
        </div>
        <CapacityWidget ctx={ctx} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PodHealthWidget ctx={ctx} />
        <IngressWidget ctx={ctx} />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <AlertsWidget ctx={ctx} />
        <SloWidget ctx={ctx} />
        <DeploysWidget ctx={ctx} deploys={deploys} loading={apps.isLoading} error={apps.error} />
      </section>

      <ProductPulse />
    </div>
  )
}

/* ─────────────────────────── source line ─────────────────────────── */

function SourceLine({
  names,
  src,
  detected,
  deploys,
  argoError,
}: {
  names: { isLoading: boolean; isError: boolean; error: unknown }
  src: HttpSource | null
  detected: HttpSource[]
  deploys: number
  argoError: boolean
}) {
  if (names.isLoading) return null
  if (names.isError) {
    return (
      <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
        <span className="font-semibold">Prometheus is not reachable.</span> Metric widgets below cannot load —{' '}
        {names.error instanceof Error ? names.error.message : 'unknown error'}.
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted">
      <span className="text-content-subtle">Request metrics</span>
      {src ? (
        <span title={src.hint} className="rounded bg-surface-sunken px-1.5 py-0.5 font-medium text-content">
          {src.label}
          {detected.length > 1 ? <span className="text-content-subtle"> · {detected.length - 1} more available</span> : null}
        </span>
      ) : (
        <span className="text-amber-700 dark:text-amber-300">none scraped — latency, traffic and error panels have no source</span>
      )}
      <span className="text-content-subtle">·</span>
      <span>
        <span className="mr-1 inline-block size-1.5 rotate-45 bg-content-muted align-middle" />
        {argoError ? 'Argo CD unreachable — no deploy markers' : `${deploys} Argo CD deploy${deploys === 1 ? '' : 's'} in range`}
      </span>
    </div>
  )
}

/* ─────────────────────────── KPI strip ─────────────────────────── */

function Kpi({
  label,
  value,
  sub,
  href,
  trend,
  health,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  href: string
  trend?: number[]
  health?: Parameters<typeof HealthTag>[0]['health']
}) {
  return (
    <DLink href={href} className="group block min-w-0">
      <Card className="h-full transition-colors group-hover:border-brand-300 dark:group-hover:border-brand-500/40">
        <div className="space-y-0.5 p-3">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{label}</span>
            {health ? <HealthTag health={health} compact /> : null}
          </div>
          <div className="truncate text-xl font-semibold tabular-nums tracking-tight text-content">{value}</div>
          {sub ? <div className="truncate text-[11px] text-content-muted">{sub}</div> : null}
          {trend && trend.length > 1 ? (
            <div className="pt-0.5">
              <Sparkline points={trend} color="var(--viz-1)" height={18} strokeWidth={1.25} />
            </div>
          ) : null}
        </div>
      </Card>
    </DLink>
  )
}

function KpiStrip({ ctx, src, deploysState }: { ctx: DashCtx; src: HttpSource | null; deploysState: 'loading' | 'error' | 'ok' }) {
  const http = src ? httpQueries(src, ctx.scope, ctx.win) : null
  const sat = saturationQueries(ctx.scope, ctx.win)
  const r = useRangeSet(
    { rps: http?.rps ?? null, err: http?.errorPct ?? null, errRps: http?.errorRps ?? null, p50: http?.p50 ?? null, p95: http?.p95 ?? null, p99: http?.p99 ?? null, cpu: sat.cpuPct, mem: sat.memPct },
    { windowMs: ctx.windowMs, stepSec: ctx.stepSec, refreshMs: ctx.refreshMs },
  )
  const pods = useInstantSet(podHealthQueries(ctx.scope, ctx.range), { refreshMs: ctx.refreshMs })
  const alerts = useAlerts()
  const trend = (s?: RangeSeries[]) => s?.[0]?.points.map((p) => p[1])
  const v = (k: keyof typeof r) => lastOf(r[k].data)
  const firing = (alerts.data ?? []).filter((a) => a.state === 'firing' && alertInScope(a, ctx.scope))
  const crit = firing.filter((a) => a.severity === 'critical').length
  const ksmMissing = !!needs(ctx, ['kube-state-metrics'])
  const podIssues = !ksmMissing && (pods.crashloop?.data || pods.pending?.data || pods.oomKilled?.data)
    ? (pods.crashloop?.data?.length ?? 0) + (pods.pending?.data?.length ?? 0) + (pods.oomKilled?.data?.length ?? 0)
    : null
  const mh = (qs: Array<string | null | undefined>) => metricsLink(ctx, qs.filter(Boolean) as string[])
  const noSrc = 'no HTTP source'
  const lastDeploy = ctx.deploys[0]
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8" aria-label="Key signals">
      <Kpi label="Traffic" value={src ? formatValue(v('rps'), 'rps') : '—'} sub={src ? 'requests / second' : noSrc} href={mh([http?.rps])} trend={trend(r.rps.data)} />
      <Kpi
        label="Errors (5xx)"
        value={src ? formatValue(v('err'), 'percent') : '—'}
        sub={src ? `${formatValue(v('errRps'), 'rps')} failing` : noSrc}
        href={mh([http?.errorPct])}
        trend={trend(r.err.data)}
        health={src ? errorHealth(v('err')) : undefined}
      />
      <Kpi
        label="Latency p95"
        value={src ? formatValue(v('p95'), 'ms') : '—'}
        sub={src ? `p50 ${formatValue(v('p50'), 'ms')} · p99 ${formatValue(v('p99'), 'ms')}` : noSrc}
        href={mh([http?.p50, http?.p95, http?.p99])}
        trend={trend(r.p95.data)}
      />
      <Kpi label="CPU" value={formatValue(v('cpu'), 'percent')} sub={sat.exporter === 'node-exporter' ? 'node utilisation' : 'of cluster allocatable'} href={mh([sat.cpuPct])} trend={trend(r.cpu.data)} health={utilHealth(v('cpu'))} />
      <Kpi label="Memory" value={formatValue(v('mem'), 'percent')} sub={sat.exporter === 'node-exporter' ? 'node utilisation' : 'of cluster allocatable'} href={mh([sat.memPct])} trend={trend(r.mem.data)} health={utilHealth(v('mem'), 80, 92)} />
      <Kpi
        label="Firing alerts"
        value={alerts.data ? firing.length : '—'}
        sub={alerts.isError ? 'Alertmanager unreachable' : !alerts.data ? 'loading…' : `${crit} critical · ${alerts.data.filter((a) => a.state === 'pending').length} pending`}
        href={discoverHref('alerts', { service: ctx.scope.service ?? undefined, namespace: ctx.scope.namespace ?? undefined })}
        health={!alerts.data ? undefined : crit ? 'crit' : firing.length ? 'warn' : 'ok'}
      />
      <Kpi
        label="Pod issues"
        value={podIssues ?? '—'}
        sub={ksmMissing ? 'needs kube-state-metrics' : 'crashloop · pending · OOM'}
        href={mh([podHealthQueries(ctx.scope, ctx.range).crashloop])}
        health={podIssues == null ? undefined : podIssues > 0 ? 'crit' : 'ok'}
      />
      <Kpi
        label="Deploys"
        value={deploysState === 'ok' ? ctx.deploys.length : '—'}
        sub={deploysState === 'error' ? 'Argo CD unreachable' : deploysState === 'loading' ? 'loading…' : lastDeploy ? `last ${formatRelative(new Date(lastDeploy.t).toISOString())} · ${lastDeploy.label}` : `none in ${ctx.range}`}
        href="/deliver?section=apps"
      />
    </section>
  )
}

function metricsLink(ctx: DashCtx, queries: string[]): string {
  const p: Record<string, string> = { range: ctx.range }
  queries.forEach((q, i) => (p[i === 0 ? 'q' : `q${i + 1}`] = q))
  return discoverHref('metrics', p)
}

function alertInScope(a: lgtm.Alert, scope: Scope): boolean {
  if (scope.namespace && a.labels.namespace && a.labels.namespace !== scope.namespace) return false
  if (scope.service) {
    const vals = [a.labels.service, a.labels.workload, a.labels.deployment, a.labels.job, a.labels.pod, a.labels.container]
    if (!vals.some((v) => v && v.startsWith(scope.service!))) return false
  }
  return true
}

/* ─────────────────────────── golden signals ─────────────────────────── */

function noSourceHint(): string {
  return `Needs request metrics from one of: ${HTTP_SOURCES_V2.map((s) => s.label).join(', ')}. On Adhar this is Cilium Hubble L7 (httpV2 with destination context labels).`
}

function ChartBody({
  q,
  series,
  unit,
  ctx,
  empty,
  yMax,
  thresholds,
  missing,
}: {
  q: { isLoading: boolean; isError: boolean; error: unknown }
  series: Array<{ name: string; points: Array<[number, number]>; color?: string }>
  unit: Unit
  ctx: DashCtx
  empty?: string
  yMax?: number
  thresholds?: Array<{ value: number; label?: string; color?: string }>
  missing?: string | null
}) {
  if (missing) return <NoData title="Exporter missing" hint={missing} height={150} />
  if (q.isLoading) return <Loading height={150} />
  if (q.isError) return <QueryError error={q.error} height={150} />
  if (!series.some((s) => s.points.length > 1)) return <NoData hint={empty} height={150} />
  return <SignalChart series={series} unit={unit} height={150} annotations={ctx.deploys} yMax={yMax} thresholds={thresholds} />
}

function anyState(...qs: Array<{ isLoading: boolean; isError: boolean; error: unknown; data?: unknown }>) {
  const withData = qs.filter((q) => q.data !== undefined)
  return {
    isLoading: qs.every((q) => q.isLoading || q.data === undefined) && qs.some((q) => q.isLoading),
    isError: withData.length === 0 && qs.some((q) => q.isError),
    error: qs.find((q) => q.isError)?.error,
  }
}

function GoldenSignals({ ctx, src }: { ctx: DashCtx; src: HttpSource | null }) {
  const http = src ? httpQueries(src, ctx.scope, ctx.win) : null
  const sat = saturationQueries(ctx.scope, ctx.win)
  const r = useRangeSet(
    {
      p50: http?.p50 ?? null,
      p90: http?.p90 ?? null,
      p99: http?.p99 ?? null,
      rps: http?.rps ?? null,
      byClass: http?.rpsByClass ?? null,
      err: http?.errorPct ?? null,
      err4: http?.clientErrorPct ?? null,
      cpu: sat.cpuPct,
      mem: sat.memPct,
      disk: sat.diskPct,
      rx: sat.netRx,
      tx: sat.netTx,
    },
    { windowMs: ctx.windowMs, stepSec: ctx.stepSec, refreshMs: ctx.refreshMs },
  )
  const one = (s: RangeSeries[] | undefined, name: string, slot: number) => (s?.[0] ? [{ name, points: s[0].points, color: seriesColor(slot) }] : [])
  const satMissing = needs(ctx, sat.exporter === 'node-exporter' ? ['node-exporter'] : ['cAdvisor', 'kube-state-metrics'])
  const scopeLabel = ctx.scope.service ? ctx.scope.service : ctx.scope.namespace ? ctx.scope.namespace : 'cluster'
  const classOrder = ['2xx', '3xx', '4xx', '5xx', '1xx']
  const classes = (r.byClass.data ?? []).slice().sort((a, b) => classOrder.indexOf(a.metric.class) - classOrder.indexOf(b.metric.class))
  const trafficSeries = classes.length
    ? classes.map((s) => ({ name: s.metric.class ?? 'other', points: s.points, color: seriesColor(Math.max(0, classOrder.indexOf(s.metric.class))) }))
    : one(r.rps.data, 'requests/s', 0)
  const noSrc = !src ? (ctx.names ? noSourceHint() : null) : null
  return (
    <section className="space-y-4" aria-label="Golden signals">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-content">Golden signals <span className="font-normal text-content-subtle">· {scopeLabel}</span></h2>
        <span className="text-[11px] text-content-subtle">step {ctx.stepSec}s · rate[{ctx.win}]</span>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Widget title="Latency" subtitle="p50 · p90 · p99" href={metricsLink(ctx, [http?.p50, http?.p90, http?.p99].filter(Boolean) as string[])} hrefLabel="Metrics">
          <ChartBody
            ctx={ctx}
            unit="ms"
            missing={noSrc}
            q={anyState(r.p50, r.p90, r.p99)}
            series={[...one(r.p50.data, 'p50', 0), ...one(r.p90.data, 'p90', 1), ...one(r.p99.data, 'p99', 2)]}
            empty={src?.duration ? `${src.label} has no duration histogram samples in this window.` : 'This source has no duration histogram.'}
          />
        </Widget>
        <Widget title="Traffic" subtitle={classes.length ? 'requests / second by status class' : 'requests / second'} href={metricsLink(ctx, [http?.rpsByClass ?? http?.rps ?? ''].filter(Boolean))} hrefLabel="Metrics">
          <ChartBody ctx={ctx} unit="rps" missing={noSrc} q={anyState(r.rps, r.byClass)} series={trafficSeries} empty="No requests recorded in this window." />
        </Widget>
        <Widget title="Errors" subtitle="5xx share · 4xx share of responses" href={metricsLink(ctx, [http?.errorPct, http?.clientErrorPct].filter(Boolean) as string[])} hrefLabel="Metrics">
          <ChartBody
            ctx={ctx}
            unit="percent"
            missing={noSrc}
            q={anyState(r.err, r.err4)}
            series={[...one(r.err.data, '5xx %', 7), ...one(r.err4.data, '4xx %', 3)]}
            thresholds={[{ value: 1, label: '1%', color: 'var(--color-amber-500)' }]}
            empty="No responses recorded in this window (an idle service has no error rate)."
          />
        </Widget>
        <Widget
          title="Saturation"
          subtitle={sat.exporter === 'node-exporter' ? 'node CPU · memory · root disk utilisation' : 'CPU · memory as share of cluster allocatable (cAdvisor)'}
          href={metricsLink(ctx, [sat.cpuPct, sat.memPct, sat.diskPct].filter(Boolean) as string[])}
          hrefLabel="Metrics"
        >
          <ChartBody
            ctx={ctx}
            unit="percent"
            missing={satMissing}
            q={anyState(r.cpu, r.mem)}
            yMax={100}
            series={[...one(r.cpu.data, 'CPU', 0), ...one(r.mem.data, 'Memory', 1), ...one(r.disk.data, 'Disk', 2)]}
          />
        </Widget>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Widget title="Network" subtitle={sat.exporter === 'node-exporter' ? 'node NIC throughput' : 'pod network throughput'} href={metricsLink(ctx, [sat.netRx, sat.netTx])} hrefLabel="Metrics">
          <ChartBody ctx={ctx} unit="bytes/s" missing={satMissing} q={anyState(r.rx, r.tx)} series={[...one(r.rx.data, 'receive', 0), ...one(r.tx.data, 'transmit', 1)]} />
        </Widget>
        <LogErrorsWidget ctx={ctx} />
        <TraceErrorsWidget ctx={ctx} />
      </div>
    </section>
  )
}

/* ─────────────────────────── RED ─────────────────────────── */

type RedSort = 'traffic' | 'errors' | 'latency'

function useRed(ctx: DashCtx, src: HttpSource | null) {
  const by = src ? serviceBy(src) : ''
  const http = src ? httpQueries(src, ctx.scope, ctx.win, by) : null
  const r = useRangeSet(
    { rps: http?.rps ?? null, err: http?.errorPct ?? null, p50: http?.p50 ?? null, p95: http?.p95 ?? null, p99: http?.p99 ?? null },
    { windowMs: ctx.windowMs, stepSec: ctx.stepSec, refreshMs: ctx.refreshMs },
  )
  const rows = useMemo(
    () => (src ? joinRed(src, { rps: r.rps.data, err: r.err.data, p50: r.p50.data, p95: r.p95.data, p99: r.p99.data }) : []),
    [src, r.rps.data, r.err.data, r.p50.data, r.p95.data, r.p99.data],
  )
  return { rows, state: r.rps, http }
}

function sortRows(rows: RedRow[], by: RedSort): RedRow[] {
  const key = (r: RedRow) => (by === 'traffic' ? r.rps : by === 'errors' ? r.errorPct : r.p95) ?? -1
  return rows.slice().sort((a, b) => key(b) - key(a))
}

function RedWidget({ ctx, src, className, onPickService }: { ctx: DashCtx; src: HttpSource | null; className?: string; onPickService(s: string, ns?: string): void }) {
  const { rows, state, http } = useRed(ctx, src)
  const [sort, setSort] = useState<RedSort>('traffic')
  const [all, setAll] = useState(false)
  const sorted = sortRows(rows, sort)
  const shown = all ? sorted : sorted.slice(0, 12)
  return (
    <Widget
      className={className}
      title="Services — RED"
      subtitle={src ? `Rate · errors · duration per ${src.serviceLabel} · ${src.label}` : 'Rate · errors · duration per service'}
      href={http ? metricsLink(ctx, [http.rps, http.errorPct]) : undefined}
      hrefLabel="Metrics"
      actions={<Segmented value={sort} onChange={setSort} ariaLabel="Sort services" options={[{ id: 'traffic', label: 'Traffic' }, { id: 'errors', label: 'Errors' }, { id: 'latency', label: 'Latency' }]} />}
      bodyClassName="p-0!"
    >
      {!src ? <div className="p-4"><NoData title="No request metrics" hint={ctx.names ? noSourceHint() : undefined} /></div> : state.isLoading ? <Loading /> : state.isError ? <div className="p-4"><QueryError error={state.error} /></div> : rows.length === 0 ? (
        <div className="p-4"><NoData hint={`${src.label} reports no series carrying a ${src.serviceLabel} label in this window.${src.id === 'hubble' ? ' Hubble needs labelsContext=destination_namespace,destination_workload on its httpV2 metric.' : ''}`} /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-[11px]">
            <thead>
              <tr className="border-b border-edge-subtle text-left text-[10px] uppercase tracking-wide text-content-subtle">
                <th className="px-4 py-1.5 font-medium sm:px-5">Service</th>
                <th className="px-2 py-1.5 text-right font-medium">Rate</th>
                <th className="px-2 py-1.5 font-medium"><span className="sr-only">Rate trend</span></th>
                <th className="px-2 py-1.5 text-right font-medium">Errors</th>
                <th className="px-2 py-1.5 text-right font-medium">p50</th>
                <th className="px-2 py-1.5 text-right font-medium">p95</th>
                <th className="px-2 py-1.5 text-right font-medium">p99</th>
                <th className="px-4 py-1.5 text-right font-medium sm:px-5">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {shown.map((row) => {
                const svcScope: Scope = { namespace: row.namespace ?? ctx.scope.namespace, service: row.service }
                const h = httpQueries(src, svcScope, ctx.win)
                return (
                  <tr key={row.key} className="hover:bg-surface-sunken/50">
                    <td className="max-w-[16rem] px-4 py-1.5 sm:px-5">
                      <div className="flex min-w-0 items-center gap-2">
                        <HealthTag health={errorHealth(row.errorPct)} compact />
                        <button
                          type="button"
                          onClick={() => onPickService(row.service, row.namespace)}
                          title="Scope the dashboard to this service"
                          className="min-w-0 truncate text-left font-medium text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300"
                        >
                          {row.service}
                        </button>
                        {row.namespace ? <span className="shrink-0 truncate text-[10px] text-content-subtle">{row.namespace}</span> : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-content">{formatValue(row.rps, 'rps')}</td>
                    <td className="w-24 px-2 py-1.5">{row.rpsTrend.length > 1 ? <Sparkline points={row.rpsTrend} color="var(--viz-1)" height={16} width={88} strokeWidth={1.25} /> : null}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-content">{formatValue(row.errorPct, 'percent')}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-content-muted">{formatValue(row.p50, 'ms')}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-content">{formatValue(row.p95, 'ms')}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-content-muted">{formatValue(row.p99, 'ms')}</td>
                    <td className="whitespace-nowrap px-4 py-1.5 text-right sm:px-5">
                      <span className="inline-flex gap-2 text-[11px] font-medium text-brand-700 dark:text-brand-300">
                        <DLink className="hover:underline" href={metricsLink(ctx, [h.rps, h.errorPct, h.p95 ?? ''].filter(Boolean))}>Metrics</DLink>
                        <DLink className="hover:underline" href={discoverHref('logs', { q: lokiSelector(svcScope), range: ctx.range })}>Logs</DLink>
                        <DLink className="hover:underline" href={discoverHref('traces', { service: row.service, range: ctx.range })}>Traces</DLink>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {sorted.length > 12 ? (
            <div className="border-t border-edge-subtle px-4 py-2 sm:px-5">
              <button type="button" onClick={() => setAll((a) => !a)} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
                {all ? 'Show top 12' : `Show all ${sorted.length} services`}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </Widget>
  )
}

function TopServicesWidget({ ctx, src }: { ctx: DashCtx; src: HttpSource | null }) {
  const { rows, state } = useRed(ctx, src)
  const [by, setBy] = useState<RedSort>('errors')
  const unit: Unit = by === 'traffic' ? 'rps' : by === 'errors' ? 'percent' : 'ms'
  const val = (r: RedRow) => (by === 'traffic' ? r.rps : by === 'errors' ? r.errorPct : r.p95)
  const top = sortRows(rows, by).filter((r) => (val(r) ?? 0) > 0).slice(0, 6)
  const max = Math.max(...top.map((r) => val(r) ?? 0), 0) || 1
  return (
    <Widget
      title="Top services"
      subtitle={by === 'traffic' ? 'by requests / second' : by === 'errors' ? 'by 5xx share' : 'by p95 latency'}
      actions={<Segmented value={by} onChange={setBy} ariaLabel="Rank by" options={[{ id: 'errors', label: 'Errors' }, { id: 'latency', label: 'p95' }, { id: 'traffic', label: 'Traffic' }]} />}
    >
      {!src ? <NoData title="No request metrics" /> : state.isLoading ? <Loading /> : state.isError ? <QueryError error={state.error} /> : top.length === 0 ? (
        <NoData title={by === 'errors' ? 'No service is returning 5xx' : 'No data in this range'} />
      ) : (
        <ol className="space-y-2.5">
          {top.map((r) => (
            <li key={r.key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <DLink
                  href={discoverHref('dashboard', { range: ctx.range, ns: r.namespace ?? ctx.scope.namespace ?? undefined, svc: r.service })}
                  className="min-w-0 truncate font-medium text-content hover:underline"
                  title={r.namespace ? `${r.namespace}/${r.service}` : r.service}
                >
                  {r.service}
                </DLink>
                <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-content">
                  {by === 'errors' ? <HealthTag health={errorHealth(r.errorPct)} compact /> : null}
                  {formatValue(val(r), unit)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full" style={{ width: `${((val(r) ?? 0) / max) * 100}%`, backgroundColor: 'var(--viz-1)' }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Widget>
  )
}

/* ─────────────────────────── alerts / SLOs / deploys ─────────────────────────── */

function AlertsWidget({ ctx }: { ctx: DashCtx }) {
  const q = useAlerts()
  const active = (q.data ?? []).filter((a) => a.state !== 'resolved' && alertInScope(a, ctx.scope))
  const firing = active.filter((a) => a.state === 'firing')
  const sev = (s: string) => firing.filter((a) => a.severity === s).length
  const order = { critical: 0, warning: 1, info: 2 } as const
  const list = active.slice().sort((a, b) => (a.state === b.state ? 0 : a.state === 'firing' ? -1 : 1) || order[a.severity] - order[b.severity]).slice(0, 6)
  return (
    <Widget
      title="Alerts"
      subtitle="Prometheus / Alertmanager · live"
      href={discoverHref('alerts', { service: ctx.scope.service ?? undefined, namespace: ctx.scope.namespace ?? undefined })}
      hrefLabel="Alerts"
      bodyClassName="space-y-3"
    >
      {q.isLoading ? <Loading /> : q.isError ? <QueryError error={q.error} /> : (
        <>
          <div className="grid grid-cols-4 gap-2 text-center">
            {([
              ['critical', sev('critical'), 'crit'],
              ['warning', sev('warning'), 'warn'],
              ['info', sev('info'), 'none'],
              ['pending', active.length - firing.length, 'none'],
            ] as const).map(([label, n, h]) => (
              <DLink
                key={label}
                href={discoverHref('alerts', { severity: label === 'pending' ? undefined : label, state: label === 'pending' ? 'pending' : 'firing', namespace: ctx.scope.namespace ?? undefined })}
                className="rounded-md border border-edge-subtle px-1 py-1.5 hover:bg-surface-sunken"
              >
                <div className="font-mono text-base font-semibold tabular-nums text-content">{n}</div>
                <div className="flex items-center justify-center gap-1 text-[10px] text-content-subtle">
                  {n > 0 && h !== 'none' ? <HealthTag health={h} compact /> : null}
                  {label}
                </div>
              </DLink>
            ))}
          </div>
          {list.length === 0 ? (
            <div className="flex items-center gap-1.5 text-[11px] text-content-muted"><HealthTag health="ok" label="No active alerts in scope" /></div>
          ) : (
            <ul className="divide-y divide-edge-subtle">
              {list.map((a) => (
                <li key={a.fingerprint} className="flex min-w-0 items-center gap-2 py-1.5 text-[11px]">
                  <HealthTag health={a.state === 'pending' ? 'warn' : a.severity === 'critical' ? 'crit' : a.severity === 'warning' ? 'warn' : 'none'} compact />
                  <span className="min-w-0 flex-1 truncate text-content" title={a.summary ?? a.name}>{a.name}</span>
                  <span className="shrink-0 text-[10px] text-content-subtle">{a.state === 'pending' ? 'pending · ' : ''}{formatRelative(a.startsAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Widget>
  )
}

function SloWidget({ ctx }: { ctx: DashCtx }) {
  const q = useSlos()
  const slos = (q.data ?? []).filter((s) => !ctx.scope.service || s.service === ctx.scope.service)
  const burning = (s: lgtm.Slo) => s.burnRate1h >= 14.4 || s.burnRate6h >= 6
  const slow = (s: lgtm.Slo) => !burning(s) && (s.burnRate6h >= 1 || s.errorBudgetRemaining < 0.25)
  const nFast = slos.filter(burning).length
  const nSlow = slos.filter(slow).length
  const list = slos.slice().sort((a, b) => b.burnRate1h - a.burnRate1h).slice(0, 5)
  return (
    <Widget title="SLO burn" subtitle="Multi-window burn rate · 1h ≥ 14.4× or 6h ≥ 6× pages" href={discoverHref('slos', { service: ctx.scope.service ?? undefined })} hrefLabel="SLOs" bodyClassName="space-y-3">
      {q.isLoading ? <Loading /> : q.isError ? <QueryError error={q.error} /> : slos.length === 0 ? (
        <NoData title="No SLOs" hint="No SLO definitions were returned (Pyrra / Sloth recording rules). Define objectives to track error-budget burn here." />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat n={nFast} label="fast burn" health={nFast ? 'crit' : 'ok'} />
            <Stat n={nSlow} label="slow burn" health={nSlow ? 'warn' : 'ok'} />
            <Stat n={slos.length - nFast - nSlow} label="on track" health="ok" />
          </div>
          <ul className="space-y-2">
            {list.map((s) => {
              const h = burning(s) ? 'crit' : slow(s) ? 'warn' : 'ok'
              return (
                <li key={s.name} className="min-w-0 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5"><HealthTag health={h} compact /><span className="truncate text-content">{s.name}</span></span>
                    <span className="shrink-0 font-mono tabular-nums text-content-muted">{s.burnRate1h.toFixed(1)}× · {(s.errorBudgetRemaining * 100).toFixed(0)}% left</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-sunken">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, s.errorBudgetRemaining * 100))}%`, backgroundColor: 'var(--viz-1)' }} />
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Widget>
  )
}

function Stat({ n, label, health }: { n: number; label: string; health: 'ok' | 'warn' | 'crit' }) {
  return (
    <div className="rounded-md border border-edge-subtle px-1 py-1.5">
      <div className="font-mono text-base font-semibold tabular-nums text-content">{n}</div>
      <div className="flex items-center justify-center gap-1 text-[10px] text-content-subtle">
        {n > 0 && health !== 'ok' ? <HealthTag health={health} compact /> : null}
        {label}
      </div>
    </div>
  )
}

function DeploysWidget({ ctx, deploys, loading, error }: { ctx: DashCtx; deploys: ReturnType<typeof deployEvents>; loading: boolean; error: unknown }) {
  return (
    <Widget title="Recent deploys" subtitle={`Argo CD sync history · ${ctx.range}${ctx.scope.namespace ? ` · ${ctx.scope.namespace}` : ''} · shown as ◆ on charts`} href="/deliver?section=apps" hrefLabel="Deliver">
      {loading ? <Loading /> : error ? <QueryError error={error} /> : deploys.length === 0 ? (
        <NoData title={`No deploys in the last ${ctx.range}`} />
      ) : (
        <ul className="divide-y divide-edge-subtle">
          {deploys.slice(0, 7).map((d) => (
            <li key={`${d.app}-${d.t}`} className="flex min-w-0 items-center gap-2 py-1.5 text-[11px]">
              <HealthTag
                health={d.phase === 'Succeeded' ? (d.health === 'Degraded' ? 'warn' : 'ok') : d.phase === 'Running' ? 'none' : 'crit'}
                compact
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-content">{d.app}</span>
                {d.revision ? <span className="ml-1.5 font-mono text-content-subtle">{shortRev(d.revision)}</span> : null}
              </span>
              <span className={cn('shrink-0 text-[10px]', d.phase === 'Succeeded' ? 'text-content-subtle' : 'text-content-muted')}>
                {d.phase !== 'Succeeded' ? `${d.phase} · ` : ''}{formatRelative(new Date(d.t).toISOString())}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}

/* ─────────────────────────── product pulse (PostHog) ─────────────────────────── */

function ProductPulse() {
  const events = useAnalyticsEvents({ sinceMs: 24 * 3600 * 1000 })
  const sessions = useSessions()
  const list = events.data ?? []
  const users = useMemo(() => new Set(list.map((e) => e.distinct_id)).size, [list])
  const top = useMemo(() => {
    const c = new Map<string, number>()
    for (const e of list) c.set(e.event, (c.get(e.event) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [list])
  const errSessions = (sessions.data ?? []).filter((s) => (s.console_error_count ?? 0) > 0).length
  const max = top[0]?.[1] ?? 1
  return (
    <Widget title="Product pulse" subtitle="PostHog · last 24 h" href={discoverHref('analytics')} hrefLabel="Analytics">
      {events.isLoading ? <Loading height={80} /> : events.isError ? <QueryError error={events.error} /> : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[repeat(3,minmax(0,8rem))_1fr]">
          <PulseStat label="Active users" value={users} />
          <PulseStat label="Events" value={list.length} />
          <PulseStat label="Sessions with errors" value={sessions.data ? errSessions : '—'} href={discoverHref('sessions')} />
          <div className="min-w-0 space-y-1.5">
            {top.length === 0 ? <div className="text-[11px] text-content-subtle">No events captured in the last 24 h.</div> : top.map(([name, n]) => (
              <div key={name} className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-2 text-[11px]">
                <code className="truncate font-mono text-content">{name}</code>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"><div className="h-full rounded-full" style={{ width: `${(n / max) * 100}%`, backgroundColor: 'var(--viz-1)' }} /></div>
                <span className="text-right font-mono tabular-nums text-content-muted">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Widget>
  )
}

function PulseStat({ label, value, href }: { label: string; value: ReactNode; href?: string }) {
  const inner = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">{label}</div>
      <div className="text-xl font-semibold tabular-nums text-content">{value}</div>
    </>
  )
  return href ? <DLink href={href} className="block rounded-md hover:bg-surface-sunken/60">{inner}</DLink> : <div>{inner}</div>
}
