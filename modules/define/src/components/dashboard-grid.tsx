import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar/utils'

/**
 * Sortable widget grid for the Define dashboard.
 *
 * Adapted from the console Overview's DraggableGrid (modules can't import
 * from apps/console) and extended:
 *
 *   • Pointer-driven (mouse, pen, touch): 6 px before a mouse press becomes a
 *     drag; on touch the card lifts after a 350 ms long-press (a swipe still
 *     scrolls the page), or at once from the grip handle.
 *   • The lifted card follows the pointer as a ghost (slight tilt, scale and a
 *     deep shadow); its slot becomes a dashed drop placeholder that moves to
 *     where the card will land.
 *   • The rest of the grid reflows live — re-packed into full rows by the
 *     caller's `classesFor` — and every move animates (FLIP), so widgets glide
 *     to their new places instead of jumping.
 *   • Edge auto-scroll near the top / bottom of the scrolling container.
 *   • Keyboard: focus a grip and use the arrow keys (Home / End for the
 *     ends); each move is announced to screen readers. Esc cancels a drag.
 *   • Respects `prefers-reduced-motion`.
 */

export interface SortableGridProps<T extends { id: string }> {
  items: readonly T[]
  /** Span classes for each item of `order` (re-run for the live drag order). */
  classesFor(order: readonly T[]): string[]
  /** Drag + keyboard reordering on (edit mode). */
  editing: boolean
  onReorder(next: T[], moved: T): void
  /** Human name for announcements, e.g. the widget title. */
  label(item: T): string
  render(item: T, state: { dragging: boolean; ghost: boolean; handle: ReactNode }): ReactNode
  className?: string
}

interface DragState {
  activeId: string
  targetIdx: number
  offsetX: number
  offsetY: number
  pointerX: number
  pointerY: number
  width: number
  height: number
}

const EDGE_ZONE = 96
const MAX_SCROLL_STEP = 22
const DRAG_THRESHOLD = 6
const LONG_PRESS_MS = 350
const LONG_PRESS_SLOP = 10
const REFLOW_MS = 260
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function SortableGrid<T extends { id: string }>({ items, classesFor, editing, onReorder, label, render, className }: SortableGridProps<T>) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag
  const [virtualOrder, setVirtualOrder] = useState<readonly T[] | null>(null)
  const slotRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const gridRef = useRef<HTMLDivElement>(null)
  const [announce, setAnnounce] = useState('')
  const focusAfter = useRef<string | null>(null)

  useEffect(() => {
    if (!drag) setVirtualOrder(null)
  }, [items, drag])

  const order = drag && virtualOrder ? virtualOrder : items
  const classes = classesFor(order)

  /* ── FLIP reflow: animate every slot from where it was to where it is ── */
  const prevPos = useRef<Map<string, { x: number; y: number }>>(new Map())
  const prevKey = useRef('')
  const layoutKey = order.map((x, i) => `${x.id}:${classes[i]}`).join('|')
  useLayoutEffect(() => {
    const next = new Map<string, { x: number; y: number }>()
    const changed = prevKey.current !== '' && prevKey.current !== layoutKey
    const animate = changed && !reducedMotion()
    slotRef.current.forEach((el, id) => {
      const pos = { x: el.offsetLeft, y: el.offsetTop }
      next.set(id, pos)
      const prev = prevPos.current.get(id)
      if (!animate || !prev || typeof el.animate !== 'function') return
      const dx = prev.x - pos.x
      const dy = prev.y - pos.y
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      el.getAnimations?.().forEach((a) => a.cancel())
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: REFLOW_MS, easing: EASE })
    })
    prevPos.current = next
    prevKey.current = layoutKey
    if (focusAfter.current) {
      const h = gridRef.current?.querySelector<HTMLElement>(`[data-grip="${CSS.escape(focusAfter.current)}"]`)
      focusAfter.current = null
      h?.focus({ preventScroll: false })
    }
  }, [layoutKey])

  const abortRef = useRef<(() => void) | null>(null)
  useEffect(() => () => abortRef.current?.(), [])
  useEffect(() => {
    if (!editing) abortRef.current?.()
  }, [editing])

  function startDrag(itemId: string, e: ReactPointerEvent<HTMLElement>, mode: 'immediate' | 'longpress') {
    if (!editing || e.button !== 0) return
    const slot = slotRef.current.get(itemId)
    if (!slot) return
    const rect = slot.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const offsetX = startX - rect.left
    const offsetY = startY - rect.top
    const scroller = scrollParentOf(gridRef.current)
    let dragging = false
    let armed = mode === 'immediate'
    let holdTimer: ReturnType<typeof setTimeout> | 0 = 0
    let raf = 0
    let px = startX
    let py = startY
    let lastTarget = -1

    const frame = () => {
      raf = 0
      const cur = dragRef.current
      if (!cur) return
      const box = scroller?.getBoundingClientRect()
      const top = box ? box.top : 0
      const bottom = box ? box.bottom : globalThis.innerHeight
      let step = 0
      if (py < top + EDGE_ZONE) step = -Math.ceil(((top + EDGE_ZONE - py) / EDGE_ZONE) * MAX_SCROLL_STEP)
      else if (py > bottom - EDGE_ZONE) step = Math.ceil(((py - (bottom - EDGE_ZONE)) / EDGE_ZONE) * MAX_SCROLL_STEP)
      if (step) {
        if (scroller) scroller.scrollTop += step
        else globalThis.scrollBy(0, step)
      }

      const fromIdx = items.findIndex((x) => x.id === cur.activeId)
      if (fromIdx < 0) return
      const gridWidth = gridRef.current?.getBoundingClientRect().width ?? 0
      let targetIdx = cur.targetIdx
      let best = Number.POSITIVE_INFINITY
      slotRef.current.forEach((el, id) => {
        if (id === cur.activeId) return
        const r = el.getBoundingClientRect()
        // Pointer inside a card wins outright; otherwise the nearest centre.
        const inside = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const d = inside ? -1 : (px - cx) ** 2 + (py - cy) ** 2 * 0.6
        if (d >= best) return
        best = d
        const hovered = items.findIndex((x) => x.id === id)
        if (hovered < 0) return
        // Full-width cards stack: split on y. Cards sharing a row: split on x.
        const stacked = gridWidth > 0 && r.width > gridWidth * 0.9
        const after = stacked ? py > cy : px > cx
        const ti = hovered + (after ? 1 : 0)
        targetIdx = ti > fromIdx ? ti - 1 : ti
      })

      const next: DragState = { ...cur, pointerX: px, pointerY: py, targetIdx }
      dragRef.current = next
      setDrag(next)
      if (targetIdx !== lastTarget) {
        lastTarget = targetIdx
        const arr = items.filter((x) => x.id !== cur.activeId)
        const moved = items.find((x) => x.id === cur.activeId)
        if (moved) arr.splice(targetIdx, 0, moved)
        setVirtualOrder(arr)
      }
      if (step) raf = requestAnimationFrame(frame)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const begin = () => {
      if (dragging) return
      const fromIdx = items.findIndex((x) => x.id === itemId)
      if (fromIdx < 0) return
      dragging = true
      lastTarget = fromIdx
      const initial: DragState = { activeId: itemId, targetIdx: fromIdx, offsetX, offsetY, pointerX: px, pointerY: py, width: rect.width, height: rect.height }
      dragRef.current = initial
      setDrag(initial)
      setVirtualOrder(items)
      document.body.classList.add('cursor-grabbing', 'select-none')
      if (mode === 'longpress') {
        try {
          (navigator as { vibrate?: (p: number) => boolean }).vibrate?.(10)
        } catch { /* unsupported */ }
      }
    }

    const onMove = (ev: PointerEvent) => {
      px = ev.clientX
      py = ev.clientY
      if (!dragging) {
        const d2 = (px - startX) ** 2 + (py - startY) ** 2
        if (!armed) {
          if (d2 > LONG_PRESS_SLOP ** 2) finish(false)
          return
        }
        if (d2 < DRAG_THRESHOLD ** 2) return
        begin()
      }
      schedule()
    }
    const onTouchMove = (ev: TouchEvent) => {
      if (dragging && ev.cancelable) ev.preventDefault()
    }
    const onContextMenu = (ev: Event) => {
      if (dragging || mode === 'longpress') ev.preventDefault()
    }
    const finish = (commit: boolean) => {
      abortRef.current = null
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerup', onUp)
      globalThis.removeEventListener('pointercancel', onCancel)
      globalThis.removeEventListener('keydown', onKey)
      globalThis.removeEventListener('scroll', schedule, true)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('contextmenu', onContextMenu)
      if (holdTimer) clearTimeout(holdTimer)
      if (raf) cancelAnimationFrame(raf)
      holdTimer = 0
      raf = 0
      document.body.classList.remove('cursor-grabbing', 'select-none')
      const cur = dragRef.current
      if (cur && commit) {
        const fromIdx = items.findIndex((x) => x.id === cur.activeId)
        if (fromIdx !== -1 && fromIdx !== cur.targetIdx) {
          const next = items.slice()
          const [moved] = next.splice(fromIdx, 1)
          next.splice(cur.targetIdx, 0, moved)
          onReorder(next, moved)
          setAnnounce(`${label(moved)} moved to position ${cur.targetIdx + 1} of ${items.length}.`)
        }
      }
      dragRef.current = null
      setDrag(null)
      setVirtualOrder(null)
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(false)
    }

    abortRef.current = () => finish(false)
    globalThis.addEventListener('pointermove', onMove)
    globalThis.addEventListener('pointerup', onUp)
    globalThis.addEventListener('pointercancel', onCancel)
    globalThis.addEventListener('keydown', onKey)
    globalThis.addEventListener('scroll', schedule, true)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('contextmenu', onContextMenu)
    if (mode === 'longpress') {
      holdTimer = setTimeout(() => {
        holdTimer = 0
        armed = true
        begin()
        schedule()
      }, LONG_PRESS_MS)
    }
  }

  function onGripKey(item: T, e: ReactKeyboardEvent<HTMLElement>) {
    const from = items.findIndex((x) => x.id === item.id)
    let to = from
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = from - 1
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = from + 1
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = items.length - 1
    else return
    e.preventDefault()
    if (to < 0 || to >= items.length || to === from) return
    const next = items.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    focusAfter.current = item.id
    onReorder(next, moved)
    setAnnounce(`${label(moved)} moved to position ${to + 1} of ${items.length}.`)
  }

  const grip = (item: T, idx: number) =>
    editing
      ? (
        <button
          type="button"
          data-grip={item.id}
          aria-label={`Move ${label(item)} — position ${idx + 1} of ${items.length}. Drag, or use the arrow keys.`}
          title="Drag to move · arrow keys to move"
          aria-roledescription="sortable"
          onPointerDown={(e) => {
            e.stopPropagation()
            startDrag(item.id, e, 'immediate')
          }}
          onKeyDown={(e) => onGripKey(item, e)}
          style={{ touchAction: 'none' }}
          className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content focus-visible:bg-brand-50 focus-visible:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 active:cursor-grabbing sm:h-7 sm:w-7 dark:focus-visible:bg-brand-500/15 dark:focus-visible:text-brand-200"
        >
          <GripGlyph />
        </button>
      )
      : null

  const committedIdx = new Map(items.map((x, i) => [x.id, i]))

  return (
    <>
      <div ref={gridRef} className={cn('relative grid grid-cols-1 gap-4 md:grid-cols-12', className)}>
        {order.map((item, i) => {
          const isDragging = drag?.activeId === item.id
          return (
            <div
              key={item.id}
              ref={(el) => {
                if (el) slotRef.current.set(item.id, el)
                else slotRef.current.delete(item.id)
              }}
              data-dragging={isDragging || undefined}
              onPointerDown={editing
                ? (e) => {
                  let node: HTMLElement | null = e.target as HTMLElement
                  while (node && node !== e.currentTarget) {
                    if (node.matches('a, button, input, textarea, select, label, [role="button"], [data-no-drag]')) return
                    node = node.parentElement
                  }
                  startDrag(item.id, e, e.pointerType === 'mouse' ? 'immediate' : 'longpress')
                }
                : undefined}
              style={editing ? ({ touchAction: 'pan-y pinch-zoom', WebkitTouchCallout: 'none' } as CSSProperties) : undefined}
              className={cn(
                'relative min-w-0',
                classes[i],
                editing && !drag && 'cursor-grab',
                editing && '[@media(hover:none)]:select-none',
              )}
            >
              <div className={cn('h-full transition-opacity duration-150', isDragging && 'opacity-0')}>
                {render(item, { dragging: isDragging, ghost: false, handle: grip(item, committedIdx.get(item.id) ?? i) })}
              </div>
              {isDragging ? <DropPlaceholder /> : null}
            </div>
          )
        })}
      </div>
      <div aria-live="polite" aria-atomic="true" className="sr-only">{announce}</div>
      {drag && typeof document !== 'undefined'
        ? createPortal(<Ghost drag={drag} item={items.find((x) => x.id === drag.activeId)!} render={render} />, document.body)
        : null}
    </>
  )
}

function Ghost<T extends { id: string }>({ drag, item, render }: { drag: DragState; item: T; render: SortableGridProps<T>['render'] }) {
  if (!item) return null
  const style: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: drag.width,
    height: Math.min(drag.height, typeof innerHeight === 'number' ? innerHeight * 0.6 : drag.height),
    transform: `translate3d(${drag.pointerX - drag.offsetX}px, ${drag.pointerY - drag.offsetY}px, 0) rotate(1deg) scale(1.025)`,
    transformOrigin: `${drag.offsetX}px ${drag.offsetY}px`,
    pointerEvents: 'none',
    zIndex: 80,
    willChange: 'transform',
  }
  return (
    <div style={style} className="adhar-define-ghost overflow-hidden rounded-xl shadow-[0_24px_48px_-12px_rgba(15,23,42,0.35),0_8px_16px_-8px_rgba(15,23,42,0.25)] ring-2 ring-brand-400/70">
      <div className="h-full bg-surface-raised">{render(item, { dragging: true, ghost: true, handle: <span className="flex h-7 w-7 items-center justify-center text-brand-600 dark:text-brand-300"><GripGlyph /></span> })}</div>
      <style>{`
        .adhar-define-ghost { animation: adhar-define-lift 160ms ${EASE}; }
        @keyframes adhar-define-lift { from { box-shadow: none; opacity: .6; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .adhar-define-ghost { animation: none; } }
      `}</style>
    </div>
  )
}

function DropPlaceholder() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border-2 border-dashed border-brand-400/80 bg-brand-50/70 dark:border-brand-400/60 dark:bg-brand-500/10"
    >
      <span className="flex items-center gap-1.5 rounded-full bg-surface-raised px-2.5 py-1 text-[11px] font-semibold text-brand-700 shadow-sm ring-1 ring-brand-200 dark:text-brand-200 dark:ring-brand-500/40">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14" />
          <path d="m6 13 6 6 6-6" />
        </svg>
        Drop here
      </span>
    </div>
  )
}

export function GripGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  )
}
