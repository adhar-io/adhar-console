import type { ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

interface Props {
  title: string
  description?: ReactNode
  action?: ReactNode
  /** Icon slot — a decorative symbol shown at the top. */
  icon?: ReactNode
  /** Compact variant for inline use inside data-table empties. */
  compact?: boolean
  className?: string
}

export function EmptyState({ title, description, action, icon, compact = false, className }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-edge-strong bg-surface-sunken/40 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <div
        className={cn(
          'mb-4 flex items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200',
          compact ? 'h-9 w-9 text-sm' : 'h-12 w-12 text-base',
        )}
      >
        {icon ?? <DefaultIcon compact={compact} />}
      </div>
      <div className={cn('font-medium text-content', compact ? 'text-sm' : 'text-base')}>
        {title}
      </div>
      {description ? (
        <p
          className={cn(
            'max-w-md leading-relaxed text-content-muted',
            compact ? 'mt-1 text-xs' : 'mt-1.5 text-sm',
          )}
        >
          {description}
        </p>
      ) : null}
      {action ? <div className={compact ? 'mt-3' : 'mt-5'}>{action}</div> : null}
    </div>
  )
}

function DefaultIcon({ compact }: { compact: boolean }) {
  const size = compact ? 16 : 20
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" strokeOpacity="0.4" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  )
}
