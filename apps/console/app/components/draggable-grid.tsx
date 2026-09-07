import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar-console/utils'

/**
 * Pointer-driven drag-and-drop grid for the Overview page.
 *
 * Why custom and not @dnd-kit / react-beautiful-dnd?
 *   - The Overview grid uses a 12-column CSS grid where panels span 3/4/6/12
 *     columns and reflow at responsive breakpoints. Off-the-shelf DnD libs
 *     either flatten to a list or charge ~30 KB for layouts we don't need.
 *   - Pointer events give us full control over the lift / ghost / drop-zone
 *     animations and let us avoid the HTML5 DnD spec quirks (jittery
 *     dragImage, missed events on touch, no native cancel-on-Escape).
 *
 * Behavior:
 *   - 6 px movement before a drag starts — accidental clicks don't trigger.
 *   - The active card stays in its slot but renders dimmed; a fixed-position
 *     ghost follows the cursor with a soft lift / rotate.
 *   - Other items reflow live as the cursor moves, with a `transform`
 *     transition for smoothness.
 *   - A brand-tinted insertion bar marks the drop target.
 *   - Esc cancels; pointerup commits via `onReorder`.
 *
 * Smoothness:
 *   - Pointer moves are coalesced into ONE update per animation frame (the
 *     ghost position, the hit-test and the live reflow all run in the rAF),
 *     so a fast mouse never queues dozens of React renders.
 *   - **Edge auto-scroll**: while dragging near the top/bottom of the
 *     scrolling container (or the window) the page scrolls towards the drop
 *     area, faster the closer the pointer is to the edge; the hit-test re-runs
 *     every frame so the target keeps tracking the content sliding under the
 *     cursor.
 *   - Slots are `touch-action: none` so the same engine works on touch.
 */

export interface DraggableGridProps<T extends { id: string }> {
  items: readonly T[]
  /** Called on commit with the new ordered array. */
  onReorder(next: T[]): void
  /** When true, drag handlers are no-ops and panels render statically. */
  disabled?: boolean
  /** Render the panel body. Receives a `dragging` flag for visual emphasis. */
  render(item: T, dragging: boolean): ReactNode
  /** Tailwind class for each item — typically a colspan value. */
  spanClassName(item: T): string
  /** Outer grid class. Defaults to a 12-col layout. */
  className?: string
}

interface DragState {
  activeId: string
  /** Where the dragging card will land in the resulting array. */
  targetIdx: number
  /** Cursor offset from the top-left of the original card — keeps the ghost glued. */
  offsetX: number
  offsetY: number
  /** Cursor position. */
  pointerX: number
  pointerY: number
  /** Card width — ghost matches the original. */
  width: number
  /** Card height — ghost matches the original. */
  height: number
}

/** Distance from a scroll edge (px) at which auto-scroll kicks in. */
const EDGE_ZONE = 96
/** Max scroll speed per frame (px). */
const MAX_SCROLL_STEP = 22
/** Movement before a press becomes a drag (px). */
const DRAG_THRESHOLD = 6

/** Nearest ancestor that actually scrolls vertically, else the document. */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const style = getComputedStyle(node)
    const oy = style.overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}

export function DraggableGrid<T extends { id: string }>({
  items,
  onReorder,
  disabled = false,
  render,
  spanClassName,
  className,
}: DraggableGridProps<T>) {
  const [drag, setDrag] = useState<DragState | null>(null)
  /** Keeps the latest state in callbacks without re-binding listeners. */
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  // Map id → DOM element for hit-testing during drag.
  const slotRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const gridRef = useRef<HTMLDivElement>(null)
  /** Local visual order during a drag — committed via onReorder on drop. */
  const [virtualOrder, setVirtualOrder] = useState<readonly T[] | null>(null)

  // Keep virtualOrder in sync when items change while no drag is active.
  useEffect(() => {
    if (!drag) setVirtualOrder(null)
  }, [items, drag])

  const renderOrder = drag && virtualOrder ? virtualOrder : items

  function startDrag(itemId: string, e: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || e.button !== 0) return
    const slot = slotRef.current.get(itemId)
    if (!slot) return
    const rect = slot.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const offsetX = startX - rect.left
    const offsetY = startY - rect.top
    const scroller = scrollParentOf(gridRef.current)

    let dragging = false
    let raf = 0
    /** Latest pointer position — consumed once per frame. */
    let px = startX
    let py = startY
    let lastTargetIdx = -1

    /** One frame of work: auto-scroll, hit-test, and a single state update. */
    const frame = () => {
      raf = 0
      const cur = dragRef.current
      if (!cur) return

      // ── edge auto-scroll ──
      const top = scroller ? scroller.getBoundingClientRect().top : 0
      const bottom = scroller ? scroller.getBoundingClientRect().bottom : globalThis.innerHeight
      let step = 0
      if (py < top + EDGE_ZONE) step = -Math.ceil(((top + EDGE_ZONE - py) / EDGE_ZONE) * MAX_SCROLL_STEP)
      else if (py > bottom - EDGE_ZONE) step = Math.ceil(((py - (bottom - EDGE_ZONE)) / EDGE_ZONE) * MAX_SCROLL_STEP)
      if (step !== 0) {
        if (scroller) scroller.scrollTop += step
        else globalThis.scrollBy(0, step)
      }

      // ── hit-test against the live slot geometry ──
      const fromIdx = items.findIndex((x) => x.id === cur.activeId)
      if (fromIdx < 0) return
      let targetIdx = cur.targetIdx
      let bestDist = Number.POSITIVE_INFINITY
      slotRef.current.forEach((el, id) => {
        if (id === cur.activeId) return
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const dx2 = px - cx
        const dy2 = py - cy
        // Weight horizontal distance higher for grid layouts so the user can
        // skim along a row.
        const d = dx2 * dx2 + dy2 * dy2 * 0.6
        if (d < bestDist) {
          bestDist = d
          const hoveredIdx = items.findIndex((x) => x.id === id)
          if (hoveredIdx < 0) return
          // Insert before/after based on cursor position relative to mid-x of target.
          const after = px > cx
          const ti = hoveredIdx + (after ? 1 : 0)
          targetIdx = ti > fromIdx ? ti - 1 : ti
        }
      })

      const next: DragState = { ...cur, pointerX: px, pointerY: py, targetIdx }
      dragRef.current = next
      setDrag(next)

      // Recompute the virtual order only when the target actually changed —
      // reflow transitions look calmer without redundant re-layouts.
      if (targetIdx !== lastTargetIdx) {
        lastTargetIdx = targetIdx
        const arr = items.filter((x) => x.id !== cur.activeId)
        const target = items.find((x) => x.id === cur.activeId)
        if (target) arr.splice(targetIdx, 0, target)
        setVirtualOrder(arr)
      }

      // Keep the loop alive while auto-scrolling so content sliding under a
      // stationary pointer still updates the drop target.
      if (step !== 0) raf = requestAnimationFrame(frame)
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame)
    }

    const onMove = (ev: PointerEvent) => {
      px = ev.clientX
      py = ev.clientY
      if (!dragging) {
        const dx = px - startX
        const dy = py - startY
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
        dragging = true
        const fromIdx = items.findIndex((x) => x.id === itemId)
        if (fromIdx < 0) return
        const initial: DragState = {
          activeId: itemId,
          targetIdx: fromIdx,
          offsetX,
          offsetY,
          pointerX: px,
          pointerY: py,
          width: rect.width,
          height: rect.height,
        }
        lastTargetIdx = fromIdx
        dragRef.current = initial
        setDrag(initial)
        setVirtualOrder(items)
        document.body.classList.add('cursor-grabbing', 'select-none')
      }
      schedule()
    }

    const finish = (commit: boolean) => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerup', onUp)
      globalThis.removeEventListener('pointercancel', onCancel)
      globalThis.removeEventListener('keydown', onKey)
      globalThis.removeEventListener('scroll', schedule, true)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      document.body.classList.remove('cursor-grabbing', 'select-none')
      const cur = dragRef.current
      if (cur && commit) {
        const fromIdx = items.findIndex((x) => x.id === cur.activeId)
        if (fromIdx !== -1 && fromIdx !== cur.targetIdx) {
          const next = items.slice()
          const [moved] = next.splice(fromIdx, 1)
          next.splice(cur.targetIdx, 0, moved)
          onReorder(next)
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

    globalThis.addEventListener('pointermove', onMove)
    globalThis.addEventListener('pointerup', onUp)
    globalThis.addEventListener('pointercancel', onCancel)
    globalThis.addEventListener('keydown', onKey)
    // Wheel/trackpad scrolling mid-drag also shifts the slots under the cursor.
    globalThis.addEventListener('scroll', schedule, true)
  }

  return (
    <>
      <div
        ref={gridRef}
        className={cn(className ?? 'grid grid-cols-12 gap-4 grid-flow-row-dense auto-rows-min')}
      >
        {renderOrder.map((item) => {
          const isDragging = drag?.activeId === item.id
          return (
            <div
              key={item.id}
              ref={(el) => {
                if (el) slotRef.current.set(item.id, el)
                else slotRef.current.delete(item.id)
              }}
              data-id={item.id}
              data-dragging={isDragging || undefined}
              onPointerDown={
                disabled
                  ? undefined
                  : (e) => {
                      // Don't start a drag on interactive children (links, buttons,
                      // inputs, code blocks). The handle is the entire card body
                      // EXCEPT explicit interactive areas. Walk up from target to
                      // current target and bail if we hit one.
                      let node: HTMLElement | null = e.target as HTMLElement
                      while (node && node !== e.currentTarget) {
                        if (
                          node.matches(
                            'a, button, input, textarea, select, label, [role="button"], [data-no-drag]',
                          )
                        ) {
                          return
                        }
                        node = node.parentElement
                      }
                      startDrag(item.id, e)
                    }
              }
              style={disabled ? undefined : { touchAction: 'none' }}
              className={cn(
                spanClassName(item),
                'group relative will-change-transform',
                drag ? 'transition-[transform,opacity] duration-200 ease-out' : 'transition-opacity duration-200',
                !disabled && 'cursor-grab active:cursor-grabbing',
              )}
            >
              {!disabled ? (
                // Drag handle — sits in the card's header row (cards use p-5),
                // to the right of the panel's "open" arrow. Faint at rest,
                // solid on hover so the affordance is discoverable but quiet.
                <span
                  aria-hidden
                  title="Drag to rearrange"
                  className={cn(
                    'pointer-events-none absolute right-5 top-5 z-10 flex h-6 w-6 items-center justify-center rounded-md text-content-subtle transition-opacity',
                    isDragging ? 'opacity-0' : 'opacity-35 group-hover:opacity-100',
                  )}
                >
                  <DragHandleGlyph />
                </span>
              ) : null}

              {/* The card content is muted while dragging — the floating
                  ghost is the visible artifact and the slot becomes a
                  dashed drop area. */}
              <div className={cn('h-full transition-opacity duration-200', isDragging && 'opacity-0')}>
                {render(item, !!isDragging)}
              </div>

              {isDragging ? <DropZonePlaceholder /> : null}
            </div>
          )
        })}
      </div>

      {drag && typeof document !== 'undefined'
        ? createPortal(
            <Ghost drag={drag} item={items.find((x) => x.id === drag.activeId)!} render={render} />,
            document.body,
          )
        : null}
    </>
  )
}

function Ghost<T extends { id: string }>({
  drag,
  item,
  render,
}: {
  drag: DragState
  item: T
  render: (item: T, dragging: boolean) => ReactNode
}) {
  const style: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: drag.width,
    maxHeight: '70vh',
    // No transition — the position is already frame-synced via rAF, and any
    // easing here reads as the ghost lagging the cursor.
    transform: `translate3d(${drag.pointerX - drag.offsetX}px, ${drag.pointerY - drag.offsetY}px, 0) rotate(1.2deg) scale(1.02)`,
    pointerEvents: 'none',
    zIndex: 80,
    willChange: 'transform',
  }
  return (
    <div
      style={style}
      className="overflow-hidden rounded-2xl shadow-2xl ring-2 ring-brand-400/60 ring-offset-2 ring-offset-transparent"
    >
      <div className="bg-surface-raised/95 backdrop-blur-sm">{render(item, true)}</div>
    </div>
  )
}

function DropZonePlaceholder() {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-400/80 bg-brand-50/60 dark:bg-brand-500/10 backdrop-blur-[1px]',
      )}
      style={{ animation: 'adhar-dropzone-pulse 1.4s ease-in-out infinite' }}
    >
      <span className="flex items-center gap-1.5 rounded-md bg-surface-raised/85 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-300 shadow-sm ring-1 ring-brand-200">
        <DropArrowGlyph /> Drop here
      </span>
      <style>{`
        @keyframes adhar-dropzone-pulse {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  )
}

function DropArrowGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  )
}

function DragHandleGlyph() {
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
