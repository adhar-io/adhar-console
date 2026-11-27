import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { isProduction, pageNamespace, scopeNamespaces } from './scope.ts'

/** Where a person's workflows live (design 0026 §4.3): project homes and environments, narrowed by the top bar and the team lens. */

const PROJECTS = [
  { metadata: { name: 'shop' }, status: { namespace: 'shop', environments: [{ name: 'dev', namespace: 'shop-dev', tier: 'dev' }, { name: 'prod', namespace: 'shop-prod', tier: 'prod' }] } },
  { metadata: { name: 'billing' }, status: { namespace: 'billing', environments: [{ name: 'dev', namespace: 'billing-dev' }, { name: 'bad', namespace: 'Not_A_Namespace' }] } },
  { metadata: { name: 'new' }, status: {} },
]

Deno.test('every project contributes its home then its environments, in a stable order', () => {
  assertEquals(scopeNamespaces(PROJECTS).map((n) => `${n.namespace}:${n.role}`), [
    'billing:home', 'billing-dev:environment', 'shop:home', 'shop-dev:environment', 'shop-prod:environment',
  ])
})

Deno.test('the top-bar namespace narrows to it alone; platform staff also see adhar-system', () => {
  assertEquals(scopeNamespaces(PROJECTS, { selected: 'shop-dev' }), [{ namespace: 'shop-dev', role: 'selected' }])
  assertEquals(scopeNamespaces(PROJECTS, { platform: true }).at(-1), { namespace: 'adhar-system', role: 'platform' })
})

Deno.test('the team lens narrows to its projects, and never to nothing', () => {
  assertEquals(scopeNamespaces(PROJECTS, { projectFilter: new Set(['shop']) }).map((n) => n.namespace), ['shop', 'shop-dev', 'shop-prod'])
  assertEquals(scopeNamespaces(PROJECTS, { projectFilter: new Set(['ghost']) }).length, 5)
})

Deno.test('production is recognised by tier or environment name', () => {
  const ns = scopeNamespaces(PROJECTS)
  assertEquals(ns.filter(isProduction).map((n) => n.namespace), ['shop-prod'])
})

Deno.test('History reads the namespace its picker shows — a URL namespace is offered, a stale one after a top-bar switch is dropped', () => {
  const all = { namespaces: scopeNamespaces(PROJECTS) }
  assertEquals(pageNamespace(all, undefined).namespace, 'billing')
  // Another team's namespace by deep link (acceptance 2): read, and offered, so the picker agrees.
  const other = pageNamespace(all, 'payments-dev')
  assertEquals(other.namespace, 'payments-dev')
  assertEquals(other.options[0], 'payments-dev')
  // The top bar switched to shop-dev while ?ns=payments-dev was in the URL: the top bar wins.
  const switched = { namespaces: scopeNamespaces(PROJECTS, { selected: 'shop-dev' }), only: 'shop-dev' }
  assertEquals(pageNamespace(switched, 'payments-dev'), { namespace: 'shop-dev', options: ['shop-dev'] })
  // Garbage in the URL is not a namespace.
  assertEquals(pageNamespace(all, 'Not_A/ns').namespace, 'billing')
})
