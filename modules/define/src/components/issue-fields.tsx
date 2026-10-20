import { useRef, useState } from 'react'
import { useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, planeError } from '../data/plane.ts'
import { useMoveWork, usePatchWork, useSetEstimate, type WorkItem } from '../data/work-hooks.ts'
import { isOverdue } from '../data/work-board.ts'
import { Avatar, AvatarStack, LabelChip, PickButton, type PickItem, PRIORITIES, PRIORITY_LABEL, PriorityIcon, StateDot } from './work-ui.tsx'

/**
 * Inline editors for one work item's properties — used by the spreadsheet
 * cells, the board cards' quick menu and the drawer's properties panel.
 * Each saves straight to Plane (optimistic, rolled back with a toast on error).
 */

export interface FieldData {
  states: plane.State[]
  labels: plane.Label[]
  cycles: plane.Cycle[]
  modules: plane.Module[]
  members: plane.Member[]
  stateById: Map<string, plane.State>
  labelById: Map<string, plane.Label>
  memberById: Map<string, plane.Member>
  cycleById: Map<string, plane.Cycle>
  moduleById: Map<string, plane.Module>
}

export function useItemEditor() {
  const patch = usePatchWork()
  const move = useMoveWork()
  const est = useSetEstimate()
  const toast = useToast()
  return {
    pending: patch.isPending || move.isPending || est.isPending,
    patch: (item: WorkItem, p: Record<string, unknown>, ok?: string) =>
      patch.mutate({ projectId: item.project, id: item.id, patch: p }, {
        onSuccess: () => ok && toast.success(ok),
        onError: (e) => toast.error(planeError(e, "Couldn't save the change.")),
      }),
    move: (item: WorkItem, to: { cycle?: string | null; module?: string | null }, ok?: string) =>
      move.mutate({ projectId: item.project, item, ...to }, {
        onSuccess: () => ok && toast.success(ok),
        onError: (e) => toast.error(planeError(e, "Couldn't move the item.")),
      }),
    estimate: (item: WorkItem, value: number | null) =>
      est.mutate({ projectId: item.project, item, value }, { onError: (e) => toast.error(planeError(e, "Couldn't set the estimate.")) }),
  }
}

const cell = 'flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400'

export function StateField({ item, data, edit, openSignal, showName = true }: { item: WorkItem; data: FieldData; edit: ReturnType<typeof useItemEditor>; openSignal?: number; showName?: boolean }) {
  const st = data.stateById.get(item.state)
  const own = data.states.filter((s) => s.project === item.project)
  const items: PickItem[] = own.map((s) => ({ id: s.id, label: s.name, hint: s.group, icon: <StateDot state={s} /> }))
  return (
    <PickButton items={items} selected={[item.state]} onPick={(id) => id !== item.state && edit.patch(item, { state: id })} className={cell} title="Change state (s)" openSignal={openSignal} placeholder="Move to…">
      <StateDot state={st} />
      {showName ? <span className="truncate">{st?.name ?? '—'}</span> : null}
    </PickButton>
  )
}

export function PriorityField({ item, edit, showName = true, openSignal }: { item: WorkItem; edit: ReturnType<typeof useItemEditor>; showName?: boolean; openSignal?: number }) {
  const items: PickItem[] = PRIORITIES.map((p) => ({ id: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))
  return (
    <PickButton items={items} selected={[item.priority]} onPick={(p) => p !== item.priority && edit.patch(item, { priority: p })} className={cell} title="Priority" width={200} openSignal={openSignal}>
      <PriorityIcon priority={item.priority} />
      {showName ? <span className={cn('truncate', item.priority === 'none' ? 'text-content-subtle' : '')}>{PRIORITY_LABEL[item.priority]}</span> : null}
    </PickButton>
  )
}

export function memberItems(members: plane.Member[]): PickItem[] {
  return members.map((m) => ({ id: m.member?.id ?? m.id, label: memberDisplayName(m), keywords: m.member?.email ?? m.email, icon: <Avatar member={m} size={18} /> }))
}

export function AssigneesField({ item, data, edit, openSignal, compact }: { item: WorkItem; data: FieldData; edit: ReturnType<typeof useItemEditor>; openSignal?: number; compact?: boolean }) {
  const people = item.assignees.map((id) => data.memberById.get(id)).filter(Boolean) as plane.Member[]
  return (
    <PickButton
      items={memberItems(data.members)}
      selected={item.assignees}
      multi
      onPick={(id) => edit.patch(item, { assignees: item.assignees.includes(id) ? item.assignees.filter((x) => x !== id) : [...item.assignees, id] })}
      className={cell}
      title="Assignees (a)"
      openSignal={openSignal}
      placeholder="Assign…"
    >
      {people.length ? (
        <>
          <AvatarStack members={people} max={compact ? 2 : 3} size={20} />
          {!compact && people.length === 1 ? <span className="truncate">{memberDisplayName(people[0])}</span> : null}
        </>
      ) : <span className="text-content-subtle">Unassigned</span>}
    </PickButton>
  )
}

export function LabelsField({ item, data, edit }: { item: WorkItem; data: FieldData; edit: ReturnType<typeof useItemEditor> }) {
  const own = data.labels.filter((l) => l.project === item.project)
  const chosen = item.labels.map((id) => data.labelById.get(id)).filter(Boolean) as plane.Label[]
  return (
    <PickButton
      items={own.map((l) => ({ id: l.id, label: l.name, icon: <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} /> }))}
      selected={item.labels}
      multi
      onPick={(id) => edit.patch(item, { labels: item.labels.includes(id) ? item.labels.filter((x) => x !== id) : [...item.labels, id] })}
      className={cn(cell, 'overflow-hidden')}
      title="Labels"
      placeholder="Label…"
    >
      {chosen.length ? (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {chosen.slice(0, 2).map((l) => <LabelChip key={l.id} label={l} />)}
          {chosen.length > 2 ? <span className="text-[11px] text-content-subtle">+{chosen.length - 2}</span> : null}
        </span>
      ) : <span className="text-content-subtle">—</span>}
    </PickButton>
  )
}

export function SprintField({ item, data, edit, lite }: { item: WorkItem; data: FieldData; edit: ReturnType<typeof useItemEditor>; lite?: boolean }) {
  const own = data.cycles.filter((c) => c.project === item.project && c.status !== 'completed')
  const cur = item.cycle ? data.cycleById.get(item.cycle) : undefined
  const items: PickItem[] = [{ id: '_none', label: 'No sprint' }, ...own.map((c) => ({ id: c.id, label: c.name, hint: c.status }))]
  return (
    <PickButton items={items} selected={[item.cycle ?? '_none']} onPick={(id) => edit.move(item, { cycle: id === '_none' ? null : id })} className={cell} title={lite ? 'Sprint membership is not loaded for cross-project rows' : 'Sprint (Plane cycle)'} disabled={lite} placeholder="Sprint…">
      {cur ? <span className="truncate">{cur.name}</span> : <span className="text-content-subtle">{lite ? 'n/a' : '—'}</span>}
    </PickButton>
  )
}

export function EpicField({ item, data, edit, lite }: { item: WorkItem; data: FieldData; edit: ReturnType<typeof useItemEditor>; lite?: boolean }) {
  const own = data.modules.filter((m) => m.project === item.project)
  const cur = item.module ? data.moduleById.get(item.module) : undefined
  const items: PickItem[] = [{ id: '_none', label: 'No epic' }, ...own.map((m) => ({ id: m.id, label: m.name, hint: m.status }))]
  return (
    <PickButton items={items} selected={[item.module ?? '_none']} onPick={(id) => edit.move(item, { module: id === '_none' ? null : id })} className={cell} title={lite ? 'Epic membership is not loaded for cross-project rows' : 'Epic (Plane module)'} disabled={lite} placeholder="Epic…">
      {cur ? <span className="truncate">{cur.name}</span> : <span className="text-content-subtle">{lite ? 'n/a' : '—'}</span>}
    </PickButton>
  )
}

export function EstimateField({ item, edit }: { item: WorkItem; edit: ReturnType<typeof useItemEditor> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const unresolved = item.estimate_point == null && !!item.estimate_point_id
  if (editing) {
    return (
      <input
        autoFocus
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false)
          if (e.key === 'Enter') {
            const v = draft.trim() === '' ? null : Number(draft)
            if (v === null || Number.isFinite(v)) edit.estimate(item, v)
            setEditing(false)
          }
        }}
        aria-label="Estimate"
        className="h-7 w-full rounded-md border border-brand-400 bg-surface-raised px-1.5 text-right text-[12.5px] tabular-nums focus:outline-none"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        setDraft(item.estimate_point != null ? String(item.estimate_point) : '')
        setEditing(true)
      }}
      title={unresolved ? "Plane has an estimate, but its public API doesn't expose the project's estimate points to read the value" : 'Estimate'}
      className={cn(cell, 'justify-end tabular-nums')}
    >
      {item.estimate_point != null ? item.estimate_point : <span className="text-content-subtle">{unresolved ? 'set' : '—'}</span>}
    </button>
  )
}

export function DateField({ item, field, edit, groupOf }: { item: WorkItem; field: 'start_date' | 'target_date'; edit: ReturnType<typeof useItemEditor>; groupOf?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const v = item[field]?.slice(0, 10) ?? ''
  const overdue = field === 'target_date' && isOverdue(v, groupOf)
  return (
    <label className={cn(cell, 'relative cursor-pointer')} title={field === 'target_date' ? 'Due date' : 'Start date'} onClick={(e) => e.stopPropagation()}>
      <span className={cn('truncate tabular-nums', !v ? 'text-content-subtle' : overdue ? 'font-medium text-rose-600 dark:text-rose-400' : '')}>
        {v ? new Date(`${v}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
      </span>
      <input
        ref={ref}
        type="date"
        value={v}
        onChange={(e) => edit.patch(item, { [field]: e.target.value || null })}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label={field === 'target_date' ? 'Due date' : 'Start date'}
      />
    </label>
  )
}
