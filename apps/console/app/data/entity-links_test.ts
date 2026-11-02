import { assertEquals, assertStrictEquals } from 'jsr:@std/assert@1'
import type { Link } from './catalog.ts'
import { canonicalLinkKey, hasTemplatePlaceholder, isBrowsableUrl, normalizeLinkIcon, repairLinkUrl, tidyLinks } from './entity-links.ts'

const TOOLS: Record<string, string> = { gitea: 'gitea', 'gitea-http': 'gitea', grafana: 'grafana', argocd: 'argocd' }
const toolFor = (host: string) => TOOLS[host.split(':')[0].split('.')[0].toLowerCase()]
// Stand-in for usePublicUrl: only in-cluster hosts move.
const pub = (url: string) => url.replace(/^https?:\/\/gitea-http\.adhar-system\.svc(\.cluster\.local)?(:\d+)?/, 'https://gitea.cloud.adhar.io')
const opts = { pub, baseDomain: 'cloud.adhar.io', toolFor }

Deno.test('canonicalLinkKey ignores scheme, case, www, default port, trailing slash and .git', () => {
  const k = canonicalLinkKey('https://gitea.cloud.adhar.io/Acme/shop')
  assertEquals(canonicalLinkKey('http://gitea.cloud.adhar.io/acme/shop/'), k)
  assertEquals(canonicalLinkKey('https://GITEA.cloud.adhar.io:443/acme/shop.git'), k)
  assertEquals(canonicalLinkKey('https://www.gitea.cloud.adhar.io/acme/shop.git/'), k)
  // A different port or query is a different link.
  assertEquals(canonicalLinkKey('https://gitea.cloud.adhar.io:8443/acme/shop') === k, false)
  assertEquals(canonicalLinkKey('https://gitea.cloud.adhar.io/acme/shop?tab=pr') === k, false)
})

Deno.test('template placeholders are recognised', () => {
  assertEquals(hasTemplatePlaceholder('https://x.io/${{ values.name }}'), true)
  assertEquals(hasTemplatePlaceholder('https://x.io/{{.Name}}'), true)
  assertEquals(hasTemplatePlaceholder('https://x.io/%7B%7Bname%7D%7D'), true)
  assertEquals(hasTemplatePlaceholder('https://x.io/a/b'), false)
})

Deno.test('icons from hand-written descriptors fold onto the drawn set', () => {
  assertEquals(normalizeLinkIcon('github'), 'repo')
  assertEquals(normalizeLinkIcon('Grafana'), 'dashboard')
  assertEquals(normalizeLinkIcon('book'), 'docs')
  assertEquals(normalizeLinkIcon('weird'), undefined)
  assertEquals(normalizeLinkIcon(undefined), undefined)
})

Deno.test('repairLinkUrl drops what cannot be opened', () => {
  assertEquals(repairLinkUrl('javascript:alert(1)', opts), null)
  assertEquals(repairLinkUrl('//evil.example', opts), null)
  assertEquals(repairLinkUrl('dir:.', opts), null)
  assertEquals(repairLinkUrl('docs/index.md', opts), null)
  assertEquals(repairLinkUrl('https://', opts), null)
  assertEquals(repairLinkUrl('http://foo bar', opts), null)
  assertEquals(repairLinkUrl('https://gitea.cloud.adhar.io/${{ values.owner }}/x', opts), null)
  assertEquals(repairLinkUrl('', opts), null)
})

Deno.test('repairLinkUrl keeps same-origin paths, mailto and ordinary public links', () => {
  assertEquals(repairLinkUrl('/catalog?entity=x', opts), '/catalog?entity=x')
  assertEquals(repairLinkUrl('mailto:team@acme.io', opts), 'mailto:team@acme.io')
  assertEquals(repairLinkUrl(' https://github.com/acme/shop ', opts), 'https://github.com/acme/shop')
  // gitea.com is somebody else's Gitea, not a stale platform host.
  assertEquals(repairLinkUrl('https://gitea.com/acme/shop', opts), 'https://gitea.com/acme/shop')
  assertEquals(repairLinkUrl('https://grafana.example.org/d/abc', opts), 'https://grafana.example.org/d/abc')
  // App routes live under the base; never rewritten.
  assertEquals(repairLinkUrl('https://grafana.dev.cloud.adhar.io/', opts), 'https://grafana.dev.cloud.adhar.io/')
})

Deno.test('repairLinkUrl rewrites in-cluster hosts through pub', () => {
  assertEquals(
    repairLinkUrl('http://gitea-http.adhar-system.svc.cluster.local:3000/acme/shop.git', opts),
    'https://gitea.cloud.adhar.io/acme/shop.git',
  )
})

Deno.test('repairLinkUrl moves a tool off a domain the platform used to live on', () => {
  assertEquals(repairLinkUrl('https://gitea.dev.adhar.io/acme/shop', opts), 'https://gitea.cloud.adhar.io/acme/shop')
  assertEquals(repairLinkUrl('https://grafana.platform.adhar.io/d/x?var=1', opts), 'https://grafana.cloud.adhar.io/d/x?var=1')
  // Unknown first label: left alone (a wrong rewrite looks right).
  assertEquals(repairLinkUrl('https://shop.dev.adhar.io/', opts), 'https://shop.dev.adhar.io/')
  // Without a known base nothing moves.
  assertEquals(repairLinkUrl('https://gitea.dev.adhar.io/acme/shop', { toolFor }), 'https://gitea.dev.adhar.io/acme/shop')
})

Deno.test('repairLinkUrl handles laptop defaults on a real install', () => {
  assertEquals(repairLinkUrl('https://adhar.localtest.me:8443/gitea', opts), null)
  assertEquals(
    repairLinkUrl('https://adhar.localtest.me:8443/gitea/acme/shop', opts),
    'https://gitea.cloud.adhar.io/acme/shop',
  )
  assertEquals(repairLinkUrl('https://shop.adhar.localtest.me/', opts), null)
  // On a laptop install the laptop host is the real one.
  assertEquals(
    repairLinkUrl('https://adhar.localtest.me:8443/gitea', { ...opts, baseDomain: 'adhar.localtest.me:8443' }),
    'https://adhar.localtest.me:8443/gitea',
  )
})

Deno.test('tidyLinks: live Source and descriptor Repo URL to the same repo become one button', () => {
  const links: Link[] = [
    { url: 'http://gitea-http.adhar-system.svc.cluster.local:3000/acme/shop.git', title: 'Source', icon: 'repo' },
    { url: 'https://gitea.cloud.adhar.io/Acme/shop/', title: 'Repo URL', icon: 'github' as Link['icon'] },
    { url: 'https://docs.acme.io/shop', title: 'Docs', icon: 'docs' },
  ]
  assertEquals(tidyLinks(links, opts), [
    { url: 'https://gitea.cloud.adhar.io/acme/shop', title: 'Source', icon: 'repo' },
    { url: 'https://docs.acme.io/shop', title: 'Docs', icon: 'docs' },
  ])
})

Deno.test('tidyLinks: the template skeleton repo link is dropped and a second generic repo link folds away', () => {
  const links: Link[] = [
    { url: 'https://gitea.cloud.adhar.io/acme/shop', title: 'Source', icon: 'repo' },
    { url: 'https://adhar.localtest.me:8443/gitea', title: 'Repo URL', icon: 'github' as Link['icon'] },
    { url: 'https://gitea.cloud.adhar.io/acme/shop-old', title: 'Repository', icon: 'repo' },
    { url: 'https://github.com/acme/shop', title: 'Upstream mirror', icon: 'github' as Link['icon'] },
  ]
  assertEquals(tidyLinks(links, opts), [
    { url: 'https://gitea.cloud.adhar.io/acme/shop', title: 'Source', icon: 'repo' },
    { url: 'https://github.com/acme/shop', title: 'Upstream mirror', icon: 'repo' },
  ])
})

Deno.test('tidyLinks: a person-written title replaces a console default on a duplicate', () => {
  const links: Link[] = [
    { url: 'https://grafana.cloud.adhar.io/d/abc', title: 'Dashboard', icon: 'dashboard' },
    { url: 'https://grafana.cloud.adhar.io/d/abc/', title: 'Shop SLOs', icon: 'dashboard' },
  ]
  assertEquals(tidyLinks(links, opts), [{ url: 'https://grafana.cloud.adhar.io/d/abc', title: 'Shop SLOs', icon: 'dashboard' }])
})

Deno.test('tidyLinks: untitled links get a readable title, unsafe ones go', () => {
  const links: Link[] = [
    { url: 'https://status.acme.io/shop/', title: 'https://status.acme.io/shop/' },
    { url: 'javascript:alert(1)', title: 'x' },
    { url: 'https://acme.io/${{ values.name }}', title: 'Templated' },
  ]
  assertEquals(tidyLinks(links, opts), [{ url: 'https://status.acme.io/shop/', title: 'status.acme.io/shop' }])
})

Deno.test('tidyLinks returns the same array when nothing changes, and every URL is unique', () => {
  const links: Link[] = [
    { url: 'https://gitea.cloud.adhar.io/acme/shop', title: 'Source', icon: 'repo' },
    { url: 'https://docs.acme.io', title: 'Docs', icon: 'docs' },
  ]
  assertStrictEquals(tidyLinks(links, opts), links)
  const dupes: Link[] = [...links, ...links, { ...links[0], url: links[0].url + '.git' }]
  const out = tidyLinks(dupes, opts)
  assertEquals(new Set(out.map((l) => l.url)).size, out.length)
  assertEquals(out.length, 2)
  assertEquals(tidyLinks(undefined, opts), [])
})

Deno.test('isBrowsableUrl refuses cluster-local and bare hosts', () => {
  assertEquals(isBrowsableUrl('https://shop.dev.cloud.adhar.io/'), true)
  assertEquals(isBrowsableUrl('http://shop.apps.svc:8080/'), false)
  assertEquals(isBrowsableUrl('http://shop.apps.svc.cluster.local/'), false)
  assertEquals(isBrowsableUrl('http://shop:8080/'), false)
  assertEquals(isBrowsableUrl('http://127.0.0.1:8080/'), false)
  assertEquals(isBrowsableUrl('not a url'), false)
})
