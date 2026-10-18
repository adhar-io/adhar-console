import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { harbor, k8s } from '@adhar/api-clients'
import type { EntityDeployment } from './catalog-deployment.ts'
import { type RunningEnv, type RunningState, runningForEnvironments, type TrivyReport } from './catalog-running.ts'
import { parseImageRef } from './catalog-techstack.ts'

/**
 * Reads what runs: trivy-operator's SbomReports (falling back to its
 * VulnerabilityReports) in each environment's namespace, through the
 * console's Kubernetes gateway with the user's own RBAC, plus the OCI labels
 * Harbor records for images it hosts. Every failure is a state the tab
 * explains (CRD not installed, access denied), never a thrown error.
 */

const kube = k8s.K8sClient.auto()
const harborClient = harbor.HarborClient.auto({ tool: 'harbor' })
const GROUP = 'aquasecurity.github.io'
const REFRESH_MS = 5 * 60_000

async function listReports(namespace: string, resource: 'sbomreports' | 'vulnerabilityreports'): Promise<TrivyReport[]> {
  const items = await kube.listGeneric(undefined, { group: GROUP, version: 'v1alpha1', resource, namespaced: true }, namespace)
  return items as unknown as TrivyReport[]
}

const statusOf = (e: unknown) => (e as { status?: number })?.status

/** SBOMs first (every package); vulnerability reports only list vulnerable packages, but still carry versions. */
async function reportsFor(namespace: string): Promise<{ state: RunningState; reports: TrivyReport[] }> {
  let sbomState: RunningState = 'ok'
  try {
    const sboms = await listReports(namespace, 'sbomreports')
    if (sboms.length) return { state: 'ok', reports: sboms }
  } catch (e) {
    const s = statusOf(e)
    sbomState = s === 404 ? 'absent' : s === 403 ? 'forbidden' : 'error'
  }
  try {
    const vulns = await listReports(namespace, 'vulnerabilityreports')
    return { state: 'ok', reports: vulns }
  } catch (e) {
    const s = statusOf(e)
    // Both families missing means trivy-operator is not installed; any 403 means RBAC.
    if (s === 403 || sbomState === 'forbidden') return { state: 'forbidden', reports: [] }
    if (s === 404 && (sbomState === 'absent' || sbomState === 'ok')) return { state: 'absent', reports: [] }
    return { state: 'error', reports: [] }
  }
}

/** OCI image-config labels for images Harbor hosts, keyed by the image string. */
async function harborLabels(images: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>()
  let host = ''
  try {
    host = (await harborClient.registryHost()).toLowerCase()
  } catch {
    return out
  }
  if (!host) return out
  const byRepo = new Map<string, string[]>()
  for (const img of images) {
    const ref = parseImageRef(img)
    if (ref.registry?.toLowerCase() !== host || !ref.repository.includes('/')) continue
    byRepo.set(ref.repository, [...(byRepo.get(ref.repository) ?? []), img])
  }
  await Promise.all(
    [...byRepo.entries()].slice(0, 6).map(async ([repo, imgs]) => {
      const [project, ...rest] = repo.split('/')
      try {
        const arts = await harborClient.listArtifacts(project, rest.join('/'))
        for (const img of imgs) {
          const ref = parseImageRef(img)
          const art = arts.find((a) => (ref.digest && a.digest === ref.digest) || (ref.tag && a.tags?.some((t) => t.name === ref.tag)))
          if (art?.configLabels) out.set(img, art.configLabels)
        }
      } catch {
        /* no access to this project — the tag still gives a version */
      }
    }),
  )
  return out
}

export interface RunningVersionsResult {
  envs: RunningEnv[]
  isLoading: boolean
  /** True when at least one namespace was read. */
  any: boolean
}

/** Running versions for every environment of `deployment` (prod first, as the deployment orders them). */
export function useRunningVersions(deployment: EntityDeployment | undefined): RunningVersionsResult {
  const envs = useMemo(() => {
    const list = [
      ...(deployment?.environments ?? []).map((e) => ({ env: e.label, app: e.app.metadata.name, namespace: e.app.spec.destination.namespace, images: e.app.status.images })),
      ...(deployment?.unscoped ?? []).map((a) => ({ env: a.metadata.name, app: a.metadata.name, namespace: a.spec.destination.namespace, images: a.status.images })),
    ]
    return list.filter((e) => e.namespace && e.images.length)
  }, [deployment?.environments, deployment?.unscoped])
  const namespaces = useMemo(() => [...new Set(envs.map((e) => e.namespace))], [envs])
  const results = useQueries({
    queries: namespaces.map((ns) => ({
      queryKey: ['catalog', 'tech', 'running', ns],
      queryFn: () => reportsFor(ns),
      staleTime: REFRESH_MS,
      retry: 0,
    })),
  })
  const allImages = useMemo(() => [...new Set(envs.flatMap((e) => e.images))], [envs])
  const labels = useQuery({
    queryKey: ['catalog', 'tech', 'oci-labels', allImages],
    queryFn: () => harborLabels(allImages),
    enabled: allImages.length > 0,
    staleTime: REFRESH_MS,
    retry: 0,
  })
  const datas = results.map((r) => r.data)
  // `results` is a new array every render; the update stamps say when its data really changed.
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  const out = useMemo(() => {
    const byNs = new Map<string, { state: RunningState; reports: TrivyReport[] }>()
    namespaces.forEach((ns, i) => {
      const d = datas[i]
      if (d) byNs.set(ns, d)
    })
    return runningForEnvironments(envs, byNs, labels.data)
  }, [envs, namespaces, labels.data, stamp])
  return { envs: out, isLoading: results.some((r) => r.isLoading), any: datas.some(Boolean) }
}
