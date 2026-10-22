import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { Button, EmptyState } from '@adhar/shell-ui'

/**
 * Router-wide fallbacks. Without them an unknown path (`/nope`, or a phase
 * that `$phase.tsx` rejects with `notFound()`) and a throwing loader (the
 * layout's `getLayoutData`) fell through to TanStack's unstyled defaults — a
 * bare "Not Found" line or a red stack dump on an otherwise blank page.
 */
export function RouteNotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        className="w-full max-w-lg"
        title="This page does not exist"
        description="The link may be out of date, or the page has moved. Head back to the dashboard to find what you were looking for."
        action={
          <Link to="/" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
            Go to the dashboard
          </Link>
        }
      />
    </div>
  )
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const message = error instanceof Error ? error.message : String(error ?? '')
  return (
    <div role="alert" className="flex min-h-[60vh] items-center justify-center p-6">
      <EmptyState
        className="w-full max-w-lg"
        title="This page could not load"
        description={message || 'Something went wrong while loading this page.'}
        action={
          <Button
            variant="primary"
            onClick={() => {
              // `reset` clears the boundary; `invalidate` re-runs the loaders
              // that threw, so "Try again" actually retries instead of
              // re-rendering the same cached failure.
              reset()
              void router.invalidate()
            }}
          >
            Try again
          </Button>
        }
      />
    </div>
  )
}
