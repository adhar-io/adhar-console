import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { kargo, type k8s } from '@adhar/api-clients'
import { usePollingInterval, useTeamProjects } from '@adhar/shell-ui'
import { argocdClient, k8sClient, useFreight, usePromotions, useStages } from './delivery.ts'

/**
 * Data for **Deliver → Environments**, organised Project → its environments.
 *
 * Environments belong to the project (`platform.adhar.io` Project XR,
 * `status.environments`); every application of the project is deployed into
 * the same ones. The pure model (both Kargo shapes, freight per app, drift) is
 * `kargo.buildProjectMatrix` in `@adhar/api-clients` — shared with the service
 * catalog's Deployment tab.
 */

const CONTROL_PLANE_NS = 'adhar-system'
const XR_MS = 20_000
const ARGO_MS = 15_000

const PROJECT_GVR: k8s.GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'projects', namespaced: true }
const APPLICATION_GVR: k8s.GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'applications', namespaced: true }

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status

/** Project XRs; `[]` when the CRD is not served (an install without the control plane). */
export function useProjectXRs() {
  return useQuery({
    queryKey: ['deliver', 'xr', 'projects'],
    queryFn: async (): Promise<kargo.ProjectLike[]> => {
      try {
        return (await k8sClient.listGeneric(undefined, PROJECT_GVR, CONTROL_PLANE_NS)) as unknown as kargo.ProjectLike[]
      } catch (e) {
        if (statusOf(e) === 404 || statusOf(e) === 403) return []
        throw e
      }
    },
    refetchInterval: usePollingInterval(XR_MS),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

interface AppXR {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: { parameters?: { project?: string } }
}

/** Application XRs — names the apps of a project before anything is deployed. */
export function useApplicationXRs() {
  return useQuery({
    queryKey: ['deliver', 'xr', 'applications'],
    queryFn: async (): Promise<AppXR[]> => {
      try {
        return (await k8sClient.listGeneric(undefined, APPLICATION_GVR, CONTROL_PLANE_NS)) as unknown as AppXR[]
      } catch (e) {
        if (statusOf(e) === 404 || statusOf(e) === 403) return []
        throw e
      }
    },
    refetchInterval: usePollingInterval(XR_MS),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/**
 * Every Argo CD Application, across AppProjects. The control plane's apps
 * (`<project>-<app>-<env>`) live in the project's own AppProject, not in the
 * console's configured one, so the project-scoped list would miss them.
 */
export function useAllArgoApps() {
  return useQuery({
    queryKey: ['argocd', 'apps', '*all*'],
    queryFn: () => argocdClient.listApplications(),
    refetchInterval: usePollingInterval(ARGO_MS),
    placeholderData: keepPreviousData,
  })
}

/** The project an Application XR belongs to (the control plane maps `default`/empty to `adhar`). */
export function xrProject(x: AppXR): string {
  const p = (x.spec?.parameters?.project ?? x.metadata.labels?.['adhar.io/project'] ?? '').trim()
  return !p || p === 'default' ? 'adhar' : p
}

export interface ProjectOption {
  name: string
  /** True when a Project XR exists (environments are published); false = seen only on stages/apps. */
  declared: boolean
  envCount: number
}

/**
 * The projects to choose between: every Project XR, plus any project the
 * stages or Argo CD apps are labelled for (so a cluster whose Project XR is
 * unreadable still shows its environments).
 */
export function projectOptions(
  projects: readonly kargo.ProjectLike[],
  stages: readonly kargo.Stage[],
  argoApps: readonly { metadata: { labels?: Record<string, string> } }[],
): ProjectOption[] {
  const out = new Map<string, ProjectOption>()
  for (const p of projects) out.set(p.metadata.name, { name: p.metadata.name, declared: true, envCount: kargo.projectEnvironments(p).length })
  const seen = (name: string | undefined) => {
    if (name && !out.has(name)) out.set(name, { name, declared: false, envCount: 0 })
  }
  for (const s of stages) seen(s.labels?.[kargo.LABEL_PROJECT])
  for (const a of argoApps) if (a.metadata.labels?.[kargo.LABEL_APPLICATION]) seen(a.metadata.labels?.[kargo.LABEL_PROJECT])
  return [...out.values()].sort((a, b) => Number(b.declared) - Number(a.declared) || a.name.localeCompare(b.name))
}

/**
 * Narrow the options to the active team's projects (Org → Team → Project).
 * A lens, never a boundary: when the team owns none of them, nothing is hidden.
 */
export function teamFilter(options: readonly ProjectOption[], team: { filtering: boolean; slugs: ReadonlySet<string> }): ProjectOption[] {
  if (!team.filtering || !team.slugs.size) return [...options]
  const mine = options.filter((o) => team.slugs.has(o.name))
  return mine.length ? mine : [...options]
}

export function useProjectEnvironmentsData(project: string | undefined) {
  const projects = useProjectXRs()
  const xrs = useApplicationXRs()
  const argo = useAllArgoApps()
  const stages = useStages()
  const freight = useFreight()
  const promotions = usePromotions()
  const team = useTeamProjects()

  const options = useMemo(
    () => projectOptions(projects.data ?? [], stages.data ?? [], argo.data ?? []),
    [projects.data, stages.data, argo.data],
  )
  const slugs = useMemo(
    () => new Set(team.projects.flatMap((p) => [p.slug, p.argoProject].filter((v): v is string => Boolean(v)))),
    [team.projects],
  )
  const scoped = useMemo(() => teamFilter(options, { filtering: team.filtering, slugs }), [options, team.filtering, slugs])
  const active = project && options.some((o) => o.name === project) ? project : scoped[0]?.name

  const projectXR = useMemo(() => (projects.data ?? []).find((p) => p.metadata.name === active), [projects.data, active])
  const matrix = useMemo(() => {
    if (!active) return undefined
    return kargo.buildProjectMatrix({
      project: active,
      envs: kargo.projectEnvironments(projectXR),
      stages: stages.data ?? [],
      freight: freight.data ?? [],
      promotions: promotions.data ?? [],
      argoApps: argo.data ?? [],
      extraApps: [
        ...kargo.projectApplications(projectXR),
        ...(xrs.data ?? []).filter((x) => xrProject(x) === active).map((x) => x.metadata.name),
      ],
    })
  }, [active, projectXR, stages.data, freight.data, promotions.data, argo.data, xrs.data])

  return {
    options,
    scoped,
    team,
    active,
    projectXR,
    matrix,
    freight: freight.data ?? [],
    loading: (stages.isLoading && !stages.data) || (projects.isLoading && !projects.data) || (argo.isLoading && !argo.data),
    errors: {
      stages: stages.isError && !stages.data ? stages.error : undefined,
      argo: argo.isError && !argo.data ? argo.error : undefined,
      projects: projects.isError && !projects.data ? projects.error : undefined,
    },
  }
}

const ANALYSIS_RUN_GVR: k8s.GVR = { group: 'argoproj.io', version: 'v1alpha1', resource: 'analysisruns', namespaced: true }

/**
 * The AnalysisRun behind a stage's latest verification. A project's shared
 * stage runs ONE `<env>-health` analysis with per-app metrics (`<app>-…`), so
 * each app's verdict is read out of it with `kargo.appVerification`.
 */
export function useAnalysisRun(ref: { name: string; namespace: string } | undefined) {
  return useQuery({
    queryKey: ['deliver', 'analysisrun', ref?.namespace ?? '', ref?.name ?? ''],
    queryFn: async (): Promise<kargo.AnalysisRunLike | null> => {
      try {
        return (await k8sClient.getGeneric(undefined, ANALYSIS_RUN_GVR, ref!.namespace, ref!.name)) as unknown as kargo.AnalysisRunLike
      } catch (e) {
        if (statusOf(e) === 404 || statusOf(e) === 403) return null
        throw e
      }
    },
    enabled: Boolean(ref?.name && ref.namespace),
    refetchInterval: usePollingInterval(ARGO_MS),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}
