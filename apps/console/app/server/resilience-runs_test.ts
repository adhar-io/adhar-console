import { assert, assertEquals, assertThrows } from 'jsr:@std/assert'
import { buildGateJob, canRunSuites, dnsSafe, gateJobName, runFromJob, validateRunRequest } from './resilience-runs.ts'

/**
 * A gate run is created as the console's ServiceAccount on behalf of whoever
 * clicked, so the manifest and the role check are the whole safety story.
 */

const CRON = {
  metadata: { name: 'adhar-resilience-runner', uid: 'u-1' },
  spec: {
    jobTemplate: {
      metadata: { labels: { 'app.kubernetes.io/name': 'adhar-resilience-runner' } },
      spec: {
        backoffLimit: 0,
        template: {
          spec: {
            serviceAccountName: 'adhar-resilience-runner',
            containers: [{
              name: 'runner',
              env: [{ name: 'PER_RUN', value: '3' }, { name: 'VERIFY_APP', value: 'stale' }],
            }],
          },
        },
      },
    },
  },
}

const DNS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

Deno.test('the job name is adhar-gate-<app>-<env>-<suffix>', () => {
  assertEquals(gateJobName('shop', 'test', 'ab12c'), 'adhar-gate-shop-test-ab12c')
})

Deno.test('the job name is at most 63 characters and DNS-safe, whatever it is given', () => {
  const cases: Array<[string, string]> = [
    ['a'.repeat(63), 'b'.repeat(63)],
    ['payments-checkout-service-with-a-long-name', 'payments-production-eu-west'],
    ['Shop_API', 'Test.Env'],
    ['x-', '-y'],
    ['---', '***'],
  ]
  for (const [app, env] of cases) {
    const n = gateJobName(app, env, 'zz9yx')
    assert(n.length <= 63, `${n} is ${n.length} long`)
    assert(DNS.test(n), `${n} is not a DNS label`)
    assert(n.startsWith('adhar-gate-'), n)
    assert(n.endsWith('-zz9yx'), n)
    assert(!n.includes('--'), n)
  }
  assertEquals(gateJobName('Shop_API', 'Test.Env', 'q1w2e'), 'adhar-gate-shop-api-test-env-q1w2e')
  assertEquals(dnsSafe('-A__b-'), 'a-b')
})

Deno.test('the job carries the three VERIFY_ env vars, replacing any the template had', () => {
  const job = buildGateJob(CRON, { app: 'shop', namespace: 'shop-test', environment: 'test' }, { suffix: 'abcde', triggeredBy: 'ana@example.com' })
  const env = (job.spec as { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } })
    .template.spec.containers[0].env
  assertEquals(env, [
    { name: 'PER_RUN', value: '3' },
    { name: 'VERIFY_APP', value: 'shop' },
    { name: 'VERIFY_NAMESPACE', value: 'shop-test' },
    { name: 'VERIFY_ENVIRONMENT', value: 'test' },
  ])
  // The CronJob object itself is untouched.
  assertEquals(CRON.spec.jobTemplate.spec.template.spec.containers[0].env.length, 2)
  assertEquals((job.spec as { backoffLimit: number }).backoffLimit, 0)
})

Deno.test('the job is labelled as a console-triggered gate run and owned by the CronJob', () => {
  const job = buildGateJob(CRON, { app: 'shop', namespace: 'shop-test', environment: 'test' }, { suffix: 'abcde', triggeredBy: 'ana' })
  assertEquals(job.metadata.namespace, 'adhar-system')
  assertEquals(job.metadata.name, 'adhar-gate-shop-test-abcde')
  assertEquals(job.metadata.labels['adhar.io/component'], 'scorecards')
  assertEquals(job.metadata.labels['adhar.io/resilience-gate'], 'shop')
  assertEquals(job.metadata.labels['adhar.io/triggered-by'], 'console')
  assertEquals(job.metadata.labels['adhar.io/resilience-namespace'], 'shop-test')
  assertEquals(job.metadata.labels['app.kubernetes.io/name'], 'adhar-resilience-runner')
  assertEquals(job.metadata.annotations['adhar.io/triggered-by-user'], 'ana')
  assertEquals(job.metadata.ownerReferences?.[0].uid, 'u-1')
})

Deno.test('a CronJob without a template is refused, not turned into an empty Job', () => {
  assertThrows(() => buildGateJob({}, { app: 'a', namespace: 'b', environment: 'b' }, { suffix: 'x' }))
  assertThrows(() => buildGateJob({ spec: { jobTemplate: { spec: { template: { spec: { containers: [] } } } } } }, { app: 'a', namespace: 'b', environment: 'b' }, { suffix: 'x' }))
})

Deno.test('requests: every value must be a DNS label; environment defaults to the namespace', () => {
  assertEquals(validateRunRequest({ app: 'shop', namespace: 'test' }), { ok: true, app: 'shop', namespace: 'test', environment: 'test' })
  for (const bad of [null, {}, { app: 'Shop', namespace: 'test' }, { app: 'shop', namespace: 'a/b' }, { app: 'shop', namespace: 'test', environment: 'te st' }]) {
    assertEquals(validateRunRequest(bad).ok, false)
  }
})

Deno.test('only admins, platform engineers and application admins may start a run', () => {
  assertEquals(canRunSuites({ roles: ['platform-engineer'] }), true)
  assertEquals(canRunSuites({ groups: ['/org/Application-Admins'] }), true)
  assertEquals(canRunSuites({ roles: ['developer', 'viewer'] }), false)
  assertEquals(canRunSuites(null), false)
})

Deno.test('a Kargo-started gate is read from its env when it has no namespace label', () => {
  const run = runFromJob({
    metadata: { name: 'adhar-gate-shop-x', labels: { 'adhar.io/resilience-gate': 'shop' }, creationTimestamp: '2026-10-20T00:00:00Z' },
    spec: { template: { spec: { containers: [{ env: [{ name: 'VERIFY_NAMESPACE', value: 'shop-test' }, { name: 'VERIFY_ENVIRONMENT', value: 'test' }] }] } } },
    status: { active: 1 },
  })
  assertEquals(run?.namespace, 'shop-test')
  assertEquals(run?.environment, 'test')
  assertEquals(run?.triggeredBy, undefined)
  assertEquals(run?.startTime, '2026-10-20T00:00:00Z')
  assertEquals(runFromJob({ metadata: { name: 'x' } }), undefined)
})
