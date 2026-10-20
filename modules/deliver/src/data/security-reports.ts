import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { k8s } from '@adhar/api-clients'
import { usePollingInterval } from '@adhar/shell-ui'
import { k8sClient } from './delivery.ts'
import type { TrivyReportObj } from './security-findings.ts'
import { useProjectXRs } from './project-environments.ts'

/**
 * trivy-operator's runtime reports, cluster-wide, through the console's
 * Kubernetes gateway with the user's own RBAC. "Not installed" (the CRD is not
 * served) and "not allowed" are states the pages explain — never an empty
 * list that reads as "no vulnerabilities".
 */

const GROUP = 'aquasecurity.github.io'
const gvr = (resource: string): k8s.GVR => ({ group: GROUP, version: 'v1alpha1', resource, namespaced: true })

export type ReportState = 'ok' | 'absent' | 'forbidden' | 'error'

export interface ReportList {
  state: ReportState
  items: TrivyReportObj[]
  detail?: string
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

async function listReports(resource: 'vulnerabilityreports' | 'sbomreports'): Promise<ReportList> {
  try {
    const items = await k8sClient.listGeneric(undefined, gvr(resource))
    return { state: 'ok', items: items as unknown as TrivyReportObj[] }
  } catch (e) {
    const s = statusOf(e)
    if (s === 404) return { state: 'absent', items: [] }
    if (s === 403) return { state: 'forbidden', items: [] }
    return { state: 'error', items: [], detail: e instanceof Error ? e.message : String(e) }
  }
}

export function useVulnerabilityReports() {
  return useQuery({
    queryKey: ['security', 'trivy', 'vulnerabilityreports'],
    queryFn: () => listReports('vulnerabilityreports'),
    refetchInterval: usePollingInterval(120_000),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useSbomReports(enabled = true) {
  return useQuery({
    queryKey: ['security', 'trivy', 'sbomreports'],
    queryFn: () => listReports('sbomreports'),
    refetchInterval: usePollingInterval(300_000),
    placeholderData: keepPreviousData,
    staleTime: 120_000,
    enabled,
  })
}

/** Project names (Project XRs). */
export function useProjectNames(): { names: string[]; loading: boolean } {
  const xrs = useProjectXRs()
  return { names: (xrs.data ?? []).map((p) => p.metadata.name).sort(), loading: xrs.isLoading }
}
