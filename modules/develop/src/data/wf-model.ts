/**
 * The workflow designer's model: a visual graph on one side, an Argo
 * Workflows DAG on the other, and a conversion that must round-trip.
 *
 * ---------------------------------------------------------------------------
 * WHY ROUND-TRIPPING MATTERS MORE THAN THE CANVAS
 * ---------------------------------------------------------------------------
 * A designer that can only ever produce YAML is a one-way door: the moment
 * someone edits the workflow in git, or Argo normalises it, the canvas can no
 * longer open it and the tool is abandoned. So the graph is DERIVED from the
 * spec, never stored alongside it — the only thing persisted beyond what Argo
 * needs is node positions, and those live in an annotation that Argo ignores
 * and that the importer treats as optional.
 *
 * That constraint is why this module is pure and tested: the conversion is the
 * product, and the canvas is a view of it.
 *
 * ---------------------------------------------------------------------------
 * THE ARGO SHAPE
 * ---------------------------------------------------------------------------
 * An Argo DAG workflow is two levels. One template holds the `dag.tasks`, each
 * task naming another template and listing its `dependencies`; the named
 * templates hold the actual containers. The designer keeps that shape rather
 * than inlining, because inlined steps cannot be reused and Argo's own UI
 * shows them differently.
 */

export const POSITIONS_ANNOTATION = 'adhar.io/designer-positions'
export const ENTRY_TEMPLATE = 'main'

export interface StepNode {
  /** DAG task name — also the generated template name. */
  id: string
  label: string
  image: string
  /** Shell command. Rendered as `["sh","-c",command]`. */
  command: string
  /** Steps that must finish first. */
  dependsOn: string[]
  /** Canvas position; purely cosmetic. */
  x: number
  y: number
  /** Key/value parameters passed to the step as environment variables. */
  env?: Record<string, string>
  /** `when` expression — the task runs only if this is truthy. */
  when?: string
}

export interface WorkflowGraph {
  name: string
  namespace: string
  /** Workflow-level parameters, offered to every step. */
  params: Array<{ name: string; value: string }>
  steps: StepNode[]
  /** Service account the pods run as; blank uses the namespace default. */
  serviceAccountName?: string
}

/* ─────────────────────────── names ─────────────────────────── */

/** Argo template and task names must be DNS-1123 labels. */
export const STEP_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export function normaliseStepName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63)
    .replace(/-+$/, '')
}

/** A name not already taken, by appending -2, -3, … */
export function uniqueStepName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const root = normaliseStepName(base) || 'step'
  if (!used.has(root)) return root
  for (let i = 2; i < 500; i++) {
    const candidate = `${root}-${i}`.slice(0, 63).replace(/-+$/, '')
    if (!used.has(candidate)) return candidate
  }
  return `${root}-${Date.now().toString(36)}`.slice(0, 63)
}

/* ─────────────────────────── validation ─────────────────────────── */

export interface GraphProblem {
  /** Step the problem belongs to, or null for a whole-graph problem. */
  step: string | null
  message: string
}

/**
 * Everything that would make Argo reject the workflow, or accept it and
 * then hang.
 *
 * A cycle is the important one: Argo does not reject it up front — the DAG
 * simply never becomes runnable, and the workflow sits in Running forever
 * with no task started and nothing explaining why.
 */
export function validateGraph(graph: WorkflowGraph): GraphProblem[] {
  const problems: GraphProblem[] = []
  const names = new Set<string>()

  if (!graph.steps.length) problems.push({ step: null, message: 'A workflow needs at least one step.' })

  for (const step of graph.steps) {
    if (!STEP_NAME_RE.test(step.id)) {
      problems.push({ step: step.id, message: `"${step.id}" is not a valid name — lowercase letters, numbers and dashes.` })
    }
    if (names.has(step.id)) {
      problems.push({ step: step.id, message: `Two steps are called "${step.id}".` })
    }
    names.add(step.id)
    if (!step.image.trim()) problems.push({ step: step.id, message: 'No image set.' })
    if (!step.command.trim()) problems.push({ step: step.id, message: 'No command set.' })
  }

  for (const step of graph.steps) {
    for (const dep of step.dependsOn) {
      if (!names.has(dep)) {
        problems.push({ step: step.id, message: `Depends on "${dep}", which is not a step in this workflow.` })
      }
      if (dep === step.id) {
        problems.push({ step: step.id, message: 'A step cannot depend on itself.' })
      }
    }
  }

  const cycle = findCycle(graph.steps)
  if (cycle) {
    problems.push({
      step: cycle[0] ?? null,
      // Argo accepts this and then never starts — worth naming the loop.
      message: `These steps depend on each other in a loop: ${cycle.join(' → ')}. The workflow would never start.`,
    })
  }

  return problems
}

/** The first dependency cycle found, as the list of steps in it. */
export function findCycle(steps: StepNode[]): string[] | null {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn.filter((d) => d !== s.id)]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const walk = (id: string): string[] | null => {
    const seen = state.get(id)
    if (seen === 'done') return null
    if (seen === 'visiting') {
      // Return the loop itself, starting where we re-entered it.
      const from = stack.indexOf(id)
      return [...stack.slice(from), id]
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue
      const found = walk(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const s of steps) {
    const found = walk(s.id)
    if (found) return found
  }
  return null
}

/**
 * Layer each step below everything it depends on.
 *
 * Used to lay out an imported workflow that carries no saved positions, and
 * to tidy a graph on demand. Longest-path layering, so a step sits one row
 * under its DEEPEST dependency rather than its first — otherwise long edges
 * cut back across the canvas.
 */
export function layoutGraph(steps: StepNode[], opts: { dx?: number; dy?: number } = {}): StepNode[] {
  const dx = opts.dx ?? 260
  const dy = opts.dy ?? 130
  const byId = new Map(steps.map((s) => [s.id, s]))
  const depth = new Map<string, number>()

  const depthOf = (id: string, guard: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (guard.has(id)) return 0 // a cycle is reported elsewhere; do not hang here
    guard.add(id)
    const step = byId.get(id)
    const parents = (step?.dependsOn ?? []).filter((d) => byId.has(d))
    const d = parents.length ? Math.max(...parents.map((p) => depthOf(p, guard))) + 1 : 0
    guard.delete(id)
    depth.set(id, d)
    return d
  }

  for (const s of steps) depthOf(s.id, new Set())

  const rows = new Map<number, StepNode[]>()
  for (const s of steps) {
    const d = depth.get(s.id) ?? 0
    const row = rows.get(d)
    if (row) row.push(s)
    else rows.set(d, [s])
  }

  return steps.map((s) => {
    const d = depth.get(s.id) ?? 0
    const row = rows.get(d)!
    const i = row.indexOf(s)
    // Centre each row so the graph grows symmetrically rather than to the right.
    const offset = (row.length - 1) / 2
    return { ...s, x: Math.round((i - offset) * dx + 400), y: d * dy + 60 }
  })
}

/* ─────────────────────────── graph → Argo ─────────────────────────── */

/**
 * Build an Argo `Workflow` (or `WorkflowTemplate`) from the graph.
 *
 * Positions ride along in an annotation. Argo ignores unknown annotations,
 * and the importer treats them as optional — so a workflow edited by hand in
 * git still opens, it just gets laid out automatically.
 */
export function toArgoSpec(
  graph: WorkflowGraph,
  opts: { kind?: 'Workflow' | 'WorkflowTemplate'; generateName?: boolean } = {},
): Record<string, unknown> {
  const kind = opts.kind ?? 'Workflow'
  const templates: Array<Record<string, unknown>> = [
    {
      name: ENTRY_TEMPLATE,
      dag: {
        tasks: graph.steps.map((s) => ({
          name: s.id,
          template: templateNameFor(s.id),
          ...(s.dependsOn.length ? { dependencies: [...s.dependsOn].sort() } : {}),
          ...(s.when ? { when: s.when } : {}),
        })),
      },
    },
    ...graph.steps.map((s) => ({
      name: templateNameFor(s.id),
      ...(s.label && s.label !== s.id ? { metadata: { annotations: { 'adhar.io/label': s.label } } } : {}),
      container: {
        image: s.image,
        // `sh -c` keeps the editor a single text box rather than an argv
        // builder, which is what people actually want for a build step.
        command: ['sh', '-c'],
        args: [s.command],
        ...(s.env && Object.keys(s.env).length
          ? { env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }
          : {}),
      },
    })),
  ]

  const positions: Record<string, [number, number]> = {}
  for (const s of graph.steps) positions[s.id] = [Math.round(s.x), Math.round(s.y)]

  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind,
    metadata: {
      ...(opts.generateName && kind === 'Workflow'
        ? { generateName: `${graph.name}-` }
        : { name: graph.name }),
      namespace: graph.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'adhar-console' },
      annotations: { [POSITIONS_ANNOTATION]: JSON.stringify(positions) },
    },
    spec: {
      entrypoint: ENTRY_TEMPLATE,
      ...(graph.serviceAccountName ? { serviceAccountName: graph.serviceAccountName } : {}),
      ...(graph.params.length
        ? { arguments: { parameters: graph.params.map((p) => ({ name: p.name, value: p.value })) } }
        : {}),
      templates,
    },
  }
}

/** `build` → `build-step`, so a task and its template never share a name. */
export function templateNameFor(step: string): string {
  return `${step}-step`.slice(0, 63)
}

/* ─────────────────────────── Argo → graph ─────────────────────────── */

interface ArgoTask {
  name?: string
  template?: string
  dependencies?: string[]
  when?: string
}

/**
 * Read an Argo workflow back into the graph.
 *
 * Deliberately forgiving: a workflow written by hand will not follow the
 * designer's `-step` naming, may inline its container, and will have no
 * saved positions. All of that opens — the alternative is a designer that
 * only understands its own output, which is a designer nobody can adopt.
 *
 * Returns null only when there is no DAG at all (a `steps:` workflow, which
 * is a different model this canvas does not represent).
 */
export function fromArgoSpec(obj: Record<string, unknown>): WorkflowGraph | null {
  const metadata = (obj.metadata ?? {}) as Record<string, unknown>
  const spec = (obj.spec ?? {}) as Record<string, unknown>
  const templates = Array.isArray(spec.templates) ? spec.templates as Array<Record<string, unknown>> : []

  const entrypoint = typeof spec.entrypoint === 'string' ? spec.entrypoint : ENTRY_TEMPLATE
  const entry = templates.find((t) => t.name === entrypoint) ??
    templates.find((t) => t.dag)
  const dag = entry?.dag as { tasks?: ArgoTask[] } | undefined
  if (!dag?.tasks) return null

  const byName = new Map(templates.map((t) => [String(t.name ?? ''), t]))
  const positions = readPositions(metadata)

  const steps: StepNode[] = dag.tasks.map((task, i) => {
    const id = String(task.name ?? `step-${i + 1}`)
    const tpl = task.template ? byName.get(task.template) : undefined
    const container = (tpl?.container ?? {}) as Record<string, unknown>
    const args = Array.isArray(container.args) ? container.args.map(String) : []
    const command = Array.isArray(container.command) ? container.command.map(String) : []
    const env: Record<string, string> = {}
    for (const e of (Array.isArray(container.env) ? container.env : []) as Array<Record<string, unknown>>) {
      if (typeof e.name === 'string' && typeof e.value === 'string') env[e.name] = e.value
    }
    const label = ((tpl?.metadata as Record<string, unknown> | undefined)?.annotations as Record<string, string> | undefined)
      ?.['adhar.io/label']
    const pos = positions[id]

    return {
      id,
      label: label ?? id,
      image: typeof container.image === 'string' ? container.image : '',
      // `sh -c "…"` collapses to the script; anything else is shown verbatim
      // so a hand-written argv is not silently rewritten.
      command: args.length && command.join(' ') === 'sh -c' ? args.join(' ') : [...command, ...args].join(' '),
      dependsOn: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      x: pos?.[0] ?? 0,
      y: pos?.[1] ?? 0,
      ...(Object.keys(env).length ? { env } : {}),
      ...(task.when ? { when: String(task.when) } : {}),
    }
  })

  const args = (spec.arguments ?? {}) as { parameters?: Array<{ name?: string; value?: unknown }> }
  const graph: WorkflowGraph = {
    name: String(metadata.name ?? metadata.generateName ?? 'workflow').replace(/-$/, ''),
    namespace: String(metadata.namespace ?? 'default'),
    params: (args.parameters ?? []).map((p) => ({ name: String(p.name ?? ''), value: String(p.value ?? '') })),
    steps,
    ...(typeof spec.serviceAccountName === 'string' ? { serviceAccountName: spec.serviceAccountName } : {}),
  }

  // No saved positions — lay it out rather than stacking every node at 0,0.
  const anyPlaced = steps.some((s) => s.x !== 0 || s.y !== 0)
  return anyPlaced ? graph : { ...graph, steps: layoutGraph(steps) }
}

function readPositions(metadata: Record<string, unknown>): Record<string, [number, number]> {
  const annotations = (metadata.annotations ?? {}) as Record<string, string>
  const raw = annotations[POSITIONS_ANNOTATION]
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, [number, number]> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number') {
        out[k] = [v[0], v[1]]
      }
    }
    return out
  } catch {
    // A hand-mangled annotation must not stop the workflow opening.
    return {}
  }
}
