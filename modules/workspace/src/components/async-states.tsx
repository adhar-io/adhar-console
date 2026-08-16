import { DocStoreError, Spinner, StatusBadge } from '@adhar-console/shell-ui'

/**
 * Shared loading / error blocks for the docStore-backed ENTERPRISE-SECURITY
 * views. A `DocStoreError` (e.g. 503 when no database is configured)
 * surfaces through the query's `error` and is rendered here — it is never
 * swallowed into fake data.
 */

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-edge-default bg-surface-raised py-16 text-sm text-content-muted shadow-sm">
      <Spinner size={16} />
      {label}
    </div>
  )
}

export function StoreErrorBlock({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const noDb =
    error instanceof DocStoreError && (error.code === 'store_unavailable' || error.status === 503)
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-6 shadow-sm dark:border-rose-500/30 dark:bg-rose-500/10">
      <div className="text-sm font-semibold text-rose-800 dark:text-rose-300">
        {noDb ? 'Connect a database to use this page' : "Couldn't reach the document store"}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-rose-700 dark:text-rose-400">
        {noDb
          ? 'This configuration is persisted in the tenant-scoped Postgres document store. Point the console at a database (DATABASE_URL) and reload — nothing is faked in the meantime.'
          : error.message}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-rose-300 bg-surface-raised px-3 py-1.5 text-xs font-semibold text-rose-700 shadow-sm hover:bg-rose-100 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/20"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}

/**
 * Honest status chip for configuration the console records but does not
 * itself enforce/activate (SSO → Keycloak, IP ranges → gateway, …).
 */
export function RecordedOnlyBadge({ label = 'Saved — apply in Keycloak' }: { label?: string }) {
  return <StatusBadge kind="paused">{label}</StatusBadge>
}
