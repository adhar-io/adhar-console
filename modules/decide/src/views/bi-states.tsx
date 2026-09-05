import { Button, EmptyState, MetabaseIcon, Skeleton } from '@adhar-console/shell-ui'

/**
 * Shared honest states for the Metabase-backed BI surfaces (dashboards,
 * questions, databases, SQL editor, pulses).
 *
 * The Metabase client is REAL by default — it talks to the live instance
 * through the console BFF proxy (`/api/svc/metabase/…`, service-authenticated
 * by the server). When Metabase isn't configured or is unreachable the proxy
 * errors and the query surfaces it, so these views render a "not connected"
 * state (with a retry) rather than an empty list that implies a healthy,
 * item-less Metabase. "No <thing>" empties are reserved for a reachable
 * Metabase that genuinely has nothing yet.
 */

export function MetabaseUnavailable({
  resource,
  error,
  onRetry,
  retrying,
}: {
  /** What we were loading, e.g. "dashboards". */
  resource: string
  error: unknown
  onRetry?: () => void
  retrying?: boolean
}) {
  const msg = (error as Error)?.message ?? 'request failed'
  return (
    <EmptyState
      icon={<MetabaseIcon size={44} />}
      title="Metabase not connected"
      description={
        <>
          Couldn’t load {resource} ({msg}). Configure{' '}
          <code className="font-mono">METABASE_URL</code> /{' '}
          <code className="font-mono">METABASE_API_KEY</code> so the console proxy can reach your
          Metabase instance.
        </>
      }
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        ) : undefined
      }
    />
  )
}

/** A skeleton grid used while a BI list is loading. */
export function BiSkeletonGrid({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: cards }).map((_, i) => (
        <div
          key={i}
          className="space-y-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <Skeleton width="45%" height={12} />
            <Skeleton width={48} height={16} rounded="full" />
          </div>
          <Skeleton width="70%" height={16} />
          <Skeleton width="100%" height={64} rounded="lg" />
        </div>
      ))}
    </div>
  )
}
