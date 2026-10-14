import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { parseRepoUrl, renderContent } from './template-render.ts'

/**
 * `| dump` must JSON-encode, because skeletons rely on it for values dropped
 * straight into source code.
 *
 * The renderer supported only `lower`, `upper` and `parseRepoUrl`; anything
 * else fell through to a path lookup of the WHOLE expression
 * (`getByPath(ctx, "values.name | dump")`), which matches nothing, returns
 * undefined and stringifies to "". So the output was silently broken rather
 * than reported.
 *
 * Live on 2026-10-13 the react-spa-app skeleton produced:
 *
 *   const APP_NAME =
 *   const DESCRIPTION =
 *   const OWNER =
 *
 * and every scaffolded app failed its first build at `vite build` with
 * `Unexpected "const"` — which reads like a broken template or a bad
 * dependency, not a scaffolding fault.
 */
Deno.test('dump JSON-encodes, so a value dropped into source keeps its quotes', () => {
  const out = renderContent('const APP_NAME = ${{ values.name | dump }}', { name: 'reactapp' })
  assertEquals(out, 'const APP_NAME = "reactapp"')
})

Deno.test('dump survives quotes and newlines in a description', () => {
  const out = renderContent('const D = ${{ values.description | dump }}', {
    description: 'An app with "quotes" and\na newline',
  })
  assertEquals(out, 'const D = "An app with \\"quotes\\" and\\na newline"')
  // The result has to be parseable as the JS literal it claims to be.
  assertEquals(JSON.parse(out.slice('const D = '.length)), 'An app with "quotes" and\na newline')
})

Deno.test('a missing value still yields a syntactically valid literal', () => {
  // null, not "" — `const X = ` is a syntax error; `const X = null` is not.
  assertEquals(renderContent('const X = ${{ values.nope | dump }}', {}), 'const X = null')
})

Deno.test('an unimplemented filter fails loudly instead of rendering nothing', () => {
  assertThrows(
    () => renderContent('${{ values.name | titlecase }}', { name: 'x' }),
    Error,
    'does not implement',
  )
})

Deno.test('lower and upper still work', () => {
  assertEquals(renderContent('${{ values.n | lower }}-${{ values.n | upper }}', { n: 'Ab' }), 'ab-AB')
})

/**
 * A RepoUrlPicker `host` is a BARE host; skeletons add the scheme themselves
 * (`'https://${{ values.giteaHost }}/...'`). Returning it verbatim gave every
 * generated app a doubled scheme:
 *
 *   const REPO_URL = 'https://https://gitea.platform.adhar.io/adhar/reactapp'
 */
Deno.test('parseRepoUrl returns a bare host whatever form it is given', () => {
  for (const v of [
    'https://gitea.platform.adhar.io?owner=adhar&repo=reactapp',
    'http://gitea.platform.adhar.io/?owner=adhar&repo=reactapp',
    'gitea.platform.adhar.io?owner=adhar&repo=reactapp',
  ]) {
    const r = parseRepoUrl(v)
    assertEquals(r.host, 'gitea.platform.adhar.io', `host not bare for ${v}`)
    assert(!r.host.includes('://'), `scheme leaked into host for ${v}`)
    assertEquals(`https://${r.host}/${r.owner}/${r.repo}`, 'https://gitea.platform.adhar.io/adhar/reactapp')
  }
})

Deno.test('parseRepoUrl still strips a .git suffix from the repo', () => {
  assertEquals(parseRepoUrl('gitea.x?owner=o&repo=r.git').repo, 'r')
})
