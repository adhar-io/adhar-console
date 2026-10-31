import { useState } from 'react'
import { Button, Field, Input, Modal, useToast } from '@adhar/shell-ui'
import { type MemberMeta, storeError, usePatchMemberMeta } from '../data/planning-store.ts'
import { type Absence, dayKey } from '../data/planning-model.ts'

/**
 * A person's time off, kept in the console (`define.member`, keyed by Plane
 * user id). Opened from a sprint's Capacity tab: days off that fall inside a
 * sprint lower that person's capacity for it.
 *
 * A sprint's capacity is set per sprint, in the tab's Capacity column. The
 * weekly capacity the old Define → Members page edited had no reader once that
 * page went, so it is no longer offered; a stored value is kept as it was
 * (saving here never drops it).
 */
export function AvailabilityModal({ member, name, meta, onClose }: { member: string; name: string; meta?: MemberMeta; onClose(): void }) {
  const save = usePatchMemberMeta()
  const toast = useToast()
  const [absences, setAbsences] = useState<Absence[]>(meta?.absences ?? [])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const today = dayKey(Date.now())
  return (
    <Modal
      open
      onClose={onClose}
      title={`${name} — time off`}
      description="Kept in the console. Days off inside a sprint reduce that person's capacity for it; the sprint's capacity itself is set in the Capacity column."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({ id: member, fn: (c) => ({ ...(c ?? {}), absences }) }, {
                onSuccess: () => {
                  toast.success('Saved')
                  onClose()
                },
                onError: (e) => toast.error(storeError(e)),
              })}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-[12px] font-medium text-content">Time off</div>
          <ul className="mb-2 space-y-1">
            {absences.filter((a) => a.to >= today).sort((a, b) => a.from.localeCompare(b.from)).map((a, k) => (
              <li key={`${a.from}-${k}`} className="flex items-center gap-2 text-[12px] text-content">
                <span className="tabular-nums">{a.from} → {a.to}</span>
                {a.note ? <span className="text-content-muted">{a.note}</span> : null}
                <button type="button" className="ml-auto text-content-subtle hover:text-content" onClick={() => setAbsences(absences.filter((x) => x !== a))}>Remove</button>
              </li>
            ))}
            {!absences.some((a) => a.to >= today) ? <li className="text-[12px] text-content-subtle">None planned.</li> : null}
          </ul>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vacation" /></Field>
            <Button
              size="sm"
              disabled={!from || !to || to < from}
              onClick={() => {
                setAbsences([...absences, { from, to, note: note.trim() || undefined }])
                setFrom('')
                setTo('')
                setNote('')
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
