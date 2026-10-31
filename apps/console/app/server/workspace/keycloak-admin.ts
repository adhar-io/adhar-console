import { getServerAuthConfig } from '@adhar/auth/server'
import { env } from '@adhar/utils'
import { orgAdminGroup, orgMemberGroup } from '../tenancy/org-access.ts'

/**
 * Keycloak Admin REST client — the console's only user store.
 *
 * Organisation membership IS Keycloak group membership (`tenancy/org-access.ts`):
 * the console lists people from groups, adds and removes them, and creates the
 * account (with a set-password email from Keycloak) for someone new. It keeps
 * no members, roles or invitations of its own.
 *
 * Credentials: a dedicated service account (`KEYCLOAK_ADMIN_CLIENT_ID` /
 * `KEYCLOAK_ADMIN_CLIENT_SECRET`, client-credentials grant) or — as a fallback
 * — the console's own confidential client, whose service account the realm job
 * grants manage-users, view-users, query-users, query-groups and manage-realm.
 *
 * EVERY method throws a typed `KcError` when Keycloak could not do what was
 * asked; nothing reports "false" and carries on. That is the opposite of the
 * old contract, on purpose: membership has no copy in Postgres to fall back on,
 * so a write that did not reach Keycloak did not happen, and saying otherwise
 * is how the console showed people as members of organisations they could not
 * open. Handlers map the error to HTTP with `kcErrorResponse`.
 *
 * TLS: Deno trusts `DENO_CERT` process-wide, so adhar-controlplane HTTPS endpoints
 * with a private CA work without extra plumbing.
 */

export interface KcGroup {
  id: string
  name: string
  path: string
}

export interface KcUser {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled?: boolean
  emailVerified?: boolean
  createdTimestamp?: number
  requiredActions?: string[]
}

export interface GroupMembers {
  members: KcUser[]
  /** True when the group has more members than one listing returns. */
  truncated: boolean
}

export type KcErrorCode =
  | 'unconfigured'
  | 'unavailable'
  | 'denied'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'email_failed'

/** What went wrong talking to Keycloak. `status` is Keycloak's HTTP status (0 = no answer). */
export class KcError extends Error {
  constructor(readonly code: KcErrorCode, readonly status: number, readonly detail: string) {
    super(detail)
    this.name = 'KcError'
  }
}

/** The directory operations the console needs — the seam tests replace. */
export interface IdentityDirectory {
  findGroup(name: string): Promise<KcGroup | null>
  ensureGroup(name: string): Promise<KcGroup>
  /**
   * Create a top-level group that must NOT exist yet: a group of that name
   * already there (including one created a moment ago by a concurrent
   * request) is a `KcError('conflict')`, never a quiet success.
   */
  createGroup(name: string): Promise<KcGroup>
  /** An absent group counts as deleted. */
  deleteGroup(name: string): Promise<void>
  /**
   * An absent group has no members. Answers are reused for a few seconds;
   * `fresh` bypasses that for decisions that must see the current set (the
   * last-admin guard).
   */
  listGroupMembers(name: string, opts?: { brief?: boolean; fresh?: boolean }): Promise<GroupMembers>
  /** Creates the group when it does not exist yet. */
  addUserToGroup(userId: string, groupName: string): Promise<void>
  /** An absent group, or a user not in it, counts as removed. */
  removeUserFromGroup(userId: string, groupName: string): Promise<void>
  getUser(id: string): Promise<KcUser | null>
  /** The user's TOP-LEVEL group names, spelled exactly as Keycloak has them. */
  getUserGroups(id: string, opts?: { timeoutMs?: number }): Promise<string[]>
  findUserByEmail(email: string): Promise<KcUser | null>
  findUserByUsername(username: string): Promise<KcUser | null>
  searchUsers(q: string, opts?: { first?: number; max?: number }): Promise<KcUser[]>
  /** Creates an enabled account that must set its password; returns its id. */
  createUser(u: { email: string; firstName?: string; lastName?: string }): Promise<string>
  deleteUser(id: string): Promise<void>
  executeActionsEmail(id: string, opts?: { lifespan?: number; clientId?: string; redirectUri?: string }): Promise<void>
  /** Whether the realm has an SMTP server, i.e. whether Keycloak can send email at all. */
  emailConfigured(): Promise<boolean>
  ensureOrgGroups(slug: string): Promise<void>
}

interface KcConfig {
  /** Server-side base origin for Keycloak (internal URL when split-horizon). */
  base: string
  realm: string
  clientId: string
  clientSecret: string
}

function resolveConfig(): KcConfig | null {
  const auth = getServerAuthConfig()
  if (!auth) return null
  // issuer is `<url>/realms/<realm>` — strip back to the origin+path base.
  const issuerBase = auth.issuer.replace(/\/realms\/[^/]+\/?$/, '')
  return {
    base: auth.internalUrl ?? issuerBase,
    realm: auth.realm,
    clientId: env('KEYCLOAK_ADMIN_CLIENT_ID') ?? auth.clientId,
    clientSecret: env('KEYCLOAK_ADMIN_CLIENT_SECRET') ?? auth.clientSecret,
  }
}

/** Per-call ceiling for Keycloak admin/token requests. */
export const KC_TIMEOUT_MS = 10_000
const PAGE = 500
/** Most members one listing collects; a bigger group is reported as truncated. */
export const MEMBERS_CAP = 5_000
const MEMBERS_TTL_MS = 15_000
const MEMBERS_CACHE_MAX = 500
const EMAIL_CONFIG_TTL_MS = 5 * 60_000
/** Three days to set a password — Keycloak's own default is twelve hours. */
export const SETUP_EMAIL_LIFESPAN_S = 259_200

const enc = encodeURIComponent
const isServiceAccount = (u: { username?: string }) => (u.username ?? '').startsWith('service-account-')

interface CallOpts {
  body?: unknown
  timeoutMs?: number
  /** The realm-management role this call needs, named in a refusal. */
  role: string
  /** Statuses the caller handles itself instead of having them thrown. */
  allow?: number[]
}

interface CallResult<T> {
  status: number
  data: T | null
  headers: Headers
}

export class KeycloakAdmin implements IdentityDirectory {
  #cfg: KcConfig
  #fetch: typeof fetch
  #now: () => number
  #token: { value: string; expiresAt: number } | null = null
  #groupIds = new Map<string, string>()
  #members = new Map<string, { at: number; value: GroupMembers }>()
  #email: { at: number; value: boolean } | null = null

  constructor(cfg: KcConfig, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#cfg = cfg
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.#now = opts.now ?? Date.now
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.#now() + 5_000) return this.#token.value
    const url = `${this.#cfg.base}/realms/${this.#cfg.realm}/protocol/openid-connect/token`
    let res: Response
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.#cfg.clientId,
          client_secret: this.#cfg.clientSecret,
        }),
        // These calls run inside user requests; a hung Keycloak must not hang them with it.
        signal: AbortSignal.timeout(KC_TIMEOUT_MS),
      })
    } catch (e) {
      throw new KcError('unavailable', 0, `Keycloak did not answer the admin token request: ${errText(e)}`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      if (res.status >= 500) throw new KcError('unavailable', res.status, `Keycloak's token endpoint failed (HTTP ${res.status}).`)
      throw new KcError(
        'denied',
        res.status,
        `Keycloak refused the console's admin client credentials (HTTP ${res.status}) — check KEYCLOAK_ADMIN_CLIENT_ID/SECRET or the adhar-console client's service account.`,
      )
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new KcError('unavailable', res.status, 'Keycloak answered the token request without a token.')
    this.#token = {
      value: body.access_token,
      expiresAt: this.#now() + Math.max(30, (body.expires_in ?? 60) - 10) * 1000,
    }
    return this.#token.value
  }

  async #call<T>(method: string, path: string, opts: CallOpts, retried = false): Promise<CallResult<T>> {
    const token = await this.#accessToken()
    const url = `${this.#cfg.base}/admin/realms/${enc(this.#cfg.realm)}${path}`
    let res: Response
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? KC_TIMEOUT_MS),
      })
    } catch (e) {
      throw new KcError('unavailable', 0, `Keycloak did not answer ${method} ${route(path)}: ${errText(e)}`)
    }
    // The cached admin token can die before its stated expiry (session limits,
    // a key rotation); one fresh token is worth one retry.
    if (res.status === 401 && !retried) {
      await res.body?.cancel().catch(() => {})
      this.#token = null
      return this.#call<T>(method, path, opts, true)
    }
    const text = await res.text().catch(() => '')
    let data: T | null = null
    if (text) {
      try {
        data = JSON.parse(text) as T
      } catch {
        data = null
      }
    }
    if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, data, headers: res.headers }
    const said = keycloakMessage(data)
    if (res.status === 401 || res.status === 403) {
      throw new KcError(
        'denied',
        res.status,
        `Keycloak refused ${method} ${route(path)} (HTTP ${res.status}). The console's service account needs the realm-management role "${opts.role}".`,
      )
    }
    if (res.status === 404) throw new KcError('not_found', 404, said || `${route(path)} does not exist in Keycloak.`)
    if (res.status === 409) throw new KcError('conflict', 409, said || 'Keycloak reports a conflict.')
    if (res.status >= 500) throw new KcError('unavailable', res.status, `Keycloak failed ${method} ${route(path)} (HTTP ${res.status})${said ? `: ${said}` : ''}.`)
    throw new KcError('invalid', res.status, said || `Keycloak rejected ${method} ${route(path)} (HTTP ${res.status}).`)
  }

  /* ─────────── groups ─────────── */

  /** A TOP-LEVEL group by exact name; a subgroup of the same name never matches. */
  async findGroup(name: string): Promise<KcGroup | null> {
    const cachedId = this.#groupIds.get(name)
    if (cachedId) return { id: cachedId, name, path: `/${name}` }
    const res = await this.#call<KcGroup[]>(
      'GET',
      `/groups?search=${enc(name)}&exact=true&briefRepresentation=true&first=0&max=10`,
      { role: 'query-groups' },
    )
    const hit = (Array.isArray(res.data) ? res.data : []).find((g) => g.name === name && g.path === `/${name}`) ?? null
    if (hit) this.#groupIds.set(name, hit.id)
    return hit
  }

  async ensureGroup(name: string): Promise<KcGroup> {
    const existing = await this.findGroup(name)
    if (existing) return existing
    const created = await this.#call('POST', '/groups', { body: { name }, role: 'manage-users', allow: [409] })
    const id = created.status === 409 ? null : idFromLocation(created.headers.get('location'))
    if (id) {
      this.#groupIds.set(name, id)
      return { id, name, path: `/${name}` }
    }
    // Lost a race with another writer (409), or no Location: it exists now.
    const found = await this.findGroup(name)
    if (!found) throw new KcError('unavailable', created.status, `Keycloak did not create group ${name}.`)
    return found
  }

  async createGroup(name: string): Promise<KcGroup> {
    const created = await this.#call('POST', '/groups', { body: { name }, role: 'manage-users' })
    const id = idFromLocation(created.headers.get('location'))
    if (id) {
      this.#groupIds.set(name, id)
      return { id, name, path: `/${name}` }
    }
    // Created, but no Location (a proxy stripped it): look it up.
    const found = await this.findGroup(name)
    if (!found) throw new KcError('unavailable', created.status, `Keycloak did not report group ${name}.`)
    return found
  }

  async deleteGroup(name: string): Promise<void> {
    this.#forgetMembers(name)
    await this.#tolerant404(name, (gid) => this.#call('DELETE', `/groups/${enc(gid)}`, { role: 'manage-users', allow: [404] }))
    this.#groupIds.delete(name)
  }

  /**
   * For calls where a 404 is an acceptable END state (deleting, leaving): a 404
   * on a CACHED id may instead mean the group was re-created under a new id, so
   * the id is re-resolved once and the call repeated against the live group.
   */
  async #tolerant404(name: string, op: (id: string) => Promise<CallResult<unknown>>): Promise<void> {
    const wasCached = this.#groupIds.has(name)
    const group = await this.findGroup(name)
    if (!group) return
    const res = await op(group.id)
    if (res.status !== 404 || !wasCached) return
    this.#groupIds.delete(name)
    const fresh = await this.findGroup(name)
    if (fresh && fresh.id !== group.id) await op(fresh.id)
  }

  /**
   * Run `op` against the group's id; a 404 on a CACHED id means the group was
   * deleted (and maybe re-created) behind the cache's back, so the id is
   * re-resolved once. `onGone` decides what an absent group means for `op`.
   */
  async #withGroup<T>(
    name: string,
    op: (id: string) => Promise<T>,
    onGone: () => Promise<T>,
  ): Promise<T> {
    const wasCached = this.#groupIds.has(name)
    const group = await this.findGroup(name)
    if (!group) return onGone()
    try {
      return await op(group.id)
    } catch (e) {
      if (!(e instanceof KcError) || e.code !== 'not_found' || !wasCached) throw e
      this.#groupIds.delete(name)
      const fresh = await this.findGroup(name)
      if (!fresh) return onGone()
      if (fresh.id === group.id) throw e
      return op(fresh.id)
    }
  }

  async listGroupMembers(name: string, opts: { brief?: boolean; fresh?: boolean } = {}): Promise<GroupMembers> {
    const brief = opts.brief !== false
    const key = `${name}\u0000${brief}`
    const hit = this.#members.get(key)
    if (hit && !opts.fresh && this.#now() - hit.at < MEMBERS_TTL_MS) return hit.value
    const value = await this.#withGroup(
      name,
      async (id) => {
        const members: KcUser[] = []
        for (let first = 0; ; first += PAGE) {
          const res = await this.#call<KcUser[]>(
            'GET',
            `/groups/${enc(id)}/members?first=${first}&max=${PAGE}&briefRepresentation=${brief}`,
            { role: 'view-users' },
          )
          const page = Array.isArray(res.data) ? res.data : []
          members.push(...page)
          if (page.length < PAGE) return { members, truncated: false }
          if (members.length >= MEMBERS_CAP) return { members: members.slice(0, MEMBERS_CAP), truncated: true }
        }
      },
      () => Promise.resolve({ members: [], truncated: false }),
    )
    // Bounded: drop the oldest listing when full (Map keeps insertion order).
    this.#members.delete(key)
    if (this.#members.size >= MEMBERS_CACHE_MAX) this.#members.delete(this.#members.keys().next().value!)
    this.#members.set(key, { at: this.#now(), value })
    return value
  }

  #forgetMembers(name: string): void {
    this.#members.delete(`${name}\u0000true`)
    this.#members.delete(`${name}\u0000false`)
  }

  async addUserToGroup(userId: string, groupName: string): Promise<void> {
    this.#forgetMembers(groupName)
    await this.#withGroup(
      groupName,
      async (gid) => {
        await this.#call('PUT', `/users/${enc(userId)}/groups/${enc(gid)}`, { role: 'manage-users' })
      },
      async () => {
        const g = await this.ensureGroup(groupName)
        await this.#call('PUT', `/users/${enc(userId)}/groups/${enc(g.id)}`, { role: 'manage-users' })
      },
    )
  }

  async removeUserFromGroup(userId: string, groupName: string): Promise<void> {
    this.#forgetMembers(groupName)
    // Keycloak answers 204 for a user who is not in the group and 404 for a
    // user who does not exist — both mean "not a member" here.
    await this.#tolerant404(
      groupName,
      (gid) => this.#call('DELETE', `/users/${enc(userId)}/groups/${enc(gid)}`, { role: 'manage-users', allow: [404] }),
    )
  }

  async ensureOrgGroups(slug: string): Promise<void> {
    await this.ensureGroup(orgMemberGroup(slug))
    await this.ensureGroup(orgAdminGroup(slug))
  }

  /* ─────────── users ─────────── */

  async getUser(id: string): Promise<KcUser | null> {
    const res = await this.#call<KcUser>('GET', `/users/${enc(id)}`, { role: 'view-users', allow: [404] })
    return res.status === 404 ? null : res.data
  }

  async getUserGroups(id: string, opts: { timeoutMs?: number } = {}): Promise<string[]> {
    const res = await this.#call<KcGroup[]>(
      'GET',
      `/users/${enc(id)}/groups?briefRepresentation=true&first=0&max=1000`,
      { role: 'view-users', timeoutMs: opts.timeoutMs },
    )
    // Top-level only: the token's `groups` claim is the last path segment, so a
    // subgroup named `org-acme-admin` would look identical there — the live
    // answer, which writes trust, does not repeat that ambiguity. Names are
    // kept exactly as spelled: Kubernetes binds them case-sensitively, so
    // `ORG-ACME-ADMIN` is not acme's admin group (tenancy/org-access.ts).
    return (Array.isArray(res.data) ? res.data : [])
      .filter((g) => typeof g?.name === 'string' && g.path === `/${g.name}`)
      .map((g) => g.name)
  }

  async #findUser(param: 'email' | 'username', value: string): Promise<KcUser | null> {
    const res = await this.#call<KcUser[]>(
      'GET',
      `/users?${param}=${enc(value)}&exact=true&first=0&max=2&briefRepresentation=false`,
      { role: 'view-users' },
    )
    const want = value.toLowerCase()
    return (Array.isArray(res.data) ? res.data : []).find((u) =>
      !isServiceAccount(u) && (param === 'email' ? u.email : u.username)?.toLowerCase() === want
    ) ?? null
  }

  findUserByEmail(email: string): Promise<KcUser | null> {
    return this.#findUser('email', email)
  }

  findUserByUsername(username: string): Promise<KcUser | null> {
    return this.#findUser('username', username)
  }

  async searchUsers(q: string, opts: { first?: number; max?: number } = {}): Promise<KcUser[]> {
    const first = Math.max(0, opts.first ?? 0)
    const max = Math.min(Math.max(1, opts.max ?? 20), 100)
    const res = await this.#call<KcUser[]>(
      'GET',
      `/users?search=${enc(q)}&first=${first}&max=${max}&briefRepresentation=true`,
      { role: 'view-users' },
    )
    return (Array.isArray(res.data) ? res.data : []).filter((u) => !isServiceAccount(u))
  }

  async createUser(u: { email: string; firstName?: string; lastName?: string }): Promise<string> {
    const res = await this.#call('POST', '/users', {
      role: 'manage-users',
      body: {
        username: u.email,
        email: u.email,
        firstName: u.firstName || undefined,
        lastName: u.lastName || undefined,
        enabled: true,
        emailVerified: false,
        requiredActions: ['UPDATE_PASSWORD'],
      },
    })
    const id = idFromLocation(res.headers.get('location'))
    if (id) return id
    // No Location (a proxy stripped it): find the account just made.
    const made = await this.findUserByEmail(u.email)
    if (!made) throw new KcError('unavailable', res.status, 'Keycloak created the account but did not say which it was.')
    return made.id
  }

  async deleteUser(id: string): Promise<void> {
    await this.#call('DELETE', `/users/${enc(id)}`, { role: 'manage-users', allow: [404] })
  }

  async executeActionsEmail(
    id: string,
    opts: { lifespan?: number; clientId?: string; redirectUri?: string } = {},
  ): Promise<void> {
    const send = (withRedirect: boolean) => {
      const q = new URLSearchParams({ lifespan: String(opts.lifespan ?? SETUP_EMAIL_LIFESPAN_S) })
      if (withRedirect && opts.clientId && opts.redirectUri) {
        q.set('client_id', opts.clientId)
        q.set('redirect_uri', opts.redirectUri)
      }
      return this.#call('PUT', `/users/${enc(id)}/execute-actions-email?${q}`, {
        role: 'manage-users',
        body: ['UPDATE_PASSWORD'],
        allow: [500],
      })
    }
    let res: CallResult<unknown>
    try {
      res = await send(true)
    } catch (e) {
      // A redirect the client does not allow is a 400; the email is still
      // worth sending without the "back to the console" link.
      if (!(e instanceof KcError) || e.code !== 'invalid' || !opts.redirectUri) throw e
      res = await send(false)
    }
    if (res.status === 500) {
      throw new KcError('email_failed', 500, `Keycloak could not send the email${keycloakMessage(res.data) ? `: ${keycloakMessage(res.data)}` : ''} — check the realm's SMTP settings.`)
    }
  }

  async emailConfigured(): Promise<boolean> {
    if (this.#email && this.#now() - this.#email.at < EMAIL_CONFIG_TTL_MS) return this.#email.value
    const res = await this.#call<{ smtpServer?: Record<string, unknown> }>('GET', '', { role: 'view-realm (manage-realm implies it)' })
    const host = res.data?.smtpServer?.host
    const value = typeof host === 'string' && host.trim().length > 0
    this.#email = { at: this.#now(), value }
    return value
  }
}

/** The id at the end of a `Location: …/groups/<id>` or `…/users/<id>` header. */
export function idFromLocation(location: string | null): string | null {
  if (!location) return null
  try {
    const seg = new URL(location, 'http://x').pathname.split('/').filter(Boolean).pop()
    return seg ? decodeURIComponent(seg) : null
  } catch {
    return null
  }
}

function keycloakMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as { errorMessage?: unknown; error?: unknown; error_description?: unknown }
  const msg = d.errorMessage ?? d.error_description ?? d.error
  return typeof msg === 'string' ? msg.slice(0, 200) : ''
}

/** The path without its query, for messages (queries carry e-mail addresses). */
function route(path: string): string {
  return path.split('?')[0] || '/'
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

let singleton: KeycloakAdmin | null | undefined

/**
 * Shared admin client, or null when Keycloak isn't configured — which is only
 * ever a laptop without auth: with auth configured the console's own client is
 * the fallback credential.
 */
export function getKeycloakAdmin(): KeycloakAdmin | null {
  if (singleton !== undefined) return singleton
  const cfg = resolveConfig()
  singleton = cfg ? new KeycloakAdmin(cfg) : null
  if (!singleton) {
    console.warn('[workspace] Keycloak not configured — organisation membership cannot be read or changed')
  }
  return singleton
}

/**
 * What a client is told for each kind of Keycloak failure. Fixed wording on
 * purpose: Keycloak's own text carries its internal URL (fetch errors name
 * it), its `errorMessage`, SMTP errors and configuration hints — and the
 * membership pages are open to every member. The full detail goes to the
 * server log (`[keycloak]` lines), which is where an operator needs it.
 */
export const KC_CLIENT_DETAIL: Readonly<Record<KcErrorCode, string>> = Object.freeze({
  unconfigured: 'Keycloak is not configured for this console, so membership cannot be read or changed.',
  unavailable: 'Keycloak could not be reached or did not answer. Nothing was changed; try again shortly.',
  denied: "Keycloak refused the console's service account. An operator can find the missing realm-management role in the console's server log.",
  not_found: 'Keycloak has no such account or group.',
  conflict: 'Keycloak reported a conflict with an existing account or group.',
  invalid: 'Keycloak rejected the request as invalid.',
  email_failed: "Keycloak could not send the email. An operator can find why in the console's server log (check the realm's SMTP settings).",
})

/** HTTP for a failed Keycloak call, or null when `e` is not one. */
export function kcErrorResponse(e: unknown, extra: Record<string, unknown> = {}): Response | null {
  if (!(e instanceof KcError)) return null
  if (e.code !== 'unconfigured') console.warn(`[keycloak] ${e.code} (HTTP ${e.status}): ${e.detail}`)
  // A multi-step write Keycloak interrupted part-way did change something.
  const detail = extra.partial === true
    ? 'Keycloak stopped answering part-way, so part of the change was made. Repeating the request finishes it.'
    : KC_CLIENT_DETAIL[e.code]
  const body = (error: string, status: number) => Response.json({ error, detail, ...extra }, { status })
  switch (e.code) {
    case 'unconfigured':
      return body('keycloak_not_configured', 503)
    case 'unavailable':
      return body('keycloak_unavailable', 503)
    case 'denied':
      return body('keycloak_denied', 502)
    case 'not_found':
      return body('not_found', 404)
    case 'conflict':
      return body('conflict', 409)
    case 'invalid':
      return body('invalid_request', 400)
    case 'email_failed':
      return body('email_send_failed', 502)
  }
}

/** The refusal for "this console has no Keycloak to ask". */
export function keycloakNotConfigured(): Response {
  return kcErrorResponse(new KcError('unconfigured', 0, ''))!
}
