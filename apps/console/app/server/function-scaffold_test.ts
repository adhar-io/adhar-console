import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { handleListTemplates, inferFamily, invalidateTemplateDiscovery, isFunctionTemplate, templateFamilyOf } from './templates.ts'
import { applicationManifest, applicationTypeOf, applyApplication, WORKLOAD_LABEL } from './control-plane.ts'
import { scaffoldWorkload } from './scaffolder.ts'

/* ───────────── a function template is its own family ───────────── */

Deno.test('templates tagged `function`, or named function-*, are functions — not backend services', () => {
  assert(isFunctionTemplate('function-nodejs-service', ['serverless', 'nodejs']))
  assert(isFunctionTemplate('orders-handler', ['Function']))
  assertEquals(inferFamily('function-java-service', ['function', 'knative', 'java']), 'function')
  assertEquals(inferFamily('my-fn', ['function']), 'function')
  // Everything that merely mentions a function or a service stays where it was.
  assertEquals(isFunctionTemplate('functional-web-service', []), false)
  assertEquals(inferFamily('springboot-web-service', ['java', 'recommended']), 'service')
  assertEquals(inferFamily('react-spa-app', ['react', 'frontend']), 'website')
})

Deno.test('the family is read from a parsed template.yaml', () => {
  assertEquals(templateFamilyOf({ metadata: { name: 'function-go-service', tags: ['go'] } }), 'function')
  assertEquals(templateFamilyOf({ metadata: { name: 'go-web-service', tags: ['go'] } }), 'service')
  assertEquals(templateFamilyOf({ metadata: {} }), undefined)
  assertEquals(templateFamilyOf(null), undefined)
})

const FUNCTION_TEMPLATE = `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: function-nodejs-service
  title: Function Service (Node.js)
  description: A serverless function.
  tags:
    - function
    - serverless
    - nodejs
spec:
  type: service
  parameters:
    - title: Function
      required:
        - name
      properties:
        name:
          type: string
`

Deno.test('discovery hands the wizard a function template under the function family', async () => {
  const saved = {
    fetch: globalThis.fetch,
    env: Object.fromEntries(['GITEA_URL', 'GITEA_TOKEN', 'ADHAR_DEV_CLUSTER_AUTH', 'GITEA_USERNAME', 'GITEA_PASSWORD'].map((k) => [k, Deno.env.get(k)])),
  }
  Deno.env.set('GITEA_URL', 'http://gitea.test')
  Deno.env.set('GITEA_TOKEN', 'test-token')
  Deno.env.set('ADHAR_DEV_CLUSTER_AUTH', 'true')
  Deno.env.delete('GITEA_USERNAME')
  Deno.env.delete('GITEA_PASSWORD')
  invalidateTemplateDiscovery()
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith('/contents/templates')) {
      return Promise.resolve(Response.json([{ type: 'dir', name: 'function-nodejs-service' }]))
    }
    if (url.pathname.endsWith('/function-nodejs-service/template.yaml')) return Promise.resolve(new Response(FUNCTION_TEMPLATE))
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as typeof fetch
  try {
    const res = await handleListTemplates(new Request('http://console.test/api/templates'))
    const body = await res.json()
    assertEquals(body.templates.length, 1)
    const t = body.templates[0]
    assertEquals(t.family, 'function')
    // The catalog entity is still a Component of type service (catalog-info.yaml says so).
    assertEquals(t.produces, { kind: 'Component', type: 'service' })
    // What the template does, said accurately — no kpack build, a function Application.
    const titles = (t.actions as Array<{ title: string }>).map((a) => a.title).join(' | ')
    assert(titles.includes('type function'), titles)
    assertEquals(titles.includes('kpack'), false)
  } finally {
    globalThis.fetch = saved.fetch
    for (const [k, v] of Object.entries(saved.env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
    invalidateTemplateDiscovery()
  }
})

/* ───────────── the scaffolder registers a function Application ───────────── */

Deno.test('the workload comes from the template itself, the wizard’s copy only as a fallback', () => {
  assertEquals(scaffoldWorkload({ metadata: { name: 'function-python-service', tags: [] } }), 'function')
  assertEquals(scaffoldWorkload({ metadata: { name: 'python-web-service', tags: ['python'] } }, { templateId: 'function-x', tags: ['function'] }), undefined)
  assertEquals(scaffoldWorkload(null, { templateId: 'function-deno-service', tags: [] }), 'function')
  assertEquals(scaffoldWorkload(null, { templateId: 'orders', tags: ['function'] }), 'function')
  assertEquals(scaffoldWorkload(null, { templateId: 'go-web-service', tags: ['go'] }), undefined)
  assertEquals(scaffoldWorkload(null), undefined)
})

Deno.test('applicationTypeOf: a function is `function`, a browser app `web`, the rest the default', () => {
  assertEquals(applicationTypeOf(undefined, 'function'), 'function')
  // A function template's dashboard type never turns it into a web app.
  assertEquals(applicationTypeOf('frontend', 'function'), 'function')
  assertEquals(applicationTypeOf('frontend'), 'web')
  assertEquals(applicationTypeOf('fullstack'), 'web')
  assertEquals(applicationTypeOf('backend-generic'), undefined)
  assertEquals(applicationTypeOf(undefined), undefined)
})

Deno.test('a function Application carries type function and the adhar.io/workload label', () => {
  const m = applicationManifest({ name: 'orders', project: 'shop', repoUrl: 'https://g/adhar/orders.git', dashboardType: 'backend-generic', workload: 'function' })
  assertEquals(m.spec.parameters.type, 'function')
  assertEquals(m.metadata.labels[WORKLOAD_LABEL], 'function')
  assertEquals(m.metadata.labels['adhar.io/dashboard-type'], 'backend-generic')
  const svc = applicationManifest({ name: 'orders', project: 'shop', repoUrl: 'x' })
  assertEquals(WORKLOAD_LABEL in svc.metadata.labels, false)
  assertEquals('type' in svc.spec.parameters, false)
})

Deno.test('a control plane whose type enum predates `function` still gets the Application, labelled', async () => {
  Deno.env.set('K8S_API_URL', 'https://apiserver.test')
  const patches: Array<Record<string, unknown>> = []
  const real = globalThis.fetch
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    patches.push(body)
    const params = (body.spec as { parameters: Record<string, unknown> }).parameters
    if (params.type === 'function') {
      return Promise.resolve(new Response(JSON.stringify({
        kind: 'Status',
        message: 'Application.platform.adhar.io "orders" is invalid: spec.parameters.type: Unsupported value: "function": supported values: "service", "web", "worker", "data", "ai"',
      }), { status: 422 }))
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  }) as typeof fetch
  try {
    const m = applicationManifest({ name: 'orders', project: 'shop', repoUrl: 'x', workload: 'function' })
    const out = await applyApplication(m, 'tok')
    assertEquals(out.ok, true)
    assertEquals(patches.length, 2)
    const retried = patches[1] as { metadata: { labels: Record<string, string> }; spec: { parameters: Record<string, unknown> } }
    assertEquals('type' in retried.spec.parameters, false)
    assertEquals(retried.metadata.labels[WORKLOAD_LABEL], 'function')
  } finally {
    globalThis.fetch = real
  }
})

Deno.test('the scaffolder passes the workload to the Application it registers', async () => {
  const src = await Deno.readTextFile(new URL('./scaffolder.ts', import.meta.url))
  for (const want of ['workload = scaffoldWorkload(templateDoc, body)', 'repoUrl: cloneUrl, workload,', 'templateDoc = doc']) {
    if (!src.includes(want)) throw new Error(`scaffolder.ts lacks ${want}`)
  }
})
