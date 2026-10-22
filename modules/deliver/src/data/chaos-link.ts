import type { kargo } from '@adhar/api-clients'

/**
 * Freight → "Chaos reports for <sha>": the commit a freight carries, and the
 * Chaos Engineering page filtered to the runs that tested it.
 *
 * CI tags every signed image with the full commit SHA and Kargo's warehouses
 * only accept such tags, so the image tag IS the commit; a git subscription's
 * commit id is the fallback. Anything that is not a full 40-hex SHA is not
 * offered — a link to "reports for latest" would look right and be wrong.
 */

const FULL_SHA = /^[0-9a-f]{40}$/

export function freightCommit(f: Pick<kargo.Freight, 'images' | 'commits'>): string | undefined {
  for (const i of f.images ?? []) {
    const t = i.tag?.toLowerCase()
    if (t && FULL_SHA.test(t)) return t
  }
  for (const c of f.commits ?? []) {
    const id = c.id?.toLowerCase()
    if (id && FULL_SHA.test(id)) return id
  }
  return undefined
}

/** `/deliver?section=chaos&tab=reports&commit=<sha>[&app=<app>]` */
export function chaosReportsHref(sha: string, app?: string): string {
  return `/deliver?section=chaos&tab=reports&commit=${encodeURIComponent(sha)}${app ? `&app=${encodeURIComponent(app)}` : ''}`
}

/** Same-tab navigation through the host router (it listens to popstate). */
export function openChaosReports(sha: string, app?: string): void {
  if (typeof history === 'undefined') return
  history.pushState(history.state, '', chaosReportsHref(sha, app))
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}
