import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'
import { getTool } from './tool-registry.ts'
import { toolPublicUrl } from './domain.ts'

/**
 * `POST /api/catalog/teardown` — remove a catalog entity from the platform.
 *
 * The scaffolder creates four things for a component: a Gitea repository, a
 * kpack Image, an Argo CD Application and (through the Application) the
 * workload. Deleting a card must undo all of it, or the catalog keeps showing
 * a service that half-exists. So this handler, as the signed-in user:
 *
 *   1. deletes every Argo CD Application the caller names, with the resources
 *      finalizer set first so the controller cascades to the workload, then
 *      waits (bounded) for each to disappear;
 *   2. deletes the kpack Image of the same name in the build namespace;
 *   3. deletes Tekton PipelineRuns labelled with the component;
 *   4. deletes the workload namespace when the caller asked for it, never a
 *      platform namespace;
 *   5. deletes the Gitea repository when the caller asked for it and the
 *      repository is on this platform's Gitea (repositories elsewhere are
 *      reported as skipped, never touched).
 *
 * Kubernetes calls carry the user's identity so RBAC decides; Gitea uses the
 * durable admin connection the scaffolder uses to create repositories. Each
 * step reports its own outcome and a missing object counts as done: the goal
 * is the platform state, not the request.
 */

interface TeardownRequest {
  name?: string
  apps?: Array<{ name?: string; namespace?: string }>
  /** Repository URL to delete. Deleted only when it lives on this Gitea. */
  repo?: string
  /** Also delete the workload namespace. */
  namespace?: string
  /** Namespace to look for PipelineRuns in (defaults to `namespace`). */
  pipelinesNamespace?: string
  /** Skip the kpack Image. */
  keepBuild?: boolean
}

export interface TeardownStep {
  id: string
  label: string
  ok: boolean
  /** True when there was nothing to do (already gone, not configured, not asked). */
  skipped?: boolean
  detail?: string
}

const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,61}[a-z0-9])?$/
const ARGO_FINALIZER = 'resources-finalizer.argocd.argoproj.io'
const APP_GONE_TIMEOUT_MS = 45_000
const APP_POLL_MS = 1_500

/** Namespaces the console never deletes, whatever the caller says. */
const PROTECTED_NAMESPACES = new Set([
  'default', 'kube-system', 'kube-public', 'kube-node-lease',
  'argocd', 'argo', 'argo-rollouts', 'tekton-pipelines', 'kpack',
  'adhar-system', 'adhar', 'gitea', 'harbor', 'keycloak', 'monitoring',
  'observability', 'cert-manager', 'crossplane-system', 'kyverno',
  'istio-system', 'envoy-gateway-system', 'ingress-nginx',
])

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function validName(s: unknown): s is string {
  return typeof s === 'string' && NAME_RE.test(s)
}

async function readErr(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { message?: string }
    if (j.message) return j.message.slice(0, 200)
  } catch { /* plain text */ }
  return t.slice(0, 200)
}

export async function handleTeardown(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  let body: TeardownRequest
  try {
    body = (await req.json()) as TeardownRequest
  } catch {
    return withCookie(Response.json({ error: 'invalid_json' }, { status: 400 }), auth.refreshedCookie)
  }
  if (!validName(body.name)) {
    return withCookie(Response.json({ error: 'invalid_name' }, { status: 400 }), auth.refreshedCookie)
  }
  const name = body.name
  const steps: TeardownStep[] = []
  const step = (s: TeardownStep) => steps.push(s)

  const id = await resolveIdentity(req)
  const argoNs = env('ARGOCD_NAMESPACE') ?? 'argocd'

  /* ── 1. Argo CD Applications, cascading ── */
  const apps = (body.apps ?? []).filter((a) => validName(a.name))
  if (!apps.length) {
    step({ id: 'argo', label: 'Argo CD applications', ok: true, skipped: true, detail: 'none matched this entity' })
  } else if (!id) {
    step({ id: 'argo', label: 'Argo CD applications', ok: false, detail: 'no cluster identity' })
  } else {
    const results: string[] = []
    let allOk = true
    for (const a of apps) {
      const ns = validName(a.namespace) ? a.namespace : argoNs
      const path = `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(ns)}/applications/${encodeURIComponent(a.name!)}`
      try {
        // Cascade needs the finalizer on the Application before it is deleted;
        // without it Argo CD forgets the app and leaves the workload running.
        const patch = await apiServerFetch(id, path, {
          method: 'PATCH',
          headers: { 'content-type': 'application/merge-patch+json' },
          body: JSON.stringify({ metadata: { finalizers: [ARGO_FINALIZER] } }),
        })
        if (patch.status === 404) {
          results.push(`${a.name}: already gone`)
          continue
        }
        if (!patch.ok) {
          allOk = false
          results.push(`${a.name}: could not set finalizer (${patch.status} ${await readErr(patch)})`)
          continue
        }
        const del = await apiServerFetch(id, path, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ propagationPolicy: 'Foreground' }),
        })
        if (!del.ok && del.status !== 404) {
          allOk = false
          results.push(`${a.name}: delete refused (${del.status} ${await readErr(del)})`)
          continue
        }
        // Wait for the controller to finish pruning; a bounded wait so a stuck
        // finalizer reports rather than hangs the request.
        const started = Date.now()
        let gone = false
        while (Date.now() - started < APP_GONE_TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, APP_POLL_MS))
          const probe = await apiServerFetch(id, path, { method: 'GET' })
          if (probe.status === 404) { gone = true; break }
          await probe.body?.cancel()
        }
        results.push(gone ? `${a.name}: deleted with its resources` : `${a.name}: deleting in the background`)
      } catch (e) {
        allOk = false
        results.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    step({ id: 'argo', label: 'Argo CD applications', ok: allOk, detail: results.join(' · ') })
  }

  /* ── 2. kpack Image ── */
  if (body.keepBuild) {
    step({ id: 'build', label: 'Build (kpack Image)', ok: true, skipped: true, detail: 'kept' })
  } else if (!id) {
    step({ id: 'build', label: 'Build (kpack Image)', ok: false, detail: 'no cluster identity' })
  } else {
    const buildNs = env('KPACK_NAMESPACE') ?? 'adhar-system'
    try {
      const r = await apiServerFetch(
        id,
        `/apis/kpack.io/v1alpha2/namespaces/${encodeURIComponent(buildNs)}/images/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      if (r.status === 404) step({ id: 'build', label: 'Build (kpack Image)', ok: true, skipped: true, detail: 'no Image for this name (or kpack not installed)' })
      else if (r.ok) step({ id: 'build', label: 'Build (kpack Image)', ok: true, detail: `${buildNs}/${name}` })
      else step({ id: 'build', label: 'Build (kpack Image)', ok: false, detail: `${r.status} ${await readErr(r)}` })
    } catch (e) {
      step({ id: 'build', label: 'Build (kpack Image)', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  /* ── 3. Tekton PipelineRuns ── */
  {
    const ns = validName(body.pipelinesNamespace) ? body.pipelinesNamespace : validName(body.namespace) ? body.namespace : undefined
    if (!id) {
      step({ id: 'pipelines', label: 'Pipeline runs', ok: false, detail: 'no cluster identity' })
    } else if (!ns) {
      step({ id: 'pipelines', label: 'Pipeline runs', ok: true, skipped: true, detail: 'no namespace known for this entity' })
    } else {
      try {
        const r = await apiServerFetch(
          id,
          `/apis/tekton.dev/v1/namespaces/${encodeURIComponent(ns)}/pipelineruns`,
          { method: 'DELETE', search: `?labelSelector=${encodeURIComponent(`adhar.io/component=${name}`)}` },
        )
        if (r.status === 404) step({ id: 'pipelines', label: 'Pipeline runs', ok: true, skipped: true, detail: 'Tekton not installed' })
        else if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { items?: unknown[] }
          const n = Array.isArray(j.items) ? j.items.length : 0
          step({ id: 'pipelines', label: 'Pipeline runs', ok: true, skipped: n === 0, detail: n ? `${n} run${n === 1 ? '' : 's'} in ${ns}` : `none labelled adhar.io/component=${name} in ${ns}` })
        } else step({ id: 'pipelines', label: 'Pipeline runs', ok: false, detail: `${r.status} ${await readErr(r)}` })
      } catch (e) {
        step({ id: 'pipelines', label: 'Pipeline runs', ok: false, detail: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  /* ── 4. Namespace ── */
  if (!validName(body.namespace)) {
    step({ id: 'namespace', label: 'Namespace', ok: true, skipped: true, detail: 'kept' })
  } else if (PROTECTED_NAMESPACES.has(body.namespace)) {
    step({ id: 'namespace', label: 'Namespace', ok: false, detail: `${body.namespace} is a platform namespace and is never deleted from here` })
  } else if (!id) {
    step({ id: 'namespace', label: 'Namespace', ok: false, detail: 'no cluster identity' })
  } else {
    try {
      const r = await apiServerFetch(id, `/api/v1/namespaces/${encodeURIComponent(body.namespace)}`, { method: 'DELETE' })
      if (r.status === 404) step({ id: 'namespace', label: 'Namespace', ok: true, skipped: true, detail: 'already gone' })
      else if (r.ok) step({ id: 'namespace', label: 'Namespace', ok: true, detail: `${body.namespace} — terminating` })
      else step({ id: 'namespace', label: 'Namespace', ok: false, detail: `${r.status} ${await readErr(r)}` })
    } catch (e) {
      step({ id: 'namespace', label: 'Namespace', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  /* ── 5. Gitea repository ── */
  if (!body.repo) {
    step({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: 'kept' })
  } else {
    const target = giteaRepoOf(body.repo)
    const conn = giteaConn()
    if (!target) {
      step({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: 'not on this platform’s Gitea — left as is' })
    } else if (!conn) {
      step({ id: 'repo', label: 'Source repository', ok: false, detail: 'Gitea is not configured on the console' })
    } else {
      try {
        const api = giteaFetcher(conn)
        const r = await api(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`, { method: 'DELETE' })
        if (r.status === 404) step({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: 'already gone' })
        else if (r.ok || r.status === 204) step({ id: 'repo', label: 'Source repository', ok: true, detail: `${target.owner}/${target.repo}` })
        else step({ id: 'repo', label: 'Source repository', ok: false, detail: `${r.status} ${await readErr(r)}` })
      } catch (e) {
        step({ id: 'repo', label: 'Source repository', ok: false, detail: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  const ok = steps.every((s) => s.ok)
  return withCookie(Response.json({ ok, name, steps }), auth.refreshedCookie)
}

/**
 * `owner/repo` when `url` points at this platform's Gitea — its configured
 * base URL, its public URL, or an in-cluster Service host — else null. The
 * check is by host, so a GitHub or GitLab URL can never be mistaken for a
 * local repository.
 */
export function giteaRepoOf(url: string, hosts: string[] = giteaHosts()): { owner: string; repo: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const known = hosts.some((h) => h === host) || /^gitea(-http)?(\.[a-z0-9-]+)?(\.svc(\.cluster\.local)?)?$/.test(host)
  if (!known) return null
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  if (!NAME_RE.test(owner.toLowerCase()) || !NAME_RE.test(repo.toLowerCase())) return null
  return { owner, repo }
}

function giteaHosts(): string[] {
  const out: string[] = []
  const add = (raw: string | undefined) => {
    if (!raw) return
    try {
      out.push(new URL(raw).hostname.toLowerCase())
    } catch { /* not a URL */ }
  }
  add(getTool('gitea')?.baseUrl)
  add(env('GITEA_URL'))
  try {
    add(toolPublicUrl('gitea', 'GITEA_URL'))
  } catch { /* no domain configured */ }
  return out
}
