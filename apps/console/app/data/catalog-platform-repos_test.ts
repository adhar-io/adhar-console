import { assertEquals } from 'jsr:@std/assert@1'
import { isPlatformRepo, PLATFORM_REPOS } from './catalog-platform-repos.ts'

Deno.test('platform repos are not catalog services', () => {
  for (const name of PLATFORM_REPOS) assertEquals(isPlatformRepo(name), true, `${name} is platform infrastructure, not a service`)
})

Deno.test('a team repo is a catalog service', () => {
  for (const name of ['my-service', 'reactapp', 'ngapp']) assertEquals(isPlatformRepo(name), false, `${name} is the team's software and must still list`)
})

Deno.test('the platform source mirror is not a service, by name and as a mirror', () => {
  // `adhar` is github.com/adhar-io/adhar mirrored for the AI knowledge base;
  // it showed in the catalog as a Component on 2026-10-15.
  assertEquals(isPlatformRepo('adhar'), true)
  // Any pull mirror is upstream code the platform fetched, whatever it is called.
  assertEquals(isPlatformRepo('some-upstream-lib', { mirror: true }), true)
  // A team repo is still a service, and a non-mirror flag changes nothing.
  assertEquals(isPlatformRepo('my-service', { mirror: false }), false)
  assertEquals(isPlatformRepo('Adhar'), true)
})
