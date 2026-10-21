import { useQuery } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { notifyUnauthorized } from '@adhar/shell-ui'
import { isNotFound } from './chaos.ts'
import {
  APP_LABEL,
  environmentNames,
  joinSuites,
  parseResults,
  parseSuite,
  RESULTS_CONFIGMAP,
  RESULTS_NAMESPACE,
  runPhase,
  SUITE_LABEL,
  type ApplicationSuites,
  type AppResult,
  type ArgoAppLike,
  type ConfigMapLike,
  type JobStatusLike,
} from './chaos-suites.ts'

/* ─────────────────────────── application suites ─────────────────────────── */

/**
 * Every application's own resilience suite, joined to what the runner last
 * proved. The model and the join live in `chaos-suites.ts`; this is the I/O.
 *
 * Three reads, each allowed to fail on its own: the suite ConfigMaps (every
 * namespace, by label), the runner's results ConfigMap in adhar-system (404 =
 * nothing tested yet), and the Argo CD Applications that name each
 * environment (only for display — the namespace is shown without them).
 */
const CONFIG_MAPS = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }
const ARGO_APPS = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true }

export function useApplicationSuites(namespace?: string) {
  const suitesQ = useQuery({
    queryKey: ['chaos', 'suites'] as const,
    queryFn: async () => {
      const res = await kube.list<ConfigMapLike>(CONFIG_MAPS, { labelSelector: `${SUITE_LABEL}=true`, limit: 500 })
      return (res.items ?? []).map(parseSuite)
    },
    retry: false,
    refetchInterval: 60_000,
  })
  const resultsQ = useQuery({
    queryKey: ['chaos', 'suite-results'] as const,
    queryFn: async () => {
      try {
        const cm = await kube.get<ConfigMapLike>(CONFIG_MAPS, RESULTS_NAMESPACE, RESULTS_CONFIGMAP)
        return parseResults(cm.data?.['results.json'])
      } catch (e) {
        if (isNotFound(e)) return parseResults(undefined)
        throw e
      }
    },
    retry: false,
    refetchInterval: 30_000,
  })
  const envQ = useQuery({
    queryKey: ['chaos', 'suite-environments'] as const,
    queryFn: async () => {
      const res = await kube.list<ArgoAppLike>(ARGO_APPS, { labelSelector: APP_LABEL, limit: 1000 })
      return environmentNames(res.items ?? [])
    },
    retry: false,
    staleTime: 5 * 60_000,
  })

  const results = resultsQ.data?.results ?? new Map<string, AppResult>()
  const suites = (suitesQ.data ?? []).filter((s) => !namespace || s.namespace === namespace)
  const apps: ApplicationSuites[] = joinSuites(suites, results, envQ.data ?? new Map())
  return {
    apps,
    results,
    isLoading: suitesQ.isLoading,
    suitesError: suitesQ.error ? (suitesQ.error as Error) : undefined,
    resultsError: resultsQ.error ? (resultsQ.error as Error).message : resultsQ.data?.error,
    refetchResults: () => resultsQ.refetch(),
  }
}

/** One gate run as `/api/resilience/runs` reports it. */
export interface ResilienceRun {
  job: string
  app: string
  namespace: string
  environment: string
  triggeredBy?: string
  startTime?: string
  completionTime?: string
  status: JobStatusLike
}

export interface ResilienceRunsState {
  /** The runner CronJob exists (the scorecards package is installed). */
  installed: boolean
  /** The signed-in user may start runs (the server's role check, mirrored). */
  allowed: boolean
  detail?: string
  runs: ResilienceRun[]
}

/**
 * Gate runs (console clicks and Kargo promotions alike), newest first. Polls
 * quickly while one is active — people watch a run they just started.
 */
export function useResilienceRuns() {
  return useQuery({
    queryKey: ['chaos', 'resilience-runs'] as const,
    queryFn: async (): Promise<ResilienceRunsState> => {
      const res = await fetch('/api/resilience/runs', { credentials: 'include', headers: { accept: 'application/json' } })
      if (res.status === 401) notifyUnauthorized()
      const body = (await res.json().catch(() => ({}))) as Partial<ResilienceRunsState> & { error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail || body.error || `runs could not be read (${res.status})`)
      return { installed: !!body.installed, allowed: !!body.allowed, ...(body.detail ? { detail: body.detail } : {}), runs: body.runs ?? [] }
    },
    retry: false,
    refetchInterval: (q) => {
      const live = (q.state.data?.runs ?? []).some((r) => {
        const p = runPhase(r.status)
        return p === 'running' || p === 'pending'
      })
      return live ? 5_000 : 30_000
    },
  })
}

export interface StartRunResult {
  started: boolean
  job?: string
  error?: string
  detail?: string
}

/** Start one app+environment's suite now. Returns the outcome rather than throwing. */
export async function startResilienceRun(input: { app: string; namespace: string; environment: string }): Promise<StartRunResult> {
  try {
    const res = await fetch('/api/resilience/runs', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    })
    if (res.status === 401) notifyUnauthorized()
    const body = (await res.json().catch(() => ({}))) as StartRunResult
    return { ...body, started: body.started === true }
  } catch (e) {
    return { started: false, error: 'network', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** The tail of a gate run's log (its newest pod). */
export function useResilienceRunLog(job: string | null, live: boolean) {
  return useQuery({
    queryKey: ['chaos', 'resilience-run-log', job],
    queryFn: async (): Promise<{ pod: string | null; log: string; detail?: string }> => {
      const res = await fetch(`/api/resilience/runs/log?job=${encodeURIComponent(job!)}`, { credentials: 'include' })
      const body = (await res.json().catch(() => ({}))) as { pod?: string | null; log?: string; error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail || body.error || `log could not be read (${res.status})`)
      return { pod: body.pod ?? null, log: body.log ?? '', ...(body.detail ? { detail: body.detail } : {}) }
    },
    enabled: !!job,
    retry: false,
    refetchInterval: job && live ? 5_000 : false,
  })
}
