import type { ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

/**
 * A page's title row.
 *
 * No description. Every page carried a sentence under its heading explaining
 * what the page was — "Every service, API, resource and team the organisation
 * depends on…" above a screen already full of services, APIs and resources.
 * It restated the title at length, pushed the content down by a paragraph on
 * every route, and was read once and never again. The title says what the page
 * is; the page says the rest.
 */
interface Props {
  title: ReactNode
  /** Optional pill rendered inline next to the title. */
  badge?: ReactNode
  actions?: ReactNode
  /** Tight bottom margin. Useful inside tabs/sub-headers. */
  compact?: boolean
  className?: string
}

export function PageHeader({
  title,
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
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}
