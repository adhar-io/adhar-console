import { env } from '@adhar/utils'
import { orgOfLabels } from '../graph/model.ts'
import { apiServerFetch } from '../k8s/gateway.ts'
import { type KubeObject, objectKey, runWatch, type WatchHandlers, type WatchSpec } from '../k8s/sa-watch.ts'
import { emitNotificationResult, type NotificationDoc } from '../notify.ts'
import { getK8sServiceToken } from '../tool-registry.ts'
import { getKeycloakAdmin } from '../workspace/keycloak-admin.ts'
import { openStore } from '../workspace/store.ts'
import { type ApprovalAsk, LABEL, nodesOf, pendingApprovals, type WfObject } from './model.ts'

/**
 * The workflow recorder (design 0026 §7.4, §6.10; W1-C4): Argo Workflows'
 * lifecycle and approvals → the Notification Center.
 *
 * Two watches, as the console's own ServiceAccount (like
 * `events/platform-events.ts` — this runs with no request in flight):
 *
 *   - **Lifecycle**: every Workflow, cluster-wide, METADATA ONLY
 *     (`Accept: …;as=PartialObjectMetadata`). The phase is Argo's own label
 *     `workflows.argoproj.io/phase` (F-10), so not one byte of status is
 *     streamed for the thousands of updates a busy controller makes. A run
 *     that turns Failed or Error notifies its submitter; a scheduled or
 *     event-triggered run (no person submitted it) notifies its namespace's
 *     organisation.
 *   - **Approvals**: `adhar.io/has-approvals=true,workflows.argoproj.io/completed=false`,
 *     full objects (the nodes are needed). Each newly waiting approval node
 *     notifies its eligible approvers — the node's `approvers` input, resolved
 *     to Keycloak users; no approvers listed = the organisation.
 *
 * Not Kubernetes Events: upstream says they "can be lost or rolled up" and
 * must not drive automation [S12]. Labels on a resumable watch can.
 *
 * Every notification carries a DETERMINISTIC key — `sha256(uid + ":" + phase)`
 * (or `+ ":" + nodeId` for an approval), first 32 hex characters — so a
 * recorder restart that re-sees a transition is de-duplicated by
 * `emitNotification` rather than notifying twice (INV-10). The same id is the
 * CloudEvent id when the bus arrives (W4); nothing here publishes yet.
 *
 * One replica only: the console runs one (`install.yaml` replicas: 1). Before
 * that changes the recorder must hold a Lease (`adhar-console-recorder`), or
 * every notification doubles (§12 R-7) — the key de-duplication softens that
 * but is a 6-hour window, not a guarantee.
 *
 * RBAC: the console ServiceAccount needs list + watch on
 * `workflows.argoproj.io` through the platform's `console-event-watcher`
 * ClusterRole. Without it (or without the CRD) the watch disables itself and
 * is retried every ten minutes, so enabling Argo Workflows needs no console
 * restart.
 */

/**
 * Metadata-only LIST: `PartialObjectMetadataList`, plain JSON as the fallback
 * (what client-go's metadata client sends for a list).
 */
export const METADATA_LIST_ACCEPT = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json'
/**
 * Metadata-only WATCH: `PartialObjectMetadata`, and never the List kind — the
 * API server takes the first transform named, and a watch negotiated as
 * `PartialObjectMetadataList` answers 200 and streams nothing (verified on
 * kube-apiserver 1.36.2), which would leave this recorder blind between
 * relists.
 */
export const METADATA_WATCH_ACCEPT = 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1,application/json'

export const LIFECYCLE_WATCH: WatchSpec = {
  id: 'workflows-lifecycle',
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflows',
  limit: 5000,
  headers: { accept: METADATA_LIST_ACCEPT },
  watchHeaders: { accept: METADATA_WATCH_ACCEPT },
}

export const APPROVALS_WATCH: WatchSpec = {
  id: 'workflows-approvals',
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'workflows',
  limit: 500,
  search: { labelSelector: `${LABEL.hasApprovals}=true,${LABEL.completed}=false` },
}

const PLATFORM_TENANT = 'default'
const RETRY_DISABLED_MS = 10 * 60_000
const NAMESPACE_REFRESH_MS = 5 * 60_000
const MAX_TRACKED = 20_000

/* ─────────────────────────── pure ─────────────────────────── */

/** A notification before it is stamped with a time and an audience. */
export type Notice = Pick<NotificationDoc, 'kind' | 'source' | 'title' | 'description' | 'href' | 'key' | 'severity' | 'target' | 'prompt'>

/** `sha256(parts.join(":"))`, first 32 hex characters — the deterministic event id. */
export async function eventId(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join(':')))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export type Trigger = 'manual' | 'cron' | 'event' | 'resubmit'

/** How a run came to be, from Argo's labels. */
export function triggerOf(labels: Record<string, string>): Trigger {
  if (labels[LABEL.cron]) return 'cron'
  if (labels[LABEL.eventBinding]) return 'event'
  if (labels[LABEL.resubmittedFrom]) return 'resubmit'
  return 'manual'
}

/** The console's run page for a run (design 0026 §6.1). */
export function runHref(namespace: string, name: string, nodeId?: string): string {
  const q = new URLSearchParams({ section: 'workflow-runs', run: `${namespace}/${name}` })
  if (nodeId) q.set('node', nodeId)
  return `/platform?${q}`
}

export interface RunMeta {
  uid: string
  namespace: string
  name: string
  phase: string
  labels: Record<string, string>
  annotations: Record<string, string>
}

export function runMetaOf(o: KubeObject): RunMeta | null {
  const md = o.metadata
  if (!md?.uid || !md.name || !md.namespace) return null
  const labels = md.labels ?? {}
  return { uid: md.uid, namespace: md.namespace, name: md.name, phase: labels[LABEL.phase] ?? '', labels, annotations: md.annotations ?? {} }
}

/**
 * Who should hear that a run failed: the PERSON who submitted it, or — for a
 * schedule, a trigger, or a run a ServiceAccount started — nobody in
 * particular (the organisation).
 */
export function failureRecipient(m: RunMeta): string | undefined {
  const t = triggerOf(m.labels)
  if (t === 'cron' || t === 'event') return undefined
  const who = m.annotations['adhar.io/submitted-by'] || m.labels[LABEL.creatorUsername] || undefined
  // `system:serviceaccount:…`, `system:admin` — not a person to notify.
  return who && !/^system:/i.test(who) ? who : undefined
}

/** The notification for a run that just went Failed / Error; null for any other phase. */
export function failureNotification(m: RunMeta, id: string): Notice | null {
  if (m.phase !== 'Failed' && m.phase !== 'Error') return null
  const t = triggerOf(m.labels)
  const template = m.labels[LABEL.template] || m.labels[LABEL.clusterTemplate]
  const cron = m.labels[LABEL.cron]
  const what = cron ? `Scheduled run of ${cron}` : template ? `Run of ${template}` : `Workflow ${m.name}`
  return {
    kind: 'error',
    source: 'platform',
    severity: t === 'cron' || t === 'event' ? 'high' : 'medium',
    title: `${what} ${m.phase === 'Error' ? 'errored' : 'failed'}`,
    description: `${m.namespace}/${m.name}${template ? ` · template ${template}` : ''} · ${t === 'manual' ? 'started by hand' : t === 'resubmit' ? 'resubmitted' : t === 'cron' ? 'from a schedule' : 'from a trigger'}`,
    href: runHref(m.namespace, m.name),
    key: `workflow:${id}`,
    target: { type: 'workflow', id: `${m.namespace}/${m.name}`, label: `${m.namespace}/${m.name}` },
    prompt: `Argo Workflow ${m.namespace}/${m.name} ${m.phase === 'Error' ? 'errored' : 'failed'}. Find the failing step, read its logs and explain the cause.`,
  }
}

/** The notification for a newly waiting approval. */
export function approvalNotification(w: WfObject, ask: ApprovalAsk, id: string): Notice {
  const ns = w.metadata?.namespace ?? ''
  const name = w.metadata?.name ?? ''
  return {
    kind: 'warning',
    source: 'platform',
    severity: 'medium',
    title: `Approval requested: ${ask.question || `${ns}/${name}`}`,
    description: `${ns}/${name}${ask.approvers.length ? ` · approvers: ${ask.approvers.join(', ')}` : ''}${ask.forbidSelfApproval ? ' · the submitter may not approve' : ''}`,
    href: runHref(ns, name, ask.nodeId),
    key: `workflow-approval:${id}`,
    target: { type: 'workflow', id: `${ns}/${name}`, label: `${ns}/${name}` },
  }
}

/* ─────────────────────────── the recorder ─────────────────────────── */

export interface RecorderDeps {
  /** Deliver one notification into `tenant`. */
  emit(tenant: string, doc: NotificationDoc): Promise<void>
  tenantOf(namespace: string): string
  /** Keycloak user ids for user names / emails; [] when none resolve (or no Keycloak). */
  usersByName(names: string[]): Promise<string[]>
  /** Keycloak user ids of the members of these groups. */
  groupMembers(groups: string[]): Promise<string[]>
  now(): number
  log?(msg: string): void
}

/**
 * The recorder's state machine, separated from the watches so it can be
 * driven by fixtures. `lifecycle` and `approvals` are the two sources'
 * `WatchHandlers`.
 */
export class WorkflowRecorder {
  readonly #deps: RecorderDeps
  /** Last phase seen per run uid. */
  readonly #phase = new Map<string, string>()
  /** Approval nodes already announced (`uid:nodeId`). */
  readonly #asked = new Set<string>()

  constructor(deps: RecorderDeps) {
    this.#deps = deps
  }

  #log(msg: string): void {
    ;(this.#deps.log ?? console.warn)(msg)
  }

  get tracked(): number {
    return this.#phase.size
  }

  /** True when `phase` is news for `uid`; the first sighting during priming is a baseline, not news. */
  #transition(uid: string, phase: string, priming: boolean): boolean {
    const prev = this.#phase.get(uid)
    if (prev === phase) return false
    if (this.#phase.size >= MAX_TRACKED && prev === undefined) {
      const oldest = this.#phase.keys().next().value
      if (oldest !== undefined) this.#phase.delete(oldest)
    }
    this.#phase.delete(uid)
    this.#phase.set(uid, phase)
    return !priming
  }

  async onRun(o: KubeObject, priming: boolean): Promise<void> {
    const m = runMetaOf(o)
    if (!m || !m.phase) return
    if (!this.#transition(m.uid, m.phase, priming)) return
    const doc = failureNotification(m, await eventId(m.uid, m.phase))
    if (!doc) return
    const who = failureRecipient(m)
    const audience = who ? await this.#deps.usersByName([who]).catch(() => []) : []
    // A notification with no audience goes to EVERYONE in the tenant
    // (notify.ts). One meant for a person who cannot be resolved (Keycloak
    // down, a renamed user) is dropped, never widened to the whole
    // organisation: teams are isolation units, and a run name is theirs.
    if (who && !audience.length) {
      this.#log(`[workflows] run ${m.namespace}/${m.name} ${m.phase}: submitter ${who} did not resolve to a user — not notified`)
      return
    }
    await this.#deps.emit(this.#deps.tenantOf(m.namespace), { ...doc, ...(audience.length ? { audience } : {}), at: new Date(this.#deps.now()).toISOString() })
  }

  onRunGone(o: KubeObject): void {
    this.#phase.delete(objectKey(o))
  }

  onResync(seen: Set<string>): void {
    for (const k of [...this.#phase.keys()]) if (!seen.has(k)) this.#phase.delete(k)
  }

  async onApprovals(o: KubeObject): Promise<void> {
    const w = o as unknown as WfObject
    const uid = w.metadata?.uid
    if (!uid || !w.metadata?.namespace) return
    const nodes = await nodesOf(w)
    if (!nodes) return
    for (const ask of pendingApprovals(nodes, w)) {
      const k = `${uid}:${ask.nodeId}`
      if (this.#asked.has(k)) continue
      const audience = await this.#approverIds(ask).catch(() => [])
      // Named approvers who resolve to nobody: not a broadcast (an empty
      // audience is "everyone in the tenant"). Not marked as asked either, so
      // the next sighting of the run tries again.
      if (ask.approvers.length && !audience.length) {
        this.#log(`[workflows] approval ${w.metadata.namespace}/${w.metadata.name} node ${ask.nodeId}: approvers ${ask.approvers.join(', ')} resolved to no user — not announced yet`)
        continue
      }
      if (this.#asked.size >= MAX_TRACKED) {
        const oldest = this.#asked.values().next().value
        if (oldest !== undefined) this.#asked.delete(oldest)
      }
      this.#asked.add(k)
      const doc = approvalNotification(w, ask, await eventId(uid, ask.nodeId))
      await this.#deps.emit(this.#deps.tenantOf(w.metadata.namespace), { ...doc, ...(audience.length ? { audience } : {}), at: new Date(this.#deps.now()).toISOString() })
    }
  }

  async #approverIds(ask: ApprovalAsk): Promise<string[]> {
    if (!ask.approvers.length) return []
    const strip = (s: string) => s.replace(/^(group|user):/i, '').replace(/^oidc:/i, '')
    const groups = ask.approvers.filter((a) => !/^user:/i.test(a)).map(strip)
    const users = ask.approvers.filter((a) => !/^group:/i.test(a)).map(strip)
    const [g, u] = await Promise.all([this.#deps.groupMembers(groups).catch(() => []), this.#deps.usersByName(users).catch(() => [])])
    return [...new Set([...g, ...u])]
  }

  lifecycle(): WatchHandlers {
    return {
      upsert: (o, { priming }) => this.onRun(o, priming),
      remove: (o) => this.onRunGone(o),
      resynced: (seen) => this.onResync(seen),
    }
  }

  approvals(): WatchHandlers {
    // Approvals are announced even while priming: one that started waiting
    // while the console was down is still waiting for someone, and the
    // deterministic key keeps a restart from announcing it twice.
    return {
      upsert: (o) => this.onApprovals(o),
      remove: () => {},
    }
  }
}

/* ─────────────────────────── wiring ─────────────────────────── */

let nsToTenant = new Map<string, string>()
let nsLoadedAt = 0

async function refreshNamespaces(token: string): Promise<void> {
  if (Date.now() - nsLoadedAt < NAMESPACE_REFRESH_MS) return
  try {
    const res = await apiServerFetch(token, '/api/v1/namespaces', { search: '?limit=2000' })
    if (!res.ok) {
      await res.body?.cancel()
      return
    }
    const body = (await res.json()) as { items?: KubeObject[] }
    const next = new Map<string, string>()
    for (const ns of body.items ?? []) {
      const slug = orgOfLabels(ns.metadata?.labels)
      if (slug && ns.metadata?.name) next.set(ns.metadata.name, slug)
    }
    nsToTenant = next
    nsLoadedAt = Date.now()
  } catch {
    // keep the previous map
  }
}

function liveDeps(): RecorderDeps {
  const kc = () => getKeycloakAdmin()
  return {
    emit: async (tenant, doc) => {
      const store = await openStore(tenant).catch(() => null)
      if (!store) return
      await emitNotificationResult(store, doc, 'system')
    },
    tenantOf: (ns) => nsToTenant.get(ns) ?? PLATFORM_TENANT,
    usersByName: async (names) => {
      const k = kc()
      if (!k) return []
      const ids = await Promise.all(names.map(async (raw) => {
        const n = raw.replace(/^oidc:/i, '').replace(/^system:serviceaccount:.*$/, '')
        if (!n) return null
        const u = n.includes('@') ? await k.findUserByEmail(n.toLowerCase()) : await k.findUserByUsername(n)
        return u?.id ?? null
      }))
      return ids.filter((x): x is string => Boolean(x))
    },
    groupMembers: async (groups) => {
      const k = kc()
      if (!k) return []
      const lists = await Promise.all(groups.map((g) => k.listGroupMembers(g).catch(() => ({ members: [] }))))
      return lists.flatMap((l) => l.members.map((m) => m.id))
    },
    now: Date.now,
  }
}

/**
 * Load the namespace → organisation map, then start the watches — in that
 * order, whatever the load's outcome (a failed load keeps the previous map and
 * must not keep the recorder off).
 */
export async function tenantsThenWatches(loadTenants: () => Promise<void>, startWatches: () => void, stopped: () => boolean): Promise<void> {
  await loadTenants().catch(() => {})
  if (!stopped()) startWatches()
}

/** Start both watches; returns the stop function. Off (once, loudly) without a ServiceAccount token. */
export function startWorkflowRecorder(): () => void {
  if (env('ADHAR_EVENTS_DISABLED') === 'true' || env('ADHAR_WORKFLOWS_RECORDER_DISABLED') === 'true') {
    console.log('[workflows] recorder disabled by environment')
    return () => {}
  }
  const token = getK8sServiceToken()
  if (!token) {
    console.log('[workflows] no ServiceAccount token — workflow notifications are off')
    return () => {}
  }
  let stopped = false
  const isStopped = () => stopped
  const recorder = new WorkflowRecorder(liveDeps())
  const nsTimer = setInterval(() => void refreshNamespaces(token), NAMESPACE_REFRESH_MS)
  const log = (m: string) => console.log(m.replace('[watch]', '[workflows]'))

  // runWatch returns when the source is disabled (no CRD, no RBAC). Argo
  // Workflows is opt-in, so look again later instead of giving up for the
  // life of the process.
  const loop = async (spec: WatchSpec, handlers: WatchHandlers) => {
    while (!stopped) {
      await runWatch(spec, token, handlers, isStopped, log).catch((e) => log(`[watch] ${spec.id}: ${e}`))
      for (let waited = 0; waited < RETRY_DISABLED_MS && !stopped; waited += 5_000) {
        await new Promise((r) => setTimeout(r, 5_000))
      }
    }
  }
  // The namespace → organisation map FIRST: approvals are announced while
  // priming, and one routed before the map exists lands in the platform
  // tenant — and, being keyed and remembered, is never sent to the right one.
  void tenantsThenWatches(() => refreshNamespaces(token), () => {
    void loop(LIFECYCLE_WATCH, recorder.lifecycle())
    void loop(APPROVALS_WATCH, recorder.approvals())
  }, isStopped)
  console.log('[workflows] recorder started (lifecycle metadata watch + approvals watch)')
  return () => {
    stopped = true
    clearInterval(nsTimer)
  }
}
