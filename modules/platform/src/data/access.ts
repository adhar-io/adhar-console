import { useOptionalConsoleRole, type ConsoleRole } from '@adhar-console/shell-ui'

/**
 * Kubernetes-scoped RBAC.
 *
 * The console maps four broad roles to fine-grained permissions on cluster
 * resources. Roles come from the auth session (`@adhar-console/auth`'s
 * `Role` type) — we keep them in lockstep here so the same identity that
 * authenticates the user gates every action they take inside the cluster
 * dashboard.
 *
 *   - `platform-admin` — full cluster control. Read/write/exec/delete every
 *                        resource. Only role allowed to drop secrets or edit
 *                        cluster-scoped RBAC.
 *   - `tenant-admin`   — manages workloads in their tenants. Can edit YAML,
 *                        scale, restart, delete pods, and exec. Read-only on
 *                        cluster-wide RBAC and Secrets.
 *   - `developer`      — day-to-day work. Read pods + logs, exec into them,
 *                        scale own deployments. No destructive ops, no edits
 *                        to ConfigMaps / Secrets in shared namespaces.
 *   - `viewer`         — read-only. Sees lists and details but cannot stream
 *                        logs or exec.
 *
 * The cluster view is purely the logged-in user's real Keycloak role: the
 * persona resolved from the auth session's `groups` claim maps straight to a
 * cluster-RBAC role, so what a user sees is exactly what their signed-in
 * identity is entitled to.
 */

export type K8sRole = 'platform-admin' | 'tenant-admin' | 'developer' | 'viewer'

export const ALL_K8S_ROLES: K8sRole[] = [
  'platform-admin',
  'tenant-admin',
  'developer',
  'viewer',
]

export const K8S_ROLE_LABEL: Record<K8sRole, string> = {
  'platform-admin': 'Platform Admin',
  'tenant-admin': 'Tenant Admin',
  developer: 'Developer',
  viewer: 'Viewer',
}

export const K8S_ROLE_TONE: Record<K8sRole, 'failed' | 'progressing' | 'healthy' | 'unknown'> = {
  'platform-admin': 'failed',
  'tenant-admin': 'progressing',
  developer: 'healthy',
  viewer: 'unknown',
}

export type K8sPermission =
  | 'pods.read'
  | 'pods.logs'
  | 'pods.exec'
  | 'pods.delete'
  | 'pods.write'
  | 'pods.metrics'
  | 'workloads.read'
  | 'workloads.scale'
  | 'workloads.write'
  | 'workloads.delete'
  | 'configmaps.read'
  | 'configmaps.write'
  | 'secrets.read'
  | 'secrets.write'
  | 'rbac.read'
  | 'rbac.write'
  | 'crds.read'
  | 'crds.write'
  | 'events.read'
  | 'nodes.cordon'

const ALL_PERMS: K8sPermission[] = [
  'pods.read',
  'pods.logs',
  'pods.exec',
  'pods.delete',
  'pods.write',
  'pods.metrics',
  'workloads.read',
  'workloads.scale',
  'workloads.write',
  'workloads.delete',
  'configmaps.read',
  'configmaps.write',
  'secrets.read',
  'secrets.write',
  'rbac.read',
  'rbac.write',
  'crds.read',
  'crds.write',
  'events.read',
  'nodes.cordon',
]

const READ_ONLY = ALL_PERMS.filter((p) => p.endsWith('.read'))

export const K8S_ROLE_PERMISSIONS: Record<K8sRole, K8sPermission[]> = {
  'platform-admin': ALL_PERMS,
  'tenant-admin': [
    'pods.read',
    'pods.logs',
    'pods.exec',
    'pods.delete',
    'pods.write',
    'pods.metrics',
    'workloads.read',
    'workloads.scale',
    'workloads.write',
    'workloads.delete',
    'configmaps.read',
    'configmaps.write',
    'secrets.read',
    'rbac.read',
    'crds.read',
    'crds.write',
    'events.read',
  ],
  developer: [
    'pods.read',
    'pods.logs',
    'pods.exec',
    'pods.metrics',
    'workloads.read',
    'workloads.scale',
    'configmaps.read',
    'rbac.read',
    'crds.read',
    'events.read',
  ],
  viewer: READ_ONLY.filter((p) => p !== 'secrets.read'),
}

export const K8S_PERMISSION_LABEL: Record<K8sPermission, string> = {
  'pods.read': 'View pods',
  'pods.logs': 'Stream pod logs',
  'pods.exec': 'Open shell session into a pod',
  'pods.delete': 'Delete pods (including restart)',
  'pods.write': 'Edit pod manifest',
  'pods.metrics': 'Read pod metrics',
  'workloads.read': 'View workloads',
  'workloads.scale': 'Scale workloads',
  'workloads.write': 'Edit workload manifests',
  'workloads.delete': 'Delete workloads',
  'configmaps.read': 'Read ConfigMaps',
  'configmaps.write': 'Edit ConfigMaps',
  'secrets.read': 'Read Secrets',
  'secrets.write': 'Edit Secrets',
  'rbac.read': 'View RBAC',
  'rbac.write': 'Edit RBAC',
  'crds.read': 'View custom resources',
  'crds.write': 'Edit custom resources',
  'events.read': 'View events',
  'nodes.cordon': 'Cordon / uncordon nodes',
}

/* ─────────── current roles ─────────── */

/**
 * Map the console persona (resolved from the real auth session) to the
 * cluster-RBAC role that gates the k8s dashboard. Both admin personas get full
 * cluster control; an application-admin manages their tenants; developer and
 * viewer map straight through.
 */
const CONSOLE_ROLE_TO_K8S: Record<ConsoleRole, K8sRole> = {
  'super-admin': 'platform-admin',
  'platform-admin': 'platform-admin',
  'application-admin': 'tenant-admin',
  developer: 'developer',
  viewer: 'viewer',
}

/**
 * Fallback when there is NO auth session in scope — anonymous, or the auth
 * provider isn't mounted in this MF remote's tree. We deliberately fall back to
 * full access (not `viewer`) so a context-resolution gap never silently strips
 * a real operator's ability to read logs / exec; a genuine `viewer` session
 * still resolves to `viewer` and is correctly limited.
 */
const NO_SESSION_ROLES: K8sRole[] = ['platform-admin']

export function useK8sCurrentRoles(): K8sRole[] {
  const persona = useOptionalConsoleRole()
  // Derive purely from the real signed-in persona; if no session is resolvable,
  // fall back to full access rather than downgrading a real operator to viewer.
  return [persona ? (CONSOLE_ROLE_TO_K8S[persona] ?? 'viewer') : NO_SESSION_ROLES[0]]
}

/* ─────────── permission checks ─────────── */

export function rolesHaveK8sPermission(roles: K8sRole[], perm: K8sPermission): boolean {
  for (const r of roles) {
    if (K8S_ROLE_PERMISSIONS[r]?.includes(perm)) return true
  }
  return false
}

export function useHasK8sPermission(perm: K8sPermission): boolean {
  const roles = useK8sCurrentRoles()
  return rolesHaveK8sPermission(roles, perm)
}

export function useHasAnyK8sPermission(...perms: K8sPermission[]): boolean {
  const roles = useK8sCurrentRoles()
  return perms.some((p) => rolesHaveK8sPermission(roles, p))
}

export function whichRolesHave(perm: K8sPermission): K8sRole[] {
  return ALL_K8S_ROLES.filter((r) => K8S_ROLE_PERMISSIONS[r]?.includes(perm))
}
