import { cn } from '@adhar/utils'
import type { AccessCheck } from '@adhar/shell-ui'

/**
 * Access gating in the cluster views is Kubernetes RBAC, asked as the
 * signed-in user with a SelfSubjectAccessReview (docs/rbac.md): wrap every
 * mutating action in shell-ui's `<Can check={canResource(GVR, verb, {namespace,
 * name})}>` (or gate it on `useCan` / `useAccess`). Blocked ACTIONS are hidden,
 * not disabled, and stay hidden while the answer loads.
 *
 * This file holds the one thing that is not an action: the notice shown in
 * place of a READ the user is not allowed — a Logs or Shell tab body, a Secret
 * value — so the panel explains itself instead of rendering blank.
 */

/** `get pods/log in shop` — the RBAC rule a check asks for, as an operator would type it. */
export function ruleText(check: AccessCheck): string {
  const res = check.group ? `${check.resource}.${check.group}` : check.resource
  const sub = check.subresource ? `/${check.subresource}` : ''
  const where = check.namespace ? ` in ${check.namespace}` : ''
  return `${check.verb} ${res}${sub}${where}`
}

export function AccessDenied({
  what,
  check,
  compact = false,
  className,
}: {
  /** What the user cannot see, e.g. "this pod's logs". */
  what: string
  /** The check that came back "no" — named so an admin knows what to grant. */
  check: AccessCheck
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-edge-default bg-surface-sunken text-sm text-content',
        compact ? 'p-3' : 'p-5',
        className,
      )}
      role="note"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-raised text-content-muted ring-1 ring-edge-default">
          <IconLock />
        </span>
        <div className="min-w-0">
          <div className="font-medium">You don't have access to {what}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
            Your Kubernetes RBAC on this cluster doesn't allow{' '}
            <code className="break-all rounded bg-surface-raised px-1 py-0.5 font-mono text-[11px] text-content">
              {ruleText(check)}
            </code>
            . Ask a platform admin to grant it.
          </p>
        </div>
      </div>
    </div>
  )
}

function IconLock() {
  return (
    <svg
      width="12"
      height="12"
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
