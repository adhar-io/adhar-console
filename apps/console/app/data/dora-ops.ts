import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { gitea, lgtm } from '@adhar-console/api-clients'
import {
  type AlertSeries,
  type Incident,
  incidentsFromSeries,
} from './dora-incidents.ts'
import {
  type DeployRevision,
  deployRevisions,
  type LeadTimeSummary,
  leadTimeSummary,
  repoKeys,
} from './dora-lead-time.ts'
import type { DoraApp } from './platform-signals.ts'

/**
 * Incident history for the Overview's MTTR and change-failure-rate tiles.
 *
 * Both need to know when things broke and when they came back, which is not
 * something Argo CD can answer. It comes from Prometheus's `ALERTS` series
 * range-queried over the window — see `dora-incidents.ts` for why that works
 * when `/api/v1/alerts` (current state only) does not.
 *
 * The query deliberately filters severity server-side. Pulling every alert and
 * discarding `info` in the browser costs bandwidth on a cluster with a noisy
 * rule set, and `ALERTS` is one series per firing alert instance — on a large
 * cluster that is thousands.
 */

const lgtmClient = lgtm.LgtmClient.auto({ tool: 'prometheus' })
const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

/**
 * Lead time looks further back than the incident window: deploys are frequent
 * but a 7-day sample of commit→deploy times is thin on a quiet week.
 */
export const LEAD_TIME_WINDOW_DAYS = 30

/** Commits fetched per repository — one request that resolves most deploys. */
export const COMMIT_PAGE = 100

/** Matches the Deploys tile's window, so the tiles describe the same period. */
export const WINDOW_DAYS = 7

/**
 * Sampling resolution, and therefore the accuracy of every recovery time.
 *
 * Five minutes over seven days is 2016 points per series — comfortably under
 * Prometheus's 11k per-series point cap, with room for the query to stay
 * responsive on a cluster with many firing alerts. It also sets the floor on
 * a reported MTTR: incidents shorter than one step read as five minutes.
 */
export const STEP_MS = 5 * 60_000

const REFRESH_MS = 60_000

export interface DoraOps {
  incidents: Incident[]
  /** End of the queried window — what "still firing" is judged against. */
  windowEndMs: number
  isLoading: boolean
  isError: boolean
  /** Why the tiles are empty, when they are. */
  error: Error | null
}

export function useDoraOps(): DoraOps {
  // Pin the window to the step grid so the query key is stable between
  // renders; keying on `Date.now()` would refetch on every render and never
  // hit the cache.
  const windowEndMs = Math.floor(Date.now() / STEP_MS) * STEP_MS
  const startMs = windowEndMs - WINDOW_DAYS * 24 * 3_600_000

  const q = useQuery({
    queryKey: ['ov', 'dora', 'incidents', windowEndMs],
    queryFn: async (): Promise<AlertSeries[]> => {
      const series = await lgtmClient.queryMetrics(
        'ALERTS{alertstate="firing",severity=~"critical|warning"}',
        new Date(startMs),
        new Date(windowEndMs),
        `${STEP_MS / 1000}s`,
      )
      return series as AlertSeries[]
    },
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS,
    retry: false,
  })

  const incidents = q.data ? incidentsFromSeries(q.data, STEP_MS, windowEndMs) : []

  return {
    incidents,
    windowEndMs,
    isLoading: q.isLoading,
    isError: q.isError,
    error: (q.error as Error | null) ?? null,
  }
}

/* ─────────────────────────── lead time ─────────────────────────── */

/**
 * Median commit→deploy time — the actual DORA "lead time for changes".
 *
 * Argo CD supplies the deployed SHA and when it went live; Gitea supplies when
 * that SHA was authored. Commits are fetched per repository rather than per
 * SHA: a page of recent commits is one request that resolves most deploys,
 * where a lookup per deploy would be a hundred requests on every page load.
 * A deploy whose commit falls outside that page is reported as unresolved
 * rather than dropped — see `leadTimeSummary`.
 */
export function useDoraLeadTime(apps: DoraApp[] | undefined): LeadTimeSummary & {
  isLoading: boolean
  isError: boolean
} {
  const sinceMs = Math.floor(Date.now() / STEP_MS) * STEP_MS - LEAD_TIME_WINDOW_DAYS * 24 * 3_600_000

  const deploys = useMemo(() => {
    const out: DeployRevision[] = []
    for (const a of apps ?? []) {
      out.push(
        ...deployRevisions(a.status?.history ?? [], sinceMs, a.spec?.sources ?? (a.spec?.source ? [a.spec.source] : undefined)),
      )
    }
    return out
  }, [apps, sinceMs])

  const repos = useMemo(() => repoKeys(deploys), [deploys])

  const q = useQuery({
    // Keyed on the repo set, not on the deploy list: the commit pages only
    // need refetching when a new repository appears.
    queryKey: ['ov', 'dora', 'commits', repos.map((r) => `${r.org}/${r.repo}`).sort().join(',')],
    enabled: repos.length > 0,
    queryFn: async () => {
      const map = new Map<string, number>()
      await Promise.all(
        repos.map(async (r) => {
          try {
            const commits = await giteaClient.listCommits(r.org, r.repo, '', COMMIT_PAGE)
            for (const c of commits) {
              const t = new Date(c.created).getTime()
              if (Number.isFinite(t)) map.set(c.sha.toLowerCase(), t)
            }
          } catch {
            // One unreadable repo must not blank the whole metric.
          }
        }),
      )
      return map
    },
    staleTime: 5 * REFRESH_MS,
    retry: false,
  })

  const summary = leadTimeSummary(deploys, q.data ?? new Map())
  return {
    ...summary,
    isLoading: repos.length > 0 && q.isLoading,
    isError: q.isError,
  }
}
