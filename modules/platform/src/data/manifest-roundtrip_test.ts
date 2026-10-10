import { assertEquals } from 'jsr:@std/assert'
import { tryParseYaml } from '@adhar/utils'
import { toYaml } from './manifest-yaml.ts'

/**
 * The provisioning dialog's YAML pane is editable, which means the manifest
 * makes a round trip: the form builds an object, `toYaml` writes it, the
 * person edits the text, and the parser reads it back before it is applied.
 *
 * `yaml-view.tsx` argued against ever doing this — "a subtle mis-parse there
 * is a wrong database, not a wrong pixel". That argument is right, and this
 * file is the answer to it: for everything the serialiser can emit, reading it
 * back must produce the object it started from. A property that holds here is
 * what makes the editable pane safe; the server-side dry run is the second
 * line, not the first.
 */

function roundTrips(label: string, value: Record<string, unknown>) {
  Deno.test(`round trip: ${label}`, () => {
    const text = toYaml(value)
    const back = tryParseYaml(text)
    assertEquals(back.ok, true, `could not parse:\n${text}`)
    if (back.ok) assertEquals(back.value, value, `mismatch for:\n${text}`)
  })
}

roundTrips('a complete claim', {
  apiVersion: 'platform.adhar.io/v1alpha1',
  kind: 'Database',
  metadata: { name: 'orders-db', namespace: 'default' },
  spec: {
    parameters: { engine: 'postgres', version: '16', storageGB: 20, highlyAvailable: true },
    compositionSelector: { matchLabels: { provider: 'local' } },
  },
})

roundTrips('nested objects several levels down', {
  spec: { a: { b: { c: { d: 'deep' } } } },
})

roundTrips('a list of mappings', {
  spec: { rules: [{ host: 'a.example.com', port: 80 }, { host: 'b.example.com', port: 443 }] },
})

roundTrips('a list of scalars', { spec: { zones: ['eu-west-1a', 'eu-west-1b'] } })

roundTrips('empty collections', { spec: { tags: [], labels: {} } })

roundTrips('every scalar type', {
  spec: { int: 7, negative: -3, float: 1.5, yes: true, no: false, nothing: null },
})

/**
 * The serialiser quotes these on purpose: unquoted they come back as booleans
 * or numbers under YAML 1.1 and the claim silently changes meaning. The round
 * trip is what proves the quoting actually achieves that.
 */
roundTrips('scalars that look like other types', {
  spec: {
    on: 'on',
    no: 'no',
    y: 'y',
    version: '1.10',
    time: '1:30',
    zero: '0',
    empty: '',
    nullish: 'null',
  },
})

roundTrips('strings needing quotes', {
  spec: {
    image: 'registry.io/app:1.2.3',
    hash: '#notacomment',
    braces: '{not: flow}',
    quoted: 'he said "hi"',
    dashed: '- leading dash',
    trailing: 'trailing space ',
  },
})

roundTrips('keys that are not plain identifiers', {
  metadata: {
    annotations: {
      'adhar.io/owner': 'team-platform',
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
    },
  },
})

roundTrips('a multi-line string', { spec: { script: 'line one\nline two\nline three' } })

roundTrips('unicode and emoji survive', { spec: { label: 'café — 日本語 🚀' } })

/**
 * The placeholder the dialog shows before the name is typed. It round-trips
 * because `<name>` is quoted — unquoted, `<` starts no YAML construct but the
 * value would still be fragile.
 */
roundTrips('the unfilled-name placeholder', {
  apiVersion: 'platform.adhar.io/v1alpha1',
  kind: 'Bucket',
  metadata: { name: '<name>', namespace: '<namespace>' },
  spec: {},
})
