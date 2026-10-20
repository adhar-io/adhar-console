/**
 * Whiteboard document model + pure geometry, framework-free (tested in
 * `whiteboard-model_test.ts`).
 *
 * A board is a flat, z-ordered list of elements: shapes (sticky, rect,
 * ellipse, diamond, text, frame), freehand pen strokes, and connectors whose
 * endpoints either float or attach to an element (and then follow it).
 *
 * Boards created before this model stored only `notes` + `connections`;
 * `migrateBoard` lifts them into elements, and `toLegacy` keeps writing those
 * two fields so read-only surfaces (dashboard, catalog) still count notes.
 */

import type { NoteConnection, StickyColor, StickyNote, WhiteboardBoard } from './types.ts'

export type ColorId = StickyColor | 'ink'

export type ShapeKind = 'sticky' | 'rect' | 'ellipse' | 'diamond' | 'text' | 'frame'

export interface ShapeEl {
  id: string
  kind: ShapeKind
  x: number
  y: number
  w: number
  h: number
  text: string
  color: ColorId
  /** Shapes only: solid tint vs outline. */
  filled?: boolean
  fontSize?: number
  locked?: boolean
  author?: string
  /** A read-only snapshot of a catalog entity or diagram embedded on the board. */
  embed?: EmbedSnapshot
  /** Plane work item this sticky became. */
  work?: WorkLink
}

/** Read-only snapshot of live data, refreshed on demand. */
export interface EmbedSnapshot {
  type: 'entity' | 'diagram'
  /** Entity ref or diagram id. */
  ref: string
  title: string
  subtitle?: string
  /** Entity facts, one per line. */
  lines?: string[]
  /** Diagram: rendered SVG as a data URI. */
  image?: string
  /** When the snapshot was taken. */
  at: string
  /** True when the source no longer exists. */
  missing?: boolean
}

export interface WorkLink {
  projectId: string
  issueId: string
  key?: string
  at: string
}

export interface PenEl {
  id: string
  kind: 'pen'
  x: number
  y: number
  w: number
  h: number
  /** Points relative to the stroke's original box (`vw` × `vh`). */
  points: [number, number][]
  vw: number
  vh: number
  color: ColorId
  width: number
  locked?: boolean
}

export interface Endpoint {
  /** Attached element id; when absent the endpoint floats at x/y. */
  id?: string
  x: number
  y: number
}

export type Route = 'straight' | 'elbow' | 'curve'
export type ArrowStyle = 'end' | 'both' | 'none'

export interface ConnectorEl {
  id: string
  kind: 'connector'
  from: Endpoint
  to: Endpoint
  color: ColorId
  route: Route
  arrow: ArrowStyle
  dashed?: boolean
  label?: string
  locked?: boolean
}

export type BoardEl = ShapeEl | PenEl | ConnectorEl

export interface Camera {
  x: number
  y: number
  k: number
}

/** Stored board: legacy fields + the element model. */
export type BoardDoc = WhiteboardBoard & {
  elements?: BoardEl[]
  camera?: Camera
  description?: string
  /** Workspace project / owner team. */
  project?: string
  team?: string
  /** Display name + user id of the last person who saved (envelope `_updatedBy` is an id). */
  updated_by?: string
  updated_by_id?: string
}

export interface Pt {
  x: number
  y: number
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const PALETTE: Record<ColorId, { fill: string; stroke: string; text: string; label: string }> = {
  amber: { fill: '#fef3c7', stroke: '#d97706', text: '#451a03', label: 'Amber' },
  rose: { fill: '#ffe4e6', stroke: '#e11d48', text: '#4c0519', label: 'Rose' },
  sky: { fill: '#e0f2fe', stroke: '#0284c7', text: '#082f49', label: 'Sky' },
  violet: { fill: '#ede9fe', stroke: '#7c3aed', text: '#2e1065', label: 'Violet' },
  emerald: { fill: '#d1fae5', stroke: '#059669', text: '#022c22', label: 'Emerald' },
  slate: { fill: '#f1f5f9', stroke: '#64748b', text: '#0f172a', label: 'Slate' },
  ink: { fill: 'none', stroke: 'currentColor', text: 'currentColor', label: 'Ink' },
}

export const STICKY_W = 180
export const STICKY_H = 140

export const isShape = (e: BoardEl): e is ShapeEl => e.kind !== 'pen' && e.kind !== 'connector'
export const isConnector = (e: BoardEl): e is ConnectorEl => e.kind === 'connector'

/* ───────── migration ───────── */

/** Elements of a board, lifting legacy notes/connections when needed. */
export function migrateBoard(board: Pick<BoardDoc, 'elements' | 'notes' | 'connections'>): BoardEl[] {
  if (Array.isArray(board.elements)) return board.elements
  const notes = Array.isArray(board.notes) ? board.notes : []
  const out: BoardEl[] = notes.map((n) => ({
    id: n.id,
    kind: 'sticky' as const,
    x: n.x,
    y: n.y,
    w: 200,
    h: 140,
    text: n.text,
    color: n.color,
    author: n.author,
  }))
  const ids = new Set(notes.map((n) => n.id))
  for (const [i, c] of (board.connections ?? []).entries()) {
    if (!ids.has(c.from) || !ids.has(c.to)) continue
    out.push({
      id: `conn-${c.from}-${c.to}-${i}`,
      kind: 'connector',
      from: { id: c.from, x: 0, y: 0 },
      to: { id: c.to, x: 0, y: 0 },
      color: 'ink',
      route: 'curve',
      arrow: 'end',
    })
  }
  return out
}

/** Derive the legacy `notes` + `connections` fields from elements. */
export function toLegacy(elements: BoardEl[]): { notes: StickyNote[]; connections: NoteConnection[] } {
  const stickies = elements.filter((e): e is ShapeEl => e.kind === 'sticky')
  const ids = new Set(stickies.map((s) => s.id))
  return {
    notes: stickies.map((s) => ({
      id: s.id,
      text: s.text,
      color: s.color === 'ink' ? 'slate' : s.color,
      x: Math.round(s.x),
      y: Math.round(s.y),
      author: s.author ?? '',
    })),
    connections: elements
      .filter(isConnector)
      .filter((c) => c.from.id && c.to.id && ids.has(c.from.id) && ids.has(c.to.id))
      .map((c) => ({ from: c.from.id!, to: c.to.id! })),
  }
}

/* ───────── geometry ───────── */

export function center(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function normalizeBox(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
}

export function snap(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v
}

/**
 * Point on an element's outline in the direction of `toward` from its
 * centre — where an attached connector meets the shape.
 */
export function anchorPoint(el: Box & { kind?: string }, toward: Pt, gap = 4): Pt {
  const c = center(el)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (dx === 0 && dy === 0) return c
  const hw = el.w / 2 + gap
  const hh = el.h / 2 + gap
  let t: number
  if (el.kind === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh))
  } else if (el.kind === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
  } else {
    t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity)
  }
  return { x: c.x + dx * t, y: c.y + dy * t }
}

/** Resolve both ends of a connector to world points. */
export function connectorEnds(c: ConnectorEl, byId: Map<string, BoardEl>): [Pt, Pt] {
  const get = (id?: string) => {
    const e = id ? byId.get(id) : undefined
    return e && e.kind !== 'connector' ? e : undefined
  }
  const a = get(c.from.id)
  const b = get(c.to.id)
  const ac: Pt = a ? center(a) : { x: c.from.x, y: c.from.y }
  const bc: Pt = b ? center(b) : { x: c.to.x, y: c.to.y }
  return [a ? anchorPoint(a, bc) : ac, b ? anchorPoint(b, ac) : bc]
}

/** SVG path for a connector between two points. */
export function connectorPath(a: Pt, b: Pt, route: Route): string {
  const r = (n: number) => Math.round(n * 10) / 10
  if (route === 'straight') return `M${r(a.x)},${r(a.y)} L${r(b.x)},${r(b.y)}`
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (route === 'elbow') {
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = a.x + dx / 2
      return `M${r(a.x)},${r(a.y)} L${r(mx)},${r(a.y)} L${r(mx)},${r(b.y)} L${r(b.x)},${r(b.y)}`
    }
    const my = a.y + dy / 2
    return `M${r(a.x)},${r(a.y)} L${r(a.x)},${r(my)} L${r(b.x)},${r(my)} L${r(b.x)},${r(b.y)}`
  }
  const horizontal = Math.abs(dx) >= Math.abs(dy)
  const k = 0.5
  const c1 = horizontal ? { x: a.x + dx * k, y: a.y } : { x: a.x, y: a.y + dy * k }
  const c2 = horizontal ? { x: b.x - dx * k, y: b.y } : { x: b.x, y: b.y - dy * k }
  return `M${r(a.x)},${r(a.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(b.x)},${r(b.y)}`
}

/** Midpoint used for connector labels. */
export function connectorMid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Bounding box of any element (connectors from their resolved ends). */
export function elementBox(el: BoardEl, byId: Map<string, BoardEl>): Box {
  if (el.kind === 'connector') {
    const [a, b] = connectorEnds(el, byId)
    return normalizeBox(a, b)
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}

export function boundsOf(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w)
    y2 = Math.max(y2, b.y + b.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Resize `box` by dragging `handle` by (dx, dy); never below `min`. */
export function resizeBox(box: Box, handle: Handle, dx: number, dy: number, keepRatio = false, min = 16): Box {
  let { x, y, w, h } = box
  if (handle.includes('e')) w = box.w + dx
  if (handle.includes('s')) h = box.h + dy
  if (handle.includes('w')) w = box.w - dx
  if (handle.includes('n')) h = box.h - dy
  if (keepRatio && box.w > 0 && box.h > 0 && handle.length === 2) {
    const ratio = box.w / box.h
    if (Math.abs(w / box.w) > Math.abs(h / box.h)) h = w / ratio
    else w = h * ratio
  }
  w = Math.max(min, w)
  h = Math.max(min, h)
  if (handle.includes('w')) x = box.x + box.w - w
  if (handle.includes('n')) y = box.y + box.h - h
  return { x, y, w, h }
}

/** Camera that fits `box` into a viewport of `vw` × `vh`. */
export function fitCamera(box: Box | null, vw: number, vh: number, pad = 60, maxK = 1.5): Camera {
  if (!box || box.w <= 0 || box.h <= 0) return { x: vw / 2 - 400, y: vh / 2 - 250, k: 1 }
  const k = Math.max(0.1, Math.min(maxK, (vw - pad * 2) / box.w, (vh - pad * 2) / box.h))
  return { k, x: (vw - box.w * k) / 2 - box.x * k, y: (vh - box.h * k) / 2 - box.y * k }
}

/** Zoom by `factor` keeping screen point (sx, sy) fixed. */
export function zoomAt(cam: Camera, factor: number, sx: number, sy: number, min = 0.1, max = 4): Camera {
  const k = Math.min(max, Math.max(min, cam.k * factor))
  const r = k / cam.k
  return { k, x: sx - (sx - cam.x) * r, y: sy - (sy - cam.y) * r }
}

/* ───────── text ───────── */

/** Greedy word-wrap using an injected width measure (canvas in the browser). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w !== '')
    let line = ''
    for (const word of words) {
      const candidate = line + word
      if (!line || measure(candidate.trimEnd()) <= maxWidth) {
        // A single word wider than the box is hard-broken.
        if (!line && measure(word) > maxWidth && word.trim()) {
          let chunk = ''
          for (const ch of word) {
            if (chunk && measure(chunk + ch) > maxWidth) {
              out.push(chunk)
              chunk = ch
            } else chunk += ch
          }
          line = chunk
        } else line = candidate
      } else {
        out.push(line.trimEnd())
        line = word.trimStart()
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

/* ───────── edits ───────── */

/** Remove elements and any connector attached to them. */
export function removeElements(elements: BoardEl[], ids: Set<string>): BoardEl[] {
  return elements.filter(
    (e) => !ids.has(e.id) && !(isConnector(e) && ((e.from.id && ids.has(e.from.id)) || (e.to.id && ids.has(e.to.id)))),
  )
}

/**
 * Deep-copy `ids` with fresh ids, offset by (dx, dy). Connectors between two
 * copied elements are re-pointed at the copies; endpoints to elements that
 * were not copied float at their resolved position.
 */
export function cloneElements(
  elements: BoardEl[],
  ids: Set<string>,
  makeId: (prefix: string) => string,
  dx = 24,
  dy = 24,
): BoardEl[] {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const map = new Map<string, string>()
  const src = elements.filter((e) => ids.has(e.id))
  for (const e of src) map.set(e.id, makeId(e.kind === 'connector' ? 'conn' : 'el'))
  return src.map((e) => {
    if (e.kind === 'connector') {
      const [a, b] = connectorEnds(e, byId)
      const end = (ep: Endpoint, p: Pt): Endpoint =>
        ep.id && map.has(ep.id) ? { id: map.get(ep.id), x: 0, y: 0 } : { x: p.x + dx, y: p.y + dy }
      return { ...e, id: map.get(e.id)!, from: end(e.from, a), to: end(e.to, b) }
    }
    // A copy is a new note: it has not become a work item.
    const { work: _work, ...rest } = e as ShapeEl
    return { ...(e.kind === 'pen' ? e : rest), id: map.get(e.id)!, x: e.x + dx, y: e.y + dy } as BoardEl
  })
}

/** Move elements (and floating ends of selected connectors) by (dx, dy). */
export function translate(origin: BoardEl[], ids: Set<string>, dx: number, dy: number): BoardEl[] {
  return origin.map((e) => {
    if (!ids.has(e.id) || e.locked) return e
    if (e.kind === 'connector') {
      return {
        ...e,
        from: e.from.id ? e.from : { x: e.from.x + dx, y: e.from.y + dy },
        to: e.to.id ? e.to : { x: e.to.x + dx, y: e.to.y + dy },
      }
    }
    return { ...e, x: e.x + dx, y: e.y + dy }
  })
}

/** Bring to front / send to back, keeping relative order. */
export function reorder(elements: BoardEl[], ids: Set<string>, where: 'front' | 'back'): BoardEl[] {
  const picked = elements.filter((e) => ids.has(e.id))
  const rest = elements.filter((e) => !ids.has(e.id))
  return where === 'front' ? [...rest, ...picked] : [...picked, ...rest]
}

/** Ids of elements fully inside any of the given frames. */
export function frameChildren(elements: BoardEl[], frameIds: Set<string>): Set<string> {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const frames = elements.filter((e) => frameIds.has(e.id) && e.kind === 'frame') as ShapeEl[]
  const out = new Set<string>()
  if (!frames.length) return out
  for (const e of elements) {
    if (frameIds.has(e.id) || e.kind === 'frame') continue
    const b = elementBox(e, byId)
    if (frames.some((f) => contains(f, b))) out.add(e.id)
  }
  return out
}

/** Smooth SVG path through freehand points (quadratic midpoints). */
export function penPath(points: [number, number][]): string {
  if (!points.length) return ''
  if (points.length < 3) return `M${points[0][0]},${points[0][1]} ` + points.slice(1).map((p) => `L${p[0]},${p[1]}`).join(' ')
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    d += ` Q${x},${y} ${(x + nx) / 2},${(y + ny) / 2}`
  }
  const last = points[points.length - 1]
  return d + ` L${last[0]},${last[1]}`
}

/** Normalise raw world points into a PenEl box (relative points). */
export function penFromPoints(id: string, pts: Pt[], color: ColorId, width: number): PenEl | null {
  if (pts.length < 2) return null
  const b = boundsOf(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!
  const w = Math.max(1, b.w)
  const h = Math.max(1, b.h)
  return {
    id,
    kind: 'pen',
    x: b.x,
    y: b.y,
    w,
    h,
    vw: w,
    vh: h,
    color,
    width,
    points: pts.map((p) => [Math.round((p.x - b.x) * 10) / 10, Math.round((p.y - b.y) * 10) / 10]),
  }
}

/* ───────── history ───────── */

export interface History {
  past: BoardEl[][]
  future: BoardEl[][]
}

export const HISTORY_LIMIT = 100

export function pushHistory(h: History, snapshot: BoardEl[]): History {
  return { past: [...h.past, snapshot].slice(-HISTORY_LIMIT), future: [] }
}

export function undo(h: History, current: BoardEl[]): { history: History; elements: BoardEl[] } | null {
  if (!h.past.length) return null
  const prev = h.past[h.past.length - 1]
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, elements: prev }
}

export function redo(h: History, current: BoardEl[]): { history: History; elements: BoardEl[] } | null {
  if (!h.future.length) return null
  const [next, ...rest] = h.future
  return { history: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: rest }, elements: next }
}

/* ───────── platform embeds + work items ───────── */

export const EMBED_W = 300

/** Facts shown on an embedded catalog entity card. */
export function entityFacts(
  e: { kind: string; name: string; title?: string; type?: string; lifecycle?: string; owner?: string; system?: string; project?: string; providesApis: string[]; consumesApis: string[]; dependsOn: string[]; description?: string },
): { title: string; subtitle: string; lines: string[] } {
  const short = (r: string) => r.replace(/^[a-z]+:(default\/)?/, '')
  const lines: string[] = []
  if (e.description) lines.push(e.description)
  if (e.owner) lines.push(`Owner: ${short(e.owner)}`)
  if (e.system) lines.push(`System: ${short(e.system)}`)
  if (e.project) lines.push(`Project: ${e.project}`)
  if (e.lifecycle) lines.push(`Lifecycle: ${e.lifecycle}`)
  if (e.providesApis.length) lines.push(`Provides: ${e.providesApis.map(short).join(', ')}`)
  if (e.consumesApis.length) lines.push(`Consumes: ${e.consumesApis.map(short).join(', ')}`)
  if (e.dependsOn.length) lines.push(`Depends on: ${e.dependsOn.map(short).join(', ')}`)
  return { title: e.title ?? e.name, subtitle: [e.kind, e.type].filter(Boolean).join(' · '), lines }
}

/** Height an entity card needs for its lines. */
export function embedHeight(lines: number): number {
  return Math.min(320, 64 + Math.max(1, lines) * 18)
}

/** Selected stickies with text that have not become work items yet. */
export function stickiesForWork(elements: readonly BoardEl[], ids: ReadonlySet<string>): ShapeEl[] {
  return elements.filter((e): e is ShapeEl => ids.has(e.id) && e.kind === 'sticky' && !!(e as ShapeEl).text?.trim() && !(e as ShapeEl).work)
}

/** Lay `n` new stickies out in a grid centred on `at`. */
export function gridAround(at: Pt, n: number, w = STICKY_W, h = STICKY_H, gap = 20): Pt[] {
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))))
  const rows = Math.ceil(n / cols)
  const x0 = at.x - (cols * (w + gap) - gap) / 2
  const y0 = at.y - (rows * (h + gap) - gap) / 2
  return Array.from({ length: n }, (_, i) => ({ x: x0 + (i % cols) * (w + gap), y: y0 + Math.floor(i / cols) * (h + gap) }))
}
