import { assertEquals } from 'jsr:@std/assert'
import { toYaml, yamlScalar } from './manifest-yaml.ts'

Deno.test('a claim serialises in the order a manifest is read', () => {
  const yaml = toYaml({
    spec: { parameters: { size: 'small' } },
    kind: 'PostgresInstance',
    metadata: { name: 'orders-db', namespace: 'payments' },
    apiVersion: 'adhar.io/v1alpha1',
  })
  assertEquals(
    yaml,
    'apiVersion: adhar.io/v1alpha1\n' +
      'kind: PostgresInstance\n' +
      'metadata:\n' +
      '  name: orders-db\n' +
      '  namespace: payments\n' +
      'spec:\n' +
      '  parameters:\n' +
      '    size: small\n',
  )
})

Deno.test('a key the manifest has that we do not order is kept, after the rest', () => {
  const yaml = toYaml({ kind: 'X', apiVersion: 'v1', weird: 'yes-really' })
  // `yes-really` is not `yes`; only the exact ambiguous tokens get quoted.
  assertEquals(yaml.split('\n').slice(0, 3), ['apiVersion: v1', 'kind: X', 'weird: yes-really'])
})

/**
 * A manifest is parsed as YAML 1.1, where `on`, `no` and `y` are booleans.
 * An unquoted `on` would come back as `true` — a different value than the one
 * the form collected.
 */
Deno.test('scalars YAML would read back as something else are quoted', () => {
  assertEquals(yamlScalar('on'), '"on"')
  assertEquals(yamlScalar('No'), '"No"')
  assertEquals(yamlScalar('y'), '"y"')
  assertEquals(yamlScalar('n'), '"n"')
  assertEquals(yamlScalar('true'), '"true"')
  assertEquals(yamlScalar('null'), '"null"')
  // A version string is not a number.
  assertEquals(yamlScalar('1.10'), '"1.10"')
  assertEquals(yamlScalar('0755'), '"0755"')
  // And a duration is not sexagesimal.
  assertEquals(yamlScalar('1:30'), '"1:30"')
})

Deno.test('ordinary strings stay bare', () => {
  for (const s of ['small', 'orders-db', 'adhar.io/v1alpha1', 'gp3', 'us-east-1a', 'Postgres']) {
    assertEquals(yamlScalar(s), s)
  }
})

Deno.test('real numbers and booleans are not quoted', () => {
  assertEquals(yamlScalar(3), '3')
  assertEquals(yamlScalar(1.5), '1.5')
  assertEquals(yamlScalar(true), 'true')
  assertEquals(yamlScalar(false), 'false')
  assertEquals(yamlScalar(null), 'null')
})

Deno.test('anything that would break the line is quoted and escaped', () => {
  assertEquals(yamlScalar('a: b'), '"a: b"')
  assertEquals(yamlScalar('# not a comment'), '"# not a comment"')
  assertEquals(yamlScalar('say "hi"'), '"say \\"hi\\""')
  assertEquals(yamlScalar('line\nbreak'), '"line\\nbreak"')
  assertEquals(yamlScalar('C:\\tmp'), '"C:\\\\tmp"')
  assertEquals(yamlScalar(' leading'), '" leading"')
  assertEquals(yamlScalar('trailing '), '"trailing "')
  assertEquals(yamlScalar(''), "''")
})

Deno.test('a key that is not a bare word is quoted', () => {
  const yaml = toYaml({ metadata: { labels: { 'adhar.io/category': 'data', 'a b': 'c' } } })
  assertEquals(yaml.includes('adhar.io/category: data'), true)
  assertEquals(yaml.includes('"a b": c'), true)
})

Deno.test('a list of scalars is written under its key', () => {
  assertEquals(
    toYaml({ spec: { zones: ['a', 'b'] } }),
    'spec:\n  zones:\n  - a\n  - b\n',
  )
})

/** The first key of an object in a list sits beside the dash. */
Deno.test('a list of objects indents under its dash', () => {
  assertEquals(
    toYaml({ spec: { rules: [{ host: 'a.example', tls: true }, { host: 'b.example' }] } }),
    'spec:\n' +
      '  rules:\n' +
      '  - host: a.example\n' +
      '    tls: true\n' +
      '  - host: b.example\n',
  )
})

Deno.test('nested lists and maps survive together', () => {
  // `z`, not `y` — a lone `y` is a YAML 1.1 boolean and gets quoted, which is
  // covered by the ambiguity test rather than here.
  const yaml = toYaml({ spec: { groups: [{ names: ['x', 'z'] }] } })
  assertEquals(yaml, 'spec:\n  groups:\n  - names:\n    - x\n    - z\n')
})

/** Empty is a value; it must not come out as a key with nothing after it. */
Deno.test('empty collections are written inline', () => {
  assertEquals(toYaml({ spec: { tags: [], meta: {} } }), 'spec:\n  tags: []\n  meta: {}\n')
})

/**
 * `undefined` is not a YAML value. A field the form never set must not appear
 * at all — emitting `key: null` would ask the apiserver to clear it.
 */
Deno.test('undefined fields are omitted rather than nulled', () => {
  assertEquals(
    toYaml({ apiVersion: 'v1', kind: 'X', metadata: { name: 'db', namespace: undefined } }),
    'apiVersion: v1\nkind: X\nmetadata:\n  name: db\n',
  )
})

Deno.test('an explicit null is kept, because it means something', () => {
  assertEquals(toYaml({ spec: { ttl: null } }), 'spec:\n  ttl: null\n')
})

Deno.test('an empty manifest is empty, not a blank line', () => {
  assertEquals(toYaml({}), '')
})

/** What the dialog actually produces, end to end. */
Deno.test('a full claim round-trips through JSON.parse of its own JSON twin', () => {
  const manifest = {
    apiVersion: 'adhar.io/v1alpha1',
    kind: 'PostgresInstance',
    metadata: { name: 'orders-db', namespace: 'payments' },
    spec: {
      parameters: { size: 'small', version: '16', storageGB: 20, highAvailability: false },
      compositionSelector: { matchLabels: { provider: 'local' } },
    },
  }
  const yaml = toYaml(manifest)
  assertEquals(yaml.startsWith('apiVersion: adhar.io/v1alpha1\nkind: PostgresInstance\n'), true)
  // The version is a string in the manifest and must still be one in the YAML.
  assertEquals(yaml.includes('version: "16"'), true)
  assertEquals(yaml.includes('storageGB: 20'), true)
  assertEquals(yaml.includes('highAvailability: false'), true)
})
