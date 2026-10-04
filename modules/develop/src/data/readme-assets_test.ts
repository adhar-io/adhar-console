import { assertEquals } from 'jsr:@std/assert'
import { dirOf, isExternal, normalizePath, resolveReadmeImage } from './readme-assets.ts'

const CTX = { owner: 'adhar', repo: 'test-service', ref: 'main', dir: '' }
const BASE = '/api/svc/gitea/api/v1/repos/adhar/test-service/raw'

Deno.test('a repo-relative image resolves onto the raw endpoint', () => {
  assertEquals(resolveReadmeImage('./docs/arch.png', CTX), `${BASE}/docs/arch.png?ref=main`)
  assertEquals(resolveReadmeImage('docs/arch.png', CTX), `${BASE}/docs/arch.png?ref=main`)
})

/** A leading slash in a README means the repository root, not the host root. */
Deno.test('a leading slash is the repository root', () => {
  assertEquals(resolveReadmeImage('/screenshots/home.png', CTX), `${BASE}/screenshots/home.png?ref=main`)
})

Deno.test('a README in a subdirectory resolves against its own directory', () => {
  const ctx = { ...CTX, dir: 'docs/guide' }
  assertEquals(resolveReadmeImage('./img/a.png', ctx), `${BASE}/docs/guide/img/a.png?ref=main`)
  assertEquals(resolveReadmeImage('../shared/b.png', ctx), `${BASE}/docs/shared/b.png?ref=main`)
})

/** A `..` too many is a mistake in the README, not a way out of the repo. */
Deno.test('a path cannot climb out of the repository', () => {
  assertEquals(resolveReadmeImage('../../../etc/passwd', CTX), `${BASE}/etc/passwd?ref=main`)
  assertEquals(normalizePath('../../a'), 'a')
  assertEquals(normalizePath('a/./b/../c'), 'a/c')
})

Deno.test('external images are returned untouched for the caller to decide on', () => {
  const badge = 'https://img.shields.io/badge/cov-90%25-green'
  assertEquals(resolveReadmeImage(badge, CTX), badge)
  assertEquals(resolveReadmeImage('//cdn.example.com/x.png', CTX), 'https://cdn.example.com/x.png')
  assertEquals(isExternal(badge), true)
  assertEquals(isExternal('./x.png'), false)
})

Deno.test('inline data is already the image', () => {
  const d = 'data:image/png;base64,iVBORw0KGgo='
  assertEquals(resolveReadmeImage(d, CTX), d)
})

/** Nothing to fetch is better than a broken image icon where alt text was. */
Deno.test('things that are not image references resolve to nothing', () => {
  assertEquals(resolveReadmeImage('', CTX), undefined)
  assertEquals(resolveReadmeImage('   ', CTX), undefined)
  assertEquals(resolveReadmeImage('#section', CTX), undefined)
  assertEquals(resolveReadmeImage('mailto:x@y.z', CTX), undefined)
  assertEquals(resolveReadmeImage('./x.png', { owner: '', repo: '', ref: 'main' }), undefined)
})

Deno.test('a query or fragment is not part of the file path', () => {
  assertEquals(resolveReadmeImage('./a.png?v=2', CTX), `${BASE}/a.png?ref=main`)
  assertEquals(resolveReadmeImage('./a.png#frag', CTX), `${BASE}/a.png?ref=main`)
})

Deno.test('a path with spaces or unicode is encoded per segment', () => {
  assertEquals(resolveReadmeImage('./my docs/a b.png', CTX), `${BASE}/my%20docs/a%20b.png?ref=main`)
  // The separators must survive the encoding.
  assertEquals(resolveReadmeImage('a/b/c.png', CTX)?.includes('/a/b/c.png'), true)
})

Deno.test('with no ref the default branch is left to Gitea', () => {
  assertEquals(resolveReadmeImage('./a.png', { owner: 'o', repo: 'r' }), '/api/svc/gitea/api/v1/repos/o/r/raw/a.png')
})

Deno.test('a README directory is derived from its path', () => {
  assertEquals(dirOf('README.md'), '')
  assertEquals(dirOf('docs/README.md'), 'docs')
  assertEquals(dirOf('docs/guide/README.md'), 'docs/guide')
  assertEquals(dirOf(undefined), '')
})
