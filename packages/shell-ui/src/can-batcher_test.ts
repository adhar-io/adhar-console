import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth'
import type { AccessCheck } from '@adhar/auth'
import {
  AccessUnknownError,
  allAllowed,
  asCheckList,
  canResource,
  clusterForCheck,
  createAccessBatcher,
  MAX_CHECKS_PER_REQUEST,
} from './can-batcher.ts'

/** A batcher whose flush runs only when the test says so, recording each request. */
function harness(answer: (c: AccessCheck) => boolean, opts: { degraded?: boolean; fail?: boolean } = {}) {
  const calls: Array<{ cluster: string | undefined; checks: AccessCheck[] }> = []
  let flush: (() => void) | null = null
  const b = createAccessBatcher(
    (cluster, checks) => {
      calls.push({ cluster, checks })
      if (opts.fail) return Promise.reject(new Error('offline'))
      return Promise.resolve({ results: checks.map(answer), ...(opts.degraded ? { degraded: true } : {}) })
    },
    (f) => (flush = f),
  )
  return { b, calls, tick: () => flush?.() }
}

const pods = canResource({ group: '', resource: 'pods', namespaced: true }, 'delete', { namespace: 'shop', name: 'web' })
const billing = consoleCheck(CONSOLE_PERMISSIONS.billingManage)

Deno.test('checks asked in the same tick share one request per cluster, deduped', async () => {
  const h = harness((c) => c.resource === 'pods')
  const a = h.b.check(undefined, pods)
  const b = h.b.check(undefined, { ...pods }) // same question, new object
  const c = h.b.check(undefined, billing)
  const d = h.b.check('east', billing)
  h.tick()
  assertEquals(await Promise.all([a, b, c, d]), [true, true, false, false])
  assertEquals(h.calls.length, 2)
  assertEquals(h.calls[0].checks.length, 2, 'duplicate check sent once')
  assertEquals(h.calls.map((x) => x.cluster), [undefined, 'east'])
})

Deno.test('a later tick is a new request', async () => {
  const h = harness(() => true)
  const a = h.b.check(undefined, pods)
  h.tick()
  await a
  const b = h.b.check(undefined, billing)
  h.tick()
  await b
  assertEquals(h.calls.length, 2)
})

Deno.test('more than the server cap is split into several requests', async () => {
  const h = harness(() => true)
  const all = Array.from({ length: MAX_CHECKS_PER_REQUEST + 5 }, (_, i) =>
    h.b.check(undefined, { verb: 'get', resource: 'pods', name: `p${i}` }))
  h.tick()
  assert((await Promise.all(all)).every(Boolean))
  assertEquals(h.calls.map((c) => c.checks.length), [MAX_CHECKS_PER_REQUEST, 5])
})

Deno.test('a degraded "no" is unknown (retried), a degraded "yes" still counts', async () => {
  const h = harness((c) => c.resource === 'pods', { degraded: true })
  const yes = h.b.check(undefined, pods)
  const no = h.b.check(undefined, billing)
  h.tick()
  assertEquals(await yes, true)
  await assertRejects(() => no, AccessUnknownError)
})

Deno.test('a failed request rejects every check in it', async () => {
  const h = harness(() => true, { fail: true })
  const a = h.b.check(undefined, pods)
  h.tick()
  await assertRejects(() => a, Error, 'offline')
})

Deno.test('canResource maps GVRs the way the apiserver will ask', () => {
  assertEquals(pods, { verb: 'delete', group: '', resource: 'pods', namespace: 'shop', name: 'web' })
  assertEquals(canResource({ group: 'core', resource: 'pods' }, 'list'), { verb: 'list', group: '', resource: 'pods' })
  // Cluster-scoped kinds have no namespace.
  assertEquals(
    canResource({ group: 'rbac.authorization.k8s.io', resource: 'clusterroles', namespaced: false }, 'get', { namespace: 'x' }),
    { verb: 'get', group: 'rbac.authorization.k8s.io', resource: 'clusterroles' },
  )
  assertEquals(canResource({ group: '', resource: 'pods' }, 'get', { subresource: 'log', namespace: 'a' }).subresource, 'log')
})

Deno.test('all-of semantics hide while loading and on any no', () => {
  assertEquals(allAllowed([true, true]), true)
  assertEquals(allAllowed([true, undefined]), false)
  assertEquals(allAllowed([true, false]), false)
  assertEquals(allAllowed([]), false)
  assertEquals(asCheckList(null), [])
  assertEquals(asCheckList(billing).length, 1)
  assertEquals(asCheckList([billing, pods]).length, 2)
})

Deno.test('catalogue permissions are referenced by name with stable shapes', () => {
  assertEquals(consoleCheck(CONSOLE_PERMISSIONS.resilienceRun, 'shop'), {
    verb: 'create',
    group: 'console.adhar.io',
    resource: 'resilience-runs',
    namespace: 'shop',
  })
})

Deno.test('console permissions are asked of the console cluster; objects of the selected one', () => {
  // Console virtual resources: granted where the console runs, whatever the topbar says.
  assertEquals(clusterForCheck(billing, undefined, 'east'), undefined)
  // Kubernetes objects: the cluster the operator is looking at.
  assertEquals(clusterForCheck(pods, undefined, 'east'), 'east')
  assertEquals(clusterForCheck(pods, undefined, undefined), undefined)
  // An explicit cluster wins for both ('' = the console's own).
  assertEquals(clusterForCheck(billing, 'west', 'east'), 'west')
  assertEquals(clusterForCheck(pods, '', 'east'), undefined)
})

Deno.test('the default window joins checks that arrive on separate timers (retries) into one request', async () => {
  const calls: AccessCheck[][] = []
  const b = createAccessBatcher((_cluster, checks) => {
    calls.push(checks)
    return Promise.resolve({ results: checks.map(() => true) })
  })
  // Two retries firing from two different timers, a millisecond apart.
  const a = new Promise<boolean>((r) => setTimeout(() => r(b.check(undefined, pods)), 0))
  const c = new Promise<boolean>((r) => setTimeout(() => r(b.check(undefined, billing)), 1))
  assertEquals(await Promise.all([a, c]), [true, true])
  assertEquals(calls.length, 1)
  assertEquals(calls[0].length, 2)
})
