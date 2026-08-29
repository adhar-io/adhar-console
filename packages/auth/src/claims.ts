import { type Claims, type Role, type User } from './types.ts'

/**
 * Keycloak realm-role / client-role / group-name → console {@link Role}.
 *
 * Roles reach the console from three places, and in Adhar the *group* is the
 * usual one: a user placed in the `/platform-admin` group has Keycloak emit a
 * `groups: ["platform-admin"]` claim (the realm's group-membership mapper,
 * `full.path=false`) — they typically have NO matching realm role. Earlier this
 * mapper only accepted a handful of exact realm-role strings and dropped
 * everything else, so a group-only admin collapsed to `viewer`. We now
 * normalize (lowercase, strip any `/group/path`) and map all three sources
 * through this alias table.
 */
const ROLE_ALIASES: Record<string, Role> = {
  // Super admin — the top-level `admin` / `super-admin` Keycloak group.
  admin: 'super-admin',
  'super-admin': 'super-admin',
  superadmin: 'super-admin',
  // Platform admin.
  'platform-admin': 'platform-admin',
  'platform-admins': 'platform-admin',
  // Platform engineer.
  'platform-engineer': 'platform-engineer',
  'platform-engineers': 'platform-engineer',
  'platform-eng': 'platform-engineer',
  // Application / tenant admin.
  'application-admin': 'application-admin',
  'application-admins': 'application-admin',
  'app-admin': 'application-admin',
  'tenant-admin': 'application-admin',
  // Developer.
  developer: 'developer',
  developers: 'developer',
  'platform-developer': 'developer',
  // Viewer (also the base group + explicit least-privilege).
  viewer: 'viewer',
  viewers: 'viewer',
  'platform-viewer': 'viewer',
  'base-user': 'viewer',
}

/** Normalize a raw role/group token: trim, lowercase, strip Keycloak path. */
export function normalizeRoleToken(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/^\/+/, '')
  return t.split('/').pop() || t
}

function mapRoles(raw: string[]): Role[] {
  const out = new Set<Role>()
  for (const r of raw) {
    const mapped = ROLE_ALIASES[normalizeRoleToken(r)]
    if (mapped) out.add(mapped)
  }
  return out.size ? [...out] : ['viewer']
}

/**
 * Map verified Keycloak ID-token claims → the app's `User`.
 *
 * Roles are collected from `realm_access.roles` (realm roles), the console
 * client's `resource_access` entry (client roles), AND the `groups` claim
 * (group memberships) — then aliased to the console's role set. Group names are
 * also preserved verbatim on `user.groups` so the shell can resolve a persona
 * from them directly. Tenants come from a custom `tenants` claim.
 *
 * Pure + dependency-free so it is safe to import from the browser bundle.
 */
export function claimsToUser(claims: Claims, clientId?: string): User {
  const realmRoles = claims.realm_access?.roles ?? []
  const clientRoles = (clientId && claims.resource_access?.[clientId]?.roles) || []
  const groups = (claims.groups ?? []).map(normalizeRoleToken).filter(Boolean)
  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    roles: mapRoles([...realmRoles, ...clientRoles, ...groups]),
    groups,
    tenants: claims.tenants ?? [],
  }
}
