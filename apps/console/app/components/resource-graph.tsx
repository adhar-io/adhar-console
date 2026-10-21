import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DrawerWidenButton, type StatusKind, useDrawerWidth, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { IconBtn } from './code-viewer.tsx'
import {
  age,
  compareNodes,
  type CompNode,
  type CompositionGraph,
  type Condition,
  type HealthLevel,
  isUnhealthy,
  kindAbbr,
  kindFamily,
  type KindFamily,
  layoutTree,
  pathToRoot,
  rollup,
  type SortKey,
  stackSiblings,
  treeRows,
} from '~/data/catalog-composition-model.ts'

/**
 * The resource-graph surface shared by the catalog drawer's Composition and
 * Resources tabs: kind badges, status pills, node cards, the pannable and
 * zoomable graph canvas, the tree-table, the conditions table and the
 * slide-over detail panel.
 */

export const LEVEL_KIND: Record<HealthLevel, StatusKind> = {
  healthy: 'healthy',
  progressing: 'progressing',
  degraded: 'degraded',
  suspended: 'info',
  missing: 'paused',
  unknown: 'unknown',
  none: 'unknown',
}

export const LEVEL_DOT: Record<HealthLevel, string> = {
  healthy: 'bg-emerald-500',
  progressing: 'bg-indigo-500',
  degraded: 'bg-rose-500',
  suspended: 'bg-sky-500',
  missing: 'bg-amber-500',
  unknown: 'bg-content-subtle',
  none: 'bg-edge-strong',
}

const FAMILY_TONE: Record<KindFamily, string> = {
  gitops: 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/25',
  composite: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/25',
  workload: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/25',
  network: 'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-500/10 dark:text-teal-300 dark:ring-teal-400/25',
  config: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
  storage: 'bg-lime-50 text-lime-800 ring-lime-200 dark:bg-lime-500/10 dark:text-lime-300 dark:ring-lime-400/25',
  // The slate ramp is re-mapped in dark mode; the semantic tokens read right in both.
  rbac: 'bg-surface-sunken text-content-muted ring-edge-default',
  other: 'bg-surface-sunken text-content-muted ring-edge-default',
}

/* ───────────────────────── status: icon + label ───────────────────────── */

const PILL_TONE: Record<HealthLevel, string> = {
  healthy: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
  progressing: 'bg-indigo-50 text-indigo-700 ring-indigo-600/15 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20',
  degraded: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25',
  suspended: 'bg-sky-50 text-sky-700 ring-sky-600/15 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20',
  missing: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
  unknown: 'bg-surface-sunken text-content-muted ring-edge-default',
  none: 'bg-surface-sunken text-content-muted ring-edge-default',
}

type Glyph = 'check' | 'spin' | 'x' | 'pause' | 'question' | 'lock' | 'dot'

function glyphFor(level: HealthLevel, label: string): Glyph {
  if (/no access|forbidden/i.test(label)) return 'lock'
  switch (level) {
    case 'healthy':
      return 'check'
    case 'progressing':
      return 'spin'
    case 'degraded':
      return 'x'
    case 'suspended':
      return 'pause'
    case 'missing':
      return 'question'
    default:
      return 'dot'
  }
}

export function StatusIcon({ glyph, className }: { glyph: Glyph; className?: string }) {
  const c = cn('h-3 w-3 shrink-0', glyph === 'spin' && 'animate-spin [animation-duration:2s]', className)
  switch (glyph) {
    case 'check':
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><circle cx="8" cy="8" r="7" className="fill-current opacity-20" /><path d="M4.5 8.2l2.2 2.2 4.8-4.8" className="fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    case 'spin':
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><circle cx="8" cy="8" r="6" className="fill-none stroke-current opacity-25" strokeWidth="2" /><path d="M8 2a6 6 0 0 1 6 6" className="fill-none stroke-current" strokeWidth="2" strokeLinecap="round" /></svg>
    case 'x':
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><circle cx="8" cy="8" r="7" className="fill-current opacity-20" /><path d="M5.5 5.5l5 5m0-5l-5 5" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" /></svg>
    case 'pause':
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><circle cx="8" cy="8" r="7" className="fill-current opacity-20" /><path d="M6.3 5v6M9.7 5v6" className="stroke-current" strokeWidth="1.8" strokeLinecap="round" /></svg>
    case 'question':
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><circle cx="8" cy="8" r="7" className="fill-current opacity-20" /><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.3" className="fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" /><circle cx="8" cy="11.6" r="0.9" className="fill-current" /></svg>
    case 'lock':
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" className="fill-current opacity-25" /><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" className="fill-none stroke-current" strokeWidth="1.6" /></svg>
    default:
      return <svg viewBox="0 0 16 16" className={c} aria-hidden><circle cx="8" cy="8" r="3" className="fill-current" /></svg>
  }
}

/** Status as a small pill: icon + label, so it reads without colour. */
export function StatusPill({ level, label, title, className }: { level: HealthLevel; label: string; title?: string; className?: string }) {
  return (
    <span
      title={title ?? label}
      className={cn('inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium ring-1 ring-inset', PILL_TONE[level], className)}
    >
      <StatusIcon glyph={glyphFor(level, label)} />
      <span className="truncate leading-4">{label}</span>
    </span>
  )
}

/** Compact health for dense rows (kept for the Resources tab's list). */
export function HealthMark({ level, label }: { level: HealthLevel; label: string }) {
  return <StatusPill level={level} label={label} />
}

export function SyncMark({ sync, prune, compact }: { sync?: string; prune?: boolean; compact?: boolean }) {
  if (prune) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-rose-700 dark:text-rose-300" title="No longer in Git — Argo CD would prune it">
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden><circle cx="4.5" cy="11.5" r="2" className="fill-none stroke-current" strokeWidth="1.5" /><circle cx="11.5" cy="11.5" r="2" className="fill-none stroke-current" strokeWidth="1.5" /><path d="M5.8 10L12 3M10.2 10L4 3" className="stroke-current" strokeWidth="1.5" strokeLinecap="round" /></svg>
        {compact ? null : 'prune'}
      </span>
    )
  }
  if (!sync) return null
  if (sync === 'Synced') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300" title="Synced with Git">
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden><path d="M13 5.5A5.5 5.5 0 0 0 3.2 4.6M3 10.5a5.5 5.5 0 0 0 9.8.9" className="fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" /><path d="M3 2v3h3" className="fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.2 8.2l1.3 1.3 2.5-2.6" className="fill-none stroke-current" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {compact ? null : 'Synced'}
      </span>
    )
  }
  if (sync === 'OutOfSync') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300" title="Out of sync with Git">
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden><path d="M13 5.5A5.5 5.5 0 0 0 3.2 4.6M3 10.5a5.5 5.5 0 0 0 9.8.9" className="fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" /><path d="M3 2v3h3M13 14v-3h-3" className="fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {compact ? null : 'OutOfSync'}
      </span>
    )
  }
  return <span className="text-content-muted" title={sync}>{sync}</span>
}

export function KindIcon({ node, className }: { node: Pick<CompNode, 'group' | 'kind' | 'source'>; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[9.5px] font-semibold uppercase tracking-tight ring-1 ring-inset', FAMILY_TONE[kindFamily(node)], className)}
      aria-hidden
    >
      {kindAbbr(node.kind)}
    </span>
  )
}

/* ───────────────────────── node card ───────────────────────── */

export const CARD_W = 252

export function NodeCard({ node, selected, highlighted, onClick, now, rolled, extra, onFocusNode }: {
  node: CompNode
  selected: boolean
  /** On the hovered/selected node's path to the root. */
  highlighted?: boolean
  onClick(): void
  now: number
  rolled?: HealthLevel
  /** An extra line under the status (replicas, image tag…). */
  extra?: ReactNode
  onFocusNode?(): void
}) {
  const stack = node.stack
  const message = [node.status.reason, node.status.message].filter(Boolean).join(': ')
  return (
    <button
      type="button"
      data-node-id={node.id}
      onClick={onClick}
      onFocus={onFocusNode}
      title={message ? `${node.kind} ${node.name}\n${message}` : `${node.kind} ${node.name}`}
      className={cn(
        'group/card relative flex h-full w-full flex-col justify-center gap-1 rounded-xl border bg-surface-raised px-2.5 text-left transition-[box-shadow,transform,border-color] duration-150',
        'shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:-translate-y-px hover:shadow-[0_6px_16px_-6px_rgba(15,23,42,0.25)] dark:shadow-none dark:hover:shadow-[0_6px_16px_-6px_rgba(0,0,0,0.6)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-canvas',
        selected ? 'border-brand-500 ring-2 ring-brand-500/25' : highlighted ? 'border-brand-300 dark:border-brand-400/50' : 'border-edge-default',
        stack && 'shadow-[3px_3px_0_-1px_var(--color-surface-raised),3px_3px_0_0_var(--color-edge-default),6px_6px_0_-1px_var(--color-surface-raised),6px_6px_0_0_var(--color-edge-default)]',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <KindIcon node={node} className="h-7 w-7" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12px] font-semibold leading-4 text-content">{node.name}</span>
          <span className="block truncate text-[11px] leading-4 text-content-subtle">
            {stack ? `${stack.kind} · click to expand` : node.kind}
            {node.namespace ? ` · ${node.namespace}` : ''}
          </span>
        </span>
        <span className="shrink-0 self-start pt-0.5 text-[10.5px] tabular-nums text-content-subtle">{age(node.createdAt, now)}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-9">
        {stack ? (
          <span className="flex items-center gap-1.5 text-[11px] text-content-muted">
            {(Object.entries(stack.byLevel) as Array<[HealthLevel, number]>).sort((a, b) => LEVEL_ORDER.indexOf(a[0]) - LEVEL_ORDER.indexOf(b[0])).map(([l, n]) => (
              <span key={l} className="inline-flex items-center gap-1" title={`${n} ${l}`}>
                <span className={cn('h-1.5 w-1.5 rounded-full', LEVEL_DOT[l])} aria-hidden />
                {n}
              </span>
            ))}
          </span>
        ) : (
          <StatusPill level={node.status.level} label={node.status.label} title={message || node.status.label} className="max-w-[9.5rem]" />
        )}
        <SyncMark sync={node.status.sync} prune={node.status.prune} compact />
        {rolled && rolled !== node.status.level && isUnhealthy(rolled) ? (
          <span className={cn('ml-auto h-2 w-2 shrink-0 rounded-full ring-2 ring-surface-raised', LEVEL_DOT[rolled])} title={`Something below is ${rolled}`} />
        ) : null}
      </span>
      {extra ? <span className="block truncate pl-9 text-[11px] text-content-subtle">{extra}</span> : null}
    </button>
  )
}

const LEVEL_ORDER: HealthLevel[] = ['degraded', 'missing', 'progressing', 'suspended', 'unknown', 'healthy', 'none']

/* ───────────────────────── graph canvas ───────────────────────── */

const COL_GAP = 64
const ROW_GAP = 14
const PAD = 28
const MIN_K = 0.3
const MAX_K = 1.6

/* ─────────────── shared canvas chrome: full screen, legend ─────────────── */

/**
 * Full screen for a canvas: the browser's Fullscreen API when it is allowed,
 * else an in-page overlay (the console can be embedded where the API is
 * blocked). `F` toggles it while the canvas has focus; Esc leaves either kind.
 */
export function useCanvasFullscreen() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [native, setNative] = useState(false)
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    const on = () => setNative(Boolean(document.fullscreenElement && document.fullscreenElement === ref.current))
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  useEffect(() => {
    if (!overlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverlay(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [overlay])
  const toggle = useCallback(() => {
    const el = ref.current
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    if (overlay) {
      setOverlay(false)
      return
    }
    if (el?.requestFullscreen) {
      el.requestFullscreen().catch(() => setOverlay(true))
    } else {
      setOverlay(true)
    }
  }, [overlay])
  const full = native || overlay
  return {
    ref,
    full,
    toggle,
    /** Classes for the canvas container while it is full screen. */
    frameClass: overlay ? 'fixed inset-0 z-[60] rounded-none' : native ? 'rounded-none' : '',
  }
}

export function FullscreenGlyph({ full }: { full: boolean }) {
  return full
    ? <path d="M9 4H7v3H4v2h5V4zm6 0h-2v5h5V7h-3V4zM4 15v2h3v3h2v-5H4zm11 0v5h2v-3h3v-2h-5z" />
    : <path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z" />
}

const LEGEND_LEVELS: Array<[HealthLevel, string]> = [
  ['healthy', 'Healthy'],
  ['progressing', 'Progressing'],
  ['degraded', 'Degraded'],
  ['missing', 'Missing'],
  ['suspended', 'Suspended'],
  ['unknown', 'Unknown'],
]

/**
 * The always-visible key: what the status colours and the two connector
 * styles mean. The detailed legend (sync marks, gestures) stays one click away.
 */
export function LegendStrip({ edges = true, className }: { edges?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-content-muted', className)} aria-label="Legend">
      {LEGEND_LEVELS.map(([l, t]) => (
        <span key={l} className="inline-flex items-center gap-1">
          <span className={cn('h-2 w-2 rounded-full', LEVEL_DOT[l])} aria-hidden />
          {t}
        </span>
      ))}
      {edges
        ? (
          <>
            <span className="mx-0.5 h-3 w-px bg-edge-default" aria-hidden />
            <span className="inline-flex items-center gap-1">
              <svg width="18" height="6" aria-hidden><path d="M0 3h18" stroke="var(--color-edge-strong)" strokeWidth="1.5" /></svg>
              owns
            </span>
            <span className="inline-flex items-center gap-1">
              <svg width="18" height="6" aria-hidden><path d="M0 3h18" stroke="var(--color-edge-strong)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
              related
            </span>
            <span className="inline-flex items-center gap-1">
              <svg width="18" height="6" aria-hidden><path d="M0 3h18" stroke="var(--color-brand-500)" strokeWidth="2" /></svg>
              path to selection
            </span>
          </>
        )
        : null}
    </div>
  )
}

export interface GraphViewProps {
  graph: CompositionGraph
  visible?: Set<string>
  collapsed: ReadonlySet<string>
  onToggle(id: string): void
  selected: string | null
  onSelect(id: string): void
  now: number
  ariaLabel: string
  /** Extra card line per node; cards grow to fit one when given. */
  cardExtra?(node: CompNode): ReactNode
  /** Changing it re-fits the view (pass the filter state). */
  fitKey?: string
  /** Same-kind siblings at or above this count fold into a stack. */
  stackThreshold?: number
  /** Expand / collapse every subtree (toolbar buttons appear when given). */
  onExpandAll?(): void
  onCollapseAll?(): void
}

interface View {
  x: number
  y: number
  k: number
}

/**
 * The graph canvas: a layered left-to-right layout of fixed-width cards with
 * rounded orthogonal connectors. Drag to pan, scroll to pan, ⌘/Ctrl+scroll
 * to zoom; the toolbar zooms, fits and resets. It fits on first render and
 * whenever `fitKey` changes. The hovered or selected node lights its path to
 * the root. Arrow keys move between cards (→ child, ← parent, ↑↓ siblings in
 * the column). Wide fan-outs of one kind fold into stacks.
 */
export function GraphView({ graph, visible, collapsed, onToggle, selected, onSelect, now, ariaLabel, cardExtra, fitKey = '', stackThreshold = 6, onExpandAll, onCollapseAll }: GraphViewProps) {
  const fs = useCanvasFullscreen()
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => new Set())
  const display = useMemo(() => stackSiblings(graph, visible, { threshold: stackThreshold, expanded: expandedStacks }), [graph, visible, stackThreshold, expandedStacks])
  const g = display.graph
  const H = cardExtra ? 82 : 66
  const layout = useMemo(() => layoutTree(g, display.visible, collapsed), [g, display.visible, collapsed])
  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout])
  const width = Math.max(1, layout.cols) * (CARD_W + COL_GAP) - COL_GAP + PAD * 2
  const height = Math.max(1, layout.rows) * (H + ROW_GAP) - ROW_GAP + PAD * 2
  const xy = useCallback((id: string) => {
    const p = pos.get(id)!
    return { x: PAD + p.col * (CARD_W + COL_GAP), y: PAD + p.row * (H + ROW_GAP) }
  }, [pos, H])

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [vp, setVp] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [hovered, setHovered] = useState<string | null>(null)
  const [legend, setLegend] = useState(false)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setVp({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!vp.w || !vp.h) return
    const k = Math.min(1, Math.max(0.5, Math.min(vp.w / width, vp.h / height)))
    const root = layout.nodes.find((n) => g.roots.includes(n.id))
    const rootY = root ? PAD + root.row * (H + ROW_GAP) + H / 2 : height / 2
    const x = width * k <= vp.w ? (vp.w - width * k) / 2 : 12
    // Centre on the root when the whole tree does not fit vertically.
    const y = height * k <= vp.h ? (vp.h - height * k) / 2 : Math.min(12, Math.max(vp.h - height * k - 12, vp.h / 2 - rootY * k))
    setView({ x, y, k })
  }, [vp.w, vp.h, width, height, layout.nodes, g.roots, H])

  // Fit on first measure and when the caller's fit key (filters) changes.
  const fittedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!vp.w) return
    const key = `${fitKey}`
    if (fittedFor.current === key) return
    fittedFor.current = key
    fit()
  }, [fit, fitKey, vp.w])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor))
      const px = cx ?? vp.w / 2
      const py = cy ?? vp.h / 2
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
    })
  }, [vp.w, vp.h])

  // Wheel: pan, or zoom with ⌘/Ctrl (and trackpad pinch, which arrives as ctrl+wheel).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Drag to pan (from the background, not from a card).
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button,a,[role=dialog]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) > 3) {
      d.moved = true
      setDragging(true)
    }
    if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const endDrag = () => {
    drag.current = null
    setDragging(false)
  }

  const focusId = hovered ?? selected
  const lit = useMemo(() => (focusId && g.nodes[focusId] ? pathToRoot(g, focusId) : new Set<string>()), [g, focusId])

  // Keep a card in view (keyboard navigation).
  const reveal = useCallback((id: string) => {
    if (!pos.has(id)) return
    const { x, y } = xy(id)
    setView((v) => {
      const sx = v.x + x * v.k
      const sy = v.y + y * v.k
      let nx = v.x
      let ny = v.y
      if (sx < 8) nx += 8 - sx
      if (sx + CARD_W * v.k > vp.w - 8) nx -= sx + CARD_W * v.k - (vp.w - 8)
      if (sy < 8) ny += 8 - sy
      if (sy + H * v.k > vp.h - 8) ny -= sy + H * v.k - (vp.h - 8)
      return nx === v.x && ny === v.y ? v : { ...v, x: nx, y: ny }
    })
  }, [pos, xy, vp.w, vp.h, H])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const from = (e.target as HTMLElement).closest('[data-node-id]')?.getAttribute('data-node-id')
    if (!from || !pos.has(from)) {
      if (e.key === '+' || e.key === '=') zoomAt(1.2)
      else if (e.key === '-') zoomAt(1 / 1.2)
      else if (e.key === '0') fit()
      else if (e.key === 'f' || e.key === 'F') fs.toggle()
      return
    }
    const here = pos.get(from)!
    let to: string | undefined
    if (e.key === 'ArrowRight') to = g.nodes[from].children.find((c) => pos.has(c))
    else if (e.key === 'ArrowLeft') to = g.nodes[from].parents.find((p) => pos.has(p))
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const down = e.key === 'ArrowDown'
      const same = layout.nodes.filter((n) => n.col === here.col && (down ? n.row > here.row : n.row < here.row))
      same.sort((a, b) => (down ? a.row - b.row : b.row - a.row))
      to = same[0]?.id
    }
    if (!to) return
    e.preventDefault()
    reveal(to)
    viewportRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(to)}"]`)?.focus({ preventScroll: true })
  }

  const edgePath = (from: string, to: string) => {
    const a = xy(from)
    const b = xy(to)
    const x1 = a.x + CARD_W
    const y1 = a.y + H / 2
    const x2 = b.x
    const y2 = b.y + H / 2
    const mx = x1 + COL_GAP / 2
    if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} H${x2}`
    const r = Math.min(10, Math.abs(y2 - y1) / 2)
    const s = y2 > y1 ? 1 : -1
    return `M${x1},${y1} H${mx - r} Q${mx},${y1} ${mx},${y1 + s * r} V${y2 - s * r} Q${mx},${y2} ${mx + r},${y2} H${x2}`
  }

  const zoomPct = Math.round(view.k * 100)

  return (
    <div
      ref={fs.ref}
      className={cn('relative overflow-hidden rounded-xl border border-edge-default bg-surface-sunken/60', fs.full && 'bg-surface-canvas', fs.frameClass)}
      style={fs.full ? { height: '100vh', width: '100vw' } : { height: 'min(68vh, 680px)', minHeight: 320 }}
    >
      {/* dot grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60 dark:opacity-40"
        style={{
          backgroundImage: 'radial-gradient(var(--color-edge-default) 1px, transparent 1px)',
          backgroundSize: `${18 * view.k}px ${18 * view.k}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        aria-hidden
      />
      <div
        ref={viewportRef}
        role="tree"
        aria-label={ariaLabel}
        className={cn('absolute inset-0 touch-none select-none outline-none', dragging ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height} aria-hidden>
            {layout.edges.map((e) => {
              const on = lit.has(e.from) && lit.has(e.to)
              return (
                <path
                  key={`${e.from}>${e.to}`}
                  d={edgePath(e.from, e.to)}
                  fill="none"
                  stroke={on ? 'var(--color-brand-500)' : 'var(--color-edge-strong)'}
                  strokeOpacity={on ? 0.95 : 0.9}
                  strokeWidth={on ? 2 : 1.25}
                  strokeDasharray={e.extra ? '4 4' : undefined}
                />
              )
            })}
            {layout.edges.map((e) => {
              const b = xy(e.to)
              const on = lit.has(e.from) && lit.has(e.to)
              return <circle key={`dot-${e.from}>${e.to}`} cx={b.x} cy={b.y + H / 2} r={on ? 3 : 2.25} fill={on ? 'var(--color-brand-500)' : 'var(--color-edge-strong)'} />
            })}
          </svg>
          {layout.nodes.map((ln) => {
            const n = g.nodes[ln.id]
            const { x, y } = xy(ln.id)
            const kids = n.children.filter((c) => !display.visible || display.visible.has(c))
            const isCollapsed = collapsed.has(n.id) && kids.length > 0
            const rolled = isCollapsed ? rollup(g, n.id) : undefined
            return (
              <div
                key={n.id}
                className="absolute"
                style={{ left: x, top: y, width: CARD_W, height: H }}
                role="treeitem"
                aria-selected={selected === n.id}
                aria-expanded={kids.length ? !isCollapsed : undefined}
                onPointerEnter={() => setHovered(n.id)}
                onPointerLeave={() => setHovered((h) => (h === n.id ? null : h))}
              >
                <NodeCard
                  node={n}
                  selected={selected === n.id}
                  highlighted={lit.has(n.id) && selected !== n.id}
                  onClick={() => {
                    if (n.stack) {
                      setExpandedStacks((s) => new Set(s).add(n.id))
                      return
                    }
                    onSelect(n.id)
                  }}
                  onFocusNode={() => reveal(n.id)}
                  now={now}
                  rolled={rolled}
                  extra={n.stack ? undefined : cardExtra?.(n)}
                />
                {kids.length ? (
                  <button
                    type="button"
                    onClick={() => onToggle(n.id)}
                    title={isCollapsed ? `Show ${kids.length} hidden` : 'Collapse this subtree'}
                    aria-label={isCollapsed ? `Expand ${n.name} (${kids.length})` : `Collapse ${n.name}`}
                    className={cn(
                      'absolute -right-3 top-1/2 z-10 flex h-6 min-w-6 -translate-y-1/2 items-center justify-center gap-1 rounded-full border bg-surface-raised px-1.5 text-[10px] font-semibold shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                      isCollapsed ? 'border-brand-300 text-brand-700 dark:border-brand-400/50 dark:text-brand-300' : 'border-edge-default text-content-subtle hover:text-content',
                    )}
                  >
                    {isCollapsed ? (
                      <>
                        {rolled && isUnhealthy(rolled) ? <span className={cn('h-1.5 w-1.5 rounded-full', LEVEL_DOT[rolled])} aria-hidden /> : null}
                        {kids.length}
                      </>
                    ) : (
                      <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden><path d="M2.5 6h7" className="stroke-current" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    )}
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {/* controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised/95 p-0.5 shadow-sm backdrop-blur">
        <IconBtn label="Zoom out (−)" onClick={() => zoomAt(1 / 1.2)}>
          <path d="M5 11h14v2H5z" />
        </IconBtn>
        <button type="button" onClick={() => setView((v) => ({ ...v, k: 1 }))} title="Reset to 100%" className="min-w-11 rounded px-1 text-center text-[11px] tabular-nums text-content-muted hover:bg-surface-sunken hover:text-content">
          {zoomPct}%
        </button>
        <IconBtn label="Zoom in (+)" onClick={() => zoomAt(1.2)}>
          <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
        </IconBtn>
        <input
          type="range"
          aria-label="Zoom"
          min={Math.round(MIN_K * 100)}
          max={Math.round(MAX_K * 100)}
          step={5}
          value={zoomPct}
          onChange={(e) => zoomAt(Number(e.target.value) / 100 / view.k)}
          className="mx-1 hidden h-1 w-20 cursor-pointer accent-brand-600 sm:block"
        />
        <span className="mx-0.5 h-4 w-px bg-edge-default" aria-hidden />
        <IconBtn label="Fit to view (0)" onClick={fit}>
          <path d="M3 5h4V3H3a2 2 0 0 0-2 2v4h2V5zm18-2h-4v2h4v4h2V5a2 2 0 0 0-2-2zM3 15H1v4a2 2 0 0 0 2 2h4v-2H3v-4zm18 4h-4v2h4a2 2 0 0 0 2-2v-4h-2v4zM8 8h8v8H8z" />
        </IconBtn>
        <IconBtn label="Centre on the selected resource" onClick={() => selected && pos.has(selected) && (() => {
          const { x, y } = xy(selected)
          setView((v) => ({ ...v, x: vp.w / 2 - (x + CARD_W / 2) * v.k, y: vp.h / 2 - (y + H / 2) * v.k }))
        })()} disabled={!selected || !pos.has(selected)}>
          <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.07A7 7 0 0 0 13 5.07V3h-2v2.07A7 7 0 0 0 5.07 11H3v2h2.07A7 7 0 0 0 11 18.93V21h2v-2.07A7 7 0 0 0 18.93 13H21v-2zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" />
        </IconBtn>
        {onExpandAll ? (
          <IconBtn label="Expand all" onClick={onExpandAll}>
            <path d="M12 5.83 15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z" />
          </IconBtn>
        ) : null}
        {onCollapseAll ? (
          <IconBtn label="Collapse all" onClick={onCollapseAll}>
            <path d="M7.41 18.59 8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z" />
          </IconBtn>
        ) : null}
        <span className="mx-0.5 h-4 w-px bg-edge-default" aria-hidden />
        <IconBtn label={fs.full ? 'Exit full screen (F / Esc)' : 'Full screen (F)'} onClick={fs.toggle}>
          <FullscreenGlyph full={fs.full} />
        </IconBtn>
      </div>

      {/* the key, always visible */}
      <LegendStrip className="absolute left-3 top-3 max-w-[calc(100%-7rem)] rounded-lg border border-edge-default bg-surface-raised/95 px-2 py-1 shadow-sm backdrop-blur" />

      <div className="absolute right-3 top-3">
        <button
          type="button"
          onClick={() => setLegend((l) => !l)}
          aria-expanded={legend}
          className="rounded-lg border border-edge-default bg-surface-raised/95 px-2 py-1 text-[11px] font-medium text-content-muted shadow-sm backdrop-blur hover:text-content"
        >
          Legend
        </button>
        {legend ? (
          <div className="absolute right-0 top-8 z-20 w-56 rounded-lg border border-edge-default bg-surface-raised p-2.5 text-[11px] shadow-lg">
            <div className="mb-1.5 font-semibold text-content">Status</div>
            <ul className="space-y-1">
              {([
                ['healthy', 'Ready / Healthy'],
                ['progressing', 'Progressing / Creating'],
                ['degraded', 'Degraded / Failing'],
                ['missing', 'Missing'],
                ['suspended', 'Suspended / Paused'],
                ['unknown', 'Unknown / No access'],
              ] as Array<[HealthLevel, string]>).map(([l, t]) => <li key={l}><StatusPill level={l} label={t} /></li>)}
            </ul>
            <div className="mb-1 mt-2.5 font-semibold text-content">Argo CD sync</div>
            <div className="flex flex-wrap gap-3"><SyncMark sync="Synced" /><SyncMark sync="OutOfSync" /><SyncMark prune /></div>
            <p className="mt-2.5 text-content-subtle">Drag or scroll to pan · ⌘/Ctrl + scroll to zoom · arrow keys move between cards.</p>
          </div>
        ) : null}
      </div>

      <Minimap layout={layout} graph={g} width={width} height={height} H={H} view={view} vp={vp} onCenter={(cx, cy) => setView((v) => ({ ...v, x: vp.w / 2 - cx * v.k, y: vp.h / 2 - cy * v.k }))} />
    </div>
  )
}

function Minimap({ layout, graph, width, height, H, view, vp, onCenter }: {
  layout: ReturnType<typeof layoutTree>
  graph: CompositionGraph
  width: number
  height: number
  H: number
  view: View
  vp: { w: number; h: number }
  onCenter(x: number, y: number): void
}) {
  // Only worth it when the tree is bigger than the viewport.
  if (!vp.w || (width * view.k <= vp.w && height * view.k <= vp.h)) return null
  const MW = 140
  const s = MW / width
  const MH = Math.min(110, height * s)
  const sc = Math.min(s, MH / height)
  const fill: Record<HealthLevel, string> = {
    healthy: '#10b981',
    progressing: '#6366f1',
    degraded: '#f43f5e',
    suspended: '#0ea5e9',
    missing: '#f59e0b',
    unknown: 'var(--color-content-subtle)',
    none: 'var(--color-edge-strong)',
  }
  return (
    <svg
      width={width * sc}
      height={height * sc}
      className="absolute bottom-3 left-3 hidden cursor-pointer rounded-md border border-edge-default bg-surface-raised/90 shadow-sm backdrop-blur sm:block"
      onPointerDown={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
        onCenter((e.clientX - r.left) / sc, (e.clientY - r.top) / sc)
      }}
      aria-label="Minimap — click to move there"
    >
      {layout.nodes.map((n) => (
        <rect
          key={n.id}
          x={(PAD + n.col * (CARD_W + COL_GAP)) * sc}
          y={(PAD + n.row * (H + ROW_GAP)) * sc}
          width={CARD_W * sc}
          height={Math.max(2, H * sc)}
          rx={1.5}
          fill={fill[graph.nodes[n.id]?.status.level ?? 'none']}
          opacity={0.75}
        />
      ))}
      <rect x={(-view.x / view.k) * sc} y={(-view.y / view.k) * sc} width={(vp.w / view.k) * sc} height={(vp.h / view.k) * sc} fill="none" stroke="var(--color-brand-500)" strokeWidth={1.25} rx={2} />
    </svg>
  )
}

/* ───────────────────────── tree-table ───────────────────────── */

const SORTABLE: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind', className: 'hidden md:table-cell' },
  { key: 'status', label: 'Status' },
  { key: 'sync', label: 'Sync', className: 'hidden lg:table-cell' },
]

/**
 * The list view: an indented tree-table with guide lines, expand/collapse
 * chevrons, sortable columns (siblings sort within their parent) and a sticky
 * header. ↑/↓ move, →/← expand/collapse, Enter opens. On a phone it folds to
 * name + status with kind, namespace, age and message on a second line.
 */
export function TreeTable({ graph, visible, collapsed, onToggle, selected, onSelect, now, ariaLabel, onExpandAll, onCollapseAll }: {
  graph: CompositionGraph
  visible?: Set<string>
  collapsed: ReadonlySet<string>
  onToggle(id: string): void
  selected: string | null
  onSelect(id: string): void
  now: number
  ariaLabel: string
  onExpandAll?(): void
  onCollapseAll?(): void
}) {
  const fs = useCanvasFullscreen()
  const [compact, setCompact] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null)
  const rows = useMemo(() => treeRows(graph, visible, collapsed, sort ? compareNodes(sort.key, sort.dir) : undefined), [graph, visible, collapsed, sort])
  const [cursor, setCursor] = useState<string | null>(null)
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)

  useEffect(() => {
    if (!cursor) return
    bodyRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return
    const i = Math.max(0, rows.findIndex((r) => r.node.id === (cursor ?? selected)))
    const row = rows[i]
    if (e.key === 'ArrowDown') setCursor(rows[Math.min(rows.length - 1, i + (cursor ? 1 : 0))].node.id)
    else if (e.key === 'ArrowUp') setCursor(rows[Math.max(0, i - 1)].node.id)
    else if (e.key === 'ArrowRight' && row.hasChildren && collapsed.has(row.node.id)) onToggle(row.node.id)
    else if (e.key === 'ArrowLeft' && row.hasChildren && !collapsed.has(row.node.id)) onToggle(row.node.id)
    else if (e.key === 'Enter' || e.key === ' ') onSelect(row.node.id)
    else if (e.key === 'f' || e.key === 'F') fs.toggle()
    else return
    e.preventDefault()
  }

  const header = (key: SortKey, label: string, className?: string) => {
    const active = sort?.key === key
    return (
      <th key={key} className={cn('px-3 py-2 font-medium', className)} aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          onClick={() => setSort((s) => (s?.key === key ? (s.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }))}
          className={cn('inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', active && 'text-content')}
        >
          {label}
          <svg viewBox="0 0 12 12" className={cn('h-2.5 w-2.5 transition-transform', !active && 'opacity-30', active && sort!.dir === -1 && 'rotate-180')} aria-hidden>
            <path d="M3 7.5L6 4.5l3 3" className="fill-none stroke-current" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </th>
    )
  }

  return (
    <div
      ref={fs.ref}
      className={cn('flex flex-col overflow-hidden rounded-xl border border-edge-default bg-surface-raised', fs.full && 'h-screen w-screen', fs.frameClass)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-edge-default bg-surface-sunken/60 px-2 py-1">
        <span className="text-[11px] tabular-nums text-content-muted">
          {rows.length} resource{rows.length === 1 ? '' : 's'} shown
        </span>
        <div className="flex items-center gap-0.5">
          {onExpandAll ? (
            <IconBtn label="Expand all" onClick={onExpandAll}>
              <path d="M12 5.83 15.17 9l1.41-1.41L12 3 7.41 7.59 8.83 9 12 5.83zm0 12.34L8.83 15l-1.41 1.41L12 21l4.59-4.59L15.17 15 12 18.17z" />
            </IconBtn>
          ) : null}
          {onCollapseAll ? (
            <IconBtn label="Collapse all" onClick={onCollapseAll}>
              <path d="M7.41 18.59 8.83 20 12 16.83 15.17 20l1.41-1.41L12 14l-4.59 4.59zm9.18-13.18L15.17 4 12 7.17 8.83 4 7.41 5.41 12 10l4.59-4.59z" />
            </IconBtn>
          ) : null}
          <IconBtn label={compact ? 'Comfortable rows' : 'Compact rows'} onClick={() => setCompact((c) => !c)}>
            {compact
              ? <path d="M3 5h18v3H3zm0 5.5h18v3H3zM3 16h18v3H3z" />
              : <path d="M3 4h18v2H3zm0 4h18v2H3zm0 4h18v2H3zm0 4h18v2H3zm0 4h18v2H3z" />}
          </IconBtn>
          <span className="mx-0.5 h-4 w-px bg-edge-default" aria-hidden />
          <IconBtn label={fs.full ? 'Exit full screen (F / Esc)' : 'Full screen (F)'} onClick={fs.toggle}>
            <FullscreenGlyph full={fs.full} />
          </IconBtn>
        </div>
      </div>
    <div
      className={cn(
        'overflow-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
        fs.full ? 'min-h-0 flex-1' : 'max-h-[64vh]',
        compact && '[&_td]:py-0.5!',
      )}
      tabIndex={0}
      role="treegrid"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      <table className="w-full border-separate border-spacing-0 text-left text-xs">
        <thead className="sticky top-0 z-10 bg-surface-sunken text-[10.5px] text-content-subtle">
          <tr className="[&>th]:border-b [&>th]:border-edge-default">
            {SORTABLE.map((c) => header(c.key, c.label, c.className))}
            <th className="hidden px-3 py-2 font-medium uppercase tracking-wide sm:table-cell">Message</th>
            {header('age', 'Age', 'text-right')}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {rows.map(({ node: n, depth, hasChildren, guides, last }) => {
            const isCollapsed = collapsed.has(n.id)
            const message = [n.status.reason, n.status.message].filter(Boolean).join(': ')
            const active = cursor === n.id
            return (
              <tr
                key={n.id}
                data-row-id={n.id}
                onClick={() => {
                  setCursor(n.id)
                  onSelect(n.id)
                }}
                aria-selected={selected === n.id}
                className={cn(
                  'cursor-pointer [&>td]:border-b [&>td]:border-edge-subtle',
                  selected === n.id ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-surface-sunken/70',
                  active && 'outline outline-2 -outline-offset-2 outline-brand-500/60',
                )}
              >
                <td className="py-1.5 pl-2 pr-3">
                  <div className="flex min-w-0 items-center">
                    {/* Guide lines: one 20px column per ancestor level, the line on the parent's chevron axis. */}
                    {guides.slice(1).map((g, i) => (
                      <span key={i} className="relative w-5 shrink-0 self-stretch" aria-hidden>
                        {g ? <span className="absolute -bottom-1.5 -top-1.5 left-2.5 border-l border-edge-default" /> : null}
                      </span>
                    ))}
                    {depth > 0 ? (
                      <span className="relative w-5 shrink-0 self-stretch" aria-hidden>
                        <span className={cn('absolute -top-1.5 left-2.5 border-l border-edge-default', last ? 'h-[calc(50%+6px)]' : '-bottom-1.5')} />
                        <span className="absolute left-2.5 top-1/2 w-2.5 border-t border-edge-default" />
                      </span>
                    ) : null}
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggle(n.id)
                        }}
                        aria-label={isCollapsed ? `Expand ${n.name}` : `Collapse ${n.name}`}
                        aria-expanded={!isCollapsed}
                        className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken hover:text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        <svg viewBox="0 0 12 12" className={cn('h-3 w-3 transition-transform', !isCollapsed && 'rotate-90')} aria-hidden>
                          <path d="M4.5 3l3 3-3 3" className="fill-none stroke-current" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    ) : (
                      <span className="mr-1 w-5 shrink-0" />
                    )}
                    <KindIcon node={n} className="mr-2 h-6 w-6 text-[8.5px]" />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[12px] font-medium text-content" title={n.name}>{n.name}</span>
                      <span className="block truncate text-[11px] text-content-subtle" title={`${n.kind}${n.namespace ? ` · ${n.namespace}` : ''}`}>
                        <span className="md:hidden">{n.kind}{n.namespace ? ' · ' : ''}</span>
                        {n.namespace ?? <span className="hidden md:inline">cluster-scoped</span>}
                        <span className="sm:hidden"> · {age(n.createdAt, now)}</span>
                      </span>
                      {message ? <span className="block truncate text-[11px] text-content-muted sm:hidden" title={message}>{message}</span> : null}
                    </span>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-3 py-1.5 text-content-muted md:table-cell">{n.kind}</td>
                <td className="px-3 py-1.5"><StatusPill level={n.status.level} label={n.status.label} title={message || n.status.label} className="max-w-36" /></td>
                <td className="hidden whitespace-nowrap px-3 py-1.5 text-[11px] lg:table-cell">
                  {n.status.sync || n.status.prune ? <SyncMark sync={n.status.sync} prune={n.status.prune} /> : <span className="text-content-subtle">—</span>}
                </td>
                <td className="hidden max-w-[18rem] px-3 py-1.5 text-[11px] text-content-muted sm:table-cell">
                  <span className="line-clamp-2" title={message || undefined}>{message || <span className="text-content-subtle">—</span>}</span>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-content-subtle" title={n.createdAt ? new Date(n.createdAt).toLocaleString() : undefined}>{age(n.createdAt, now)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
      <LegendStrip edges={false} className="border-t border-edge-default bg-surface-sunken/60 px-2 py-1" />
    </div>
  )
}

/* ───────────────────────── panels ───────────────────────── */

export function ConditionsTable({ conditions, now }: { conditions: readonly Condition[]; now: number }) {
  if (!conditions.length) return null
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold text-content">Conditions</h4>
      <div className="overflow-x-auto rounded-md border border-edge-default">
        <table className="w-full min-w-115 text-left text-xs">
          <thead className="bg-surface-sunken text-[11px] text-content-subtle">
            <tr>
              <th className="px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
              <th className="px-2 py-1.5 font-medium">Reason / message</th>
              <th className="px-2 py-1.5 text-right font-medium">Since</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge-default">
            {conditions.map((c) => (
              <tr key={c.type} className="align-top">
                <td className="px-2 py-1.5 font-medium text-content">{c.type}</td>
                <td className="px-2 py-1.5">
                  <StatusPill level={c.status === 'True' ? 'healthy' : c.status === 'False' ? 'degraded' : 'unknown'} label={c.status} />
                </td>
                <td className="px-2 py-1.5 text-content-muted">
                  {c.reason ? <span className="font-medium text-content">{c.reason}</span> : null}
                  {c.message ? <div className="wrap-break-word whitespace-pre-wrap">{c.message}</div> : null}
                </td>
                <td className="px-2 py-1.5 text-right text-content-subtle">{age(c.lastTransitionTime, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function RelatedList({ title, ids, graph, onSelect }: { title: string; ids: string[]; graph: CompositionGraph; onSelect(id: string): void }) {
  if (!ids.length) return null
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-semibold text-content">{title} <span className="font-normal text-content-subtle">({ids.length})</span></h4>
      <ul className="flex flex-wrap gap-1.5">
        {ids.map((id) => {
          const n = graph.nodes[id]
          if (!n) return null
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelect(id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] hover:bg-surface-sunken"
              >
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', LEVEL_DOT[n.status.level])} aria-hidden />
                <span className="text-content-subtle">{n.kind}</span>
                <span className="font-mono text-content">{n.name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function FieldList({ fields }: { fields: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-[9rem_1fr]">
      {fields.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-content-subtle">{k}</dt>
          <dd className="break-all font-mono text-content">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function StatusCallout({ node }: { node: CompNode }) {
  if (!node.status.reason && !node.status.message) return null
  return (
    <div className={cn('rounded-md px-3 py-2 text-xs ring-1 ring-inset', node.status.level === 'degraded' ? 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-400/25' : 'bg-surface-sunken text-content ring-edge-default')}>
      {node.status.reason ? <span className="font-semibold">{node.status.reason}</span> : null}
      {node.status.reason && node.status.message ? ': ' : null}
      {node.status.message ? <span className="wrap-break-word whitespace-pre-wrap">{node.status.message}</span> : null}
    </div>
  )
}

/**
 * The slide-over a node opens: header (kind, name, status, section switcher,
 * close) over a scrolling body. Escape closes it without closing the drawer
 * underneath.
 */
export function NodeSidePanel<T extends string>({ node, tabs, tab, onTab, onClose, actions, children, wide }: {
  node: CompNode
  tabs: Array<{ value: T; label: ReactNode }>
  tab: T
  onTab(t: T): void
  onClose(): void
  /** Links/buttons beside the status line (e.g. "Open in Argo CD"). */
  actions?: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  const toast = useToast()
  const width = useDrawerWidth('graph.node', { base: wide ? 'sm:max-w-205' : 'sm:max-w-150' })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    globalThis.addEventListener('keydown', onKey, true)
    return () => globalThis.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const copy = (v: string) =>
    navigator.clipboard.writeText(v).then(() => toast.success('Copied name', { description: v })).catch(() => toast.error('Could not copy'))

  const panel = (
    // Above the drawer (z-50) and its own overlays; below toasts.
    <div className="fixed inset-0 z-60 flex justify-end" role="dialog" aria-modal="true" aria-label={`${node.kind} ${node.name}`}>
      <button type="button" className="absolute inset-0 bg-slate-950/25 backdrop-blur-[1px] dark:bg-black/50" aria-label="Close details" onClick={onClose} />
      <div className={cn('relative flex h-full w-full flex-col border-l border-edge-default bg-surface-canvas shadow-2xl', width.className)}>
        <header className="border-b border-edge-default bg-surface-raised px-4 pt-3">
          <div className="flex items-start gap-3">
            <KindIcon node={node} className="h-9 w-9" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="truncate font-mono text-sm font-semibold text-content" title={node.name}>{node.name}</h3>
                <button type="button" className="shrink-0 rounded px-1 text-[11px] text-content-subtle hover:bg-surface-sunken hover:text-content" onClick={() => copy(node.name)} title="Copy name">
                  Copy
                </button>
              </div>
              <div className="truncate text-xs text-content-subtle" title={`${node.kind}${node.namespace ? ` · ${node.namespace}` : ''}`}>
                {node.kind}
                {node.namespace ? ` · ${node.namespace}` : ''}
              </div>
            </div>
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} size="sm" />
            <IconBtn label="Close (Esc)" onClick={onClose}>
              <path d="M6.4 5L5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z" />
            </IconBtn>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
            <StatusPill level={node.status.level} label={node.status.label} />
            {node.status.sync || node.status.prune ? <span className="text-[11px]"><SyncMark sync={node.status.sync} prune={node.status.prune} /></span> : null}
            {actions ? <span className="ml-auto">{actions}</span> : null}
          </div>
          <nav className="-mb-px mt-2 flex gap-1 overflow-x-auto" role="tablist" aria-label="Detail section">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={tab === t.value}
                onClick={() => onTab(t.value)}
                className={cn(
                  'shrink-0 border-b-2 px-2.5 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  tab === t.value ? 'border-brand-500 text-content' : 'border-transparent text-content-muted hover:text-content',
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? null : createPortal(panel, document.body)
}
