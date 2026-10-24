/**
 * PostHog data layer for the Discover analytics pages (Analytics, Funnels,
 * Cohorts, Sessions, Feature flags).
 *
 * Everything goes to PostHog's real API through the console BFF tool proxy
 * (`/api/svc/posthog/...`, the server injects the personal API key):
 *
 *   • POST /api/projects/@current/query/              HogQL + Trends/Funnels/Retention/Paths/Lifecycle queries
 *   • GET  /api/projects/@current/event_definitions/  real event names (builder pickers)
 *   • GET  /api/projects/@current/property_definitions/
 *   • GET|POST|PATCH /api/projects/@current/insights/ saved funnels / insights
 *   • GET|POST|PATCH /api/projects/@current/cohorts/  (+ /<id>/persons/)
 *   • GET  /api/projects/@current/session_recordings/
 *   • GET|POST|PATCH /api/projects/@current/feature_flags/
 *   • GET  /api/projects/@current/experiments/
 *
 * The pure helpers (query builders, response parsers, funnel/retention math,
 * flag parsing, HogQL filter compilation) are exported for unit tests. No
 * helper ever fills a gap with a made-up number: missing data stays missing.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const BASE = '/api/svc/posthog/api/projects/@current'

/* ─────────── HTTP ─────────── */

export class PostHogError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
    this.name = 'HttpError'
  }
}

/** True for the gateway answers PostHog gives while it boots / migrates. */
export function isStartingUp(e: unknown): boolean {
  const s = (e as { status?: number } | null)?.status
  return s === 502 || s === 503 || s === 504
}

export async function ph<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...init,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      headers: { accept: 'application/json', ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    })
  } catch (e) {
    const err = new Error(`Network error: ${(e as Error).message}`)
    err.name = 'NetworkError'
    throw err
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) {
    const detail = (body as { detail?: string; error?: string } | undefined)?.detail ?? (body as { error?: string } | undefined)?.error ?? ''
    throw new PostHogError(res.status, `PostHog HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, body)
  }
  if (typeof body === 'string' && /^\s*</.test(body)) {
    // An auth proxy's login page, not PostHog JSON.
    throw new PostHogError(401, 'PostHog answered with an HTML page instead of JSON (is POSTHOG_TOKEN set?)')
  }
  return body as T
}

const noRetryOnClientError = (n: number, e: unknown) => {
  const s = (e as { status?: number }).status ?? 0
  if (s >= 400 && s < 500) return false
  return n < (isStartingUp(e) ? 0 : 1)
}

/* ─────────── date ranges ─────────── */

export const DATE_RANGES = [
  { id: '-24h', label: 'Last 24 hours', hours: 24 },
  { id: '-7d', label: 'Last 7 days', hours: 24 * 7 },
  { id: '-14d', label: 'Last 14 days', hours: 24 * 14 },
  { id: '-30d', label: 'Last 30 days', hours: 24 * 30 },
  { id: '-90d', label: 'Last 90 days', hours: 24 * 90 },
] as const
export type DateRangeId = (typeof DATE_RANGES)[number]['id']

export function rangeHours(id: DateRangeId): number {
  return DATE_RANGES.find((r) => r.id === id)?.hours ?? 24 * 7
}

/** Interval PostHog should bucket a range in. */
export function intervalFor(id: DateRangeId): 'hour' | 'day' | 'week' {
  const h = rangeHours(id)
  return h <= 48 ? 'hour' : h > 24 * 60 ? 'week' : 'day'
}

/** HogQL predicate for the current window (and the one before it). */
export function windowClause(id: DateRangeId, previous = false): string {
  const h = rangeHours(id)
  return previous
    ? `timestamp >= now() - interval ${h * 2} hour and timestamp < now() - interval ${h} hour`
    : `timestamp >= now() - interval ${h} hour`
}

/* ─────────── property filters ─────────── */

export type FilterOperator = 'exact' | 'is_not' | 'icontains' | 'not_icontains' | 'is_set' | 'is_not_set' | 'gt' | 'lt' | 'regex'

export interface PropertyFilter {
  key: string
  value?: string | number | Array<string | number>
  operator?: FilterOperator
  type: 'event' | 'person' | 'cohort'
}

/** Escape a string for a single-quoted HogQL literal. */
export function hogqlString(s: string): string {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** A safe HogQL property accessor (`properties.$browser` / `properties['a b']`). */
export function propAccessor(key: string, type: 'event' | 'person'): string {
  const root = type === 'person' ? 'person.properties' : 'properties'
  return /^[$A-Za-z_][\w$]*$/.test(key) ? `${root}.${key}` : `${root}[${hogqlString(key)}]`
}

/** Compile console property filters to a HogQL `and`-joined predicate. */
export function filtersToHogQL(filters: PropertyFilter[]): string {
  const parts: string[] = []
  for (const f of filters) {
    if (f.type === 'cohort') {
      const id = Number(f.value)
      if (Number.isFinite(id)) parts.push(`person_id IN COHORT ${id}`)
      continue
    }
    if (!f.key) continue
    const acc = propAccessor(f.key, f.type)
    const vals = Array.isArray(f.value) ? f.value : f.value == null || f.value === '' ? [] : [f.value]
    const lit = (v: string | number) => (typeof v === 'number' ? String(v) : hogqlString(v))
    switch (f.operator ?? 'exact') {
      case 'is_set':
        parts.push(`${acc} IS NOT NULL`)
        break
      case 'is_not_set':
        parts.push(`${acc} IS NULL`)
        break
      case 'icontains':
        if (vals.length) parts.push(`${acc} ILIKE ${hogqlString(`%${vals[0]}%`)}`)
        break
      case 'not_icontains':
        if (vals.length) parts.push(`NOT (${acc} ILIKE ${hogqlString(`%${vals[0]}%`)})`)
        break
      case 'regex':
        if (vals.length) parts.push(`match(toString(${acc}), ${hogqlString(String(vals[0]))})`)
        break
      case 'gt':
        if (vals.length) parts.push(`toFloat(${acc}) > ${Number(vals[0])}`)
        break
      case 'lt':
        if (vals.length) parts.push(`toFloat(${acc}) < ${Number(vals[0])}`)
        break
      case 'is_not':
        if (vals.length) parts.push(vals.length === 1 ? `${acc} != ${lit(vals[0])}` : `${acc} NOT IN (${vals.map(lit).join(', ')})`)
        break
      default:
        if (vals.length) parts.push(vals.length === 1 ? `${acc} = ${lit(vals[0])}` : `${acc} IN (${vals.map(lit).join(', ')})`)
    }
  }
  return parts.join(' and ')
}

/** Console filters → PostHog's own `properties` array (for Trends/Funnels queries). */
export function filtersToPostHog(filters: PropertyFilter[]): Array<Record<string, unknown>> {
  return filters
    .filter((f) => f.type === 'cohort' ? f.value != null : !!f.key)
    .map((f) =>
      f.type === 'cohort'
        ? { type: 'cohort', key: 'id', value: Number(f.value) }
        : { type: f.type, key: f.key, value: f.value ?? null, operator: f.operator ?? 'exact' }
    )
}

/* ─────────── HogQL ─────────── */

export interface HogQLResult {
  columns: string[]
  results: unknown[][]
}

export function hogql(query: string): Promise<HogQLResult> {
  return ph<HogQLResult>('/query/', { method: 'POST', json: { query: { kind: 'HogQLQuery', query } } })
}

/** Rows of a HogQL result as objects keyed by column. */
export function rowsOf<T = Record<string, unknown>>(r: HogQLResult | undefined): T[] {
  if (!r?.results) return []
  return r.results.map((row) => Object.fromEntries((r.columns ?? []).map((c, i) => [c, row[i]])) as T)
}

/* ─────────── insights (Trends) ─────────── */

export type TrendMath = 'total' | 'dau' | 'weekly_active' | 'monthly_active' | 'unique_session' | 'sum' | 'avg' | 'min' | 'max' | 'median' | 'p90' | 'p95' | 'p99'

export const TREND_MATHS: Array<{ id: TrendMath; label: string; needsProperty?: boolean }> = [
  { id: 'total', label: 'Total count' },
  { id: 'dau', label: 'Unique users' },
  { id: 'weekly_active', label: 'Weekly active users' },
  { id: 'monthly_active', label: 'Monthly active users' },
  { id: 'unique_session', label: 'Unique sessions' },
  { id: 'sum', label: 'Sum of property', needsProperty: true },
  { id: 'avg', label: 'Average of property', needsProperty: true },
  { id: 'median', label: 'Median of property', needsProperty: true },
  { id: 'p95', label: '95th percentile of property', needsProperty: true },
  { id: 'max', label: 'Max of property', needsProperty: true },
]

export type ChartType = 'line' | 'bar' | 'number' | 'table'

export interface TrendSpec {
  /** Event name; null = all events. */
  event: string | null
  math: TrendMath
  mathProperty?: string
  breakdown?: string
  breakdownType?: 'event' | 'person'
  range: DateRangeId
  compare?: boolean
  filters?: PropertyFilter[]
  interval?: 'hour' | 'day' | 'week' | 'month'
}

const PROPERTY_MATHS = new Set(['sum', 'avg', 'min', 'max', 'median', 'p90', 'p95', 'p99'])

export function buildTrendsQuery(spec: TrendSpec | TrendSpec[]): Record<string, unknown> {
  const specs = Array.isArray(spec) ? spec : [spec]
  const first = specs[0]
  const q: Record<string, unknown> = {
    kind: 'TrendsQuery',
    series: specs.map((s) => ({
      kind: 'EventsNode',
      event: s.event,
      name: s.event ?? 'All events',
      math: s.math,
      ...(PROPERTY_MATHS.has(s.math) && s.mathProperty ? { math_property: s.mathProperty } : {}),
    })),
    dateRange: { date_from: first.range },
    interval: first.interval ?? intervalFor(first.range),
    trendsFilter: { display: 'ActionsLineGraph' },
  }
  if (first.filters?.length) q.properties = filtersToPostHog(first.filters)
  if (first.breakdown) q.breakdownFilter = { breakdown: first.breakdown, breakdown_type: first.breakdownType ?? 'event', breakdown_limit: 10 }
  if (first.compare) q.compareFilter = { compare: true }
  return q
}

export interface TrendSeries {
  label: string
  /** Epoch ms per bucket. */
  times: number[]
  data: number[]
  count: number
  breakdown?: string
  /** 'current' | 'previous' when compare is on. */
  compare?: string
  seriesIndex: number
}

interface RawTrend {
  label?: string
  data?: number[]
  days?: string[]
  labels?: string[]
  count?: number
  aggregated_value?: number
  breakdown_value?: unknown
  compare_label?: string
  compare?: boolean
  action?: { order?: number; name?: string }
}

/** PostHog Trends results → series with real timestamps. */
export function parseTrends(results: unknown): TrendSeries[] {
  if (!Array.isArray(results)) return []
  return (results as RawTrend[]).map((r, i) => {
    const days = r.days ?? []
    const times = days.map((d) => Date.parse(d.length === 10 ? `${d}T00:00:00` : d.replace(' ', 'T')))
    const data = (r.data ?? []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0))
    const bv = r.breakdown_value
    const breakdown = bv == null ? undefined : Array.isArray(bv) ? bv.join(', ') : String(bv)
    return {
      label: r.label ?? r.action?.name ?? `Series ${i + 1}`,
      times,
      data,
      count: r.count ?? r.aggregated_value ?? data.reduce((a, b) => a + b, 0),
      breakdown: breakdown === '$$_posthog_breakdown_other_$$' ? 'Other' : breakdown === '$$_posthog_breakdown_null_$$' ? '(none)' : breakdown,
      compare: r.compare_label,
      seriesIndex: r.action?.order ?? 0,
    }
  })
}

export async function runQuery(query: Record<string, unknown>): Promise<unknown> {
  const res = await ph<{ results?: unknown; result?: unknown }>('/query/', { method: 'POST', json: { query } })
  return res.results ?? res.result ?? []
}

/** % change current vs previous; null when there is no previous baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (!Number.isFinite(prev) || prev === 0) return null
  return ((cur - prev) / prev) * 100
}

/* ─────────── funnels ─────────── */

export interface FunnelStepSpec {
  event: string
  /** Optional per-step label. */
  name?: string
}

export interface FunnelSpec {
  steps: FunnelStepSpec[]
  range: DateRangeId
  windowDays: number
  breakdown?: string
  breakdownType?: 'event' | 'person'
  filters?: PropertyFilter[]
  order?: 'ordered' | 'strict' | 'unordered'
}

export function buildFunnelsQuery(f: FunnelSpec): Record<string, unknown> {
  const q: Record<string, unknown> = {
    kind: 'FunnelsQuery',
    series: f.steps.map((s) => ({ kind: 'EventsNode', event: s.event, name: s.event, ...(s.name ? { custom_name: s.name } : {}) })),
    dateRange: { date_from: f.range },
    funnelsFilter: {
      funnelWindowInterval: f.windowDays,
      funnelWindowIntervalUnit: 'day',
      funnelVizType: 'steps',
      funnelOrderType: f.order ?? 'ordered',
    },
  }
  if (f.filters?.length) q.properties = filtersToPostHog(f.filters)
  if (f.breakdown) q.breakdownFilter = { breakdown: f.breakdown, breakdown_type: f.breakdownType ?? 'event', breakdown_limit: 8 }
  return q
}

/** Recover a FunnelSpec from a saved insight's query (new) or filters (legacy). */
export function funnelSpecFromInsight(ins: { query?: unknown; filters?: unknown }): FunnelSpec | null {
  const src = ((ins.query as { source?: unknown })?.source ?? ins.query) as Record<string, unknown> | undefined
  if (src && src.kind === 'FunnelsQuery' && Array.isArray(src.series)) {
    const ff = (src.funnelsFilter ?? {}) as Record<string, unknown>
    const bf = (src.breakdownFilter ?? {}) as Record<string, unknown>
    const unit = String(ff.funnelWindowIntervalUnit ?? 'day')
    const n = Number(ff.funnelWindowInterval ?? 14)
    const days = unit === 'week' ? n * 7 : unit === 'hour' ? Math.max(1, Math.round(n / 24)) : unit === 'month' ? n * 30 : n
    return {
      steps: (src.series as Array<Record<string, unknown>>).map((s) => ({ event: String(s.event ?? s.name ?? ''), name: (s.custom_name as string) || undefined })).filter((s) => s.event),
      range: (normalizeRange((src.dateRange as { date_from?: string })?.date_from) ?? '-30d'),
      windowDays: days,
      breakdown: typeof bf.breakdown === 'string' ? bf.breakdown : undefined,
      breakdownType: bf.breakdown_type === 'person' ? 'person' : 'event',
      order: (ff.funnelOrderType as FunnelSpec['order']) ?? 'ordered',
    }
  }
  const fl = ins.filters as Record<string, unknown> | undefined
  if (fl && Array.isArray(fl.events) && (fl.insight === 'FUNNELS' || fl.insight === undefined)) {
    return {
      steps: (fl.events as Array<Record<string, unknown>>).sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)).map((e) => ({ event: String(e.id ?? e.name ?? ''), name: (e.custom_name as string) || undefined })).filter((s) => s.event),
      range: normalizeRange(fl.date_from as string) ?? '-30d',
      windowDays: Number(fl.funnel_window_days ?? fl.funnel_window_interval ?? 14),
      breakdown: typeof fl.breakdown === 'string' ? fl.breakdown : undefined,
    }
  }
  return null
}

function normalizeRange(v?: string): DateRangeId | null {
  if (!v) return null
  const hit = DATE_RANGES.find((r) => r.id === v)
  if (hit) return hit.id
  const m = /^-(\d+)([hdwm])$/.exec(v)
  if (!m) return null
  const h = Number(m[1]) * ({ h: 1, d: 24, w: 168, m: 720 } as Record<string, number>)[m[2]]
  return [...DATE_RANGES].sort((a, b) => Math.abs(a.hours - h) - Math.abs(b.hours - h))[0].id
}

export interface FunnelStep {
  name: string
  event: string
  count: number
  /** Average seconds from the previous step (null on step 1 / unknown). */
  avgTime: number | null
  medianTime: number | null
}

export interface FunnelBreakdown {
  value: string | null
  steps: FunnelStep[]
}

interface RawFunnelStep {
  name?: string
  custom_name?: string | null
  action_id?: string
  order?: number
  count?: number
  average_conversion_time?: number | null
  median_conversion_time?: number | null
  breakdown_value?: unknown
  breakdown?: unknown
}

/** FunnelsQuery results → breakdown groups of steps (one group when no breakdown). */
export function parseFunnel(results: unknown): FunnelBreakdown[] {
  if (!Array.isArray(results) || results.length === 0) return []
  const toStep = (s: RawFunnelStep): FunnelStep => ({
    name: s.custom_name || s.name || s.action_id || `Step ${(s.order ?? 0) + 1}`,
    event: s.action_id ?? s.name ?? '',
    count: Number(s.count ?? 0),
    avgTime: s.order && s.average_conversion_time != null ? Number(s.average_conversion_time) : null,
    medianTime: s.order && s.median_conversion_time != null ? Number(s.median_conversion_time) : null,
  })
  const sortSteps = (a: RawFunnelStep[]) => [...a].sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
  if (Array.isArray(results[0])) {
    return (results as RawFunnelStep[][]).map((group) => {
      const bv = group[0]?.breakdown_value ?? group[0]?.breakdown
      return { value: bv == null ? null : Array.isArray(bv) ? bv.join(', ') : String(bv), steps: sortSteps(group).map(toStep) }
    })
  }
  return [{ value: null, steps: sortSteps(results as RawFunnelStep[]).map(toStep) }]
}

export interface FunnelStepMath extends FunnelStep {
  /** Share of step 1 that reached this step (0..1). */
  fromStart: number
  /** Share of the previous step that reached this step (0..1). */
  fromPrevious: number
  /** People lost since the previous step. */
  dropped: number
}

export function funnelMath(steps: FunnelStep[]): { steps: FunnelStepMath[]; overall: number } {
  const top = steps[0]?.count ?? 0
  const out = steps.map((s, i) => {
    const prev = i === 0 ? s.count : steps[i - 1].count
    return {
      ...s,
      fromStart: top > 0 ? s.count / top : 0,
      fromPrevious: i === 0 ? 1 : prev > 0 ? s.count / prev : 0,
      dropped: i === 0 ? 0 : Math.max(0, prev - s.count),
    }
  })
  return { steps: out, overall: top > 0 && steps.length ? steps[steps.length - 1].count / top : 0 }
}

/** Biggest drop-off step (index ≥ 1) or -1. */
export function worstStep(steps: FunnelStepMath[]): number {
  let idx = -1
  let worst = 1.01
  steps.forEach((s, i) => {
    if (i > 0 && s.fromPrevious < worst) {
      worst = s.fromPrevious
      idx = i
    }
  })
  return idx
}

/* ─────────── retention ─────────── */

export interface RetentionSpec {
  event: string
  returningEvent?: string
  period: 'Day' | 'Week' | 'Month'
  intervals: number
  firstTime?: boolean
}

export function buildRetentionQuery(r: RetentionSpec): Record<string, unknown> {
  return {
    kind: 'RetentionQuery',
    retentionFilter: {
      targetEntity: { id: r.event, name: r.event, type: 'events' },
      returningEntity: { id: r.returningEvent ?? r.event, name: r.returningEvent ?? r.event, type: 'events' },
      retentionType: r.firstTime ? 'retention_first_time' : 'retention_recurring',
      totalIntervals: r.intervals,
      period: r.period,
    },
    dateRange: { date_from: r.period === 'Day' ? `-${r.intervals}d` : r.period === 'Week' ? `-${r.intervals * 7}d` : `-${r.intervals * 30}d` },
  }
}

export interface RetentionCohort {
  label: string
  date: string
  size: number
  counts: number[]
  /** Percent of the cohort retained per period (0..100). */
  pct: number[]
}

export function parseRetention(results: unknown): RetentionCohort[] {
  if (!Array.isArray(results)) return []
  return (results as Array<{ date?: string; label?: string; values?: Array<{ count?: number }> }>).map((c) => {
    const counts = (c.values ?? []).map((v) => Number(v.count ?? 0))
    const size = counts[0] ?? 0
    return {
      label: c.label ?? c.date ?? '',
      date: c.date ?? '',
      size,
      counts,
      pct: counts.map((n) => (size > 0 ? (n / size) * 100 : 0)),
    }
  })
}

/** Size-weighted mean retention per period, counting only cohorts old enough. */
export function averageRetention(cohorts: RetentionCohort[]): number[] {
  const len = Math.max(0, ...cohorts.map((c) => c.counts.length))
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    let n = 0
    let d = 0
    for (const c of cohorts) {
      if (c.counts.length > i && c.size > 0) {
        n += c.counts[i]
        d += c.size
      }
    }
    out.push(d > 0 ? (n / d) * 100 : 0)
  }
  return out
}

/* ─────────── paths ─────────── */

export function buildPathsQuery(range: DateRangeId, startPoint?: string): Record<string, unknown> {
  return {
    kind: 'PathsQuery',
    dateRange: { date_from: range },
    pathsFilter: { includeEventTypes: ['$pageview'], stepLimit: 4, edgeLimit: 30, ...(startPoint ? { startPoint } : {}) },
  }
}

export interface PathEdge {
  source: string
  target: string
  value: number
}

/** PostHog prefixes nodes with their step (`1_/pricing`); split it off. */
export function parsePaths(results: unknown): Array<PathEdge & { step: number; from: string; to: string }> {
  if (!Array.isArray(results)) return []
  return (results as PathEdge[]).map((e) => {
    const m = /^(\d+)_(.*)$/.exec(e.source)
    const t = /^(\d+)_(.*)$/.exec(e.target)
    return { ...e, step: m ? Number(m[1]) : 0, from: m ? m[2] : e.source, to: t ? t[2] : e.target }
  }).sort((a, b) => b.value - a.value)
}

/* ─────────── lifecycle ─────────── */

export function buildLifecycleQuery(event: string | null, range: DateRangeId): Record<string, unknown> {
  return {
    kind: 'LifecycleQuery',
    series: [{ kind: 'EventsNode', event, name: event ?? 'All events', math: 'total' }],
    dateRange: { date_from: range },
    interval: intervalFor(range) === 'hour' ? 'day' : intervalFor(range),
  }
}

/** Lifecycle results → per-status series (new / returning / resurrecting / dormant). */
export function parseLifecycle(results: unknown): Record<string, TrendSeries> {
  const out: Record<string, TrendSeries> = {}
  const raw = Array.isArray(results) ? (results as Array<{ status?: string }>) : []
  parseTrends(results).forEach((s, i) => {
    const status = raw[i]?.status ?? s.label.split(' - ').pop() ?? s.label
    out[status] = s
  })
  return out
}

/* ─────────── feature flags ─────────── */

export interface RawFlag {
  id: number | string
  key: string
  name?: string
  active: boolean
  deleted?: boolean
  rollout_percentage?: number | null
  filters?: {
    groups?: Array<{ properties?: Array<Record<string, unknown>>; rollout_percentage?: number | null; variant?: string | null }>
    multivariate?: { variants?: Array<{ key: string; name?: string; rollout_percentage: number }> } | null
    payloads?: Record<string, unknown>
    aggregation_group_type_index?: number | null
  }
  experiment_set?: Array<number | string>
  tags?: string[]
  created_at?: string
  created_by?: { first_name?: string; email?: string } | null
  updated_at?: string
  last_modified_by?: { first_name?: string; email?: string } | null
  ensure_experience_continuity?: boolean
}

export interface FlagCondition {
  rollout: number
  properties: string[]
  variant?: string | null
}

export interface ParsedFlag {
  id: string
  key: string
  name: string
  active: boolean
  conditions: FlagCondition[]
  variants: Array<{ key: string; name?: string; rollout: number }>
  /** Effective reach of the widest condition with no property filter, else null. */
  rollout: number | null
  /** True when every condition is 100% with no filters (a plain on-switch). */
  fullyRolledOut: boolean
  experiments: string[]
  tags: string[]
  createdAt?: string
  updatedAt?: string
  author?: string
}

export function describeProperty(p: Record<string, unknown>): string {
  const type = String(p.type ?? 'person')
  if (type === 'cohort') return `in cohort ${String(p.value)}`
  const op = String(p.operator ?? 'exact')
  const val = Array.isArray(p.value) ? (p.value as unknown[]).join(' or ') : p.value == null ? '' : String(p.value)
  const ops: Record<string, string> = {
    exact: '=',
    is_not: '≠',
    icontains: 'contains',
    not_icontains: 'does not contain',
    regex: 'matches',
    not_regex: 'does not match',
    gt: '>',
    gte: '≥',
    lt: '<',
    lte: '≤',
    is_set: 'is set',
    is_not_set: 'is not set',
    is_date_before: 'before',
    is_date_after: 'after',
  }
  const o = ops[op] ?? op
  return op === 'is_set' || op === 'is_not_set' ? `${p.key} ${o}` : `${p.key} ${o} ${val}`
}

export function parseFlag(f: RawFlag): ParsedFlag {
  const groups = f.filters?.groups ?? []
  const conditions: FlagCondition[] = groups.map((g) => ({
    // PostHog treats a missing rollout on a condition as 100%.
    rollout: g.rollout_percentage == null ? 100 : Number(g.rollout_percentage),
    properties: (g.properties ?? []).map(describeProperty),
    variant: g.variant ?? null,
  }))
  if (!conditions.length && f.rollout_percentage != null) conditions.push({ rollout: Number(f.rollout_percentage), properties: [] })
  const unfiltered = conditions.filter((c) => c.properties.length === 0)
  const rollout = unfiltered.length ? Math.max(...unfiltered.map((c) => c.rollout)) : null
  return {
    id: String(f.id),
    key: f.key,
    name: f.name ?? '',
    active: !!f.active,
    conditions,
    variants: (f.filters?.multivariate?.variants ?? []).map((v) => ({ key: v.key, name: v.name, rollout: Number(v.rollout_percentage) })),
    rollout,
    fullyRolledOut: conditions.length > 0 && conditions.every((c) => c.rollout === 100 && c.properties.length === 0),
    experiments: (f.experiment_set ?? []).map(String),
    tags: f.tags ?? [],
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    author: f.last_modified_by?.first_name || f.last_modified_by?.email || f.created_by?.first_name || f.created_by?.email,
  }
}

/** Variant splits must sum to 100 for PostHog to accept them. */
export function variantsValid(v: Array<{ rollout: number }>): boolean {
  if (!v.length) return true
  return Math.round(v.reduce((a, b) => a + (Number(b.rollout) || 0), 0)) === 100
}

export const FLAG_KEY_RE = /^[a-zA-Z0-9_-]+$/

export interface FlagDraft {
  key: string
  name: string
  active: boolean
  conditions: Array<{ rollout: number; properties: PropertyFilter[] }>
  variants: Array<{ key: string; name?: string; rollout: number }>
}

/** Draft → PostHog `filters` body. */
export function flagDraftToFilters(d: FlagDraft): Record<string, unknown> {
  return {
    groups: d.conditions.map((c) => ({
      properties: c.properties.filter((p) => p.key || p.type === 'cohort').map((p) =>
        p.type === 'cohort'
          ? { type: 'cohort', key: 'id', value: Number(p.value) }
          : { type: p.type, key: p.key, value: p.value ?? null, operator: p.operator ?? 'exact' }
      ),
      rollout_percentage: Math.max(0, Math.min(100, Number(c.rollout))),
    })),
    ...(d.variants.length ? { multivariate: { variants: d.variants.map((v) => ({ key: v.key, name: v.name ?? '', rollout_percentage: Number(v.rollout) })) } } : {}),
  }
}

/** Raw flag → editable draft (property filters that are not simple stay intact as text-only). */
export function flagToDraft(f: RawFlag): FlagDraft {
  return {
    key: f.key,
    name: f.name ?? '',
    active: !!f.active,
    conditions: (f.filters?.groups ?? [{ rollout_percentage: f.rollout_percentage ?? 100, properties: [] }]).map((g) => ({
      rollout: g.rollout_percentage == null ? 100 : Number(g.rollout_percentage),
      properties: (g.properties ?? []).map((p): PropertyFilter => ({
        key: String(p.key ?? ''),
        value: p.value as PropertyFilter['value'],
        operator: (p.operator as FilterOperator) ?? 'exact',
        type: p.type === 'cohort' ? 'cohort' : p.type === 'event' ? 'event' : 'person',
      })),
    })),
    variants: (f.filters?.multivariate?.variants ?? []).map((v) => ({ key: v.key, name: v.name, rollout: Number(v.rollout_percentage) })),
  }
}

/* ─────────── cohorts ─────────── */

export interface RawCohort {
  id: number | string
  name: string
  description?: string
  count?: number | null
  is_static?: boolean
  is_calculating?: boolean
  errors_calculating?: number
  last_calculation?: string | null
  created_at?: string
  created_by?: { first_name?: string; email?: string } | null
  filters?: { properties?: CohortGroupNode } | null
  groups?: Array<Record<string, unknown>>
  deleted?: boolean
}

interface CohortGroupNode {
  type?: 'AND' | 'OR'
  values?: Array<CohortGroupNode | Record<string, unknown>>
}

/** Human-readable rule lines for a cohort's (nested AND/OR) filters. */
export function describeCohort(c: RawCohort): { joiner: 'AND' | 'OR'; groups: string[][] } {
  const root = c.filters?.properties
  const leafText = (p: Record<string, unknown>): string => {
    if (p.type === 'behavioral') {
      const verb = String(p.value ?? 'performed_event')
      const ev = String(p.key ?? '')
      const tv = p.time_value != null ? ` in the last ${p.time_value} ${p.time_interval ?? 'day'}${Number(p.time_value) === 1 ? '' : 's'}` : ''
      const map: Record<string, string> = {
        performed_event: `did ${ev}`,
        performed_event_multiple: `did ${ev} ${p.operator === 'gte' ? '≥' : p.operator === 'lte' ? '≤' : '='} ${p.operator_value ?? ''} times`,
        not_performed_event: `did not do ${ev}`,
        performed_event_first_time: `did ${ev} for the first time`,
        stopped_performing_event: `stopped doing ${ev}`,
        restarted_performing_event: `restarted doing ${ev}`,
      }
      return `${map[verb] ?? `${verb} ${ev}`}${tv}`
    }
    return describeProperty(p)
  }
  if (root?.values?.length) {
    const groups = root.values.map((g) => {
      const node = g as CohortGroupNode
      if (Array.isArray(node.values)) return node.values.map((v) => leafText(v as Record<string, unknown>))
      return [leafText(g as Record<string, unknown>)]
    })
    return { joiner: root.type === 'AND' ? 'AND' : 'OR', groups }
  }
  // Legacy `groups` shape.
  const legacy = (c.groups ?? []).map((g) => {
    const props = (g.properties as Array<Record<string, unknown>> | undefined) ?? []
    const lines = props.map(describeProperty)
    if (g.action_id || g.event_id) lines.push(`did ${String(g.event_id ?? `action ${g.action_id}`)}${g.days ? ` in the last ${g.days} days` : ''}`)
    return lines
  }).filter((l) => l.length)
  return { joiner: 'OR', groups: legacy }
}

export interface CohortRule {
  kind: 'person' | 'behavioral'
  /** person: property key; behavioral: event name. */
  key: string
  operator?: FilterOperator
  value?: string
  /** behavioral */
  verb?: 'performed_event' | 'not_performed_event' | 'performed_event_multiple'
  times?: number
  days?: number
}

/** Console cohort rules (one AND group) → PostHog cohort `filters`. */
export function buildCohortFilters(rules: CohortRule[], joiner: 'AND' | 'OR' = 'AND'): Record<string, unknown> {
  return {
    properties: {
      type: 'OR',
      values: [
        {
          type: joiner,
          values: rules.filter((r) => r.key).map((r) =>
            r.kind === 'behavioral'
              ? {
                type: 'behavioral',
                key: r.key,
                event_type: 'events',
                value: r.verb ?? 'performed_event',
                time_value: r.days ?? 30,
                time_interval: 'day',
                ...(r.verb === 'performed_event_multiple' ? { operator: 'gte', operator_value: r.times ?? 1 } : {}),
              }
              : {
                type: 'person',
                key: r.key,
                value: r.operator === 'is_set' || r.operator === 'is_not_set' ? r.operator : r.value,
                operator: r.operator ?? 'exact',
              }
          ),
        },
      ],
    },
  }
}

/* ─────────── sessions ─────────── */

export interface Recording {
  id: string
  distinctId: string
  personId?: string
  personName: string
  personEmail?: string
  start: string
  end?: string
  durationS: number
  activeS: number
  clicks: number
  keypresses: number
  consoleErrors: number
  consoleWarns: number
  startUrl?: string
  viewed: boolean
  ongoing: boolean
  activityScore?: number
  browser?: string
  os?: string
  device?: string
  country?: string
}

/** Real `session_recordings` row → Recording (tolerates older field names). */
export function normalizeRecording(r: Record<string, unknown>): Recording {
  const person = (r.person ?? {}) as { id?: string; uuid?: string; name?: string; distinct_ids?: string[]; properties?: Record<string, unknown> }
  const props = person.properties ?? {}
  const email = (props.email as string | undefined) ?? undefined
  const distinct = String(r.distinct_id ?? person.distinct_ids?.[0] ?? '')
  return {
    id: String(r.id ?? r.session_id ?? ''),
    distinctId: distinct,
    personId: person.uuid ?? (person.id != null ? String(person.id) : undefined),
    personName: String(person.name ?? props.name ?? email ?? distinct ?? 'Anonymous'),
    personEmail: email,
    start: String(r.start_time ?? ''),
    end: r.end_time ? String(r.end_time) : undefined,
    durationS: Number(r.recording_duration ?? r.duration ?? 0),
    activeS: Number(r.active_seconds ?? 0),
    clicks: Number(r.click_count ?? 0),
    keypresses: Number(r.keypress_count ?? 0),
    consoleErrors: Number(r.console_error_count ?? 0),
    consoleWarns: Number(r.console_warn_count ?? 0),
    startUrl: (r.start_url as string | undefined) ?? undefined,
    viewed: !!r.viewed,
    ongoing: !!r.ongoing,
    activityScore: r.activity_score != null ? Number(r.activity_score) : undefined,
    browser: (props.$browser as string | undefined) ?? undefined,
    os: (props.$os as string | undefined) ?? undefined,
    device: (props.$device_type as string | undefined) ?? undefined,
    country: (props.$geoip_country_code as string | undefined) ?? undefined,
  }
}

export interface RecordingFilter {
  person?: string
  minDurationS?: number
  errorsOnly?: boolean
  url?: string
  unwatched?: boolean
}

export function filterRecordings(list: Recording[], f: RecordingFilter): Recording[] {
  const person = f.person?.trim().toLowerCase()
  const url = f.url?.trim().toLowerCase()
  return list.filter((r) => {
    if (f.errorsOnly && r.consoleErrors === 0) return false
    if (f.minDurationS && r.durationS < f.minDurationS) return false
    if (f.unwatched && r.viewed) return false
    if (url && !(r.startUrl ?? '').toLowerCase().includes(url)) return false
    if (person && ![r.personName, r.personEmail, r.distinctId].some((x) => (x ?? '').toLowerCase().includes(person))) return false
    return true
  })
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—'
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

/* ─────────── hooks ─────────── */

export function usePHQuery<T>(key: unknown[], query: Record<string, unknown> | null, map: (r: unknown) => T, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['ph', 'query', ...key, query],
    queryFn: async () => map(await runQuery(query!)),
    enabled: !!query && (opts.enabled ?? true),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: noRetryOnClientError,
  })
}

export function useHogQL<T = Record<string, unknown>>(key: unknown[], query: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['ph', 'hogql', ...key, query],
    queryFn: async () => rowsOf<T>(await hogql(query!)),
    enabled: !!query && (opts.enabled ?? true),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: noRetryOnClientError,
  })
}

export interface EventDefinition {
  name: string
  volume_30_day?: number | null
  last_seen_at?: string | null
}

export function useEventDefinitions() {
  return useQuery({
    queryKey: ['ph', 'event-definitions'],
    queryFn: async () => {
      const r = await ph<{ results: EventDefinition[] }>('/event_definitions/?limit=500&ordering=-last_seen_at')
      return (r.results ?? []).filter((e) => e.name)
    },
    staleTime: 5 * 60_000,
    retry: noRetryOnClientError,
  })
}

export function usePropertyDefinitions(type: 'event' | 'person') {
  return useQuery({
    queryKey: ['ph', 'property-definitions', type],
    queryFn: async () => {
      const r = await ph<{ results: Array<{ name: string; property_type?: string | null }> }>(`/property_definitions/?type=${type}&limit=500`)
      return (r.results ?? []).map((p) => p.name).filter(Boolean)
    },
    staleTime: 5 * 60_000,
    retry: noRetryOnClientError,
  })
}

export interface SavedInsight {
  id: number
  short_id: string
  name: string | null
  derived_name?: string | null
  description?: string | null
  query?: unknown
  filters?: unknown
  last_modified_at?: string
  created_at?: string
  created_by?: { first_name?: string } | null
  saved?: boolean
}

/** Saved insights whose query is a given kind (FunnelsQuery, TrendsQuery …). */
export function useSavedInsights(kind?: string) {
  return useQuery({
    queryKey: ['ph', 'insights', kind ?? 'all'],
    queryFn: async () => {
      const r = await ph<{ results: SavedInsight[] }>(`/insights/?saved=true&limit=200&order=-last_modified_at${kind === 'FunnelsQuery' ? '&insight=FUNNELS' : ''}`)
      const list = r.results ?? []
      if (!kind) return list
      return list.filter((i) => {
        const src = ((i.query as { source?: { kind?: string } })?.source ?? i.query) as { kind?: string } | undefined
        if (src?.kind) return src.kind === kind
        return kind === 'FunnelsQuery' && (i.filters as { insight?: string } | undefined)?.insight === 'FUNNELS'
      })
    },
    staleTime: 60_000,
    retry: noRetryOnClientError,
  })
}

export function useSaveInsight() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id?: number; name: string; description?: string; source: Record<string, unknown> }) => {
      const body = { name: p.name, description: p.description ?? '', saved: true, query: { kind: 'InsightVizNode', source: p.source } }
      return p.id
        ? ph<SavedInsight>(`/insights/${p.id}/`, { method: 'PATCH', json: body })
        : ph<SavedInsight>('/insights/', { method: 'POST', json: body })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ph', 'insights'] }),
  })
}

export function useDeleteInsight() {
  const qc = useQueryClient()
  return useMutation({
    // PostHog soft-deletes insights with PATCH {deleted: true}.
    mutationFn: (id: number) => ph(`/insights/${id}/`, { method: 'PATCH', json: { deleted: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ph', 'insights'] }),
  })
}

export function usePHCohorts() {
  return useQuery({
    queryKey: ['ph', 'cohorts'],
    queryFn: async () => {
      const r = await ph<{ results: RawCohort[] }>('/cohorts/?limit=200')
      return (r.results ?? []).filter((c) => !c.deleted)
    },
    staleTime: 60_000,
    retry: noRetryOnClientError,
    // A cohort that is still calculating gets its count shortly — re-read at
    // the poll floor until it settles, then stop.
    refetchInterval: (q) => ((q.state.data as RawCohort[] | undefined)?.some((c) => c.is_calculating) ? 60_000 : false),
  })
}

export interface CohortPerson {
  id: string
  name?: string
  distinct_ids?: string[]
  properties?: Record<string, unknown>
  created_at?: string
}

export function useCohortPersons(id: string | number | null) {
  return useQuery({
    queryKey: ['ph', 'cohort-persons', id],
    queryFn: async () => {
      const r = await ph<{ results: CohortPerson[] }>(`/cohorts/${id}/persons/?limit=25`)
      return r.results ?? []
    },
    enabled: id != null,
    staleTime: 60_000,
    retry: noRetryOnClientError,
  })
}

export function useSaveCohort() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id?: number | string; name: string; description?: string; filters: Record<string, unknown> }) => {
      const body = { name: p.name, description: p.description ?? '', filters: p.filters, is_static: false }
      return p.id
        ? ph<RawCohort>(`/cohorts/${p.id}/`, { method: 'PATCH', json: body })
        : ph<RawCohort>('/cohorts/', { method: 'POST', json: body })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ph', 'cohorts'] }),
  })
}

export function useRecordings(p: { range: DateRangeId; personUuid?: string; limit?: number }) {
  return useQuery({
    queryKey: ['ph', 'recordings', p.range, p.personUuid ?? '', p.limit ?? 100],
    queryFn: async () => {
      const qs = new URLSearchParams({ limit: String(p.limit ?? 100), date_from: p.range, order: 'start_time' })
      if (p.personUuid) qs.set('person_uuid', p.personUuid)
      const r = await ph<{ results: Array<Record<string, unknown>>; has_next?: boolean }>(`/session_recordings/?${qs}`)
      return { list: (r.results ?? []).map(normalizeRecording).filter((x) => x.id), hasNext: !!r.has_next }
    },
    // Recordings land minutes after a session ends; the list is read on open
    // (and on range change) rather than re-polled.
    staleTime: 2 * 60_000,
    retry: noRetryOnClientError,
  })
}

export function useFlags() {
  return useQuery({
    queryKey: ['ph', 'flags'],
    queryFn: async () => {
      const r = await ph<{ results: RawFlag[] }>('/feature_flags/?limit=200')
      return (r.results ?? []).filter((f) => !f.deleted)
    },
    staleTime: 30_000,
    retry: noRetryOnClientError,
  })
}

export interface Experiment {
  id: number | string
  name: string
  feature_flag_key?: string
  feature_flag?: { id?: number; key?: string } | null
  start_date?: string | null
  end_date?: string | null
  archived?: boolean
}

export function useExperiments() {
  return useQuery({
    queryKey: ['ph', 'experiments'],
    queryFn: async () => (await ph<{ results: Experiment[] }>('/experiments/?limit=200')).results ?? [],
    staleTime: 60_000,
    retry: false,
  })
}

export function useSaveFlag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { id?: string; body: Record<string, unknown> }) =>
      p.id
        ? ph<RawFlag>(`/feature_flags/${p.id}/`, { method: 'PATCH', json: p.body })
        : ph<RawFlag>('/feature_flags/', { method: 'POST', json: p.body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ph', 'flags'] }),
  })
}

/** Day-by-day `$feature_flag_called` evaluations of one flag, split by response. */
export function flagUsageHogQL(key: string, days = 14): string {
  return `select toStartOfDay(timestamp) as day, toString(properties.$feature_flag_response) as response, count() as evaluations, uniq(person_id) as users
from events
where event = '$feature_flag_called' and properties.$feature_flag = ${hogqlString(key)} and timestamp >= now() - interval ${days} day
group by day, response
order by day`
}

/** Events of one session in time order. */
export function sessionEventsHogQL(sessionId: string): string {
  return `select uuid, event, timestamp, properties.$current_url as url, properties.$pathname as path, properties.$exception_message as exception, properties.$el_text as el_text
from events
where $session_id = ${hogqlString(sessionId)}
order by timestamp asc
limit 500`
}
