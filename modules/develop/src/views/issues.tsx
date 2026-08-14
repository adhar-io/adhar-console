import { useState } from 'react'
import { Card, CardBody, EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useIssues } from '../data/git.ts'
import { RepoScope } from '../components/repo-scope.tsx'

export function Issues() {
  return (
    <RepoScope>
      {(repo) => <IssueList repo={repo} />}
    </RepoScope>
  )
}

function IssueList({ repo }: { repo: string }) {
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open')
  const q = useIssues(repo, state)

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading issues…
      </div>
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't load issues" description={q.error instanceof Error ? q.error.message : ''} />
  }
  const list = q.data ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-sm">
        {(['open', 'closed', 'all'] as const).map((s) => {
          const on = state === s
          return (
            <button
              key={s}
              type="button"
              onClick={() => setState(s)}
              className={
                on
                  ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
                  : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
              }
            >
              {s}
            </button>
          )
        })}
      </div>

      {list.length === 0 ? (
        <EmptyState title="No issues" description={`No ${state} issues in ${repo}.`} />
      ) : (
        <Card>
          <CardBody className="p-0!">
            <ul className="divide-y divide-edge-subtle">
              {list.map((it) => (
                <li
                  key={it.id}
                  className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-brand-50/40"
                >
                  <code className="mt-0.5 font-mono text-[10px] text-content-muted">#{it.number}</code>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-content">{it.title}</span>
                      <StatusBadge kind={it.state === 'open' ? 'info' : 'unknown'}>{it.state}</StatusBadge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
                      <span>{it.user.login}</span>
                      <span>· opened {formatRelative(it.created_at)}</span>
                      {it.comments != null ? <span>· {it.comments} comment{it.comments === 1 ? '' : 's'}</span> : null}
                      <div className="ml-auto flex flex-wrap gap-1">
                        {it.labels.map((l) => (
                          <span
                            key={l.name}
                            className="rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset"
                            style={{ color: `#${l.color}`, borderColor: `#${l.color}66` }}
                          >
                            {l.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
