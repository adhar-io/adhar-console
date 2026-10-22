import { globalSingleton } from '@adhar/utils'

/**
 * The page-wide stack of open overlays, newest last.
 *
 * Every open overlay used to own a window `keydown` listener that closed it on
 * ESC, so with a confirm dialog open over a detail drawer one ESC closed BOTH —
 * the drawer the person was still working in went away with the dialog. Only
 * the topmost overlay may react; the stack says which one that is.
 *
 * Kept on `globalThis` (see `globalSingleton`): the host and every federated
 * remote bundle their own copy of shell-ui, and a drawer from one remote can
 * open a dialog from another.
 */
const stack = globalSingleton('shell-ui.overlay-stack', () => [] as symbol[])

/** Register an open overlay; returns the function that unregisters it. */
export function pushOverlay(id: symbol): () => void {
  stack.push(id)
  return () => {
    const i = stack.lastIndexOf(id)
    if (i !== -1) stack.splice(i, 1)
  }
}

/** True when `id` is the most recently opened overlay still open. */
export function isTopOverlay(id: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id
}

/** The focusable descendants of `root`, in tab order (enough for a focus trap). */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',')
