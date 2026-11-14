import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { type ReportConfigMap, scheduleServices } from '../../data/batch-schedules-model.ts'
import { type NamespaceSchedules, schedulesKey } from '../../data/batch-schedules.ts'
import type { BatchJobList, BatchJobXR } from '../../data/batch-model.ts'
import { Batch } from '../../views/batch.tsx'
import { InServiceSchedulesView } from './in-service-schedules.tsx'

/**
 * The in-service group on Develop → Batch → Jobs (CON-Q.3), rendered from the
 * schedule reports: what a row says, that it is grouped by application, that it
 * links to the service's logs and dashboard, and that it offers no action at
 * all. The page half is AQ.8's offline half: a caller who may list the
 * namespace's ConfigMaps sees the schedules, one who may not sees nothing.
 */

const SAMPLE = Deno.readTextFileSync(new URL('../../data/testdata/batch/schedules-report-v1.json', import.meta.url))
const NOW = Date.parse('2026-11-14T09:01:00Z')
const GRAFANA = 'https://grafana.adhar.example'

const cm = (data: string, o: { name?: string; namespace?: string; application?: string } = {}): ReportConfigMap => ({
  metadata: {
    name: o.name ?? 'importer-batch-schedules',
    namespace: o.namespace ?? 'prod',
    labels: { 'adhar.io/batch-schedules': 'true', 'adhar.io/application': o.application ?? 'importer', 'app.kubernetes.io/managed-by': 'adhar-kit' },
  },
  data: { 'schedules.json': data },
})

const view = (cms: ReportConfigMap[], grafana = GRAFANA) =>
  renderToStaticMarkup(<InServiceSchedulesView services={scheduleServices(cms, { now: NOW, envByNamespace: new Map([['prod', 'prod'], ['dev', 'dev']]) })} now={NOW} grafana={grafana} />)

/** Words that would be an action on an in-service run: none may appear. */
const ACTIONS = ['Run now', 'Stop', 'Restart', 'Resume', 'Hold', 'Release', '<button']

Deno.test('row: job, triggers in words with zone, calendar and misfire, next fire, last run, replicas', () => {
  const html = view([cm(SAMPLE)])
  assertStringIncludes(html, 'In-service schedules')
  assertStringIncludes(html, 'importJob')
  assertStringIncludes(html, 'import-job')
  assertStringIncludes(html, 'Every day at 01:30')
  assertStringIncludes(html, 'title="0 30 1 ? * *"')
  assertStringIncludes(html, 'Asia/Singapore · calendar sg-business · misfire latest')
  assertStringIncludes(html, '1 live replica')
  assertStringIncludes(html, 'scheduler <span class="font-mono">importer</span>')
  assertStringIncludes(html, 'Completed')
  assertStringIncludes(html, 'import-job-09932cb3')
  assertStringIncludes(html, '11m 12s')
  assertStringIncludes(html, 'in 56h 29m')
})

Deno.test('row: read-only — no action of any kind, only where to look', () => {
  const html = view([cm(SAMPLE)])
  for (const a of ACTIONS) assert(!html.includes(a), `in-service rows offer no "${a}"`)
  assertStringIncludes(html, 'Logs of this run')
  assertStringIncludes(html, 'Dashboard')
  assertStringIncludes(html, `href="${GRAFANA}/d/app-importer?var-env=prod"`)
  const logs = /href="([^"]*explore[^"]*)"/.exec(html)?.[1] ?? ''
  assertStringIncludes(decodeURIComponent(logs.replaceAll('&amp;', '&')), '|= \\"import-job-09932cb3\\"')
  // Without Grafana there is nothing to link to, and nothing pretends there is.
  const bare = view([cm(SAMPLE)], '')
  assert(!bare.includes('Logs'), 'no logs link without Grafana')
  assert(!bare.includes('Dashboard'))
})

Deno.test('group: by application, each service under it by environment', () => {
  const billing = JSON.stringify({ v: 1, scheduler: 'billing', instances: [], jobs: [{ job: 'invoiceJob', triggers: [{ key: 'adhar-batch-config.invoice-job.hourly', kind: 'interval', every: '1h', next: '2026-11-14T10:00:00Z' }] }] })
  const html = view([cm(SAMPLE, { namespace: 'prod' }), cm(billing, { name: 'billing-batch-schedules', namespace: 'prod', application: 'billing' }), cm(SAMPLE, { namespace: 'dev' })])
  const headers = [...html.matchAll(/scope="rowgroup"[^>]*>([^<]+)</g)].map((m) => m[1])
  assertEquals(headers, ['billing', 'importer'])
  assert(html.indexOf('>dev<') < html.indexOf('>prod<', html.indexOf('>importer<')), 'dev before prod under importer')
  assertStringIncludes(html, 'Every hour')
  assertStringIncludes(html, 'no live replicas')
  assertStringIncludes(html, '3 jobs in 3 services')
})

Deno.test('flags: truncated, overdue and a report this console cannot read', () => {
  const late = JSON.stringify({ v: 1, truncated: true, jobs: [{ job: 'importJob', triggers: [{ key: 'k.nightly', kind: 'cron', expression: '0 30 1 ? * *', next: '2026-11-14T08:00:00Z' }] }] })
  const html = view([cm(late)])
  assertStringIncludes(html, 'Report truncated')
  assertStringIncludes(html, 'Overdue')
  assertStringIncludes(html, 'was due')
  assertStringIncludes(html, 'Not in the truncated report')
  const v2 = '{"v":2,"jobs":[{"job":"importJob"}]}'
  const raw = view([cm(v2)])
  assertStringIncludes(raw, 'version <span class="font-mono">2</span>')
  assertStringIncludes(raw, 'shown as the service wrote it')
  assertStringIncludes(raw, '{&quot;v&quot;:2,&quot;jobs&quot;:[{&quot;job&quot;:&quot;importJob&quot;}]}')
  assert(!raw.includes('No runs yet'), 'nothing is read out of an unknown version')
  assertStringIncludes(view([cm('{"v":1,')]), 'could not be read')
})

Deno.test('nothing to show renders nothing', () => {
  assertEquals(renderToStaticMarkup(<InServiceSchedulesView services={[]} now={NOW} grafana={GRAFANA} />), '')
})

/* ─────────────────────────── on the page (AQ.8, offline half) ─────────────────────────── */

const CANDIDATES = ['dev', 'prod', 'test']

function page(seed: (qc: QueryClient) => void, ui: ReactNode = <Batch />): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  seed(qc)
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
  qc.clear()
  return html
}

const list = (o: Partial<BatchJobList> = {}): BatchJobList => ({ items: [], scope: 'cluster', namespaces: [], denied: [], installed: true, ...o })
const seedList = (qc: QueryClient, l: BatchJobList) => qc.setQueryData(['batch', 'jobs', CANDIDATES.join(',')], l)
const seedSchedules = (qc: QueryClient, prod: NamespaceSchedules['state']) => {
  for (const ns of CANDIDATES) {
    const items = ns === 'prod' && prod === 'read' ? [cm(SAMPLE)] : []
    qc.setQueryData(schedulesKey(ns), { namespace: ns, state: ns === 'prod' ? prod : 'read', items } satisfies NamespaceSchedules)
  }
}

Deno.test('page: a caller who may list the ConfigMaps sees the schedules, with no BatchJob at all', () => {
  const html = page((qc) => {
    seedList(qc, list())
    seedSchedules(qc, 'read')
  })
  assertStringIncludes(html, 'In-service schedules')
  assertStringIncludes(html, 'importJob')
  assertStringIncludes(html, 'Every day at 01:30')
  assert(!html.includes('No batch jobs yet'), 'a page whose only jobs are in-service is not empty')
})

Deno.test('page: a caller refused the list sees nothing of them — not a row, not an error', () => {
  const html = page((qc) => {
    seedList(qc, list())
    seedSchedules(qc, 'forbidden')
  })
  assert(!html.includes('In-service schedules'))
  assert(!html.includes('importJob'))
  assert(!html.includes('Could not read the schedule reports'))
  assertStringIncludes(html, 'No batch jobs yet')
})

Deno.test('page: beside the BatchJobs, and still there when the BatchJob API is not', () => {
  const job: BatchJobXR = { metadata: { name: 'settlement', namespace: 'prod', labels: { 'adhar.io/application': 'payments' } }, spec: { parameters: { job: 'settlementJob', image: 'img' } } }
  const both = page((qc) => {
    seedList(qc, list({ items: [job], namespaces: ['prod'] }))
    seedSchedules(qc, 'read')
  })
  assertStringIncludes(both, 'settlementJob')
  assertStringIncludes(both, 'In-service schedules')
  assert(both.indexOf('settlementJob') < both.indexOf('In-service schedules'), 'the BatchJobs come first')
  const noApi = page((qc) => {
    seedList(qc, list({ installed: false }))
    seedSchedules(qc, 'read')
  })
  assertStringIncludes(noApi, 'Batch is not available on this cluster')
  assertStringIncludes(noApi, 'In-service schedules')
})

function withLocation<T>(search: string, fn: () => T): T {
  const g = globalThis as unknown as { location?: unknown }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: { search, pathname: '/develop', protocol: 'https:' }, configurable: true })
  try {
    return fn()
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had)
    else delete g.location
  }
}

Deno.test('page: the search narrows the in-service group too, and says when nothing is left', () => {
  const seed = (qc: QueryClient) => {
    seedList(qc, list())
    seedSchedules(qc, 'read')
  }
  const hit = withLocation('?section=batch&app=sg-business', () => page(seed))
  assertStringIncludes(hit, 'importJob')
  assert(!hit.includes('No jobs match'))
  const miss = withLocation('?section=batch&app=no-such-thing', () => page(seed))
  assert(!miss.includes('importJob'))
  assertStringIncludes(miss, 'No jobs match')
  assert(!miss.includes('No batch jobs yet'), 'a search that matches nothing is not an empty platform')
})

Deno.test('page: no BatchJob is not "No batch jobs yet" while the schedule reports are still being read', () => {
  // Cold schedule cache: every namespace's read is in flight. The page may not
  // claim it is empty yet, or it flashes the templates prompt at a person whose
  // only jobs are in-service.
  const html = page((qc) => seedList(qc, list()))
  assert(!html.includes('No batch jobs yet'))
})

Deno.test('page: with no BatchJob, a namespace whose reports could not be read is still said', () => {
  // `retryOnMount: false`: a failed query otherwise retries as it mounts and renders as loading.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } } })
  seedList(qc, list())
  for (const ns of ['dev', 'test']) qc.setQueryData(schedulesKey(ns), { namespace: ns, state: 'read', items: [] } satisfies NamespaceSchedules)
  qc.getQueryCache().build(qc, { queryKey: schedulesKey('prod') }).setState({ status: 'error', error: new Error('gateway timeout'), errorUpdatedAt: NOW, fetchStatus: 'idle' })
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}><Batch /></QueryClientProvider>)
  qc.clear()
  assertStringIncludes(html, 'No batch jobs yet')
  assertStringIncludes(html, 'Could not read the schedule reports in prod (gateway timeout)')
})
