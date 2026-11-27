import type { Path, WfDoc } from './doc.ts'
import type { Condition } from './depends.ts'
import { conjunctionTerms, dependsTerms } from './depends.ts'
import type { CatalogueStep, NodeKind, TemplateRef } from './kinds.ts'
import { inferKind, kindOfTemplate, refOf } from './kinds.ts'
import { CARD_WIDTH, layoutGraph, RUN_CARD_HEIGHT } from './layout.ts'
import { decodePositions } from './positions.ts'
import type { ResourceKind, Shape, TaskAt, TemplateAt } from './shape.ts'
import { arr, obj, shapeOf, stepGroupsOf, str, tasksOf, uidOf } from './shape.ts'
import type { Diagnostic, ValidateOptions } from './validate.ts'
import { validate } from './validate.ts'

/**
 * Document → canvas (design 0026 §6.5). The graph is DERIVED from the
 * document every time and never stored: there is no second copy of the
 * workflow that could disagree with the YAML.
 *
 * The projection reads only what the canvas draws — tasks, the templates they
 * name, `depends`, a handful of badge fields. Everything else in the document
 * is left where it is, which is how it survives.
 *
 * Deterministic: the same document and catalogue give the same graph, in the
 * same order, with the same coordinates. Pure: `project_test.ts`.
 */

export type EdgeCondition = Condition | 'Expression'

export type ReadOnlyReason =
  /** The YAML does not parse; the canvas keeps its last good projection. */
  | 'yaml-errors'
  | 'not-a-workflow'
  /** No entrypoint: a step library, or a run that only references a template. */
  | 'no-entry'
  /** The entrypoint names a template that is not there. */
  | 'missing-entry'
  /** A `steps` entrypoint: read-only columns, with "Convert to DAG". */
  | 'steps'
  /** The entrypoint is a single leaf template; "Wrap in a DAG" makes it editable. */
  | 'leaf-entry'

export interface DesignerParam {
  name: string
  value?: string
  enum?: string[]
  description?: string
  secretRef?: { name: string; key: string }
  path: Path
}

export interface DesignerNode {
  /** Canvas-unique: the task name in the entry DAG, `<template>/<task>` elsewhere. Also its positions key. */
  uid: string
  /** The task name. */
  id: string
  /** The DAG (or steps) template that holds the task. */
  dag: string
  lane: 'main' | 'exit'
  kind: NodeKind
  /** The catalogue's title for a referenced step. */
  title?: string
  template: { local?: string; ref?: TemplateRef }
  /** Document path of the local template, when there is one (inspector edits go there). */
  templatePath?: Path
  /** Other tasks using the same local template: editing it changes them too. */
  sharedBy: number
  badges: {
    when?: string
    retry?: number
    timeout?: string
    fanOut?: 'items' | 'param' | 'sequence'
    hooks?: number
    continueOn?: boolean
    /** `depends` is not a plain conjunction: edited as text in the inspector. */
    expression?: boolean
  }
  position: { x: number; y: number; fromAnnotation: boolean }
  /** Document path of the task. */
  path: Path
  /** `steps` entrypoints: the parallel group this step is in. */
  column?: number
  /** A sub-flow: the nested DAG it runs, drawn collapsed until opened. */
  group?: { template: string; nodes: DesignerNode[]; edges: DesignerEdge[]; recursive?: boolean }
}

export interface DesignerEdge {
  id: string
  source: string
  target: string
  condition: EdgeCondition
  /** A bare name in `depends` (Argo: Succeeded, Skipped or Daemoned) rather than an explicit `.Succeeded`. */
  bare?: boolean
  /** From a legacy `dependencies` list. */
  legacy?: boolean
  /** The whole `depends`, when it is not a pure conjunction. */
  expression?: string
}

export interface DesignerGraph {
  resource: { kind?: ResourceKind; name: string; namespace?: string }
  /** `spec.entrypoint` (CronWorkflow: `spec.workflowSpec.entrypoint`); '' when there is none. */
  entry: string
  /** The canvas may edit the main graph. */
  editable: boolean
  readOnly?: ReadOnlyReason
  params: DesignerParam[]
  nodes: DesignerNode[]
  edges: DesignerEdge[]
  exitLane?: { template: string; editable: boolean; nodes: DesignerNode[]; edges: DesignerEdge[] }
  /** Every local template: what it is and who uses it (the template list beside the canvas). */
  templates: Array<{ name: string; kind: NodeKind; path: Path; usedBy: string[] }>
  diagnostics: Diagnostic[]
}

export interface ProjectOptions {
  /** The step libraries on the cluster (`kinds.ts` `catalogueSteps`); kinds and titles of references come from here. */
  catalogue?: readonly CatalogueStep[]
  validate?: ValidateOptions
}

/** Designer cards are the run view's cards (§6.8), so the two graphs line up. */
export const COL_GAP = CARD_WIDTH + 64
export const ROW_GAP = RUN_CARD_HEIGHT + 28
export const LANE_GAP = 56
/** How deep nested sub-flows are projected; deeper ones stay collapsed with no children. */
const MAX_GROUP_DEPTH = 4

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

interface Ctx {
  shape: Shape
  catalogue: readonly CatalogueStep[]
  templates: Map<string, unknown>
  uses: Map<string, number>
  positions: ReturnType<typeof decodePositions>
}

function nodeOf(ctx: Ctx, dag: string, lane: 'main' | 'exit', task: TaskAt, depth: number, trail: readonly string[]): DesignerNode {
  const b = task.body
  const local = b.templateRef === undefined && b.inline === undefined ? str(b.template) : undefined
  const ref = refOf(b)
  const tmpl = local ? ctx.shape.byName.get(local) : undefined
  const kind = inferKind(b, ctx.templates, ctx.catalogue)
  const step = ref ? ctx.catalogue.find((s) => s.ref.name === ref.name && s.ref.template === ref.template && Boolean(ref.clusterScope) === Boolean(s.ref.clusterScope)) : undefined
  const tb = tmpl?.body
  const depends = str(b.depends)
  const badges: DesignerNode['badges'] = {}
  if (b.when !== undefined && b.when !== '') badges.when = str(b.when)
  const retry = num(obj(tb?.retryStrategy)?.limit)
  if (retry !== undefined) badges.retry = retry
  const timeout = str(tb?.timeout) || (tb?.activeDeadlineSeconds !== undefined ? `${str(tb.activeDeadlineSeconds)}s` : undefined)
  if (timeout) badges.timeout = timeout
  if (b.withItems !== undefined) badges.fanOut = 'items'
  else if (b.withParam !== undefined) badges.fanOut = 'param'
  else if (b.withSequence !== undefined) badges.fanOut = 'sequence'
  const hooks = Object.keys(obj(b.hooks) ?? {}).length
  if (hooks) badges.hooks = hooks
  if (b.continueOn !== undefined) badges.continueOn = true
  if (depends !== undefined && depends.trim() && conjunctionTerms(depends) === null) badges.expression = true

  const uid = uidOf(ctx.shape.entry, dag, task.name)
  const node: DesignerNode = {
    uid,
    id: task.name,
    dag,
    lane,
    kind,
    title: step?.title,
    template: { ...(local ? { local } : {}), ...(ref ? { ref } : {}) },
    templatePath: tmpl?.path,
    sharedBy: local ? Math.max(0, (ctx.uses.get(local) ?? 1) - 1) : 0,
    badges,
    position: { x: 0, y: 0, fromAnnotation: false },
    path: task.path,
  }
  if (kind === 'subflow' && tmpl) {
    if (trail.includes(tmpl.name)) node.group = { template: tmpl.name, nodes: [], edges: [], recursive: true }
    else if (depth < MAX_GROUP_DEPTH) {
      const inner = projectDag(ctx, tmpl, lane, depth + 1, [...trail, tmpl.name])
      node.group = { template: tmpl.name, ...inner }
    } else node.group = { template: tmpl.name, nodes: [], edges: [] }
  }
  return node
}

function edgesInto(dag: string, entry: string | undefined, task: TaskAt, names: ReadonlySet<string>): DesignerEdge[] {
  const target = uidOf(entry, dag, task.name)
  const edge = (source: string, rest: Omit<DesignerEdge, 'id' | 'source' | 'target'>): DesignerEdge => {
    const s = uidOf(entry, dag, source)
    return { id: `${s}->${target}`, source: s, target, ...rest }
  }
  const depends = str(task.body.depends)
  if (depends !== undefined && depends.trim()) {
    const pure = conjunctionTerms(depends)
    if (pure) return pure.filter((t) => names.has(t.task)).map((t) => edge(t.task, { condition: t.condition ?? 'Succeeded', ...(t.condition ? {} : { bare: true }) }))
    const seen = new Set<string>()
    const out: DesignerEdge[] = []
    for (const t of dependsTerms(depends)) {
      if (!names.has(t.task) || seen.has(t.task)) continue
      seen.add(t.task)
      out.push(edge(t.task, { condition: 'Expression', expression: depends }))
    }
    return out
  }
  const seen = new Set<string>()
  return arr(task.body.dependencies).map(str).filter((s): s is string => Boolean(s) && names.has(s!) && !seen.has(s!) && Boolean(seen.add(s!))).map((s) => edge(s, { condition: 'Succeeded', legacy: true }))
}

function place(ctx: Ctx, nodes: DesignerNode[], edges: DesignerEdge[], offsetY = 0): number {
  const laid = layoutGraph(nodes.map((n) => ({ id: n.uid })), edges, { colGap: COL_GAP, rowGap: ROW_GAP })
  let bottom = 0
  for (const n of nodes) {
    const saved = ctx.positions[n.uid]
    const p = saved ?? { x: laid[n.uid]?.x ?? 0, y: (laid[n.uid]?.y ?? 0) + offsetY }
    n.position = { x: p.x, y: p.y, fromAnnotation: Boolean(saved) }
    bottom = Math.max(bottom, n.position.y + RUN_CARD_HEIGHT)
  }
  return bottom
}

function projectDag(ctx: Ctx, t: TemplateAt, lane: 'main' | 'exit', depth: number, trail: readonly string[], offsetY = 0): { nodes: DesignerNode[]; edges: DesignerEdge[]; bottom: number } {
  const tasks = tasksOf(t)
  const names = new Set(tasks.map((x) => x.name))
  const nodes = tasks.map((task) => nodeOf(ctx, t.name, lane, task, depth, trail))
  const edges = tasks.flatMap((task) => edgesInto(t.name, ctx.shape.entry, task, names))
  const bottom = place(ctx, nodes, edges, offsetY)
  return { nodes, edges, bottom }
}

function projectSteps(ctx: Ctx, t: TemplateAt, lane: 'main' | 'exit', offsetY = 0): { nodes: DesignerNode[]; edges: DesignerEdge[]; bottom: number } {
  const groups = stepGroupsOf(t)
  const nodes: DesignerNode[] = []
  const edges: DesignerEdge[] = []
  let bottom = 0
  groups.forEach((group, column) => {
    group.forEach((step, row) => {
      const n = nodeOf(ctx, t.name, lane, step, MAX_GROUP_DEPTH, [t.name])
      n.column = column
      const saved = ctx.positions[n.uid]
      n.position = saved ? { ...saved, fromAnnotation: true } : { x: column * COL_GAP, y: offsetY + row * ROW_GAP, fromAnnotation: false }
      bottom = Math.max(bottom, n.position.y + RUN_CARD_HEIGHT)
      nodes.push(n)
      for (const prev of column > 0 ? groups[column - 1] : []) {
        const s = uidOf(ctx.shape.entry, t.name, prev.name)
        edges.push({ id: `${s}->${n.uid}`, source: s, target: n.uid, condition: 'Succeeded', bare: true })
      }
    })
  })
  return { nodes, edges, bottom }
}

/** A leaf template as the single node of a lane (a leaf entrypoint, a leaf exit handler). */
function leafNode(ctx: Ctx, t: TemplateAt, lane: 'main' | 'exit', offsetY = 0): DesignerNode {
  const uid = lane === 'exit' ? uidOf(ctx.shape.entry, 'onExit', t.name) : t.name
  const saved = ctx.positions[uid]
  return {
    uid,
    id: t.name,
    dag: '',
    lane,
    kind: kindOfTemplate(t.body),
    template: { local: t.name },
    templatePath: t.path,
    sharedBy: Math.max(0, ctx.uses.get(t.name) ?? 0),
    badges: {},
    position: saved ? { ...saved, fromAnnotation: true } : { x: 0, y: offsetY, fromAnnotation: false },
    path: t.path,
  }
}

function paramsOf(shape: Shape): DesignerParam[] {
  const base = [...shape.specPath, 'arguments', 'parameters']
  const out: DesignerParam[] = []
  arr(obj(shape.spec.arguments)?.parameters).forEach((p, i) => {
    const param = obj(p)
    const name = str(param?.name)
    if (!param || !name) return
    const secret = obj(obj(param.valueFrom)?.secretKeyRef)
    const en = arr(param.enum).map(str).filter((e): e is string => e !== undefined)
    out.push({
      name,
      value: str(param.value) ?? str(param.default),
      enum: en.length ? en : undefined,
      description: str(param.description),
      secretRef: secret && str(secret.name) && str(secret.key) ? { name: str(secret.name)!, key: str(secret.key)! } : undefined,
      path: [...base, i],
    })
  })
  return out
}

/** Project a document onto the canvas. */
export function project(d: WfDoc, opts: ProjectOptions = {}): DesignerGraph {
  const diagnostics = validate(d, opts.validate)
  const empty = (readOnly: ReadOnlyReason, resource: DesignerGraph['resource'] = { name: '' }): DesignerGraph => ({
    resource,
    entry: '',
    editable: false,
    readOnly,
    params: [],
    nodes: [],
    edges: [],
    templates: [],
    diagnostics,
  })
  if (d.errors.length) return empty('yaml-errors')
  const shape = shapeOf(d)
  const resource = { kind: shape.kind, name: shape.name, namespace: shape.namespace }
  if (!shape.root || !shape.kind) return empty('not-a-workflow', resource)

  const uses = new Map<string, number>()
  const usedBy = new Map<string, string[]>()
  for (const t of shape.templates) {
    for (const c of [...tasksOf(t), ...stepGroupsOf(t).flat()]) {
      const local = c.body.templateRef === undefined ? str(c.body.template) : undefined
      if (!local) continue
      uses.set(local, (uses.get(local) ?? 0) + 1)
      usedBy.set(local, [...(usedBy.get(local) ?? []), uidOf(shape.entry, t.name, c.name)])
    }
  }
  const ctx: Ctx = {
    shape,
    catalogue: opts.catalogue ?? [],
    templates: new Map([...shape.byName].map(([name, t]) => [name, t.body])),
    uses,
    positions: decodePositions(obj(obj(shape.root.metadata)?.annotations)?.['adhar.io/designer-positions']),
  }

  const graph: DesignerGraph = {
    resource,
    entry: shape.entry ?? '',
    editable: false,
    params: paramsOf(shape),
    nodes: [],
    edges: [],
    templates: shape.templates.filter((t) => t.name).map((t) => ({ name: t.name, kind: kindOfTemplate(t.body), path: t.path, usedBy: usedBy.get(t.name) ?? [] })),
    diagnostics,
  }

  let bottom = 0
  const entry = shape.entry ? shape.byName.get(shape.entry) : undefined
  if (!shape.entry) graph.readOnly = 'no-entry'
  else if (!entry) graph.readOnly = 'missing-entry'
  else if (entry.body.dag !== undefined) {
    const main = projectDag(ctx, entry, 'main', 0, [entry.name])
    graph.nodes = main.nodes
    graph.edges = main.edges
    graph.editable = true
    bottom = main.bottom
  } else if (entry.body.steps !== undefined) {
    const main = projectSteps(ctx, entry, 'main')
    graph.nodes = main.nodes
    graph.edges = main.edges
    graph.readOnly = 'steps'
    bottom = main.bottom
  } else {
    graph.nodes = [leafNode(ctx, entry, 'main')]
    graph.readOnly = 'leaf-entry'
    bottom = RUN_CARD_HEIGHT
  }

  const exit = shape.onExit ? shape.byName.get(shape.onExit) : undefined
  if (exit) {
    const y = bottom + LANE_GAP
    if (exit.body.dag !== undefined) {
      const lane = projectDag(ctx, exit, 'exit', 0, [exit.name], y)
      graph.exitLane = { template: exit.name, editable: true, nodes: lane.nodes, edges: lane.edges }
    } else if (exit.body.steps !== undefined) {
      const lane = projectSteps(ctx, exit, 'exit', y)
      graph.exitLane = { template: exit.name, editable: false, nodes: lane.nodes, edges: lane.edges }
    } else {
      graph.exitLane = { template: exit.name, editable: false, nodes: [leafNode(ctx, exit, 'exit', y)], edges: [] }
    }
  }
  return graph
}

/** Every node of a graph, including the exit lane and (when `deep`) the children of sub-flows. */
export function allNodes(g: DesignerGraph, deep = false): DesignerNode[] {
  const out: DesignerNode[] = []
  const walk = (nodes: readonly DesignerNode[]) => {
    for (const n of nodes) {
      out.push(n)
      if (deep && n.group) walk(n.group.nodes)
    }
  }
  walk(g.nodes)
  walk(g.exitLane?.nodes ?? [])
  return out
}

export function findNode(g: DesignerGraph, uid: string): DesignerNode | undefined {
  return allNodes(g, true).find((n) => n.uid === uid)
}

/**
 * The diagnostics a node's badge shows: those about the task itself and those
 * about the local template it runs (so every task sharing a broken template
 * is marked).
 */
export function diagnosticsFor(g: DesignerGraph, node: DesignerNode): Diagnostic[] {
  return g.diagnostics.filter((x) => (x.task ? x.task.uid === node.uid : node.template.local !== undefined && x.template === node.template.local))
}
