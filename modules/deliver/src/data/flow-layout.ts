/**
 * Serpentine layout for the delivery value stream.
 *
 * The flow is a linear chain — Code → PR → Build → Dev loop → Preview →
 * Promotion → GitOps → Rollout — and it used to be drawn as exactly that: one
 * row in a horizontally-scrolling strip. Eight nodes never fit, so the reader
 * scrolled to see the back half and could never see the shape of the stream at
 * once; the nodes were squeezed to 196px to stretch the row as far as possible.
 *
 * On a canvas the chain wraps instead, like a line of text: row 0 runs left to
 * right, row 1 runs right to left, and so on. That is what makes the wrap
 * legible — the last node of a row sits directly above the first node of the
 * next, so the connector is a short vertical drop rather than a long sweep back
 * across the canvas. Reading order is never in doubt: follow the arrows, or the
 * step number on each node.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export interface FlowPlaced {
  x: number
  y: number
  row: number
  col: number
}

export interface FlowEdgeGeom {
  from: { x: number; y: number }
  to: { x: number; y: number }
  /** `wrap` is the vertical drop into the next row; everything else is in-row. */
  dir: 'forward' | 'wrap'
}

export interface SerpentineLayout {
  /** Index-aligned with the stage list. */
  pos: FlowPlaced[]
  /** `edges[i]` leaves node `i` for node `i + 1`. */
  edges: FlowEdgeGeom[]
  width: number
  height: number
  nodeWidth: number
  nodeHeight: number
  perRow: number
  rows: number
}

export interface SerpentineOpts {
  nodeWidth?: number
  nodeHeight?: number
  colGap?: number
  rowGap?: number
  maxPerRow?: number
}

/**
 * How to break `count` nodes into rows of at most `maxPerRow`.
 *
 * Rows are balanced rather than greedily filled: eight nodes with a maximum of
 * four become 4 + 4, not 4 + 4 by accident — and nine become 3 + 3 + 3 instead
 * of 4 + 4 + 1, which would leave a row holding a single node.
 */
export function rowShape(count: number, maxPerRow = 4): { rows: number; perRow: number } {
  if (count <= 0) return { rows: 0, perRow: 0 }
  const rows = Math.ceil(count / Math.max(1, maxPerRow))
  return { rows, perRow: Math.ceil(count / rows) }
}

export function layoutSerpentine(count: number, opts: SerpentineOpts = {}): SerpentineLayout {
  const NW = opts.nodeWidth ?? 252
  // Tall enough for the node's detail line to actually have room: a node is a
  // fixed-height flex column, so anything the chrome does not leave space for
  // is shrunk to nothing rather than overflowing, and the detail silently
  // vanishes.
  const NH = opts.nodeHeight ?? 156
  const CX = opts.colGap ?? 56
  const RY = opts.rowGap ?? 68
  const { rows, perRow } = rowShape(count, opts.maxPerRow ?? 4)

  const pos: FlowPlaced[] = []
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow)
    const seat = i % perRow
    // Odd rows run backwards, so every row ends under where the next begins.
    const col = row % 2 === 0 ? seat : perRow - 1 - seat
    pos.push({ row, col, x: col * (NW + CX), y: row * (NH + RY) })
  }

  const edges: FlowEdgeGeom[] = []
  for (let i = 0; i + 1 < count; i++) {
    const a = pos[i]
    const b = pos[i + 1]
    if (a.row === b.row) {
      // Leave by the edge that faces the next node, whichever way the row runs.
      const rightward = b.col > a.col
      edges.push({
        from: { x: a.x + (rightward ? NW : 0), y: a.y + NH / 2 },
        to: { x: b.x + (rightward ? 0 : NW), y: b.y + NH / 2 },
        dir: 'forward',
      })
    } else {
      edges.push({
        from: { x: a.x + NW / 2, y: a.y + NH },
        to: { x: b.x + NW / 2, y: b.y },
        dir: 'wrap',
      })
    }
  }

  return {
    pos,
    edges,
    width: perRow ? perRow * NW + (perRow - 1) * CX : NW,
    height: rows ? rows * NH + (rows - 1) * RY : NH,
    nodeWidth: NW,
    nodeHeight: NH,
    perRow,
    rows,
  }
}
