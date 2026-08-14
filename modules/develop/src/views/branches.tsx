import { Card, CardBody, EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useBranches } from '../data/git.ts'
import { RepoScope } from '../components/repo-scope.tsx'

export function Branches() {
  return (
    <RepoScope>
      {(repo) => <BranchList repo={repo} />}
    </RepoScope>
  )
}

function BranchList({ repo }: { repo: string }) {
  const q = useBranches(repo)
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading branches…
      </div>
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't load branches" description={q.error instanceof Error ? q.error.message : ''} />
  }
  const list = q.data ?? []
  if (!list.length) {
    return <EmptyState title="No branches" description={`${repo} has no branches yet.`} />
  }
  return (
    <Card>
      <CardBody className="p-0!">
        <ul className="divide-y divide-edge-subtle">
          {list.map((b) => (
            <li key={b.name} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40">
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-content">
                {b.name}
              </code>
              {b.protected ? <StatusBadge kind="info">protected</StatusBadge> : null}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-content">{b.commit.message}</div>
                <div className="text-[11px] text-content-subtle">
                  {b.commit.author.name} · {formatRelative(b.commit.timestamp)}
                </div>
              </div>
              <code className="hidden font-mono text-[10px] text-content-muted sm:inline">
                {b.commit.id.slice(0, 7)}
              </code>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}
