/**
 * Golden signals, RED and USE — PromQL builders.
 *
 * Pure and JSX-free so it can be unit-tested with `deno test`.
 *
 * HTTP signals (traffic / errors / latency) come from whichever request-metric
 * family the cluster actually scrapes. Each family is described once as an
 * {@link HttpSource} — its counter, the label holding the status code, its
 * duration histogram (and that histogram's unit) and the labels naming the
 * service and namespace — and every query is generated from that description.
 * This replaces the old `a or b or c` unions, which silently mixed families and
 * grouped by labels some of them don't carry.
 *
 * Saturation comes from node-exporter (nodes), cAdvisor (containers) and
 * kube-state-metrics (requests / limits / pod state). Each builder documents
 * the exporter it needs so a widget can say "needs kube-state-metrics" instead
 * of drawing an empty chart that reads as zero.
 */

/* ─────────── sources ─────────── */

export interface HttpSource {
  id: string
  label: string
  /** Request counter. */
  requests: string
  /** Counter carrying the status label, when it differs from `requests` (Hubble httpV1). */
  responses?: string
  /** Label with the HTTP status code (or OTel status for spanmetrics). */
  statusLabel: string
  /** Regex matching a server error on `statusLabel`. */
  errorMatch: string
  /** Regex matching a client error on `statusLabel` (undefined when the family has none). */
  clientErrorMatch?: string
  /** Duration histogram base name (without `_bucket`). */
  duration?: string
  /** Multiplier taking the histogram's unit to milliseconds. */
  durationToMs: number
  serviceLabel: string
  namespaceLabel?: string
  /** Label that splits one request into several reporters (Hubble client/server); de-duplicated with max. */
  reporterLabel?: string
  /** Metric names whose presence proves this source exists. */
  probe: string
  hint: string
}

export const HTTP_SOURCES_V2: HttpSource[] = [
  {
    id: 'hubble',
    label: 'Cilium Hubble L7',
    requests: 'hubble_http_requests_total',
    responses: 'hubble_http_responses_total',
    statusLabel: 'status',
    errorMatch: '5..',
    clientErrorMatch: '4..',
    duration: 'hubble_http_request_duration_seconds',
    durationToMs: 1000,
    serviceLabel: 'destination_workload',
    namespaceLabel: 'destination_namespace',
    reporterLabel: 'reporter',
    probe: 'hubble_http_requests_total',
    hint: 'Hubble httpV2 metrics with labelsContext=destination_namespace,destination_workload',
  },
  {
    id: 'istio',
    label: 'Istio / Envoy',
    requests: 'istio_requests_total',
    statusLabel: 'response_code',
    errorMatch: '5..',
    clientErrorMatch: '4..',
    duration: 'istio_request_duration_milliseconds',
    durationToMs: 1,
    serviceLabel: 'destination_workload',
    namespaceLabel: 'destination_workload_namespace',
    reporterLabel: 'reporter',
    probe: 'istio_requests_total',
    hint: 'Istio sidecar / ambient telemetry',
  },
  {
    id: 'nginx',
    label: 'NGINX Ingress',
    requests: 'nginx_ingress_controller_requests',
    statusLabel: 'status',
    errorMatch: '5..',
    clientErrorMatch: '4..',
    duration: 'nginx_ingress_controller_request_duration_seconds',
    durationToMs: 1000,
    serviceLabel: 'service',
    namespaceLabel: 'exported_namespace',
    probe: 'nginx_ingress_controller_requests',
    hint: 'ingress-nginx controller metrics',
  },
  {
    id: 'spanmetrics',
    label: 'Tempo span metrics',
    requests: 'traces_spanmetrics_calls_total',
    statusLabel: 'status_code',
    errorMatch: 'STATUS_CODE_ERROR',
    duration: 'traces_spanmetrics_latency',
    durationToMs: 1000,
    serviceLabel: 'service',
    probe: 'traces_spanmetrics_calls_total',
    hint: 'Tempo metrics-generator span-metrics processor',
  },
  {
    id: 'app',
    label: 'Application (http_requests_total)',
    requests: 'http_requests_total',
    statusLabel: 'status',
    errorMatch: '5..',
    clientErrorMatch: '4..',
    duration: 'http_request_duration_seconds',
    durationToMs: 1000,
    serviceLabel: 'service',
    namespaceLabel: 'namespace',
    probe: 'http_requests_total',
    hint: 'Prometheus client-library instrumentation',
  },
]

/** Sources whose probe metric is present, in preference order. */
export function detectSources(names: Iterable<string>): HttpSource[] {
  const set = new Set(names)
  return HTTP_SOURCES_V2.filter((s) => set.has(s.probe))
}

/** Resolve the source to use: an explicit id when present, else the first detected. */
export function pickSource(detected: HttpSource[], id?: string | null): HttpSource | null {
  if (id) {
    const hit = detected.find((s) => s.id === id)
    if (hit) return hit
  }
  return detected[0] ?? null
}

/** Hubble httpV1 puts status on a separate responses counter; prefer it when present. */
export function withResponsesResolved(src: HttpSource, names: Iterable<string>): HttpSource {
  if (!src.responses) return src
  const set = new Set(names)
  return set.has(src.responses) ? src : { ...src, responses: undefined }
}

/* ─────────── scope / selectors ─────────── */

export interface Scope {
  namespace?: string | null
  service?: string | null
}

/** Escape a value for use inside a PromQL double-quoted string. */
export function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Escape a literal for use inside a PromQL regex matcher (RE2). */
export function escRe(v: string): string {
  return esc(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** `{a="b", c=~"d"}` from a list of matcher strings (empty → ``). */
export function sel(matchers: Array<string | null | undefined | false>): string {
  const m = matchers.filter(Boolean) as string[]
  return m.length ? `{${m.join(', ')}}` : ''
}

/**
 * Anchored pod regex for a workload name: Deployment pods (`name-<rs>-<pod>`),
 * DaemonSet pods (`name-<hash>`) and StatefulSet pods (`name-0`). A bare
 * `name.*` would also match `name-worker-…`.
 */
export function podRegex(workload: string): string {
  const n = escRe(workload)
  return `${n}(-[a-z0-9]{5,10}){1,2}|${n}-[0-9]+`
}

function httpMatchers(src: HttpSource, scope: Scope, extra: string[] = []): string {
  return sel([
    scope.namespace && src.namespaceLabel ? `${src.namespaceLabel}="${esc(scope.namespace)}"` : null,
    scope.service ? `${src.serviceLabel}="${esc(scope.service)}"` : null,
    ...extra,
  ])
}

/** Labels to group a per-service query by. */
export function serviceBy(src: HttpSource): string {
  return src.namespaceLabel ? `${src.namespaceLabel}, ${src.serviceLabel}` : src.serviceLabel
}

/* ─────────── HTTP signals ─────────── */

export interface HttpQueries {
  rps: string
  /** 5xx responses per second. */
  errorRps: string
  /** 5xx share of all responses, percent. */
  errorPct: string
  /** 4xx share, percent (null when the family has no client-error notion). */
  clientErrorPct: string | null
  /** Traffic split by status class (2xx/3xx/4xx/5xx). */
  rpsByClass: string | null
  p50: string | null
  p90: string | null
  p95: string | null
  p99: string | null
}

/** Sum a counter's rate, de-duplicating reporters (Hubble/Istio count both ends). */
function rateSum(src: HttpSource, metric: string, matchers: string, win: string, by: string): string {
  const inner = `rate(${metric}${matchers}[${win}])`
  if (!src.reporterLabel) return by ? `sum by (${by}) (${inner})` : `sum(${inner})`
  const grp = by ? `${by}, ${src.reporterLabel}` : src.reporterLabel
  const outer = by ? `max by (${by})` : 'max'
  return `${outer} (sum by (${grp}) (${inner}))`
}

function quantile(src: HttpSource, q: number, scope: Scope, win: string, by: string): string | null {
  if (!src.duration) return null
  const grp = by ? `le, ${by}` : 'le'
  const mul = src.durationToMs === 1 ? '' : `${src.durationToMs} * `
  return `${mul}histogram_quantile(${q}, sum by (${grp}) (rate(${src.duration}_bucket${httpMatchers(src, scope)}[${win}])))`
}

/**
 * Cluster- or scope-level HTTP golden signals. `by` groups the result
 * (e.g. `serviceBy(src)` for per-service RED); empty = one series.
 */
export function httpQueries(src: HttpSource, scope: Scope, win: string, by = ''): HttpQueries {
  const statusMetric = src.responses ?? src.requests
  const all = httpMatchers(src, scope)
  const err = httpMatchers(src, scope, [`${src.statusLabel}=~"${src.errorMatch}"`])
  const rps = rateSum(src, src.requests, all, win, by)
  const errorRps = rateSum(src, statusMetric, err, win, by)
  const statusTotal = rateSum(src, statusMetric, all, win, by)
  const pct = (num: string) => `100 * (${num}) / (${statusTotal})`
  const clientErr = src.clientErrorMatch
    ? pct(rateSum(src, statusMetric, httpMatchers(src, scope, [`${src.statusLabel}=~"${src.clientErrorMatch}"`]), win, by))
    : null
  const classed = `label_replace(rate(${statusMetric}${all}[${win}]), "class", "\${1}xx", "${src.statusLabel}", "([0-9])..")`
  const byClass = !src.clientErrorMatch
    ? null
    : src.reporterLabel
    ? `max by (class) (sum by (class, ${src.reporterLabel}) (${classed}))`
    : `sum by (class) (${classed})`
  return {
    rps,
    errorRps,
    errorPct: pct(errorRps),
    clientErrorPct: clientErr,
    rpsByClass: byClass,
    p50: quantile(src, 0.5, scope, win, by),
    p90: quantile(src, 0.9, scope, win, by),
    p95: quantile(src, 0.95, scope, win, by),
    p99: quantile(src, 0.99, scope, win, by),
  }
}

/** Top-k wrapper used by the "top services" widgets. */
export function topk(k: number, expr: string): string {
  return `topk(${k}, ${expr})`
}

/* ─────────── saturation (cluster / namespace / workload) ─────────── */

/** Filesystems worth measuring: real block devices, not tmpfs/overlay. */
export const REAL_FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|nsfs", mountpoint="/"'
export const NET_DEV = 'device!~"lo|veth.*|lxc.*|cilium.*|cali.*|flannel.*|cni.*|docker.*|br-.*|vxlan.*|genev.*"'

export interface SaturationQueries {
  /** CPU utilisation, percent. */
  cpuPct: string
  memPct: string
  diskPct: string | null
  netRx: string
  netTx: string
  /** Which exporter feeds the CPU/memory queries. */
  exporter: 'node-exporter' | 'cAdvisor'
}

/**
 * Cluster scope → node-exporter (true node utilisation). Namespace or service
 * scope → cAdvisor container usage as a share of the scope's CPU/memory limits
 * would hide unlimited pods, so it is expressed against node allocatable
 * capacity from kube-state-metrics instead.
 */
export function saturationQueries(scope: Scope, win: string): SaturationQueries {
  if (!scope.namespace && !scope.service) {
    return {
      cpuPct: `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[${win}])))`,
      memPct: '100 * (1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))',
      diskPct: `100 * (1 - sum(node_filesystem_avail_bytes{${REAL_FS}}) / sum(node_filesystem_size_bytes{${REAL_FS}}))`,
      netRx: `sum(rate(node_network_receive_bytes_total{${NET_DEV}}[${win}]))`,
      netTx: `sum(rate(node_network_transmit_bytes_total{${NET_DEV}}[${win}]))`,
      exporter: 'node-exporter',
    }
  }
  const m = containerMatchers(scope)
  const pm = podMatchers(scope)
  return {
    cpuPct: `100 * sum(rate(container_cpu_usage_seconds_total${m}[${win}])) / sum(kube_node_status_allocatable{resource="cpu"})`,
    memPct: `100 * sum(container_memory_working_set_bytes${m}) / sum(kube_node_status_allocatable{resource="memory"})`,
    diskPct: null,
    netRx: `sum(rate(container_network_receive_bytes_total${pm}[${win}]))`,
    netTx: `sum(rate(container_network_transmit_bytes_total${pm}[${win}]))`,
    exporter: 'cAdvisor',
  }
}

/** cAdvisor container matchers for a scope (real containers only). */
export function containerMatchers(scope: Scope): string {
  return sel([
    'container!=""',
    'container!="POD"',
    scope.namespace ? `namespace="${esc(scope.namespace)}"` : null,
    scope.service ? `pod=~"${podRegex(scope.service)}"` : null,
  ])
}

/** Pod-level matchers (network metrics are per pod, no container label). */
export function podMatchers(scope: Scope): string {
  return sel([
    scope.namespace ? `namespace="${esc(scope.namespace)}"` : null,
    scope.service ? `pod=~"${podRegex(scope.service)}"` : null,
  ])
}

/** Per-namespace / per-pod CPU and memory for the breakdown charts. */
export function usageBreakdown(scope: Scope, win: string): { cpu: string; mem: string; by: string } {
  const by = scope.namespace ? 'pod' : 'namespace'
  const m = containerMatchers(scope)
  return {
    by,
    cpu: `topk(8, sum by (${by}) (rate(container_cpu_usage_seconds_total${m}[${win}])))`,
    mem: `topk(8, sum by (${by}) (container_memory_working_set_bytes${m}))`,
  }
}

/* ─────────── USE (nodes) ─────────── */

/** Join node-exporter `instance` → the Kubernetes node name. */
const NODENAME = '* on (instance) group_left (nodename) node_uname_info'

export const USE_QUERIES = {
  cpuUtil: `100 * (1 - avg by (nodename) (rate(node_cpu_seconds_total{mode="idle"}[5m]) ${NODENAME}))`,
  /** Run-queue saturation: 1m load per CPU (>1 = queueing). */
  cpuSat: `max by (nodename) (node_load1 ${NODENAME}) / count by (nodename) (node_cpu_seconds_total{mode="idle"} ${NODENAME})`,
  memUtil: `100 * (1 - max by (nodename) (node_memory_MemAvailable_bytes ${NODENAME}) / max by (nodename) (node_memory_MemTotal_bytes ${NODENAME}))`,
  /** Major page faults per second — memory pressure forcing disk reads. */
  memSat: `max by (nodename) (rate(node_vmstat_pgmajfault[5m]) ${NODENAME})`,
  diskUtil: `100 * (1 - max by (nodename) (node_filesystem_avail_bytes{${REAL_FS}} ${NODENAME}) / max by (nodename) (node_filesystem_size_bytes{${REAL_FS}} ${NODENAME}))`,
  /** Weighted IO time: average IO queue depth across devices. */
  diskSat: `max by (nodename) (rate(node_disk_io_time_weighted_seconds_total[5m]) ${NODENAME})`,
  netErr: `sum by (nodename) ((rate(node_network_receive_errs_total{${NET_DEV}}[5m]) + rate(node_network_transmit_errs_total{${NET_DEV}}[5m])) ${NODENAME})`,
  /** kube-state-metrics: Ready=false and pressure conditions. */
  notReady: 'max by (node) (kube_node_status_condition{condition="Ready", status!="true"})',
  pressure:
    'max by (node, condition) (kube_node_status_condition{condition=~"MemoryPressure|DiskPressure|PIDPressure|NetworkUnavailable", status="true"}) > 0',
} as const

/* ─────────── pod health (kube-state-metrics) ─────────── */

export function podHealthQueries(scope: Scope, windowLabel: string): Record<string, string> {
  const ns = scope.namespace ? `namespace="${esc(scope.namespace)}"` : null
  const pod = scope.service ? `pod=~"${podRegex(scope.service)}"` : null
  const m = (extra: string[] = []) => sel([ns, pod, ...extra])
  return {
    restarts: `sum(increase(kube_pod_container_status_restarts_total${m()}[${windowLabel}]))`,
    topRestarts: `topk(8, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total${m()}[${windowLabel}])) > 0)`,
    crashloop: `sum by (namespace, pod) (kube_pod_container_status_waiting_reason${m(['reason="CrashLoopBackOff"'])}) > 0`,
    imagePull: `sum by (namespace, pod) (kube_pod_container_status_waiting_reason${m(['reason=~"ImagePullBackOff|ErrImagePull"'])}) > 0`,
    oomKilled: `sum by (namespace, pod) (kube_pod_container_status_last_terminated_reason${m(['reason="OOMKilled"'])}) > 0`,
    pending: `sum by (namespace, pod) (kube_pod_status_phase${m(['phase="Pending"'])}) > 0`,
    failed: `sum by (namespace, pod) (kube_pod_status_phase${m(['phase="Failed"'])}) > 0`,
    notReady: `sum by (namespace, pod) (kube_pod_status_ready${m(['condition="false"'])}) > 0`,
    running: `sum(kube_pod_status_phase${m(['phase="Running"'])})`,
  }
}

/* ─────────── capacity (requests vs limits vs usage vs allocatable) ─────────── */

export function capacityQueries(scope: Scope, win: string): Record<string, string> {
  const ns = scope.namespace ? `namespace="${esc(scope.namespace)}"` : null
  const pod = scope.service ? `pod=~"${podRegex(scope.service)}"` : null
  const res = (r: string) => sel([`resource="${r}"`, ns, pod])
  const cm = containerMatchers(scope)
  return {
    cpuAlloc: 'sum(kube_node_status_allocatable{resource="cpu"})',
    cpuReq: `sum(kube_pod_container_resource_requests${res('cpu')})`,
    cpuLim: `sum(kube_pod_container_resource_limits${res('cpu')})`,
    cpuUse: `sum(rate(container_cpu_usage_seconds_total${cm}[${win}]))`,
    memAlloc: 'sum(kube_node_status_allocatable{resource="memory"})',
    memReq: `sum(kube_pod_container_resource_requests${res('memory')})`,
    memLim: `sum(kube_pod_container_resource_limits${res('memory')})`,
    memUse: `sum(container_memory_working_set_bytes${cm})`,
  }
}

/* ─────────── ingress / gateway ─────────── */

export interface IngressSource {
  id: string
  label: string
  probe: string
  rps: (win: string) => string
  errPct: (win: string) => string
  p95: ((win: string) => string) | null
  /** Label naming the route / host. */
  by: string
  hint: string
}

export const INGRESS_SOURCES: IngressSource[] = [
  {
    id: 'nginx',
    label: 'NGINX Ingress',
    probe: 'nginx_ingress_controller_requests',
    by: 'host',
    rps: (w) => `topk(8, sum by (host) (rate(nginx_ingress_controller_requests[${w}])))`,
    errPct: (w) =>
      `100 * sum by (host) (rate(nginx_ingress_controller_requests{status=~"5.."}[${w}])) / sum by (host) (rate(nginx_ingress_controller_requests[${w}]))`,
    p95: (w) =>
      `1000 * histogram_quantile(0.95, sum by (le, host) (rate(nginx_ingress_controller_request_duration_seconds_bucket[${w}])))`,
    hint: 'ingress-nginx controller metrics',
  },
  {
    id: 'envoy',
    label: 'Envoy Gateway / Cilium Envoy',
    probe: 'envoy_http_downstream_rq_total',
    by: 'envoy_http_conn_manager_prefix',
    rps: (w) => `topk(8, sum by (envoy_http_conn_manager_prefix) (rate(envoy_http_downstream_rq_total[${w}])))`,
    errPct: (w) =>
      `100 * sum by (envoy_http_conn_manager_prefix) (rate(envoy_http_downstream_rq_xx{envoy_response_code_class="5"}[${w}])) / sum by (envoy_http_conn_manager_prefix) (rate(envoy_http_downstream_rq_total[${w}]))`,
    p95: (w) =>
      `histogram_quantile(0.95, sum by (le, envoy_http_conn_manager_prefix) (rate(envoy_http_downstream_rq_time_bucket[${w}])))`,
    hint: 'Envoy admin stats scraped from the gateway proxy',
  },
  {
    id: 'traefik',
    label: 'Traefik',
    probe: 'traefik_service_requests_total',
    by: 'service',
    rps: (w) => `topk(8, sum by (service) (rate(traefik_service_requests_total[${w}])))`,
    errPct: (w) =>
      `100 * sum by (service) (rate(traefik_service_requests_total{code=~"5.."}[${w}])) / sum by (service) (rate(traefik_service_requests_total[${w}]))`,
    p95: (w) =>
      `1000 * histogram_quantile(0.95, sum by (le, service) (rate(traefik_service_request_duration_seconds_bucket[${w}])))`,
    hint: 'Traefik Prometheus metrics',
  },
]

/* ─────────── tracing / logs ─────────── */

export function traceErrorPct(scope: Scope, win: string): string {
  const m = (extra: string[]) => sel([scope.service ? `service="${esc(scope.service)}"` : null, ...extra])
  return `100 * sum(rate(traces_spanmetrics_calls_total${m(['status_code="STATUS_CODE_ERROR"'])}[${win}])) / sum(rate(traces_spanmetrics_calls_total${m(['span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"'])}[${win}]))`
}

/** Loki error-line volume. Line filter, so it works without a `level` label. */
export function lokiErrorVolume(scope: Scope, stepSec: number): string {
  const selector = scope.namespace
    ? `{namespace="${esc(scope.namespace)}"${scope.service ? `, pod=~"${podRegex(scope.service)}"` : ''}}`
    : '{namespace=~".+"}'
  const by = scope.namespace ? '' : ' by (namespace)'
  return `topk(8, sum${by} (count_over_time(${selector} |~ "(?i)\\\\b(error|fatal|panic|exception)\\\\b" [${stepSec}s])))`
}

/** LogQL selector to open Logs scoped like the dashboard. */
export function lokiSelector(scope: Scope): string {
  if (scope.namespace && scope.service) return `{namespace="${esc(scope.namespace)}", pod=~"${podRegex(scope.service)}"}`
  if (scope.namespace) return `{namespace="${esc(scope.namespace)}"}`
  if (scope.service) return `{service_name="${esc(scope.service)}"}`
  return '{namespace=~".+"}'
}

/* ─────────── exporters ─────────── */

export const EXPORTERS = {
  'kube-state-metrics': 'kube_pod_status_phase',
  'node-exporter': 'node_cpu_seconds_total',
  cAdvisor: 'container_cpu_usage_seconds_total',
  'Tempo span metrics': 'traces_spanmetrics_calls_total',
  'Tempo service graphs': 'traces_service_graph_request_total',
} as const
export type Exporter = keyof typeof EXPORTERS

/** Exporters (of the given set) missing from the scraped metric names. */
export function missingExporters(names: Iterable<string> | undefined, need: Exporter[]): Exporter[] {
  if (!names) return []
  const set = new Set(names)
  return need.filter((e) => !set.has(EXPORTERS[e]))
}

/* ─────────── aggregation helpers ─────────── */

export interface SeriesLike {
  metric: Record<string, string>
  points: Array<[number, number]>
}

export function lastPoint(s: SeriesLike | undefined): number | null {
  if (!s || !s.points.length) return null
  return s.points[s.points.length - 1][1]
}

/** Last value of the first series (one-series queries), or null. */
export function lastOf(series: SeriesLike[] | undefined): number | null {
  return lastPoint(series?.[0])
}

export function peak(s: SeriesLike): number {
  let m = -Infinity
  for (const [, v] of s.points) if (v > m) m = v
  return m
}

export function mean(s: SeriesLike): number | null {
  if (!s.points.length) return null
  return s.points.reduce((a, [, v]) => a + v, 0) / s.points.length
}

/** Key for a series from a set of labels (used to join RED rows). */
export function keyOf(metric: Record<string, string>, labels: string[]): string {
  return labels.map((l) => metric[l] ?? '').join('/')
}

export interface RedRow {
  key: string
  service: string
  namespace?: string
  rps: number | null
  errorPct: number | null
  p50: number | null
  p95: number | null
  p99: number | null
  rpsTrend: number[]
  errTrend: number[]
  p95Trend: number[]
}

/** Join per-service RED series (same grouping labels) into rows. */
export function joinRed(
  src: HttpSource,
  parts: { rps?: SeriesLike[]; err?: SeriesLike[]; p50?: SeriesLike[]; p95?: SeriesLike[]; p99?: SeriesLike[] },
): RedRow[] {
  const labels = src.namespaceLabel ? [src.namespaceLabel, src.serviceLabel] : [src.serviceLabel]
  const rows = new Map<string, RedRow>()
  const get = (m: Record<string, string>) => {
    const key = keyOf(m, labels)
    let r = rows.get(key)
    if (!r) {
      r = {
        key,
        service: m[src.serviceLabel] ?? '',
        namespace: src.namespaceLabel ? m[src.namespaceLabel] : undefined,
        rps: null,
        errorPct: null,
        p50: null,
        p95: null,
        p99: null,
        rpsTrend: [],
        errTrend: [],
        p95Trend: [],
      }
      rows.set(key, r)
    }
    return r
  }
  for (const s of parts.rps ?? []) {
    const r = get(s.metric)
    r.rps = lastPoint(s)
    r.rpsTrend = s.points.map((p) => p[1])
  }
  for (const s of parts.err ?? []) {
    const r = get(s.metric)
    r.errorPct = lastPoint(s)
    r.errTrend = s.points.map((p) => p[1])
  }
  for (const s of parts.p50 ?? []) get(s.metric).p50 = lastPoint(s)
  for (const s of parts.p95 ?? []) {
    const r = get(s.metric)
    r.p95 = lastPoint(s)
    r.p95Trend = s.points.map((p) => p[1])
  }
  for (const s of parts.p99 ?? []) get(s.metric).p99 = lastPoint(s)
  // A service with no name is a scrape that lacks the grouping label — not a service.
  return [...rows.values()].filter((r) => r.service !== '')
}

export type Health = 'ok' | 'warn' | 'crit' | 'none'

/** Error-rate health (percent). */
export function errorHealth(pct: number | null | undefined): Health {
  if (pct == null || !Number.isFinite(pct)) return 'none'
  if (pct >= 5) return 'crit'
  if (pct >= 1) return 'warn'
  return 'ok'
}

/** Utilisation health (percent). */
export function utilHealth(pct: number | null | undefined, warn = 75, crit = 90): Health {
  if (pct == null || !Number.isFinite(pct)) return 'none'
  if (pct >= crit) return 'crit'
  if (pct >= warn) return 'warn'
  return 'ok'
}

export function worst(...hs: Health[]): Health {
  if (hs.includes('crit')) return 'crit'
  if (hs.includes('warn')) return 'warn'
  if (hs.includes('ok')) return 'ok'
  return 'none'
}
