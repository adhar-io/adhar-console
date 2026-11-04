import { type PointerEvent as RPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { edgeCurve, type MapLayout, NODE_H, NODE_W, type Pos } from '../data/flow-layout.ts'
import {
  activity,
  type Bezier,
  bezierAt,
  bezierPath,
  emissionRate,
  formatMs,
  formatPct,
  formatRate,
  type MapEdge,
  mapEdgeHealth,
  type MapGraph,
  type MapNode,
  mapNodeHealth,
  primaryRate,
  strokeWidth,
  travelMs,
} from '../data/live-flows.ts'
import type { Health } from '../data/golden-signals.ts'
import { KindGlyph } from './service-map-glyphs.tsx'

/**
 * The live map canvas.
 *
 * Three stacked layers share one pan/zoom transform: an SVG with namespace
 * frames and edges, a <canvas> with the traffic particles, and an SVG with
 * the node cards (pointer events only on the cards themselves). Particles are
 * drawn in a requestAnimationFrame loop that runs only while animating — it
 * stops when paused, when the tab is hidden, and under prefers-reduced-motion.
 *
 * Layout changes are tweened (450 ms) so nodes glide to their new place
 * instead of jumping; dragging a node pins it. Trackpad/two-finger scroll
 * pans, pinch or ⌘/Ctrl+wheel zooms, a touch pinch zooms on phones.
 */

export interface CanvasHandle {
  fit(): void
  zoomBy(f: number): void
}

interface Props {
  graph: MapGraph
  layout: MapLayout
  focus: string | null
  edge: string | null
  /** 1-hop neighbourhood of the focus (null = nothing dimmed). */
  near: Set<string> | null
  animate: boolean
  onNode(id: string): void
  onEdge(id: string): void
  onClear(): void
  onPin(id: string, p: Pos): void
  onToggleGroup(ns: string): void
  collapsed: ReadonlySet<string>
  handle?: (h: CanvasHandle) => void
  className?: string
  style?: React.CSSProperties
}

interface View {
  k: number
  x: number
  y: number
}

const MIN_K = 0.08
const MAX_K = 2.5
const TWEEN_MS = 450
const MAX_PARTICLES = 700
const PULSE_CSS =
  '@keyframes sm2-pulse{0%{transform:scale(.6);opacity:.45}70%{transform:scale(1.9);opacity:0}100%{opacity:0}}' +
  '.sm2-pulse{transform-box:fill-box;transform-origin:center;animation:sm2-pulse 1.8s ease-out infinite}' +
  '@media (prefers-reduced-motion:reduce){.sm2-pulse{animation:none}}'

const HEALTH_VAR: Record<Health, string> = {
  ok: '--color-emerald-500',
  warn: '--color-amber-500',
  crit: '--color-rose-500',
  none: '--color-slate-400',
}

function reducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function useVisible(): boolean {
  const [v, setV] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = () => setV(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return v
}

/** Tween node positions between layouts so moves glide instead of jump. */
function useTweenedPositions(target: Map<string, Pos>): Map<string, Pos> {
  const [shown, setShown] = useState(target)
  const fromRef = useRef(target)
  const shownRef = useRef(target)
  useEffect(() => {
    const from = shownRef.current
    fromRef.current = from
    if (reducedMotion() || from.size === 0) {
      shownRef.current = target
      setShown(target)
      return
    }
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS)
      const e = 1 - (1 - t) ** 3
      const next = new Map<string, Pos>()
      for (const [id, p] of target) {
        const a = from.get(id)
        next.set(id, a ? { x: a.x + (p.x - a.x) * e, y: a.y + (p.y - a.y) * e } : p)
      }
      shownRef.current = next
      setShown(next)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return shown
}

export function MapCanvas(p: Props) {
  const wrap = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const userMoved = useRef(false)
  const visible = useVisible()
  const pos = useTweenedPositions(p.layout.pos)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    const { w, h } = { w: wrap.current?.clientWidth ?? 0, h: wrap.current?.clientHeight ?? 0 }
    if (!w || !h) return
    const pad = 24
    const k = Math.max(MIN_K, Math.min(1.15, (w - pad * 2) / p.layout.width, (h - pad * 2) / p.layout.height))
    setView({ k, x: (w - p.layout.width * k) / 2, y: Math.max(pad / 2, (h - p.layout.height * k) / 2) })
    userMoved.current = false
  }, [p.layout.width, p.layout.height])

  const zoomAt = useCallback((f: number, cx: number, cy: number) => {
    const v = viewRef.current
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f))
    const r = k / v.k
    setView({ k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r })
    userMoved.current = true
  }, [])

  // Glide to a new view (instant under reduced motion).
  const animRef = useRef(0)
  const glideTo = useCallback((to: View) => {
    cancelAnimationFrame(animRef.current)
    const from = viewRef.current
    if (reducedMotion()) return setView(to)
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 380)
      const e = 1 - (1 - t) ** 3
      setView({ k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e })
      if (t < 1) animRef.current = requestAnimationFrame(step)
    }
    animRef.current = requestAnimationFrame(step)
  }, [])

  // Selecting a service (click or deep link) brings it to the centre at a readable zoom.
  const focusPos = p.focus ? p.layout.pos.get(p.focus) : undefined
  useEffect(() => {
    if (!p.focus || !focusPos || !size.w) return
    const k = Math.max(viewRef.current.k, 0.8)
    glideTo({ k, x: size.w / 2 - (focusPos.x + NODE_W / 2) * k, y: size.h / 2 - (focusPos.y + NODE_H / 2) * k })
    userMoved.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus, !!focusPos, size.w > 0])

  // Re-fit when the content's size changes, until the user takes the wheel.
  useEffect(() => {
    if (!userMoved.current) fit()
  }, [fit, size.w, size.h])

  useEffect(() => {
    p.handle?.({ fit, zoomBy: (f) => zoomAt(f, size.w / 2, size.h / 2) })
  }, [p.handle, fit, zoomAt, size.w, size.h])

  // Wheel: pinch / ⌘-wheel zooms, plain scroll pans. Non-passive so the page does not scroll.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
      else {
        const v = viewRef.current
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
        userMoved.current = true
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  /* ─── pointer: pan background, drag (pin) nodes, pinch ─── */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; el: Element; sx: number; sy: number; vx: number; vy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const pinch = useRef<{ d: number; k: number } | null>(null)
  const [dragPos, setDragPos] = useState<{ id: string; p: Pos } | null>(null)

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const pt = local(e)
    pointers.current.set(e.pointerId, pt)
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: viewRef.current.k }
      drag.current = null
      return
    }
    const target = (e.target as Element).closest('[data-node]') as HTMLElement | null
    const v = viewRef.current
    if (target) {
      const id = target.getAttribute('data-node')!
      const np = pos.get(id) ?? { x: 0, y: 0 }
      drag.current = { kind: 'node', id, el: e.target as Element, sx: pt.x, sy: pt.y, vx: v.x, vy: v.y, ox: np.x, oy: np.y, moved: false }
    } else {
      drag.current = { kind: 'pan', el: e.target as Element, sx: pt.x, sy: pt.y, vx: v.x, vy: v.y, ox: 0, oy: 0, moved: false }
    }
  }

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    const pt = local(e)
    pointers.current.set(e.pointerId, pt)
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const v = viewRef.current
      const k = Math.max(MIN_K, Math.min(MAX_K, pinch.current.k * (d / pinch.current.d)))
      zoomAt(k / v.k, (a.x + b.x) / 2, (a.y + b.y) / 2)
      return
    }
    const g = drag.current
    if (!g) return
    const dx = pt.x - g.sx
    const dy = pt.y - g.sy
    if (!g.moved && Math.hypot(dx, dy) < 4) return
    g.moved = true
    if (g.kind === 'pan') {
      setView({ k: viewRef.current.k, x: g.vx + dx, y: g.vy + dy })
      userMoved.current = true
    } else if (g.id) {
      const k = viewRef.current.k
      setDragPos({ id: g.id, p: { x: g.ox + dx / k, y: g.oy + dy / k } })
    }
  }

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const g = drag.current
    drag.current = null
    if (!g) return
    if (g.kind === 'node' && g.id) {
      if (g.moved && dragPos) p.onPin(g.id, dragPos.p)
      else if (!g.moved) p.onNode(g.id)
      setDragPos(null)
      return
    }
    if (!g.moved) {
      // Pointer capture retargets `pointerup` to the wrapper: use where it went down.
      const edgeEl = g.el.closest('[data-edge]')
      const grp = g.el.closest('[data-group]')
      if (edgeEl) p.onEdge(edgeEl.getAttribute('data-edge')!)
      else if (grp) p.onToggleGroup(grp.getAttribute('data-group')!)
      else p.onClear()
    }
  }

  /* ─── geometry ─── */
  const at = useCallback((id: string) => (dragPos?.id === id ? dragPos.p : pos.get(id)), [pos, dragPos])
  const curves = useMemo(() => {
    const out: Array<{ e: MapEdge; b: Bezier }> = []
    for (const e of p.graph.edges) {
      const a = at(e.s)
      const b = at(e.d)
      if (a && b) out.push({ e, b: edgeCurve(a, b) })
    }
    return out
  }, [p.graph.edges, at])

  /* ─── particles ─── */
  const animate = p.animate && visible && !reducedMotion()
  const curvesRef = useRef(curves)
  curvesRef.current = curves
  const dimRef = useRef<(e: MapEdge) => boolean>(() => false)
  dimRef.current = (e) => !!p.near && !(p.near.has(e.s) && p.near.has(e.d))
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    cv.width = Math.max(1, Math.floor(size.w * dpr))
    cv.height = Math.max(1, Math.floor(size.h * dpr))
    if (!animate) {
      ctx.clearRect(0, 0, cv.width, cv.height)
      return
    }
    let colors: Record<Health, string> = { ok: '', warn: '', crit: '', none: '' }
    let colorsAt = 0
    const readColors = () => {
      const cs = getComputedStyle(document.documentElement)
      colors = {
        ok: cs.getPropertyValue(HEALTH_VAR.ok).trim() || '#10b981',
        warn: cs.getPropertyValue(HEALTH_VAR.warn).trim() || '#f59e0b',
        crit: cs.getPropertyValue(HEALTH_VAR.crit).trim() || '#f43f5e',
        none: cs.getPropertyValue(HEALTH_VAR.none).trim() || '#94a3b8',
      }
    }
    interface Particle {
      id: string
      t0: number
      dur: number
      drop: boolean
      h: Health
      r: number
    }
    let parts: Particle[] = []
    const acc = new Map<string, number>()
    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (now - colorsAt > 2000) {
        readColors()
        colorsAt = now
      }
      const list = curvesRef.current
      const byId = new Map(list.map((c) => [c.e.id, c]))
      // Emit — scaled down together when the budget is tight.
      const budget = Math.max(0, MAX_PARTICLES - parts.length)
      let want = 0
      for (const { e } of list) if (!e.idle) want += emissionRate(activity(e)) * dt
      const scale = want > budget ? budget / want : 1
      for (const { e } of list) {
        if (e.idle) continue
        const a = activity(e)
        const n = (acc.get(e.id) ?? Math.random()) + emissionRate(a) * dt * scale
        let whole = Math.floor(n)
        acc.set(e.id, n - whole)
        const h = mapEdgeHealth(e)
        const dropShare = e.drops > 0 ? Math.min(1, e.drops / Math.max(e.drops, a)) : 0
        while (whole-- > 0) {
          parts.push({ id: e.id, t0: now, dur: travelMs(a) * (0.85 + Math.random() * 0.3), drop: Math.random() < dropShare, h: h === 'none' ? 'none' : h, r: Math.min(3.2, 1.6 + Math.log10(1 + a) * 0.5) })
        }
      }
      const v = viewRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)
      ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y)
      const alive: Particle[] = []
      for (const pt of parts) {
        const c = byId.get(pt.id)
        if (!c) continue
        let t = (now - pt.t0) / pt.dur
        if (t >= 1) continue
        // Dropped particles stop at 60% and fade out where the drop happens.
        let alpha = 0.95
        if (pt.drop) {
          if (t > 0.6) {
            alpha = Math.max(0, 0.95 - (t - 0.6) * 2.6)
            t = 0.6
          }
        }
        const q = bezierAt(c.b, t)
        const dim = dimRef.current(c.e)
        ctx.globalAlpha = (dim ? 0.12 : alpha) * (t < 0.06 ? t / 0.06 : 1)
        ctx.fillStyle = pt.drop ? colors.crit : colors[pt.h]
        ctx.beginPath()
        // At least ~2px on screen, however far out the map is zoomed.
        ctx.arc(q.x, q.y, Math.max(pt.r, 2 / v.k), 0, Math.PI * 2)
        ctx.fill()
        if (pt.drop && alpha < 0.9) {
          // a small "x" where the packet was dropped
          ctx.strokeStyle = colors.crit
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.moveTo(q.x - 3, q.y - 3)
          ctx.lineTo(q.x + 3, q.y + 3)
          ctx.moveTo(q.x + 3, q.y - 3)
          ctx.lineTo(q.x - 3, q.y + 3)
          ctx.stroke()
        }
        alive.push(pt)
      }
      ctx.globalAlpha = 1
      parts = alive
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [animate, size.w, size.h])

  /* ─── render ─── */
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
  const dimNode = (id: string) => !!p.near && !p.near.has(id)
  const dimEdge = (e: MapEdge) => !!p.near && !(p.near.has(e.s) && p.near.has(e.d))
  const showLabels = view.k >= 0.55
  // Zoomed out, namespace names are drawn at a fixed screen size on the frame's top edge.
  const zoomedIn = view.k >= 0.7
  const labelFor = (e: MapEdge) => p.edge === e.id || (!!p.focus && (e.s === p.focus || e.d === p.focus))

  return (
    <div
      ref={wrap}
      className={cn('relative touch-none select-none overflow-hidden bg-surface-sunken/40 [background-image:radial-gradient(var(--color-edge-default)_1px,transparent_1px)] [background-size:22px_22px]', p.className)}
      style={p.style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="application"
      aria-label={`Service map: ${p.graph.nodes.length} services, ${p.graph.edges.length} connections. Drag to pan, pinch or Ctrl+scroll to zoom.`}
    >
      <style>{PULSE_CSS}</style>
      {/* frames + edges */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          {(['ok', 'warn', 'crit', 'none', 'brand'] as const).map((h) => (
            <marker key={h} id={`sm2-arrow-${h}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 Z" fill={h === 'brand' ? 'var(--color-brand-500)' : `var(${HEALTH_VAR[h]})`} />
            </marker>
          ))}
        </defs>
        <g style={{ transform: t, transformOrigin: '0 0' }}>
          {p.layout.groups.map((g) => (
            <g key={g.ns} data-group={g.ns} className="cursor-pointer">
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={14} fill="var(--color-surface-raised)" fillOpacity={0.55} stroke="var(--color-edge-default)" strokeDasharray="5 4" />
              {zoomedIn ? (
                <>
                  <text x={g.x + 14} y={g.y + 17} fontSize="10.5" fontWeight={600} letterSpacing="0.06em" fill="var(--color-content-muted)">
                    {g.ns.toUpperCase()}
                  </text>
                  <text x={g.x + g.w - 12} y={g.y + 17} fontSize="10" textAnchor="end" fill="var(--color-content-subtle)">
                    {g.count} · collapse
                  </text>
                </>
              ) : null}
            </g>
          ))}
          {curves.map(({ e, b }) => {
            const h = mapEdgeHealth(e)
            const sel = p.edge === e.id
            const d = bezierPath(b)
            const w = strokeWidth(activity(e))
            const stroke = sel ? 'var(--color-brand-500)' : e.idle ? 'var(--color-edge-strong)' : `var(${HEALTH_VAR[h]})`
            return (
              <g key={e.id} data-edge={e.id} className="cursor-pointer" opacity={dimEdge(e) ? 0.12 : 1}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(12, w + 8)} />
                <path
                  d={d}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={e.idle ? 0.45 : h === 'none' ? 0.45 : 0.6}
                  strokeWidth={sel ? w + 1.5 : w}
                  strokeDasharray={e.idle ? '4 5' : undefined}
                  strokeLinecap="round"
                  markerEnd={`url(#sm2-arrow-${sel ? 'brand' : e.idle ? 'none' : h})`}
                  style={{ transition: 'stroke-width 400ms, stroke 400ms' }}
                />
                {e.drops > 0 ? <path d={d} fill="none" stroke={`var(${HEALTH_VAR.crit})`} strokeWidth={1.5} strokeDasharray="3 5" strokeOpacity={0.9} /> : null}
              </g>
            )
          })}
        </g>
      </svg>

      {/* particles */}
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />

      {/* nodes + labels */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        {!zoomedIn
          ? p.layout.groups.map((g) => {
            const sx = view.x + g.x * view.k
            const sy = view.y + g.y * view.k
            const sw = g.w * view.k
            if (sw < 40) return null
            const label = g.ns.length * 6.6 > sw - 12 ? `${g.ns.slice(0, Math.max(3, Math.floor((sw - 24) / 6.6)))}…` : g.ns
            const w = label.length * 6.6 + 14
            return (
              <g key={g.ns} transform={`translate(${sx + 6},${sy - 9})`}>
                <rect width={w} height={18} rx={9} fill="var(--color-surface-raised)" stroke="var(--color-edge-default)" />
                <text x={7} y={12.5} fontSize="10.5" fontWeight={600} fill="var(--color-content-muted)">{label}</text>
              </g>
            )
          })
          : null}
        <g style={{ transform: t, transformOrigin: '0 0' }}>
          {showLabels
            ? curves.filter(({ e }) => labelFor(e)).map(({ e, b }) => <EdgeLabel key={e.id} e={e} b={b} />)
            : null}
          {p.graph.nodes.map((n) => {
            const q = at(n.id)
            if (!q) return null
            return (
              <NodeCard
                key={n.id}
                n={n}
                x={q.x}
                y={q.y}
                selected={p.focus === n.id}
                dim={dimNode(n.id)}
                pulse={animate}
                detail={view.k >= 0.45}
              />
            )
          })}
        </g>
      </svg>

      <Minimap layout={p.layout} pos={pos} graph={p.graph} view={view} size={size} onCenter={(x, y) => {
        setView({ k: view.k, x: size.w / 2 - x * view.k, y: size.h / 2 - y * view.k })
        userMoved.current = true
      }} />
    </div>
  )
}

/* ─────────────────────────── node card ─────────────────────────── */

const HEALTH_WORD: Record<Health, string> = { ok: 'Healthy', warn: 'Warning', crit: 'Critical', none: 'No L7 data' }

function NodeCard({ n, x, y, selected, dim, pulse, detail }: { n: MapNode; x: number; y: number; selected: boolean; dim: boolean; pulse: boolean; detail: boolean }) {
  const h = mapNodeHealth(n)
  const served = n.rps + n.cps + n.fps > 0
  const r = served ? primaryRate(n) : primaryRate({ rps: n.orps, cps: 0, fps: n.ofps })
  const name = n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name
  const stats = n.idle
    ? n.kind === 'namespace' ? `${n.members ?? 0} workloads · idle` : 'idle'
    : [
      `${formatRate(r.value)} ${r.unit}${served ? '' : ' out'}`,
      n.err !== null ? formatPct(n.err) : null,
      n.p95 !== null ? formatMs(n.p95) : null,
      n.drops > 0 ? `${formatRate(n.drops)} drop/s` : null,
    ].filter(Boolean).join(' · ')
  const bar = h === 'none' ? (n.idle ? 'var(--color-edge-default)' : 'var(--color-slate-400)') : `var(${HEALTH_VAR[h]})`
  return (
    <g
      data-node={n.id}
      transform={`translate(${x},${y})`}
      opacity={dim ? 0.28 : n.idle ? 0.62 : 1}
      className="pointer-events-auto cursor-pointer"
      style={{ transition: 'opacity 250ms' }}
      role="button"
      tabIndex={-1}
      aria-label={`${n.name}${n.ns ? ` in ${n.ns}` : ''}: ${HEALTH_WORD[h]}, ${stats}`}
    >
      <title>{`${n.ns ? `${n.ns}/` : ''}${n.name} — ${HEALTH_WORD[h]}\n${stats}`}</title>
      {selected ? <rect x={-4} y={-4} width={NODE_W + 8} height={NODE_H + 8} rx={13} fill="none" stroke="var(--color-brand-500)" strokeOpacity={0.35} strokeWidth={4} /> : null}
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill="var(--color-surface-raised)"
        stroke={selected ? 'var(--color-brand-500)' : h === 'warn' || h === 'crit' ? `var(${HEALTH_VAR[h]})` : 'var(--color-edge-default)'}
        strokeWidth={selected ? 2 : h === 'crit' ? 1.6 : 1}
        strokeDasharray={n.idle ? '4 3' : undefined}
        style={{ filter: n.idle ? undefined : 'drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.08))' }}
      />
      <rect x={0} y={10} width={3} height={NODE_H - 20} rx={1.5} fill={bar} />
      <g transform="translate(12,13)">
        <rect width={28} height={28} rx={8} fill="var(--color-surface-sunken)" stroke="var(--color-edge-subtle)" />
        <g transform="translate(6,6)" className="text-content-muted">
          <KindGlyph kind={n.kind} size={16} />
        </g>
      </g>
      <text x={50} y={detail ? 23 : 31} fontSize="12" fontWeight={600} fill="var(--color-content)">{name}</text>
      {detail ? <text x={50} y={40} fontSize="10" fontFamily="var(--font-mono)" fill="var(--color-content-muted)">{stats.length > 30 ? `${stats.slice(0, 29)}…` : stats}</text> : null}
      {!n.idle && served ? (
        <g transform={`translate(${NODE_W - 12},12)`}>
          {pulse ? <circle r={6} fill={bar} opacity={0.25} className="sm2-pulse" /> : null}
          <circle r={3} fill={bar} />
        </g>
      ) : null}
    </g>
  )
}

function EdgeLabel({ e, b }: { e: MapEdge; b: Bezier }) {
  const m = bezierAt(b, 0.5)
  const r = primaryRate(e)
  const text = [`${formatRate(r.value)} ${r.unit}`, e.err !== null ? formatPct(e.err) : null, e.p95 !== null ? formatMs(e.p95) : null].filter(Boolean).join(' · ')
  const w = text.length * 5.6 + 14
  return (
    <g transform={`translate(${m.x},${m.y})`}>
      <rect x={-w / 2} y={-9} width={w} height={18} rx={9} fill="var(--color-surface-raised)" stroke="var(--color-edge-default)" />
      <text y={3.5} textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fill="var(--color-content-muted)">{text}</text>
    </g>
  )
}

/* ─────────────────────────── minimap ─────────────────────────── */

function Minimap({ layout, pos, graph, view, size, onCenter }: {
  layout: MapLayout
  pos: Map<string, Pos>
  graph: MapGraph
  view: View
  size: { w: number; h: number }
  onCenter(x: number, y: number): void
}) {
  const W = 168
  const H = Math.max(60, Math.min(120, (layout.height / layout.width) * W))
  const s = Math.min(W / layout.width, H / layout.height)
  // Only worth showing when the map does not fit on screen.
  if (layout.width * view.k <= size.w * 1.02 && layout.height * view.k <= size.h * 1.02) return null
  const vx = -view.x / view.k
  const vy = -view.y / view.k
  const vw = size.w / view.k
  const vh = size.h / view.k
  const pick = (e: RPointerEvent<SVGSVGElement>) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    onCenter((e.clientX - r.left) / s, (e.clientY - r.top) / s)
  }
  return (
    <svg
      width={W}
      height={H}
      className="absolute bottom-3 right-3 hidden rounded-lg border border-edge-default bg-surface-raised/90 shadow-md backdrop-blur sm:block"
      onPointerDown={pick}
      role="img"
      aria-label="Minimap — click to move the view"
    >
      {layout.groups.map((g) => <rect key={g.ns} x={g.x * s} y={g.y * s} width={g.w * s} height={g.h * s} rx={2} fill="var(--color-surface-sunken)" />)}
      {graph.nodes.map((n) => {
        const q = pos.get(n.id)
        if (!q) return null
        const h = mapNodeHealth(n)
        return <rect key={n.id} x={q.x * s} y={q.y * s} width={Math.max(2, NODE_W * s)} height={Math.max(1.5, NODE_H * s)} rx={1} fill={h === 'none' ? 'var(--color-content-subtle)' : `var(${HEALTH_VAR[h]})`} opacity={n.idle ? 0.4 : 0.85} />
      })}
      <rect x={vx * s} y={vy * s} width={vw * s} height={vh * s} fill="var(--color-brand-500)" fillOpacity={0.08} stroke="var(--color-brand-500)" strokeWidth={1} />
    </svg>
  )
}
