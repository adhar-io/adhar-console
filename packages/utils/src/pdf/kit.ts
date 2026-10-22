/**
 * Layout kit for the console's PDF reports (Performance, Chaos Engineering):
 * the page cursor, section headings, KPI tiles, fact rows, tables, finding
 * cards and the ranked recommendation list — the same look as the HTML
 * reports (report-html.ts), drawn with the dependency-free writer.
 *
 * Pure: returns nothing but drawing on a PdfDocument, no DOM.
 */

import { REPORT_PRIORITY_COLOR, REPORT_TONE_COLOR, REPORT_TONE_LABEL, type ReportTone as Tone } from '../report-html.ts'
import { type FontName, hex, PdfDocument, type Rgb, textWidth, wrapMono, wrapText } from './writer.ts'

/** What a finding card and a recommendation need — both reports' findings fit. */
export interface KitFinding {
  tone: Tone
  title: string
  observation: string
  explanation: string
  recommendation?: string
  snippet?: string
  priority?: 'high' | 'medium' | 'low'
}

export const INK = hex('#0f172a')
export const MUTED = hex('#475569')
export const SUBTLE = hex('#94a3b8')
export const LINE = hex('#e2e8f0')
export const SOFT = hex('#f8fafc')
export const BRAND = hex('#4f46e5')
export const COVER = hex('#312e81')
export const COVER_2 = hex('#4338ca')
export const WHITE: Rgb = [1, 1, 1]
export const REC_BG = hex('#eef2ff')
export const REC_INK = hex('#312e81')
export const CODE_BG = hex('#0f172a')
export const CODE_INK = hex('#e2e8f0')

export const tone = (t: Tone): Rgb => hex(REPORT_TONE_COLOR[t])
/** A tone at 7% over white — the pills' and callouts' background. */
export const tint = (c: Rgb, a = 0.08): Rgb => c.map((x) => 1 - a + a * x) as Rgb

export const M = 40 // page margin
export const FOOT = 46 // footer band: the rule, the caption and clear space above them

export const fmtPct = (n: number | undefined) => (n === undefined ? '—' : `${Number(n.toFixed(1))}%`)
export const utc = (iso?: string) => (iso ? `${iso.slice(0, 19).replace('T', ' ')} UTC` : 'not recorded')

export class Layout {
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
    this.ensure(64)
    this.y += 16
    const label = title.toUpperCase()
    this.text(label, M, this.y + 8, 'bold', 8, BRAND)
    const w = textWidth(label, 'bold', 8)
    this.doc.line(M + w + 8, this.y + 5, M + this.W, this.y + 5, LINE)
    this.y += 20
  }

  /** A sub-heading; `keepWith` is the height of what must follow it on the same page. */
  h3(title: string, keepWith = 0): void {
    this.ensure(Math.max(56, 30 + keepWith))
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

export function kpis(L: Layout, items: Array<{ value: string; label: string; color: Rgb }>): void {
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

export function facts(L: Layout, rows: Array<{ label: string; value: string; mono?: boolean; sub?: string }>): void {
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

export interface Cell {
  text: string
  sub?: string
  mono?: boolean
  pill?: { tone: Tone; label: string }
}

export function table(L: Layout, cols: Array<{ title: string; width: number }>, rows: Cell[][]): void {
  const total = cols.reduce((a, c) => a + c.width, 0)
  const widths = cols.map((c) => (c.width / total) * L.W)
  // A header is never left alone at the foot of a page: keep it with its first row.
  const firstRowH = rows.length
    ? Math.max(...rows[0].map((c, i) => (c.pill ? 12 : wrapText(c.text, c.mono ? 'mono' : 'regular', c.mono ? 8 : 9, widths[i] - 8).length * 12.5) + (c.sub ? wrapText(c.sub, 'regular', 7, widths[i] - 8).length * 9.5 : 0))) + 8
    : 0
  const header = () => {
    L.ensure(20 + firstRowH)
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
export function leadLines(lead: string, body: string, size: number, width: number): { leadW: number; lines: string[] } {
  const leadW = textWidth(`${lead} `, 'bold', size)
  return { leadW, lines: wrapText(body, 'regular', size, width, leadW) }
}

/** The height a finding card takes, so a heading can be kept with the first one. */
export function findingCardHeight(L: Layout, f: KitFinding): number {
  return cardGeometry(L, f).h + 8
}

function cardGeometry(L: Layout, f: KitFinding) {
  const pad = 12
  const inner = L.W - 2 * pad - 4
  const size = 8.5
  const lh = size * 1.45
  const pw = L.pillWidth(REPORT_TONE_LABEL[f.tone])
  const title = wrapText(f.title, 'bold', 10, inner - pw - 8)
  const obs = leadLines('Observation.', f.observation, size, inner)
  const mean = leadLines('What it means.', f.explanation, size, inner)
  const rec = f.recommendation ? leadLines('Recommendation.', f.recommendation, size, inner - 16) : undefined
  const REC_PAD = 6
  const TITLE_LH = 13.5
  const PARA_GAP = 3
  // One geometry for measuring and drawing, so the space under the last line
  // matches the space above the title.
  const contentH = title.length * TITLE_LH + 4 + obs.lines.length * lh + PARA_GAP + mean.lines.length * lh +
    (rec ? 6 + REC_PAD * 2 + rec.lines.length * lh : 0)
  return { pad, inner, size, lh, pw, title, obs, mean, rec, REC_PAD, TITLE_LH, PARA_GAP, h: pad + contentH + pad - 2 }
}

export function findingCard(L: Layout, f: KitFinding): void {
  const { pad, inner, size, lh, pw, title, obs, mean, rec, REC_PAD, TITLE_LH, PARA_GAP, h } = cardGeometry(L, f)
  L.ensure(h + 8)
  const top = L.y
  L.doc.rect(M, top, L.W, h, { stroke: LINE, lineWidth: 0.7, radius: 7 })
  L.doc.rect(M, top, 3.5, h, { fill: tone(f.tone) })
  const x = M + pad + 4
  // `y` is the TOP of the next line box; baselines sit `size` below it.
  let y = top + pad
  title.forEach((t, i) => L.text(t, x, y + 10 + i * TITLE_LH, 'bold', 10, INK))
  L.pill(M + L.W - pad - pw, y + 9, f.tone)
  y += title.length * TITLE_LH + 4
  const drawLead = (lead: string, p: { leadW: number; lines: string[] }, color: Rgb, dx = 0) => {
    p.lines.forEach((ln, i) => {
      if (i === 0) L.text(lead, x + dx, y + size, 'bold', size, color)
      L.text(ln, x + dx + (i === 0 ? p.leadW : 0), y + size, 'regular', size, color)
      y += lh
    })
  }
  drawLead('Observation.', obs, hex('#334155'))
  y += PARA_GAP
  drawLead('What it means.', mean, hex('#334155'))
  if (rec) {
    y += 6
    L.doc.rect(x - 4, y, inner + 8, REC_PAD * 2 + rec.lines.length * lh - 2, { fill: REC_BG, radius: 5 })
    y += REC_PAD - 1
    drawLead('Recommendation.', rec, REC_INK, 4)
  }
  L.y = top + h + 8
}

export function recommendationList(L: Layout, recs: KitFinding[]): void {
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


/** Page footers, once the page count is known: a caption left, "Page n of N" right. */
export function footers(doc: PdfDocument, caption: string): void {
  const n = doc.pageCount
  const W = doc.width - 2 * M
  for (let i = 0; i < n; i++) {
    doc.setPage(i)
    const top = doc.height - M - 10
    doc.line(M, top - 10, doc.width - M, top - 10, LINE)
    doc.text(wrapText(caption, 'regular', 7, W - 60)[0], M, top, { size: 7, color: SUBTLE })
    const pg = `Page ${i + 1} of ${n}`
    doc.text(pg, doc.width - M - textWidth(pg, 'regular', 7), top, { size: 7, color: SUBTLE })
  }
}

/** The cover's diagonal brand gradient, approximated with vertical strips. */
export function coverBand(doc: PdfDocument, height: number): void {
  const strips = 48
  for (let i = 0; i < strips; i++) {
    const t = i / (strips - 1)
    const c = COVER.map((v, k) => v + (COVER_2[k] - v) * t) as Rgb
    doc.rect((doc.width / strips) * i, 0, doc.width / strips + 0.6, height, { fill: c })
  }
}
