/**
 * The LitmusChaos fault catalogue, and the rules for reading a run's state.
 *
 * Kept free of React so the status logic can be tested directly. That logic is
 * worth testing because it is the difference between a page that tells you a
 * fault is currently applied to production and one that quietly says
 * "Running" while nothing is injected.
 *
 * Litmus's model, in three objects:
 *   • `ChaosExperiment` — a fault DEFINITION the platform installs (pod-delete,
 *     pod-network-latency, …): the runner image, its env knobs and defaults,
 *     the RBAC it needs. Twenty-nine ship with the litmus package.
 *   • `ChaosEngine` — a RUN: which experiment, against which app, with which
 *     knobs and probes. Creating one starts the chaos; `engineState: stop`
 *     ends it and lets the runner recover the target.
 *   • `ChaosResult` — the VERDICT of a run (`Pass` / `Fail`), its probe
 *     outcomes and history. Named `<engine>-<experiment>`.
 */

export const LITMUS_GROUP = 'litmuschaos.io'
export const LITMUS_VERSION = 'v1alpha1'

export const ENGINES_GVR = { group: LITMUS_GROUP, version: LITMUS_VERSION, resource: 'chaosengines', namespaced: true }
export const EXPERIMENTS_GVR = { group: LITMUS_GROUP, version: LITMUS_VERSION, resource: 'chaosexperiments', namespaced: true }
export const RESULTS_GVR = { group: LITMUS_GROUP, version: LITMUS_VERSION, resource: 'chaosresults', namespaced: true }

/**
 * Where engines are created and where the operator, the fault definitions and
 * the `chaosServiceAccount` live. A run created here can target ANY namespace
 * through `appinfo.appns`; Litmus only requires the service account to be
 * beside the engine, and `k8s-chaos-admin` is bound cluster-wide.
 */
export const CHAOS_NAMESPACE = 'adhar-system'
export const CHAOS_SERVICE_ACCOUNT = 'k8s-chaos-admin'

/** Families the catalogue is grouped by, ordered least to most destructive. */
export type FaultFamily = 'pod' | 'stress' | 'network' | 'http' | 'dns' | 'io' | 'node'

export interface FaultKnob {
  /** Env var the runner reads, e.g. `NETWORK_LATENCY`. */
  env: string
  label: string
  /** Default the platform's definition ships; shown pre-filled. */
  value: string
  hint?: string
}

export interface ChaosFault {
  /** The ChaosExperiment name — `pod-delete`. */
  id: string
  family: FaultFamily
  label: string
  /** What it actually does to a running system, in one line. */
  blurb: string
  /**
   * How much of a production outage this fault resembles. Used to order the
   * catalogue and to decide which runs need a second confirmation — deleting
   * one pod is a Tuesday; draining a node is not.
   */
  blast: 'low' | 'medium' | 'high'
  /** Knobs worth exposing; every fault also takes TOTAL_CHAOS_DURATION. */
  knobs: FaultKnob[]
  /** Targets nodes rather than pods: `appinfo` is ignored, a node name is not. */
  node?: boolean
}

const dur = (value: string): FaultKnob => ({ env: 'TOTAL_CHAOS_DURATION', label: 'Duration (s)', value })

/**
 * Ordered least to most destructive within each family.
 *
 * `pod-delete` is first deliberately: it is the experiment people should
 * start with, because it is the one real clusters survive.
 */
export const CHAOS_FAULTS: ChaosFault[] = [
  /* ── pod ── */
  { id: 'pod-delete', family: 'pod', label: 'Pod delete', blast: 'low',
    blurb: 'Deletes target pods at an interval; the controller must replace them.',
    knobs: [dur('30'), { env: 'CHAOS_INTERVAL', label: 'Interval (s)', value: '10' }, { env: 'FORCE', label: 'Force', value: 'false', hint: 'true skips the grace period' }] },
  { id: 'container-kill', family: 'pod', label: 'Container kill', blast: 'medium',
    blurb: 'Kills a container inside a running pod; the pod itself stays.',
    knobs: [dur('30'), { env: 'CHAOS_INTERVAL', label: 'Interval (s)', value: '10' }, { env: 'TARGET_CONTAINER', label: 'Container', value: '', hint: 'empty = first container' }] },
  { id: 'pod-autoscaler', family: 'pod', label: 'Scale up', blast: 'medium',
    blurb: 'Scales the deployment up and checks it comes back to its replica count.',
    knobs: [dur('60'), { env: 'REPLICA_COUNT', label: 'Replicas', value: '5' }] },
  /* ── stress ── */
  { id: 'pod-cpu-hog', family: 'stress', label: 'CPU hog', blast: 'low',
    blurb: 'Burns CPU inside the target pods.',
    knobs: [dur('60'), { env: 'CPU_CORES', label: 'Cores', value: '1' }] },
  { id: 'pod-memory-hog', family: 'stress', label: 'Memory hog', blast: 'low',
    blurb: 'Fills memory inside the target pods towards their limit.',
    knobs: [dur('60'), { env: 'MEMORY_CONSUMPTION', label: 'MB', value: '500' }] },
  { id: 'pod-io-stress', family: 'stress', label: 'I/O stress', blast: 'medium',
    blurb: 'Saturates disk I/O from inside the target pods.',
    knobs: [dur('60'), { env: 'FILESYSTEM_UTILIZATION_PERCENTAGE', label: 'Filesystem %', value: '10' }] },
  /* ── network ── */
  { id: 'pod-network-latency', family: 'network', label: 'Latency', blast: 'low',
    blurb: 'Adds delay to every packet the target pods send.',
    knobs: [dur('60'), { env: 'NETWORK_LATENCY', label: 'Latency (ms)', value: '2000' }, { env: 'JITTER', label: 'Jitter (ms)', value: '0' }] },
  { id: 'pod-network-loss', family: 'network', label: 'Packet loss', blast: 'medium',
    blurb: 'Drops a percentage of the target pods’ packets.',
    knobs: [dur('60'), { env: 'NETWORK_PACKET_LOSS_PERCENTAGE', label: 'Loss %', value: '100' }] },
  { id: 'pod-network-corruption', family: 'network', label: 'Corruption', blast: 'medium',
    blurb: 'Corrupts a percentage of packets in flight.',
    knobs: [dur('60'), { env: 'NETWORK_PACKET_CORRUPTION_PERCENTAGE', label: 'Corrupt %', value: '100' }] },
  { id: 'pod-network-duplication', family: 'network', label: 'Duplication', blast: 'low',
    blurb: 'Duplicates a percentage of packets.',
    knobs: [dur('60'), { env: 'NETWORK_PACKET_DUPLICATION_PERCENTAGE', label: 'Duplicate %', value: '100' }] },
  { id: 'pod-network-partition', family: 'network', label: 'Partition', blast: 'high',
    blurb: 'Isolates the target pods with a NetworkPolicy — nothing in or out.',
    knobs: [dur('60'), { env: 'POLICY_TYPES', label: 'Direction', value: 'all', hint: 'all | ingress | egress' }] },
  /* ── http ── */
  { id: 'pod-http-latency', family: 'http', label: 'HTTP latency', blast: 'low',
    blurb: 'Proxies the pod’s HTTP port and delays every response.',
    knobs: [dur('60'), { env: 'TARGET_SERVICE_PORT', label: 'Port', value: '8080' }, { env: 'LATENCY', label: 'Latency (ms)', value: '2000' }] },
  { id: 'pod-http-status-code', family: 'http', label: 'HTTP status code', blast: 'medium',
    blurb: 'Rewrites responses to a status code of your choosing.',
    knobs: [dur('60'), { env: 'TARGET_SERVICE_PORT', label: 'Port', value: '8080' }, { env: 'STATUS_CODE', label: 'Status', value: '500' }] },
  { id: 'pod-http-reset-peer', family: 'http', label: 'HTTP reset', blast: 'medium',
    blurb: 'Resets connections after a delay — what a crashing upstream looks like.',
    knobs: [dur('60'), { env: 'TARGET_SERVICE_PORT', label: 'Port', value: '8080' }, { env: 'RESET_TIMEOUT', label: 'Reset after (ms)', value: '0' }] },
  { id: 'pod-http-modify-body', family: 'http', label: 'HTTP modify body', blast: 'medium',
    blurb: 'Replaces response bodies.',
    knobs: [dur('60'), { env: 'TARGET_SERVICE_PORT', label: 'Port', value: '8080' }, { env: 'RESPONSE_BODY', label: 'Body', value: '' }] },
  { id: 'pod-http-modify-header', family: 'http', label: 'HTTP modify header', blast: 'low',
    blurb: 'Adds or rewrites HTTP headers in flight.',
    knobs: [dur('60'), { env: 'TARGET_SERVICE_PORT', label: 'Port', value: '8080' }, { env: 'HEADERS_MAP', label: 'Headers (JSON)', value: '{}' }] },
  /* ── dns ── */
  { id: 'pod-dns-error', family: 'dns', label: 'DNS error', blast: 'medium',
    blurb: 'Makes name resolution fail for the target pods.',
    knobs: [dur('60'), { env: 'TARGET_HOSTNAMES', label: 'Hostnames', value: '', hint: 'empty = all' }] },
  { id: 'pod-dns-spoof', family: 'dns', label: 'DNS spoof', blast: 'high',
    blurb: 'Answers lookups with an address of your choosing.',
    knobs: [dur('60'), { env: 'SPOOF_MAP', label: 'Spoof map (JSON)', value: '{}' }] },
  /* ── io / disk ── */
  { id: 'disk-fill', family: 'io', label: 'Disk fill', blast: 'medium',
    blurb: 'Fills the pod’s ephemeral storage towards its limit.',
    knobs: [dur('60'), { env: 'FILL_PERCENTAGE', label: 'Fill %', value: '80' }] },
  /* ── node ── */
  { id: 'node-cpu-hog', family: 'node', label: 'Node CPU hog', blast: 'medium', node: true,
    blurb: 'Burns CPU on a whole node — every pod on it competes.',
    knobs: [dur('60'), { env: 'NODE_CPU_CORE', label: 'Cores', value: '1' }] },
  { id: 'node-memory-hog', family: 'node', label: 'Node memory hog', blast: 'high', node: true,
    blurb: 'Consumes node memory; the kubelet starts evicting.',
    knobs: [dur('60'), { env: 'MEMORY_CONSUMPTION_PERCENTAGE', label: 'Memory %', value: '30' }] },
  { id: 'node-io-stress', family: 'node', label: 'Node I/O stress', blast: 'medium', node: true,
    blurb: 'Saturates a node’s disk.',
    knobs: [dur('60'), { env: 'FILESYSTEM_UTILIZATION_PERCENTAGE', label: 'Filesystem %', value: '10' }] },
  { id: 'node-drain', family: 'node', label: 'Node drain', blast: 'high', node: true,
    blurb: 'Cordons and drains a node; everything on it must reschedule.',
    knobs: [dur('60')] },
  { id: 'node-taint', family: 'node', label: 'Node taint', blast: 'high', node: true,
    blurb: 'Taints a node NoExecute; pods without a toleration are evicted.',
    knobs: [dur('60'), { env: 'TAINTS', label: 'Taints', value: 'node.kubernetes.io/unreachable:NoExecute' }] },
  { id: 'kubelet-service-kill', family: 'node', label: 'Kubelet kill', blast: 'high', node: true,
    blurb: 'Stops the kubelet; the node goes NotReady.',
    knobs: [dur('60')] },
  { id: 'docker-service-kill', family: 'node', label: 'Container runtime kill', blast: 'high', node: true,
    blurb: 'Stops the container runtime on a node.',
    knobs: [dur('60')] },
  { id: 'disk-loss', family: 'node', label: 'Disk loss', blast: 'high', node: true,
    blurb: 'Detaches a cloud disk from a node.',
    knobs: [dur('60')] },
]

export const FAMILY_LABEL: Record<FaultFamily, string> = {
  pod: 'Pod', stress: 'Stress', network: 'Network', http: 'HTTP', dns: 'DNS', io: 'Storage', node: 'Node',
}

export function faultById(id: string): ChaosFault | undefined {
  return CHAOS_FAULTS.find((f) => f.id === id)
}

/* ─────────── objects ─────────── */

export interface ChaosProbe {
  name: string
  type: string
  mode?: string
  runProperties?: Record<string, unknown>
  [k: string]: unknown
}

export interface ChaosEngine {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: {
    engineState?: 'active' | 'stop'
    appinfo?: { appns?: string; applabel?: string; appkind?: string }
    chaosServiceAccount?: string
    jobCleanUpPolicy?: string
    experiments?: Array<{
      name: string
      spec?: {
        components?: { env?: Array<{ name: string; value: string }>; nodeSelector?: Record<string, string> }
        probe?: ChaosProbe[]
      }
    }>
    [k: string]: unknown
  }
  status?: {
    engineStatus?: string
    experiments?: Array<{
      name: string
      status?: string
      verdict?: string
      lastUpdateTime?: string
      experimentPod?: string
      runner?: string
    }>
  }
}

export interface ChaosResult {
  metadata: { name: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> }
  spec?: { engine?: string; experiment?: string }
  status?: {
    experimentStatus?: {
      phase?: string
      verdict?: string
      failStep?: string
      probeSuccessPercentage?: string
      errorOutput?: { reason?: string; errorCode?: string }
    }
    history?: {
      passedRuns?: number
      failedRuns?: number
      stoppedRuns?: number
      targets?: Array<{ name: string; kind: string; chaosStatus: string }>
    }
    probeStatuses?: Array<{ name: string; type: string; mode?: string; status?: { verdict?: string; description?: string } }>
  }
}

/** The ChaosResult a run writes: `<engine>-<experiment>`. */
export function resultNameFor(engine: ChaosEngine): string | undefined {
  const exp = engine.spec?.experiments?.[0]?.name
  return exp ? `${engine.metadata.name}-${exp}` : undefined
}

export function faultOf(engine: ChaosEngine): string {
  return engine.spec?.experiments?.[0]?.name ?? engine.metadata.labels?.['adhar.io/chaos-fault'] ?? 'unknown'
}

export function envOf(engine: ChaosEngine): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of engine.spec?.experiments?.[0]?.spec?.components?.env ?? []) out[e.name] = e.value
  return out
}

/* ─────────── status ─────────── */

/**
 * What a run is actually doing, right now.
 *
 * `injecting` is deliberately distinct from `injected`: an engine that is
 * active but whose runner has not started the fault yet (`Waiting for Job
 * Creation`, `initialized`) has broken nothing. Collapsing the two would make
 * the page claim a fault is live before it is — the single most misleading
 * thing a chaos console can do.
 */
export type ChaosPhase = 'injected' | 'injecting' | 'recovering' | 'stopped' | 'passed' | 'failed' | 'unknown'

const exp0 = (e: ChaosEngine) => e.status?.experiments?.[0]

/** Someone asked for this run to stop (or it was stopped). */
export function isStopRequested(e: ChaosEngine): boolean {
  return e.spec?.engineState === 'stop'
}

/** The runner reports the fault applied. */
export function isRunning(e: ChaosEngine): boolean {
  return (exp0(e)?.status ?? '').toLowerCase() === 'running' && (e.status?.engineStatus ?? '').toLowerCase() !== 'completed'
}

export function phaseOf(e: ChaosEngine): ChaosPhase {
  const engine = (e.status?.engineStatus ?? '').toLowerCase()
  const verdict = (exp0(e)?.verdict ?? '').toLowerCase()

  // Asked to stop but the runner still reports the fault applied: the fault is
  // live and the page must not imply otherwise. This is the reading that
  // matters during an incident.
  if (isRunning(e) && isStopRequested(e)) return 'recovering'
  if (isRunning(e)) return 'injected'
  // Past here nothing is applied, and the only question is why it stopped.
  if (engine === 'stopped' || (isStopRequested(e) && engine !== 'completed')) return 'stopped'
  if (engine === 'completed') {
    if (verdict === 'pass') return 'passed'
    if (verdict === 'fail' || verdict === 'error') return 'failed'
    if (verdict === 'stopped') return 'stopped'
    return 'unknown'
  }
  if (e.spec?.engineState === 'active') return 'injecting'
  return 'unknown'
}

/** True when a fault is currently applied to at least one target. */
export function isLive(e: ChaosEngine): boolean {
  const phase = phaseOf(e)
  return phase === 'injected' || phase === 'recovering'
}

/** How long the fault runs, from the engine's own knobs. */
export function durationOf(e: ChaosEngine): number | undefined {
  const v = envOf(e).TOTAL_CHAOS_DURATION
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Human summary of what the run is pointed at. */
export function targetSummary(e: ChaosEngine): string {
  const fault = faultById(faultOf(e))
  const env = envOf(e)
  if (fault?.node) {
    const nodes = env.TARGET_NODES || env.TARGET_NODE
    return nodes ? `node ${nodes}` : 'a node picked by the runner'
  }
  const app = e.spec?.appinfo
  const scope = app?.appns ?? 'unknown namespace'
  const label = app?.applabel ? app.applabel : 'every pod'
  const pct = env.PODS_AFFECTED_PERC
  const share = pct && pct !== '' ? `${pct}% of pods` : 'one pod'
  return [scope, label, share].join(' · ')
}

/** Litmus's `PODS_AFFECTED_PERC` from a mode the launcher understands. */
export type TargetMode = 'one' | 'all' | 'percent'

export function podsAffected(mode: TargetMode, percent?: string): string {
  switch (mode) {
    case 'all':
      return '100'
    case 'percent':
      return percent && percent.trim() ? percent.trim() : '50'
    default:
      return ''
  }
}

export function modeLabel(mode: TargetMode, percent?: string): string {
  switch (mode) {
    case 'one':
      return 'one pod'
    case 'all':
      return 'all pods'
    default:
      return `${percent ?? '50'}% of pods`
  }
}
