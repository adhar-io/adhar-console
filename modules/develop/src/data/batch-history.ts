import { useMemo } from 'react'
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { buildRun, CONFIGMAPS_GVR, type ConfigMapLike, gvrOfRun, type RunRow, type RunTemplate } from './batch-model.ts'
import { createRun, resumeRun, type RunOutcome, statusOf } from './batch-api.ts'
import { BATCH_KEY } from './batch.ts'
import {
  type BackfillItem,
  type Calendar,
  CALENDAR_SELECTOR,
  type HistoryRead,
  OPS_DLQ_REPLAY,
  OPS_TRIGGER,
  parseCalendar,
  parseHistory,
  PLATFORM_CALENDAR_NAMESPACE,
} from './batch-history-model.ts'

/**
 * Develop → Batch, Phase 3, the requests and hooks (design 0025 §7.2, D12).
 *
 * History is the one read on this page that is NOT made as the signed-in user:
 * the `adhar.batch` topic holds every tenant's runs and no user has a grant on
 * the event bridge, so the console reads it and `/api/batch/history` returns
 * only the namespaces the caller may list BatchJobs in. Everything else here —
 * calendars, a backfill's runs, a dead-letter replay — is a Kubernetes call as
 * the user, like the rest of the page.
 */

/* ─────────────────────────── history ─────────────────────────── */

export interface HistoryQuery {
  namespace?: string
  job?: string
  /** An age (`7d`, `12h`) or an instant. */
  since?: string
  limit?: number
}

export const historyKey = (q: HistoryQuery = {}) => [...BATCH_KEY, 'history', q.namespace ?? '', q.job ?? '', q.since ?? '', q.limit ?? 0]

/** `/api/batch/history`. A cluster with no bus answers 200 `unavailable`; only a failed request throws. */
export async function fetchHistory(q: HistoryQuery = {}): Promise<HistoryRead> {
  const params = new URLSearchParams()
  if (q.namespace) params.set('namespace', q.namespace)
  if (q.job) params.set('job', q.job)
  if (q.since) params.set('since', q.since)
  if (q.limit) params.set('limit', String(q.limit))
  const query = params.toString()
  const res = await fetch(`/api/batch/history${query ? `?${query}` : ''}`, { credentials: 'include', headers: { accept: 'application/json' } })
  if (res.status === 401) throw new Error('Your session has ended. Sign in again to read the batch history.')
  if (res.status === 404) return { state: 'unavailable', reason: 'no-endpoint', detail: 'This console does not serve the batch history yet.' }
  if (!res.ok) throw new Error(`The batch history could not be read (HTTP ${res.status}).`)
  return parseHistory(await res.json().catch(() => null))
}

/** The retained events. Polled: nothing announces a new event to the browser, and the BFF caches the read for 30 s. */
export function useBatchHistory(q: HistoryQuery = {}, enabled = true) {
  return useQuery({
    queryKey: historyKey(q),
    queryFn: () => fetchHistory(q),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: 1,
  })
}

/* ─────────────────────────── calendars (D5) ─────────────────────────── */

export interface NamespaceCalendars {
  namespace: string
  state: 'read' | 'forbidden' | 'absent'
  calendars: Calendar[]
}

export const calendarsKey = (namespace: string) => [...BATCH_KEY, 'calendars', namespace]

/** The calendar ConfigMaps of one namespace, by label, as the user. */
export async function readNamespaceCalendars(namespace: string): Promise<NamespaceCalendars> {
  try {
    const { items } = await kube.list<ConfigMapLike>(CONFIGMAPS_GVR, { namespace, labelSelector: CALENDAR_SELECTOR })
    return { namespace, state: 'read', calendars: items.map((cm) => parseCalendar({ ...cm, metadata: { ...cm.metadata, namespace: cm.metadata?.namespace ?? namespace } })) }
  } catch (e) {
    const s = statusOf(e)
    if (s === 403 || s === 401) return { namespace, state: 'forbidden', calendars: [] }
    if (s === 404) return { namespace, state: 'absent', calendars: [] }
    throw e
  }
}

/**
 * Every calendar a job in `namespaces` could resolve: each namespace's own, and
 * the platform's. `unread` names the namespaces whose calendars this caller may
 * not list, so a forecast can say a calendar is unknown rather than absent.
 */
export function useCalendars(namespaces: readonly string[], enabled = true) {
  const all = useMemo(() => [...new Set([PLATFORM_CALENDAR_NAMESPACE, ...namespaces.filter(Boolean)])].sort(), [namespaces])
  const results = useQueries({
    queries: all.map((namespace) => ({
      queryKey: calendarsKey(namespace),
      queryFn: () => readNamespaceCalendars(namespace),
      enabled,
      // A calendar changes when someone merges a holiday: minutes are soon enough.
      refetchInterval: 5 * 60_000,
      staleTime: 60_000,
      placeholderData: keepPreviousData,
      retry: 1,
    })),
  })
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  return useMemo(() => ({
    calendars: results.flatMap((r) => r.data?.calendars ?? []),
    unread: results.filter((r) => r.data?.state === 'forbidden').map((r) => r.data!.namespace),
    loading: results.some((r) => r.isLoading),
    error: results.find((r) => r.error)?.error as Error | undefined,
  }), [stamp, results.length])
}

/* ─────────────────────────── writes ─────────────────────────── */

/**
 * Replay one execution's dead letters: an ops Job from the deployed run
 * template with `ADHAR_BATCH_COMMAND=dlq-replay` and the execution id, exactly
 * the Job `adhar batch dlq --replay` creates. The kit's runner re-processes only
 * that execution's rejected items, with the job's own credentials.
 */
export function replayDeadLetters(input: { namespace: string; template: RunTemplate; name: string; executionId: number; restartOf?: string }): Promise<RunOutcome> {
  const manifest = buildRun(input.template, {
    name: input.name,
    namespace: input.namespace,
    trigger: OPS_TRIGGER,
    // The runner acts on the execution id and resolves no parameters.
    params: {},
    restartOf: input.restartOf,
    ops: { verb: OPS_DLQ_REPLAY, executionId: input.executionId },
  })
  return createRun(gvrOfRun(manifest), input.namespace, manifest, input.name)
}

export interface BackfillCreated {
  item: BackfillItem
  outcome: RunOutcome
}

/**
 * Create a backfill's runs, in date order. On the native path each is created
 * SUSPENDED and released afterwards, never more than `parallel` at once; on
 * Volcano each is created as it is and the job's queue decides. A run that
 * already exists (409) is found, not an error: the same backfill twice starts
 * nothing twice. The first failure stops the loop and is thrown with what was
 * created before it.
 */
export async function createBackfill(input: { namespace: string; template: RunTemplate; items: readonly BackfillItem[]; volcano: boolean }): Promise<BackfillCreated[]> {
  const out: BackfillCreated[] = []
  for (const item of input.items) {
    if (item.action !== 'create' && item.action !== 'restart') continue
    const manifest = buildRun(input.template, {
      name: item.run,
      namespace: input.namespace,
      trigger: item.action === 'restart' ? 'restart' : 'backfill',
      params: item.params,
      restartOf: item.restartOf,
      suspend: !input.volcano,
    })
    try {
      out.push({ item, outcome: await createRun(gvrOfRun(manifest), input.namespace, manifest, item.run) })
    } catch (e) {
      throw Object.assign(new Error(`${item.businessDate}: ${e instanceof Error ? e.message : String(e)}`), { created: out, status: statusOf(e) })
    }
  }
  return out
}

/** Release queued backfill runs (`spec.suspend=false`), in the order given. */
export async function releaseBackfillRuns(runs: readonly RunRow[]): Promise<string[]> {
  const released: string[] = []
  for (const r of runs) {
    await resumeRun(r.raw)
    released.push(r.name)
  }
  return released
}

function useAfterWrite() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: [...BATCH_KEY] })
}

export function useReplayDeadLetters() {
  const settled = useAfterWrite()
  return useMutation({ mutationFn: replayDeadLetters, onSettled: settled })
}

export function useCreateBackfill() {
  const settled = useAfterWrite()
  return useMutation({ mutationFn: createBackfill, onSettled: settled })
}

export function useReleaseBackfillRuns() {
  const settled = useAfterWrite()
  return useMutation({ mutationFn: releaseBackfillRuns, onSettled: settled })
}
