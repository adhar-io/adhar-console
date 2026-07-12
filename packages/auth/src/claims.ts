import { type Claims, type Role, type User } from './types.ts'

const KNOWN_ROLES: Role[] = ['platform-admin', 'tenant-admin', 'developer', 'viewer']

function mapRoles(raw: string[]): Role[] {
  const mapped = raw.filter((r): r is Role => (KNOWN_ROLES as string[]).includes(r))
  return mapped.length ? mapped : ['viewer']
}

/**
 * Map verified Keycloak ID-token claims → the app's `User`.
 *
 * Roles are read from both `realm_access.roles` (realm roles) and the
 * console client's entry in `resource_access` (client roles), then narrowed
 * to the four roles the console understands. Tenants come from a custom
 * `tenants` claim (mapped in Keycloak via a group/attribute mapper).
 *
 * Pure + dependency-free so it is safe to import from the browser bundle.
 */
export function claimsToUser(claims: Claims, clientId?: string): User {
  const realmRoles = claims.realm_access?.roles ?? []
  const clientRoles = (clientId && claims.resource_access?.[clientId]?.roles) || []
  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    roles: mapRoles([...realmRoles, ...clientRoles]),
    tenants: claims.tenants ?? [],
  }
}
