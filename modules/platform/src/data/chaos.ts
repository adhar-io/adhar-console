import { useQuery } from '@tanstack/react-query'
import { kube, type KubeObject } from '@adhar/api-clients/k8s'
import { clusterParam, useActiveCluster } from './client.ts'
import {
  CHAOS_FAULTS,
  CHAOS_NAMESPACE,
  CHAOS_SERVICE_ACCOUNT,
  ENGINES_GVR,
  EXPERIMENTS_GVR,
  LITMUS_GROUP,
  LITMUS_VERSION,
  RESULTS_GVR,
  faultById,
  isLive,
  phaseOf,
  podsAffected,
  type ChaosEngine,
  type ChaosFault,
  type ChaosProbe,
  type ChaosResult,
  type TargetMode,
} from './chaos-kinds.ts'

/**
 * LitmusChaos — deliberate failure, on purpose, with a way back.
 *
 * Litmus models a run as one polymorphic object (`ChaosEngine`) that names the
 * fault it runs, so "show me every experiment" is a single list call, and the
 * verdict of each run lands in a `ChaosResult` beside it. The catalogue of
 * faults that can be run is the set of `ChaosExperiment` definitions the
 * platform installed — read from the cluster, not assumed, so a definition
 * somebody removed is not offered.
 *
 * The important safety property is that a run is never deleted to stop it.
 * Litmus recovers the fault on the way out of a running engine (`engineState:
 * stop`), and deleting the object while the runner is mid-injection can leave
 * the fault applied — a NetworkPolicy partition, a tc qdisc — with nothing
 * left to undo it. Stopping goes through the engine state, which is the
 * operator's own supported path back.
 */

/**
 * Every read and write here goes to the cluster selected in the top bar —
 * the chaos objects of one cluster must never be shown (or stopped!) as if
 * they were another's. `cluster` is the gateway's `?cluster=` value
 * (undefined for the default cluster); the query keys carry the selection so
 * switching clusters never shows the previous cluster's cached runs.
 */
export function useChaosCluster(): { cluster: string | undefined; key: string } {
  const { cluster } = useActiveCluster()
  return { cluster: clusterParam(cluster), key: cluster }
}

export function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404
}

/** A 404 listing engines means Litmus's CRDs are not installed at all. */
export const isCrdMissing = isNotFound

/* ─────────── reads ─────────── */

const byNewest = (a: { metadata: { creationTimestamp?: string } }, b: { metadata: { creationTimestamp?: string } }) =>
  (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')

/**
 * Every chaos run on the cluster.
 *
 * `namespace` filters by the TARGET (`appinfo.appns`), not by where the engine
 * object lives: runs are created in the platform namespace beside the operator
 * (see `CHAOS_NAMESPACE`), and an operator looking at a team's namespace wants
 * the faults pointed at it, wherever the engine sits.
 */
export function useChaosEngines(namespace?: string) {
  const { cluster, key } = useChaosCluster()
  const query = useQuery({
    queryKey: ['chaos', 'engines', key] as const,
    queryFn: async (): Promise<ChaosEngine[]> => {
      const res = await kube.list<ChaosEngine>(ENGINES_GVR, { limit: 500, cluster })
      return (res.items ?? []).sort(byNewest)
    },
    retry: false,
    // A fault being applied is watched closely; a quiet cluster is not.
    refetchInterval: (q) => ((q.state.data ?? []).some((e) => isLive(e) || phaseOf(e) === 'injecting') ? 4_000 : 15_000),
  })
  const all = query.data ?? []
  const engines = namespace ? all.filter((e) => e.spec?.appinfo?.appns === namespace) : all
  return {
    engines,
    all,
    isLoading: query.isLoading,
    installed: !isNotFound(query.error),
    error: query.error && !isNotFound(query.error) ? query.error : undefined,
    refetch: () => void query.refetch(),
  }
}

/** One engine, polled quickly while it is not finished. A deleted engine reads as `gone`. */
export function useChaosEngine(namespace: string | undefined, name: string | null) {
  const { cluster, key } = useChaosCluster()
  const enabled = Boolean(namespace && name)
  const query = useQuery({
    queryKey: ['chaos', 'engine', key, namespace, name] as const,
    queryFn: () => kube.get<ChaosEngine>(ENGINES_GVR, namespace!, name!, { cluster }),
    enabled,
    retry: false,
    refetchInterval: (q) => {
      const e = q.state.data
      if (!e || q.state.error) return false
      const p = phaseOf(e)
      return p === 'passed' || p === 'failed' || p === 'stopped' ? 15_000 : 3_000
    },
  })
  return { ...query, gone: isNotFound(query.error) }
}

/** One ChaosResult (`<engine>-<fault>`), polled with its engine. Absent until the runner writes it. */
export function useChaosResult(namespace: string | undefined, name: string | undefined, live: boolean) {
  const { cluster, key } = useChaosCluster()
  return useQuery({
    queryKey: ['chaos', 'result', key, namespace, name] as const,
    queryFn: async () => {
      try {
        return await kube.get<ChaosResult>(RESULTS_GVR, namespace!, name!, { cluster })
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },
    enabled: Boolean(namespace && name),
    retry: false,
    refetchInterval: live ? 3_000 : false,
  })
}

/**
 * The fault definitions installed on the cluster, matched to the catalogue.
 *
 * Only faults with both a definition on the cluster AND an entry in
 * `CHAOS_FAULTS` are offered: the definition is what makes a run possible, the
 * catalogue entry is what makes it explainable.
 */
export function useInstalledFaults() {
  const { cluster, key } = useChaosCluster()
  const query = useQuery({
    queryKey: ['chaos', 'experiments', key, CHAOS_NAMESPACE] as const,
    queryFn: async () => {
      const res = await kube.list<{ metadata: { name: string } }>(EXPERIMENTS_GVR, { namespace: CHAOS_NAMESPACE, limit: 200, cluster })
      return new Set((res.items ?? []).map((i) => i.metadata.name))
    },
    retry: false,
    refetchInterval: 60_000,
  })
  const names = query.data ?? new Set<string>()
  const installed: ChaosFault[] = CHAOS_FAULTS.filter((f) => names.has(f.id))
  return { installed, definitions: names.size, isLoading: query.isLoading }
}

/** The verdicts of every run, keyed by ChaosResult name (`<engine>-<fault>`). */
export function useChaosResults(fast = false) {
  const { cluster, key } = useChaosCluster()
  const query = useQuery({
    queryKey: ['chaos', 'results', key] as const,
    queryFn: async () => {
      const res = await kube.list<ChaosResult>(RESULTS_GVR, { namespace: CHAOS_NAMESPACE, limit: 500, cluster })
      const out = new Map<string, ChaosResult>()
      for (const r of res.items ?? []) out.set(r.metadata.name, r)
      return out
    },
    retry: false,
    refetchInterval: fast ? 4_000 : 15_000,
  })
  return query.data ?? EMPTY_RESULTS
}

const EMPTY_RESULTS = new Map<string, ChaosResult>()

export interface TargetNamespace {
  name: string
  labels: Record<string, string>
}

/** Namespaces chaos may be pointed at (with their labels, for the production rail). */
export function useTargetNamespaces() {
  const { cluster, key } = useChaosCluster()
  return useQuery({
    queryKey: ['chaos', 'target-namespaces', key],
    queryFn: async (): Promise<TargetNamespace[]> => {
      const res = await kube.list<{ metadata: { name: string; labels?: Record<string, string> } }>(
        { group: '', version: 'v1', resource: 'namespaces', namespaced: false },
        { cluster },
      )
      return (res.items ?? []).map((n) => ({ name: n.metadata.name, labels: n.metadata.labels ?? {} })).sort((a, b) => a.name.localeCompare(b.name))
    },
    staleTime: 60_000,
    retry: false,
  })
}

/* ─────────── writes ─────────── */

/**
 * Stop a run.
 *
 * `engineState: stop` is Litmus's own halt: the runner ends the injection,
 * recovers the target, and the result records `Stopped`. Deleting the engine
 * instead would skip that recovery. There is no resume — a stopped run is
 * over, and running the fault again is a new run with its own verdict.
 */
export function stopChaosEngine(namespace: string, name: string, cluster?: string): Promise<unknown> {
  return kube.patch(ENGINES_GVR, namespace, name, { spec: { engineState: 'stop' } }, 'merge', { cluster })
}

/**
 * Delete a run and its result.
 *
 * Offered only for runs that are not currently injecting — the view gates on
 * that, and the reason is in `stopChaosEngine` above.
 */
export async function deleteChaosEngine(engine: ChaosEngine, cluster?: string): Promise<unknown> {
  if (isLive(engine)) throw new Error('Stop the run first — deleting it now could leave the fault applied')
  const ns = engine.metadata.namespace ?? CHAOS_NAMESPACE
  const fault = engine.spec?.experiments?.[0]?.name
  await kube.delete(ENGINES_GVR, ns, engine.metadata.name, { cluster })
  if (fault) {
    // Best effort: the result is history, not a lock.
    await kube.delete(RESULTS_GVR, ns, `${engine.metadata.name}-${fault}`, { cluster }).catch(() => undefined)
  }
  return undefined
}

/** Create an engine from a full manifest (a re-run). */
export function applyChaosEngine(manifest: ChaosEngine, cluster?: string): Promise<ChaosEngine> {
  return kube.apply<ChaosEngine>(manifest as unknown as KubeObject, { cluster })
}

export interface SteadyStateProbe {
  url: string
  /** Expected status code; anything else fails the run. */
  statusCode: number
  intervalSeconds: number
}

export interface NewChaosEngine {
  /** Fault id — a ChaosExperiment name. */
  fault: string
  name: string
  /** Namespace whose pods are targeted. */
  targetNamespace: string
  /** `app=checkout`. Litmus takes one label; empty means every pod. */
  label?: string
  appKind?: 'deployment' | 'statefulset' | 'daemonset' | 'rollout'
  mode: TargetMode
  percent?: string
  /** Env overrides for the fault's knobs (TOTAL_CHAOS_DURATION included). */
  env?: Record<string, string>
  /** For node faults: the node to hit. */
  node?: string
  /**
   * The hypothesis, as a probe. Litmus runs it continuously through the fault
   * and fails the verdict when it stops holding — which is what turns
   * "I broke it" into "the system survived" or "it did not".
   */
  steadyState?: SteadyStateProbe
}

/** The ChaosEngine manifest for a run. Pure, so the game-day builder can reuse it. */
export function engineManifest(input: NewChaosEngine): ChaosEngine {
  const fault = faultById(input.fault)
  if (!fault) throw new Error(`unknown chaos fault: ${input.fault}`)

  const env: Record<string, string> = {}
  for (const k of fault.knobs) if (k.value !== '') env[k.env] = k.value
  Object.assign(env, input.env ?? {})
  if (!fault.node) {
    const pct = podsAffected(input.mode, input.percent)
    if (pct) env.PODS_AFFECTED_PERC = pct
  } else if (input.node) {
    env.TARGET_NODES = input.node
  }

  const probes: ChaosProbe[] = input.steadyState
    ? [{
      name: 'steady-state',
      type: 'httpProbe',
      mode: 'Continuous',
      runProperties: {
        probeTimeout: '5s',
        interval: `${input.steadyState.intervalSeconds}s`,
        retry: 1,
        // A single failed poll fails the run: the hypothesis is "keeps
        // serving", not "serves most of the time".
        stopOnFailure: true,
      },
      'httpProbe/inputs': {
        url: input.steadyState.url,
        insecureSkipVerify: true,
        method: { get: { criteria: '==', responseCode: String(input.steadyState.statusCode) } },
      },
    }]
    : []

  return {
    apiVersion: `${LITMUS_GROUP}/${LITMUS_VERSION}`,
    kind: 'ChaosEngine',
    metadata: {
      name: input.name,
      namespace: CHAOS_NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'adhar-console',
        'adhar.io/chaos-fault': input.fault,
        'adhar.io/chaos-target': input.targetNamespace,
      },
    },
    spec: {
      engineState: 'active',
      // Litmus's annotation gate exists for clusters where every workload must
      // opt in with a label; the platform gates in the console instead.
      annotationCheck: 'false',
      chaosServiceAccount: CHAOS_SERVICE_ACCOUNT,
      // Runner and experiment pods stay after the run so their logs are the
      // record of what happened; deleting the engine cleans them up.
      jobCleanUpPolicy: 'retain',
      ...(fault.node
        ? {}
        : {
          appinfo: {
            appns: input.targetNamespace,
            ...(input.label ? { applabel: input.label } : {}),
            appkind: input.appKind ?? 'deployment',
          },
        }),
      experiments: [{
        name: input.fault,
        spec: {
          components: { env: Object.entries(env).map(([name, value]) => ({ name, value })) },
          ...(probes.length ? { probe: probes } : {}),
        },
      }],
    },
  }
}

export function createChaosEngine(input: NewChaosEngine, cluster?: string): Promise<ChaosEngine> {
  return kube.apply<ChaosEngine>(engineManifest(input) as unknown as KubeObject, { cluster })
}

/* ─────────────────────────── game days ─────────────────────────── */

/**
 * A game day is an Argo `Workflow`. Argo Workflows is an OPTIONAL package on
 * this platform, so game days need it installed —
 * whose steps each create a ChaosEngine and wait for its ChaosResult, with
 * recovery pauses between them. This is the same shape Litmus's own Chaos
 * Center generates (`litmus-checker` per step), so a game day made here is
 * also readable there.
 *
 * Progress lives in `status.nodes`: one entry per step, with a phase and
 * timestamps. That is the real record; the workflow's own phase only says
 * whether the whole run is still going and how it ended.
 */
export const WORKFLOWS_GVR = { group: 'argoproj.io', version: 'v1alpha1', resource: 'workflows', namespaced: true }

export interface ChaosWorkflowNode {
  id: string
  name: string
  displayName?: string
  type?: string
  templateName?: string
  phase?: string
  message?: string
  startedAt?: string
  finishedAt?: string
  children?: string[]
}

export interface ChaosWorkflow {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: { entrypoint?: string; templates?: Array<Record<string, unknown>>; [k: string]: unknown }
  status?: {
    phase?: string
    message?: string
    startedAt?: string
    finishedAt?: string
    progress?: string
    nodes?: Record<string, ChaosWorkflowNode>
  }
}

export const LABEL_GAMEDAY = 'adhar.io/chaos-gameday'

const wfRunning = (w: ChaosWorkflow) => !w.status?.finishedAt && w.status?.phase !== 'Succeeded' && w.status?.phase !== 'Failed' && w.status?.phase !== 'Error'

export function useChaosWorkflows(namespace?: string) {
  const { cluster, key } = useChaosCluster()
  const query = useQuery({
    queryKey: ['chaos', 'workflows', key],
    queryFn: async () => {
      const res = await kube.list<ChaosWorkflow>(WORKFLOWS_GVR, {
        namespace: CHAOS_NAMESPACE,
        labelSelector: LABEL_GAMEDAY,
        limit: 200,
        cluster,
      })
      return (res.items ?? []).sort(byNewest)
    },
    refetchInterval: (q) => ((q.state.data ?? []).some(wfRunning) ? 5_000 : 20_000),
    retry: false,
  })
  const all = query.data ?? []
  return {
    ...query,
    data: namespace ? all.filter((w) => w.metadata.labels?.['adhar.io/chaos-target'] === namespace) : query.data,
    /** Argo Workflows' CRD is absent: game days need the optional package. */
    notInstalled: isNotFound(query.error),
  }
}

export function useChaosWorkflow(namespace: string | undefined, name: string | null) {
  const { cluster, key } = useChaosCluster()
  const enabled = Boolean(namespace && name)
  const query = useQuery({
    queryKey: ['chaos', 'workflow', key, namespace, name],
    queryFn: () => kube.get<ChaosWorkflow>(WORKFLOWS_GVR, namespace, name!, { cluster }),
    // A game day is minutes long and people watch it; poll fast while it runs.
    refetchInterval: (q) => (!enabled || q.state.error ? false : q.state.data && !wfRunning(q.state.data) ? 30_000 : 4_000),
    enabled,
    retry: false,
  })
  return { ...query, gone: isNotFound(query.error) }
}

/** The engines a game day created (labelled with its name), for the live target view. */
export function useGameDayEngines(name: string | null, live: boolean) {
  const { cluster, key } = useChaosCluster()
  return useQuery({
    queryKey: ['chaos', 'gameday-engines', key, name],
    queryFn: async () => (await kube.list<ChaosEngine>(ENGINES_GVR, { namespace: CHAOS_NAMESPACE, labelSelector: `${LABEL_GAMEDAY}=${name}`, cluster })).items ?? [],
    enabled: !!name,
    retry: false,
    refetchInterval: live ? 4_000 : false,
  })
}

export function createGameDay(manifest: Record<string, unknown>, cluster?: string): Promise<ChaosWorkflow> {
  return kube.apply<ChaosWorkflow>(manifest as unknown as KubeObject, { cluster })
}

/**
 * Abort a running game day. `spec.shutdown: Stop` is Argo's graceful stop: no
 * new step starts and the exit handler — the `revert` step that stops and
 * removes every engine the game day made — still runs. (`Terminate` would
 * skip it and could strand a fault.)
 */
export function stopGameDay(namespace: string, name: string, cluster?: string): Promise<unknown> {
  return kube.patch(WORKFLOWS_GVR, namespace, name, { spec: { shutdown: 'Stop' } }, 'merge', { cluster })
}

/**
 * Delete a game day. Its engines are its own children (the revert step deletes
 * them, and the workflow owns nothing else), so removing the workflow is safe
 * once it is no longer running — the view gates on that.
 */
export function deleteGameDay(namespace: string, name: string, cluster?: string): Promise<unknown> {
  return kube.delete(WORKFLOWS_GVR, namespace, name, { cluster })
}
