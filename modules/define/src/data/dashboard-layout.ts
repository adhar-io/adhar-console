/**
 * The Define dashboard's widget catalogue and layout operations (pure).
 *
 * A layout is an ordered list of widget instances, each with a size on a
 * 12-column grid (`s` = 4, `m` = 6, `l` = 12 columns at desktop; every widget
 * is full-width on phones). It is saved per user in docStore
 * (`define.dashboard`, see `dashboard-store.ts`).
 */

export type WidgetType =
  | 'my-open'
  | 'counters'
  | 'active-sprints'
  | 'by-state'
  | 'by-priority'
  | 'by-assignee'
  | 'created-resolved'
  | 'bug-trend'
  | 'cycle-time'
  | 'blocked'
  | 'recent'
  | 'releases'
  | 'okrs'
  | 'intake'
  | 'due-soon'
  | 'notes'

export type WidgetSize = 's' | 'm' | 'l'

export interface WidgetInstance {
  id: string
  type: WidgetType
  size: WidgetSize
}

export type DashboardScope = 'project' | 'team' | 'all'

export interface DashboardLayout {
  version: 1
  scope: DashboardScope
  widgets: WidgetInstance[]
}

export interface WidgetDef {
  type: WidgetType
  title: string
  description: string
  size: WidgetSize
}

export const WIDGETS: WidgetDef[] = [
  { type: 'counters', title: 'At a glance', description: 'Assigned to me, reported by me, due soon, overdue — each opens the matching issues.', size: 'l' },
  { type: 'my-open', title: 'My open work', description: 'Your open issues, most urgent first.', size: 'm' },
  { type: 'due-soon', title: 'Due soon & overdue', description: 'Open work with a target date in the next 7 days or already past.', size: 'm' },
  { type: 'active-sprints', title: 'Active sprints', description: 'Current cycles with a burndown mini-chart.', size: 'l' },
  { type: 'by-state', title: 'Work by state', description: 'Open and finished work by state group.', size: 's' },
  { type: 'by-priority', title: 'Work by priority', description: 'Open work by priority.', size: 's' },
  { type: 'by-assignee', title: 'Work by assignee', description: 'Open work per person (workload).', size: 's' },
  { type: 'created-resolved', title: 'Created vs resolved', description: 'Cumulative issues created and resolved, last 30 days.', size: 'm' },
  { type: 'bug-trend', title: 'Bug trend', description: 'Bugs (label "bug" or "defect") created vs resolved, last 30 days.', size: 'm' },
  { type: 'cycle-time', title: 'Lead & cycle time', description: 'Median and 85th-percentile days to done, last 30 days.', size: 's' },
  { type: 'blocked', title: 'Blocked', description: 'Open work in a state or with a label named "blocked".', size: 's' },
  { type: 'intake', title: 'Intake queue', description: 'Requests waiting for triage.', size: 's' },
  { type: 'recent', title: 'Recently updated', description: 'The latest changes to work items.', size: 'm' },
  { type: 'releases', title: 'Upcoming releases', description: 'Releases planned in Define, next first.', size: 'm' },
  { type: 'okrs', title: 'OKR progress', description: 'This quarter\'s objectives and their progress.', size: 'm' },
  { type: 'notes', title: 'Team notes', description: 'Plane stickies shared with the whole workspace.', size: 'l' },
]

export const WIDGET_BY_TYPE = new Map(WIDGETS.map((w) => [w.type, w]))

const DEFAULT_ORDER: WidgetType[] = [
  'counters',
  'my-open',
  'due-soon',
  'active-sprints',
  'by-state',
  'by-priority',
  'by-assignee',
  'created-resolved',
  'cycle-time',
  'blocked',
  'intake',
  'bug-trend',
  'recent',
  'releases',
  'okrs',
  'notes',
]

export function defaultLayout(): DashboardLayout {
  return {
    version: 1,
    scope: 'project',
    widgets: DEFAULT_ORDER.map((type) => ({ id: type, type, size: WIDGET_BY_TYPE.get(type)!.size })),
  }
}

/** Accept whatever was stored; drop unknown widgets and duplicate ids. */
export function normalizeLayout(raw: unknown): DashboardLayout {
  const r = raw as Partial<DashboardLayout> | null | undefined
  if (!r || !Array.isArray(r.widgets)) return defaultLayout()
  const seen = new Set<string>()
  const widgets: WidgetInstance[] = []
  for (const w of r.widgets) {
    if (!w || typeof w !== 'object' || !WIDGET_BY_TYPE.has(w.type) || typeof w.id !== 'string' || seen.has(w.id)) continue
    seen.add(w.id)
    widgets.push({ id: w.id, type: w.type, size: w.size === 's' || w.size === 'm' || w.size === 'l' ? w.size : WIDGET_BY_TYPE.get(w.type)!.size })
  }
  const scope = r.scope === 'team' || r.scope === 'all' ? r.scope : 'project'
  return { version: 1, scope, widgets }
}

export function addWidget(l: DashboardLayout, type: WidgetType): DashboardLayout {
  let id: string = type
  for (let n = 2; l.widgets.some((w) => w.id === id); n++) id = `${type}-${n}`
  return { ...l, widgets: [...l.widgets, { id, type, size: WIDGET_BY_TYPE.get(type)!.size }] }
}

export function removeWidget(l: DashboardLayout, id: string): DashboardLayout {
  return { ...l, widgets: l.widgets.filter((w) => w.id !== id) }
}

/** Move the widget `id` to index `to` (clamped). */
export function moveWidget(l: DashboardLayout, id: string, to: number): DashboardLayout {
  const from = l.widgets.findIndex((w) => w.id === id)
  if (from < 0) return l
  const next = [...l.widgets]
  const [w] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, w)
  return { ...l, widgets: next }
}

export function resizeWidget(l: DashboardLayout, id: string, size: WidgetSize): DashboardLayout {
  return { ...l, widgets: l.widgets.map((w) => (w.id === id ? { ...w, size } : w)) }
}

export const SIZE_CLASS: Record<WidgetSize, string> = {
  s: 'lg:col-span-4 md:col-span-6',
  m: 'lg:col-span-6 md:col-span-6',
  l: 'lg:col-span-12 md:col-span-12',
}
