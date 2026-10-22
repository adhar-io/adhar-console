import type { NotificationDoc } from '../notify.ts'
import type { EvidenceLimits } from './config.ts'
import type { IncidentRef } from './classify.ts'
import { redactObject, redactText } from './redact.ts'
import { XR_GROUP, XR_KINDS } from '../events/control-plane-sources.ts'

/**
 * Evidence for a support ticket: what the object says, what its pods say,
 * what the logs, metrics and traces say, and what was being delivered.
 *
 * BEST EFFORT, BY CONSTRUCTION. Each section is collected on its own with its
 * own timeout (`queryTimeoutMs` per backend call) and its own failure: Loki
 * being down costs the ticket its log section — which then says "Loki
 * unreachable: …" — never the ticket. Nothing in here throws to its caller.
 *
 * Everything that comes back is redacted (`redact.ts`) BEFORE it is stored on
 * the evidence object, so the rendered ticket, the JSON attachment and the dry
 * run all see the same scrubbed data.
 */

/* ─────────────────────────── backends ─────────────────────────── */

export interface LokiStream { stream: Record<string, string>; values: Array<[string, string]> }
export interface PromSample { metric: Record<string, string>; value: [number, string] }
export interface TempoTrace { traceID: string; rootServiceName?: string; rootTraceName?: string; startTimeUnixNano?: string; durationMs?: number }

/** The I/O the collector does — injected so tests (and a dry run) can stand in for the cluster. */
export interface Backends {
  /** GET an apiserver path; throws on a non-2xx (with the status in the message). */
  k8s(path: string, search?: Record<string, string>): Promise<unknown>
  /** GET an apiserver path as text (pod logs). */
  k8sText(path: string, search?: Record<string, string>): Promise<string>
  /** Loki `query_range` (newest first unless `direction` is `forward`). */
  loki(query: string, startMs: number, endMs: number, limit: number, direction?: 'backward' | 'forward'): Promise<LokiStream[]>
  /** Prometheus instant query. */
  prom(expr: string): Promise<PromSample[]>
  /** Tempo TraceQL search. */
  tempo(q: string, startMs: number, endMs: number, limit: number): Promise<TempoTrace[]>
}

/** Public URLs deep links are built on; empty string = that link is omitted. */
export interface LinkBases {
  console: string
  grafana: string
  argocd: string
  kargo: string
  /** Grafana datasource uids. */
  ds: { prometheus: string; loki: string; tempo: string }
}

/* ─────────────────────────── evidence shape ─────────────────────────── */

export type SectionStatus = 'ok' | 'empty' | 'error' | 'skipped'
export interface Section<T> { status: SectionStatus; note?: string; data?: T }

export interface PodSummary {
  name: string
  phase?: string
  ready: boolean
  restarts: number
  node?: string
  containers: Array<{ name: string; ready?: boolean; restarts: number; waiting?: string; lastTermination?: { reason?: string; exitCode?: number; finishedAt?: string } }>
}

export interface EventSummary { at?: string; type?: string; reason?: string; object: string; message?: string; count?: number }

export interface MetricResult {
  title: string
  expr: string
  unit: 'count' | 'cores' | 'bytes' | 'ratio' | 'seconds' | 'raw'
  values: Array<{ labels: Record<string, string>; value: number }>
  exploreUrl?: string
  error?: string
}

export interface Evidence {
  collectedAt: string
  windowMinutes: number
  subject: {
    family: string
    objectKind?: string
    namespace?: string
    name?: string
    app?: string
    env?: string
    project?: string
    workloadNamespace?: string
    pods: string[]
  }
  k8s: Section<{ object?: unknown; events: EventSummary[]; pods: PodSummary[] }>
  logs: Section<{ source: 'loki' | 'apiserver'; query?: string; errorLines: string[]; lines: string[]; exploreUrl?: string }>
  metrics: Section<{ results: MetricResult[] }>
  traces: Section<{ query: string; traces: Array<{ traceId: string; service?: string; name?: string; start?: string; durationMs?: number; url?: string }>; exploreUrl?: string }>
  delivery: Section<{
    argo?: {
      name: string
      namespace: string
      project?: string
      repo?: string
      path?: string
      targetRevision?: string
      revision?: string
      health?: string
      healthMessage?: string
      sync?: string
      lastOperation?: { phase?: string; message?: string; startedAt?: string; finishedAt?: string; initiatedBy?: string; promotion?: string }
      images: string[]
    }
    kargo?: {
      promotion?: { name: string; namespace: string; phase?: string; message?: string; stage?: string; freight?: string; images: string[]; commits: string[] }
      verification?: { stage: string; phase?: string; message?: string; analysisRun?: string; health?: string; issues?: string[] }
    }
    commit?: string
  }>
  links: { console?: string; argocd?: string; kargo?: string; grafana?: string }
}

/* ─────────────────────────── helpers ─────────────────────────── */

type Obj = Record<string, unknown>
const get = <T>(o: unknown, path: string): T | undefined => {
  let cur: unknown = o
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Obj)[p]
  }
  return cur as T | undefined
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const promStr = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const MAX_LINE = 500

/** Workload kinds and where they live in the API. */
const WORKLOAD_PATH: Record<string, (ns: string, n: string) => string> = {
  Rollout: (ns, n) => `/apis/argoproj.io/v1alpha1/namespaces/${ns}/rollouts/${n}`,
  Deployment: (ns, n) => `/apis/apps/v1/namespaces/${ns}/deployments/${n}`,
  StatefulSet: (ns, n) => `/apis/apps/v1/namespaces/${ns}/statefulsets/${n}`,
  DaemonSet: (ns, n) => `/apis/apps/v1/namespaces/${ns}/daemonsets/${n}`,
  Job: (ns, n) => `/apis/batch/v1/namespaces/${ns}/jobs/${n}`,
}

/** `{app: x, tier: y}` → `app=x,tier=y`. */
const selectorOf = (labels: Record<string, string> | undefined) =>
  Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`).join(',')

/** Grafana Explore URL for one query (Grafana 10+ `panes` form). */
export function exploreUrl(
  base: string,
  ds: { type: 'prometheus' | 'loki' | 'tempo'; uid: string },
  query: string,
  windowMinutes: number,
): string | undefined {
  if (!base) return undefined
  const q = ds.type === 'tempo'
    ? { refId: 'A', datasource: ds, queryType: 'traceql', query, limit: 20 }
    : { refId: 'A', datasource: ds, expr: query }
  const panes = { a: { datasource: ds.uid, queries: [q], range: { from: `now-${windowMinutes}m`, to: 'now' } } }
  return `${base.replace(/\/$/, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
}

/* ─────────────────────────── subject resolution ─────────────────────────── */

interface Resolved {
  primary?: Obj
  argo?: Obj
  namespace?: string
  app?: string
  env?: string
  project?: string
  pods: Obj[]
  /** Extra LogQL line filter (`|~ "…"`) when the pods log far more than the incident. */
  logFilter?: string
  notes: string[]
}

async function tryGet(b: Backends, path: string, search?: Record<string, string>): Promise<Obj | undefined> {
  try {
    return (await b.k8s(path, search)) as Obj
  } catch {
    return undefined
  }
}

async function findArgoApp(b: Backends, app?: string, env?: string): Promise<Obj | undefined> {
  if (!app) return undefined
  const sel = `adhar.io/application=${app}${env ? `,adhar.io/environment=${env}` : ''}`
  const list = await tryGet(b, '/apis/argoproj.io/v1alpha1/applications', { labelSelector: sel, limit: '5' })
  return (list?.items as Obj[] | undefined)?.[0]
}

async function podsOfSelector(b: Backends, ns: string, selector: string): Promise<Obj[]> {
  if (!selector) return []
  const list = await tryGet(b, `/api/v1/namespaces/${ns}/pods`, { labelSelector: selector, limit: '30' })
  return (list?.items as Obj[] | undefined) ?? []
}

async function podsOfWorkloads(b: Backends, ns: string, workloads: Array<{ kind: string; name: string }>): Promise<Obj[]> {
  const out: Obj[] = []
  for (const w of workloads.slice(0, 3)) {
    const path = WORKLOAD_PATH[w.kind]?.(ns, w.name)
    if (!path) continue
    const obj = await tryGet(b, path)
    const sel = selectorOf(get<Record<string, string>>(obj, 'spec.selector.matchLabels'))
    if (sel) out.push(...await podsOfSelector(b, ns, sel))
  }
  return out
}

/** The workloads an Argo CD app deploys, from its resource tree. */
function argoWorkloads(argo: Obj): Array<{ kind: string; name: string; namespace?: string }> {
  const res = get<Array<{ kind?: string; name?: string; namespace?: string }>>(argo, 'status.resources') ?? []
  return res.filter((r) => r.kind && r.name && r.kind in WORKLOAD_PATH && r.kind !== 'Job').map((r) => ({ kind: r.kind!, name: r.name!, namespace: r.namespace }))
}

async function fromArgo(b: Backends, argo: Obj, r: Resolved): Promise<void> {
  r.argo = argo
  const l = get<Record<string, string>>(argo, 'metadata.labels') ?? {}
  r.namespace = get<string>(argo, 'spec.destination.namespace') ?? r.namespace
  r.app = l['adhar.io/application'] ?? r.app ?? get<string>(argo, 'metadata.name')
  r.env = l['adhar.io/environment'] ?? r.env
  r.project = l['adhar.io/project'] ?? r.project
  if (r.namespace && !r.pods.length) {
    r.pods = await podsOfWorkloads(b, r.namespace, argoWorkloads(argo))
  }
}

export async function resolveSubject(ref: IncidentRef, doc: NotificationDoc, b: Backends): Promise<Resolved> {
  const r: Resolved = { namespace: ref.namespace, app: ref.app, env: ref.env, pods: [], notes: [] }
  const ns = ref.namespace ?? ''
  const name = ref.name ?? ''
  switch (ref.source) {
    case 'argocd':
    case 'argocd-sync': {
      r.primary = await tryGet(b, `/apis/argoproj.io/v1alpha1/namespaces/${ns}/applications/${name}`)
      r.namespace = undefined
      if (r.primary) await fromArgo(b, r.primary, r)
      else r.notes.push(`Argo CD application ${ns}/${name} could not be read.`)
      break
    }
    case 'rollout': {
      r.primary = await tryGet(b, WORKLOAD_PATH.Rollout(ns, name))
      const sel = selectorOf(get<Record<string, string>>(r.primary, 'spec.selector.matchLabels'))
      r.pods = await podsOfSelector(b, ns, sel)
      const argo = await findArgoApp(b, ref.app, ref.env)
      if (argo) await fromArgo(b, argo, r)
      r.namespace = ns
      break
    }
    case 'tekton': {
      r.primary = await tryGet(b, `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns/${name}`)
      r.pods = await podsOfSelector(b, ns, `tekton.dev/pipelineRun=${name}`)
      break
    }
    case 'kargo-promotion':
    case 'kargo-verification': {
      r.primary = await tryGet(
        b,
        ref.source === 'kargo-promotion'
          ? `/apis/kargo.akuity.io/v1alpha1/namespaces/${ns}/promotions/${name}`
          : `/apis/kargo.akuity.io/v1alpha1/namespaces/${ns}/stages/${name}`,
      )
      r.project = ns
      const argo = await findArgoApp(b, ref.app, ref.env)
      if (argo) await fromArgo(b, argo, r)
      else r.namespace = undefined
      break
    }
    case 'event': {
      if (ref.objectKind === 'Pod') {
        const pod = await tryGet(b, `/api/v1/namespaces/${ns}/pods/${name}`)
        r.primary = pod
        const labels = { ...(get<Record<string, string>>(pod, 'metadata.labels') ?? {}) }
        for (const k of ['pod-template-hash', 'rollouts-pod-template-hash', 'controller-revision-hash', 'statefulset.kubernetes.io/pod-name', 'apps.kubernetes.io/pod-index']) delete labels[k]
        r.pods = pod ? await podsOfSelector(b, ns, selectorOf(labels)) : []
        if (!r.pods.length) {
          // The pod is gone (replaced); its siblings share the workload prefix.
          const list = await tryGet(b, `/api/v1/namespaces/${ns}/pods`, { limit: '200' })
          r.pods = ((list?.items as Obj[] | undefined) ?? []).filter((p) => (get<string>(p, 'metadata.name') ?? '').startsWith(`${ref.app}-`))
        }
      } else if (ref.objectKind && WORKLOAD_PATH[ref.objectKind]) {
        r.primary = await tryGet(b, WORKLOAD_PATH[ref.objectKind](ns, name))
        r.pods = await podsOfSelector(b, ns, selectorOf(get<Record<string, string>>(r.primary, 'spec.selector.matchLabels')))
      }
      break
    }
    case 'xr': {
      const plural = XR_KINDS.find((k) => k.kind === ref.objectKind)?.plural
      if (plural) r.primary = await tryGet(b, `/apis/${XR_GROUP}/v1alpha1/namespaces/${ns}/${plural}/${name}`)
      const xl = get<Record<string, string>>(r.primary, 'metadata.labels') ?? {}
      r.app = xl['adhar.io/application']
      r.project = xl['adhar.io/project']
      break
    }
    case 'autoscaler': {
      r.primary = await tryGet(b, `/apis/${XR_GROUP}/v1alpha1/namespaces/adhar-system/adharplatforms/${name}`)
      r.namespace = 'adhar-system'
      r.pods = await podsOfSelector(b, 'adhar-system', 'app.kubernetes.io/name=adhar-controller-manager')
      r.logFilter = '(?i)(autoscal|scale|node)'
      break
    }
    case 'resilience-gate': {
      r.primary = await tryGet(b, WORKLOAD_PATH.Job('adhar-system', name))
      r.namespace = 'adhar-system'
      r.pods = await podsOfSelector(b, 'adhar-system', `job-name=${name}`)
      break
    }
    case 'alertmanager': {
      const labels = ref.extra ?? {}
      if (ns && labels.pod) {
        const pod = await tryGet(b, `/api/v1/namespaces/${ns}/pods/${labels.pod}`)
        r.primary = pod
        if (pod) r.pods = [pod]
      } else if (ns && ref.objectKind && WORKLOAD_PATH[ref.objectKind] && ref.name) {
        r.primary = await tryGet(b, WORKLOAD_PATH[ref.objectKind](ns, ref.name))
        r.pods = await podsOfSelector(b, ns, selectorOf(get<Record<string, string>>(r.primary, 'spec.selector.matchLabels')))
      }
      break
    }
    default: {
      // Manual ticket for something no family knows: try the target as an Argo CD app.
      if (doc.target?.type === 'application') {
        const argo = await tryGet(b, `/apis/argoproj.io/v1alpha1/namespaces/adhar-system/applications/${doc.target.id}`)
        if (argo) {
          r.primary = argo
          await fromArgo(b, argo, r)
        }
      }
    }
  }
  // Fall back to the conventional `app=` label when nothing named the workload.
  if (!r.pods.length && r.namespace && r.app && ref.family !== 'tekton') {
    r.pods = await podsOfSelector(b, r.namespace, `app=${r.app}`)
    if (!r.pods.length) r.pods = await podsOfSelector(b, r.namespace, `app.kubernetes.io/name=${r.app}`)
  }
  // Unhealthy pods first, then the most restarted; ten is plenty for a ticket.
  r.pods = dedupePods(r.pods).sort((a, c) => podScore(c) - podScore(a)).slice(0, 10)
  return r
}

function dedupePods(pods: Obj[]): Obj[] {
  const seen = new Set<string>()
  return pods.filter((p) => {
    const n = get<string>(p, 'metadata.name') ?? ''
    if (seen.has(n)) return false
    seen.add(n)
    return true
  })
}

function podScore(p: Obj): number {
  const s = summarizePod(p)
  return (s.ready ? 0 : 1000) + s.restarts
}

/* ─────────────────────────── kubernetes ─────────────────────────── */

export function summarizePod(p: Obj): PodSummary {
  const statuses = get<Obj[]>(p, 'status.containerStatuses') ?? []
  const containers = statuses.map((c) => {
    const term = get<Obj>(c, 'lastState.terminated') ?? get<Obj>(c, 'state.terminated')
    return {
      name: String(c.name ?? ''),
      ready: c.ready as boolean | undefined,
      restarts: Number(c.restartCount ?? 0),
      waiting: get<string>(c, 'state.waiting.reason'),
      lastTermination: term ? { reason: term.reason as string | undefined, exitCode: term.exitCode as number | undefined, finishedAt: term.finishedAt as string | undefined } : undefined,
    }
  })
  return {
    name: get<string>(p, 'metadata.name') ?? '?',
    phase: get<string>(p, 'status.phase'),
    ready: (get<Obj[]>(p, 'status.conditions') ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    restarts: containers.reduce((n, c) => n + c.restarts, 0),
    node: get<string>(p, 'spec.nodeName'),
    containers,
  }
}

/** The part of an object's status a person reads in an incident. */
export function trimObject(o: Obj | undefined): unknown {
  if (!o) return undefined
  const s = (o.status ?? {}) as Obj
  const conds = (s.conditions as Obj[] | undefined)?.map((c) => ({
    type: c.type,
    status: c.status,
    reason: c.reason,
    message: typeof c.message === 'string' ? c.message.slice(0, 600) : undefined,
    lastTransitionTime: c.lastTransitionTime,
  }))
  const op = s.operationState as Obj | undefined
  const fh = (s.freightHistory as Obj[] | undefined)?.[0]
  const status: Obj = {
    phase: s.phase,
    message: typeof s.message === 'string' ? s.message.slice(0, 800) : undefined,
    health: s.health,
    sync: s.sync ? { status: get(s, 'sync.status'), revision: get(s, 'sync.revision') } : undefined,
    operationState: op ? { phase: op.phase, message: op.message, startedAt: op.startedAt, finishedAt: op.finishedAt } : undefined,
    abort: s.abort,
    currentPodHash: s.currentPodHash,
    stableRS: s.stableRS,
    replicas: s.replicas,
    readyReplicas: s.readyReplicas,
    availableReplicas: s.availableReplicas,
    verification: fh ? (fh.verificationHistory as Obj[] | undefined)?.[0] : undefined,
    conditions: conds,
  }
  for (const k of Object.keys(status)) if (status[k] === undefined) delete status[k]
  const md = (o.metadata ?? {}) as Obj
  const labels = Object.fromEntries(Object.entries((md.labels ?? {}) as Record<string, string>).filter(([k]) => k.startsWith('adhar.io/') || k === 'app'))
  return redactObject({ apiVersion: o.apiVersion, kind: o.kind, name: md.name, namespace: md.namespace, labels, status })
}

async function eventsFor(b: Backends, ns: string, names: string[], limit: number): Promise<EventSummary[]> {
  const all: EventSummary[] = []
  await Promise.all(names.slice(0, 8).map(async (n) => {
    const list = await tryGet(b, `/api/v1/namespaces/${ns}/events`, { fieldSelector: `involvedObject.name=${n}`, limit: '50' })
    for (const e of (list?.items as Obj[] | undefined) ?? []) {
      all.push({
        at: (e.lastTimestamp ?? e.eventTime ?? get(e, 'metadata.creationTimestamp')) as string | undefined,
        type: e.type as string | undefined,
        reason: e.reason as string | undefined,
        object: `${get<string>(e, 'involvedObject.kind') ?? ''}/${get<string>(e, 'involvedObject.name') ?? n}`,
        message: typeof e.message === 'string' ? redactText(e.message).slice(0, MAX_LINE) : undefined,
        count: e.count as number | undefined,
      })
    }
  }))
  // Warnings first, newest first within each.
  return all
    .sort((a, c) => (a.type === c.type ? String(c.at ?? '').localeCompare(String(a.at ?? '')) : a.type === 'Warning' ? -1 : 1))
    .slice(0, limit)
}

/* ─────────────────────────── logs ─────────────────────────── */

const ERROR_FILTER = '(?i)(error|exception|fatal|panic|traceback|caused by|oomkill|out ?of ?memory|killed|refused|denied|timed? ?out|failed|unhealthy)'
const ERROR_RE = new RegExp(ERROR_FILTER.replace('(?i)', ''), 'i')
/** Lines that MATCH the error filter but are configuration echo, not failures. */
const NOT_AN_ERROR = /^Picked up JAVA_TOOL_OPTIONS|^Calculated JVM Memory Configuration|ExitOnOutOfMemoryError\s/i
/** Context lines kept after each distinct error (stack traces, parser messages). */
const CONTEXT_LINES = 20
/** Distinct errors whose context is fetched. */
const CONTEXT_ERRORS = 3

interface Line { ts: string; line: string; pod?: string }

function streamLines(streams: LokiStream[]): Line[] {
  return streams
    .flatMap((s) => s.values.map(([ts, line]) => ({ ts, line, pod: s.stream.pod })))
    .sort((a, c) => (a.ts < c.ts ? 1 : a.ts > c.ts ? -1 : 0))
}

const cut = (text: string) => {
  const t = redactText(text.replace(/\s+$/, ''))
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)}…` : t
}
const fmtLine = (l: { line: string; pod?: string }) => (l.pod ? `[${l.pod}] ${cut(l.line)}` : cut(l.line))

/**
 * What makes two error lines "the same error": the text with timestamps,
 * numbers, hashes and pod names taken out. A crash-looping pod prints one
 * error forty times; the ticket needs it once, with the count.
 */
export function errorSignature(line: string): string {
  return line
    .replace(/^\S*\d{2}:\d{2}:\d{2}\S*\s*/, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** Group error lines by signature, newest first: one entry per distinct error. */
export function groupErrors(lines: Line[]): Array<{ first: Line; count: number; pods: Set<string> }> {
  const groups = new Map<string, { first: Line; count: number; pods: Set<string> }>()
  for (const l of lines) {
    if (!l.line.trim() || NOT_AN_ERROR.test(l.line)) continue
    const sig = errorSignature(l.line)
    const g = groups.get(sig)
    if (g) {
      g.count++
      if (l.pod) g.pods.add(l.pod)
    } else groups.set(sig, { first: l, count: 1, pods: new Set(l.pod ? [l.pod] : []) })
  }
  return [...groups.values()]
}

/** Render error groups (with their context) as ticket lines. */
function errorBlock(groups: Array<{ first: Line; count: number; pods: Set<string> }>, context: Map<Line, string[]>): string[] {
  const out: string[] = []
  for (const g of groups) {
    const times = g.count > 1 ? ` (×${g.count}${g.pods.size > 1 ? ` across ${g.pods.size} pods` : ''})` : ''
    out.push(`${fmtLine(g.first)}${times}`)
    for (const c of context.get(g.first) ?? []) out.push(`    │ ${cut(c)}`)
  }
  return out
}

async function collectLogs(r: Resolved, b: Backends, lim: EvidenceLimits, links: LinkBases, now: number): Promise<Evidence['logs']> {
  if (lim.logLines <= 0) return { status: 'skipped', note: 'Log collection is turned off.' }
  if (!r.namespace) return { status: 'skipped', note: 'No workload namespace is known for this incident.' }
  const ns = r.namespace
  const podNames = r.pods.map((p) => get<string>(p, 'metadata.name')).filter((n): n is string => !!n)
  const selector = podNames.length
    ? `{namespace="${promStr(ns)}", pod=~"${promStr(podNames.map(reEscape).join('|'))}"}`
    : r.app
    ? `{namespace="${promStr(ns)}", app="${promStr(r.app)}"}`
    : ''
  if (!selector) return { status: 'skipped', note: 'No pods or app label to select logs by.' }
  const base = r.logFilter ? `${selector} |~ "${promStr(r.logFilter)}"` : selector
  const start = now - lim.windowMinutes * 60_000
  let lokiError: string | undefined
  try {
    const [errs, tail] = await Promise.all([
      b.loki(`${base} |~ "${promStr(ERROR_FILTER)}"`, start, now, Math.max(10, lim.logLines)),
      b.loki(base, start, now, lim.logLines),
    ])
    const groups = groupErrors(streamLines(errs))
    // The line AFTER an error is usually the cause (a stack trace, a parser's
    // complaint) — fetch a few seconds forward from the newest occurrence of
    // each of the first few distinct errors.
    const context = new Map<Line, string[]>()
    await Promise.all(groups.slice(0, CONTEXT_ERRORS).map(async (g) => {
      if (!g.first.pod) return
      const t = Number(BigInt(g.first.ts) / 1_000_000n)
      try {
        const after = await b.loki(`{namespace="${promStr(ns)}", pod="${promStr(g.first.pod)}"}`, t, t + 5_000, CONTEXT_LINES + 1, 'forward')
        const lines = streamLines(after).reverse().filter((l) => l.ts !== g.first.ts && l.line.trim())
        context.set(g.first, lines.slice(0, CONTEXT_LINES).map((l) => l.line))
      } catch {
        // context is a nicety
      }
    }))
    const errorLines = errorBlock(groups, context).slice(0, lim.logLines)
    const budget = Math.max(0, lim.logLines - errorLines.length)
    const lines = streamLines(tail).filter((l) => l.line.trim()).map(fmtLine).slice(0, budget).reverse()
    if (errorLines.length || lines.length) {
      return {
        status: 'ok',
        data: { source: 'loki', query: base, errorLines, lines, exploreUrl: exploreUrl(links.grafana, { type: 'loki', uid: links.ds.loki }, base, lim.windowMinutes) },
      }
    }
  } catch (e) {
    lokiError = errMsg(e)
  }
  // Loki had nothing (or is down): the apiserver still has the current and previous container logs.
  const lines: string[] = []
  const errLines: Line[] = []
  const context = new Map<Line, string[]>()
  const per = Math.max(20, Math.floor(lim.logLines / Math.max(1, Math.min(3, r.pods.length))))
  for (const pod of r.pods.slice(0, 3)) {
    const s = summarizePod(pod)
    const c = s.containers.find((x) => x.restarts > 0 || x.lastTermination) ?? s.containers[0]
    if (!c) continue
    for (const previous of c.restarts > 0 ? [true, false] : [false]) {
      try {
        const text = await b.k8sText(`/api/v1/namespaces/${ns}/pods/${s.name}/log`, {
          container: c.name,
          tailLines: String(per),
          ...(previous ? { previous: 'true' } : {}),
        })
        const label = `${s.name}${previous ? ' (previous)' : ''}`
        const all = text.split('\n')
        all.forEach((raw, i) => {
          if (!raw.trim()) return
          if (ERROR_RE.test(raw) && !NOT_AN_ERROR.test(raw)) {
            const l = { ts: String(i), line: raw, pod: label }
            errLines.push(l)
            context.set(l, all.slice(i + 1, i + 1 + CONTEXT_LINES).filter((x) => x.trim() && !ERROR_RE.test(x)))
          } else lines.push(fmtLine({ line: raw, pod: label }))
        })
      } catch {
        // a container that never started has no log; keep going
      }
    }
  }
  const groups = groupErrors(errLines)
  const errorLines = errorBlock(groups, new Map(groups.slice(0, CONTEXT_ERRORS).map((g) => [g.first, context.get(g.first) ?? []])))
  const note = lokiError ? `Loki unavailable (${lokiError}); read from the Kubernetes API instead.` : 'Loki had no lines in the window; read from the Kubernetes API instead.'
  if (!lines.length && !errorLines.length) return { status: lokiError ? 'error' : 'empty', note: lokiError ? `Loki unavailable (${lokiError}) and the pods returned no log.` : 'No log lines in the window.' }
  return {
    status: 'ok',
    note,
    data: { source: 'apiserver', errorLines: errorLines.slice(0, lim.logLines), lines: lines.slice(-Math.max(0, lim.logLines - errorLines.length)) },
  }
}

/* ─────────────────────────── metrics ─────────────────────────── */

interface MetricQuery { title: string; expr: string; unit: MetricResult['unit'] }

export function metricQueries(r: Resolved, family: string, windowMinutes: number): MetricQuery[] {
  if (family === 'autoscaler') {
    return [
      { title: 'Pending pods', expr: 'sum(kube_pod_status_phase{phase="Pending"})', unit: 'count' },
      { title: 'Nodes', expr: 'count(kube_node_info)', unit: 'count' },
      { title: 'Not-ready nodes', expr: 'sum(kube_node_status_condition{condition="Ready",status!="true"})', unit: 'count' },
      { title: 'CPU requested / allocatable', expr: 'sum(kube_pod_container_resource_requests{resource="cpu"}) / sum(kube_node_status_allocatable{resource="cpu"})', unit: 'ratio' },
      { title: 'Memory requested / allocatable', expr: 'sum(kube_pod_container_resource_requests{resource="memory"}) / sum(kube_node_status_allocatable{resource="memory"})', unit: 'ratio' },
    ]
  }
  if (!r.namespace) return []
  const podNames = r.pods.map((p) => get<string>(p, 'metadata.name')).filter((n): n is string => !!n)
  const podRe = podNames.length ? podNames.map(reEscape).join('|') : r.app ? `${reEscape(r.app)}-.*` : ''
  if (!podRe) return []
  const sel = `namespace="${promStr(r.namespace)}",pod=~"${promStr(podRe)}"`
  const w = `${windowMinutes}m`
  const out: MetricQuery[] = [
    { title: `Container restarts (last ${w})`, expr: `sum by (pod) (increase(kube_pod_container_status_restarts_total{${sel}}[${w}]))`, unit: 'count' },
    { title: 'Last termination reason', expr: `sum by (pod, reason) (kube_pod_container_status_last_terminated_reason{${sel}}) > 0`, unit: 'raw' },
    { title: 'Waiting reason', expr: `sum by (pod, reason) (kube_pod_container_status_waiting_reason{${sel}}) > 0`, unit: 'raw' },
    { title: 'CPU used (cores, 5m rate)', expr: `sum by (pod) (rate(container_cpu_usage_seconds_total{${sel},container!=""}[5m]))`, unit: 'cores' },
    { title: 'CPU requested (cores)', expr: `sum by (pod) (kube_pod_container_resource_requests{${sel},resource="cpu"})`, unit: 'cores' },
    { title: `Peak memory working set (last ${w})`, expr: `max by (pod) (max_over_time(container_memory_working_set_bytes{${sel},container!=""}[${w}]))`, unit: 'bytes' },
    { title: 'Memory limit', expr: `sum by (pod) (kube_pod_container_resource_limits{${sel},resource="memory"})`, unit: 'bytes' },
    {
      title: 'HTTP 5xx ratio (5m)',
      expr: `(sum(rate(http_server_requests_seconds_count{${sel},status=~"5.."}[5m])) / sum(rate(http_server_requests_seconds_count{${sel}}[5m]))) or (sum(rate(http_requests_total{${sel},code=~"5.."}[5m])) / sum(rate(http_requests_total{${sel}}[5m])))`,
      unit: 'ratio',
    },
    {
      title: 'HTTP p95 latency (5m)',
      expr: `histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{${sel}}[5m]))) or histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${sel}}[5m])))`,
      unit: 'seconds',
    },
  ]
  const argoName = get<string>(r.argo, 'metadata.name')
  if (argoName) out.push({ title: 'Argo CD status', expr: `argocd_app_info{name="${promStr(argoName)}"}`, unit: 'raw' })
  return out
}

async function collectMetrics(r: Resolved, family: string, b: Backends, lim: EvidenceLimits, links: LinkBases): Promise<Evidence['metrics']> {
  const queries = metricQueries(r, family, lim.windowMinutes)
  if (!queries.length) return { status: 'skipped', note: 'No workload to query metrics for.' }
  const results = await Promise.all(queries.map(async (q): Promise<MetricResult> => {
    const exp = exploreUrl(links.grafana, { type: 'prometheus', uid: links.ds.prometheus }, q.expr, lim.windowMinutes)
    try {
      const samples = await b.prom(q.expr)
      return {
        ...q,
        exploreUrl: exp,
        values: samples.slice(0, 10).map((s) => {
          const { __name__: _n, job: _j, instance: _i, endpoint: _e, service: _s, uid: _u, ...labels } = s.metric
          return { labels, value: Number(s.value[1]) }
        }),
      }
    } catch (e) {
      return { ...q, exploreUrl: exp, values: [], error: errMsg(e) }
    }
  }))
  if (results.every((x) => x.error)) return { status: 'error', note: `Prometheus unavailable: ${results[0].error}`, data: { results } }
  return { status: results.some((x) => x.values.length) ? 'ok' : 'empty', data: { results } }
}

/* ─────────────────────────── traces ─────────────────────────── */

async function collectTraces(r: Resolved, b: Backends, lim: EvidenceLimits, links: LinkBases, now: number): Promise<Evidence['traces']> {
  if (lim.traceLimit <= 0) return { status: 'skipped', note: 'Trace collection is turned off.' }
  if (!r.app) return { status: 'skipped', note: 'No service name to search traces for.' }
  const svc = promStr(r.app)
  const q = `{ resource.service.name = "${svc}" && status = error }`
  const start = now - lim.windowMinutes * 60_000
  const exp = exploreUrl(links.grafana, { type: 'tempo', uid: links.ds.tempo }, q, lim.windowMinutes)
  try {
    const traces = await b.tempo(q, start, now, lim.traceLimit)
    if (traces.length) {
      return {
        status: 'ok',
        data: {
          query: q,
          exploreUrl: exp,
          traces: traces.slice(0, lim.traceLimit).map((t) => ({
            traceId: t.traceID,
            service: t.rootServiceName,
            name: t.rootTraceName,
            start: t.startTimeUnixNano ? new Date(Number(BigInt(t.startTimeUnixNano) / 1_000_000n)).toISOString() : undefined,
            durationMs: t.durationMs,
            url: exploreUrl(links.grafana, { type: 'tempo', uid: links.ds.tempo }, t.traceID, lim.windowMinutes),
          })),
        },
      }
    }
    // No error traces — is the service traced at all?
    const any = await b.tempo(`{ resource.service.name = "${svc}" }`, start, now, 1)
    return any.length
      ? { status: 'empty', note: `No error traces for ${r.app} in the last ${lim.windowMinutes} minutes.`, data: { query: q, traces: [], exploreUrl: exp } }
      : { status: 'empty', note: `No traces at all for service "${r.app}" in the last ${lim.windowMinutes} minutes — the service does not appear to be instrumented for tracing (OpenTelemetry → Alloy → Tempo).`, data: { query: q, traces: [], exploreUrl: exp } }
  } catch (e) {
    return { status: 'error', note: `Tempo unavailable: ${errMsg(e)}` }
  }
}

/* ─────────────────────────── delivery ─────────────────────────── */

async function collectDelivery(ref: IncidentRef, r: Resolved, b: Backends): Promise<Evidence['delivery']> {
  const out: NonNullable<Evidence['delivery']['data']> = {}
  const argo = r.argo
  if (argo) {
    const op = get<Obj>(argo, 'status.operationState')
    const info = get<Array<{ name?: string; value?: string }>>(op, 'operation.info') ?? []
    const by = get<{ username?: string; automated?: boolean }>(op, 'operation.initiatedBy')
    out.argo = {
      name: get<string>(argo, 'metadata.name') ?? '',
      namespace: get<string>(argo, 'metadata.namespace') ?? '',
      project: get<string>(argo, 'spec.project'),
      repo: get<string>(argo, 'spec.source.repoURL'),
      path: get<string>(argo, 'spec.source.path'),
      targetRevision: get<string>(argo, 'spec.source.targetRevision'),
      revision: get<string>(argo, 'status.sync.revision'),
      health: get<string>(argo, 'status.health.status'),
      healthMessage: get<string>(argo, 'status.health.message'),
      sync: get<string>(argo, 'status.sync.status'),
      lastOperation: op
        ? {
          phase: op.phase as string | undefined,
          message: typeof op.message === 'string' ? redactText(op.message).slice(0, 800) : undefined,
          startedAt: op.startedAt as string | undefined,
          finishedAt: op.finishedAt as string | undefined,
          initiatedBy: by?.username ?? (by?.automated ? 'auto-sync' : undefined),
          promotion: info.find((i) => i.name === 'kargo.akuity.io/promotion')?.value,
        }
        : undefined,
      images: (get<string[]>(argo, 'status.summary.images') ?? []).slice(0, 10),
    }
    out.commit = out.argo.revision
  }

  // Kargo: the promotion this incident is about, or the one that last synced the app.
  const promoName = ref.source === 'kargo-promotion' ? ref.name : out.argo?.lastOperation?.promotion
  let promo: Obj | undefined = ref.source === 'kargo-promotion' ? r.primary : undefined
  if (!promo && promoName) {
    const list = await tryGet(b, '/apis/kargo.akuity.io/v1alpha1/promotions', { fieldSelector: `metadata.name=${promoName}`, limit: '1' })
    promo = (list?.items as Obj[] | undefined)?.[0]
  }
  const kargo: NonNullable<typeof out.kargo> = {}
  if (promo) {
    const freight = get<Obj>(promo, 'status.freight')
    kargo.promotion = {
      name: get<string>(promo, 'metadata.name') ?? '',
      namespace: get<string>(promo, 'metadata.namespace') ?? '',
      phase: get<string>(promo, 'status.phase'),
      message: (() => {
        const m = get<string>(promo, 'status.message')
        return m ? redactText(m).slice(0, 800) : undefined
      })(),
      stage: get<string>(promo, 'spec.stage'),
      freight: get<string>(freight, 'name') ?? get<string>(promo, 'spec.freight'),
      images: ((freight?.images as Obj[] | undefined) ?? []).map((i) => `${i.repoURL ?? ''}${i.tag ? `:${i.tag}` : ''}${i.digest ? `@${i.digest}` : ''}`).slice(0, 5),
      commits: ((freight?.commits as Obj[] | undefined) ?? []).map((c) => `${c.repoURL ?? ''}@${c.id ?? c.tag ?? ''}`).slice(0, 5),
    }
    if (!out.commit) out.commit = ((freight?.commits as Obj[] | undefined)?.[0]?.id as string | undefined)
  }
  // The stage's latest verification (the failing metric's message is the useful bit).
  const stageNs = ref.source === 'kargo-verification' ? ref.namespace : kargo.promotion?.namespace ?? r.project
  const stageName = ref.source === 'kargo-verification' ? ref.name : kargo.promotion?.stage ?? r.env
  if (stageNs && stageName) {
    const stage = ref.source === 'kargo-verification' && r.primary
      ? r.primary
      : await tryGet(b, `/apis/kargo.akuity.io/v1alpha1/namespaces/${stageNs}/stages/${stageName}`)
    const ver = get<Obj[]>(stage, 'status.freightHistory.0.verificationHistory')?.[0]
    if (stage) {
      kargo.verification = {
        stage: `${stageNs}/${stageName}`,
        health: get<string>(stage, 'status.health.status'),
        issues: (get<string[]>(stage, 'status.health.issues') ?? []).slice(0, 5).map((i) => redactText(i).slice(0, 400)),
        phase: get<string>(ver, 'phase'),
        message: (() => {
          const m = get<string>(ver, 'message')
          return m ? redactText(m).slice(0, 800) : undefined
        })(),
        analysisRun: get<string>(ver, 'analysisRun.name'),
      }
    }
  }
  if (kargo.promotion || kargo.verification) out.kargo = kargo
  if (!out.argo && !out.kargo) return { status: 'skipped', note: 'No Argo CD application or Kargo stage is associated with this incident.' }
  return { status: 'ok', data: out }
}

/* ─────────────────────────── entry point ─────────────────────────── */

const settle = async <T>(p: Promise<T>, fallback: (e: unknown) => T): Promise<T> => {
  try {
    return await p
  } catch (e) {
    return fallback(e)
  }
}

/**
 * Every backend call raced against `ms`: the real backends carry their own
 * abort signals, but a backend that hangs anyway (a stuck DNS lookup, a
 * proxy that never answers) must cost one section, not the whole ticket.
 * Exported for tests.
 */
export function withDeadline(b: Backends, ms: number): Backends {
  const race = <T>(what: string, p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    })
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
  }
  return {
    k8s: (path, search) => race('Kubernetes API', b.k8s(path, search)),
    k8sText: (path, search) => race('Kubernetes API', b.k8sText(path, search)),
    loki: (q, s, e, l, d) => race('Loki', b.loki(q, s, e, l, d)),
    prom: (q) => race('Prometheus', b.prom(q)),
    tempo: (q, s, e, l) => race('Tempo', b.tempo(q, s, e, l)),
  }
}

/**
 * Collect everything for one incident. Never throws: every section reports its
 * own status, and a backend that fails or times out is named in that section.
 */
export async function collectEvidence(
  ref: IncidentRef,
  doc: NotificationDoc,
  lim: EvidenceLimits,
  b: Backends,
  links: LinkBases,
  now = Date.now(),
): Promise<Evidence> {
  b = withDeadline(b, lim.queryTimeoutMs)
  const r = await settle(resolveSubject(ref, doc, b), (e) => ({ pods: [], notes: [`Subject could not be resolved: ${errMsg(e)}`] }) as Resolved)
  const podNames = r.pods.map((p) => get<string>(p, 'metadata.name')).filter((n): n is string => !!n)

  const k8s = settle<Evidence['k8s']>((async () => {
    const objNs = get<string>(r.primary, 'metadata.namespace') ?? ref.namespace
    const objName = get<string>(r.primary, 'metadata.name') ?? ref.name
    const [objEvents, podEvents] = await Promise.all([
      objNs && objName ? eventsFor(b, objNs, [objName], lim.eventLimit) : Promise.resolve([]),
      r.namespace ? eventsFor(b, r.namespace, podNames, lim.eventLimit) : Promise.resolve([]),
    ])
    const events = [...objEvents, ...podEvents].slice(0, lim.eventLimit)
    const pods = r.pods.map(summarizePod)
    const object = trimObject(r.primary)
    const status: SectionStatus = object || events.length || pods.length ? 'ok' : 'empty'
    return { status, note: r.notes.join(' ') || undefined, data: { object, events, pods } }
  })(), (e) => ({ status: 'error', note: `Kubernetes API: ${errMsg(e)}` }))

  const [k8sS, logs, metrics, traces, delivery] = await Promise.all([
    k8s,
    settle(collectLogs(r, b, lim, links, now), (e) => ({ status: 'error' as const, note: errMsg(e) })),
    settle(collectMetrics(r, ref.family, b, lim, links), (e) => ({ status: 'error' as const, note: errMsg(e) })),
    settle(collectTraces(r, b, lim, links, now), (e) => ({ status: 'error' as const, note: errMsg(e) })),
    settle(collectDelivery(ref, r, b), (e) => ({ status: 'error' as const, note: errMsg(e) })),
  ])

  const argoName = delivery.data?.argo?.name
  const argoNs = delivery.data?.argo?.namespace
  const stage = delivery.data?.kargo?.verification?.stage ?? (delivery.data?.kargo?.promotion ? `${delivery.data.kargo.promotion.namespace}/${delivery.data.kargo.promotion.stage}` : undefined)
  const consoleHref = doc.href?.startsWith('/') && links.console ? `${links.console.replace(/\/$/, '')}${doc.href}` : doc.href?.startsWith('http') ? doc.href : undefined
  return {
    collectedAt: new Date(now).toISOString(),
    windowMinutes: lim.windowMinutes,
    subject: {
      family: ref.family,
      objectKind: ref.objectKind,
      namespace: ref.namespace,
      name: ref.name,
      app: r.app,
      env: r.env,
      project: r.project,
      workloadNamespace: r.namespace,
      pods: podNames,
    },
    k8s: k8sS,
    logs,
    metrics,
    traces,
    delivery,
    links: {
      console: consoleHref,
      argocd: argoName && links.argocd ? `${links.argocd.replace(/\/$/, '')}/applications/${argoNs}/${argoName}` : undefined,
      kargo: stage && links.kargo ? `${links.kargo.replace(/\/$/, '')}/project/${stage.split('/')[0]}/stage/${stage.split('/')[1]}` : undefined,
      grafana: links.grafana || undefined,
    },
  }
}
