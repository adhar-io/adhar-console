import { useMemo, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { Button, EmptyState, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { useProjects, useViews } from '../data/plane.ts'
import { KINDS, type SavedView, storeError, useCreateDoc, usePutDoc, useRemoveDoc, type ViewDefault } from '../data/work-store.ts'
import { legacyQueryToWql, useSavedViews, type ViewDoc } from '../data/work-views.ts'
import { defineHref, navigateTo } from '../data/work-nav.ts'
import { readIssueQuery, type SavedIssueQuery } from '../data/view-query.ts'
import { ViewSaveModal } from '../components/view-save-modal.tsx'
import { SearchInput } from '../components/list-toolbar.tsx'
import { ConsoleSide, IconBoard, IconList, IconPlus, IconStar } from '../components/work-ui.tsx'

/**
 * Saved Views — named WQL queries for Issues and Board, shared with the team
 * or personal, starred, and one default per project. Kept console-side
 * (`define.view`): Plane's public API has no views endpoint. Opening a view
 * deep-links to `?section=issues&view=<id>` (or the board).
 */
export function Views({
  projectId,
}: {
  projectId?: string
  /** Kept for the shell's older wiring; views now open through the URL. */
  onApply?(query: SavedIssueQuery): void
}) {
  const toast = useToast()
  const { views, me, defaultId, isLoading, isError, error } = useSavedViews(projectId)
  const projects = useProjects()
  const legacy = useViews(projectId)
  const put = usePutDoc<SavedView>(KINDS.view)
  const create = useCreateDoc<SavedView>(KINDS.view)
  const remove = useRemoveDoc(KINDS.view)
  const putDefault = usePutDoc<ViewDefault>(KINDS.viewDefault)
  const [tab, setTab] = useState<'all' | 'starred' | 'mine' | 'shared'>('all')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<ViewDoc | 'new' | null>(null)

  const rows = useMemo(() => {
    const f = search.trim().toLowerCase()
    return views
      .filter((v) => tab === 'all' || (tab === 'starred' ? v.data.starredBy?.includes(me) : tab === 'mine' ? v.data.owner?.toLowerCase() === me : v.data.visibility === 'shared'))
      .filter((v) => !f || `${v.data.name} ${v.data.description ?? ''} ${v.data.jql}`.toLowerCase().includes(f))
  }, [views, tab, search, me])

  if (!projectId) return <EmptyState icon={<EmptyIcon name="folder" />} title="Pick a project" />

  const star = (v: ViewDoc) => {
    const on = v.data.starredBy?.includes(me)
    put.mutate({ id: v.id, update: (prev) => {
      const cur = prev ?? v.data
      const list = cur.starredBy ?? []
      return { ...cur, starredBy: on ? list.filter((x) => x !== me) : [...new Set([...list, me])] }
    } }, { onError: (e) => toast.error(storeError(e)) })
  }
  const setDefault = (v: ViewDoc | null) =>
    putDefault.mutate({ id: projectId, data: { viewId: v?.id ?? '' } }, {
      onSuccess: () => toast.success(v ? `“${v.data.name}” opens by default` : 'Default view cleared'),
      onError: (e) => toast.error(storeError(e)),
    })
  const project = (id: string | null) => (id ? projects.data?.find((p) => p.id === id)?.identifier ?? 'project' : 'Any project')
  const legacyViews = legacy.data ?? []

  const importLegacy = async () => {
    let n = 0
    for (const lv of legacyViews) {
      const { jql, groupBy } = legacyQueryToWql(readIssueQuery(lv.query_data))
      try {
        await create.mutateAsync({ name: lv.name, description: lv.description, projectId, jql, layout: 'list', groupBy, visibility: 'personal', owner: me, starredBy: [] })
        n++
      } catch (e) {
        toast.error(storeError(e))
        return
      }
    }
    toast.success(`Imported ${n} view${n === 1 ? '' : 's'} as personal views`)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="inline-flex rounded-lg bg-surface-sunken p-0.5">
          {(['all', 'starred', 'mine', 'shared'] as const).map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium capitalize', tab === t ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content')}>{t}</button>
          ))}
        </div>
        <ConsoleSide title="Plane's public API has no views — saved by the console" />
        <div className="ml-auto flex items-center gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder="Search views…" />
          <Button size="sm" variant="primary" leading={<IconPlus />} onClick={() => setEditing('new')}>New view</Button>
        </div>
      </div>

      {legacyViews.length ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-edge-default bg-surface-sunken/50 px-3 py-2 text-[12.5px] text-content-muted">
          <span>{legacyViews.length} view{legacyViews.length === 1 ? ' was' : 's were'} saved by the previous Saved Views page in your personal preferences.</span>
          <Button size="xs" onClick={importLegacy} loading={create.isPending}>Import as personal views</Button>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={14} /> Loading views…</div>
      ) : isError ? (
        <EmptyState title="Saved views are unavailable" description={storeError(error)} />
      ) : !rows.length ? (
        <EmptyState icon={<EmptyIcon name="view" />}
          title={views.length ? 'No views match' : 'No saved views yet'}
          description={views.length ? 'Try another tab or search.' : 'Build a query on Issues and press Save view, or create one here with WQL.'}
          action={!views.length ? <Button size="sm" variant="primary" onClick={() => setEditing('new')}>New view</Button> : undefined}
        />
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {rows.map((v) => {
            const starred = v.data.starredBy?.includes(me)
            const mine = v.data.owner?.toLowerCase() === me
            return (
              <li key={v.id} className="group flex flex-wrap items-start gap-3 px-3 py-3 sm:flex-nowrap">
                <button type="button" onClick={() => star(v)} aria-pressed={starred} aria-label={starred ? 'Unstar' : 'Star'} className={cn('mt-0.5', starred ? 'text-amber-500' : 'text-content-subtle hover:text-amber-500')}><IconStar filled={starred} /></button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => navigateTo(defineHref(v.data.layout === 'board' ? 'board' : 'issues', { view: v.id }))} className="truncate text-[13.5px] font-semibold text-content hover:text-brand-700 dark:hover:text-brand-300">{v.data.name}</button>
                    {defaultId === v.id ? <span className="rounded-full bg-brand-50 px-1.5 text-[10.5px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">default</span> : null}
                    <span className="rounded-full bg-surface-sunken px-1.5 text-[10.5px] text-content-muted">{v.data.visibility === 'personal' ? 'only me' : 'shared'}</span>
                    <span className="text-[11px] text-content-subtle">{project(v.data.projectId)}</span>
                  </div>
                  {v.data.description ? <p className="mt-0.5 text-[12px] text-content-muted">{v.data.description}</p> : null}
                  <span className="mt-1 block truncate font-mono text-[11.5px] text-content-subtle" title={v.data.jql}>{v.data.jql || '(all work items)'}</span>
                  <p className="mt-0.5 text-[11px] text-content-subtle">{v.data.ownerName ?? v.data.owner} · updated {formatRelative(v.updatedAt)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <Button size="xs" leading={<IconList size={12} />} onClick={() => navigateTo(defineHref('issues', { view: v.id }))}>List</Button>
                  <Button size="xs" leading={<IconBoard size={12} />} onClick={() => navigateTo(defineHref('board', { q: v.data.jql }))}>Board</Button>
                  {v.data.projectId ? (defaultId === v.id ? <Button size="xs" variant="ghost" onClick={() => setDefault(null)}>Unset default</Button> : <Button size="xs" variant="ghost" onClick={() => setDefault(v)}>Make default</Button>) : null}
                  <Button size="xs" variant="ghost" onClick={() => create.mutate({ ...v.data, name: `${v.data.name} (copy)`, owner: me, visibility: 'personal', starredBy: [] }, { onSuccess: () => toast.success('Duplicated as a personal view'), onError: (e) => toast.error(storeError(e)) })}>Duplicate</Button>
                  {mine ? <Button size="xs" variant="ghost" onClick={() => setEditing(v)}>Edit</Button> : null}
                  {mine ? (
                    <Button size="xs" variant="ghost" className="text-rose-700 dark:text-rose-300" onClick={() => confirm(`Delete view “${v.data.name}”?`) && remove.mutate(v.id, { onSuccess: () => toast.success('View deleted'), onError: (e) => toast.error(storeError(e)) })}>Delete</Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-[11.5px] text-content-subtle">Edit and delete are offered to a view's author. The console store is shared by your organisation, so this is a courtesy, not a permission Plane enforces.</p>

      <ViewSaveModal
        open={!!editing}
        onClose={() => setEditing(null)}
        projectId={projectId}
        editableQuery
        existing={editing && editing !== 'new' ? editing : undefined}
        isDefault={!!editing && editing !== 'new' && defaultId === editing.id}
        draft={editing && editing !== 'new' ? { jql: editing.data.jql, layout: editing.data.layout, groupBy: editing.data.groupBy, columns: editing.data.columns } : { jql: '', layout: 'list' }}
      />
    </div>
  )
}
