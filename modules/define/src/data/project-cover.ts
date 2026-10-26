/**
 * A Plane project's visual identity — cover image, emoji and icon colour —
 * read defensively from whatever the running Plane returns (pure).
 *
 * Plane has carried the cover under several fields over releases:
 *   • `cover_image_url` — computed: the uploaded asset's URL, else `cover_image`
 *   • `cover_image_asset` — the uploaded file's asset id (served from
 *     `/api/assets/v2/static/<id>/`, which redirects to object storage)
 *   • `cover_image` — a plain URL (Plane's stock Unsplash covers, older uploads)
 * Relative Plane paths, and absolute ones on Plane's own host, are routed
 * through the console's Plane proxy (`/api/svc/plane/…`) so they load in the
 * console without a Plane session.
 *
 * The emoji lives in `logo_props.emoji.value` (newer) or `emoji` (older), both
 * as decimal code points joined with "-" (e.g. "128640", "9917-65039").
 *
 * Deliberately no imports: the test loads this file on its own.
 */

export interface PlaneProjectVisual {
  emoji?: string | null
  cover_image?: string | null
  cover_image_url?: string | null
  cover_image_asset?: string | null
  logo_props?: {
    in_use?: string
    emoji?: { value?: string | null; url?: string | null } | null
    icon?: { name?: string | null; color?: string | null; background_color?: string | null } | null
  } | null
}

export const PLANE_PROXY = '/api/svc/plane'

/** Decode Plane's "128640" / "9917-65039" code-point form; pass real emoji through. */
export function decodeEmoji(raw: string | null | undefined): string | undefined {
  const v = (raw ?? '').trim()
  if (!v) return undefined
  if (/^\d+(-\d+)*$/.test(v)) {
    try {
      return String.fromCodePoint(...v.split('-').map(Number))
    } catch {
      return undefined
    }
  }
  // Already a glyph (older Plane, or a console-created project). Ignore plain words.
  return /^[\x20-\x7e]+$/.test(v) ? undefined : v
}

export function projectEmoji(p: unknown): string | undefined {
  const v = p as PlaneProjectVisual | null | undefined
  if (!v) return undefined
  const lp = v.logo_props
  if (lp && lp.in_use === 'icon') return undefined
  return decodeEmoji(lp?.emoji?.value) ?? decodeEmoji(v.emoji)
}

/** The colour Plane gives a project's material icon, when it uses one. */
export function projectIconColor(p: unknown): string | undefined {
  const lp = (p as PlaneProjectVisual | null | undefined)?.logo_props
  if (!lp || lp.in_use !== 'icon') return undefined
  const c = lp.icon?.color ?? ''
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined
}

/**
 * The URL to load a project's cover from, or undefined when it has none.
 * `planeBase` is Plane's public URL (from the console config), used to spot
 * absolute links back to Plane itself.
 */
export function coverImageUrl(p: unknown, planeBase?: string): string | undefined {
  const v = p as PlaneProjectVisual | null | undefined
  if (!v) return undefined
  const asset = (v.cover_image_asset ?? '').trim()
  const raw = (v.cover_image_url ?? '').trim() || (asset ? `/api/assets/v2/static/${asset}/` : '') || (v.cover_image ?? '').trim()
  if (!raw) return undefined
  return resolvePlaneUrl(raw, planeBase)
}

export function resolvePlaneUrl(raw: string, planeBase?: string): string | undefined {
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('/')) return `${PLANE_PROXY}${raw}`
  if (!/^https?:\/\//i.test(raw)) return undefined
  const base = (planeBase ?? '').replace(/\/+$/, '')
  if (base && raw.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return `${PLANE_PROXY}${raw.slice(base.length)}`
  return raw
}
