import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { Button, EmptyState, PageHeader, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import {
  addWidget,
  type DashboardLayout,
  defaultLayout,
  packLayout,
  removeWidget,
  resizeWidget,
  SIZE_LABEL,
  SIZES,
  sizeOfSpan,
  spanClass,
  WIDGET_BY_TYPE,
  type WidgetInstance,
  type WidgetSize,
  type WidgetType,
} from '../data/dashboard-layout.ts'
import { useDashboardLayout } from '../data/dashboard-store.ts'
import { useDrill } from '../data/insights-drill.ts'
import {
  classifyError,
  type Me,
  MAX_SCOPE_PROJECTS,
  type ProjectData,
  useCyclesFor,
  useIntakeCounts,
  useMe,
  useMemberNames,
  usePairIds,
  useProjectsData,
  useReleases,
  useScopeProjects,
} from '../data/insights-data.ts'
import {
  burn,
  createdVsResolved,
  DAY,
  type Group,
  GROUP_LABEL,
  isDueWithin,
  isOpen,
  isOverdue,
  percentile,
  startOfDay,
  toMs,
  type WorkItem,
} from '../data/insights-math.ts'
import { OPEN_CATEGORIES } from '../data/insights-nav.ts'
import { currentQuarter, objectiveProgress, paceStatus, statusMeta, useAllObjectives } from '../data/okrs.ts'
import { useLinkResolver } from '../data/okrs-links.ts'
import { ItemRow, Loading, Panel, SourceNote, Stat, useGroupColor } from '../components/insights-ui.tsx'
import { LineChart, Meter, MiniBurn, RankBars, SegmentBar, useSeriesColor } from '../components/insights-viz.tsx'
import { StickyNotes } from '../components/sticky-notes.tsx'
import { ProjectPicker } from '../components/project-picker.tsx'
import { SortableGrid } from '../components/dashboard-grid.tsx'
import { WidgetPicker } from '../components/widget-picker.tsx'

/**
 * Define dashboard — a configurable widget grid over live Plane data.
 *
 * Each person arranges their own (Customize: add from the widget gallery,
 * remove, drag or arrow-key to reorder, resize; saved per user in docStore
 * `define.dashboard`) and picks what it covers from the header: every Plane
 * project, or one. Widgets always pack into full rows (see `packLayout`).
 * Every number drills into Issues with the JQL-like query that produced it.
 */
export function Dashboard({
  projectId,
  onOpenProject: _onOpenProject,
  onPickProject,
}: {
  projectId?: string
  onOpenProject?(id: string): void
  onPickProject?(id: string): void
}) {
  const { layout, update, persistence, error } = useDashboardLayout()
  const [editing, setEditing] = useState(false)
  const [picker, setPicker] = useState(false)
  const toast = useToast()
  const scope = useScopeProjects(layout.scope, projectId)
  const has = (t: WidgetType) => layout.widgets.some((w) => w.type === t)
  const data = useProjectsData(scope.projects, { labels: has('bug-trend') || has('blocked') })
  const me = useMe()
  const now = useMemo(() => Date.now(), [data.updatedAt])
  const ctx: WidgetCtx = { data, projects: scope.projects, me, now, has }
  const err = data.errors[0] ? classifyError(data.errors[0]) : null
  const present = useMemo(() => new Set(layout.widgets.map((w) => w.type)), [layout.widgets])

  // Saving to the account failed: say so once, as a toast — the layout keeps
  // working in this browser.
  useEffect(() => {
    if (error) toast.error('Layout saved in this browser only', { description: error })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  const commit = useCallback((next: DashboardLayout, undo?: { title: string; prev: DashboardLayout }) => {
    update(next)
    if (undo) toast.success(undo.title, { action: { label: 'Undo', onClick: () => update(undo.prev) } })
  }, [update, toast])

  const add = (type: WidgetType) => {
    commit(addWidget(layout, type))
    toast.success(`Added “${WIDGET_BY_TYPE.get(type)!.title}”`)
  }
  const remove = (w: WidgetInstance) => commit(removeWidget(layout, w.id), { title: `Removed “${WIDGET_BY_TYPE.get(w.type)!.title}”`, prev: layout })
  const resetLayout = () => commit({ ...defaultLayout(), scope: layout.scope }, { title: 'Dashboard reset to the default layout', prev: layout })

  const pickerEl = (
    <ProjectPicker
      variant="compact"
      align="right"
      value={projectId}
      allSelected={layout.scope === 'all'}
      onSelectAll={() => update({ ...layout, scope: 'all' })}
      onChange={(id) => {
        onPickProject?.(id)
        if (layout.scope !== 'project') update({ ...layout, scope: 'project' })
      }}
    />
  )

  return (
    <div className="space-y-4">
      <PageHeader
        compact
        title="Dashboard"
        badge={scope.capped
          ? <span title={`Plane allows the console's API key 60 requests a minute, so the dashboard reads the first ${MAX_SCOPE_PROJECTS} projects. Pick one project to see any other.`}><StatusBadge kind="info">First {MAX_SCOPE_PROJECTS} of {scope.total} projects</StatusBadge></span>
          : editing
          ? <StatusBadge kind="info">Editing layout</StatusBadge>
          : null}
        actions={editing
          ? (
            <>
              <Button size="sm" leading={<PlusGlyph />} onClick={() => setPicker(true)}>Add widgets</Button>
              <Button size="sm" variant="ghost" onClick={resetLayout}>Reset to default</Button>
              <Button size="sm" variant="primary" onClick={() => setEditing(false)}>Done</Button>
            </>
          )
          : (
            <>
              {pickerEl}
              <Button size="sm" leading={<LayoutGlyph />} onClick={() => setEditing(true)}>Customize</Button>
            </>
          )}
      />

      {editing
        ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-brand-300/70 bg-brand-50/50 px-3 py-2 text-[12px] text-content-muted dark:border-brand-500/40 dark:bg-brand-500/10">
            <span className="font-medium text-content">Drag widgets to rearrange.</span>
            <span>Keyboard: focus a grip, then use the arrow keys.</span>
            <span className="hidden md:inline">Pick a width from each widget's toolbar — rows always stay full.</span>
            {persistence === 'browser' ? <span className="text-content-subtle">Saved in this browser only — the console database isn't available.</span> : null}
          </div>
        )
        : null}

      {err ? <SourceNote kind={err.kind} message={err.message} /> : null}
      {me.unmatched && me.user ? <SourceNote kind="other" title="You aren’t a Plane member yet" message={`No Plane member has your console email (${me.user.email}), so the "assigned to me" widgets are empty. Open Plane once and sign in with Keycloak — that adds you to the workspace.`} /> : null}

      {!scope.ready
        ? <Loading label="Loading projects…" />
        : !scope.projects.length
        ? (
          <EmptyState
            icon={<EmptyIcon name="folder" />}
            title={layout.scope === 'project' ? 'Pick a project' : 'No Plane projects yet'}
            description={layout.scope === 'project' ? 'Choose a project from the picker above, or show every project.' : 'Create a project on the Projects page to start planning work.'}
            action={layout.scope === 'project' ? <Button size="sm" variant="primary" onClick={() => update({ ...layout, scope: 'all' })}>Show all projects</Button> : undefined}
          />
        )
        : !layout.widgets.length
        ? (
          <EmptyState
            icon={<EmptyIcon name="widgets" />}
            title="Your dashboard is empty"
            description="Add widgets from the gallery, or go back to the default layout."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" variant="primary" onClick={() => setPicker(true)}>Add widgets</Button>
                <Button size="sm" onClick={resetLayout}>Use default layout</Button>
              </div>
            }
          />
        )
        : (
          <SortableGrid
            items={layout.widgets}
            editing={editing}
            classesFor={(order) => packLayout(order).map(spanClass)}
            label={(w) => WIDGET_BY_TYPE.get(w.type)!.title}
            onReorder={(next) => update({ ...layout, widgets: next })}
            render={(w, st) => (
              <WidgetFrame
                w={w}
                span={packLayout(layout.widgets).find((p) => p.widget.id === w.id)?.span ?? 12}
                editing={editing}
                ghost={st.ghost}
                handle={st.handle}
                onResize={(s) => update(resizeWidget(layout, w.id, s))}
                onRemove={() => remove(w)}
                ctx={ctx}
              />
            )}
          />
        )}

      <WidgetPicker
        open={picker}
        onClose={() => setPicker(false)}
        present={present}
        onAdd={add}
        onRemove={(t) => {
          const w = layout.widgets.find((x) => x.type === t)
          if (w) remove(w)
        }}
      />
    </div>
  )
}

interface WidgetCtx {
  data: ProjectData
  projects: plane.Project[]
  me: Me
  now: number
  has(t: WidgetType): boolean
}

const SIZE_GLYPH: Record<WidgetSize, string> = { s: '⅓', m: '½', w: '⅔', l: 'Full' }

function WidgetFrame({ w, span, editing, ghost, handle, onResize, onRemove, ctx }: {
  w: WidgetInstance
  /** Desktop span the packed row gives this widget. */
  span: number
  editing: boolean
  ghost: boolean
  handle: ReactNode
  onResize(s: WidgetSize): void
  onRemove(): void
  ctx: WidgetCtx
}) {
  const def = WIDGET_BY_TYPE.get(w.type)!
  const body = w.type === 'notes'
    ? <StickyNotes />
    : (
      <Panel title={def.title} className="h-full">
        <WidgetBody type={w.type} ctx={ctx} size={sizeOfSpan(span)} />
      </Panel>
    )
  if (!editing && !ghost) return body
  const current = sizeOfSpan(span)
  return (
    <div className={cn('group/w relative h-full rounded-xl transition-shadow', !ghost && 'outline-2 outline-offset-2 outline-dashed outline-brand-300/70 hover:shadow-lg hover:outline-brand-400 dark:outline-brand-500/40 dark:hover:outline-brand-400/70')}>
      {/* The widget stays live underneath but inert, so the whole card drags. */}
      <div className="pointer-events-none h-full select-none" aria-hidden inert>{body}</div>
      <div className="absolute inset-x-0 top-0 z-10 flex h-11 items-center gap-1 rounded-t-xl border-b border-brand-200/80 bg-surface-raised/95 pl-1.5 pr-1.5 backdrop-blur-sm dark:border-brand-500/30">
        {handle}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-content">{def.title}</span>
        {!ghost
          ? (
            <>
              <div role="group" aria-label={`Width of ${def.title}`} className="hidden items-center rounded-md border border-edge-default bg-surface-sunken/60 p-0.5 md:flex">
                {SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={current === s}
                    aria-label={SIZE_LABEL[s]}
                    title={SIZE_LABEL[s]}
                    onClick={() => onResize(s)}
                    className={cn(
                      'h-6 min-w-7 rounded px-1.5 text-[11px] font-semibold tabular-nums transition-colors',
                      current === s ? 'bg-surface-raised text-brand-700 shadow-sm ring-1 ring-edge-default dark:text-brand-200' : 'text-content-muted hover:text-content',
                    )}
                  >
                    {SIZE_GLYPH[s]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-label={`Remove ${def.title}`}
                title="Remove widget"
                onClick={onRemove}
                className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 sm:h-7 sm:w-7 dark:hover:bg-rose-500/15 dark:hover:text-rose-300"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </>
          )
          : null}
      </div>
    </div>
  )
}

function PlusGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
}

function LayoutGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

/* ───── widgets ───── */

const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
const byUrgency = (a: WorkItem, b: WorkItem) =>
  (PRIORITY_RANK[a.priority] ?? 5) - (PRIORITY_RANK[b.priority] ?? 5) || (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999')

function WidgetBody({ type, ctx, size }: { type: WidgetType; ctx: WidgetCtx; size: WidgetSize }) {
  const { data } = ctx
  if (data.isLoading && !data.items.length && type !== 'releases' && type !== 'okrs') return <Loading />
  // Never draw zeros for data that failed to load — say it's unavailable.
  if (data.errors.length && !data.items.length && !['releases', 'okrs', 'intake', 'active-sprints'].includes(type)) {
    return <SourceNote compact {...classifyError(data.errors[0])} />
  }
  switch (type) {
    case 'counters':
      return <Counters ctx={ctx} />
    case 'my-open':
      return <MyOpen ctx={ctx} />
    case 'due-soon':
      return <DueSoon ctx={ctx} />
    case 'active-sprints':
      return <ActiveSprints ctx={ctx} />
    case 'by-state':
      return <ByState ctx={ctx} />
    case 'by-priority':
      return <ByPriority ctx={ctx} />
    case 'by-assignee':
      return <ByAssignee ctx={ctx} />
    case 'created-resolved':
      return <CreatedResolved ctx={ctx} height={size === 's' ? 140 : 180} />
    case 'bug-trend':
      return <CreatedResolved ctx={ctx} height={size === 's' ? 140 : 180} bugs />
    case 'cycle-time':
      return <CycleTime ctx={ctx} />
    case 'blocked':
      return <Blocked ctx={ctx} />
    case 'intake':
      return <IntakeQueue ctx={ctx} />
    case 'recent':
      return <Recent ctx={ctx} />
    case 'releases':
      return <Releases ctx={ctx} />
    case 'okrs':
      return <OkrProgress ctx={ctx} />
    default:
      return null
  }
}

function stateNames(ctx: WidgetCtx) {
  return new Map(ctx.data.states.map((s) => [s.id, s.name]))
}

function Counters({ ctx }: { ctx: WidgetCtx }) {
  const { items } = ctx.data
  const d = useDrill(ctx.projects)
  const me = ctx.me.planeId
  const open = items.filter(isOpen)
  const mine = me ? open.filter((i) => i.assignees.includes(me)) : []
  const reported = me ? open.filter((i) => i.createdBy === me) : []
  const due = open.filter((i) => isDueWithin(i, ctx.now, 7))
  const overdue = open.filter((i) => isOverdue(i, ctx.now))
  const done30 = items.filter((i) => i.group === 'completed' && (i.completedAt ?? 0) >= ctx.now - 30 * DAY)
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Assigned to me" value={me ? mine.length : '—'} hint={me ? `${mine.filter((i) => i.group === 'started').length} in progress` : 'not a Plane member'} onClick={me ? () => d.issues({ assignee: 'me', statusCategory: OPEN_CATEGORIES }) : undefined} />
      <Stat label="Reported by me" value={me ? reported.length : '—'} hint="open, created by you" onClick={me ? () => d.issues({ reporter: 'me', statusCategory: OPEN_CATEGORIES }) : undefined} />
      <Stat label="Due in 7 days" value={due.length} tone={due.length ? 'warn' : undefined} onClick={() => d.issues({ statusCategory: OPEN_CATEGORIES, due: '<= +7d' })} />
      <Stat label="Overdue" value={overdue.length} tone={overdue.length ? 'bad' : undefined} onClick={() => d.issues({ statusCategory: OPEN_CATEGORIES, due: '< today()' })} />
      <Stat label="Open" value={open.length} hint={`${items.length} total`} onClick={() => d.issues({ statusCategory: OPEN_CATEGORIES })} />
      <Stat label="Done · 30 days" value={done30.length} onClick={() => d.issues({ statusCategory: ['completed'], resolved: '>= -30d' })} />
    </div>
  )
}

function ItemList({ ctx, items, empty, more }: { ctx: WidgetCtx; items: WorkItem[]; empty: string; more?(): void }) {
  const d = useDrill(ctx.projects)
  const names = stateNames(ctx)
  if (!items.length) return <p className="py-3 text-center text-[12px] text-content-subtle">{empty}</p>
  return (
    <div>
      <ul className="divide-y divide-edge-subtle">
        {items.slice(0, 8).map((i) => <ItemRow key={i.id} item={i} stateName={names.get(i.state)} now={ctx.now} onOpen={() => d.item(i)} />)}
      </ul>
      {items.length > 8 && more ? <button type="button" onClick={more} className="mt-2 text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">All {items.length} →</button> : null}
    </div>
  )
}

function MyOpen({ ctx }: { ctx: WidgetCtx }) {
  const d = useDrill(ctx.projects)
  const me = ctx.me.planeId
  if (!me) return <p className="text-[12px] text-content-subtle">Your console account isn't matched to a Plane member, so nothing is assigned to you here.</p>
  const mine = ctx.data.items.filter((i) => isOpen(i) && i.assignees.includes(me)).sort(byUrgency)
  return <ItemList ctx={ctx} items={mine} empty="Nothing open is assigned to you. 🎉" more={() => d.issues({ assignee: 'me', statusCategory: OPEN_CATEGORIES })} />
}

function DueSoon({ ctx }: { ctx: WidgetCtx }) {
  const d = useDrill(ctx.projects)
  const rows = ctx.data.items.filter((i) => isOverdue(i, ctx.now) || isDueWithin(i, ctx.now, 7)).sort((a, b) => (a.targetDate ?? '').localeCompare(b.targetDate ?? ''))
  return <ItemList ctx={ctx} items={rows} empty="Nothing due in the next 7 days." more={() => d.issues({ statusCategory: OPEN_CATEGORIES, due: '<= +7d' })} />
}

function ActiveSprints({ ctx }: { ctx: WidgetCtx }) {
  const cycles = useCyclesFor(ctx.projects.map((p) => p.id))
  const color = useSeriesColor()(0)
  const d = useDrill(ctx.projects)
  const active = cycles.flatMap((q) => q.data ?? []).filter((c) => c.status === 'current' && !c.archived_at).slice(0, 6)
  const ids = usePairIds('cycle', active.map((c) => ({ project: c.project, id: c.id })))
  if (cycles.some((q) => q.isLoading)) return <Loading />
  const err = cycles.find((q) => q.error)?.error
  if (err) return <SourceNote compact {...classifyError(err)} />
  if (!active.length) return <p className="py-3 text-center text-[12px] text-content-subtle">No cycle is running in this scope.</p>
  const byId = new Map(ctx.data.items.map((i) => [i.id, i]))
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {active.map((c, k) => {
        const memberIds = ids[k]?.data
        const items = (memberIds ?? []).map((id) => byId.get(id)).filter((i): i is WorkItem => !!i)
        const start = toMs(c.start_date) ?? ctx.now
        const end = toMs(c.end_date) ?? ctx.now
        const b = memberIds ? burn(items, start, end, ctx.now) : null
        const left = Math.max(0, Math.ceil((end + DAY - ctx.now) / DAY))
        const project = ctx.projects.find((p) => p.id === c.project)
        return (
          <li key={c.id} className="rounded-lg border border-edge-subtle bg-surface-sunken/30 p-3">
            <button type="button" className="block w-full text-left" onClick={() => d.open('reports', { report: 'burndown', cycle: c.id, project: c.project })}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] font-semibold text-content">{c.name}</span>
                <span className="shrink-0 text-[11px] text-content-subtle">{left} day{left === 1 ? '' : 's'} left</span>
              </div>
              {ctx.projects.length > 1 && project ? <div className="text-[11px] text-content-subtle">{project.name}</div> : null}
              <div className="mt-2 flex items-end justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-content-muted">{c.completed_issues ?? 0} of {(c.total_issues ?? 0) - (c.cancelled_issues ?? 0)} done</div>
                  <Meter className="mt-1" value={c.progress ?? 0} color={color} />
                </div>
                {b ? <MiniBurn remaining={b.points.filter((p) => p.remaining !== undefined).map((p) => [p.t, p.remaining!])} ideal={b.points.map((p) => [p.t, p.ideal])} color={color} width={110} height={36} /> : <div className="h-9 w-27.5 animate-pulse rounded bg-surface-sunken" />}
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ByState({ ctx }: { ctx: WidgetCtx }) {
  const color = useGroupColor()
  const d = useDrill(ctx.projects)
  const groups: Group[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']
  const parts = groups.map((g) => ({ key: g, label: GROUP_LABEL[g], value: ctx.data.items.filter((i) => i.group === g).length, color: color(g) }))
  return <SegmentBar parts={parts} onSelect={(g) => d.issues({ statusCategory: [g] })} />
}

function ByPriority({ ctx }: { ctx: WidgetCtx }) {
  const color = useSeriesColor()(0)
  const d = useDrill(ctx.projects)
  const open = ctx.data.items.filter(isOpen)
  const rows = ['urgent', 'high', 'medium', 'low', 'none'].map((p) => ({ key: p, label: p === 'none' ? 'No priority' : p[0].toUpperCase() + p.slice(1), value: open.filter((i) => i.priority === p).length }))
  return <RankBars rows={rows} color={color} format={String} onSelect={(p) => d.issues({ statusCategory: OPEN_CATEGORIES, priority: [p] })} />
}

function ByAssignee({ ctx }: { ctx: WidgetCtx }) {
  const color = useSeriesColor()(0)
  const name = useMemberNames()
  const d = useDrill(ctx.projects)
  const counts = new Map<string, number>()
  for (const i of ctx.data.items.filter(isOpen)) for (const a of i.assignees.length ? i.assignees : ['']) counts.set(a, (counts.get(a) ?? 0) + 1)
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ key: k, label: name(k), value: v }))
  return (
    <RankBars
      rows={rows}
      color={color}
      format={String}
      empty="No open work."
      onSelect={(k) => d.issues({ statusCategory: OPEN_CATEGORIES, assignee: k ? (k === ctx.me.planeId ? 'me' : name(k)) : 'EMPTY' })}
    />
  )
}

function bugLabelIds(ctx: WidgetCtx): Set<string> {
  return new Set(ctx.data.labels.filter((l) => /\b(bug|defect)s?\b/i.test(l.name)).map((l) => l.id))
}

function CreatedResolved({ ctx, height, bugs }: { ctx: WidgetCtx; height: number; bugs?: boolean }) {
  const c = useSeriesColor()
  const d = useDrill(ctx.projects)
  const ids = bugs ? bugLabelIds(ctx) : null
  const items = ids ? ctx.data.items.filter((i) => i.labels.some((l) => ids.has(l))) : ctx.data.items
  const from = startOfDay(ctx.now - 29 * DAY)
  const buckets = createdVsResolved(items, from, ctx.now)
  if (bugs && ids && !ids.size) return <p className="py-3 text-[12px] text-content-subtle">No label named “bug” or “defect” in this scope — add one in the project's labels to track bugs.</p>
  return (
    <div>
      <LineChart
        height={height}
        series={[
          { name: 'Created', color: c(1), points: buckets.map((b) => [b.t, b.cumCreated]) },
          { name: 'Resolved', color: c(0), points: buckets.map((b) => [b.t, b.cumResolved]) },
        ]}
        emptyLabel="No activity in the last 30 days."
      />
      <div className="mt-2 flex items-center justify-between text-[11px] text-content-subtle">
        <span>Cumulative, last 30 days · {buckets.at(-1)?.cumCreated ?? 0} created, {buckets.at(-1)?.cumResolved ?? 0} resolved</span>
        <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => d.issues({ ...(bugs ? { label: 'bug' } : {}), created: '>= -30d' })}>Open →</button>
      </div>
    </div>
  )
}

function CycleTime({ ctx }: { ctx: WidgetCtx }) {
  const d = useDrill(ctx.projects)
  const done = ctx.data.items.filter((i) => i.group === 'completed' && (i.completedAt ?? 0) >= ctx.now - 30 * DAY)
  const lead = done.map((i) => ((i.completedAt ?? 0) - i.createdAt) / DAY)
  const fmt = (v: number) => (v < 1 ? `${Math.round(v * 24)}h` : `${v.toFixed(1)}d`)
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Median lead time" value={lead.length ? fmt(percentile(lead, 50)) : '—'} />
        <Stat label="85th percentile" value={lead.length ? fmt(percentile(lead, 85)) : '—'} />
      </div>
      <p className="text-[11px] text-content-subtle">
        Created → done for {done.length} item{done.length === 1 ? '' : 's'} finished in 30 days. Cycle time (started → done) needs state history —{' '}
        <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => d.open('reports', { report: 'control', project: ctx.projects[0]?.id })}>control chart</button>.
      </p>
    </div>
  )
}

function Blocked({ ctx }: { ctx: WidgetCtx }) {
  const d = useDrill(ctx.projects)
  const blockedStates = new Set(ctx.data.states.filter((s) => /block/i.test(s.name)).map((s) => s.id))
  const blockedLabels = new Set(ctx.data.labels.filter((l) => /block/i.test(l.name)).map((l) => l.id))
  const rows = ctx.data.items.filter((i) => isOpen(i) && (blockedStates.has(i.state) || i.labels.some((l) => blockedLabels.has(l))))
  if (!blockedStates.size && !blockedLabels.size) {
    return <p className="text-[12px] text-content-subtle">No state or label named “Blocked” in this scope. Add one to the workflow to track blocked work.</p>
  }
  const stateName = ctx.data.states.find((s) => blockedStates.has(s.id))?.name
  return <ItemList ctx={ctx} items={rows} empty="Nothing is blocked." more={() => d.issues(stateName ? { state: stateName } : { label: 'blocked' })} />
}

function IntakeQueue({ ctx }: { ctx: WidgetCtx }) {
  const projects = ctx.projects.filter((p) => p.intake_view ?? p.inbox_view ?? true)
  const qs = useIntakeCounts(projects.map((p) => p.id))
  const d = useDrill(ctx.projects)
  if (qs.some((q) => q.isLoading)) return <Loading />
  const rows = projects.map((p, k) => ({ p, pending: (qs[k]?.data ?? []).filter((x) => x.status === -2).length, err: qs[k]?.error }))
  const total = rows.reduce((a, r) => a + r.pending, 0)
  const err = rows.find((r) => r.err)?.err
  return (
    <div className="space-y-2">
      <Stat label="Waiting for triage" value={total} tone={total > 10 ? 'warn' : undefined} onClick={() => d.open('intake', { project: ctx.projects[0]?.id })} />
      {err ? <SourceNote compact {...classifyError(err)} /> : null}
      {rows.length > 1
        ? (
          <ul className="space-y-1 text-[12px]">
            {rows.filter((r) => r.pending).slice(0, 5).map((r) => (
              <li key={r.p.id} className="flex justify-between gap-2">
                <button type="button" className="truncate text-left text-content hover:underline" onClick={() => d.open('intake', { project: r.p.id })}>{r.p.name}</button>
                <span className="tabular-nums text-content-muted">{r.pending}</span>
              </li>
            ))}
          </ul>
        )
        : null}
    </div>
  )
}

function Recent({ ctx }: { ctx: WidgetCtx }) {
  const d = useDrill(ctx.projects)
  const names = stateNames(ctx)
  const rows = [...ctx.data.items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  if (!rows.length) return <p className="py-3 text-center text-[12px] text-content-subtle">No work items yet.</p>
  return (
    <div>
      <ul className="divide-y divide-edge-subtle">
        {rows.map((i) => (
          <ItemRow key={i.id} item={i} stateName={names.get(i.state)} now={ctx.now} onOpen={() => d.item(i)} trailing={<span className="hidden w-24 shrink-0 whitespace-nowrap text-right text-[11px] text-content-subtle md:inline">{formatRelative(i.updatedAt)}</span>} />
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-content-subtle">Plane's public API has no workspace activity feed; this lists the most recently updated items.</p>
    </div>
  )
}

function Releases({ ctx }: { ctx: WidgetCtx }) {
  const q = useReleases(ctx.has('releases'))
  const d = useDrill(ctx.projects)
  const color = useSeriesColor()(0)
  const byId = new Map(ctx.data.items.map((i) => [i.id, i]))
  if (q.isLoading) return <Loading />
  if (q.error) return <SourceNote compact {...classifyError(q.error)} />
  const ids = new Set(ctx.projects.map((p) => p.id))
  const today = new Date(startOfDay(ctx.now)).toISOString().slice(0, 10)
  const rows = (q.data ?? [])
    .filter((r) => !r.project || ids.has(r.project))
    .filter((r) => !r.date || r.date >= addDaysIso(today, -14))
    .filter((r) => !/^(released|archived|done|shipped|cancelled)$/i.test(r.status ?? ''))
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))
    .slice(0, 6)
  if (!rows.length) {
    return (
      <p className="py-3 text-center text-[12px] text-content-subtle">
        No upcoming releases. <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => d.open('releases')}>Plan one →</button>
      </p>
    )
  }
  return (
    <ul className="divide-y divide-edge-subtle">
      {rows.map((r) => {
        const days = r.date ? Math.round((toMs(r.date)! - startOfDay(ctx.now)) / DAY) : undefined
        const its = r.issues.map((id) => byId.get(id)).filter((i): i is WorkItem => !!i && i.group !== 'cancelled')
        const done = its.filter((i) => i.group === 'completed').length
        return (
          <li key={r.id} className="py-2">
            <div className="flex items-center gap-3">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-[13px] text-content hover:underline" onClick={() => d.open('releases', { project: r.project })}>{r.name}</button>
              <span className={cn('shrink-0 text-[11px] tabular-nums', days !== undefined && days < 0 ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-content-muted')}>
                {r.date ? (days === 0 ? 'today' : days! < 0 ? `${-days!}d late · ${r.date}` : `in ${days}d · ${r.date}`) : 'no date'}
              </span>
            </div>
            {its.length ? <Meter className="mt-1" value={its.length ? (done / its.length) * 100 : 0} color={color} label={`${done} of ${its.length} items done`} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

function OkrProgress({ ctx }: { ctx: WidgetCtx }) {
  const q = useAllObjectives()
  const color = useSeriesColor()(0)
  const d = useDrill(ctx.projects)
  const quarter = currentQuarter()
  const ids = new Set(ctx.projects.map((p) => p.id))
  const all = q.data ?? []
  const rows = all.filter((o) => o.quarter === quarter && (!o.project || ids.has(o.project))).slice(0, 6)
  const resolve = useLinkResolver(rows)
  if (q.isLoading) return <Loading />
  if (q.error) return <SourceNote compact {...classifyError(q.error)} />
  if (!rows.length) {
    return (
      <p className="py-3 text-center text-[12px] text-content-subtle">
        No objectives for {quarter}. <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => d.open('okrs', { project: ctx.projects[0]?.id })}>Set OKRs →</button>
      </p>
    )
  }
  return (
    <ul className="space-y-3">
      {rows.map((o) => {
        const p = objectiveProgress(o, all, resolve)
        const st = statusMeta(paceStatus(p, o.quarter))
        return (
          <li key={o.id}>
            <button type="button" className="block w-full text-left" onClick={() => d.open('okrs', { objective: o.id, quarter, project: o.project || ctx.projects[0]?.id })}>
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="min-w-0 truncate text-content">{o.title}</span>
                <span className="shrink-0 tabular-nums text-content">{p}%</span>
              </div>
              <Meter className="mt-1" value={p} color={color} label={<>{st.label} · {o.key_results.length} key result{o.key_results.length === 1 ? '' : 's'}</>} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

