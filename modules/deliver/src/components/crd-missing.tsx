import { EmptyState } from '@adhar-console/shell-ui'
import type { ReactNode } from 'react'

/**
 * Rendered when the underlying CRD group isn't installed on the cluster.
 * Tells the user how to install the operator instead of a bare error.
 */
export function CrdMissing({
  tool,
  href,
  children,
}: {
  tool: string
  href: string
  children?: ReactNode
}) {
  return (
    <EmptyState
      title={`${tool} not installed`}
      description={
        <>
          The CRDs for {tool} aren't registered on this cluster. Install the operator and this
          view will populate automatically.{' '}
          <a
            className="text-brand-700 underline"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            Install guide ↗
          </a>
          {children}
        </>
      }
    />
  )
}
