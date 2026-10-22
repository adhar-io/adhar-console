import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyIcon } from '../components/empty-icon.tsx'
import { useQuery } from '@tanstack/react-query'
import { Button, Checkbox, EmptyState, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { planeError, useProjects } from '../data/plane.ts'
import { useModulesIssueIds, usePlanRelations, usePortfolio, useReschedule } from '../data/planning-plane.ts'
import { toReleases, useProjectMetas, useReleaseDocs } from '../data/planning-store.ts'
import { DAY_MS, startOfDay, toMs, wallNow } from '../data/planning-model.ts'
import { barFor, criticalPath, dependencyEdges, edgePath, PX_PER_DAY, scheduleConflicts, shiftDates, type Span, ticks, timelineRange, type Zoom } from '../data/planning-roadmap.ts'
import { planningHref, usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { EPIC_STATUS } from './modules.tsx'
import { fmtDate, Loading, Notice, ProblemState, Segmented } from '../components/planning-ui.tsx'

/**
 * Roadmap — a timeline of epics and work items across one project or all of
 * them. Bars come from Plane dates; drag a bar to move it, drag an edge to
 * change its start or end (a date PATCH to Plane). Dependency arrows come
 * from Plane's "blocks / blocked by" relations (one call per work item, so
 * they load on demand, capped); the critical path is the latest-finishing
 * chain of blockers. Releases show as milestones.
 */

type Group = 'project' | 'epic' | 'team'
type Scope = 'project' | 'all'

interface Row {
  key: string
  kind: 'group' | 'epic' | 'issue'
  id: string
  project: string
  label: string
  sub?: string
  span?: Span
  color?: string
  done?: boolean
}

const ROW_H = 30
const LABEL_W = 220

export function Roadmap({ projectId }: { projectId?: string }) {
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const zoom: Zoom = params.zoom === 'week' || params.zoom === 'quarter' ? params.zoom : 'month'
  const [scope, setScope] = useState<Scope>('project')
  const group: Group = params.group === 'epic' && scope === 'project' ? 'epic' : params.group === 'team' ? 'team' : 'project'
  const [showItems, setShowItems] = useState(true)
  const [deps, setDeps] = useState(false)
  const [critical, setCritical] = useState(false)
  const [openIssue, setOpenIssue] = useState<{ project: string; id: string } | null>(null)

  const projects = useProjects()
  const metas = useProjectMetas()
  const releases = useReleaseDocs()
  const ids = useMemo(() => (scope === 'all' ? (projects.data ?? []).filter((p) => !p.archived_at).map((p) => p.id) : projectId ? [projectId] : []), [scope, projects.data, projectId])
  const portfolio = usePortfolio(ids, { modules: true })
  const epicIds = useMemo(() => (group === 'epic' && projectId ? (portfolio.modules.get(projectId) ?? []).map((m) => m.id) : []), [group, projectId, portfolio.modules])
  const epicMembership = useModulesIssueIds(group === 'epic' ? projectId : undefined, epicIds)
  const ws = useQuery({
    queryKey: ['workspace', 'projects', 'all'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/projects', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      return ((await res.json()) as { items?: Array<{ slug: string; teams?: string[] }> }).items ?? []
    },
    enabled: group === 'team',
    staleTime: 60_000,
    retry: false,
  })
  const reschedule = useReschedule()
  const toast = useToast()
  const now = wallNow()

  const projectName = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p])), [projects.data])

  // Rows, grouped.
  const { rows, undated } = useMemo(() => {
    const out: Row[] = []
    let undated = 0
    const issueRow = (i: plane.PlanIssue): Row | null => {
      if (!i.start_date && !i.target_date) {
        if (i.state_group !== 'completed' && i.state_group !== 'cancelled') undated++
        return null
      }
      const p = projectName.get(i.project)
      return {
        key: `i:${i.id}`,
        kind: 'issue',
        id: i.id,
        project: i.project,
        label: i.name,
        sub: p ? `${p.identifier}-${i.sequence_id}` : undefined,
        span: { id: i.id, start: i.start_date, end: i.target_date },
        color: i.state_color,
        done: i.state_group === 'completed' || i.state_group === 'cancelled',
      }
    }
    const epicRow = (m: plane.Module): Row => ({
      key: `e:${m.id}`,
      kind: 'epic',
      id: m.id,
      project: m.project,
      label: m.name,
      sub: EPIC_STATUS[m.status]?.label,
      span: { id: m.id, start: m.start_date, end: m.target_date },
      done: m.status === 'completed' || m.status === 'cancelled',
    })
    const byStart = (a: Row, b: Row) => (toMs(a.span?.start ?? a.span?.end) ?? Infinity) - (toMs(b.span?.start ?? b.span?.end) ?? Infinity)

    if (group === 'epic' && projectId) {
      const issues = portfolio.issues.get(projectId) ?? []
      const byId = new Map(issues.map((i) => [i.id, i]))
      const placed = new Set<string>()
      for (const m of portfolio.modules.get(projectId) ?? []) {
        out.push({ ...epicRow(m), kind: 'epic' })
        if (showItems) {
          const kids = (epicMembership.ids.get(m.id) ?? []).map((id) => byId.get(id)).filter((i): i is plane.PlanIssue => !!i)
          for (const i of kids) placed.add(i.id)
          out.push(...kids.map(issueRow).filter((r): r is Row => !!r).sort(byStart))
        }
      }
      if (showItems) {
        const rest = issues.filter((i) => !placed.has(i.id)).map(issueRow).filter((r): r is Row => !!r).sort(byStart)
        if (rest.length) out.push({ key: 'g:none', kind: 'group', id: 'none', project: projectId, label: 'Not in an epic' }, ...rest)
      }
      return { rows: out, undated }
    }

    // Project or team grouping.
    const metaBy = new Map((metas.data ?? []).map((d) => [d.id, d.data]))
    const teamsOf = (pid: string): string[] => {
      const m = metaBy.get(pid)
      const viaProject = ws.data?.find((x) => x.slug === m?.adharProject)?.teams ?? []
      const all = [...new Set([...viaProject, ...(m?.teams ?? [])])]
      return all.length ? all : ['No team']
    }
    const groups = new Map<string, string[]>()
    for (const pid of ids) {
      const keys = group === 'team' ? teamsOf(pid) : [pid]
      for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), pid])
    }
    for (const [k, pids] of groups) {
      out.push({ key: `g:${k}`, kind: 'group', id: k, project: pids[0], label: group === 'team' ? k : projectName.get(k)?.name ?? k })
      for (const pid of pids) {
        const epics = (portfolio.modules.get(pid) ?? []).map(epicRow).filter((r) => r.span?.start || r.span?.end).sort(byStart)
        out.push(...epics.map((r) => ({ ...r, key: `${k}:${r.key}`, sub: group === 'team' ? `${projectName.get(pid)?.identifier ?? ''} · ${r.sub ?? ''}` : r.sub })))
        if (showItems) {
          const items = (portfolio.issues.get(pid) ?? []).map(issueRow).filter((r): r is Row => !!r).sort(byStart)
          out.push(...items.map((r) => ({ ...r, key: `${k}:${r.key}` })))
        }
      }
    }
    return { rows: out, undated }
  }, [group, projectId, portfolio.issues, portfolio.modules, epicMembership.ids, showItems, ids, metas.data, ws.data, projectName])

  // Milestones from releases in scope.
  const milestones = useMemo(
    () => toReleases(releases.data).filter((r) => ids.includes(r.project) && r.release_date && r.status !== 'archived').map((r) => ({ id: r.id, name: r.name, t: startOfDay(toMs(r.release_date)!), released: r.status === 'released' })),
    [releases.data, ids],
  )

  const spans = rows.filter((r) => r.span).map((r) => r.span!)
  const range = timelineRange([...spans, ...milestones.map((m) => ({ id: m.id, start: new Date(m.t).toISOString().slice(0, 10) }))], now, zoom)
  const ppd = PX_PER_DAY[zoom]
  const width = Math.ceil((range.end - range.start) / DAY_MS) * ppd
  const tickList = ticks(range, zoom)

  // Dependencies (opt-in): relations for dated work items in view.
  const issueRows = rows.filter((r) => r.kind === 'issue')
  const relQ = usePlanRelations(issueRows.map((r) => ({ id: r.id, project: r.project })), deps, 40)
  const visible = new Set(issueRows.map((r) => r.id))
  const edges = deps ? dependencyEdges(relQ.relations, visible) : []
  const spanMap = new Map(issueRows.map((r) => [r.id, r.span!]))
  const conflicts = new Set(scheduleConflicts(edges, spanMap).map((e) => `${e.from}>${e.to}`))
  const crit = deps && critical ? criticalPath(edges, spanMap) : new Set<string>()

  // Drag state.
  const [drag, setDrag] = useState<{ row: Row; mode: 'move' | 'start' | 'end'; x0: number; dx: number } | null>(null)
  const dragDays = drag ? Math.round(drag.dx / ppd) : 0
  const scroller = useRef<HTMLDivElement>(null)
  const todayX = ((startOfDay(now) - range.start) / DAY_MS) * ppd
  // Open on today (when the timeline mounts), and again whenever the zoom changes the scale.
  const todayRef = useRef(todayX)
  todayRef.current = todayX
  const toToday = (el: HTMLDivElement | null) => {
    if (el) el.scrollLeft = Math.max(0, todayRef.current - el.clientWidth / 3)
  }
  // Stable identity, so it runs once when the timeline mounts — not on every render.
  const mountScroller = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el
    if (el) el.scrollLeft = Math.max(0, todayRef.current - el.clientWidth / 3)
  }, [])
  useEffect(() => {
    toToday(scroller.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  const commit = (row: Row, mode: 'move' | 'start' | 'end', days: number) => {
    if (!days || !row.span) return
    const next = shiftDates(row.span, days, mode)
    reschedule.mutate({ project: row.project, kind: row.kind === 'epic' ? 'epic' : 'issue', id: row.id, ...next }, {
      onSuccess: () => toast.success(`${row.label}: ${fmtDate(next.start_date)} → ${fmtDate(next.target_date)}`),
      onError: (e) => toast.error(planeError(e, "Couldn't reschedule it.")),
    })
  }

  if (scope === 'project' && !projectId) return <EmptyState icon={<EmptyIcon name="folder" />} title="Pick a project" />
  if (projects.isLoading || (portfolio.loading && !rows.length)) return <Loading label="Loading the roadmap…" />
  if (portfolio.error && !rows.length) return <ProblemState error={portfolio.error} />

  const yOf = new Map(rows.map((r, k) => [r.id, k * ROW_H + ROW_H / 2]))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Scope> label="Scope" value={scope} onChange={setScope} options={[{ value: 'project', label: 'This project' }, { value: 'all', label: 'All projects' }]} />
        <Segmented
          label="Group by"
          value={group}
          onChange={(g) => setParams({ group: g === 'project' ? undefined : g })}
          options={[{ value: 'project', label: 'Project' }, ...(scope === 'project' ? [{ value: 'epic' as const, label: 'Epic' }] : []), { value: 'team', label: 'Team' }]}
        />
        <Segmented label="Zoom" value={zoom} onChange={(z) => setParams({ zoom: z === 'month' ? undefined : z })} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }]} />
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox label="Work items" checked={showItems} onChange={(e) => setShowItems(e.target.checked)} />
          <Checkbox label="Dependencies" checked={deps} onChange={(e) => setDeps(e.target.checked)} />
          {deps ? <Checkbox label="Critical path" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> : null}
        </div>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => {
            toToday(scroller.current)
          }}
        >
          Today
        </Button>
      </div>
      {undated ? <p className="text-[12px] text-content-muted">{undated} open work item{undated === 1 ? '' : 's'} without dates {undated === 1 ? 'is' : 'are'} not shown — give {undated === 1 ? 'it' : 'them'} a start or due date to place {undated === 1 ? 'it' : 'them'}.</p> : null}
      {deps && relQ.skipped ? <Notice>Dependencies loaded for the first 40 work items in view ({relQ.skipped} more not checked) — Plane needs one request per item.</Notice> : null}
      {deps && relQ.error ? <ProblemState compact error={relQ.error} /> : null}

      {rows.length === 0
        ? <EmptyState icon={<EmptyIcon name="roadmap" />} title="Nothing on the roadmap yet" description="Give epics or work items start and due dates and they appear here." />
        : (
          <div className="flex overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
            <div className="shrink-0 border-r border-edge-default" style={{ width: `min(${LABEL_W}px, 40vw)` }}>
              <div className="h-9 border-b border-edge-default" />
              {rows.map((r) => (
                <div key={r.key} className={cn('flex items-center gap-1.5 truncate border-b border-edge-subtle px-3 text-[12px]', r.kind === 'group' && 'bg-surface-sunken font-semibold text-content', r.kind === 'epic' && 'font-medium text-content', r.kind === 'issue' && 'pl-5 text-content-muted')} style={{ height: ROW_H }}>
                  {r.kind === 'issue'
                    ? (
                      <button type="button" onClick={() => setOpenIssue({ project: r.project, id: r.id })} className={cn('truncate text-left hover:text-content', r.done && 'line-through')} title={r.label}>
                        {r.sub ? <span className="mr-1 font-mono text-[10px] text-content-subtle">{r.sub}</span> : null}{r.label}
                      </button>
                    )
                    : r.kind === 'epic'
                    ? <a href={planningHref('modules', { epic: r.id })} className="truncate hover:underline" title={r.label}>{r.label}</a>
                    : <span className="truncate">{r.label}</span>}
                </div>
              ))}
            </div>
            <div ref={mountScroller} className="min-w-0 flex-1 overflow-x-auto">
              <div className="relative" style={{ width, height: 36 + rows.length * ROW_H }}>
                {/* axis */}
                <div className="sticky top-0 h-9 border-b border-edge-default">
                  {tickList.map((t) => (
                    <span key={t.t} className={cn('absolute top-0 flex h-9 items-end pb-1 pl-1 text-[10px]', t.major ? 'text-content-muted' : 'text-content-subtle')} style={{ left: ((t.t - range.start) / DAY_MS) * ppd }}>
                      {t.label}
                    </span>
                  ))}
                  {milestones.map((m) => (
                    <span key={m.id} title={`${m.name} · ${fmtDate(new Date(m.t).toISOString())}`} className="absolute top-0.5 -translate-x-1/2 truncate text-[10px] font-medium text-content" style={{ left: ((m.t - range.start) / DAY_MS) * ppd + ppd / 2, maxWidth: 120 }}>
                      ◆ {m.name}
                    </span>
                  ))}
                </div>
                <svg className="absolute left-0 top-9" width={width} height={rows.length * ROW_H} aria-hidden>
                  {tickList.filter((t) => t.major).map((t) => <line key={t.t} x1={((t.t - range.start) / DAY_MS) * ppd} x2={((t.t - range.start) / DAY_MS) * ppd} y1={0} y2={rows.length * ROW_H} stroke="var(--color-edge-subtle)" />)}
                  {rows.map((r, k) => (r.kind === 'group' ? <rect key={r.key} x={0} y={k * ROW_H} width={width} height={ROW_H} fill="var(--color-surface-sunken)" /> : null))}
                  {milestones.map((m) => {
                    const x = ((m.t - range.start) / DAY_MS) * ppd + ppd / 2
                    return <line key={m.id} x1={x} x2={x} y1={0} y2={rows.length * ROW_H} stroke={m.released ? 'var(--color-emerald-500, #10b981)' : 'var(--color-content-muted)'} strokeDasharray="2 3" />
                  })}
                  <line x1={todayX} x2={todayX} y1={0} y2={rows.length * ROW_H} stroke="var(--color-amber-500, #f59e0b)" strokeWidth="1.5" />
                  {edges.map((e) => {
                    const a = rows.find((r) => r.id === e.from)
                    const b = rows.find((r) => r.id === e.to)
                    const ba = a?.span ? barFor(a.span, range, ppd) : null
                    const bb = b?.span ? barFor(b.span, range, ppd) : null
                    if (!ba || !bb) return null
                    const bad = conflicts.has(`${e.from}>${e.to}`)
                    const hot = crit.has(e.from) && crit.has(e.to)
                    return (
                      <path
                        key={`${e.from}>${e.to}`}
                        d={edgePath({ x: ba.x, w: ba.w, y: yOf.get(e.from)! }, { x: bb.x, y: yOf.get(e.to)! })}
                        fill="none"
                        stroke={bad ? 'var(--color-rose-500, #f43f5e)' : hot ? 'var(--color-brand-500)' : 'var(--color-content-subtle)'}
                        strokeWidth={hot ? 2 : 1.25}
                        markerEnd="url(#rm-arrow)"
                      />
                    )
                  })}
                  <defs>
                    <marker id="rm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--color-content-subtle)" />
                    </marker>
                  </defs>
                </svg>
                {/* bars */}
                <div className="absolute left-0 top-9" style={{ width, height: rows.length * ROW_H }}>
                  {rows.map((r, k) => {
                    if (!r.span) return null
                    const live = drag && drag.row.key === r.key ? shiftDates(r.span, dragDays, drag.mode) : null
                    const b = barFor(live ? { id: r.id, start: live.start_date, end: live.target_date } : r.span, range, ppd)
                    if (!b) return null
                    const hot = crit.has(r.id)
                    return (
                      <div
                        key={r.key}
                        role="button"
                        tabIndex={0}
                        aria-label={`${r.label}, ${fmtDate(r.span.start)} to ${fmtDate(r.span.end)}. Drag to reschedule.`}
                        title={`${r.label}\n${fmtDate(r.span.start)} → ${fmtDate(r.span.end)}`}
                        onPointerDown={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect()
                          const local = e.clientX - rect.left
                          const mode = b.partial ? 'move' : local < 8 ? 'start' : local > rect.width - 8 ? 'end' : 'move'
                          e.currentTarget.setPointerCapture(e.pointerId)
                          setDrag({ row: r, mode, x0: e.clientX, dx: 0 })
                        }}
                        onPointerMove={(e) => drag && drag.row.key === r.key && setDrag({ ...drag, dx: e.clientX - drag.x0 })}
                        onPointerUp={() => {
                          if (drag && drag.row.key === r.key) {
                            const days = Math.round(drag.dx / ppd)
                            setDrag(null)
                            if (days) commit(r, drag.mode, days)
                            else if (r.kind === 'issue') setOpenIssue({ project: r.project, id: r.id })
                          }
                        }}
                        onPointerCancel={() => setDrag(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                            e.preventDefault()
                            commit(r, e.shiftKey ? 'end' : 'move', e.key === 'ArrowRight' ? 1 : -1)
                          }
                        }}
                        className={cn(
                          'absolute flex cursor-grab touch-none items-center overflow-hidden rounded-md px-1.5 text-[10px] font-medium shadow-sm select-none active:cursor-grabbing',
                          r.kind === 'epic' ? 'bg-brand-600 text-white' : 'bg-surface-sunken text-content ring-1 ring-inset ring-edge-default',
                          r.done && 'opacity-50',
                          b.partial && 'border border-dashed border-content-subtle',
                          hot && 'ring-2 ring-brand-400 ring-offset-1 ring-offset-surface-raised',
                          drag?.row.key === r.key && 'opacity-80',
                        )}
                        style={{ left: b.x, width: b.w, top: k * ROW_H + 6, height: ROW_H - 12, borderLeft: r.kind === 'issue' ? `3px solid ${r.color ?? 'var(--color-edge-strong)'}` : undefined }}
                      >
                        <span className="truncate">{b.w > 60 ? r.label : ''}</span>
                      </div>
                    )
                  })}
                </div>
                {drag && dragDays
                  ? <div className="pointer-events-none absolute right-2 top-1 rounded bg-surface-raised px-2 py-0.5 text-[11px] text-content shadow">{dragDays > 0 ? '+' : ''}{dragDays}d</div>
                  : null}
              </div>
            </div>
          </div>
        )}
      <p className="text-[11px] text-content-subtle">
        Drag a bar to move it, its edges to change start or end; arrow keys move a focused bar a day (Shift: its end). The amber line is today; ◆ marks releases.{deps ? ' Red arrows: the blocker finishes after the blocked item starts.' : ''}
      </p>
      {openIssue ? <IssueDrawer projectId={openIssue.project} issueId={openIssue.id} onClose={() => setOpenIssue(null)} onPick={(id) => setOpenIssue({ ...openIssue, id })} /> : null}
    </div>
  )
}
