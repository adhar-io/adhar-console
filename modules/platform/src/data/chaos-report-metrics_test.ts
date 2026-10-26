import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { type MetricPoint, parseRunnerTimeline } from '@adhar/utils'
import {
  alignedPoints,
  chaosFindings,
  chaosReportHtml,
  type ChaosRunReport,
  metricCaption,
  metricChartSvg,
  reportMetrics,
  runDomain,
  timelineRows,
  timelineSvg,
} from './chaos-report.ts'
import { chaosReportPdf } from './chaos-report-pdf.ts'

const T0 = Date.parse('2026-10-22T09:48:00Z')
const LOG = [
  '2026-10-22T09:50:05Z adhar-resilience: cart: load test against http://cart',
  '2026-10-22T09:51:25Z adhar-resilience: cart: performance {"status":"passed"}',
  '2026-10-22T09:51:26Z adhar-resilience: cart: pod-delete chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:52:20Z adhar-resilience: cart: pod-delete {"status":"passed","probeSuccessPercentage":100,"recoverySeconds":12}',
  '2026-10-22T09:52:21Z adhar-resilience: cart: pod-cpu-hog chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:53:30Z adhar-resilience: cart: pod-cpu-hog {"status":"failed","probeSuccessPercentage":64,"recoverySeconds":20}',
].join('\n')
const phases = parseRunnerTimeline(LOG, 'cart').phases
const series = (f: (t: number) => number): MetricPoint[] => Array.from({ length: 64 }, (_, i) => [T0 + i * 15_000, f(T0 + i * 15_000)])
const inFault = (t: number) => phases.some((p) => p.kind === 'fault' && t >= p.start && t <= (p.end ?? 0))

const base: ChaosRunReport = {
  id: 'cart.shop-test.1',
  app: 'cart',
  namespace: 'shop-test',
  environment: 'test',
  commitSource: 'unknown',
  trigger: 'console',
  startedAt: '2026-10-22T09:50:00Z',
  finishedAt: '2026-10-22T09:53:30Z',
  recordedAt: '2026-10-22T09:54:00Z',
  experiments: [
    { name: 'pod-delete', status: 'passed', probeSuccessPercentage: 100, recoverySeconds: 12 },
    { name: 'pod-cpu-hog', status: 'failed', probeSuccessPercentage: 64, recoverySeconds: 20 },
  ],
}

const withMetrics: ChaosRunReport = {
  ...base,
  phases,
  metrics: {
    window: { start: T0, end: T0 + 63 * 15_000, stepSeconds: 15 },
    selector: 'namespace="shop-test",pod=~"cart-[a-z0-9]{1,10}-[a-z0-9]{5}"',
    capturedAt: '2026-10-22T09:57:00Z',
    source: 'prometheus',
    series: [
      { id: 'rps', label: 'Request rate', unit: 'rps', points: series((t) => (inFault(t) ? 2 : 40)) },
      { id: 'errors', label: 'Error rate (5xx)', unit: 'percent', points: series((t) => (inFault(t) ? 12 : 0.1)) },
      { id: 'ready', label: 'Ready pods', unit: 'count', points: series((t) => (inFault(t) ? 0 : 2)) },
      { id: 'restarts', label: 'Container restarts', unit: 'count', points: series((t) => (t > T0 + 300_000 ? 2 : 0)) },
    ],
    missing: [{ id: 'p95', label: 'p95 latency', reason: 'The application exports no HTTP request metrics.' }],
  },
}

Deno.test('a report with series renders the timeline, every chart with shaded faults, and what is missing', () => {
  const html = chaosReportHtml(withMetrics, {}, { generatedAt: '2026-10-22T10:00:00Z' })
  assertStringIncludes(html, '<h2>Run timeline</h2>')
  assertStringIncludes(html, 'aria-label="Run timeline"')
  assertStringIncludes(html, '<h2>Target metrics during the run</h2>')
  for (const label of ['Request rate', 'Error rate (5xx)', 'Ready pods', 'Container restarts', 'Steady-state probe']) assertStringIncludes(html, `<h4>${label}</h4>`)
  assertStringIncludes(html, 'The application exports no HTTP request metrics.')
  // Fault bands are drawn inside the charts.
  assert((html.match(/fill-opacity="\.12"/g) ?? []).length >= 4)
  // Nothing in the SVG is NaN or Infinity.
  assert(!/NaN|Infinity/.test(html))
})

Deno.test('metrics produce findings that explain the dips against the baseline', () => {
  const f = chaosFindings(withMetrics).filter((x) => x.area === 'Target metrics')
  assertEquals(f.map((x) => x.title), [
    'Server errors rose to 12% during the faults',
    'No pod was ready during a fault',
    '2 container restarts during the run',
  ])
  const m = reportMetrics(withMetrics).find((x) => x.def.id === 'errors')!
  assertEquals(metricCaption(m, phases), 'peak 12% during faults · baseline 0.1%')
})

Deno.test('an old report (no phases, no series) still renders, and says why there are no charts', () => {
  const html = chaosReportHtml(base, {}, { generatedAt: '2026-10-22T10:00:00Z' })
  assertStringIncludes(html, 'recorded without target metrics')
  assert(!html.includes('<h2>Run timeline</h2>'))
  assertEquals(chaosFindings(base).filter((x) => x.area === 'Target metrics'), [])
  assertEquals(runDomain(base), undefined)
  // A note from the recorder is what is shown.
  assertStringIncludes(chaosReportHtml({ ...base, metricsNote: 'Prometheus could not be queried (HTTP 503).' }, {}, { generatedAt: 'x' }), 'Prometheus could not be queried (HTTP 503).')
})

Deno.test('phases alone (no Prometheus) still give the timeline and the probe chart', () => {
  const html = chaosReportHtml({ ...base, phases, metricsNote: 'Prometheus is not configured.' }, {}, { generatedAt: 'x' })
  assertStringIncludes(html, '<h2>Run timeline</h2>')
  assertStringIncludes(html, '<h4>Steady-state probe</h4>')
  assertStringIncludes(html, 'Prometheus is not configured.')
})

Deno.test('timeline rows join each fault with its recovery and carry the outcome', () => {
  const rows = timelineRows(phases)
  assertEquals(rows.map((r) => [r.label, r.parts.length, r.tone]), [['Load test', 1, 'good'], ['Pod delete', 2, 'good'], ['CPU saturation', 2, 'bad']])
  assertStringIncludes(rows[2].note, 'probe 64%')
  assertEquals(timelineSvg([], [0, 1]), '')
  assertStringIncludes(metricChartSvg([], { label: 'x', unit: 'count', color: '#000' }, [0, 1], []), 'No samples')
})

Deno.test('runs align on their own start for overlaying', () => {
  const pts = alignedPoints(withMetrics, 'rps')
  assertEquals(pts[0][0], T0 - Date.parse('2026-10-22T09:50:00Z'))
  assertEquals(alignedPoints(base, 'rps'), [])
})

Deno.test('the PDF draws the timeline and charts, and an old report still builds', () => {
  const dec = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('')
  const out = dec(chaosReportPdf(withMetrics, {}, { generatedAt: '2026-10-22T10:00:00Z' }))
  for (const s of ['RUN TIMELINE', 'TARGET METRICS DURING THE RUN', '(Request rate)', '(Error rate \\(5xx\\))', '(Load test)', 'peak 12% during faults']) assertStringIncludes(out, s)
  assert(!/NaN/.test(out))
  const old = dec(chaosReportPdf(base, {}, { generatedAt: '2026-10-22T10:00:00Z' }))
  assertStringIncludes(old, 'recorded without target metrics')
  assert(!old.includes('RUN TIMELINE'))
})
