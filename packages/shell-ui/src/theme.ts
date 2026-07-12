/**
 * Theme presets. Each theme redefines the brand/accent ramps + surface tints
 * as CSS custom properties on `:root`. The values are OKLCH so the ramps
 * stay perceptually even; compare to the defaults in `apps/console/app/styles.css`.
 */
export interface ThemePreset {
  id: string
  name: string
  description: string
  /** Hex preview swatches rendered in the picker (500, 700, accent). */
  swatches: [string, string, string]
  /** CSS variables applied to document.documentElement. */
  vars: Record<string, string>
}

const cobaltVars: Record<string, string> = {
  '--color-brand-50': 'oklch(0.97 0.015 265)',
  '--color-brand-100': 'oklch(0.94 0.03 265)',
  '--color-brand-200': 'oklch(0.89 0.055 264)',
  '--color-brand-300': 'oklch(0.81 0.09 263)',
  '--color-brand-400': 'oklch(0.71 0.13 262)',
  '--color-brand-500': 'oklch(0.58 0.17 262)',
  '--color-brand-600': 'oklch(0.51 0.19 262)',
  '--color-brand-700': 'oklch(0.44 0.18 262)',
  '--color-brand-800': 'oklch(0.36 0.15 262)',
  '--color-brand-900': 'oklch(0.28 0.11 262)',
  '--color-brand-950': 'oklch(0.19 0.07 262)',
  '--color-accent-50': 'oklch(0.97 0.025 180)',
  '--color-accent-500': 'oklch(0.66 0.13 180)',
  '--color-accent-600': 'oklch(0.58 0.14 180)',
}

function ramp(hue: number, accentHue: number): Record<string, string> {
  return {
    '--color-brand-50': `oklch(0.97 0.015 ${hue})`,
    '--color-brand-100': `oklch(0.94 0.03 ${hue})`,
    '--color-brand-200': `oklch(0.89 0.055 ${hue})`,
    '--color-brand-300': `oklch(0.81 0.09 ${hue})`,
    '--color-brand-400': `oklch(0.71 0.13 ${hue})`,
    '--color-brand-500': `oklch(0.58 0.17 ${hue})`,
    '--color-brand-600': `oklch(0.51 0.19 ${hue})`,
    '--color-brand-700': `oklch(0.44 0.18 ${hue})`,
    '--color-brand-800': `oklch(0.36 0.15 ${hue})`,
    '--color-brand-900': `oklch(0.28 0.11 ${hue})`,
    '--color-brand-950': `oklch(0.19 0.07 ${hue})`,
    '--color-accent-50': `oklch(0.97 0.025 ${accentHue})`,
    '--color-accent-500': `oklch(0.66 0.13 ${accentHue})`,
    '--color-accent-600': `oklch(0.58 0.14 ${accentHue})`,
  }
}

/**
 * Low-chroma ramp for genuinely neutral themes (Graphite). The colored
 * `ramp()` above pegs chroma to ~0.17–0.19 at the mid-tones so brand surfaces
 * read as a real color — but feeding hue 250 into that ramp produces a
 * saturated blue-violet, not a graphite. This ramp keeps the same lightness
 * progression but caps chroma at the values the Tailwind `slate` palette
 * uses (≤0.046), giving the actual charcoal the picker swatches advertise.
 *
 * Accent is still saturated — Graphite gets a teal pop on top of neutral
 * surfaces, which is the whole reason to pick it.
 */
function neutralRamp(accentHue: number): Record<string, string> {
  return {
    '--color-brand-50': 'oklch(0.984 0.003 247)',
    '--color-brand-100': 'oklch(0.968 0.007 247)',
    '--color-brand-200': 'oklch(0.929 0.013 256)',
    '--color-brand-300': 'oklch(0.869 0.022 252)',
    '--color-brand-400': 'oklch(0.704 0.04 256)',
    '--color-brand-500': 'oklch(0.554 0.046 257)',
    '--color-brand-600': 'oklch(0.446 0.043 257)',
    '--color-brand-700': 'oklch(0.372 0.044 257)',
    '--color-brand-800': 'oklch(0.279 0.041 260)',
    '--color-brand-900': 'oklch(0.208 0.042 266)',
    '--color-brand-950': 'oklch(0.129 0.042 264)',
    '--color-accent-50': `oklch(0.97 0.025 ${accentHue})`,
    '--color-accent-500': `oklch(0.66 0.13 ${accentHue})`,
    '--color-accent-600': `oklch(0.58 0.14 ${accentHue})`,
  }
}

export const THEMES: ThemePreset[] = [
  {
    id: 'cobalt',
    name: 'Cobalt',
    description: 'Default. Deep indigo / teal — calm and operator-friendly.',
    swatches: ['#3366e0', '#26409e', '#12b1a3'],
    vars: cobaltVars,
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Richer purple with a warm magenta accent.',
    swatches: ['#7c4dff', '#5a2fcc', '#ff4d8d'],
    vars: ramp(295, 340),
  },
  {
    id: 'emerald',
    name: 'Emerald',
    description: 'Deep green with a saturated lime accent.',
    swatches: ['#1aa86c', '#0f6d47', '#a3d613'],
    vars: ramp(155, 130),
  },
  {
    id: 'amber',
    name: 'Amber',
    description: 'Warm amber / cider — high contrast, low blue light.',
    swatches: ['#d97706', '#a15301', '#c41d7f'],
    vars: ramp(60, 25),
  },
  {
    id: 'rose',
    name: 'Rose',
    description: 'Crimson rose with a muted sky accent.',
    swatches: ['#e0395e', '#a31e40', '#2da4e8'],
    vars: ramp(15, 220),
  },
  {
    id: 'slate',
    name: 'Graphite',
    description: 'Neutral charcoal with a teal accent — understated, newsprint-style.',
    swatches: ['#475569', '#1f2937', '#0d9488'],
    vars: neutralRamp(180),
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Azure blue with a bright cyan accent.',
    swatches: ['#1e88e5', '#0d47a1', '#00bcd4'],
    vars: ramp(230, 205),
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Burnt orange + fuchsia — bold, for marketing demos.',
    swatches: ['#ff5722', '#c41d1d', '#d500f9'],
    vars: ramp(35, 320),
  },
]

const STORAGE_KEY = 'adhar.theme'
export const DEFAULT_THEME_ID = 'cobalt'

export function getStoredThemeId(): string {
  if (typeof globalThis === 'undefined' || !globalThis.localStorage) return DEFAULT_THEME_ID
  return globalThis.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME_ID
}

export function applyTheme(id: string): void {
  if (typeof document === 'undefined') return
  const preset = THEMES.find((t) => t.id === id) ?? THEMES[0]
  const root = document.documentElement
  for (const [key, value] of Object.entries(preset.vars)) {
    root.style.setProperty(key, value)
  }
  root.dataset.theme = preset.id
  globalThis.localStorage?.setItem(STORAGE_KEY, preset.id)
}

/* ─────────── Color mode (light / dark / system) ─────────── */

export type ColorMode = 'light' | 'dark' | 'system'

const MODE_STORAGE_KEY = 'adhar.theme.mode'
export const DEFAULT_COLOR_MODE: ColorMode = 'system'

export function getStoredMode(): ColorMode {
  if (typeof globalThis === 'undefined' || !globalThis.localStorage) return DEFAULT_COLOR_MODE
  const v = globalThis.localStorage.getItem(MODE_STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULT_COLOR_MODE
}

/**
 * The OS-level preference. `system` mode tracks this live; explicit
 * `light` / `dark` ignore it. Returns `'light'` when no `matchMedia` is
 * available so SSR snapshots stay deterministic.
 */
export function getSystemMode(): 'light' | 'dark' {
  if (typeof globalThis === 'undefined' || typeof globalThis.matchMedia !== 'function') {
    return 'light'
  }
  return globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** The mode actually painting on screen right now (resolves `'system'`). */
export function getResolvedMode(mode: ColorMode = getStoredMode()): 'light' | 'dark' {
  return mode === 'system' ? getSystemMode() : mode
}

/**
 * Apply a color mode. Toggles `.dark` on `<html>` and persists the user's
 * choice (including their explicit `system` preference, so a future
 * call to `bootColorMode` keeps tracking the OS).
 */
export function applyColorMode(mode: ColorMode): void {
  if (typeof document === 'undefined') return
  const resolved = getResolvedMode(mode)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.mode = mode
  root.style.colorScheme = resolved
  globalThis.localStorage?.setItem(MODE_STORAGE_KEY, mode)
}

/**
 * Boot the saved (or system) color mode AND start tracking OS preference
 * changes when the saved value is `'system'`. Returns a teardown function
 * that callers should run on unmount in long-lived contexts (most boots
 * happen at app-init and are never torn down).
 */
export function bootColorMode(): () => void {
  if (typeof globalThis === 'undefined' || typeof globalThis.matchMedia !== 'function') {
    applyColorMode(getStoredMode())
    return () => {}
  }
  applyColorMode(getStoredMode())
  const mq = globalThis.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (getStoredMode() === 'system') applyColorMode('system')
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** Call once at app boot so the saved theme + mode survive reloads. */
export function bootTheme(): void {
  if (typeof globalThis === 'undefined') return
  applyTheme(getStoredThemeId())
  bootColorMode()
}
