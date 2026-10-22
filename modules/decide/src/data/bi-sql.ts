import type * as metabase from './mb-types.ts'

/**
 * SQL editor helpers: a cheap formatter, error-position parsing, per-user
 * query history and export. All pure (storage is injected) so they test
 * without a browser.
 */

/* ─────────── tokenizer ─────────── */

type Tok = { t: 'ws' | 'word' | 'str' | 'comment' | 'punct' | 'tag'; v: string }

/** Splits SQL without touching strings, comments or `{{tags}}` / `[[ ]]`. */
export function tokenize(sql: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const c2 = sql.slice(i, i + 2)
    if (/\s/.test(c)) {
      let j = i
      while (j < n && /\s/.test(sql[j])) j++
      out.push({ t: 'ws', v: sql.slice(i, j) })
      i = j
    } else if (c2 === '--') {
      let j = sql.indexOf('\n', i)
      if (j < 0) j = n
      out.push({ t: 'comment', v: sql.slice(i, j) })
      i = j
    } else if (c2 === '/*') {
      let j = sql.indexOf('*/', i + 2)
      j = j < 0 ? n : j + 2
      out.push({ t: 'comment', v: sql.slice(i, j) })
      i = j
    } else if (c2 === '{{') {
      let j = sql.indexOf('}}', i + 2)
      j = j < 0 ? n : j + 2
      out.push({ t: 'tag', v: sql.slice(i, j) })
      i = j
    } else if (c2 === '[[' || c2 === ']]') {
      out.push({ t: 'tag', v: c2 })
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) j += 2
        else if (sql[j] === c) break
        else j++
      }
      out.push({ t: 'str', v: sql.slice(i, j + 1) })
      i = j + 1
    } else if (/[\w$.]/.test(c)) {
      let j = i
      while (j < n && /[\w$.]/.test(sql[j])) j++
      out.push({ t: 'word', v: sql.slice(i, j) })
      i = j
    } else {
      out.push({ t: 'punct', v: c })
      i++
    }
  }
  return out
}

/* ─────────── write detection ─────────── */

const WRITE_VERBS = new Set(['insert', 'update', 'delete', 'merge', 'upsert', 'drop', 'alter', 'truncate', 'create', 'grant', 'revoke', 'rename', 'comment', 'vacuum', 'copy', 'call'])

const CTE_DML = new Set(['insert', 'update', 'delete', 'merge'])
const EXPLAIN_PREFIX = new Set(['explain', 'analyze', 'analyse', 'verbose'])

/**
 * The first statement verb that changes data or schema (`DELETE`, `DROP`, …),
 * or null for a read. Metabase runs native SQL with whatever rights its
 * connection has, so the editor asks before sending one of these.
 *
 * Only a statement's leading verb counts — or the verb right after a CTE list
 * (`WITH x AS (…) DELETE …`) — so `SELECT … FOR UPDATE`, a column called
 * `created_at`, strings and comments never trip it.
 */
export function writeVerb(sql: string): string | null {
  let depth = 0
  let atStart = true
  let inWith = false
  let prev = ''
  for (const tok of tokenize(sql)) {
    if (tok.t === 'ws' || tok.t === 'comment' || tok.t === 'tag') continue
    if (tok.t === 'punct') {
      if (tok.v === '(') depth++
      else if (tok.v === ')') depth = Math.max(0, depth - 1)
      else if (tok.v === ';' && depth === 0) {
        atStart = true
        inWith = false
      }
      prev = tok.v
      continue
    }
    if (tok.t !== 'word') {
      atStart = false
      prev = tok.v
      continue
    }
    const lw = tok.v.toLowerCase()
    if (atStart) {
      // `EXPLAIN ANALYZE DELETE …` executes the delete: look through the prefix.
      if (EXPLAIN_PREFIX.has(lw)) {
        prev = lw
        continue
      }
      atStart = false
      if (lw === 'with') inWith = true
      else if (WRITE_VERBS.has(lw)) return lw.toUpperCase()
    } else if (inWith && prev === '(' && CTE_DML.has(lw)) {
      // Data-modifying CTE: `WITH d AS (DELETE … RETURNING *) SELECT …`.
      return lw.toUpperCase()
    } else if (inWith && depth === 0 && prev === ')') {
      // `WITH a AS (…), b AS (…) <main statement>` — a comma would continue the list.
      if (WRITE_VERBS.has(lw)) return lw.toUpperCase()
      inWith = false
    }
    prev = lw
  }
  return null
}

const KEYWORDS = new Set(
  (
    'select from where group by order having limit offset join left right inner outer full cross on as and or not in is null ' +
    'like ilike between case when then else end distinct union all with insert into values update set delete create table ' +
    'view drop alter asc desc over partition count sum avg min max coalesce cast interval true false exists any filter ' +
    'lateral using natural window rows range preceding following current row nulls first last except intersect returning'
  ).split(' '),
)

/** Clauses that start on their own line. Multi-word ones are matched on their first word. */
const BREAK_BEFORE = new Set(['select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect', 'window', 'with'])
const JOIN_HEAD = new Set(['join', 'left', 'right', 'inner', 'full', 'cross', 'natural'])

/**
 * Upper-cases keywords and puts each top-level clause on its own line, with
 * select-list items and AND/OR conditions indented. Deliberately modest: it
 * never reorders tokens or touches literals, comments or Metabase tags, so the
 * query means exactly what it meant before.
 */
export function formatSql(sql: string): string {
  const toks = tokenize(sql).filter((t) => t.t !== 'ws' || /\n\s*\n/.test(t.v))
  let out = ''
  let depth = 0
  let clause = ''
  let prevWord = ''
  const nl = (indent = 0) => {
    out = out.replace(/[ \t]+$/, '')
    out += `\n${'  '.repeat(depth + indent)}`
  }
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]
    if (tok.t === 'ws') {
      // Preserve a deliberate blank line between statements.
      out = out.replace(/[ \t]+$/, '') + '\n\n'
      continue
    }
    if (tok.t === 'word') {
      const lw = tok.v.toLowerCase()
      const kw = KEYWORDS.has(lw)
      const word = kw ? tok.v.toUpperCase() : tok.v
      if (depth === 0 && BREAK_BEFORE.has(lw) && !(lw === 'all' && prevWord === 'union')) {
        if (out.trim()) nl()
        out += word
        clause = lw
      } else if (depth === 0 && JOIN_HEAD.has(lw) && !JOIN_HEAD.has(prevWord) && prevWord !== 'outer') {
        if (out.trim()) nl()
        out += word
      } else if (depth === 0 && (lw === 'and' || lw === 'or') && (clause === 'where' || clause === 'having') && prevWord !== 'between') {
        // An optional clause `[[AND …]]` starts its own line, brackets and all.
        const optional = /\[\[\s*$/.test(out)
        if (optional) out = out.replace(/\s*\[\[\s*$/, '')
        nl(1)
        out += (optional ? '[[' : '') + word
      } else {
        out += (needsSpace(out) ? ' ' : '') + word
      }
      if (depth === 0 && clause === 'select' && lw === 'select') nl(1)
      prevWord = lw
      continue
    }
    if (tok.t === 'punct') {
      if (tok.v === '(') {
        // `count(` hugs its function name; `IN (`, `AS (`, `, (` get a space.
        const fnCall = prevWord !== '' && !KEYWORDS.has(prevWord) || ['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'cast', 'filter', 'over'].includes(prevWord)
        out += (fnCall || !needsSpace(out) ? '' : ' ') + '('
        depth++
      } else if (tok.v === ')') {
        depth = Math.max(0, depth - 1)
        out = out.replace(/\s+$/, '') + ')'
      } else if (tok.v === ',') {
        out = out.replace(/\s+$/, '') + ','
        if (depth === 0 && clause === 'select') nl(1)
      } else if (tok.v === ';') {
        out = out.replace(/\s+$/, '') + ';'
        clause = ''
      } else {
        out += (needsSpace(out) && tok.v !== '.' ? ' ' : '') + tok.v
      }
      prevWord = ''
      continue
    }
    // strings, comments, tags
    if (tok.t === 'comment' && tok.v.startsWith('--')) {
      out += (needsSpace(out) ? ' ' : '') + tok.v
      nl()
      continue
    }
    out += (needsSpace(out) && tok.v !== ']]' ? ' ' : '') + tok.v
    prevWord = ''
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function needsSpace(out: string): boolean {
  return out.length > 0 && !/[\s(.]$/.test(out)
}

/* ─────────── errors ─────────── */

export interface ErrorPos {
  line: number
  column: number
}

/** Line/column of a database error, when the message says where. */
export function errorPosition(message: string, sql: string): ErrorPos | null {
  // Postgres / Redshift / Snowflake: "Position: 42" (1-based char offset).
  const p = /\bPosition: (\d+)/.exec(message)
  if (p) return offsetToPos(sql, Math.max(0, Number(p[1]) - 1))
  // "line 3:14", "line 3, column 14", "line 3 column 14", Snowflake's "line 3 at position 4" (0-based), "[3:14]".
  const lc = /\bline\s+(\d+)(?:\s*[:,]\s*(?:column\s+|col\s+)?(\d+)|\s+column\s+(\d+)|\s+at position\s+(\d+))?/i.exec(message)
  if (lc) return { line: Number(lc[1]), column: lc[4] != null ? Number(lc[4]) + 1 : Number(lc[2] ?? lc[3] ?? 1) }
  const br = /\[(\d+):(\d+)\]/.exec(message)
  if (br) return { line: Number(br[1]), column: Number(br[2]) }
  return null
}

export function offsetToPos(sql: string, offset: number): ErrorPos {
  const before = sql.slice(0, Math.min(offset, sql.length))
  const lines = before.split('\n')
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

/** The human message of a failed dataset (Metabase nests it in a few ways). */
export function datasetError(ds?: metabase.MbDataset | null): string | null {
  if (!ds) return null
  if (ds.status === 'failed' || ds.error) {
    const e = ds.error
    if (typeof e === 'string') return e
    if (e && typeof e === 'object' && e.message) return e.message
    return 'The query failed.'
  }
  return null
}

/* ─────────── history ─────────── */

export interface HistoryEntry {
  sql: string
  databaseId: number
  at: number
  ok: boolean
  rows?: number
  ms?: number
}

export interface KV {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

export const HISTORY_MAX = 50

export function historyKey(user: string | number | undefined): string {
  return `adhar.decide.sql-history.${user ?? 'anon'}`
}

export function loadHistory(store: KV | undefined, user: string | number | undefined): HistoryEntry[] {
  try {
    const raw = store?.getItem(historyKey(user))
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.sql === 'string') : []
  } catch {
    return []
  }
}

/** Newest first; a re-run of the same query against the same database moves it up instead of duplicating. */
export function pushHistory(list: HistoryEntry[], e: HistoryEntry): HistoryEntry[] {
  const rest = list.filter((x) => !(x.sql.trim() === e.sql.trim() && x.databaseId === e.databaseId))
  return [e, ...rest].slice(0, HISTORY_MAX)
}

export function saveHistory(store: KV | undefined, user: string | number | undefined, list: HistoryEntry[]): void {
  try {
    store?.setItem(historyKey(user), JSON.stringify(list))
  } catch {
    /* storage full or blocked — history is a convenience */
  }
}

/* ─────────── export ─────────── */

/**
 * RFC 4180 CSV. Text cells that a spreadsheet would execute as a formula
 * (`=`, `+`, `-`, `@` …) are prefixed with `'` — a query result is untrusted data.
 */
export function toCsv(cols: Pick<metabase.MbColumn, 'name' | 'display_name'>[], rows: metabase.MbCell[][]): string {
  const cell = (v: metabase.MbCell): string => {
    if (v == null) return ''
    let s = String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = cols.map((c) => cell(c.display_name ?? c.name)).join(',')
  return [head, ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n'
}

export function toJson(cols: Pick<metabase.MbColumn, 'name'>[], rows: metabase.MbCell[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i] ?? null]))), null, 2)
}

/** TSV for pasting into a spreadsheet. */
export function toTsv(cols: Pick<metabase.MbColumn, 'name' | 'display_name'>[] | null, rows: metabase.MbCell[][]): string {
  const cell = (v: metabase.MbCell) => (v == null ? '' : String(v).replace(/[\t\n\r]+/g, ' '))
  const lines = rows.map((r) => r.map(cell).join('\t'))
  return (cols ? [cols.map((c) => c.display_name ?? c.name).join('\t'), ...lines] : lines).join('\n')
}

export function safeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'export'
}
