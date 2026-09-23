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
/** Stage names by column, cosmetic like positions; see `stepDepths`. */
export const STAGES_ANNOTATION = 'adhar.io/designer-stages'
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
  /**
   * Stage names, one per dependency depth (column). A stage is not an Argo
   * concept — it is how a CI canvas reads a DAG: everything that can start
   * together is a column, and the columns run left to right. Names are
   * optional labels on those columns; the columns themselves are derived.
   */
  stages?: string[]
}

/* ─────────────────────────── schedule ─────────────────────────── */

/**
 * When a designed workflow should run.
 *
 *   now   — submit a Workflow immediately.
 *   once  — run at one future time. Argo has no one-shot object, so this is a
 *           CronWorkflow whose cron names that minute and whose stop strategy
 *           ends it after the first run (Argo ≥ 3.6).
 *   cron  — a recurring CronWorkflow.
 */
export type ScheduleMode = 'now' | 'once' | 'cron'

export interface Schedule {
  mode: ScheduleMode
  /** `once`: local date-time (`YYYY-MM-DDTHH:mm`). */
  at?: string
  /** `cron`: a five-field cron expression. */
  cron?: string
  /** IANA zone, e.g. `Europe/London`. Blank = the controller's zone (UTC). */
  timezone?: string
  /** What to do if the previous run is still going. */
  concurrencyPolicy?: 'Allow' | 'Forbid' | 'Replace'
  /** Create it paused. */
  suspend?: boolean
}

export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays at 06:00', cron: '0 6 * * 1-5' },
  { label: 'Every Monday at 06:00', cron: '0 6 * * 1' },
  { label: 'First of the month at 00:00', cron: '0 0 1 * *' },
]

export const CRON_RE = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/

/** The cron expression that fires once at `d`, in `d`'s own calendar. */
export function cronForDate(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * A cron expression in words, for the shapes people actually write. Anything
 * else comes back as the expression itself — a wrong paraphrase of a schedule
 * is worse than none.
 */
export function describeCron(expr: string, timezone?: string): string {
  const m = CRON_RE.exec(expr)
  if (!m) return expr
  const [, min, hour, dom, mon, dow] = m
  const tz = timezone ? ` (${timezone})` : ''
  const hhmm = (h: string, mi: string) => `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`
  const every = (v: string) => /^\*\/(\d+)$/.exec(v)?.[1]
  const dowName = (v: string): string | undefined => {
    if (v === '1-5') return 'weekdays'
    if (v === '0,6' || v === '6,0') return 'weekends'
    if (/^[0-6]$/.test(v)) return `every ${DAY_NAMES[Number(v)]}`
    if (/^[0-6](,[0-6])+$/.test(v)) return v.split(',').map((d) => DAY_NAMES[Number(d)]).join(', ')
    return undefined
  }
  const eMin = every(min)
  if (eMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${eMin} minutes${tz}`
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every minute${tz}`
  const eHour = every(hour)
  if (/^\d+$/.test(min) && eHour && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${eHour} hours at :${min.padStart(2, '0')}${tz}`
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return min === '0' ? `Every hour${tz}` : `Every hour at :${min.padStart(2, '0')}${tz}`
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const at = hhmm(hour, min)
    if (dom === '*' && mon === '*' && dow === '*') return `Every day at ${at}${tz}`
    if (dom === '*' && mon === '*') {
      const d = dowName(dow)
      if (d) return `${d === 'weekdays' || d === 'weekends' ? `On ${d}` : d.startsWith('every') ? d.charAt(0).toUpperCase() + d.slice(1) : `On ${d}`} at ${at}${tz}`
    }
    if (/^\d+$/.test(dom) && mon === '*' && dow === '*') {
      const n = Number(dom)
      const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
      return `On the ${n}${suffix} of every month at ${at}${tz}`
    }
    if (/^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*') {
      const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      return `Once, on ${dom} ${MONTHS[Number(mon) - 1] ?? mon} at ${at}${tz}`
    }
  }
  return expr
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
export function stepDepths(steps: StepNode[]): Map<string, number> {
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
  return depth
}

/**
 * Lay the graph out as a pipeline: one column per dependency depth, left to
 * right, each column centred vertically. That is the shape a CI canvas has,
 * and it is why the same DAG that is a wall of YAML reads at a glance here.
 */
export function layoutGraph(steps: StepNode[], opts: { dx?: number; dy?: number } = {}): StepNode[] {
  const dx = opts.dx ?? 270
  const dy = opts.dy ?? 118
  const depth = stepDepths(steps)

  const cols = new Map<number, StepNode[]>()
  for (const s of steps) {
    const d = depth.get(s.id) ?? 0
    const col = cols.get(d)
    if (col) col.push(s)
    else cols.set(d, [s])
  }
  const tallest = Math.max(1, ...[...cols.values()].map((c) => c.length))

  return steps.map((s) => {
    const d = depth.get(s.id) ?? 0
    const col = cols.get(d)!
    const i = col.indexOf(s)
    // Centre each column against the tallest one so the graph is symmetric.
    const offset = (tallest - col.length) / 2
    return { ...s, x: d * dx + 60, y: Math.round((i + offset) * dy) + 60 }
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
export interface CronOptions {
  cron: string
  timezone?: string
  concurrencyPolicy?: 'Allow' | 'Forbid' | 'Replace'
  suspend?: boolean
  /** Stop after the first completed run — a one-off at a future time. */
  oneShot?: boolean
}

export function toArgoSpec(
  graph: WorkflowGraph,
  opts: { kind?: 'Workflow' | 'WorkflowTemplate' | 'CronWorkflow'; generateName?: boolean; schedule?: CronOptions } = {},
): Record<string, unknown> {
  const kind = opts.kind ?? 'Workflow'
  if (kind === 'CronWorkflow') {
    if (!opts.schedule) throw new Error('A CronWorkflow needs a schedule')
    const inner = toArgoSpec(graph, { kind: 'Workflow' })
    const sc = opts.schedule
    return {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'CronWorkflow',
      metadata: inner.metadata,
      spec: {
        // Argo ≥ 3.6 reads `schedules`; the singular is deprecated there.
        schedules: [sc.cron],
        ...(sc.timezone ? { timezone: sc.timezone } : {}),
        concurrencyPolicy: sc.concurrencyPolicy ?? 'Forbid',
        ...(sc.suspend ? { suspend: true } : {}),
        // A one-off: the controller stops the CronWorkflow after its first
        // finished run instead of firing again next year on the same date.
        ...(sc.oneShot ? { stopStrategy: { expression: 'cron.succeeded >= 1 || cron.failed >= 1' } } : {}),
        workflowSpec: inner.spec,
      },
    }
  }
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
  const stages = (graph.stages ?? []).some((n) => n.trim()) ? graph.stages : undefined

  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind,
    metadata: {
      ...(opts.generateName && kind === 'Workflow'
        ? { generateName: `${graph.name}-` }
        : { name: graph.name }),
      namespace: graph.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'adhar-console' },
      annotations: {
        [POSITIONS_ANNOTATION]: JSON.stringify(positions),
        ...(stages ? { [STAGES_ANNOTATION]: JSON.stringify(stages) } : {}),
      },
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
  const outer = (obj.spec ?? {}) as Record<string, unknown>
  // A CronWorkflow wraps the workflow in `workflowSpec`; open that.
  const spec = (obj.kind === 'CronWorkflow' || (outer.workflowSpec && !outer.templates)
    ? (outer.workflowSpec ?? {})
    : outer) as Record<string, unknown>
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
  const stages = readStages(metadata)
  const graph: WorkflowGraph = {
    name: String(metadata.name ?? metadata.generateName ?? 'workflow').replace(/-$/, ''),
    namespace: String(metadata.namespace ?? 'default'),
    params: (args.parameters ?? []).map((p) => ({ name: String(p.name ?? ''), value: String(p.value ?? '') })),
    steps,
    ...(typeof spec.serviceAccountName === 'string' ? { serviceAccountName: spec.serviceAccountName } : {}),
    ...(stages ? { stages } : {}),
  }

  // No saved positions — lay it out rather than stacking every node at 0,0.
  const anyPlaced = steps.some((s) => s.x !== 0 || s.y !== 0)
  return anyPlaced ? graph : { ...graph, steps: layoutGraph(steps) }
}

/** The schedule a CronWorkflow object carries, for editing it again. */
export function scheduleFromArgo(obj: Record<string, unknown>): Schedule | null {
  if (obj.kind !== 'CronWorkflow') return null
  const spec = (obj.spec ?? {}) as Record<string, unknown>
  const cron = Array.isArray(spec.schedules) && spec.schedules.length ? String(spec.schedules[0]) : typeof spec.schedule === 'string' ? spec.schedule : ''
  if (!cron) return null
  const stop = (spec.stopStrategy as { expression?: string } | undefined)?.expression ?? ''
  const cp = spec.concurrencyPolicy
  return {
    mode: /cron\.(succeeded|failed)\s*>=\s*1/.test(stop) ? 'once' : 'cron',
    cron,
    ...(typeof spec.timezone === 'string' ? { timezone: spec.timezone } : {}),
    ...(cp === 'Allow' || cp === 'Forbid' || cp === 'Replace' ? { concurrencyPolicy: cp } : {}),
    ...(spec.suspend === true ? { suspend: true } : {}),
  }
}

function readStages(metadata: Record<string, unknown>): string[] | undefined {
  const annotations = (metadata.annotations ?? {}) as Record<string, string>
  const raw = annotations[STAGES_ANNOTATION]
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : undefined
  } catch {
    return undefined
  }
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
