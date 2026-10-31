import { env } from '@adhar/utils'
import { isStoredSlug, PLATFORM_ORG_SLUG, PLATFORM_TENANT_ID, RESERVED_ORG_SLUGS } from './org-access.ts'

/**
 * The organisation directory — which tenant id holds which organisation.
 *
 * The console keeps an organisation's own data (teams, projects, OKRs, …)
 * under a random tenant id, `acme-x1y2z`, while everything the platform knows
 * the organisation by — the Keycloak groups `org-acme`/`org-acme-admin`, the
 * namespace, the Gitea org, the Organisation XR — is named by its slug, `acme`.
 * Membership now comes from those groups, so "which organisations may this
 * person open" is a question about slugs, and the answer has to be turned back
 * into tenant ids. That mapping used to live only in the CREATOR's per-user
 * registry: a member added in Keycloak had no way to reach the tenant.
 *
 * One shared directory instead, in the console database's `_directory` tenant
 * (`workspace.org-directory`, id = slug, never reachable as a session tenant):
 *
 *   - built from every per-user registry (what creators already recorded) plus
 *     the entries written on create / rename / delete and by the migration;
 *   - the platform's own organisation is always present as `adhar → default` —
 *     the tenant every console has kept its default workspace in — and wins
 *     any conflict over that slug or tenant;
 *   - one slug in several registries resolves to the EARLIEST created entry, and
 *     the conflict is logged; a stored entry beats a registry-derived one;
 *   - one tenant holds ONE organisation: a second slug pointing at a tenant
 *     already held is dropped and logged (the slug decides which groups
 *     entitle the tenant, so two would make either set enough);
 *   - an organisation named `<x>-admin` beside an organisation `<x>` is dropped
 *     and logged: its member group `org-<x>-admin` IS `<x>`'s admin group, so
 *     being added to it would make someone `<x>`'s admin. New names cannot end
 *     in `-admin`; an existing pair needs an operator to rename one of them;
 *   - the console's own system tenants (`auth`, `_directory`, anything with a
 *     leading `_`) are never an organisation's;
 *   - a deleted organisation leaves a tombstone, because the registries that
 *     named it still do and would otherwise bring it back.
 *
 * Reads are cached for a minute per replica; this replica's writes invalidate.
 */

export const DIRECTORY_TENANT = '_directory'
export const DIRECTORY_KIND = 'workspace.org-directory'
const TTL_MS = 60_000
/** A miss may re-read the directory, but not more often than this. */
const MISS_REFRESH_GAP_MS = 5_000

export interface DirectoryEntry {
  slug: string
  /** The console tenant id the organisation's data lives under. */
  tenantId: string
  name: string
  description?: string
  createdAt: string
  createdBy?: string
}

interface StoredEntry extends DirectoryEntry {
  /** A deleted organisation (tombstone). */
  deletedAt?: string
}

/** Where entries come from; the database in production, memory in tests. */
export interface DirectorySource {
  listStored(): Promise<Array<{ id: string; data: Record<string, unknown> }>>
  putStored(slug: string, data: Record<string, unknown>, by: string): Promise<void>
  /** Every user's `organizations` registry document. */
  listRegistries(): Promise<Array<{ userId: string; data: Record<string, unknown> }>>
}

/** Tenant ids a console organisation can have (organizations.ts mints them). */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Tenant ids the console uses for its own records — the session store
 * (session-store-db.ts) and this directory. Personal tenants start with `_`
 * too. No organisation may hold one, and no session may be scoped to one by
 * choosing an organisation.
 */
export const SYSTEM_TENANTS: ReadonlySet<string> = new Set(['auth', DIRECTORY_TENANT])
export const isSystemTenantId = (id: string): boolean => SYSTEM_TENANTS.has(id) || id.startsWith('_')

export const PLATFORM_ENTRY: DirectoryEntry = Object.freeze({
  slug: PLATFORM_ORG_SLUG,
  tenantId: PLATFORM_TENANT_ID,
  name: 'Adhar',
  description: "The platform's own organisation.",
  createdAt: '1970-01-01T00:00:00.000Z',
})

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

function entryOf(raw: Record<string, unknown>): StoredEntry | null {
  const slug = str(raw.slug)
  const tenantId = str(raw.tenantId) ?? str(raw.id)
  if (!slug || !tenantId) return null
  return {
    slug,
    tenantId,
    name: str(raw.name) ?? slug,
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    createdAt: str(raw.createdAt) ?? new Date(0).toISOString(),
    ...(str(raw.createdBy) ? { createdBy: str(raw.createdBy) } : {}),
    ...(str(raw.deletedAt) ? { deletedAt: str(raw.deletedAt) } : {}),
  }
}

/** Why an entry cannot be an organisation, or null when it can. */
function unusable(e: DirectoryEntry): string | null {
  if (!isStoredSlug(e.slug)) return 'slug is not a DNS label'
  if (RESERVED_ORG_SLUGS.has(e.slug)) return 'reserved slug'
  if (isSystemTenantId(e.tenantId)) return 'tenant id is one of the console\'s own'
  if (!TENANT_ID_RE.test(e.tenantId)) return 'tenant id is not a console tenant'
  // The platform pair is fixed: no registry may claim either half of it.
  if ((e.slug === PLATFORM_ORG_SLUG) !== (e.tenantId === PLATFORM_TENANT_ID)) return 'claims the platform organisation'
  return null
}

/**
 * Merge stored entries and registries into the directory. Pure, so the
 * precedence rules are tested without a database.
 */
export function buildDirectory(
  stored: Array<{ id: string; data: Record<string, unknown> }>,
  registries: Array<{ userId: string; data: Record<string, unknown> }>,
): { entries: DirectoryEntry[]; conflicts: string[] } {
  const conflicts: string[] = []
  const bySlug = new Map<string, DirectoryEntry & { stored: boolean }>()
  const deadTenants = new Set<string>()
  const deadSlugs = new Set<string>()

  let platform: DirectoryEntry = PLATFORM_ENTRY
  for (const doc of stored) {
    const e = entryOf({ ...doc.data, slug: doc.data.slug ?? doc.id })
    if (!e) continue
    if (e.deletedAt) {
      deadTenants.add(e.tenantId)
      deadSlugs.add(e.slug)
      continue
    }
    if (e.slug === PLATFORM_ORG_SLUG && e.tenantId === PLATFORM_TENANT_ID) {
      // Renaming the platform organisation is allowed; moving it is not.
      platform = { ...PLATFORM_ENTRY, name: e.name, ...(e.description ? { description: e.description } : {}) }
      continue
    }
    const why = unusable(e)
    if (why) {
      conflicts.push(`stored ${e.slug} → ${e.tenantId} ignored: ${why}`)
      continue
    }
    bySlug.set(e.slug, { ...stripDeleted(e), stored: true })
  }

  for (const reg of registries) {
    const orgs = Array.isArray(reg.data.orgs) ? reg.data.orgs : []
    for (const raw of orgs) {
      if (!raw || typeof raw !== 'object') continue
      const e = entryOf(raw as Record<string, unknown>)
      if (!e || e.deletedAt) continue
      // `readRegistry` seeds a placeholder whose slug IS its id (`default`, or
      // the session's tenant); a created organisation's id always carries a
      // random suffix. A seed is not an organisation.
      if (e.tenantId === e.slug || e.tenantId === PLATFORM_TENANT_ID) continue
      if (unusable(e) || deadTenants.has(e.tenantId)) continue
      const have = bySlug.get(e.slug)
      if (!have) {
        if (!deadSlugs.has(e.slug)) bySlug.set(e.slug, { ...e, stored: false })
        continue
      }
      if (have.tenantId === e.tenantId) {
        // The creator's copy names it best; anyone else's may be stale.
        if (!have.stored && e.createdBy === reg.userId && have.createdBy !== reg.userId) bySlug.set(e.slug, { ...e, stored: false })
        continue
      }
      if (have.stored || have.createdAt <= e.createdAt) {
        conflicts.push(`slug ${e.slug}: tenant ${e.tenantId} ignored, ${have.tenantId} holds it`)
        continue
      }
      conflicts.push(`slug ${e.slug}: tenant ${have.tenantId} ignored, ${e.tenantId} is older`)
      bySlug.set(e.slug, { ...e, stored: false })
    }
  }

  // One tenant, one organisation. Stored entries first (they were written on
  // purpose), then the oldest; a later slug for a tenant already held is
  // dropped rather than left to decide, by sort order, which groups entitle it.
  const byTenant = new Map<string, string>()
  const kept: Array<DirectoryEntry & { stored: boolean }> = []
  const precedence = [...bySlug.values()].sort((a, b) =>
    Number(b.stored) - Number(a.stored) || a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug)
  )
  for (const e of precedence) {
    const holder = byTenant.get(e.tenantId)
    if (holder) {
      conflicts.push(`slug ${e.slug} ignored: tenant ${e.tenantId} already holds ${holder}`)
      continue
    }
    byTenant.set(e.tenantId, e.slug)
    kept.push(e)
  }

  // `x` and `x-admin` side by side make org-x-admin both x's admin group and
  // x-admin's member group: anyone put in x-admin as a member would be x's
  // admin. New slugs cannot end in -admin, so only an older pair can get here —
  // and it is dropped, never resolved, entitled or migrated, until an operator
  // renames one of them. The platform's own slug counts as an `x`.
  const slugs = new Set([platform.slug, ...kept.map((e) => e.slug)])
  const rest: DirectoryEntry[] = []
  for (const { stored: _s, ...e } of kept) {
    const base = e.slug.endsWith('-admin') ? e.slug.slice(0, -'-admin'.length) : ''
    if (base && slugs.has(base)) {
      conflicts.push(
        `slug ${e.slug} ignored: its member group org-${e.slug} is the admin group of ${base} — rename one of them`,
      )
      continue
    }
    rest.push(e)
  }
  rest.sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
  return { entries: [platform, ...rest], conflicts }
}

/**
 * Why `entry` could not be recorded as an organisation, or null when it can —
 * for the create path, so nothing is written to Keycloak for an organisation
 * the directory would then refuse.
 */
export function entryProblem(entry: DirectoryEntry): string | null {
  if (entry.slug === PLATFORM_ORG_SLUG && entry.tenantId === PLATFORM_TENANT_ID) return null
  return unusable(entry)
}

function stripDeleted(e: StoredEntry): DirectoryEntry {
  const { deletedAt: _d, ...rest } = e
  return rest
}

/** The directory could not be read (database down) — distinct from "no such organisation". */
export class DirectoryUnavailable extends Error {
  constructor(cause: unknown) {
    super(`organisation directory unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'DirectoryUnavailable'
  }
}

export class OrgDirectory {
  #source: DirectorySource | null
  #now: () => number
  #log: (line: string) => void
  #cache: { at: number; entries: DirectoryEntry[] } | null = null
  #inflight: Promise<DirectoryEntry[]> | null = null
  #reported = new Set<string>()

  constructor(
    source: DirectorySource | null,
    opts: { now?: () => number; log?: (line: string) => void } = {},
  ) {
    this.#source = source
    this.#now = opts.now ?? Date.now
    this.#log = opts.log ?? ((line) => console.warn(line))
  }

  /** Every organisation, the platform's first. Throws `DirectoryUnavailable`. */
  entries(): Promise<DirectoryEntry[]> {
    if (this.#cache && this.#now() - this.#cache.at < TTL_MS) return Promise.resolve(this.#cache.entries)
    if (!this.#source) return Promise.resolve([PLATFORM_ENTRY])
    if (!this.#inflight) {
      const source = this.#source
      this.#inflight = (async () => {
        try {
          const [stored, registries] = await Promise.all([source.listStored(), source.listRegistries()])
          const { entries, conflicts } = buildDirectory(stored, registries)
          for (const c of conflicts) {
            if (this.#reported.has(c)) continue
            this.#reported.add(c)
            this.#log(`[org-directory] ${c}`)
          }
          this.#cache = { at: this.#now(), entries }
          return entries
        } catch (e) {
          throw new DirectoryUnavailable(e)
        } finally {
          this.#inflight = null
        }
      })()
    }
    return this.#inflight
  }

  async bySlug(slug: string): Promise<DirectoryEntry | null> {
    return (await this.entries()).find((e) => e.slug === slug) ?? null
  }

  /**
   * The organisation a tenant holds. `refreshOnMiss` re-reads the directory
   * once (at most every few seconds) before answering "none": an organisation
   * created on ANOTHER replica a moment ago is not in this replica's cache yet,
   * and its creator's very next request may land here.
   */
  async byTenant(tenantId: string, opts: { refreshOnMiss?: boolean } = {}): Promise<DirectoryEntry | null> {
    if (!tenantId) return null
    const find = (entries: DirectoryEntry[]) => entries.find((e) => e.tenantId === tenantId) ?? null
    const hit = find(await this.entries())
    if (hit || !opts.refreshOnMiss || !this.#source) return hit
    if (this.#cache && this.#now() - this.#cache.at < MISS_REFRESH_GAP_MS) return null
    this.invalidate()
    return find(await this.entries())
  }

  /** Record (or rename) an organisation. */
  async put(entry: DirectoryEntry, by: string): Promise<void> {
    if (!this.#source) return
    const why = entryProblem(entry)
    if (why) throw new Error(`cannot record organisation ${entry.slug}: ${why}`)
    await this.#source.putStored(entry.slug, { ...entry } as Record<string, unknown>, by)
    this.invalidate()
  }

  /** Tombstone a deleted organisation, so no registry brings it back. */
  async remove(entry: DirectoryEntry, by: string): Promise<void> {
    if (!this.#source) return
    await this.#source.putStored(
      entry.slug,
      { ...entry, deletedAt: new Date(this.#now()).toISOString() } as Record<string, unknown>,
      by,
    )
    this.invalidate()
  }

  invalidate(): void {
    this.#cache = null
  }
}

/** The database-backed directory: `_directory` documents + every user's registry. */
function dbSource(): DirectorySource {
  const db = () => import('@adhar/db')
  const conn = async () => {
    const mod = await db()
    const c = await mod.getMigratedDb()
    if (!c) throw new Error('database not configured')
    return { mod, c }
  }
  return {
    async listStored() {
      const { mod, c } = await conn()
      return await mod.listDocuments(c, DIRECTORY_TENANT, DIRECTORY_KIND)
    },
    async putStored(slug, data, by) {
      const { mod, c } = await conn()
      await mod.putDocument(c, DIRECTORY_TENANT, DIRECTORY_KIND, slug, data, by)
    },
    async listRegistries() {
      const { mod, c } = await conn()
      return await mod.listPreferencesByScope(c, 'organizations')
    },
  }
}

let shared: OrgDirectory | undefined

/**
 * The process-wide directory. With no database configured it holds only the
 * platform organisation, which is all a database-less console can serve.
 */
export function getOrgDirectory(): OrgDirectory {
  if (shared) return shared
  // The same test as @adhar/db's isDbConfigured, without loading postgres.js
  // into every module that only wants to ask "which organisation is this?".
  const configured = Boolean(env('DATABASE_URL') || (env('POSTGRES_HOST') && env('POSTGRES_PASSWORD')))
  shared = new OrgDirectory(configured ? dbSource() : null)
  return shared
}
