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
    // No notifications from the loader. They used to be six fabricated events
    // ("adhar-console v0.1.4 deployed to production", a review request from a
    // person who does not exist) returned on EVERY request, production
    // included — indistinguishable from real platform activity and impossible
    // to act on. The real feed is `/api/notifications`, DB-backed and
    // tenant-scoped; `useNotifications` reads it and now shows an honest empty
    // state until something actually happens.
    notifications: [],
  }
}

