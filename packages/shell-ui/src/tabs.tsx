import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@adhar/utils'
import type { StatusKind } from './status-badge.tsx'

export interface TabDef<T extends string = string> {
  id: T
  label: ReactNode
  description?: string
  badge?: { kind: StatusKind; value: ReactNode } | ReactNode
  disabled?: boolean
  /** Hidden from rendering (useful for conditional tabs without index gaps). */
  hidden?: boolean
}

interface Props<T extends string> {
  tabs: ReadonlyArray<TabDef<T>>
  /** Controlled active tab. If omitted, the Tabs component manages state itself. */
  value?: T
  onChange?(id: T): void
  /** Initial active tab when uncontrolled. Defaults to first non-disabled/hidden tab. */
  defaultValue?: T
  /** Layout — horizontal (default) or vertical. */
  orientation?: 'horizontal' | 'vertical'
  ariaLabel?: string
  className?: string
  /** Right-side actions, only shown in horizontal mode. */
  actions?: ReactNode
  /**
   * Horizontal look. `underline` (default) is a page's main tab row; `pills`
   * is a compact segmented row for a second level of tabs inside a tabbed page,
   * so the two rows never read as the same control.
   */
  variant?: 'underline' | 'pills'
  children?(activeId: T): ReactNode
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  defaultValue,
  orientation = 'horizontal',
  ariaLabel,
  className,
  actions,
  variant = 'underline',
  children,
}: Props<T>) {
  // Element ids are scoped per strip: a page's tabs and a nested strip inside
  // one of its panels can share a tab id ("quotas"), and ids must be unique.
  const uid = useId()
  const tabId = (id: string) => `tab-${uid}-${id}`
  const panelId = (id: string) => `panel-${uid}-${id}`
  const visibleTabs = tabs.filter((t) => !t.hidden)
  const firstEnabled = visibleTabs.find((t) => !t.disabled)
  const [internal, setInternal] = useState<T>(defaultValue ?? (firstEnabled?.id as T))
  const active = (value ?? internal) as T
  const setActive = (next: T) => {
    if (onChange) onChange(next)
    if (value === undefined) setInternal(next)
  }

  /*
   * The horizontal strip's edge fades.
   *
   * A strip wider than its container scrolls with the scrollbar hidden, so a
   * fade is the only hint that tabs continue past the edge. It used to be a
   * fixed right-hand mask below `sm` only: at tablet widths an overflowing
   * strip was cut hard mid-label with no hint at all, and on a phone the fade
   * stayed on after scrolling to the end, dimming the last tab for nothing.
   * Each edge is now measured — it fades only while there is something to
   * scroll to on that side, at any width.
   */
  const stripRef = useRef<HTMLElement>(null)
  const [fade, setFade] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  const tabCount = visibleTabs.length
  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) return
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth
      // 1px of slack: fractional widths leave a sub-pixel remainder at the end.
      const left = el.scrollLeft > 1
      const right = max - el.scrollLeft > 1
      setFade((f) => (f.left === left && f.right === right ? f : { left, right }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [orientation, tabCount])

  // Keep the active tab in view: a tab chosen by the keyboard, a deep link or
  // the page itself may sit past the edge of a scrolled strip. The strip's own
  // `scrollLeft` is moved rather than calling `scrollIntoView`, which would
  // also scroll the page vertically to the strip. Instant on first paint (no
  // sweep on load), eased afterwards unless motion is reduced.
  const stripSettled = useRef(false)
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const first = !stripSettled.current
    stripSettled.current = true
    const tab = [...el.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.id === tabId(active))
    if (!tab || el.scrollWidth <= el.clientWidth) return
    const strip = el.getBoundingClientRect()
    const box = tab.getBoundingClientRect()
    // Clear of the fade, so the active label is never the dimmed one.
    const margin = 32
    let delta = 0
    if (box.left < strip.left + margin) delta = box.left - strip.left - margin
    else if (box.right > strip.right - margin) delta = box.right - strip.right + margin
    if (!delta) return
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const left = el.scrollLeft + delta
    if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior: first || reduce ? 'auto' : 'smooth' })
    else el.scrollLeft = left
  }, [active, orientation, tabCount])

  const FADE = '1.75rem'
  const stripMask = fade.left || fade.right
    ? `linear-gradient(to right, ${fade.left ? `transparent, black ${FADE}` : 'black, black'}, ${fade.right ? `black calc(100% - ${FADE}), transparent` : 'black'})`
    : undefined

  if (orientation === 'vertical') {
    return (
      <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr] lg:gap-6', className)}>
        {/* Below lg the rail is one scrolling row of chips: stacked full-width
            rows pushed the panel itself off the first screen of a phone. */}
        <aside
          role="tablist"
          aria-label={ariaLabel}
          aria-orientation="vertical"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] lg:mx-0 lg:block lg:space-y-0.5 lg:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {visibleTabs.map((t) => {
            const isActive = t.id === active
            return (
              <button
                key={t.id}
                role="tab"
                type="button"
                // The panel's `aria-labelledby` points here; without the id
                // (the horizontal variant has it) the reference dangled.
                id={tabId(t.id)}
                aria-selected={isActive}
                aria-controls={panelId(t.id)}
                disabled={t.disabled}
                onClick={() => setActive(t.id)}
                className={cn(
                  'block shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors lg:w-full lg:whitespace-normal',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40',
                  // Active: the same brand mark the horizontal tabs use (an
                  // underline there, a left rail here) so the two variants
                  // read as one component.
                  isActive
                    ? 'bg-surface-sunken font-medium text-content lg:shadow-[inset_2px_0_0_var(--color-brand-500)]'
                    : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                  t.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <div>{t.label}</div>
                {t.description ? (
                  <div className="hidden text-[11px] text-content-subtle lg:block">{t.description}</div>
                ) : null}
              </button>
            )
          })}
        </aside>
        <div
          role="tabpanel"
          id={panelId(active)}
          aria-labelledby={tabId(active)}
          className="min-w-0"
        >
          {children?.(active)}
        </div>
      </div>
    )
  }

  // Roving focus: ← → move between tabs (wrapping), Home/End jump to the
  // ends, and the moved-to tab is selected — the WAI-ARIA tabs pattern, so
  // a keyboard user is not left tabbing through every tab to reach one.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const enabled = visibleTabs.filter((t) => !t.disabled)
    if (!enabled.length) return
    const i = Math.max(0, enabled.findIndex((t) => t.id === active))
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (i + 1) % enabled.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next === null) return
    e.preventDefault()
    const id = enabled[next].id
    setActive(id)
    ;(e.currentTarget.querySelector(`#${CSS.escape(tabId(id))}`) as HTMLElement | null)?.focus()
  }

  const pills = variant === 'pills'

  return (
    <div className={cn(pills ? 'space-y-4' : 'space-y-5', className)}>
      {/* The scroller is masked at whichever edge still has tabs beyond it: a
          hard cut at the edge gives no hint that more tabs exist. The mask
          fades the last visible one instead (see `fade` above). */}
      {/* With actions, a phone stacks them above the tab list (which keeps
          the full width to scroll) instead of squeezing both into one row. */}
      <div
        className={cn(
          'relative flex flex-col-reverse gap-1 sm:flex-row sm:justify-between sm:gap-4',
          pills ? 'sm:items-center' : 'border-b border-edge-default sm:items-end',
        )}
      >
        <nav
          ref={stripRef}
          role="tablist"
          aria-label={ariaLabel}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          style={stripMask ? { maskImage: stripMask, WebkitMaskImage: stripMask } : undefined}
          className={cn(
            'flex min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            // Pills: a sunken track sized to its tabs, the active one raised.
            pills
              ? 'w-fit max-w-full gap-0.5 rounded-lg border border-edge-subtle bg-surface-sunken p-0.5'
              : '-mb-px gap-0.5',
          )}
        >
          {visibleTabs.map((t) => {
            const isActive = t.id === active
            return (
              <button
                key={t.id}
                role="tab"
                type="button"
                id={tabId(t.id)}
                aria-selected={isActive}
                aria-controls={panelId(t.id)}
                tabIndex={isActive ? 0 : -1}
                disabled={t.disabled}
                onClick={() => setActive(t.id)}
                className={cn(
                  'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40',
                  pills
                    ? cn(
                        'min-h-8 rounded-md px-3 py-1 text-[13px] pointer-coarse:min-h-9',
                        isActive
                          ? 'bg-surface-raised font-medium text-content shadow-sm ring-1 ring-edge-default'
                          : 'text-content-muted hover:bg-surface-raised/60 hover:text-content',
                      )
                    : cn(
                        'rounded-t-md border-b-2 px-3 py-2.5',
                        // The active underline is the brand, not a hard black
                        // rule; a resting tab gets a faint underline on hover so
                        // the target reads before the click.
                        isActive
                          ? 'border-brand-600 font-medium text-content dark:border-brand-400'
                          : 'border-transparent text-content-subtle hover:border-edge-strong hover:text-content',
                      ),
                  t.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {t.label}
                {renderBadge(t.badge)}
              </button>
            )
          })}
        </nav>
        {actions ? <div className={cn('flex shrink-0 flex-wrap items-center justify-end gap-2', !pills && 'pb-1 sm:pb-2')}>{actions}</div> : null}
      </div>
      <div role="tabpanel" id={panelId(active)} aria-labelledby={tabId(active)}>
        {children?.(active)}
      </div>
    </div>
  )
}

function renderBadge(badge?: TabDef['badge']) {
  if (!badge) return null
  if (typeof badge === 'object' && 'kind' in badge) {
    const tone: Record<StatusKind, string> = {
      healthy: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
      degraded: 'bg-rose-100 dark:bg-rose-500/15 text-rose-800 dark:text-rose-300',
      progressing: 'bg-indigo-100 dark:bg-indigo-500/15 text-indigo-800 dark:text-indigo-300',
      paused: 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300',
      failed: 'bg-rose-200 dark:bg-rose-500/25 text-rose-900 dark:text-rose-200',
      unknown: 'bg-surface-sunken text-content-muted',
      info: 'bg-sky-100 dark:bg-sky-500/15 text-sky-800 dark:text-sky-300',
    }
    return (
      <span
        className={cn(
          'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
          tone[badge.kind],
        )}
      >
        {badge.value}
      </span>
    )
  }
  return <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-content-muted">{badge}</span>
}
