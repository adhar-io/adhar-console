import { assertEquals } from 'jsr:@std/assert'
import { isPlatformRepo, PLATFORM_REPOS } from './catalog-live.ts'

/**
 * Every repo in the Gitea org used to become a catalog Component, and the
 * platform keeps its own repos in that org — so scaffolding ONE service made six
 * appear next to it. The k8s half of the live catalog always filtered its
 * equivalent (system namespaces); the Gitea half had no counterpart.
 */
Deno.test('platform repos are not catalog services', () => {
  for (const name of ['packages', 'environments', 'templates', 'adhar-templates', 'adhar-ui', 'adhar-kit']) {
    assertEquals(isPlatformRepo(name), true, `${name} is platform infrastructure, not a service`)
  }
})

Deno.test('a team repo is a catalog service', () => {
  for (const name of ['cart', 'checkout-api', 'my-adhar-thing', 'packages-service', 'ui']) {
    assertEquals(isPlatformRepo(name), false, `${name} is the team's software and must still list`)
  }
})

/** Gitea repo names are case-insensitive for our purposes; a missing name is not a service. */
Deno.test('matching tolerates case and a missing name', () => {
  assertEquals(isPlatformRepo('Packages'), true)
  assertEquals(isPlatformRepo('ADHAR-UI'), true)
  assertEquals(isPlatformRepo(undefined), false)
  assertEquals(isPlatformRepo(''), false)
})

/**
 * Kept in lockstep with the CEL interceptor in
 * packages/application/adhar-supply-chain/manifests/70-app-ci.yaml, which skips
 * exactly these repos: a push to one is platform traffic, not an app build.
 */
Deno.test('the set matches the supply-chain pipeline exclusions', () => {
  assertEquals(
    [...PLATFORM_REPOS].sort(),
    ['adhar-kit', 'adhar-templates', 'adhar-ui', 'environments', 'packages', 'templates'],
  )
})
