import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { handleListTemplates, invalidateTemplateDiscovery } from './templates.ts'

// A fake Gitea with a fixed latency per call that counts how many requests are
// in flight at once — so the test can tell reads made together from reads made
// one after another without timing them (a timed test fails on a loaded machine).
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

function withFakeGitea(fn: (calls: string[], load: { inFlight: number; maxInFlight: number }) => Promise<void>) {
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
    const load = { inFlight: 0, maxInFlight: 0 }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      calls.push(url.pathname)
      load.maxInFlight = Math.max(load.maxInFlight, ++load.inFlight)
      await new Promise((r) => setTimeout(r, LATENCY))
      load.inFlight--
      if (url.pathname.endsWith('/contents/templates')) {
        return Response.json(NAMES.map((n) => ({ type: 'dir', name: n, path: `templates/${n}` })))
      }
      if (url.pathname.endsWith('/catalog-info.yaml')) return new Response('not found', { status: 404 })
      const m = url.pathname.match(/\/raw\/templates\/([^/]+)\/template\.yaml$/)
      if (m) return new Response(templateYaml(m[1]))
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    try {
      await fn(calls, load)
    } finally {
      globalThis.fetch = saved.fetch
      for (const [k, v] of Object.entries(saved.env)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
      invalidateTemplateDiscovery()
    }
  }
}

Deno.test(
  'templates are read from Gitea together, not one after another',
  withFakeGitea(async (calls, load) => {
    const res = await handleListTemplates(new Request('http://console.test/api/templates'))
    const body = await res.json()
    assertEquals(res.status, 200)
    assertEquals(body.templates.length, NAMES.length)
    // Discovery order is kept even though reads finish in any order.
    assertEquals(body.templates.map((t: { id: string }) => t.id), NAMES)
    assertEquals(body.repo, 'adhar-templates')
    // 2 listing calls + 7 template reads = 9 calls. One after another, never
    // more than one is in flight; read together, several are.
    assertEquals(calls.length, 2 + NAMES.length)
    assert(load.maxInFlight >= 3, `at most ${load.maxInFlight} request(s) in flight — reads are not parallel`)
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
