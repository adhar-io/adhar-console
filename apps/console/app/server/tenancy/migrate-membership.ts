import { getKeycloakAdmin, type IdentityDirectory } from '../workspace/keycloak-admin.ts'
import { KIND, type MemberDoc, openStore, type Store, type TeamDoc, writeSystemAudit } from '../workspace/store.ts'
import { emitNotification } from '../notify.ts'
import { listTeamXrs, type TeamXrSummary } from '../control-plane.ts'
import { DIRECTORY_TENANT, type DirectoryEntry, getOrgDirectory, type OrgDirectory } from './directory.ts'
import {
  isPlatformAdmin,
  isStoredSlug,
  orgAdminGroup,
  orgMemberGroup,
  PLATFORM_ADMIN_GROUPS,
  PLATFORM_ORG_SLUG,
  PLATFORM_TENANT_ID,
  teamGroup,
} from './org-access.ts'

/**
 * One-time move of organisation membership out of the console's database and
 * into Keycloak groups — the console stopped keeping members the release this
 * shipped in.
 *
 * Until then a member was a `workspace.member` document per tenant (role +
 * team slugs), mirrored — when it worked — into realm-wide `ws-role-<role>`
 * and unqualified `ws-team-<team>` groups. Now a member is someone in
 * `org-<slug>` (admins also in `org-<slug>-admin`) and a team member someone in
 * `ws-team-<slug>.<team>`, so on start-up every tenant's documents are replayed
 * into those groups:
 *
 *   - every member → `org-<slug>`; owners and admins also → `org-<slug>-admin`;
 *     billing and viewer roles are plain members now;
 *   - every team slug a member carried → that team's qualified group;
 *   - EXCEPT in the platform's own organisation (`adhar`), where old admin AND
 *     team grants are only reported, not made: `org-adhar-admin` is Kubernetes
 *     admin of the platform's own namespaces (adhar, dev, test, prod), and the
 *     platform's Project binds `ws-team-adhar.platform` as admin of adhar/dev/
 *     test — rights the default workspace's admins and team members were never
 *     vetted for (its first visitor became owner; the old first-team bootstrap
 *     put whoever listed teams first in the team). Platform admins get one
 *     notification listing them, to grant by hand in Members and Teams;
 *   - the old, organisation-less `ws-team-<team>` groups are only REPORTED,
 *     once, globally: they never said which organisation a member came from,
 *     so nothing is inferred from them. Whoever the console's own records place
 *     in a team was granted above, by that organisation's tenant pass; anyone
 *     else is listed for platform admins to decide (`ambiguousLegacy`).
 *
 * Additive: every write is a group PUT, NOTHING is removed — the old
 * documents, the `ws-role-*` groups and the old team groups all stay, so
 * rolling the console back finds what it left. And a retry never undoes what
 * people did since: a tenant's grants are planned once and persisted
 * (`workspace.migration/keycloak-membership-v1-plan`), each is marked as it is
 * made, a retry makes only the ones still open — and skips every remaining
 * grant of anyone the console's audit trail shows was changed since the plan
 * (removed, demoted, added to a team…). A tenant is marked done
 * (`workspace.migration/keycloak-membership-v1`) only when every planned grant
 * was made or skipped; until then the sweep retries it every five minutes.
 */

export const MIGRATION_ID = 'keycloak-membership-v1'
/** The persisted plan of one tenant's grants, with which ones were made. */
export const PLAN_ID = `${MIGRATION_ID}-plan`
export const LEGACY_MARKER_ID = 'legacy-team-groups-v1'
const RETRY_MS = 5 * 60_000
const FIRST_RUN_DELAY_MS = 5_000

export interface MigrationDeps {
  kc: IdentityDirectory | null
  directory: OrgDirectory
  openStore(tenant: string): Promise<Store | null>
  /** Tenants holding membership or team documents. */
  listTenants(): Promise<string[]>
  teamXrs(): Promise<TeamXrSummary[] | null>
  log(line: string): void
}

export interface MigrationCounts {
  members: number
  addedMember: number
  addedAdmin: number
  withheldAdmins: number
  teamMemberships: number
  missingUsers: number
  unknownTeams: number
  /** Old ws-team-<team> members the console's records placed — granted by their tenant's pass. */
  legacyCovered: number
  ambiguousLegacy: number
  /** Team grants held back in the platform organisation (see the header). */
  withheldTeams: number
  /** Planned grants skipped because the console changed that person since the plan. */
  skippedChanged: number
}

export type TenantOutcome =
  | { status: 'migrated'; counts: MigrationCounts }
  | { status: 'already' }
  | { status: 'unresolved'; reason: string }
  | { status: 'failed'; error: string }

const zero = (): MigrationCounts => ({
  members: 0,
  addedMember: 0,
  addedAdmin: 0,
  withheldAdmins: 0,
  teamMemberships: 0,
  missingUsers: 0,
  unknownTeams: 0,
  legacyCovered: 0,
  ambiguousLegacy: 0,
  withheldTeams: 0,
  skippedChanged: 0,
})

function line(prefix: string, counts: MigrationCounts): string {
  return `[membership-migration] ${prefix} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`
}

function defaultDeps(): MigrationDeps {
  return {
    kc: getKeycloakAdmin(),
    directory: getOrgDirectory(),
    openStore,
    async listTenants() {
      const mod = await import('@adhar/db')
      const conn = await mod.getMigratedDb()
      if (!conn) return []
      const tenants = await mod.listTenantsWithKinds(conn, [KIND.member, KIND.team])
      return tenants.filter((t) => t !== 'auth' && !t.startsWith('_')).sort()
    },
    teamXrs: () => listTeamXrs(),
    log: (l) => console.log(l),
  }
}

const said = new Set<string>()
function logOnce(deps: MigrationDeps, msg: string): void {
  if (said.has(msg)) return
  if (said.size > 1_000) said.clear()
  said.add(msg)
  deps.log(msg)
}

/** Has tenant `tenant` been migrated? (A console without a database has nothing to migrate.) */
export async function isMigrated(tenant: string, deps: Pick<MigrationDeps, 'openStore'> = defaultDeps()): Promise<boolean> {
  const store = await deps.openStore(tenant)
  if (!store) return true
  return (await store.get(KIND.migration, MIGRATION_ID)) !== null
}

const running = new Map<string, Promise<TenantOutcome>>()

/** Migrate one tenant (single-flight per tenant in this replica). */
export function migrateTenant(tenant: string, deps: MigrationDeps = defaultDeps()): Promise<TenantOutcome> {
  const inflight = running.get(tenant)
  if (inflight) return inflight
  const p = migrateTenantOnce(tenant, deps)
    .catch((e): TenantOutcome => ({ status: 'failed', error: e instanceof Error ? e.message : String(e) }))
    .finally(() => running.delete(tenant))
  running.set(tenant, p)
  return p
}

interface PlannedGrant {
  userId: string
  group: string
  applied?: boolean
  /** Skipped: the console changed this person after the plan was made. */
  skipped?: boolean
}

interface Withheld {
  userId: string
  email: string
  /** A team grant (no team: an organisation-admin grant). */
  team?: string
}

/** One tenant's migration, planned once and persisted — what a retry resumes. */
interface TenantPlan {
  version: 1
  /** When the plan was made: console changes to a person after this win over it. */
  startedAt: string
  orgSlug: string
  grants: PlannedGrant[]
  members: number
  missingUsers: number
  unknownTeams: number
  withheld: Withheld[]
  excluded: Array<{ userId: string; reason: string }>
  [k: string]: unknown
}

async function planTenant(kc: IdentityDirectory, store: Store, slug: string): Promise<TenantPlan> {
  const plan: TenantPlan = {
    version: 1,
    startedAt: new Date().toISOString(),
    orgSlug: slug,
    grants: [],
    members: 0,
    missingUsers: 0,
    unknownTeams: 0,
    withheld: [],
    excluded: [],
  }
  const platform = slug === PLATFORM_ORG_SLUG
  const teams = new Set((await store.list<TeamDoc>(KIND.team)).map((t) => t.data?.slug).filter(isStoredSlug))
  for (const m of await store.list<MemberDoc>(KIND.member)) {
    plan.members++
    const userId = m.id
    const user = await kc.getUser(userId)
    if (!user) {
      plan.missingUsers++
      plan.excluded.push({ userId, reason: 'no Keycloak account' })
      continue
    }
    const email = user.email ?? m.data.email ?? ''
    plan.grants.push({ userId, group: orgMemberGroup(slug) })
    // In the platform organisation only someone who is a platform admin
    // already gets admin or team grants: they add nothing such a person
    // could not do anyway. Everyone else is reported.
    const vetted = !platform || isPlatformAdmin(await kc.getUserGroups(userId))
    if (m.data.role === 'owner' || m.data.role === 'admin') {
      if (vetted) plan.grants.push({ userId, group: orgAdminGroup(slug) })
      else plan.withheld.push({ userId, email })
    }
    for (const t of new Set(Array.isArray(m.data.teams) ? m.data.teams : [])) {
      if (typeof t !== 'string' || !teams.has(t)) {
        plan.unknownTeams++
        continue
      }
      if (vetted) plan.grants.push({ userId, group: teamGroup(slug, t) })
      else plan.withheld.push({ userId, email, team: t })
    }
  }
  return plan
}

/**
 * Has the console changed `userId` in this tenant since `since`? Any audited
 * membership action about them — added, removed, role changed, added to or
 * removed from a team — means a person decided, and the plan must not
 * overrule them.
 */
async function changedSince(store: Store, userId: string, since: string): Promise<boolean> {
  for (const path of ['target.id', 'metadata.userId']) {
    const page = await store.query(KIND.audit, {
      equals: [{ path, value: userId }],
      range: { path: 'at', from: since },
      sort: { path: 'at', direction: 'desc' },
      limit: 1,
      offset: 0,
    })
    if (page.total > 0) return true
  }
  return false
}

async function migrateTenantOnce(tenant: string, deps: MigrationDeps): Promise<TenantOutcome> {
  const store = await deps.openStore(tenant)
  if (!store) return { status: 'failed', error: 'database not configured' }
  if (await store.get(KIND.migration, MIGRATION_ID)) return { status: 'already' }
  const kc = deps.kc
  if (!kc) return { status: 'failed', error: 'Keycloak not configured' }
  const entry = await deps.directory.byTenant(tenant)
  if (!entry) {
    logOnce(deps, `[membership-migration] tenant=${tenant} has no organisation in the directory — skipped`)
    return { status: 'unresolved', reason: 'no organisation in the directory' }
  }
  // The directory already drops such an organisation; a stale cache must not
  // let one through: its members would become admins of another organisation.
  const base = entry.slug.endsWith('-admin') ? entry.slug.slice(0, -'-admin'.length) : ''
  const clash = base && (base === PLATFORM_ORG_SLUG || (await deps.directory.bySlug(base)))
    ? `its member group ${orgMemberGroup(entry.slug)} is the admin group of ${base}`
    : null
  if (clash) {
    logOnce(deps, `[membership-migration] tenant=${tenant} org=${entry.slug} refused: ${clash} — rename one of them`)
    return { status: 'unresolved', reason: clash }
  }
  const slug = entry.slug
  await kc.ensureOrgGroups(slug)

  // Plan once; a retry resumes the persisted plan instead of replaying the
  // member documents over whatever admins have done since.
  let plan = (await store.get<TenantPlan>(KIND.migration, PLAN_ID))?.data ?? null
  if (!plan || plan.orgSlug !== slug) {
    plan = await planTenant(kc, store, slug)
    await store.put(KIND.migration, PLAN_ID, plan, 'system')
  }

  const skippedUsers = new Set<string>()
  const checked = new Map<string, boolean>()
  for (const g of plan.grants) {
    if (g.applied || g.skipped) continue
    let changed = checked.get(g.userId)
    if (changed === undefined) {
      changed = await changedSince(store, g.userId, plan.startedAt)
      checked.set(g.userId, changed)
    }
    if (changed) {
      g.skipped = true
      skippedUsers.add(g.userId)
    } else {
      await kc.addUserToGroup(g.userId, g.group)
      g.applied = true
    }
    // Progress is saved grant by grant: a retry must know exactly what is done.
    await store.put(KIND.migration, PLAN_ID, plan, 'system')
  }

  const counts = zero()
  counts.members = plan.members
  counts.missingUsers = plan.missingUsers
  counts.unknownTeams = plan.unknownTeams
  for (const g of plan.grants) {
    if (g.skipped) {
      counts.skippedChanged++
      continue
    }
    if (g.group === orgMemberGroup(slug)) counts.addedMember++
    else if (g.group === orgAdminGroup(slug)) counts.addedAdmin++
    else counts.teamMemberships++
  }
  const withheldAdmins = plan.withheld.filter((w) => !w.team)
  const withheldTeams = plan.withheld.filter((w) => w.team)
  counts.withheldAdmins = withheldAdmins.length
  counts.withheldTeams = withheldTeams.length

  // Only now, with every planned grant made or skipped: the marker, then the record of it.
  await store.put(
    KIND.migration,
    MIGRATION_ID,
    {
      version: 1,
      at: new Date().toISOString(),
      orgSlug: slug,
      counts,
      withheldAdmins,
      withheldTeams,
      excluded: plan.excluded,
      skippedChanged: [...skippedUsers],
    },
    'system',
  )
  await writeSystemAudit(store, 'member.migrated_to_keycloak', { type: 'organization', id: slug, label: entry.name }, { ...counts })
  deps.log(line(`tenant=${tenant} org=${slug}`, counts))
  if (slug !== PLATFORM_ORG_SLUG) await deps.directory.put(entry, 'system').catch(() => {})
  if (plan.withheld.length > 0) await notifyWithheld(deps, kc, store, entry, plan.withheld)
  return { status: 'migrated', counts }
}

/** Everyone in a platform admin group: who decides what the migration would not. */
async function platformAdmins(kc: IdentityDirectory): Promise<string[]> {
  const audience = new Set<string>()
  for (const g of PLATFORM_ADMIN_GROUPS) {
    for (const m of (await kc.listGroupMembers(g)).members) audience.add(m.id)
  }
  return [...audience]
}

const listed = (names: string[]) => `${names.slice(0, 10).join(', ')}${names.length > 10 ? `, and ${names.length - 10} more` : ''}`

/** One notification for the platform admins, naming the admin and team grants that were held back. */
async function notifyWithheld(
  deps: MigrationDeps,
  kc: IdentityDirectory,
  store: Store,
  entry: DirectoryEntry,
  withheld: Withheld[],
): Promise<void> {
  try {
    const audience = await platformAdmins(kc)
    if (audience.length === 0) return
    const admins = withheld.filter((w) => !w.team).map((w) => w.email || w.userId)
    const teams = withheld.filter((w) => w.team).map((w) => `${w.email || w.userId} → ${w.team}`)
    const parts = [
      admins.length ? `admin of ${entry.name} (Kubernetes admin of the platform's own namespaces): ${listed(admins)}` : '',
      teams.length ? `team membership (the platform's Project binds its teams as namespace admin): ${listed(teams)}` : '',
    ].filter(Boolean)
    await emitNotification(store, {
      kind: 'warning',
      source: 'workspace',
      title: `${withheld.length} grant${withheld.length === 1 ? '' : 's'} in ${entry.name} were not migrated`,
      description: `Not granted automatically — ${parts.join('; ')}. Grant whoever should keep them in Members and Teams.`,
      href: '/settings?section=members',
      key: `membership-migration-withheld-${entry.slug}`,
      severity: 'medium',
      audience,
      target: { type: 'organization', id: entry.slug, label: entry.name },
      at: new Date().toISOString(),
    })
  } catch (e) {
    deps.log(`[membership-migration] could not notify platform admins about withheld grants in ${entry.slug}: ${e instanceof Error ? e.message : e}`)
  }
}

/**
 * The old, unqualified `ws-team-<team>` groups — REPORTED, never copied. Runs
 * once (marker in the directory tenant) and writes nothing to Keycloak.
 *
 * Such a group never said which organisation its members came from, so any
 * inference from it ("the only organisation with a team of that name", "the
 * platform's own team") would hand someone membership of an organisation
 * nobody added them to — or the platform team's namespace admin. Whoever the
 * console's own records place in a team was already granted by that
 * organisation's tenant pass (`legacyCovered`); everyone else is listed for the
 * platform admins to decide (`ambiguousLegacy`).
 */
export async function migrateLegacyTeamGroups(
  deps: MigrationDeps = defaultDeps(),
): Promise<{ status: 'migrated' | 'already' | 'failed'; counts?: MigrationCounts; error?: string }> {
  try {
    const marks = await deps.openStore(DIRECTORY_TENANT)
    if (!marks) return { status: 'failed', error: 'database not configured' }
    if (await marks.get(KIND.migration, LEGACY_MARKER_ID)) return { status: 'already' }
    const kc = deps.kc
    if (!kc) return { status: 'failed', error: 'Keycloak not configured' }

    // Every team name any organisation has, and who the records place in one.
    const names = new Set<string>()
    const placed = new Set<string>()
    for (const tenant of await deps.listTenants()) {
      const entry = await deps.directory.byTenant(tenant)
      const store = entry ? await deps.openStore(tenant) : null
      if (!entry || !store) continue
      const teams = new Set((await store.list<TeamDoc>(KIND.team)).map((t) => t.data?.slug).filter(isStoredSlug))
      for (const t of teams) names.add(t)
      for (const m of await store.list<MemberDoc>(KIND.member)) {
        for (const t of Array.isArray(m.data.teams) ? m.data.teams : []) {
          if (typeof t === 'string' && teams.has(t)) placed.add(`${m.id}\u0000${t}`)
        }
      }
    }
    for (const x of (await deps.teamXrs()) ?? []) {
      if (isStoredSlug(x.name)) names.add(x.name)
    }

    const counts = zero()
    const ambiguous: Array<{ userId: string; team: string; email?: string }> = []
    for (const team of [...names].sort()) {
      const legacy = `ws-team-${team}`
      if (!(await kc.findGroup(legacy))) continue
      for (const u of (await kc.listGroupMembers(legacy, { fresh: true })).members) {
        if (placed.has(`${u.id}\u0000${team}`)) {
          counts.legacyCovered++
          continue
        }
        counts.ambiguousLegacy++
        ambiguous.push({ userId: u.id, team, ...(u.email ? { email: u.email } : {}) })
      }
    }
    await marks.put(
      KIND.migration,
      LEGACY_MARKER_ID,
      { version: 2, at: new Date().toISOString(), counts, ambiguous },
      'system',
    )
    deps.log(line('legacy-team-groups', counts))
    if (ambiguous.length > 0) await notifyAmbiguousLegacy(deps, kc, ambiguous)
    return { status: 'migrated', counts }
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Tell the platform admins who is in an old team group with nothing to say where they belong. */
async function notifyAmbiguousLegacy(
  deps: MigrationDeps,
  kc: IdentityDirectory,
  ambiguous: Array<{ userId: string; team: string; email?: string }>,
): Promise<void> {
  try {
    const audience = await platformAdmins(kc)
    const store = audience.length ? await deps.openStore(PLATFORM_TENANT_ID) : null
    if (!store) return
    await emitNotification(store, {
      kind: 'warning',
      source: 'workspace',
      title: `${ambiguous.length} ${ambiguous.length === 1 ? 'person is' : 'people are'} in old team groups with no organisation`,
      description: `The old ws-team-<team> groups never said which organisation a member belonged to, so nobody was added anywhere from them: ` +
        `${listed(ambiguous.map((a) => `${a.email ?? a.userId} (ws-team-${a.team})`))}. Add whoever should be in a team under that organisation's Members and Teams.`,
      href: '/settings?section=teams',
      key: 'membership-migration-ambiguous-legacy',
      severity: 'medium',
      audience,
      target: { type: 'organization', id: PLATFORM_ORG_SLUG, label: 'Old team groups' },
      at: new Date().toISOString(),
    })
  } catch (e) {
    deps.log(`[membership-migration] could not notify platform admins about old team group members: ${e instanceof Error ? e.message : e}`)
  }
}

/** Every tenant, then the legacy team groups. `complete` when nothing failed. */
export async function runMembershipMigration(
  deps: MigrationDeps = defaultDeps(),
): Promise<{ complete: boolean; tenants: Record<string, TenantOutcome['status']> }> {
  const tenants: Record<string, TenantOutcome['status']> = {}
  if (!deps.kc) {
    logOnce(deps, '[membership-migration] Keycloak not configured — nothing to migrate into')
    return { complete: true, tenants }
  }
  let failed = 0
  for (const tenant of await deps.listTenants()) {
    const out = await migrateTenant(tenant, deps)
    tenants[tenant] = out.status
    if (out.status === 'failed') {
      failed++
      deps.log(`[membership-migration] tenant=${tenant} failed, will retry: ${out.error}`)
    }
  }
  const legacy = await migrateLegacyTeamGroups(deps)
  if (legacy.status === 'failed') {
    failed++
    deps.log(`[membership-migration] legacy team groups failed, will retry: ${legacy.error}`)
  }
  if (failed === 0) {
    const n = (s: TenantOutcome['status']) => Object.values(tenants).filter((v) => v === s).length
    deps.log(
      `[membership-migration] done tenants=${Object.keys(tenants).length} migrated=${n('migrated')} already=${n('already')} unresolved=${n('unresolved')} legacy=${legacy.status}`,
    )
  }
  return { complete: failed === 0, tenants }
}

/**
 * Run the migration in the background from server start, retrying every five
 * minutes until it completes. Returns the stop function for shutdown.
 */
export function startMembershipMigration(opts: { deps?: () => MigrationDeps; intervalMs?: number } = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped) return
    try {
      if ((await runMembershipMigration((opts.deps ?? defaultDeps)())).complete) return
    } catch (e) {
      console.warn('[membership-migration] sweep failed, will retry:', e instanceof Error ? e.message : e)
    }
    if (!stopped) timer = setTimeout(tick, opts.intervalMs ?? RETRY_MS)
  }
  timer = setTimeout(tick, FIRST_RUN_DELAY_MS)
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
