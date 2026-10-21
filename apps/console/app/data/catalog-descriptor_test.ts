import { assertEquals, assertStrictEquals } from 'jsr:@std/assert@1'
import type { Entity } from './catalog.ts'
import { catalogInfoPath, createLimiter, descriptorDoc, overlayDescriptor, withDescriptor } from './catalog-descriptor.ts'

function entity(over: Partial<Entity> & { metadata?: Partial<Entity['metadata']> } = {}): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    ...over,
    metadata: { name: 'cart', ...(over.metadata ?? {}) },
    spec: { type: 'service', ...(over.spec ?? {}) },
  } as Entity
}

const LIVE = entity({
  metadata: {
    name: 'cart',
    description: 'Repository acme/cart.',
    tags: ['go'],
    links: [{ url: 'https://gitea.example.io/acme/cart', title: 'Repository', icon: 'repo' }],
    annotations: {
      'argocd/app-name': 'cart',
      'adhar.io/team': 'live-team',
      'backstage.io/source-location': 'url:https://gitea.example.io/acme/cart/src/branch/main/',
      'backstage.io/managed-by-location': 'url:https://gitea.example.io/acme/cart/src/branch/main/catalog-info.yaml',
    },
  },
  spec: { type: 'service', lifecycle: 'staging', owner: 'group:platform' },
})

const DESCRIPTOR = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: cart
  title: Cart
  description: Shopping cart
  tags: [Payments]
  links:
    - url: https://grafana.example.io/d/cart
      title: Dashboard
      icon: dashboard
    - url: https://elsewhere.example.io/other/repo
      title: Not the source
      icon: repo
  annotations:
    adhar.io/team: payments
    adhar.io/hpa: cart
    backstage.io/managed-by-location: url:https://gitea.example.io/acme/other/src/branch/main/x.yaml
    adhar.io/branch: release
spec:
  type: service
  owner: payments
  lifecycle: experimental
`

Deno.test('descriptor wins for owner, title, description, links, tags and annotations', () => {
  const e = withDescriptor(LIVE, { exists: true, text: DESCRIPTOR })
  assertEquals(e.spec.owner, 'group:payments')
  assertEquals(e.metadata.title, 'Cart')
  assertEquals(e.metadata.description, 'Shopping cart')
  assertEquals(e.metadata.tags, ['go', 'payments'])
  assertEquals(e.metadata.links?.map((l) => l.url), ['https://gitea.example.io/acme/cart', 'https://grafana.example.io/d/cart'])
  assertEquals(e.metadata.annotations?.['adhar.io/team'], 'payments')
  assertEquals(e.metadata.annotations?.['adhar.io/hpa'], 'cart')
  assertEquals(e.metadata.annotations?.['argocd/app-name'], 'cart')
})

Deno.test('the descriptor cannot relocate itself (location annotations and repo links stay live)', () => {
  const e = withDescriptor(LIVE, { exists: true, text: DESCRIPTOR })
  assertEquals(e.metadata.annotations?.['backstage.io/managed-by-location'], LIVE.metadata.annotations?.['backstage.io/managed-by-location'])
  assertEquals(e.metadata.annotations?.['adhar.io/branch'], undefined)
  assertEquals(catalogInfoPath(e), catalogInfoPath(LIVE))
  assertEquals(e.metadata.links?.filter((l) => l.icon === 'repo').length, 1)
})

Deno.test('lifecycle: deployed lifecycle stands; declared production/deprecated wins; declared fills a gap', () => {
  assertEquals(withDescriptor(LIVE, { exists: true, text: DESCRIPTOR }).spec.lifecycle, 'staging')
  assertEquals(withDescriptor(LIVE, { exists: true, text: DESCRIPTOR.replace('experimental', 'production') }).spec.lifecycle, 'production')
  assertEquals(withDescriptor(LIVE, { exists: true, text: DESCRIPTOR.replace('experimental', 'deprecated') }).spec.lifecycle, 'deprecated')
  const noLc = entity({ metadata: { name: 'cart' }, spec: { type: 'service' } })
  assertEquals(withDescriptor(noLc, { exists: true, text: DESCRIPTOR }).spec.lifecycle, 'experimental')
  assertEquals(withDescriptor(noLc, { exists: true, text: DESCRIPTOR.replace('experimental', 'nonsense') }).spec.lifecycle, undefined)
})

Deno.test('missing, unread or unparseable descriptors leave the entity untouched', () => {
  assertStrictEquals(withDescriptor(LIVE, undefined), LIVE)
  assertStrictEquals(withDescriptor(LIVE, { exists: false, text: null }), LIVE)
  assertStrictEquals(withDescriptor(LIVE, { exists: true, text: '' }), LIVE)
  const garbage = withDescriptor(LIVE, { exists: true, text: '::: not: [yaml' })
  assertEquals(garbage.spec.owner, 'group:platform')
  assertEquals(garbage.metadata.description, LIVE.metadata.description)
})

Deno.test('multi-document descriptors: the document for this entity is used', () => {
  const multi = `apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: shop
  description: The shop
spec:
  owner: sales
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: cart
  description: Cart API
spec:
  owner: api-team
---
${DESCRIPTOR}`
  const e = withDescriptor(LIVE, { exists: true, text: multi })
  assertEquals(e.metadata.description, 'Shopping cart')
  assertEquals(e.spec.owner, 'group:payments')
  // Same name, other kind → its own document.
  const api = withDescriptor(entity({ kind: 'API', metadata: { name: 'cart' } }), { exists: true, text: multi })
  assertEquals(api.spec.owner, 'group:api-team')
  // No exact match → the first document of the same kind.
  const other = withDescriptor(entity({ metadata: { name: 'basket' } }), { exists: true, text: multi })
  assertEquals(other.metadata.description, 'Shopping cart')
})

Deno.test('the overlay is idempotent', () => {
  const doc = descriptorDoc(DESCRIPTOR, LIVE)
  const once = overlayDescriptor(LIVE, doc)
  assertEquals(overlayDescriptor(once, doc), once)
})

Deno.test('owner keeps an explicit kind prefix', () => {
  const e = withDescriptor(LIVE, { exists: true, text: DESCRIPTOR.replace('owner: payments', 'owner: user:jane') })
  assertEquals(e.spec.owner, 'user:jane')
})

Deno.test('limiter: never more than max in flight; urgent work jumps the queue', async () => {
  const lim = createLimiter(2)
  let inFlight = 0
  let peak = 0
  const order: string[] = []
  const gates: Array<() => void> = []
  const task = (name: string) => () =>
    new Promise<string>((resolve) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      order.push(name)
      gates.push(() => {
        inFlight--
        resolve(name)
      })
    })
  const all = [lim.run(task('a')), lim.run(task('b')), lim.run(task('c')), lim.run(task('d')), lim.run(task('urgent'), true)]
  await Promise.resolve()
  assertEquals(order, ['a', 'b'])
  assertEquals(lim.pending, 3)
  while (gates.length) {
    gates.shift()!()
    await new Promise((r) => setTimeout(r, 0))
  }
  assertEquals(await Promise.all(all), ['a', 'b', 'c', 'd', 'urgent'])
  assertEquals(order, ['a', 'b', 'urgent', 'c', 'd'])
  assertEquals(peak, 2)
})
