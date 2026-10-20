import { useMemo, useState } from 'react'
import { Button, EmptyState, SearchInput, Select, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError, useArchivedCycles, useCycleLifecycle, useCycles, useProject } from '../data/plane.ts'
import { toWorkItem, useCyclesIssueIds, usePlanIssues, useSprintActions } from '../data/planning-plane.ts'
import { useSprintData, useVelocityData } from '../data/planning-sprint.ts'
import { useIssuePoints, useProjectMeta, useSprintMetas } from '../data/planning-store.ts'
import { capacityPlan, daysLeft, type Metric, pointsOf, sprintElapsed, sprintStatus, type SprintStatus, toMs, workdays } from '../data/planning-model.ts'
import { usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { ArchivedSection } from '../components/archived-section.tsx'
import { CycleDetail, ItemList, SPRINT_STATUS } from '../components/cycle-detail.tsx'
import { CreateCycleModal } from '../components/create-forms.tsx'
import { DayLineChart, fmtRange, GroupedBars, IDEAL_COLOR, Loading, Meter, Notice, ProblemState, SectionTitle, Segmented, Stat, usePeople, useSeriesColor } from '../components/planning-ui.tsx'

/**
 * Sprints (Plane cycles). Three views:
 *   • Sprints — the active sprint up front (goal, pace, burndown), then
 *     upcoming, completed and draft sprints;
 *   • Planning — backlog on the left, a sprint on the right with capacity
 *     and velocity, drag or click to move work in;
 *   • Velocity — committed vs completed across finished sprints.
 * Status is derived from dates (Plane cycles carry none).
 */

type View = 'list' | 'planning' | 'velocity'

export function Cycles({ projectId }: { projectId?: string }) {
  const q = useCycles(projectId)
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const [createOpen, setCreateOpen] = useState(false)
  const view: View = params.tab === 'planning' || params.tab === 'velocity' ? params.tab : 'list'
  const open = (q.data ?? []).find((c) => c.id === params.sprint)

  if (!projectId) return <EmptyState title="Pick a project" />
  if (q.isLoading) return <Loading label="Loading sprints…" />
  if (q.isError) return <ProblemState error={q.error} onRetry={() => q.refetch()} />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Sprint view"
          value={view}
          onChange={(v) => setParams({ tab: v === 'list' ? undefined : v })}
          options={[{ value: 'list', label: 'Sprints' }, { value: 'planning', label: 'Planning' }, { value: 'velocity', label: 'Velocity' }]}
        />
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>New sprint</Button>
      </div>
      {view === 'planning'
        ? <PlanningBoard projectId={projectId} cycles={q.data ?? []} />
        : view === 'velocity'
        ? <VelocityView projectId={projectId} cycles={q.data ?? []} />
        : <SprintList projectId={projectId} cycles={q.data ?? []} onOpen={(c) => setParams({ sprint: c.id, stab: undefined }, { push: true })} />}
      {open ? <CycleDetail projectId={projectId} cycle={open} onClose={() => setParams({ sprint: undefined, stab: undefined })} /> : null}
      <CreateCycleModal projectId={projectId} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(c) => setParams({ sprint: c.id }, { push: true })} />
    </div>
  )
}

/* ───── list ───── */

function SprintList({ projectId, cycles, onOpen }: { projectId: string; cycles: plane.Cycle[]; onOpen(c: plane.Cycle): void }) {
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const archived = useArchivedCycles(projectId, showArchived)
  const life = useCycleLifecycle(projectId)
  const metas = useSprintMetas()
  const goals = new Map((metas.data ?? []).map((d) => [d.id, d.data.goal]))
  const f = search.trim().toLowerCase()
  const list = cycles.filter((c) => !f || c.name.toLowerCase().includes(f) || (goals.get(c.id) ?? '').toLowerCase().includes(f))
  const by = (s: SprintStatus) => list.filter((c) => sprintStatus(c) === s).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
  const active = by('active')
  const completed = by('completed').reverse()

  return (
    <div className="space-y-6">
      <SearchInput value={search} onChange={setSearch} placeholder="Search sprints and goals…" block />
      {cycles.length === 0
        ? <EmptyState title="No sprints yet" description="Create a sprint, plan work into it, then start it when the team commits." />
        : (
          <>
            {active.map((c) => <ActiveSprint key={c.id} projectId={projectId} cycle={c} goal={goals.get(c.id)} onOpen={() => onOpen(c)} />)}
            {!active.length && !f ? <Notice>No sprint is running. Start an upcoming sprint from its page.</Notice> : null}
            <SprintRows title="Upcoming" cycles={by('upcoming')} goals={goals} onOpen={onOpen} />
            <SprintRows title="Draft" cycles={by('draft')} goals={goals} onOpen={onOpen} />
            <SprintRows title="Completed" cycles={completed} goals={goals} onOpen={onOpen} />
            {list.length === 0 ? <EmptyState compact title="No matches" /> : null}
          </>
        )}
      <ArchivedSection
        noun="sprint"
        open={showArchived}
        onToggle={() => setShowArchived((v) => !v)}
        loading={archived.isLoading}
        items={(archived.data ?? []).map((c) => ({ id: c.id, name: c.name, archived_at: c.archived_at, meta: fmtRange(c.start_date, c.end_date) }))}
        onRestore={(id) => life.unarchive.mutateAsync(id)}
        restoring={life.unarchive.isPending}
      />
    </div>
  )
}

function ActiveSprint({ projectId, cycle, goal, onOpen }: { projectId: string; cycle: plane.Cycle; goal?: string; onOpen(): void }) {
  const data = useSprintData(projectId, cycle)
  const color = useSeriesColor()
  const elapsed = sprintElapsed(cycle)
  const o = data.outcome
  const unit = data.metric === 'points' ? ' pts' : ''
  const pct = o && o.completed + o.carried > 0 ? Math.round((o.completed / (o.completed + o.carried)) * 100) : cycle.progress ?? 0
  const behind = elapsed - pct / 100
  return (
    <section className="rounded-xl border border-edge-default bg-surface-raised p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-subtle">
            <StatusBadge kind="progressing">Active sprint</StatusBadge>
            <span>{fmtRange(cycle.start_date, cycle.end_date)}</span>
            <span>· {daysLeft(cycle.end_date) ?? '—'} days left</span>
          </div>
          <button type="button" onClick={onOpen} className="mt-1 text-left text-lg font-semibold tracking-tight text-content hover:text-brand-700 dark:hover:text-brand-300">{cycle.name}</button>
          <p className={cn('mt-0.5 text-[13px]', goal ? 'text-content-muted' : 'text-content-subtle')}>{goal ? `Goal: ${goal}` : 'No sprint goal set.'}</p>
        </div>
        <Button size="sm" onClick={onOpen}>Open sprint</Button>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-3">
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[12px] text-content-muted">
              <span>{pct}% done · {Math.round(elapsed * 100)}% of the time used</span>
              <span className={cn(behind > 0.15 ? 'text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>{behind > 0.15 ? 'behind pace' : 'on pace'}</span>
            </div>
            <Meter value={pct} tone={behind > 0.35 ? 'bad' : behind > 0.15 ? 'warn' : 'good'} label="Sprint progress" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Committed" value={`${o?.committed ?? 0}${unit}`} />
            <Stat label="Done" value={`${o?.completed ?? 0}${unit}`} />
            <Stat label="Scope +/-" value={`+${o?.added ?? 0} / −${o?.removed ?? 0}`} />
          </div>
        </div>
        {data.burn
          ? (
            <DayLineChart
              days={data.burn.days}
              height={150}
              unit={unit}
              series={[
                { name: 'Remaining', values: data.burn.remaining, color: color(0) },
                { name: 'Ideal', values: data.burn.ideal, color: IDEAL_COLOR, dashed: true },
              ]}
            />
          )
          : data.loading ? <Loading label="Loading burndown…" /> : null}
      </div>
    </section>
  )
}

function SprintRows({ title, cycles, goals, onOpen }: { title: string; cycles: plane.Cycle[]; goals: Map<string, string | undefined>; onOpen(c: plane.Cycle): void }) {
  if (!cycles.length) return null
  return (
    <section>
      <SectionTitle>{title} · {cycles.length}</SectionTitle>
      <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        {cycles.map((c) => {
          const s = sprintStatus(c)
          const total = (c.total_issues ?? 0) - (c.cancelled_issues ?? 0)
          return (
            <li key={c.id}>
              <button type="button" onClick={() => onOpen(c)} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left hover:bg-surface-sunken/60 sm:grid-cols-[minmax(0,1.6fr)_8rem_minmax(0,1fr)_6rem]">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-content">{c.name}</span>
                  <span className="block truncate text-[11px] text-content-subtle">{goals.get(c.id) ? `Goal: ${goals.get(c.id)}` : fmtRange(c.start_date, c.end_date)}</span>
                </span>
                <span className="justify-self-end sm:justify-self-start"><StatusBadge kind={SPRINT_STATUS[s].kind}>{SPRINT_STATUS[s].label}</StatusBadge></span>
                <span className="hidden items-center gap-2 sm:flex">
                  <Meter value={c.progress ?? 0} label="Progress" />
                  <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-content-muted">{c.progress ?? 0}%</span>
                </span>
                <span className="hidden text-right text-[11px] tabular-nums text-content-muted sm:block">{c.completed_issues ?? 0}/{total} done</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/* ───── planning board ───── */

function PlanningBoard({ projectId, cycles }: { projectId: string; cycles: plane.Cycle[] }) {
  const plannable = useMemo(
    () => cycles.filter((c) => sprintStatus(c) !== 'completed').sort((a, b) => (toMs(a.start_date) ?? Infinity) - (toMs(b.start_date) ?? Infinity)),
    [cycles],
  )
  const [target, setTarget] = useState<string>('')
  const sprint = plannable.find((c) => c.id === target) ?? plannable.find((c) => sprintStatus(c) === 'upcoming') ?? plannable[0]
  const issues = usePlanIssues(projectId)
  const membership = useCyclesIssueIds(projectId, plannable.map((c) => c.id))
  const data = useSprintData(projectId, sprint)
  const vel = useVelocityData(projectId, cycles, data.metric)
  const pts = useIssuePoints(projectId)
  const pmeta = useProjectMeta(projectId)
  const project = useProject(projectId)
  const actions = useSprintActions(projectId)
  const { people } = usePeople()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [over, setOver] = useState<'backlog' | 'sprint' | null>(null)
  const identifier = project.data?.identifier ?? ''

  const planned = useMemo(() => {
    const s = new Set<string>()
    for (const ids of membership.ids.values()) for (const id of ids ?? []) s.add(id)
    return s
  }, [membership.ids])
  const f = search.trim().toLowerCase()
  const PRI: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
  const backlog = (issues.data ?? [])
    .filter((i) => !planned.has(i.id) && i.state_group !== 'completed' && i.state_group !== 'cancelled')
    .filter((i) => !f || i.name.toLowerCase().includes(f) || `${identifier}-${i.sequence_id}`.toLowerCase().includes(f))
    .sort((a, b) => PRI[a.priority] - PRI[b.priority] || (a.sequence_id ?? 0) - (b.sequence_id ?? 0))

  if (!plannable.length) return <EmptyState title="No sprint to plan" description="Create a sprint first; completed sprints cannot take new work." />
  if (issues.isLoading || membership.loading) return <Loading label="Loading backlog…" />
  if (issues.isError) return <ProblemState error={issues.error} onRetry={() => issues.refetch()} />

  const metric: Metric = data.metric
  const unit = metric === 'points' ? 'pts' : 'items'
  const s = toMs(sprint?.start_date)
  const e = toMs(sprint?.end_date)
  const cap = capacityPlan({
    entries: Object.entries(data.meta.data?.capacity ?? {}).map(([member, capacity]) => ({ member, capacity })),
    items: data.items,
    metric,
    points: pts.points,
    workdays: s !== undefined && e !== undefined ? workdays(s, e) : 0,
  })
  const load = data.items.filter((i) => i.state_group !== 'cancelled').reduce((a, i) => a + (metric === 'issues' ? 1 : pointsOf(i, pts.points) ?? 0), 0)
  const budget = cap.totalCapacity || vel.velocity.average || 0
  const add = (ids: string[]) =>
    sprint && actions.addIssues.mutate({ cycle: sprint.id, issues: ids }, {
      onSuccess: () => toast.success(`Moved ${ids.length} into ${sprint.name}`),
      onError: (er) => toast.error(planeError(er, "Couldn't move it into the sprint.")),
    })
  const remove = (id: string) =>
    sprint && actions.removeIssue.mutate({ cycle: sprint.id, issue: id }, {
      onSuccess: () => toast.success('Moved back to the backlog'),
      onError: (er) => toast.error(planeError(er, "Couldn't move it out of the sprint.")),
    })
  const drop = (zone: 'backlog' | 'sprint') => (ev: React.DragEvent) => {
    ev.preventDefault()
    setOver(null)
    const id = ev.dataTransfer.getData('text/x-define-issue')
    if (!id) return
    if (zone === 'sprint' && !data.items.some((i) => i.id === id)) add([id])
    if (zone === 'backlog' && data.items.some((i) => i.id === id)) remove(id)
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section
        onDragOver={(ev) => {
          ev.preventDefault()
          setOver('backlog')
        }}
        onDragLeave={() => setOver(null)}
        onDrop={drop('backlog')}
        className={cn('min-w-0 rounded-xl p-1', over === 'backlog' && 'ring-2 ring-brand-400/50')}
      >
        <SectionTitle>Backlog · {backlog.length}</SectionTitle>
        <div className="mb-2"><SearchInput value={search} onChange={setSearch} placeholder="Filter backlog…" block shortcut={false} /></div>
        {backlog.length
          ? (
            <ItemList
              projectId={projectId}
              items={backlog.slice(0, 150)}
              people={people}
              identifier={identifier}
              points={pts.points}
              scale={pmeta.data?.estimate?.values}
              draggable
              action={(i) => <button type="button" className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => add([i.id])} aria-label={`Move ${i.name} into the sprint`}>Add →</button>}
            />
          )
          : <EmptyState compact title="Backlog is empty" description="Every open work item is planned into a sprint." />}
        {backlog.length > 150 ? <p className="mt-2 text-[11px] text-content-subtle">Showing the first 150 by priority — filter to find others.</p> : null}
      </section>

      <section
        onDragOver={(ev) => {
          ev.preventDefault()
          setOver('sprint')
        }}
        onDragLeave={() => setOver(null)}
        onDrop={drop('sprint')}
        className={cn('min-w-0 rounded-xl p-1', over === 'sprint' && 'ring-2 ring-brand-400/50')}
      >
        <SectionTitle
          actions={
            <Select
              aria-label="Sprint to plan"
              value={sprint?.id ?? ''}
              onChange={(ev) => setTarget(ev.target.value)}
              options={plannable.map((c) => ({ value: c.id, label: `${c.name} · ${SPRINT_STATUS[sprintStatus(c)].label}` }))}
            />
          }
        >
          Sprint
        </SectionTitle>
        <div className="mb-3 space-y-2 rounded-xl border border-edge-default bg-surface-raised p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-content-muted">
            <span><b className="tabular-nums text-content">{Math.round(load * 10) / 10}</b> {unit} planned{budget ? <> of <b className="tabular-nums text-content">{budget}</b> {cap.totalCapacity ? 'capacity' : 'average velocity'}</> : ''}</span>
            <span>{fmtRange(sprint?.start_date, sprint?.end_date)}</span>
          </div>
          {budget ? <Meter value={load} max={Math.max(budget, load)} tone={load > budget ? 'bad' : load > budget * 0.9 ? 'warn' : 'good'} label="Planned vs capacity" /> : null}
          {cap.rows.filter((r) => r.over).length
            ? <p className="text-[11px] text-rose-700 dark:text-rose-300">Over capacity: {cap.rows.filter((r) => r.over).map((r) => people.get(r.member)?.name ?? 'someone').join(', ')}</p>
            : !budget
            ? <p className="text-[11px] text-content-subtle">Set capacity on the sprint's Capacity tab, or finish a sprint to get a velocity.</p>
            : null}
        </div>
        {data.loading ? <Loading label="Loading sprint…" /> : data.plan.length
          ? (
            <ItemList
              projectId={projectId}
              items={data.plan}
              people={people}
              identifier={identifier}
              points={pts.points}
              scale={pmeta.data?.estimate?.values}
              draggable
              action={(i) => <button type="button" className="text-[11px] text-content-subtle hover:text-content" onClick={() => remove(i.id)} aria-label={`Move ${i.name} back to the backlog`}>← Remove</button>}
            />
          )
          : <div className="rounded-xl border border-dashed border-edge-default px-4 py-10 text-center text-[12px] text-content-subtle">Drag work items here, or use Add →</div>}
      </section>
    </div>
  )
}

/* ───── velocity ───── */

function VelocityView({ projectId, cycles }: { projectId: string; cycles: plane.Cycle[] }) {
  const pts = useIssuePoints(projectId)
  const [metric, setMetric] = useState<Metric>('issues')
  const vel = useVelocityData(projectId, cycles, metric)
  const color = useSeriesColor()
  const issues = usePlanIssues(projectId)
  const hasPoints = (issues.data ?? []).some((i) => pointsOf(toWorkItem(i), pts.points) !== null)
  const unit = metric === 'points' ? ' pts' : ''
  if (vel.loading) return <Loading label="Loading finished sprints…" />
  if (vel.error) return <ProblemState error={vel.error} />
  const v = vel.velocity
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-content-muted">Last {vel.outcomes.length} finished sprint{vel.outcomes.length === 1 ? '' : 's'}. Committed is the scope at sprint start where the console recorded it, else the final scope.</p>
        <Segmented label="Measure" value={metric} onChange={setMetric} options={[{ value: 'issues', label: 'Items' }, { value: 'points', label: 'Points' }]} />
      </div>
      {metric === 'points' && !hasPoints ? <Notice tone="warn">No work item has story points yet — set them on the planning board or the sprint's work items.</Notice> : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Average velocity" value={v.average === null ? '—' : `${v.average}${unit}`} hint={`last ${Math.min(v.window, vel.outcomes.length)} sprints`} />
        <Stat label="Say / do" value={v.sayDo === null ? '—' : `${Math.round(v.sayDo * 100)}%`} hint="completed ÷ committed" />
        <Stat label="Trend" value={v.trend === 1 ? 'Rising' : v.trend === -1 ? 'Falling' : 'Steady'} />
        <Stat label="Carry-over" value={`${vel.outcomes.reduce((a, o) => a + o.carried, 0)}${unit}`} hint="unfinished, all shown sprints" />
      </div>
      <GroupedBars
        categories={vel.outcomes.map((o) => o.name)}
        unit={unit}
        refLine={v.average !== null ? { value: v.average, label: `avg ${v.average}` } : undefined}
        series={[
          { name: 'Committed', values: vel.outcomes.map((o) => o.committed), color: color(1) },
          { name: 'Completed', values: vel.outcomes.map((o) => o.completed), color: color(0) },
        ]}
      />
      {vel.outcomes.length
        ? (
          <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
            <table className="w-full min-w-130 text-[12px]">
              <thead>
                <tr className="border-b border-edge-subtle text-left text-[11px] text-content-subtle">
                  <th className="px-3 py-2 font-medium">Sprint</th>
                  <th className="px-3 py-2 text-right font-medium">Committed</th>
                  <th className="px-3 py-2 text-right font-medium">Completed</th>
                  <th className="px-3 py-2 text-right font-medium">Added</th>
                  <th className="px-3 py-2 text-right font-medium">Removed</th>
                  <th className="px-3 py-2 text-right font-medium">Carried</th>
                </tr>
              </thead>
              <tbody>
                {[...vel.outcomes].reverse().map((o) => (
                  <tr key={o.id} className="border-b border-edge-subtle last:border-0">
                    <td className="px-3 py-1.5 text-content">{o.name}{o.measured ? '' : <span className="ml-1 text-[10px] text-content-subtle">final scope</span>}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{o.committed}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{o.completed}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{o.added}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{o.removed}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{o.carried}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
    </div>
  )
}
