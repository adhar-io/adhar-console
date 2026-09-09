import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { argocd, argoRollouts, falco, harbor, kargo, trivy } from '@adhar-console/api-clients'
import { useArgocdProject, useHarborProject, useLiveInvalidate, usePollingInterval } from '@adhar-console/shell-ui'
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
 * Delivery hooks layer. Wraps the stub-backed clients in react-query so
 * every Deliver view picks up the same cached data + matching invalidations.
 */

export const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })
export const kargoClient = kargo.KargoClient.auto({ tool: 'kargo' })
export const rolloutsClient = argoRollouts.ArgoRolloutsClient.auto({ tool: 'argo-rollouts' })
export const harborClient = harbor.HarborClient.auto({ tool: 'harbor' })
export const trivyClient = trivy.TrivyClient.auto({ tool: 'trivy' })
export const falcoClient = falco.FalcoClient.auto({ tool: 'falco' })

/**
 * Argo CD project the platform's Applications (and, per-install, the matching
 * Kargo project / Harbor project) live under. Served by the BFF at
 * `/api/config` and read through `useArgocdProject()` (real default `default`)
 * — never the old hardcoded `acme` that made every list come back empty. Each
 * hook resolves it locally and threads it through its `queryKey` + `queryFn`.
 */

const REFRESH_MS = 15_000

/* ─────────── ArgoCD ─────────── */

/** Argo CD Applications are CRDs — a watch on them drives refreshes; polling only while the live socket is down. */
const ARGO_APPS_WATCH = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications' }
const KARGO = 'kargo.akuity.io'
const TRIVY = 'aquasecurity.github.io'

export function useApplications() {
  const project = useArgocdProject()
  useLiveInvalidate('k8s', ARGO_APPS_WATCH, [['argocd', 'apps'], ['argocd', 'app'], ['argocd', 'resources'], ['argocd', 'history']])
  return useQuery({
    queryKey: ['argocd', 'apps', project],
    queryFn: () => argocdClient.listApplications(project),
    refetchInterval: usePollingInterval(REFRESH_MS),
  })
}

export function useApplication(name?: string) {
  return useQuery({
    queryKey: ['argocd', 'app', name],
    queryFn: () => argocdClient.getApplication(name!),
    enabled: !!name,
    refetchInterval: usePollingInterval(REFRESH_MS),
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
    refetchInterval: usePollingInterval(REFRESH_MS),
  })
}

export function useAppHistory(name?: string) {
  return useQuery({
    queryKey: ['argocd', 'history', name],
    queryFn: () => fetchRevisionHistory(name!),
    enabled: !!name,
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

export function useStages() {
  const project = useArgocdProject()
  useLiveInvalidate('k8s', { group: KARGO, version: 'v1alpha1', resource: 'stages' }, [['kargo', 'stages']])
  return useQuery({
    queryKey: ['kargo', 'stages', project],
    queryFn: () => kargoClient.listStages(project),
    refetchInterval: usePollingInterval(REFRESH_MS),
  })
}

export function useFreight() {
  const project = useArgocdProject()
  useLiveInvalidate('k8s', { group: KARGO, version: 'v1alpha1', resource: 'freights' }, [['kargo', 'freight']])
  return useQuery({
    queryKey: ['kargo', 'freight', project],
    queryFn: () => kargoClient.listFreight(project),
    refetchInterval: usePollingInterval(REFRESH_MS),
  })
}

export function usePromote() {
  const project = useArgocdProject()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ stage, freight }: { stage: string; freight: string }) =>
      kargoClient.promote(project, stage, freight),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kargo'] }),
  })
}

export function usePromotions() {
  const project = useArgocdProject()
  useLiveInvalidate('k8s', { group: KARGO, version: 'v1alpha1', resource: 'promotions' }, [['kargo', 'promotions'], ['kargo', 'stages']])
  return useQuery({
    queryKey: ['kargo', 'promotions', project],
    queryFn: () => kargoClient.listPromotions(project),
    refetchInterval: usePollingInterval(REFRESH_MS),
  })
}

export function useWarehouses() {
  const project = useArgocdProject()
  useLiveInvalidate('k8s', { group: KARGO, version: 'v1alpha1', resource: 'warehouses' }, [['kargo', 'warehouses']])
  return useQuery({
    queryKey: ['kargo', 'warehouses', project],
    queryFn: () => kargoClient.listWarehouses(project),
    refetchInterval: usePollingInterval(REFRESH_MS),
  })
}

function useKargoMutation<V>(fn: (project: string, v: V) => Promise<void>) {
  const project = useArgocdProject()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => fn(project, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kargo'] }),
  })
}

export function useAbortPromotion() {
  return useKargoMutation((project, { promotion }: { promotion: string }) => kargoClient.abortPromotion(project, promotion))
}
export function useApproveFreight() {
  return useKargoMutation((project, { freight, stage }: { freight: string; stage: string }) => kargoClient.approveFreight(project, freight, stage))
}
export function useRefreshWarehouse() {
  return useKargoMutation((project, { warehouse }: { warehouse: string }) => kargoClient.refreshWarehouse(project, warehouse))
}
export function useRefreshStage() {
  return useKargoMutation((project, { stage }: { stage: string }) => kargoClient.refreshStage(project, stage))
}

/* ─────────── Argo Rollouts ─────────── */

export function useRollouts() {
  useLiveInvalidate('k8s', { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts' }, [['rollouts']])
  return useQuery({
    queryKey: ['rollouts', 'all'],
    queryFn: () => rolloutsClient.listRollouts(),
    refetchInterval: usePollingInterval(REFRESH_MS),
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

/* ─────────── Harbor ─────────── */

export function useRepositories() {
  const project = useHarborProject()
  return useQuery({
    queryKey: ['harbor', 'repos', project],
    queryFn: () => harborClient.listRepositories(project),
    staleTime: 30_000,
  })
}

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

/* ─────────── Trivy ─────────── */

export function useScans(filter?: { target?: trivy.ScanTarget; namespace?: string }) {
  useLiveInvalidate('k8s', { group: TRIVY, version: 'v1alpha1', resource: 'vulnerabilityreports' }, [['trivy']])
  return useQuery({
    queryKey: ['trivy', 'reports', filter?.target ?? 'all', filter?.namespace ?? 'all'],
    queryFn: () => trivyClient.listReports(filter),
    refetchInterval: 60_000,
  })
}

export function useScan(id?: string) {
  return useQuery({
    queryKey: ['trivy', 'report', id],
    queryFn: () => trivyClient.getReport(id!),
    enabled: !!id,
  })
}

export function useRescan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => trivyClient.rescan(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['trivy'] }),
  })
}

/* ─────────── Falco ─────────── */

export function useFalcoEvents(filter?: { priority?: falco.FalcoPriority; sinceMs?: number }) {
  return useQuery({
    queryKey: ['falco', 'events', filter?.priority ?? 'all', filter?.sinceMs ?? 0],
    queryFn: () => falcoClient.listEvents(filter),
    refetchInterval: REFRESH_MS,
  })
}

export function useFalcoRules() {
  return useQuery({
    queryKey: ['falco', 'rules'],
    queryFn: () => falcoClient.listRules(),
    staleTime: 60_000,
  })
}

export function useToggleFalcoRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      falcoClient.toggleRule(name, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['falco', 'rules'] }),
  })
}
