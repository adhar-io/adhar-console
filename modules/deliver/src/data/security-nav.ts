import { useCallback, useEffect, useState } from 'react'

/**
 * Deep links for Deliver → Scans:
 *   `/deliver?section=scans&tab=<tab>&finding=<CVE|pkg>&waiver=<id>&project=<p>`
 *
 * The host route owns `?section=`; these params sit next to it. Deliver does
 * not share the host router, so they are written with the History API and
 * announced with `popstate`, which the host router listens to.
 */

export const SECURITY_TABS = ['overview', 'findings', 'images', 'licenses', 'review', 'waivers', 'policy'] as const
export type SecurityTab = typeof SECURITY_TABS[number]

export interface SecurityParams {
  tab?: string
  finding?: string
  waiver?: string
  project?: string
}

const KEYS = ['tab', 'finding', 'waiver', 'project'] as const

function read(): SecurityParams {
  if (typeof location === 'undefined') return {}
  const q = new URLSearchParams(location.search)
  const out: SecurityParams = {}
  for (const k of KEYS) {
    let v = q.get(k)
    // TanStack Router writes JSON-looking strings quoted.
    if (v && v.startsWith('"')) {
      try {
        const j = JSON.parse(v)
        if (typeof j === 'string') v = j
      } catch { /* keep raw */ }
    }
    if (v) out[k] = v
  }
  return out
}

export function useSecurityParams(): SecurityParams {
  const [p, setP] = useState<SecurityParams>(read)
  useEffect(() => {
    const sync = () => setP((cur) => {
      const next = read()
      return JSON.stringify(cur) === JSON.stringify(next) ? cur : next
    })
    globalThis.addEventListener('popstate', sync)
    return () => globalThis.removeEventListener('popstate', sync)
  }, [])
  return p
}

/** Patch the params; `push` adds a history entry (opening a finding), default replaces. */
export function useSetSecurityParams() {
  return useCallback((patch: SecurityParams, opts: { push?: boolean } = {}) => {
    if (typeof location === 'undefined') return
    const q = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') q.delete(k)
      else q.set(k, v)
    }
    const url = `${location.pathname}?${q.toString()}`
    if (opts.push) history.pushState(history.state, '', url)
    else history.replaceState(history.state, '', url)
    globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  }, [])
}

/** Absolute deep link (for "Copy link" and Plane issues). */
export function securityLink(params: SecurityParams): string {
  const q = new URLSearchParams({ section: 'scans' })
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
  const origin = typeof location === 'undefined' ? '' : location.origin
  return `${origin}/deliver?${q.toString()}`
}
