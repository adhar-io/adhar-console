/**
 * Minimal gRPC server-streaming client over HTTP/2 — one call per connection.
 *
 * Why not @grpc/grpc-js: on Deno 2.1.4 (the console's runtime image) its
 * `node:http2` session never completes the handshake against Hubble Relay (TCP
 * connects, no frames flow), and `fetch` there cannot speak cleartext HTTP/2
 * with prior knowledge. Hubble Relay serves plaintext gRPC in-cluster
 * (`disable-server-tls: true`), so this speaks just enough HTTP/2 itself:
 *
 *   - client preface + SETTINGS (push off, 8 MiB stream window) + a connection
 *     WINDOW_UPDATE, then one HEADERS (HPACK literals, no Huffman, no dynamic
 *     table) and one DATA frame carrying the request with END_STREAM;
 *   - reads frames: DATA → gRPC length-prefixed messages; SETTINGS → ACK;
 *     PING → ACK; HEADERS with END_STREAM (trailers), RST_STREAM and GOAWAY
 *     end the call. Response header blocks are skipped, never decoded — we do
 *     not need them, so we keep no HPACK decoder state;
 *   - returns flow-control credit as messages are consumed, and pings every
 *     30 s so a half-open connection is noticed (no frame for 90 s → closed).
 *
 * TLS (`tls: true`) uses ALPN h2 via `Deno.connectTls`.
 *
 * The frame/HPACK helpers are pure and unit-tested (h2c-grpc_test.ts, which
 * also runs the client against an in-process HTTP/2 stub server).
 */

const PREFACE = new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')

export const FRAME = {
  DATA: 0,
  HEADERS: 1,
  RST_STREAM: 3,
  SETTINGS: 4,
  PING: 6,
  GOAWAY: 7,
  WINDOW_UPDATE: 8,
  CONTINUATION: 9,
} as const

export const FLAG = { END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20 } as const

const STREAM_WINDOW = 8 * 1024 * 1024
const CONN_WINDOW = 16 * 1024 * 1024
/** Return credit once this much has been consumed (half a window). */
const CREDIT_AT = 4 * 1024 * 1024
/** Refuse absurd messages instead of buffering them. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const PING_EVERY_MS = 30_000
const IDLE_TIMEOUT_MS = 90_000

/* ─────────────────────────── frames ─────────────────────────── */

export function frame(type: number, flags: number, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(9 + payload.length)
  const len = payload.length
  out[0] = (len >>> 16) & 0xff
  out[1] = (len >>> 8) & 0xff
  out[2] = len & 0xff
  out[3] = type
  out[4] = flags
  new DataView(out.buffer).setUint32(5, stream & 0x7fffffff)
  out.set(payload, 9)
  return out
}

export interface Frame {
  type: number
  flags: number
  stream: number
  payload: Uint8Array
}

/** Parses complete frames off the front of `buf`; returns them and the unconsumed rest. */
export function parseFrames(buf: Uint8Array): { frames: Frame[]; rest: Uint8Array } {
  const frames: Frame[] = []
  let off = 0
  while (buf.length - off >= 9) {
    const len = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
    if (buf.length - off < 9 + len) break
    const dv = new DataView(buf.buffer, buf.byteOffset + off)
    frames.push({
      type: buf[off + 3],
      flags: buf[off + 4],
      stream: dv.getUint32(5) & 0x7fffffff,
      payload: buf.slice(off + 9, off + 9 + len),
    })
    off += 9 + len
  }
  return { frames, rest: buf.slice(off) }
}

/** DATA payload without padding. */
export function dataPayload(f: Frame): Uint8Array {
  if (!(f.flags & FLAG.PADDED)) return f.payload
  const pad = f.payload[0] ?? 0
  return f.payload.subarray(1, Math.max(1, f.payload.length - pad))
}

export function settingsPayload(entries: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(entries.length * 6)
  const dv = new DataView(out.buffer)
  entries.forEach(([id, v], i) => {
    dv.setUint16(i * 6, id)
    dv.setUint32(i * 6 + 2, v)
  })
  return out
}

export function windowUpdate(stream: number, increment: number): Uint8Array {
  const p = new Uint8Array(4)
  new DataView(p.buffer).setUint32(0, increment & 0x7fffffff)
  return frame(FRAME.WINDOW_UPDATE, 0, stream, p)
}

/* ─────────────────────────── HPACK (encode only) ─────────────────────────── */

/** HPACK integer with an N-bit prefix (RFC 7541 §5.1). */
export function hpackInt(value: number, prefixBits: number, firstByte = 0): number[] {
  const max = (1 << prefixBits) - 1
  if (value < max) return [firstByte | value]
  const out = [firstByte | max]
  let v = value - max
  while (v >= 128) {
    out.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v)
  return out
}

function hpackStr(s: string): number[] {
  const b = new TextEncoder().encode(s)
  return [...hpackInt(b.length, 7, 0), ...b]
}

/** Static-table indexes used below (RFC 7541 Appendix A). */
const IDX = { authority: 1, methodPost: 3, path: 4, schemeHttp: 6, schemeHttps: 7, contentType: 31, userAgent: 58 }

/** The request header block: literals without indexing, no Huffman. */
export function requestHeaderBlock(o: { path: string; authority: string; tls: boolean }): Uint8Array {
  const lit = (idx: number, v: string) => [...hpackInt(idx, 4, 0x00), ...hpackStr(v)]
  const bytes = [
    0x80 | IDX.methodPost,
    0x80 | (o.tls ? IDX.schemeHttps : IDX.schemeHttp),
    ...lit(IDX.path, o.path),
    ...lit(IDX.authority, o.authority),
    ...lit(IDX.contentType, 'application/grpc'),
    // New-name literal: `te: trailers` is required by gRPC servers.
    0x00,
    ...hpackStr('te'),
    ...hpackStr('trailers'),
    ...lit(IDX.userAgent, 'adhar-console-flows/1'),
  ]
  return Uint8Array.from(bytes)
}

/** A gRPC length-prefixed message (uncompressed). */
export function grpcFrame(msg: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + msg.length)
  new DataView(out.buffer).setUint32(1, msg.length)
  out.set(msg, 5)
  return out
}

/**
 * Splits gRPC messages off a byte buffer. Throws on a compressed message (we
 * never advertise an encoding, so a server must not send one) or one larger
 * than `MAX_MESSAGE_BYTES`.
 */
export function parseGrpcMessages(buf: Uint8Array): { messages: Uint8Array[]; rest: Uint8Array } {
  const messages: Uint8Array[] = []
  let off = 0
  while (buf.length - off >= 5) {
    if (buf[off] !== 0) throw new Error('compressed gRPC message not supported')
    const len = new DataView(buf.buffer, buf.byteOffset + off).getUint32(1)
    if (len > MAX_MESSAGE_BYTES) throw new Error(`gRPC message too large (${len} bytes)`)
    if (buf.length - off < 5 + len) break
    messages.push(buf.slice(off + 5, off + 5 + len))
    off += 5 + len
  }
  return { messages, rest: buf.slice(off) }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/* ─────────────────────────── client ─────────────────────────── */

export interface StreamOpts {
  hostname: string
  port: number
  tls?: boolean
  /** e.g. `/observer.Observer/GetFlows` */
  path: string
  message: Uint8Array
  signal: AbortSignal
  onMessage(msg: Uint8Array): void
  /** Called once the server's first frame arrives (the connection is real). */
  onOpen?(): void
  /** Test seam. */
  connect?(o: { hostname: string; port: number; tls: boolean }): Promise<Deno.Conn>
}

export interface StreamEnd {
  reason: 'end' | 'reset' | 'goaway' | 'closed' | 'aborted' | 'idle'
  detail?: string
}

async function defaultConnect(o: { hostname: string; port: number; tls: boolean }): Promise<Deno.Conn> {
  if (o.tls) return await Deno.connectTls({ hostname: o.hostname, port: o.port, alpnProtocols: ['h2'] })
  return await Deno.connect({ hostname: o.hostname, port: o.port })
}

/**
 * Runs one server-streaming call until it ends. Resolves with why it ended;
 * rejects only when the connection could not be made at all.
 */
export async function grpcServerStream(o: StreamOpts): Promise<StreamEnd> {
  const tls = o.tls ?? false
  const conn = await (o.connect ?? defaultConnect)({ hostname: o.hostname, port: o.port, tls })
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      conn.close()
    } catch {
      // already closed
    }
  }
  const onAbort = () => close()
  o.signal.addEventListener('abort', onAbort, { once: true })

  // Writes are serialised so frames never interleave mid-frame.
  let writing: Promise<unknown> = Promise.resolve()
  const write = (b: Uint8Array) => {
    writing = writing.then(async () => {
      if (closed) return
      let off = 0
      while (off < b.length) off += await conn.write(b.subarray(off))
    }).catch(() => close())
    return writing
  }

  let lastFrameAt = Date.now()
  const pinger = setInterval(() => {
    if (Date.now() - lastFrameAt > IDLE_TIMEOUT_MS) {
      end = { reason: 'idle', detail: 'no frames from relay' }
      close()
      return
    }
    void write(frame(FRAME.PING, 0, 0, new Uint8Array(8)))
  }, PING_EVERY_MS)

  let end: StreamEnd = { reason: 'closed' }
  try {
    const authority = `${o.hostname}:${o.port}`
    await write(concat(
      concat(PREFACE, frame(FRAME.SETTINGS, 0, 0, settingsPayload([[0x2, 0], [0x4, STREAM_WINDOW]]))),
      windowUpdate(0, CONN_WINDOW - 65_535),
    ))
    await write(frame(FRAME.HEADERS, FLAG.END_HEADERS, 1, requestHeaderBlock({ path: o.path, authority, tls })))
    await write(frame(FRAME.DATA, FLAG.END_STREAM, 1, grpcFrame(o.message)))

    let buf: Uint8Array = new Uint8Array(0)
    let grpcBuf: Uint8Array = new Uint8Array(0)
    let unacked = 0
    let opened = false
    const chunk = new Uint8Array(64 * 1024)
    outer: for (;;) {
      if (closed) {
        if (o.signal.aborted) end = { reason: 'aborted' }
        break
      }
      let n: number | null
      try {
        n = await conn.read(chunk)
      } catch (e) {
        if (o.signal.aborted) end = { reason: 'aborted' }
        else if (end.reason === 'closed') end = { reason: 'closed', detail: e instanceof Error ? e.message : String(e) }
        break
      }
      if (n === null) break
      lastFrameAt = Date.now()
      buf = concat(buf, chunk.slice(0, n))
      const parsed = parseFrames(buf)
      buf = parsed.rest
      for (const f of parsed.frames) {
        if (!opened) {
          opened = true
          o.onOpen?.()
        }
        switch (f.type) {
          case FRAME.DATA: {
            if (f.stream !== 1) break
            grpcBuf = concat(grpcBuf, dataPayload(f))
            const m = parseGrpcMessages(grpcBuf)
            grpcBuf = m.rest
            for (const msg of m.messages) o.onMessage(msg)
            unacked += f.payload.length
            if (unacked >= CREDIT_AT) {
              void write(concat(windowUpdate(0, unacked), windowUpdate(1, unacked)))
              unacked = 0
            }
            if (f.flags & FLAG.END_STREAM) {
              end = { reason: 'end' }
              break outer
            }
            break
          }
          case FRAME.HEADERS:
            if (f.stream === 1 && f.flags & FLAG.END_STREAM) {
              end = { reason: 'end' }
              break outer
            }
            break
          case FRAME.RST_STREAM:
            if (f.stream === 1) {
              end = { reason: 'reset', detail: `code ${new DataView(f.payload.buffer, f.payload.byteOffset).getUint32(0)}` }
              break outer
            }
            break
          case FRAME.GOAWAY:
            end = { reason: 'goaway' }
            break outer
          case FRAME.SETTINGS:
            if (!(f.flags & FLAG.ACK)) void write(frame(FRAME.SETTINGS, FLAG.ACK, 0))
            break
          case FRAME.PING:
            if (!(f.flags & FLAG.ACK)) void write(frame(FRAME.PING, FLAG.ACK, 0, f.payload))
            break
          default:
            // WINDOW_UPDATE, CONTINUATION (of a header block we skip), PRIORITY, unknown — ignore.
            break
        }
      }
    }
  } finally {
    clearInterval(pinger)
    o.signal.removeEventListener('abort', onAbort)
    // Let queued control frames (SETTINGS/PING ACKs) go out before closing,
    // but never wait on a peer that stopped reading.
    if (!closed) await Promise.race([writing, new Promise((r) => setTimeout(r, 250))])
    close()
  }
  return end
}
