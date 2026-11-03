import { Button, DocStoreError, EmptyState, Skeleton } from '@adhar/shell-ui'

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
  // No database configured is a setup step, not an outage — say what to do, neutrally.
  const noDb = error instanceof DocStoreError && (error.code === 'store_unavailable' || error.status === 503)
  return (
    <EmptyState
      tone={noDb ? 'default' : 'error'}
      title={noDb ? 'Connect a database to use Design' : title}
      description={noDb
        ? 'Design documents are stored in the console’s Postgres document store. Point the console at a database (DATABASE_URL) and reload — nothing is faked in the meantime.'
        : readableError(error)}
      action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
    />
  )
}

/**
 * An api-client `HttpError` reads "HTTP 502 Bad Gateway at GET http://…/api/svc/…"
 * — accurate, but not a sentence. When the console BFF said why (its JSON
 * `{ error: code }`), say that instead; otherwise keep the message.
 */
export function readableError(error: Error): string {
  const body = (error as { body?: unknown }).body
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  switch (code) {
    case 'upstream_unreachable':
      return 'The console could not connect to the service. Check that it is running, then retry.'
    case 'upstream_timeout':
      return 'The service did not answer in time. Retry in a moment.'
    case 'login_session_failed':
      return 'The service refused the console’s service credential. Check it in the console server’s environment.'
    case 'tool_not_configured':
    case 'auth_not_configured':
    case 'basic_credentials_missing':
    case 'login_credentials_missing':
      return 'The console is not configured to reach this service.'
  }
  return error.message
}
