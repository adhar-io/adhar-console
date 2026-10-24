/**
 * A small, dependency-free PDF writer: text in the three standard fonts,
 * filled and stroked shapes, and link annotations, on A4 pages.
 *
 * Why not a library: the reports need vector text a reader can select and
 * search, and nothing more. jsPDF's HTML path rasterises through html2canvas,
 * pdf-lib is unmaintained, and either adds a new npm dependency (and a
 * pnpm-lock change the container build is strict about) for what is a few
 * hundred lines of a well-specified format. The standard 14 fonts need no
 * embedding, so a multi-page report is tens of kilobytes.
 *
 * Coordinates are in points from the TOP-left (the layout code thinks top-down;
 * PDF's bottom-up origin is converted here). Text is WinAnsi: Latin-1 plus the
 * usual typographic punctuation; anything else is transliterated or becomes
 * "?", never dropped silently.
 *
 * Pure: builds a Uint8Array, no DOM.
 */

export const A4 = { width: 595.28, height: 841.89 }

export type FontName = 'regular' | 'bold' | 'mono'
export type Rgb = [number, number, number]

const FONT_RES: Record<FontName, { key: string; base: string }> = {
  regular: { key: 'F1', base: 'Helvetica' },
  bold: { key: 'F2', base: 'Helvetica-Bold' },
  mono: { key: 'F3', base: 'Courier' },
}

/* Advance widths (1/1000 em) for ASCII 32–126, from the Adobe AFM files. */
// deno-fmt-ignore
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
// deno-fmt-ignore
const HELVETICA_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]

/** Unicode → WinAnsi byte for the characters outside Latin-1 that WinAnsi has. */
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}
/** Characters WinAnsi lacks, spelled with ones it has. */
const SPELL: Record<string, string> = { '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '↗': '', '✓': 'v', '×': 'x', '−': '-', ' ': ' ', '\t': '  ' }
/** Rough widths for the WinAnsi punctuation above (the rest of 0x80–0xFF is treated as a lowercase letter). */
const WIDE: Record<number, number> = { 0x85: 1000, 0x95: 350, 0x96: 556, 0x97: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0xb7: 278 }

/** A string as WinAnsi bytes (one char per byte, 0–255). */
export function toWinAnsi(s: string): string {
  let out = ''
  for (const ch of s.normalize('NFC')) {
    if (SPELL[ch] !== undefined) {
      out += SPELL[ch]
      continue
    }
    const cp = ch.codePointAt(0)!
    if (cp === 0x0a || cp === 0x0d) out += ' '
    else if (cp < 0x20) continue
    else if (cp < 0x7f || (cp >= 0xa0 && cp <= 0xff)) out += ch
    else if (WIN_ANSI[cp] !== undefined) out += String.fromCharCode(WIN_ANSI[cp])
    else out += '?'
  }
  return out
}

function charWidth(code: number, font: FontName): number {
  if (font === 'mono') return 600
  if (code >= 32 && code <= 126) return (font === 'bold' ? HELVETICA_BOLD : HELVETICA)[code - 32]
  return WIDE[code] ?? 556
}

/** Width of `s` in points at `size`. */
export function textWidth(s: string, font: FontName, size: number): number {
  const enc = toWinAnsi(s)
  let w = 0
  for (let i = 0; i < enc.length; i++) w += charWidth(enc.charCodeAt(i), font)
  return (w * size) / 1000
}

/**
 * Greedy word wrap to `maxWidth`. A single word wider than the line (a SHA,
 * an image reference) is broken at the character that overflows.
 * `firstIndent` narrows only the first line (for a bold lead-in before it).
 */
export function wrapText(s: string, font: FontName, size: number, maxWidth: number, firstIndent = 0): string[] {
  const lines: string[] = []
  let line = ''
  const limit = () => maxWidth - (lines.length === 0 ? firstIndent : 0)
  const push = () => {
    lines.push(line)
    line = ''
  }
  for (const word of s.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!word) continue
    const candidate = line ? `${line} ${word}` : word
    if (textWidth(candidate, font, size) <= limit()) {
      line = candidate
      continue
    }
    if (line) push()
    let rest = word
    // `rest &&`: with a first-line indent wider than the line the limit goes
    // negative, an empty remainder still "overflows", and this never ended.
    while (rest && textWidth(rest, font, size) > limit()) {
      let n = 1
      while (n < rest.length && textWidth(rest.slice(0, n + 1), font, size) <= limit()) n++
      line = rest.slice(0, n)
      push()
      rest = rest.slice(n)
    }
    line = rest
  }
  if (line || !lines.length) lines.push(line)
  return lines
}

/** Code lines for a monospace font: indentation kept, long lines cut at the width. */
export function wrapMono(s: string, size: number, maxWidth: number): string[] {
  const per = Math.max(1, Math.floor(maxWidth / (0.6 * size)))
  return s.split('\n').flatMap((line) => {
    const out: string[] = []
    for (let i = 0; i < line.length; i += per) out.push(line.slice(i, i + per))
    return out.length ? out : ['']
  })
}

/** `s` cut to fit `maxWidth`, with an ellipsis when it was cut. */
export function fitText(s: string, font: FontName, size: number, maxWidth: number): string {
  if (textWidth(s, font, size) <= maxWidth) return s
  let n = s.length
  while (n > 0 && textWidth(`${s.slice(0, n)}\u2026`, font, size) > maxWidth) n--
  return `${s.slice(0, n)}\u2026`
}

/** `#4f46e5` → [r, g, b] in 0–1. */
export function hex(c: string): Rgb {
  const h = c.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6), 16)
  // An unparseable colour would emit `NaN NaN NaN rg` — an invalid operator
  // that makes strict readers drop the rest of the page. Fall back to black.
  if (!Number.isFinite(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// Non-finite numbers (a NaN from an empty data set's scale, say) would write
// `NaN` into the content stream, which is not a PDF number; draw at 0 instead.
const f = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0).toString()
const rgb = (c: Rgb) => c.map((x) => f(x)).join(' ')
const pdfString = (s: string) => `(${toWinAnsi(s).replace(/[\\()]/g, (m) => `\\${m}`)})`

interface Page {
  ops: string[]
  links: Array<{ x: number; y: number; w: number; h: number; url: string }>
}

export interface ShapeStyle {
  fill?: Rgb
  stroke?: Rgb
  lineWidth?: number
}

export class PdfDocument {
  readonly width = A4.width
  readonly height = A4.height
  private pages: Page[] = []
  private info: Record<string, string>

  constructor(info: { title?: string; author?: string; subject?: string } = {}) {
    this.info = Object.fromEntries(Object.entries(info).filter(([, v]) => !!v)) as Record<string, string>
  }

  get pageCount(): number {
    return this.pages.length
  }

  /** Start a new page; later drawing goes to it. */
  addPage(): number {
    this.pages.push({ ops: [], links: [] })
    this.current = this.pages.length - 1
    return this.current
  }

  /** Draw on an earlier page again (page footers are written once the count is known). */
  setPage(i: number): void {
    if (i >= 0 && i < this.pages.length) this.current = i
  }
  private current = 0

  private get cur(): Page {
    if (!this.pages.length) this.addPage()
    return this.pages[this.current]
  }

  private y(top: number): number {
    return this.height - top
  }

  /** Text with its BASELINE at `top`. */
  text(s: string, x: number, top: number, opt: { font?: FontName; size?: number; color?: Rgb } = {}): void {
    const font = opt.font ?? 'regular'
    const size = opt.size ?? 10
    this.cur.ops.push(`BT /${FONT_RES[font].key} ${f(size)} Tf ${rgb(opt.color ?? [0, 0, 0])} rg ${f(x)} ${f(this.y(top))} Td ${pdfString(s)} Tj ET`)
  }

  private paint(style: ShapeStyle): string {
    const parts: string[] = []
    if (style.fill) parts.push(`${rgb(style.fill)} rg`)
    if (style.stroke) parts.push(`${rgb(style.stroke)} RG ${f(style.lineWidth ?? 0.75)} w`)
    return parts.join(' ')
  }

  private op(style: ShapeStyle): string {
    return style.fill && style.stroke ? 'B' : style.fill ? 'f' : 'S'
  }

  /** A rectangle, optionally with rounded corners. */
  rect(x: number, top: number, w: number, h: number, style: ShapeStyle & { radius?: number }): void {
    const r = Math.min(style.radius ?? 0, w / 2, h / 2)
    const y0 = this.y(top + h)
    if (r <= 0) {
      this.cur.ops.push(`q ${this.paint(style)} ${f(x)} ${f(y0)} ${f(w)} ${f(h)} re ${this.op(style)} Q`)
      return
    }
    const k = r * 0.5523
    const x1 = x + w
    const y1 = y0 + h
    const path = [
      `${f(x + r)} ${f(y0)} m`,
      `${f(x1 - r)} ${f(y0)} l`,
      `${f(x1 - r + k)} ${f(y0)} ${f(x1)} ${f(y0 + r - k)} ${f(x1)} ${f(y0 + r)} c`,
      `${f(x1)} ${f(y1 - r)} l`,
      `${f(x1)} ${f(y1 - r + k)} ${f(x1 - r + k)} ${f(y1)} ${f(x1 - r)} ${f(y1)} c`,
      `${f(x + r)} ${f(y1)} l`,
      `${f(x + r - k)} ${f(y1)} ${f(x)} ${f(y1 - r + k)} ${f(x)} ${f(y1 - r)} c`,
      `${f(x)} ${f(y0 + r)} l`,
      `${f(x)} ${f(y0 + r - k)} ${f(x + r - k)} ${f(y0)} ${f(x + r)} ${f(y0)} c`,
      'h',
    ].join(' ')
    this.cur.ops.push(`q ${this.paint(style)} ${path} ${this.op(style)} Q`)
  }

  /** A circle centred at (cx, cy-from-top). */
  circle(cx: number, cyTop: number, r: number, style: ShapeStyle): void {
    const cy = this.y(cyTop)
    const k = r * 0.5523
    const path = [
      `${f(cx + r)} ${f(cy)} m`,
      `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
      `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
      `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
      `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
      'h',
    ].join(' ')
    this.cur.ops.push(`q ${this.paint(style)} ${path} ${this.op(style)} Q`)
  }

  /** An arc of a ring: `fraction` of the circle clockwise from 12 o'clock, stroked. */
  arc(cx: number, cyTop: number, r: number, fraction: number, color: Rgb, lineWidth: number): void {
    const frac = Math.max(0, Math.min(1, fraction))
    if (frac <= 0) return
    const cy = this.y(cyTop)
    const segs = Math.max(1, Math.ceil(frac * 16))
    const pts: string[] = []
    for (let i = 0; i <= segs; i++) {
      const a = Math.PI / 2 - (2 * Math.PI * frac * i) / segs
      pts.push(`${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))} ${i === 0 ? 'm' : 'l'}`)
    }
    this.cur.ops.push(`q ${rgb(color)} RG ${f(lineWidth)} w 1 J 1 j ${pts.join(' ')} S Q`)
  }

  line(x1: number, top1: number, x2: number, top2: number, color: Rgb, lineWidth = 0.75): void {
    this.cur.ops.push(`q ${rgb(color)} RG ${f(lineWidth)} w ${f(x1)} ${f(this.y(top1))} m ${f(x2)} ${f(this.y(top2))} l S Q`)
  }

  /**
   * An open polyline through `points` (x, top) — one path, so a 160-sample
   * series is one drawing operation. `dash` is `[on, off]` in points.
   */
  polyline(points: Array<[number, number]>, color: Rgb, lineWidth = 1, dash?: [number, number]): void {
    if (points.length < 2) return
    const path = points.map(([x, top], i) => `${f(x)} ${f(this.y(top))} ${i === 0 ? 'm' : 'l'}`).join(' ')
    const d = dash ? `[${f(dash[0])} ${f(dash[1])}] 0 d ` : ''
    this.cur.ops.push(`q ${rgb(color)} RG ${f(lineWidth)} w 1 J 1 j ${d}${path} S Q`)
  }

  /** A clickable area opening `url`. */
  link(x: number, top: number, w: number, h: number, url: string): void {
    if (!/^https?:\/\//.test(url)) return
    this.cur.links.push({ x, y: this.y(top + h), w, h, url })
  }

  /** The finished file. */
  output(): Uint8Array {
    const pages = this.pages
    const objs: string[] = []
    const add = (body: string) => {
      objs.push(body)
      return objs.length
    }
    const catalog = add('') // filled below
    const pagesObj = add('')
    const fonts = (Object.keys(FONT_RES) as FontName[]).map((k) =>
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_RES[k].base} /Encoding /WinAnsiEncoding >>`)
    )
    const fontDict = (Object.keys(FONT_RES) as FontName[]).map((k, i) => `/${FONT_RES[k].key} ${fonts[i]} 0 R`).join(' ')
    const kids: number[] = []
    for (const p of pages) {
      const stream = p.ops.join('\n')
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
      const annots = p.links.map((l) =>
        add(`<< /Type /Annot /Subtype /Link /Rect [${f(l.x)} ${f(l.y)} ${f(l.x + l.w)} ${f(l.y + l.h)}] /Border [0 0 0] /A << /Type /Action /S /URI /URI ${pdfString(l.url)} >> >>`)
      )
      kids.push(add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${f(this.width)} ${f(this.height)}] /Resources << /Font << ${fontDict} >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`,
      ))
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
    const infoEntries = Object.entries(this.info).map(([k, v]) => `/${k[0].toUpperCase()}${k.slice(1)} ${pdfString(v)}`)
    const info = add(`<< ${infoEntries.join(' ')} /Producer (Adhar Console) >>`)

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
    const offsets: number[] = []
    objs.forEach((body, i) => {
      offsets.push(out.length)
      out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = out.length
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`

    const bytes = new Uint8Array(out.length)
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff
    return bytes
  }
}
