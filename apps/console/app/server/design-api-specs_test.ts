import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { API_SPEC_KIND, apiSpecRegistrations, catalogApis, decodeScaffoldedFile, registerApiSpecs, specIdFor, splitYamlDocuments } from './design-api-specs.ts'

/* ───────────── what a function template renders ───────────── */

const CATALOG_INFO = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: demo-fn
  description: "A function on the Adhar platform."
spec:
  type: function
  lifecycle: experimental
  owner: group:platform-engineers
  providesApis:
    - demo-fn-api
---
# The function's HTTP interface, for the catalog's APIs.
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: demo-fn-api
  description: HTTP interface of the demo-fn function.
  tags:
    - function
spec:
  type: openapi
  lifecycle: experimental
  owner: group:platform-engineers
  definition:
    $text: ./api/openapi.yaml
`

const OPENAPI = `openapi: 3.1.0
info:
  title: demo-fn
  version: 0.2.0
  description: "A function on the Adhar platform."
servers:
  - url: https://demo-fn.dev.example.com
paths:
  /healthz:
    get:
      operationId: healthz
      responses:
        "200":
          description: The function is up.
`

const ctx = {
  catalogInfoPath: 'catalog-info.yaml',
  repo: 'demo-fn',
  branch: 'main',
  source: 'scaffold:templates/function-deno-service',
  project: 'payments',
  by: 'Dana',
  now: '2026-11-12T01:00:00.000Z',
}

Deno.test('a YAML stream splits on document markers, not on dashes inside a document', () => {
  assertEquals(splitYamlDocuments('a: 1\n---\nb: 2\n---\n...\n'), ['a: 1', 'b: 2'])
  assertEquals(splitYamlDocuments('---\nlist:\n  - x\n  --- not a marker\n'), [
    'list:\n  - x\n  --- not a marker',
  ])
})

Deno.test('the API documents of a catalog-info are found with their definition path resolved', () => {
  const apis = catalogApis(CATALOG_INFO)
  assertEquals(apis.length, 1)
  assertEquals(apis[0].name, 'demo-fn-api')
  assertEquals(apis[0].namespace, 'default')
  assertEquals(apis[0].definitionPath, 'api/openapi.yaml')
  // Relative to where catalog-info lives, like the Design module resolves it.
  assertEquals(
    catalogApis(CATALOG_INFO, 'svc/catalog-info.yaml')[0].definitionPath,
    'svc/api/openapi.yaml',
  )
  // A URL definition is not a file to register; an inline one is carried as is.
  assertEquals(
    catalogApis(CATALOG_INFO.replace('./api/openapi.yaml', 'https://example.com/openapi.yaml'))[0]
      .definitionPath,
    undefined,
  )
  const inline = catalogApis(
    CATALOG_INFO.replace(
      'definition:\n    $text: ./api/openapi.yaml',
      'definition: |\n    openapi: 3.1.0\n    info: {title: inline, version: 1.0.0}',
    ),
  )
  assert(inline[0].definition?.includes('openapi: 3.1.0'))
})

Deno.test('a scaffold registers one spec per API whose definition it committed, shaped like the Design module writes it', () => {
  const regs = apiSpecRegistrations([
    { path: 'catalog-info.yaml', text: CATALOG_INFO },
    { path: 'api/openapi.yaml', text: OPENAPI },
    { path: 'deploy/kustomization.yaml', text: 'resources: []\n' },
  ], ctx)
  assertEquals(regs.length, 1)
  const [r] = regs
  assertEquals(r.entity, 'api:default/demo-fn-api')
  assertEquals(r.id, 'catalog-api-default-demo-fn-api')
  assertEquals(r.data.name, 'demo-fn-api')
  assertEquals(r.data.version, '0.2.0')
  assertEquals(r.data.document, OPENAPI)
  assertEquals(r.data.description, 'HTTP interface of the demo-fn function.')
  assertEquals(r.data.git, {
    repo: 'demo-fn',
    branch: 'main',
    path: 'api/openapi.yaml',
    at: ctx.now,
  })
  assertEquals(r.data.project, 'payments')
  assertEquals(r.data.team, undefined)
  assertEquals(r.data.source, ctx.source)
  assertEquals(r.data.updated_by, 'Dana')
})

Deno.test('nothing is registered when the skeleton ships no API entity, or names a definition it did not commit', () => {
  const component = CATALOG_INFO.split('\n---\n')[0]
  assertEquals(apiSpecRegistrations([{ path: 'catalog-info.yaml', text: component }], ctx), [])
  assertEquals(apiSpecRegistrations([{ path: 'catalog-info.yaml', text: CATALOG_INFO }], ctx), [])
  assertEquals(apiSpecRegistrations([{ path: 'api/openapi.yaml', text: OPENAPI }], ctx), [])
})

Deno.test('the spec id is derived from the catalog ref the same way the Design module derives it', () => {
  // Pinned on both sides (modules/design data/api-catalog.ts `catalogSpecId`), because the
  // two cannot import each other and a different id means two documents for one API.
  assertEquals(specIdFor('api:default/orders-api'), 'catalog-api-default-orders-api')
  assertEquals(specIdFor('API:Team-A/Orders_API'), 'catalog-api-team-a-orders-api')
})

Deno.test('registration creates what is missing and never overwrites a spec someone may be editing', async () => {
  const docs = new Map<string, Record<string, unknown>>([['catalog-api-default-demo-fn-api', {
    name: 'edited by hand',
    document: 'openapi: 3.0.0',
  }]])
  const puts: string[] = []
  const store = {
    get: (kind: string, id: string) =>
      Promise.resolve(
        kind === API_SPEC_KIND && docs.has(id)
          ? {
            id,
            data: docs.get(id)!,
            createdBy: null,
            updatedBy: null,
            createdAt: '',
            updatedAt: '',
          }
          : null,
      ),
    put: (_kind: string, id: string, data: Record<string, unknown>) => {
      puts.push(id)
      docs.set(id, data)
      return Promise.resolve({
        id,
        data,
        createdBy: null,
        updatedBy: null,
        createdAt: '',
        updatedAt: '',
      })
    },
  }
  const regs = apiSpecRegistrations([
    {
      path: 'catalog-info.yaml',
      text: CATALOG_INFO +
        '---\nkind: API\nmetadata:\n  name: other\nspec:\n  definition:\n    $text: ./api/other.yaml\n',
    },
    { path: 'api/openapi.yaml', text: OPENAPI },
    { path: 'api/other.yaml', text: 'openapi: 3.1.0\ninfo:\n  title: other\n  version: 1.0.0\n' },
  ], ctx)
  assertEquals(regs.map((r) => r.id), [
    'catalog-api-default-demo-fn-api',
    'catalog-api-default-other',
  ])
  const result = await registerApiSpecs(store, regs, 'user-1')
  assertEquals(result.created.map((r) => r.id), ['catalog-api-default-other'])
  assertEquals(result.existing.map((r) => r.id), ['catalog-api-default-demo-fn-api'])
  assertEquals(puts, ['catalog-api-default-other'])
  assertEquals(docs.get('catalog-api-default-demo-fn-api')?.name, 'edited by hand')
})

Deno.test('a rendered file round-trips through the scaffolder base64 encoding, non-ASCII included', () => {
  const text = 'info:\n  title: Zahlungen — Café API\n'
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  assertEquals(decodeScaffoldedFile('api/openapi.yaml', base64), {
    path: 'api/openapi.yaml',
    text,
  })
})
