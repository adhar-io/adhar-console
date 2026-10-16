import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Pan & zoom viewport for rendered diagrams.
 *   • drag to pan, wheel to pan, ⌘/Ctrl + wheel (or trackpad pinch) to zoom
 *     around the cursor
 *   • toolbar: zoom out / in, percentage (click = 100%), fit
 *   • re-fits automatically when `fitKey` changes (a different diagram)
 */
export function PanZoom({
  children,
  fitKey,
  contentKey,
  className,
  background,
}: {
  children: React.ReactNode
  /** Changing this re-fits the content (e.g. a new diagram id). */
  fitKey?: string
  /** Changing this re-measures; fits only if the user has not moved yet. */
  contentKey?: string
  className?: string
  background?: React.CSSProperties
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  const touched = useRef(false)

  const fit = useCallback(() => {
    const host = hostRef.current
    const inner = innerRef.current
    if (!host || !inner) return
    const hw = host.clientWidth
    const hh = host.clientHeight
    const cw = inner.scrollWidth || 1
    const ch = inner.scrollHeight || 1
    const k = Math.min(2, Math.max(0.1, Math.min((hw - 48) / cw, (hh - 48) / ch)))
    setView({ k, x: (hw - cw * k) / 2, y: (hh - ch * k) / 2 })
  }, [])

  useLayoutEffect(() => {
    touched.current = false
    fit()
  }, [fitKey, fit])

  useLayoutEffect(() => {
    if (!touched.current) fit()
  }, [contentKey, fit])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [fit])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const host = hostRef.current
    if (!host) return
    touched.current = true
    const px = cx ?? host.clientWidth / 2
    const py = cy ?? host.clientHeight / 2
    setView((v) => {
      const k = Math.min(8, Math.max(0.05, v.k * factor))
      const r = k / v.k
      return { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }
    })
  }, [])

  // Wheel must be non-passive to preventDefault the page scroll.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = host.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top)
      } else {
        touched.current = true
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      touched.current = true
      setView((v) => ({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y }))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className={`relative overflow-hidden ${className ?? ''}`} style={background}>
      <div
        ref={hostRef}
        onPointerDown={onPointerDown}
        onDoubleClick={() => fit()}
        className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
      >
        <div
          ref={innerRef}
          className="absolute left-0 top-0 inline-block origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {children}
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg border border-edge-default bg-surface-raised/95 p-0.5 text-content shadow-sm backdrop-blur">
        <ZoomBtn label="Zoom out" onClick={() => zoomAt(1 / 1.2)}>−</ZoomBtn>
        <button
          type="button"
          onClick={() => {
            touched.current = true
            const host = hostRef.current
            if (host) zoomAt(1 / view.k)
          }}
          className="min-w-12 rounded-md px-1.5 py-1 font-mono text-[11px] tabular-nums text-content-muted hover:bg-surface-sunken"
          title="Reset to 100%"
        >
          {Math.round(view.k * 100)}%
        </button>
        <ZoomBtn label="Zoom in" onClick={() => zoomAt(1.2)}>+</ZoomBtn>
        <ZoomBtn
          label="Fit to view"
          onClick={() => {
            touched.current = false
            fit()
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        </ZoomBtn>
      </div>
    </div>
  )
}

function ZoomBtn({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-sm text-content-muted hover:bg-surface-sunken hover:text-content"
    >
      {children}
    </button>
  )
}
