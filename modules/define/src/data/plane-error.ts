/**
 * Plane error → a sentence a person can act on. Pure (no imports) so it is
 * testable on its own; re-exported from `plane.ts`.
 */

/**
 * A sentence a person can act on, from whatever a Plane call threw. The BFF
 * and Plane both answer in JSON — `{error}`, `{detail}`, or DRF field errors
 * (`{name: ["This field is required."]}`) — and the raw `HTTP 400 at …`
 * message names none of that.
 */
export function planeError(e: unknown, fallback = 'Plane request failed.'): string {
  const err = e as { status?: number; body?: unknown; message?: string } | undefined
  const status = err?.status
  const body = err?.body
  if (status === 429) {
    // DRF's throttle answer says when: "Request was throttled. Expected available in 42 seconds."
    const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined
    const secs = typeof detail === 'string' ? Number(detail.match(/available in (\d+)/)?.[1]) : NaN
    return Number.isFinite(secs) && secs > 0
      ? `Plane is rate-limiting the console right now. Try again in ${secs} second${secs === 1 ? '' : 's'}.`
      : 'Plane is rate-limiting the console right now. Try again in a minute.'
  }
  // The console's own refusals (an invitation route, a membership change by
  // someone who is not an organisation admin) carry a `plane_*` code and say
  // why — they are not Plane rejecting the API key.
  if (status === 403 && body && typeof body === 'object') {
    const b = body as { error?: unknown; detail?: unknown }
    if (typeof b.error === 'string' && b.error.startsWith('plane_') && typeof b.detail === 'string' && b.detail) return b.detail
  }
  if (status === 401 || status === 403) {
    return 'Plane rejected the console\'s API key. An operator needs to re-run the Plane setup so the console gets a valid token.'
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (b.error === 'tool_not_configured') return 'Plane is not connected to this console (no PLANE_URL).'
    if (b.error === 'upstream_unreachable') return 'The console could not reach Plane. It may be restarting.'
    for (const key of ['error', 'detail', 'message']) {
      if (typeof b[key] === 'string' && b[key]) return b[key] as string
    }
    const fields = Object.entries(b)
      .filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'string')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${(v as string[])[0]}`)
    if (fields.length) return fields.join(' · ')
  }
  if (status === 404) return 'Plane has no such item, or it was deleted.'
  return e instanceof Error && e.message ? e.message : fallback
}
