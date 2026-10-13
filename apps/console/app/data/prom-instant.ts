import { useQuery } from '@tanstack/react-query'

/**
 * Instant PromQL for Overview panels.
 *
 * Most panels read the Kubernetes API, but several signals only exist as
 * metrics — Hubble's L7 golden signals, Cilium's policy-enforcement counts,
 * Falco and Kyverno result totals. Those come from the console's `prometheus`
 * tool (the in-cluster kube-prometheus Prometheus, or Mimir as a fallback).
 *
 * A panel asks for a named set of queries at once, so one panel is one
 * request round and one loading state. Every query may legitimately return
 * an empty vector — the exporter may not be installed — and the panel says
 * so rather than drawing a zero.
 */

const PROM_BASE = '/api/svc/prometheus'

export interface PromSample {
  labels: Record<string, string>
  value: number
}

interface PromVector {
  status?: string
  data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }
  error?: string
}

export async function promInstant(query: string): Promise<PromSample[]> {
  const res = await fetch(`${PROM_BASE}/api/v1/query?${new URLSearchParams({ query })}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(
      res.status === 503 ? 'Prometheus is not configured for this install.' : `Prometheus returned HTTP ${res.status}.`,
    )
  }
  const body = (await res.json()) as PromVector
  if (body.status && body.status !== 'success') throw new Error(body.error ?? 'Prometheus query failed.')
  return (body.data?.result ?? [])
    .map((r) => ({ labels: r.metric ?? {}, value: Number(r.value?.[1]) }))
    .filter((s) => Number.isFinite(s.value))
}

/**
 * Run a named set of instant queries together. A query that fails on its own
 * (bad metric on this version, say) comes back as an empty vector so the rest
 * of the panel still renders; only a transport failure — Prometheus missing —
 * fails the whole set.
 */
export function usePromInstant<K extends string>(key: string, queries: Record<K, string>, refetchMs = 30_000) {
  return useQuery({
    queryKey: ['ov', 'prom', key, queries],
    queryFn: async (): Promise<Record<K, PromSample[]>> => {
      const entries = Object.entries(queries) as Array<[K, string]>
      const settled = await Promise.allSettled(entries.map(([, q]) => promInstant(q)))
      const transport = settled.find(
        (s): s is PromiseRejectedResult => s.status === 'rejected' && /not configured|HTTP 5\d\d/.test(String(s.reason?.message)),
      )
      if (transport && settled.every((s) => s.status === 'rejected')) throw transport.reason
      return Object.fromEntries(
        entries.map(([k], i) => [k, settled[i].status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<PromSample[]>).value : []]),
      ) as Record<K, PromSample[]>
    },
    refetchInterval: refetchMs,
    staleTime: refetchMs / 2,
  })
}

/** First sample's value, or null when the vector is empty. */
export const scalar = (v: PromSample[] | undefined): number | null => (v && v.length ? v[0].value : null)

/** Sum of a vector, or null when it is empty. */
export const total = (v: PromSample[] | undefined): number | null =>
  v && v.length ? v.reduce((a, s) => a + s.value, 0) : null

/** A range-query series, in Prometheus's own wire shape. */
export interface PromSeries {
  metric: Record<string, string>
  values: Array<[number, string]>
}

/** Range query over `[now - windowMs, now]` at `stepS` resolution. */
export async function promRange(query: string, windowMs: number, stepS: number): Promise<PromSeries[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - Math.floor(windowMs / 1000)
  const qs = new URLSearchParams({ query, start: String(start), end: String(end), step: String(stepS) })
  const res = await fetch(`${PROM_BASE}/api/v1/query_range?${qs}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(
      res.status === 503 ? 'Prometheus is not configured for this install.' : `Prometheus returned HTTP ${res.status}.`,
    )
  }
  const body = (await res.json()) as { status?: string; error?: string; data?: { result?: PromSeries[] } }
  if (body.status && body.status !== 'success') throw new Error(body.error ?? 'Prometheus query failed.')
  return (body.data?.result ?? []).map((r) => ({ metric: r.metric ?? {}, values: r.values ?? [] }))
}
