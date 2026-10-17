import { assertEquals } from 'jsr:@std/assert@1'
import { matchApps, repoFromUrl } from './designer-catalog.ts'

Deno.test('repo URLs in Application XRs', () => {
  assertEquals(repoFromUrl('https://gitea.example.com/acme/portal.git'), { owner: 'acme', name: 'portal' })
  assertEquals(repoFromUrl('git@gitea.example.com:acme/portal.git'), { owner: 'acme', name: 'portal' })
  assertEquals(repoFromUrl('http://gitea-http.gitea.svc:3000/adhar/shop/'), { owner: 'adhar', name: 'shop' })
})

Deno.test('apps match their repository by owner/name', () => {
  const apps = [
    { name: 'Portal', team: 'web', project: 'customer', repoUrl: 'https://g/acme/portal.git' },
    { name: 'Other', repoUrl: 'https://g/else/portal.git' },
    { name: 'Shop', repoUrl: 'https://g/acme/shop' },
  ]
  assertEquals(matchApps(apps, { name: 'portal', owner: 'acme' }).map((a) => a.name), ['Portal'])
  assertEquals(matchApps(apps, { name: 'portal' }).map((a) => a.name), ['Portal', 'Other'])
})
