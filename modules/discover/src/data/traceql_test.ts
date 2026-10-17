import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildTraceQL,
  compareTraces,
  criticalPath,
  EMPTY_FORM,
  normId,
  orderSpans,
  parseSearch,
  parseTagValues,
  parseTrace,
  percentile,
  selfTimes,
  serviceBreakdown,
  type TraceSpan,
} from './traceql.ts'

Deno.test('buildTraceQL composes conditions', () => {
  assertEquals(buildTraceQL(EMPTY_FORM), '{}')
  assertEquals(
    buildTraceQL({
      service: 'api',
      operation: 'GET /users',
      status: 'error',
      kind: 'server',
      minDuration: '250',
      maxDuration: '2s',
      tags: [
        { scope: 'span', key: 'http.status_code', op: '>=', value: '500' },
        { scope: 'resource', key: 'k8s.namespace.name', op: '=', value: 'adhar-system' },
        { scope: 'any', key: 'db.system', op: '=~', value: 'postgres.*' },
        { scope: 'span', key: '', op: '=', value: 'ignored' },
      ],
    }),
    '{ resource.service.name = "api" && name = "GET /users" && status = error && kind = server && duration >= 250ms && duration <= 2s && span.http.status_code >= 500 && resource.k8s.namespace.name = "adhar-system" && .db.system =~ "postgres.*" }',
  )
})

Deno.test('parseSearch reads spanSets and derives error', () => {
  const hits = parseSearch({
    traces: [
      {
        traceID: 'abc',
        rootServiceName: 'api',
        rootTraceName: 'GET /',
        startTimeUnixNano: '1700000000000000000',
        durationMs: 12,
        spanSets: [{ matched: 2, spans: [{ spanID: 's1', startTimeUnixNano: '1700000000000000000', durationNanos: '5000000', attributes: [{ key: 'status', value: { stringValue: 'error' } }] }] }],
      },
      { traceID: 'def' },
      { nope: true },
    ],
  })
  assertEquals(hits.length, 2)
  assertEquals(hits[0].startMs, 1700000000000)
  assertEquals(hits[0].matched, 2)
  assertEquals(hits[0].error, true)
  assertEquals(hits[0].spans[0].durationMs, 5)
  assertEquals(hits[1].durationMs, 0)
  assertEquals(hits[1].error, undefined)
  assertEquals(parseSearch(null), [])
})

Deno.test('parseTagValues handles v1 and v2', () => {
  assertEquals(parseTagValues({ tagValues: ['b', 'a'] }), ['a', 'b'])
  assertEquals(parseTagValues({ tagValues: [{ type: 'string', value: 'x' }] }), ['x'])
  assertEquals(parseTagValues({}), [])
})

Deno.test('normId converts base64 ids to hex', () => {
  assertEquals(normId('AAAAAAAAAAE='), '0000000000000001')
  assertEquals(normId('ABCDEF0123456789'), 'abcdef0123456789')
})

Deno.test('parseTrace reads OTLP v1 batches and v2 trace envelope', () => {
  const batch = {
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }, { key: 'k8s.namespace.name', value: { stringValue: 'ns' } }] },
    scopeSpans: [{
      scope: { name: 'otel-go' },
      spans: [{
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        name: 'GET',
        kind: 'SPAN_KIND_SERVER',
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '1050000000',
        status: { code: 'STATUS_CODE_ERROR', message: 'boom' },
        attributes: [{ key: 'http.status_code', value: { intValue: '500' } }],
        events: [{ timeUnixNano: '1010000000', name: 'exception', attributes: [] }],
      }],
    }],
  }
  for (const body of [{ batches: [batch] }, { trace: { resourceSpans: [batch] } }]) {
    const [s] = parseTrace(body)
    assertEquals(s.serviceName, 'api')
    assertEquals(s.kind, 'server')
    assertEquals(s.status, 'error')
    assertEquals(s.durationMs, 50)
    assertEquals(s.attributes['http.status_code'], '500')
    assertEquals(s.resource['k8s.namespace.name'], 'ns')
    assertEquals(s.events[0].timeMs, 1010)
  }
})

const span = (id: string, parent: string | undefined, start: number, end: number, svc = 'a', status: TraceSpan['status'] = 'ok'): TraceSpan => ({
  spanID: id,
  parentSpanID: parent,
  traceID: 't',
  serviceName: svc,
  name: id,
  kind: 'internal',
  startMs: start,
  endMs: end,
  durationMs: end - start,
  status,
  attributes: {},
  resource: {},
  events: [],
  links: [],
})

//  root 0───────────100
//    a   10────40
//    b      30──────90      (b ends last → on path)
//      c      40──60       (child of b)
//    d   5─20              (parallel, finishes before b starts? no: before 30 → on path between 10 and 30?)
const TREE = [
  span('root', undefined, 0, 100, 'gw'),
  span('a', 'root', 10, 40, 'api'),
  span('b', 'root', 30, 90, 'db', 'error'),
  span('c', 'b', 40, 60, 'db'),
  span('d', 'root', 5, 20, 'cache'),
]

Deno.test('orderSpans is depth-first by start time', () => {
  const o = orderSpans([...TREE].reverse())
  assertEquals(o.map((x) => x.span.spanID), ['root', 'd', 'a', 'b', 'c'])
  assertEquals(o.find((x) => x.span.spanID === 'c')!.depth, 2)
  assertEquals(o.find((x) => x.span.spanID === 'c')!.ancestors, ['root', 'b'])
  // orphan becomes a root
  assertEquals(orderSpans([span('x', 'missing', 0, 1)])[0].depth, 0)
})

Deno.test('criticalPath follows the last-finishing children', () => {
  const { ids, contribution } = criticalPath(TREE)
  assert(ids.has('root'))
  assert(ids.has('b'))
  assert(ids.has('c'))
  assert(ids.has('d')) // finishes at 20, before b starts (30)
  assert(!ids.has('a')) // a ends at 40, after b started — not gating
  // root self: 90→100 (10) + 20→30 (10) + 0→5 (5) = 25
  assertEquals(contribution.get('root'), 25)
  // b: 60→90 (30) + 30→40 (10) = 40; c: 20
  assertEquals(contribution.get('b'), 40)
  assertEquals(contribution.get('c'), 20)
  const total = [...contribution.values()].reduce((a, b) => a + b, 0)
  assertEquals(total, 100)
})

Deno.test('selfTimes / serviceBreakdown', () => {
  const self = selfTimes(TREE)
  // root covered by union [5,20]∪[10,40]∪[30,90] = [5,90] = 85 → self 15
  assertEquals(self.get('root'), 15)
  assertEquals(self.get('b'), 40)
  const br = serviceBreakdown(TREE)
  assertEquals(br[0].service, 'db')
  assertEquals(br[0].selfMs, 60)
  assertEquals(br[0].errors, 1)
})

Deno.test('compareTraces sorts by absolute delta', () => {
  const d = compareTraces([span('q', undefined, 0, 10)], [span('q', undefined, 0, 50), span('r', undefined, 0, 5)])
  assertEquals(d[0].name, 'q')
  assertEquals(d[0].deltaMs, 40)
  assertEquals(d[1].aCount, 0)
})

Deno.test('percentile nearest rank', () => {
  assertEquals(percentile([5, 1, 3, 2, 4], 50), 3)
  assertEquals(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
  assert(Number.isNaN(percentile([], 50)))
})
