import type { AccessCheck } from '@adhar/auth'
import { apiServerFetch, type K8sIdentity, resolveIdentity } from './k8s/gateway.ts'
import { checkAccess, MAX_BATCH } from './k8s/access.ts'
import { getK8sServiceToken } from './tool-registry.ts'

/**
 * `GET /api/batch/history` — what happened to batch jobs beyond the runs the
 * cluster still holds (design 0025 §7.2 History, §12, D12).
 *
 * A run Job is deleted by its TTL; the batch observer published each of its
 * transitions onto the `adhar.batch` topic, which keeps 90 days. This handler
 * reads that topic the way `adhar batch history` does: through the API server's
 * SERVICE PROXY to the Strimzi bridge, with the console's own ServiceAccount.
 * No second credential, no network path the API server does not already have.
 *
 * Two identities, kept apart on purpose:
 *
 *   - the STREAM is read as the console (a user has no grant on the bridge, and
 *     the topic carries every tenant's runs);
 *   - what a caller is SHOWN is decided as the caller: an event is kept only
 *     when its subject's namespace is one where that person may list BatchJobs.
 *
 * The bridge's consumer API is stateful (create, subscribe, poll, delete) and
 * each consumer is a real group member on the broker, so the read is shared:
 * one in flight at a time, its result kept for `CACHE_MS`, and the consumer is
 * deleted on every exit path. Each read uses its own group, because members of
 * one group split the partitions between them and every reader wants them all;
 * nothing is committed, so the group leaves nothing behind.
 */

export const BATCH_TOPIC = 'adhar.batch'
const BATCH_TYPE_PREFIX = 'io.adhar.batch.'

/** The Service Strimzi creates for `KafkaBridge/adhar-events` (cmd/events/reach.go in the platform repo). */
export const BRIDGE_NAMESPACE = 'adhar-system'
export const BRIDGE_SERVICE = 'adhar-events-bridge-service'
export const BRIDGE_PORT = '8080'
/** The name RBAC sees for this proxy request: the console's Role names exactly this (`resourceNames`). */
export const BRIDGE_PROXY_RESOURCE = `${BRIDGE_SERVICE}:${BRIDGE_PORT}`
export const BRIDGE_PROXY_PATH = `/api/v1/namespaces/${BRIDGE_NAMESPACE}/services/${BRIDGE_PROXY_RESOURCE}/proxy`

const CACHE_MS = 30_000
/** The newest this many events are kept: 90 days of a busy platform must not live in the console's heap. */
export const MAX_EVENTS = 20_000
const POLL_MS = 2_000
const READ_BUDGET_MS = 25_000
const DEFAULT_LIMIT = 500
const MAX_LIMIT = 5_000

/** One `adhar.batch` CloudEvent, as platform/events/CONTRACT.md defines it. Every `data` field is optional. */
export interface BatchEvent {
  specversion: string
  id?: string
  type: string
  source?: string
  subject: string
  time?: string
  data?: Record<string, unknown>
  [extension: string]: unknown
}

/** One HTTP call to the bridge, relative to its root (`/consumers/…`). */
export type BridgeFetch = (path: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => Promise<Response>

export type StreamRead =
  /**
   * `truncated`: the stream is larger than the cap, so the OLDEST events were dropped. `behind`: the budget ran out
   * before the stream's end, and the read is oldest first, so the NEWEST events were never reached.
   */
  | { state: 'read'; events: BatchEvent[]; foreign: number; truncated: boolean; behind?: boolean }
  /** `no-bus`: the cluster has no bridge (the bus is opt-in). `unreachable`: it has one that did not answer. */
  | { state: 'unavailable'; reason: 'no-bus' | 'unreachable' | 'forbidden' | 'no-identity'; detail: string }

class BridgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function call(bridge: BridgeFetch, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await bridge(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new BridgeError(res.status, `bridge ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`.trim())
  }
  return res
}

/**
 * The consumer's path under the bridge root. The bridge answers with an
 * absolute `base_uri` built from the host it was reached at, which through the
 * API server's proxy is not an address to follow: the ServiceAccount token is
 * sent to the API server and nowhere else. Only the path after `/consumers/` is
 * taken from it, and only when it is the consumer that was asked for.
 */
export function consumerPath(group: string, name: string, created: { base_uri?: unknown; instance_id?: unknown }): string {
  const own = `/consumers/${group}/instances/${typeof created.instance_id === 'string' && created.instance_id ? created.instance_id : name}`
  const uri = typeof created.base_uri === 'string' ? created.base_uri : ''
  const at = uri.indexOf('/consumers/')
  const tail = at >= 0 ? uri.slice(at).replace(/\/+$/, '') : ''
  return tail === own ? tail : own
}

function eventOf(value: unknown): BatchEvent | null {
  const e = value as Partial<BatchEvent> | null
  if (!e || typeof e !== 'object' || typeof e.specversion !== 'string' || !e.specversion) return null
  if (typeof e.type !== 'string' || !e.type.startsWith(BATCH_TYPE_PREFIX)) return null
  if (typeof e.subject !== 'string' || !/^[^/]+\/[^/]+$/.test(e.subject)) return null
  return e as BatchEvent
}

/**
 * Read the whole retained topic, oldest first, ending when the stream goes
 * quiet (two empty polls in a row, as `adhar events list` decides) or the
 * budget is spent, which leaves the read `behind`: short of the stream's end.
 * A record that is not an `adhar.batch` CloudEvent is counted, not shown.
 */
export async function readTopic(
  bridge: BridgeFetch,
  opts: { pollMs?: number; budgetMs?: number; maxEvents?: number; now?: () => number; id?: string } = {},
): Promise<StreamRead> {
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? POLL_MS
  const max = opts.maxEvents ?? MAX_EVENTS
  const deadline = now() + (opts.budgetMs ?? READ_BUDGET_MS)
  const id = opts.id ?? `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const group = `adhar-console-${id}`
  const name = `history-${id}`
  let consumer = ''
  try {
    const created = await call(bridge, 'POST', `/consumers/${group}`, {
      name,
      format: 'json',
      // A reader, never a committer.
      'auto.offset.reset': 'earliest',
      'enable.auto.commit': false,
      'consumer.request.timeout.ms': 60_000,
    })
    consumer = consumerPath(group, name, (await created.json().catch(() => ({}))) as Record<string, unknown>)
    await (await call(bridge, 'POST', `${consumer}/subscription`, { topics: [BATCH_TOPIC] })).body?.cancel()
    let events: BatchEvent[] = []
    let foreign = 0
    let truncated = false
    let behind = false
    let empties = 0
    while (empties < 2) {
      if (now() >= deadline) {
        behind = true
        break
      }
      const res = await call(bridge, 'GET', `${consumer}/records?timeout=${pollMs}`)
      const records = (await res.json().catch(() => null)) as Array<{ value?: unknown }> | null
      // Anything but a list is not the bridge answering a poll, and counting it as a quiet stream would report an empty history.
      if (!Array.isArray(records)) throw new BridgeError(502, `bridge GET ${consumer}/records: the answer is not a list of records`)
      if (records.length === 0) {
        empties++
        continue
      }
      empties = 0
      for (const r of records) {
        const e = eventOf(r?.value)
        if (e) events.push(e)
        else foreign++
      }
      if (events.length > max) {
        events = events.slice(events.length - max)
        truncated = true
      }
    }
    return { state: 'read', events, foreign, truncated, ...(behind ? { behind } : {}) }
  } catch (e) {
    const status = e instanceof BridgeError ? e.status : 0
    const detail = e instanceof Error ? e.message : String(e)
    // The API server answers 404 for a Service that does not exist, and 503 for one with no endpoints. Only the
    // first request can mean that: once the consumer exists, a 404 is the bridge having lost it (it restarted).
    if (status === 404 && !consumer) {
      return {
        state: 'unavailable',
        reason: 'no-bus',
        detail: 'This cluster has no event bridge. The event bus is opt-in: the kafka-operator package declares it.',
      }
    }
    if (status === 403 || status === 401) {
      return {
        state: 'unavailable',
        reason: 'forbidden',
        detail: 'The console may not reach the event bridge. Its Role console-batch-history (adhar-console package) grants that.',
      }
    }
    return { state: 'unavailable', reason: 'unreachable', detail }
  } finally {
    // A consumer left behind is a group member that never leaves.
    if (consumer) await bridge(consumer, { method: 'DELETE', signal: AbortSignal.timeout(5_000) }).then((r) => r.body?.cancel()).catch(() => {})
  }
}

/** The bridge, through the API server's service proxy, as the console's ServiceAccount. */
export function serviceProxyBridge(token: string): BridgeFetch {
  return (path, init = {}) => {
    const q = path.indexOf('?')
    return apiServerFetch(token, BRIDGE_PROXY_PATH + (q < 0 ? path : path.slice(0, q)), {
      method: init.method ?? 'GET',
      body: init.body,
      search: q < 0 ? undefined : path.slice(q),
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/vnd.kafka.v2+json' } : {}), accept: 'application/vnd.kafka.json.v2+json' },
      signal: init.signal ?? AbortSignal.timeout(POLL_MS + 15_000),
    })
  }
}

let cached: { at: number; read: StreamRead } | undefined
let inFlight: Promise<StreamRead> | undefined

/** The shared read: one at a time, kept for `CACHE_MS`. */
export function sharedRead(read: () => Promise<StreamRead>, now: () => number = Date.now): Promise<StreamRead> {
  if (cached && now() - cached.at < CACHE_MS) return Promise.resolve(cached.read)
  inFlight ??= read()
    .then((r) => {
      cached = { at: now(), read: r }
      return r
    })
    .finally(() => {
      inFlight = undefined
    })
  return inFlight
}

export function resetBatchHistoryCache(): void {
  cached = undefined
  inFlight = undefined
}

const SINCE = /^(\d+)([smhdw])$/
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `since`: an instant, or an age (`7d`, `12h`, `90m`). `null` when it is neither. */
export function parseSince(text: string | null, now: number): number | undefined | null {
  if (!text) return undefined
  const m = SINCE.exec(text.trim())
  if (m) return now - Number(m[1]) * UNIT_MS[m[2]]
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

export interface HistoryQuery {
  namespace?: string
  job?: string
  sinceMs?: number
  limit: number
}

const namespaceOf = (e: BatchEvent) => e.subject.slice(0, e.subject.indexOf('/'))

/** The caller's own filter. An event whose time cannot be read is kept, as the CLI keeps it. */
export function matching(events: readonly BatchEvent[], q: HistoryQuery): BatchEvent[] {
  return events.filter((e) => {
    const slash = e.subject.indexOf('/')
    if (q.namespace && e.subject.slice(0, slash) !== q.namespace) return false
    // Exactly the job: a prefix match would give `importer` the history of `importer-eu`.
    if (q.job && e.subject.slice(slash + 1) !== q.job) return false
    if (q.sinceMs !== undefined) {
      const at = Date.parse(e.time ?? '')
      if (Number.isFinite(at) && at < q.sinceMs) return false
    }
    return true
  })
}

/** The access a person needs to be shown a namespace's history: what the Batch page itself asks for. */
export const historyCheck = (namespace: string): AccessCheck => ({ verb: 'list', group: 'platform.adhar.io', resource: 'batchjobs', namespace })

export interface HistoryDeps {
  identity(req: Request): Promise<K8sIdentity | null>
  read(): Promise<StreamRead>
  /** For each namespace, in order: may this person list BatchJobs there? */
  allowed(id: K8sIdentity, namespaces: string[]): Promise<{ results: boolean[]; degraded: boolean }>
  now(): number
}

const defaultDeps: HistoryDeps = {
  identity: resolveIdentity,
  read: () => {
    const token = getK8sServiceToken()
    if (!token) {
      return Promise.resolve({ state: 'unavailable', reason: 'no-identity', detail: 'The console has no ServiceAccount token to read the event bridge with.' })
    }
    return sharedRead(() => readTopic(serviceProxyBridge(token)))
  },
  allowed: async (id, namespaces) => {
    const results: boolean[] = []
    let degraded = false
    for (let i = 0; i < namespaces.length; i += MAX_BATCH) {
      const r = await checkAccess(id, namespaces.slice(i, i + MAX_BATCH).map(historyCheck))
      results.push(...r.results)
      degraded ||= r.degraded
    }
    return { results, degraded }
  },
  now: Date.now,
}

const json = (body: unknown, status = 200, cookie?: string): Response => {
  const res = Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

export async function handleBatchHistory(req: Request, deps: HistoryDeps = defaultDeps): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
  const id = await deps.identity(req).catch(() => null)
  if (!id) return json({ error: 'unauthenticated' }, 401)
  const params = new URL(req.url).searchParams
  const sinceMs = parseSince(params.get('since'), deps.now())
  if (sinceMs === null) return json({ error: 'bad_request', detail: 'since is an instant or an age (7d, 12h, 90m)' }, 400, id.refreshedCookie)
  const asked = Number(params.get('limit') ?? DEFAULT_LIMIT)
  if (!Number.isInteger(asked) || asked < 1) return json({ error: 'bad_request', detail: `limit is 1–${MAX_LIMIT}` }, 400, id.refreshedCookie)
  const query: HistoryQuery = {
    namespace: params.get('namespace') || undefined,
    job: params.get('job') || undefined,
    sinceMs: sinceMs ?? undefined,
    limit: Math.min(asked, MAX_LIMIT),
  }

  const stream = await deps.read()
  if (stream.state !== 'read') return json({ state: 'unavailable', reason: stream.reason, detail: stream.detail, events: [] }, 200, id.refreshedCookie)

  const wanted = matching(stream.events, query)
  const namespaces = [...new Set(wanted.map(namespaceOf))].sort()
  const access = namespaces.length ? await deps.allowed(id, namespaces) : { results: [], degraded: false }
  const visible = new Set(namespaces.filter((_, i) => access.results[i] === true))
  const shown = wanted.filter((e) => visible.has(namespaceOf(e)))
  return json(
    {
      state: 'read',
      // Oldest first, the newest `limit` of them.
      events: shown.slice(Math.max(0, shown.length - query.limit)),
      total: shown.length,
      // The stream is larger than the console keeps, so older events exist than are here.
      truncated: stream.truncated,
      // The read ran out of time before the stream's end, so what happened LAST is not here.
      behind: stream.behind === true,
      // An access review could not be answered: a namespace may be missing for that reason alone.
      degraded: access.degraded,
    },
    200,
    id.refreshedCookie,
  )
}
