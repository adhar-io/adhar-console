import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { readElementsEnabled, requestArgoRefresh, resolvePackageName } from './appset.ts'

// The five names that produced five confident, wrong "set ADHAR_APPSET_REPO and
// ADHAR_APPSET_FILE" errors in one onboarding run — against a repo and file that
// were already configured correctly.
Deno.test('bootstrap components are always installed, not togglable', () => {
  for (const n of ['gitea', 'argocd', 'argo-cd', 'Gitea', 'cilium', 'crossplane']) {
    const r = resolvePackageName(n)
    assertEquals(r.kind, 'always-installed', `${n} should be always-installed`)
  }
})

Deno.test('a sub-component resolves to the package that ships it', () => {
  for (const n of ['grafana', 'prometheus', 'alertmanager', 'kube-prometheus-stack']) {
    assertEquals(resolvePackageName(n), { kind: 'package', name: 'kube-prometheus' })
  }
})

Deno.test('argo-rollouts is a spelling of the argo-rollout package', () => {
  // The package directory is singular; the console names it plural.
  assertEquals(resolvePackageName('argo-rollouts'), { kind: 'package', name: 'argo-rollout' })
})

Deno.test('a real package name passes through untouched', () => {
  for (const n of ['keycloak', 'harbor', 'kyverno', 'airbyte', 'adhar-ai', 'kube-prometheus']) {
    assertEquals(resolvePackageName(n), { kind: 'package', name: n })
  }
})

Deno.test('resolution is case-insensitive but preserves an unmapped name verbatim', () => {
  assertEquals(resolvePackageName('GRAFANA'), { kind: 'package', name: 'kube-prometheus' })
  // Unmapped names keep their original casing — the appset is the authority on
  // spelling, so we must not silently lower-case something we do not know.
  assertEquals(resolvePackageName('MyCustomPkg'), { kind: 'package', name: 'MyCustomPkg' })
})

// The file seeding commits as applicationset.yaml, in the shapes it really takes.
const APPSET = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: helm-charts-production
spec:
  generators:
    - list:
        elements:
          # a comment between elements, as the real file has
          - name: "argo-workflows"
            enabled: "true"
            namespace: "adhar-system"
            manifestPath: "application/argo-workflows/manifests/platform"
          - name: "n8n"
            enabled: "false"
          - packageName: 'legacy'
            enabled: true
          - name: "no-flag"
      selector:
        matchLabels:
          enabled: "true"
`

Deno.test('desired state is read from the file, as the generator reads it', () => {
  assertEquals(readElementsEnabled(APPSET), {
    'argo-workflows': true,
    n8n: false,
    legacy: true,
    'no-flag': false,
  })
})

Deno.test('metadata.name is not an element, and an unreadable file has none', () => {
  assertEquals('helm-charts-production' in readElementsEnabled(APPSET), false)
  assertEquals(readElementsEnabled('not: [an appset'), {})
  assertEquals(readElementsEnabled(''), {})
})

Deno.test('matrix generators are read too', () => {
  const yaml = `spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - name: a
                  enabled: "true"
`
  assertEquals(readElementsEnabled(yaml), { a: true })
})

/** A stand-in for apiServerFetch that records who asked and answers per caller. */
function recorder(answers: Record<string, number>) {
  const calls: Array<{ auth: string; path: string; method?: string; body: unknown; type?: string }> = []
  const call = ((auth: unknown, path: string, init: { method?: string; body?: BodyInit | null; headers?: Record<string, string> } = {}) => {
    const who = String(auth)
    calls.push({ auth: who, path, method: init.method, body: init.body, type: init.headers?.['content-type'] })
    return Promise.resolve(new Response(null, { status: answers[who] ?? 500 }))
  }) as unknown as Parameters<typeof requestArgoRefresh>[3]
  return { calls, call }
}

Deno.test('a toggle asks Argo CD to look at the Application that owns the ApplicationSet', async () => {
  const { calls, call } = recorder({ user: 200 })
  assertEquals(await requestArgoRefresh('adhar-system', 'adhar-platform-applicationset', ['user', 'console'], call), true)
  assertEquals(calls.length, 1)
  assertEquals(calls[0], {
    auth: 'user',
    path: '/apis/argoproj.io/v1alpha1/namespaces/adhar-system/applications/adhar-platform-applicationset',
    method: 'PATCH',
    body: JSON.stringify({ metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } }),
    type: 'application/merge-patch+json',
  })
})

Deno.test('a person allowed to toggle but not to patch Applications falls back to the console', async () => {
  const { calls, call } = recorder({ user: 403, console: 200 })
  assertEquals(await requestArgoRefresh('adhar-system', 'app', ['user', 'console'], call), true)
  assertEquals(calls.map((c) => c.auth), ['user', 'console'])
})

Deno.test('a refused refresh is reported, never thrown: the commit already landed', async () => {
  const { call } = recorder({ user: 403, console: 403 })
  assertEquals(await requestArgoRefresh('adhar-system', 'app', ['user', 'console'], call), false)
  const boom = (() => Promise.reject(new Error('down'))) as unknown as Parameters<typeof requestArgoRefresh>[3]
  assertEquals(await requestArgoRefresh('adhar-system', 'app', ['user', null, undefined], boom), false)
})

// No apiserver or Gitea under this runner, so these read the source. A toggle that
// stopped asking would still commit, and only feel slow: two minutes of "Enabling…".
Deno.test('both ways out of a toggle ask Argo CD to look', async () => {
  const src = await Deno.readTextFile(new URL('./appset.ts', import.meta.url))
  assertEquals(src.match(/refreshed: await settled\(\)/g)?.length, 2)
  assertEquals(/desiredCache\.clear\(\)\s+return await requestArgoRefresh\(/.test(src), true)
})

Deno.test('the desired-state endpoint is served', async () => {
  const src = await Deno.readTextFile(new URL('../../server.ts', import.meta.url))
  assertEquals(src.includes(`if (path === '/api/platform/appset/desired') return handleAppsetDesired(req)`), true)
})
