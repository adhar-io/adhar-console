import { useQuery } from '@tanstack/react-query'
import { gitea } from '@adhar-console/api-clients'
import { useGiteaOrg } from '@adhar-console/shell-ui'

/**
 * DORA flow metrics that ArgoCD alone can't provide.
 *
 * `DoraRadarPanel` derives deploy frequency and change-failure rate from ArgoCD.
 * **Lead time for changes** needs a commit/merge source — we compute it honestly
 * from Gitea: the median time from a pull request opening to it merging, across
 * PRs merged in the trailing window. That's the widely-used "PR cycle time"
 * proxy for lead time, and it's real data, not a fabricated number.
 *
 * MTTR is intentionally *not* computed here: restoring-service time needs an
 * incident source with open+resolve timestamps (Alertmanager history, an
 * incident tracker). Prometheus `/alerts` only lists currently-active alerts, so
 * there is nothing to measure a recovery against — the panel shows "—" until
 * such a source is wired, rather than inventing a value.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

const WINDOW_DAYS = 30
const REFRESH_MS = 60_000
/** Cap repos scanned so the Overview stays snappy on large orgs. */
const MAX_REPOS = 40

export interface DoraFlow {
  /** Median PR open→merge time in hours over the window, or null if none merged. */
  leadTimeHours: number | null
  /** Count of merged PRs the median is based on. */
  sampleSize: number
  isLoading: boolean
  isError: boolean
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function useDoraFlow(): DoraFlow {
  const org = useGiteaOrg()

  const q = useQuery({
    queryKey: ['ov', 'dora', 'lead-time', org],
    queryFn: async () => {
      const repos = await giteaClient.listRepos(org)
      const since = Date.now() - WINDOW_DAYS * 24 * 3600_000
      const durations: number[] = []
      for (const r of repos.slice(0, MAX_REPOS)) {
        let prs: gitea.PullRequest[]
        try {
          prs = await giteaClient.listPullRequests(org, r.name, 'closed')
        } catch {
          continue // repo without PR access — skip, don't fail the whole metric
        }
        for (const p of prs) {
          if (!p.merged || !p.merged_at) continue
          const merged = new Date(p.merged_at).getTime()
          const created = new Date(p.created_at).getTime()
          if (!Number.isFinite(merged) || !Number.isFinite(created)) continue
          if (merged < since) continue
          const hours = (merged - created) / 3600_000
          if (hours >= 0) durations.push(hours)
        }
      }
      return durations
    },
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS,
    retry: false,
  })

  const durations = q.data ?? []
  return {
    leadTimeHours: durations.length ? median(durations) : null,
    sampleSize: durations.length,
    isLoading: q.isLoading,
    isError: q.isError,
  }
}

/** Lead-time hours → 0..1 score vs the DORA elite benchmark (< 24h = elite). */
export function leadTimeScore(hours: number): number {
  if (hours <= 24) return 1 // elite: less than one day
  if (hours <= 24 * 7) return 0.7 // high: less than one week
  if (hours <= 24 * 30) return 0.4 // medium: less than one month
  return 0.2 // low
}

/** Compact human label for a lead time in hours. */
export function formatLeadTime(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}
