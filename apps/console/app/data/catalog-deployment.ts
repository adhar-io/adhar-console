import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
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

/** Rank environments so Production sorts first, Dev last. */
function envRank(key: string): number {
  const k = key.toLowerCase()
  if (k.startsWith('prod')) return 0
  if (k.startsWith('stag') || k === 'stg') return 1
  if (k === 'uat') return 2
  if (k === 'qa' || k === 'test') return 3
  if (k === 'preview' || k === 'canary') return 4
  if (k.startsWith('dev')) return 5
  return 6
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
  /** Apps grouped into ordered environments (prod → dev). */
  environments: EntityEnvironment[]
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
    if ((hit || isExplicit) && !seen.has(an)) {
      seen.add(an)
      matched.push({ app, env })
    }
  }

  // Derive an environment key per app: name suffix first, else destination
  // namespace suffix, else "default".
  const environments: EntityEnvironment[] = matched
    .map(({ app, env }) => {
      let key = env
      if (!key) {
        const where = workloadNamespace(app)
        const ns = where.toLowerCase()
        key =
          ENV_SUFFIXES.find((s) => ns === s || ns.endsWith(`-${s}`) || ns.startsWith(`${s}-`)) ??
          // Nothing in the name or namespace says which environment this is
          // (the service's bootstrap app, say). Label it by where it actually
          // runs — the destination ("default") is often not that place.
          (where || app.metadata.name)
      }
      return { key, label: envLabel(key), app }
    })
    .sort((a, b) => envRank(a.key) - envRank(b.key) || a.label.localeCompare(b.label))

  const apps = matched.map((m) => m.app)
  const primary =
    environments.find((e) => e.key.toLowerCase().startsWith('prod'))?.app ?? apps[0]

  return {
    apps,
    environments,
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
  return { apps: q.data, isLoading: q.isLoading, isError: q.isError }
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
  const state = { isLoading: q.isLoading, isError: q.isError }
  return useMemo(
    () => deriveDeployment(entity, q.data, state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data, q.isLoading, q.isError, entity],
  )
}


/* ─────────── Kargo environments ─────────── */

/**
 * On this platform an environment is a Kargo Stage — `dev`, `test`, `prod` in
 * the `adhar-environments` project, each one promoting from the last. A
 * service's Argo CD apps rarely say which stage they belong to (the bootstrap
 * app is named `<service>-bootstrap`), so the Deploy tab reads the stages
 * directly instead of inventing environments from app names.
 */
export interface KargoEnvironment {
  stage: kargo.Stage
  label: string
  /** Position along the promotion chain, entry stage first. */
  index: number
  /** The service's Argo CD app for this stage, when one can be matched. */
  app?: argocd.Application
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

/** Stage → this service's app for it, matched on the derived environment key or namespace. */
export function kargoEnvironments(stages: readonly kargo.Stage[] | undefined, deployment: EntityDeployment | undefined): KargoEnvironment[] {
  if (!stages?.length) return []
  return stages.map((stage, index) => {
    const key = stage.name.toLowerCase()
    const app = deployment?.environments.find((e) => {
      const k = e.key.toLowerCase()
      const ns = e.app.spec.destination.namespace.toLowerCase()
      return k === key || envLabel(k) === envLabel(key) || ns === key || ns.endsWith(`-${key}`)
    })?.app
    return { stage, label: envLabel(stage.name), index, app }
  })
}
