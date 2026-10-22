import { lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { ErrorBoundary } from '@adhar/shell-ui'

interface Props {
  loader(): Promise<{ default: ComponentType<Record<string, unknown>> }>
  fallback?: ReactNode
  componentProps?: Record<string, unknown>
  /** Label shown in the fallback skeleton — e.g. "Develop". */
  label?: string
}

/**
 * Loader for a single exposed Module Federation component.
 *
 * Callers pass an `import()` expression directly so `@module-federation/vite`
 * can statically transform it at build time:
 *
 *   <RemoteModule loader={() => import('develop/Home')} />
 *
 * `componentProps` are forwarded to the lazy component — use this to pass
 * the current `?section=<x>` down so modules can open the right tab.
 */
export function RemoteModule({ loader, fallback, componentProps = {}, label }: Props) {
  // `useMemo` prevents React.lazy from being recreated across renders when
  // componentProps change — same loader ref = same chunk, no reload.
  // `attempt` is the one deliberate exception: React.lazy caches a REJECTED
  // load forever, so the boundary's "Try again" used to re-throw the same
  // failed import (a network blip, a remote mid-rollout) with no way out
  // short of a full reload. A retry builds a fresh lazy that imports again.
  const [attempt, setAttempt] = useState(0)
  const Lazy = useMemo(() => lazy(loader), [loader, attempt])
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <LoadFailed
          label={label}
          error={error}
          onRetry={() => {
            setAttempt((n) => n + 1)
            reset()
          }}
        />
      )}
    >
      <Suspense fallback={fallback ?? <DefaultFallback label={label} />}>
        <Lazy {...componentProps} />
      </Suspense>
    </ErrorBoundary>
  )
}

/**
 * Loader for a remote that exposes a TanStack route tree (`./routes`).
 * The remote returns its own route subtree; the host mounts it under
 * a phase prefix.
 */
export function RemoteRoutes({ loader, fallback, label }: Props) {
  return <RemoteModule loader={loader} fallback={fallback} label={label} />
}

/**
 * A module that failed to load or render. A chunk that 404s after a new
 * release was deployed under the open tab can only be fixed by reloading the
 * page (the old asset hashes are gone), so that is offered next to the retry.
 */
function LoadFailed({ label, error, onRetry }: { label?: string; error: Error; onRetry(): void }) {
  const chunkLoad = /dynamically imported module|Failed to fetch|Loading chunk|remoteEntry|error loading/i.test(
    error.message,
  )
  return (
    <div
      role="alert"
      className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 p-6 text-rose-900 dark:text-rose-200"
    >
      <div className="text-sm font-semibold">
        {chunkLoad ? `${label ?? 'This section'} could not be loaded` : 'Something went wrong'}
      </div>
      <p className="mt-1 text-xs">
        {chunkLoad
          ? 'The network dropped or the console was just updated. Try again, or reload the page to pick up the latest version.'
          : error.message}
      </p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-rose-300 bg-surface-raised px-3 py-1.5 text-sm font-medium text-rose-900 dark:text-rose-200 hover:bg-rose-50 dark:hover:bg-rose-500/10"
        >
          Try again
        </button>
        {chunkLoad ? (
          <button
            type="button"
            onClick={() => globalThis.location?.reload()}
            className="rounded-md border border-rose-300 bg-surface-raised px-3 py-1.5 text-sm font-medium text-rose-900 dark:text-rose-200 hover:bg-rose-50 dark:hover:bg-rose-500/10"
          >
            Reload page
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Branded loading skeleton — mirrors the AppShell content area (title, tabs,
 * stat tiles, content cards) so switching modules never jumps the layout and
 * never flashes an unstyled/bordered box. Uses the shared themed
 * `.skeleton-shimmer` utility (defined in the host stylesheet), so the plate +
 * sweep track the active light/dark theme instead of hardcoded grays.
 */
function DefaultFallback({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={label ? `Loading ${label}` : 'Loading module'}
      className="space-y-6 motion-safe:animate-[adhar-fade-in_180ms_ease-out]"
    >
      {/* Page header — title + subtitle + an action placeholder */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2.5">
          <div className="skeleton-shimmer h-7 w-52 rounded-md" />
          <div className="skeleton-shimmer h-4 w-80 max-w-[70vw] rounded" />
        </div>
        <div className="skeleton-shimmer hidden h-8 w-28 rounded-md sm:block" />
      </div>

      {/* Tab / filter row */}
      <div className="flex flex-wrap gap-2">
        {[72, 90, 64, 96, 76].map((w, i) => (
          <div key={i} className="skeleton-shimmer h-7 rounded-md" style={{ width: w }} />
        ))}
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer h-20 rounded-xl"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>

      {/* Content cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer h-28 rounded-lg"
            style={{ animationDelay: `${i * 70}ms` }}
          />
        ))}
      </div>
      <span className="sr-only">Loading{label ? ` ${label}` : ''}…</span>
    </div>
  )
}
