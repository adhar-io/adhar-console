/**
 * `GET /api/status` — the live platform status, computed on the server.
 *
 * Everything on the Platform status page comes from here and is read from the
 * running system, nothing from constants:
 *
 *   - Console version: the image tag of the `adhar-console` Deployment that is
 *     actually running, alongside `ADHAR_CONSOLE_VERSION` baked in at build.
 *   - Platform version: the image tag of `adhar-controller-manager` — the Adhar
 *     CLI installs the controller at exactly the version it was released as —
 *     plus the `AdharPlatform` resource's conditions.
 *   - Kubernetes: the API server's `/version` and node readiness.
 *   - Dependencies: API server, Postgres, Keycloak and Prometheus, each probed
 *     with its latency.
 *   - Components: every backing tool's workloads, readiness and the version its
 *     image runs.
 *
 * One snapshot is shared by every viewer and recomputed at most every
 * SNAPSHOT_TTL_MS, so a room full of status pages costs one set of API calls.
 * A sampler keeps an hour of per-component history and a log of status
 * changes in memory (lost on restart — this is a live view, not an archive).
 */
import { env } from '@adhar/utils'
import { getServerAuthConfig } from '@adhar/auth/server'
import { BACKING_TOOLS, type ServiceHealth } from '@adhar/platform-info'
import { apiServerFetch, type K8sIdentity, resolveIdentity } from './k8s/gateway.ts'
import { getK8sServiceToken, getToolRegistry } from './tool-registry.ts'
import { foldHealth, imageVersion, matchWorkloads, type Workload } from '../data/backing-match.ts'
import { withDeadline } from './http-hardening.ts'

const SNAPSHOT_TTL_MS = 5_000
const SAMPLE_EVERY_MS = 30_000
const HISTORY_BUCKETS = 120 // 1h at 30s
const MAX_EVENTS = 50
const PROBE_TIMEOUT_MS = 4_000
const STARTED_AT = new Date().toISOString()

type DepStatus = 'ok' | 'degraded' | 'down' | 'unconfigured'

export interface Dependency {
  id: string
  name: string
  status: DepStatus
  latencyMs?: number
  detail?: string
  version?: string
}

export interface ComponentStatus {
  id: string
  name: string
  purpose: string
  homepage: string
  health: ServiceHealth
  ready: number
  desired: number
  version?: string
  workloads: Array<{ name: string; namespace?: string; kind: Workload['kind']; ready: number; desired: number; version?: string }>
}

export interface StatusSnapshot {
  generatedAt: string
  overall: ServiceHealth
  summary: string
  console: { version: string; image?: string; imageVersion?: string; startedAt: string; ready?: string; runtime: string }
  platform: {
    version?: string
    image?: string
    ready?: string
    name?: string
    conditions: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>
  }
  kubernetes: { version?: string; nodesReady?: number; nodesTotal?: number }
  dependencies: Dependency[]
  components: ComponentStatus[]
  history: { bucketMs: number; buckets: Array<{ t: number; overall: ServiceHealth; byId: Record<string, ServiceHealth> }> }
  events: Array<{ t: string; id: string; name: string; from: ServiceHealth; to: ServiceHealth }>
  /** How the cluster was read: the console's service account, or the viewer's identity. */
  readAs: 'service-account' | 'viewer' | 'none'
}

/* ─────────── helpers ─────────── */

type Auth = string | K8sIdentity

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
  const t0 = performance.now()
  try {
    const value = await withDeadline(fn(), PROBE_TIMEOUT_MS, `timed out after ${PROBE_TIMEOUT_MS / 1000}s`)
    return { value, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) }
  }
}

/** Cluster reads get a hard deadline: an unreachable API server must not hold the page for a minute. */
const KUBE_TIMEOUT_MS = 8_000

async function kubeJson<T>(auth: Auth, path: string, search?: string): Promise<T> {
  const res = await apiServerFetch(auth, path, { search, signal: AbortSignal.timeout(KUBE_TIMEOUT_MS) })
  if (!res.ok) {
    await res.body?.cancel()
    throw Object.assign(new Error(`${res.status} ${res.statusText}`.trim()), { status: res.status })
  }
  return (await res.json()) as T
}

interface RawWorkload {
  metadata?: { name?: string; namespace?: string }
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string }> } } }
  status?: { readyReplicas?: number; numberReady?: number; desiredNumberScheduled?: number; currentNumberScheduled?: number }
}

function toWorkloads(items: RawWorkload[] | undefined, kind: Workload['kind']): Workload[] {
  return (items ?? []).map((o) => ({
    name: o.metadata?.name ?? '',
    namespace: o.metadata?.namespace,
    kind,
    image: o.spec?.template?.spec?.containers?.[0]?.image,
    ready: kind === 'DaemonSet' ? o.status?.numberReady ?? 0 : o.status?.readyReplicas ?? 0,
    desired: kind === 'DaemonSet' ? o.status?.desiredNumberScheduled ?? o.status?.currentNumberScheduled ?? 0 : o.spec?.replicas ?? 0,
  }))
}

const RANK: Record<ServiceHealth, number> = { operational: 0, unknown: 1, degraded: 2, 'partial-outage': 3, outage: 4 }
const worst = (a: ServiceHealth, b: ServiceHealth): ServiceHealth => (RANK[b] > RANK[a] ? b : a)

/* ─────────── probes ─────────── */

async function probeDatabase(): Promise<Dependency> {
  const { isDbConfigured, pingDb } = await import('@adhar/db')
  if (!isDbConfigured()) return { id: 'database', name: 'Console database (Postgres)', status: 'unconfigured', detail: 'DATABASE_URL is not set — sessions, notifications and preferences fall back to defaults.' }
  const r = await timed(() => pingDb())
  return { id: 'database', name: 'Console database (Postgres)', status: r.value ? 'ok' : 'down', latencyMs: r.ms, detail: r.error ?? (r.value ? undefined : 'ping failed') }
}

async function probeKeycloak(): Promise<Dependency> {
  const cfg = getServerAuthConfig()
  if (!cfg) return { id: 'keycloak', name: 'Sign-in (Keycloak)', status: 'unconfigured', detail: 'Keycloak is not configured; the console runs with stub auth.' }
  const r = await timed(async () => {
    const res = await fetch(`${cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
    await res.body?.cancel()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return true
  })
  return { id: 'keycloak', name: 'Sign-in (Keycloak)', status: r.value ? (r.ms > 2_000 ? 'degraded' : 'ok') : 'down', latencyMs: r.ms, detail: r.error }
}

async function probePrometheus(): Promise<Dependency> {
  const def = getToolRegistry().prometheus
  if (!def?.baseUrl) return { id: 'prometheus', name: 'Metrics (Prometheus)', status: 'unconfigured', detail: 'No PROMETHEUS_URL or MIMIR_URL configured.' }
  const r = await timed(async () => {
    const headers: Record<string, string> = { ...(def.headers ?? {}) }
    if (def.serviceToken) headers.authorization = `Bearer ${def.serviceToken}`
    const res = await fetch(`${def.baseUrl.replace(/\/$/, '')}/api/v1/status/buildinfo`, { headers })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`HTTP ${res.status}`)
    }
    const body = (await res.json().catch(() => ({}))) as { data?: { version?: string } }
    return body.data?.version ?? ''
  })
  return {
    id: 'prometheus',
    name: 'Metrics (Prometheus)',
    status: r.error ? 'down' : r.ms > 2_000 ? 'degraded' : 'ok',
    latencyMs: r.ms,
    detail: r.error,
    version: r.value || undefined,
  }
}

/* ─────────── snapshot ─────────── */

const history: StatusSnapshot['history']['buckets'] = []
const events: StatusSnapshot['events'] = []
let lastById: Record<string, ServiceHealth> = {}
let cached: { at: number; snap: StatusSnapshot } | undefined
let inflight: Promise<StatusSnapshot> | undefined
let samplerStarted = false

function record(snap: StatusSnapshot) {
  const now = Date.now()
  const byId: Record<string, ServiceHealth> = {}
  for (const c of snap.components) byId[c.id] = c.health
  for (const d of snap.dependencies) {
    if (d.status === 'unconfigured') continue
    byId[`dep:${d.id}`] = d.status === 'ok' ? 'operational' : d.status === 'degraded' ? 'degraded' : 'outage'
  }

  // Status changes, newest first. The first sample sets the baseline silently.
  if (Object.keys(lastById).length) {
    const names = new Map([...snap.components.map((c) => [c.id, c.name] as const), ...snap.dependencies.map((d) => [`dep:${d.id}`, d.name] as const)])
    for (const [id, to] of Object.entries(byId)) {
      const from = lastById[id]
      if (from && from !== to) events.unshift({ t: new Date(now).toISOString(), id, name: names.get(id) ?? id, from, to })
    }
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS
  }
  lastById = byId

  // One bucket per SAMPLE_EVERY_MS; within a bucket the worst status wins, so
  // a blip between samples is not smoothed away.
  const t = Math.floor(now / SAMPLE_EVERY_MS) * SAMPLE_EVERY_MS
  const last = history[history.length - 1]
  if (last && last.t === t) {
    last.overall = worst(last.overall, snap.overall)
    for (const [id, h] of Object.entries(byId)) last.byId[id] = worst(last.byId[id] ?? 'operational', h)
  } else {
    history.push({ t, overall: snap.overall, byId: { ...byId } })
    if (history.length > HISTORY_BUCKETS) history.splice(0, history.length - HISTORY_BUCKETS)
  }
}

async function compute(auth: Auth | null, readAs: StatusSnapshot['readAs']): Promise<StatusSnapshot> {
  const empty = { items: [] as RawWorkload[] }
  const [apiserver, deps, sts, ds, nodes, platforms, database, keycloak, prometheus] = await Promise.all([
    auth ? timed(() => kubeJson<{ gitVersion?: string }>(auth, '/version')) : Promise.resolve({ ms: 0, error: 'no cluster credentials', value: undefined }),
    auth ? kubeJson<{ items?: RawWorkload[] }>(auth, '/apis/apps/v1/deployments', '?limit=2000').catch(() => empty) : empty,
    auth ? kubeJson<{ items?: RawWorkload[] }>(auth, '/apis/apps/v1/statefulsets', '?limit=2000').catch(() => empty) : empty,
    auth ? kubeJson<{ items?: RawWorkload[] }>(auth, '/apis/apps/v1/daemonsets', '?limit=2000').catch(() => empty) : empty,
    auth
      ? kubeJson<{ items?: Array<{ status?: { conditions?: Array<{ type: string; status: string }> } }> }>(auth, '/api/v1/nodes').catch(() => undefined)
      : undefined,
    auth
      ? kubeJson<{ items?: Array<{ metadata?: { name?: string }; status?: { conditions?: StatusSnapshot['platform']['conditions'] } }> }>(
        auth,
        '/apis/platform.adhar.io/v1alpha1/adharplatforms',
      ).catch(() => undefined)
      : undefined,
    probeDatabase(),
    probeKeycloak(),
    probePrometheus(),
  ])

  const all = [...toWorkloads(deps.items, 'Deployment'), ...toWorkloads(sts.items, 'StatefulSet'), ...toWorkloads(ds.items, 'DaemonSet')]

  const components: ComponentStatus[] = BACKING_TOOLS.map((t) => {
    const ws = matchWorkloads(all, t.id)
    const f = foldHealth(ws)
    // The version is the most common image tag among the component's own
    // workloads (sidecars and exporters carry their own tags).
    const tags = ws.map((w) => imageVersion(w.image)).filter((v): v is string => Boolean(v) && v !== 'latest')
    const counts = new Map<string, number>()
    for (const v of tags) counts.set(v, (counts.get(v) ?? 0) + 1)
    const version = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return {
      id: t.id,
      name: t.name,
      purpose: t.purpose,
      homepage: t.homepage,
      health: f.health,
      ready: f.ready,
      desired: f.desired,
      version,
      workloads: ws.map((w) => ({ name: w.name, namespace: w.namespace, kind: w.kind, ready: w.ready, desired: w.desired, version: imageVersion(w.image) })),
    }
  })

  const controller = all.find((w) => w.name === 'adhar-controller-manager')
  const consoleWl = all.find((w) => w.kind === 'Deployment' && w.name === 'adhar-console')
  const platform = platforms?.items?.[0]

  const apiDep: Dependency = {
    id: 'apiserver',
    name: 'Kubernetes API server',
    status: !auth ? 'unconfigured' : apiserver.error ? 'down' : apiserver.ms > 2_000 ? 'degraded' : 'ok',
    latencyMs: auth ? apiserver.ms : undefined,
    detail: apiserver.error,
    version: apiserver.value?.gitVersion,
  }
  const dependencies = [apiDep, database, keycloak, prometheus]

  let nodesReady: number | undefined
  let nodesTotal: number | undefined
  if (nodes?.items) {
    nodesTotal = nodes.items.length
    nodesReady = nodes.items.filter((n) => n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')).length
  }

  // Overall: an unreachable API server is an outage of the console's view of
  // the platform; any component or dependency below operational degrades it.
  const detected = components.filter((c) => c.workloads.length > 0)
  let overall: ServiceHealth = 'operational'
  if (apiDep.status === 'down') overall = 'outage'
  else if (!auth) overall = 'unknown'
  else {
    for (const c of detected) if (c.health !== 'operational') overall = worst(overall, c.health === 'outage' ? 'partial-outage' : c.health)
    for (const d of dependencies) if (d.status === 'down' || d.status === 'degraded') overall = worst(overall, 'degraded')
    if (controller && controller.ready === 0) overall = worst(overall, 'partial-outage')
  }
  const down = detected.filter((c) => c.health === 'outage').length
  const degraded = detected.filter((c) => c.health === 'degraded').length
  const depsDown = dependencies.filter((d) => d.status === 'down').length
  const summary = apiDep.status === 'down'
    ? `Kubernetes API server unreachable (${apiDep.detail ?? 'no response'}) — component health is unknown`
    : overall === 'operational'
    ? `All ${detected.length} components and ${dependencies.filter((d) => d.status === 'ok').length} dependencies healthy`
    : overall === 'unknown'
    ? 'The console has no cluster credentials to read status with'
    : [down ? `${down} down` : '', degraded ? `${degraded} degraded` : '', depsDown ? `${depsDown} dependenc${depsDown === 1 ? 'y' : 'ies'} unreachable` : '']
      .filter(Boolean)
      .join(' · ') || 'Some checks are slow'

  const snap: StatusSnapshot = {
    generatedAt: new Date().toISOString(),
    overall,
    summary,
    console: {
      version: env('ADHAR_CONSOLE_VERSION') ?? 'dev',
      image: consoleWl?.image,
      imageVersion: imageVersion(consoleWl?.image),
      startedAt: STARTED_AT,
      ready: consoleWl ? `${consoleWl.ready}/${consoleWl.desired}` : undefined,
      runtime: `Deno ${Deno.version.deno}`,
    },
    platform: {
      version: imageVersion(controller?.image),
      image: controller?.image,
      ready: controller ? `${controller.ready}/${controller.desired}` : undefined,
      name: platform?.metadata?.name,
      conditions: platform?.status?.conditions ?? [],
    },
    kubernetes: { version: apiserver.value?.gitVersion, nodesReady, nodesTotal },
    dependencies,
    components,
    history: { bucketMs: SAMPLE_EVERY_MS, buckets: [] },
    events: [],
    readAs,
  }
  record(snap)
  return snap
}

function snapshot(auth: Auth | null, readAs: StatusSnapshot['readAs']): Promise<StatusSnapshot> {
  // Only the service-account view is the same for everyone. A snapshot read
  // with one viewer's identity reflects THAT viewer's RBAC and must not be
  // served to the next caller — signed in as someone else, or not at all.
  if (readAs !== 'service-account') return compute(auth, readAs)
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return Promise.resolve(cached.snap)
  inflight ??= compute(auth, readAs)
    .then((snap) => {
      cached = { at: Date.now(), snap }
      return snap
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

/** Keep history filling while nobody is looking — only possible with the console's own credentials. */
function ensureSampler() {
  if (samplerStarted) return
  const token = getK8sServiceToken()
  if (!token) return
  samplerStarted = true
  setInterval(() => {
    snapshot(token, 'service-account').catch(() => {})
  }, SAMPLE_EVERY_MS)
}

export async function handleStatus(req: Request): Promise<Response> {
  if (req.method !== 'GET') return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  ensureSampler()
  const sa = getK8sServiceToken()
  let auth: Auth | null = sa ?? null
  let readAs: StatusSnapshot['readAs'] = sa ? 'service-account' : 'none'
  if (!auth) {
    const id = await resolveIdentity(req).catch(() => null)
    if (id) {
      auth = id
      readAs = 'viewer'
    }
  }
  const snap = await snapshot(auth, readAs)
  // The status page is public (it has to work before sign-in), but workload
  // names, namespaces, images and condition / probe messages are a map of the
  // cluster. Anonymous viewers get health, counts and versions only.
  const signedIn = readAs === 'viewer' || !getServerAuthConfig() ||
    Boolean(await resolveIdentity(req).catch(() => null))
  const body = signedIn ? snap : redactForAnonymous(snap)
  return Response.json(
    { ...body, history: { bucketMs: SAMPLE_EVERY_MS, buckets: history }, events },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/** The public subset of a snapshot — see handleStatus. */
export function redactForAnonymous(snap: StatusSnapshot): StatusSnapshot {
  return {
    ...snap,
    console: { ...snap.console, image: undefined },
    platform: {
      ...snap.platform,
      image: undefined,
      conditions: snap.platform.conditions.map(({ type, status, lastTransitionTime }) => ({ type, status, lastTransitionTime })),
    },
    dependencies: snap.dependencies.map(({ detail: _detail, ...d }) => d),
    components: snap.components.map((c) => ({ ...c, workloads: [] })),
  }
}
