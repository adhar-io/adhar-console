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

/* ─────────── LGTM ─────────── */

export function useLogs(query: string, range: TimeRangeId, limit = 200) {
  const { start, end } = rangeToWindow(range)
  return useQuery({
    queryKey: ['lgtm', 'logs', query, range],
    queryFn: () => lgtmClient.queryLogs(query, start, end, limit),
    refetchInterval: REFRESH_MS,
  })
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

export function useTrace(traceID?: string) {
  return useQuery({
    queryKey: ['lgtm', 'trace', traceID],
    queryFn: () => lgtmClient.getTrace(traceID!),
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
