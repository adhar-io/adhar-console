import { assertEquals } from 'jsr:@std/assert'
import { usernameFromEmail } from './index.ts'

Deno.test('usernameFromEmail matches what Coder derives at OIDC sign-in', () => {
  assertEquals(usernameFromEmail('user1@noreply.com'), 'user1')
  assertEquals(usernameFromEmail('Tapas.Jena@example.com'), 'tapas-jena')
  assertEquals(usernameFromEmail('first_last+tag@x.io'), 'first-last-tag')
  assertEquals(usernameFromEmail('--weird--@x.io'), 'weird')
  assertEquals(usernameFromEmail('@x.io'), 'user')
  assertEquals(usernameFromEmail('a'.repeat(40) + '@x.io').length, 32)
})

import { workspaceNameFor } from './index.ts'
Deno.test('workspaceNameFor yields a valid Coder workspace name from a repo name', () => {
  assertEquals(workspaceNameFor('ci-probe-go'), 'ci-probe-go')
  assertEquals(workspaceNameFor('My_Service.v2'), 'my-service-v2')
  assertEquals(workspaceNameFor('--x--'), 'x')
  assertEquals(workspaceNameFor(''), 'repo')
  assertEquals(workspaceNameFor('a'.repeat(50)).length, 32)
})
