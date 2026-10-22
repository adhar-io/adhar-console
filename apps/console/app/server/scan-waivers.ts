import { getRequestUser, unauthorized } from './request-user.ts'
import { openStore, type Store } from './workspace/store.ts'
import { apiServerFetch, type K8sIdentity, originOk, resolveIdentity } from './k8s/gateway.ts'
import { permissionsFor, requirePermission } from './k8s/access.ts'
import { CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth/server'
import { emitNotification, type NotificationDoc } from './notify.ts'
import {
  type Actor,
  affectedScopes,
  DEFAULT_POLICY,
  GATE_DECISION_KIND,
  gateDecisionPatch,
  gateOf,
  type GateView,
  hasScanSignal,
  isActive,
  isDnsLabel,
  isExpiringSoon,
  mergeConfigMapData,
  newWaiver,
  parsePolicy,
  PLATFORM_NAMESPACE,
  POLICY_CM,
  POLICY_GLOBAL_CM,
  POLICY_LABEL,
  renderWaiverConfigMap,
  type ScanPolicy,
  serializePolicy,
  sweep,
  transition,
  type TransitionCtx,
  validatePolicy,
  validateWaiverRequest,
  WAIVER_KIND,
  type WaiverAction,
  type WaiverRecord,
  WAIVERS_LABEL,
} from './scan-waivers-model.ts'

/**
 * Scan waivers, scan policy and the manual scan gate — `/api/security/*`.
 *
 *   GET  /api/security/waivers[?project=]          list (+ expiry sweep), caller's capabilities
 *   POST /api/security/waivers                      request a waiver
 *   GET  /api/security/waivers/<id>                 one record with its audit trail
 *   POST /api/security/waivers/<id>/<action>        approve | reject | revoke | withdraw | comment | extend
 *   POST /api/security/waivers/bulk                 { ids, action: approve|reject|revoke, comment }
 *   POST /api/security/waivers/sync                 { project? | global } re-render the ConfigMaps now
 *   GET  /api/security/policy?project=              project + global scan policy, effective policy
 *   PUT  /api/security/policy                       { scope: project|global, project?, policy }
 *   GET  /api/security/gates[?namespace=&name=]     PipelineRuns carrying scan results / a gate
 *   POST /api/security/gate                         { namespace, name, decision, comment, waiver? }
 *
 * Waiver requests and reviews live in the console database (`security.waiver`,
 * tenant-scoped; the generic `/api/store` refuses `security.*` so nobody can
 * forge an approval). Every decision re-renders the affected `scan-waivers`
 * ConfigMap(s) through the apiserver AS THE SIGNED-IN USER (impersonation on
 * managed clusters) — the user's RBAC, not the console's, decides whether the
 * write lands, and a refusal is reported, never hidden.
 */

const SWEEP_EVERY_MS = 60_000
const lastSweep = new Map<string, number>()

type Auth = NonNullable<Awaited<ReturnType<typeof getRequestUser>>>

function json(body: unknown, status: number, cookie?: string): Response {
  const res = Response.json(body, { status })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function actorOf(auth: Auth): Actor {
  const u = auth.user as { id: string; name?: string; username?: string; email?: string }
  return { id: u.id, label: u.name || u.username || u.email || u.id }
}

/**
 * What the caller may do here, as Kubernetes RBAC answers it — the same checks
 * the handlers enforce and the Scans page hides its actions on:
 *   create scan-waivers        request / extend a waiver
 *   approve scan-waivers       approve, reject, revoke; decide gates; re-sync
 *   self-approve scan-waivers  approve a request you made yourself
 *   update scan-policies       change global / project scan policy
 */
async function caps(req: Request, auth: Auth) {
  const a = actorOf(auth)
  const can = await permissionsFor(req, {
    canRequest: CONSOLE_PERMISSIONS.waiverRequest,
    canApprove: CONSOLE_PERMISSIONS.waiverApprove,
    platformAdmin: CONSOLE_PERMISSIONS.waiverSelfApprove,
    canEditPolicy: CONSOLE_PERMISSIONS.scanPolicyEdit,
  })
  return { id: a.id, label: a.label, ...can }
}

function auditLine(entry: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'security.waiver', ...entry }))
  } catch { /* never let logging break a request */ }
}

async function readErr(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { message?: string }
    if (j.message) return j.message.slice(0, 400)
  } catch { /* plain text */ }
  return t.slice(0, 400)
}

async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

/* ───────────────────────────── routing ───────────────────────────── */

export async function handleScanSecurity(req: Request, subpath: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const cookie = auth.refreshedCookie
  const method = req.method.toUpperCase()
  // Decisions here change what CI lets through — refuse cross-site writes.
  if (method !== 'GET' && method !== 'HEAD' && !originOk(req)) return json({ error: 'origin_not_allowed' }, 403, cookie)
  const parts = subpath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent)

  try {
    if (parts[0] === 'policy') {
      if (method === 'GET') return json(await getPolicy(req, auth), 200, cookie)
      if (method === 'PUT') return withCookie(await putPolicy(req, auth), cookie)
      return new Response('Method Not Allowed', { status: 405 })
    }
    if (parts[0] === 'gates' && method === 'GET') return withCookie(await listGates(req, auth), cookie)
    if (parts[0] === 'gate' && method === 'POST') return withCookie(await decideGate(req, auth), cookie)
    if (parts[0] !== 'waivers') return json({ error: 'not_found' }, 404, cookie)

    const store = await openStore(auth.activeTenant)
    if (!store) {
      return json({ error: 'store_unavailable', detail: 'The console database is not configured, so waivers cannot be recorded.' }, 503, cookie)
    }
    if (parts.length === 1) {
      if (method === 'GET') return withCookie(await listWaivers(req, auth, store), cookie)
      if (method === 'POST') return withCookie(await createWaiver(req, auth, store), cookie)
      return new Response('Method Not Allowed', { status: 405 })
    }
    if (parts[1] === 'bulk' && method === 'POST') return withCookie(await bulk(req, auth, store), cookie)
    if (parts[1] === 'sync' && method === 'POST') return withCookie(await resync(req, auth, store), cookie)
    const id = parts[1]
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return json({ error: 'invalid_id' }, 400, cookie)
    if (parts.length === 2 && method === 'GET') {
      const doc = await store.get<WaiverRecord>(WAIVER_KIND, id)
      if (!doc) return json({ error: 'not_found' }, 404, cookie)
      return json({ item: doc.data, me: await caps(req, auth) }, 200, cookie)
    }
    if (parts.length === 3 && method === 'POST') return withCookie(await act(req, auth, store, id, parts[2]), cookie)
    return json({ error: 'not_found' }, 404, cookie)
  } catch (e) {
    console.error('[security] request failed:', e)
    return json({ error: 'internal_error', detail: e instanceof Error ? e.message : String(e) }, 500, cookie)
  }
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

/* ───────────────────────────── ConfigMaps ───────────────────────────── */

export interface ConfigMapWrite {
  namespace: string
  name: string
  ok: boolean
  changed: boolean
  detail: string
  count?: number
}

interface CM {
  metadata?: { resourceVersion?: string; labels?: Record<string, string>; annotations?: Record<string, string> }
  data?: Record<string, string>
}

/**
 * Write a ConfigMap as the user: read, merge, write with the read
 * resourceVersion, retry on a 409. Unchanged content is not written.
 */
async function writeConfigMap(
  id: K8sIdentity,
  namespace: string,
  name: string,
  label: string,
  merge: (existing: Record<string, string> | undefined) => { data: Record<string, string>; changed: boolean },
): Promise<ConfigMapWrite> {
  const base = `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`
  for (let attempt = 0; attempt < 4; attempt++) {
    const get = await apiServerFetch(id, `${base}/${encodeURIComponent(name)}`)
    if (get.status === 403) return { namespace, name, ok: false, changed: false, detail: `Your account may not read ConfigMaps in ${namespace} (${await readErr(get)})` }
    if (get.status === 404) {
      await get.body?.cancel()
      const { data } = merge(undefined)
      const r = await apiServerFetch(id, base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name, namespace, labels: { [label]: 'true', 'app.kubernetes.io/managed-by': 'adhar-console' }, annotations: { 'adhar.io/rendered-at': new Date().toISOString() } },
          data,
        }),
      })
      if (r.status === 409) {
        await r.body?.cancel()
        continue
      }
      if (r.ok) {
        await r.body?.cancel()
        return { namespace, name, ok: true, changed: true, detail: `created ${namespace}/${name}` }
      }
      const why = await readErr(r)
      return {
        namespace,
        name,
        ok: false,
        changed: false,
        detail: r.status === 404 ? `namespace ${namespace} does not exist` : r.status === 403 ? `Your account may not create ConfigMaps in ${namespace} (${why})` : `${r.status} ${why}`,
      }
    }
    if (!get.ok) return { namespace, name, ok: false, changed: false, detail: `${get.status} ${await readErr(get)}` }
    const cm = (await get.json()) as CM
    const { data, changed } = merge(cm.data)
    if (!changed) return { namespace, name, ok: true, changed: false, detail: `${namespace}/${name} already up to date` }
    const r = await apiServerFetch(id, `${base}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          ...cm.metadata,
          name,
          namespace,
          labels: { ...cm.metadata?.labels, [label]: 'true' },
          annotations: { ...cm.metadata?.annotations, 'adhar.io/rendered-at': new Date().toISOString() },
        },
        data,
      }),
    })
    if (r.status === 409) {
      await r.body?.cancel()
      continue
    }
    if (r.ok) {
      await r.body?.cancel()
      return { namespace, name, ok: true, changed: true, detail: `updated ${namespace}/${name}` }
    }
    const why = await readErr(r)
    return { namespace, name, ok: false, changed: false, detail: r.status === 403 ? `Your account may not update ConfigMaps in ${namespace} (${why})` : `${r.status} ${why}` }
  }
  return { namespace, name, ok: false, changed: false, detail: `${namespace}/${name} kept changing underneath — try again` }
}

/** Re-render and write the waiver ConfigMaps for these scopes, as the user. */
async function syncScopes(id: K8sIdentity | null, store: Store, scopes: { projects: string[]; global: boolean }, now: number): Promise<ConfigMapWrite[]> {
  if (!scopes.projects.length && !scopes.global) return []
  if (!id) {
    return [
      ...scopes.projects.map((p) => ({ namespace: p, name: 'scan-waivers', ok: false, changed: false, detail: 'No cluster identity for your session — sign in again.' })),
      ...(scopes.global ? [{ namespace: PLATFORM_NAMESPACE, name: 'scan-waivers-global', ok: false, changed: false, detail: 'No cluster identity for your session — sign in again.' }] : []),
    ]
  }
  const all = (await store.list<WaiverRecord>(WAIVER_KIND)).map((d) => d.data)
  const targets: Array<string | null> = [...scopes.projects, ...(scopes.global ? [null] : [])]
  const out: ConfigMapWrite[] = []
  for (const t of targets) {
    const rendered = renderWaiverConfigMap(all, t, now)
    try {
      const w = await writeConfigMap(id, rendered.namespace, rendered.name, WAIVERS_LABEL, (existing) => mergeConfigMapData(existing, rendered.data))
      out.push({ ...w, count: rendered.count })
    } catch (e) {
      out.push({ namespace: rendered.namespace, name: rendered.name, ok: false, changed: false, detail: e instanceof Error ? e.message : String(e), count: rendered.count })
    }
  }
  return out
}

function syncNote(writes: ConfigMapWrite[], now: number): WaiverRecord['sync'] | undefined {
  if (!writes.length) return undefined
  const bad = writes.filter((w) => !w.ok)
  return { at: new Date(now).toISOString(), ok: bad.length === 0, detail: (bad.length ? bad : writes).map((w) => w.detail).join('; ').slice(0, 1000) }
}

/* ───────────────────────────── policy ───────────────────────────── */

interface PolicyRead {
  exists: boolean
  policy: ScanPolicy
  error?: string
}

async function readPolicyCM(id: K8sIdentity, namespace: string, name: string, base: ScanPolicy): Promise<PolicyRead> {
  try {
    const r = await apiServerFetch(id, `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`)
    if (r.status === 404) {
      await r.body?.cancel()
      return { exists: false, policy: { ...base } }
    }
    if (!r.ok) return { exists: false, policy: { ...base }, error: r.status === 403 ? `no permission to read ${namespace}/${name}` : `${r.status} ${await readErr(r)}` }
    const cm = (await r.json()) as CM
    return { exists: true, policy: parsePolicy(cm.data, base) }
  } catch (e) {
    return { exists: false, policy: { ...base }, error: e instanceof Error ? e.message : String(e) }
  }
}

/** The effective policy for a project: project keys over global keys over the defaults. */
async function effectivePolicy(id: K8sIdentity | null, project?: string): Promise<{ global: PolicyRead; project?: PolicyRead; effective: ScanPolicy }> {
  if (!id) return { global: { exists: false, policy: { ...DEFAULT_POLICY }, error: 'no cluster identity' }, effective: { ...DEFAULT_POLICY } }
  const global = await readPolicyCM(id, PLATFORM_NAMESPACE, POLICY_GLOBAL_CM, DEFAULT_POLICY)
  if (!project) return { global, effective: global.policy }
  const proj = await readPolicyCM(id, project, POLICY_CM, global.policy)
  return { global, project: proj, effective: proj.policy }
}

async function getPolicy(req: Request, auth: Auth) {
  const project = new URL(req.url).searchParams.get('project') ?? undefined
  if (project !== undefined && !isDnsLabel(project)) return { error: 'invalid_project' }
  const id = await resolveIdentity(req)
  const p = await effectivePolicy(id, project)
  return {
    ...p,
    defaults: DEFAULT_POLICY,
    // The platform seeds the global policy when it enforces scans in CI; until
    // it exists, waivers are recorded here but nothing in CI reads them.
    platformEnforces: p.global.exists,
    me: await caps(req, auth),
  }
}

async function putPolicy(req: Request, auth: Auth): Promise<Response> {
  const denied = await requirePermission(req, CONSOLE_PERMISSIONS.scanPolicyEdit)
  if (denied) return denied
  const body = await readBody<{ scope?: string; project?: string; policy?: unknown }>(req)
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 })
  const v = validatePolicy(body.policy)
  if (!v.ok) return Response.json({ error: v.error, detail: v.detail }, { status: v.status })
  let namespace: string
  let name: string
  if (body.scope === 'global') {
    namespace = PLATFORM_NAMESPACE
    name = POLICY_GLOBAL_CM
  } else if (body.scope === 'project' && isDnsLabel(body.project)) {
    namespace = body.project
    name = POLICY_CM
  } else {
    return Response.json({ error: 'invalid_scope', detail: 'scope must be "global", or "project" with a project name.' }, { status: 400 })
  }
  const id = await resolveIdentity(req)
  if (!id) return Response.json({ error: 'no_identity', detail: 'No cluster identity for your session — sign in again.' }, { status: 401 })
  const data = serializePolicy(v.value)
  const w = await writeConfigMap(id, namespace, name, POLICY_LABEL, (existing) => {
    const merged = { ...existing, ...data }
    return { data: merged, changed: JSON.stringify(Object.entries(existing ?? {}).sort()) !== JSON.stringify(Object.entries(merged).sort()) }
  })
  auditLine({ action: 'policy.save', user: actorOf(auth).label, namespace, name, ok: w.ok, detail: w.detail })
  return Response.json({ ok: w.ok, write: w, policy: v.value }, { status: w.ok ? 200 : 502 })
}

/* ───────────────────────────── waivers ───────────────────────────── */

async function maxDaysFor(id: K8sIdentity | null, project: string): Promise<number> {
  return (await effectivePolicy(id, project)).effective.maxWaiverDays
}

/**
 * May the caller request a waiver for `project`? RBAC `create scan-waivers` in
 * the project's namespace, AND membership: a reviewer, or someone the cluster
 * lets list pods there — a waiver is asked for by the people who run the code.
 */
async function isProjectMember(id: K8sIdentity | null, req: Request, project: string): Promise<{ ok: boolean; why?: string }> {
  if (!id) return { ok: false, why: 'No cluster identity for your session — sign in again.' }
  const can = await permissionsFor(req, {
    request: consoleCheck(CONSOLE_PERMISSIONS.waiverRequest, project),
    review: CONSOLE_PERMISSIONS.waiverApprove,
    member: { verb: 'list', group: '', resource: 'pods', namespace: project },
  }, { id })
  if (!can.request) return { ok: false, why: 'Requesting a waiver needs the Kubernetes RBAC permission "create scan-waivers.console.adhar.io".' }
  return can.review || can.member ? { ok: true } : { ok: false, why: `You are not a member of project ${project} (no access to its namespace).` }
}

type Notice = Pick<NotificationDoc, 'kind' | 'title' | 'description' | 'href' | 'key' | 'severity' | 'audience' | 'target'>

async function notify(store: Store, actor: Actor, doc: Notice): Promise<void> {
  await emitNotification(store, { ...doc, source: 'security', actor, at: new Date().toISOString() }, actor.id)
}

const waiverHref = (id: string, tab = 'waivers') => `/deliver?section=scans&tab=${tab}&waiver=${encodeURIComponent(id)}`
const label = (w: WaiverRecord) => `${w.findingId}${w.target.package ? ` in ${w.target.package}` : ''} (${w.scope === 'platform' ? 'platform' : w.target.app ? `${w.target.project}/${w.target.app}` : w.target.project})`

async function runSweep(req: Request, auth: Auth, store: Store, force = false): Promise<ConfigMapWrite[]> {
  const now = Date.now()
  const last = lastSweep.get(store.tenant) ?? 0
  if (!force && now - last < SWEEP_EVERY_MS) return []
  lastSweep.set(store.tenant, now)
  const all = (await store.list<WaiverRecord>(WAIVER_KIND)).map((d) => d.data)
  const { expire, warn } = sweep(all, now)
  const system: Actor = { id: 'system', label: 'expiry sweep' }
  const expired: WaiverRecord[] = []
  for (const w of expire) {
    const t = transition(w, 'expire', { actor: system, canApprove: false, platformAdmin: false, now, maxDays: 365 })
    if (!t.ok) continue
    await store.put(WAIVER_KIND, w.id, t.value, 'system')
    expired.push(t.value)
    if (w.status === 'approved') {
      await notify(store, system, {
        kind: 'warning',
        title: `Waiver expired: ${label(w)}`,
        description: 'The finding counts against the scan gate again unless a new waiver is approved.',
        href: waiverHref(w.id),
        key: `waiver-expired:${w.id}`,
        audience: [w.requestedBy.id, ...(w.approvedBy ? [w.approvedBy.id] : [])],
        target: { type: 'waiver', id: w.id, label: w.findingId },
      })
    }
  }
  for (const w of warn) {
    const days = Math.max(0, Math.ceil((Date.parse(w.expiresAt) - now) / 86_400_000))
    await notify(store, system, {
      kind: 'warning',
      severity: w.severity === 'critical' || w.severity === 'high' ? 'high' : 'medium',
      title: `Waiver expires in ${days} day${days === 1 ? '' : 's'}: ${label(w)}`,
      description: 'Fix the finding, or extend the waiver (which goes back to review).',
      href: waiverHref(w.id),
      key: `waiver-expiring:${w.id}`,
      audience: [w.requestedBy.id, ...(w.approvedBy ? [w.approvedBy.id] : [])],
      target: { type: 'waiver', id: w.id, label: w.findingId },
    })
    await store.put(WAIVER_KIND, w.id, { ...w, expiryNotifiedAt: new Date(now).toISOString() }, 'system')
  }
  // Only approved → expired changes what is rendered. Trivy also honours
  // `expired_at`, so a write refused here still stops applying on time.
  const scopes = affectedScopes(expired.filter((w) => w.history.at(-1)?.from === 'approved'))
  if (!scopes.projects.length && !scopes.global) return []
  const writes = await syncScopes(await resolveIdentity(req), store, scopes, now)
  auditLine({ action: 'sweep', user: actorOf(auth).label, expired: expired.map((w) => w.id), writes })
  return writes
}

async function listWaivers(req: Request, auth: Auth, store: Store): Promise<Response> {
  const sweepWrites = await runSweep(req, auth, store, new URL(req.url).searchParams.get('sweep') === '1')
  const project = new URL(req.url).searchParams.get('project')
  const now = Date.now()
  const docs = await store.list<WaiverRecord>(WAIVER_KIND)
  const items = docs
    .map((d) => d.data)
    .filter((w) => !project || w.target.project === project || w.scope === 'platform')
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
  return Response.json({
    items,
    counts: {
      requested: items.filter((w) => w.status === 'requested').length,
      active: items.filter((w) => isActive(w, now)).length,
      expiringSoon: items.filter((w) => isExpiringSoon(w, now)).length,
    },
    sweep: sweepWrites,
    me: await caps(req, auth),
    now: new Date(now).toISOString(),
  })
}

async function createWaiver(req: Request, auth: Auth, store: Store): Promise<Response> {
  const body = await readBody<Record<string, unknown>>(req)
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 })
  const id = await resolveIdentity(req)
  const project = (body.target as { project?: unknown } | undefined)?.project
  if (!isDnsLabel(project)) return Response.json({ error: 'invalid_project', detail: 'target.project must be the project (its namespace name).' }, { status: 400 })
  const member = await isProjectMember(id, req, project)
  if (!member.ok) return Response.json({ error: 'forbidden', detail: member.why }, { status: 403 })
  const now = Date.now()
  const maxDays = await maxDaysFor(id, project)
  const v = validateWaiverRequest(body, now, maxDays)
  if (!v.ok) return Response.json({ error: v.error, detail: v.detail }, { status: v.status })
  const actor = actorOf(auth)

  // One open request per finding and target: a second one is a duplicate the
  // reviewer would have to reject by hand.
  const open = (await store.list<WaiverRecord>(WAIVER_KIND)).map((d) => d.data).find((w) =>
    w.status === 'requested' && w.kind === v.value.kind && w.findingId === v.value.findingId && w.scope === v.value.scope &&
    w.target.project === v.value.target.project && (w.target.app ?? '') === (v.value.target.app ?? '') &&
    (w.target.digest ?? '') === (v.value.target.digest ?? '') && (w.target.package ?? '') === (v.value.target.package ?? '')
  )
  if (open) return Response.json({ error: 'duplicate', detail: `An identical request is already waiting for review (${open.id}).`, id: open.id }, { status: 409 })

  const wid = `wv-${now.toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const rec = newWaiver(wid, v.value, actor, now, typeof body.comment === 'string' ? body.comment : undefined)
  await store.put(WAIVER_KIND, wid, rec, actor.id)
  auditLine({ action: 'request', user: actor.label, waiver: wid, findingId: rec.findingId, scope: rec.scope, project: rec.target.project })
  // Reviewers are not enumerable from here, so a request reaches the tenant's feed.
  await notify(store, actor, {
    kind: 'info',
    severity: rec.severity === 'critical' ? 'critical' : rec.severity === 'high' ? 'high' : 'medium',
    title: `Waiver requested: ${label(rec)}`,
    description: `${actor.label}: ${rec.justification.slice(0, 280)}`,
    href: waiverHref(wid, 'review'),
    target: { type: 'waiver', id: wid, label: rec.findingId },
  })
  return Response.json({ ok: true, item: rec }, { status: 201 })
}

interface ActionBody {
  comment?: string
  selfApproveReason?: string
  expiresAt?: string
  justification?: string
}

const ACTIONS = new Set<WaiverAction>(['approve', 'reject', 'revoke', 'withdraw', 'comment', 'extend'])

/** Apply one action to one waiver, persist, and return what to re-render. */
async function applyAction(
  req: Request,
  auth: Auth,
  store: Store,
  wid: string,
  action: WaiverAction,
  body: ActionBody,
  now: number,
): Promise<{ ok: true; item: WaiverRecord; touched: WaiverRecord[]; created?: WaiverRecord } | { ok: false; status: number; error: string; detail: string }> {
  const doc = await store.get<WaiverRecord>(WAIVER_KIND, wid)
  if (!doc) return { ok: false, status: 404, error: 'not_found', detail: `No waiver ${wid}.` }
  const rec = doc.data
  const actor = actorOf(auth)
  const id = await resolveIdentity(req)

  if (action === 'extend') {
    // An extension is a NEW request that goes through review again; the
    // current waiver keeps applying until the new one is approved.
    if (rec.status !== 'approved' && rec.status !== 'expired') return { ok: false, status: 409, error: 'invalid_transition', detail: `A ${rec.status} waiver cannot be extended.` }
    if (rec.supersededBy) return { ok: false, status: 409, error: 'already_extended', detail: `An extension (${rec.supersededBy}) already exists.` }
    const member = await isProjectMember(id, req, rec.target.project)
    if (!member.ok) return { ok: false, status: 403, error: 'forbidden', detail: member.why ?? 'forbidden' }
    const maxDays = await maxDaysFor(id, rec.target.project)
    const v = validateWaiverRequest({ ...rec, justification: body.justification?.trim() || rec.justification, expiresAt: body.expiresAt }, now, maxDays)
    if (!v.ok) return v
    const nid = `wv-${now.toString(36)}-${crypto.randomUUID().slice(0, 6)}`
    const created = { ...newWaiver(nid, { ...v.value, supersedes: rec.id }, actor, now, body.comment ?? `Extension of ${rec.id}`) }
    const old: WaiverRecord = { ...rec, supersededBy: nid, history: [...rec.history, { at: new Date(now).toISOString(), by: actor, action: 'extend', comment: `Extension requested as ${nid}${body.comment ? ` — ${body.comment}` : ''}` }] }
    await store.put(WAIVER_KIND, nid, created, actor.id)
    await store.put(WAIVER_KIND, rec.id, old, actor.id)
    return { ok: true, item: old, touched: [], created }
  }

  const maxDays = action === 'approve' ? await maxDaysFor(id, rec.target.project) : 365
  const can = await permissionsFor(req, {
    approve: CONSOLE_PERMISSIONS.waiverApprove,
    selfApprove: CONSOLE_PERMISSIONS.waiverSelfApprove,
  }, { id })
  const ctx: TransitionCtx = {
    actor,
    canApprove: can.approve,
    platformAdmin: can.selfApprove,
    now,
    comment: body.comment,
    selfApproveReason: body.selfApproveReason,
    maxDays,
  }
  const t = transition(rec, action, ctx)
  if (!t.ok) return t
  const touched: WaiverRecord[] = []
  let item = t.value
  if (action === 'approve' || action === 'revoke') touched.push(item)
  // Approving an extension retires the waiver it replaces.
  if (action === 'approve' && item.supersedes) {
    const prev = await store.get<WaiverRecord>(WAIVER_KIND, item.supersedes)
    if (prev && prev.data.status === 'approved') {
      const s = transition(prev.data, 'supersede', { ...ctx, comment: `Superseded by ${item.id}` })
      if (s.ok) {
        await store.put(WAIVER_KIND, prev.id, { ...s.value, supersededBy: item.id }, actor.id)
        touched.push(s.value)
      }
    }
  }
  // A rejected or withdrawn extension frees the original for another try.
  if ((action === 'reject' || action === 'withdraw') && item.supersedes) {
    const prev = await store.get<WaiverRecord>(WAIVER_KIND, item.supersedes)
    if (prev && prev.data.supersededBy === item.id) {
      const { supersededBy: _drop, ...rest } = prev.data
      await store.put(WAIVER_KIND, prev.id, rest as WaiverRecord, actor.id)
    }
  }
  await store.put(WAIVER_KIND, item.id, item, actor.id)
  item = { ...item }
  return { ok: true, item, touched }
}

async function decisionNotice(store: Store, auth: Auth, item: WaiverRecord, action: WaiverAction): Promise<void> {
  const actor = actorOf(auth)
  if (action === 'comment') {
    const audience = [...new Set([item.requestedBy.id, ...(item.approvedBy ? [item.approvedBy.id] : [])])].filter((x) => x !== actor.id)
    if (!audience.length) return
    await notify(store, actor, { kind: 'info', title: `New comment on waiver: ${label(item)}`, description: item.history.at(-1)?.comment?.slice(0, 280), href: waiverHref(item.id), audience, target: { type: 'waiver', id: item.id, label: item.findingId } })
    return
  }
  if (action === 'extend' || item.requestedBy.id === actor.id) return
  const verb = { approve: 'approved', reject: 'rejected', revoke: 'revoked', withdraw: 'withdrawn' }[action as string]
  if (!verb) return
  await notify(store, actor, {
    kind: action === 'approve' ? 'success' : 'warning',
    title: `Waiver ${verb}: ${label(item)}`,
    description: item.history.at(-1)?.comment ? `${actor.label}: ${item.history.at(-1)!.comment!.slice(0, 280)}` : `by ${actor.label}`,
    href: waiverHref(item.id),
    audience: [item.requestedBy.id],
    target: { type: 'waiver', id: item.id, label: item.findingId },
  })
}

async function act(req: Request, auth: Auth, store: Store, wid: string, rawAction: string): Promise<Response> {
  const action = rawAction as WaiverAction
  if (!ACTIONS.has(action)) return Response.json({ error: 'invalid_action', detail: `Unknown action ${rawAction}.` }, { status: 400 })
  const body = (await readBody<ActionBody>(req)) ?? {}
  const now = Date.now()
  const r = await applyAction(req, auth, store, wid, action, body, now)
  if (!r.ok) return Response.json({ error: r.error, detail: r.detail }, { status: r.status })
  const writes = await syncScopes(r.touched.length ? await resolveIdentity(req) : null, store, affectedScopes(r.touched), now)
  let item = r.item
  const note = syncNote(writes, now)
  if (note) {
    item = { ...item, sync: note }
    await store.put(WAIVER_KIND, item.id, item, actorOf(auth).id)
  }
  auditLine({ action, user: actorOf(auth).label, waiver: wid, status: item.status, created: r.created?.id, writes })
  await decisionNotice(store, auth, r.created ?? item, action)
  if (r.created) {
    await notify(store, actorOf(auth), {
      kind: 'info',
      title: `Waiver extension requested: ${label(r.created)}`,
      description: `Until ${r.created.expiresAt.slice(0, 10)} — needs review.`,
      href: waiverHref(r.created.id, 'review'),
      target: { type: 'waiver', id: r.created.id, label: r.created.findingId },
    })
  }
  return Response.json({ ok: true, item, created: r.created, writes })
}

async function bulk(req: Request, auth: Auth, store: Store): Promise<Response> {
  const body = await readBody<ActionBody & { ids?: unknown; action?: unknown }>(req)
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 })
  const action = body.action as WaiverAction
  if (action !== 'approve' && action !== 'reject' && action !== 'revoke') {
    return Response.json({ error: 'invalid_action', detail: 'Bulk actions are approve, reject and revoke.' }, { status: 400 })
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string').slice(0, 200) : []
  if (!ids.length) return Response.json({ error: 'missing_ids' }, { status: 400 })
  const now = Date.now()
  const results: Array<{ id: string; ok: boolean; status?: WaiverRecord['status']; detail?: string }> = []
  const touched: WaiverRecord[] = []
  for (const wid of ids) {
    const r = await applyAction(req, auth, store, wid, action, body, now)
    if (r.ok) {
      results.push({ id: wid, ok: true, status: r.item.status })
      touched.push(...r.touched)
      await decisionNotice(store, auth, r.item, action)
    } else {
      results.push({ id: wid, ok: false, detail: r.detail })
    }
  }
  const writes = await syncScopes(touched.length ? await resolveIdentity(req) : null, store, affectedScopes(touched), now)
  const note = syncNote(writes, now)
  if (note) {
    for (const w of touched) {
      const d = await store.get<WaiverRecord>(WAIVER_KIND, w.id)
      if (d) await store.put(WAIVER_KIND, w.id, { ...d.data, sync: note }, actorOf(auth).id)
    }
  }
  auditLine({ action: `bulk.${action}`, user: actorOf(auth).label, results, writes })
  return Response.json({ ok: results.every((r) => r.ok), results, writes })
}

async function resync(req: Request, auth: Auth, store: Store): Promise<Response> {
  const denied = await requirePermission(req, CONSOLE_PERMISSIONS.waiverApprove)
  if (denied) return denied
  const body = (await readBody<{ project?: unknown; global?: unknown }>(req)) ?? {}
  const now = Date.now()
  await runSweep(req, auth, store, true)
  let scopes: { projects: string[]; global: boolean }
  if (isDnsLabel(body.project)) scopes = { projects: [body.project], global: body.global === true }
  else if (body.global === true) scopes = { projects: [], global: true }
  else {
    // Everything that has ever had an approved waiver, so revoked ones are removed too.
    const all = (await store.list<WaiverRecord>(WAIVER_KIND)).map((d) => d.data).filter((w) => w.approvedAt)
    scopes = affectedScopes(all)
  }
  const writes = await syncScopes(await resolveIdentity(req), store, scopes, now)
  auditLine({ action: 'sync', user: actorOf(auth).label, writes })
  return Response.json({ ok: writes.every((w) => w.ok), writes })
}

/* ───────────────────────────── the scan gate ───────────────────────────── */

const RUNS_V1 = '/apis/tekton.dev/v1'
const RUNS_V1BETA1 = '/apis/tekton.dev/v1beta1'

async function fetchRuns(id: K8sIdentity, path: string): Promise<Response> {
  const r = await apiServerFetch(id, `${RUNS_V1}${path}`)
  if (r.status !== 404) return r
  await r.body?.cancel()
  return apiServerFetch(id, `${RUNS_V1BETA1}${path}`)
}

async function listGates(req: Request, auth: Auth): Promise<Response> {
  const id = await resolveIdentity(req)
  const me = await caps(req, auth)
  if (!id) return Response.json({ items: [], state: 'error', detail: 'No cluster identity for your session — sign in again.', me })
  const p = new URL(req.url).searchParams
  const ns = p.get('namespace')
  const name = p.get('name')
  if (ns && name) {
    if (!isDnsLabel(ns)) return Response.json({ error: 'invalid_namespace' }, { status: 400 })
    const r = await fetchRuns(id, `/namespaces/${encodeURIComponent(ns)}/pipelineruns/${encodeURIComponent(name)}`)
    if (!r.ok) return Response.json({ items: [], state: r.status === 403 ? 'forbidden' : r.status === 404 ? 'absent' : 'error', detail: await readErr(r), me })
    return Response.json({ items: [gateOf(await r.json())], state: 'ok', me })
  }
  const path = ns && isDnsLabel(ns) ? `/namespaces/${encodeURIComponent(ns)}/pipelineruns` : '/pipelineruns'
  const r = await apiServerFetch(id, `${RUNS_V1}${path}`, { search: '?limit=500' })
  if (!r.ok) {
    const detail = await readErr(r)
    return Response.json({ items: [], state: r.status === 403 ? 'forbidden' : r.status === 404 ? 'absent' : 'error', detail, me })
  }
  const list = (await r.json()) as { items?: unknown[] }
  const items: GateView[] = (list.items ?? []).map((x) => gateOf(x as Parameters<typeof gateOf>[0])).filter(hasScanSignal)
  items.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return Response.json({ items: items.slice(0, 300), state: 'ok', me })
}

interface GateBody {
  namespace?: unknown
  name?: unknown
  decision?: unknown
  comment?: unknown
  project?: unknown
  waiver?: {
    findings?: Array<{ findingId?: unknown; package?: unknown; purl?: unknown; severity?: unknown; kind?: unknown; version?: unknown }>
    expiresAt?: unknown
    justification?: unknown
    vex?: unknown
  }
}

async function decideGate(req: Request, auth: Auth): Promise<Response> {
  const denied = await requirePermission(req, CONSOLE_PERMISSIONS.waiverApprove)
  if (denied) return denied
  const body = await readBody<GateBody>(req)
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 })
  const { namespace, name } = body
  if (!isDnsLabel(namespace) || typeof name !== 'string' || !/^[a-z0-9][-a-z0-9.]{0,252}$/.test(name)) {
    return Response.json({ error: 'invalid_run', detail: 'namespace and name of the PipelineRun are required.' }, { status: 400 })
  }
  const decision = body.decision
  if (decision !== 'approved' && decision !== 'rejected') return Response.json({ error: 'invalid_decision', detail: 'decision must be approved or rejected.' }, { status: 400 })
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 1000) : ''
  if (!comment) return Response.json({ error: 'missing_comment', detail: 'Record why the gate is approved or rejected.' }, { status: 400 })
  const id = await resolveIdentity(req)
  if (!id) return Response.json({ error: 'no_identity', detail: 'No cluster identity for your session — sign in again.' }, { status: 401 })

  const runPath = `/namespaces/${encodeURIComponent(namespace)}/pipelineruns/${encodeURIComponent(name)}`
  const cur = await fetchRuns(id, runPath)
  if (!cur.ok) return Response.json({ error: 'run_unavailable', detail: `${cur.status} ${await readErr(cur)}` }, { status: cur.status === 404 ? 404 : cur.status === 403 ? 403 : 502 })
  const gate = gateOf(await cur.json())
  if (gate.state !== 'awaiting') {
    return Response.json({ error: 'not_awaiting', detail: gate.decision ? `This run was already ${gate.decision.value}${gate.decision.by ? ` by ${gate.decision.by}` : ''}.` : 'This run is not waiting for a scan approval.' }, { status: 409 })
  }

  // Prepare the waivers BEFORE touching the run, so a bad waiver body does not
  // leave a decided run with no record of what was accepted.
  const actor = actorOf(auth)
  const now = Date.now()
  const project = isDnsLabel(body.project) ? body.project : namespace
  const waivers: WaiverRecord[] = []
  if (decision === 'approved' && body.waiver?.findings?.length) {
    if (!gate.digest || !gate.app) {
      return Response.json({ error: 'no_digest', detail: 'This run did not publish the image digest and app, so a digest-scoped waiver cannot be created. Approve without one.' }, { status: 400 })
    }
    const maxDays = await maxDaysFor(id, project)
    for (const f of body.waiver.findings.slice(0, 200)) {
      const v = validateWaiverRequest({
        kind: typeof f.kind === 'string' ? f.kind : 'vuln',
        scope: 'digest',
        target: { project, app: gate.app, digest: gate.digest, image: gate.image, package: f.package, purl: f.purl, version: f.version },
        findingId: f.findingId,
        severity: f.severity,
        justification: body.waiver.justification,
        vex: body.waiver.vex,
        expiresAt: body.waiver.expiresAt,
        source: { pipelineRun: `${namespace}/${name}` },
      }, now, maxDays)
      if (!v.ok) return Response.json({ error: v.error, detail: `${String(f.findingId)}: ${v.detail}` }, { status: v.status })
      const wid = `wv-${now.toString(36)}-${crypto.randomUUID().slice(0, 6)}`
      const rec = newWaiver(wid, v.value, actor, now, `Accepted at the manual scan gate of ${namespace}/${name}`)
      const at = new Date(now).toISOString()
      // Deciding the gate IS the review — by someone holding a reviewer role.
      waivers.push({ ...rec, status: 'approved', approvedBy: actor, approvedAt: at, decidedBy: actor, decidedAt: at, history: [...rec.history, { at, by: actor, action: 'approve', from: 'requested', to: 'approved', comment }] })
    }
  }

  const patch = await apiServerFetch(id, `${RUNS_V1}${runPath}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify(gateDecisionPatch(decision, actor.label, new Date(now).toISOString(), comment)),
  })
  if (!patch.ok) {
    const why = await readErr(patch)
    auditLine({ action: `gate.${decision}`, user: actor.label, run: `${namespace}/${name}`, ok: false, detail: why })
    return Response.json({ error: 'patch_failed', detail: patch.status === 403 ? `Your account may not update PipelineRuns in ${namespace} (${why})` : `${patch.status} ${why}` }, { status: patch.status === 403 ? 403 : 502 })
  }
  await patch.body?.cancel()

  const store = await openStore(auth.activeTenant)
  let writes: ConfigMapWrite[] = []
  if (store) {
    await store.put(GATE_DECISION_KIND, crypto.randomUUID(), {
      run: `${namespace}/${name}`,
      app: gate.app,
      digest: gate.digest,
      summary: gate.summary,
      decision,
      comment,
      by: actor,
      at: new Date(now).toISOString(),
      waivers: waivers.map((w) => w.id),
    }, actor.id)
    for (const w of waivers) await store.put(WAIVER_KIND, w.id, w, actor.id)
    if (waivers.length) writes = await syncScopes(id, store, affectedScopes(waivers), now)
    await notify(store, actor, {
      kind: decision === 'approved' ? 'success' : 'warning',
      title: `Scan gate ${decision}: ${gate.app ?? name}`,
      description: `${actor.label}: ${comment.slice(0, 280)}`,
      href: `/deliver?section=scans&tab=review`,
      target: { type: 'pipelinerun', id: `${namespace}/${name}`, label: name },
    })
  }
  auditLine({ action: `gate.${decision}`, user: actor.label, run: `${namespace}/${name}`, ok: true, waivers: waivers.map((w) => w.id), writes })
  return Response.json({
    ok: true,
    decision,
    waivers,
    writes,
    persisted: Boolean(store),
  })
}
