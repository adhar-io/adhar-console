import { createElement, Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { kube } from '@adhar/api-clients/k8s'
import {
  POLL_FLOOR_MS,
  useActiveCluster,
  useActiveNamespace,
  useLiveStatus,
  useOptionalConsoleRole,
  useTeamProjects,
  useWatchSignal,
} from '@adhar/shell-ui'
import { clusterParam } from '../../data/client.ts'
import { watchOf } from '../../data/live.ts'
import {
  type ArchiveFilters,
  type Capabilities,
  getArchived,
  getCapabilities,
  getEngine,
  getHydratedRun,
  getRun,
  listArchive,
  listRuns,
  listTemplates,
  NO_CAPABILITIES,
  probeInstalled,
  statusOf,
} from './api.ts'
import { CLUSTER_WORKFLOW_TEMPLATES, CONTROL_PLANE_NS, CRON_WORKFLOWS, EVENTS, PROJECTS, WORKFLOW_TEMPLATES, WORKFLOWS } from './gvr.ts'
import { isFinished, isRun, readNodes, type WfNode, type Workflow } from './nodes.ts'
import { type PendingApproval, pendingApprovals } from './approvals.ts'
import { type ProjectXR, type ScopeNamespace, scopeNamespaces } from './scope.ts'

/**
 * Workflows, the hooks: `api.ts` kept live by apiserver WATCHES over the shared
 * socket (acceptance 1 of W1: a team member sees runs move without the 60 s
 * poll). A list across namespaces opens one watch per namespace the caller can
 * read; a timer runs only while the socket is down or a watch was refused.
 */

const PLATFORM_ROLES = new Set(['super-admin', 'platform-admin', 'platform-engineer'])

/** Platform staff: the console role says so (RBAC still decides every request). */
export function useIsPlatformStaff(): boolean {
  const role = useOptionalConsoleRole()
  return role !== null && PLATFORM_ROLES.has(role)
}

export function useWorkflowCluster(): { cluster: string | undefined; key: string } {
  const { cluster } = useActiveCluster()
  return { cluster: clusterParam(cluster), key: cluster }
}

/* ─────────────────────────── capabilities ─────────────────────────── */

export interface CapabilityState {
  caps: Capabilities
  /** The BFF answered (otherwise `caps` came from the gateway probe alone). */
  bff: boolean
  isLoading: boolean
}

/** `GET /api/workflows/capabilities`, cached 60 s per cluster (§6.3). */
export function useCapabilities(): CapabilityState {
  const { cluster, key } = useWorkflowCluster()
  const q = useQuery({
    queryKey: ['workflows', 'capabilities', key],
    queryFn: async (): Promise<{ caps: Capabilities; bff: boolean }> => {
      try {
        return { caps: await getCapabilities(cluster), bff: true }
      } catch {
        // An older console server, or the BFF failing: the gateway still says
        // whether the kind is served, and every gateway feature keeps working.
        return { caps: { ...NO_CAPABILITIES, installed: await probeInstalled(cluster) }, bff: false }
      }
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: false,
  })
  return { caps: q.data?.caps ?? NO_CAPABILITIES, bff: q.data?.bff ?? false, isLoading: q.isLoading }
}

/* ─────────────────────────── scope ─────────────────────────── */

export interface Scope {
  namespaces: ScopeNamespace[]
  /** Only the top-bar namespace. */
  only?: string
  ready: boolean
  platform: boolean
  key: string
}

const SIGNAL = { fallbackMs: POLL_FLOOR_MS, throttleMs: 2_000 }

/** The namespaces this person's workflows live in (see scope.ts). */
export function useScope(): Scope {
  const { namespace } = useActiveNamespace()
  const { cluster, key: clusterKey } = useWorkflowCluster()
  const platform = useIsPlatformStaff()
  const team = useTeamProjects()
  const queryKey = ['workflows', 'projects', clusterKey]
  const q = useQuery({
    queryKey,
    queryFn: async (): Promise<ProjectXR[]> => {
      try {
        return (await kube.list<ProjectXR>(PROJECTS, { namespace: CONTROL_PLANE_NS, cluster })).items ?? []
      } catch (e) {
        if (statusOf(e) === 403 || statusOf(e) === 404) return []
        throw e
      }
    },
    refetchInterval: useWatchSignal(watchOf(PROJECTS, { namespace: CONTROL_PLANE_NS, cluster }), [queryKey], SIGNAL),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 1,
  })
  const teamFilter = useMemo(() => {
    if (!team.filtering) return undefined
    return new Set(team.projects.flatMap((p) => [p.slug, p.id, p.argoProject].filter((v): v is string => Boolean(v))))
  }, [team.filtering, team.projects])
  const namespaces = useMemo(
    () => scopeNamespaces(q.data ?? [], { selected: namespace, platform, projectFilter: teamFilter }),
    [q.data, namespace, platform, teamFilter],
  )
  return {
    namespaces,
    only: namespace,
    ready: !q.isLoading,
    platform,
    key: `${clusterKey}|${namespace ?? '*'}|${namespaces.map((n) => n.namespace).join(',')}`,
  }
}

/* ─────────────────────────── watches across a scope ─────────────────────────── */

type Gvr = { group: string; version: string; resource: string }

function WatchOne({ gvr, namespace, labelSelector, cluster, queryKeys, throttleMs }: { gvr: Gvr; namespace?: string; labelSelector?: string; cluster?: string; queryKeys: unknown[][]; throttleMs: number }) {
  useWatchSignal(watchOf(gvr, { namespace, labelSelector, cluster }), queryKeys, { fallbackMs: POLL_FLOOR_MS, throttleMs })
  return null
}

/**
 * One apiserver watch per namespace (or one cluster-wide), each invalidating
 * `queryKeys` when something in it changes. A component, because the number of
 * watches follows the scope and hooks cannot be called in a loop.
 */
export function ScopeWatches({ gvr, mode, namespaces, denied, labelSelector, queryKeys, throttleMs = 2_000 }: { gvr: Gvr; mode: 'cluster' | 'namespaces' | undefined; namespaces: readonly string[]; denied?: readonly string[]; labelSelector?: string; queryKeys: unknown[][]; throttleMs?: number }) {
  const { cluster } = useWorkflowCluster()
  if (!mode) return null
  // A namespace that refused the list would refuse the watch too: not asked.
  const targets = mode === 'cluster' ? [undefined] : namespaces.filter((n) => !denied?.includes(n))
  return createElement(
    Fragment,
    null,
    ...targets.map((ns) => createElement(WatchOne, { key: ns ?? '*', gvr, namespace: ns, labelSelector, cluster, queryKeys, throttleMs })),
  )
}

/** The timer a list falls back to: only while the live socket is down. */
export function useFallbackInterval(): number | false {
  return useLiveStatus() === 'live' ? false : POLL_FLOOR_MS
}

/* ─────────────────────────── runs ─────────────────────────── */

export function useRuns(scope: Scope, labelSelector: string | undefined, enabled = true) {
  const { cluster, key } = useWorkflowCluster()
  const queryKey = ['workflows', 'runs', key, scope.key, labelSelector ?? '']
  const fallback = useFallbackInterval()
  const q = useQuery({
    queryKey,
    queryFn: () => listRuns({ namespaces: scope.namespaces.map((n) => n.namespace), labelSelector, cluster, only: scope.only }),
    enabled: enabled && scope.ready,
    refetchInterval: fallback,
    placeholderData: keepPreviousData,
    retry: 1,
  })
  return { ...q, queryKey }
}

/**
 * One run, live: its own watch (by name), throttled to 2 Hz (§6.8), with the
 * nodes inflated in the browser — and, when they cannot be (offloaded, or a
 * compression the browser cannot read), the run as argo-server hydrates it.
 */
export function useRun(namespace: string | undefined, name: string | undefined) {
  const { cluster, key } = useWorkflowCluster()
  const on = Boolean(namespace && name)
  const queryKey = ['workflows', 'run', key, namespace, name]
  const signal = useWatchSignal(
    on ? watchOf(WORKFLOWS, { namespace, fieldSelector: `metadata.name=${name}`, cluster }) : null,
    [queryKey],
    { fallbackMs: POLL_FLOOR_MS, throttleMs: 500, enabled: on },
  )
  const q = useQuery({
    queryKey,
    queryFn: () => getRun(namespace!, name!, cluster),
    enabled: on,
    refetchInterval: signal,
    // No placeholder across keys: the previous key is another run (isRun).
    retry: 1,
  })
  const run = isRun(q.data, namespace, name) ? q.data : null
  const [nodes, setNodes] = useState<{ key?: string; rv?: string; nodes: Record<string, WfNode> | null; hydrated: boolean }>({ nodes: null, hydrated: false })
  const rv = run?.metadata.resourceVersion
  const runKey = `${key}|${namespace}/${name}`
  useEffect(() => {
    let cancelled = false
    if (!run) return
    void (async () => {
      const r = await readNodes(run)
      if (cancelled) return
      if (r.state === 'ready') {
        setNodes({ key: runKey, rv, nodes: r.nodes, hydrated: false })
        return
      }
      try {
        const h = await getHydratedRun(namespace!, name!, cluster)
        if (!cancelled) setNodes({ key: runKey, rv, nodes: h.status?.nodes ?? {}, hydrated: true })
      } catch {
        if (!cancelled) setNodes({ key: runKey, rv, nodes: null, hydrated: true })
      }
    })()
    return () => {
      cancelled = true
    }
  // The run object changes identity on every refetch; its resourceVersion is what moved.
  }, [rv, runKey, cluster])
  // Another run's nodes are never this run's, however briefly.
  const mine = nodes.key === runKey
  return { ...q, run, gone: q.isSuccess && q.data === null, nodes: mine ? nodes.nodes : null, hydrated: mine && nodes.hydrated, nodesStale: !mine || nodes.rv !== rv }
}

/** Kubernetes events in a run's namespace that are about the run or its pods. */
export function useRunEvents(namespace: string | undefined, run: string | undefined, enabled = true) {
  const { cluster, key } = useWorkflowCluster()
  const on = enabled && Boolean(namespace && run)
  const queryKey = ['workflows', 'events', key, namespace, run]
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        const items = (await kube.list<{ metadata: { uid?: string; name: string }; involvedObject?: { kind?: string; name?: string }; reason?: string; message?: string; type?: string; lastTimestamp?: string; eventTime?: string; count?: number }>(EVENTS, { namespace, cluster })).items ?? []
        return { items: items.filter((e) => e.involvedObject?.name === run || e.involvedObject?.name?.startsWith(`${run}-`)), forbidden: false }
      } catch (e) {
        if (statusOf(e) === 403) return { items: [], forbidden: true }
        throw e
      }
    },
    enabled: on,
    refetchInterval: useWatchSignal(on ? watchOf(EVENTS, { namespace, cluster }) : null, [queryKey], { fallbackMs: POLL_FLOOR_MS, throttleMs: 5_000, enabled: on }),
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/* ─────────────────────────── templates ─────────────────────────── */

export function useTemplates(scope: Scope, enabled = true) {
  const { cluster, key } = useWorkflowCluster()
  const queryKey = ['workflows', 'templates', key, scope.key]
  const q = useQuery({
    queryKey,
    queryFn: () => listTemplates({ namespaces: scope.namespaces.map((n) => n.namespace), cluster, only: scope.only }),
    enabled: enabled && scope.ready,
    refetchInterval: useFallbackInterval(),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: 1,
  })
  return { ...q, queryKey }
}

/** The watches that keep `useTemplates` live; rendered by the views that show templates. */
export function TemplateWatches({ scope, mode, queryKey }: { scope: Scope; mode: 'cluster' | 'namespaces' | undefined; queryKey: unknown[] }) {
  const namespaces = scope.namespaces.map((n) => n.namespace)
  return createElement(
    Fragment,
    null,
    createElement(ScopeWatches, { gvr: WORKFLOW_TEMPLATES, mode, namespaces, queryKeys: [queryKey], throttleMs: 5_000 }),
    createElement(ScopeWatches, { gvr: CRON_WORKFLOWS, mode, namespaces, queryKeys: [queryKey], throttleMs: 5_000 }),
    createElement(ScopeWatches, { gvr: CLUSTER_WORKFLOW_TEMPLATES, mode: mode ? 'cluster' : undefined, namespaces: [], queryKeys: [queryKey], throttleMs: 5_000 }),
  )
}

/* ─────────────────────────── archive + engine ─────────────────────────── */

export function useArchive(namespace: string | undefined, filters: ArchiveFilters, enabled = true) {
  const { cluster, key } = useWorkflowCluster()
  return useQuery({
    queryKey: ['workflows', 'archive', key, namespace, filters],
    queryFn: () => listArchive(namespace!, filters, cluster),
    enabled: enabled && Boolean(namespace),
    // Keep the page on screen while paging or filtering ONE namespace; never
    // across namespaces — archived rows carry no namespace column, so another
    // namespace's runs would read as this one's, and opening one asks the BFF
    // for a uid in the wrong namespace (404).
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === key && prevQuery?.queryKey[3] === namespace ? prev : undefined),
    staleTime: 15_000,
    retry: false,
  })
}

export function useArchivedRun(namespace: string | undefined, uid: string | undefined) {
  const { cluster, key } = useWorkflowCluster()
  return useQuery({
    queryKey: ['workflows', 'archived', key, namespace, uid],
    queryFn: () => getArchived(namespace!, uid!, cluster),
    enabled: Boolean(namespace && uid),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useEngine(enabled = true) {
  const { cluster, key } = useWorkflowCluster()
  return useQuery({
    queryKey: ['workflows', 'engine', key],
    queryFn: () => getEngine(cluster),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  })
}

/** Invalidate every Workflows query (after a write the watches have not seen yet). */
export function useInvalidateWorkflows(): () => void {
  const qc = useQueryClient()
  return useCallback(() => void qc.invalidateQueries({ queryKey: ['workflows'] }), [qc])
}

/* ─────────────────────────── clock ─────────────────────────── */

/** A ticking clock while `active` — run durations move between watch events. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

/* ─────────────────────────── URL params ─────────────────────────── */

export interface WfParams {
  run?: string
  node?: string
  tab?: string
  uid?: string
  ns?: string
  q?: string
  view?: string
}

const KEYS = ['run', 'node', 'tab', 'uid', 'ns', 'q', 'view'] as const

export function readParams(search: string): WfParams {
  const q = new URLSearchParams(search)
  const out: WfParams = {}
  for (const k of KEYS) {
    const raw = q.get(k)
    if (!raw) continue
    let v = raw
    // TanStack Router JSON-encodes values that look like JSON; read either form.
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v)
      } catch { /* keep raw */ }
    }
    out[k] = v
  }
  return out
}

type RouterLike = { history?: { location?: { search?: string; pathname?: string }; subscribe?(fn: () => void): () => void }; navigate?(opts: Record<string, unknown>): unknown } | null | undefined

/**
 * The page's deep-link params (`run`, `node`, `tab`, `uid`, `ns`, `q`, `view`),
 * kept in step with the URL both ways: re-read on Back/Forward and on the host
 * router's navigations; written through the router so the host hears them.
 * Opening a run pushes a history entry (Back closes it); tabs replace.
 */
export function useWfParams(): [WfParams, (patch: WfParams, push?: boolean) => void] {
  const router = useRouter({ warn: false }) as unknown as RouterLike
  const current = useCallback(() => router?.history?.location?.search ?? (typeof location === 'undefined' ? '' : location.search), [router])
  const [params, setParams] = useState<WfParams>(() => readParams(current()))
  useEffect(() => {
    const sync = () => {
      const next = readParams(current())
      setParams((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
    }
    sync()
    globalThis.addEventListener('popstate', sync)
    const unsubscribe = router?.history?.subscribe?.(() => queueMicrotask(sync))
    return () => {
      globalThis.removeEventListener('popstate', sync)
      unsubscribe?.()
    }
  }, [router, current])
  const patch = useCallback((p: WfParams, push = false) => {
    setParams((cur) => {
      const next: WfParams = { ...cur }
      for (const [k, v] of Object.entries(p) as Array<[keyof WfParams, string | undefined]>) {
        if (v) next[k] = v
        else delete next[k]
      }
      return next
    })
    if (router?.navigate) {
      void router.navigate({
        to: router.history?.location?.pathname ?? location.pathname,
        search: ((prev: Record<string, unknown>) => {
          const out: Record<string, unknown> = { ...prev }
          for (const [k, v] of Object.entries(p)) {
            if (v) out[k] = v
            else delete out[k]
          }
          return out
        }) as never,
        replace: !push,
      })
      return
    }
    if (typeof location === 'undefined') return
    const q = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(p)) {
      if (v) q.set(k, v)
      else q.delete(k)
    }
    const url = `${location.pathname}?${q.toString()}`
    if (push) history.pushState(history.state, '', url)
    else history.replaceState(history.state, '', url)
    globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  }, [router])
  return [params, patch]
}

/** Navigate to another Workflows section (a history entry the host router hears). */
export function goToSection(section: string, extra: Record<string, string> = {}): void {
  const url = new URL(globalThis.location.href)
  for (const k of [...url.searchParams.keys()]) if (k !== 'section') url.searchParams.delete(k)
  url.searchParams.set('section', section)
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
  history.pushState(history.state, '', `${url.pathname}${url.search}`)
  globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

/* ─────────────────────────── approvals across runs ─────────────────────────── */

/**
 * Every approval waiting in the given runs. A run's nodes may be compressed,
 * so they are read asynchronously; only unfinished runs are read at all, and a
 * run is re-read only when its resourceVersion moved.
 */
export function usePendingApprovals(runs: readonly Workflow[] | undefined): PendingApproval[] {
  const live = useMemo(() => (runs ?? []).filter((w) => !isFinished(w)), [runs])
  const key = live.map((w) => `${w.metadata.namespace}/${w.metadata.name}@${w.metadata.resourceVersion ?? ''}`).join('|')
  const [out, setOut] = useState<PendingApproval[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const all: PendingApproval[] = []
      for (const w of live) {
        const r = await readNodes(w)
        if (r.state === 'ready') all.push(...pendingApprovals(w, r.nodes))
      }
      if (!cancelled) setOut(all)
    })()
    return () => {
      cancelled = true
    }
    // `key` stands for `live`: the list identity changes on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return out
}
