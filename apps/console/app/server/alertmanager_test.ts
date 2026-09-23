import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { levelOf, sourceOf, toNotification } from './alertmanager.ts'

const firing = {
  status: 'firing' as const,
  labels: { alertname: 'AdharNamespaceBudgetExceeded', namespace: 'team-payments', severity: 'critical', adhar_component: 'cost-governance' },
  annotations: { summary: 'team-payments is over its monthly budget', description: 'Projected 130%.' },
  startsAt: '2026-09-22T10:00:00Z',
  fingerprint: 'abc123',
}

Deno.test('a critical firing alert becomes an error-level notification for everyone', () => {
  const n = toNotification(firing)
  assertEquals(n.kind, 'error')
  assertEquals(n.severity, 'critical')
  assertEquals(n.audience, undefined) // platform-wide
  assertStringIncludes(n.title, 'over its monthly budget')
  assertEquals(n.target?.id, 'team-payments')
})

Deno.test('a cost alert files under platform, a policy alert under policy', () => {
  assertEquals(sourceOf(firing), 'platform')
  assertEquals(sourceOf({ labels: { alertname: 'KyvernoPolicyViolation' } }), 'policy')
  assertEquals(sourceOf({ labels: { alertname: 'KubeNodeNotReady' } }), 'system')
})

Deno.test('resolution is a distinct success entry, not an overwrite of the firing one', () => {
  // The regression this guards: keying only on the fingerprint made "resolved"
  // replace "firing", so the timeline lost the fact that anything had fired.
  const resolved = { ...firing, status: 'resolved' as const, endsAt: '2026-09-22T11:00:00Z' }
  const f = toNotification(firing)
  const r = toNotification(resolved)
  assertEquals(r.kind, 'success')
  assertStringIncludes(r.title, 'Resolved:')
  assertEquals(f.key, 'alertmanager:abc123:firing')
  assertEquals(r.key, 'alertmanager:abc123:resolved')
  assertEquals(r.at, '2026-09-22T11:00:00Z')
})

Deno.test('re-delivery of the same firing alert carries the same key so it de-dupes', () => {
  assertEquals(toNotification(firing).key, toNotification({ ...firing, startsAt: '2026-09-22T22:00:00Z' }).key)
})

Deno.test('severity maps warning→high, info→low, unknown→medium', () => {
  assertEquals(levelOf({ status: 'firing', labels: { severity: 'warning' } }).severity, 'high')
  assertEquals(levelOf({ status: 'firing', labels: { severity: 'info' } }).severity, 'low')
  assertEquals(levelOf({ status: 'firing', labels: {} }).severity, 'medium')
})

Deno.test('an alert with no fingerprint still produces a notification, just without a de-dupe key', () => {
  const n = toNotification({ status: 'firing', labels: { alertname: 'X' } })
  assertEquals(n.key, undefined)
  assertEquals(n.title, 'X')
})
