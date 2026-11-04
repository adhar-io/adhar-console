import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  dataPayload,
  FLAG,
  frame,
  FRAME,
  grpcFrame,
  grpcServerStream,
  hpackInt,
  MAX_MESSAGE_BYTES,
  parseFrames,
  parseGrpcMessages,
  requestHeaderBlock,
} from './h2c-grpc.ts'

Deno.test('HPACK integers follow RFC 7541 §C.1', () => {
  assertEquals(hpackInt(10, 5), [10])
  assertEquals(hpackInt(1337, 5), [31, 154, 10])
  assertEquals(hpackInt(42, 8), [42])
  assertEquals(hpackInt(31, 4, 0x00), [0x0f, 0x10])
})

Deno.test('request header block uses static-table names and literal values', () => {
  const b = requestHeaderBlock({ path: '/observer.Observer/GetFlows', authority: 'relay:80', tls: false })
  assertEquals(b[0], 0x83, ':method POST')
  assertEquals(b[1], 0x86, ':scheme http')
  assertEquals(b[2], 0x04, ':path literal, indexed name')
  const text = new TextDecoder().decode(b)
  for (const s of ['/observer.Observer/GetFlows', 'relay:80', 'application/grpc', 'te', 'trailers']) assert(text.includes(s), s)
  assertEquals(requestHeaderBlock({ path: '/', authority: 'a', tls: true })[1], 0x87, ':scheme https')
})

Deno.test('frames round-trip and partial frames stay buffered', () => {
  const a = frame(FRAME.DATA, FLAG.END_STREAM, 1, Uint8Array.from([1, 2, 3]))
  const b = frame(FRAME.PING, 0, 0, new Uint8Array(8))
  const all = new Uint8Array(a.length + b.length)
  all.set(a)
  all.set(b, a.length)
  const { frames, rest } = parseFrames(all.subarray(0, all.length - 3))
  assertEquals(frames.length, 1)
  assertEquals(frames[0].type, FRAME.DATA)
  assertEquals(frames[0].stream, 1)
  assertEquals([...frames[0].payload], [1, 2, 3])
  assertEquals(rest.length, b.length - 3)
})

Deno.test('padded DATA frames are unpadded', () => {
  const f = { type: FRAME.DATA, flags: FLAG.PADDED, stream: 1, payload: Uint8Array.from([2, 9, 8, 0, 0]) }
  assertEquals([...dataPayload(f)], [9, 8])
})

Deno.test('gRPC messages split across chunks; compressed and oversized refused', () => {
  const m1 = grpcFrame(Uint8Array.from([1, 2]))
  const m2 = grpcFrame(Uint8Array.from([3]))
  const both = Uint8Array.from([...m1, ...m2])
  const first = parseGrpcMessages(both.subarray(0, 8))
  assertEquals(first.messages.map((m) => [...m]), [[1, 2]])
  const second = parseGrpcMessages(Uint8Array.from([...first.rest, ...both.subarray(8)]))
  assertEquals(second.messages.map((m) => [...m]), [[3]])
  assertThrows(() => parseGrpcMessages(Uint8Array.from([1, 0, 0, 0, 1, 0])))
  const big = new Uint8Array(5)
  new DataView(big.buffer).setUint32(1, MAX_MESSAGE_BYTES + 1)
  assertThrows(() => parseGrpcMessages(big))
})

/** A tiny HTTP/2 server: answers SETTINGS, streams `messages`, then trailers. */
function stubServer(messages: Uint8Array[], opts: { reset?: boolean; hold?: boolean } = {}) {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const port = (listener.addr as Deno.NetAddr).port
  const received: { preface: boolean; headers: boolean; data: Uint8Array | null; settingsAck: boolean; pingAck: boolean } = {
    preface: false,
    headers: false,
    data: null,
    settingsAck: false,
    pingAck: false,
  }
  const done = (async () => {
    const conn = await listener.accept()
    const buf = new Uint8Array(65_536)
    let acc: Uint8Array = new Uint8Array(0)
    const write = (b: Uint8Array) => conn.write(b)
    await write(frame(FRAME.SETTINGS, 0, 0))
    await write(frame(FRAME.PING, 0, 0, new Uint8Array(8)))
    try {
      for (;;) {
        const n = await conn.read(buf)
        if (n === null) break
        acc = Uint8Array.from([...acc, ...buf.subarray(0, n)])
        if (!received.preface && acc.length >= 24) {
          received.preface = new TextDecoder().decode(acc.subarray(0, 24)) === 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'
          acc = acc.slice(24)
        }
        const { frames, rest } = parseFrames(acc)
        acc = rest
        for (const f of frames) {
          if (f.type === FRAME.HEADERS) received.headers = true
          if (f.type === FRAME.SETTINGS && f.flags & FLAG.ACK) received.settingsAck = true
          if (f.type === FRAME.PING && f.flags & FLAG.ACK) received.pingAck = true
          if (f.type === FRAME.DATA && f.flags & FLAG.END_STREAM) {
            received.data = f.payload
            await write(frame(FRAME.HEADERS, FLAG.END_HEADERS, 1, Uint8Array.from([0x88])))
            if (opts.reset) {
              await write(frame(FRAME.RST_STREAM, 0, 1, Uint8Array.from([0, 0, 0, 8])))
              continue
            }
            // Messages split oddly across DATA frames, one padded.
            const body = Uint8Array.from(messages.flatMap((m) => [...grpcFrame(m)]))
            const mid = Math.floor(body.length / 2)
            await write(frame(FRAME.DATA, 0, 1, body.subarray(0, mid)))
            await write(frame(FRAME.DATA, FLAG.PADDED, 1, Uint8Array.from([2, ...body.subarray(mid), 0, 0])))
            if (!opts.hold) await write(frame(FRAME.HEADERS, FLAG.END_HEADERS | FLAG.END_STREAM, 1, Uint8Array.from([0x88])))
          }
        }
      }
    } catch {
      // client closed
    }
    try {
      conn.close()
    } catch {
      // closed
    }
    listener.close()
  })()
  return { port, received, done }
}

Deno.test('client streams messages from an HTTP/2 server and ends on trailers', async () => {
  const msgs = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4]), new Uint8Array(300).fill(7)]
  const srv = await stubServer(msgs)
  const got: number[][] = []
  let opened = false
  const end = await grpcServerStream({
    hostname: '127.0.0.1',
    port: srv.port,
    path: '/observer.Observer/GetFlows',
    message: Uint8Array.from([9, 9]),
    signal: new AbortController().signal,
    onOpen: () => (opened = true),
    onMessage: (m) => got.push([...m]),
  })
  await srv.done
  assertEquals(end.reason, 'end')
  assert(opened)
  assertEquals(got.length, 3)
  assertEquals(got[0], [1, 2, 3])
  assertEquals(got[2].length, 300)
  assert(srv.received.preface)
  assert(srv.received.headers)
  assert(srv.received.settingsAck)
  assert(srv.received.pingAck)
  assertEquals([...srv.received.data!], [...grpcFrame(Uint8Array.from([9, 9]))])
})

Deno.test('RST_STREAM ends the call with a reason', async () => {
  const srv = await stubServer([], { reset: true })
  const end = await grpcServerStream({
    hostname: '127.0.0.1',
    port: srv.port,
    path: '/x',
    message: new Uint8Array(0),
    signal: new AbortController().signal,
    onMessage: () => {},
  })
  await srv.done
  assertEquals(end.reason, 'reset')
  assertEquals(end.detail, 'code 8')
})

Deno.test('aborting closes a held-open stream', async () => {
  const srv = await stubServer([Uint8Array.from([1])], { hold: true })
  const ac = new AbortController()
  let n = 0
  const p = grpcServerStream({
    hostname: '127.0.0.1',
    port: srv.port,
    path: '/x',
    message: new Uint8Array(0),
    signal: ac.signal,
    onMessage: () => {
      n++
      ac.abort()
    },
  })
  const end = await p
  await srv.done
  assertEquals(n, 1)
  assertEquals(end.reason, 'aborted')
})

Deno.test('connection refused rejects', async () => {
  const l = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const port = (l.addr as Deno.NetAddr).port
  l.close()
  let threw = false
  try {
    await grpcServerStream({ hostname: '127.0.0.1', port, path: '/x', message: new Uint8Array(0), signal: new AbortController().signal, onMessage: () => {} })
  } catch {
    threw = true
  }
  assert(threw)
})
