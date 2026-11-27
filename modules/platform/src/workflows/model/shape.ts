import type { Path, WfDoc } from './doc.ts'
import { toJS } from './doc.ts'

/**
 * Where things are in an Argo document (design 0026 §6.5): which kinds the
 * designer opens, where each keeps its workflow spec, and the paths of its
 * templates and DAG tasks. Shared by the projection, the operations and the
 * validation, so the three cannot disagree about a path. Pure.
 */

export const RESOURCE_KINDS = ['WorkflowTemplate', 'ClusterWorkflowTemplate', 'CronWorkflow', 'Workflow'] as const
export type ResourceKind = typeof RESOURCE_KINDS[number]

export type Obj = Record<string, unknown>
export const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)

/** The names Argo accepts for a DAG task or a step (its `isValidWorkflowFieldName`). */
export const TASK_NAME = /^[A-Za-z0-9][-A-Za-z0-9]*$/

/** A CronWorkflow keeps the workflow under `spec.workflowSpec`; everything else under `spec`. */
export function specPathOf(kind: string | undefined): Path {
  return kind === 'CronWorkflow' ? ['spec', 'workflowSpec'] : ['spec']
}

export interface TemplateAt {
  name: string
  index: number
  path: Path
  body: Obj
}

export interface TaskAt {
  name: string
  index: number
  path: Path
  body: Obj
}

export interface Shape {
  /** The document as plain data (null when it does not parse or is not a map). */
  root: Obj | null
  kind?: ResourceKind
  /** The raw `kind`, whatever it is. */
  rawKind?: string
  name: string
  namespace?: string
  specPath: Path
  spec: Obj
  entry?: string
  onExit?: string
  templates: TemplateAt[]
  /** First template of each name (Argo resolves a duplicate name to the first). */
  byName: Map<string, TemplateAt>
}

/** Read the document's shape once. */
export function shapeOf(d: WfDoc): Shape {
  const root = obj(toJS(d)) ?? null
  const rawKind = str(root?.kind)
  const kind = (RESOURCE_KINDS as readonly string[]).includes(rawKind ?? '') ? (rawKind as ResourceKind) : undefined
  const specPath = specPathOf(rawKind)
  let spec: Obj = {}
  let cur: unknown = root
  for (const k of specPath) cur = obj(cur)?.[k as string]
  spec = obj(cur) ?? {}
  const meta = obj(root?.metadata)
  const templates: TemplateAt[] = []
  arr(spec.templates).forEach((t, index) => {
    const body = obj(t)
    if (body) templates.push({ name: str(body.name) ?? '', index, path: [...specPath, 'templates', index], body })
  })
  const byName = new Map<string, TemplateAt>()
  for (const t of templates) if (t.name && !byName.has(t.name)) byName.set(t.name, t)
  return {
    root,
    kind,
    rawKind,
    name: str(meta?.name) ?? str(meta?.generateName) ?? '',
    namespace: str(meta?.namespace),
    specPath,
    spec,
    entry: str(spec.entrypoint),
    onExit: str(spec.onExit),
    templates,
    byName,
  }
}

/** The tasks of a DAG template. */
export function tasksOf(t: TemplateAt): TaskAt[] {
  const out: TaskAt[] = []
  arr(obj(t.body.dag)?.tasks).forEach((task, index) => {
    const body = obj(task)
    if (body) out.push({ name: str(body.name) ?? '', index, path: [...t.path, 'dag', 'tasks', index], body })
  })
  return out
}

/** The steps of a `steps` template, as parallel groups in order. */
export function stepGroupsOf(t: TemplateAt): TaskAt[][] {
  return arr(t.body.steps).map((group, g) =>
    arr(group).map((step, index) => {
      const body = obj(step) ?? {}
      return { name: str(body.name) ?? '', index, path: [...t.path, 'steps', g, index], body }
    })
  )
}

/**
 * A canvas-unique id for a task: its name in the entry DAG, `<template>/<task>`
 * in any other (the exit lane, a sub-flow). The same string is the task's key
 * in the positions annotation (`positions.ts`).
 */
export function uidOf(entry: string | undefined, dag: string, task: string): string {
  return dag === entry ? task : `${dag}/${task}`
}

/** Names a local template is referenced by, anywhere in the spec: `template:` of tasks, steps and hooks, `onExit`, `entrypoint`. */
export function templateUses(shape: Shape): Map<string, string[]> {
  const uses = new Map<string, string[]>()
  const add = (name: unknown, by: string) => {
    const n = str(name)
    if (!n) return
    uses.set(n, [...(uses.get(n) ?? []), by])
  }
  add(shape.entry, 'entrypoint')
  add(shape.onExit, 'onExit')
  const hooks = (h: unknown, by: string) => {
    for (const [k, v] of Object.entries(obj(h) ?? {})) add(obj(v)?.template, `${by} hook ${k}`)
  }
  hooks(shape.spec.hooks, 'workflow')
  for (const t of shape.templates) {
    const callers = [...tasksOf(t), ...stepGroupsOf(t).flat()]
    for (const c of callers) {
      add(c.body.template, `${t.name}/${c.name}`)
      add(c.body.onExit, `${t.name}/${c.name} onExit`)
      hooks(c.body.hooks, `${t.name}/${c.name}`)
    }
    hooks(t.body.hooks, t.name)
  }
  return uses
}
