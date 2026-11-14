import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { appFreight, giteaRepoOf, handleScaling, type ScalingDeps } from './scaling.ts'
import type { K8sIdentity } from './k8s/gateway.ts'

/* ─────────── a small cluster + Gitea ─────────── */

const OVERLAY = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: prod
resources:
  - ../../base
patches:
  - target: {kind: Rollout, name: "shop"}
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 2
`
const BASE_KZ = 'resources:\n  - rollout.yaml\n  - hpa.yaml\n'
const BASE_HPA = 'apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: shop\nspec:\n  scaleTargetRef: {apiVersion: argoproj.io/v1alpha1, kind: Rollout, name: shop}\n  minReplicas: 2\n  maxReplicas: 4\n'

interface World {
  type?: string
  hpa: boolean
  keda?: boolean
  desired: number
  freight?: string
  canPromote?: boolean
  permitted?: boolean
  files: Map<string, { text: string; sha: string }>
  commits: Array<{ branch: string; message: string; files: Array<{ operation: string; path: string; content?: string }> }>
  promotions: unknown[]
  scales: unknown[]
  records: Array<{ action: string; outcome: string; meta: Record<string, unknown> }>
  argoSync?: string
}

function world(over: Partial<World> = {}): World {
  const files = new Map<string, { text: string; sha: string }>([
    ['main:deploy/envs/prod/kustomization.yaml', { text: OVERLAY, sha: 'a1' }],
    ['main:deploy/base/kustomization.yaml', { text: BASE_KZ, sha: 'b1' }],
    ['main:deploy/base/hpa.yaml', { text: BASE_HPA, sha: 'b2' }],
    ['main:deploy/base/rollout.yaml', { text: 'kind: Rollout\nmetadata:\n  name: shop\n', sha: 'b3' }],
  ])
  return { hpa: true, desired: 3, freight: 'f00d', canPromote: true, permitted: true, files, commits: [], promotions: [], scales: [], records: [], argoSync: 'Synced', ...over }
}

const j = (body: unknown, status = 200) => Response.json(body, { status })
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

function deps(w: World): ScalingDeps {
  const id = { token: 't', user: { id: 'u1', name: 'Ana', email: 'ana@x.io' } } as K8sIdentity
  return {
    user: () => Promise.resolve({ user: { id: 'u1', name: 'Ana', email: 'ana@x.io' }, activeTenant: 'acme' }),
    identity: () => Promise.resolve(id),
    permit: () => Promise.resolve(w.permitted ? null : j({ error: 'forbidden', detail: 'needs update application-scaling.console.adhar.io' }, 403)),
    can: () => Promise.resolve(Boolean(w.canPromote)),
    refreshArgo: () => Promise.resolve(true),
    record: (_t, _a, action, _target, _req, meta, outcome) => {
      w.records.push({ action, outcome, meta })
      return Promise.resolve()
    },
    log: () => {},
    k8s: (_id, path, init) => {
      const method = init?.method ?? 'GET'
      if (path === '/apis/platform.adhar.io/v1alpha1/namespaces/adhar-system/applications/shop') {
        return Promise.resolve(j({
          spec: { parameters: { type: w.type ?? 'service', source: { repoURL: 'https://gitea.example.io/acme/shop.git' } } },
          status: {
            environments: [{ name: 'prod', namespace: 'prod', stage: 'prod', argoApplication: 'acme-shop-prod' }],
            delivery: { promote: true, kargoProject: 'acme', repoURL: 'http://gitea-http.adhar-system.svc.cluster.local:3000/acme/shop.git', path: 'deploy', targetRevision: 'main' },
          },
        }))
      }
      if (path === '/apis/argoproj.io/v1alpha1/namespaces/prod/rollouts/shop' && method === 'GET') return Promise.resolve(j({ spec: { replicas: w.desired } }))
      if (path === '/apis/autoscaling/v2/namespaces/prod/horizontalpodautoscalers') {
        return Promise.resolve(j({
          items: w.hpa
            ? [{
              metadata: { name: 'shop', namespace: 'prod' },
              spec: { scaleTargetRef: { kind: 'Rollout', name: 'shop' }, minReplicas: 2, maxReplicas: 4, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] },
              status: { currentReplicas: 3, desiredReplicas: 3 },
            }]
            : [],
        }))
      }
      if (path === '/apis/keda.sh/v1alpha1/namespaces/prod/scaledobjects') {
        return Promise.resolve(w.keda ? j({ items: [{ metadata: { name: 'shop-so', namespace: 'prod' }, spec: { scaleTargetRef: { kind: 'Rollout', name: 'shop' } } }] }) : j({}, 404))
      }
      if (path === '/apis/kargo.akuity.io/v1alpha1/namespaces/acme/stages/prod') {
        return Promise.resolve(j({ status: { freightHistory: [{ items: w.freight ? { 'Warehouse/shop': { name: w.freight, origin: { kind: 'Warehouse', name: 'shop' } }, 'Warehouse/cart': { name: 'other' } } : {} }] } }))
      }
      if (path === '/apis/kargo.akuity.io/v1alpha1/namespaces/acme/promotions' && method === 'POST') {
        w.promotions.push(JSON.parse(init!.body!))
        return Promise.resolve(j({ metadata: { name: 'prod-abc12' } }, 201))
      }
      if (path === '/apis/argoproj.io/v1alpha1/namespaces/adhar-system/applications/acme-shop-prod') {
        return Promise.resolve(j({ status: { sync: { status: w.argoSync }, operationState: { phase: 'Succeeded' } } }))
      }
      if (path === '/apis/argoproj.io/v1alpha1/namespaces/prod/rollouts/shop/scale' && method === 'PATCH') {
        w.scales.push({ search: init?.search, body: JSON.parse(init!.body!) })
        return Promise.resolve(j({}))
      }
      return Promise.resolve(j({ message: `unexpected ${method} ${path}` }, 404))
    },
    gitea: () => (path, init) => {
      const u = new URL(`http://g${path}`)
      if (u.pathname === '/repos/acme/shop/contents' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as World['commits'][number]
        w.commits.push(body)
        for (const f of body.files) {
          if (f.operation === 'delete') w.files.delete(`${body.branch}:${f.path}`)
          else w.files.set(`${body.branch}:${f.path}`, { text: unb64(f.content!), sha: `s${w.commits.length}` })
        }
        return Promise.resolve(j({ commit: { sha: 'c0ffee1' } }, 201))
      }
      const m = /^\/repos\/acme\/shop\/contents\/(.+)$/.exec(u.pathname)
      const f = m ? w.files.get(`${u.searchParams.get('ref')}:${decodeURIComponent(m[1])}`) : undefined
      return Promise.resolve(f ? j({ type: 'file', encoding: 'base64', content: b64(f.text), sha: f.sha }) : j({ message: 'not found' }, 404))
    },
  }
}

const post = (body: unknown, sub = '') => new Request(`http://console.local/api/catalog/scaling${sub}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

/* ─────────── tests ─────────── */

Deno.test('giteaRepoOf / appFreight read the shapes the platform writes', () => {
  assertEquals(giteaRepoOf('http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/reactapp.git'), { org: 'adhar', repo: 'reactapp' })
  assertEquals(giteaRepoOf('ftp://x'), undefined)
  assertEquals(appFreight({ status: { freightHistory: [{ items: { 'Warehouse/a': { name: 'fa' }, 'Warehouse/b': { name: 'fb', origin: { name: 'b' } } } }] } }, 'b'), 'fb')
  assertEquals(appFreight({ status: { currentFreight: { name: 'only' } } }, 'b'), 'only')
})

Deno.test('GET: overlay found, nothing managed yet', async () => {
  const w = world()
  const res = await handleScaling(new Request('http://console.local/api/catalog/scaling?app=shop&env=prod'), '', deps(w))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.overlay, 'ok')
  assertEquals(body.managed, false)
  assertEquals(body.workload, { kind: 'Rollout', name: 'shop' })
  assertEquals(body.repo, { org: 'acme', repo: 'shop', branch: 'main', dir: 'deploy/envs/prod' })
  assertEquals(body.delivery, 'kargo')
})

Deno.test('dry run: autoscaling off previews the files, the change and the rollout — and writes nothing', async () => {
  const w = world()
  const res = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 5 }, dryRun: true }), '', deps(w))
  assertEquals(res.status, 200)
  const { plan } = await res.json()
  assertEquals(plan.summary, 'Autoscaling off · hold 5 instances')
  assertEquals(plan.confirm, 'production')
  assertEquals(plan.rollout, 'promotion')
  assertEquals(plan.files.map((f: { path: string }) => f.path), ['deploy/envs/prod/kustomization.yaml', 'deploy/envs/prod/scaling.yaml'])
  assertStringIncludes(plan.files[1].after, '$patch: delete')
  assert(plan.warnings.some((x: string) => x.includes('autoscaler stops')))
  assertEquals(w.commits.length, 0)
  assertEquals(w.promotions.length, 0)
})

Deno.test('apply in production needs the typed name', async () => {
  const w = world()
  const res = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 5 } }), '', deps(w))
  assertEquals(res.status, 400)
  assertEquals((await res.json()).error, 'confirm_required')
  assertEquals(w.commits.length, 0)
})

Deno.test('apply: commits [skip ci] to the overlay as the user, then promotes the running freight', async () => {
  const w = world()
  const d = deps(w)
  const { plan } = await (await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 5 }, dryRun: true }), '', d)).json()
  const res = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 5 }, fingerprint: plan.fingerprint, confirm: 'shop' }), '', d)
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals([body.commit, body.promotion, body.rollout], ['c0ffee1', 'prod-abc12', 'promotion'])
  assertEquals(w.commits.length, 1)
  assertEquals(w.commits[0].branch, 'main')
  assertStringIncludes(w.commits[0].message, '[skip ci]')
  assertStringIncludes(w.commits[0].message, 'via Adhar console by Ana')
  assertEquals(w.commits[0].files.map((f) => [f.operation, f.path]), [['update', 'deploy/envs/prod/kustomization.yaml'], ['create', 'deploy/envs/prod/scaling.yaml']])
  assertEquals((w.promotions[0] as { spec: unknown }).spec, { stage: 'prod', freight: 'f00d' })
  assertEquals(w.records.map((r) => [r.action, r.outcome]), [['app.scale', 'success']])
  assertEquals(w.records[0].meta.to, { mode: 'fixed', replicas: 5 })
})

Deno.test('apply refuses a plan built on files that changed since', async () => {
  const w = world()
  const res = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 5 }, fingerprint: 'deadbeef', confirm: 'shop' }), '', deps(w))
  assertEquals(res.status, 409)
  assertEquals((await res.json()).error, 'stale')
  assertEquals(w.commits.length, 0)
})

Deno.test('no permission: refused before anything is written', async () => {
  const w = world({ permitted: false })
  const res = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'auto', min: 2, max: 8, cpu: 60 }, confirm: 'shop' }), '', deps(w))
  assertEquals(res.status, 403)
  assertEquals(w.commits.length, 0)
})

Deno.test('invalid intents are refused with the field rule', async () => {
  const w = world()
  for (const intent of [{ mode: 'auto', min: 0, max: 3, cpu: 70 }, { mode: 'auto', min: 4, max: 3, cpu: 70 }, { mode: 'fixed', replicas: 500 }, { mode: 'auto', min: 1, max: 3 }]) {
    const res = await handleScaling(post({ app: 'shop', env: 'prod', intent }), '', deps(w))
    assertEquals(res.status, 400, JSON.stringify(intent))
  }
})

Deno.test('KEDA-scaled and function applications are not offered', async () => {
  const keda = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 2 }, dryRun: true }), '', deps(world({ keda: true })))
  assertEquals([keda.status, (await keda.json()).error], [409, 'keda_managed'])
  const fn = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 2 }, dryRun: true }), '', deps(world({ type: 'function' })))
  assertEquals([fn.status, (await fn.json()).error], [409, 'not_scalable'])
})

Deno.test('no freight in the environment, or no right to promote: committed, applied at the next promotion', async () => {
  for (const w of [world({ freight: undefined }), world({ canPromote: false })]) {
    const res = await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'auto', min: 2, max: 6, cpu: 70 }, confirm: 'shop' }), '', deps(w))
    const body = await res.json()
    assertEquals(body.rollout, 'deferred')
    assert(body.rolloutReason.length > 10)
    assertEquals(w.promotions.length, 0)
    assertEquals(w.commits.length, 1)
  }
})

Deno.test('settle: refused until the rendered branch carries the count, then sets it through the scale subresource', async () => {
  const w = world({ hpa: false, desired: 4 })
  const d = deps(w)
  await handleScaling(post({ app: 'shop', env: 'prod', intent: { mode: 'fixed', replicas: 2 }, confirm: 'shop' }), '', d)

  const early = await handleScaling(post({ app: 'shop', env: 'prod' }, '/settle'), '/settle', d)
  assertEquals([early.status, (await early.json()).error], [409, 'not_rolled_out'])

  w.files.set('stage/prod:manifests.yaml', { text: 'apiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  name: shop\nspec:\n  replicas: 2\n', sha: 'r1' })
  w.argoSync = 'OutOfSync'
  const busy = await handleScaling(post({ app: 'shop', env: 'prod' }, '/settle'), '/settle', d)
  assertEquals([busy.status, (await busy.json()).error], [409, 'argo_busy'])

  w.argoSync = 'Synced'
  const ok = await handleScaling(post({ app: 'shop', env: 'prod' }, '/settle'), '/settle', d)
  assertEquals(ok.status, 200)
  assertEquals(w.scales, [{ search: '?fieldManager=adhar-console', body: { spec: { replicas: 2 } } }])
  assertEquals(w.records.at(-1)?.action, 'app.scale.settle')
})

Deno.test('settle refuses while an autoscaler decides the count', async () => {
  const res = await handleScaling(post({ app: 'shop', env: 'prod' }, '/settle'), '/settle', deps(world()))
  assertEquals([res.status, (await res.json()).error], [409, 'autoscaler_present'])
})

Deno.test('only GET and POST, and no cross-origin writes', async () => {
  assertEquals((await handleScaling(new Request('http://console.local/api/catalog/scaling', { method: 'DELETE' }), '', deps(world()))).status, 405)
  const xo = new Request('http://console.local/api/catalog/scaling', { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })
  assertEquals((await handleScaling(xo, '', deps(world()))).status, 403)
})
