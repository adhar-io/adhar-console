import { apiServerFetch } from '../k8s/gateway.ts'
import { getK8sServiceToken } from '../tool-registry.ts'
import { emitNotification, type NotificationDoc } from '../notify.ts'
import { openStore } from '../workspace/store.ts'
import { env } from '@adhar-console/utils'
import { type KubeObject as SaKubeObject, runWatch, type WatchSpec } from '../k8s/sa-watch.ts'

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
 */

/* ─────────────────────────── configuration ─────────────────────────── */

/** Tenant that owns un-labelled (platform) namespaces. */
const PLATFORM_TENANT = 'default'
const ORG_LABEL = 'adhar.io/org'

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

/* ─────────────────────────── kube shapes ─────────────────────────── */

/** Re-exported from the shared watcher so the signal functions read the same
 *  objects the watch delivers. */
type KubeObject = SaKubeObject

/** One thing worth telling somebody about. */
interface Signal {
  /** Stable per-object state; a notification is emitted only when this changes. */
  signature: string
  doc: Omit<NotificationDoc, 'at'>
}

interface Source {
  id: string
  /** Empty string for core/v1. */
  group: string
  version: string
  resource: string
  /** Extra query parameters (field selectors and the like). */
  search?: Record<string, string>
  /** Null when the object is in a state nobody needs to hear about. */
  signal(obj: KubeObject): Signal | null
}

/* ─────────────────────────── helpers ─────────────────────────── */

const nameOf = (o: KubeObject) => o.metadata?.name ?? '<unnamed>'
const nsOf = (o: KubeObject) => o.metadata?.namespace ?? ''
const keyOf = (o: KubeObject) => o.metadata?.uid ?? `${nsOf(o)}/${nameOf(o)}`

function get<T>(obj: unknown, path: string): T | undefined {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur as T | undefined
}

/** `Succeeded`-style condition lookup used by Tekton. */
function condition(obj: KubeObject, type: string): { status?: string; reason?: string; message?: string } | undefined {
  const conds = get<Array<{ type?: string; status?: string; reason?: string; message?: string }>>(obj, 'status.conditions')
  return conds?.find((c) => c.type === type)
}

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
      const href = `/deliver?section=apps&app=${encodeURIComponent(name)}`
      const target = { type: 'application', id: name, label: name }
      const base = { source: 'gitops' as const, target, href, key: `argocd:${nsOf(obj)}/${name}:${health}/${sync}` }

      if (health === 'Degraded' || health === 'Missing') {
        return {
          signature: `${health}/${sync}`,
          doc: {
            ...base,
            kind: 'error',
            severity: 'high',
            title: `${name} is ${health.toLowerCase()}`,
            description: get<string>(obj, 'status.health.message') ?? `Argo CD reports the application as ${health}, sync ${sync}.`,
            prompt: `Argo CD application ${name} is ${health}. Diagnose why and tell me what to do about it.`,
          },
        }
      }
      if (health === 'Healthy' && sync === 'Synced') {
        return {
          signature: `${health}/${sync}`,
          doc: { ...base, kind: 'success', title: `${name} is synced and healthy`, description: `Revision ${(get<string>(obj, 'status.sync.revision') ?? '').slice(0, 7) || 'unknown'} is live.` },
        }
      }
      if (sync === 'OutOfSync') {
        return {
          signature: `${health}/${sync}`,
          doc: {
            ...base,
            kind: 'warning',
            severity: 'medium',
            title: `${name} has drifted from Git`,
            description: 'The live state no longer matches the desired state in the repository.',
            prompt: `Argo CD application ${name} is OutOfSync. What drifted, and should I sync it?`,
          },
        }
      }
      return null
    },
  },

  /**
   * Tekton PipelineRuns — CI outcomes.
   *
   * Only terminal states. A run that is still going is what the CI page is
   * for; a notification for it would arrive before there was anything to say.
   */
  {
    id: 'tekton',
    group: 'tekton.dev',
    version: 'v1',
    resource: 'pipelineruns',
    signal(obj) {
      const cond = condition(obj, 'Succeeded')
      if (!cond?.status || cond.status === 'Unknown') return null
      const name = nameOf(obj)
      const ok = cond.status === 'True'
      return {
        signature: `${cond.status}/${cond.reason ?? ''}`,
        doc: {
          source: 'platform',
          kind: ok ? 'success' : 'error',
          severity: ok ? 'low' : 'high',
          title: ok ? `Pipeline ${name} succeeded` : `Pipeline ${name} failed`,
          description: cond.message ?? cond.reason,
          href: `/platform?section=ci`,
          key: `tekton:${nsOf(obj)}/${name}:${cond.status}`,
          target: { type: 'pipelinerun', id: name, label: name },
          ...(ok ? {} : { prompt: `Tekton PipelineRun ${name} failed: ${cond.reason ?? 'unknown reason'}. Find the failing task and its logs, and explain the cause.` }),
        },
      }
    },
  },

  /** Argo Workflows — everything that is a DAG of containers but not CI. */
  {
    id: 'argo-workflows',
    group: 'argoproj.io',
    version: 'v1alpha1',
    resource: 'workflows',
    signal(obj) {
      const phase = get<string>(obj, 'status.phase')
      if (phase !== 'Succeeded' && phase !== 'Failed' && phase !== 'Error') return null
      const name = nameOf(obj)
      const ok = phase === 'Succeeded'
      return {
        signature: phase,
        doc: {
          source: 'platform',
          kind: ok ? 'success' : 'error',
          severity: ok ? 'low' : 'high',
          title: ok ? `Workflow ${name} completed` : `Workflow ${name} ${phase.toLowerCase()}`,
          description: get<string>(obj, 'status.message'),
          href: `/develop?section=workflows`,
          key: `workflow:${nsOf(obj)}/${name}:${phase}`,
          target: { type: 'workflow', id: name, label: name },
          ...(ok ? {} : { prompt: `Argo Workflow ${name} ${phase.toLowerCase()}. Which step failed, and why?` }),
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
          href: `/platform?section=events&namespace=${encodeURIComponent(ns)}`,
          key: `event:${ns}/${subject}:${reason}:${bucket}`,
          target: { type: involved.kind?.toLowerCase() ?? 'object', id: involved.name ?? '', label: subject },
          prompt: `${subject} in namespace ${ns} is reporting ${reason}. Diagnose it and tell me what to do.`,
        },
      }
    },
  },
]

/* ─────────────────────── namespace → tenant ─────────────────────── */

let nsToTenant = new Map<string, string>()
let nsLoadedAt = 0

async function refreshNamespaces(token: string): Promise<void> {
  if (Date.now() - nsLoadedAt < NAMESPACE_REFRESH_MS) return
  try {
    const res = await apiServerFetch(token, '/api/v1/namespaces', { search: '?limit=2000' })
    if (!res.ok) return
    const body = (await res.json()) as { items?: KubeObject[] }
    const next = new Map<string, string>()
    for (const ns of body.items ?? []) {
      const slug = ns.metadata?.labels?.[ORG_LABEL]
      if (slug && ns.metadata?.name) next.set(ns.metadata.name, slug)
    }
    nsToTenant = next
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
  await emitNotification(store, { ...signal.doc, at: new Date().toISOString() } as NotificationDoc, 'system')
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
    console.log('[events] no ServiceAccount token — platform event watching is off (set K8S_SA_TOKEN or run in-cluster)')
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

  for (const source of SOURCES) {
    const spec: WatchSpec = {
      id: source.id,
      group: source.group,
      version: source.version,
      resource: source.resource,
      search: source.search,
    }
    void runWatch(
      spec,
      token,
      {
        async upsert(obj, { priming }) {
          const signal = source.signal(obj as KubeObject)
          if (!signal) return
          const key = keyOf(obj as KubeObject)
          // The priming list establishes the baseline in silence: on boot
          // every application has a health status and every finished run has
          // an outcome, and announcing all of it would fill the feed with
          // history every time the console restarts.
          if (priming) {
            lastSignature.set(key, signal.signature)
            return
          }
          // Everything after that — including a resync list after the watch
          // dropped — is a real transition if the signature changed.
          if (remember(key, signal.signature)) {
            await deliver(obj as KubeObject, signal).catch((e) =>
              console.warn(`[events] ${source.id}: emit failed:`, e)
            )
          }
        },
        remove(obj) {
          lastSignature.delete(keyOf(obj as KubeObject))
        },
      },
      isStopped,
      (m) => console.log(m.replace('[watch]', '[events]')),
    ).catch((e) => console.warn(`[events] ${source.id}: watcher exited:`, e))
  }
  console.log(`[events] platform event watcher started (${SOURCES.length} sources)`)

  return () => {
    stopped = true
    running = false
    clearInterval(nsTimer)
  }
}
