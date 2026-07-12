import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { gitea } from '@adhar-console/api-clients'

/**
 * Gitea hooks for the Develop module. Stub-backed in dev so the IDE,
 * repo cards, branch picker, and PR drawers all render without a live
 * Gitea behind them.
 */

export const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
export const ORG = 'acme'

const REFRESH_MS = 30_000

/* ─────────── selection ─────────── */

const REPO_KEY = 'adhar.develop.activeRepo'
const BRANCH_KEY = 'adhar.develop.activeBranch'

export function getStoredRepo(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage.getItem(REPO_KEY) ?? undefined
}
export function setStoredRepo(name: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(REPO_KEY, name)
}
export function getStoredBranch(repo: string): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage.getItem(`${BRANCH_KEY}:${repo}`) ?? undefined
}
export function setStoredBranch(repo: string, branch: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`${BRANCH_KEY}:${repo}`, branch)
}

/* ─────────── queries ─────────── */

export function useRepos() {
  return useQuery({
    queryKey: ['gitea', 'repos', ORG],
    queryFn: () => giteaClient.listRepos(ORG),
    staleTime: REFRESH_MS,
  })
}

export function useRepo(repo?: string) {
  return useQuery({
    queryKey: ['gitea', 'repo', ORG, repo],
    queryFn: () => giteaClient.getRepo(ORG, repo!),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  })
}

export function useBranches(repo?: string) {
  return useQuery({
    queryKey: ['gitea', 'branches', ORG, repo],
    queryFn: () => giteaClient.listBranches(ORG, repo!),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  })
}

export function useCommits(repo?: string, ref?: string, limit = 50) {
  return useQuery({
    queryKey: ['gitea', 'commits', ORG, repo, ref, limit],
    queryFn: () => giteaClient.listCommits(ORG, repo!, ref, limit),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  })
}

export function usePullRequests(repo?: string, state: 'open' | 'closed' | 'all' = 'open') {
  return useQuery({
    queryKey: ['gitea', 'prs', ORG, repo, state],
    queryFn: () => giteaClient.listPullRequests(ORG, repo!, state),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  })
}

/** PRs across every repo in the org — flattened. Used by the dashboard. */
export function useAllOpenPullRequests() {
  const repos = useRepos()
  return useQuery({
    queryKey: ['gitea', 'prs-flat', ORG, repos.data?.map((r) => r.name).join(',')],
    queryFn: async () => {
      if (!repos.data) return []
      const out: Array<gitea.PullRequest & { repo: string }> = []
      for (const r of repos.data) {
        const list = await giteaClient.listPullRequests(ORG, r.name, 'open')
        out.push(...list.map((p) => ({ ...p, repo: r.name })))
      }
      return out
    },
    enabled: !!repos.data?.length,
    staleTime: REFRESH_MS,
  })
}

export function useIssues(repo?: string, state: 'open' | 'closed' | 'all' = 'open') {
  return useQuery({
    queryKey: ['gitea', 'issues', ORG, repo, state],
    queryFn: () => giteaClient.listIssues(ORG, repo!, state),
    enabled: !!repo,
    staleTime: REFRESH_MS,
  })
}

export function useTree(repo?: string, ref?: string, path = '') {
  return useQuery({
    queryKey: ['gitea', 'tree', ORG, repo, ref, path],
    queryFn: () => giteaClient.listTree(ORG, repo!, ref!, path),
    enabled: !!repo && !!ref,
    staleTime: REFRESH_MS,
  })
}

export function useFile(repo?: string, ref?: string, path?: string) {
  return useQuery({
    queryKey: ['gitea', 'file', ORG, repo, ref, path],
    queryFn: () => giteaClient.getFile(ORG, repo!, ref!, path!),
    enabled: !!repo && !!ref && !!path,
    staleTime: REFRESH_MS,
  })
}

export function useSaveFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      repo,
      ref,
      path,
      content,
      message,
      sha,
    }: {
      repo: string
      ref: string
      path: string
      content: string
      message: string
      sha?: string
    }) => giteaClient.saveFile(ORG, repo, ref, path, { content, message, sha }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['gitea', 'file', ORG, vars.repo, vars.ref, vars.path] })
      qc.invalidateQueries({ queryKey: ['gitea', 'commits', ORG, vars.repo] })
    },
  })
}
