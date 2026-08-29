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
import { handleListTemplates } from './app/server/templates.ts'
import { handleWorkspace } from './app/server/workspace/handlers.ts'
import { handleBilling } from './app/server/billing/handlers.ts'
import { handleOrganizations } from './app/server/organizations.ts'
import { registerDbSessionStore, sessionStoreStatus } from './app/server/session-store-db.ts'

// Keep the Keycloak tokens server-side (Postgres) so the session cookie stays
// small — inlining them exceeds the browser cookie-size limit and drops the
// cookie, which manifests as an endless redirect back to /login.
registerDbSessionStore()
import { apiServerFetch, handleK8s, resolveIdentity } from './app/server/k8s/gateway.ts'
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

/**
 * Live connectivity diagnostics — a single endpoint that reports the real state
 * of every dependency the console needs, with the ACTUAL resolved values and
 * upstream errors (not a generic "unavailable"). Purpose-built to answer
 * "why won't login / the cluster connect?":
 *
 *   - keycloak: discovery reachability + the resolved issuer / token / jwks
 *     ORIGINS, so an issuer-scheme mismatch (e.g. an http:// issuer the
 *     apiserver rejects) is visible at a glance.
 *   - kubernetes: a real call to K8S_API_URL with the signed-in user's token,
 *     surfacing 401 (token rejected → iss/aud mismatch), TLS failures (missing
 *     DENO_CERT), and unreachable hosts.
 *   - db: configured + ping.
 *
 * Read-only; contains no secrets (only public OIDC metadata + status). The
 * kubernetes probe is included only when a session is present.
 */
async function diagnostics(req: Request): Promise<Response> {
  const out: Record<string, unknown> = { ts: new Date().toISOString() }

  const cfg = getServerAuthConfig()
  out.auth = { configured: Boolean(cfg), publicUrl: cfg?.publicUrl ?? null }

  // Session-store mode — 'postgres' means the session cookie is small (a session
  // id only). 'inline-fallback' means tokens are inlined and login can fail if
  // the cookie exceeds the browser's ~4 KB limit; set DATABASE_URL to fix.
  out.sessionStore = sessionStoreStatus()

  // ── Keycloak (OIDC discovery + resolved endpoint origins) ──
  if (cfg) {
    try {
      const disc = await Promise.race([
        getDiscovery(cfg),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('discovery timeout after 5s')), 5000)),
      ])
      const origin = (u?: string) => {
        try {
          return u ? new URL(u).origin : null
        } catch {
          return u ?? null
        }
      }
      const issuerScheme = origin(disc.issuer)?.startsWith('https') ?? false
      out.keycloak = {
        status: 'ok',
        issuer: disc.issuer,
        issuerIsHttps: issuerScheme,
        // These are the origins the SERVER uses; browser-facing auth stays public.
        tokenEndpointOrigin: origin(disc.token_endpoint),
        jwksOrigin: origin(disc.jwks_uri),
        authorizeEndpointOrigin: origin(disc.authorization_endpoint),
        internalBackchannel: cfg.internalUrl ?? null,
        // The kube-apiserver validates the token `iss` strictly against its
        // --oidc-issuer-url (https). If this is false, apiserver token
        // acceptance AND console id-token verification will fail.
        hint: issuerScheme
          ? undefined
          : 'Issuer is not https — Keycloak is emitting a non-https issuer over the backchannel. Set hostname-strict-backchannel=true on Keycloak.',
      }
    } catch (e) {
      out.keycloak = { status: 'unreachable', error: e instanceof Error ? e.message : String(e) }
    }
  } else {
    out.keycloak = { status: 'not_configured' }
  }

  // ── Database ──
  try {
    const { isDbConfigured, pingDb } = await import('@adhar-console/db')
    out.db = isDbConfigured()
      ? { status: (await pingDb()) ? 'ok' : 'down', configured: true }
      : { status: 'unconfigured', configured: false }
  } catch (e) {
    out.db = { status: 'error', error: e instanceof Error ? e.message : String(e) }
  }

  // ── Kubernetes apiserver (real call as the signed-in user) ──
  const apiUrl = env('K8S_API_URL') ?? 'https://kubernetes.default.svc'
  const k8s: Record<string, unknown> = { apiUrl }
  const id = cfg ? await resolveIdentity(req) : null
  if (!id) {
    k8s.status = 'no_session'
    k8s.hint = 'Sign in first — the cluster is reached with your Keycloak token (per-user impersonation).'
  } else {
    try {
      const res = await Promise.race([
        apiServerFetch(id.token, '/version'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('apiserver timeout after 8s')), 8000)),
      ])
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { gitVersion?: string }
        k8s.status = 'ok'
        k8s.serverVersion = body.gitVersion ?? null
        k8s.user = id.user.name
      } else {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        k8s.status = 'rejected'
        k8s.httpStatus = res.status
        k8s.detail = detail
        if (res.status === 401) {
          k8s.hint =
            'Token rejected (401). The apiserver --oidc-issuer-url / --oidc-client-id must match the token iss (https Keycloak issuer) + aud (kubernetes). Usually the Keycloak backchannel issuer scheme.'
        } else if (res.status === 403) {
          k8s.hint = 'Authenticated but not authorized (403) — your Keycloak groups need RBAC bindings (oidc: prefix).'
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      k8s.status = 'unreachable'
      k8s.error = msg
      if (/certificate|self.signed|tls|ssl/i.test(msg)) {
        k8s.hint = 'TLS failure — set DENO_CERT to a bundle trusting the apiserver CA (and Keycloak CA).'
      } else if (/refused|dns|resolve|network/i.test(msg)) {
        k8s.hint = `Cannot reach ${apiUrl}. In local dev set K8S_API_URL to your kube context server (e.g. https://127.0.0.1:6443).`
      }
    }
  }
  out.kubernetes = k8s

  return Response.json(out, { headers: { 'cache-control': 'no-store' } })
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
  if (path === '/api/diagnostics') return diagnostics(req)

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

  // Software templates for Catalog → Create New — discovered from Gitea.
  if (path === '/api/templates') return handleListTemplates(req)

  // Component scaffolder (Catalog → Create): real Gitea repo + GitOps.
  if (path === '/api/scaffold') return handleScaffold(req)

  // Workspace / Organization management (orgs, members, teams, roles,
  // invitations, projects, api-tokens, audit) — tenant-scoped, Postgres-backed,
  // with optional Keycloak group reflection.
  const ws = path.match(/^\/api\/workspace\/(.*)$/)
  if (ws) return handleWorkspace(req, ws[1])

  // Billing (plans, subscription, seats, usage metering, invoices, budgets).
  const billing = path.match(/^\/api\/billing\/(.*)$/)
  if (billing) return handleBilling(req, billing[1])

  // Organizations (the tenant that scopes console-owned data) — list, create,
  // switch (re-signs the session's activeTenant), rename, delete.
  const orgs = path.match(/^\/api\/organizations(?:\/(.*))?$/)
  if (orgs) return handleOrganizations(req, orgs[1] ?? '')

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
