import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Batch } from './batch.tsx'
import { HistoryTable, HistoryUnavailable } from './batch-history.tsx'
import { historyKey } from '../data/batch-history.ts'
import type { BatchEvent, HistoryRead } from '../data/batch-history-model.ts'
import type { BatchJobList, BatchJobXR } from '../data/batch-model.ts'

/**
 * Develop → Batch → History, rendered from data. The page's one claim that can
 * mislead is the empty table: "no events" must mean nothing happened where this
 * person can see, so every other reason the table could be empty — no bus, a
 * bridge that did not answer, a cut stream, an access review that failed — has
 * its own words here and is asserted NOT to read as empty.
 */

function render(ui: ReactNode, seed: (qc: QueryClient) => void = () => {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const ev = (type: string, subject: string, time: string, data: Record<string, unknown> = {}): BatchEvent => ({ id: `${subject}|${type}|${time}`, type: `io.adhar.batch.${type}`, subject, time, data })

const EVENTS: BatchEvent[] = [
  ev('run.failed', 'prod/importer', '2026-10-01T02:05:00Z', {
    run: { name: 'importer-09932cb3', trigger: 'schedule', actor: 'system:serviceaccount:prod:importer-batch' },
    springBatch: { executionId: 97, businessDate: '2026-10-01' },
    outcome: { reason: 'skip-limit', exitCode: 3 },
    counts: { read: 120, written: 100, deadLettered: 20 },
    durationSeconds: 300,
  }),
  ev('run.succeeded', 'prod/importer', '2026-10-02T02:10:00Z', { run: { name: 'importer-held0001', trigger: 'manual', actor: 'oidc:alice@example.com' }, durationSeconds: 600 }),
  ev('schedule.missed', 'dev/settle', '2026-10-03T01:00:00Z', { schedule: { slot: '2026-10-03T01:00:00Z' } }),
]

const read = (o: Partial<Extract<HistoryRead, { state: 'read' }>> = {}): HistoryRead => ({ state: 'read', events: EVENTS, total: EVENTS.length, truncated: false, degraded: false, ...o })

const table = (r: HistoryRead | undefined, props: Partial<Parameters<typeof HistoryTable>[0]> = {}) =>
  render(<HistoryTable read={r} loading={false} since='7d' onSince={() => {}} {...props} />)

Deno.test('history: each event is a row — what happened, to which run, for which date, and why', () => {
  const html = table(read(), { envByNamespace: new Map([['prod', 'production']]) })
  for (const s of ['Failed', 'Succeeded', 'Slot missed', 'importer-09932cb3', '2026-10-01', 'skip-limit · exit 3 · read 120 written 100 · 20 dead-lettered', '5m 0s', 'oidc:alice@example.com', 'slot 2026-10-03T01:00:00Z']) {
    assertStringIncludes(html, s)
  }
  assertStringIncludes(html, '3 events')
  // The environment's name where the page knows it, the namespace where it does not.
  assertStringIncludes(html, '>production<')
  assertStringIncludes(html, '>dev<')
  // Newest first.
  assert(html.indexOf('Slot missed') < html.indexOf('Succeeded') && html.indexOf('Succeeded') < html.indexOf('>Failed<'), 'newest first')
})

Deno.test('history: a run opens only while the cluster still holds it; a job only when it is on the page', () => {
  const html = table(read(), { heldRuns: new Set(['prod/importer-held0001']), jobKeys: new Set(['prod/importer']), onOpenRun: () => {}, onOpenJob: () => {} })
  assertMatch(html, /<button[^>]*>importer-held0001<\/button>/)
  assertMatch(html, /<span[^>]*title="This run is no longer in the cluster"[^>]*>importer-09932cb3<\/span>/)
  assertMatch(html, /<button[^>]*>importer<\/button>/)
  assert(!/<button[^>]*>settle<\/button>/.test(html), 'a job this page does not list has no drawer to open')
  // With no handlers nothing is a button.
  assert(!table(read(), { heldRuns: new Set(['prod/importer-held0001']) }).includes('<button type="button" class="font-mono'))
})

Deno.test('history: no bus is said plainly, and is not an empty history', () => {
  const html = table({ state: 'unavailable', reason: 'no-bus', detail: 'This cluster has no event bridge.' })
  assertStringIncludes(html, 'This cluster keeps no batch history')
  assertStringIncludes(html, 'kafka-operator')
  assert(!html.includes('No batch events in this period'))
  assert(!html.includes('could not be read'), 'an absent bus is not a failure')
})

Deno.test('history: a bridge that did not answer is an error with its reason, never "nothing ran"', () => {
  for (const reason of ['unreachable', 'forbidden', 'no-identity', 'unreadable']) {
    const html = render(<HistoryUnavailable read={{ state: 'unavailable', reason, detail: 'bridge GET /consumers: HTTP 503' }} />)
    assertStringIncludes(html, 'The batch history could not be read')
    assertStringIncludes(html, 'bridge GET /consumers: HTTP 503')
    assertStringIncludes(html, 'This is not “nothing ran”')
    assert(!html.includes('No batch events'))
  }
  const failed = table(undefined, { error: new Error('Your session has ended. Sign in again to read the batch history.'), onRetry: () => {} })
  assertStringIncludes(failed, 'Your session has ended')
  assertStringIncludes(failed, 'Retry')
  assert(!failed.includes('No batch events'))
})

Deno.test('history: empty is said only for a stream that was read, and names what would have been there', () => {
  const html = table(read({ events: [], total: 0 }))
  assertStringIncludes(html, 'No batch events in this period')
  assertStringIncludes(html, 'in the namespaces you can see')
  assertStringIncludes(html, '0 events')
  // While loading, nothing is claimed.
  assert(!render(<HistoryTable read={undefined} loading since='7d' onSince={() => {}} />).includes('No batch events in this period'))
})

Deno.test('history: what was left out is named — a limit, a cut stream, an unanswered access review', () => {
  const limited = table(read({ total: 4_200 }))
  assertStringIncludes(limited, 'Showing the newest 3 of 4200 events in this period')
  assert(!table(read()).includes('Showing the newest'))
  const cut = table(read({ truncated: true }))
  assertStringIncludes(cut, 'the oldest events are not here')
  assertStringIncludes(cut, 'adhar batch history')
  const degraded = table(read({ degraded: true }))
  assertStringIncludes(degraded, 'Access to some namespaces could not be checked')
  assertStringIncludes(degraded, 'not the same as nothing having happened there')
  const clean = table(read())
  assert(!clean.includes('oldest events are not here') && !clean.includes('could not be checked'))
})

Deno.test('history: the period is a choice, kept as the BFF’s `since`', () => {
  const html = table(read(), { since: '30d' })
  assertMatch(html, /<option value="30d" selected="">Last 30 days<\/option>/)
  for (const v of ['24h', '7d', '90d']) assertStringIncludes(html, `<option value="${v}"`)
})

/* ─────────────────────────── on the page ─────────────────────────── */

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

const job = (name: string): BatchJobXR => ({ metadata: { name, namespace: 'prod', labels: { 'adhar.io/application': name, 'adhar.io/environment': 'prod' } }, spec: { parameters: { job: 'importJob', image: 'img' } } })
const seedPage = (qc: QueryClient) => {
  const list: BatchJobList = { items: [job('importer')], scope: 'cluster', namespaces: ['prod'], denied: [], installed: true }
  qc.setQueryData(['batch', 'jobs', 'dev,prod,test'], list)
  qc.setQueryData(['batch', 'runs', 'cluster', 'prod'], { runs: [], pods: [], partial: false, forbidden: false, volcano: false, podsUnknown: false })
}

Deno.test('page: History and Tonight are tabs of Batch, and ?view=history shows the events the BFF returned', () => {
  const jobs = render(<Batch />, seedPage)
  for (const tab of ['Jobs', 'Runs', 'Tonight', 'History']) assertMatch(jobs, new RegExp(`role="tab"[^>]*>(<[^>]+>)*${tab}<`))
  const html = withLocation('?section=batch&view=history', () =>
    render(<Batch />, (qc) => {
      seedPage(qc)
      // The page asks for the last seven days, newest 2,000.
      qc.setQueryData(historyKey({ since: '7d', limit: 2_000 }), read())
    }))
  assertStringIncludes(html, 'importer-09932cb3')
  assertStringIncludes(html, 'Slot missed')
  assertEquals(html.includes('No batch events in this period'), false)
})
