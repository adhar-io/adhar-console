import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1'
import { DEFAULT_CONFIG, type PerfTestConfig } from './perf-format.ts'
import { DEFAULT_TOLERANCE, evaluateGate, gateEnv, type PerfBaseline, type PerfGate } from './perf-gate.ts'
import { extractSummary, joinRunnerSummaries, readStoredSummary } from './perf-results.ts'
import {
  artefactConfigMap,
  cronJobManifest,
  defaultScheduleName,
  kargoAnalysisTemplate,
  manualJobFromSchedule,
  RUN_SCRIPT,
  RUNNER_SA,
  runnerRbac,
  scheduleFromCronJob,
  scheduleNameError,
  tektonTask,
  testRunTemplate,
} from './perf-runner.ts'
import { RUNNER_LOG } from './testdata/k6-runner-log.ts'

/**
 * The runner script is what a CronJob, a Tekton step and a Kargo
 * verification actually execute, so it is not just inspected here — it is
 * RUN, against a fake `kubectl` that plays the k6 operator. The verdict it
 * reaches is then checked against `evaluateGate` on the same numbers, which
 * is what keeps the awk and the TypeScript from drifting apart.
 */

const config: PerfTestConfig = {
  ...DEFAULT_CONFIG,
  title: 'Checkout',
  namespace: 'perf',
  parallelism: 2,
  arguments: '--vus 10',
  env: { BASE_URL: 'http://checkout' },
}

/* ─────────────────────────── the fake cluster ─────────────────────────── */

const FAKE_KUBECTL = `#!/bin/sh
F="$FAKE_DIR"
shift 2
echo "$*" >> "$F/calls.log"
case "$1 $2" in
  "get configmap")
    case "$*" in
      *gate*env*) [ -f "$F/gate.env" ] && cat "$F/gate.env" || exit 1 ;;
      *testrun*json*) cat "$F/testrun.json" ;;
      *"-l "*) printf 'configmap/k6-result-old1\\nconfigmap/k6-result-old2\\nconfigmap/k6-result-new\\n' ;;
    esac ;;
  "create -f") cp "$3" "$F/created.json" ;;
  "get testrun")
    case "$*" in
      *status.stage*) cat "$F/stage" ;;
      *spec.parallelism*) echo 2 ;;
    esac ;;
  "get pods") printf 'pod/run-initializer-x\\npod/run-1-abc\\npod/run-2-def\\n' ;;
  "create configmap")
    for a in "$@"; do case "$a" in --from-file=summary.txt=*) cp "\${a#--from-file=summary.txt=}" "$F/summary.txt" ;; esac; done
    echo "$3" > "$F/result-name" ;;
  *)
    case "$1" in
      logs) cat "$F/runner.log" ;;
      get) case "$2" in *-2-*) cat "$F/exit2" ;; *) echo 0 ;; esac ;;
      label|annotate|delete) echo "$*" >> "$F/$1.log" ;;
    esac ;;
esac
exit 0
`

interface Outcome {
  code: number
  stdout: string
  verdict: string
  annotations: string
  labels: string
  deleted: string
  created: Record<string, unknown>
  summary: string
}

async function runScript(opts: {
  gate?: PerfGate
  baseline?: PerfBaseline
  exit2?: string
  stage?: string
  env?: Record<string, string>
  noArtefact?: boolean
  log?: string
}): Promise<Outcome> {
  const dir = await Deno.makeTempDir({ prefix: 'perf-runner-test-' })
  try {
    const write = (name: string, text: string) => Deno.writeTextFile(`${dir}/${name}`, text)
    await write('kubectl', FAKE_KUBECTL)
    await Deno.chmod(`${dir}/kubectl`, 0o755)
    await write('run.sh', RUN_SCRIPT)
    if (!opts.noArtefact) {
      await write('gate.env', gateEnv({ test: 'checkout', namespace: 'perf', commit: 'abc1234', gate: opts.gate, baseline: opts.baseline }))
    }
    await write('testrun.json', JSON.stringify(testRunTemplate({ test: 'checkout', config, commit: 'abc1234' })))
    await write('runner.log', opts.log ?? RUNNER_LOG)
    await write('exit2', `${opts.exit2 ?? '0'}\n`)
    await write('stage', `${opts.stage ?? 'finished'}\n`)

    const out = await new Deno.Command('sh', {
      args: [`${dir}/run.sh`],
      env: {
        PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin',
        FAKE_DIR: dir,
        KUBECTL: `${dir}/kubectl`,
        TEST: 'checkout',
        NS: 'perf',
        TRIGGER: 'ci',
        POLL: '0',
        RETAIN: '2',
        VERDICT_FILE: `${dir}/verdict`,
        ...opts.env,
      },
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).output()

    const read = (name: string) => Deno.readTextFile(`${dir}/${name}`).catch(() => '')
    const created = await read('created.json')
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
      verdict: await read('verdict'),
      annotations: await read('annotate.log'),
      labels: await read('label.log'),
      deleted: await read('delete.log'),
      created: created ? JSON.parse(created) : {},
      summary: await read('summary.txt'),
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const gate: PerfGate = { p95Ms: 500, errorRatePct: 2, requireThresholds: true, failOnRegression: false, tolerance: DEFAULT_TOLERANCE }

Deno.test('runner: a run inside its budget passes and is recorded', async () => {
  const r = await runScript({ gate })
  assertEquals(r.code, 0, r.stdout)
  assertEquals(r.verdict, 'pass')

  // The TestRun came from the template with the tokens filled in.
  const meta = r.created.metadata as { name: string; labels: Record<string, string> }
  assert(/^checkout-\d{8}-\d{6}$/.test(meta.name), meta.name)
  assertEquals(meta.labels['adhar.io/perf-trigger'], 'ci')
  assertEquals(meta.labels['adhar.io/perf-runner'], 'job')

  // Both runners were harvested; the initializer was not.
  const stored = readStoredSummary(r.summary)
  assertEquals(stored.runners, 2)
  assertEquals(stored.metrics?.rps, 98.12)
  assertEquals(r.summary.includes('running ('), false)

  assertStringIncludes(r.labels, 'adhar.io/perf-result=true')
  assertStringIncludes(r.labels, 'adhar.io/perf-commit=abc1234')
  assertStringIncludes(r.annotations, 'adhar.io/perf-verdict=pass')
  assertStringIncludes(r.annotations, 'adhar.io/perf-stage=finished')
  assertStringIncludes(r.annotations, 'adhar.io/perf-parallelism=2')
  assertStringIncludes(r.annotations, 'adhar.io/perf-harvested=k6-result-checkout-')

  // CLEANUP deletes the TestRun; RETAIN=2 drops the oldest of three results.
  assertStringIncludes(r.deleted, 'testrun checkout-')
  assertStringIncludes(r.deleted, 'configmap/k6-result-old1')
  assertEquals(r.deleted.includes('old2'), false)
})

Deno.test('runner: p(99) — now that every run asks for it — is gated like p95', async () => {
  const log = RUNNER_LOG.replace('p(95)=241ms', 'p(95)=241ms  p(99)=612ms')
  const r = await runScript({ gate: { ...gate, p99Ms: 500 }, log })
  assertEquals(r.code, 1, r.stdout)
  assertStringIncludes(r.stdout, 'p99=612ms')
  assertStringIncludes(r.annotations, 'p99_ms 612 > 500')
  assertEquals(readStoredSummary(r.summary).metrics?.p99Ms, 612)
  // Without it in the summary the limit fails as "not reported", never as a pass.
  const old = await runScript({ gate: { ...gate, p99Ms: 500 } })
  assertStringIncludes(old.annotations, 'p99_ms not reported')
})

Deno.test('runner: a breached budget fails the step, with the reason', async () => {
  const r = await runScript({ gate: { ...gate, p95Ms: 200 } })
  assertEquals(r.code, 1)
  assertEquals(r.verdict, 'fail')
  assertStringIncludes(r.annotations, 'adhar.io/perf-verdict=fail')
  assertStringIncludes(r.annotations, 'p95_ms 241 > 200')
})

Deno.test('runner: ENFORCE_GATE=false records the failure without failing the job', async () => {
  const r = await runScript({ gate: { ...gate, p95Ms: 200 }, env: { ENFORCE_GATE: 'false' } })
  assertEquals(r.code, 0)
  assertEquals(r.verdict, 'fail')
})

Deno.test('runner: exit code 99 from any runner is a threshold failure', async () => {
  const r = await runScript({ gate, exit2: '99' })
  assertEquals(r.code, 1)
  assertStringIncludes(r.annotations, 'adhar.io/perf-exit-code=99')
  assertStringIncludes(r.annotations, 'script thresholds crossed')
})

Deno.test('runner: a regression against the baseline gates only when asked to', async () => {
  const baseline: PerfBaseline = { run: 'checkout-r1', pinnedAt: '', metrics: { p95Ms: 150, rps: 98.12 } }
  const soft = await runScript({ gate, baseline })
  assertEquals(soft.code, 0)
  assertStringIncludes(soft.annotations, 'regressed (not gating): p95_ms 241 > 165')

  const hard = await runScript({ gate: { ...gate, failOnRegression: true }, baseline })
  assertEquals(hard.code, 1)
  assertStringIncludes(hard.annotations, 'regression vs checkout-r1')
})

Deno.test('runner: a run that errors fails even with no gate', async () => {
  const r = await runScript({ stage: 'error' })
  assertEquals(r.code, 1)
  assertStringIncludes(r.annotations, 'run ended in stage error')
})

Deno.test('runner: a missing artefact is an infrastructure error, not a verdict', async () => {
  const r = await runScript({ noArtefact: true })
  assertEquals(r.code, 2)
  assertStringIncludes(r.stdout, 'not found')
})

Deno.test('runner and console agree on the verdict for the same numbers', async () => {
  const stored = readStoredSummary(joinRunnerSummaries([
    { pod: 'a', summary: extractSummary(RUNNER_LOG) },
    { pod: 'b', summary: extractSummary(RUNNER_LOG) },
  ]))
  const cases: PerfGate[] = [
    gate,
    { ...gate, p95Ms: 240 },
    { ...gate, errorRatePct: 0.5 },
    { ...gate, minRps: 99 },
    { ...gate, minRps: 98 },
    { ...gate, avgMs: 99 },
  ]
  for (const g of cases) {
    const shell = await runScript({ gate: g })
    const ts = evaluateGate({ metrics: stored.metrics, stage: 'finished', exitCode: 0, gate: g })
    // The fixture's own http_req_failed threshold is crossed but the exit
    // code is 0, so the script-threshold check is disabled for parity: the
    // shell trusts k6's exit code, the console also reads the ✗ marks.
    const tsNoThresholds = evaluateGate({ metrics: stored.metrics, stage: 'finished', gate: { ...g, requireThresholds: false } })
    assertEquals(shell.verdict, tsNoThresholds.status, `${JSON.stringify(g)}\n${shell.stdout}`)
    assert(ts.status === 'fail' || ts.status === tsNoThresholds.status)
  }
})

/* ─────────────────────────── manifests ─────────────────────────── */

Deno.test('the artefact carries script, template, gate and runner', () => {
  const cm = artefactConfigMap({ test: 'checkout', config: { ...config, gate }, script: 'export default () => {}', commit: 'abc' })
  assertEquals(cm.metadata.name, 'k6-checkout')
  assertEquals(cm.metadata.namespace, 'perf')
  assertEquals(Object.keys(cm.data).sort(), ['gate.env', 'run.sh', 'script.js', 'testrun.json'])
  assertStringIncludes(cm.data['gate.env'], "GATE_P95_MS='500'")
  const tr = JSON.parse(cm.data['testrun.json'])
  assertEquals(tr.spec.parallelism, 2)
  assertEquals(tr.spec.paused, 'false')
  assertEquals(tr.spec.arguments, '--vus 10')
  // The script sets no summaryTrendStats, so the template asks for p(99) itself.
  assertEquals(tr.spec.runner.env, [{ name: 'BASE_URL', value: 'http://checkout' }, { name: 'K6_SUMMARY_TREND_STATS', value: 'avg,min,med,max,p(90),p(95),p(99)' }])
  // No cleanup: 'post' — the operator would delete the TestRun before its result was harvested.
  assertEquals('cleanup' in tr.spec, false)
})

Deno.test('the runner script contains no unexpanded template placeholders', () => {
  assertEquals(RUN_SCRIPT.includes('%{'), false)
  assertStringIncludes(RUN_SCRIPT, '${TEST:?TEST is required}')
  assertStringIncludes(RUN_SCRIPT, String.raw`/running \(|\[ *[0-9]+%|\[=/`)
})

Deno.test('RBAC is namespaced and limited to what the runner calls', () => {
  const [sa, role, binding] = runnerRbac('perf') as Array<Record<string, unknown>>
  assertEquals(sa.kind, 'ServiceAccount')
  assertEquals(role.kind, 'Role')
  assertEquals(binding.kind, 'RoleBinding')
  const rules = (role as { rules: Array<{ resources: string[] }> }).rules
  assertEquals(rules.flatMap((r) => r.resources).sort(), ['configmaps', 'pods', 'pods/log', 'testruns'])
})

Deno.test('a schedule round-trips through its CronJob', () => {
  const input = {
    name: 'checkout-nightly',
    namespace: 'perf',
    test: 'checkout',
    cron: '0 2 * * *',
    timeZone: 'Asia/Kolkata',
    suspend: false,
    enforceGate: true,
    description: 'Nightly regression run',
    image: 'alpine/k8s:1.31.1',
    retain: 30,
    timeoutSecs: 3600,
  }
  const cj = cronJobManifest(input)
  assertEquals(cj.spec.concurrencyPolicy, 'Forbid')
  assertEquals(cj.spec.jobTemplate.spec.template.spec.serviceAccountName, RUNNER_SA)
  const back = scheduleFromCronJob({ ...cj, metadata: { ...cj.metadata, uid: 'u1' }, status: { lastScheduleTime: 't' } })!
  assertEquals({ ...back, uid: undefined, createdAt: undefined, lastScheduleTime: undefined, lastSuccessfulTime: undefined, active: 0 }, {
    ...input,
    uid: undefined,
    createdAt: undefined,
    lastScheduleTime: undefined,
    lastSuccessfulTime: undefined,
    active: 0,
  })
  assertEquals(back.lastScheduleTime, 't')
})

Deno.test('CronJobs that are not perf schedules are ignored', () => {
  assertEquals(scheduleFromCronJob({ metadata: { name: 'backup', labels: { app: 'db' } } }), null)
})

Deno.test('run now stamps a Job from the schedule, marked manual and owned by the CronJob', () => {
  const s = scheduleFromCronJob({
    ...cronJobManifest({
      name: 'checkout-nightly',
      namespace: 'perf',
      test: 'checkout',
      cron: '0 2 * * *',
      suspend: true,
      enforceGate: true,
      image: '',
      retain: 50,
      timeoutSecs: 7200,
    }),
    metadata: { name: 'checkout-nightly', namespace: 'perf', uid: 'u1', labels: { 'adhar.io/perf-test': 'checkout', 'adhar.io/perf-schedule': 'checkout-nightly' } },
  })!
  const job = manualJobFromSchedule(s, '021500')
  assertEquals(job.kind, 'Job')
  assertEquals(job.metadata.name, 'checkout-nightly-m-021500')
  assertEquals(job.metadata.ownerReferences?.[0].uid, 'u1')
  const env = job.spec.template.spec.containers[0].env
  assertEquals(env.find((e) => e.name === 'TRIGGER')?.value, 'manual')
})

Deno.test('schedule names fit the CronJob limit', () => {
  assertEquals(scheduleNameError('checkout-nightly'), null)
  assertEquals(typeof scheduleNameError('a'.repeat(53)), 'string')
  assertEquals(typeof scheduleNameError('Bad_Name'), 'string')
  assertEquals(defaultScheduleName('a'.repeat(63)).length <= 52, true)
})

Deno.test('CI and promotion snippets point at the test and its runner', () => {
  const t = tektonTask({ test: 'checkout', namespace: 'perf' })
  assertStringIncludes(t, 'kind: Task')
  assertStringIncludes(t, 'default: checkout')
  assertStringIncludes(t, String.raw`jsonpath='{.data.run\.sh}'`)
  assertStringIncludes(t, '$(results.verdict.path)')
  const k = kargoAnalysisTemplate({ test: 'checkout', namespace: 'perf', project: 'shop' })
  assertStringIncludes(k, 'kind: AnalysisTemplate')
  assertStringIncludes(k, 'namespace: shop')
  assertStringIncludes(k, 'name: perf-gate-checkout')
})
