import { Card, CardBody, EmptyState, Spinner } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useBranches, useCommits } from '../data/git.ts'
import { RepoScope } from '../components/repo-scope.tsx'

export function Commits() {
  return (
    <RepoScope>
      {(repo) => <CommitList repo={repo} />}
    </RepoScope>
  )
}

function CommitList({ repo }: { repo: string }) {
  const branches = useBranches(repo)
  const main = branches.data?.find((b) => b.protected) ?? branches.data?.[0]
  const ref = main?.name
  const q = useCommits(repo, ref, 50)

  if (q.isLoading || branches.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading commits…
      </div>
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't load commits" description={q.error instanceof Error ? q.error.message : ''} />
  }
  const list = q.data ?? []
  if (!list.length) {
    return <EmptyState title="No commits" description={`No commits on ${ref} yet.`} />
  }

  return (
    <Card>
      <CardBody className="p-0!">
        <ul className="divide-y divide-edge-subtle">
          {list.map((c) => (
            <li
              key={c.sha}
              className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40"
            >
              <img
                src={c.author.avatar_url ?? `https://i.pravatar.cc/64?u=${c.author.login}`}
                alt=""
                className="h-8 w-8 shrink-0 rounded-full ring-1 ring-edge-subtle"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-content">{c.message}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-content-subtle">
                  <span>{c.author.login}</span>
                  <span>· {formatRelative(c.created)}</span>
                  <code className="ml-2 font-mono text-[10px]">{c.short_sha}</code>
                </div>
              </div>
              {c.stats ? (
                <div className="hidden text-right text-[11px] sm:block">
                  <span className="font-mono text-emerald-700">+{c.stats.additions}</span>{' '}
                  <span className="font-mono text-rose-700">-{c.stats.deletions}</span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}
