import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  applySuggestion,
  cursorContext,
  formatValue,
  goldenPresets,
  guessUnit,
  pushHistory,
  referencedMetrics,
  starterFor,
  suggest,
} from './promql-lite.ts'
import { HTTP_SOURCES_V2 } from './golden-signals.ts'

const vocab = { metrics: ['http_requests_total', 'http_request_duration_seconds_bucket', 'up', 'node_load1'], labels: ['job', 'namespace', 'status'], values: ['api', 'apiserver', 'web'] }

Deno.test('cursorContext: metric / function prefix', () => {
  const c = cursorContext('sum(rate(http_re', 16)
  assertEquals(c.where, 'expr')
  assertEquals(c.prefix, 'http_re')
  const s = suggest(c, vocab)
  assertEquals(s[0].text, 'http_requests_total')
  assert(s.some((x) => x.text === 'http_request_duration_seconds_bucket'))
})

Deno.test('cursorContext: label name and value inside braces', () => {
  const t = 'up{jo'
  const c = cursorContext(t, t.length)
  assertEquals(c.where, 'labelName')
  assertEquals(c.metric, 'up')
  assertEquals(suggest(c, vocab)[0].insert, 'job="')
  const t2 = 'up{job="ap'
  const c2 = cursorContext(t2, t2.length)
  assertEquals(c2.where, 'labelValue')
  assertEquals(c2.label, 'job')
  assertEquals(suggest(c2, vocab).map((s) => s.text), ['api', 'apiserver'])
})

Deno.test('cursorContext: grouping and range', () => {
  const t = 'sum by (na'
  assertEquals(cursorContext(t, t.length).where, 'grouping')
  const r = 'rate(up[5'
  const c = cursorContext(r, r.length)
  assertEquals(c.where, 'range')
  assertEquals(suggest(c, vocab)[0].insert, '5m]')
})

Deno.test('functions complete with an opening paren', () => {
  const c = cursorContext('histogram_q', 11)
  const s = suggest(c, vocab)
  assertEquals(s[0].insert, 'histogram_quantile(')
})

Deno.test('applySuggestion replaces the token and swallows its tail', () => {
  const text = 'sum(rate(http_re[5m]))'
  const c = cursorContext(text, 16)
  const out = applySuggestion(text, c, { text: 'http_requests_total', kind: 'metric' }, 16)
  assertEquals(out.text, 'sum(rate(http_requests_total[5m]))')
  assertEquals(out.cursor, 28)
  const t2 = 'up{job="ap"}'
  const c2 = cursorContext(t2, 10)
  assertEquals(applySuggestion(t2, c2, { text: 'api', kind: 'value', insert: 'api"' }, 10).text, 'up{job="api"}')
})

Deno.test('referencedMetrics ignores string contents', () => {
  const known = new Set(['up', 'http_requests_total'])
  assertEquals(referencedMetrics('sum(rate(http_requests_total{job="up"}[5m])) / up', known), ['http_requests_total', 'up'])
})

Deno.test('starterFor by metric type', () => {
  assertEquals(starterFor('http_requests_total', 'counter'), 'sum(rate(http_requests_total[5m]))')
  assertEquals(starterFor('x_bucket', 'histogram'), 'histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))')
  assertEquals(starterFor('node_load1', 'gauge'), 'node_load1')
})

Deno.test('pushHistory dedupes, caps and ignores blanks', () => {
  assertEquals(pushHistory(['a', 'b'], 'b'), ['b', 'a'])
  assertEquals(pushHistory(['a'], '  '), ['a'])
  assertEquals(pushHistory(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'])
})

Deno.test('formatValue / guessUnit', () => {
  assertEquals(formatValue(null, 'ms'), '—')
  assertEquals(formatValue(1500, 'ms'), '1.50 s')
  assertEquals(formatValue(2048, 'bytes'), '2.0 KiB')
  assertEquals(formatValue(0.25, 'cores'), '250m')
  assertEquals(formatValue(12.345, 'percent'), '12.3%')
  assertEquals(guessUnit('100 * sum(rate(a[5m])) / sum(rate(b[5m]))'), 'percent')
  assertEquals(guessUnit('1000 * histogram_quantile(0.9, x)'), 'ms')
  assertEquals(guessUnit('sum(rate(node_network_receive_bytes_total[5m]))'), 'bytes/s')
  assertEquals(guessUnit('sum(rate(http_requests_total[5m]))'), 'rps')
})

Deno.test('goldenPresets include HTTP signals only with a source', () => {
  assert(!goldenPresets(null).some((p) => p.group === 'Golden signals'))
  const p = goldenPresets(HTTP_SOURCES_V2[0])
  assertEquals(p.find((x) => x.label.startsWith('Latency'))!.queries.length, 3)
})
