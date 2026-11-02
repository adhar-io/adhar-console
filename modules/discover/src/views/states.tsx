import type { ReactNode } from 'react'
import { Button, EmptyState, Spinner } from '@adhar/shell-ui'
import { classifySourceError, sourceErrorKind } from '../data/source-error.ts'

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
  const { title, description } = classifySourceError(tool, error)
  // A tool nobody connected is a setup step, not a failure — keep it neutral.
  const tone = sourceErrorKind(error) === 'not-configured' ? 'default' : 'error'
  return (
    <EmptyState
      compact={compact}
      tone={tone}
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
