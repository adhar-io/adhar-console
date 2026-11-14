import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useWatchSignal } from '@adhar/shell-ui'
import { watchOf } from './functions.ts'
import { type BatchJobList, PODGROUPS_GVR, QUEUES_GVR } from './batch-model.ts'
import { ROOT_QUEUE } from './batch-queues-model.ts'
import { readNamespaceGangs, readPodGroups, readQueue, readQueues, readRunGang, readSchedulerDescriptor, volcanoServed } from './batch-queues-api.ts'

/**
 * Develop → Batch → Queues, the hooks: `batch-queues-api.ts` kept live by
 * apiserver watches where the caller may watch, and by a slow poll where it may
 * only `get` (a team member reads its three leaves by name and cannot watch
 * them). Every query is off until discovery says Volcano is installed, so a
 * cluster without it never sees a refused request from this page.
 */

const SIGNAL = { fallbackMs: 60_000, throttleMs: 2_000 }
/** A caller who can only `get` by name has no watch to wait on; a queue's numbers move with every gang. */
const NAMED_POLL_MS = 30_000

export const VOLCANO_KEY = ['batch', 'volcano'] as const
const QUEUES_KEY = ['batch', 'queues'] as const
const PODGROUPS_KEY = ['batch', 'podgroups'] as const

/** Whether Volcano's scheduling APIs are served. It changes only when the package is enabled or removed. */
export function useVolcanoInstalled() {
  return useQuery({
    queryKey: [...VOLCANO_KEY],
    queryFn: volcanoServed,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  })
}

/** `ConfigMap adhar-batch-scheduler` (D7). */
export function useSchedulerDescriptor(enabled: boolean) {
  return useQuery({
    queryKey: ['batch', 'scheduler-descriptor'],
    queryFn: readSchedulerDescriptor,
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  })
}

/** The queues the caller may read: all of them, or the candidate leaves by name. */
export function useBatchQueues(candidates: readonly string[], root: string | undefined, enabled: boolean) {
  const names = useMemo(() => [...new Set(candidates.filter(Boolean))].sort(), [candidates])
  const rootQueue = root || ROOT_QUEUE
  const queryKey = [...QUEUES_KEY, rootQueue, names.join(',')]
  // Opened as soon as the API exists; a caller who may not watch is refused once
  // and falls back to the poll below.
  const signal = useWatchSignal(enabled ? watchOf(QUEUES_GVR) : null, [[...QUEUES_KEY]], { ...SIGNAL, enabled })
  return useQuery({
    queryKey,
    queryFn: () => readQueues(names, rootQueue),
    enabled,
    refetchInterval: (query) => (query.state.data?.scope === 'names' ? NAMED_POLL_MS : signal),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** PodGroups across the Batch page's scope, live while the caller may watch them. */
export function useBatchPodGroups(list: BatchJobList | undefined, enabled: boolean) {
  const scope = list?.scope ?? 'cluster'
  const readable = useMemo(() => {
    const denied = new Set(list?.denied ?? [])
    return (list?.namespaces ?? []).filter((n) => !denied.has(n))
  }, [list?.namespaces, list?.denied])
  const cluster = scope === 'cluster'
  const signal = useWatchSignal(enabled && cluster ? watchOf(PODGROUPS_GVR) : null, [[...PODGROUPS_KEY]], { ...SIGNAL, enabled })
  return useQuery({
    queryKey: [...PODGROUPS_KEY, scope, readable.join(',')],
    queryFn: () => readPodGroups(scope, readable),
    enabled: enabled && Boolean(list),
    refetchInterval: cluster ? signal : NAMED_POLL_MS,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** One namespace's PodGroups, watched for a caller who cannot watch cluster-wide. */
export function usePodGroupNamespaceWatch(namespace: string) {
  useWatchSignal(watchOf(PODGROUPS_GVR, { namespace }), [[...PODGROUPS_KEY]], SIGNAL)
}

/**
 * The gang of one run (the run drawer's "Gang" section): its PodGroup, found by
 * owner. `null` when the run has none — a native Job on the default scheduler.
 */
/**
 * Keyed by the run's uid too: a Job and a Volcano Job of one name, or a run
 * recreated under its old name, would otherwise be served the other's cached
 * PodGroup until the refetch lands.
 */
export const runGangKey = (namespace: string | undefined, run: string | undefined, uid?: string) => [...PODGROUPS_KEY, 'run', namespace, run, uid ?? '']

export function useRunGang(namespace: string | undefined, run: string | undefined, enabled = true, uid?: string) {
  const on = Boolean(enabled && namespace && run)
  const queryKey = runGangKey(namespace, run, uid)
  return useQuery({
    queryKey,
    queryFn: () => readRunGang(namespace!, run!, uid),
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(PODGROUPS_GVR, { namespace }) : null, [queryKey], { ...SIGNAL, enabled: on }),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** The PodGroups of one namespace (a job drawer's gangs), live while the caller may watch them there. */
export function useNamespaceGangs(namespace: string, enabled: boolean) {
  const queryKey = [...PODGROUPS_KEY, 'namespace', namespace]
  return useQuery({
    queryKey,
    queryFn: () => readNamespaceGangs(namespace),
    enabled: enabled && Boolean(namespace),
    refetchInterval: useWatchSignal(enabled ? watchOf(PODGROUPS_GVR, { namespace }) : null, [queryKey], { ...SIGNAL, enabled }),
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/** One leaf queue by name, polled: the caller can usually only `get` it, and its numbers move with every gang. */
export function useQueue(name: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...QUEUES_KEY, 'one', name],
    queryFn: () => readQueue(name!),
    enabled: enabled && Boolean(name),
    refetchInterval: NAMED_POLL_MS,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}
