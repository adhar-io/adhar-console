import { useMemo } from 'react'
import { keepPreviousData, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { useWatchSignal } from '@adhar/shell-ui'
import { watchOf } from './functions.ts'
import { CONFIGMAPS_GVR } from './batch-model.ts'
import { statusOf } from './batch-api.ts'
import { type ReportConfigMap, SCHEDULES_SELECTOR, type ScheduleServiceRow, scheduleServices } from './batch-schedules-model.ts'

/**
 * Develop → Batch → Jobs, the in-service group's reads and hooks (design 0025
 * §5.20.8, CON-Q.2).
 *
 * The schedule reports are ConfigMaps in the services' own namespaces, read AS
 * THE SIGNED-IN USER through the Kubernetes gateway, one namespace at a time:
 * nobody is shown a report the apiserver would not hand them, and the console's
 * ServiceAccount reads nothing here. Each namespace is kept live by a watch on
 * the report label; where the caller may list but not watch, or the socket is
 * down, a 30 s poll takes over (a report changes after every fire, and the
 * shared watch fallback is floored at a minute). A namespace that refuses the
 * list contributes nothing at all: a 403 is not "no schedules", but it is also
 * nothing this page may show, and the BatchJob half of the page already says
 * which namespaces are hidden.
 */

const SIGNAL = { fallbackMs: 60_000, throttleMs: 2_000 }
/** The poll for a caller who cannot watch the reports. */
export const SCHEDULES_POLL_MS = 30_000
/** A namespace that refused the list is asked again this often: access can be granted. */
export const SCHEDULES_REFUSED_POLL_MS = 5 * 60_000

export const SCHEDULES_KEY = ['batch', 'schedules'] as const
export const schedulesKey = (namespace: string) => [...SCHEDULES_KEY, namespace]

export interface NamespaceSchedules {
  namespace: string
  /** `read`: the list answered; `forbidden`: RBAC refused it; `absent`: the namespace does not exist. */
  state: 'read' | 'forbidden' | 'absent'
  items: ReportConfigMap[]
}

/** The report ConfigMaps of one namespace, by label. Never asks cluster-wide. */
export async function readNamespaceSchedules(namespace: string): Promise<NamespaceSchedules> {
  try {
    const { items } = await kube.list<ReportConfigMap>(CONFIGMAPS_GVR, { namespace, labelSelector: SCHEDULES_SELECTOR })
    return { namespace, state: 'read', items: items.map((cm) => ({ ...cm, metadata: { ...cm.metadata, namespace: cm.metadata.namespace ?? namespace } })) }
  } catch (e) {
    const s = statusOf(e)
    if (s === 403 || s === 401) return { namespace, state: 'forbidden', items: [] }
    if (s === 404) return { namespace, state: 'absent', items: [] }
    throw e
  }
}

/** The one query a namespace's reports live in; the page and its watch share it. */
export function schedulesQuery(namespace: string) {
  return {
    queryKey: schedulesKey(namespace),
    queryFn: () => readNamespaceSchedules(namespace),
    placeholderData: keepPreviousData,
    retry: 1,
  }
}

/**
 * The refetch interval for one namespace: none while its watch is live (the
 * watch invalidates on change), 30 s while it is not, and rarely once the
 * namespace refused the list.
 */
export function schedulesInterval(signal: number | false, state: NamespaceSchedules['state'] | undefined): number | false {
  if (state === 'forbidden' || state === 'absent') return SCHEDULES_REFUSED_POLL_MS
  return signal === false ? false : SCHEDULES_POLL_MS
}

/**
 * One namespace's watch, and the poll that stands in for it. A second observer
 * of the same query, so the page's own read needs no interval of its own.
 */
export function useScheduleNamespaceWatch(namespace: string, enabled = true) {
  const on = enabled && Boolean(namespace)
  const signal = useWatchSignal(on ? watchOf(CONFIGMAPS_GVR, { namespace, labelSelector: SCHEDULES_SELECTOR }) : null, [schedulesKey(namespace)], { ...SIGNAL, enabled: on })
  useQuery({ ...schedulesQuery(namespace), enabled: on, refetchInterval: (q) => (on ? schedulesInterval(signal, q.state.data?.state) : false) })
}

export interface BatchSchedules {
  services: ScheduleServiceRow[]
  /** Some namespace has not answered yet. */
  loading: boolean
  /** Namespaces that refused the list: shown nowhere, kept for the record. */
  forbidden: string[]
  /** Namespaces whose read failed for another reason, with the message. */
  failed: Array<{ namespace: string; message: string }>
}

type Result = Pick<UseQueryResult<NamespaceSchedules>, 'data' | 'isLoading' | 'error'>

/** The namespaces' answers → the page's rows. Pure, so the 403 rule is tested without React. */
export function combineSchedules(
  namespaces: readonly string[],
  results: readonly Result[],
  opts: { envByNamespace?: ReadonlyMap<string, string>; now?: number } = {},
): BatchSchedules {
  const cms: ReportConfigMap[] = []
  const forbidden: string[] = []
  const failed: BatchSchedules['failed'] = []
  let loading = false
  results.forEach((r, i) => {
    const namespace = namespaces[i]
    if (r.isLoading) loading = true
    if (r.data?.state === 'forbidden') forbidden.push(namespace)
    else if (r.data?.state === 'read') cms.push(...r.data.items)
    else if (r.error && !r.data) failed.push({ namespace, message: r.error instanceof Error ? r.error.message : String(r.error) })
  })
  return { services: scheduleServices(cms, opts), loading, forbidden, failed }
}

/**
 * Every in-service schedule the caller may read across `namespaces`. Live only
 * while `useScheduleNamespaceWatch` runs for each of them (the page renders one
 * per namespace); on its own this reads once.
 */
export function useBatchSchedules(namespaces: readonly string[], opts: { envByNamespace?: ReadonlyMap<string, string>; now?: number } = {}): BatchSchedules {
  const sorted = useMemo(() => [...new Set(namespaces.filter(Boolean))].sort(), [namespaces])
  const results = useQueries({ queries: sorted.map((ns) => schedulesQuery(ns)) })
  const stamp = results.map((r) => `${r.dataUpdatedAt}:${r.errorUpdatedAt}:${r.isLoading ? 1 : 0}`).join(',')
  return useMemo(
    () => combineSchedules(sorted, results, opts),
    // `results` is a new array every render; what it says changes only with the stamps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sorted, stamp, opts.envByNamespace, opts.now],
  )
}
