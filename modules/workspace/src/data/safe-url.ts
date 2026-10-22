/**
 * Href guard for URLs that people type into workspace settings and that other
 * members then click (e.g. a compliance framework's externally hosted report).
 *
 * The value is stored and rendered for everyone in the org, so a `javascript:`
 * or `data:` URL would be stored XSS against whoever clicks it. Only absolute
 * http(s) URLs are allowed through; anything else renders as "no link".
 */
export function safeExternalHref(value: string | undefined | null): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}
