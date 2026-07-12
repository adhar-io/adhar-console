import type { ReactNode } from 'react'
import { StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  ROLE_LABEL,
  ROLE_TONE,
  rolesHavePermission,
  useCurrentRoles,
  type Permission,
  type Role,
} from '../data/access.ts'

/**
 * Wraps a section / button so that it renders read-only or fully hides
 * depending on whether the current user has the required permission. The
 * "Required role" pill is shown so the operator immediately understands
 * who can change a setting (segregation-of-duty UX).
 */
export function RequirePermission({
  perm,
  /** Roles that satisfy the permission — purely cosmetic; affects the pill. */
  required,
  children,
  fallback,
  /** When true, render children with `pointerEvents:none` and a disabled tone instead of hiding. */
  readOnly = false,
}: {
  perm: Permission
  required: Role[]
  children: ReactNode
  fallback?: ReactNode
  readOnly?: boolean
}) {
  const roles = useCurrentRoles()
  const allowed = rolesHavePermission(roles, perm)
  if (!allowed && !readOnly) {
    return (
      <>
        {fallback ?? (
          <PermissionDenied required={required} perm={perm} />
        )}
      </>
    )
  }
  if (!allowed && readOnly) {
    return (
      <div className="relative" aria-disabled="true">
        <div className="pointer-events-none opacity-60">{children}</div>
        <div className="pointer-events-none absolute right-3 top-3">
          <RequiredRolePill required={required} />
        </div>
      </div>
    )
  }
  return <>{children}</>
}

export function PermissionDenied({ required, perm }: { required: Role[]; perm: Permission }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-6 text-sm text-amber-900">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
          <IconLock />
        </span>
        <div className="min-w-0">
          <div className="font-semibold">Restricted</div>
          <p className="mt-1 text-[12px] text-amber-800">
            Editing this section requires the{' '}
            <code className="font-mono text-amber-900">{required.map((r) => ROLE_LABEL[r]).join(' or ')}</code>{' '}
            role. Permission needed: <code className="font-mono text-amber-900">{perm}</code>.
          </p>
        </div>
      </div>
    </div>
  )
}

export function RequiredRolePill({
  required,
  className,
}: {
  required: Role[]
  className?: string
}) {
  if (!required.length) return null
  const primary = required[0]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shadow-sm',
        'border-edge-default text-content-muted',
        className,
      )}
      title={`Required role${required.length > 1 ? 's' : ''}: ${required.map((r) => ROLE_LABEL[r]).join(', ')}`}
    >
      <IconLock />
      <span>{ROLE_LABEL[primary]}{required.length > 1 ? ` +${required.length - 1}` : ''}</span>
    </span>
  )
}

export function RoleBadge({ role }: { role: Role }) {
  return <StatusBadge kind={ROLE_TONE[role]}>{ROLE_LABEL[role]}</StatusBadge>
}

function IconLock() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
