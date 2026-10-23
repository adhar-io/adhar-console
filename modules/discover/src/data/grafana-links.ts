/**
 * Grafana link handling for the native board renderer.
 *
 * Data links and panel links on the platform's boards point at other boards
 * with Grafana-relative URLs (`/d/<uid>/<slug>?var-namespace=…`). Inside the
 * console those open the board natively (`?board=<uid>&var-…`), keeping the
 * host's own params (`section=dashboards`); anything else opens in Grafana.
 */

import { readBoardUrl, writeBoardUrl } from './grafana-board.ts'

/**
 * Console URL for a Grafana board link, or null when the URL is not a
 * `/d/<uid>` link. `search` is the current query string (host params kept);
 * `fallback` supplies from/to when the link carries none.
 */
export function consoleBoardHref(
  url: string,
  search: string,
  fallback: { from: string; to: string },
  pathname = typeof location !== 'undefined' ? location.pathname : '',
): string | null {
  let path = url.trim()
  // Absolute links to the same Grafana are still board links.
  const abs = /^https?:\/\/[^/]+(\/.*)$/.exec(path)
  if (abs) path = abs[1]
  const m = /^(?:\/grafana)?\/d\/([^/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?/.exec(path)
  if (!m) return null
  const uid = decodeURIComponent(m[1])
  const target = readBoardUrl(`?${m[2] ?? ''}`)
  const next = writeBoardUrl(search, {
    board: uid,
    from: target.from ?? fallback.from,
    to: target.to ?? fallback.to,
    refresh: target.refresh,
    vars: target.vars,
  })
  return `${pathname}${next}`
}

/** Panel-level links (`panel.links`) with their interpolated URLs. */
export function panelLinks(
  links: Array<{ title?: string; url?: string; targetBlank?: boolean }> | undefined,
  interpolateUrl: (u: string) => string,
): Array<{ title: string; url: string; blank: boolean }> {
  return (links ?? [])
    .filter((l) => l.url)
    .map((l) => ({ title: l.title || l.url!, url: interpolateUrl(l.url!), blank: !!l.targetBlank }))
}
