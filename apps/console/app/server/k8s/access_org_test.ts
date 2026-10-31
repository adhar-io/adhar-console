/**
 * The org-scoped console permissions are answered from the organisation's
 * groups, not by Kubernetes RBAC — and still through the one choke point, so
 * <Can> and the handlers agree. Pinned here: they never reach a
 * SelfSubjectAccessReview or the shared answer cache (whose key carries no
 * organisation), and every other check still does.
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { accessCheckKey, type AccessCheck, CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth/server'
import { AccessCache, authorize, evaluateChecks, orgPermissionDenied, type OrgScope } from './access.ts'
import { NO_ACCESS, orgAccess } from '../tenancy/org-access.ts'

const pods: AccessCheck = { verb: 'list', group: '', resource: 'pods', namespace: 'shop' }
const invite = consoleCheck(CONSOLE_PERMISSIONS.membersInvite)
const billing = consoleCheck(CONSOLE_PERMISSIONS.billingView)
const toggle = consoleCheck(CONSOLE_PERMISSIONS.packagesToggle)

const scope = (groups: string[], slug = 'acme'): OrgScope => ({ access: orgAccess(groups, slug), degraded: false, slug })

function spy() {
  const asked: string[] = []
  const review = (c: AccessCheck) => {
    asked.push(accessCheckKey(c))
    return Promise.resolve(true)
  }
  return { asked, review }
}

Deno.test('org-scoped checks never reach a review or the cache; the rest still do', async () => {
  const { asked, review } = spy()
  const cache = new AccessCache()
  const r = await evaluateChecks([invite, pods, billing, toggle], review, scope(['org-acme']), { cache, scope: 'u1' })
  // A member: may read billing, may not invite; RBAC said yes to the others.
  assertEquals(r, { results: [false, true, true, true], degraded: false })
  assertEquals(asked, [accessCheckKey(pods), accessCheckKey(toggle)])
  assertEquals(cache.size, 2, 'only the RBAC answers are cached')
})

Deno.test('the answer follows the organisation, not a cached guess', async () => {
  const { review } = spy()
  const cache = new AccessCache()
  const admin = await evaluateChecks([invite], review, scope(['org-acme', 'org-acme-admin']), { cache, scope: 'u1' })
  const elsewhere = await evaluateChecks([invite], review, scope(['org-acme', 'org-acme-admin'], 'beta'), { cache, scope: 'u1' })
  assertEquals([admin.results[0], elsewhere.results[0]], [true, false])
})

Deno.test('an organisation that could not be resolved is a degraded no, without a review', async () => {
  const { asked, review } = spy()
  const r = await evaluateChecks([invite, pods], review, { access: NO_ACCESS, degraded: true }, {})
  assertEquals(r, { results: [false, true], degraded: true })
  assertEquals(asked, [accessCheckKey(pods)])
  // No session context at all: a plain no.
  assertEquals((await evaluateChecks([billing], review, null, {})).results, [false])
})

Deno.test('authorize answers org-scoped checks from the organisation alone', async () => {
  const id = { token: 't', user: { id: 'u1', name: 'U', email: 'u@x', groups: ['org-acme-admin', 'org-acme'] } }
  const req = new Request('http://console.test/')
  const yes = await authorize(req, invite, { id, org: scope(['org-acme-admin', 'org-acme']) })
  assertEquals(yes.allowed, true)
  const no = await authorize(req, invite, { id, org: scope(['org-acme']) })
  assertEquals(no.allowed, false)
  // A namespace or a cluster does not send it to RBAC either.
  const ns = await authorize(req, { ...invite, namespace: 'acme' }, { id, org: scope(['org-acme']), cluster: 'nowhere' })
  assertEquals(ns.allowed, false)
})

Deno.test('refusals name the organisation\'s groups, not an RBAC rule', async () => {
  const admin = orgPermissionDenied(CONSOLE_PERMISSIONS.membersInvite, scope(['org-acme']))
  assertEquals(admin.status, 403)
  const body = await admin.json()
  assertEquals(body.error, 'requires_org_admin')
  assertEquals(body.detail.includes('org-acme-admin'), true)
  const outsider = await orgPermissionDenied(CONSOLE_PERMISSIONS.membersInvite, scope(['org-beta'])).json()
  assertEquals(outsider.error, 'not_a_member')
  const nowhere = orgPermissionDenied(CONSOLE_PERMISSIONS.billingView, { access: NO_ACCESS, degraded: false, personal: true })
  assertEquals([nowhere.status, (await nowhere.json()).error], [409, 'no_organisation'])
  assertEquals(orgPermissionDenied(CONSOLE_PERMISSIONS.billingView, { access: NO_ACCESS, degraded: true }).status, 503)
})
