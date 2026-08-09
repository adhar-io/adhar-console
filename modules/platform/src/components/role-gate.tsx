import type { ReactNode } from 'react'
import { StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  ALL_K8S_ROLES,
  K8S_PERMISSION_LABEL,
  K8S_ROLE_DESCRIPTION,
  K8S_ROLE_LABEL,
  K8S_ROLE_TONE,
  rolesHaveK8sPermission,
  setViewAsRole,
  useK8sCurrentRoles,
  useViewAsRole,
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
      <div className="pointer-events-none absolute right-2 top-2">
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
            , or use the "View as" switcher in the cluster header to preview that experience.
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
        'inline-flex items-center gap-1 rounded-full border bg-surface-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-muted shadow-sm',
        'border-edge-default',
        className,
      )}
      title={`Requires ${required.map((r) => K8S_ROLE_LABEL[r]).join(', ')} · ${K8S_PERMISSION_LABEL[perm]}`}
    >
      <IconLock />
      <span>
        {K8S_ROLE_LABEL[primary]}
        {required.length > 1 ? ` +${required.length - 1}` : ''}
      </span>
    </span>
  )
}

export function K8sRoleBadge({ role }: { role: K8sRole }) {
  return <StatusBadge kind={K8S_ROLE_TONE[role]}>{K8S_ROLE_LABEL[role]}</StatusBadge>
}

/**
 * Header chip that lets the operator preview each role's UI without
 * re-authenticating. Persists to localStorage so the choice survives reloads,
 * and surfaces a clear "Reset" affordance so it's never sticky by accident.
 */
export function ViewAsRoleSwitcher({ className }: { className?: string }) {
  const override = useViewAsRole()
  const current = useK8sCurrentRoles()[0]
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-edge-default bg-surface-raised/70 px-1.5 py-1 shadow-sm backdrop-blur',
        className,
      )}
      title="Preview the dashboard as a different role — affects RBAC gating in real time."
    >
      <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        <IconEye />
        View as
      </span>
      <select
        value={override ?? current}
        onChange={(e) => {
          const v = e.target.value as K8sRole
          setViewAsRole(v)
        }}
        className="rounded-full border border-edge-default bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-content focus:outline-none"
        aria-label="View as role"
      >
        {ALL_K8S_ROLES.map((r) => (
          <option key={r} value={r} title={K8S_ROLE_DESCRIPTION[r]}>
            {K8S_ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {override ? (
        <button
          type="button"
          onClick={() => setViewAsRole(null)}
          className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-muted hover:bg-surface-sunken hover:text-content"
          aria-label="Reset to your real role"
        >
          Reset
        </button>
      ) : null}
    </div>
  )
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

function IconEye() {
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
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
