import type * as metabase from './mb-types.ts'

/**
 * Parameters, both kinds Metabase has:
 *
 *  • native-SQL variables — `{{name}}` in the query text, optionally wrapped in
 *    `[[ … ]]` so the clause drops out when the value is empty. Metabase needs
 *    each one declared as a *template tag* next to the query and a *parameter
 *    value* targeting it, or it rejects the query outright.
 *  • dashboard filters — declared on the dashboard and wired to each card by
 *    the dashcard's `parameter_mappings`. A filter only reaches the cards it is
 *    mapped to; sending it to the others is an error in Metabase.
 *
 * Pure functions; the views own the state.
 */

export type VarType = 'text' | 'number' | 'date'

export interface SqlVariable {
  /** Template-tag key exactly as Metabase expects it (`n`, `snippet: x`, `#12`). */
  key: string
  /** Display / input name. */
  name: string
  kind: 'variable' | 'snippet' | 'card'
  /** Inside a `[[ … ]]` optional clause. */
  optional: boolean
}

const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Every `{{…}}` in the query, in first-seen order, de-duplicated. */
export function parseSqlVariables(sql: string): SqlVariable[] {
  const out: SqlVariable[] = []
  const seen = new Map<string, SqlVariable>()
  for (const m of sql.matchAll(TAG_RE)) {
    const raw = m[1].trim()
    const optional = insideOptional(sql, m.index ?? 0)
    let v: SqlVariable
    if (/^snippet\s*:/i.test(raw)) {
      const name = raw.replace(/^snippet\s*:\s*/i, '').trim()
      v = { key: `snippet: ${name}`, name, kind: 'snippet', optional }
    } else if (/^#\d+/.test(raw)) {
      v = { key: raw, name: raw, kind: 'card', optional }
    } else if (/^[A-Za-z_][\w]*$/.test(raw)) {
      v = { key: raw, name: raw, kind: 'variable', optional }
    } else {
      continue
    }
    const prev = seen.get(v.key)
    if (prev) {
      // Required anywhere means required.
      prev.optional = prev.optional && v.optional
      continue
    }
    seen.set(v.key, v)
    out.push(v)
  }
  return out
}

/** Is `index` between an unclosed `[[` and its `]]`? */
function insideOptional(sql: string, index: number): boolean {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (sql[i] === '[' && sql[i + 1] === '[') {
      depth++
      i++
    } else if (sql[i] === ']' && sql[i + 1] === ']') {
      depth = Math.max(0, depth - 1)
      i++
    }
  }
  return depth > 0
}

/** A stable-enough id for a new template tag (Metabase wants a UUID-ish string). */
export function tagId(seed: string): string {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  const hex = (h >>> 0).toString(16).padStart(8, '0')
  return `${hex}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex.slice(4, 7)}-${hex}${hex.slice(0, 4)}`
}

/**
 * The `template-tags` map for a query. Ids are kept from `prev` when a tag
 * already existed so a saved question's tags keep their identity.
 */
export function buildTemplateTags(
  vars: SqlVariable[],
  types: Record<string, VarType>,
  opts: { prev?: Record<string, metabase.MbTemplateTag>; snippets?: metabase.MbSnippet[] } = {},
): Record<string, metabase.MbTemplateTag> {
  const out: Record<string, metabase.MbTemplateTag> = {}
  for (const v of vars) {
    const id = opts.prev?.[v.key]?.id ?? tagId(v.key)
    if (v.kind === 'snippet') {
      const sn = opts.snippets?.find((s) => s.name === v.name)
      out[v.key] = {
        id,
        name: v.key,
        'display-name': v.name,
        type: 'snippet',
        'snippet-name': v.name,
        ...(sn ? { 'snippet-id': sn.id } : {}),
      }
    } else if (v.kind === 'card') {
      const cardId = Number(v.key.slice(1).split('-')[0])
      out[v.key] = { id, name: v.key, 'display-name': v.key, type: 'card', 'card-id': cardId } as metabase.MbTemplateTag
    } else {
      out[v.key] = {
        id,
        name: v.key,
        'display-name': humanize(v.name),
        type: types[v.key] ?? opts.prev?.[v.key]?.type ?? 'text',
        required: false,
      }
    }
  }
  return out
}

/** Parameter values for the variables that have one. Empty optionals are omitted. */
export function buildParameterValues(
  vars: SqlVariable[],
  values: Record<string, string>,
  types: Record<string, VarType>,
): metabase.MbParameterValue[] {
  const out: metabase.MbParameterValue[] = []
  for (const v of vars) {
    if (v.kind !== 'variable') continue
    const raw = (values[v.key] ?? '').trim()
    if (!raw) continue
    const t = types[v.key] ?? 'text'
    out.push({
      type: t === 'number' ? 'number/=' : t === 'date' ? 'date/single' : 'category',
      value: t === 'number' ? Number(raw) : raw,
      target: ['variable', ['template-tag', v.key]],
    })
  }
  return out
}

/** Required variables (outside `[[ ]]`) that have no value yet. */
export function missingRequired(vars: SqlVariable[], values: Record<string, string>): string[] {
  return vars.filter((v) => v.kind === 'variable' && !v.optional && !(values[v.key] ?? '').trim()).map((v) => v.key)
}

/** A number variable whose value doesn't parse. */
export function invalidNumbers(vars: SqlVariable[], values: Record<string, string>, types: Record<string, VarType>): string[] {
  return vars
    .filter((v) => types[v.key] === 'number' && (values[v.key] ?? '').trim() !== '' && !Number.isFinite(Number(values[v.key])))
    .map((v) => v.key)
}

export function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* ─────────── dashboard filters ─────────── */

export type FilterWidget = 'text' | 'number' | 'date-single' | 'date-range' | 'date-relative' | 'date-month' | 'id'

export function filterWidget(type: string): FilterWidget {
  if (type === 'date/single') return 'date-single'
  if (type === 'date/range') return 'date-range'
  if (type === 'date/month-year') return 'date-month'
  if (type.startsWith('date/')) return 'date-relative'
  if (type.startsWith('number/')) return 'number'
  if (type === 'id') return 'id'
  return 'text'
}

/** The common relative-date tokens Metabase accepts. */
export const RELATIVE_DATES: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'past7days', label: 'Past 7 days' },
  { value: 'past30days', label: 'Past 30 days' },
  { value: 'past3months', label: 'Past 3 months' },
  { value: 'past12months', label: 'Past 12 months' },
  { value: 'thisweek', label: 'This week' },
  { value: 'thismonth', label: 'This month' },
  { value: 'thisquarter', label: 'This quarter' },
  { value: 'thisyear', label: 'This year' },
  { value: 'lastmonth', label: 'Last month' },
  { value: 'lastyear', label: 'Last year' },
]

/** UI string → the value shape Metabase wants for that filter type. */
export function encodeFilterValue(type: string, raw: string): unknown {
  const s = raw.trim()
  if (!s) return null
  const w = filterWidget(type)
  if (w.startsWith('date')) return s
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  if (w === 'number') {
    // `number/between` takes two values; everything else a list.
    const nums = parts.map(Number).filter(Number.isFinite)
    return nums.length ? nums : null
  }
  return parts
}

/** A filter's default as the UI string. */
export function defaultFilterString(p: Pick<metabase.MbParameter, 'default'>): string {
  const d = p.default
  if (d == null) return ''
  if (Array.isArray(d)) return d.map(String).join(', ')
  return String(d)
}

/**
 * The parameter values for one dashcard: only filters that are both set and
 * mapped to this card, each aimed at the card's own target.
 */
export function parametersForDashcard(
  params: metabase.MbParameter[],
  dashcard: Pick<metabase.MbDashcard, 'parameter_mappings' | 'card_id'>,
  values: Record<string, string>,
): metabase.MbParameterValue[] {
  const out: metabase.MbParameterValue[] = []
  for (const m of dashcard.parameter_mappings ?? []) {
    if (m.card_id != null && dashcard.card_id != null && m.card_id !== dashcard.card_id) continue
    const p = params.find((x) => x.id === m.parameter_id)
    if (!p) continue
    const value = encodeFilterValue(p.type, values[p.id] ?? '')
    if (value == null) continue
    out.push({ id: p.id, type: p.type, value, target: m.target })
  }
  return out
}

/** How many cards each filter reaches — a filter wired to nothing is shown as such. */
export function filterReach(params: metabase.MbParameter[], dashcards: Pick<metabase.MbDashcard, 'parameter_mappings'>[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(params.map((p) => [p.id, 0]))
  for (const dc of dashcards) {
    const ids = new Set((dc.parameter_mappings ?? []).map((m) => m.parameter_id))
    for (const id of ids) if (id in out) out[id]++
  }
  return out
}
