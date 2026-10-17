/**
 * Deep links from the Discover dashboard, metrics explorer and service map
 * into the detail pages, with context preserved in the URL.
 *
 * The host route owns `/discover?section=…`; each view keeps its own context
 * beside it:
 *
 *   metrics    ?section=metrics&q=<promql>[&q2=…&q3=…]&range=1h&step=60&mode=range|instant&view=chart|table
 *   logs       ?section=logs&q=<logql>&range=1h            (read by logs.tsx)
 *   traces     ?section=traces&service=<svc>&status=error&range=1h
 *   alerts     ?section=alerts&service=<svc>&severity=critical&namespace=<ns>
 *   slos       ?section=slos&service=<svc>
 *   servicemap ?section=servicemap&focus=<node>&ns=<ns>&range=15m
 *   dashboard  ?section=dashboard&range=1h&ns=<ns>&svc=<svc>&src=<source>&refresh=30
 *
 * Values are written the way TanStack Router encodes search params — a string
 * that would parse as JSON (`60`, `true`) is quoted — so the host router and
 * these helpers read each other's URLs. Navigation uses the History API + a
 * `popstate` event, which the host router listens to (this remote has no
 * router dependency). `discover-nav.ts` holds the Logs/Traces helpers; this
 * file is the dashboard/metrics/service-map side and shares its encoding.
 *
 * The pure half (`discoverHref`, `decodeParam`, `encodeParam`) is unit-tested.
 */

export type DiscoverSection =
  | 'dashboard'
  | 'metrics'
  | 'logs'
  | 'traces'
  | 'servicemap'
  | 'alerts'
  | 'slos'
  | 'dashboards'
  | 'analytics'
  | 'sessions'

export type Params = Record<string, string | number | null | undefined | false>

/** Decode one search value as TanStack Router wrote it. */
export function decodeParam(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const v = JSON.parse(raw)
      if (typeof v === 'string') return v
    } catch {
      /* not JSON — keep raw */
    }
  }
  return raw
}

/** Encode one value as TanStack Router would, so either side can read it. */
export function encodeParam(v: string): string {
  try {
    JSON.parse(v)
    return JSON.stringify(v)
  } catch {
    return v
  }
}

/** Build `/discover?section=…&…` with empty values dropped. */
export function discoverHref(section: DiscoverSection, params: Params = {}, base = '/discover'): string {
  const qs = new URLSearchParams()
  qs.set('section', section)
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    qs.set(k, encodeParam(String(v)))
  }
  return `${base}?${qs.toString()}`
}

/** Current params (decoded), or {} outside a browser. */
export function readParams(): Record<string, string> {
  if (typeof location === 'undefined') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = decodeParam(v)
  return out
}

/**
 * Patch params on the current page in place (replaceState — filter and editor
 * state should not flood the back button).
 */
export function replaceParams(patch: Params): void {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  const qs = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '' || v === false) qs.delete(k)
    else qs.set(k, encodeParam(String(v)))
  }
  const next = `${location.pathname}?${qs.toString()}`
  if (next === `${location.pathname}${location.search}`) return
  history.replaceState(history.state, '', next)
}

/** Navigate to an href (pushState + popstate so the host router follows). */
export function go(href: string): void {
  if (typeof history === 'undefined') return
  history.pushState(history.state, '', href)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  globalThis.scrollTo?.({ top: 0 })
}

/**
 * onClick for an `<a href>` that should route in-app. Modified clicks (new
 * tab, new window) fall through to the browser, so links stay real links.
 */
export function routeClick(e: {
  defaultPrevented: boolean
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  preventDefault(): void
  currentTarget: { getAttribute(n: string): string | null }
}): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const href = e.currentTarget.getAttribute('href')
  if (!href || !href.startsWith('/')) return
  e.preventDefault()
  go(href)
}
