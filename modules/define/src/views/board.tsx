import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, EmptyState, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName, planeError, useCreateIssue } from '../data/plane.ts'
import { useMoveWork, usePatchWork, type WorkItem } from '../data/work-hooks.ts'
import { useWorkScope, type WorkScope } from '../data/work-scope.ts'
import { effectivePoints, useWorkRules, useWorkRulesCtx, viewOf, WorkRulesProvider } from '../data/work-rules.ts'
import { andQuery } from '../data/work-ql.ts'
import {
  type BoardColumn,
  boardColumns,
  byRank,
  coverFromHtml,
  GROUP_LABEL,
  groupBands,
  isOverdue,
  laneOf,
  planRank,
  subtaskProgress,
  type SwimlaneBy,
  swimlanes,
  targetState,
  wipStatus,
} from '../data/work-board.ts'
import { type ChecklistDoc, checklistProgress, KINDS, storeError, useDocById, useDocs, usePutDoc, type WipDoc } from '../data/work-store.ts'
import { issueParam, parseIssueParam, useSetWorkParams, useWorkParams } from '../data/work-nav.ts'
import { IssueQueryBar, QUICK_FILTERS } from '../components/issue-query-bar.tsx'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { NewIssueModal } from '../components/new-issue-modal.tsx'
import {
  AvatarStack,
  ConsoleSide,
  IconCalendar,
  IconChecklist,
  IconChevron,
  IconClip,
  IconLink,
  IconPlus,
  IconSubtask,
  Kbd,
  PlaneErrorState,
  PriorityIcon,
  StateDot,
  useHotkeys,
} from '../components/work-ui.tsx'

/**
 * Board — Kanban over Plane work items. Columns are the workflow states
 * (grouped under their state group); a query naming several projects gets one
 * column per state group instead. Swimlanes by assignee / epic / priority,
 * WIP limits per column (console-side) with visible breaches, drag and drop
 * between and within columns (rank = Plane `sort_order`), Trello-style cards,
 * quick-add per column, collapsible columns and two densities.
 */

const LS = (k: string) => `adhar.define.board.${k}`
const ls = <T,>(k: string, d: T): T => {
  try {
    const v = globalThis.localStorage?.getItem(LS(k))
    return v ? (JSON.parse(v) as T) : d
  } catch {
    return d
  }
}
const lsSet = (k: string, v: unknown) => {
  try {
    globalThis.localStorage?.setItem(LS(k), JSON.stringify(v))
  } catch { /* private mode */ }
}

const CARD_CAP = 80

interface DropAt {
  col: string
  lane: string
  index: number
}

export function Board({ projectId }: { projectId?: string }) {
  const params = useWorkParams()
  const setParams = useSetWorkParams()
  const toast = useToast()
  const [jql, setJql] = useState(params.q ?? '')
  const [quick, setQuick] = useState<string[]>([])
  const [lane, setLane] = useState<SwimlaneBy>(() => ls('lane', 'none'))
  const [compact, setCompact] = useState<boolean>(() => ls('compact', false))
  const [collapsed, setCollapsed] = useState<string[]>(() => ls(`collapsed.${projectId}`, []))
  const [wipEdit, setWipEdit] = useState(false)
  const [createIn, setCreateIn] = useState<{ state?: string } | null>(null)
  const queryInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (params.q !== undefined && params.q !== jql) setJql(params.q)
  }, [params.q]) // eslint-disable-line react-hooks/exhaustive-deps

  const effective = useMemo(() => andQuery(jql, QUICK_FILTERS.filter((f) => quick.includes(f.id)).map((f) => f.jql)), [jql, quick])
  const scope = useWorkScope(projectId, effective, byRank)
  const rules = useWorkRules(scope.projectIds, scope.states)
  const cross = scope.projectIds.length > 1
  const scopeStates = useMemo(() => scope.states.filter((s) => scope.projectIds.includes(s.project)), [scope.states, scope.projectIds])
  const columns = useMemo(() => boardColumns(scopeStates, cross), [scopeStates, cross])
  const bands = useMemo(() => groupBands(columns), [columns])
  const wipKey = cross ? `x-${[...scope.projectIds].sort().join('-')}`.slice(0, 120) : scope.primary
  const wip = useDocById<WipDoc>(KINDS.wip, wipKey)
  const putWip = usePutDoc<WipDoc>(KINDS.wip)
  const checklists = useDocs<ChecklistDoc>(KINDS.checklist)
  const checkById = useMemo(() => new Map((checklists.data ?? []).map((d) => [d.id, d.data])), [checklists.data])
  const subs = useMemo(() => subtaskProgress(scope.all, (s) => scope.stateById.get(s)?.group), [scope.all, scope.stateById])
  const patch = usePatchWork()
  const move = useMoveWork()

  const lanes = useMemo(
    () => swimlanes(scope.items, lane, { member: (id) => memberDisplayName(scope.memberById.get(id)), epic: (id) => scope.moduleById.get(id)?.name ?? 'Unknown epic' }),
    [scope.items, lane, scope.memberById, scope.moduleById],
  )
  // Manual ordering (drag within a column) only when the board shows rank order.
  const rankable = !/\border\s+by\b/i.test(jql) || /\border\s+by\s+rank\b/i.test(jql)
  const cell = (col: BoardColumn, laneId: string) => scope.items.filter((i) => col.stateIds.includes(i.state) && (lane === 'none' || laneOf(i, lane) === laneId))
  const [drop, setDrop] = useState<DropAt | null>(null)
  const dragId = useRef<string | null>(null)

  useHotkeys({ c: () => setCreateIn({}), '/': () => queryInput.current?.focus() }, !!projectId)

  if (!projectId) return <EmptyState title="Pick a project" description="Choose one from the project picker above to see its board." />

  const toggleCollapse = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]
    setCollapsed(next)
    lsSet(`collapsed.${projectId}`, next)
  }

  const onDrop = (at: DropAt) => {
    const id = dragId.current
    dragId.current = null
    setDrop(null)
    const item = id ? scope.itemById.get(id) : undefined
    const col = columns.find((c) => c.id === at.col)
    if (!item || !col) return
    const toState = targetState(col, scope.states, item.project)
    if (!toState) {
      toast.error(`${scope.projectById.get(item.project)?.identifier ?? 'That project'} has no ${GROUP_LABEL[col.group].toLowerCase()} state.`)
      return
    }
    const p: Record<string, unknown> = {}
    if (toState !== item.state) p.state = toState
    // Lane change → the lane's field.
    if (lane === 'assignee' && laneOf(item, 'assignee') !== at.lane) p.assignees = at.lane === '_none' ? [] : [at.lane, ...item.assignees.filter((a) => a !== at.lane && a !== item.assignees[0])]
    if (lane === 'priority' && item.priority !== at.lane) p.priority = at.lane
    // Rank within the target cell (Plane `sort_order`).
    // Neighbours come from the cell as displayed; rank only applies when the board is in rank order.
    const displayed = cell(col, at.lane)
    const before = displayed.slice(0, at.index).filter((i) => i.id !== item.id && i.project === item.project).length
    const list = displayed.filter((i) => i.project === item.project)
    const ranks = rankable ? planRank(list, item.id, before) : []
    const own = ranks.find((r) => r.id === item.id)
    if (own && own.sort_order !== item.sort_order) p.sort_order = own.sort_order
    // Workflow rules (console-enforced) — a blocked move doesn't happen.
    if (typeof p.state === 'string') {
      const c = rules.check({ ...item, assignees: (p.assignees as string[] | undefined) ?? item.assignees }, p.state)
      if (!c.ok) {
        toast.error(c.reason, { description: 'Workflow rule (enforced by the console)' })
        return
      }
    }
    const run = () => {
      if (Object.keys(p).length) {
        patch.mutate({ projectId: item.project, id: item.id, patch: p }, {
          onSuccess: () => {
            if (p.state) toast.success(`${scope.keyOf(item)} → ${scope.stateById.get(toState)?.name}`)
            if (p.state || p.assignees || p.priority) rules.automate('updated', viewOf(item), viewOf({ ...item, ...(p as Partial<WorkItem>) }))
          },
          onError: (e) => toast.error(planeError(e, "Couldn't move the card.")),
        })
      }
      for (const r of ranks) if (r.id !== item.id) patch.mutate({ projectId: item.project, id: r.id, patch: { sort_order: r.sort_order } })
      if (lane === 'epic' && laneOf(item, 'epic') !== at.lane) {
        if (scope.liteProjects.includes(item.project)) toast.warning('Epic membership is not loaded for cross-project items; change it from the item.')
        else move.mutate({ projectId: item.project, item, module: at.lane === '_none' ? null : at.lane }, { onError: (e) => toast.error(planeError(e, "Couldn't change the epic.")) })
      }
    }
    run()
  }

  const firstError = scope.errors[0]
  const width = compact ? 248 : 288

  return (
    <WorkRulesProvider value={rules}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Swimlanes"
          value={lane}
          options={[['none', 'None'], ['assignee', 'Assignee'], ['epic', 'Epic'], ['priority', 'Priority']]}
          onChange={(v) => {
            setLane(v as SwimlaneBy)
            lsSet('lane', v)
          }}
        />
        <Segmented label="Density" value={compact ? 'compact' : 'comfortable'} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} onChange={(v) => { setCompact(v === 'compact'); lsSet('compact', v === 'compact') }} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant={wipEdit ? 'primary' : 'secondary'} onClick={() => setWipEdit((w) => !w)}>{wipEdit ? 'Done' : 'WIP limits'}</Button>
          <Button size="sm" variant="primary" leading={<IconPlus />} onClick={() => setCreateIn({})}>New item <Kbd>C</Kbd></Button>
        </div>
      </div>
      <IssueQueryBar value={jql} onRun={(q) => { setJql(q); setParams({ q: q || undefined }) }} ctx={scope.ctx} compiled={scope.compiled} inputRef={queryInput} quick={quick} onQuick={setQuick} count={scope.items.length} total={scope.all.length} busy={scope.isFetching && !scope.isLoading} />
      {wipEdit ? <p className="flex items-center gap-2 text-[11.5px] text-content-subtle">Set a work-in-progress limit per column — the column turns red when it's exceeded. <ConsoleSide title="Plane has no WIP limits; the console keeps them per board" /></p> : null}
      {!rankable ? <p className="text-[11.5px] text-content-subtle">The query sorts cards with ORDER BY, so dragging within a column won't re-rank — drop on another column to change status.</p> : null}
      {cross ? <p className="text-[11.5px] text-content-subtle">Several projects — one column per state group, since each project has its own workflow. Dropping a card moves it to its project's first state in that group.</p> : null}
      {wip.isError && wipEdit ? <p className="text-[12px] text-rose-700 dark:text-rose-300">{storeError(wip.error)}</p> : null}

      {firstError && !scope.all.length ? <PlaneErrorState error={firstError.error} /> : scope.isLoading && !scope.all.length ? (
        <div className="flex gap-3 overflow-hidden">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-96 w-72 shrink-0 animate-pulse rounded-xl bg-surface-sunken/70" />)}</div>
      ) : !columns.length ? (
        <EmptyState title="No workflow states" description="This project has no states in Plane yet — add them in the project's settings." />
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pb-3" role="region" aria-label="Board">
          <div className="inline-flex min-w-full flex-col gap-2">
            {/* group bands */}
            <div className="flex gap-2">
              {bands.map((b) => {
                const cols = columns.slice(b.start, b.start + b.span)
                const w = cols.reduce((n, c) => n + (collapsed.includes(c.id) ? 44 : width), 0) + (b.span - 1) * 8
                return <div key={`${b.group}-${b.start}`} style={{ width: w }} className="shrink-0 border-b-2 border-edge-default pb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{GROUP_LABEL[b.group]}</div>
              })}
            </div>
            {/* column headers */}
            <div className="sticky top-0 z-10 flex gap-2 bg-surface-app/95 py-1 backdrop-blur">
              {columns.map((col) => {
                const count = scope.items.filter((i) => col.stateIds.includes(i.state)).length
                const limit = wip.doc?.data.limits?.[col.id]
                const ws = wipStatus(count, limit)
                const isCol = collapsed.includes(col.id)
                return (
                  <div key={col.id} style={{ width: isCol ? 44 : width }} className={cn('flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1.5', ws === 'over' ? 'border-rose-400 bg-rose-50 dark:bg-rose-500/10' : ws === 'at' ? 'border-amber-300 bg-amber-50/60 dark:bg-amber-500/10' : 'border-edge-default bg-surface-raised')}>
                    <button type="button" onClick={() => toggleCollapse(col.id)} title={isCol ? 'Expand column' : 'Collapse column'} className="text-content-subtle hover:text-content"><IconChevron open={!isCol} /></button>
                    {!isCol ? (
                      <>
                        {col.color ? <StateDot state={{ color: col.color, group: col.group, name: col.label }} /> : null}
                        <span className="truncate text-[12.5px] font-semibold text-content">{col.label}</span>
                        <span className={cn('ml-auto rounded-full px-1.5 text-[11px] font-semibold tabular-nums', ws === 'over' ? 'bg-rose-600 text-white' : 'bg-surface-sunken text-content-muted')} title={limit ? `WIP limit ${limit}` : undefined}>
                          {count}{limit ? `/${limit}` : ''}
                        </span>
                        {wipEdit ? (
                          <input
                            type="number"
                            min={0}
                            defaultValue={limit ?? ''}
                            aria-label={`WIP limit for ${col.label}`}
                            placeholder="∞"
                            onBlur={(e) => {
                              const v = e.target.value === '' ? 0 : Math.max(0, Math.floor(Number(e.target.value)))
                              if (!wipKey || v === (limit ?? 0)) return
                              putWip.mutate({ id: wipKey, update: (prev) => ({ projectId: wipKey, limits: { ...(prev?.limits ?? {}), [col.id]: v } }) }, { onError: (err) => toast.error(storeError(err)) })
                            }}
                            className="h-6 w-12 rounded border border-edge-default bg-surface-app px-1 text-right text-[11.5px]"
                          />
                        ) : null}
                      </>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {/* lanes */}
            {lanes.map((ln) => (
              <div key={ln.id} className="space-y-1.5">
                {lane !== 'none' ? (
                  <div className="sticky left-0 flex items-center gap-2 pt-1 text-[12px] font-semibold text-content">
                    {lane === 'priority' ? <PriorityIcon priority={ln.id as plane.Priority} /> : null}
                    {ln.label}
                    <span className="text-[11px] font-normal text-content-subtle">{scope.items.filter((i) => laneOf(i, lane) === ln.id).length}</span>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  {columns.map((col) => {
                    const isCol = collapsed.includes(col.id)
                    const cards = cell(col, ln.id)
                    const limit = wip.doc?.data.limits?.[col.id]
                    const over = wipStatus(scope.items.filter((i) => col.stateIds.includes(i.state)).length, limit) === 'over'
                    if (isCol) {
                      return (
                        <div
                          key={col.id}
                          style={{ width: 44 }}
                          onDragOver={(e) => { e.preventDefault(); setDrop({ col: col.id, lane: ln.id, index: cards.length }) }}
                          onDrop={(e) => { e.preventDefault(); onDrop({ col: col.id, lane: ln.id, index: cards.length }) }}
                          className={cn('flex min-h-24 shrink-0 justify-center rounded-xl border border-dashed border-edge-default pt-2', drop?.col === col.id && drop.lane === ln.id ? 'bg-brand-50 dark:bg-brand-500/10' : '')}
                        >
                          <span className="text-[11px] font-medium text-content-subtle [writing-mode:vertical-rl]">{col.label} · {cards.length}</span>
                        </div>
                      )
                    }
                    return (
                      <Cell
                        key={col.id}
                        width={width}
                        over={over}
                        active={drop?.col === col.id && drop.lane === ln.id}
                        dropIndex={drop?.col === col.id && drop.lane === ln.id ? drop.index : null}
                        cards={cards}
                        scope={scope}
                        compact={compact}
                        subs={subs}
                        checkById={checkById}
                        onDragStart={(id) => { dragId.current = id }}
                        onDragEnd={() => { dragId.current = null; setDrop(null) }}
                        onHover={(index) => setDrop({ col: col.id, lane: ln.id, index })}
                        onDrop={(index) => onDrop({ col: col.id, lane: ln.id, index })}
                        onOpen={(i) => setParams({ issue: issueParam(i.project, i.id) }, { push: true })}
                        quickAdd={!cross && lane === 'none' ? { projectId: scope.primary!, state: col.id } : undefined}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {createIn ? <NewIssueModal projectId={scope.primary ?? projectId} defaultState={createIn.state} onClose={() => setCreateIn(null)} /> : null}
      <BoardDrawer projectId={projectId} />
    </div>
    </WorkRulesProvider>
  )
}

/** Shared drawer driven by `?issue=` (Board and Backlog). */
export function BoardDrawer({ projectId }: { projectId?: string }) {
  const params = useWorkParams()
  const setParams = useSetWorkParams()
  const t = parseIssueParam(params.issue, projectId)
  if (!t) return null
  return (
    <IssueDrawer
      key={params.issue}
      projectId={t.projectId}
      issueId={t.issueId}
      onClose={() => setParams({ issue: undefined })}
      onPick={(id) => setParams({ issue: issueParam(t.projectId, id) }, { push: true })}
      onPickIn={(p, id) => setParams({ issue: issueParam(p, id) }, { push: true })}
    />
  )
}

function Cell({
  width,
  over,
  active,
  dropIndex,
  cards,
  scope,
  compact,
  subs,
  checkById,
  onDragStart,
  onDragEnd,
  onHover,
  onDrop,
  onOpen,
  quickAdd,
}: {
  width: number
  over: boolean
  active: boolean
  dropIndex: number | null
  cards: WorkItem[]
  scope: WorkScope
  compact: boolean
  subs: Map<string, { done: number; total: number }>
  checkById: Map<string, ChecklistDoc>
  onDragStart(id: string): void
  onDragEnd(): void
  onHover(index: number): void
  onDrop(index: number): void
  onOpen(i: WorkItem): void
  quickAdd?: { projectId: string; state: string }
}) {
  const [cap, setCap] = useState(CARD_CAP)
  const shown = cards.slice(0, cap)
  const indexAt = (e: React.DragEvent, el: HTMLElement) => {
    const nodes = [...el.querySelectorAll<HTMLElement>('[data-card]')]
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) return i
    }
    return nodes.length
  }
  return (
    <div
      style={{ width }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const i = indexAt(e, e.currentTarget)
        if (i !== dropIndex) onHover(i)
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop(indexAt(e, e.currentTarget))
      }}
      className={cn('flex min-h-24 shrink-0 flex-col gap-1.5 rounded-xl border p-1.5 transition-colors', over ? 'border-rose-300 bg-rose-50/50 dark:border-rose-500/40 dark:bg-rose-500/5' : 'border-transparent bg-surface-sunken/50', active ? 'ring-2 ring-brand-400/40' : '')}
    >
      {shown.map((i, idx) => (
        <div key={i.id} data-card>
          {dropIndex === idx ? <div className="mb-1.5 h-0.5 rounded bg-brand-500" /> : null}
          <Card item={i} scope={scope} compact={compact} sub={subs.get(i.id)} checklist={checkById.get(i.id)} onOpen={() => onOpen(i)} onDragStart={() => onDragStart(i.id)} onDragEnd={onDragEnd} />
        </div>
      ))}
      {dropIndex !== null && dropIndex >= shown.length ? <div className="h-0.5 rounded bg-brand-500" /> : null}
      {cards.length > cap ? <button type="button" onClick={() => setCap((c) => c + CARD_CAP)} className="rounded-md py-1 text-[11.5px] font-medium text-content-muted hover:bg-surface-raised">Show {Math.min(CARD_CAP, cards.length - cap)} more of {cards.length - cap}</button> : null}
      {quickAdd ? <QuickAdd projectId={quickAdd.projectId} state={quickAdd.state} /> : null}
    </div>
  )
}

function Card({ item, scope, compact, sub, checklist, onOpen, onDragStart, onDragEnd }: {
  item: WorkItem
  scope: WorkScope
  compact: boolean
  sub?: { done: number; total: number }
  checklist?: ChecklistDoc
  onOpen(): void
  onDragStart(): void
  onDragEnd(): void
}) {
  const labels = item.labels.map((id) => scope.labelById.get(id)).filter(Boolean) as plane.Label[]
  const people = item.assignees.map((id) => scope.memberById.get(id)).filter(Boolean) as plane.Member[]
  const group = scope.stateById.get(item.state)?.group
  const overdue = isOverdue(item.target_date, group)
  const cover = compact ? undefined : coverFromHtml(item.description_html)
  const cp = checklistProgress(checklist)
  const pts = effectivePoints(item, useWorkRulesCtx())
  const done = group === 'completed' || group === 'cancelled'
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      aria-label={`${scope.keyOf(item)} ${item.name}`}
      className="group cursor-grab overflow-hidden rounded-lg border border-edge-subtle bg-surface-raised shadow-sm transition hover:border-edge-strong hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 active:cursor-grabbing"
    >
      {cover ? <img src={cover} alt="" loading="lazy" className="h-28 w-full object-cover" /> : null}
      <div className={cn(compact ? 'space-y-1 p-2' : 'space-y-1.5 p-2.5')}>
        {labels.length ? (
          <div className="flex flex-wrap gap-1">
            {labels.slice(0, compact ? 6 : 4).map((l) => compact ? <span key={l.id} title={l.name} className="h-1.5 w-7 rounded-full" style={{ backgroundColor: l.color }} /> : (
              <span key={l.id} className="inline-flex max-w-[8rem] items-center gap-1 truncate rounded px-1.5 py-px text-[10.5px] font-medium text-white" style={{ backgroundColor: l.color }}>{l.name}</span>
            ))}
          </div>
        ) : null}
        <div className={cn('text-[13px] font-medium leading-snug text-content', done ? 'text-content-muted line-through' : '', compact ? 'line-clamp-2' : 'line-clamp-3')}>{item.name}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content-subtle">
          <span className="font-mono">{scope.keyOf(item)}</span>
          <PriorityIcon priority={item.priority} size={12} />
          {item.target_date ? <span className={cn('inline-flex items-center gap-0.5', overdue ? 'rounded bg-rose-600 px-1 font-medium text-white' : '')} title={overdue ? 'Overdue' : 'Due'}><IconCalendar size={11} />{new Date(`${item.target_date.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span> : null}
          {pts.value != null ? <span className="rounded bg-surface-sunken px-1 font-semibold tabular-nums text-content-muted" title={pts.source === 'plane' ? 'Estimate' : 'Story points (console-side)'}>{pts.value}</span> : null}
          {sub ? <span className={cn('inline-flex items-center gap-0.5', sub.done === sub.total ? 'text-emerald-600' : '')} title="Sub-tasks done"><IconSubtask size={11} />{sub.done}/{sub.total}</span> : null}
          {cp.total ? <span className={cn('inline-flex items-center gap-0.5', cp.done === cp.total ? 'rounded bg-emerald-600 px-1 text-white' : '')} title="Checklist (console-side)"><IconChecklist size={11} />{cp.done}/{cp.total}</span> : null}
          {item.link_count ? <span className="inline-flex items-center gap-0.5" title="Links"><IconLink size={11} />{item.link_count}</span> : null}
          {item.attachment_count ? <span className="inline-flex items-center gap-0.5" title="Attachments"><IconClip size={11} />{item.attachment_count}</span> : null}
          {people.length ? <span className="ml-auto"><AvatarStack members={people} max={3} size={compact ? 18 : 22} /></span> : null}
        </div>
      </div>
    </div>
  )
}

function QuickAdd({ projectId, state }: { projectId: string; state: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const create = useCreateIssue(projectId)
  const toast = useToast()
  const rules = useWorkRulesCtx()
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-content-subtle hover:bg-surface-raised hover:text-content"><IconPlus /> Add a card</button>
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!name.trim()) return
        create.mutate({ name: name.trim(), state, priority: 'none' } as Partial<plane.Issue>, {
          onSuccess: (created) => {
            setName('')
            rules?.automate('created', undefined, viewOf(created as WorkItem))
          },
          onError: (err) => toast.error(planeError(err, "Couldn't add the card.")),
        })
      }}
      className="space-y-1.5"
    >
      <textarea
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            e.currentTarget.form?.requestSubmit()
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
          }
        }}
        rows={2}
        placeholder="Card title — Enter to add"
        className="block w-full resize-none rounded-lg border border-edge-default bg-surface-raised px-2 py-1.5 text-[13px] shadow-sm focus:border-brand-400 focus:outline-none"
      />
      <div className="flex gap-1">
        <Button size="xs" variant="primary" type="submit" loading={create.isPending} disabled={!name.trim()}>Add</Button>
        <Button size="xs" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  )
}

export function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange(v: string): void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-content-subtle">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-surface-sunken p-0.5">
        {options.map(([id, l]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)} className={cn('rounded-md px-2 py-1 text-[11.5px] font-medium', value === id ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content')}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}
