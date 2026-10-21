import type { argoRollouts } from '@adhar/api-clients'
import { readRollout, type RolloutPhase, type RolloutView, type Strategy } from './rollout-state.ts'

/**
 * Rollouts grouped by APPLICATION.
 *
 * On Adhar an application is deployed once per project environment — the
 * shared dev → test → prod, namespaces `<project>-<env>` — so one app owns
 * several Rollout objects, usually with the same name in different
 * namespaces. The page used to list each of them as its own card, so one
 * app showed up three times and nothing said they were the same thing.
 *
 * Identity, in order of trust:
 *   1. `adhar.io/application` (+ `adhar.io/project`, `adhar.io/environment`)
 *      on the Rollout, else on its pod template;
 *   2. the owning Argo CD Application (tracking-id annotation, instance label,
 *      or the app's managed-resource list) and ITS adhar.io labels;
 *   3. the Rollout's own name, with project/env read off the namespace.
 *
 * JSX-free and fetch-free so it is unit-tested.
 */

export const LABEL_PROJECT = 'adhar.io/project'
export const LABEL_APPLICATION = 'adhar.io/application'
export const LABEL_ENVIRONMENT = 'adhar.io/environment'
const TRACKING_ID = 'argocd.argoproj.io/tracking-id'
const INSTANCE = 'app.kubernetes.io/instance'
const REVISION = 'rollout.argoproj.io/revision'

type Loose = Record<string, unknown>
const asObj = (v: unknown): Loose | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strMap = (v: unknown): Record<string, string> => {
  const o = asObj(v)
  if (!o) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(o)) if (typeof val === 'string') out[k] = val
  return out
}

/**
 * Promotion order of an environment key — dev → test → prod. Unknown keys
 * sort between the known pre-production tiers and production. (The same rule
 * as apps/console `catalog-env-order.ts`; copied, not imported, because a
 * remote module never imports across the host boundary.)
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

const KNOWN_ENVS = ['dev', 'development', 'sandbox', 'preview', 'qa', 'test', 'uat', 'staging', 'stage', 'stg', 'canary', 'prod', 'production']

/** `<project>-<env>` → env, when the namespace follows the convention. */
export function envFromNamespace(namespace: string, project?: string): { project?: string; env?: string } {
  if (project && namespace.startsWith(`${project}-`)) {
    const env = namespace.slice(project.length + 1)
    if (env) return { project, env }
  }
  const i = namespace.lastIndexOf('-')
  if (i > 0) {
    const suffix = namespace.slice(i + 1).toLowerCase()
    if (KNOWN_ENVS.includes(suffix)) return { project: project ?? namespace.slice(0, i), env: suffix }
  }
  return { project }
}

/* ─────────── images ─────────── */

export interface ContainerImage {
  container: string
  image: string
  /** Repository without tag or digest. */
  repo: string
  /** Tag, else a short digest, else `latest`. */
  tag: string
}

export function parseImage(container: string, image: string): ContainerImage {
  let rest = image
  let digest: string | undefined
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  const slash = rest.lastIndexOf('/')
  const colon = rest.lastIndexOf(':')
  let tag: string | undefined
  if (colon > slash) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  const short = digest ? digest.replace(/^sha256:/, '').slice(0, 12) : undefined
  return { container, image, repo: rest, tag: tag ?? (short ? `@${short}` : 'latest') }
}

/** Every container image of a pod template (init containers excluded — they are not the version). */
export function templateImages(template: unknown): ContainerImage[] {
  const spec = asObj(asObj(template)?.spec)
  return asArr(spec?.containers)
    .map((c) => asObj(c))
    .filter((c): c is Loose => Boolean(c && asStr(c.image)))
    .map((c) => parseImage(asStr(c.name) ?? 'main', asStr(c.image)!))
}

/* ─────────── identity ─────────── */

/** The slice of an Argo CD Application identity resolution reads. */
export interface ArgoAppLike {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: { project?: string }
  status?: { resourceList?: Array<{ kind?: string; name?: string; namespace?: string }> }
}

export interface RolloutIdentity {
  app: string
  project?: string
  env: string
  /** True when the environment came from a label rather than the namespace. */
  envLabelled: boolean
  argoApp?: string
}

function rawMeta(r: argoRollouts.Rollout) {
  const m = r.metadata as unknown as Loose
  return { labels: strMap(m.labels), annotations: strMap(m.annotations), uid: asStr(m.uid) }
}

function templateLabels(r: argoRollouts.Rollout): Record<string, string> {
  const spec = r.spec as unknown as Loose
  return strMap(asObj(asObj(spec.template)?.metadata)?.labels)
}

/** The Argo CD Application that manages this Rollout, if any. */
export function owningArgoApp(r: argoRollouts.Rollout, apps: ArgoAppLike[]): ArgoAppLike | undefined {
  if (!apps.length) return undefined
  const { labels, annotations } = rawMeta(r)
  const byName = (n?: string) => (n ? apps.find((a) => a.metadata.name === n) : undefined)
  const tracked = annotations[TRACKING_ID]?.split(':')[0]
  return byName(tracked) ??
    byName(labels[INSTANCE]) ??
    apps.find((a) =>
      (a.status?.resourceList ?? []).some((x) =>
        x.kind === 'Rollout' && x.name === r.metadata.name && x.namespace === r.metadata.namespace
      )
    )
}

export function identifyRollout(r: argoRollouts.Rollout, apps: ArgoAppLike[] = []): RolloutIdentity {
  const { labels } = rawMeta(r)
  const tpl = templateLabels(r)
  const argo = owningArgoApp(r, apps)
  const al = argo?.metadata.labels ?? {}
  const pick = (k: string) => labels[k] || tpl[k] || al[k] || undefined

  const app = pick(LABEL_APPLICATION) ?? r.metadata.name
  const argoProject = argo?.spec?.project && argo.spec.project !== 'default' ? argo.spec.project : undefined
  const labelledProject = pick(LABEL_PROJECT)
  const labelledEnv = pick(LABEL_ENVIRONMENT)
  const fromNs = envFromNamespace(r.metadata.namespace, labelledProject ?? argoProject)
  return {
    app,
    project: labelledProject ?? argoProject ?? fromNs.project,
    env: labelledEnv ?? fromNs.env ?? r.metadata.namespace,
    envLabelled: Boolean(labelledEnv),
    argoApp: argo?.metadata.name,
  }
}

/* ─────────── the per-environment entry ─────────── */

export interface AnalysisRef {
  kind: 'step' | 'background' | 'pre-promotion' | 'post-promotion'
  name: string
  status: string
  message?: string
}

export interface RolloutCondition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface RolloutEnv {
  /** `<namespace>/<name>` — unique. */
  id: string
  env: string
  namespace: string
  name: string
  argoApp?: string
  view: RolloutView
  raw: argoRollouts.Rollout
  /** `rollout.argoproj.io/revision` — the revision currently being rolled out. */
  revision?: number
  images: ContainerImage[]
  /** The primary container's tag — the version, at a glance. */
  tag?: string
  analysis: AnalysisRef[]
  conditions: RolloutCondition[]
  currentPodHash?: string
  stableRS?: string
}

export function analysisRefs(status: unknown): AnalysisRef[] {
  const st = asObj(status)
  const out: AnalysisRef[] = []
  const push = (kind: AnalysisRef['kind'], v: unknown) => {
    const o = asObj(v)
    const name = asStr(o?.name)
    if (o && name) out.push({ kind, name, status: asStr(o.status) ?? 'Pending', message: asStr(o.message) })
  }
  const canary = asObj(st?.canary)
  push('step', canary?.currentStepAnalysisRunStatus)
  push('background', canary?.currentBackgroundAnalysisRunStatus)
  const bg = asObj(st?.blueGreen)
  push('pre-promotion', bg?.prePromotionAnalysisRunStatus)
  push('post-promotion', bg?.postPromotionAnalysisRunStatus)
  return out
}

export function rolloutConditions(status: unknown): RolloutCondition[] {
  return asArr(asObj(status)?.conditions)
    .map((c) => asObj(c))
    .filter((c): c is Loose => Boolean(c && asStr(c.type)))
    .map((c) => ({
      type: asStr(c.type)!,
      status: asStr(c.status) ?? 'Unknown',
      reason: asStr(c.reason),
      message: asStr(c.message),
      lastTransitionTime: asStr(c.lastTransitionTime),
    }))
}

export function readRolloutEnv(r: argoRollouts.Rollout, id: RolloutIdentity): RolloutEnv {
  const { annotations } = rawMeta(r)
  const spec = r.spec as unknown as Loose
  const images = templateImages(spec.template)
  const rev = Number(annotations[REVISION])
  return {
    id: `${r.metadata.namespace}/${r.metadata.name}`,
    env: id.env,
    namespace: r.metadata.namespace,
    name: r.metadata.name,
    argoApp: id.argoApp,
    view: readRollout(r),
    raw: r,
    revision: Number.isFinite(rev) && rev > 0 ? rev : undefined,
    images,
    tag: images[0]?.tag,
    analysis: analysisRefs(r.status),
    conditions: rolloutConditions(r.status),
    currentPodHash: r.status.currentPodHash,
    stableRS: r.status.stableRS,
  }
}

/* ─────────── the application ─────────── */

export interface RolloutApp {
  /** `<project|namespace>/<app>` — also the deep-link value. */
  key: string
  app: string
  project?: string
  /** Project when known, else the namespace (platform packages). */
  scope: string
  strategy: Strategy | 'mixed'
  /** dev → test → prod. */
  envs: RolloutEnv[]
  /** The worst phase across environments. */
  phase: RolloutPhase
  aborted: boolean
  /** Lower is more urgent; see `attentionRank`. */
  rank: number
}

/** Needs-a-human first. An abort outranks every phase. */
const PHASE_RANK: Record<RolloutPhase, number> = {
  Degraded: 0,
  Paused: 1,
  Progressing: 2,
  Unknown: 3,
  Healthy: 4,
}

export function attentionRank(v: RolloutView): number {
  return v.aborted ? -1 : PHASE_RANK[v.phase] ?? 5
}

export function groupRollouts(rollouts: argoRollouts.Rollout[], apps: ArgoAppLike[] = []): RolloutApp[] {
  const groups = new Map<string, { app: string; project?: string; scope: string; envs: RolloutEnv[] }>()
  for (const r of rollouts) {
    const id = identifyRollout(r, apps)
    const scope = id.project ?? r.metadata.namespace
    const key = `${scope}/${id.app}`
    const g = groups.get(key) ?? { app: id.app, project: id.project, scope, envs: [] }
    g.envs.push(readRolloutEnv(r, id))
    groups.set(key, g)
  }
  return [...groups.entries()].map(([key, g]) => {
    const envs = g.envs.sort((a, b) =>
      envOrder(a.env) - envOrder(b.env) || a.env.localeCompare(b.env) || a.name.localeCompare(b.name)
    )
    const strategies = new Set(envs.map((e) => e.view.strategy))
    const worst = envs.reduce((w, e) => (attentionRank(e.view) < attentionRank(w.view) ? e : w), envs[0])
    return {
      key,
      app: g.app,
      project: g.project,
      scope: g.scope,
      strategy: strategies.size === 1 ? envs[0].view.strategy : 'mixed',
      envs,
      phase: worst.view.phase,
      aborted: envs.some((e) => e.view.aborted),
      rank: Math.min(...envs.map((e) => attentionRank(e.view))),
    }
  })
}

export function byAppAttention(a: RolloutApp, b: RolloutApp): number {
  return a.rank - b.rank || a.app.localeCompare(b.app) || a.scope.localeCompare(b.scope)
}

/** Label for an env inside its app — the Rollout name is added only when one env holds two Rollouts. */
export function envLabel(app: RolloutApp, e: RolloutEnv): string {
  const twins = app.envs.filter((x) => x.env === e.env).length > 1
  return twins ? `${e.env} · ${e.name}` : e.env
}

/* ─────────── summary + filters ─────────── */

export type PhaseFilter = RolloutPhase | 'Aborted'

export interface AppSummary {
  apps: number
  envs: number
  /** Apps with at least one environment in this state, and how many envs. */
  by: Record<PhaseFilter, { apps: number; envs: number }>
}

export function envMatchesPhase(e: RolloutEnv, p: PhaseFilter): boolean {
  return p === 'Aborted' ? e.view.aborted : e.view.phase === p
}

export function summariseApps(apps: RolloutApp[]): AppSummary {
  const keys: PhaseFilter[] = ['Healthy', 'Progressing', 'Paused', 'Degraded', 'Unknown', 'Aborted']
  const by = Object.fromEntries(keys.map((k) => [k, { apps: 0, envs: 0 }])) as AppSummary['by']
  for (const a of apps) {
    for (const k of keys) {
      const n = a.envs.filter((e) => envMatchesPhase(e, k)).length
      if (n) {
        by[k].apps++
        by[k].envs += n
      }
    }
  }
  return { apps: apps.length, envs: apps.reduce((s, a) => s + a.envs.length, 0), by }
}

export interface AppFilter {
  phase?: PhaseFilter | null
  project?: string | null
  env?: string | null
  query?: string
}

export function filterApps(apps: RolloutApp[], f: AppFilter): RolloutApp[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return apps.filter((a) => {
    if (f.project && a.scope !== f.project) return false
    const envs = f.env ? a.envs.filter((e) => e.env === f.env) : a.envs
    if (!envs.length) return false
    if (f.phase && !envs.some((e) => envMatchesPhase(e, f.phase!))) return false
    if (!q) return true
    const hay = [a.app, a.scope, ...a.envs.flatMap((e) => [e.name, e.namespace, e.env, ...e.images.map((i) => i.image)])]
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
}

/** Distinct environments across apps, dev → test → prod. */
export function envOptions(apps: RolloutApp[]): string[] {
  return [...new Set(apps.flatMap((a) => a.envs.map((e) => e.env)))].sort((a, b) =>
    envOrder(a) - envOrder(b) || a.localeCompare(b)
  )
}

export function projectOptions(apps: RolloutApp[]): string[] {
  return [...new Set(apps.map((a) => a.scope))].sort()
}

/** The one-line "what needs doing" for an env, or nothing when it is fine. */
export function attentionNote(e: RolloutEnv): string | undefined {
  const v = e.view
  if (v.aborted) return 'Aborted — retry or roll forward'
  if (v.phase === 'Degraded') return 'Degraded'
  if (v.phase === 'Paused') return v.pausedReason === 'CanaryPauseStep' || !v.pausedReason ? 'Waiting for promotion' : `Paused · ${v.pausedReason}`
  if (v.phase === 'Progressing') return v.totalSteps ? `Step ${Math.min(v.currentStep + 1, v.totalSteps)} of ${v.totalSteps}` : 'Rolling out'
  return undefined
}
