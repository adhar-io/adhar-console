import { useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar-console/api-clients'
import { kube, type KubeObject } from '@adhar-console/api-clients/k8s'
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

const client = k8s.K8sClient.auto()

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
  const query = useQuery({
    queryKey: ['chaos', 'engines'] as const,
    queryFn: async (): Promise<ChaosEngine[]> => {
      const res = await kube.list<ChaosEngine>(ENGINES_GVR, { limit: 500 })
      return (res.items ?? []).sort(byNewest)
    },
    retry: false,
    refetchInterval: 10_000,
  })
  const all = query.data ?? []
  const engines = namespace ? all.filter((e) => e.spec?.appinfo?.appns === namespace) : all
  return {
    engines,
    isLoading: query.isLoading,
    installed: !isNotFound(query.error),
    error: query.error && !isNotFound(query.error) ? query.error : undefined,
    refetch: () => void query.refetch(),
  }
}

/**
 * The fault definitions installed on the cluster, matched to the catalogue.
 *
 * Only faults with both a definition on the cluster AND an entry in
 * `CHAOS_FAULTS` are offered: the definition is what makes a run possible, the
 * catalogue entry is what makes it explainable.
 */
export function useInstalledFaults() {
  const query = useQuery({
    queryKey: ['chaos', 'experiments', CHAOS_NAMESPACE] as const,
    queryFn: async () => {
      const res = await kube.list<{ metadata: { name: string } }>(EXPERIMENTS_GVR, { namespace: CHAOS_NAMESPACE, limit: 200 })
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
export function useChaosResults() {
  const query = useQuery({
    queryKey: ['chaos', 'results'] as const,
    queryFn: async () => {
      const res = await kube.list<ChaosResult>(RESULTS_GVR, { namespace: CHAOS_NAMESPACE, limit: 500 })
      const out = new Map<string, ChaosResult>()
      for (const r of res.items ?? []) out.set(r.metadata.name, r)
      return out
    },
    retry: false,
    refetchInterval: 10_000,
  })
  return query.data ?? new Map<string, ChaosResult>()
}

export function useTargetNamespaces() {
  return useQuery({
    queryKey: ['namespaces', 'chaos-targets'],
    queryFn: async () => (await client.listNamespaces()).map((n) => n.metadata.name).sort(),
    staleTime: 60_000,
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
export function stopChaosEngine(namespace: string, name: string): Promise<unknown> {
  return kube.patch(ENGINES_GVR, namespace, name, { spec: { engineState: 'stop' } }, 'merge')
}

/**
 * Delete a run and its result.
 *
 * Offered only for runs that are not currently injecting — the view gates on
 * that, and the reason is in `stopChaosEngine` above.
 */
export async function deleteChaosEngine(engine: ChaosEngine): Promise<unknown> {
  if (isLive(engine)) throw new Error('Stop the run first — deleting it now could leave the fault applied')
  const ns = engine.metadata.namespace ?? CHAOS_NAMESPACE
  const fault = engine.spec?.experiments?.[0]?.name
  await kube.delete(ENGINES_GVR, ns, engine.metadata.name)
  if (fault) {
    // Best effort: the result is history, not a lock.
    await kube.delete(RESULTS_GVR, ns, `${engine.metadata.name}-${fault}`).catch(() => undefined)
  }
  return undefined
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

export function createChaosEngine(input: NewChaosEngine): Promise<ChaosEngine> {
  return kube.apply<ChaosEngine>(engineManifest(input) as unknown as KubeObject)
}

/* ─────────────────────────── game days ─────────────────────────── */

/**
 * A game day is an Argo `Workflow` — the platform's argo-workflows package —
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

export function useChaosWorkflows(namespace?: string) {
  return useQuery({
    queryKey: ['chaos', 'workflows', namespace ?? 'all'],
    queryFn: async () => {
      const res = await kube.list<ChaosWorkflow>(WORKFLOWS_GVR, {
        namespace: CHAOS_NAMESPACE,
        labelSelector: LABEL_GAMEDAY,
        limit: 200,
      })
      const all = (res.items ?? []).sort(byNewest)
      return namespace ? all.filter((w) => w.metadata.labels?.['adhar.io/chaos-target'] === namespace) : all
    },
    refetchInterval: 10_000,
    retry: false,
  })
}

export function useChaosWorkflow(namespace: string | undefined, name: string | null) {
  const enabled = Boolean(namespace && name)
  return useQuery({
    queryKey: ['chaos', 'workflow', namespace, name],
    queryFn: () => kube.get<ChaosWorkflow>(WORKFLOWS_GVR, namespace, name!),
    // A game day is minutes long and people watch it; poll faster than the list.
    refetchInterval: enabled ? 5_000 : false,
    enabled,
    retry: false,
  })
}

export function createGameDay(manifest: Record<string, unknown>): Promise<ChaosWorkflow> {
  return kube.apply<ChaosWorkflow>(manifest as unknown as KubeObject)
}

/**
 * Delete a game day. Its engines are its own children (the revert step deletes
 * them, and the workflow owns nothing else), so removing the workflow is safe
 * once it is no longer running — the view gates on that.
 */
export function deleteGameDay(namespace: string, name: string): Promise<unknown> {
  return kube.delete(WORKFLOWS_GVR, namespace, name)
}
