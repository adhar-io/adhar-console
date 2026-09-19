import { useEffect, useState, type RefObject } from 'react'

/**
 * The observed width of an element, in px (0 before first measurement).
 *
 * For layout that depends on how much room a COMPONENT has rather than how
 * wide the window is. The two are not the same in this console: the shell's
 * sidebar takes 256px when expanded and 64px when collapsed, so a page at a
 * 1024px viewport actually has 768px — and a media query asking
 * `min-width: 1024px` happily grants a three-column layout to a container
 * that cannot hold one. That is exactly how the Adhar AI page ended up
 * rendering its conversation at 172px wide, and why collapsing the sidebar
 * appeared to "break" the layout: it was the only thing that gave the column
 * its width back.
 *
 * `ResizeObserver` also fires on the sidebar's collapse transition, so the
 * layout settles with the animation instead of a frame behind it.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
