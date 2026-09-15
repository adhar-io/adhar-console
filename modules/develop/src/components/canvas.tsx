import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'
import type { StatusKind } from '@adhar-console/shell-ui'

/**
 * Canvas shell for the Develop module's graph views.
 *
 * An Argo Workflow is a DAG, and a DAG drawn as a horizontally-scrolling row of
 * cards is readable for four nodes and unusable for twenty, with no way to step
 * back and see the shape of the run. This provides the chrome such a view needs
 * — dotted ground, pan, zoom, fit-to-view, full-page — so the view itself only
 * has to describe its own nodes and edges.
 *
 * Deliberately a copy of `modules/deliver/src/components/canvas.tsx` rather than
 * a shared import: the two are separate Module-Federation remotes and must never
 * reach across into one another. Promoting it to `packages/shell-ui` is not the
 * answer either — that package is source-aliased into all nine remotes, so
 * anything added there is bundled nine times.
 */

export const ZOOM_STEPS = [0.5, 0.65, 0.8, 0.9, 1, 1.15, 1.35, 1.6, 2] as const
const DEFAULT_ZOOM_INDEX = 4

/** Status colour for edges, node accents and the legend. */
export function statusHex(kind: StatusKind): string {
  switch (kind) {
    case 'healthy':
      return 'var(--color-emerald-500)'
    case 'failed':
    case 'degraded':
      return 'var(--color-rose-500)'
    case 'progressing':
      return 'var(--color-indigo-500)'
    case 'paused':
      return 'var(--color-amber-500)'
    case 'info':
      return 'var(--color-sky-500)'
    default:
      return 'var(--color-slate-400)'
  }
}

export interface CanvasEdge {
  from: { x: number; y: number }
  to: { x: number; y: number }
  kind: StatusKind
  /** Animate the dash, for an edge whose upstream is actively running. */
  flowing?: boolean
}

export interface GraphCanvasProps {
  /** Intrinsic size of the laid-out graph, before zoom. */
  width: number
  height: number
  edges?: CanvasEdge[]
  /** Absolutely-positioned nodes, in graph coordinates. */
  children: React.ReactNode
  /** Legend entries, rendered bottom-left. */
  legend?: Array<{ kind: StatusKind; label: string }>
  /** Height when not full-page. */
  className?: string
  /** Extra controls placed left of the zoom cluster. */
  toolbar?: React.ReactNode
  /** Announced to screen readers in place of the visual graph. */
  ariaLabel?: string
}

/**
 * Pan/zoom canvas with a dotted ground.
 *
 * Panning is drag-to-move on the background rather than scrollbars, because a
 * graph is a plane and not a document. Nodes keep their own pointer events, so
 * dragging from a node never starts a pan and clicking one still selects it.
 */
export function GraphCanvas({
  width,
  height,
  edges = [],
  children,
  legend,
  className,
  toolbar,
  ariaLabel = 'Pipeline graph',
}: GraphCanvasProps) {
  const [zoomIdx, setZoomIdx] = useState(DEFAULT_ZOOM_INDEX)
  const [full, setFull] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const zoom = ZOOM_STEPS[zoomIdx]

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [full])

  /** Scale the graph to fit the viewport, and centre it. */
  const fit = useCallback(() => {
    const el = viewportRef.current
    if (!el || !width || !height) return
    const pad = 32
    const sx = (el.clientWidth - pad * 2) / width
    const sy = (el.clientHeight - pad * 2) / height
    const target = Math.min(sx, sy, ZOOM_STEPS[ZOOM_STEPS.length - 1])
    // Snap to the nearest step at or below the ideal scale, so the zoom
    // readout stays one of the values the buttons can return to.
    let idx = 0
    for (let i = 0; i < ZOOM_STEPS.length; i++) if (ZOOM_STEPS[i] <= target) idx = i
    const z = ZOOM_STEPS[idx]
    setZoomIdx(idx)
    setPan({
      x: Math.max(pad, (el.clientWidth - width * z) / 2),
      y: Math.max(pad, (el.clientHeight - height * z) / 2),
    })
  }, [width, height])

  // Fit once the graph has a size, and again whenever it changes shape.
  useEffect(() => {
    const t = setTimeout(fit, 0)
    return () => clearTimeout(t)
  }, [fit])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only the background pans; a node handles its own pointer events.
    if (e.target !== e.currentTarget) return
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    setPan({ x: d.panX + (e.clientX - d.x), y: d.panY + (e.clientY - d.y) })
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // pointer already gone
    }
  }

  const paths = useMemo(
    () =>
      edges.map((e, i) => {
        const mx = (e.from.x + e.to.x) / 2
        return {
          i,
          kind: e.kind,
          flowing: e.flowing,
          d: `M${e.from.x},${e.from.y} C${mx},${e.from.y} ${mx},${e.to.y} ${e.to.x},${e.to.y}`,
        }
      }),
    [edges],
  )

  return (
    <div
      className={cn(
        'relative flex flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised',
        full ? 'fixed inset-3 z-50 shadow-2xl' : className ?? 'h-[460px]',
      )}
    >
      {/* Canvas ground. */}
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 bg-surface-sunken/40 [--dot:rgb(100_116_139_/_0.35)] dark:[--dot:rgb(148_163_184_/_0.20)]'
        style={{
          backgroundImage: 'radial-gradient(circle, var(--dot) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      />

      {/* Viewport — drag the background to pan. */}
      <div
        ref={viewportRef}
        role='group'
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className='relative min-h-0 flex-1 cursor-grab touch-none active:cursor-grabbing'
      >
        <div
          className='absolute origin-top-left'
          style={{
            width,
            height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg
            className='pointer-events-none absolute inset-0 overflow-visible'
            width={width}
            height={height}
            aria-hidden
          >
            {/* Connectors are deliberately COLOURLESS. Status already reads from
                each node's glyph; painting it onto the wiring too turned the
                graph into a rainbow and made the edges compete with the nodes.
                `currentColor` keeps them theme-aware; a flowing edge is still
                distinguishable — by weight and motion, not by hue. */}
            {paths.map((p) => (
              <path
                key={p.i}
                d={p.d}
                fill='none'
                stroke='currentColor'
                className={cn('text-edge-strong', p.flowing && 'adhar-flow-dash')}
                strokeWidth={p.flowing ? 2.25 : 1.5}
                strokeOpacity={p.flowing ? 0.95 : 0.65}
                strokeLinecap='round'
                strokeDasharray={p.flowing ? '7 7' : undefined}
              />
            ))}
          </svg>
          {children}
        </div>
      </div>

      {/* Legend + canvas controls — one footer under the canvas rather than two
          floating overlays. Overlays sat on top of whichever node occupied a
          corner; a footer can never cover the graph and gives the controls a
          permanent, predictable home. */}
      {/* `relative` so the footer stacks above the positioned dotted ground. */}
      <div className='relative flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge-subtle bg-surface-raised px-3 py-1.5 text-[11px] text-content-muted'>
        {legend?.length ? (
          <>
            <span className='font-medium text-content-subtle'>Legend</span>
            {legend.map((l) => (
              <span key={l.label} className='inline-flex items-center gap-1.5'>
                <span className='h-2 w-2 rounded-full' style={{ background: statusHex(l.kind) }} />
                {l.label}
              </span>
            ))}
          </>
        ) : null}
        <span className='ml-auto flex items-center gap-2'>
          {full ? <span className='hidden text-content-subtle sm:inline'>Esc to exit</span> : null}
          <span className='flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-sunken/60 p-0.5'>
            {toolbar}
            {toolbar ? <span className='mx-0.5 h-4 w-px bg-edge-subtle' /> : null}
            <CanvasBtn label='Zoom out' disabled={zoomIdx === 0} onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}>
              −
            </CanvasBtn>
            <button
              type='button'
              onClick={fit}
              title='Fit to view'
              className='w-10 text-center text-[10px] font-semibold tabular-nums text-content-muted hover:text-content'
            >
              {Math.round(zoom * 100)}%
            </button>
            <CanvasBtn
              label='Zoom in'
              disabled={zoomIdx === ZOOM_STEPS.length - 1}
              onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
            >
              +
            </CanvasBtn>
            <span className='mx-0.5 h-4 w-px bg-edge-subtle' />
            <CanvasBtn label='Fit to view' onClick={fit}>
              ⊡
            </CanvasBtn>
            <CanvasBtn label={full ? 'Exit full page (Esc)' : 'Full page'} onClick={() => setFull((f) => !f)}>
              {full ? '⤡' : '⤢'}
            </CanvasBtn>
          </span>
        </span>
      </div>

      <style>
        {`
        @keyframes adhar-flow-dash { to { stroke-dashoffset: -28; } }
        .adhar-flow-dash { animation: adhar-flow-dash 1s linear infinite; }
        @keyframes adhar-node-in {
          from { opacity: 0; transform: translateY(6px) scale(.97); }
          to   { opacity: 1; transform: none; }
        }
        .adhar-node-in { animation: adhar-node-in .3s cubic-bezier(.2,.7,.3,1) backwards; }
        @media (prefers-reduced-motion: reduce) {
          .adhar-flow-dash, .adhar-node-in { animation: none !important; }
        }
      `}
      </style>
    </div>
  )
}

export function CanvasBtn({
  label,
  onClick,
  disabled = false,
  active = false,
  children,
}: {
  label: string
  onClick(): void
  disabled?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded text-[12px] font-semibold transition-colors disabled:opacity-30',
        active
          ? 'bg-brand-500/15 text-brand-700 dark:text-brand-300'
          : 'text-content-muted hover:bg-surface-sunken hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ─────────── layered layout ─────────── */

export interface LayoutNode {
  id: string
  /** Column index — 0 is the leftmost stage. */
  level: number
}

export interface Placed {
  x: number
  y: number
}

export interface LayoutResult {
  pos: Map<string, Placed>
  width: number
  height: number
  nodeWidth: number
  nodeHeight: number
}

/**
 * Place levelled nodes into columns, each column vertically centred against the
 * tallest one. Deliberately simple: these graphs are shallow promotion chains
 * and value streams, not arbitrary DAGs needing crossing minimisation.
 */
export function layoutLayers(
  nodes: LayoutNode[],
  opts: { nodeWidth?: number; nodeHeight?: number; colGap?: number; rowGap?: number } = {},
): LayoutResult {
  const NW = opts.nodeWidth ?? 220
  const NH = opts.nodeHeight ?? 96
  const CX = opts.colGap ?? 84
  const RY = opts.rowGap ?? 24

  const columns = new Map<number, LayoutNode[]>()
  for (const n of nodes) {
    const list = columns.get(n.level) ?? []
    list.push(n)
    columns.set(n.level, list)
  }
  const levels = [...columns.keys()].sort((a, b) => a - b)
  const maxRows = Math.max(1, ...levels.map((l) => columns.get(l)!.length))
  const totalH = maxRows * NH + (maxRows - 1) * RY

  const pos = new Map<string, Placed>()
  levels.forEach((level, col) => {
    const list = columns.get(level)!
    const colH = list.length * NH + (list.length - 1) * RY
    const top = (totalH - colH) / 2
    list.forEach((n, row) => {
      pos.set(n.id, { x: col * (NW + CX), y: top + row * (NH + RY) })
    })
  })

  return {
    pos,
    width: Math.max(NW, levels.length * NW + Math.max(0, levels.length - 1) * CX),
    height: Math.max(NH, totalH),
    nodeWidth: NW,
    nodeHeight: NH,
  }
}

/** Edge anchor points between two placed nodes, right edge to left edge. */
export function edgeBetween(a: Placed, b: Placed, nodeWidth: number, nodeHeight: number) {
  return {
    from: { x: a.x + nodeWidth, y: a.y + nodeHeight / 2 },
    to: { x: b.x, y: b.y + nodeHeight / 2 },
  }
}
