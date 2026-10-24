import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { argocd, argoRollouts, harbor, k8s, kargo, nexus, trivy } from '@adhar/api-clients'
import { useArgocdProject, useHarborProject, useLiveToolPoll } from '@adhar/shell-ui'
import { useWatchSignal } from './live.ts'
import {
  deleteApplication,
  fetchManagedResources,
  fetchRevisionHistory,
  refreshApplication,
  rollbackApplication,
  syncApplication,
  terminateOperation,
  type ArgoHealthState,
  type ArgoSyncState,
  type ResourceNode,
  type RevisionHistoryEntry,
  type SyncOptions,
} from './argocd-api.ts'

// Re-exported so views keep importing these types from the delivery hooks layer.
export type {
  ArgoHealthState,
  ArgoSyncState,
  ResourceNode,
  RevisionHistoryEntry,
  SyncOptions,
}

/**
 * Delivery hooks layer. Wraps the live tool clients in react-query so
 * every Deliver view picks up the same cached data + matching invalidations.
 */

export const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })
export const kargoClient = kargo.KargoClient.auto({ tool: 'kargo' })
export const rolloutsClient = argoRollouts.ArgoRolloutsClient.auto({ tool: 'argo-rollouts' })
export const harborClient = harbor.HarborClient.auto({ tool: 'harbor' })
export const trivyClient = trivy.TrivyClient.auto({ tool: 'trivy' })
export const nexusClient = nexus.NexusClient.auto({ tool: 'nexus' })
/** Kubernetes reads — admission policies live as CRDs, not in any registry API. */
export const k8sClient = k8s.K8sClient.auto()

/**
 * Argo CD project the platform's Applications (and, per-install, the matching
 * Kargo project / Harbor project) live under. Served by the BFF at
 * `/api/config` and read through `useArgocdProject()` (real default `default`)
 * — never the old hardcoded `acme` that made every list come back empty. Each
 * hook resolves it locally and threads it through its `queryKey` + `queryFn`.
 */

/* ─────────── ArgoCD ─────────── */

/**
 * Argo CD Applications are CRDs: sync / health / operation state all live in
 * `.status`, so the apiserver watch is the change signal and the REST list is
 * only re-read when an Application really changed (reconcile timestamps are
 * filtered out — see `./live.ts`). Every panel uses these exact params so the
 * hub runs ONE upstream watch for all of them.
 */
export const ARGO_APPS_WATCH = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications' }

/** `refetchInterval` for any query derived from the Application list. */
export function useArgoAppsSignal() {
  return useWatchSignal(ARGO_APPS_WATCH, [['argocd', 'apps']])
}

/** Same, for one Application's detail queries — fires only when THAT app changes. */
function useArgoAppSignal(name: string | undefined, key: string) {
  return useWatchSignal(
    name ? { ...ARGO_APPS_WATCH, fieldSelector: `metadata.name=${name}` } : null,
    [['argocd', key, name]],
    { enabled: !!name },
  )
}
const KARGO = 'kargo.akuity.io'
const TRIVY = 'aquasecurity.github.io'

export function useApplications() {
  const project = useArgocdProject()
  return useQuery({
    queryKey: ['argocd', 'apps', project],
    queryFn: () => argocdClient.listApplications(project),
    refetchInterval: useArgoAppsSignal(),
  })
}

/**
 * Options-aware sync. Threads the ArgoCD `sync` dialog options (prune / dry-run
 * / force) through to the real ArgoCD REST API via the module-scoped helper.
 */
export function useSyncApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, options }: { name: string; options?: SyncOptions }) =>
      syncApplication(name, options),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['argocd'] }),
  })
}

/** Re-compare against git (`hard` also drops the manifest cache). */
export function useRefreshApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, hard }: { name: string; hard?: boolean }) => refreshApplication(name, hard),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['argocd'] }),
  })
}

/** Stop the running sync/rollback operation. */
export function useTerminateOperation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name }: { name: string }) => terminateOperation(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['argocd'] }),
  })
}

/** Delete the Application (cascade removes its managed resources). */
export function useDeleteApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, cascade }: { name: string; cascade?: boolean }) => deleteApplication(name, cascade),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['argocd'] }),
  })
}

/* ─────────── ArgoCD — managed resources, history, rollback ───────────
 *
 * The shared ArgoCD client only models the Application summary. The detail
 * drawer additionally needs the managed-resource tree + deployment history +
 * rollback, so those are backed by the real ArgoCD REST API through the console
 * BFF proxy (`/api/svc/argocd/…`) via the module-scoped `./argocd-api.ts`
 * helpers. Errors propagate to react-query — no fake fallbacks.
 */

export function useAppResources(name?: string) {
  return useQuery({
    queryKey: ['argocd', 'resources', name],
    queryFn: () => fetchManagedResources(name!),
    enabled: !!name,
    refetchInterval: useArgoAppSignal(name, 'resources'),
  })
}

export function useAppHistory(name?: string) {
  return useQuery({
    queryKey: ['argocd', 'history', name],
    queryFn: () => fetchRevisionHistory(name!),
    enabled: !!name,
    // History is `.status.history` — it grows when a sync finishes.
    refetchInterval: useArgoAppSignal(name, 'history'),
  })
}

export function useRollbackApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, id }: { name: string; id: number }) =>
      rollbackApplication(name, id),
    // Optimistically mark the target revision as current so the drawer reflects
    // the rollback immediately; the refetch reconciles once the op "completes".
    onMutate: async ({ name, id }) => {
      await qc.cancelQueries({ queryKey: ['argocd', 'history', name] })
      const prev = qc.getQueryData<RevisionHistoryEntry[]>(['argocd', 'history', name])
      if (prev) {
        qc.setQueryData<RevisionHistoryEntry[]>(
          ['argocd', 'history', name],
          prev.map((h) => ({ ...h, current: h.id === id })),
        )
      }
      return { prev, name }
    },
    onError: (_err, { name }, ctx) => {
      if (ctx?.prev) qc.setQueryData(['argocd', 'history', name], ctx.prev)
    },
    onSettled: (_data, _err, { name }) => {
      qc.invalidateQueries({ queryKey: ['argocd', 'history', name] })
    },
  })
}

/* ─────────── Kargo ─────────── */

// Kargo lists are cluster-wide here, deliberately. Every application's
// promotion chain lives in ITS project's Kargo namespace (`<app>-dev` …
// `<app>-prod` in project `adhar`), while the platform's own environments
// chain lives in `adhar-environments`. Listing only the configured project
// showed the platform's `environments` freight as the sole "release" — the
// "dummy app" — and never a team's build (2026-10-16). Views group by
// warehouse, which is the application.
const ALL_PROJECTS = ''

/** Cluster-wide Kargo watch — one per resource, shared by every panel. */
export function kargoWatch(resource: 'stages' | 'freights' | 'promotions' | 'warehouses') {
  return { group: KARGO, version: 'v1alpha1', resource }
}

export function useStages() {
  const project = ALL_PROJECTS
  return useQuery({
    queryKey: ['kargo', 'stages', project],
    queryFn: () => kargoClient.listStages(project),
    refetchInterval: useWatchSignal(kargoWatch('stages'), [['kargo', 'stages']]),
  })
}

export function useFreight() {
  const project = ALL_PROJECTS
  return useQuery({
    queryKey: ['kargo', 'freight', project],
    queryFn: () => kargoClient.listFreight(project),
    refetchInterval: useWatchSignal(kargoWatch('freights'), [['kargo', 'freight']]),
  })
}

/**
 * Kargo mutations act on an object the user is looking at, so they take the
 * object's OWN project (its namespace) and fall back to the page project only
 * when the caller has nothing better. The list hooks above fall back to every
 * project the user can see when the page project is empty (see listScoped),
 * which is how the Deliver view shows `adhar-environments` while
 * `useArgocdProject()` still says `default` — a promotion that then PATCHed
 * `namespaces/default/freights/<id>/status` got a 404 ("kargo promotion failing
 * to prod", 2026-10-04). The freight is always where its Stage is.
 */
export function usePromote() {
  const fallback = useArgocdProject()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ stage, freight, project }: { stage: string; freight: string; project?: string }) =>
      kargoClient.promote(project || fallback, stage, freight),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kargo'] }),
  })
}

export function usePromotions() {
  const project = ALL_PROJECTS
  return useQuery({
    queryKey: ['kargo', 'promotions', project],
    queryFn: () => kargoClient.listPromotions(project),
    refetchInterval: useWatchSignal(kargoWatch('promotions'), [['kargo', 'promotions']]),
  })
}

export function useWarehouses() {
  const project = useArgocdProject()
  return useQuery({
    queryKey: ['kargo', 'warehouses', project],
    queryFn: () => kargoClient.listWarehouses(project),
    // Cluster-wide watch: a superset of the project list (which itself falls
    // back to every namespace), and the same watch Flow's warehouse list uses.
    refetchInterval: useWatchSignal(kargoWatch('warehouses'), [['kargo', 'warehouses']]),
  })
}

function useKargoMutation<V extends { project?: string }>(fn: (project: string, v: V) => Promise<void>) {
  const fallback = useArgocdProject()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => fn(v.project || fallback, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kargo'] }),
  })
}

export function useAbortPromotion() {
  return useKargoMutation((project, { promotion }: { promotion: string; project?: string }) => kargoClient.abortPromotion(project, promotion))
}
export function useApproveFreight() {
  return useKargoMutation((project, { freight, stage }: { freight: string; stage: string; project?: string }) => kargoClient.approveFreight(project, freight, stage))
}
export function useRefreshWarehouse() {
  return useKargoMutation((project, { warehouse }: { warehouse: string; project?: string }) => kargoClient.refreshWarehouse(project, warehouse))
}
export function useRefreshStage() {
  return useKargoMutation((project, { stage }: { stage: string; project?: string }) => kargoClient.refreshStage(project, stage))
}

/* ─────────── Argo Rollouts ─────────── */

export function useRollouts() {
  return useQuery({
    queryKey: ['rollouts', 'all'],
    queryFn: () => rolloutsClient.listRollouts(),
    // A canary step / pause / abort is a status change on the Rollout itself.
    refetchInterval: useWatchSignal({ group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts' }, [['rollouts']]),
  })
}

export function usePromoteRollout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ namespace, name, full }: { namespace: string; name: string; full?: boolean }) =>
      rolloutsClient.promoteRollout(namespace, name, full),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rollouts'] }),
  })
}

export function useAbortRollout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      rolloutsClient.abortRollout(namespace, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rollouts'] }),
  })
}

/**
 * Clear an abort and run the rollout again.
 *
 * The client has had this since it was written; nothing called it, so an
 * aborted or degraded rollout could be looked at from the console but only
 * recovered from a terminal.
 */
export function useRetryRollout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ namespace, name }: { namespace: string; name: string }) =>
      rolloutsClient.retryRollout(namespace, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rollouts'] }),
  })
}

/* ─────────── Harbor ─────────── */

/** `repo` is Harbor's full name (`<project>/<path>`); the project is taken from it. */
export function useArtifacts(repo?: string) {
  const fallback = useHarborProject()
  const slash = repo?.indexOf('/') ?? -1
  const project = slash > 0 ? repo!.slice(0, slash) : fallback
  const path = slash > 0 ? repo!.slice(slash + 1) : repo
  return useQuery({
    queryKey: ['harbor', 'artifacts', project, path],
    queryFn: () => harborClient.listArtifacts(project, path!),
    enabled: !!path,
    staleTime: 30_000,
  })
}

/**
 * Every artifact in the registry, with its scan verdict.
 *
 * Vulnerability Scans is a registry-wide question — "what are we shipping that
 * has a critical in it" — and Harbor answers it per artifact, so the list is
 * projects → repositories → artifacts fanned out. The scan verdict already
 * rides along on the artifact; no extra call per image is needed until someone
 * opens one.
 *
 * Bounded on purpose: this walks the registry, so it refetches slowly and the
 * repository fan-out is capped. A registry with thousands of repositories
 * needs a server-side index, not a thousand browser requests.
 */
export function useRegistryArtifacts(limitRepos = 60) {
  const projects = useHarborProjects()
  const list = projects.data ?? []
  return useQuery({
    queryKey: ['harbor', 'all-artifacts', list.map((p) => p.name).join(',')],
    enabled: list.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const repos: Array<{ project: string; name: string }> = []
      for (const p of list) {
        const rs = await harborClient.listRepositories(p.name)
        for (const r of rs) repos.push({ project: p.name, name: r.name })
      }
      const capped = repos.slice(0, limitRepos)
      const results = await Promise.all(
        capped.map(async (r) => {
          const path = r.name.startsWith(`${r.project}/`) ? r.name.slice(r.project.length + 1) : r.name
          try {
            const artifacts = await harborClient.listArtifacts(r.project, path)
            return artifacts.map((a) => ({ repo: r.name, artifact: a }))
          } catch {
            // One unreadable repository must not empty the whole page.
            return []
          }
        }),
      )
      return {
        items: results.flat(),
        repoCount: repos.length,
        truncated: repos.length > capped.length,
      }
    },
  })
}

export function useHarborProjects() {
  return useQuery({
    queryKey: ['harbor', 'projects'],
    queryFn: () => harborClient.listProjects(),
    staleTime: 60_000,
  })
}

/** Repositories of one explicit project (the registry page's project selector). */
export function useProjectRepositories(project?: string) {
  return useQuery({
    queryKey: ['harbor', 'repos', project ?? '*'],
    queryFn: () => harborClient.listRepositories(project ?? ''),
    staleTime: 30_000,
  })
}

function splitRepo(repo: string, fallback: string): { project: string; path: string } {
  const slash = repo.indexOf('/')
  return slash > 0 ? { project: repo.slice(0, slash), path: repo.slice(slash + 1) } : { project: fallback, path: repo }
}

/** Full CVE report for one artifact (`repo` is the full Harbor name). */
export function useArtifactVulnerabilities(repo?: string, ref?: string) {
  const fallback = useHarborProject()
  const { project, path } = splitRepo(repo ?? '', fallback)
  return useQuery({
    queryKey: ['harbor', 'vulns', project, path, ref],
    queryFn: () => harborClient.listVulnerabilities(project, path, ref!),
    enabled: !!repo && !!ref,
    staleTime: 60_000,
  })
}

function useHarborMutation<V extends { repo: string }>(fn: (project: string, path: string, v: V) => Promise<void>) {
  const fallback = useHarborProject()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => {
      const { project, path } = splitRepo(v.repo, fallback)
      return fn(project, path, v)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['harbor'] }),
  })
}

export function useScanArtifact() {
  return useHarborMutation((p, r, { ref }: { repo: string; ref: string }) => harborClient.scanArtifact(p, r, ref))
}
export function useDeleteArtifact() {
  return useHarborMutation((p, r, { ref }: { repo: string; ref: string }) => harborClient.deleteArtifact(p, r, ref))
}
export function useAddTag() {
  return useHarborMutation((p, r, { ref, tag }: { repo: string; ref: string; tag: string }) => harborClient.addTag(p, r, ref, tag))
}
export function useDeleteTag() {
  return useHarborMutation((p, r, { ref, tag }: { repo: string; ref: string; tag: string }) => harborClient.deleteTag(p, r, ref, tag))
}
export function useRegistryHost() {
  return useQuery({ queryKey: ['harbor', 'host'], queryFn: () => harborClient.registryHost(), staleTime: Infinity })
}

/* ─────────── Harbor: instance + supply chain ─────────── */

/** Instance-wide counters. Harbor has no watch, so the BFF does the polling. */
export function useHarborStatistics() {
  const queryKey = ['harbor', 'statistics']
  return useQuery({
    queryKey,
    queryFn: () => harborClient.statistics(),
    retry: false,
    refetchInterval: useLiveToolPoll('harbor', '/api/v2.0/statistics', 60_000, [queryKey]),
  })
}

/** Harbor component health (core, database, jobservice, registry, …). */
export function useHarborHealth() {
  const queryKey = ['harbor', 'health']
  return useQuery({
    queryKey,
    queryFn: () => harborClient.health(),
    retry: false,
    // Component health rarely flips; the BFF checks it every 2 minutes.
    refetchInterval: useLiveToolPoll('harbor', '/api/v2.0/health', 120_000, [queryKey]),
  })
}

export function useHarborSystemInfo() {
  return useQuery({ queryKey: ['harbor', 'systeminfo'], queryFn: () => harborClient.systemInfo(), staleTime: 5 * 60_000, retry: false })
}

/**
 * Registered scanner adapters.
 *
 * The **empty** answer is the one that matters: with no scanner registered,
 * Harbor cannot produce scan results, SBOMs or fixable-CVE counts for any
 * artifact — so "no findings" must never be rendered as "no vulnerabilities".
 * The query is kept separate from the artifact list precisely so the UI can
 * distinguish the two.
 */
export function useHarborScanners() {
  // Scanner registration is configuration — it does not change while a page
  // is open, so it is read once and kept.
  return useQuery({
    queryKey: ['harbor', 'scanners'],
    queryFn: () => harborClient.scanners(),
    staleTime: 10 * 60_000,
    retry: false,
  })
}

/** `docker history` for one artifact — the only in-registry build provenance Harbor keeps. */
export function useArtifactBuildHistory(repo?: string, ref?: string, enabled = true) {
  const fallback = useHarborProject()
  const { project, path } = splitRepo(repo ?? '', fallback)
  return useQuery({
    queryKey: ['harbor', 'build-history', project, path, ref],
    queryFn: () => harborClient.buildHistory(project, path, ref!),
    enabled: enabled && !!repo && !!ref,
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/** SBOM document for one artifact. Resolves to `null` when Harbor has none. */
export function useArtifactSbom(repo?: string, ref?: string, enabled = true) {
  const fallback = useHarborProject()
  const { project, path } = splitRepo(repo ?? '', fallback)
  return useQuery({
    queryKey: ['harbor', 'sbom', project, path, ref],
    queryFn: () => harborClient.sbom(project, path, ref!),
    enabled: enabled && !!repo && !!ref,
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/* ─────────── Admission policy (cluster-side supply chain) ─────────── */

const SIGSTORE_POLICIES: k8s.GVR = {
  group: 'policy.sigstore.dev',
  version: 'v1beta1',
  resource: 'clusterimagepolicies',
  namespaced: false,
}
const KYVERNO_IVPOLICIES: k8s.GVR = {
  group: 'policies.kyverno.io',
  version: 'v1alpha1',
  resource: 'imagevalidatingpolicies',
  namespaced: false,
}

/** What a missing CRD means — "not installed" is not an error and not "no policies". */
export type PolicyAvailability = 'present' | 'not-installed' | 'error'

export interface AdmissionPolicies {
  sigstore: { availability: PolicyAvailability; items: k8s.Generic[] }
  kyverno: { availability: PolicyAvailability; items: k8s.Generic[] }
}

async function listPolicies(gvr: k8s.GVR): Promise<{ availability: PolicyAvailability; items: k8s.Generic[] }> {
  try {
    return { availability: 'present', items: await k8sClient.listGeneric(undefined, gvr) }
  } catch (e) {
    // 404 = the CRD is not registered on this cluster. That is a configuration
    // fact ("the admission controller isn't installed"), not a failure, and the
    // two must not look the same to the reader.
    const status = (e as { status?: number }).status
    return { availability: status === 404 || status === 403 ? 'not-installed' : 'error', items: [] }
  }
}

/**
 * Image-admission policies that would gate a pulled image: Sigstore policy
 * controller `ClusterImagePolicy` and Kyverno `ImageValidatingPolicy`. Both are
 * optional CRDs, so each reports its own availability rather than collapsing
 * "absent" into "none found".
 */
export function useAdmissionImagePolicies() {
  return useQuery<AdmissionPolicies>({
    queryKey: ['supply-chain', 'admission-image-policies'],
    queryFn: async () => {
      const [sigstore, kyverno] = await Promise.all([listPolicies(SIGSTORE_POLICIES), listPolicies(KYVERNO_IVPOLICIES)])
      return { sigstore, kyverno }
    },
    // Admission policy is configuration; read once per visit.
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/* ─────────── Nexus ─────────── */

export function useNexusRepositories() {
  // Repository definitions are configuration — no polling.
  return useQuery({
    queryKey: ['nexus', 'repositories'],
    queryFn: () => nexusClient.listRepositories(),
    retry: false,
    staleTime: 5 * 60_000,
  })
}

export function useNexusStatus() {
  const queryKey = ['nexus', 'status']
  return useQuery({
    queryKey,
    queryFn: () => nexusClient.statusCheck(),
    retry: false,
    refetchInterval: useLiveToolPoll('nexus', '/service/rest/v1/status/check', 120_000, [queryKey]),
  })
}

/**
 * Components of one Nexus repository, or a keyword search across the instance.
 * Nexus pages by continuation token; the first two pages are enough for a
 * browsing UI and the hook reports whether more remain rather than pretending
 * the list is complete.
 */
export function useNexusComponents(repository?: string, q?: string) {
  return useQuery({
    queryKey: ['nexus', 'components', repository ?? '*', q ?? ''],
    queryFn: async () => {
      const query = q?.trim()
      const first = query
        ? await nexusClient.search({ repository, q: query })
        : await nexusClient.listComponents(repository!)
      let items = first.items
      let token = first.continuationToken
      let pages = 1
      while (token && pages < 3) {
        const next = query
          ? await nexusClient.search({ repository, q: query, continuationToken: token })
          : await nexusClient.listComponents(repository!, token)
        items = items.concat(next.items)
        token = next.continuationToken
        pages++
      }
      return { items, truncated: Boolean(token) }
    },
    enabled: !!repository || !!q?.trim(),
    retry: false,
    staleTime: 30_000,
  })
}

/* ─────────── Trivy ─────────── */

export function useScans(filter?: { target?: trivy.ScanTarget; namespace?: string }) {
  const queryKey = ['trivy', 'reports', filter?.target ?? 'all', filter?.namespace ?? 'all']
  return useQuery({
    queryKey,
    queryFn: () => trivyClient.listReports(filter),
    // Reports are CRDs; a rescan rewrites the report, which the watch sees.
    // Bursts (a scan wave across the cluster) are throttled to one re-list per 30s.
    refetchInterval: useWatchSignal(
      { group: TRIVY, version: 'v1alpha1', resource: 'vulnerabilityreports', namespace: filter?.namespace },
      [queryKey],
      { throttleMs: 30_000 },
    ),
  })
}

/* ─────────── Runtime events ─────────── */

// Runtime events (Tetragon / Falco) are read from the agents themselves — see
// ./runtime.ts. The old Falco REST hooks read a BFF route with no real
// backend, so they were removed rather than left to serve sample events.
