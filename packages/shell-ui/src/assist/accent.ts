/**
 * Agent accents as literal Tailwind classes.
 *
 * Tailwind generates only the classes it can see in source; a template like
 * `bg-${accent}-500` produces nothing, and the dot silently renders with no
 * colour. The accent vocabulary is closed (see `AgentDef.accent` on the
 * server), so a static map is both correct and complete.
 */
export const ACCENT_DOT: Record<string, string> = {
  brand: 'bg-brand-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  violet: 'bg-violet-500',
  sky: 'bg-sky-500',
  rose: 'bg-rose-500',
}

export const ACCENT_GRADIENT: Record<string, string> = {
  brand: 'from-brand-500 to-accent-500',
  emerald: 'from-emerald-500 to-teal-600',
  amber: 'from-amber-500 to-orange-600',
  violet: 'from-violet-500 to-fuchsia-600',
  sky: 'from-sky-500 to-indigo-600',
  rose: 'from-rose-500 to-pink-600',
}

export const ACCENT_TEXT: Record<string, string> = {
  brand: 'text-brand-600 dark:text-brand-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  violet: 'text-violet-600 dark:text-violet-400',
  sky: 'text-sky-600 dark:text-sky-400',
  rose: 'text-rose-600 dark:text-rose-400',
}

export const accentDot = (a?: string) => ACCENT_DOT[a ?? ''] ?? ACCENT_DOT.brand
export const accentGradient = (a?: string) => ACCENT_GRADIENT[a ?? ''] ?? ACCENT_GRADIENT.brand
export const accentText = (a?: string) => ACCENT_TEXT[a ?? ''] ?? ACCENT_TEXT.brand
