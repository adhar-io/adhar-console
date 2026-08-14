import { env } from '@adhar-console/utils'
import { apiServerFetch } from '../k8s/gateway.ts'
import type { ToolDef } from './provider.ts'

/**
 * Read-only Kubernetes tools exposed to the model. Every tool runs against the
 * apiserver with the SIGNED-IN USER's token, so the AI can never see or do more
 * than the user's own RBAC allows. The only "write" tool, `propose_change`,
 * does NOT touch the cluster — it returns a manifest for the human to review
 * and apply. (Chosen policy: read + diagnose + propose only.)
 */

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'k8s_list',
      description: 'List Kubernetes resources of a kind. Returns names, namespaces and a brief status summary.',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: "API group, '' for core (e.g. 'apps', '')" },
          version: { type: 'string', description: "API version (e.g. 'v1')" },
          resource: { type: 'string', description: "Plural resource name (e.g. 'pods', 'deployments')" },
          namespace: { type: 'string', description: 'Namespace; omit for all/cluster-scoped' },
          labelSelector: { type: 'string' },
          fieldSelector: { type: 'string' },
        },
        required: ['version', 'resource'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_get',
      description: 'Get a single Kubernetes object (full manifest incl. spec + status).',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          version: { type: 'string' },
          resource: { type: 'string' },
          namespace: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['version', 'resource', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_logs',
      description: 'Read recent logs from a pod container (for diagnosing crashes/errors).',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          pod: { type: 'string' },
          container: { type: 'string' },
          tailLines: { type: 'number', description: 'default 200' },
          previous: { type: 'boolean', description: 'logs from the previous (crashed) container instance' },
        },
        required: ['namespace', 'pod'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_events',
      description: 'List Events, optionally scoped to one object (to explain scheduling/pull/health failures).',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          name: { type: 'string', description: 'involved object name' },
          kind: { type: 'string', description: 'involved object kind' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_discovery',
      description: 'List the API resource kinds available in the cluster (incl. CRDs).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_describe',
      description:
        'Describe one resource like `kubectl describe`: the object (metadata, spec highlights, status, conditions) plus its recent Events, in one call. Best first look at any single resource.',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: "API group, '' for core (e.g. 'apps', '')" },
          version: { type: 'string', description: "API version (e.g. 'v1')" },
          resource: { type: 'string', description: "Plural resource name (e.g. 'pods', 'deployments')" },
          namespace: { type: 'string', description: 'Namespace; omit for cluster-scoped' },
          name: { type: 'string' },
        },
        required: ['version', 'resource', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_pod_diagnostics',
      description:
        'Deep pod health check: phase, readiness, per-container state (waiting/terminated reasons like CrashLoopBackOff, ImagePullBackOff, OOMKilled), restart counts, last-state of crashed containers, and a distilled list of detected issues.',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          pod: { type: 'string' },
        },
        required: ['namespace', 'pod'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_workload_health',
      description:
        'Rollout health of a Deployment/StatefulSet/DaemonSet: desired vs ready/updated/available replicas, rollout conditions (e.g. ProgressDeadlineExceeded), and diagnostics for owned pods that have problems.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['deployment', 'statefulset', 'daemonset'], description: 'workload kind (lowercase)' },
          namespace: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['kind', 'namespace', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'k8s_events_scan',
      description:
        'Scan for Warning events across a namespace (or the whole cluster if namespace is omitted), grouped by reason + involved object with counts and latest messages. Good for "what is unhealthy right now?".',
      parameters: {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'omit to scan the entire cluster' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'argocd_app_status',
      description:
        'GitOps status of an ArgoCD Application (Application CR read via the apiserver): sync status/revision, health, last operation result, conditions, and any out-of-sync/unhealthy resources. Use when a workload is GitOps-managed (e.g. labeled app.kubernetes.io/instance or annotated argocd/app-name).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Application name' },
          namespace: { type: 'string', description: "Application's namespace (defaults to the platform ArgoCD namespace)" },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_change',
      description:
        'Propose a change to the cluster as a full manifest for the human to review and apply. Does NOT apply it. Use for fixes/edits you recommend.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'one-line description of the change and why' },
          manifest: { type: 'object', description: 'the complete desired object (apiVersion, kind, metadata, spec)' },
        },
        required: ['summary', 'manifest'],
      },
    },
  },
]

function root(group: string, version: string): string {
  return group ? `/apis/${group}/${version}` : `/api/${version}`
}

export interface ToolResult {
  /** JSON string fed back to the model. */
  content: string
  /** Set for propose_change → surfaced to the client for human approval. */
  proposal?: { summary: string; manifest: unknown }
}

/** Execute a tool call with the user's token. Never throws — returns an error string. */
export async function executeTool(name: string, argsJson: string, token: string): Promise<ToolResult> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson || '{}')
  } catch {
    return { content: JSON.stringify({ error: 'invalid tool arguments (not JSON)' }) }
  }
  try {
    switch (name) {
      case 'k8s_list': {
        const { group = '', version, resource, namespace, labelSelector, fieldSelector } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const q = new URLSearchParams()
        if (labelSelector) q.set('labelSelector', labelSelector)
        if (fieldSelector) q.set('fieldSelector', fieldSelector)
        q.set('limit', '200')
        const res = await apiServerFetch(token, `${root(group, version)}${ns}/${resource}`, { search: `?${q}` })
        const body = await res.json()
        const items = (body.items ?? []).map((o: KObj) => summarize(o))
        return { content: JSON.stringify({ count: items.length, items }) }
      }
      case 'k8s_get': {
        const { group = '', version, resource, namespace, name: n } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const res = await apiServerFetch(token, `${root(group, version)}${ns}/${resource}/${n}`)
        const body = await res.json()
        return { content: JSON.stringify(trim(body)) }
      }
      case 'k8s_logs': {
        const { namespace, pod, container, tailLines = 200, previous } = args as Record<string, unknown>
        const q = new URLSearchParams({ tailLines: String(tailLines), timestamps: 'true' })
        if (container) q.set('container', String(container))
        if (previous) q.set('previous', 'true')
        const res = await apiServerFetch(token, `/api/v1/namespaces/${namespace}/pods/${pod}/log`, { search: `?${q}` })
        const text = await res.text()
        return { content: text.slice(-8000) || '(no logs)' }
      }
      case 'k8s_events': {
        const { namespace, name: n, kind } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const q = new URLSearchParams()
        const sel: string[] = []
        if (n) sel.push(`involvedObject.name=${n}`)
        if (kind) sel.push(`involvedObject.kind=${kind}`)
        if (sel.length) q.set('fieldSelector', sel.join(','))
        const res = await apiServerFetch(token, `/api/v1${ns}/events`, { search: q.toString() ? `?${q}` : '' })
        const body = await res.json()
        const events = (body.items ?? []).map((e: KEvent) => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`,
          count: e.count,
          lastTimestamp: e.lastTimestamp,
        }))
        return { content: JSON.stringify({ count: events.length, events }) }
      }
      case 'k8s_discovery': {
        const [core, apis] = await Promise.all([
          apiServerFetch(token, '/api/v1').then((r) => r.json()),
          apiServerFetch(token, '/apis').then((r) => r.json()),
        ])
        const kinds = new Set<string>()
        for (const r of core.resources ?? []) if (!r.name.includes('/')) kinds.add(`core/${r.kind} (${r.name})`)
        for (const g of apis.groups ?? []) kinds.add(`${g.name}: ${g.preferredVersion?.groupVersion}`)
        return { content: JSON.stringify({ kinds: [...kinds] }) }
      }
      case 'k8s_describe': {
        const { group = '', version, resource, namespace, name: n } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const res = await apiServerFetch(token, `${root(group, version)}${ns}/${resource}/${n}`)
        if (!res.ok) return { content: JSON.stringify({ error: `get ${resource}/${n} failed (HTTP ${res.status})` }) }
        const obj = trim(await res.json())
        const events = await fetchEvents(token, namespace, n, obj.kind)
        return { content: describeText(obj, events) }
      }
      case 'k8s_pod_diagnostics': {
        const { namespace, pod } = args as Record<string, string>
        const res = await apiServerFetch(token, `/api/v1/namespaces/${namespace}/pods/${pod}`)
        if (!res.ok) return { content: JSON.stringify({ error: `get pod ${pod} failed (HTTP ${res.status})` }) }
        const p = (await res.json()) as KPod
        return { content: JSON.stringify(podDiagnostics(p)) }
      }
      case 'k8s_workload_health': {
        const { kind, namespace, name: n } = args as Record<string, string>
        const plural = { deployment: 'deployments', statefulset: 'statefulsets', daemonset: 'daemonsets' }[
          (kind ?? '').toLowerCase()
        ]
        if (!plural) return { content: JSON.stringify({ error: `unsupported kind "${kind}" (deployment|statefulset|daemonset)` }) }
        const res = await apiServerFetch(token, `/apis/apps/v1/namespaces/${namespace}/${plural}/${n}`)
        if (!res.ok) return { content: JSON.stringify({ error: `get ${plural}/${n} failed (HTTP ${res.status})` }) }
        const w = (await res.json()) as KWorkload
        return { content: JSON.stringify(await workloadHealth(token, plural, namespace, w)) }
      }
      case 'k8s_events_scan': {
        const { namespace } = args as Record<string, string>
        const ns = namespace ? `/namespaces/${namespace}` : ''
        const q = new URLSearchParams({ fieldSelector: 'type=Warning', limit: '500' })
        const res = await apiServerFetch(token, `/api/v1${ns}/events`, { search: `?${q}` })
        if (!res.ok) return { content: JSON.stringify({ error: `event scan failed (HTTP ${res.status})` }) }
        const body = await res.json()
        return { content: JSON.stringify(groupWarnings(body.items ?? [], namespace)) }
      }
      case 'argocd_app_status': {
        const { name: n, namespace } = args as Record<string, string>
        const ns = namespace || env('ARGOCD_NAMESPACE') || 'argocd'
        const res = await apiServerFetch(
          token,
          `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(ns)}/applications/${encodeURIComponent(n)}`,
        )
        if (res.status === 404) {
          return { content: JSON.stringify({ error: `ArgoCD Application "${n}" not found in namespace "${ns}"` }) }
        }
        if (!res.ok) return { content: JSON.stringify({ error: `get ArgoCD Application ${n} failed (HTTP ${res.status})` }) }
        const app = (await res.json()) as ArgoApp
        return { content: JSON.stringify(argoAppStatus(app)) }
      }
      case 'propose_change': {
        const summary = String((args as Record<string, unknown>).summary ?? 'Proposed change')
        const manifest = (args as Record<string, unknown>).manifest
        return {
          content: JSON.stringify({ status: 'proposed_for_human_review', summary }),
          proposal: { summary, manifest },
        }
      }
      default:
        return { content: JSON.stringify({ error: `unknown tool ${name}` }) }
    }
  } catch (e) {
    return { content: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }
  }
}

interface KObj {
  kind?: string
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> }
  status?: Record<string, unknown>
  spec?: Record<string, unknown>
}
interface KEvent {
  type?: string
  reason?: string
  message?: string
  count?: number
  lastTimestamp?: string
  involvedObject?: { kind?: string; name?: string }
}

function summarize(o: KObj): Record<string, unknown> {
  const s = o.status ?? {}
  return {
    name: o.metadata?.name,
    namespace: o.metadata?.namespace,
    phase: s.phase,
    ready: s.readyReplicas ?? s.numberReady,
    replicas: (o.spec as { replicas?: number })?.replicas,
    conditions: Array.isArray(s.conditions)
      ? (s.conditions as Array<{ type: string; status: string; reason?: string }>).map((c) => `${c.type}=${c.status}${c.reason ? `(${c.reason})` : ''}`)
      : undefined,
    created: o.metadata?.creationTimestamp,
  }
}

/** Drop noisy managedFields before feeding an object to the model. */
function trim(o: KObj): KObj {
  if (o.metadata && 'managedFields' in o.metadata) delete (o.metadata as Record<string, unknown>).managedFields
  return o
}

/* ─────────── diagnostic-tool helpers (all read-only) ─────────── */

async function fetchEvents(token: string, namespace?: string, name?: string, kind?: string): Promise<KEvent[]> {
  const ns = namespace ? `/namespaces/${namespace}` : ''
  const sel: string[] = []
  if (name) sel.push(`involvedObject.name=${name}`)
  if (kind) sel.push(`involvedObject.kind=${kind}`)
  const q = new URLSearchParams()
  if (sel.length) q.set('fieldSelector', sel.join(','))
  const res = await apiServerFetch(token, `/api/v1${ns}/events`, { search: q.toString() ? `?${q}` : '' })
  if (!res.ok) return []
  const body = await res.json().catch(() => ({}))
  return (body.items ?? []) as KEvent[]
}

/** kubectl-describe-style text: object summary + status + recent events. */
function describeText(o: KObj, events: KEvent[]): string {
  const lines: string[] = []
  const md = o.metadata ?? {}
  lines.push(`Name:       ${md.name ?? ''}`)
  if (md.namespace) lines.push(`Namespace:  ${md.namespace}`)
  if (o.kind) lines.push(`Kind:       ${o.kind}`)
  if (md.creationTimestamp) lines.push(`Created:    ${md.creationTimestamp}`)
  if (md.labels && Object.keys(md.labels).length) {
    lines.push(`Labels:     ${Object.entries(md.labels).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  const s = (o.status ?? {}) as Record<string, unknown>
  if (s.phase) lines.push(`Phase:      ${s.phase}`)
  if (Array.isArray(s.conditions)) {
    lines.push('Conditions:')
    for (const c of s.conditions as Array<{ type?: string; status?: string; reason?: string; message?: string }>) {
      lines.push(`  ${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}${c.message ? ` — ${c.message}` : ''}`)
    }
  }
  lines.push('Spec+Status (JSON):')
  lines.push(JSON.stringify({ spec: o.spec, status: o.status }).slice(0, 4000))
  lines.push('Events:')
  if (events.length === 0) lines.push('  <none>')
  for (const e of events.slice(-25)) {
    lines.push(`  ${e.type ?? ''}  ${e.reason ?? ''}  x${e.count ?? 1}  ${e.lastTimestamp ?? ''}  ${e.message ?? ''}`)
  }
  return lines.join('\n')
}

interface KContainerState {
  waiting?: { reason?: string; message?: string }
  running?: { startedAt?: string }
  terminated?: { reason?: string; exitCode?: number; finishedAt?: string; message?: string }
}
interface KContainerStatus {
  name?: string
  image?: string
  ready?: boolean
  started?: boolean
  restartCount?: number
  state?: KContainerState
  lastState?: KContainerState
}
interface KPod extends KObj {
  spec?: { nodeName?: string; containers?: Array<{ name?: string; image?: string }> } & Record<string, unknown>
  status?: {
    phase?: string
    reason?: string
    message?: string
    startTime?: string
    qosClass?: string
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
    containerStatuses?: KContainerStatus[]
    initContainerStatuses?: KContainerStatus[]
  } & Record<string, unknown>
}

function stateText(st?: KContainerState): string {
  if (!st) return 'unknown'
  if (st.waiting) return `waiting: ${st.waiting.reason ?? '?'}${st.waiting.message ? ` — ${st.waiting.message}` : ''}`
  if (st.terminated) {
    const t = st.terminated
    return `terminated: ${t.reason ?? '?'} (exit ${t.exitCode ?? '?'})${t.finishedAt ? ` at ${t.finishedAt}` : ''}`
  }
  if (st.running) return `running since ${st.running.startedAt ?? '?'}`
  return 'unknown'
}

/** Distill a pod into phase, container states and a list of detected issues. */
function podDiagnostics(p: KPod): Record<string, unknown> {
  const st = p.status ?? {}
  const issues: string[] = []
  const container = (c: KContainerStatus, init = false) => {
    const kind = init ? 'init container' : 'container'
    const w = c.state?.waiting?.reason
    const t = c.state?.terminated?.reason
    const lt = c.lastState?.terminated
    if (w) issues.push(`${kind} "${c.name}" is waiting: ${w}${c.state?.waiting?.message ? ` — ${c.state.waiting.message}` : ''}`)
    if (t && t !== 'Completed') issues.push(`${kind} "${c.name}" terminated: ${t} (exit ${c.state?.terminated?.exitCode ?? '?'})`)
    if (lt && lt.reason && lt.reason !== 'Completed') {
      issues.push(`${kind} "${c.name}" previously terminated: ${lt.reason} (exit ${lt.exitCode ?? '?'})${lt.reason === 'OOMKilled' ? ' — raise memory limits or fix a leak' : ''}`)
    }
    if ((c.restartCount ?? 0) > 0) issues.push(`${kind} "${c.name}" restarted ${c.restartCount} time(s)`)
    if (!init && c.ready === false && st.phase === 'Running') issues.push(`${kind} "${c.name}" is not ready (readiness probe failing?)`)
    return {
      name: c.name,
      image: c.image,
      ready: c.ready,
      restartCount: c.restartCount,
      state: stateText(c.state),
      lastState: c.lastState ? stateText(c.lastState) : undefined,
    }
  }
  const containers = (st.containerStatuses ?? []).map((c) => container(c))
  const initContainers = (st.initContainerStatuses ?? []).map((c) => container(c, true))
  for (const c of st.conditions ?? []) {
    if (c.type === 'PodScheduled' && c.status === 'False') issues.push(`unschedulable: ${c.reason ?? ''} — ${c.message ?? ''}`)
    if (c.type === 'Ready' && c.status === 'False' && st.phase !== 'Succeeded') issues.push(`pod not Ready${c.reason ? ` (${c.reason})` : ''}`)
  }
  if (st.phase === 'Failed') issues.push(`pod Failed${st.reason ? `: ${st.reason}` : ''}${st.message ? ` — ${st.message}` : ''}`)
  return {
    pod: p.metadata?.name,
    namespace: p.metadata?.namespace,
    phase: st.phase,
    reason: st.reason,
    node: p.spec?.nodeName,
    startTime: st.startTime,
    qosClass: st.qosClass,
    conditions: (st.conditions ?? []).map((c) => `${c.type}=${c.status}${c.reason ? `(${c.reason})` : ''}`),
    containers,
    initContainers: initContainers.length ? initContainers : undefined,
    issues: issues.length ? issues : ['none detected — pod looks healthy'],
  }
}

interface KWorkload extends KObj {
  spec?: {
    replicas?: number
    selector?: { matchLabels?: Record<string, string> }
  } & Record<string, unknown>
  status?: Record<string, unknown>
}

/** Desired-vs-actual rollout state + diagnostics for owned pods with problems. */
async function workloadHealth(
  token: string,
  plural: string,
  namespace: string,
  w: KWorkload,
): Promise<Record<string, unknown>> {
  const s = (w.status ?? {}) as Record<string, number | Array<Record<string, string>>>
  const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : undefined)
  const replicaSummary =
    plural === 'daemonsets'
      ? {
          desired: num('desiredNumberScheduled'),
          current: num('currentNumberScheduled'),
          ready: num('numberReady'),
          available: num('numberAvailable'),
          updated: num('updatedNumberScheduled'),
          misscheduled: num('numberMisscheduled'),
        }
      : {
          desired: w.spec?.replicas ?? 1,
          current: num('replicas'),
          ready: num('readyReplicas'),
          available: num('availableReplicas'),
          updated: num('updatedReplicas'),
          unavailable: num('unavailableReplicas'),
        }
  const conditions = Array.isArray(s.conditions)
    ? (s.conditions as Array<{ type?: string; status?: string; reason?: string; message?: string }>).map(
        (c) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ''}${c.message ? ` — ${c.message}` : ''}`,
      )
    : []
  const desired = replicaSummary.desired ?? 0
  const ready = replicaSummary.ready ?? 0
  const healthy = ready >= desired && desired > 0

  // Inspect owned pods via the workload's label selector; report only problem pods.
  let podIssues: Array<Record<string, unknown>> = []
  let podCount = 0
  const match = w.spec?.selector?.matchLabels
  if (match && Object.keys(match).length) {
    const sel = Object.entries(match).map(([k, v]) => `${k}=${v}`).join(',')
    const q = new URLSearchParams({ labelSelector: sel, limit: '100' })
    const res = await apiServerFetch(token, `/api/v1/namespaces/${namespace}/pods`, { search: `?${q}` })
    if (res.ok) {
      const body = await res.json().catch(() => ({}))
      const pods = (body.items ?? []) as KPod[]
      podCount = pods.length
      podIssues = pods
        .map((p) => podDiagnostics(p))
        .filter((d) => !(d.issues as string[])[0]?.startsWith('none detected'))
    }
  }

  return {
    workload: `${plural}/${w.metadata?.name}`,
    namespace,
    healthy,
    replicas: replicaSummary,
    conditions,
    generation: { observed: num('observedGeneration'), desired: (w.metadata as { generation?: number } | undefined)?.generation },
    pods: { total: podCount, withIssues: podIssues.length },
    podIssues: podIssues.slice(0, 10),
  }
}

/** Group Warning events by reason + involved object. */
function groupWarnings(items: KEvent[], namespace?: string): Record<string, unknown> {
  const groups = new Map<string, { reason: string; object: string; count: number; lastSeen?: string; message?: string }>()
  for (const e of items) {
    const object = `${e.involvedObject?.kind ?? '?'}/${e.involvedObject?.name ?? '?'}`
    const key = `${e.reason}|${object}`
    const g = groups.get(key) ?? { reason: e.reason ?? '?', object, count: 0 }
    g.count += e.count ?? 1
    if (!g.lastSeen || (e.lastTimestamp ?? '') > g.lastSeen) {
      g.lastSeen = e.lastTimestamp
      g.message = e.message
    }
    groups.set(key, g)
  }
  const sorted = [...groups.values()].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
  return {
    scope: namespace ? `namespace ${namespace}` : 'cluster-wide',
    warningGroups: sorted.length,
    groups: sorted.slice(0, 40),
  }
}

interface ArgoApp extends KObj {
  spec?: {
    project?: string
    source?: { repoURL?: string; path?: string; targetRevision?: string; chart?: string }
    destination?: { namespace?: string; server?: string; name?: string }
  } & Record<string, unknown>
  status?: {
    sync?: { status?: string; revision?: string }
    health?: { status?: string; message?: string }
    operationState?: { phase?: string; message?: string; finishedAt?: string; startedAt?: string }
    conditions?: Array<{ type?: string; message?: string }>
    resources?: Array<{ kind?: string; name?: string; namespace?: string; status?: string; health?: { status?: string; message?: string } }>
  } & Record<string, unknown>
}

/** Sync + health of an ArgoCD Application CR, flagging degraded/out-of-sync resources. */
function argoAppStatus(app: ArgoApp): Record<string, unknown> {
  const st = app.status ?? {}
  const problem = (st.resources ?? []).filter(
    (r) => (r.status && r.status !== 'Synced') || (r.health?.status && r.health.status !== 'Healthy'),
  )
  return {
    application: app.metadata?.name,
    project: app.spec?.project,
    source: app.spec?.source,
    destination: app.spec?.destination,
    sync: st.sync,
    health: st.health,
    lastOperation: st.operationState
      ? { phase: st.operationState.phase, message: st.operationState.message, finishedAt: st.operationState.finishedAt }
      : undefined,
    conditions: (st.conditions ?? []).map((c) => `${c.type}: ${c.message ?? ''}`),
    resourcesWithIssues: problem.slice(0, 20).map((r) => ({
      resource: `${r.kind}/${r.name}`,
      namespace: r.namespace,
      sync: r.status,
      health: r.health?.status,
      message: r.health?.message,
    })),
  }
}
