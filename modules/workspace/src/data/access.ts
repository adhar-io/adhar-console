import {
  CONSOLE_PERMISSIONS,
  type ConsolePermissionName,
  ORG_SCOPED_PERMISSIONS,
  type OrgScopedRole,
} from '@adhar/shell-ui'

/**
 * An organisation's roles, as Settings → Roles & permissions shows them.
 *
 * There are exactly two, and both are Keycloak groups — the console stores no
 * roles of its own:
 *
 *   member   `org-<slug>`
 *   admin    `org-<slug>-admin` (every admin is in both)
 *
 * Two kinds of people hold a role without being listed in either group: the
 * platform admin groups (`platform-admin`, `platform-engineer`, `super-admin`)
 * are admins of EVERY organisation, and the platform team
 * (`platform-developer`, `platform-viewer`) are members of the platform's own
 * organisation.
 *
 * What a role may do in its organisation is decided by the console from those
 * groups — `ORG_SCOPED_PERMISSIONS`, the same list the server enforces
 * (apps/console/app/server/tenancy/org-access.ts). Kubernetes RBAC answers the
 * console's other permissions (platform packages, scan waivers, …), and is not
 * asked about these.
 */

export type Role = OrgScopedRole

/**
 * A permission key inside a custom role saved before roles came from Keycloak
 * (`workspace.role` documents). Those documents grant nothing now and no page
 * offers them; the type stays so they can still be read.
 */
export type Permission = string

export const ALL_ROLES: Role[] = ['member', 'admin']

export const ROLE_LABEL: Record<Role, string> = {
  member: 'Member',
  admin: 'Admin',
}

export const ROLE_GROUP: Record<Role, (slug: string) => string> = {
  member: (slug) => `org-${slug}`,
  admin: (slug) => `org-${slug}-admin`,
}

export const ROLE_DESCRIPTION: Record<Role, string> = {
  member: 'Works in the organization: reads its settings, members, teams, projects, approvals, audit trail and billing.',
  admin: 'Everything a member can, plus who is in the organization, its teams, projects, tokens, approvals, billing and settings.',
}

export const ROLE_TONE: Record<Role, 'progressing' | 'info'> = {
  admin: 'progressing',
  member: 'info',
}

/**
 * A role name from anywhere — including documents saved before roles came
 * from Keycloak (`owner`, `billing`, …) — as a label. The retired roles had
 * no successor but admin or member, so they say which.
 */
export function roleLabel(role: string): string {
  if (role === 'admin' || role === 'member') return ROLE_LABEL[role]
  if (role === 'owner') return 'Admin (was Owner)'
  return `${role} (retired)`
}

/** One row of the permission table: an organisation-scoped permission and who holds it. */
export interface OrgPermissionRow {
  name: ConsolePermissionName
  description: string
  /** The least role that holds it. */
  role: Role
}

/** Permissions that are no longer offered anywhere (custom roles are gone). */
const RETIRED: ReadonlySet<ConsolePermissionName> = new Set(['rolesCreate', 'rolesUpdate', 'rolesDelete'])

/** The organisation-scoped permissions, members' first, as the server decides them. */
export const ORG_PERMISSION_ROWS: OrgPermissionRow[] = ORG_SCOPED_PERMISSIONS
  .filter(([name]) => !RETIRED.has(name))
  .map(([name, role]) => ({ name, description: CONSOLE_PERMISSIONS[name].description, role }))
  .sort((a, b) => (a.role === b.role ? 0 : a.role === 'member' ? -1 : 1))

/** Groups that hold a role in every organisation (or the platform's) without being listed. */
export const IMPLICIT_ROLE_GROUPS: Array<{ group: string; role: Role; where: string }> = [
  { group: 'platform-admin', role: 'admin', where: 'every organization' },
  { group: 'platform-engineer', role: 'admin', where: 'every organization' },
  { group: 'super-admin', role: 'admin', where: 'every organization' },
  { group: 'platform-developer', role: 'member', where: "the platform's own organization" },
  { group: 'platform-viewer', role: 'member', where: "the platform's own organization" },
]
