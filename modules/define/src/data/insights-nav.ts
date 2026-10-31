import { useCallback, useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { setStoredProjectId } from './plane.ts'
import { clean, decode, type DefineParams, encode } from './insights-query.ts'

export * from './insights-query.ts'

/**
 * Deep links for Define's insights pages (dashboard, My Work, Reports, OKRs,
 * Pages) and the drill-down into Issues.
 *
 * The host route owns `?section=`; these views keep their own selection next
 * to it (`?section=reports&report=velocity&cycle=…`, `?section=pages&page=…`).
 * Adapted from Design's `deep-link.ts`: the shared host router when present,
 * else the History API + `popstate`.
 *
 * Drill-downs land on Issues with a JQL-like query in `q`
 * (`/define?section=issues&q=project = CON AND assignee = me`) — the syntax
 * the Issues view parses. Every query the insights pages emit is built by
 * `jql()` below, so the vocabulary lives in one place:
 *
 *   project = KEY                 assignee = me | "Display Name" | EMPTY
 *   creator = me                  category in (backlog, unstarted, started, completed, cancelled)
 *   status = "In Review"          priority in (urgent, high)
 *   label = bug                   sprint = "Sprint 4"    epic = "Auth"
 *   due < today() | due <= +7d    created >= -30d        resolved >= -30d
 *   key = CON-12
 *
 * — the canonical field names of the Issues view's WQL (`work-ql.ts`).
 */

const KEYS = ['report', 'cycle', 'module', 'range', 'page', 'mode', 'quarter', 'objective', 'tab', 'q', 'issue', 'project'] as const

function readSearch(): Record<string, string> {
  if (typeof location === 'undefined') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = decode(v)
  return out
}

function pick(s: Record<string, unknown>): DefineParams {
  const out: DefineParams = {}
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

export function useDefineParams(): DefineParams {
  const router = useRouter({ warn: false })
  const [params, setParams] = useState<DefineParams>(() => pick(readSearch()))
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

export function useSetDefineParams() {
  const router = useRouter({ warn: false })
  return useCallback(
    (patch: DefineParams, opts: { push?: boolean } = {}) => {
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

/** Absolute link to the current page with `patch` applied — for "Copy link". */
export function defineLink(patch: DefineParams): string {
  if (typeof location === 'undefined') return ''
  const search = clean({ ...readSearch(), ...patch })
  const qs = new URLSearchParams(Object.entries(search).map(([k, v]) => [k, encode(v)])).toString()
  return `${location.origin}${currentPath()}${qs ? `?${qs}` : ''}`
}

/**
 * Navigate to a Define section. A `project` param also becomes the stored
 * active project, so the target view opens on it.
 */
export function useOpenDefine() {
  const router = useRouter({ warn: false })
  return useCallback(
    (section: string, params: DefineParams = {}) => {
      if (params.project) setStoredProjectId(params.project)
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

