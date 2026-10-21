import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { handleListTemplates, invalidateTemplateDiscovery } from './templates.ts'

// A fake Gitea with a fixed latency per call, so the test can tell reads made
// together from reads made one after another.
const LATENCY = 40
const NAMES = ['node-service', 'go-service', 'react-site', 'data-pipeline', 'ml-model', 'docs-site', 'infra-module']

function templateYaml(name: string): string {
  return `apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: ${name}
  title: ${name}
  description: The ${name} golden path.
  tags:
    - recommended
spec:
  type: service
  parameters:
    - title: Basics
      required:
        - name
      properties:
        name:
          type: string
`
}

function withFakeGitea(fn: (calls: string[]) => Promise<void>) {
  return async () => {
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
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      calls.push(url.pathname)
      await new Promise((r) => setTimeout(r, LATENCY))
      if (url.pathname.endsWith('/contents/templates')) {
        return Response.json(NAMES.map((n) => ({ type: 'dir', name: n, path: `templates/${n}` })))
      }
      if (url.pathname.endsWith('/catalog-info.yaml')) return new Response('not found', { status: 404 })
      const m = url.pathname.match(/\/raw\/templates\/([^/]+)\/template\.yaml$/)
      if (m) return new Response(templateYaml(m[1]))
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      await fn(calls)
    } finally {
      globalThis.fetch = saved.fetch
      for (const [k, v] of Object.entries(saved.env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
      invalidateTemplateDiscovery()
    }
  }
}

Deno.test(
  'templates are read from Gitea together, not one after another',
  withFakeGitea(async (calls) => {
    const t0 = performance.now()
    const res = await handleListTemplates(new Request('http://console.test/api/templates'))
    const took = performance.now() - t0
    const body = await res.json()
    assertEquals(res.status, 200)
    assertEquals(body.templates.length, NAMES.length)
    // Discovery order is kept even though reads finish in any order.
    assertEquals(body.templates.map((t: { id: string }) => t.id), NAMES)
    assertEquals(body.repo, 'adhar-templates')
    // 2 listing calls + 7 template reads = 9 calls. In series that is
    // 9 × LATENCY; together it is 3 rounds (listing, then 6 + 1 reads).
    assertEquals(calls.length, 2 + NAMES.length)
    assert(took < LATENCY * 5, `took ${Math.round(took)} ms — reads are not parallel`)
  }),
)

Deno.test(
  'a second visit is served from the discovery cache; refresh=1 reads Gitea again',
  withFakeGitea(async (calls) => {
    await (await handleListTemplates(new Request('http://console.test/api/templates'))).json()
    const first = calls.length
    const again = await (await handleListTemplates(new Request('http://console.test/api/templates'))).json()
    assertEquals(again.templates.length, NAMES.length)
    assertEquals(calls.length, first, 'cached visit must not call Gitea')
    await (await handleListTemplates(new Request('http://console.test/api/templates?refresh=1'))).json()
    assertEquals(calls.length, first * 2)
  }),
)

Deno.test(
  'concurrent page loads share one discovery',
  withFakeGitea(async (calls) => {
    const [a, b] = await Promise.all([
      handleListTemplates(new Request('http://console.test/api/templates')),
      handleListTemplates(new Request('http://console.test/api/templates')),
    ])
    assertEquals((await a.json()).templates.length, NAMES.length)
    assertEquals((await b.json()).templates.length, NAMES.length)
    assertEquals(calls.length, 2 + NAMES.length)
  }),
)
