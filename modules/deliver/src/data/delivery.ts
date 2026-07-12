import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { argocd, argoRollouts, falco, harbor, kargo, trivy } from '@adhar-console/api-clients'

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

export const PROJECT = 'acme'

const REFRESH_MS = 15_000

/* ─────────── ArgoCD ─────────── */

export function useApplications() {
  return useQuery({
    queryKey: ['argocd', 'apps', PROJECT],
    queryFn: () => argocdClient.listApplications(PROJECT),
    refetchInterval: REFRESH_MS,
  })
}

export function useApplication(name?: string) {
  return useQuery({
    queryKey: ['argocd', 'app', name],
    queryFn: () => argocdClient.getApplication(name!),
    enabled: !!name,
    refetchInterval: REFRESH_MS,
  })
}

export function useSyncApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => argocdClient.syncApplication(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['argocd'] }),
  })
}

/* ─────────── Kargo ─────────── */

export function useStages() {
  return useQuery({
    queryKey: ['kargo', 'stages', PROJECT],
    queryFn: () => kargoClient.listStages(PROJECT),
    refetchInterval: REFRESH_MS,
  })
}

export function useFreight() {
  return useQuery({
    queryKey: ['kargo', 'freight', PROJECT],
    queryFn: () => kargoClient.listFreight(PROJECT),
    refetchInterval: REFRESH_MS,
  })
}

export function usePromote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ stage, freight }: { stage: string; freight: string }) =>
      kargoClient.promote(PROJECT, stage, freight),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kargo'] }),
  })
}

/* ─────────── Argo Rollouts ─────────── */

export function useRollouts() {
  return useQuery({
    queryKey: ['rollouts', 'all'],
    queryFn: () => rolloutsClient.listRollouts(),
    refetchInterval: REFRESH_MS,
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
  return useQuery({
    queryKey: ['harbor', 'repos', PROJECT],
    queryFn: () => harborClient.listRepositories(PROJECT),
    staleTime: 30_000,
  })
}

export function useArtifacts(repo?: string) {
  return useQuery({
    queryKey: ['harbor', 'artifacts', PROJECT, repo],
    queryFn: () => harborClient.listArtifacts(PROJECT, repo!),
    enabled: !!repo,
    staleTime: 30_000,
  })
}

/* ─────────── Trivy ─────────── */

export function useScans(filter?: { target?: trivy.ScanTarget; namespace?: string }) {
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
