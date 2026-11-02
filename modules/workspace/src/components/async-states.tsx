import { Button, DocStoreError, EmptyState, Spinner, StatusBadge } from '@adhar/shell-ui'

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
    <EmptyState
      // No database is a setup step, not an outage — keep it neutral.
      tone={noDb ? 'default' : 'error'}
      title={noDb ? 'Connect a database to use this page' : "Couldn't reach the document store"}
      description={noDb
        ? 'This configuration is persisted in the tenant-scoped Postgres document store. Point the console at a database (DATABASE_URL) and reload — nothing is faked in the meantime.'
        : error.message}
      action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
    />
  )
}

/**
 * Honest status chip for configuration the console records but does not
 * itself enforce/activate (SSO → Keycloak, IP ranges → gateway, …).
 */
export function RecordedOnlyBadge({ label = 'Saved — apply in Keycloak' }: { label?: string }) {
  return <StatusBadge kind="paused">{label}</StatusBadge>
}
