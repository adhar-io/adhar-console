import { useMemo } from 'react'
import { envOrder } from './catalog-env-order.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { argocd, kargo } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'

/**
 * Live deployment / GitOps signals for the Service Catalog entity drawer.
 *
 * The drawer's "Deployment" tab shows real ArgoCD Application state for the
 * entity being viewed — sync status, health, revision, source path, and the
 * environments it rolls out to. We reuse the same BFF `argocd` proxy the rest
 * of the console uses (no MF hop) and match Applications to the entity by name
 * so the panel never shows another service's rollout.
 *
 * Matching is deliberately conservative: an Application counts as "this
 * entity's" when its name is exactly the entity name, the entity name with a
 * common environment suffix (`-prod`, `-staging`, …), or when the entity
 * declares the app explicitly via the `adhar.io/argocd-app` annotation. That
 * keeps false positives out — an unmatched entity gets an honest empty state
 * and a deep link into the GitOps view rather than a guessed rollout.
 */

const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })
const kargoClient = kargo.KargoClient.auto({ tool: 'kargo' })

const REFRESH_MS = 30_000

/** Environment suffixes we recognise on ArgoCD app names (`billing-prod`). */
const ENV_SUFFIXES = [
  'prod',
  'production',
  'staging',
  'stage',
  'stg',
  'dev',
  'development',
  'qa',
  'test',
  'uat',
  'preview',
  'canary',
  'sandbox',
] as const

/**
 * The platform's canonical environments, in promotion order.
 *
 * These mirror `globals.PlatformEnvironmentsCSV` in the platform repo and the
 * Kargo stages bootstrap creates in the `adhar-environments` project, which is
 * what an environment IS here: dev is promoted to test, and test to prod.
 */
export const PLATFORM_ENVIRONMENTS = ['dev', 'test', 'prod'] as const

const WORKLOAD_KINDS = new Set(['Deployment', 'Rollout', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'KService'])

/**
 * Where an application's workload actually runs.
 *
 * Argo CD's `destination.namespace` is only the DEFAULT for manifests that do
 * not name one. Scaffolded services pin `metadata.namespace` in their own
 * manifests (my-service: destination `default`, everything in `adhar-system`),
 * so the destination sends routes, metrics and pipeline lookups to an empty
 * namespace. The managed resources are the evidence: the workload's namespace,
 * else the Service's, else the most common one, else the destination.
 */
export function workloadNamespace(app: argocd.Application): string {
  const list = app.status.resourceList.filter((r) => r.namespace)
  const pick = (kinds: (k?: string) => boolean) => list.find((r) => kinds(r.kind))?.namespace
  const counts = new Map<string, number>()
  for (const r of list) counts.set(r.namespace!, (counts.get(r.namespace!) ?? 0) + 1)
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return pick((k) => WORKLOAD_KINDS.has(k ?? '')) ?? pick((k) => k === 'Service') ?? common ?? app.spec.destination.namespace
}

/** Pretty label for a derived environment key. */
export function envLabel(key: string): string {
  const k = key.toLowerCase()
  if (k === 'prod' || k === 'production') return 'Production'
  if (k === 'staging' || k === 'stage' || k === 'stg') return 'Staging'
  if (k === 'dev' || k === 'development') return 'Development'
  if (k === 'qa') return 'QA'
  if (k === 'uat') return 'UAT'
  if (k === 'test') return 'Test'
  if (k === 'preview') return 'Preview'
  if (k === 'canary') return 'Canary'
  if (k === 'sandbox') return 'Sandbox'
  return key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * Position of an environment along a promotion chain: dev first, prod last.
 *
 * This is the order the control plane chains Kargo stages in (the project's
 * `environments`, default dev → test → prod) and the order people read a
 * rollout in — left to right, the way a build travels. Unknown keys sort
 * between the known pre-production tiers and production.
 */
export { envOrder }

/**
 * The environment an Application belongs to, or `undefined` when nothing says.
 *
 * Authority order — the platform's own declaration first, then convention:
 *
 *   1. `adhar.io/environment`, which the control-plane compositions stamp on
 *      everything they compose. If it is present it is the answer.
 *   2. The environment suffix on the app NAME (`my-service-dev`), already
 *      matched by `matchName` and passed in as `nameSuffix`.
 *   3. An environment segment in the namespace the workload actually runs in
 *      (`shop-prod`, `prod-shop`, or exactly `prod`).
 *
 * It returns `undefined` rather than guessing, and that is the point. This
 * used to fall back to the NAMESPACE itself, which answers a different
 * question — "where does this run" written into a field that means "which
 * environment is this". Because every platform package runs in `adhar-system`,
 * a scaffolded service's bootstrap app reports `default`, and the org's home
 * namespace is `adhar`, the Deployment tab listed `Adhar-system`, `Default`
 * and `Adhar` beside the real dev/test/prod as though they were stages of a
 * promotion pipeline. They are not environments at all.
 */
export function environmentOf(app: argocd.Application, nameSuffix?: string): string | undefined {
  const declared = (app.metadata.labels?.['adhar.io/environment'] ?? '').trim().toLowerCase()
  if (declared) return declared
  if (nameSuffix) return nameSuffix
  const ns = workloadNamespace(app).toLowerCase()
  return ENV_SUFFIXES.find((s) => ns === s || ns.endsWith(`-${s}`) || ns.startsWith(`${s}-`))
}

export interface EntityEnvironment {
  /** Environment key derived from the app-name suffix or destination namespace. */
  key: string
  label: string
  app: argocd.Application
}

export interface EntityDeployment {
  /** Every ArgoCD Application confidently matched to this entity. */
  apps: argocd.Application[]
  /** Apps grouped into environments in promotion order (dev → prod). */
  environments: EntityEnvironment[]
  /**
   * Matched apps that belong to no environment — the platform's own singletons
   * and a scaffolded service's bootstrap app. Reported separately so they are
   * never drawn as if they were stages of a promotion pipeline.
   */
  unscoped: argocd.Application[]
  /** The primary app (prod if present, else the first match). */
  primary: argocd.Application | undefined
  isLoading: boolean
  isError: boolean
  /** True when the query resolved but nothing matched this entity. */
  unmatched: boolean
  /** Where the primary app's workload runs (see `workloadNamespace`). */
  namespace: string | undefined
}

function matchName(appName: string, entityName: string): { hit: boolean; env: string | undefined } {
  const a = appName.toLowerCase()
  const n = entityName.toLowerCase()
  if (a === n) return { hit: true, env: undefined }
  for (const suf of ENV_SUFFIXES) {
    if (a === `${n}-${suf}`) return { hit: true, env: suf }
  }
  return { hit: false, env: undefined }
}

/**
 * Match `apps` to `entity` and derive its environments — the pure half of
 * `useEntityDeployment`, split out so the browse grid can run it for every
 * card against ONE fetched list instead of mounting a query per card.
 */
export function deriveDeployment(
  entity: Entity,
  all: readonly argocd.Application[] | undefined,
  state: { isLoading: boolean; isError: boolean },
): EntityDeployment {
  const name = entity.metadata.name
  const explicit = (entity.metadata.annotations?.['adhar.io/argocd-app'] ?? '').trim().toLowerCase()
  const seen = new Set<string>()
  const matched: Array<{ app: argocd.Application; env: string | undefined }> = []
  for (const app of all ?? []) {
    const an = app.metadata.name.toLowerCase()
    const { hit, env } = matchName(app.metadata.name, name)
    const isExplicit = explicit && an === explicit
    // The control plane names an application's Argo CD apps
    // `<project>-<app>-<env>` and stamps every one with adhar.io/application
    // and adhar.io/environment; the name match above never saw them, so a
    // scaffolded service showed no environments at all (Azure, 2026-10-17).
    const labelled = (app.metadata.labels?.['adhar.io/application'] ?? '').toLowerCase() === name.toLowerCase()
    if ((hit || isExplicit || labelled) && !seen.has(an)) {
      seen.add(an)
      matched.push({ app, env: env ?? (labelled ? app.metadata.labels?.['adhar.io/environment']?.toLowerCase() : undefined) })
    }
  }

  // Split the matched apps into the ones whose environment is KNOWN and the
  // ones that simply do not have one. Nothing is guessed — see `environmentOf`.
  const scoped: EntityEnvironment[] = []
  const unscoped: argocd.Application[] = []
  for (const { app, env } of matched) {
    const key = environmentOf(app, env)
    if (key) scoped.push({ key, label: envLabel(key), app })
    else unscoped.push(app)
  }
  const environments = scoped.sort(
    (a, b) => envOrder(a.key) - envOrder(b.key) || a.label.localeCompare(b.label),
  )

  const apps = matched.map((m) => m.app)
  const primary =
    environments.find((e) => e.key.toLowerCase().startsWith('prod'))?.app ?? apps[0]

  return {
    apps,
    environments,
    unscoped,
    primary,
    isLoading: state.isLoading,
    isError: state.isError,
    unmatched: !state.isLoading && !state.isError && apps.length === 0,
    namespace: primary ? workloadNamespace(primary) : undefined,
  }
}

/**
 * The primary app's live resource tree — only fetched while the app is not
 * Healthy, to say which resource is failing and why.
 */
export function useResourceTree(app: argocd.Application | undefined, enabled = true) {
  const unhealthy = Boolean(app && app.status.health.status !== 'Healthy')
  return useQuery({
    queryKey: ['catalog', 'argocd', 'tree', app?.metadata.namespace, app?.metadata.name],
    queryFn: () => argocdClient.getResourceTree(app!.metadata.name, app!.metadata.namespace),
    enabled: enabled && unhealthy,
    staleTime: REFRESH_MS,
    refetchInterval: enabled && unhealthy ? REFRESH_MS : false,
    retry: 1,
  })
}

/** Unhealthy nodes, the cause before its symptoms: pods first, then their owners. */
export function unhealthyNodes(nodes: readonly argocd.ResourceNode[]): Array<{ kind: string; name: string; namespace?: string; status: string; reason: string }> {
  const bad = nodes.filter((n) => n.health?.status && !['Healthy', 'Progressing', 'Suspended'].includes(n.health.status))
  const rank = (k: string) => (k === 'Pod' ? 0 : WORKLOAD_KINDS.has(k) ? 1 : k === 'ReplicaSet' ? 3 : 2)
  return bad
    .map((n) => {
      const info = Object.fromEntries((n.info ?? []).map((i) => [i.name ?? '', i.value ?? '']))
      const reason = n.health?.message || info['Status Reason'] || ''
      return { kind: n.kind, name: n.name, namespace: n.namespace, status: n.health!.status!, reason }
    })
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name))
}

/**
 * The whole Application list, once, for a page that shows many entities.
 * Same query key as `useEntityDeployment`, so the drawer opening on a card
 * reuses the fetch rather than repeating it.
 */
export function useDeploymentIndex(enabled = true): {
  apps: argocd.Application[] | undefined
  isLoading: boolean
  isError: boolean
} {
  const q = useQuery({
    queryKey: ['catalog', 'argocd', 'apps'],
    queryFn: () => argocdClient.listApplications(),
    refetchInterval: enabled ? REFRESH_MS : false,
    staleTime: REFRESH_MS,
    enabled,
  })
  // A failed BACKGROUND refetch keeps the last good list: only a query that
  // never answered is an error.
  return { apps: q.data, isLoading: q.isLoading, isError: q.isError && !q.data }
}

/**
 * All ArgoCD Applications that belong to `entity`, plus derived environments.
 * Read-only: the drawer surfaces status and deep-links to the GitOps view for
 * actions (the catalog runs under a view-only service account).
 */
export function useEntityDeployment(entity: Entity, enabled = true): EntityDeployment {
  const q = useQuery({
    queryKey: ['catalog', 'argocd', 'apps'],
    queryFn: () => argocdClient.listApplications(),
    refetchInterval: enabled ? REFRESH_MS : false,
    staleTime: REFRESH_MS,
    enabled,
  })
  const state = { isLoading: q.isLoading, isError: q.isError && !q.data }
  return useMemo(
    () => deriveDeployment(entity, q.data, state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data, q.isLoading, q.isError, entity],
  )
}


/* ─────────── Kargo environments ─────────── */

/**
 * The environments a service is promoted through. Environments belong to the
 * service's PROJECT (dev → test → prod, shared by every app in it); the Kargo
 * state per environment is either the project's shared stage filtered to THIS
 * app's freight (target shape) or the app's own `<app>-<env>` stage (current
 * shape). See `kargo.buildProjectMatrix` in `@adhar/api-clients`.
 */
export interface KargoEnvironment {
  stage: kargo.Stage
  label: string
  /** Position along the promotion chain, entry stage first. */
  index: number
  /** The service's Argo CD app for this stage, when one can be matched. */
  app?: argocd.Application
  /** The project environment (`dev`, `test`, …). */
  env: string
  /** The project the environment belongs to, when known. */
  project?: string
  /** `shared`: the project's stage, carrying every app; `per-app`: this app's own. */
  shape: 'shared' | 'per-app'
  /** THIS application's current freight in the stage (never another app's). */
  freight?: string
  /** The running promotion, when it is this application's. */
  promotion?: string
  /** Another application's promotion is running in the shared stage. */
  busyWithOther?: boolean
  /** This application's last promotion into the stage, when the stage records it. */
  lastPromoted?: string
  lastPromotionPhase?: string
  /** The model's view of the stage for this app — what promotion candidates are computed from. */
  view: kargo.AppStage
}

/** "adhar · Development" — an environment is the project's, not the service's. */
export function projectEnvLabel(project: string | undefined, env: string): string {
  return project ? `${project} · ${envLabel(env)}` : envLabel(env)
}

/** Topological order along `upstream` edges; entry stages first, ties by name. */
export function orderKargoStages(stages: readonly kargo.Stage[]): kargo.Stage[] {
  const byName = new Map(stages.map((s) => [s.name, s]))
  const depth = new Map<string, number>()
  const visit = (s: kargo.Stage, seen: Set<string>): number => {
    if (depth.has(s.name)) return depth.get(s.name)!
    if (seen.has(s.name)) return 0
    seen.add(s.name)
    const ups = (s.upstream ?? []).map((u) => byName.get(u)).filter((u): u is kargo.Stage => Boolean(u))
    const d = ups.length ? Math.max(...ups.map((u) => visit(u, seen))) + 1 : 0
    depth.set(s.name, d)
    return d
  }
  for (const s of stages) visit(s, new Set())
  return [...stages].sort((a, b) => (depth.get(a.name) ?? 0) - (depth.get(b.name) ?? 0) || a.name.localeCompare(b.name))
}

export function useKargoStages(enabled = true) {
  return useQuery({
    queryKey: ['catalog', 'kargo', 'stages'],
    queryFn: async () => orderKargoStages(await kargoClient.listStages('')),
    refetchInterval: enabled ? REFRESH_MS : false,
    staleTime: REFRESH_MS,
    enabled,
    retry: 1,
  })
}

export interface KargoEnvironmentOptions {
  /** The service's project (Application XR `spec.parameters.project`). */
  project?: string
  /** The project's environments (`kargo.projectEnvironments(projectXR)`), in order. */
  envs?: readonly kargo.ProjectEnv[]
  /** Freight, to attribute a running promotion in a shared stage to its app. */
  freight?: readonly kargo.Freight[]
}

/**
 * This service's Kargo environments, in project environment order, each with
 * its Argo CD app.
 *
 * Project first: the project is the service's own (option, else its Argo CD
 * apps' `adhar.io/project`, else the namespace of a stage labelled for it or
 * of a shared stage that requests its warehouse, else the Argo CD AppProject
 * of its environment apps). Its stages are grouped by
 * environment for both shapes, and each environment resolves to the shared
 * stage when that stage requests this app's freight, else the app's own stage.
 * A shared stage that does not request this app is never shown as its
 * environment, and neither is another application's `<app>-<env>` stage.
 *
 * Stages composed before any label existed still match by `<app>-<env>`, and
 * an unlabelled env-named stage without origin information is shown only where
 * the service has an Argo CD app for that environment.
 */
export function kargoEnvironments(
  stages: readonly kargo.Stage[] | undefined,
  deployment: EntityDeployment | undefined,
  entityName?: string,
  opts: KargoEnvironmentOptions = {},
): KargoEnvironment[] {
  if (!stages?.length || !deployment) return []
  const application = (
    deployment.apps.map((a) => a.metadata.labels?.['adhar.io/application']).find(Boolean) ?? entityName ?? ''
  ).toLowerCase()
  if (!application) return []
  const appFor = (env: string) => deployment.environments.find((e) => e.key.toLowerCase() === env)?.app
  const freightById = new Map((opts.freight ?? []).map((f) => [f.id, f]))
  const project = opts.project
    ?? deployment.apps.map((a) => a.metadata.labels?.['adhar.io/project']).find(Boolean)
    ?? stages.find((s) => kargo.stageApplication(s) === application)?.project
    ?? stages.find((s) => kargo.isSharedStage(s) && kargo.stageCarriesApp(s, application))?.project
    // The control plane puts `<project>-<app>-<env>` in the project's own Argo CD AppProject.
    ?? deployment.environments.map((e) => e.app.spec.project).find((p) => p && p !== 'default')

  const fromView = (view: kargo.AppStage, index: number): KargoEnvironment => {
    const st = view.stage
    const mineLast = view.shape === 'per-app' || (st.lastPromotionOrigin ?? '').toLowerCase() === application ||
      (Boolean(st.lastPromotionFreight) && st.lastPromotionFreight === view.freight)
    return {
      stage: st,
      label: projectEnvLabel(project, view.env),
      index,
      app: appFor(view.env),
      env: view.env,
      ...(project ? { project } : {}),
      shape: view.shape,
      ...(view.freight ? { freight: view.freight } : {}),
      ...(view.promotion ? { promotion: view.promotion } : {}),
      ...(view.busyWithOther ? { busyWithOther: true } : {}),
      ...(mineLast && st.lastPromoted ? { lastPromoted: st.lastPromoted } : {}),
      ...(mineLast && st.lastPromotionPhase ? { lastPromotionPhase: st.lastPromotionPhase } : {}),
      view,
    }
  }

  if (project) {
    const declared = (opts.envs ?? []).map((e) => e.name.toLowerCase())
    const known = [...new Set([...declared, ...deployment.environments.map((e) => e.key.toLowerCase()), ...ENV_SUFFIXES])]
    const groups = kargo.groupStagesByEnvironment([...stages], project, known)
    const order = declared.length
      ? [...declared, ...[...groups.keys()].filter((k) => !declared.includes(k)).sort((a, b) => envOrder(a) - envOrder(b))]
      : [...groups.keys()].sort((a, b) => envOrder(a) - envOrder(b) || a.localeCompare(b))
    const views: kargo.AppStage[] = []
    for (const env of order) {
      const g = groups.get(env)
      if (!g) continue
      const view = kargo.appStage(g, application, freightById)
      if (view) {
        views.push(view)
        continue
      }
      // An env-named stage that says nothing about its origins (composed
      // before freight origins were recorded): this app's only where it
      // actually has an Argo CD app in that environment.
      const s = g.shared
      if (s && !s.origins?.length && !s.freightByOrigin && appFor(env)) {
        views.push({ app: application, env, shape: 'shared', stage: s, ...(s.currentFreight ? { freight: s.currentFreight } : {}), ...(s.currentPromotion ? { promotion: s.currentPromotion } : {}) })
      }
    }
    if (views.length) return views.map(fromView)
  }

  // Before any label existed: this app's `<app>-<env>` stages by name.
  const prefix = `${application}-`
  const legacy = stages.filter((s) => !kargo.stageApplication(s) && s.name.toLowerCase().startsWith(prefix) && appFor(s.name.toLowerCase().slice(prefix.length)))
  return legacy.map((stage, index) => {
    const env = stage.name.toLowerCase().slice(prefix.length)
    return fromView({ app: application, env, shape: 'per-app', stage, ...(stage.currentFreight ? { freight: stage.currentFreight } : {}), ...(stage.currentPromotion ? { promotion: stage.currentPromotion } : {}) }, index)
  })
}

/* ─────────── Kargo freight + promotion actions ─────────── */

/**
 * Every freight in the project, newest first. Needed to offer a promotion:
 * a Promotion names the freight it carries, so a UI that cannot list freight
 * can only ever show history.
 */
export function useKargoFreight(project: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['catalog', 'kargo', 'freight', project ?? ''],
    queryFn: () => kargoClient.listFreight(project ?? ''),
    enabled: enabled && Boolean(project),
    staleTime: REFRESH_MS,
    refetchInterval: enabled && project ? REFRESH_MS : false,
    retry: 1,
  })
}

/** Promotions in the project, newest first — the chain's recent history. */
export function useKargoPromotions(project: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['catalog', 'kargo', 'promotions', project ?? ''],
    queryFn: () => kargoClient.listPromotions(project ?? ''),
    enabled: enabled && Boolean(project),
    staleTime: REFRESH_MS,
    refetchInterval: enabled && project ? REFRESH_MS : false,
    retry: 1,
  })
}

/**
 * The freight `stage` may be promoted to, newest first.
 *
 * Kargo's rule, not ours: a stage accepts freight its UPSTREAM has verified,
 * or freight a human has explicitly approved for it (the manual override that
 * exists for exactly the case where verification cannot run). An entry stage
 * has no upstream and takes whatever its warehouse has discovered.
 *
 * Freight already current on the stage is excluded — promoting a stage to what
 * it is already running is a no-op that reads as a broken button.
 */
export function promotableFreight(
  stage: kargo.Stage,
  freight: readonly kargo.Freight[] | undefined,
): kargo.Freight[] {
  if (!freight?.length) return []
  const ups = stage.upstream ?? []
  return freight.filter((f) => {
    if (f.id === stage.currentFreight) return false
    if ((f.approvedFor ?? []).includes(stage.name)) return true
    if (!ups.length) return !stage.warehouse || f.warehouse === stage.warehouse
    return ups.some((u) => (f.verifiedIn ?? []).includes(u))
  })
}

/**
 * The freight THIS service may be promoted to in one of its environments —
 * only its own (origin `Warehouse/<app>`), even when the stage is shared by
 * the whole project, verified upstream or approved for the stage.
 */
export function promotableFreightFor(env: KargoEnvironment, freight: readonly kargo.Freight[] | undefined): kargo.Freight[] {
  return kargo.promotableFreightForApp(env.view, freight)
}

/** What a freight is called on screen: the application and its build, never Kargo's random alias. */
export function freightLabel(f: kargo.Freight): string {
  return kargo.freightDisplayName(f)
}

/** The image tags a freight carries, for telling two candidates apart. */
export function freightTags(f: kargo.Freight): string {
  return f.images.map((i) => i.tag).filter(Boolean).join(', ')
}

/**
 * The write half of the promotion chain: promote, abort, approve, refresh.
 *
 * Every mutation invalidates the Kargo queries it affects rather than patching
 * the cache — Kargo's own controller is what moves a stage, so the authority is
 * always the next read, never an optimistic guess about what it will decide.
 */
export function useKargoActions(project: string | undefined) {
  const qc = useQueryClient()
  const invalidate = () => {
    for (const k of ['stages', 'freight', 'promotions']) {
      void qc.invalidateQueries({ queryKey: ['catalog', 'kargo', k] })
    }
  }
  const promote = useMutation({
    mutationFn: ({ stage, freight }: { stage: string; freight: string }) =>
      kargoClient.promote(project ?? '', stage, freight),
    onSuccess: invalidate,
  })
  const abort = useMutation({
    mutationFn: ({ promotion }: { promotion: string }) => kargoClient.abortPromotion(project ?? '', promotion),
    onSuccess: invalidate,
  })
  const approve = useMutation({
    mutationFn: ({ stage, freight }: { stage: string; freight: string }) =>
      kargoClient.approveFreight(project ?? '', freight, stage),
    onSuccess: invalidate,
  })
  const refresh = useMutation({
    mutationFn: ({ stage }: { stage: string }) => kargoClient.refreshStage(project ?? '', stage),
    onSuccess: invalidate,
  })
  return { promote, abort, approve, refresh }
}

/**
 * The repository behind a deployment, from the Argo CD source when the catalog
 * entity itself carries no repo annotation or link. The control plane records
 * the platform's Gitea by its IN-CLUSTER address; a person needs the public one.
 */
export function repoUrlFromDeployment(deployment: EntityDeployment | undefined, giteaPublicUrl: string): string | undefined {
  const app = deployment?.primary ?? deployment?.apps[0]
  const raw = (app?.spec.source?.repoURL ?? '').trim().replace(/\.git$/, '')
  if (!raw) return undefined
  const inCluster = raw.match(/^https?:\/\/gitea-http\.[^/]+\/(.+)$/)
  if (inCluster) {
    const base = giteaPublicUrl.replace(/\/+$/, '')
    return base ? `${base}/${inCluster[1]}` : undefined
  }
  return /^https?:/.test(raw) ? raw : undefined
}

/** The entity with a `repo` link added when it has none, so docs and the tech stack can read the repository. */
export function withRepoLink(entity: Entity, repoUrl: string | undefined): Entity {
  if (!repoUrl || (entity.metadata.links ?? []).some((l) => l.icon === 'repo')) return entity
  return { ...entity, metadata: { ...entity.metadata, links: [...(entity.metadata.links ?? []), { url: repoUrl, title: 'Source', icon: 'repo' }] } }
}
