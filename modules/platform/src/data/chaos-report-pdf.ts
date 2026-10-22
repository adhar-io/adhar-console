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

import { REPORT_GRADE_COLOR, REPORT_PRIORITY_COLOR, REPORT_TONE_COLOR, REPORT_TONE_LABEL, type ReportTone as Tone, scoreTone } from '@adhar/utils'
import {
  chaosFindings,
  type ChaosRunReport,
  compareRuns,
  designLabel,
  type ExperimentRecord,
  experimentTone,
  faultTitle,
  type Finding,
  headline,
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
import { fitText, type FontName, hex, PdfDocument, type Rgb, textWidth, wrapMono, wrapText } from './pdf-writer.ts'

const INK = hex('#0f172a')
const MUTED = hex('#475569')
const SUBTLE = hex('#94a3b8')
const LINE = hex('#e2e8f0')
const SOFT = hex('#f8fafc')
const BRAND = hex('#4f46e5')
const COVER = hex('#312e81')
const COVER_2 = hex('#4338ca')
const WHITE: Rgb = [1, 1, 1]
const REC_BG = hex('#eef2ff')
const REC_INK = hex('#312e81')
const CODE_BG = hex('#0f172a')
const CODE_INK = hex('#e2e8f0')

const tone = (t: Tone): Rgb => hex(REPORT_TONE_COLOR[t])
/** A tone at 7% over white — the pills' and callouts' background. */
const tint = (c: Rgb, a = 0.08): Rgb => c.map((x) => 1 - a + a * x) as Rgb

const M = 40 // page margin
const FOOT = 34 // footer band

const fmtPct = (n: number | undefined) => (n === undefined ? '—' : `${Number(n.toFixed(1))}%`)
const utc = (iso?: string) => (iso ? `${iso.slice(0, 19).replace('T', ' ')} UTC` : 'not recorded')

class Layout {
  readonly doc: PdfDocument
  y = M
  readonly W: number

  constructor(doc: PdfDocument) {
    this.doc = doc
    this.W = doc.width - 2 * M
  }

  get bottom(): number {
    return this.doc.height - M - FOOT
  }

  newPage(): void {
    this.doc.addPage()
    this.y = M
  }

  /** Room for `h` more points on this page, or a new page. */
  ensure(h: number): void {
    if (this.y + h > this.bottom) this.newPage()
  }

  text(s: string, x: number, top: number, font: FontName, size: number, color: Rgb): void {
    this.doc.text(s, x, top, { font, size, color })
  }

  /** Wrapped lines at the cursor; returns nothing, advances y. */
  para(s: string, opt: { size?: number; color?: Rgb; font?: FontName; x?: number; width?: number; gap?: number } = {}): void {
    const size = opt.size ?? 9.5
    const lh = size * 1.45
    const x = opt.x ?? M
    for (const line of wrapText(s, opt.font ?? 'regular', size, opt.width ?? this.W)) {
      this.ensure(lh)
      this.text(line, x, this.y + size, opt.font ?? 'regular', size, opt.color ?? MUTED)
      this.y += lh
    }
    this.y += opt.gap ?? 4
  }

  /** A section heading, kept with at least the start of what follows. */
  section(title: string): void {
    this.ensure(110)
    this.y += 16
    const label = title.toUpperCase()
    this.text(label, M, this.y + 8, 'bold', 8, BRAND)
    const w = textWidth(label, 'bold', 8)
    this.doc.line(M + w + 8, this.y + 5, M + this.W, this.y + 5, LINE)
    this.y += 20
  }

  h3(title: string): void {
    this.ensure(90)
    this.y += 6
    this.text(title, M, this.y + 10, 'bold', 10.5, INK)
    this.y += 17
  }

  /** A pill whose text baseline is at `top`; returns its width. */
  pill(x: number, top: number, t: Tone, label = REPORT_TONE_LABEL[t]): number {
    const size = 7
    const w = textWidth(label, 'bold', size) + 10
    this.doc.rect(x, top - 7.5, w, 11, { fill: tint(tone(t)), stroke: tint(tone(t), 0.35), lineWidth: 0.6, radius: 5.5 })
    this.text(label, x + 5, top, 'bold', size, tone(t))
    return w
  }

  pillWidth(label: string): number {
    return textWidth(label, 'bold', 7) + 10
  }
}

/* ─────────────────────────── blocks ─────────────────────────── */

function cover(L: Layout, r: ChaosRunReport, meta: ReportMeta): void {
  const { doc } = L
  const H = 206
  // The HTML cover's diagonal gradient, approximated with vertical strips.
  const strips = 48
  for (let i = 0; i < strips; i++) {
    const t = i / (strips - 1)
    const c = COVER.map((v, k) => v + (COVER_2[k] - v) * t) as Rgb
    doc.rect((doc.width / strips) * i, 0, doc.width / strips + 0.6, H, { fill: c })
  }
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

function kpis(L: Layout, items: Array<{ value: string; label: string; color: Rgb }>): void {
  const gap = 8
  const w = (L.W - gap * (items.length - 1)) / items.length
  L.ensure(50)
  items.forEach((k, i) => {
    const x = M + i * (w + gap)
    L.doc.rect(x, L.y, w, 44, { fill: SOFT, stroke: LINE, lineWidth: 0.6, radius: 7 })
    L.text(k.value, x + 10, L.y + 20, 'bold', 15, k.color)
    L.text(k.label, x + 10, L.y + 34, 'regular', 7.5, MUTED)
  })
  L.y += 52
}

function facts(L: Layout, rows: Array<{ label: string; value: string; mono?: boolean; sub?: string }>): void {
  const lw = 104
  const vw = L.W - lw
  for (const row of rows) {
    const size = row.mono ? 8 : 9
    const lines = wrapText(row.value, row.mono ? 'mono' : 'regular', size, vw)
    const sub = row.sub ? wrapText(row.sub, 'regular', 7.5, vw) : []
    const h = lines.length * size * 1.4 + sub.length * 10.5 + 5
    L.ensure(h)
    L.text(row.label, M, L.y + 9, 'regular', 8.5, MUTED)
    lines.forEach((ln, i) => L.text(ln, M + lw, L.y + 9 + i * size * 1.4, row.mono ? 'mono' : 'regular', size, INK))
    sub.forEach((ln, i) => L.text(ln, M + lw, L.y + 9 + lines.length * size * 1.4 + i * 10.5, 'regular', 7.5, SUBTLE))
    L.y += h
  }
}

interface Cell {
  text: string
  sub?: string
  mono?: boolean
  pill?: { tone: Tone; label: string }
}

function table(L: Layout, cols: Array<{ title: string; width: number }>, rows: Cell[][]): void {
  const total = cols.reduce((a, c) => a + c.width, 0)
  const widths = cols.map((c) => (c.width / total) * L.W)
  const header = () => {
    L.ensure(20)
    let x = M
    cols.forEach((c, i) => {
      L.text(c.title.toUpperCase(), x + 4, L.y + 9, 'bold', 6.5, SUBTLE)
      x += widths[i]
    })
    L.doc.line(M, L.y + 14, M + L.W, L.y + 14, LINE)
    L.y += 18
  }
  header()
  for (const row of rows) {
    const laid = row.map((c, i) => ({
      c,
      lines: c.pill ? [] : wrapText(c.text, c.mono ? 'mono' : 'regular', c.mono ? 8 : 9, widths[i] - 8),
      sub: c.sub ? wrapText(c.sub, 'regular', 7, widths[i] - 8) : [],
    }))
    const h = Math.max(...laid.map((l) => (l.c.pill ? 12 : l.lines.length * 12.5) + l.sub.length * 9.5)) + 8
    if (L.y + h > L.bottom) {
      L.newPage()
      header()
    }
    let x = M
    laid.forEach((l, i) => {
      if (l.c.pill) L.pill(x + 4, L.y + 10, l.c.pill.tone, l.c.pill.label)
      l.lines.forEach((ln, j) => L.text(ln, x + 4, L.y + 10 + j * 12.5, l.c.mono ? 'mono' : 'regular', l.c.mono ? 8 : 9, INK))
      l.sub.forEach((ln, j) => L.text(ln, x + 4, L.y + 10 + (l.c.pill ? 12 : l.lines.length * 12.5) + j * 9.5, 'regular', 7, SUBTLE))
      x += widths[i]
    })
    L.y += h
    L.doc.line(M, L.y - 3, M + L.W, L.y - 3, hex('#f1f5f9'))
  }
  L.y += 4
}

/** A paragraph with a bold lead-in ("Observation.") on its first line. */
function leadLines(lead: string, body: string, size: number, width: number): { leadW: number; lines: string[] } {
  const leadW = textWidth(`${lead} `, 'bold', size)
  return { leadW, lines: wrapText(body, 'regular', size, width, leadW) }
}

function findingCard(L: Layout, f: Finding): void {
  const pad = 11
  const inner = L.W - 2 * pad - 4
  const size = 8.5
  const lh = size * 1.45
  const pw = L.pillWidth(REPORT_TONE_LABEL[f.tone])
  const title = wrapText(f.title, 'bold', 10, inner - pw - 8)
  const obs = leadLines('Observation.', f.observation, size, inner)
  const mean = leadLines('What it means.', f.explanation, size, inner)
  const rec = f.recommendation ? leadLines('Recommendation.', f.recommendation, size, inner - 12) : undefined
  const h = pad + title.length * 13 + 4 + (obs.lines.length + mean.lines.length) * lh + 6 + (rec ? rec.lines.length * lh + 14 : 0) + pad - 4
  L.ensure(h + 8)
  const top = L.y
  L.doc.rect(M, top, L.W, h, { stroke: LINE, lineWidth: 0.7, radius: 7 })
  L.doc.rect(M, top, 3.5, h, { fill: tone(f.tone) })
  const x = M + pad + 4
  let y = top + pad + 9
  title.forEach((t, i) => L.text(t, x, y + i * 13, 'bold', 10, INK))
  L.pill(M + L.W - pad - pw, y - 1, f.tone)
  y += title.length * 13 + 4
  const drawLead = (lead: string, p: { leadW: number; lines: string[] }, color: Rgb, dx = 0) => {
    L.text(lead, x + dx, y, 'bold', size, color)
    p.lines.forEach((ln, i) => {
      L.text(ln, x + dx + (i === 0 ? p.leadW : 0), y, 'regular', size, color)
      y += lh
    })
  }
  drawLead('Observation.', obs, hex('#334155'))
  drawLead('What it means.', mean, hex('#334155'))
  if (rec) {
    y += 4
    L.doc.rect(x - 2, y - 10, inner + 4, rec.lines.length * lh + 8, { fill: REC_BG, radius: 5 })
    drawLead('Recommendation.', rec, REC_INK, 4)
  }
  L.y = top + h + 8
}

function recommendationList(L: Layout, recs: Finding[]): void {
  recs.forEach((f, i) => {
    const x = M + 28
    const w = L.W - 28
    const prio = (f.priority ?? 'medium').toUpperCase()
    const pw = textWidth(`${prio}  `, 'bold', 7)
    const title = wrapText(f.title, 'bold', 9.5, w - pw)
    const body = wrapText(f.recommendation ?? '', 'regular', 8.5, w)
    const code = f.snippet ? wrapMono(f.snippet, 7, w - 16) : []
    const h = title.length * 12.5 + body.length * 12 + (code.length ? code.length * 9.5 + 14 : 0) + 12
    L.ensure(h)
    const top = L.y
    L.doc.circle(M + 11, top + 10, 10, { fill: INK })
    const n = String(i + 1)
    L.text(n, M + 11 - textWidth(n, 'bold', 8.5) / 2, top + 13, 'bold', 8.5, WHITE)
    L.text(prio, x, top + 10, 'bold', 7, hex(REPORT_PRIORITY_COLOR[f.priority ?? 'medium']))
    title.forEach((t, j) => L.text(t, x + (j === 0 ? pw : 0), top + 10 + j * 12.5, 'bold', 9.5, INK))
    let y = top + 10 + title.length * 12.5
    body.forEach((t) => {
      L.text(t, x, y + 1, 'regular', 8.5, MUTED)
      y += 12
    })
    if (code.length) {
      L.doc.rect(x, y - 4, w, code.length * 9.5 + 10, { fill: CODE_BG, radius: 5 })
      code.forEach((t, j) => L.text(t, x + 8, y + 6 + j * 9.5, 'mono', 7, CODE_INK))
      y += code.length * 9.5 + 14
    }
    L.y = y + 4
    L.doc.line(M, L.y - 2, M + L.W, L.y - 2, hex('#f1f5f9'))
    L.y += 4
  })
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

  if (h.previous || h.previousCommit) {
    L.section('Compared with earlier runs')
    if (h.previous) compareBlock(L, r, h.previous, 'Previous run')
    if (h.previousCommit && h.previousCommit.id !== h.previous?.id) compareBlock(L, r, h.previousCommit, `Previous commit (${shortSha(h.previousCommit.commit)})`)
  }

  L.section('Observations')
  for (const area of ['Experiments', 'Recovery', 'Workload design', 'Change over time'] as const) {
    const list = findings.filter((f) => f.area === area)
    if (!list.length) continue
    L.h3(area)
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

  // Footers, now that the page count is known.
  const n = doc.pageCount
  const left = `Chaos Engineering Report · ${r.app}${r.commit ? ` @ ${shortSha(r.commit)}` : ''} · generated ${meta.generatedAt.slice(0, 16).replace('T', ' ')} UTC${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}`
  for (let i = 0; i < n; i++) {
    doc.setPage(i)
    const top = doc.height - M - 10
    doc.line(M, top - 10, doc.width - M, top - 10, LINE)
    doc.text(wrapText(left, 'regular', 7, L.W - 60)[0], M, top, { size: 7, color: SUBTLE })
    const pg = `Page ${i + 1} of ${n}`
    doc.text(pg, doc.width - M - textWidth(pg, 'regular', 7), top, { size: 7, color: SUBTLE })
  }
  return doc.output()
}
