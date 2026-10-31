import { type DirectoryEntry, isSystemTenantId, type OrgDirectory } from './directory.ts'
import { isStoredSlug, NO_ACCESS, type OrgAccess, orgAccess, PLATFORM_ORG_SLUG } from './org-access.ts'
import { getKeycloakAdmin, type IdentityDirectory } from '../workspace/keycloak-admin.ts'

/**
 * Which organisation a request is working in — re-decided on EVERY request.
 *
 * The session remembers an `activeTenant`, but remembering is not entitlement:
 * someone removed from `org-acme` in Keycloak must stop reading acme's data,
 * and someone added must be able to open it, without the console keeping a
 * member list of its own. So the remembered tenant is checked against the
 * caller's groups each time, and replaced when they no longer entitle it:
 *
 *   1. keep the session's tenant when the token's groups entitle it;
 *   2. otherwise ask Keycloak for the caller's groups (live, cached a minute):
 *      a membership the token does not show yet still counts, and the caller
 *      should refresh the token so the rest of the console sees it too;
 *   3. otherwise the organisation they last activated, the platform's own, or
 *      the first by name — whichever their groups entitle, among organisations
 *      they have opened before (their registry) and the platform's own. Being
 *      ADDED to an organisation does not move anyone into it: they see it in
 *      the switcher and open it themselves. Any organisation admin can add any
 *      account, and without this they could put someone in front of their
 *      organisation on that person's next click without being asked;
 *   4. otherwise a PERSONAL tenant: private, empty, and never an organisation.
 *      It used to be the shared `default` workspace, which is how every
 *      self-registered account landed in the platform's own organisation.
 *
 * When the directory cannot be read nothing can be checked, so the answer
 * fails CLOSED to the personal tenant (flagged `degraded`) — never the
 * remembered one. Most routes that read and write tenant data (`/api/store`,
 * notifications, …) only see `activeTenant`; handing them a tenant nobody
 * checked would serve an organisation's data to someone removed from it for
 * exactly as long as the outage lasts.
 */

/** Prefix of personal tenants. Organisation tenant ids never start with `_`. */
export const PERSONAL_PREFIX = '_u_'

const HEX = '0123456789abcdef'

/** The caller's own private tenant — derived from their subject, unguessable to others. */
export async function personalTenantId(sub: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub)))
  let hex = ''
  for (const b of digest) hex += HEX[b >> 4] + HEX[b & 15]
  return `${PERSONAL_PREFIX}${hex.slice(0, 24)}`
}

export const isPersonalTenantId = (id: string): boolean => id.startsWith(PERSONAL_PREFIX)

/* ─────────────────── live groups ─────────────────── */

export interface LiveGroups {
  /** The user's groups from Keycloak, or null when Keycloak could not be asked. */
  get(userId: string, maxAgeMs?: number): Promise<string[] | null>
  /** Forget a user's answer — after the console changed their groups. */
  invalidate(userId: string): void
}

const LIVE_TTL_MS = 60_000
const LIVE_TIMEOUT_MS = 3_000
const LIVE_MAX = 5_000

/**
 * A short-lived cache of users' live group sets. A failure is never cached,
 * so the next request asks again rather than serving "no groups".
 */
export function createLiveGroups(
  kc: () => IdentityDirectory | null,
  opts: { now?: () => number; timeoutMs?: number } = {},
): LiveGroups {
  const now = opts.now ?? Date.now
  const cache = new Map<string, { at: number; groups: string[] }>()
  const inflight = new Map<string, Promise<string[] | null>>()
  return {
    get(userId, maxAgeMs = LIVE_TTL_MS) {
      const hit = cache.get(userId)
      if (hit && now() - hit.at < maxAgeMs) return Promise.resolve(hit.groups)
      const running = inflight.get(userId)
      if (running) return running
      const client = kc()
      if (!client) return Promise.resolve(null)
      const p = (async () => {
        try {
          const groups = await client.getUserGroups(userId, { timeoutMs: opts.timeoutMs ?? LIVE_TIMEOUT_MS })
          if (cache.size >= LIVE_MAX) cache.delete(cache.keys().next().value!)
          cache.set(userId, { at: now(), groups })
          return groups
        } catch {
          return null
        } finally {
          inflight.delete(userId)
        }
      })()
      inflight.set(userId, p)
      return p
    },
    invalidate(userId) {
      cache.delete(userId)
    },
  }
}

/** The process-wide cache, over the console's Keycloak admin client. */
export const sharedLiveGroups: LiveGroups = createLiveGroups(() => getKeycloakAdmin())

/* ─────────────────── resolution ─────────────────── */

export interface ResolvedTenant {
  tenant: string
  /** The organisation `tenant` holds; null for a personal tenant. */
  org: DirectoryEntry | null
  /** The caller's role there, by the groups that decided it. */
  access: OrgAccess
  personal: boolean
  /**
   * Keycloak entitles `tenant` but the token's groups do not: refresh the
   * session so the token (and everything that reads it) catches up.
   */
  needsRefresh: boolean
  /** The directory could not be read, so no organisation could be resolved. */
  degraded: boolean
}

export interface EntitlementDeps {
  directory: OrgDirectory
  liveGroups: LiveGroups
  /** The organisation the user last activated (their registry's `activeId`). */
  registryActiveId(userId: string): Promise<string | null>
  /** The organisations the user created or opened themselves (their registry). */
  registryOrgIds(userId: string): Promise<string[]>
  /**
   * A laptop with no identity provider: the session tenant is kept as it is
   * and, when the directory does not know it, stands for itself.
   */
  devMode: boolean
}

const byName = (a: DirectoryEntry, b: DirectoryEntry) =>
  a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug)

/** The organisations `groups` entitle, platform first then by name. */
export function entitledEntries(
  entries: DirectoryEntry[],
  groups: readonly string[],
): Array<{ entry: DirectoryEntry; access: OrgAccess }> {
  return entries
    .map((entry) => ({ entry, access: orgAccess(groups, entry.slug) }))
    .filter((x) => x.access.role !== null)
}

export async function resolveActiveTenant(
  input: { userId: string; groups: readonly string[]; sessionTenant: string },
  deps: EntitlementDeps,
): Promise<ResolvedTenant> {
  const personal = await personalTenantId(input.userId)
  const session = input.sessionTenant
  const done = (
    tenant: string,
    org: DirectoryEntry | null,
    access: OrgAccess,
    extra: Partial<ResolvedTenant> = {},
  ): ResolvedTenant => ({
    tenant,
    org,
    access,
    personal: org === null && tenant === personal,
    needsRefresh: false,
    degraded: false,
    ...extra,
  })

  let entries: DirectoryEntry[]
  try {
    entries = (await deps.directory.entries()).filter((e) => !isSystemTenantId(e.tenantId))
  } catch {
    // Without the directory no entitlement can be checked: fail closed to the
    // caller's own private tenant, and say so. The session keeps remembering
    // its organisation (request-user.ts does not re-sign it), so the next
    // request after the outage goes straight back there.
    return done(personal, null, NO_ACCESS, { degraded: true, personal: true })
  }
  const byTenant = (t: string) => entries.find((e) => e.tenantId === t) ?? null

  if (deps.devMode) {
    const org = byTenant(session) ?? (isStoredSlug(session) ? devEntry(session) : null)
    return done(session, org, org ? orgAccess(input.groups, org.slug) : NO_ACCESS)
  }

  // 1. The remembered organisation, if the token still entitles it. A tenant
  // this replica does not know may be one created elsewhere a moment ago.
  let remembered = session && session !== personal ? byTenant(session) : null
  if (!remembered && session && session !== personal && !isSystemTenantId(session)) {
    remembered = await deps.directory.byTenant(session, { refreshOnMiss: true }).catch(() => null)
    if (remembered && isSystemTenantId(remembered.tenantId)) remembered = null
    if (remembered) entries = (await deps.directory.entries()).filter((e) => !isSystemTenantId(e.tenantId))
  }
  if (remembered) {
    const access = orgAccess(input.groups, remembered.slug)
    if (access.role) return done(session, remembered, access)
  }

  // 2. A miss: what does Keycloak say right now?
  const live = await deps.liveGroups.get(input.userId)
  if (live && remembered) {
    const access = orgAccess(live, remembered.slug)
    if (access.role) return done(session, remembered, access, { needsRefresh: true })
  }

  // 3. Some other organisation they belong to — one they chose before, or the
  // platform's own. A membership they never opened waits for them to open it.
  const groups = live ?? input.groups
  const opened = new Set(await deps.registryOrgIds(input.userId).catch(() => [] as string[]))
  const candidates = entitledEntries(entries, groups)
    .filter((c) => c.entry.slug === PLATFORM_ORG_SLUG || opened.has(c.entry.tenantId))
  if (candidates.length > 0) {
    const activeId = await deps.registryActiveId(input.userId).catch(() => null)
    const pick = (activeId ? candidates.find((c) => c.entry.tenantId === activeId) : undefined) ??
      candidates.find((c) => c.entry.slug === PLATFORM_ORG_SLUG) ??
      [...candidates].sort((a, b) => byName(a.entry, b.entry))[0]
    const tokenKnows = orgAccess(input.groups, pick.entry.slug).role !== null
    return done(pick.entry.tenantId, pick.entry, pick.access, { needsRefresh: !tokenKnows })
  }

  // 4. Nowhere: their own private tenant.
  return done(personal, null, NO_ACCESS)
}

function devEntry(slug: string): DirectoryEntry {
  return { slug, tenantId: slug, name: slug.charAt(0).toUpperCase() + slug.slice(1), createdAt: new Date(0).toISOString() }
}
