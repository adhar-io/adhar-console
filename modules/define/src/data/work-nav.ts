import { useCallback, useEffect, useState } from 'react'

/**
 * Deep links for the work-item surfaces (Issues, Board, Backlog, Views).
 *
 * The host route owns `?section=`; these views keep their own selection next
 * to it so a toast, a copied link or a notification lands on the exact item:
 *
 *   /define?section=issues&issue=<projectId>/<issueId>
 *   /define?section=issues&view=<savedViewId>
 *   /define?section=issues&q=<url-encoded WQL>
 *   /define?section=board&issue=…    /define?section=backlog&issue=…
 *
 * The Define remote does not depend on the host's router package, so this
 * uses the History API and announces changes with `popstate`, which the host
 * router (and every hook below) listens to.
 */

export interface WorkParams {
  /** `<projectId>/<issueId>` of the open work item. */
  issue?: string
  /** Saved view id. */
  view?: string
  /** WQL query text. */
  q?: string
  /** `1` — open the create dialog. */
  new?: string
}

const KEYS = ['issue', 'view', 'q', 'new'] as const

function decode(raw: string): string {
  // TanStack Router writes strings that look like JSON quoted; read them back.
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw)
      if (typeof v === 'string') return v
    } catch { /* keep raw */ }
  }
  return raw
}

function readSearch(): Record<string, string> {
  if (typeof location === 'undefined') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = decode(v)
  return out
}

function pick(s: Record<string, string>): WorkParams {
  const out: WorkParams = {}
  for (const k of KEYS) if (s[k]) out[k] = s[k]
  return out
}

function write(path: string, search: Record<string, string | undefined>, push: boolean) {
  const qs = new URLSearchParams(Object.entries(search).filter(([, v]) => v !== undefined && v !== '') as Array<[string, string]>).toString()
  const url = `${path}${qs ? `?${qs}` : ''}`
  if (typeof history === 'undefined') return
  if (`${location.pathname}${location.search}` === url) return
  if (push) history.pushState(history.state, '', url)
  else history.replaceState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

const currentPath = () => (typeof location !== 'undefined' && location.pathname !== '/' ? location.pathname : '/define')

/** The work-item params on the current URL (re-renders on navigation). */
export function useWorkParams(): WorkParams {
  const [params, setParams] = useState<WorkParams>(() => pick(readSearch()))
  useEffect(() => {
    const sync = () =>
      setParams((cur) => {
        const next = pick(readSearch())
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
      })
    sync()
    globalThis.addEventListener('popstate', sync)
    return () => globalThis.removeEventListener('popstate', sync)
  }, [])
  return params
}

/** Patch the params; `push` adds a history entry (opening an item) so Back closes it. */
export function useSetWorkParams() {
  return useCallback((patch: Partial<Record<keyof WorkParams, string | undefined>>, opts: { push?: boolean } = {}) => {
    write(currentPath(), { ...readSearch(), ...patch }, !!opts.push)
  }, [])
}

/** `?issue=` value for an item. */
export const issueParam = (projectId: string, issueId: string) => `${projectId}/${issueId}`

/** Parse `?issue=` → ids (a bare id falls back to the page's project). */
export function parseIssueParam(v: string | undefined, fallbackProject?: string): { projectId: string; issueId: string } | undefined {
  if (!v) return undefined
  const [a, b] = v.split('/')
  if (b) return { projectId: a, issueId: b }
  return fallbackProject ? { projectId: fallbackProject, issueId: a } : undefined
}

/** Href of a Define section with params (`/define?section=board&issue=…`). */
export function defineHref(section: string, params: WorkParams = {}): string {
  const qs = new URLSearchParams(Object.entries({ section, ...params }).filter(([, v]) => !!v) as Array<[string, string]>).toString()
  return `/define?${qs}`
}

/** Absolute URL for "Copy link". */
export function absoluteHref(href: string): string {
  return typeof location === 'undefined' ? href : `${location.origin}${href}`
}

/** Client-side navigation to any console path (other sections, other phases). */
export function navigateTo(href: string) {
  if (typeof history === 'undefined') return
  history.pushState(history.state, '', href)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}
