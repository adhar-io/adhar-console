import { lazy, Suspense, useMemo, type ComponentType, type ReactNode } from 'react'
import { ErrorBoundary } from '@adhar-console/shell-ui'

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
  const Lazy = useMemo(() => lazy(loader), [loader])
  return (
    <ErrorBoundary>
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
