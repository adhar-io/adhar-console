import { env } from '@adhar/utils'
import { apiServerFetch } from './k8s/gateway.ts'
import { getK8sServiceToken, getTool } from './tool-registry.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { getKeycloakAdmin } from './workspace/keycloak-admin.ts'
import { applyXr, organisationManifest } from './control-plane.ts'
import { orgAdminGroup, orgMemberGroup } from './tenancy/org-access.ts'

/**
 * Tenant provisioner — turns a logical organization into a real, isolated tenant
 * across the platform's systems when the console has the credentials to do so:
 *
 *   • **Keycloak**   — the identity groups `org-<slug>` (members) and
 *                      `org-<slug>-admin` (admins), with the creator in both:
 *                      they ARE the organisation's membership (org-access.ts).
 *   • **Kubernetes** — a namespace `<slug>` labelled for the tenant, with the
 *                      admin group bound to the namespaced `admin` ClusterRole
 *                      and the member group to `view` — the isolation boundary,
 *                      exactly what the Organisation composition grants.
 *   • **ArgoCD**     — an AppProject `<slug>` whose destinations are restricted
 *                      to the tenant namespace, so GitOps can only deploy there.
 *   • **Gitea**      — an org `<slug>` to hold the tenant's repositories.
 *   • **Grafana**    — a folder for the tenant's dashboards, plus a team named
 *                      for its Keycloak group, granted edit on that folder.
 *   • **Harbor**     — a private project `<slug>` to push images to, with the
 *                      tenant's group added as a developer.
 *
 * Every step is **best-effort and independent**: the organization record is
 * already persisted before this runs and is never rolled back. Each step reports
 * `done` / `skipped` (credentials/URL absent) / `failed` (with a short detail),
 * so onboarding can show an honest per-system result instead of pretending.
 * Privileged calls use the console's own service-account token — not the
 * signed-in user's — because tenant creation is a platform operation.
 */

export interface ProvisionStepResult {
  system: 'controlplane' | 'keycloak' | 'namespace' | 'argocd' | 'gitea' | 'grafana' | 'harbor'
  label: string
  status: 'done' | 'skipped' | 'failed'
  detail?: string
}

export interface ProvisionInput {
  slug: string
  name: string
  /** The creating user's Keycloak id (the token's `sub`), put in both groups. */
  userRef?: string
  /** What the organisation is for, as typed during onboarding. */
  description?: string
}

/** The organisation's member group — the name Grafana and Harbor are given for it. */
export const groupForOrg = (slug: string) => orgMemberGroup(slug)

const ok = (status: number) => status >= 200 && status < 300

async function k8sApply(token: string, path: string, manifest: unknown): Promise<Response> {
  return apiServerFetch(token, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  })
}

/* ── Keycloak identity groups ── */
async function provisionKeycloak(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `Keycloak groups ${orgMemberGroup(input.slug)}, ${orgAdminGroup(input.slug)}`
  const kc = getKeycloakAdmin()
  if (!kc) return { system: 'keycloak', label, status: 'skipped', detail: 'Keycloak admin not configured' }
  try {
    // Organisation creation already did this inline (organizations.ts); it is
    // repeated, idempotently, so the job's report is about what is TRUE.
    await kc.ensureOrgGroups(input.slug)
    if (input.userRef) {
      await kc.addUserToGroup(input.userRef, orgMemberGroup(input.slug))
      await kc.addUserToGroup(input.userRef, orgAdminGroup(input.slug))
    }
    return { system: 'keycloak', label, status: 'done', detail: input.userRef ? 'groups ready, creator is admin' : 'groups ready' }
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
    // The same two bindings the Organisation composition makes (admin-rbac /
    // member-rbac in compositions/organisation/local.yaml), with the
    // apiserver's `oidc:` group prefix: admins administer the namespace,
    // members may read it. Binding the MEMBER group to admin — as this path
    // once did — made every member an administrator.
    for (const binding of [
      { name: `${input.slug}-org-admin`, role: 'admin', group: orgAdminGroup(input.slug) },
      { name: `${input.slug}-org-view`, role: 'view', group: orgMemberGroup(input.slug) },
    ]) {
      const rbRes = await k8sApply(
        token,
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${input.slug}/rolebindings`,
        {
          apiVersion: 'rbac.authorization.k8s.io/v1',
          kind: 'RoleBinding',
          metadata: { name: binding.name, namespace: input.slug, labels: { 'adhar.io/organisation': input.slug } },
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: binding.role },
          subjects: [
            { kind: 'Group', name: `oidc:${binding.group}`, apiGroup: 'rbac.authorization.k8s.io' },
          ],
        },
      )
      if (!ok(rbRes.status) && rbRes.status !== 409) {
        return {
          system: 'namespace',
          label,
          status: 'failed',
          detail: `namespace ready, RoleBinding ${binding.name} ${rbRes.status}`,
        }
      }
    }
    return {
      system: 'namespace',
      label,
      status: 'done',
      detail: `namespace; ${orgAdminGroup(input.slug)} admin, ${orgMemberGroup(input.slug)} view`,
    }
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

/* ── Shared: basic-auth fetch for tools the console holds admin creds for ── */

/**
 * Admin-credentialled call to a backing tool.
 *
 * Grafana and Harbor both take HTTP Basic with the admin account the console
 * already holds for its proxy, so there is no separate credential to provision
 * or rotate for this. Returns null when the tool is not configured, which the
 * callers report as `skipped` rather than `failed` — an install without Harbor
 * has not failed to provision Harbor.
 */
function adminFetch(tool: 'grafana' | 'harbor') {
  const def = getTool(tool)
  if (!def?.baseUrl || !def.username || !def.password) return null
  const auth = `Basic ${btoa(`${def.username}:${def.password}`)}`
  const base = def.baseUrl.replace(/\/$/, '')
  return (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: auth,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
}

/* ── Grafana: a folder per tenant, owned by the tenant's team ── */

/**
 * Give the organization somewhere of its own in Grafana.
 *
 * A folder, a team, and the permission that ties them together. The folder is
 * the part that matters: without it every tenant's dashboards land in the same
 * flat list, and "which of these are ours" stops having an answer as soon as
 * there is a second tenant.
 *
 * The team is created too, and named for the Keycloak group, so that an install
 * with Grafana team sync configured has something to sync INTO. Open-source
 * Grafana has no team sync, so membership fills in by hand or as people are
 * added — which is why a missing team is reported, not fatal.
 *
 * Idempotent: an existing folder (412 Precondition Failed on a duplicate uid)
 * and an existing team (409) are both treated as success.
 */
async function provisionGrafana(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `Grafana folder ${input.name}`
  const call = adminFetch('grafana')
  if (!call) return { system: 'grafana', label, status: 'skipped', detail: 'Grafana admin not configured' }

  const uid = `org-${input.slug}`.slice(0, 40)
  try {
    const folderRes = await call('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ uid, title: input.name }),
    })
    // 409/412 both mean "already there", which is the desired end state.
    if (!ok(folderRes.status) && folderRes.status !== 409 && folderRes.status !== 412) {
      return { system: 'grafana', label, status: 'failed', detail: `folder ${folderRes.status}` }
    }

    // Best-effort from here: the folder exists, and that is the useful part.
    const teamName = groupForOrg(input.slug)
    let teamId: number | undefined
    const teamRes = await call('/api/teams', { method: 'POST', body: JSON.stringify({ name: teamName }) })
    if (ok(teamRes.status)) {
      teamId = ((await teamRes.json().catch(() => ({}))) as { teamId?: number }).teamId
    } else if (teamRes.status === 409) {
      const found = await call(`/api/teams/search?name=${encodeURIComponent(teamName)}`)
      const body = (await found.json().catch(() => ({}))) as { teams?: Array<{ id: number }> }
      teamId = body.teams?.[0]?.id
    }

    if (teamId) {
      await call(`/api/folders/${uid}/permissions`, {
        method: 'POST',
        // 2 = Edit. The tenant's own people manage their own dashboards.
        body: JSON.stringify({ items: [{ teamId, permission: 2 }] }),
      }).catch(() => undefined)
      return { system: 'grafana', label, status: 'done', detail: `folder + team ${teamName} (edit)` }
    }
    return { system: 'grafana', label, status: 'done', detail: 'folder ready; team not created' }
  } catch (e) {
    return { system: 'grafana', label, status: 'failed', detail: (e as Error).message }
  }
}

/* ── Harbor: a private project per tenant ── */

/**
 * A registry project the tenant pushes to.
 *
 * The platform's own project model already expects one — `ProjectDoc` carries a
 * `harborProject` alongside `giteaOrg` and `argoProject` — but nothing created
 * it, so that field pointed at a project that did not exist and every tenant
 * shared `library`.
 *
 * Private by default: a registry that is public until someone remembers to
 * change it is the wrong default for a multi-tenant platform. The Keycloak group
 * is added as a project member where Harbor's OIDC group support allows it, so
 * access follows the same group as everything else.
 */
async function provisionHarbor(input: ProvisionInput): Promise<ProvisionStepResult> {
  const label = `Harbor project ${input.slug}`
  const call = adminFetch('harbor')
  if (!call) return { system: 'harbor', label, status: 'skipped', detail: 'Harbor admin not configured' }

  try {
    const res = await call('/api/v2.0/projects', {
      method: 'POST',
      body: JSON.stringify({
        project_name: input.slug,
        metadata: { public: 'false' },
      }),
    })
    // 409 = already exists, which is the end state we want.
    if (!ok(res.status) && res.status !== 409) {
      return { system: 'harbor', label, status: 'failed', detail: `harbor ${res.status}` }
    }

    // Group membership is best-effort: it needs Harbor configured for OIDC
    // groups, and the project existing is the part that unblocks pushes.
    await call(`/api/v2.0/projects/${encodeURIComponent(input.slug)}/members`, {
      method: 'POST',
      body: JSON.stringify({
        // 2 = Developer: push and pull, but not project administration.
        role_id: 2,
        member_group: { group_name: groupForOrg(input.slug), group_type: 3 },
      }),
    }).catch(() => undefined)

    return {
      system: 'harbor',
      label,
      status: 'done',
      detail: res.status === 409 ? 'project already exists' : 'project created (private)',
    }
  } catch (e) {
    return { system: 'harbor', label, status: 'failed', detail: (e as Error).message }
  }
}

/**
 * Provision a tenant across all systems. Runs Keycloak → Namespace/RBAC first
 * (identity + isolation), then ArgoCD + Gitea in parallel. Never throws — always
 * resolves with one result per system.
 */
/* ── the control plane: the Organisation XR ── */
async function provisionControlPlane(input: ProvisionInput): Promise<ProvisionStepResult> {
  const out = await applyXr(organisationManifest({ slug: input.slug, name: input.name, description: input.description }))
  return {
    system: 'controlplane',
    label: 'Organisation resource',
    status: out.ok ? 'done' : 'failed',
    detail: out.ok ? out.detail : `${out.detail} — falling back to direct provisioning`,
  }
}

export async function provisionTenant(input: ProvisionInput): Promise<ProvisionStepResult[]> {
  const results: ProvisionStepResult[] = []
  // Identity stays the console's: the Organisation composition BINDS the
  // `org-<slug>` groups, it does not create them.
  results.push(await provisionKeycloak(input))
  // Declare the organisation to the control plane. Its composition creates the
  // home namespace, quota and role bindings and the Gitea organisation, so
  // when it is accepted those two steps are not repeated here — two writers
  // for one namespace is how drift starts. If the platform has no control
  // plane (or refuses the write) the direct path below still provisions.
  const cp = await provisionControlPlane(input)
  results.push(cp)
  if (cp.status === 'done') {
    const via = 'via the control plane (Organisation XR)'
    results.push({ system: 'namespace', label: 'Namespace & RBAC', status: 'done', detail: via })
    const rest = await Promise.all([provisionArgoProject(input), provisionGrafana(input), provisionHarbor(input)])
    results.push(...rest)
    results.push({ system: 'gitea', label: 'Git organization', status: 'done', detail: via })
    return results
  }
  results.push(await provisionNamespace(input))
  // The rest are independent of each other and of the order they finish in, so
  // they run together — provisioning an organization should not take as long as
  // the sum of every tool's latency.
  const rest = await Promise.all([
    provisionArgoProject(input),
    provisionGitea(input),
    provisionGrafana(input),
    provisionHarbor(input),
  ])
  results.push(...rest)
  return results
}
