/**
 * `?returnTo=` comes from the address bar, so anyone can craft a link that
 * carries it. Only same-origin, absolute *paths* are honoured: `//evil.io`
 * and `/\evil.io` start with a slash but browsers resolve them as
 * protocol-relative URLs to another host, and a scheme (`https:`,
 * `javascript:`) is never a path. Anything else falls back to `fallback`.
 * `/login` is also refused — sending a signed-in user back to the sign-in
 * page re-triggers the redirect that brought them here and loops.
 */
export function safeReturnTo(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  // Control characters (tab/newline are stripped by URL parsers, which can
  // turn `/\t/evil.io` into `//evil.io`).
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return fallback
  return raw
}

/** Split a validated return path into the router's `{ to, search }` pair. */
export function splitReturnTo(raw: string | null | undefined): { to: string; search: Record<string, string> } {
  const safe = safeReturnTo(raw)
  const [path, query = ''] = safe.split('?')
  return { to: path || '/', search: Object.fromEntries(new URLSearchParams(query)) }
}
