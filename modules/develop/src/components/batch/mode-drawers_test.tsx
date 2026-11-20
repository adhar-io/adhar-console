import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { type BatchJobXR, jobRows, lineageLabel, modeLabel, modeOfJob, type RunObject, runModeOf, runRow, runRows } from '../../data/batch-model.ts'
import { type DrawerFrame, RunDrawer } from './run-drawer.tsx'
import { JobDrawer } from './job-drawer.tsx'

/**
 * Remote chunking (design 0025 D11): a chunked job is the partitioned SHAPE — an
 * Indexed Job natively, a Volcano gang on Volcano — so the run object's kind cannot
 * say which it is. The definition's `mode` does, and on a run the distribution the
 * composition writes on every pod. These prove the Batch views read both, and say
 * "chunked" where a person looks: the job drawer's Definition and the run drawer.
 */

const NOW = Date.parse('2026-11-03T18:00:00Z')
const DrawerShell: DrawerFrame = ({ header, children, footer }) => <div>{header}{children}{footer}</div>

function mount(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const LABELS = { 'adhar.io/batch-job': 'ledger', 'adhar.io/application': 'ledger', 'adhar.io/environment': 'dev', 'adhar.io/project': 'shop' }

const job = (p: NonNullable<BatchJobXR['spec']>['parameters'] = {}): BatchJobXR => ({
  metadata: { name: 'ledger', namespace: 'dev', labels: LABELS },
  spec: { parameters: { job: 'ledgerJob', image: 'img', ...p } },
})

const CHUNKED = job({
  mode: 'chunked',
  workers: 3,
  chunking: { requestQueue: 'ledger-chunks', replyQueue: 'ledger-replies' },
  lineage: { enabled: true, credentialsSecretRef: { name: 'ledger-om' } },
})

/** A run as the composition renders it: an Indexed Job, or a gang, whose pods say the distribution. */
const run = (name: string, opts: { indexed?: boolean; volcano?: boolean; distribution?: string }): RunObject => {
  const env = [{ name: 'ADHAR_BATCH_PARAMS', value: '{"businessDate":"2026-11-03"}' }, ...(opts.distribution ? [{ name: 'ADHAR_BATCH_DISTRIBUTION', value: opts.distribution }] : [])]
  const template = { spec: { containers: [{ name: 'batch', image: 'img', env }] } }
  return {
    apiVersion: opts.volcano ? 'batch.volcano.sh/v1alpha1' : 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: 'dev', creationTimestamp: '2026-11-03T17:30:00Z', labels: { ...LABELS, 'adhar.io/batch-trigger': 'manual' } },
    spec: opts.volcano
      ? { tasks: [{ name: 'manager', replicas: 1, template }, { name: 'worker', replicas: 3, template }] }
      : { ...(opts.indexed ? { completionMode: 'Indexed', completions: 4, parallelism: 4 } : {}), template },
    status: { startTime: '2026-11-03T17:30:00Z', active: 1, ready: 1 },
  }
}

Deno.test('mode: a definition says its mode, single by default', () => {
  assertEquals(modeOfJob(job()), 'single')
  assertEquals(modeOfJob(CHUNKED), 'chunked')
  assertEquals(modeLabel(CHUNKED), 'Remote chunking: 1 manager + 3 workers over RabbitMQ (chunks on Queue ledger-chunks, replies on Queue ledger-replies)')
  // workers and gridSize take the XRD's defaults (2, D25; 4 × workers).
  assertEquals(modeLabel(job({ mode: 'partitioned' })), "Partitioned: 1 manager + 2 workers, 8 partitions over the job repository's database")
  assertEquals(modeLabel(job()), 'Single: one pod')
  assertEquals(lineageLabel(CHUNKED), "OpenLineage to the platform's OpenMetadata, token from Secret ledger-om")
  assertEquals(lineageLabel(job({ lineage: { enabled: true, url: 'http://marquez:5000' } })), 'OpenLineage to http://marquez:5000')
  assertEquals(lineageLabel(job()), undefined)
})

Deno.test('mode: a run is chunked when its pods say so, whatever its kind', () => {
  assertEquals(runModeOf(run('a', {})), 'single')
  assertEquals(runModeOf(run('b', { indexed: true })), 'partitioned')
  assertEquals(runModeOf(run('c', { indexed: true, distribution: 'chunked' })), 'chunked')
  assertEquals(runModeOf(run('d', { volcano: true })), 'partitioned')
  assertEquals(runModeOf(run('e', { volcano: true, distribution: 'chunked' })), 'chunked')
  assertEquals(runRow(run('f', { volcano: true, distribution: 'chunked' }), [], NOW).mode, 'chunked')
})

Deno.test('job drawer: the Definition says remote chunking, its Queues and its lineage', () => {
  const row = jobRows([CHUNKED], runRows([], [], NOW), { now: NOW })[0]
  const html = mount(() => {}, <JobDrawer row={row} now={NOW} tab='overview' onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)
  assertStringIncludes(html, 'Remote chunking: 1 manager + 3 workers over RabbitMQ')
  assertStringIncludes(html, 'ledger-chunks')
  assertStringIncludes(html, 'ledger-replies')
  assertStringIncludes(html, 'OpenLineage to the platform')
  const plain = mount(() => {}, <JobDrawer row={jobRows([job()], [], { now: NOW })[0]} now={NOW} tab='overview' onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)
  assert(!plain.includes('OpenLineage'), 'a job without lineage shows no lineage line')
})

Deno.test('run drawer: a chunked run says so, a single one says nothing about it', () => {
  const open = (r: RunObject) =>
    mount((qc) => {
      qc.setQueryData(['batch', 'run', 'dev', r.metadata.name, 'Job'], r)
      qc.setQueryData(['batch', 'run-pods', 'dev', r.metadata.name, 'Job'], { items: [], forbidden: false })
    }, <RunDrawer namespace='dev' name={r.metadata.name} job={CHUNKED} existingNames={[]} onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)
  assertStringIncludes(open(run('ledger-aa', { indexed: true, distribution: 'chunked' })), 'Remote chunking (1 manager + workers over RabbitMQ)')
  const single = open(run('ledger-bb', {}))
  assert(!single.includes('Remote chunking') && !single.includes('Partitioned ('), 'a single run carries no mode line')
})
