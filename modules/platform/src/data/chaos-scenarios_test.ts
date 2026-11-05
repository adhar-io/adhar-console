import { assert, assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1'
import {
  applicationOf,
  buildGameDay,
  formatSeconds,
  GAMEDAY_SERVICE_ACCOUNT,
  GAMEDAY_TTL_SECONDS,
  KUBECTL_IMAGE,
  LABEL_APPLICATION,
  REVERT_DELETE_TIMEOUT_SECONDS,
  revertDeadlineSeconds,
  SCENARIOS,
  scenarioById,
  TERMINATION_LOG,
  totalSeconds,
  VERDICT_GRACE_SECONDS,
  type GameDayInput,
} from './chaos-scenarios.ts'
import { CHAOS_NAMESPACE, CHAOS_SERVICE_ACCOUNT, faultById } from './chaos-kinds.ts'
import { engineManifest } from './chaos.ts'

Deno.test('every scenario states a hypothesis — otherwise it is just breakage', () => {
  for (const s of SCENARIOS) {
    assertEquals(typeof s.hypothesis, 'string', s.id)
    assertEquals(s.hypothesis.length > 20, true, s.id)
    assertEquals(s.seconds > 0, true, s.id)
  }
})

Deno.test('scenario ids are unique and resolvable, and every fault they name is catalogued', () => {
  const ids = SCENARIOS.map((s) => s.id)
  assertEquals(new Set(ids).size, ids.length)
  for (const s of SCENARIOS) {
    assertEquals(scenarioById(s.id)?.id, s.id)
    assertEquals(faultById(s.fault)?.id, s.fault, `${s.id} names unknown fault ${s.fault}`)
  }
})

Deno.test('scenarios never carry their own target — the launcher supplies it', () => {
  for (const s of SCENARIOS) {
    assertEquals('PODS_AFFECTED_PERC' in s.env && s.blast !== 'high', false, s.id)
    assertEquals('TARGET_NODES' in s.env, false, s.id)
  }
})

Deno.test('the catalogue covers the failure families that matter', () => {
  const cats = new Set(SCENARIOS.map((s) => s.category))
  for (const c of ['availability', 'network', 'resource', 'storage', 'dependency', 'node']) assertEquals(cats.has(c as never), true, c)
})

const target: GameDayInput['target'] = { namespace: 'payments', label: 'app=checkout', mode: 'one' }

Deno.test('an engine manifest is a runnable Litmus ChaosEngine', () => {
  const m = engineManifest({ fault: 'pod-network-latency', name: 'x', targetNamespace: 'payments', label: 'app=checkout', mode: 'percent', percent: '50', env: { NETWORK_LATENCY: '250' } })
  assertEquals(m.kind, 'ChaosEngine')
  assertEquals(m.metadata.namespace, CHAOS_NAMESPACE)
  assertEquals(m.spec?.chaosServiceAccount, CHAOS_SERVICE_ACCOUNT)
  assertEquals(m.spec?.engineState, 'active')
  assertEquals(m.spec?.appinfo, { appns: 'payments', applabel: 'app=checkout', appkind: 'deployment' })
  const env = Object.fromEntries((m.spec?.experiments?.[0].spec?.components?.env ?? []).map((e) => [e.name, e.value]))
  assertEquals(env.NETWORK_LATENCY, '250')       // override wins
  assertEquals(env.TOTAL_CHAOS_DURATION, '60')   // catalogue default kept
  assertEquals(env.PODS_AFFECTED_PERC, '50')
})

Deno.test('a steady-state URL becomes a continuous Litmus http probe that fails the run', () => {
  const m = engineManifest({ fault: 'pod-delete', name: 'x', targetNamespace: 'p', mode: 'one', steadyState: { url: 'http://svc/health', statusCode: 200, intervalSeconds: 5 } })
  const probe = m.spec?.experiments?.[0].spec?.probe?.[0] as Record<string, unknown>
  assertEquals(probe.type, 'httpProbe')
  assertEquals(probe.mode, 'Continuous')
  assertEquals((probe.runProperties as Record<string, unknown>).stopOnFailure, true)
  assertEquals(((probe['httpProbe/inputs'] as Record<string, unknown>).method as Record<string, Record<string, string>>).get.responseCode, '200')
})

Deno.test('a node fault carries no appinfo and names the node', () => {
  const m = engineManifest({ fault: 'node-drain', name: 'x', targetNamespace: 'p', mode: 'one', node: 'w-1' })
  assertEquals(m.spec?.appinfo, undefined)
  const env = Object.fromEntries((m.spec?.experiments?.[0].spec?.components?.env ?? []).map((e) => [e.name, e.value]))
  assertEquals(env.TARGET_NODES, 'w-1')
})

Deno.test('a serial game day alternates faults and recovery pauses, then reverts', () => {
  const wf = buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'serial', recoverySeconds: 30 }) as {
    spec: { entrypoint: string; onExit: string; serviceAccountName: string; templates: Array<Record<string, unknown>> }
    metadata: { namespace: string; labels: Record<string, string> }
  }
  assertEquals(wf.metadata.namespace, CHAOS_NAMESPACE)
  assertEquals(wf.spec.serviceAccountName, GAMEDAY_SERVICE_ACCOUNT)
  assertEquals(wf.spec.onExit, 'revert')
  const entry = wf.spec.templates.find((t) => t.name === wf.spec.entrypoint) as { steps: Array<Array<{ name: string }>> }
  assertEquals(entry.steps.map((g) => g.map((s) => s.name)), [['1-pod-delete-one'], ['1-recover'], ['2-net-latency']])
  const step = wf.spec.templates.find((t) => t.name === '1-pod-delete-one') as { container: { image: string; args: string[] }; inputs: { artifacts: Array<{ raw: { data: string } }> } }
  assertEquals(step.container.image, KUBECTL_IMAGE)
  const eng = JSON.parse(step.inputs.artifacts[0].raw.data)
  assertEquals(eng.kind, 'ChaosEngine')
  assertEquals(eng.metadata.labels['adhar.io/chaos-gameday'], 'gd')
  assertEquals(eng.spec.experiments[0].name, 'pod-delete')
})

Deno.test('a parallel game day is one step group with no pauses', () => {
  const wf = buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'parallel', recoverySeconds: 30 }) as {
    spec: { entrypoint: string; templates: Array<Record<string, unknown>> }
  }
  const entry = wf.spec.templates.find((t) => t.name === wf.spec.entrypoint) as { steps: Array<Array<{ name: string }>> }
  assertEquals(entry.steps.length, 1)
  assertEquals(entry.steps[0].length, 2)
  assertEquals(wf.spec.templates.some((t) => 'suspend' in t), false)
})

Deno.test('the revert step stops and deletes every engine the game day made', () => {
  const wf = buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'serial', recoverySeconds: 0 }) as {
    spec: { templates: Array<Record<string, unknown>> }
  }
  const revert = wf.spec.templates.find((t) => t.name === 'revert') as { container: { args: string[] } }
  const script = revert.container.args[0]
  assertEquals(script.includes('gd-1-pod-delete'), true)
  assertEquals(script.includes('gd-2-pod-network-latency'), true)
  assertEquals(script.includes('"engineState":"stop"'), true)
  assertEquals(script.includes('delete chaosengine'), true)
})

Deno.test('a game day needs at least one scenario', () => {
  assertThrows(() => buildGameDay({ name: 'gd', target, scenarios: [], strategy: 'serial', recoverySeconds: 0 }))
})

Deno.test('duration arithmetic', () => {
  const chosen = ['pod-delete-one', 'net-latency'].map(scenarioById).filter(Boolean) as NonNullable<ReturnType<typeof scenarioById>>[]
  assertEquals(totalSeconds(chosen, { strategy: 'serial', recoverySeconds: 30 }), 60 + 30 + 120)
  assertEquals(totalSeconds(chosen, { strategy: 'parallel', recoverySeconds: 30 }), 120)
  assertEquals(formatSeconds(90), '1m 30s')
  assertEquals(formatSeconds(3600), '1h 0m')
})

/* ─────────────── what the platform's Argo and policies require ─────────────── */

type Container = {
  image: string
  command?: string[]
  args: string[]
  env?: Array<{ name: string; value: string }>
  securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; allowPrivilegeEscalation?: boolean; capabilities?: { drop?: string[] } }
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
}
type Template = {
  name: string
  container?: Container
  suspend?: unknown
  activeDeadlineSeconds?: number
  inputs?: { artifacts: Array<{ path: string; mode?: number; raw: { data: string } }> }
}
type GameDay = {
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: {
    entrypoint: string
    activeDeadlineSeconds: number
    ttlStrategy: { secondsAfterCompletion?: number; secondsAfterSuccess?: number; secondsAfterFailure?: number }
    podGC: { strategy: string }
    templates: Template[]
  }
}

const gameDay = (over: Partial<GameDayInput> = {}) =>
  buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'serial', recoverySeconds: 30, ...over }) as unknown as GameDay
const containers = (wf: GameDay) => wf.spec.templates.flatMap((t) => (t.container ? [t] : [])) as Array<Template & { container: Container }>
const scenarioSteps = (wf: GameDay) => wf.spec.templates.filter((t) => t.inputs?.artifacts?.length) as Array<Template & { container: Container }>

Deno.test('every step runs the docker.io Litmus 3.33.0 kubectl image — never the scarf redirect host', () => {
  // The registry policy admits docker.io and not litmuschaos.docker.scarf.sh,
  // and the local Kind image cache mirrors docker.io only.
  assertEquals(KUBECTL_IMAGE, 'docker.io/litmuschaos/k8s:3.33.0')
  const wf = gameDay()
  for (const t of containers(wf)) assertEquals(t.container.image, KUBECTL_IMAGE, t.name)
  const json = JSON.stringify(wf)
  assert(!json.includes('scarf.sh'), 'no step pulls from the scarf host')
})

Deno.test('no step trusts litmus-checker for a verdict — it exits 0 whatever the verdict', () => {
  const wf = gameDay()
  assert(!JSON.stringify(wf).includes('litmus-checker'))
  for (const t of scenarioSteps(wf)) {
    const script = t.container.args[0]
    assertEquals(t.container.command, ['sh', '-c'])
    assertStringIncludes(script, 'kubectl create -f')
    assertStringIncludes(script, '.status.experimentStatus.verdict')
    // The only exit 0 is the Pass branch.
    assertEquals(script.match(/exit 0/g)?.length, 1, t.name)
    assertStringIncludes(script, 'Pass) printf')
    // Its reason goes where Argo reads a step's message from.
    assertEquals(script.split(`tlog='${TERMINATION_LOG}'`).length, 2, t.name)
  }
})

Deno.test('a scenario step waits for its own result, for the fault plus the grace', () => {
  const wf = gameDay()
  const [first, second] = scenarioSteps(wf)
  assertStringIncludes(first.container.args[0], `result='gd-1-pod-delete-pod-delete'`)
  assertStringIncludes(first.container.args[0], `budget=${60 + VERDICT_GRACE_SECONDS}`)
  assertStringIncludes(second.container.args[0], `result='gd-2-pod-network-latency-pod-network-latency'`)
  assertStringIncludes(second.container.args[0], `budget=${120 + VERDICT_GRACE_SECONDS}`)
  // The step reads the engine from the artifact the workflow carries — as a
  // non-root user, so the file is made world-readable whatever the umask of
  // the executor that writes it.
  for (const step of [first, second]) {
    assertStringIncludes(step.container.args[0], `file='${step.inputs!.artifacts[0].path}'`)
    assertEquals(step.inputs!.artifacts[0].mode, 0o444, step.name)
  }
})

Deno.test('a finished game day stays for 7 days whatever the platform workflowDefaults say', () => {
  const wf = gameDay()
  assertEquals(GAMEDAY_TTL_SECONDS, 604_800)
  assertEquals(wf.spec.podGC, { strategy: 'OnWorkflowSuccess' })
  // The controller merges workflowDefaults into the Workflow field by field
  // (argo-workflows v4.1.6 util.MergeTo: the Workflow's fields win, missing
  // ones come from the defaults), then its GC reads secondsAfterFailure /
  // secondsAfterSuccess BEFORE secondsAfterCompletion (gc_controller ttl()).
  // These are 0026 §5.2's defaults.
  const defaults = { secondsAfterSuccess: 86_400, secondsAfterFailure: 259_200 }
  const merged = { ...defaults, ...wf.spec.ttlStrategy }
  const ttl = (phase: 'Succeeded' | 'Failed' | 'Error') =>
    phase === 'Failed' && merged.secondsAfterFailure !== undefined
      ? merged.secondsAfterFailure
      : phase === 'Succeeded' && merged.secondsAfterSuccess !== undefined
      ? merged.secondsAfterSuccess
      : merged.secondsAfterCompletion
  for (const phase of ['Succeeded', 'Failed', 'Error'] as const) assertEquals(ttl(phase), GAMEDAY_TTL_SECONDS, phase)
})

Deno.test('every step container is non-root, unescalated and sized', () => {
  for (const t of containers(gameDay())) {
    const sc = t.container.securityContext!
    assertEquals(sc.runAsNonRoot, true, t.name)
    assert((sc.runAsUser ?? 0) > 0, `${t.name} runs as root`)
    assertEquals(sc.allowPrivilegeEscalation, false, t.name)
    assertEquals(sc.capabilities?.drop, ['ALL'], t.name)
    assert(t.container.resources?.requests?.memory && t.container.resources?.limits?.memory, `${t.name} is unsized`)
    assertEquals(t.container.env?.find((e) => e.name === 'HOME')?.value, '/tmp', `${t.name}: kubectl needs a writable HOME`)
  }
  // One spec per step: changing one template never changes another.
  const [a, b] = scenarioSteps(gameDay())
  assert(a.container.securityContext !== b.container.securityContext)
})

Deno.test('the application a selector names is stamped on every engine', () => {
  assertEquals(applicationOf('app=checkout'), 'checkout')
  assertEquals(applicationOf(' app.kubernetes.io/name == cart '), 'cart')
  assertEquals(applicationOf('adhar.io/application=shop'), 'shop')
  assertEquals(applicationOf('app.kubernetes.io/instance=shop-1'), 'shop-1')
  assertEquals(applicationOf('tier=web'), undefined) // names no application
  assertEquals(applicationOf('app!=checkout'), undefined)
  assertEquals(applicationOf('app=a,tier=b'), undefined)
  assertEquals(applicationOf('app=-bad-'), undefined) // not a label value
  assertEquals(applicationOf(''), undefined)
  assertEquals(applicationOf(undefined), undefined)

  const engines = (wf: GameDay) => scenarioSteps(wf).map((t) => JSON.parse(t.inputs!.artifacts[0].raw.data))
  for (const e of engines(gameDay())) assertEquals(e.metadata.labels[LABEL_APPLICATION], 'checkout')
  for (const e of engines(gameDay({ target: { ...target, label: 'tier=web' } }))) assertEquals(LABEL_APPLICATION in e.metadata.labels, false)
})

/* ─────────────── the step scripts, run against a stand-in kubectl ─────────────── */

/**
 * A stand-in `kubectl` (plus `date` and `sleep`) on PATH. Behaviour comes from
 * files in its directory: `results` / `states` hold one scripted reply per
 * read of the ChaosResult / the engine's status (the last one repeats) — a
 * reply is what the step's jsonpath prints, `verdict|phase|score|probe
 * verdicts`; `engine.exists`, `get.fail`, `delete.fail`, `create.fail` and
 * `warn` switch the matching behaviour on, and `engine.stuck` names an engine
 * whose deletion times out. Every call is appended to `calls.log`, and the
 * engine argument of every get/patch/delete of a ChaosEngine — exactly as
 * kubectl received it — to `engine-args.log`.
 */
const FAKE_KUBECTL = `#!/bin/sh
echo "kubectl $*" >>"$FAKE/calls.log"
case "$3 $4" in "get chaosengine"|"patch chaosengine"|"delete chaosengine") echo "$5" >>"$FAKE/engine-args.log" ;; esac
[ -f "$FAKE/warn" ] && echo "E1105 memcache.go:265] couldn't get current server API group list: the server is currently unable to handle the request" >&2
next() {  # the n-th scripted line on the n-th call; the last one repeats (shell builtins only: fast)
  n=0; [ -f "$FAKE/$1.n" ] && read -r n <"$FAKE/$1.n"; n=$((n + 1)); echo "$n" >"$FAKE/$1.n"
  i=0; last=
  while IFS= read -r line; do i=$((i + 1)); last=$line; [ "$i" -eq "$n" ] && break; done <"$FAKE/$1"
  printf '%s' "$last"
}
case "$*" in
  *"get chaosengine"*"-o name"*)
    [ -f "$FAKE/get.fail" ] && { echo 'error: You must be logged in to the server (Unauthorized)' >&2; exit 1; }
    [ -f "$FAKE/engine.exists" ] && echo "chaosengine.litmuschaos.io/$5"
    exit 0 ;;
  *"delete chaosresult"*)
    [ -f "$FAKE/delete.fail" ] && { echo 'Error from server (Forbidden): chaosresults is forbidden' >&2; exit 1; }
    exit 0 ;;
  *"create -f"*)
    [ -f "$FAKE/create.fail" ] && { cat "$FAKE/create.fail" >&2; exit 1; }
    echo "chaosengine.litmuschaos.io/created"; exit 0 ;;
  *"get chaosresult"*)
    line=$(next results)
    [ "$line" = NOTFOUND ] && { echo 'Error from server (NotFound): chaosresults.litmuschaos.io not found' >&2; exit 1; }
    printf '%s' "$line"; exit 0 ;;
  *"get chaosengine"*"engineStatus"*) next states; exit 0 ;;
  *"patch chaosengine"*) exit 0 ;;
  *"delete chaosengine"*)
    stuck=; [ -f "$FAKE/engine.stuck" ] && read -r stuck <"$FAKE/engine.stuck"
    [ "$5" = "$stuck" ] && { echo "error: timed out waiting for the condition on chaosengines/$5" >&2; exit 1; }
    exit 0 ;;
esac
echo "unexpected: kubectl $*" >&2
exit 99
`
/** `date +%s`: a clock that moves 100 s per read. */
const FAKE_DATE = `#!/bin/sh
t=1000; [ -f "$FAKE/clock" ] && read -r t <"$FAKE/clock"; echo $((t + 100)) >"$FAKE/clock"; echo "$t"
`
const FAKE_SLEEP = `#!/bin/sh
echo "sleep $*" >>"$FAKE/calls.log"
`

interface Fake {
  results?: string[]
  states?: string[]
  engineExists?: boolean
  getFails?: boolean
  deleteFails?: boolean
  createFails?: string
  warn?: boolean
  /** An engine whose deletion times out (its finalizer is never released). */
  stuckEngine?: string
}

/**
 * Run a step script with the stand-ins (never a real kubectl: they come first
 * on PATH), its termination log redirected into the sandbox. `files` lists
 * what the sandbox holds afterwards.
 */
async function runStep(script: string, fake: Fake = {}) {
  const dir = await Deno.makeTempDir({ prefix: 'gameday-step-' })
  try {
    const put = async (name: string, text: string, exec = false) => {
      await Deno.writeTextFile(`${dir}/${name}`, text)
      if (exec) await Deno.chmod(`${dir}/${name}`, 0o755)
    }
    await put('kubectl', FAKE_KUBECTL, true)
    await put('date', FAKE_DATE, true)
    await put('sleep', FAKE_SLEEP, true)
    await put('results', `${(fake.results ?? ['NOTFOUND']).join('\n')}\n`)
    await put('states', `${(fake.states ?? ['initialized']).join('\n')}\n`)
    if (fake.engineExists) await put('engine.exists', '')
    if (fake.getFails) await put('get.fail', '')
    if (fake.deleteFails) await put('delete.fail', '')
    if (fake.createFails) await put('create.fail', fake.createFails)
    if (fake.warn) await put('warn', '')
    if (fake.stuckEngine) await put('engine.stuck', `${fake.stuckEngine}\n`)
    const out = await new Deno.Command('sh', {
      args: ['-c', script.replace(`tlog='${TERMINATION_LOG}'`, () => `tlog='${dir}/termination-log'`)],
      env: { PATH: `${dir}:/usr/bin:/bin`, FAKE: dir, TMPDIR: dir },
      clearEnv: true,
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    const read = (name: string) => Deno.readTextFile(`${dir}/${name}`).catch(() => '')
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
      message: await read('termination-log'),
      calls: (await read('calls.log')).trim().split('\n').filter(Boolean),
      engineArgs: (await read('engine-args.log')).split('\n').filter(Boolean),
      files: (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name),
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const firstScenario = (over: Partial<GameDayInput> = {}) => scenarioSteps(gameDay(over))[0].container.args[0]

Deno.test('step: a Pass verdict passes, after clearing a stale result and creating the engine', async () => {
  const r = await runStep(firstScenario(), { results: ['NOTFOUND', 'Awaited|Running|Awaited|Awaited', 'Pass|Completed|100|Passed'] })
  assertEquals(r.code, 0, r.stdout + r.stderr)
  assertStringIncludes(r.stdout, 'passed (verdict Pass, phase Completed, probe success 100%)')
  assertEquals(r.message, '')
  const del = r.calls.findIndex((c) => c.includes('delete chaosresult gd-1-pod-delete-pod-delete --ignore-not-found'))
  const create = r.calls.findIndex((c) => c === `kubectl create -f /tmp/gd-1-pod-delete.yaml`)
  assert(del >= 0 && create > del, r.calls.join('\n'))
})

Deno.test('step: a failed hypothesis fails the step, and the reason reaches the termination log', async () => {
  const r = await runStep(firstScenario(), { results: ['Awaited|Running|Awaited|Awaited', 'Fail|Completed_With_Probe_Failure|40|Passed Failed'] })
  assertEquals(r.code, 1)
  assertEquals(r.message, 'the hypothesis did not hold (verdict Fail, phase Completed_With_Probe_Failure, probe success 40%)')
})

Deno.test('step: a verdict ends the wait at once, whichever it is', async () => {
  for (const reply of ['Pass|Completed|100|Passed', 'Fail|Completed|0|Failed', 'Stopped|Stopped|0|Failed', 'Stopped|Stopped|0|Awaited', 'Error|Error|0|N/A']) {
    const r = await runStep(firstScenario(), { results: [reply], states: ['initialized'] })
    assertEquals(r.calls.filter((c) => c.includes('get chaosresult')).length, 1, reply)
    assertEquals(r.calls.filter((c) => c.startsWith('sleep')).length, 0, reply)
    assertEquals(r.code, reply.startsWith('Pass|') ? 0 : 1, reply)
  }
})

Deno.test('step: a stopped or errored experiment is not a pass', async () => {
  // Stopped with no failed probe: someone (or the safety lever) aborted it.
  const stopped = await runStep(firstScenario(), { results: ['Stopped|Stopped|0|Awaited'] })
  assertEquals(stopped.code, 1)
  assertEquals(stopped.message, 'the experiment was stopped before it finished (verdict Stopped, phase Stopped, probe success 0%)')
  const errored = await runStep(firstScenario(), { results: ['Error|Error|0|N/A'] })
  assertEquals(errored.code, 1)
  assertStringIncludes(errored.message, 'the experiment errored')
})

Deno.test('step: a steady-state probe that stopped the fault is a failed hypothesis, not an abort', async () => {
  // The steady-state probe is stopOnFailure: when it fails, Litmus stops the
  // fault early and writes Stopped (litmus-go pkg/result), with the probe Failed.
  const r = await runStep(firstScenario({ steadyState: { url: 'http://checkout.payments/health', statusCode: 200, intervalSeconds: 5 } }), {
    results: ['Awaited|Running|Awaited|Awaited', 'Stopped|Stopped|0|Failed'],
  })
  assertEquals(r.code, 1)
  assertEquals(
    r.message,
    'the hypothesis did not hold: a steady-state probe failed, so Litmus stopped the fault early (verdict Stopped, phase Stopped, probe success 0%)',
  )
})

Deno.test('step: an engine that finishes without a verdict fails after one more read', async () => {
  const r = await runStep(firstScenario(), { results: ['NOTFOUND'], states: ['completed'] })
  assertEquals(r.code, 1)
  assertStringIncludes(r.message, 'the engine finished without writing a verdict')
  assertEquals(r.calls.filter((c) => c.includes('get chaosresult')).length, 2)
})

Deno.test('step: no verdict within the budget fails rather than waiting forever', async () => {
  const r = await runStep(firstScenario(), { results: ['Awaited|Running|Awaited|Awaited'], states: ['initialized'] })
  assertEquals(r.code, 1)
  // Litmus's "Awaited" score is not a number, so it reads as n/a.
  assertEquals(r.message, `no verdict within ${60 + VERDICT_GRACE_SECONDS}s (verdict Awaited, phase Running, probe success n/a)`)
  // The fake clock moves 100 s per read, so the 360 s budget allows four polls.
  assertEquals(r.calls.filter((c) => c.startsWith('sleep')).length, 3)
})

Deno.test('step: an engine of the same name is never adopted, cleared or injected next to', async () => {
  const r = await runStep(firstScenario(), { engineExists: true, results: ['Pass|Completed|100|Passed'] })
  assertEquals(r.code, 2)
  assertStringIncludes(r.message, 'ChaosEngine gd-1-pod-delete already exists')
  assert(!r.calls.some((c) => c.includes('create -f') || c.includes('delete chaosresult')), r.calls.join('\n'))
})

Deno.test('step: a discovery warning on stderr is not mistaken for an existing engine', async () => {
  const r = await runStep(firstScenario(), { warn: true, results: ['Pass|Completed|100|Passed'] })
  assertEquals(r.code, 0, r.stdout)
  assert(r.calls.some((c) => c.includes('create -f')))
})

Deno.test('step: refusals say why and inject nothing', async () => {
  const denied = 'Error from server: admission webhook "validate.kyverno.svc-fail" denied the request: the safety lever is engaged'
  const create = await runStep(firstScenario(), { createFails: denied })
  assertEquals(create.code, 2)
  assertEquals(create.message, `could not create ChaosEngine gd-1-pod-delete: ${denied}`)
  assert(!create.calls.some((c) => c.includes('get chaosresult')), 'nothing to wait for')

  const check = await runStep(firstScenario(), { getFails: true })
  assertEquals(check.code, 2)
  assertStringIncludes(check.message, 'could not check for an existing ChaosEngine gd-1-pod-delete: error: You must be logged in')
  assert(!check.calls.some((c) => c.includes('create -f')))

  const clear = await runStep(firstScenario(), { deleteFails: true })
  assertEquals(clear.code, 2)
  assertStringIncludes(clear.message, 'could not clear an earlier result gd-1-pod-delete-pod-delete')
  assert(!clear.calls.some((c) => c.includes('create -f')), 'a stale result would read as this run’s verdict')
})

Deno.test('step: a name is data, never shell', async () => {
  // Each name breaks a different quoting mistake: naive single quotes, no
  // quotes at all, and command substitution inside double quotes.
  const hostiles = [`gd'; touch "$FAKE/pwned"; echo '`, `gd;touch "$FAKE/pwned";x`, 'gd $(touch "$FAKE/pwned") `touch "$FAKE/pwned"`']
  for (const hostile of hostiles) {
    const wf = buildGameDay({ name: hostile, target, scenarios: ['pod-delete-one'], strategy: 'serial', recoverySeconds: 0 }) as unknown as GameDay
    for (const t of containers(wf)) {
      const r = await runStep(t.container.args[0], { results: ['Pass|Completed|100|Passed'] })
      assertEquals(r.code, 0, `${t.name}: ${r.stdout}${r.stderr}`)
      assertEquals(r.files.includes('pwned'), false, `${t.name}: ${hostile} broke out of its string`)
      // Every engine call received the name whole and unchanged, as one argument.
      assert(r.engineArgs.length > 0, r.calls.join('\n'))
      for (const arg of r.engineArgs) assertEquals(arg, `${hostile}-1-pod-delete`, t.name)
    }
  }
})

const revertOf = (wf: GameDay) => wf.spec.templates.find((t) => t.name === 'revert')! as Template & { container: Container }

Deno.test('the revert step stops, then deletes, every engine — and only those', async () => {
  const r = await runStep(revertOf(gameDay()).container.args[0])
  assertEquals(r.code, 0, r.stdout + r.stderr)
  assertStringIncludes(r.stdout, 'reverted 2 engine(s)')
  assertEquals(r.message, '')
  assertEquals(r.calls, [
    `kubectl -n adhar-system patch chaosengine gd-1-pod-delete --type merge -p {"spec":{"engineState":"stop"}}`,
    `kubectl -n adhar-system patch chaosengine gd-2-pod-network-latency --type merge -p {"spec":{"engineState":"stop"}}`,
    'sleep 15',
    `kubectl -n adhar-system delete chaosengine gd-1-pod-delete --ignore-not-found --timeout=${REVERT_DELETE_TIMEOUT_SECONDS}s`,
    `kubectl -n adhar-system delete chaosengine gd-2-pod-network-latency --ignore-not-found --timeout=${REVERT_DELETE_TIMEOUT_SECONDS}s`,
  ])
})

Deno.test('a revert that cannot remove one engine still removes the rest, then fails naming it', async () => {
  // Litmus holds a finalizer on every engine; while its operator is down a
  // delete never finishes. The revert must not stop at the first such engine
  // (the others would keep their faults), and must not report success.
  const r = await runStep(revertOf(gameDay()).container.args[0], { stuckEngine: 'gd-1-pod-delete' })
  assertEquals(r.code, 1, r.stdout + r.stderr)
  assert(r.calls.some((c) => c.startsWith('kubectl -n adhar-system delete chaosengine gd-2-pod-network-latency ')), r.calls.join('\n'))
  assertEquals(
    r.message,
    'could not remove ChaosEngine(s) gd-1-pod-delete. Litmus still ends each fault when its duration runs out; delete what is left with: kubectl -n adhar-system delete chaosengine gd-1-pod-delete',
  )
  assert(!r.stdout.includes('reverted 2 engine(s)'), 'a half-finished revert is never reported as done')
})

Deno.test('the revert is bounded on its own: Argo exempts an exit handler from the workflow deadline', () => {
  for (const scenarios of [['pod-delete-one'], ['pod-delete-one', 'net-latency', 'node-drain']]) {
    const revert = revertOf(gameDay({ scenarios }))
    const deadline = revert.activeDeadlineSeconds!
    assertEquals(deadline, revertDeadlineSeconds(scenarios.length))
    // Room for the pause and every delete at its timeout — and no more than a few minutes beyond.
    assert(deadline >= 15 + scenarios.length * REVERT_DELETE_TIMEOUT_SECONDS, `${deadline}`)
    assert(deadline <= 15 + scenarios.length * (REVERT_DELETE_TIMEOUT_SECONDS + 60) + 120, `${deadline}`)
    // Every delete waits a bounded time (kubectl's own default is a week).
    const deletes = revert.container.args[0].split('\n').filter((l) => l.trim().startsWith('kubectl') && l.includes(' delete chaosengine '))
    assert(deletes.length > 0)
    for (const l of deletes) assertStringIncludes(l, `--timeout=${REVERT_DELETE_TIMEOUT_SECONDS}s`)
    // Its reason, too, reaches the step's message.
    assertEquals(revert.container.args[0].split(`tlog='${TERMINATION_LOG}'`).length, 2)
  }
})
