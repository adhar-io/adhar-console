import { CONSOLE_PERMISSIONS } from '@adhar/auth/server'
import type { ConsolePermission } from '@adhar/auth/server'
import { requirePermission } from './k8s/access.ts'
import { apiServerFetch, audit, canI, type K8sIdentity, originOk, resolveIdentity } from './k8s/gateway.ts'
import { getRequestUser, unauthorized } from './request-user.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import { requestArgoRefresh } from './appset.ts'
import { openStore, writeAudit } from './workspace/store.ts'
import { actorName, safePath } from './scorecard-fix-model.ts'
import { APPLICATION_GVR, CONTROL_PLANE_NAMESPACE } from '../data/catalog-custom-apps.ts'
import {
  changeWarnings,
  confirmReason,
  currentIntent,
  describeChange,
  hpaView,
  type RolloutMode,
  scaledObjectFor,
  sameIntent,
  scalerFor,
  type ScalingIntent,
  validateIntent,
} from '../data/catalog-scaling-model.ts'
import type { KObj } from '../data/catalog-composition-model.ts'
import {
  declaredIntent,
  findHpaName,
  kustomizeInputs,
  type OverlayFiles,
  PATCH_FILE,
  planFiles,
  planFingerprint,
  readPatchFile,
  renderedReplicas,
  RESOURCE_FILE,
  resolveRepoPath,
  type WorkloadRef,
} from './scaling-gitops.ts'

/**
 * `/api/catalog/scaling` — instances and autoscaling of one application in one
 * environment, changed the GitOps way (see `data/catalog-scaling-model.ts` for
 * why a live patch would be a lie, and `scaling-gitops.ts` for the files).
 *
 *   GET  ?app=&env=           what the overlay declares, and whether the
 *                             console can manage it
 *   POST {app, env, intent, dryRun: true}
 *                             the plan: the files before/after, the one-line
 *                             change, warnings, whether it needs a typed
 *                             confirmation, and how it will roll out
 *   POST {app, env, intent, fingerprint, confirm?}
 *                             commit it to the overlay (`[skip ci]` — no
 *                             rebuild), then roll it out as the user: a Kargo
 *                             Promotion of the freight already in the
 *                             environment, which re-renders the overlay
 *   POST /settle {app, env}   once the rollout landed, set the count Git now
 *                             declares on the workload when Argo CD is ignoring
 *                             it (the autoscaler wrote it last)
 *
 * Who may: `update application-scaling.console.adhar.io` IN the environment's
 * namespace (the commit uses the console's Gitea credentials, so the console
 * must ask). Everything that touches the cluster — reading the Application,
 * the workload and its autoscaler, creating the Promotion, the scale write —
 * runs AS the user through the k8s gateway, so their RBAC applies too.
 */

/* ─────────── dependencies (injected by the tests) ─────────── */

type GiteaFetch = (path: string, init?: RequestInit) => Promise<Response>
type K8sCall = (id: K8sIdentity, path: string, init?: { method?: string; body?: string; headers?: Record<string, string>; search?: string }) => Promise<Response>

export interface ScalingDeps {
  user(req: Request): Promise<{ user: { id: string; name: string; email?: string; username?: string }; activeTenant: string; refreshedCookie?: string } | null>
  identity(req: Request): Promise<K8sIdentity | null>
  k8s: K8sCall
  permit(req: Request, perm: ConsolePermission, namespace: string, id: K8sIdentity): Promise<Response | null>
  can(id: K8sIdentity, attrs: { verb: string; group: string; resource: string; namespace: string }): Promise<boolean>
  gitea(): GiteaFetch | null
  refreshArgo(namespace: string, app: string, id: K8sIdentity): Promise<unknown>
  record(tenant: string, actor: { id: string; name: string }, action: string, target: { type: string; id: string; label: string }, req: Request, meta: Record<string, unknown>, outcome: 'success' | 'failure'): Promise<void>
  log(entry: Record<string, unknown>): void
}

const realDeps: ScalingDeps = {
  user: (req) => getRequestUser(req) as ReturnType<ScalingDeps['user']>,
  identity: resolveIdentity,
  k8s: (id, path, init) => apiServerFetch(id, path, init),
  permit: (req, perm, namespace, id) => requirePermission(req, perm, { namespace, id }),
  can: async (id, attrs) => (await canI(id, attrs)).allowed,
  gitea: () => {
    const c = giteaConn()
    return c ? giteaFetcher(c) : null
  },
  refreshArgo: (namespace, app, id) => requestArgoRefresh(namespace, app, [id]),
  record: async (tenant, actor, action, target, req, meta, outcome) => {
    const store = await openStore(tenant).catch(() => null)
    if (store) await writeAudit(store, actor, action, target, req, meta, outcome)
  },
  log: audit,
}

/* ─────────── helpers ─────────── */

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, detail: string) {
    super(detail)
  }
}

function json(body: unknown, status: number, cookie?: string): Response {
  const res = Response.json(body, { status })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

const NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function decode(content: string): string {
  const bin = atob(content.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

async function readErr(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { message?: string }
    return (j.message ?? t).slice(0, 300)
  } catch {
    return t.slice(0, 300)
  }
}

/** `http://gitea-http…/adhar/reactapp.git` / `https://gitea.x/adhar/reactapp` → adhar/reactapp. */
export function giteaRepoOf(url: string | undefined): { org: string; repo: string } | undefined {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec((url ?? '').trim())
  return m ? { org: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]) } : undefined
}

/* ─────────── what the request is about ─────────── */

interface Ctx {
  app: string
  env: string
  namespace: string
  stage: string
  argoApp?: string
  promote: boolean
  kargoProject?: string
  repo: { org: string; repo: string }
  branch: string
  dir: string
  workload: WorkloadRef & { desired: number }
  hpa?: KObj
  keda?: string
}

type Dict = Record<string, unknown>
const dict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? v as Dict : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

async function getJson(deps: ScalingDeps, id: K8sIdentity, path: string): Promise<{ status: number; body?: Dict }> {
  const r = await deps.k8s(id, path)
  if (!r.ok) {
    await r.body?.cancel()
    return { status: r.status }
  }
  return { status: r.status, body: (await r.json()) as Dict }
}

const WORKLOADS = [
  { kind: 'Rollout' as const, base: '/apis/argoproj.io/v1alpha1', resource: 'rollouts' },
  { kind: 'Deployment' as const, base: '/apis/apps/v1', resource: 'deployments' },
]

async function resolve(deps: ScalingDeps, id: K8sIdentity, app: string, env: string): Promise<Ctx> {
  const xrPath = `/apis/${APPLICATION_GVR.group}/${APPLICATION_GVR.version}/namespaces/${CONTROL_PLANE_NAMESPACE}/${APPLICATION_GVR.resource}/${encodeURIComponent(app)}`
  const xr = await getJson(deps, id, xrPath)
  if (xr.status === 404) throw new Refusal(404, 'not_found', `Application ${app} not found.`)
  if (xr.status === 403) throw new Refusal(403, 'forbidden', `You cannot read application ${app}.`)
  if (!xr.body) throw new Refusal(502, 'cluster_unavailable', `Reading application ${app} failed (HTTP ${xr.status}).`)
  const params = dict(dict(xr.body.spec).parameters)
  const type = str(params.type) ?? 'service'
  if (type === 'function' || type === 'batch') {
    throw new Refusal(409, 'not_scalable', type === 'function'
      ? 'Functions scale on demand (Knative): their concurrency and scale bounds live in the overlay, not in an instance count.'
      : 'Batch applications run to completion; they have no instances to scale.')
  }
  const status = dict(xr.body.status)
  const envs = Array.isArray(status.environments) ? status.environments.map(dict) : []
  const e = envs.find((x) => x.name === env)
  if (!e) throw new Refusal(404, 'env_not_found', `${app} has no environment ${env}.`)
  const namespace = str(e.namespace)
  if (!namespace) throw new Refusal(409, 'env_not_ready', `${app}'s ${env} environment has no namespace yet.`)
  const delivery = dict(status.delivery)
  const source = dict(params.source)
  const repo = giteaRepoOf(str(delivery.repoURL) ?? str(source.repoURL))
  if (!repo) throw new Refusal(409, 'no_repository', `${app} is not deployed from a Gitea repository the console can write to.`)
  const path = (str(delivery.path) ?? str(source.path) ?? 'deploy').replace(/^\/+|\/+$/g, '')
  // The commit is made with the console's Gitea credentials: only ever into a
  // plain overlay directory, never a CI definition (see scorecard-fix.ts).
  if (!safePath(`${path}/envs/${env}`) || /^(\.gitea|\.github|\.forgejo|\.tekton|\.woodpecker|\.circleci)(\/|$)/i.test(path)) {
    throw new Refusal(409, 'overlay_unsupported', `${app}'s deploy path ${path} is not an overlay directory the console writes to.`)
  }
  const kargoProject = str(delivery.kargoProject)

  // The workload: a Rollout named for the application, else a Deployment.
  let workload: Ctx['workload'] | undefined
  for (const w of WORKLOADS) {
    const r = await getJson(deps, id, `${w.base}/namespaces/${encodeURIComponent(namespace)}/${w.resource}/${encodeURIComponent(app)}`)
    if (r.status === 403) throw new Refusal(403, 'forbidden', `You cannot read ${w.resource} in ${namespace}.`)
    if (r.body) {
      const spec = dict(r.body.spec)
      workload = { kind: w.kind, name: app, desired: typeof spec.replicas === 'number' ? spec.replicas : 1 }
      break
    }
  }
  if (!workload) throw new Refusal(409, 'not_running', `${app} is not running in ${env} yet — scale it once it has been promoted there.`)

  const hpas = await getJson(deps, id, `/apis/autoscaling/v2/namespaces/${encodeURIComponent(namespace)}/horizontalpodautoscalers`)
  const items = (b?: Dict) => (Array.isArray(b?.items) ? b.items as KObj[] : []).map((o) => ({ ...o, metadata: { ...o.metadata, namespace: o.metadata?.namespace ?? namespace } }))
  const hpa = scalerFor(items(hpas.body), { kind: workload.kind, name: workload.name, namespace })
  const so = await getJson(deps, id, `/apis/keda.sh/v1alpha1/namespaces/${encodeURIComponent(namespace)}/scaledobjects`)
  const keda = scaledObjectFor(items(so.body), { kind: workload.kind, name: workload.name, namespace })?.metadata.name ??
    (hpa ? hpaView(hpa).keda : undefined)

  return {
    app,
    env,
    namespace,
    stage: str(e.stage) ?? env,
    ...(str(e.argoApplication) ? { argoApp: str(e.argoApplication) } : {}),
    promote: delivery.promote !== false && Boolean(kargoProject),
    ...(kargoProject ? { kargoProject } : {}),
    repo,
    branch: str(delivery.targetRevision) ?? str(source.targetRevision) ?? 'main',
    dir: `${path}/envs/${env}`,
    workload,
    ...(hpa ? { hpa } : {}),
    ...(keda ? { keda } : {}),
  }
}

/* ─────────── the overlay in Gitea ─────────── */

interface RepoFile {
  text: string
  sha: string
}

async function readFile(gitea: GiteaFetch, ctx: Pick<Ctx, 'repo'>, path: string, ref: string): Promise<RepoFile | null> {
  const r = await gitea(`/repos/${encodeURIComponent(ctx.repo.org)}/${encodeURIComponent(ctx.repo.repo)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`)
  if (r.status === 404) {
    await r.body?.cancel()
    return null
  }
  if (!r.ok) throw new Refusal(502, 'gitea_unavailable', `Gitea: reading ${path} failed (${r.status} ${await readErr(r)})`)
  const body = (await r.json()) as { content?: string; encoding?: string; sha?: string; type?: string }
  if (Array.isArray(body) || (body.type && body.type !== 'file')) return null
  return { text: body.content ? (body.encoding === 'base64' ? decode(body.content) : body.content) : '', sha: body.sha ?? '' }
}

async function readKustomization(gitea: GiteaFetch, ctx: Pick<Ctx, 'repo'>, dir: string, ref: string): Promise<(RepoFile & { path: string }) | null> {
  for (const name of ['kustomization.yaml', 'kustomization.yml', 'Kustomization']) {
    const f = await readFile(gitea, ctx, `${dir}/${name}`, ref)
    if (f) return { ...f, path: `${dir}/${name}` }
  }
  return null
}

/**
 * The autoscaler the overlay's inputs define for the workload — base,
 * components, the overlay's own files — leaving out the console's
 * `autoscaler.yaml`. `'unknown'` when an input cannot be read (a remote base).
 */
async function inputHpa(gitea: GiteaFetch, ctx: Ctx, dir: string, kz: string, top: boolean, budget: { files: number }): Promise<string | undefined | 'unknown'> {
  const inputs = kustomizeInputs(kz)
  let unknown = false
  for (const entry of [...inputs.resources, ...inputs.components]) {
    if (top && entry.replace(/^\.\//, '') === RESOURCE_FILE) continue
    if (--budget.files < 0) return 'unknown'
    const p = resolveRepoPath(dir, entry)
    if (!p) {
      unknown = true
      continue
    }
    if (/\.(ya?ml|json)$/i.test(p)) {
      const f = await readFile(gitea, ctx, p, ctx.branch)
      const name = f ? findHpaName(f.text, ctx.workload) : undefined
      if (name) return name
      continue
    }
    const k = await readKustomization(gitea, ctx, p, ctx.branch)
    if (!k) {
      unknown = true
      continue
    }
    const found = await inputHpa(gitea, ctx, p, k.text, false, budget)
    if (found === 'unknown') unknown = true
    else if (found) return found
  }
  return unknown ? 'unknown' : undefined
}

interface Overlay {
  files: OverlayFiles
  declared?: ScalingIntent
}

async function readOverlay(gitea: GiteaFetch, ctx: Ctx): Promise<Overlay> {
  const kz = await readKustomization(gitea, ctx, ctx.dir, ctx.branch)
  if (!kz) {
    throw new Refusal(409, 'no_overlay', `${ctx.repo.org}/${ctx.repo.repo}@${ctx.branch} has no kustomize overlay at ${ctx.dir} — the console scales applications deployed from deploy/envs/<env> overlays.`)
  }
  const inputs = kustomizeInputs(kz.text)
  if (inputs.helm) throw new Refusal(409, 'overlay_unsupported', `${kz.path} renders a Helm chart; set replicas and autoscaling in its values instead.`)
  if (inputs.renames) throw new Refusal(409, 'overlay_unsupported', `${kz.path} renames resources (namePrefix/nameSuffix); the console cannot patch them safely.`)
  const patch = await readFile(gitea, ctx, `${ctx.dir}/${PATCH_FILE}`, ctx.branch)
  const resource = await readFile(gitea, ctx, `${ctx.dir}/${RESOURCE_FILE}`, ctx.branch)
  const files: OverlayFiles = { dir: ctx.dir, kustomization: kz, ...(patch ? { patch } : {}), ...(resource ? { resource } : {}) }
  const declared = patch ? declaredIntent(readPatchFile(patch.text, ctx.workload), Boolean(resource)) : undefined
  return { files, ...(declared ? { declared } : {}) }
}

/* ─────────── rolling it out ─────────── */

interface Rollout {
  mode: RolloutMode
  reason?: string
  freight?: string
}

/** THIS application's freight in the environment's stage (shared stage: keyed by its warehouse). */
export function appFreight(stage: Dict, app: string): string | undefined {
  const st = dict(stage.status)
  const items = dict((Array.isArray(st.freightHistory) ? dict(st.freightHistory[0]) : {}).items)
  for (const [key, raw] of Object.entries(items)) {
    const item = dict(raw)
    const origin = str(dict(item.origin).name) ?? (key.includes('/') ? key.slice(key.indexOf('/') + 1) : key)
    if (origin === app && str(item.name)) return str(item.name)
  }
  // A per-app stage (`<app>-<env>`) carries only this app's freight.
  return str(dict(st.currentFreight).name)
}

async function planRollout(deps: ScalingDeps, id: K8sIdentity, ctx: Ctx): Promise<Rollout> {
  if (!ctx.promote || !ctx.kargoProject) return { mode: 'argo' }
  const stage = await getJson(deps, id, `/apis/kargo.akuity.io/v1alpha1/namespaces/${encodeURIComponent(ctx.kargoProject)}/stages/${encodeURIComponent(ctx.stage)}`)
  if (!stage.body) {
    return { mode: 'deferred', reason: stage.status === 403 ? `You cannot read Kargo stage ${ctx.stage} — the change applies with the next promotion of ${ctx.env}.` : `Kargo stage ${ctx.stage} was not found — the change applies with the next promotion of ${ctx.env}.` }
  }
  const freight = appFreight(stage.body, ctx.app)
  if (!freight) return { mode: 'deferred', reason: `Nothing has been promoted to ${ctx.env} yet — the change applies with its first promotion.` }
  const allowed = await deps.can(id, { verb: 'create', group: 'kargo.akuity.io', resource: 'promotions', namespace: ctx.kargoProject })
  if (!allowed) return { mode: 'deferred', reason: `You cannot start promotions in Kargo project ${ctx.kargoProject} — the change applies with the next promotion of ${ctx.env}.` }
  return { mode: 'promotion', freight }
}

/* ─────────── handlers ─────────── */

interface Body {
  app?: unknown
  env?: unknown
  intent?: unknown
  dryRun?: unknown
  fingerprint?: unknown
  confirm?: unknown
}

function names(app: unknown, env: unknown): { app: string; env: string } {
  if (typeof app !== 'string' || !NAME.test(app)) throw new Refusal(400, 'invalid_request', 'app must be an application name.')
  if (typeof env !== 'string' || !NAME.test(env)) throw new Refusal(400, 'invalid_request', 'env must be an environment name.')
  return { app, env }
}

function liveMetrics(hpa: KObj | undefined): unknown[] {
  const metrics = (dict(hpa?.spec).metrics ?? []) as Array<Dict>
  return metrics.filter((m) => {
    const r = dict(m.resource)
    return !(m.type === 'Resource' && (r.name === 'cpu' || r.name === 'memory') && dict(r.target).type === 'Utilization')
  })
}

async function state(deps: ScalingDeps, id: K8sIdentity, url: URL): Promise<Response> {
  const { app, env } = names(url.searchParams.get('app'), url.searchParams.get('env'))
  const ctx = await resolve(deps, id, app, env)
  const base = {
    app,
    env,
    namespace: ctx.namespace,
    workload: { kind: ctx.workload.kind, name: ctx.workload.name },
    repo: { ...ctx.repo, branch: ctx.branch, dir: ctx.dir },
    delivery: ctx.promote ? 'kargo' : 'argo',
    ...(ctx.kargoProject ? { kargo: { project: ctx.kargoProject, stage: ctx.stage } } : {}),
    ...(ctx.keda ? { keda: ctx.keda } : {}),
  }
  const gitea = deps.gitea()
  if (!gitea) return json({ ...base, overlay: 'unavailable', overlayProblem: 'Gitea is not configured on the console, so scaling cannot be committed.' }, 200)
  try {
    const o = await readOverlay(gitea, ctx)
    return json({ ...base, overlay: 'ok', managed: Boolean(o.files.patch), ...(o.declared ? { declared: o.declared } : {}) }, 200)
  } catch (e) {
    if (e instanceof Refusal && e.status === 409) return json({ ...base, overlay: e.code === 'no_overlay' ? 'missing' : 'unsupported', overlayProblem: e.message }, 200)
    throw e
  }
}

async function change(deps: ScalingDeps, req: Request, id: K8sIdentity, auth: NonNullable<Awaited<ReturnType<ScalingDeps['user']>>>, body: Body): Promise<Response> {
  const { app, env } = names(body.app, body.env)
  const v = validateIntent(body.intent)
  if (!v.ok) throw new Refusal(400, 'invalid_intent', v.message)
  const intent = v.value
  const ctx = await resolve(deps, id, app, env)
  const denied = await deps.permit(req, CONSOLE_PERMISSIONS.appScale, ctx.namespace, id)
  if (denied) return denied
  if (ctx.keda) throw new Refusal(409, 'keda_managed', `${app} in ${env} is scaled by KEDA (ScaledObject ${ctx.keda}); change its triggers and bounds there.`)
  const gitea = deps.gitea()
  if (!gitea) throw new Refusal(503, 'gitea_not_configured', 'Gitea is not configured on the console, so the change cannot be committed.')

  const overlay = await readOverlay(gitea, ctx)
  const found = await inputHpa(gitea, ctx, ctx.dir, overlay.files.kustomization.text, true, { files: 40 })
  // Cannot tell from Git (a remote base): the live autoscaler is the evidence,
  // unless it is the console's own autoscaler.yaml.
  const liveHpa = ctx.hpa ? hpaView(ctx.hpa) : undefined
  const hpaName = found === 'unknown' ? (liveHpa && !overlay.files.resource ? liveHpa.name : undefined) : found
  const from = currentIntent(ctx.workload.desired, liveHpa)
  const files = planFiles(overlay.files, {
    app,
    env,
    workload: ctx.workload,
    intent,
    ...(hpaName ? { inputHpa: hpaName } : {}),
    replicasWhileAuto: liveHpa?.current ?? ctx.workload.desired,
    keepMetrics: liveMetrics(ctx.hpa),
  })
  const fingerprint = await planFingerprint(overlay.files)
  const rollout = await planRollout(deps, id, ctx)
  const summary = describeChange(from, intent)
  const confirm = confirmReason(env, intent)

  if (body.dryRun === true) {
    return json({
      plan: {
        summary,
        from,
        target: intent,
        warnings: changeWarnings(env, from, intent),
        confirm,
        fingerprint,
        repo: { ...ctx.repo, branch: ctx.branch, dir: ctx.dir },
        files: files.map((f) => ({ path: f.path, before: f.before, after: f.after })),
        rollout: rollout.mode,
        ...(rollout.reason ? { rolloutReason: rollout.reason } : {}),
      },
    }, 200)
  }

  if (typeof body.fingerprint === 'string' && body.fingerprint !== fingerprint) {
    throw new Refusal(409, 'stale', `${ctx.dir} changed in ${ctx.repo.org}/${ctx.repo.repo} since the preview — review the change again.`)
  }
  if (confirm && body.confirm !== app) {
    throw new Refusal(400, 'confirm_required', confirm === 'offline' ? `Type ${app} to confirm taking it offline in ${env}.` : `Type ${app} to confirm changing production.`)
  }

  // Git already declares it and the cluster already runs it: nothing to do.
  if (!files.length && sameIntent(from, intent)) return json({ ok: true, noop: true, summary, from, target: intent, rollout: 'argo' }, 200)

  const who = actorName(auth.user)
  const target = { type: 'application', id: app, label: `${app} · ${env}` }
  const meta = { env, namespace: ctx.namespace, from, to: intent, repo: `${ctx.repo.org}/${ctx.repo.repo}`, branch: ctx.branch }
  let commit: string | undefined
  if (files.length) {
    const repoPath = `/repos/${encodeURIComponent(ctx.repo.org)}/${encodeURIComponent(ctx.repo.repo)}`
    const res = await gitea(`${repoPath}/contents`, {
      method: 'POST',
      body: JSON.stringify({
        branch: ctx.branch,
        // `[skip ci]`: the paved-road CI drops pushes carrying it. A scaling
        // change needs no new image — a build would mint new freight and
        // promote a new version along with the count.
        message: `scale(${env}): ${app} — ${summary} [skip ci]\n\nvia Adhar console by ${who}`,
        ...(auth.user.email ? { author: { name: who, email: auth.user.email } } : {}),
        files: files.map((f) => ({
          operation: f.after === null ? 'delete' : f.sha ? 'update' : 'create',
          path: f.path,
          ...(f.after !== null ? { content: b64(f.after) } : {}),
          ...(f.sha ? { sha: f.sha } : {}),
        })),
      }),
    })
    if (!res.ok) {
      const detail = await readErr(res)
      deps.log({ action: 'app.scale', user: auth.user.email ?? auth.user.id, app, env, outcome: 'commit_failed', detail })
      await deps.record(auth.activeTenant, auth.user, 'app.scale', target, req, { ...meta, detail }, 'failure')
      const conflict = res.status === 409 || res.status === 422
      throw new Refusal(conflict ? 409 : 502, conflict ? 'conflict' : 'gitea_unavailable', `Gitea refused the commit: ${detail}`)
    }
    commit = ((await res.json().catch(() => ({}))) as { commit?: { sha?: string } }).commit?.sha
  }

  // Roll it out. A failure here leaves the commit in place — say so, rather
  // than reporting a change that did not happen or hiding one that did.
  let mode = rollout.mode
  let reason = rollout.reason
  let promotion: string | undefined
  if (mode === 'promotion' && ctx.kargoProject && rollout.freight) {
    const r = await deps.k8s(id, `/apis/kargo.akuity.io/v1alpha1/namespaces/${encodeURIComponent(ctx.kargoProject)}/promotions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'kargo.akuity.io/v1alpha1',
        kind: 'Promotion',
        metadata: { generateName: `${ctx.stage}-`, namespace: ctx.kargoProject, annotations: { 'adhar.io/reason': `scale ${app}: ${summary}`.slice(0, 200) } },
        spec: { stage: ctx.stage, freight: rollout.freight },
      }),
    })
    if (r.ok) promotion = str(dict(dict(await r.json()).metadata).name)
    else {
      mode = 'deferred'
      reason = `Committed, but starting the promotion failed (${r.status} ${await readErr(r)}) — it applies with the next promotion of ${env}.`
    }
  } else if (mode === 'argo' && ctx.argoApp) {
    await deps.refreshArgo(CONTROL_PLANE_NAMESPACE, ctx.argoApp, id).catch(() => undefined)
  }

  deps.log({ action: 'app.scale', user: auth.user.email ?? auth.user.id, app, env, outcome: 'ok', commit, promotion, rollout: mode })
  await deps.record(auth.activeTenant, auth.user, 'app.scale', target, req, { ...meta, ...(commit ? { commit } : {}), ...(promotion ? { promotion } : {}), rollout: mode }, 'success')
  return json({
    ok: true,
    summary,
    from,
    target: intent,
    ...(commit ? { commit } : {}),
    ...(promotion ? { promotion } : {}),
    rollout: mode,
    ...(reason ? { rolloutReason: reason } : {}),
  }, 200)
}

async function settle(deps: ScalingDeps, req: Request, id: K8sIdentity, auth: NonNullable<Awaited<ReturnType<ScalingDeps['user']>>>, body: Body): Promise<Response> {
  const { app, env } = names(body.app, body.env)
  const ctx = await resolve(deps, id, app, env)
  const denied = await deps.permit(req, CONSOLE_PERMISSIONS.appScale, ctx.namespace, id)
  if (denied) return denied
  if (ctx.hpa) throw new Refusal(409, 'autoscaler_present', `An autoscaler still scales ${app} in ${env}; it decides the count.`)
  const gitea = deps.gitea()
  if (!gitea) throw new Refusal(503, 'gitea_not_configured', 'Gitea is not configured on the console.')
  const overlay = await readOverlay(gitea, ctx)
  const declared = overlay.declared
  if (declared?.mode !== 'fixed') throw new Refusal(409, 'not_fixed', `${ctx.dir}/${PATCH_FILE} does not declare a fixed instance count.`)
  const want = declared.replicas
  if (ctx.workload.desired === want) return json({ ok: true, noop: true, replicas: want }, 200)

  // Only ever write what the cluster is MEANT to run already: the rendered
  // environment branch must carry the count, and Argo CD must be at rest.
  if (ctx.promote) {
    const rendered = await readFile(gitea, ctx, 'manifests.yaml', `stage/${env}`)
    const there = rendered ? renderedReplicas(rendered.text, ctx.workload) : undefined
    if (there !== want) throw new Refusal(409, 'not_rolled_out', `stage/${env} does not carry ${want} instances yet${there !== undefined ? ` (it has ${there})` : ''} — wait for the promotion.`)
  }
  if (ctx.argoApp) {
    const a = await getJson(deps, id, `/apis/argoproj.io/v1alpha1/namespaces/${CONTROL_PLANE_NAMESPACE}/applications/${encodeURIComponent(ctx.argoApp)}`)
    const st = dict(a.body?.status)
    if (a.body && (dict(st.sync).status !== 'Synced' || dict(st.operationState).phase === 'Running')) {
      throw new Refusal(409, 'argo_busy', `Argo CD is still applying ${ctx.argoApp}; try again when it is synced.`)
    }
  }

  const w = WORKLOADS.find((x) => x.kind === ctx.workload.kind)!
  const r = await deps.k8s(id, `${w.base}/namespaces/${encodeURIComponent(ctx.namespace)}/${w.resource}/${encodeURIComponent(ctx.workload.name)}/scale`, {
    method: 'PATCH',
    search: '?fieldManager=adhar-console',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ spec: { replicas: want } }),
  })
  const target = { type: 'application', id: app, label: `${app} · ${env}` }
  if (!r.ok) {
    const detail = await readErr(r)
    deps.log({ action: 'app.scale.settle', user: auth.user.email ?? auth.user.id, app, env, outcome: 'failed', status: r.status, detail })
    throw new Refusal(r.status === 403 ? 403 : 502, r.status === 403 ? 'forbidden' : 'cluster_unavailable', r.status === 403
      ? `You cannot scale ${w.resource} in ${ctx.namespace} (it needs patch ${w.resource}/scale).`
      : `Setting the count failed: ${detail}`)
  }
  await r.body?.cancel()
  deps.log({ action: 'app.scale.settle', user: auth.user.email ?? auth.user.id, app, env, outcome: 'ok', from: ctx.workload.desired, to: want })
  await deps.record(auth.activeTenant, auth.user, 'app.scale.settle', target, req, { env, namespace: ctx.namespace, from: ctx.workload.desired, to: want }, 'success')
  return json({ ok: true, replicas: want, from: ctx.workload.desired }, 200)
}

export function handleScaling(req: Request, subpath: string, deps: ScalingDeps = realDeps): Promise<Response> {
  return handle(req, subpath, deps)
}

async function handle(req: Request, subpath: string, deps: ScalingDeps): Promise<Response> {
  const method = req.method.toUpperCase()
  const sub = subpath.replace(/^\/+|\/+$/g, '')
  if (!(method === 'GET' && sub === '') && !(method === 'POST' && (sub === '' || sub === 'settle'))) {
    return new Response('Method Not Allowed', { status: 405 })
  }
  if (method === 'POST' && !originOk(req)) return json({ error: 'forbidden', detail: 'Cross-origin request refused.' }, 403)
  const auth = await deps.user(req)
  if (!auth) return unauthorized()
  const cookie = auth.refreshedCookie
  const id = await deps.identity(req)
  if (!id) return unauthorized()
  try {
    let res: Response
    if (method === 'GET') res = await state(deps, id, new URL(req.url))
    else {
      const body = (await req.json().catch(() => null)) as Body | null
      if (!body || typeof body !== 'object') throw new Refusal(400, 'invalid_request', 'Expected a JSON object.')
      res = sub === 'settle' ? await settle(deps, req, id, auth, body) : await change(deps, req, id, auth, body)
    }
    if (cookie) res.headers.append('set-cookie', cookie)
    return res
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.code, detail: e.message }, e.status, cookie)
    console.error('[scaling] request failed:', e)
    return json({ error: 'internal_error', detail: e instanceof Error ? e.message : String(e) }, 500, cookie)
  }
}
