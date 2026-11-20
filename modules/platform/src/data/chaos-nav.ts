import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { type ChaosParams, readChaosParams } from './chaos-report-hooks.ts'

/**
 * The Chaos page's deep-link params, kept in step with the URL both ways.
 *
 * The page used to read the URL once and then only write it, so anything that
 * moved the URL from outside — the browser's Back, the Deliver sidebar link
 * (`?section=chaos` with nothing else), an Assist or notification link to
 * `?run=` while the page was open — left the drawers showing what the URL no
 * longer said. Now the params are re-read on every navigation:
 *
 *   • on `popstate` (Back / Forward), and
 *   • on the host router's history notifications — read in a microtask,
 *     because TanStack's history notifies BEFORE it writes `window.history`,
 *     and reading the URL in the callback sees the previous one (every drawer
 *     one navigation behind; X "not closing").
 *
 * Opening a drawer pushes a history entry, so Back closes it; switching from
 * one drawer to another replaces that entry; closing the drawer this page
 * pushed goes back to the entry beneath it rather than stacking a second
 * drawer-less entry (which would make the next Back do nothing). Tabs and
 * filters replace: they are not navigation.
 */

/** The params that open a drawer. Exactly one is open at a time. */
export const DRAWER_KEYS = ['run', 'gameday', 'job', 'report', 'compare'] as const

/** The open drawer as `key=value`, or undefined when none is. */
export function drawerOf(p: ChaosParams): string | undefined {
  for (const k of DRAWER_KEYS) if (p[k]) return `${k}=${p[k]}`
  return undefined
}

/** `cur` with `patch` applied; empty values are removed. */
export function mergeParams(cur: ChaosParams, patch: ChaosParams): ChaosParams {
  const next: ChaosParams = { ...cur }
  for (const [k, v] of Object.entries(patch) as Array<[keyof ChaosParams, string | undefined]>) {
    if (v) next[k] = v
    else delete next[k]
  }
  return next
}

export type NavMode = 'push' | 'replace' | 'back'

/** The params other than the drawer's — the tab and filters the drawer sits over. */
function contextOf(p: ChaosParams): string {
  return JSON.stringify(Object.entries(p).filter(([k]) => !(DRAWER_KEYS as readonly string[]).includes(k)).sort())
}

/**
 * Whether a push opened a drawer over the page as it was (same tab, same
 * filters). Only then is the entry beneath "this page without the drawer",
 * so only then may closing it go back: a drawer opened together with a tab
 * change (a game day started from the Library opens on Game days) would
 * otherwise close onto the Library.
 */
export function opensInPlace(cur: ChaosParams, patch: ChaosParams): boolean {
  return contextOf(cur) === contextOf(mergeParams(cur, patch))
}

/**
 * How a patch reaches the history. `pushed` says the drawer open now is one
 * this page pushed an entry for (so going back lands on the same page without
 * it); a drawer that arrived with the URL — a pasted link, a reload — has no
 * entry beneath it to go back to.
 */
export function navMode(cur: ChaosParams, patch: ChaosParams, pushed: boolean): NavMode {
  const next = mergeParams(cur, patch)
  const was = drawerOf(cur)
  const now = drawerOf(next)
  if (!was && now) return 'push'
  if (was && !now && pushed) {
    // Only a pure close may go back: a close that also changes the tab (a
    // drawer's "Go to run reports") must land where it asked to.
    if (contextOf(cur) === contextOf(next)) return 'back'
  }
  return 'replace'
}

const same = (a: ChaosParams, b: ChaosParams) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

type RouterLike = {
  history?: {
    location?: { search?: string; pathname?: string }
    subscribe?(fn: () => void): () => void
    back?(): void
  }
  navigate?(opts: Record<string, unknown>): Promise<void> | void
} | null | undefined

/** The search of the location the app is on now (the router's, which leads `window.location`). */
function currentSearch(router: RouterLike): string {
  const s = router?.history?.location?.search
  return typeof s === 'string' ? s : typeof location === 'undefined' ? '' : location.search
}

function currentPath(router: RouterLike): string {
  return router?.history?.location?.pathname ?? (typeof location === 'undefined' ? '/' : location.pathname)
}

/** Encode a value the way TanStack Router does, so either side reads it back. */
function encode(v: string): string {
  try {
    JSON.parse(v)
    return JSON.stringify(v)
  } catch {
    return v
  }
}

/** Without a router (a standalone remote): the History API, announced with popstate. */
function writeUrl(patch: ChaosParams, push: boolean) {
  if (typeof location === 'undefined') return
  const q = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v) q.set(k, encode(v))
    else q.delete(k)
  }
  const qs = q.toString()
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`
  if (push) history.pushState(history.state, '', url)
  else history.replaceState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

export function useChaosParams(): [ChaosParams, (patch: ChaosParams) => void] {
  const router = useRouter({ warn: false }) as unknown as RouterLike
  const [params, setParams] = useState<ChaosParams>(() => readChaosParams(currentSearch(router)))
  const pushed = useRef(false)

  useEffect(() => {
    const sync = () => {
      const next = readChaosParams(currentSearch(router))
      if (!drawerOf(next)) pushed.current = false
      setParams((cur) => (same(cur, next) ? cur : next))
    }
    sync()
    globalThis.addEventListener('popstate', sync)
    const unsubscribe = router?.history?.subscribe?.(() => queueMicrotask(sync))
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router])

  const patch = useCallback((p: ChaosParams) => {
    // The URL is the truth, not the last render: two patches in one tick
    // (close a drawer, then switch tab) must compose.
    const cur = readChaosParams(currentSearch(router))
    const mode = navMode(cur, p, pushed.current)
    const next = mergeParams(cur, p)
    setParams(next)
    if (mode === 'back') {
      pushed.current = false
      if (router?.history?.back) router.history.back()
      else history.back()
      return
    }
    if (mode === 'push') pushed.current = opensInPlace(cur, p)
    if (router?.navigate) {
      void router.navigate({
        to: currentPath(router),
        search: ((prev: Record<string, unknown>) => {
          const out: Record<string, unknown> = { ...prev }
          for (const [k, v] of Object.entries(p)) {
            if (v) out[k] = v
            else delete out[k]
          }
          return out
        }) as never,
        replace: mode === 'replace',
      })
      return
    }
    writeUrl(p, mode === 'push')
  }, [router])

  return [params, patch]
}
