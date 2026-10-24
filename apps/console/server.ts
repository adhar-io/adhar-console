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
import { env } from '@adhar/utils'
import {
  getDiscovery,
  getServerAuthConfig,
  handleCallback,
  handleLogin,
  handleLogout,
  handleSession,
  isServerAuthConfigured,
} from '@adhar/auth/server'
import { proxyToolRequest } from './app/server/proxy.ts'
import { publicConfigResponse } from './app/server/public-config.ts'
import { handleDocuments, handlePreferences } from './app/server/api-handlers.ts'
import { handleNotificationsApi } from './app/server/notifications.ts'
import { handleScaffold } from './app/server/scaffolder.ts'
import { handleAppsetToggle } from './app/server/appset.ts'
import { handleListTemplates } from './app/server/templates.ts'
import { handleScorecardHistory, handleScorecardRerun, handleScorecards } from './app/server/scorecards.ts'
import { handleScorecardFix } from './app/server/scorecard-fix.ts'
import { handleEntityRoutes } from './app/server/entity-routes.ts'
import { handleTeardown } from './app/server/teardown.ts'
import { handleAppDelete } from './app/server/app-delete.ts'
import { handleResilienceRuns } from './app/server/resilience-runs.ts'
import { handleResilienceReports, startResilienceReports } from './app/server/resilience-reports.ts'
import { handleScanSecurity } from './app/server/scan-waivers.ts'
import { handleCoderIdentity, handleCoderIdeSession } from './app/server/coder-ide.ts'
import { handleAlertmanagerWebhook } from './app/server/alertmanager.ts'
import { handleSupportApi } from './app/server/support/handlers.ts'
import { handleListTeams } from './app/server/teams.ts'
import { handleWorkspace } from './app/server/workspace/handlers.ts'
import { startPlatformEvents } from './app/server/events/platform-events.ts'
import { startGraph } from './app/server/graph/builder.ts'
import { handleGraph } from './app/server/graph/handlers.ts'
import { handleBilling } from './app/server/billing/handlers.ts'
import { handleOrganizations } from './app/server/organizations.ts'
import { handleStatus } from './app/server/status.ts'
import { handlePromBatch } from './app/server/prom-batch.ts'
import { registerDbSessionStore, sessionStoreStatus } from './app/server/session-store-db.ts'
import {
  csrfRejected,
  guardJsonBody,
  isMutating,
  RequestBodyError,
  withDeadline,
  withSecurityHeaders,
} from './app/server/http-hardening.ts'

// Keep the Keycloak tokens server-side (Postgres) so the session cookie stays
// small — inlining them exceeds the browser cookie-size limit and drops the
// cookie, which manifests as an endless redirect back to /login.
registerDbSessionStore()
import { apiServerFetch, handleK8s, resolveIdentity } from './app/server/k8s/gateway.ts'
import { handleExec } from './app/server/k8s/exec.ts'
import { handleLive, liveStats } from './app/server/live.ts'
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
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // Malformed percent-encoding (`/%E0%A4%A`) is not a file we have — let the
    // SPA fallback answer instead of the router's 500.
    return null
  }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '')
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
  const { isDbConfigured, pingDb } = await import('@adhar/db')
  const db = isDbConfigured() ? ((await pingDb()) ? 'ok' : 'down') : 'unconfigured'
  const cfg = getServerAuthConfig()
  if (!cfg) {
    return Response.json({ status: 'ready', auth: 'stub', db }, { headers: { 'cache-control': 'no-store' } })
  }
  // OIDC discovery is a REPORTED, non-fatal readiness signal — never a hard gate.
  // It's fetched lazily and cached on first login, and the console serves the SPA
  // + /healthz + BFF without it, so a transient Keycloak/gateway unavailability
  // (or adhar-controlplane split-horizon DNS at startup) must NOT keep the pod out of its
  // Service — that would remove all endpoints and black-hole routing. We probe it
  // with a short timeout and report reachability, but stay ready regardless.
  let keycloak: 'ok' | 'unreachable' = 'ok'
  try {
    await withDeadline(getDiscovery(cfg), 3000, 'discovery timeout')
  } catch {
    keycloak = 'unreachable'
  }
  return Response.json(
    { status: 'ready', auth: 'keycloak', db, keycloak },
    { headers: { 'cache-control': 'no-store' } },
  )
}

// Shared with the TanStack route (app/routes/api/config.ts) — see
// app/server/public-config.ts. The two used to be hand-copied and drifted:
// this one never gained giteaOrg/argocdProject/docsBaseUrl/publicBaseDomain,
// so a real install got `null` for all of them, and it hardcoded a bogus
// '0.2.0' version fallback.
function apiConfig(): Promise<Response> {
  return publicConfigResponse()
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
 *
 * Anonymous callers get the statuses and hints only. The endpoint has to work
 * before sign-in does (it is how a broken login is debugged), but the internal
 * backchannel URL, the apiserver address and raw upstream error text (which
 * names adhar-controlplane hosts) are a map of the cluster for anyone who can reach
 * the console — so they are shown to signed-in users only.
 */
async function diagnostics(req: Request): Promise<Response> {
  const out: Record<string, unknown> = { ts: new Date().toISOString() }

  const cfg = getServerAuthConfig()
  const id = cfg ? await resolveIdentity(req) : null
  // No identity provider at all is a laptop; there is nothing to protect.
  const detailed = !cfg || Boolean(id)
  const errText = (e: unknown) => (detailed ? (e instanceof Error ? e.message : String(e)) : undefined)
  out.auth = { configured: Boolean(cfg), publicUrl: cfg?.publicUrl ?? null }

  // Session-store mode — 'postgres' means the session cookie is small (a session
  // id only). 'inline-fallback' means tokens are inlined and login can fail if
  // the cookie exceeds the browser's ~4 KB limit; set DATABASE_URL to fix.
  const store = sessionStoreStatus()
  out.sessionStore = detailed ? store : { mode: store.mode }

  // ── Keycloak (OIDC discovery + resolved endpoint origins) ──
  if (cfg) {
    try {
      const disc = await withDeadline(getDiscovery(cfg), 5000, 'discovery timeout after 5s')
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
        internalBackchannel: detailed ? cfg.internalUrl ?? null : undefined,
        // The kube-apiserver validates the token `iss` strictly against its
        // --oidc-issuer-url (https). If this is false, apiserver token
        // acceptance AND console id-token verification will fail.
        hint: issuerScheme
          ? undefined
          : 'Issuer is not https — Keycloak is emitting a non-https issuer over the backchannel. Set hostname-strict-backchannel=true on Keycloak.',
      }
    } catch (e) {
      out.keycloak = { status: 'unreachable', error: errText(e) }
    }
  } else {
    out.keycloak = { status: 'not_configured' }
  }

  // ── Database ──
  try {
    const { isDbConfigured, pingDb } = await import('@adhar/db')
    out.db = isDbConfigured()
      ? { status: (await pingDb()) ? 'ok' : 'down', configured: true }
      : { status: 'unconfigured', configured: false }
  } catch (e) {
    out.db = { status: 'error', error: errText(e) }
  }

  // ── Kubernetes apiserver (real call as the signed-in user) ──
  const apiUrl = env('K8S_API_URL') ?? 'https://kubernetes.default.svc'
  const k8s: Record<string, unknown> = detailed ? { apiUrl } : {}
  if (!id) {
    k8s.status = 'no_session'
    k8s.hint = 'Sign in first — the cluster is reached with your Keycloak token (per-user impersonation).'
  } else {
    try {
      const res = await apiServerFetch(id, '/version', { signal: AbortSignal.timeout(8000) })
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

  if (!detailed) return Response.json(out, { headers: { 'cache-control': 'no-store' } })

  // ── realtime hub load ──
  // `watches` is the number of upstream apiserver watches this process holds;
  // `subscribers` is how many browser subscriptions they serve. Identical
  // subscriptions share one watch, so subscribers should sit well above
  // watches on a busy install — if the two track each other, deduplication has
  // stopped working and the apiserver is carrying one stream per panel.
  const live = liveStats()
  out.live = {
    watches: live.watches,
    subscribers: live.watchSubscribers,
    pollers: live.pollers,
    sharingRatio: live.watches ? Number((live.watchSubscribers / live.watches).toFixed(2)) : 0,
  }

  return Response.json(out, { headers: { 'cache-control': 'no-store' } })
}

/* ─────────────── request router ─────────────── */

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method.toUpperCase()

  if (path.startsWith('/api/') && isMutating(method)) {
    // CSRF: see http-hardening.ts for why SameSite=Lax alone is not enough here.
    const csrf = csrfRejected(req)
    if (csrf) return csrf
    guardJsonBody(req)
  }

  // Health/config (dependency-light).
  if (path === '/healthz') return healthz()
  if (path === '/readyz') return readyz()
  if (path === '/api/config') return apiConfig()
  if (path === '/api/diagnostics') return diagnostics(req)
  if (path === '/api/status') return handleStatus(req)
  // Many PromQL queries in one request (Overview and other panels coalesce here).
  if (path === '/api/prom/batch') return handlePromBatch(req)

  // Auth (OIDC) — all GET, full-page navigations + the session probe.
  if (path === '/api/auth/login') return handleLogin(req)
  if (path === '/api/auth/callback') return handleCallback(req)
  if (path === '/api/auth/logout') return handleLogout(req)
  if (path === '/api/auth/session') return handleSession(req)

  // Pod exec/attach terminal (WebSocket upgrade).
  if (path === '/api/k8s/exec') return handleExec(req)
  // Live hub: one multiplexed WebSocket for watches, change-detection and notifications.
  if (path === '/api/live') return handleLive(req)

  // AI assistant (SSE chat + diagnose/explain/generate).
  const ai = path.match(/^\/api\/ai\/(.*)$/)
  if (ai) return handleAi(req, ai[1])

  // Kubernetes gateway: /api/k8s/<apiserver path…> — user-token, streaming,
  // discovery + access-review + apply under /api/k8s/-/…
  const k8s = path.match(/^\/api\/k8s\/(.*)$/)
  if (k8s) return handleK8s(req, k8s[1])

  // Cloud IDEs: whose Coder account this person drives, and a short-lived
  // authenticated URL for opening an IDE in the browser.
  if (path === '/api/coder/identity') return handleCoderIdentity(req)
  if (path === '/api/coder/ide-session') return handleCoderIdeSession(req)

  // Backing-tool proxy: /api/svc/<tool>/<upstream path...>
  const svc = path.match(/^\/api\/svc\/([^/]+)(?:\/(.*))?$/)
  if (svc) return proxyToolRequest(req, svc[1], svc[2] ?? '')

  // Preferences: /api/prefs/<scope>
  const prefs = path.match(/^\/api\/prefs\/([^/]+)$/)
  if (prefs) return handlePreferences(req, prefs[1])

  // Notification Center: feed, state, create, insights scan.
  // Platform knowledge graph: /api/graph/<search|node|neighbourhood|path|overview>
  const gr = path.match(/^\/api\/graph(\/.*)?$/)
  if (gr) return handleGraph(req, gr[1] ?? '')

  const notif = path.match(/^\/api\/notifications(\/.*)?$/)
  if (notif) return handleNotificationsApi(req, notif[1] ?? '')

  // Console-owned document store: /api/store/<kind>[/<id>]
  const store = path.match(/^\/api\/store\/([^/]+)(?:\/(.+))?$/)
  if (store) {
    let kind: string, id: string | undefined
    try {
      kind = decodeURIComponent(store[1])
      id = store[2] ? decodeURIComponent(store[2]) : undefined
    } catch {
      return Response.json({ error: 'invalid_path' }, { status: 400 })
    }
    return handleDocuments(req, kind, id)
  }

  // Software templates for Catalog → Create New — discovered from Gitea.
  if (path === '/api/templates') return handleListTemplates(req)

  // Production-readiness scorecards published by the platform's adhar-controlplane
  // scorer (the `scorecards` package) — `configured: false` when it isn't installed.
  if (path === '/api/scorecards') return handleScorecards(req)
  // The scorer's rolling series, so a score can be read as a trend.
  if (path === '/api/scorecards/history') return handleScorecardHistory(req)
  // Score now rather than at the next half-hour tick: creates a Job from the
  // scorer CronJob's own template, as the caller, so a manual run and a
  // scheduled run cannot produce different numbers.
  if (path === '/api/scorecards/rerun') return handleScorecardRerun(req)
  // Scorecard "Fix": commit a catalog-info.yaml / deploy-manifest change as a
  // PR (or direct commit) — gated to the owning team's developers and admins.
  if (path === '/api/scorecards/fix') return handleScorecardFix(req)

  // Run one application's resilience suite now (Chaos page): a gate-mode Job
  // from the resilience runner's own CronJob, created as the console SA behind
  // an RBAC check (create resilience-runs.console.adhar.io in the app's
  // namespace); plus the gate runs' status and log tails.
  const resilience = path.match(/^\/api\/resilience\/runs(\/.*)?$/)
  if (resilience) return handleResilienceRuns(req, resilience[1] ?? '')
  // Chaos Engineering run reports: one per resilience run, tagged with the
  // commit under test, recorded server-side (see resilience-reports.ts).
  const reports = path.match(/^\/api\/resilience\/reports(\/.*)?$/)
  if (reports) return handleResilienceReports(req, reports[1] ?? '')

  // Alertmanager's receiver: platform alerts land in the Notification Center
  // for everyone. Bearer-token auth (Alertmanager is not a user) — see the
  // handler for why an unset token refuses rather than accepts.
  if (path === '/api/alerts/alertmanager') return handleAlertmanagerWebhook(req)

  // Support tickets in Plane: open one by hand for a notification (the
  // platform watcher and Alertmanager open them automatically) and report
  // whether the pipeline is wired. See app/server/support/.
  const support = path.match(/^\/api\/support\/(.*)$/)
  if (support) return handleSupportApi(req, support[1])

  // Where a catalog entity is reachable — HTTPRoutes/Ingresses whose backend is
  // the entity's Service. Powers the drawer's "Open" button and the full URLs
  // on its Deployment tab.
  if (path === '/api/catalog/routes') return handleEntityRoutes(req)

  // Remove an entity from the platform: Argo CD apps (cascading), kpack
  // Image, PipelineRuns, optionally its namespace and Gitea repository.
  if (path === '/api/catalog/teardown') return handleTeardown(req)

  // Delete a custom application: its Application XR as the signed-in user
  // (Crossplane removes the Argo CD apps and composed resources), then,
  // optionally, its Gitea repository. RBAC-gated server-side (delete applications.console.adhar.io).
  if (path === '/api/apps/delete') return handleAppDelete(req)

  // Scan waivers (request → review → ConfigMap the CI/runtime enforce), scan
  // policy, and the manual scan gate on paused PipelineRuns. RBAC-gated
  // server-side (scan-waivers / scan-policies.console.adhar.io); cluster
  // writes go out as the signed-in user.
  const sec = path.match(/^\/api\/security\/(.*)$/)
  if (sec) return handleScanSecurity(req, sec[1])

  // Owner/team (Group entity) picker for Catalog → Create New — discovered
  // from the adhar/adhar-templates Gitea repo, always incl. the two defaults.
  if (path === '/api/teams') return handleListTeams(req)

  // Component scaffolder (Catalog → Create): real Gitea repo + GitOps.
  if (path === '/api/scaffold') return handleScaffold(req)

  // Marketplace enable/disable: flip an app's `enabled` in the Adhar
  // ApplicationSet YAML in Gitea (GitOps) — ArgoCD reconciles the change.
  if (path === '/api/platform/appset/toggle') return handleAppsetToggle(req)

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
    return withSecurityHeaders(await route(req))
  } catch (err) {
    // A malformed / oversized JSON body is the client's error, not ours.
    if (err instanceof RequestBodyError) return withSecurityHeaders(err.toResponse())
    // Never let a handler error crash the server. Redact the query string —
    // `/api/auth/callback` carries a single-use `?code=` we must not log.
    const u = new URL(req.url)
    console.error(`[server] unhandled error for ${req.method} ${u.pathname}:`, err)
    return withSecurityHeaders(Response.json({ error: 'internal_error' }, { status: 500 }))
  }
}

/* ─────────────── boot + graceful shutdown ─────────────── */

const server = Deno.serve({ port: PORT, hostname: HOSTNAME }, handler)

// Watch the platform and turn its state transitions into notifications. Needs
// no request in flight and no user: it authenticates as the console's own
// ServiceAccount, and stays off (loudly, once) when there isn't one.
const stopPlatformEvents = startPlatformEvents()

// The platform knowledge graph — what exists and how it is connected, kept
// current from the apiserver. Adhar AI reads it to answer relationship
// questions that list tools cannot, and the Knowledge Graph page renders it.
const stopGraph = startGraph()

// Chaos Engineering run reports — the resilience runner keeps only each app's
// latest result, so the console freezes every run as it lands, commit and all.
const stopResilienceReports = startResilienceReports()

console.log(`adhar-console listening on http://${HOSTNAME}:${PORT}  (dist: ${DIST})`)
console.log(`  auth: ${isServerAuthConfigured() ? 'keycloak' : 'stub (KEYCLOAK_URL/AUTH_* not set)'}`)

// `server.shutdown()` waits for every in-flight response to finish — and the
// console holds long-lived ones by design (watch streams, log follows, the live
// hub WebSocket, SSE chat). Without a deadline a drain never completes and the
// pod sits in Terminating until the kubelet SIGKILLs it at the grace period,
// cutting everything mid-write anyway. Exit on our own terms a little before
// the default 30s grace instead; a second signal exits at once.
const SHUTDOWN_DEADLINE_MS = Number(env('SHUTDOWN_DEADLINE_MS') ?? 25_000)
let draining = false

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  try {
    Deno.addSignalListener(sig, () => {
      if (draining) {
        console.log(`[server] ${sig} received again — exiting now`)
        Deno.exit(0)
      }
      draining = true
      console.log(`[server] ${sig} received — draining (deadline ${SHUTDOWN_DEADLINE_MS}ms)…`)
      stopPlatformEvents()
      stopGraph()
      stopResilienceReports()
      setTimeout(() => {
        console.warn('[server] drain deadline reached — closing remaining connections')
        Deno.exit(0)
      }, SHUTDOWN_DEADLINE_MS)
      server.shutdown().finally(() => Deno.exit(0))
    })
  } catch {
    /* signal not supported on this platform — ignore */
  }
}
