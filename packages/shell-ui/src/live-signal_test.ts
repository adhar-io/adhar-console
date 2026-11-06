import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1'
import { QueryClient } from '@tanstack/react-query'
import { applyEvent, fingerprint, nextDelay, objectKey, sameSnapshot, snapshotOf, trailingDelay } from './live-signal.ts'
import { invalidateIfIdle } from './live.ts'

const app = (rv: string, reconciledAt: string, sync = 'Synced') => ({
  metadata: { uid: 'u1', name: 'web', namespace: 'argocd', resourceVersion: rv, managedFields: [{ x: rv }] },
  status: { sync: { status: sync }, reconciledAt, conditions: [{ type: 'Ok', lastProbeTime: reconciledAt }] },
})

Deno.test('fingerprint ignores bookkeeping fields at any depth', () => {
  assertEquals(fingerprint(app('1', 't1')), fingerprint(app('2', 't2')))
  assertNotEquals(fingerprint(app('1', 't1')), fingerprint(app('2', 't2', 'OutOfSync')))
})

Deno.test('fingerprint honours extra ignore keys', () => {
  const r = (ts: number, result: string) => ({ metadata: { name: 'r' }, results: [{ result, timestamp: { seconds: ts } }] })
  assertNotEquals(fingerprint(r(1, 'pass')), fingerprint(r(2, 'pass')))
  assertEquals(fingerprint(r(1, 'pass'), ['timestamp']), fingerprint(r(2, 'pass'), ['timestamp']))
  assertNotEquals(fingerprint(r(1, 'pass'), ['timestamp']), fingerprint(r(1, 'fail'), ['timestamp']))
})

Deno.test('objectKey prefers uid, falls back to namespace/name', () => {
  assertEquals(objectKey({ metadata: { uid: 'x', name: 'a' } }), 'x')
  assertEquals(objectKey({ metadata: { namespace: 'ns', name: 'a' } }), 'ns/a')
})

Deno.test('applyEvent reports only meaningful changes', () => {
  const snap = snapshotOf([app('1', 't1')])
  assert(!applyEvent(snap, 'MODIFIED', app('2', 't2')), 'reconcile-only update is noise')
  assert(applyEvent(snap, 'MODIFIED', app('3', 't3', 'OutOfSync')), 'sync change is real')
  assert(applyEvent(snap, 'ADDED', { metadata: { uid: 'u2', name: 'api' } }))
  assert(applyEvent(snap, 'DELETED', { metadata: { uid: 'u2', name: 'api' } }))
  assert(!applyEvent(snap, 'DELETED', { metadata: { uid: 'gone' } }))
})

Deno.test('a relist resync with no real change is not a change', () => {
  const a = snapshotOf([app('1', 't1')])
  assert(sameSnapshot(a, snapshotOf([app('9', 't9')])))
  assert(!sameSnapshot(a, snapshotOf([app('9', 't9', 'OutOfSync')])))
  assert(!sameSnapshot(a, snapshotOf([])))
})

Deno.test('nextDelay debounces and throttles', () => {
  assertEquals(nextDelay(10_000, 0, 5_000), 250)
  assertEquals(nextDelay(10_000, 9_000, 5_000), 4_000)
  assertEquals(nextDelay(10_000, 9_900, 5_000, 250), 4_900)
})

Deno.test('a trailing debounce waits after the last event, up to the max wait', () => {
  // A lone event, and one arriving while another waits: the full settle time.
  assertEquals(trailingDelay(1000, 1000, 2500, 15000), 2500)
  assertEquals(trailingDelay(5000, 1000, 2500, 15000), 2500)
  // A steady stream cannot postpone the refetch forever.
  assertEquals(trailingDelay(15000, 1000, 2500, 15000), 1000)
  assertEquals(trailingDelay(99000, 1000, 2500, 15000), 0)
})

Deno.test('a change arriving during a fetch is not answered by that fetch', async () => {
  // The cluster at the time of each read. The first read starts before the change.
  let cluster = 'Progressing'
  let release = () => {}
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  const key = ['apps']
  const observer = qc.getQueryCache().build(qc, {
    queryKey: key,
    queryFn: async () => {
      const seen = cluster
      await new Promise<void>((r) => (release = r))
      return seen
    },
  })
  const first = observer.fetch()
  await Promise.resolve()

  cluster = 'Healthy' // the watch event, while that read is in flight
  assertEquals(invalidateIfIdle(qc, [key]), false, 'must not hand this change to the running fetch')
  release()
  await first
  assertEquals(qc.getQueryData(key), 'Progressing')

  // The retry, once it has finished. An active query refetches on invalidation;
  // this one has no observer, so ask for the refetch the hook's query would do.
  assertEquals(invalidateIfIdle(qc, [key]), true)
  assertEquals(qc.getQueryState(key)?.isInvalidated, true)
  const second = qc.refetchQueries({ queryKey: key })
  await Promise.resolve()
  release()
  await second
  assertEquals(qc.getQueryData(key), 'Healthy')
  qc.clear()
})
