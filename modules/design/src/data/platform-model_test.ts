import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  apiUsage,
  c4ContainerDiagram,
  c4ContextDiagram,
  classifyArgoApp,
  deploymentDiagram,
  diffStats,
  entitiesFromApplications,
  entityFromRepo,
  lineDiff,
  mergeEntities,
  neighbours,
  normalizeRef,
  parseCatalogInfo,
  resolveRepoPath,
  shortRef,
  tenancyDiagram,
} from './platform-model.ts'

const CATALOG = `apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: orders
  title: Orders
  description: Order capture and fulfilment
spec:
  owner: team-orders
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: orders-api
  description: REST front door
spec:
  type: service
  lifecycle: production
  owner: group:team-orders
  system: orders
  providesApis: [orders-rest]
  consumesApis:
    - api:payments-rest
  dependsOn:
    - resource:orders-db
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: orders-rest
spec:
  type: openapi
  system: orders
  definition:
    $text: ./api/openapi.yaml
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: orders-db
spec:
  type: database
  system: orders
---
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: ignored
`

const PAYMENTS = `kind: System
metadata:
  name: payments
spec: {}
---
kind: Component
metadata:
  name: payments-svc
spec:
  type: service
  system: payments
  providesApis: [payments-rest]
---
kind: API
metadata:
  name: payments-rest
spec:
  type: openapi
  definition: |
    openapi: 3.0.0
    info:
      title: Payments
`

const loc = { repo: 'orders', branch: 'main', path: 'catalog-info.yaml' }

function catalog() {
  return mergeEntities(
    parseCatalogInfo(CATALOG, loc),
    parseCatalogInfo(PAYMENTS, { repo: 'payments', branch: 'main', path: 'deploy/catalog-info.yaml' }),
    entitiesFromApplications([
      { metadata: { name: 'orders-api' }, spec: { parameters: { project: 'shop', source: { repoURL: 'https://git.example/acme/orders.git' } } } },
      { metadata: { name: 'cart' }, spec: { parameters: { project: 'shop', displayName: 'Cart' } } },
      { metadata: { name: 'gone', deletionTimestamp: '2026-10-01T00:00:00Z' }, spec: { parameters: {} } },
    ]),
    [entityFromRepo({ name: 'orders' }), entityFromRepo({ name: 'Cart', language: 'Go' })],
  )
}

Deno.test('refs normalise every console spelling', () => {
  assertEquals(normalizeRef('component:cart'), 'component:default/cart')
  assertEquals(normalizeRef('API:Default/Orders'), 'api:default/orders')
  assertEquals(normalizeRef('team-x', 'group'), 'group:default/team-x')
  assertEquals(shortRef('component:default/cart'), 'component:cart')
  assertEquals(resolveRepoPath('deploy/catalog-info.yaml', './api/openapi.yaml'), 'deploy/api/openapi.yaml')
  assertEquals(resolveRepoPath('deploy/catalog-info.yaml', '../openapi.yaml'), 'openapi.yaml')
})

Deno.test('parses multi-document catalog-info with relations and API sources', () => {
  const list = parseCatalogInfo(CATALOG, loc)
  assertEquals(list.map((e) => e.kind), ['System', 'Component', 'API', 'Resource'])
  const cmp = list[1]
  assertEquals(cmp.owner, 'group:default/team-orders')
  assertEquals(cmp.system, 'system:default/orders')
  assertEquals(cmp.providesApis, ['api:default/orders-rest'])
  assertEquals(cmp.consumesApis, ['api:default/payments-rest'])
  assertEquals(cmp.dependsOn, ['resource:default/orders-db'])
  assertEquals(list[2].definitionPath, 'api/openapi.yaml')
  const inline = parseCatalogInfo(PAYMENTS).find((e) => e.kind === 'API')!
  assertStringIncludes(inline.definition ?? '', 'openapi: 3.0.0')
})

Deno.test('merges descriptor, application and repo into one entity', () => {
  const list = catalog()
  const api = list.find((e) => e.name === 'orders-api')!
  assertEquals(api.origin, 'catalog-info')
  assertEquals(api.project, 'shop')
  assertEquals(api.repo, 'orders')
  const cart = list.filter((e) => e.name === 'cart')
  assertEquals(cart.length, 1)
  assertEquals(cart[0].project, 'shop')
  assertEquals(cart[0].title, 'Cart')
  assert(!list.some((e) => e.name === 'gone'), 'deleting applications are not listed')
  assert(!list.some((e) => e.kind === 'Component' && e.name === 'orders'), 'a described repo is not also a bare component')
})

Deno.test('API usage and neighbours follow catalog relations', () => {
  const list = catalog()
  const u = apiUsage(list, 'api:payments-rest')
  assertEquals(u.providers.map((e) => e.name), ['payments-svc'])
  assertEquals(u.consumers.map((e) => e.name), ['orders-api'])
  const n = neighbours(list, 'component:orders-api')
  assert(n.some((x) => x.type === 'partOf' && x.entity.name === 'orders'))
  assert(n.some((x) => x.type === 'dependsOn' && x.entity.name === 'orders-db'))
})

Deno.test('C4 context draws systems and cross-system API use', () => {
  const src = c4ContextDiagram(catalog())
  assert(src.startsWith('C4Context\n'))
  assertStringIncludes(src, 'System(sys_orders, "Orders", "Order capture and fulfilment")')
  assertStringIncludes(src, 'System(sys_payments, "payments", "")')
  // cart has no system → drawn as its own box
  assertStringIncludes(src, 'System(cmp_cart, "Cart", "Project shop")')
  assertStringIncludes(src, 'Rel(sys_orders, sys_payments, "uses payments-rest")')
  // deterministic
  assertEquals(src, c4ContextDiagram(catalog()))
})

Deno.test('C4 container groups by system with db and external providers', () => {
  const src = c4ContainerDiagram(catalog(), { system: 'system:orders' })
  assertStringIncludes(src, 'System_Boundary(b_orders, "Orders") {')
  assertStringIncludes(src, 'Container(cnt_orders_api, "orders-api", "service", "REST front door")')
  assertStringIncludes(src, 'ContainerDb(res_orders_db, "orders-db", "database", "")')
  assertStringIncludes(src, 'Container_Ext(cnt_payments_svc, "payments-svc", "service", "")')
  assertStringIncludes(src, 'Rel(cnt_orders_api, cnt_payments_svc, "calls payments-rest", "openapi")')
  assertStringIncludes(src, 'Rel(cnt_orders_api, res_orders_db, "reads / writes")')
})

Deno.test('Argo apps classify by labels, then <project>-<app>-<env>', () => {
  assertEquals(classifyArgoApp({ name: 'shop-cart-dev', project: 'shop' }), { argo: 'shop-cart-dev', project: 'shop', app: 'cart', env: 'dev', sync: undefined, health: undefined })
  assertEquals(
    classifyArgoApp({ name: 'x', labels: { 'adhar.io/environment': 'prod', 'adhar.io/application': 'cart', 'adhar.io/project': 'shop' } })?.app,
    'cart',
  )
  assertEquals(classifyArgoApp({ name: 'argocd-bootstrap' }), undefined)
})

Deno.test('deployment diagram orders environments dev → test → prod and chains promotion', () => {
  const src = deploymentDiagram([
    { name: 'shop-cart-prod', project: 'shop', sync: 'Synced', health: 'Healthy' },
    { name: 'shop-cart-dev', project: 'shop', sync: 'OutOfSync', health: 'Degraded' },
    { name: 'shop-cart-test', project: 'shop', sync: 'Synced', health: 'Healthy' },
    { name: 'billing-ledger-dev', project: 'billing', sync: 'Synced', health: 'Progressing' },
  ])
  const dev = src.indexOf('Development')
  const test = src.indexOf('"Test"')
  const prod = src.indexOf('Production')
  assert(dev > 0 && dev < test && test < prod)
  assertStringIncludes(src, 'a_shop_cart_dev -.-> a_shop_cart_test')
  assertStringIncludes(src, 'a_shop_cart_test -.-> a_shop_cart_prod')
  assertStringIncludes(src, 'a_shop_cart_dev["cart<br/><small>OutOfSync · Degraded</small>"]:::degraded')
  assertStringIncludes(src, 'subgraph p_billing["Project · billing"]')
  assertStringIncludes(deploymentDiagram([], {}), 'No Argo CD applications')
  assert(!deploymentDiagram([{ name: 'billing-ledger-dev' }], { project: 'shop' }).includes('ledger'))
})

Deno.test('tenancy diagram links org → team → project → app', () => {
  const src = tenancyDiagram({
    org: { slug: 'acme', name: 'Acme' },
    teams: [{ slug: 'payments', name: 'Payments' }],
    projects: [{ slug: 'shop', teams: ['payments'] }, { slug: 'lab' }],
    apps: [{ name: 'cart', project: 'shop' }, { name: 'cart', project: 'shop' }, { name: 'stray' }],
  })
  assertStringIncludes(src, 'org_acme --> t_payments')
  assertStringIncludes(src, 't_payments --> p_shop')
  assertStringIncludes(src, 'org_acme --> p_lab')
  assertStringIncludes(src, 'p_shop --> a_shop_cart')
  assertStringIncludes(src, 'org_acme -.-> a_none_stray')
  assertEquals(src.split('a_shop_cart["').length, 2, 'apps are de-duplicated')
})

Deno.test('line diff reports additions and removals', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nc\nd\n')
  assertEquals(d, [{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' }])
  assertEquals(diffStats(d), { added: 1, removed: 1 })
  assertEquals(diffStats(lineDiff('x', 'x')), { added: 0, removed: 0 })
})

Deno.test('generators are deterministic and scoped', async () => {
  const { generateDiagram, generatorTitle, tenancyApps } = await import('./platform-model.ts')
  const data = {
    entities: catalog(),
    argoApps: [{ name: 'shop-cart-dev', project: 'shop' }, { name: 'lab-x-dev', project: 'lab' }],
    tenancy: { org: { slug: 'acme' }, teams: [{ slug: 'payments' }, { slug: 'r' }], projects: [{ slug: 'shop', teams: ['payments'] }, { slug: 'lab', teams: ['r'] }], apps: [] as { name: string; project?: string }[] },
  }
  data.tenancy.apps = tenancyApps(data.entities, data.argoApps)
  assertEquals(data.tenancy.apps.map((a) => `${a.project}/${a.name}`).sort(), ['lab/x', 'shop/cart', 'shop/orders-api'])
  const t = generateDiagram('tenancy', { project: 'shop' }, data)
  assert(t.includes('p_shop') && !t.includes('p_lab') && !t.includes('t_r'))
  assertEquals(generateDiagram('deployment', {}, data), generateDiagram('deployment', {}, data))
  assertEquals(generatorTitle('c4-container', { system: 'system:orders', project: 'shop' }, data.entities), 'C4 containers — Orders · shop')
})
