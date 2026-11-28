import { isMap, isScalar, isSeq, Pair } from 'yaml'
import type { Document, YAMLMap, YAMLSeq } from 'yaml'
import type { Path, WfDoc } from './doc.ts'
import { createValue, deleteNode, DocEditError, edit, getIn, insertNode, mapStrings, nodeAt, own, setNode, setScalarString, toJS } from './doc.ts'
import type { Condition } from './depends.ts'
import { addTerm, conjunctionTerms, CONDITIONS, dependsTerms, fromDependencies, parseDepends, removeTask, renameTask, setCondition } from './depends.ts'
import type { CatalogueStep, TemplateRef } from './kinds.ts'
import { APPROVAL_REF, kindOfRef, palette, paletteEntry, refOf } from './kinds.ts'
import type { Positions } from './positions.ts'
import { decodePositions, encodePositions } from './positions.ts'
import { allNodes, project } from './project.ts'
import type { Shape, TaskAt, TemplateAt } from './shape.ts'
import { arr, obj, shapeOf, stepGroupsOf, str, TASK_NAME, tasksOf, templateUses, uidOf } from './shape.ts'
import { dependenciesOf } from './validate.ts'

/**
 * The designer's edits (design 0026 §6.5). Each takes a snapshot and returns
 * a new one: the document is cloned, mutated IN THE YAML TREE (so comments,
 * key order and every field the designer does not model stay put), printed
 * and parsed again (`doc.ts` `edit`).
 *
 * An operation is a plain object, so the canvas can log it, replay it and hand
 * it to `session.ts` for undo. Where an exact semantic inverse exists it is
 * returned (`inverse`); undo itself never relies on it — the session keeps
 * snapshots.
 *
 * Nodes are addressed by their canvas `uid`: the task name in the entry DAG,
 * `<template>/<task>` in the exit lane or a sub-flow.
 *
 * Pure: `ops_test.ts`, and the corpus (`roundtrip_test.ts`) runs rename,
 * connect and disconnect with their inverses over every real template.
 */

export const POSITIONS_ANNOTATION = 'adhar.io/designer-positions'
export const DRAFT_LABEL = 'adhar.io/workflow-draft'
export const DRAFT_EXPIRES_ANNOTATION = 'adhar.io/draft-expires'
export const HAS_APPROVALS_LABEL = 'adhar.io/has-approvals'
/** Kyverno #7 admits a draft whose expiry is at most this far ahead. */
export const DRAFT_TTL_MS = 7 * 86_400_000

export type Op =
  /** Drop a palette entry (`kinds.ts` `palette()` ids). `lane: 'exit'` adds to the exit handler, creating it when there is none. */
  | { op: 'addNode'; palette: string; at?: { x: number; y: number }; name?: string; dag?: string; lane?: 'exit' }
  /** Add a task that calls another template. `arguments` default to the entries the reference requires. */
  | { op: 'addRef'; ref: TemplateRef; at?: { x: number; y: number }; name?: string; dag?: string; lane?: 'exit'; arguments?: Array<{ name: string; value: string }> }
  /** `source` must finish (with `condition`; Succeeded writes the bare name) before `target` starts. */
  | { op: 'connect'; source: string; target: string; condition?: Condition; explicit?: boolean; index?: number }
  | { op: 'disconnect'; source: string; target: string }
  | { op: 'removeNode'; node: string; keepTemplate?: boolean }
  | { op: 'rename'; node: string; to: string }
  | { op: 'set'; path: Path; value: unknown }
  | { op: 'unset'; path: Path }
  | { op: 'insert'; path: Path; value: unknown; index?: number }
  /** Set (or with no `value`, remove) one of a task's `arguments.parameters`. */
  | { op: 'setArgument'; node: string; name: string; value?: string }
  /** Drag end: merge these into the positions annotation. */
  | { op: 'setPositions'; positions: Positions }
  /** Forget every saved position and write the automatic layout (one undo step). */
  | { op: 'autoLayout' }
  /** Rewrite a `steps` template (the entrypoint by default) as a DAG. */
  | { op: 'convertStepsToDag'; template?: string }
  /** Put a leaf entrypoint inside a new DAG so steps can be added around it. */
  | { op: 'wrapEntry' }
  /** `dependencies: [a, b]` → `depends: "a && b"`. */
  | { op: 'migrateDependencies'; node: string }
  /** Mark the template a draft that expires at `expires` (RFC 3339); see `draftExpiry`. */
  | { op: 'stampDraft'; expires: string }

export interface OpResult {
  doc: WfDoc
  /** What changed, in words — for the status line and for edits the user did not ask for by name (a migration, a kept template). */
  changes: string[]
  /** Operations that undo this one exactly, when such operations exist. */
  inverse?: Op[]
  /** `addNode` / `addRef`: the node that now exists. */
  created?: { uid: string; task: string; dag: string; template?: string }
}

export interface ApplyOptions {
  catalogue?: readonly CatalogueStep[]
}

export type OpErrorCode = 'unparseable' | 'not-editable' | 'not-found' | 'exists' | 'invalid-name' | 'cycle' | 'expression' | 'invalid'

export class OpError extends Error {
  constructor(readonly code: OpErrorCode, message: string) {
    super(message)
    this.name = 'OpError'
  }
}

const fail = (code: OpErrorCode, message: string): never => {
  throw new OpError(code, message)
}

/** When a draft saved at `now` expires: seven days on, to the second (Kyverno #7; the janitor deletes it after that). */
export function draftExpiry(now: Date): string {
  return new Date(now.getTime() + DRAFT_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/* ─────────────────────────── addressing ─────────────────────────── */

interface Target {
  shape: Shape
  dag: TemplateAt
  tasks: TaskAt[]
  task: TaskAt
}

function need(d: WfDoc): Shape {
  if (d.errors.length) fail('unparseable', 'The YAML has errors; fix them in the YAML panel first.')
  const shape = shapeOf(d)
  if (!shape.root || !shape.kind) fail('not-editable', 'This is not an Argo workflow document.')
  return shape
}

function dagOf(shape: Shape, name: string | undefined): TemplateAt {
  const n = name ?? shape.entry
  const t = n ? shape.byName.get(n) : undefined
  if (!t) return fail('not-found', n ? `There is no template "${n}".` : 'The workflow has no entrypoint.')
  if (t.body.dag === undefined) return fail('not-editable', `"${t.name}" is not a DAG; the canvas edits DAG templates.`)
  return t
}

function splitUid(shape: Shape, uid: string): { dag: string | undefined; task: string } {
  const i = uid.indexOf('/')
  return i < 0 ? { dag: shape.entry, task: uid } : { dag: uid.slice(0, i), task: uid.slice(i + 1) }
}

function locate(d: WfDoc, uid: string): Target {
  const shape = need(d)
  const { dag: dagName, task: name } = splitUid(shape, uid)
  const dag = dagOf(shape, dagName)
  const tasks = tasksOf(dag)
  const task = tasks.find((t) => t.name === name)
  if (!task) return fail('not-found', `There is no task "${name}" in "${dag.name}".`)
  return { shape, dag, tasks, task }
}

/* ─────────────────────────── YAML tree helpers ─────────────────────────── */

/**
 * The map at `path`, ready to be changed: an alias on the way is replaced by
 * its own copy and the map's merge keys are written out (`doc.ts` `own`), so
 * setting or deleting a key changes this map and nothing that shared it.
 */
function mapAt(doc: Document, path: Path): YAMLMap {
  const n = own(doc, path, { whole: true })
  if (!isMap(n)) throw new OpError('invalid', `${path.join('.')} is not a map.`)
  return n
}

/** The value at `path` as the document reads (aliases followed, merge keys folded in), and whether anything is there. */
function valueAt(d: WfDoc, path: Path): { found: boolean; value?: unknown } {
  let cur: unknown = toJS(d)
  for (const key of path) {
    if (Array.isArray(cur) && typeof key === 'number' && key >= 0 && key < cur.length) cur = cur[key]
    else if (cur && typeof cur === 'object' && !Array.isArray(cur) && Object.prototype.hasOwnProperty.call(cur, key)) cur = (cur as Record<string, unknown>)[key as string]
    else return { found: false }
  }
  return { found: true, value: cur }
}

/** Whether `to` can be reached from `from` along `edges`. */
function reaches(edges: ReadonlyArray<{ source: string; target: string }>, from: string, to: string): boolean {
  const seen = new Set([from])
  const queue = [from]
  while (queue.length) {
    const n = queue.pop()!
    if (n === to) return true
    for (const e of edges) {
      if (e.source === n && !seen.has(e.target)) {
        seen.add(e.target)
        queue.push(e.target)
      }
    }
  }
  return false
}

const keyIs = (p: Pair, key: string) => (isScalar(p.key) ? p.key.value : p.key) === key

/** Set `key` in a map, placing a NEW key right after `after` (so `depends` sits under `name`, where people write it). */
function setKeyAfter(doc: Document, map: YAMLMap, after: string, key: string, value: unknown): void {
  const existing = map.items.find((p) => keyIs(p, key))
  if (existing) {
    if (isScalar(existing.value) && typeof value === 'string') setScalarString(existing.value, value)
    else existing.value = createValue(doc, value)
    return
  }
  const pair = new Pair(createValue(doc, key), createValue(doc, value))
  const i = map.items.findIndex((p) => keyIs(p, after))
  map.items.splice(i < 0 ? map.items.length : i + 1, 0, pair as Pair<unknown, unknown>)
}

/** Replace `from: …` with `to: value` in place: the entry keeps its position and its comments. */
function replaceKey(doc: Document, map: YAMLMap, from: string, to: string, value: unknown): void {
  const pair = map.items.find((p) => keyIs(p, from))
  if (!pair) {
    map.items.push(new Pair(createValue(doc, to), createValue(doc, value)) as Pair<unknown, unknown>)
    return
  }
  if (isScalar(pair.key)) pair.key.value = to
  else pair.key = createValue(doc, to)
  const old = pair.value
  const next = createValue(doc, value)
  if (old && typeof old === 'object' && 'comment' in old && (old as { comment?: string | null }).comment) next.comment = (old as { comment?: string | null }).comment
  pair.value = next
}

/**
 * What undoes a `set` at `path`: the old value back, or — when the path was
 * not there — removing the shallowest thing the set had to create, so no empty
 * parent map is left behind.
 */
function unsetting(d: WfDoc, path: Path): Op {
  const was = valueAt(d, path)
  if (was.found) return { op: 'set', path, value: was.value }
  let n = path.length
  while (n > 1 && nodeAt(d, path.slice(0, n - 1)) === undefined) n--
  return { op: 'unset', path: path.slice(0, n) }
}

function unique(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2;; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

function readPositions(d: WfDoc | Document): Positions {
  return decodePositions(getIn(d, ['metadata', 'annotations', POSITIONS_ANNOTATION]))
}

function writePositions(doc: Document, positions: Positions): void {
  const path = ['metadata', 'annotations', POSITIONS_ANNOTATION]
  if (!Object.keys(positions).length) {
    deleteNode(doc, path)
    pruneEmpty(doc, ['metadata', 'annotations'])
    return
  }
  setNode(doc, path, encodePositions(positions))
}

/** Delete a map the edit just emptied (never one that was written empty on purpose: callers only prune what they emptied). */
function pruneEmpty(doc: Document, path: Path): void {
  const n = nodeAt(doc, path)
  if ((isMap(n) || isSeq(n)) && n.items.length === 0) deleteNode(doc, path)
}

/* ─────────────────────────── the operations ─────────────────────────── */

/** Apply one operation. Throws `OpError` — and nothing else — when it cannot apply; the input snapshot is never changed. */
export function applyOp(d: WfDoc, op: Op, opts: ApplyOptions = {}): OpResult {
  try {
    return run(d, op, opts)
  } catch (e) {
    // `doc.ts` refuses an edit it cannot write (a list where a map is needed, YAML the library cannot print); the canvas knows one error type.
    if (e instanceof DocEditError) throw new OpError('invalid', e.message)
    throw e
  }
}

function sameRef(a: TemplateRef, b: TemplateRef): boolean {
  return a.name === b.name && a.template === b.template && Boolean(a.clusterScope) === Boolean(b.clusterScope)
}

function run(d: WfDoc, op: Op, opts: ApplyOptions): OpResult {
  switch (op.op) {
    case 'addNode':
      return addNode(d, op, opts)
    case 'addRef': {
      // A step the catalogue knows brings its title and the arguments it REQUIRES (§6.5), as dropping it from the palette does.
      const known = palette(opts.catalogue, { batch: true, gamedays: true }).find((e) => e.ref !== undefined && sameRef(e.ref, op.ref))
      return addTask(d, { ...op, arguments: op.arguments ?? known?.arguments, title: known?.title ?? `${op.ref.name}/${op.ref.template}` }, opts)
    }
    case 'connect':
      return connect(d, op)
    case 'disconnect':
      return disconnect(d, op)
    case 'removeNode':
      return removeNode(d, op, opts)
    case 'rename':
      return rename(d, op)
    case 'set': {
      need(d)
      if (!op.path.length) fail('invalid', 'set needs a path.')
      // Setting a field to what it already holds is no edit: no reprint, no undo step.
      const was = valueAt(d, op.path)
      if (was.found && op.value !== undefined && JSON.stringify(was.value) === JSON.stringify(op.value)) return { doc: d, changes: [], inverse: [] }
      return {
        doc: edit(d, (doc) => setNode(doc, op.path, op.value)),
        changes: [`Set ${op.path.join('.')}`],
        inverse: [unsetting(d, op.path)],
      }
    }
    case 'unset': {
      need(d)
      const was = valueAt(d, op.path)
      if (!was.found) return { doc: d, changes: [], inverse: [] }
      const before = was.value
      const index = typeof op.path[op.path.length - 1] === 'number' ? (op.path[op.path.length - 1] as number) : undefined
      return {
        doc: edit(d, (doc) => void deleteNode(doc, op.path)),
        changes: [`Removed ${op.path.join('.')}`],
        inverse: [index === undefined ? { op: 'set', path: op.path, value: before } : { op: 'insert', path: op.path.slice(0, -1), value: before, index }],
      }
    }
    case 'insert': {
      need(d)
      let at = 0
      const doc = edit(d, (y) => void (at = insertNode(y, op.path, op.value, op.index)))
      return { doc, changes: [`Added to ${op.path.join('.')}`], inverse: [{ op: 'unset', path: [...op.path, at] }] }
    }
    case 'setArgument':
      return setArgument(d, op)
    case 'setPositions': {
      need(d)
      const current = readPositions(d)
      const next = { ...current, ...op.positions }
      // A drag that ends where it began writes nothing (and reprints nothing).
      if (encodePositions(next) === encodePositions(current)) return { doc: d, changes: [], inverse: [] }
      return {
        doc: edit(d, (doc) => writePositions(doc, next)),
        changes: [],
        inverse: [unsetting(d, ['metadata', 'annotations', POSITIONS_ANNOTATION])],
      }
    }
    case 'autoLayout': {
      need(d)
      const bare = nodeAt(d, ['metadata', 'annotations', POSITIONS_ANNOTATION]) ? edit(d, (doc) => writePositions(doc, {})) : d
      const laid: Positions = {}
      for (const n of allNodes(project(bare, { catalogue: opts.catalogue }), true)) laid[n.uid] = { x: n.position.x, y: n.position.y }
      return { doc: edit(bare, (doc) => writePositions(doc, laid)), changes: ['Laid out every step'] }
    }
    case 'convertStepsToDag':
      return convertStepsToDag(d, op.template)
    case 'wrapEntry':
      return wrapEntry(d)
    case 'migrateDependencies': {
      const { task } = locate(d, op.node)
      if (task.body.dependencies === undefined || task.body.depends !== undefined) return { doc: d, changes: [] }
      const deps = arr(task.body.dependencies).map(str).filter((s): s is string => Boolean(s))
      return {
        doc: edit(d, (doc) => {
          const map = mapAt(doc, task.path)
          if (deps.length) replaceKey(doc, map, 'dependencies', 'depends', fromDependencies(deps))
          else map.delete('dependencies')
        }),
        changes: [`"${task.name}": dependencies became depends`],
      }
    }
    case 'stampDraft': {
      need(d)
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(op.expires)) fail('invalid', 'A draft expiry is an RFC 3339 time.')
      return {
        doc: edit(d, (doc) => {
          setNode(doc, ['metadata', 'labels', DRAFT_LABEL], 'true')
          setNode(doc, ['metadata', 'annotations', DRAFT_EXPIRES_ANNOTATION], op.expires)
        }),
        changes: [],
      }
    }
  }
}

/** Apply several operations in order; one failing leaves the input as it was. */
export function applyOps(d: WfDoc, ops: readonly Op[], opts: ApplyOptions = {}): OpResult {
  let doc = d
  const changes: string[] = []
  let created: OpResult['created']
  for (const op of ops) {
    const r = applyOp(doc, op, opts)
    doc = r.doc
    changes.push(...r.changes)
    created = r.created ?? created
  }
  return { doc, changes, created }
}

/* ── add ── */

interface AddTask {
  at?: { x: number; y: number }
  name?: string
  dag?: string
  lane?: 'exit'
  /** A local template to create (body without `name`), or a reference. */
  template?: Record<string, unknown>
  ref?: TemplateRef
  arguments?: Array<{ name: string; value: string }>
  baseName?: string
  title: string
}

function addNode(d: WfDoc, op: Extract<Op, { op: 'addNode' }>, opts: ApplyOptions): OpResult {
  // The exit-handler entry is "a container step in the exit lane".
  const exit = op.palette === 'exit-handler'
  const entry = paletteEntry(exit ? 'container' : op.palette, opts.catalogue)
  if (!entry) return fail('not-found', `The palette has no entry "${op.palette}".`)
  if (entry.action === 'pick-ref') return fail('invalid', 'Pick the template to call first, then add it with addRef.')
  return addTask(d, {
    at: op.at,
    name: op.name,
    dag: op.dag,
    lane: exit ? 'exit' : op.lane,
    template: entry.action === 'local' ? entry.template!() : undefined,
    ref: entry.ref,
    arguments: entry.arguments,
    baseName: exit ? 'notify' : entry.baseName,
    title: entry.title,
  }, opts)
}

function addTask(d: WfDoc, a: AddTask, opts: ApplyOptions): OpResult {
  const shape = need(d)
  const changes: string[] = []
  const sp = shape.specPath
  const templateNames = new Set(shape.templates.map((t) => t.name))

  // Which DAG receives the task. The exit lane is created (or its leaf handler wrapped) on first use.
  let dagName = a.dag
  let createExit: { name: string; wraps?: TemplateAt } | undefined
  if (a.lane === 'exit' && !a.dag) {
    const current = shape.onExit ? shape.byName.get(shape.onExit) : undefined
    if (current && current.body.dag !== undefined) dagName = current.name
    else if (current && current.body.steps !== undefined) return fail('not-editable', `The exit handler "${current.name}" is a steps template; convert it to a DAG first.`)
    else {
      createExit = { name: unique('on-exit', templateNames), wraps: current }
      dagName = createExit.name
      templateNames.add(createExit.name)
    }
  }
  const dag = createExit ? undefined : dagOf(shape, dagName)
  const existingTasks = new Set(dag ? tasksOf(dag).map((t) => t.name) : createExit?.wraps ? [createExit.wraps.name] : [])

  const taken = new Set([...existingTasks, ...(a.template ? templateNames : [])])
  const base = a.baseName ?? a.ref?.template.replace(/[^A-Za-z0-9-]+/g, '-') ?? 'step'
  const name = a.name ?? unique(/^[A-Za-z]/.test(base) ? base : `step-${base}`, taken)
  if (!TASK_NAME.test(name)) fail('invalid-name', `"${name}" is not a usable name: letters, digits and -, starting with a letter or digit.`)
  if (existingTasks.has(name)) fail('exists', `There is already a task "${name}".`)
  if (a.template && templateNames.has(name)) fail('exists', `There is already a template "${name}".`)

  const task: Record<string, unknown> = { name }
  if (a.template) task.template = name
  else if (a.ref) {
    task.templateRef = { name: a.ref.name, template: a.ref.template, ...(a.ref.clusterScope ? { clusterScope: true } : {}) }
    if (a.arguments?.length) task.arguments = { parameters: a.arguments.map((p) => ({ name: p.name, value: p.value })) }
  } else fail('invalid', 'A task needs a template or a reference.')

  const approval = a.ref ? kindOfRef(a.ref, opts.catalogue) === 'approval' : false
  const finalDag = dagName ?? shape.entry!
  const uid = uidOf(shape.entry, finalDag, name)

  const doc = edit(d, (y) => {
    if (a.template) insertNode(y, [...sp, 'templates'], { name, ...a.template })
    if (createExit) {
      const tasks: unknown[] = createExit.wraps ? [{ name: createExit.wraps.name, template: createExit.wraps.name }] : []
      insertNode(y, [...sp, 'templates'], { name: createExit.name, dag: { tasks: [...tasks, task] } })
      setNode(y, [...sp, 'onExit'], createExit.name)
    } else {
      insertNode(y, [...dag!.path, 'dag', 'tasks'], task)
    }
    if (approval) setNode(y, [...sp, 'workflowMetadata', 'labels', HAS_APPROVALS_LABEL], 'true')
    if (a.at) writePositions(y, { ...readPositions(y), [uid]: a.at })
  })
  changes.push(`Added ${a.title} "${name}"`)
  if (createExit) changes.push(createExit.wraps ? `The exit handler "${createExit.wraps.name}" now runs inside the new exit lane "${createExit.name}"` : `Created the exit lane "${createExit.name}"`)
  return {
    doc,
    changes,
    created: { uid, task: name, dag: finalDag, template: a.template ? name : undefined },
    inverse: createExit ? undefined : [{ op: 'removeNode', node: uid }],
  }
}

/* ── connect / disconnect ── */

function sameDag(shape: Shape, a: string, b: string): { dag: TemplateAt; source: string; target: string } {
  const s = splitUid(shape, a)
  const t = splitUid(shape, b)
  if (s.dag !== t.dag) fail('invalid', 'Steps in different graphs cannot depend on each other.')
  return { dag: dagOf(shape, t.dag), source: s.task, target: t.task }
}

function connect(d: WfDoc, op: Extract<Op, { op: 'connect' }>): OpResult {
  const shape = need(d)
  const { dag, source, target } = sameDag(shape, op.source, op.target)
  const tasks = tasksOf(dag)
  const from = tasks.find((t) => t.name === source) ?? fail('not-found', `There is no task "${source}" in "${dag.name}".`)
  const to = tasks.find((t) => t.name === target) ?? fail('not-found', `There is no task "${target}" in "${dag.name}".`)
  if (from.name === to.name) fail('cycle', 'A step cannot depend on itself.')
  if (op.condition !== undefined && !(CONDITIONS as readonly string[]).includes(op.condition)) fail('invalid', `"${op.condition}" is not a result Argo knows.`)

  const edges = tasks.flatMap((t) => dependenciesOf(t.body).map((s) => ({ source: s, target: t.name })))
  const already = edges.some((e) => e.source === source && e.target === target)
  // Only a circle THIS edge would close refuses it: a document that already holds one elsewhere (validation says so) can still be edited.
  if (!already && reaches(edges, target, source)) {
    fail('cycle', `"${source}" already waits for "${target}"; connecting them the other way round would make a circle.`)
  }

  // Succeeded is written as the bare name unless the explicit form is asked for.
  const cond: Condition | undefined = op.condition === undefined || (op.condition === 'Succeeded' && !op.explicit) ? undefined : op.condition
  const changes: string[] = []
  const undo: Op[] = [{ op: 'disconnect', source: op.source, target: op.target }]
  let inverse: Op[] | undefined = undo
  const depends = str(to.body.depends)
  const hasDepends = to.body.depends !== undefined && depends !== undefined && depends.trim() !== ''
  const legacy = to.body.dependencies !== undefined && !hasDepends

  const doc = edit(d, (y) => {
    const map = mapAt(y, to.path)
    if (hasDepends) {
      const parsed = parseDepends(depends!)
      if (!parsed.ok) return fail('expression', `depends of "${target}" does not parse (${parsed.message}); fix it in the inspector first.`)
      const pure = conjunctionTerms(depends!)
      const present = dependsTerms(depends!).find((t) => t.task === source)
      if (present && !pure) return fail('expression', `"${target}" already names "${source}" in an expression; edit it as text in the inspector.`)
      if (present) {
        if (present.condition === cond) {
          inverse = []
          return
        }
        setKeyAfter(y, map, 'name', 'depends', setCondition(depends!, source, cond))
        inverse = [{ op: 'connect', source: op.source, target: op.target, condition: present.condition ?? 'Succeeded', explicit: present.condition === 'Succeeded' }]
        changes.push(`"${target}" now waits for "${source}" to be ${cond ?? 'Succeeded'}`)
        return
      }
      setKeyAfter(y, map, 'name', 'depends', addTerm(depends!, source, cond, op.index))
    } else if (legacy) {
      const deps = arr(to.body.dependencies).map(str).filter((s): s is string => Boolean(s))
      if (cond === undefined) {
        if (deps.includes(source)) {
          inverse = []
          return
        }
        insertNode(y, [...to.path, 'dependencies'], source, op.index)
      } else {
        // Any other result cannot be said in a `dependencies` list, and a task may not have both (Argo's CEL rule).
        const rest = deps.filter((x) => x !== source)
        replaceKey(y, map, 'dependencies', 'depends', addTerm(fromDependencies(rest), source, cond, op.index))
        changes.push(`"${target}": dependencies became depends, to say "${source}.${cond}"`)
        inverse = undefined
      }
    } else {
      if (to.body.depends !== undefined) map.delete('depends')
      if (to.body.continueOn !== undefined) changes.push(`"${target}" has continueOn, which Argo refuses together with depends`)
      setKeyAfter(y, map, 'name', 'depends', addTerm('', source, cond))
    }
  })
  if (!changes.length && inverse !== undefined && inverse.length) changes.push(`"${target}" now waits for "${source}"`)
  return { doc: inverse !== undefined && inverse.length === 0 ? d : doc, changes, inverse }
}

function disconnect(d: WfDoc, op: Extract<Op, { op: 'disconnect' }>): OpResult {
  const shape = need(d)
  const { dag, source, target } = sameDag(shape, op.source, op.target)
  const to = tasksOf(dag).find((t) => t.name === target) ?? fail('not-found', `There is no task "${target}" in "${dag.name}".`)
  const depends = str(to.body.depends)
  let inverse: Op[] = []
  let changed = false
  const doc = edit(d, (y) => {
    const map = mapAt(y, to.path)
    if (to.body.depends !== undefined && depends !== undefined && depends.trim()) {
      const parsed = parseDepends(depends)
      if (!parsed.ok) return fail('expression', `depends of "${target}" does not parse (${parsed.message}); fix it in the inspector first.`)
      if (!dependsTerms(depends).some((t) => t.task === source)) return
      const pure = conjunctionTerms(depends)
      const r = removeTask(depends, source)
      if (r.depends === undefined) map.delete('depends')
      else setKeyAfter(y, map, 'name', 'depends', r.depends)
      changed = true
      inverse = pure
        ? [{ op: 'connect', source: op.source, target: op.target, condition: r.term?.condition ?? 'Succeeded', explicit: r.term?.condition === 'Succeeded', index: r.index }]
        : [{ op: 'set', path: [...to.path, 'depends'], value: depends }]
      return
    }
    const deps = arr(to.body.dependencies).map(str)
    const i = deps.indexOf(source)
    if (i < 0) return
    changed = true
    if (deps.length === 1) map.delete('dependencies')
    else deleteNode(y, [...to.path, 'dependencies', i])
    inverse = deps.length === 1
      ? [{ op: 'set', path: [...to.path, 'dependencies'], value: [source] }]
      : [{ op: 'connect', source: op.source, target: op.target, index: i }]
  })
  return changed ? { doc, changes: [`"${target}" no longer waits for "${source}"`], inverse } : { doc: d, changes: [], inverse: [] }
}

/* ── remove ── */

function removeNode(d: WfDoc, op: Extract<Op, { op: 'removeNode' }>, opts: ApplyOptions): OpResult {
  const { shape, dag, tasks, task } = locate(d, op.node)
  const changes = [`Removed "${task.name}"`]
  const local = task.body.templateRef === undefined ? str(task.body.template) : undefined
  const tmpl = local ? shape.byName.get(local) : undefined
  // Who else uses the template: every use except this task's own.
  const self = `${dag.name}/${task.name}`
  const others = tmpl ? (templateUses(shape).get(tmpl.name) ?? []).filter((u) => u !== self) : []
  const dropTemplate = Boolean(tmpl) && !op.keepTemplate && others.length === 0
  if (tmpl && !dropTemplate) {
    changes.push(op.keepTemplate ? `Kept the template "${tmpl.name}"` : `Kept the template "${tmpl.name}": ${others.join(', ')} still use${others.length === 1 ? 's' : ''} it`)
  }
  const wasApproval = refOf(task.body) ? kindOfRef(refOf(task.body)!, opts.catalogue) === 'approval' : false
  const otherApprovals = shape.templates.some((t) =>
    [...tasksOf(t), ...stepGroupsOf(t).flat()].some((c) => !(t.name === dag.name && c.name === task.name) && refOf(c.body) !== undefined && kindOfRef(refOf(c.body)!, opts.catalogue) === 'approval')
  )
  const sp = shape.specPath

  const doc = edit(d, (y) => {
    for (const other of tasks) {
      if (other.name === task.name) continue
      const depends = str(other.body.depends)
      if (other.body.depends !== undefined && depends && dependsTerms(depends).some((t) => t.task === task.name)) {
        const map = mapAt(y, other.path)
        const r = removeTask(depends, task.name)
        if (r.depends === undefined) map.delete('depends')
        else setKeyAfter(y, map, 'name', 'depends', r.depends)
      }
      const deps = arr(other.body.dependencies).map(str)
      if (deps.includes(task.name)) {
        const map = mapAt(y, other.path)
        const rest = deps.filter((x) => x !== task.name)
        if (rest.length) {
          // Highest index first, so earlier deletions do not shift later ones.
          deps.map((x, i) => (x === task.name ? i : -1)).filter((i) => i >= 0).reverse().forEach((i) => deleteNode(y, [...other.path, 'dependencies', i]))
        } else map.delete('dependencies')
      }
    }
    deleteNode(y, task.path)
    if (dropTemplate) deleteNode(y, tmpl!.path)
    if (wasApproval && !otherApprovals) {
      const labels = [...sp, 'workflowMetadata', 'labels']
      if (deleteNode(y, [...labels, HAS_APPROVALS_LABEL])) {
        pruneEmpty(y, labels)
        pruneEmpty(y, [...sp, 'workflowMetadata'])
      }
    }
    const positions = readPositions(y)
    const uid = uidOf(shape.entry, dag.name, task.name)
    if (uid in positions) {
      delete positions[uid]
      writePositions(y, positions)
    }
  })
  return { doc, changes }
}

/* ── rename ── */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrite `tasks.<from>` (and `tasks['<from>']`) to the new name, on TOKEN
 * boundaries: renaming `build` must leave `tasks.build-image` and
 * `subtasks.build` alone.
 */
export function renameTaskTokens(text: string, from: string, to: string, root: 'tasks' | 'steps' = 'tasks', toRoot: 'tasks' | 'steps' = root): string {
  const dotted = new RegExp(`(?<![A-Za-z0-9_.-])${root}\\.${escapeRe(from)}(?![A-Za-z0-9_-])`, 'g')
  const bracket = new RegExp(`(?<![A-Za-z0-9_.-])${root}\\[(\\s*)(['"])${escapeRe(from)}\\2(\\s*)\\]`, 'g')
  return text.replace(dotted, `${toRoot}.${to}`).replace(bracket, `${toRoot}[$1$2${to}$2$3]`)
}

function rename(d: WfDoc, op: Extract<Op, { op: 'rename' }>): OpResult {
  const { shape, dag, tasks, task } = locate(d, op.node)
  const from = task.name
  const to = op.to
  if (from === to) return { doc: d, changes: [], inverse: [] }
  if (!TASK_NAME.test(to)) fail('invalid-name', `"${to}" is not a usable name: letters, digits and -, starting with a letter or digit.`)
  if (tasks.some((t) => t.name === to)) fail('exists', `There is already a task "${to}" in "${dag.name}".`)
  const oldUid = uidOf(shape.entry, dag.name, from)
  const newUid = uidOf(shape.entry, dag.name, to)

  const doc = edit(d, (y) => {
    setNode(y, [...task.path, 'name'], to)
    const tasksPath = [...dag.path, 'dag', 'tasks']
    mapStrings(y, dag.path, (value, at) => {
      const key = at[at.length - 1]
      const inTask = at.length > tasksPath.length && tasksPath.every((k, i) => at[i] === k)
      if (inTask && at.length === tasksPath.length + 2) {
        if (key === 'depends') return renameTask(value, from, to)
        if (key === 'name') return value
      }
      if (inTask && at.length === tasksPath.length + 3 && at[at.length - 2] === 'dependencies') return value === from ? to : value
      if (at.length === dag.path.length + 2 && at[at.length - 2] === 'dag' && key === 'target') {
        return value.split(/(\s+)/).map((tok) => (tok === from ? to : tok)).join('')
      }
      return renameTaskTokens(value, from, to)
    })
    const positions = readPositions(y)
    if (oldUid in positions) {
      positions[newUid] = positions[oldUid]
      delete positions[oldUid]
      writePositions(y, positions)
    }
  })
  return { doc, changes: [`Renamed "${from}" to "${to}"`], inverse: [{ op: 'rename', node: newUid, to: from }] }
}

/* ── arguments ── */

function setArgument(d: WfDoc, op: Extract<Op, { op: 'setArgument' }>): OpResult {
  const { task } = locate(d, op.node)
  const params = arr(obj(task.body.arguments)?.parameters)
  const i = params.findIndex((p) => str(obj(p)?.name) === op.name)
  const list = [...task.path, 'arguments', 'parameters']
  const before = i >= 0 ? str(obj(params[i])?.value) : undefined
  if (op.value === undefined && i < 0) return { doc: d, changes: [], inverse: [] }
  if (op.value !== undefined && before === op.value) return { doc: d, changes: [], inverse: [] }
  const doc = edit(d, (y) => {
    if (op.value === undefined) {
      deleteNode(y, [...list, i])
      pruneEmpty(y, list)
      pruneEmpty(y, [...task.path, 'arguments'])
    } else if (i >= 0) setNode(y, [...list, i, 'value'], op.value)
    else insertNode(y, list, { name: op.name, value: op.value })
  })
  return {
    doc,
    changes: [`Set ${op.name} of "${task.name}"`],
    inverse: [{ op: 'setArgument', node: op.node, name: op.name, value: before }],
  }
}

/* ── steps → DAG, leaf → DAG ── */

function convertStepsToDag(d: WfDoc, template: string | undefined): OpResult {
  const shape = need(d)
  const name = template ?? shape.entry
  const t = name ? shape.byName.get(name) : undefined
  if (!t) return fail('not-found', name ? `There is no template "${name}".` : 'The workflow has no entrypoint.')
  if (t.body.steps === undefined) return fail('invalid', `"${t.name}" is not a steps template.`)
  const groups = stepGroupsOf(t)
  const names = groups.flat().map((s) => s.name)
  if (new Set(names).size !== names.length) fail('invalid', 'Two steps share a name; a DAG needs each task named once. Rename one in the YAML first.')
  const changes = [`"${t.name}" is now a DAG: each group waits for the group before it`]

  const tolerant = (s: TaskAt): string => {
    const c = obj(s.body.continueOn)
    if (!c) return s.name
    const also = [c.failed === true ? `${s.name}.Failed` : '', c.error === true ? `${s.name}.Errored` : ''].filter(Boolean)
    if (!also.length) return s.name
    changes.push(`continueOn of "${s.name}" is now said in the depends of the steps after it`)
    return `(${s.name}.Succeeded || ${s.name}.Skipped || ${s.name}.Daemoned || ${also.join(' || ')})`
  }

  const doc = edit(d, (y) => {
    const tmap = mapAt(y, t.path)
    const stepsPath = [...t.path, 'steps']
    const stepsSeq = own(y, stepsPath)
    if (!isSeq(stepsSeq)) return fail('invalid', `"${t.name}".steps is not a list.`)
    const tasks: unknown[] = []
    // The group a group waits for is the last one BEFORE it that holds a step: an empty group (`- []`) runs nothing and must not cut the chain.
    let prev: TaskAt[] = []
    ;(stepsSeq as YAMLSeq).items.forEach((_group, g) => {
      // A group or a step written as an alias (`- *deploy`) becomes this template's own copy first; it is about to be changed.
      const groupNode = own(y, [...stepsPath, g])
      if (!isSeq(groupNode) || !groupNode.items.length) return
      const depends = prev.map(tolerant).join(' && ')
      groupNode.items.forEach((_step, i) => {
        const stepNode = own(y, [...stepsPath, g, i], { whole: true })
        if (!isMap(stepNode)) return fail('invalid', `Step ${i + 1} of group ${g + 1} in "${t.name}" is not a map; fix it in the YAML first.`)
        // A comment written above the group belongs to its first task now.
        if (i === 0 && groupNode.commentBefore) {
          stepNode.commentBefore = [groupNode.commentBefore, stepNode.commentBefore].filter(Boolean).join('\n')
        }
        stepNode.flow = false
        if (stepNode.has('continueOn')) stepNode.delete('continueOn')
        if (depends) {
          setKeyAfter(y, stepNode, 'name', 'depends', depends)
          const stepName = groups[g]?.[i]?.name ?? ''
          if (/^[0-9]/.test(stepName)) changes.push(`"${stepName}" begins with a digit, which a DAG task that waits for another may not: rename it`)
        }
        tasks.push(stepNode)
      })
      prev = groups[g] ?? []
    })
    const pair = tmap.items.find((p) => keyIs(p, 'steps'))!
    if (isScalar(pair.key)) pair.key.value = 'dag'
    const dagMap = y.createNode({}) as YAMLMap
    const seq = y.createNode([]) as YAMLSeq
    seq.items = tasks
    // A comment above the first group is held by the list itself; it stays above the first task.
    seq.commentBefore = stepsSeq.commentBefore
    // (`map.set` would store a bare string key, which the string walk below does not descend through.)
    dagMap.items.push(new Pair(createValue(y, 'tasks'), seq) as Pair<unknown, unknown>)
    pair.value = dagMap
    // `{{steps.x.…}}` reads become `{{tasks.x.…}}`.
    mapStrings(y, t.path, (value) => names.reduce((v, n) => renameTaskTokens(v, n, n, 'steps', 'tasks'), value))
  })
  return { doc, changes }
}

function wrapEntry(d: WfDoc): OpResult {
  const shape = need(d)
  const leaf = shape.entry ? shape.byName.get(shape.entry) : undefined
  if (!leaf) return fail('not-found', 'The workflow has no entrypoint to wrap.')
  if (leaf.body.dag !== undefined || leaf.body.steps !== undefined) return fail('invalid', `"${leaf.name}" already holds steps.`)
  const name = unique('main', new Set(shape.templates.map((t) => t.name)))
  const taskName = TASK_NAME.test(leaf.name) ? leaf.name : 'step'
  const params = arr(obj(leaf.body.inputs)?.parameters).map((p) => str(obj(p)?.name)).filter((n): n is string => Boolean(n))
  const task: Record<string, unknown> = { name: taskName, template: leaf.name }
  // An entrypoint takes its inputs from the workflow's arguments by name; as a task it has to be handed them.
  if (params.length) task.arguments = { parameters: params.map((p) => ({ name: p, value: `{{workflow.parameters.${p}}}` })) }
  const changes = [`"${leaf.name}" now runs as the first step of the new DAG "${name}"`]
  if (arr(obj(leaf.body.inputs)?.artifacts).length) changes.push(`"${leaf.name}" takes input artifacts; pass them to the task in the YAML`)
  const doc = edit(d, (y) => {
    insertNode(y, [...shape.specPath, 'templates'], { name, dag: { tasks: [task] } }, leaf.index)
    setNode(y, [...shape.specPath, 'entrypoint'], name)
  })
  return { doc, changes, created: { uid: taskName, task: taskName, dag: name } }
}

/** Whether the document references the platform's approval step anywhere (the `has-approvals` label must agree). */
export function usesApprovals(d: WfDoc, catalogue: readonly CatalogueStep[] = []): boolean {
  const shape = shapeOf(d)
  return shape.templates.some((t) => [...tasksOf(t), ...stepGroupsOf(t).flat()].some((c) => refOf(c.body) !== undefined && kindOfRef(refOf(c.body)!, catalogue) === 'approval'))
}

export { APPROVAL_REF }
