import { crStatus, platformRouteHost } from '@adhar/utils'
import { kargo } from '@adhar/api-clients'

/**
 * Develop → Functions, the pure half: what a Function XR and the Knative
 * objects it composes MEAN, with no fetching and no React, so every rule is
 * unit-tested (`functions-model_test.ts`).
 *
 * The platform contract this reads (platform/controlplane: function.xrd.yaml +
 * compositions/function/local-knative.yaml):
 *
 *   • A Function XR (`platform.adhar.io/v1alpha1`, namespaced) lives in each
 *     environment namespace of its project, created by GitOps from the app
 *     repository's `deploy/envs/<env>` overlay. Labels say which application,
 *     environment, project and team it belongs to.
 *   • It composes a Knative Service of the same name in the same namespace —
 *     pods labelled `serving.knative.dev/service=<name>`, app container
 *     `user-container` next to a `queue-proxy` — a PodAutoscaler per revision,
 *     and an edge route `https://<name>.<env>.<platform domain>`.
 *   • `status.url / readyRevision / latestRevision / message` and the
 *     `ServiceReady / EdgeReady / TriggersReady` conditions report what it is
 *     doing.
 *
 * Every field is optional here: the contract is being implemented as this is
 * written, and a page that throws on a missing status field shows nothing at
 * all, which is worse than a page that says "not reported yet".
 */

/* ─────────────────────────── API surface ─────────────────────────── */

export const FUNCTIONS_GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'functions', namespaced: true } as const
export const KSVC_GVR = { group: 'serving.knative.dev', version: 'v1', resource: 'services', namespaced: true } as const
export const REVISIONS_GVR = { group: 'serving.knative.dev', version: 'v1', resource: 'revisions', namespaced: true } as const
export const ROUTES_GVR = { group: 'serving.knative.dev', version: 'v1', resource: 'routes', namespaced: true } as const
export const PODAUTOSCALERS_GVR = { group: 'autoscaling.internal.knative.dev', version: 'v1alpha1', resource: 'podautoscalers', namespaced: true } as const
export const PODS_GVR = { group: '', version: 'v1', resource: 'pods', namespaced: true } as const
export const EVENTS_GVR = { group: '', version: 'v1', resource: 'events', namespaced: true } as const
export const PIPELINERUNS_GVR = { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true } as const
export const APPLICATIONS_GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'applications', namespaced: true } as const
export const PROJECTS_GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'projects', namespaced: true } as const

/** Where the control plane keeps Application and Project XRs. */
export const CONTROL_PLANE_NS = 'adhar-system'

export const LABEL = {
  application: 'adhar.io/application',
  environment: 'adhar.io/environment',
  project: 'adhar.io/project',
  team: 'adhar.io/team',
  workload: 'adhar.io/workload',
  function: 'platform.adhar.io/function',
  runtime: 'platform.adhar.io/runtime',
  ksvc: 'serving.knative.dev/service',
  revision: 'serving.knative.dev/revision',
  configGeneration: 'serving.knative.dev/configurationGeneration',
  ciApp: 'adhar.io/app',
} as const

/** The container the function's code runs in; `queue-proxy` is Knative's. */
export const USER_CONTAINER = 'user-container'

/* ─────────────────────────── shapes ─────────────────────────── */

export interface Condition {
  type?: string
  status?: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface Meta {
  name: string
  namespace?: string
  uid?: string
  creationTimestamp?: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  generation?: number
}

export interface FunctionTrigger {
  name?: string
  type?: string
  path?: string
  schedule?: string
  timezone?: string
  broker?: string
  filter?: Record<string, string>
  pubsub?: string
  topic?: string
  deadLetterTopic?: string
  bucket?: string
}

export interface FunctionParameters {
  displayName?: string
  runtime?: string
  image?: string
  imagePullSecrets?: string[]
  trigger?: string
  eventSource?: string
  triggers?: FunctionTrigger[]
  hostname?: string
  visibility?: string
  port?: number
  minScale?: number
  maxScale?: number
  targetConcurrency?: number
  containerConcurrency?: number
  timeoutSeconds?: number
  dapr?: { enabled?: boolean; appPort?: number; config?: string }
  env?: Record<string, string>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  organisation?: string
  team?: string
  project?: string
  application?: string
  environment?: string
}

export interface FunctionXR {
  apiVersion?: string
  kind?: string
  metadata: Meta
  spec?: { parameters?: FunctionParameters; crossplane?: Record<string, unknown> }
  status?: {
    url?: string
    address?: string
    readyRevision?: string
    latestRevision?: string
    message?: string
    triggers?: Array<{ name?: string; type?: string; kind?: string; resource?: string; ready?: string; message?: string }>
    conditions?: Condition[]
  }
}

export interface TrafficTarget {
  revisionName?: string
  configurationName?: string
  latestRevision?: boolean
  percent?: number
  tag?: string
  url?: string
}

export interface KService {
  metadata: Meta
  spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } }; traffic?: TrafficTarget[] }
  status?: {
    url?: string
    address?: { url?: string }
    latestReadyRevisionName?: string
    latestCreatedRevisionName?: string
    traffic?: TrafficTarget[]
    conditions?: Condition[]
  }
}

export interface KRoute {
  metadata: Meta
  status?: { url?: string; traffic?: TrafficTarget[]; conditions?: Condition[] }
}

export interface KRevision {
  metadata: Meta
  spec?: { containers?: Array<{ name?: string; image?: string }>; containerConcurrency?: number; timeoutSeconds?: number }
  status?: {
    conditions?: Condition[]
    containerStatuses?: Array<{ name?: string; imageDigest?: string }>
    actualReplicas?: number
    desiredReplicas?: number
  }
}

export interface PodAutoscaler {
  metadata: Meta
  spec?: { reachability?: string }
  status?: { desiredScale?: number; actualScale?: number; conditions?: Condition[] }
}

export interface PodLike {
  metadata: Meta
  spec?: { containers?: Array<{ name: string }> }
  status?: {
    phase?: string
    reason?: string
    conditions?: Condition[]
    containerStatuses?: Array<{
      name: string
      ready?: boolean
      restartCount?: number
      state?: { waiting?: { reason?: string }; running?: unknown; terminated?: { reason?: string } }
    }>
  }
}

export interface EventLike {
  metadata: Meta
  type?: string
  reason?: string
  message?: string
  count?: number
  lastTimestamp?: string
  eventTime?: string
  firstTimestamp?: string
  involvedObject?: { kind?: string; name?: string; namespace?: string }
}

export interface PipelineRunLike {
  metadata: Meta
  spec?: { params?: Array<{ name: string; value?: unknown }>; pipelineRef?: { name?: string } }
  status?: { conditions?: Condition[]; startTime?: string; completionTime?: string }
}

/** The bits of an Application XR this page reads (adhar-system). */
export interface ApplicationXR {
  metadata: Meta
  spec?: { parameters?: { type?: string; project?: string; displayName?: string; source?: { repoURL?: string; path?: string; targetRevision?: string } } }
  status?: { conditions?: Condition[] }
}

/* ─────────────────────────── identity ─────────────────────────── */

const lower = (s: string | undefined) => (s ?? '').trim().toLowerCase()

/** The platform's canonical environments, in promotion order. */
export const PLATFORM_ENVIRONMENTS = ['dev', 'test', 'prod'] as const

/**
 * The environment a Function serves: its `adhar.io/environment` label, else
 * what its namespace is in the project's environment list, else its own
 * parameter, else a namespace that IS a platform environment. `undefined`
 * rather than a guess — a Function in `adhar-system` is not in any
 * environment, and calling it "adhar-system" would draw it as a promotion
 * stage.
 */
export function functionEnvironment(fn: FunctionXR, envByNamespace?: ReadonlyMap<string, string>): string | undefined {
  const label = lower(fn.metadata.labels?.[LABEL.environment])
  if (label) return label
  const ns = fn.metadata.namespace ?? ''
  const mapped = envByNamespace?.get(ns)
  if (mapped) return lower(mapped)
  const param = lower(fn.spec?.parameters?.environment)
  if (param) return param
  return (PLATFORM_ENVIRONMENTS as readonly string[]).includes(ns) ? ns : undefined
}

/** The application a Function belongs to (defaults to the function's own name, as the XRD does). */
export function functionApplication(fn: FunctionXR): string {
  return fn.metadata.labels?.[LABEL.application] || fn.spec?.parameters?.application || fn.metadata.name
}

export function functionProject(fn: FunctionXR): string | undefined {
  return fn.metadata.labels?.[LABEL.project] || fn.spec?.parameters?.project || undefined
}

export function functionTeam(fn: FunctionXR): string | undefined {
  return fn.metadata.labels?.[LABEL.team] || fn.spec?.parameters?.team || undefined
}

export function functionRuntime(fn: FunctionXR): string | undefined {
  return fn.metadata.labels?.[LABEL.runtime] || fn.spec?.parameters?.runtime || undefined
}

const RUNTIME_LABEL: Record<string, string> = {
  node20: 'Node.js 20',
  node22: 'Node.js 22',
  node24: 'Node.js 24',
  python312: 'Python 3.12',
  python313: 'Python 3.13',
  go122: 'Go 1.22',
  go125: 'Go 1.25',
  java21: 'Java 21',
  java25: 'Java 25',
  deno2: 'Deno 2',
  custom: 'Custom',
}

export function runtimeLabel(runtime: string | undefined): string {
  if (!runtime) return '—'
  return RUNTIME_LABEL[runtime] ?? runtime
}

/**
 * What invokes the function. HTTP is always served; the event triggers come
 * from `triggers[]`, or the older single `trigger` shorthand.
 */
export function functionTriggers(fn: FunctionXR): string[] {
  const p = fn.spec?.parameters ?? {}
  const out = ['http']
  const types = Array.isArray(p.triggers) && p.triggers.length
    ? p.triggers.map((t) => lower(t.type))
    : [lower(p.trigger) || 'http']
  for (const t of types) if (t && !out.includes(t)) out.push(t)
  return out
}

export function triggerLabel(triggers: readonly string[]): string {
  const map: Record<string, string> = { http: 'HTTP', cron: 'cron', cloudevent: 'CloudEvent', topic: 'topic', bucket: 'bucket' }
  return triggers.map((t) => map[t] ?? t).join(' + ')
}

/* ─────────────────────────── health ─────────────────────────── */

export type FunctionHealth = 'ready' | 'degraded' | 'deploying' | 'failed' | 'deleting' | 'unknown'

export interface FunctionState {
  health: FunctionHealth
  label: string
  /** The platform's own sentence about it (`status.message`, else the condition's). */
  message?: string
  /** Each function-specific condition that is False: `EdgeReady: HostClaimed — …`. */
  issues: string[]
}

/** The conditions the Function composition adds beside Crossplane's Ready / Synced. */
export const FUNCTION_CONDITIONS = ['ServiceReady', 'EdgeReady', 'TriggersReady'] as const

const condition = (conds: readonly Condition[] | undefined, type: string) => (conds ?? []).find((c) => c.type === type)

/**
 * Health of one Function, read through the console's generic `crStatus`
 * (Ready / Synced first, as Crossplane reports them), then sharpened with the
 * function's own conditions: a Knative Service that is not serving is a
 * failure even while Crossplane says Ready, and a function that serves but
 * whose edge or triggers are not ready is degraded, not healthy.
 */
export function functionState(fn: FunctionXR): FunctionState {
  if (fn.metadata.deletionTimestamp) return { health: 'deleting', label: 'Deleting', issues: [] }
  const conds = fn.status?.conditions ?? []
  const base = crStatus(fn)
  const issues = FUNCTION_CONDITIONS.map((t) => condition(conds, t))
    .filter((c): c is Condition => Boolean(c && c.status === 'False'))
    .map((c) => `${c.type}: ${c.reason || 'False'}${c.message ? ` — ${c.message}` : ''}`)
  const message = fn.status?.message || base.message
  const service = condition(conds, 'ServiceReady')
  if (service?.status === 'False') {
    return { health: 'failed', label: service.reason || 'Not serving', message: service.message || message, issues }
  }
  switch (base.health) {
    case 'degraded':
      return { health: 'failed', label: base.label, message, issues }
    case 'progressing':
      return { health: 'deploying', label: base.label, message, issues }
    case 'healthy':
      return issues.length
        ? { health: 'degraded', label: 'Degraded', message: issues[0], issues }
        : { health: 'ready', label: 'Ready', message, issues }
    default:
      return conds.length || fn.status?.readyRevision
        ? { health: 'unknown', label: base.label, message, issues }
        : { health: 'deploying', label: 'Pending', message: message ?? 'The control plane has not reported on it yet.', issues }
  }
}

/** Badge kind (shell-ui StatusBadge) for each health. */
export const HEALTH_BADGE: Record<FunctionHealth, 'healthy' | 'paused' | 'progressing' | 'failed' | 'unknown'> = {
  ready: 'healthy',
  degraded: 'paused',
  deploying: 'progressing',
  failed: 'failed',
  deleting: 'progressing',
  unknown: 'unknown',
}

const SEVERITY: Record<FunctionHealth, number> = { failed: 5, degraded: 4, deploying: 3, deleting: 2, unknown: 1, ready: 0 }

/** The worst of several healths — a group is as healthy as its least healthy environment. */
export function worstHealth(list: readonly FunctionHealth[]): FunctionHealth | undefined {
  return [...list].sort((a, b) => SEVERITY[b] - SEVERITY[a])[0]
}

/** Is the function's Knative Service serving (whatever its edge and triggers say)? */
export function isServing(state: FunctionState): boolean {
  return state.health === 'ready' || state.health === 'degraded'
}

/* ─────────────────────────── scale ─────────────────────────── */

export interface ScaleView {
  min: number
  max: number
  /** The autoscaler's soft target of in-flight requests per pod. */
  target: number
  /** Pods running now (autoscaler's actualScale, else live pods). */
  actual?: number
  /** What the autoscaler wants (desiredScale); undefined until it knows. */
  desired?: number
  /** Pods whose Ready condition is True. */
  ready?: number
  /** Serving, minScale 0, and no pod running — the next request cold-starts. */
  scaledToZero: boolean
  source: 'autoscaler' | 'pods' | 'none'
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

function isTerminating(p: PodLike): boolean {
  return Boolean(p.metadata.deletionTimestamp)
}

function podReady(p: PodLike): boolean {
  return condition(p.status?.conditions, 'Ready')?.status === 'True'
}

/** The function's pods (Knative labels them with the service name), live ones only. */
export function podsOf(pods: readonly PodLike[] | undefined, name: string): PodLike[] {
  return (pods ?? []).filter((p) => p.metadata.labels?.[LABEL.ksvc] === name && !isTerminating(p))
}

/** The function's PodAutoscalers — one per revision. */
export function autoscalersOf(list: readonly PodAutoscaler[] | undefined, name: string): PodAutoscaler[] {
  return (list ?? []).filter((pa) => pa.metadata.labels?.[LABEL.ksvc] === name)
}

/**
 * Scale now against the bounds. The autoscaler is the authority when it can be
 * read (it knows a pod is coming before the pod exists); otherwise the live
 * pods are counted. `scaledToZero` only when the function is actually serving
 * and allowed to be at zero — a function that never started is not "scaled to
 * zero", it is not running.
 */
export function scaleView(
  fn: FunctionXR,
  opts: { autoscalers?: readonly PodAutoscaler[]; pods?: readonly PodLike[]; serving?: boolean } = {},
): ScaleView {
  const p = fn.spec?.parameters ?? {}
  const min = Math.max(0, num(p.minScale, 0))
  const max = Math.max(1, num(p.maxScale, 20))
  const target = Math.max(1, num(p.targetConcurrency, 100))
  const serving = opts.serving ?? isServing(functionState(fn))
  const pas = autoscalersOf(opts.autoscalers, fn.metadata.name)
  const pods = opts.pods ? podsOf(opts.pods, fn.metadata.name) : undefined
  const ready = pods ? pods.filter(podReady).length : undefined
  if (pas.length) {
    const actual = pas.reduce((n, pa) => n + Math.max(0, num(pa.status?.actualScale, 0)), 0)
    const known = pas.map((pa) => pa.status?.desiredScale).filter((d): d is number => typeof d === 'number' && d >= 0)
    const desired = known.length ? known.reduce((a, b) => a + b, 0) : undefined
    return { min, max, target, actual, desired, ready, scaledToZero: serving && min === 0 && actual === 0 && (desired ?? 0) === 0, source: 'autoscaler' }
  }
  if (pods) {
    return { min, max, target, actual: pods.length, ready, scaledToZero: serving && min === 0 && pods.length === 0, source: 'pods' }
  }
  return { min, max, target, scaledToZero: false, source: 'none' }
}

/** `1 (0–20)` — pods now, then the bounds. */
export function scaleLabel(s: ScaleView): string {
  const now = s.actual === undefined ? '—' : String(s.actual)
  return `${now} (${s.min}–${s.max})`
}

/* ─────────────────────────── URLs ─────────────────────────── */

export interface FunctionUrl {
  url?: string
  /** Not reported by the platform — derived from the route rule. */
  derived: boolean
  /** Reachable only inside the cluster. */
  clusterOnly: boolean
}

export function isClusterLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h.endsWith('.svc') || h.endsWith('.svc.cluster.local') || h.endsWith('.cluster.local')
  } catch {
    return false
  }
}

/**
 * Where the function answers. `status.url` when the platform has published
 * one; otherwise what the composition WILL publish — the platform route
 * (`platformRouteHost`, the same rule the scaffolder writes) or the
 * function's own hostname — flagged as derived so the page never presents a
 * guess as a fact.
 */
export function functionUrl(fn: FunctionXR, baseDomain?: string, envByNamespace?: ReadonlyMap<string, string>): FunctionUrl {
  const reported = (fn.status?.url ?? '').trim()
  if (reported) return { url: reported, derived: false, clusterOnly: isClusterLocalUrl(reported) }
  const p = fn.spec?.parameters ?? {}
  const name = fn.metadata.name
  const ns = fn.metadata.namespace
  if (p.visibility === 'cluster') {
    const url = fn.status?.address || (ns ? `http://${name}.${ns}.svc.cluster.local` : undefined)
    return { url, derived: !fn.status?.address, clusterOnly: true }
  }
  if (p.hostname) return { url: `https://${p.hostname}`, derived: true, clusterOnly: false }
  const env = functionEnvironment(fn, envByNamespace)
  const base = (baseDomain ?? '').trim()
  if (env && base) {
    const port = base.match(/:(\d+)$/)?.[1]
    const host = platformRouteHost(name, env, base)
    return { url: `https://${host}${port && port !== '443' ? `:${port}` : ''}`, derived: true, clusterOnly: false }
  }
  return { derived: true, clusterOnly: false }
}

/* ─────────────────────────── GitOps ownership ─────────────────────────── */

export interface GitOpsOwner {
  /** Something reconciles this object from Git — deleting it directly is undone. */
  managed: boolean
  /** The Argo CD Application that owns it, when the tracking metadata names one. */
  argoApp?: string
  argoNamespace?: string
}

const TRACKING_ID = 'argocd.argoproj.io/tracking-id'

/**
 * Who owns an object in Git. Argo CD stamps what it applies: the
 * `argocd.argoproj.io/tracking-id` annotation (`<app>:<group>/<kind>:<ns>/<name>`,
 * `<ns>_<app>:…` for apps outside Argo's own namespace) on this platform, or
 * the `app.kubernetes.io/instance` / `argocd.argoproj.io/instance` label under
 * label tracking. Any of them makes the object managed.
 */
export function gitopsOwner(meta: Pick<Meta, 'labels' | 'annotations'>): GitOpsOwner {
  const id = meta.annotations?.[TRACKING_ID]
  if (id) {
    const head = id.split(':')[0] ?? ''
    const us = head.indexOf('_')
    return us > 0
      ? { managed: true, argoNamespace: head.slice(0, us), argoApp: head.slice(us + 1) || undefined }
      : { managed: true, argoApp: head || undefined }
  }
  const byLabel = meta.labels?.['argocd.argoproj.io/instance'] || meta.labels?.['app.kubernetes.io/instance']
  return byLabel ? { managed: true, argoApp: byLabel } : { managed: false }
}

/* ─────────────────────────── grouping ─────────────────────────── */

export interface FunctionCell {
  fn: FunctionXR
  /** Environment key (`dev`), or the namespace when the function is in none. */
  env: string
  /** False when `env` is a namespace standing in for an unknown environment. */
  envKnown: boolean
  state: FunctionState
}

export interface FunctionGroup {
  key: string
  name: string
  application: string
  project?: string
  team?: string
  runtime?: string
  triggers: string[]
  /** One cell per environment, in promotion order. */
  cells: FunctionCell[]
  /** A function application with no Function deployed yet (from its Application XR). */
  pendingApp?: ApplicationXR
}

/** Is this Application XR a function app? (`type: function`, or the adhar.io/workload label). */
export function isFunctionApplication(app: ApplicationXR): boolean {
  return app.spec?.parameters?.type === 'function' || app.metadata.labels?.[LABEL.workload] === 'function'
}

export function applicationProject(app: ApplicationXR): string | undefined {
  const p = (app.spec?.parameters?.project ?? app.metadata.labels?.[LABEL.project] ?? '').trim()
  return !p || p === 'default' ? undefined : p
}

/** Promotion order of an environment key (dev → test → prod), shared with Deliver. */
export function envRank(key: string): number {
  return kargo.envOrder(key)
}

/**
 * Functions grouped per (project, application, function name) — the row a
 * person thinks of as "my function" — with one cell per environment it runs
 * in. Function applications that have nothing deployed yet join as empty
 * rows, so a function created a minute ago from a template is visible while
 * its first build runs.
 */
export function groupFunctions(
  functions: readonly FunctionXR[],
  opts: { envByNamespace?: ReadonlyMap<string, string>; applications?: readonly ApplicationXR[] } = {},
): FunctionGroup[] {
  const groups = new Map<string, FunctionGroup>()
  for (const fn of functions) {
    const name = fn.metadata.name
    const application = functionApplication(fn)
    const project = functionProject(fn)
    const key = `${project ?? ''}/${application}/${name}`
    let g = groups.get(key)
    if (!g) {
      g = { key, name, application, project, team: functionTeam(fn), runtime: functionRuntime(fn), triggers: [], cells: [] }
      groups.set(key, g)
    }
    g.team ??= functionTeam(fn)
    g.runtime ??= functionRuntime(fn)
    for (const t of functionTriggers(fn)) if (!g.triggers.includes(t)) g.triggers.push(t)
    const env = functionEnvironment(fn, opts.envByNamespace)
    let cellEnv = env ?? fn.metadata.namespace ?? '—'
    // The same function twice in one environment (two namespaces claiming it):
    // keep both, told apart by namespace, rather than dropping one.
    if (g.cells.some((c) => c.env === cellEnv)) cellEnv = `${cellEnv} (${fn.metadata.namespace ?? '?'})`
    g.cells.push({ fn, env: cellEnv, envKnown: Boolean(env), state: functionState(fn) })
  }
  for (const g of groups.values()) {
    g.cells.sort((a, b) => Number(b.envKnown) - Number(a.envKnown) || envRank(a.env) - envRank(b.env) || a.env.localeCompare(b.env))
  }
  for (const app of opts.applications ?? []) {
    if (!isFunctionApplication(app)) continue
    const name = app.metadata.labels?.[LABEL.application] || app.metadata.name
    const deployed = [...groups.values()].some((g) => g.application === name)
    if (deployed) continue
    const project = applicationProject(app)
    const key = `${project ?? ''}/${name}/${name}`
    groups.set(key, { key, name, application: name, project, team: app.metadata.labels?.[LABEL.team], triggers: ['http'], cells: [], pendingApp: app })
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.project ?? '').localeCompare(b.project ?? ''))
}

/**
 * The environment columns: the project's declared environments first (in
 * their order), then any other environment a function runs in, in promotion
 * order, then stand-in namespaces.
 */
export function environmentColumns(groups: readonly FunctionGroup[], declared: readonly string[] = []): string[] {
  const seen = new Map<string, boolean>()
  for (const g of groups) for (const c of g.cells) if (!seen.has(c.env)) seen.set(c.env, c.envKnown)
  const known = [...seen.entries()].filter(([, k]) => k).map(([e]) => e)
  const other = [...seen.entries()].filter(([, k]) => !k).map(([e]) => e).sort()
  const order = [...declared.map(lower)].filter((e, i, a) => e && a.indexOf(e) === i)
  const rest = known.filter((e) => !order.includes(e)).sort((a, b) => envRank(a) - envRank(b) || a.localeCompare(b))
  // Declared environments are columns even when nothing runs there yet: the
  // empty cell is what says "not promoted to prod".
  return [...order, ...rest, ...other]
}

/** The cell a group has in one environment column. */
export function cellFor(g: FunctionGroup, env: string): FunctionCell | undefined {
  return g.cells.find((c) => c.env === env)
}

/** The health of a whole row: its worst environment, or pending for an app with nothing deployed. */
export function groupHealth(g: FunctionGroup): FunctionHealth | 'pending' {
  if (!g.cells.length) return 'pending'
  return worstHealth(g.cells.map((c) => c.state.health)) ?? 'unknown'
}

/* ─────────────────────────── filters ─────────────────────────── */

export const STATUS_LABEL: Record<FunctionHealth | 'pending' | 'scaled-to-zero', string> = {
  ready: 'Ready',
  degraded: 'Degraded',
  deploying: 'Deploying',
  failed: 'Failed',
  deleting: 'Deleting',
  unknown: 'Unknown',
  pending: 'Not deployed yet',
  'scaled-to-zero': 'Scaled to zero',
}

/**
 * The values a row offers each filter facet. Status is per environment (a row
 * failing in dev and ready in prod matches both), plus `scaled-to-zero` when
 * any environment is.
 */
export function groupFacets(
  g: FunctionGroup,
  scaledToZero: (cell: FunctionCell) => boolean = () => false,
): Record<'project' | 'team' | 'runtime' | 'trigger' | 'status' | 'environment', string[]> {
  const statuses = new Set<string>(g.cells.length ? g.cells.map((c) => c.state.health) : ['pending'])
  if (g.cells.some(scaledToZero)) statuses.add('scaled-to-zero')
  return {
    project: g.project ? [g.project] : [],
    team: g.team ? [g.team] : [],
    runtime: g.runtime ? [g.runtime] : [],
    trigger: g.triggers,
    status: [...statuses],
    environment: g.cells.filter((c) => c.envKnown).map((c) => c.env),
  }
}

/** The text a row is found by. */
export function groupSearchText(g: FunctionGroup): string[] {
  const images = g.cells.map((c) => c.fn.spec?.parameters?.image)
  const urls = g.cells.map((c) => c.fn.status?.url)
  return [g.name, g.application, g.project, g.team, g.runtime, ...g.triggers, ...g.cells.map((c) => c.fn.metadata.namespace), ...images, ...urls]
    .filter((s): s is string => typeof s === 'string' && s !== '')
}

/* ─────────────────────────── revisions & traffic ─────────────────────────── */

export interface RevisionRow {
  name: string
  created?: string
  image?: string
  /** `sha256:…`, as Knative resolved the tag at deploy time. */
  digest?: string
  ready: 'True' | 'False' | 'Unknown'
  reason?: string
  message?: string
  /** Share of traffic routed to it. */
  percent: number
  tags: string[]
  /** It is the Function's ready revision. */
  current: boolean
  /** It is the newest revision created. */
  latest: boolean
}

export function revisionsOf(list: readonly KRevision[] | undefined, name: string): KRevision[] {
  return (list ?? []).filter((r) => r.metadata.labels?.[LABEL.ksvc] === name)
}

function generationOf(r: KRevision): number {
  const g = Number(r.metadata.labels?.[LABEL.configGeneration])
  return Number.isFinite(g) ? g : 0
}

/** `image@sha256:abc` → `sha256:abc`. */
export function digestOf(imageDigest: string | undefined): string | undefined {
  const m = (imageDigest ?? '').match(/(sha256:[0-9a-f]{12,64})/)
  return m?.[1]
}

/**
 * The revisions newest first, each with the traffic it serves. Traffic comes
 * from the Route's resolved `status.traffic` (the ksvc mirrors it); an entry
 * may name its revision or point at `latestRevision`, which is resolved to the
 * latest ready one.
 */
export function revisionRows(
  revisions: readonly KRevision[],
  traffic: readonly TrafficTarget[] | undefined,
  opts: { readyRevision?: string; latestRevision?: string } = {},
): RevisionRow[] {
  const sorted = [...revisions].sort((a, b) =>
    generationOf(b) - generationOf(a) || (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')
  )
  const latestReady = opts.readyRevision ?? sorted.find((r) => condition(r.status?.conditions, 'Ready')?.status === 'True')?.metadata.name
  const percent = new Map<string, number>()
  const tags = new Map<string, string[]>()
  for (const t of traffic ?? []) {
    const rev = t.revisionName ?? (t.latestRevision ? latestReady : undefined)
    if (!rev) continue
    percent.set(rev, (percent.get(rev) ?? 0) + num(t.percent, 0))
    if (t.tag) tags.set(rev, [...(tags.get(rev) ?? []), t.tag])
  }
  const latest = opts.latestRevision ?? sorted[0]?.metadata.name
  return sorted.map((r) => {
    const ready = condition(r.status?.conditions, 'Ready')
    const container = r.spec?.containers?.find((c) => c.name === USER_CONTAINER) ?? r.spec?.containers?.[0]
    const status = r.status?.containerStatuses?.find((c) => c.name === USER_CONTAINER) ?? r.status?.containerStatuses?.[0]
    return {
      name: r.metadata.name,
      created: r.metadata.creationTimestamp,
      image: container?.image,
      digest: digestOf(status?.imageDigest),
      ready: ready?.status === 'True' ? 'True' : ready?.status === 'False' ? 'False' : 'Unknown',
      reason: ready?.reason,
      message: ready?.message,
      percent: percent.get(r.metadata.name) ?? 0,
      tags: tags.get(r.metadata.name) ?? [],
      current: r.metadata.name === latestReady,
      latest: r.metadata.name === latest,
    }
  })
}

/** When the function last changed what it serves: its ready revision's creation. */
export function lastDeployed(fn: FunctionXR, revisions: readonly KRevision[] | undefined): string | undefined {
  const ready = fn.status?.readyRevision
  const mine = revisionsOf(revisions, fn.metadata.name)
  const rev = (ready && mine.find((r) => r.metadata.name === ready)) ||
    [...mine].sort((a, b) => generationOf(b) - generationOf(a))[0]
  if (rev?.metadata.creationTimestamp) return rev.metadata.creationTimestamp
  return condition(fn.status?.conditions, 'ServiceReady')?.lastTransitionTime
}

/** The ready revision's image digest, when Knative has resolved one. */
export function readyDigest(fn: FunctionXR, revisions: readonly KRevision[] | undefined): string | undefined {
  const ready = fn.status?.readyRevision
  const rev = revisionsOf(revisions, fn.metadata.name).find((r) => r.metadata.name === ready)
  const status = rev?.status?.containerStatuses?.find((c) => c.name === USER_CONTAINER) ?? rev?.status?.containerStatuses?.[0]
  return digestOf(status?.imageDigest)
}

/* ─────────────────────────── pods & events ─────────────────────────── */

export interface PodRow {
  name: string
  revision?: string
  phase: string
  ready: boolean
  /** `2/2` — containers ready of total. */
  containers: string
  restarts: number
  created?: string
  /** The user container's waiting/terminated reason (CrashLoopBackOff, OOMKilled…). */
  reason?: string
}

export function podRows(pods: readonly PodLike[]): PodRow[] {
  return [...pods]
    .sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''))
    .map((p) => {
      const cs = p.status?.containerStatuses ?? []
      const total = p.spec?.containers?.length ?? cs.length
      const user = cs.find((c) => c.name === USER_CONTAINER)
      return {
        name: p.metadata.name,
        revision: p.metadata.labels?.[LABEL.revision],
        phase: p.metadata.deletionTimestamp ? 'Terminating' : p.status?.phase ?? 'Unknown',
        ready: podReady(p),
        containers: `${cs.filter((c) => c.ready).length}/${total}`,
        restarts: cs.reduce((n, c) => n + num(c.restartCount, 0), 0),
        created: p.metadata.creationTimestamp,
        reason: user?.state?.waiting?.reason ?? user?.state?.terminated?.reason ?? p.status?.reason,
      }
    })
}

export interface EventRow {
  key: string
  type: string
  reason: string
  message: string
  object: string
  count: number
  at?: string
}

/**
 * Events about the function and everything it composes — the Function XR, the
 * ksvc, Route and Configuration (all named `<name>`), its revisions, their
 * autoscalers and pods (all `<name>-…`) — newest first.
 */
export function functionEvents(events: readonly EventLike[] | undefined, name: string): EventRow[] {
  return (events ?? [])
    .filter((e) => {
      const n = e.involvedObject?.name ?? ''
      return n === name || n.startsWith(`${name}-`)
    })
    .map((e) => ({
      key: e.metadata.uid ?? `${e.metadata.name}`,
      type: e.type ?? 'Normal',
      reason: e.reason ?? '',
      message: e.message ?? '',
      object: `${e.involvedObject?.kind ?? ''}/${e.involvedObject?.name ?? ''}`,
      count: num(e.count, 1),
      at: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp,
    }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/* ─────────────────────────── builds ─────────────────────────── */

export type BuildState = 'succeeded' | 'failed' | 'running' | 'cancelled' | 'unknown'

export interface BuildRow {
  name: string
  namespace: string
  state: BuildState
  message?: string
  started?: string
  finished?: string
  durationMs?: number
  revision?: string
  /** The console's own view of the run (Develop → Builds). */
  href: string
}

function param(run: PipelineRunLike, name: string): string | undefined {
  const v = run.spec?.params?.find((p) => p.name === name)?.value
  return typeof v === 'string' ? v : undefined
}

/** Is this CI run for `app`? app-ci labels it `adhar.io/app`; older runs only carry the `repo-name` param. */
export function isRunForApp(run: PipelineRunLike, app: string): boolean {
  const l = run.metadata.labels ?? {}
  if (l[LABEL.ciApp]) return l[LABEL.ciApp] === app
  return l['tekton.dev/pipeline'] === 'app-ci' && param(run, 'repo-name') === app
}

export function buildState(run: PipelineRunLike): BuildState {
  const c = condition(run.status?.conditions, 'Succeeded')
  if (!c || c.status === 'Unknown') return run.status?.startTime ? 'running' : 'unknown'
  if (c.status === 'True') return 'succeeded'
  return /cancel/i.test(c.reason ?? '') ? 'cancelled' : 'failed'
}

export function buildRows(runs: readonly PipelineRunLike[] | undefined, app: string): BuildRow[] {
  return (runs ?? [])
    .filter((r) => isRunForApp(r, app))
    .map((r) => {
      const started = r.status?.startTime ?? r.metadata.creationTimestamp
      const finished = r.status?.completionTime
      const ns = r.metadata.namespace ?? ''
      return {
        name: r.metadata.name,
        namespace: ns,
        state: buildState(r),
        message: condition(r.status?.conditions, 'Succeeded')?.message,
        started,
        finished,
        durationMs: started && finished ? Math.max(0, Date.parse(finished) - Date.parse(started)) : undefined,
        revision: param(r, 'revision'),
        href: `/develop?section=builds&run=${encodeURIComponent(`${ns}/${r.metadata.name}`)}`,
      }
    })
    .sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''))
}

/* ─────────────────────────── delivery (Kargo) ─────────────────────────── */

export interface DeliveryRow {
  env: string
  stage?: string
  shape?: 'shared' | 'per-app'
  phase?: string
  health?: string
  /** This application's freight in the stage, as a person reads it (`orders 3ba0d88`). */
  freight?: string
  lastPromoted?: string
  lastPromotionPhase?: string
  verification?: string
  /** A promotion of THIS app is running. */
  promoting: boolean
  /** The shared stage is busy promoting another app. */
  busyWithOther: boolean
}

/**
 * This application's place in its project's promotion chain, one row per
 * environment, for both Kargo shapes (the project's shared stage per
 * environment, or the app's own `<app>-<env>` stage) — the same model the
 * catalog's Deploy tab reads (`kargo.appStage`).
 */
export function deliveryRows(
  stages: readonly kargo.Stage[] | undefined,
  freight: readonly kargo.Freight[] | undefined,
  project: string | undefined,
  app: string,
  envs: readonly string[],
): DeliveryRow[] {
  if (!project) return envs.map((env) => ({ env, promoting: false, busyWithOther: false }))
  const groups = kargo.groupStagesByEnvironment([...(stages ?? [])], project, [...envs])
  const byId = new Map((freight ?? []).map((f) => [f.id, f]))
  return envs.map((env) => {
    const view = kargo.appStage(groups.get(env), app, byId)
    if (!view) return { env, promoting: false, busyWithOther: false }
    const st = view.stage
    const f = view.freight ? byId.get(view.freight) : undefined
    const mine = view.shape === 'per-app' || lower(st.lastPromotionOrigin) === lower(app) ||
      (Boolean(st.lastPromotionFreight) && st.lastPromotionFreight === view.freight)
    return {
      env,
      stage: st.name,
      shape: view.shape,
      phase: st.phase,
      health: st.health,
      freight: f ? kargo.freightDisplayName(f) : view.freight?.slice(0, 12),
      lastPromoted: mine ? st.lastPromoted : undefined,
      lastPromotionPhase: mine ? st.lastPromotionPhase : undefined,
      verification: st.verification?.phase,
      promoting: Boolean(view.promotion),
      busyWithOther: Boolean(view.busyWithOther),
    }
  })
}

/* ─────────────────────────── source repository ─────────────────────────── */

export interface RepoRef {
  org: string
  repo: string
  /** The repository's browser URL (public Gitea), when it can be built. */
  webUrl?: string
}

/**
 * The repository behind an Application, from its `source.repoURL`. The
 * control plane may record Gitea by its in-cluster address; a person needs
 * the public one (`giteaPublicUrl`).
 */
export function repoFromUrl(raw: string | undefined, giteaPublicUrl = ''): RepoRef | undefined {
  const v = (raw ?? '').trim().replace(/\.git$/, '')
  if (!v) return undefined
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return undefined
  }
  const [org, repo] = u.pathname.replace(/^\/+/, '').split('/')
  if (!org || !repo) return undefined
  const internal = /^gitea-http\./.test(u.hostname) || u.hostname.endsWith('.svc') || u.hostname.endsWith('.svc.cluster.local')
  const base = internal ? giteaPublicUrl.replace(/\/+$/, '') : u.origin
  return { org, repo, webUrl: base ? `${base}/${org}/${repo}` : undefined }
}

/** The overlay that deploys the function into `env` (`deploy/envs/<env>`). */
export function overlayDir(env: string, manifestPath = 'deploy'): string {
  return `${manifestPath.replace(/\/+$/, '')}/envs/${env}`
}

/** A folder of the repository in Gitea's web UI. */
export function giteaTreeUrl(webUrl: string, branch: string, path: string): string {
  return `${webUrl.replace(/\/+$/, '')}/src/branch/${encodeURIComponent(branch)}/${path.replace(/^\/+/, '')}`
}

/* ─────────────────────────── change through a pull request ─────────────────────────── */

export interface ScaleOverrides {
  minScale: number
  maxScale: number
  timeoutSeconds: number
  targetConcurrency: number
  /** Environment variables the function should have. */
  env: Record<string, string>
  /** Variables to remove (set to null in the merge patch). */
  removeEnv: string[]
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What is wrong with the overrides, in words — empty when they are valid. */
export function validateOverrides(o: ScaleOverrides): string[] {
  const errs: string[] = []
  const int = (v: number) => Number.isInteger(v)
  if (!int(o.minScale) || o.minScale < 0) errs.push('Min scale must be a whole number, 0 or more.')
  if (!int(o.maxScale) || o.maxScale < 1) errs.push('Max scale must be a whole number, 1 or more.')
  if (int(o.minScale) && int(o.maxScale) && o.minScale > o.maxScale) errs.push('Min scale cannot exceed max scale.')
  if (!int(o.timeoutSeconds) || o.timeoutSeconds < 1 || o.timeoutSeconds > 600) {
    errs.push('Timeout must be between 1 and 600 seconds (Knative refuses more).')
  }
  if (!int(o.targetConcurrency) || o.targetConcurrency < 1) errs.push('Target concurrency must be a whole number, 1 or more.')
  for (const k of [...Object.keys(o.env), ...o.removeEnv]) {
    if (!ENV_NAME.test(k)) errs.push(`"${k}" is not a valid environment variable name.`)
  }
  return errs
}

/** The patch file the console owns in an overlay, one per function. */
export function overridesFileName(name: string): string {
  return `function-${name}.patch.yaml`
}

/** A YAML double-quoted scalar (JSON's string escaping is valid YAML). */
function yamlString(v: string): string {
  return JSON.stringify(v)
}

/**
 * The merge patch over the Function in one overlay. Kustomize applies a
 * patch to a custom resource as a JSON merge patch, so a key set to `null`
 * removes it — which is how a deleted environment variable is expressed.
 */
export function overridesPatchYaml(name: string, o: ScaleOverrides): string {
  const lines = [
    '# Written by the Adhar console (Functions → Configuration → Change scale, timeout or env).',
    '# A merge patch over the Function this overlay deploys — reviewed as a pull request,',
    '# because Argo CD would put back any edit made to the live object.',
    'apiVersion: platform.adhar.io/v1alpha1',
    'kind: Function',
    'metadata:',
    `  name: ${name}`,
    'spec:',
    '  parameters:',
    `    minScale: ${o.minScale}`,
    `    maxScale: ${o.maxScale}`,
    `    targetConcurrency: ${o.targetConcurrency}`,
    `    timeoutSeconds: ${o.timeoutSeconds}`,
  ]
  const keys = Object.keys(o.env).sort()
  const removed = o.removeEnv.filter((k) => !(k in o.env)).sort()
  if (keys.length || removed.length) {
    lines.push('    env:')
    for (const k of keys) lines.push(`      ${k}: ${yamlString(o.env[k])}`)
    for (const k of removed) lines.push(`      ${k}: null`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * The overlay's `kustomization.yaml` with `file` listed under `patches:`.
 * Unchanged when it is already listed; a `patches:` block gets the entry at
 * its own indentation; no `patches:` at all gets one appended. `null` when the
 * file uses a form this cannot edit safely (a flow-style list) — the page then
 * sends the person to edit it in Git rather than rewriting their YAML.
 */
export function withPatchReference(kustomization: string, file: string): string | null {
  const text = kustomization.replace(/\r\n/g, '\n')
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(^|\\s)(-\\s*)?(path:\\s*)?["']?(\\./)?${escaped}["']?\\s*$`, 'm').test(text)) return kustomization
  const lines = text.split('\n')
  const at = lines.findIndex((l) => /^patches:\s*(#.*)?$/.test(l) || /^patches:\s*\[\s*\]\s*$/.test(l))
  if (at === -1) {
    if (lines.some((l) => /^patches:/.test(l))) return null
    const body = text.endsWith('\n') || text === '' ? text : `${text}\n`
    return `${body}patches:\n  - path: ${file}\n`
  }
  if (/\[\s*\]/.test(lines[at])) {
    lines[at] = 'patches:'
    lines.splice(at + 1, 0, `  - path: ${file}`)
    return lines.join('\n')
  }
  const next = lines.slice(at + 1).find((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  const indent = next && /^\s*-\s/.test(next) ? (next.match(/^(\s*)-/)?.[1] ?? '  ') : '  '
  lines.splice(at + 1, 0, `${indent}- path: ${file}`)
  return lines.join('\n')
}

/** A branch name for the pull request: `functions/<name>-<env>-<stamp>`. */
export function overridesBranch(name: string, env: string, now = Date.now()): string {
  const slug = `${name}-${env}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
  return `functions/${slug || 'change'}-${now.toString(36)}`
}

/* ─────────────────────────── metrics ─────────────────────────── */

export interface FunctionMetricQuery {
  id: 'rps' | 'errors' | 'p95' | 'cpu' | 'memory'
  title: string
  unit: 'req/s' | 'ms' | 'cores' | 'bytes'
  hint: string
  query: string
}

const promStr = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * PromQL for one function. Knative's request metrics changed names when it
 * moved to OpenTelemetry (1.18): the OTel histogram
 * `http_server_request_duration_seconds` labelled `k8s_namespace_name` /
 * `kn_service_name`, and before it `revision_request_*` labelled
 * `namespace_name` / `service_name`. Each query asks for both with `or`, so
 * whichever the cluster exports answers. CPU and memory come from cAdvisor,
 * which is always scraped, for the user container of the function's pods
 * (`<name>-<5 digit generation>-deployment-…`).
 */
export function functionMetricQueries(namespace: string, name: string): FunctionMetricQuery[] {
  const ns = promStr(namespace)
  const svc = promStr(name)
  const otel = `k8s_namespace_name="${ns}",kn_service_name="${svc}"`
  const legacy = `namespace_name="${ns}",service_name="${svc}"`
  const pods = `namespace="${ns}",pod=~"${svc}-[0-9]+-deployment-.+",container="${USER_CONTAINER}"`
  return [
    {
      id: 'rps',
      title: 'Requests',
      unit: 'req/s',
      hint: 'Requests the function served, per second.',
      query: `sum(rate(http_server_request_duration_seconds_count{${otel}}[5m])) or sum(rate(revision_request_count{${legacy}}[5m]))`,
    },
    {
      id: 'errors',
      title: 'Errors (5xx)',
      unit: 'req/s',
      hint: 'Responses with a 5xx status, per second.',
      query: `sum(rate(http_server_request_duration_seconds_count{${otel},http_response_status_code=~"5.."}[5m])) or sum(rate(revision_request_count{${legacy},response_code_class="5xx"}[5m]))`,
    },
    {
      id: 'p95',
      title: 'Latency p95',
      unit: 'ms',
      hint: '95th percentile request duration.',
      query: `1000 * histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{${otel}}[5m]))) or histogram_quantile(0.95, sum by (le) (rate(revision_request_latencies_bucket{${legacy}}[5m])))`,
    },
    {
      id: 'cpu',
      title: 'CPU',
      unit: 'cores',
      hint: 'CPU used by the function container, all pods.',
      query: `sum(rate(container_cpu_usage_seconds_total{${pods}}[5m]))`,
    },
    {
      id: 'memory',
      title: 'Memory',
      unit: 'bytes',
      hint: 'Working set of the function container, all pods.',
      query: `sum(container_memory_working_set_bytes{${pods}})`,
    },
  ]
}

/* ─────────────────────────── invoke (browser side) ─────────────────────────── */

/**
 * `Name: value` lines → headers. Blank lines and `#` comments are skipped;
 * a line without a colon is reported, not guessed at. The server validates
 * again (function-invoke-model.ts) — this only gives the person early words.
 */
export function parseHeaderLines(text: string): { headers: Record<string, string>; errors: string[] } {
  const headers: Record<string, string> = {}
  const errors: string[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const at = line.indexOf(':')
    if (at <= 0) {
      errors.push(`Line ${i + 1}: expected "Name: value".`)
      return
    }
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  })
  return { headers, errors }
}

/** A response body as it should be read: JSON indented, anything else as it came. */
export function prettyBody(body: string, contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase()
  const looksJson = ct.includes('json') || /^\s*[[{]/.test(body)
  if (!looksJson) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

/** `/develop?section=functions&fn=<ns>/<name>` ⇄ `{ namespace, name }`. */
export function functionRef(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

export function parseFunctionRef(ref: string | undefined): { namespace: string; name: string } | null {
  if (!ref) return null
  const i = ref.indexOf('/')
  if (i <= 0 || i === ref.length - 1) return null
  return { namespace: ref.slice(0, i), name: ref.slice(i + 1) }
}
