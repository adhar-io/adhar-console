import { useEffect, type RefObject } from 'react'

/**
 * Close a popover when the pointer goes down anywhere outside it.
 *
 * The console's popovers used to rely on a transparent full-screen backdrop
 * behind the panel to catch outside clicks. That works only when nothing on
 * the page sits above the backdrop — and the sidebar, the topbar and every
 * drawer do, so a click on any of them left the panel open. Listening on the
 * document instead and asking "was this inside the panel?" needs no backdrop
 * and no z-index arithmetic, and lets the outside click do its own job too
 * (a click on a nav link closes the menu AND navigates).
 *
 * `pointerdown` rather than `click`, so the panel is gone before the outside
 * element handles its own click, and so a drag that starts outside closes it.
 * Escape is handled here as well, because every popover wants both.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
  opts: { escape?: boolean } = {},
): void {
  const escape = opts.escape ?? true
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent | MouseEvent) => {
      const el = ref.current
      const target = e.target as Node | null
      if (!el || !target) return
      if (el.contains(target)) return
      // Portalled children (a dialog opened from the menu) are outside the
      // DOM subtree but inside the interaction: leave those alone.
      if (target instanceof Element && target.closest('[role="dialog"],[data-popover-keep]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (escape && e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, onClose, active, escape])
}
