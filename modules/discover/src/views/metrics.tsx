import { useState } from 'react'
import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PrometheusIcon,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import type { lgtm } from '@adhar-console/api-clients'
import {
  DEFAULT_RANGE,
  PROMQL,
  seriesLabel,
  seriesToPoints,
  TIME_RANGES,
  useMetrics,
  useTelemetrySources,
  type TimeRangeId,
} from '../data/observability.ts'
import { SourceError } from './states.tsx'

const QUICK_PANELS: Array<{
  id: string
  label: string
  query: string
  unit: 'rps' | 'percent' | 'ms' | 'cpu' | 'bytes'
  color: string
}> = [
  { id: 'rps', label: 'Requests / sec', query: PROMQL.rps, unit: 'rps', color: 'var(--color-brand-500)' },
  { id: 'errors', label: 'Error rate (5xx)', query: PROMQL.errorRate, unit: 'percent', color: 'var(--color-rose-500)' },
  { id: 'latency', label: 'Latency p95', query: PROMQL.latencyP95, unit: 'ms', color: 'var(--color-amber-500)' },
  { id: 'cpu', label: 'CPU by namespace (cores)', query: PROMQL.cpu, unit: 'cpu', color: 'var(--color-violet-500)' },
  { id: 'memory', label: 'Memory working set by namespace', query: PROMQL.memory, unit: 'bytes', color: 'var(--color-emerald-500)' },
]

/**
 * Metrics — multi-panel PromQL explorer.
 *
 * Top toolbar: time range, custom PromQL query field. Below: a configurable
 * grid of panels (golden signals + saturation by default). Each panel
 * groups results by `metric.service` and renders a per-series area chart
 * with a max value pill.
 */
/** Panels that need HTTP telemetry; saturation panels work from cAdvisor alone. */
const HTTP_PANEL_IDS = new Set(['rps', 'errors', 'latency'])

export function Metrics() {
  const [range, setRange] = useState<TimeRangeId>(DEFAULT_RANGE)
  const [query, setQuery] = useState('')
  const sources = useTelemetrySources()

  const httpSources = sources.data ?? []
  // Only claim "no source" once the probe has actually answered — while it is
  // loading, an empty list would wrongly accuse the cluster.
  const noHttpSource = sources.isSuccess && httpSources.length === 0

  return (
    <div className="space-y-4">
      <Toolbar range={range} onRange={setRange} query={query} onQuery={setQuery} />

      {/* What is feeding the golden signals. An empty request-rate chart means
          something entirely different depending on whether anything on the
          cluster reports HTTP metrics at all, so the page says which. */}
      {!query.trim() ? (
        <TelemetryBanner sources={httpSources} none={noHttpSource} loading={sources.isLoading} />
      ) : null}

      {query.trim() ? (
        <CustomPanel query={query} range={range} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {QUICK_PANELS.map((p) => (
            <MetricPanel
              key={p.id}
              panel={p}
              range={range}
              unavailable={noHttpSource && HTTP_PANEL_IDS.has(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TelemetryBanner({
  sources,
  none,
  loading,
}: {
  sources: Array<{ metric: string; label: string; hint: string }>
  none: boolean
  loading: boolean
}) {
  if (loading) return null
  if (none) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] leading-relaxed text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
        <span className="font-semibold">No HTTP telemetry is being scraped.</span> Prometheus has
        none of the request metric families this page reads, so request rate, error rate and latency
        have nothing to draw — that is not the same as zero traffic. Scrape an ingress controller or
        service mesh, or instrument your services with a Prometheus client library. Saturation
        panels below use cAdvisor and work regardless.
      </div>
    )
  }
  if (!sources.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted">
      <span className="font-medium text-content-subtle">Request metrics from</span>
      {sources.map((s) => (
        <span
          key={s.metric}
          title={`${s.metric} — ${s.hint}`}
          className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-1.5 py-0.5 font-medium text-content"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {s.label}
        </span>
      ))}
    </div>
  )
}

function Toolbar({
  range,
  onRange,
  query,
  onQuery,
}: {
  range: TimeRangeId
  onRange(r: TimeRangeId): void
  query: string
  onQuery(q: string): void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
      <RangeSelect value={range} onChange={onRange} />
      <div className="ml-2 flex flex-1 min-w-0 items-center gap-2">
        <span className="hidden font-mono text-[10px] uppercase tracking-wider text-content-subtle sm:inline">
          PromQL
        </span>
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder='sum by (service) (rate(http_requests_total{service=~".+"}[5m]))'
          className="block min-w-0 flex-1 rounded-md border border-edge-default bg-surface-raised px-2 py-1 font-mono text-[12px] focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQuery('')}
            className="rounded-md px-2 py-1 text-[11px] text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

function RangeSelect({
  value,
  onChange,
}: {
  value: TimeRangeId
  onChange(v: TimeRangeId): void
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-edge-default bg-surface-raised p-1">
      {TIME_RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onChange(r.id)}
          className={
            value === r.id
              ? 'rounded bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700'
              : 'rounded px-2 py-0.5 text-[11px] text-content-muted hover:bg-surface-sunken'
          }
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

/* ─────────── panel ─────────── */

function MetricPanel({
  panel,
  range,
  unavailable = false,
}: {
  panel: typeof QUICK_PANELS[number]
  range: TimeRangeId
  /** No source on this cluster reports the metric family this panel needs. */
  unavailable?: boolean
}) {
  const q = useMetrics(panel.query, range)
  const series = q.data ?? []
  const peak = peakValue(series)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">{panel.label}</div>
            <code className="font-mono text-[10px] text-content-subtle">{panel.query}</code>
          </div>
          <StatusBadge kind="info">{formatUnit(peak, panel.unit)}</StatusBadge>
        </div>
      </CardHeader>
      <CardBody>
        {q.isLoading ? (
          <div className="flex h-32 items-center justify-center text-xs text-content-subtle">
            <Spinner size={12} />
          </div>
        ) : q.isError ? (
          <SourceError compact tool="Prometheus" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />
        ) : series.length === 0 ? (
          // "No data" is ambiguous and, for a golden signal, misleading — it
          // reads as "no traffic". Say which of the two it is.
          <EmptyState
            compact
            title={unavailable ? 'No source for this metric' : 'No data in this range'}
            description={
              unavailable
                ? 'Nothing on this cluster reports the request metrics this panel needs.'
                : undefined
            }
          />
        ) : (
          <SeriesGrid series={series} color={panel.color} unit={panel.unit} />
        )}
      </CardBody>
    </Card>
  )
}

function CustomPanel({ query, range }: { query: string; range: TimeRangeId }) {
  const q = useMetrics(query, range)
  const series = q.data ?? []
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">Custom query</div>
            <code className="font-mono text-[10px] text-content-subtle">{query}</code>
          </div>
          <StatusBadge kind="info">{series.length} series</StatusBadge>
        </div>
      </CardHeader>
      <CardBody>
        {q.isLoading ? (
          <div className="flex h-40 items-center justify-center text-xs text-content-subtle">
            <Spinner size={12} />
          </div>
        ) : q.isError ? (
          <SourceError compact tool="Prometheus" error={q.error} onRetry={() => q.refetch()} icon={<PrometheusIcon size={20} />} />
        ) : series.length === 0 ? (
          <EmptyState compact title="No matching series" description="Refine your PromQL." />
        ) : (
          <SeriesGrid series={series} color="var(--color-brand-500)" unit="rps" tall />
        )}
      </CardBody>
    </Card>
  )
}

function SeriesGrid({
  series,
  color,
  unit,
  tall = false,
}: {
  series: lgtm.MetricSeries[]
  color: string
  unit: 'rps' | 'percent' | 'ms' | 'cpu' | 'bytes'
  tall?: boolean
}) {
  return (
    <div className={`grid gap-3 ${tall ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
      {series.map((s, i) => {
        const points = seriesToPoints(s)
        const last = points[points.length - 1] ?? 0
        const max = Math.max(...points, 0)
        const label = labelFor(s)
        return (
          <div key={i} className="rounded-md border border-edge-subtle bg-surface-sunken/30 p-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-content">{label}</span>
              <span className="font-mono text-[11px] tabular-nums text-content-muted">
                {formatUnit(last, unit)}
              </span>
            </div>
            <AreaChart points={points} color={color} height={tall ? 120 : 56} showAxis={false} />
            <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-content-subtle">
              <span>last {formatUnit(last, unit)}</span>
              <span>peak {formatUnit(max, unit)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function labelFor(s: lgtm.MetricSeries): string {
  return seriesLabel(s.metric)
}

function peakValue(series: lgtm.MetricSeries[]): number {
  let m = 0
  for (const s of series) for (const [, v] of s.values) m = Math.max(m, Number(v))
  return m
}

function formatUnit(v: number, unit: 'rps' | 'percent' | 'ms' | 'cpu' | 'bytes'): string {
  if (!Number.isFinite(v)) return '—'
  switch (unit) {
    case 'rps':
      return `${v.toFixed(v < 10 ? 1 : 0)} rps`
    case 'percent':
      return `${v.toFixed(2)}%`
    case 'ms':
      return `${v.toFixed(0)} ms`
    case 'cpu':
      return `${(v * 1000).toFixed(0)} mCPU`
    case 'bytes': {
      const mib = v / (1024 * 1024)
      if (mib < 1024) return `${mib.toFixed(0)} MiB`
      return `${(mib / 1024).toFixed(1)} GiB`
    }
  }
}
