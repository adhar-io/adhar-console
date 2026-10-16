import type { ThemePreset, ThemeTokens } from '@adhar/builder/project'
import type { TokenSet } from './types.ts'

/**
 * Design → Design Tokens  ⇒  a builder theme preset ("Workspace").
 *
 * The workspace token set is the source of truth for colours and radius, so
 * the Visual Builder offers it as a theme and new projects start on it. Colour
 * tokens are matched by name/role (primary, accent, danger, muted, border,
 * background, text); anything not present falls back to the Adhar base so a
 * partial token set still yields a complete theme.
 */

export const WORKSPACE_THEME_ID = 'workspace'

/** `#4f46e5` / `#fff` / `rgb(…)`-free hex → `"H S% L%"` (the builder's token format). */
export function hexToHslTriplet(hex: string): string | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let hue = 0
  let sat = 0
  if (max !== min) {
    const d = max - min
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    hue *= 60
  }
  return `${Math.round(hue)} ${Math.round(sat * 100)}% ${Math.round(l * 100)}%`
}

/** White or near-black text, whichever reads on `triplet`. */
function onColor(triplet: string): string {
  const l = Number(triplet.split(/\s+/)[2]?.replace('%', '') ?? 50)
  return l > 60 ? '224 40% 10%' : '0 0% 100%'
}

const BASE_LIGHT: ThemeTokens = {
  background: '0 0% 100%', foreground: '226 57% 15%',
  card: '0 0% 100%', cardForeground: '226 57% 15%',
  popover: '0 0% 100%', popoverForeground: '226 57% 15%',
  primary: '221 83% 53%', primaryForeground: '0 0% 100%',
  secondary: '220 40% 96%', secondaryForeground: '226 57% 15%',
  muted: '220 40% 96%', mutedForeground: '222 15% 40%',
  accent: '220 40% 95%', accentForeground: '226 57% 15%',
  destructive: '347 77% 50%', destructiveForeground: '0 0% 100%',
  border: '220 30% 89%', input: '220 25% 82%', ring: '217 91% 60%', radius: '0.75rem',
}
const BASE_DARK: ThemeTokens = {
  background: '226 40% 8%', foreground: '220 30% 94%',
  card: '226 35% 11%', cardForeground: '220 30% 94%',
  popover: '226 35% 11%', popoverForeground: '220 30% 94%',
  primary: '217 91% 60%', primaryForeground: '0 0% 100%',
  secondary: '226 28% 17%', secondaryForeground: '220 30% 94%',
  muted: '226 28% 17%', mutedForeground: '222 15% 65%',
  accent: '226 28% 17%', accentForeground: '220 30% 94%',
  destructive: '347 77% 50%', destructiveForeground: '0 0% 100%',
  border: '226 25% 20%', input: '226 25% 24%', ring: '217 91% 60%', radius: '0.75rem',
}

type Slot = 'primary' | 'accent' | 'destructive' | 'muted' | 'border' | 'background' | 'foreground'
const MATCH: Array<[Slot, RegExp]> = [
  ['destructive', /danger|error|destructive|critical/i],
  ['accent', /accent|link|brand-secondary/i],
  ['primary', /primary|brand/i],
  ['muted', /muted|subtle/i],
  ['border', /border|divider|outline/i],
  ['background', /background|canvas|\bbg\b|page/i],
  ['foreground', /foreground|text|ink|content/i],
]

function pickColors(set: TokenSet, mode: 'light' | 'dark' = 'light'): Partial<Record<Slot, string>> {
  const out: Partial<Record<Slot, string>> = {}
  for (const t of set.color ?? []) {
    const triplet = hexToHslTriplet(mode === 'dark' && t.dark ? t.dark : t.value)
    if (!triplet) continue
    const hay = `${t.name} ${t.role ?? ''}`
    for (const [slot, re] of MATCH) {
      if (!out[slot] && re.test(hay)) {
        out[slot] = triplet
        break
      }
    }
  }
  return out
}

function pickRadius(set: TokenSet): string | undefined {
  const list = set.radius ?? []
  const named = list.find((r) => /\b(md|base|default|medium)\b|-md$/i.test(r.name))
  const v = (named ?? list[Math.floor(list.length / 2)])?.value
  return v && /^\d*\.?\d+(px|rem|em)$/.test(v.trim()) ? v.trim() : undefined
}

/** The workspace token set as a theme preset, or null when it has no usable colours. */
export function themeFromTokenSet(set: TokenSet | null | undefined): ThemePreset | null {
  if (!set) return null
  const c = pickColors(set)
  if (!c.primary && !c.accent) return null
  // Tokens that carry an explicit dark value drive the dark variant fully.
  const hasDark = (set.color ?? []).some((t) => !!t.dark)
  const d = hasDark ? pickColors(set, 'dark') : null
  const radius = pickRadius(set) ?? BASE_LIGHT.radius
  const primary = c.primary ?? c.accent!
  const light: ThemeTokens = {
    ...BASE_LIGHT,
    primary,
    primaryForeground: onColor(primary),
    ring: c.accent ?? primary,
    radius,
    // `accent` in the builder vocabulary is the subtle hover/active fill; the
    // brand accent drives the focus ring (and stands in for a dark primary).
    ...(c.destructive ? { destructive: c.destructive, destructiveForeground: onColor(c.destructive) } : {}),
    ...(c.muted ? { muted: c.muted, secondary: c.muted } : {}),
    ...(c.border ? { border: c.border, input: c.border } : {}),
    ...(c.background ? { background: c.background, card: c.background, popover: c.background } : {}),
    ...(c.foreground ? { foreground: c.foreground, cardForeground: c.foreground, popoverForeground: c.foreground, secondaryForeground: c.foreground } : {}),
  }
  // Dark keeps Adhar's dark surfaces; brand colours carry over.
  const dark: ThemeTokens = {
    ...BASE_DARK,
    radius,
    ...(c.accent ? { ring: c.accent } : {}),
    ...(c.destructive ? { destructive: c.destructive } : {}),
    // A very dark brand primary (a navy "primary surface") vanishes on dark
    // backgrounds — use the accent there instead.
    ...(lightness(primary) < 30 && c.accent ? { primary: c.accent, primaryForeground: onColor(c.accent) } : { primary, primaryForeground: onColor(primary) }),
  }
  if (d) {
    if (d.primary) Object.assign(dark, { primary: d.primary, primaryForeground: onColor(d.primary) })
    if (d.accent) dark.ring = d.accent
    if (d.destructive) dark.destructive = d.destructive
    if (d.muted) Object.assign(dark, { muted: d.muted, secondary: d.muted })
    if (d.border) Object.assign(dark, { border: d.border, input: d.border })
    if (d.background) Object.assign(dark, { background: d.background, card: d.background, popover: d.background })
    if (d.foreground) Object.assign(dark, { foreground: d.foreground, cardForeground: d.foreground, popoverForeground: d.foreground })
  }
  return { id: WORKSPACE_THEME_ID, name: 'Workspace', light, dark }
}

function lightness(triplet: string): number {
  return Number(triplet.split(/\s+/)[2]?.replace('%', '') ?? 50)
}
