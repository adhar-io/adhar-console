/**
 * Deep links between Discover sections (Logs ⇄ Traces ⇄ Alerts ⇄ SLOs).
 *
 * The host route owns `?section=`; each view keeps its own selection beside it
 * (`?section=traces&trace=<id>`). This remote has no router dependency, so it
 * writes the URL with the History API and announces it with `popstate`, which
 * the host router listens to (the same fallback the Develop module uses).
 *
 * Values are encoded the way TanStack Router does: a string that would parse
 * as JSON (a numeric-looking trace id) is written quoted and read back as the
 * string it was.
 */

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

/** One deep-link param from the current URL (decoded). */
export function readParam(key: string): string | undefined {
  if (typeof location === 'undefined') return undefined
  const v = new URLSearchParams(location.search).get(key)
  return v == null || v === '' ? undefined : decode(v)
}

function discoverPath(): string {
  return typeof location !== 'undefined' && location.pathname.startsWith('/discover') ? location.pathname : '/discover'
}

/** Navigate to a Discover section with params (new history entry). */
export function goDiscover(section: string, params: Record<string, string | undefined> = {}) {
  const qs = new URLSearchParams()
  qs.set('section', section)
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, encode(v))
  const url = `${discoverPath()}?${qs}`
  history.pushState(history.state, '', url)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

/** Patch params on the current URL in place (no new entry) — for shareable selection state. */
export function patchParams(patch: Record<string, string | undefined>) {
  if (typeof location === 'undefined') return
  const qs = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(patch)) {
    if (v) qs.set(k, encode(v))
    else qs.delete(k)
  }
  history.replaceState(history.state, '', `${location.pathname}?${qs}`)
}

/** Absolute URL to a Discover section — for "copy link". */
export function discoverUrl(section: string, params: Record<string, string | undefined> = {}): string {
  if (typeof location === 'undefined') return ''
  const qs = new URLSearchParams()
  qs.set('section', section)
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, encode(v))
  return `${location.origin}${discoverPath()}?${qs}`
}

/** Logs view for a query over an absolute window. */
export function goLogs(query: string, from: Date, to: Date) {
  goDiscover('logs', { q: query, from: from.toISOString(), to: to.toISOString() })
}

/** Open a trace in the Traces view. */
export function goTrace(traceId: string) {
  goDiscover('traces', { trace: traceId })
}
