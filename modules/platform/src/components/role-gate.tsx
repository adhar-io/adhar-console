import type { ReactNode } from 'react'
import { StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  K8S_PERMISSION_LABEL,
  K8S_ROLE_LABEL,
  K8S_ROLE_TONE,
  rolesHaveK8sPermission,
  useK8sCurrentRoles,
  whichRolesHave,
  type K8sPermission,
  type K8sRole,
} from '../data/access.ts'

/**
 * Wraps an action so it renders normally when the current roles satisfy the
 * permission, or in one of two restricted modes otherwise:
 *
 *   - default: replaces children with a friendly "Restricted" card showing
 *              who CAN run the action.
 *   - readOnly: keeps the children visible but disables interaction and
 *               overlays a small "required role" pill, so the user can still
 *               see what the screen would do.
 */
export function RequireK8sPermission({
  perm,
  children,
  fallback,
  readOnly = false,
}: {
  perm: K8sPermission
  children: ReactNode
  fallback?: ReactNode
  readOnly?: boolean
}) {
  const roles = useK8sCurrentRoles()
  const allowed = rolesHaveK8sPermission(roles, perm)
  if (allowed) return <>{children}</>
  if (!readOnly) {
    return <>{fallback ?? <K8sPermissionDenied perm={perm} />}</>
  }
  return (
    <div className="relative" aria-disabled="true">
      <div className="pointer-events-none opacity-55">{children}</div>
      <div className="pointer-events-none absolute right-2 top-2 z-10 max-w-[calc(100%-1rem)]">
        <K8sRolePill perm={perm} />
      </div>
    </div>
  )
}

export function K8sPermissionDenied({
  perm,
  compact = false,
}: {
  perm: K8sPermission
  compact?: boolean
}) {
  const required = whichRolesHave(perm)
  return (
    <div
      className={cn(
        'rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 text-sm text-amber-900 dark:text-amber-200',
        compact ? 'p-3' : 'p-6',
      )}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <IconLock />
        </span>
        <div className="min-w-0">
          <div className="font-semibold">{K8S_PERMISSION_LABEL[perm]} requires elevated access</div>
          <p className="mt-1 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
            Your current role doesn't include{' '}
            <code className="font-mono text-amber-900 dark:text-amber-200">{perm}</code>. Ask an administrator to grant
            the role{' '}
            <code className="font-mono text-amber-900 dark:text-amber-200">
              {required.map((r) => K8S_ROLE_LABEL[r]).join(' or ')}
            </code>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

export function K8sRolePill({
  perm,
  className,
}: {
  perm: K8sPermission
  className?: string
}) {
  const required = whichRolesHave(perm)
  if (!required.length) return null
  const primary = required[0]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider text-content-muted shadow-sm align-middle',
        'border-edge-default',
        className,
      )}
      title={`Requires ${required.map((r) => K8S_ROLE_LABEL[r]).join(', ')} · ${K8S_PERMISSION_LABEL[perm]}`}
    >
      <IconLock />
      <span className="whitespace-nowrap">
        {K8S_ROLE_LABEL[primary]}
        {required.length > 1 ? ` +${required.length - 1}` : ''}
      </span>
    </span>
  )
}

export function K8sRoleBadge({ role }: { role: K8sRole }) {
  return <StatusBadge kind={K8S_ROLE_TONE[role]}>{K8S_ROLE_LABEL[role]}</StatusBadge>
}

function IconLock() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
