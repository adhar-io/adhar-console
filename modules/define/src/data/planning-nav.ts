import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * Deep links for Define's planning pages — Projects, Sprints, Epics,
 * Roadmap, Releases, Intake, Automation.
 *
 * The host route owns `?section=`; each view keeps its selection beside it:
 *
 *   ?section=projects&pd=<plane project>&ptab=workflow     project drawer + tab
 *   ?section=cycles&sprint=<cycle>&stab=burndown           sprint detail + tab
 *   ?section=cycles&tab=planning                           sprint planning board
 *   ?section=modules&epic=<module>                         epic detail
 *   ?section=roadmap&zoom=month&group=epic                 roadmap view
 *   ?section=releases&release=<id>                         release detail
 *
 * Same mechanics as the other Define deep links: the shared host router when
 * present, else the History API + `popstate`.
 */

export interface PlanningParams {
  /** Section-level tab (sprints: list | planning | velocity). */
  tab?: string
  /** Open project drawer (Plane project id) and its tab. */
  pd?: string
  ptab?: string
  /** Open sprint (Plane cycle id) and its tab. */
  sprint?: string
  stab?: string
  /** Open epic (Plane module id). */
  epic?: string
  /** Open release id. */
  release?: string
  /** Roadmap zoom / grouping. */
  zoom?: string
  group?: string
  /** Projects layout (cards | table) and health filter. */
  layout?: string
  health?: string
}

const KEYS = ['tab', 'pd', 'ptab', 'sprint', 'stab', 'epic', 'release', 'zoom', 'group', 'layout', 'health'] as const

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

function pick(s: Record<string, unknown>): PlanningParams {
  const out: PlanningParams = {}
  for (const k of KEYS) if (s[k] != null && s[k] !== '') out[k] = String(s[k])
  return out
}

const currentPath = () => (typeof location !== 'undefined' && location.pathname !== '/' ? location.pathname : '/define')

function writeUrl(path: string, search: Record<string, string>, replace: boolean) {
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)])).toString()
  const url = `${path}${qs ? `?${qs}` : ''}`
  if (replace) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

export function usePlanningParams(): PlanningParams {
  const router = useRouter({ warn: false })
  const [params, setParams] = useState<PlanningParams>(() => pick(readSearch()))
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

/** Patch the planning params of the current page (`push` adds a history entry). */
export function useSetPlanningParams() {
  const router = useRouter({ warn: false })
  return useCallback(
    (patch: PlanningParams, opts: { push?: boolean } = {}) => {
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

/** Navigate to another Define section with params. */
export function useOpenSection() {
  const router = useRouter({ warn: false })
  return useCallback(
    (section: string, params: Record<string, string | undefined> = {}) => {
      const search = clean({ section, ...params })
      if (router) {
        void router.navigate({ to: '/define', search: search as never })
        return
      }
      writeUrl('/define', search, false)
    },
    [router],
  )
}

/** Plain href for a console deep link (anchors, notifications, copy-link). */
export function planningHref(section: string, params: Record<string, string | undefined> = {}, phase = 'define'): string {
  const qs = new URLSearchParams(Object.entries(clean({ section, ...params })).map(([k, v]) => [k, encode(v)])).toString()
  return `/${phase}${qs ? `?${qs}` : ''}`
}

/** Absolute URL of the current page with `patch` applied. */
export function planningLink(patch: PlanningParams): string {
  if (typeof location === 'undefined') return ''
  const search = clean({ ...readSearch(), ...patch })
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)])).toString()
  return `${location.origin}${currentPath()}${qs ? `?${qs}` : ''}`
}
