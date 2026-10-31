/**
 * Pure helpers behind Settings → Members and Teams: what a membership status
 * looks like, what each BFF error code means to a person, and the filtering
 * the pages do. No React and no fetch, so the wording is testable.
 *
 * Membership lives in Keycloak: `org-<slug>` holds an organization's members,
 * `org-<slug>-admin` its admins (every admin is in both), and a team is the
 * group `ws-team-<org>.<team>`. The console keeps no member, role or
 * invitation records of its own — every row on these pages is read from
 * those groups, and every change is written to them.
 */

export type OrgRole = 'admin' | 'member'

/** How the signed-in user holds their role in an organization. */
export type OrgVia = 'membership' | 'platform-admin' | 'platform-team'

/**
 * `invited` — the account exists but its owner has not set a password yet
 * (Keycloak still lists the UPDATE_PASSWORD required action); `disabled` —
 * the Keycloak account is switched off.
 */
export type MemberStatus = 'active' | 'invited' | 'disabled'

/** The StatusBadge kinds these pages use (a subset of shell-ui's StatusKind). */
export type BadgeKind = 'healthy' | 'paused' | 'unknown' | 'info' | 'progressing'

export function memberStatusBadge(status: MemberStatus): { kind: BadgeKind; label: string; hint: string } {
  switch (status) {
    case 'invited':
      return { kind: 'paused', label: 'Invited', hint: 'Has not set a password yet' }
    case 'disabled':
      return { kind: 'unknown', label: 'Disabled', hint: 'The Keycloak account is disabled' }
    default:
      return { kind: 'healthy', label: 'Active', hint: 'Can sign in' }
  }
}

export const ORG_ROLE_OPTIONS: Array<{ value: OrgRole; label: string }> = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
]

export function orgRoleBadge(role: OrgRole): { kind: BadgeKind; label: string } {
  return role === 'admin' ? { kind: 'progressing', label: 'Admin' } : { kind: 'info', label: 'Member' }
}

/* ─────────────────── errors ─────────────────── */

/**
 * Every error code the workspace BFF answers with, in a person's words —
 * members-model_test.ts reads the server's code to keep it that way. Codes
 * outside this map fall back to the server's `detail`, then to the status —
 * never to a guess.
 *
 * `not_a_member` is about the CALLER ("you are not"); a person acted ON who is
 * not in the organisation is `user_not_in_organisation`.
 */
export const WORKSPACE_ERROR_MESSAGE: Record<string, string> = {
  // 400
  invalid_json: 'The request could not be read. Reload the page and try again.',
  invalid_user_id: 'That person could not be identified. Pick them from the list again.',
  invalid_role: 'Choose Admin or Member.',
  invalid_email: 'Enter a valid email address.',
  invalid_slug: 'Use lowercase letters, digits and hyphens, starting with a letter — at most 40 characters.',
  invalid_query: 'Type 2 to 100 characters to search.',
  unknown_team: 'One of the selected teams no longer exists in this organization.',
  cannot_remove_self: 'You cannot remove yourself here. Leave the organization from the organization switcher instead.',
  invalid_request: 'Keycloak rejected the request as invalid.',
  missing_name: 'Give it a name.',
  nothing_to_update: 'There was nothing to save.',
  missing_scopes: 'Choose at least one scope for the token.',
  invalid_expiry: 'That expiry date could not be read.',
  invalid_scope: 'That is not an approval scope the console knows.',
  missing_summary: 'Say what the request is for.',
  invalid_checks: 'The permission check could not be read. Reload the page and try again.',
  // 403
  requires_org_admin: 'Only an organization admin can do this.',
  forbidden: 'You do not have permission to do this.',
  not_a_member: 'You are not a member of that organization.',
  plane_invitations_disabled: 'Plane invitations are turned off. Add people in Settings → Members instead.',
  plane_membership_requires_admin: 'Only an admin of the organization can change who is in its Plane projects.',
  origin_not_allowed: 'The request did not come from this console. Reload the page and try again.',
  // 404
  not_found: 'It no longer exists — it may have been deleted.',
  user_not_found: 'That Keycloak account no longer exists.',
  user_not_in_organisation: 'That person is not a member of this organization — add them under Members first.',
  // 409
  no_organisation: 'You are not in an organization yet.',
  already_member: 'That person is already a member of this organization.',
  user_exists: 'A Keycloak account with that email already exists. Add it as an existing account instead.',
  cannot_demote_last_admin: 'The organization must keep at least one admin.',
  cannot_remove_last_admin: 'The organization must keep at least one admin.',
  cannot_leave_last_admin: 'You are the last admin. Make someone else an admin before you leave.',
  platform_organisation: 'The platform organization cannot be deleted.',
  platform_admin_access: 'You see this organization as a platform admin, not as a member, so there is no membership to leave.',
  slug_taken: 'That slug is already in use.',
  reauth_required: 'Your session does not carry this membership yet. Sign out and sign back in.',
  setup_not_pending: 'That person has already set a password, so there is no set-password email to send.',
  email_unverified:
    "Keycloak has not verified that this account's email address belongs to whoever created it, so it cannot be added on the email alone. Ask the person to verify their email, or ask a platform admin to add them.",
  conflict: 'Keycloak reported a conflict with an existing account or group.',
  // 410
  invitations_removed: 'Invitations were removed. Add people from Settings → Members → Add people.',
  ownership_removed: 'Organizations no longer have a single owner. Make more people admins instead.',
  // 422
  keycloak_email_not_configured: 'Keycloak has no SMTP server, so it cannot email a set-password link. Configure Realm settings → Email in Keycloak first.',
  // 429
  rate_limited: 'Too many of these in a short time. Wait a little and try again.',
  // 500
  internal_error: 'Something went wrong on the console server. Try again; if it keeps happening, an operator can find why in its log.',
  session_reissue_failed: 'Your session could not be switched. Sign out and sign back in.',
  // 401
  unauthenticated: 'Sign in to continue.',
  session_expired: 'Your session expired. Sign in again — nothing you entered is lost.',
  // 502
  keycloak_denied: "Keycloak refused the console's service account.",
  email_send_failed: "Keycloak could not send the email. The realm's SMTP settings need checking.",
  // 503
  keycloak_not_configured: 'The console has no Keycloak admin credential, so membership cannot be read or changed.',
  keycloak_unavailable: 'Keycloak could not be reached. Try again in a moment.',
  store_unavailable: 'The console database is not configured.',
  authorization_unavailable: 'Your organization access could not be checked right now. Try again in a moment.',
  // Organisation names (/api/organizations) and the remaining workspace writes.
  invalid_name: 'Use a name whose slug is lowercase letters, digits and hyphens, starting with a letter.',
  name_required: 'Give the organization a name.',
  name_too_long: 'That name is too long.',
  name_reserved: 'That name is reserved by the platform. Choose another.',
  name_taken: 'An organization with that name already exists on this platform.',
  cannot_decide_own_request: 'You cannot approve or reject your own request.',
  confirmation_mismatch: 'The confirmation text does not match the organization name.',
  already_decided: 'This request has already been decided.',
}

/** Codes whose `detail` says something the message cannot: which role, which team, what failed. */
const DETAIL_ADDS_CONTEXT = new Set(['keycloak_denied', 'keycloak_unavailable', 'authorization_unavailable', 'unknown_team', 'rate_limited'])

/**
 * Codes the server uses for several situations, whose own message can only
 * guess: when the server explains which one it was, its sentence is shown
 * INSTEAD (a `not_found` "That account has already been set up" is not "it
 * may have been deleted").
 */
const DETAIL_REPLACES = new Set(['not_found', 'conflict', 'invalid_request'])

export interface WorkspaceErrorBody {
  status: number
  code?: string
  detail?: string
  /** Keycloak failed part-way through a multi-step write (e.g. removing a member from several groups). */
  partial?: boolean
}

export function workspaceErrorMessage(e: WorkspaceErrorBody): string {
  const known = e.code ? WORKSPACE_ERROR_MESSAGE[e.code] : undefined
  if (known) {
    if (e.partial) return `${known} Part of the change was applied; repeating it is safe and finishes the rest.`
    if (e.detail && e.code && DETAIL_REPLACES.has(e.code)) return asSentence(e.detail)
    if (e.detail && e.code && DETAIL_ADDS_CONTEXT.has(e.code)) return `${known} ${asSentence(e.detail)}`
    return known
  }
  if (e.detail) return asSentence(e.detail)
  if (e.status === 503) return WORKSPACE_ERROR_MESSAGE.store_unavailable
  return `Workspace request failed (${e.status}${e.code ? `: ${e.code}` : ''})`
}

function asSentence(s: string): string {
  const t = s.trim()
  if (!t) return t
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/* ─────────────────── lists ─────────────────── */

export interface MemberLike {
  userId: string
  email: string
  name: string
  username?: string
  role: OrgRole
  teams: string[]
  status?: MemberStatus
}

/** Search (name, email, username, team) and role filter, as the Members page applies them. */
export function filterMembers<M extends MemberLike>(members: readonly M[], query: string, role: 'all' | OrgRole): M[] {
  const q = query.trim().toLowerCase()
  return members.filter((m) => {
    if (role !== 'all' && m.role !== role) return false
    if (!q) return true
    return (
      m.name.toLowerCase().includes(q) ||
      m.email.toLowerCase().includes(q) ||
      (m.username ?? '').toLowerCase().includes(q) ||
      m.teams.some((t) => t.toLowerCase().includes(q))
    )
  })
}

/** Organisation members who can still be added to a team: everyone not already in it. */
export function teamCandidates<M extends { userId: string }>(orgMembers: readonly M[], inTeam: readonly { userId: string }[]): M[] {
  const taken = new Set(inTeam.map((m) => m.userId))
  return orgMembers.filter((m) => !taken.has(m.userId))
}

export function memberCounts(members: readonly MemberLike[]): { members: number; admins: number; invited: number } {
  return {
    members: members.length,
    admins: members.filter((m) => m.role === 'admin').length,
    invited: members.filter((m) => m.status === 'invited').length,
  }
}

/** The pattern the Team XRD enforces on a new team slug. */
export const TEAM_SLUG_RE = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/**
 * The slug the server derives when none is typed — the same derivation as
 * the BFF's `teamSlugFromName` (tenancy/org-access.ts), so the form can show
 * it and never submit a name whose slug would be refused: lower-cased, runs
 * of anything else as one hyphen, a `t-` before a leading digit, cut to 40
 * characters. Empty when nothing can be made (no Latin letters or digits).
 */
export function deriveTeamSlug(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) return ''
  if (!/^[a-z]/.test(s)) s = `t-${s}`
  return s.slice(0, 40).replace(/-+$/, '')
}

/** Enough to enable a button; the BFF is the one that validates. */
export function looksLikeEmail(s: string): boolean {
  const t = s.trim()
  return t.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)
}
