/**
 * Thin fetch helpers for the raw backend APIs the richer Discover views need
 * (Prometheus instant queries, Loki metric queries, Tempo TraceQL search,
 * Alertmanager through Grafana). Everything goes through the console BFF tool
 * proxy (`/api/svc/<tool>/…`, cookie-authenticated) — the same path the LGTM
 * client uses — so there is no new auth surface.
 *
 * Errors carry `.status` / `.name` in the shape `views/states.tsx` classifies
 * (404/501 → not configured, 502-504 → unavailable, NetworkError → unreachable).
 */

export class BackendError extends Error {
  constructor(message: string, readonly status?: number, name = 'BackendError') {
    super(message)
    this.name = name
  }
}

export async function svcJson<T>(tool: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/svc/${tool}${path.startsWith('/') ? path : `/${path}`}`, {
      credentials: 'include',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (e) {
    const err = new BackendError(e instanceof Error ? e.message : `Can't reach ${tool}`, undefined)
    err.name = 'NetworkError'
    throw err
  }
  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text) as { error?: string; message?: string }
        detail = j.error || j.message || ''
      } catch {
        detail = text.slice(0, 300)
      }
    } catch {
      /* no body */
    }
    throw new BackendError(detail ? `${tool} ${res.status}: ${detail}` : `${tool} responded ${res.status}`, res.status)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    // Some endpoints (Alertmanager DELETE) answer with an empty / non-JSON body.
    return text as unknown as T
  }
}

/* ─────────── Prometheus ─────────── */

export interface PromVectorSample {
  metric: Record<string, string>
  value: [number, string]
}
export interface PromMatrixSeries {
  metric: Record<string, string>
  values: Array<[number, string]>
}

/** Prometheus instant query → vector samples. */
export async function promInstant(query: string, time?: Date): Promise<PromVectorSample[]> {
  const qs = new URLSearchParams({ query })
  if (time) qs.set('time', String(time.getTime() / 1000))
  const body = await svcJson<{ data?: { resultType?: string; result?: unknown } }>('prometheus', `/api/v1/query?${qs}`)
  const r = body?.data?.result
  if (body?.data?.resultType === 'scalar' && Array.isArray(r)) return [{ metric: {}, value: r as [number, string] }]
  return Array.isArray(r) ? (r as PromVectorSample[]) : []
}

/** Prometheus range query → matrix series. */
export async function promRange(query: string, start: Date, end: Date, stepSec: number): Promise<PromMatrixSeries[]> {
  const qs = new URLSearchParams({
    query,
    start: String(start.getTime() / 1000),
    end: String(end.getTime() / 1000),
    step: String(Math.max(1, Math.round(stepSec))),
  })
  const body = await svcJson<{ data?: { result?: PromMatrixSeries[] } }>('prometheus', `/api/v1/query_range?${qs}`)
  return body?.data?.result ?? []
}

/** Every metric name Prometheus knows (cached by callers). */
export async function promMetricNames(): Promise<Set<string>> {
  const body = await svcJson<{ data?: string[] }>('prometheus', '/api/v1/label/__name__/values')
  return new Set(body?.data ?? [])
}

/** A finite number from a Prometheus sample value, or null (NaN / ±Inf / missing). */
export function sampleNum(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* ─────────── Loki metric queries ─────────── */

/** Loki metric query_range (matrix). */
export async function lokiMatrix(query: string, start: Date, end: Date, stepSec: number): Promise<PromMatrixSeries[]> {
  const qs = new URLSearchParams({
    query,
    start: String(start.getTime() * 1e6),
    end: String(end.getTime() * 1e6),
    step: `${Math.max(1, Math.round(stepSec))}s`,
  })
  const body = await svcJson<{ data?: { resultType?: string; result?: unknown } }>('loki', `/loki/api/v1/query_range?${qs}`)
  if (body?.data?.resultType && body.data.resultType !== 'matrix') return []
  return Array.isArray(body?.data?.result) ? (body!.data!.result as PromMatrixSeries[]) : []
}
