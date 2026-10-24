import { useQuery } from '@tanstack/react-query'

/**
 * Instant PromQL for Overview panels.
 *
 * Most panels read the Kubernetes API, but several signals only exist as
 * metrics — Hubble's L7 golden signals, Cilium's policy-enforcement counts,
 * Falco and Kyverno result totals. Those come from the console's `prometheus`
 * tool (the adhar-controlplane kube-prometheus Prometheus, or Mimir as a fallback).
 *
 * A panel asks for a named set of queries at once, so one panel is one
 * request round and one loading state. Every query may legitimately return
 * an empty vector — the exporter may not be installed — and the panel says
 * so rather than drawing a zero.
 */

export interface PromSample {
  labels: Record<string, string>
  value: number
}

interface PromVector {
  status?: string
  data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }
  error?: string
}

/* ─────────── batching ───────────
 *
 * Every query issued in the same instant — all the panels of a page mounting,
 * or their minute timers firing together — goes out as ONE `POST
 * /api/prom/batch` instead of one request per query. The BFF fans them out
 * to Prometheus and caches each answer briefly per user, so tabs and panels
 * asking the same thing share one evaluation.
 */

interface BatchItem {
  kind: 'instant' | 'range'
  query: string
  start?: number
  end?: number
  step?: number
}
interface Pending {
  item: BatchItem
  resolve(v: { status: number; body: unknown }): void
  reject(e: unknown): void
}

/** How long to gather queries before sending — long enough to catch a page's panels. */
const BATCH_WINDOW_MS = 40
const BATCH_MAX = 64
let queue: Pending[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined

async function flush() {
  flushTimer = undefined
  const batch = queue
  queue = []
  for (let i = 0; i < batch.length; i += BATCH_MAX) {
    const chunk = batch.slice(i, i + BATCH_MAX)
    try {
      const res = await fetch('/api/prom/batch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ items: chunk.map((p) => p.item) }),
      })
      if (!res.ok) throw new Error(`Prometheus returned HTTP ${res.status}.`)
      const { results } = (await res.json()) as { results: Array<{ status: number; body: unknown }> }
      chunk.forEach((p, j) => p.resolve(results[j] ?? { status: 502, body: null }))
    } catch (e) {
      for (const p of chunk) p.reject(e)
    }
  }
}

function enqueue(item: BatchItem): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    queue.push({ item, resolve, reject })
    flushTimer ??= setTimeout(() => void flush(), BATCH_WINDOW_MS)
  })
}

function promError(status: number): Error {
  return new Error(status === 503 ? 'Prometheus is not configured for this install.' : `Prometheus returned HTTP ${status}.`)
}

export async function promInstant(query: string): Promise<PromSample[]> {
  const { status, body: raw } = await enqueue({ kind: 'instant', query })
  if (status !== 200) throw promError(status)
  const body = (raw ?? {}) as PromVector
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
export function usePromInstant<K extends string>(key: string, queries: Record<K, string>, refetchMs = 60_000) {
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

/**
 * Range query over `[now - windowMs, now]` at `stepS` resolution. The window
 * end snaps to the step grid, so repeats within a step are the same query
 * (and the BFF's cache answers them).
 */
export async function promRange(query: string, windowMs: number, stepS: number): Promise<PromSeries[]> {
  const step = Math.max(1, Math.floor(stepS))
  const end = Math.floor(Date.now() / 1000 / step) * step
  const start = end - Math.floor(windowMs / 1000)
  const { status, body: raw } = await enqueue({ kind: 'range', query, start, end, step })
  if (status !== 200) throw promError(status)
  const body = (raw ?? {}) as { status?: string; error?: string; data?: { result?: PromSeries[] } }
  if (body.status && body.status !== 'success') throw new Error(body.error ?? 'Prometheus query failed.')
  return (body.data?.result ?? []).map((r) => ({ metric: r.metric ?? {}, values: r.values ?? [] }))
}
