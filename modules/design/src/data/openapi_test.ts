import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  detectKind,
  diffSpecs,
  exampleFor,
  extractOperations,
  locateLine,
  type OpenApiDoc,
  parseSpec,
  parseYaml,
  snippetFor,
  SPEC_STARTERS,
  toYaml,
  validateInstance,
  validateSpec,
} from './openapi.ts'

Deno.test('YAML: block scalars, flow collections, folded plain scalars, quotes', () => {
  const v = parseYaml(`a: |
  line one
  line two
b: >-
  folded
  text
c: [1, "two", {x: 3}]
d: 'it''s'
e: "tab\\tquote\\""
f: this is
  continued
g:
- one
- k: v
  m: 2
h: ~
`) as Record<string, unknown>
  assertEquals(v.a, 'line one\nline two\n')
  assertEquals(v.b, 'folded text')
  assertEquals(v.c, [1, 'two', { x: 3 }])
  assertEquals(v.d, "it's")
  assertEquals(v.e, 'tab\tquote"')
  assertEquals(v.f, 'this is continued')
  assertEquals(v.g, ['one', { k: 'v', m: 2 }])
  assertEquals(v.h, null)
})

Deno.test('YAML errors carry line numbers', () => {
  const r = parseSpec('openapi: 3.1.0\ninfo:\n  title: x\n    bad: indent\n')
  assert(r.error)
  assertEquals(r.errorLine, 4)
  const d = parseSpec('a: 1\na: 2\n')
  assertEquals(d.errorLine, 2)
  const j = parseSpec('{\n  "a": 1,\n}')
  assertEquals(j.format, 'json')
  assert(j.error)
})

Deno.test('toYaml round-trips the starter specs', () => {
  for (const s of SPEC_STARTERS) {
    const { doc } = parseSpec(s.document)
    assert(doc, s.id)
    assertEquals(parseYaml(toYaml(doc)), JSON.parse(JSON.stringify(doc)))
  }
  assertEquals(toYaml({ s: 'yes', n: '42', m: 'a\nb', e: [], k: { '200': 'ok' } }), 's: "yes"\nn: "42"\nm: |-\n  a\n  b\ne: []\nk:\n  "200": ok')
})

Deno.test('starters are valid and detected', () => {
  const kinds = SPEC_STARTERS.map((s) => detectKind(parseSpec(s.document).doc))
  assertEquals(kinds, ['openapi', 'asyncapi', 'jsonschema'])
  for (const s of SPEC_STARTERS) {
    const p = parseSpec(s.document)
    const errs = validateSpec(p.doc, s.document).filter((i) => i.severity === 'error')
    assertEquals(errs, [], s.id)
  }
})

Deno.test('operations: path-level params, $ref bodies/responses, AsyncAPI channels', () => {
  const doc = parseSpec(SPEC_STARTERS[0].document).doc
  const ops = extractOperations(doc)
  assertEquals(ops.map((o) => o.key), ['GET /orders', 'POST /orders', 'GET /orders/{orderId}'])
  const get = ops[2]
  assertEquals(get.parameters[0].name, 'orderId')
  assertEquals(get.parameters[0].required, true)
  const post = ops[1]
  assertEquals(post.requestBody?.required, true)
  assertEquals(post.responses.map((r) => r.status), ['201', '422'])
  assertEquals(post.responses[1].description, 'Validation failed')
  const async = extractOperations(parseSpec(SPEC_STARTERS[1].document).doc)
  assertEquals(async.map((o) => o.key), ['SUB orders.created', 'PUB orders.shipped'])
  assertEquals(async[0].message?.contentType, 'application/json')
})

Deno.test('examples follow refs, allOf, formats and enums', () => {
  const doc = parseSpec(SPEC_STARTERS[0].document).doc!
  const ex = exampleFor({ $ref: '#/components/schemas/Order' }, doc) as Record<string, unknown>
  assertEquals(ex.sku, 'SKU-1042')
  assertEquals(ex.status, 'pending')
  assertEquals(ex.id, '3fa85f64-5717-4562-b3fc-2c963f66afa6')
  // Recursive schemas terminate.
  const rec = { components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } } } } }
  assertEquals(exampleFor({ $ref: '#/components/schemas/Node' }, rec), { child: {} })
})

Deno.test('snippets', () => {
  const doc = parseSpec(SPEC_STARTERS[0].document).doc!
  const ops = extractOperations(doc)
  const curl = snippetFor('curl', ops[1], 'https://api.example.com/v1', doc)
  assert(curl.startsWith("curl -X POST 'https://api.example.com/v1/orders'"))
  assert(curl.includes('"Authorization: Bearer $TOKEN"'))
  assert(curl.includes('"sku": "SKU-1042"'))
  assert(snippetFor('fetch', ops[2], 'https://x', doc).includes('https://x/orders/3fa85f64'))
  assert(snippetFor('python', ops[1], 'https://x', doc).includes('json={'))
})

Deno.test('validation finds structural problems with lines', () => {
  const text = `openapi: 3.0.3
info:
  title: T
paths:
  users/{id}:
    get:
      operationId: a
      responses: {}
  /b:
    post:
      operationId: a
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Missing'
`
  const issues = validateSpec(parseSpec(text).doc, text)
  const msgs = issues.map((i) => i.message)
  assert(msgs.some((m) => m.includes('info.version')))
  assert(msgs.some((m) => m.includes('must start with "/"')))
  assert(msgs.some((m) => m.includes('"{id}" is not declared')))
  assert(msgs.some((m) => m.includes('no responses')))
  assert(msgs.some((m) => m.includes('Duplicate operationId')))
  const unresolved = issues.find((i) => i.message.includes('Unresolved'))!
  assertEquals(unresolved.line, 18)
  assertEquals(locateLine(text, ['paths', '/b', 'post']), 10)
})

Deno.test('diff flags breaking changes', () => {
  const a = parseSpec(SPEC_STARTERS[0].document).doc as OpenApiDoc
  const b = JSON.parse(JSON.stringify(a)) as OpenApiDoc
  delete (b.paths as Record<string, unknown>)['/orders/{orderId}']
  ;(b.paths!['/orders'].get as { parameters: unknown[] }).parameters.push({ name: 'tenant', in: 'header', required: true, schema: { type: 'string' } })
  ;(b.components!.schemas!.NewOrder.properties as Record<string, unknown>).note = { type: 'string' }
  ;(b.components!.schemas!.NewOrder.required as string[]).push('note')
  const d = diffSpecs(a, b)
  assertEquals(d.removed, ['GET /orders/{orderId}'])
  assert(d.breaking.some((x) => x.includes('new required header parameter "tenant"')))
  assert(d.breaking.some((x) => x.includes('new required request field "note"')))
  assertEquals(d.schemasChanged.map((c) => c.key), ['NewOrder', 'Order'].filter((n) => d.schemasChanged.some((c) => c.key === n)))
})

Deno.test('JSON Schema instance validation', () => {
  const doc = parseSpec(SPEC_STARTERS[2].document).doc!
  const ok = { name: 'Platform', slug: 'platform', members: [{ email: 'a@b.co', role: 'owner' }] }
  assertEquals(validateInstance(doc, ok, doc), [])
  const bad = validateInstance(doc, { name: 'P', slug: 'Bad Slug', members: [{ email: 'nope', role: 'god' }] }, doc)
  const paths = bad.map((e) => `${e.path} ${e.message}`)
  assert(paths.some((p) => p.startsWith('$.name shorter')))
  assert(paths.some((p) => p.startsWith('$.slug does not match')))
  assert(paths.some((p) => p.startsWith('$.members[0].email is not an email')))
  assert(paths.some((p) => p.startsWith('$.members[0].role must be one of')))
})
