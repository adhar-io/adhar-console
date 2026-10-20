import { useEffect, useState } from 'react'
import { Button, Modal, useOptionalUser, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { KINDS, type SavedView, storeError, useCreateDoc, usePutDoc, type ViewDefault } from '../data/work-store.ts'
import type { ViewDoc } from '../data/work-views.ts'
import { ConsoleSide } from './work-ui.tsx'

/**
 * Save (or update) a WQL view — name, description, shared vs personal,
 * this project vs cross-project, and "default for this project".
 */
export function ViewSaveModal({
  open,
  onClose,
  projectId,
  draft,
  existing,
  isDefault,
  onSaved,
  editableQuery,
}: {
  open: boolean
  onClose(): void
  projectId?: string
  draft: Pick<SavedView, 'jql' | 'layout' | 'groupBy' | 'columns' | 'swimlane'>
  /** Updating this view instead of creating one. */
  existing?: ViewDoc
  isDefault?: boolean
  onSaved?(id: string): void
  /** Let the query be typed here (the Views page) instead of captured from Issues. */
  editableQuery?: boolean
}) {
  const user = useOptionalUser()
  const toast = useToast()
  const create = useCreateDoc<SavedView>(KINDS.view)
  const put = usePutDoc<SavedView>(KINDS.view)
  const putDefault = usePutDoc<ViewDefault>(KINDS.viewDefault)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'shared' | 'personal'>('shared')
  const [cross, setCross] = useState(false)
  const [makeDefault, setMakeDefault] = useState(false)
  const [query, setQuery] = useState(draft.jql)

  useEffect(() => {
    if (!open) return
    setName(existing?.data.name ?? '')
    setDescription(existing?.data.description ?? '')
    setVisibility(existing?.data.visibility ?? 'shared')
    setCross(existing ? existing.data.projectId === null : false)
    setMakeDefault(!!isDefault)
    setQuery(existing?.data.jql ?? draft.jql)
  }, [open, existing, isDefault]) // eslint-disable-line react-hooks/exhaustive-deps

  const busy = create.isPending || put.isPending
  const submit = async () => {
    if (!name.trim() || !user) return
    const data: SavedView = {
      name: name.trim(),
      description: description.trim() || undefined,
      projectId: cross ? null : projectId ?? null,
      jql: editableQuery ? query.trim() : draft.jql,
      layout: draft.layout,
      groupBy: draft.groupBy,
      columns: draft.columns,
      swimlane: draft.swimlane,
      visibility,
      owner: existing?.data.owner ?? user.email,
      ownerName: existing?.data.ownerName ?? user.name,
      starredBy: existing?.data.starredBy ?? [],
    }
    try {
      const id = existing ? (await put.mutateAsync({ id: existing.id, data })).id : (await create.mutateAsync(data)).id
      if (projectId && makeDefault !== !!isDefault) {
        await putDefault.mutateAsync({ id: projectId, data: { viewId: makeDefault ? id : '' } })
      }
      toast.success(existing ? `Updated “${data.name}”` : `Saved view “${data.name}”`)
      onSaved?.(id)
      onClose()
    } catch (e) {
      toast.error(storeError(e))
    }
  }

  const seg = (on: boolean) => cn('flex-1 rounded-md px-2 py-1.5 text-[12px] font-medium', on ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Update saved view' : 'Save view'}
      description={<span className="inline-flex items-center gap-2">Saved in the console, not in Plane (its API has no views). <ConsoleSide /></span>}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!name.trim() || !user} onClick={submit}>{existing ? 'Update view' : 'Save view'}</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="My open bugs" className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-3 text-sm focus:border-brand-400 focus:outline-none" />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-3 text-sm focus:border-brand-400 focus:outline-none" />
        </label>
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Query</span>
          {editableQuery ? (
            <textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={3} spellCheck={false} placeholder='status in (Todo, "In Progress") AND assignee = me ORDER BY priority' className="mt-1 block w-full rounded-lg border border-edge-default bg-surface-raised px-3 py-2 font-mono text-[12px] text-content focus:border-brand-400 focus:outline-none" />
          ) : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-[11.5px] text-content">{draft.jql || '(all work items)'}</pre>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Visible to</span>
            <div className="mt-1 flex gap-0.5 rounded-lg bg-surface-sunken p-0.5">
              <button type="button" className={seg(visibility === 'shared')} onClick={() => setVisibility('shared')}>Everyone</button>
              <button type="button" className={seg(visibility === 'personal')} onClick={() => setVisibility('personal')}>Only me</button>
            </div>
          </div>
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Scope</span>
            <div className="mt-1 flex gap-0.5 rounded-lg bg-surface-sunken p-0.5">
              <button type="button" className={seg(!cross)} onClick={() => setCross(false)} disabled={!projectId}>This project</button>
              <button type="button" className={seg(cross)} onClick={() => setCross(true)}>Any project</button>
            </div>
          </div>
        </div>
        {visibility === 'personal' ? <p className="text-[11.5px] text-content-subtle">“Only me” hides the view from other people's lists in the console. It isn't access control — the console store is shared by your organisation.</p> : null}
        {projectId && !cross ? (
          <label className="flex items-center gap-2 text-[13px] text-content">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="accent-brand-600" />
            Open this view by default for this project
          </label>
        ) : null}
      </form>
    </Modal>
  )
}
