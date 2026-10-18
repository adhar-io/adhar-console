import { assert, assertEquals } from 'jsr:@std/assert@1'
import { parseYaml } from '@adhar/utils'
import { hasServerNoise, LAST_APPLIED, stripServerNoise, toJson, toJsonWithPaths, toYaml, toYamlWithPaths, yamlScalar } from './k8s-yaml.ts'

Deno.test('manifest key order and identity-first metadata', () => {
  const y = toYaml({ status: { phase: 'Running' }, spec: { replicas: 2 }, metadata: { labels: { a: 'b' }, namespace: 'ns', name: 'x' }, kind: 'Deployment', apiVersion: 'apps/v1' })
  assertEquals(
    y,
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: x',
      '  namespace: ns',
      '  labels:',
      '    a: b',
      'spec:',
      '  replicas: 2',
      'status:',
      '  phase: Running',
      '',
    ].join('\n'),
  )
})

Deno.test('ambiguous scalars are quoted, plain ones are not', () => {
  for (const s of ['on', 'no', 'Yes', '1.10', '1:30', '0x1F', '~', 'null', '', '-dash', 'a: b', '#c', ' lead', 'trail ', '.5', '1e3']) {
    assert(yamlScalar(s).startsWith('"') || yamlScalar(s) === "''", `${JSON.stringify(s)} → ${yamlScalar(s)}`)
  }
  for (const s of ['hello', 'ghcr.io/adhar/console:v1', 'orders-db', 'a b']) assertEquals(yamlScalar(s), s)
  assertEquals(yamlScalar(3), '3')
  assertEquals(yamlScalar(true), 'true')
  assertEquals(yamlScalar(null), 'null')
})

Deno.test('multi-line strings become literal blocks with the right chomping', () => {
  assertEquals(toYaml({ a: 'x\ny' }), 'a: |-\n  x\n  y\n')
  assertEquals(toYaml({ a: 'x\ny\n' }), 'a: |\n  x\n  y\n')
  assertEquals(toYaml({ a: ['line1\nline2'] }), 'a:\n- |-\n  line1\n  line2\n')
  assertEquals(toYaml({ a: '  indented\nnext' }), 'a: |2-\n    indented\n  next\n')
  // carriage returns cannot live in a block: quoted instead
  assertEquals(toYaml({ a: 'x\r\ny' }), 'a: "x\\r\\ny"\n')
})

Deno.test('empty collections, nested sequences of maps', () => {
  assertEquals(toYaml({ a: [], b: {}, c: [{ name: 'x', v: 1 }, { name: 'z' }], d: [[1, 2]] }), [
    'a: []',
    'b: {}',
    'c:',
    '- name: x',
    '  v: 1',
    '- name: z',
    'd:',
    '- - 1',
    '  - 2',
    '',
  ].join('\n'))
})

Deno.test('round-trips through the repo YAML reader', () => {
  const doc = {
    apiVersion: 'platform.adhar.io/v1alpha1',
    kind: 'Application',
    metadata: { name: 'orders', labels: { 'adhar.io/application': 'orders', version: '1.10', enabled: 'on' } },
    spec: {
      parameters: { replicas: 3, debug: false, source: { repoURL: 'https://git/x.git', path: 'deploy' }, script: 'echo a\necho b' },
      list: ['a', 'b: c', { k: 'v' }],
    },
  }
  assertEquals(parseYaml(toYaml(doc)), doc)
})

Deno.test('managedFields and last-applied are stripped without mutating', () => {
  const o = { metadata: { name: 'x', managedFields: [{ manager: 'kubectl' }], annotations: { [LAST_APPLIED]: '{}' } }, spec: {} }
  assert(hasServerNoise(o))
  const s: unknown = stripServerNoise(o)
  assertEquals(s, { metadata: { name: 'x' }, spec: {} })
  assert(!hasServerNoise(s))
  assertEquals(o.metadata.managedFields.length, 1)
  const keep: { metadata: { annotations?: unknown } } = stripServerNoise({ metadata: { name: 'x', annotations: { [LAST_APPLIED]: '{}', other: 'y' } } })
  assertEquals(keep.metadata.annotations, { other: 'y' })
  assertEquals(toJson({ a: 1 }), '{\n  "a": 1\n}\n')
})

Deno.test('every emitted line knows its path (YAML and JSON)', () => {
  const obj = {
    kind: 'Deployment',
    metadata: { name: 'x', labels: { 'app.kubernetes.io/name': 'x' } },
    spec: { template: { spec: { containers: [{ name: 'app', image: 'ghcr.io/x:1', args: ['a', 'b'] }] } }, script: 'l1\nl2' },
  }
  const y = toYamlWithPaths(obj)
  const at = (text: string, paths: string[], needle: string) => paths[text.split('\n').findIndex((l) => l.includes(needle))]
  assertEquals(y.text.split('\n').length - 1, y.paths.length)
  assertEquals(at(y.text, y.paths, 'image:'), '.spec.template.spec.containers[0].image')
  assertEquals(at(y.text, y.paths, '- name: app'), '.spec.template.spec.containers[0].name')
  assertEquals(at(y.text, y.paths, '- b'), '.spec.template.spec.containers[0].args[1]')
  assertEquals(at(y.text, y.paths, 'app.kubernetes.io/name'), '.metadata.labels["app.kubernetes.io/name"]')
  assertEquals(at(y.text, y.paths, '  l2'), '.spec.script')
  assertEquals(y.text, toYaml(obj))
  const j = toJsonWithPaths(obj)
  assertEquals(j.text, `${JSON.stringify({ kind: obj.kind, metadata: obj.metadata, spec: obj.spec }, null, 2)}\n`)
  assertEquals(at(j.text, j.paths, '"image"'), '.spec.template.spec.containers[0].image')
  assertEquals(at(j.text, j.paths, '"b"'), '.spec.template.spec.containers[0].args[1]')
  assertEquals(j.paths.length, j.text.split('\n').length - 1)
})
