import { EmptyState } from '@adhar-console/shell-ui'
import type { ReactNode } from 'react'

/**
 * Rendered when the API group behind a view isn't registered on the cluster.
 *
 * A 404 from the apiserver for a CRD path is not an error the user caused and
 * not one they can retry — the operator simply isn't installed. Saying that
 * plainly, with the install guide, is more use than a red error banner.
 *
 * Local to `modules/develop`: `modules/deliver` has its own copy because the
 * two are separate Module-Federation remotes and must not import across the
 * boundary, and `packages/shell-ui` is source-aliased into all nine remotes so
 * anything put there is bundled nine times.
 */
export function CrdMissing({
  tool,
  href,
  action,
  children,
}: {
  /** Product name, as the user would say it. */
  tool: string
  /** Upstream install guide. */
  href: string
  /** Optional primary action — e.g. a link to the tool itself. */
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <EmptyState
      title={`${tool} is not installed`}
      description={
        <>
          The CRDs for {tool} aren't registered on this cluster, so there is nothing to show yet.
          Install the operator and this view populates on its own.{' '}
          <a className='text-brand-700 underline dark:text-brand-300' href={href} target='_blank' rel='noreferrer'>
            Install guide ↗
          </a>
          {children}
        </>
      }
      action={action}
    />
  )
}
