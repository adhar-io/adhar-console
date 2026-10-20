/**
 * Pure deep-link + drill-down query helpers for Define's insights pages
 * (re-exported by `insights-nav.ts`; tested in `insights-nav_test.ts`).
 */

export interface DefineParams {
  /** Reports: which report. */
  report?: string
  /** Reports / dashboard: Plane cycle id. */
  cycle?: string
  /** Reports: Plane module (epic) id. */
  module?: string
  /** Reports: range in days. */
  range?: string
  /** Pages: open page id. */
  page?: string
  /** Pages: editor mode (`edit` | `history`). */
  mode?: string
  /** OKRs: quarter (`2026-Q4`). */
  quarter?: string
  /** OKRs: open objective id. */
  objective?: string
  /** My Work: tab. */
  tab?: string
  /** Issues: query. */
  q?: string
  /** Issues: open issue id (drawer). */
  issue?: string
  /** Active Plane project id. */
  project?: string
}

export function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = String(v)
  return out
}

export function decode(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw)
      if (typeof v === 'string') return v
    } catch { /* keep raw */ }
  }
  return raw
}

export function encode(v: string): string {
  try {
    JSON.parse(v)
    return JSON.stringify(v)
  } catch {
    return v
  }
}

/** Plain href for a Define section deep link. */
export function defineHref(section: string, params: DefineParams = {}): string {
  const qs = new URLSearchParams(Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)])).toString()
  return `/define${qs ? `?${qs}` : ''}`
}

/* ───── JQL-like drill-down queries ───── */

export interface JqlParts {
  project?: string
  assignee?: 'me' | 'EMPTY' | string
  reporter?: 'me' | string
  statusCategory?: string[]
  state?: string
  priority?: string[]
  label?: string
  cycle?: string
  module?: string
  due?: string
  created?: string
  resolved?: string
  key?: string
}

const quote = (v: string) => (/^[A-Za-z0-9_.+-]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`)
const opValue = (expr: string) => {
  const m = /^(<=|>=|<|>|=|!=)\s*(.+)$/.exec(expr.trim())
  return m ? `${m[1]} ${m[2]}` : `= ${expr}`
}

/** Build the Issues query string from parts (stable clause order). */
export function jql(p: JqlParts): string {
  const out: string[] = []
  if (p.project) out.push(`project = ${quote(p.project)}`)
  if (p.key) out.push(`key = ${quote(p.key)}`)
  if (p.assignee) out.push(`assignee = ${quote(p.assignee)}`)
  if (p.reporter) out.push(`creator = ${quote(p.reporter)}`)
  if (p.statusCategory?.length) {
    out.push(p.statusCategory.length === 1 ? `category = ${p.statusCategory[0]}` : `category in (${p.statusCategory.join(', ')})`)
  }
  if (p.state) out.push(`status = ${quote(p.state)}`)
  if (p.priority?.length) out.push(p.priority.length === 1 ? `priority = ${p.priority[0]}` : `priority in (${p.priority.join(', ')})`)
  if (p.label) out.push(`label = ${quote(p.label)}`)
  if (p.cycle) out.push(`sprint = ${quote(p.cycle)}`)
  if (p.module) out.push(`epic = ${quote(p.module)}`)
  if (p.due) out.push(`due ${opValue(p.due)}`)
  if (p.created) out.push(`created ${opValue(p.created)}`)
  if (p.resolved) out.push(`resolved ${opValue(p.resolved)}`)
  return out.join(' AND ')
}

export const OPEN_CATEGORIES = ['backlog', 'unstarted', 'started']

/** `/define?section=issues&q=…` for a drill-down. */
export function issuesHref(parts: JqlParts, projectId?: string): string {
  return defineHref('issues', { q: jql(parts), project: projectId })
}
