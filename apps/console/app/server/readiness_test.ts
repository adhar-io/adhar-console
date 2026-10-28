import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { DB_PING_DEADLINE_MS, dbReadiness } from './readiness.ts'

// The console runs ONE replica behind the Gateway. Whatever /readyz waits on
// decides whether the Gateway has an upstream at all, so the database ping may
// report, but it may never hold the probe.

Deno.test('a database that never answers is reported down inside the deadline', async () => {
  const started = performance.now()
  const hung = () => new Promise<boolean>(() => {})
  assertEquals(await dbReadiness(true, hung, 50), 'down')
  assert(performance.now() - started < 1000, 'the readiness ping outlived its deadline')
})

Deno.test('a failing or refusing database is reported, never thrown', async () => {
  assertEquals(await dbReadiness(true, () => Promise.resolve(false)), 'down')
  assertEquals(await dbReadiness(true, () => Promise.reject(new Error('ECONNREFUSED'))), 'down')
})

Deno.test('a healthy database reads ok, and an unconfigured one is not pinged', async () => {
  assertEquals(await dbReadiness(true, () => Promise.resolve(true)), 'ok')
  let pinged = false
  const ping = () => {
    pinged = true
    return Promise.resolve(true)
  }
  assertEquals(await dbReadiness(false, ping), 'unconfigured')
  assert(!pinged, 'an unconfigured database must not be pinged')
})

Deno.test('the ping plus the 3s discovery probe fit inside the kubelet 5s probe timeout', () => {
  // Kubelet: readinessProbe.timeoutSeconds 5 (adhar-io/adhar, packages/core/
  // adhar-console/manifests/install.yaml). Discovery: withDeadline(…, 3000)
  // in server.ts readyz(), which runs after this ping.
  assert(DB_PING_DEADLINE_MS + 3000 < 5000, `DB_PING_DEADLINE_MS=${DB_PING_DEADLINE_MS} leaves no room in the probe`)
})
