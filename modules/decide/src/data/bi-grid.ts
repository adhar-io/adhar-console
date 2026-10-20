/**
 * Dashboard grid layout.
 *
 * Metabase (≥ 0.47) lays dashboards out on a 24-column grid: each dashcard has
 * `col`, `row`, `size_x`, `size_y` in grid units. On a desktop we honour that
 * exactly; narrower screens can't, so:
 *
 *  • tablet — a 12-column flow in reading order; each card keeps its relative
 *    width (halved, floored at half the row so charts stay legible) and its height;
 *  • phone — one column in reading order, heights clamped so a tall table
 *    doesn't eat the screen and a number card doesn't collapse.
 *
 * Reading order is row, then column — what a person scanning the desktop
 * layout would read first.
 */

export interface GridItem {
  id: number
  row: number
  col: number
  size_x: number
  size_y: number
}

export type GridMode = 'desktop' | 'tablet' | 'phone'

export interface Placement {
  id: number
  /** CSS `grid-column` value. */
  column: string
  /** CSS `grid-row` value (desktop only; flow layouts leave it to the browser). */
  row?: string
  /** Height in grid rows. */
  span: number
  order: number
}

export const GRID_COLS = 24

/** Column count the layout needs (≥ 24; never clip a card placed past it). */
export function gridColumns(items: GridItem[]): number {
  return Math.max(GRID_COLS, ...items.map((d) => (d.col ?? 0) + Math.max(1, d.size_x ?? 1)))
}

/** Reading order: top to bottom, then left to right. */
export function readingOrder<T extends GridItem>(items: T[]): T[] {
  return [...items].sort((a, b) => a.row - b.row || a.col - b.col || a.id - b.id)
}

export function gridMode(width: number): GridMode {
  if (width >= 1024) return 'desktop'
  if (width >= 640) return 'tablet'
  return 'phone'
}

/** Pixel height of one grid row per mode. */
export const ROW_PX: Record<GridMode, number> = { desktop: 48, tablet: 48, phone: 44 }

export function layout(items: GridItem[], mode: GridMode): { columns: number; placements: Placement[] } {
  const ordered = readingOrder(items)
  if (mode === 'desktop') {
    const columns = gridColumns(items)
    return {
      columns,
      placements: ordered.map((d, i) => ({
        id: d.id,
        column: `${Math.max(0, d.col) + 1} / span ${Math.max(1, d.size_x)}`,
        row: `${Math.max(0, d.row) + 1} / span ${Math.max(1, d.size_y)}`,
        span: Math.max(1, d.size_y),
        order: i,
      })),
    }
  }
  if (mode === 'tablet') {
    return {
      columns: 12,
      placements: ordered.map((d, i) => {
        const w = Math.min(12, Math.max(6, Math.round(Math.max(1, d.size_x) / 2)))
        return { id: d.id, column: `span ${w}`, span: Math.max(2, d.size_y), order: i }
      }),
    }
  }
  return {
    columns: 1,
    placements: ordered.map((d, i) => ({
      id: d.id,
      column: '1 / -1',
      span: Math.min(9, Math.max(1, d.size_y)),
      order: i,
    })),
  }
}
