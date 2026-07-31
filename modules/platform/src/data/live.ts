import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar-console/api-clients'
import { kube } from '@adhar-console/api-clients/k8s'
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s'
import { isDevK8s } from './client.ts'

/**
 * In dev (pure SPA, no gateway) the live list resolves from stub fixtures once
 * instead of opening a watch — so UI work needs no cluster / kubectl proxy.
 */
const stubClient = isDevK8s ? k8s.K8sClient.stub() : null
async function stubList(gvr: GVR): Promise<KubeObject[]> {
  if (!stubClient) return []
  const byResource: Record<string, () => Promise<unknown[]>> = {
    pods: () => stubClient.listPods(),
    nodes: () => stubClient.listNodes(),
    deployments: () => stubClient.listDeployments(),
    statefulsets: () => stubClient.listStatefulSets(),
    daemonsets: () => stubClient.listDaemonSets(),
    events: () => stubClient.listEvents(),
    services: () => stubClient.listServices(),
    ingresses: () => stubClient.listIngresses(),
    namespaces: () => stubClient.listNamespaces(),
  }
  const fn = byResource[gvr.resource]
  if (fn) return (await fn().catch(() => [])) as KubeObject[]
  return (await stubClient.listGeneric(undefined, gvr).catch(() => [])) as KubeObject[]
}

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
  opts: { namespace?: string; labelSelector?: string; fieldSelector?: string; enabled?: boolean } = {},
): LiveList<T> {
  const { namespace, labelSelector, fieldSelector, enabled = true } = opts
  const [map, setMap] = useState<Map<string, T>>(() => new Map())
  const [isLoading, setLoading] = useState(true)
  const [status, setStatus] = useState<LiveStatus>('connecting')
  const [error, setError] = useState<Error | null>(null)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  // Stable key so the effect only re-runs on real input changes.
  const depKey = `${gvr.group}/${gvr.version}/${gvr.resource}|${namespace ?? '*'}|${labelSelector ?? ''}|${fieldSelector ?? ''}|${enabled}|${nonce}`

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false

    // Dev: one-shot stub fixtures, no watch, no network.
    if (isDevK8s) {
      void stubList(gvr).then((list) => {
        if (cancelled) return
        const seeded = new Map<string, T>()
        for (const it of list as T[]) seeded.set(keyOf(it), it)
        setMap(seeded)
        setLoading(false)
        setStatus('live')
        setError(null)
      })
      return () => {
        cancelled = true
      }
    }

    const ac = new AbortController()
    setLoading(true)
    setStatus('connecting')

    ;(async () => {
      let backoff = 1000
      while (!cancelled) {
        try {
          const list = await kube.list<T>(gvr, { namespace, labelSelector, fieldSelector })
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
            { namespace, labelSelector, fieldSelector, resourceVersion: rv, signal: ac.signal },
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
  return useQuery({
    queryKey: ['k8s', 'discovery', isDevK8s],
    queryFn: () => (isDevK8s ? Promise.resolve(devDiscovery()) : kube.discovery().then((r) => r.resources)),
    staleTime: 5 * 60_000,
  })
}

/** Minimal stub discovery (dev) so the resource browser has kinds to show. */
function devDiscovery() {
  return Object.entries(devGvrs).map(([kind, g]) => ({
    group: g.group,
    version: g.version,
    groupVersion: g.group ? `${g.group}/${g.version}` : g.version,
    kind,
    name: g.resource,
    namespaced: g.namespaced ?? true,
    verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
    subresource: false,
  }))
}
const devGvrs: Record<string, GVR> = {
  Pod: { group: '', version: 'v1', resource: 'pods', namespaced: true },
  Service: { group: '', version: 'v1', resource: 'services', namespaced: true },
  ConfigMap: { group: '', version: 'v1', resource: 'configmaps', namespaced: true },
  Secret: { group: '', version: 'v1', resource: 'secrets', namespaced: true },
  Namespace: { group: '', version: 'v1', resource: 'namespaces', namespaced: false },
  Node: { group: '', version: 'v1', resource: 'nodes', namespaced: false },
  Deployment: { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true },
  StatefulSet: { group: 'apps', version: 'v1', resource: 'statefulsets', namespaced: true },
  DaemonSet: { group: 'apps', version: 'v1', resource: 'daemonsets', namespaced: true },
  Job: { group: 'batch', version: 'v1', resource: 'jobs', namespaced: true },
  CronJob: { group: 'batch', version: 'v1', resource: 'cronjobs', namespaced: true },
  Ingress: { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', namespaced: true },
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
  return useQuery({
    queryKey: ['k8s', 'access', rest.verb, rest.group ?? '', rest.resource, rest.namespace ?? '', rest.name ?? ''],
    queryFn: () => (isDevK8s ? Promise.resolve(true) : kube.access(rest).then((r) => r.allowed)),
    enabled,
    staleTime: 60_000,
  })
}
