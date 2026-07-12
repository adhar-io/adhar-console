import type { ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

interface Props {
  title: ReactNode
  description?: ReactNode
  /** Optional pill rendered inline next to the title. */
  badge?: ReactNode
  actions?: ReactNode
  /** Tight bottom margin. Useful inside tabs/sub-headers. */
  compact?: boolean
  className?: string
}

export function PageHeader({
  title,
  description,
  badge,
  actions,
  compact = false,
  className,
}: Props) {
  return (
    <header
      className={cn(
        'flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6',
        compact ? 'mb-4' : 'mb-6',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-content sm:text-[28px]">
            {title}
          </h1>
          {badge}
        </div>
        {description ? (
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-content-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
