import { useEffect, useState } from 'react'
import { EmptyState, Spinner } from '@adhar-console/shell-ui'
import {
  getStoredRepo,
  setStoredRepo,
  useRepos,
} from '../data/git.ts'
import { RepoPicker } from './repo-picker.tsx'

/**
 * Repo-scoped wrapper for views that need an active repo. Restores the
 * last-used repo from localStorage and renders a small scope bar above
 * the children.
 */
export function RepoScope({ children }: { children(repo: string): React.ReactNode }) {
  const repos = useRepos()
  const [repo, setRepo] = useState<string | undefined>(undefined)

  useEffect(() => {
    setRepo((cur) => cur ?? getStoredRepo() ?? undefined)
  }, [])
  useEffect(() => {
    if (!repo && repos.data?.length) setRepo(repos.data[0].name)
  }, [repo, repos.data])

  const onPick = (n: string) => {
    setRepo(n)
    setStoredRepo(n)
  }

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
        <RepoPicker value={repo} onChange={onPick} />
        <span className="text-[11px] text-content-muted">scope</span>
      </div>
      {repo ? children(repo) : null}
    </div>
  )
}
