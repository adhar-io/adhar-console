import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * Deep links for the BI sections. The host route owns `?section=`; each BI
 * view keeps its selection next to it — `?section=dashboards&dashboard=12&tab=3`,
 * `?section=questions&question=40`, `?section=databases&db=2&table=118`,
 * `?section=sql&db=2&question=40` — so a pasted URL, a toast action or the
 * "copy link" button lands on the exact thing.
 *
 * Same contract as the Develop module's `nav.ts`: use the host router when it
 * is shared, fall back to the History API + `popstate` when it isn't, and
 * encode values the way TanStack does (a numeric id is written quoted and
 * read back as the string it was).
 */

export type BiSection = 'dashboards' | 'questions' | 'sql' | 'databases' | 'pulses'

export interface BiParams {
  dashboard?: string
  /** Dashboard tab id. */
  tab?: string
  question?: string
  db?: string
  table?: string
  /** Library filter: collection id, `root`, `favorites`, `recent`, `verified`. */
  collection?: string
  /** Free-text search. */
  q?: string
  /** Page-level view (Pulses: `subscriptions` / `alerts`). */
  view?: string
}

const KEYS = ['dashboard', 'tab', 'question', 'db', 'table', 'collection', 'q', 'view'] as const

function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = String(v)
  return out
}

function decode(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw)
      if (typeof v === 'string') return v
    } catch { /* keep raw */ }
  }
  return raw
}

function encode(v: string): string {
  try {
    JSON.parse(v)
    return JSON.stringify(v)
  } catch {
    return v
  }
}

function readSearch(): Record<string, string> {
  if (typeof location === 'undefined') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = decode(v)
  return out
}

function pick(s: Record<string, unknown>): BiParams {
  const out: BiParams = {}
  for (const k of KEYS) if (s[k] != null && s[k] !== '') out[k] = String(s[k])
  return out
}

function writeUrl(path: string, search: Record<string, string>, replace: boolean) {
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)])).toString()
  const url = `${path}${qs ? `?${qs}` : ''}`
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

function currentPath(): string {
  return typeof location !== 'undefined' && location.pathname !== '/' ? location.pathname : '/decide'
}

export function useBiParams(): BiParams {
  const router = useRouter({ warn: false })
  const [params, setParams] = useState<BiParams>(() => pick(readSearch()))
  useEffect(() => {
    const sync = () =>
      setParams((cur) => {
        const next = pick(readSearch())
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
      })
    sync()
    globalThis.addEventListener('popstate', sync)
    const unsubscribe = router?.history?.subscribe?.(sync)
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router])
  return params
}

/**
 * Patch the params of the current page. `push` adds a history entry (opening
 * a dashboard should be undoable with Back); filters replace in place.
 */
export function useSetBiParams() {
  const router = useRouter({ warn: false })
  return useCallback(
    (patch: BiParams, opts: { push?: boolean } = {}) => {
      const replace = !opts.push
      if (router) {
        void router.navigate({
          to: currentPath(),
          search: ((prev: Record<string, unknown>) => clean({ ...prev, ...patch })) as never,
          replace,
        })
        return
      }
      writeUrl(currentPath(), clean({ ...readSearch(), ...patch }), replace)
    },
    [router],
  )
}

/** Go to another BI section, optionally straight to one item. */
export function useGoBi() {
  const router = useRouter({ warn: false })
  return useCallback(
    (section: BiSection, params: BiParams = {}) => {
      const search = clean({ section, ...params })
      const to = currentPath()
      if (router) {
        void router.navigate({ to, search: search as never })
        return
      }
      writeUrl(to, search, false)
    },
    [router],
  )
}

/** Absolute console URL for a BI item — what "Copy link" copies. */
export function biHref(section: BiSection, params: BiParams = {}): string {
  const qs = new URLSearchParams(Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)])).toString()
  const origin = typeof location !== 'undefined' ? location.origin : ''
  return `${origin}${currentPath()}?${qs}`
}
