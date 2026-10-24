import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { notifyUnauthorized, POLL_FLOOR_MS, useLiveRefetch } from '@adhar/shell-ui'
import { isNotFound } from './chaos.ts'
import { watchOf } from './live.ts'
import { useFollowedRunLog } from './run-log-follow.ts'
import {
  APP_LABEL,
  environmentNames,
  joinSuites,
  parseResults,
  parseSuite,
  RESULTS_CONFIGMAP,
  RESULTS_NAMESPACE,
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
const JOBS = { group: 'batch', version: 'v1', resource: 'jobs' }
/** Where gate Jobs run and the label every one of them carries (BFF `resilience-runs.ts`). */
const RUNNER_NAMESPACE = 'adhar-system'
const GATE_LABEL = 'adhar.io/resilience-gate'

/*
 * Suites, the runner's results and gate runs are all Kubernetes objects (or
 * read straight from them by the BFF), so each query is invalidated by an
 * apiserver watch rather than polled; the timer below is only the fallback
 * while the live socket is down.
 */

export function useApplicationSuites(namespace?: string) {
  const suitesKey = ['chaos', 'suites'] as const
  const resultsKey = ['chaos', 'suite-results'] as const
  const suitesInterval = useLiveRefetch(watchOf(CONFIG_MAPS, { labelSelector: `${SUITE_LABEL}=true` }), [suitesKey], POLL_FLOOR_MS)
  const resultsInterval = useLiveRefetch(
    watchOf(CONFIG_MAPS, { namespace: RESULTS_NAMESPACE, fieldSelector: `metadata.name=${RESULTS_CONFIGMAP}` }),
    [resultsKey],
    POLL_FLOOR_MS,
  )
  const suitesQ = useQuery({
    queryKey: suitesKey,
    queryFn: async () => {
      const res = await kube.list<ConfigMapLike>(CONFIG_MAPS, { labelSelector: `${SUITE_LABEL}=true`, limit: 500 })
      return (res.items ?? []).map(parseSuite)
    },
    retry: false,
    refetchInterval: suitesInterval,
  })
  const resultsQ = useQuery({
    queryKey: resultsKey,
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
    refetchInterval: resultsInterval,
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
 * Gate runs (console clicks and Kargo promotions alike), newest first. The BFF
 * lists the gate Jobs; a watch on those same Jobs re-reads it the moment one
 * starts, progresses or finishes.
 */
export function useResilienceRuns() {
  const queryKey = ['chaos', 'resilience-runs'] as const
  const interval = useLiveRefetch(watchOf(JOBS, { namespace: RUNNER_NAMESPACE, labelSelector: GATE_LABEL }), [queryKey], POLL_FLOOR_MS)
  return useQuery({
    queryKey,
    queryFn: async (): Promise<ResilienceRunsState> => {
      const res = await fetch('/api/resilience/runs', { credentials: 'include', headers: { accept: 'application/json' } })
      if (res.status === 401) notifyUnauthorized()
      const body = (await res.json().catch(() => ({}))) as Partial<ResilienceRunsState> & { error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail || body.error || `runs could not be read (${res.status})`)
      return { installed: !!body.installed, allowed: !!body.allowed, ...(body.detail ? { detail: body.detail } : {}), runs: body.runs ?? [] }
    },
    retry: false,
    // Not installed / not allowed is a fact about the cluster, not a moment.
    refetchInterval: (q) => (q.state.data && !q.state.data.installed ? false : interval),
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

/** The tail of a gate run's log (its newest pod) — followed as a stream while `live`. */
export function useResilienceRunLog(job: string | null, live: boolean) {
  const queryKey = ['chaos', 'resilience-run-log', job]
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<{ pod: string | null; log: string; detail?: string }> => {
      const res = await fetch(`/api/resilience/runs/log?job=${encodeURIComponent(job!)}`, { credentials: 'include' })
      const body = (await res.json().catch(() => ({}))) as { pod?: string | null; log?: string; error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail || body.error || `log could not be read (${res.status})`)
      return { pod: body.pod ?? null, log: body.log ?? '', ...(body.detail ? { detail: body.detail } : {}) }
    },
    enabled: !!job,
    retry: false,
    // A finished run's log no longer changes.
    staleTime: live ? 30_000 : Infinity,
  })
  const followed = useFollowedRunLog({ job, pod: query.data?.pod ?? null, live, queryKeys: [queryKey] })
  const data = useMemo(() => (followed !== undefined && query.data ? { ...query.data, log: followed } : query.data), [followed, query.data])
  return { ...query, data }
}
