import { env } from '@adhar/utils'
import { normaliseToken } from './role-tokens.ts'
import { getRequestUser, unauthorized } from './request-user.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'
import { isPlatformRepo } from '../data/catalog-platform-repos.ts'
import { APPLICATION_GVR, CONTROL_PLANE_NAMESPACE } from '../data/catalog-custom-apps.ts'

/**
 * `POST /api/apps/delete` — delete a custom application from the platform.
 *
 * Request:  `{ name: string, deleteRepo: boolean, confirm: string }`
 * Response: `{ ok, name, deleting, steps: AppDeleteStep[] }` (200), or
 *           `{ error, detail }` with 400 / 401 / 403 / 405 / 502 / 503 when the
 *           request is refused before anything is touched.
 *
 * An application created through the control plane is ONE Application XR in
 * `adhar-system`; Crossplane composes everything else from it — an Argo CD
 * Application per environment, and the databases, caches and event pools the
 * app declared. Deleting the composed Argo CD apps directly (what the generic
 * catalog teardown does) only makes Crossplane put them back. So this handler
 * deletes the XR and lets Crossplane remove what it composed.
 *
 *   1. Application XR — deleted AS THE SIGNED-IN USER through the k8s gateway
 *      (impersonation on clusters without OIDC), so the user's own RBAC
 *      decides; a 403 from the apiserver is reported verbatim. Foreground
 *      propagation: the XR stays (with a deletionTimestamp) until the garbage
 *      collector has removed its composed resources, so "still deleting" is
 *      observable instead of the XR vanishing while its database lingers.
 *   2. Gitea repository `<org>/<name>` — only when asked, and only after step 1
 *      succeeded (or the XR was already gone). The console talks to Gitea with
 *      ADMIN credentials, which is why this lives on the server behind a role
 *      check and never goes through the browser's generic `/api/svc/gitea`
 *      proxy. Platform repositories, pull mirrors and archived repositories
 *      are refused before anything is deleted.
 *
 * A missing object counts as done: the goal is the platform state.
 */

export interface AppDeleteRequest {
  name?: unknown
  deleteRepo?: unknown
  confirm?: unknown
}

export interface AppDeleteStep {
  id: 'application' | 'repo'
  label: string
  ok: boolean
  /** True when there was nothing to do (already gone, not asked). */
  skipped?: boolean
  detail?: string
}

export interface AppDeleteResult {
  ok: boolean
  name: string
  /** True when the XR is still finalising (Crossplane removing composed resources). */
  deleting: boolean
  steps: AppDeleteStep[]
}

/** Console roles allowed to delete an application. The server is the gate; the UI only mirrors it. */
export const APP_DELETE_ROLES = ['super-admin', 'platform-admin', 'platform-engineer', 'application-admin'] as const

/** Raw role/group spellings that mean one of the allowed roles (mirrors @adhar/auth ROLE_ALIASES). */
const ALLOWED_TOKENS = new Set([
  'admin', 'super-admin', 'superadmin',
  'platform-admin', 'platform-admins',
  'platform-engineer', 'platform-engineers', 'platform-eng',
  'application-admin', 'application-admins', 'app-admin', 'tenant-admin',
])

/** DNS-1123 label — what an Application XR name and its repo name must be. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export { normaliseToken }

/** True when the user's roles or groups include a role allowed to delete applications. */
export function canDeleteApplications(user: { roles?: readonly string[]; groups?: readonly string[] } | null | undefined): boolean {
  if (!user) return false
  for (const raw of [...(user.roles ?? []), ...(user.groups ?? [])]) {
    if (typeof raw === 'string' && ALLOWED_TOKENS.has(normaliseToken(raw))) return true
  }
  return false
}

export type Validation =
  | { ok: true; name: string; deleteRepo: boolean }
  | { ok: false; status: number; error: string; detail: string }

/** Validate the request body. Pure — no I/O. */
export function validateAppDelete(body: AppDeleteRequest | null | undefined): Validation {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'invalid_body', detail: 'Expected a JSON object.' }
  }
  const { name, confirm, deleteRepo } = body
  if (typeof name !== 'string' || !DNS_LABEL.test(name)) {
    return { ok: false, status: 400, error: 'invalid_name', detail: 'The application name must be a DNS-1123 label (lowercase letters, digits and dashes, at most 63 characters).' }
  }
  if (typeof confirm !== 'string' || confirm !== name) {
    return { ok: false, status: 400, error: 'confirm_mismatch', detail: `Type the application name (${name}) to confirm.` }
  }
  if (deleteRepo !== undefined && typeof deleteRepo !== 'boolean') {
    return { ok: false, status: 400, error: 'invalid_body', detail: '`deleteRepo` must be a boolean.' }
  }
  if (isPlatformRepo(name)) {
    return { ok: false, status: 400, error: 'platform_app', detail: `${name} is part of the platform and cannot be deleted from the catalog.` }
  }
  return { ok: true, name, deleteRepo: deleteRepo === true }
}

/** Why a Gitea repository must not be deleted from here, or null when it may be. Pure. */
export function repoRefusal(repo: { name?: string; mirror?: boolean; archived?: boolean }): string | null {
  if (isPlatformRepo(repo.name, repo)) {
    return repo.mirror
      ? `${repo.name} is a pull mirror of upstream code, not an application repository.`
      : `${repo.name} is a platform repository.`
  }
  if (repo.archived) return `${repo.name} is archived — unarchive it in Gitea first if it really should go.`
  return null
}

/** The Gitea org the catalog lists repositories from (same rule as /api/config's `giteaOrg`). */
function catalogOrg(): string {
  return env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar'
}

function json(body: unknown, status: number, cookie?: string): Response {
  const res = Response.json(body, { status })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

async function readErr(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { message?: string }
    if (j.message) return j.message.slice(0, 400)
  } catch { /* plain text */ }
  return t.slice(0, 400)
}

function auditLine(entry: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'app.delete', ...entry }))
  } catch { /* never let logging break a request */ }
}

export async function handleAppDelete(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const cookie = auth.refreshedCookie
  const who = auth.user.username ?? auth.user.email ?? auth.user.id

  if (!canDeleteApplications(auth.user)) {
    return json({ error: 'forbidden', detail: 'Deleting an application needs the platform-admin, platform-engineer or application-admin role.' }, 403, cookie)
  }

  let body: AppDeleteRequest
  try {
    body = (await req.json()) as AppDeleteRequest
  } catch {
    return json({ error: 'invalid_json', detail: 'The request body is not JSON.' }, 400, cookie)
  }
  const v = validateAppDelete(body)
  if (!v.ok) return json({ error: v.error, detail: v.detail }, v.status, cookie)
  const { name, deleteRepo } = v
  const org = catalogOrg()

  // Check the repository BEFORE deleting anything, so a refusal (mirror,
  // archived, Gitea unreachable) leaves the application untouched.
  const conn = deleteRepo ? giteaConn() : null
  let repoGone = false
  if (deleteRepo) {
    if (!conn) return json({ error: 'gitea_not_configured', detail: 'Gitea is not configured on the console, so the repository cannot be deleted. Untick it to delete only the application.' }, 503, cookie)
    try {
      const r = await giteaFetcher(conn)(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`)
      if (r.status === 404) {
        repoGone = true
        await r.body?.cancel()
      } else if (!r.ok) {
        return json({ error: 'gitea_unavailable', detail: `Could not check ${org}/${name} in Gitea (${r.status} ${await readErr(r)}). Nothing was deleted.` }, 502, cookie)
      } else {
        const repo = (await r.json()) as { name?: string; mirror?: boolean; archived?: boolean }
        const why = repoRefusal({ ...repo, name: repo.name ?? name })
        if (why) return json({ error: 'repo_protected', detail: `${why} Nothing was deleted.` }, 400, cookie)
      }
    } catch (e) {
      return json({ error: 'gitea_unavailable', detail: `Could not reach Gitea: ${e instanceof Error ? e.message : String(e)}. Nothing was deleted.` }, 502, cookie)
    }
  }

  const steps: AppDeleteStep[] = []
  let deleting = false

  /* ── 1. Application XR, as the user ── */
  const id = await resolveIdentity(req)
  const xrPath = `/apis/${APPLICATION_GVR.group}/${APPLICATION_GVR.version}/namespaces/${CONTROL_PLANE_NAMESPACE}/${APPLICATION_GVR.resource}/${encodeURIComponent(name)}`
  if (!id) {
    steps.push({ id: 'application', label: 'Application resource', ok: false, detail: 'No cluster identity for your session — sign in again.' })
  } else {
    try {
      const r = await apiServerFetch(id, xrPath, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'DeleteOptions', apiVersion: 'v1', propagationPolicy: 'Foreground' }),
      })
      if (r.status === 404) {
        await r.body?.cancel()
        steps.push({ id: 'application', label: 'Application resource', ok: true, skipped: true, detail: `${CONTROL_PLANE_NAMESPACE}/${name} was already gone` })
      } else if (r.ok) {
        // 200 with the object while finalizers run; 200 with a Status when it
        // was removed outright. Either way the deletion is accepted.
        const obj = (await r.json().catch(() => ({}))) as { kind?: string; metadata?: { deletionTimestamp?: string } }
        deleting = obj.kind !== 'Status' && Boolean(obj.metadata?.deletionTimestamp)
        steps.push({
          id: 'application',
          label: 'Application resource',
          ok: true,
          detail: deleting
            ? `${CONTROL_PLANE_NAMESPACE}/${name} is deleting — Crossplane is removing its Argo CD apps and composed resources`
            : `${CONTROL_PLANE_NAMESPACE}/${name} deleted`,
        })
      } else {
        // RBAC refusals and anything else, verbatim from the apiserver.
        steps.push({ id: 'application', label: 'Application resource', ok: false, detail: `${r.status} ${await readErr(r)}` })
      }
    } catch (e) {
      steps.push({ id: 'application', label: 'Application resource', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  const xrOk = steps[0]?.ok === true

  /* ── 2. Gitea repository (admin connection, only after step 1) ── */
  if (!deleteRepo) {
    steps.push({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: 'kept' })
  } else if (!xrOk) {
    steps.push({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: `kept — ${org}/${name} is only deleted after the application is` })
  } else if (repoGone) {
    steps.push({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: `${org}/${name} was already gone` })
  } else {
    try {
      const r = await giteaFetcher(conn!)(`/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (r.status === 404) steps.push({ id: 'repo', label: 'Source repository', ok: true, skipped: true, detail: `${org}/${name} was already gone` })
      else if (r.ok) steps.push({ id: 'repo', label: 'Source repository', ok: true, detail: `${org}/${name} deleted` })
      else steps.push({ id: 'repo', label: 'Source repository', ok: false, detail: `${r.status} ${await readErr(r)}` })
      await r.body?.cancel().catch(() => {})
    } catch (e) {
      steps.push({ id: 'repo', label: 'Source repository', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const ok = steps.every((s) => s.ok)
  auditLine({
    user: who,
    app: name,
    deleteRepo,
    ok,
    steps: steps.map((s) => ({ id: s.id, ok: s.ok, skipped: s.skipped ?? false, detail: s.detail })),
  })
  const result: AppDeleteResult = { ok, name, deleting, steps }
  return json(result, 200, cookie)
}
