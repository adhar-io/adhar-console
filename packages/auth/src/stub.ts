import type { Session, User } from './types.ts'

/**
 * The placeholder identity a page renders with while the session resolves.
 *
 * NOT a persona. This used to be a fully-formed fake person — a real name and
 * a real email address — used as `useOptionalSession()?.user ?? STUB_USER` on
 * twelve routes, so a signed-out or still-loading console showed someone's
 * actual identity in the account menu as though they were signed in. The root
 * route redirects an unauthenticated visitor to /login anyway, so the fallback
 * only ever paints for a frame; it should say "we do not know yet", and this
 * does.
 */
export const PENDING_USER: User = {
  id: '',
  email: '',
  name: 'Signing in…',
  roles: ['viewer'],
  groups: [],
  tenants: [],
}

/**
 * The identity behind "Continue as demo user" on the login page, which appears
 * only when no Keycloak is configured (a laptop running the console with no
 * platform behind it). Deliberately anonymous: an explicit demo session should
 * look like one, not like a named colleague.
 */
export const DEMO_USER: User = {
  id: 'demo',
  email: 'demo@localhost',
  name: 'Demo User',
  roles: ['platform-admin'],
  groups: ['platform-admin'],
  tenants: ['default'],
}

/** Fresh each call so `expiresAt` is always in the future. */
export function getDemoSession(): Session {
  return {
    user: DEMO_USER,
    accessToken: '',
    refreshToken: '',
    expiresAt: Date.now() + 60 * 60 * 1000,
    activeTenant: 'default',
  }
}
