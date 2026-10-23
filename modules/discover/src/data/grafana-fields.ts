/**
 * Grafana's data-frame + field-config model, reduced to what the console's
 * native board renderer needs.
 *
 * Query results become frames (one per Prometheus series for time series,
 * one per query for `format: table`), transformations reshape them, and then
 * every field gets its effective config: `fieldConfig.defaults` merged with
 * each matching `fieldConfig.overrides[]` rule (byName, byRegexp,
 * byFrameRefID, byType, byNames). Display names, value text, colours and
 * `noValue` are all resolved here, side-effect free, so the views only draw.
 */

import {
  type FieldDefaults,
  type FieldOverride,
  formatLegend,
  formatUnit,
  grafanaColor,
  interpolate,
  mapValue,
  type PromSeries,
  thresholdFor,
  toJsRegex,
  type VarMap,
} from './grafana-board.ts'

export type FieldType = 'time' | 'number' | 'string'
export type FieldValue = number | string | null

export interface Field {
  name: string
  type: FieldType
  values: FieldValue[]
  labels?: Record<string, string>
  config: FieldDefaults
}

export interface DataFrame {
  refId?: string
  name?: string
  fields: Field[]
}

/** Raw per-query result, as `usePanelData` returns it. */
export interface QueryFrame {
  refId: string
  legendFormat?: string
  series: PromSeries[]
  /** `format: table` (or an instant query feeding a table). */
  table?: boolean
  /** `format: heatmap` — Prometheus histogram buckets. */
  heatmap?: boolean
  /** Query step in ms (the `interval` Grafana stamps on each field). */
  stepMs?: number
}

/* ─────────── frames from Prometheus ─────────── */

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isNaN(n) && v !== 'NaN' ? null : n
}

/**
 * Prometheus results → data frames, mirroring Grafana's Prometheus
 * datasource. Time series: one frame per series with `Time` + `Value`
 * (labels on the value field, legend as `displayNameFromDS`). Table format:
 * one frame per query with `Time`, one string field per label (sorted) and
 * `Value` — named `Value #<refId>` when the panel has more than one query.
 */
export function framesFromQueries(queries: QueryFrame[]): DataFrame[] {
  const out: DataFrame[] = []
  const multi = queries.length > 1
  for (const q of queries) {
    if (q.table) {
      const labelNames = [...new Set(q.series.flatMap((s) => Object.keys(s.metric)))].filter((k) => k !== '__name__').sort()
      const hasName = q.series.some((s) => s.metric.__name__)
      const time: FieldValue[] = []
      const vals: FieldValue[] = []
      const cols: Record<string, FieldValue[]> = Object.fromEntries(labelNames.map((l) => [l, []]))
      const nameCol: FieldValue[] = []
      for (const s of q.series) {
        const samples = s.value ? [s.value] : s.values?.length ? [s.values[s.values.length - 1]] : []
        for (const [t, v] of samples) {
          time.push(t * 1000)
          vals.push(num(v))
          if (hasName) nameCol.push(s.metric.__name__ ?? '')
          for (const l of labelNames) cols[l].push(s.metric[l] ?? '')
        }
      }
      out.push({
        refId: q.refId,
        fields: [
          { name: 'Time', type: 'time', values: time, config: {} },
          ...(hasName ? [{ name: '__name__', type: 'string' as const, values: nameCol, config: {} }] : []),
          ...labelNames.map((l) => ({ name: l, type: 'string' as const, values: cols[l], config: {} })),
          { name: multi ? `Value #${q.refId}` : 'Value', type: 'number', values: vals, config: {} },
        ],
      })
      continue
    }
    for (const s of q.series) {
      const samples = s.values ?? (s.value ? [s.value] : [])
      const legend = formatLegend(q.legendFormat, s.metric, q.refId)
      out.push({
        refId: q.refId,
        name: legend,
        fields: [
          { name: 'Time', type: 'time', values: samples.map(([t]) => t * 1000), config: q.stepMs ? { interval: q.stepMs } : {} },
          {
            name: 'Value',
            type: 'number',
            values: samples.map(([, v]) => num(v)),
            labels: s.metric,
            config: { displayNameFromDS: legend, ...(q.stepMs ? { interval: q.stepMs } : {}) },
          },
        ],
      })
    }
  }
  return out
}

/* ─────────── display names ─────────── */

/** Field display name as Grafana computes it (config → DS legend → name). */
export function fieldDisplayName(field: Field, frame?: DataFrame, vars: VarMap = {}, scoped: Record<string, string> = {}): string {
  const dn = field.config.displayName
  if (dn) return templateDisplayName(dn, field, frame, vars, scoped)
  if (field.config.displayNameFromDS) return field.config.displayNameFromDS
  if (field.type === 'time') return field.name
  if (field.name === 'Value' && frame?.name) return frame.name
  return field.name
}

/** `${__field.labels.pod}`, `${__field.name}`, `${__series.name}` + board variables. */
export function templateDisplayName(tpl: string, field: Field, frame: DataFrame | undefined, vars: VarMap, scoped: Record<string, string> = {}): string {
  const s = tpl
    .replace(/\$\{__field\.labels\.([\w.]+)\}/g, (_, k: string) => field.labels?.[k] ?? '')
    .replace(/\$\{__field\.labels\}/g, () => Object.entries(field.labels ?? {}).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', '))
    .replace(/\$\{__field\.name\}/g, field.name)
    .replace(/\$\{__field\.displayName\}/g, field.config.displayNameFromDS ?? field.name)
    .replace(/\$\{__series\.name\}/g, frame?.name ?? field.config.displayNameFromDS ?? field.name)
    .replace(/\$\{__data\.refId\}/g, frame?.refId ?? '')
  return interpolate(s, vars, {}, scoped, 'text')
}

/* ─────────── overrides ─────────── */

/** Does an override matcher select this field? */
export function matchField(
  matcher: FieldOverride['matcher'],
  field: Field,
  frame: DataFrame,
  displayName: string,
): boolean {
  const id = matcher?.id
  const opt = matcher?.options
  switch (id) {
    case 'byName':
      return typeof opt === 'string' && (opt === displayName || opt === field.name)
    case 'byRegexp': {
      if (typeof opt !== 'string') return false
      const re = toJsRegex(opt)
      return !!re && re.test(displayName)
    }
    case 'byFrameRefID':
      return typeof opt === 'string' && frame.refId === opt
    case 'byType':
      return opt === field.type || (opt === 'number' && field.type === 'number')
    case 'byNames': {
      const o = opt as { names?: string[]; mode?: string } | undefined
      const names = o?.names ?? []
      const hit = names.includes(displayName) || names.includes(field.name)
      return o?.mode === 'exclude' ? !hit : hit
    }
    case 'byRegexpOrNames': {
      const o = opt as { pattern?: string; names?: string[] } | undefined
      if (o?.names?.includes(displayName)) return true
      const re = o?.pattern ? toJsRegex(o.pattern) : null
      return !!re && re.test(displayName)
    }
    default:
      return false
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let cur = target
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    const next = cur[k]
    cur[k] = next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

/**
 * Effective config of one field: the field's own config (from the
 * datasource / organize) under the panel defaults, then every matching
 * override applied in order. Override values replace (Grafana semantics):
 * `color`, `thresholds`, `mappings` and `custom.*` paths are set wholesale.
 */
export function resolveFieldConfig(
  field: Field,
  frame: DataFrame,
  defaults: FieldDefaults | undefined,
  overrides: FieldOverride[] | undefined,
  vars: VarMap = {},
): FieldDefaults {
  const base: FieldDefaults = {
    ...(defaults ?? {}),
    ...field.config,
    custom: { ...(defaults?.custom ?? {}), ...(field.config.custom ?? {}) },
  }
  // A display name set by organize (`renameByName`) beats the panel default.
  if (field.config.displayName) base.displayName = field.config.displayName
  // Matchers see the name the field arrives with (datasource legend or an
  // organize rename), not the panel's default displayName — as in Grafana.
  const name = fieldDisplayName({ ...field, config: { ...base, displayName: field.config.displayName } }, frame, vars)
  const cfg = base as Record<string, unknown>
  for (const o of overrides ?? []) {
    if (!matchField(o.matcher, field, frame, name)) continue
    for (const p of o.properties ?? []) {
      if (!p?.id) continue
      if (p.id === 'color' && typeof p.value === 'string') setPath(cfg, 'color', { mode: 'fixed', fixedColor: p.value })
      else setPath(cfg, p.id, p.value)
    }
  }
  return base
}

/** A field with its resolved config and display name. */
export interface ResolvedField extends Field {
  displayName: string
  frame: DataFrame
  frameIndex: number
  /** Index among all number fields of the panel (series colour slot). */
  seriesIndex: number
}

/** Resolve every field of every frame (overrides, display names). */
export function resolveFields(
  frames: DataFrame[],
  defaults: FieldDefaults | undefined,
  overrides: FieldOverride[] | undefined,
  vars: VarMap = {},
  scoped: Record<string, string> = {},
): Array<{ frame: DataFrame; fields: ResolvedField[] }> {
  let series = 0
  return frames.map((frame, frameIndex) => ({
    frame,
    fields: frame.fields.map((f) => {
      const config = resolveFieldConfig(f, frame, defaults, overrides, vars)
      const withCfg = { ...f, config }
      return {
        ...withCfg,
        displayName: fieldDisplayName(withCfg, frame, vars, scoped),
        frame,
        frameIndex,
        seriesIndex: f.type === 'number' ? series++ : -1,
      }
    }),
  }))
}

/* ─────────── values & colours ─────────── */

export interface DisplayValue {
  text: string
  /** Colour from mapping / thresholds / fixed / palette (CSS). */
  color?: string
  /** Raw Grafana colour name (for tone icons). */
  rawColor?: string
  numeric: number | null
  /** Mapped by a value mapping. */
  mapped?: boolean
}

const CONTINUOUS: Record<string, string[]> = {
  'continuous-GrYlRd': ['#73bf69', '#fade2a', '#f2495c'],
  'continuous-RdYlGr': ['#f2495c', '#fade2a', '#73bf69'],
  'continuous-BlYlRd': ['#5794f2', '#fade2a', '#f2495c'],
  'continuous-YlRd': ['#fade2a', '#f2495c'],
  'continuous-BlPu': ['#5794f2', '#b877d9'],
  'continuous-YlBl': ['#fade2a', '#5794f2'],
  'continuous-blues': ['#c0d8ff', '#1f60c4'],
  'continuous-reds': ['#ffa6b0', '#c4162a'],
  'continuous-greens': ['#c8f2c2', '#37872d'],
  'continuous-purples': ['#deb6f2', '#8f3bb8'],
  'continuous-viridis': ['#440154', '#21918c', '#fde725'],
}

/** Linear blend through a list of hex stops (t in 0..1). */
export function blendStops(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const a = hex(stops[i])
  const b = hex(stops[Math.min(stops.length - 1, i + 1)])
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function hex(h: string): [number, number, number] {
  const s = h.replace('#', '')
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

/**
 * Colour of a value under a field's colour mode. `paletteColor` supplies the
 * categorical colour for `palette-classic` (the console's own series palette).
 */
export function fieldColor(
  cfg: FieldDefaults,
  value: number | null,
  paletteColor: string,
  range?: { min: number; max: number },
): { color?: string; raw?: string } {
  const mode = cfg.color?.mode ?? 'thresholds'
  if (mode === 'fixed' || mode === 'shades') {
    const raw = cfg.color?.fixedColor ?? 'blue'
    return { color: grafanaColor(raw), raw }
  }
  if (mode === 'thresholds') {
    const step = thresholdFor(value, cfg.thresholds, cfg.min ?? range?.min ?? 0, cfg.max ?? range?.max ?? 100)
    return step ? { color: grafanaColor(step.color), raw: step.color } : { color: paletteColor }
  }
  if (CONTINUOUS[mode]) {
    if (value == null) return {}
    const lo = cfg.min ?? range?.min ?? 0
    const hi = cfg.max ?? range?.max ?? 100
    return { color: blendStops(CONTINUOUS[mode], (value - lo) / Math.max(1e-9, hi - lo)) }
  }
  return { color: paletteColor }
}

/** Value → display text + colour (mappings first, then unit + colour mode). */
export function displayValue(
  cfg: FieldDefaults,
  value: FieldValue,
  paletteColor: string,
  range?: { min: number; max: number },
): DisplayValue {
  const n = typeof value === 'number' ? value : value != null && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : null
  const mapped = mapValue(value, cfg.mappings)
  const base = fieldColor(cfg, n, paletteColor, range)
  if (mapped && (mapped.text != null || mapped.color)) {
    return {
      text: mapped.text ?? (n != null ? formatUnit(n, cfg.unit, cfg.decimals) : String(value ?? '')),
      color: mapped.color ? grafanaColor(mapped.color) : base.color,
      rawColor: mapped.color ?? base.raw,
      numeric: n,
      mapped: true,
    }
  }
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) {
    return { text: cfg.noValue ?? (value == null ? '—' : String(value)), numeric: null }
  }
  if (typeof value === 'string' && n == null) return { text: value, numeric: null, color: base.color, rawColor: base.raw }
  return { text: formatUnit(n, cfg.unit, cfg.decimals), color: base.color, rawColor: base.raw, numeric: n }
}

/** Interpolate data-link URLs (`${__data.fields.X}`, `${__value.raw}`, board vars). */
export function interpolateLink(
  url: string,
  row: Record<string, FieldValue>,
  vars: VarMap,
  extra: Record<string, string> = {},
): string {
  const s = url
    .replace(/\$\{__data\.fields(?:\.|\[")([^}"\]]+)(?:"\])?\}/g, (_, k: string) => encodeURIComponent(String(row[k] ?? '')))
    .replace(/\$\{__value\.(?:raw|text|numeric)\}/g, () => encodeURIComponent(String(row.__value ?? '')))
    .replace(/\$\{__url_time_range\}/g, extra.__url_time_range ?? '')
    .replace(/\$\{(\w+):queryparam\}/g, (whole, name: string) => {
      const v = vars[name]
      if (!v) return whole
      return v.values.map((x) => `var-${name}=${encodeURIComponent(x === '$__all' ? 'All' : x)}`).join('&')
    })
  return interpolate(s, vars, extra, {}, 'raw')
}

/* ─────────── single-value panels ─────────── */

export interface DisplayItem {
  key: string
  name: string
  field: ResolvedField
  value: number | null
  /** Sparkline samples (stat graphMode area). */
  spark: Array<[number, number]>
}

/**
 * Grafana `reduceOptions` → the values a stat / gauge / bar gauge / pie
 * shows. `values: false` reduces each number field with `calcs[0]`;
 * `values: true` shows every row (up to `limit`). `fields` narrows by
 * name or `/regex/` ('' = numeric fields).
 */
export function displayItems(
  frames: Array<{ fields: ResolvedField[] }>,
  reduceOptions: { calcs?: string[]; values?: boolean; fields?: string; limit?: number } | undefined,
  calcFallback = 'lastNotNull',
  reduceFn: (vals: Array<number | null>, calc: string) => number | null,
): DisplayItem[] {
  const calc = reduceOptions?.calcs?.[0] ?? calcFallback
  const sel = reduceOptions?.fields ?? ''
  const re = sel && sel !== 'numeric' ? toJsRegex(sel) : null
  const pick = (f: ResolvedField) => (re ? re.test(f.displayName) || re.test(f.name) : f.type === 'number')
  const out: DisplayItem[] = []
  for (const fr of frames) {
    const time = fr.fields.find((f) => f.type === 'time')
    for (const f of fr.fields) {
      if (f.type === 'time' || !pick(f)) continue
      if (f.type !== 'number' && !re) continue
      const nums = f.values.map((v) => (v == null || v === '' ? null : Number(v)))
      if (reduceOptions?.values) {
        const names = fr.fields.filter((x) => x.type === 'string')
        const limit = reduceOptions.limit ?? 5000
        for (let i = 0; i < Math.min(nums.length, limit); i++) {
          const rowName = names.map((x) => String(x.values[i] ?? '')).filter(Boolean).join(' ')
          out.push({ key: `${f.frameIndex}:${f.name}:${i}`, name: rowName || f.displayName, field: f, value: nums[i], spark: [] })
        }
        continue
      }
      const spark: Array<[number, number]> = time
        ? nums.flatMap((v, i) => (v != null && Number.isFinite(v) ? [[Number(time.values[i]), v] as [number, number]] : []))
        : []
      out.push({ key: `${f.frameIndex}:${f.name}:${f.seriesIndex}`, name: f.displayName, field: f, value: reduceFn(nums, calc), spark })
    }
  }
  return out
}
