import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { argocd, k8s } from '@adhar/api-clients'
import { useWatchInvalidate } from './live-k8s.ts'
import type { Entity } from './catalog.ts'
import {
  type ArgoTreeNode,
  buildCompositionGraph,
  type CompositionFetcher,
  type CompositionGraph,
  type KObj,
  nodeId,
  type ObjRef,
  PLATFORM_GROUP,
  refGroup,
  refVersion,
  type RootCandidate,
  rootCandidates,
  type RootInput,
  toFetchError,
} from './catalog-composition-model.ts'

/**
 * Live data for the catalog drawer's Composition tab (and the Raw tab's
 * resource picker), through the console's per-user Kubernetes gateway.
 *
 *   1. Discovery (`/api/k8s/-/discovery`, cached server-side) maps every
 *      `{group, kind}` a ref names to its REST resource and scope. A kind the
 *      apiserver does not serve is a CRD that is not installed — reported as
 *      such rather than as a failed read.
 *   2. Roots: the entity's composite (annotation, else the platform's naming
 *      convention — see `rootCandidates`), companion XRs labelled
 *      `adhar.io/application=<name>`, and the Argo CD apps the Deployment tab
 *      already matched to the entity.
 *   3. The graph: `buildCompositionGraph` from those roots, re-read when a
 *      root's watch reports a change (pausable).
 */

const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

const ARGO_APPS: k8s.GatewayGVR = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true }

/** Minimum gap between two watch-driven re-reads of the graph. */
export const COMPOSITION_REFRESH_MS = 12_000

/* ───────────────────────── discovery ───────────────────────── */

export interface Discovery {
  resolve(group: string, kind: string, version?: string): k8s.DiscoveredResource | undefined
  /** Kinds served in a group (top-level resources only). */
  kindsIn(group: string): k8s.DiscoveredResource[]
  hasGroup(group: string): boolean
}

export function makeDiscovery(resources: readonly k8s.DiscoveredResource[]): Discovery {
  const top = resources.filter((r) => !r.subresource && !r.name.includes('/'))
  const byKind = new Map<string, k8s.DiscoveredResource[]>()
  for (const r of top) {
    const key = `${r.group}/${r.kind}`
    const list = byKind.get(key) ?? []
    list.push(r)
    byKind.set(key, list)
  }
  const groups = new Set(top.map((r) => r.group))
  return {
    resolve(group, kind, version) {
      const list = byKind.get(`${group}/${kind}`)
      if (!list?.length) return undefined
      return (version && list.find((r) => r.version === version)) || list[0]
    },
    kindsIn(group) {
      const seen = new Set<string>()
      return top.filter((r) => r.group === group && !seen.has(r.kind) && seen.add(r.kind))
    },
    hasGroup: (g) => groups.has(g),
  }
}

export class NotServedError extends Error {
  status = 404
  reason = 'NotServed'
  constructor(public group: string, public kind: string) {
    super(`${kind}${group ? `.${group}` : ''} is not served by this cluster — its CRD is not installed.`)
    this.name = 'NotServedError'
  }
}

export function useDiscovery(enabled: boolean) {
  return useQuery({
    queryKey: ['k8s', 'discovery'],
    queryFn: async () => makeDiscovery((await k8s.kube.discovery()).resources),
    enabled,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
  })
}

/* ───────────────────────── fetcher ───────────────────────── */

export function makeFetcher(d: Discovery): CompositionFetcher & { gvrFor(ref: ObjRef): k8s.GatewayGVR } {
  const gvrFor = (ref: ObjRef): k8s.GatewayGVR => {
    const group = refGroup(ref)
    const r = d.resolve(group, ref.kind, refVersion(ref))
    if (!r) throw new NotServedError(group, ref.kind)
    // Keep the version the ref names when it is served, so the object reads
    // back in the shape its owner wrote it.
    return { group: r.group, version: r.version, resource: r.name, namespaced: r.namespaced }
  }
  return {
    gvrFor,
    normalize(ref) {
      const r = d.resolve(refGroup(ref), ref.kind, refVersion(ref))
      return r && !r.namespaced && ref.namespace ? { ...ref, namespace: undefined } : ref
    },
    async get(ref) {
      const gvr = gvrFor(ref)
      return await k8s.kube.get<KObj>(gvr, gvr.namespaced ? ref.namespace : undefined, ref.name)
    },
    async argoTree(app) {
      return (await argocdClient.getResourceTree(app.name, app.namespace)) as ArgoTreeNode[]
    },
  }
}

/* ───────────────────────── roots ───────────────────────── */

export interface CompositionRoot {
  ref: ObjRef
  object?: KObj
  /** How the root was found — provenance shown in the tab. */
  via: string
}

export interface CompositionRoots {
  roots: CompositionRoot[]
  /** Facts worth saying out loud: a CRD missing, a lookup forbidden. */
  notes: string[]
  isLoading: boolean
  /** Discovery itself failed (RBAC, gateway down). */
  error?: { status: number; message: string }
  discovery?: Discovery
}

interface ArgoAppLike {
  metadata: { name: string; namespace?: string }
}

async function resolveRoots(entity: Entity, argoApps: readonly ArgoAppLike[], d: Discovery): Promise<{ roots: CompositionRoot[]; notes: string[] }> {
  const fetcher = makeFetcher(d)
  const roots: CompositionRoot[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  const add = (obj: KObj, via: string) => {
    const ref: ObjRef = { apiVersion: obj.apiVersion, kind: obj.kind ?? '', name: obj.metadata.name, namespace: obj.metadata.namespace }
    const id = nodeId(ref)
    if (seen.has(id)) return
    seen.add(id)
    roots.push({ ref, object: obj, via })
  }

  const candidates: RootCandidate[] = rootCandidates(entity)
  if (candidates.some((c) => c.group === PLATFORM_GROUP) && !d.hasGroup(PLATFORM_GROUP)) {
    notes.push(`The platform APIs (${PLATFORM_GROUP}) are not installed on this cluster, so there is no composite to show.`)
  }
  await Promise.all(candidates.map(async (c) => {
    const r = d.resolve(c.group, c.kind)
    if (!r) return
    const gvr: k8s.GatewayGVR = { group: r.group, version: r.version, resource: r.name, namespaced: r.namespaced }
    try {
      if (c.name) {
        add(await fetcher.get({ group: r.group, version: r.version, kind: c.kind, name: c.name, namespace: c.namespace }), c.via)
      } else if (c.labelSelector) {
        const list = await k8s.kube.list<KObj>(gvr, { namespace: r.namespaced ? c.namespace : undefined, labelSelector: c.labelSelector })
        for (const o of list.items) add({ ...o, apiVersion: o.apiVersion ?? `${r.group}/${r.version}`, kind: o.kind ?? c.kind }, c.via)
      }
    } catch (e) {
      const err = toFetchError(e)
      if (err.status === 403) notes.push(`You do not have permission to read ${c.kind} objects (${c.via}).`)
      else if (err.status !== 404) notes.push(`Could not read ${c.kind} ${c.name ?? c.labelSelector}: ${err.message}`)
    }
  }))

  // Companion composites the control plane made for this application (a
  // Database, Cache, Queue… claimed beside it) carry its label.
  const appName = (entity.metadata.annotations?.['adhar.io/application'] ?? entity.metadata.name).trim()
  if ((entity.kind === 'Component' || entity.kind === 'Resource') && appName) {
    const kinds = d.kindsIn(PLATFORM_GROUP).filter((r) => !['Application', 'Organisation', 'Team', 'Project', 'Environment'].includes(r.kind))
    await Promise.all(kinds.map(async (r) => {
      try {
        const list = await k8s.kube.list<KObj>({ group: r.group, version: r.version, resource: r.name, namespaced: r.namespaced }, { labelSelector: `adhar.io/application=${appName}`, limit: 50 })
        for (const o of list.items) add({ ...o, apiVersion: o.apiVersion ?? `${r.group}/${r.version}`, kind: o.kind ?? r.kind }, `${r.kind} labelled adhar.io/application=${appName}`)
      } catch {
        // A kind the user cannot list is simply not a companion we can show.
      }
    }))
  }

  // Argo CD apps the Deployment tab matched. Read through the apiserver so the
  // raw object (with `status.resources`) is available for the walk and the
  // Raw tab alike; an app that cannot be read still becomes a root by name.
  if (argoApps.length && d.resolve('argoproj.io', 'Application')) {
    await Promise.all(argoApps.map(async (a) => {
      try {
        const o = await k8s.kube.get<KObj>(ARGO_APPS, a.metadata.namespace, a.metadata.name)
        add({ ...o, apiVersion: o.apiVersion ?? 'argoproj.io/v1alpha1', kind: o.kind ?? 'Application' }, 'Argo CD application matched to the entity')
      } catch {
        const ref: ObjRef = { group: 'argoproj.io', version: 'v1alpha1', kind: 'Application', name: a.metadata.name, namespace: a.metadata.namespace }
        const id = nodeId(ref)
        if (!seen.has(id)) {
          seen.add(id)
          roots.push({ ref, via: 'Argo CD application matched to the entity' })
        }
      }
    }))
  }

  // Stable order: composites first, then Argo apps, each by name.
  roots.sort((a, b) => {
    const ga = refGroup(a.ref) === 'argoproj.io' ? 1 : 0
    const gb = refGroup(b.ref) === 'argoproj.io' ? 1 : 0
    return ga - gb || a.ref.name.localeCompare(b.ref.name)
  })
  return { roots, notes }
}

/**
 * Resolve an entity to the platform objects behind it. Cheap enough for the
 * drawer to call on open (it decides whether the tab exists); not polled.
 */
export function useCompositionRoots(entity: Entity, argoApps: readonly ArgoAppLike[], enabled: boolean): CompositionRoots {
  const disc = useDiscovery(enabled)
  const appKey = argoApps.map((a) => `${a.metadata.namespace ?? ''}/${a.metadata.name}`).sort().join(',')
  const ref = `${entity.kind}:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`
  const q = useQuery({
    queryKey: ['catalog', 'composition', 'roots', ref, appKey],
    queryFn: () => resolveRoots(entity, argoApps, disc.data!),
    enabled: enabled && Boolean(disc.data),
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  })
  return useMemo(() => {
    const err = disc.error ? toFetchError(disc.error) : undefined
    return {
      roots: q.data?.roots ?? [],
      notes: q.data?.notes ?? [],
      isLoading: enabled && (disc.isLoading || q.isLoading),
      error: err,
      discovery: disc.data,
    }
  }, [q.data, q.isLoading, disc.data, disc.error, disc.isLoading, enabled])
}

/* ───────────────────────── graph ───────────────────────── */

export function useCompositionGraph(roots: CompositionRoots, opts: { paused: boolean }) {
  const key = roots.roots.map((r) => nodeId(r.ref)).join(',')
  const queryKey = ['catalog', 'composition', 'graph', key]
  // Crossplane rolls every composed resource's state up into its composite's
  // status (Synced/Ready conditions), so the roots' watches say when the
  // graph moved. Re-read at most once per COMPOSITION_REFRESH_MS on a change;
  // never on a timer while the socket is up.
  const watches = useMemo(() => {
    const d = roots.discovery
    if (!d) return []
    const gvrFor = makeFetcher(d).gvrFor
    return roots.roots.flatMap((r) => {
      try {
        const g = gvrFor(r.ref)
        return [{
          group: g.group,
          version: g.version,
          resource: g.resource,
          ...(g.namespaced && r.ref.namespace ? { namespace: r.ref.namespace } : {}),
          fieldSelector: `metadata.name=${r.ref.name}`,
        }]
      } catch {
        return []
      }
    })
  }, [roots.discovery, roots.roots])
  const refetchInterval = useWatchInvalidate(watches, [queryKey], { enabled: !opts.paused, minGapMs: COMPOSITION_REFRESH_MS })
  return useQuery<CompositionGraph>({
    queryKey,
    queryFn: async () => {
      const d = roots.discovery!
      const fetcher = makeFetcher(d)
      // Re-read the roots on every refresh: the resolver's copies are the
      // state at open time, and live status is the point of the tab.
      const inputs: RootInput[] = roots.roots.map((r) => ({ ref: r.ref }))
      return await buildCompositionGraph(inputs, fetcher)
    },
    enabled: Boolean(roots.discovery) && roots.roots.length > 0,
    refetchInterval: opts.paused ? false : refetchInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/** Read one object on demand (Raw tab picker, node detail YAML). */
export function useLiveObject(discovery: Discovery | undefined, ref: ObjRef | undefined, enabled = true) {
  return useQuery<KObj>({
    queryKey: ['catalog', 'composition', 'object', ref ? nodeId(ref) : ''],
    queryFn: () => makeFetcher(discovery!).get(ref!),
    enabled: enabled && Boolean(discovery && ref),
    retry: false,
    staleTime: 5_000,
  })
}

/** Events about one object, newest first. */
export function useObjectEvents(ref: { kind: string; name: string; namespace?: string } | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog', 'composition', 'events', ref?.kind, ref?.namespace, ref?.name],
    queryFn: async () => {
      const list = await k8s.kube.list<KObj & { reason?: string; message?: string; type?: string; count?: number; lastTimestamp?: string; eventTime?: string; firstTimestamp?: string; source?: { component?: string }; reportingComponent?: string }>(
        { group: '', version: 'v1', resource: 'events', namespaced: true },
        { namespace: ref!.namespace || 'default', fieldSelector: `involvedObject.name=${ref!.name},involvedObject.kind=${ref!.kind}`, limit: 100 },
      )
      return list.items
        .map((e) => ({
          type: e.type ?? 'Normal',
          reason: e.reason ?? '',
          message: e.message ?? '',
          count: e.count ?? 1,
          at: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp,
          source: e.source?.component ?? e.reportingComponent,
        }))
        .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    },
    enabled: enabled && Boolean(ref),
    retry: false,
    staleTime: 10_000,
  })
}
