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

/**
 * `x or <default>` is Nunjucks's default-value idiom and every shipped
 * template uses it for optional parameters. It used to fall through to a path
 * lookup of the whole expression and render EMPTY — which is how the Spring
 * Boot skeleton shipped `name:` with no topic and `app.kafka.topic=` with no
 * value, the Messaging XR tried to compose `topic-<no value>`, and the service
 * died at startup on "No resolvable bootstrap urls" with nothing pointing at
 * the template.
 */
Deno.test('or takes the default when the parameter is missing or empty', () => {
  const v = { parameters: {} }
  assertEquals(renderContent("${{ parameters.kafkaTopic or 'events' }}", v), 'events')
  assertEquals(renderContent("${{ parameters.kafkaPartitions or 3 }}", v), '3')
  assertEquals(renderContent("${{ parameters.cacheTtl or '10m' }}", { parameters: { cacheTtl: '' } }), '10m')
})

Deno.test('or keeps the parameter when it is set', () => {
  assertEquals(renderContent("${{ parameters.kafkaTopic or 'events' }}", { parameters: { kafkaTopic: 'orders' } }), 'orders')
  assertEquals(renderContent("${{ parameters.kafkaPartitions or 3 }}", { parameters: { kafkaPartitions: 12 } }), '12')
})

Deno.test('or falls back to a path on the right-hand side too', () => {
  assertEquals(renderContent('${{ values.alias or values.name }}', { values: { name: 'svc' } }), 'svc')
})

Deno.test('other unimplemented operators still fail loudly', () => {
  assertThrows(() => renderContent("${{ parameters.a and 'b' }}", { parameters: {} }), Error, 'does not implement')
})

Deno.test('escape HTML-escapes, so a description cannot break out of a meta attribute', () => {
  const out = renderContent('<meta content="${{ values.description | escape }}">', {
    description: `Tom's "fast" <app> & more`,
  })
  assertEquals(out, '<meta content="Tom&#39;s &quot;fast&quot; &lt;app&gt; &amp; more">')
  assert(!/[<>"]/.test(out.slice('<meta content="'.length, -2)))
})
