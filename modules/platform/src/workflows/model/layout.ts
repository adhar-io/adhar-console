/**
 * Deterministic layered layout for workflow graphs (design 0026 §6.8):
 *
 *   1. longest-path layering — a task's column is one more than its deepest
 *      dependency;
 *   2. two passes of barycentric ordering within each column;
 *   3. ties broken by task name;
 *   4. an exit lane laid out separately, below.
 *
 * The same graph always draws the same way, so "the red step on the left"
 * means something across reloads and between the designer and the run view.
 * Pure: `layout_test.ts`.
 */

export interface LayoutNode {
  id: string
  lane?: 'main' | 'exit'
}

export interface LayoutEdge {
  source: string
  target: string
}

export interface LayoutOptions {
  /** Horizontal distance between column origins. */
  colGap?: number
  /** Vertical distance between row origins. */
  rowGap?: number
  /** Gap between the main graph and the exit lane. */
  laneGap?: number
}

export type Positions = Record<string, { x: number; y: number }>

export const CARD_WIDTH = 248
export const RUN_CARD_HEIGHT = 88

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Column per node by longest path from the sources; nodes on a cycle keep the column they reached. */
export function layers(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id))
  const preds = new Map<string, string[]>()
  for (const id of ids) preds.set(id, [])
  for (const e of edges) if (ids.has(e.source) && ids.has(e.target) && e.source !== e.target) preds.get(e.target)!.push(e.source)
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0 // a cycle: validation reports it; layout must still terminate
    visiting.add(id)
    let d = 0
    for (const p of preds.get(id) ?? []) d = Math.max(d, depth(p) + 1)
    visiting.delete(id)
    layer.set(id, d)
    return d
  }
  for (const id of [...ids].sort(byName)) depth(id)
  return layer
}

/** Order inside each column: by name, then two barycentric sweeps (forward, backward). */
export function orderColumns(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], layer: Map<string, number>): string[][] {
  const cols: string[][] = []
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0
    ;(cols[l] ??= []).push(n.id)
  }
  for (let i = 0; i < cols.length; i++) cols[i] = (cols[i] ?? []).sort(byName)
  // Nothing to order across: an empty graph (a new sub-flow) or a single column.
  if (cols.length < 2) return cols
  const index = () => {
    const m = new Map<string, number>()
    cols.forEach((c) => c.forEach((id, i) => m.set(id, i)))
    return m
  }
  const preds = new Map<string, string[]>()
  const succs = new Map<string, string[]>()
  for (const e of edges) {
    ;(preds.get(e.target) ?? preds.set(e.target, []).get(e.target)!).push(e.source)
    ;(succs.get(e.source) ?? succs.set(e.source, []).get(e.source)!).push(e.target)
  }
  const sweep = (from: number, to: number, step: number, neighbours: Map<string, string[]>) => {
    for (let l = from; l !== to; l += step) {
      const pos = index()
      const bary = (id: string) => {
        const ns = (neighbours.get(id) ?? []).map((n) => pos.get(n)).filter((v): v is number => v !== undefined)
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : (pos.get(id) ?? 0)
      }
      const scores = new Map(cols[l].map((id) => [id, bary(id)]))
      cols[l] = [...cols[l]].sort((a, b) => scores.get(a)! - scores.get(b)! || byName(a, b))
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    sweep(1, cols.length, 1, preds)
    sweep(cols.length - 2, -1, -1, succs)
  }
  return cols
}

/**
 * Positions for every node. Columns are centred on the tallest one, so a
 * single-task step sits level with the middle of a parallel group.
 */
export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: LayoutOptions = {}): Positions {
  const colGap = opts.colGap ?? CARD_WIDTH + 64
  const rowGap = opts.rowGap ?? RUN_CARD_HEIGHT + 28
  const laneGap = opts.laneGap ?? 56
  const main = nodes.filter((n) => n.lane !== 'exit')
  const exit = nodes.filter((n) => n.lane === 'exit')
  const mainIds = new Set(main.map((n) => n.id))
  const cols = orderColumns(main, edges.filter((e) => mainIds.has(e.source) && mainIds.has(e.target)), layers(main, edges))
  const tallest = Math.max(1, ...cols.map((c) => c?.length ?? 0))
  const out: Positions = {}
  cols.forEach((col, x) => {
    const offset = ((tallest - col.length) * rowGap) / 2
    col.forEach((id, y) => (out[id] = { x: x * colGap, y: offset + y * rowGap }))
  })
  const exitY = tallest * rowGap + laneGap
  ;[...exit].sort((a, b) => byName(a.id, b.id)).forEach((n, i) => (out[n.id] = { x: i * colGap, y: exitY }))
  return out
}

/**
 * The clock a run card needs: `now` while its step is running (its elapsed
 * time moves), else a constant — a finished or unstarted step shows nothing
 * that depends on the time, so its card need not change when the clock ticks.
 */
export function clockFor(n: { startedAt?: string; finishedAt?: string }, now: number): number {
  return n.startedAt && !n.finishedAt ? now : 0
}
