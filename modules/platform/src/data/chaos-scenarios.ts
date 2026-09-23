import { CHAOS_NAMESPACE, faultById, type TargetMode } from './chaos-kinds.ts'
import { engineManifest, LABEL_GAMEDAY, type SteadyStateProbe } from './chaos.ts'

/**
 * The scenario library, and the builder that turns scenarios into a game day.
 *
 * ---------------------------------------------------------------------------
 * WHY A LIBRARY RATHER THAN A FORM
 * ---------------------------------------------------------------------------
 * A blank chaos form asks the wrong question. "Which fault do you want?"
 * assumes you already know the failure modes worth rehearsing, and in practice
 * people run pod-delete a few times and stop — so the interesting failures,
 * the ones that actually take production down, are the ones never tried: a
 * dependency that answers slowly instead of failing, DNS returning the wrong
 * answer, a node that goes away, memory that runs out.
 *
 * So the catalogue is the product. Each entry states a HYPOTHESIS — what
 * should happen — because an experiment without one is just breakage. The
 * verdict is whether the hypothesis held, not whether the fault was injected;
 * with Litmus that is literal, because the hypothesis becomes a probe the
 * runner evaluates throughout the fault.
 *
 * ---------------------------------------------------------------------------
 * AUTOMATION
 * ---------------------------------------------------------------------------
 * A game day is an Argo Workflow: one `ChaosEngine` per scenario, run in
 * series with recovery pauses, each step waiting for its verdict
 * (`litmus-checker`) and the whole run stopping at the first failed
 * hypothesis. Serial-with-recovery is the default because simultaneous faults
 * tell you something broke without telling you which one did it.
 *
 * This module is pure — it builds manifests and never talks to a cluster —
 * because the manifests are the part that must be exactly right.
 */

export type ScenarioCategory =
  | 'availability'
  | 'network'
  | 'resource'
  | 'storage'
  | 'dependency'
  | 'node'

export interface Scenario {
  id: string
  title: string
  category: ScenarioCategory
  /** The Litmus fault (ChaosExperiment name) this scenario runs. */
  fault: string
  /** How much of a real outage this resembles. */
  blast: 'low' | 'medium' | 'high'
  /** What SHOULD happen. The experiment tests this, not the injection. */
  hypothesis: string
  /** Why it is worth rehearsing — the failure it is a proxy for. */
  rationale: string
  /** Seconds the fault runs; every scenario is bounded. */
  seconds: number
  /**
   * Fault knobs, minus the target, which the launcher supplies so one scenario
   * can be pointed at any workload.
   */
  env: Record<string, string>
}

/**
 * The catalogue.
 *
 * Ordered by blast radius within each category so the obvious starting point
 * is the first one you see. Everything here is bounded and reversible.
 */
export const SCENARIOS: Scenario[] = [
  /* ── availability ── */
  {
    id: 'pod-delete-one',
    title: 'One replica is deleted',
    category: 'availability',
    fault: 'pod-delete',
    blast: 'low',
    hypothesis: 'The pod is rescheduled and ready within its normal startup time; no request fails.',
    rationale:
      'The single most common real failure. If this hurts, nothing else in this list matters yet.',
    seconds: 60,
    env: { CHAOS_INTERVAL: '20', FORCE: 'false' },
  },
  {
    id: 'container-kill',
    title: 'A container is killed inside a running pod',
    category: 'availability',
    fault: 'container-kill',
    blast: 'medium',
    hypothesis: 'The container restarts in place and the readiness probe removes it from the service until it is back.',
    rationale:
      'Finds pods that keep receiving traffic while a sidecar or main container is restarting — a readiness probe that only checks the process, not the dependency.',
    seconds: 30,
    env: { CHAOS_INTERVAL: '10' },
  },
  {
    id: 'pod-delete-majority',
    title: 'Most replicas are deleted at once',
    category: 'availability',
    fault: 'pod-delete',
    blast: 'high',
    hypothesis: 'The remaining replica absorbs the load, or the disruption budget refuses the deletion.',
    rationale:
      'What a bad node drain or a zone failure looks like. Tests the PodDisruptionBudget and whether one replica can actually carry the service.',
    seconds: 60,
    env: { CHAOS_INTERVAL: '60', FORCE: 'true', PODS_AFFECTED_PERC: '67' },
  },
  /* ── network ── */
  {
    id: 'net-latency',
    title: 'The network gets slow',
    category: 'network',
    fault: 'pod-network-latency',
    blast: 'low',
    hypothesis: 'Latency rises but requests complete; timeouts are longer than the added delay and nothing retries into a storm.',
    rationale:
      'Slow is worse than down: a dead dependency fails fast, a slow one ties up every worker until the pool is exhausted.',
    seconds: 120,
    env: { NETWORK_LATENCY: '200', JITTER: '50' },
  },
  {
    id: 'net-loss',
    title: 'Packets are dropped',
    category: 'network',
    fault: 'pod-network-loss',
    blast: 'medium',
    hypothesis: 'TCP retransmits; throughput drops but the error rate stays at zero.',
    rationale: 'Lossy links between zones and flapping NICs both look exactly like this.',
    seconds: 120,
    env: { NETWORK_PACKET_LOSS_PERCENTAGE: '10' },
  },
  {
    id: 'net-partition',
    title: 'The network is partitioned',
    category: 'network',
    fault: 'pod-network-partition',
    blast: 'high',
    hypothesis: 'The targets are unreachable; callers fail fast with a clear error and recover the moment the partition lifts.',
    rationale:
      'The split-brain rehearsal. Clients that hang instead of failing, and leaders that keep leading without quorum, both show up here.',
    seconds: 60,
    env: { POLICY_TYPES: 'all' },
  },
  {
    id: 'net-corrupt',
    title: 'Packets are corrupted',
    category: 'network',
    fault: 'pod-network-corruption',
    blast: 'medium',
    hypothesis: 'Checksums catch the corruption and TCP retransmits; nothing above the transport notices.',
    rationale: 'Faulty hardware exists. It tends to show up as inexplicable protocol errors from one host.',
    seconds: 90,
    env: { NETWORK_PACKET_CORRUPTION_PERCENTAGE: '5' },
  },
  /* ── resource ── */
  {
    id: 'cpu-stress',
    title: 'CPU is contended',
    category: 'resource',
    fault: 'pod-cpu-hog',
    blast: 'low',
    hypothesis: 'Latency degrades gracefully; CPU limits keep the noise from spilling onto neighbours.',
    rationale: 'A noisy neighbour, a runaway job, or the autoscaler catching up late all look like this.',
    seconds: 120,
    env: { CPU_CORES: '1' },
  },
  {
    id: 'memory-stress',
    title: 'Memory is consumed',
    category: 'resource',
    fault: 'pod-memory-hog',
    blast: 'medium',
    hypothesis: 'The pod is OOM-killed and restarted cleanly rather than swapping or taking the node down.',
    rationale:
      'The most common cause of a pod dying in production, and the one whose limits are most often set by guessing.',
    seconds: 90,
    env: { MEMORY_CONSUMPTION: '256' },
  },
  /* ── storage ── */
  {
    id: 'io-stress',
    title: 'Disk I/O is saturated',
    category: 'storage',
    fault: 'pod-io-stress',
    blast: 'medium',
    hypothesis: 'The service stays within its latency budget; a slow volume does not block the request path.',
    rationale: 'Throttled cloud volumes and a neighbour compacting a database both slow the disk without failing it.',
    seconds: 120,
    env: { FILESYSTEM_UTILIZATION_PERCENTAGE: '10' },
  },
  {
    id: 'disk-fill',
    title: 'The disk fills up',
    category: 'storage',
    fault: 'disk-fill',
    blast: 'medium',
    hypothesis: 'Writes fail with a clear error; the service keeps serving reads and recovers when space returns.',
    rationale: 'Logs and caches grow until they don’t. Finds services that die instead of degrading when a write fails.',
    seconds: 90,
    env: { FILL_PERCENTAGE: '80' },
  },
  /* ── dependency ── */
  {
    id: 'dns-error',
    title: 'DNS stops resolving',
    category: 'dependency',
    fault: 'pod-dns-error',
    blast: 'medium',
    hypothesis: 'Established connections keep working; new ones fail fast and recover as soon as resolution returns.',
    rationale:
      'CoreDNS restarting, a search-path change, an upstream outage — every service depends on DNS and almost none of them test it.',
    seconds: 60,
    env: {},
  },
  {
    id: 'dns-spoof',
    title: 'DNS returns the wrong address',
    category: 'dependency',
    fault: 'pod-dns-spoof',
    blast: 'high',
    hypothesis: 'Connections to the wrong host fail TLS verification and are refused rather than trusted.',
    rationale: 'A poisoned cache or a stale record. If your clients accept whatever DNS says, this is how you find out.',
    seconds: 60,
    env: { SPOOF_MAP: '{"example.invalid":"127.0.0.1"}' },
  },
  {
    id: 'http-status',
    title: 'HTTP responses become errors',
    category: 'dependency',
    fault: 'pod-http-status-code',
    blast: 'medium',
    hypothesis: 'Callers see a 500 and either retry with backoff or fail cleanly; no one treats the error as an empty result.',
    rationale: 'Half the dependency handling in a codebase is only ever exercised in production. Exercise it here.',
    seconds: 60,
    env: { STATUS_CODE: '500', TARGET_SERVICE_PORT: '8080' },
  },
  {
    id: 'http-delay',
    title: 'HTTP responses are delayed',
    category: 'dependency',
    fault: 'pod-http-latency',
    blast: 'low',
    hypothesis: 'Callers time out at their configured deadline, not at the dependency’s, and shed load rather than queue it.',
    rationale:
      'The other half: a dependency that answers eventually. This is where missing client timeouts turn one slow service into a slow platform.',
    seconds: 90,
    env: { LATENCY: '3000', TARGET_SERVICE_PORT: '8080' },
  },
  /* ── node ── */
  {
    id: 'node-drain',
    title: 'A node is drained',
    category: 'node',
    fault: 'node-drain',
    blast: 'high',
    hypothesis: 'Every pod on the node reschedules; disruption budgets pace the eviction and the service never loses all replicas.',
    rationale: 'Every upgrade, every autoscaler scale-down. The rehearsal for the maintenance that is going to happen anyway.',
    seconds: 90,
    env: {},
  },
]

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}

export const CATEGORY_LABEL: Record<ScenarioCategory, string> = {
  availability: 'Availability',
  network: 'Network',
  resource: 'Resource contention',
  storage: 'Storage',
  dependency: 'Dependencies',
  node: 'Nodes',
}

export const CATEGORY_BLURB: Record<ScenarioCategory, string> = {
  availability: 'Replicas and containers going away.',
  network: 'The wire being slow, lossy or split.',
  resource: 'Competing for CPU and memory.',
  storage: 'Disks that are slow, or full.',
  dependency: 'What you call, misbehaving.',
  node: 'Whole machines going away.',
}

/* ─────────────────────────── target ─────────────────────────── */

export interface ChaosTarget {
  namespace: string
  /** `app=checkout` — empty means every pod in the namespace. */
  label: string
  appKind?: 'deployment' | 'statefulset' | 'daemonset' | 'rollout'
  mode: TargetMode
  percent?: string
  /** For node scenarios. */
  node?: string
}

/* ─────────────────────────── workflow ─────────────────────────── */

export interface GameDayInput {
  name: string
  target: ChaosTarget
  /** Scenario ids, in the order they should run. */
  scenarios: string[]
  /** Serial runs one fault at a time; parallel runs them together. */
  strategy: 'serial' | 'parallel'
  /** Quiet time between scenarios for the system to recover. */
  recoverySeconds: number
  /** Optional probe that fails a scenario when the system stops being healthy. */
  steadyState?: SteadyStateProbe
}

export const LABEL_SCENARIO = 'adhar.io/chaos-scenario'

/** The step images. Pinned to the platform's Litmus release. */
export const CHECKER_IMAGE = 'litmuschaos.docker.scarf.sh/litmuschaos/litmus-checker:3.31.0'
export const KUBECTL_IMAGE = 'litmuschaos.docker.scarf.sh/litmuschaos/k8s:3.31.0'
export const GAMEDAY_SERVICE_ACCOUNT = 'adhar-chaos-gameday'

/**
 * Build the Argo `Workflow` for a game day.
 *
 * Serial by default, with a pause between each fault. That ordering is the
 * whole value: running everything at once tells you the system broke without
 * telling you which fault did it, and leaves nothing recovered to compare
 * against. The pauses are where recovery is observed.
 *
 * Each scenario step hands `litmus-checker` a ChaosEngine manifest; the
 * checker creates it and blocks until the ChaosResult is written, exiting
 * non-zero on a failed verdict — so a failed hypothesis stops the run, and a
 * steady-state probe (a Litmus `httpProbe` on every engine) is what produces
 * that verdict. A final `revert` step, run whatever happened, stops and
 * deletes the engines the game day created, so a fault never outlives it.
 */
export function buildGameDay(input: GameDayInput): Record<string, unknown> {
  const chosen = input.scenarios.map(scenarioById).filter((s): s is Scenario => Boolean(s))
  if (!chosen.length) throw new Error('A game day needs at least one scenario.')
  for (const s of chosen) {
    if (!faultById(s.fault)) throw new Error(`scenario ${s.id} names an unknown fault ${s.fault}`)
  }

  const templates: Array<Record<string, unknown>> = []
  const steps: Array<Array<{ name: string; template: string }>> = []
  const engineNames: string[] = []

  chosen.forEach((scenario, i) => {
    const stepName = `${i + 1}-${scenario.id}`
    const engineName = `${input.name}-${i + 1}-${scenario.fault}`.slice(0, 63).replace(/-+$/, '')
    engineNames.push(engineName)
    const engine = engineManifest({
      fault: scenario.fault,
      name: engineName,
      targetNamespace: input.target.namespace,
      label: input.target.label || undefined,
      appKind: input.target.appKind,
      mode: input.target.mode,
      percent: input.target.percent,
      node: input.target.node,
      env: { ...scenario.env, TOTAL_CHAOS_DURATION: String(scenario.seconds) },
      steadyState: input.steadyState,
    })
    engine.metadata.labels = {
      ...engine.metadata.labels,
      [LABEL_GAMEDAY]: input.name,
      [LABEL_SCENARIO]: scenario.id,
    }
    templates.push({
      name: stepName,
      inputs: {
        artifacts: [{
          name: 'engine',
          path: `/tmp/${engineName}.yaml`,
          raw: { data: JSON.stringify(engine) },
        }],
      },
      container: {
        image: CHECKER_IMAGE,
        args: [`-file=/tmp/${engineName}.yaml`, `-saveName=/tmp/${engineName}-name`],
      },
    })
    const step = { name: stepName, template: stepName }

    if (input.strategy === 'parallel') {
      // One parallel group holding every scenario.
      if (steps.length === 0) steps.push([])
      steps[0].push(step)
      return
    }
    steps.push([step])
    // Recovery pauses only make sense between faults, and only in serial —
    // in parallel everything overlaps and a pause would delay nothing.
    const isLast = i === chosen.length - 1
    if (!isLast && input.recoverySeconds > 0) {
      const pause = `${i + 1}-recover`
      templates.push({ name: pause, suspend: { duration: `${input.recoverySeconds}s` } })
      steps.push([{ name: pause, template: pause }])
    }
  })

  // Runs whatever happened: a failed hypothesis must not leave its fault
  // applied, and a stopped engine is what lets the runner recover the target.
  templates.push({
    name: 'revert',
    container: {
      image: KUBECTL_IMAGE,
      command: ['sh', '-c'],
      args: [
        [
          `set -e`,
          `for e in ${engineNames.join(' ')}; do`,
          `  kubectl -n ${CHAOS_NAMESPACE} patch chaosengine "$e" --type merge -p '{"spec":{"engineState":"stop"}}' 2>/dev/null || true`,
          `done`,
          `sleep 15`,
          `for e in ${engineNames.join(' ')}; do`,
          `  kubectl -n ${CHAOS_NAMESPACE} delete chaosengine "$e" --ignore-not-found`,
          `done`,
          `echo "reverted ${engineNames.length} engine(s)"`,
        ].join('\n'),
      ],
    },
  })

  templates.push({
    name: 'game-day',
    steps,
  })

  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
      name: input.name,
      namespace: CHAOS_NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'adhar-console',
        [LABEL_GAMEDAY]: input.name,
        'adhar.io/chaos-target': input.target.namespace,
      },
      annotations: {
        'adhar.io/chaos-scenarios': chosen.map((s) => s.id).join(','),
        'adhar.io/chaos-strategy': input.strategy,
      },
    },
    spec: {
      entrypoint: 'game-day',
      serviceAccountName: GAMEDAY_SERVICE_ACCOUNT,
      // Exit handler: Argo runs it after the entrypoint, success or failure.
      onExit: 'revert',
      // The run must not outlive its own budget by much.
      activeDeadlineSeconds: totalSeconds(chosen, input) + 15 * 60,
      // Nothing to tidy: the engines are deleted by revert, and finished
      // workflows are the game-day history.
      podGC: { strategy: 'OnWorkflowSuccess' },
      templates,
    },
  }
}

/** Wall-clock seconds the fault sequence will take. */
export function totalSeconds(scenarios: Scenario[], input: Pick<GameDayInput, 'strategy' | 'recoverySeconds'>): number {
  const durations = scenarios.map((s) => s.seconds)
  if (input.strategy === 'parallel') return Math.max(0, ...durations)
  const faults = durations.reduce((a, b) => a + b, 0)
  const pauses = Math.max(0, scenarios.length - 1) * input.recoverySeconds
  return faults + pauses
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${Math.round(total)}s`
  const m = Math.floor(total / 60)
  const s = Math.round(total % 60)
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
