import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * The sidebar's active-row indicator — one rail that SLIDES between rows
 * instead of a mark that blinks out in one place and in at another.
 *
 * It tracks TOP-LEVEL rows only (see `data-nav-active` in nav-item.tsx). Sub
 * items have their own smaller rail, and when a sub item is the current route
 * this one parks on its parent, so the column shows both "which section" and
 * "which page" without two full-height marks competing.
 *
 * Why a single moving element rather than a border on each row: continuous
 * motion between the old and new position is what tells the eye the two rows
 * are the same control in two states. Per-row borders give no such signal —
 * navigation reads as the highlight teleporting, and at 14 rows over three
 * sections the user re-finds their place on every click.
 *
 * It measures with getBoundingClientRect against the scroll container rather
 * than offsetTop, because offsetTop is relative to the nearest POSITIONED
 * ancestor: the rows set `relative` for their own hover affordances, and any
 * new wrapper that happens to be positioned would silently shift every
 * measurement. Adding the container's scrollTop converts the viewport-relative
 * delta back into content space, which is the coordinate system an absolutely
 * positioned child of a scroll container lives in.
 */
export function NavShuttle({
  containerRef,
  /** Anything that can move rows: collapse, section visibility, the route. */
  deps,
  collapsed,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  deps: unknown[]
  collapsed?: boolean
}) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null)
  // First paint must not animate: a rail that flies in from y=0 on load looks
  // like a glitch rather than a transition.
  const settled = useRef(false)

  useLayoutEffect(() => {
    const host = containerRef.current
    if (!host) return

    const measure = () => {
      const active = host.querySelector<HTMLElement>('[data-nav-active="true"]')
      if (!active) {
        setBox(null)
        return
      }
      const hostRect = host.getBoundingClientRect()
      const rect = active.getBoundingClientRect()
      setBox({ top: rect.top - hostRect.top + host.scrollTop, height: rect.height })
    }

    measure()
    // Two observers, because rows move for two different reasons: the sidebar
    // or a row changes size (resize), and the accordion adds or removes rows
    // above the active one (mutation). Missing either leaves the rail parked
    // next to the wrong row with no error.
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    const mo = new MutationObserver(measure)
    mo.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-nav-active', 'class'],
    })
    const raf = requestAnimationFrame(() => {
      measure()
      settled.current = true
    })
    return () => {
      ro.disconnect()
      mo.disconnect()
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, collapsed, ...deps])

  // Re-measure after fonts load: a late webfont changes row heights, and the
  // rail would otherwise keep the metrics of the fallback face.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
    if (!fonts?.ready) return
    let cancelled = false
    void fonts.ready.then(() => {
      if (cancelled) return
      const host = containerRef.current
      const active = host?.querySelector<HTMLElement>('[data-nav-active="true"]')
      if (!host || !active) return
      const hostRect = host.getBoundingClientRect()
      const rect = active.getBoundingClientRect()
      setBox({ top: rect.top - hostRect.top + host.scrollTop, height: rect.height })
    })
    return () => {
      cancelled = true
    }
  }, [containerRef])

  return (
    <span
      aria-hidden
      className={cn(
        // `top-0` is load-bearing. Without an explicit `top`, an absolutely
        // positioned box stays at its STATIC position — where it would have
        // sat in flow — which here is below the container's `pt-2`. The
        // translateY from `measure()` is relative to the container's padding
        // box, so the two stacked and the rail rendered 8px below the row it
        // was marking, at every row, in both sidebar states.
        'pointer-events-none absolute top-0 z-10 w-[3px] rounded-full',
        'bg-linear-to-b from-brand-400 to-brand-600',
        // Inset rather than flush at x=0: the sidebar is the leftmost element
        // on the page, so `left-0` put the rail hard against the window edge
        // where it read as clipped chrome rather than as a marker.
        'left-0.5',
        // A short overshoot-free ease: the rail should arrive before the page
        // content does, or the motion reads as lag rather than polish.
        settled.current
          ? 'transition-[transform,height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
          : '',
        'motion-reduce:transition-none',
      )}
      style={{
        transform: `translateY(${box?.top ?? 0}px)`,
        height: box?.height ?? 0,
        opacity: box ? 1 : 0,
        // Set here, not as `shadow-[...]`: Tailwind's arbitrary shadow sets
        // the geometry but leaves `--tw-shadow-color` unset, so the glow
        // computed to a fully transparent shadow and never painted.
        boxShadow: '0 0 10px -1px var(--color-brand-500)',
      }}
    />
  )
}
