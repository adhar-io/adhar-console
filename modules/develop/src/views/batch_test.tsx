import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { accessCheckKey } from '@adhar/auth'
import { canResource } from '@adhar/shell-ui'
import { Batch } from './batch.tsx'
import { type BatchJobList, type BatchJobXR, actionGates, type RunObject, runRow, type RunKind, type RunPod } from '../data/batch-model.ts'
import type { RunList } from '../data/batch-api.ts'
import { BatchLoadError } from '../components/batch/bits.tsx'
import { JobActionsBar } from '../components/batch/job-drawer.tsx'
import { RunActionsBar } from '../components/batch/run-drawer.tsx'

/**
 * The page itself, rendered from a seeded query cache: what a person sees in each
 * state, that nothing is shown which did not come from the cluster, and that a
 * blocked action is absent rather than disabled.
 */

const CANDIDATES = 'dev,prod,test'

function page(seed: (qc: QueryClient) => void, ui: ReactNode = <Batch />): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const list = (o: Partial<BatchJobList> = {}): BatchJobList => ({ items: [], scope: 'cluster', namespaces: [], denied: [], installed: true, ...o })
const seedList = (qc: QueryClient, l: BatchJobList) => qc.setQueryData(['batch', 'jobs', CANDIDATES], l)

Deno.test('state: while loading it says nothing it does not know', () => {
  const html = page(() => {})
  assertStringIncludes(html, 'Batch')
  for (const claim of ['not available', 'No batch jobs yet', 'do not have access']) assert(!html.includes(claim), claim)
})

Deno.test('state: the API not installed is said plainly, and offers nothing to create', () => {
  const html = page((qc) => seedList(qc, list({ installed: false })))
  assertStringIncludes(html, 'Batch is not available on this cluster')
  assertStringIncludes(html, 'batchjobs.platform.adhar.io')
  assert(!html.includes('No batch jobs yet'))
  assert(!html.includes('New batch job'))
})

Deno.test('state: forbidden is not "no jobs"', () => {
  const html = page((qc) => seedList(qc, list({ scope: 'namespaces', namespaces: ['dev', 'prod'], denied: ['dev', 'prod'] })))
  assertStringIncludes(html, 'You do not have access to batch jobs here')
  assertStringIncludes(html, 'dev, prod')
  assertStringIncludes(html, 'does not mean there are none')
  assert(!html.includes('No batch jobs yet'))
})

Deno.test('state: an empty cluster points at the templates', () => {
  const html = page((qc) => seedList(qc, list()))
  assertStringIncludes(html, 'No batch jobs yet')
  assertStringIncludes(html, '/catalog?section=create')
})

Deno.test('state: a failed read says so and offers a retry', () => {
  // Rendered directly: a query with an error refetches as it mounts, so a seeded
  // cache cannot hold the page in this state. `pageStateOf` picks it (batch-model_test).
  const html = page(() => {}, <BatchLoadError error={new Error('apiserver unreachable')} onRetry={() => {}} />)
  assertStringIncludes(html, 'Could not load batch jobs')
  assertStringIncludes(html, 'apiserver unreachable')
  assertStringIncludes(html, 'Retry')
})

const job = (name: string, over: Partial<BatchJobXR> = {}, p: NonNullable<BatchJobXR['spec']>['parameters'] = {}): BatchJobXR => ({
  ...over,
  metadata: { name, namespace: 'prod', labels: { 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod', 'adhar.io/project': 'shop' }, ...(over.metadata ?? {}) },
  spec: { parameters: { job: 'importJob', image: 'img', ...p } },
})

const seedRuns = (qc: QueryClient, namespaces: string[], data: Partial<RunList>) =>
  qc.setQueryData(['batch', 'runs', 'cluster', namespaces.join(',')], { runs: [], pods: [], partial: false, forbidden: false, volcano: false, podsUnknown: false, ...data })

const run = (name: string, status: RunObject['status']): RunObject => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: { name, namespace: 'prod', creationTimestamp: '2026-11-03T17:30:00Z', labels: { 'adhar.io/batch-job': 'importer', 'adhar.io/batch-trigger': 'manual', 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod' }, annotations: { 'adhar.io/batch-actor': 'alice@example.com' } },
  status,
})

Deno.test('jobs: a row shows what the XR and its runs say, grouped by application', () => {
  const html = page((qc) => {
    seedList(qc, list({ namespaces: ['prod'], items: [job('importer', { metadata: { name: 'importer', namespace: 'prod', annotations: { 'adhar.io/batch-hold': 'late file' }, labels: { 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod', 'adhar.io/project': 'shop' } } }, { schedule: { cron: '30 1 * * *', timeZone: 'Asia/Singapore' }, sla: { maxDuration: '1h' } })] }))
    seedRuns(qc, ['prod'], { runs: [run('importer-aa', { startTime: '2026-11-03T17:30:00Z', conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-03T17:40:00Z' }] })] })
  })
  assertStringIncludes(html, 'project shop')
  assertStringIncludes(html, 'importJob')
  assertStringIncludes(html, 'Every day at 01:30')
  assertStringIncludes(html, 'Asia/Singapore')
  assertStringIncludes(html, 'Held')
  assertStringIncludes(html, 'Failed')
  assertStringIncludes(html, '10m 0s')
  assertStringIncludes(html, 'Within SLA')
  // Held: the next-run column promises nothing.
  assert(!html.includes('in 1'), 'a held job shows no next run')
})

Deno.test('jobs: with no pods read yet a job is "No runs yet", not a fabricated run', () => {
  const html = page((qc) => {
    seedList(qc, list({ namespaces: ['prod'], items: [job('importer')] }))
    seedRuns(qc, ['prod'], {})
  })
  assertStringIncludes(html, 'No runs yet')
  assertStringIncludes(html, 'On demand')
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

Deno.test('runs: columns come from the object, its actor from Kyverno’s stamp', () => {
  const html = withLocation('?section=batch&view=runs', () =>
    page((qc) => {
      seedList(qc, list({ namespaces: ['prod'], items: [job('importer')] }))
      seedRuns(qc, ['prod'], {
        runs: [run('importer-09932cb3', { startTime: '2026-11-03T17:30:00Z', active: 1, ready: 1 })],
      })
    }))
  assertStringIncludes(html, 'importer-09932cb3')
  assertStringIncludes(html, 'manual')
  assertStringIncludes(html, 'alice@example.com')
  assertStringIncludes(html, 'Running')
})

Deno.test('runs: a refused list and an empty one are different things', () => {
  const refused = withLocation('?view=runs', () =>
    page((qc) => {
      seedList(qc, list({ namespaces: ['prod'], items: [job('importer')] }))
      seedRuns(qc, ['prod'], { forbidden: true })
    }))
  assertStringIncludes(refused, 'You may not list runs here')
  const empty = withLocation('?view=runs', () =>
    page((qc) => {
      seedList(qc, list({ namespaces: ['prod'], items: [job('importer')] }))
      seedRuns(qc, ['prod'], {})
    }))
  assertStringIncludes(empty, 'No runs yet')
  assert(!empty.includes('You may not list'))
})

Deno.test('runs: unreadable pods are named, so a missing exit code is not read as none', () => {
  const html = withLocation('?view=runs', () =>
    page((qc) => {
      seedList(qc, list({ namespaces: ['prod'], items: [job('importer')] }))
      seedRuns(qc, ['prod'], { podsUnknown: true, runs: [run('importer-aa', { active: 1, ready: 1 })] })
    }))
  assertStringIncludes(html, 'exit codes and summaries are unknown')
})

/* ─────────────────────────── blocked actions are hidden ─────────────────────────── */

/** Seed the RBAC answers the way `useAccessReview` caches them for an anonymous session. */
function seedGates(qc: QueryClient, action: Parameters<typeof actionGates>[0], target: { namespace: string; name: string; kind: RunKind }, allowed: boolean) {
  for (const g of actionGates(action, target)) {
    const check = canResource(g.gvr, g.verb, { namespace: g.namespace, name: g.name, subresource: g.subresource })
    qc.setQueryData(['k8s', 'can', '', accessCheckKey(check), 'anonymous'], allowed)
  }
}

const target = { namespace: 'prod', name: 'importer-aa', kind: 'Job' as const }

Deno.test('run actions: shown for their phase and only when RBAC allows', () => {
  const render = (status: RunObject['status'], spec: RunObject['spec'], allow: boolean, pods: RunPod[] = []) => {
    const row = runRow({ ...run('importer-aa', status), spec }, pods)
    return page((qc) => {
      for (const a of ['stop', 'resume', 'restart'] as const) seedGates(qc, a, target, allow)
    }, <RunActionsBar row={row} existingNames={[]} onOpenRun={() => {}} />)
  }
  const failed = { conditions: [{ type: 'Failed', status: 'True' }] }
  const running = { active: 1, ready: 1 }
  const stopped = { conditions: [{ type: 'Suspended', status: 'True' }] }
  assertStringIncludes(render(running, {}, true), 'Stop')
  assert(!render(running, {}, true).includes('Restart'))
  assertStringIncludes(render(failed, {}, true), 'Restart')
  assert(!render(failed, {}, true).includes('Stop'))
  assertStringIncludes(render(stopped, { suspend: true }, true), 'Resume')
  // Blocked: hidden, not disabled.
  for (const [s, sp] of [[running, {}], [failed, {}], [stopped, { suspend: true }]] as const) {
    assertEquals(render(s, sp, false), '')
  }
})

Deno.test('job actions: Run now and Hold each answer to their own check; held shows Release', () => {
  const j = job('importer')
  const t = { namespace: 'prod', name: 'importer', kind: 'Job' as const }
  const bar = (runAllowed: boolean, holdAllowed: boolean, held = false) =>
    page((qc) => {
      seedGates(qc, 'run', t, runAllowed)
      seedGates(qc, 'hold', t, holdAllowed)
    }, <JobActionsBar job={j} held={held} onDialog={() => {}} />)
  assertStringIncludes(bar(true, false), 'Run now')
  assert(!bar(true, false).includes('Hold'))
  assertStringIncludes(bar(false, true), 'Hold')
  assert(!bar(false, true).includes('Run now'))
  assertStringIncludes(bar(false, true, true), 'Release')
  assertEquals(bar(false, false), '')
})

Deno.test('job actions: while the answer is unknown nothing flashes in', () => {
  const html = page(() => {}, <JobActionsBar job={job('importer')} held={false} onDialog={() => {}} />)
  assertEquals(html, '')
})
