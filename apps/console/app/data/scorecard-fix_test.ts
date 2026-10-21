import { assert, assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1'
import type { Entity } from './catalog.ts'
import {
  catalogInfoPath,
  deploySourcesFor,
  descriptorDoc,
  editDescriptor,
  entitySource,
  findWorkload,
  fixBranchName,
  fixForCheck,
  fixForSignal,
  kustomizationResources,
  type ManifestBase,
  overlayDescriptor,
  patchEntity,
  pendingFor,
  type PendingFix,
  planManifestFix,
  prunePending,
  repoFromUrl,
  resolveRel,
  scoreDelta,
  snapshotOf,
  suggestResources,
} from './scorecard-fix.ts'
import { diffHunks, diffLines, parseDocs } from './scorecard-yaml-edit.ts'

const entity = (over: Partial<Entity> = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'cart', namespace: 'default', ...(over.metadata ?? {}) },
  spec: { type: 'service', ...(over.spec ?? {}) },
  origin: over.origin ?? 'live',
})

/* ─────────── check → fix mapping ─────────── */

Deno.test('fixForCheck: metadata checks edit the source, live-only explains the annotation', () => {
  assertEquals(fixForCheck({ id: 'has-owner', pass: false }, 'component:cart', 'gitea'), { kind: 'metadata', field: 'owner', source: 'gitea' })
  assertEquals(fixForCheck({ id: 'lifecycle-production', pass: false }, 'component:cart', 'registered')?.kind, 'metadata')
  const live = fixForCheck({ id: 'has-runbook', pass: false }, 'component:cart', 'live')
  assertEquals(live?.kind, 'explain')
  assertStringIncludes((live as { explain: string }).explain, 'adhar.io/runbook')
})

Deno.test('fixForCheck: manifest checks, deep links, and passing checks', () => {
  assertEquals(fixForCheck({ id: 'resource-limits', pass: false }, 'component:cart', 'gitea'), { kind: 'manifest', target: 'resources' })
  assertEquals(fixForCheck({ id: 'has-hpa', pass: false }, 'component:cart', 'live'), { kind: 'manifest', target: 'hpa' })
  assertEquals(fixForCheck({ id: 'has-pdb', pass: false }, 'component:cart', 'live'), { kind: 'manifest', target: 'pdb' })
  const ci = fixForCheck({ id: 'has-ci', pass: false }, 'component:cart', 'gitea')
  assertEquals(ci?.kind === 'link' && ci.href, '/develop?section=builds')
  const git = fixForCheck({ id: 'gitops-deployed', pass: false }, 'component:cart', 'gitea')
  assertEquals(git?.kind === 'link' && git.href, '/catalog?entity=component%3Acart&tab=deploy')
  assertEquals(fixForCheck({ id: 'image-scanned', pass: false }, 'x', 'gitea')?.kind === 'link', true)
  const alerts = fixForCheck({ id: 'has-alerts', pass: false }, 'x', 'gitea')
  assertEquals(alerts?.kind === 'link' && alerts.href, '/discover?section=alerts')
  assertEquals(fixForCheck({ id: 'has-owner', pass: true }, 'x', 'gitea'), null)
  assertEquals(fixForCheck({ id: 'unknown', pass: false }, 'x', 'gitea'), null)
})

Deno.test('fixForSignal: platform signals map to manifest fixes or links', () => {
  assertEquals(fixForSignal({ name: 'resources', applicable: true, score: 0.5 }, 'cart', 'c'), { kind: 'manifest', target: 'resources' })
  assertEquals(fixForSignal({ name: 'autoscaling', applicable: true, score: 0 }, 'cart', 'c'), { kind: 'manifest', target: 'hpa' })
  assertEquals(fixForSignal({ name: 'pod_disruption_budget', applicable: true, score: 0 }, 'cart', 'c'), { kind: 'manifest', target: 'pdb' })
  assertEquals(fixForSignal({ name: 'resources', applicable: true, score: 1 }, 'cart', 'c'), null)
  assertEquals(fixForSignal({ name: 'resources', applicable: false, score: 0 }, 'cart', 'c'), null)
  const lt = fixForSignal({ name: 'load_test', applicable: true, score: 0 }, 'cart', 'c')
  assertEquals(lt?.kind === 'link' && lt.href, '/deliver?section=performance&view=readiness&app=cart')
})

Deno.test('entitySource: registered wins, then a Gitea repo, else live', () => {
  assertEquals(entitySource(entity({ origin: 'registered' }), true), 'registered')
  assertEquals(entitySource(entity(), true), 'gitea')
  assertEquals(entitySource(entity(), false), 'live')
})

Deno.test('catalogInfoPath: managed-by-location annotation, then dir, then root', () => {
  assertEquals(catalogInfoPath(entity()), 'catalog-info.yaml')
  assertEquals(catalogInfoPath(entity(), 'apps/cart/'), 'apps/cart/catalog-info.yaml')
  assertEquals(
    catalogInfoPath(entity({ metadata: { name: 'cart', annotations: { 'backstage.io/managed-by-location': 'url:https://git.example.com/acme/cart/src/branch/main/services/cart/catalog-info.yaml' } } })),
    'services/cart/catalog-info.yaml',
  )
})

/* ─────────── catalog-info.yaml edits ─────────── */

const DESCRIPTOR = `# Owned by the cart squad
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: cart
  description: "Shopping cart" # keep me
  annotations:
    argocd/app-name: cart
  tags: ["golden-path"]
spec:
  type: service
  lifecycle: experimental
`

Deno.test('editDescriptor: replaces existing values in place and keeps comments', () => {
  const r = editDescriptor(DESCRIPTOR, entity(), { description: 'Cart service', lifecycle: 'production' })
  assertEquals(r.created, false)
  assertEquals(r.reserialised, false)
  assertStringIncludes(r.content, '# Owned by the cart squad')
  assertStringIncludes(r.content, 'description: Cart service # keep me')
  assertStringIncludes(r.content, 'lifecycle: production')
  assertEquals(r.content.split('\n').length, DESCRIPTOR.split('\n').length)
})

Deno.test('editDescriptor: inserts missing fields (owner, links) where they belong', () => {
  const r = editDescriptor(DESCRIPTOR, entity(), {
    owner: 'group:payments',
    links: [{ url: 'https://grafana.example.com/d/cart', title: 'Dashboard', icon: 'dashboard' }],
  })
  assertEquals(r.reserialised, false)
  const doc = descriptorDoc(r.content, entity())!
  assertEquals((doc.spec as Record<string, unknown>).owner, 'payments')
  const links = (doc.metadata as Record<string, unknown>).links as Array<Record<string, unknown>>
  assertEquals(links[0], { url: 'https://grafana.example.com/d/cart', title: 'Dashboard', icon: 'dashboard' })
  // The owner lands inside spec, the links inside metadata.
  const lines = r.content.split('\n')
  assert(lines.indexOf('  owner: payments') > lines.indexOf('spec:'))
  assert(lines.findIndex((l) => l.includes('links:')) < lines.indexOf('spec:'))
})

Deno.test('editDescriptor: appends to an existing links list at its indentation', () => {
  const src = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: cart
  links:
    - url: https://docs.example.com/cart
      title: Docs
      icon: docs
spec:
  owner: payments
`
  const r = editDescriptor(src, entity(), { links: [{ url: 'https://runbooks.example.com/cart', title: 'Runbook', icon: 'runbook' }] })
  assertStringIncludes(r.content, '    - url: https://runbooks.example.com/cart\n      title: Runbook\n      icon: runbook')
  const links = (descriptorDoc(r.content, entity())!.metadata as Record<string, unknown>).links as unknown[]
  assertEquals(links.length, 2)
})

Deno.test('editDescriptor: links: [] becomes a block list', () => {
  const src = 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: cart\n  links: []\nspec:\n  owner: a\n'
  const r = editDescriptor(src, entity(), { links: [{ url: 'https://d.example.com', title: 'Docs', icon: 'docs' }] })
  assertEquals(r.reserialised, false)
  assertStringIncludes(r.content, '  links:\n  - url: https://d.example.com')
})

Deno.test('editDescriptor: creates spec when the document has none', () => {
  const src = 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: cart\n'
  const r = editDescriptor(src, entity(), { owner: 'payments', lifecycle: 'production' })
  const spec = descriptorDoc(r.content, entity())!.spec as Record<string, unknown>
  assertEquals(spec, { owner: 'payments', lifecycle: 'production' })
})

Deno.test('editDescriptor: multi-document streams only change the matching document', () => {
  const src = `apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: cart-api
spec:
  owner: other
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: cart
spec:
  owner: other
`
  const r = editDescriptor(src, entity(), { owner: 'payments' })
  const docs = parseDocs(r.content)
  assertEquals(((docs[0].value as Record<string, unknown>).spec as Record<string, unknown>).owner, 'other')
  assertEquals(((docs[1].value as Record<string, unknown>).spec as Record<string, unknown>).owner, 'payments')
})

Deno.test('editDescriptor: flow-style metadata falls back to a re-serialisation, flagged', () => {
  const src = 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata: {name: cart}\nspec:\n  owner: a\n'
  const r = editDescriptor(src, entity(), { description: 'Cart' })
  assertEquals(r.reserialised, true)
  assertEquals((descriptorDoc(r.content, entity())!.metadata as Record<string, unknown>).description, 'Cart')
})

Deno.test('editDescriptor: a missing file is created; garbage is refused', () => {
  const r = editDescriptor(null, entity({ spec: { type: 'service', lifecycle: 'staging' } }), { owner: 'group:payments', description: 'Cart' })
  assertEquals(r.created, true)
  const doc = descriptorDoc(r.content, entity())!
  assertEquals(doc.kind, 'Component')
  assertEquals((doc.metadata as Record<string, unknown>).name, 'cart')
  assertEquals((doc.metadata as Record<string, unknown>).description, 'Cart')
  assertEquals((doc.spec as Record<string, unknown>).owner, 'payments')
  assertEquals((doc.spec as Record<string, unknown>).lifecycle, 'staging')
  assertThrows(() => editDescriptor('\tnot: yaml', entity(), { owner: 'x' }))
})

Deno.test('patchEntity: registered entities get the same fields', () => {
  const e = patchEntity(entity(), { owner: 'payments', lifecycle: 'production', links: [{ url: 'u', title: 'Docs', icon: 'docs' }] })
  assertEquals(e.spec.owner, 'group:payments')
  assertEquals(e.spec.lifecycle, 'production')
  assertEquals(e.metadata.links?.[0].icon, 'docs')
})

Deno.test('overlayDescriptor: declared owner/description/links reach the evaluator; deployed lifecycle stands', () => {
  const doc = descriptorDoc(DESCRIPTOR.replace('lifecycle: experimental', 'lifecycle: experimental\n  owner: payments'), entity())
  const live = entity({ metadata: { name: 'cart', description: 'Repository acme/cart.' }, spec: { type: 'service', lifecycle: 'staging' } })
  const e = overlayDescriptor(live, doc)
  assertEquals(e.spec.owner, 'group:payments')
  assertEquals(e.metadata.description, 'Shopping cart')
  assertEquals(e.spec.lifecycle, 'staging')
  assertEquals(e.metadata.annotations?.['argocd/app-name'], 'cart')
  // A declared production wins over a derived lifecycle.
  const prod = overlayDescriptor(live, descriptorDoc(DESCRIPTOR.replace('experimental', 'production'), entity()))
  assertEquals(prod.spec.lifecycle, 'production')
  assertEquals(overlayDescriptor(live, undefined), live)
})

/* ─────────── kustomize ─────────── */

Deno.test('repoFromUrl / resolveRel / kustomizationResources', () => {
  assertEquals(repoFromUrl('http://gitea-http.adhar-system.svc:3000/acme/cart.git'), { org: 'acme', repo: 'cart' })
  assertEquals(repoFromUrl('git@git.example.com:acme/cart.git'), { org: 'acme', repo: 'cart' })
  assertEquals(resolveRel('deploy/envs/prod', '../../base'), 'deploy/base')
  assertEquals(resolveRel('deploy', '../../x'), null)
  assertEquals(
    kustomizationResources('resources:\n  - ../../base\n  - https://github.com/x/y//z?ref=v1\n  - extra.yaml\n'),
    ['../../base', 'extra.yaml'],
  )
})

Deno.test('deploySourcesFor: production first, XR source included, deduplicated', () => {
  const apps = [
    { metadata: { name: 'cart-test', labels: { 'adhar.io/application': 'cart', 'adhar.io/environment': 'test' } }, spec: { source: { repoURL: 'http://g/acme/cart.git', path: 'deploy/envs/test' } } },
    { metadata: { name: 'cart-prod', labels: { 'adhar.io/application': 'cart', 'adhar.io/environment': 'prod' } }, spec: { source: { repoURL: 'http://g/acme/cart.git', path: 'deploy/envs/prod' } } },
    { metadata: { name: 'other', labels: {} }, spec: { source: { repoURL: 'http://g/acme/other.git', path: 'deploy' } } },
  ]
  const out = deploySourcesFor('cart', apps, { spec: { parameters: { source: { repoURL: 'http://g/acme/cart', path: 'deploy/envs/prod' } } } })
  assertEquals(out.map((s) => s.path), ['deploy/envs/prod', 'deploy/envs/test'])
  assertEquals(out[0].env, 'prod')
})

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: cart
spec:
  replicas: 1 # one for now
  selector:
    matchLabels:
      app: cart
  template:
    metadata:
      labels:
        app: cart
    spec:
      containers:
        - name: cart
          image: registry/cart:latest
          ports:
            - containerPort: 8080
        - name: sidecar
          image: envoy
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
`

const base = (over: Partial<ManifestBase> = {}): ManifestBase => ({
  dir: 'deploy/base',
  kustomization: { path: 'deploy/base/kustomization.yaml', text: '# base\nresources:\n  - deployment.yaml\n  - service.yaml\n', sha: 'k1' },
  workloadFile: { path: 'deploy/base/deployment.yaml', text: DEPLOYMENT, sha: 'd1' },
  workload: findWorkload(DEPLOYMENT, 'cart')!,
  others: [{ path: 'deploy/base/service.yaml', text: 'apiVersion: v1\nkind: Service\nmetadata:\n  name: cart\n', sha: 's1' }],
  ...over,
})

Deno.test('findWorkload: reads selector, replicas and per-container resources', () => {
  const w = findWorkload(DEPLOYMENT, 'cart')!
  assertEquals(w.kind, 'Deployment')
  assertEquals(w.replicas, 1)
  assertEquals(w.matchLabels, { app: 'cart' })
  assertEquals(w.containers, [
    { name: 'cart', hasRequests: false, hasLimits: false },
    // cpu + memory both requested → a full request; limits absent.
    { name: 'sidecar', hasRequests: true, hasLimits: false },
  ])
})

Deno.test('planManifestFix resources: fills gaps per container, keeps existing numbers and comments', () => {
  const plan = planManifestFix(base(), ['resources'])
  assertEquals(plan.skipped, [])
  assertEquals(plan.changes.length, 1)
  const after = plan.changes[0].after
  assertStringIncludes(after, '# one for now')
  const w = findWorkload(after, 'cart')!
  assert(w.containers.every((c) => c.hasRequests && c.hasLimits))
  // The sidecar's own request survives; only limits were added.
  assertStringIncludes(after, 'cpu: 50m')
  assertStringIncludes(after, 'memory: 64Mi')
  assertEquals(plan.changes[0].baseSha, 'd1')
  // The workload declares what it now carries, for the catalog check.
  assertEquals(plan.stamps, { 'adhar.io/resource-limits': 'true' })
  assertStringIncludes(after, "  annotations:\n    adhar.io/resource-limits: \"true\"")
})

Deno.test('editDescriptor: annotation stamps land under metadata.annotations', () => {
  const r = editDescriptor(DESCRIPTOR, entity(), { annotations: { 'adhar.io/hpa': 'cart' } })
  assertEquals(r.reserialised, false)
  assertStringIncludes(r.content, '    argocd/app-name: cart\n    adhar.io/hpa: cart\n')
})

Deno.test('planManifestFix resources: a partial request gains the missing quantity', () => {
  const dep = DEPLOYMENT.replace('              memory: 64Mi\n', '')
  const plan = planManifestFix(base({ workloadFile: { path: 'deploy/base/deployment.yaml', text: dep, sha: 'd' }, workload: findWorkload(dep, 'cart')! }), ['resources'])
  const w = findWorkload(plan.changes[0].after, 'cart')!
  assert(w.containers.every((c) => c.hasRequests && c.hasLimits))
  assertStringIncludes(plan.changes[0].after, '              cpu: 50m\n              memory: 128Mi')
})

Deno.test('planManifestFix hpa: new hpa.yaml listed in the kustomization, replicas handed to the HPA', () => {
  const plan = planManifestFix(base(), ['hpa'])
  const hpa = plan.changes.find((c) => c.path === 'deploy/base/hpa.yaml')!
  assertEquals(hpa.before, null)
  assertEquals(hpa.baseSha, null)
  const doc = parseDocs(hpa.after)[0].value as Record<string, any>
  assertEquals(doc.kind, 'HorizontalPodAutoscaler')
  assertEquals(doc.spec.minReplicas, 2)
  assertEquals(doc.spec.maxReplicas, 5)
  assertEquals(doc.spec.metrics[0].resource.target.averageUtilization, 70)
  assertEquals(doc.spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: 'cart' })
  const k = plan.changes.find((c) => c.path.endsWith('kustomization.yaml'))!
  assertEquals(kustomizationResources(k.after), ['deployment.yaml', 'service.yaml', 'hpa.yaml'])
  assertStringIncludes(k.after, '# base')
  const dep = plan.changes.find((c) => c.path.endsWith('deployment.yaml'))!
  assertEquals(findWorkload(dep.after, 'cart')!.replicas, undefined)
  assert(plan.notes.some((n) => n.includes('CPU requests')))
})

Deno.test('planManifestFix pdb: selects the workload pods; warns about single replicas', () => {
  const plan = planManifestFix(base(), ['pdb'])
  const pdb = plan.changes.find((c) => c.path === 'deploy/base/pdb.yaml')!
  const doc = parseDocs(pdb.after)[0].value as Record<string, any>
  assertEquals(doc.apiVersion, 'policy/v1')
  assertEquals(doc.spec, { minAvailable: 1, selector: { matchLabels: { app: 'cart' } } })
  assert(plan.notes.some((n) => n.includes('blocks node drains')))
  // Together with an HPA (min 2) the warning goes away.
  const both = planManifestFix(base(), ['hpa', 'pdb', 'resources'])
  assert(!both.notes.some((n) => n.includes('blocks node drains')))
  assertEquals(both.changes.filter((c) => c.path.endsWith('kustomization.yaml')).length, 1)
  assertEquals(kustomizationResources(both.changes.find((c) => c.path.endsWith('kustomization.yaml'))!.after), ['deployment.yaml', 'service.yaml', 'hpa.yaml', 'pdb.yaml'])
})

Deno.test('planManifestFix: skips what already exists; plain directories need no kustomization', () => {
  const withHpa = base({
    others: [{ path: 'deploy/base/autoscale.yaml', text: 'apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: cart\nspec:\n  scaleTargetRef:\n    name: cart\n', sha: 'h' }],
  })
  const p = planManifestFix(withHpa, ['hpa'])
  // Only the stamp changes: the HPA exists, the catalog just could not see it.
  assertEquals(p.changes.map((c) => c.path), ['deploy/base/deployment.yaml'])
  assertEquals(p.stamps, { 'adhar.io/hpa': 'cart' })
  assertEquals(p.skipped[0].target, 'hpa')
  const plain = planManifestFix(base({ kustomization: undefined, dir: 'k8s' }), ['pdb'])
  assertEquals(plain.changes.map((c) => c.path), ['deploy/base/deployment.yaml', 'k8s/pdb.yaml'])
  // An existing hpa.yaml name is not overwritten.
  const taken = planManifestFix(base({ others: [{ path: 'deploy/base/hpa.yaml', text: 'kind: ConfigMap\n', sha: 'x' }] }), ['hpa'])
  assert(taken.changes.some((c) => c.path === 'deploy/base/hpa-2.yaml'))
})

Deno.test('suggestResources: from usage when observed, conservative defaults otherwise', () => {
  assertEquals(suggestResources({}).fromUsage, false)
  assertEquals(suggestResources({}).spec.requests, { cpu: '100m', memory: '128Mi' })
  const s = suggestResources({ cpuCores: 0.2, memoryBytes: 200 * 1024 * 1024 })
  assertEquals(s.fromUsage, true)
  assertEquals(s.spec.requests, { cpu: '240m', memory: '240Mi' })
  assertEquals(s.spec.limits, { cpu: '960m', memory: '480Mi' })
})

/* ─────────── deltas + pending ─────────── */

Deno.test('scoreDelta: the "78 → 86, +2 checks passing" line', () => {
  const card = (score: number, passing: string[]) => ({
    score,
    checks: passing.map((id) => ({ id, label: id, category: 'ownership' as const, weight: 1, pass: true })),
    platform: undefined,
  })
  const d = scoreDelta(snapshotOf(card(78, ['a'])), snapshotOf(card(86, ['a', 'b', 'c'])))
  assertEquals(d.message, '78 → 86, +2 checks passing')
  assertEquals(d.nowPassing, ['check:b', 'check:c'])
  assertEquals(scoreDelta(snapshotOf(card(50, ['a'])), snapshotOf(card(50, ['a']))).message, 'No change — still 50')
  assertEquals(scoreDelta(snapshotOf(card(60, ['a', 'b'])), snapshotOf(card(55, ['a']))).message, '60 → 55, -1 check passing')
})

Deno.test('prunePending: confirmed fixes and stale ones drop, open PRs stay', () => {
  const now = Date.parse('2026-10-22T00:00:00Z')
  const fix = (over: Partial<PendingFix>): PendingFix => ({
    id: 'f', entityRef: 'component:cart', targets: ['check:has-owner'], org: 'a', repo: 'b', branch: 'x', mode: 'pr',
    pr: { number: 3 }, state: 'open', createdAt: '2026-10-01T00:00:00Z', ...over,
  })
  const passed = new Map([['component:cart', new Set(['check:has-owner'])]])
  assertEquals(prunePending([fix({})], passed, now).length, 1)
  assertEquals(prunePending([fix({ state: 'merged', landedAt: '2026-10-21T00:00:00Z' })], passed, now).length, 0)
  assertEquals(prunePending([fix({ state: 'merged', landedAt: '2026-10-21T00:00:00Z' })], new Map(), now).length, 1)
  assertEquals(prunePending([fix({ state: 'committed', landedAt: '2026-10-10T00:00:00Z' })], new Map(), now).length, 0)
  assertEquals(pendingFor([fix({})], 'component:cart', 'check:has-owner')?.pr?.number, 3)
})

Deno.test('fixBranchName + diff', () => {
  assertEquals(fixBranchName('Cart Service', ['check:has-owner'], 36 ** 3), 'scorecard/cart-service-has-owner-1000')
  assertEquals(fixBranchName('cart', ['check:a', 'signal:b'], 1), 'scorecard/cart-readiness-1')
  const d = diffLines('a\nb\nc\n', 'a\nB\nc\n')
  assertEquals(d.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`), ['del:b', 'add:B'])
  assertEquals(diffHunks(diffLines('1\n2\n3\n4\n5\n6\n7\n8\n9\n10', '1\n2\n3\n4\n5\n6\n7\n8\n9\nX'), 1).length, 3)
})
