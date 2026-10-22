/**
 * Catalog links come from data anyone with repo access can write
 * (`catalog-info.yaml`, `adhar.io/*` annotations, the Register form), so a
 * link is only rendered when it is plainly web navigation: an absolute
 * http(s) URL, `mailto:`, or a same-origin path. `javascript:`, `data:`,
 * `vbscript:` and protocol-relative `//host` are refused. React 19 also
 * neuters `javascript:` hrefs, but `window.open` and iframes do not go
 * through that guard.
 */
export function isSafeLinkUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string') return false
  const u = url.trim()
  if (!u) return false
  // Same-origin path, but not `//host` (protocol-relative) or `/\host`.
  if (u.startsWith('/')) return !u.startsWith('//') && !u.startsWith('/\\')
  return /^(https?:\/\/[^\s/]|mailto:)/i.test(u)
}

/** Only absolute http(s) — for fields that must name an external site (a repo URL). */
export function isHttpUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string') return false
  try {
    const p = new URL(url.trim())
    return (p.protocol === 'http:' || p.protocol === 'https:') && Boolean(p.host)
  } catch {
    return false
  }
}
