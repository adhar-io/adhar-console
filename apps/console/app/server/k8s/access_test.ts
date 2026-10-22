import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  accessCheckKey,
  type AccessCheck,
  CONSOLE_API_GROUP,
  CONSOLE_PERMISSIONS,
  consoleCheck,
  consoleResourceCatalogue,
} from '@adhar/auth/server'
import {
  AccessCache,
  describeCheck,
  evaluateBatch,
  handleAccessBatch,
  identityKey,
  MAX_BATCH,
  permissionDenied,
  validateBatch,
} from './access.ts'

const pods: AccessCheck = { verb: 'list', group: '', resource: 'pods', namespace: 'team-a' }

/* ─────────── validation ─────────── */

Deno.test('validateBatch accepts well-formed checks and normalises them', () => {
  const v = validateBatch({
    checks: [
      pods,
      { verb: 'update', group: 'console.adhar.io', resource: 'billing' },
      { verb: 'get', resource: 'pods', subresource: 'log', namespace: 'x', name: 'web-1' },
      { verb: 'bind', group: 'rbac.authorization.k8s.io', resource: 'clusterroles', name: 'system:aggregate-to-view' },
    ],
  })
  assert(v.ok)
  assertEquals(v.checks[1], { verb: 'update', group: 'console.adhar.io', resource: 'billing' })
  assertEquals(v.checks[2].group, '')
})

Deno.test('validateBatch refuses malformed input', () => {
  const cases: unknown[] = [
    null,
    [],
    { checks: 'x' },
    { checks: [] },
    { checks: Array.from({ length: MAX_BATCH + 1 }, () => pods) },
    { checks: [{ resource: 'pods' }] },
    { checks: [{ verb: 'get' }] },
    { checks: [{ verb: 'GET', resource: 'pods' }] },
    { checks: [{ verb: 'get', resource: 'pods', namespace: 'Bad_NS' }] },
    { checks: [{ verb: 'get', resource: 'pods', group: 'a/b' }] },
    { checks: [{ verb: 'get', resource: '../secrets' }] },
    { checks: [{ verb: 'get', resource: 'pods', extra: 'x' }] },
    { checks: [{ verb: 'get', resource: 'pods', name: 3 }] },
    { checks: [{ verb: 'get', resource: 'pods', name: 'a b' }] },
  ]
  for (const c of cases) assertEquals(validateBatch(c).ok, false, JSON.stringify(c)?.slice(0, 80))
})

Deno.test('validateBatch accepts exactly MAX_BATCH checks', () => {
  assert(validateBatch({ checks: Array.from({ length: MAX_BATCH }, () => pods) }).ok)
})

/* ─────────── cache ─────────── */

Deno.test('AccessCache expires entries after the TTL', () => {
  let now = 0
  const c = new AccessCache({ ttlMs: 100, now: () => now })
  c.set('a', true)
  assertEquals(c.get('a'), true)
  now = 99
  assertEquals(c.get('a'), true)
  now = 100
  assertEquals(c.get('a'), undefined)
  assertEquals(c.size, 0)
})

Deno.test('AccessCache evicts the least recently used entry at capacity', () => {
  const c = new AccessCache({ max: 2 })
  c.set('a', true)
  c.set('b', false)
  c.get('a') // a is now most recent
  c.set('c', true)
  assertEquals(c.get('b'), undefined)
  assertEquals(c.get('a'), true)
  assertEquals(c.get('c'), true)
  assertEquals(c.size, 2)
})

Deno.test('identityKey ignores group order but separates users, groups and clusters', () => {
  const u = (groups: string[], username = 'ana') => ({ user: { id: '1', name: 'A', email: 'a@x', username, groups } })
  assertEquals(identityKey(u(['b', 'a'])), identityKey(u(['a', 'b'])))
  assert(identityKey(u(['a'])) !== identityKey(u(['a', 'b'])))
  assert(identityKey(u(['a'])) !== identityKey(u(['a'], 'bob')))
  assert(identityKey(u(['a']), 'east') !== identityKey(u(['a']), 'west'))
})

/* ─────────── evaluation ─────────── */

Deno.test('evaluateBatch dedupes, keeps order and caches definitive answers', async () => {
  const asked: string[] = []
  const review = (c: AccessCheck) => {
    asked.push(accessCheckKey(c))
    return Promise.resolve(c.verb === 'list')
  }
  const cache = new AccessCache()
  const del: AccessCheck = { ...pods, verb: 'delete' }
  const first = await evaluateBatch([pods, del, pods, { ...pods, group: undefined }], review, { cache, scope: 'u1' })
  assertEquals(first, { results: [true, false, true, true], degraded: false })
  assertEquals(asked.length, 2)

  const second = await evaluateBatch([del, pods], review, { cache, scope: 'u1' })
  assertEquals(second.results, [false, true])
  assertEquals(asked.length, 2, 'served from cache')

  // Another identity never reads the first one's answers.
  await evaluateBatch([pods], review, { cache, scope: 'u2' })
  assertEquals(asked.length, 3)
})

Deno.test('evaluateBatch fails closed, flags degraded and does not cache failures', async () => {
  let fail = true
  const review = (c: AccessCheck) =>
    fail && c.resource === 'billing' ? Promise.reject(new Error('unreachable')) : Promise.resolve(true)
  const cache = new AccessCache()
  const billing = consoleCheck(CONSOLE_PERMISSIONS.billingManage)
  const r = await evaluateBatch([pods, billing], review, { cache })
  assertEquals(r, { results: [true, false], degraded: true })
  fail = false
  assertEquals((await evaluateBatch([billing], review, { cache })).results, [true])
})

Deno.test('evaluateBatch never runs more reviews at once than the concurrency bound', async () => {
  let inFlight = 0
  let peak = 0
  const review = async () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 2))
    inFlight--
    return true
  }
  const checks = Array.from({ length: 40 }, (_, i) => ({ verb: 'get', resource: 'pods', name: `p${i}` }))
  const r = await evaluateBatch(checks, review, { concurrency: 8 })
  assertEquals(r.results.length, 40)
  assert(r.results.every(Boolean))
  assertEquals(peak, 8)
})

/* ─────────── HTTP surface ─────────── */

const id = { token: 't', user: { id: '1', name: 'A', email: 'a@x', groups: [] } }

Deno.test('handleAccessBatch rejects bad methods and bodies before any review', async () => {
  const get = await handleAccessBatch(new Request('http://x/api/k8s/-/access-batch'), id)
  assertEquals(get.status, 405)
  const notJson = await handleAccessBatch(new Request('http://x', { method: 'POST', body: '{' }), id)
  assertEquals(notJson.status, 400)
  const bad = await handleAccessBatch(
    new Request('http://x', { method: 'POST', body: JSON.stringify({ checks: [{ verb: 'get' }] }) }),
    id,
  )
  assertEquals(bad.status, 400)
  assertEquals((await bad.json()).error, 'invalid_checks')
})

Deno.test('permissionDenied names the missing RBAC rule, and says 503 when the cluster could not be asked', async () => {
  const denied = permissionDenied(CONSOLE_PERMISSIONS.packagesToggle, false)
  assertEquals(denied.status, 403)
  const body = await denied.json()
  assert(body.detail.includes('update packages.console.adhar.io'), body.detail)
  assertEquals(body.permission, { verb: 'update', group: CONSOLE_API_GROUP, resource: 'packages' })
  assertEquals(permissionDenied(CONSOLE_PERMISSIONS.packagesToggle, true).status, 503)
  assertEquals(describeCheck(pods), 'list pods in namespace team-a')
})

/* ─────────── catalogue ─────────── */

Deno.test('every catalogue permission is a valid, unique console.adhar.io check', () => {
  const perms = Object.values(CONSOLE_PERMISSIONS)
  const v = validateBatch({ checks: perms.map((p) => consoleCheck(p)) })
  assert(v.ok, v.ok ? '' : v.detail)
  assert(perms.every((p) => p.group === CONSOLE_API_GROUP && p.description.length > 10))
  const keys = perms.map((p) => accessCheckKey(consoleCheck(p)))
  assertEquals(new Set(keys).size, keys.length, 'two names for one permission')
  assertEquals(consoleCheck(CONSOLE_PERMISSIONS.resilienceRun, 'shop').namespace, 'shop')
})

Deno.test('the resource catalogue lists each virtual resource once with its verbs', () => {
  const cat = consoleResourceCatalogue()
  const scan = cat.find((r) => r.resource === 'scan-waivers')
  assertEquals(scan?.verbs, ['approve', 'create', 'self-approve'])
  assertEquals(new Set(cat.map((r) => r.resource)).size, cat.length)
})
