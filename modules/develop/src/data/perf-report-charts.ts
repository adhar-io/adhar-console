/**
 * The charts of a run report: what k6 measured over time (when it
 * remote-writes), what the application under load was doing (its pods' CPU,
 * memory, request rate and latency — the shared `runMetricQueries`, the same
 * selector the chaos reports and the resilience runner use), and the load
 * generators' own CPU, all over ONE window: the run, padded a minute either
 * side so the steady state before and after is visible.
 *
 * Nothing is synthesised: a query that returns nothing becomes a "not
 * charted, because…" line, never a flat zero.
 *
 * Pure: queries in, chart data out. The React hook lives in perf-run.ts.
 */

import { type MetricPoint, missingReason, podRegexForApp, rateFor, runMetricQueries, stepFor } from '@adhar/utils'
import { k6RemoteQueries, runnerResourceQueries } from './perf-live.ts'
import type { ReportChart, ReportCharts } from './perf-run-report.ts'

export const REPORT_PAD_MS = 60_000

export interface ChartQuery {
  chart: string
  title: string
  source: string
  unit: ReportChart['unit']
  series: string
  color: string
  query: string
  scale?: number
  yMax?: number
}

export interface ReportChartInput {
  run: string
  /** Namespace of the run (and its runner pods). */
  namespace: string
  /** The application the test drives, when recorded (`adhar.io/application`). */
  application?: string
  /** Where that application runs; defaults to the run's namespace. */
  targetNamespace?: string
  startMs: number
  endMs: number
}

export function reportWindow(startMs: number, endMs: number): { start: number; end: number; step: number } {
  const start = startMs - REPORT_PAD_MS
  const end = endMs + REPORT_PAD_MS
  return { start, end, step: stepFor(start, end, 120, 10) }
}

/** Every query a report charts, grouped into charts. */
export function reportChartQueries(i: ReportChartInput): ChartQuery[] {
  const { step } = reportWindow(i.startMs, i.endMs)
  const out: ChartQuery[] = []
  const k6 = new Map(k6RemoteQueries(i.run).map((q) => [`${q.chart}:${q.series}`, q]))
  const add = (key: string, q: Omit<ChartQuery, 'query' | 'scale'>) => {
    const src = k6.get(key)
    if (src) out.push({ ...q, query: src.query, scale: src.scale })
  }
  add('vus:VUs', { chart: 'k6-load', title: 'Virtual users', source: 'k6', unit: 'count', series: 'VUs', color: '#6366f1' })
  add('rps:requests/s', { chart: 'k6-rps', title: 'Request rate (k6)', source: 'k6', unit: 'rps', series: 'requests/s', color: '#4f46e5' })
  add('latency:p50', { chart: 'k6-latency', title: 'Latency (k6)', source: 'k6', unit: 'ms', series: 'p50', color: '#0284c7' })
  add('latency:p95', { chart: 'k6-latency', title: 'Latency (k6)', source: 'k6', unit: 'ms', series: 'p95', color: '#d97706' })
  add('latency:p99', { chart: 'k6-latency', title: 'Latency (k6)', source: 'k6', unit: 'ms', series: 'p99', color: '#e11d48' })
  add('errors:failed requests', { chart: 'k6-errors', title: 'Failed requests (k6)', source: 'k6', unit: 'percent', series: 'failed', color: '#e11d48' })

  if (i.application) {
    const target = `${i.application} pods`
    const qs = new Map(runMetricQueries({ namespace: i.targetNamespace || i.namespace, podRegex: podRegexForApp(i.application), rate: rateFor(step) }).map((q) => [q.id, q.query]))
    const app = (id: string, q: Omit<ChartQuery, 'query' | 'source'>) => {
      const query = qs.get(id as never)
      if (query) out.push({ ...q, source: target, query })
    }
    app('cpu', { chart: 'target-cpu', title: 'Target CPU', unit: 'cores', series: 'CPU', color: '#0284c7' })
    app('memory', { chart: 'target-memory', title: 'Target memory', unit: 'bytes', series: 'working set', color: '#7c3aed' })
    app('rps', { chart: 'target-rps', title: 'Target request rate', unit: 'rps', series: 'requests/s', color: '#4f46e5' })
    app('p95', { chart: 'target-latency', title: 'Target p95 latency', unit: 'ms', series: 'p95', color: '#d97706' })
    app('errors', { chart: 'target-errors', title: 'Target 5xx rate', unit: 'percent', series: '5xx', color: '#e11d48' })
    app('ready', { chart: 'target-ready', title: 'Target ready pods', unit: 'count', series: 'ready', color: '#059669' })
  }

  const cpu = runnerResourceQueries(i.run, i.namespace).find((q) => q.chart === 'cpu')
  if (cpu) out.push({ chart: 'runner-cpu', title: 'Load generator CPU', source: 'k6 runner pods', unit: 'cores', series: 'CPU', color: '#64748b', query: cpu.query })
  return out
}

/** `The application exports…` → `the application exports…`, for "not charted — …". */
const clause = (s: string) => s.replace(/\.$/, '').replace(/^(The|An?) /, (w) => w.toLowerCase())

/** Why a chart came back empty, in words someone can act on. */
function emptyReason(chart: string): string {
  if (chart.startsWith('k6-')) return 'the run does not remote-write k6 metrics to Prometheus (--out experimental-prometheus-rw)'
  if (chart === 'target-rps' || chart === 'target-latency' || chart === 'target-errors') return clause(missingReason('rps'))
  if (chart === 'target-ready') return clause(missingReason('ready'))
  if (chart === 'runner-cpu') return 'the runner pods were not scraped in this window'
  return clause(missingReason('cpu'))
}

/**
 * Shape query answers (in `queries` order; `undefined` = failed or empty)
 * into the report's charts. k6 charts with no samples at all collapse into a
 * single "not charted" line rather than four.
 */
export function chartsFromAnswers(
  i: ReportChartInput,
  queries: ChartQuery[],
  answers: Array<MetricPoint[] | undefined>,
): ReportCharts {
  const { start, end } = reportWindow(i.startMs, i.endMs)
  const charts = new Map<string, ReportChart>()
  const empty = new Map<string, ChartQuery>()
  queries.forEach((q, k) => {
    const pts = (answers[k] ?? []).map(([t, v]): MetricPoint => [t, v * (q.scale ?? 1)]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && t >= start && t <= end)
    if (pts.length < 2) {
      if (!charts.has(q.chart)) empty.set(q.chart, q)
      return
    }
    empty.delete(q.chart)
    const c = charts.get(q.chart) ?? { id: q.chart, title: q.title, unit: q.unit, source: q.source, series: [], yMax: q.unit === 'percent' ? undefined : q.yMax }
    c.series.push({ label: q.series, color: q.color, points: pts })
    charts.set(q.chart, c)
  })
  const missing: ReportCharts['missing'] = []
  const k6Empty = [...empty.keys()].filter((c) => c.startsWith('k6-'))
  if (k6Empty.length && ![...charts.keys()].some((c) => c.startsWith('k6-'))) {
    missing.push({ label: 'k6 metrics over time', reason: emptyReason('k6-load') })
  }
  const targetHttp = ['target-rps', 'target-latency', 'target-errors'].filter((c) => empty.has(c))
  if (targetHttp.length === 3) missing.push({ label: 'Target request rate, latency and errors', reason: emptyReason('target-rps') })
  for (const [chart, q] of empty) {
    if (chart.startsWith('k6-') || (targetHttp.length === 3 && targetHttp.includes(chart))) continue
    missing.push({ label: q.title, reason: emptyReason(chart) })
  }
  if (!i.application) missing.push({ label: 'The application under load', reason: 'the run does not record which application it drives (adhar.io/application)' })
  return { domain: [start, end], load: { start: i.startMs, end: i.endMs }, charts: [...charts.values()], missing }
}
