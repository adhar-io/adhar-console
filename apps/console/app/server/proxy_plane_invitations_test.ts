import { assertEquals } from 'jsr:@std/assert@1'
import { planeInvitationPath, planeMembershipDenied, proxyToolRequest } from './proxy.ts'

// People join through Keycloak; the console's Plane proxy carries the console's
// own API key, so Plane's invitation routes are closed outright.

Deno.test('every spelling of a Plane invitation route is recognised', () => {
  for (const p of [
    '/api/v1/workspaces/adhar/invitations/',
    '/api/v1/workspaces/adhar/invitations',
    '/api/v1/workspaces/adhar/invitations/0b6d8f6e/',
    '/api/workspaces/adhar/invitations/',
    '/api/v1//workspaces/adhar//invitations/',
    '/api/v1/workspaces/adhar%2Finvitations/',
    '/api/v1/Workspaces/adhar/Invitations/',
    '/api/users/me/workspaces/invitations/',
  ]) {
    assertEquals(planeInvitationPath(p), true, p)
  }
  for (const p of ['/api/v1/workspaces/adhar/members/', '/api/v1/workspaces/adhar/projects/x/issues/', '/api/v1/workspaces/invitations-team/projects/']) {
    assertEquals(planeInvitationPath(p), false, p)
  }
})

Deno.test('the Plane proxy refuses invitations for every method', async () => {
  Deno.env.set('PLANE_URL', 'http://plane.invalid')
  try {
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
      const res = await proxyToolRequest(new Request('http://console.test/api/svc/plane/api/v1/workspaces/adhar/invitations/', { method }), 'plane', 'api/v1/workspaces/adhar/invitations/')
      assertEquals(res.status, 403, method)
      assertEquals((await res.json()).error, 'plane_invitations_disabled')
    }
  } finally {
    Deno.env.delete('PLANE_URL')
  }
})

Deno.test('project invitations, the invitation inbox and join routes are closed too', () => {
  for (const p of [
    '/api/workspaces/adhar/projects/0b6d8f6e/invitations/',
    '/api/workspaces/adhar/projects/0b6d8f6e/project-invitations/',
    '/api/users/me/invitations/workspaces/',
    '/api/users/me/invitations/projects/',
    '/api/workspaces/adhar/invitations/0b6d8f6e/join/',
    '/api/workspaces/adhar/projects/0b6d8f6e/join/',
  ]) {
    assertEquals(planeInvitationPath(p), true, p)
  }
})

Deno.test('changing Plane membership takes an admin of the workspace\'s organisation', () => {
  const add = '/api/v1/workspaces/adhar/projects/0b6d8f6e/project-members/'
  const role = '/api/workspaces/adhar/projects/0b6d8f6e/project-members/7f1c/'
  const ws = '/api/v1/workspaces/adhar/members/7f1c/'
  // A member of the organisation, or nobody's member: refused for every write.
  for (const groups of [['org-adhar'], ['org-acme-admin'], []]) {
    for (const [m, p] of [['POST', add], ['PATCH', role], ['DELETE', role], ['PATCH', ws], ['DELETE', ws]] as const) {
      const r = planeMembershipDenied(groups, m, p)
      assertEquals(r?.status, 403, `${groups.join(',')} ${m} ${p}`)
    }
  }
  // Reads stay open; admins of that organisation and platform admins may write.
  assertEquals(planeMembershipDenied(['org-adhar'], 'GET', add), null)
  assertEquals(planeMembershipDenied(['org-adhar', 'org-adhar-admin'], 'POST', add), null)
  assertEquals(planeMembershipDenied(['platform-admin'], 'DELETE', role), null)
  // Work items are not membership.
  assertEquals(planeMembershipDenied(['org-adhar'], 'POST', '/api/v1/workspaces/adhar/projects/x/issues/'), null)
  // No session to read groups from (a laptop without auth): nothing to decide on.
  assertEquals(planeMembershipDenied(null, 'POST', add), null)
})
