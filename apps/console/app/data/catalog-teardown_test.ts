import { assertEquals } from 'jsr:@std/assert'
import { entityRepoUrl, planTeardown } from './catalog-teardown.ts'
import type { Entity } from './catalog.ts'
import type { EntityDeployment } from './catalog-deployment.ts'

const entity = (over: Partial<Entity['metadata']> = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'cart', ...over },
  spec: { type: 'service' },
  origin: 'live',
} as Entity)

const app = (name: string, destination: string): EntityDeployment['apps'][number] => ({
  metadata: { name, namespace: 'argocd', labels: {} },
  spec: { project: 'default', source: { repoURL: '', path: '', targetRevision: '' }, sources: [], destination: { server: '', namespace: destination }, syncPolicy: { syncOptions: [] } },
  status: { sync: { status: 'Synced' }, health: { status: 'Healthy' }, conditions: [], images: [], history: 0, resources: { total: 0, healthy: 0, degraded: 0, progressing: 0, missing: 0, suspended: 0 } },
} as unknown as EntityDeployment['apps'][number])

const dep = (apps: EntityDeployment['apps']): EntityDeployment =>
  ({ apps, environments: [], primary: apps[0], isLoading: false, isError: false, unmatched: apps.length === 0 }) as EntityDeployment

Deno.test('planTeardown: apps, a dedicated namespace and a Gitea repository', () => {
  const plan = planTeardown(entity(), dep([app('cart', 'cart'), app('cart-staging', 'cart')]), 'https://gitea.example.com/acme/cart', 'gitea.example.com')
  assertEquals(plan.apps.map((a) => a.name), ['cart', 'cart-staging'])
  assertEquals(plan.namespace, 'cart')
  assertEquals(plan.namespaceDedicated, true)
  assertEquals(plan.repo, { url: 'https://gitea.example.com/acme/cart', onGitea: true, label: 'acme/cart' })
  assertEquals(plan.deployable, true)
})

Deno.test('planTeardown: apps in different namespaces leave the namespace unknown', () => {
  const plan = planTeardown(entity(), dep([app('cart', 'shop-prod'), app('cart-dev', 'shop-dev')]), undefined)
  assertEquals(plan.namespace, undefined)
  assertEquals(plan.namespaceDedicated, false)
  assertEquals(plan.repo, undefined)
})

Deno.test('planTeardown: annotation names the namespace when nothing is deployed', () => {
  const plan = planTeardown(entity({ annotations: { 'adhar.io/namespace': 'shop' } }), dep([]), 'https://github.com/acme/cart')
  assertEquals(plan.apps, [])
  assertEquals(plan.namespace, 'shop')
  assertEquals(plan.pipelinesNamespace, 'shop')
  assertEquals(plan.repo?.onGitea, false)
})

Deno.test('entityRepoUrl: repo link first, then annotations, never a non-http value', () => {
  assertEquals(entityRepoUrl(entity({ links: [{ url: 'https://gitea.example.com/acme/cart', title: 'Source', icon: 'repo' }] })), 'https://gitea.example.com/acme/cart')
  assertEquals(entityRepoUrl(entity({ annotations: { 'backstage.io/source-location': 'url:https://github.com/acme/cart' } })), 'https://github.com/acme/cart')
  assertEquals(entityRepoUrl(entity({ annotations: { 'adhar.io/source-repo': 'git@github.com:acme/cart.git' } })), undefined)
})
