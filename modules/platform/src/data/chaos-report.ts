/**
 * The Chaos Engineering run report: one self-contained document per
 * resilience run of one application, tagged with the commit that was tested.
 *
 * A run is what the platform's resilience runner did to one build in one
 * environment — hourly, as a promotion's verification, or from a click on this
 * page — and the console's recorder froze it as it landed (BFF
 * `resilience-reports.ts`). So "which chaos evidence do we have for the commit
 * we are promoting?" is a filter on this list, and every report can be handed
 * to a change record as HTML or PDF.
 *
 * Like the Performance Report it explains rather than lists: every experiment
 * says what was observed, what that means for the service and what to change,
 * and the recommendations are ranked. It adds no data of its own. A commit
 * that could not be resolved is shown as unknown, with why; a measurement the
 * runner did not take is shown as missing.
 *
 * Pure: no React, no DOM. The look is shared with the Performance Report
 * through `@adhar/utils`' report helpers.
 */

import {
  escapeHtml as esc,
  REPORT_CSS,
  REPORT_GRADE_COLOR,
  REPORT_PRIORITY_COLOR,
  REPORT_TONE_COLOR,
  reportPill as pill,
  reportRing as ring,
  reportTime,
  type ReportTone as Tone,
} from '@adhar/utils'
import { faultById } from './chaos-kinds.ts'

/* ─────────────────────────── wire model ─────────────────────────── */

/** Mirrors the BFF's `ChaosRunReport` (resilience-reports-model.ts). */
export type ReportTrigger = 'promotion' | 'console' | 'schedule' | 'unknown'

export interface ExperimentRecord {
  name: string
  status: string
  verdict?: string
  probeSuccessPercentage?: number
  recoverySeconds?: number
  durationSeconds?: number
  replicas?: number
  hypothesis?: string
  detail?: string
}

export interface PerformanceRecord {
  status: string
  p95Ms?: number
  p99Ms?: number
  errorRate?: number
  rps?: number
  thresholdP95Ms?: number
  thresholdErrorRate?: number
  detail?: string
}

export interface DesignCheck {
  name: string
  applicable: boolean
  score: number
  detail?: string
}

export interface ChaosRunReport {
  id: string
  app: string
  namespace: string
  environment: string
  project?: string
  image?: string
  commit?: string
  commitSource: 'image-tag' | 'kargo-freight' | 'unknown'
  commitNote?: string
  digest?: string
  freight?: { name: string; alias?: string; project?: string }
  repoUrl?: string
  trigger: ReportTrigger
  triggeredByUser?: string
  runId?: string
  startedAt?: string
  finishedAt: string
  target?: string
  experiments: ExperimentRecord[]
  performance?: PerformanceRecord
  gate?: { verdict: string; reasons: string[]; at?: string }
  checks?: DesignCheck[]
  checksEnvironment?: string
  recordedAt: string
}

/* ─────────────────────────── commits ─────────────────────────── */

export const shortSha = (sha: string | undefined): string => (sha ? sha.slice(0, 7) : '')

/** A pasted SHA (full or short, any case) → lowercase hex; undefined when it is not one (4–40 hex). */
export function shaQuery(q: string | null | undefined): string | undefined {
  const s = (q ?? '').trim().toLowerCase()
  return /^[0-9a-f]{4,40}$/.test(s) ? s : undefined
}

/** True when the report tested the commit `q` names (a prefix of the full SHA). */
export function matchesCommit(r: Pick<ChaosRunReport, 'commit'>, q: string): boolean {
  const s = shaQuery(q)
  return !!s && !!r.commit && r.commit.startsWith(s)
}

/** `http://gitea…/org/repo.git` + sha → the commit page (still in-cluster; the view makes it public). */
export function commitUrl(repoUrl: string | undefined, sha: string | undefined): string | undefined {
  if (!repoUrl || !sha || !/^https?:\/\//.test(repoUrl)) return undefined
  return `${repoUrl.replace(/\.git$/, '').replace(/\/+$/, '')}/commit/${sha}`
}

export const TRIGGER_LABEL: Record<ReportTrigger, string> = {
  promotion: 'Promotion (Kargo verification)',
  console: 'Manual (Chaos page)',
  schedule: 'Schedule (hourly runner)',
  unknown: 'Not recorded',
}

/* ─────────────────────────── verdict + grade ─────────────────────────── */

export type RunVerdict = 'survived' | 'failed' | 'inconclusive'

export const VERDICT_LABEL: Record<RunVerdict, string> = { survived: 'Survived', failed: 'Did not survive', inconclusive: 'Inconclusive' }
export const VERDICT_TONE: Record<RunVerdict, Tone> = { survived: 'good', failed: 'bad', inconclusive: 'warn' }

export function experimentTone(e: Pick<ExperimentRecord, 'status'>): Tone {
  return e.status === 'passed' ? 'good' : e.status === 'failed' ? 'bad' : e.status === 'error' ? 'warn' : 'none'
}

const STATUS_TEXT: Record<string, string> = {
  passed: 'Survived',
  failed: 'Failed',
  error: 'No verdict',
  unavailable: 'Not installed',
  'opted-out': 'Opted out',
}
export const statusText = (s: string): string => STATUS_TEXT[s] ?? 'Unknown'

/**
 * Failed if any fault failed; survived if at least one ran and every one that
 * ran passed; otherwise (nothing ran, or a fault produced no verdict)
 * inconclusive — an infrastructure result, not one about the application.
 */
export function runVerdict(r: Pick<ChaosRunReport, 'experiments'>): RunVerdict {
  const s = r.experiments.map((e) => e.status)
  if (s.includes('failed')) return 'failed'
  if (s.includes('passed') && !s.includes('error')) return 'survived'
  return 'inconclusive'
}

/**
 * 0–100: the mean, over faults with a verdict, of the steady-state probe's
 * success percentage (100 for a pass that recorded none, 0 for such a fail).
 * Null when no fault produced a verdict.
 */
export function resilienceScore(r: Pick<ChaosRunReport, 'experiments'>): number | null {
  const judged = r.experiments.filter((e) => e.status === 'passed' || e.status === 'failed')
  if (!judged.length) return null
  const sum = judged.reduce((acc, e) => acc + (e.probeSuccessPercentage ?? (e.status === 'passed' ? 100 : 0)), 0)
  return Math.round(sum / judged.length)
}

/** A–F from the score; a run with a failed fault grades C at best. `—` when nothing was judged. */
export function runGrade(r: Pick<ChaosRunReport, 'experiments'>): string {
  const score = resilienceScore(r)
  if (score === null) return '—'
  const g = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
  return runVerdict(r) === 'failed' && (g === 'A' || g === 'B') ? 'C' : g
}

/** Seconds above which recovery is called slow. */
export const SLOW_RECOVERY_SECONDS = 60

/* ─────────────────────────── history ─────────────────────────── */

export interface History {
  /** The run before this one, same application and namespace. */
  previous?: ChaosRunReport
  /** The latest earlier run of a DIFFERENT known commit, same application and namespace. */
  previousCommit?: ChaosRunReport
}

export function historyOf(all: ChaosRunReport[], r: ChaosRunReport): History {
  const earlier = all
    .filter((x) => x.id !== r.id && x.app === r.app && x.namespace === r.namespace && x.finishedAt < r.finishedAt)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
  const previousCommit = r.commit ? earlier.find((x) => x.commit && x.commit !== r.commit) : undefined
  return { ...(earlier[0] ? { previous: earlier[0] } : {}), ...(previousCommit ? { previousCommit } : {}) }
}

export type Change = 'better' | 'worse' | 'same' | 'new' | 'gone'

export interface ExperimentDelta {
  name: string
  before?: ExperimentRecord
  after?: ExperimentRecord
  change: Change
}

const RANK: Record<string, number> = { passed: 2, error: 1, failed: 0 }

/** How each fault moved from `before` to `after`: verdict first, then probe %, then recovery. */
export function compareRuns(after: ChaosRunReport, before: ChaosRunReport): { rows: ExperimentDelta[]; overall: Change } {
  const names = [...new Set([...after.experiments.map((e) => e.name), ...before.experiments.map((e) => e.name)])]
  const rows = names.map((name): ExperimentDelta => {
    const a = after.experiments.find((e) => e.name === name)
    const b = before.experiments.find((e) => e.name === name)
    if (!b) return { name, after: a, change: 'new' }
    if (!a) return { name, before: b, change: 'gone' }
    const ra = RANK[a.status]
    const rb = RANK[b.status]
    if (ra !== undefined && rb !== undefined && ra !== rb) return { name, before: b, after: a, change: ra > rb ? 'better' : 'worse' }
    const dp = (a.probeSuccessPercentage ?? -1) - (b.probeSuccessPercentage ?? -1)
    if (a.probeSuccessPercentage !== undefined && b.probeSuccessPercentage !== undefined && Math.abs(dp) >= 5) {
      return { name, before: b, after: a, change: dp > 0 ? 'better' : 'worse' }
    }
    if (a.recoverySeconds !== undefined && b.recoverySeconds !== undefined) {
      const dr = a.recoverySeconds - b.recoverySeconds
      // Recovery jitters by a few seconds between runs; only a real move counts.
      if (Math.abs(dr) >= Math.max(10, b.recoverySeconds * 0.5)) return { name, before: b, after: a, change: dr < 0 ? 'better' : 'worse' }
    }
    return { name, before: b, after: a, change: 'same' }
  })
  const worse = rows.some((r) => r.change === 'worse')
  const better = rows.some((r) => r.change === 'better')
  return { rows, overall: worse ? 'worse' : better ? 'better' : 'same' }
}

/* ─────────────────────────── guidance ─────────────────────────── */

export type Priority = 'high' | 'medium' | 'low'

export interface Finding {
  area: 'Experiments' | 'Recovery' | 'Workload design' | 'Change over time'
  tone: Tone
  title: string
  observation: string
  explanation: string
  recommendation?: string
  snippet?: string
  priority?: Priority
}

interface FaultGuidance {
  title: string
  /** What the fault simulates, in a clause: "while pods were deleted". */
  during: string
  why: string
  fix: string
  snippet?: string
  priority: Priority
}

const POD_LOSS: Omit<FaultGuidance, 'title' | 'during'> = {
  priority: 'high',
  why: 'Pods are lost routinely — deploys, node upgrades, evictions. If losing one interrupts service, every ordinary cluster operation is an outage.',
  fix: 'Run at least two replicas, give the container a readiness probe so traffic only reaches pods that are ready, and add a PodDisruptionBudget so voluntary disruptions keep one pod serving.',
  snippet: 'spec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n        - name: app\n          readinessProbe:\n            httpGet: { path: /healthz, port: http }\n            periodSeconds: 5\n---\napiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: <app>\nspec:\n  minAvailable: 1\n  selector:\n    matchLabels: { app: <app> }',
}

const SLOW_NETWORK: Omit<FaultGuidance, 'title' | 'during'> = {
  priority: 'medium',
  why: 'Networks slow down. Without timeouts a slow dependency holds connections and workers until the service runs out of both, turning one slow call into a full outage.',
  fix: 'Set explicit client timeouts on every outbound call (shorter than the caller\'s own), retry idempotent calls with backoff and jitter, and put a circuit breaker around dependencies that can be slow.',
}

const LOSSY_NETWORK: Omit<FaultGuidance, 'title' | 'during'> = {
  priority: 'medium',
  why: 'Dropped, corrupted or reset connections are normal on real networks. A service that treats each one as fatal fails requests it could have completed.',
  fix: 'Retry idempotent requests with exponential backoff and a cap, make write paths idempotent (request ids) so a retry is safe, and open a circuit breaker when a dependency keeps failing.',
}

const NODE_LOSS: Omit<FaultGuidance, 'title' | 'during'> = {
  priority: 'high',
  why: 'Nodes are drained and replaced on every cluster upgrade. Replicas that share a node, or that may all be evicted at once, go down together.',
  fix: 'Spread replicas across nodes with a topology spread constraint and protect them with a PodDisruptionBudget so a drain waits for a replacement.',
  snippet: 'topologySpreadConstraints:\n  - maxSkew: 1\n    topologyKey: kubernetes.io/hostname\n    whenUnsatisfiable: ScheduleAnyway\n    labelSelector:\n      matchLabels: { app: <app> }',
}

const GUIDANCE: Record<string, FaultGuidance> = {
  'pod-delete': { title: 'Pod delete', during: 'while its pods were deleted', ...POD_LOSS },
  'container-kill': { title: 'Container kill', during: 'while its container was killed', ...POD_LOSS },
  'pod-network-latency': { title: 'Network latency', during: 'with network latency added', ...SLOW_NETWORK },
  'pod-http-latency': { title: 'HTTP latency', during: 'with its HTTP responses delayed', ...SLOW_NETWORK },
  'pod-network-loss': { title: 'Packet loss', during: 'while packets were dropped', ...LOSSY_NETWORK },
  'pod-network-corruption': { title: 'Packet corruption', during: 'while packets were corrupted', ...LOSSY_NETWORK },
  'pod-network-duplication': { title: 'Packet duplication', during: 'while packets were duplicated', ...LOSSY_NETWORK },
  'pod-http-reset-peer': { title: 'HTTP connection reset', during: 'while connections were reset', ...LOSSY_NETWORK },
  'pod-network-partition': {
    title: 'Network partition',
    during: 'while cut off from the network',
    priority: 'high',
    why: 'A partition is a dependency that is simply gone. The service should fail fast and degrade, not hang.',
    fix: 'Fail fast with short connect timeouts, serve a degraded response (cached data, a feature turned off) when a dependency is unreachable, and keep readiness tied to what the service itself needs.',
  },
  'pod-cpu-hog': {
    title: 'CPU saturation',
    during: 'with its CPU saturated',
    priority: 'medium',
    why: 'Under CPU pressure a service should slow down gracefully. Failing health checks and restarting in a loop turns a busy period into an outage.',
    fix: 'Set CPU requests to the real steady-state usage, scale out on CPU with a HorizontalPodAutoscaler, and give the liveness probe enough timeout and failure threshold that a busy pod is not killed.',
    snippet: 'apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: <app>\nspec:\n  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: <app> }\n  minReplicas: 2\n  maxReplicas: 6\n  metrics:\n    - type: Resource\n      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }',
  },
  'node-cpu-hog': {
    title: 'Node CPU saturation',
    during: 'with its node\'s CPU saturated',
    priority: 'medium',
    why: 'A noisy neighbour on the same node takes CPU the service was counting on. Without requests it gets no guaranteed share.',
    fix: 'Set CPU requests so the scheduler reserves capacity, spread replicas across nodes, and scale out on CPU with an HPA.',
  },
  'pod-memory-hog': {
    title: 'Memory pressure',
    during: 'under memory pressure',
    priority: 'medium',
    why: 'When memory runs out the container is OOM-killed. A limit set too close to real usage, or a leak, turns ordinary load into restarts.',
    fix: 'Set the memory limit with headroom above measured peak usage (and the request near steady state), check for leaks with a heap profile under load, and cap in-process caches.',
    snippet: 'resources:\n  requests: { memory: 256Mi }\n  limits: { memory: 512Mi }',
  },
  'node-memory-hog': {
    title: 'Node memory pressure',
    during: 'with its node short of memory',
    priority: 'medium',
    why: 'A node under memory pressure evicts pods, lowest priority and furthest over request first.',
    fix: 'Set memory requests to real usage so the pod is not first to be evicted, run two or more replicas on different nodes, and add a PodDisruptionBudget.',
  },
  'pod-io-stress': {
    title: 'Disk I/O stress',
    during: 'with its disk I/O saturated',
    priority: 'low',
    why: 'Slow disk I/O stalls logging, temp files and local caches; a request path that writes to disk inherits that latency.',
    fix: 'Keep request paths off local disk (buffer logs, write asynchronously), and give scratch space an ephemeral-storage request and limit.',
  },
  'disk-fill': {
    title: 'Disk fill',
    during: 'with its disk filling up',
    priority: 'medium',
    why: 'A full disk fails writes — logs, uploads, temp files — and can crash a process that assumes it can always write.',
    fix: 'Set ephemeral-storage requests and limits, rotate or stream logs instead of keeping them on disk, and handle write failures explicitly.',
    snippet: 'resources:\n  requests: { ephemeral-storage: 256Mi }\n  limits: { ephemeral-storage: 1Gi }',
  },
  'node-drain': { title: 'Node drain', during: 'while its node was drained', ...NODE_LOSS },
  'node-taint': { title: 'Node taint', during: 'while its node was tainted', ...NODE_LOSS },
  'kubelet-service-kill': { title: 'Kubelet kill', during: 'while its node\'s kubelet was down', ...NODE_LOSS },
  'docker-service-kill': { title: 'Container runtime kill', during: 'while its node\'s container runtime was down', ...NODE_LOSS },
  'pod-dns-error': {
    title: 'DNS errors',
    during: 'while DNS lookups failed',
    priority: 'medium',
    why: 'When name resolution fails every outbound call fails with it. Services that resolve on every request feel it immediately.',
    fix: 'Reuse connections (pooling, keep-alive) so a resolver blip does not touch every request, set a short connect timeout, and handle resolution errors as retryable.',
  },
  'pod-http-status-code': {
    title: 'HTTP error responses',
    during: 'while its responses were replaced with errors',
    priority: 'medium',
    why: 'Dependencies return errors. Callers that do not handle them propagate failures upward instead of degrading.',
    fix: 'Treat 5xx from a dependency as retryable for idempotent calls, add a circuit breaker, and return a degraded response rather than an error where the product allows.',
  },
}

function guidanceFor(name: string): FaultGuidance {
  const g = GUIDANCE[name]
  if (g) return g
  const f = faultById(name)
  return {
    title: f?.label ?? name,
    during: `under ${name}`,
    priority: 'medium',
    why: 'The service did not stay healthy while this fault was injected.',
    fix: 'Re-run the fault from the Chaos page with a steady-state probe and read the pod events and application logs for the fault window.',
  }
}

const DESIGN: Record<string, { label: string; why: string; fix: string; snippet?: string; priority: Priority }> = {
  replicas_ha: {
    label: 'At least two replicas',
    priority: 'high',
    why: 'With one replica any pod loss is a full outage — which is what the pod-delete experiment simulates.',
    fix: 'Run at least two replicas in every environment that serves real traffic.',
    snippet: 'spec:\n  replicas: 2',
  },
  pod_disruption_budget: {
    label: 'PodDisruptionBudget',
    priority: 'medium',
    why: 'Without a PodDisruptionBudget a node drain may evict every replica at once.',
    fix: 'Add a PodDisruptionBudget that keeps at least one pod available.',
    snippet: 'apiVersion: policy/v1\nkind: PodDisruptionBudget\nmetadata:\n  name: <app>\nspec:\n  minAvailable: 1\n  selector:\n    matchLabels: { app: <app> }',
  },
  autoscaling: {
    label: 'HorizontalPodAutoscaler',
    priority: 'medium',
    why: 'A fixed replica count cannot absorb a CPU spike or the capacity lost while a pod restarts.',
    fix: 'Add a HorizontalPodAutoscaler on CPU (or request rate) with a floor of two replicas.',
  },
  spread_across_nodes: {
    label: 'Replicas spread across nodes',
    priority: 'medium',
    why: 'Replicas on the same node fail together when that node is drained or lost.',
    fix: 'Add a topology spread constraint so replicas land on different nodes.',
    snippet: 'topologySpreadConstraints:\n  - maxSkew: 1\n    topologyKey: kubernetes.io/hostname\n    whenUnsatisfiable: ScheduleAnyway\n    labelSelector:\n      matchLabels: { app: <app> }',
  },
  graceful_shutdown: {
    label: 'Graceful shutdown (preStop drain)',
    priority: 'medium',
    why: 'Without a drain a pod stops while requests are still routed to it, so every deleted pod drops a few requests.',
    fix: 'Add a short preStop sleep so endpoints update before the process stops, finish in-flight requests on SIGTERM, and keep terminationGracePeriodSeconds above the drain time.',
    snippet: 'lifecycle:\n  preStop:\n    exec: { command: ["sleep", "10"] }\nterminationGracePeriodSeconds: 30',
  },
  restart_stability: {
    label: 'No crash-looping containers',
    priority: 'high',
    why: 'Containers already restarting have no slack: a fault on top of a crash loop is an outage.',
    fix: 'Read the previous container\'s logs and termination reason; OOMKilled means the memory limit is too low or memory leaks, a failing liveness probe may be too aggressive for start-up.',
  },
  progressive_delivery: {
    label: 'Progressive delivery (canary / blue-green)',
    priority: 'low',
    why: 'A canary exposes a bad build to a slice of traffic and rolls back automatically, instead of failing for everyone.',
    fix: 'Deliver the service with an Argo Rollouts canary and an analysis step on error rate and latency.',
  },
  recovery_time: {
    label: 'Recovers quickly after chaos',
    priority: 'medium',
    why: 'Slow recovery stretches every incident: capacity stays reduced until the replacement pod is ready.',
    fix: 'Shorten start-up (smaller image, lazy initialisation), tune the readiness probe\'s initial delay and period, and keep spare replicas.',
  },
}

export const designLabel = (name: string): string => DESIGN[name]?.label ?? name.replaceAll('_', ' ')
export const faultTitle = (name: string): string => guidanceFor(name).title

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 }

/* ─────────────────────────── findings ─────────────────────────── */

/** `Pod delete` → `pod delete`, but `CPU saturation` stays as it is. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)

const fmtPct = (n: number | undefined) => (n === undefined ? undefined : `${Number(n.toFixed(1))}%`)

/** Every observation the report makes, derived only from the recorded run. */
export function chaosFindings(r: ChaosRunReport, h: History = {}): Finding[] {
  const out: Finding[] = []
  if (!r.experiments.length) {
    out.push({
      area: 'Experiments',
      tone: 'none',
      title: 'No fault was injected',
      observation: 'The run recorded no chaos experiment for this application.',
      explanation: 'Without injected failure there is no evidence the service survives a pod loss, a slow network or a saturated CPU.',
      recommendation: 'Declare the faults the service must survive in its resilience suite (the <app>-resilience ConfigMap) and run it from Application suites.',
      priority: 'medium',
    })
  }

  for (const e of r.experiments) {
    const g = guidanceFor(e.name)
    const probe = fmtPct(e.probeSuccessPercentage)
    const facts = [
      probe ? `the steady-state probe answered ${probe} of the time` : undefined,
      e.recoverySeconds !== undefined ? `the workload was back at full readiness ${e.recoverySeconds}s after the fault` : undefined,
      e.replicas !== undefined ? `${e.replicas} replica${e.replicas === 1 ? '' : 's'} were running` : undefined,
    ].filter(Boolean).join('; ')
    const base = `${g.title} (${e.name})${e.durationSeconds ? ` for ${e.durationSeconds}s` : ''}`
    if (e.status === 'passed') {
      const dipped = e.probeSuccessPercentage !== undefined && e.probeSuccessPercentage < 100
      out.push({
        area: 'Experiments',
        tone: dipped ? 'warn' : 'good',
        title: `${g.title}: ${dipped ? 'survived, with dips' : 'kept serving'}`,
        observation: `${base} passed${facts ? `: ${facts}` : ''}.${e.hypothesis ? ` Hypothesis: ${e.hypothesis}` : ''}`,
        explanation: dipped
          ? `Litmus judged the run a pass, but some probe requests failed ${g.during}. A few more failed requests and the verdict flips.`
          : `The service stayed available ${g.during}.`,
        ...(dipped ? { recommendation: g.fix, snippet: g.snippet, priority: 'low' as const } : {}),
      })
    } else if (e.status === 'failed') {
      out.push({
        area: 'Experiments',
        tone: 'bad',
        title: `${g.title}: stopped serving`,
        observation: `${base} failed${facts ? `: ${facts}` : ''}.${e.detail ? ` The runner recorded: "${e.detail}".` : ''}${e.hypothesis ? ` Hypothesis: ${e.hypothesis}` : ''}`,
        explanation: g.why,
        recommendation: g.fix,
        snippet: g.snippet,
        priority: g.priority,
      })
    } else if (e.status === 'error') {
      out.push({
        area: 'Experiments',
        tone: 'warn',
        title: `${g.title}: no verdict`,
        observation: `${base} produced no verdict${e.detail ? `: ${e.detail}` : ''}.`,
        explanation: 'The experiment did not finish — its runner pod never started or Litmus timed out. That is a result about the cluster, not the application, and it proves nothing either way.',
        recommendation: 'Re-run the suite from Application suites; if it repeats, check the Litmus operator and the runner pod\'s events in adhar-system.',
        priority: 'low',
      })
    } else {
      out.push({
        area: 'Experiments',
        tone: 'none',
        title: `${g.title}: ${statusText(e.status).toLowerCase()}`,
        observation: e.detail ? `${base}: ${e.detail}.` : `${base} did not run (${e.status}).`,
        explanation: e.status === 'opted-out'
          ? 'The service opted out of chaos, so this run is no evidence of how it handles the fault.'
          : 'The fault is not installed on this cluster, so this run is no evidence of how the service handles it.',
      })
    }
    if (e.recoverySeconds !== undefined && e.recoverySeconds > SLOW_RECOVERY_SECONDS) {
      const d = DESIGN.recovery_time
      out.push({
        area: 'Recovery',
        tone: 'warn',
        title: `Slow recovery after ${lowerFirst(g.title)}`,
        observation: `It took ${e.recoverySeconds}s for the workload to be back at full readiness, over the ${SLOW_RECOVERY_SECONDS}s this report treats as quick.`,
        explanation: d.why,
        recommendation: d.fix,
        priority: d.priority,
      })
    }
  }

  for (const c of r.checks ?? []) {
    if (!c.applicable || c.score >= 1) continue
    const d = DESIGN[c.name]
    out.push({
      area: 'Workload design',
      tone: c.score > 0 ? 'warn' : 'bad',
      title: `Not met: ${designLabel(c.name)}`,
      observation: `${c.detail ?? 'The platform scorer found this check not met.'}${r.checksEnvironment ? ` (graded on ${r.checksEnvironment})` : ''}`,
      explanation: d?.why ?? 'This check counts toward the resilience grade.',
      recommendation: d?.fix ?? 'Open the scorecard for this application for the check\'s details.',
      snippet: d?.snippet,
      priority: d?.priority ?? 'medium',
    })
  }

  for (const [which, other] of [['previous run', h.previous], ['previous commit', h.previousCommit]] as const) {
    if (!other || (which === 'previous commit' && other.id === h.previous?.id)) continue
    const { rows, overall } = compareRuns(r, other)
    const worse = rows.filter((x) => x.change === 'worse').map((x) => faultTitle(x.name))
    const better = rows.filter((x) => x.change === 'better').map((x) => faultTitle(x.name))
    const label = which === 'previous commit' ? `commit ${shortSha(other.commit)}` : `the run of ${other.finishedAt.slice(0, 10)}${other.commit ? ` (commit ${shortSha(other.commit)})` : ''}`
    out.push({
      area: 'Change over time',
      tone: overall === 'worse' ? 'bad' : overall === 'better' ? 'good' : 'none',
      title: overall === 'worse' ? `Worse than the ${which}` : overall === 'better' ? `Better than the ${which}` : `Unchanged since the ${which}`,
      observation: `Compared with ${label}: ${worse.length ? `worse on ${worse.join(', ')}` : 'nothing got worse'}${better.length ? `; better on ${better.join(', ')}` : ''}.`,
      explanation: overall === 'worse'
        ? 'Something between the two builds or environments reduced how well the service survives these faults.'
        : overall === 'better'
        ? 'The service survives these faults better than it did.'
        : 'The service behaves the same under these faults as it did.',
      ...(overall === 'worse'
        ? {
          recommendation: which === 'previous commit' && r.commit && other.commit
            ? `Review the changes between ${shortSha(other.commit)} and ${shortSha(r.commit)} that touch timeouts, probes, resources or replica settings, and re-run the suite to rule out a flake.`
            : 'Re-run the suite to rule out a flake, then compare the two runs\' images and workload settings.',
          priority: 'high' as const,
        }
        : {}),
    })
  }

  return out.map((f) => (f.snippet ? { ...f, snippet: f.snippet.replaceAll('<app>', r.app) } : f))
    .map((f) => (f.recommendation ? { ...f, recommendation: f.recommendation.replaceAll('<app>', r.app) } : f))
}

/** Recommendations, most important first. */
export function recommendations(findings: Finding[]): Finding[] {
  return findings
    .filter((f) => f.recommendation)
    .sort((a, b) => PRIORITY_ORDER[a.priority ?? 'medium'] - PRIORITY_ORDER[b.priority ?? 'medium'])
}

/** One line for the top of the report and the list row. */
export function headline(r: ChaosRunReport): string {
  const v = runVerdict(r)
  const failed = r.experiments.filter((e) => e.status === 'failed').map((e) => lowerFirst(faultTitle(e.name)))
  const ran = r.experiments.filter((e) => e.status === 'passed' || e.status === 'failed').length
  if (v === 'survived') return `${r.app} survived all ${ran} injected fault${ran === 1 ? '' : 's'} in ${r.environment}.`
  if (v === 'failed') return `${r.app} did not survive ${failed.join(', ')} in ${r.environment}${ran > failed.length ? `; it survived the other ${ran - failed.length}` : ''}.`
  return `This run of ${r.app} in ${r.environment} is inconclusive: no fault produced a verdict about the application.`
}

/* ─────────────────────────── HTML ─────────────────────────── */

export interface ReportMeta {
  generatedAt: string
  generatedBy?: string
  /** Where the report can be found in the console. */
  consoleUrl?: string
  /** Public link to the commit (made openable by the view). */
  commitHref?: string
}

const CHANGE_TONE: Record<Change, Tone> = { better: 'good', worse: 'bad', same: 'none', new: 'none', gone: 'none' }
const CHANGE_TEXT: Record<Change, string> = { better: 'Better', worse: 'Worse', same: 'Same', new: 'New fault', gone: 'Not run now' }

const EXTRA_CSS = `.facts{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;font-size:13px}
.facts dt{color:var(--muted);font-size:12px}.facts dd{margin:0;word-break:break-all}
.facts code,.sha{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.sha{background:#ffffff26;padding:2px 8px;border-radius:6px;font-weight:700;letter-spacing:.02em}
.verdict{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;background:#fff}
@media (max-width:720px){.facts{grid-template-columns:1fr}}`

function compareTable(cur: ChaosRunReport, other: ChaosRunReport, caption: string): string {
  const { rows } = compareRuns(cur, other)
  const cell = (e?: ExperimentRecord) =>
    e ? `${esc(statusText(e.status))}${e.probeSuccessPercentage !== undefined ? ` · ${esc(fmtPct(e.probeSuccessPercentage))}` : ''}${e.recoverySeconds !== undefined ? ` · ${e.recoverySeconds}s` : ''}` : '—'
  return `<h3>${esc(caption)}</h3>
<p class="note">${esc(other.finishedAt.slice(0, 16).replace('T', ' '))} UTC${other.commit ? ` · commit ${esc(shortSha(other.commit))}` : ' · commit unknown'}${other.environment !== cur.environment ? ` · ${esc(other.environment)}` : ''}</p>
<table><thead><tr><th>Fault</th><th>Then</th><th>Now</th><th>Change</th></tr></thead><tbody>
${rows.map((x) => `<tr><td>${esc(faultTitle(x.name))}<div class="sub">${esc(x.name)}</div></td><td class="num">${cell(x.before)}</td><td class="num">${cell(x.after)}</td><td>${pill(CHANGE_TONE[x.change], CHANGE_TEXT[x.change])}</td></tr>`).join('\n')}
</tbody></table>`
}

/** The full report as a standalone HTML document. */
export function chaosReportHtml(r: ChaosRunReport, h: History, meta: ReportMeta): string {
  const findings = chaosFindings(r, h)
  const recs = recommendations(findings)
  const verdict = runVerdict(r)
  const score = resilienceScore(r)
  const grade = runGrade(r)
  const judged = r.experiments.filter((e) => e.status === 'passed' || e.status === 'failed')
  const survived = judged.filter((e) => e.status === 'passed').length
  const probes = r.experiments.map((e) => e.probeSuccessPercentage).filter((n): n is number => n !== undefined)
  const recoveries = r.experiments.map((e) => e.recoverySeconds).filter((n): n is number => n !== undefined)
  const worstRecovery = recoveries.length ? Math.max(...recoveries) : undefined
  const minProbe = probes.length ? Math.round(Math.min(...probes)) : null
  const high = recs.filter((f) => f.priority === 'high').length
  const areas: Finding['area'][] = ['Experiments', 'Recovery', 'Workload design', 'Change over time']
  const when = (iso?: string) => (iso ? `${esc(iso.slice(0, 19).replace('T', ' '))} UTC` : '<span class="muted">not recorded</span>')

  const commitCell = r.commit
    ? `<code>${esc(r.commit)}</code>${meta.commitHref ? ` · <a href="${esc(meta.commitHref)}">view commit</a>` : ''}<div class="sub">${r.commitSource === 'kargo-freight' ? `Resolved from the image digest through Kargo freight ${esc(r.freight?.alias ?? r.freight?.name ?? '')}` : 'From the image tag (CI tags every image with its commit SHA)'}</div>`
    : `<span class="muted">Unknown</span><div class="sub">${esc(r.commitNote ?? 'The commit could not be resolved.')}</div>`

  const findingCard = (f: Finding) => `<div class="finding" style="border-left-color:${REPORT_TONE_COLOR[f.tone]}">
<div class="fhead"><h4>${esc(f.title)}</h4>${pill(f.tone)}</div>
<p><strong>Observation.</strong> ${esc(f.observation)}</p>
<p><strong>What it means.</strong> ${esc(f.explanation)}</p>
${f.recommendation ? `<p class="rec"><strong>Recommendation.</strong> ${esc(f.recommendation)}</p>` : ''}
</div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chaos Engineering Report — ${esc(r.app)}${r.commit ? ` @ ${esc(shortSha(r.commit))}` : ''}</title>
<style>
${REPORT_CSS}
${EXTRA_CSS}
</style>
</head>
<body>
<div class="page">
<header class="cover">
<div class="eyebrow">Adhar · Chaos Engineering Report</div>
<h1>${esc(r.app)}</h1>
<div class="meta">
${esc(r.environment)} · namespace <code>${esc(r.namespace)}</code>${r.project ? ` · project <code>${esc(r.project)}</code>` : ''} · ${when(r.finishedAt)}
<br>Commit ${r.commit ? `<span class="sha">${esc(shortSha(r.commit))}</span> <code>${esc(r.commit)}</code>` : '<code>unknown</code>'}
${r.image ? `<br>Image <code>${esc(r.image)}</code>` : ''}
<br>Triggered by ${esc(TRIGGER_LABEL[r.trigger])}${r.triggeredByUser ? ` — ${esc(r.triggeredByUser)}` : ''}
</div>
<div class="hero">
<div class="grade" style="background:${REPORT_GRADE_COLOR[grade] ?? '#64748b'}">${esc(grade)}</div>
<div class="score"><b>${score ?? '—'}${score === null ? '' : '/100'}</b>resilience under injected faults<br><span class="verdict" style="color:${REPORT_TONE_COLOR[VERDICT_TONE[verdict]]}">${esc(VERDICT_LABEL[verdict])}</span></div>
<div class="rings">${ring('Resilience', score)}${ring('Worst probe', minProbe)}</div>
</div>
</header>
<main>

<section>
<h2>Executive summary</h2>
<p class="summary">${esc(headline(r))}</p>
${r.gate ? `<p class="note">Promotion gate in ${esc(r.namespace)}: <strong>${esc(r.gate.verdict)}</strong>${r.gate.reasons.length ? ` — ${esc(r.gate.reasons.join('; '))}` : ''}.</p>` : ''}
<div class="kpis">
<div class="kpi"><b style="color:${REPORT_TONE_COLOR.good}">${survived}/${judged.length}</b><span>faults survived</span></div>
<div class="kpi"><b style="color:${REPORT_TONE_COLOR.bad}">${judged.length - survived}</b><span>faults failed</span></div>
<div class="kpi"><b style="color:${worstRecovery !== undefined && worstRecovery > SLOW_RECOVERY_SECONDS ? REPORT_TONE_COLOR.warn : 'inherit'}">${worstRecovery !== undefined ? `${worstRecovery}s` : '—'}</b><span>slowest recovery</span></div>
<div class="kpi"><b style="color:${REPORT_PRIORITY_COLOR.high}">${high}</b><span>high-priority actions</span></div>
</div>
</section>

<section>
<h2>What was tested</h2>
<dl class="facts">
<dt>Application</dt><dd>${esc(r.app)}</dd>
<dt>Environment</dt><dd>${esc(r.environment)} (namespace <code>${esc(r.namespace)}</code>)</dd>
<dt>Commit</dt><dd>${commitCell}</dd>
<dt>Image</dt><dd>${r.image ? `<code>${esc(r.image)}</code>` : '<span class="muted">not recorded</span>'}</dd>
${r.freight ? `<dt>Kargo freight</dt><dd>${esc(r.freight.alias ?? r.freight.name)}${r.freight.project ? ` <span class="sub">in project ${esc(r.freight.project)}</span>` : ''}</dd>` : ''}
<dt>Triggered by</dt><dd>${esc(TRIGGER_LABEL[r.trigger])}${r.triggeredByUser ? ` — ${esc(r.triggeredByUser)}` : ''}</dd>
<dt>Run</dt><dd>${r.runId ? `<code>${esc(r.runId)}</code>` : '<span class="muted">not recorded</span>'}</dd>
<dt>Started</dt><dd>${when(r.startedAt)}</dd>
<dt>Finished</dt><dd>${when(r.finishedAt)}</dd>
${r.target ? `<dt>Probe target</dt><dd><code>${esc(r.target)}</code></dd>` : ''}
</dl>
</section>

<section>
<h2>Experiments</h2>
<p class="note">Litmus faults, injected in order while a steady-state HTTP probe polled the service continuously. Recovery is the time until the workload was back at its desired ready replica count.</p>
${r.experiments.length ? `<table><thead><tr><th>Fault</th><th>Probe up</th><th>Recovery</th><th>Result</th></tr></thead><tbody>
${r.experiments.map((e) => `<tr><td>${esc(faultTitle(e.name))}<div class="sub">${esc(e.name)}${e.hypothesis ? ` — ${esc(e.hypothesis)}` : ''}</div></td><td class="num">${e.probeSuccessPercentage !== undefined ? esc(fmtPct(e.probeSuccessPercentage)) : '—'}</td><td class="num">${e.recoverySeconds !== undefined ? `${e.recoverySeconds}s` : '—'}</td><td>${pill(experimentTone(e), statusText(e.status))}</td></tr>`).join('\n')}
</tbody></table>` : '<p class="note">No experiment was recorded for this run.</p>'}
${r.performance ? `<h3>Load test in the same run ${pill(r.performance.status === 'passed' ? 'good' : r.performance.status === 'failed' ? 'bad' : 'warn', r.performance.status)}</h3>
<table><thead><tr><th>p95 latency</th><th>Error rate</th><th>Throughput</th><th>Threshold</th></tr></thead><tbody>
<tr><td class="num">${r.performance.p95Ms !== undefined ? `${Number(r.performance.p95Ms.toFixed(1))} ms` : '—'}</td><td class="num">${r.performance.errorRate !== undefined ? esc(fmtPct(r.performance.errorRate * 100)) : '—'}</td><td class="num">${r.performance.rps !== undefined ? `${Number(r.performance.rps.toFixed(1))} req/s` : '—'}</td><td class="num">${r.performance.thresholdP95Ms !== undefined ? `p95 &lt; ${r.performance.thresholdP95Ms} ms` : '—'}</td></tr>
</tbody></table>${r.performance.detail ? `<p class="note">${esc(r.performance.detail)}</p>` : ''}` : ''}
</section>

${h.previous || h.previousCommit ? `<section>
<h2>Compared with earlier runs</h2>
${h.previous ? compareTable(r, h.previous, 'Previous run') : ''}
${h.previousCommit && h.previousCommit.id !== h.previous?.id ? compareTable(r, h.previousCommit, `Previous commit (${shortSha(h.previousCommit.commit)})`) : ''}
</section>` : ''}

<section>
<h2>Observations</h2>
${areas.map((a) => {
    const list = findings.filter((f) => f.area === a)
    return list.length ? `<h3>${esc(a)}</h3>${list.map(findingCard).join('\n')}` : ''
  }).join('\n')}
</section>

<section>
<h2>Recommendations</h2>
${recs.length
    ? `<ol class="recs">${recs.map((f) => `<li><div><span class="prio" style="color:${REPORT_PRIORITY_COLOR[f.priority ?? 'medium']}">${esc(f.priority ?? 'medium')}</span><strong>${esc(f.title)}</strong>
<div class="note" style="margin-top:3px">${esc(f.recommendation)}</div>${f.snippet ? `<pre>${esc(f.snippet)}</pre>` : ''}</div></li>`).join('\n')}</ol>`
    : '<p class="note">Nothing to do: every injected fault was survived and every workload-design check recorded for the application passes.</p>'}
</section>

${r.checks?.length ? `<section>
<h2>Workload design checks</h2>
<p class="note">How the workload is built to survive failure, from the platform scorer${r.checksEnvironment ? ` (graded on ${esc(r.checksEnvironment)})` : ''} at the time of the run.</p>
<div class="checks">
${r.checks.map((c) => `<div class="check"><i style="background:${!c.applicable ? '#cbd5e1' : c.score >= 1 ? REPORT_TONE_COLOR.good : c.score > 0 ? REPORT_TONE_COLOR.warn : REPORT_TONE_COLOR.bad}"></i><div>${esc(designLabel(c.name))}<small>${!c.applicable ? 'Not applicable — ' : ''}${esc(c.detail ?? (c.score >= 1 ? 'Pass' : 'Not met'))}</small></div></div>`).join('\n')}
</div>
</section>` : ''}

<section>
<h2>How this report was produced</h2>
<p class="note">The platform's resilience runner injected each fault of the application's own resilience suite with LitmusChaos in ${esc(r.environment)} (never production), under a continuous steady-state HTTP probe, and measured recovery as the time until the workload was back at its desired ready replicas. The Adhar Console recorded the run as it landed. The commit is the one the tested image was built from — read from the image's commit-SHA tag, or for an image pinned by digest from the Kargo freight that carries that digest — and is shown as unknown rather than guessed when neither names it. The resilience score is the mean probe success over faults with a verdict (A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60); a run with a failed fault grades C at best. Recovery over ${SLOW_RECOVERY_SECONDS}s is reported as slow. Anything the runner did not measure is shown as missing.</p>
</section>

</main>
<footer><span>Generated ${esc(reportTime(meta.generatedAt))}${meta.generatedBy ? ` by ${esc(meta.generatedBy)}` : ''} · report ${esc(r.id)}</span><span>${meta.consoleUrl ? `<a href="${esc(meta.consoleUrl)}" style="color:inherit">${esc(meta.consoleUrl)}</a>` : 'Adhar Console'}</span></footer>
</div>
</body>
</html>
`
}

/** `cart-test-a1b2c3d-2026-10-22.pdf` */
export function reportFileName(r: ChaosRunReport, ext: 'pdf' | 'html'): string {
  return `${r.app}-${r.environment}-chaos-${r.commit ? shortSha(r.commit) : 'unknown-commit'}-${r.finishedAt.slice(0, 10)}.${ext}`
}
