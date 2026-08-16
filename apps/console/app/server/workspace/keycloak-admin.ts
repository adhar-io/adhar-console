import { getServerAuthConfig } from '@adhar-console/auth/server'
import { env } from '@adhar-console/utils'

/**
 * Minimal Keycloak Admin REST client used to reflect workspace teams and org
 * roles into realm groups so cluster RBAC (group-based bindings) matches what
 * the console shows.
 *
 * Credentials: a dedicated service account (`KEYCLOAK_ADMIN_CLIENT_ID` /
 * `KEYCLOAK_ADMIN_CLIENT_SECRET`, client-credentials grant) or — as a fallback
 * — the console's own confidential client, which works when that client has
 * the `manage-users` / `manage-groups` service-account roles.
 *
 * EVERY method degrades gracefully: a missing credential or a 401/403/network
 * failure logs a warning and reports `false`/`null` — persistence in Postgres
 * must never be rolled back because group reflection failed. Callers surface
 * the result as a `keycloakSynced` flag so the UI can show "console-only" vs
 * "synced to RBAC".
 *
 * TLS: Deno trusts `DENO_CERT` process-wide, so in-cluster HTTPS endpoints
 * with a private CA work without extra plumbing.
 */

export interface KcGroup {
  id: string
  name: string
  path: string
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

export class KeycloakAdmin {
  #cfg: KcConfig
  #token: { value: string; expiresAt: number } | null = null
  #groupIds = new Map<string, string>()

  constructor(cfg: KcConfig) {
    this.#cfg = cfg
  }

  async #accessToken(): Promise<string | null> {
    if (this.#token && this.#token.expiresAt > Date.now() + 5_000) return this.#token.value
    const url = `${this.#cfg.base}/realms/${this.#cfg.realm}/protocol/openid-connect/token`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.#cfg.clientId,
          client_secret: this.#cfg.clientSecret,
        }),
      })
      if (!res.ok) {
        console.warn(`[workspace] keycloak admin token request failed (${res.status})`)
        return null
      }
      const body = (await res.json()) as { access_token: string; expires_in?: number }
      this.#token = {
        value: body.access_token,
        expiresAt: Date.now() + Math.max(30, (body.expires_in ?? 60) - 10) * 1000,
      }
      return this.#token.value
    } catch (e) {
      console.warn('[workspace] keycloak admin token request errored:', e)
      return null
    }
  }

  async #call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: T | null }> {
    const token = await this.#accessToken()
    if (!token) return { ok: false, status: 0, data: null }
    const url = `${this.#cfg.base}/admin/realms/${this.#cfg.realm}${path}`
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (res.status === 401 || res.status === 403) {
        console.warn(`[workspace] keycloak admin call ${method} ${path} denied (${res.status}) — check the admin client's service-account roles`)
        return { ok: false, status: res.status, data: null }
      }
      let data: T | null = null
      const text = await res.text()
      if (text) {
        try {
          data = JSON.parse(text) as T
        } catch {
          data = null
        }
      }
      return { ok: res.ok, status: res.status, data }
    } catch (e) {
      console.warn(`[workspace] keycloak admin call ${method} ${path} errored:`, e)
      return { ok: false, status: 0, data: null }
    }
  }

  /** All top-level realm groups. */
  async listGroups(): Promise<KcGroup[]> {
    const res = await this.#call<KcGroup[]>('GET', '/groups?briefRepresentation=true&max=500')
    return res.ok && res.data ? res.data : []
  }

  /** Find a top-level group by exact name. */
  async findGroup(name: string): Promise<KcGroup | null> {
    const cachedId = this.#groupIds.get(name)
    if (cachedId) return { id: cachedId, name, path: `/${name}` }
    const res = await this.#call<KcGroup[]>(
      'GET',
      `/groups?search=${encodeURIComponent(name)}&exact=true&max=10`,
    )
    const hit = res.data?.find((g) => g.name === name) ?? null
    if (hit) this.#groupIds.set(name, hit.id)
    return hit
  }

  /** Create the group if absent. Returns the group, or null on failure. */
  async ensureGroup(name: string): Promise<KcGroup | null> {
    const existing = await this.findGroup(name)
    if (existing) return existing
    const created = await this.#call('POST', '/groups', { name })
    if (!created.ok && created.status !== 409) return null
    return await this.findGroup(name)
  }

  /** Delete a top-level group by name (best-effort). */
  async deleteGroup(name: string): Promise<boolean> {
    const group = await this.findGroup(name)
    if (!group) return true
    const res = await this.#call('DELETE', `/groups/${group.id}`)
    if (res.ok) this.#groupIds.delete(name)
    return res.ok
  }

  /** Resolve a Keycloak user id from a user id (sub), email, or username. */
  async resolveUserId(ref: string): Promise<string | null> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
      return ref
    }
    const byEmail = ref.includes('@')
      ? await this.#call<{ id: string }[]>(
          'GET',
          `/users?email=${encodeURIComponent(ref)}&exact=true&max=2`,
        )
      : await this.#call<{ id: string }[]>(
          'GET',
          `/users?username=${encodeURIComponent(ref)}&exact=true&max=2`,
        )
    return byEmail.data?.[0]?.id ?? null
  }

  /** Put a user (id/email/username) into a group, creating the group if needed. */
  async addUserToGroup(userRef: string, groupName: string): Promise<boolean> {
    const [userId, group] = await Promise.all([
      this.resolveUserId(userRef),
      this.ensureGroup(groupName),
    ])
    if (!userId || !group) return false
    const res = await this.#call('PUT', `/users/${userId}/groups/${group.id}`)
    return res.ok
  }

  /** Remove a user (id/email/username) from a group, if both exist. */
  async removeUserFromGroup(userRef: string, groupName: string): Promise<boolean> {
    const [userId, group] = await Promise.all([
      this.resolveUserId(userRef),
      this.findGroup(groupName),
    ])
    if (!group) return true // group gone — nothing to remove
    if (!userId) return false
    const res = await this.#call('DELETE', `/users/${userId}/groups/${group.id}`)
    return res.ok || res.status === 404
  }
}

let singleton: KeycloakAdmin | null | undefined

/**
 * Shared admin client, or null when Keycloak isn't configured (dev/stub mode).
 * Null simply means "console-only" — persistence proceeds without RBAC sync.
 */
export function getKeycloakAdmin(): KeycloakAdmin | null {
  if (singleton !== undefined) return singleton
  const cfg = resolveConfig()
  singleton = cfg ? new KeycloakAdmin(cfg) : null
  if (!singleton) {
    console.warn('[workspace] Keycloak not configured — team/role changes stay console-only')
  }
  return singleton
}

/** Group-name conventions shared by teams and org roles. */
export const groupForTeam = (slug: string) => `ws-team-${slug}`
export const groupForRole = (role: string) => `ws-role-${role}`
