import { getServerAuthConfig, getValidSession } from '@adhar-console/auth/server'
import { getTool, type ToolDef } from './tool-registry.ts'

/**
 * Same-origin reverse proxy for backing tools.
 *
 * The browser calls `/api/svc/<tool>/<upstream-path>` with the session cookie;
 * this never carries a bearer token. The server resolves the cookie, looks up
 * the tool, injects the right upstream credential (the user's Keycloak access
 * token for `user` mode, or a service token for `service` mode), and forwards
 * the request. Tokens therefore never reach the browser.
 *
 * Hop-by-hop and identity headers are stripped before forwarding so the client
 * can't smuggle its own `Authorization` or spoof `cookie`.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'content-length',
])

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(extra as Record<string, string>) },
  })
}

async function resolveToken(
  tool: ToolDef,
  request: Request,
): Promise<{ token?: string; refreshedCookie?: string } | { error: Response }> {
  if (tool.authMode === 'none') return {}
  if (tool.authMode === 'service') {
    if (!tool.serviceToken) {
      return { error: json(503, { error: 'tool_service_token_missing' }) }
    }
    return { token: tool.serviceToken }
  }
  // user impersonation
  const cfg = getServerAuthConfig()
  if (!cfg) return { error: json(503, { error: 'auth_not_configured' }) }
  const result = await getValidSession(request, cfg)
  if (!result) return { error: json(401, { error: 'unauthenticated' }) }
  return { token: result.session.accessToken, refreshedCookie: result.refreshedCookie }
}

/**
 * Proxy one request. `tool` is the registry key; `splat` is the remaining
 * upstream path (e.g. `api/v1/orgs/acme/repos`).
 */
export async function proxyToolRequest(
  request: Request,
  tool: string,
  splat: string,
): Promise<Response> {
  const def = getTool(tool)
  if (!def) return json(404, { error: 'unknown_tool', tool })
  if (!def.baseUrl) return json(503, { error: 'tool_not_configured', tool })

  const auth = await resolveToken(def, request)
  if ('error' in auth) return auth.error

  const incoming = new URL(request.url)
  const path = splat ? `/${splat}` : ''
  const upstreamUrl = `${def.baseUrl}${def.stripPrefix ? path.replace(def.stripPrefix, '') : path}${incoming.search}`

  const headers = new Headers()
  for (const [k, v] of request.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v)
  }
  for (const [k, v] of Object.entries(def.headers ?? {})) headers.set(k, v)
  if (auth.token && !def.headers?.['x-api-key']) {
    headers.set('authorization', `Bearer ${auth.token}`)
  }

  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    })
  } catch (e) {
    return json(502, { error: 'upstream_unreachable', detail: e instanceof Error ? e.message : '' })
  }

  // Pass the upstream response through, dropping hop-by-hop headers, and attach
  // a refreshed session cookie if the token was rotated mid-request.
  const respHeaders = new Headers()
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie') {
      respHeaders.set(k, v)
    }
  }
  if (auth.refreshedCookie) respHeaders.append('set-cookie', auth.refreshedCookie)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  })
}
