import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { catalogSpecDoc, catalogSpecId, catalogSpecsToRegister } from './api-catalog.ts'
import type { PEntity } from './platform-model.ts'

/**
 * The library registers the catalog's APIs by itself: a `kind: API` with a
 * readable definition and no spec linked to it becomes a spec at a fixed id,
 * so a function or service created from the CLI, or before this existed,
 * shows up under Design → API & Schemas without anyone pressing Import.
 */

const api = (name: string, extra: Partial<PEntity> = {}): PEntity => ({
  kind: 'API',
  name,
  namespace: 'default',
  origin: 'catalog-info',
  repo: name.replace(/-api$/, ''),
  definitionPath: 'api/openapi.yaml',
  ...extra,
} as PEntity)

Deno.test('the spec id is derived from the catalog ref exactly as the server derives it', () => {
  // Pinned on both sides (server design-api-specs_test.ts `specIdFor`): a different id
  // would give one API two documents — the scaffold's and the back-fill's.
  assertEquals(catalogSpecId('api:default/orders-api'), 'catalog-api-default-orders-api')
  assertEquals(catalogSpecId('API:Team-A/Orders_API'), 'catalog-api-team-a-orders-api')
})

Deno.test('only catalog APIs with a readable definition and no linked spec are registered', () => {
  const entities: PEntity[] = [
    api('orders-api'),
    api('linked-api'),
    api('remote-api', {
      definitionPath: undefined,
      definitionUrl: 'https://example.com/openapi.yaml',
    }),
    api('bare-api', { definitionPath: undefined }),
    api('inline-api', {
      definitionPath: undefined,
      definition: 'openapi: 3.1.0\ninfo: {title: inline, version: 1.0.0}',
    }),
    { kind: 'Component', name: 'orders', namespace: 'default', origin: 'catalog-info' } as PEntity,
  ]
  const specs = [{ entity: 'api:default/linked-api' }, { entity: undefined }]
  assertEquals(catalogSpecsToRegister(entities, specs).map((e) => e.name), [
    'orders-api',
    'inline-api',
  ])
})

Deno.test('the registered document carries what the editor and the Catalog tab read back', () => {
  const doc = catalogSpecDoc(
    api('orders-api', { title: 'Orders', description: 'Order lifecycle.' }),
    'openapi: 3.1.0\ninfo:\n  title: orders\n  version: 2.1.0\npaths: {}\n',
    {
      source: 'orders/api/openapi.yaml',
      git: { repo: 'orders', branch: 'main', path: 'api/openapi.yaml', at: 't' },
      by: 'Dana',
      project: 'payments',
      now: 't',
    },
  )
  assertEquals(doc.id, 'catalog-api-default-orders-api')
  assertEquals(doc.entity, 'api:default/orders-api')
  assertEquals(doc.name, 'Orders')
  assertEquals(doc.version, '2.1.0')
  assertEquals(doc.description, 'Order lifecycle.')
  assertEquals(doc.kind, 'openapi')
  assertEquals(doc.git?.path, 'api/openapi.yaml')
  assertEquals(doc.project, 'payments')
  assertEquals(doc.team, undefined)
  assertEquals(doc.updated_by, 'Dana')
  assertEquals(doc.created_at, 't')
})
