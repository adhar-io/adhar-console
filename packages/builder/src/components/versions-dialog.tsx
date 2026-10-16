import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { Button, docStore, Field, Input, Modal, Spinner, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import type { BuilderProject } from '../types.ts'
import { makeVersion, VERSION_KIND, versionId, versionsOf, type VersionSummary } from '../lib/versions.ts'

/**
 * Named version snapshots (console document store, `builder.version`):
 * save the current project under a name, restore any earlier one, delete.
 * Restoring replaces the open project as unsaved changes — Save keeps it.
 */
export function VersionsDialog({ docId, project, onRestore, onClose }: {
  docId: string
  project: BuilderProject | null
  onRestore(project: BuilderProject): void
  onClose(): void
}) {
  const toast = useToast()
  const [list, setList] = useState<VersionSummary[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setList(versionsOf(docId, await docStore.list(VERSION_KIND)))
    } catch (e) {
      setList([])
      toast.error('Could not load versions', { description: e instanceof Error ? e.message : String(e) })
    }
  }, [docId, toast])
  useEffect(() => void load(), [load])

  const save = async () => {
    if (!project) return
    setBusy(true)
    try {
      const v = makeVersion(docId, name, project)
      await docStore.put(VERSION_KIND, versionId(docId), v as unknown as Record<string, unknown>)
      toast.success('Version saved', { description: v.name })
      setName('')
      await load()
    } catch (e) {
      toast.error('Saving the version failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (v: VersionSummary) => {
    try {
      await docStore.remove(VERSION_KIND, v.id)
      setList((l) => (l ?? []).filter((x) => x.id !== v.id))
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Modal open onClose={onClose} title='Versions' description='Named snapshots of this project, shared with your workspace.' width='lg'
      footer={<Button onClick={onClose}>Close</Button>}>
      <div className='space-y-5'>
        <div className='flex items-end gap-2'>
          <Field label='Save the current state as' className='flex-1'>
            <Input value={name} placeholder='e.g. Before review' onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()} />
          </Field>
          <Button variant='primary' onClick={() => void save()} loading={busy} disabled={!project}>Save version</Button>
        </div>
        {list === null ? (
          <div className='flex items-center gap-2 text-sm text-content-muted'><Spinner size={14} /> Loading versions…</div>
        ) : list.length === 0 ? (
          <p className='text-sm text-content-muted'>No versions yet. Save one before a big change so you can always go back.</p>
        ) : (
          <ul className='divide-y divide-edge-subtle rounded-lg border border-edge-default'>
            {list.map((v) => (
              <li key={v.id} className='flex items-center gap-3 px-3 py-2.5'>
                <div className='min-w-0 flex-1'>
                  <div className='truncate text-sm font-medium text-content'>{v.name}</div>
                  <div className='text-xs text-content-muted'>{v.createdAt ? formatRelative(v.createdAt) : ''}</div>
                </div>
                <Button size='sm' onClick={() => { onRestore(v.project); toast.success('Version restored', { description: `${v.name} — save to keep it.` }); onClose() }}>Restore</Button>
                <Button size='sm' variant='ghost' onClick={() => void remove(v)}>Delete</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
