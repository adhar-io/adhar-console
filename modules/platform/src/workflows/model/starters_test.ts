import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { commentsOf, parse, toJS } from './doc.ts'
import { applyOp } from './ops.ts'
import { project } from './project.ts'
import { instantiate, STARTERS, starters } from './starters.ts'
import { platformCatalogue } from './testdata.ts'

/** §6.6: a starter is a file somebody could have written. Each one opens, edits and validates like any other. */

const opts = { catalogue: platformCatalogue() }

Deno.test('the gallery holds the starters the design lists, gated by capability', () => {
  assertEquals(STARTERS.map((s) => s.id), ['blank', 'nightly-maintenance', 'approval-gated-release', 'fan-out', 'etl-quality-gate', 'smoke-after-promotion', 'gameday-launcher', 'batch-pipeline'])
  assertEquals(new Set(STARTERS.map((s) => s.id)).size, STARTERS.length)
  const plain = starters().map((s) => s.id)
  assert(!plain.includes('batch-pipeline') && !plain.includes('gameday-launcher'))
  assert(starters({ batch: true }).some((s) => s.id === 'batch-pipeline'))
  assert(starters({ gamedays: true }).some((s) => s.id === 'gameday-launcher'))
})

for (const s of STARTERS) {
  Deno.test(`starter ${s.id} opens editable with no errors and no warnings`, () => {
    const d = parse(s.yaml)
    assertEquals(d.errors, [])
    assertEquals((toJS(d) as { kind: string }).kind, s.kind)
    const g = project(d, opts)
    assert(g.editable, `${s.id} is ${g.readOnly}`)
    assert(g.nodes.length > 0)
    assertEquals(g.diagnostics.filter((x) => x.level !== 'info').map((x) => `${x.code}: ${x.message}`), [])
    assert(g.nodes.every((n) => n.kind !== 'unknown'), JSON.stringify(g.nodes.map((n) => [n.id, n.kind])))
    // It takes an edit like any other document.
    const r = applyOp(d, { op: 'addNode', palette: 'timer' }, opts)
    assert(project(r.doc, opts).nodes.some((n) => n.uid === r.created!.uid))
  })
}

Deno.test('instantiate sets the name and namespace and nothing else', () => {
  const s = STARTERS.find((x) => x.id === 'approval-gated-release')!
  const out = parse(instantiate(s, { name: 'ship-it', namespace: 'payments-dev' }))
  const a = toJS(out) as { metadata: Record<string, unknown> }
  const b = toJS(parse(s.yaml)) as { metadata: Record<string, unknown> }
  assertEquals(a.metadata.name, 'ship-it')
  assertEquals(a.metadata.namespace, 'payments-dev')
  assertEquals({ ...a, metadata: undefined }, { ...b, metadata: undefined })
  assertEquals(commentsOf(out), commentsOf(parse(s.yaml)))
  assertEquals((toJS(parse(instantiate(s, { name: 'x' }))) as { metadata: Record<string, unknown> }).metadata.namespace, b.metadata.namespace)
})
