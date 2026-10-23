/**
 * Grafana panel transformations, applied to data frames before field config.
 *
 * Implemented (in order of use on the platform's boards): `organize`,
 * `merge`, `joinByField` (+ legacy `seriesToColumns`), then the common
 * general ones: `reduce`, `filterFieldsByName`, `filterByRefId`,
 * `calculateField`, `labelsToFields`, `sortBy`, `limit`, `groupBy`,
 * `concatenate`, `renameByRegex`. Unknown transformations pass frames through
 * unchanged and are reported so the panel can say so.
 */

import { CALC_LABEL, reduce, toJsRegex } from './grafana-board.ts'
import { type DataFrame, type Field, fieldDisplayName, type FieldValue } from './grafana-fields.ts'

export interface Transformation {
  id: string
  options?: Record<string, unknown>
  disabled?: boolean
}

export const SUPPORTED_TRANSFORMS = new Set([
  'organize',
  'merge',
  'joinByField',
  'seriesToColumns',
  'reduce',
  'filterFieldsByName',
  'filterByRefId',
  'calculateField',
  'labelsToFields',
  'sortBy',
  'limit',
  'groupBy',
  'concatenate',
  'renameByRegex',
])

const rowCount = (f: DataFrame) => f.fields[0]?.values.length ?? 0
const dn = (f: Field, frame: DataFrame) => fieldDisplayName(f, frame)

/** Run a panel's transformations. Returns frames + ids that were skipped. */
export function applyTransformations(frames: DataFrame[], list: Transformation[] | undefined): { frames: DataFrame[]; skipped: string[] } {
  let out = frames
  const skipped: string[] = []
  for (const t of list ?? []) {
    if (t.disabled) continue
    const o = t.options ?? {}
    switch (t.id) {
      case 'organize':
        out = out.map((f) => organize(f, o))
        break
      case 'merge':
        out = merge(out)
        break
      case 'joinByField':
      case 'seriesToColumns':
        out = joinByField(out, (o.byField as string | undefined) ?? 'Time', (o.mode as string | undefined) === 'inner' ? 'inner' : 'outer')
        break
      case 'reduce':
        out = reduceTransform(out, o)
        break
      case 'filterFieldsByName':
        out = out.map((f) => filterFieldsByName(f, o))
        break
      case 'filterByRefId': {
        const re = toJsRegex(String(o.include ?? ''))
        if (re) out = out.filter((f) => re.test(f.refId ?? ''))
        break
      }
      case 'calculateField':
        out = out.map((f) => calculateField(f, o))
        break
      case 'labelsToFields':
        out = labelsToFields(out, o)
        break
      case 'sortBy':
        out = out.map((f) => sortBy(f, (o.sort as Array<{ field?: string; desc?: boolean }> | undefined) ?? []))
        break
      case 'limit':
        out = out.map((f) => sliceRows(f, 0, Number(o.limitField ?? 10)))
        break
      case 'groupBy':
        out = out.map((f) => groupBy(f, (o.fields as Record<string, { operation?: string; aggregations?: string[] }> | undefined) ?? {}))
        break
      case 'concatenate':
        out = out.length ? [{ refId: out[0].refId, name: out[0].name, fields: out.flatMap((f) => f.fields.map((x) => ({ ...x, config: { ...x.config, displayName: x.config.displayName ?? dn(x, f) } }))) }] : out
        break
      case 'renameByRegex': {
        const re = toJsRegex(String(o.regex ?? ''))
        const pat = String(o.renamePattern ?? '')
        if (re) {
          out = out.map((f) => ({
            ...f,
            fields: f.fields.map((x) => {
              const name = dn(x, f)
              return re.test(name) ? { ...x, config: { ...x.config, displayName: name.replace(re, pat) } } : x
            }),
          }))
        }
        break
      }
      default:
        skipped.push(t.id)
    }
  }
  return { frames: out, skipped }
}

/* ─────────── organize ─────────── */

export function organize(frame: DataFrame, o: Record<string, unknown>): DataFrame {
  const exclude = (o.excludeByName ?? {}) as Record<string, boolean>
  const index = (o.indexByName ?? {}) as Record<string, number>
  const rename = (o.renameByName ?? {}) as Record<string, string>
  const kept = frame.fields
    .map((f, i) => ({ f, i, name: dn(f, frame) }))
    .filter((x) => !exclude[x.name])
  const hasIndex = Object.keys(index).length > 0
  if (hasIndex) {
    kept.sort((a, b) => (index[a.name] ?? Number.MAX_SAFE_INTEGER) - (index[b.name] ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
  }
  return {
    ...frame,
    fields: kept.map(({ f, name }) => (rename[name] ? { ...f, config: { ...f.config, displayName: rename[name] } } : f)),
  }
}

/* ─────────── merge ─────────── */

/**
 * Grafana's `merge`: one table from many. Fields are matched by name; the
 * key is every field present in all frames; rows with the same key merge
 * when none of their defined values conflict.
 */
export function merge(frames: DataFrame[]): DataFrame[] {
  if (frames.length < 2) return frames
  const names: string[] = []
  const proto = new Map<string, Field>()
  for (const fr of frames) {
    for (const f of fr.fields) {
      if (!proto.has(f.name)) {
        proto.set(f.name, f)
        names.push(f.name)
      }
    }
  }
  const keyNames = names.filter((n) => frames.every((fr) => fr.fields.some((f) => f.name === n)))
  const rows: Array<Record<string, FieldValue>> = []
  const byKey = new Map<string, number[]>()
  for (const fr of frames) {
    const n = rowCount(fr)
    for (let r = 0; r < n; r++) {
      const row: Record<string, FieldValue> = {}
      for (const f of fr.fields) row[f.name] = f.values[r] ?? null
      const key = JSON.stringify(keyNames.map((k) => row[k]))
      const candidates = byKey.get(key) ?? []
      const target = candidates.find((i) => Object.entries(row).every(([k, v]) => v == null || rows[i][k] == null || rows[i][k] === v))
      if (target != null) Object.assign(rows[target], Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)))
      else {
        rows.push(row)
        byKey.set(key, [...candidates, rows.length - 1])
      }
    }
  }
  return [{
    refId: frames[0].refId,
    fields: names.map((n) => {
      const p = proto.get(n)!
      return { ...p, labels: undefined, values: rows.map((r) => r[n] ?? null) }
    }),
  }]
}

/* ─────────── join ─────────── */

/**
 * `joinByField` (outer / inner). Fields whose name appears in more than one
 * frame get Grafana's ` <frame#>` suffix (`Time 1`, `Time 2` …), which is
 * what boards' `organize` options refer to.
 */
export function joinByField(frames: DataFrame[], byField: string, mode: 'outer' | 'inner' = 'outer'): DataFrame[] {
  const usable = frames.filter((fr) => fr.fields.some((f) => f.name === byField || dn(f, fr) === byField))
  if (usable.length < 2) return frames
  const keyOf = (fr: DataFrame) => fr.fields.find((f) => f.name === byField || dn(f, fr) === byField)!
  const counts = new Map<string, number>()
  for (const fr of usable) for (const f of fr.fields) if (f !== keyOf(fr)) counts.set(f.name, (counts.get(f.name) ?? 0) + 1)
  const keys: FieldValue[] = []
  const seen = new Set<string>()
  const perFrame = usable.map((fr) => {
    const kf = keyOf(fr)
    const m = new Map<string, number>()
    kf.values.forEach((v, i) => {
      const k = String(v)
      if (!m.has(k)) m.set(k, i)
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(v)
      }
    })
    return m
  })
  const rowsKeys = mode === 'inner' ? keys.filter((k) => perFrame.every((m) => m.has(String(k)))) : keys
  if (byField === 'Time' || keyOf(usable[0]).type === 'time') rowsKeys.sort((a, b) => Number(a) - Number(b))
  const first = keyOf(usable[0])
  const fields: Field[] = [{ ...first, labels: undefined, values: rowsKeys }]
  usable.forEach((fr, i) => {
    const kf = keyOf(fr)
    for (const f of fr.fields) {
      if (f === kf) continue
      const name = (counts.get(f.name) ?? 0) > 1 ? `${f.name} ${i + 1}` : f.name
      fields.push({
        ...f,
        name,
        values: rowsKeys.map((k) => {
          const r = perFrame[i].get(String(k))
          return r == null ? null : f.values[r] ?? null
        }),
      })
    }
  })
  return [{ refId: usable[0].refId, fields }, ...frames.filter((f) => !usable.includes(f))]
}

/* ─────────── reduce ─────────── */

function reduceTransform(frames: DataFrame[], o: Record<string, unknown>): DataFrame[] {
  const reducers = ((o.reducers as string[] | undefined) ?? ['max']).filter(Boolean)
  const mode = (o.mode as string | undefined) ?? 'seriesToRows'
  if (mode === 'reduceFields') {
    return frames.map((fr) => ({
      ...fr,
      fields: fr.fields.flatMap((f) =>
        f.type === 'number'
          ? reducers.map((r) => ({ ...f, name: reducers.length > 1 ? `${f.name} ${CALC_LABEL[r] ?? r}` : f.name, values: [reduce(f.values as Array<number | null>, r)] }))
          : f.type === 'time' && !o.includeTimeField ? [] : [{ ...f, values: f.values.slice(-1) }]
      ),
    }))
  }
  const names: string[] = []
  const cols: Array<Array<number | null>> = reducers.map(() => [])
  const labelCols = new Map<string, FieldValue[]>()
  const wantLabels = !!o.labelsToFields
  for (const fr of frames) {
    for (const f of fr.fields) {
      if (f.type !== 'number') continue
      names.push(dn(f, fr))
      reducers.forEach((r, i) => cols[i].push(reduce(f.values as Array<number | null>, r)))
      if (wantLabels) {
        for (const k of Object.keys(f.labels ?? {})) if (!labelCols.has(k)) labelCols.set(k, new Array(names.length - 1).fill(null))
        for (const [k, arr] of labelCols) arr.push(f.labels?.[k] ?? null)
      }
    }
  }
  return [{
    refId: frames[0]?.refId,
    fields: [
      { name: 'Field', type: 'string', values: names, config: {} },
      ...[...labelCols].map(([k, v]) => ({ name: k, type: 'string' as const, values: v, config: {} })),
      ...reducers.map((r, i) => ({ name: CALC_LABEL[r] ?? r, type: 'number' as const, values: cols[i], config: {} })),
    ],
  }]
}

/* ─────────── filters ─────────── */

function filterFieldsByName(frame: DataFrame, o: Record<string, unknown>): DataFrame {
  const inc = o.include as { names?: string[]; pattern?: string } | undefined
  const exc = o.exclude as { names?: string[]; pattern?: string } | undefined
  const incRe = inc?.pattern ? toJsRegex(inc.pattern) : null
  const excRe = exc?.pattern ? toJsRegex(exc.pattern) : null
  return {
    ...frame,
    fields: frame.fields.filter((f) => {
      const name = dn(f, frame)
      if (inc && (inc.names?.length || incRe)) {
        if (!(inc.names?.includes(name) || (incRe && incRe.test(name)))) return false
      }
      if (exc && (exc.names?.includes(name) || (excRe && excRe.test(name)))) return false
      return true
    }),
  }
}

/* ─────────── calculateField ─────────── */

function calculateField(frame: DataFrame, o: Record<string, unknown>): DataFrame {
  const mode = (o.mode as string | undefined) ?? 'reduceRow'
  const n = rowCount(frame)
  let values: Array<number | null> = []
  let defaultName = ''
  const numericByName = (name: string) => frame.fields.find((f) => dn(f, frame) === name || f.name === name)
  if (mode === 'binary') {
    const b = (o.binary ?? {}) as { left?: string | { matcher?: { options?: string } }; right?: string | { matcher?: { options?: string } }; operator?: string }
    const side = (s: unknown): (i: number) => number | null => {
      const name = typeof s === 'string' ? s : (s as { matcher?: { options?: string }; fixed?: string })?.matcher?.options ?? (s as { fixed?: string })?.fixed ?? ''
      const f = numericByName(name)
      if (f) return (i) => (f.values[i] == null ? null : Number(f.values[i]))
      const c = Number(name)
      return () => (Number.isFinite(c) ? c : null)
    }
    const l = side(b.left)
    const r = side(b.right)
    const op = b.operator ?? '+'
    values = Array.from({ length: n }, (_, i) => {
      const a = l(i)
      const c = r(i)
      if (a == null || c == null) return null
      switch (op) {
        case '-':
          return a - c
        case '*':
          return a * c
        case '/':
          return c === 0 ? null : a / c
        case '%':
          return a % c
        case '^':
          return a ** c
        default:
          return a + c
      }
    })
    defaultName = `${typeof b.left === 'string' ? b.left : 'left'} ${op} ${typeof b.right === 'string' ? b.right : 'right'}`
  } else {
    const r = (o.reduce ?? {}) as { reducer?: string; include?: string[] }
    const reducer = r.reducer ?? 'sum'
    const cols = frame.fields.filter((f) => f.type === 'number' && (!r.include?.length || r.include.includes(dn(f, frame))))
    values = Array.from({ length: n }, (_, i) => reduce(cols.map((f) => (f.values[i] == null ? null : Number(f.values[i]))), reducer))
    defaultName = CALC_LABEL[reducer] ?? reducer
  }
  const field: Field = { name: (o.alias as string | undefined) || defaultName, type: 'number', values, config: {} }
  if (o.replaceFields) return { ...frame, fields: [...frame.fields.filter((f) => f.type === 'time'), field] }
  return { ...frame, fields: [...frame.fields, field] }
}

/* ─────────── labelsToFields ─────────── */

function labelsToFields(frames: DataFrame[], o: Record<string, unknown>): DataFrame[] {
  const valueLabel = o.valueLabel as string | undefined
  const keep = o.keepLabels as string[] | undefined
  if (o.mode === 'rows') {
    return frames.map((fr) => {
      const labels = fr.fields.flatMap((f) => Object.entries(f.labels ?? {})).filter(([k]) => !keep || keep.includes(k))
      return {
        ...fr,
        fields: [
          { name: 'label', type: 'string', values: labels.map(([k]) => k), config: {} },
          { name: 'value', type: 'string', values: labels.map(([, v]) => v), config: {} },
        ],
      }
    })
  }
  return frames.map((fr) => {
    const fields: Field[] = []
    const n = rowCount(fr)
    for (const f of fr.fields) {
      if (!f.labels || f.type !== 'number') {
        fields.push(f)
        continue
      }
      const entries = Object.entries(f.labels).filter(([k]) => k !== '__name__' && (!keep || keep.includes(k)) && k !== valueLabel)
      for (const [k, v] of entries) if (!fields.some((x) => x.name === k)) fields.push({ name: k, type: 'string', values: new Array(n).fill(v), config: {} })
      const name = valueLabel && f.labels[valueLabel] ? f.labels[valueLabel] : f.name
      fields.push({ ...f, name, labels: undefined, config: { ...f.config, displayNameFromDS: undefined } })
    }
    return { ...fr, fields }
  })
}

/* ─────────── sort / limit / group ─────────── */

function sliceRows(frame: DataFrame, start: number, end: number): DataFrame {
  return { ...frame, fields: frame.fields.map((f) => ({ ...f, values: f.values.slice(start, end) })) }
}

export function sortBy(frame: DataFrame, sort: Array<{ field?: string; desc?: boolean }>): DataFrame {
  const s = sort[0]
  if (!s?.field) return frame
  const f = frame.fields.find((x) => dn(x, frame) === s.field || x.name === s.field)
  if (!f) return frame
  const idx = f.values.map((_, i) => i)
  idx.sort((a, b) => compareValues(f.values[a], f.values[b]) * (s.desc ? -1 : 1))
  return { ...frame, fields: frame.fields.map((x) => ({ ...x, values: idx.map((i) => x.values[i]) })) }
}

/** Nulls last, numbers numerically, strings naturally. */
export function compareValues(a: FieldValue, b: FieldValue): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

function groupBy(frame: DataFrame, fields: Record<string, { operation?: string; aggregations?: string[] }>): DataFrame {
  const groupNames = Object.entries(fields).filter(([, v]) => v.operation === 'groupby').map(([k]) => k)
  if (!groupNames.length) return frame
  const find = (name: string) => frame.fields.find((f) => dn(f, frame) === name || f.name === name)
  const gFields = groupNames.map(find).filter((f): f is Field => !!f)
  const n = rowCount(frame)
  const groups = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const k = JSON.stringify(gFields.map((f) => f.values[i]))
    groups.set(k, [...(groups.get(k) ?? []), i])
  }
  const rows = [...groups.values()]
  const out: Field[] = gFields.map((f) => ({ ...f, labels: undefined, values: rows.map((r) => f.values[r[0]]) }))
  for (const [name, v] of Object.entries(fields)) {
    if (v.operation !== 'aggregate') continue
    const f = find(name)
    if (!f) continue
    for (const calc of v.aggregations ?? []) {
      out.push({
        name: `${dn(f, frame)} (${calc})`,
        type: 'number',
        values: rows.map((r) => reduce(r.map((i) => (f.values[i] == null ? null : Number(f.values[i]))), calc)),
        config: f.config,
      })
    }
  }
  return { ...frame, fields: out }
}
