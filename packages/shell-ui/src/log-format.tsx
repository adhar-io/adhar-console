import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * Shared log-rendering helpers for the streaming Logs page (`logs-viewer.tsx`)
 * and the pod drawer log panel (`pod-logs.tsx`).
 *
 * Everything here is pure string/DOM processing over the *real* log stream —
 * nothing is fabricated. It provides:
 *
 *   • `SINCE_OPTIONS` / `TAIL_OPTIONS` — time-window presets wired to
 *     `logStream`'s `sinceSeconds` / `tailLines`.
 *   • `detectSeverity` + `SEVERITY_*` — parse common level tokens
 *     (`level=error`, `ERROR`, klog `E0102`, JSON `"level":"error"`) and colour
 *     each line by severity.
 *   • ANSI SGR parsing (`parseAnsi` / `stripAnsi`) so colourised container
 *     output renders correctly; codes are stripped for copy / download.
 *   • `buildMatcher` — a plain / regex, case (in)sensitive find + filter matcher.
 *   • `renderSegments` — combines ANSI colouring with find-highlighting in one
 *     pass, so a matched substring stays highlighted inside its ANSI colour.
 *   • `containerColor` — stable per-container tint for the "All containers"
 *     merged view.
 */

/* ───────────────────────── time / tail presets ───────────────────────── */

export const TAIL_OPTIONS = [100, 500, 1000, 5000, 10000] as const
export type Tail = (typeof TAIL_OPTIONS)[number]

export const SINCE_OPTIONS = [
  { label: 'all', seconds: undefined as number | undefined },
  { label: '5m', seconds: 5 * 60 },
  { label: '15m', seconds: 15 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '6h', seconds: 6 * 60 * 60 },
  { label: '24h', seconds: 24 * 60 * 60 },
] as const

export type SinceLabel = (typeof SINCE_OPTIONS)[number]['label']

export function sinceSecondsFor(label: SinceLabel): number | undefined {
  return SINCE_OPTIONS.find((s) => s.label === label)?.seconds
}

/* ───────────────────────────── severity ──────────────────────────────── */

export type Severity = 'error' | 'warn' | 'info' | 'debug' | 'other'

export const SEVERITIES: Severity[] = ['error', 'warn', 'info', 'debug', 'other']

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
  debug: 'Debug',
  other: 'Other',
}

/** Text tint for a line of the given severity, tuned for the dark log surface. */
export const SEVERITY_TONE: Record<Severity, string> = {
  error: 'text-rose-300',
  warn: 'text-amber-200',
  info: 'text-sky-200',
  debug: 'text-code-fg/55',
  other: 'text-code-fg/85',
}

/** Small dot / chip accent per severity (theme-aware chrome). */
export const SEVERITY_DOT: Record<Severity, string> = {
  error: 'bg-rose-400',
  warn: 'bg-amber-400',
  info: 'bg-sky-400',
  debug: 'bg-code-fg/40',
  other: 'bg-code-fg/55',
}

/**
 * Classify a log line by severity from common level markers. Order matters:
 * error > warn > debug > info, so a line mentioning both "error" and "info"
 * reads as an error.
 */
export function detectSeverity(line: string): Severity {
  const s = line.toLowerCase()
  // Structured: level=error / "level":"error" / lvl=warn / severity=info
  const kv = s.match(/(?:"?(?:level|lvl|severity)"?\s*[=:]\s*"?)(error|err|fatal|crit|warn(?:ing)?|info|debug|trace)/)
  if (kv) return normalizeToken(kv[1])
  // klog / glog single-letter + date: E0102, W0102, I0102, D0102
  if (/\b[e]\d{4}\b/.test(s)) return 'error'
  if (/\b[w]\d{4}\b/.test(s)) return 'warn'
  // Bare word tokens.
  if (/\b(error|fatal|panic|fault|exception)\b/.test(s)) return 'error'
  if (/\bwarn(?:ing)?\b/.test(s)) return 'warn'
  if (/\b(debug|trace)\b/.test(s)) return 'debug'
  if (/\b[i]\d{4}\b/.test(s) || /\binfo\b/.test(s)) return 'info'
  return 'other'
}

function normalizeToken(t: string): Severity {
  if (t === 'err' || t === 'fatal' || t === 'crit' || t === 'error') return 'error'
  if (t === 'warn' || t === 'warning') return 'warn'
  if (t === 'debug' || t === 'trace') return 'debug'
  if (t === 'info') return 'info'
  return 'other'
}

/* ─────────────────────────── ANSI SGR parsing ────────────────────────── */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

/** Strip all ANSI SGR escape codes — used for copy, download, search & filter. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export interface AnsiStyle {
  color?: string
  fontWeight?: 'bold'
  fontStyle?: 'italic'
  textDecoration?: 'underline'
  opacity?: number
}

export interface AnsiSegment {
  text: string
  style: AnsiStyle
}

// xterm-ish palette tuned for a dark (slate-950) background.
const ANSI_FG: Record<number, string> = {
  30: '#64748b', 31: '#f87171', 32: '#4ade80', 33: '#fbbf24',
  34: '#60a5fa', 35: '#c084fc', 36: '#22d3ee', 37: '#e2e8f0',
  90: '#94a3b8', 91: '#fca5a5', 92: '#86efac', 93: '#fde047',
  94: '#93c5fd', 95: '#d8b4fe', 96: '#67e8f9', 97: '#f8fafc',
}

function xterm256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined
  if (n < 16) {
    // Standard + bright map onto the fg table (30-37 / 90-97).
    const base = n < 8 ? 30 + n : 90 + (n - 8)
    return ANSI_FG[base]
  }
  if (n < 232) {
    const c = n - 16
    const r = Math.floor(c / 36)
    const g = Math.floor((c % 36) / 6)
    const b = c % 6
    const conv = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return rgbHex(conv(r), conv(g), conv(b))
  }
  const v = 8 + (n - 232) * 10
  return rgbHex(v, v, v)
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/**
 * Parse a line containing ANSI SGR codes into styled text segments. Unknown or
 * unsupported codes are ignored; background codes are dropped (we keep the dark
 * surface). Returns at least one segment (possibly with empty text).
 */
export function parseAnsi(line: string): AnsiSegment[] {
  if (!line.includes('\x1b[')) return [{ text: line, style: {} }]
  const segments: AnsiSegment[] = []
  let style: AnsiStyle = {}
  let last = 0
  ANSI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const push = (text: string) => {
    if (text) segments.push({ text, style: { ...style } })
  }
  while ((m = ANSI_RE.exec(line)) !== null) {
    push(line.slice(last, m.index))
    last = ANSI_RE.lastIndex
    style = applySgr(style, m[0])
  }
  push(line.slice(last))
  return segments.length ? segments : [{ text: '', style: {} }]
}

function applySgr(prev: AnsiStyle, code: string): AnsiStyle {
  const body = code.slice(2, -1) // strip \x1b[ and m
  const nums = body === '' ? [0] : body.split(';').map((n) => Number(n) || 0)
  const style: AnsiStyle = { ...prev }
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]
    if (n === 0) {
      // reset
      style.color = undefined
      style.fontWeight = undefined
      style.fontStyle = undefined
      style.textDecoration = undefined
      style.opacity = undefined
    } else if (n === 1) style.fontWeight = 'bold'
    else if (n === 2) style.opacity = 0.7
    else if (n === 3) style.fontStyle = 'italic'
    else if (n === 4) style.textDecoration = 'underline'
    else if (n === 22) {
      style.fontWeight = undefined
      style.opacity = undefined
    } else if (n === 23) style.fontStyle = undefined
    else if (n === 24) style.textDecoration = undefined
    else if (n === 39) style.color = undefined
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) style.color = ANSI_FG[n]
    else if (n === 38) {
      // extended fg: 38;5;n (256) or 38;2;r;g;b (truecolor)
      const mode = nums[i + 1]
      if (mode === 5) {
        style.color = xterm256(nums[i + 2]) ?? style.color
        i += 2
      } else if (mode === 2) {
        style.color = rgbHex(nums[i + 2], nums[i + 3], nums[i + 4])
        i += 4
      }
    }
    // 40-49 (background) intentionally ignored.
  }
  return style
}

function styleToCss(s: AnsiStyle): CSSProperties | undefined {
  if (!s.color && !s.fontWeight && !s.fontStyle && !s.textDecoration && s.opacity == null) return undefined
  return {
    color: s.color,
    fontWeight: s.fontWeight,
    fontStyle: s.fontStyle,
    textDecoration: s.textDecoration,
    opacity: s.opacity,
  }
}

/* ─────────────────────────── search matcher ──────────────────────────── */

export interface Matcher {
  /** True if the (ANSI-stripped) text matches. */
  test(text: string): boolean
  /** Non-overlapping [start, end) match ranges over the stripped text. */
  ranges(text: string): Array<[number, number]>
  /** True when a non-empty query is active. */
  readonly active: boolean
  /** Set when a regex query failed to compile. */
  readonly error?: string
}

const EMPTY_MATCHER: Matcher = {
  test: () => true,
  ranges: () => [],
  active: false,
}

/**
 * Build a find / filter matcher. `regex` switches from plain substring to a
 * RegExp; an invalid pattern yields an inert matcher carrying `.error`.
 */
export function buildMatcher(query: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}): Matcher {
  const q = query
  if (!q) return EMPTY_MATCHER
  const flags = opts.caseSensitive ? 'g' : 'gi'
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(q, flags)
    } catch (err) {
      return { ...EMPTY_MATCHER, active: true, error: err instanceof Error ? err.message : 'Invalid regex' }
    }
    return {
      active: true,
      test: (text) => {
        re.lastIndex = 0
        return re.test(text)
      },
      ranges: (text) => {
        const out: Array<[number, number]> = []
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(text)) !== null) {
          if (m[0] === '') {
            re.lastIndex++ // avoid zero-width infinite loop
            continue
          }
          out.push([m.index, m.index + m[0].length])
          if (out.length > 5000) break
        }
        return out
      },
    }
  }
  const needle = opts.caseSensitive ? q : q.toLowerCase()
  return {
    active: true,
    test: (text) => (opts.caseSensitive ? text : text.toLowerCase()).includes(needle),
    ranges: (text) => {
      const hay = opts.caseSensitive ? text : text.toLowerCase()
      const out: Array<[number, number]> = []
      let from = 0
      for (;;) {
        const idx = hay.indexOf(needle, from)
        if (idx < 0) break
        out.push([idx, idx + needle.length])
        from = idx + needle.length
        if (out.length > 5000) break
      }
      return out
    },
  }
}

/* ─────────────────────── combined ANSI + highlight ───────────────────── */

/**
 * Render a raw log line as React nodes: ANSI colours applied, and any matcher
 * hits wrapped in <mark>. Highlight ranges are computed over the ANSI-stripped
 * text and mapped back onto the coloured segments so a match inside coloured
 * output still highlights correctly. `currentRange`, when supplied (stripped
 * coords), marks the "active" find hit for next/prev navigation.
 */
export function renderSegments(
  line: string,
  matcher: Matcher,
  currentRange?: [number, number] | null,
): ReactNode {
  const segments = parseAnsi(line)
  if (!matcher.active || matcher.error) {
    return segments.map((seg, i) => (
      <span key={i} style={styleToCss(seg.style)}>
        {seg.text}
      </span>
    ))
  }
  const stripped = segments.map((s) => s.text).join('')
  const ranges = matcher.ranges(stripped)
  if (ranges.length === 0) {
    return segments.map((seg, i) => (
      <span key={i} style={styleToCss(seg.style)}>
        {seg.text}
      </span>
    ))
  }

  const out: ReactNode[] = []
  let key = 0
  let offset = 0 // running position in the stripped string
  for (const seg of segments) {
    const segStart = offset
    const segEnd = offset + seg.text.length
    const css = styleToCss(seg.style)
    // Overlapping ranges for this segment.
    let cursor = segStart
    const pieces: ReactNode[] = []
    for (const [rs, re] of ranges) {
      if (re <= segStart || rs >= segEnd) continue
      const s = Math.max(rs, segStart)
      const e = Math.min(re, segEnd)
      if (s > cursor) pieces.push(<span key={key++}>{seg.text.slice(cursor - segStart, s - segStart)}</span>)
      const isCurrent = currentRange && rs === currentRange[0] && re === currentRange[1]
      pieces.push(
        <mark
          key={key++}
          className={cn(
            'rounded px-0.5',
            isCurrent ? 'bg-amber-400 text-code' : 'bg-amber-300/30 text-amber-100',
          )}
        >
          {seg.text.slice(s - segStart, e - segStart)}
        </mark>,
      )
      cursor = e
    }
    if (cursor < segEnd) pieces.push(<span key={key++}>{seg.text.slice(cursor - segStart)}</span>)
    out.push(
      <span key={key++} style={css}>
        {pieces}
      </span>,
    )
    offset = segEnd
  }
  return out
}

/* ───────────────────────── container tinting ─────────────────────────── */

const CONTAINER_PALETTE = [
  '#7dd3fc', // sky-300
  '#86efac', // green-300
  '#fca5a5', // red-300
  '#fdba74', // orange-300
  '#c4b5fd', // violet-300
  '#f9a8d4', // pink-300
  '#5eead4', // teal-300
  '#fde047', // yellow-300
]

/** Stable colour for a container name in the merged "All containers" view. */
export function containerColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return CONTAINER_PALETTE[h % CONTAINER_PALETTE.length]
}
