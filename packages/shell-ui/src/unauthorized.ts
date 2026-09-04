/**
 * Cross-boundary "session expired" signal.
 *
 * Any data layer that sees a `401 Unauthorized` from a BFF call calls
 * {@link notifyUnauthorized}; the host shell subscribes once via
 * {@link subscribeUnauthorized} and redirects to the login screen. A plain
 * `CustomEvent` on `globalThis` is used deliberately — shell-ui is NOT an MF
 * singleton, so a window event is the reliable way to reach the host router
 * from a federated remote without shared module state.
 */

export const UNAUTHORIZED_EVENT = 'adhar:unauthorized'

/**
 * Announce that a request came back 401. Browser-only (no-op on the server,
 * where a 401 from an upstream must never redirect anything). Coalesced: rapid
 * bursts (a page firing many queries at once) collapse into a single event
 * within a short window so the shell navigates just once.
 */
let lastFiredAt = 0
export function notifyUnauthorized(): void {
  // Browser-only: a 401 seen server-side (BFF → upstream) must never redirect.
  if (typeof document === 'undefined') return
  const g = globalThis as unknown as {
    dispatchEvent?: (e: Event) => boolean
    CustomEvent?: typeof CustomEvent
  }
  if (typeof g.dispatchEvent !== 'function' || typeof g.CustomEvent !== 'function') return
  const now = Date.now()
  if (now - lastFiredAt < 1500) return
  lastFiredAt = now
  try {
    g.dispatchEvent(new g.CustomEvent(UNAUTHORIZED_EVENT))
  } catch {
    /* environments without CustomEvent construction — ignore */
  }
}

/** Subscribe to the unauthorized signal. Returns an unsubscribe fn. */
export function subscribeUnauthorized(handler: () => void): () => void {
  const g = globalThis as unknown as {
    addEventListener?: (t: string, h: () => void) => void
    removeEventListener?: (t: string, h: () => void) => void
  }
  if (typeof g.addEventListener !== 'function') return () => {}
  g.addEventListener(UNAUTHORIZED_EVENT, handler)
  return () => g.removeEventListener?.(UNAUTHORIZED_EVENT, handler)
}
