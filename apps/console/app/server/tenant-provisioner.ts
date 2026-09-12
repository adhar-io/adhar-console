import { env } from '@adhar-console/utils'
import { apiServerFetch } from './k8s/gateway.ts'
import { getK8sServiceToken, getTool } from './tool-registry.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { getKeycloakAdmin } from './workspace/keycloak-admin.ts'

/**
 * Tenant provisioner — turns a logical organization into a real, isolated tenant
 * across the platform's systems when the console has the credentials to do so:
 *
 *   • **Keycloak**   — an identity group `org-<slug>` (+ the creator added), so
 *                      cluster RBAC and app access can be granted by group.
 *   • **Kubernetes** — a namespace `<slug>` labelled for the tenant, plus a
 *                      RoleBinding granting the `org-<slug>` group the namespaced
 *                      `admin` ClusterRole inside it — the isolation boundary.
 *   • **ArgoCD**     — an AppProject `<slug>` whose destinations are restricted
 *                      to the tenant namespace, so GitOps can only deploy there.
 *   • **Gitea**      — an org `<slug>` to hold the tenant's repositories.
 *
 * Every step is **best-effort and independent**: the organization record is
 * already persisted before this runs and is never rolled back. Each step reports
 * `done` / `skipped` (credentials/URL absent) / `failed` (with a short detail),
 * so onboarding can show an honest per-system result instead of pretending.
 * Privileged calls use the console's own service-account token — not the
 * signed-in user's — because tenant creation is a platform operation.
 */

export interface ProvisionStepResult {
  system: 'keycloak' | 'namespace' | 'argocd' | 'gitea'
  label: string
  status: 'done' | 'skipped' | 'failed'
  detail?: string
}

export interface ProvisionInput {
  slug: string
  name: string
  /** Creating user — id (sub), email, or username, for group membership. */
  userRef?: string
}

/** Group name convention used for tenant RBAC (matches ws-* group bindings). */
export const groupForOrg = (slug: string) => `org-${slug}`

const ok = (status: number) => status >= 200 && status < 300

async function k8sApply(token: string, path: string, manifest: unknown): Promise<Response> {
  return apiServerFetch(token, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  })
}

/* ── Keycloak identity group ── */
async function provisionKeycloak(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `Keycloak group ${groupForOrg(input.slug)}`
  const kc = getKeycloakAdmin()
  if (!kc) return { system: 'keycloak', label, status: 'skipped', detail: 'Keycloak admin not configured' }
  try {
    const group = await kc.ensureGroup(groupForOrg(input.slug))
    if (!group) return { system: 'keycloak', label, status: 'failed', detail: 'could not create group' }
    if (input.userRef) await kc.addUserToGroup(input.userRef, groupForOrg(input.slug))
    return { system: 'keycloak', label, status: 'done', detail: 'group ready, creator added' }
  } catch (e) {
    return { system: 'keycloak', label, status: 'failed', detail: (e as Error).message }
  }
}

/* ── Kubernetes namespace + RBAC (the isolation boundary) ── */
async function provisionNamespace(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `Namespace ${input.slug} + RBAC`
  const token = getK8sServiceToken()
  if (!token) return { system: 'namespace', label, status: 'skipped', detail: 'no service-account token' }
  try {
    const nsRes = await k8sApply(token, '/api/v1/namespaces', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: input.slug,
        labels: {
          'adhar.io/tenant': input.slug,
          'adhar.io/org': input.slug,
          'app.kubernetes.io/managed-by': 'adhar-console',
        },
      },
    })
    if (!ok(nsRes.status) && nsRes.status !== 409) {
      return { system: 'namespace', label, status: 'failed', detail: `namespace ${nsRes.status}` }
    }
    const rbRes = await k8sApply(
      token,
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${input.slug}/rolebindings`,
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: 'adhar-tenant-admins', namespace: input.slug },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' },
        subjects: [
          { kind: 'Group', name: groupForOrg(input.slug), apiGroup: 'rbac.authorization.k8s.io' },
        ],
      },
    )
    if (!ok(rbRes.status) && rbRes.status !== 409) {
      return {
        system: 'namespace',
        label,
        status: 'failed',
        detail: `namespace ready, RoleBinding ${rbRes.status}`,
      }
    }
    return { system: 'namespace', label, status: 'done', detail: `namespace + admin binding for ${groupForOrg(input.slug)}` }
  } catch (e) {
    return { system: 'namespace', label, status: 'failed', detail: (e as Error).message }
  }
}

/* ── ArgoCD AppProject scoped to the tenant namespace ── */
async function provisionArgoProject(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `ArgoCD project ${input.slug}`
  const token = getK8sServiceToken()
  if (!token) return { system: 'argocd', label, status: 'skipped', detail: 'no service-account token' }
  const argocdNs = env('ARGOCD_NAMESPACE') ?? 'argocd'
  try {
    const res = await k8sApply(
      token,
      `/apis/argoproj.io/v1alpha1/namespaces/${argocdNs}/appprojects`,
      {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'AppProject',
        metadata: {
          name: input.slug,
          namespace: argocdNs,
          labels: { 'adhar.io/tenant': input.slug },
        },
        spec: {
          description: `Tenant ${input.name}`,
          sourceRepos: ['*'],
          destinations: [{ namespace: input.slug, server: 'https://kubernetes.default.svc' }],
          namespaceResourceWhitelist: [{ group: '*', kind: '*' }],
        },
      },
    )
    if (res.status === 404) {
      return { system: 'argocd', label, status: 'skipped', detail: `AppProject CRD not found in ${argocdNs} (set ARGOCD_NAMESPACE)` }
    }
    if (!ok(res.status) && res.status !== 409) {
      return { system: 'argocd', label, status: 'failed', detail: `appproject ${res.status}` }
    }
    return { system: 'argocd', label, status: 'done', detail: `deploys restricted to namespace ${input.slug}` }
  } catch (e) {
    return { system: 'argocd', label, status: 'failed', detail: (e as Error).message }
  }
}

/* ── Gitea org for the tenant's repositories ── */
async function provisionGitea(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `Gitea org ${input.slug}`
  const tool = getTool('gitea')
  const conn = giteaConn()
  if (!tool?.baseUrl || !conn) {
    return { system: 'gitea', label, status: 'skipped', detail: 'Gitea admin not configured' }
  }
  try {
    // `giteaConn()` already ends `base` at `/api/v1`, so paths here are
    // relative to it — passing `/api/v1/orgs` built `…/api/v1/api/v1/orgs`,
    // which Gitea answers with a plain 404. The step then reported
    // `gitea 404` and every tenant was created without its Gitea org.
    const res = await giteaFetcher(conn)('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: input.slug,
        full_name: input.name,
        visibility: 'private',
      }),
    })
    if (res.status === 422) {
      return { system: 'gitea', label, status: 'done', detail: 'org already exists' }
    }
    if (!ok(res.status)) {
      return { system: 'gitea', label, status: 'failed', detail: `gitea ${res.status}` }
    }
    return { system: 'gitea', label, status: 'done', detail: 'org created (private)' }
  } catch (e) {
    return { system: 'gitea', label, status: 'failed', detail: (e as Error).message }
  }
}

/**
 * Provision a tenant across all systems. Runs Keycloak → Namespace/RBAC first
 * (identity + isolation), then ArgoCD + Gitea in parallel. Never throws — always
 * resolves with one result per system.
 */
export async function provisionTenant(input: ProvisionInput): Promise<ProvisionStepResult[]> {
  const results: ProvisionStepResult[] = []
  results.push(await provisionKeycloak(input))
  results.push(await provisionNamespace(input))
  const [argo, gitea] = await Promise.all([provisionArgoProject(input), provisionGitea(input)])
  results.push(argo, gitea)
  return results
}
