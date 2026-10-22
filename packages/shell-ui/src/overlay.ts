import { type RefObject, useEffect, useRef } from 'react'
import { FOCUSABLE_SELECTOR, isTopOverlay, pushOverlay } from './overlay-stack.ts'

/**
 * The behaviours every overlay owes the user: ESC closes it (only the topmost
 * one, when overlays are stacked), the page behind it stops scrolling while it
 * is open, and — when given its container — keyboard focus moves into it, stays
 * there, and goes back where it came from on close.
 *
 * `Modal` had these inline, but the console also has ~39 hand-rolled drawers
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
 * @param opts.focusRef the overlay's container. When set, focus moves into it
 *        on open, Tab cycles inside it, and focus returns to the element that
 *        opened it on close (WAI-ARIA dialog pattern). Opt-in so a non-modal
 *        flyout doesn't steal focus from the page.
 */
export function useOverlayDismiss(
  open: boolean,
  onClose: () => void,
  opts: { lockScroll?: boolean; focusRef?: RefObject<HTMLElement | null> } = {},
) {
  const { lockScroll = true, focusRef } = opts

  // Most callers pass an inline arrow (`() => setOpen(false)`), which is a new
  // function every render. Holding it in a ref keeps the listener subscribed
  // once per open/close rather than torn down and re-added on every render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const idRef = useRef<symbol | null>(null)
  if (!idRef.current) idRef.current = Symbol('overlay')

  useEffect(() => {
    if (!open) return
    const id = idRef.current!
    const pop = pushOverlay(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isTopOverlay(id)) return
      // An inner control already consumed this ESC (a combobox closing its
      // list), or an IME is composing — neither is "close the overlay".
      if (e.defaultPrevented || e.isComposing) return
      onCloseRef.current()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => {
      globalThis.removeEventListener('keydown', onKey)
      pop()
    }
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

  useEffect(() => {
    if (!open || !focusRef || typeof document === 'undefined') return
    const opener = document.activeElement as HTMLElement | null
    const id = idRef.current!
    // After paint: the portal content is mounted, and a child that took focus
    // itself (React's `autoFocus`) is left alone. Otherwise prefer an explicit
    // `data-autofocus`, then the first form field — landing on the header's
    // Close button would make Enter dismiss the dialog — then the container
    // (give it tabIndex={-1}) so a screen reader announces the dialog.
    const raf = requestAnimationFrame(() => {
      const root = focusRef.current
      if (!root || root.contains(document.activeElement)) return
      const target = root.querySelector<HTMLElement>('[data-autofocus]') ??
        root.querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])',
        ) ??
        root
      target.focus({ preventScroll: true })
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTopOverlay(id)) return
      const root = focusRef.current
      if (!root) return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      // Return focus to the opener if it is still on the page.
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        opener.focus({ preventScroll: true })
      }
    }
  }, [open, focusRef])
}
