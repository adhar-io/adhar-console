import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import {
  groupServicesByApplication,
  inServiceLinks,
  OVERDUE_AFTER_MS,
  parseEveryMs,
  parseReport,
  quartzCronWords,
  RAW_LIMIT,
  type ReportConfigMap,
  scheduleService,
  scheduleServices,
  serviceSearchText,
  triggerWords,
} from './batch-schedules-model.ts'

/**
 * The in-service schedule report (design 0025 §5.20.8, CON-Q.1): version 1 read
 * field by field, any other version kept as written, Quartz cron in words, and
 * the two judgements the page adds: when a job next fires, and whether the
 * report has fallen behind that.
 */

const SAMPLE = Deno.readTextFileSync(new URL('./testdata/batch/schedules-report-v1.json', import.meta.url))
const NOW = Date.parse('2026-11-14T09:01:00Z')

const cm = (data: string | undefined, o: { name?: string; namespace?: string; labels?: Record<string, string> } = {}): ReportConfigMap => ({
  metadata: { name: o.name ?? 'importer-batch-schedules', namespace: o.namespace ?? 'shop-prod', labels: o.labels ?? { 'adhar.io/batch-schedules': 'true', 'adhar.io/application': 'importer', 'app.kubernetes.io/managed-by': 'adhar-kit' } },
  data: data === undefined ? undefined : { 'schedules.json': data },
})

const report = (o: Record<string, unknown>) => JSON.stringify({ v: 1, engine: 'quartz', scheduler: 'importer', ...o })
const trigger = (o: Record<string, unknown>) => ({ key: 'adhar-batch-config.import-job.t', kind: 'cron', expression: '0 30 1 ? * *', state: 'NORMAL', ...o })

Deno.test('report v1: the design’s sample reads as written', () => {
  const p = parseReport(SAMPLE)
  assert(p.kind === 'v1')
  assertEquals(p.report.scheduler, 'importer')
  assertEquals(p.report.truncated, false)
  assertEquals(p.report.instances?.length, 1)
  const job = p.report.jobs[0]
  assertEquals(job.job, 'importJob')
  assertEquals(job.triggers[0].calendar, 'sg-business')
  assertEquals(job.lastRun?.executionId, 97)

  const row = scheduleService(cm(SAMPLE), { now: NOW, envByNamespace: new Map([['shop-prod', 'prod']]) })
  assertEquals(row.application, 'importer')
  assertEquals(row.environment, 'prod')
  assertEquals(row.replicas, 1)
  assertEquals(row.stale, false)
  const j = row.jobs[0]
  assertEquals(j.name, 'import-job')
  assertEquals(j.triggers[0].name, 'nightly')
  assertEquals(j.triggers[0].words, 'Every day at 01:30')
  assertEquals(j.triggers[0].timeZone, 'Asia/Singapore')
  assertEquals(j.nextFireMs, Date.parse('2026-11-16T17:30:00Z'))
  assertEquals(j.nextTimeZone, 'Asia/Singapore')
  assertEquals(j.lastRun?.label, 'Completed')
  assertEquals(j.lastRun?.durationMs, 11 * 60_000 + 12_000)
})

Deno.test('report v1: every field is optional — an empty object, wrong types and missing keys read as absent', () => {
  for (const doc of ['{}', '{"v":1}', '{"jobs":null,"instances":"x","truncated":"yes"}', '{"jobs":[null,3,{"triggers":[null,{"next":42,"state":7}],"lastRun":"x"}]}']) {
    const p = parseReport(doc)
    assert(p.kind === 'v1', doc)
    const row = scheduleService(cm(doc), { now: NOW })
    assertEquals(row.truncated, false, doc)
    assertEquals(row.stale, false, doc)
    for (const j of row.jobs) {
      assertEquals(j.nextFireMs, undefined)
      assertEquals(j.lastRun, undefined)
    }
  }
  // No `instances` is "not said", which is not "no replicas".
  assertEquals(scheduleService(cm('{}')).replicas, undefined)
  assertEquals(scheduleService(cm('{"instances":[]}')).replicas, 0)
  // The application still has a name with no label and no scheduler.
  assertEquals(scheduleService(cm('{}', { labels: {} })).application, 'importer')
  assertEquals(scheduleService(cm(report({}), { labels: {}, name: 'x-batch-schedules' })).application, 'importer')
})

Deno.test('report: an unknown version is kept raw, never parsed', () => {
  const v2 = JSON.stringify({ v: 2, jobs: [{ job: 'importJob', triggers: [trigger({ next: '2026-11-14T00:00:00Z' })] }] })
  const p = parseReport(v2)
  assertEquals(p.kind, 'unknown')
  assert(p.kind === 'unknown')
  assertEquals(p.version, '2')
  assertEquals(p.raw, v2)
  const row = scheduleService(cm(v2), { now: NOW })
  assertEquals(row.report, 'unknown')
  assertEquals(row.jobs, [], 'nothing is read out of a version this console does not know')
  assertEquals(row.stale, false)
  assertEquals(row.raw, v2)
  assertEquals((parseReport('{"v":"1"}') as { kind: string }).kind, 'unknown', 'a string "1" is not version 1')
})

Deno.test('report: invalid, missing and oversized documents are told apart', () => {
  const bad = parseReport('{"v":1,')
  assertEquals(bad.kind, 'invalid')
  assertEquals((parseReport('[1,2]') as { kind: string }).kind, 'invalid')
  assertEquals(parseReport(undefined), { kind: 'missing' })
  assertEquals(parseReport('  '), { kind: 'missing' })
  const row = scheduleService(cm('not json'))
  assertEquals(row.report, 'invalid')
  assert(row.error)
  const huge = `{"v":3,"pad":"${'x'.repeat(RAW_LIMIT * 2)}"}`
  const p = parseReport(huge)
  assert(p.kind === 'unknown')
  assertEquals(p.raw.length, RAW_LIMIT + 1)
})

Deno.test('report: a truncated report says so, and what survived still reads', () => {
  // The writer drops `lastRun` first, then triggers beyond 50 per job (§5.20.8).
  const doc = report({ truncated: true, jobs: [{ job: 'importJob', triggers: [trigger({ next: '2026-11-15T01:30:00Z' })] }, { job: 'exportJob' }] })
  const row = scheduleService(cm(doc), { now: NOW })
  assertEquals(row.truncated, true)
  assertEquals(row.jobs.length, 2)
  assertEquals(row.jobs[0].lastRun, undefined)
  assertEquals(row.jobs[0].nextFireMs, Date.parse('2026-11-15T01:30:00Z'))
  assertEquals(row.jobs[1].triggers, [])
})

Deno.test('cron in words: Quartz syntax read the way a BatchJob schedule reads', () => {
  const cases: Array<[string, string]> = [
    ['0 30 1 ? * *', 'Every day at 01:30'],
    ['0 30 1 * * ?', 'Every day at 01:30'],
    ['0 0 6 ? * MON-FRI', 'Weekdays at 06:00'],
    // Quartz numbers days from Sunday = 1: 2-6 is Monday to Friday.
    ['0 0 6 ? * 2-6', 'Weekdays at 06:00'],
    ['0 0 3 ? * 1', 'Every Sun at 03:00'],
    ['0 0 3 ? * 7', 'Every Sat at 03:00'],
    ['0 0/5 * * * ?', 'Every 5 minutes'],
    ['0 */15 * ? * *', 'Every 15 minutes'],
    ['0/5 * * * * ?', 'Every 5 seconds'],
    ['*/1 * * * * ?', 'Every second'],
    ['* * * ? * *', 'Every second'],
    ['0 0 2 1 * ?', 'Monthly on day 1 at 02:00'],
    ['0 0 2 1 * ? *', 'Monthly on day 1 at 02:00'],
  ]
  for (const [expr, want] of cases) assertEquals(quartzCronWords(expr), want, expr)
  // What has no words is shown as written, never mistranslated.
  for (const expr of ['0 0 2 L * ?', '0 0 2 ? * 6#3', '0 0 2 15W * ?', '0 0 2 * * ? 2027', '15 30 1 ? * *', '0 30 1 ? * 9', '0 0 3 ? * 8', 'nonsense', '0 30 1 * *']) {
    assertEquals(quartzCronWords(expr), expr, expr)
  }
  assertEquals(quartzCronWords(undefined), undefined)
})

Deno.test('trigger words: interval and daily triggers, from the §5.20.6 fields', () => {
  assertEquals(triggerWords({ kind: 'interval', every: '5s' }), 'Every 5 seconds')
  assertEquals(triggerWords({ kind: 'interval', every: 'PT1M' }), 'Every minute')
  assertEquals(triggerWords({ kind: 'interval', every: '300000' }), 'Every 5 minutes')
  assertEquals(triggerWords({ kind: 'interval', every: 'fortnightly' }), 'Every fortnightly')
  assertEquals(triggerWords({ kind: 'daily', every: '5m', from: '09:00', to: '17:00', days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }), 'Every 5 minutes, 09:00–17:00, on weekdays')
  assertEquals(triggerWords({ kind: 'daily', every: 'PT30M', from: '9:00:00', to: '12:00', days: ['2', '4'] }), 'Every 30 minutes, 09:00–12:00, on Mon, Wed')
  assertEquals(triggerWords({ kind: 'daily', every: '1h', days: ['SATURDAY', 'SUNDAY'] }), 'Every hour, at weekends')
  assertEquals(triggerWords({ kind: 'cron', expression: '0 30 1 ? * *' }), 'Every day at 01:30')
  assertEquals(triggerWords({}), 'Trigger')
  assertEquals(parseEveryMs('1h30m'), 90 * 60_000)
  assertEquals(parseEveryMs('P1DT2H'), 26 * 3_600_000)
  assertEquals(parseEveryMs('PT'), undefined)
  assertEquals(parseEveryMs('0'), undefined)
  // `days` may arrive as one string.
  const row = scheduleService(cm(report({ jobs: [{ job: 'j', triggers: [{ kind: 'daily', every: '5m', days: 'MON,TUE,WED,THU,FRI' }] }] })))
  assertEquals(row.jobs[0].triggers[0].words, 'Every 5 minutes, on weekdays')
})

// §5.20.8 names the interval and daily fields the kit writes (KIT-Q.7): the
// §5.20.6 property names, `every` as ISO-8601, `days` as day names.
Deno.test('report v1: interval and daily triggers read in the shape §5.20.8 names', () => {
  const row = scheduleService(cm(report({
    jobs: [{
      job: 'importJob',
      triggers: [
        trigger({ key: 'adhar-batch-config.import-job.poll', kind: 'interval', expression: undefined, every: 'PT5M', start: '2026-01-01T00:00:00Z' }),
        trigger({ key: 'adhar-batch-config.import-job.office', kind: 'daily', expression: undefined, every: 'PT30M', from: '09:00', to: '17:00', days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }),
      ],
    }],
  })))
  const [poll, office] = row.jobs[0].triggers
  assertEquals(poll.words, 'Every 5 minutes')
  assertEquals(office.words, 'Every 30 minutes, 09:00–17:00, on weekdays')
})

Deno.test('next fire: the soonest trigger that will still fire', () => {
  const doc = report({
    jobs: [{
      job: 'importJob',
      triggers: [
        trigger({ key: 'a.paused', state: 'PAUSED', next: '2026-11-14T09:05:00Z' }),
        trigger({ key: 'a.done', state: 'COMPLETE', next: '2026-11-14T09:06:00Z' }),
        trigger({ key: 'a.later', next: '2026-11-14T12:00:00Z', timeZone: 'UTC' }),
        trigger({ key: 'a.running', state: 'BLOCKED', next: '2026-11-14T10:00:00Z', timeZone: 'Asia/Singapore' }),
      ],
    }],
  })
  const j = scheduleService(cm(doc), { now: NOW }).jobs[0]
  assertEquals(j.nextFireMs, Date.parse('2026-11-14T10:00:00Z'))
  assertEquals(j.nextTimeZone, 'Asia/Singapore')
  assertEquals(j.triggers.map((t) => t.stateLabel), ['Paused', 'No more fires', undefined, 'Running'])
  // Nothing that fires: no next fire, rather than a paused trigger's.
  const paused = scheduleService(cm(report({ jobs: [{ job: 'j', triggers: [trigger({ state: 'PAUSED', next: '2026-11-14T09:05:00Z' })] }] })), { now: NOW }).jobs[0]
  assertEquals(paused.nextFireMs, undefined)
})

Deno.test('staleness: a report behind its own next fire by more than the threshold is overdue, and only then', () => {
  const at = (nextIso: string, state = 'NORMAL') => scheduleService(cm(report({ jobs: [{ job: 'j', triggers: [trigger({ next: nextIso, state })] }] })), { now: NOW })
  const due = new Date(NOW - OVERDUE_AFTER_MS - 1_000).toISOString()
  const justLate = new Date(NOW - OVERDUE_AFTER_MS + 1_000).toISOString()
  assertEquals(at(due).stale, true)
  assertEquals(at(due).jobs[0].overdue, true)
  assertEquals(at(due).jobs[0].overdueSinceMs, Date.parse(due))
  assertEquals(at(justLate).stale, false, 'late within the misfire threshold is not a misfire')
  assertEquals(at('2026-11-15T00:00:00Z').stale, false)
  assertEquals(at(due, 'PAUSED').stale, false, 'a paused trigger is not overdue')
})

Deno.test('last run: Spring Batch statuses and the kit’s outcome', () => {
  const lr = (o: Record<string, unknown>) => scheduleService(cm(report({ jobs: [{ job: 'j', lastRun: { run: 'j-aa', start: '2026-11-14T08:00:00Z', ...o } }] })), { now: NOW }).jobs[0].lastRun!
  assertEquals([lr({ status: 'COMPLETED' }).label, lr({ status: 'COMPLETED' }).tone], ['Completed', 'healthy'])
  assertEquals(lr({ status: 'COMPLETED', outcome: 'skipped(duplicate)' }).label, 'Skipped')
  assertEquals(lr({ status: 'FAILED' }).tone, 'failed')
  assertEquals(lr({ status: 'ABANDONED' }).tone, 'failed')
  assertEquals(lr({ status: 'STOPPED' }).tone, 'paused')
  const running = lr({ status: 'STARTED' })
  assertEquals([running.label, running.running, running.durationMs], ['Running', true, 61 * 60_000])
  assertEquals(lr({ status: 'WEIRD' }).label, 'WEIRD')
})

Deno.test('rows: grouped by application, one service per ConfigMap, searchable', () => {
  const env = new Map([['shop-dev', 'dev'], ['shop-prod', 'prod']])
  const rows = scheduleServices([
    cm(SAMPLE, { namespace: 'shop-prod' }),
    cm(report({ scheduler: 'billing' }), { name: 'billing-batch-schedules', namespace: 'shop-prod', labels: { 'adhar.io/application': 'billing' } }),
    cm(SAMPLE, { namespace: 'shop-dev' }),
    cm(SAMPLE, { namespace: 'shop-prod' }),
  ], { envByNamespace: env, now: NOW })
  // Application first: billing in prod still comes before importer in dev.
  assertEquals(rows.map((r) => r.key), ['shop-prod/billing-batch-schedules', 'shop-dev/importer-batch-schedules', 'shop-prod/importer-batch-schedules'])
  const groups = groupServicesByApplication(rows)
  assertEquals(groups.map((g) => [g.application, g.services.map((s) => s.environment)]), [['billing', ['prod']], ['importer', ['dev', 'prod']]])
  const text = serviceSearchText(rows[2])
  for (const want of ['importer', 'importJob', 'import-job-09932cb3', 'sg-business', 'nightly']) assert(text.includes(want), want)
})

Deno.test('links: the service’s dashboard, and its logs filtered to the run', () => {
  assertEquals(inServiceLinks('', { application: 'importer', namespace: 'shop-prod' }), undefined)
  const l = inServiceLinks('https://grafana.example/', { application: 'importer', namespace: 'shop-prod', run: 'import-job-09932cb3', job: 'importJob' })!
  assertEquals(l.dashboard, 'https://grafana.example/d/app-importer?var-env=shop-prod')
  const logs = decodeURIComponent(l.logs)
  assertStringIncludes(logs, '{namespace=\\"shop-prod\\"} |= \\"import-job-09932cb3\\"')
  assert(!logs.includes('importJob'), 'the run wins over the job name')
  const byJob = decodeURIComponent(inServiceLinks('https://grafana.example', { application: 'importer', namespace: 'shop-prod', job: 'importJob' })!.logs)
  assertStringIncludes(byJob, '|= \\"importJob\\"')
})
