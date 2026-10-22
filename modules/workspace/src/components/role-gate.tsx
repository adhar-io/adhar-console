import type { ReactNode } from 'react'
import { StatusBadge, useAccessReview, type AccessCheck } from '@adhar/shell-ui'
import { ROLE_LABEL, ROLE_TONE, type Role } from '../data/access.ts'

/**
 * Write gating for Settings — Kubernetes RBAC, asked as the signed-in user
 * (docs/rbac.md). Every write a settings page makes goes to a BFF endpoint
 * guarded by a `CONSOLE_PERMISSIONS` entry; the page asks the same question
 * before it offers the action.
 *
 * Blocked actions are HIDDEN, not disabled — and stay hidden while the answer
 * loads. A form the user may read but not change stays visible in `readOnly`
 * mode: its controls are inert (a disabled fieldset), and its submit buttons
 * live in the page header where they are wrapped without `readOnly`, so they
 * simply are not there.
 */
export function RequirePermission({
  check,
  children,
  fallback = null,
  readOnly = false,
}: {
  /** One check, or several that must ALL be allowed (CONSOLE_PERMISSIONS entries). */
  check: AccessCheck | readonly AccessCheck[]
  children: ReactNode
  /** Rendered instead when not allowed (and while loading). Default: nothing. */
  fallback?: ReactNode
  /** Keep the children visible but inert — for forms that double as the read-only view. */
  readOnly?: boolean
}) {
  const { allowed } = useAccessReview(check)
  if (allowed) return <>{children}</>
  if (!readOnly) return <>{fallback}</>
  // `display: contents` keeps the form's own layout; `disabled` on a fieldset
  // makes every nested input, select and button inert in one place.
  return (
    <fieldset disabled className="contents" aria-readonly="true">
      {children}
    </fieldset>
  )
}

/**
 * "Read only" pill beside a settings page title, shown once the user is known
 * NOT to hold the page's write permission — it explains why the page has no
 * buttons. Nothing while loading, when unknown, or when allowed.
 */
export function ReadOnlyPill({ check }: { check: AccessCheck | readonly AccessCheck[] }) {
  // Only a definite "no" — an answer that could not be obtained (cluster
  // unreachable, no session) is not evidence the page is read-only.
  const { results } = useAccessReview(check)
  if (!results.some((r) => r === false)) return null
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-edge-default bg-surface-sunken px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wider text-content-muted"
      title="Your Kubernetes RBAC on this cluster does not allow changes here. Ask a workspace admin for access."
    >
      <IconLock />
      Read only
    </span>
  )
}

export function RoleBadge({ role }: { role: Role }) {
  return <StatusBadge kind={ROLE_TONE[role]}>{ROLE_LABEL[role]}</StatusBadge>
}

function IconLock() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
