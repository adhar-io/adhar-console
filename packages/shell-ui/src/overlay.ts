import { useEffect, useRef } from 'react'

/**
 * The two behaviours every overlay owes the user: ESC closes it, and the page
 * behind it stops scrolling while it is open.
 *
 * `Modal` had both inline, but the console also has ~39 hand-rolled drawers
 * built straight on `createPortal` (detail panels, fullscreen editors, log
 * consoles) because they need layouts `Modal` does not offer. Nine of them had
 * grown a click-the-scrim affordance and no keyboard path at all, so the same
 * gesture that dismissed one panel did nothing on the next — the kind of
 * inconsistency that is invisible in review and obvious in use.
 *
 * Kept as a hook rather than a wrapper component so it composes with any
 * markup: the drawers differ in layout, not in dismissal semantics.
 *
 * @param open   whether the overlay is currently mounted/visible
 * @param onClose invoked on ESC
 * @param opts.lockScroll set false for non-blocking overlays (inline popovers,
 *        flyouts) that should not freeze the page behind them
 */
export function useOverlayDismiss(
  open: boolean,
  onClose: () => void,
  opts: { lockScroll?: boolean } = {},
) {
  const { lockScroll = true } = opts

  // Most callers pass an inline arrow (`() => setOpen(false)`), which is a new
  // function every render. Holding it in a ref keeps the listener subscribed
  // once per open/close rather than torn down and re-added on every render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open || !lockScroll) return
    if (typeof document === 'undefined') return
    // Restore the previous value rather than clearing it: nested overlays would
    // otherwise unlock the page when the inner one closes.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open, lockScroll])
}
