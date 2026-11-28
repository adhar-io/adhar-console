import { assert, assertEquals, assertStrictEquals } from 'jsr:@std/assert@^1.0.0'
import * as S from '../model/session.ts'
import { platformCatalogue } from '../model/testdata.ts'
import { init, reduce } from './designer-state.ts'
import { EDGE_HEX, edgeLook, FlowCache, toFlow } from './flow-model.ts'

/**
 * W2 acceptance 7, the part that can be held offline: a 200-node DAG costs
 * React Flow no work while it pans, and an edit costs it one card.
 *
 * React Flow re-renders a card when its node OBJECT changes and diffs the
 * whole graph when the `nodes` ARRAY changes. Panning changes neither. So the
 * budget is stated as "objects rebuilt per change": zero when nothing changed
 * (same arrays back — a pan, a re-render of the page, a status tick), one per
 * card that changed (a drag, a selection), and a wall-clock ceiling on the
 * whole edit cycle (projection + mapping) that an O(n²) regression would blow.
 * The ≥ 50 fps figure itself needs a browser and is owed live.
 */

const opts = { catalogue: platformCatalogue() }

/** 20 layers × 10 tasks; each task after the first layer depends on two in the layer before. */
export function syntheticDag(layers = 20, width = 10): string {
  const tasks: string[] = []
  for (let l = 0; l < layers; l++) {
    for (let i = 0; i < width; i++) {
      const name = `t${l}-${i}`.replace(/^t/, 'task-')
      const deps = l === 0 ? '' : `\n            depends: "task-${l - 1}-${i} && task-${l - 1}-${(i + 1) % width}"`
      tasks.push(`          - name: ${name}${deps}\n            template: step`)
    }
  }
  return `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: big
spec:
  entrypoint: main
  activeDeadlineSeconds: 3600
  templates:
    - name: main
      dag:
        tasks:
${tasks.join('\n')}
    - name: step
      container:
        image: docker.io/library/busybox:1.37
        command: [sh, -c]
        args: ["true"]
        resources:
          requests: {cpu: 10m, memory: 16Mi}
          limits: {cpu: 50m, memory: 32Mi}
`
}

Deno.test('acceptance 7: the 200-node DAG maps to 200 cards and 380 edges', () => {
  const s = init(syntheticDag(), opts)
  assertEquals(s.session.graph.nodes.length, 200)
  const cache = new FlowCache()
  const f = toFlow(s.session.graph, s.session.doc, null, cache)
  assertEquals(f.nodes.length, 200)
  assertEquals(f.edges.length, 380)
  assertEquals(cache.built, 200)
})

Deno.test('acceptance 7: nothing changed (a pan, a re-render) gives back the same arrays and builds nothing', () => {
  const s = init(syntheticDag(), opts)
  const cache = new FlowCache()
  const a = toFlow(s.session.graph, s.session.doc, null, cache)
  // A fresh projection of the same text: new DesignerNode objects, same content.
  const again = S.open(S.text(s.session), opts)
  const b = toFlow(again.graph, again.doc, null, cache)
  assertStrictEquals(b.nodes, a.nodes)
  assertStrictEquals(b.edges, a.edges)
  assertEquals(cache.built, 0)
})

Deno.test('acceptance 7: a drag of one card rebuilds that card only, inside the edit budget', () => {
  let s = init(syntheticDag(), opts)
  const cache = new FlowCache()
  const before = toFlow(s.session.graph, s.session.doc, null, cache)
  const t0 = performance.now()
  s = reduce(s, { type: 'moved', positions: { 'task-10-5': { x: 4000, y: 4000 } } })
  const after = toFlow(s.session.graph, s.session.doc, null, cache)
  const ms = performance.now() - t0
  assertEquals(cache.built, 1)
  const changed = after.nodes.filter((n, i) => n !== before.nodes[i])
  assertEquals(changed.map((n) => n.id), ['task-10-5'])
  assertEquals(changed[0].position, { x: 4000, y: 4000 })
  // The edges kept their objects; the array is the same one.
  assertStrictEquals(after.edges, before.edges)
  // Projection + validation + mapping of 200 nodes after an edit: generous, but an O(n²) slip is seconds.
  assert(ms < 1500, `an edit of the 200-node DAG took ${ms.toFixed(0)} ms`)
})

Deno.test('acceptance 7: selecting a card rebuilds exactly the two cards whose ring changed', () => {
  const s = init(syntheticDag(), opts)
  const cache = new FlowCache()
  toFlow(s.session.graph, s.session.doc, 'task-0-0', cache)
  const f = toFlow(s.session.graph, s.session.doc, 'task-0-1', cache)
  assertEquals(cache.built, 2)
  assertEquals(f.nodes.filter((n) => n.selected).map((n) => n.id), ['task-0-1'])
})

Deno.test('a frozen document draws its cards fixed: nothing drags, nothing connects', () => {
  const s = init(syntheticDag(2, 2), opts)
  const f = toFlow(s.session.graph, s.session.doc, null, new FlowCache(), { frozen: true })
  assert(f.nodes.every((n) => !n.draggable && !n.connectable))
  assert(f.edges.every((e) => !e.deletable))
})

Deno.test('a card carries its problems: counts and the first message', () => {
  const s = init(syntheticDag(2, 2).replace('template: step', 'template: nowhere'), opts)
  const f = toFlow(s.session.graph, s.session.doc, null, new FlowCache())
  const broken = f.nodes.find((n) => n.id === 'task-0-0')!
  assertEquals(broken.data.errors, 1)
  assert(broken.data.problem)
  assert(/error/.test(broken.ariaLabel))
  assertEquals(f.nodes.find((n) => n.id === 'task-0-1')!.data.subtitle, 'busybox:1.37')
})

Deno.test('edges say their condition (§6.8)', () => {
  const e = (condition: string) => ({ id: 'a>b', source: 'a', target: 'b', condition }) as Parameters<typeof edgeLook>[0]
  assertEquals(edgeLook(e('Succeeded')), { stroke: EDGE_HEX.success })
  assertEquals(edgeLook(e('Failed')).label, 'on failure')
  assertEquals(edgeLook(e('Failed')).stroke, EDGE_HEX.failure)
  assertEquals(edgeLook(e('Expression')).label, 'ƒ')
  assertEquals(edgeLook(e('Succeeded'), '{{tasks.approve.outputs.parameters.decision}} == approve').label, '{{tasks.approve.outputs…')
  assertEquals(edgeLook(e('Skipped')).label, 'Skipped')
})
