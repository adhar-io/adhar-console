import { useMemo } from 'react'
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { canResource, useAccessReview, useWatchSignal } from '@adhar/shell-ui'
import { watchOf } from './functions.ts'
import {
  type AccessGate,
  actionGates,
  BATCHJOBS_GVR,
  type BatchAction,
  type BatchJobList,
  type BatchJobXR,
  EVENTS_GVR,
  firingAlerts,
  firingAlertsQuery,
  JOBS_GVR,
  nextScheduleIndex,
  nextScheduleQuery,
  PODS_GVR,
  RUN_SELECTOR,
  runMetricQueries,
  type RunKind,
  type RunObject,
  type RunPod,
  type RunRow,
  runRows,
  VOLCANO_JOBS_GVR,
} from './batch-model.ts'
import type { EventLike } from './functions-model.ts'
import {
  listBatchJobs,
  listRuns,
  promInstant,
  promRange,
  readRunTemplate,
  restartRun,
  resumeRun,
  type RunList,
  runNow,
  setHold,
  statusOf,
  stopRun,
} from './batch-api.ts'

/**
 * Develop → Batch, the hooks: `batch-api.ts` kept live by apiserver watches over
 * the shared socket (a timer runs only while a watch is refused or the socket is
 * down), the same arrangement as Develop → Functions.
 */

const SIGNAL = { fallbackMs: 60_000, throttleMs: 2_000 }

export const BATCH_KEY = ['batch'] as const
const JOBS_KEY = ['batch', 'jobs'] as const
const RUNS_KEY = ['batch', 'runs'] as const

export function useBatchJobList(candidates: readonly string[]) {
  const sorted = useMemo(() => [...new Set(candidates.filter(Boolean))].sort(), [candidates])
  const signal = useWatchSignal(watchOf(BATCHJOBS_GVR), [[...JOBS_KEY]], SIGNAL)
  return useQuery({
    queryKey: [...JOBS_KEY, sorted.join(',')],
    queryFn: () => listBatchJobs(sorted),
    refetchInterval: signal,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** Runs and their pods, across the jobs' scope, live while the BatchJob API is there to explain them. */
export function useBatchRuns(list: BatchJobList | undefined) {
  const scope = list?.scope ?? 'cluster'
  const readable = useMemo(() => {
    const denied = new Set(list?.denied ?? [])
    return (list?.namespaces ?? []).filter((n) => !denied.has(n))
  }, [list?.namespaces, list?.denied])
  const enabled = Boolean(list?.installed)
  const nsKey = readable.join(',')
  const queryKey = [...RUNS_KEY, scope, nsKey]
  const cluster = scope === 'cluster'
  const jobsSignal = useWatchSignal(cluster ? watchOf(JOBS_GVR, { labelSelector: RUN_SELECTOR }) : null, [[...RUNS_KEY]], { ...SIGNAL, enabled })
  const podsSignal = useWatchSignal(cluster ? watchOf(PODS_GVR, { labelSelector: RUN_SELECTOR }) : null, [[...RUNS_KEY]], { ...SIGNAL, enabled })
  const q = useQuery({
    queryKey,
    queryFn: () => listRuns(scope, readable),
    enabled,
    refetchInterval: cluster ? (jobsSignal && podsSignal ? Math.min(jobsSignal, podsSignal) : jobsSignal || podsSignal) : 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  })
  // Volcano's watch opens only once its API is known to exist: asking for one
  // that is not served logs a refused watch for every viewer of this page.
  useWatchSignal(cluster && q.data?.volcano ? watchOf(VOLCANO_JOBS_GVR, { labelSelector: RUN_SELECTOR }) : null, [[...RUNS_KEY]], { ...SIGNAL, enabled })
  return q
}

/**
 * Rows from a run list. Recomputed on a tick while anything runs would be a
 * timer per page; the list re-reads on every watch event, and a running row's
 * duration is the one value that moves between events, so the page passes `now`.
 */
export function useRunRows(data: RunList | undefined, now?: number): RunRow[] {
  return useMemo(() => runRows(data?.runs ?? [], data?.pods ?? [], now), [data, now])
}

/** The change signal for a caller who cannot watch cluster-wide: one namespace's jobs, runs and pods. */
export function useNamespaceWatches(namespace: string, volcano: boolean) {
  useWatchSignal(watchOf(BATCHJOBS_GVR, { namespace }), [[...JOBS_KEY]], SIGNAL)
  useWatchSignal(watchOf(JOBS_GVR, { namespace, labelSelector: RUN_SELECTOR }), [[...RUNS_KEY]], SIGNAL)
  useWatchSignal(watchOf(PODS_GVR, { namespace, labelSelector: RUN_SELECTOR }), [[...RUNS_KEY]], SIGNAL)
  useWatchSignal(volcano ? watchOf(VOLCANO_JOBS_GVR, { namespace, labelSelector: RUN_SELECTOR }) : null, [[...RUNS_KEY]], SIGNAL)
}

/** One BatchJob, live. `null` once it no longer exists. */
export function useBatchJob(namespace: string | undefined, name: string | undefined) {
  const on = Boolean(namespace && name)
  const queryKey = ['batch', 'job', namespace, name]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<BatchJobXR | null> => {
      try {
        return await kube.get<BatchJobXR>(BATCHJOBS_GVR, namespace!, name!)
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(BATCHJOBS_GVR, { namespace, fieldSelector: `metadata.name=${name}` }) : null, [queryKey], { ...SIGNAL, enabled: on }),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** One run, live. `null` once it is gone (TTL, or deleted). */
export function useRun(namespace: string | undefined, name: string | undefined, kind: RunKind | undefined) {
  const on = Boolean(namespace && name)
  const gvr = kind === 'VolcanoJob' ? VOLCANO_JOBS_GVR : JOBS_GVR
  const queryKey = ['batch', 'run', namespace, name, kind ?? 'Job']
  return useQuery({
    queryKey,
    queryFn: async (): Promise<RunObject | null> => {
      try {
        const run = await kube.get<RunObject>(gvr, namespace!, name!)
        return { ...run, apiVersion: run.apiVersion ?? (kind === 'VolcanoJob' ? 'batch.volcano.sh/v1alpha1' : 'batch/v1'), kind: 'Job' }
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(gvr, { namespace, fieldSelector: `metadata.name=${name}` }) : null, [queryKey], { ...SIGNAL, throttleMs: 1_500, enabled: on }),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** Pods of one run, live. 403 is reported, not thrown: the rest of the page still works. */
export function useRunPods(namespace: string | undefined, name: string | undefined, kind: RunKind | undefined) {
  const on = Boolean(namespace && name)
  const labelSelector = kind === 'VolcanoJob' ? `volcano.sh/job-name=${name}` : `batch.kubernetes.io/job-name=${name}`
  const queryKey = ['batch', 'run-pods', namespace, name, kind ?? 'Job']
  return useQuery({
    queryKey,
    queryFn: async (): Promise<{ items: RunPod[]; forbidden: boolean }> => {
      try {
        return { items: (await kube.list<RunPod>(PODS_GVR, { namespace, labelSelector })).items, forbidden: false }
      } catch (e) {
        if (statusOf(e) === 403) return { items: [], forbidden: true }
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(PODS_GVR, { namespace, labelSelector }) : null, [queryKey], { ...SIGNAL, throttleMs: 1_500, enabled: on }),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

export function useRunEvents(namespace: string | undefined, enabled = true) {
  const on = enabled && Boolean(namespace)
  const queryKey = ['batch', 'events', namespace]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<{ items: EventLike[]; forbidden: boolean }> => {
      try {
        return { items: (await kube.list<EventLike>(EVENTS_GVR, { namespace })).items, forbidden: false }
      } catch (e) {
        if (statusOf(e) === 403) return { items: [], forbidden: true }
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(EVENTS_GVR, { namespace }) : null, [queryKey], { fallbackMs: 60_000, throttleMs: 5_000, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

export function useRunTemplate(namespace: string | undefined, batchJob: string | undefined, templateName?: string, enabled = true) {
  const on = enabled && Boolean(namespace && batchJob)
  return useQuery({
    queryKey: ['batch', 'template', namespace, batchJob, templateName ?? ''],
    queryFn: () => readRunTemplate(namespace!, batchJob!, templateName),
    enabled: on,
    // Promotion replaces the image in it: never start a run from a stale copy.
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  })
}

/* ─────────────────────────── access ─────────────────────────── */

const toCheck = (g: AccessGate) => canResource(g.gvr, g.verb, { namespace: g.namespace, name: g.name, subresource: g.subresource })

/** May the caller do this? False while the answer loads: a blocked action stays hidden, never flashes in. */
export function useBatchGate(action: BatchAction, target: { namespace: string; name: string; kind: RunKind }) {
  const checks = useMemo(() => actionGates(action, target).map(toCheck), [action, target.namespace, target.name, target.kind])
  return useAccessReview(checks)
}

/* ─────────────────────────── Prometheus ─────────────────────────── */

/** When each CronJob next fires, as kube-state-metrics reports it; empty when Prometheus cannot say. */
export function useNextSchedules(namespaces: readonly string[]) {
  const key = [...namespaces].sort().join(',')
  const q = useQuery({
    queryKey: ['batch', 'next', key],
    queryFn: () => promInstant(nextScheduleQuery(namespaces)),
    enabled: namespaces.length > 0,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  })
  return useMemo(() => nextScheduleIndex(q.data ?? []), [q.data])
}

export function useFiringAlerts(namespace: string, job: string, enabled = true) {
  const q = useQuery({
    queryKey: ['batch', 'alerts', namespace, job],
    queryFn: () => promInstant(firingAlertsQuery(namespace, job)),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  })
  const alerts = useMemo(() => firingAlerts(q.data ?? []), [q.data])
  return { alerts, isLoading: q.isLoading, error: q.error as Error | null }
}

export function useRunMetrics(namespace: string, run: string, startMs: number | undefined, endMs: number | undefined, enabled = true) {
  const specs = useMemo(() => runMetricQueries(namespace, run), [namespace, run])
  const results = useQueries({
    queries: specs.map((spec) => ({
      queryKey: ['batch', 'metrics', namespace, run, spec.id, startMs, endMs ?? 'live'],
      queryFn: () => promRange(spec.query, startMs as number, endMs ?? Date.now()),
      enabled: enabled && startMs !== undefined,
      refetchInterval: endMs === undefined ? 60_000 : (false as const),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      retry: false,
    })),
  })
  return specs.map((spec, i) => ({
    spec,
    points: results[i]?.data ?? [],
    loading: Boolean(results[i]?.isLoading),
    error: results[i]?.error instanceof Error ? results[i].error.message : undefined,
  }))
}

/* ─────────────────────────── writes ─────────────────────────── */

function useAfterBatchWrite() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: [...BATCH_KEY] })
}

export function useRunNow() {
  const settled = useAfterBatchWrite()
  return useMutation({ mutationFn: runNow, onSettled: settled })
}

export function useRestartRun() {
  const settled = useAfterBatchWrite()
  return useMutation({ mutationFn: restartRun, onSettled: settled })
}

export function useStopRun() {
  const settled = useAfterBatchWrite()
  return useMutation({ mutationFn: stopRun, onSettled: settled })
}

export function useResumeRun() {
  const settled = useAfterBatchWrite()
  return useMutation({ mutationFn: resumeRun, onSettled: settled })
}

export function useSetHold() {
  const settled = useAfterBatchWrite()
  return useMutation({
    mutationFn: ({ namespace, name, reason }: { namespace: string; name: string; reason: string | null }) => setHold(namespace, name, reason),
    onSettled: settled,
  })
}
