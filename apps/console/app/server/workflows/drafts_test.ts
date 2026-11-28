import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { parse, parseAllDocuments } from 'yaml'
import { DRAFT_EXPIRES_ANNOTATION, DRAFT_LABEL, draftExpiry, draftName, draftSlug, MAX_DRAFT_BYTES, parseTestRun, stampDraft, testRunManifest } from './drafts.ts'

/**
 * The draft a test run applies (design 0026 §4.5, §6.4; Kyverno #7): its name,
 * namespace, label and expiry are the server's, and nothing else in the text
 * changes its meaning — read the way the API server reads it (YAML 1.1).
 */

const NOW = Date.parse('2026-11-28T10:00:00Z')
const opts = { namespace: 'shop-dev', kubeUser: 'oidc:ana@x.io', expires: draftExpiry(NOW) }

const WT = `# nightly clean-up
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: nightly # the GitOps name
spec:
  entrypoint: main
  templates:
    - name: main
      container:
        image: docker.io/library/busybox:1.37
        args: ["echo", "{{workflow.name}}"]
`

/** The object the API server would build from this text: YAML 1.1 (octal 0644, yes/no booleans, merge keys). */
const as11 = (text: string) => parse(text, { version: '1.1', merge: true }) as Record<string, any>

function stamped(text: string, o = opts) {
  const r = stampDraft(text, o)
  assert(r.ok, r.ok ? '' : r.detail)
  return r.value
}

Deno.test('a draft expires seven days on, RFC 3339 to the second', () => {
  assertEquals(draftExpiry(NOW), '2026-12-05T10:00:00Z')
  assertEquals(draftExpiry(Date.parse('2026-11-28T10:00:00.999Z')), '2026-12-05T10:00:00Z')
})

Deno.test('the draft name is <name>-draft-<user>, a DNS label, and never doubles', () => {
  assertEquals(draftSlug('oidc:ana@x.io'), 'ana-x-io')
  assertEquals(draftSlug('oidc:Ana.B_C@Example.COM'), 'ana-b-c-example-com')
  assertEquals(draftSlug('system:serviceaccount:adhar-system:argo'), 'serviceaccount-adhar-sys')
  assertEquals(draftSlug('oidc:--'), 'user')
  assertEquals(draftName('nightly', 'ana-x-io'), 'nightly-draft-ana-x-io')
  // Opening one's own draft and running it again keeps the name.
  assertEquals(draftName('nightly-draft-ana-x-io', 'ana-x-io'), 'nightly-draft-ana-x-io')
  // Somebody else's draft becomes mine, not a draft of a draft.
  assertEquals(draftName('nightly-draft-bob', 'ana-x-io'), 'nightly-draft-ana-x-io')
  const long = draftName('a'.repeat(80), draftSlug(`oidc:${'x'.repeat(80)}`))
  assert(long.length <= 63, long)
  assert(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(long), long)
  assertStringIncludes(long, '-draft-')
  assertEquals(draftName('nightly.-', 'u').startsWith('nightly'), true)
})

Deno.test('stamping writes the name, namespace, label and expiry — and they are strings to the API server', () => {
  const s = stamped(WT)
  assertEquals(s.name, 'nightly-draft-ana-x-io')
  assertEquals(s.base, 'nightly')
  const o = as11(s.yaml)
  assertEquals(o.metadata.name, 'nightly-draft-ana-x-io')
  assertEquals(o.metadata.namespace, 'shop-dev')
  // Under YAML 1.1 an unquoted true is a boolean and a timestamp a Date: a label must be neither.
  assertEquals(o.metadata.labels[DRAFT_LABEL], 'true')
  assertEquals(o.metadata.annotations[DRAFT_EXPIRES_ANNOTATION], '2026-12-05T10:00:00Z')
  assertStringIncludes(s.yaml, `${DRAFT_LABEL}: "true"`)
  // Comments survive (the draft is what the author wrote).
  assertStringIncludes(s.yaml, '# nightly clean-up')
})

Deno.test('a namespace YAML 1.1 would read as a number or a boolean is still a string to the API server', () => {
  // All valid DNS labels. Written plain under the failsafe schema they became
  // 1234, true, true, 31 and 1000, and the apply failed on metadata.namespace.
  for (const ns of ['1234', 'yes', 'on', '0x1f', '1e3', 'no']) {
    const s = stamped(WT, { ...opts, namespace: ns })
    assertEquals(as11(s.yaml).metadata.namespace, ns, s.yaml)
  }
  // An ordinary name is not quoted for nothing.
  assertStringIncludes(stamped(WT).yaml, '  namespace: shop-dev\n')
})

Deno.test('whatever the browser sent, the draft fields are the server\'s', () => {
  const sent = WT.replace('  name: nightly # the GitOps name', `  name: nightly
  namespace: shop-dev
  labels:
    adhar.io/workflow-draft: "yes"
    adhar.io/team: shop
  annotations:
    adhar.io/draft-expires: "2099-01-01T00:00:00Z"
    adhar.io/designer-positions: '{"a":[1,2]}'`)
  const o = as11(stamped(sent).yaml)
  assertEquals(o.metadata.labels, { [DRAFT_LABEL]: 'true', 'adhar.io/team': 'shop' })
  assertEquals(o.metadata.annotations[DRAFT_EXPIRES_ANNOTATION], '2026-12-05T10:00:00Z')
  assertEquals(o.metadata.annotations['adhar.io/designer-positions'], '{"a":[1,2]}')
})

Deno.test('scalars keep the meaning the API server gives them (YAML 1.1): octal modes, yes/no, empty values, quotes', () => {
  const tricky = `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: tricky
  labels:
spec:
  entrypoint: main
  podGC: ~
  arguments:
    parameters:
      - {name: flag, value: "yes"}
      - {name: version, value: "1.10"}
      - name: when
        value: 2026-01-01
  templates:
    - name: main
      volumes:
        - name: scratch
          emptyDir:
        - name: cfg
          configMap:
            name: cfg
            defaultMode: 0644
            optional: yes
      script:
        image: docker.io/library/bash:5.2
        source: |
          set -euo pipefail
          echo "{{inputs.parameters.flag}}"   # not a comment to YAML
        resources: &small
          requests: {cpu: 100m, memory: 128Mi}
    - name: other
      container:
        image: 'docker.io/library/busybox:1.37'
        resources: *small
        securityContext:
          runAsUser: 065532
          privileged: off
`
  const before = as11(tricky)
  const after = as11(stamped(tricky).yaml)
  // What the API server reads.
  assertEquals(before.spec.templates[0].volumes[1].configMap.defaultMode, 420)
  assertEquals(before.spec.templates[0].volumes[1].configMap.optional, true)
  // Only the draft fields differ.
  after.metadata = { name: before.metadata.name, labels: before.metadata.labels }
  assertEquals(after, before)
})

Deno.test('every WorkflowTemplate in the designer corpus keeps its YAML 1.1 meaning when stamped', async () => {
  const corpus = new URL('../../../../../modules/platform/src/workflows/model/corpus/', import.meta.url)
  let checked = 0
  for (const dir of ['upstream/', 'platform/', 'handwritten/']) {
    for await (const f of Deno.readDir(new URL(dir, corpus))) {
      if (!f.isFile || !/\.ya?ml$/.test(f.name)) continue
      const text = await Deno.readTextFile(new URL(dir + f.name, corpus))
      const docs = parseAllDocuments(text, { version: '1.1', merge: true, logLevel: 'silent' }) as unknown as Array<{ contents: unknown; errors: unknown[]; toJS(): any }>
      if (docs.length !== 1 || docs[0].errors.length) continue
      const before = docs[0].toJS()
      if (before?.kind !== 'WorkflowTemplate' || typeof before?.metadata?.name !== 'string' || before.metadata.generateName) continue
      const r = stampDraft(text, { ...opts, namespace: before.metadata.namespace ?? 'shop-dev' })
      assert(r.ok, `${dir}${f.name}: ${r.ok ? '' : r.detail}`)
      const after = as11(r.value.yaml)
      assertEquals(after.metadata.labels[DRAFT_LABEL], 'true', f.name)
      delete after.metadata.labels[DRAFT_LABEL]
      delete after.metadata.annotations[DRAFT_EXPIRES_ANNOTATION]
      for (const k of ['labels', 'annotations'] as const) {
        if (!Object.keys(after.metadata[k]).length && !before.metadata[k]) delete after.metadata[k]
      }
      after.metadata.name = before.metadata.name
      if (before.metadata.namespace === undefined) delete after.metadata.namespace
      assertEquals(after, before, `${dir}${f.name}`)
      checked++
    }
  }
  assert(checked >= 8, `only ${checked} WorkflowTemplates checked: the corpus moved?`)
})

Deno.test('what is not exactly one WorkflowTemplate in this namespace is refused, never repaired', () => {
  const refuse = (text: string, why: RegExp) => {
    const r = stampDraft(text, opts)
    assert(!r.ok, `accepted: ${text.slice(0, 60)}`)
    assert(why.test(r.detail), r.detail)
  }
  refuse('', /empty/)
  refuse('# only a comment\n', /empty/)
  refuse(`${WT}---\n${WT}`, /several documents/)
  refuse(WT.replace('spec:', 'spec: [unclosed'), /does not parse/)
  refuse(WT.replace('kind: WorkflowTemplate', 'kind: ClusterWorkflowTemplate'), /not a ClusterWorkflowTemplate/)
  refuse(WT.replace('kind: WorkflowTemplate', 'kind: Workflow'), /not a Workflow/)
  refuse(WT.replace('argoproj.io/v1alpha1', 'v1'), /apiVersion/)
  refuse(WT.replace('  name: nightly # the GitOps name', '  generateName: nightly-'), /name/)
  refuse(WT.replace('  name: nightly # the GitOps name', '  name: nightly\n  generateName: x-'), /generateName/)
  refuse(WT.replace('  name: nightly # the GitOps name', '  name: Not_A_Name'), /valid name/)
  refuse(WT.replace('  name: nightly # the GitOps name', '  name: nightly\n  namespace: shop-prod'), /shop-prod.*not shop-dev/)
  refuse(WT.replace('  name: nightly # the GitOps name', '  name: nightly\n  labels: *x'), /parse|written out/)
  refuse('- a\n- b\n', /not a Kubernetes object/)
})

Deno.test('the request body: YAML text, parameters, an optional dry run', () => {
  const ok = parseTestRun({ yaml: WT, parameters: { env: 'dev', flag: '' }, dryRun: true })
  assert(ok.ok)
  assertEquals(ok.value.parameters, [{ name: 'env', value: 'dev' }, { name: 'flag', value: '' }])
  assertEquals(ok.value.dryRun, true)
  assertEquals(parseTestRun({ yaml: WT }).ok && (parseTestRun({ yaml: WT }) as any).value.dryRun, false)
  assertEquals((parseTestRun({ yaml: WT, parameters: ['a=b=c'] }) as any).value.parameters, [{ name: 'a', value: 'b=c' }])
  for (const badBody of [null, [], {}, { yaml: 7 }, { yaml: '   ' }, { yaml: WT, dryRun: 'yes' }, { yaml: WT, parameters: { 'bad name': 'x' } }, { yaml: WT, parameters: { a: 1 } }, { yaml: 'x'.repeat(MAX_DRAFT_BYTES + 1) }, { manifest: { kind: 'WorkflowTemplate' } }]) {
    assert(!parseTestRun(badBody).ok, JSON.stringify(badBody)?.slice(0, 80))
  }
})

Deno.test('the run a test run starts references the draft and names no service account', () => {
  const m = testRunManifest('shop-dev', 'nightly-draft-ana-x-io', [{ name: 'env', value: 'dev' }])
  assertEquals(m, {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: { generateName: 'nightly-draft-ana-x-io-', namespace: 'shop-dev', labels: { 'workflows.argoproj.io/workflow-template': 'nightly-draft-ana-x-io' } },
    spec: { workflowTemplateRef: { name: 'nightly-draft-ana-x-io' }, arguments: { parameters: [{ name: 'env', value: 'dev' }] } },
  })
  assert(!JSON.stringify(testRunManifest('shop-dev', 'd', [])).includes('arguments'))
  assert(!JSON.stringify(m).toLowerCase().includes('serviceaccount'))
})
