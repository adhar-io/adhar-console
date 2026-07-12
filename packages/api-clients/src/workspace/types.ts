import { z } from 'zod'

export const PlanTierSchema = z.enum(['free', 'team', 'business', 'enterprise'])
export type PlanTier = z.infer<typeof PlanTierSchema>

export const OrgRoleSchema = z.enum(['owner', 'admin', 'member', 'billing', 'viewer'])
export type OrgRole = z.infer<typeof OrgRoleSchema>

export const OrganizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  region: z.string(),
  plan: PlanTierSchema,
  createdAt: z.string(),
  defaultProjectId: z.string().optional(),
  ssoEnforced: z.boolean(),
  domain: z.string().optional(),
})
export type Organization = z.infer<typeof OrganizationSchema>

export const MemberSchema = z.object({
  userId: z.string(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().url().optional(),
  role: OrgRoleSchema,
  teams: z.array(z.string()),
  joinedAt: z.string(),
  lastActiveAt: z.string().optional(),
  ssoProvider: z.string().optional(),
})
export type Member = z.infer<typeof MemberSchema>

export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: OrgRoleSchema,
  invitedBy: z.string(),
  invitedAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']),
})
export type Invitation = z.infer<typeof InvitationSchema>

export const TeamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  memberCount: z.number(),
  projectCount: z.number(),
  createdAt: z.string(),
})
export type Team = z.infer<typeof TeamSchema>

export const ProjectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tenantId: z.string(),
  teams: z.array(z.string()),
  primaryRepo: z.string().optional(),
  giteaOrg: z.string(),
  argoProject: z.string(),
  harborProject: z.string(),
  planeProject: z.string().optional(),
  environments: z.array(z.string()),
  createdAt: z.string(),
})
export type Project = z.infer<typeof ProjectSchema>

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['dev', 'staging', 'preview', 'prod']),
  clusterRef: z.string(),
  namespace: z.string(),
  promoteFromEnvId: z.string().optional(),
  protectionRules: z.object({
    requireApproval: z.boolean(),
    approvers: z.array(z.string()),
    windowsCron: z.string().optional(),
  }),
  createdAt: z.string(),
})
export type Environment = z.infer<typeof EnvironmentSchema>

export const IntegrationSchema = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.enum(['connected', 'degraded', 'disconnected', 'pending']),
  url: z.string().url(),
  connectedAt: z.string(),
  mode: z.enum(['in-cluster', 'external']),
  version: z.string().optional(),
})
export type Integration = z.infer<typeof IntegrationSchema>

export const ApiTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  ownerType: z.enum(['user', 'org']),
  ownerId: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
})
export type ApiToken = z.infer<typeof ApiTokenSchema>

export const AuditEventSchema = z.object({
  id: z.string(),
  actor: z.object({ type: z.enum(['user', 'token', 'system']), id: z.string(), label: z.string() }),
  action: z.string(),
  target: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  outcome: z.enum(['success', 'failure']),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  at: z.string(),
})
export type AuditEvent = z.infer<typeof AuditEventSchema>

export const PlanSchema = z.object({
  tier: PlanTierSchema,
  seats: z.number(),
  seatsUsed: z.number(),
  priceMonthly: z.number(),
  currency: z.string(),
  renewsAt: z.string(),
  paymentMethod: z.string().optional(),
  limits: z.object({
    projects: z.number(),
    environments: z.number(),
    clusters: z.number(),
    storageGb: z.number(),
  }),
})
export type Plan = z.infer<typeof PlanSchema>

export const UsageSchema = z.object({
  period: z.string(),
  metrics: z.object({
    projects: z.number(),
    environments: z.number(),
    activeUsers: z.number(),
    deployments: z.number(),
    apiCalls: z.number(),
    logBytesIngested: z.number(),
    storageUsedGb: z.number(),
  }),
  quotas: z.object({
    projects: z.number(),
    environments: z.number(),
    activeUsers: z.number(),
    deployments: z.number(),
    apiCalls: z.number(),
    logBytesIngested: z.number(),
    storageUsedGb: z.number(),
  }),
})
export type Usage = z.infer<typeof UsageSchema>

export const WebhookSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  events: z.array(z.string()),
  active: z.boolean(),
  secretSet: z.boolean(),
  lastDeliveryAt: z.string().optional(),
  lastDeliveryStatus: z.enum(['success', 'failure']).optional(),
})
export type Webhook = z.infer<typeof WebhookSchema>

export interface CreateOrgInput {
  slug: string
  name: string
  region: string
  plan: PlanTier
}

export interface InviteMemberInput {
  email: string
  role: OrgRole
  teams?: string[]
}

export interface CreateProjectInput {
  slug: string
  name: string
  teams: string[]
  environments: string[]
}
