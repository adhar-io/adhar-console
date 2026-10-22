/**
 * The Performance Report as a PDF — the same sections, wording and colours as
 * the HTML report (perf-report.ts), laid out for A4 with the shared report
 * kit (`@adhar/utils/pdf`). Text stays text: selectable, searchable, small.
 *
 * Loaded on demand (the Readiness view imports it dynamically), so the writer
 * and this layout cost nothing until someone downloads a report.
 *
 * Pure: returns bytes, no DOM.
 */

import { REPORT_GRADE_COLOR, REPORT_PRIORITY_COLOR, scoreTone } from '@adhar/utils'
import {
  coverBand, facts, findingCard, findingCardHeight, fitText, footers, hex, INK, kpis, Layout, LINE, M, MUTED, PdfDocument, type Rgb,
  recommendationList, table, textWidth, tone, utc, WHITE, wrapText,
} from '@adhar/utils/pdf'
import { fmtGauge, type Gauge, type ReadinessReport, type Tone } from './perf-readiness.ts'
import { REPORT_AREAS, reportHeadline, type ReportMeta, reportSummary } from './perf-report.ts'

/** A sub-heading, its caption, the table header and a first row stay on one page. */
const KEEP_WITH_TABLE = 120

const RESULT_LABEL: Record<Tone, string> = { good: 'Pass', bad: 'Fail', warn: 'Watch', none: 'No data' }

function cover(L: Layout, r: ReadinessReport): void {
  const { doc } = L
  const H = 200
  coverBand(doc, H)
  const x = M
  const soft: Rgb = [0.86, 0.87, 0.97]
  L.text('ADHAR  ·  PERFORMANCE & RESILIENCE REPORT', x, 50, 'bold', 7.5, [0.78, 0.8, 0.95])
  L.text(r.app, x, 78, 'bold', 24, WHITE)
  const where = [
    r.gradedOn ? `graded on ${r.gradedOn}` : undefined,
    r.testedIn ? `tested in ${r.testedIn}` : 'not load-tested yet',
    r.testedAt ? utc(r.testedAt) : undefined,
  ].filter(Boolean).join('  ·  ')
  L.text(where, x, 96, 'regular', 8.5, soft)
  if (r.image) {
    L.text('Image', x, 112, 'regular', 8.5, soft)
    L.text(fitText(r.image, 'mono', 7, doc.width - 2 * M - 38), x + 38, 112, 'mono', 7, soft)
  }

  doc.circle(x + 24, 160, 24, { fill: hex(REPORT_GRADE_COLOR[r.grade] ?? '#64748b') })
  doc.circle(x + 24, 160, 27, { stroke: [0.55, 0.53, 0.85], lineWidth: 2.5 })
  L.text(r.grade, x + 24 - textWidth(r.grade, 'bold', 22) / 2, 168, 'bold', 22, WHITE)
  L.text(`${r.score}/100`, x + 62, 158, 'bold', 17, WHITE)
  L.text('production readiness', x + 62, 171, 'regular', 8, soft)

  const rings: Array<[string, number | null]> = [['Performance', r.performanceScore], ['Resilience', r.resilienceScore]]
  const cw = 206
  const cx0 = doc.width - M - cw
  doc.rect(cx0, 134, cw, 52, { fill: WHITE, radius: 9 })
  rings.forEach(([label, v], i) => {
    const cx = cx0 + 24 + i * 100
    const cy = 160
    doc.circle(cx, cy, 13, { stroke: LINE, lineWidth: 4 })
    doc.arc(cx, cy, 13, (v ?? 0) / 100, tone(scoreTone(v)), 4)
    const t = v === null ? 'n/a' : String(v)
    L.text(t, cx - textWidth(t, 'bold', 8) / 2, cy + 3, 'bold', 8, INK)
    L.text(label, cx + 18, cy + 3, 'regular', 7, MUTED)
  })
  L.y = H + 10
}

function gaugeTable(L: Layout, gauges: Gauge[]): void {
  table(L, [{ title: 'Metric', width: 3 }, { title: 'Measured', width: 1.6 }, { title: 'Target', width: 1.6 }, { title: 'Result', width: 1.2 }], gauges.map((g) => {
    const judged = g.target !== undefined || g.value === undefined
    const t: Tone = g.value === undefined ? 'none' : g.tone
    return [
      { text: g.label, sub: g.note },
      { text: fmtGauge(g), mono: true },
      { text: g.target !== undefined ? `${g.lowerIsBetter ? '<=' : '>='} ${fmtGauge({ value: g.target, unit: g.unit })}` : '—', mono: true },
      { text: '', pill: judged ? { tone: t, label: RESULT_LABEL[t] } : { tone: 'none' as Tone, label: 'Info' } },
    ]
  }))
}

function checksGrid(L: Layout, r: ReadinessReport): void {
  const colW = (L.W - 20) / 2
  const items = r.signals
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2).map((s) => ({
      s,
      detail: wrapText(`${!s.applicable ? 'Not applicable — ' : ''}${s.detail ?? (s.passed ? 'Pass' : 'Not met')}`, 'regular', 7.5, colW - 14),
      label: wrapText(s.label, 'regular', 9, colW - 14),
    }))
    const h = Math.max(...pair.map((p) => p.label.length * 11 + p.detail.length * 10)) + 8
    L.ensure(h)
    pair.forEach((p, j) => {
      const x = M + j * (colW + 20)
      const color = !p.s.applicable ? hex('#cbd5e1') : p.s.passed ? tone('good') : tone('bad')
      L.doc.circle(x + 4, L.y + 6, 3.5, { fill: color })
      p.label.forEach((t, k) => L.text(t, x + 13, L.y + 9 + k * 11, 'regular', 9, INK))
      p.detail.forEach((d, k) => L.text(d, x + 13, L.y + 9 + p.label.length * 11 + k * 10, 'regular', 7.5, MUTED))
    })
    L.y += h
  }
}

/** The report as PDF bytes. */
export function perfReportPdf(r: ReadinessReport, meta: ReportMeta): Uint8Array {
  const doc = new PdfDocument({
    title: `Performance Report — ${r.app}`,
    subject: `Performance and resilience readiness of ${r.app}`,
    author: meta.generatedBy ?? 'Adhar Console',
  })
  doc.addPage()
  const L = new Layout(doc)
  const { findings, recs, counts, applicable, passed, high } = reportSummary(r)

  cover(L, r)

  L.section('Executive summary')
  L.para(reportHeadline(r), { size: 11.5, color: INK, gap: 6 })
  L.para(r.verdict, { size: 8.5 })
  kpis(L, [
    { value: `${passed}/${applicable.length}`, label: 'readiness checks passing', color: tone('good') },
    { value: String(counts.bad), label: 'issues found', color: tone('bad') },
    { value: String(counts.warn), label: 'to watch', color: tone('warn') },
    { value: String(high), label: 'high-priority actions', color: hex(REPORT_PRIORITY_COLOR.high) },
  ])

  L.section('What was measured')
  facts(L, [
    { label: 'Application', value: r.app },
    { label: 'Graded on', value: r.gradedOn ?? 'not recorded' },
    { label: 'Load-tested in', value: r.testedIn ?? 'not load-tested yet', sub: r.pending && !r.testedAt ? `Pending: ${r.pending}` : undefined },
    { label: 'Tested at', value: utc(r.testedAt) },
    { label: 'Image', value: r.image ?? 'not recorded', mono: !!r.image },
    ...(r.target ? [{ label: 'Load target', value: r.target, mono: true }] : []),
  ])

  L.section('Key measurements')
  L.ensure(KEEP_WITH_TABLE)
  L.h3(`Automated load test: ${r.loadStatus}`)
  L.para(`k6 against ${r.target ?? 'the application Service'}${r.testedIn ? ` in ${r.testedIn}` : ''}, run hourly by the platform's resilience runner.`, { size: 8.5 })
  gaugeTable(L, r.load)
  if (r.slo.length) {
    L.ensure(KEEP_WITH_TABLE)
    L.h3('Live service levels')
    L.para(`From Prometheus request metrics over the last 24 hours${r.sloEnvironment ? ` in ${r.sloEnvironment}` : ''}.`, { size: 8.5 })
    gaugeTable(L, r.slo)
  }
  if (r.chaos.length) {
    L.ensure(KEEP_WITH_TABLE)
    L.h3('Chaos suite')
    L.para('Litmus experiments under a continuous steady-state probe.', { size: 8.5 })
    table(L, [{ title: 'Fault', width: 4 }, { title: 'Probe up', width: 1.4 }, { title: 'Recovery', width: 1.4 }, { title: 'Result', width: 1.6 }], r.chaos.map((c) => [
      { text: c.title, sub: c.experiment },
      { text: c.probePct !== undefined ? `${c.probePct}%` : '—', mono: true },
      { text: c.recoverySeconds !== undefined ? `${c.recoverySeconds}s` : '—', mono: true },
      { text: '', pill: { tone: c.tone, label: c.status } },
    ]))
  }

  L.section('Observations')
  for (const area of REPORT_AREAS) {
    const list = findings.filter((f) => f.area === area)
    if (!list.length) continue
    L.h3(area, findingCardHeight(L, list[0]))
    list.forEach((f) => findingCard(L, f))
  }

  L.section('Recommendations')
  if (recs.length) recommendationList(L, recs)
  else L.para('Nothing to do: every applicable check passes and every measurement is within target.')

  if (r.signals.length) {
    L.section('All readiness checks')
    checksGrid(L, r)
  }

  L.section('How this report was produced')
  L.para("Every number comes from the Adhar platform scorer, which joins the resilience runner's automated k6 load test and Litmus chaos suite (run hourly in the test environment, never production), live 24-hour service levels from Prometheus, the team's Performance Center gates and game days, and how the workload is built to survive failure. The report adds no measurements of its own; anything not yet measured is shown as missing, with how to measure it.", { size: 8.5 })

  footers(doc, `Performance Report · ${r.app} · generated ${meta.generatedAt.slice(0, 16).replace('T', ' ')} UTC${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}`)
  return doc.output()
}
