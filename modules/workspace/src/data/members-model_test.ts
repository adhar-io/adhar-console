import { assert, assertEquals } from 'jsr:@std/assert@^1'
import {
  deriveTeamSlug,
  filterMembers,
  looksLikeEmail,
  memberCounts,
  memberStatusBadge,
  TEAM_SLUG_RE,
  teamCandidates,
  WORKSPACE_ERROR_MESSAGE,
  workspaceErrorMessage,
} from './members-model.ts'

/**
 * Every code the workspace BFF contract names (the Keycloak membership plan,
 * section A). Written out here rather than read from the map, so a code that
 * loses its message — or a new one nobody worded — fails this test instead of
 * reaching someone as "Workspace request failed (409: …)".
 */
const CONTRACT_CODES = [
  // 400
  'invalid_json', 'invalid_user_id', 'invalid_role', 'invalid_email', 'invalid_slug', 'invalid_query', 'unknown_team', 'cannot_remove_self',
  // 403
  'requires_org_admin', 'forbidden', 'not_a_member', 'plane_invitations_disabled',
  // 404
  'not_found', 'user_not_found',
  // 409
  'no_organisation', 'already_member', 'user_exists', 'cannot_demote_last_admin', 'cannot_remove_last_admin', 'cannot_leave_last_admin',
  'platform_organisation', 'platform_admin_access', 'slug_taken', 'reauth_required',
  // 410
  'invitations_removed', 'ownership_removed',
  // 422
  'keycloak_email_not_configured',
  // 502
  'keycloak_denied',
  // 503
  'keycloak_not_configured', 'keycloak_unavailable', 'store_unavailable', 'authorization_unavailable',
]

Deno.test('every contract error code has a message of its own', () => {
  const missing = CONTRACT_CODES.filter((c) => !WORKSPACE_ERROR_MESSAGE[c]?.trim())
  assertEquals(missing, [])
  for (const code of CONTRACT_CODES) {
    const msg = workspaceErrorMessage({ status: 400, code })
    assert(!msg.includes(code), `${code} leaks the raw code: ${msg}`)
  }
})

/**
 * The codes the BFF actually sends, read from its source: every snake_case
 * string literal in the files that answer /api/workspace and
 * /api/organizations, plus the one-word codes in error positions. A code
 * added there without a message here fails this test — it would otherwise
 * reach someone as "Workspace request failed (400: …)".
 */
const SERVER = new URL('../../../../apps/console/app/server/', import.meta.url)
const SERVER_FILES = ['workspace/handlers.ts', 'workspace/keycloak-admin.ts', 'request-user.ts', 'organizations.ts', 'k8s/access.ts']
/** Snake_case literals in those files that are not error codes. */
const NOT_CODES = new Set(['client_credentials', 'client_id', 'redirect_uri', 'send_failed', 'email_failed'])

function serverCodes(): string[] {
  const out = new Set<string>()
  for (const f of SERVER_FILES) {
    const src = Deno.readTextFileSync(new URL(f, SERVER))
    for (const m of src.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)) if (!NOT_CODES.has(m[1])) out.add(m[1])
    for (const m of src.matchAll(/(?:error:\s*|badRequest\(\s*|notFound\(\s*|conflict\(\s*|body\(\s*)'([a-z_]+)'/g)) out.add(m[1])
  }
  return [...out].sort()
}

Deno.test('every code the server sends has a message of its own', () => {
  const codes = serverCodes()
  // The scan must actually see the server, or this test proves nothing.
  for (const c of ['user_not_in_organisation', 'setup_not_pending', 'email_unverified', 'email_send_failed', 'forbidden', 'conflict']) {
    assert(codes.includes(c), `${c} not found in the server source — is the scan still reading it?`)
  }
  assertEquals(codes.filter((c) => !WORKSPACE_ERROR_MESSAGE[c]?.trim()), [])
})

Deno.test('a code the server uses for several things shows the server\'s own sentence', () => {
  const said = 'That account has already been set up; there is no set-password email to send.'
  assertEquals(workspaceErrorMessage({ status: 404, code: 'not_found', detail: said }), said)
  // Without one, the generic message stands.
  assertEquals(workspaceErrorMessage({ status: 404, code: 'not_found' }), WORKSPACE_ERROR_MESSAGE.not_found)
  // A person acted on who is not in the organisation is not "you are not a member".
  assert(!WORKSPACE_ERROR_MESSAGE.user_not_in_organisation.startsWith('You are'))
})

Deno.test('the slug preview is the server\'s derivation, and always fits the Team XRD', () => {
  // The same cases tenancy/org-access_test.ts pins for teamSlugFromName.
  assertEquals(deriveTeamSlug('Ops Crew'), 'ops-crew')
  assertEquals(deriveTeamSlug('2026 Platform'), 't-2026-platform')
  assertEquals(deriveTeamSlug('Platform Engineering and Developer Experience'), 'platform-engineering-and-developer-exper')
  assertEquals(deriveTeamSlug('日本'), '')
  for (const n of ['2026 Platform', 'a'.repeat(39) + ' b', '--x--', '9']) assert(TEAM_SLUG_RE.test(deriveTeamSlug(n)), n)
})

Deno.test('the retired owner and invitation codes are gone from the map', () => {
  for (const old of ['requires_owner', 'requires_admin_or_owner', 'cannot_demote_last_owner', 'cannot_remove_last_owner']) {
    assertEquals(WORKSPACE_ERROR_MESSAGE[old], undefined, old)
  }
})

Deno.test('a denied Keycloak call names what is missing; a plain code does not repeat the detail', () => {
  const denied = workspaceErrorMessage({ status: 502, code: 'keycloak_denied', detail: 'service account lacks realm-management manage-users' })
  assert(denied.startsWith(WORKSPACE_ERROR_MESSAGE.keycloak_denied))
  assert(denied.includes('manage-users'))
  assertEquals(workspaceErrorMessage({ status: 409, code: 'already_member', detail: 'user is in org-acme' }), WORKSPACE_ERROR_MESSAGE.already_member)
})

Deno.test('a partial failure says retrying is safe', () => {
  const msg = workspaceErrorMessage({ status: 503, code: 'keycloak_unavailable', partial: true })
  assert(msg.startsWith(WORKSPACE_ERROR_MESSAGE.keycloak_unavailable))
  assert(/repeating it is safe/.test(msg))
})

Deno.test('unknown codes fall back to the detail, then to the status', () => {
  assertEquals(workspaceErrorMessage({ status: 400, code: 'brand_new', detail: 'Something specific' }), 'Something specific.')
  assertEquals(workspaceErrorMessage({ status: 418, code: 'brand_new' }), 'Workspace request failed (418: brand_new)')
  assertEquals(workspaceErrorMessage({ status: 503 }), WORKSPACE_ERROR_MESSAGE.store_unavailable)
})

Deno.test('membership status maps to a badge', () => {
  assertEquals(memberStatusBadge('active'), { kind: 'healthy', label: 'Active', hint: 'Can sign in' })
  assertEquals(memberStatusBadge('invited').label, 'Invited')
  assertEquals(memberStatusBadge('invited').kind, 'paused')
  assertEquals(memberStatusBadge('disabled').kind, 'unknown')
})

const ada = { userId: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', username: 'ada', role: 'admin' as const, teams: ['payments'], status: 'active' as const }
const bob = { userId: 'u2', email: 'bob@example.com', name: 'Bob', username: 'bobby', role: 'member' as const, teams: [], status: 'invited' as const }

Deno.test('the member filter matches name, email, username and team, and narrows by role', () => {
  const all = [ada, bob]
  assertEquals(filterMembers(all, '', 'all').map((m) => m.userId), ['u1', 'u2'])
  assertEquals(filterMembers(all, 'PAY', 'all').map((m) => m.userId), ['u1'])
  assertEquals(filterMembers(all, 'bobby', 'all').map((m) => m.userId), ['u2'])
  assertEquals(filterMembers(all, '', 'member').map((m) => m.userId), ['u2'])
  assertEquals(filterMembers(all, 'ada', 'member'), [])
})

Deno.test('team candidates are the organisation members not already in the team', () => {
  assertEquals(teamCandidates([ada, bob], [{ userId: 'u1' }]).map((m) => m.userId), ['u2'])
  assertEquals(teamCandidates([ada], [{ userId: 'u1' }]), [])
})

Deno.test('counts: admins and people who have not set a password yet', () => {
  assertEquals(memberCounts([ada, bob]), { members: 2, admins: 1, invited: 1 })
})

Deno.test('a new team slug follows the Team XRD pattern', () => {
  for (const ok of ['payments', 'p', 'team-2', 'a'.repeat(40)]) assert(TEAM_SLUG_RE.test(ok), ok)
  // A dot would make ws-team-<org>.<team> ambiguous; a digit first or a 41st character the XRD refuses.
  for (const bad of ['2fa', 'Payments', 'pay.ments', 'team-', '-team', 'a'.repeat(41), '']) assert(!TEAM_SLUG_RE.test(bad), bad)
})

Deno.test('email shape check is only a button gate', () => {
  assert(looksLikeEmail(' ada@example.com '))
  assert(!looksLikeEmail('ada'))
  assert(!looksLikeEmail('ada@example'))
})
