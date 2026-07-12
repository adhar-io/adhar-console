import { useSyncExternalStore } from 'react'

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
 * In dev a "view-as" override is persisted to localStorage so the same logged
 * in user can preview each role's UX without re-authenticating. This is
 * deliberate — every gate uses the same hook, so the previewer mirrors the
 * production experience exactly.
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

export const K8S_ROLE_DESCRIPTION: Record<K8sRole, string> = {
  'platform-admin':
    'Full cluster control — read, write, exec, delete every resource including cluster RBAC and Secrets.',
  'tenant-admin':
    'Manages workloads in their tenants. Can edit YAML, exec into pods, scale and delete workloads.',
  'developer':
    'Read pods and logs, exec into pods, scale own deployments. No destructive ops in shared envs.',
  viewer:
    'Read-only — no log streaming, no exec, no edits.',
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
}

/* ─────────── current roles + view-as override ─────────── */

/**
 * In v1 the current user's K8s roles are seeded from the auth stub. Once the
 * SPA wires up `<SessionContext.Provider>` end-to-end, swap this for a
 * `useUser()` call from `@adhar-console/auth/client`.
 */
const STUB_ROLES: K8sRole[] = ['platform-admin']

const VIEW_AS_KEY = 'adhar.k8s.view-as'

const listeners = new Set<() => void>()
function notify() {
  for (const l of Array.from(listeners)) l()
}

function readOverride(): K8sRole | null {
  if (typeof localStorage === 'undefined') return null
  const v = localStorage.getItem(VIEW_AS_KEY)
  if (v && (ALL_K8S_ROLES as string[]).includes(v)) return v as K8sRole
  return null
}

export function setViewAsRole(role: K8sRole | null): void {
  if (typeof localStorage === 'undefined') return
  if (role) localStorage.setItem(VIEW_AS_KEY, role)
  else localStorage.removeItem(VIEW_AS_KEY)
  notify()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === VIEW_AS_KEY) cb()
  }
  if (typeof globalThis !== 'undefined' && 'addEventListener' in globalThis) {
    globalThis.addEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(cb)
    if (typeof globalThis !== 'undefined' && 'removeEventListener' in globalThis) {
      globalThis.removeEventListener('storage', onStorage)
    }
  }
}
function getSnapshot(): K8sRole | null {
  return readOverride()
}
function getServerSnapshot(): K8sRole | null {
  return null
}

export function useViewAsRole(): K8sRole | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function useK8sCurrentRoles(): K8sRole[] {
  const override = useViewAsRole()
  if (override) return [override]
  return STUB_ROLES
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
