import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useDeleteView, useLabels, useMembers, useStates, useViews } from '../data/plane.ts'
import { CreateViewModal } from '../components/create-forms.tsx'
import { ListToolbar } from '../components/list-toolbar.tsx'
import { issueQueryChips, readIssueQuery, type SavedIssueQuery } from '../data/view-query.ts'

/**
 * Saved Views — Plane's per-project filter bookmarks. Each view's `query_data`
 * renders as a resolved chip strip (ids → names), and Open re-applies the
 * saved filter set to the Issues board.
 */
export function Views({
  projectId,
  onApply,
}: {
  projectId?: string
  /** Applies a saved view's filters to the Issues board (handled by the shell). */
  onApply?(query: SavedIssueQuery): void
}) {
  const q = useViews(projectId)
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const remove = useDeleteView(projectId)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')

  const chipCtx = useMemo(
    () => ({ states: states.data, labels: labels.data, members: members.data }),
    [states.data, labels.data, members.data],
  )

  if (!projectId) return <EmptyState title="Pick a project" />
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading views…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }
  const all = q.data ?? []
  const f = search.trim().toLowerCase()
  const rows = f
    ? all.filter(
        (v) =>
          v.name.toLowerCase().includes(f) || (v.description ?? '').toLowerCase().includes(f),
      )
    : all
  return (
    <div className="space-y-4">
      <ListToolbar
        count={all.length}
        noun="saved view"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search views…"
        onNew={() => setCreateOpen(true)}
        newLabel="New view"
        disabled={createOpen}
      />

      {all.length === 0 ? (
        <EmptyState
          title="No saved views"
          description="Click New view to capture a filter set — or hit Save view on the Issues page."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No matches"
          description={`No views match "${search}". Try a different keyword.`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((v) => {
            const chips = issueQueryChips(v.query_data, chipCtx)
            return (
              <Card key={v.id} className="group relative" interactive>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-content">{v.name}</div>
                      {v.description ? (
                        <div className="mt-0.5 line-clamp-2 text-xs text-content-muted">
                          {v.description}
                        </div>
                      ) : null}
                    </div>
                    <StatusBadge kind={v.access === 'public' ? 'info' : 'unknown'}>
                      {v.access ?? 'public'}
                    </StatusBadge>
                  </div>
                </CardHeader>
                <CardBody className="space-y-3">
                  {chips.length ? (
                    <div className="flex flex-wrap gap-1">
                      {chips.map((chip, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted"
                        >
                          <span className="text-content-subtle">{chip.key}</span>
                          <span className="text-content">{chip.value}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] text-content-subtle">
                      No filters — shows all issues.
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[11px] text-content-subtle">
                    <span>{v.created_at ? `Saved ${formatRelative(v.created_at)}` : null}</span>
                    <div className="flex items-center gap-1">
                      {onApply ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => onApply(readIssueQuery(v.query_data))}
                        >
                          Open
                        </Button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm(`Delete view "${v.name}"?`)) return
                          remove.mutate(v.id)
                        }}
                        className="rounded-md px-2 py-0.5 text-[11px] font-medium text-rose-700 opacity-0 transition-opacity hover:bg-rose-50 group-hover:opacity-100"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}

      <CreateViewModal
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  )
}
