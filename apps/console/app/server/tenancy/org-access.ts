import {
  accessCheckKey,
  type AccessCheck,
  CONSOLE_API_GROUP,
  CONSOLE_PERMISSIONS,
  type ConsolePermission,
  consoleCheck,
  ORG_SCOPED_PERMISSIONS as ORG_SCOPED_ROLES,
} from '@adhar/auth/server'
import type { IdentityDirectory } from '../workspace/keycloak-admin.ts'

/**
 * Organisation membership and authority — the ONE function that answers "what
 * is this person in this organisation?".
 *
 * Keycloak is the only user store. An organisation's people are the members of
 * two realm groups, and nothing about them is kept anywhere else:
 *
 *   org-<slug>          members
 *   org-<slug>-admin    admins (admins are ALSO members — the console always
 *                       writes both — so the admin group is a subset)
 *
 * They are the groups the platform's Organisation and Project compositions
 * already bind (`org-<slug>-admin` → admin, `org-<slug>` → view in the
 * organisation's namespaces), so what the console shows and what Kubernetes
 * enforces come from the same membership.
 *
 * Platform admins (`platform-admin`, `platform-engineer`, `super-admin` — the
 * groups that pass every `console.adhar.io` check already) are admins of EVERY
 * organisation without being listed in any, and the platform team
 * (`platform-developer`, `platform-viewer`) are members of the platform's own
 * organisation, `adhar`. The realm group `admin` is deliberately not here: it
 * has no Kubernetes binding, so treating it as an admin would let the console
 * grant what the cluster refuses.
 *
 * The answer comes from the groups of a verified token (or, for writes that
 * change access, a live read of the user's groups — `confirmOrgAdminLive`), so
 * it needs no database and cannot drift from Keycloak. The realm-wide
 * `ws-role-*` groups the console used to mirror roles into are retired: an
 * owner of one organisation was an admin of all of them.
 *
 * Group names are compared EXACTLY as Keycloak spells them. Kubernetes binds
 * `oidc:org-acme-admin` case-sensitively, and Keycloak lets `ORG-ACME-ADMIN`
 * exist beside `org-acme-admin`; folding case here would make the console
 * honour a group the cluster does not.
 */

export type OrgRole = 'admin' | 'member'
/** Why someone has their role: listed in the org's groups, or implicitly. */
export type OrgVia = 'membership' | 'platform-admin' | 'platform-team'

export interface OrgAccess {
  role: OrgRole | null
  via: OrgVia | null
}

export const NO_ACCESS: OrgAccess = Object.freeze({ role: null, via: null })

/** The platform's own organisation (`Organisation/adhar`, 95-default-tenancy.yaml). */
export const PLATFORM_ORG_SLUG = 'adhar'
/** The tenant id the console has always kept the platform organisation's data under. */
export const PLATFORM_TENANT_ID = 'default'
export const PLATFORM_ADMIN_GROUPS: readonly string[] = Object.freeze(['platform-admin', 'platform-engineer', 'super-admin'])
export const PLATFORM_TEAM_GROUPS: readonly string[] = Object.freeze(['platform-developer', 'platform-viewer'])

/**
 * Namespaces an organisation may never be named after. The Organisation
 * composition owns its home namespace through a provider-kubernetes Object with
 * the default deletionPolicy, so an organisation called `default` ADOPTS the
 * Kubernetes default namespace and deleting the organisation would delete it.
 * The control plane refuses these too (compositions/organisation/local.yaml).
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  'default',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'adhar-system',
])

/**
 * A slug the console may CREATE: the Organisation/Team XRD pattern (letter
 * first, at most 40). An organisation slug must also not end in `-admin`, or
 * `org-x-admin` would be both the admin group of `x` and the member group of
 * `x-admin` — joining one would make you admin of the other.
 */
const NEW_SLUG_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/
/** A slug already stored, before it goes into a group name: a DNS-1123 label. */
const STORED_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isNewOrgSlug = (slug: string): boolean => NEW_SLUG_RE.test(slug) && !slug.endsWith('-admin')
export const isNewTeamSlug = (slug: string): boolean => NEW_SLUG_RE.test(slug)
export const isStoredSlug = (slug: unknown): slug is string => typeof slug === 'string' && STORED_SLUG_RE.test(slug)

/**
 * The slug a team gets when nobody typed one: the name, lower-cased with runs
 * of anything else as one hyphen — then made to fit the Team XRD the same way
 * every time, so the slug a person never saw cannot be the reason the team is
 * refused: a leading digit gets a `t-` in front ("2026 Platform" →
 * `t-2026-platform`) and it is cut to 40 characters without a trailing hyphen.
 * Empty (a name with no Latin letters or digits) stays empty; the caller asks
 * for an explicit slug then. Settings → Teams previews the same derivation
 * (modules/workspace/src/data/members-model.ts, `deriveTeamSlug`).
 */
export function teamSlugFromName(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) return ''
  if (!/^[a-z]/.test(s)) s = `t-${s}`
  return s.slice(0, 40).replace(/-+$/, '')
}

function safe(slug: string, what: string): string {
  if (!isStoredSlug(slug)) throw new Error(`${what} ${JSON.stringify(slug)} is not a valid slug`)
  return slug
}

export const orgMemberGroup = (slug: string): string => `org-${safe(slug, 'organisation')}`
export const orgAdminGroup = (slug: string): string => `org-${safe(slug, 'organisation')}-admin`
/**
 * A team's group, qualified by its organisation. `.` is not in the slug
 * alphabet, so `ws-team-acme.platform-x` can only mean (acme, platform-x) — a
 * hyphen would make it (acme-platform, x) too. The old `ws-team-<team>` had no
 * organisation at all: every organisation's "platform" team shared one group,
 * and with it the platform's own team's namespace access.
 */
export const teamGroup = (org: string, team: string): string =>
  `ws-team-${safe(org, 'organisation')}.${safe(team, 'team')}`
/** The team slugs of `org` among a set of group names. */
export function teamsOf(groups: readonly string[], org: string): string[] {
  const prefix = `ws-team-${org}.`
  const out = new Set<string>()
  for (const g of groups) {
    if (g.startsWith(prefix) && isStoredSlug(g.slice(prefix.length))) out.add(g.slice(prefix.length))
  }
  return [...out].sort()
}

/** True when `groups` holds any platform-admin group (exact names, see the header). */
export function isPlatformAdmin(groups: readonly string[]): boolean {
  return groups.some((g) => PLATFORM_ADMIN_GROUPS.includes(g))
}

/**
 * The role `groups` gives in organisation `slug`. Explicit membership wins over
 * the implicit kinds for `via`, so a platform admin who is also listed shows as
 * a listed admin. A slug that could not be a group name gives nothing.
 */
export function orgAccess(groups: readonly string[], slug: string): OrgAccess {
  if (!isStoredSlug(slug)) return NO_ACCESS
  const set = new Set(groups)
  if (set.has(orgAdminGroup(slug))) return { role: 'admin', via: 'membership' }
  if (PLATFORM_ADMIN_GROUPS.some((g) => set.has(g))) return { role: 'admin', via: 'platform-admin' }
  if (set.has(orgMemberGroup(slug))) return { role: 'member', via: 'membership' }
  if (slug === PLATFORM_ORG_SLUG && PLATFORM_TEAM_GROUPS.some((g) => set.has(g))) {
    return { role: 'member', via: 'platform-team' }
  }
  return NO_ACCESS
}

/* ─────────────────── org-scoped console permissions ─────────────────── */

/** From the shared catalogue, so Settings → Roles & permissions lists exactly this. */
const ORG_SCOPED_PERMISSIONS: Array<[ConsolePermission, OrgRole]> = ORG_SCOPED_ROLES.map(
  ([name, role]) => [CONSOLE_PERMISSIONS[name], role],
)

/**
 * Console permissions that belong to ONE organisation, by `accessCheckKey`,
 * with the role they need there. For these the function above is
 * authoritative and Kubernetes RBAC is not consulted: a ClusterRoleBinding is
 * realm-wide, so "admin of acme" could only ever be expressed as "admin of
 * every organisation". `organizations create` is not here — creating an
 * organisation is a platform decision and stays RBAC.
 */
export const ORG_SCOPED: ReadonlyMap<string, OrgRole> = new Map(
  ORG_SCOPED_PERMISSIONS.map(([perm, role]) => [accessCheckKey(consoleCheck(perm)), role]),
)

const ORG_SCOPED_BY_RULE = new Map(
  ORG_SCOPED_PERMISSIONS.map(([perm, role]) => [`${perm.verb}|${perm.resource}`, role]),
)

/**
 * The role an org-scoped check needs, or undefined for every other check. A
 * namespace or name on the check does not take it out of scope — the question
 * is about the organisation either way — so a namespaced RoleBinding cannot
 * re-grant what the organisation's groups refuse.
 */
export function orgScopedRole(check: AccessCheck): OrgRole | undefined {
  if ((check.group ?? '') !== CONSOLE_API_GROUP || check.subresource) return undefined
  return ORG_SCOPED_BY_RULE.get(`${check.verb}|${check.resource}`)
}

/** `undefined` → not org-scoped (ask RBAC as before); otherwise the answer. */
export function decideOrgScoped(check: AccessCheck, access: OrgAccess): boolean | undefined {
  const need = orgScopedRole(check)
  if (!need) return undefined
  if (!access.role) return false
  return need === 'member' || access.role === 'admin'
}

/* ─────────────────── live confirmation for writes ─────────────────── */

/** A refusal decided by membership, mapped to HTTP by the handlers. */
export class OrgAccessError extends Error {
  constructor(readonly code: 'requires_org_admin' | 'not_a_member', message?: string) {
    super(message ?? code)
    this.name = 'OrgAccessError'
  }
}

/** The per-request live check must be quick: a slow Keycloak fails the write, not the page. */
export const LIVE_CHECK_TIMEOUT_MS = 3_000

/**
 * Re-read the caller's groups from Keycloak and require org admin NOW.
 *
 * Every write that changes who may do what (members, accounts, teams, deleting,
 * renaming or leaving an organisation) calls this on top of the token check:
 * a token is up to half an hour old, and a demoted admin must not keep making
 * access changes until it expires. Throws `OrgAccessError` (→ 403) when the
 * groups do not make the caller an admin, and lets a `KcError` (→ 503/502)
 * through when Keycloak cannot be asked — never a pass.
 */
export async function confirmOrgAdminLive(kc: IdentityDirectory, userId: string, slug: string): Promise<void> {
  let groups: string[]
  try {
    groups = await kc.getUserGroups(userId, { timeoutMs: LIVE_CHECK_TIMEOUT_MS })
  } catch (e) {
    // The caller's own account is gone: certainly not an admin.
    if ((e as { code?: string }).code === 'not_found') throw new OrgAccessError('requires_org_admin')
    throw e
  }
  if (orgAccess(groups, slug).role !== 'admin') {
    throw new OrgAccessError('requires_org_admin', `${orgAdminGroup(slug)} does not list you any more`)
  }
}

/** The implicit grants of an organisation, for the Members page. */
export function implicitGrants(slug: string): Array<{ group: string; role: OrgRole }> {
  const out = PLATFORM_ADMIN_GROUPS.map((group) => ({ group, role: 'admin' as OrgRole }))
  if (slug === PLATFORM_ORG_SLUG) {
    for (const group of PLATFORM_TEAM_GROUPS) out.push({ group, role: 'member' })
  }
  return out
}
