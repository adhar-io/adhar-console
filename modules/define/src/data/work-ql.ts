/**
 * WQL — the Define module's JQL-style work-item query language.
 *
 *   project = CON AND status in (Todo, "In Progress") AND assignee = me()
 *     AND label = bug ORDER BY priority, updated DESC
 *
 * Parsed here into an AST, then compiled against the loaded Plane metadata
 * (projects, states, labels, members, cycles, modules) into a client-side
 * predicate and comparator. Plane's public list endpoint ignores every filter
 * parameter, so ALL filtering happens in the browser; the parser also reports
 * which projects a query names so the page loads exactly those.
 *
 * Grammar (keywords case-insensitive):
 *   query   := or? (ORDER BY sort (',' sort)*)?
 *   or      := and (OR and)*
 *   and     := unary ((AND)? unary)*          — juxtaposition means AND
 *   unary   := NOT unary | '(' or ')' | clause | text
 *   clause  := field op value | field IN list | field NOT IN list | field IS [NOT] EMPTY
 *   op      := = | != | ~ | !~ | > | >= | < | <=
 *   value   := word | "quoted" | fn '(' ')' | relative date (-7d, +2w, -1m)
 *   text    := a bare word or "quoted phrase" — matches title, description, key
 *
 * Pure (no React, no fetch) so it is unit-tested in work-ql_test.ts.
 */

/* ───────────────────────────── fields ───────────────────────────── */

export type FieldName =
  | 'project'
  | 'status'
  | 'category'
  | 'assignee'
  | 'label'
  | 'priority'
  | 'epic'
  | 'sprint'
  | 'estimate'
  | 'due'
  | 'start'
  | 'created'
  | 'updated'
  | 'resolved'
  | 'text'
  | 'key'
  | 'parent'
  | 'creator'

export const FIELD_ALIASES: Record<string, FieldName> = {
  project: 'project',
  status: 'status',
  state: 'status',
  statuscategory: 'category',
  category: 'category',
  group: 'category',
  assignee: 'assignee',
  assignees: 'assignee',
  label: 'label',
  labels: 'label',
  priority: 'priority',
  epic: 'epic',
  module: 'epic',
  sprint: 'sprint',
  cycle: 'sprint',
  estimate: 'estimate',
  points: 'estimate',
  storypoints: 'estimate',
  due: 'due',
  duedate: 'due',
  target: 'due',
  start: 'start',
  startdate: 'start',
  created: 'created',
  updated: 'updated',
  resolved: 'resolved',
  text: 'text',
  summary: 'text',
  title: 'text',
  key: 'key',
  issue: 'key',
  parent: 'parent',
  creator: 'creator',
  reporter: 'creator',
}

/** Canonical field names with a one-line hint (autocomplete + help). */
export const FIELD_DOCS: Array<{ field: FieldName; hint: string }> = [
  { field: 'project', hint: 'Project key or name — project = CON' },
  { field: 'status', hint: 'Workflow state — status in (Todo, "In Progress")' },
  { field: 'category', hint: 'State group — backlog, unstarted, started, completed, cancelled' },
  { field: 'assignee', hint: 'Member name / email, me(), or EMPTY' },
  { field: 'label', hint: 'Label name — label = bug' },
  { field: 'priority', hint: 'urgent, high, medium, low, none' },
  { field: 'epic', hint: 'Plane module — epic = "Auth revamp"' },
  { field: 'sprint', hint: 'Plane cycle — sprint in openSprints()' },
  { field: 'estimate', hint: 'Estimate value — estimate >= 3' },
  { field: 'due', hint: 'Target date — due < now(), due <= +7d' },
  { field: 'start', hint: 'Start date' },
  { field: 'created', hint: 'Created — created >= -14d' },
  { field: 'updated', hint: 'Last updated — updated >= startOfWeek()' },
  { field: 'resolved', hint: 'Completed at — resolved >= -30d' },
  { field: 'text', hint: 'Title / description contains — text ~ "login"' },
  { field: 'key', hint: 'Work item key — key = CON-42' },
  { field: 'parent', hint: 'Parent key, or EMPTY for top-level items' },
  { field: 'creator', hint: 'Who created it (Plane records the API-key user for console-made items)' },
]

export type SortField = 'priority' | 'updated' | 'created' | 'due' | 'start' | 'estimate' | 'rank' | 'key' | 'status' | 'title'
export const SORT_ALIASES: Record<string, SortField> = {
  priority: 'priority',
  updated: 'updated',
  created: 'created',
  due: 'due',
  duedate: 'due',
  target: 'due',
  start: 'start',
  estimate: 'estimate',
  points: 'estimate',
  rank: 'rank',
  key: 'key',
  status: 'status',
  state: 'status',
  title: 'title',
  summary: 'title',
}

export const FUNCTIONS = [
  'me',
  'currentUser',
  'now',
  'today',
  'startOfWeek',
  'endOfWeek',
  'startOfMonth',
  'endOfMonth',
  'openSprints',
  'futureSprints',
  'closedSprints',
] as const

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'empty', 'null', 'order', 'by', 'asc', 'desc'])

/* ───────────────────────────── lexer ───────────────────────────── */

export type TokenType = 'word' | 'string' | 'op' | 'lparen' | 'rparen' | 'comma'
export interface Token {
  type: TokenType
  value: string
  start: number
  end: number
  /** A string token whose closing quote is missing (still being typed). */
  open?: boolean
}

export function lex(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ type: c === '(' ? 'lparen' : c === ')' ? 'rparen' : 'comma', value: c, start: i, end: i + 1 })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          v += src[j + 1]
          j += 2
          continue
        }
        v += src[j]
        j++
      }
      const closed = j < src.length
      out.push({ type: 'string', value: v, start: i, end: closed ? j + 1 : j, open: !closed })
      i = closed ? j + 1 : j
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '!=' || two === '!~' || two === '>=' || two === '<=') {
      out.push({ type: 'op', value: two, start: i, end: i + 2 })
      i += 2
      continue
    }
    if (c === '=' || c === '~' || c === '>' || c === '<') {
      out.push({ type: 'op', value: c, start: i, end: i + 1 })
      i++
      continue
    }
    let j = i
    while (j < src.length && !/[\s(),=!~<>"']/.test(src[j])) j++
    if (j === i) {
      // A lone `!` — keep it as a word so the parser reports it.
      j = i + 1
    }
    out.push({ type: 'word', value: src.slice(i, j), start: i, end: j })
    i = j
  }
  return out
}

/* ───────────────────────────── AST ───────────────────────────── */

export type Op = '=' | '!=' | '~' | '!~' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'is empty' | 'is not empty'

export type Value =
  | { kind: 'literal'; text: string; quoted?: boolean }
  | { kind: 'fn'; name: string }

export type Expr =
  | { kind: 'and'; items: Expr[] }
  | { kind: 'or'; items: Expr[] }
  | { kind: 'not'; item: Expr }
  | { kind: 'clause'; field: FieldName; op: Op; values: Value[]; start: number; end: number }
  | { kind: 'text'; value: string }

export interface OrderTerm {
  field: SortField
  dir: 'asc' | 'desc'
}

export interface QlError {
  message: string
  start: number
  end: number
}

export interface Parsed {
  expr?: Expr
  orderBy: OrderTerm[]
  errors: QlError[]
}

const isKw = (t: Token | undefined, kw: string) => t?.type === 'word' && t.value.toLowerCase() === kw

export function parse(src: string): Parsed {
  const toks = lex(src)
  let p = 0
  const errors: QlError[] = []
  const peek = () => toks[p]
  const next = () => toks[p++]
  const err = (message: string, t?: Token) => {
    const at = t ?? toks[toks.length - 1]
    errors.push({ message, start: at?.start ?? src.length, end: at?.end ?? src.length })
  }

  const atOrderBy = () => isKw(peek(), 'order') && isKw(toks[p + 1], 'by')
  const atEnd = () => p >= toks.length || atOrderBy()

  const parseValue = (): Value | undefined => {
    const t = next()
    if (!t) {
      err('Expected a value')
      return undefined
    }
    if (t.type === 'string') return { kind: 'literal', text: t.value, quoted: true }
    if (t.type === 'word') {
      if (peek()?.type === 'lparen' && toks[p + 1]?.type === 'rparen') {
        p += 2
        const fn = FUNCTIONS.find((f) => f.toLowerCase() === t.value.toLowerCase())
        if (!fn) err(`Unknown function ${t.value}()`, t)
        return { kind: 'fn', name: fn ?? t.value }
      }
      return { kind: 'literal', text: t.value }
    }
    err(`Expected a value, got "${t.value}"`, t)
    return undefined
  }

  const parseList = (): Value[] => {
    const out: Value[] = []
    if (peek()?.type !== 'lparen') {
      // `status in Todo` — accept a single value.
      const v = parseValue()
      return v ? [v] : []
    }
    next()
    while (p < toks.length && peek()?.type !== 'rparen') {
      const v = parseValue()
      if (v) out.push(v)
      if (peek()?.type === 'comma') next()
      else if (peek()?.type !== 'rparen') {
        err('Expected "," or ")" in the list', peek())
        break
      }
    }
    if (peek()?.type === 'rparen') next()
    else err('Missing ")"')
    return out
  }

  const parseClauseOrText = (): Expr | undefined => {
    const t = peek()
    if (!t) return undefined
    if (t.type === 'string') {
      next()
      return { kind: 'text', value: t.value }
    }
    if (t.type !== 'word') {
      err(`Unexpected "${t.value}"`, t)
      next()
      return undefined
    }
    const field = FIELD_ALIASES[t.value.toLowerCase()]
    const after = toks[p + 1]
    const looksLikeClause = after && (after.type === 'op' || isKw(after, 'in') || isKw(after, 'is') || (isKw(after, 'not') && isKw(toks[p + 2], 'in')))
    if (!looksLikeClause) {
      next()
      if (KEYWORDS.has(t.value.toLowerCase())) {
        err(`Unexpected keyword ${t.value.toUpperCase()}`, t)
        return undefined
      }
      return { kind: 'text', value: t.value }
    }
    next()
    if (!field) {
      err(`Unknown field "${t.value}"`, t)
    }
    const opTok = next()!
    let op: Op
    let values: Value[] = []
    if (opTok.type === 'op') {
      op = opTok.value as Op
      const v = parseValue()
      if (v) values = [v]
    } else if (isKw(opTok, 'in')) {
      op = 'in'
      values = parseList()
    } else if (isKw(opTok, 'not')) {
      next() // IN
      op = 'not in'
      values = parseList()
    } else {
      // IS [NOT] EMPTY|NULL
      const neg = isKw(peek(), 'not')
      if (neg) next()
      const e = next()
      if (!isKw(e, 'empty') && !isKw(e, 'null')) err('Expected EMPTY after IS', e ?? opTok)
      op = neg ? 'is not empty' : 'is empty'
    }
    if (!field) return undefined
    const end = toks[p - 1]?.end ?? t.end
    return { kind: 'clause', field, op, values, start: t.start, end }
  }

  // deno-lint-ignore prefer-const
  let parseOr: () => Expr | undefined

  const parseUnary = (): Expr | undefined => {
    const t = peek()
    if (!t) return undefined
    if (isKw(t, 'not') && !(toks[p + 1] && isKw(toks[p + 1], 'in'))) {
      next()
      const inner = parseUnary()
      return inner ? { kind: 'not', item: inner } : undefined
    }
    if (t.type === 'lparen') {
      next()
      const inner = parseOr()
      if (peek()?.type === 'rparen') next()
      else err('Missing ")"')
      return inner
    }
    return parseClauseOrText()
  }

  const parseAnd = (): Expr | undefined => {
    const items: Expr[] = []
    while (!atEnd()) {
      const t = peek()
      if (t?.type === 'rparen' || isKw(t, 'or')) break
      if (isKw(t, 'and')) {
        next()
        continue
      }
      const before = p
      const e = parseUnary()
      if (e) items.push(e)
      if (p === before) next() // never spin
    }
    if (!items.length) return undefined
    return items.length === 1 ? items[0] : { kind: 'and', items }
  }

  parseOr = (): Expr | undefined => {
    const items: Expr[] = []
    const first = parseAnd()
    if (first) items.push(first)
    while (isKw(peek(), 'or')) {
      next()
      const e = parseAnd()
      if (e) items.push(e)
      else err('Expected a condition after OR')
    }
    if (!items.length) return undefined
    return items.length === 1 ? items[0] : { kind: 'or', items }
  }

  let expr: Expr | undefined
  while (p < toks.length && !atOrderBy()) {
    const before = p
    const e = parseOr()
    if (e) expr = expr ? { kind: 'and', items: [expr, e] } : e
    if (peek()?.type === 'rparen') {
      err('Unbalanced ")"', peek())
      next()
    }
    if (p === before) next()
  }

  const orderBy: OrderTerm[] = []
  if (atOrderBy()) {
    p += 2
    while (p < toks.length) {
      const t = next()!
      const f = t.type === 'word' ? SORT_ALIASES[t.value.toLowerCase()] : undefined
      if (!f) {
        err(`Can't sort by "${t.value}"`, t)
      }
      let dir: 'asc' | 'desc' = 'asc'
      if (isKw(peek(), 'asc') || isKw(peek(), 'desc')) dir = next()!.value.toLowerCase() as 'asc' | 'desc'
      if (f) orderBy.push({ field: f, dir })
      if (peek()?.type === 'comma') next()
      else if (p < toks.length) {
        err('Expected "," between sort fields', peek())
        break
      }
    }
    if (!orderBy.length && !errors.length) err('ORDER BY needs a field')
  }
  return { expr, orderBy, errors }
}

/* ───────────────────────────── compile ───────────────────────────── */

export interface QlIssue {
  id: string
  name: string
  project: string
  state: string
  priority: string
  assignees: string[]
  labels: string[]
  sequence_id?: number
  estimate_point?: number | null
  start_date?: string | null
  target_date?: string | null
  created_at: string
  updated_at?: string
  completed_at?: string | null
  parent?: string | null
  cycle?: string | null
  module?: string | null
  created_by?: string
  description_stripped?: string
  sort_order?: number
}

export interface QlContext {
  projects: Array<{ id: string; identifier: string; name: string }>
  states: Array<{ id: string; name: string; group: string; project: string; sequence?: number }>
  labels: Array<{ id: string; name: string; project?: string }>
  members: Array<{ id: string; name: string; email?: string }>
  cycles: Array<{ id: string; name: string; status?: string; project?: string }>
  modules: Array<{ id: string; name: string; project?: string }>
  /** Plane user id of the signed-in console user, when their email matches a member. */
  me?: string
  now?: number
  /** `CON-42` → issue id for `parent = CON-42` (optional). */
  idByKey?: Map<string, string>
}

export interface Compiled {
  predicate(issue: QlIssue): boolean
  compare(a: QlIssue, b: QlIssue): number
  /** Problems that do not stop the query (unknown names, me() unmapped). */
  warnings: string[]
  errors: QlError[]
  /** Project ids the query names positively; null → use the page's project. */
  projectIds: string[] | null
  /** Free-text terms (for Plane search across projects). */
  textTerms: string[]
}

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none']
const GROUP_ORDER = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']
const CATEGORY_ALIASES: Record<string, string> = {
  backlog: 'backlog',
  unstarted: 'unstarted',
  todo: 'unstarted',
  'to do': 'unstarted',
  started: 'started',
  'in progress': 'started',
  inprogress: 'started',
  completed: 'completed',
  done: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}

const DAY = 86_400_000

/** Resolve a date literal / function / relative offset to epoch ms (start of day for dates). */
export function resolveDate(v: Value, now: number): number | undefined {
  if (v.kind === 'fn') {
    const d = new Date(now)
    const startOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
    switch (v.name) {
      case 'now':
        return now
      case 'today':
        return startOfDay
      case 'startOfWeek':
        return startOfDay - dow * DAY
      case 'endOfWeek':
        return startOfDay + (7 - dow) * DAY - 1
      case 'startOfMonth':
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
      case 'endOfMonth':
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1
    }
    return undefined
  }
  const t = v.text.trim()
  const rel = /^([+-]?)(\d+)([dwmh])$/i.exec(t)
  if (rel) {
    const n = Number(rel[2]) * (rel[1] === '-' ? -1 : 1)
    const unit = rel[3].toLowerCase()
    const ms = unit === 'h' ? 3_600_000 : unit === 'd' ? DAY : unit === 'w' ? 7 * DAY : 30 * DAY
    return now + n * ms
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00Z`)
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : undefined
}

const lc = (s: string | undefined | null) => (s ?? '').toLowerCase()
const parseMs = (s?: string | null) => {
  if (!s) return undefined
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)
  return Number.isFinite(ms) ? ms : undefined
}

/** Human key for an issue — `CON-42`. */
export function issueKey(issue: { project: string; sequence_id?: number }, projects: QlContext['projects']): string {
  const p = projects.find((x) => x.id === issue.project)
  return p && issue.sequence_id != null ? `${p.identifier}-${issue.sequence_id}` : `#${issue.sequence_id ?? '?'}`
}

export function compile(src: string, ctx: QlContext): Compiled {
  const parsed = parse(src)
  const now = ctx.now ?? Date.now()
  const warnings: string[] = []
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m)
  }
  const projectIds = new Set<string>()
  const textTerms: string[] = []

  const stateById = new Map(ctx.states.map((s) => [s.id, s]))

  const resolveIds = (field: FieldName, v: Value): Set<string> | 'empty' => {
    const out = new Set<string>()
    if (v.kind === 'literal' && !v.quoted && (lc(v.text) === 'empty' || lc(v.text) === 'null')) return 'empty'
    const text = v.kind === 'literal' ? lc(v.text) : ''
    switch (field) {
      case 'project': {
        for (const p of ctx.projects) if (lc(p.identifier) === text || lc(p.name) === text || p.id === text) out.add(p.id)
        if (!out.size) warn(`No project "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'status': {
        for (const s of ctx.states) if (lc(s.name) === text || s.id === text) out.add(s.id)
        if (!out.size) warn(`No status named "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'category': {
        const g = CATEGORY_ALIASES[text]
        if (!g) warn(`Unknown status category "${v.kind === 'literal' ? v.text : ''}" — use backlog, unstarted, started, completed or cancelled`)
        else out.add(g)
        return out
      }
      case 'assignee':
      case 'creator': {
        // `assignee = me` (unquoted) reads as me(), the way the brief and Jira users write it.
        const isMe = (v.kind === 'fn' && (v.name === 'me' || v.name === 'currentUser')) || (v.kind === 'literal' && !v.quoted && lc(v.text) === 'me')
        if (isMe) {
          if (ctx.me) out.add(ctx.me)
          else warn("me() matches nobody — your console account's email isn't a Plane member")
          return out
        }
        for (const m of ctx.members) {
          if (lc(m.name) === text || lc(m.email) === text || lc(m.email?.split('@')[0]) === text || m.id === text) out.add(m.id)
        }
        if (!out.size) warn(`No member "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'label': {
        for (const l of ctx.labels) if (lc(l.name) === text || l.id === text) out.add(l.id)
        if (!out.size) warn(`No label "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'priority': {
        if (PRIORITY_ORDER.includes(text)) out.add(text)
        else warn(`Unknown priority "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'epic': {
        for (const m of ctx.modules) if (lc(m.name) === text || m.id === text) out.add(m.id)
        if (!out.size) warn(`No epic (module) "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'sprint': {
        if (v.kind === 'fn') {
          const want = v.name === 'openSprints' ? 'current' : v.name === 'futureSprints' ? 'upcoming' : v.name === 'closedSprints' ? 'completed' : ''
          for (const c of ctx.cycles) if (c.status === want) out.add(c.id)
          return out
        }
        for (const c of ctx.cycles) if (lc(c.name) === text || c.id === text) out.add(c.id)
        if (!out.size) warn(`No sprint (cycle) "${v.kind === 'literal' ? v.text : ''}"`)
        return out
      }
      case 'key':
      case 'parent': {
        const raw = v.kind === 'literal' ? v.text.trim().toUpperCase() : ''
        const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(raw)
        if (m) out.add(`${m[1]}-${m[2]}`)
        else if (/^\d+$/.test(raw)) out.add(`#${raw}`)
        else warn(`"${raw}" is not a key like CON-42`)
        return out
      }
      default:
        return out
    }
  }

  const keyOf = (i: QlIssue) => issueKey(i, ctx.projects)

  const valueOf = (field: FieldName, i: QlIssue): number | undefined => {
    switch (field) {
      case 'estimate':
        return i.estimate_point ?? undefined
      case 'due':
        return parseMs(i.target_date)
      case 'start':
        return parseMs(i.start_date)
      case 'created':
        return parseMs(i.created_at)
      case 'updated':
        return parseMs(i.updated_at ?? i.created_at)
      case 'resolved':
        return parseMs(i.completed_at)
      case 'priority':
        return PRIORITY_ORDER.length - PRIORITY_ORDER.indexOf(i.priority)
    }
    return undefined
  }

  type Pred = (i: QlIssue) => boolean

  const multi = (i: QlIssue, field: FieldName): string[] => {
    switch (field) {
      case 'project':
        return [i.project]
      case 'status':
        return [i.state]
      case 'category':
        return [stateById.get(i.state)?.group ?? '']
      case 'assignee':
        return i.assignees
      case 'creator':
        return i.created_by ? [i.created_by] : []
      case 'label':
        return i.labels
      case 'priority':
        return [i.priority]
      case 'epic':
        return i.module ? [i.module] : []
      case 'sprint':
        return i.cycle ? [i.cycle] : []
      case 'key': {
        const k = keyOf(i)
        return [k, `#${i.sequence_id ?? ''}`]
      }
      case 'parent': {
        if (!i.parent) return []
        const out = [i.parent]
        if (ctx.idByKey) for (const [k, id] of ctx.idByKey) if (id === i.parent) out.push(k)
        return out
      }
    }
    return []
  }

  const isEmpty = (field: FieldName, i: QlIssue): boolean => {
    if (['estimate', 'due', 'start', 'resolved'].includes(field)) return valueOf(field, i) === undefined
    if (field === 'priority') return i.priority === 'none'
    if (field === 'text') return !i.description_stripped
    return multi(i, field).length === 0
  }

  const textMatch = (i: QlIssue, needle: string) => {
    const n = lc(needle)
    return lc(i.name).includes(n) || lc(i.description_stripped).includes(n) || lc(keyOf(i)) === n
  }

  const compileExpr = (e: Expr, positive: boolean): Pred => {
    switch (e.kind) {
      case 'and': {
        const ps = e.items.map((x) => compileExpr(x, positive))
        return (i) => ps.every((p) => p(i))
      }
      case 'or': {
        const ps = e.items.map((x) => compileExpr(x, positive))
        return (i) => ps.some((p) => p(i))
      }
      case 'not': {
        const p = compileExpr(e.item, !positive)
        return (i) => !p(i)
      }
      case 'text':
        textTerms.push(e.value)
        return (i) => textMatch(i, e.value)
      case 'clause':
        return compileClause(e, positive)
    }
  }

  const compileClause = (c: Extract<Expr, { kind: 'clause' }>, positive: boolean): Pred => {
    const { field, op, values } = c
    if (op === 'is empty') return (i) => isEmpty(field, i)
    if (op === 'is not empty') return (i) => !isEmpty(field, i)

    if (field === 'text') {
      const needle = values[0]?.kind === 'literal' ? values[0].text : ''
      if (op === '~' || op === '=') {
        textTerms.push(needle)
        return (i) => textMatch(i, needle)
      }
      if (op === '!~' || op === '!=') return (i) => !textMatch(i, needle)
      warn('text supports ~ and !~')
      return () => true
    }

    const ordered = ['estimate', 'due', 'start', 'created', 'updated', 'resolved'].includes(field)
    const priorityRange = field === 'priority' && ['>', '>=', '<', '<='].includes(op)
    if ((ordered && ['>', '>=', '<', '<=', '=', '!='].includes(op)) || priorityRange) {
      const v = values[0]
      let target: number | undefined
      if (!v) return () => false
      if (field === 'estimate') target = v.kind === 'literal' ? Number(v.text) : undefined
      else if (field === 'priority') {
        const idx = PRIORITY_ORDER.indexOf(lc(v.kind === 'literal' ? v.text : ''))
        target = idx < 0 ? undefined : PRIORITY_ORDER.length - idx
      } else target = resolveDate(v, now)
      if (target === undefined || !Number.isFinite(target)) {
        warn(`Can't read "${v.kind === 'literal' ? v.text : `${v.name}()`}" as a ${field === 'estimate' ? 'number' : field === 'priority' ? 'priority' : 'date'}`)
        return () => false
      }
      const t = target
      const isDay = field !== 'estimate' && field !== 'priority' && v.kind === 'literal' && /^\d{4}-\d{2}-\d{2}$/.test(v.text.trim())
      return (i) => {
        const x = valueOf(field, i)
        if (x === undefined) return op === '!='
        if (op === '=' || op === '!=') {
          const eq = isDay ? x >= t && x < t + DAY : x === t
          return op === '=' ? eq : !eq
        }
        switch (op) {
          case '>':
            return isDay ? x >= t + DAY : x > t
          case '>=':
            return x >= t
          case '<':
            return x < t
          case '<=':
            return isDay ? x < t + DAY : x <= t
        }
        return false
      }
    }

    // Set membership (=, !=, in, not in, ~ treated as =).
    const wanted = new Set<string>()
    let wantsEmpty = false
    for (const v of values) {
      const r = resolveIds(field, v)
      if (r === 'empty') wantsEmpty = true
      else for (const id of r) wanted.add(id)
    }
    const negate = op === '!=' || op === 'not in' || op === '!~'
    if (field === 'project' && positive && !negate) for (const id of wanted) projectIds.add(id)
    const hit = (i: QlIssue) => {
      const vals = multi(i, field)
      if (wantsEmpty && vals.length === 0) return true
      return vals.some((x) => wanted.has(x))
    }
    return negate ? (i) => !hit(i) : hit
  }

  let predicate: Pred = () => true
  if (parsed.expr) predicate = compileExpr(parsed.expr, true)

  const order = parsed.orderBy
  const sortValue = (f: SortField, i: QlIssue): number | string | undefined => {
    switch (f) {
      case 'priority':
        return PRIORITY_ORDER.indexOf(i.priority)
      case 'updated':
        return parseMs(i.updated_at ?? i.created_at)
      case 'created':
        return parseMs(i.created_at)
      case 'due':
        return parseMs(i.target_date)
      case 'start':
        return parseMs(i.start_date)
      case 'estimate':
        return i.estimate_point ?? undefined
      case 'rank':
        return i.sort_order ?? undefined
      case 'key': {
        // Project key first, then the number — so CON-2 < CON-10 < OPS-1.
        if (i.sequence_id == null) return undefined
        const ident = ctx.projects.find((p) => p.id === i.project)?.identifier ?? i.project
        return `${ident}\u0000${String(i.sequence_id).padStart(10, '0')}`
      }
      case 'status': {
        const s = stateById.get(i.state)
        return s ? GROUP_ORDER.indexOf(s.group) * 10_000 + (s.sequence ?? 0) : undefined
      }
      case 'title':
        return lc(i.name)
    }
  }
  const compare = (a: QlIssue, b: QlIssue) => {
    for (const t of order) {
      const x = sortValue(t.field, a)
      const y = sortValue(t.field, b)
      if (x === y) continue
      // Missing values always sink, whatever the direction.
      if (x === undefined) return 1
      if (y === undefined) return -1
      const d = x < y ? -1 : 1
      return t.dir === 'desc' ? -d : d
    }
    return 0
  }

  return {
    predicate,
    compare,
    warnings,
    errors: parsed.errors,
    projectIds: projectIds.size ? [...projectIds] : null,
    textTerms,
  }
}

/* ───────────────────────────── text helpers ───────────────────────────── */

/** Split `… ORDER BY …` into its filter and sort parts (sort text without the keywords). */
export function splitOrderBy(src: string): { where: string; orderBy: string } {
  const toks = lex(src)
  for (let i = 0; i < toks.length - 1; i++) {
    if (isKw(toks[i], 'order') && isKw(toks[i + 1], 'by')) {
      return { where: src.slice(0, toks[i].start).trim(), orderBy: src.slice(toks[i + 1].end).trim() }
    }
  }
  return { where: src.trim(), orderBy: '' }
}

/** Join a base query with extra conditions (quick filters), keeping its ORDER BY. */
export function andQuery(base: string, extra: string[]): string {
  const { where, orderBy } = splitOrderBy(base)
  const parts = [where, ...extra].map((s) => s.trim()).filter(Boolean)
  const body = parts.length > 1 ? parts.map((p) => (needsParens(p) ? `(${p})` : p)).join(' AND ') : parts[0] ?? ''
  return orderBy ? `${body}${body ? ' ' : ''}ORDER BY ${orderBy}` : body
}

function needsParens(q: string): boolean {
  return lex(q).some((t) => isKw(t, 'or'))
}

/** Replace the ORDER BY clause (header click → `ORDER BY due DESC`). */
export function setOrderBy(src: string, field: SortField | null, dir: 'asc' | 'desc' = 'asc'): string {
  const { where } = splitOrderBy(src)
  if (!field) return where
  return `${where}${where ? ' ' : ''}ORDER BY ${field}${dir === 'desc' ? ' DESC' : ''}`
}

/** Quote a value when it is not a bare word. */
export function quoteValue(v: string): string {
  return /^[A-Za-z0-9_.@+-]+$/.test(v) && !KEYWORDS.has(v.toLowerCase()) ? v : `"${v.replace(/"/g, '\\"')}"`
}

/* ───────────────────────────── autocomplete ───────────────────────────── */

export interface Suggestion {
  label: string
  insert: string
  kind: 'field' | 'operator' | 'value' | 'keyword' | 'function' | 'sort'
  detail?: string
}

export interface Suggestions {
  from: number
  to: number
  items: Suggestion[]
}

type Expect = 'field' | 'operator' | 'value' | 'list-value' | 'after-value' | 'sort-field' | 'after-sort'

/** Values offered after `field op`, from the loaded metadata. */
function valuesFor(field: FieldName | undefined, ctx: QlContext): Suggestion[] {
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
  const vals = (xs: string[], detail?: string): Suggestion[] => uniq(xs).map((x) => ({ label: x, insert: quoteValue(x), kind: 'value' as const, detail }))
  const fns = (xs: string[]): Suggestion[] => xs.map((f) => ({ label: `${f}()`, insert: `${f}()`, kind: 'function' as const }))
  switch (field) {
    case 'project':
      return vals(ctx.projects.map((p) => p.identifier), 'project')
    case 'status':
      return vals(ctx.states.map((s) => s.name), 'status')
    case 'category':
      return vals(['backlog', 'unstarted', 'started', 'completed', 'cancelled'])
    case 'assignee':
    case 'creator':
      return [...fns(['me']), ...vals(ctx.members.map((m) => m.name), 'member'), { label: 'EMPTY', insert: 'EMPTY', kind: 'keyword' }]
    case 'label':
      return [...vals(ctx.labels.map((l) => l.name), 'label'), { label: 'EMPTY', insert: 'EMPTY', kind: 'keyword' }]
    case 'priority':
      return vals(PRIORITY_ORDER)
    case 'epic':
      return [...vals(ctx.modules.map((m) => m.name), 'epic'), { label: 'EMPTY', insert: 'EMPTY', kind: 'keyword' }]
    case 'sprint':
      return [...fns(['openSprints', 'futureSprints', 'closedSprints']), ...vals(ctx.cycles.map((c) => c.name), 'sprint'), { label: 'EMPTY', insert: 'EMPTY', kind: 'keyword' }]
    case 'due':
    case 'start':
    case 'created':
    case 'updated':
    case 'resolved':
      return [...fns(['now', 'today', 'startOfWeek', 'endOfWeek', 'startOfMonth', 'endOfMonth']), ...vals(['-7d', '-14d', '-30d', '+7d'])]
    case 'parent':
      return [{ label: 'EMPTY', insert: 'EMPTY', kind: 'keyword' }]
  }
  return []
}

const OPERATORS: Record<string, string[]> = {
  set: ['=', '!=', 'in', 'not in', 'is empty', 'is not empty'],
  ordered: ['=', '!=', '>', '>=', '<', '<=', 'is empty', 'is not empty'],
  text: ['~', '!~'],
}
function operatorsFor(field: FieldName | undefined): string[] {
  if (field === 'text') return OPERATORS.text
  if (field && ['estimate', 'due', 'start', 'created', 'updated', 'resolved'].includes(field)) return OPERATORS.ordered
  if (field === 'priority') return [...OPERATORS.set, '>', '<']
  return OPERATORS.set
}

/**
 * What can come at `cursor`: the partial word being typed (replaced by the
 * pick) and the candidates, filtered by that prefix.
 */
export function suggest(src: string, cursor: number, ctx: QlContext): Suggestions {
  const before = src.slice(0, cursor)
  const toks = lex(before)
  // The token under the cursor (no whitespace after it) is the prefix.
  let partial: Token | undefined
  const last = toks[toks.length - 1]
  if (last && last.end === before.length && (last.type === 'word' || (last.type === 'string' && last.open))) {
    partial = last
    toks.pop()
  }
  const prefix = partial ? (partial.type === 'string' ? partial.value : partial.value) : ''
  const from = partial ? partial.start : cursor
  // Extend `to` over the rest of the word after the cursor.
  let to = cursor
  while (to < src.length && !/[\s(),=!~<>"']/.test(src[to])) to++

  let expect: Expect = 'field'
  let field: FieldName | undefined
  let listDepth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const v = t.value.toLowerCase()
    if (expect === 'sort-field' || expect === 'after-sort') {
      if (t.type === 'comma') expect = 'sort-field'
      else if (t.type === 'word' && (v === 'asc' || v === 'desc')) expect = 'after-sort'
      else if (t.type === 'word') expect = 'after-sort'
      continue
    }
    if (t.type === 'word' && v === 'order' && isKw(toks[i + 1], 'by')) {
      i++
      expect = 'sort-field'
      continue
    }
    switch (expect) {
      case 'field':
        if (t.type === 'lparen') continue
        if (t.type === 'word' && v === 'not') continue
        if (t.type === 'word') {
          field = FIELD_ALIASES[v]
          expect = field ? 'operator' : 'after-value'
        } else if (t.type === 'string') expect = 'after-value'
        break
      case 'operator':
        if (t.type === 'op') expect = 'value'
        else if (v === 'in') {
          expect = 'list-value'
          listDepth = 0
        }
        else if (v === 'not') {
          /* NOT IN — wait for IN */
        } else if (v === 'is') {
          expect = 'value'
        } else expect = 'after-value'
        break
      case 'value':
        if (t.type === 'word' && (v === 'not' || v === 'empty' || v === 'null')) {
          if (v !== 'not') expect = 'after-value'
          continue
        }
        if (t.type === 'lparen') continue // fn call parens
        if (t.type === 'rparen') {
          expect = 'after-value'
          continue
        }
        expect = toks[i + 1]?.type === 'lparen' ? 'value' : 'after-value'
        break
      case 'list-value':
        if (t.type === 'lparen') {
          listDepth++
          continue
        }
        if (t.type === 'comma') continue
        if (t.type === 'rparen') {
          listDepth--
          if (listDepth <= 0) expect = 'after-value'
          continue
        }
        if (listDepth <= 0) expect = 'after-value'
        break
      case 'after-value':
        if (t.type === 'rparen') continue
        if (t.type === 'word' && (v === 'and' || v === 'or')) {
          expect = 'field'
          field = undefined
        } else if (t.type === 'word') {
          // juxtaposed clause start
          field = FIELD_ALIASES[v]
          expect = field ? 'operator' : 'after-value'
        }
        break
    }
  }

  let items: Suggestion[] = []
  switch (expect) {
    case 'field':
      items = [
        ...FIELD_DOCS.map((f) => ({ label: f.field, insert: f.field, kind: 'field' as const, detail: f.hint })),
        { label: 'NOT', insert: 'NOT', kind: 'keyword' },
      ]
      break
    case 'operator':
      items = operatorsFor(field).map((o) => ({ label: o, insert: o.toUpperCase() === o ? o : o.toUpperCase(), kind: 'operator' as const }))
      break
    case 'value':
    case 'list-value':
      items = valuesFor(field, ctx)
      if (expect === 'list-value' && listDepth <= 0 && !partial) items = items.map((s) => ({ ...s, insert: `(${s.insert}` }))
      break
    case 'after-value':
      items = [
        { label: 'AND', insert: 'AND', kind: 'keyword' },
        { label: 'OR', insert: 'OR', kind: 'keyword' },
        { label: 'ORDER BY', insert: 'ORDER BY', kind: 'keyword' },
      ]
      break
    case 'sort-field':
      items = (['priority', 'updated', 'created', 'due', 'estimate', 'rank', 'key', 'status', 'title'] as SortField[]).map((f) => ({ label: f, insert: f, kind: 'sort' as const }))
      break
    case 'after-sort':
      items = [
        { label: 'ASC', insert: 'ASC', kind: 'keyword' },
        { label: 'DESC', insert: 'DESC', kind: 'keyword' },
      ]
      break
  }

  const p = prefix.toLowerCase()
  if (p) {
    const starts = items.filter((s) => s.label.toLowerCase().startsWith(p))
    const contains = items.filter((s) => !s.label.toLowerCase().startsWith(p) && s.label.toLowerCase().includes(p))
    items = [...starts, ...contains]
    // An exact, complete match offers nothing new.
    if (items.length === 1 && items[0].label.toLowerCase() === p) items = []
  }
  return { from, to: Math.max(to, cursor), items: items.slice(0, 40) }
}
