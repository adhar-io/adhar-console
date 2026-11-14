import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  type BatchSchedules,
  combineSchedules,
  type NamespaceSchedules,
  readNamespaceSchedules,
  SCHEDULES_POLL_MS,
  SCHEDULES_REFUSED_POLL_MS,
  schedulesInterval,
  schedulesKey,
  schedulesQuery,
  useBatchSchedules,
} from './batch-schedules.ts'

/**
 * The in-service reads and hooks (CON-Q.2) against a fake Kubernetes gateway:
 * one labelled list per namespace as the signed-in user, never cluster-wide and
 * never a write; a watch where the caller may watch and a 30 s poll where not;
 * and a namespace that refuses the list shows nothing.
 */

const SAMPLE = Deno.readTextFileSync(new URL('./testdata/batch/schedules-report-v1.json', import.meta.url))

type Reply = { status: number; body?: unknown }

function fakeGateway(routes: Record<string, Reply>) {
  const seen: Array<{ method: string; url: string }> = []
  const saved = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    seen.push({ method, url })
    const line = `${method} ${url}`
    const key = Object.keys(routes).filter((k) => line.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    const r = key ? routes[key] : { status: 500, body: { message: `no route for ${line}` } }
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, statusText: String(r.status) }))
  }) as typeof fetch
  return { seen, restore: () => (globalThis.fetch = saved) }
}

const CMS = (ns: string) => `GET /api/k8s/api/v1/namespaces/${ns}/configmaps`
const forbidden = { status: 403, body: { kind: 'Status', reason: 'Forbidden', code: 403, message: 'configmaps is forbidden' } }
const notFound = { status: 404, body: { kind: 'Status', reason: 'NotFound', code: 404, message: 'namespaces "gone" not found' } }
const reportCm = (name: string, data = SAMPLE) => ({ metadata: { name, labels: { 'adhar.io/batch-schedules': 'true', 'adhar.io/application': 'importer' } }, data: { 'schedules.json': data } })

Deno.test('read: one labelled list in the namespace, as the user, and nothing else', async () => {
  const g = fakeGateway({ [CMS('shop-prod')]: { status: 200, body: { items: [reportCm('importer-batch-schedules')] } } })
  try {
    const r = await readNamespaceSchedules('shop-prod')
    assertEquals(r.state, 'read')
    assertEquals(r.items.length, 1)
    // The namespace is filled in when the list item omits it.
    assertEquals(r.items[0].metadata.namespace, 'shop-prod')
    assertEquals(g.seen.length, 1)
    const url = new URL(g.seen[0].url, 'https://console.example')
    assertEquals(url.pathname, '/api/k8s/api/v1/namespaces/shop-prod/configmaps')
    assertEquals(url.searchParams.get('labelSelector'), 'adhar.io/batch-schedules=true')
    assert(g.seen.every((s) => s.method === 'GET'), 'reading schedules never writes')
  } finally {
    g.restore()
  }
})

Deno.test('read: 403 is "forbidden" with nothing in it, 404 "absent"; anything else is an error', async () => {
  const g = fakeGateway({ [CMS('shop-prod')]: forbidden, [CMS('gone')]: notFound, [CMS('broken')]: { status: 500, body: { message: 'apiserver unreachable' } } })
  try {
    assertEquals(await readNamespaceSchedules('shop-prod'), { namespace: 'shop-prod', state: 'forbidden', items: [] })
    assertEquals(await readNamespaceSchedules('gone'), { namespace: 'gone', state: 'absent', items: [] })
    await assertRejects(() => readNamespaceSchedules('broken'))
    assert(!g.seen.some((s) => /\/api\/v1\/configmaps/.test(s.url)), 'never asked cluster-wide')
  } finally {
    g.restore()
  }
})

Deno.test('combine: a refused namespace shows nothing — not a row, not an error', () => {
  const read: NamespaceSchedules = { namespace: 'shop-prod', state: 'read', items: [{ ...reportCm('importer-batch-schedules'), metadata: { ...reportCm('importer-batch-schedules').metadata, namespace: 'shop-prod' } }] }
  const refused: NamespaceSchedules = { namespace: 'shop-dev', state: 'forbidden', items: [] }
  const only403 = combineSchedules(['shop-dev'], [{ data: refused, isLoading: false, error: null }])
  assertEquals(only403, { services: [], loading: false, forbidden: ['shop-dev'], failed: [] })
  const mixed = combineSchedules(['shop-dev', 'shop-prod', 'boom'], [
    { data: refused, isLoading: false, error: null },
    { data: read, isLoading: false, error: null },
    { data: undefined, isLoading: false, error: new Error('apiserver unreachable') },
  ])
  assertEquals(mixed.services.map((s) => s.key), ['shop-prod/importer-batch-schedules'])
  assertEquals(mixed.forbidden, ['shop-dev'])
  assertEquals(mixed.failed, [{ namespace: 'boom', message: 'apiserver unreachable' }])
  assertEquals(combineSchedules(['a'], [{ data: undefined, isLoading: true, error: null }]).loading, true)
})

Deno.test('interval: no timer while the watch is live, 30 s while it is not, rarely once refused', () => {
  assertEquals(schedulesInterval(false, 'read'), false)
  assertEquals(schedulesInterval(false, undefined), false)
  // `useWatchSignal` hands back its (≥60 s) fallback when the watch is refused or the socket is down.
  assertEquals(schedulesInterval(60_000, 'read'), SCHEDULES_POLL_MS)
  assertEquals(schedulesInterval(120_000, undefined), SCHEDULES_POLL_MS)
  assertEquals(SCHEDULES_POLL_MS, 30_000)
  assertEquals(schedulesInterval(false, 'forbidden'), SCHEDULES_REFUSED_POLL_MS)
  assertEquals(schedulesInterval(60_000, 'absent'), SCHEDULES_REFUSED_POLL_MS)
})

Deno.test('query: the shared query reads through the gateway and caches per namespace', async () => {
  const g = fakeGateway({ [CMS('shop-prod')]: { status: 200, body: { items: [reportCm('importer-batch-schedules')] } }, [CMS('shop-dev')]: forbidden })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const prod = await qc.fetchQuery({ ...schedulesQuery('shop-prod'), retry: false })
    const dev = await qc.fetchQuery({ ...schedulesQuery('shop-dev'), retry: false })
    assertEquals(prod.items.length, 1)
    assertEquals(dev.state, 'forbidden')
    assertEquals(qc.getQueryData(schedulesKey('shop-prod')), prod)
    assertEquals(schedulesKey('shop-prod'), ['batch', 'schedules', 'shop-prod'])
  } finally {
    g.restore()
    qc.clear()
  }
})

/** Renders `useBatchSchedules` over a seeded cache and hands back what it returned. */
function runHook(namespaces: string[], seed: (qc: QueryClient) => void): BatchSchedules {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seed(qc)
  let out: BatchSchedules | undefined
  function Probe() {
    out = useBatchSchedules(namespaces, { envByNamespace: new Map([['shop-prod', 'prod']]) })
    return null
  }
  renderToStaticMarkup(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>)
  qc.clear()
  return out!
}

Deno.test('hook: rows from every namespace that answered; a 403 namespace adds nothing', () => {
  const out = runHook(['shop-prod', 'shop-dev', 'shop-prod'], (qc) => {
    qc.setQueryData(schedulesKey('shop-prod'), { namespace: 'shop-prod', state: 'read', items: [{ ...reportCm('importer-batch-schedules'), metadata: { ...reportCm('importer-batch-schedules').metadata, namespace: 'shop-prod' } }] } satisfies NamespaceSchedules)
    qc.setQueryData(schedulesKey('shop-dev'), { namespace: 'shop-dev', state: 'forbidden', items: [] } satisfies NamespaceSchedules)
  })
  assertEquals(out.services.map((s) => [s.key, s.environment]), [['shop-prod/importer-batch-schedules', 'prod']])
  assertEquals(out.forbidden, ['shop-dev'])
  assertEquals(out.loading, false)
  const refusedOnly = runHook(['shop-dev'], (qc) => qc.setQueryData(schedulesKey('shop-dev'), { namespace: 'shop-dev', state: 'forbidden', items: [] }))
  assertEquals(refusedOnly.services, [])
  // Before any answer: loading, and no rows invented.
  const cold = runHook(['shop-prod'], () => {})
  assertEquals([cold.loading, cold.services.length], [true, 0])
})
