import { useMemo, useState } from 'react'
import type { TimeRangeId } from '../data/observability.ts'
import {
  capacityQueries,
  type Exporter,
  INGRESS_SOURCES,
  lastOf,
  lokiErrorVolume,
  lokiSelector,
  missingExporters,
  podHealthQueries,
  type Scope,
  traceErrorPct,
  USE_QUERIES,
  utilHealth,
  worst,
  type Health,
} from '../data/golden-signals.ts'
import { type InstantSample, useInstantSet, useRange } from '../data/prom.ts'
import { discoverHref } from '../data/discover-links.ts'
import { formatValue } from '../data/promql-lite.ts'
import {
  type Annotation,
  DLink,
  HealthTag,
  Loading,
  Meter,
  NoData,
  QueryError,
  Segmented,
  seriesColor,
  SignalChart,
  toTimeSeries,
  Widget,
} from './viz.tsx'

/** Everything a dashboard widget needs to scope, time and refresh itself. */
export interface DashCtx {
  range: TimeRangeId
  windowMs: number
  stepSec: number
  /** Rate window (`5m`, `10m`, …) matched to the step. */
  win: string
  scope: Scope
  names?: Set<string>
  refreshMs: number | false
  deploys: Annotation[]
}

/** "needs X" hint when an exporter is missing, else null. */
export function needs(ctx: DashCtx, exporters: Exporter[]): string | null {
  const miss = missingExporters(ctx.names, exporters)
  return miss.length ? `Needs ${miss.join(' + ')} — Prometheus is not scraping ${miss.length > 1 ? 'them' : 'it'}.` : null
}

const metricsHref = (ctx: DashCtx, queries: string[]) => {
  const p: Record<string, string> = { range: ctx.range }
  queries.forEach((q, i) => (p[i === 0 ? 'q' : `q${i + 1}`] = q))
  return discoverHref('metrics', p)
}

/* ─────────────────────────── USE (nodes) ─────────────────────────── */

interface NodeRow {
  node: string
  cpu: number | null
  load: number | null
  mem: number | null
  majfault: number | null
  disk: number | null
  ioq: number | null
  netErr: number | null
  notReady: boolean
  pressure: string[]
}

function byLabel(samples: InstantSample[] | undefined, label: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of samples ?? []) if (s.metric[label]) m.set(s.metric[label], s.value)
  return m
}

export function UseNodesWidget({ ctx }: { ctx: DashCtx }) {
  const q = useInstantSet(USE_QUERIES, { refreshMs: ctx.refreshMs })
  const missing = needs(ctx, ['node-exporter'])
  const rows = useMemo<NodeRow[]>(() => {
    const cpu = byLabel(q.cpuUtil.data, 'nodename')
    const load = byLabel(q.cpuSat.data, 'nodename')
    const mem = byLabel(q.memUtil.data, 'nodename')
    const maj = byLabel(q.memSat.data, 'nodename')
    const disk = byLabel(q.diskUtil.data, 'nodename')
    const ioq = byLabel(q.diskSat.data, 'nodename')
    const net = byLabel(q.netErr.data, 'nodename')
    const notReady = byLabel(q.notReady.data, 'node')
    const pressure = new Map<string, string[]>()
    for (const s of q.pressure.data ?? []) {
      const list = pressure.get(s.metric.node) ?? []
      list.push(s.metric.condition)
      pressure.set(s.metric.node, list)
    }
    const nodes = new Set([...cpu.keys(), ...mem.keys(), ...notReady.keys()])
    return [...nodes].sort().map((node) => ({
      node,
      cpu: cpu.get(node) ?? null,
      load: load.get(node) ?? null,
      mem: mem.get(node) ?? null,
      majfault: maj.get(node) ?? null,
      disk: disk.get(node) ?? null,
      ioq: ioq.get(node) ?? null,
      netErr: net.get(node) ?? null,
      notReady: (notReady.get(node) ?? 0) > 0,
      pressure: pressure.get(node) ?? [],
    }))
  }, [q.cpuUtil.data, q.cpuSat.data, q.memUtil.data, q.memSat.data, q.diskUtil.data, q.diskSat.data, q.netErr.data, q.notReady.data, q.pressure.data])

  const body = q.cpuUtil.isLoading
    ? <Loading />
    : q.cpuUtil.isError
    ? <QueryError error={q.cpuUtil.error} />
    : rows.length === 0
    ? <NoData title="No node metrics" hint={missing ?? 'node-exporter returned no nodes, or node_uname_info is missing.'} />
    : (
      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full min-w-[640px] text-[11px]">
          <thead>
            <tr className="border-b border-edge-subtle text-left text-[10px] uppercase tracking-wide text-content-subtle">
              <th className="px-4 py-1.5 font-medium sm:px-5">Node</th>
              <th className="px-2 py-1.5 font-medium" title="Utilisation">CPU</th>
              <th className="px-2 py-1.5 font-medium" title="Saturation: 1m load average per core">Load/core</th>
              <th className="px-2 py-1.5 font-medium">Memory</th>
              <th className="px-2 py-1.5 font-medium" title="Saturation: major page faults per second">Maj. faults</th>
              <th className="px-2 py-1.5 font-medium">Disk /</th>
              <th className="px-2 py-1.5 font-medium" title="Saturation: average IO queue depth">IO queue</th>
              <th className="px-2 py-1.5 font-medium" title="Errors: NIC rx+tx errors per second">Net errs</th>
              <th className="px-4 py-1.5 font-medium sm:px-5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle">
            {rows.map((r) => {
              const h: Health = r.notReady
                ? 'crit'
                : worst(
                  utilHealth(r.cpu),
                  utilHealth(r.mem, 80, 92),
                  utilHealth(r.disk, 80, 90),
                  r.load == null ? 'none' : r.load >= 2 ? 'crit' : r.load >= 1 ? 'warn' : 'ok',
                  r.pressure.length ? 'warn' : 'ok',
                  (r.netErr ?? 0) > 0 ? 'warn' : 'ok',
                )
              return (
                <tr key={r.node} className="hover:bg-surface-sunken/50">
                  <td className="max-w-[14rem] truncate px-4 py-1.5 font-mono text-content sm:px-5">{r.node}</td>
                  <Cell v={r.cpu} fmt={(v) => formatValue(v, 'percent')} h={utilHealth(r.cpu)} />
                  <Cell v={r.load} fmt={(v) => v.toFixed(2)} h={r.load == null ? 'none' : r.load >= 2 ? 'crit' : r.load >= 1 ? 'warn' : 'ok'} />
                  <Cell v={r.mem} fmt={(v) => formatValue(v, 'percent')} h={utilHealth(r.mem, 80, 92)} />
                  <Cell v={r.majfault} fmt={(v) => `${v.toFixed(1)}/s`} />
                  <Cell v={r.disk} fmt={(v) => formatValue(v, 'percent')} h={utilHealth(r.disk, 80, 90)} />
                  <Cell v={r.ioq} fmt={(v) => v.toFixed(2)} />
                  <Cell v={r.netErr} fmt={(v) => `${v.toFixed(2)}/s`} h={r.netErr == null ? 'none' : r.netErr > 0 ? 'warn' : 'ok'} />
                  <td className="px-4 py-1.5 sm:px-5">
                    <HealthTag
                      health={h}
                      label={r.notReady ? 'NotReady' : r.pressure.length ? r.pressure.join(', ') : undefined}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  return (
    <Widget
      title="Nodes — USE"
      subtitle="Utilisation · saturation · errors · node-exporter + kube-state-metrics"
      href={metricsHref(ctx, [USE_QUERIES.cpuUtil, USE_QUERIES.memUtil])}
      hrefLabel="Metrics"
    >
      {body}
    </Widget>
  )
}

function Cell({ v, fmt, h }: { v: number | null; fmt(v: number): string; h?: Health }) {
  const tone = h === 'crit' ? 'text-rose-700 dark:text-rose-300 font-semibold' : h === 'warn' ? 'text-amber-700 dark:text-amber-300 font-semibold' : 'text-content'
  return (
    <td className={`px-2 py-1.5 font-mono tabular-nums ${v == null ? 'text-content-subtle' : tone}`}>
      {v == null ? '—' : fmt(v)}
      {h === 'crit' || h === 'warn' ? <span className="sr-only"> ({h === 'crit' ? 'critical' : 'warning'})</span> : null}
    </td>
  )
}

/* ─────────────────────────── pod health ─────────────────────────── */

const WIN_LABEL: Record<TimeRangeId, string> = { '5m': '5m', '15m': '15m', '1h': '1h', '6h': '6h', '24h': '24h', '7d': '7d' }

export function PodHealthWidget({ ctx }: { ctx: DashCtx }) {
  const queries = useMemo(() => podHealthQueries(ctx.scope, WIN_LABEL[ctx.range]), [ctx.scope, ctx.range])
  const q = useInstantSet(queries, { refreshMs: ctx.refreshMs })
  const missing = needs(ctx, ['kube-state-metrics'])
  const count = (k: string) => q[k]?.data?.length ?? 0
  const restarts = lastValue(q.restarts?.data)
  const stats: Array<{ key: string; label: string; value: number | null; bad: boolean; hint: string }> = [
    { key: 'restarts', label: `Restarts · ${ctx.range}`, value: restarts == null ? null : Math.round(restarts), bad: (restarts ?? 0) > 0, hint: 'increase(kube_pod_container_status_restarts_total)' },
    { key: 'crashloop', label: 'CrashLoopBackOff', value: count('crashloop'), bad: count('crashloop') > 0, hint: 'kube_pod_container_status_waiting_reason' },
    { key: 'oomKilled', label: 'OOMKilled (last exit)', value: count('oomKilled'), bad: count('oomKilled') > 0, hint: 'kube_pod_container_status_last_terminated_reason' },
    { key: 'pending', label: 'Pending', value: count('pending'), bad: count('pending') > 0, hint: 'kube_pod_status_phase' },
    { key: 'notReady', label: 'Not ready', value: count('notReady'), bad: count('notReady') > 0, hint: 'kube_pod_status_ready' },
    { key: 'imagePull', label: 'Image pull errors', value: count('imagePull'), bad: count('imagePull') > 0, hint: 'kube_pod_container_status_waiting_reason' },
  ]
  type Issue = { ns: string; pod: string; reasons: string[]; restarts?: number }
  const issues = useMemo(() => {
    const m = new Map<string, Issue>()
    const add = (k: string, reason: string) => {
      for (const s of q[k]?.data ?? []) {
        const id = `${s.metric.namespace}/${s.metric.pod}`
        const cur = m.get(id) ?? { ns: s.metric.namespace, pod: s.metric.pod, reasons: [] }
        if (k === 'topRestarts') cur.restarts = Math.round(s.value)
        else cur.reasons.push(reason)
        m.set(id, cur)
      }
    }
    add('crashloop', 'CrashLoopBackOff')
    add('oomKilled', 'OOMKilled')
    add('imagePull', 'ImagePull')
    add('failed', 'Failed')
    add('pending', 'Pending')
    add('notReady', 'NotReady')
    add('topRestarts', '')
    return [...m.values()].sort((a, b) => b.reasons.length - a.reasons.length || (b.restarts ?? 0) - (a.restarts ?? 0)).slice(0, 8)
  }, [q.crashloop?.data, q.oomKilled?.data, q.imagePull?.data, q.failed?.data, q.pending?.data, q.notReady?.data, q.topRestarts?.data])

  const loading = q.running?.isLoading
  const err = q.running?.isError ? q.running.error : null
  return (
    <Widget
      title="Pod health"
      subtitle={`kube-state-metrics · ${lastValue(q.running?.data) != null ? `${Math.round(lastValue(q.running?.data)!)} running` : 'running —'}`}
      href={metricsHref(ctx, [queries.topRestarts])}
      hrefLabel="Metrics"
    >
      {loading ? <Loading /> : err ? <QueryError error={err} /> : missing ? <NoData title="No pod state" hint={missing} /> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {stats.map((s) => (
              <div key={s.key} title={s.hint} className="rounded-md border border-edge-subtle px-2.5 py-1.5">
                <div className="text-[10px] text-content-subtle">{s.label}</div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-base font-semibold tabular-nums text-content">{s.value ?? '—'}</span>
                  {s.value != null ? <HealthTag health={s.bad ? (s.key === 'restarts' ? 'warn' : 'crit') : 'ok'} compact /> : null}
                </div>
              </div>
            ))}
          </div>
          {issues.length ? (
            <ul className="divide-y divide-edge-subtle rounded-md border border-edge-subtle">
              {issues.map((i) => (
                <li key={`${i.ns}/${i.pod}`} className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[11px]">
                  <HealthTag health={i.reasons.length ? 'crit' : 'warn'} compact />
                  <span className="min-w-0 flex-1 truncate font-mono text-content" title={`${i.ns}/${i.pod}`}>
                    <span className="text-content-subtle">{i.ns}/</span>{i.pod}
                  </span>
                  <span className="shrink-0 text-content-muted">
                    {[...i.reasons, i.restarts ? `${i.restarts} restarts` : ''].filter(Boolean).join(' · ')}
                  </span>
                  <DLink
                    href={discoverHref('logs', { q: `{namespace="${i.ns}", pod="${i.pod}"}`, range: ctx.range })}
                    className="shrink-0 text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300"
                  >
                    Logs
                  </DLink>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[11px] text-content-subtle">No crashlooping, OOMKilled, pending or restarting pods in scope.</div>
          )}
        </div>
      )}
    </Widget>
  )
}

function lastValue(s: InstantSample[] | undefined): number | null {
  return s && s.length ? s[0].value : null
}

/* ─────────────────────────── capacity ─────────────────────────── */

export function CapacityWidget({ ctx }: { ctx: DashCtx }) {
  const queries = useMemo(() => capacityQueries(ctx.scope, '5m'), [ctx.scope])
  const q = useInstantSet(queries, { refreshMs: ctx.refreshMs })
  const v = (k: string) => lastValue(q[k]?.data)
  const missing = needs(ctx, ['kube-state-metrics', 'cAdvisor'])
  const loading = q.cpuAlloc?.isLoading
  const err = q.cpuAlloc?.isError ? q.cpuAlloc.error : null
  return (
    <Widget
      title="Kubernetes capacity"
      subtitle={`Usage vs requests vs limits${ctx.scope.namespace ? ` · ${ctx.scope.namespace}` : ''} against node allocatable`}
      href={metricsHref(ctx, [queries.cpuUse, queries.cpuReq, queries.cpuLim])}
      hrefLabel="Metrics"
    >
      {loading ? <Loading /> : err ? <QueryError error={err} /> : missing && v('cpuAlloc') == null ? <NoData title="No capacity data" hint={missing} /> : (
        <div className="space-y-4">
          <Meter
            label="CPU"
            max={v('cpuAlloc')}
            format={(x) => formatValue(x, 'cores') + (x >= 1 ? ' cores' : '')}
            bars={[
              { name: 'Usage', value: v('cpuUse'), color: seriesColor(0) },
              { name: 'Requests', value: v('cpuReq'), color: seriesColor(1) },
              { name: 'Limits', value: v('cpuLim'), color: seriesColor(2) },
            ]}
          />
          <Meter
            label="Memory"
            max={v('memAlloc')}
            format={(x) => formatValue(x, 'bytes')}
            bars={[
              { name: 'Usage', value: v('memUse'), color: seriesColor(0) },
              { name: 'Requests', value: v('memReq'), color: seriesColor(1) },
              { name: 'Limits', value: v('memLim'), color: seriesColor(2) },
            ]}
          />
          {(() => {
            const req = v('cpuReq')
            const use = v('cpuUse')
            if (req == null || use == null || req === 0) return null
            const eff = (use / req) * 100
            return (
              <div className="text-[11px] text-content-muted">
                CPU request efficiency <span className="font-mono text-content">{eff.toFixed(0)}%</span>
                {eff < 30 ? ' — requests are well above usage; capacity is reserved but idle.' : eff > 100 ? ' — usage exceeds requests; pods rely on burst capacity.' : ''}
              </div>
            )
          })()}
        </div>
      )}
    </Widget>
  )
}

/* ─────────────────────────── ingress / gateway ─────────────────────────── */

export function IngressWidget({ ctx }: { ctx: DashCtx }) {
  const available = useMemo(() => INGRESS_SOURCES.filter((s) => ctx.names?.has(s.probe)), [ctx.names])
  const [pick, setPick] = useState<string | null>(null)
  const src = available.find((s) => s.id === pick) ?? available[0] ?? null
  const q = useInstantSet(
    {
      rps: src ? src.rps(ctx.win) : null,
      err: src ? src.errPct(ctx.win) : null,
      p95: src?.p95 ? src.p95(ctx.win) : null,
    },
    { refreshMs: ctx.refreshMs },
  )
  const rps = useRange(src ? src.rps(ctx.win) : null, { windowMs: ctx.windowMs, stepSec: ctx.stepSec, refreshMs: ctx.refreshMs })
  const rows = useMemo(() => {
    if (!src) return []
    const err = byLabel(q.err.data, src.by)
    const p95 = byLabel(q.p95.data, src.by)
    return (q.rps.data ?? [])
      .map((s) => ({ route: s.metric[src.by] || '(none)', rps: s.value, err: err.get(s.metric[src.by]) ?? null, p95: p95.get(s.metric[src.by]) ?? null }))
      .sort((a, b) => b.rps - a.rps)
  }, [src, q.rps.data, q.err.data, q.p95.data])
  return (
    <Widget
      title="Ingress / gateway traffic"
      subtitle={src ? `${src.label} · by ${src.by}` : 'Edge proxy request metrics'}
      href={src ? metricsHref(ctx, [src.rps(ctx.win)]) : undefined}
      hrefLabel="Metrics"
      actions={available.length > 1
        ? <Segmented value={src!.id} options={available.map((s) => ({ id: s.id, label: s.label.split(' ')[0] }))} onChange={setPick} ariaLabel="Ingress source" />
        : null}
    >
      {!ctx.names ? <Loading /> : !src ? (
        <NoData
          title="No ingress or gateway metrics"
          hint="Needs an edge proxy exporter: ingress-nginx metrics, Envoy Gateway / Cilium Envoy admin stats, or Traefik metrics. Cilium Hubble traffic shows under the golden signals."
        />
      ) : q.rps.isLoading ? <Loading /> : q.rps.isError ? <QueryError error={q.rps.error} /> : rows.length === 0 ? <NoData hint={`${src.label} is scraped but reported no requests in this window.`} /> : (
        <div className="space-y-3">
          <SignalChart
            series={toTimeSeries(rps.data ?? [], (s) => s.metric[src.by] || '(none)')}
            unit="rps"
            height={120}
            annotations={ctx.deploys}
          />
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-content-subtle">
                <th className="py-1 font-medium">{src.by === 'envoy_http_conn_manager_prefix' ? 'Listener' : src.by}</th>
                <th className="py-1 text-right font-medium">Req/s</th>
                <th className="py-1 text-right font-medium">5xx</th>
                <th className="py-1 text-right font-medium">p95</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {rows.map((r) => (
                <tr key={r.route}>
                  <td className="max-w-[12rem] truncate py-1 font-mono text-content" title={r.route}>{r.route}</td>
                  <td className="py-1 text-right font-mono tabular-nums text-content">{formatValue(r.rps, 'rps')}</td>
                  <td className="py-1 text-right">
                    <span className="inline-flex items-center justify-end gap-1 font-mono tabular-nums text-content">
                      {formatValue(r.err, 'percent')}
                      {r.err != null && r.err >= 1 ? <HealthTag health={r.err >= 5 ? 'crit' : 'warn'} compact /> : null}
                    </span>
                  </td>
                  <td className="py-1 text-right font-mono tabular-nums text-content">{formatValue(r.p95, 'ms')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  )
}

/* ─────────────────────────── logs + traces error charts ─────────────────────────── */

const LOKI_MAX_MS = 6 * 3_600_000

export function LogErrorsWidget({ ctx }: { ctx: DashCtx }) {
  const cheap = ctx.windowMs <= LOKI_MAX_MS
  const step = Math.max(60, ctx.stepSec)
  const query = lokiErrorVolume(ctx.scope, step)
  const q = useRange(cheap ? query : null, { windowMs: ctx.windowMs, stepSec: step, refreshMs: ctx.refreshMs, source: 'loki' })
  const logsQ = `${lokiSelector(ctx.scope)} |~ "(?i)\\\\b(error|fatal|panic|exception)\\\\b"`
  const series = q.data ?? []
  const total = series.reduce((a, s) => a + s.points.reduce((b, [, v]) => b + v, 0), 0)
  return (
    <Widget
      title="Log error volume"
      subtitle={`Loki · lines matching error|fatal|panic|exception${cheap ? ` · ${Math.round(total).toLocaleString()} in range` : ''}`}
      href={discoverHref('logs', { q: logsQ, range: ctx.range })}
      hrefLabel="Logs"
    >
      {!cheap ? (
        <NoData title="Range too wide for a full log scan" hint="Log error volume scans every stream; pick 6h or less, or open Logs to query a narrower selector." />
      ) : q.isLoading ? <Loading /> : q.isError ? <QueryError error={q.error} /> : series.length === 0 ? (
        <NoData hint="No error lines in this window — or Loki has no streams with a namespace label." />
      ) : (
        <SignalChart
          series={toTimeSeries(series, (s) => s.metric.namespace ?? 'error lines')}
          unit="short"
          height={140}
          annotations={ctx.deploys}
        />
      )}
    </Widget>
  )
}

export function TraceErrorsWidget({ ctx }: { ctx: DashCtx }) {
  const missing = needs(ctx, ['Tempo span metrics'])
  const query = traceErrorPct(ctx.scope, ctx.win)
  const q = useRange(missing ? null : query, { windowMs: ctx.windowMs, stepSec: ctx.stepSec, refreshMs: ctx.refreshMs })
  const last = lastOf(q.data)
  return (
    <Widget
      title="Trace error rate"
      subtitle={`Tempo span metrics · server spans with STATUS_CODE_ERROR${last != null ? ` · now ${formatValue(last, 'percent')}` : ''}`}
      href={discoverHref('traces', { status: 'error', service: ctx.scope.service ?? undefined, range: ctx.range })}
      hrefLabel="Traces"
    >
      {!ctx.names ? <Loading /> : missing ? (
        <NoData title="No span metrics" hint={`${missing} Enable the span-metrics processor in Tempo's metrics-generator to get error rates from traces.`} />
      ) : q.isLoading ? <Loading /> : q.isError ? <QueryError error={q.error} /> : (q.data ?? []).length === 0 ? (
        <NoData hint="No server spans in this window." />
      ) : (
        <SignalChart series={toTimeSeries(q.data ?? [], () => 'span error %')} unit="percent" height={140} annotations={ctx.deploys} />
      )}
    </Widget>
  )
}

