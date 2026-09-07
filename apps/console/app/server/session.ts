import { DEFAULT_TENANT } from '@adhar-console/tenancy'
import type { Notification } from '@adhar-console/shell-ui'

/**
 * App-shell layout data: the available tenants and the seed notification feed.
 *
 * The signed-in **user** is intentionally NOT resolved here. In production the
 * shell only renders client-side after `AuthProvider` has loaded the session
 * from `/api/auth/session` (the root route shows a boot splash until then), so
 * components read the user from `useOptionalSession()` — the cookie-backed
 * source of truth — rather than from this loader. This keeps the loader
 * isomorphic and free of any token handling.
 */
export function getLayoutData() {
  // The shell's organization switcher loads the user's REAL organizations from
  // `/api/organizations` client-side; these are only the fallback shown while
  // that list loads / when signed out. The built-in default organization is a
  // real, manageable org (not a demo company) — see @adhar-console/tenancy.
  return {
    tenants: [DEFAULT_TENANT],
    activeTenant: DEFAULT_TENANT,
    notifications: getSeedNotifications(),
  }
}

/**
 * Seed notifications returned by the loader on every request. The client-side
 * `useNotifications` hook merges these with localStorage-persisted read /
 * dismissed state, so the user's interactions survive reloads even though the
 * seed itself is recomputed fresh.
 *
 * Replace with a real `/api/notifications` feed once the BFF exists.
 */
function getSeedNotifications(): Notification[] {
  const now = Date.now()
  const mins = (m: number) => new Date(now - m * 60_000).toISOString()
  const hours = (h: number) => new Date(now - h * 3600_000).toISOString()

  return [
    {
      id: 'deploy-adhar-console-128',
      title: 'adhar-console v0.1.4 deployed to production',
      description: 'Argo Rollout completed all canary steps. 6 replicas healthy.',
      at: mins(4),
      kind: 'success',
      href: '/deliver?section=rollouts',
    },
    {
      id: 'pr-review-request-482',
      title: 'Review requested on #482 — "Add theming presets"',
      description: 'maya asked for your review in adhar/adhar-console.',
      at: mins(18),
      kind: 'info',
      href: '/develop?section=prs',
    },
    {
      id: 'kyverno-violation-12',
      title: 'Kyverno policy violation in prod',
      description:
        '1 Deployment in namespace "payments" violates require-image-digest. Pod creation was blocked.',
      at: mins(42),
      kind: 'warning',
      href: '/deliver?section=policy',
    },
    {
      id: 'argo-sync-billing',
      title: 'billing-service is OutOfSync',
      description: 'Manifests in argocd-apps diverged from live resources after a hotfix.',
      at: hours(2),
      kind: 'warning',
      href: '/deliver?section=apps',
    },
    {
      id: 'harbor-cve-high',
      title: 'New high-severity CVE in registry',
      description: 'CVE-2026-4182 affects payments-api:2.3.1 (base image alpine:3.19).',
      at: hours(6),
      kind: 'error',
      href: '/deliver?section=registry',
    },
    {
      id: 'usage-quota-80',
      title: 'Monthly usage at 80% of plan',
      description: 'Review the Usage dashboard or upgrade before quota enforcement kicks in.',
      at: hours(20),
      kind: 'info',
      href: '/settings?section=usage',
    },
  ]
}
