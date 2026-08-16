import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { kube } from '@adhar-console/api-clients/k8s'
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s'
import { clusterParam, useActiveCluster } from './client.ts'

/**
 * Live, watch-backed Kubernetes lists. Instead of polling, `useLiveList` does
 * one initial list to seed state + capture `resourceVersion`, then holds an
 * apiserver **watch** open and merges ADDED/MODIFIED/DELETED deltas into a
 * keyed map. It transparently reconnects (resumes from the last
 * resourceVersion; relists from scratch on `410 Gone`), with backoff.
 *
 * The return shape mirrors TanStack Query (`data` / `isLoading` / `error`) so
 * existing views can swap polling → live with no other changes, plus a `status`
 * field for a "● live" indicator.
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'error'

export interface LiveList<T> {
  data: T[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  status: LiveStatus
  /** Force a fresh relist + rewatch. */
  refetch: () => void
}

function keyOf(obj: KubeObject): string {
  return obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ''}/${obj.metadata?.name ?? ''}`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function useLiveList<T extends KubeObject = KubeObject>(
  gvr: GVR,
  opts: {
    namespace?: string
    labelSelector?: string
    fieldSelector?: string
    enabled?: boolean
    /** Explicit cluster override — defaults to the active-cluster selection. */
    cluster?: string
  } = {},
): LiveList<T> {
  const { namespace, labelSelector, fieldSelector, enabled = true } = opts
  const { cluster: activeCluster } = useActiveCluster()
  // Undefined for the gateway default cluster → requests stay byte-identical
  // to single-cluster operation; switching clusters changes `depKey`, which
  // tears down the watch and relists against the newly selected cluster.
  const cluster = clusterParam(opts.cluster ?? activeCluster)
  const [map, setMap] = useState<Map<string, T>>(() => new Map())
  const [isLoading, setLoading] = useState(true)
  const [status, setStatus] = useState<LiveStatus>('connecting')
  const [error, setError] = useState<Error | null>(null)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  const lastClusterRef = useRef(cluster)

  // Stable key so the effect only re-runs on real input changes.
  const depKey = `${gvr.group}/${gvr.version}/${gvr.resource}|${namespace ?? '*'}|${labelSelector ?? ''}|${fieldSelector ?? ''}|${cluster ?? ''}|${enabled}|${nonce}`

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false

    // Cluster switch: drop the previous cluster's objects immediately so the
    // views never mix data from two clusters while the new list is in flight.
    if (lastClusterRef.current !== cluster) {
      lastClusterRef.current = cluster
      setMap(new Map())
    }

    const ac = new AbortController()
    setLoading(true)
    setStatus('connecting')

    ;(async () => {
      let backoff = 1000
      while (!cancelled) {
        try {
          const list = await kube.list<T>(gvr, { namespace, labelSelector, fieldSelector, cluster })
          if (cancelled) return
          const seeded = new Map<string, T>()
          for (const it of list.items) seeded.set(keyOf(it), it)
          setMap(seeded)
          setLoading(false)
          setError(null)
          setStatus('live')
          backoff = 1000
          let rv = list.metadata?.resourceVersion ?? ''

          await kube.watch<T>(
            gvr,
            { namespace, labelSelector, fieldSelector, cluster, resourceVersion: rv, signal: ac.signal },
            (e) => {
              const obj = e.object as T & { metadata?: { resourceVersion?: string } }
              if (e.type === 'BOOKMARK') {
                if (obj.metadata?.resourceVersion) rv = obj.metadata.resourceVersion
                return
              }
              if (e.type === 'ERROR') throw new Error('watch stream error')
              setMap((prev) => {
                const next = new Map(prev)
                const k = keyOf(obj)
                if (e.type === 'DELETED') next.delete(k)
                else next.set(k, obj)
                return next
              })
              if (obj.metadata?.resourceVersion) rv = obj.metadata.resourceVersion
            },
          )
          // Watch closed cleanly (server timeout) → immediately relist + rewatch.
          if (cancelled) return
          setStatus('reconnecting')
        } catch (err) {
          if (cancelled || ac.signal.aborted) return
          setError(err as Error)
          setStatus('error')
          await sleep(backoff)
          backoff = Math.min(backoff * 2, 15_000)
        }
      }
    })()

    return () => {
      cancelled = true
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])

  const data = useMemo(() => [...map.values()], [map])
  return { data, isLoading, isError: status === 'error', error, status, refetch }
}

/* ─────────── discovery + access review ─────────── */

export function useDiscovery() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'discovery', cluster],
    queryFn: () => kube.discovery({ cluster: clusterParam(cluster) }).then((r) => r.resources),
    staleTime: 5 * 60_000,
  })
}

/** Reactive SelfSubjectAccessReview — gate action buttons on it. */
export function useAccess(attrs: {
  verb: string
  group?: string
  resource: string
  namespace?: string
  name?: string
  subresource?: string
  enabled?: boolean
}) {
  const { enabled = true, ...rest } = attrs
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'access', rest.verb, rest.group ?? '', rest.resource, rest.namespace ?? '', rest.name ?? '', cluster],
    queryFn: () => kube.access(rest, { cluster: clusterParam(cluster) }).then((r) => r.allowed),
    enabled,
    staleTime: 60_000,
  })
}
