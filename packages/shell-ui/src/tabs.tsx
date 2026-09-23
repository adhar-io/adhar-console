import { useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
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
  children,
}: Props<T>) {
  const visibleTabs = tabs.filter((t) => !t.hidden)
  const firstEnabled = visibleTabs.find((t) => !t.disabled)
  const [internal, setInternal] = useState<T>(defaultValue ?? (firstEnabled?.id as T))
  const active = (value ?? internal) as T
  const setActive = (next: T) => {
    if (onChange) onChange(next)
    if (value === undefined) setInternal(next)
  }

  if (orientation === 'vertical') {
    return (
      <div className={cn('grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]', className)}>
        <aside
          role="tablist"
          aria-label={ariaLabel}
          aria-orientation="vertical"
          className="space-y-0.5"
        >
          {visibleTabs.map((t) => {
            const isActive = t.id === active
            return (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={isActive}
                aria-controls={`panel-${t.id}`}
                disabled={t.disabled}
                onClick={() => setActive(t.id)}
                className={cn(
                  'block w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                  isActive
                    ? 'bg-surface-sunken font-medium text-content'
                    : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                  t.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <div>{t.label}</div>
                {t.description ? (
                  <div className="text-[11px] text-content-subtle">{t.description}</div>
                ) : null}
              </button>
            )
          })}
        </aside>
        <div
          role="tabpanel"
          id={`panel-${active}`}
          aria-labelledby={`tab-${active}`}
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
    ;(e.currentTarget.querySelector(`#tab-${CSS.escape(id)}`) as HTMLElement | null)?.focus()
  }

  return (
    <div className={cn('space-y-5', className)}>
      <div className="flex items-end justify-between gap-4 border-b border-edge-default">
        <nav
          role="tablist"
          aria-label={ariaLabel}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          className="-mb-px flex gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {visibleTabs.map((t) => {
            const isActive = t.id === active
            return (
              <button
                key={t.id}
                role="tab"
                type="button"
                id={`tab-${t.id}`}
                aria-selected={isActive}
                aria-controls={`panel-${t.id}`}
                tabIndex={isActive ? 0 : -1}
                disabled={t.disabled}
                onClick={() => setActive(t.id)}
                className={cn(
                  'relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2.5 text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/40',
                  // The active underline is the brand, not a hard black rule;
                  // a resting tab gets a faint underline on hover so the
                  // target reads before the click.
                  isActive
                    ? 'border-brand-600 font-medium text-content dark:border-brand-400'
                    : 'border-transparent text-content-subtle hover:border-edge-strong hover:text-content',
                  t.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {t.label}
                {renderBadge(t.badge)}
              </button>
            )
          })}
        </nav>
        {actions ? <div className="pb-2">{actions}</div> : null}
      </div>
      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
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
      failed: 'bg-rose-200 text-rose-900',
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
