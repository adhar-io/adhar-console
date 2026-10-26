/**
 * The Define dashboard's widget catalogue and layout operations (pure).
 *
 * A layout is an ordered list of widget instances, each with a preferred
 * width on a 12-column grid:
 *
 *   s = ⅓ (4)   m = ½ (6)   w = ⅔ (8)   l = full (12)
 *
 * What is drawn is never the raw preference: `packSpans` flows the widgets
 * into rows and closes every row flush, so no layout a person can produce —
 * by adding, removing, dragging or resizing — leaves a gap or a half-filled
 * row. Tablets get their own pack (thirds and halves become halves); phones
 * stack every widget full width.
 *
 * Saved per user in docStore (`define.dashboard`, see `dashboard-store.ts`).
 * Deliberately no imports: the test loads this file on its own.
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

export type WidgetSize = 's' | 'm' | 'w' | 'l'

export interface WidgetInstance {
  id: string
  type: WidgetType
  size: WidgetSize
}

/** `project` = the active Plane project; `all` = every Plane project. */
export type DashboardScope = 'project' | 'all'

export interface DashboardLayout {
  version: 1
  scope: DashboardScope
  widgets: WidgetInstance[]
}

export type WidgetCategory = 'Personal' | 'Delivery' | 'Breakdown' | 'Trends' | 'Planning' | 'Team'

export interface WidgetDef {
  type: WidgetType
  title: string
  description: string
  /** Width a freshly added widget gets. */
  size: WidgetSize
  category: WidgetCategory
}

export const WIDGETS: WidgetDef[] = [
  { type: 'counters', title: 'At a glance', description: 'Assigned to me, reported by me, due soon, overdue — each opens the matching issues.', size: 'l', category: 'Personal' },
  { type: 'my-open', title: 'My open work', description: 'Your open issues, most urgent first.', size: 'm', category: 'Personal' },
  { type: 'due-soon', title: 'Due soon & overdue', description: 'Open work with a target date in the next 7 days or already past.', size: 'm', category: 'Personal' },
  { type: 'active-sprints', title: 'Active sprints', description: 'Current cycles with a burndown mini-chart.', size: 'l', category: 'Delivery' },
  { type: 'by-state', title: 'Work by state', description: 'Open and finished work by state group.', size: 's', category: 'Breakdown' },
  { type: 'by-priority', title: 'Work by priority', description: 'Open work by priority.', size: 's', category: 'Breakdown' },
  { type: 'by-assignee', title: 'Work by assignee', description: 'Open work per person (workload).', size: 's', category: 'Breakdown' },
  { type: 'created-resolved', title: 'Created vs resolved', description: 'Cumulative issues created and resolved, last 30 days.', size: 'w', category: 'Trends' },
  { type: 'bug-trend', title: 'Bug trend', description: 'Bugs (label "bug" or "defect") created vs resolved, last 30 days.', size: 'w', category: 'Trends' },
  { type: 'cycle-time', title: 'Lead & cycle time', description: 'Median and 85th-percentile days to done, last 30 days.', size: 's', category: 'Trends' },
  { type: 'blocked', title: 'Blocked', description: 'Open work in a state or with a label named "blocked".', size: 's', category: 'Delivery' },
  { type: 'intake', title: 'Intake queue', description: 'Requests waiting for triage.', size: 's', category: 'Delivery' },
  { type: 'recent', title: 'Recently updated', description: 'The latest changes to work items.', size: 'w', category: 'Delivery' },
  { type: 'releases', title: 'Upcoming releases', description: 'Releases planned in Define, next first.', size: 'm', category: 'Planning' },
  { type: 'okrs', title: 'OKR progress', description: 'This quarter\'s objectives and their progress.', size: 'm', category: 'Planning' },
  { type: 'notes', title: 'Team notes', description: 'Plane stickies shared with the whole workspace.', size: 'l', category: 'Team' },
]

export const WIDGET_BY_TYPE = new Map(WIDGETS.map((w) => [w.type, w]))

export const SIZES: readonly WidgetSize[] = ['s', 'm', 'w', 'l']

/** Column span of each size on the 12-column desktop grid. */
export const SIZE_SPAN: Record<WidgetSize, number> = { s: 4, m: 6, w: 8, l: 12 }

/** Column span on the tablet grid (12 columns, but only halves and full). */
export const SIZE_SPAN_MD: Record<WidgetSize, number> = { s: 6, m: 6, w: 12, l: 12 }

export const SIZE_LABEL: Record<WidgetSize, string> = { s: 'One third', m: 'Half', w: 'Two thirds', l: 'Full width' }

const SPAN_SIZE: Record<number, WidgetSize> = { 4: 's', 6: 'm', 8: 'w', 12: 'l' }

/**
 * The default arrangement, written as rows. Every row fills the 12 columns
 * exactly and reads as one story; `dashboard-layout_test.ts` holds it to that.
 */
export const DEFAULT_ROWS: ReadonlyArray<ReadonlyArray<readonly [WidgetType, WidgetSize]>> = [
  [['counters', 'l']],
  [['my-open', 'm'], ['due-soon', 'm']],
  [['active-sprints', 'l']],
  [['by-state', 's'], ['by-priority', 's'], ['by-assignee', 's']],
  [['created-resolved', 'w'], ['cycle-time', 's']],
  [['bug-trend', 'w'], ['blocked', 's']],
  [['recent', 'w'], ['intake', 's']],
  [['releases', 'm'], ['okrs', 'm']],
  [['notes', 'l']],
]

export function defaultLayout(): DashboardLayout {
  return {
    version: 1,
    scope: 'all',
    widgets: DEFAULT_ROWS.flat().map(([type, size]) => ({ id: type, type, size })),
  }
}

const isSize = (v: unknown): v is WidgetSize => v === 's' || v === 'm' || v === 'w' || v === 'l'

/** Accept whatever was stored; drop unknown widgets and duplicate ids. */
export function normalizeLayout(raw: unknown): DashboardLayout {
  const r = raw as { scope?: unknown; widgets?: unknown } | null | undefined
  if (!r || !Array.isArray(r.widgets)) return defaultLayout()
  const seen = new Set<string>()
  const widgets: WidgetInstance[] = []
  for (const w of r.widgets as Array<Partial<WidgetInstance> | null>) {
    if (!w || typeof w !== 'object' || !w.type || !WIDGET_BY_TYPE.has(w.type) || typeof w.id !== 'string' || seen.has(w.id)) continue
    seen.add(w.id)
    widgets.push({ id: w.id, type: w.type, size: isSize(w.size) ? w.size : WIDGET_BY_TYPE.get(w.type)!.size })
  }
  // `team` was a former scope; Define no longer narrows Plane by team.
  const scope: DashboardScope = r.scope === 'project' ? 'project' : 'all'
  return { version: 1, scope, widgets }
}

/* ───── packing ───── */

/**
 * Fit a sequence of column spans into rows of exactly `cols` columns.
 *
 * Widgets are placed in order; one that doesn't fit in the current row starts
 * the next. A row left short is closed by sharing the columns evenly when its
 * widget count divides them, otherwise by widening its last widget — so every
 * row sums to `cols` and nothing is reordered. Rows already full are untouched.
 */
export function packSpans(spans: readonly number[], cols = 12): number[] {
  const out: number[] = []
  let row: number[] = []
  let used = 0
  const close = () => {
    if (!row.length) return
    if (used === cols) out.push(...row)
    else if (cols % row.length === 0) out.push(...row.map(() => cols / row.length))
    else out.push(...row.slice(0, -1), row[row.length - 1] + (cols - used))
    row = []
    used = 0
  }
  for (const raw of spans) {
    const s = Math.min(cols, Math.max(1, Math.round(raw)))
    if (used + s > cols) close()
    row.push(s)
    used += s
  }
  close()
  return out
}

/** Group packed spans into rows of indices (each row sums to `cols`). */
export function rowsOf(spans: readonly number[], cols = 12): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  spans.forEach((s, i) => {
    row.push(i)
    used += s
    if (used >= cols) {
      rows.push(row)
      row = []
      used = 0
    }
  })
  if (row.length) rows.push(row)
  return rows
}

export interface PackedWidget {
  widget: WidgetInstance
  /** Desktop (lg+) span. */
  span: number
  /** Tablet (md) span. */
  spanMd: number
}

/** The layout as drawn: every widget with the spans its packed row gives it. */
export function packLayout(widgets: readonly WidgetInstance[]): PackedWidget[] {
  const lg = packSpans(widgets.map((w) => SIZE_SPAN[w.size]))
  const md = packSpans(widgets.map((w) => SIZE_SPAN_MD[w.size]))
  return widgets.map((widget, i) => ({ widget, span: lg[i], spanMd: md[i] }))
}

/** The size a packed span reads as (packing only ever yields 4, 6, 8 or 12 for these sizes). */
export function sizeOfSpan(span: number): WidgetSize {
  return SPAN_SIZE[span] ?? (span <= 4 ? 's' : span <= 6 ? 'm' : span <= 8 ? 'w' : 'l')
}

/* ───── edits ───── */

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

/** Split `rem` columns among `n` widgets using widget spans (4, 6, 8). */
function split(rem: number, n: number): number[] | null {
  if (n === 1) return [4, 6, 8].includes(rem) ? [rem] : null
  if (n === 2) return rem === 8 ? [4, 4] : null
  return null
}

/**
 * Resize a widget the way a person expects on a full-row grid: the widget
 * takes the chosen width and its row-mates give up or take the difference,
 * so the row stays flush and the choice is actually visible.
 *
 *   • Shrinking a widget that shares a row widens its neighbours.
 *   • Widening one narrows its neighbours, or pushes the last of them onto
 *     the next row when they can't share what's left.
 *   • Shrinking a widget that sits alone pulls the next widget up beside it.
 *
 * Whatever can't be made exact is closed by `packSpans` at draw time.
 */
export function resizeWidget(l: DashboardLayout, id: string, size: WidgetSize): DashboardLayout {
  const idx = l.widgets.findIndex((w) => w.id === id)
  if (idx < 0) return l
  const widgets = l.widgets.map((w) => ({ ...w }))
  const packed = packSpans(widgets.map((w) => SIZE_SPAN[w.size]))
  const row = rowsOf(packed).find((r) => r.includes(idx))!
  widgets[idx].size = size
  const rem = 12 - SIZE_SPAN[size]
  const others = row.filter((i) => i !== idx)

  // Freeze the rows before this one at what they're drawn as, so the row
  // being edited starts at the same widget after the change.
  for (let i = 0; i < row[0]; i++) widgets[i].size = sizeOfSpan(packed[i])

  if (rem === 0) {
    // Full width: row-mates flow on to the next row with their own sizes.
    return { ...l, widgets }
  }
  if (others.length) {
    for (let keep = others.length; keep >= 1; keep--) {
      const spans = split(rem, keep)
      if (!spans) continue
      others.slice(0, keep).forEach((i, k) => (widgets[i].size = sizeOfSpan(spans[k])))
      return { ...l, widgets }
    }
    return { ...l, widgets }
  }
  // Alone in its row: bring the next widget(s) up to fill the space.
  const after = widgets.slice(idx + 1)
  if (after.length >= 2 && rem === 8 && SIZE_SPAN[after[0].size] === 4 && SIZE_SPAN[after[1].size] === 4) return { ...l, widgets }
  if (after.length) {
    const spans = split(rem, 1)
    if (spans) widgets[idx + 1].size = sizeOfSpan(spans[0])
  }
  return { ...l, widgets }
}

/* ───── Tailwind classes (literal, so the scanner sees every one) ───── */

const LG_SPAN = ['', 'lg:col-span-1', 'lg:col-span-2', 'lg:col-span-3', 'lg:col-span-4', 'lg:col-span-5', 'lg:col-span-6', 'lg:col-span-7', 'lg:col-span-8', 'lg:col-span-9', 'lg:col-span-10', 'lg:col-span-11', 'lg:col-span-12']
const MD_SPAN = ['', 'md:col-span-1', 'md:col-span-2', 'md:col-span-3', 'md:col-span-4', 'md:col-span-5', 'md:col-span-6', 'md:col-span-7', 'md:col-span-8', 'md:col-span-9', 'md:col-span-10', 'md:col-span-11', 'md:col-span-12']

export function spanClass(p: Pick<PackedWidget, 'span' | 'spanMd'>): string {
  return `col-span-1 ${MD_SPAN[p.spanMd] ?? 'md:col-span-12'} ${LG_SPAN[p.span] ?? 'lg:col-span-12'}`
}
