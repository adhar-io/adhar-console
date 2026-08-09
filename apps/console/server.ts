/**
 * Adhar Console — standalone production server (Deno).
 *
 * The console ships as a client-rendered SPA. This server:
 *   1. serves the built SPA + federated remotes from `dist/` (one origin), and
 *   2. hosts the BFF API — auth (Keycloak OIDC), the backing-tool proxy, and
 *      the Postgres-backed preferences/notifications APIs.
 *
 * All API logic lives in framework-agnostic `Request -> Response` handlers in
 * `packages/auth/server` and `app/server/*`; this file is only the router +
 * static host. No TanStack Start SSR / Nitro — see build-config/host.ts.
 *
 * Resilience: every request is wrapped so a handler throwing never takes down
 * the process; `/healthz` is dependency-free; `/readyz` reports (but does not
 * hard-fail on) optional dependencies; SIGTERM/SIGINT drain gracefully.
 */
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '@adhar-console/utils'
import {
  getDiscovery,
  getServerAuthConfig,
  handleCallback,
  handleLogin,
  handleLogout,
  handleSession,
  isServerAuthConfigured,
} from '@adhar-console/auth/server'
import { proxyToolRequest } from './app/server/proxy.ts'
import { publicToolInfo } from './app/server/tool-registry.ts'
import { handleDocuments, handleNotifications, handlePreferences } from './app/server/api-handlers.ts'
import { handleScaffold } from './app/server/scaffolder.ts'
import { handleK8s } from './app/server/k8s/gateway.ts'
import { handleExec } from './app/server/k8s/exec.ts'
import { handleAi } from './app/server/ai/handlers.ts'

const PORT = Number(env('PORT') ?? 3000)
const HOSTNAME = env('HOST') ?? '0.0.0.0'
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist')

/* ─────────────── static file serving ─────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

function cacheHeader(pathname: string): string {
  // Vite emits content-hashed asset filenames → safe to cache forever.
  if (/\/assets\/|\/mf\/.+\/assets\//.test(pathname) || /\.[0-9a-f]{8,}\.\w+$/.test(pathname)) {
    return 'public, max-age=31536000, immutable'
  }
  return 'no-cache'
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '')
  const filePath = join(DIST, rel)
  // Path-traversal guard: resolved path must stay within DIST.
  if (filePath !== DIST && !filePath.startsWith(DIST + '/')) return null
  try {
    const stat = await Deno.stat(filePath)
    if (!stat.isFile) return null
    const file = await Deno.open(filePath, { read: true })
    return new Response(file.readable, {
      headers: {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': cacheHeader(pathname),
      },
    })
  } catch {
    return null
  }
}

let indexHtmlCache: string | null = null
async function serveIndex(): Promise<Response> {
  try {
    if (indexHtmlCache === null) indexHtmlCache = await Deno.readTextFile(join(DIST, 'index.html'))
    return new Response(indexHtmlCache, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  } catch {
    return new Response('Adhar Console assets not found', { status: 500 })
  }
}

/* ─────────────── health + config ─────────────── */

function healthz(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } })
}

async function readyz(): Promise<Response> {
  const { isDbConfigured, pingDb } = await import('@adhar-console/db')
  const db = isDbConfigured() ? ((await pingDb()) ? 'ok' : 'down') : 'unconfigured'
  const cfg = getServerAuthConfig()
  if (!cfg) {
    return Response.json({ status: 'ready', auth: 'stub', db }, { headers: { 'cache-control': 'no-store' } })
  }
  // OIDC discovery is a REPORTED, non-fatal readiness signal — never a hard gate.
  // It's fetched lazily and cached on first login, and the console serves the SPA
  // + /healthz + BFF without it, so a transient Keycloak/gateway unavailability
  // (or in-cluster split-horizon DNS at startup) must NOT keep the pod out of its
  // Service — that would remove all endpoints and black-hole routing. We probe it
  // with a short timeout and report reachability, but stay ready regardless.
  let keycloak: 'ok' | 'unreachable' = 'ok'
  try {
    await Promise.race([
      getDiscovery(cfg),
      new Promise((_, reject) => setTimeout(() => reject(new Error('discovery timeout')), 3000)),
    ])
  } catch {
    keycloak = 'unreachable'
  }
  return Response.json(
    { status: 'ready', auth: 'keycloak', db, keycloak },
    { headers: { 'cache-control': 'no-store' } },
  )
}

function apiConfig(): Response {
  return Response.json(
    {
      authConfigured: isServerAuthConfigured(),
      builderUrl: env('ADHAR_BUILDER_URL') ?? env('VITE_ADHAR_BUILDER_URL') ?? '',
      tools: publicToolInfo(),
      version: env('ADHAR_CONSOLE_VERSION') ?? '0.2.0',
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/* ─────────────── request router ─────────────── */

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method.toUpperCase()

  // Health/config (dependency-light).
  if (path === '/healthz') return healthz()
  if (path === '/readyz') return readyz()
  if (path === '/api/config') return apiConfig()

  // Auth (OIDC) — all GET, full-page navigations + the session probe.
  if (path === '/api/auth/login') return handleLogin(req)
  if (path === '/api/auth/callback') return handleCallback(req)
  if (path === '/api/auth/logout') return handleLogout(req)
  if (path === '/api/auth/session') return handleSession(req)

  // Pod exec/attach terminal (WebSocket upgrade).
  if (path === '/api/k8s/exec') return handleExec(req)

  // AI assistant (SSE chat + diagnose/explain/generate).
  const ai = path.match(/^\/api\/ai\/(.*)$/)
  if (ai) return handleAi(req, ai[1])

  // Kubernetes gateway: /api/k8s/<apiserver path…> — user-token, streaming,
  // discovery + access-review + apply under /api/k8s/-/…
  const k8s = path.match(/^\/api\/k8s\/(.*)$/)
  if (k8s) return handleK8s(req, k8s[1])

  // Backing-tool proxy: /api/svc/<tool>/<upstream path...>
  const svc = path.match(/^\/api\/svc\/([^/]+)(?:\/(.*))?$/)
  if (svc) return proxyToolRequest(req, svc[1], svc[2] ?? '')

  // Preferences: /api/prefs/<scope>
  const prefs = path.match(/^\/api\/prefs\/([^/]+)$/)
  if (prefs) return handlePreferences(req, prefs[1])

  // Notifications state.
  if (path === '/api/notifications') return handleNotifications(req)

  // Console-owned document store: /api/store/<kind>[/<id>]
  const store = path.match(/^\/api\/store\/([^/]+)(?:\/(.+))?$/)
  if (store) return handleDocuments(req, decodeURIComponent(store[1]), store[2] ? decodeURIComponent(store[2]) : undefined)

  // Component scaffolder (Catalog → Create): real Gitea repo + GitOps.
  if (path === '/api/scaffold') return handleScaffold(req)

  // Unknown API path → 404 JSON (don't fall through to the SPA).
  if (path.startsWith('/api/')) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  // Static assets, else SPA fallback so client-side routing works.
  if (method === 'GET' || method === 'HEAD') {
    const asset = await serveStatic(path)
    if (asset) return asset
    return serveIndex()
  }
  return new Response('Method Not Allowed', { status: 405 })
}

async function handler(req: Request): Promise<Response> {
  try {
    return await route(req)
  } catch (err) {
    // Never let a handler error crash the server. Redact the query string —
    // `/api/auth/callback` carries a single-use `?code=` we must not log.
    const u = new URL(req.url)
    console.error(`[server] unhandled error for ${req.method} ${u.pathname}:`, err)
    return Response.json({ error: 'internal_error' }, { status: 500 })
  }
}

/* ─────────────── boot + graceful shutdown ─────────────── */

const server = Deno.serve({ port: PORT, hostname: HOSTNAME }, handler)

console.log(`adhar-console listening on http://${HOSTNAME}:${PORT}  (dist: ${DIST})`)
console.log(`  auth: ${isServerAuthConfigured() ? 'keycloak' : 'stub (KEYCLOAK_URL/AUTH_* not set)'}`)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  try {
    Deno.addSignalListener(sig, () => {
      console.log(`[server] ${sig} received — draining…`)
      server.shutdown().finally(() => Deno.exit(0))
    })
  } catch {
    /* signal not supported on this platform — ignore */
  }
}
