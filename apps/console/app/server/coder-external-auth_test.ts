import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { externalAuthStatus } from './coder-ide.ts'

// The Console links a person's Gitea account in Coder before it opens a
// repository: until that link exists the workspace's `git clone` waits on
// GIT_ASKPASS and the IDE opened on an empty folder (2026-10-27).

const BASE = 'https://coder.example.test'

Deno.test('an unlinked person gets the URL that starts the link and comes back to Coder', () => {
  const s = externalAuthStatus('gitea', 200, { authenticated: false, display_name: 'Gitea' }, BASE)
  assertEquals(s.configured, true)
  assertEquals(s.authenticated, false)
  // Coder's callback without a `code` redirects to the provider; `redirect`
  // brings the browser back to Coder's own confirmation page.
  assertEquals(s.startUrl, `${BASE}/external-auth/gitea/callback?redirect=%2Fexternal-auth%2Fgitea`)
})

Deno.test('a linked person needs nothing', () => {
  const s = externalAuthStatus('gitea', 200, { authenticated: true }, BASE)
  assertEquals(s.authenticated, true)
})

Deno.test('a Coder without the provider has nothing to link (and nothing to wait for)', () => {
  const s = externalAuthStatus('gitea', 404, null, BASE)
  assertEquals(s.configured, false)
  assertEquals(s.authenticated, false)
})
