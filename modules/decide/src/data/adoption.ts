import { useQuery } from '@tanstack/react-query'
import { gitea, metabase } from '@adhar/api-clients'
import { useGiteaOrg } from '@adhar/shell-ui'

/**
 * Platform adoption + BI highlights for the overview.
 *
 *   Teams      `/api/workspace/teams`
 *   Repos      Gitea org repositories; golden-path = repos carrying the
 *              `golden-path` topic (what the scaffolder tags its starters with)
 *   Metabase   dashboards + saved questions (scalar cards), read-only
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
const metabaseClient = metabase.MetabaseClient.auto({ tool: 'metabase' })

export function useWorkspaceTeams() {
  return useQuery({
    queryKey: ['decide', 'workspace', 'teams'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/teams', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw Object.assign(new Error(`Teams unavailable (${res.status})`), { status: res.status })
      const body = (await res.json()) as { items?: Array<{ slug: string; name: string }> }
      return body.items ?? []
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useOrgRepos() {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['decide', 'gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useBiHighlights() {
  return useQuery({
    queryKey: ['decide', 'metabase', 'highlights'],
    queryFn: async () => {
      const [dashboards, questions] = await Promise.all([
        metabaseClient.listDashboards(),
        // A failed question listing is "unknown", not "zero questions".
        metabaseClient.listQuestions().catch(() => null),
      ])
      return {
        dashboards: [...dashboards].sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0)).slice(0, 3),
        scalars: (questions ?? []).filter((q) => q.display === 'scalar' && q.scalar != null).slice(0, 4),
        totalDashboards: dashboards.length,
        totalQuestions: questions ? questions.length : null,
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}
