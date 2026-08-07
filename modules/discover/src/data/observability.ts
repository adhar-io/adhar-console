import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lgtm, posthog } from '@adhar-console/api-clients'

/**
 * Discover hooks layer — wraps the LGTM stack (Loki / Mimir / Tempo /
 * Grafana / Alertmanager / SLOs) and PostHog analytics.
 *
 * Stub-backed in dev so every view renders rich data without a live LGTM
 * or PostHog instance behind the BFF.
 */

export const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })
export const phClient = posthog.PostHogClient.auto({ tool: 'posthog' })

const REFRESH_MS = 15_000

/* ─────────── time helpers ─────────── */

export const TIME_RANGES = [
  { id: '5m', label: '5m', ms: 5 * 60_000 },
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60_000 },
] as const
export type TimeRangeId = (typeof TIME_RANGES)[number]['id']
export const DEFAULT_RANGE: TimeRangeId = '1h'

export function rangeToWindow(id: TimeRangeId): { start: Date; end: Date } {
  const ms = TIME_RANGES.find((r) => r.id === id)?.ms ?? 60 * 60_000
  const end = new Date()
  const start = new Date(end.getTime() - ms)
  return { start, end }
}

/**
 * A time selection is either one of the quick presets or an absolute
 * from/to window (ISO strings so it hashes stably into a query key).
 */
export type TimeSelection =
  | { kind: 'preset'; id: TimeRangeId }
  | { kind: 'absolute'; from: string; to: string }

export const presetSelection = (id: TimeRangeId): TimeSelection => ({ kind: 'preset', id })

export function selectionToWindow(sel: TimeSelection): { start: Date; end: Date } {
  if (sel.kind === 'absolute') return { start: new Date(sel.from), end: new Date(sel.to) }
  return rangeToWindow(sel.id)
}

/** Human label for the toolbar / histogram header. */
export function selectionLabel(sel: TimeSelection): string {
  if (sel.kind === 'preset') return `last ${TIME_RANGES.find((r) => r.id === sel.id)?.label ?? sel.id}`
  const f = new Date(sel.from)
  const t = new Date(sel.to)
  const fmt = (d: Date) =>
    `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${fmt(f)} → ${fmt(t)}`
}

/* ─────────── LGTM ─────────── */

export function useLogs(query: string, sel: TimeSelection, limit = 200) {
  const { start, end } = selectionToWindow(sel)
  return useQuery({
    queryKey: ['lgtm', 'logs', query, sel],
    queryFn: () => lgtmClient.queryLogs(query, start, end, limit),
    refetchInterval: REFRESH_MS,
  })
}

/* ─────────── log volume histogram (derived from real logs) ─────────── */

/** One time bucket of the log-volume histogram, split by level bucket. */
export interface HistogramBucket {
  /** epoch ms — bucket start / end. */
  start: number
  end: number
  info: number
  warn: number
  error: number
}

export type HistogramLevel = 'info' | 'warn' | 'error'
export const HISTOGRAM_LEVELS: HistogramLevel[] = ['error', 'warn', 'info']

/** Collapse a log entry's level onto one of the three histogram buckets. */
function histogramLevelOf(level: lgtm.LogEntry['level']): HistogramLevel {
  if (level === 'error' || level === 'fatal') return 'error'
  if (level === 'warn') return 'warn'
  return 'info'
}

/**
 * Bucket real log lines by timestamp across [start, end), split by level.
 * This is the actual observed volume of the returned stream — no synthetic
 * fill — so a sparse stream renders sparsely and an error burst shows up
 * exactly where it happened.
 */
export function bucketLogsByLevel(
  logs: lgtm.LogEntry[],
  start: Date,
  end: Date,
  buckets = 48,
): HistogramBucket[] {
  const t0 = start.getTime()
  const t1 = end.getTime()
  const width = Math.max(1, t1 - t0) / buckets
  const out: HistogramBucket[] = []
  for (let i = 0; i < buckets; i++) {
    out.push({ start: t0 + i * width, end: t0 + (i + 1) * width, info: 0, warn: 0, error: 0 })
  }
  for (const l of logs) {
    const t = new Date(l.timestamp).getTime()
    if (Number.isNaN(t) || t < t0 || t > t1) continue
    let idx = Math.floor((t - t0) / width)
    if (idx < 0) idx = 0
    if (idx >= buckets) idx = buckets - 1
    out[idx][histogramLevelOf(l.level)] += 1
  }
  return out
}

export function useMetrics(query: string, range: TimeRangeId, step = '1m') {
  const { start, end } = rangeToWindow(range)
  return useQuery({
    queryKey: ['lgtm', 'metrics', query, range, step],
    queryFn: () => lgtmClient.queryMetrics(query, start, end, step),
    refetchInterval: REFRESH_MS,
  })
}

export function useTraces(filter: { service?: string; minDurationMs?: number; status?: 'error' | 'ok' }) {
  return useQuery({
    queryKey: ['lgtm', 'traces', filter],
    queryFn: () => lgtmClient.searchTraces(filter),
    refetchInterval: REFRESH_MS,
  })
}

/* ─────────── span detail ─────────── */

/**
 * A timestamped event recorded during a span (OTel span event) and a span
 * carrying its real attributes, status message, and events — both sourced
 * straight from the Tempo trace response the LGTM client parses.
 */
export type SpanEvent = lgtm.SpanEvent
export type SpanDetail = lgtm.Span

export function useTrace(traceID?: string) {
  return useQuery({
    queryKey: ['lgtm', 'trace', traceID],
    queryFn: (): Promise<SpanDetail[]> => lgtmClient.getTrace(traceID!),
    enabled: !!traceID,
  })
}

export function useServiceMap() {
  return useQuery({
    queryKey: ['lgtm', 'service-map'],
    queryFn: () => lgtmClient.serviceMap(),
    staleTime: 30_000,
  })
}

export function useServices() {
  return useQuery({
    queryKey: ['lgtm', 'services'],
    queryFn: () => lgtmClient.listServices(),
    staleTime: 30_000,
  })
}

export function useAlerts() {
  return useQuery({
    queryKey: ['lgtm', 'alerts'],
    queryFn: () => lgtmClient.listAlerts(),
    refetchInterval: REFRESH_MS,
  })
}

export function useSilenceAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ fingerprint, durationMin }: { fingerprint: string; durationMin: number }) =>
      lgtmClient.silenceAlert(fingerprint, durationMin),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lgtm', 'alerts'] }),
  })
}

export function useSlos() {
  return useQuery({
    queryKey: ['lgtm', 'slos'],
    queryFn: () => lgtmClient.listSlos(),
    refetchInterval: 30_000,
  })
}

export function useGrafanaDashboards() {
  return useQuery({
    queryKey: ['lgtm', 'dashboards'],
    queryFn: () => lgtmClient.listDashboards(),
    staleTime: 60_000,
  })
}

export function grafanaEmbedUrl(uid: string, params?: Record<string, string>) {
  return lgtmClient.grafanaEmbedUrl(uid, params)
}

/* ─────────── PostHog ─────────── */

export function useAnalyticsEvents(filter?: { event?: string; sinceMs?: number }) {
  return useQuery({
    queryKey: ['posthog', 'events', filter?.event ?? 'all', filter?.sinceMs ?? 0],
    queryFn: () => phClient.listEvents(filter),
    refetchInterval: REFRESH_MS,
  })
}

export function usePersons(search?: string) {
  return useQuery({
    queryKey: ['posthog', 'persons', search ?? ''],
    queryFn: () => phClient.listPersons({ search }),
    staleTime: 30_000,
  })
}

export function useInsights(type?: posthog.InsightType) {
  return useQuery({
    queryKey: ['posthog', 'insights', type ?? 'all'],
    queryFn: () => phClient.listInsights(type ? { type } : undefined),
    staleTime: 30_000,
  })
}

export function useInsight(id?: string) {
  return useQuery({
    queryKey: ['posthog', 'insight', id],
    queryFn: () => phClient.getInsight(id!),
    enabled: !!id,
    staleTime: 30_000,
  })
}

export function useCohorts() {
  return useQuery({
    queryKey: ['posthog', 'cohorts'],
    queryFn: () => phClient.listCohorts(),
    staleTime: 60_000,
  })
}

export function useFeatureFlags() {
  return useQuery({
    queryKey: ['posthog', 'flags'],
    queryFn: () => phClient.listFeatureFlags(),
    staleTime: 60_000,
  })
}

export function useToggleFlag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      phClient.toggleFeatureFlag(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['posthog', 'flags'] }),
  })
}

export function useSessions(filter?: { hasErrors?: boolean }) {
  return useQuery({
    queryKey: ['posthog', 'sessions', filter?.hasErrors ?? false],
    queryFn: () => phClient.listSessions(filter),
    refetchInterval: 30_000,
  })
}

/* ─────────── series helpers ─────────── */

/** MetricSeries values → AreaChart points. */
export function seriesToPoints(s: lgtm.MetricSeries): number[] {
  return s.values.map(([, v]) => Number(v))
}
