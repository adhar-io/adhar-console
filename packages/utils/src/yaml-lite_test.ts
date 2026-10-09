import { assertEquals } from 'jsr:@std/assert'
import { parseYaml, tryParseYaml } from './yaml-lite.ts'

/**
 * This parser used to live server-side, reading template files that a human
 * had committed and a human would notice were wrong. It now also reads the
 * provisioning dialog's editable YAML pane, where the result is applied to a
 * cluster — so the shapes a Kubernetes manifest actually contains are tested
 * here, and so is the difference between "unreadable" and "null".
 */

Deno.test('a claim manifest reads back with its nesting intact', () => {
  const doc = `apiVersion: platform.adhar.io/v1alpha1
kind: Database
metadata:
  name: orders-db
  namespace: default
spec:
  parameters:
    engine: postgres
    version: "16"
    storageGB: 20
    highlyAvailable: true
`
  assertEquals(parseYaml(doc), {
    apiVersion: 'platform.adhar.io/v1alpha1',
    kind: 'Database',
    metadata: { name: 'orders-db', namespace: 'default' },
    spec: {
      parameters: {
        engine: 'postgres',
        // Quoted, so it stays a string — an unquoted 16 would be a number and
        // the apiserver would reject it against a string-typed field.
        version: '16',
        storageGB: 20,
        highlyAvailable: true,
      },
    },
  })
})

Deno.test('a list of mappings keeps each entry separate', () => {
  const doc = `spec:
  rules:
    - host: a.example.com
      port: 80
    - host: b.example.com
      port: 443
`
  assertEquals(parseYaml(doc), {
    spec: { rules: [{ host: 'a.example.com', port: 80 }, { host: 'b.example.com', port: 443 }] },
  })
})

/** `matchLabels: {provider: local}` is how a compositionSelector is written. */
Deno.test('a flow mapping is read as a mapping, not as a string', () => {
  assertEquals(parseYaml('compositionSelector:\n  matchLabels: {provider: local, tier: gold}\n'), {
    compositionSelector: { matchLabels: { provider: 'local', tier: 'gold' } },
  })
})

Deno.test('a sequence may sit at its key’s own indent', () => {
  // Both of these are valid YAML and both appear in real manifests.
  const flush = parseYaml('items:\n- a\n- b\n')
  const indented = parseYaml('items:\n  - a\n  - b\n')
  assertEquals(flush, { items: ['a', 'b'] })
  assertEquals(flush, indented)
})

Deno.test('scalar types survive: numbers, booleans, null and empty', () => {
  assertEquals(parseYaml('a: 3\nb: 3.5\nc: -2\nd: true\ne: false\nf: null\ng: ~\n'), {
    a: 3,
    b: 3.5,
    c: -2,
    d: true,
    e: false,
    f: null,
    g: null,
  })
})

Deno.test('a quoted number stays a string', () => {
  assertEquals(parseYaml('version: "16"\ntag: \'1.2\'\n'), { version: '16', tag: '1.2' })
})

Deno.test('comments and blank lines are not content', () => {
  assertEquals(parseYaml('# leading\nkind: Bucket\n\n  # indented\nname: x\n'), {
    kind: 'Bucket',
    name: 'x',
  })
})

Deno.test('a value containing a colon is not split at it', () => {
  assertEquals(parseYaml('image: registry.io/app:1.2.3\n'), { image: 'registry.io/app:1.2.3' })
})

Deno.test('an empty flow collection is empty, not null', () => {
  assertEquals(parseYaml('a: []\nb: {}\n'), { a: [], b: {} })
})

/* ── the difference between "unreadable" and "null" ── */

Deno.test('an empty document is refused rather than read as null', () => {
  const r = tryParseYaml('   \n\n')
  assertEquals(r.ok, false)
  assertEquals(parseYaml('   \n\n'), null)
})

/**
 * A tab in the indentation is invalid YAML and the commonest way a hand-edited
 * manifest breaks. Scanning it as content would nest the document wrongly and
 * apply something the author never wrote.
 */
Deno.test('a tab-indented line is refused, and the message says which line', () => {
  const r = tryParseYaml('spec:\n\tname: x\n')
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error, 'Line 2: YAML cannot be indented with tabs')
})

Deno.test('a tab INSIDE a value is content, not an indentation error', () => {
  const r = tryParseYaml('note: "a\tb"\n')
  assertEquals(r.ok, true)
})

Deno.test('a readable document reports ok with its value', () => {
  const r = tryParseYaml('kind: Cache\n')
  assertEquals(r.ok, true)
  if (r.ok) assertEquals(r.value, { kind: 'Cache' })
})
