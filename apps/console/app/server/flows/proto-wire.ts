/**
 * Hubble Observer protobuf codec — hand-written, dependency-free.
 *
 * Only the fields in `protos/observer-min.proto` are read (field numbers are
 * upstream's, unchanged); everything else is skipped, which is how protobuf
 * stays forward compatible. Hand-written rather than generated because the
 * console's runtime image runs `--cached-only --node-modules-dir=none` on
 * Deno 2.1.4, where @grpc/grpc-js never completes its HTTP/2 handshake; a
 * small codec plus `h2c-grpc.ts` keeps the relay stream free of npm deps.
 *
 * Pure and unit-tested (proto-wire_test.ts).
 */

/* ─────────────────────────── reader ─────────────────────────── */

export class PbReader {
  pos: number
  constructor(readonly buf: Uint8Array, start = 0, readonly end = buf.length) {
    this.pos = start
  }

  get done(): boolean {
    return this.pos >= this.end
  }

  /** Varint as a JS number (exact up to 2^53, which covers every field we read). */
  varint(): number {
    let result = 0
    let mul = 1
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('truncated varint')
      const b = this.buf[this.pos++]
      result += (b & 0x7f) * mul
      if (b < 0x80) return result
      mul *= 128
    }
    throw new Error('varint too long')
  }

  /** int32 fields are sign-extended to 10 bytes on the wire. */
  int32(): number {
    // Only the low 32 bits matter; accumulate them with integer ops so the
    // 64-bit sign extension never goes through a lossy float.
    let low = 0
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('truncated varint')
      const b = this.buf[this.pos++]
      if (i < 5) low |= (b & 0x7f) << (7 * i)
      if (b < 0x80) return low | 0
    }
    throw new Error('varint too long')
  }

  tag(): { field: number; wire: number } {
    const t = this.varint()
    return { field: Math.floor(t / 8), wire: t & 7 }
  }

  bytes(): Uint8Array {
    const len = this.varint()
    if (this.pos + len > this.end) throw new Error('truncated bytes')
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  /** A length-delimited sub-message, as a reader over its span. */
  sub(): PbReader {
    const len = this.varint()
    if (this.pos + len > this.end) throw new Error('truncated message')
    const r = new PbReader(this.buf, this.pos, this.pos + len)
    this.pos += len
    return r
  }

  string(): string {
    return decoder.decode(this.bytes())
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint()
        return
      case 1:
        this.pos += 8
        return
      case 2: {
        const len = this.varint()
        this.pos += len
        return
      }
      case 5:
        this.pos += 4
        return
      default:
        throw new Error(`unsupported wire type ${wire}`)
    }
  }
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/* ─────────────────────────── writer ─────────────────────────── */

export class PbWriter {
  #chunks: number[] = []

  varint(v: number): this {
    let n = Math.floor(v)
    while (n >= 0x80) {
      this.#chunks.push((n % 128) | 0x80)
      n = Math.floor(n / 128)
    }
    this.#chunks.push(n)
    return this
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire)
  }

  uint(field: number, v: number): this {
    return v ? this.tag(field, 0).varint(v) : this
  }

  bool(field: number, v: boolean): this {
    return v ? this.tag(field, 0).varint(1) : this
  }

  bytes(field: number, b: Uint8Array): this {
    this.tag(field, 2).varint(b.length)
    for (const x of b) this.#chunks.push(x)
    return this
  }

  string(field: number, s: string): this {
    return this.bytes(field, encoder.encode(s))
  }

  message(field: number, build: (w: PbWriter) => void): this {
    const w = new PbWriter()
    build(w)
    return this.bytes(field, w.finish())
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.#chunks)
  }
}

/* ─────────────────────────── request ─────────────────────────── */

/**
 * Fields the relay sends back. Nested paths keep each flow small and — most
 * importantly — never include `l7.http.headers`, which carry Authorization
 * and cookies verbatim.
 */
export const FLOW_FIELD_MASK = [
  'time',
  'verdict',
  'drop_reason_desc',
  'IP.source',
  'IP.destination',
  'l4',
  'source.identity',
  'source.namespace',
  'source.labels',
  'source.pod_name',
  'source.workloads',
  'destination.identity',
  'destination.namespace',
  'destination.labels',
  'destination.pod_name',
  'destination.workloads',
  'Type',
  'source_names',
  'destination_names',
  'l7.type',
  'l7.latency_ns',
  'l7.http.code',
  'l7.http.method',
  'l7.http.url',
  'l7.http.protocol',
  'l7.dns.query',
  'l7.dns.rcode',
  'l7.dns.qtypes',
  'l7.kafka.error_code',
  'l7.kafka.api_key',
  'l7.kafka.topic',
  'source_service',
  'destination_service',
  'traffic_direction',
  'is_reply',
] as const

export interface GetFlowsRequestOpts {
  follow: boolean
  /** Backfill from this time (ms epoch). Incompatible with `number`. */
  sinceMs?: number
  number?: number
  /** Label filters excluded server-side, e.g. `reserved:health`. */
  excludeLabels?: string[]
  fieldMask?: readonly string[]
}

export function encodeGetFlowsRequest(o: GetFlowsRequestOpts): Uint8Array {
  const w = new PbWriter()
  if (o.number && !o.sinceMs) w.uint(1, o.number)
  w.bool(3, o.follow)
  for (const l of o.excludeLabels ?? []) {
    w.message(5, (f) => f.string(10, l))
    w.message(5, (f) => f.string(11, l))
  }
  if (o.sinceMs) {
    const s = Math.floor(o.sinceMs / 1000)
    const n = Math.floor((o.sinceMs % 1000) * 1e6)
    w.message(7, (t) => t.uint(1, s).uint(2, n))
  }
  const mask = o.fieldMask ?? FLOW_FIELD_MASK
  if (mask.length) w.message(10, (m) => mask.forEach((p) => m.string(1, p)))
  return w.finish()
}

/* ─────────────────────────── response ─────────────────────────── */

export const VERDICT = ['UNKNOWN', 'FORWARDED', 'DROPPED', 'ERROR', 'AUDIT', 'REDIRECTED', 'TRACED', 'TRANSLATED'] as const
export const FLOW_TYPE_L3_L4 = 1
export const FLOW_TYPE_L7 = 2
export const L7_REQUEST = 1
export const L7_RESPONSE = 2

export interface HubbleEndpoint {
  identity: number
  namespace: string
  labels: string[]
  podName: string
  workloads: Array<{ name: string; kind: string }>
}

export interface HubbleL4 {
  proto: 'TCP' | 'UDP' | 'ICMPv4' | 'ICMPv6' | 'SCTP' | ''
  srcPort: number
  dstPort: number
  syn: boolean
  ack: boolean
  fin: boolean
  rst: boolean
}

export interface HubbleL7 {
  type: number
  latencyNs: number
  http?: { code: number; method: string; url: string; protocol: string }
  dns?: { query: string; rcode: number; qtypes: string[] }
  kafka?: { errorCode: number; apiKey: string; topic: string }
}

export interface HubbleFlow {
  timeMs: number
  verdict: number
  dropReason: number
  ipSrc: string
  ipDst: string
  l4: HubbleL4
  source: HubbleEndpoint | null
  destination: HubbleEndpoint | null
  type: number
  sourceNames: string[]
  destinationNames: string[]
  l7: HubbleL7 | null
  sourceService: { name: string; namespace: string } | null
  destinationService: { name: string; namespace: string } | null
  trafficDirection: number
  /** null when the agent could not tell (the BoolValue was absent). */
  isReply: boolean | null
}

export type FlowsResponse =
  | { kind: 'flow'; flow: HubbleFlow }
  | { kind: 'lost'; lost: number }
  | { kind: 'node-status' }
  | { kind: 'other' }

function timestamp(r: PbReader): number {
  let s = 0
  let n = 0
  while (!r.done) {
    const { field, wire } = r.tag()
    if (field === 1 && wire === 0) s = r.varint()
    else if (field === 2 && wire === 0) n = r.int32()
    else r.skip(wire)
  }
  return s * 1000 + Math.floor(n / 1e6)
}

function endpoint(r: PbReader): HubbleEndpoint {
  const ep: HubbleEndpoint = { identity: 0, namespace: '', labels: [], podName: '', workloads: [] }
  while (!r.done) {
    const { field, wire } = r.tag()
    if (field === 2 && wire === 0) ep.identity = r.varint()
    else if (field === 3 && wire === 2) ep.namespace = r.string()
    else if (field === 4 && wire === 2) ep.labels.push(r.string())
    else if (field === 5 && wire === 2) ep.podName = r.string()
    else if (field === 6 && wire === 2) {
      const w = r.sub()
      const wl = { name: '', kind: '' }
      while (!w.done) {
        const t = w.tag()
        if (t.field === 1 && t.wire === 2) wl.name = w.string()
        else if (t.field === 2 && t.wire === 2) wl.kind = w.string()
        else w.skip(t.wire)
      }
      ep.workloads.push(wl)
    } else r.skip(wire)
  }
  return ep
}

function ports(r: PbReader, l4: HubbleL4, withFlags: boolean): void {
  while (!r.done) {
    const { field, wire } = r.tag()
    if (field === 1 && wire === 0) l4.srcPort = r.varint()
    else if (field === 2 && wire === 0) l4.dstPort = r.varint()
    else if (withFlags && field === 3 && wire === 2) {
      const f = r.sub()
      while (!f.done) {
        const t = f.tag()
        if (t.wire !== 0) {
          f.skip(t.wire)
          continue
        }
        const v = f.varint() !== 0
        if (t.field === 1) l4.fin = v
        else if (t.field === 2) l4.syn = v
        else if (t.field === 3) l4.rst = v
        else if (t.field === 5) l4.ack = v
      }
    } else r.skip(wire)
  }
}

function layer4(r: PbReader): HubbleL4 {
  const l4: HubbleL4 = { proto: '', srcPort: 0, dstPort: 0, syn: false, ack: false, fin: false, rst: false }
  while (!r.done) {
    const { field, wire } = r.tag()
    if (wire !== 2) {
      r.skip(wire)
      continue
    }
    const s = r.sub()
    if (field === 1) {
      l4.proto = 'TCP'
      ports(s, l4, true)
    } else if (field === 2) {
      l4.proto = 'UDP'
      ports(s, l4, false)
    } else if (field === 3) l4.proto = 'ICMPv4'
    else if (field === 4) l4.proto = 'ICMPv6'
    else if (field === 5) {
      l4.proto = 'SCTP'
      ports(s, l4, false)
    }
  }
  return l4
}

function service(r: PbReader): { name: string; namespace: string } {
  const s = { name: '', namespace: '' }
  while (!r.done) {
    const { field, wire } = r.tag()
    if (field === 1 && wire === 2) s.name = r.string()
    else if (field === 2 && wire === 2) s.namespace = r.string()
    else r.skip(wire)
  }
  return s
}

function layer7(r: PbReader): HubbleL7 {
  const l7: HubbleL7 = { type: 0, latencyNs: 0 }
  while (!r.done) {
    const { field, wire } = r.tag()
    if (field === 1 && wire === 0) l7.type = r.varint()
    else if (field === 2 && wire === 0) l7.latencyNs = r.varint()
    else if (field === 101 && wire === 2) {
      const h = r.sub()
      const http = { code: 0, method: '', url: '', protocol: '' }
      while (!h.done) {
        const t = h.tag()
        if (t.field === 1 && t.wire === 0) http.code = h.varint()
        else if (t.field === 2 && t.wire === 2) http.method = h.string()
        else if (t.field === 3 && t.wire === 2) http.url = h.string()
        else if (t.field === 4 && t.wire === 2) http.protocol = h.string()
        else h.skip(t.wire) // headers (5) are never requested; skipped if a relay sends them anyway
      }
      l7.http = http
    } else if (field === 100 && wire === 2) {
      const d = r.sub()
      const dns = { query: '', rcode: 0, qtypes: [] as string[] }
      while (!d.done) {
        const t = d.tag()
        if (t.field === 1 && t.wire === 2) dns.query = d.string()
        else if (t.field === 6 && t.wire === 0) dns.rcode = d.varint()
        else if (t.field === 7 && t.wire === 2) dns.qtypes.push(d.string())
        else d.skip(t.wire)
      }
      l7.dns = dns
    } else if (field === 102 && wire === 2) {
      const k = r.sub()
      const kafka = { errorCode: 0, apiKey: '', topic: '' }
      while (!k.done) {
        const t = k.tag()
        if (t.field === 1 && t.wire === 0) kafka.errorCode = k.int32()
        else if (t.field === 3 && t.wire === 2) kafka.apiKey = k.string()
        else if (t.field === 5 && t.wire === 2) kafka.topic = k.string()
        else k.skip(t.wire)
      }
      l7.kafka = kafka
    } else r.skip(wire)
  }
  return l7
}

export function decodeFlow(r: PbReader): HubbleFlow {
  const f: HubbleFlow = {
    timeMs: 0,
    verdict: 0,
    dropReason: 0,
    ipSrc: '',
    ipDst: '',
    l4: { proto: '', srcPort: 0, dstPort: 0, syn: false, ack: false, fin: false, rst: false },
    source: null,
    destination: null,
    type: 0,
    sourceNames: [],
    destinationNames: [],
    l7: null,
    sourceService: null,
    destinationService: null,
    trafficDirection: 0,
    isReply: null,
  }
  while (!r.done) {
    const { field, wire } = r.tag()
    switch (field) {
      case 1:
        if (wire === 2) f.timeMs = timestamp(r.sub())
        else r.skip(wire)
        break
      case 2:
        if (wire === 0) f.verdict = r.varint()
        else r.skip(wire)
        break
      case 5:
        if (wire === 2) {
          const ip = r.sub()
          while (!ip.done) {
            const t = ip.tag()
            if (t.field === 1 && t.wire === 2) f.ipSrc = ip.string()
            else if (t.field === 2 && t.wire === 2) f.ipDst = ip.string()
            else ip.skip(t.wire)
          }
        } else r.skip(wire)
        break
      case 6:
        if (wire === 2) f.l4 = layer4(r.sub())
        else r.skip(wire)
        break
      case 8:
        if (wire === 2) f.source = endpoint(r.sub())
        else r.skip(wire)
        break
      case 9:
        if (wire === 2) f.destination = endpoint(r.sub())
        else r.skip(wire)
        break
      case 10:
        if (wire === 0) f.type = r.varint()
        else r.skip(wire)
        break
      case 13:
        if (wire === 2) f.sourceNames.push(r.string())
        else r.skip(wire)
        break
      case 14:
        if (wire === 2) f.destinationNames.push(r.string())
        else r.skip(wire)
        break
      case 15:
        if (wire === 2) f.l7 = layer7(r.sub())
        else r.skip(wire)
        break
      case 20:
        if (wire === 2) f.sourceService = service(r.sub())
        else r.skip(wire)
        break
      case 21:
        if (wire === 2) f.destinationService = service(r.sub())
        else r.skip(wire)
        break
      case 22:
        if (wire === 0) f.trafficDirection = r.varint()
        else r.skip(wire)
        break
      case 25:
        if (wire === 0) f.dropReason = r.varint()
        else r.skip(wire)
        break
      case 26:
        if (wire === 2) {
          const b = r.sub()
          let v = false
          while (!b.done) {
            const t = b.tag()
            if (t.field === 1 && t.wire === 0) v = b.varint() !== 0
            else b.skip(t.wire)
          }
          f.isReply = v
        } else r.skip(wire)
        break
      default:
        r.skip(wire)
    }
  }
  return f
}

export function decodeGetFlowsResponse(buf: Uint8Array): FlowsResponse {
  const r = new PbReader(buf)
  let out: FlowsResponse = { kind: 'other' }
  while (!r.done) {
    const { field, wire } = r.tag()
    if (field === 1 && wire === 2) out = { kind: 'flow', flow: decodeFlow(r.sub()) }
    else if (field === 2 && wire === 2) {
      r.skip(wire)
      out = { kind: 'node-status' }
    } else if (field === 3 && wire === 2) {
      const l = r.sub()
      let lost = 0
      while (!l.done) {
        const t = l.tag()
        if (t.field === 2 && t.wire === 0) lost = l.varint()
        else l.skip(t.wire)
      }
      out = { kind: 'lost', lost }
    } else r.skip(wire)
  }
  return out
}

/* ─────────────────────────── drop reasons ─────────────────────────── */

const DROP_REASONS: Record<number, string> = {
  130: 'Invalid source MAC',
  131: 'Invalid destination MAC',
  132: 'Invalid source IP',
  133: 'Policy denied',
  134: 'Invalid packet',
  135: 'CT truncated or invalid header',
  136: 'CT missing TCP ACK flag',
  137: 'CT unknown L4 protocol',
  139: 'Unsupported L3 protocol',
  140: 'Missed tail call',
  142: 'Unknown L4 protocol',
  150: 'Unknown L3 target address',
  151: 'Stale or unroutable IP',
  155: 'CT map insertion failed',
  157: 'IP fragmentation not supported',
  158: 'Service backend not found',
  160: 'No tunnel endpoint',
  162: 'EDT rate limit',
  163: 'Unknown connection tracking state',
  164: 'Local host unreachable',
  165: 'No policy configuration',
  169: 'FIB lookup failed',
  171: 'Invalid identity',
  172: 'Unknown sender',
  176: 'Forbidden ICMPv6 message',
  177: 'Denied by LB source range',
  178: 'Socket lookup failed',
  179: 'Socket assign failed',
  180: 'Proxy redirection not supported',
  181: 'Policy deny rule',
  182: 'VLAN filtered',
  189: 'Authentication required',
  194: 'No egress gateway',
  195: 'Unencrypted traffic',
  196: 'TTL exceeded',
  198: 'Rate limited',
  202: 'Host not ready',
  203: 'Endpoint not ready',
}

export function dropReasonName(code: number): string {
  if (!code) return 'Unknown reason'
  return DROP_REASONS[code] ?? `Drop reason ${code}`
}
