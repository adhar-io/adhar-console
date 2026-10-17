import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { TIME_RANGES, type TimeRangeId } from './observability.ts'

/**
 * Direct Prometheus / Loki HTTP helpers for the Discover dashboard, metrics
 * explorer and service map.
 *
 * Everything goes through the console BFF tool proxy (`/api/svc/<tool>`), which
 * adds the Mimir `/prometheus` prefix when the backend is Mimir. These helpers
 * always talk to the real backend — there is no fixture fallback — so a widget
 * either shows real samples or an honest "no data / exporter missing" state.
 */

export const PROM_BASE = '/api/svc/prometheus'
export const LOKI_BASE = '/api/svc/loki'

/** One series of a range query: label set + [epoch ms, value] samples. */
export interface RangeSeries {
  metric: Record<string, string>
  points: Array<[number, number]>
}

/** One sample of an instant vector. */
export interface InstantSample {
  metric: Record<string, string>
  value: number
}

export class PromError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'PromError'
    this.status = status
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' }, signal })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON error page */
  }
  const b = body as { status?: string; error?: string } | null
  if (!res.ok || (b?.status && b.status !== 'success')) {
    const msg = b?.error ?? (res.status === 503 ? 'backend is not configured for this install' : `HTTP ${res.status}`)
    throw new PromError(msg, res.ok ? 400 : res.status)
  }
  return body as T
}

interface MatrixBody {
  data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]>; value?: [number, string] }> }
}

/** Parse a Prometheus/Loki matrix body into RangeSeries (non-finite samples dropped). */
export function parseMatrix(body: MatrixBody): RangeSeries[] {
  return (body?.data?.result ?? []).map((r) => ({
    metric: r.metric ?? {},
    points: (r.values ?? [])
      .map(([t, v]) => [Number(t) * 1000, Number(v)] as [number, number])
      .filter(([, v]) => Number.isFinite(v)),
  }))
}

/** Parse an instant vector (or scalar) body into samples. */
export function parseVector(body: MatrixBody): InstantSample[] {
  const d = body?.data
  if (d?.resultType === 'scalar') {
    const raw = (d as unknown as { result: [number, string] }).result
    const v = Number(raw?.[1])
    return Number.isFinite(v) ? [{ metric: {}, value: v }] : []
  }
  return (d?.result ?? [])
    .map((r) => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) }))
    .filter((s) => Number.isFinite(s.value))
}

export async function promRange(
  query: string,
  startMs: number,
  endMs: number,
  stepSec: number,
  signal?: AbortSignal,
): Promise<RangeSeries[]> {
  const qs = new URLSearchParams({
    query,
    start: String(startMs / 1000),
    end: String(endMs / 1000),
    step: String(stepSec),
  })
  return parseMatrix(await getJson<MatrixBody>(`${PROM_BASE}/api/v1/query_range?${qs}`, signal))
}

export async function promInstant(query: string, timeMs?: number, signal?: AbortSignal): Promise<InstantSample[]> {
  const qs = new URLSearchParams({ query })
  if (timeMs) qs.set('time', String(timeMs / 1000))
  return parseVector(await getJson<MatrixBody>(`${PROM_BASE}/api/v1/query?${qs}`, signal))
}

/** Loki metric query (`count_over_time` …) over a range — same matrix shape. */
export async function lokiRange(
  query: string,
  startMs: number,
  endMs: number,
  stepSec: number,
  signal?: AbortSignal,
): Promise<RangeSeries[]> {
  const qs = new URLSearchParams({
    query,
    start: String(startMs * 1e6),
    end: String(endMs * 1e6),
    step: String(stepSec),
  })
  return parseMatrix(await getJson<MatrixBody>(`${LOKI_BASE}/loki/api/v1/query_range?${qs}`, signal))
}

/* ─────────── metadata ─────────── */

export interface MetricMeta {
  type: string
  help: string
  unit: string
}

export async function promMetricNames(): Promise<string[]> {
  const b = await getJson<{ data?: string[] }>(`${PROM_BASE}/api/v1/label/__name__/values`)
  return (b.data ?? []).slice().sort()
}

export async function promMetadata(): Promise<Record<string, MetricMeta>> {
  const b = await getJson<{ data?: Record<string, Array<{ type?: string; help?: string; unit?: string }>> }>(
    `${PROM_BASE}/api/v1/metadata`,
  )
  const out: Record<string, MetricMeta> = {}
  for (const [name, list] of Object.entries(b.data ?? {})) {
    const m = list?.[0] ?? {}
    out[name] = { type: m.type ?? 'unknown', help: m.help ?? '', unit: m.unit ?? '' }
  }
  return out
}

export async function promLabelNames(match?: string): Promise<string[]> {
  const qs = new URLSearchParams()
  if (match) qs.append('match[]', match)
  qs.set('start', String(Math.floor(Date.now() / 1000) - 3600))
  const b = await getJson<{ data?: string[] }>(`${PROM_BASE}/api/v1/labels?${qs}`)
  return (b.data ?? []).filter((l) => l !== '__name__').sort()
}

export async function promLabelValues(label: string, match?: string): Promise<string[]> {
  const qs = new URLSearchParams()
  if (match) qs.append('match[]', match)
  qs.set('start', String(Math.floor(Date.now() / 1000) - 3600))
  const b = await getJson<{ data?: string[] }>(`${PROM_BASE}/api/v1/label/${encodeURIComponent(label)}/values?${qs}`)
  return (b.data ?? []).slice().sort()
}

/* ─────────── time / step ─────────── */

export function rangeMs(id: TimeRangeId): number {
  return TIME_RANGES.find((r) => r.id === id)?.ms ?? 3_600_000
}

const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400]

/** Step (seconds) giving ~`points` samples across the window, snapped to a tidy value. */
export function autoStep(windowMs: number, points = 120): number {
  const raw = windowMs / 1000 / points
  return NICE_STEPS.find((s) => s >= raw) ?? NICE_STEPS[NICE_STEPS.length - 1]
}

/**
 * Rate window for a given step, like Grafana's `$__rate_interval`: never below
 * 5m (two scrapes at the slowest common interval), and at least two steps so
 * long ranges don't skip samples between points.
 */
export function rateWindow(stepSec: number): string {
  const s = Math.max(300, stepSec * 2)
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}

/* ─────────── hooks ─────────── */

/** Metric names Prometheus knows — drives exporter detection and the browser. */
export function useMetricNames() {
  return useQuery({
    queryKey: ['prom', 'names'],
    queryFn: promMetricNames,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useMetricMetadata() {
  return useQuery({
    queryKey: ['prom', 'metadata'],
    queryFn: promMetadata,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

export interface RangeOpts {
  /** Window end is "now" at fetch time; this is the window length. */
  windowMs: number
  stepSec?: number
  refreshMs?: number | false
  enabled?: boolean
  source?: 'prometheus' | 'loki'
}

/** One range query; the window slides to "now" on every refetch. */
export function useRange(query: string | null, opts: RangeOpts) {
  const step = opts.stepSec ?? autoStep(opts.windowMs)
  const src = opts.source ?? 'prometheus'
  return useQuery({
    queryKey: ['prom', 'range', src, query, opts.windowMs, step],
    queryFn: ({ signal }) => {
      const end = Date.now()
      const fn = src === 'loki' ? lokiRange : promRange
      return fn(query!, end - opts.windowMs, end, step, signal)
    },
    enabled: !!query && (opts.enabled ?? true),
    refetchInterval: opts.refreshMs ?? false,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/** A keyed set of range queries run in parallel; each settles on its own. */
export function useRangeSet<K extends string>(queries: Record<K, string | null>, opts: RangeOpts) {
  const step = opts.stepSec ?? autoStep(opts.windowMs)
  const keys = Object.keys(queries) as K[]
  const results = useQueries({
    queries: keys.map((k) => ({
      queryKey: ['prom', 'range', 'prometheus', queries[k], opts.windowMs, step],
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        const end = Date.now()
        return promRange(queries[k]!, end - opts.windowMs, end, step, signal)
      },
      enabled: !!queries[k] && (opts.enabled ?? true),
      refetchInterval: opts.refreshMs ?? false,
      placeholderData: keepPreviousData,
      retry: false,
    })),
  })
  const out = {} as Record<K, (typeof results)[number]>
  keys.forEach((k, i) => (out[k] = results[i]))
  return out
}

/** A keyed set of instant queries; each settles on its own. */
export function useInstantSet<K extends string>(
  queries: Record<K, string | null>,
  opts: { refreshMs?: number | false; enabled?: boolean } = {},
) {
  const keys = Object.keys(queries) as K[]
  const results = useQueries({
    queries: keys.map((k) => ({
      queryKey: ['prom', 'instant', queries[k]],
      queryFn: ({ signal }: { signal: AbortSignal }) => promInstant(queries[k]!, undefined, signal),
      enabled: !!queries[k] && (opts.enabled ?? true),
      refetchInterval: opts.refreshMs ?? false,
      placeholderData: keepPreviousData,
      retry: false,
    })),
  })
  const out = {} as Record<K, (typeof results)[number]>
  keys.forEach((k, i) => (out[k] = results[i]))
  return out
}
