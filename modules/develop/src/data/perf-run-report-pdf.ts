/**
 * The run report as a PDF — the same model, sections and numbers as the HTML
 * report (perf-run-report.ts), laid out for A4 with the shared report kit
 * (`@adhar/utils/pdf`), the way the chaos run report is. Charts are vector:
 * drawn with the kit's line charts on the run's own time axis.
 *
 * Loaded on demand (dynamic import), so the writer costs nothing until
 * someone downloads a PDF.
 *
 * Pure: returns bytes, no DOM.
 */

import { clockUtc, formatMetric, PHASE_COLOR, REPORT_TONE_COLOR } from '@adhar/utils'
import {
  type Cell, coverBand, facts, fitText, footers, hex, INK, Layout, legend, LINE, lineCharts, M, MUTED, type PdfChart, PdfDocument, type Rgb, SOFT, SUBTLE,
  table, textWidth, timelineChart, tone, utc, WHITE, wrapText,
} from '@adhar/utils/pdf'
import { fmtSecs } from './perf-run-model.ts'
import { chartCaption, fmtUtc, type RunReport } from './perf-run-report.ts'

const KEEP_WITH_TABLE = 110

/** A section heading kept on the same page as the start of what follows it. */
function section(L: Layout, title: string, keep = KEEP_WITH_TABLE): void {
  L.ensure(keep + 36)
  L.section(title)
}

const PHASE_STATE_COLOR: Record<string, string> = { done: '#6366f1', failed: '#e11d48', active: '#0284c7', skipped: '#cbd5e1', pending: '#cbd5e1' }

function cover(L: Layout, r: RunReport): void {
  const { doc } = L
  const soft: Rgb = [0.86, 0.87, 0.97]
  const headline = wrapText(r.verdict.headline, 'regular', 9.5, doc.width - 2 * M - 10).slice(0, 3)
  const H = 150 + headline.length * 13
  coverBand(doc, H)
  L.text('ADHAR  ·  PERFORMANCE RUN REPORT', M, 46, 'bold', 7.5, [0.78, 0.8, 0.95])
  L.text(fitText(r.title, 'bold', 22, doc.width - 2 * M), M, 74, 'bold', 22, WHITE)
  const meta = [
    `${r.namespace}/${r.run}`,
    r.application ? `application ${r.application}` : undefined,
    r.trigger ? `${r.trigger === 'ci' ? 'CI' : r.trigger}${r.schedule ? ` (${r.schedule})` : ''}` : undefined,
  ].filter(Boolean).join('  ·  ')
  L.text(fitText(meta, 'regular', 8.5, doc.width - 2 * M), M, 92, 'regular', 8.5, soft)
  const when = [r.startedAt ? utc(r.startedAt) : undefined, r.durationSecs !== undefined ? fmtSecs(r.durationSecs) : undefined, r.commit ? `commit ${r.commit.slice(0, 12)}` : undefined].filter(Boolean).join('  ·  ')
  if (when) L.text(fitText(when, 'regular', 8.5, doc.width - 2 * M), M, 106, 'regular', 8.5, soft)
  // The verdict, as a filled badge.
  const label = r.verdict.label
  const bw = textWidth(label, 'bold', 11) + 22
  doc.rect(M, 118, bw, 20, { fill: hex(REPORT_TONE_COLOR[r.verdict.tone]), radius: 10 })
  L.text(label, M + 11, 132, 'bold', 11, WHITE)
  headline.forEach((ln, i) => L.text(ln, M, 156 + i * 13, 'regular', 9.5, WHITE))
  L.y = H + 6
}

/** Eight KPI tiles, four per row, each with its note. */
function kpiGrid(L: Layout, r: RunReport): void {
  const per = 4
  const gap = 8
  const w = (L.W - gap * (per - 1)) / per
  for (let i = 0; i < r.kpis.length; i += per) {
    L.ensure(54)
    r.kpis.slice(i, i + per).forEach((k, j) => {
      const x = M + j * (w + gap)
      L.doc.rect(x, L.y, w, 48, { fill: SOFT, stroke: LINE, lineWidth: 0.6, radius: 7 })
      L.text(fitText(k.label.toUpperCase(), 'bold', 6.5, w - 16), x + 9, L.y + 12, 'bold', 6.5, SUBTLE)
      const color = k.tone && k.tone !== 'none' ? tone(k.tone) : k.value === 'not recorded' ? SUBTLE : INK
      L.text(fitText(k.value, 'bold', k.value.length > 10 ? 11 : 14, w - 16), x + 9, L.y + 30, 'bold', k.value.length > 10 ? 11 : 14, color)
      if (k.note) L.text(fitText(k.note, 'regular', 6.5, w - 16), x + 9, L.y + 41, 'regular', 6.5, MUTED)
    })
    L.y += 56
  }
}

function charts(L: Layout, r: RunReport): void {
  const c = r.charts
  if (!c) return
  const band = c.load ? [{ start: c.load.start, end: c.load.end, color: hex(PHASE_COLOR.load), label: 'load' }] : []
  const list: PdfChart[] = c.charts.map((ch) => ({
    title: ch.title,
    caption: [ch.source, chartCaption(ch)].filter(Boolean).join(' · '),
    series: ch.series.map((s) => ({ points: s.points, color: hex(s.color), label: s.label, dashed: s.dashed })),
    bands: band,
    domain: c.domain,
    yMax: ch.yMax,
    formatY: (v) => formatMetric(v, ch.unit),
    formatX: clockUtc,
  }))
  if (list.length) lineCharts(L, list, { cols: 2, height: 118 })
  const multi = c.charts.filter((ch) => ch.series.length > 1)
  if (multi.length) {
    const seen = new Map<string, Rgb>()
    for (const ch of multi) for (const s of ch.series) if (!seen.has(s.label)) seen.set(s.label, hex(s.color))
    legend(L, [...seen].map(([label, color]) => ({ label, color })))
  }
  if (c.load) L.para('The shaded band is the load window. Times are UTC.', { size: 7.5, color: SUBTLE })
  if (c.missing.length) L.para(`Not charted: ${c.missing.map((x) => `${x.label} — ${x.reason}`).join('; ')}.`, { size: 7.5 })
}

/** The report as PDF bytes. */
export function runReportPdf(r: RunReport): Uint8Array {
  const doc = new PdfDocument({
    title: `Performance run report — ${r.title}`,
    subject: `k6 run ${r.namespace}/${r.run}`,
    author: r.generatedBy ?? 'Adhar Console',
  })
  doc.addPage()
  const L = new Layout(doc)
  cover(L, r)

  L.section('Summary')
  if (r.kpis.length) kpiGrid(L, r)
  else L.para('No end-of-test summary was kept for this run, so there are no measurements.')
  for (const reason of r.verdict.reasons) L.para(`•  ${reason}`, { size: 8.5, color: INK, gap: 1 })
  if (r.verdict.note) L.para(r.verdict.note, { size: 8 })

  if (r.latency.length) {
    section(L, 'Latency percentiles')
    table(L, r.latency.map((l) => ({ title: l.label, width: 1 })), [r.latency.map((l): Cell => ({ text: l.text, mono: l.value !== undefined }))])
    const missing = r.latency.filter((l) => l.note)
    L.para(`http_req_duration over the whole run, from k6's end-of-test summary.${missing.length ? ` ${missing.map((l) => `${l.label}: ${l.note}`).join(' ')}` : ''}`, { size: 7.5 })
  }

  section(L, 'Gate and thresholds')
  if (r.gate.length) {
    table(L, [{ title: 'Check', width: 3 }, { title: 'Measured', width: 4 }, { title: 'Result', width: 1.1 }], r.gate.map((g) => [
      { text: g.label },
      { text: g.detail },
      { text: '', pill: { tone: g.passed ? 'good' : 'bad', label: g.passed ? 'Pass' : 'Fail' } },
    ]))
  } else {
    L.para('No gate was evaluated for this run.', { size: 8.5 })
  }
  if (r.thresholds.length) {
    L.ensure(KEEP_WITH_TABLE)
    L.h3('Script thresholds')
    table(L, [{ title: 'Metric', width: 2.4 }, { title: 'Rule', width: 2 }, { title: 'Measured', width: 2 }, { title: 'Result', width: 1.3 }], r.thresholds.map((t) => [
      { text: t.metric, mono: true },
      { text: t.expression, mono: true },
      { text: t.actual ?? '—', mono: true },
      { text: '', pill: { tone: t.state === 'pass' ? 'good' : t.state === 'fail' ? 'bad' : 'none', label: t.state === 'pass' ? 'Pass' : t.state === 'fail' ? 'Fail' : 'Pending' } },
    ]))
  } else {
    L.para('The script declares no thresholds.', { size: 8.5 })
  }

  if (r.comparisons.length) {
    section(L, 'Comparison', 150)
    for (const c of r.comparisons) {
      L.ensure(KEEP_WITH_TABLE)
      L.h3(`${c.title}: ${c.against}`)
      if (c.when) L.para(c.when, { size: 7.5 })
      table(L, [{ title: 'Metric', width: 2.4 }, { title: 'Then', width: 1.4 }, { title: 'Now', width: 1.4 }, { title: 'Change', width: 1.2 }, { title: 'Status', width: 1.8 }], c.rows.map((x) => [
        { text: x.label },
        { text: x.before, mono: true },
        { text: x.now, mono: true },
        { text: x.change ?? '—', mono: true },
        x.status === 'n/a'
          ? { text: 'not comparable', sub: undefined }
          : { text: '', pill: { tone: x.status === 'regressed' ? 'bad' : x.status === 'improved' ? 'good' : 'none', label: x.status === 'within' ? 'Within tolerance' : x.status === 'regressed' ? 'Regressed' : 'Improved' } },
      ]))
    }
  }

  if (r.charts) {
    section(L, 'During the run', 150)
    charts(L, r)
  }

  if (r.timeline.length) {
    section(L, 'Timeline')
    const items = r.timeline.filter((p) => p.startMs !== undefined).map((p) => ({
      label: p.label,
      start: p.startMs!,
      end: p.endMs ?? p.startMs!,
      color: hex(PHASE_STATE_COLOR[p.state] ?? '#6366f1'),
      note: p.endMs !== undefined ? fmtSecs((p.endMs - p.startMs!) / 1000) : undefined,
    }))
    if (items.length) timelineChart(L, items, { formatX: (t) => new Date(t).toISOString().slice(11, 19) })
    const detailed = r.timeline.filter((p) => p.detail)
    for (const p of detailed) L.para(`${p.label}: ${p.detail}`, { size: 7.5, gap: 1 })
  }

  section(L, 'Environment and test configuration')
  facts(L, r.config.map((c) => ({ label: c.label, value: c.value, mono: c.mono })))
  if (r.environment.length) {
    L.ensure(KEEP_WITH_TABLE)
    L.h3('Runner environment')
    facts(L, r.environment.map((v) => ({ label: v.name, value: v.value || '""', mono: true })))
  }

  if (r.logs.length) {
    section(L, r.logs[0]?.count !== undefined ? 'Most frequent warnings and errors' : 'Errors logged')
    table(L, [{ title: 'Count', width: 1 }, { title: 'Message', width: 6 }], r.logs.map((l) => [
      { text: `${l.count !== undefined ? `${l.count} x ` : ''}${l.level ?? ''}`, mono: true },
      { text: l.text, mono: true },
    ]))
  }

  if (r.metrics.length) {
    section(L, 'All k6 metrics')
    table(L, [{ title: 'Metric', width: 2.2 }, { title: 'Value', width: 6 }], r.metrics.map((x) => [{ text: x.name, mono: true }, { text: x.raw, mono: true }]))
  }

  if (r.notes.length) {
    L.section('Notes')
    for (const n of r.notes) L.para(n, { size: 8 })
  }

  footers(doc, `Performance run report · ${r.namespace}/${r.run} · generated ${fmtUtc(r.generatedAt.getTime())}${r.generatedBy ? ` by ${r.generatedBy}` : ''}`)
  if (r.link) {
    // The whole cover band links back to the run in the console.
    doc.setPage(0)
    doc.link(M, 60, doc.width - 2 * M, 20, r.link)
  }
  return doc.output()
}
