/**
 * Prometheus for the platform module, through the BFF proxy.
 *
 * Every panel that draws a time series (pod metrics, the database insight in
 * the Adhar Resources drawer) reads the same Prometheus the same way, so the
 * plumbing lives here once: the proxy prefix, the response shapes, and the two
 * query forms. Callers own their PromQL and their refresh cadence.
 *
 * Failures are thrown, not swallowed — a panel decides how to degrade (the
 * pod view shows a setup note, the database view keeps its topology and drops
 * only the traffic tiles). Nothing here retries: Prometheus being absent is a
 * fact about the platform, not a transient.
 */

export const PROM_BASE = '/api/svc/prometheus'

/** A chart point: value in native units, time in ms. Shell-ui's charts accept it as-is. */
export interface Point {
  v: number
  t: number
}

export interface PromMatrix {
  metric: Record<string, string>
  values: Array<[number, string]>
}

export interface PromVector {
  metric: Record<string, string>
  value: [number, string]
}

interface PromResponse<T> {
  status: string
  error?: string
  data?: { resultType: string; result: T[] }
}

async function promFetch<T>(path: string, params: URLSearchParams): Promise<T[]> {
  const res = await fetch(`${PROM_BASE}${path}?${params.toString()}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Prometheus request failed (${res.status} ${res.statusText})`)
  const json = (await res.json()) as PromResponse<T>
  if (json.status !== 'success' || !json.data) throw new Error(json.error ?? 'Prometheus query failed')
  return json.data.result
}

/** `query_range` over the last `seconds`, sampled every `step` seconds. */
export function promRange(
  query: string,
  cfg: { seconds: number; step: number },
): Promise<PromMatrix[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - cfg.seconds
  return promFetch<PromMatrix>(
    '/api/v1/query_range',
    new URLSearchParams({ query, start: String(start), end: String(end), step: String(cfg.step) }),
  )
}

/** Instant `query` — one sample per series, now. */
export function promInstant(query: string): Promise<PromVector[]> {
  return promFetch<PromVector>('/api/v1/query', new URLSearchParams({ query }))
}

/** A single matrix series → chart points (v in native units, t in ms). */
export function toPoints(series: PromMatrix | undefined): Point[] {
  if (!series) return []
  return series.values.map(([t, v]) => ({ v: Number(v), t: t * 1000 }))
}

/** Last numeric value of a series (the "current" reading). */
export function lastValue(series: PromMatrix | undefined): number | undefined {
  if (!series || series.values.length === 0) return undefined
  const raw = series.values[series.values.length - 1][1]
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** The one number an aggregate instant query yields, or undefined when empty / NaN. */
export function scalarOf(vector: PromVector[] | undefined): number | undefined {
  if (!vector || vector.length === 0) return undefined
  const n = Number(vector[0].value[1])
  return Number.isFinite(n) ? n : undefined
}
