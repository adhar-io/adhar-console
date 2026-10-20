import { useEffect, useState } from 'react'
import { Button, Field, Input, Modal, Textarea } from '@adhar/shell-ui'
import type { metabase } from '@adhar/api-clients'
import { useCollectionTree, useMbUser } from '../data/bi.ts'
import { CollectionSelect, flattenCollections } from './bi-kit.tsx'

/** Name + description + collection — "Save as question" and "Save as new". */
export function SaveCardModal({
  open,
  onClose,
  title,
  initialName,
  initialDescription,
  initialCollection,
  busy,
  onSave,
  extra,
}: {
  open: boolean
  onClose(): void
  title: string
  initialName: string
  initialDescription?: string | null
  initialCollection?: number | null
  busy?: boolean
  onSave(v: { name: string; description: string | null; collection: number | 'root'; type: metabase.MbCardType }): void
  extra?: React.ReactNode
}) {
  const tree = useCollectionTree()
  const me = useMbUser()
  const collections = flattenCollections(tree.data, me.data?.id)
  const [name, setName] = useState(initialName)
  const [desc, setDesc] = useState(initialDescription ?? '')
  const [coll, setColl] = useState<number | 'root'>(initialCollection ?? 'root')
  const [type, setType] = useState<metabase.MbCardType>('question')
  useEffect(() => {
    if (open) {
      setName(initialName)
      setDesc(initialDescription ?? '')
      setColl(initialCollection ?? 'root')
      setType('question')
    }
  }, [open, initialName, initialDescription, initialCollection])
  const submit = () => name.trim() && onSave({ name: name.trim(), description: desc.trim() || null, collection: coll, type })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      branded
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>
            Save
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Name" required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={254} />
        </Field>
        <Field label="Description">
          <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
        </Field>
        <Field label="Collection" hint={tree.isError ? 'Couldn’t load collections — it will be saved to Our analytics.' : undefined}>
          <CollectionSelect collections={collections} value={coll} onChange={setColl} />
        </Field>
        <Field label="Save as" hint="Models are curated datasets others build questions on.">
          <select value={type} onChange={(e) => setType(e.target.value as metabase.MbCardType)} className="w-full rounded-md border border-edge-default bg-surface-raised px-3 py-2 text-sm text-content">
            <option value="question">Question</option>
            <option value="model">Model</option>
          </select>
        </Field>
        {extra}
      </form>
    </Modal>
  )
}

/** Pick a collection to move an item into. */
export function MoveModal({
  open,
  onClose,
  itemName,
  current,
  busy,
  onMove,
}: {
  open: boolean
  onClose(): void
  itemName: string
  current?: number | null
  busy?: boolean
  onMove(collection: number | 'root'): void
}) {
  const tree = useCollectionTree()
  const me = useMbUser()
  const collections = flattenCollections(tree.data, me.data?.id)
  const [coll, setColl] = useState<number | 'root'>(current ?? 'root')
  useEffect(() => {
    if (open) setColl(current ?? 'root')
  }, [open, current])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move “${itemName}”`}
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={String(coll) === String(current ?? 'root')} onClick={() => onMove(coll)}>
            Move
          </Button>
        </div>
      }
    >
      <Field label="Collection">
        <CollectionSelect collections={collections} value={coll} onChange={setColl} />
      </Field>
    </Modal>
  )
}
