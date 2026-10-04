import { assertEquals } from 'jsr:@std/assert'
import { shortRepo, sourceRef } from './source-ref.ts'

/**
 * Every Application on this platform points at the same in-cluster Gitea, so
 * the host is the part the cards had in common and the repository is the part
 * that got truncated away.
 */
Deno.test('an in-cluster Gitea URL names its repository', () => {
  assertEquals(
    shortRepo('http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/manifests'),
    'adhar/manifests',
  )
})

Deno.test('the scheme, a trailing slash and .git are all noise', () => {
  for (
    const u of [
      'https://gitea.test.adhar.io/adhar/test-service',
      'https://gitea.test.adhar.io/adhar/test-service.git',
      'https://gitea.test.adhar.io/adhar/test-service/',
      'gitea.test.adhar.io/adhar/test-service',
    ]
  ) {
    assertEquals(shortRepo(u), 'adhar/test-service', u)
  }
})

/** `git@host:org/repo` is not a URL — the colon is a separator, not a port. */
Deno.test('an ssh remote is read, not mistaken for a port', () => {
  assertEquals(shortRepo('git@gitea.test.adhar.io:adhar/test-service.git'), 'adhar/test-service')
})

Deno.test('a deep path keeps the last two segments', () => {
  assertEquals(shortRepo('https://host/a/b/c/d'), 'c/d')
})

Deno.test('a Helm repository is named by host and chart repo', () => {
  assertEquals(shortRepo('https://charts.bitnami.com/bitnami'), 'charts.bitnami.com/bitnami')
  assertEquals(shortRepo('oci://registry.adhar.io/charts/nginx'), 'charts/nginx')
})

Deno.test('a host on its own is all there is to show', () => {
  assertEquals(shortRepo('https://gitea.test.adhar.io'), 'gitea.test.adhar.io')
})

Deno.test('query and fragment are not part of the name', () => {
  assertEquals(shortRepo('https://host/org/repo?ref=main#frag'), 'org/repo')
})

Deno.test('no source URL renders as a dash, never as "undefined"', () => {
  assertEquals(shortRepo(''), '—')
  assertEquals(shortRepo('   '), '—')
  assertEquals(shortRepo(undefined as unknown as string), '—')
})

Deno.test('a chart source reads as a chart, a git source as its path', () => {
  assertEquals(sourceRef({ chart: 'nginx', targetRevision: '1.2.3' }), 'chart nginx @ 1.2.3')
  assertEquals(sourceRef({ path: 'apps/web', targetRevision: 'main' }), 'apps/web @ main')
})

/** Argo CD's own default when `targetRevision` is unset, and the repo root. */
Deno.test('an unset revision is HEAD and an unset path is the root', () => {
  assertEquals(sourceRef({ path: 'apps/web' }), 'apps/web @ HEAD')
  assertEquals(sourceRef({}), '/ @ HEAD')
})
