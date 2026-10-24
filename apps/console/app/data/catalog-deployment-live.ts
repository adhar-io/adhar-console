import { useMemo } from 'react'
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { gitea, harbor, k8s, type kargo } from '@adhar/api-clients'
import type { KObj } from './catalog-composition-model.ts'
import type { EntityRoute } from './catalog-routes.ts'
import { useLiveToolPoll, useWatchSignal } from '@adhar/shell-ui'
import { useK8sListSync, useWatchInvalidate } from './live-k8s.ts'

/**
 * Live reads for the Deployment tab beyond Argo CD and Kargo: per-environment
 * routes, the Gitea repository's state, and the Harbor image tags.
 *
 * Every query keeps its previous data while a key changes and treats a failed
 * BACKGROUND refetch as "still showing the last good answer" — the tab
 * refreshes silently, it never flashes back to a spinner or an error.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
const harborClient = harbor.HarborClient.auto({ tool: 'harbor' })
const k8sClient = k8s.K8sClient.auto()

const ROUTES_MS = 60_000
const REPO_MS = 60_000
const REGISTRY_MS = 120_000

/** HTTPRoutes and Ingresses in `ns` — what `/api/catalog/routes` reads. */
export function routeWatches(ns?: string) {
  const n = ns ? { namespace: ns } : {}
  return [
    { group: 'gateway.networking.k8s.io', version: 'v1', resource: 'httproutes', ...n },
    { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', ...n },
  ]
}

/**
 * Routes for `name` in each of the environments' namespaces.
 *
 * The drawer's own route query is scoped to ONE namespace (production's), so
 * dev and test URLs never appeared. Each environment has its own namespace
 * (`<project>-<env>`), so this asks the same endpoint once per namespace and
 * merges, one entry per URL.
 */
export function useEnvironmentRoutes(name: string, namespaces: readonly string[], enabled = true): {
  routes: EntityRoute[]
  isLoading: boolean
  isError: boolean
} {
  // Routes are HTTPRoutes and Ingresses: their watches in each environment's
  // namespace say when to re-ask (throttled), instead of a timer. The
  // namespace set varies per project, hence the multi-watch hook.
  const refetchInterval = useWatchInvalidate(
    enabled && name ? namespaces.flatMap((ns) => routeWatches(ns)) : [],
    [['catalog', 'routes', name]],
  )
  const results = useQueries({
    queries: namespaces.map((ns) => ({
      queryKey: ['catalog', 'routes', name, ns],
      queryFn: async () => {
        const params = new URLSearchParams({ name, namespace: ns })
        const res = await fetch(`/api/catalog/routes?${params}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' as const })
        if (!res.ok) throw new Error(`routes: ${res.status}`)
        return (await res.json()) as { routes?: EntityRoute[]; error?: string }
      },
      enabled: enabled && Boolean(name),
      staleTime: ROUTES_MS,
      refetchInterval: enabled ? refetchInterval : (false as const),
      placeholderData: keepPreviousData,
    })),
  })
  const datas = results.map((r) => r.data)
  const routes = useMemo(() => {
    const seen = new Set<string>()
    const out: EntityRoute[] = []
    for (const d of datas) {
      for (const r of d?.routes ?? []) {
        if (seen.has(r.url)) continue
        seen.add(r.url)
        out.push(r)
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(datas.map((d) => d?.routes?.map((r) => r.url) ?? []))])
  return {
    routes,
    isLoading: results.some((r) => r.isLoading),
    isError: results.length > 0 && results.every((r) => r.isError && !r.data),
  }
}

export interface RepoSummary {
  repo: gitea.Repo
  /** Recent commits on the default branch, newest first. */
  commits: gitea.Commit[]
}

/**
 * The repository's default branch, open pull requests and recent commits —
 * one repo read and one commit list. The commits double as the message
 * lookup for the sync history (a promotion is a `promote(<env>): …` commit).
 */
export function useRepoSummary(ref: { org: string; repo: string } | undefined, enabled = true) {
  const queryKey = ['catalog', 'gitea', 'repo-summary', ref?.org ?? '', ref?.repo ?? '']
  // Gitea has no watch: the BFF polls the head commit (one cheap call per
  // minute, shared by every viewer) and the summary refetches only when it moved.
  const refetchInterval = useLiveToolPoll(
    'gitea',
    ref ? `/api/v1/repos/${ref.org}/${ref.repo}/commits?limit=1&files=false&verification=false` : '',
    REPO_MS,
    [queryKey],
    { enabled: enabled && Boolean(ref) },
  )
  return useQuery({
    queryKey,
    queryFn: async (): Promise<RepoSummary> => {
      const repo = await giteaClient.getRepo(ref!.org, ref!.repo)
      const commits = await giteaClient.listCommits(ref!.org, ref!.repo, repo.default_branch, 30).catch(() => [])
      return { repo, commits }
    },
    enabled: enabled && Boolean(ref),
    staleTime: REPO_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** Harbor artifacts (newest first) for the app's image repository. */
export function useImageArtifacts(ref: { project: string; repo: string } | undefined, enabled = true) {
  const queryKey = ['catalog', 'harbor', 'artifacts', ref?.project ?? '', ref?.repo ?? '']
  // The BFF watches the newest artifact (shared, every 2 min); the full list —
  // tags, scan and SBOM overviews — is re-read only when a push lands.
  const refetchInterval = useLiveToolPoll(
    'harbor',
    ref
      ? `/api/v2.0/projects/${encodeURIComponent(ref.project)}/repositories/${encodeURIComponent(encodeURIComponent(ref.repo))}/artifacts?page_size=1&sort=-push_time&with_scan_overview=true`
      : '',
    REGISTRY_MS,
    [queryKey],
    { enabled: enabled && Boolean(ref) },
  )
  return useQuery({
    queryKey,
    queryFn: () => harborClient.listArtifacts(ref!.project, ref!.repo),
    enabled: enabled && Boolean(ref),
    staleTime: REGISTRY_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/* ─────────── control plane: Application XR, Project, composed Objects ─────────── */

const CONTROL_PLANE_NS = 'adhar-system'
const XR_MS = 15_000 // staleTime only: the watches below keep these current
const GVR = {
  application: { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'applications', namespaced: true },
  project: { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'projects', namespaced: true },
  object: { group: 'kubernetes.m.crossplane.io', version: 'v1alpha1', resource: 'objects', namespaced: true },
  rollout: { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts', namespaced: true },
  deployment: { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true },
} satisfies Record<string, k8s.GVR>

/** A list response's items do not carry apiVersion/kind; put them back for the model. */
const withKind = (items: unknown[], apiVersion: string, kind: string): KObj[] =>
  (items as KObj[]).map((o) => ({ ...o, apiVersion: o.apiVersion ?? apiVersion, kind: o.kind ?? kind }))

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

/** Application XRs in the control-plane namespace. `[]` when the CRD is not served. */
export function useApplicationXRs(enabled = true) {
  const queryKey = ['catalog', 'xr', 'applications']
  const refetchInterval = useK8sListSync(queryKey, { ...GVR.application, namespace: CONTROL_PLANE_NS }, {
    enabled,
    map: (o) => withKind([o], 'platform.adhar.io/v1alpha1', 'Application')[0],
  })
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return withKind(await k8sClient.listGeneric(undefined, GVR.application, CONTROL_PLANE_NS), 'platform.adhar.io/v1alpha1', 'Application')
      } catch (e) {
        if (statusOf(e) === 404) return []
        throw e
      }
    },
    enabled,
    staleTime: XR_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** The Project an application belongs to; `null` when it does not exist. */
export function useProjectXR(name: string | undefined, namespace: string | undefined) {
  const queryKey = ['catalog', 'xr', 'project', namespace ?? '', name ?? '']
  const refetchInterval = useWatchSignal(
    name && namespace ? { group: GVR.project.group, version: GVR.project.version, resource: GVR.project.resource, namespace, fieldSelector: `metadata.name=${name}` } : null,
    [queryKey],
    { throttleMs: 3_000, enabled: Boolean(name && namespace) },
  )
  return useQuery({
    queryKey,
    queryFn: async (): Promise<KObj | null> => {
      try {
        const o = await k8sClient.getGeneric(undefined, GVR.project, namespace, name!)
        return { ...(o as unknown as KObj), apiVersion: 'platform.adhar.io/v1alpha1', kind: 'Project' }
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw e
      }
    },
    enabled: Boolean(name && namespace),
    staleTime: XR_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** provider-kubernetes Objects in the XR's namespace (the model picks the XR's own). */
export function useComposedObjects(namespace: string | undefined) {
  const queryKey = ['catalog', 'xr', 'objects', namespace ?? '']
  const refetchInterval = useK8sListSync(queryKey, namespace ? { ...GVR.object, namespace } : null, {
    map: (o) => withKind([o], 'kubernetes.m.crossplane.io/v1alpha1', 'Object')[0],
  })
  return useQuery({
    queryKey,
    queryFn: async () => withKind(await k8sClient.listGeneric(undefined, GVR.object, namespace), 'kubernetes.m.crossplane.io/v1alpha1', 'Object'),
    enabled: Boolean(namespace),
    staleTime: XR_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/**
 * Rollouts and Deployments in each environment namespace — the workload's own
 * view of a rollout (canary step, weight, pause), which Argo CD only reports as
 * "Progressing". A namespace without the Rollout CRD just contributes Deployments.
 */
export function useWorkloads(namespaces: readonly string[], enabled = true) {
  const key = [...namespaces].sort().join(',')
  const queryKey = ['catalog', 'workloads', key]
  const on = enabled && namespaces.length > 0
  const refetchInterval = useWatchInvalidate(
    on ? namespaces.flatMap((ns) => [{ ...GVR.rollout, namespace: ns }, { ...GVR.deployment, namespace: ns }]) : [],
    [queryKey],
    { minGapMs: 3_000 },
  )
  return useQuery({
    queryKey,
    queryFn: async () => {
      const out: KObj[] = []
      await Promise.all(namespaces.flatMap((ns) => [
        k8sClient.listGeneric(undefined, GVR.rollout, ns).then((r) => out.push(...withKind(r, 'argoproj.io/v1alpha1', 'Rollout'))).catch(() => undefined),
        k8sClient.listGeneric(undefined, GVR.deployment, ns).then((r) => out.push(...withKind(r, 'apps/v1', 'Deployment'))).catch(() => undefined),
      ]))
      return out
    },
    enabled: enabled && namespaces.length > 0,
    staleTime: XR_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
  })
}

const ANALYSIS_RUN = { group: 'argoproj.io', version: 'v1alpha1', resource: 'analysisruns', namespaced: true } satisfies k8s.GVR

/**
 * The AnalysisRun behind a stage's latest verification. In a project's shared
 * stage it is ONE `<env>-health` run whose metrics are per app (`<app>-…`);
 * the caller reads this app's verdict out of it (`kargo.appVerification`).
 */
export function useAnalysisRun(ref: { name: string; namespace: string } | undefined, enabled = true) {
  const queryKey = ['catalog', 'analysisrun', ref?.namespace ?? '', ref?.name ?? '']
  const on = enabled && Boolean(ref?.name && ref.namespace)
  const refetchInterval = useWatchSignal(
    on ? { group: ANALYSIS_RUN.group, version: ANALYSIS_RUN.version, resource: ANALYSIS_RUN.resource, namespace: ref!.namespace, fieldSelector: `metadata.name=${ref!.name}` } : null,
    [queryKey],
    { throttleMs: 3_000, enabled: on },
  )
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return (await k8sClient.getGeneric(undefined, ANALYSIS_RUN, ref!.namespace, ref!.name)) as unknown as kargo.AnalysisRunLike
      } catch (e) {
        if (statusOf(e) === 404 || statusOf(e) === 403) return null
        throw e
      }
    },
    enabled: enabled && Boolean(ref?.name && ref.namespace),
    staleTime: XR_MS,
    refetchInterval,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}
