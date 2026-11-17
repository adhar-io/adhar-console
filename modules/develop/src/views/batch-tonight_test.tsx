import { assert, assertEquals, assertMatch, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { accessCheckKey } from '@adhar/auth'
import { canResource } from '@adhar/shell-ui'
import { Batch } from './batch.tsx'
import { CalendarsTable, DlqTable, ReplayButton, ReplayDialog, TonightView } from './batch-tonight.tsx'
import { calendarsKey, historyKey } from '../data/batch-history.ts'
import {
  type BatchEvent,
  type Calendar,
  calendarRows,
  dlqByJob,
  dlqEntries,
  type DlqEntry,
  type HistoryRead,
  parseCalendar,
} from '../data/batch-history-model.ts'
import { actionGates, type BatchJobList, type BatchJobXR, parseRunTemplate, type RunObject, type RunPod, type RunRow, runRows } from '../data/batch-model.ts'
import type { TemplateRead } from '../data/batch-api.ts'
import type { DialogFrame } from '../components/batch/dialogs.tsx'

/**
 * Develop → Batch → Tonight, rendered from data: the forecast with calendars
 * applied, the dependency chains, the dead-letter queue with its replay, and the
 * calendars. What these hold is that the page never draws what it does not know
 * as good news: no estimate is not "on time", an unreadable calendar is not
 * "runs every day", and a replay nobody may start has no button.
 */

const NOW = Date.parse('2026-11-03T12:00:00Z')

function render(ui: ReactNode, seed: (qc: QueryClient) => void = () => {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// `Modal` renders through a portal, which the server renderer cannot do.
const DialogShell: DialogFrame = ({ title, description, footer, children }) => (
  <div>
    <h2>{title}</h2>
    <p>{description}</p>
    {children}
    <footer>{footer}</footer>
  </div>
)

const job = (name: string, p: NonNullable<BatchJobXR['spec']>['parameters'] = {}, namespace = 'prod'): BatchJobXR => ({
  metadata: { name, namespace, labels: { 'adhar.io/application': name, 'adhar.io/environment': namespace } },
  spec: { parameters: { job: 'importJob', image: 'img', ...p } },
})

const DONE = { startTime: '2026-11-03T02:00:00Z', completionTime: '2026-11-03T02:10:00Z', succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }
const FAILED = { startTime: '2026-11-03T02:00:00Z', failed: 1, conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-03T02:05:00Z' }] }
const RUNNING = { startTime: '2026-11-03T02:00:00Z', active: 1 }

const run = (
  name: string,
  status: RunObject['status'],
  o: { job?: string; trigger?: string; env?: Record<string, string>; created?: string } = {},
): RunObject => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: {
    name,
    namespace: 'prod',
    creationTimestamp: o.created ?? '2026-11-03T02:00:00Z',
    labels: { 'adhar.io/batch-job': o.job ?? 'importer', 'adhar.io/batch-trigger': o.trigger ?? 'schedule' },
  },
  spec: { template: { spec: { containers: [{ name: 'batch', image: 'img', env: Object.entries(o.env ?? {}).map(([n, value]) => ({ name: n, value })) }] } } },
  status,
})

const pod = (jobName: string, summary: Record<string, unknown>): RunPod => ({
  metadata: { name: `${jobName}-x`, namespace: 'prod', creationTimestamp: '2026-11-03T02:00:00Z', labels: { 'batch.kubernetes.io/job-name': jobName } },
  status: {
    phase: 'Succeeded',
    containerStatuses: [{
      name: 'batch',
      state: { terminated: { exitCode: 0, message: JSON.stringify({ v: 1, outcome: 'completed', exitCode: 0, ...summary }) } },
    }],
  },
})

const ev = (type: string, subject: string, time: string, data: Record<string, unknown> = {}): BatchEvent => ({
  type: `io.adhar.batch.${type}`,
  subject,
  time,
  data,
})
const history = (events: BatchEvent[] = [], o: Partial<Extract<HistoryRead, { state: 'read' }>> = {}): HistoryRead => ({
  state: 'read',
  events,
  total: events.length,
  truncated: false,
  degraded: false,
  ...o,
})
const cal = (name: string, yaml: string, namespace = 'adhar-system'): Calendar =>
  parseCalendar({ metadata: { name, namespace }, data: { 'calendar.yaml': yaml } })

const view = (props: Partial<Parameters<typeof TonightView>[0]> & { jobs: BatchJobXR[] }) =>
  render(<TonightView runs={[]} history={history()} calendars={[]} now={NOW} {...props} />)

/** The text of one table row, tags dropped: the row that mentions `needle`. */
function rowOf(html: string, needle: string): string {
  const row = html.split('<tr').find((r) => r.includes(needle))
  assert(row, `no row mentions ${needle}`)
  return row.split('</tr>')[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

/* ─────────────────────────── the forecast ─────────────────────────── */

Deno.test('tonight: a fire in the next 24 hours shows its start in the job’s zone, its business date and what it starts', () => {
  const html = view({
    jobs: [
      job('extract', { displayName: 'Nightly extract', schedule: { cron: '30 0 * * *', timeZone: 'Asia/Singapore' } }),
      job('load', { dependsOn: [{ batchJob: 'extract' }] }),
    ],
  })
  const row = rowOf(html, 'Nightly extract')
  // 00:30 in Singapore, which is 16:30 UTC today; the business date is Singapore's.
  assertStringIncludes(row, '00:30 Asia/Singapore')
  assertStringIncludes(row, 'in 4h 30m')
  assertStringIncludes(row, '2026-11-04')
  assertStringIncludes(row, 'prod/load')
  // No history and no SLA: nothing is promised.
  assertStringIncludes(row, 'no estimate')
  assert(!row.includes('On time') && !row.includes('At risk'))
})

Deno.test('tonight: nothing scheduled is said, and held or on-demand jobs are not forecast', () => {
  const html = view({
    jobs: [job('on-demand'), {
      ...job('held', { schedule: { cron: '0 2 * * *' } }),
      metadata: { name: 'held', namespace: 'prod', annotations: { 'adhar.io/batch-hold': 'month end' } },
    }],
  })
  assertStringIncludes(html, 'Nothing is scheduled in the next 24 hours')
})

Deno.test('tonight: expected end is start + p90 of the last successes; finishBy reads on time, at risk, or no estimate', () => {
  const durations = (name: string) =>
    Array.from(
      { length: 10 },
      (_, i) => ev('run.succeeded', `prod/${name}`, `2026-10-${10 + i}T03:00:00Z`, { run: { name: `${name}-${i}` }, durationSeconds: (i + 1) * 600 }),
    )
  const html = view({
    jobs: [
      job('early', { schedule: { cron: '0 2 * * *' }, sla: { finishBy: '04:00' } }),
      job('late', { schedule: { cron: '0 2 * * *' }, sla: { finishBy: '03:00' } }),
      job('blind', { schedule: { cron: '0 2 * * *' }, sla: { finishBy: '03:00' } }),
    ],
    history: history([...durations('early'), ...durations('late')]),
  })
  // p90 of 10..100 minutes is 90 minutes: a 02:00 start ends 03:30.
  const early = rowOf(html, '>early<')
  assertStringIncludes(early, '03:30')
  assertStringIncludes(early, 'p90 1h 30m')
  assertStringIncludes(early, 'On time by 04:00')
  const late = rowOf(html, '>late<')
  assertStringIncludes(late, 'At risk by 03:00 30m 0s late')
  const blind = rowOf(html, '>blind<')
  assertStringIncludes(blind, 'no estimate')
  assertStringIncludes(blind, 'No estimate by 03:00')
  assert(!blind.includes('On time'), 'a deadline with no forecast is never drawn as met')
})

Deno.test('tonight: the calendar is applied — a holiday is a run that skips, an unreadable calendar is unknown', () => {
  const html = view({
    jobs: [
      job('workday', { schedule: { cron: '0 2 * * *', calendar: 'weekdays' } }),
      job('banked', { schedule: { cron: '0 2 * * *', calendar: 'bank' }, sla: { finishBy: '03:00' } }),
      job('lost', { schedule: { cron: '0 2 * * *', calendar: 'nowhere' } }),
      job('hidden', { schedule: { cron: '0 2 * * *', calendar: 'theirs' } }, 'dev'),
    ],
    calendars: [cal('weekdays', 'name: weekdays\n'), cal('bank', 'name: bank\nholidays: [2026-11-04]\n', 'prod')],
    unreadCalendars: ['dev'],
  })
  const workday = rowOf(html, '>workday<')
  assertStringIncludes(workday, 'weekdays')
  assert(!workday.includes('Skips') && !workday.includes('unknown'))
  const banked = rowOf(html, '>banked<')
  assertStringIncludes(banked, 'Skips: holiday')
  assertStringIncludes(banked, 'no work')
  assertStringIncludes(banked, 'nothing due')
  assert(!banked.includes('At risk') && !banked.includes('No estimate'), 'a date with no work has no deadline to miss')
  assertStringIncludes(html, 'It starts and exits 0 as skipped: this date is a holiday in bank.')
  const lost = rowOf(html, '>lost<')
  assertStringIncludes(lost, 'Calendar unknown')
  assertStringIncludes(lost, 'nowhere: not found')
  // A namespace whose calendars this person may not list: said so, not "not found".
  const hidden = rowOf(html, '>hidden<')
  assertStringIncludes(hidden, 'theirs: you may not read the calendars of dev')
  assertStringIncludes(html, 'You may not read the calendars of')
})

Deno.test('tonight: history that could not be read is said once, and the forecast still stands on the runs the cluster holds', () => {
  const jobs = [job('nightly', { schedule: { cron: '0 2 * * *' }, sla: { finishBy: '03:00' } })]
  const runs = runRows([run('nightly-a', DONE, { job: 'nightly' })], [], NOW)
  const noBus = view({ jobs, runs, history: { state: 'unavailable', reason: 'no-bus', detail: 'no bridge' } })
  assertStringIncludes(noBus, 'This cluster has no event bus')
  assertStringIncludes(noBus, 'come only from the runs the cluster still holds')
  // One ten-minute success in the cluster: ends 02:10, inside 03:00.
  assertStringIncludes(rowOf(noBus, '>nightly<'), 'p90 10m 0s')
  assertStringIncludes(rowOf(noBus, '>nightly<'), 'On time by 03:00')
  const down = view({ jobs, history: { state: 'unavailable', reason: 'unreachable', detail: 'bridge GET: HTTP 503' } })
  assertStringIncludes(down, 'The batch history could not be read (bridge GET: HTTP 503)')
  const failed = view({ jobs, history: undefined, historyError: new Error('HTTP 502') })
  assertStringIncludes(failed, 'The batch history could not be read (HTTP 502)')
  assertStringIncludes(view({ jobs, history: history([], { truncated: true }) }), 'may rest on fewer runs than there were')
  const clean = view({ jobs })
  assert(!clean.includes('could not be read') && !clean.includes('no event bus') && !clean.includes('fewer runs'))
  // Still loading: nothing is claimed about the history either way.
  assert(!view({ jobs, history: undefined }).includes('could not be read'))
})

/* ─────────────────────────── dependency chains ─────────────────────────── */

Deno.test('chains: each job that waits, what it waits for, and whether that has succeeded', () => {
  const jobs = [
    job('extract'),
    job('load', { dependsOn: [{ batchJob: 'extract' }] }),
    job('report', { dependsOn: [{ batchJob: 'rates', namespace: 'shared' }] }),
    job('mirror', { dependsOn: [{ batchJob: 'load', sameBusinessDate: false }] }),
  ]
  const runs = runRows(
    [
      run('extract-a', DONE, { job: 'extract' }),
      run('load-dep', RUNNING, { job: 'load', trigger: 'dependency', created: '2026-11-03T02:11:00Z' }),
    ],
    [pod('extract-a', { businessDate: '2026-11-03' })],
    NOW,
  )
  const html = view({ jobs, runs, onOpenRun: () => {} })
  const load = rowOf(html, '>load<')
  assertStringIncludes(load, 'prod/extract same business date · last succeeded for 2026-11-03')
  assertStringIncludes(load, 'Upstream done')
  assertMatch(html, /<button[^>]*>load-dep<\/button>/)
  const report = rowOf(html, '>report<')
  assertStringIncludes(report, 'shared/rates not visible to you')
  assertStringIncludes(report, 'Cannot tell')
  const mirror = rowOf(html, '>mirror<')
  assertStringIncludes(mirror, 'prod/load latest run · running')
  assertStringIncludes(mirror, 'Waiting')
  assertStringIncludes(view({ jobs: [job('solo')] }), 'No job waits for another')
})

/* ─────────────────────────── the dead-letter queue ─────────────────────────── */

const DLQ_RUNS = (replay?: RunObject['status']): RunRow[] =>
  runRows(
    [
      run('importer-aaaa1111', DONE),
      ...(replay
        ? [run('importer-ops-dlq-replay-97', replay, { trigger: 'ops', env: { ADHAR_BATCH_COMMAND: 'dlq-replay', ADHAR_BATCH_EXECUTION_ID: '97' } })]
        : []),
    ],
    [pod('importer-aaaa1111', { executionId: 97, deadLettered: 1200, businessDate: '2026-11-03' })],
    NOW,
  )

const GONE = ev('run.failed', 'prod/importer', '2026-10-20T02:10:00Z', {
  run: { name: 'importer-bbbb2222' },
  springBatch: { executionId: 61, businessDate: '2026-10-20' },
  counts: { deadLettered: 4 },
})

Deno.test('dlq: counts per job, from the runs the cluster holds and from history for the ones it no longer does', () => {
  const html = view({ jobs: [job('importer')], runs: DLQ_RUNS(), history: history([GONE]), onOpenRun: () => {} })
  assertStringIncludes(html, `${(1204).toLocaleString()} dead-lettered in 2 runs`)
  const held = rowOf(html, 'importer-aaaa1111')
  assertStringIncludes(held, '97')
  assertStringIncludes(held, (1200).toLocaleString())
  assertMatch(html, /<button[^>]*>importer-aaaa1111<\/button>/)
  const gone = rowOf(html, 'importer-bbbb2222')
  assertStringIncludes(gone, 'from history')
  assertStringIncludes(gone, '2026-10-20')
  assertMatch(html, /title="This run is no longer in the cluster"[^>]*>importer-bbbb2222</)
  assertStringIncludes(html, 'adhar batch dlq &lt;job&gt; --replay')
  assertStringIncludes(view({ jobs: [job('importer')] }), 'No dead letters')
})

Deno.test('dlq: a replay under way is shown beside the execution it replays', () => {
  const html = render(<DlqTable jobs={dlqByJob(dlqEntries(DLQ_RUNS(RUNNING), []))} />)
  const row = rowOf(html, 'importer-aaaa1111')
  assertStringIncludes(row, 'importer-ops-dlq-replay-97')
  assertStringIncludes(row, 'Running')
  // The ops Job is not itself a row of dead letters.
  assertEquals(html.split('<tr').filter((r) => r.includes('importer-ops-dlq-replay-97')).length, 1)
})

const seedRunGate = (qc: QueryClient, allowed: boolean, name = 'importer') => {
  for (const g of actionGates('run', { namespace: 'prod', name, kind: 'Job' })) {
    qc.setQueryData([
      'k8s',
      'can',
      '',
      accessCheckKey(canResource(g.gvr, g.verb, { namespace: g.namespace, name: g.name, subresource: g.subresource })),
      'anonymous',
    ], allowed)
  }
}

const entryOf = (o: Partial<DlqEntry> = {}): DlqEntry => ({
  namespace: 'prod',
  job: 'importer',
  run: 'importer-aaaa1111',
  executionId: 97,
  deadLettered: 10,
  source: 'run',
  ...o,
})

Deno.test('replay button: there only when a replay could be started — hidden, never disabled', () => {
  const button = (entry: DlqEntry, allowed: boolean | undefined, jobs = [job('importer')]) =>
    render(<ReplayButton entry={entry} jobs={jobs} onReplay={() => {}} />, (qc) => (allowed === undefined ? undefined : seedRunGate(qc, allowed)))
  assertStringIncludes(button(entryOf(), true), '>Replay<')
  assertEquals(button(entryOf(), false), '', 'the caller may not create runs here')
  assertEquals(button(entryOf(), undefined), '', 'while the answer is unknown nothing flashes in')
  assertEquals(button(entryOf({ executionId: undefined }), true), '', 'nothing to name the replay after')
  assertEquals(button(entryOf(), true, [job('other')]), '', 'the BatchJob is not on the page: no run template to make it from')
  assertEquals(button(entryOf({ replay: { run: 'importer-ops-dlq-replay-97', phase: 'running' } }), true), '', 'one is under way')
  assertEquals(button(entryOf({ replay: { run: 'importer-ops-dlq-replay-97', phase: 'succeeded' } }), true), '', 'it was replayed')
  assertStringIncludes(button(entryOf({ replay: { run: 'importer-ops-dlq-replay-97', phase: 'failed' } }), true), '>Retry replay<')
})

const TESTDATA = new URL('../data/testdata/batch/', import.meta.url)
const importerTemplate = async () => parseRunTemplate(JSON.parse(await Deno.readTextFile(new URL('run-template-importer.configmap.json', TESTDATA)))).template!
const seedTemplate = (qc: QueryClient, read: TemplateRead) => qc.setQueryData(['batch', 'template', 'prod', 'importer', ''], read)

const dialog = (read: TemplateRead | undefined, entry: DlqEntry, runs: RunRow[] = []) =>
  render(
    <ReplayDialog entry={entry} job={job('importer')} runs={runs} onClose={() => {}} Frame={DialogShell} />,
    (qc) => (read ? seedTemplate(qc, read) : undefined),
  )

Deno.test('replay dialog: names the ops Job it creates — the CLI’s name — and what it will do', async () => {
  const html = dialog({ state: 'ok', template: await importerTemplate() }, entryOf({ businessDate: '2026-11-03' }))
  assertStringIncludes(html, 'Replay dead letters of importer')
  assertMatch(html, /Run <span[^>]*>importer-ops-dlq-replay-97<\/span>/)
  assertMatch(html, /Execution <span[^>]*>97<\/span>/)
  assertStringIncludes(html, 'Only the rejected items of this execution are processed again')
  assertMatch(html, /<button(?![^>]* disabled="")[^>]*>Start replay<\/button>/)
})

Deno.test('replay dialog: an existing replay is shown instead of a second; a failed one is retried as -r1', async () => {
  const read: TemplateRead = { state: 'ok', template: await importerTemplate() }
  const running = dialog(read, entryOf(), DLQ_RUNS(RUNNING))
  assertStringIncludes(running, 'A replay of this execution is already running')
  assertStringIncludes(running, 'Open the existing replay')
  assert(!running.includes('Start replay'))
  const failed = dialog(read, entryOf(), DLQ_RUNS(FAILED))
  assertMatch(failed, /Run <span[^>]*>importer-ops-dlq-replay-97-r1<\/span>/)
  assertMatch(failed, /The earlier replay <span[^>]*>importer-ops-dlq-replay-97<\/span> failed, so this is its retry/)
  assertStringIncludes(failed, 'Start replay')
})

Deno.test('replay dialog: without a readable run template, or an execution id, nothing can be started', async () => {
  const missing = dialog({ state: 'missing', message: 'The run template prod/importer-run does not exist yet.' }, entryOf())
  assertStringIncludes(missing, 'The run template prod/importer-run does not exist yet.')
  assertMatch(missing, /<button[^>]*disabled=""[^>]*>Start replay<\/button>/)
  const noId = dialog({ state: 'ok', template: await importerTemplate() }, entryOf({ executionId: undefined }))
  assertStringIncludes(noId, 'reported no execution id')
  assertMatch(noId, /<button[^>]*disabled=""[^>]*>Start replay<\/button>/)
  // Nothing seeded: still reading, and the button waits.
  assertMatch(dialog(undefined, entryOf()), /<button[^>]*disabled=""[^>]*>Start replay<\/button>/)
})

/* ─────────────────────────── calendars ─────────────────────────── */

Deno.test('calendars: each one’s scope, weekend, what is coming up and who follows it', () => {
  const calendars = [
    cal('weekdays', 'name: weekdays\n'),
    cal(
      'weekdays',
      'name: weekdays\ntimeZone: Asia/Singapore\nweekendDays: [SUNDAY]\nholidays: [2026-11-04, 2026-10-01]\nbusinessDays: [2026-11-08]\n',
      'prod',
    ),
    cal('broken', 'name: broken\nholidays: nope\n', 'prod'),
  ]
  const html = render(
    <CalendarsTable rows={calendarRows(calendars, [job('importer', { schedule: { cron: '0 2 * * *', calendar: 'weekdays' } })], '2026-11-03')} />,
  )
  const platform = rowOf(html, 'adhar-system')
  assertStringIncludes(platform, 'platform')
  assertStringIncludes(platform, 'Sat, Sun')
  assertStringIncludes(platform, 'the job’s')
  assertStringIncludes(platform, 'no job on this page', 'the team calendar of the same name is the one the job follows')
  const team = rowOf(html, 'replaces the platform calendar')
  assertStringIncludes(team, 'Asia/Singapore')
  assertStringIncludes(team, '2026-11-04 holiday')
  assertStringIncludes(team, '2026-11-08 working day')
  assert(!team.includes('2026-10-01'), 'a holiday that has passed is not coming up')
  assertStringIncludes(team, 'prod/importer')
  const broken = rowOf(html, '>broken<')
  assertStringIncludes(broken, 'Unreadable')
  assertStringIncludes(broken, 'holidays is not a list. A run that mounts it exits 2.')
  assertStringIncludes(render(<CalendarsTable rows={[]} />), 'No calendars')
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

Deno.test('page: ?view=tonight forecasts the listed jobs with the calendars read as the user, and offers a replay the caller may start', () => {
  const html = withLocation('?section=batch&view=tonight', () =>
    render(<Batch />, (qc) => {
      const list: BatchJobList = {
        items: [job('importer', { schedule: { cron: '* * * * *', calendar: 'never' } })],
        scope: 'cluster',
        namespaces: ['prod'],
        denied: [],
        installed: true,
      }
      qc.setQueryData(['batch', 'jobs', 'dev,prod,test'], list)
      qc.setQueryData(['batch', 'runs', 'cluster', 'prod'], {
        runs: [run('importer-aaaa1111', DONE)],
        pods: [pod('importer-aaaa1111', { executionId: 97, deadLettered: 10 })],
        partial: false,
        forbidden: false,
        volcano: false,
        podsUnknown: false,
      })
      qc.setQueryData(historyKey({ since: '30d', limit: 5_000 }), history())
      // Every day is a weekend on this calendar, so the verdict does not depend on today's date.
      qc.setQueryData(calendarsKey('prod'), {
        namespace: 'prod',
        state: 'read',
        calendars: [cal('never', 'name: never\nweekendDays: [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY]\n', 'prod')],
      })
      qc.setQueryData(calendarsKey('adhar-system'), { namespace: 'adhar-system', state: 'forbidden', calendars: [] })
      seedRunGate(qc, true)
    }))
  for (const section of ['Next 24 hours', 'Dependency chains', 'Dead-letter queue', 'Calendars']) assertStringIncludes(html, section)
  assertStringIncludes(html, 'Skips: weekend')
  assertStringIncludes(html, 'more fires in this window')
  assertStringIncludes(html, 'importer-aaaa1111')
  assertStringIncludes(html, '>Replay<')
  assertStringIncludes(html, 'You may not read the calendars of')
})
