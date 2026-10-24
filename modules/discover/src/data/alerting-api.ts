import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLiveInvalidate, usePollingInterval } from '@adhar/shell-ui'
import { BackendError, promRange, svcJson } from './backends.ts'
import {
  type AmAlert,
  type AmInhibitRule,
  type AmMatcher,
  type AmReceiver,
  type AmRoute,
  type AmSilence,
  lanesFromAlertsSeries,
  mergeAlerts,
  type PromAlert,
  type PromRuleGroup,
  receiverIntegrations,
} from './alerting.ts'

/**
 * Alerting hooks.
 *
 *   Prometheus (`/api/svc/prometheus`) — active alerts incl. pending, the rule
 *   catalogue, and `ALERTS` history for the timeline.
 *
 *   Alertmanager — not a console tool of its own; reached through Grafana,
 *   which ships an `alertmanager`-type datasource pointing at the adhar-controlplane
 *   Alertmanager. We try Grafana's Alertmanager API
 *   (`/api/alertmanager/<uid>/…`), then its raw datasource proxy
 *   (`/api/datasources/proxy/uid/<uid>/…`), then a direct `alertmanager` tool,
 *   and remember the first that answers. When none does, the view says so and
 *   falls back to Prometheus-only state (no silences).
 */

/** The console-wide poll floor — also the BFF change-detection cadence, shared with `useAlerts`. */
const REFRESH_MS = 60_000

interface AmTarget {
  tool: string
  base: string
  via: string
}

let resolved: Promise<AmTarget> | null = null

async function probe(t: AmTarget): Promise<boolean> {
  try {
    await svcJson(t.tool, `${t.base}/api/v2/status`)
    return true
  } catch (e) {
    const s = (e as BackendError).status
    // 401/403 means the path exists but we can't use it — surface that.
    if (s === 401 || s === 403) throw e
    return false
  }
}

export function resolveAlertmanager(): Promise<AmTarget> {
  if (resolved) return resolved
  resolved = (async () => {
    const uids: string[] = []
    try {
      const ds = await svcJson<Array<{ uid: string; type: string; name: string }>>('grafana', '/api/datasources')
      for (const d of ds ?? []) if (d.type === 'alertmanager') uids.push(d.uid)
    } catch {
      /* Grafana unreachable or not admin — try the conventional uid */
    }
    if (!uids.length) uids.push('alertmanager')
    const candidates: AmTarget[] = []
    for (const uid of uids) {
      candidates.push({ tool: 'grafana', base: `/api/alertmanager/${encodeURIComponent(uid)}`, via: `Grafana datasource “${uid}”` })
      candidates.push({ tool: 'grafana', base: `/api/datasources/proxy/uid/${encodeURIComponent(uid)}`, via: `Grafana proxy “${uid}”` })
    }
    candidates.push({ tool: 'alertmanager', base: '', via: 'alertmanager tool' })
    for (const c of candidates) if (await probe(c)) return c
    throw new BackendError('No Alertmanager reachable through Grafana or the console proxy', 404)
  })()
  resolved.catch(() => {
    // allow a retry later
    setTimeout(() => {
      resolved = null
    }, 30_000)
  })
  return resolved
}

async function am<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await resolveAlertmanager()
  return svcJson<T>(t.tool, `${t.base}${path}`, init)
}

export function useAmTarget() {
  return useQuery({ queryKey: ['am', 'target'], queryFn: resolveAlertmanager, staleTime: 5 * 60_000, retry: false })
}

/** Unified alerts: Alertmanager (if reachable) + Prometheus. */
export function useUnifiedAlerts() {
  const pollMs = usePollingInterval(REFRESH_MS)
  useLiveInvalidate('poll', { tool: 'prometheus', path: '/api/v1/alerts', intervalMs: REFRESH_MS }, [['alerting', 'unified']])
  return useQuery({
    queryKey: ['alerting', 'unified'],
    queryFn: async () => {
      const [amRes, promRes] = await Promise.allSettled([
        am<AmAlert[]>('/api/v2/alerts?active=true&silenced=true&inhibited=true'),
        svcJson<{ data?: { alerts?: PromAlert[] } }>('prometheus', '/api/v1/alerts'),
      ])
      if (amRes.status === 'rejected' && promRes.status === 'rejected') throw promRes.reason
      const amAlerts = amRes.status === 'fulfilled' && Array.isArray(amRes.value) ? amRes.value : null
      const promAlerts = promRes.status === 'fulfilled' ? promRes.value?.data?.alerts ?? [] : []
      return {
        alerts: mergeAlerts(amAlerts, promAlerts),
        amError: amRes.status === 'rejected' ? amRes.reason : null,
        promError: promRes.status === 'rejected' ? promRes.reason : null,
      }
    },
    refetchInterval: pollMs,
  })
}

export function useRules() {
  return useQuery({
    queryKey: ['alerting', 'rules'],
    queryFn: async () => {
      const body = await svcJson<{ data?: { groups?: PromRuleGroup[] } }>('prometheus', '/api/v1/rules?type=alert')
      return body?.data?.groups ?? []
    },
    staleTime: 30_000,
  })
}

export function useAlertTimeline(windowMs: number) {
  const step = Math.max(30, Math.round(windowMs / 1000 / 240))
  return useQuery({
    queryKey: ['alerting', 'timeline', windowMs],
    queryFn: async () => {
      const end = new Date()
      const start = new Date(end.getTime() - windowMs)
      const series = await promRange('ALERTS', start, end, step)
      return {
        start: start.getTime(),
        end: end.getTime(),
        lanes: lanesFromAlertsSeries(series.map((s) => ({ metric: s.metric, values: s.values.map(([t, v]) => [Number(t), v] as [number, string]) })), step),
      }
    },
    refetchInterval: 60_000,
  })
}

export function useSilences() {
  return useQuery({
    queryKey: ['alerting', 'silences'],
    queryFn: () => am<AmSilence[]>('/api/v2/silences'),
    // Silences change by someone's action, not on their own (expiry is
    // computed from `endsAt`); our own mutations invalidate this key.
    staleTime: 60_000,
    retry: false,
  })
}

export function useCreateSilence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: { matchers: AmMatcher[]; startsAt: string; endsAt: string; createdBy: string; comment: string; id?: string }) =>
      am<{ silenceID?: string }>('/api/v2/silences', { method: 'POST', body: JSON.stringify(s) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerting'] })
    },
  })
}

export function useExpireSilence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => am<unknown>(`/api/v2/silence/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerting'] })
    },
  })
}

export interface RoutingConfig {
  route?: AmRoute
  receivers: AmReceiver[]
  inhibitRules: AmInhibitRule[]
  /** Raw YAML when only the status endpoint's original config is available. */
  rawYaml?: string
  cluster?: { status?: string; peers?: number }
  version?: string
  uptime?: string
}

/** Routing tree, receivers and inhibition rules. */
export function useRouting() {
  return useQuery({
    queryKey: ['alerting', 'routing'],
    queryFn: async (): Promise<RoutingConfig> => {
      const t = await resolveAlertmanager()
      const status = await am<{
        config?: { original?: string }
        cluster?: { status?: string; peers?: unknown[] }
        versionInfo?: { version?: string }
        uptime?: string
      }>('/api/v2/status').catch(() => null)
      const meta = {
        cluster: status?.cluster ? { status: status.cluster.status, peers: status.cluster.peers?.length } : undefined,
        version: status?.versionInfo?.version,
        uptime: status?.uptime,
      }
      // Grafana converts the upstream config to JSON for its own UI.
      if (t.base.startsWith('/api/alertmanager/')) {
        try {
          const cfg = await svcJson<{ alertmanager_config?: { route?: AmRoute; receivers?: Array<Record<string, unknown>>; inhibit_rules?: AmInhibitRule[] } }>(
            t.tool,
            `${t.base}/config/api/v1/alerts`,
          )
          const c = cfg?.alertmanager_config
          if (c) {
            return {
              ...meta,
              route: c.route,
              receivers: (c.receivers ?? []).map((r) => ({ name: String(r.name ?? ''), integrations: receiverIntegrations(r) })),
              inhibitRules: c.inhibit_rules ?? [],
            }
          }
        } catch {
          /* fall through to the receivers list + raw YAML */
        }
      }
      const receivers = await am<Array<{ name: string }>>('/api/v2/receivers').catch((e: unknown) => (status ? null : Promise.reject(e)))
      // Status answered but receivers did not → still show what we know; when
      // neither answered the query fails so the view shows an error + retry
      // rather than an empty routing tree that reads as "nothing configured".
      return {
        ...meta,
        receivers: (receivers ?? []).map((r) => ({ name: r.name, integrations: [] })),
        inhibitRules: [],
        rawYaml: status?.config?.original,
      }
    },
    staleTime: 60_000,
    retry: false,
  })
}
