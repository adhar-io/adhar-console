import { apiServerFetch } from './k8s/gateway.ts'
import { getK8sServiceToken } from './tool-registry.ts'
import type { BatchEvent } from './batch-history.ts'

/**
 * The batch run-summary archive as a second source of `/api/batch/history`
 * (design 0025 Phase 4; the platform repo's platform/batcharchive is the
 * writer and the Go reader this restates).
 *
 * The batch observer keeps the final `adhar.batch` event of every finished run
 * in RustFS, at `<namespace>/<batchJob>/<businessDate>/<run>.json` in bucket
 * `adhar-batch-archive`, long after the topic's 90 days. Each object IS the
 * event the bus carried, with the same `id`, so the handler drops an archived
 * copy the stream still holds and shows the rest marked `archived: true`.
 *
 * Read as the console, like the stream: the credential is the platform's
 * object-store Secret `adhar-system/root-creds`, read live through the API
 * server with the console's ServiceAccount (its `read-all` ClusterRole already
 * covers it), so a store installed after the console needs no restart. What a
 * caller is SHOWN is decided by the handler, as the caller, per namespace —
 * and the archive is read only for a namespace the caller may see.
 */

export const ARCHIVE_BUCKET = 'adhar-batch-archive'
export const ARCHIVE_DEFAULT_ENDPOINT = 'http://rustfs.adhar-system.svc.cluster.local:9000'
const CREDENTIAL_PATH = '/api/v1/namespaces/adhar-system/secrets/root-creds'
const CREDENTIAL_TTL_MS = 5 * 60_000
const REGION = 'us-east-1'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
/** Over ten years of a job that runs ten times a day. */
const MAX_LISTED = 50_000
const PARALLEL = 8
const CALL_MS = 10_000

export interface ArchiveCredentials {
  accessKey: string
  secretKey: string
}

export type ArchiveRead =
  | { state: 'read'; events: BatchEvent[]; problems: string[] }
  /** `absent`: this cluster archives nothing (no store, no credential, no bucket) — not an error worth a banner. */
  | { state: 'absent' | 'unreachable'; detail: string }

/* ─────────────────────────── SigV4 ─────────────────────────── */

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(data))
}

/** RFC 3986 encoding, as SigV4's canonical query wants it. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/**
 * The `Authorization` header of a body-less S3 request, SigV4 over host,
 * x-amz-content-sha256 and x-amz-date — the three headers aws-sdk-go-v2's
 * signer signs for the same request (pinned by vectors it produced).
 */
export async function signGet(url: URL, creds: ArchiveCredentials, at: Date): Promise<Record<string, string>> {
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = ['GET', url.pathname, query, `host:${url.host}`, `x-amz-content-sha256:${EMPTY_SHA256}`, `x-amz-date:${amzDate}`, '', 'host;x-amz-content-sha256;x-amz-date', EMPTY_SHA256]
    .join('\n')
  const scope = `${day}/${REGION}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n')
  let key = await hmac(enc.encode(`AWS4${creds.secretKey}`), day)
  for (const part of [REGION, 's3', 'aws4_request']) key = await hmac(key, part)
  const signature = hex(await hmac(key, toSign))
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  }
}

/* ─────────────────────────── the store ─────────────────────────── */

export type StoreFetch = (url: URL, headers: Record<string, string>) => Promise<Response>

export interface ArchiveStore {
  endpoint: string
  bucket?: string
  credentials(): Promise<ArchiveCredentials | null>
  fetch?: StoreFetch
  now?(): Date
}

class StoreError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`object store answered HTTP ${status}${code ? ` ${code}` : ''}`)
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const tag = (xml: string, name: string) => unxml(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '')

async function get(store: ArchiveStore, path: string, params: Record<string, string> = {}): Promise<Response> {
  const creds = await store.credentials()
  if (!creds) throw new StoreError(0, 'NoCredential')
  const url = new URL(store.endpoint.replace(/\/+$/, '') + path)
  // Written in the canonical encoding, not URLSearchParams' form encoding (a
  // space as `+`), so the query the store sees is the one that was signed.
  url.search = Object.entries(params).map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&')
  const headers = await signGet(url, creds, store.now?.() ?? new Date())
  const res = await (store.fetch ?? ((u, h) => fetch(u, { headers: h, signal: AbortSignal.timeout(CALL_MS) })))(url, headers)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new StoreError(res.status, tag(body, 'Code'))
  }
  return res
}

export interface ArchivedObject {
  key: string
  lastModified: number
}

/** Every object under `prefix`, paged with ListObjectsV2. */
export async function listArchive(store: ArchiveStore, prefix: string): Promise<ArchivedObject[]> {
  const bucket = store.bucket ?? ARCHIVE_BUCKET
  const out: ArchivedObject[] = []
  let token = ''
  for (let page = 0; page < 1000 && out.length < MAX_LISTED; page++) {
    const res = await get(store, `/${bucket}`, { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) })
    const xml = await res.text()
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const at = Date.parse(tag(m[1], 'LastModified'))
      out.push({ key: tag(m[1], 'Key'), lastModified: Number.isFinite(at) ? at : 0 })
    }
    token = tag(xml, 'NextContinuationToken')
    if (tag(xml, 'IsTruncated') !== 'true' || !token) break
  }
  return out
}

const isEvent = (e: unknown, namespace: string, job?: string): e is BatchEvent => {
  const o = e as Partial<BatchEvent> | null
  if (!o || typeof o !== 'object' || typeof o.type !== 'string' || typeof o.subject !== 'string') return false
  const [ns, name] = o.subject.split('/')
  return ns === namespace && (!job || name === job)
}

/**
 * One namespace's archived runs — or one job's — the newest `limit` whose time
 * is not before `sinceMs`, oldest first. Ordered and bounded by WHEN each
 * object was written, never the business date in its key (a backfill writes an
 * old date today); an object written before `sinceMs` holds an event that
 * ended before it and is skipped unread.
 */
export async function readArchive(
  store: ArchiveStore,
  q: { namespace: string; job?: string; sinceMs?: number; limit: number },
): Promise<ArchiveRead> {
  let objs: ArchivedObject[]
  try {
    objs = await listArchive(store, q.job ? `${q.namespace}/${q.job}/` : `${q.namespace}/`)
  } catch (e) {
    if (e instanceof StoreError && (e.code === 'NoSuchBucket' || e.code === 'NoCredential')) {
      return { state: 'absent', detail: e.code === 'NoSuchBucket' ? 'Nothing has been archived on this cluster.' : 'This cluster has no object-store credential.' }
    }
    return { state: 'unreachable', detail: `The run-summary archive could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  const problems: string[] = []
  if (objs.length >= MAX_LISTED) problems.push(`The archive holds at least ${MAX_LISTED} runs here; only the first ${MAX_LISTED} in key order were considered.`)
  const keys = objs
    .filter((o) => q.sinceMs === undefined || !o.lastModified || o.lastModified >= q.sinceMs)
    .sort((a, b) => b.lastModified - a.lastModified)
    .map((o) => o.key)
  const events: BatchEvent[] = []
  for (let i = 0; i < keys.length && events.length < q.limit; i += PARALLEL) {
    await Promise.all(keys.slice(i, i + PARALLEL).map(async (key) => {
      try {
        const body = await (await get(store, `/${store.bucket ?? ARCHIVE_BUCKET}/${key}`)).json()
        if (!isEvent(body, q.namespace, q.job)) throw new Error('not an adhar.batch event of this job')
        const at = Date.parse(body.time ?? '')
        if (q.sinceMs !== undefined && Number.isFinite(at) && at < q.sinceMs) return
        events.push(body)
      } catch (e) {
        problems.push(`archive object ${key}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }))
  }
  events.sort((a, b) => (Date.parse(a.time ?? '') || 0) - (Date.parse(b.time ?? '') || 0))
  return { state: 'read', events: events.slice(Math.max(0, events.length - q.limit)), problems }
}

/* ─────────────────────────── the console's store ─────────────────────────── */

let cachedCreds: { at: number; creds: ArchiveCredentials | null } | undefined

/** `root-creds`, read live as the console, kept for five minutes. */
async function consoleCredentials(): Promise<ArchiveCredentials | null> {
  if (cachedCreds && Date.now() - cachedCreds.at < CREDENTIAL_TTL_MS) return cachedCreds.creds
  const token = getK8sServiceToken()
  if (!token) return null
  const res = await apiServerFetch(token, CREDENTIAL_PATH)
  let creds: ArchiveCredentials | null = null
  if (res.ok) {
    const s = (await res.json().catch(() => ({}))) as { data?: Record<string, string> }
    const b64 = (v?: string) => (v ? new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))) : '')
    const accessKey = b64(s.data?.rootUser)
    const secretKey = b64(s.data?.rootPassword)
    creds = accessKey && secretKey ? { accessKey, secretKey } : null
  } else {
    await res.body?.cancel()
  }
  cachedCreds = { at: Date.now(), creds }
  return creds
}

export function resetArchiveCredentials(): void {
  cachedCreds = undefined
}

/** The platform's archive: `BATCH_ARCHIVE_URL`, else RustFS in the cluster; none outside one. */
export function consoleArchiveStore(): ArchiveStore | null {
  const endpoint = Deno.env.get('BATCH_ARCHIVE_URL') || (Deno.env.get('KUBERNETES_SERVICE_HOST') ? ARCHIVE_DEFAULT_ENDPOINT : '')
  if (!endpoint) return null
  return { endpoint, bucket: Deno.env.get('BATCH_ARCHIVE_BUCKET') || ARCHIVE_BUCKET, credentials: consoleCredentials }
}
