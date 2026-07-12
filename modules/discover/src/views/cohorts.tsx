import { Card, CardBody, EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useCohorts } from '../data/observability.ts'

export function Cohorts() {
  const q = useCohorts()
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading cohorts…
      </div>
    )
  }
  const list = q.data ?? []
  if (list.length === 0) {
    return <EmptyState title="No cohorts" description="Define a cohort in PostHog to populate this list." />
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {list.map((c) => (
        <Card key={c.id}>
          <CardBody className="space-y-3 p-5">
            <div>
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-content">{c.name}</span>
                <StatusBadge kind={c.is_static ? 'unknown' : 'info'}>{c.is_static ? 'static' : 'live'}</StatusBadge>
              </div>
              {c.description ? (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-content-muted">{c.description}</p>
              ) : null}
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold tabular-nums text-content">{c.count}</span>
              <span className="text-xs text-content-muted">people</span>
            </div>
            {c.groups?.length ? (
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Filters</div>
                <div className="flex flex-wrap gap-1 font-mono text-[10px]">
                  {c.groups.map((g, i) => (
                    <span key={i} className="rounded bg-surface-sunken px-1.5 py-0.5 text-content-muted">
                      <span className="text-content">{g.property}</span> {g.operator} {g.value}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="text-[11px] text-content-subtle">
              Created {formatRelative(c.created_at)}
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}
