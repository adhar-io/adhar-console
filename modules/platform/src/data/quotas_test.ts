import { assertEquals } from 'jsr:@std/assert@^1'
import {
  buildLimitRange,
  buildQuota,
  EMPTY_LIMITS,
  limitRangeErrors,
  LIMIT_PRESET,
  nameError,
  pressureOf,
  quantityError,
  quotaLines,
  resourceLabel,
  usagePct,
} from './quotas.ts'

Deno.test('usagePct compares quantities across units', () => {
  assertEquals(usagePct('500m', '2'), 25)
  assertEquals(usagePct('2Gi', '8Gi'), 25)
  assertEquals(usagePct('15', '30'), 50)
  assertEquals(usagePct(undefined, '4'), 0)
  assertEquals(usagePct('1', undefined), null)
  assertEquals(usagePct('1', '0'), 100)
})

Deno.test('pressure thresholds', () => {
  assertEquals(pressureOf(null), 'unbounded')
  assertEquals(pressureOf(10), 'ok')
  assertEquals(pressureOf(70), 'warn')
  assertEquals(pressureOf(95), 'high')
  assertEquals(pressureOf(100), 'full')
})

Deno.test('quotaLines orders by pressure', () => {
  const lines = quotaLines({
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: { name: 'q', namespace: 'dev' },
    status: { hard: { pods: '30', 'requests.cpu': '4' }, used: { pods: '3', 'requests.cpu': '3' } },
  })
  assertEquals(lines.map((l) => l.resource), ['requests.cpu', 'pods'])
  assertEquals(lines[0].pressure, 'warn')
})

Deno.test('resource labels', () => {
  assertEquals(resourceLabel('requests.cpu'), 'CPU requests')
  assertEquals(resourceLabel('count/deployments.apps'), 'deployments (count)')
  assertEquals(resourceLabel('gold.storageclass.storage.k8s.io/requests.storage'), 'Storage · gold')
})

Deno.test('names and quantities validate', () => {
  assertEquals(nameError(''), 'Required.')
  assertEquals(nameError('Team_A') !== undefined, true)
  assertEquals(nameError('team-a'), undefined)
  assertEquals(quantityError('4Gi'), undefined)
  assertEquals(quantityError('four') !== undefined, true)
})

Deno.test('buildQuota drops blank values', () => {
  const q = buildQuota('dev', 'dev-quota', { pods: '10', 'requests.cpu': ' ', 'limits.memory': '8Gi' })
  assertEquals(q.spec.hard, { pods: '10', 'limits.memory': '8Gi' })
  assertEquals('scopes' in q.spec, false)
})

Deno.test('buildLimitRange writes only what is set', () => {
  const lr = buildLimitRange('dev', 'dev-limits', { ...EMPTY_LIMITS, defaultCpu: '500m', pvcMax: '10Gi' })
  assertEquals(lr.spec.limits, [
    { type: 'Container', default: { cpu: '500m' } },
    { type: 'PersistentVolumeClaim', max: { storage: '10Gi' } },
  ])
  assertEquals(buildLimitRange('dev', 'x', EMPTY_LIMITS).spec.limits, [])
})

Deno.test('limit range ordering is enforced', () => {
  assertEquals(limitRangeErrors(LIMIT_PRESET), [])
  const errs = limitRangeErrors({ ...LIMIT_PRESET, defaultRequestCpu: '1', defaultCpu: '500m' })
  assertEquals(errs.length, 1)
  assertEquals(errs[0].startsWith('CPU: default request'), true)
})
