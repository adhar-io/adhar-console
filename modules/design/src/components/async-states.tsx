import { Spinner } from '@adhar-console/shell-ui'

/**
 * Shared loading / error blocks for views backed by the document store.
 * A `DocStoreError` (e.g. 503 when no database is configured) surfaces through
 * the query's `error` and is rendered here — never swallowed into fake data.
 */

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-edge-default bg-white py-16 text-sm text-content-muted shadow-sm">
      <Spinner size={16} />
      {label}
    </div>
  )
}

export function ErrorBlock({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 shadow-sm">
      <div className="text-sm font-semibold text-rose-800">
        Couldn't reach the document store
      </div>
      <p className="mt-1 text-xs leading-relaxed text-rose-700">{error.message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 shadow-sm hover:bg-rose-100"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
