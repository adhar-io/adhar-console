import { assert, assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1'
import {
  declaredIntent,
  ensurePatchLast,
  findHpaName,
  kustomizeInputs,
  planFiles,
  readPatchFile,
  renderedReplicas,
  renderPatchFile,
  renderResourceFile,
  resolveRepoPath,
  setResource,
  type WorkloadRef,
} from './scaling-gitops.ts'

/** The test environment overlay every paved-road template ships (react-spa-app, rendered). */
const OVERLAY = `# test: promoted automatically once dev is verified.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: test
resources:
  - ../../base
images:
  - name: harbor-core.adhar-system.svc.cluster.local/library/demo
    newTag: latest
patches:
  # Two replicas, like prod.
  - target: {kind: Rollout, name: "demo"}
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 2
  - target: {kind: HorizontalPodAutoscaler, name: "demo"}
    patch: |-
      - op: replace
        path: /spec/minReplicas
        value: 2
`

const BASE_KZ = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - rollout.yaml
  - service.yaml
  - hpa.yaml
`

const BASE_HPA = `# CPU-based autoscaling of the Rollout.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: demo
  labels:
    app: demo
spec:
  scaleTargetRef:
    apiVersion: argoproj.io/v1alpha1
    kind: Rollout
    name: demo
  minReplicas: 1
  maxReplicas: 3
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`

const BASE_ROLLOUT = `apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: demo
  labels:
    app: demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
        - name: app
          image: harbor-core.adhar-system.svc.cluster.local/library/demo:latest
  strategy:
    canary:
      steps:
        - setWeight: 20
`

const BASE_SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: demo
spec:
  selector:
    app: demo
  ports:
    - port: 80
`

const W: WorkloadRef = { kind: 'Rollout', name: 'demo' }

/* ─────────── kustomization edits ─────────── */

Deno.test('ensurePatchLast appends the managed patch after the inline ones, keeping comments and block scalars', () => {
  const out = ensurePatchLast(OVERLAY)
  assert(out.startsWith(OVERLAY), 'the existing text is untouched')
  assertEquals(out.slice(OVERLAY.length), '  - path: scaling.yaml\n')
  assertEquals(ensurePatchLast(out), out, 'idempotent')
})

Deno.test('ensurePatchLast moves an earlier managed entry to the end', () => {
  const moved = OVERLAY.replace('patches:\n', 'patches:\n  - path: scaling.yaml\n')
  const out = ensurePatchLast(moved)
  assertEquals(out.match(/scaling\.yaml/g)?.length, 1)
  assert(out.trimEnd().endsWith('- path: scaling.yaml'))
})

Deno.test('ensurePatchLast also recognises a multi-line entry that names the file', () => {
  const two = OVERLAY.replace('patches:\n', 'patches:\n  - target: {kind: Rollout}\n    path: ./scaling.yaml\n')
  const out = ensurePatchLast(two)
  assertEquals(out.match(/scaling\.yaml/g)?.length, 1)
  assert(!out.includes('target: {kind: Rollout}\n    path'), 'the old entry went, whole')
})

Deno.test('ensurePatchLast inserts before the next key and its leading comment', () => {
  const src = `resources:\n- ../../base\npatches:\n- target: {kind: Rollout}\n  patch: |-\n    - op: test\n\n# the images Kargo sets\nimages:\n- name: x\n`
  const out = ensurePatchLast(src)
  assertStringIncludes(out, '  patch: |-\n    - op: test\n- path: scaling.yaml\n\n# the images Kargo sets\nimages:')
})

Deno.test('ensurePatchLast creates the key, or fills an empty flow list', () => {
  assertEquals(ensurePatchLast('resources:\n  - ../../base\n'), 'resources:\n  - ../../base\npatches:\n  - path: scaling.yaml\n')
  assertEquals(ensurePatchLast('patches: []\nresources:\n  - x\n'), 'patches:\n  - path: scaling.yaml\nresources:\n  - x\n')
  assertThrows(() => ensurePatchLast('patches: [{path: a.yaml}]\n'))
})

Deno.test('setResource adds and removes the console autoscaler, and only that line', () => {
  const added = setResource(OVERLAY, 'autoscaler.yaml', true)
  assertStringIncludes(added, 'resources:\n  - ../../base\n  - autoscaler.yaml\nimages:')
  assertEquals(setResource(added, 'autoscaler.yaml', true), added)
  assertEquals(setResource(added, 'autoscaler.yaml', false), OVERLAY)
  assertEquals(setResource(OVERLAY, 'autoscaler.yaml', false), OVERLAY)
})

Deno.test('setResource keeps CRLF files CRLF', () => {
  const crlf = OVERLAY.replaceAll('\n', '\r\n')
  const out = setResource(crlf, 'autoscaler.yaml', true)
  assert(!/[^\r]\n/.test(out), 'no bare LF introduced')
})

Deno.test('kustomizeInputs reads resources and flags renames and Helm', () => {
  assertEquals(kustomizeInputs(OVERLAY), { resources: ['../../base'], components: [], renames: false, helm: false })
  assertEquals(kustomizeInputs('namePrefix: x-\nresources:\n  - a.yaml\n').renames, true)
})

Deno.test('resolveRepoPath stays inside the repository and refuses remote bases', () => {
  assertEquals(resolveRepoPath('deploy/envs/test', '../../base'), 'deploy/base')
  assertEquals(resolveRepoPath('deploy/envs/test', './hpa.yaml'), 'deploy/envs/test/hpa.yaml')
  assertEquals(resolveRepoPath('deploy', '../../x'), undefined)
  assertEquals(resolveRepoPath('deploy', 'https://github.com/x/y//base'), undefined)
  assertEquals(resolveRepoPath('deploy', 'github.com/x/y/base?ref=v1'), undefined)
})

/* ─────────── reading manifests ─────────── */

Deno.test('findHpaName finds the autoscaler by name or by its scaleTargetRef', () => {
  assertEquals(findHpaName(BASE_HPA, W), 'demo')
  assertEquals(findHpaName(BASE_HPA.replace('  name: demo\n  labels', '  name: demo-hpa\n  labels'), W), 'demo-hpa')
  assertEquals(findHpaName('kind: HorizontalPodAutoscaler\nmetadata:\n  name: other\nspec:\n  scaleTargetRef: {kind: Rollout, name: other}\n', W), undefined)
  assertEquals(findHpaName(BASE_ROLLOUT, W), undefined)
})

Deno.test('renderedReplicas reads the rendered branch, not a nested replicas', () => {
  const rendered = `apiVersion: v1\nkind: Service\nmetadata:\n  name: demo\n---\napiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata:\n  labels:\n    app: demo\n  name: demo\n  namespace: test\nspec:\n  revisionHistoryLimit: 2\n  replicas: 4\n  selector:\n    matchLabels:\n      app: demo\n`
  assertEquals(renderedReplicas(rendered, W), 4)
  assertEquals(renderedReplicas(rendered, { kind: 'Rollout', name: 'other' }), undefined)
  assertEquals(renderedReplicas(rendered.replace('  replicas: 4\n', ''), W), undefined)
})

/* ─────────── the managed files round-trip ─────────── */

Deno.test('a fixed count with a base autoscaler: replicas + $patch delete, read back as fixed', () => {
  const text = renderPatchFile({ app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 5 }, inputHpa: 'demo' })
  assertStringIncludes(text, 'kind: Rollout\nmetadata:\n  name: demo\nspec:\n  replicas: 5\n')
  assertStringIncludes(text, '$patch: delete')
  const back = readPatchFile(text, W)
  assertEquals(back, { replicas: 5, hpaDeleted: true })
  assertEquals(declaredIntent(back, false), { mode: 'fixed', replicas: 5 })
})

Deno.test('a fixed count without any autoscaler writes no delete (kustomize fails a delete with no target)', () => {
  const text = renderPatchFile({ app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 0 } })
  assert(!text.includes('HorizontalPodAutoscaler'))
  assertEquals(declaredIntent(readPatchFile(text, W), false), { mode: 'fixed', replicas: 0 })
})

Deno.test('autoscaling: bounds and targets in the patch, replicas clamped into them, other metrics kept', () => {
  const keep = [{ type: 'Pods', pods: { metric: { name: 'rps' }, target: { type: 'AverageValue', averageValue: '100' } } }]
  const text = renderPatchFile({ app: 'demo', env: 'prod', workload: W, intent: { mode: 'auto', min: 2, max: 6, cpu: 65, memory: 80 }, inputHpa: 'demo', replicasWhileAuto: 9, keepMetrics: keep })
  assertStringIncludes(text, '  replicas: 6\n')
  assertStringIncludes(text, '  minReplicas: 2\n  maxReplicas: 6\n')
  assertStringIncludes(text, `  - ${JSON.stringify(keep[0])}`)
  const back = readPatchFile(text, W)
  assertEquals(back.hpa, { name: 'demo', min: 2, max: 6, cpu: 65, memory: 80 })
  assertEquals(declaredIntent(back, false), { mode: 'auto', min: 2, max: 6, cpu: 65, memory: 80 })
})

Deno.test('a Deployment workload gets apps/v1', () => {
  const text = renderPatchFile({ app: 'api', env: 'dev', workload: { kind: 'Deployment', name: 'api' }, intent: { mode: 'fixed', replicas: 2 } })
  assertStringIncludes(text, 'apiVersion: apps/v1\nkind: Deployment\n')
  assertThrows(() => renderResourceFile({ app: 'api', env: 'dev', workload: { kind: 'Deployment', name: 'api' }, intent: { mode: 'fixed', replicas: 2 } }))
})

/* ─────────── plans ─────────── */

const overlay = (extra: Partial<Parameters<typeof planFiles>[0]> = {}) => ({
  dir: 'deploy/envs/test',
  kustomization: { path: 'deploy/envs/test/kustomization.yaml', text: OVERLAY, sha: 'k1' },
  ...extra,
})

Deno.test('plan: first change writes the kustomization line and scaling.yaml', () => {
  const files = planFiles(overlay(), { app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 3 }, inputHpa: 'demo' })
  assertEquals(files.map((f) => [f.path, f.before === null, f.after === null, f.sha]), [
    ['deploy/envs/test/kustomization.yaml', false, false, 'k1'],
    ['deploy/envs/test/scaling.yaml', true, false, null],
  ])
})

Deno.test('plan: turning autoscaling on with no autoscaler anywhere adds autoscaler.yaml; off again deletes it', () => {
  const on = planFiles(overlay(), { app: 'demo', env: 'test', workload: W, intent: { mode: 'auto', min: 1, max: 4, cpu: 70 } })
  const kz = on.find((f) => f.path.endsWith('kustomization.yaml'))!.after!
  assertStringIncludes(kz, '  - autoscaler.yaml\n')
  const res = on.find((f) => f.path.endsWith('autoscaler.yaml'))!
  assertStringIncludes(res.after!, 'scaleTargetRef:\n    apiVersion: argoproj.io/v1alpha1\n    kind: Rollout\n    name: demo\n')
  const patch = on.find((f) => f.path.endsWith('scaling.yaml'))!.after!

  const off = planFiles(
    overlay({ kustomization: { path: 'deploy/envs/test/kustomization.yaml', text: kz, sha: 'k2' }, patch: { text: patch, sha: 'p1' }, resource: { text: res.after!, sha: 'r1' } }),
    { app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 2 } },
  )
  assertEquals(off.map((f) => [f.path.split('/').pop(), f.after === null]), [['kustomization.yaml', false], ['scaling.yaml', false], ['autoscaler.yaml', true]])
  assert(!off[0].after!.includes('autoscaler.yaml'))
  assert(!off[1].after!.includes('HorizontalPodAutoscaler'), 'no delete patch: the resource itself goes')
})

Deno.test('plan: no change → no files', () => {
  const kz = ensurePatchLast(OVERLAY)
  const patch = renderPatchFile({ app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 3 }, inputHpa: 'demo' })
  assertEquals(planFiles(overlay({ kustomization: { path: 'k', text: kz, sha: 'k' }, patch: { text: patch, sha: 'p' } }), { app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 3 }, inputHpa: 'demo' }), [])
})

/* ─────────── the real thing: kustomize builds what the console writes ─────────── */

async function kustomizeBin(): Promise<string | undefined> {
  for (const bin of ['kustomize']) {
    try {
      const r = await new Deno.Command(bin, { args: ['version'], stdout: 'null', stderr: 'null' }).output()
      if (r.success) return bin
    } catch {
      // not installed
    }
  }
  return undefined
}

const bin = await kustomizeBin()

async function build(files: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: 'scaling-kz-' })
  try {
    for (const [p, text] of Object.entries(files)) {
      const full = `${dir}/${p}`
      await Deno.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true })
      await Deno.writeTextFile(full, text)
    }
    const r = await new Deno.Command(bin!, { args: ['build', `${dir}/deploy/envs/test`] }).output()
    return { ok: r.success, out: new TextDecoder().decode(r.success ? r.stdout : r.stderr) }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

function apply(base: Record<string, string>, files: ReturnType<typeof planFiles>): Record<string, string> {
  const out = { ...base }
  for (const f of files) {
    if (f.after === null) delete out[f.path]
    else out[f.path] = f.after
  }
  return out
}

const REPO = (withHpa: boolean): Record<string, string> => ({
  'deploy/base/kustomization.yaml': withHpa ? BASE_KZ : BASE_KZ.replace('  - hpa.yaml\n', ''),
  'deploy/base/rollout.yaml': BASE_ROLLOUT,
  'deploy/base/service.yaml': BASE_SERVICE,
  ...(withHpa ? { 'deploy/base/hpa.yaml': BASE_HPA } : {}),
  'deploy/envs/test/kustomization.yaml': OVERLAY,
})

const ov = (repo: Record<string, string>) => ({
  dir: 'deploy/envs/test',
  kustomization: { path: 'deploy/envs/test/kustomization.yaml', text: repo['deploy/envs/test/kustomization.yaml'], sha: 'k' },
  ...(repo['deploy/envs/test/scaling.yaml'] ? { patch: { text: repo['deploy/envs/test/scaling.yaml'], sha: 'p' } } : {}),
  ...(repo['deploy/envs/test/autoscaler.yaml'] ? { resource: { text: repo['deploy/envs/test/autoscaler.yaml'], sha: 'r' } } : {}),
})

Deno.test({
  name: 'kustomize: fixed count overrides the inline replica patch and removes the base autoscaler',
  ignore: !bin,
  async fn() {
    const repo = REPO(true)
    const r = await build(apply(repo, planFiles(ov(repo), { app: 'demo', env: 'test', workload: W, intent: { mode: 'fixed', replicas: 5 }, inputHpa: 'demo' })))
    assert(r.ok, r.out)
    assertEquals(renderedReplicas(r.out, W), 5)
    assert(!r.out.includes('kind: HorizontalPodAutoscaler'), r.out)
  },
})

Deno.test({
  name: 'kustomize: autoscaling bounds override the inline minReplicas patch',
  ignore: !bin,
  async fn() {
    const repo = REPO(true)
    const r = await build(apply(repo, planFiles(ov(repo), { app: 'demo', env: 'test', workload: W, intent: { mode: 'auto', min: 3, max: 9, cpu: 55 }, inputHpa: 'demo', replicasWhileAuto: 2 })))
    assert(r.ok, r.out)
    assertStringIncludes(r.out, 'maxReplicas: 9')
    assertStringIncludes(r.out, 'minReplicas: 3')
    assertStringIncludes(r.out, 'averageUtilization: 55')
    assertEquals(renderedReplicas(r.out, W), 3)
  },
})

Deno.test({
  name: 'kustomize: on → off → on without a base autoscaler builds every time',
  ignore: !bin,
  async fn() {
    let repo = REPO(false)
    const steps = [
      { mode: 'auto', min: 2, max: 5, cpu: 70 },
      { mode: 'fixed', replicas: 1 },
      { mode: 'auto', min: 1, max: 3, memory: 75 },
    ] as const
    for (const intent of steps) {
      repo = apply(repo, planFiles(ov(repo), { app: 'demo', env: 'test', workload: W, intent }))
      const r = await build(repo)
      assert(r.ok, `${JSON.stringify(intent)}: ${r.out}`)
      assertEquals(r.out.includes('kind: HorizontalPodAutoscaler'), intent.mode === 'auto', JSON.stringify(intent))
      if (intent.mode === 'auto') assertStringIncludes(r.out, `minReplicas: ${intent.min}`)
      else assertEquals(renderedReplicas(r.out, W), intent.replicas)
    }
  },
})
