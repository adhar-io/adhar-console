import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * Deep links inside Decide. The host owns `?section=`; each page keeps its
 * own state next to it (`?section=dora&range=90d&project=adhar&group=app`), so
 * a tile, a pasted link or a shared view lands on exactly what was on screen.
 *
 * Same contract as Develop's `nav.ts`: use the host router when it is shared,
 * else fall back to the History API + `popstate`. Values are encoded the way
 * TanStack Router writes them (a string that parses as JSON is quoted).
 */

export const PARAM_KEYS = [
  'range',
  'project',
  'env',
  'group',
  'metric',
  'tab',
  'dim',
  'label',
  'q',
  'view',
  'budget',
] as const

export type ParamKey = (typeof PARAM_KEYS)[number]
export type DecideParams = Partial<Record<ParamKey, string>>
export type DecideSection = 'dashboard' | 'dora' | 'spend' | 'dashboards' | 'questions' | 'sql' | 'databases' | 'pulses'

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

function pick(s: Record<string, unknown>): DecideParams {
  const out: DecideParams = {}
  for (const k of PARAM_KEYS) if (s[k] != null && s[k] !== '') out[k] = String(s[k])
  return out
}

function clean(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = String(v)
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

export function useDecideParams(): DecideParams {
  const router = useRouter({ warn: false })
  const [params, setParams] = useState<DecideParams>(() => pick(readSearch()))
  useEffect(() => {
    const sync = () =>
      setParams((cur) => {
        const next = pick(readSearch())
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
      })
    sync()
    globalThis.addEventListener('popstate', sync)
    // TanStack Router notifies before it writes the URL (`window.history` is
    // updated in a microtask), so reading `location` here would see the
    // previous URL — every drawer one navigation behind. Read after it.
    const unsubscribe = router?.history?.subscribe?.(() => queueMicrotask(sync))
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router])
  return params
}

/** Patch this page's params in place (no new history entry). `''` clears one. */
export function useSetDecideParams() {
  const router = useRouter({ warn: false })
  return useCallback(
    (patch: DecideParams) => {
      if (router) {
        void router.navigate({
          to: currentPath(),
          search: ((prev: Record<string, unknown>) => clean({ ...prev, ...patch })) as never,
          replace: true,
        })
        return
      }
      writeUrl(currentPath(), clean({ ...readSearch(), ...patch }), true)
    },
    [router],
  )
}

/** An href to a Decide section with params (`/decide?section=dora&range=30d`). */
export function decideHref(section: DecideSection, params: DecideParams = {}): string {
  const qs = new URLSearchParams(Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)])).toString()
  return `/decide?${qs}`
}

/** Navigate to a Decide section (pushes history). */
export function useGoDecide() {
  const router = useRouter({ warn: false })
  return useCallback(
    (section: DecideSection, params: DecideParams = {}) => {
      const search = clean({ section, ...params })
      if (router) {
        void router.navigate({ to: '/decide', search: search as never })
        return
      }
      writeUrl('/decide', search, false)
    },
    [router],
  )
}

/** Links to other phases (Deliver / Discover / Develop) — plain hrefs. */
export function phaseHref(phase: string, section: string, params: Record<string, string | undefined> = {}): string {
  const qs = new URLSearchParams(Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)])).toString()
  return `/${phase}?${qs}`
}
