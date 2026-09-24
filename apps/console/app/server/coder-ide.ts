import { env } from '@adhar-console/utils'
import { getRequestUser } from './request-user.ts'
import { getServerAuthConfig } from '@adhar-console/auth/server'
import { getTool } from './tool-registry.ts'
import { proxyToolRequest } from './proxy.ts'
import { toPublicToolUrl, toolPublicUrl } from './domain.ts'

/**
 * Opening a cloud IDE as the right person.
 *
 * `/api/svc/coder/*` reaches Coder with the console's own credential, so the
 * console can read workspaces. A BROWSER opening code-server cannot use that:
 * the IDE is served by Coder's own app proxy on Coder's domain, and the tab
 * arrives with no Coder session. Every "Open in VS Code" therefore ended at
 * Coder's sign-in page, or at a 404 for a workspace the visitor could not see.
 *
 * Coder accepts a session token as the `coder_session_token` query parameter
 * on an app URL, exchanges it for a cookie on its own domain and redirects to
 * the clean URL. So the fix is to mint a SHORT-LIVED token for the workspace's
 * owner here, server-side, and hand the browser a URL that already carries it.
 *
 * Whose token, and why that is safe:
 *
 *   • the signed-in person's own Coder account, matched by e-mail, and created
 *     for them when they have none — they are getting a token for themselves;
 *   • when the console runs WITHOUT an identity provider (a laptop against a
 *     dev cluster: no Keycloak, stub session) there is no person to match, so
 *     it falls back to the console's own Coder identity. That is the same
 *     identity this process already uses for every Coder call, and the
 *     credential is already on that laptop, so nothing is escalated. The
 *     fallback is refused as soon as an identity provider is configured, and
 *     refused outright in-cluster.
 *
 * The client never names an owner: it asks for a workspace it can already see
 * and the owner is resolved here, so nobody can request a token for someone
 * else by editing a request.
 */

const KEY_LIFETIME_SECONDS = 120
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/

export interface CoderIdentity {
  /** Coder username whose workspaces this person drives. Empty when unresolved. */
  owner: string
  /** True when `owner` is this person's own account (not the console's). */
  matched: boolean
  /** True when the account was created for them just now. */
  created: boolean
  /** Why it is not matched — shown to the person rather than swallowed. */
  reason?: string
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

/** True when this console has no identity provider — a laptop, not a deployment. */
function stubAuth(): boolean {
  return !getServerAuthConfig() && !env('KUBERNETES_SERVICE_HOST')
}

/** Call Coder through the console's own tool proxy, reusing its credential. */
async function coder<T>(req: Request, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const upstream = new Request(`http://internal/api/svc/coder${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      // Forward the caller's cookies so per-user proxy modes still apply.
      ...(req.headers.get('cookie') ? { cookie: req.headers.get('cookie')! } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const res = await proxyToolRequest(upstream, 'coder', path)
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const j = JSON.parse(text) as { message?: string; detail?: string; validations?: Array<{ detail?: string }> }
      detail = [j.message, j.detail, ...(j.validations ?? []).map((v) => v.detail)].filter(Boolean).join(' — ') || detail
    } catch { /* not JSON */ }
    throw new Error(`Coder ${res.status}: ${detail}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

interface CoderUser {
  username: string
  email?: string
  organization_ids?: string[]
}

/** A Coder username from an e-mail, matching the client-side helper. */
function usernameFromEmail(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return (base || 'user').slice(0, 32)
}

/**
 * The Coder account this request acts as. Order: the person's own account,
 * an account created for them, then — only without an identity provider — the
 * console's own.
 */
export async function resolveCoderIdentity(req: Request): Promise<CoderIdentity> {
  const auth = await getRequestUser(req)
  const email = auth?.user.email?.trim().toLowerCase() ?? ''

  if (email) {
    try {
      const found = await coder<{ users?: CoderUser[] }>(req, `/api/v2/users?q=${encodeURIComponent(email)}&limit=5`)
      const exact = (found.users ?? []).find((u) => u.email?.toLowerCase() === email)
      if (exact) return { owner: exact.username, matched: true, created: false }
    } catch { /* fall through to creation */ }
    try {
      const me = await coder<CoderUser>(req, '/api/v2/users/me')
      const orgs = me.organization_ids?.length
        ? me.organization_ids
        : (await coder<Array<{ id: string }>>(req, '/api/v2/organizations')).map((o) => o.id)
      const made = await coder<CoderUser>(req, '/api/v2/users', {
        method: 'POST',
        body: {
          email,
          username: usernameFromEmail(email),
          name: auth?.user.name || undefined,
          login_type: 'oidc',
          organization_ids: orgs,
        },
      })
      return { owner: made.username, matched: true, created: true }
    } catch (e) {
      // Creation can legitimately fail — a name already taken, an address the
      // deployment's policy rejects, no permission to create users. Carry the
      // reason instead of discarding it, then try the fallback below.
      const reason = e instanceof Error ? e.message : String(e)
      if (!stubAuth()) {
        return { owner: '', matched: false, created: false, reason: `Coder has no account for ${email}, and one could not be created (${reason}). Sign in to Coder once from the app launcher.` }
      }
    }
  }

  if (!stubAuth()) {
    return {
      owner: '',
      matched: false,
      created: false,
      reason: 'You are signed in without an e-mail address, so no Coder account could be matched. Sign in to Coder once from the app launcher.',
    }
  }
  // Laptop, no identity provider: act as the console's own Coder identity.
  const me = await coder<CoderUser>(req, '/api/v2/users/me')
  return {
    owner: me.username,
    matched: false,
    created: false,
    reason: `No identity provider is configured, so cloud environments open as the console's own Coder account (${me.username}).`,
  }
}

/** `GET /api/coder/identity` — whose workspaces the browser should show and drive. */
export async function handleCoderIdentity(req: Request): Promise<Response> {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  try {
    const id = await resolveCoderIdentity(req)
    return withCookie(Response.json(id), auth?.refreshedCookie)
  } catch (e) {
    return withCookie(
      Response.json({ owner: '', matched: false, created: false, reason: e instanceof Error ? e.message : String(e) }),
      auth?.refreshedCookie,
    )
  }
}

interface WorkspaceApp {
  slug: string
  external?: boolean
  url?: string
}
interface Workspace {
  name: string
  owner_name: string
  latest_build: {
    status: string
    resources?: Array<{ agents?: Array<{ name: string; apps?: WorkspaceApp[] }> }>
  }
}

/**
 * `POST /api/coder/ide-session` — an IDE URL the browser can open directly.
 *
 * Body: `{ workspace, agent, app }`. The workspace must belong to the resolved
 * identity and be running; the app must exist on that agent. Returns
 * `{ url, owner, external }` — `external` marks a desktop deep link
 * (JetBrains Gateway, VS Code Desktop) rather than a browser URL.
 */
export async function handleCoderIdeSession(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)

  let body: { workspace?: string; agent?: string; app?: string; folder?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return withCookie(Response.json({ error: 'invalid_json' }, { status: 400 }), auth?.refreshedCookie)
  }
  const { workspace, agent, app } = body
  if (!workspace || !agent || !app || ![workspace, agent, app].every((v) => NAME_RE.test(v))) {
    return withCookie(Response.json({ error: 'invalid_request' }, { status: 400 }), auth?.refreshedCookie)
  }

  let identity: CoderIdentity
  try {
    identity = await resolveCoderIdentity(req)
  } catch (e) {
    return withCookie(Response.json({ error: 'coder_unreachable', detail: e instanceof Error ? e.message : String(e) }, { status: 502 }), auth?.refreshedCookie)
  }
  if (!identity.owner) {
    return withCookie(Response.json({ error: 'no_coder_account', detail: identity.reason }, { status: 403 }), auth?.refreshedCookie)
  }

  // The workspace must be one this identity owns — the client asking for
  // somebody else's must not mint a token for it.
  let ws: Workspace
  try {
    ws = await coder<Workspace>(req, `/api/v2/users/${encodeURIComponent(identity.owner)}/workspace/${encodeURIComponent(workspace)}`)
  } catch (e) {
    return withCookie(Response.json({ error: 'workspace_not_found', detail: e instanceof Error ? e.message : String(e) }, { status: 404 }), auth?.refreshedCookie)
  }
  if (ws.owner_name !== identity.owner) {
    return withCookie(Response.json({ error: 'not_your_workspace' }, { status: 403 }), auth?.refreshedCookie)
  }
  if (ws.latest_build.status !== 'running') {
    return withCookie(Response.json({ error: 'workspace_not_running', detail: ws.latest_build.status }, { status: 409 }), auth?.refreshedCookie)
  }
  const agentDef = (ws.latest_build.resources ?? []).flatMap((r) => r.agents ?? []).find((a) => a.name === agent)
  const appDef = agentDef?.apps?.find((a) => a.slug === app)
  if (!appDef) {
    return withCookie(Response.json({ error: 'app_not_found', detail: `${agent}/${app}` }, { status: 404 }), auth?.refreshedCookie)
  }

  // A short-lived token, exchanged for a cookie by Coder on first load.
  let key: string
  try {
    const minted = await coder<{ key: string }>(req, `/api/v2/users/${encodeURIComponent(identity.owner)}/keys`, {
      method: 'POST',
      body: { lifetime: `${KEY_LIFETIME_SECONDS}s` },
    })
    key = minted.key
  } catch (e) {
    return withCookie(Response.json({ error: 'token_mint_failed', detail: e instanceof Error ? e.message : String(e) }, { status: 502 }), auth?.refreshedCookie)
  }
  if (!key) return withCookie(Response.json({ error: 'token_mint_failed' }, { status: 502 }), auth?.refreshedCookie)

  const base = coderPublicUrl()
  if (!base) return withCookie(Response.json({ error: 'coder_url_unknown' }, { status: 503 }), auth?.refreshedCookie)

  // A desktop app (JetBrains Gateway, VS Code Desktop) is a deep link the
  // template supplies; Coder's own UI fills a `$SESSION_TOKEN` placeholder in
  // it, so fill it here with the same token rather than sending the user to a
  // link that asks them to paste one.
  if (appDef.external && appDef.url) {
    const url = appDef.url.replaceAll('$SESSION_TOKEN', encodeURIComponent(key))
    return withCookie(Response.json({ url, owner: identity.owner, external: true, matched: identity.matched }), auth?.refreshedCookie)
  }

  const url = `${base}/@${encodeURIComponent(identity.owner)}/${encodeURIComponent(ws.name)}.${encodeURIComponent(agent)}/apps/${encodeURIComponent(app)}/?coder_session_token=${encodeURIComponent(key)}`
  return withCookie(Response.json({ url, owner: identity.owner, external: false, matched: identity.matched }), auth?.refreshedCookie)
}

/** Coder's browser-reachable origin (never an in-cluster Service host). */
function coderPublicUrl(): string {
  const configured = getTool('coder')?.baseUrl
  const publicised = toPublicToolUrl(configured, 'coder', 'CODER_URL')
  const url = publicised && /^https?:/.test(publicised) ? publicised : toolPublicUrl('coder', 'CODER_URL')
  return (url ?? '').replace(/\/$/, '')
}
