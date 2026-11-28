import { parse as parseYaml, stringify } from 'yaml'
import type { Path } from '../model/doc.ts'
import { getIn } from '../model/doc.ts'
import type { Condition } from '../model/depends.ts'
import type { InspectorField, PaletteEntry, TemplateRef } from '../model/kinds.ts'
import { palette as modelPalette } from '../model/kinds.ts'
import { CARD_WIDTH } from '../model/layout.ts'
import type { Op, OpResult } from '../model/ops.ts'
import { OpError } from '../model/ops.ts'
import type { DesignerGraph, DesignerNode } from '../model/project.ts'
import { allNodes, findNode } from '../model/project.ts'
import * as S from '../model/session.ts'
import type { Diagnostic } from '../model/validate.ts'
import { fieldOp } from './field-ops.ts'

/**
 * The designer's state machine (design 0026 §6.8, W2-C2). Every gesture the
 * page offers — a drop from the palette, Enter on a palette entry, a drawn
 * connection, a drag that ends, an inspector edit, a key — is an `Action`
 * reduced here into the one `Session` (model/session.ts). The React files only
 * translate events into actions, so what a person can do on the canvas is
 * exactly what `designer-state_test.ts` exercises, mouse or keyboard.
 *
 * A refused edit (`OpError`) never changes the document: the state keeps its
 * session and carries the refusal as `status`, which the page shows and the
 * `aria-live` region reads out.
 *
 * Pure: no React, no fetch, no @xyflow.
 */

export const GRID = 8
export const NUDGE = GRID
export const NUDGE_FAR = GRID * 10

export interface Status {
  tone: 'info' | 'error'
  text: string
}

export interface DesignerState {
  session: S.Session
  opts: S.SessionOptions
  /** The node the inspector shows, by `uid`. */
  selected: string | null
  /** What the last action did or why it was refused (status line + aria-live). */
  status: Status | null
  /** A `pick-ref` drop waiting for the template to call (the picker is open). */
  picking?: { at?: { x: number; y: number }; lane?: 'exit' }
}

export type Action =
  /** A palette entry dropped on the canvas (`at` in flow coordinates) or activated with Enter (no `at`). */
  | { type: 'drop'; entry: string; at?: { x: number; y: number }; lane?: 'exit' }
  /** The template picker answered a `pick-ref` drop. */
  | { type: 'pick'; ref: TemplateRef; arguments?: Array<{ name: string; value: string }> }
  | { type: 'cancel-pick' }
  | { type: 'connect'; source: string; target: string; condition?: Condition }
  | { type: 'disconnect'; source: string; target: string }
  | { type: 'remove'; node?: string }
  | { type: 'rename'; node: string; to: string }
  /** An inspector field changed (`raw` is what the control holds). */
  | { type: 'field'; node: string | null; field: InspectorField; raw: unknown }
  /** Drag END: the nodes' new top-left corners. */
  | { type: 'moved'; positions: Record<string, { x: number; y: number }> }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'select'; node: string | null }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'layout' }
  /** The YAML panel, after its 400 ms debounce. */
  | { type: 'text'; text: string }
  | { type: 'convert' }
  | { type: 'wrap' }
  | { type: 'paste'; text: string }
  /** The cluster's step libraries arrived (or changed): re-project with them. */
  | { type: 'catalogue'; opts: S.SessionOptions }
  | { type: 'saved' }
  | { type: 'status'; status: Status | null }

/**
 * An empty canvas: a WorkflowTemplate whose entry DAG has no tasks yet. The
 * starters (model/starters.ts) begin with a step; this is for building from
 * nothing by dragging.
 */
export const EMPTY_WORKFLOW = `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: new-workflow
spec:
  entrypoint: main
  activeDeadlineSeconds: 3600
  templates:
    - name: main
      dag:
        tasks: []
`

/**
 * A name as a YAML scalar the API server reads as a string. `yes`, `on`,
 * `1234` and `1e3` are valid names and namespaces, and YAML 1.1 (the API
 * server, Argo CD) reads them plain as a boolean or a number.
 */
function nameScalar(v: string): string {
  try {
    if (typeof parseYaml(v, { version: '1.1' }) === 'string') return v
  } catch { /* not plain-safe: quote it */ }
  return JSON.stringify(v)
}

/** The empty canvas under the name and namespace the person chose. */
export function emptyWorkflow(name: string, namespace?: string): string {
  return EMPTY_WORKFLOW.replace('name: new-workflow', `name: ${nameScalar(name)}${namespace ? `\n  namespace: ${nameScalar(namespace)}` : ''}`)
}

export function init(text: string, opts: S.SessionOptions = {}): DesignerState {
  return { session: S.open(text, opts), opts, selected: null, status: null }
}

/* ─────────────────────────── the palette the page shows ─────────────────────────── */

/**
 * Fan-out (§6.6 "×N"): a container step run once per item of a list. Argo
 * has no fan-out template — it is `withItems` on a task — so the entry is a
 * Container drop plus that field, made as ONE undo step.
 */
export const FAN_OUT_ID = 'fan-out'

export function designerPalette(catalogue: S.SessionOptions['catalogue'] = [], capabilities: { batch?: boolean; gamedays?: boolean } = {}): PaletteEntry[] {
  const base = modelPalette(catalogue, capabilities)
  const container = base.find((e) => e.id === 'container')
  if (!container) return base
  const fanOut: PaletteEntry = {
    ...container,
    id: FAN_OUT_ID,
    section: 'Flow control',
    title: 'Fan-out',
    description: 'Run a container once for each item in a list, in parallel.',
    baseName: 'for-each',
    guardrails: ['Each item is a separate pod: keep the list short, or bound it with parallelism on the template.', ...container.guardrails],
  }
  const at = base.findIndex((e) => e.id === 'subflow')
  return [...base.slice(0, at + 1), fanOut, ...base.slice(at + 1)]
}

/* ─────────────────────────── helpers ─────────────────────────── */

const snap = (v: number) => Math.round(v / GRID) * GRID

/** A drop point is where the pointer is; the card is centred on it and snapped to the grid. */
export function dropCorner(at: { x: number; y: number }): { x: number; y: number } {
  return { x: snap(at.x - CARD_WIDTH / 2), y: snap(at.y - 36) }
}

function names(g: DesignerGraph): Set<string> {
  return new Set([...allNodes(g, true).map((n) => n.id), ...g.templates.map((t) => t.name)])
}

export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

function refused(state: DesignerState, e: unknown): DesignerState {
  if (e instanceof OpError) return { ...state, status: { tone: 'error', text: e.message } }
  throw e
}

function said(changes: readonly string[]): Status | null {
  return changes.length ? { tone: 'info', text: changes.join('. ') } : null
}

/**
 * Several operations as ONE undo step: each is computed from the session the
 * previous one left (so it may use what that one created), and the undo stack
 * is that of the first. Any refusal leaves the state as it was.
 */
export function applySteps(state: DesignerState, steps: ReadonlyArray<(s: S.Session, prev: OpResult | undefined) => Op | null>): { session: S.Session; results: OpResult[] } {
  let s = state.session
  let prev: OpResult | undefined
  const results: OpResult[] = []
  for (const step of steps) {
    const op = step(s, prev)
    if (!op) continue
    const r = S.apply(s, op, state.opts)
    s = r.session
    prev = r.result
    results.push(r.result)
  }
  if (s === state.session) return { session: s, results }
  const undo = [...state.session.undo, state.session.doc].slice(-S.MAX_UNDO)
  return { session: { ...s, undo, redo: [], changes: results.flatMap((r) => r.changes) }, results }
}

/** The uid a node will have after its task is renamed. */
export function renamedUid(g: DesignerGraph, node: DesignerNode, to: string): string {
  return node.lane === 'main' && node.dag === g.entry ? to : `${node.dag}/${to}`
}

/** Path of the entry DAG's task list and of the templates list, when the entry is a DAG. */
function entryPaths(g: DesignerGraph): { tasks: Path; templates: Path } | undefined {
  const t = g.templates.find((x) => x.name === g.entry)
  if (!t || !g.editable) return undefined
  return { tasks: [...t.path, 'dag', 'tasks'], templates: t.path.slice(0, -1) }
}

/* ─────────────────────────── copy / paste (⌘C / ⌘V, §6.8) ─────────────────────────── */

/** The selected task as YAML: the task, and the local template it runs (when it has one). */
export function copyText(state: DesignerState): string | null {
  const node = state.selected ? findNode(state.session.graph, state.selected) : undefined
  if (!node) return null
  const task = getIn<Record<string, unknown>>(state.session.doc, node.path)
  if (!task) return null
  const template = node.templatePath ? getIn<Record<string, unknown>>(state.session.doc, node.templatePath) : undefined
  return stringify({ task, ...(template ? { template } : {}) }, { lineWidth: 0 })
}

function pasteSteps(state: DesignerState, text: string): Array<(s: S.Session) => Op | null> {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    throw new OpError('invalid', 'The clipboard does not hold a step (it is not YAML).')
  }
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const task = r.task && typeof r.task === 'object' && !Array.isArray(r.task) ? { ...(r.task as Record<string, unknown>) } : undefined
  if (!task || typeof task.name !== 'string') throw new OpError('invalid', 'The clipboard does not hold a step copied from the designer.')
  const g = state.session.graph
  const paths = entryPaths(g)
  if (!paths) throw new OpError('not-editable', 'Steps can be pasted only into a DAG.')
  const taken = names(g)
  const name = uniqueName(task.name, taken)
  taken.add(name)
  // The copy depends on nothing: its old dependencies are tasks of another place.
  delete task.depends
  delete task.dependencies
  task.name = name
  const template = r.template && typeof r.template === 'object' && !Array.isArray(r.template) ? { ...(r.template as Record<string, unknown>) } : undefined
  const steps: Array<(s: S.Session) => Op | null> = []
  if (template && typeof task.template === 'string') {
    const tname = uniqueName(name, new Set(g.templates.map((t) => t.name)))
    template.name = tname
    task.template = tname
    steps.push(() => ({ op: 'insert', path: paths.templates, value: template }))
  }
  steps.push(() => ({ op: 'insert', path: paths.tasks, value: task }))
  return steps
}

/* ─────────────────────────── the reducer ─────────────────────────── */

export function reduce(state: DesignerState, action: Action): DesignerState {
  const { opts } = state
  const g = state.session.graph
  try {
    switch (action.type) {
      case 'drop': {
        const entry = designerPalette(opts.catalogue, { batch: true, gamedays: true }).find((e) => e.id === action.entry)
        if (!entry) return { ...state, status: { tone: 'error', text: `The palette has no "${action.entry}".` } }
        const at = action.at ? dropCorner(action.at) : undefined
        if (entry.action === 'pick-ref') return { ...state, picking: { at, lane: action.lane }, status: { tone: 'info', text: 'Pick the template this step calls.' } }
        if (entry.id === FAN_OUT_ID) {
          const name = uniqueName(entry.baseName, names(g))
          let uid: string | null = null
          const { session } = applySteps(state, [
            () => ({ op: 'addNode', palette: 'container', name, at, lane: action.lane }),
            (s, prev) => {
              uid = prev?.created?.uid ?? null
              const n = uid ? findNode(s.graph, uid) : undefined
              return n ? { op: 'set', path: [...n.path, 'withItems'], value: ['one', 'two', 'three'] } : null
            },
            (s) => {
              const n = uid ? findNode(s.graph, uid) : undefined
              return n?.templatePath ? { op: 'set', path: [...n.templatePath, 'container', 'args'], value: ['echo "{{item}}"'] } : null
            },
          ])
          return { ...state, session, selected: uid, picking: undefined, status: { tone: 'info', text: `Added Fan-out "${name}" (one pod per item)` } }
        }
        const r = S.apply(state.session, { op: 'addNode', palette: entry.id, at, lane: action.lane }, opts)
        return { ...state, session: r.session, selected: r.result.created?.uid ?? state.selected, picking: undefined, status: said(r.result.changes) }
      }
      case 'pick': {
        const at = state.picking?.at
        const r = S.apply(state.session, { op: 'addRef', ref: action.ref, at, lane: state.picking?.lane, arguments: action.arguments }, opts)
        return { ...state, session: r.session, selected: r.result.created?.uid ?? state.selected, picking: undefined, status: said(r.result.changes) }
      }
      case 'cancel-pick':
        return { ...state, picking: undefined, status: null }
      case 'connect': {
        if (action.source === action.target) return { ...state, status: { tone: 'error', text: 'A step cannot depend on itself.' } }
        const r = S.apply(state.session, { op: 'connect', source: action.source, target: action.target, condition: action.condition }, opts)
        return { ...state, session: r.session, status: said(r.result.changes) ?? { tone: 'info', text: `"${action.target}" now runs after "${action.source}"` } }
      }
      case 'disconnect': {
        const r = S.apply(state.session, { op: 'disconnect', source: action.source, target: action.target }, opts)
        return { ...state, session: r.session, status: said(r.result.changes) ?? { tone: 'info', text: `"${action.target}" no longer waits for "${action.source}"` } }
      }
      case 'remove': {
        const uid = action.node ?? state.selected
        if (!uid) return state
        const r = S.apply(state.session, { op: 'removeNode', node: uid }, opts)
        return { ...state, session: r.session, selected: state.selected === uid ? null : state.selected, status: said(r.result.changes) }
      }
      case 'rename': {
        const node = findNode(g, action.node)
        if (!node || node.id === action.to) return state
        const r = S.apply(state.session, { op: 'rename', node: action.node, to: action.to }, opts)
        return { ...state, session: r.session, selected: state.selected === action.node ? renamedUid(g, node, action.to) : state.selected, status: said(r.result.changes) }
      }
      case 'field': {
        const node = action.node ? findNode(g, action.node) : undefined
        const op = fieldOp(state.session.doc, g, node, action.field, action.raw)
        if (!op) return state
        const r = S.apply(state.session, op, opts)
        return { ...state, session: r.session, status: null }
      }
      case 'moved': {
        if (!Object.keys(action.positions).length) return state
        const r = S.apply(state.session, { op: 'setPositions', positions: action.positions }, opts)
        return { ...state, session: r.session }
      }
      case 'nudge': {
        const node = state.selected ? findNode(g, state.selected) : undefined
        if (!node) return state
        const r = S.apply(state.session, { op: 'setPositions', positions: { [node.uid]: { x: node.position.x + action.dx, y: node.position.y + action.dy } } }, opts)
        return { ...state, session: r.session }
      }
      case 'select':
        return state.selected === action.node ? state : { ...state, selected: action.node }
      case 'undo': {
        const session = S.undo(state.session, opts)
        return { ...state, session, selected: keep(session.graph, state.selected), status: session === state.session ? null : { tone: 'info', text: 'Undone' } }
      }
      case 'redo': {
        const session = S.redo(state.session, opts)
        return { ...state, session, selected: keep(session.graph, state.selected), status: session === state.session ? null : { tone: 'info', text: 'Redone' } }
      }
      case 'layout': {
        const r = S.apply(state.session, { op: 'autoLayout' }, opts)
        return { ...state, session: r.session, status: said(r.result.changes) }
      }
      case 'text': {
        if (action.text === S.text(state.session)) return state
        const session = S.editText(state.session, action.text, opts)
        return { ...state, session, selected: keep(session.graph, state.selected), status: null }
      }
      case 'convert': {
        const r = S.apply(state.session, { op: 'convertStepsToDag' }, opts)
        return { ...state, session: r.session, status: said(r.result.changes) }
      }
      case 'wrap': {
        const r = S.apply(state.session, { op: 'wrapEntry' }, opts)
        return { ...state, session: r.session, status: said(r.result.changes) }
      }
      case 'paste': {
        const { session, results } = applySteps(state, pasteSteps(state, action.text))
        const pasted = results.length ? session.graph.nodes.find((n) => !g.nodes.some((o) => o.uid === n.uid)) : undefined
        return { ...state, session, selected: pasted?.uid ?? state.selected, status: pasted ? { tone: 'info', text: `Pasted "${pasted.id}"` } : null }
      }
      case 'catalogue': {
        // Re-open the same text with the new catalogue, keeping undo and the baseline.
        const fresh = S.open(S.text(state.session), action.opts)
        return { ...state, opts: action.opts, session: { ...state.session, graph: fresh.graph, frozen: fresh.frozen } }
      }
      case 'saved':
        return { ...state, session: S.markSaved(state.session) }
      case 'status':
        return { ...state, status: action.status }
    }
  } catch (e) {
    return refused(state, e)
  }
}

/** A selection survives an edit only while its node exists. */
function keep(g: DesignerGraph, selected: string | null): string | null {
  return selected && findNode(g, selected) ? selected : null
}

/* ─────────────────────────── what the page may offer ─────────────────────────── */

/**
 * Level A plus what only the designer can see: a catalogue step whose
 * REQUIRED input was left empty (a drop fills required arguments with "", and
 * Argo would run `http-check` against an empty URL). A warning, not an error:
 * an empty string is a value Argo accepts.
 */
export function designerDiagnostics(state: DesignerState): Diagnostic[] {
  const g = state.session.graph
  const out = [...g.diagnostics]
  const catalogue = state.opts.catalogue ?? []
  if (!catalogue.length || state.session.frozen) return out
  for (const n of allNodes(g, true)) {
    const ref = n.template.ref
    if (!ref) continue
    const step = catalogue.find((c) => c.ref.name === ref.name && c.ref.template === ref.template && Boolean(c.ref.clusterScope) === Boolean(ref.clusterScope))
    if (!step) continue
    const params = getIn<unknown[]>(state.session.doc, [...n.path, 'arguments', 'parameters'])
    const given = new Map((Array.isArray(params) ? params : []).map((p) => (p && typeof p === 'object' ? [(p as { name?: unknown }).name, (p as { value?: unknown }).value] : [undefined, undefined])))
    for (const input of step.inputs.filter((i) => i.required)) {
      const v = given.get(input.name)
      if (v !== undefined && v !== null && String(v).trim() !== '') continue
      out.push({
        level: 'warning',
        code: 'designer/empty-argument',
        message: `"${n.id}" passes no value for ${input.name}, which ${step.title} needs.`,
        path: [...n.path, 'arguments', 'parameters'],
        task: { dag: n.dag, name: n.id, uid: n.uid },
        source: 'client',
      })
    }
  }
  return out
}

/** Why test run is not offered right now, or null when it is (§6.7: no errors). */
export function testRunBlocker(state: DesignerState): string | null {
  const s = state.session
  if (s.frozen) return 'The YAML does not parse.'
  if (s.graph.resource.kind !== 'WorkflowTemplate') return 'Only a WorkflowTemplate can be test-run as a draft.'
  const errors = designerDiagnostics(state).filter((d) => d.level === 'error').length
  if (errors) return `Fix ${errors} error${errors === 1 ? '' : 's'} first.`
  return null
}
