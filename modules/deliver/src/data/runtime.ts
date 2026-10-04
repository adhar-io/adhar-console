import { useQueries, useQuery } from '@tanstack/react-query'
import type { k8s as K8s } from '@adhar-console/api-clients'
import { client, useCRD } from './k8s.ts'
import {
  byNewest,
  parseEventLines,
  type RuntimeEngine,
  type RuntimeEvent,
} from './runtime-events.ts'
import { groupBy, parsePrometheusText, series, total, type Sample } from './prom-text.ts'

/**
 * Data layer for **Runtime Security**.
 *
 * Both engines on this platform run as DaemonSets and both write their events
 * as newline-delimited JSON to a container's stdout — Tetragon through its
 * `export-stdout` sidecar, Falco from the `falco` container itself. So the
 * feed is read from container logs through the authenticated k8s gateway
 * (`/api/k8s/…`), the same path every other Deliver view uses, with the
 * signed-in user's own RBAC. No new tool proxy, no exporter to deploy, and
 * nothing seeded: an engine that is not installed contributes nothing.
 *
 * The one thing logs cannot give is totals since the agent started — a tail is
 * the last few minutes by definition. Tetragon publishes those on its metrics
 * port, reached through the apiserver's service proxy. That call is allowed to
 * fail: it needs `services/proxy` on the agent's namespace, which not every
 * viewer has, and the page is fully usable without it.
 */

const EVENTS_REFRESH_MS = 10_000
const AGENTS_REFRESH_MS = 30_000

/** How each engine's events are found once its DaemonSet is located. */
const ENGINES: Record<RuntimeEngine, { daemonSet: string; container: string; label: string }> = {
  tetragon: { daemonSet: 'tetragon', container: 'export-stdout', label: 'Tetragon' },
  falco: { daemonSet: 'falco', container: 'falco', label: 'Falco' },
}

export interface AgentPod {
  name: string
  namespace: string
  node?: string
  ready: boolean
  phase: string
  restarts: number
  age?: string
}

export interface EngineStatus {
  engine: RuntimeEngine
  label: string
  installed: boolean
  namespace?: string
  /** Image tag of the agent container, which is the version operators quote. */
  version?: string
  desired: number
  ready: number
  pods: AgentPod[]
}

type Generic = K8s.Generic

function img(spec: Record<string, unknown> | undefined, container: string): string | undefined {
  const containers = ((spec?.containers ?? []) as Array<Record<string, unknown>>) ?? []
  const match = containers.find((c) => c.name === container) ?? containers[0]
  const image = typeof match?.image === 'string' ? match.image : undefined
  if (!image) return undefined
  // `quay.io/cilium/tetragon:v1.7.1` → `v1.7.1`; a digest is not a version.
  const tag = image.split('@')[0].split(':').pop()
  return tag && tag !== image ? tag : undefined
}

/** `spec.selector.matchLabels` as the `labelSelector` query the API expects. */
function labelSelector(ds?: Generic): string | undefined {
  const spec = (ds?.spec ?? {}) as Record<string, unknown>
  const selector = (spec.selector ?? {}) as Record<string, unknown>
  const labels = (selector.matchLabels ?? {}) as Record<string, unknown>
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${String(v)}`)
  return pairs.length ? pairs.join(',') : undefined
}

/**
 * Locate both agents.
 *
 * The namespace is discovered rather than assumed: this platform installs them
 * into `adhar-system`, upstream charts default to `kube-system` or a namespace
 * of their own, and hardcoding either would report a running agent as missing.
 */
export function useRuntimeAgents() {
  const daemonSets = useQuery({
    queryKey: ['deliver', 'runtime', 'daemonsets'],
    queryFn: () => client.listDaemonSets(undefined, undefined),
    refetchInterval: AGENTS_REFRESH_MS,
    retry: false,
  })

  const found: Partial<Record<RuntimeEngine, Generic>> = {}
  for (const ds of daemonSets.data ?? []) {
    for (const engine of Object.keys(ENGINES) as RuntimeEngine[]) {
      if (ds.metadata?.name === ENGINES[engine].daemonSet) found[engine] = ds
    }
  }

  const podQueries = useQueries({
    queries: (Object.keys(ENGINES) as RuntimeEngine[]).map((engine) => {
      const ds = found[engine]
      const namespace = ds?.metadata?.namespace
      // The DaemonSet's own selector is exactly the set of pods it owns — no
      // guessing at chart labels, and no listing a namespace that holds two
      // hundred unrelated pods to find five.
      const selector = labelSelector(ds)
      return {
        queryKey: ['deliver', 'runtime', 'pods', engine, namespace ?? '-', selector ?? '-'],
        queryFn: () => client.listPods(undefined, namespace, selector),
        enabled: Boolean(namespace),
        refetchInterval: AGENTS_REFRESH_MS,
        retry: false,
      }
    }),
  })

  const engines: EngineStatus[] = (Object.keys(ENGINES) as RuntimeEngine[]).map((engine, i) => {
    const ds = found[engine]
    const meta = ds?.metadata
    const status = (ds?.status ?? {}) as Record<string, number>
    const spec = (ds?.spec ?? {}) as Record<string, unknown>
    const template = (spec.template ?? {}) as Record<string, unknown>
    const pods = ((podQueries[i].data ?? []) as K8s.Pod[])
      .map((p) => ({
        name: p.metadata?.name ?? '',
        namespace: p.metadata?.namespace ?? '',
        node: (p.spec as { nodeName?: string } | undefined)?.nodeName,
        ready: (p.status?.containerStatuses ?? []).every((c) => c.ready) &&
          (p.status?.containerStatuses ?? []).length > 0,
        phase: p.status?.phase ?? 'Unknown',
        restarts: (p.status?.containerStatuses ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0),
        age: p.metadata?.creationTimestamp,
      }))
      .sort((a, b) => (a.node ?? a.name).localeCompare(b.node ?? b.name))

    return {
      engine,
      label: ENGINES[engine].label,
      installed: Boolean(ds),
      namespace: meta?.namespace,
      version: img(template.spec as Record<string, unknown> | undefined, ENGINES[engine].daemonSet),
      desired: status.desiredNumberScheduled ?? 0,
      ready: status.numberReady ?? 0,
      pods,
    }
  })

  return {
    engines,
    isLoading: daemonSets.isLoading,
    isError: daemonSets.isError,
    error: daemonSets.error,
    refetch: daemonSets.refetch,
  }
}

/**
 * The merged event feed.
 *
 * Every agent pod reports only what happened on its own node, so a
 * cluster-wide feed is every pod's tail merged in time order. The tail is
 * bounded per pod: a busy node can emit thousands of process events a minute,
 * and the page is a feed, not an archive.
 */
export function useRuntimeEvents(
  engines: EngineStatus[],
  opts: { tailLines?: number; enabled?: boolean } = {},
) {
  const tailLines = opts.tailLines ?? 250
  const targets = engines.flatMap((e) =>
    e.installed
      ? e.pods.filter((p) => p.ready).map((p) => ({ engine: e.engine, pod: p }))
      : []
  )

  const queries = useQueries({
    queries: targets.map(({ engine, pod }) => ({
      queryKey: ['deliver', 'runtime', 'events', engine, pod.namespace, pod.name, tailLines],
      queryFn: async () => {
        const text = await client.podLogs(undefined, pod.namespace, pod.name, {
          container: ENGINES[engine].container,
          tailLines,
        })
        return parseEventLines(text, engine)
      },
      enabled: opts.enabled !== false,
      refetchInterval: EVENTS_REFRESH_MS,
      retry: false,
      // A node's feed stays on screen while the next tail is in flight, so the
      // list does not empty and refill every ten seconds.
      placeholderData: (prev: RuntimeEvent[] | undefined) => prev,
    })),
  })

  const events = queries.flatMap((q) => q.data ?? []).sort(byNewest)
  const failures = queries.filter((q) => q.isError).length

  return {
    events,
    /** Agent pods whose log could not be read — usually an RBAC gap. */
    failures,
    total: targets.length,
    isLoading: queries.length > 0 && queries.every((q) => q.isLoading),
    isFetching: queries.some((q) => q.isFetching),
    refetch: () => Promise.all(queries.map((q) => q.refetch())),
  }
}

/* ─────────── TracingPolicies ─────────── */

export const TRACING_POLICY_GVR = {
  group: 'cilium.io',
  version: 'v1alpha1',
  resource: 'tracingpolicies',
  namespaced: false,
} as const

export const TRACING_POLICY_NS_GVR = {
  group: 'cilium.io',
  version: 'v1alpha1',
  resource: 'tracingpoliciesnamespaced',
  namespaced: true,
} as const

export function useTracingPolicies(enabled = true) {
  return useCRD(TRACING_POLICY_GVR, undefined, enabled)
}

export function useTracingPoliciesNamespaced(enabled = true) {
  return useCRD(TRACING_POLICY_NS_GVR, undefined, enabled)
}

/* ─────────── Tetragon metrics ─────────── */

export interface TetragonMetrics {
  samples: Sample[]
  /** How many agents answered — the totals are the sum over exactly these. */
  agentsScraped: number
  agentsTotal: number
  version?: string
  /** Events exported since the agent started, cluster-wide. */
  eventsTotal: number
  byType: Array<{ name: string; count: number }>
  byNamespace: Array<{ name: string; count: number }>
  byWorkload: Array<{ name: string; count: number }>
  /** Probes the kernel dropped — a real signal that the feed is incomplete. */
  missed: number
  errors: number
}

/**
 * Tetragon's counters, scraped from every agent and added up.
 *
 * Each agent counts only its own node, so a cluster total is the sum over all
 * of them. Going through the *service* instead returns whichever pod the
 * apiserver's load balancer picked, which made the figure jump by a factor of
 * two between one render and the next — a number that changes when nothing
 * happened is worse than no number.
 *
 * Needs `get` on `pods/proxy` in the agent's namespace. A viewer without it
 * gets an error here and a page that is otherwise complete, which is why
 * nothing on the page depends on this resolving.
 */
export function useTetragonMetrics(agent?: EngineStatus, enabled = true) {
  const namespace = agent?.namespace
  const pods = (agent?.pods ?? []).filter((p) => p.ready).map((p) => p.name)
  return useQuery({
    queryKey: ['deliver', 'runtime', 'tetragon-metrics', namespace ?? '-', pods.join(',')],
    enabled: Boolean(namespace) && pods.length > 0 && enabled,
    refetchInterval: AGENTS_REFRESH_MS,
    retry: false,
    queryFn: async (): Promise<TetragonMetrics> => {
      const scrapes = await Promise.allSettled(
        pods.map(async (pod) => {
          const res = await fetch(
            `/api/k8s/api/v1/namespaces/${encodeURIComponent(namespace!)}/pods/${
              encodeURIComponent(pod)
            }:2112/proxy/metrics`,
            { credentials: 'include', headers: { accept: 'text/plain' } },
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return parsePrometheusText(await res.text())
        }),
      )
      const ok = scrapes.filter((r) => r.status === 'fulfilled')
      // One agent answering is a usable cluster picture; none answering is not.
      if (ok.length === 0) {
        const why = scrapes[0]?.status === 'rejected' ? String(scrapes[0].reason) : 'no agents'
        throw new Error(`no agent returned metrics (${why})`)
      }
      const samples = ok.flatMap((r) => (r as PromiseFulfilledResult<Sample[]>).value)
      return {
        agentsScraped: ok.length,
        agentsTotal: pods.length,
        samples,
        version: series(samples, 'tetragon_build_info')[0]?.labels.version,
        eventsTotal: total(samples, 'tetragon_events_total'),
        byType: groupBy(samples, 'tetragon_events_total', 'type'),
        byNamespace: groupBy(samples, 'tetragon_events_total', 'namespace'),
        byWorkload: groupBy(samples, 'tetragon_events_total', 'workload'),
        missed: total(samples, 'tetragon_missed_link_probes_total') +
          total(samples, 'tetragon_missed_prog_probes_total'),
        errors: total(samples, 'tetragon_errors_total'),
      }
    },
  })
}
