import { assertEquals } from 'jsr:@std/assert'
import { giteaRepoOf } from './teardown.ts'

const HOSTS = ['gitea.platform.example.com']

Deno.test('giteaRepoOf: repository on the platform Gitea by public host', () => {
  assertEquals(giteaRepoOf('https://gitea.platform.example.com/acme/cart', HOSTS), { owner: 'acme', repo: 'cart' })
  assertEquals(giteaRepoOf('https://gitea.platform.example.com/acme/cart.git', HOSTS), { owner: 'acme', repo: 'cart' })
  assertEquals(giteaRepoOf('https://gitea.platform.example.com/acme/cart/src/branch/main/docs', HOSTS), { owner: 'acme', repo: 'cart' })
})

Deno.test('giteaRepoOf: in-cluster service hosts count as Gitea', () => {
  assertEquals(giteaRepoOf('http://gitea-http.gitea.svc.cluster.local:3000/acme/cart.git', []), { owner: 'acme', repo: 'cart' })
  assertEquals(giteaRepoOf('http://gitea.adhar-system.svc/acme/cart', []), { owner: 'acme', repo: 'cart' })
})

Deno.test('giteaRepoOf: never a repository hosted elsewhere', () => {
  assertEquals(giteaRepoOf('https://github.com/acme/cart', HOSTS), null)
  assertEquals(giteaRepoOf('https://gitlab.com/acme/cart', HOSTS), null)
  assertEquals(giteaRepoOf('not a url', HOSTS), null)
  assertEquals(giteaRepoOf('https://gitea.platform.example.com/acme', HOSTS), null)
})
