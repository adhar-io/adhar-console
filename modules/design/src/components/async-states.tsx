import { Button, Skeleton } from '@adhar/shell-ui'

/**
 * Shared loading / error blocks for views backed by the document store.
 * A `DocStoreError` (e.g. 503 when no database is configured) surfaces through
 * the query's `error` and is rendered here — never swallowed into fake data.
 */

/**
 * Skeleton shaped like a section's first paint — a toolbar row over a card
 * grid — so the page does not jump when the documents arrive. `label` is for
 * assistive tech only (no visible status text).
 */
export function LoadingBlock({ label = 'Loading…', cards = 6 }: { label?: string; cards?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={label} role="status">
      <div className="flex items-center justify-between gap-3">
        <Skeleton width={220} height={32} rounded="lg" />
        <Skeleton width={120} height={32} rounded="lg" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
            <Skeleton width="60%" height={14} />
            <Skeleton width="90%" height={10} />
            <Skeleton width="40%" height={10} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ErrorBlock({ error, onRetry, title = 'Couldn’t reach the document store' }: { error: Error; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-5 shadow-sm dark:border-rose-500/30 dark:bg-rose-500/10">
      <div className="text-sm font-semibold text-rose-800 dark:text-rose-200">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-rose-700 [overflow-wrap:anywhere] dark:text-rose-300">{error.message}</p>
      {onRetry ? <Button size="sm" className="mt-3" onClick={onRetry}>Retry</Button> : null}
    </div>
  )
}
