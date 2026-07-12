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
                    ? 'bg-slate-100 font-medium text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                  t.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <div>{t.label}</div>
                {t.description ? (
                  <div className="text-[11px] text-slate-500">{t.description}</div>
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

  return (
    <div className={cn('space-y-5', className)}>
      <div className="flex items-end justify-between gap-4 border-b border-slate-200">
        <nav
          role="tablist"
          aria-label={ariaLabel}
          aria-orientation="horizontal"
          className="-mb-px flex gap-1 overflow-x-auto"
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
                disabled={t.disabled}
                onClick={() => setActive(t.id)}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-all',
                  isActive
                    ? 'border-slate-900 font-medium text-slate-900'
                    : 'border-transparent text-slate-500 hover:border-slate-200 hover:text-slate-800',
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
      healthy: 'bg-emerald-100 text-emerald-800',
      degraded: 'bg-rose-100 text-rose-800',
      progressing: 'bg-indigo-100 text-indigo-800',
      paused: 'bg-amber-100 text-amber-800',
      failed: 'bg-rose-200 text-rose-900',
      unknown: 'bg-slate-100 text-slate-700',
      info: 'bg-sky-100 text-sky-800',
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
  return <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">{badge}</span>
}
