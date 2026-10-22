import { Button, EmptyState, MetabaseIcon, Skeleton } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { Icon } from '../components/bi-kit.tsx'

/**
 * Shared honest states for the Metabase-backed BI surfaces.
 *
 * The Metabase client is REAL by default — it talks to the live instance
 * through the console BFF proxy (`/api/svc/metabase/…`, authenticated by the
 * server). Failures are classified from what the proxy and Metabase actually
 * answer, so the page says *which* thing is wrong:
 *
 *   • not configured — the proxy has no Metabase URL or credentials (503
 *     `tool_not_configured` / `*_credentials_missing`);
 *   • starting / unreachable — the proxy couldn't connect (502
 *     `upstream_unreachable`, network error, timeout) or Metabase answered 503
 *     while it initialises;
 *   • sign-in failed — the configured credentials were rejected (401, 502
 *     `login_session_failed`);
 *   • no permission — Metabase answered 403 for this account;
 *   • not found — 404.
 *
 * "No <thing>" empties are reserved for a reachable Metabase that genuinely
 * has nothing yet.
 */

export type MbErrorKind = 'not-configured' | 'starting' | 'auth' | 'forbidden' | 'not-found' | 'error'

export interface MbErrorInfo {
  kind: MbErrorKind
  title: string
  detail: string
  status?: number
}

function bodyCode(e: unknown): string {
  const b = (e as { body?: unknown })?.body
  if (b && typeof b === 'object' && 'error' in b) return String((b as { error: unknown }).error)
  return ''
}

/** Metabase's own message, when the body carries one. */
export function mbMessage(e: unknown): string {
  const b = (e as { body?: unknown })?.body
  if (typeof b === 'string' && b.trim() && b.length < 400 && !b.trim().startsWith('<')) return b.trim()
  if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>
    const m = o.message ?? o.cause ?? (o.errors && typeof o.errors === 'object' ? Object.values(o.errors as object).join('; ') : undefined)
    if (typeof m === 'string' && m) return m
  }
  return (e as Error)?.message ?? 'Request failed'
}

export function classifyMbError(e: unknown): MbErrorInfo {
  const status = (e as { status?: number })?.status
  const name = (e as Error)?.name
  const code = bodyCode(e)
  if (code === 'tool_not_configured' || code === 'unknown_tool') {
    return { kind: 'not-configured', status, title: 'Metabase is not configured', detail: 'The console has no Metabase address. Set METABASE_URL on the console server.' }
  }
  if (/credentials_missing|auth_not_configured/.test(code)) {
    return {
      kind: 'not-configured',
      status,
      title: 'Metabase credentials are missing',
      detail: 'Set METABASE_API_KEY (preferred) or METABASE_USERNAME / METABASE_PASSWORD on the console server.',
    }
  }
  if (code === 'login_session_failed' || status === 401) {
    return { kind: 'auth', status, title: 'Metabase rejected the console’s sign-in', detail: 'The configured API key or admin credentials were not accepted. Check them in the console server’s environment.' }
  }
  if (code === 'upstream_unreachable' || name === 'NetworkError' || name === 'TimeoutError' || status === 503 || status === 504 || status === 502) {
    return {
      kind: 'starting',
      status,
      title: 'Metabase is starting or unreachable',
      detail: 'The console could not get an answer from Metabase. It may still be initialising — this usually clears within a few minutes.',
    }
  }
  if (status === 403) {
    return { kind: 'forbidden', status, title: 'No permission', detail: mbMessage(e) || 'Your Metabase account is not allowed to do this.' }
  }
  if (status === 404) return { kind: 'not-found', status, title: 'Not found', detail: 'Metabase has no such item — it may have been moved to the trash.' }
  return { kind: 'error', status, title: 'Metabase returned an error', detail: mbMessage(e) }
}

/** Short message for toasts. */
export function errorToast(e: unknown): string {
  const i = classifyMbError(e)
  return i.kind === 'error' || i.kind === 'forbidden' ? i.detail : i.title
}

/** Full-area state when a whole BI page can't load. */
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
  const info = classifyMbError(error)
  return (
    <EmptyState
      icon={<MetabaseIcon size={26} />}
      title={info.title}
      description={
        <>
          Couldn’t load {resource}. {info.detail}
          {info.status ? <span className="mt-1 block font-mono text-[11px] text-content-subtle">HTTP {info.status}</span> : null}
        </>
      }
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry} loading={retrying} leading={<Icon name="refresh" size={14} />}>
            Retry
          </Button>
        ) : undefined
      }
    />
  )
}

/** Compact in-card error, e.g. one dashboard card failing while the rest render. */
export function InlineError({ error, message, onRetry, className }: { error?: unknown; message?: string; onRetry?: () => void; className?: string }) {
  const info = error ? classifyMbError(error) : null
  const text = message ?? (info ? (info.kind === 'error' || info.kind === 'forbidden' ? info.detail : info.title) : 'Something went wrong')
  return (
    <div role="alert" className={cn('flex h-full min-h-16 flex-col items-center justify-center gap-2 p-3 text-center', className)}>
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-rose-700 dark:text-rose-300">
        <Icon name="warning" size={14} />
        {info?.kind === 'forbidden' ? 'No permission' : 'Couldn’t load'}
      </span>
      <span className="line-clamp-3 max-w-md wrap-break-word text-[11px] text-content-muted">{text}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="text-[11px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Retry
        </button>
      ) : null}
    </div>
  )
}

/** A skeleton grid used while a BI list is loading. */
export function BiSkeletonGrid({ cards = 6 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
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

/** Skeleton rows for list layouts. */
export function BiSkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton width={28} height={28} rounded="lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton width="40%" height={12} />
            <Skeleton width="65%" height={10} />
          </div>
        </div>
      ))}
    </div>
  )
}
