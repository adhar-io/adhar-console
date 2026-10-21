import { DEFAULT_TENANT } from '@adhar/tenancy'

/**
 * App-shell layout data: the available tenants. Notifications are NOT part of
 * it — the shell reads the real feed from `/api/notifications` (no seed).
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
  // real, manageable org (not a demo company) — see @adhar/tenancy.
  return {
    tenants: [DEFAULT_TENANT],
    activeTenant: DEFAULT_TENANT,
  }
}

