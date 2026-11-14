import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { accessCheckKey } from '@adhar/auth'
import type { kargo } from '@adhar/api-clients'
import { canResource } from '@adhar/shell-ui'
import {
  type BatchJobXR,
  initialParamValues,
  jobRows,
  parseRunTemplate,
  resolveParams,
  runName,
  type RunObject,
  type RunPod,
  runRow,
  runRows,
  type RunTemplate,
} from '../../data/batch-model.ts'
import type { TemplateRead } from '../../data/batch-api.ts'
import { type DialogFrame, RestartDialog, RunNowDialog } from './dialogs.tsx'
import { type DrawerFrame, RunDrawer } from './run-drawer.tsx'
import { JobDrawer } from './job-drawer.tsx'

/**
 * The two drawers and the two dialogs that create a run, rendered from a seeded
 * query cache. The page tests (views/batch_test.tsx) stop at the rows; these
 * prove what a person reads once they open one: the summary's step counts
 * (A1.5), the validation message of an exit-2 run (A1.9), the run name a
 * dialog is about to create and the reasons it refuses to.
 */

const TESTDATA = new URL('../../data/testdata/batch/', import.meta.url)
const text = (name: string) => Deno.readTextFile(new URL(name, TESTDATA))

// `Modal` and `Drawer` render through a portal, which the server renderer cannot do.
const DialogShell: DialogFrame = ({ title, description, footer, children }) => (
  <div><h2>{title}</h2><p>{description}</p>{children}<footer>{footer}</footer></div>
)
const DrawerShell: DrawerFrame = ({ header, children, footer }) => <div>{header}{children}{footer}</div>

function mount(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const LABELS = { 'adhar.io/batch-job': 'importer', 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod', 'adhar.io/project': 'shop' }
const IMAGE = 'harbor-core.adhar-system.svc.cluster.local/library/importer@sha256:1111111111111111111111111111111111111111111111111111111111111111'

const job = (p: NonNullable<BatchJobXR['spec']>['parameters'] = {}, labels: Record<string, string> = LABELS): BatchJobXR => ({
  metadata: { name: 'importer', namespace: 'prod', labels },
  spec: { parameters: { job: 'importJob', image: IMAGE, ...p } },
})

const run = (name: string, status: RunObject['status'], params = '{"businessDate":"2026-11-03","source":"inbound/records.csv"}', image = IMAGE): RunObject => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: { name, namespace: 'prod', creationTimestamp: '2026-11-03T17:30:00Z', labels: { ...LABELS, 'adhar.io/batch-trigger': 'manual' }, annotations: { 'adhar.io/batch-actor': 'alice@example.com' } },
  spec: { template: { spec: { containers: [{ name: 'batch', image, env: [{ name: 'ADHAR_BATCH_PARAMS', value: params }] }] } } },
  status,
})

const FAILED = { startTime: '2026-11-03T17:30:00Z', conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-03T17:30:05Z' }] }
const DONE = { startTime: '2026-11-03T17:30:00Z', completionTime: '2026-11-03T17:43:36Z', succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }
const RUNNING = { startTime: '2026-11-03T17:30:00Z', active: 1, ready: 1 }

const pod = (jobName: string, term?: { exitCode: number; message?: string }): RunPod => ({
  metadata: { name: `${jobName}-x`, namespace: 'prod', creationTimestamp: '2026-11-03T17:30:00Z', labels: { 'batch.kubernetes.io/job-name': jobName } },
  status: { phase: term ? (term.exitCode === 0 ? 'Succeeded' : 'Failed') : 'Running', containerStatuses: [{ name: 'batch', state: term ? { terminated: term } : { running: {} } }] },
})

const seedRun = (qc: QueryClient, r: RunObject | null, pods: RunPod[] = [], name = r?.metadata.name ?? 'importer-aa') => {
  qc.setQueryData(['batch', 'run', 'prod', name, 'Job'], r)
  qc.setQueryData(['batch', 'run-pods', 'prod', name, 'Job'], { items: pods, forbidden: false })
}

const drawer = (r: RunObject | null, pods: RunPod[] = [], name = r?.metadata.name ?? 'importer-aa', j?: BatchJobXR, seed: (qc: QueryClient) => void = () => {}) =>
  mount((qc) => {
    seedRun(qc, r, pods, name)
    seed(qc)
  }, <RunDrawer namespace='prod' name={name} job={j} existingNames={[]} onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)

const n = (x: number) => x.toLocaleString()

/* ─────────────────────────── run detail: the summary (A1.5) ─────────────────────────── */

Deno.test('run drawer: the step counts of the summary are on the page, step by step', async () => {
  const summary = await text('summary-v1/completed.json')
  const html = drawer(run('importer-aa', DONE), [pod('importer-aa', { exitCode: 0, message: summary })])
  // The step table, not just the totals: a row per step with its own counts.
  assertMatch(html, /<th[^>]*>Step<\/th><th[^>]*>Status<\/th><th[^>]*>Read<\/th>/)
  assertMatch(html, new RegExp(`importStep</td><td[^>]*>COMPLETED</td><td[^>]*>${n(120000)}</td><td[^>]*>${n(119990)}</td><td[^>]*>${n(10)}</td>`))
  // The totals, each under its own label.
  for (const [label, v] of [['Read', 120000], ['Written', 119990], ['Skipped', 10], ['Dead-lettered', 10], ['Filtered', 0]] as const) {
    assertMatch(html, new RegExp(`${label}</div><div[^>]*>${n(v)}</div>`), label)
  }
  assertMatch(html, /Execution<\/dt><dd[^>]*>97</)
  assertMatch(html, /Instance<\/dt><dd[^>]*>42</)
  assertMatch(html, /Spring Batch status<\/dt><dd[^>]*>COMPLETED</)
  assertStringIncludes(html, 'triggered by manual')
  assertStringIncludes(html, 'by alice@example.com')
  assert(!html.includes('wrote no summary'))
})

Deno.test('run drawer: each step row carries that step’s counts, not the run’s totals', async () => {
  // The same totals split over two steps, so a row that echoed the totals (or the run's status) would show.
  const steps = [
    { name: 'importStep', status: 'COMPLETED', read: 100000, written: 99995, skipped: 5 },
    { name: 'publishStep', status: 'FAILED', read: 20000, written: 19995, skipped: 5 },
  ]
  const summary = JSON.stringify({ ...JSON.parse(await text('summary-v1/completed.json')), status: 'FAILED', steps })
  const html = drawer(run('importer-aa', DONE), [pod('importer-aa', { exitCode: 0, message: summary })])
  for (const st of steps) {
    assertMatch(html, new RegExp(`${st.name}</td><td[^>]*>${st.status}</td><td[^>]*>${n(st.read)}</td><td[^>]*>${n(st.written)}</td><td[^>]*>${n(st.skipped)}</td>`), st.name)
  }
  assertMatch(html, new RegExp(`Read</div><div[^>]*>${n(120000)}</div>`))
})

Deno.test('run drawer: a summary that lost its steps, or was cut, says so', async () => {
  const dropped = drawer(run('importer-aa', DONE), [pod('importer-aa', { exitCode: 0, message: '{"v":1,"outcome":"completed","read":5,"stepsTruncated":true}' })])
  assertStringIncludes(dropped, 'Step detail was dropped')
  assert(!/>Step<\/th>/.test(dropped), 'no step table for a summary without steps')
  assertMatch(dropped, /Read<\/div><div[^>]*>5<\/div>/)
  const cut = drawer(run('importer-aa', FAILED), [pod('importer-aa', { exitCode: 5, message: await text('summary-v1/truncated.txt') })])
  assertStringIncludes(cut, 'The summary was cut off')
})

Deno.test('run drawer: no summary is said for what it is, by phase', () => {
  assertStringIncludes(drawer(run('importer-aa', RUNNING), [pod('importer-aa')]), 'The runner writes its summary when the run ends')
  assertStringIncludes(drawer(run('importer-aa', FAILED), [pod('importer-aa', { exitCode: 137 })]), 'This run wrote no summary')
  // The exit code still comes from the container.
  assertMatch(drawer(run('importer-aa', FAILED), [pod('importer-aa', { exitCode: 137 })]), /Exit code<\/dt><dd[^>]*>.*137.*Killed/)
})

Deno.test('run drawer: a run that is gone says so instead of an empty page', () => {
  const html = drawer(null)
  assertStringIncludes(html, 'gone')
  assertStringIncludes(html, 'no longer exists')
  assert(!html.includes('Summary'))
})

/* ─────────────────────────── run detail: exit 2 (A1.9) ─────────────────────────── */

Deno.test('run drawer: an exit-2 run shows the validation message the runner wrote', async () => {
  const summary = await text('summary-v1/invalid-parameters.json')
  const j = job({ parameters: [{ name: 'region', type: 'string', allowed: ['sg', 'my'] }] })
  const html = drawer(run('importer-aa', FAILED, '{"region":"xx"}'), [pod('importer-aa', { exitCode: 2, message: summary })], undefined, j)
  // The outcome row (D13 reason), the exit code with its meaning, and the description itself.
  assertMatch(html, /Outcome<\/dt><dd[^>]*>Invalid: the parameters were refused</)
  // Beside the code, in words — not only in its tooltip.
  assertMatch(html, /Exit code<\/dt><dd[^>]*><span>.*?>2<\/span> <span[^>]*>Invalid request \(parameters, unknown job, migration\)<\/span>/)
  assertStringIncludes(html, 'parameter region: value &#x27;xx&#x27; is not one of [sg, my]')
  // The parameter it refused is on the same page.
  assertMatch(html, /region<\/dt><dd[^>]*><span[^>]*>xx</)
  assert(!html.includes('wrote no summary'))
})

/* ─────────────────────────── run detail: sensitive parameters ─────────────────────────── */

const SECRET_RUN = run('importer-aa', DONE, '{"businessDate":"2026-11-03","token":"s3cr3t-value"}')
const tokenField = { name: 'token', type: 'string', identifying: false, source: 'input', sensitive: true } as const

Deno.test('run drawer: a sensitive parameter is masked whether the BatchJob or only its run template says so', async () => {
  const fromJob = drawer(SECRET_RUN, [], undefined, job({ parameters: [{ name: 'businessDate', type: 'date' }, tokenField] }))
  const base = await importerTemplate()
  const template: RunTemplate = { ...base, fields: [...base.fields, { ...tokenField, required: false }] }
  const fromTemplate = drawer(SECRET_RUN, [], undefined, undefined, (qc) => seedTemplate(qc, { state: 'ok', template }))
  for (const html of [fromJob, fromTemplate]) {
    assert(!html.includes('s3cr3t-value'))
    assertMatch(html, /token<\/dt><dd[^>]*><span[^>]*>••••••</)
    assertMatch(html, /businessDate<\/dt><dd[^>]*><span[^>]*>2026-11-03</)
    assert(!html.includes('Values are hidden'))
  }
})

Deno.test('run drawer: when nothing says which parameters are sensitive, every value is hidden, and why', () => {
  for (const read of [{ state: 'forbidden', message: 'no' }, { state: 'missing', message: 'gone' }] as const) {
    const html = drawer(SECRET_RUN, [], undefined, undefined, (qc) => seedTemplate(qc, read))
    assert(!html.includes('s3cr3t-value'))
    assertMatch(html, /businessDate<\/dt><dd[^>]*><span[^>]*>••••••</)
    assertStringIncludes(html, 'Values are hidden')
  }
})

/* ─────────────────────────── Run now ─────────────────────────── */

async function importerTemplate(): Promise<RunTemplate> {
  const cm = JSON.parse(await text('run-template-importer.configmap.json'))
  return parseRunTemplate(cm).template!
}

const seedTemplate = (qc: QueryClient, read: TemplateRead) => qc.setQueryData(['batch', 'template', 'prod', 'importer', ''], read)

const runNow = (read: TemplateRead, j: BatchJobXR, existingNames: string[] = []) =>
  mount((qc) => seedTemplate(qc, read), <RunNowDialog job={j} existingNames={existingNames} onClose={() => {}} onOpenRun={() => {}} Frame={DialogShell} />)

Deno.test('run now: the form is the template’s parameters, and the footer names the run it will create', async () => {
  const template = await importerTemplate()
  const j = job({ schedule: { cron: '30 1 * * *', timeZone: 'Asia/Singapore' } })
  const html = runNow({ state: 'ok', template }, j)
  for (const f of ['businessDate', 'source', 'dryRun']) assertStringIncludes(html, `>${f}</span>`)
  assertStringIncludes(html, 'part of the run’s identity')
  assertStringIncludes(html, 'does not affect its identity')
  assertStringIncludes(html, 'default inbound/records.csv')
  // The same name the model (and so the CLI and the kit) computes for today's date in the job's zone.
  const expected = runName('importer', resolveParams(template.fields, initialParamValues(template.fields, { timeZone: 'Asia/Singapore' })).identifying)
  assertMatch(html, new RegExp(`Run <span[^>]*>${expected}</span>`))
  assertStringIncludes(html, '>Start run<')
  assert(!html.includes('Open the existing run'))
  assert(!html.includes('already exists'))
})

Deno.test('run now: an identity that was already run opens that run and starts nothing (A1.2)', async () => {
  const template = await importerTemplate()
  const j = job()
  const expected = runName('importer', resolveParams(template.fields, initialParamValues(template.fields, {})).identifying)
  const html = runNow({ state: 'ok', template }, j, [expected])
  assertStringIncludes(html, 'Open the existing run')
  assertStringIncludes(html, `${expected}</span> already exists`)
  assert(!html.includes('>Start run<'))
})

Deno.test('run now: each refused field carries its reason, and the run cannot be started', async () => {
  const base = await importerTemplate()
  const template: RunTemplate = {
    ...base,
    fields: [
      { name: 'region', type: 'string', identifying: true, required: true, allowed: ['sg', 'my'], source: 'input', sensitive: false },
      { name: 'apiKey', type: 'string', identifying: false, required: false, source: 'input', sensitive: false },
      { name: 'asOf', type: 'date', identifying: true, required: false, source: 'schedule', sensitive: false, default: 'yesterday' },
    ],
  }
  const html = runNow({ state: 'ok', template }, job())
  assertStringIncludes(html, 'Required.')
  assertStringIncludes(html, 'The runner refuses a parameter with this name')
  assertStringIncludes(html, 'Must be a date, yyyy-mm-dd.')
  assertMatch(html, /<button[^>]*disabled=""[^>]*>Start run</)
  assert(!html.includes('Run <span'), 'no name preview while a field is refused')
})

Deno.test('run now: a template that is not there yet is said plainly, and nothing can be started', () => {
  const html = runNow({ state: 'missing', message: 'The run template prod/importer-run does not exist yet.' }, job())
  assertStringIncludes(html, 'does not exist yet')
  assertMatch(html, /<button[^>]*disabled=""[^>]*>Start run</)
  assert(!html.includes('businessDate'))
})

/* ─────────────────────────── Restart ─────────────────────────── */

const restart = (read: TemplateRead, r: RunObject, pods: RunPod[] = [], existingNames: string[] = []) =>
  mount((qc) => seedTemplate(qc, read), <RestartDialog run={runRow(r, pods)} existingNames={existingNames} onClose={() => {}} onOpenRun={() => {}} Frame={DialogShell} />)

Deno.test('restart: names the -r1 it creates, lists the identity it keeps, and warns about exit 2', async () => {
  const template = await importerTemplate()
  const summary = await text('summary-v1/invalid-parameters.json')
  const base = runName('importer', { businessDate: '2026-11-03', source: 'inbound/records.csv' })
  const html = restart({ state: 'ok', template }, run(base, FAILED), [pod(base, { exitCode: 2, message: summary })], [base])
  assertMatch(html, new RegExp(`Creates <span[^>]*>${base}-r1</span>`))
  assertStringIncludes(html, 'businessDate = 2026-11-03')
  assertStringIncludes(html, 'source = inbound/records.csv')
  assertStringIncludes(html, 'refused as an invalid request (exit 2)')
  assert(!html.includes('promoted since this run'), 'same image, no warning')
  assert(!html.includes('disabled=""'))
})

Deno.test('restart: the identity it keeps masks a sensitive value, and every value when the parameters cannot be read', async () => {
  const base = await importerTemplate()
  const fields = base.fields.map((f) => (f.name === 'source' ? { ...f, sensitive: true } : f))
  const r = run('importer-aa', FAILED, '{"businessDate":"2026-11-03","source":"vault/token"}')
  const masked = restart({ state: 'ok', template: { ...base, fields } }, r, [pod('importer-aa', { exitCode: 5 })])
  assertStringIncludes(masked, 'source = ••••••')
  assertStringIncludes(masked, 'businessDate = 2026-11-03')
  assert(!masked.includes('vault/token'))
  const unread = restart({ state: 'ok', template: { ...base, paramsError: 'parameters.json cannot be read' } }, r, [pod('importer-aa', { exitCode: 5 })])
  assert(!unread.includes('vault/token'))
  assertStringIncludes(unread, 'businessDate = ••••••')
})

Deno.test('restart: says when the deployed image is not the one the run used', async () => {
  const template = await importerTemplate()
  const html = restart({ state: 'ok', template }, run('importer-aa', FAILED, undefined, 'harbor/library/importer@sha256:2222'), [pod('importer-aa', { exitCode: 5 })])
  assertStringIncludes(html, 'The job was promoted since this run')
  assertStringIncludes(html, 'sha256:2222')
  assertStringIncludes(html, 'sha256:1111')
  assert(!html.includes('exit 2'))
})

Deno.test('restart: a run whose identity cannot be reused is refused, in words, with no button to press', async () => {
  const template = await importerTemplate()
  const html = restart({ state: 'ok', template }, run('importer-aa', FAILED, '{}'), [pod('importer-aa', { exitCode: 5 })])
  assertStringIncludes(html, 'cannot be reused')
  assertStringIncludes(html, 'businessDate')
  assertMatch(html, /<button[^>]*disabled=""[^>]*>Restart</)
  assert(!html.includes('Creates <span'))
})

/* ─────────────────────────── Job drawer: Runs and Delivery ─────────────────────────── */

const jobDrawer = (j: BatchJobXR, runs: RunObject[], tab: string, seed: (qc: QueryClient) => void = () => {}) => {
  const row = jobRows([j], runRows(runs, [], Date.parse('2026-11-03T18:00:00Z')), { now: Date.parse('2026-11-03T18:00:00Z') })[0]
  return mount(seed, <JobDrawer row={row} now={Date.parse('2026-11-03T18:00:00Z')} tab={tab} onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)
}

Deno.test('job drawer: Runs draws every run as a bar against the limit and lists it beneath', () => {
  const html = jobDrawer(job({ sla: { maxDuration: '1h' } }), [run('importer-aa', DONE), run('importer-bb', FAILED)], 'runs')
  assertStringIncludes(html, 'Duration of the last 2 runs, against a limit of 1h 0m')
  assertStringIncludes(html, 'aria-label="importer-aa, succeeded, took 13m 36s"')
  assertMatch(html, /<th[^>]*>Run<\/th><th[^>]*>Status<\/th><th[^>]*>Trigger<\/th>/)
  assertStringIncludes(html, '>importer-aa</button>')
  assertStringIncludes(html, '>importer-bb</button>')
  assertStringIncludes(html, '2026-11-03')
  assert(!html.includes('Held'), 'a job that is not held carries no hold badge')
})

Deno.test('job drawer: Runs with nothing to show says what would make one appear', () => {
  assertStringIncludes(jobDrawer(job({ schedule: { cron: '30 1 * * *' } }), [], 'runs'), 'when the schedule next fires')
  assertStringIncludes(jobDrawer(job(), [], 'runs'), 'someone starts it with Run now')
})

const STAGES = [
  { name: 'importer-prod', project: 'shop', phase: 'Steady', health: 'Healthy', labels: { 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod' }, currentFreight: 'f1', lastPromoted: '2026-11-01T00:00:00Z', lastPromotionPhase: 'Succeeded' },
] as kargo.Stage[]
const FREIGHT = [{ id: 'f1', project: 'shop', warehouse: 'importer', images: [{ repoURL: 'harbor/library/importer', tag: '3ba0d883abec17f17821b99429ec0267d46c7850' }], created: '2026-10-31T00:00:00Z' }] as kargo.Freight[]

const seedDelivery = (qc: QueryClient) => {
  qc.setQueryData(['functions', 'kargo', 'stages', 'shop'], STAGES)
  qc.setQueryData(['functions', 'kargo', 'freight', 'shop'], FREIGHT)
}

Deno.test('job drawer: Delivery is the job’s place in its project’s promotion chain, as Functions show it', () => {
  const html = jobDrawer(job(), [], 'delivery', seedDelivery)
  assertStringIncludes(html, 'Promote from the catalog’s Deploy tab')
  assertStringIncludes(html, 'component%3Aimporter')
  assertMatch(html, /<td[^>]*>prod<\/td><td[^>]*>importer-prod/)
  assertStringIncludes(html, 'importer 3ba0d88')
  assertStringIncludes(html, 'Succeeded')
  // dev and test have no stage yet.
  assertMatch(html, /<td[^>]*>dev<\/td><td[^>]*>—/)
})

Deno.test('job drawer: Delivery it may not read, or has no project for, is not shown as an empty chain', () => {
  const check = canResource({ group: 'kargo.akuity.io', resource: 'stages', namespaced: true }, 'list', { namespace: 'shop' })
  const forbidden = jobDrawer(job(), [], 'delivery', (qc) => {
    seedDelivery(qc)
    qc.setQueryData(['k8s', 'can', '', accessCheckKey(check), 'anonymous'], false)
  })
  assertStringIncludes(forbidden, 'You may not read Kargo stages in project shop')
  assert(!forbidden.includes('importer-prod'))
  const { 'adhar.io/project': _, ...noProject } = LABELS
  assertStringIncludes(jobDrawer(job({}, noProject), [], 'delivery', seedDelivery), 'names no project')
})

Deno.test('job drawer: the header carries status, environment and the hold', () => {
  const held = job()
  held.metadata.annotations = { 'adhar.io/batch-hold': 'late file' }
  const html = jobDrawer(held, [run('importer-aa', DONE)], 'runs')
  assertStringIncludes(html, 'Held')
  assertStringIncludes(html, 'late file')
  assertStringIncludes(html, 'Its schedule is not firing')
  assertEquals(html.includes('deleted'), false)
})
