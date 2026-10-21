import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, Modal, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, planeError, useCreateIssue } from '../data/plane.ts'
import { patchItemCaches, usePatchWork, useSprintActions as useCycleCreate, type WorkItem } from '../data/work-hooks.ts'
import { useSprintActions } from '../data/planning-plane.ts'
import { type SprintMeta, useSprintMetas } from '../data/planning-store.ts'
import type { WorkItem as PlanWorkItem } from '../data/planning-model.ts'
import { planningHref } from '../data/planning-nav.ts'
import { navigateTo } from '../data/work-nav.ts'
import { useQueryClient } from '@tanstack/react-query'
import { usePlaneWorkspace } from '@adhar/shell-ui'
import { useWorkScope, type WorkScope } from '../data/work-scope.ts'
import { effectivePoints, useWorkRules, useWorkRulesCtx, viewOf, WorkRulesProvider } from '../data/work-rules.ts'
import { andQuery } from '../data/work-ql.ts'
import { byRank, planRank } from '../data/work-board.ts'
import { localDay } from '../data/work-time.ts'
import { KINDS, type SprintDoc, useDocs } from '../data/work-store.ts'
import { issueParam, useSetWorkParams, useWorkParams } from '../data/work-nav.ts'
import { IssueQueryBar, QUICK_FILTERS } from '../components/issue-query-bar.tsx'
import { NewIssueModal } from '../components/new-issue-modal.tsx'
import { BoardDrawer } from './board.tsx'
import { Avatar, ConsoleSide, IconChevron, IconGrip, IconPlus, Kbd, PlaneErrorState, PriorityIcon, ProgressBar, StateDot, useHotkeys } from '../components/work-ui.tsx'

/**
 * Backlog — Jira-style sprint planning on Plane cycles. Active and upcoming
 * sprints sit above the ranked backlog; drag items between them (one Plane
 * membership call) or within a list to re-rank (Plane `sort_order`). Each
 * sprint shows committed work against a capacity kept console-side, and can
 * be started or completed. Plane derives sprint status from dates, so
 * "start" and "complete" set dates — said so in the dialogs.
 */

const today = () => localDay()
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const fmt = (d?: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—')

export function Backlog({ projectId }: { projectId?: string }) {
  const params = useWorkParams()
  const setParams = useSetWorkParams()
  const toast = useToast()
  const [jql, setJql] = useState(params.q ?? '')
  const [quick, setQuick] = useState<string[]>([])
  const effective = useMemo(() => andQuery(jql, QUICK_FILTERS.filter((f) => quick.includes(f.id)).map((f) => f.jql)), [jql, quick])
  const scope = useWorkScope(projectId, effective, byRank)
  const rules = useWorkRules(scope.projectIds, scope.states)
  // Sprint lifecycle and membership: Agent B's actions, so commitment, snapshots and the retro are recorded.
  const sprints = useSprintActions(projectId)
  const cycleCreate = useCycleCreate(projectId)
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  // Goal + capacity: B's `define.sprintplan` (capacity per member), the old `define.sprint` as fallback.
  const plans = useSprintMetas()
  const legacy = useDocs<SprintDoc>(KINDS.sprint)
  const patch = usePatchWork()
  const queryInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (params.q !== undefined && params.q !== jql) setJql(params.q)
  }, [params.q]) // eslint-disable-line react-hooks/exhaustive-deps
  const dragId = useRef<string | null>(null)
  const [over, setOver] = useState<{ list: string; index: number } | null>(null)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [newSprint, setNewSprint] = useState(false)
  const [starting, setStarting] = useState<plane.Cycle | null>(null)
  const [completing, setCompleting] = useState<plane.Cycle | null>(null)

  useHotkeys({ c: () => setCreateOpen(true), '/': () => queryInput.current?.focus() }, !!projectId)

  const items = useMemo(() => scope.items.filter((i) => i.project === projectId), [scope.items, projectId])
  const allProject = useMemo(() => scope.all.filter((i) => i.project === projectId), [scope.all, projectId])
  const groupOf = (s: string) => scope.stateById.get(s)?.group
  const open = (g?: string) => g !== 'completed' && g !== 'cancelled'
  const cycles = useMemo(() => {
    const rank: Record<string, number> = { current: 0, upcoming: 1, draft: 2 }
    return scope.cycles
      .filter((c) => c.project === projectId && c.status !== 'completed' && !c.archived_at)
      .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (a.start_date ?? '9').localeCompare(b.start_date ?? '9'))
  }, [scope.cycles, projectId])
  const ptsOf = (i: WorkItem) => effectivePoints(i, rules).value
  const usesPoints = allProject.some((i) => ptsOf(i) !== undefined)
  const unresolved = !usesPoints && allProject.some((i) => i.estimate_point_id)
  const sprintInfo = (id: string) => {
    const plan = (plans.data ?? []).find((d) => d.id === id)?.data as SprintMeta | undefined
    const old = (legacy.data ?? []).find((d) => d.id === id)?.data
    const perMember = Object.values(plan?.capacity ?? {})
    return {
      goal: plan?.goal ?? old?.goal,
      capacity: perMember.length ? perMember.reduce((n, v) => n + v, 0) : old?.capacity ?? null,
      fromPlan: perMember.length > 0,
    }
  }
  const toPlan = (i: WorkItem): PlanWorkItem => ({
    id: i.id, name: i.name, state_group: groupOf(i.state) as PlanWorkItem['state_group'], completed_at: i.completed_at, created_at: i.created_at,
    assignees: i.assignees, start_date: i.start_date, target_date: i.target_date, priority: i.priority, labels: i.labels, project: i.project,
    estimate_point: ptsOf(i) ?? null,
  })

  if (!projectId) return <EmptyState title="Pick a project" description="Choose one from the project picker above to plan its sprints." />

  const lists: Array<{ id: string; cycle?: plane.Cycle; items: WorkItem[] }> = [
    ...cycles.map((c) => ({ id: c.id, cycle: c, items: items.filter((i) => i.cycle === c.id) })),
    { id: '_backlog', items: items.filter((i) => !i.cycle && open(groupOf(i.state))) },
  ]

  const onDrop = (listId: string, index: number) => {
    const id = dragId.current
    dragId.current = null
    setOver(null)
    const item = id ? scope.itemById.get(id) : undefined
    if (!item) return
    const target = lists.find((l) => l.id === listId)
    if (!target) return
    const toCycle = listId === '_backlog' ? null : listId
    if ((item.cycle ?? null) !== toCycle) {
      const name = toCycle ? scope.cycleById.get(toCycle)?.name : 'the backlog'
      const snapshot = qc.getQueriesData({ queryKey: ['plane'] })
      patchItemCaches(qc, slug, projectId, item.id, (i) => ({ ...i, cycle: toCycle }))
      const opts = {
        onSuccess: () => toast.success(`${scope.keyOf(item)} → ${name}`),
        onError: (e: unknown) => {
          for (const [k, d] of snapshot) qc.setQueryData(k, d)
          toast.error(planeError(e, "Couldn't move the item."))
        },
      }
      if (toCycle) sprints.addIssues.mutate({ cycle: toCycle, issues: [item.id] }, opts)
      else if (item.cycle) sprints.removeIssue.mutate({ cycle: item.cycle, issue: item.id }, opts)
    }
    const before = target.items.slice(0, index).filter((i) => i.id !== item.id).length
    const ranks = planRank(target.items, item.id, before)
    for (const r of ranks) {
      const cur = scope.itemById.get(r.id)
      if (cur && cur.sort_order !== r.sort_order) patch.mutate({ projectId, id: r.id, patch: { sort_order: r.sort_order } }, { onError: (e) => toast.error(planeError(e, "Couldn't re-rank.")) })
    }
  }

  const firstError = scope.errors[0]

  return (
    <WorkRulesProvider value={rules}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" onClick={() => setNewSprint(true)} leading={<IconPlus />}>Create sprint</Button>
        <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>New item <Kbd>C</Kbd></Button>
      </div>
      <IssueQueryBar value={jql} onRun={(q) => { setJql(q); setParams({ q: q || undefined }) }} ctx={scope.ctx} compiled={scope.compiled} inputRef={queryInput} quick={quick} onQuick={setQuick} count={items.length} total={allProject.length} busy={scope.isFetching && !scope.isLoading} />
      {unresolved ? <p className="text-[11.5px] text-amber-700 dark:text-amber-300">Items carry Plane estimates, but this Plane build's public API doesn't expose estimate points, so the console can't read their values — commitment is counted in items.</p> : null}

      {firstError && !scope.all.length ? <PlaneErrorState error={firstError.error} /> : scope.isLoading && !scope.all.length ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-40 animate-pulse rounded-xl bg-surface-sunken/70" />)}</div>
      ) : (
        <div className="space-y-3">
          {lists.map((l) => {
            const c = l.cycle
            const isCol = collapsed.includes(l.id)
            const pointsSum = l.items.reduce((n, i) => n + (ptsOf(i) ?? 0), 0)
            const committed = usesPoints ? pointsSum : l.items.length
            const info = c ? sprintInfo(c.id) : undefined
            const cap = info?.capacity ?? null
            const doneCount = l.items.filter((i) => groupOf(i.state) === 'completed').length
            const isOver = over?.list === l.id
            return (
              <section
                key={l.id}
                aria-label={c ? c.name : 'Backlog'}
                onDragOver={(e) => {
                  e.preventDefault()
                  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')]
                  let index = rows.length
                  for (let i = 0; i < rows.length; i++) {
                    const r = rows[i].getBoundingClientRect()
                    if (e.clientY < r.top + r.height / 2) {
                      index = i
                      break
                    }
                  }
                  if (over?.list !== l.id || over.index !== index) setOver({ list: l.id, index })
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  onDrop(l.id, over?.list === l.id ? over.index : l.items.length)
                }}
                className={cn('rounded-xl border bg-surface-raised', isOver ? 'border-brand-400 ring-2 ring-brand-400/20' : c?.status === 'current' ? 'border-brand-300 dark:border-brand-500/40' : 'border-edge-default')}
              >
                <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                  <button type="button" onClick={() => setCollapsed((cs) => (cs.includes(l.id) ? cs.filter((x) => x !== l.id) : [...cs, l.id]))} className="flex items-center gap-2 text-left" aria-expanded={!isCol}>
                    <IconChevron open={!isCol} />
                    <span className="text-[13.5px] font-semibold text-content">{c ? c.name : 'Backlog'}</span>
                  </button>
                  {c ? (
                    <>
                      <span className={cn('rounded-full px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wider', c.status === 'current' ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300' : c.status === 'upcoming' ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300' : 'bg-surface-sunken text-content-muted')}>
                        {c.status === 'current' ? 'active' : c.status}
                      </span>
                      <span className="text-[12px] text-content-muted">{c.start_date ? `${fmt(c.start_date)} – ${fmt(c.end_date)}` : 'No dates'}</span>
                    </>
                  ) : null}
                  <span className="text-[12px] text-content-subtle">{l.items.length} item{l.items.length === 1 ? '' : 's'}{usesPoints ? ` · ${pointsSum} pts` : ''}</span>
                  {c ? (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <CapacityEditor
                        value={cap}
                        committed={committed}
                        unit={usesPoints ? 'pts' : 'items'}
                        onEdit={() => navigateTo(planningHref('cycles', { sprint: c.id, stab: 'capacity' }))}
                      />
                      {c.status === 'current' ? <Button size="xs" onClick={() => setCompleting(c)}>Complete sprint</Button> : <Button size="xs" variant="primary" onClick={() => setStarting(c)} disabled={!l.items.length} title={!l.items.length ? 'Add items before starting' : undefined}>Start sprint</Button>}
                    </div>
                  ) : null}
                  {info?.goal ? <p className="w-full pl-6 text-[12px] text-content-muted">Goal: {info.goal}</p> : null}
                  {c && l.items.length ? <div className="w-full pl-6"><ProgressBar value={doneCount} total={l.items.length} tone="emerald" /></div> : null}
                </header>
                {!isCol ? (
                  <ul className="border-t border-edge-subtle">
                    {l.items.map((i, idx) => (
                      <li key={i.id} data-row>
                        {isOver && over?.index === idx ? <div className="h-0.5 bg-brand-500" /> : null}
                        <Row item={i} scope={scope} onOpen={() => setParams({ issue: issueParam(i.project, i.id) }, { push: true })} onDragStart={() => { dragId.current = i.id }} onDragEnd={() => { dragId.current = null; setOver(null) }} />
                      </li>
                    ))}
                    {isOver && over && over.index >= l.items.length ? <li className="h-0.5 bg-brand-500" /> : null}
                    {!l.items.length ? <li className="px-4 py-5 text-center text-[12.5px] text-content-subtle">{c ? 'Plan this sprint — drag items here from the backlog.' : 'The backlog is empty.'}</li> : null}
                    {!c ? <li className="border-t border-edge-subtle px-2 py-1.5"><QuickAddRow projectId={projectId} /></li> : null}
                  </ul>
                ) : null}
              </section>
            )
          })}
          {!cycles.length ? <p className="text-[12px] text-content-subtle">No open sprints. Create one to start planning — sprints are Plane cycles.</p> : null}
        </div>
      )}

      {createOpen ? <NewIssueModal projectId={projectId} onClose={() => setCreateOpen(false)} /> : null}
      <NewSprintModal open={newSprint} onClose={() => setNewSprint(false)} existing={cycles.length + scope.cycles.filter((c) => c.status === 'completed' && c.project === projectId).length} onCreate={(body) => cycleCreate.create.mutate(body, { onSuccess: () => { toast.success(`Created ${body.name}`); setNewSprint(false) }, onError: (e) => toast.error(planeError(e, "Couldn't create the sprint.")) })} busy={cycleCreate.create.isPending} />
      {starting ? (
        <StartSprintModal
          cycle={starting}
          hasActive={cycles.some((c) => c.status === 'current')}
          goal={sprintInfo(starting.id).goal ?? ''}
          busy={sprints.start.isPending}
          onClose={() => setStarting(null)}
          onStart={(end, goal) => {
            sprints.start.mutate({ cycle: starting, endDate: end, goal: goal || undefined, items: allProject.filter((i) => i.cycle === starting.id).map(toPlan) }, {
              onSuccess: () => {
                toast.success(`${starting.name} started`)
                setStarting(null)
              },
              onError: (e) => toast.error(planeError(e, "Couldn't start the sprint.")),
            })
          }}
        />
      ) : null}
      {completing ? (
        <CompleteSprintModal
          cycle={completing}
          items={items.filter((i) => i.cycle === completing.id)}
          allItems={allProject.filter((i) => i.cycle === completing.id)}
          groupOf={groupOf}
          targets={cycles.filter((c) => c.id !== completing.id)}
          busy={sprints.complete.isPending}
          onClose={() => setCompleting(null)}
          onComplete={(moveTo, unfinished) =>
            sprints.complete.mutate({ cycle: completing, carryTo: moveTo, openIds: unfinished, items: allProject.filter((i) => i.cycle === completing.id).map(toPlan) }, {
              onSuccess: () => {
                toast.success(`${completing.name} completed`, { description: unfinished.length ? `${unfinished.length} unfinished item${unfinished.length === 1 ? '' : 's'} moved to ${moveTo === 'backlog' ? 'the backlog' : scope.cycleById.get(moveTo)?.name}.` : undefined })
                setCompleting(null)
              },
              onError: (e) => toast.error(planeError(e, "Couldn't complete the sprint.")),
            })}
        />
      ) : null}
      <BoardDrawer projectId={projectId} />
    </div>
    </WorkRulesProvider>
  )
}

function Row({ item, scope, onOpen, onDragStart, onDragEnd }: { item: WorkItem; scope: WorkScope; onOpen(): void; onDragStart(): void; onDragEnd(): void }) {
  const st = scope.stateById.get(item.state)
  const pts = effectivePoints(item, useWorkRulesCtx())
  const who = item.assignees.map((a) => scope.memberById.get(a)).filter(Boolean) as plane.Member[]
  const epic = item.module ? scope.moduleById.get(item.module) : undefined
  const labels = item.labels.map((l) => scope.labelById.get(l)).filter(Boolean) as plane.Label[]
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className="group flex h-10 items-center gap-2 border-b border-edge-subtle px-2 text-[13px] last:border-b-0 hover:bg-surface-sunken/50"
    >
      <span className="cursor-grab text-content-subtle opacity-40 group-hover:opacity-100" aria-hidden><IconGrip /></span>
      <PriorityIcon priority={item.priority} size={13} />
      <span className="w-[4.5rem] shrink-0 font-mono text-[11px] text-content-subtle">{scope.keyOf(item)}</span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left font-medium text-content hover:text-brand-700 dark:hover:text-brand-300">{item.name}</button>
      <span className="hidden items-center gap-1 md:flex">
        {labels.slice(0, 2).map((l) => <span key={l.id} className="h-1.5 w-5 rounded-full" style={{ backgroundColor: l.color }} title={l.name} />)}
      </span>
      {epic ? <span className="hidden max-w-[9rem] truncate rounded bg-violet-50 px-1.5 text-[11px] text-violet-700 sm:inline dark:bg-violet-500/10 dark:text-violet-300">{epic.name}</span> : null}
      <span className="hidden items-center gap-1 text-[11.5px] text-content-muted sm:flex"><StateDot state={st} /> {st?.name}</span>
      <span className="w-6 text-right text-[11.5px] font-semibold tabular-nums text-content-muted" title={pts.source === 'console' ? 'Story points (console-side)' : 'Estimate'}>{pts.value ?? ''}</span>
      {who[0] ? <Avatar member={who[0]} size={20} title={memberDisplayName(who[0])} /> : <span className="h-5 w-5 rounded-full border border-dashed border-edge-strong" title="Unassigned" />}
    </div>
  )
}

function CapacityEditor({ value, committed, unit, onEdit }: { value: number | null; committed: number; unit: string; onEdit(): void }) {
  const over = value !== null && committed > value
  return (
    <button type="button" onClick={onEdit} title="Capacity is set per member on the sprint's Capacity tab (console-side — Plane cycles have none)" className={cn('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px]', over ? 'bg-rose-50 font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300' : 'text-content-muted hover:bg-surface-sunken')}>
      {committed}{value !== null ? ` / ${value}` : ''} {unit}
      {value === null ? <span className="text-content-subtle">· set capacity</span> : over ? <span>over</span> : null}
    </button>
  )
}

function QuickAddRow({ projectId }: { projectId: string }) {
  const [name, setName] = useState('')
  const rules = useWorkRulesCtx()
  const create = useCreateIssue(projectId)
  const toast = useToast()
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        create.mutate({ name: name.trim(), priority: 'none' } as Partial<plane.Issue>, { onSuccess: (created) => { setName(''); rules?.automate('created', undefined, viewOf(created as WorkItem)) }, onError: (err) => toast.error(planeError(err, "Couldn't create the item.")) })
      }}
    >
      <span className="text-content-subtle"><IconPlus /></span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add to backlog — type a title, Enter" aria-label="New backlog item" className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-content placeholder:text-content-subtle focus:outline-none" />
      {name.trim() ? <Button size="xs" variant="primary" type="submit" loading={create.isPending}>Add</Button> : null}
    </form>
  )
}

function NewSprintModal({ open, onClose, onCreate, busy, existing }: { open: boolean; onClose(): void; onCreate(b: { name: string; start_date: string | null; end_date: string | null }): void; busy: boolean; existing: number }) {
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const valid = !!name.trim() && (!!start === !!end) && (!start || start <= end)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create sprint"
      description="A Plane cycle. Leave the dates empty for a draft sprint you'll start later."
      footer={<><Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={() => onCreate({ name: name.trim(), start_date: start || null, end_date: end || null })}>Create</Button></>}
    >
      <div className="space-y-3">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`Sprint ${existing + 1}`} aria-label="Sprint name" className="block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-3 text-sm" />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[12px] text-content-muted">Start<input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (!end && e.target.value) setEnd(plusDays(e.target.value, 13)) }} className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-sm" /></label>
          <label className="text-[12px] text-content-muted">End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-sm" /></label>
        </div>
        {start && end && start > end ? <p className="text-[12px] text-rose-700">End must be after start.</p> : !!start !== !!end ? <p className="text-[12px] text-content-subtle">Plane needs both dates, or neither.</p> : null}
      </div>
    </Modal>
  )
}

function StartSprintModal({ cycle, hasActive, goal, busy, onClose, onStart }: { cycle: plane.Cycle; hasActive: boolean; goal: string; busy: boolean; onClose(): void; onStart(end: string, goal: string): void }) {
  const start = today()
  const [weeks, setWeeks] = useState(2)
  const [end, setEnd] = useState(() => (cycle.end_date && cycle.end_date.slice(0, 10) > today() ? cycle.end_date.slice(0, 10) : plusDays(today(), 13)))
  const [g, setG] = useState(goal)
  return (
    <Modal
      open
      onClose={onClose}
      title={`Start ${cycle.name}`}
      description="Plane has no sprint status — it reads one from the dates, so starting sets the start to now. The committed scope is recorded for burndown and the sprint report."
      footer={<><Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" loading={busy} disabled={!start || !end || start > end} onClick={() => onStart(end, g.trim())}>Start sprint</Button></>}
    >
      <div className="space-y-3 text-[13px]">
        {hasActive ? <p className="rounded-lg bg-amber-50 p-2 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">Another sprint is active. Plane allows overlapping cycles, but the team's focus may not.</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-content-muted">Duration</span>
          {[1, 2, 3, 4].map((w) => <button key={w} type="button" onClick={() => { setWeeks(w); setEnd(plusDays(start, w * 7 - 1)) }} className={cn('rounded-full border px-2 py-0.5 text-[12px]', weeks === w ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200' : 'border-edge-default text-content-muted')}>{w} week{w > 1 ? 's' : ''}</button>)}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="text-[12px] text-content-muted">Start<p className="mt-1 flex h-9 items-center px-1 text-[13px] text-content">Now</p></div>
          <label className="text-[12px] text-content-muted">End<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-2" /></label>
        </div>
        <label className="block text-[12px] text-content-muted">
          <span className="flex items-center gap-2">Sprint goal <ConsoleSide /></span>
          <input value={g} onChange={(e) => setG(e.target.value)} placeholder="What does this sprint deliver?" className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-[13px] text-content" />
        </label>
      </div>
    </Modal>
  )
}

function CompleteSprintModal({ cycle, items, allItems, groupOf, targets, busy, onClose, onComplete }: {
  cycle: plane.Cycle
  items: WorkItem[]
  allItems: WorkItem[]
  groupOf(s: string): string | undefined
  targets: plane.Cycle[]
  busy: boolean
  onClose(): void
  onComplete(moveTo: string | 'backlog', unfinished: string[]): void
}) {
  const list = allItems.length >= items.length ? allItems : items
  const done = list.filter((i) => groupOf(i.state) === 'completed').length
  const unfinished = list.filter((i) => { const g = groupOf(i.state); return g !== 'completed' && g !== 'cancelled' })
  const [moveTo, setMoveTo] = useState<string>(targets[0]?.id ?? 'backlog')
  return (
    <Modal
      open
      onClose={onClose}
      title={`Complete ${cycle.name}`}
      description="Ends the Plane cycle now (Plane reads a cycle as completed once its end date has passed)."
      footer={<><Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button><Button size="sm" variant="primary" loading={busy} onClick={() => onComplete(moveTo, unfinished.map((i) => i.id))}>Complete sprint</Button></>}
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-content-muted"><strong className="text-content">{done}</strong> done · <strong className="text-content">{unfinished.length}</strong> unfinished</p>
        {unfinished.length ? (
          <label className="block text-[12px] text-content-muted">
            Move unfinished items to
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="mt-1 block h-9 w-full rounded-lg border border-edge-default bg-surface-raised px-2 text-[13px] text-content">
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.status})</option>)}
              <option value="backlog">Backlog</option>
            </select>
          </label>
        ) : null}
        {unfinished.length && moveTo === 'backlog' ? <p className="text-[11.5px] text-content-subtle">Moving to the backlog removes each item from the sprint first — {unfinished.length} Plane request{unfinished.length === 1 ? '' : 's'}. Moving to another sprint is one request.</p> : null}
      </div>
    </Modal>
  )
}
