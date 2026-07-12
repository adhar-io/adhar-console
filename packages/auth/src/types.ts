import { z } from 'zod'

export const RoleSchema = z.enum([
  'platform-admin',
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
