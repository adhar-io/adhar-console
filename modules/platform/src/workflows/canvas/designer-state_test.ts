import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.0'
import { getIn } from '../model/doc.ts'
import { allNodes, findNode } from '../model/project.ts'
import * as S from '../model/session.ts'
import { platformCatalogue } from '../model/testdata.ts'
import { hasErrors } from '../model/validate.ts'
import { parse as parseYaml } from 'yaml'
import { copyText, type DesignerState, designerDiagnostics, designerPalette, EMPTY_WORKFLOW, emptyWorkflow, FAN_OUT_ID, init, NUDGE, NUDGE_FAR, reduce, testRunBlocker } from './designer-state.ts'
import { commandFor } from './keys.ts'

/**
 * The designer's gestures, end to end on the real model (design 0026 §6.8,
 * W2-C2). The canvas and the palette translate pointer and key events into
 * exactly these actions, so these are the acceptance criteria in pure form:
 * acceptance 2 (a 6-node DAG by drag and drop only) and acceptance 6 (a
 * 3-node flow by keyboard only).
 */

const opts = { catalogue: platformCatalogue() }
const parseYaml11 = (t: string) => parseYaml(t, { version: '1.1' }) as { metadata: { name: unknown; namespace: unknown } }
const HTTP_CHECK = { name: 'adhar-steps', template: 'http-check', clusterScope: true }

function run(s: DesignerState, ...actions: Parameters<typeof reduce>[1][]): DesignerState {
  for (const a of actions) s = reduce(s, a)
  return s
}

/** Acceptance 2: six drops (one of them answered in the template picker), five drawn edges. */
function sixNodeDag(): DesignerState {
  let s = init(EMPTY_WORKFLOW, opts)
  s = run(
    s,
    { type: 'drop', entry: 'container', at: { x: 140, y: 120 } },
    { type: 'drop', entry: 'script', at: { x: 460, y: 120 } },
    { type: 'drop', entry: 'http', at: { x: 780, y: 120 } },
    { type: 'drop', entry: 'approval', at: { x: 1100, y: 120 } },
    { type: 'drop', entry: 'template', at: { x: 1420, y: 120 } },
    { type: 'pick', ref: HTTP_CHECK, arguments: [{ name: 'url', value: 'http://shop.shop-dev.svc/healthz' }] },
    { type: 'drop', entry: FAN_OUT_ID, at: { x: 1740, y: 120 } },
  )
  const ids = s.session.graph.nodes.map((n) => n.uid)
  for (let i = 1; i < ids.length; i++) s = reduce(s, { type: 'connect', source: ids[i - 1], target: ids[i] })
  return s
}

Deno.test('acceptance 2: a 6-node DAG of every kind is built by drag and drop alone, and validates', () => {
  const s = sixNodeDag()
  const g = s.session.graph
  assertEquals(g.nodes.map((n) => n.kind), ['container', 'script', 'http', 'approval', 'platform-step', 'container'])
  assertEquals(g.nodes.map((n) => n.id), ['run', 'script', 'call', 'approve', 'http-check', 'for-each'])
  assertEquals(g.nodes[5].badges.fanOut, 'items')
  assertEquals(g.edges.length, 5)
  assert(g.editable)
  assert(!hasErrors(designerDiagnostics(s)), JSON.stringify(designerDiagnostics(s)))
  assertEquals(testRunBlocker(s), null)
  // Every drop is where the pointer was (centred, snapped to the grid) and lands in the annotation.
  assertEquals(findNode(g, 'run')!.position, { x: 16, y: 88, fromAnnotation: true })
  // The approval set the label the catalogue and notifications read.
  assertEquals(getIn(s.session.doc, ['spec', 'workflowMetadata', 'labels', 'adhar.io/has-approvals']), 'true')
  // Each gesture is one undo step: six drops (the fan-out included) and five connections.
  assertEquals(s.session.undo.length, 11)
  let back = s
  for (let i = 0; i < 11; i++) back = reduce(back, { type: 'undo' })
  assertEquals(S.text(back.session), EMPTY_WORKFLOW)
})

Deno.test('dropping the template entry opens the picker and changes nothing until it answers', () => {
  const s0 = init(EMPTY_WORKFLOW, opts)
  const s1 = reduce(s0, { type: 'drop', entry: 'template', at: { x: 300, y: 300 } })
  assert(s1.picking)
  assertEquals(S.text(s1.session), EMPTY_WORKFLOW)
  const s2 = reduce(s1, { type: 'cancel-pick' })
  assertEquals(s2.picking, undefined)
  assertEquals(s2.session, s0.session)
  const s3 = reduce(s1, { type: 'pick', ref: HTTP_CHECK })
  assertEquals(findNode(s3.session.graph, 'http-check')?.position, { x: 176, y: 264, fromAnnotation: true })
  // A required argument the picker left empty is a warning on the node, not silence.
  assert(designerDiagnostics(s3).some((d) => d.code === 'designer/empty-argument' && d.task?.uid === 'http-check'))
})

Deno.test('the fan-out entry is a container with withItems, made as one undo step', () => {
  const s = reduce(init(EMPTY_WORKFLOW, opts), { type: 'drop', entry: FAN_OUT_ID })
  assertEquals(s.session.undo.length, 1)
  assertEquals(s.selected, 'for-each')
  const n = findNode(s.session.graph, 'for-each')!
  assertEquals(getIn(s.session.doc, [...n.path, 'withItems']), ['one', 'two', 'three'])
  assertEquals(getIn(s.session.doc, [...n.templatePath!, 'container', 'args']), ['echo "{{item}}"'])
  assertEquals(S.text(reduce(s, { type: 'undo' }).session), EMPTY_WORKFLOW)
  assert(designerPalette(opts.catalogue).some((e) => e.id === FAN_OUT_ID && e.section === 'Flow control'))
})

Deno.test('acceptance 6: a 3-node flow is made keyboard-only', () => {
  // Tab to the palette and press Enter on an entry: a drop with no pointer position (auto-laid out).
  let s = init(EMPTY_WORKFLOW, opts)
  s = run(s, { type: 'drop', entry: 'container' }, { type: 'drop', entry: 'script' }, { type: 'drop', entry: 'http' })
  assertEquals(s.selected, 'call')
  // The inspector's "Runs after" control (a select and an Add button) connects.
  s = run(s, { type: 'connect', source: 'run', target: 'script' }, { type: 'connect', source: 'script', target: 'call' })
  const g = s.session.graph
  assertEquals(g.edges.map((e) => `${e.source}->${e.target}`), ['run->script', 'script->call'])
  // Laid out by the model, no two cards on top of each other.
  assertEquals(new Set(g.nodes.map((n) => `${n.position.x},${n.position.y}`)).size, 3)
  // Rename from the inspector's name field.
  s = reduce(s, { type: 'rename', node: 'call', to: 'notify' })
  assertEquals(s.selected, 'notify')
  // Arrows nudge; Delete removes; ⌘Z undoes — through the keymap the page binds.
  const key = (k: Parameters<typeof commandFor>[0]) => commandFor(k, false)
  assertEquals(key({ key: 'ArrowRight' }), 'nudge-right')
  assertEquals(key({ key: 'ArrowDown', shiftKey: true }), 'nudge-down-far')
  const before = findNode(s.session.graph, 'notify')!.position
  s = run(s, { type: 'nudge', dx: NUDGE, dy: 0 }, { type: 'nudge', dx: 0, dy: NUDGE_FAR })
  assertEquals(findNode(s.session.graph, 'notify')!.position, { x: before.x + NUDGE, y: before.y + NUDGE_FAR, fromAnnotation: true })
  assertEquals(key({ key: 'Delete' }), 'remove')
  const removed = reduce(s, { type: 'remove' })
  assertEquals(removed.session.graph.nodes.length, 2)
  assertEquals(removed.selected, null)
  assertEquals(key({ key: 'z', metaKey: true }), 'undo')
  assertEquals(reduce(removed, { type: 'undo' }).session.graph.nodes.length, 3)
  assert(!hasErrors(designerDiagnostics(s)))
})

Deno.test('a refused edit changes nothing and says why', () => {
  const s = sixNodeDag()
  const cycle = reduce(s, { type: 'connect', source: 'for-each', target: 'run' })
  assertEquals(cycle.session, s.session)
  assertEquals(cycle.status?.tone, 'error')
  assert(/circle|cycle/i.test(cycle.status!.text), cycle.status!.text)
  const self = reduce(s, { type: 'connect', source: 'run', target: 'run' })
  assertEquals(self.session, s.session)
  assertEquals(self.status?.tone, 'error')
  const bad = reduce(s, { type: 'rename', node: 'run', to: 'Not a name!' })
  assertEquals(bad.session, s.session)
  assertEquals(bad.status?.tone, 'error')
})

Deno.test('typed YAML that does not parse freezes the canvas: drops are refused, the text is kept', () => {
  const s = sixNodeDag()
  const broken = `${S.text(s.session)}\n  : : nope\n`
  const f = reduce(s, { type: 'text', text: broken })
  assert(f.session.frozen)
  assertEquals(S.text(f.session), broken)
  assertEquals(f.session.graph.nodes.length, 6, 'the last good graph stays on screen')
  const d = reduce(f, { type: 'drop', entry: 'container' })
  assertEquals(d.session, f.session)
  assertEquals(d.status?.tone, 'error')
  assert(testRunBlocker(f))
  // Fixing the text thaws it; the same text is not a second edit.
  const fixed = reduce(f, { type: 'text', text: S.text(s.session) })
  assert(!fixed.session.frozen)
  assertEquals(reduce(fixed, { type: 'text', text: S.text(s.session) }), fixed)
})

Deno.test('copy and paste a step: a new name, its own template, no dependencies', () => {
  let s = sixNodeDag()
  s = reduce(s, { type: 'select', node: 'script' })
  const clip = copyText(s)!
  assert(clip.includes('task:') && clip.includes('template:'))
  const p = reduce(s, { type: 'paste', text: clip })
  const added = allNodes(p.session.graph).filter((n) => !allNodes(s.session.graph).some((o) => o.uid === n.uid))
  assertEquals(added.map((n) => n.id), ['script-2'])
  assertEquals(p.selected, 'script-2')
  assertEquals(added[0].template.local, 'script-2')
  assertEquals(p.session.graph.edges.filter((e) => e.target === 'script-2'), [])
  assertEquals(p.session.undo.length, s.session.undo.length + 1)
  assert(!hasErrors(designerDiagnostics(p)))
  const junk = reduce(s, { type: 'paste', text: 'just: words' })
  assertEquals(junk.session, s.session)
  assertEquals(junk.status?.tone, 'error')
})

Deno.test('a drag that ends writes positions once; an empty one writes nothing', () => {
  const s = sixNodeDag()
  assertEquals(reduce(s, { type: 'moved', positions: {} }), s)
  const m = reduce(s, { type: 'moved', positions: { run: { x: 0, y: 400 }, script: { x: 320, y: 400 } } })
  assertEquals(m.session.undo.length, s.session.undo.length + 1)
  assertEquals(findNode(m.session.graph, 'script')!.position, { x: 320, y: 400, fromAnnotation: true })
  const laid = reduce(m, { type: 'layout' })
  assertNotEquals(findNode(laid.session.graph, 'script')!.position.y, 400)
})

Deno.test('a selection that no longer exists is dropped (undo of an add, a rename in the YAML)', () => {
  const s = reduce(init(EMPTY_WORKFLOW, opts), { type: 'drop', entry: 'container' })
  assertEquals(s.selected, 'run')
  assertEquals(reduce(s, { type: 'undo' }).selected, null)
})

Deno.test('test run needs a WorkflowTemplate with no errors', () => {
  assertEquals(testRunBlocker(sixNodeDag()), null)
  const cron = init(EMPTY_WORKFLOW.replace('kind: WorkflowTemplate', 'kind: CronWorkflow'), opts)
  assert(testRunBlocker(cron))
  const broken = run(sixNodeDag(), { type: 'text', text: S.text(sixNodeDag().session).replace('depends: run', 'depends: nothing-here') })
  assert(/error/.test(testRunBlocker(broken) ?? ''), testRunBlocker(broken) ?? '')
})

Deno.test('an empty canvas named yes in namespace 1234 is still a string name and namespace to the API server', () => {
  // Both are valid names; written plain, YAML 1.1 (the API server, Argo CD) read true and 1234.
  for (const [name, ns] of [['yes', '1234'], ['on', 'no'], ['1e3', '0x1f']]) {
    const o = parseYaml11(emptyWorkflow(name, ns))
    assertEquals([o.metadata.name, o.metadata.namespace], [name, ns])
  }
  // An ordinary name is written as typed.
  assert(emptyWorkflow('nightly', 'shop-dev').includes('  name: nightly\n  namespace: shop-dev\n'))
})
