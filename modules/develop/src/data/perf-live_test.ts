import { assertEquals } from 'jsr:@std/assert@^1'
import { evalThreshold, fmtBytes, k6LogLevel, liveWindow, logActivity, normaliseMessage, parseLogfmt, runnerPodRegex, stepFor } from './perf-live.ts'
import { V1_FAILING_LOG } from './testdata/k6-v1-runner-log.ts'

const LINES = V1_FAILING_LOG.split('\n').map((text) => ({ text }))

Deno.test('logfmt fields, including escaped quotes', () => {
  const f = parseLogfmt(LINES[0].text)
  assertEquals(f.level, 'warning')
  assertEquals(f.msg, 'Request Failed')
  assertEquals(f.error.startsWith('Get "http://my-service'), true)
})

Deno.test('only k6 log lines have a level; the summary does not', () => {
  assertEquals(k6LogLevel(LINES[0].text), 'warning')
  assertEquals(k6LogLevel('    ✗ \'rate<0.01\' rate=100.00%'), undefined)
  assertEquals(k6LogLevel('time="x" level=error msg="thresholds crossed"'), 'error')
})

Deno.test('failures bucket per second and group by normalised error', () => {
  const a = logActivity(LINES, { bucketSecs: 1 })
  assertEquals(a.totals, { error: 1, warning: 3, info: 0 })
  assertEquals(a.buckets.slice(0, 2), [
    { t: Date.parse('2026-10-24T04:10:50Z'), warning: 2, error: 0 },
    { t: Date.parse('2026-10-24T04:10:51Z'), warning: 1, error: 0 },
  ])
  // Empty seconds between the last warning and the final error are real zeros.
  assertEquals(a.buckets.at(-1), { t: Date.parse('2026-10-24T04:12:35Z'), warning: 0, error: 1 })
  assertEquals(a.groups[0].count, 3)
  assertEquals(a.groups[0].msg, 'Request Failed')
  assertEquals(a.groups[0].detail.includes('<ip>'), true)
})

Deno.test('kube timestamps win over k6 time= and the bucket grows with the span', () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 9, 24, 4, 0, 0) + i * 5000).toISOString(), text: 'time="ignored" level=warning msg="x"' }))
  const a = logActivity(lines)
  assertEquals(a.bucketSecs, 12)
  assertEquals(a.totals.warning, 400)
})

Deno.test('messages normalise IPs, ids and numbers', () => {
  assertEquals(normaliseMessage('dial tcp 10.1.2.3:80: timeout after 30s'), 'dial tcp <ip>: timeout after <n>s')
})

Deno.test('threshold expressions evaluate only against the aggregation they name', () => {
  assertEquals(evalThreshold('p(95)<500', { 'p(95)': 120 }), true)
  assertEquals(evalThreshold("'p(95)<500'", { 'p(95)': 620 }), false)
  assertEquals(evalThreshold('rate<0.01', { 'p(95)': 1 }), undefined)
  assertEquals(evalThreshold('rate>=0.99', { rate: 0.99 }), true)
  assertEquals(evalThreshold('nonsense', { rate: 1 }), undefined)
})

Deno.test('runner regex matches runner pods only, with the run name escaped', () => {
  const re = new RegExp(`^${runnerPodRegex('a.b-1').replace(/\\\\/g, '\\')}$`)
  assertEquals(re.test('a.b-1-2-xyz'), true)
  assertEquals(re.test('a.b-1-initializer-xyz'), false)
  assertEquals(re.test('aXb-1-2-xyz'), false)
})

Deno.test('a live window only moves once per quantum', () => {
  const a = liveWindow(0, undefined, 61_000)
  const b = liveWindow(0, undefined, 74_000)
  assertEquals(a, b)
  assertEquals(liveWindow(undefined, undefined, 1), null)
  assertEquals(liveWindow(0, 30_000, 99_000), { startMs: 0, endMs: 60_000 })
  assertEquals(stepFor(0, 30 * 60_000), 12)
})

Deno.test('bytes', () => {
  assertEquals(fmtBytes(1_900_000), '1.9 MB')
  assertEquals(fmtBytes(512), '512 B')
})
