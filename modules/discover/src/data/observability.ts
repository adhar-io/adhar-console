import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lgtm, posthog } from '@adhar-console/api-clients'
import { useLiveInvalidate, useLivePoll, usePollingInterval } from '@adhar-console/shell-ui'

/**
 * Discover hooks layer — wraps the LGTM stack (Loki / Mimir / Tempo /
 * Grafana / Alertmanager / SLOs) and PostHog analytics.
 *
 * Every hook talks to a real backend through the console BFF tool proxy
 * (`/api/svc/<tool>`, cookie-authenticated). In production builds the queries
 * hit live Prometheus/Mimir, Loki, Tempo, Grafana, Alertmanager and PostHog;
 * the LGTM client falls back to an in-memory fixture only in a non-prod dev
 * build so the views are demoable without a cluster. Views render honest
 * "not configured / unreachable / no data" states (see `views/states.tsx`)
 * whenever a source is absent — no fabricated series or rows.
 */

export const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })
export const phClient = posthog.PostHogClient.auto({ tool: 'posthog' })

const REFRESH_MS = 15_000

/* ─────────── time helpers ─────────── */

export const TIME_RANGES = [
  { id: '5m', label: '5m', ms: 5 * 60_000 },
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60_000 },
] as const
export type TimeRangeId = (typeof TIME_RANGES)[number]['id']
export const DEFAULT_RANGE: TimeRangeId = '1h'

export function rangeToWindow(id: TimeRangeId): { start: Date; end: Date } {
  const ms = TIME_RANGES.find((r) => r.id === id)?.ms ?? 60 * 60_000
  const end = new Date()
  const start = new Date(end.getTime() - ms)
  return { start, end }
}

/**
 * A time selection is either one of the quick presets or an absolute
 * from/to window (ISO strings so it hashes stably into a query key).
 */
export type TimeSelection =
  | { kind: 'preset'; id: TimeRangeId }
  | { kind: 'absolute'; from: string; to: string }

export const presetSelection = (id: TimeRangeId): TimeSelection => ({ kind: 'preset', id })

export function selectionToWindow(sel: TimeSelection): { start: Date; end: Date } {
  if (sel.kind === 'absolute') return { start: new Date(sel.from), end: new Date(sel.to) }
  return rangeToWindow(sel.id)
}

/** Human label for the toolbar / histogram header. */
export function selectionLabel(sel: TimeSelection): string {
  if (sel.kind === 'preset') return `last ${TIME_RANGES.find((r) => r.id === sel.id)?.label ?? sel.id}`
  const f = new Date(sel.from)
  const t = new Date(sel.to)
  const fmt = (d: Date) =>
    `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${fmt(f)} → ${fmt(t)}`
}

/* ─────────── LGTM ─────────── */

export interface LogsOptions {
  /** Live tail: refetch every few seconds with a window that ends "now". */
  live?: boolean
  direction?: 'backward' | 'forward'
  enabled?: boolean
}

export const LIVE_REFRESH_MS = 4_000

export function useLogs(query: string, sel: TimeSelection, limit = 200, opts: LogsOptions = {}) {
  // Loki (LogQL) requires a non-empty stream selector — never fire an empty
  // query against a real backend; the view prompts for one instead.
  const enabled = (opts.enabled ?? true) && query.trim().length > 0
  const queryKey = ['lgtm', 'logs', query, sel, limit, opts.direction ?? 'backward']
  // Live tail / presets: the BFF re-runs the sliding query_range server-side
  // and pushes only when the result changes — the browser stops polling.
  const presetMs = sel.kind === 'preset' ? (TIME_RANGES.find((r) => r.id === sel.id)?.ms ?? 0) : 0
  useLivePoll(
    'loki',
    `/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start={start}&end={end}&limit=${limit}&direction=${opts.direction ?? 'backward'}`,
    opts.live ? LIVE_REFRESH_MS : REFRESH_MS,
    queryKey,
    { windowMs: presetMs, enabled: enabled && sel.kind === 'preset', map: lokiToEntries },
  )
  const pollMs = usePollingInterval(opts.live ? LIVE_REFRESH_MS : REFRESH_MS)
  return useQuery({
    queryKey,
    // The window is computed inside queryFn so a preset like "last 15m"
    // slides forward on every background refetch (live tail), instead of
    // freezing at the moment the component last rendered.
    queryFn: () => {
      const { start, end } = selectionToWindow(sel)
      return lgtmClient.queryLogs(query, start, end, limit, opts.direction ?? 'backward')
    },
    refetchInterval: sel.kind === 'preset' ? pollMs : false,
    placeholderData: keepPreviousData,
    enabled,
  })
}

/** Raw Loki query_range body → LogEntry[] (same mapping as the client). */
function lokiToEntries(body: unknown): lgtm.LogEntry[] {
  const res = body as { data?: { result?: Array<{ values: [string, string][]; stream: Record<string, string> }> } }
  return (res?.data?.result ?? []).flatMap((stream) =>
    stream.values.map(([ts, msg]) => ({
      timestamp: new Date(Number(ts) / 1e6).toISOString(),
      level: lgtm.detectLogLevel(msg, stream.stream),
      message: msg,
      labels: stream.stream,
    })),
  )
}

/** Loki label names in the selected window — drives the label browser. */
export function useLogLabels(sel: TimeSelection, enabled = true) {
  return useQuery({
    queryKey: ['lgtm', 'log-labels', selectionLabel(sel)],
    queryFn: () => {
      const { start, end } = selectionToWindow(sel)
      return lgtmClient.listLogLabels(start, end)
    },
    staleTime: 60_000,
    enabled,
  })
}

/** Values of one label in the window, narrowed by the current selector when given. */
export function useLogLabelValues(label: string | null, sel: TimeSelection, selector?: string) {
  return useQuery({
    queryKey: ['lgtm', 'log-label-values', label, selectionLabel(sel), selector ?? ''],
    queryFn: () => {
      const { start, end } = selectionToWindow(sel)
      return lgtmClient.listLogLabelValues(label!, start, end, selector || undefined)
    },
    staleTime: 60_000,
    enabled: !!label,
  })
}

/* ─────────── log volume histogram (derived from real logs) ─────────── */

/** One time bucket of the log-volume histogram, split by level bucket. */
export interface HistogramBucket {
  /** epoch ms — bucket start / end. */
  start: number
  end: number
  info: number
  warn: number
  error: number
}

export type HistogramLevel = 'info' | 'warn' | 'error'
export const HISTOGRAM_LEVELS: HistogramLevel[] = ['error', 'warn', 'info']

/** Collapse a log entry's level onto one of the three histogram buckets. */
function histogramLevelOf(level: lgtm.LogEntry['level']): HistogramLevel {
  if (level === 'error' || level === 'fatal') return 'error'
  if (level === 'warn') return 'warn'
  return 'info'
}

/**
 * Bucket real log lines by timestamp across [start, end), split by level.
 * This is the actual observed volume of the returned stream — no synthetic
 * fill — so a sparse stream renders sparsely and an error burst shows up
 * exactly where it happened.
 */
export function bucketLogsByLevel(
  logs: lgtm.LogEntry[],
  start: Date,
  end: Date,
  buckets = 48,
): HistogramBucket[] {
  const t0 = start.getTime()
  const t1 = end.getTime()
  const width = Math.max(1, t1 - t0) / buckets
  const out: HistogramBucket[] = []
  for (let i = 0; i < buckets; i++) {
    out.push({ start: t0 + i * width, end: t0 + (i + 1) * width, info: 0, warn: 0, error: 0 })
  }
  for (const l of logs) {
    const t = new Date(l.timestamp).getTime()
    if (Number.isNaN(t) || t < t0 || t > t1) continue
    let idx = Math.floor((t - t0) / width)
    if (idx < 0) idx = 0
    if (idx >= buckets) idx = buckets - 1
    out[idx][histogramLevelOf(l.level)] += 1
  }
  return out
}

/**
 * Golden-signal PromQL that works on a real cluster. Each expression unions
 * (`or`) the metric families the platform may expose — Gateway API / Envoy
 * (Cilium, Envoy Gateway), NGINX ingress, Hubble L7, plain `http_*` app
 * metrics — so whichever exists answers, grouped by `service` (falling back
 * to the label the family provides). Saturation uses cAdvisor, which every
 * kubelet exposes.
 */
/**
 * Golden-signal queries, one variant per telemetry source.
 *
 * Each variant groups by a label the metric family **actually carries**. The
 * previous version forced every source into a synthetic `service` label with
 * `label_replace(..., "<src>", "(.+)")`, which fails silently and badly: when
 * the source label does not exist, `label_replace` copies nothing and the
 * `sum by (service)` collapses every series into one anonymous `{}` bucket. On
 * a cluster whose only HTTP source is Hubble — whose `http_requests_total`
 * carries `namespace`/`pod`/`method`/`status` and no `destination` — the chart
 * showed a single unlabelled line instead of either real per-service traffic
 * or an honest empty panel.
 *
 * `seriesLabel()` picks the best label present on whatever comes back, so each
 * variant can group naturally instead of being coerced.
 */
export const PROMQL = {
  rps: [
    'sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total[5m]))',
    'sum by (service) (rate(nginx_ingress_controller_requests[5m]))',
    'sum by (namespace, pod) (rate(hubble_http_requests_total[5m]))',
    'sum by (service) (rate(http_requests_total[5m]))',
    'sum by (job) (rate(http_server_requests_seconds_count[5m]))',
  ].join(' or '),
  errorRate: [
    '100 * sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_xx{envoy_response_code_class="5"}[5m])) / sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total[5m]))',
    '100 * sum by (service) (rate(nginx_ingress_controller_requests{status=~"5.."}[5m])) / sum by (service) (rate(nginx_ingress_controller_requests[5m]))',
    '100 * sum by (namespace) (rate(hubble_http_requests_total{status=~"5.."}[5m])) / sum by (namespace) (rate(hubble_http_requests_total[5m]))',
    '100 * sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) / sum by (service) (rate(http_requests_total[5m]))',
  ].join(' or '),
  latencyP95: [
    '1000 * histogram_quantile(0.95, sum by (le, envoy_cluster_name) (rate(envoy_cluster_upstream_rq_time_bucket[5m])))',
    '1000 * histogram_quantile(0.95, sum by (le, service) (rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])))',
    '1000 * histogram_quantile(0.95, sum by (le, namespace) (rate(hubble_http_request_duration_seconds_bucket[5m])))',
    '1000 * histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))',
  ].join(' or '),
  cpu: 'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m]))',
  memory: 'sum by (namespace) (container_memory_working_set_bytes{container!="", container!="POD"})',
  podRestarts: 'sum by (namespace) (increase(kube_pod_container_status_restarts_total[1h]))',
} as const

/**
 * Metric families the golden-signal panels depend on, in preference order.
 * `useTelemetrySources()` probes which of these Prometheus actually has, so a
 * panel with no data can say *why* — "no ingress or mesh exporter is scraped"
 * — instead of rendering an empty chart that reads as "zero traffic".
 */
export const HTTP_SOURCES: Array<{ metric: string; label: string; hint: string }> = [
  { metric: 'envoy_cluster_upstream_rq_total', label: 'Envoy / Istio', hint: 'service mesh sidecars' },
  { metric: 'nginx_ingress_controller_requests', label: 'NGINX Ingress', hint: 'ingress controller metrics' },
  { metric: 'hubble_http_requests_total', label: 'Cilium Hubble', hint: 'eBPF L7 visibility' },
  { metric: 'http_requests_total', label: 'Application', hint: 'Prometheus client library' },
  { metric: 'http_server_requests_seconds_count', label: 'Spring / Micrometer', hint: 'JVM actuator metrics' },
]

/** Best display label for a series: service → namespace → job/pod/instance → __name__. */
export function seriesLabel(metric: Record<string, string | undefined>): string {
  return metric.service || metric.namespace || metric.job || metric.pod || metric.instance || metric.__name__ || 'series'
}

/**
 * Which HTTP telemetry sources Prometheus is actually scraping.
 *
 * Asks Prometheus for the metric names it knows about and intersects them with
 * `HTTP_SOURCES`. This is what lets a golden-signal panel distinguish "this
 * service had no traffic in the window" from "nothing on this cluster reports
 * HTTP metrics at all" — two states that look identical on an empty chart and
 * mean completely different things.
 */
export function useTelemetrySources() {
  return useQuery({
    queryKey: ['lgtm', 'telemetry-sources'],
    queryFn: async () => {
      const res = await fetch('/api/svc/prometheus/api/v1/label/__name__/values', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Prometheus ${res.status} listing metric names`)
      const body = (await res.json()) as { data?: string[] }
      const present = new Set(body.data ?? [])
      return HTTP_SOURCES.filter((s) => present.has(s.metric))
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useMetrics(query: string, range: TimeRangeId, step = '1m') {
  const queryKey = ['lgtm', 'metrics', query, range, step]
  const windowMs = TIME_RANGES.find((r) => r.id === range)?.ms ?? 60 * 60_000
  // Prometheus is pull-only: the BFF runs the sliding range query and pushes
  // the series only when they change, so the tab itself never polls.
  useLivePoll<lgtm.MetricSeries[]>(
    'prometheus',
    `/api/v1/query_range?query=${encodeURIComponent(query)}&start={start}&end={end}&step=${step}`,
    REFRESH_MS,
    queryKey,
    { windowMs, enabled: !!query, map: (b) => ((b as { data?: { result?: lgtm.MetricSeries[] } })?.data?.result ?? []) },
  )
  const pollMs = usePollingInterval(REFRESH_MS)
  return useQuery({
    queryKey,
    queryFn: () => {
      const { start, end } = rangeToWindow(range)
      return lgtmClient.queryMetrics(query, start, end, step)
    },
    refetchInterval: pollMs,
    placeholderData: keepPreviousData,
  })
}

export function useTraces(filter: { service?: string; minDurationMs?: number; status?: 'error' | 'ok' }) {
  return useQuery({
    queryKey: ['lgtm', 'traces', filter],
    queryFn: () => lgtmClient.searchTraces(filter),
    refetchInterval: REFRESH_MS,
  })
}

/* ─────────── span detail ─────────── */

/**
 * A timestamped event recorded during a span (OTel span event) and a span
 * carrying its real attributes, status message, and events — both sourced
 * straight from the Tempo trace response the LGTM client parses.
 */
export type SpanEvent = lgtm.SpanEvent
export type SpanDetail = lgtm.Span

export function useTrace(traceID?: string) {
  return useQuery({
    queryKey: ['lgtm', 'trace', traceID],
    queryFn: (): Promise<SpanDetail[]> => lgtmClient.getTrace(traceID!),
    enabled: !!traceID,
  })
}

export function useServiceMap() {
  return useQuery({
    queryKey: ['lgtm', 'service-map'],
    queryFn: () => lgtmClient.serviceMap(),
    staleTime: 30_000,
  })
}

export function useServices() {
  return useQuery({
    queryKey: ['lgtm', 'services'],
    queryFn: () => lgtmClient.listServices(),
    staleTime: 30_000,
  })
}

export function useAlerts() {
  const pollMs = usePollingInterval(REFRESH_MS)
  // Alertmanager/Prometheus are pull-only: the BFF watches `/api/v1/alerts`
  // for changes and we refetch (the client mapping enriches with rule exprs).
  useLiveInvalidate('poll', { tool: 'prometheus', path: '/api/v1/alerts', intervalMs: REFRESH_MS }, [['lgtm', 'alerts']])
  return useQuery({
    queryKey: ['lgtm', 'alerts'],
    queryFn: () => lgtmClient.listAlerts(),
    refetchInterval: pollMs,
  })
}

export function useSilenceAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ fingerprint, durationMin }: { fingerprint: string; durationMin: number }) =>
      lgtmClient.silenceAlert(fingerprint, durationMin),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lgtm', 'alerts'] }),
  })
}

export function useSlos() {
  return useQuery({
    queryKey: ['lgtm', 'slos'],
    queryFn: () => lgtmClient.listSlos(),
    refetchInterval: 30_000,
  })
}

export function useGrafanaDashboards() {
  return useQuery({
    queryKey: ['lgtm', 'dashboards'],
    queryFn: () => lgtmClient.listDashboards(),
    staleTime: 60_000,
  })
}

export function grafanaEmbedUrl(uid: string, params?: Record<string, string>) {
  return lgtmClient.grafanaEmbedUrl(uid, params)
}

/* ─────────── PostHog ─────────── */

export function useAnalyticsEvents(filter?: { event?: string; sinceMs?: number }) {
  return useQuery({
    queryKey: ['posthog', 'events', filter?.event ?? 'all', filter?.sinceMs ?? 0],
    queryFn: () => phClient.listEvents(filter),
    refetchInterval: REFRESH_MS,
  })
}

export function usePersons(search?: string) {
  return useQuery({
    queryKey: ['posthog', 'persons', search ?? ''],
    queryFn: () => phClient.listPersons({ search }),
    staleTime: 30_000,
  })
}

export function useInsights(type?: posthog.InsightType) {
  return useQuery({
    queryKey: ['posthog', 'insights', type ?? 'all'],
    queryFn: () => phClient.listInsights(type ? { type } : undefined),
    staleTime: 30_000,
  })
}

export function useInsight(id?: string) {
  return useQuery({
    queryKey: ['posthog', 'insight', id],
    queryFn: () => phClient.getInsight(id!),
    enabled: !!id,
    staleTime: 30_000,
  })
}

export function useCohorts() {
  return useQuery({
    queryKey: ['posthog', 'cohorts'],
    queryFn: () => phClient.listCohorts(),
    staleTime: 60_000,
  })
}

export function useFeatureFlags() {
  return useQuery({
    queryKey: ['posthog', 'flags'],
    queryFn: () => phClient.listFeatureFlags(),
    staleTime: 60_000,
  })
}

export function useToggleFlag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      phClient.toggleFeatureFlag(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['posthog', 'flags'] }),
  })
}

export function useSessions(filter?: { hasErrors?: boolean }) {
  return useQuery({
    queryKey: ['posthog', 'sessions', filter?.hasErrors ?? false],
    queryFn: () => phClient.listSessions(filter),
    refetchInterval: 30_000,
  })
}

/* ─────────── series helpers ─────────── */

/** MetricSeries values → AreaChart points. */
export function seriesToPoints(s: lgtm.MetricSeries): number[] {
  return s.values.map(([, v]) => Number(v))
}
