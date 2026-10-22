/**
 * Guard for links whose URL comes from data rather than from code — OCI image
 * labels, scanner references, alert annotations, repo "website" fields. Any of
 * those can be set by whoever pushed the image / wrote the rule, and React
 * still renders a `javascript:` href (it only warns), so one click would run
 * script in the console's origin with the viewer's session.
 *
 * Only absolute http(s) URLs pass; anything else returns `undefined` so the
 * caller renders plain text instead of a link.
 */
export function safeExternalUrl(raw: string | null | undefined): string | undefined {
  const s = raw?.trim()
  if (!s) return undefined
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}
