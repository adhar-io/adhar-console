import { assert, assertEquals } from 'jsr:@std/assert'
import {
  buildLogQL,
  detectSpikes,
  EMPTY_SPEC,
  findTraceId,
  isMetricQuery,
  type LogQLSpec,
  parseLogQL,
  stepFor,
  validateSpec,
  volumeQueries,
} from './logql.ts'

const spec = (patch: Partial<LogQLSpec>): LogQLSpec => ({ ...EMPTY_SPEC, ...patch, metric: { ...EMPTY_SPEC.metric, ...patch.metric } })

Deno.test('buildLogQL composes selector, filters, parser, label filters', () => {
  const q = buildLogQL(spec({
    matchers: [{ key: 'namespace', op: '=', value: 'adhar-system' }, { key: 'app', op: '=~', value: 'console|api' }],
    lineFilters: [{ op: '|=', value: 'error' }, { op: '!~', value: 'health(z)?' }],
    parser: 'json',
    labelFilters: [{ key: 'status', op: '>=', value: '500' }, { key: 'path', op: '!=', value: '/healthz' }],
  }))
  assertEquals(
    q,
    '{namespace="adhar-system", app=~`console|api`} |= "error" !~ `health(z)?` | json | status>=500 | path!="/healthz"',
  )
})

Deno.test('buildLogQL wraps metric aggregations', () => {
  const base = { matchers: [{ key: 'namespace', op: '=' as const, value: 'x' }] }
  assertEquals(
    buildLogQL(spec({ ...base, metric: { fn: 'rate', range: '1m', agg: 'sum', by: ['app'] } })),
    'sum by (app) (rate({namespace="x"} [1m]))',
  )
  assertEquals(
    buildLogQL(spec({ ...base, metric: { fn: 'count_over_time', range: '5m', agg: 'topk', by: ['pod'], k: 5 } })),
    'topk(5, sum by (pod) (count_over_time({namespace="x"} [5m])))',
  )
  assertEquals(buildLogQL(spec({ ...base, metric: { fn: 'rate', range: '5m', agg: 'none', by: [] } })), 'rate({namespace="x"} [5m])')
})

Deno.test('parseLogQL round-trips builder output', () => {
  const cases: LogQLSpec[] = [
    spec({ matchers: [{ key: 'namespace', op: '=', value: 'a"b' }], lineFilters: [{ op: '|=', value: 'x' }] }),
    spec({
      matchers: [{ key: 'app', op: '=~', value: '.+' }],
      parser: 'logfmt',
      labelFilters: [{ key: 'duration', op: '>', value: '250ms' }],
      lineFormat: '{{.msg}}',
    }),
    spec({
      matchers: [{ key: 'namespace', op: '=', value: 'x' }],
      parser: 'pattern',
      parserArg: '<ip> - - <_> "<method> <path> <_>" <status>',
      metric: { fn: 'count_over_time', range: '5m', agg: 'sum', by: ['status'], k: 10 },
    }),
  ]
  for (const c of cases) {
    const parsed = parseLogQL(buildLogQL(c))
    assert(parsed, `parse failed for ${buildLogQL(c)}`)
    assertEquals(buildLogQL(parsed), buildLogQL(c))
  }
})

Deno.test('parseLogQL returns null for unsupported constructs', () => {
  assertEquals(parseLogQL('{app="x"} | label_format foo="bar"'), null)
  assertEquals(parseLogQL('sum(rate({app="x"} | unwrap bytes [5m]))'), null)
  assertEquals(parseLogQL('not a query'), null)
})

Deno.test('validateSpec flags empty selectors', () => {
  assertEquals(validateSpec(EMPTY_SPEC).length, 1)
  assertEquals(validateSpec(spec({ matchers: [{ key: 'app', op: '!=', value: 'x' }] })).length, 1)
  assertEquals(validateSpec(spec({ matchers: [{ key: 'app', op: '=', value: 'x' }] })), [])
})

Deno.test('isMetricQuery / volumeQueries', () => {
  assert(isMetricQuery('sum by (app) (rate({a="b"}[5m]))'))
  assert(isMetricQuery('count_over_time({a="b"}[1m])'))
  assert(!isMetricQuery('{a="b"} |= "sum("'))
  assertEquals(volumeQueries('sum(rate({a="b"}[1m]))', 60), null)
  const v = volumeQueries('{a="b"} |= "x"', 60)!
  assertEquals(v.total, 'sum(count_over_time({a="b"} |= "x" [60s]))')
  assert(v.error.includes('|~ `'))
})

Deno.test('stepFor picks friendly steps', () => {
  assertEquals(stepFor(60 * 60_000, 60), 60)
  assertEquals(stepFor(24 * 60 * 60_000, 60), 1800)
  assertEquals(stepFor(5 * 60_000, 60), 5)
})

Deno.test('detectSpikes finds bursts, ignores flat series', () => {
  assertEquals(detectSpikes([2, 3, 2, 3, 2, 3, 2, 3]), [])
  const s = detectSpikes([2, 3, 2, 40, 3, 2, 3, 2])
  assertEquals(s.map((x) => x.index), [3])
  assert(s[0].ratio > 10)
  assertEquals(detectSpikes([0, 0, 0, 3, 0, 0]), []) // below minCount
})

Deno.test('findTraceId reads labels, fields and text', () => {
  const id = '4bf92f3577b34da6a3ce929d0e0e4736'
  assertEquals(findTraceId('x', { trace_id: id }), id)
  assertEquals(findTraceId('x', {}, { traceID: id.toUpperCase() }), id)
  assertEquals(findTraceId(`level=info traceId=${id} msg=ok`), id)
  assertEquals(findTraceId(`traceparent: 00-${id}-00f067aa0ba902b7-01`), id)
  assertEquals(findTraceId('trace_id=00000000000000000000000000000000'), null)
  assertEquals(findTraceId('no trace here'), null)
})
