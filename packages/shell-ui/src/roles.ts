import { useOptionalSession } from '@adhar-console/auth'
import type { NavItem, NavSection } from './nav-tree.tsx'

/**
 * Console persona model — the five RBAC personas the shell understands.
 *
 * A persona is *derived* from the signed-in user's Keycloak realm/client
 * roles and group memberships (groups arrive through the `tenants` claim —
 * Keycloak maps groups such as `platform-admin`, `platform-developer` and
 * `platform-viewer` into it). Resolution is pure, additive and read-only:
 * no server calls, no new claims. When nothing matches (or there is no
 * session at all) we fall back to `viewer` — least privilege.
 */
export type ConsoleRole =
  | 'super-admin'
  | 'platform-admin'
  | 'application-admin'
  | 'developer'
  | 'platform-engineer'
  | 'viewer'

/** All personas, ordered by descending privilege (used for resolution). */
export const CONSOLE_ROLES: readonly ConsoleRole[] = [
  'super-admin',
  'platform-admin',
  'platform-engineer',
  'application-admin',
  'developer',
  'viewer',
]

export const ROLE_LABEL: Record<ConsoleRole, string> = {
  'super-admin': 'Super admin',
  'platform-admin': 'Platform admin',
  'platform-engineer': 'Platform engineer',
  'application-admin': 'Application admin',
  developer: 'Developer',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTION: Record<ConsoleRole, string> = {
  'super-admin':
    'Unrestricted — every surface across the platform and all workspaces, including administration.',
  'platform-admin':
    'Full control — platform operations, workspace administration and every lifecycle surface.',
  'platform-engineer':
    'Operates the platform — Kubernetes, Crossplane resources, policies and workspace settings.',
  'application-admin':
    'Administers applications — catalog, planning, delivery and application-level settings.',
  developer:
    'Builds and ships software — the full lifecycle plus read access to platform surfaces.',
  viewer: 'Read-only access — sees every detail across the console, but cannot make changes.',
}

/**
 * Keycloak → persona mapping. Tokens are matched (case-insensitively,
 * ignoring group-path prefixes) against the user's realm/client roles and
 * group memberships. Mirrors the auth package's `ROLE_ALIASES` so the console
 * persona and the coarse auth `Role` agree.
 */
const ROLE_TOKENS: Record<ConsoleRole, readonly string[]> = {
  'super-admin': ['super-admin', 'superadmin', 'admin'],
  'platform-admin': ['platform-admin', 'platform-admins'],
  'platform-engineer': ['platform-engineer', 'platform-engineers', 'platform-eng'],
  'application-admin': ['application-admin', 'app-admin', 'tenant-admin', 'application-admins'],
  developer: ['developer', 'developers', 'platform-developer'],
  viewer: ['viewer', 'viewers', 'platform-viewer', 'base-user'],
}

/**
 * Minimal structural view of the auth `User` — kept loose on purpose so the
 * resolver keeps working if the auth package widens its role/group claims.
 */
export interface RoleSource {
  roles?: readonly string[]
  /** Keycloak group memberships (mapped into the `tenants` claim today). */
  groups?: readonly string[]
  tenants?: readonly string[]
}

/** Normalize a role/group token: lowercase + strip Keycloak group paths. */
function tokensOf(raw: string): string[] {
  const t = raw.trim().toLowerCase()
  if (!t) return []
  const noSlash = t.replace(/^\/+/, '')
  const last = noSlash.split('/').pop() ?? noSlash
  return last === noSlash ? [noSlash] : [noSlash, last]
}

/**
 * Resolve the console persona for a signed-in user.
 *
 * Looks at realm/client roles *and* group memberships, picks the highest-
 * privilege persona that matches, and defaults to `viewer` (least
 * privilege) when the user is anonymous or nothing matches.
 */
export function resolveConsoleRole(user?: RoleSource | null): ConsoleRole {
  if (!user) return 'viewer'
  const seen = new Set<string>()
  for (const raw of [...(user.roles ?? []), ...(user.groups ?? []), ...(user.tenants ?? [])]) {
    for (const t of tokensOf(raw)) seen.add(t)
  }
  for (const role of CONSOLE_ROLES) {
    if (ROLE_TOKENS[role].some((t) => seen.has(t))) return role
  }
  return 'viewer'
}

/**
 * Current persona for the running tab. Reads the (optional) auth session —
 * safe to call without an `<AuthProvider>` and while anonymous, in which
 * case it resolves the `fallback` (e.g. a `user` prop) or `viewer`.
 */
export function useConsoleRole(fallback?: RoleSource | null): ConsoleRole {
  const session = useOptionalSession()
  return resolveConsoleRole(session?.user ?? fallback)
}

/**
 * Like {@link useConsoleRole} but returns `null` when there is no auth session
 * in scope (anonymous, or the provider isn't mounted in this tree — e.g. an MF
 * remote that doesn't share the host's auth context). Callers use the `null`
 * to distinguish "real viewer" from "identity unknown" and pick a safe default
 * instead of silently downgrading to least-privilege.
 */
export function useOptionalConsoleRole(): ConsoleRole | null {
  const session = useOptionalSession()
  if (!session?.user) return null
  return resolveConsoleRole(session.user)
}

/** Where each persona lands right after login. */
export const ROLE_LANDING: Record<ConsoleRole, string> = {
  'super-admin': '/platform',
  'platform-admin': '/platform',
  'platform-engineer': '/platform',
  developer: '/develop',
  'application-admin': '/catalog',
  viewer: '/',
}

export function landingPathForRole(role: ConsoleRole): string {
  return ROLE_LANDING[role] ?? '/'
}

/** Personas with unrestricted access — every capability, every surface. */
const UNRESTRICTED: readonly ConsoleRole[] = ['super-admin', 'platform-admin']

/**
 * Can `role` see a surface gated by `requiredRoles`?
 *
 *   - `undefined` / empty → visible to everyone (backward compatible).
 *   - unrestricted personas (super/platform admin) see everything, always.
 *   - otherwise the role must be listed.
 *
 * NOTE: the console shows *all details* to every persona by design — visibility
 * is not gated. This helper remains for callers that opt into hiding a specific
 * surface; write access is gated separately via {@link can}.
 */
export function roleCanSee(role: ConsoleRole, requiredRoles?: readonly string[]): boolean {
  if (!requiredRoles?.length) return true
  if (UNRESTRICTED.includes(role)) return true
  return requiredRoles.includes(role)
}

/* ───────────────────────── Capabilities (write access) ─────────────────────
 *
 * The console follows a "read-everything, write-by-role" model: every persona
 * can SEE all details, but mutating actions are gated by capability. Modules
 * call `useCan('platform.manage')` (etc.) to enable/disable edit controls.
 */
export type Capability =
  | 'platform.manage' // Kubernetes ops, Crossplane resources, policies, cluster settings
  | 'workspace.manage' // members, billing/plan, org settings, branding, integrations
  | 'app.manage' // catalog, planning, design, delivery — application-level changes
  | 'develop' // develop lifecycle — build/ship software
  | 'create' // create new entities (apps, projects, resources)

const ALL_CAPS: readonly Capability[] = [
  'platform.manage',
  'workspace.manage',
  'app.manage',
  'develop',
  'create',
]

/** Per-persona write capabilities. Unrestricted personas implicitly get all. */
export const ROLE_CAPABILITIES: Record<ConsoleRole, readonly Capability[]> = {
  'super-admin': ALL_CAPS,
  'platform-admin': ALL_CAPS,
  'platform-engineer': ['platform.manage', 'develop', 'create'],
  'application-admin': ['app.manage', 'workspace.manage', 'create'],
  developer: ['develop', 'create'],
  viewer: [],
}

/** Does `role` hold write capability `cap`? Unrestricted personas always do. */
export function can(role: ConsoleRole, cap: Capability): boolean {
  if (UNRESTRICTED.includes(role)) return true
  return ROLE_CAPABILITIES[role].includes(cap)
}

/** Capability check for the running tab's persona (session-aware). */
export function useCan(cap: Capability): boolean {
  return can(useConsoleRole(), cap)
}

/** True when the persona has no write capability at all — pure read-only. */
export function isReadOnly(role: ConsoleRole): boolean {
  return !UNRESTRICTED.includes(role) && ROLE_CAPABILITIES[role].length === 0
}

function itemVisible(item: NavItem, role: ConsoleRole, extraRoles?: readonly string[]): boolean {
  if (roleCanSee(role, item.roles)) return true
  // Legacy escape hatch: nav annotated with raw Keycloak role strings keeps
  // working when those strings match the user's raw roles.
  return !!extraRoles?.length && !!item.roles?.some((r) => extraRoles.includes(r))
}

function filterItems(
  items: NavItem[],
  role: ConsoleRole,
  extraRoles?: readonly string[],
): NavItem[] {
  const out: NavItem[] = []
  for (const item of items) {
    if (!itemVisible(item, role, extraRoles)) continue
    if (!item.children?.length) {
      out.push(item)
      continue
    }
    const children = filterItems(item.children, role, extraRoles)
    // A pure group (no route of its own) with nothing left inside is noise.
    if (!children.length && !item.to) continue
    out.push({ ...item, children })
  }
  return out
}

/**
 * Produce the persona-appropriate nav tree: role-gated items are removed
 * recursively and sections left with no items are dropped entirely.
 * `extraRoles` (optional) lets raw user role strings keep matching legacy
 * annotations. Pure — never mutates the input tree.
 */
export function filterNavByRole(
  sections: NavSection[],
  role: ConsoleRole,
  extraRoles?: readonly string[],
): NavSection[] {
  const out: NavSection[] = []
  for (const section of sections) {
    const items = filterItems(section.items, role, extraRoles)
    if (!items.length) continue
    out.push({ ...section, items })
  }
  return out
}
