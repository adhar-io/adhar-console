import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { K8sError, kube, resourcePath } from '@adhar/api-clients/k8s'
import type { GatewayGVR as GVR } from '@adhar/api-clients/k8s'
import { clusterParam, useActiveCluster } from './client.ts'
import type { KubeTable } from './explore.ts'

/**
 * Explore — the I/O half of the resource browser: the apiserver's Table
 * rendering (kubectl's printer columns), cheap per-kind counts, the
 * per-browser pins/recents store and the `?kind=&obj=` deep link.
 */

/* ─── printer columns (as=Table) ────────────────────────────────────────── */

const TABLE_ACCEPT = 'application/json;as=Table;v=v1;g=meta.k8s.io,application/json;as=Table;v=v1beta1;g=meta.k8s.io,application/json'

async function fetchTable(
  gvr: GVR,
  opts: { namespace?: string; labelSelector?: string; cluster?: string },
): Promise<KubeTable | null> {
  const q = new URLSearchParams({ includeObject: 'Metadata' })
  if (opts.labelSelector) q.set('labelSelector', opts.labelSelector)
  if (opts.cluster) q.set('cluster', opts.cluster)
  const res = await fetch(`/api/k8s${resourcePath(gvr, { namespace: opts.namespace })}?${q}`, {
    credentials: 'include',
    headers: { accept: TABLE_ACCEPT },
  })
  if (!res.ok) throw new K8sError(res.status, `${res.status} ${res.statusText}`)
  const body = (await res.json()) as KubeTable
  // An aggregated API that can't render tables answers with a plain list.
  return body?.kind === 'Table' ? body : null
}

/**
 * kubectl's columns for any kind, rendered server-side. The apiserver applies a
 * CRD's `additionalPrinterColumns` and the built-in printers alike, so this one
 * request gives Deployments their READY/UP-TO-DATE and Argo Applications their
 * SYNC STATUS/HEALTH without per-kind code. It is a snapshot, so the caller
 * bumps `version` (debounced) whenever the live watch changes the row set.
 */
export function useResourceTable(
  gvr: GVR,
  opts: { namespace?: string; labelSelector?: string; enabled: boolean; version: number },
) {
  const { cluster } = useActiveCluster()
  const c = clusterParam(cluster)
  return useQuery({
    queryKey: ['k8s', 'explore-table', gvr.group, gvr.version, gvr.resource, opts.namespace ?? '', opts.labelSelector ?? '', cluster, opts.version],
    queryFn: () => fetchTable(gvr, { namespace: opts.namespace, labelSelector: opts.labelSelector, cluster: c }),
    enabled: opts.enabled,
    // Keep the previous columns on screen while the next snapshot loads.
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    retry: false,
  })
}

/**
 * Object count for one kind — a `limit=1` list reads `remainingItemCount`, so
 * the picker can show "Pods 214" without transferring 214 pods.
 */
export function useKindCount(gvr: GVR | null, namespace: string | undefined, enabled = true) {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'explore-count', gvr?.group, gvr?.version, gvr?.resource, gvr?.namespaced ? namespace ?? '' : '', cluster],
    queryFn: async () => {
      const list = await kube.list(gvr!, {
        namespace: gvr!.namespaced ? namespace : undefined,
        limit: 1,
        cluster: clusterParam(cluster),
      })
      const remaining = (list.metadata as { remainingItemCount?: number }).remainingItemCount ?? 0
      return list.items.length + remaining
    },
    enabled: enabled && !!gvr,
    // One count per kind in the picker: a hint, not a live number.
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/* ─── pins + recents (per browser) ──────────────────────────────────────── */

function readList(key: string): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** A string list persisted to localStorage; storage failures degrade to memory. */
export function useStoredList(key: string, fallback: string[] = []) {
  const [list, setList] = useState<string[]>(() => {
    const v = readList(key)
    return v.length ? v : fallback
  })
  const update = useCallback(
    (fn: (prev: string[]) => string[]) => {
      setList((prev) => {
        const next = fn(prev)
        try {
          globalThis.localStorage?.setItem(key, JSON.stringify(next))
        } catch {
          /* private window / quota — keep it in memory */
        }
        return next
      })
    },
    [key],
  )
  return [list, update] as const
}

/* ─── deep link ─────────────────────────────────────────────────────────── */

export interface ExploreLink {
  /** kubectl-style kind: `deployments.apps`. */
  kind?: string
  /** `namespace/name`, or `name` for cluster-scoped objects. */
  obj?: string
}

function readLink(): ExploreLink {
  if (typeof location === 'undefined') return {}
  const p = new URLSearchParams(location.search)
  return { kind: p.get('kind') ?? undefined, obj: p.get('obj') ?? undefined }
}

/**
 * `?kind=` / `?obj=` alongside the host's `?section=explore`. Written with
 * `history.replaceState` (keeping the router's own history state) so the page
 * is shareable and survives reloads without stacking history entries, and
 * re-read on back/forward.
 */
export function useExploreLink() {
  const [link, setLink] = useState<ExploreLink>(readLink)
  const linkRef = useRef(link)
  linkRef.current = link

  useEffect(() => {
    const onPop = () => setLink(readLink())
    globalThis.addEventListener('popstate', onPop)
    return () => globalThis.removeEventListener('popstate', onPop)
  }, [])

  const update = useCallback((patch: ExploreLink) => {
    const next = { ...linkRef.current, ...patch }
    setLink(next)
    if (typeof location === 'undefined') return
    try {
      const url = new URL(location.href)
      for (const k of ['kind', 'obj'] as const) {
        if (next[k]) url.searchParams.set(k, next[k]!)
        else url.searchParams.delete(k)
      }
      if (url.href !== location.href) history.replaceState(history.state, '', url)
    } catch {
      /* sandboxed frame — the in-memory state still drives the page */
    }
  }, [])

  return [link, update] as const
}
