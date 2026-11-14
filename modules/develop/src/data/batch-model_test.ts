import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@^1.0.0'
import {
  actionGates,
  batchRef,
  type BatchJobXR,
  buildRun,
  canonicalParams,
  COMMANDS_GVR,
  CONFIGMAPS_GVR,
  dateInZone,
  durationBars,
  exitMeaning,
  firingAlerts,
  firingAlertsQuery,
  groupByApplication,
  heldOf,
  holdPatch,
  initialParamValues,
  isBatchApplication,
  jobRows,
  jobStatusOf,
  maskParam,
  JOBS_GVR,
  nextRestartName,
  nextRunOf,
  nextScheduleIndex,
  nextScheduleQuery,
  observabilityLinks,
  outcomeLabel,
  pageStateOf,
  type ParamField,
  paramFormOf,
  paramsHash,
  parseBatchRef,
  parseDurationMs,
  parseRunTemplate,
  parseSummary,
  pendingApplications,
  resolveParams,
  restartName,
  restartPlan,
  restartWarning,
  resumeRequest,
  runActionsOf,
  runEvents,
  runKindOfJob,
  runMetricQueries,
  runName,
  type RunKind,
  type RunObject,
  runParams,
  runPhaseOf,
  type RunPod,
  runRow,
  runRows,
  type RunTemplate,
  scheduleOf,
  sensitiveParams,
  slaStateOf,
  speakerPod,
  stopRequest,
  summaryOf,
  volcanoCommand,
  VOLCANO_JOBS_GVR,
} from './batch-model.ts'
import { compareCodePoints, hasLoneSurrogate, sha256Hex } from './batch-naming.ts'

const TESTDATA = new URL('./testdata/batch/', import.meta.url)
const text = (name: string) => Deno.readTextFile(new URL(name, TESTDATA))
const json = async <T>(name: string) => JSON.parse(await text(name)) as T

/* ─────────────────────────── naming v1: the shared vectors (D1, §8.3) ─────────────────────────── */

interface Vector {
  id: string
  params: Record<string, string>
  canonical: string
  canonicalUtf8Hex: string
  hash8: string
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

Deno.test('naming v1: every shared vector matches byte for byte', async () => {
  const { vectors } = await json<{ vectors: Vector[] }>('naming-v1-vectors.json')
  // The seven of §8.3: a vector dropped from the file must not pass silently.
  assertEquals(vectors.map((v) => v.id), ['v1-empty', 'v1-business-date', 'v1-key-order', 'v1-codepoint-order', 'v1-escapes', 'v1-unicode', 'v1-empty-value'])
  for (const v of vectors) {
    assertEquals(canonicalParams(v.params), v.canonical, v.id)
    assertEquals(hex(new TextEncoder().encode(canonicalParams(v.params))), v.canonicalUtf8Hex, v.id)
    assertEquals(paramsHash(v.params), v.hash8, v.id)
    assertEquals(runName('importer', v.params), `importer-${v.hash8}`, v.id)
  }
})

Deno.test('naming v1: the design worked example', () => {
  assertEquals(runName('importer', { businessDate: '2026-11-03' }), 'importer-09932cb3')
  assertEquals(restartName('importer-09932cb3', 1), 'importer-09932cb3-r1')
})

Deno.test('naming v1: nothing beyond the minimal escapes is escaped', () => {
  const c = canonicalParams({ a: '/<>&\u007fé' })
  assertEquals(c, '{"a":"/<>&\u007fé"}')
  assertEquals(canonicalParams({ a: '\u0001\u001f\b\f\n\r\t"\\' }), '{"a":"\\u0001\\u001f\\b\\f\\n\\r\\t\\"\\\\"}')
})

Deno.test('naming v1: keys sort by code point, not by UTF-16 code unit', () => {
  // U+1F680 is above U+FFFD by code point but below it by code unit.
  assertEquals(compareCodePoints('�', '🚀') < 0, true)
  assertEquals(canonicalParams({ '🚀': '1', '�': '2' }), '{"�":"2","🚀":"1"}')
})

Deno.test('naming v1: an integer-like key keeps its sorted place', () => {
  // A plain object would hand `2` back before `10`; code-point order says 10 first.
  assertEquals(canonicalParams({ 2: 'a', 10: 'b' }), '{"10":"b","2":"a"}')
})

Deno.test('naming v1: a lone surrogate is refused, never hashed', () => {
  assert(hasLoneSurrogate('a\ud800'))
  assert(hasLoneSurrogate('\udc00a'))
  assert(!hasLoneSurrogate('🚀'))
  assertThrows(() => runName('importer', { a: 'x\ud800' }), Error, 'lone surrogate')
})

Deno.test('naming v1: SHA-256 agrees with WebCrypto across block boundaries', async () => {
  for (let n = 0; n < 200; n++) {
    const data = new Uint8Array(n).map((_, i) => (i * 7 + n) & 0xff)
    const want = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
    assertEquals(sha256Hex(data), want, `length ${n}`)
  }
})

Deno.test('naming v1: restarts count up from what exists and stop at 99', () => {
  assertEquals(nextRestartName('job-aa', []), 'job-aa-r1')
  assertEquals(nextRestartName('job-aa', ['job-aa', 'job-aa-r1']), 'job-aa-r2')
  // A hole left by a TTL is not refilled; another identity's restarts do not count.
  assertEquals(nextRestartName('job-aa', ['job-aa-r3', 'job-bb-r9', 'job-aa-rx']), 'job-aa-r4')
  assertEquals(nextRestartName('job-aa', ['job-aa-r99']), undefined)
  assertThrows(() => restartName('job-aa', 100))
  assertThrows(() => restartName('job-aa', 0))
})

/* ─────────────────────────── summary v1 (§5.13, D13) ─────────────────────────── */

Deno.test('summary: the fixtures parse, each to its outcome', async () => {
  const completed = parseSummary(await text('summary-v1/completed.json'))!
  assertEquals(completed.outcome, 'completed')
  assertEquals(completed.exitCode, 0)
  assertEquals(completed.read, 120000)
  assertEquals(completed.executionId, 97)
  assertEquals(completed.steps?.[0].name, 'importStep')
  assertEquals(completed.truncated, false)

  const failed = parseSummary(await text('summary-v1/failed-retryable.json'))!
  assertEquals(failed.exitCode, 5)
  assertEquals(failed.outcome, 'failed')

  const skipped = parseSummary(await text('summary-v1/skipped-duplicate.json'))!
  assertEquals(skipped.reason, 'duplicate')
  assertEquals(outcomeLabel(skipped), 'Skipped: another run of this identity is in progress')

  const invalid = parseSummary(await text('summary-v1/invalid-parameters.json'))!
  assertEquals(invalid.exitCode, 2)
  assertEquals(invalid.reason, 'parameters')
  // No execution exists, so the ids are absent rather than zero.
  assertEquals(invalid.instanceId, undefined)
  assertEquals(invalid.executionId, undefined)
})

Deno.test('summary: a document cut part way yields what it can and says so', async () => {
  const cut = parseSummary(await text('summary-v1/truncated.txt'))!
  assertEquals(cut.truncated, true)
  assertEquals(cut.job, 'importJob')
  assertEquals(cut.executionId, 97)
  assertEquals(cut.outcome, 'completed')
  assertEquals(cut.exitCode, 0)
  // The value cut mid-string is absent, not a broken string.
  assertEquals(cut.businessDate, undefined)
})

Deno.test('summary: cut inside steps, a step count is never read as a total', () => {
  const s = parseSummary('{"v":1,"read":5,"written":4,"steps":[{"name":"a","status":"COMPLETED","read":999,"written":888,"skipped":0},{"name":"b","read":7')!
  assertEquals(s.truncated, true)
  assertEquals(s.read, 5)
  assertEquals(s.written, 4)
  assertEquals(s.steps, [{ name: 'a', status: 'COMPLETED', read: 999, written: 888, skipped: 0 }])
})

Deno.test('summary: every field is optional and unknown fields are ignored', () => {
  assertEquals(parseSummary('{"v":1,"future":{"x":1}}'), { truncated: false, v: 1 })
  assertEquals(parseSummary('{"v":1,"stepsTruncated":true}')?.stepsTruncated, true)
  // Wrong types are dropped, not trusted.
  assertEquals(parseSummary('{"v":1,"read":"many","exitCode":"0"}'), { truncated: false, v: 1 })
})

Deno.test('summary: text that is not a summary is null, never a guess', () => {
  for (const t of [undefined, '', '   ', 'Error: main class not found', '[1,2]', '{"foo":"bar"}', '{"foo":"ba']) {
    assertEquals(parseSummary(t), null, String(t))
  }
})

const pod = (name: string, opts: Partial<{ created: string; role: string; index: string; job: string; ns: string; message: string; exitCode: number; running: boolean; last: boolean }> = {}): RunPod => {
  const term = { exitCode: opts.exitCode ?? 0, message: opts.message }
  return {
    metadata: {
      name,
      namespace: opts.ns ?? 'prod',
      creationTimestamp: opts.created ?? '2026-11-03T17:30:00Z',
      labels: {
        'batch.kubernetes.io/job-name': opts.job ?? 'importer-aa',
        ...(opts.role ? { 'adhar.io/batch-role': opts.role } : {}),
        ...(opts.index !== undefined ? { 'batch.kubernetes.io/job-completion-index': opts.index } : {}),
      },
    },
    status: {
      phase: opts.running ? 'Running' : 'Failed',
      containerStatuses: [{
        name: 'batch',
        state: opts.running ? { running: {} } : opts.last ? {} : { terminated: term },
        ...(opts.last ? { lastState: { terminated: term } } : {}),
      }],
    },
  }
}

Deno.test('summary: read from the batch container, current state or last', () => {
  assertEquals(summaryOf(pod('p', { message: '{"v":1,"outcome":"failed"}' }))?.outcome, 'failed')
  assertEquals(summaryOf(pod('p', { message: '{"v":1,"outcome":"failed"}', last: true }))?.outcome, 'failed')
  assertEquals(summaryOf(pod('p', { running: true })), null)
  // A sidecar's message is not the run's.
  assertEquals(summaryOf({
    metadata: { name: 'p' },
    status: { containerStatuses: [{ name: 'side', state: { terminated: { message: '{"v":1}' } } }, { name: 'batch', state: { running: {} } }] },
  }), null)
})

Deno.test('speaker: the manager speaks for the run, then the newest attempt', () => {
  const worker = pod('w', { role: 'worker', index: '1', created: '2026-11-03T18:00:00Z', message: '{"v":1,"outcome":"failed"}' })
  const manager = pod('m', { role: 'manager', index: '0', created: '2026-11-03T17:00:00Z', message: '{"v":1,"outcome":"completed"}' })
  assertEquals(speakerPod([worker, manager])?.metadata.name, 'm')
  const newer = pod('b', { created: '2026-11-03T18:00:00Z', message: '{"v":1,"outcome":"completed"}' })
  const older = pod('a', { created: '2026-11-03T17:00:00Z', message: '{"v":1,"outcome":"failed"}' })
  assertEquals(speakerPod([newer, older])?.metadata.name, 'b')
  // A newer attempt still running has no summary yet; the last one that wrote speaks.
  assertEquals(speakerPod([pod('c', { running: true }), older])?.metadata.name, 'a')
  assertEquals(speakerPod([]), undefined)
})

/* ─────────────────────────── exit codes (§5.7) ─────────────────────────── */

Deno.test('exit codes: every code of the contract has a meaning', () => {
  for (const c of [0, 1, 2, 3, 4, 5, 6, 7, 137, 143]) assert(!exitMeaning(c)!.startsWith('Exit '), `code ${c}`)
  assertEquals(exitMeaning(42), 'Exit 42')
  assertEquals(exitMeaning(undefined), undefined)
})

/* ─────────────────────────── phases ─────────────────────────── */

const run = (over: Partial<RunObject> & { status?: RunObject['status']; spec?: RunObject['spec'] } = {}, name = 'importer-aa'): RunObject => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  ...over,
  metadata: {
    name,
    namespace: 'prod',
    uid: 'uid-1',
    creationTimestamp: '2026-11-03T17:30:00Z',
    labels: { 'adhar.io/batch-job': 'importer', 'adhar.io/application': 'importer', 'adhar.io/environment': 'prod' },
    ...(over.metadata ?? {}),
  },
})

const cond = (type: string, status = 'True', at?: string, message?: string) => ({ type, status, lastTransitionTime: at, message })

Deno.test('phase: native Jobs', () => {
  const p = (status: RunObject['status'], spec?: RunObject['spec']) => runPhaseOf(run({ status, spec }))
  assertEquals(p({}), 'pending')
  assertEquals(p({ active: 1, ready: 1 }), 'running')
  assertEquals(p({ active: 1, ready: 0 }), 'pending')
  assertEquals(p({ conditions: [cond('Complete')] }), 'succeeded')
  assertEquals(p({ conditions: [cond('SuccessCriteriaMet')], active: 1 }), 'succeeded')
  assertEquals(p({ conditions: [cond('Failed')] }), 'failed')
  // Decided: its pods are only leaving.
  assertEquals(p({ conditions: [cond('FailureTarget')], active: 1 }), 'failed')
  assertEquals(p({ conditions: [cond('Complete', 'False')], active: 1, ready: 1 }), 'running')
  assertEquals(p({ active: 1, ready: 1 }, { suspend: true }), 'stopping')
  assertEquals(p({ terminating: 1 }, { suspend: true }), 'stopping')
  assertEquals(p({ conditions: [cond('Suspended')] }, { suspend: true }), 'stopped')
  assertEquals(runPhaseOf(run({ metadata: { name: 'x', deletionTimestamp: '2026-11-03T17:30:00Z' } })), 'deleting')
})

Deno.test('phase: Volcano Jobs', () => {
  const v = (phase?: string) => runPhaseOf(run({ apiVersion: 'batch.volcano.sh/v1alpha1', status: phase ? { state: { phase } } : {} }))
  assertEquals(v(), 'pending')
  assertEquals(v('Pending'), 'pending')
  for (const s of ['Running', 'Restarting', 'Completing']) assertEquals(v(s), 'running', s)
  assertEquals(v('Aborting'), 'stopping')
  assertEquals(v('Aborted'), 'stopped')
  assertEquals(v('Completed'), 'succeeded')
  for (const s of ['Failed', 'Terminating', 'Terminated']) assertEquals(v(s), 'failed', s)
  assertEquals(v('SomethingNew'), 'unknown')
})

Deno.test('actions: stop what runs, resume what stopped, restart what failed', () => {
  assertEquals(runActionsOf('running'), { stop: true, resume: false, restart: false })
  assertEquals(runActionsOf('pending'), { stop: true, resume: false, restart: false })
  assertEquals(runActionsOf('stopping'), { stop: false, resume: false, restart: false })
  assertEquals(runActionsOf('stopped'), { stop: false, resume: true, restart: false })
  assertEquals(runActionsOf('failed'), { stop: false, resume: false, restart: true })
  assertEquals(runActionsOf('succeeded'), { stop: false, resume: false, restart: false })
})

/* ─────────────────────────── a run's row ─────────────────────────── */

Deno.test('row: a scheduled run reads its trigger and business date from the schedule, in the job zone', () => {
  const r = runRow(run({
    metadata: {
      name: 'importer-29374530',
      annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': '2026-11-03T17:30:00Z', 'adhar.io/batch-actor': 'system:serviceaccount:kube-system:cronjob-controller' },
      labels: { 'adhar.io/batch-job': 'importer', 'adhar.io/batch-trigger': 'schedule' },
      ownerReferences: [{ kind: 'CronJob', name: 'importer' }],
    },
    spec: { template: { spec: { containers: [{ name: 'batch', env: [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }, { name: 'ADHAR_BATCH_TIME_ZONE', value: 'Asia/Singapore' }] }] } } },
    status: { active: 1, ready: 1, startTime: '2026-11-03T17:30:05Z' },
  }), [], Date.parse('2026-11-03T17:31:05Z'))
  assertEquals(r.trigger, 'schedule')
  // 17:30 UTC on the 3rd is 01:30 on the 4th in Singapore.
  assertEquals(r.businessDate, '2026-11-04')
  assertEquals(r.durationMs, 60_000)
  assertEquals(r.actor, 'system:serviceaccount:kube-system:cronjob-controller')
})

Deno.test('row: the summary supplies exit code, outcome and business date over anything inferred', async () => {
  const summary = await text('summary-v1/failed-retryable.json')
  const r = runRow(
    run({ status: { failed: 3, startTime: '2026-11-03T17:30:00Z', conditions: [cond('Failed', 'True', '2026-11-03T17:35:00Z', 'Job has reached the specified backoff limit')] } }),
    [pod('importer-aa-x', { message: summary, exitCode: 5 })],
  )
  assertEquals(r.phase, 'failed')
  assertEquals(r.exitCode, 5)
  assertEquals(r.summary?.outcome, 'failed')
  assertEquals(r.businessDate, '2026-11-03')
  assertEquals(r.attempts, 3)
  // A failed Job has no completionTime; the condition says when it ended.
  assertEquals(r.finishedAt, '2026-11-03T17:35:00Z')
  assertEquals(r.durationMs, 300_000)
  assertEquals(r.message, 'Job has reached the specified backoff limit')
})

Deno.test('row: without a summary the exit code still comes from the container', () => {
  const r = runRow(run({ status: { failed: 1, conditions: [cond('Failed')] } }), [pod('importer-aa-x', { exitCode: 137 })])
  assertEquals(r.exitCode, 137)
  assertEquals(r.summary, null)
})

Deno.test('row: a pod of another run or namespace is not this run', () => {
  const r = runRow(run(), [pod('other', { job: 'importer-bb', message: '{"v":1}' }), pod('elsewhere', { ns: 'dev', message: '{"v":1}' })])
  assertEquals(r.summary, null)
  assertEquals(r.attempts, 0)
})

Deno.test('row: every field is optional', () => {
  const r = runRow({ metadata: { name: 'bare' } }, [])
  assertEquals(r.phase, 'pending')
  assertEquals(r.batchJob, undefined)
  assertEquals(r.durationMs, undefined)
  assertEquals(runParams({}), {})
  assertEquals(runParams({ spec: { template: { spec: { containers: [{ name: 'batch', env: [{ name: 'ADHAR_BATCH_PARAMS', value: 'not json' }] }] } } } }), {})
})

Deno.test('rows: newest first', () => {
  const rows = runRows([
    run({ metadata: { name: 'a', creationTimestamp: '2026-11-01T00:00:00Z' } }),
    run({ metadata: { name: 'b', creationTimestamp: '2026-11-03T00:00:00Z' } }),
  ], [])
  assertEquals(rows.map((r) => r.name), ['b', 'a'])
})

/* ─────────────────────────── the parameter form ─────────────────────────── */

const F = (o: Partial<ParamField> & { name: string }): ParamField => ({ type: 'string', identifying: true, required: false, source: 'input', sensitive: false, ...o })

Deno.test('form: the rendered parameters.json becomes fields', async () => {
  const cm = await json<{ data: Record<string, string> }>('run-template-importer.configmap.json')
  const { fields, error } = paramFormOf(cm.data['parameters.json'])
  assertEquals(error, undefined)
  assertEquals(fields.map((f) => f.name), ['businessDate', 'source', 'dryRun'])
  assertEquals(fields[0].source, 'schedule')
  assertEquals(fields[1].default, 'inbound/records.csv')
  assertEquals(fields[2].identifying, false)
})

Deno.test('form: tolerates absence, refuses garbage in words', () => {
  assertEquals(paramFormOf(undefined), { fields: [] })
  assertEquals(paramFormOf(''), { fields: [] })
  assertStringIncludes(paramFormOf('{nope').error!, 'cannot be read')
  assertStringIncludes(paramFormOf('{"a":1}').error!, 'not a list')
  // XRD defaults apply to anything the document leaves out.
  assertEquals(paramFormOf('[{"name":"a"},{"noName":true}]').fields, [{ name: 'a', type: 'string', identifying: true, required: false, source: 'input', sensitive: false }])
})

Deno.test('form: sensitive in the BatchJob or its run template is masked; unknown masks every value', () => {
  const job: BatchJobXR = { metadata: { name: 'importer', namespace: 'prod' }, spec: { parameters: { parameters: [{ name: 'token', sensitive: true }, { name: 'day' }] } } }
  const template = { fields: [F({ name: 'day' }), F({ name: 'key', sensitive: true })] }
  assertEquals([...sensitiveParams(job, undefined)!], ['token'])
  assertEquals([...sensitiveParams(undefined, template)!], ['key'])
  assertEquals([...sensitiveParams(job, template)!].sort(), ['key', 'token'])
  assertEquals(sensitiveParams(undefined, { ...template, paramsError: 'cannot be read' }), undefined)
  assertEquals(sensitiveParams(undefined, undefined), undefined)
  // A job that declares no parameters has none sensitive: known, not unknown.
  assertEquals(sensitiveParams({ metadata: { name: 'x', namespace: 'p' } }, undefined)?.size, 0)
  const known = sensitiveParams(job, template)
  assertEquals([maskParam(known, 'token', 's'), maskParam(known, 'day', '2026-11-03')], ['••••••', '2026-11-03'])
  assertEquals(maskParam(undefined, 'day', '2026-11-03'), '••••••')
})

Deno.test('form: defaults apply before hashing, so a typed default is the same run', () => {
  const fields = [F({ name: 'businessDate', type: 'date', source: 'schedule' }), F({ name: 'source', default: 'inbound/records.csv' })]
  const typed = resolveParams(fields, { businessDate: '2026-11-03', source: 'inbound/records.csv' })
  const left = resolveParams(fields, { businessDate: '2026-11-03', source: '' })
  assertEquals(runName('importer', typed.identifying), runName('importer', left.identifying))
  assertEquals(left.errors, {})
})

Deno.test('form: an optional parameter with no value is absent, not empty', () => {
  const r = resolveParams([F({ name: 'a' }), F({ name: 'b', default: '' })], { a: '' })
  assertEquals(r.errors, {})
  assertEquals(r.params, { b: '' })
  // The v1-empty-value vector: a present "" changes the name.
  assertNotEquals(runName('j', { b: '' }), runName('j', {}))
})

Deno.test('form: only identifying parameters reach the name', () => {
  const fields = [F({ name: 'date', type: 'date' }), F({ name: 'dryRun', type: 'boolean', identifying: false })]
  const a = resolveParams(fields, { date: '2026-11-03', dryRun: 'true' })
  const b = resolveParams(fields, { date: '2026-11-03', dryRun: 'false' })
  assertEquals(a.identifying, b.identifying)
  assertNotEquals(a.params, b.params)
})

Deno.test('form: every declared rule refuses what it should', () => {
  const bad = (f: ParamField, v: string) => resolveParams([f], { [f.name]: v }).errors[f.name]
  assert(bad(F({ name: 'a', required: true }), ''))
  assert(bad(F({ name: 'a', type: 'long' }), '1.5'))
  assert(bad(F({ name: 'a', type: 'double' }), 'x'))
  assert(bad(F({ name: 'a', type: 'boolean' }), 'yes'))
  assert(bad(F({ name: 'a', type: 'date' }), '2026-02-30'))
  assert(bad(F({ name: 'a', type: 'date' }), '03/11/2026'))
  assert(bad(F({ name: 'a', type: 'datetime' }), '2026-11-03T17:30:00'))
  assert(bad(F({ name: 'a', allowed: ['sg', 'my'] }), 'xx'))
  assert(bad(F({ name: 'a', pattern: '[a-z]+' }), 'abc1'), 'a pattern matches the whole value')
  assert(bad(F({ name: 'a' }), 'x\ud800'))
  // A parameter the schedule normally supplies must be given by hand.
  assert(bad(F({ name: 'a', type: 'date', source: 'schedule' }), ''))

  const ok = (f: ParamField, v: string) => assertEquals(bad(f, v), undefined, `${f.type} ${v}`)
  ok(F({ name: 'a', type: 'long' }), '-42')
  ok(F({ name: 'a', type: 'double' }), '1.5e3')
  ok(F({ name: 'a', type: 'boolean' }), 'false')
  ok(F({ name: 'a', type: 'date' }), '2024-02-29')
  ok(F({ name: 'a', type: 'datetime' }), '2026-11-03T17:30:00+08:00')
  ok(F({ name: 'a', allowed: ['sg'] }), 'sg')
  ok(F({ name: 'a', pattern: '[a-z]+' }), 'abc')
  // A pattern JavaScript cannot compile (a Java possessive) is left to the runner.
  ok(F({ name: 'a', pattern: 'a++(' }), 'whatever')
})

Deno.test('form: the secret-name guard says what the runner would (§5.6)', () => {
  for (const name of ['password', 'dbPassword', 'apiKey', 'api_key', 'SECRET', 'authToken', 'privateKey', 'credential']) {
    assertStringIncludes(resolveParams([F({ name })], { [name]: 'x' }).errors[name], 'refuses')
  }
  assertEquals(resolveParams([F({ name: 'region' })], { region: 'sg' }).errors, {})
})

Deno.test('form: a date the schedule would supply starts at today, in the job zone', () => {
  const fields = [F({ name: 'businessDate', type: 'date', source: 'schedule' }), F({ name: 'source', default: 'x' }), F({ name: 'free' })]
  const now = Date.parse('2026-11-03T17:30:00Z')
  assertEquals(initialParamValues(fields, { timeZone: 'Asia/Singapore', now }), { businessDate: '2026-11-04', source: 'x', free: '' })
  assertEquals(initialParamValues(fields, { timeZone: 'America/New_York', now }).businessDate, '2026-11-03')
  assertEquals(dateInZone(now, 'Not/AZone'), undefined)
})

/* ─────────────────────────── the run template and what a client may change (§6.5) ─────────────────────────── */

const templateOf = async () => {
  const cm = await json<{ data: Record<string, string> }>('run-template-importer.configmap.json')
  const { template, error } = parseRunTemplate(cm)
  assertEquals(error, undefined)
  return template as RunTemplate
}

Deno.test('template: reads what the composition actually renders', async () => {
  const t = await templateOf()
  assertEquals(t.kind, 'Job')
  assertEquals(t.naming, 'v1')
  assertEquals(t.manifest.apiVersion, 'batch/v1')
  assertEquals(t.manifest.metadata.labels?.['adhar.io/batch-trigger'], 'manual')
  assertEquals(t.fields.length, 3)
  const c = t.manifest.spec?.template?.spec?.containers?.[0]
  assertEquals(c?.name, 'batch')
  assertEquals(c?.env?.find((e) => e.name === 'ADHAR_BATCH_PARAMS')?.value, '{}')
  // Strings stay strings: Kyverno compares these with the template.
  assertEquals(t.manifest.metadata.annotations?.['adhar.io/batch-actor'], '')
})

Deno.test('template: the block YAML of the composition reads exactly as its JSON does', async () => {
  // Generated by sigs.k8s.io/yaml from the JSON beside it, with the awkward
  // values a job's env can hold: colons, hashes, booleans and octals as strings.
  const fromYaml = parseRunTemplate({ data: { 'template.yaml': await text('run-template-edge.yaml') } }).template?.manifest
  const fromJson = parseRunTemplate({ data: { 'template.yaml': await text('run-template-edge.json') } }).template?.manifest
  assert(fromJson)
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v
  assertEquals(sort(fromYaml), sort(fromJson))
})

Deno.test('template: refuses what it cannot honestly start from', () => {
  assertStringIncludes(parseRunTemplate(null).error!, 'no template.yaml')
  assertStringIncludes(parseRunTemplate({ data: { 'template.yaml': 'kind: Job\napiVersion: batch/v1\nmetadata: {}\n', naming: 'v2' } }).error!, 'naming v1')
  assertStringIncludes(parseRunTemplate({ data: { 'template.yaml': 'kind: Pod\napiVersion: v1\n' } }).error!, 'not a Job')
  assertStringIncludes(parseRunTemplate({ data: { 'template.yaml': 'kind: Job\napiVersion: batch/v1\nspec: {}\n' } }).error!, 'no containers')
  assertStringIncludes(parseRunTemplate({ data: { 'template.yaml': '{"kind":"Job","apiVersion":"batch/v1","spec":{"template":{"spec":{"containers":[{"name":"batch"}]}}},"metadata":{}}', 'parameters.json': '{bad' } }).template!.paramsError!, 'cannot be read')
})

/** Every path at which two JSON values differ. */
function diffPaths(a: unknown, b: unknown, at = ''): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const key = (a[i] as { name?: string } | undefined)?.name ?? (b[i] as { name?: string } | undefined)?.name ?? String(i)
      out.push(...diffPaths(a[i], b[i], `${at}[${key}]`))
    }
    return out
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k))
  }
  return Object.is(a, b) ? [] : [at]
}

const CONTAINER = 'spec.template.spec.containers[batch].env'

Deno.test('INV: a manual run differs from its template ONLY where §6.5 allows', async () => {
  const t = await templateOf()
  const params = { businessDate: '2026-11-03', source: 'inbound/records.csv', dryRun: 'false' }
  const built = buildRun(t, { name: 'importer-09932cb3', namespace: 'prod', trigger: 'manual', params })
  assertEquals(diffPaths(t.manifest, built).sort(), [
    `${CONTAINER}[ADHAR_BATCH_PARAMS].value`,
    'metadata.name',
  ].sort())
  assertEquals(JSON.parse(built.spec!.template!.spec!.containers![0].env!.find((e) => e.name === 'ADHAR_BATCH_PARAMS')!.value!), params)
})

Deno.test('INV: a restart differs from its template ONLY where §6.5 allows', async () => {
  const t = await templateOf()
  const built = buildRun(t, { name: 'importer-09932cb3-r1', namespace: 'prod', trigger: 'restart', params: { businessDate: '2026-11-03' }, restartOf: 'importer-09932cb3' })
  assertEquals(diffPaths(t.manifest, built).sort(), [
    `${CONTAINER}[ADHAR_BATCH_PARAMS].value`,
    `${CONTAINER}[ADHAR_BATCH_RESTART_OF]`,
    `${CONTAINER}[ADHAR_BATCH_TRIGGER].value`,
    'metadata.labels.adhar.io/batch-trigger',
    'metadata.name',
    'spec.template.metadata.labels.adhar.io/batch-trigger',
  ].sort())
  const env = built.spec!.template!.spec!.containers![0].env!
  assertEquals(env.find((e) => e.name === 'ADHAR_BATCH_RESTART_OF')?.value, 'importer-09932cb3')
  assertEquals(env.find((e) => e.name === 'ADHAR_BATCH_TRIGGER')?.value, 'restart')
})

Deno.test('INV: building a run never touches the template it came from', async () => {
  const t = await templateOf()
  const before = JSON.stringify(t.manifest)
  buildRun(t, { name: 'x', namespace: 'prod', trigger: 'restart', params: { a: 'b' }, restartOf: 'y' })
  assertEquals(JSON.stringify(t.manifest), before)
})

Deno.test('buildRun: a sidecar with no batch contract stays as it was; every Volcano task gets it', () => {
  const t: RunTemplate = {
    kind: 'VolcanoJob',
    naming: 'v1',
    fields: [],
    manifest: {
      apiVersion: 'batch.volcano.sh/v1alpha1',
      kind: 'Job',
      metadata: { name: '' },
      spec: {
        tasks: ['manager', 'worker'].map((name) => ({
          name,
          template: { metadata: { labels: { 'adhar.io/batch-trigger': 'manual' } }, spec: { containers: [{ name: 'batch', env: [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }] }, { name: 'side', env: [{ name: 'X', value: '1' }] }] } },
        })),
      },
    },
  }
  const built = buildRun(t, { name: 'j-aa-r1', namespace: 'prod', trigger: 'restart', params: { a: 'b' }, restartOf: 'j-aa' })
  for (const task of built.spec!.tasks!) {
    const [batch, side] = task.template!.spec!.containers!
    assertEquals(batch.env!.find((e) => e.name === 'ADHAR_BATCH_PARAMS')?.value, '{"a":"b"}')
    assertEquals(side.env, [{ name: 'X', value: '1' }])
    assertEquals(task.template!.metadata!.labels!['adhar.io/batch-trigger'], 'restart')
  }
})

/* ─────────────────────────── restart (§3.4) ─────────────────────────── */

const failedRun = (over: Partial<RunObject['metadata']> = {}, env: Array<{ name: string; value: string }> = [{ name: 'ADHAR_BATCH_PARAMS', value: '{"businessDate":"2026-11-03","source":"inbound/records.csv"}' }], image = 'img:1') =>
  run({
    metadata: { name: 'importer-09932cb3', labels: { 'adhar.io/batch-job': 'importer' }, ...over } as RunObject['metadata'],
    spec: { template: { spec: { containers: [{ name: 'batch', image, env }] } } },
    status: { conditions: [cond('Failed')], failed: 1 },
  })

const tplFor = (image: string): RunTemplate => ({
  kind: 'Job',
  naming: 'v1',
  fields: [F({ name: 'businessDate', type: 'date', source: 'schedule' }), F({ name: 'source', default: 'inbound/records.csv' }), F({ name: 'dryRun', type: 'boolean', identifying: false, default: 'false' })],
  manifest: { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: '' }, spec: { template: { spec: { containers: [{ name: 'batch', image, env: [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }] }] } } } },
})

Deno.test('restart: the same identity as the run it continues', () => {
  const row = runRow(failedRun(), [])
  const plan = restartPlan('importer', row, tplFor('img:1'), ['importer-09932cb3'])
  const base = runName('importer', { businessDate: '2026-11-03', source: 'inbound/records.csv' })
  assertEquals(plan.base, base)
  assertEquals(plan.name, `${base}-r1`)
  assertEquals(plan.identifying, { businessDate: '2026-11-03', source: 'inbound/records.csv' })
  assertEquals(plan.imageChange, undefined)
})

Deno.test('restart: a restart of a restart takes the next number', () => {
  const base = runName('importer', { businessDate: '2026-11-03', source: 'inbound/records.csv' })
  const row = runRow(failedRun({ name: `${base}-r1` }), [])
  assertEquals(restartPlan('importer', row, tplFor('img:1'), [base, `${base}-r1`]).name, `${base}-r2`)
})

Deno.test('restart: a scheduled run states the business date the schedule gave it', () => {
  // Its params are {}, so without this it would start a new instance and re-process the date from the top.
  const row = runRow(
    failedRun({ name: 'importer-29374530', annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': '2026-11-03T17:30:00Z' } }, [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }, { name: 'ADHAR_BATCH_TIME_ZONE', value: 'Asia/Singapore' }]),
    [pod('p', { job: 'importer-29374530', message: '{"v":1,"businessDate":"2026-11-04"}' })],
  )
  const plan = restartPlan('importer', row, tplFor('img:1'), [])
  assertEquals(plan.identifying, { businessDate: '2026-11-04', source: 'inbound/records.csv' })
  // The same name the kit and the CLI compute for that date.
  assertEquals(plan.base, runName('importer', { businessDate: '2026-11-04', source: 'inbound/records.csv' }))
})

Deno.test('restart: no summary, the scheduled timestamp in the job zone decides', () => {
  const row = runRow(
    failedRun({ name: 'importer-29374530', annotations: { 'batch.kubernetes.io/cronjob-scheduled-timestamp': '2026-11-03T17:30:00Z' } }, [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }, { name: 'ADHAR_BATCH_TIME_ZONE', value: 'Asia/Singapore' }]),
    [],
  )
  assertEquals(restartPlan('importer', row, tplFor('img:1'), []).identifying?.businessDate, '2026-11-04')
})

Deno.test('restart: says when the template moved on, refuses what it cannot reuse', () => {
  const row = runRow(failedRun(), [])
  assertEquals(restartPlan('importer', row, tplFor('img:2'), []).imageChange, { from: 'img:1', to: 'img:2' })
  // A run with no date and nothing to derive one from.
  const undated = runRow(failedRun({}, [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }]), [])
  assertStringIncludes(restartPlan('importer', undated, tplFor('img:1'), []).error!, 'businessDate')
  // Used up.
  const base = runName('importer', { businessDate: '2026-11-03', source: 'inbound/records.csv' })
  assertStringIncludes(restartPlan('importer', row, tplFor('img:1'), [`${base}-r99`]).error!, '99')
})

Deno.test('restart: warned about when the same identity will only fail again', () => {
  assertStringIncludes(restartWarning(2)!, 'exit 2')
  assertStringIncludes(restartWarning(6)!, 'exit 6')
  assertEquals(restartWarning(5), undefined)
  assertEquals(restartWarning(undefined), undefined)
})

/* ─────────────────────────── writes and their gates (§7.4) ─────────────────────────── */

Deno.test('stop and resume: native Jobs are suspended, in the Job itself', () => {
  assertEquals(stopRequest(run()), { verb: 'patch', gvr: JOBS_GVR, namespace: 'prod', name: 'importer-aa', body: { spec: { suspend: true } } })
  assertEquals(resumeRequest(run()), { verb: 'patch', gvr: JOBS_GVR, namespace: 'prod', name: 'importer-aa', body: { spec: { suspend: false } } })
})

Deno.test('stop and resume: Volcano Jobs get the Command vcctl would create', () => {
  const v = run({ apiVersion: 'batch.volcano.sh/v1alpha1' })
  const stop = stopRequest(v)
  assertEquals(stop.verb, 'create')
  assertEquals(stop.gvr, COMMANDS_GVR)
  assertEquals(volcanoCommand(v, 'AbortJob'), (stop as { body: unknown }).body)
  const c = volcanoCommand(v, 'ResumeJob') as { action: string; target: Record<string, unknown>; metadata: { generateName: string; namespace: string; ownerReferences: unknown[] } }
  assertEquals(c.action, 'ResumeJob')
  assertEquals(c.target, { apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', name: 'importer-aa', uid: 'uid-1', controller: true, blockOwnerDeletion: true })
  assertEquals(c.metadata.generateName, 'importer-aa-resumejob-')
  assertEquals(c.metadata.namespace, 'prod')
  assertEquals(c.metadata.ownerReferences.length, 1)
  assertEquals((resumeRequest(v) as { body: { action: string } }).body.action, 'ResumeJob')
})

Deno.test('hold: only the annotation, and release removes it', () => {
  assertEquals(holdPatch('  late file '), { metadata: { annotations: { 'adhar.io/batch-hold': 'late file' } } })
  assertEquals(holdPatch(null), { metadata: { annotations: { 'adhar.io/batch-hold': null } } })
})

Deno.test('gates: each action asks exactly what its request needs (§7.4)', () => {
  const t: { namespace: string; name: string; kind: RunKind } = { namespace: 'prod', name: 'x', kind: 'Job' }
  const v: typeof t = { ...t, kind: 'VolcanoJob' }
  const short = (a: Parameters<typeof actionGates>[0], target = t) => actionGates(a, target).map((g) => `${g.verb} ${g.gvr.group}/${g.gvr.resource}${g.subresource ? `/${g.subresource}` : ''}`)
  assertEquals(short('run'), ['create batch/jobs', 'get /configmaps'])
  assertEquals(short('run', v), ['create batch.volcano.sh/jobs', 'get /configmaps'])
  assertEquals(short('restart'), ['create batch/jobs', 'get /configmaps'])
  assertEquals(short('stop'), ['patch batch/jobs'])
  assertEquals(short('resume'), ['patch batch/jobs'])
  assertEquals(short('stop', v), ['create bus.volcano.sh/commands'])
  assertEquals(short('resume', v), ['create bus.volcano.sh/commands'])
  assertEquals(short('hold'), ['patch platform.adhar.io/batchjobs'])
  assertEquals(short('logs'), ['get /pods/log'])
  // Namespaced, and named where a request names one.
  assertEquals(actionGates('hold', t)[0].namespace, 'prod')
  assertEquals(actionGates('hold', t)[0].name, 'x')
  assertEquals(actionGates('run', t)[1].gvr, CONFIGMAPS_GVR)
  assertEquals(actionGates('run', v)[0].gvr, VOLCANO_JOBS_GVR)
})

/* ─────────────────────────── jobs ─────────────────────────── */

const job = (name: string, p: NonNullable<BatchJobXR['spec']>['parameters'] = {}, over: Partial<BatchJobXR> = {}): BatchJobXR => ({
  ...over,
  metadata: { name, namespace: 'prod', ...(over.metadata ?? {}) },
  spec: { parameters: p },
})

Deno.test('schedule: human-readable with its zone; none means on demand', () => {
  assertEquals(scheduleOf(job('a')), { label: 'On demand', timeZone: 'UTC', suspended: false })
  const s = scheduleOf(job('a', { schedule: { cron: '30 1 * * *', timeZone: 'Asia/Singapore' } }))
  assertEquals(s.label, 'Every day at 01:30')
  assertEquals(s.timeZone, 'Asia/Singapore')
})

Deno.test('next run: from kube-state-metrics when it knows, else the cron in the job zone', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')
  const j = job('a', { schedule: { cron: '30 1 * * *', timeZone: 'Asia/Singapore' } })
  // 01:30 in Singapore is 17:30 UTC.
  assertEquals(new Date(nextRunOf(j, { now })!).toISOString(), '2026-11-03T17:30:00.000Z')
  const reported = now + 60_000
  assertEquals(nextRunOf(j, { now, reportedMs: reported }), reported)
  // A value already past is stale: the CronJob fired and the series has not caught up.
  assertEquals(new Date(nextRunOf(j, { now, reportedMs: now - 1 })!).toISOString(), '2026-11-03T17:30:00.000Z')
})

Deno.test('next run: a held, suspended or on-demand job promises nothing', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')
  const sch = { cron: '30 1 * * *' }
  assertEquals(nextRunOf(job('a'), { now }), undefined)
  assertEquals(nextRunOf(job('a', { schedule: { ...sch, suspend: true } }), { now, reportedMs: now + 1 }), undefined)
  assertEquals(nextRunOf(job('a', { schedule: sch }, { metadata: { name: 'a', annotations: { 'adhar.io/batch-hold': 'x' } } }), { now, reportedMs: now + 1 }), undefined)
})

Deno.test('hold: the annotation or the status says so, and an empty reason is still a hold', () => {
  assertEquals(heldOf(job('a')), undefined)
  assertEquals(heldOf(job('a', {}, { metadata: { name: 'a', annotations: { 'adhar.io/batch-hold': '' } } })), { reason: '', since: undefined })
  assertEquals(heldOf(job('a', {}, { status: { held: { reason: 'r', since: 's' } } })), { reason: 'r', since: 's' })
})

const finished = (name: string, phase: 'Complete' | 'Failed', startedAt = '2026-11-03T17:30:00Z', at = '2026-11-03T17:40:00Z') =>
  runRow(run({ metadata: { name, creationTimestamp: startedAt }, status: { startTime: startedAt, conditions: [cond(phase, 'True', at)] } }), [])

Deno.test('job status: a run in progress first, then what the last run did', () => {
  const j = job('importer')
  assertEquals(jobStatusOf(j, []), 'idle')
  assertEquals(jobStatusOf(j, [finished('a', 'Complete')]), 'succeeded')
  assertEquals(jobStatusOf(j, [finished('b', 'Failed'), finished('a', 'Complete')]), 'failed')
  // A failure older than the last success is history, not a state.
  assertEquals(jobStatusOf(j, [finished('b', 'Complete'), finished('a', 'Failed')]), 'succeeded')
  assertEquals(jobStatusOf(j, [runRow(run({ status: { active: 1, ready: 1 } }), [])]), 'running')
  const broken = job('x', {}, { status: { conditions: [cond('PrerequisitesReady', 'False', undefined, 'no scheduler')] } })
  assertEquals(jobStatusOf(broken, []), 'not-ready')
  assertEquals(jobStatusOf(broken, [finished('b', 'Failed')]), 'failed')
  assertEquals(jobStatusOf(job('x', {}, { metadata: { name: 'x', deletionTimestamp: 'x' } }), []), 'deleting')
})

Deno.test('SLA: nothing to judge is not the same as fine', () => {
  const now = Date.parse('2026-11-03T18:00:00Z')
  assertEquals(slaStateOf(job('a'), [], now).level, 'none')
  assertEquals(slaStateOf(job('a', { sla: { maxDuration: '1h' } }), [], now).level, 'ok')
})

Deno.test('SLA: a running run against maxDuration, a last run over it, a stale schedule', () => {
  const now = Date.parse('2026-11-03T18:00:00Z')
  const running = (startTime: string) => [runRow(run({ status: { active: 1, ready: 1, startTime } }), [], now)]
  const j = job('a', { sla: { maxDuration: '1h' } })
  assertEquals(slaStateOf(j, running('2026-11-03T17:30:00Z'), now).level, 'ok')
  assertEquals(slaStateOf(j, running('2026-11-03T17:05:00Z'), now).level, 'at-risk')
  assertEquals(slaStateOf(j, running('2026-11-03T16:30:00Z'), now).level, 'breached')
  assertEquals(slaStateOf(j, [finished('x', 'Complete', '2026-11-03T15:00:00Z', '2026-11-03T17:00:00Z')], now).level, 'breached')
  // Newer runs matter: only the last finished run is judged.
  assertEquals(slaStateOf(j, [finished('y', 'Complete', '2026-11-03T17:00:00Z', '2026-11-03T17:10:00Z'), finished('x', 'Complete', '2026-11-03T14:00:00Z', '2026-11-03T17:00:00Z')], now).level, 'ok')

  const sch = { cron: '0 1 * * *' }
  const staleAt = { status: { lastSuccessfulTime: '2026-11-01T00:00:00Z' } }
  assertEquals(slaStateOf(job('a', { schedule: sch }, staleAt), [], now).level, 'breached')
  // A job on hold is expected to be quiet.
  assertEquals(slaStateOf(job('a', { schedule: sch }, { ...staleAt, metadata: { name: 'a', annotations: { 'adhar.io/batch-hold': 'x' } } }), [], now).level, 'ok')
  // The default limit is the hard deadline.
  assertEquals(slaStateOf(job('a', { timeouts: { activeDeadlineSeconds: 3600 } }), [], now).maxDurationMs, 3_600_000)
})

Deno.test('durations: an unreadable one means no limit, never zero', () => {
  assertEquals(parseDurationMs('3h'), 10_800_000)
  assertEquals(parseDurationMs('1h30m'), 5_400_000)
  assertEquals(parseDurationMs('45s'), 45_000)
  assertEquals(parseDurationMs('1d'), 86_400_000)
  for (const bad of [undefined, '', 'soon', '3', '3h and more']) assertEquals(parseDurationMs(bad), undefined, String(bad))
})

Deno.test('jobs page: grouped by application, then environment in promotion order', () => {
  const j = (name: string, app: string, env: string) => job(name, {}, { metadata: { name, namespace: env, labels: { 'adhar.io/application': app, 'adhar.io/environment': env } } })
  const rows = jobRows([j('b', 'zeta', 'dev'), j('a', 'alpha', 'prod'), j('a', 'alpha', 'dev'), j('a', 'alpha', 'test')], [])
  assertEquals(rows.map((r) => `${r.application}/${r.environment}`), ['alpha/dev', 'alpha/test', 'alpha/prod', 'zeta/dev'])
  assertEquals(groupByApplication(rows).map((g) => [g.application, g.rows.length]), [['alpha', 3], ['zeta', 1]])
})

Deno.test('jobs page: a run counts for its job only in its own namespace', () => {
  const mine = runRow(run({ metadata: { name: 'importer-aa', namespace: 'prod', labels: { 'adhar.io/batch-job': 'importer' } } }), [])
  const other = runRow(run({ metadata: { name: 'importer-bb', namespace: 'dev', labels: { 'adhar.io/batch-job': 'importer' } } }), [])
  const rows = jobRows([job('importer')], [mine, other])
  assertEquals(rows[0].runs.map((r) => r.name), ['importer-aa'])
})

Deno.test('jobs page: next-run index joins on the namespace and the CronJob', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')
  const idx = nextScheduleIndex([{ labels: { namespace: 'prod', cronjob: 'importer' }, value: (now + 60_000) / 1_000 }, { labels: { namespace: 'prod' }, value: 1 }])
  assertEquals([...idx.keys()], ['prod/importer'])
  const rows = jobRows([job('importer', { schedule: { cron: '0 1 * * *' } })], [], { nextByCronJob: idx, now })
  assertEquals(rows[0].nextRunMs, now + 60_000)
  assertStringIncludes(nextScheduleQuery(['a.b', 'c']), 'namespace=~"a\\\\.b|c"')
})

Deno.test('jobs page: a batch application with no BatchJob is shown as not deployed', () => {
  const apps = [
    { metadata: { name: 'importer', labels: { 'adhar.io/workload': 'batch' } } },
    { metadata: { name: 'reports' }, spec: { parameters: { type: 'batch' } } },
    { metadata: { name: 'web' }, spec: { parameters: { type: 'service' } } },
  ]
  assert(isBatchApplication(apps[0]))
  assert(!isBatchApplication(apps[2]))
  const rows = jobRows([job('importer')], [])
  assertEquals(pendingApplications(apps, rows).map((a) => a.metadata.name), ['reports'])
})

Deno.test('deployment kind: partitioned on Volcano only', () => {
  assertEquals(runKindOfJob(job('a')), 'Job')
  assertEquals(runKindOfJob(job('a', { mode: 'partitioned' })), 'Job')
  assertEquals(runKindOfJob(job('a', { mode: 'partitioned' }, { status: { scheduler: 'volcano' } })), 'VolcanoJob')
})

/* ─────────────────────────── page states: never an empty table for the wrong reason ─────────────────────────── */

Deno.test('page state: each of them, told apart', () => {
  const list = (o: Partial<Parameters<typeof pageStateOf>[0]['list'] & object> = {}) => ({ items: [], scope: 'cluster' as const, namespaces: [], denied: [], installed: true, ...o })
  const st = (l?: ReturnType<typeof list>, flags = { isLoading: false, isError: false }, pending = 0) => pageStateOf({ list: l, ...flags }, pending)
  assertEquals(st(undefined, { isLoading: true, isError: false }), 'loading')
  assertEquals(st(undefined, { isLoading: false, isError: true }), 'error')
  assertEquals(st(list({ installed: false })), 'not-installed')
  assertEquals(st(list()), 'empty')
  assertEquals(st(list({ items: [job('a')] })), 'ready')
  // Every namespace refused: not "no jobs".
  assertEquals(st(list({ scope: 'namespaces', namespaces: ['a', 'b'], denied: ['a', 'b'] })), 'forbidden')
  assertEquals(st(list({ scope: 'namespaces', namespaces: [], denied: [] })), 'forbidden')
  // Some refused, some empty: it is true that the readable ones hold nothing.
  assertEquals(st(list({ scope: 'namespaces', namespaces: ['a', 'b'], denied: ['a'] })), 'empty')
  // A refused namespace does not hide what could be read.
  assertEquals(st(list({ scope: 'namespaces', namespaces: ['a', 'b'], denied: ['a'], items: [job('x')] })), 'ready')
  // A scaffolded application is something to show.
  assertEquals(st(list(), undefined, 1), 'ready')
})

/* ─────────────────────────── duration bars, events, queries, links ─────────────────────────── */

Deno.test('duration bars: oldest first, scaled to the taller of the slowest run and the limit', () => {
  const a = finished('new', 'Complete', '2026-11-03T17:00:00Z', '2026-11-03T17:30:00Z')
  const b = finished('old', 'Failed', '2026-11-03T10:00:00Z', '2026-11-03T12:00:00Z')
  const { bars, limitRatio } = durationBars([a, b], 3_600_000)
  assertEquals(bars.map((x) => x.name), ['old', 'new'])
  assertEquals(bars[0].ratio, 1)
  assertEquals(bars[0].over, true)
  assertEquals(bars[1].over, false)
  assertEquals(bars[1].ratio, 0.25)
  assertEquals(limitRatio, 0.5)
  assertEquals(durationBars([], undefined), { bars: [], limitRatio: undefined })
})

Deno.test('events: about this run and its pods, newest first', () => {
  const e = (name: string, at: string) => ({ metadata: { name: `${name}.1`, uid: `${name}-${at}` }, involvedObject: { kind: 'Pod', name }, lastTimestamp: at, reason: 'R' })
  const rows = runEvents([e('importer-aa-x', '2026-11-03T10:00:00Z'), e('importer-aa', '2026-11-03T11:00:00Z'), e('importer-bb', '2026-11-03T12:00:00Z'), e('stray', '2026-11-03T12:00:00Z')], { name: 'importer-aa' }, ['importer-aa-x'])
  assertEquals(rows.map((r) => r.object), ['Pod/importer-aa', 'Pod/importer-aa-x'])
  assertEquals(runEvents(undefined, { name: 'x' }, []), [])
})

Deno.test('metrics: scoped to this run’s pods, with the selector escaped', () => {
  const [cpu] = runMetricQueries('prod', 'importer-aa')
  assertStringIncludes(cpu.query, 'namespace="prod"')
  assertStringIncludes(cpu.query, 'pod=~"importer-aa-.*"')
  assertStringIncludes(runMetricQueries('pr"od', 'x')[0].query, 'namespace="pr\\"od"')
})

Deno.test('alerts: read by the label the composed rules set', () => {
  assertEquals(firingAlertsQuery('prod', 'importer'), 'ALERTS{alertstate="firing",namespace="prod",adhar_batch_job="importer"}')
  assertEquals(firingAlerts([{ labels: { alertname: 'B', severity: 'critical' }, value: 1 }, { labels: { alertname: 'A' }, value: 1 }]).map((a) => a.name), ['A', 'B'])
})

Deno.test('links: the application’s dashboard in this environment, Loki and Tempo', () => {
  assertEquals(observabilityLinks('', { application: 'a', namespace: 'prod', name: 'a' }), undefined)
  const l = observabilityLinks('https://grafana.x/', { application: 'importer', namespace: 'prod', name: 'importer', run: 'importer-aa' })!
  assertEquals(l.dashboard, 'https://grafana.x/d/app-importer?var-env=prod')
  assertStringIncludes(decodeURIComponent(l.logs), 'pod=~\\"importer-aa-.*\\"')
  assertStringIncludes(decodeURIComponent(l.traces), 'resource.service.name')
})

Deno.test('refs: namespace/name round-trips and refuses anything else', () => {
  assertEquals(parseBatchRef(batchRef('prod', 'a')), { namespace: 'prod', name: 'a' })
  for (const bad of [undefined, '', 'noslash', '/x', 'x/']) assertEquals(parseBatchRef(bad), null, String(bad))
})
