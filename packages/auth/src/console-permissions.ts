/**
 * Console permissions as Kubernetes RBAC — the catalogue of VIRTUAL resources.
 *
 * Authorization in the console is Kubernetes RBAC, evaluated for the signed-in
 * user with a SelfSubjectAccessReview. Kubernetes objects need nothing extra:
 * "may I delete this Deployment" is asked about the Deployment. Console-level
 * actions — switching a platform package on, changing billing, approving a scan
 * waiver — are not Kubernetes objects, so they are named here as resources in
 * the API group `console.adhar.io`.
 *
 * No CRD backs them, and none is needed: the RBAC authorizer matches rules by
 * string, so a ClusterRole rule `{apiGroups: [console.adhar.io], resources:
 * [billing], verbs: [update]}` is honoured by an SSAR for exactly that triple
 * whether or not the API exists. Operators grant console actions with the same
 * ClusterRoles/RoleBindings they already use for everything else, and
 * `kubectl auth can-i update billing.console.adhar.io --as …` answers the same
 * question the console asks.
 *
 * This module is the single source of the names: the BFF authorizes with it,
 * shell-ui's `<Can>` checks with it, and the platform's ClusterRoles grant it
 * (docs/rbac.md). Pure data, no dependencies — server and browser both import it.
 */

/** The API group every console virtual resource lives in. */
export const CONSOLE_API_GROUP = 'console.adhar.io'

/**
 * One authorization question — the `resourceAttributes` of a
 * SelfSubjectAccessReview. `group` '' (or absent) is the core API group.
 */
export interface AccessCheck {
  verb: string
  group?: string
  resource: string
  subresource?: string
  namespace?: string
  name?: string
}

/** A catalogue entry: an `AccessCheck` in `console.adhar.io` plus what it allows. */
export interface ConsolePermission extends AccessCheck {
  group: typeof CONSOLE_API_GROUP
  /** What holding this permission lets someone do — shown in docs and denials. */
  description: string
}

const p = (resource: string, verb: string, description: string): ConsolePermission =>
  Object.freeze({ group: CONSOLE_API_GROUP, resource, verb, description })

/**
 * Every console-level permission. Modules reference these by name — never by
 * re-typing the strings — so a rename is a compile error, not a silently
 * hidden button.
 *
 * Checks are cluster-scoped unless a caller adds a `namespace` (see
 * `consoleCheck`): `resilienceRun` is asked in the target app's namespace, so a
 * team that is `admin` of its own namespace may run suites there.
 */
export const CONSOLE_PERMISSIONS = Object.freeze({
  // Platform packages (Marketplace): enable/disable commits to the platform's
  // ApplicationSet and Argo CD installs or REMOVES the package cluster-wide.
  packagesToggle: p('packages', 'update', 'Enable or disable platform packages; also commit scorecard fixes to platform repositories.'),

  // Billing for the organisation.
  billingView: p('billing', 'get', 'See plan, usage, invoices, budgets and payment methods.'),
  billingManage: p('billing', 'update', 'Change plan or seats, budgets, cost centres, payment methods; generate and pay invoices.'),

  // Workspace administration (Workspace settings).
  membersInvite: p('workspace-members', 'create', 'Invite people to the organisation.'),
  membersUpdate: p('workspace-members', 'update', 'Change a member\'s organisation role.'),
  membersRemove: p('workspace-members', 'delete', 'Remove members and revoke pending invitations.'),
  rolesCreate: p('workspace-roles', 'create', 'Create custom workspace roles.'),
  rolesUpdate: p('workspace-roles', 'update', 'Edit custom workspace roles.'),
  rolesDelete: p('workspace-roles', 'delete', 'Delete custom workspace roles.'),
  teamsCreate: p('workspace-teams', 'create', 'Create teams.'),
  teamsUpdate: p('workspace-teams', 'update', 'Rename teams and add or remove team members.'),
  teamsDelete: p('workspace-teams', 'delete', 'Delete teams.'),
  projectsCreate: p('workspace-projects', 'create', 'Create workspace projects.'),
  projectsUpdate: p('workspace-projects', 'update', 'Edit workspace projects.'),
  projectsDelete: p('workspace-projects', 'delete', 'Delete workspace projects.'),
  tokensCreate: p('workspace-tokens', 'create', 'Issue organisation API tokens.'),
  tokensRevoke: p('workspace-tokens', 'delete', 'Revoke organisation API tokens.'),
  approvalsDecide: p('workspace-approvals', 'approve', 'Approve or reject workspace approval requests.'),

  // Organisations (tenant switcher / onboarding).
  orgCreate: p('organizations', 'create', 'Create (and provision) an organisation.'),
  orgUpdate: p('organizations', 'update', 'Rename an organisation, edit its settings, transfer ownership.'),
  orgDelete: p('organizations', 'delete', 'Delete an organisation.'),

  auditView: p('audit', 'get', 'Read the workspace audit trail.'),

  // Scorecards: re-evaluate and apply fixes (the fix is still held to the
  // entity's owning team — see scorecard-fix-model.ts).
  scorecardsRun: p('scorecards', 'update', 'Re-run scorecard evaluation and apply scorecard fixes.'),

  resilienceRun: p('resilience-runs', 'create', 'Start a resilience (load + chaos) suite.'),

  // Supply-chain scan governance.
  waiverRequest: p('scan-waivers', 'create', 'Request (and extend) scan-finding waivers.'),
  waiverApprove: p('scan-waivers', 'approve', 'Approve, reject or revoke waivers, decide paused scan gates, re-sync waivers.'),
  waiverSelfApprove: p('scan-waivers', 'self-approve', 'Approve a waiver you requested yourself (break-glass).'),
  scanPolicyEdit: p('scan-policies', 'update', 'Change global and project scan policy.'),

  notificationsBroadcast: p('notifications-broadcast', 'create', 'Send a notification to every member of the organisation.'),

  aiKnowledgeAdd: p('ai-knowledge', 'create', 'Add notes, runbooks and incident write-ups to the Adhar AI knowledge base.'),
  aiKnowledgeRate: p('ai-knowledge', 'update', 'Rate answer grounding, which re-ranks knowledge chunks.'),

  // Applications: scaffolding commits a new repository with the console's
  // Gitea credentials; deleting can delete that repository with them.
  applicationsCreate: p('applications', 'create', 'Create applications from golden-path templates.'),
  applicationsDelete: p('applications', 'delete', 'Delete applications, including their source repository.'),
} as const)

export type ConsolePermissionName = keyof typeof CONSOLE_PERMISSIONS

/** Every virtual resource with the verbs the console asks about — for docs and tests. */
export function consoleResourceCatalogue(): Array<{ resource: string; verbs: string[] }> {
  const by = new Map<string, Set<string>>()
  for (const perm of Object.values(CONSOLE_PERMISSIONS)) {
    const verbs = by.get(perm.resource) ?? new Set<string>()
    verbs.add(perm.verb)
    by.set(perm.resource, verbs)
  }
  return [...by.entries()]
    .map(([resource, verbs]) => ({ resource, verbs: [...verbs].sort() }))
    .sort((a, b) => a.resource.localeCompare(b.resource))
}

/**
 * A catalogue permission as a plain `AccessCheck`, optionally narrowed to a
 * namespace. The description is dropped so the check is a stable cache key.
 */
export function consoleCheck(perm: ConsolePermission, namespace?: string): AccessCheck {
  return {
    verb: perm.verb,
    group: perm.group,
    resource: perm.resource,
    ...(namespace ? { namespace } : {}),
  }
}

/**
 * Canonical string for a check — the cache/dedupe key on both sides. Absent and
 * empty fields are the same question, so they serialise the same way.
 */
export function accessCheckKey(c: AccessCheck): string {
  return [c.verb, c.group ?? '', c.resource, c.subresource ?? '', c.namespace ?? '', c.name ?? ''].join('|')
}
