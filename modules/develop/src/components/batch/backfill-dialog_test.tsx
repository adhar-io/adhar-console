import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { accessCheckKey } from '@adhar/auth'
import { canResource } from '@adhar/shell-ui'
import {
  actionGates,
  type BatchJobXR,
  JOBS_GVR,
  parseRunTemplate,
  runName,
  type RunObject,
  type RunRow,
  runRows,
  type RunTemplate,
} from '../../data/batch-model.ts'
import type { TemplateRead } from '../../data/batch-api.ts'
import { type BackfillItem, backfillPlan } from '../../data/batch-history-model.ts'
import { BackfillDialog, BackfillPreview, BackfillProgressView } from './backfill-dialog.tsx'
import { type DialogFrame } from './dialogs.tsx'
import { JobActionsBar } from './job-drawer.tsx'

/**
 * The backfill dialog, rendered from a seeded query cache: what it says it will
 * do before anything is created, the reasons it refuses to, and how a backfill
 * under way reads. The plan and the release rule themselves are the model's
 * (`batch-history-model_test.ts`); these hold what a person is told.
 */

// `Modal` renders through a portal, which the server renderer cannot do.
const DialogShell: DialogFrame = ({ title, description, footer, children }) => (
  <div>
    <h2>{title}</h2>
    <p>{description}</p>
    {children}
    <footer>{footer}</footer>
  </div>
)

function mount(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const TESTDATA = new URL('../../data/testdata/batch/', import.meta.url)
const importerTemplate = async (): Promise<RunTemplate> =>
  parseRunTemplate(JSON.parse(await Deno.readTextFile(new URL('run-template-importer.configmap.json', TESTDATA)))).template!

const JOB: BatchJobXR = { metadata: { name: 'importer', namespace: 'prod' }, spec: { parameters: { job: 'importJob', image: 'img' } } }

const DONE = { startTime: '2026-11-03T02:00:00Z', completionTime: '2026-11-03T02:10:00Z', succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }
const FAILED = { startTime: '2026-11-03T02:00:00Z', failed: 1, conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-03T02:05:00Z' }] }
const RUNNING = { startTime: '2026-11-03T02:00:00Z', active: 1 }

const run = (name: string, status: RunObject['status'], suspend = false): RunObject => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: { name, namespace: 'prod', creationTimestamp: '2026-11-03T02:00:00Z', labels: { 'adhar.io/batch-job': 'importer' } },
  spec: suspend ? { suspend: true } : {},
  status,
})
const rows = (runs: RunObject[]): RunRow[] => runRows(runs, [], Date.parse('2026-11-03T12:00:00Z'))
const nameOf = (date: string) => runName('importer', { businessDate: date, source: 'inbound/records.csv' })

const seedTemplate = (qc: QueryClient, read: TemplateRead) => qc.setQueryData(['batch', 'template', 'prod', 'importer', ''], read)
const seedRelease = (qc: QueryClient, allowed: boolean) =>
  qc.setQueryData(['k8s', 'can', '', accessCheckKey(canResource(JOBS_GVR, 'patch', { namespace: 'prod' })), 'anonymous'], allowed)

const dialog = (read: TemplateRead | undefined, o: { runs?: RunRow[]; initial?: { from?: string; to?: string; parallel?: number }; release?: boolean } = {}) =>
  mount((qc) => {
    if (read) seedTemplate(qc, read)
    if (o.release !== undefined) seedRelease(qc, o.release)
  }, <BackfillDialog job={JOB} runs={o.runs ?? []} initial={o.initial} onClose={() => {}} Frame={DialogShell} />)

const START = /<button[^>]*>Start backfill<\/button>/
const START_DISABLED = /<button[^>]* disabled=""[^>]*>Start backfill<\/button>/

Deno.test('backfill: the form asks for a range and a parallelism, and says which parameter the date goes into', async () => {
  const html = dialog({ state: 'ok', template: await importerTemplate() })
  assertStringIncludes(html, 'Backfill importer')
  assertStringIncludes(html, 'one run per business date, from the deployed run template')
  for (const label of ['First business date', 'Last business date', 'At once']) assertStringIncludes(html, label)
  assertMatch(html, /goes into <span[^>]*>businessDate<\/span>/)
  // The other parameters are asked once, for every date; the business date is not asked twice.
  assertStringIncludes(html, '>source</span>')
  assertStringIncludes(html, '>dryRun</span>')
  assertStringIncludes(html, 'the same for every date')
  assertEquals(html.split('>businessDate</span>').length - 1, 1)
  assertStringIncludes(html, 'Up to 366 dates')
  // Nothing to start until there is a range.
  assertMatch(html, START_DISABLED)
})

Deno.test('backfill: with a range, every date’s run is named before anything is created', async () => {
  const held = rows([run(nameOf('2026-11-01'), DONE), run(nameOf('2026-11-02'), FAILED)])
  const html = dialog({ state: 'ok', template: await importerTemplate() }, {
    runs: held,
    initial: { from: '2026-11-01', to: '2026-11-03', parallel: 2 },
    release: true,
  })
  assertStringIncludes(html, '3 dates: 1 to start · 1 to restart (failed before) · 1 already completed.')
  assertStringIncludes(html, nameOf('2026-11-03'))
  assertStringIncludes(html, `${nameOf('2026-11-02')}-r1`)
  assertMatch(html, new RegExp(`will restart<span[^>]*> \\(continues ${nameOf('2026-11-02')}\\)</span>`))
  assertStringIncludes(html, '3 dates · 2 to start')
  assertMatch(html, START)
  assert(!START_DISABLED.test(html))
})

Deno.test('backfill: a caller who may not release runs is told, because the runs would be created and never start', async () => {
  const template = await importerTemplate()
  const html = dialog({ state: 'ok', template }, { initial: { from: '2026-11-01', to: '2026-11-02' }, release: false })
  assertMatch(html, /needs <span[^>]*>patch jobs<\/span> in prod/)
  assertStringIncludes(html, 'the runs would never start')
  assertMatch(html, START_DISABLED)
  // While the answer is unknown the warning does not flash in.
  assert(!dialog({ state: 'ok', template }, { initial: { from: '2026-11-01', to: '2026-11-02' } }).includes('would never start'))
  assert(!dialog({ state: 'ok', template }, { initial: { from: '2026-11-01', to: '2026-11-02' }, release: true }).includes('would never start'))
})

Deno.test('backfill: a bad range, a refused parameter and a nonsense parallelism each say why, and start nothing', async () => {
  const read: TemplateRead = { state: 'ok', template: await importerTemplate() }
  const backwards = dialog(read, { initial: { from: '2026-11-03', to: '2026-11-01' }, release: true })
  assertStringIncludes(backwards, '2026-11-01 is before 2026-11-03.')
  assertMatch(backwards, START_DISABLED)
  const huge = dialog(read, { initial: { from: '2024-01-01', to: '2026-01-01' }, release: true })
  assertStringIncludes(huge, 'more than 366 dates')
  assertMatch(huge, START_DISABLED)
  const zero = dialog(read, { initial: { from: '2026-11-01', to: '2026-11-01', parallel: 0 }, release: true })
  assertStringIncludes(zero, 'A whole number, 1 or more.')
  assertMatch(zero, START_DISABLED)
})

Deno.test('backfill: nothing left to create but runs still queued is a backfill to continue; all done is nothing to do', async () => {
  const read: TemplateRead = { state: 'ok', template: await importerTemplate() }
  const queued = rows([run(nameOf('2026-11-01'), DONE), run(nameOf('2026-11-02'), {}, true)])
  const html = dialog(read, { runs: queued, initial: { from: '2026-11-01', to: '2026-11-02' }, release: true })
  assertStringIncludes(html, '1 already completed · 1 already there')
  assertMatch(html, /<button(?![^>]* disabled="")[^>]*>Continue backfill<\/button>/)
  const done = dialog(read, { runs: rows([run(nameOf('2026-11-01'), DONE)]), initial: { from: '2026-11-01', to: '2026-11-01' }, release: true })
  assertMatch(done, START_DISABLED)
})

Deno.test('backfill: a job with no business-date parameter, or no readable template, cannot be backfilled, and says so', async () => {
  const template = await importerTemplate()
  const noDate = dialog({ state: 'ok', template: { ...template, fields: template.fields.filter((f) => f.name !== 'businessDate') } })
  assertStringIncludes(noDate, 'declares no business-date parameter')
  assert(!noDate.includes('First business date'))
  assertMatch(noDate, START_DISABLED)
  const missing = dialog({ state: 'missing', message: 'The run template prod/importer-run does not exist yet.' })
  assertStringIncludes(missing, 'The run template prod/importer-run does not exist yet.')
  assertMatch(missing, START_DISABLED)
  assertMatch(dialog(undefined), START_DISABLED)
})

/* ─────────────────────────── preview and progress, from data ─────────────────────────── */

const item = (date: string, action: BackfillItem['action'], name = `importer-${date}`): BackfillItem => ({
  businessDate: date,
  run: name,
  action,
  params: { businessDate: date },
})

Deno.test('preview: on Volcano the page says "at once" is the queue’s, not the dialog’s', () => {
  const items = [item('2026-11-01', 'create'), item('2026-11-02', 'stopped')]
  const volcano = mount(() => {}, <BackfillPreview items={items} volcano parallel={4} />)
  assertStringIncludes(volcano, 'its queue decides how many start')
  assertStringIncludes(volcano, '2 dates: 1 to start · 1 stopped by someone, left alone.')
  assert(!mount(() => {}, <BackfillPreview items={items} volcano={false} parallel={4} />).includes('queue decides'))
})

Deno.test('progress: each date’s run as it stands — queued is not "stopped", and what is released next is said', () => {
  const items = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d) => item(d, 'create'))
  const live = rows([
    run('importer-2026-11-01', DONE),
    run('importer-2026-11-02', RUNNING),
    run('importer-2026-11-03', {}, true),
    run('importer-2026-11-04', {}, true),
    // 2026-11-05 was deleted.
  ])
  const html = mount(() => {}, <BackfillProgressView items={items} runs={live} parallel={2} volcano={false} onOpenRun={() => {}} />)
  assertStringIncludes(html, '1 of 5 ended · 1 in flight · 2 queued · 1 no longer in the cluster')
  assertStringIncludes(html, 'at most 2 at a time')
  assertStringIncludes(html, 'adhar batch backfill')
  const row = (date: string) => html.split('<tr').find((r) => r.includes(`>${date}<`))!.split('</tr>')[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assertStringIncludes(row('2026-11-01'), 'Succeeded')
  assertStringIncludes(row('2026-11-02'), 'Running')
  // Created suspended and never started: the Job's phase reads "stopped"; the page must not.
  assertStringIncludes(row('2026-11-03'), 'Queued')
  assert(!row('2026-11-03').includes('Stopped'))
  assertStringIncludes(row('2026-11-05'), 'not in the cluster')
  assertMatch(html, /<button[^>]*>importer-2026-11-01<\/button>/)
  assert(!/<button[^>]*>importer-2026-11-05<\/button>/.test(html), 'a run that is gone opens nothing')

  // Just released, the list not caught up: in flight, not queued.
  const released = mount(() => {}, <BackfillProgressView items={items} runs={live} parallel={2} volcano={false} released={new Set(['importer-2026-11-03'])} />)
  assertStringIncludes(released, '2 in flight · 1 queued')
  assert(!row('2026-11-03').includes('Stopped'))

  const volcano = mount(() => {}, <BackfillProgressView items={items} runs={live} parallel={2} volcano />)
  assertStringIncludes(volcano, 'its queue decides how many start')
  assert(!volcano.includes('at a time'))
})

/* ─────────────────────────── where it is opened from ─────────────────────────── */

Deno.test('job actions: Backfill stands behind the same check as Run now — hidden without it', () => {
  const t = { namespace: 'prod', name: 'importer', kind: 'Job' as const }
  const bar = (runAllowed: boolean) =>
    mount((qc) => {
      for (const [action, allowed] of [['run', runAllowed], ['hold', true]] as const) {
        for (const g of actionGates(action, t)) {
          qc.setQueryData([
            'k8s',
            'can',
            '',
            accessCheckKey(canResource(g.gvr, g.verb, { namespace: g.namespace, name: g.name, subresource: g.subresource })),
            'anonymous',
          ], allowed)
        }
      }
    }, <JobActionsBar job={JOB} held={false} onDialog={() => {}} />)
  assertStringIncludes(bar(true), '>Backfill<')
  assert(!bar(false).includes('Backfill'))
  assertStringIncludes(bar(false), 'Hold')
})

Deno.test('the plan the dialog shows is the model’s plan, date for date', async () => {
  const template = await importerTemplate()
  const plan = backfillPlan({ namespace: 'prod', job: 'importer' }, template, ['2026-11-01', '2026-11-02'], {}, [])
  assert('items' in plan)
  const html = dialog({ state: 'ok', template }, { initial: { from: '2026-11-01', to: '2026-11-02' }, release: true })
  for (const i of plan.items) assertStringIncludes(html, i.run)
})
