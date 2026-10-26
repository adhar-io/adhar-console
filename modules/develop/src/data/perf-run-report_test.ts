import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1'
import { buildRunReport, chartSvg, escapeHtml, inputFromRecord, previousRecord, type ReportCharts, runReportHtml } from './perf-run-report.ts'
import { runReportPdf } from './perf-run-report-pdf.ts'
import { chartsFromAnswers, reportChartQueries } from './perf-report-charts.ts'
import { runLifecycle } from './perf-run-model.ts'
import { parseK6Summary } from './k6-summary.ts'
import { metricsFromSummary, recordFromConfigMap, resultConfigMap, type RunRecord } from './perf-results.ts'
import { evaluateGate } from './perf-gate.ts'
import { parsePlan } from './perf-plan.ts'
import { SCRIPT_STAGES, STORED_NO_P99, V1_FAILING_LOG, V1_WITH_P99_LOG } from './testdata/k6-v1-runner-log.ts'

/** The result ConfigMap exactly as it sits on the cluster (2026-10-25), as the console lists it. */
function storedRecord(): RunRecord {
  return recordFromConfigMap({
    metadata: {
      name: 'k6-result-transaction-service-load-20261025-162828',
      namespace: 'test',
      creationTimestamp: '2026-10-25T08:31:07Z',
      labels: {
        'adhar.io/application': 'transaction-service',
        'adhar.io/perf-commit': '9f95a285926b30f9ec3564d2aecd0b236729bd44',
        'adhar.io/perf-result': 'true',
        'adhar.io/perf-test': 'transaction-service-load',
        'adhar.io/perf-trigger': 'console',
        'app.kubernetes.io/managed-by': 'adhar-console',
      },
      annotations: {
        'adhar.io/perf-exit-code': '0',
        'adhar.io/perf-finished': '2026-10-25T08:31:06Z',
        'adhar.io/perf-parallelism': '1',
        'adhar.io/perf-run': 'transaction-service-load-20261025-162828',
        'adhar.io/perf-stage': 'finished',
        'adhar.io/perf-started': '2026-10-25T08:28:29Z',
        'adhar.io/perf-verdict': 'pass',
      },
    },
    data: { 'summary.txt': STORED_NO_P99 },
  })!
}

const at = new Date('2026-10-27T10:00:00Z')

Deno.test('escapes everything it interpolates', () => {
  assertEquals(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;')
})

Deno.test('an OLD stored result (no p99, no TestRun) still makes a full report — p99 says "not recorded", with why', () => {
  const rec = storedRecord()
  const r = buildRunReport({ ...inputFromRecord(rec), verdict: evaluateGate({ metrics: rec.metrics, stage: rec.stage, exitCode: rec.exitCode }), generatedAt: at })
  assertEquals(r.verdict.label, 'Passed')
  assertEquals(r.verdict.tone, 'good')
  assertStringIncludes(r.verdict.headline, 'p95 31ms')
  assertStringIncludes(r.verdict.headline, 'p99 not recorded')
  assertStringIncludes(r.verdict.headline, 'over 2m 37s')
  const p99 = r.latency.find((l) => l.key === 'p99Ms')!
  assertEquals(p99.text, 'not recorded')
  assertStringIncludes(p99.note!, 'summaryTrendStats')
  assertEquals(r.kpis.find((k) => k.label === 'p99 latency')!.value, 'not recorded')
  // Same formatter as the Results table: 30.71 → "31ms", 15.4 req/s.
  assertEquals(r.kpis.find((k) => k.label === 'p95 latency')!.value, '31ms')
  assertEquals(r.kpis.find((k) => k.label === 'Throughput')!.value, '15.4/s')
  assertEquals(r.thresholds.map((t) => t.state), ['pass', 'pass', 'pass'])
  assertEquals(r.timeline.length, 1)
  assert(r.notes.some((n) => n.startsWith('p99 not recorded')))
  const html = runReportHtml(r)
  assertStringIncludes(html, 'class="nr" title="k6 reports p99 only when asked')
  assertEquals(html.includes('>—</td>'), false)
})

Deno.test('a new run with p99 reports it everywhere, and judges a p99 gate on it', () => {
  const summary = parseK6Summary(V1_WITH_P99_LOG)
  const metrics = metricsFromSummary(summary)
  const verdict = evaluateGate({ metrics, stage: 'finished', exitCode: 99, gate: { p99Ms: 50, requireThresholds: true, failOnRegression: false, tolerance: { latencyPct: 10, errorRatePts: 0.5, throughputPct: 10 } } })
  const r = buildRunReport({ run: 'r2', namespace: 'test', test: 'checkout', stage: 'finished', exitCode: 99, summary, metrics, verdict, generatedAt: at })
  assertEquals(r.latency.find((l) => l.key === 'p99Ms')!.text, '61ms')
  assertEquals(r.latency.find((l) => l.key === 'p99Ms')!.note, undefined)
  assertEquals(r.verdict.label, 'Failed')
  assert(r.verdict.reasons.some((x) => x.startsWith('p99 latency ≤ 50ms: 61ms vs 50ms')), r.verdict.reasons.join('\n'))
  assertEquals(r.thresholds.find((t) => t.expression === 'p(99)<40')!.actual, 'p(99)=61.2ms')
  assertEquals(r.notes.some((n) => n.includes('p99 not recorded')), false)
})

Deno.test('baseline and previous-run comparisons use the gate tolerance; an old baseline without p99 is "not comparable"', () => {
  const rec = { ...storedRecord(), metrics: { ...storedRecord().metrics!, p99Ms: 80 } }
  const prev: RunRecord = { ...storedRecord(), run: 'older', startedAt: '2026-10-24T08:00:00Z', metrics: { ...storedRecord().metrics!, p95Ms: 20 } }
  assertEquals(previousRecord(rec, [rec, prev])?.run, 'older')
  const r = buildRunReport({
    ...inputFromRecord(rec),
    baseline: { run: 'base', metrics: { p95Ms: 30, avgMs: 12, rps: 15, errorRatePct: 0 } },
    previous: { run: prev.run, startedAt: prev.startedAt, metrics: prev.metrics },
    generatedAt: at,
  })
  assertEquals(r.comparisons.map((c) => c.title), ['Against the baseline', 'Against the previous run'])
  const base = r.comparisons[0].rows
  assertEquals(base.find((x) => x.key === 'p99Ms')!.status, 'n/a')
  assertEquals(base.find((x) => x.key === 'p95Ms')!.status, 'within')
  const vsPrev = r.comparisons[1].rows.find((x) => x.key === 'p95Ms')!
  assertEquals(vsPrev.status, 'regressed')
  assertEquals(vsPrev.change, '+54%')
  assertEquals(r.comparisons[1].rows.find((x) => x.key === 'p99Ms')!.before, 'not recorded')
})

Deno.test('a run that never produced a summary is a report too — with the logged errors', () => {
  const rec: RunRecord = { ...storedRecord(), metrics: undefined, summary: undefined, stage: 'error', exitCode: 107, logExcerpt: ['TypeError: x is undefined'] }
  const r = buildRunReport({ ...inputFromRecord(rec), verdict: evaluateGate({ stage: 'error' }), generatedAt: at })
  assertEquals(r.verdict.tone, 'bad')
  assertEquals(r.kpis, [])
  assertEquals(r.logs, [{ level: 'error', text: 'TypeError: x is undefined' }])
  assertStringIncludes(runReportHtml(r), 'No end-of-test summary was kept')
})

Deno.test('the error lines a harvest keeps come back as the report\'s log excerpt', () => {
  const rec = recordFromConfigMap(resultConfigMap({ run: 'r1', test: 't', namespace: 'n', summaryText: V1_FAILING_LOG, trigger: 'console' }))!
  assertEquals(rec.logExcerpt, ["thresholds on metrics 'checks, http_req_failed' have been crossed"])
})

Deno.test('a live run with a lifecycle carries its phases and its plan, and never leaks markup', () => {
  const summary = parseK6Summary(V1_FAILING_LOG)
  const r = buildRunReport({
    run: 'r1',
    namespace: 'test',
    test: '<script>alert(1)</script>',
    stage: 'finished',
    lifecycle: runLifecycle({ metadata: { name: 'r1' }, status: { stage: 'finished' } }, [], 0, 99),
    plan: parsePlan(SCRIPT_STAGES),
    summary,
    metrics: metricsFromSummary(summary),
    config: { env: [{ name: 'API_TOKEN', value: 'hunter2' }, { name: 'BASE_URL', value: 'http://x' }] },
    generatedAt: at,
  })
  assertEquals(r.verdict.label, 'Thresholds failed')
  assertEquals(r.environment, [{ name: 'API_TOKEN', value: '••••••' }, { name: 'BASE_URL', value: 'http://x' }])
  const html = runReportHtml(r)
  assertEquals(html.includes('<script>alert(1)</script>'), false)
  assertEquals(html.includes('hunter2'), false)
  assertStringIncludes(html, 'rate&lt;0.01')
})

const START = Date.parse('2026-10-25T08:28:29Z')
const END = Date.parse('2026-10-25T08:31:06Z')

function sampleCharts(): ReportCharts {
  const input = { run: 'transaction-service-load-20261025-162828', namespace: 'test', application: 'transaction-service', startMs: START, endMs: END }
  const queries = reportChartQueries(input)
  // Real shape: CPU and memory answered, k6 remote write and HTTP metrics empty.
  const answers = queries.map((q) => {
    if (q.chart === 'target-cpu') return [[START - 60_000, 0.37], [START, 0.52], [START + 30_000, 0.6], [END, 0.4], [END + 400_000, 99]] as Array<[number, number]>
    if (q.chart === 'target-memory') return [[START - 60_000, 1.48e9], [START + 60_000, 2.06e9], [END, 2.1e9]] as Array<[number, number]>
    if (q.chart === 'runner-cpu') return [[START + 30_000, 0.01], [START + 60_000, 0.045], [END, 0.03]] as Array<[number, number]>
    return undefined
  })
  return chartsFromAnswers(input, queries, answers)
}

Deno.test('chart queries cover k6, the target application and the runners; empties become reasons', () => {
  const queries = reportChartQueries({ run: 'r1', namespace: 'test', application: 'transaction-service', startMs: START, endMs: END })
  assertEquals([...new Set(queries.map((q) => q.chart))], ['k6-load', 'k6-rps', 'k6-latency', 'k6-errors', 'target-cpu', 'target-memory', 'target-rps', 'target-latency', 'target-errors', 'target-ready', 'runner-cpu'])
  assert(queries.find((q) => q.chart === 'target-cpu')!.query.includes('namespace="test",pod=~"transaction-service-'))
  const c = sampleCharts()
  assertEquals(c.charts.map((x) => x.id), ['target-cpu', 'target-memory', 'runner-cpu'])
  assertEquals(c.missing.map((m) => m.label), ['k6 metrics over time', 'Target request rate, latency and errors', 'Target ready pods'])
  assertEquals(c.domain, [START - 60_000, END + 60_000])
  // No application recorded: the target is not guessed.
  const none = chartsFromAnswers({ run: 'r1', namespace: 'test', startMs: START, endMs: END }, [], [])
  assertEquals(none.missing.at(-1)!.label, 'The application under load')
})

Deno.test('the HTML chart stays inside its viewBox; out-of-window samples are dropped', () => {
  const c = sampleCharts()
  const svg = chartSvg(c.charts[0], c.domain, c.load)
  const nums = [...svg.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  assert(nums.length >= 3)
  for (const [x, y] of nums) assert(x >= 0 && x <= 440 && y >= 0 && y <= 160, `${x},${y}`)
  // The 99-core spike lies outside the window and does not set the axis.
  assertEquals(svg.includes('>99<'), false)
})

Deno.test('PDF: renders every section, and every chart mark stays inside the page margins', () => {
  const rec = storedRecord()
  const r = buildRunReport({ ...inputFromRecord(rec), verdict: evaluateGate({ metrics: rec.metrics, stage: rec.stage, exitCode: rec.exitCode }), charts: sampleCharts(), config: { arguments: '--vus 10', env: [{ name: 'BASE_URL', value: 'http://transaction-service.test.svc.cluster.local' }] }, link: 'https://console.example/develop?section=performance&report=test/x', generatedAt: at })
  const bytes = runReportPdf(r)
  const text = new TextDecoder('latin1').decode(bytes)
  assert(text.startsWith('%PDF-1.4'))
  for (const s of ['SUMMARY', 'LATENCY PERCENTILES', 'GATE AND THRESHOLDS', 'DURING THE RUN', 'ENVIRONMENT AND TEST CONFIGURATION', 'not recorded', 'Target CPU']) assertStringIncludes(text, s)
  const W = 595.28
  const H = 841.89
  let paths = 0
  for (const m of text.matchAll(/RG [\d.]+ w 1 J 1 j (?:\[[^\]]*\] 0 d )?((?:-?[\d.]+ -?[\d.]+ [ml] ?)+)S Q/g)) {
    paths++
    const nums = m[1].trim().split(/\s+/).filter((t) => t !== 'm' && t !== 'l').map(Number)
    for (let k = 0; k < nums.length; k += 2) {
      assert(nums[k] >= 40 && nums[k] <= W - 40, `x ${nums[k]}`)
      assert(nums[k + 1] >= 40 && nums[k + 1] <= H - 40, `y ${nums[k + 1]}`)
    }
  }
  assertEquals(paths, 3)
})

Deno.test('samples outside the run window do not make a chart — it is "not charted" instead of empty', () => {
  const input = { run: 'r1', namespace: 'test', application: 'app', startMs: START, endMs: END }
  const queries = reportChartQueries(input)
  const c = chartsFromAnswers(input, queries, queries.map(() => [[START - 3_600_000, 1], [START - 3_500_000, 2]] as Array<[number, number]>))
  assertEquals(c.charts, [])
  assert(c.missing.some((m) => m.label === 'Target CPU'))
})
