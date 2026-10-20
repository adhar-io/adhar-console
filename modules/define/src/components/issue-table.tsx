import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { memberDisplayName } from '../data/plane.ts'
import type { WorkItem } from '../data/work-hooks.ts'
import type { WorkScope } from '../data/work-scope.ts'
import type { OrderTerm, SortField } from '../data/work-ql.ts'
import { estimateTotal, GROUP_LABEL, STATE_GROUPS, subtaskProgress } from '../data/work-board.ts'
import {
  AssigneesField,
  DateField,
  EpicField,
  EstimateField,
  LabelsField,
  PriorityField,
  SprintField,
  StateField,
  useItemEditor,
} from './issue-fields.tsx'
import { IconChevron, PRIORITIES, PRIORITY_LABEL, PriorityIcon, StateDot } from './work-ui.tsx'

/**
 * The work-item spreadsheet: sticky header, configurable columns, grouping
 * with collapsible group rows, row selection (click / shift-range / all),
 * inline-editable cells, keyboard focus, and row virtualisation — only the
 * rows in view (plus overscan) are in the DOM, so thousands of items stay
 * smooth.
 */

export type ColumnId = 'key' | 'title' | 'state' | 'priority' | 'assignees' | 'labels' | 'estimate' | 'start' | 'due' | 'sprint' | 'epic' | 'parent' | 'subtasks' | 'project' | 'created' | 'updated'

export const COLUMNS: Record<ColumnId, { label: string; width: string; sort?: SortField }> = {
  key: { label: 'Key', width: '88px', sort: 'key' },
  title: { label: 'Title', width: 'minmax(260px, 1fr)', sort: 'title' },
  state: { label: 'Status', width: '150px', sort: 'status' },
  priority: { label: 'Priority', width: '120px', sort: 'priority' },
  assignees: { label: 'Assignees', width: '160px' },
  labels: { label: 'Labels', width: '170px' },
  estimate: { label: 'Est.', width: '64px', sort: 'estimate' },
  start: { label: 'Start', width: '92px', sort: 'start' },
  due: { label: 'Due', width: '92px', sort: 'due' },
  sprint: { label: 'Sprint', width: '140px' },
  epic: { label: 'Epic', width: '140px' },
  parent: { label: 'Parent', width: '96px' },
  subtasks: { label: 'Sub-tasks', width: '96px' },
  project: { label: 'Project', width: '110px' },
  created: { label: 'Created', width: '104px', sort: 'created' },
  updated: { label: 'Updated', width: '104px', sort: 'updated' },
}
export const ALL_COLUMNS = Object.keys(COLUMNS) as ColumnId[]
export const DEFAULT_COLUMNS: ColumnId[] = ['key', 'title', 'state', 'priority', 'assignees', 'labels', 'due', 'sprint', 'updated']

export type GroupBy = 'none' | 'state' | 'assignee' | 'priority' | 'label' | 'epic' | 'sprint' | 'project'
export const GROUP_OPTIONS: Array<{ id: GroupBy; label: string }> = [
  { id: 'none', label: 'No grouping' },
  { id: 'state', label: 'Status' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'priority', label: 'Priority' },
  { id: 'label', label: 'Label' },
  { id: 'epic', label: 'Epic' },
  { id: 'sprint', label: 'Sprint' },
  { id: 'project', label: 'Project' },
]

type Row = { kind: 'group'; id: string; label: string; icon?: ReactNode; count: number; points: number; collapsed: boolean } | { kind: 'item'; item: WorkItem; group: string }

const ROW_H = 36
const GROUP_H = 34
const OVERSCAN = 12

/** Group keys an item falls under (multi-valued fields put it in several). */
function groupKeys(i: WorkItem, by: GroupBy): string[] {
  switch (by) {
    case 'state':
      return [i.state]
    case 'assignee':
      return i.assignees.length ? i.assignees : ['_none']
    case 'priority':
      return [i.priority]
    case 'label':
      return i.labels.length ? i.labels : ['_none']
    case 'epic':
      return [i.module ?? '_none']
    case 'sprint':
      return [i.cycle ?? '_none']
    case 'project':
      return [i.project]
    default:
      return ['_all']
  }
}

export function buildRows(items: WorkItem[], by: GroupBy, scope: WorkScope, collapsed: Set<string>): Row[] {
  if (by === 'none') return items.map((item) => ({ kind: 'item' as const, item, group: '_all' }))
  const buckets = new Map<string, WorkItem[]>()
  for (const i of items) for (const k of groupKeys(i, by)) (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i)
  const meta = (k: string): { label: string; icon?: ReactNode; order: number } => {
    switch (by) {
      case 'state': {
        const s = scope.stateById.get(k)
        return { label: s ? (scope.projectIds.length > 1 ? `${s.name} · ${scope.projectById.get(s.project)?.identifier ?? ''}` : s.name) : 'Unknown', icon: <StateDot state={s} />, order: s ? STATE_GROUPS.indexOf(s.group as never) * 1000 + (s.sequence ?? 0) : 1e9 }
      }
      case 'assignee':
        return { label: k === '_none' ? 'Unassigned' : memberDisplayName(scope.memberById.get(k)), order: k === '_none' ? 1e9 : 0 }
      case 'priority':
        return { label: PRIORITY_LABEL[k as plane.Priority] ?? k, icon: <PriorityIcon priority={k as plane.Priority} />, order: PRIORITIES.indexOf(k as plane.Priority) }
      case 'label': {
        const l = scope.labelById.get(k)
        return { label: k === '_none' ? 'No label' : l?.name ?? 'Unknown label', icon: l ? <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} /> : undefined, order: k === '_none' ? 1e9 : 0 }
      }
      case 'epic':
        return { label: k === '_none' ? 'No epic' : scope.moduleById.get(k)?.name ?? 'Unknown epic', order: k === '_none' ? 1e9 : 0 }
      case 'sprint': {
        const c = scope.cycleById.get(k)
        const rank = { current: 0, upcoming: 1, draft: 2, completed: 3 } as Record<string, number>
        return { label: k === '_none' ? 'Backlog (no sprint)' : c ? `${c.name} · ${c.status}` : 'Unknown sprint', order: k === '_none' ? 1e9 : rank[c?.status ?? 'draft'] ?? 5 }
      }
      case 'project': {
        const p = scope.projectById.get(k)
        return { label: p ? `${p.identifier} · ${p.name}` : k, order: 0 }
      }
    }
    return { label: k, order: 0 }
  }
  const groups = [...buckets.entries()].map(([k, list]) => ({ k, list, ...meta(k) }))
  groups.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  const rows: Row[] = []
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.k)
    rows.push({ kind: 'group', id: g.k, label: g.label, icon: g.icon, count: g.list.length, points: estimateTotal(g.list).points, collapsed: isCollapsed })
    if (!isCollapsed) for (const item of g.list) rows.push({ kind: 'item', item, group: g.k })
  }
  return rows
}

export function IssueTable({
  items,
  scope,
  columns,
  groupBy,
  order,
  onSort,
  selected,
  onSelect,
  onOpen,
  focusedId,
  onFocus,
  signal,
  loading,
}: {
  items: WorkItem[]
  scope: WorkScope
  columns: ColumnId[]
  groupBy: GroupBy
  order?: OrderTerm
  onSort(field: SortField): void
  selected: Set<string>
  onSelect(next: Set<string>): void
  onOpen(item: WorkItem): void
  focusedId?: string
  onFocus(id: string): void
  /** Keyboard-triggered editor: open column `col` on row `id`. */
  signal?: { id: string; col: 'state' | 'assignees' | 'priority'; n: number } | null
  loading?: boolean
}) {
  const edit = useItemEditor()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rows = useMemo(() => buildRows(items, groupBy, scope, collapsed), [items, groupBy, scope, collapsed])
  const subs = useMemo(() => subtaskProgress(scope.all, (s) => scope.stateById.get(s)?.group), [scope.all, scope.stateById])
  const box = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const lastClicked = useRef<string | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Row offsets (group rows are shorter).
  const offsets = useMemo(() => {
    const out = new Array<number>(rows.length + 1)
    out[0] = 0
    for (let i = 0; i < rows.length; i++) out[i + 1] = out[i] + (rows[i].kind === 'group' ? GROUP_H : ROW_H)
    return out
  }, [rows])
  const total = offsets[rows.length]
  let first = 0
  {
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= scrollTop) lo = mid + 1
      else hi = mid
    }
    first = Math.max(0, lo - OVERSCAN)
  }
  let last = first
  while (last < rows.length && offsets[last] < scrollTop + viewH) last++
  last = Math.min(rows.length, last + OVERSCAN)

  // Keep the focused row in view (j/k).
  useEffect(() => {
    if (!focusedId || !box.current) return
    const idx = rows.findIndex((r) => r.kind === 'item' && r.item.id === focusedId)
    if (idx < 0) return
    const top = offsets[idx]
    const el = box.current
    const head = 34
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight - head) el.scrollTop = top + ROW_H - el.clientHeight + head
  }, [focusedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const template = `36px ${columns.map((c) => COLUMNS[c].width).join(' ')}`
  const minWidth = 36 + columns.reduce((n, c) => n + (parseInt(COLUMNS[c].width) || 260), 0)
  const visibleIds = items.map((i) => i.id)
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  const toggle = (id: string, range: boolean) => {
    const next = new Set(selected)
    if (range && lastClicked.current) {
      const order = rows.filter((r) => r.kind === 'item').map((r) => (r as { item: WorkItem }).item.id)
      const a = order.indexOf(lastClicked.current)
      const b = order.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [s, e] = a < b ? [a, b] : [b, a]
        for (const x of order.slice(s, e + 1)) next.add(x)
        onSelect(next)
        return
      }
    }
    if (next.has(id)) next.delete(id)
    else next.add(id)
    lastClicked.current = id
    onSelect(next)
  }

  return (
    <div
      ref={box}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative h-[calc(100dvh-19rem)] min-h-[22rem] overflow-auto rounded-xl border border-edge-default bg-surface-raised"
      role="grid"
      aria-rowcount={rows.length}
      aria-busy={loading}
    >
      <div style={{ minWidth }}>
        <div role="row" className="sticky top-0 z-10 grid h-[34px] items-center border-b border-edge-default bg-surface-sunken/95 text-[11.5px] font-semibold text-content-muted backdrop-blur" style={{ gridTemplateColumns: template }}>
          <span className="flex justify-center">
            <input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => onSelect(allOn ? new Set() : new Set(visibleIds))} className="h-3.5 w-3.5 accent-brand-600" />
          </span>
          {columns.map((c) => {
            const s = COLUMNS[c].sort
            const active = s && order?.field === s
            return (
              <span key={c} role="columnheader" aria-sort={active ? (order!.dir === 'asc' ? 'ascending' : 'descending') : undefined} className="truncate px-2">
                {s ? (
                  <button type="button" onClick={() => onSort(s)} className={cn('inline-flex items-center gap-1 hover:text-content', active ? 'text-content' : '')}>
                    {COLUMNS[c].label}
                    {active ? <span aria-hidden>{order!.dir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                ) : COLUMNS[c].label}
              </span>
            )
          })}
        </div>

        {loading && !rows.length ? (
          <div className="space-y-px p-1">
            {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-8 animate-pulse rounded bg-surface-sunken/70" />)}
          </div>
        ) : null}

        <div style={{ height: total, position: 'relative' }}>
          {rows.slice(first, last).map((r, k) => {
            const idx = first + k
            const top = offsets[idx]
            if (r.kind === 'group') {
              return (
                <div key={`g-${r.id}`} role="row" style={{ position: 'absolute', top, left: 0, right: 0, height: GROUP_H }} className="flex items-center gap-2 border-b border-edge-subtle bg-surface-sunken/50 px-2">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => {
                      const n = new Set(c)
                      if (n.has(r.id)) n.delete(r.id)
                      else n.add(r.id)
                      return n
                    })}
                    aria-expanded={!r.collapsed}
                    className="sticky left-2 flex items-center gap-2 text-[12px] font-semibold text-content"
                  >
                    <IconChevron open={!r.collapsed} />
                    {r.icon}
                    <span>{r.label}</span>
                    <span className="rounded-full bg-surface-raised px-1.5 text-[10.5px] font-medium text-content-muted ring-1 ring-inset ring-edge-default">{r.count}</span>
                    {r.points ? <span className="text-[10.5px] font-normal text-content-subtle">{r.points} pts</span> : null}
                  </button>
                </div>
              )
            }
            const i = r.item
            const lite = scope.liteProjects.includes(i.project)
            const isSel = selected.has(i.id)
            const isFocus = focusedId === i.id
            const sg = scope.stateById.get(i.state)?.group
            const sp = subs.get(i.id)
            const parent = i.parent ? scope.itemById.get(i.parent) : undefined
            return (
              <div
                key={`${r.group}-${i.id}`}
                role="row"
                aria-selected={isSel}
                data-focused={isFocus || undefined}
                onClick={() => onFocus(i.id)}
                onDoubleClick={() => onOpen(i)}
                style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, gridTemplateColumns: template }}
                className={cn(
                  'group grid items-center border-b border-edge-subtle text-[12.5px]',
                  isSel ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/40',
                  isFocus ? 'shadow-[inset_2px_0_0_var(--color-brand-500)]' : '',
                )}
              >
                <span className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${scope.keyOf(i)}`} checked={isSel} onChange={(e) => toggle(i.id, (e.nativeEvent as MouseEvent).shiftKey)} className="h-3.5 w-3.5 accent-brand-600" />
                </span>
                {columns.map((c) => (
                  <span key={c} role="gridcell" className="min-w-0 px-1" onClick={c === 'title' || c === 'key' ? undefined : (e) => e.stopPropagation()}>
                    {(() => {
                      switch (c) {
                        case 'key':
                          return <button type="button" onClick={() => onOpen(i)} className="truncate px-1 font-mono text-[11px] text-content-muted hover:text-brand-700 hover:underline">{scope.keyOf(i)}</button>
                        case 'title':
                          return (
                            <button type="button" onClick={() => onOpen(i)} className="flex w-full min-w-0 items-center gap-1.5 px-1 text-left">
                              {parent ? <span className="shrink-0 text-[10.5px] text-content-subtle" title={`Sub-task of ${parent.name}`}>↳</span> : null}
                              <span className="truncate font-medium text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{i.name}</span>
                            </button>
                          )
                        case 'state':
                          return <StateField item={i} data={scope} edit={edit} openSignal={signal?.id === i.id && signal.col === 'state' ? signal.n : undefined} />
                        case 'priority':
                          return <PriorityField item={i} edit={edit} openSignal={signal?.id === i.id && signal.col === 'priority' ? signal.n : undefined} />
                        case 'assignees':
                          return <AssigneesField item={i} data={scope} edit={edit} openSignal={signal?.id === i.id && signal.col === 'assignees' ? signal.n : undefined} />
                        case 'labels':
                          return <LabelsField item={i} data={scope} edit={edit} />
                        case 'estimate':
                          return <EstimateField item={i} edit={edit} />
                        case 'start':
                          return <DateField item={i} field="start_date" edit={edit} />
                        case 'due':
                          return <DateField item={i} field="target_date" edit={edit} groupOf={sg} />
                        case 'sprint':
                          return <SprintField item={i} data={scope} edit={edit} lite={lite} />
                        case 'epic':
                          return <EpicField item={i} data={scope} edit={edit} lite={lite} />
                        case 'parent':
                          return parent ? <button type="button" onClick={() => onOpen(parent)} className="truncate px-1 font-mono text-[11px] text-content-muted hover:underline">{scope.keyOf(parent)}</button> : <span className="px-1.5 text-content-subtle">—</span>
                        case 'subtasks':
                          return sp ? <span className="px-1.5 text-[11.5px] tabular-nums text-content-muted">{sp.done}/{sp.total}</span> : <span className="px-1.5 text-content-subtle">—</span>
                        case 'project':
                          return <span className="truncate px-1.5 text-[11.5px] text-content-muted">{scope.projectById.get(i.project)?.identifier ?? '—'}</span>
                        case 'created':
                          return <span className="truncate px-1.5 text-[11.5px] text-content-muted" title={i.created_at}>{formatRelative(i.created_at)}</span>
                        case 'updated':
                          return <span className="truncate px-1.5 text-[11.5px] text-content-muted" title={i.updated_at ?? ''}>{formatRelative(i.updated_at ?? i.created_at)}</span>
                      }
                    })()}
                  </span>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Group label helpers shared with Board. */
export { GROUP_LABEL }
