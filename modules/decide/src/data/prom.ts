/**
 * Prometheus through the console BFF (`/api/svc/prometheus`). Failures throw —
 * a panel decides how to degrade and names Prometheus as the missing source.
 */

export const PROM_BASE = '/api/svc/prometheus'

export interface PromVector {
  metric: Record<string, string>
  value: [number, string]
}

export interface PromMatrix {
  metric: Record<string, string>
  values: Array<[number, string]>
}

interface PromResponse<T> {
  status: string
  error?: string
  data?: { resultType: string; result: T[] }
}

async function promFetch<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const res = await fetch(`${PROM_BASE}${path}?${new URLSearchParams(params)}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw Object.assign(new Error(`Prometheus request failed (${res.status})`), { status: res.status })
  const json = (await res.json()) as PromResponse<T>
  if (json.status !== 'success' || !json.data) throw new Error(json.error ?? 'Prometheus query failed')
  return json.data.result
}

export function promInstant(query: string): Promise<PromVector[]> {
  return promFetch<PromVector>('/api/v1/query', { query })
}

/** Range query; `step` in seconds is raised so the range stays under 10k points. */
export function promRange(query: string, startMs: number, endMs: number, step: number): Promise<PromMatrix[]> {
  const s = Math.max(step, Math.ceil((endMs - startMs) / 1000 / 10_000))
  return promFetch<PromMatrix>('/api/v1/query_range', {
    query,
    start: String(Math.floor(startMs / 1000)),
    end: String(Math.floor(endMs / 1000)),
    step: String(s),
  })
}

export function num(v: string | undefined): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
