import { assert, assertStringIncludes } from 'jsr:@std/assert@1'
import { readinessReport, type ScorerApplication } from './perf-readiness.ts'
import { perfReportPdf } from './perf-report-pdf.ts'

const app: ScorerApplication = {
  kind: 'application',
  name: 'cart',
  score: 64,
  grade: 'D',
  environment: 'prod',
  categories: { performance: 55, resilience: 70 },
  signals: [
    { name: 'load_test', category: 'performance', applicable: true, score: 0, detail: 'p95 640 ms over 500 ms' },
    { name: 'replicas_ha', category: 'resilience', applicable: true, score: 0, detail: '1 replica' },
  ],
  evidence: {
    environment: 'test',
    testedAt: '2026-10-22T09:00:00Z',
    performance: { status: 'failed', p95Ms: 640, p99Ms: 1900, errorRate: 0.002, thresholdP95Ms: 500, thresholdErrorRate: 0.01, rps: 120 },
    chaosSuite: { 'pod-delete': { status: 'failed', probeSuccessPercentage: 62, recoverySeconds: 48 } },
  },
}

Deno.test('the PDF is a real PDF with every section and page numbers', () => {
  const bytes = perfReportPdf(readinessReport(app), { generatedAt: '2026-10-22T10:00:00Z', generatedBy: 'Ana' })
  const out = Array.from(bytes, (c) => String.fromCharCode(c)).join('')
  assert(out.startsWith('%PDF-1.4'))
  assert(out.trimEnd().endsWith('%%EOF'))
  for (const s of ['EXECUTIVE SUMMARY', 'TEST RESULTS', 'KEY MEASUREMENTS', 'OBSERVATIONS', 'RECOMMENDATIONS', 'ALL READINESS CHECKS', 'Page 1 of', 'p95 latency is over target under load', 'by Ana']) {
    assertStringIncludes(out, s)
  }
  assert(bytes.length < 200_000)
})

Deno.test('an application with no evidence still produces a report that says what is missing', () => {
  const bytes = perfReportPdf(readinessReport({ kind: 'application', name: 'web', score: 0, grade: 'F' }), { generatedAt: '2026-10-22T10:00:00Z' })
  const out = Array.from(bytes, (c) => String.fromCharCode(c)).join('')
  assertStringIncludes(out, 'No automated load test result yet')
  assertStringIncludes(out, 'No live request metrics')
})
