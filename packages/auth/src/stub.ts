import type { Session, User } from './types.ts'

export const STUB_USER: User = {
  id: 'stub-user-1',
  email: 'tapas.friends@gmail.com',
  name: 'Tapas Jena',
  roles: ['platform-admin', 'developer'],
  groups: ['platform-admin'],
  tenants: ['acme', 'globex'],
}

export const STUB_SESSION: Session = {
  user: STUB_USER,
  accessToken: 'stub.access.token',
  refreshToken: 'stub.refresh.token',
  expiresAt: Date.now() + 60 * 60 * 1000,
  activeTenant: 'acme',
}

/**
 * Dev-only fallback session, used by the login page's "Continue as demo user"
 * button when no server-side Keycloak is configured (pure SPA dev). Returns a
 * fresh copy each call so its `expiresAt` is always in the future.
 */
export function getStubSession(): Session {
  return { ...STUB_SESSION, expiresAt: Date.now() + 60 * 60 * 1000 }
}
