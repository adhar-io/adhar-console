/**
 * The Chaos Engineering run report as a PDF — the same sections, wording and
 * colours as the HTML report (chaos-report.ts), laid out for A4 with the
 * dependency-free writer in pdf-writer.ts. Text stays text: selectable,
 * searchable, and small enough to attach anywhere.
 *
 * Loaded on demand (the view imports it dynamically), so the writer and this
 * layout are their own chunk and cost nothing until someone downloads a PDF.
 *
 * Pure: returns bytes, no DOM.
 */

import { clockUtc, METRIC_DEFS, yMaxFor, type MetricPoint, PHASE_COLOR, REPORT_GRADE_COLOR, REPORT_PRIORITY_COLOR, type ReportTone as Tone, scoreTone } from '@adhar/utils'
import {
  chaosFindings,
  type ChaosRunReport,
  compareRuns,
  designLabel,
  type ExperimentRecord,
  experimentTone,
  faultTitle,
  FINDING_AREAS,
  headline,
  metricCaption,
  reportBands,
  reportMetrics,
  type ReportMetric,
  runDomain,
  timelineRows,
  type History,
  recommendations,
  type ReportMeta,
  resilienceScore,
  runGrade,
  runVerdict,
  shortSha,
  SLOW_RECOVERY_SECONDS,
  statusText,
  TRIGGER_LABEL,
  VERDICT_LABEL,
  VERDICT_TONE,
} from './chaos-report.ts'
import {
  coverBand, facts, findingCard, findingCardHeight, fitText, footers, hex, INK, kpis, Layout, legend, LINE, lineCharts, M, MUTED, type PdfChart,
  PdfDocument, type Rgb, recommendationList, table, textWidth, timelineChart, tone, utc, WHITE, wrapText, fmtPct,
} from '@adhar/utils/pdf'

/* ─────────────────────────── blocks ─────────────────────────── */

function cover(L: Layout, r: ChaosRunReport, meta: ReportMeta): void {
  const { doc } = L
  const H = 218
  coverBand(doc, H)
  const x = M
  L.text('ADHAR  ·  CHAOS ENGINEERING REPORT', x, 50, 'bold', 7.5, [0.78, 0.8, 0.95])
  L.text(r.app, x, 78, 'bold', 24, WHITE)
  const soft: Rgb = [0.86, 0.87, 0.97]
  L.text(`${r.environment}  ·  namespace ${r.namespace}${r.project ? `  ·  project ${r.project}` : ''}  ·  ${utc(r.finishedAt)}`, x, 96, 'regular', 8.5, soft)
  // Commit: the short SHA as a badge, the full SHA beside it.
  L.text('Commit', x, 112, 'regular', 8.5, soft)
  if (r.commit) {
    const bx = x + 38
    const bw = textWidth(shortSha(r.commit), 'bold', 9) + 10
    doc.rect(bx, 103, bw, 13, { fill: [0.36, 0.34, 0.75], radius: 3 })
    L.text(shortSha(r.commit), bx + 5, 112.5, 'bold', 9, WHITE)
    L.text(r.commit, bx + bw + 6, 112, 'mono', 7.5, soft)
    if (meta.commitHref) doc.link(bx, 103, bw + 6 + textWidth(r.commit, 'mono', 7.5), 13, meta.commitHref)
  } else {
    L.text('unknown', x + 38, 112, 'mono', 8.5, soft)
  }
  if (r.image) {
    L.text('Image', x, 126, 'regular', 8.5, soft)
    L.text(fitText(r.image, 'mono', 7, doc.width - 2 * M - 38), x + 38, 126, 'mono', 7, soft)
  }
  L.text(`Triggered by ${TRIGGER_LABEL[r.trigger]}${r.triggeredByUser ? ` — ${r.triggeredByUser}` : ''}`, x, 140, 'regular', 8.5, soft)

  // Hero: grade, score and verdict on the left; rings on a white card at the right.
  const grade = runGrade(r)
  const score = resilienceScore(r)
  const verdict = runVerdict(r)
  doc.circle(x + 24, 176, 24, { fill: hex(REPORT_GRADE_COLOR[grade] ?? '#64748b') })
  doc.circle(x + 24, 176, 27, { stroke: [0.55, 0.53, 0.85], lineWidth: 2.5 })
  L.text(grade, x + 24 - textWidth(grade, 'bold', 22) / 2, 184, 'bold', 22, WHITE)
  L.text(score === null ? '—' : `${score}/100`, x + 62, 173, 'bold', 17, WHITE)
  L.text('resilience under injected faults', x + 62, 186, 'regular', 8, soft)
  const vLabel = VERDICT_LABEL[verdict]
  const vw = textWidth(vLabel, 'bold', 8) + 14
  doc.rect(x + 62, 191, vw, 12, { fill: WHITE, radius: 6 })
  L.text(vLabel, x + 69, 200, 'bold', 8, tone(VERDICT_TONE[verdict]))

  const probes = r.experiments.map((e) => e.probeSuccessPercentage).filter((n): n is number => n !== undefined)
  const rings: Array<[string, number | null]> = [['Resilience', score], ['Worst probe', probes.length ? Math.round(Math.min(...probes)) : null]]
  const cw = 196
  const cx0 = doc.width - M - cw
  doc.rect(cx0, 148, cw, 52, { fill: WHITE, radius: 9 })
  rings.forEach(([label, v], i) => {
    const cx = cx0 + 24 + i * 96
    const cy = 168
    doc.circle(cx, cy, 13, { stroke: LINE, lineWidth: 4 })
    doc.arc(cx, cy, 13, (v ?? 0) / 100, tone(scoreTone(v)), 4)
    const t = v === null ? 'n/a' : String(v)
    L.text(t, cx - textWidth(t, 'bold', 8) / 2, cy + 3, 'bold', 8, INK)
    L.text(label, cx + 18, cy + 3, 'regular', 7, MUTED)
  })
  L.y = H + 10
}

function checksGrid(L: Layout, r: ChaosRunReport): void {
  const colW = (L.W - 20) / 2
  const items = r.checks ?? []
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2).map((c) => ({
      c,
      detail: wrapText(`${!c.applicable ? 'Not applicable — ' : ''}${c.detail ?? (c.score >= 1 ? 'Pass' : 'Not met')}`, 'regular', 7.5, colW - 14),
    }))
    const h = Math.max(...pair.map((p) => 12 + p.detail.length * 10)) + 6
    L.ensure(h)
    pair.forEach((p, j) => {
      const x = M + j * (colW + 20)
      const color = !p.c.applicable ? hex('#cbd5e1') : p.c.score >= 1 ? tone('good') : p.c.score > 0 ? tone('warn') : tone('bad')
      L.doc.circle(x + 4, L.y + 6, 3.5, { fill: color })
      L.text(designLabel(p.c.name), x + 13, L.y + 9, 'regular', 9, INK)
      p.detail.forEach((d, k) => L.text(d, x + 13, L.y + 20 + k * 10, 'regular', 7.5, MUTED))
    })
    L.y += h
  }
}

function compareBlock(L: Layout, cur: ChaosRunReport, other: ChaosRunReport, caption: string): void {
  const { rows } = compareRuns(cur, other)
  const cell = (e?: ExperimentRecord) =>
    e ? `${statusText(e.status)}${e.probeSuccessPercentage !== undefined ? ` · ${fmtPct(e.probeSuccessPercentage)}` : ''}${e.recoverySeconds !== undefined ? ` · ${e.recoverySeconds}s` : ''}` : '—'
  const CH: Record<string, [Tone, string]> = { better: ['good', 'Better'], worse: ['bad', 'Worse'], same: ['none', 'Same'], new: ['none', 'New fault'], gone: ['none', 'Not run now'] }
  L.h3(caption)
  L.para(`${utc(other.finishedAt)}${other.commit ? ` · commit ${shortSha(other.commit)}` : ' · commit unknown'}${other.environment !== cur.environment ? ` · ${other.environment}` : ''}`, { size: 8 })
  table(L, [{ title: 'Fault', width: 3 }, { title: 'Then', width: 2.4 }, { title: 'Now', width: 2.4 }, { title: 'Change', width: 1.4 }], rows.map((x) => [
    { text: faultTitle(x.name), sub: x.name },
    { text: cell(x.before) },
    { text: cell(x.after) },
    { text: '', pill: { tone: CH[x.change][0], label: CH[x.change][1] } },
  ]))
}

/** The run timeline and the target's metrics — what the HTML report draws as SVG. */
function metricsBlock(L: Layout, r: ChaosRunReport): void {
  const domain = runDomain(r)
  const phases = r.phases ?? []
  if (!domain) {
    L.section('Target metrics during the run')
    L.para(r.metricsNote ?? 'This run was recorded without target metrics or a phase timeline — it predates their capture, or the runner\'s log and Prometheus were not reachable when it was recorded.', { size: 8.5 })
    return
  }
  L.section('Run timeline')
  if (phases.length) {
    L.para('When each phase ran, from the resilience runner\'s own log. A fault\'s bar is the injection; the lighter bar after it is the recovery.', { size: 8.5 })
    const rows = timelineRows(phases)
    const barColor = (k: string) => (k === 'recovery' ? hex('#f5c27a') : hex(PHASE_COLOR[k as keyof typeof PHASE_COLOR] ?? '#94a3b8'))
    timelineChart(L, rows.map((row) => ({
      label: row.label,
      start: row.parts[0].start,
      end: row.parts[0].end ?? domain[1],
      color: barColor(row.parts[0].kind),
      more: row.parts.slice(1).map((p) => ({ start: p.start, end: p.end ?? domain[1], color: barColor(p.kind) })),
      ...(row.note ? { note: row.note } : {}),
    })), { domain, formatX: clockUtc })
  } else {
    L.para('The runner\'s log was not available when this run was recorded, so the phase windows are not known.', { size: 8.5 })
  }

  L.section('Target metrics during the run')
  L.para(r.metrics
    ? `The target's own series from Prometheus over the run window (${clockUtc(domain[0])}–${clockUtc(domain[1])} UTC, one sample every ${r.metrics.window.stepSeconds}s), selected by ${r.metrics.selector ?? 'the application pods'}. Shaded bands are the phases above.`
    : r.metricsNote ?? 'Prometheus series were not captured for this run; the probe chart is drawn from the faults\' recorded results.', { size: 8.5 })
  const bands = reportBands(r, domain)
  const kinds = [...new Set(bands.map((b) => b.kind))]
  if (kinds.length) legend(L, kinds.map((k) => ({ label: k === 'fault' ? 'Fault injected' : k === 'recovery' ? 'Recovering' : 'Load test', color: hex(PHASE_COLOR[k]) })))
  const list: ReportMetric[] = reportMetrics(r)
  if (!list.some((m) => m.def.id === 'probe') && phases.some((p) => p.probeSuccessPercentage !== undefined)) {
    const def = METRIC_DEFS.find((d) => d.id === 'probe')!
    const pts = phases.filter((p) => p.kind === 'fault' && p.probeSuccessPercentage !== undefined && p.end !== undefined)
      .flatMap((p) => [[p.start, p.probeSuccessPercentage!], [p.end!, p.probeSuccessPercentage!]] as MetricPoint[])
    list.unshift({ def, series: { id: 'probe', label: def.label, unit: def.unit, points: pts } })
  }
  const charts: PdfChart[] = list.map((m) => ({
    title: m.def.label,
    caption: metricCaption(m, phases),
    series: m.series ? [{ points: m.series.points, color: hex(m.def.color), pairs: m.def.id === 'probe' }] : [],
    bands: bands.map((b) => ({ start: b.start, end: b.end, color: hex(PHASE_COLOR[b.kind]) })),
    domain,
    ...(m.series ? { yMax: yMaxFor(m.def.id, m.def.unit, m.series.points) } : {}),
    formatY: (v: number) => formatMetricShort(v, m.def.unit),
    formatX: clockUtc,
    emptyText: m.missing?.reason ?? 'No samples in the run window.',
  }))
  if (charts.length) lineCharts(L, charts, { cols: 2, height: 118 })
}

/** Axis labels: the metric's unit, kept short enough for a 30 pt gutter. */
function formatMetricShort(v: number, unit: ReportMetric['def']['unit']): string {
  if (unit === 'bytes') return v >= 1024 ** 3 ? `${Number((v / 1024 ** 3).toFixed(1))}G` : `${Math.round(v / 1024 ** 2)}M`
  if (unit === 'ms') return v >= 1000 ? `${Number((v / 1000).toFixed(1))}s` : `${Math.round(v)}`
  if (unit === 'percent') return `${Number(v.toFixed(v < 10 && v % 1 ? 1 : 0))}%`
  if (unit === 'cores') return v >= 1 ? `${Number(v.toFixed(1))}` : `${Math.round(v * 1000)}m`
  return `${Number(v.toFixed(v < 10 && v % 1 ? 1 : 0))}`
}

/* ─────────────────────────── document ─────────────────────────── */

/** The report as PDF bytes. */
export function chaosReportPdf(r: ChaosRunReport, h: History, meta: ReportMeta): Uint8Array {
  const doc = new PdfDocument({
    title: `Chaos Engineering Report — ${r.app}${r.commit ? ` @ ${shortSha(r.commit)}` : ''}`,
    subject: `${r.app} in ${r.environment}, ${r.finishedAt}`,
    author: meta.generatedBy ?? 'Adhar Console',
  })
  doc.addPage()
  const L = new Layout(doc)
  const findings = chaosFindings(r, h)
  const recs = recommendations(findings)
  const judged = r.experiments.filter((e) => e.status === 'passed' || e.status === 'failed')
  const survived = judged.filter((e) => e.status === 'passed').length
  const recoveries = r.experiments.map((e) => e.recoverySeconds).filter((n): n is number => n !== undefined)
  const worst = recoveries.length ? Math.max(...recoveries) : undefined

  cover(L, r, meta)

  L.section('Executive summary')
  L.para(headline(r), { size: 11.5, color: INK, gap: 6 })
  if (r.gate) L.para(`Promotion gate in ${r.namespace}: ${r.gate.verdict}${r.gate.reasons.length ? ` — ${r.gate.reasons.join('; ')}` : ''}.`, { size: 8.5 })
  kpis(L, [
    { value: `${survived}/${judged.length}`, label: 'faults survived', color: tone('good') },
    { value: String(judged.length - survived), label: 'faults failed', color: tone('bad') },
    { value: worst !== undefined ? `${worst}s` : '—', label: 'slowest recovery', color: worst !== undefined && worst > SLOW_RECOVERY_SECONDS ? tone('warn') : INK },
    { value: String(recs.filter((f) => f.priority === 'high').length), label: 'high-priority actions', color: hex(REPORT_PRIORITY_COLOR.high) },
  ])

  L.section('What was tested')
  facts(L, [
    { label: 'Application', value: r.app },
    { label: 'Environment', value: `${r.environment} (namespace ${r.namespace})` },
    r.commit
      ? { label: 'Commit', value: r.commit, mono: true, sub: r.commitSource === 'kargo-freight' ? `Resolved from the image digest through Kargo freight ${r.freight?.alias ?? r.freight?.name ?? ''}` : 'From the image tag (CI tags every image with its commit SHA)' }
      : { label: 'Commit', value: 'Unknown', sub: r.commitNote ?? 'The commit could not be resolved.' },
    { label: 'Image', value: r.image ?? 'not recorded', mono: !!r.image },
    ...(r.freight ? [{ label: 'Kargo freight', value: `${r.freight.alias ?? r.freight.name}${r.freight.project ? ` (project ${r.freight.project})` : ''}` }] : []),
    { label: 'Triggered by', value: `${TRIGGER_LABEL[r.trigger]}${r.triggeredByUser ? ` — ${r.triggeredByUser}` : ''}` },
    { label: 'Run', value: r.runId ?? 'not recorded', mono: !!r.runId },
    { label: 'Started', value: utc(r.startedAt) },
    { label: 'Finished', value: utc(r.finishedAt) },
    ...(r.target ? [{ label: 'Probe target', value: r.target, mono: true }] : []),
  ])

  L.section('Experiments')
  L.para('Litmus faults, injected in order while a steady-state HTTP probe polled the service continuously. Recovery is the time until the workload was back at its desired ready replica count.', { size: 8.5 })
  if (r.experiments.length) {
    table(L, [{ title: 'Fault', width: 5 }, { title: 'Probe up', width: 1.4 }, { title: 'Recovery', width: 1.4 }, { title: 'Result', width: 1.7 }], r.experiments.map((e) => [
      { text: faultTitle(e.name), sub: `${e.name}${e.hypothesis ? ` — ${e.hypothesis}` : ''}` },
      { text: fmtPct(e.probeSuccessPercentage), mono: true },
      { text: e.recoverySeconds !== undefined ? `${e.recoverySeconds}s` : '—', mono: true },
      { text: '', pill: { tone: experimentTone(e), label: statusText(e.status) } },
    ]))
  } else {
    L.para('No experiment was recorded for this run.')
  }
  if (r.performance) {
    const p = r.performance
    L.h3(`Load test in the same run: ${p.status}`)
    table(L, [{ title: 'p95 latency', width: 1 }, { title: 'Error rate', width: 1 }, { title: 'Throughput', width: 1 }, { title: 'Threshold', width: 1 }], [[
      { text: p.p95Ms !== undefined ? `${Number(p.p95Ms.toFixed(1))} ms` : '—', mono: true },
      { text: p.errorRate !== undefined ? fmtPct(p.errorRate * 100) : '—', mono: true },
      { text: p.rps !== undefined ? `${Number(p.rps.toFixed(1))} req/s` : '—', mono: true },
      { text: p.thresholdP95Ms !== undefined ? `p95 < ${p.thresholdP95Ms} ms` : '—', mono: true },
    ]])
    if (p.detail) L.para(p.detail, { size: 8 })
  }

  metricsBlock(L, r)

  if (h.previous || h.previousCommit) {
    L.section('Compared with earlier runs')
    if (h.previous) compareBlock(L, r, h.previous, 'Previous run')
    if (h.previousCommit && h.previousCommit.id !== h.previous?.id) compareBlock(L, r, h.previousCommit, `Previous commit (${shortSha(h.previousCommit.commit)})`)
  }

  L.section('Observations')
  for (const area of FINDING_AREAS) {
    const list = findings.filter((f) => f.area === area)
    if (!list.length) continue
    L.h3(area, findingCardHeight(L, list[0]))
    list.forEach((f) => findingCard(L, f))
  }

  L.section('Recommendations')
  if (recs.length) recommendationList(L, recs)
  else L.para('Nothing to do: every injected fault was survived and every workload-design check recorded for the application passes.')

  if (r.checks?.length) {
    L.section('Workload design checks')
    L.para(`How the workload is built to survive failure, from the platform scorer${r.checksEnvironment ? ` (graded on ${r.checksEnvironment})` : ''} at the time of the run.`, { size: 8.5 })
    checksGrid(L, r)
  }

  L.section('How this report was produced')
  L.para(`The platform's resilience runner injected each fault of the application's own resilience suite with LitmusChaos in ${r.environment} (never production), under a continuous steady-state HTTP probe, and measured recovery as the time until the workload was back at its desired ready replicas. The Adhar Console recorded the run as it landed. The commit is the one the tested image was built from — read from the image's commit-SHA tag, or for an image pinned by digest from the Kargo freight that carries that digest — and is shown as unknown rather than guessed when neither names it. The resilience score is the mean probe success over faults with a verdict (A >= 90, B >= 80, C >= 70, D >= 60); a run with a failed fault grades C at best. Recovery over ${SLOW_RECOVERY_SECONDS}s is reported as slow. Anything the runner did not measure is shown as missing.`, { size: 8.5 })

  footers(doc, `Chaos Engineering Report · ${r.app}${r.commit ? ` @ ${shortSha(r.commit)}` : ''} · generated ${meta.generatedAt.slice(0, 16).replace('T', ' ')} UTC${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}`)
  return doc.output()
}
