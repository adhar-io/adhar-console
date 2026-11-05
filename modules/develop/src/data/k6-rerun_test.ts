import { assertEquals } from 'jsr:@std/assert@^1'
import { kube } from '@adhar/api-clients/k8s'
import { rerunScriptFile } from './k6-summary.ts'
import { rerunTestRun, type TestRun } from './k6.ts'

/**
 * "Run again" copies a run's spec into a new TestRun, including the artefact
 * key its script is mounted from. That key follows the extension of the
 * test's file (`script.ts` for `load.ts`, `script.js` for a legacy
 * `load.js`) and the artefact keeps one script key, so once a test's file
 * changes language and the test is run again from its page, an older run
 * names a key that is gone. The rerun must point at the key the artefact
 * holds now, and change nothing else.
 */

Deno.test('a rerun keeps the key it names while the ConfigMap still holds it', () => {
  assertEquals(rerunScriptFile('script.js', ['gate.env', 'run.sh', 'script.js', 'testrun.json']), 'script.js')
  assertEquals(rerunScriptFile('script.ts', ['script.ts']), 'script.ts')
  // A ConfigMap a person made, holding both: whatever the run named.
  assertEquals(rerunScriptFile('script.js', ['script.js', 'script.ts']), 'script.js')
})

Deno.test('a rerun follows the script to the other extension once the key it names is gone', () => {
  // A legacy load.js renamed to load.ts, then run from its page: the
  // artefact now holds script.ts and an older run still names script.js.
  assertEquals(rerunScriptFile('script.js', ['gate.env', 'run.sh', 'script.ts', 'testrun.json']), 'script.ts')
  // And back.
  assertEquals(rerunScriptFile('script.ts', ['script.js', 'testrun.json']), 'script.js')
  // Any name, not just the artefact's.
  assertEquals(rerunScriptFile('smoke.js', ['smoke.ts']), 'smoke.ts')
})

Deno.test('a rerun changes nothing it cannot account for', () => {
  // The ConfigMap could not be read: no evidence the key is gone.
  assertEquals(rerunScriptFile('script.js', undefined), 'script.js')
  // Neither extension is there: nothing to point at, the run fails as it would have.
  assertEquals(rerunScriptFile('script.js', ['testrun.json']), 'script.js')
  // Only .js and .ts trade places.
  assertEquals(rerunScriptFile('script.mjs', ['script.ts']), 'script.mjs')
  assertEquals(rerunScriptFile('script.JS', ['script.ts']), 'script.JS')
  assertEquals(rerunScriptFile('script', ['script.ts']), 'script')
  assertEquals(rerunScriptFile(undefined, ['script.ts']), undefined)
  assertEquals(rerunScriptFile('', ['script.ts']), '')
})

/* ─────────── the TestRun "Run again" applies ─────────── */

const LEGACY_RUN: TestRun = {
  apiVersion: 'k6.io/v1alpha1',
  kind: 'TestRun',
  metadata: {
    name: 'checkout-load-20261101-101500',
    namespace: 'perf',
    labels: { 'adhar.io/perf-test': 'checkout-load', 'adhar.io/perf-trigger': 'console' },
  },
  spec: {
    parallelism: 2,
    arguments: '--vus 10',
    paused: 'false',
    script: { configMap: { name: 'k6-checkout-load', file: 'script.js' } },
  },
}

/** Run `rerunTestRun` against a gateway whose ConfigMap read answers `data` (or fails); returns what it applied. */
async function rerunAgainst(run: TestRun, data: Record<string, string> | Error): Promise<{ applied: TestRun; asked: string[] }> {
  const get = kube.get
  const apply = kube.apply
  const asked: string[] = []
  let applied: TestRun | undefined
  kube.get = ((gvr: { resource: string }, namespace: string, name: string) => {
    asked.push(`${gvr.resource}/${namespace}/${name}`)
    return data instanceof Error ? Promise.reject(data) : Promise.resolve({ data })
  }) as typeof kube.get
  kube.apply = ((manifest: TestRun) => {
    applied = manifest
    return Promise.resolve(manifest)
  }) as typeof kube.apply
  try {
    await rerunTestRun(run)
  } finally {
    kube.get = get
    kube.apply = apply
  }
  return { applied: applied!, asked }
}

const TYPED = `import http from 'k6/http'\nimport type { Options } from 'k6/options'\nexport const options: Options = { vus: 1, summaryTrendStats: ['p(95)'] }\nexport default function (): void { http.get(__ENV.BASE_URL) }\n`

Deno.test('"Run again" on a run from before its test became TypeScript mounts the script.ts the artefact holds now', async () => {
  const { applied, asked } = await rerunAgainst(LEGACY_RUN, { 'script.ts': TYPED, 'testrun.json': '{}' })
  assertEquals(asked, ['configmaps/perf/k6-checkout-load'])
  assertEquals(applied.metadata.name, 'checkout-load-20261101-101500-r2')
  assertEquals(applied.spec?.script, { configMap: { name: 'k6-checkout-load', file: 'script.ts' } })
  // The rest of the spec is the original's.
  assertEquals([applied.spec?.parallelism, applied.spec?.arguments, applied.spec?.paused], [2, '--vus 10', 'false'])
  // The source read is the re-keyed one: this script sets its own trend
  // stats, so none are added for it.
  const env = ((applied.spec?.runner ?? {}) as { env?: Array<{ name: string }> }).env ?? []
  assertEquals(env.some((e) => e.name === 'K6_SUMMARY_TREND_STATS'), false)
  // The run it was asked to repeat is not touched.
  assertEquals(LEGACY_RUN.spec?.script?.configMap?.file, 'script.js')
})

Deno.test('"Run again" on a legacy load.js run still mounts script.js while the artefact holds it', async () => {
  const { applied } = await rerunAgainst(LEGACY_RUN, { 'script.js': 'export default function () {}\n', 'testrun.json': '{}' })
  assertEquals(applied.spec?.script, { configMap: { name: 'k6-checkout-load', file: 'script.js' } })
  // A script that sets no trend stats of its own gets the console's.
  const env = ((applied.spec?.runner ?? {}) as { env?: Array<{ name: string }> }).env ?? []
  assertEquals(env.some((e) => e.name === 'K6_SUMMARY_TREND_STATS'), true)
})

Deno.test('"Run again" copies the key verbatim when the ConfigMap cannot be read', async () => {
  const { applied } = await rerunAgainst(LEGACY_RUN, Object.assign(new Error('forbidden'), { status: 403 }))
  assertEquals(applied.spec?.script, { configMap: { name: 'k6-checkout-load', file: 'script.js' } })
})
