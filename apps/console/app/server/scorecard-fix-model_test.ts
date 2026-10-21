import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  actorName,
  canApplyFix,
  canClaimOwnership,
  declaredOwner,
  fixCommitMessage,
  ownerTeam,
  refName,
  safePath,
  validateFixRequest,
} from './scorecard-fix-model.ts'
import { rerunFocus } from './scorecards.ts'

Deno.test('canApplyFix: admins always, developers only for their own team', () => {
  assertEquals(canApplyFix({ roles: ['platform-admin'] }, 'group:payments').ok, true)
  assertEquals(canApplyFix({ roles: ['viewer'], groups: ['/org/Platform-Admins'] }, undefined).ok, true)
  assertEquals(canApplyFix({ roles: ['developer'], groups: ['payments'] }, 'group:payments').ok, true)
  assertEquals(canApplyFix({ roles: ['developer'], groups: ['/acme/team-payments'] }, 'group:default/payments').ok, true)
  const other = canApplyFix({ roles: ['developer'], groups: ['search'] }, 'group:payments')
  assertEquals(other.ok, false)
  assert(!other.ok && other.reason.includes('payments'))
  // A viewer in the team is still a viewer.
  assertEquals(canApplyFix({ roles: ['viewer'], groups: ['payments'] }, 'payments').ok, false)
  // No owner: only an admin.
  assertEquals(canApplyFix({ roles: ['developer'], groups: ['payments'] }, undefined).ok, false)
  assertEquals(canApplyFix(null, 'payments').ok, false)
})

Deno.test('canClaimOwnership: developers and admins may set a missing owner', () => {
  assertEquals(canClaimOwnership({ roles: ['developer'] }).ok, true)
  assertEquals(canClaimOwnership({ roles: ['platform-admin'] }).ok, true)
  assertEquals(canClaimOwnership({ roles: ['viewer'] }).ok, false)
})

Deno.test('ownerTeam / refName', () => {
  assertEquals(ownerTeam('group:default/Payments'), 'payments')
  assertEquals(ownerTeam('payments'), 'payments')
  assertEquals(ownerTeam(undefined), undefined)
  assertEquals(refName('component:default/cart'), 'cart')
  assertEquals(refName('component:cart'), 'cart')
})

Deno.test('safePath refuses escapes', () => {
  assert(safePath('deploy/base/hpa.yaml'))
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a//b', '.git/config', 'a\\b']) assert(!safePath(bad), bad)
})

const good = {
  entityRef: 'component:cart',
  org: 'acme',
  repo: 'cart',
  mode: 'pr',
  newBranch: 'scorecard/cart-has-owner-1',
  title: 'Set owner',
  files: [{ path: 'catalog-info.yaml', content: 'x', baseSha: 'abc1234' }],
}

Deno.test('validateFixRequest: accepts a well-formed PR, rejects the rest', () => {
  const ok = validateFixRequest(good)
  assert(ok.ok)
  assertEquals(ok.ok && ok.value.files[0].baseSha, 'abc1234')
  assert(validateFixRequest({ ...good, mode: 'commit', newBranch: undefined }).ok)
  assert(!validateFixRequest({ ...good, newBranch: undefined }).ok)
  assert(!validateFixRequest({ ...good, org: '../x' }).ok)
  assert(!validateFixRequest({ ...good, files: [] }).ok)
  assert(!validateFixRequest({ ...good, files: [{ path: '../x', content: '', baseSha: null }] }).ok)
  assert(!validateFixRequest({ ...good, files: [{ path: 'a', content: '', baseSha: 'not-a-sha!' }] }).ok)
  assert(!validateFixRequest({ ...good, files: [good.files[0], good.files[0]] }).ok)
  assert(!validateFixRequest({ ...good, descriptorPath: '/abs' }).ok)
  assert(validateFixRequest({ ...good, files: [{ path: 'new.yaml', content: '', baseSha: null }] }).ok)
})

Deno.test('declaredOwner reads spec.owner of the matching document', () => {
  const text = `apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: cart-api
spec:
  owner: apis
---
kind: Component
metadata:
  name: cart # the service
spec:
  type: service
  owner: "payments" # squad
`
  assertEquals(declaredOwner(text, 'cart'), 'payments')
  assertEquals(declaredOwner(text, 'unknown'), 'apis')
  assertEquals(declaredOwner('kind: Component\nmetadata:\n  name: x\n', 'x'), undefined)
})

Deno.test('commit message names the console user', () => {
  assertEquals(fixCommitMessage('Set owner', 'Ada'), 'Set owner\n\nvia Adhar console by Ada')
  assertEquals(actorName({ email: 'a@x' }), 'a@x')
  assertEquals(actorName(null), 'unknown user')
})

Deno.test('rerunFocus: optional, validated, backward compatible', () => {
  assertEquals(rerunFocus(null), undefined)
  assertEquals(rerunFocus({}), undefined)
  assertEquals(rerunFocus({ service: 'cart' }), 'cart')
  assertEquals(rerunFocus({ service: 'bad name!' }), undefined)
})
