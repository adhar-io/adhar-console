import { audit, originOk, resolveIdentity } from './gateway.ts'
import { env } from '@adhar-console/utils'

/**
 * Pod exec / attach over WebSocket.
 *
 * The kube-apiserver speaks the `v5.channel.k8s.io` binary sub-protocol for
 * exec: every frame is `[channel byte][payload]` (0 stdin · 1 stdout · 2 stderr
 * · 3 error · 4 resize). The browser's terminal speaks the SAME protocol, so
 * this bridge is a transparent binary relay — we only:
 *   1. authenticate the browser via the session cookie (per-user), and
 *   2. inject the user's bearer token to the apiserver as the
 *      `base64url.bearer.authorization.k8s.io.<token>` sub-protocol (browsers
 *      can't set an `Authorization` header on a WebSocket).
 *
 * Deno's `WebSocket` client honours `DENO_CERT`, so the wss connection to the
 * apiserver's self-signed endpoint is trusted the same way `fetch` is.
 */

const CHANNEL_PROTOCOL = 'v5.channel.k8s.io'

function apiServerWss(): string {
  const base = (env('K8S_API_URL') ?? 'https://kubernetes.default.svc').replace(/\/$/, '')
  return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Max stdin buffered before the apiserver socket opens (guards runaway memory). */
const MAX_OUTBOX = 256
/** If the apiserver exec socket hasn't opened in this long, give up. */
const OPEN_TIMEOUT_MS = 15_000

export async function handleExec(req: Request): Promise<Response> {
  const id = await resolveIdentity(req)
  if (!id) return new Response('Unauthorized', { status: 401 })
  // CSRF/clickjacking guard — exec is the most sensitive surface. A cross-origin
  // page must not be able to open a shell with the victim's session cookie.
  if (!originOk(req)) return new Response('Origin not allowed', { status: 403 })
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 })
  }

  const url = new URL(req.url)
  const q = url.searchParams
  const namespace = q.get('namespace')
  const pod = q.get('pod')
  if (!namespace || !pod) return new Response('namespace + pod required', { status: 400 })

  // Build the apiserver exec URL. `command` may repeat.
  const upstream = new URLSearchParams()
  upstream.set('container', q.get('container') ?? '')
  upstream.set('stdin', q.get('stdin') ?? 'true')
  upstream.set('stdout', q.get('stdout') ?? 'true')
  upstream.set('stderr', q.get('stderr') ?? 'true')
  upstream.set('tty', q.get('tty') ?? 'true')
  const cmds = q.getAll('command')
  const command = cmds.length ? cmds : ['/bin/sh', '-c', 'exec /bin/bash 2>/dev/null || exec /bin/sh']
  for (const c of command) upstream.append('command', c)
  const verb = q.get('attach') === 'true' ? 'attach' : 'exec'
  const execUrl =
    `${apiServerWss()}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/${verb}?${upstream}`

  let clientWs: WebSocket
  let response: Response
  try {
    ;({ socket: clientWs, response } = Deno.upgradeWebSocket(req, { protocol: CHANNEL_PROTOCOL }))
  } catch (e) {
    return new Response(`upgrade failed: ${e instanceof Error ? e.message : e}`, { status: 500 })
  }
  // Carry a refreshed session cookie back on the upgrade response.
  if (id.refreshedCookie) response.headers.append('set-cookie', id.refreshedCookie)

  // Audit the exec/attach session start — this opens a shell in a container.
  audit({
    user: id.user.id,
    action: verb,
    namespace,
    pod,
    container: q.get('container') || undefined,
    command: verb === 'exec' ? command.join(' ') : undefined,
  })

  const tokenProto = `base64url.bearer.authorization.k8s.io.${b64url(id.token)}`
  const apiWs = new WebSocket(execUrl, [CHANNEL_PROTOCOL, tokenProto])
  apiWs.binaryType = 'arraybuffer'
  clientWs.binaryType = 'arraybuffer'

  const outbox: Array<string | ArrayBufferLike> = []
  let apiOpen = false

  // Abandon the session if the apiserver socket never opens.
  const openTimer = setTimeout(() => {
    if (!apiOpen) {
      try {
        apiWs.close()
      } catch { /* ignore */ }
      try {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'apiserver exec timeout')
      } catch { /* ignore */ }
    }
  }, OPEN_TIMEOUT_MS)

  apiWs.onopen = () => {
    apiOpen = true
    clearTimeout(openTimer)
    for (const m of outbox) apiWs.send(m as ArrayBuffer)
    outbox.length = 0
  }
  apiWs.onmessage = (e) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(e.data)
  }
  apiWs.onclose = (e) => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(e.code === 1006 ? 1011 : e.code, e.reason)
    } catch {
      /* already closing */
    }
  }
  apiWs.onerror = () => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'apiserver error')
    } catch {
      /* ignore */
    }
  }

  clientWs.onmessage = (e) => {
    const data = e.data as string | ArrayBufferLike
    if (apiOpen && apiWs.readyState === WebSocket.OPEN) apiWs.send(data as ArrayBuffer)
    else if (outbox.length < MAX_OUTBOX) outbox.push(data)
    else {
      // Client is flooding stdin before the shell is up — drop the session.
      try {
        clientWs.close(1013, 'exec buffer overflow')
      } catch { /* ignore */ }
    }
  }
  clientWs.onclose = () => {
    clearTimeout(openTimer)
    try {
      apiWs.close()
    } catch {
      /* ignore */
    }
  }
  clientWs.onerror = () => {
    try {
      apiWs.close()
    } catch {
      /* ignore */
    }
  }

  return response
}
