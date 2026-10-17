import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { BackendError, promInstant, promMetricNames, promRange, sampleNum, svcJson } from './backends.ts'
import { parseSearch, parseTagValues, parseTrace, type TraceHit, type TraceSpan } from './traceql.ts'

/**
 * Tempo + spanmetrics hooks for the Traces view. All requests go to the real
 * Tempo (`/api/svc/tempo`) and Prometheus (`/api/svc/prometheus`) through the
 * BFF; nothing here falls back to fixtures.
 */

const sec = (d: Date) => Math.floor(d.getTime() / 1000)

/** Values of a Tempo tag (v2 scoped API first, then the v1 flat API). */
async function tagValues(v2Tag: string, v1Tag: string, start: Date, end: Date, scopeQuery?: string): Promise<string[]> {
  const qs = new URLSearchParams({ start: String(sec(start)), end: String(sec(end)) })
  if (scopeQuery) qs.set('q', scopeQuery)
  try {
    return parseTagValues(await svcJson('tempo', `/api/v2/search/tag/${encodeURIComponent(v2Tag)}/values?${qs}`))
  } catch (e) {
    // 404 → an older Tempo without the v2 tag API; anything else is real.
    if ((e as BackendError).status !== 404) throw e
    const qs1 = new URLSearchParams({ start: String(sec(start)), end: String(sec(end)) })
    return parseTagValues(await svcJson('tempo', `/api/search/tag/${encodeURIComponent(v1Tag)}/values?${qs1}`))
  }
}

export function useTraceServices(start: Date, end: Date) {
  const bucket = Math.floor(end.getTime() / 60_000)
  return useQuery({
    queryKey: ['tempo', 'services', Math.floor(start.getTime() / 60_000), bucket],
    queryFn: () => tagValues('resource.service.name', 'service.name', start, end),
    staleTime: 60_000,
    retry: false,
  })
}

export function useTraceOperations(service: string | undefined, start: Date, end: Date) {
  return useQuery({
    queryKey: ['tempo', 'operations', service ?? '', Math.floor(start.getTime() / 60_000)],
    queryFn: () =>
      tagValues('name', 'name', start, end, service ? `{resource.service.name="${service.replace(/"/g, '\\"')}"}` : undefined),
    staleTime: 60_000,
    retry: false,
  })
}

/** Attribute names Tempo has indexed (for the tag-filter autocomplete). */
export function useTraceTagNames(start: Date, end: Date) {
  return useQuery({
    queryKey: ['tempo', 'tag-names', Math.floor(start.getTime() / 300_000)],
    queryFn: async () => {
      const qs = new URLSearchParams({ start: String(sec(start)), end: String(sec(end)) })
      try {
        const body = await svcJson<{ scopes?: Array<{ name: string; tags?: string[] }> }>('tempo', `/api/v2/search/tags?${qs}`)
        const out: Array<{ scope: 'span' | 'resource'; key: string }> = []
        for (const s of body?.scopes ?? []) {
          if (s.name !== 'span' && s.name !== 'resource') continue
          for (const t of s.tags ?? []) out.push({ scope: s.name, key: t })
        }
        return out
      } catch {
        const body = await svcJson<{ tagNames?: string[] }>('tempo', `/api/search/tags?${qs}`)
        return (body?.tagNames ?? []).map((key) => ({ scope: 'span' as const, key }))
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useTraceSearch(traceql: string, start: Date, end: Date, limit: number, enabled = true) {
  return useQuery({
    queryKey: ['tempo', 'search', traceql, start.toISOString(), end.toISOString(), limit],
    queryFn: async (): Promise<TraceHit[]> => {
      const qs = new URLSearchParams({
        q: traceql,
        start: String(sec(start)),
        end: String(sec(end)),
        limit: String(limit),
        spss: '5',
      })
      return parseSearch(await svcJson('tempo', `/api/search?${qs}`))
    },
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  })
}

/** A full trace (v2 endpoint first, v1 fallback), with absolute span times. */
export function useTempoTrace(traceID: string | null | undefined) {
  return useQuery({
    queryKey: ['tempo', 'trace', traceID],
    queryFn: async (): Promise<TraceSpan[]> => {
      try {
        return parseTrace(await svcJson('tempo', `/api/v2/traces/${encodeURIComponent(traceID!)}`))
      } catch (e) {
        if ((e as BackendError).status !== 404 && (e as BackendError).status !== 400) throw e
        return parseTrace(await svcJson('tempo', `/api/traces/${encodeURIComponent(traceID!)}`))
      }
    },
    enabled: !!traceID,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/* ─────────── spanmetrics (RED per service) ─────────── */

export interface SpanMetricsFamily {
  id: string
  label: string
  calls: string
  latency?: string
  /** Unit of the latency histogram's `le`. */
  unit: 's' | 'ms'
  service: string
  span: string
  status: string
  errorValue: string
}

/**
 * Known spanmetrics layouts, preference order:
 *   • Tempo metrics-generator / Grafana Beyla — `traces_spanmetrics_*`, seconds.
 *   • OTel collector spanmetrics connector ≥0.85 — `traces_span_metrics_*` / bare `calls_total`, ms.
 */
export const SPANMETRICS_FAMILIES: SpanMetricsFamily[] = [
  {
    id: 'tempo',
    label: 'Tempo metrics-generator',
    calls: 'traces_spanmetrics_calls_total',
    latency: 'traces_spanmetrics_latency_bucket',
    unit: 's',
    service: 'service',
    span: 'span_name',
    status: 'status_code',
    errorValue: 'STATUS_CODE_ERROR',
  },
  {
    id: 'otel-connector',
    label: 'OTel spanmetrics connector',
    calls: 'traces_span_metrics_calls_total',
    latency: 'traces_span_metrics_duration_milliseconds_bucket',
    unit: 'ms',
    service: 'service_name',
    span: 'span_name',
    status: 'status_code',
    errorValue: 'STATUS_CODE_ERROR',
  },
  {
    id: 'otel-connector-legacy',
    label: 'OTel spanmetrics (legacy names)',
    calls: 'calls_total',
    latency: 'duration_milliseconds_bucket',
    unit: 'ms',
    service: 'service_name',
    span: 'span_name',
    status: 'status_code',
    errorValue: 'STATUS_CODE_ERROR',
  },
]

const LATENCY_ALTERNATES: Record<string, string[]> = {
  tempo: ['traces_spanmetrics_latency_bucket', 'traces_spanmetrics_duration_seconds_bucket'],
  'otel-connector': ['traces_span_metrics_duration_milliseconds_bucket', 'traces_span_metrics_duration_seconds_bucket'],
  'otel-connector-legacy': ['duration_milliseconds_bucket', 'latency_bucket', 'duration_seconds_bucket'],
}

export function useSpanMetricsFamily() {
  return useQuery({
    queryKey: ['prometheus', 'spanmetrics-family'],
    queryFn: async (): Promise<SpanMetricsFamily | null> => {
      const names = await promMetricNames()
      for (const f of SPANMETRICS_FAMILIES) {
        if (!names.has(f.calls)) continue
        const latency = (LATENCY_ALTERNATES[f.id] ?? []).find((n) => names.has(n))
        return { ...f, latency, unit: latency?.includes('seconds') || latency === 'traces_spanmetrics_latency_bucket' ? 's' : 'ms' }
      }
      return null
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export interface RedRow {
  name: string
  rps: number | null
  errorPct: number | null
  p95Ms: number | null
}

function q(s: string) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** RED per service — or per operation when `service` is given. */
export function useRedTable(fam: SpanMetricsFamily | null | undefined, service?: string) {
  return useQuery({
    queryKey: ['prometheus', 'red', fam?.id, fam?.latency, service ?? ''],
    queryFn: async (): Promise<RedRow[]> => {
      const f = fam!
      const by = service ? f.span : f.service
      const sel = service ? `${f.service}=${q(service)}` : ''
      const selErr = [sel, `${f.status}=${q(f.errorValue)}`].filter(Boolean).join(', ')
      const kindSel = `span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER|server|consumer"`
      // Prefer server/consumer spans (the service's own work); fall back to all spans.
      const mk = (extra: string) => {
        const s = [extra, kindSel].filter(Boolean).join(', ')
        return s
      }
      const [rps, err, p95] = await Promise.all([
        promInstant(`sum by (${by}) (rate(${f.calls}{${mk(sel)}}[5m])) or sum by (${by}) (rate(${f.calls}{${sel}}[5m]))`),
        promInstant(`sum by (${by}) (rate(${f.calls}{${mk(selErr)}}[5m])) or sum by (${by}) (rate(${f.calls}{${selErr}}[5m]))`),
        f.latency
          ? promInstant(
            `${f.unit === 's' ? '1000 * ' : ''}histogram_quantile(0.95, sum by (le, ${by}) (rate(${f.latency}{${sel}}[5m])))`,
          )
          : Promise.resolve([]),
      ])
      const rows = new Map<string, RedRow>()
      const row = (n: string) => {
        const r = rows.get(n) ?? { name: n, rps: null, errorPct: null, p95Ms: null }
        rows.set(n, r)
        return r
      }
      for (const s of rps) row(s.metric[by] ?? '—').rps = sampleNum(s.value[1])
      const errBy = new Map(err.map((s) => [s.metric[by] ?? '—', sampleNum(s.value[1]) ?? 0]))
      for (const r of rows.values()) {
        const e = errBy.get(r.name) ?? 0
        r.errorPct = r.rps && r.rps > 0 ? (100 * e) / r.rps : r.rps === 0 ? 0 : null
      }
      for (const s of p95) row(s.metric[by] ?? '—').p95Ms = sampleNum(s.value[1])
      return [...rows.values()].sort((a, b) => (b.rps ?? 0) - (a.rps ?? 0))
    },
    enabled: !!fam,
    refetchInterval: 30_000,
    retry: false,
  })
}

/** RED time series for one service (rate, errors/s, p95 ms). */
export function useRedSeries(fam: SpanMetricsFamily | null | undefined, service: string | undefined, start: Date, end: Date) {
  const step = Math.max(15, Math.round((end.getTime() - start.getTime()) / 1000 / 120))
  return useQuery({
    queryKey: ['prometheus', 'red-series', fam?.id, service ?? '', Math.floor(start.getTime() / 60_000), step],
    queryFn: async () => {
      const f = fam!
      const sel = service ? `${f.service}=${q(service)}` : ''
      const selErr = [sel, `${f.status}=${q(f.errorValue)}`].filter(Boolean).join(', ')
      const w = `${Math.max(60, step * 2)}s`
      const [rps, err, p95] = await Promise.all([
        promRange(`sum(rate(${f.calls}{${sel}}[${w}]))`, start, end, step),
        promRange(`sum(rate(${f.calls}{${selErr}}[${w}]))`, start, end, step),
        f.latency
          ? promRange(`${f.unit === 's' ? '1000 * ' : ''}histogram_quantile(0.95, sum by (le) (rate(${f.latency}{${sel}}[${w}])))`, start, end, step)
          : Promise.resolve([]),
      ])
      const pts = (s: typeof rps) =>
        (s[0]?.values ?? []).map(([t, v]) => [t * 1000, sampleNum(v) ?? NaN] as [number, number]).filter(([, v]) => Number.isFinite(v))
      return { rps: pts(rps), err: pts(err), p95: pts(p95) }
    },
    enabled: !!fam,
    staleTime: 30_000,
    retry: false,
  })
}
