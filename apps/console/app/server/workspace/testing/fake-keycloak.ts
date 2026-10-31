import { KeycloakAdmin } from '../keycloak-admin.ts'

/**
 * A fake Keycloak at the HTTP level: the subset of the Admin REST API the
 * console's client (keycloak-admin.ts) calls, over an in-memory realm. Tests
 * drive the REAL client through it, so request shapes, paging, error mapping
 * and caching are exercised exactly as against Keycloak.
 *
 * Failure injection: `down` (every admin call fails at the network), `deny`
 * (every admin call 403s), `failOn` (per request), `afterWrite` (run a hook
 * after a successful write — a concurrent change by someone else).
 */

export interface FakeUser {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled: boolean
  emailVerified: boolean
  createdTimestamp: number
  requiredActions: string[]
}

interface FakeGroup {
  id: string
  name: string
  parentId?: string
}

export interface FakeCall {
  method: string
  path: string
  query: URLSearchParams
}

const BASE = 'http://kc.test'
const REALM = 'adhar'

let counter = 0
const uuid = () => crypto.randomUUID()

export class FakeKeycloak {
  users = new Map<string, FakeUser>()
  groups = new Map<string, FakeGroup>()
  members = new Map<string, Set<string>>()
  smtpHost: string | null = 'smtp.example.test'
  /** Redirect URIs the console client accepts on execute-actions-email. */
  validRedirectPrefix = 'https://console.example.test'
  /** Status execute-actions-email answers (500 = SMTP failure). */
  emailStatus = 204
  emails: Array<{ userId: string; actions: unknown; query: URLSearchParams }> = []
  calls: FakeCall[] = []
  tokenRequests = 0
  down = false
  deny = false
  failOn: ((c: FakeCall) => number | 'network' | null) | null = null
  afterWrite: ((c: FakeCall) => void) | null = null
  /** The clock createdTimestamp is stamped from. */
  now: () => number = Date.now

  /** The real admin client, wired to this fake. */
  client(): KeycloakAdmin {
    return new KeycloakAdmin(
      { base: BASE, realm: REALM, clientId: 'adhar-console', clientSecret: 'not-a-secret' },
      { fetch: (input, init) => this.fetch(input, init) },
    )
  }

  addUser(u: Partial<FakeUser> & { username: string }): string {
    const id = u.id ?? uuid()
    this.users.set(id, {
      id,
      username: u.username,
      email: u.email ?? (u.username.includes('@') ? u.username : undefined),
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: u.enabled ?? true,
      emailVerified: u.emailVerified ?? true,
      createdTimestamp: u.createdTimestamp ?? this.now() - 86_400_000,
      requiredActions: u.requiredActions ?? [],
    })
    return id
  }

  addGroup(name: string, parentName?: string): string {
    const parent = parentName ? this.#topLevel(parentName) ?? this.groups.get(this.addGroup(parentName)) : undefined
    const id = `g-${++counter}-${name}`
    this.groups.set(id, { id, name, ...(parent ? { parentId: parent.id } : {}) })
    this.members.set(id, new Set())
    return id
  }

  /** Put a user in a TOP-LEVEL group (created when missing). */
  join(userId: string, groupName: string): void {
    const g = this.#topLevel(groupName) ?? this.groups.get(this.addGroup(groupName))!
    this.members.get(g.id)!.add(userId)
  }

  leave(userId: string, groupName: string): void {
    const g = this.#topLevel(groupName)
    if (g) this.members.get(g.id)!.delete(userId)
  }

  hasGroup(name: string): boolean {
    return this.#topLevel(name) !== undefined
  }

  /** Top-level group names the user is in. */
  groupsOf(userId: string): string[] {
    return [...this.groups.values()]
      .filter((g) => !g.parentId && this.members.get(g.id)!.has(userId))
      .map((g) => g.name)
      .sort()
  }

  membersOf(groupName: string): string[] {
    const g = this.#topLevel(groupName)
    return g ? [...this.members.get(g.id)!].sort() : []
  }

  /** Calls that change something. */
  writes(): FakeCall[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }

  #topLevel(name: string): FakeGroup | undefined {
    return [...this.groups.values()].find((g) => !g.parentId && g.name === name)
  }

  #path(g: FakeGroup): string {
    const parent = g.parentId ? this.groups.get(g.parentId) : undefined
    return parent ? `${this.#path(parent)}/${g.name}` : `/${g.name}`
  }

  #user(u: FakeUser, brief: boolean) {
    const out: Record<string, unknown> = {
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: u.enabled,
      emailVerified: u.emailVerified,
      createdTimestamp: u.createdTimestamp,
    }
    if (!brief) out.requiredActions = [...u.requiredActions]
    return out
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await Promise.resolve()
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.pathname === `/realms/${REALM}/protocol/openid-connect/token`) {
      this.tokenRequests++
      if (this.down) throw new TypeError('connection refused')
      return Response.json({ access_token: `tok-${this.tokenRequests}`, expires_in: 300 })
    }
    const prefix = `/admin/realms/${REALM}`
    if (!url.pathname.startsWith(prefix)) return new Response('not found', { status: 404 })
    const path = url.pathname.slice(prefix.length) || '/'
    const call: FakeCall = { method, path, query: url.searchParams }
    this.calls.push(call)
    if (this.down) throw new TypeError('connection refused')
    if (this.deny) return Response.json({ error: 'forbidden' }, { status: 403 })
    const injected = this.failOn?.(call)
    if (injected === 'network') throw new TypeError('connection reset')
    if (typeof injected === 'number') return Response.json({ errorMessage: 'injected' }, { status: injected })
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const res = this.#route(method, path, url.searchParams, body)
    if (res.status < 300 && method !== 'GET') this.afterWrite?.(call)
    return res
  }

  #route(method: string, path: string, q: URLSearchParams, body: unknown): Response {
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
    const notFound = (what: string) => Response.json({ error: `${what} not found` }, { status: 404 })

    if (seg.length === 0 && method === 'GET') {
      return Response.json({ realm: REALM, smtpServer: this.smtpHost ? { host: this.smtpHost, from: 'kc@example.test' } : {} })
    }

    if (seg[0] === 'groups') {
      if (seg.length === 1 && method === 'GET') {
        const search = q.get('search') ?? ''
        const exact = q.get('exact') === 'true'
        const hit = (g: FakeGroup) => (exact ? g.name === search : g.name.includes(search))
        // Like Keycloak: top-level groups that match, or that have a matching
        // subgroup (returned with that subgroup under subGroups).
        const out = [...this.groups.values()]
          .filter((g) => !g.parentId)
          .filter((g) => hit(g) || [...this.groups.values()].some((s) => s.parentId === g.id && hit(s)))
          .map((g) => ({ id: g.id, name: g.name, path: this.#path(g) }))
        return Response.json(out.slice(0, Number(q.get('max') ?? 100)))
      }
      if (seg.length === 1 && method === 'POST') {
        const name = (body as { name: string }).name
        if (this.#topLevel(name)) return Response.json({ errorMessage: 'Top level group named exists' }, { status: 409 })
        const id = this.addGroup(name)
        return new Response(null, { status: 201, headers: { location: `${BASE}/admin/realms/${REALM}/groups/${id}` } })
      }
      const g = this.groups.get(seg[1])
      if (seg.length === 2 && method === 'DELETE') {
        if (!g) return notFound('group')
        this.groups.delete(g.id)
        this.members.delete(g.id)
        return new Response(null, { status: 204 })
      }
      if (seg.length === 3 && seg[2] === 'members' && method === 'GET') {
        if (!g) return notFound('group')
        const first = Number(q.get('first') ?? 0)
        const max = Number(q.get('max') ?? 100)
        const brief = q.get('briefRepresentation') !== 'false'
        const ids = [...this.members.get(g.id)!].sort()
        return Response.json(ids.slice(first, first + max).map((id) => this.#user(this.users.get(id)!, brief)))
      }
    }

    if (seg[0] === 'users') {
      if (seg.length === 1 && method === 'GET') {
        const brief = q.get('briefRepresentation') !== 'false'
        let list = [...this.users.values()]
        if (q.has('email')) list = list.filter((u) => u.email?.toLowerCase() === q.get('email')!.toLowerCase())
        if (q.has('username')) list = list.filter((u) => u.username.toLowerCase() === q.get('username')!.toLowerCase())
        if (q.has('search')) {
          const s = q.get('search')!.toLowerCase()
          list = list.filter((u) => [u.username, u.email, u.firstName, u.lastName].some((v) => v?.toLowerCase().includes(s)))
        }
        const first = Number(q.get('first') ?? 0)
        const max = Number(q.get('max') ?? 100)
        return Response.json(list.slice(first, first + max).map((u) => this.#user(u, brief)))
      }
      if (seg.length === 1 && method === 'POST') {
        const b = body as Partial<FakeUser>
        const clash = [...this.users.values()].some((u) =>
          u.username.toLowerCase() === b.username?.toLowerCase() || (b.email && u.email?.toLowerCase() === b.email.toLowerCase())
        )
        if (clash) return Response.json({ errorMessage: 'User exists with same username' }, { status: 409 })
        const id = this.addUser({ ...b, username: b.username!, createdTimestamp: this.now() })
        return new Response(null, { status: 201, headers: { location: `${BASE}/admin/realms/${REALM}/users/${id}` } })
      }
      const u = this.users.get(seg[1])
      if (seg.length === 2 && method === 'GET') return u ? Response.json(this.#user(u, false)) : notFound('user')
      if (seg.length === 2 && method === 'DELETE') {
        if (!u) return notFound('user')
        this.users.delete(u.id)
        for (const set of this.members.values()) set.delete(u.id)
        return new Response(null, { status: 204 })
      }
      if (seg.length === 3 && seg[2] === 'groups' && method === 'GET') {
        if (!u) return notFound('user')
        const out = [...this.groups.values()]
          .filter((g) => this.members.get(g.id)!.has(u.id))
          .map((g) => ({ id: g.id, name: g.name, path: this.#path(g) }))
        return Response.json(out)
      }
      if (seg.length === 4 && seg[2] === 'groups') {
        const g = this.groups.get(seg[3])
        if (!u) return notFound('user')
        if (!g) return notFound('group')
        if (method === 'PUT') this.members.get(g.id)!.add(u.id)
        else if (method === 'DELETE') this.members.get(g.id)!.delete(u.id)
        else return new Response(null, { status: 405 })
        return new Response(null, { status: 204 })
      }
      if (seg.length === 3 && seg[2] === 'execute-actions-email' && method === 'PUT') {
        if (!u) return notFound('user')
        const redirect = q.get('redirect_uri')
        if (redirect && !redirect.startsWith(this.validRedirectPrefix)) {
          return Response.json({ errorMessage: 'Invalid redirect uri.' }, { status: 400 })
        }
        if (this.emailStatus >= 300) {
          return Response.json({ errorMessage: 'Failed to send execute actions email' }, { status: this.emailStatus })
        }
        this.emails.push({ userId: u.id, actions: body, query: q })
        return new Response(null, { status: 204 })
      }
    }
    return new Response('not implemented in the fake', { status: 501 })
  }
}
