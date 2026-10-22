import type { workspace } from '@adhar/api-clients'

/**
 * Organisation roles, their labels, and the segregation-of-duty matrix shown
 * on Roles & permissions. Informational only: what a user may actually DO is
 * decided by Kubernetes RBAC (CONSOLE_PERMISSIONS, docs/rbac.md), asked per
 * action through components/role-gate.tsx / useCan.
 *
 * Standard org roles (`workspace.OrgRole`) are extended here with a few
 * enterprise-only roles surfaced in the role matrix:
 *
 *   - `owner`     — full control. Can transfer ownership / delete the org.
 *   - `admin`     — manages members, projects, integrations, security
 *                   settings (no billing).
 *   - `security`  — manages SSO, MFA, IP allowlist, audit, compliance,
 *                   approvals. Read-only on billing.
 *   - `billing`   — manages plan, payment methods, invoices, budgets,
 *                   cost centers. Read-only on the rest.
 *   - `finance`   — alias of billing focused on cost allocation review.
 *   - `member`    — day-to-day developer; read-most, edit projects and
 *                   their environments.
 *   - `viewer`    — read-only.
 *
 * Segregation of duty: the platform model deliberately separates billing
 * (`billing` / `finance`) from security (`security`) from execution
 * (`admin` / `member`). One person SHOULD NOT be able to change cluster
 * security policy AND approve their own purchase order.
 */

export type Role =
  | 'owner'
  | 'admin'
  | 'security'
  | 'billing'
  | 'finance'
  | 'member'
  | 'viewer'

export const ALL_ROLES: Role[] = ['owner', 'admin', 'security', 'billing', 'finance', 'member', 'viewer']

export type Permission =
  /* Org */
  | 'org.read'
  | 'org.write'
  | 'org.transfer'
  | 'org.delete'
  /* Members */
  | 'members.read'
  | 'members.invite'
  | 'members.remove'
  | 'members.update_role'
  /* Roles & teams */
  | 'roles.read'
  | 'roles.write'
  | 'teams.read'
  | 'teams.write'
  /* Identity & Access */
  | 'sso.read'
  | 'sso.write'
  | 'scim.read'
  | 'scim.write'
  | 'mfa.read'
  | 'mfa.enforce'
  | 'session.read'
  | 'session.write'
  | 'ipallow.read'
  | 'ipallow.write'
  /* Security & compliance */
  | 'security.read'
  | 'security.write'
  | 'audit.read'
  | 'audit.export'
  | 'compliance.read'
  | 'compliance.write'
  | 'approvals.read'
  | 'approvals.write'
  /* Workloads */
  | 'projects.read'
  | 'projects.write'
  | 'environments.read'
  | 'environments.write'
  /* Connectivity */
  | 'integrations.read'
  | 'integrations.write'
  | 'tokens.read'
  | 'tokens.write'
  | 'webhooks.read'
  | 'webhooks.write'
  /* Billing */
  | 'billing.read'
  | 'billing.write'
  | 'invoices.read'
  | 'payments.read'
  | 'payments.write'
  | 'budgets.read'
  | 'budgets.write'
  | 'costcenters.read'
  | 'costcenters.write'
  | 'allocation.read'

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  security: 'Security',
  billing: 'Billing',
  finance: 'Finance',
  member: 'Member',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Full control. Transfer or delete the organization.',
  admin: 'Manages people, projects, integrations. No billing access.',
  security: 'Manages SSO, MFA, IP allowlist, audit, compliance, approvals.',
  billing: 'Manages plan, payments, invoices, budgets, cost centers.',
  finance: 'Reviews cost allocation and approves budget changes.',
  member: 'Day-to-day work — projects and environments.',
  viewer: 'Read-only across the workspace.',
}

export const ROLE_TONE: Record<Role, 'failed' | 'progressing' | 'info' | 'unknown' | 'paused' | 'healthy'> = {
  owner: 'failed',
  admin: 'progressing',
  security: 'paused',
  billing: 'info',
  finance: 'info',
  member: 'healthy',
  viewer: 'unknown',
}

const ALL_PERMS: Permission[] = [
  'org.read', 'org.write', 'org.transfer', 'org.delete',
  'members.read', 'members.invite', 'members.remove', 'members.update_role',
  'roles.read', 'roles.write', 'teams.read', 'teams.write',
  'sso.read', 'sso.write', 'scim.read', 'scim.write', 'mfa.read', 'mfa.enforce',
  'session.read', 'session.write', 'ipallow.read', 'ipallow.write',
  'security.read', 'security.write', 'audit.read', 'audit.export',
  'compliance.read', 'compliance.write', 'approvals.read', 'approvals.write',
  'projects.read', 'projects.write', 'environments.read', 'environments.write',
  'integrations.read', 'integrations.write', 'tokens.read', 'tokens.write',
  'webhooks.read', 'webhooks.write',
  'billing.read', 'billing.write', 'invoices.read',
  'payments.read', 'payments.write', 'budgets.read', 'budgets.write',
  'costcenters.read', 'costcenters.write', 'allocation.read',
]

const READ_ONLY = ALL_PERMS.filter((p) => p.endsWith('.read'))

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMS,
  admin: [
    'org.read', 'org.write',
    'members.read', 'members.invite', 'members.remove', 'members.update_role',
    'roles.read', 'teams.read', 'teams.write',
    'sso.read', 'scim.read', 'mfa.read', 'session.read', 'ipallow.read',
    'security.read', 'audit.read', 'compliance.read', 'approvals.read',
    'projects.read', 'projects.write', 'environments.read', 'environments.write',
    'integrations.read', 'integrations.write', 'tokens.read', 'tokens.write',
    'webhooks.read', 'webhooks.write',
    'billing.read', 'invoices.read', 'budgets.read', 'costcenters.read', 'allocation.read',
  ],
  security: [
    ...READ_ONLY,
    'sso.write', 'scim.write', 'mfa.enforce', 'session.write', 'ipallow.write',
    'security.write', 'audit.export', 'compliance.write', 'approvals.write',
  ],
  billing: [
    ...READ_ONLY,
    'billing.write', 'payments.write', 'budgets.write', 'costcenters.write',
  ],
  finance: [
    ...READ_ONLY,
    'budgets.write', 'costcenters.write',
  ],
  member: [
    'org.read',
    'members.read', 'roles.read', 'teams.read',
    'projects.read', 'projects.write', 'environments.read', 'environments.write',
    'integrations.read', 'tokens.read', 'webhooks.read',
    'billing.read', 'budgets.read', 'allocation.read',
    'audit.read',
  ],
  viewer: READ_ONLY,
}

/* ─────────── helpers / re-exports ─────────── */

export type WorkspaceOrgRole = workspace.OrgRole
export const ORG_ROLE_LABEL: Record<workspace.OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  billing: 'Billing',
  member: 'Member',
  viewer: 'Viewer',
}
