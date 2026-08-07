import { z } from 'zod'
import { HttpClient, isProdBuild, svcBaseUrl, type HttpClientOptions } from '../base/index.ts'

/**
 * Loki + Grafana + Mimir + Tempo (LGTM) aggregator.
 *
 * One client for the whole observability stack — the BFF fans out per
 * tenant to the right backend. Schemas mirror the upstream shapes
 * (Prometheus instant/range, Loki log streams, Tempo trace search,
 * Alertmanager, Pyrra-style SLOs) so the views render real data when
 * pointed at production.
 */

/* ─────────── logs ─────────── */

export const LogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).optional(),
  message: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
})
export type LogEntry = z.infer<typeof LogEntrySchema>

/* ─────────── metrics ─────────── */

export const MetricSeriesSchema = z.object({
  metric: z.record(z.string(), z.string()),
  values: z.array(z.tuple([z.number(), z.string()])),
})
export type MetricSeries = z.infer<typeof MetricSeriesSchema>

/* ─────────── traces ─────────── */

export const TraceSchema = z.object({
  traceID: z.string(),
  rootServiceName: z.string(),
  rootTraceName: z.string(),
  startTimeUnixNano: z.string(),
  durationMs: z.number(),
  spanCount: z.number(),
  status: z.enum(['ok', 'error']).optional(),
})
export type Trace = z.infer<typeof TraceSchema>

/** A timestamped event/log recorded during a span (OTel span event). */
export const SpanEventSchema = z.object({
  /** Offset in ms from the span's own start. */
  timeMs: z.number(),
  name: z.string(),
  attributes: z.record(z.string(), z.string()).optional(),
})
export type SpanEvent = z.infer<typeof SpanEventSchema>

export const SpanSchema = z.object({
  spanID: z.string(),
  parentSpanID: z.string().optional(),
  serviceName: z.string(),
  operationName: z.string(),
  startTimeMs: z.number(),
  durationMs: z.number(),
  status: z.enum(['ok', 'error']).optional(),
  /** Span status message (e.g. the OTel status description on errors). */
  statusMessage: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  events: z.array(SpanEventSchema).optional(),
})
export type Span = z.infer<typeof SpanSchema>

/* ─────────── service map ─────────── */

export const ServiceNodeSchema = z.object({
  name: z.string(),
  language: z.string().optional(),
  rps: z.number(),
  errorRate: z.number(),
  p95Ms: z.number(),
  /** Apdex score 0..1 — derived. */
  apdex: z.number().optional(),
})
export type ServiceNode = z.infer<typeof ServiceNodeSchema>

export const ServiceEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  rps: z.number(),
  errorRate: z.number(),
  p95Ms: z.number(),
})
export type ServiceEdge = z.infer<typeof ServiceEdgeSchema>

/* ─────────── alerts ─────────── */

export const AlertStateSchema = z.enum(['firing', 'pending', 'resolved'])
export type AlertState = z.infer<typeof AlertStateSchema>

export const AlertSeveritySchema = z.enum(['critical', 'warning', 'info'])
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>

export const AlertSchema = z.object({
  fingerprint: z.string(),
  name: z.string(),
  state: AlertStateSchema,
  severity: AlertSeveritySchema,
  summary: z.string().optional(),
  description: z.string().optional(),
  runbook_url: z.string().optional(),
  labels: z.record(z.string(), z.string()),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  /** Last value of the alert expression. */
  value: z.number().optional(),
  expression: z.string().optional(),
})
export type Alert = z.infer<typeof AlertSchema>

/* ─────────── SLOs ─────────── */

export const SloSchema = z.object({
  name: z.string(),
  service: z.string(),
  /** Indicator description e.g. "HTTP 2xx/3xx ratio". */
  indicator: z.string(),
  objective: z.number(),
  /** Window in days. */
  window: z.number(),
  current: z.number(),
  errorBudgetRemaining: z.number(),
  /** 1h burn-rate vs short window. */
  burnRate1h: z.number(),
  burnRate6h: z.number(),
  /** History of objective adherence (latest first). */
  history: z.array(z.number()),
})
export type Slo = z.infer<typeof SloSchema>

/* ─────────── client ─────────── */

export interface LgtmClient {
  queryLogs(query: string, start: Date, end: Date, limit?: number): Promise<LogEntry[]>
  queryMetrics(query: string, start: Date, end: Date, step: string): Promise<MetricSeries[]>
  searchTraces(filter: { service?: string; minDurationMs?: number; status?: 'error' | 'ok' }): Promise<Trace[]>
  getTrace(traceID: string): Promise<Span[]>
  listServices(): Promise<ServiceNode[]>
  serviceMap(): Promise<{ nodes: ServiceNode[]; edges: ServiceEdge[] }>
  listAlerts(): Promise<Alert[]>
  silenceAlert(fingerprint: string, durationMin: number): Promise<void>
  listSlos(): Promise<Slo[]>
  grafanaEmbedUrl(dashboardUid: string, params?: Record<string, string>): string
  listDashboards(): Promise<Array<{ uid: string; title: string; tags: string[]; folder?: string }>>
}

/* ─────────── OTLP trace parsing ─────────── */

/**
 * Tempo's trace-by-id endpoint (`GET /api/traces/{id}`) returns OTLP
 * resource/scope spans. These interfaces mirror the subset we read; the
 * parser flattens them into the flat {@link Span} shape the views render,
 * keeping real attributes, status, and span events.
 */
interface OtlpAnyValue {
  stringValue?: string
  intValue?: string | number
  boolValue?: boolean
  doubleValue?: number
  bytesValue?: string
  arrayValue?: { values?: OtlpAnyValue[] }
  kvlistValue?: { values?: OtlpKeyValue[] }
}
interface OtlpKeyValue {
  key?: string
  value?: OtlpAnyValue
}
interface OtlpSpanEvent {
  timeUnixNano?: string | number
  name?: string
  attributes?: OtlpKeyValue[]
}
interface OtlpSpan {
  spanId?: string
  spanID?: string
  parentSpanId?: string
  parentSpanID?: string
  name?: string
  startTimeUnixNano?: string | number
  endTimeUnixNano?: string | number
  attributes?: OtlpKeyValue[]
  status?: { code?: number | string; message?: string }
  events?: OtlpSpanEvent[]
}
interface OtlpScopeSpans {
  spans?: OtlpSpan[]
}
interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] }
  scopeSpans?: OtlpScopeSpans[]
  instrumentationLibrarySpans?: OtlpScopeSpans[]
}
interface OtlpTraceResponse {
  batches?: OtlpResourceSpans[]
  resourceSpans?: OtlpResourceSpans[]
}

function anyValueToString(v?: OtlpAnyValue): string {
  if (!v) return ''
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return String(v.intValue)
  if (v.boolValue !== undefined) return String(v.boolValue)
  if (v.doubleValue !== undefined) return String(v.doubleValue)
  if (v.bytesValue !== undefined) return v.bytesValue
  if (v.arrayValue) return JSON.stringify((v.arrayValue.values ?? []).map(anyValueToString))
  if (v.kvlistValue) return JSON.stringify(flattenAttrs(v.kvlistValue.values))
  return ''
}

function flattenAttrs(kvs?: OtlpKeyValue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of kvs ?? []) if (kv.key) out[kv.key] = anyValueToString(kv.value)
  return out
}

/** OTLP status code → our two-state status (UNSET → undefined). */
function statusFromCode(code?: number | string): Span['status'] {
  if (code === 2 || code === 'STATUS_CODE_ERROR' || code === 'ERROR') return 'error'
  if (code === 1 || code === 'STATUS_CODE_OK' || code === 'OK') return 'ok'
  return undefined
}

function parseOtlpTrace(res: OtlpTraceResponse): Span[] {
  const batches = res.batches ?? res.resourceSpans ?? []
  const collected: Array<{ span: OtlpSpan; serviceName: string; startMs: number }> = []
  for (const batch of batches) {
    const serviceName = flattenAttrs(batch.resource?.attributes)['service.name'] ?? 'unknown'
    const scopes = batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []
    for (const scope of scopes) {
      for (const span of scope.spans ?? []) {
        collected.push({ span, serviceName, startMs: Number(span.startTimeUnixNano ?? 0) / 1e6 })
      }
    }
  }
  // Span offsets are relative to the earliest span start in the trace.
  const traceStartMs = collected.length ? Math.min(...collected.map((c) => c.startMs)) : 0
  return collected.map(({ span, serviceName, startMs }) => {
    const endMs = Number(span.endTimeUnixNano ?? span.startTimeUnixNano ?? 0) / 1e6
    const tags = flattenAttrs(span.attributes)
    const events: SpanEvent[] = (span.events ?? []).map((ev) => {
      const attrs = flattenAttrs(ev.attributes)
      return {
        timeMs: Math.max(0, Number(ev.timeUnixNano ?? 0) / 1e6 - startMs),
        name: ev.name ?? '',
        attributes: Object.keys(attrs).length ? attrs : undefined,
      }
    })
    return {
      spanID: span.spanId ?? span.spanID ?? '',
      parentSpanID: (span.parentSpanId ?? span.parentSpanID) || undefined,
      serviceName,
      operationName: span.name ?? '',
      startTimeMs: Math.max(0, startMs - traceStartMs),
      durationMs: Math.max(0, endMs - startMs),
      status: statusFromCode(span.status?.code),
      statusMessage: span.status?.message || undefined,
      tags: Object.keys(tags).length ? tags : undefined,
      events: events.length ? events : undefined,
    }
  })
}

function build(http: HttpClient, grafanaUrl: string): LgtmClient {
  return {
    queryLogs: async (query, start, end, limit = 500) => {
      const res = await http.get<{
        data: { result: { values: [string, string][]; stream: Record<string, string> }[] }
      }>(
        `/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start.toISOString()}&end=${end.toISOString()}&limit=${limit}`,
      )
      return res.data.result.flatMap((stream) =>
        stream.values.map(([ts, msg]) => ({
          timestamp: new Date(Number(ts) / 1e6).toISOString(),
          message: msg,
          labels: stream.stream,
        })),
      )
    },
    queryMetrics: async (query, start, end, step) => {
      const res = await http.get<{ data: { result: MetricSeries[] } }>(
        `/prometheus/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start.toISOString()}&end=${end.toISOString()}&step=${step}`,
      )
      return res.data.result
    },
    searchTraces: async (filter) => {
      const qs = new URLSearchParams()
      if (filter.service) qs.set('tags', `service.name=${filter.service}`)
      if (filter.minDurationMs) qs.set('minDuration', `${filter.minDurationMs}ms`)
      if (filter.status === 'error') qs.set('tags', `${qs.get('tags') ?? ''} status.code=error`.trim())
      const res = await http.get<{ traces: Trace[] }>(`/api/search?${qs}`)
      return res.traces
    },
    getTrace: async (id) => {
      const res = await http.get<OtlpTraceResponse>(`/api/traces/${id}`)
      return parseOtlpTrace(res)
    },
    listServices: async () => {
      const res = await http.get<{ services: ServiceNode[] }>(`/api/services`)
      return res.services
    },
    serviceMap: async () => {
      return await http.get<{ nodes: ServiceNode[]; edges: ServiceEdge[] }>(`/api/service-map`)
    },
    listAlerts: async () => {
      const res = await http.get<Alert[]>(`/alertmanager/api/v2/alerts`)
      return res
    },
    silenceAlert: async (fingerprint, durationMin) => {
      await http.post<void>(`/alertmanager/api/v2/silences`, {
        matchers: [{ name: 'fingerprint', value: fingerprint, isRegex: false }],
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + durationMin * 60_000).toISOString(),
        comment: 'Silenced from Adhar Console',
      })
    },
    listSlos: async () => {
      const res = await http.get<{ slos: Slo[] }>(`/api/slos`)
      return res.slos
    },
    grafanaEmbedUrl: (uid, params = {}) => {
      const qs = new URLSearchParams({ kiosk: 'tv', ...params })
      return `${grafanaUrl.replace(/\/$/, '')}/d/${uid}?${qs}`
    },
    listDashboards: async () => {
      const res = await http.get<Array<{ uid: string; title: string; tags: string[]; folderTitle?: string }>>(
        `/api/search?type=dash-db`,
      )
      return res.map((d) => ({ uid: d.uid, title: d.title, tags: d.tags, folder: d.folderTitle }))
    },
  }
}

/* ─────────── stub data ─────────── */

const now = Date.now()
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()
const secondsAgo = (s: number) => new Date(now - s * 1000).toISOString()

/** Stable smooth-ish series generator for chart aesthetics. */
function genSeries(opts: {
  count: number
  min: number
  max: number
  /** 0..1 — higher = more wiggle. */
  noise?: number
  trend?: 'up' | 'down' | 'flat'
  seed?: number
}) {
  const { count, min, max, noise = 0.25, trend = 'flat', seed = 42 } = opts
  let s = seed
  const rand = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  const span = max - min
  const trendStep = trend === 'up' ? span * 0.3 : trend === 'down' ? -span * 0.3 : 0
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const baseline = min + span * 0.5 + (trendStep * i) / count
    const wave = Math.sin((i / count) * Math.PI * 4) * span * 0.18
    const wiggle = (rand() - 0.5) * span * noise
    out.push(Math.max(min, Math.min(max, baseline + wave + wiggle)))
  }
  return out
}

const SERVICES = ['adhar-console', 'platform-bff', 'billing-service', 'customer-portal', 'auth-service']

const STUB_LOGS: LogEntry[] = (() => {
  const lines: Array<Pick<LogEntry, 'level' | 'message' | 'labels'>> = [
    { level: 'info', message: 'Listening on :8080', labels: { app: 'adhar-console', pod: 'adhar-console-7f8b8d5c4-xq2ws', namespace: 'acme-console' } },
    { level: 'info', message: 'Reconciled application "adhar-console" (sync=Synced health=Healthy)', labels: { app: 'argocd-app-controller', namespace: 'argocd' } },
    { level: 'warn', message: 'Slow database query (523ms) SELECT * FROM invoices WHERE customer_id=?', labels: { app: 'billing-service', pod: 'billing-service-5b4c6d8e9-k7fvr', namespace: 'acme-billing' } },
    { level: 'error', message: 'panic: nil pointer dereference at customer_handler.go:142 stack=...', labels: { app: 'customer-portal', pod: 'customer-portal-d4-p9lkm', namespace: 'acme-portal' } },
    { level: 'info', message: 'http.server: GET /api/repos status=200 dur_ms=142', labels: { app: 'platform-bff', pod: 'platform-bff-78a-c12kk', namespace: 'acme-platform' } },
    { level: 'warn', message: 'rate limit hit for tenant "acme-internal" — burst=12 limit=10', labels: { app: 'platform-bff', pod: 'platform-bff-78a-c12kk', namespace: 'acme-platform' } },
    { level: 'info', message: 'webhook delivered (event=push repo=acme/adhar-console deliveries=1)', labels: { app: 'gitea', namespace: 'gitea' } },
    { level: 'error', message: 'connection refused dialing postgres:5432 (retry 2/5)', labels: { app: 'billing-service', pod: 'billing-service-5b4c6d8e9-k7fvr', namespace: 'acme-billing' } },
    { level: 'info', message: 'login_success user=tapas method=oidc tenant=acme', labels: { app: 'auth-service', pod: 'auth-service-9d7-fw2mn', namespace: 'acme-auth' } },
    { level: 'info', message: 'cache hit ratio: 0.94 (last 1m)', labels: { app: 'platform-bff', pod: 'platform-bff-78a-c12kk', namespace: 'acme-platform' } },
    { level: 'debug', message: 'pgbouncer: pool_size=24 active=8 waiting=0', labels: { app: 'pgbouncer', namespace: 'data' } },
    { level: 'fatal', message: 'unable to read kubeconfig: permission denied — restarting', labels: { app: 'kargo', namespace: 'kargo' } },
  ]
  return lines.map((l, i) => ({ ...l, timestamp: secondsAgo(i * 7 + 2) }))
})()

const STUB_METRICS_SERIES: Record<string, MetricSeries[]> = {
  rps: SERVICES.map((svc, i) => ({
    metric: { __name__: 'http_requests_per_second', service: svc },
    values: genSeries({
      count: 60,
      min: 8 + i * 4,
      max: 30 + i * 10,
      trend: i % 2 ? 'up' : 'flat',
      seed: 11 + i,
    }).map((v, idx) => [now / 1000 - (60 - idx) * 60, v.toFixed(2)] as [number, string]),
  })),
  errorRate: SERVICES.map((svc, i) => ({
    metric: { __name__: 'http_5xx_rate', service: svc },
    values: genSeries({ count: 60, min: 0, max: i === 2 ? 4.2 : 0.6, noise: 0.6, seed: 21 + i }).map(
      (v, idx) => [now / 1000 - (60 - idx) * 60, v.toFixed(3)] as [number, string],
    ),
  })),
  latencyP95: SERVICES.map((svc, i) => ({
    metric: { __name__: 'http_request_duration_p95_ms', service: svc },
    values: genSeries({ count: 60, min: 60 + i * 18, max: 220 + i * 22, seed: 31 + i }).map(
      (v, idx) => [now / 1000 - (60 - idx) * 60, v.toFixed(0)] as [number, string],
    ),
  })),
  cpu: SERVICES.map((svc, i) => ({
    metric: { __name__: 'container_cpu_usage_seconds_total:rate1m', service: svc },
    values: genSeries({ count: 60, min: 0.04, max: 0.42 + i * 0.03, noise: 0.4, seed: 41 + i }).map(
      (v, idx) => [now / 1000 - (60 - idx) * 60, v.toFixed(3)] as [number, string],
    ),
  })),
  memory: SERVICES.map((svc, i) => ({
    metric: { __name__: 'container_memory_working_set_bytes', service: svc },
    values: genSeries({ count: 60, min: 80 + i * 30, max: 220 + i * 40, seed: 51 + i }).map(
      (v, idx) => [now / 1000 - (60 - idx) * 60, (v * 1024 * 1024).toFixed(0)] as [number, string],
    ),
  })),
}

const STUB_TRACES: Trace[] = [
  {
    traceID: 'a1b2c3d4e5f60718',
    rootServiceName: 'platform-bff',
    rootTraceName: 'GET /api/repos',
    startTimeUnixNano: String((now - 2 * 60_000) * 1e6),
    durationMs: 142,
    spanCount: 8,
    status: 'ok',
  },
  {
    traceID: 'b2c3d4e5f6071829',
    rootServiceName: 'billing-service',
    rootTraceName: 'POST /v1/invoices/finalize',
    startTimeUnixNano: String((now - 5 * 60_000) * 1e6),
    durationMs: 1843,
    spanCount: 22,
    status: 'error',
  },
  {
    traceID: 'c3d4e5f607182930',
    rootServiceName: 'customer-portal',
    rootTraceName: 'GET /dashboard',
    startTimeUnixNano: String((now - 9 * 60_000) * 1e6),
    durationMs: 412,
    spanCount: 14,
    status: 'ok',
  },
  {
    traceID: 'd4e5f60718293041',
    rootServiceName: 'auth-service',
    rootTraceName: 'POST /oauth/token',
    startTimeUnixNano: String((now - 14 * 60_000) * 1e6),
    durationMs: 87,
    spanCount: 5,
    status: 'ok',
  },
  {
    traceID: 'e5f6071829304152',
    rootServiceName: 'platform-bff',
    rootTraceName: 'GET /api/applications',
    startTimeUnixNano: String((now - 22 * 60_000) * 1e6),
    durationMs: 295,
    spanCount: 11,
    status: 'ok',
  },
]

// Dev fixture shaped like a parsed Tempo trace: bare spans already carrying
// real attributes, status messages, and span events (as production spans do),
// so the inspector renders without any client-side enrichment layer.
const STUB_SPANS_FOR_TRACE: Record<string, Span[]> = {
  a1b2c3d4e5f60718: [
    { spanID: 's1', serviceName: 'platform-bff', operationName: 'GET /api/repos', startTimeMs: 0, durationMs: 142, status: 'ok', tags: { 'http.method': 'GET', 'http.route': '/api/repos', 'http.status_code': '200', 'net.peer.ip': '10.4.2.11', 'user.tenant': 'acme', 'otel.library.name': 'platform-bff/http' }, events: [{ timeMs: 0, name: 'request.received', attributes: { 'http.host': 'bff.adhar.local' } }, { timeMs: 138, name: 'response.sent', attributes: { 'http.status_code': '200', 'response.bytes': '4213' } }] },
    { spanID: 's2', parentSpanID: 's1', serviceName: 'platform-bff', operationName: 'middleware.auth', startTimeMs: 1, durationMs: 6, tags: { 'auth.method': 'oidc', 'auth.subject': 'user:tapas', 'cache.hit': 'true' }, events: [{ timeMs: 1, name: 'token.validated', attributes: { issuer: 'https://auth.adhar.local' } }] },
    { spanID: 's3', parentSpanID: 's1', serviceName: 'platform-bff', operationName: 'http.request gitea.adhar.local', startTimeMs: 8, durationMs: 124, tags: { 'http.method': 'GET', 'http.url': 'https://gitea.adhar.local/api/v1/orgs/acme/repos', 'peer.service': 'gitea', 'retry.count': '0' }, events: [{ timeMs: 0, name: 'connect.start' }, { timeMs: 4, name: 'connect.established', attributes: { 'tls.version': '1.3' } }] },
    { spanID: 's4', parentSpanID: 's3', serviceName: 'gitea', operationName: 'GET /api/v1/orgs/acme/repos', startTimeMs: 18, durationMs: 86, tags: { 'http.method': 'GET', 'http.status_code': '200', 'db.rows': '37', 'gitea.org': 'acme' }, events: [{ timeMs: 60, name: 'cache.miss', attributes: { key: 'orgs:acme:repos' } }] },
    { spanID: 's5', parentSpanID: 's4', serviceName: 'postgres', operationName: 'SELECT repos', startTimeMs: 22, durationMs: 12, tags: { 'db.system': 'postgresql', 'db.statement': 'SELECT id, name FROM repository WHERE owner_id = $1', 'db.rows': '37', 'db.pool.wait_ms': '0' }, events: [{ timeMs: 0, name: 'query.start' }, { timeMs: 12, name: 'query.done', attributes: { rows: '37' } }] },
    { spanID: 's6', parentSpanID: 's3', serviceName: 'platform-bff', operationName: 'response.serialize', startTimeMs: 134, durationMs: 6, tags: { 'serializer.format': 'json', 'response.bytes': '4213' } },
  ],
  b2c3d4e5f6071829: [
    { spanID: 'b1', serviceName: 'billing-service', operationName: 'POST /v1/invoices/finalize', startTimeMs: 0, durationMs: 1843, status: 'error', statusMessage: 'invoice finalize failed: downstream lock_timeout', tags: { 'http.method': 'POST', 'http.route': '/v1/invoices/finalize', 'http.status_code': '500', 'invoice.id': 'inv_8842', tenant: 'acme', error: 'true' }, events: [{ timeMs: 0, name: 'request.received' }, { timeMs: 43, name: 'tax.calculated', attributes: { 'tax.amount': '128.40' } }, { timeMs: 1750, name: 'exception', attributes: { 'exception.type': 'LockTimeout', 'exception.message': 'could not obtain lock on relation "subscriptions"' } }, { timeMs: 1820, name: 'response.error', attributes: { 'http.status_code': '500' } }] },
    { spanID: 'b2', parentSpanID: 'b1', serviceName: 'billing-service', operationName: 'tax.calculate', startTimeMs: 5, durationMs: 38, tags: { 'tax.provider': 'avalara', 'tax.amount': '128.40', 'cache.hit': 'false' }, events: [{ timeMs: 30, name: 'tax.provider.responded', attributes: { latency_ms: '33' } }] },
    { spanID: 'b3', parentSpanID: 'b1', serviceName: 'postgres', operationName: 'SELECT subscriptions FOR UPDATE', startTimeMs: 50, durationMs: 1700, status: 'error', statusMessage: 'lock_timeout after 1700ms waiting on row lock', tags: { 'db.statement': 'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', error: 'lock_timeout', 'db.system': 'postgresql', 'db.pool.wait_ms': '1680', 'db.lock.mode': 'FOR UPDATE', 'error.kind': 'lock_timeout' }, events: [{ timeMs: 0, name: 'query.start' }, { timeMs: 20, name: 'lock.wait.begin', attributes: { relation: 'subscriptions', 'blocking.pid': '48213' } }, { timeMs: 1700, name: 'exception', attributes: { 'exception.type': 'QueryCanceled', 'exception.message': 'canceling statement due to lock timeout' } }] },
    { spanID: 'b4', parentSpanID: 'b1', serviceName: 'billing-service', operationName: 'response.error 500', startTimeMs: 1820, durationMs: 8, status: 'error', statusMessage: 'returned HTTP 500 to caller', tags: { 'http.status_code': '500', error: 'true', 'response.bytes': '182' } },
  ],
}

const STUB_SERVICE_MAP: { nodes: ServiceNode[]; edges: ServiceEdge[] } = {
  nodes: [
    { name: 'customer-portal', language: 'typescript', rps: 14, errorRate: 0.4, p95Ms: 412, apdex: 0.94 },
    { name: 'platform-bff', language: 'typescript', rps: 86, errorRate: 0.2, p95Ms: 152, apdex: 0.97 },
    { name: 'auth-service', language: 'go', rps: 32, errorRate: 0.1, p95Ms: 88, apdex: 0.99 },
    { name: 'billing-service', language: 'go', rps: 12, errorRate: 4.2, p95Ms: 1843, apdex: 0.71 },
    { name: 'adhar-console', language: 'typescript', rps: 22, errorRate: 0.3, p95Ms: 110, apdex: 0.97 },
    { name: 'gitea', language: 'go', rps: 28, errorRate: 0.2, p95Ms: 132, apdex: 0.96 },
    { name: 'postgres', language: 'sql', rps: 184, errorRate: 0.05, p95Ms: 22, apdex: 0.99 },
  ],
  edges: [
    { from: 'customer-portal', to: 'platform-bff', rps: 14, errorRate: 0.4, p95Ms: 220 },
    { from: 'adhar-console', to: 'platform-bff', rps: 22, errorRate: 0.3, p95Ms: 158 },
    { from: 'platform-bff', to: 'gitea', rps: 28, errorRate: 0.2, p95Ms: 132 },
    { from: 'platform-bff', to: 'billing-service', rps: 12, errorRate: 4.2, p95Ms: 1843 },
    { from: 'platform-bff', to: 'auth-service', rps: 32, errorRate: 0.1, p95Ms: 88 },
    { from: 'billing-service', to: 'postgres', rps: 88, errorRate: 0.6, p95Ms: 64 },
    { from: 'auth-service', to: 'postgres', rps: 96, errorRate: 0.05, p95Ms: 18 },
  ],
}

const STUB_ALERTS: Alert[] = [
  {
    fingerprint: 'al-001',
    name: 'BillingService HighErrorRate',
    state: 'firing',
    severity: 'critical',
    summary: 'billing-service 5xx rate above 2% for 10m',
    description: 'POST /v1/invoices/finalize failing with lock_timeout against postgres.',
    runbook_url: 'https://wiki.adhar.local/runbooks/billing-5xx',
    labels: { service: 'billing-service', severity: 'critical', team: 'billing' },
    startsAt: minutesAgo(18),
    value: 4.2,
    expression: 'sum(rate(http_requests_total{service="billing-service",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="billing-service"}[5m])) > 0.02',
  },
  {
    fingerprint: 'al-002',
    name: 'PostgresPrimaryReplicationLag',
    state: 'pending',
    severity: 'warning',
    summary: 'replication lag > 30s for 5m',
    description: 'data/postgres-primary → data/postgres-replica-1 lag exceeds threshold.',
    labels: { service: 'postgres', severity: 'warning', team: 'platform' },
    startsAt: minutesAgo(4),
    value: 38,
    expression: 'pg_replication_lag_seconds > 30',
  },
  {
    fingerprint: 'al-003',
    name: 'CertExpiringSoon',
    state: 'firing',
    severity: 'warning',
    summary: '*.adhar.local cert expires in 14 days',
    labels: { service: 'cert-manager', severity: 'warning', team: 'platform' },
    startsAt: minutesAgo(620),
    value: 14,
    expression: '(probe_ssl_earliest_cert_expiry - time()) / 86400 < 30',
  },
  {
    fingerprint: 'al-004',
    name: 'CustomerPortalLowApdex',
    state: 'firing',
    severity: 'warning',
    summary: 'customer-portal Apdex < 0.95 (1h)',
    labels: { service: 'customer-portal', severity: 'warning', team: 'customer' },
    startsAt: minutesAgo(72),
    value: 0.91,
  },
  {
    fingerprint: 'al-005',
    name: 'AuthServiceLatencyP95',
    state: 'pending',
    severity: 'info',
    summary: 'auth-service p95 > 200ms (10m)',
    labels: { service: 'auth-service', severity: 'info', team: 'identity' },
    startsAt: minutesAgo(2),
    value: 218,
  },
  {
    fingerprint: 'al-006',
    name: 'IngressControllerCPUSaturated',
    state: 'resolved',
    severity: 'critical',
    summary: 'nginx-ingress CPU > 90% for 5m',
    labels: { service: 'nginx-ingress', severity: 'critical', team: 'platform' },
    startsAt: minutesAgo(180),
    endsAt: minutesAgo(140),
    value: 87,
  },
]

const STUB_SLOS: Slo[] = [
  {
    name: 'platform-bff availability',
    service: 'platform-bff',
    indicator: '2xx/3xx ratio over 28d',
    objective: 99.9,
    window: 28,
    current: 99.94,
    errorBudgetRemaining: 0.62,
    burnRate1h: 0.4,
    burnRate6h: 0.7,
    history: genSeries({ count: 28, min: 99.85, max: 99.99, seed: 7 }),
  },
  {
    name: 'platform-bff latency p95 < 250ms',
    service: 'platform-bff',
    indicator: 'p95 latency < 250ms (28d)',
    objective: 99,
    window: 28,
    current: 99.21,
    errorBudgetRemaining: 0.42,
    burnRate1h: 0.9,
    burnRate6h: 0.6,
    history: genSeries({ count: 28, min: 98.7, max: 99.6, seed: 13 }),
  },
  {
    name: 'billing-service availability',
    service: 'billing-service',
    indicator: '2xx/3xx ratio over 28d',
    objective: 99.5,
    window: 28,
    current: 98.92,
    errorBudgetRemaining: -0.18,
    burnRate1h: 12.4,
    burnRate6h: 6.2,
    history: genSeries({ count: 28, min: 98.5, max: 99.8, trend: 'down', seed: 17 }),
  },
  {
    name: 'auth-service latency p95 < 100ms',
    service: 'auth-service',
    indicator: 'p95 latency < 100ms (28d)',
    objective: 99.9,
    window: 28,
    current: 99.97,
    errorBudgetRemaining: 0.86,
    burnRate1h: 0.1,
    burnRate6h: 0.2,
    history: genSeries({ count: 28, min: 99.93, max: 100, seed: 19 }),
  },
  {
    name: 'customer-portal availability',
    service: 'customer-portal',
    indicator: '2xx/3xx ratio over 28d',
    objective: 99.5,
    window: 28,
    current: 99.42,
    errorBudgetRemaining: 0.16,
    burnRate1h: 1.2,
    burnRate6h: 1.4,
    history: genSeries({ count: 28, min: 99.3, max: 99.8, seed: 23 }),
  },
]

const STUB_DASHBOARDS = [
  { uid: 'svc-overview', title: 'Service overview', tags: ['platform', 'gold'], folder: 'Platform' },
  { uid: 'argocd-overview', title: 'ArgoCD overview', tags: ['argocd', 'gold'], folder: 'Delivery' },
  { uid: 'kube-cluster', title: 'Kubernetes cluster', tags: ['kubernetes', 'gold'], folder: 'Platform' },
  { uid: 'http-rps-latency', title: 'HTTP — RPS, latency, errors', tags: ['service', 'gold'], folder: 'Service' },
  { uid: 'redis', title: 'Redis', tags: ['redis'], folder: 'Data' },
  { uid: 'postgres', title: 'PostgreSQL', tags: ['postgres', 'gold'], folder: 'Data' },
]

export const LgtmClient = {
  create: (opts: import('../base/http.ts').HttpClientOptions & { grafanaUrl: string }) =>
    build(new HttpClient(opts), opts.grafanaUrl),
  /**
   * Environment-aware client. Prod build → LGTM/Grafana datasource API through
   * the BFF proxy (`/api/svc/lgtm`, cookie-authenticated); dev → stub. The
   * `grafanaUrl` (for embed deep-links) defaults to the conventional host and
   * can be overridden from `/api/config`.
   */
  auto(
    opts: { tool?: string; mode?: 'real' | 'stub'; grafanaUrl?: string } & Partial<HttpClientOptions> = {},
  ): LgtmClient {
    const real = opts.mode ? opts.mode === 'real' : isProdBuild()
    if (!real) return this.stub()
    return build(
      new HttpClient({
        ...opts,
        baseUrl: opts.baseUrl ?? svcBaseUrl(opts.tool ?? 'lgtm'),
        credentials: opts.credentials ?? 'include',
      }),
      opts.grafanaUrl ?? 'https://grafana.adhar.local',
    )
  },
  stub: (): LgtmClient => ({
    queryLogs: async (q) => {
      const f = q.toLowerCase()
      return STUB_LOGS.filter(
        (l) =>
          !f ||
          l.message.toLowerCase().includes(f) ||
          Object.values(l.labels ?? {}).some((v) => v.toLowerCase().includes(f)),
      )
    },
    queryMetrics: async (query) => {
      const slug = (query.match(/__name__="([^"]+)"|^\s*([a-zA-Z_:][\w:]*)/) ?? [])[1]
      const map: Record<string, keyof typeof STUB_METRICS_SERIES> = {
        http_requests_per_second: 'rps',
        http_5xx_rate: 'errorRate',
        http_request_duration_p95_ms: 'latencyP95',
        'container_cpu_usage_seconds_total:rate1m': 'cpu',
        container_memory_working_set_bytes: 'memory',
      }
      const key = (slug && map[slug]) || ('rps' as keyof typeof STUB_METRICS_SERIES)
      return STUB_METRICS_SERIES[key]
    },
    searchTraces: async (filter) => {
      let list = STUB_TRACES.slice()
      if (filter.service) list = list.filter((t) => t.rootServiceName === filter.service)
      if (filter.minDurationMs) list = list.filter((t) => t.durationMs >= filter.minDurationMs!)
      if (filter.status) list = list.filter((t) => t.status === filter.status)
      return list
    },
    getTrace: async (id) =>
      STUB_SPANS_FOR_TRACE[id] ?? [
        {
          spanID: 'root',
          serviceName: 'unknown',
          operationName: 'unknown',
          startTimeMs: 0,
          durationMs: 50,
        },
      ],
    listServices: async () => STUB_SERVICE_MAP.nodes,
    serviceMap: async () => STUB_SERVICE_MAP,
    listAlerts: async () => STUB_ALERTS,
    silenceAlert: async () => {},
    listSlos: async () => STUB_SLOS,
    grafanaEmbedUrl: (uid, params = {}) => {
      const qs = new URLSearchParams({ kiosk: 'tv', ...params })
      return `https://grafana.adhar.local/d/${uid}?${qs}`
    },
    listDashboards: async () => STUB_DASHBOARDS,
  }),
}
