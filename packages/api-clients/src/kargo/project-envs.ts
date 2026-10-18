import type { Freight, Promotion, Stage } from './index.ts'

/**
 * Project environments — the one model every console surface uses to answer
 * "what is application X running in environment Y of project P".
 *
 * Environments belong to the PROJECT (`platform.adhar.io/v1alpha1` Project,
 * `status.environments`: name, namespace `<project>-<env>`, order). Every
 * application in the project deploys into the same dev → test → prod; an app
 * does not own environments of its own.
 *
 * Kargo has two shapes for that, and both are live while the platform moves
 * from one to the other:
 *
 *  - **shared** (target): one Stage per environment in the Kargo project
 *    namespace `<project>`, named after the environment (`dev`, `test`, …),
 *    labelled `adhar.io/stage-scope: project` and WITHOUT
 *    `adhar.io/application`. It requests freight from one Warehouse per app
 *    (`Warehouse/<app>`), so its current freight is a collection keyed by
 *    origin — one entry per application. A promotion moves ONE app's freight.
 *    The app's Argo CD app authorises `<project>:<env>`.
 *  - **per-app** (current): a Stage `<app>-<env>` per application labelled
 *    `adhar.io/application` + `adhar.io/environment`; authorises
 *    `<project>:<app>-<env>`.
 *
 * Pure (no React, no fetch) so the Deliver module and the console app share it
 * and it is unit-tested once.
 */

export const LABEL_PROJECT = 'adhar.io/project'
export const LABEL_APPLICATION = 'adhar.io/application'
export const LABEL_ENVIRONMENT = 'adhar.io/environment'
export const LABEL_STAGE_SCOPE = 'adhar.io/stage-scope'
export const AUTHORIZED_STAGE = 'kargo.akuity.io/authorized-stage'

/**
 * Promotion order of an environment key — dev → test → prod. Unknown keys sort
 * between the known pre-production tiers and production. (The same rule as
 * apps/console `catalog-env-order.ts`.)
 */
export function envOrder(key: string): number {
  const k = key.toLowerCase()
  if (k === 'dev' || k === 'development') return 0
  if (k === 'sandbox' || k === 'preview') return 1
  if (k === 'qa' || k === 'test') return 2
  if (k === 'uat') return 3
  if (k.startsWith('stag') || k === 'stg') return 4
  if (k === 'canary') return 5
  if (k.startsWith('prod')) return 7
  return 6
}

/* ─────────── projects ─────────── */

export interface ProjectEnv {
  name: string
  /** Where the project's apps run in this environment (`<project>-<env>` by convention). */
  namespace: string
  order: number
  /** Human-readable guardrails the project declares for this environment (approval, quota, …). */
  guardrails: string[]
}

/** The minimal Project XR shape read here. */
export interface ProjectLike {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
}

type Loose = Record<string, unknown>

const asObj = (v: unknown): Loose | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined)

/** Short guardrail phrases from whatever the project declares — never invented. */
export function guardrailsOf(e: Loose | undefined): string[] {
  if (!e) return []
  const out: string[] = []
  const flag = (...keys: string[]) => keys.map((k) => e[k]).find((v) => v !== undefined)
  const auto = flag('autoPromote', 'autoPromotion', 'auto')
  if (auto === true) out.push('auto-promote')
  else if (auto === false) out.push('manual promotion')
  const approval = flag('requireApproval', 'approvalRequired', 'approval', 'approvals')
  if (approval === true || (typeof approval === 'number' && approval > 0)) out.push('approval required')
  else if (Array.isArray(approval) && approval.length) out.push(`approval: ${approval.join(', ')}`)
  if (e.protected === true) out.push('protected')
  if (e.freeze === true || e.frozen === true) out.push('change freeze')
  const quota = asObj(flag('quota', 'resourceQuota', 'quotas'))
  if (quota) {
    const parts = ['cpu', 'memory', 'pods'].map((k) => (quota[k] !== undefined ? `${k} ${String(quota[k])}` : '')).filter(Boolean)
    out.push(parts.length ? `quota ${parts.join(' · ')}` : 'quota')
  }
  const policies = flag('policies', 'policy', 'policyPacks')
  if (Array.isArray(policies) && policies.length) out.push(`policy: ${policies.map(String).join(', ')}`)
  else if (typeof policies === 'string' && policies) out.push(`policy: ${policies}`)
  const net = flag('networkPolicy', 'isolation')
  if (typeof net === 'string' && net) out.push(`network: ${net}`)
  else if (net === true) out.push('network isolated')
  const verify = flag('verification', 'analysis')
  if (verify === true || asObj(verify) || (typeof verify === 'string' && verify)) out.push('verification')
  return out
}

/**
 * The project's environments in promotion order: `status.environments` (the
 * control plane's published list), with guardrails merged from the matching
 * `spec.parameters.environments[]` entry when the project declares any.
 */
export function projectEnvironments(project: ProjectLike | null | undefined): ProjectEnv[] {
  if (!project) return []
  const name = project.metadata.name
  const st = (asObj(project.status)?.environments ?? []) as unknown[]
  const params = asObj(asObj(project.spec)?.parameters)
  const declared = ((params?.environments ?? asObj(project.spec)?.environments ?? []) as unknown[])
    .map(asObj)
    .filter((e): e is Loose => Boolean(e))
  const list = (Array.isArray(st) ? st : []).map(asObj).filter((e): e is Loose => Boolean(e && typeof e.name === 'string' && e.name))
  return list
    .map((e, i) => {
      const env = String(e.name)
      const spec = declared.find((d) => d.name === env)
      const order = typeof e.order === 'number' ? e.order : typeof spec?.order === 'number' ? spec.order : i
      return {
        name: env,
        namespace: typeof e.namespace === 'string' && e.namespace ? e.namespace : `${name}-${env}`,
        order,
        guardrails: [...new Set([...guardrailsOf(e), ...guardrailsOf(spec)])],
      }
    })
    .sort((a, b) => a.order - b.order || envOrder(a.name) - envOrder(b.name) || a.name.localeCompare(b.name))
}

/* ─────────── stages ─────────── */

const lower = (v: string | undefined) => (v ?? '').trim().toLowerCase()

/** The application a per-app stage belongs to; `undefined` for a shared stage. */
export function stageApplication(s: Pick<Stage, 'labels'>): string | undefined {
  return lower(s.labels?.[LABEL_APPLICATION]) || undefined
}

/** True for the project's shared stage of an environment (the target shape). */
export function isSharedStage(s: Pick<Stage, 'labels'>): boolean {
  if (lower(s.labels?.[LABEL_STAGE_SCOPE]) === 'project') return true
  return !stageApplication(s)
}

/** The Kargo stages of a project: its namespace, or labelled for it. */
export function stagesOfProject<T extends Pick<Stage, 'project' | 'labels'>>(stages: readonly T[], project: string): T[] {
  const p = lower(project)
  return stages.filter((s) => lower(s.project) === p || lower(s.labels?.[LABEL_PROJECT]) === p)
}

export interface EnvStages {
  env: string
  /** The project's shared stage for this environment (target shape). */
  shared?: Stage
  /** Per-application stages (current shape), keyed by application. */
  perApp: Record<string, Stage>
}

/**
 * Group a project's stages into its environments, for BOTH shapes.
 *
 * Labels decide when present (`adhar.io/environment`, `adhar.io/application`).
 * An unlabelled stage is read by name against the known environments: exactly
 * `<env>` is the shared stage, `<app>-<env>` is that app's stage. A stage that
 * fits no known environment is kept under its own name rather than dropped.
 */
export function groupStagesByEnvironment(
  stages: readonly Stage[],
  project: string,
  envNames: readonly string[] = [],
): Map<string, EnvStages> {
  const known = envNames.map(lower)
  const out = new Map<string, EnvStages>()
  const slot = (env: string) => {
    let g = out.get(env)
    if (!g) out.set(env, (g = { env, perApp: {} }))
    return g
  }
  for (const s of stagesOfProject(stages, project)) {
    const name = lower(s.name)
    const app = stageApplication(s)
    let env = lower(s.labels?.[LABEL_ENVIRONMENT])
    if (app) {
      if (!env) env = name.startsWith(`${app}-`) ? name.slice(app.length + 1) : known.find((k) => name.endsWith(`-${k}`)) ?? name
      slot(env).perApp[app] = s
      continue
    }
    if (env || known.includes(name)) {
      const g = slot(env || name)
      // Two shared candidates: the explicitly scoped one wins.
      if (!g.shared || lower(s.labels?.[LABEL_STAGE_SCOPE]) === 'project') g.shared = s
      continue
    }
    const suffix = known.find((k) => name.endsWith(`-${k}`))
    if (suffix) {
      slot(suffix).perApp[name.slice(0, -(suffix.length + 1))] = s
      continue
    }
    slot(name).shared ??= s
  }
  return out
}

/** Does a shared stage carry this application (by its requested origins or current freight)? */
export function stageCarriesApp(s: Stage, app: string): boolean {
  const a = lower(app)
  if (s.origins?.some((o) => lower(o) === a)) return true
  if (s.freightByOrigin && Object.keys(s.freightByOrigin).some((o) => lower(o) === a)) return true
  return false
}

/** The freight THIS app is running in a stage: its own origin's entry, never another app's. */
export function appFreightInStage(s: Stage, app: string): string | undefined {
  const a = lower(app)
  const hit = Object.entries(s.freightByOrigin ?? {}).find(([o]) => lower(o) === a)?.[1]
  if (hit) return hit
  if (isSharedStage(s)) {
    // A shared stage reports a single `currentFreight` too — it is only this
    // app's when the stage requests freight from this app alone.
    const origins = s.origins ?? []
    return origins.length === 1 && lower(origins[0]) === a && !s.freightByOrigin ? s.currentFreight : undefined
  }
  return s.currentFreight
}

export interface AppStage {
  app: string
  env: string
  shape: 'shared' | 'per-app'
  stage: Stage
  /** This app's current freight in the stage. */
  freight?: string
  /** The running promotion, when it is this app's. */
  promotion?: string
  /** A promotion is running in the stage for ANOTHER app (shared shape only). */
  busyWithOther?: boolean
}

/**
 * The stage an app is promoted through in an environment, plus what it holds
 * for that app. The shared stage wins when it lists the app (the target
 * shape); the app's own stage is the fallback (current shape). A shared stage
 * that does not list the app is not this app's.
 */
export function appStage(
  group: EnvStages | undefined,
  app: string,
  freightById?: ReadonlyMap<string, Pick<Freight, 'warehouse'>>,
): AppStage | undefined {
  if (!group) return undefined
  const a = lower(app)
  const own = Object.entries(group.perApp).find(([k]) => lower(k) === a)?.[1]
  const shared = group.shared && stageCarriesApp(group.shared, a) ? group.shared : undefined
  const stage = shared ?? own
  if (!stage) return undefined
  const shape = shared ? 'shared' : 'per-app'
  let promotion: string | undefined
  let busyWithOther = false
  if (stage.currentPromotion) {
    if (shape === 'per-app') promotion = stage.currentPromotion
    else {
      const origin = stage.currentPromotionOrigin
        ?? (stage.currentPromotionFreight ? freightById?.get(stage.currentPromotionFreight)?.warehouse : undefined)
      if (origin && lower(origin) === a) promotion = stage.currentPromotion
      else busyWithOther = true
    }
  }
  return { app: a, env: group.env, shape, stage, freight: appFreightInStage(stage, a), promotion, busyWithOther }
}

/** The application a promotion moved: its recorded origin, else its freight's warehouse. */
export function promotionApp(p: Pick<Promotion, 'origin' | 'freight'>, freightById?: ReadonlyMap<string, Pick<Freight, 'warehouse'>>): string | undefined {
  return lower(p.origin ?? freightById?.get(p.freight)?.warehouse) || undefined
}

/** Promotions of THIS app into its stage, newest first. In a shared stage, other apps' are excluded. */
export function appPromotions(
  view: AppStage,
  promotions: readonly Promotion[] | undefined,
  freightById?: ReadonlyMap<string, Pick<Freight, 'warehouse'>>,
): Promotion[] {
  return (promotions ?? [])
    .filter((p) => p.project === view.stage.project && p.stage === view.stage.name)
    .filter((p) => view.shape === 'per-app' || promotionApp(p, freightById) === view.app)
    .sort((x, y) => y.created.localeCompare(x.created))
}

/**
 * The freight `view.app` may be promoted to in its stage, newest first.
 *
 * Only the app's own freight (origin `Warehouse/<app>`) — offering another
 * application's freight in a shared stage would promote the wrong service.
 * Kargo's rule then applies: verified in an upstream stage, or approved for
 * this one; an entry stage takes whatever the warehouse discovered.
 */
export function promotableFreightForApp(view: AppStage, freight: readonly Freight[] | undefined): Freight[] {
  const { stage, app } = view
  const ups = stage.upstream ?? []
  return (freight ?? [])
    .filter((f) => !f.project || !stage.project || f.project === stage.project)
    .filter((f) => {
      const origin = lower(f.warehouse)
      return origin === app || (view.shape === 'per-app' && Boolean(stage.warehouse) && origin === lower(stage.warehouse))
    })
    .filter((f) => f.id !== view.freight)
    .filter((f) => (f.approvedFor ?? []).includes(stage.name) || !ups.length || ups.some((u) => (f.verifiedIn ?? []).includes(u)))
    .sort((x, y) => y.created.localeCompare(x.created))
}

/* ─────────── Argo CD authorisation ─────────── */

/** The `kargo.akuity.io/authorized-stage` values that let Kargo update `<project>-<app>-<env>`, new shape first. */
export function authorizedStageValues(project: string, app: string, env: string): string[] {
  return [`${project}:${env}`, `${project}:${app}-${env}`]
}

/**
 * Whether an Argo CD app's `authorized-stage` lets the stage that promotes it
 * update it: `<project>:<env>` (shared) or `<project>:<app>-<env>` (per-app),
 * or exactly the stage it is actually promoted through.
 */
export function isAuthorizedStage(
  value: string | undefined,
  ctx: { project: string; app: string; env: string; stage?: Pick<Stage, 'project' | 'name'> },
): boolean {
  const v = (value ?? '').trim()
  if (!v) return false
  if (ctx.stage && v === `${ctx.stage.project}:${ctx.stage.name}`) return true
  return authorizedStageValues(ctx.project, ctx.app, ctx.env).includes(v)
}

/**
 * Why Kargo would refuse to update an Argo CD app, or `undefined` when it would
 * not (or when the annotations were not read — their absence is not evidence).
 */
export function authorizedStageProblem(
  argoApp: Pick<ArgoAppLike, 'metadata'> | undefined,
  ctx: { project: string; app: string; env: string; stage?: Pick<Stage, 'project' | 'name'> },
): string | undefined {
  if (!argoApp || !ctx.stage || !argoApp.metadata.annotations) return undefined
  const have = argoApp.metadata.annotations[AUTHORIZED_STAGE]
  const want = `${ctx.stage.project}:${ctx.stage.name}`
  if (!have) return `${argoApp.metadata.name} is missing ${AUTHORIZED_STAGE}: ${want}, so Kargo cannot update it.`
  if (!isAuthorizedStage(have, ctx)) return `${argoApp.metadata.name} authorises ${have}, not ${want}, so Kargo cannot update it.`
  return undefined
}

/* ─────────── versions across environments ─────────── */

/** The minimal Argo CD Application shape read here (`argocd.Application` satisfies it). */
export interface ArgoAppLike {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> }
  spec: { destination: { namespace?: string } }
  status: {
    sync: { status: string; revision?: string }
    health: { status: string; message?: string }
    images?: string[]
    operationState?: { phase?: string; finishedAt?: string; startedAt?: string }
  }
}

/** The Argo CD app `<project>-<app>-<env>` (by labels, else by name). */
export function argoAppFor<T extends ArgoAppLike>(apps: readonly T[], project: string, app: string, env: string): T | undefined {
  const [p, a, e] = [lower(project), lower(app), lower(env)]
  return apps.find((x) => {
    const l = x.metadata.labels ?? {}
    return lower(l[LABEL_APPLICATION]) === a && lower(l[LABEL_ENVIRONMENT]) === e && (!l[LABEL_PROJECT] || lower(l[LABEL_PROJECT]) === p)
  }) ?? apps.find((x) => lower(x.metadata.name) === `${p}-${a}-${e}`)
}

export interface CellVersion {
  /** Comparison identity — two cells run the same thing when their keys match. */
  key: string
  /** What to print: alias, image tag or short revision. */
  label: string
  freight?: string
  alias?: string
  tag?: string
  commit?: string
}

export interface MatrixCell {
  app: string
  env: string
  namespace?: string
  argoApp?: string
  health?: string
  sync?: string
  version?: CellVersion
  stage?: AppStage
  /** Last promotion of THIS app into this environment. */
  lastPromotion?: { name: string; phase: Promotion['phase']; at: string; message?: string }
  /**
   * Set when this environment runs something different from the environment
   * before it (or nothing while it has something): the env it differs from.
   */
  driftFrom?: string
  /** Set when Kargo is not authorised to update this env's Argo CD app. */
  authProblem?: string
}

export interface MatrixRow {
  app: string
  cells: MatrixCell[]
  /** Environments that differ from their upstream neighbour. */
  drifted: string[]
}

export interface ProjectMatrix {
  project: string
  envs: ProjectEnv[]
  apps: string[]
  rows: MatrixRow[]
  groups: Map<string, EnvStages>
  /** Which Kargo shape the project uses right now. */
  shape: 'shared' | 'per-app' | 'mixed' | 'none'
}

export interface ProjectMatrixInput {
  project: string
  /** From `projectEnvironments`; when empty, environments are derived from stages and Argo CD labels. */
  envs: readonly ProjectEnv[]
  stages: readonly Stage[]
  freight?: readonly Freight[]
  promotions?: readonly Promotion[]
  argoApps: readonly ArgoAppLike[]
  /** Applications known from elsewhere (Application XRs, Warehouses). */
  extraApps?: readonly string[]
}

const shortSha = (s?: string) => (s && /^[0-9a-f]{12,}$/i.test(s) ? s.slice(0, 7) : s)

/** `repo/name:tag@sha256:…` → its tag (or a short digest). */
export function imageTag(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const [noDigest, digest] = ref.split('@')
  const slash = noDigest.lastIndexOf('/')
  const colon = noDigest.lastIndexOf(':')
  if (colon > slash) return noDigest.slice(colon + 1)
  return digest ? digest.replace(/^sha256:/, '').slice(0, 12) : undefined
}

function freightVersion(f: Freight | undefined, id: string): CellVersion {
  const img = f?.images?.[0]
  const commit = f?.commits?.[0]?.id
  return {
    key: `freight:${id}`,
    label: f?.alias ?? img?.tag ?? shortSha(commit) ?? id.slice(0, 12),
    freight: id,
    ...(f?.alias ? { alias: f.alias } : {}),
    ...(img?.tag ? { tag: img.tag } : {}),
    ...(commit ? { commit } : {}),
  }
}

function argoVersion(a: ArgoAppLike): CellVersion | undefined {
  const img = a.status.images?.[0]
  if (img) {
    const tag = imageTag(img)
    return { key: `image:${img}`, label: shortSha(tag) ?? img, ...(tag ? { tag } : {}) }
  }
  const rev = a.status.sync.revision
  return rev ? { key: `rev:${rev}`, label: shortSha(rev) ?? rev, commit: rev } : undefined
}

/** Applications of a project, from every source that names them. */
export function projectApps(input: Omit<ProjectMatrixInput, 'envs'> & { envs?: readonly ProjectEnv[] }, groups?: Map<string, EnvStages>): string[] {
  const p = lower(input.project)
  const set = new Set<string>()
  const envs = (input.envs ?? []).map((e) => lower(e.name))
  for (const a of input.argoApps) {
    const l = a.metadata.labels ?? {}
    const app = lower(l[LABEL_APPLICATION])
    if (app && lower(l[LABEL_PROJECT]) === p) {
      set.add(app)
      continue
    }
    const n = lower(a.metadata.name)
    const env = envs.find((e) => n.startsWith(`${p}-`) && n.endsWith(`-${e}`) && n.length > p.length + e.length + 2)
    if (env && !l[LABEL_APPLICATION]) set.add(n.slice(p.length + 1, -(env.length + 1)))
  }
  for (const g of (groups ?? groupStagesByEnvironment([...input.stages], input.project, envs)).values()) {
    for (const k of Object.keys(g.perApp)) set.add(lower(k))
    for (const o of g.shared?.origins ?? []) set.add(lower(o))
    for (const o of Object.keys(g.shared?.freightByOrigin ?? {})) set.add(lower(o))
  }
  for (const x of input.extraApps ?? []) if (x) set.add(lower(x))
  return [...set].sort()
}

/**
 * Every application of a project × every environment: what version each runs,
 * its health and sync, its last promotion, and where it differs from the
 * environment upstream of it.
 */
export function buildProjectMatrix(input: ProjectMatrixInput): ProjectMatrix {
  const project = input.project
  const freightById = new Map((input.freight ?? []).map((f) => [f.id, f]))
  let envs = [...input.envs]
  const groups = groupStagesByEnvironment([...input.stages], project, envs.map((e) => e.name))
  if (!envs.length) {
    // No Project XR to read: the environments the stages and Argo CD apps declare.
    const names = new Set<string>(groups.keys())
    for (const a of input.argoApps) {
      const l = a.metadata.labels ?? {}
      if (lower(l[LABEL_PROJECT]) === lower(project) && l[LABEL_ENVIRONMENT]) names.add(lower(l[LABEL_ENVIRONMENT]))
    }
    envs = [...names]
      .sort((a, b) => envOrder(a) - envOrder(b) || a.localeCompare(b))
      .map((name, order) => ({ name, namespace: `${project}-${name}`, order, guardrails: [] }))
  }
  const apps = projectApps({ ...input, envs }, groups)

  let sharedSeen = false
  let perAppSeen = false
  const rows: MatrixRow[] = apps.map((app) => {
    const cells: MatrixCell[] = envs.map((e) => {
      const view = appStage(groups.get(lower(e.name)), app, freightById)
      if (view?.shape === 'shared') sharedSeen = true
      if (view?.shape === 'per-app') perAppSeen = true
      const argo = argoAppFor(input.argoApps, project, app, e.name)
      const version = view?.freight ? freightVersion(freightById.get(view.freight), view.freight) : argo ? argoVersion(argo) : undefined
      const last = view ? appPromotions(view, input.promotions, freightById)[0] : undefined
      const authProblem = authorizedStageProblem(argo, { project, app, env: e.name, stage: view?.stage })
      const stageLast = view && (view.shape === 'per-app' || lower(view.stage.lastPromotionOrigin) === app) && view.stage.lastPromoted
        ? { name: '', phase: (view.stage.lastPromotionPhase ?? 'Succeeded') as Promotion['phase'], at: view.stage.lastPromoted }
        : undefined
      return {
        app,
        env: e.name,
        namespace: argo?.spec.destination.namespace || e.namespace,
        ...(argo ? { argoApp: argo.metadata.name, health: argo.status.health.status, sync: argo.status.sync.status } : {}),
        ...(version ? { version } : {}),
        ...(view ? { stage: view } : {}),
        ...(authProblem ? { authProblem } : {}),
        ...(last
          ? { lastPromotion: { name: last.name, phase: last.phase, at: last.finished ?? last.created, ...(last.message ? { message: last.message } : {}) } }
          : stageLast ? { lastPromotion: stageLast } : {}),
      }
    })
    const drifted = markDrift(cells)
    return { app, cells, drifted }
  })

  const shape = sharedSeen && perAppSeen ? 'mixed' : sharedSeen ? 'shared' : perAppSeen ? 'per-app' : 'none'
  return { project, envs, apps, rows, groups, shape }
}

/**
 * Mark each cell that runs something other than its upstream neighbour. The
 * first environment has no upstream; an environment that has never received
 * anything while upstream has is drift too (it has not been promoted yet).
 */
export function markDrift(cells: MatrixCell[]): string[] {
  const out: string[] = []
  for (let i = 1; i < cells.length; i++) {
    const up = cells[i - 1]
    const here = cells[i]
    if (!up.version) continue
    if (!here.version || here.version.key !== up.version.key) {
      here.driftFrom = up.env
      out.push(here.env)
    }
  }
  return out
}
