import { apiServerFetch } from '../k8s/gateway.ts'
import { getK8sServiceToken } from '../tool-registry.ts'
import { emitNotificationResult, type NotificationDoc } from '../notify.ts'
import { observeNotification } from '../support/service.ts'
import { orgOfLabels } from '../graph/model.ts'
import { openStore } from '../workspace/store.ts'
import { env } from '@adhar/utils'
import { runWatch, type WatchSpec } from '../k8s/sa-watch.ts'
import { condition, get, type KubeObject, labelsOf, links, nameOf, nsOf, type Signal, type SignalContext, type Source } from './signal-kit.ts'
import { argoDisplay, DELIVERY_SOURCES, freightAliasOf } from './delivery-sources.ts'
import { CONTROL_PLANE_SOURCES } from './control-plane-sources.ts'

/**
 * Platform events → notifications, with nobody pressing a button.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO MESSAGE BROKER HERE
 * ---------------------------------------------------------------------------
 * The obvious instinct is to put NATS (or Kafka, both of which this platform
 * can install) between the platform and the console. It would be the wrong
 * dependency, because it would not be the source of truth for anything it
 * carried.
 *
 * Every signal that matters here — a deploy going out, a sync degrading, a
 * pipeline failing, a pod being OOMKilled, a policy refusing an admission —
 * is ALREADY a state transition on a Kubernetes object, and the apiserver
 * already offers an ordered, resumable, RBAC-filtered stream of exactly those
 * transitions with `?watch=1`. A broker in front of it would mean running and
 * operating another stateful component, teaching every producer to publish to
 * it, and then reconciling its contents against the apiserver anyway when the
 * two disagreed — which they would, because the apiserver is what actually
 * decides. Watching is not polling: it is the same push semantics a broker
 * would give, from the component that owns the truth.
 *
 * A broker earns its place when there are events with NO other home — a
 * webhook from a SaaS, an application's own domain events, fan-out to
 * consumers outside the cluster. Argo Events (which embeds NATS) is already
 * installed for that shape of problem. When the console needs those, they
 * arrive at `POST /api/notifications`, which exists and is authenticated. This
 * file covers the platform's own state, and for that the apiserver is the bus.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 * One watch per source, cluster-wide, authenticated as the console's own
 * ServiceAccount (not any user's token — this runs with no request in flight).
 * Each source maps an object to a small "signature" of the state a human would
 * care about; a notification is emitted only when that signature CHANGES, so a
 * resync or a no-op update writes nothing.
 *
 * Tenancy is resolved per object from its namespace: the provisioner labels
 * every tenant namespace `adhar.io/org=<slug>`, so the namespace→tenant map is
 * read from the apiserver and refreshed on a timer. An event in a namespace
 * with no such label belongs to the platform itself and lands in the default
 * tenant, where only platform operators are looking.
 *
 * It fails quiet and visible: with no ServiceAccount token it logs once and
 * stays off. It never invents an event.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COVERS
 * ---------------------------------------------------------------------------
 * The sources below are the platform's health (Argo CD health, Tekton
 * outcomes, Warning events). `delivery-sources.ts` covers the delivery
 * lifecycle — Argo CD sync operations, Kargo freight / promotions / stage
 * verification, Argo Rollouts — and `control-plane-sources.ts` the control
 * plane and the cluster: every `platform.adhar.io` XR created / ready / failed
 * / deleted, nodes joining and leaving, the node autoscaler's decisions and
 * the resilience gate. Every resource watched here must be granted to the
 * console ServiceAccount by the `console-event-watcher` ClusterRole in the
 * platform repo (`TestConsoleWatchedResourcesAreGranted` reads these files).
 */

/* ─────────────────────────── configuration ─────────────────────────── */

/** Tenant that owns un-labelled (platform) namespaces. */
const PLATFORM_TENANT = 'default'

/** How often the namespace→tenant map is re-read. */
const NAMESPACE_REFRESH_MS = 5 * 60_000

/**
 * Warning `Event` reasons worth waking someone for.
 *
 * An allowlist, not a filter on severity: `type=Warning` alone is a firehose
 * (readiness probes, image pulls retrying, scheduler churn) and a notification
 * feed that reproduces it is one nobody reads. These are the reasons that mean
 * something is actually stuck rather than merely slow.
 */
const EVENT_REASONS = new Set([
  'OOMKilling',
  'Evicted',
  'FailedScheduling',
  'FailedMount',
  'FailedAttachVolume',
  'FailedCreatePodSandBox',
  'NodeNotReady',
  'BackOff',
  'FailedCreate',
  'Unhealthy',
])

/** Reasons that are only interesting after repeating — a single blip is noise. */
const EVENT_MIN_COUNT: Record<string, number> = { BackOff: 3, Unhealthy: 5, FailedMount: 2 }

/* ─────────────────────────── helpers ─────────────────────────── */

/**
 * Tracking key for one object AS SEEN BY ONE SOURCE. Several sources read the
 * same object (Argo CD health and Argo CD sync operations are both
 * Applications); keyed by uid alone, each would overwrite the other's last
 * signature and both would re-notify on every update.
 */
const keyOf = (sourceId: string, o: KubeObject) => `${sourceId}:${o.metadata?.uid ?? `${nsOf(o)}/${nameOf(o)}`}`

/* ─────────────────────────── the sources ─────────────────────────── */

/** Exported for tests: the signal functions are pure and worth exercising. */
export const SOURCES: Source[] = [
  /**
   * Argo CD Applications — the platform's delivery state.
   *
   * Health and sync together: "Degraded" is the alarm, "Synced + Healthy after
   * being anything else" is the all-clear people actually want, and an
   * OutOfSync application that is still Healthy is a drift notice, not an
   * incident.
   */
  {
    id: 'argocd',
    group: 'argoproj.io',
    version: 'v1alpha1',
    resource: 'applications',
    signal(obj) {
      const health = get<string>(obj, 'status.health.status') ?? 'Unknown'
      const sync = get<string>(obj, 'status.sync.status') ?? 'Unknown'
      const name = nameOf(obj)
      // Titles name the app ("qua-service (dev)"), not the Argo CD object
      // (`adhar-qua-service-dev`); the link still opens the Argo CD app.
      const display = argoDisplay(obj).display
      const href = links.argoApp(name)
      const target = { type: 'application', id: name, label: display }
      const base = { source: 'gitops' as const, target, href, key: `argocd:${nsOf(obj)}/${name}:${health}/${sync}` }

      if (health === 'Degraded' || health === 'Missing') {
        return {
          signature: `${health}/${sync}`,
          doc: {
            ...base,
            kind: 'error',
            severity: 'high',
            title: `${display} is ${health.toLowerCase()}`,
            description: get<string>(obj, 'status.health.message') ?? `Argo CD reports the application as ${health}, sync ${sync}.`,
            prompt: `Argo CD application ${name} is ${health}. Diagnose why and tell me what to do about it.`,
          },
        }
      }
      if (health === 'Healthy' && sync === 'Synced') {
        return {
          signature: `${health}/${sync}`,
          doc: { ...base, kind: 'success', title: `${display} is synced and healthy`, description: `Revision ${(get<string>(obj, 'status.sync.revision') ?? '').slice(0, 7) || 'unknown'} is live.` },
        }
      }
      if (sync === 'OutOfSync') {
        return {
          signature: `${health}/${sync}`,
          doc: {
            ...base,
            kind: 'warning',
            severity: 'medium',
            title: `${display} has drifted from Git`,
            description: 'The live state no longer matches the desired state in the repository.',
            prompt: `Argo CD application ${name} is OutOfSync. What drifted, and should I sync it?`,
          },
        }
      }
      return null
    },
  },

  /**
   * Tekton PipelineRuns — CI starts and outcomes.
   *
   * A start is a low-priority "build of X started"; every in-flight reason
   * (Started, Running, PipelineRunPending) is ONE signature, so a run reports
   * its start once however its reason churns. The outcome replaces it. The
   * priming list baselines runs already in flight, so a console restart does
   * not re-announce them.
   */
  {
    id: 'tekton',
    group: 'tekton.dev',
    version: 'v1',
    resource: 'pipelineruns',
    signal(obj) {
      const cond = condition(obj, 'Succeeded')
      const name = nameOf(obj)
      const ns = nsOf(obj)
      const l = labelsOf(obj)
      const subject = l['adhar.io/app'] ?? l['adhar.io/application'] ?? l['adhar.io/library']
      const what = subject ? `Build of ${subject}` : `Pipeline ${name}`
      const base = {
        source: 'platform' as const,
        href: links.build(ns, name),
        target: { type: 'pipelinerun', id: `${ns}/${name}`, label: subject ? `${subject} · ${name}` : name },
      }
      if (!obj.status || !cond?.status || cond.status === 'Unknown') {
        // A run Tekton has not picked up yet has no condition at all.
        return {
          signature: 'running',
          doc: { ...base, kind: 'info', severity: 'low', title: `${what} started`, description: l['tekton.dev/pipeline'] ? `Pipeline ${l['tekton.dev/pipeline']} · run ${name}` : undefined, key: `tekton:${ns}/${name}:started` },
        }
      }
      const ok = cond.status === 'True'
      return {
        signature: `${cond.status}/${cond.reason ?? ''}`,
        doc: {
          ...base,
          kind: ok ? 'success' : 'error',
          severity: ok ? 'low' : 'high',
          title: ok ? `${what} succeeded` : `${what} failed`,
          description: cond.message ?? cond.reason,
          key: `tekton:${ns}/${name}:${cond.status}`,
          ...(ok ? {} : { prompt: `Tekton PipelineRun ${ns}/${name} failed: ${cond.reason ?? 'unknown reason'}. Find the failing task and its logs, and explain the cause.` }),
        },
      }
    },
  },

  /**
   * Kubernetes Warning events — the cluster itself complaining.
   *
   * `fieldSelector=type=Warning` narrows it at the apiserver so the console
   * never receives the Normal firehose, and EVENT_REASONS narrows it again to
   * the ones that mean something is stuck. The event's own `count` is part of
   * the signature, so a recurring problem re-notifies as it escalates — but
   * `emitNotification`'s 6-hour de-duplication on `key` keeps that to a
   * trickle rather than one per occurrence.
   */
  {
    id: 'k8s-events',
    group: '',
    version: 'v1',
    resource: 'events',
    search: { fieldSelector: 'type=Warning' },
    signal(obj) {
      const reason = get<string>(obj, 'reason') ?? ''
      if (!EVENT_REASONS.has(reason)) return null
      const count = get<number>(obj, 'count') ?? 1
      if (count < (EVENT_MIN_COUNT[reason] ?? 1)) return null

      const involved = get<{ kind?: string; name?: string; namespace?: string }>(obj, 'involvedObject') ?? {}
      const subject = `${involved.kind ?? 'Object'}/${involved.name ?? '?'}`
      const ns = involved.namespace ?? nsOf(obj)
      // Bucket the count so an event firing 40 times does not produce 40
      // distinct signatures — it should re-notify at 1, 10, 100, not at each.
      const bucket = count >= 100 ? '100+' : count >= 10 ? '10+' : '1'
      return {
        signature: `${reason}/${bucket}`,
        doc: {
          source: 'platform',
          kind: 'warning',
          severity: reason === 'OOMKilling' || reason === 'Evicted' ? 'high' : 'medium',
          title: `${subject}: ${reason}${count > 1 ? ` (×${count})` : ''}`,
          description: get<string>(obj, 'message'),
          href: links.events(ns),
          key: `event:${ns}/${subject}:${reason}:${bucket}`,
          target: { type: involved.kind?.toLowerCase() ?? 'object', id: involved.name ?? '', label: subject },
          prompt: `${subject} in namespace ${ns} is reporting ${reason}. Diagnose it and tell me what to do.`,
        },
      }
    },
  },

  ...DELIVERY_SOURCES,
  ...CONTROL_PLANE_SOURCES,
]

/* ─────────────────────── namespace → tenant ─────────────────────── */

let nsToTenant = new Map<string, string>()
/** Every namespace's labels — rollouts read the project/environment from them. */
let nsLabels = new Map<string, Record<string, string>>()
let nsLoadedAt = 0

async function refreshNamespaces(token: string): Promise<void> {
  if (Date.now() - nsLoadedAt < NAMESPACE_REFRESH_MS) return
  try {
    const res = await apiServerFetch(token, '/api/v1/namespaces', { search: '?limit=2000' })
    if (!res.ok) return
    const body = (await res.json()) as { items?: KubeObject[] }
    const next = new Map<string, string>()
    const labels = new Map<string, Record<string, string>>()
    for (const ns of body.items ?? []) {
      const slug = orgOfLabels(ns.metadata?.labels)
      if (slug && ns.metadata?.name) next.set(ns.metadata.name, slug)
      if (ns.metadata?.name) labels.set(ns.metadata.name, ns.metadata.labels ?? {})
    }
    nsToTenant = next
    nsLabels = labels
    nsLoadedAt = Date.now()
  } catch {
    // Keep the previous map; a stale mapping routes to the platform tenant at
    // worst, which is visible, rather than dropping the event silently.
  }
}

function tenantFor(namespace: string): string {
  return nsToTenant.get(namespace) ?? PLATFORM_TENANT
}

/* ─────────────────────────── the watcher ─────────────────────────── */

/**
 * Last-known signature per object.
 *
 * Bounded: an entry is only kept for objects a source found interesting, and
 * DELETED clears it. A cluster with tens of thousands of such objects would
 * grow this, which is why the cap exists — dropping the oldest costs one
 * duplicate notification, never a missed one.
 */
const MAX_TRACKED = 20_000
const lastSignature = new Map<string, string>()

/**
 * Record a signature; true when it is news.
 *
 * A key seen for the FIRST time is news. That is not an obvious call, so it is
 * worth being explicit about: suppressing first sightings here would silence
 * almost everything this file exists to report, because `signal()` returns null
 * for objects in flight and nothing null is ever tracked. A PipelineRun is
 * untracked while it runs, so the failure that ends it is its first tracked
 * state; a Warning event is born already interesting; a Workflow is untracked
 * until the moment it goes terminal. Suppressing first sightings would mean
 * only Argo CD ever notified, and only for its second transition onward.
 *
 * Boot is handled somewhere else and better: the priming list writes straight
 * to the map, so everything already in flight at startup is "seen" without
 * passing through here.
 *
 * Exported for tests — the one-duplicate-never-a-miss trade-off below is the
 * kind of thing that should fail loudly if someone inverts it.
 */
export function remember(key: string, signature: string): boolean {
  const previous = lastSignature.get(key)
  if (previous === signature) return false
  if (lastSignature.size >= MAX_TRACKED) {
    const oldest = lastSignature.keys().next().value
    if (oldest !== undefined) lastSignature.delete(oldest)
  }
  lastSignature.set(key, signature)
  return true
}

async function deliver(obj: KubeObject, signal: Signal): Promise<void> {
  const tenant = tenantFor(nsOf(obj))
  const store = await openStore(tenant)
  if (!store) return // no database configured — notifications are durable or not at all
  const doc = { ...signal.doc, at: new Date().toISOString() } as NotificationDoc
  const { id, created } = await emitNotificationResult(store, doc, 'system')
  // Failures become support tickets (and recoveries close them) — queued,
  // so the watch loop never waits on Plane.
  observeNotification({ tenant, notificationId: id, doc, created, origin: 'platform-watcher' })
}

/**
 * Sources that read the same resource with the same selectors share ONE
 * watch. Argo CD health and Argo CD sync operations are both Applications; two
 * watches would double what the apiserver streams for no extra information.
 * Exported for tests.
 */
export function groupByWatch(sources: Source[]): Source[][] {
  const out = new Map<string, Source[]>()
  for (const s of sources) {
    const k = `${s.group}/${s.version}/${s.resource}?${new URLSearchParams(s.search ?? {}).toString()}`
    const g = out.get(k) ?? []
    g.push(s)
    out.set(k, g)
  }
  return [...out.values()]
}

/**
 * The watch handlers for one group of sources: priming baselines in silence,
 * later frames emit on a signature change, DELETED frames emit what a source's
 * `removed` says. Separate from `startPlatformEvents` so the rules can be
 * exercised without a cluster or a database. Exported for tests.
 */
export function watchHandlers(
  group: Source[],
  baseCtx: SignalContext,
  emit: (obj: KubeObject, signal: Signal, source: Source) => Promise<void>,
): { upsert(obj: KubeObject, ctx: { priming: boolean }): Promise<void>; remove(obj: KubeObject): void } {
  return {
    async upsert(obj, { priming }) {
      for (const source of group) {
        source.observe?.(obj)
        const key = keyOf(source.id, obj)
        const signal = source.signal(obj, { ...baseCtx, previous: lastSignature.get(key) })
        if (!signal) continue
        // The priming list establishes the baseline in silence: on boot
        // every application has a health status and every finished run
        // has an outcome, and announcing all of it would fill the feed
        // with history every time the console restarts.
        if (priming) {
          lastSignature.set(key, signal.signature)
          continue
        }
        // Everything after that — including a resync list after the watch
        // dropped — is a real transition if the signature changed.
        if (remember(key, signal.signature)) await emit(obj, signal, source)
      }
    },
    remove(obj) {
      for (const source of group) {
        const key = keyOf(source.id, obj)
        const previous = lastSignature.get(key)
        lastSignature.delete(key)
        const signal = source.removed?.(obj, { ...baseCtx, previous })
        if (signal) void emit(obj, signal, source)
      }
    },
  }
}

let running = false

/**
 * Start watching. Safe to call once at boot; a second call is a no-op.
 *
 * Returns a stop function for tests. Off by default in dev unless a token is
 * available, because a console with no cluster behind it should produce an
 * empty feed rather than errors.
 */
export function startPlatformEvents(): () => void {
  if (running) return () => {}
  if (env('ADHAR_EVENTS_DISABLED') === 'true') {
    console.log('[events] disabled by ADHAR_EVENTS_DISABLED')
    return () => {}
  }
  const token = getK8sServiceToken()
  if (!token) {
    console.log('[events] no ServiceAccount token — platform event watching is off (set K8S_SA_TOKEN or run adhar-controlplane)')
    return () => {}
  }

  running = true
  let stopped = false
  const isStopped = () => stopped

  // The namespace→tenant map is refreshed on its own timer rather than inside
  // the watch loop: it is shared by every source, and its own TTL already
  // decides when a refresh is due.
  void refreshNamespaces(token)
  const nsTimer = setInterval(() => void refreshNamespaces(token), NAMESPACE_REFRESH_MS)

  // "Created" means created after THIS moment: anything older is a restart
  // or a relist, not something that just happened.
  const since = Date.now()
  const baseCtx: SignalContext = {
    since,
    namespaceLabels: (ns) => nsLabels.get(ns),
    freightAlias: freightAliasOf,
  }

  const groups = groupByWatch(SOURCES)
  for (const group of groups) {
    const [first] = group
    const spec: WatchSpec = {
      id: group.map((s) => s.id).join('+'),
      group: first.group,
      version: first.version,
      resource: first.resource,
      search: first.search,
    }
    void runWatch(
      spec,
      token,
      watchHandlers(group, baseCtx, (obj, signal, source) =>
        deliver(obj, signal).catch((e) => console.warn(`[events] ${source.id}: emit failed:`, e))),
      isStopped,
      (m) => console.log(m.replace('[watch]', '[events]')),
    ).catch((e) => console.warn(`[events] ${spec.id}: watcher exited:`, e))
  }
  console.log(`[events] platform event watcher started (${SOURCES.length} sources on ${groups.length} watches)`)

  return () => {
    stopped = true
    running = false
    clearInterval(nsTimer)
  }
}
