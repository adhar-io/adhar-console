import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth/server'
import {
  decideOrgScoped,
  isNewOrgSlug,
  isNewTeamSlug,
  NO_ACCESS,
  ORG_SCOPED,
  orgAccess,
  orgAdminGroup,
  orgMemberGroup,
  orgScopedRole,
  PLATFORM_ORG_SLUG,
  teamGroup,
  teamSlugFromName,
  teamsOf,
} from './org-access.ts'

Deno.test('roles come from the organisation\'s two groups', () => {
  assertEquals(orgAccess(['org-acme'], 'acme'), { role: 'member', via: 'membership' })
  assertEquals(orgAccess(['org-acme', 'org-acme-admin'], 'acme'), { role: 'admin', via: 'membership' })
  assertEquals(orgAccess(['org-acme-admin'], 'acme').role, 'admin')
  // Another organisation's groups give nothing here.
  assertEquals(orgAccess(['org-beta', 'org-beta-admin', 'ws-team-acme.payments'], 'acme'), NO_ACCESS)
})

Deno.test('group names are compared exactly, the way Kubernetes binds them', () => {
  // Keycloak lets ORG-ACME-ADMIN exist beside org-acme-admin, and the
  // apiserver binds `oidc:org-acme-admin` case-sensitively: a case variant
  // must not make the console treat someone as acme's admin.
  assertEquals(orgAccess(['ORG-ACME-ADMIN'], 'acme'), NO_ACCESS)
  assertEquals(orgAccess(['Org-Acme'], 'acme'), NO_ACCESS)
  assertEquals(orgAccess(['Platform-Admin'], 'acme'), NO_ACCESS)
  assertEquals(teamsOf(['WS-TEAM-acme.payments', 'ws-team-acme.Ops'], 'acme'), [])
})

Deno.test('platform admins are admins of every organisation; the realm `admin` group is not', () => {
  for (const g of ['platform-admin', 'platform-engineer', 'super-admin']) {
    assertEquals(orgAccess([g], 'acme'), { role: 'admin', via: 'platform-admin' }, g)
    assertEquals(orgAccess([g], PLATFORM_ORG_SLUG).role, 'admin', g)
  }
  assertEquals(orgAccess(['admin'], 'acme'), NO_ACCESS)
  // Listed AND platform admin: the listing is what is reported.
  assertEquals(orgAccess(['platform-admin', 'org-acme-admin'], 'acme').via, 'membership')
  assertEquals(orgAccess(['platform-admin', 'org-acme'], 'acme'), { role: 'admin', via: 'platform-admin' })
})

Deno.test('the platform team are members of the platform organisation only', () => {
  for (const g of ['platform-developer', 'platform-viewer']) {
    assertEquals(orgAccess([g], PLATFORM_ORG_SLUG), { role: 'member', via: 'platform-team' }, g)
    assertEquals(orgAccess([g], 'acme'), NO_ACCESS, g)
  }
})

Deno.test('the retired realm-wide role groups grant nothing', () => {
  assertEquals(orgAccess(['ws-role-owner', 'ws-role-admin', 'ws-team-platform'], 'acme'), NO_ACCESS)
})

Deno.test('slugs that would make ambiguous group names are refused', () => {
  // org-x-admin would be x's admin group AND x-admin's member group.
  assertEquals(isNewOrgSlug('acme-admin'), false)
  assertEquals(isNewOrgSlug('acme'), true)
  for (const bad of ['9lives', '-a', 'a-', 'a.b', 'A', 'a_b', 'x'.repeat(41), '']) {
    assertEquals(isNewOrgSlug(bad), false, bad)
    assertEquals(isNewTeamSlug(bad), false, bad)
  }
  // A team MAY end in -admin: `ws-team-acme.ops-admin` cannot be misread.
  assertEquals(isNewTeamSlug('ops-admin'), true)
  // `.` separates organisation and team, so it can appear in neither.
  assertThrows(() => teamGroup('acme.evil', 'x'))
  assertThrows(() => teamGroup('acme', 'x.y'))
  assertThrows(() => orgMemberGroup('Acme'))
  assertThrows(() => orgAdminGroup('a/b'))
  assertEquals(teamGroup('acme', 'platform-x'), 'ws-team-acme.platform-x')
  assertEquals(teamGroup('acme-platform', 'x'), 'ws-team-acme-platform.x')
  assertEquals(orgAccess(['org-a.b'], 'a.b'), NO_ACCESS)
})

Deno.test('a slug derived from a team name always fits the Team XRD', () => {
  assertEquals(teamSlugFromName('Ops Crew'), 'ops-crew')
  // A leading digit and an over-long name were refused with a slug nobody typed.
  assertEquals(teamSlugFromName('2026 Platform'), 't-2026-platform')
  const long = teamSlugFromName('Platform Engineering and Developer Experience')
  assertEquals(long, 'platform-engineering-and-developer-exper')
  for (const name of ['2026 Platform', 'Platform Engineering and Developer Experience', 'a'.repeat(39) + ' b', '--x--', '9']) {
    assert(isNewTeamSlug(teamSlugFromName(name)), `${name} → ${teamSlugFromName(name)}`)
  }
  assertEquals(teamSlugFromName('日本'), '')
})

Deno.test('team slugs are read back from qualified groups of THIS organisation only', () => {
  assertEquals(teamsOf(['ws-team-acme.payments', 'ws-team-acme.ops', 'ws-team-acmex.y', 'ws-team-beta.ops', 'ws-team-payments'], 'acme'), [
    'ops',
    'payments',
  ])
})

Deno.test('org-scoped permissions: members read billing and audit, admins do the rest', () => {
  const member = orgAccess(['org-acme'], 'acme')
  const admin = orgAccess(['org-acme-admin', 'org-acme'], 'acme')
  assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS.billingView, member), true)
  assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS.auditView, member), true)
  for (const name of ['membersInvite', 'membersUpdate', 'membersRemove', 'teamsCreate', 'orgDelete', 'billingManage', 'tokensCreate', 'approvalsDecide'] as const) {
    assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS[name], member), false, name)
    assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS[name], admin), true, name)
    assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS[name], NO_ACCESS), false, name)
  }
  assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS.billingView, NO_ACCESS), false)
})

Deno.test('creating organisations and every non-organisation permission stay RBAC', () => {
  assertEquals(orgScopedRole(CONSOLE_PERMISSIONS.orgCreate), undefined)
  assertEquals(orgScopedRole(CONSOLE_PERMISSIONS.packagesToggle), undefined)
  assertEquals(orgScopedRole({ verb: 'delete', group: '', resource: 'pods' }), undefined)
  assertEquals(decideOrgScoped(CONSOLE_PERMISSIONS.waiverApprove, orgAccess(['platform-admin'], 'acme')), undefined)
  assertEquals(ORG_SCOPED.size, 21)
  assert(ORG_SCOPED.has([...ORG_SCOPED.keys()].find((k) => k.includes('workspace-members'))!))
})

Deno.test('a namespace on an org-scoped check does not take it back to RBAC', () => {
  // Otherwise an aggregated namespace `admin` binding could re-grant what the
  // organisation's groups refuse.
  assertEquals(orgScopedRole(consoleCheck(CONSOLE_PERMISSIONS.membersInvite, 'acme')), 'admin')
  assertEquals(decideOrgScoped(consoleCheck(CONSOLE_PERMISSIONS.billingManage, 'team-ns'), orgAccess(['org-acme'], 'acme')), false)
})
