import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { type BatchJobXR, parseRunTemplate, runName, type RunObject, type RunPod, type RunRow, runRows, type RunTemplate } from './batch-model.ts'
import {
  backfillDates,
  backfillPlan,
  backfillProgress,
  backfillState,
  type BatchEvent,
  businessDateField,
  calendarOf,
  calendarRows,
  deadlineAfter,
  dependencyChains,
  dependentsOf,
  dlqByJob,
  dlqEntries,
  eventDetail,
  historyRows,
  isBusinessDay,
  isOpsRun,
  MAX_BACKFILL_DATES,
  opsRunName,
  p90Of,
  parseCalendar,
  parseHistory,
  RELEASE_LOOP_START,
  type ReleaseLoop,
  releaseRetried,
  releaseSent,
  releaseSettled,
  releaseStep,
  replayPlan,
  successDurations,
  tonightRows,
  unforecastJobs,
} from './batch-history-model.ts'

/**
 * The Phase-3 rules of Develop → Batch (design 0025 §7.2, §8.1, D5, D12). Three
 * of them are shared with `adhar batch` and the batch observer, and a console
 * that disagrees with either does harm quietly: an ops Job under another name is
 * a second replay of the same execution, a forecast with another percentile
 * contradicts the `deadline.endangered` event beside it, and a backfill that
 * misreads "queued" releases more runs at once than it was asked to.
 */

const TESTDATA = new URL('./testdata/batch/', import.meta.url)
const json = async <T>(name: string) => JSON.parse(await Deno.readTextFile(new URL(name, TESTDATA))) as T

const NOW = Date.parse('2026-11-03T12:00:00Z')

const job = (name: string, p: NonNullable<BatchJobXR['spec']>['parameters'] = {}, over: Partial<BatchJobXR['metadata']> = {}): BatchJobXR => ({
  metadata: { name, namespace: 'prod', ...over },
  spec: { parameters: { job: 'importJob', image: 'img', ...p } },
})

const DONE = (end = '2026-11-03T02:10:00Z', start = '2026-11-03T02:00:00Z') => ({
  startTime: start,
  completionTime: end,
  succeeded: 1,
  conditions: [{ type: 'Complete', status: 'True' }],
})
const FAILED = { startTime: '2026-11-03T02:00:00Z', failed: 1, conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: '2026-11-03T02:05:00Z' }] }
const RUNNING = { startTime: '2026-11-03T02:00:00Z', active: 1 }

const run = (
  name: string,
  status: RunObject['status'],
  o: {
    job?: string
    ns?: string
    trigger?: string
    env?: Record<string, string>
    suspend?: boolean
    /** Suspended and carrying a backfill's mark: `adhar.io/batch-queued=backfill`. */
    queued?: boolean
    created?: string
    params?: Record<string, string>
  } = {},
): RunObject => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: {
    name,
    namespace: o.ns ?? 'prod',
    creationTimestamp: o.created ?? '2026-11-03T02:00:00Z',
    labels: { 'adhar.io/batch-job': o.job ?? 'importer', 'adhar.io/batch-trigger': o.trigger ?? 'schedule' },
    ...(o.queued ? { annotations: { 'adhar.io/batch-queued': 'backfill' } } : {}),
  },
  spec: {
    ...(o.suspend || o.queued ? { suspend: true } : {}),
    template: {
      spec: {
        containers: [{
          name: 'batch',
          image: 'img',
          env: [
            { name: 'ADHAR_BATCH_PARAMS', value: JSON.stringify(o.params ?? {}) },
            ...Object.entries(o.env ?? {}).map(([n, value]) => ({ name: n, value })),
          ],
        }],
      },
    },
  },
  status,
})

const pod = (jobName: string, summary: Record<string, unknown>, ns = 'prod'): RunPod => ({
  metadata: { name: `${jobName}-x`, namespace: ns, creationTimestamp: '2026-11-03T02:00:00Z', labels: { 'batch.kubernetes.io/job-name': jobName } },
  status: {
    phase: 'Succeeded',
    containerStatuses: [{
      name: 'batch',
      state: { terminated: { exitCode: Number(summary.exitCode ?? 0), message: JSON.stringify({ v: 1, outcome: 'completed', ...summary }) } },
    }],
  },
})

const rows = (runs: RunObject[], pods: RunPod[] = []): RunRow[] => runRows(runs, pods, NOW)

const ev = (type: string, subject: string, time: string, data: Record<string, unknown> = {}, id?: string): BatchEvent => ({
  id,
  type: `io.adhar.batch.${type}`,
  subject,
  time,
  data,
})

const template = async (): Promise<RunTemplate> => {
  const { template } = parseRunTemplate(await json<{ data: Record<string, string> }>('run-template-importer.configmap.json'))
  assert(template)
  return template
}

/* ─────────────────────────── the BFF's answer ─────────────────────────── */

Deno.test('history: a body that is not a history is unavailable, never an empty one', () => {
  for (const body of [null, 'oops', {}, { state: 'read' }, { state: 'read', events: 'none' }, { events: [] }]) {
    const r = parseHistory(body)
    assertEquals(r.state, 'unavailable', JSON.stringify(body))
  }
  assertEquals(parseHistory({ state: 'unavailable', reason: 'no-bus', detail: 'This cluster has no event bridge.' }), {
    state: 'unavailable',
    reason: 'no-bus',
    detail: 'This cluster has no event bridge.',
  })
  const read = parseHistory({
    state: 'read',
    events: [{ type: 'io.adhar.batch.run.failed', subject: 'prod/importer' }, { type: 7 }, null],
    total: 9,
    truncated: true,
  })
  assert(read.state === 'read')
  assertEquals(read.events.length, 1, 'an entry with no type or subject is dropped, not shown blank')
  assertEquals([read.total, read.truncated, read.behind, read.degraded], [9, true, false, false])
  // The read that ended early is its own flag, and only a literal true sets it.
  const late = parseHistory({ state: 'read', events: [], behind: true })
  assert(late.state === 'read' && late.behind && !late.truncated)
  const not = parseHistory({ state: 'read', events: [], behind: 'yes' })
  assert(not.state === 'read' && !not.behind)
})

Deno.test('history: rows are newest first, read from the event as the CLI reads it', () => {
  const out = historyRows([
    ev('run.started', 'prod/importer', '2026-11-03T02:00:00Z', { run: { name: 'importer-09932cb3', trigger: 'schedule' } }, 'a'),
    ev('run.failed', 'prod/importer', '2026-11-03T02:05:00Z', {
      run: { name: 'importer-09932cb3', trigger: 'schedule', actor: 'system:serviceaccount:prod:importer-batch' },
      springBatch: { executionId: 97, businessDate: '2026-11-03' },
      outcome: { reason: 'skip-limit', exitCode: 3 },
      counts: { read: 120, written: 100, deadLettered: 20 },
      durationSeconds: 300,
    }, 'b'),
    ev('schedule.held', 'prod/settle', '2026-11-02T09:00:00Z', { schedule: { holdReason: 'month end' } }, 'c'),
    { type: 'io.adhar.batch.run.novel', subject: 'prod/importer', time: 'not a time' },
    { type: 'io.adhar.batch.run.failed', subject: 'no-slash' },
  ])
  assertEquals(
    out.map((r) => r.key),
    ['b', 'a', 'c', 'prod/importer|io.adhar.batch.run.novel|not a time|3'],
    'an unreadable time sorts last and is still shown; a subject with no job is not a row',
  )
  const failed = out[0]
  assertEquals([failed.namespace, failed.job, failed.event, failed.label, failed.tone], ['prod', 'importer', 'run.failed', 'Failed', 'failed'])
  assertEquals([failed.run, failed.businessDate, failed.trigger, failed.executionId, failed.durationMs, failed.exitCode, failed.deadLettered], [
    'importer-09932cb3',
    '2026-11-03',
    'schedule',
    97,
    300_000,
    3,
    20,
  ])
  assertEquals(failed.detail, 'skip-limit · exit 3 · read 120 written 100 · 20 dead-lettered')
  assertEquals(out[2].detail, 'held: month end')
  // A type this page does not know keeps its own name instead of a guessed label.
  assertEquals([out[3].label, out[3].tone], ['run.novel', 'unknown'])
})

Deno.test('history: the detail names what each event type is about', () => {
  assertEquals(
    eventDetail({ deadline: { deadline: '2026-11-03T06:00:00Z', expectedEnd: '2026-11-03T06:20:00Z' } }),
    'deadline 2026-11-03T06:00:00Z · expected 2026-11-03T06:20:00Z',
  )
  assertEquals(
    eventDetail({ dependency: { after: ['prod/extract', 'prod/load'] }, run: { queue: 'adhar-batch.team-a' } }),
    'after prod/extract, prod/load · queue adhar-batch.team-a',
  )
  assertEquals(eventDetail({ pod: 'importer-x', schedule: { slot: '2026-11-03T02:00:00Z' } }), 'pod importer-x · slot 2026-11-03T02:00:00Z')
  assertEquals(eventDetail({ counts: { read: 5, deadLettered: 0 } }), 'read 5 written 0')
  assertEquals(eventDetail(undefined), '')
})

/* ─────────────────────────── ops Jobs: the CLI's names ─────────────────────────── */

Deno.test('ops run name: <job>-ops-<verb>-<executionId>, the CLI’s (cmd/batch/ops.go)', () => {
  assertEquals(opsRunName('importer', 'abandon', 412), 'importer-ops-abandon-412')
  assertEquals(opsRunName('importer', 'dlq-replay', 97), 'importer-ops-dlq-replay-97')
})

Deno.test('ops run name: a long job is cut at the PREFIX, leaving the id whole and room for -r99', () => {
  const long = 'a'.repeat(40) + '-' + 'b'.repeat(30)
  const got = opsRunName(long, 'dlq-replay', 1234567890123)
  assert(got.endsWith('-ops-dlq-replay-1234567890123'), got)
  assert(got.length + '-r99'.length <= 63, `${got.length}`)
  assertEquals(got.length + '-r99'.length, 63, 'no more of the job name is given up than the limit asks')
  // The cut never leaves a separator before the suffix.
  const dashed = opsRunName('a'.repeat(29) + '-----' + 'b'.repeat(30), 'dlq-replay', 1234567890123)
  assert(!dashed.includes('--ops-'), dashed)
  assert(dashed.startsWith('a'.repeat(29) + '-ops-'), dashed)
})

Deno.test('ops run: told by its trigger label or its command, so it is never counted as a business run', () => {
  assert(isOpsRun(run('x', {}, { trigger: 'ops' })))
  assert(isOpsRun(run('x', {}, { trigger: 'manual', env: { ADHAR_BATCH_COMMAND: 'abandon' } })))
  assert(!isOpsRun(run('x', {}, { trigger: 'manual' })))
})

/* ─────────────────────────── the dead-letter queue ─────────────────────────── */

Deno.test('dlq: counts come from the run’s summary, and from the end event once the run is gone; never both', () => {
  const held = rows([run('importer-aaaa1111', DONE())], [pod('importer-aaaa1111', { executionId: 97, deadLettered: 10, businessDate: '2026-11-03' })])
  const events = [
    // The same execution, as the observer reported it: counted once.
    ev('run.succeeded', 'prod/importer', '2026-11-03T02:10:00Z', {
      run: { name: 'importer-aaaa1111' },
      springBatch: { executionId: 97 },
      counts: { deadLettered: 10 },
    }),
    // A run past its TTL.
    ev('run.failed', 'prod/importer', '2026-10-20T02:10:00Z', {
      run: { name: 'importer-bbbb2222' },
      springBatch: { executionId: 61, businessDate: '2026-10-20' },
      counts: { deadLettered: 4 },
      end: '2026-10-20T02:09:00Z',
    }),
    // Not an end event, no dead letters, and an ops Job's own end: none is an entry.
    ev('run.started', 'prod/importer', '2026-10-21T02:00:00Z', { run: { name: 'importer-cccc3333' }, counts: { deadLettered: 9 } }),
    ev('run.succeeded', 'prod/importer', '2026-10-22T02:00:00Z', { run: { name: 'importer-dddd4444' }, counts: { deadLettered: 0 } }),
    ev('run.succeeded', 'prod/importer', '2026-10-23T02:00:00Z', {
      run: { name: 'importer-ops-dlq-replay-61', trigger: 'ops' },
      springBatch: { executionId: 70 },
      counts: { deadLettered: 2 },
    }),
    ev('run.failed', 'test/other', '2026-10-24T02:00:00Z', { run: { name: 'other-eeee5555' }, counts: { deadLettered: 1 } }),
  ]
  const entries = dlqEntries(held, events)
  assertEquals(entries.map((e) => [e.namespace, e.job, e.run, e.executionId, e.deadLettered, e.source]), [
    ['prod', 'importer', 'importer-aaaa1111', 97, 10, 'run'],
    ['test', 'other', 'other-eeee5555', undefined, 1, 'event'],
    ['prod', 'importer', 'importer-bbbb2222', 61, 4, 'event'],
  ])
  assertEquals(entries[2].businessDate, '2026-10-20')
  assertEquals(entries[2].ended, '2026-10-20T02:09:00Z', 'the run’s own end, not the time the event was published')
  const by = dlqByJob(entries)
  assertEquals(by.map((j) => [j.key, j.total, j.entries.length]), [['prod/importer', 14, 2], ['test/other', 1, 1]], 'the largest queue first')
})

Deno.test('dlq: an ops Job in the cluster is not a business run, and marks the execution it replays', () => {
  const held = rows([
    run('importer-aaaa1111', DONE()),
    run('importer-ops-dlq-replay-97', FAILED, {
      trigger: 'ops',
      env: { ADHAR_BATCH_COMMAND: 'dlq-replay', ADHAR_BATCH_EXECUTION_ID: '97' },
      created: '2026-11-03T03:00:00Z',
    }),
    run('importer-ops-dlq-replay-97-r1', RUNNING, {
      trigger: 'ops',
      env: { ADHAR_BATCH_COMMAND: 'dlq-replay', ADHAR_BATCH_EXECUTION_ID: '97' },
      created: '2026-11-03T04:00:00Z',
    }),
    // Another verb on the same execution is not a replay of it.
    run('importer-ops-abandon-97', DONE(), {
      trigger: 'ops',
      env: { ADHAR_BATCH_COMMAND: 'abandon', ADHAR_BATCH_EXECUTION_ID: '97' },
      created: '2026-11-03T05:00:00Z',
    }),
  ], [
    pod('importer-aaaa1111', { executionId: 97, deadLettered: 10 }),
    // The replay's own summary reports what it dead-lettered AGAIN: still not a business run.
    pod('importer-ops-dlq-replay-97', { executionId: 120, deadLettered: 3, exitCode: 3 }),
  ])
  const entries = dlqEntries(held, [])
  assertEquals(entries.map((e) => e.run), ['importer-aaaa1111'])
  assertEquals(entries[0].replay, { run: 'importer-ops-dlq-replay-97-r1', phase: 'running' }, 'the latest replay, which is the retry')
})

Deno.test('replay plan: ask twice and the replay that exists is shown; only a failed one is retried, as -r<n>', () => {
  const entry = { namespace: 'prod', job: 'importer', executionId: 97 }
  assertEquals(replayPlan(entry, []), { action: 'create', name: 'importer-ops-dlq-replay-97' })
  assertEquals(replayPlan(entry, [{ namespace: 'prod', name: 'importer-ops-dlq-replay-97', phase: 'running' }]), {
    action: 'exists',
    name: 'importer-ops-dlq-replay-97',
    phase: 'running',
  })
  assertEquals(replayPlan(entry, [{ namespace: 'prod', name: 'importer-ops-dlq-replay-97', phase: 'succeeded' }]), {
    action: 'exists',
    name: 'importer-ops-dlq-replay-97',
    phase: 'succeeded',
  })
  assertEquals(
    replayPlan(entry, [{ namespace: 'prod', name: 'importer-ops-dlq-replay-97', phase: 'failed' }]),
    { action: 'create', name: 'importer-ops-dlq-replay-97-r1', restartOf: 'importer-ops-dlq-replay-97' },
  )
  // The LATEST of the chain decides: r1 failed too → r2; r1 running → shown.
  const chain = [{ namespace: 'prod', name: 'importer-ops-dlq-replay-97', phase: 'failed' as const }, {
    namespace: 'prod',
    name: 'importer-ops-dlq-replay-97-r1',
    phase: 'failed' as const,
  }]
  assertEquals(replayPlan(entry, chain), { action: 'create', name: 'importer-ops-dlq-replay-97-r2', restartOf: 'importer-ops-dlq-replay-97-r1' })
  assertEquals(replayPlan(entry, [chain[0], { ...chain[1], phase: 'running' }]).action, 'exists')
  // The same name in another namespace is another job's, and execution 970 is not execution 97.
  assertEquals(replayPlan(entry, [{ namespace: 'test', name: 'importer-ops-dlq-replay-97', phase: 'running' }]).action, 'create')
  assertEquals(replayPlan(entry, [{ namespace: 'prod', name: 'importer-ops-dlq-replay-970', phase: 'running' }]).action, 'create')
})

Deno.test('replay plan: refused without an execution id, and after 99 retries', () => {
  const none = replayPlan({ namespace: 'prod', job: 'importer', executionId: undefined }, [])
  assert(none.action === 'refused')
  assertStringIncludes(none.reason, 'no execution id')
  const base = 'importer-ops-dlq-replay-97'
  const spent = [
    { namespace: 'prod', name: base, phase: 'failed' as const },
    ...Array.from({ length: 99 }, (_, i) => ({ namespace: 'prod', name: `${base}-r${i + 1}`, phase: 'failed' as const })),
  ]
  const out = replayPlan({ namespace: 'prod', job: 'importer', executionId: 97 }, spent)
  assert(out.action === 'refused')
  assertStringIncludes(out.reason, '99 restarts')
})

/* ─────────────────────────── calendars (D5) ─────────────────────────── */

const cm = (name: string, yaml: string | undefined, namespace = 'adhar-system') => ({
  metadata: { name, namespace },
  data: (yaml === undefined ? {} : { 'calendar.yaml': yaml }) as Record<string, string>,
})

Deno.test('calendar: the platform’s weekdays calendar, as core/adhar-batch ships it', () => {
  const c = parseCalendar(cm('weekdays', 'name: weekdays\nweekendDays: [SATURDAY, SUNDAY]\nholidays: []\nbusinessDays: []\n'))
  assertEquals(c, { namespace: 'adhar-system', name: 'weekdays', weekendDays: ['SATURDAY', 'SUNDAY'], holidays: [], businessDays: [] })
  assert(isBusinessDay(c, '2026-11-06'), 'a Friday')
  assert(!isBusinessDay(c, '2026-11-07'), 'a Saturday')
  assert(!isBusinessDay(c, '2026-11-08'), 'a Sunday')
  assert(isBusinessDay(c, '2026-11-09'), 'a Monday')
})

Deno.test('calendar: D5’s rule — a listed business day beats the weekend AND a holiday; a holiday beats a weekday', () => {
  const c = parseCalendar(
    cm(
      'sg',
      'name: sg\ntimeZone: Asia/Singapore\nweekendDays:\n  - friday\n  - SATURDAY\nholidays:\n  - 2026-11-09\n  - 2026-12-25\nbusinessDays:\n  - 2026-11-07\n  - 2026-12-25\n',
      'prod',
    ),
  )
  assertEquals(c.error, undefined)
  assertEquals([c.timeZone, c.weekendDays, c.holidays, c.businessDays], ['Asia/Singapore', ['FRIDAY', 'SATURDAY'], ['2026-11-09', '2026-12-25'], [
    '2026-11-07',
    '2026-12-25',
  ]])
  assert(!isBusinessDay(c, '2026-11-06'), 'Friday is this calendar’s weekend')
  assert(isBusinessDay(c, '2026-11-07'), 'a working Saturday')
  assert(isBusinessDay(c, '2026-11-08'), 'Sunday is a working day here')
  assert(!isBusinessDay(c, '2026-11-09'), 'a holiday on a Monday')
  assert(isBusinessDay(c, '2026-12-25'), 'listed in both: businessDays wins')
})

Deno.test('calendar: no weekendDays means Saturday and Sunday; an empty list means none', () => {
  assertEquals(parseCalendar(cm('a', 'name: a\n')).weekendDays, ['SATURDAY', 'SUNDAY'])
  const none = parseCalendar(cm('b', 'name: b\nweekendDays: []\n'))
  assertEquals(none.weekendDays, [])
  assert(isBusinessDay(none, '2026-11-07'))
})

Deno.test('calendar: one that cannot be read keeps its name and says why', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, 'no calendar.yaml'],
    ['   \n', 'no calendar.yaml'],
    ['- a\n- b\n', 'cannot be read'],
    ['name: x\nweekendDays: SATURDAY\n', 'weekendDays is not a list'],
    ['name: x\nweekendDays: [SATURDAY, FUNDAY]\n', 'FUNDAY, which is not a day of the week'],
    ['name: x\nholidays: tomorrow\n', 'holidays is not a list'],
    ['name: x\nholidays:\n  - 2026-13-45\n', 'holidays has 2026-13-45, which is not a date'],
    ['name: x\nbusinessDays:\n  - 7 Nov\n', 'businessDays has 7 Nov'],
    // A date that does not exist is not rolled over into the next month: the runner reading this file refuses it (exit 2).
    ['name: x\nholidays: [2026-02-30]\n', 'holidays has 2026-02-30, which is not a date'],
    ['name: x\nholidays: ["2026-02-29"]\n', 'holidays has 2026-02-29, which is not a date'],
    ['name: x\nbusinessDays: ["2026-04-31"]\n', 'businessDays has 2026-04-31, which is not a date'],
  ]
  for (const [yaml, want] of cases) {
    const c = parseCalendar(cm('x', yaml, 'prod'))
    assertEquals([c.name, c.namespace], ['x', 'prod'])
    assertStringIncludes(c.error ?? '', want, String(yaml))
  }
  // A leap day that exists is a date.
  assertEquals(parseCalendar(cm('x', 'holidays: [2028-02-29]\n', 'prod')), {
    namespace: 'prod',
    name: 'x',
    weekendDays: ['SATURDAY', 'SUNDAY'],
    holidays: ['2028-02-29'],
    businessDays: [],
  })
})

Deno.test('calendar: a job’s own namespace is looked in first, then the platform’s', () => {
  const platform = parseCalendar(cm('weekdays', 'name: weekdays\n'))
  const team = parseCalendar(cm('weekdays', 'name: weekdays\nweekendDays: [SUNDAY]\n', 'prod'))
  const j = job('importer', { schedule: { cron: '0 2 * * *', calendar: 'weekdays' } })
  assertEquals(calendarOf(j, [platform, team])?.calendar, team)
  assertEquals(
    calendarOf(job('importer', { schedule: { cron: '0 2 * * *', calendar: 'weekdays' } }, { namespace: 'test' }), [platform, team])?.calendar,
    platform,
  )
  assertEquals(calendarOf(job('importer', { schedule: { cron: '0 2 * * *', calendar: 'bank' } }), [platform, team]), { name: 'bank', calendar: undefined })
  assertEquals(calendarOf(job('importer', { schedule: { cron: '0 2 * * *' } }), [platform]), undefined)
  // Another team's calendar of that name is never borrowed.
  assertEquals(calendarOf(job('importer', { schedule: { calendar: 'weekdays' } }, { namespace: 'dev' }), [team])?.calendar, undefined)

  const out = calendarRows([team, platform], [j, job('settle', { schedule: { calendar: 'weekdays' } }, { namespace: 'test' })], '2026-11-03')
  assertEquals(out.map((r) => [r.key, r.scope, r.usedBy, r.shadows ?? false]), [
    ['adhar-system/weekdays', 'platform', ['test/settle'], false],
    ['prod/weekdays', 'team', ['prod/importer'], true],
  ])
})

Deno.test('calendar rows: what is coming up starts today, holidays and working days in date order', () => {
  const c = parseCalendar(cm('sg', 'name: sg\nholidays: [2026-11-02, 2026-11-03, 2026-12-25]\nbusinessDays: [2026-11-07, 2026-10-31]\n'))
  assertEquals(calendarRows([c], [], '2026-11-03')[0].upcoming, [
    { date: '2026-11-03', kind: 'holiday' },
    { date: '2026-11-07', kind: 'business day' },
    { date: '2026-12-25', kind: 'holiday' },
  ])
})

/* ─────────────────────────── the forecast ─────────────────────────── */

Deno.test('p90: nearest rank, the batch observer’s (platform/controllers/batch/schedule.go)', () => {
  assertEquals(p90Of([]), undefined)
  assertEquals(p90Of([7]), 7)
  assertEquals(p90Of([10, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 9, 'ceil(0.9 × 10) = the 9th')
  assertEquals(p90Of([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 10, 'ceil(0.9 × 11) = the 10th')
  assertEquals(p90Of([100, 200]), 200)
})

Deno.test('durations: the last successes, cluster then history, each run once, newest twenty', () => {
  const held = rows([
    run('importer-a', DONE('2026-11-03T02:10:00Z')),
    run('importer-f', FAILED),
    run('importer-ops-dlq-replay-97', DONE('2026-11-03T03:00:30Z', '2026-11-03T03:00:00Z'), { trigger: 'ops' }),
    run('other-a', DONE('2026-11-03T02:01:00Z'), { job: 'other' }),
    run('importer-a', DONE('2026-11-03T02:01:00Z'), { ns: 'test' }),
  ])
  const events = [
    ev('run.succeeded', 'prod/importer', '2026-11-03T02:10:00Z', { run: { name: 'importer-a' }, durationSeconds: 600 }),
    ev('run.succeeded', 'prod/importer', '2026-11-01T02:20:00Z', { run: { name: 'importer-old' }, durationSeconds: 1200 }),
    ev('run.succeeded', 'prod/importer', '2026-11-02T02:20:00Z', { run: { name: 'importer-ops-dlq-replay-61', trigger: 'ops' }, durationSeconds: 5 }),
    ev('run.failed', 'prod/importer', '2026-11-02T02:20:00Z', { run: { name: 'importer-x' }, durationSeconds: 9 }),
    ev('run.succeeded', 'prod/importer-eu', '2026-11-02T02:20:00Z', { run: { name: 'importer-eu-a' }, durationSeconds: 7 }),
    ev('run.succeeded', 'prod/importer', '2026-11-02T02:20:00Z', { run: { name: 'importer-nodur' } }),
  ]
  assertEquals(successDurations('prod', 'importer', held, events), [600_000, 1_200_000])
  const many = Array.from(
    { length: 30 },
    (_, i) =>
      ev('run.succeeded', 'prod/importer', new Date(Date.parse('2026-10-01T00:00:00Z') + i * 86_400_000).toISOString(), {
        run: { name: `r${i}` },
        durationSeconds: i,
      }),
  )
  const got = successDurations('prod', 'importer', [], many)
  assertEquals(got.length, 20)
  assertEquals([got[0], got[19]], [29_000, 10_000], 'the newest twenty, newest first')
})

Deno.test('forecast: a time zone nobody can read leaves that job out and SAYS so; the others are still forecast', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  const jobs = [
    job('good', { schedule: { cron: '0 20 * * *' } }),
    // The XRD takes any string: a misspelling reaches the page.
    job('typo', { schedule: { cron: '0 20 * * *', timeZone: 'Asia/Kolkatta' } }),
    job('late', { schedule: { cron: '0 20 * * *' }, sla: { finishBy: '06:00', timeZone: 'Mars/Phobos' } }),
    job('fine', { schedule: { cron: '0 20 * * *', timeZone: 'Asia/Kolkata' }, sla: { finishBy: '06:00' } }),
    // Not scheduled to run, so nothing is missing from the forecast.
    job('on-demand', { schedule: undefined }),
    job('held', { schedule: { cron: '0 20 * * *', timeZone: 'Asia/Kolkatta' } }, { annotations: { 'adhar.io/batch-hold': 'x' } }),
    job('off', { schedule: { cron: '0 20 * * *', timeZone: 'Asia/Kolkatta', suspend: true } }),
  ]
  const rows = tonightRows(jobs, { now })
  assertEquals(rows.map((r) => r.job).sort(), ['fine', 'good', 'late'])
  const late = rows.find((r) => r.job === 'late')!
  assertEquals([late.finishBy, late.deadlineMs, late.sla], ['06:00', undefined, 'none'], 'no deadline is invented in a zone that cannot be read')
  assertEquals(unforecastJobs(jobs), [
    { key: 'prod/late', what: 'sla', timeZone: 'Mars/Phobos' },
    { key: 'prod/typo', what: 'schedule', timeZone: 'Asia/Kolkatta' },
  ])
  assertEquals(deadlineAfter(now, '06:00', 'Asia/Kolkatta'), undefined)
})

Deno.test('deadline: the first HH:MM at or after the anchor, on the zone’s own clock', () => {
  const at = (iso: string) => Date.parse(iso)
  assertEquals(deadlineAfter(at('2026-11-03T02:00:00Z'), '06:00', 'UTC'), at('2026-11-03T06:00:00Z'))
  assertEquals(deadlineAfter(at('2026-11-03T06:00:00Z'), '06:00', 'UTC'), at('2026-11-03T06:00:00Z'), 'at the deadline is still inside it')
  assertEquals(deadlineAfter(at('2026-11-03T06:00:30Z'), '06:00', 'UTC'), at('2026-11-04T06:00:00Z'))
  assertEquals(deadlineAfter(at('2026-11-03T22:00:00Z'), '06:00', 'UTC'), at('2026-11-04T06:00:00Z'), 'a night job’s deadline is the next morning')
  assertEquals(deadlineAfter(at('2026-11-03T02:00:00Z'), '06:00', 'Asia/Singapore'), at('2026-11-03T22:00:00Z'))
  for (const bad of [undefined, '', '6:00', '24:00', '06:60', 'soon']) {
    assertEquals(deadlineAfter(at('2026-11-03T02:00:00Z'), bad, 'UTC'), undefined, String(bad))
  }
})

Deno.test('tonight: every fire in 24 hours of a schedule that is neither held nor suspended', () => {
  const jobs = [
    job('nightly', { schedule: { cron: '0 2 * * *', timeZone: 'UTC' }, displayName: 'Nightly import' }, {
      labels: { 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod' },
    }),
    job('held', { schedule: { cron: '0 3 * * *' } }, { annotations: { 'adhar.io/batch-hold': 'month end' } }),
    job('suspended', { schedule: { cron: '0 3 * * *', suspend: true } }),
    job('on-demand'),
    job('weekly', { schedule: { cron: '0 5 * * 0' } }), // next Sunday, outside the window
    job('sg', { schedule: { cron: '30 0 * * *', timeZone: 'Asia/Singapore' } }, { namespace: 'test' }),
  ]
  const out = tonightRows(jobs, { now: NOW, envByNamespace: new Map([['test', 'test']]) })
  assertEquals(out.map((r) => [r.key, r.businessDate, r.environment]), [
    // 00:30 in Singapore is 16:30 UTC, and its business date is Singapore's.
    [`test/sg@${Date.parse('2026-11-03T16:30:00Z')}`, '2026-11-04', 'test'],
    [`prod/nightly@${Date.parse('2026-11-04T02:00:00Z')}`, '2026-11-04', 'prod'],
  ])
  assertEquals([out[1].displayName, out[1].application, out[1].sla, out[1].calendar.state, out[1].p90Ms, out[1].expectedEndMs], [
    'Nightly import',
    'importer',
    'none',
    'none',
    undefined,
    undefined,
  ])
})

Deno.test('tonight: a frequent job gets four rows and says how many more fire', () => {
  const out = tonightRows([job('poller', { schedule: { cron: '0 * * * *' } })], { now: NOW })
  assertEquals(out.length, 4)
  assertEquals(out.map((r) => r.more), [0, 0, 0, 20], '24 fires in the window, four shown')
  assertEquals(out[0].startMs, Date.parse('2026-11-03T13:00:00Z'))
})

Deno.test('tonight: expected end is start + p90, and finishBy makes it on time, at risk or unknown', () => {
  const sla = (finishBy: string, timeZone?: string) => job('nightly', { schedule: { cron: '0 2 * * *' }, sla: { finishBy, ...(timeZone ? { timeZone } : {}) } })
  const events = Array.from(
    { length: 10 },
    (_, i) => ev('run.succeeded', 'prod/nightly', `2026-10-${10 + i}T03:00:00Z`, { run: { name: `nightly-${i}` }, durationSeconds: (i + 1) * 600 }),
  )
  const start = Date.parse('2026-11-04T02:00:00Z')
  // p90 of 10..100 minutes is 90 minutes: ends 03:30.
  const [ok] = tonightRows([sla('04:00')], { now: NOW, events })
  assertEquals([ok.p90Ms, ok.expectedEndMs, ok.deadlineMs, ok.slackMs, ok.sla], [
    5_400_000,
    start + 5_400_000,
    Date.parse('2026-11-04T04:00:00Z'),
    1_800_000,
    'ok',
  ])
  const [risk] = tonightRows([sla('03:00')], { now: NOW, events })
  assertEquals([risk.slackMs, risk.sla], [-1_800_000, 'at-risk'])
  const [edge] = tonightRows([sla('03:30')], { now: NOW, events })
  assertEquals([edge.slackMs, edge.sla], [0, 'ok'], 'ending at the deadline meets it')
  // No history: the deadline is known, the end is not. Never drawn as on time.
  const [blind] = tonightRows([sla('03:00')], { now: NOW })
  assertEquals([blind.expectedEndMs, blind.slackMs, blind.sla, blind.deadlineMs], [undefined, undefined, 'unknown', Date.parse('2026-11-04T03:00:00Z')])
  // The SLA's own zone, when it has one: 11:00 in Singapore is 03:00 UTC.
  const [zoned] = tonightRows([sla('11:00', 'Asia/Singapore')], { now: NOW, events })
  assertEquals([zoned.deadlineMs, zoned.sla], [Date.parse('2026-11-04T03:00:00Z'), 'at-risk'])
})

Deno.test('tonight: the calendar is applied to the business date — skipped, a business day, or unknown; never guessed', () => {
  const weekdays = parseCalendar(cm('weekdays', 'name: weekdays\n'))
  const bank = parseCalendar(cm('bank', 'name: bank\nholidays: [2026-11-04]\n', 'prod'))
  const broken = parseCalendar(cm('broken', 'name: broken\nholidays: nope\n', 'prod'))
  const j = (calendar: string, cron = '0 2 * * *', sla?: { finishBy: string }) =>
    job(`on-${calendar}`, { schedule: { cron, calendar }, ...(sla ? { sla } : {}) })
  const first = (x: BatchJobXR, now = NOW, unreadCalendars: string[] = []) => tonightRows([x], { now, calendars: [weekdays, bank, broken], unreadCalendars })[0]

  assertEquals(first(j('weekdays')).calendar, { state: 'business-day', calendar: 'weekdays' }) // Wednesday the 4th
  assertEquals(first(j('bank')).calendar, { state: 'skipped', calendar: 'bank', why: 'holiday' })
  // Friday noon: the next fire is Saturday the 7th.
  assertEquals(first(j('weekdays'), Date.parse('2026-11-06T12:00:00Z')).calendar, { state: 'skipped', calendar: 'weekdays', why: 'weekend' })
  const missing = first(j('nowhere')).calendar
  assert(missing.state === 'unknown')
  assertStringIncludes(missing.why, 'not found')
  const unreadable = first(j('broken')).calendar
  assert(unreadable.state === 'unknown')
  assertStringIncludes(unreadable.why, 'holidays is not a list')
  // A namespace this person may not list is not "absent".
  const hidden = first(j('nowhere'), NOW, ['adhar-system']).calendar
  assert(hidden.state === 'unknown')
  assertStringIncludes(hidden.why, 'may not read the calendars of adhar-system')

  // A skipped date has no work due, so no deadline to miss; an unknown calendar still has one.
  assertEquals(first(j('bank', '0 2 * * *', { finishBy: '03:00' })).sla, 'none')
  assertEquals(first(j('nowhere', '0 2 * * *', { finishBy: '03:00' })).sla, 'unknown')
})

/* ─────────────────────────── dependency chains ─────────────────────────── */

Deno.test('chains: who waits for whom, and whether what they wait for has succeeded', () => {
  const jobs = [
    job('extract', { schedule: { cron: '0 1 * * *' } }),
    job('load', { dependsOn: [{ batchJob: 'extract' }] }),
    job('report', { dependsOn: [{ batchJob: 'load' }, { batchJob: 'rates', namespace: 'shared' }] }),
    job('mirror', { dependsOn: [{ batchJob: 'extract', sameBusinessDate: false }, {}] }),
  ]
  assertEquals([...dependentsOf(jobs)], [['prod/extract', ['prod/load', 'prod/mirror']], ['prod/load', ['prod/report']], ['shared/rates', ['prod/report']]])
  // Tonight's row for extract names what it starts.
  assertEquals(tonightRows(jobs, { now: NOW })[0].then, ['prod/load', 'prod/mirror'])

  const held = rows([
    run('extract-new', FAILED, { job: 'extract', created: '2026-11-03T01:00:00Z', params: { businessDate: '2026-11-03' } }),
    run('extract-old', DONE('2026-11-02T01:10:00Z', '2026-11-02T01:00:00Z'), {
      job: 'extract',
      created: '2026-11-02T01:00:00Z',
      params: { businessDate: '2026-11-02' },
    }),
    run('load-dep', DONE(), { job: 'load', trigger: 'dependency', created: '2026-11-02T01:11:00Z', params: { businessDate: '2026-11-02' } }),
    run('extract-ops-abandon-5', DONE(), { job: 'extract', trigger: 'ops', created: '2026-11-03T05:00:00Z' }),
  ])
  const chains = dependencyChains(jobs, held)
  assertEquals(chains.map((c) => [c.key, c.state]), [['prod/load', 'ready'], ['prod/mirror', 'waiting'], ['prod/report', 'unknown']])
  const load = chains[0]
  assertEquals(load.after, [{ key: 'prod/extract', sameBusinessDate: true, known: true, lastPhase: 'failed', lastSuccessDate: '2026-11-02' }])
  assertEquals(load.lastDependencyRun, { name: 'load-dep', phase: 'succeeded', businessDate: '2026-11-02' })
  // Latest-run rule: extract's newest BUSINESS run failed (the ops Job after it does not count).
  assertEquals(chains[1].after[0].lastPhase, 'failed')
  // An upstream out of sight is not judged.
  assertEquals(chains[2].after.map((l) => [l.key, l.known]), [['prod/load', true], ['shared/rates', false]])
})

/* ─────────────────────────── backfill ─────────────────────────── */

Deno.test('backfill dates: inclusive, in order, and bounded', () => {
  assertEquals(backfillDates('2026-10-30', '2026-11-02'), { dates: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'] })
  assertEquals(backfillDates('2026-11-02', '2026-11-02'), { dates: ['2026-11-02'] })
  assertStringIncludes(backfillDates('2026-11-03', '2026-11-02').error ?? '', '2026-11-02 is before 2026-11-03')
  assertStringIncludes(backfillDates('2026-02-30', '2026-03-02').error ?? '', 'first date')
  assertStringIncludes(backfillDates('2026-03-01', '03/02/2026').error ?? '', 'last date')
  const year = backfillDates('2025-01-01', '2026-01-01')
  assert('dates' in year && year.dates.length === MAX_BACKFILL_DATES, 'exactly the bound is allowed')
  assertStringIncludes(backfillDates('2025-01-01', '2026-01-02').error ?? '', `more than ${MAX_BACKFILL_DATES} dates`)
})

Deno.test('backfill: the business date goes into businessDate, else the first date the schedule supplies', async () => {
  const t = await template()
  assertEquals(businessDateField(t.fields)?.name, 'businessDate')
  const f = (name: string, type: string, source: string) => ({ ...t.fields[0], name, type, source }) as (typeof t.fields)[number]
  assertEquals(businessDateField([f('asOf', 'date', 'input'), f('day', 'date', 'schedule'), f('other', 'date', 'schedule')])?.name, 'day')
  assertEquals(businessDateField([f('asOf', 'date', 'input'), f('at', 'string', 'schedule')]), undefined)
})

Deno.test('backfill plan: every date named as Run now names it; done is left alone, failed is restarted, in flight is found', async () => {
  const t = await template()
  const name = (date: string) => runName('importer', { businessDate: date, source: 'inbound/records.csv' })
  assertEquals(runName('importer', { businessDate: '2026-11-03' }), 'importer-09932cb3', 'naming v1')
  const held = rows([
    run(name('2026-11-01'), DONE()),
    run(name('2026-11-02'), FAILED),
    run(name('2026-11-03'), RUNNING),
    run(name('2026-11-04'), {}, { queued: true }), // queued by an earlier backfill
    // Stopped by a person. Since Kubernetes 1.36 its status is that of a run that never started: only the mark tells.
    run(name('2026-11-05'), {}, { suspend: true }),
    run(name('2026-11-06'), FAILED),
    run(`${name('2026-11-06')}-r1`, DONE()),
    // Another job's run of the same name pattern is not this job's.
    run(name('2026-11-07'), DONE(), { job: 'other' }),
  ])
  const plan = backfillPlan(
    { namespace: 'prod', job: 'importer' },
    t,
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'],
    {},
    held,
  )
  assert('items' in plan, plan.error)
  assertEquals([plan.volcano, plan.field], [false, 'businessDate'])
  assertEquals(plan.items.map((i) => [i.businessDate, i.action, i.run, i.restartOf]), [
    ['2026-11-01', 'completed', name('2026-11-01'), undefined],
    ['2026-11-02', 'restart', `${name('2026-11-02')}-r1`, name('2026-11-02')],
    ['2026-11-03', 'exists', name('2026-11-03'), undefined],
    ['2026-11-04', 'exists', name('2026-11-04'), undefined],
    ['2026-11-05', 'stopped', name('2026-11-05'), undefined],
    // The restart that succeeded describes the date, not the base that failed.
    ['2026-11-06', 'completed', `${name('2026-11-06')}-r1`, undefined],
    ['2026-11-07', 'create', name('2026-11-07'), undefined],
  ])
  assertEquals(
    plan.items[6].params,
    { businessDate: '2026-11-07', source: 'inbound/records.csv', dryRun: 'false' },
    'defaults resolved exactly as Run now resolves them',
  )
})

Deno.test('backfill plan: extra parameters are the same for every date and change the identity', async () => {
  const t = await template()
  const plan = backfillPlan({ namespace: 'prod', job: 'importer' }, t, ['2026-11-01'], { source: 'inbound/redo.csv' }, [])
  assert('items' in plan)
  assertEquals(plan.items[0].run, runName('importer', { businessDate: '2026-11-01', source: 'inbound/redo.csv' }))
})

Deno.test('backfill plan: one refused date refuses the backfill, before anything is created', async () => {
  const t = await template()
  const bad = backfillPlan({ namespace: 'prod', job: 'importer' }, t, ['2026-11-01', '2026-11-02'], { source: 'has spaces' }, [])
  assert(!('items' in bad))
  assertStringIncludes(bad.error, 'Parameters refused. 2026-11-01: source:')
  assertStringIncludes(
    backfillPlan({ namespace: 'prod', job: 'importer' }, t, ['2026-11-01'], { businessDate: '2026-01-01' }, []).error ?? '',
    'businessDate is the business date',
  )
  assertStringIncludes(
    backfillPlan({ namespace: 'prod', job: 'importer' }, { ...t, fields: t.fields.slice(1) }, ['2026-11-01'], {}, []).error ?? '',
    'declares no business-date parameter',
  )
  assertStringIncludes(
    backfillPlan({ namespace: 'prod', job: 'importer' }, { ...t, paramsError: 'parameters.json is not JSON' }, ['2026-11-01'], {}, []).error ?? '',
    'parameters.json is not JSON',
  )
  // A date whose chain is spent refuses the whole backfill.
  const base = runName('importer', { businessDate: '2026-11-01', source: 'inbound/records.csv' })
  const spent = rows([run(base, FAILED), ...Array.from({ length: 99 }, (_, i) => run(`${base}-r${i + 1}`, FAILED))])
  assertStringIncludes(backfillPlan({ namespace: 'prod', job: 'importer' }, t, ['2026-11-01'], {}, spent).error ?? '', '99 restarts')
})

Deno.test('backfill state: queued is a backfill’s MARK and no sign of a start; suspended otherwise is stopped; anything unproven is in flight', () => {
  const one = (r: RunObject) => backfillState(rows([r])[0])
  assertEquals(one(run('a', {}, { queued: true })), 'queued')
  assertEquals(one(run('a', undefined, { queued: true })), 'queued', 'no status yet')
  // The CLI's rule (cmd/batch/backfill.go). Kubernetes 1.36 clears status.startTime on every suspend, so a run a
  // person stopped before a pod failed has exactly this status: without the mark it is theirs, and is never released.
  assertEquals(one(run('a', {}, { suspend: true })), 'stopped', 'suspended with no mark is a person’s')
  assertEquals(one(run('a', undefined, { suspend: true })), 'stopped')
  const other = run('a', {}, { suspend: true })
  other.metadata.annotations = { 'adhar.io/batch-queued': 'someone-else' }
  assertEquals(one(other), 'stopped', 'queued by something this page knows nothing about')
  // The mark alone is not enough either: a marked run that shows a start was not left waiting.
  assertEquals(one(run('a', { startTime: '2026-11-03T02:00:00Z' }, { queued: true })), 'stopped')
  assertEquals(one(run('a', { failed: 1 }, { queued: true })), 'stopped')
  assertEquals(one(run('a', { succeeded: 1 }, { queued: true })), 'stopped')
  assertEquals(one(run('a', { active: 1 }, { queued: true })), 'in-flight', 'still stopping')
  assertEquals(one(run('a', { terminating: 1 }, { queued: true })), 'in-flight')
  assertEquals(one(run('a', { active: 1 }, { suspend: true })), 'in-flight', 'still stopping')
  assertEquals(one(run('a', { terminating: 1 }, { suspend: true })), 'in-flight')
  assertEquals(one(run('a', {})), 'in-flight', 'released, not started yet')
  assertEquals(one(run('a', RUNNING)), 'in-flight')
  assertEquals(one(run('a', DONE())), 'done')
  assertEquals(one(run('a', FAILED)), 'done')
})

Deno.test('backfill progress (A3.3): queued runs are released in date order, never more than parallel in flight', () => {
  const names = ['d1', 'd2', 'd3', 'd4', 'd5']
  const world = (s: Record<string, RunObject['status'] | 'queued'>) =>
    rows(Object.entries(s).map(([n, st]) => (st === 'queued' ? run(n, {}, { queued: true }) : run(n, st))))
  const all = world({ d1: 'queued', d2: 'queued', d3: 'queued', d4: 'queued', d5: 'queued' })
  let p = backfillProgress(names, all, 2, false)
  assertEquals([p.release.map((r) => r.name), p.inFlight, p.queued, p.settled], [['d1', 'd2'], 0, 5, false])
  // The list has not caught up with the release yet: nothing more is released.
  p = backfillProgress(names, all, 2, false, new Set(['d1', 'd2']))
  assertEquals([p.release.length, p.inFlight, p.queued], [0, 2, 3])
  // One ended, one still running: exactly one more.
  p = backfillProgress(names, world({ d1: DONE(), d2: RUNNING, d3: 'queued', d4: 'queued', d5: 'queued' }), 2, false, new Set(['d1', 'd2']))
  assertEquals([p.release.map((r) => r.name), p.done, p.inFlight, p.queued], [['d3'], 1, 1, 3])
  // A failed run frees its slot like a finished one; a deleted one is gone, not in flight.
  p = backfillProgress(names, world({ d1: DONE(), d2: FAILED, d4: 'queued', d5: 'queued' }), 2, false)
  assertEquals([p.release.map((r) => r.name), p.done, p.gone], [['d4', 'd5'], 2, 1])
  // Everything released: settled, even while runs are still going.
  p = backfillProgress(names, world({ d1: DONE(), d2: DONE(), d3: DONE(), d4: RUNNING, d5: RUNNING }), 2, false)
  assertEquals([p.release.length, p.settled, p.inFlight], [0, true, 2])
  // A nonsense parallel still makes progress, one at a time.
  assertEquals(backfillProgress(names, all, 0, false).release.map((r) => r.name), ['d1'])
  // A run a person stopped is left alone and holds no slot, whatever its status says about having started.
  p = backfillProgress(['d1', 'd2'], rows([run('d1', {}, { suspend: true }), run('d2', {}, { queued: true })]), 1, false)
  assertEquals([p.stopped, p.release.map((r) => r.name)], [1, ['d2']])
})

Deno.test('backfill progress: on Volcano nothing is released from here — the queue decides', () => {
  const all = rows([run('d1', {}, { queued: true }), run('d2', {}, { queued: true })])
  const p = backfillProgress(['d1', 'd2'], all, 2, true)
  assertEquals([p.release, p.queued], [[], 2])
})

/**
 * The backfill dialog's release loop, as its effect drives it: the effect fires
 * when the names `releaseStep` returns change, sends them, and settles. This
 * harness is that effect without a renderer, so the two ways the loop used to
 * stall are held here: a failed release counted in flight for the rest of the
 * session, and a run list that changed while a release was pending never acted on.
 */
function releaseHarness(names: readonly string[], parallel: number) {
  let loop: ReleaseLoop = RELEASE_LOOP_START
  let key = ''
  const sent: string[][] = []
  return {
    /** A render: returns the batch the effect sends, or undefined when the key did not change. */
    render(runs: RunRow[]) {
      const batch = releaseStep(names, runs, parallel, false, loop)
      const next = batch.map((r) => r.name).join(',')
      if (next === key) return undefined
      key = next
      if (!batch.length) return undefined
      loop = releaseSent(loop, batch.map((r) => r.name))
      sent.push(batch.map((r) => r.name))
      return batch.map((r) => r.name)
    },
    ok() {
      loop = releaseSettled(loop, {})
    },
    fail(error: string, releasedBefore: string[] = []) {
      loop = releaseSettled(loop, { error, releasedBefore })
    },
    retry() {
      loop = releaseRetried(loop)
    },
    get loop() {
      return loop
    },
    sent,
  }
}

Deno.test('backfill release loop: a failed release frees its slot and halts until a person retries', () => {
  const names = ['d1', 'd2', 'd3']
  const queued = rows(names.map((n) => run(n, {}, { queued: true })))
  const h = releaseHarness(names, 1)
  assertEquals(h.render(queued), ['d1'])
  h.fail('forbidden')
  // d1 is not in flight: with "at once" 1 a ghost there would hold the only slot for good.
  assertEquals(h.loop.released.has('d1'), false)
  assertEquals(backfillProgress(names, queued, 1, false, h.loop.released).inFlight, 0)
  assertEquals(h.loop.halted, 'forbidden')
  // Halted: the same refusal is not sent again on every change of the list.
  assertEquals(h.render(queued), undefined)
  assertEquals(h.render(rows(names.map((n) => run(n, {}, { queued: true })))), undefined)
  h.retry()
  assertEquals(h.render(queued), ['d1'], 'retried, the earliest date goes first')
  h.ok()
  assertEquals(h.loop.halted, undefined)
  assertEquals(h.sent, [['d1'], ['d1']])
})

Deno.test('backfill release loop: a release that failed part way keeps the runs patched before it in flight', () => {
  const names = ['d1', 'd2', 'd3']
  const queued = rows(names.map((n) => run(n, {}, { queued: true })))
  const h = releaseHarness(names, 2)
  assertEquals(h.render(queued), ['d1', 'd2'])
  h.fail('quota', ['d1'])
  assertEquals([...h.loop.released], ['d1'])
  // The list has not caught up: d1 still reads queued, and is counted in flight all the same.
  const p = backfillProgress(names, queued, 2, false, h.loop.released)
  assertEquals([p.inFlight, p.queued], [1, 2])
  h.retry()
  assertEquals(h.render(queued), ['d2'], 'one slot is free, and d1 is not released twice')
})

Deno.test('backfill release loop: a run list that changed while a release was pending is acted on once it settles', () => {
  const names = ['d1', 'd2', 'd3']
  const h = releaseHarness(names, 1)
  assertEquals(h.render(rows(names.map((n) => run(n, {}, { queued: true })))), ['d1'])
  // d1 ends while its release is still on its way: nothing is sent over a pending release.
  const d1Done = rows([run('d1', DONE()), run('d2', {}, { queued: true }), run('d3', {}, { queued: true })])
  assertEquals(releaseStep(names, d1Done, 1, false, h.loop), [])
  assertEquals(h.render(d1Done), undefined)
  // Settled, the next render (the one the settle itself causes) releases d2 without waiting for another list.
  h.ok()
  assertEquals(h.render(d1Done), ['d2'])
  h.ok()
  // A list that has not caught up with d2's release does not release a second batch.
  assertEquals(h.render(d1Done), undefined)
  assertEquals(releaseStep(names, d1Done, 1, false, h.loop), [])
  assertEquals(h.sent, [['d1'], ['d2']])
})

Deno.test('backfill release loop: on Volcano nothing is ever sent', () => {
  const all = rows([run('d1', {}, { queued: true })])
  assertEquals(releaseStep(['d1'], all, 2, true, RELEASE_LOOP_START), [])
})
