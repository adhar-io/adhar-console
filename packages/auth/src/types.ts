import { z } from 'zod'

// Console RBAC roles, ordered high → low privilege. `super-admin` (the Keycloak
// `admin`/`super-admin` group) and `platform-admin` are unrestricted; the rest
// are scoped. `tenant-admin` is kept as a backward-compatible alias of
// `application-admin` (older sessions / annotations may still carry it).
export const RoleSchema = z.enum([
  'super-admin',
  'platform-admin',
  'platform-engineer',
  'application-admin',
  'tenant-admin',
  'developer',
  'viewer',
])
export type Role = z.infer<typeof RoleSchema>

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().url().optional(),
  roles: z.array(RoleSchema),
  // Raw Keycloak group memberships (path-stripped, e.g. `platform-admin`). The
  // console persona is resolved from these + `roles`. Defaulted so sessions
  // minted before this field existed still validate.
  groups: z.array(z.string()).default([]),
  tenants: z.array(z.string()),
})
export type User = z.infer<typeof UserSchema>

export const ClaimsSchema = z.object({
  sub: z.string(),
  email: z.string(),
  name: z.string(),
  preferred_username: z.string().optional(),
  realm_access: z.object({ roles: z.array(z.string()) }).optional(),
  resource_access: z.record(z.object({ roles: z.array(z.string()) })).optional(),
  // Keycloak group-membership mapper (`claim.name: groups`, `full.path: false`).
  // This is how Adhar assigns RBAC personas (e.g. the `platform-admin` group).
  groups: z.array(z.string()).optional(),
  tenants: z.array(z.string()).optional(),
  exp: z.number(),
  iat: z.number(),
})
export type Claims = z.infer<typeof ClaimsSchema>

export const SessionSchema = z.object({
  user: UserSchema,
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
  activeTenant: z.string(),
})
export type Session = z.infer<typeof SessionSchema>
