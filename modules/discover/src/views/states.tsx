import type { ReactNode } from 'react'
import { Button, EmptyState, Spinner } from '@adhar-console/shell-ui'

/**
 * Honest source states for every Discover view.
 *
 * The views never fabricate rows or series — when a backing tool (Prometheus /
 * Loki / Tempo / Grafana / Alertmanager / PostHog) is unreachable, not
 * configured, or returns nothing, we say so plainly and offer a retry rather
 * than rendering blank space or, worse, fake data.
 */

/** Inline "loading …" card, matching the spinner blocks used across views. */
export function LoadingCard({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
      <Spinner size={14} /> {label}
    </div>
  )
}

/**
 * Duck-typed classification of an api-client error. We avoid importing the
 * `HttpError` class (it isn't re-exported from the package root) and instead
 * read the shape the base HTTP layer guarantees: `.status` on response errors,
 * `.name` = 'NetworkError' | 'TimeoutError' otherwise.
 */
function classify(
  tool: string,
  error: unknown,
): { title: string; description: string } {
  const status = (error as { status?: number } | null)?.status
  const name = (error as { name?: string } | null)?.name

  if (status === 404 || status === 501) {
    return {
      title: `${tool} is not configured`,
      description: `No ${tool} backend is wired to this workspace yet. Connect ${tool} through the platform integrations to populate this view.`,
    }
  }
  if (status === 401 || status === 403) {
    return {
      title: `Not authorized for ${tool}`,
      description: `Your session can't read from ${tool}. Check your role or re-authenticate, then retry.`,
    }
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      title: `${tool} is unavailable`,
      description: `The ${tool} backend responded but isn't ready (HTTP ${status}). It may be starting up — retry in a moment.`,
    }
  }
  if (name === 'TimeoutError') {
    return {
      title: `${tool} timed out`,
      description: `The request to ${tool} took too long to respond. Retry, or check the backend's health.`,
    }
  }
  if (name === 'NetworkError') {
    return {
      title: `Can't reach ${tool}`,
      description: `The console couldn't connect to ${tool} through the BFF proxy. Confirm the backend is running and try again.`,
    }
  }
  return {
    title: `Couldn't load ${tool} data`,
    description:
      error instanceof Error && error.message
        ? error.message
        : `An unexpected error occurred talking to ${tool}.`,
  }
}

/**
 * Honest error / not-configured state for a view whose single source failed.
 * `icon` is typically the tool's brand mark from shell-ui.
 */
export function SourceError({
  tool,
  error,
  onRetry,
  icon,
  compact = false,
}: {
  tool: string
  error: unknown
  onRetry?: () => void
  icon?: ReactNode
  compact?: boolean
}) {
  const { title, description } = classify(tool, error)
  return (
    <EmptyState
      compact={compact}
      icon={icon}
      title={title}
      description={description}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  )
}
