import { assert, assertStringIncludes } from 'jsr:@std/assert@1'
import { chaosReportPdf } from './chaos-report-pdf.ts'
import type { ChaosRunReport } from './chaos-report.ts'

const SHA = '3f9c2a1' + '0'.repeat(33)

const report: ChaosRunReport = {
  id: 'cart.shop-test.1',
  app: 'cart',
  namespace: 'shop-test',
  environment: 'test',
  commit: SHA,
  commitSource: 'image-tag',
  image: `h/shop/cart:${SHA}`,
  trigger: 'console',
  triggeredByUser: 'ana@example.com',
  finishedAt: '2026-10-22T10:00:00Z',
  recordedAt: '2026-10-22T10:01:00Z',
  experiments: [
    { name: 'pod-delete', status: 'passed', probeSuccessPercentage: 100, recoverySeconds: 12 },
    { name: 'pod-cpu-hog', status: 'failed', probeSuccessPercentage: 64, recoverySeconds: 95 },
  ],
  checks: [{ name: 'pod_disruption_budget', applicable: true, score: 0, detail: 'none' }],
}

Deno.test('the PDF carries the commit, the sections and a link to the commit', () => {
  const bytes = chaosReportPdf(report, { previous: { ...report, id: 'p', finishedAt: '2026-10-22T09:00:00Z' } }, {
    generatedAt: '2026-10-22T10:05:00Z',
    commitHref: `https://gitea.example/shop/cart/commit/${SHA}`,
  })
  const out = Array.from(bytes, (c) => String.fromCharCode(c)).join('')
  assert(out.startsWith('%PDF-1.4'))
  for (const s of [SHA, '(3f9c2a1)', 'EXECUTIVE SUMMARY', 'OBSERVATIONS', 'RECOMMENDATIONS', 'Compared'.toUpperCase(), 'Page 1 of']) {
    assertStringIncludes(out, s)
  }
  assertStringIncludes(out, `/URI (https://gitea.example/shop/cart/commit/${SHA})`)
  assert(bytes.length < 200_000)
})
