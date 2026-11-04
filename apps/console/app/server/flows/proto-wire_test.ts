import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { decodeGetFlowsResponse, dropReasonName, encodeGetFlowsRequest, FLOW_FIELD_MASK, PbReader, PbWriter } from './proto-wire.ts'
import { encodeResponse, pod } from './testing.ts'

Deno.test('varints round-trip, including multi-byte and > 2^32 values', () => {
  for (const v of [0, 1, 127, 128, 300, 16_384, 2 ** 31, 2 ** 40 + 7, 1_793_721_064]) {
    const b = new PbWriter().tag(1, 0).varint(v).finish()
    const r = new PbReader(b)
    assertEquals(r.tag(), { field: 1, wire: 0 })
    assertEquals(r.varint(), v)
  }
})

Deno.test('int32 decodes negative values (10-byte sign extension)', () => {
  // -1 as int32 on the wire: ff ff ff ff ff ff ff ff ff 01
  const r = new PbReader(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))
  assertEquals(r.int32(), -1)
})

Deno.test('truncated input throws instead of reading garbage', () => {
  assertThrows(() => new PbReader(Uint8Array.from([0x80])).varint())
  assertThrows(() => new PbReader(Uint8Array.from([0x05, 0x61])).bytes())
})

Deno.test('GetFlowsRequest encodes follow, since, exclusions and the field mask', () => {
  const b = encodeGetFlowsRequest({ follow: true, sinceMs: 1_700_000_000_250, excludeLabels: ['reserved:health'] })
  const r = new PbReader(b)
  const seen: Record<number, number> = {}
  const paths: string[] = []
  let since = 0
  while (!r.done) {
    const { field, wire } = r.tag()
    seen[field] = (seen[field] ?? 0) + 1
    if (field === 3) assertEquals(r.varint(), 1)
    else if (field === 7) {
      const t = r.sub()
      t.tag()
      since = t.varint() * 1000
      t.tag()
      since += t.varint() / 1e6
    } else if (field === 10) {
      const m = r.sub()
      while (!m.done) {
        m.tag()
        paths.push(m.string())
      }
    } else r.skip(wire)
  }
  assertEquals(seen[5], 2, 'source and destination exclusion filters')
  assertEquals(seen[1], undefined, '`number` is omitted when `since` is set')
  assertEquals(since, 1_700_000_000_250)
  assertEquals(paths, [...FLOW_FIELD_MASK])
})

Deno.test('the field mask never asks for HTTP headers', () => {
  assert(!FLOW_FIELD_MASK.some((p) => p.includes('headers')))
  assert(!FLOW_FIELD_MASK.includes('l7' as never))
  assert(!FLOW_FIELD_MASK.includes('l7.http' as never))
})

Deno.test('decodes an L7 HTTP response flow end to end', () => {
  const msg = encodeResponse({
    timeMs: 1_793_721_086_731,
    ipSrc: '10.244.3.199',
    ipDst: '10.244.7.64',
    tcp: { sport: 8080, dport: 51_234 },
    src: pod('shop', 'cart-6b7c9d8f4-x2x9k', 'cart'),
    dst: pod('shop', 'web-7d9f8c6b5-k2m4n', 'web'),
    l7: { type: 2, latencyNs: 12_500_000, http: { code: 503, method: 'POST', url: 'http://cart/api/checkout?token=secret', headers: [['Authorization', 'Basic abc']] } },
    isReply: true,
  })
  const r = decodeGetFlowsResponse(msg)
  assert(r.kind === 'flow')
  const f = r.flow
  assertEquals(f.timeMs, 1_793_721_086_731)
  assertEquals(f.ipSrc, '10.244.3.199')
  assertEquals(f.l4, { proto: 'TCP', srcPort: 8080, dstPort: 51_234, syn: false, ack: false, fin: false, rst: false })
  assertEquals(f.source?.namespace, 'shop')
  assertEquals(f.source?.workloads, [{ name: 'cart-6b7c9d8f4', kind: 'ReplicaSet' }])
  assertEquals(f.type, 2)
  assertEquals(f.l7?.type, 2)
  assertEquals(f.l7?.latencyNs, 12_500_000)
  assertEquals(f.l7?.http, { code: 503, method: 'POST', url: 'http://cart/api/checkout?token=secret', protocol: 'HTTP/1.1' })
  assertEquals(f.isReply, true)
  // Headers a relay sends anyway are skipped, never surfaced.
  assert(!JSON.stringify(f).includes('Authorization'))
})

Deno.test('decodes TCP flags, DNS, Kafka, drops and services', () => {
  const syn = decodeGetFlowsResponse(encodeResponse({ timeMs: 1000, tcp: { sport: 40_000, dport: 5432, syn: true } }))
  assert(syn.kind === 'flow' && syn.flow.l4.syn && !syn.flow.l4.ack)
  const dns = decodeGetFlowsResponse(encodeResponse({ timeMs: 1000, udp: { sport: 53, dport: 33_000 }, l7: { type: 2, dns: { query: 'api.example.com.', rcode: 2 } } }))
  assert(dns.kind === 'flow')
  assertEquals(dns.flow.l7?.dns, { query: 'api.example.com.', rcode: 2, qtypes: [] })
  const kafka = decodeGetFlowsResponse(encodeResponse({ timeMs: 1000, l7: { type: 2, kafka: { errorCode: 3, apiKey: 'produce', topic: 'orders' } } }))
  assert(kafka.kind === 'flow')
  assertEquals(kafka.flow.l7?.kafka, { errorCode: 3, apiKey: 'produce', topic: 'orders' })
  const drop = decodeGetFlowsResponse(encodeResponse({ timeMs: 1000, verdict: 2, dropReason: 133, dstService: { name: 'db', namespace: 'shop' } }))
  assert(drop.kind === 'flow')
  assertEquals(drop.flow.verdict, 2)
  assertEquals(dropReasonName(drop.flow.dropReason), 'Policy denied')
  assertEquals(drop.flow.destinationService, { name: 'db', namespace: 'shop' })
})

Deno.test('lost-events and node-status responses are recognised', () => {
  const lost = new PbWriter().message(3, (l) => l.uint(1, 1).uint(2, 42)).finish()
  assertEquals(decodeGetFlowsResponse(lost), { kind: 'lost', lost: 42 })
  const status = new PbWriter().message(2, (n) => n.uint(1, 1)).finish()
  assertEquals(decodeGetFlowsResponse(status), { kind: 'node-status' })
})

Deno.test('unknown fields of every wire type are skipped', () => {
  const w = new PbWriter()
  w.tag(999, 0).varint(5)
  w.tag(998, 1)
  const fixed64 = [1, 2, 3, 4, 5, 6, 7, 8]
  const extra = new PbWriter().string(1, 'x').finish()
  const b = Uint8Array.from([...w.finish(), ...fixed64, ...new PbWriter().bytes(997, extra).finish(), ...new PbWriter().tag(996, 5).finish(), 1, 2, 3, 4])
  assertEquals(decodeGetFlowsResponse(b), { kind: 'other' })
})

Deno.test('drop reason names fall back to the code', () => {
  assertEquals(dropReasonName(0), 'Unknown reason')
  assertEquals(dropReasonName(181), 'Policy deny rule')
  assertEquals(dropReasonName(9999), 'Drop reason 9999')
})
