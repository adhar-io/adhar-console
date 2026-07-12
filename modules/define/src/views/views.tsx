import { useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { useDeleteView, useViews } from '../data/plane.ts'
import { CreateViewModal } from '../components/create-forms.tsx'
import { ListToolbar } from '../components/list-toolbar.tsx'

/**
 * Saved Views — Plane's per-project filter bookmarks. Renders each view's
 * `query_data` as a chip strip so operators can read at-a-glance what each
 * filter does.
 */
export function Views({ projectId }: { projectId?: string }) {
  const q = useViews(projectId)
  const remove = useDeleteView(projectId)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')

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
          description="Click New view to capture a blank starter — or save a filter set from the Issues page."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No matches"
          description={`No views match "${search}". Try a different keyword.`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((v) => (
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
                <div className="flex flex-wrap gap-1">
                  {chipsFromQuery(v.query_data).map((chip, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted"
                    >
                      <span className="text-content-subtle">{chip.key}</span>
                      <span className="text-content">{chip.value}</span>
                    </span>
                  ))}
                </div>
                <div className="flex items-center justify-between text-[11px] text-content-subtle">
                  <span>{v.created_at ? `Saved ${formatRelative(v.created_at)}` : null}</span>
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
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <CreateViewModal
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        query={{}}
      />
    </div>
  )
}

function chipsFromQuery(q: Record<string, unknown>): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) {
      out.push({ key: k, value: v.join(' / ') })
    } else if (typeof v === 'object' && v !== null) {
      out.push({ key: k, value: JSON.stringify(v) })
    } else if (v !== undefined && v !== null) {
      out.push({ key: k, value: String(v) })
    }
  }
  return out
}
