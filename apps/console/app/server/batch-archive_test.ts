import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { ARCHIVE_BUCKET, type ArchiveRead, type ArchiveStore, readArchive, signGet, type StoreFetch } from './batch-archive.ts'
import { type BatchEvent, handleBatchHistory, type HistoryDeps } from './batch-history.ts'
import type { K8sIdentity } from './k8s/gateway.ts'

/**
 * The run-summary archive as the console's second history source (design 0025
 * Phase 4): SigV4 exactly as the platform's Go signer computes it, the read
 * ordered by when each run was written, and the handler merging it under the
 * same per-namespace access as the stream.
 */

const CREDS = { accessKey: 'rustfsadmin', secretKey: 's3cret/+=' }
const AT = new Date('2026-11-20T01:02:03Z')

// Vectors from aws-sdk-go-v2's v4 signer (DisableURIPathEscaping, service s3, us-east-1), which the batch
// observer and `adhar batch history` sign with: the console must agree with them byte for byte.
const VECTORS: Array<[string, string]> = [
  [
    'http://rustfs.adhar-system.svc.cluster.local:9000/adhar-batch-archive?list-type=2&prefix=prod%2Fimporter%2F',
    '2122037e7b31ef6ce7b1278d77de0679b6bbdd7288f4dd7d5ea3374fdaf0e97d',
  ],
  [
    'http://rustfs.adhar-system.svc.cluster.local:9000/adhar-batch-archive/prod/importer/2026-11-03/importer-09932cb3.json',
    'e387c05e6ed796a8e87a315b91767b722654ad88df35cf9d2daabbdda2cf0c07',
  ],
  [
    'http://127.0.0.1:9000/adhar-batch-archive?continuation-token=a%2Bb%3D&list-type=2&prefix=team%20a%2F',
    '0b5c3b74e4d5f66bc603e7d54edc37af5650f88dcf308f1f12977a94dbe78624',
  ],
]

Deno.test('archive: SigV4 agrees with the Go signer the observer writes with', async () => {
  for (const [url, signature] of VECTORS) {
    const h = await signGet(new URL(url), CREDS, AT)
    assertEquals(
      h.authorization,
      `AWS4-HMAC-SHA256 Credential=rustfsadmin/20261120/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
      url,
    )
    assertEquals(h['x-amz-date'], '20261120T010203Z')
  }
  // The canonical query is sorted: the order a URL was written in changes nothing.
  const reordered = await signGet(new URL(VECTORS[0][0].replace('list-type=2&prefix=prod%2Fimporter%2F', 'prefix=prod%2Fimporter%2F&list-type=2')), CREDS, AT)
  assert(reordered.authorization.endsWith(`Signature=${VECTORS[0][1]}`))
})

const ev = (subject: string, type: string, time: string, id = `${subject}|${type}|${time}`): BatchEvent => ({
  specversion: '1.0',
  id,
  type: `io.adhar.batch.${type}`,
  source: '/adhar/test/batch-observer',
  subject,
  time,
  data: { run: { name: id } },
})

/** An in-memory bucket behind the S3 calls the reader makes, checking each is signed for it. */
function fakeStore(objects: Record<string, { body: unknown; modified: string }>, opts: { bucket?: boolean; page?: number } = {}) {
  const calls: string[] = []
  const fetch: StoreFetch = async (url, headers) => {
    calls.push(`${url.pathname}${url.search}`)
    const again = await signGet(url, CREDS, AT)
    if (headers.authorization !== again.authorization) return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })
    if (opts.bucket === false) return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
    const key = url.pathname.slice(`/${ARCHIVE_BUCKET}/`.length)
    if (url.pathname !== `/${ARCHIVE_BUCKET}`) {
      const o = objects[key]
      return o ? new Response(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
    }
    const prefix = url.searchParams.get('prefix') ?? ''
    const keys = Object.keys(objects).filter((k) => k.startsWith(prefix)).sort()
    const start = Number(url.searchParams.get('continuation-token') ?? 0)
    const end = Math.min(start + (opts.page ?? 1000), keys.length)
    const contents = keys.slice(start, end).map((k) => `<Contents><Key>${k}</Key><LastModified>${objects[k].modified}</LastModified></Contents>`).join('')
    const more = end < keys.length ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${end}</NextContinuationToken>` : '<IsTruncated>false</IsTruncated>'
    return new Response(`<?xml version="1.0"?><ListBucketResult>${contents}${more}</ListBucketResult>`)
  }
  const store: ArchiveStore = { endpoint: 'http://rustfs:9000', credentials: () => Promise.resolve(CREDS), fetch, now: () => AT }
  return { store, calls }
}

function twelveDays() {
  const objects: Record<string, { body: unknown; modified: string }> = {}
  for (let d = 1; d <= 12; d++) {
    const day = String(d).padStart(2, '0')
    const time = `2026-11-${day}T02:00:00Z`
    objects[`prod/importer/2026-11-${day}/r${day}.json`] = { body: ev('prod/importer', 'run.succeeded', time, `r${day}`), modified: `2026-11-${day}T02:00:01Z` }
  }
  // A backfill of an OLD date, finished last: the newest run of all.
  objects['prod/importer/2026-01-15/backfill.json'] = { body: ev('prod/importer', 'run.succeeded', '2026-11-13T02:00:00Z', 'backfill'), modified: '2026-11-13T02:00:01Z' }
  objects['prod/importer/2026-11-30/garbage.json'] = { body: 'not json', modified: '2026-11-14T00:00:00Z' }
  objects['prod/importer-eu/2026-11-01/other.json'] = { body: ev('prod/importer-eu', 'run.failed', '2026-11-01T02:00:00Z', 'other'), modified: '2026-11-15T00:00:00Z' }
  return objects
}

const ids = (r: ArchiveRead) => (r.state === 'read' ? r.events.map((e) => e.id).join(',') : r.state)

Deno.test('archive: the newest WRITTEN runs, not the newest dated, across pages', async () => {
  const { store } = fakeStore(twelveDays(), { page: 3 })
  const two = await readArchive(store, { namespace: 'prod', job: 'importer', limit: 2 })
  assertEquals(ids(two), 'r12,backfill')
  assert(two.state === 'read' && two.problems.length === 1 && two.problems[0].includes('garbage.json'))
  const since = await readArchive(store, { namespace: 'prod', job: 'importer', sinceMs: Date.parse('2026-11-11T00:00:00Z'), limit: 100 })
  assertEquals(ids(since), 'r11,r12,backfill')
  // A job's read is exactly that job: importer-eu shares the prefix `prod/importer` but not `prod/importer/`.
  assert(!ids(await readArchive(store, { namespace: 'prod', job: 'importer', limit: 100 })).includes('other'))
})

Deno.test('archive: no bucket is an archive that is absent, not an error', async () => {
  const { store } = fakeStore({}, { bucket: false })
  assertEquals((await readArchive(store, { namespace: 'prod', limit: 10 })).state, 'absent')
  const keyless: ArchiveStore = { ...store, credentials: () => Promise.resolve(null) }
  assertEquals((await readArchive(keyless, { namespace: 'prod', limit: 10 })).state, 'absent')
})

/* ─────────────────────────── the handler ─────────────────────────── */

const alice: K8sIdentity = { token: 't', user: { id: 'alice', name: 'Alice', email: 'alice@example.com' } }
const BOTH = ev('prod/importer', 'run.failed', '2026-11-03T02:00:00Z', 'both')
const OLD = ev('prod/importer', 'run.succeeded', '2026-03-01T02:00:00Z', 'old')

function deps(over: Partial<HistoryDeps> = {}): HistoryDeps & { archived: string[] } {
  const archived: string[] = []
  return {
    archived,
    identity: () => Promise.resolve(alice),
    read: () => Promise.resolve({ state: 'read', events: [BOTH, ev('payments/ledger', 'run.failed', '2026-11-03T03:00:00Z')], foreign: 0, truncated: false }),
    allowed: (_id, namespaces) => Promise.resolve({ results: namespaces.map((n) => n === 'prod'), degraded: false }),
    archive: (q) => {
      archived.push(`${q.namespace}/${q.job ?? ''}`)
      return Promise.resolve({ state: 'read', events: [OLD, BOTH], problems: [] })
    },
    now: () => Date.parse('2026-11-10T00:00:00Z'),
    ...over,
  }
}

const get = (query: string, d: HistoryDeps) => handleBatchHistory(new Request(`https://console.example/api/batch/history${query}`), d).then((r) => r.json())

Deno.test('handler: a job’s archived runs join its stream, each once, the archived ones marked', async () => {
  const d = deps()
  const body = await get('?namespace=prod&job=importer', d)
  assertEquals(body.state, 'read')
  assertEquals(body.events.map((e: BatchEvent) => [e.id, e.archived === true]), [['old', true], ['both', false]])
  assertEquals(body.archive, { state: 'read', events: 2 })
  assertEquals(d.archived, ['prod/importer'])
})

Deno.test('handler: with no bus, a job’s history is the archive alone, and says so', async () => {
  const d = deps({ read: () => Promise.resolve({ state: 'unavailable', reason: 'no-bus', detail: 'opt-in' }) })
  const body = await get('?namespace=prod&job=importer', d)
  assertEquals(body.state, 'read')
  assertEquals(body.events.map((e: BatchEvent) => e.id), ['old', 'both'])
  assertEquals(body.stream, { state: 'unavailable', reason: 'no-bus', detail: 'opt-in' })
  // Without a job named, there is nothing to read the archive for: the stream's answer stands.
  const all = await get('', d)
  assertEquals([all.state, all.reason, all.archive?.state], ['unavailable', 'no-bus', 'skipped'])
})

Deno.test('handler: the archive is never read for a namespace the caller may not see', async () => {
  const d = deps()
  const body = await get('?namespace=payments&job=ledger', d)
  assertEquals(body.events, [])
  assertEquals(body.archive.state, 'skipped')
  assertEquals(d.archived, [])
})
