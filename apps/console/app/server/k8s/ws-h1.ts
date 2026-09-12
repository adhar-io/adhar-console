import { env } from '@adhar-console/utils'

/**
 * A minimal WebSocket **client** that is pinned to HTTP/1.1.
 *
 * Deno's built-in `new WebSocket()` negotiates HTTP/2 over ALPN when the server
 * offers it. The kube-apiserver offers h2 but does **not** implement RFC 8441
 * (Extended CONNECT), which is what carries WebSockets over HTTP/2 — so the
 * handshake dies at the protocol layer before authentication is even attempted:
 *
 *     NetworkError: failed to connect to WebSocket:
 *     stream error received: unspecific protocol error detected
 *
 * which surfaced in the console as "the exec channel could not be established".
 * Pinning ALPN to `http/1.1` makes the same request succeed. Verified against
 * the live apiserver: over h2 it fails as above; over HTTP/1.1 the identical
 * handshake reaches authorization and answers properly.
 *
 * This is the same hazard the REST gateway already avoids with
 * `Deno.createHttpClient({ http1: true, http2: false })` — but that option is
 * unavailable to `new WebSocket()`, so the socket is built by hand: raw TLS,
 * the RFC 6455 handshake, and just enough framing to bridge the apiserver's
 * binary channel protocol.
 *
 * Deliberately small: exec traffic is binary channel frames plus the occasional
 * ping. Anything it does not need — extensions, permessage-deflate,
 * continuation of text frames — is not implemented rather than half-implemented.
 */

type Conn = Deno.TlsConn | Deno.TcpConn

export interface H1WebSocket {
  /** Resolves once the 101 handshake has completed. */
  readonly opened: Promise<void>
  /** Sub-protocol the server selected, if any. */
  readonly protocol: string
  send(data: ArrayBufferLike | string): void
  close(code?: number, reason?: string): void
  onmessage: ((data: Uint8Array) => void) | null
  onclose: ((code: number, reason: string) => void) | null
  onerror: ((err: Error) => void) | null
}

const enum Op {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa,
}

function randomKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

/**
 * Frame a payload as a masked client frame. RFC 6455 requires every
 * client-to-server frame to be masked; an unmasked one is a protocol error and
 * the apiserver will drop the connection.
 */
function frame(op: Op, payload: Uint8Array): Uint8Array {
  const n = payload.length
  const header = n < 126 ? 2 : n < 65536 ? 4 : 10
  const out = new Uint8Array(header + 4 + n)
  out[0] = 0x80 | op // FIN + opcode
  if (n < 126) {
    out[1] = 0x80 | n
  } else if (n < 65536) {
    out[1] = 0x80 | 126
    new DataView(out.buffer).setUint16(2, n)
  } else {
    out[1] = 0x80 | 127
    new DataView(out.buffer).setBigUint64(2, BigInt(n))
  }
  const mask = crypto.getRandomValues(new Uint8Array(4))
  out.set(mask, header)
  for (let i = 0; i < n; i++) out[header + 4 + i] = payload[i] ^ mask[i & 3]
  return out
}

/** Grow-on-demand read buffer with a cheap `take` for consumed bytes. */
class Buf {
  private data = new Uint8Array(0)
  get length() {
    return this.data.length
  }
  push(chunk: Uint8Array) {
    const next = new Uint8Array(this.data.length + chunk.length)
    next.set(this.data)
    next.set(chunk, this.data.length)
    this.data = next
  }
  peek(): Uint8Array {
    return this.data
  }
  take(n: number): Uint8Array {
    const head = this.data.subarray(0, n)
    this.data = this.data.slice(n)
    return head
  }
  indexOfDoubleCrlf(): number {
    const d = this.data
    for (let i = 3; i < d.length; i++) {
      if (d[i - 3] === 13 && d[i - 2] === 10 && d[i - 1] === 13 && d[i] === 10) return i + 1
    }
    return -1
  }
}

/**
 * Open a WebSocket to `url` over HTTP/1.1.
 *
 * TLS trust comes from `DENO_CERT` when set — the same bundle the REST gateway
 * uses — because a cluster apiserver is normally signed by a private CA that is
 * not in the system store.
 */
export function connectH1WebSocket(url: string, protocols: string[]): H1WebSocket {
  const u = new URL(url)
  const secure = u.protocol === 'wss:'
  const port = u.port ? Number(u.port) : secure ? 443 : 80
  const path = `${u.pathname}${u.search}`

  let conn: Conn | null = null
  let open = false
  let closed = false
  let selected = ''
  const pending: Uint8Array[] = []

  const api: H1WebSocket = {
    opened: Promise.resolve(),
    protocol: '',
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      const bytes = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data as ArrayBuffer)
      const op = typeof data === 'string' ? Op.Text : Op.Binary
      if (!open) {
        pending.push(frame(op, bytes))
        return
      }
      void write(frame(op, bytes))
    },
    close(code = 1000, reason = '') {
      if (closed) return
      closed = true
      const r = new TextEncoder().encode(reason)
      const payload = new Uint8Array(2 + r.length)
      new DataView(payload.buffer).setUint16(0, code)
      payload.set(r, 2)
      void write(frame(Op.Close, payload)).finally(() => {
        try {
          conn?.close()
        } catch { /* already gone */ }
      })
    },
  }

  async function write(bytes: Uint8Array) {
    if (!conn) return
    try {
      let off = 0
      while (off < bytes.length) off += await conn.write(bytes.subarray(off))
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)))
    }
  }

  function fail(err: Error) {
    if (closed) return
    closed = true
    api.onerror?.(err)
    api.onclose?.(1006, err.message)
    try {
      conn?.close()
    } catch { /* already gone */ }
  }

  let resolveOpen: () => void = () => {}
  let rejectOpen: (e: Error) => void = () => {}
  const opened = new Promise<void>((res, rej) => {
    resolveOpen = res
    rejectOpen = rej
  })
  ;(api as { opened: Promise<void> }).opened = opened

  void (async () => {
    try {
      const caPath = env('DENO_CERT')
      const caCerts = caPath ? [await Deno.readTextFile(caPath)] : undefined
      conn = secure
        // ALPN pinned: this is the entire point of this module.
        ? await Deno.connectTls({ hostname: u.hostname, port, alpnProtocols: ['http/1.1'], caCerts })
        : await Deno.connect({ hostname: u.hostname, port })

      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: ${u.hostname}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomKey()}`,
        'Sec-WebSocket-Version: 13',
        ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : []),
        '',
        '',
      ].join('\r\n')
      await write(new TextEncoder().encode(req))

      const buf = new Buf()
      const chunk = new Uint8Array(16 * 1024)

      // ── handshake ──
      let headerEnd = -1
      while (headerEnd < 0) {
        const n = await conn.read(chunk)
        if (n === null) throw new Error('apiserver closed the connection during the handshake')
        buf.push(chunk.subarray(0, n))
        headerEnd = buf.indexOfDoubleCrlf()
      }
      const head = new TextDecoder().decode(buf.take(headerEnd))
      const statusLine = head.split('\r\n')[0] ?? ''
      if (!/^HTTP\/1\.1 101/.test(statusLine)) {
        // Surface the apiserver's own words — a 401/403 here is an RBAC answer,
        // not a transport failure, and the user can act on it.
        throw new Error(`apiserver refused the exec upgrade: ${statusLine.replace('HTTP/1.1 ', '')}`)
      }
      const protoLine = head.split('\r\n').find((l) => /^sec-websocket-protocol:/i.test(l))
      selected = protoLine ? protoLine.split(':')[1].trim() : ''
      ;(api as { protocol: string }).protocol = selected

      open = true
      resolveOpen()
      for (const p of pending.splice(0)) await write(p)

      // ── frame loop ──
      for (;;) {
        // Enough header to know the length?
        while (buf.length < 2) {
          const n = await conn.read(chunk)
          if (n === null) throw new Error('connection closed')
          buf.push(chunk.subarray(0, n))
        }
        const d = buf.peek()
        const op = (d[0] & 0x0f) as Op
        const masked = (d[1] & 0x80) !== 0
        const len0 = d[1] & 0x7f
        let headerLen = 2
        let len = len0
        if (len0 === 126) {
          while (buf.length < 4) {
            const n = await conn.read(chunk)
            if (n === null) throw new Error('connection closed')
            buf.push(chunk.subarray(0, n))
          }
          len = new DataView(buf.peek().buffer, buf.peek().byteOffset).getUint16(2)
          headerLen = 4
        } else if (len0 === 127) {
          while (buf.length < 10) {
            const n = await conn.read(chunk)
            if (n === null) throw new Error('connection closed')
            buf.push(chunk.subarray(0, n))
          }
          len = Number(new DataView(buf.peek().buffer, buf.peek().byteOffset).getBigUint64(2))
          headerLen = 10
        }
        const total = headerLen + (masked ? 4 : 0) + len
        while (buf.length < total) {
          const n = await conn.read(chunk)
          if (n === null) throw new Error('connection closed')
          buf.push(chunk.subarray(0, n))
        }
        const full = buf.take(total)
        let payload = full.subarray(headerLen + (masked ? 4 : 0))
        if (masked) {
          const mask = full.subarray(headerLen, headerLen + 4)
          const copy = new Uint8Array(payload.length)
          for (let i = 0; i < payload.length; i++) copy[i] = payload[i] ^ mask[i & 3]
          payload = copy
        }

        if (op === Op.Close) {
          const code = payload.length >= 2 ? new DataView(payload.buffer, payload.byteOffset).getUint16(0) : 1005
          const reason = payload.length > 2 ? new TextDecoder().decode(payload.subarray(2)) : ''
          closed = true
          api.onclose?.(code, reason)
          try {
            conn.close()
          } catch { /* already gone */ }
          return
        }
        if (op === Op.Ping) {
          await write(frame(Op.Pong, payload))
          continue
        }
        if (op === Op.Pong) continue
        // Binary, text and continuation frames all carry channel bytes; the
        // caller reassembles, exactly as it would from a browser socket.
        api.onmessage?.(payload)
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      if (!open) rejectOpen(err)
      fail(err)
    }
  })()

  return api
}
