/**
 * Service map layout — layered left → right, grouped by namespace, stable.
 *
 *  1. Layers: entry points (External, Ingress) sit in column 0; everything
 *     else takes the longest path from a source over the graph with back
 *     edges removed (DFS), capped so a long chain cannot run off the page.
 *  2. Each namespace becomes a framed block laid out left → right by layer;
 *     a layer column taller than the block's row budget wraps into side-by-side
 *     sub-columns, so a busy namespace is a wide, short frame, not a tower.
 *  3. Three lanes: entry points (External, Ingress) on the left, namespace
 *     frames shelf-packed in rows (about 1.8 : 1) in the middle, cluster
 *     infrastructure (nodes, Kubernetes API, masked peers) on the right.
 *     Frames never overlap.
 *  4. Stability: blocks and nodes keep the order they had last time
 *     (previous position), new ones go after; pinned (dragged) nodes keep
 *     their exact position. The caller only re-runs layout when the node/edge
 *     SET changes, not on every rate update, and the canvas animates moves.
 *
 * Pure (unit-tested).
 */

import { ENTRY_KINDS, type MapGraph, type MapNode } from './live-flows.ts'

export const NODE_W = 188
export const NODE_H = 54
const GAP_Y = 14
const GAP_X = 76
const PAD = 28
const GROUP_PAD = 14
const GROUP_HEAD = 26
const BLOCK_GAP = 22
const MAX_LAYER = 7

export interface Pos {
  x: number
  y: number
}

export interface GroupBox {
  ns: string
  x: number
  y: number
  w: number
  h: number
  count: number
}

export interface MapLayout {
  pos: Map<string, Pos>
  groups: GroupBox[]
  width: number
  height: number
}

/** Structural signature: the layout only needs recomputing when this changes. */
export function layoutKey(g: MapGraph): string {
  const n = g.nodes.map((x) => x.id).sort().join('|')
  const e = g.edges.map((x) => x.id).sort().join('|')
  return `${n}#${e}`
}

export function computeLayers(g: MapGraph): Map<string, number> {
  const out = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const n of g.nodes) {
    out.set(n.id, [])
    indeg.set(n.id, 0)
  }
  for (const e of g.edges) {
    if (!out.has(e.s) || !out.has(e.d) || e.s === e.d) continue
    out.get(e.s)!.push(e.d)
    indeg.set(e.d, (indeg.get(e.d) ?? 0) + 1)
  }
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]))
  // DFS from sources (entries first) marking back edges so cycles cannot inflate layers.
  const order = [...g.nodes]
    .sort((a, b) => Number(ENTRY_KINDS.has(b.kind)) - Number(ENTRY_KINDS.has(a.kind)) || (indeg.get(a.id)! - indeg.get(b.id)!) || a.id.localeCompare(b.id))
    .map((n) => n.id)
  const state = new Map<string, 0 | 1 | 2>()
  const back = new Set<string>()
  const topo: string[] = []
  for (const root of order) {
    if (state.get(root)) continue
    const stack: Array<[string, number]> = [[root, 0]]
    state.set(root, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const [id, i] = top
      const next = out.get(id)!
      if (i < next.length) {
        top[1]++
        const d = next[i]
        const s = state.get(d) ?? 0
        if (s === 1) back.add(`${id}>${d}`)
        else if (s === 0) {
          state.set(d, 1)
          stack.push([d, 0])
        }
      } else {
        state.set(id, 2)
        topo.push(id)
        stack.pop()
      }
    }
  }
  topo.reverse()
  const layer = new Map<string, number>(g.nodes.map((n) => [n.id, 0]))
  for (const id of topo) {
    const l = layer.get(id)!
    for (const d of out.get(id)!) {
      if (back.has(`${id}>${d}`)) continue
      if (ENTRY_KINDS.has(kind.get(d)!)) continue
      layer.set(d, Math.min(MAX_LAYER, Math.max(layer.get(d)!, l + 1)))
    }
  }
  // Entry points always lead.
  for (const n of g.nodes) if (ENTRY_KINDS.has(n.kind)) layer.set(n.id, 0)
  return layer
}

const GAP_X_IN = 44
const LANE_GAP = 96

/**
 * Lays one block out: columns by (local) layer, and any column taller than
 * `maxRows` split into side-by-side sub-columns, so a namespace with a hundred
 * workloads becomes a wide, short frame instead of a tower.
 */
function blockLayout(nodes: MapNode[], layer: Map<string, number>, prev: Map<string, Pos>, framed: boolean) {
  const minL = Math.min(...nodes.map((n) => layer.get(n.id) ?? 0))
  const cols = new Map<number, MapNode[]>()
  for (const n of nodes) {
    const c = (layer.get(n.id) ?? 0) - minL
    const arr = cols.get(c) ?? []
    arr.push(n)
    cols.set(c, arr)
  }
  const prevKey = (n: MapNode) => {
    const p = prev.get(n.id)
    return p ? p.x * 1e-3 + p.y : Number.POSITIVE_INFINITY
  }
  // Rows for a roughly 1.6 : 1 block: cells are (NODE_W+GAP_X_IN) × (NODE_H+GAP_Y),
  // so c ≈ 0.47·r would give 1.6 : 1; layers add columns of their own, so aim
  // taller (r ≈ √(n / 0.3)) to land near that once layering is accounted for.
  const maxRows = Math.max(3, Math.min(16, Math.ceil(Math.sqrt(nodes.length / 0.3))))
  // Columns (a layer, or a slice of a tall layer), each with the gap after it.
  const columns: Array<{ nodes: MapNode[]; gapAfter: number }> = []
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const arr = cols.get(c)!
    arr.sort((a, b) => prevKey(a) - prevKey(b) || Number(!!a.idle) - Number(!!b.idle) || a.name.localeCompare(b.name))
    const chunks = Math.ceil(arr.length / maxRows)
    for (let k = 0; k < chunks; k++) columns.push({ nodes: arr.slice(k * maxRows, (k + 1) * maxRows), gapAfter: k < chunks - 1 ? GAP_X_IN : GAP_X })
  }
  // A long chain would make a ribbon: wrap columns into stacked bands once a
  // band passes the block's target width (about 1.8 : 1 for its node count).
  const cellArea = (NODE_W + GAP_X_IN) * (NODE_H + GAP_Y)
  const targetW = Math.max(NODE_W * 3 + GAP_X * 2, Math.sqrt(nodes.length * cellArea * 1.8))
  const rel = new Map<string, Pos>()
  let x = 0
  let bandTop = 0
  let bandH = 0
  let innerW = 0
  let band: Array<{ x: number; nodes: MapNode[] }> = []
  const flush = () => {
    for (const col of band) {
      const h = col.nodes.length * (NODE_H + GAP_Y) - GAP_Y
      col.nodes.forEach((n, i) => rel.set(n.id, { x: col.x, y: bandTop + (bandH - h) / 2 + i * (NODE_H + GAP_Y) }))
    }
    band = []
  }
  for (const col of columns) {
    if (band.length && x + NODE_W > targetW) {
      flush()
      bandTop += bandH + GAP_Y * 3
      bandH = 0
      x = 0
    }
    band.push({ x, nodes: col.nodes })
    bandH = Math.max(bandH, col.nodes.length * (NODE_H + GAP_Y) - GAP_Y)
    innerW = Math.max(innerW, x + NODE_W)
    x += NODE_W + col.gapAfter
  }
  flush()
  const innerH = bandTop + bandH
  const head = framed ? GROUP_HEAD : 0
  const pad = framed ? GROUP_PAD : 0
  return { rel, w: innerW + pad * 2, h: innerH + head + pad * 2, offX: pad, offY: head + pad, minL }
}

export function layoutMap(g: MapGraph, opts: { prev?: Map<string, Pos>; pinned?: Map<string, Pos> } = {}): MapLayout {
  const prev = opts.prev ?? new Map()
  const pinned = opts.pinned ?? new Map()
  const layer = computeLayers(g)
  const pos = new Map<string, Pos>()
  const groups: GroupBox[] = []

  // Three lanes: entry points | namespace frames | cluster infrastructure.
  const entries = g.nodes.filter((n) => !n.ns && ENTRY_KINDS.has(n.kind))
  const infra = g.nodes.filter((n) => (!n.ns && !ENTRY_KINDS.has(n.kind)) || n.kind === 'namespace')
  const byNs = new Map<string, MapNode[]>()
  for (const n of g.nodes) {
    if (!n.ns || n.kind === 'namespace') continue
    const list = byNs.get(n.ns) ?? []
    list.push(n)
    byNs.set(n.ns, list)
  }
  const stack = (list: MapNode[], x: number, top: number) => {
    const sorted = [...list].sort((a, b) => (prev.get(a.id)?.y ?? Infinity) - (prev.get(b.id)?.y ?? Infinity) || a.name.localeCompare(b.name))
    sorted.forEach((n, i) => pos.set(n.id, { x, y: top + i * (NODE_H + GAP_Y) }))
    return sorted.length ? sorted.length * (NODE_H + GAP_Y) - GAP_Y : 0
  }

  const blocks = [...byNs.entries()].map(([ns, nodes]) => {
    const b = blockLayout(nodes, layer, prev, true)
    const ps = nodes.map((n) => prev.get(n.id)).filter((p): p is Pos => !!p)
    return { ns, nodes, ...b, prevY: ps.length ? Math.min(...ps.map((p) => p.y)) : Infinity, prevX: ps.length ? Math.min(...ps.map((p) => p.x)) : Infinity }
  })
  // Order: where they were last time (stability), else upstream first, biggest first.
  blocks.sort((a, b) =>
    (a.prevY === Infinity && b.prevY === Infinity ? 0 : a.prevY - b.prevY || a.prevX - b.prevX) ||
    a.minL - b.minL || b.w * b.h - a.w * a.h || a.ns.localeCompare(b.ns)
  )
  const area = blocks.reduce((s, b) => s + (b.w + BLOCK_GAP) * (b.h + BLOCK_GAP), 0)
  const target = Math.max(...blocks.map((b) => b.w), Math.sqrt(area * 1.8), 0)

  const entryX = PAD
  const midX = entries.length ? entryX + NODE_W + LANE_GAP : PAD
  // Shelf packing of the namespace frames.
  let x = midX
  let y = PAD
  let rowH = 0
  let maxRight = midX
  for (const b of blocks) {
    if (x > midX && x - midX + b.w > target) {
      x = midX
      y += rowH + BLOCK_GAP
      rowH = 0
    }
    for (const [id, p] of b.rel) pos.set(id, { x: x + b.offX + p.x, y: y + b.offY + p.y })
    groups.push({ ns: b.ns, x, y, w: b.w, h: b.h, count: b.nodes.length })
    x += b.w + BLOCK_GAP
    rowH = Math.max(rowH, b.h)
    maxRight = Math.max(maxRight, x - BLOCK_GAP)
  }
  const midH = blocks.length ? y + rowH - PAD : 0
  const infraX = blocks.length ? maxRight + LANE_GAP : midX
  // Side lanes are centred on the frames.
  const entryH = entries.length * (NODE_H + GAP_Y) - GAP_Y
  stack(entries, entryX, PAD + Math.max(0, (midH - entryH) / 2))
  const infraH = infra.length * (NODE_H + GAP_Y) - GAP_Y
  stack(infra, infraX, PAD + Math.max(0, (midH - infraH) / 2))

  // Pinned nodes override; their frames grow to contain them.
  for (const [id, p] of pinned) if (pos.has(id)) pos.set(id, p)
  if (pinned.size) {
    for (const grp of groups) {
      const members = (byNs.get(grp.ns) ?? []).map((n) => pos.get(n.id)!).filter(Boolean)
      if (!members.length) continue
      const x0 = Math.min(...members.map((p) => p.x)) - GROUP_PAD
      const y0 = Math.min(...members.map((p) => p.y)) - GROUP_PAD - GROUP_HEAD
      const x1 = Math.max(...members.map((p) => p.x + NODE_W)) + GROUP_PAD
      const y1 = Math.max(...members.map((p) => p.y + NODE_H)) + GROUP_PAD
      Object.assign(grp, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
  }
  let width = 0
  let height = 0
  for (const p of pos.values()) {
    width = Math.max(width, p.x + NODE_W + PAD)
    height = Math.max(height, p.y + NODE_H + PAD)
  }
  for (const grp of groups) {
    width = Math.max(width, grp.x + grp.w + PAD)
    height = Math.max(height, grp.y + grp.h + PAD)
  }
  return { pos, groups, width: Math.max(width, NODE_W + PAD * 2), height: Math.max(height, NODE_H + PAD * 2) }
}

/** Node-set signature: edges coming and going never move anything. */
export function nodeSetKey(g: MapGraph): string {
  return g.nodes.map((x) => x.id).sort().join('|')
}

/** Frames recomputed around their members (after provisional placement or pins). */
function framesFromMembers(g: MapGraph, pos: Map<string, Pos>): GroupBox[] {
  const byNs = new Map<string, Pos[]>()
  for (const n of g.nodes) {
    if (!n.ns || n.kind === 'namespace') continue
    const p = pos.get(n.id)
    if (!p) continue
    const list = byNs.get(n.ns) ?? []
    list.push(p)
    byNs.set(n.ns, list)
  }
  return [...byNs.entries()].map(([ns, ps]) => {
    const x0 = Math.min(...ps.map((p) => p.x)) - GROUP_PAD
    const y0 = Math.min(...ps.map((p) => p.y)) - GROUP_PAD - GROUP_HEAD
    const x1 = Math.max(...ps.map((p) => p.x + NODE_W)) + GROUP_PAD
    const y1 = Math.max(...ps.map((p) => p.y + NODE_H)) + GROUP_PAD
    return { ns, x: x0, y: y0, w: x1 - x0, h: y1 - y0, count: ps.length }
  })
}

function bounds(pos: Map<string, Pos>, groups: GroupBox[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const p of pos.values()) {
    width = Math.max(width, p.x + NODE_W + PAD)
    height = Math.max(height, p.y + NODE_H + PAD)
  }
  for (const grp of groups) {
    width = Math.max(width, grp.x + grp.w + PAD)
    height = Math.max(height, grp.y + grp.h + PAD)
  }
  return { width: Math.max(width, NODE_W + PAD * 2), height: Math.max(height, NODE_H + PAD * 2) }
}

/**
 * Live updates without jitter: every node that already has a place keeps it
 * exactly, nodes that left leave their slot empty, and a newcomer in a
 * namespace already on the map takes the next free cell of that frame.
 * Anything that changes the map at block level — a namespace, entry point or
 * infrastructure node not yet on it — returns `null`: the caller then runs a
 * full (order-preserving, animated) `layoutMap`, since squeezing a whole new
 * lane or frame into free space is what produced overlapping lanes.
 */
export function incrementalLayout(g: MapGraph, prev: MapLayout, opts: { pinned?: Map<string, Pos> } = {}): { layout: MapLayout; provisional: number } | null {
  const pinned = opts.pinned ?? new Map()
  const pos = new Map<string, Pos>()
  const missing: MapNode[] = []
  for (const n of g.nodes) {
    const p = pinned.get(n.id) ?? prev.pos.get(n.id)
    if (p) pos.set(n.id, p)
    else missing.push(n)
  }
  // Frame extents BEFORE this batch, so placing one node cannot widen the
  // search for the next (which marched new nodes off to the right).
  const extents = new Map<string, { x0: number; x1: number; y0: number }>()
  for (const n of g.nodes) {
    const p = pos.get(n.id)
    if (!p || !n.ns || n.kind === 'namespace') continue
    const e = extents.get(n.ns)
    if (!e) extents.set(n.ns, { x0: p.x, x1: p.x, y0: p.y })
    else extents.set(n.ns, { x0: Math.min(e.x0, p.x), x1: Math.max(e.x1, p.x), y0: Math.min(e.y0, p.y) })
  }
  if (missing.some((n) => !n.ns || n.kind === 'namespace' || !extents.has(n.ns))) return null
  const taken = (x: number, y: number) => {
    for (const p of pos.values()) if (Math.abs(p.x - x) < NODE_W && Math.abs(p.y - y) < NODE_H) return true
    return false
  }
  const cellW = NODE_W + GAP_X_IN
  const cellH = NODE_H + GAP_Y
  for (const n of missing) {
    // Next free cell, scanning rows from the frame's top, within its original width.
    const { x0, x1, y0 } = extents.get(n.ns!)!
    let placed = false
    for (let y = y0; !placed && y < y0 + cellH * 60; y += cellH) {
      for (let x = x0; x <= x1; x += cellW) {
        if (!taken(x, y)) {
          pos.set(n.id, { x, y })
          placed = true
          break
        }
      }
    }
    if (!placed) return null
  }
  const groups = framesFromMembers(g, pos)
  return { layout: { pos, groups, ...bounds(pos, groups) }, provisional: missing.length }
}

/** The bezier an edge follows (also the particles' track). */
export function edgeCurve(a: Pos, b: Pos): { x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number } {
  if (b.x > a.x + NODE_W + 8) {
    const x0 = a.x + NODE_W
    const y0 = a.y + NODE_H / 2
    const x3 = b.x - 3
    const y3 = b.y + NODE_H / 2
    const c = Math.max(36, (x3 - x0) / 2)
    return { x0, y0, x1: x0 + c, y1: y0, x2: x3 - c, y2: y3, x3, y3 }
  }
  // Same column or backwards: leave below, arrive from below.
  const x0 = a.x + NODE_W / 2 + 10
  const y0 = a.y + NODE_H
  const x3 = b.x + NODE_W / 2 - 10
  const y3 = b.y + NODE_H + 3
  const dip = Math.max(y0, y3) + 40 + Math.min(80, Math.abs(x3 - x0) * 0.15)
  return { x0, y0, x1: x0, y1: dip, x2: x3, y2: dip, x3, y3 }
}
