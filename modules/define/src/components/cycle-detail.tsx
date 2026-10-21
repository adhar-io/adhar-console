import { useMemo, useState } from 'react'
import { Button, EmptyState, Field, Input, Modal, SearchInput, Select, StatusBadge, type StatusKind, Tabs, Textarea, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError, useCycleLifecycle, useCycles, useDeleteCycle, useProject, useProjectMembers } from '../data/plane.ts'
import { planeProblem, useSprintActions } from '../data/planning-plane.ts'
import { useSprintData, useVelocityData } from '../data/planning-sprint.ts'
import { type SprintMeta, storeError, useMemberMetas, usePatchSprintMeta, useSetIssuePoints } from '../data/planning-store.ts'
import { capacityPlan, dayKey, daysLeft, daysOffIn, isDone, type Metric, pointsOf, scopeChanges, type SprintStatus, startOfDay, toMs, wallNow, workdays } from '../data/planning-model.ts'
import { usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { IssueDrawer } from './issue-drawer.tsx'
import {
  AvatarStack,
  DayLineChart,
  fmtDate,
  fmtRange,
  IDEAL_COLOR,
  Loading,
  Meter,
  Notice,
  type Person,
  ProblemState,
  SectionTitle,
  Segmented,
  SidePanel,
  Stat,
  usePeople,
  useSeriesColor,
} from './planning-ui.tsx'

/**
 * Sprint detail (a Plane cycle): goal, burndown / burnup, scope changes,
 * work items with points, capacity per member, retrospective and the sprint
 * report — plus Start sprint and Complete sprint with carry-over.
 *
 * Plane stores the cycle, its dates and membership. Goal, capacity, daily
 * snapshots (for scope history), the commitment and the retrospective are
 * console-side (`define.sprint`).
 */

export const SPRINT_STATUS: Record<SprintStatus, { label: string; kind: StatusKind }> = {
  active: { label: 'Active', kind: 'progressing' },
  upcoming: { label: 'Upcoming', kind: 'info' },
  completed: { label: 'Completed', kind: 'healthy' },
  draft: { label: 'Draft', kind: 'unknown' },
}

type Tab = 'overview' | 'items' | 'capacity' | 'retro' | 'report'

export function CycleDetail({ projectId, cycle, onClose }: { projectId: string; cycle: plane.Cycle; onClose(): void }) {
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const tab = (['overview', 'items', 'capacity', 'retro', 'report'] as const).includes(params.stab as Tab) ? params.stab as Tab : 'overview'
  const [metric, setMetric] = useState<Metric | undefined>(undefined)
  const data = useSprintData(projectId, cycle, metric)
  const cycles = useCycles(projectId)
  const project = useProject(projectId)
  const remove = useDeleteCycle(projectId)
  const life = useCycleLifecycle(projectId)
  const toast = useToast()
  const [starting, setStarting] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [openIssue, setOpenIssue] = useState<string | null>(null)
  const status = data.status
  const ended = status === 'completed'
  const openIds = data.items.filter((i) => !isDone(i) && i.state_group !== 'cancelled').map((i) => i.id)
  const finalized = !!data.meta.data?.completedAt

  return (
    <SidePanel
      widthId="define.sprint"
      onClose={onClose}
      wide
      eyebrow={
        <>
          Sprint <StatusBadge kind={SPRINT_STATUS[status].kind}>{SPRINT_STATUS[status].label}</StatusBadge>
          {finalized ? <span className="normal-case tracking-normal text-content-subtle">completed in the console {fmtDate(data.meta.data?.completedAt)}</span> : null}
        </>
      }
      title={cycle.name}
      meta={
        <span className="flex flex-wrap gap-x-3">
          <span>{fmtRange(cycle.start_date, cycle.end_date)}</span>
          {status === 'active' ? <span>{daysLeft(cycle.end_date) ?? '—'} days left</span> : null}
          {data.goal ? <span className="text-content">Goal: {data.goal}</span> : null}
        </span>
      }
      actions={
        <>
          {status === 'upcoming' || status === 'draft' ? <Button size="sm" variant="primary" onClick={() => setStarting(true)}>Start sprint</Button> : null}
          {status === 'active' || (ended && !finalized && openIds.length > 0) ? <Button size="sm" variant="primary" onClick={() => setCompleting(true)}>Complete sprint</Button> : null}
          {ended
            ? (
              <Button
                size="sm"
                loading={life.archive.isPending}
                onClick={() =>
                  life.archive.mutate(cycle.id, {
                    onSuccess: () => {
                      toast.success(`Archived ${cycle.name}`)
                      onClose()
                    },
                    onError: (e) => toast.error(planeError(e, "Couldn't archive the sprint.")),
                  })}
              >
                Archive
              </Button>
            )
            : null}
          <Button
            size="sm"
            variant="danger"
            loading={remove.isPending}
            onClick={() => {
              if (!confirm(`Delete "${cycle.name}"? Its work items stay in the project.`)) return
              remove.mutate(cycle.id, {
                onSuccess: () => {
                  toast.success(`Deleted ${cycle.name}`)
                  onClose()
                },
                onError: (e) => toast.error(planeError(e, "Couldn't delete the sprint.")),
              })
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      {data.loading ? <Loading label="Loading the sprint…" /> : data.error ? <ProblemState error={data.error} onRetry={() => data.ids.refetch()} /> : (
        <Tabs
          ariaLabel="Sprint"
          value={tab}
          onChange={(t) => setParams({ stab: t === 'overview' ? undefined : t })}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'items', label: 'Work items', badge: { kind: 'unknown', value: data.items.length } },
            { id: 'capacity', label: 'Capacity' },
            { id: 'retro', label: 'Retrospective' },
            { id: 'report', label: 'Report' },
          ]}
          actions={
            <Segmented
              label="Measure"
              value={data.metric}
              onChange={(m) => setMetric(m)}
              options={[{ value: 'issues', label: 'Items' }, { value: 'points', label: 'Points' }]}
            />
          }
        >
          {(active) => (
            <div className="pt-4">
              {active === 'items'
                ? <ItemsTab projectId={projectId} cycle={cycle} data={data} identifier={project.data?.identifier ?? ''} onOpen={setOpenIssue} />
                : active === 'capacity'
                ? <CapacityTab projectId={projectId} cycle={cycle} data={data} cycles={cycles.data} />
                : active === 'retro'
                ? <RetroTab cycle={cycle} projectId={projectId} meta={data.meta.data} error={data.meta.error} />
                : active === 'report'
                ? <ReportTab cycle={cycle} data={data} identifier={project.data?.identifier ?? ''} />
                : <OverviewTab projectId={projectId} cycle={cycle} data={data} />}
            </div>
          )}
        </Tabs>
      )}
      {starting ? <StartSprintModal projectId={projectId} cycle={cycle} data={data} onClose={() => setStarting(false)} /> : null}
      {completing
        ? <CompleteSprintModal projectId={projectId} cycle={cycle} cycles={cycles.data ?? []} data={data} openIds={openIds} onClose={() => setCompleting(false)} />
        : null}
      {openIssue ? <IssueDrawer projectId={projectId} issueId={openIssue} onClose={() => setOpenIssue(null)} onPick={setOpenIssue} /> : null}
    </SidePanel>
  )
}

type SprintData = ReturnType<typeof useSprintData>

/* ───── overview ───── */

function OverviewTab({ projectId, cycle, data }: { projectId: string; cycle: plane.Cycle; data: SprintData }) {
  const color = useSeriesColor()
  const [mode, setMode] = useState<'burndown' | 'burnup'>('burndown')
  const patch = usePatchSprintMeta()
  const toast = useToast()
  const [goal, setGoal] = useState(data.goal ?? '')
  const [editing, setEditing] = useState(false)
  const o = data.outcome
  const b = data.burn
  const unit = data.metric === 'points' ? ' pts' : ''
  const changes = scopeChanges(data.meta.data?.snapshots)
  const byId = new Map(data.plan.map((i) => [i.id, i]))
  const today = startOfDay(wallNow())

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle actions={!editing ? <Button size="xs" variant="ghost" onClick={() => setEditing(true)} disabled={!!data.meta.error}>{data.goal ? 'Edit goal' : 'Set goal'}</Button> : null}>Sprint goal</SectionTitle>
        {editing
          ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                patch.mutate({ id: cycle.id, fn: (cur) => ({ ...(cur ?? { project: projectId }), project: projectId, goal: goal.trim() || undefined }) }, {
                  onSuccess: () => {
                    toast.success('Sprint goal saved')
                    setEditing(false)
                  },
                  onError: (er) => toast.error(storeError(er)),
                })
              }}
            >
              <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What will this sprint deliver?" className="min-w-0 flex-1" autoFocus />
              <Button type="submit" size="sm" variant="primary" loading={patch.isPending}>Save</Button>
              <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </form>
          )
          : <p className={cn('text-[13px]', data.goal ? 'text-content' : 'text-content-subtle')}>{data.goal ?? 'No goal set.'}</p>}
        {data.meta.error ? <div className="mt-2"><Notice tone="warn">{storeError(data.meta.error)}</Notice></div> : null}
      </section>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Committed" value={`${o?.committed ?? 0}${unit}`} hint={o?.measured ? 'at sprint start' : 'current scope'} />
        <Stat label="Completed" value={`${o?.completed ?? 0}${unit}`} tone={o && o.committed && o.completed >= o.committed ? 'good' : undefined} />
        <Stat label="Remaining" value={`${o?.carried ?? 0}${unit}`} />
        <Stat label="Added" value={`${o?.added ?? 0}${unit}`} hint={o?.measured ? 'since start' : 'needs a start snapshot'} />
        <Stat label="Removed" value={`${o?.removed ?? 0}${unit}`} />
        <Stat label="Days left" value={data.status === 'active' ? daysLeft(cycle.end_date) ?? '—' : data.status === 'completed' ? 'ended' : '—'} />
      </div>

      <section>
        <SectionTitle actions={<Segmented label="Chart" value={mode} onChange={setMode} options={[{ value: 'burndown', label: 'Burndown' }, { value: 'burnup', label: 'Burnup' }]} />}>
          {mode === 'burndown' ? 'Burndown' : 'Burnup'}
        </SectionTitle>
        {!b
          ? <EmptyState compact title="No dates" description="Give the sprint start and end dates (or start it) to chart its progress." />
          : (
            <>
              <DayLineChart
                days={b.days}
                height={220}
                unit={unit}
                markers={today >= b.days[0] && today <= b.days[b.days.length - 1] ? [{ t: today, label: 'Today' }] : []}
                series={mode === 'burndown'
                  ? [
                    { name: 'Remaining', values: b.remaining, color: color(0) },
                    { name: 'Ideal', values: b.ideal, color: IDEAL_COLOR, dashed: true },
                  ]
                  : [
                    { name: 'Scope', values: b.scope, color: color(1) },
                    { name: 'Completed', values: b.completed, color: color(0) },
                  ]}
              />
              <p className="mt-2 text-[11px] text-content-subtle">
                Completion dates come from Plane.{' '}
                {b.scopeSource === 'current'
                  ? 'Plane keeps no history of a sprint\'s contents, so each day uses today\'s scope; the console records the scope daily from now on while the sprint is open here.'
                  : b.scopeSource === 'mixed'
                  ? 'Daily scope comes from the console\'s snapshots since it started recording; earlier days use the first recorded scope or today\'s.'
                  : 'Daily scope comes from the console\'s daily snapshots.'}
              </p>
            </>
          )}
      </section>

      <section>
        <SectionTitle>Scope changes</SectionTitle>
        {changes.length
          ? (
            <ul className="space-y-1 text-[12px]">
              {changes.slice(-10).reverse().map((c) => (
                <li key={c.day} className="flex flex-wrap gap-x-2">
                  <span className="w-16 shrink-0 tabular-nums text-content-subtle">{fmtDate(c.day)}</span>
                  {c.added.length ? <span className="text-content">+{c.added.length} {c.added.slice(0, 3).map((id) => byId.get(id)?.name ?? 'removed item').join(', ')}{c.added.length > 3 ? '…' : ''}</span> : null}
                  {c.removed.length ? <span className="text-content-muted">−{c.removed.length} {c.removed.slice(0, 3).map((id) => byId.get(id)?.name ?? 'an item').join(', ')}{c.removed.length > 3 ? '…' : ''}</span> : null}
                </li>
              ))}
            </ul>
          )
          : <p className="text-[12px] text-content-subtle">{Object.keys(data.meta.data?.snapshots ?? {}).length > 1 ? 'No scope changes recorded.' : 'Scope changes appear once the console has recorded more than one day of this sprint.'}</p>}
      </section>
    </div>
  )
}

/* ───── items ───── */

function ItemsTab({ projectId, cycle, data, identifier, onOpen }: { projectId: string; cycle: plane.Cycle; data: SprintData; identifier: string; onOpen(id: string): void }) {
  const { people } = usePeople()
  const actions = useSprintActions(projectId)
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const inSprint = new Set(data.items.map((i) => i.id))
  const candidates = (data.issues.data ?? []).filter((i) => !inSprint.has(i.id) && i.state_group !== 'completed' && i.state_group !== 'cancelled')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-content-muted">{data.items.length} work items · {data.items.filter(isDone).length} done</span>
        <Button size="sm" onClick={() => setAdding(true)} disabled={data.status === 'completed'}>Add work items</Button>
      </div>
      {data.plan.length === 0
        ? <EmptyState compact title="Nothing in this sprint yet" description="Add work items from the backlog, or plan it on the Planning board." />
        : (
          <ItemList
            projectId={projectId}
            items={data.plan}
            people={people}
            identifier={identifier}
            points={data.points}
            scale={data.scale?.values}
            onOpen={onOpen}
            action={(i) =>
              data.status === 'completed' ? null : (
                <button
                  type="button"
                  className="text-[11px] text-content-subtle hover:text-content"
                  onClick={() =>
                    actions.removeIssue.mutate({ cycle: cycle.id, issue: i.id }, {
                      onSuccess: () => toast.success(`Removed ${identifier}-${i.sequence_id} from the sprint`),
                      onError: (e) => toast.error(planeError(e, "Couldn't remove it from the sprint.")),
                    })}
                >
                  Remove
                </button>
              )}
          />
        )}
      {adding
        ? (
          <PickItemsModal
            title={`Add to ${cycle.name}`}
            items={candidates}
            identifier={identifier}
            busy={actions.addIssues.isPending}
            onClose={() => setAdding(false)}
            onPick={(ids) =>
              actions.addIssues.mutate({ cycle: cycle.id, issues: ids }, {
                onSuccess: () => {
                  toast.success(`Added ${ids.length} work item${ids.length === 1 ? '' : 's'}`)
                  setAdding(false)
                },
                onError: (e) => toast.error(planeError(e, "Couldn't add to the sprint.")),
              })}
          />
        )
        : null}
    </div>
  )
}

/** Compact work-item rows with state, assignees and an inline points picker. */
export function ItemList({ projectId, items, people, identifier, points, scale, onOpen, action, draggable }: {
  projectId: string
  items: plane.PlanIssue[]
  people: Map<string, Person>
  identifier: string
  points: Record<string, number>
  scale?: number[]
  onOpen?(id: string): void
  action?(i: plane.PlanIssue): React.ReactNode
  draggable?: boolean
}) {
  return (
    <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
      {items.map((i) => (
        <li
          key={i.id}
          draggable={draggable}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/x-define-issue', i.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          className={cn('flex items-center gap-2 px-3 py-2', draggable && 'cursor-grab active:cursor-grabbing')}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: i.state_color ?? 'var(--color-edge-strong)' }} title={i.state_name ?? i.state_group} />
          <span className="hidden w-16 shrink-0 font-mono text-[11px] text-content-subtle sm:inline">{identifier}-{i.sequence_id}</span>
          <button type="button" onClick={() => onOpen?.(i.id)} className={cn('min-w-0 flex-1 truncate text-left text-[13px]', i.state_group === 'completed' ? 'text-content-muted line-through' : 'text-content', onOpen && 'hover:text-brand-700 dark:hover:text-brand-300')}>
            {i.name}
          </button>
          {i.priority !== 'none' ? <span className="hidden text-[10px] uppercase text-content-subtle md:inline">{i.priority}</span> : null}
          <AvatarStack ids={i.assignees} people={people} max={2} size={18} />
          <PointsPicker projectId={projectId} issue={i} points={points} scale={scale} />
          {action ? <span className="shrink-0">{action(i)}</span> : null}
        </li>
      ))}
    </ul>
  )
}

export function PointsPicker({ projectId, issue, points, scale }: { projectId: string; issue: { id: string; estimate_point?: string | number | null }; points: Record<string, number>; scale?: number[] }) {
  const set = useSetIssuePoints(projectId)
  const toast = useToast()
  const value = pointsOf({ id: issue.id, estimate_point: typeof issue.estimate_point === 'number' ? issue.estimate_point : null }, points)
  const values = scale ?? [1, 2, 3, 5, 8, 13, 21]
  return (
    <select
      aria-label="Story points"
      value={value === null ? '' : String(value)}
      disabled={typeof issue.estimate_point === 'number' || set.isPending}
      title={typeof issue.estimate_point === 'number' ? 'Estimated in Plane' : 'Story points (kept in the console)'}
      onChange={(e) => set.mutate({ issue: issue.id, points: e.target.value === '' ? null : Number(e.target.value) }, { onError: (er) => toast.error(storeError(er)) })}
      className="h-6 w-14 shrink-0 rounded border border-edge-default bg-surface-app px-1 text-[11px] tabular-nums text-content"
    >
      <option value="">–</option>
      {[...new Set([...values, ...(value !== null ? [value] : [])])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v}</option>)}
    </select>
  )
}

export function PickItemsModal({ title, items, identifier, busy, onClose, onPick }: {
  title: string
  items: plane.PlanIssue[]
  identifier: string
  busy: boolean
  onClose(): void
  onPick(ids: string[]): void
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const f = q.trim().toLowerCase()
  const shown = items.filter((i) => !f || i.name.toLowerCase().includes(f) || `${identifier}-${i.sequence_id}`.toLowerCase().includes(f)).slice(0, 200)
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!sel.size} loading={busy} onClick={() => onPick([...sel])}>Add {sel.size || ''}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <SearchInput value={q} onChange={setQ} placeholder="Search open work items…" block shortcut={false} autoFocus />
        <ul className="max-h-96 divide-y divide-edge-subtle overflow-y-auto rounded-lg border border-edge-default">
          {shown.length
            ? shown.map((i) => (
              <li key={i.id}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-surface-sunken/60">
                  <input
                    type="checkbox"
                    checked={sel.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(sel)
                      if (e.target.checked) next.add(i.id)
                      else next.delete(i.id)
                      setSel(next)
                    }}
                  />
                  <span className="w-16 shrink-0 font-mono text-[11px] text-content-subtle">{identifier}-{i.sequence_id}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-content">{i.name}</span>
                  <span className="text-[11px] text-content-subtle">{i.state_name ?? i.state_group}</span>
                </label>
              </li>
            ))
            : <li className="px-3 py-4 text-center text-[12px] text-content-subtle">No matching work items.</li>}
        </ul>
      </div>
    </Modal>
  )
}

/* ───── capacity ───── */

function CapacityTab({ projectId, cycle, data, cycles }: { projectId: string; cycle: plane.Cycle; data: SprintData; cycles?: plane.Cycle[] }) {
  const members = useProjectMembers(projectId)
  const memberMetas = useMemberMetas()
  const patch = usePatchSprintMeta()
  const vel = useVelocityData(projectId, cycles, data.metric)
  const { people } = usePeople()
  const toast = useToast()
  const s = toMs(cycle.start_date)
  const e = toMs(cycle.end_date)
  const days = s !== undefined && e !== undefined ? workdays(s, e) : 0
  const absences = new Map((memberMetas.data ?? []).map((d) => [d.id, d.data.absences ?? []]))
  const capacity = data.meta.data?.capacity ?? {}
  const entries = (members.data ?? []).filter((m) => !m.is_bot).map((m) => ({
    member: m.id,
    capacity: capacity[m.id] ?? 0,
    daysOff: s !== undefined && e !== undefined ? daysOffIn(absences.get(m.id), s, e) : 0,
  }))
  const plan = capacityPlan({ entries, items: data.items, metric: data.metric, points: data.points, workdays: days })
  const unit = data.metric === 'points' ? 'pts' : 'items'
  const setCap = (member: string, v: number) =>
    patch.mutate({ id: cycle.id, fn: (cur) => ({ ...(cur ?? { project: projectId }), project: projectId, metric: data.metric, capacity: { ...(cur?.capacity ?? {}), [member]: v } }) }, { onError: (er) => toast.error(storeError(er)) })

  if (members.isLoading) return <Loading label="Loading members…" />
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Capacity" value={`${plan.totalCapacity} ${unit}`} hint={days ? `${days} working days` : 'no dates'} />
        <Stat label="Planned" value={`${plan.totalAssigned} ${unit}`} tone={plan.totalCapacity && plan.totalAssigned > plan.totalCapacity ? 'warn' : undefined} />
        <Stat label="Unassigned" value={`${plan.unassigned} ${unit}`} />
        <Stat label="Velocity" value={vel.velocity.average === null ? '—' : `${vel.velocity.average} ${unit}`} hint={vel.velocity.average === null ? 'no finished sprints' : `avg of last ${Math.min(vel.outcomes.length, 3)}`} />
      </div>
      {data.meta.error ? <Notice tone="warn">{storeError(data.meta.error)}</Notice> : null}
      <p className="text-[12px] text-content-muted">
        Capacity per person for this sprint in {unit}, kept in the console. Days off come from each person's availability on the Members page. Open work only; shared items split evenly.
      </p>
      <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
        <table className="w-full min-w-130 text-[12px]">
          <thead>
            <tr className="border-b border-edge-subtle text-left text-[11px] text-content-subtle">
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 font-medium">Capacity</th>
              <th className="px-3 py-2 font-medium">Days off</th>
              <th className="px-3 py-2 font-medium">Assigned</th>
              <th className="w-1/3 px-3 py-2 font-medium">Load</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => {
              const p = people.get(r.member)
              return (
                <tr key={r.member} className="border-b border-edge-subtle last:border-0">
                  <td className="px-3 py-1.5 text-content">{p?.name ?? members.data?.find((m) => m.id === r.member)?.display_name ?? 'Former member'}</td>
                  <td className="px-3 py-1.5">
                    <input
                      type="number"
                      min={0}
                      step={data.metric === 'points' ? 1 : 1}
                      aria-label={`Capacity of ${p?.name ?? r.member}`}
                      defaultValue={capacity[r.member] ?? ''}
                      onBlur={(ev) => {
                        const v = Math.max(0, Number(ev.target.value) || 0)
                        if (v !== (capacity[r.member] ?? 0)) setCap(r.member, v)
                      }}
                      className="h-7 w-20 rounded-md border border-edge-default bg-surface-app px-2 tabular-nums text-content"
                      disabled={!!data.meta.error}
                    />
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-content-muted">{entries.find((x) => x.member === r.member)?.daysOff ?? 0}</td>
                  <td className="px-3 py-1.5 tabular-nums text-content">{r.assigned}{r.effective ? ` / ${r.effective}` : ''}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <Meter value={r.assigned} max={Math.max(r.effective, r.assigned, 1)} tone={r.over ? 'bad' : r.load !== null && r.load > 0.85 ? 'warn' : 'good'} label="Load" />
                      <span className={cn('w-20 shrink-0 text-[11px]', r.over ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-content-muted')}>
                        {r.over ? 'over capacity' : r.load === null ? (r.assigned ? 'no capacity set' : '—') : `${Math.round(r.load * 100)}%`}
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ───── retrospective ───── */

function RetroTab({ cycle, projectId, meta, error }: { cycle: plane.Cycle; projectId: string; meta: SprintMeta | null | undefined; error: unknown }) {
  const patch = usePatchSprintMeta()
  const toast = useToast()
  const [well, setWell] = useState(meta?.retro?.well ?? '')
  const [improve, setImprove] = useState(meta?.retro?.improve ?? '')
  const [actionsText, setActions] = useState(meta?.retro?.actions ?? '')
  const [mood, setMood] = useState(meta?.retro?.mood ?? 0)
  if (error) return <Notice tone="warn">{storeError(error)}</Notice>
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        patch.mutate({ id: cycle.id, fn: (cur) => ({ ...(cur ?? { project: projectId }), project: projectId, retro: { well, improve, actions: actionsText, mood: mood || undefined } }) }, {
          onSuccess: () => toast.success('Retrospective saved'),
          onError: (er) => toast.error(storeError(er)),
        })
      }}
    >
      <p className="text-[12px] text-content-muted">Kept in the console with the sprint.</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="What went well">
          <Textarea rows={6} value={well} onChange={(e) => setWell(e.target.value)} />
        </Field>
        <Field label="What to improve">
          <Textarea rows={6} value={improve} onChange={(e) => setImprove(e.target.value)} />
        </Field>
        <Field label="Action items">
          <Textarea rows={6} value={actionsText} onChange={(e) => setActions(e.target.value)} placeholder="One per line" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] text-content-muted">Team mood</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" aria-pressed={mood === n} onClick={() => setMood(mood === n ? 0 : n)} className={cn('h-7 w-7 rounded-md border text-[12px] tabular-nums', mood === n ? 'border-brand-400 bg-brand-50 text-content dark:bg-brand-500/15' : 'border-edge-default text-content-muted')}>
            {n}
          </button>
        ))}
        <Button type="submit" variant="primary" size="sm" loading={patch.isPending} className="ml-auto">Save retrospective</Button>
      </div>
    </form>
  )
}

/* ───── report ───── */

export function sprintReportMarkdown(cycle: plane.Cycle, data: Pick<SprintData, 'plan' | 'outcome' | 'metric' | 'meta' | 'goal'>, identifier: string): string {
  const o = data.outcome
  const unit = data.metric === 'points' ? ' pts' : ''
  const done = data.plan.filter((i) => i.state_group === 'completed')
  const notDone = data.plan.filter((i) => i.state_group !== 'completed' && i.state_group !== 'cancelled')
  const line = (i: plane.PlanIssue) => `- ${identifier}-${i.sequence_id} ${i.name}`
  const retro = data.meta.data?.retro
  return [
    `# ${cycle.name} — sprint report`,
    '',
    `${fmtRange(cycle.start_date, cycle.end_date)}${data.goal ? ` · Goal: ${data.goal}` : ''}`,
    '',
    `Committed ${o?.committed ?? 0}${unit} · Completed ${o?.completed ?? 0}${unit} · Not completed ${o?.carried ?? 0}${unit} · Added ${o?.added ?? 0}${unit} · Removed ${o?.removed ?? 0}${unit}`,
    '',
    `## Completed (${done.length})`,
    ...(done.length ? done.map(line) : ['- none']),
    '',
    `## Not completed (${notDone.length})`,
    ...(notDone.length ? notDone.map(line) : ['- none']),
    ...(retro && (retro.well || retro.improve || retro.actions)
      ? ['', '## Retrospective', '', `**Went well:** ${retro.well || '—'}`, '', `**Improve:** ${retro.improve || '—'}`, '', `**Actions:** ${retro.actions || '—'}`]
      : []),
    '',
  ].join('\n')
}

function ReportTab({ cycle, data, identifier }: { cycle: plane.Cycle; data: SprintData; identifier: string }) {
  const toast = useToast()
  const md = useMemo(() => sprintReportMarkdown(cycle, data, identifier), [cycle, data, identifier])
  const o = data.outcome
  const unit = data.metric === 'points' ? ' pts' : ''
  const done = data.plan.filter((i) => i.state_group === 'completed')
  const notDone = data.plan.filter((i) => i.state_group !== 'completed' && i.state_group !== 'cancelled')
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-content-muted">
          {o?.committed ? `${Math.round(((o.completed ?? 0) / o.committed) * 100)}% of the commitment completed` : 'Nothing committed'}
          {o && !o.measured ? ' (commitment = current scope; no start snapshot)' : ''}
          {data.meta.data?.carriedTo ? ` · unfinished work moved ${data.meta.data.carriedTo === 'backlog' ? 'to the backlog' : 'to the next sprint'}` : ''}
        </p>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(md)
            toast.success('Report copied as Markdown')
          }}
        >
          Copy as Markdown
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Committed" value={`${o?.committed ?? 0}${unit}`} />
        <Stat label="Completed" value={`${o?.completed ?? 0}${unit}`} />
        <Stat label="Not completed" value={`${o?.carried ?? 0}${unit}`} />
        <Stat label="Added" value={`${o?.added ?? 0}${unit}`} />
        <Stat label="Removed" value={`${o?.removed ?? 0}${unit}`} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section>
          <SectionTitle>Completed · {done.length}</SectionTitle>
          <ul className="space-y-1 text-[12px]">{done.map((i) => <li key={i.id} className="truncate text-content"><span className="font-mono text-content-subtle">{identifier}-{i.sequence_id}</span> {i.name}</li>)}</ul>
        </section>
        <section>
          <SectionTitle>Not completed · {notDone.length}</SectionTitle>
          <ul className="space-y-1 text-[12px]">{notDone.map((i) => <li key={i.id} className="truncate text-content"><span className="font-mono text-content-subtle">{identifier}-{i.sequence_id}</span> {i.name} <span className="text-content-subtle">· {i.state_name ?? i.state_group}</span></li>)}</ul>
        </section>
      </div>
    </div>
  )
}

/* ───── start / complete ───── */

function StartSprintModal({ projectId, cycle, data, onClose }: { projectId: string; cycle: plane.Cycle; data: SprintData; onClose(): void }) {
  const actions = useSprintActions(projectId)
  const toast = useToast()
  // Dates in the viewer's calendar (wall clock), not UTC.
  const defaultEnd = cycle.end_date && (toMs(cycle.end_date) ?? 0) > Date.now()
    ? dayKey(wallNow(new Date(cycle.end_date).getTimezoneOffset(), toMs(cycle.end_date)!))
    : dayKey(wallNow() + (data.sprintDays - 1) * 86_400_000)
  const [end, setEnd] = useState(defaultEnd)
  const [goal, setGoal] = useState(data.goal ?? '')
  const today = dayKey(wallNow())
  return (
    <Modal
      open
      onClose={onClose}
      title={`Start ${cycle.name}`}
      description="Starts today. The work items in the sprint now become its commitment."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={end < today}
            loading={actions.start.isPending}
            onClick={() =>
              actions.start.mutate({ cycle, endDate: end, items: data.items, goal: goal.trim() || undefined }, {
                onSuccess: () => {
                  toast.success(`${cycle.name} started`)
                  onClose()
                },
                onError: (e) => toast.error(planeProblem(e).kind === 'other' ? (e instanceof Error ? e.message : planeError(e)) : planeProblem(e).message),
              })}
          >
            Start sprint
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <Input value={today} readOnly disabled />
          </Field>
          <Field label="Ends" error={end < today ? 'The end is before today.' : undefined}>
            <Input type="date" value={end} min={today} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Sprint goal">
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What will this sprint deliver?" />
        </Field>
        <Notice>
          Committing {data.items.length} work item{data.items.length === 1 ? '' : 's'}{data.hasPoints ? ` · ${data.items.reduce((a, i) => a + (pointsOf(i, data.points) ?? 0), 0)} points` : ''}.
          {data.items.length === 0 ? ' The sprint is empty — add work first, or start it and plan as you go.' : ''}
        </Notice>
      </div>
    </Modal>
  )
}

function CompleteSprintModal({ projectId, cycle, cycles, data, openIds, onClose }: {
  projectId: string
  cycle: plane.Cycle
  cycles: plane.Cycle[]
  data: SprintData
  openIds: string[]
  onClose(): void
}) {
  const actions = useSprintActions(projectId)
  const toast = useToast()
  const targets = cycles.filter((c) => c.id !== cycle.id && (c.status === 'upcoming' || c.status === 'draft' || c.status === 'current'))
  const [carryTo, setCarryTo] = useState<string>(targets.find((c) => c.status === 'upcoming')?.id ?? targets[0]?.id ?? 'backlog')
  const [well, setWell] = useState(data.meta.data?.retro?.well ?? '')
  const [improve, setImprove] = useState(data.meta.data?.retro?.improve ?? '')
  const [act, setAct] = useState(data.meta.data?.retro?.actions ?? '')
  const done = data.items.filter(isDone).length
  return (
    <Modal
      open
      onClose={onClose}
      width="lg"
      title={`Complete ${cycle.name}`}
      description={`${done} of ${data.items.length} work items done.${data.status === 'active' ? ' The sprint ends now.' : ''}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={actions.complete.isPending}
            onClick={() =>
              actions.complete.mutate({ cycle, carryTo, openIds, items: data.items, retro: well || improve || act ? { well, improve, actions: act } : undefined }, {
                onSuccess: () => {
                  toast.success(`${cycle.name} completed${openIds.length ? ` · ${openIds.length} carried over` : ''}`)
                  onClose()
                },
                onError: (e) => toast.error(planeError(e, "Couldn't complete the sprint.")),
              })}
          >
            Complete sprint
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {openIds.length
          ? (
            <Field label={`Move ${openIds.length} unfinished work item${openIds.length === 1 ? '' : 's'} to`} hint={carryTo === 'backlog' ? 'They leave the sprint and go back to the backlog.' : 'Plane transfers them into that sprint.'}>
              <Select
                value={carryTo}
                onChange={(e) => setCarryTo(e.target.value)}
                options={[...targets.map((c) => ({ value: c.id, label: `${c.name}${c.status === 'upcoming' ? ' (next)' : c.status === 'draft' ? ' (draft)' : ''}` })), { value: 'backlog', label: 'Backlog' }]}
              />
            </Field>
          )
          : <Notice>Everything in this sprint is done.</Notice>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Went well">
            <Textarea rows={4} value={well} onChange={(e) => setWell(e.target.value)} />
          </Field>
          <Field label="Improve">
            <Textarea rows={4} value={improve} onChange={(e) => setImprove(e.target.value)} />
          </Field>
          <Field label="Actions">
            <Textarea rows={4} value={act} onChange={(e) => setAct(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
