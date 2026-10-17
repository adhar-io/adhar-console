import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  capacityQueries,
  detectSources,
  errorHealth,
  escRe,
  httpQueries,
  HTTP_SOURCES_V2,
  joinRed,
  lokiErrorVolume,
  lokiSelector,
  missingExporters,
  pickSource,
  podHealthQueries,
  podRegex,
  saturationQueries,
  serviceBy,
  utilHealth,
  withResponsesResolved,
  worst,
} from './golden-signals.ts'

const hubble = HTTP_SOURCES_V2.find((s) => s.id === 'hubble')!
const nginx = HTTP_SOURCES_V2.find((s) => s.id === 'nginx')!
const span = HTTP_SOURCES_V2.find((s) => s.id === 'spanmetrics')!
const istio = HTTP_SOURCES_V2.find((s) => s.id === 'istio')!

Deno.test('detectSources keeps preference order and only present families', () => {
  const got = detectSources(['http_requests_total', 'hubble_http_requests_total', 'up'])
  assertEquals(got.map((s) => s.id), ['hubble', 'app'])
  assertEquals(detectSources(['up']), [])
})

Deno.test('pickSource honours an explicit id, else the first detected', () => {
  const d = detectSources(['http_requests_total', 'hubble_http_requests_total'])
  assertEquals(pickSource(d, 'app')?.id, 'app')
  assertEquals(pickSource(d, 'nope')?.id, 'hubble')
  assertEquals(pickSource([], null), null)
})

Deno.test('Hubble httpV2: status on requests counter when no responses metric', () => {
  const s = withResponsesResolved(hubble, ['hubble_http_requests_total'])
  assertEquals(s.responses, undefined)
  const q = httpQueries(s, {}, '5m')
  assertStringIncludes(q.errorPct, 'hubble_http_requests_total{status=~"5.."}')
  const v1 = withResponsesResolved(hubble, ['hubble_http_requests_total', 'hubble_http_responses_total'])
  assertStringIncludes(httpQueries(v1, {}, '5m').errorPct, 'hubble_http_responses_total{status=~"5.."}')
})

Deno.test('reporter de-duplication wraps the sum in max', () => {
  const q = httpQueries(hubble, {}, '5m')
  assertEquals(q.rps, 'max (sum by (reporter) (rate(hubble_http_requests_total[5m])))')
  const by = httpQueries(hubble, {}, '5m', serviceBy(hubble))
  assertEquals(
    by.rps,
    'max by (destination_namespace, destination_workload) (sum by (destination_namespace, destination_workload, reporter) (rate(hubble_http_requests_total[5m])))',
  )
  // Families without reporters sum directly.
  assertEquals(httpQueries(nginx, {}, '5m').rps, 'sum(rate(nginx_ingress_controller_requests[5m]))')
})

Deno.test('scope adds namespace + service matchers with the family labels', () => {
  const q = httpQueries(nginx, { namespace: 'shop', service: 'cart' }, '10m')
  assertStringIncludes(q.rps, 'nginx_ingress_controller_requests{exported_namespace="shop", service="cart"}[10m]')
  // spanmetrics has no namespace label — namespace scope is ignored, service kept.
  const s = httpQueries(span, { namespace: 'shop', service: 'cart' }, '5m')
  assertStringIncludes(s.rps, 'traces_spanmetrics_calls_total{service="cart"}')
  assertEquals(s.clientErrorPct, null)
  assertEquals(s.rpsByClass, null)
  assertStringIncludes(s.errorPct, 'status_code=~"STATUS_CODE_ERROR"')
})

Deno.test('latency quantiles convert to ms only when needed', () => {
  assertStringIncludes(httpQueries(nginx, {}, '5m').p99!, '1000 * histogram_quantile(0.99, sum by (le) (rate(nginx_ingress_controller_request_duration_seconds_bucket[5m])))')
  const i = httpQueries(istio, {}, '5m').p50!
  assert(i.startsWith('histogram_quantile(0.5,'), i)
})

Deno.test('podRegex is anchored to the workload and escapes regex chars', () => {
  assertEquals(podRegex('api'), 'api(-[a-z0-9]{5,10}){1,2}|api-[0-9]+')
  const re = new RegExp(`^(?:${podRegex('api')})$`)
  assert(re.test('api-7d9f8b6c5-x2x9q'))
  assert(re.test('api-0'))
  assert(re.test('api-abcde'))
  assert(!re.test('api-worker-7d9f8b6c5-x2x9q'))
  assertEquals(escRe('a.b'), 'a\\\\.b')
})

Deno.test('saturation: node-exporter at cluster scope, cAdvisor when scoped', () => {
  const c = saturationQueries({}, '5m')
  assertEquals(c.exporter, 'node-exporter')
  assertStringIncludes(c.cpuPct, 'node_cpu_seconds_total{mode="idle"}')
  const n = saturationQueries({ namespace: 'shop' }, '5m')
  assertEquals(n.exporter, 'cAdvisor')
  assertStringIncludes(n.cpuPct, 'container_cpu_usage_seconds_total{container!="", container!="POD", namespace="shop"}')
  assertEquals(n.diskPct, null)
})

Deno.test('pod health + capacity queries carry the scope', () => {
  const p = podHealthQueries({ namespace: 'adhar-system' }, '1h')
  assertStringIncludes(p.crashloop, 'namespace="adhar-system", reason="CrashLoopBackOff"')
  assertStringIncludes(p.restarts, '[1h]')
  const cap = capacityQueries({ namespace: 'x' }, '5m')
  assertStringIncludes(cap.cpuReq, 'kube_pod_container_resource_requests{resource="cpu", namespace="x"}')
  assertEquals(cap.cpuAlloc, 'sum(kube_node_status_allocatable{resource="cpu"})')
})

Deno.test('Loki helpers produce valid selectors', () => {
  assertEquals(lokiSelector({}), '{namespace=~".+"}')
  assertEquals(lokiSelector({ namespace: 'a' }), '{namespace="a"}')
  assertEquals(lokiSelector({ service: 'cart' }), '{service_name="cart"}')
  const v = lokiErrorVolume({}, 60)
  assertStringIncludes(v, 'sum by (namespace) (count_over_time({namespace=~".+"}')
  assertStringIncludes(v, '[60s]')
})

Deno.test('missingExporters reports only absent ones and nothing before names load', () => {
  assertEquals(missingExporters(undefined, ['node-exporter']), [])
  assertEquals(missingExporters(['kube_pod_status_phase'], ['kube-state-metrics', 'node-exporter']), ['node-exporter'])
})

Deno.test('joinRed merges per-service series and drops unlabeled scrapes', () => {
  const m = (ns: string, wl: string) => ({ destination_namespace: ns, destination_workload: wl })
  const rows = joinRed(hubble, {
    rps: [{ metric: m('shop', 'cart'), points: [[1, 2], [2, 4]] }, { metric: {}, points: [[1, 9]] }],
    err: [{ metric: m('shop', 'cart'), points: [[2, 1.5]] }],
    p95: [{ metric: m('shop', 'cart'), points: [[2, 120]] }],
  })
  assertEquals(rows.length, 1)
  assertEquals(rows[0].service, 'cart')
  assertEquals(rows[0].namespace, 'shop')
  assertEquals(rows[0].rps, 4)
  assertEquals(rows[0].errorPct, 1.5)
  assertEquals(rows[0].p95, 120)
  assertEquals(rows[0].p99, null)
  assertEquals(rows[0].rpsTrend, [2, 4])
})

Deno.test('health classification', () => {
  assertEquals(errorHealth(null), 'none')
  assertEquals(errorHealth(0.2), 'ok')
  assertEquals(errorHealth(2), 'warn')
  assertEquals(errorHealth(7), 'crit')
  assertEquals(utilHealth(80), 'warn')
  assertEquals(utilHealth(95), 'crit')
  assertEquals(worst('ok', 'none', 'warn'), 'warn')
  assertEquals(worst('none'), 'none')
})
