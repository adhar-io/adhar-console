import { type ReactNode, useMemo, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { Button, EmptyState, Tabs, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { useProject } from '../data/plane.ts'
import {
  classifyError,
  downloadText,
  HISTORY_BATCH,
  useContainerIds,
  useContainersIds,
  useCyclesFor,
  useIssueHistories,
  useMemberNames,
  useModulesFor,
  useProjectsData,
  useSnapshots,
} from '../data/insights-data.ts'
import { useDrill } from '../data/insights-drill.ts'
import {
  averageAge,
  burn,
  controlChart,
  createdVsResolved,
  DAY,
  epicForecast,
  firstStarted,
  type Group,
  GROUP_LABEL,
  isOpen,
  type Metric,
  percentile,
  type Segment,
  sprintReport,
  startOfDay,
  timeInStatus,
  timelineFromHistory,
  toCsv,
  toMs,
  velocity,
  type WorkItem,
  workload,
} from '../data/insights-math.ts'
import { cfd, timelineFromDays } from '../data/insights-snapshot.ts'
import { defineLink, OPEN_CATEGORIES, useDefineParams, useSetDefineParams } from '../data/insights-nav.ts'
import { ItemRow, Loading, MiniSelect, Provenance, SourceNote, Stat, StateChip, UpdatedAgo, useGroupColor } from '../components/insights-ui.tsx'
import { fmtDay, GroupedBars, LineChart, Meter, RankBars, Scatter, StackedArea, useSeriesColor } from '../components/insights-viz.tsx'

/**
 * Agile reports for the active project — Jira's report set on live Plane
 * data, with each chart saying where its numbers come from:
 *
 *   • timestamps on issues (created_at / completed_at) — burndown, burnup,
 *     created vs resolved, average age, lead time, epic forecast;
 *   • Plane's cycle totals — velocity (counts);
 *   • cycle/module membership endpoints — sprint and epic scope;
 *   • console daily snapshots (`define.snapshot`) — cumulative flow and
 *     day-granular time in status / cycle time;
 *   • Plane's per-issue activity log, read on request for a bounded batch —
 *     exact time in status and cycle time.
 */

type ReportId = 'burndown' | 'burnup' | 'velocity' | 'cfd' | 'control' | 'created' | 'age' | 'status' | 'workload' | 'sprint' | 'epic'

const REPORTS: Array<{ id: ReportId; label: string; description: string }> = [
  { id: 'burndown', label: 'Burndown', description: 'Remaining sprint work vs the ideal line' },
  { id: 'burnup', label: 'Burnup', description: 'Completed vs total scope' },
  { id: 'velocity', label: 'Velocity', description: 'Committed vs completed per sprint' },
  { id: 'cfd', label: 'Cumulative flow', description: 'Work in each state over time' },
  { id: 'control', label: 'Control chart', description: 'Cycle / lead time per item' },
  { id: 'created', label: 'Created vs resolved', description: 'Inflow against outflow' },
  { id: 'age', label: 'Average age', description: 'How old open work is' },
  { id: 'status', label: 'Time in status', description: 'Where work waits' },
  { id: 'workload', label: 'Workload', description: 'Open work per person' },
  { id: 'sprint', label: 'Sprint report', description: 'What a sprint finished' },
  { id: 'epic', label: 'Epic report', description: 'Progress and forecast of an epic' },
]

const RANGES = [
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' },
]

interface Filters {
  assignee: string
  label: string
  priority: string
}

export function Reports({ projectId }: { projectId?: string }) {
  const params = useDefineParams()
  const setParams = useSetDefineParams()
  const report = (REPORTS.some((r) => r.id === params.report) ? params.report : 'burndown') as ReportId
  const project = useProject(projectId)
  const projects = useMemo(() => (project.data ? [project.data] : []), [project.data])
  const data = useProjectsData(projects, { labels: true })
  const cycles = useCyclesFor(projectId ? [projectId] : [])[0]
  const modules = useModulesFor(projectId ? [projectId] : [])[0]
  const [filters, setFilters] = useState<Filters>({ assignee: '', label: '', priority: '' })
  const now = useMemo(() => Date.now(), [data.updatedAt])
  const days = Number(params.range ?? '30') || 30
  const from = startOfDay(now - (days - 1) * DAY)

  if (!projectId) return <EmptyState icon={<EmptyIcon name="folder" />} title="Pick a project" description="Reports read one project at a time." />

  const items = data.items.filter((i) =>
    (!filters.assignee || (filters.assignee === '-' ? !i.assignees.length : i.assignees.includes(filters.assignee))) &&
    (!filters.label || i.labels.includes(filters.label)) &&
    (!filters.priority || i.priority === filters.priority)
  )
  const filtered = !!(filters.assignee || filters.label || filters.priority)
  const err = data.errors[0] ? classifyError(data.errors[0]) : null
  const ctx: Ctx = {
    projectId,
    project: project.data,
    items,
    allItems: data.items,
    states: data.states,
    cycles: cycles?.data ?? [],
    modules: modules?.data ?? [],
    cyclesLoading: !!cycles?.isLoading,
    now,
    from,
    days,
    filtered,
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterRow data={data} filters={filters} onChange={setFilters} />
        <UpdatedAgo at={data.updatedAt} fetching={data.isFetching} />
      </div>
      {err ? <SourceNote kind={err.kind} message={err.message} /> : null}
      <Tabs
        orientation="vertical"
        ariaLabel="Reports"
        tabs={REPORTS}
        value={report}
        onChange={(r) => setParams({ report: r })}
      >
        {(id) =>
          data.isLoading && !data.items.length ? <Loading label="Loading project data…" /> : (
            <div className="space-y-3">
              {id === 'burndown' || id === 'burnup' ? <BurnReport ctx={ctx} kind={id} /> : null}
              {id === 'velocity' ? <VelocityReport ctx={ctx} /> : null}
              {id === 'cfd' ? <CfdReport ctx={ctx} /> : null}
              {id === 'control' ? <ControlReport ctx={ctx} /> : null}
              {id === 'created' ? <CreatedReport ctx={ctx} /> : null}
              {id === 'age' ? <AgeReport ctx={ctx} /> : null}
              {id === 'status' ? <StatusReport ctx={ctx} /> : null}
              {id === 'workload' ? <WorkloadReport ctx={ctx} /> : null}
              {id === 'sprint' ? <SprintReportView ctx={ctx} /> : null}
              {id === 'epic' ? <EpicReport ctx={ctx} /> : null}
            </div>
          )}
      </Tabs>
    </div>
  )
}

interface Ctx {
  projectId: string
  project?: plane.Project
  items: WorkItem[]
  allItems: WorkItem[]
  states: plane.State[]
  cycles: plane.Cycle[]
  modules: plane.Module[]
  cyclesLoading: boolean
  now: number
  from: number
  days: number
  filtered: boolean
}

function FilterRow({ data, filters, onChange }: { data: ReturnType<typeof useProjectsData>; filters: Filters; onChange(f: Filters): void }) {
  const name = useMemberNames()
  const people = [...new Set(data.items.flatMap((i) => i.assignees))]
  return (
    <div className="flex flex-wrap items-center gap-2">
      <MiniSelect label="Assignee" value={filters.assignee} onChange={(v) => onChange({ ...filters, assignee: v })} options={[{ value: '', label: 'Anyone' }, { value: '-', label: 'Unassigned' }, ...people.map((p) => ({ value: p, label: name(p) })).sort((a, b) => a.label.localeCompare(b.label))]} />
      <MiniSelect label="Label" value={filters.label} onChange={(v) => onChange({ ...filters, label: v })} options={[{ value: '', label: 'Any label' }, ...data.labels.map((l) => ({ value: l.id, label: l.name }))]} />
      <MiniSelect label="Priority" value={filters.priority} onChange={(v) => onChange({ ...filters, priority: v })} options={[{ value: '', label: 'Any priority' }, ...['urgent', 'high', 'medium', 'low', 'none'].map((p) => ({ value: p, label: p === 'none' ? 'No priority' : p[0].toUpperCase() + p.slice(1) }))]} />
      {filters.assignee || filters.label || filters.priority ? <Button size="xs" variant="ghost" onClick={() => onChange({ assignee: '', label: '', priority: '' })}>Clear</Button> : null}
    </div>
  )
}

/** Report header: title, controls, CSV + link actions on the right. */
function ReportHead({ title, subtitle, controls, csv, csvName }: { title: string; subtitle?: ReactNode; controls?: ReactNode; csv?(): Array<Record<string, unknown>>; csvName?: string }) {
  const toast = useToast()
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-content">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[12px] text-content-muted">{subtitle}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {controls}
        {csv
          ? (
            <Button
              size="sm"
              onClick={() => {
                const rows = csv()
                if (!rows.length) return toast.info('Nothing to export')
                downloadText(`${csvName ?? 'report'}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows))
              }}
            >
              Export CSV
            </Button>
          )
          : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(defineLink({})).then(() => toast.success('Link copied'))
          }}
        >
          Copy link
        </Button>
      </div>
    </div>
  )
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm', className)}>{children}</div>
}

function RangeSelect() {
  const params = useDefineParams()
  const setParams = useSetDefineParams()
  return <MiniSelect label="Range" value={params.range ?? '30'} onChange={(v) => setParams({ range: v === '30' ? undefined : v })} options={RANGES} />
}

function MetricSelect({ value, onChange }: { value: Metric; onChange(m: Metric): void }) {
  return <MiniSelect label="Measure" value={value} onChange={onChange} options={[{ value: 'count', label: 'Issue count' }, { value: 'points', label: 'Story points' }]} />
}

function CycleSelect({ ctx, filter }: { ctx: Ctx; filter?(c: plane.Cycle): boolean }) {
  const params = useDefineParams()
  const setParams = useSetDefineParams()
  const list = ctx.cycles.filter((c) => c.start_date && c.end_date && (!filter || filter(c)))
  const sorted = [...list].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
  const value = params.cycle && list.some((c) => c.id === params.cycle) ? params.cycle : pickDefaultCycle(sorted)?.id ?? ''
  return (
    <MiniSelect
      label="Sprint"
      value={value}
      onChange={(v) => setParams({ cycle: v })}
      options={sorted.length ? sorted.map((c) => ({ value: c.id, label: `${c.name}${c.status === 'current' ? ' (active)' : c.status === 'upcoming' ? ' (upcoming)' : ''}` })) : [{ value: '', label: 'No dated cycles' }]}
    />
  )
}

function pickDefaultCycle(sorted: plane.Cycle[]): plane.Cycle | undefined {
  return sorted.find((c) => c.status === 'current') ?? sorted.find((c) => c.status === 'completed') ?? sorted[0]
}

function useSelectedCycle(ctx: Ctx): plane.Cycle | undefined {
  const params = useDefineParams()
  const dated = ctx.cycles.filter((c) => c.start_date && c.end_date)
  return dated.find((c) => c.id === params.cycle) ?? pickDefaultCycle([...dated].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '')))
}

function useMembersOf(ctx: Ctx, kind: 'cycle' | 'module', id: string | undefined) {
  const ids = useContainerIds(ctx.projectId, kind, id)
  const byId = new Map(ctx.items.map((i) => [i.id, i]))
  return { ...ids, items: (ids.data ?? []).map((x) => byId.get(x)).filter((i): i is WorkItem => !!i) }
}

/* ───── burndown / burnup ───── */

function BurnReport({ ctx, kind }: { ctx: Ctx; kind: 'burndown' | 'burnup' }) {
  const c = useSeriesColor()
  const [metric, setMetric] = useState<Metric>('count')
  const cycle = useSelectedCycle(ctx)
  const members = useMembersOf(ctx, 'cycle', cycle?.id)
  const start = toMs(cycle?.start_date) ?? ctx.now
  const end = toMs(cycle?.end_date) ?? ctx.now
  const b = burn(members.items, start, end, ctx.now, metric)
  const unit = metric === 'points' ? 'pts' : 'issues'
  const noPoints = metric === 'points' && members.items.every((i) => i.points == null)
  const series = kind === 'burndown'
    ? [
      { name: 'Remaining', color: c(0), points: b.points.filter((p) => p.remaining !== undefined).map((p) => [p.t, p.remaining!] as [number, number]) },
      { name: 'Ideal', color: 'var(--color-content-subtle)', dashed: true, points: b.points.map((p) => [p.t, p.ideal] as [number, number]) },
    ]
    : [
      { name: 'Scope', color: c(1), points: b.points.filter((p) => p.scope !== undefined).map((p) => [p.t, p.scope!] as [number, number]) },
      { name: 'Completed', color: c(0), points: b.points.filter((p) => p.completed !== undefined).map((p) => [p.t, p.completed!] as [number, number]) },
    ]
  return (
    <>
      <ReportHead
        title={kind === 'burndown' ? 'Sprint burndown' : 'Sprint burnup'}
        subtitle={cycle ? `${cycle.name} · ${cycle.start_date} → ${cycle.end_date} · ${b.total} ${unit} in scope` : 'Pick a sprint with start and end dates.'}
        controls={<><CycleSelect ctx={ctx} /><MetricSelect value={metric} onChange={setMetric} /></>}
        csvName={kind}
        csv={() => b.points.map((p) => ({ date: new Date(p.t).toISOString().slice(0, 10), remaining: p.remaining ?? '', ideal: Math.round(p.ideal * 10) / 10, completed: p.completed ?? '', scope: p.scope ?? '' }))}
      />
      <Card>
        {ctx.cyclesLoading || members.isLoading ? <Loading /> : members.error ? <SourceNote {...classifyError(members.error)} /> : !cycle
          ? <p className="text-[12px] text-content-subtle">This project has no cycles with dates. Create one under Cycles.</p>
          : noPoints
          ? <p className="text-[12px] text-content-subtle">No item in this sprint has an estimate. Switch to issue count, or estimate the work.</p>
          : <LineChart series={series} height={260} domain={[startOfDay(start), startOfDay(end)]} formatY={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))} emptyLabel="No work in this sprint yet." />}
        <Provenance>
          Built from the issues currently in the sprint and their completion dates (Plane's <code>completed_at</code>). Cancelled work is out of scope. Plane's API does not record when an
          issue joined a cycle, so work moved in mid-sprint counts from its creation date{kind === 'burnup' ? ' — scope steps up on that day' : ''}.
          {ctx.filtered ? ' Filters apply.' : ''}
        </Provenance>
      </Card>
    </>
  )
}

/* ───── velocity ───── */

function VelocityReport({ ctx }: { ctx: Ctx }) {
  const c = useSeriesColor()
  const [metric, setMetric] = useState<Metric>('count')
  const finished = ctx.cycles.filter((cy) => cy.end_date && (toMs(cy.end_date) ?? 0) + DAY <= ctx.now)
    .sort((a, b) => (a.end_date ?? '').localeCompare(b.end_date ?? ''))
    .slice(-8)
  // Points need each sprint's membership — one id-only request per sprint, only when asked.
  const ids = useContainersIds(metric === 'points' ? ctx.projectId : undefined, 'cycle', metric === 'points' ? finished.map((x) => x.id) : [])
  const byId = new Map(ctx.allItems.map((i) => [i.id, i]))
  const itemsByCycle = metric === 'points' && ids.every((q) => q.data)
    ? new Map(finished.map((cy, k) => [cy.id, (ids[k].data ?? []).map((x) => byId.get(x)).filter((i): i is WorkItem => !!i)]))
    : undefined
  const v = velocity(finished, ctx.now, itemsByCycle)
  const pts = metric === 'points'
  const loadingPts = pts && ids.some((q) => q.isLoading)
  return (
    <>
      <ReportHead
        title="Velocity"
        subtitle={v.rows.length ? `Average of the last ${Math.min(3, v.rows.length)} sprints: ${pts ? `${(v.averagePts ?? 0).toFixed(1)} points` : `${v.average.toFixed(1)} issues`}` : 'Velocity needs at least one finished sprint.'}
        controls={<MetricSelect value={metric} onChange={setMetric} />}
        csvName="velocity"
        csv={() => v.rows.map((r) => ({ sprint: r.name, ended: new Date(r.end).toISOString().slice(0, 10), committed: r.committed, completed: r.completed, committed_points: r.committedPts ?? '', completed_points: r.completedPts ?? '' }))}
      />
      <Card>
        {ctx.cyclesLoading || loadingPts ? <Loading /> : (
          <GroupedBars
            categories={v.rows.map((r) => r.name)}
            series={[
              { name: 'Committed', color: c(1), values: v.rows.map((r) => (pts ? r.committedPts ?? 0 : r.committed)) },
              { name: 'Completed', color: c(0), values: v.rows.map((r) => (pts ? r.completedPts ?? 0 : r.completed)) },
            ]}
            height={240}
            emptyLabel="No finished sprints yet."
          />
        )}
        <Provenance>
          Counts come from Plane's cycle totals; “committed” is the sprint's final scope (minus cancelled) — Plane does not snapshot scope at sprint start.
          {pts ? ' Points add up the estimates of the issues still in each sprint.' : ''}
        </Provenance>
      </Card>
    </>
  )
}

/* ───── cumulative flow ───── */

function CfdReport({ ctx }: { ctx: Ctx }) {
  const groupColor = useGroupColor()
  const [metric, setMetric] = useState<Metric>('count')
  const snaps = useSnapshots(ctx.projectId, ctx.from, ctx.now)
  const order: Group[] = ['completed', 'started', 'unstarted', 'backlog']
  const flow = cfd(snaps.days, metric, order)
  const enough = snaps.days.length >= 2
  // Before snapshots exist: the two bands issue timestamps can support.
  const buckets = createdVsResolved(ctx.allItems, ctx.from, ctx.now)
  const preexisting = ctx.allItems.filter((i) => i.createdAt < ctx.from)
  const baseOpen = preexisting.length
  return (
    <>
      <ReportHead
        title="Cumulative flow"
        subtitle={enough ? `Daily snapshots since ${fmtDay(snaps.firstDay!)}` : 'Per-state history is still being collected.'}
        controls={<><RangeSelect /><MetricSelect value={metric} onChange={setMetric} /></>}
        csvName="cumulative-flow"
        csv={() => snaps.days.map((d) => ({ date: new Date(d.t).toISOString().slice(0, 10), ...Object.fromEntries(order.map((g) => [GROUP_LABEL[g], (metric === 'points' ? d.points[g] : d.counts[g]) ?? 0])) }))}
      />
      <Card>
        {snaps.isLoading ? <Loading /> : snaps.storeError ? <SourceNote {...snaps.storeError} /> : enough
          ? <StackedArea height={280} series={flow.map((f) => ({ name: GROUP_LABEL[f.group], color: groupColor(f.group), points: f.points }))} />
          : (
            <LineChart
              height={260}
              series={[
                { name: 'Created (cumulative)', color: groupColor('unstarted'), points: buckets.map((b) => [b.t, baseOpen + b.cumCreated]) },
                { name: 'Done (cumulative)', color: groupColor('completed'), points: buckets.map((b) => [b.t, preexisting.filter((i) => i.group === 'completed' && (i.completedAt ?? 0) < ctx.from).length + b.cumResolved]) },
              ]}
            />
          )}
        <Provenance>
          {enough
            ? <>History starts on {fmtDay(snaps.firstDay!)}: Plane's API has no project-wide state history, so the console records every issue's state once a day whenever someone opens this project in Define (stored console-side). Gaps are days nobody looked.</>
            : <>Per-state bands appear once two daily snapshots exist{snaps.firstDay ? ` (first taken ${fmtDay(snaps.firstDay)})` : ' — the first is taken now'}. Until then this shows the two bands issue timestamps support: everything created vs everything done.</>}
          {ctx.filtered ? ' Filters do not apply to snapshot bands.' : ''}
        </Provenance>
      </Card>
    </>
  )
}

/* ───── control chart + time in status (history sources) ───── */

type HistorySource = 'lead' | 'snapshots' | 'plane'

function useTimelines(ctx: Ctx, items: WorkItem[], source: HistorySource, load: boolean) {
  const snaps = useSnapshots(source === 'snapshots' ? ctx.projectId : undefined, ctx.from - 60 * DAY, ctx.now)
  const ids = items.map((i) => i.id)
  const hist = useIssueHistories(ctx.projectId, ids, source === 'plane' && load)
  const timelines = new Map<string, Segment[]>()
  if (source === 'snapshots') {
    for (const i of items) if (i.seq != null) {
      const tl = timelineFromDays(i.seq, snaps.days, ctx.now)
      if (tl.length) timelines.set(i.id, tl)
    }
  } else if (source === 'plane' && hist.data) {
    for (const i of items) {
      const rows = hist.data.get(i.id)
      if (rows) timelines.set(i.id, timelineFromHistory(i, rows, ctx.states, ctx.now))
    }
  }
  return { timelines, snaps, hist }
}

function SourcePicker({ value, onChange, allowLead }: { value: HistorySource; onChange(s: HistorySource): void; allowLead?: boolean }) {
  return (
    <MiniSelect
      label="Source"
      value={value}
      onChange={onChange}
      options={[
        ...(allowLead ? [{ value: 'lead' as const, label: 'Lead time (created → done)' }] : []),
        { value: 'snapshots' as const, label: 'Daily snapshots (console)' },
        { value: 'plane' as const, label: `Plane activity log (≤${HISTORY_BATCH} items)` },
      ]}
    />
  )
}

function HistoryGate({ source, hist, onLoad, count }: { source: HistorySource; hist: ReturnType<typeof useIssueHistories>; onLoad(): void; count: number }) {
  if (source !== 'plane') return null
  if (hist.isFetching) return <Loading label={`Reading Plane activity… ${hist.progress}/${hist.total}`} />
  if (hist.error) return <SourceNote {...classifyError(hist.error)} />
  if (hist.data) return null
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-edge-default bg-surface-sunken/40 px-3 py-2 text-[12px] text-content-muted">
      Reading exact state history costs one Plane request per item ({Math.min(count, HISTORY_BATCH)} here) from the console's shared budget.
      <Button size="sm" variant="primary" onClick={onLoad} disabled={!count}>Load history</Button>
    </div>
  )
}

function ControlReport({ ctx }: { ctx: Ctx }) {
  const c = useSeriesColor()
  const drill = useDrill(ctx.project ? [ctx.project] : [])
  const [source, setSource] = useState<HistorySource>('lead')
  const [load, setLoad] = useState(false)
  const done = ctx.items.filter((i) => i.group === 'completed' && (i.completedAt ?? 0) >= ctx.from).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  const sample = source === 'plane' ? done.slice(0, HISTORY_BATCH) : done
  const { timelines, snaps, hist } = useTimelines(ctx, sample, source, load)
  const startOf = source === 'lead' ? undefined : (i: WorkItem) => {
    const tl = timelines.get(i.id)
    return tl ? firstStarted(tl) : undefined
  }
  const usable = source === 'lead' ? sample : sample.filter((i) => startOf?.(i) !== undefined)
  const cc = controlChart(usable, ctx.from, ctx.now, startOf)
  const vals = cc.points.map((p) => p.days)
  const label = source === 'lead' ? 'Lead time' : 'Cycle time'
  const byId = new Map(ctx.items.map((i) => [i.id, i]))
  return (
    <>
      <ReportHead
        title="Control chart"
        subtitle={cc.points.length ? `${label}: mean ${cc.mean.toFixed(1)}d · median ${percentile(vals, 50).toFixed(1)}d · 85th pct ${percentile(vals, 85).toFixed(1)}d · ${cc.points.length} items` : `${label} of work finished in range`}
        controls={<><RangeSelect /><SourcePicker value={source} onChange={(s) => { setSource(s); setLoad(false) }} allowLead /></>}
        csvName="control-chart"
        csv={() => cc.points.map((p) => ({ key: p.key, name: p.name, done: new Date(p.t).toISOString(), days: Math.round(p.days * 100) / 100 }))}
      />
      <Card>
        <HistoryGate source={source} hist={hist} onLoad={() => setLoad(true)} count={done.length} />
        {source === 'snapshots' && snaps.storeError ? <SourceNote {...snaps.storeError} /> : null}
        <Scatter
          points={cc.points.map((p) => ({ id: p.id, t: p.t, v: p.days, label: `${p.key ? `${p.key} · ` : ''}${p.name}` }))}
          line={cc.rolling}
          refLines={cc.points.length ? [{ value: cc.mean, label: `mean ${cc.mean.toFixed(1)}d` }] : []}
          color={c(0)}
          lineColor={c(1)}
          pointName={label}
          lineName="Rolling average (5)"
          emptyLabel={source === 'lead' ? 'Nothing finished in this range.' : source === 'plane' && !hist.data ? 'Load history to plot cycle time.' : 'No finished item has a recorded start in this range.'}
          onSelect={(id) => { const i = byId.get(id); if (i) drill.item(i) }}
        />
        <Provenance>
          {source === 'lead' && 'Lead time runs from creation to completion — available for every item from Plane timestamps.'}
          {source === 'snapshots' && <>Cycle time from the console's daily snapshots: the first day an item was seen in a started state, to completion (day granularity){snaps.firstDay ? `; history starts ${fmtDay(snaps.firstDay)}` : '; no snapshots yet'}. Items that started before history began are left out.</>}
          {source === 'plane' && <>Cycle time from Plane's activity log for the {Math.min(done.length, HISTORY_BATCH)} most recently finished items: first move into a started state → completion.</>}
          {' '}Click a dot to open the item.
        </Provenance>
      </Card>
    </>
  )
}

function StatusReport({ ctx }: { ctx: Ctx }) {
  const c = useSeriesColor()
  const [source, setSource] = useState<HistorySource>('snapshots')
  const [load, setLoad] = useState(false)
  const pool = [...ctx.items].filter((i) => i.updatedAt >= ctx.from).sort((a, b) => b.updatedAt - a.updatedAt)
  const sample = source === 'plane' ? pool.slice(0, HISTORY_BATCH) : pool
  const { timelines, snaps, hist } = useTimelines(ctx, sample, source, load)
  const totals = timeInStatus([...timelines.values()])
  const stateById = new Map(ctx.states.map((s) => [s.id, s]))
  const rows = [...totals].map(([id, v]) => ({ id, name: stateById.get(id)?.name ?? 'Removed state', group: v.group, avgDays: v.ms / DAY / Math.max(1, v.items), totalDays: v.ms / DAY, items: v.items }))
    .sort((a, b) => b.avgDays - a.avgDays)
  return (
    <>
      <ReportHead
        title="Time in status"
        subtitle={`Average days an item spends in each state · ${timelines.size} item${timelines.size === 1 ? '' : 's'} with history`}
        controls={<><RangeSelect /><SourcePicker value={source === 'lead' ? 'snapshots' : source} onChange={(s) => { setSource(s); setLoad(false) }} /></>}
        csvName="time-in-status"
        csv={() => rows.map((r) => ({ state: r.name, group: r.group, items: r.items, avg_days: Math.round(r.avgDays * 100) / 100, total_days: Math.round(r.totalDays * 100) / 100 }))}
      />
      <Card>
        <HistoryGate source={source} hist={hist} onLoad={() => setLoad(true)} count={pool.length} />
        {source === 'snapshots' && snaps.isLoading ? <Loading /> : source === 'snapshots' && snaps.storeError ? <SourceNote {...snaps.storeError} /> : (
          <RankBars
            rows={rows.map((r) => ({ key: r.id, label: <span className="inline-flex items-center gap-2">{r.name} <StateChip group={r.group} /></span>, value: r.avgDays, sub: `${r.items} item${r.items === 1 ? '' : 's'} · ${r.totalDays.toFixed(1)} days in total` }))}
            color={c(0)}
            format={(v) => `${v.toFixed(1)}d`}
            empty={source === 'plane' && !hist.data ? 'Load history to measure time in status.' : 'No state history in this range yet.'}
          />
        )}
        <Provenance>
          Completed and cancelled states aren't timed. {source === 'snapshots'
            ? <>From the console's daily snapshots (day granularity){snaps.firstDay ? `, collected since ${fmtDay(snaps.firstDay)}` : ' — none collected yet; they start when people open this project'}.</>
            : <>From Plane's activity log for the {Math.min(pool.length, HISTORY_BATCH)} most recently updated items.</>}
        </Provenance>
      </Card>
    </>
  )
}

/* ───── created vs resolved, age ───── */

function CreatedReport({ ctx }: { ctx: Ctx }) {
  const c = useSeriesColor()
  const [bucket, setBucket] = useState<'day' | 'week'>(ctx.days > 60 ? 'week' : 'day')
  const [mode, setMode] = useState<'cumulative' | 'per'>('cumulative')
  const b = createdVsResolved(ctx.items, ctx.from, ctx.now, bucket)
  const last = b.at(-1)
  return (
    <>
      <ReportHead
        title="Created vs resolved"
        subtitle={last ? `${last.cumCreated} created · ${last.cumResolved} resolved · net ${last.cumCreated - last.cumResolved >= 0 ? '+' : ''}${last.cumCreated - last.cumResolved}` : undefined}
        controls={
          <>
            <RangeSelect />
            <MiniSelect label="Bucket" value={bucket} onChange={(v) => setBucket(v as 'day' | 'week')} options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }]} />
            <MiniSelect label="Show" value={mode} onChange={(v) => setMode(v as 'cumulative' | 'per')} options={[{ value: 'cumulative', label: 'Cumulative' }, { value: 'per', label: `Per ${bucket}` }]} />
          </>
        }
        csvName="created-vs-resolved"
        csv={() => b.map((x) => ({ from: new Date(x.t).toISOString().slice(0, 10), created: x.created, resolved: x.resolved, cumulative_created: x.cumCreated, cumulative_resolved: x.cumResolved }))}
      />
      <Card>
        <LineChart
          height={260}
          series={[
            { name: 'Created', color: c(1), points: b.map((x) => [x.t, mode === 'cumulative' ? x.cumCreated : x.created]) },
            { name: 'Resolved', color: c(0), points: b.map((x) => [x.t, mode === 'cumulative' ? x.cumResolved : x.resolved]) },
          ]}
        />
        <Provenance>Created from <code>created_at</code>, resolved from <code>completed_at</code> (done states only). A widening gap means the backlog is growing.{ctx.filtered ? ' Filters apply.' : ''}</Provenance>
      </Card>
    </>
  )
}

function AgeReport({ ctx }: { ctx: Ctx }) {
  const c = useSeriesColor()
  const a = averageAge(ctx.items, ctx.from, ctx.now)
  const drill = useDrill(ctx.project ? [ctx.project] : [])
  const oldest = ctx.items.filter(isOpen).sort((x, y) => x.createdAt - y.createdAt).slice(0, 8)
  const names = new Map(ctx.states.map((s) => [s.id, s.name]))
  return (
    <>
      <ReportHead
        title="Average age"
        subtitle={a.at(-1) ? `${a.at(-1)!.open} open items, ${a.at(-1)!.age.toFixed(1)} days old on average` : undefined}
        controls={<RangeSelect />}
        csvName="average-age"
        csv={() => a.map((x) => ({ date: new Date(x.t).toISOString().slice(0, 10), open: x.open, average_age_days: Math.round(x.age * 10) / 10 }))}
      />
      <Card>
        <LineChart height={240} series={[{ name: 'Average age (days)', color: c(0), points: a.map((x) => [x.t, x.age]) }]} formatY={(v) => `${Math.round(v)}d`} />
        <Provenance>For each day: the mean age of items created by then and not yet done or cancelled. Cancelled items count as closed on their last update.{ctx.filtered ? ' Filters apply.' : ''}</Provenance>
      </Card>
      <Card>
        <h3 className="mb-1 text-[13px] font-semibold text-content">Oldest open work</h3>
        {oldest.length
          ? <ul className="divide-y divide-edge-subtle">{oldest.map((i) => <ItemRow key={i.id} item={i} stateName={names.get(i.state)} now={ctx.now} onOpen={() => drill.item(i)} trailing={<span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-content-subtle">{Math.floor((ctx.now - i.createdAt) / DAY)}d</span>} />)}</ul>
          : <p className="text-[12px] text-content-subtle">No open work.</p>}
      </Card>
    </>
  )
}

/* ───── workload ───── */

function WorkloadReport({ ctx }: { ctx: Ctx }) {
  const c = useSeriesColor()
  const name = useMemberNames()
  const drill = useDrill(ctx.project ? [ctx.project] : [])
  const [metric, setMetric] = useState<Metric>('count')
  const rows = workload(ctx.items, ctx.now)
  return (
    <>
      <ReportHead
        title="Workload"
        subtitle="Open work per assignee — an item with two assignees counts for both."
        controls={<MetricSelect value={metric} onChange={setMetric} />}
        csvName="workload"
        csv={() => rows.map((r) => ({ assignee: name(r.assignee), open: r.open, in_progress: r.inProgress, overdue: r.overdue, points: r.points }))}
      />
      <Card>
        <RankBars
          rows={rows.map((r) => ({ key: r.assignee, label: name(r.assignee), value: metric === 'points' ? r.points : r.open, sub: `${r.inProgress} in progress · ${r.overdue} overdue${metric === 'count' && r.points ? ` · ${r.points} pts` : ''}` }))}
          color={c(0)}
          format={(v) => (metric === 'points' ? `${v} pts` : String(v))}
          empty="No open work."
          onSelect={(k) => drill.issues({ statusCategory: OPEN_CATEGORIES, assignee: k ? name(k) : 'EMPTY' })}
        />
      </Card>
    </>
  )
}

/* ───── sprint report ───── */

function SprintReportView({ ctx }: { ctx: Ctx }) {
  const cycle = useSelectedCycle(ctx)
  const members = useMembersOf(ctx, 'cycle', cycle?.id)
  const drill = useDrill(ctx.project ? [ctx.project] : [])
  const color = useSeriesColor()
  const start = toMs(cycle?.start_date) ?? ctx.now
  const end = toMs(cycle?.end_date) ?? ctx.now
  const r = sprintReport(members.items, start)
  const b = burn(members.items, start, end, ctx.now)
  const names = new Map(ctx.states.map((s) => [s.id, s.name]))
  const section = (title: string, list: WorkItem[], q: ReactNode) => (
    <Card>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-content">{title} <span className="font-normal text-content-subtle">({list.length})</span></h3>
        {q}
      </div>
      {list.length
        ? <ul className="divide-y divide-edge-subtle">{list.map((i) => <ItemRow key={i.id} item={i} stateName={names.get(i.state)} now={ctx.now} onOpen={() => drill.item(i)} trailing={i.points != null ? <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-content-subtle">{i.points} pt</span> : null} />)}</ul>
        : <p className="text-[12px] text-content-subtle">None.</p>}
    </Card>
  )
  return (
    <>
      <ReportHead
        title="Sprint report"
        subtitle={cycle ? `${cycle.name} · ${cycle.start_date} → ${cycle.end_date}${cycle.status === 'current' ? ' · in progress' : ''}` : 'Pick a sprint.'}
        controls={<CycleSelect ctx={ctx} />}
        csvName="sprint-report"
        csv={() => members.items.map((i) => ({ key: i.key, name: i.name, outcome: i.group === 'completed' ? 'completed' : i.group === 'cancelled' ? 'cancelled' : 'not completed', points: i.points ?? '', created_after_start: i.createdAt > start ? 'yes' : '' }))}
      />
      {members.isLoading ? <Loading /> : members.error ? <SourceNote {...classifyError(members.error)} /> : !cycle ? null : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Completed" value={r.completed.length} hint={`${r.completedPts} pts`} />
            <Stat label="Not completed" value={r.notCompleted.length} hint={`${r.notCompletedPts} pts`} />
            <Stat label="Completion" value={`${r.completion}%`} />
            <Stat label="Created after start" value={r.createdAfterStart.length} hint="scope added" />
          </div>
          <Card>
            <LineChart
              height={200}
              series={[
                { name: 'Remaining', color: color(0), points: b.points.filter((p) => p.remaining !== undefined).map((p) => [p.t, p.remaining!]) },
                { name: 'Ideal', color: 'var(--color-content-subtle)', dashed: true, points: b.points.map((p) => [p.t, p.ideal]) },
              ]}
              domain={[startOfDay(start), startOfDay(end)]}
            />
          </Card>
          {section('Completed', r.completed, null)}
          {section('Not completed', r.notCompleted, <button type="button" className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => drill.issues({ cycle: cycle.name, statusCategory: OPEN_CATEGORIES })}>Open in Issues →</button>)}
          {r.cancelled.length ? section('Cancelled', r.cancelled, null) : null}
          <Provenance>“Created after start” is the closest signal Plane's API gives for scope added mid-sprint (it doesn't record when an issue joined a cycle).</Provenance>
        </>
      )}
    </>
  )
}

/* ───── epic report ───── */

function EpicReport({ ctx }: { ctx: Ctx }) {
  const params = useDefineParams()
  const setParams = useSetDefineParams()
  const c = useSeriesColor()
  const drill = useDrill(ctx.project ? [ctx.project] : [])
  const mods = [...ctx.modules].sort((a, b) => a.name.localeCompare(b.name))
  const mod = mods.find((m) => m.id === params.module) ?? mods.find((m) => m.status === 'in-progress') ?? mods[0]
  const members = useMembersOf(ctx, 'module', mod?.id)
  const f = epicForecast(members.items, ctx.now)
  const first = Math.min(ctx.now, ...members.items.map((i) => i.createdAt))
  const from = Math.max(startOfDay(first), ctx.now - 180 * DAY)
  const b = createdVsResolved(members.items, from, ctx.now, ctx.now - from > 60 * DAY ? 'week' : 'day')
  const base = members.items.filter((i) => i.createdAt < from)
  const target = toMs(mod?.target_date)
  const names = new Map(ctx.states.map((s) => [s.id, s.name]))
  const open = members.items.filter(isOpen)
  return (
    <>
      <ReportHead
        title="Epic report"
        subtitle={mod ? `${mod.name}${mod.target_date ? ` · target ${mod.target_date}` : ''} · ${mod.status}` : 'This project has no modules (epics) yet.'}
        controls={<MiniSelect label="Epic" value={mod?.id ?? ''} onChange={(v) => setParams({ module: v })} options={mods.length ? mods.map((m) => ({ value: m.id, label: m.name })) : [{ value: '', label: 'No epics' }]} />}
        csvName="epic-report"
        csv={() => members.items.map((i) => ({ key: i.key, name: i.name, state: names.get(i.state) ?? i.group, points: i.points ?? '', created: new Date(i.createdAt).toISOString().slice(0, 10), completed: i.completedAt ? new Date(i.completedAt).toISOString().slice(0, 10) : '' }))}
      />
      {!mod ? null : members.isLoading ? <Loading /> : members.error ? <SourceNote {...classifyError(members.error)} /> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Done" value={`${f.done}/${f.total}`} hint={f.total ? `${Math.round((f.done / f.total) * 100)}%` : undefined} />
            <Stat label="Remaining" value={f.remaining} />
            <Stat label="Throughput" value={`${f.ratePerWeek.toFixed(1)}/wk`} hint="last 4 weeks" />
            <Stat
              label="Forecast"
              value={f.remaining === 0 ? 'Done' : f.eta ? new Date(f.eta).toISOString().slice(0, 10) : '—'}
              hint={f.remaining && !f.eta ? 'nothing finished lately' : target && f.eta && f.eta > target + DAY ? `after target (${mod.target_date})` : target && f.eta ? 'before target' : undefined}
              tone={target && f.eta && f.eta > target + DAY ? 'warn' : undefined}
            />
          </div>
          <Card>
            <Meter value={f.total ? (f.done / f.total) * 100 : 0} color={c(0)} />
            <div className="mt-4">
              <LineChart
                height={220}
                series={[
                  { name: 'Scope', color: c(1), points: b.map((x) => [x.t, base.length + x.cumCreated]) },
                  { name: 'Done', color: c(0), points: b.map((x) => [x.t, base.filter((i) => i.group === 'completed' && (i.completedAt ?? 0) < from).length + x.cumResolved]) },
                ]}
              />
            </div>
            <Provenance>Burnup from the epic's current issues (Plane module membership). Forecast = remaining ÷ items finished per week over the last 4 weeks — a projection, not a promise.</Provenance>
          </Card>
          <Card>
            <div className="mb-1 flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold text-content">Open in this epic ({open.length})</h3>
              <button type="button" className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => drill.issues({ module: mod.name, statusCategory: OPEN_CATEGORIES })}>Open in Issues →</button>
            </div>
            {open.length ? <ul className="divide-y divide-edge-subtle">{open.slice(0, 15).map((i) => <ItemRow key={i.id} item={i} stateName={names.get(i.state)} now={ctx.now} onOpen={() => drill.item(i)} />)}</ul> : <p className="text-[12px] text-content-subtle">Nothing open.</p>}
          </Card>
        </>
      )}
    </>
  )
}

