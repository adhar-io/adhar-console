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
 * Branded loading skeleton — mirrors the AppShell content area so the page
 * doesn't jump on hydration.
 */
function DefaultFallback({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ? `Loading ${label}` : 'Loading module'}
      className="space-y-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-48 animate-pulse rounded-md bg-slate-200" />
          <div className="h-4 w-80 animate-pulse rounded bg-slate-100" />
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-400" />
          Loading{label ? ` ${label}` : ''}…
        </div>
      </div>
      <div className="border-b border-slate-200">
        <div className="flex gap-2 pb-2">
          {[72, 88, 64, 96, 72].map((w, i) => (
            <div
              key={i}
              className="h-6 animate-pulse rounded bg-slate-100"
              style={{ width: w }}
            />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-lg border border-slate-200 bg-white shadow-sm"
            style={{ animationDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
