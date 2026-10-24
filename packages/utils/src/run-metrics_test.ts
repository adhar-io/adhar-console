import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  bandsFrom,
  captureWindow,
  chartScale,
  compactPoints,
  deltaFromFirst,
  downsample,
  faultImpact,
  formatMetric,
  MAX_POINTS,
  type MetricPoint,
  niceCeil,
  parseRunnerTimeline,
  podRegexForApp,
  podRegexFromPods,
  pointsFromMatrix,
  probeSeries,
  rateFor,
  roundSig,
  runMetricQueries,
  segments,
  segmentsFor,
  stepFor,
  yMaxFor,
} from './run-metrics.ts'

const T0 = Date.parse('2026-10-22T09:50:00Z')

Deno.test('matrix values become sorted, finite [ms, n] points', () => {
  assertEquals(pointsFromMatrix([[20, '2'], [10, '1'], [30, 'NaN'], [40, '+Inf']]), [[10_000, 1], [20_000, 2]])
  assertEquals(pointsFromMatrix(undefined), [])
})

Deno.test('downsampling keeps the endpoints, the bound and the dip', () => {
  const pts: MetricPoint[] = Array.from({ length: 1000 }, (_, i) => [i * 1000, i === 500 ? 0 : 100])
  const out = downsample(pts, 50)
  assertEquals(out.length, 50)
  assertEquals(out[0], pts[0])
  assertEquals(out[out.length - 1], pts[999])
  // The single-sample outage survives — averaging would have hidden it.
  assert(out.some(([, v]) => v === 0))
  // Short series pass through untouched.
  assertEquals(downsample(pts.slice(0, 10), 50), pts.slice(0, 10))
})

Deno.test('compacted series are bounded, ordered and rounded', () => {
  const pts: MetricPoint[] = Array.from({ length: 900 }, (_, i) => [T0 + (899 - i) * 5000, Math.PI * i])
  const out = compactPoints(pts)
  assert(out.length <= MAX_POINTS)
  for (let i = 1; i < out.length; i++) assert(out[i][0] > out[i - 1][0])
  assertEquals(roundSig(3.14159265, 4), 3.142)
  assertEquals(roundSig(0.000123456, 3), 0.000123)
  assertEquals(roundSig(0), 0)
})

Deno.test('window pads the run and falls back when no start was recorded', () => {
  const w = captureWindow({ startedAt: '2026-10-22T09:50:00Z', finishedAt: '2026-10-22T10:00:00Z' })!
  assertEquals(w.start, T0 - 120_000)
  assertEquals(w.end, T0 + 10 * 60_000 + 120_000)
  const noStart = captureWindow({ finishedAt: '2026-10-22T10:00:00Z' })!
  assertEquals(noStart.end - noStart.start, 15 * 60_000 + 240_000)
  // A phase earlier than the recorded start widens the window.
  const early = captureWindow({ startedAt: '2026-10-22T09:50:00Z', finishedAt: '2026-10-22T10:00:00Z', phases: [{ kind: 'load', name: 'load-test', start: T0 - 60_000 }] })!
  assertEquals(early.start, T0 - 180_000)
  assertEquals(captureWindow({ finishedAt: 'nope' }), undefined)
})

Deno.test('step keeps a range under the point budget, in 5 s units, never under 15 s', () => {
  assertEquals(stepFor(0, 10 * 60_000), 15)
  const day = stepFor(0, 24 * 3600_000)
  assert(86_400 / day <= MAX_POINTS)
  assertEquals(day % 5, 0)
  assertEquals(rateFor(15), '60s')
  assertEquals(rateFor(60), '240s')
})

Deno.test('queries select the app pods, escape label values and cover every metric', () => {
  const q = runMetricQueries({ namespace: 'shop-test', podRegex: podRegexForApp('cart.v2') })
  assertEquals(q.map((x) => x.id), ['rps', 'errors', 'p95', 'ready', 'restarts', 'cpu', 'memory'])
  for (const x of q) assert(x.query.includes('namespace="shop-test"'))
  assert(q[0].query.includes('pod=~"cart\\\\.v2-[a-z0-9]+-[a-z0-9]+"'))
  assert(runMetricQueries({ namespace: 'a"b', podRegex: 'x' })[0].query.includes('namespace="a\\"b"'))
})

Deno.test('pod regex from live pods follows the controller, not the pod', () => {
  assertEquals(podRegexFromPods([{ name: 'cart-7d9f8-abcde', templateHash: '7d9f8' }, { name: 'cart-7d9f8-zzzzz', templateHash: '7d9f8' }]), 'cart-[a-z0-9]+-[a-z0-9]+')
  assertEquals(podRegexFromPods([{ name: 'db-0' }, { name: 'web-5c-x1', templateHash: '5c' }]), '(db-[a-z0-9]+|web-[a-z0-9]+-[a-z0-9]+)')
  assertEquals(podRegexFromPods([]), undefined)
})

const LOG = [
  '2026-10-22T09:50:01.123456789Z adhar-resilience: 1 application(s) delivered by the control plane',
  '2026-10-22T09:50:02Z adhar-resilience: other: load test against http://other',
  '2026-10-22T09:50:05.5Z adhar-resilience: cart: load test against http://cart.shop-test.svc.cluster.local:8080/ in test (p95 < 500 ms, errors < 0.01)',
  '2026-10-22T09:51:25Z adhar-resilience: cart: performance {"status":"passed","p95Ms":210}',
  '2026-10-22T09:51:26Z adhar-resilience: cart: pod-delete chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:52:20Z adhar-resilience: cart: pod-delete {"status":"passed","verdict":"Pass","probeSuccessPercentage":100,"recoverySeconds":12}',
  '2026-10-22T09:52:21Z adhar-resilience: cart: pod-cpu-hog chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:53:00Z adhar-resilience: cart: pod-cpu-hog produced no verdict (x); retrying once',
  '2026-10-22T09:53:01Z adhar-resilience: cart: pod-cpu-hog chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:54:00Z adhar-resilience: cart: pod-cpu-hog {"status":"failed","probeSuccessPercentage":64,"recoverySeconds":0}',
  '2026-10-22T09:54:01Z adhar-resilience: cart: pod-network-latency chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:54:02Z ADHAR_GATE_VERDICT {"verdict":"fail","reasons":["pod-cpu-hog failed: x"]}',
  'not a timestamped line',
].join('\n')

Deno.test('the runner log becomes phases: load, faults, recovery, still-running', () => {
  const tl = parseRunnerTimeline(LOG, 'cart')
  assertEquals(tl.phases.map((p) => `${p.kind}:${p.name}:${p.status}`), [
    'load:load-test:passed',
    'fault:pod-delete:passed',
    'recovery:pod-delete:passed',
    'fault:pod-cpu-hog:failed',
    'fault:pod-network-latency:running',
  ])
  const load = tl.phases[0]
  assertEquals(load.start, Date.parse('2026-10-22T09:50:05.500Z'))
  const del = tl.phases[1]
  assertEquals(del.end, Date.parse('2026-10-22T09:52:08Z'))
  assertEquals(del.recoverySeconds, 12)
  assertEquals(del.probeSuccessPercentage, 100)
  assertEquals(del.plannedSeconds, 30)
  // The retry continued the first attempt's phase.
  assertEquals(tl.phases[3].start, Date.parse('2026-10-22T09:52:21Z'))
  assertEquals(tl.phases[4].end, undefined)
  assertEquals(tl.gate, { verdict: 'fail', reasons: ['pod-cpu-hog failed: x'] })
  assertEquals(tl.lastAt, Date.parse('2026-10-22T09:54:02Z'))
  assertEquals(parseRunnerTimeline('', 'cart').phases, [])
})

Deno.test('probe series holds each fault result over its window; restarts become deltas', () => {
  const tl = parseRunnerTimeline(LOG, 'cart')
  const p = probeSeries(tl.phases)
  assertEquals(p.length, 4)
  assertEquals(p[0][1], 100)
  assertEquals(p[3][1], 64)
  assertEquals(deltaFromFirst([[1, 4], [2, 5], [3, 1]]), [[1, 0], [2, 1], [3, 0]])
})

Deno.test('fault impact compares the worst sample during faults with the baseline before', () => {
  const tl = parseRunnerTimeline(LOG, 'cart')
  const pts: MetricPoint[] = [[T0, 0.1], [T0 + 60_000, 0.1], [Date.parse('2026-10-22T09:51:40Z'), 8], [Date.parse('2026-10-22T09:52:30Z'), 12]]
  assertEquals(faultImpact(pts, tl.phases, 'max'), { baseline: 0.1, during: 12 })
  assertEquals(faultImpact([], tl.phases, 'max'), {})
})

Deno.test('chart scale maps the domain into the frame and bands are clipped', () => {
  const frame = { width: 600, height: 160, pad: { l: 40, r: 10, t: 10, b: 20 } }
  const s = chartScale([[[0, 0], [100, 47]]], frame)!
  assertEquals(s.x(0), 40)
  assertEquals(s.x(100), 590)
  // 47 with 8% headroom is 50.8, whose nice ceiling is 100.
  assertEquals(s.top, 100)
  assertEquals(s.y(0), 140)
  assertEquals(s.y(s.top), 10)
  // Values never leave the plot.
  assertEquals(s.y(1e9), 10)
  assertEquals(s.y(-5), 140)
  assertEquals(niceCeil(47), 50)
  assertEquals(niceCeil(0.03), 0.05)
  assertEquals(chartScale([[]], frame), undefined)
  assertEquals(bandsFrom([{ kind: 'fault', name: 'x', start: -10, end: 50 }, { kind: 'prepare', name: 'p', start: 0, end: 5 }], [0, 100]), [{ start: 0, end: 50, kind: 'fault', label: 'x' }])
})

Deno.test('count and probe axes get readable ceilings', () => {
  assertEquals(yMaxFor('ready', 'count', [[0, 3], [1, 1]]), 4)
  assertEquals(yMaxFor('restarts', 'count', [[0, 0]]), 2)
  assertEquals(yMaxFor('probe', 'percent', [[0, 40]]), 100)
  assertEquals(yMaxFor('cpu', 'cores', [[0, 3]]), undefined)
})

Deno.test('segments break at collection gaps', () => {
  const pts: MetricPoint[] = [[0, 1], [10, 1], [20, 1], [200, 1], [210, 1]]
  assertEquals(segments(pts).map((s) => s.length), [3, 2])
  // The probe is one flat piece per fault, never joined across the pause.
  assertEquals(segmentsFor('probe', [[0, 100], [10, 100], [50, 64], [60, 64]]), [[[0, 100], [10, 100]], [[50, 64], [60, 64]]])
})

Deno.test('metric values read in their own units', () => {
  assertEquals(formatMetric(1536 * 1024 * 1024, 'bytes'), '1.5 GiB')
  assertEquals(formatMetric(0.25, 'cores'), '250m')
  assertEquals(formatMetric(1234, 'ms'), '1.23 s')
  assertEquals(formatMetric(0.5, 'percent'), '0.5%')
  assertEquals(formatMetric(12.345, 'rps'), '12.3/s')
  assertEquals(formatMetric(undefined, 'rps'), '—')
})
