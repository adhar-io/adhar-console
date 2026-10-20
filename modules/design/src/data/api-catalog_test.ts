import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { bumpFor, bumpVersion, describeSource, operationName, specSource, tsClientFor } from './api-catalog.ts'
import { diffSpecs, parseSpec } from './openapi.ts'

const V1 = `openapi: 3.0.3
info:
  title: Orders
  version: 1.2.0
servers:
  - url: https://orders.example/api
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      summary: Read one order
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
  /orders:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Order'
      responses:
        '201':
          description: created
components:
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id:
          type: string
        total:
          type: number
        status:
          type: string
          enum: [open, paid]
`

Deno.test('spec source follows the catalog descriptor', () => {
  assertEquals(
    specSource({ definitionPath: 'api/openapi.yaml', location: { repo: 'orders', branch: 'main', path: 'catalog-info.yaml' } }),
    { type: 'repo', repo: 'orders', path: 'api/openapi.yaml', branch: 'main' },
  )
  assertEquals(specSource({ definitionUrl: 'https://x/spec.json' }), { type: 'url', url: 'https://x/spec.json' })
  assertEquals(specSource({ definition: 'openapi: 3.0.0' })?.type, 'inline')
  assertEquals(specSource({}), null)
  assertEquals(describeSource(null), 'No definition in catalog-info')
})

Deno.test('semver bump from the repo diff', () => {
  const a = parseSpec(V1).doc
  const removedField = parseSpec(V1.replace('        total:\n          type: number\n', '')).doc
  const added = parseSpec(V1.replace('components:', `  /health:\n    get:\n      responses:\n        '200':\n          description: ok\ncomponents:`)).doc
  assertEquals(bumpFor(diffSpecs(a, a)), 'none')
  assertEquals(bumpFor(diffSpecs(a, removedField)), 'major')
  assertEquals(bumpFor(diffSpecs(a, added)), 'minor')
  assertEquals(bumpVersion('1.2.0', 'major'), '2.0.0')
  assertEquals(bumpVersion('v1.2.3', 'minor'), 'v1.3.0')
  assertEquals(bumpVersion('1.2.3', 'patch'), '1.2.4')
  assertEquals(bumpVersion('draft', 'major'), 'draft')
})

Deno.test('operation names are stable identifiers', () => {
  assertEquals(operationName({ operationId: 'getOrder', method: 'GET', path: '/x' }), 'getOrder')
  assertEquals(operationName({ method: 'GET', path: '/users/{id}/posts' }), 'getUsersByIdPosts')
  assertEquals(operationName({ operationId: 'list-all items', method: 'GET', path: '/' }), 'listAllItems')
})

Deno.test('generates a typed fetch client', () => {
  const src = tsClientFor(parseSpec(V1).doc)
  assertStringIncludes(src, `export type Order = { id: string; total?: number; status?: "open" | "paid" }`)
  assertStringIncludes(src, `const baseUrl = (opts.baseUrl ?? "https://orders.example/api")`)
  assertStringIncludes(src, 'getOrder: (params: { id: string }) => call<Order>("GET", `/orders/${encodeURIComponent(String(params["id"]))}`, undefined),')
  assertStringIncludes(src, 'postOrders: (body: Order) => call<void>("POST", `/orders`, undefined, body),')
  assert(tsClientFor(null) === '')
})
