import { type argocd, kargo } from '@adhar/api-clients'
import {
  type Condition,
  composedRefs,
  conditionsOf,
  isProviderKubernetesObject,
  type KObj,
  type ObjRef,
  wrappedManifest,
} from './catalog-composition-model.ts'
import { envOrder } from './catalog-deployment.ts'

/**
 * Why a platform Application is (not yet) deployed — the pure half.
 *
 * An Application XR (`platform.adhar.io/v1alpha1`, in `adhar-system`) is
 * composed by `application-multienv` into, per environment of its Project:
 *
 *   - a provider-kubernetes Object wrapping the Argo CD Application
 *     `<project>-<app>-<env>` (namespace adhar-system),
 *   - its Kargo promotion through the environment: the project's SHARED
 *     Stage `<env>` (one per project environment, one freight origin per app —
 *     the target shape) or, until the platform moves, its own Stage
 *     `<app>-<env>` — plus AnalysisTemplate `<app>-<env>-health`, in the Kargo
 *     project namespace `<project>`,
 *
 * plus one Warehouse `<app>` and a Grafana dashboard ConfigMap. Nothing is
 * rendered until the Project has been observed AND reports environments, so
 * "no Argo CD app" usually means "the Project has no environments" or "an
 * Object failed to apply" — and those are what this diagnoses, instead of the
 * generic "not deployed" dead end.
 */

export type PieceState = 'live' | 'composed' | 'failing' | 'missing'

export interface Piece {
  kind: 'Application' | 'Stage' | 'AnalysisTemplate' | 'Warehouse'
  name: string
  namespace: string
  state: PieceState
  /** Why it is failing or missing, from the Object's own conditions when it has them. */
  reason?: string
}

export interface EnvDiagnosis {
  env: string
  /** The environment's namespace, from the Project. */
  namespace?: string
  app: Piece
  stage: Piece
  analysis: Piece
}

export type DeliveryPhase = 'ready' | 'setting-up' | 'failed' | 'blocked'

export interface DeliveryDiagnosis {
  phase: DeliveryPhase
  headline: string
  detail?: string
  xr: { name: string; namespace: string; phase?: string; message?: string; composition?: string }
  conditions: Condition[]
  project: { name: string; found: boolean; environments: Array<{ name: string; namespace?: string }> }
  /**
   * The application's own `spec.parameters.environments`, when set. Deprecated:
   * environments are the project's, and a current control plane ignores it
   * (`wantedIgnored`); an older one still filters by it.
   */
  wanted: string[]
  wantedIgnored: boolean
  /** Environments the application asks for that its Project does not have. */
  unknownEnvs: string[]
  /** The control plane's `ProjectEnvironments` condition, when it reports one (Inherited | OverrideIgnored). */
  inheritance?: { reason: string; message?: string }
  envs: EnvDiagnosis[]
  warehouse: Piece
  /** Composed Objects reporting Synced/Ready = False, with their messages. */
  objectErrors: Array<{ name: string; wraps?: string; reason?: string; message: string }>
}

interface XrParams {
  project?: string
  environments?: Array<{ name?: string }>
}

function params(xr: KObj): XrParams {
  return ((xr.spec ?? {}) as { parameters?: XrParams }).parameters ?? {}
}

/** The control plane maps `default` (and nothing) to the platform project. */
export function projectOf(xr: KObj): string {
  const p = (params(xr).project ?? '').trim()
  return !p || p === 'default' ? 'adhar' : p
}

/**
 * The condition that says something is WRONG: Synced=False always (the
 * provider could not apply it), Ready=False only with an explanation — a
 * bare `Creating` is an object still coming up, not a failure.
 */
function falseCond(list: readonly Condition[]): Condition | undefined {
  return list.find((c) => c.type === 'Synced' && c.status === 'False')
    ?? list.find((c) => c.type === 'Ready' && c.status === 'False' && Boolean(c.message) && c.reason !== 'Creating')
}

function firstLine(s: string | undefined, max = 280): string | undefined {
  if (!s) return undefined
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * The XR that represents `entity` — matched on its own name (case-insensitive),
 * or the name the entity declares via `adhar.io/application` / `adhar.io/xr`.
 */
export function findApplicationXR(
  xrs: readonly KObj[] | undefined,
  entityName: string,
  annotations: Record<string, string> = {},
): KObj | undefined {
  const want = [annotations['adhar.io/xr'], annotations['adhar.io/application'], entityName]
    .map((n) => (n ?? '').trim().toLowerCase())
    .filter(Boolean)
  for (const n of want) {
    const hit = (xrs ?? []).find((x) => x.metadata.name.toLowerCase() === n)
    if (hit) return hit
  }
  return undefined
}

export interface DiagnoseInput {
  xr: KObj
  /** `undefined` while unknown; `null` when the read said it does not exist. */
  project: KObj | null | undefined
  /** The XR's composed provider-kubernetes Objects. */
  objects: readonly KObj[]
  argoApps: readonly argocd.Application[]
  stages: readonly kargo.Stage[]
}

export function diagnoseDelivery({ xr, project, objects, argoApps, stages }: DiagnoseInput): DeliveryDiagnosis {
  const app = xr.metadata.name
  const proj = projectOf(xr)
  const xrStatus = (xr.status ?? {}) as { phase?: string; message?: string }
  const conditions = conditionsOf(xr)
  const cp = ((xr.spec ?? {}).crossplane ?? {}) as { compositionRef?: { name?: string } }
  const composition = cp.compositionRef?.name ?? ((xr.spec ?? {}).compositionRef as { name?: string } | undefined)?.name

  const projEnvs = (((project?.status ?? {}) as { environments?: Array<{ name?: string; namespace?: string }> }).environments ?? [])
    .filter((e): e is { name: string; namespace?: string } => Boolean(e?.name))
  const wanted = (params(xr).environments ?? []).map((e) => (e?.name ?? '').trim()).filter(Boolean)
  // A current control plane publishes the app's environments itself
  // (`status.environments[]`: name, namespace, argoApplication, stage) — always
  // the project's, the app's own list ignored. An older one still filters.
  const published = ((xrStatus as { environments?: unknown }).environments ?? []) as Array<{ name?: string; namespace?: string; argoApplication?: string; stage?: string }>
  const fromStatus = Array.isArray(published) && published.some((e) => e?.name)
  const inheritCond = conditions.find((c) => c.type === 'ProjectEnvironments')
  const wantedIgnored = fromStatus || Boolean(inheritCond)
  const expected: Array<{ name: string; namespace?: string; argoApplication?: string; stage?: string }> = fromStatus
    ? published.filter((e): e is (typeof published)[number] & { name: string } => Boolean(e?.name)).map((e) => ({ ...e, namespace: e.namespace ?? projEnvs.find((p) => p.name === e.name)?.namespace }))
    : projEnvs.filter((e) => wantedIgnored || !wanted.length || wanted.includes(e.name))
  const unknownEnvs = wantedIgnored ? [] : wanted.filter((w) => projEnvs.length && !projEnvs.some((e) => e.name === w))

  // What each composed Object wraps, so a piece can be told "composed" from "missing".
  const refs = new Set(composedRefs(xr).map((r: ObjRef) => r.name))
  const wraps = new Map<string, KObj>()
  const objectErrors: DeliveryDiagnosis['objectErrors'] = []
  for (const o of objects) {
    if (!isProviderKubernetesObject({ apiVersion: o.apiVersion, kind: o.kind ?? '' })) continue
    const mine = refs.has(o.metadata.name) || o.metadata.labels?.['crossplane.io/composite'] === app
    if (!mine) continue
    const w = wrappedManifest(o)
    if (w) wraps.set(`${w.kind}/${w.name}`, o)
    const bad = falseCond(conditionsOf(o))
    if (bad) {
      objectErrors.push({
        name: o.metadata.name,
        ...(w ? { wraps: `${w.kind} ${w.name}` } : {}),
        ...(bad.reason ? { reason: bad.reason } : {}),
        message: firstLine(bad.message) ?? bad.reason ?? 'not ready',
      })
    }
  }

  const piece = (kind: Piece['kind'], name: string, namespace: string, live: boolean): Piece => {
    const o = wraps.get(`${kind}/${name}`)
    if (live) return { kind, name, namespace, state: 'live' }
    if (o) {
      const bad = falseCond(conditionsOf(o))
      return bad
        ? { kind, name, namespace, state: 'failing', reason: firstLine(bad.message) ?? bad.reason }
        : { kind, name, namespace, state: 'composed' }
    }
    return { kind, name, namespace, state: 'missing' }
  }
  const argoNames = new Set(argoApps.map((a) => a.metadata.name))
  const stageKeys = new Set(stages.map((s) => `${s.project}/${s.name}`))
  const groups = kargo.groupStagesByEnvironment([...stages], proj, projEnvs.map((e) => e.name))

  const envs: EnvDiagnosis[] = expected
    .map((e) => {
      const appName = e.argoApplication || `${proj}-${app}-${e.name}`
      // The project's shared stage when it requests this app's freight, else the app's own.
      const view = kargo.appStage(groups.get(e.name.toLowerCase()), app)
      const shared = view?.shape === 'shared' || (Boolean(e.stage) && e.stage === e.name)
      const stageName = e.stage || (view ? view.stage.name : `${app}-${e.name}`)
      // An Object that is Ready means the manifest exists in the cluster even
      // when the Argo CD API does not list it (its token cannot see the project).
      const argoObj = wraps.get(`Application/${appName}`)
      const argoLive = argoNames.has(appName) || Boolean(argoObj && conditionsOf(argoObj).some((c) => c.type === 'Ready' && c.status === 'True'))
      return {
        env: e.name,
        ...(e.namespace ? { namespace: e.namespace } : {}),
        app: piece('Application', appName, 'adhar-system', argoLive),
        stage: piece('Stage', stageName, proj, stageKeys.has(`${proj}/${stageName}`)),
        // Shared shape: ONE `<env>-health` per environment (per-app metrics
        // inside), composed by the project with its stage.
        analysis: shared
          ? { kind: 'AnalysisTemplate' as const, name: `${e.name}-health`, namespace: proj, state: stageKeys.has(`${proj}/${stageName}`) ? 'live' as const : 'missing' as const }
          : piece('AnalysisTemplate', `${app}-${e.name}-health`, proj, false),
      }
    })
    .sort((a, b) => envOrder(a.env) - envOrder(b.env))
  // AnalysisTemplates are not listed anywhere else: "composed" is as live as it gets.
  for (const e of envs) if (e.analysis.state === 'composed') e.analysis.state = 'live'
  const warehouse = piece('Warehouse', app, proj, false)
  if (warehouse.state === 'composed') warehouse.state = 'live'

  const synced = conditions.find((c) => c.type === 'Synced')
  const ready = conditions.find((c) => c.type === 'Ready')
  const xrInfo = { name: app, namespace: xr.metadata.namespace ?? '', ...(xrStatus.phase ? { phase: xrStatus.phase } : {}), ...(xrStatus.message ? { message: xrStatus.message } : {}), ...(composition ? { composition } : {}) }
  const base = { xr: xrInfo, conditions, project: { name: proj, found: project !== null, environments: projEnvs }, wanted, unknownEnvs, wantedIgnored, ...(inheritCond?.reason ? { inheritance: { reason: inheritCond.reason, ...(inheritCond.message ? { message: inheritCond.message } : {}) } } : {}), envs, warehouse, objectErrors }

  if (project === null) {
    return { ...base, phase: 'blocked', headline: `Project ${proj} does not exist`, detail: `Application ${app} belongs to project ${proj}, which is not in ${xrInfo.namespace}. Create the project, or point the application at an existing one.` }
  }
  if (synced?.status === 'False') {
    return { ...base, phase: 'failed', headline: 'Delivery failed', detail: firstLine(synced.message) ?? synced.reason }
  }
  if (project && !projEnvs.length) {
    return { ...base, phase: 'blocked', headline: `Project ${proj} has no environments`, detail: 'Nothing is composed until the project publishes its environments — add one in Platform → Environments.' }
  }
  if (project && !expected.length) {
    return { ...base, phase: 'blocked', headline: 'No environment selected', detail: `The application asks for ${wanted.join(', ')}, and project ${proj} has ${projEnvs.map((e) => e.name).join(', ')}.` }
  }
  const failing = envs.flatMap((e) => [e.app, e.stage]).filter((p) => p.state === 'failing')
  if (failing.length || objectErrors.length) {
    return { ...base, phase: 'failed', headline: 'Delivery failed', detail: failing[0]?.reason ?? objectErrors[0]?.message }
  }
  const allLive = envs.length > 0 && envs.every((e) => e.app.state === 'live')
  if (allLive && ready?.status !== 'False') {
    const hidden = envs.filter((e) => !argoNames.has(e.app.name))
    if (hidden.length) {
      return { ...base, phase: 'failed', headline: 'Argo CD does not list the applications', detail: `${hidden.map((e) => e.app.name).join(', ')} exist in the cluster, but the Argo CD API did not return them — the console's Argo CD account probably lacks access to project ${proj}.` }
    }
    return { ...base, phase: 'ready', headline: 'Delivery is set up' }
  }
  return {
    ...base,
    phase: 'setting-up',
    headline: 'Delivery is being set up',
    detail: firstLine(ready?.message) ?? xrStatus.message ?? (project === undefined ? 'Reading the project…' : undefined),
  }
}

/** Per-environment expectations for `withExpectedEnvs`, with a reason when the Argo CD app is not live. */
export function expectedEnvs(d: DeliveryDiagnosis | undefined): Array<{ env: string; namespace?: string; appProblem?: string }> {
  return (d?.envs ?? []).map((e) => ({
    env: e.env,
    ...(e.namespace ? { namespace: e.namespace } : {}),
    ...(e.app.state === 'live'
      ? {}
      : {
        appProblem: e.app.state === 'failing'
          ? `no Argo CD app yet — ${e.app.reason ?? 'its Object is failing'}`
          : e.app.state === 'composed'
            ? `no Argo CD app yet — ${e.app.name} is composed and waiting to be applied`
            : `no Argo CD app yet — ${d?.phase === 'failed' ? 'the composition failed (see Delivery)' : d?.phase === 'blocked' ? (d.headline.toLowerCase()) : 'not composed yet'}`,
      }),
  }))
}

/* ─────────── Kargo authorisation ─────────── */

/**
 * Kargo refuses to touch an Argo CD Application that does not name the Stage
 * in `kargo.akuity.io/authorized-stage: <project>:<stage>`. A missing or wrong
 * annotation makes every promotion fail at its last step AFTER pushing.
 */
export function authorisationProblem(app: argocd.Application | undefined, stage: kargo.Stage | undefined): string | undefined {
  if (!app || !stage) return undefined
  // Both forms are valid: `<project>:<env>` (the project's shared stage) and
  // `<project>:<app>-<env>` (the app's own stage, until the platform moves).
  const labels = app.metadata.labels ?? {}
  const application = labels['adhar.io/application'] ?? kargo.stageApplication(stage) ?? ''
  const env = labels['adhar.io/environment'] ?? stage.labels?.['adhar.io/environment'] ?? stage.name
  return kargo.authorizedStageProblem(app, { project: stage.project, app: application, env, stage })
}

export function isAuthorisationError(message: string | undefined): boolean {
  return Boolean(message && /not authorized|authorized-stage|unauthori[sz]ed/i.test(message))
}

/* ─────────── rollout / workload ─────────── */

export interface WorkloadStatus {
  kind: 'Rollout' | 'Deployment'
  name: string
  namespace: string
  /** Healthy / Progressing / Paused / Degraded (Rollout), or Available / Progressing (Deployment). */
  phase: string
  paused: boolean
  aborted: boolean
  step?: { index: number; total: number }
  canaryWeight?: number
  strategy?: 'canary' | 'blueGreen' | 'rolling'
  replicas: { desired: number; ready: number; updated: number; available: number }
  message?: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function workloadStatus(obj: KObj): WorkloadStatus | undefined {
  const kind = obj.kind
  const spec = (obj.spec ?? {}) as Record<string, unknown>
  const st = (obj.status ?? {}) as Record<string, unknown>
  const replicas = {
    desired: spec.replicas === undefined ? 1 : num(spec.replicas),
    ready: num(st.readyReplicas),
    updated: num(st.updatedReplicas),
    available: num(st.availableReplicas),
  }
  const base = { name: obj.metadata.name, namespace: obj.metadata.namespace ?? '', replicas }
  if (kind === 'Rollout') {
    const strat = (spec.strategy ?? {}) as { canary?: { steps?: unknown[] }; blueGreen?: unknown }
    const steps = strat.canary?.steps?.length ?? 0
    const idx = st.currentStepIndex
    const weights = (st.canary as { weights?: { canary?: { weight?: number } } } | undefined)?.weights
    const pauses = Array.isArray(st.pauseConditions) ? st.pauseConditions : []
    const aborted = Boolean(st.abort)
    const paused = Boolean(spec.paused) || pauses.length > 0 || st.phase === 'Paused'
    return {
      kind: 'Rollout',
      ...base,
      phase: aborted ? 'Aborted' : String(st.phase ?? (paused ? 'Paused' : 'Unknown')),
      paused,
      aborted,
      ...(steps && typeof idx === 'number' ? { step: { index: Math.min(idx, steps), total: steps } } : {}),
      ...(typeof weights?.canary?.weight === 'number' ? { canaryWeight: weights.canary.weight } : {}),
      strategy: strat.canary ? 'canary' : strat.blueGreen ? 'blueGreen' : 'rolling',
      ...(typeof st.message === 'string' && st.message ? { message: st.message } : {}),
    }
  }
  if (kind === 'Deployment') {
    const conds = conditionsOf(obj)
    const progressing = conds.find((c) => c.type === 'Progressing')
    const available = conds.find((c) => c.type === 'Available')
    const done = replicas.updated >= replicas.desired && replicas.available >= replicas.desired
    return {
      kind: 'Deployment',
      ...base,
      phase: progressing?.reason === 'ProgressDeadlineExceeded' ? 'Degraded' : done ? 'Available' : 'Progressing',
      paused: Boolean(spec.paused),
      aborted: false,
      strategy: 'rolling',
      ...(progressing?.status === 'False' || available?.status === 'False' ? { message: progressing?.message ?? available?.message } : {}),
    }
  }
  return undefined
}

/** One line for an env card: "Paused · step 2/4 · canary 20% · 3/3 ready". */
export function describeWorkload(w: WorkloadStatus): string {
  const parts: string[] = [w.phase]
  if (w.step) parts.push(`step ${w.step.index}/${w.step.total}`)
  if (w.canaryWeight !== undefined && w.canaryWeight > 0 && w.canaryWeight < 100) parts.push(`canary ${w.canaryWeight}%`)
  parts.push(`${w.replicas.ready}/${w.replicas.desired} ready`)
  return parts.join(' · ')
}

/** The service's workload in a namespace: named for it, or labelled for it. Rollout before Deployment. */
export function pickWorkload(objs: readonly KObj[], app: string, namespace: string): WorkloadStatus | undefined {
  const n = app.toLowerCase()
  const mine = objs.filter((o) => (o.metadata.namespace ?? '') === namespace && (
    o.metadata.name.toLowerCase() === n || (o.metadata.labels?.['adhar.io/application'] ?? '').toLowerCase() === n || (o.metadata.labels?.['app.kubernetes.io/name'] ?? '').toLowerCase() === n
  ))
  const rollout = mine.find((o) => o.kind === 'Rollout')
  return workloadStatus(rollout ?? mine.find((o) => o.kind === 'Deployment') ?? ({ metadata: { name: '' } } as KObj))
}

/* ─────────── releases ─────────── */

export interface Release {
  promotion: string
  env: string
  stage: string
  phase: kargo.Promotion['phase']
  created: string
  finished?: string
  actor?: string
  /** The commit the promotion pushed to the environment's overlay. */
  promotionCommit?: string
  freight?: { id: string; label: string; imageTag?: string; digest?: string; sourceCommit?: string }
  verified: boolean
  message?: string
}

/** `email:alice@x` / `subject:…` / the controller → a short name. */
export function actorLabel(actor: string | undefined): string | undefined {
  if (!actor) return undefined
  if (/kargo/i.test(actor) && /controller|api|system/i.test(actor)) return 'auto-promotion'
  return actor.replace(/^(email|subject|sub|name):/, '')
}

/**
 * Promotions into this service's stages, newest first, joined with their
 * freight. In a stage shared by the project, only THIS application's
 * promotions (by the promoted freight's origin) — never another service's.
 */
export function releaseHistory(
  stages: ReadonlyArray<{ stage: kargo.Stage; env: string; shared?: boolean }>,
  promotions: readonly kargo.Promotion[] | undefined,
  freight: readonly kargo.Freight[] | undefined,
  app?: string,
): Release[] {
  const byStage = new Map(stages.map((s) => [`${s.stage.project}/${s.stage.name}`, s]))
  const fById = new Map((freight ?? []).map((f) => [f.id, f]))
  const mine = (p: kargo.Promotion) => {
    const s = byStage.get(`${p.project}/${p.stage}`)
    if (!s) return false
    if (!s.shared || !app) return true
    return kargo.promotionApp(p, fById) === app.toLowerCase()
  }
  return (promotions ?? [])
    .filter(mine)
    .map((p) => {
      const s = byStage.get(`${p.project}/${p.stage}`)!
      const f = fById.get(p.freight)
      const img = f?.images[0]
      return {
        promotion: p.name,
        env: s.env,
        stage: p.stage,
        phase: p.phase,
        created: p.created,
        ...(p.finished ? { finished: p.finished } : {}),
        ...(actorLabel(p.actor) ? { actor: actorLabel(p.actor) } : {}),
        ...(p.commit ? { promotionCommit: p.commit } : {}),
        freight: {
          id: p.freight,
          label: f ? kargo.freightDisplayName(f) : p.freight.slice(0, 12),
          ...(img?.tag ? { imageTag: img.tag } : {}),
          ...(img?.digest ? { digest: img.digest } : {}),
          ...(f?.commits?.[0]?.id ? { sourceCommit: f.commits[0].id } : img?.tag && /^[0-9a-f]{40}$/i.test(img.tag) ? { sourceCommit: img.tag } : {}),
        },
        verified: Boolean(f?.verifiedIn?.includes(p.stage)),
        ...(p.message ? { message: p.message } : {}),
      }
    })
    .sort((a, b) => b.created.localeCompare(a.created))
}
