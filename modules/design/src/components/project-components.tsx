import { useMemo, useState } from 'react'
import { Button, EmptyState, SearchInput, Skeleton } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { DesignScope } from '../data/design-scope.ts'
import { useRepoComponentScans, type RepoScan } from '../data/repo-components-scan.ts'
import { useGiteaFileUrl } from '../data/gitea.ts'
import { useGoDesign } from '../data/nav.ts'
import { useScopeRepos } from './token-integrations.tsx'
import { IconArrowRight } from './ux-kit.tsx'
import { Icon } from './ui-bits.tsx'

/**
 * The project's own UI components, discovered from the repositories its
 * catalog applications deploy (best effort, cached 15 minutes per repo):
 * exported PascalCase names from `components/**.tsx`, with a link to the
 * source and the Visual Designer.
 */
export function ProjectComponents({ scope, shellNames }: { scope: DesignScope; shellNames: string[] }) {
  const { repos, loading, error } = useScopeRepos(scope)
  const targets = useMemo(() => repos.filter((r) => r.inScope).map((r) => ({ fullName: r.fullName, branch: r.defaultBranch })), [repos])
  const scans = useRepoComponentScans(targets, shellNames)
  const fileUrl = useGiteaFileUrl()
  const go = useGoDesign()
  const [q, setQ] = useState('')

  if (error) return <EmptyState compact title="Could not list repositories" description={error.message} />
  if (loading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} height={56} className="block w-full" rounded="lg" />)}</div>
  if (!targets.length) {
    return (
      <EmptyState
        icon={<Icon name="component" size={22} />}
        title={`No application repositories in ${scope.label}`}
        description="Components are discovered from the Gitea repositories of the platform Applications in this scope. Deploy an application from the Service Catalog, or pick another project."
      />
    )
  }

  const needle = q.trim().toLowerCase()
  const total = scans.reduce((n, s) => n + (s.data?.components.length ?? 0), 0)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Find a component" className="w-full sm:w-72" />
        <span className="text-xs text-content-muted">
          {total} component{total === 1 ? '' : 's'} in {targets.length} repositor{targets.length === 1 ? 'y' : 'ies'}
        </span>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" onClick={() => scans.forEach((s) => void s.refetch())}>Rescan</Button>
        </div>
      </div>
      {targets.map((t, i) => (
        <RepoBlock
          key={t.fullName}
          repo={t.fullName}
          branch={t.branch}
          scan={scans[i]?.data}
          loading={!!scans[i]?.isLoading}
          error={(scans[i]?.error as Error | null) ?? null}
          needle={needle}
          fileUrl={fileUrl}
          onDesign={() => go('builder', { repo: t.fullName, branch: t.branch })}
        />
      ))}
    </div>
  )
}

function RepoBlock({
  repo,
  branch,
  scan,
  loading,
  error,
  needle,
  fileUrl,
  onDesign,
}: {
  repo: string
  branch: string
  scan?: RepoScan
  loading: boolean
  error: Error | null
  needle: string
  fileUrl: (repo: string, branch: string, path: string) => string | undefined
  onDesign(): void
}) {
  const name = repo.split('/').pop() ?? repo
  const list = (scan?.components ?? []).filter((c) => !needle || `${c.name} ${c.path}`.toLowerCase().includes(needle))
  return (
    <section className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge-subtle px-4 py-2.5">
        <span className="font-mono text-sm font-medium text-content">{repo}</span>
        <span className="font-mono text-[11px] text-content-subtle">{branch}</span>
        {scan ? (
          <span className="text-[11px] text-content-subtle">
            {scan.components.length} exports from {scan.filesScanned} file{scan.filesScanned === 1 ? '' : 's'}
            {scan.truncated ? ` (first ${scan.filesScanned} of ${scan.filesFound} scanned)` : ''}
          </span>
        ) : null}
        <button type="button" onClick={onDesign} className="ml-auto inline-flex items-center gap-1 text-xs text-brand-700 hover:underline dark:text-brand-300">
          Open in Visual Designer <IconArrowRight size={11} />
        </button>
      </header>
      {loading ? (
        <div className="px-4 py-3 text-xs text-content-muted">Scanning {name}…</div>
      ) : error ? (
        <div className="px-4 py-3 text-xs text-rose-600 dark:text-rose-400">Could not scan: {error.message}</div>
      ) : !scan?.components.length ? (
        <div className="px-4 py-3 text-xs text-content-muted">
          {scan?.filesFound ? 'No exported PascalCase components found.' : 'No files under a components/ folder.'}
        </div>
      ) : list.length === 0 ? (
        <div className="px-4 py-3 text-xs text-content-subtle">Nothing matches.</div>
      ) : (
        <ul className="grid grid-cols-1 divide-y divide-edge-subtle sm:grid-cols-2 sm:divide-y-0">
          {list.map((c) => {
            const href = fileUrl(name, branch, c.path)
            return (
              <li key={`${c.path}:${c.name}`} className={cn('flex min-w-0 items-center gap-2 px-4 py-2 sm:border-b sm:border-edge-subtle')}>
                <span className="font-mono text-xs font-semibold text-content">{c.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content-subtle" title={c.path}>{c.path}</span>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] text-brand-700 hover:underline dark:text-brand-300">Source</a>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** shell-ui usage counted across project scans already in cache (no extra requests). */
export function useShellUsage(scope: DesignScope, shellNames: string[]): Map<string, number> | null {
  const { repos } = useScopeRepos(scope)
  const targets = useMemo(() => repos.filter((r) => r.inScope).map((r) => ({ fullName: r.fullName, branch: r.defaultBranch })), [repos])
  const scans = useRepoComponentScans(targets, shellNames, false)
  return useMemo(() => {
    const done = scans.filter((s) => s.data)
    if (!done.length) return null
    const out = new Map<string, number>()
    for (const s of done) for (const [k, v] of Object.entries(s.data!.shellUsage)) out.set(k, (out.get(k) ?? 0) + v)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scans.map((s) => s.dataUpdatedAt).join(',')])
}
