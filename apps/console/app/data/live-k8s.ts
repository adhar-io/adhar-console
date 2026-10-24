import { useEffect, useRef, useState } from 'react'
import { type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { applyEvent, liveClient, type LiveWatchRef, pollEvery, sameSnapshot, type Snapshot, snapshotOf, useLiveStatus } from '@adhar/shell-ui'
import { applyWatchEvents, createThrottle, type WatchEvent } from './watch-delta.ts'

/**
 * Kubernetes-backed queries kept current by apiserver watches over `/api/live`,
 * WITHOUT re-listing on every change.
 *
 * `useLiveRefetch` (shell-ui) turns each watch event into an invalidation, so
 * a busy resource — cluster-wide pods or events — became a full re-list every
 * few hundred milliseconds. The hooks here fold the watch deltas straight into
 * the query cache instead: one list when the query first loads, then nothing
 * but the (shared, server-side) watch stream.
 *
 *   • `useK8sList`        — a raw apiserver list, owned and kept current here.
 *   • `useK8sListSync`    — the same delta-folding for an existing query whose
 *                           data is a list of the watched objects (optionally
 *                           mapped, optionally merge-only for proxied APIs).
 *   • `useWatchInvalidate`— for derived queries over a VARIABLE set of watches
 *                           (one per environment namespace…): a throttled
 *                           refetch when any of them changes. A fixed, single
 *                           watch uses shell-ui's `useWatchSignal` instead,
 *                           which also filters status-only noise.
 *
 * Every hook returns the `refetchInterval` to hand to TanStack Query: `false`
 * while the watch is healthy, the 60s floor when the socket is down or the
 * watch failed for a reason that may heal, and `false` again when the watch
 * failed for a reason that will not (401/403/404 — no access, CRD missing).
 */

const client = k8s.K8sClient.auto()

/** Watch events are buffered and folded in at most this often. */
const FLUSH_MS = 1_000
/** Default minimum gap between two refetches a watch can trigger. */
const DEFAULT_MIN_GAP_MS = 10_000
const FALLBACK_MS = 60_000

type WatchState = 'ok' | 'retry' | 'fatal'

function watchParams(w: LiveWatchRef): Record<string, unknown> {
  // Only the fields the hub keys on, so identical watches from different
  // panels serialise identically (and share one upstream watch).
  return {
    group: w.group,
    version: w.version,
    resource: w.resource,
    ...(w.namespace ? { namespace: w.namespace } : {}),
    ...(w.labelSelector ? { labelSelector: w.labelSelector } : {}),
    ...(w.fieldSelector ? { fieldSelector: w.fieldSelector } : {}),
    ...(w.cluster ? { cluster: w.cluster } : {}),
  }
}

function stateOfError(msg: Record<string, unknown>): WatchState {
  const s = Number(msg.status)
  return s === 401 || s === 403 || s === 404 ? 'fatal' : 'retry'
}

function useInterval(enabled: boolean, state: WatchState, fallbackMs: number, pollOnFatal = false): number | false {
  const status = useLiveStatus()
  if (!enabled) return false
  if (state === 'fatal') return pollOnFatal ? pollEvery(fallbackMs) : false
  return state === 'retry' || status !== 'live' ? pollEvery(fallbackMs) : false
}

export interface ListSyncOpts<T> {
  enabled?: boolean
  /** Shape a raw object the way the query's `queryFn` does. */
  map?(o: unknown): T
  /** Never add objects the list does not hold — refetch instead (see watch-delta.ts). */
  mergeOnly?: boolean
  fallbackMs?: number
  minGapMs?: number
  /**
   * Keep the timer when the watch is refused for good (403/404). Right when
   * the query reads through another API than the watch (merge-only lists);
   * wrong for a raw list, which fails the same way the watch did.
   */
  pollOnFatal?: boolean
}

/**
 * Keep `queryKey` (a list of the objects `watch` names) current from the
 * watch stream. Returns the query's `refetchInterval`.
 */
export function useK8sListSync<T>(
  queryKey: QueryKey,
  watch: LiveWatchRef | null | undefined,
  opts: ListSyncOpts<T> = {},
): number | false {
  const { enabled = true, mergeOnly = false, fallbackMs = FALLBACK_MS, minGapMs = DEFAULT_MIN_GAP_MS } = opts
  const qc = useQueryClient()
  const [state, setState] = useState<WatchState>('ok')
  const mapRef = useRef(opts.map)
  mapRef.current = opts.map
  const keyStr = JSON.stringify(queryKey)
  const paramsStr = watch ? JSON.stringify(watchParams(watch)) : ''
  const on = enabled && Boolean(paramsStr)

  useEffect(() => {
    if (!on) return
    setState('ok')
    const key = JSON.parse(keyStr) as QueryKey
    const refetch = createThrottle(() => void qc.invalidateQueries({ queryKey: key, exact: true }), minGapMs)
    let buf: WatchEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let resyncs = 0
    const flush = () => {
      flushTimer = undefined
      const events = buf
      buf = []
      const prev = qc.getQueryData<T[]>(key)
      // Not loaded yet: the query's own first fetch is newer than these.
      if (!Array.isArray(prev)) return
      const r = applyWatchEvents(prev, events, { map: mapRef.current, mergeOnly })
      if (r.changed) qc.setQueryData(key, r.next)
      if (r.unknown) refetch.call()
    }
    const unsub = liveClient.subscribe('k8s', JSON.parse(paramsStr), (msg) => {
      if (msg.op === 'event') {
        buf.push(msg as WatchEvent)
        flushTimer ??= setTimeout(flush, FLUSH_MS)
      } else if (msg.op === 'resync') {
        setState('ok')
        resyncs++
        const items = (msg.items as unknown[] | undefined) ?? []
        // The hub pages its list, so a resync is the whole set.
        if (mergeOnly) {
          // The first resync answers the subscription the query just fetched
          // for; later ones (reconnect, relist) may carry missed changes.
          if (resyncs > 1) refetch.call()
          return
        }
        buf = []
        const m = mapRef.current
        qc.setQueryData(key, m ? items.map((o) => m(o)) : items)
      } else if (msg.op === 'error') {
        setState(stateOfError(msg))
      }
    })
    return () => {
      unsub()
      refetch.cancel()
      if (flushTimer) clearTimeout(flushTimer)
    }
  }, [keyStr, paramsStr, on, mergeOnly, minGapMs, qc])

  return useInterval(on, state, fallbackMs, opts.pollOnFatal ?? mergeOnly)
}

export interface WatchInvalidateOpts {
  enabled?: boolean
  fallbackMs?: number
  /** Minimum gap between two refetches (bursts coalesce into one). */
  minGapMs?: number
}

/**
 * Refetch `queryKeys` — throttled — when any of `watches` changes. For queries
 * derived from several resources (a resource tree, a join) where folding the
 * deltas in is not possible. `null` entries are skipped.
 */
export function useWatchInvalidate(
  watches: ReadonlyArray<LiveWatchRef | null | undefined>,
  queryKeys: QueryKey[],
  opts: WatchInvalidateOpts = {},
): number | false {
  const { enabled = true, fallbackMs = FALLBACK_MS, minGapMs = DEFAULT_MIN_GAP_MS } = opts
  const qc = useQueryClient()
  const [state, setState] = useState<WatchState>('ok')
  const keysRef = useRef(queryKeys)
  keysRef.current = queryKeys
  const live = watches.filter((w): w is LiveWatchRef => Boolean(w))
  const paramsStr = JSON.stringify(live.map(watchParams))
  const on = enabled && live.length > 0

  useEffect(() => {
    if (!on) return
    setState('ok')
    const refetch = createThrottle(() => {
      for (const k of keysRef.current) void qc.invalidateQueries({ queryKey: k })
    }, minGapMs)
    const params = JSON.parse(paramsStr) as Array<Record<string, unknown>>
    const fatal = new Set<number>()
    const unsubs = params.map((p, i) => {
      // Change-filtered with shell-ui's fingerprints: status-only noise
      // (resourceVersion, reconciledAt, heartbeats…) never triggers a refetch.
      let snap: Snapshot | null = null
      return liveClient.subscribe('k8s', p, (msg) => {
        if (msg.op === 'event') {
          snap ??= new Map()
          if (applyEvent(snap, String(msg.type ?? ''), msg.object)) refetch.call()
        } else if (msg.op === 'resync') {
          const next = snapshotOf((msg.items as unknown[] | undefined) ?? [])
          // The first resync answers the subscription the query just fetched for.
          const changed = snap !== null && !sameSnapshot(snap, next)
          snap = next
          if (changed) refetch.call()
        } else if (msg.op === 'error') {
          const s = stateOfError(msg)
          if (s === 'fatal') fatal.add(i)
          // One watch unavailable for good is not a reason to poll the rest;
          // all of them unavailable means nothing will ever push.
          setState(s === 'retry' ? 'retry' : fatal.size === params.length ? 'fatal' : 'ok')
        }
      })
    })
    return () => {
      for (const u of unsubs) u()
      refetch.cancel()
    }
  }, [paramsStr, on, minGapMs, qc])

  // A derived query reads through its own APIs: with every watch refused it
  // still needs its timer.
  return useInterval(on, state, fallbackMs, true)
}

/** Canonical cache key for a raw apiserver list — every panel reading it shares one entry. */
export function k8sListKey(gvr: k8s.GVR, opts: { namespace?: string; labelSelector?: string; cluster?: string } = {}): QueryKey {
  return ['k8s', 'list', opts.cluster ?? '', gvr.group, gvr.version, gvr.resource, opts.namespace ?? '*', opts.labelSelector ?? '']
}

export interface K8sListOpts<T> {
  namespace?: string
  labelSelector?: string
  cluster?: string
  enabled?: boolean
  fallbackMs?: number
  /** Shape each object (list items and watch objects alike). Needs its own `queryKey`. */
  map?(o: unknown): T
  queryKey?: QueryKey
  retry?: boolean | number
  gcTime?: number
}

/**
 * A raw apiserver list, live. One list on first load; after that the shared
 * watch keeps the cache current, so the data never goes stale while the
 * socket is up.
 */
export function useK8sList<T = k8s.Generic>(gvr: k8s.GVR, opts: K8sListOpts<T> = {}) {
  const { namespace, labelSelector, cluster, enabled = true, map } = opts
  const queryKey = opts.queryKey ?? k8sListKey(gvr, { namespace, labelSelector, cluster })
  const status = useLiveStatus()
  const watch: LiveWatchRef = { group: gvr.group, version: gvr.version, resource: gvr.resource, namespace, labelSelector, cluster }
  const refetchInterval = useK8sListSync<T>(queryKey, watch, { enabled, map, fallbackMs: opts.fallbackMs })
  return useQuery({
    queryKey,
    queryFn: async (): Promise<T[]> => {
      const g = { ...gvr, namespaced: gvr.namespaced || Boolean(namespace) }
      const items: unknown[] = labelSelector
        ? (await k8s.kube.list(g, { namespace, labelSelector, cluster })).items
        : await client.listGeneric(cluster, g, namespace)
      return map ? items.map((o) => map(o)) : (items as T[])
    },
    enabled,
    // While the socket is up the watch keeps this entry current, so a remount
    // (or a second panel) needs no list of its own.
    staleTime: status === 'live' && refetchInterval === false ? Infinity : 30_000,
    refetchInterval,
    retry: opts.retry ?? false,
    ...(opts.gcTime !== undefined ? { gcTime: opts.gcTime } : {}),
  })
}

/**
 * One `refetchInterval` from several watch signals over related resources:
 * no timer while ANY of them is live (the others are typically refused
 * because their CRD is not installed — nothing to miss there); otherwise the
 * first one's fallback.
 */
export function combineIntervals(...xs: Array<number | false>): number | false {
  return xs.some((x) => x === false) ? false : xs[0] ?? false
}
