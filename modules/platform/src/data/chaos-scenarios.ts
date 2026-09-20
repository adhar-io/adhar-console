import { CHAOS_GROUP, CHAOS_VERSION, type ChaosKindId } from './chaos-kinds.ts'

/**
 * The scenario library, and the builder that turns scenarios into a Chaos
 * Mesh `Workflow`.
 *
 * ---------------------------------------------------------------------------
 * WHY A LIBRARY RATHER THAN A FORM
 * ---------------------------------------------------------------------------
 * A blank chaos form asks the wrong question. "Which fault do you want?"
 * assumes you already know the failure modes worth rehearsing, and in practice
 * people run pod-kill a few times and stop — so the interesting failures, the
 * ones that actually take production down, are the ones never tried: a
 * dependency that answers slowly instead of failing, DNS returning the wrong
 * answer, a disk that starts returning EIO, a clock that jumps.
 *
 * So the catalogue is the product. Each entry states a HYPOTHESIS — what
 * should happen — because an experiment without one is just breakage. The
 * verdict is whether the hypothesis held, not whether the fault was injected.
 *
 * ---------------------------------------------------------------------------
 * AUTOMATION
 * ---------------------------------------------------------------------------
 * Chaos Mesh's `Workflow` is a DAG of templates, so a game day is one object:
 * scenarios in series, each with a deadline, separated by recovery pauses, and
 * guarded by a `StatusCheck` that aborts the whole run when the system stops
 * being healthy. Serial-with-recovery is the default because simultaneous
 * faults tell you something broke without telling you which one did it.
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
  | 'time'

export interface Scenario {
  id: string
  title: string
  category: ScenarioCategory
  kind: ChaosKindId
  /** How much of a real outage this resembles. */
  blast: 'low' | 'medium' | 'high'
  /** What SHOULD happen. The experiment tests this, not the injection. */
  hypothesis: string
  /** Why it is worth rehearsing — the failure it is a proxy for. */
  rationale: string
  /** Default duration; every scenario is bounded. */
  duration: string
  /**
   * The chaos spec, minus selector and mode, which the launcher supplies so
   * one scenario can be pointed at any workload.
   */
  spec: Record<string, unknown>
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
    id: 'pod-failure-one',
    title: 'One replica becomes unavailable',
    category: 'availability',
    kind: 'pod',
    blast: 'low',
    hypothesis: 'Traffic continues on the remaining replicas; no request fails.',
    rationale:
      'The single most common real failure. If this hurts, nothing else in this list matters yet.',
    duration: '60s',
    spec: { action: 'pod-failure' },
  },
  {
    id: 'pod-kill-one',
    title: 'One pod is killed',
    category: 'availability',
    kind: 'pod',
    blast: 'low',
    hypothesis: 'The pod is rescheduled and ready within its normal startup time; no request fails.',
    rationale:
      'Distinct from unavailability: this exercises restart, readiness gates and whatever the pod does on boot.',
    duration: '30s',
    spec: { action: 'pod-kill' },
  },
  {
    id: 'container-kill',
    title: 'A container is killed inside a running pod',
    category: 'availability',
    kind: 'pod',
    blast: 'medium',
    hypothesis: 'The container restarts in place and the readiness probe removes it from the service until it is back.',
    rationale:
      'Finds pods that keep receiving traffic while a sidecar or main container is restarting — a readiness probe that only checks the process, not the dependency.',
    duration: '30s',
    spec: { action: 'container-kill' },
  },
  {
    id: 'pod-failure-majority',
    title: 'Most replicas become unavailable',
    category: 'availability',
    kind: 'pod',
    blast: 'high',
    hypothesis: 'The service degrades but stays up; the survivors are not overwhelmed by the redirected load.',
    rationale:
      'A node drain or zone loss looks like this. Usually the first place a too-small HPA floor shows up.',
    duration: '60s',
    spec: { action: 'pod-failure' },
  },

  /* ── network ── */
  {
    id: 'net-latency',
    title: 'The network gets slow',
    category: 'network',
    kind: 'network',
    blast: 'low',
    hypothesis: 'Callers absorb the added latency without their own timeouts firing or their queues growing without bound.',
    rationale:
      'Slow is harder than down. A dependency that answers in 2s instead of failing fast is what exhausts connection pools.',
    duration: '120s',
    spec: { action: 'delay', delay: { latency: '200ms', correlation: '50', jitter: '50ms' } },
  },
  {
    id: 'net-loss',
    title: 'Packets are dropped',
    category: 'network',
    kind: 'network',
    blast: 'medium',
    hypothesis: 'Retries absorb the loss; the error rate stays within the SLO.',
    rationale: 'Exercises retry and backoff. Also finds retries that amplify rather than absorb.',
    duration: '120s',
    spec: { action: 'loss', loss: { loss: '10', correlation: '25' } },
  },
  {
    id: 'net-partition',
    title: 'The network is partitioned',
    category: 'network',
    kind: 'network',
    blast: 'high',
    hypothesis: 'Each side detects the partition and degrades predictably; nothing corrupts state by assuming it is alone.',
    rationale:
      'The classic distributed-systems failure. Leader election, quorum and split-brain handling are only ever tested here.',
    duration: '90s',
    spec: { action: 'partition', direction: 'both' },
  },
  {
    id: 'net-bandwidth',
    title: 'Bandwidth is throttled',
    category: 'network',
    kind: 'network',
    blast: 'medium',
    hypothesis: 'Large responses take longer but nothing times out or truncates.',
    rationale: 'A noisy neighbour or a saturated uplink. Finds code that assumes bulk transfers are instant.',
    duration: '120s',
    spec: { action: 'bandwidth', bandwidth: { rate: '1mbps', limit: 20_971_520, buffer: 10_000 } },
  },
  {
    id: 'net-corrupt',
    title: 'Packets are corrupted',
    category: 'network',
    kind: 'network',
    blast: 'medium',
    hypothesis: 'Checksums reject the corrupt packets and the transport retransmits; the application never sees bad data.',
    rationale: 'Verifies that nothing is trusting the wire without validation.',
    duration: '60s',
    spec: { action: 'corrupt', corrupt: { corrupt: '5', correlation: '25' } },
  },

  /* ── resource ── */
  {
    id: 'cpu-stress',
    title: 'CPU is contended',
    category: 'resource',
    kind: 'stress',
    blast: 'low',
    hypothesis: 'Latency rises but stays inside the SLO; the autoscaler responds before the error budget is spent.',
    rationale:
      'A noisy neighbour on the same node. Also the cheapest way to find out whether your HPA thresholds are set anywhere useful.',
    duration: '120s',
    spec: { stressors: { cpu: { workers: 2, load: 80 } } },
  },
  {
    id: 'memory-stress',
    title: 'Memory is consumed',
    category: 'resource',
    kind: 'stress',
    blast: 'medium',
    hypothesis: 'The pod stays within its limit, or is OOMKilled and restarts cleanly without losing in-flight work.',
    rationale:
      'Finds limits set from guesswork, and the difference between a graceful shutdown and a SIGKILL half way through a request.',
    duration: '120s',
    spec: { stressors: { memory: { workers: 1, size: '256MB' } } },
  },

  /* ── storage ── */
  {
    id: 'io-latency',
    title: 'Disk reads and writes get slow',
    category: 'storage',
    kind: 'io',
    blast: 'medium',
    hypothesis: 'Requests that touch disk slow down without blocking requests that do not.',
    rationale: 'A degraded volume. Finds synchronous disk access on the hot path that nobody knew was there.',
    duration: '120s',
    spec: { action: 'latency', delay: '100ms', percent: 100, volumePath: '/data', path: '/data/**/*' },
  },
  {
    id: 'io-fault',
    title: 'Disk operations fail',
    category: 'storage',
    kind: 'io',
    blast: 'high',
    hypothesis: 'The I/O error is surfaced and handled; the process does not corrupt state or exit without explanation.',
    rationale:
      'A full or failing volume returns EIO. Most code has never been run down this path even once.',
    duration: '60s',
    spec: { action: 'fault', errno: 5, percent: 50, volumePath: '/data', path: '/data/**/*' },
  },

  /* ── dependency ── */
  {
    id: 'dns-error',
    title: 'DNS stops resolving',
    category: 'dependency',
    kind: 'dns',
    blast: 'medium',
    hypothesis: 'Name-resolution failures are retried and reported clearly, not mistaken for the dependency being down.',
    rationale:
      'CoreDNS trouble presents as every dependency failing at once. Finds clients that cache nothing and resolve per request.',
    duration: '60s',
    spec: { action: 'error', patterns: ['*'] },
  },
  {
    id: 'dns-random',
    title: 'DNS returns the wrong address',
    category: 'dependency',
    kind: 'dns',
    blast: 'high',
    hypothesis: 'Connections to the wrong address fail fast and are retried; nothing sends data to an unverified endpoint.',
    rationale: 'The nastier half of DNS failure: an answer that is wrong rather than absent.',
    duration: '60s',
    spec: { action: 'random', patterns: ['*'] },
  },
  {
    id: 'http-abort',
    title: 'HTTP requests are aborted',
    category: 'dependency',
    kind: 'http',
    blast: 'medium',
    hypothesis: 'The caller retries or fails gracefully; a dropped connection does not leave state half-written.',
    rationale: 'A dependency that resets the connection mid-response, which is not the same as returning a 500.',
    duration: '90s',
    spec: { target: 'Request', abort: true, port: 80 },
  },
  {
    id: 'http-delay',
    title: 'HTTP responses are delayed',
    category: 'dependency',
    kind: 'http',
    blast: 'medium',
    hypothesis: 'Client timeouts fire before the caller’s own deadline, and the circuit breaker opens.',
    rationale:
      'Tests timeout budgets end to end. Finds the service whose client timeout is longer than its own SLA.',
    duration: '90s',
    spec: { target: 'Request', delay: '3s', port: 80 },
  },

  /* ── time ── */
  {
    id: 'clock-skew',
    title: 'The clock jumps forward',
    category: 'time',
    kind: 'time',
    blast: 'medium',
    hypothesis: 'Tokens, caches and scheduled work behave sensibly; nothing assumes the clock only moves forward slowly.',
    rationale:
      'Finds expiry logic that breaks on a jump, and anything measuring elapsed time with a wall clock instead of a monotonic one.',
    duration: '60s',
    spec: { timeOffset: '+10m' },
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
  time: 'Time',
}

export const CATEGORY_BLURB: Record<ScenarioCategory, string> = {
  availability: 'Replicas and containers going away.',
  network: 'The wire being slow, lossy or split.',
  resource: 'Competing for CPU and memory.',
  storage: 'Volumes that are slow, or failing.',
  dependency: 'What you call, misbehaving.',
  time: 'Clocks that do not agree.',
}

/* ─────────────────────────── target ─────────────────────────── */

export interface ChaosTarget {
  namespace: string
  /** `app=checkout` — empty means every pod in the namespace. */
  selector: string
  mode: 'one' | 'all' | 'fixed' | 'fixed-percent' | 'random-max-percent'
  value?: string
}

/** Chaos Mesh's `selector` block for a target. */
export function selectorFor(target: ChaosTarget): Record<string, unknown> {
  const labelSelectors: Record<string, string> = {}
  for (const pair of target.selector.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    if (k && v) labelSelectors[k] = v
  }
  return {
    namespaces: [target.namespace],
    ...(Object.keys(labelSelectors).length ? { labelSelectors } : {}),
  }
}

/** The template key Chaos Mesh expects for a kind, e.g. `podChaos`. */
export const TEMPLATE_KEY: Record<ChaosKindId, string> = {
  pod: 'podChaos',
  network: 'networkChaos',
  stress: 'stressChaos',
  io: 'ioChaos',
  time: 'timeChaos',
  dns: 'dnsChaos',
  http: 'httpChaos',
  jvm: 'jvmChaos',
  block: 'blockChaos',
  kernel: 'kernelChaos',
}

/** The `templateType` Chaos Mesh expects, e.g. `PodChaos`. */
export const TEMPLATE_TYPE: Record<ChaosKindId, string> = {
  pod: 'PodChaos',
  network: 'NetworkChaos',
  stress: 'StressChaos',
  io: 'IOChaos',
  time: 'TimeChaos',
  dns: 'DNSChaos',
  http: 'HTTPChaos',
  jvm: 'JVMChaos',
  block: 'BlockChaos',
  kernel: 'KernelChaos',
}

/* ─────────────────────────── workflow ─────────────────────────── */

export interface SteadyState {
  /** URL probed throughout the run. */
  url: string
  /** Status code considered healthy, e.g. `200` or `2XX`. */
  statusCode: string
  intervalSeconds: number
  /** Consecutive failures before the run is abandoned. */
  failureThreshold: number
}

export interface GameDayInput {
  name: string
  namespace: string
  target: ChaosTarget
  /** Scenario ids, in the order they should run. */
  scenarios: string[]
  /** Serial runs one fault at a time; parallel runs them together. */
  strategy: 'serial' | 'parallel'
  /** Quiet time between scenarios for the system to recover. */
  recoverySeconds: number
  /** Optional probe that aborts the run when the system stops being healthy. */
  steadyState?: SteadyState
}

export const LABEL_GAMEDAY = 'adhar.io/chaos-gameday'
export const LABEL_SCENARIO = 'adhar.io/chaos-scenario'

/**
 * Build a Chaos Mesh `Workflow` from a list of scenarios.
 *
 * Serial by default, with a pause between each fault. That ordering is the
 * whole value: running everything at once tells you the system broke without
 * telling you which fault did it, and leaves nothing recovered to compare
 * against. The pauses are where recovery is observed.
 *
 * A steady-state probe becomes a `StatusCheck` template that runs alongside
 * the faults, and `abortWithStatusCheck` stops the run the moment the system
 * genuinely stops serving — which is the difference between an experiment and
 * an outage you caused.
 */
export function buildGameDay(input: GameDayInput): Record<string, unknown> {
  const chosen = input.scenarios.map(scenarioById).filter((s): s is Scenario => Boolean(s))
  if (!chosen.length) throw new Error('A game day needs at least one scenario.')

  const selector = selectorFor(input.target)
  const templates: Array<Record<string, unknown>> = []
  const children: string[] = []

  chosen.forEach((scenario, i) => {
    const stepName = `${i + 1}-${scenario.id}`
    templates.push({
      name: stepName,
      templateType: TEMPLATE_TYPE[scenario.kind],
      deadline: scenario.duration,
      [TEMPLATE_KEY[scenario.kind]]: {
        ...scenario.spec,
        mode: input.target.mode,
        ...(input.target.value ? { value: input.target.value } : {}),
        selector,
      },
    })
    children.push(stepName)

    // Recovery pauses only make sense between faults, and only in serial —
    // in parallel everything overlaps and a pause would delay nothing.
    const isLast = i === chosen.length - 1
    if (input.strategy === 'serial' && !isLast && input.recoverySeconds > 0) {
      const pause = `${i + 1}-recover`
      templates.push({ name: pause, templateType: 'Suspend', deadline: `${input.recoverySeconds}s` })
      children.push(pause)
    }
  })

  const entryName = 'entry'
  const entry: Record<string, unknown> = {
    name: entryName,
    templateType: input.strategy === 'serial' ? 'Serial' : 'Parallel',
    children,
  }

  if (input.steadyState) {
    const checkName = 'steady-state'
    templates.push({
      name: checkName,
      templateType: 'StatusCheck',
      // Outlives the faults so recovery is observed too.
      deadline: `${totalSeconds(chosen, input) + input.recoverySeconds}s`,
      statusCheck: {
        mode: 'Continuous',
        type: 'HTTP',
        intervalSeconds: input.steadyState.intervalSeconds,
        failureThreshold: input.steadyState.failureThreshold,
        http: {
          url: input.steadyState.url,
          method: 'GET',
          criteria: { statusCode: input.steadyState.statusCode },
        },
      },
    })
    // The probe runs BESIDE the faults, not before them, so the entry becomes
    // a parallel pair: the fault sequence and the watch over it.
    const faultsName = 'faults'
    templates.push({ ...entry, name: faultsName })
    templates.push({
      name: entryName,
      templateType: 'Parallel',
      children: [faultsName, checkName],
      abortWithStatusCheck: true,
    })
  } else {
    templates.push(entry)
  }

  return {
    apiVersion: `${CHAOS_GROUP}/${CHAOS_VERSION}`,
    kind: 'Workflow',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'adhar-console',
        [LABEL_GAMEDAY]: input.name,
      },
    },
    spec: { entry: entryName, templates },
  }
}

/** Wall-clock seconds the fault sequence will take. */
export function totalSeconds(scenarios: Scenario[], input: Pick<GameDayInput, 'strategy' | 'recoverySeconds'>): number {
  const durations = scenarios.map((s) => parseDuration(s.duration))
  if (input.strategy === 'parallel') return Math.max(0, ...durations)
  const faults = durations.reduce((a, b) => a + b, 0)
  const pauses = Math.max(0, scenarios.length - 1) * input.recoverySeconds
  return faults + pauses
}

/** `90s`, `2m`, `1h` → seconds. Unknown shapes are 0 rather than NaN. */
export function parseDuration(d: string): number {
  const m = d.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/)
  if (!m) return 0
  const n = Number(m[1])
  switch (m[2]) {
    case 'ms':
      return n / 1000
    case 's':
      return n
    case 'm':
      return n * 60
    case 'h':
      return n * 3600
    default:
      return 0
  }
}

export function formatSeconds(total: number): string {
  if (total < 60) return `${Math.round(total)}s`
  const m = Math.floor(total / 60)
  const s = Math.round(total % 60)
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
