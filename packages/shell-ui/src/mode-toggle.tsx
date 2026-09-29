import { useEffect, useState } from 'react'
import { cn } from '@adhar-console/utils'
import {
  applyColorMode,
  getResolvedMode,
  getStoredMode,
  type ColorMode,
} from './theme.ts'

/**
 * Three-state color-mode toggle: Light · System · Dark.
 *
 * Two presentations share the same logic:
 *   - `variant="segmented"` — full pill with all three options visible. Best
 *     in settings drawers / preference sheets where space is plentiful.
 *   - `variant="icon"` — single icon button that cycles through the three
 *     states on click. Best for the topbar where every pixel counts.
 *
 * `system` mode tracks `prefers-color-scheme` live; the `bootColorMode`
 * function in `theme.ts` installs the listener at app boot, so picking
 * `System` here just reactivates that tracking.
 */
export function ModeToggle({
  variant = 'icon',
  className,
}: {
  variant?: 'icon' | 'segmented'
  className?: string
}) {
  const [mode, setMode] = useState<ColorMode>('system')

  // Hydrate from localStorage after mount — don't read storage during render
  // because that breaks SSR / first paint determinism.
  useEffect(() => {
    setMode(getStoredMode())
  }, [])

  // The actual painted mode (resolves `system` → `light`/`dark`).
  const resolved = getResolvedMode(mode)

  function commit(next: ColorMode) {
    setMode(next)
    applyColorMode(next)
  }

  if (variant === 'segmented') {
    const index = mode === 'light' ? 0 : mode === 'system' ? 1 : 2
    return (
      <div
        role="radiogroup"
        aria-label="Color mode"
        className={cn(
          'relative inline-flex items-center rounded-full border border-edge-default bg-surface-sunken p-0.5 text-[11px] font-medium',
          className,
        )}
      >
        {/* One thumb that travels, rather than a fill that jumps between three
            buttons. The selection then has a direction — you see Light move to
            Dark — and only one element carries the elevation, so the control
            reads as a physical switch instead of three tabs.

            `w-9` is `2.25rem`; the offset is computed rather than written as
            three arbitrary classes so the two cannot drift apart. */}
        <span
          aria-hidden
          className="absolute left-0.5 top-0.5 h-7 w-9 rounded-full bg-surface-raised shadow-sm ring-1 ring-edge-default transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(calc(${index} * 2.25rem))` }}
        />
        <Seg active={mode === 'light'} onClick={() => commit('light')} label="Light" tone="text-amber-500">
          <SunIcon />
        </Seg>
        <Seg active={mode === 'system'} onClick={() => commit('system')} label="System" tone="text-brand-600 dark:text-brand-300">
          <SystemIcon />
        </Seg>
        <Seg active={mode === 'dark'} onClick={() => commit('dark')} label="Dark" tone="text-indigo-500 dark:text-indigo-300">
          <MoonIcon />
        </Seg>
      </div>
    )
  }

  // Icon-only cycle button.
  const next: ColorMode = mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light'
  const tooltip =
    mode === 'system'
      ? `System (currently ${resolved})`
      : mode === 'light'
        ? 'Light'
        : 'Dark'
  return (
    <button
      type="button"
      onClick={() => commit(next)}
      title={`${tooltip} — click for ${capitalize(next)}`}
      aria-label={`Color mode: ${tooltip}`}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-surface-sunken hover:text-content',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        className,
      )}
    >
      {mode === 'light' ? <SunIcon /> : mode === 'dark' ? <MoonIcon /> : <SystemIcon />}
    </button>
  )
}

/**
 * One option on the segmented control.
 *
 * The button paints no background of its own — the travelling thumb behind it
 * does that — so it sits above the thumb (`relative`) and carries only the
 * icon. Selection shows as the icon taking its mode's own colour instead of a
 * blue fill: warm for light, cool for dark, brand for system. It says which
 * mode is selected without relying on the fill, which is the same blue
 * whatever it sits under.
 */
function Seg({
  active,
  onClick,
  label,
  tone,
  children,
}: {
  active: boolean
  onClick(): void
  label: string
  /** Colour the icon takes when this option is the selected one. */
  tone: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'relative inline-flex h-7 w-9 items-center justify-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        active ? tone : 'text-content-subtle hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  )
}
