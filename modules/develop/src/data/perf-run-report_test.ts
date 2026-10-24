import { assertEquals } from 'jsr:@std/assert@^1'
import { escapeHtml, runReportHtml } from './perf-run-report.ts'
import { runLifecycle } from './perf-run-model.ts'
import { parseK6Summary } from './k6-summary.ts'
import { metricsFromSummary } from './perf-results.ts'
import { parsePlan } from './perf-plan.ts'
import { SCRIPT_STAGES, V1_FAILING_LOG } from './testdata/k6-v1-runner-log.ts'

Deno.test('escapes everything it interpolates', () => {
  assertEquals(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;')
})

Deno.test('a run report carries the verdict, thresholds and no raw markup', () => {
  const summary = parseK6Summary(V1_FAILING_LOG)
  const html = runReportHtml({
    name: 'r1',
    namespace: 'test',
    test: '<script>alert(1)</script>',
    stage: 'finished',
    parallelism: 1,
    lifecycle: runLifecycle({ metadata: { name: 'r1' }, status: { stage: 'finished' } }, [], 0, 99),
    plan: parsePlan(SCRIPT_STAGES),
    summary,
    metrics: metricsFromSummary(summary),
    pods: [],
    generatedAt: new Date(0),
  })
  assertEquals(html.includes('<script>alert(1)</script>'), false)
  assertEquals(html.includes('Thresholds failed'), true)
  assertEquals(html.includes('rate&lt;0.01'), true)
})
