import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { cn } from '@adhar/utils'
import {
  drawerWidthClass,
  isTypingTarget,
  readDrawerWide,
  subscribeDrawerWide,
  writeDrawerWide,
} from './drawer-width-store.ts'

export interface DrawerWidth {
  /** Whether the drawer is currently widened. */
  wide: boolean
  setWide(next: boolean): void
  toggle(): void
  /** Width classes for the drawer panel: `base`, the wide override, the transition. */
  className: string
}

/**
 * Wide mode for a side drawer, remembered per drawer `id`.
 *
 * ```tsx
 * const width = useDrawerWidth('deliver.argo-app', { base: 'max-w-3xl' })
 * <aside className={cn('relative flex h-full w-full flex-col …', width.className)}>
 *   <header>… <DrawerWidenButton wide={width.wide} onToggle={width.toggle} /> <Close/></header>
 * ```
 *
 * Every instance with the same id stays in sync (two buttons driving one
 * drawer, or the drawer reopened later). Without storage the preference lasts
 * for the session.
 */
export function useDrawerWidth(
  id: string,
  opts: {
    /** The drawer's standard max width, e.g. `max-w-3xl`. */
    base?: string
    /** Used when nothing was saved for this id yet. */
    defaultWide?: boolean
    /** One-off read of an older preference key, consulted when nothing is saved under `id`. */
    legacy?: () => boolean | undefined
  } = {},
): DrawerWidth {
  const { base = 'max-w-3xl', defaultWide = false, legacy } = opts
  const legacyRef = useRef(legacy)
  legacyRef.current = legacy
  const wide = useSyncExternalStore(
    subscribeDrawerWide,
    () => readDrawerWide(id) ?? legacyRef.current?.() ?? defaultWide,
    () => defaultWide,
  )
  const setWide = useCallback((next: boolean) => writeDrawerWide(id, next), [id])
  const toggle = useCallback(() => writeDrawerWide(id, !(readDrawerWide(id) ?? legacyRef.current?.() ?? defaultWide)), [id, defaultWide])
  return { wide, setWide, toggle, className: drawerWidthClass(base, wide) }
}

/**
 * The header toggle for wide mode. It sits in the drawer's top-right action
 * cluster, just before Close. Hidden below `lg`, where drawers are already
 * full width. `]` toggles it while focus is inside the drawer and not in a
 * text field.
 */
export function DrawerWidenButton({
  wide,
  onToggle,
  className,
  size = 'md',
  shortcut = true,
}: {
  wide: boolean
  onToggle(): void
  /** Extra classes — typically to match the neighbouring header buttons. */
  className?: string
  /** `sm` = 28px square (compact headers), `md` = 32px square. */
  size?: 'sm' | 'md'
  /** Bind the `]` shortcut. */
  shortcut?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const toggleRef = useRef(onToggle)
  toggleRef.current = onToggle

  useEffect(() => {
    if (!shortcut || typeof document === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ']' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      const btn = ref.current
      // Not rendered (below lg it is display:none) — nothing to toggle.
      if (!btn || btn.offsetParent === null) return
      const dialog = btn.closest('[role="dialog"]') ?? btn.closest('aside')
      if (!dialog) return
      const active = document.activeElement
      const focusInside = !!active && dialog.contains(active)
      // Focus on the page body (nothing focused yet): only the top-most open
      // drawer answers, so stacked drawers do not all toggle at once.
      const bodyFocus = !active || active === document.body
      if (!focusInside) {
        if (!bodyFocus) return
        const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
        if (dialogs.length && dialogs[dialogs.length - 1] !== dialog) return
      }
      e.preventDefault()
      toggleRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shortcut])

  const label = wide ? 'Standard width' : 'Widen'
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      aria-pressed={wide}
      aria-label={wide ? 'Return drawer to standard width' : 'Widen drawer'}
      title={shortcut ? `${label} (])` : label}
      className={cn(
        'hidden shrink-0 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 lg:inline-flex',
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        wide && 'bg-brand-50 text-brand-700 hover:bg-brand-50 hover:text-brand-700 dark:bg-brand-500/15 dark:text-brand-300 dark:hover:bg-brand-500/15 dark:hover:text-brand-300',
        className,
      )}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {/* Dashed centre line with arrows: pointing out = widen, pointing in = back to standard. */}
        <path d="M12 2v2M12 8v2M12 14v2M12 20v2" />
        {wide ? (
          <>
            <path d="M2 12h6" />
            <path d="m5 9 3 3-3 3" />
            <path d="M22 12h-6" />
            <path d="m19 9-3 3 3 3" />
          </>
        ) : (
          <>
            <path d="M16 12h6" />
            <path d="m19 9 3 3-3 3" />
            <path d="M8 12H2" />
            <path d="m5 9-3 3 3 3" />
          </>
        )}
      </svg>
    </button>
  )
}
