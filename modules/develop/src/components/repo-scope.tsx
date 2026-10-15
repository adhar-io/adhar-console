import { useCallback, useEffect } from 'react'
import { EmptyState, Spinner } from '@adhar/shell-ui'
import { getStoredRepo, setStoredRepo, useRepos } from '../data/git.ts'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { RepoPicker } from './repo-picker.tsx'

/**
 * The repo a repo-scoped view works on: `?repo=` first (so links land on
 * the right one), then the last repo used in this browser, then the first
 * repo in the org. Picking one writes both the URL and the stored choice.
 */
export function useScopedRepo() {
  const repos = useRepos()
  const params = useDevelopParams()
  const setParams = useSetDevelopParams()
  const names = repos.data?.map((r) => r.name) ?? []
  const stored = getStoredRepo()
  const repo = params.repo && names.includes(params.repo)
    ? params.repo
    : stored && names.includes(stored)
    ? stored
    : names[0]

  const setRepo = useCallback((n: string) => {
    setStoredRepo(n)
    setParams({ repo: n, branch: undefined, sha: undefined })
  }, [setParams])

  // Make the implicit choice explicit in the URL, so it can be shared.
  useEffect(() => {
    if (repo && params.repo !== repo && repos.data) setParams({ repo })
  }, [repo, params.repo, repos.data, setParams])

  return { repo, setRepo, repos }
}

/**
 * Repo-scoped wrapper for views that need an active repo (used by the
 * repo-drawer-free views). Renders a small scope bar above the children.
 */
export function RepoScope({ children }: { children(repo: string): React.ReactNode }) {
  const { repo, setRepo, repos } = useScopedRepo()
  if (repos.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading repos…
      </div>
    )
  }
  if (!repos.data?.length) {
    return <EmptyState title="No repositories" description="Connect a Gitea org first." />
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-default bg-surface-raised p-2 shadow-sm">
        <RepoPicker value={repo} onChange={setRepo} />
        <span className="text-[11px] text-content-muted">scope</span>
      </div>
      {repo ? children(repo) : null}
    </div>
  )
}
