import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { getIn } from '../model/doc.ts'
import type { InspectorField } from '../model/kinds.ts'
import { fieldsFor } from '../model/kinds.ts'
import { OpError } from '../model/ops.ts'
import { findNode } from '../model/project.ts'
import * as S from '../model/session.ts'
import { platformCatalogue } from '../model/testdata.ts'
import { type DesignerState, EMPTY_WORKFLOW, init, reduce } from './designer-state.ts'
import { display, fieldOp, isArgument, parseRef, readField } from './field-ops.ts'
import { commandFor, commandIn, isTextTarget, KEYMAP } from './keys.ts'

/** The inspector's controls ⇄ the document (§6.6), and the keymap (§6.8). */

const opts = { catalogue: platformCatalogue() }

function withNodes(): DesignerState {
  let s = init(EMPTY_WORKFLOW, opts)
  for (const e of ['container', 'approval', 'http']) s = reduce(s, { type: 'drop', entry: e })
  return s
}

function field(s: DesignerState, uid: string, id: string): InspectorField {
  const n = findNode(s.session.graph, uid)!
  const f = fieldsFor(n.kind, n.template.ref, opts.catalogue, n.template.local !== undefined).find((x) => x.id === id)
  assert(f, `no field ${id} on ${uid}`)
  return f
}

function edit(s: DesignerState, uid: string, id: string, raw: unknown): DesignerState {
  return reduce(s, { type: 'field', node: uid, field: field(s, uid, id), raw })
}

const value = (s: DesignerState, uid: string, id: string) => {
  const n = findNode(s.session.graph, uid)!
  const f = field(s, uid, id)
  return display(f, readField(s.session.doc, s.session.graph, n, f))
}

Deno.test('text fields write the string and an empty one removes the field', () => {
  let s = withNodes()
  assertEquals(value(s, 'run', 'image'), 'docker.io/library/busybox:1.37')
  s = edit(s, 'run', 'image', 'ghcr.io/acme/tool:1.2.3')
  assertEquals(value(s, 'run', 'image'), 'ghcr.io/acme/tool:1.2.3')
  s = edit(s, 'run', 'workingDir', '/work')
  assertEquals(getIn(s.session.doc, ['spec', 'templates', 1, 'container', 'workingDir']), '/work')
  s = edit(s, 'run', 'workingDir', '')
  assertEquals(getIn(s.session.doc, ['spec', 'templates', 1, 'container', 'workingDir']), undefined)
  // Removing what is not there is no edit at all.
  const n = findNode(s.session.graph, 'run')!
  assertEquals(fieldOp(s.session.doc, s.session.graph, n, field(s, 'run', 'workingDir'), ''), null)
})

Deno.test('lists are one item per line; numbers are numbers; a toggle is a boolean', () => {
  let s = withNodes()
  s = edit(s, 'run', 'args', 'echo one\n\necho two\n')
  assertEquals(value(s, 'run', 'args'), 'echo one\necho two')
  s = edit(s, 'run', 'retries', '3')
  assertEquals(getIn(s.session.doc, [...findNode(s.session.graph, 'run')!.templatePath!, 'retryStrategy', 'limit']), 3)
  assertThrows(() => fieldOp(s.session.doc, s.session.graph, findNode(s.session.graph, 'run'), field(s, 'run', 'retries'), 'lots'), OpError)
  // The reducer turns that refusal into a status, and leaves the document alone.
  const refused = edit(s, 'run', 'retries', 'lots')
  assertEquals(refused.session, s.session)
  assertEquals(refused.status?.tone, 'error')
  assertEquals(value(s, 'run', 'nonRoot'), true)
  s = edit(s, 'run', 'nonRoot', false)
  assertEquals(value(s, 'run', 'nonRoot'), false)
})

Deno.test('plain environment and secret environment edit the same list without touching each other', () => {
  let s = withNodes()
  s = edit(s, 'run', 'env', 'MODE=fast\nLEVEL=2')
  s = edit(s, 'run', 'secret-env', 'TOKEN=shop-api/token')
  assertEquals(value(s, 'run', 'env'), 'MODE=fast\nLEVEL=2')
  assertEquals(value(s, 'run', 'secret-env'), 'TOKEN=shop-api/token')
  s = edit(s, 'run', 'env', 'MODE=slow')
  assertEquals(value(s, 'run', 'secret-env'), 'TOKEN=shop-api/token', 'the secret survives an edit of the plain values')
  const env = getIn<unknown[]>(s.session.doc, [...findNode(s.session.graph, 'run')!.templatePath!, 'container', 'env'])!
  assertEquals(env, [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'shop-api', key: 'token' } } }, { name: 'MODE', value: 'slow' }])
  assertThrows(() => fieldOp(s.session.doc, s.session.graph, findNode(s.session.graph, 'run'), field(s, 'run', 'secret-env'), 'TOKEN=just-a-value'), OpError)
  assertThrows(() => fieldOp(s.session.doc, s.session.graph, findNode(s.session.graph, 'run'), field(s, 'run', 'env'), '1BAD=x'), OpError)
})

Deno.test('resources are YAML; headers are Name: value lines', () => {
  let s = withNodes()
  assert(String(value(s, 'run', 'resources')).includes('cpu: 100m'))
  s = edit(s, 'run', 'resources', 'requests: {cpu: 250m, memory: 256Mi}\nlimits: {cpu: "1", memory: 512Mi}')
  assertEquals(getIn(s.session.doc, [...findNode(s.session.graph, 'run')!.templatePath!, 'container', 'resources', 'limits', 'cpu']), '1')
  assertThrows(() => fieldOp(s.session.doc, s.session.graph, findNode(s.session.graph, 'run'), field(s, 'run', 'resources'), '- a list'), OpError)
  s = edit(s, 'call', 'headers', 'Accept: application/json\nX-Trace: on')
  assertEquals(value(s, 'call', 'headers'), 'Accept: application/json\nX-Trace: on')
})

Deno.test('a referenced step is edited through its arguments, never through a template it does not own', () => {
  let s = withNodes()
  const q = field(s, 'approve', 'arg:question')
  assert(isArgument(q))
  s = edit(s, 'approve', 'arg:question', 'Ship to prod?')
  assertEquals(value(s, 'approve', 'arg:question'), 'Ship to prod?')
  s = edit(s, 'approve', 'arg:timeout', '30m')
  assertEquals(value(s, 'approve', 'arg:timeout'), '30m')
  // An optional argument emptied is removed from the task.
  s = edit(s, 'approve', 'arg:timeout', '')
  assertEquals(value(s, 'approve', 'arg:timeout'), '')
  assert(!S.text(s.session).includes('name: timeout'))
  // A template field on a reference has nowhere to go.
  const node = findNode(s.session.graph, 'approve')!
  assertThrows(() => fieldOp(s.session.doc, s.session.graph, node, { id: 'x', label: 'Retries', target: 'template', path: ['retryStrategy'], control: 'number' }, '2'), OpError)
})

Deno.test('the template picker accepts library/template and cluster:library/template', () => {
  assertEquals(parseRef('cluster:adhar-steps/http-check'), { name: 'adhar-steps', template: 'http-check', clusterScope: true })
  assertEquals(parseRef('nightly/main'), { name: 'nightly', template: 'main' })
  assertEquals(parseRef('nonsense'), undefined)
})

Deno.test('the keymap: letters only outside text, save and test run everywhere', () => {
  assertEquals(commandFor({ key: 'f' }, false), 'fit')
  assertEquals(commandFor({ key: 'f' }, true), null)
  assertEquals(commandFor({ key: 'l' }, false), 'layout')
  assertEquals(commandFor({ key: '/' }, false), 'search')
  assertEquals(commandFor({ key: 'Enter' }, false), 'inspect')
  assertEquals(commandFor({ key: 'Backspace' }, false), 'remove')
  assertEquals(commandFor({ key: 'Escape' }, false), 'deselect')
  assertEquals(commandFor({ key: 'ArrowLeft', shiftKey: true }, false), 'nudge-left-far')
  assertEquals(commandFor({ key: 's', metaKey: true }, true), 'save')
  assertEquals(commandFor({ key: 'Enter', ctrlKey: true }, true), 'test-run')
  assertEquals(commandFor({ key: 'z', metaKey: true, shiftKey: true }, false), 'redo')
  assertEquals(commandFor({ key: 'z', metaKey: true }, true), null, "undo in a text field is the field's own")
  assertEquals(commandFor({ key: 'c', ctrlKey: true }, false), 'copy')
  assertEquals(commandFor({ key: 'v', metaKey: true }, false), 'paste')
  assertEquals(commandFor({ key: 'f', altKey: true }, false), null)
  assert(isTextTarget({ tagName: 'input' }))
  assert(isTextTarget({ tagName: 'DIV', closest: (s: string) => (s === '.monaco-editor' ? {} : null) }))
  assert(!isTextTarget({ tagName: 'BUTTON', closest: () => null }))
  // Every documented key does something (eleven bound here, plus Monaco's own way out of the YAML editor).
  assertEquals(KEYMAP.length, 12)
  // Tab indents in the YAML editor: the help must say how to leave it with the keyboard.
  assert(KEYMAP.some((k) => /Ctrl\+M/.test(k.keys) && /Tab move focus/.test(k.does)))
})

Deno.test('a key pressed in a dialog, or on a control, never edits the step behind it', () => {
  // A fake DOM: the page's root, a canvas card inside it, buttons and a tab inside it, and a dialog in a portal OUTSIDE it.
  const el = (tagName: string, inCanvas: boolean) => ({ tagName, closest: (s: string) => (s === '.react-flow' && inCanvas ? {} : null) })
  const card = el('DIV', true)
  const toolbarButton = el('BUTTON', false)
  const tab = el('BUTTON', false)
  const dialogButton = el('BUTTON', false)
  const dialogInput = el('INPUT', false)
  const inside = new Set<unknown>([card, toolbarButton, tab])
  const root = { contains: (n: unknown) => n === root || inside.has(n) }
  // On the canvas: the step keys work.
  assertEquals(commandIn({ key: 'Delete' }, card, root), 'remove')
  assertEquals(commandIn({ key: 'ArrowRight' }, card, root), 'nudge-right')
  assertEquals(commandIn({ key: 'c', metaKey: true }, card, root), 'copy')
  // In the test-run dialog (a portal): nothing at all — not Delete, not an arrow, not f, not even save.
  for (const k of [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'ArrowDown' }, { key: 'f' }, { key: 'l' }, { key: 's', metaKey: true }]) {
    assertEquals(commandIn(k, dialogButton, root), null, k.key)
    assertEquals(commandIn(k, dialogInput, root), null, k.key)
  }
  // On a button or a tab of the page: step edits are the canvas's, page commands still work.
  assertEquals(commandIn({ key: 'Backspace' }, toolbarButton, root), null)
  assertEquals(commandIn({ key: 'ArrowRight' }, tab, root), null)
  assertEquals(commandIn({ key: 'c', metaKey: true }, toolbarButton, root), null)
  assertEquals(commandIn({ key: 'f' }, toolbarButton, root), 'fit')
  assertEquals(commandIn({ key: 'z', metaKey: true }, toolbarButton, root), 'undo')
  assertEquals(commandIn({ key: 's', metaKey: true }, toolbarButton, root), 'save')
  // Enter on a button is the button's.
  assertEquals(commandIn({ key: 'Enter' }, toolbarButton, root), null)
  assertEquals(commandIn({ key: 'Enter' }, card, root), 'inspect')
})
