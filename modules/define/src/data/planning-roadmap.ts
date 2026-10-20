/**
 * Roadmap (timeline / Gantt) layout — pure geometry and scheduling.
 *
 * Bars come from Plane dates (`start_date` / `target_date` on work items,
 * `start_date` / `target_date` on modules). Dependencies come from Plane's
 * work-item relations (`blocking` / `blocked_by`). Dragging a bar becomes a
 * date PATCH computed by `shiftDates`.
 */

import { DAY_MS, dayKey, startOfDay, toMs } from './planning-model.ts'

export type Zoom = 'week' | 'month' | 'quarter'

/** Horizontal pixels per day at each zoom. */
export const PX_PER_DAY: Record<Zoom, number> = { week: 36, month: 12, quarter: 4 }

export interface Span {
  id: string
  start?: string | null
  end?: string | null
}

export interface Range {
  start: number
  end: number
}

/** Padded extent of every dated span, always including today. */
export function timelineRange(spans: Span[], now: number, zoom: Zoom): Range {
  let lo = startOfDay(now)
  let hi = startOfDay(now)
  for (const s of spans) {
    for (const v of [toMs(s.start), toMs(s.end)]) {
      if (v === undefined) continue
      lo = Math.min(lo, startOfDay(v))
      hi = Math.max(hi, startOfDay(v))
    }
  }
  const pad = zoom === 'week' ? 7 : zoom === 'month' ? 14 : 30
  return { start: lo - pad * DAY_MS, end: hi + (pad + 1) * DAY_MS }
}

export interface Tick {
  t: number
  label: string
  major: boolean
}

/** Axis ticks: days (week zoom), weeks (month), months (quarter). */
export function ticks(range: Range, zoom: Zoom): Tick[] {
  const out: Tick[] = []
  if (zoom === 'quarter') {
    const d = new Date(range.start)
    let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    while (m <= range.end && out.length < 400) {
      const dm = new Date(m)
      if (m >= range.start) {
        out.push({
          t: m,
          label: dm.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }) + (dm.getUTCMonth() === 0 ? ` ${dm.getUTCFullYear()}` : ''),
          major: dm.getUTCMonth() % 3 === 0,
        })
      }
      m = Date.UTC(dm.getUTCFullYear(), dm.getUTCMonth() + 1, 1)
    }
    return out
  }
  for (let t = startOfDay(range.start); t <= range.end && out.length < 1000; t += DAY_MS) {
    const d = new Date(t)
    if (zoom === 'month' && d.getUTCDay() !== 1) continue
    out.push({
      t,
      label: zoom === 'week'
        ? String(d.getUTCDate())
        : d.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      major: zoom === 'week' ? d.getUTCDay() === 1 : d.getUTCDate() <= 7,
    })
  }
  return out
}

export interface Bar {
  x: number
  w: number
  /** Only one date is known — drawn as a short marker, not a span. */
  partial: boolean
}

/** Pixel geometry of a span, or null when it has no dates. */
export function barFor(span: Span, range: Range, pxPerDay: number): Bar | null {
  const s = toMs(span.start)
  const e = toMs(span.end)
  if (s === undefined && e === undefined) return null
  const from = startOfDay(s ?? e!)
  const to = startOfDay(e ?? s!)
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const x = ((lo - range.start) / DAY_MS) * pxPerDay
  const w = Math.max(pxPerDay, ((hi - lo) / DAY_MS + 1) * pxPerDay)
  return { x, w, partial: s === undefined || e === undefined }
}

/** Dates after dragging a bar by `days`. */
export function shiftDates(
  span: Span,
  days: number,
  mode: 'move' | 'start' | 'end',
): { start_date: string | null; target_date: string | null } {
  const s = toMs(span.start)
  const e = toMs(span.end)
  const move = (v: number | undefined) => (v === undefined ? null : dayKey(v + days * DAY_MS))
  if (mode === 'move') return { start_date: move(s), target_date: move(e) }
  if (mode === 'start') {
    const next = s === undefined ? undefined : s + days * DAY_MS
    // Never let a start run past the end.
    const clamped = next !== undefined && e !== undefined ? Math.min(next, e) : next
    return { start_date: clamped === undefined ? null : dayKey(clamped), target_date: e === undefined ? null : dayKey(e) }
  }
  const next = e === undefined ? undefined : e + days * DAY_MS
  const clamped = next !== undefined && s !== undefined ? Math.max(next, s) : next
  return { start_date: s === undefined ? null : dayKey(s), target_date: clamped === undefined ? null : dayKey(clamped) }
}

export interface Edge {
  /** The blocker. */
  from: string
  /** The blocked item. */
  to: string
}

/**
 * Blocks-edges among the visible items, from each item's relations. Plane
 * records both directions (`blocking` on one, `blocked_by` on the other), so
 * edges are de-duplicated.
 */
export function dependencyEdges(
  relations: Map<string, { blocking: string[]; blocked_by: string[] }>,
  visible: Set<string>,
): Edge[] {
  const seen = new Set<string>()
  const out: Edge[] = []
  const add = (from: string, to: string) => {
    if (from === to || !visible.has(from) || !visible.has(to)) return
    const k = `${from}>${to}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ from, to })
  }
  for (const [id, r] of relations) {
    for (const t of r.blocking) add(id, t)
    for (const b of r.blocked_by) add(b, id)
  }
  return out
}

/** Edges whose blocker is scheduled to finish after the blocked item starts. */
export function scheduleConflicts(edges: Edge[], spans: Map<string, Span>): Edge[] {
  return edges.filter((e) => {
    const a = spans.get(e.from)
    const b = spans.get(e.to)
    const aEnd = toMs(a?.end ?? a?.start)
    const bStart = toMs(b?.start ?? b?.end)
    return aEnd !== undefined && bStart !== undefined && aEnd >= bStart
  })
}

/**
 * The critical path: the dependency chain with the latest finish, walking
 * back through blockers. Cycles in the graph are ignored (each node once).
 */
export function criticalPath(edges: Edge[], spans: Map<string, Span>): Set<string> {
  if (!edges.length) return new Set()
  const blockers = new Map<string, string[]>()
  const nodes = new Set<string>()
  for (const e of edges) {
    nodes.add(e.from)
    nodes.add(e.to)
    blockers.set(e.to, [...(blockers.get(e.to) ?? []), e.from])
  }
  const end = (id: string) => toMs(spans.get(id)?.end ?? spans.get(id)?.start) ?? -Infinity
  // Longest chain (by node count, then by finish) ending at each node.
  const memo = new Map<string, { len: number; path: string[] }>()
  const visiting = new Set<string>()
  const best = (id: string): { len: number; path: string[] } => {
    const m = memo.get(id)
    if (m) return m
    if (visiting.has(id)) return { len: 0, path: [] }
    visiting.add(id)
    let pick = { len: 1, path: [id] }
    for (const b of blockers.get(id) ?? []) {
      const r = best(b)
      if (r.len + 1 > pick.len || (r.len + 1 === pick.len && end(b) > end(pick.path[pick.path.length - 2] ?? id))) {
        pick = { len: r.len + 1, path: [...r.path, id] }
      }
    }
    visiting.delete(id)
    memo.set(id, pick)
    return pick
  }
  let top: { len: number; path: string[] } = { len: 0, path: [] }
  let topEnd = -Infinity
  for (const n of nodes) {
    const r = best(n)
    if (r.len < 2) continue
    if (end(n) > topEnd || (end(n) === topEnd && r.len > top.len)) {
      top = r
      topEnd = end(n)
    }
  }
  return new Set(top.path)
}

/** Connector path for an edge: out of the blocker's right edge, into the blocked's left. */
export function edgePath(a: { x: number; w: number; y: number }, b: { x: number; y: number }): string {
  const x1 = a.x + a.w
  const x2 = b.x
  const mid = Math.max(x1 + 8, x2 - 8)
  if (x2 >= x1 + 16) return `M${x1},${a.y} H${mid} V${b.y} H${x2}`
  // Backwards (conflict): route around below the blocker.
  const drop = a.y + (b.y >= a.y ? 10 : -10)
  return `M${x1},${a.y} h8 V${drop} H${x2 - 8} V${b.y} H${x2}`
}
