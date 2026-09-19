/**
 * Turning a stored href into something the router will accept.
 *
 * Notification hrefs are written server-side as plain strings —
 * `/settings?section=teams` — because that is what a server emitting a
 * notification can produce without knowing anything about the router.
 *
 * TanStack Router's `Link` does not take that. `to` is a PATHNAME; the query
 * belongs in `search`. Handed the whole string it looks for a route whose
 * path is literally `/settings?section=teams`, finds none, and renders the
 * 404. Every notification in the product carries a section, so every
 * notification link was dead — and the `as never` cast at the call site was
 * suppressing the exact type error that would have said so.
 *
 * Its own module, free of React and the router, so it can be tested.
 */

export interface RouteTarget {
  to: string
  search: Record<string, string>
}

/**
 * Split an internal href into `to` + `search`.
 *
 * Returns null for anything that is not a plain internal path, so a bad or
 * hand-written href degrades to unlinked text rather than a broken link.
 */
export function routeTarget(href: string): RouteTarget | null {
  if (!href.startsWith('/')) return null
  const [path, query] = href.split('?')
  if (!path) return null
  const search: Record<string, string> = {}
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) search[k] = v
  }
  // Collapse a trailing slash so `/settings/` and `/settings` are one route;
  // the root itself keeps its slash.
  const to = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  return { to, search }
}
