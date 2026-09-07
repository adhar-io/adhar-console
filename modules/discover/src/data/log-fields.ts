import type { lgtm } from '@adhar-console/api-clients'

/**
 * Pure helpers for the Logs explorer — field extraction, dedup keys, text
 * matching/highlighting, LogQL editing and the small localStorage stores for
 * query history / saved queries. No React, no network.
 */

/** Stream labels as a concrete record (zod leaves the field optional). */
export function labelsOf(entry: Pick<lgtm.LogEntry, 'labels'>): Record<string, string> {
  return entry.labels ?? {}
}

/* ─────────── structured field extraction ─────────── */

export type ParsedFormat = 'json' | 'logfmt' | 'text'

export interface ParsedLine {
  format: ParsedFormat
  fields: Record<string, string>
  /** Pretty-printed JSON when the line is a JSON object. */
  pretty?: string
}

const cache = new WeakMap<object, ParsedLine>()

/** Auto-detect JSON / logfmt and flatten to string fields (cached per entry). */
export function parseLine(entry: lgtm.LogEntry): ParsedLine {
  const hit = cache.get(entry)
  if (hit) return hit
  const out = parseMessage(entry.message)
  cache.set(entry, out)
  return out
}

export function parseMessage(message: string): ParsedLine {
  const trimmed = message.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const fields: Record<string, string> = {}
        flatten(obj as Record<string, unknown>, '', fields)
        return { format: 'json', fields, pretty: JSON.stringify(obj, null, 2) }
      }
    } catch {
      // fall through — not JSON after all
    }
  }
  const fields = parseLogfmt(trimmed)
  if (Object.keys(fields).length >= 2) return { format: 'logfmt', fields }
  return { format: 'text', fields }
}

function flatten(obj: Record<string, unknown>, prefix: string, into: Record<string, string>, depth = 0) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
      flatten(v as Record<string, unknown>, key, into, depth + 1)
    } else if (Array.isArray(v)) {
      into[key] = JSON.stringify(v)
    } else if (v === null || v === undefined) {
      into[key] = ''
    } else {
      into[key] = String(v)
    }
  }
}

const LOGFMT = /([A-Za-z_][\w.\-/]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S*)/g

/** `key=value key2="quoted value"` pairs anywhere in the line. */
export function parseLogfmt(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of line.matchAll(LOGFMT)) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\(["'\\])/g, '$1')
    }
    out[m[1]] = v
  }
  return out
}

/* ─────────── dedup ─────────── */

export type DedupMode = 'none' | 'exact' | 'numbers' | 'signature'

/** Key used to collapse repeated lines, per Grafana's dedup strategies. */
export function dedupKey(message: string, mode: DedupMode): string {
  switch (mode) {
    case 'exact':
      return message
    case 'numbers':
      return message.replace(/\d+(?:\.\d+)?/g, '#')
    case 'signature':
      // Strip numbers, hex ids, quoted strings and timestamps → the "shape".
      return message
        .replace(/"[^"]*"/g, '"…"')
        .replace(/\b[0-9a-f]{8,}\b/gi, '#')
        .replace(/\d+(?:[.:T\-/]\d+)*Z?/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
    default:
      return ''
  }
}

/* ─────────── text matching + highlighting ─────────── */

export interface TextFilter {
  text: string
  regex: boolean
  caseSensitive: boolean
  /** Hide lines that match instead of showing only matches. */
  exclude: boolean
}

export const EMPTY_TEXT_FILTER: TextFilter = { text: '', regex: false, caseSensitive: false, exclude: false }

export function compileFilter(f: TextFilter): RegExp | null {
  const t = f.text.trim()
  if (!t) return null
  const flags = f.caseSensitive ? 'g' : 'gi'
  try {
    return new RegExp(f.regex ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  } catch {
    return null
  }
}

/** Split `text` into plain / highlighted segments for the compiled matcher. */
export function splitMatches(text: string, re: RegExp | null): Array<{ text: string; hit: boolean }> {
  if (!re) return [{ text, hit: false }]
  const out: Array<{ text: string; hit: boolean }> = []
  let last = 0
  re.lastIndex = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (m[0].length === 0) continue
    if (i > last) out.push({ text: text.slice(last, i), hit: false })
    out.push({ text: m[0], hit: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out.length ? out : [{ text, hit: false }]
}

/* ─────────── LogQL editing ─────────── */

/** `{a="b", c="d"}` → [[a,=,b],[c,=,d]] for the leading stream selector. */
export function parseSelector(query: string): Array<{ key: string; op: string; value: string }> {
  const m = /^\s*\{([^}]*)\}/.exec(query)
  if (!m) return []
  return [...m[1].matchAll(/([A-Za-z_][\w]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"/g)].map((x) => ({
    key: x[1],
    op: x[2],
    value: x[3],
  }))
}

/** Add / replace one matcher in the leading stream selector (creating it if absent). */
export function withMatcher(query: string, key: string, value: string, op: '=' | '!=' = '='): string {
  const matchers = parseSelector(query).filter((m) => !(m.key === key && m.op === op))
  matchers.push({ key, op, value })
  const selector = `{${matchers.map((m) => `${m.key}${m.op}"${escapeQ(m.value)}"`).join(', ')}}`
  const rest = /^\s*\{[^}]*\}/.test(query) ? query.replace(/^\s*\{[^}]*\}/, '') : query.trim() ? ` ${query.trim()}` : ''
  return `${selector}${rest}`
}

/** Append a line filter (`|= "text"` / `!= "text"`). Adds a selector if the query has none. */
export function withLineFilter(query: string, text: string, exclude = false): string {
  const base = /^\s*\{/.test(query) ? query.trim() : `{namespace=~".+"}${query.trim() ? ` ${query.trim()}` : ''}`
  return `${base} ${exclude ? '!=' : '|='} "${escapeQ(text)}"`
}

/** Selector that pins every label of an entry — used for "show context". */
export function selectorFor(labels: Record<string, string> | undefined): string {
  const entries = Object.entries(labels ?? {}).filter(([k]) => !k.startsWith('__') && k !== 'detected_level')
  if (!entries.length) return '{namespace=~".+"}'
  return `{${entries.map(([k, v]) => `${k}="${escapeQ(v)}"`).join(', ')}}`
}

function escapeQ(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/* ─────────── tiny persistent stores ─────────── */

export interface SavedQuery {
  name: string
  query: string
  savedAt: string
}

const HISTORY_KEY = 'adhar.discover.logs.history.v1'
const SAVED_KEY = 'adhar.discover.logs.saved.v1'
const HISTORY_MAX = 25

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // quota / private mode — history is a convenience only
  }
}

export function loadHistory(): string[] {
  return read<string[]>(HISTORY_KEY, [])
}

export function pushHistory(query: string): string[] {
  const q = query.trim()
  if (!q) return loadHistory()
  const next = [q, ...loadHistory().filter((h) => h !== q)].slice(0, HISTORY_MAX)
  write(HISTORY_KEY, next)
  return next
}

export function clearHistory(): string[] {
  write(HISTORY_KEY, [])
  return []
}

export function loadSaved(): SavedQuery[] {
  return read<SavedQuery[]>(SAVED_KEY, [])
}

export function saveQuery(name: string, query: string): SavedQuery[] {
  const next = [
    { name: name.trim(), query: query.trim(), savedAt: new Date().toISOString() },
    ...loadSaved().filter((s) => s.name !== name.trim()),
  ]
  write(SAVED_KEY, next)
  return next
}

export function deleteSaved(name: string): SavedQuery[] {
  const next = loadSaved().filter((s) => s.name !== name)
  write(SAVED_KEY, next)
  return next
}

/* ─────────── formatting ─────────── */

const pad = (n: number) => String(n).padStart(2, '0')

export type TsFormat = 'time' | 'iso' | 'relative'

export function formatTs(iso: string, fmt: TsFormat, now = Date.now()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  if (fmt === 'iso') return d.toISOString()
  if (fmt === 'relative') return relative(now - d.getTime())
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

export function relative(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 1) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function formatDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/* ─────────── export ─────────── */

export function toExport(entries: lgtm.LogEntry[], kind: 'txt' | 'json' | 'csv'): string {
  if (kind === 'json') return JSON.stringify(entries, null, 2)
  if (kind === 'csv') {
    const keys = new Set<string>()
    for (const e of entries) for (const k of Object.keys(labelsOf(e))) keys.add(k)
    const cols = ['timestamp', 'level', 'message', ...[...keys].sort()]
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
    return [
      cols.join(','),
      ...entries.map((e) =>
        cols
          .map((c) =>
            c === 'timestamp' ? e.timestamp : c === 'level' ? e.level ?? '' : c === 'message' ? esc(e.message) : esc(labelsOf(e)[c] ?? ''),
          )
          .join(','),
      ),
    ].join('\n')
  }
  return entries.map((e) => `${e.timestamp} ${(e.level ?? 'info').toUpperCase().padEnd(5)} ${e.message}`).join('\n')
}
