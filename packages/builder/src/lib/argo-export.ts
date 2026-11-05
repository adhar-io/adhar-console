/**
 * `.workflow` → Argo Workflows.
 *
 * Argo Workflows is the platform's workflow engine, so a workflow drawn in the
 * builder is exported as a `WorkflowTemplate` (a DAG, one task per step, edges
 * from the canvas connections) plus a `CronWorkflow` when it starts on a cron
 * schedule. Steps map to small, real containers:
 *
 *   HTTP Request → curl          Delay → `suspend` with a duration
 *   everything else → a shell step that logs what it stands for, as a
 *   placeholder to replace with the team's real image.
 *
 * Triggers do not become tasks: a webhook/event trigger is how the template
 * gets submitted (Argo Events, the CLI, the console), and every Schedule
 * trigger becomes one entry of the CronWorkflow's `schedules` list.
 *
 * The output is for Argo Workflows v4 (the platform pins v4.1.6), which
 * enforces two rules a v3-era export broke:
 *
 *   • `spec.schedule` on a CronWorkflow is gone: v4 reads only the
 *     `spec.schedules` list. The platform installs the MINIMAL CRDs, so the
 *     API server stores an old `schedule` key without complaint, the
 *     controller drops it when it decodes the object, and then refuses the
 *     CronWorkflow with "cron workflow must have at least one schedule" — it
 *     is accepted and never runs.
 *   • A DAG task that has `dependencies` may not start with a digit, so a
 *     step called "2FA check" is exported as `step-2fa-check-<n>`.
 *
 * YAML is emitted with JSON-quoted scalars, which is valid YAML and needs no
 * serializer dependency.
 */

interface Step {
  id: string
  type: 'trigger' | 'action' | 'condition' | 'delay'
  name: string
  config?: Record<string, unknown>
}
interface Conn {
  from: string
  to: string
}
interface WorkflowData {
  steps?: Step[]
  connections?: Conn[]
}

const CURL_IMAGE = 'curlimages/curl:8.10.1'
const SHELL_IMAGE = 'alpine:3.20'
const CRON = /^\s*(\S+\s+){4}\S+\s*$/

/**
 * A DNS-safe object name: lowercase letters, digits and inner hyphens, at
 * most 52 characters. The trailing hyphen is trimmed AFTER the cut, because a
 * cut can land on one and Kubernetes refuses a name that ends with a hyphen.
 */
export function slug(s: string, fallback = 'workflow'): string {
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 52).replace(/-+$/, '')
  return v || fallback
}

const q = (v: unknown) => JSON.stringify(String(v ?? ''))

function delaySeconds(cfg: Record<string, unknown>): string {
  const n = Number(cfg.delayValue ?? 5) || 5
  const unit = String(cfg.delayUnit ?? 'seconds')
  return unit.startsWith('min') ? `${n}m` : unit.startsWith('hour') ? `${n}h` : unit.startsWith('day') ? `${n * 24}h` : `${n}s`
}

/**
 * The DAG task (and template) name of the `i`-th step: DNS-safe, at most 63
 * characters, and never starting with a digit — Argo refuses a task named
 * like that once it has `dependencies` ("name cannot begin with a digit when
 * using either 'depends' or 'dependencies'"), and the index suffix keeps two
 * steps with the same label apart.
 */
function taskNameFor(s: Step, i: number): string {
  const suffix = `-${i + 1}`
  const base = slug(s.name, 'step')
  const lead = /^[0-9]/.test(base) ? `step-${base}` : base
  return `${lead.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`
}

/**
 * Every distinct cron expression the workflow's triggers carry, in canvas
 * order. A v4 CronWorkflow fires on each entry of `schedules`, so two
 * Schedule triggers on one canvas become one CronWorkflow with two entries
 * (the v3 export kept only the first). Whitespace is normalised so the same
 * schedule typed twice is listed once.
 */
function cronSchedules(steps: Step[]): string[] {
  const out: string[] = []
  for (const s of steps) {
    const cron = s.type === 'trigger' ? s.config?.schedule : undefined
    if (typeof cron !== 'string' || !CRON.test(cron)) continue
    const normal = cron.trim().replace(/\s+/g, ' ')
    if (!out.includes(normal)) out.push(normal)
  }
  return out
}

export function workflowToArgo(content: string, name: string): string | null {
  let data: WorkflowData
  try {
    data = JSON.parse(content || '{}')
  } catch {
    return null
  }
  const steps = data.steps ?? []
  const conns = data.connections ?? []
  const tasks = steps.filter((s) => s.type !== 'trigger')
  if (tasks.length === 0) return null

  // At most 52 characters (`slug` caps it): a CronWorkflow's runs are named
  // `<name>-<unix time>`, and Argo refuses a CronWorkflow name over 52.
  const wfName = slug(name)
  const taskName = new Map<string, string>()
  tasks.forEach((s, i) => taskName.set(s.id, taskNameFor(s, i)))

  // A task depends on the nearest non-trigger ancestors along the connections.
  const depsOf = (id: string, seen = new Set<string>()): string[] => {
    const out: string[] = []
    for (const c of conns.filter((c) => c.to === id)) {
      if (seen.has(c.from)) continue
      seen.add(c.from)
      if (taskName.has(c.from)) out.push(taskName.get(c.from)!)
      else out.push(...depsOf(c.from, seen))
    }
    return [...new Set(out)]
  }

  const L: string[] = []
  L.push('apiVersion: argoproj.io/v1alpha1')
  L.push('kind: WorkflowTemplate')
  L.push('metadata:')
  L.push(`  name: ${q(wfName)}`)
  L.push('  labels:')
  L.push('    app.kubernetes.io/managed-by: "adhar-builder"')
  L.push('spec:')
  L.push('  entrypoint: "main"')
  L.push('  templates:')
  L.push('    - name: "main"')
  L.push('      dag:')
  L.push('        tasks:')
  for (const s of tasks) {
    const n = taskName.get(s.id)!
    L.push(`          - name: ${q(n)}`)
    L.push(`            template: ${q(n)}`)
    const deps = depsOf(s.id)
    if (deps.length) L.push(`            dependencies: [${deps.map(q).join(', ')}]`)
  }
  for (const s of tasks) {
    const n = taskName.get(s.id)!
    const cfg = s.config ?? {}
    L.push(`    - name: ${q(n)}`)
    if (s.type === 'delay') {
      L.push('      suspend:')
      L.push(`        duration: ${q(delaySeconds(cfg))}`)
    } else if (typeof cfg.url === 'string' && cfg.url) {
      L.push('      container:')
      L.push(`        image: ${q(CURL_IMAGE)}`)
      L.push(`        args: ["-sSfL", "-X", ${q(cfg.method ?? 'GET')}, ${q(cfg.url)}]`)
    } else {
      const what = s.type === 'condition'
        ? `condition ${cfg.field ?? ''} ${cfg.operator ?? ''} ${cfg.condValue ?? ''}`.trim()
        : String(cfg.message ?? cfg.subject ?? s.name)
      L.push('      container:')
      L.push(`        image: ${q(SHELL_IMAGE)}`)
      L.push(`        command: ["sh", "-c"]`)
      L.push(`        args: [${q(`echo ${JSON.stringify(`[${s.name}] ${what}`)}`)}]`)
    }
  }

  const schedules = cronSchedules(steps)
  if (schedules.length) {
    L.push('---')
    L.push('apiVersion: argoproj.io/v1alpha1')
    L.push('kind: CronWorkflow')
    L.push('metadata:')
    L.push(`  name: ${q(wfName)}`)
    L.push('  labels:')
    L.push('    app.kubernetes.io/managed-by: "adhar-builder"')
    L.push('spec:')
    // v4: a list. The singular `schedule` was removed (see the header).
    L.push(`  schedules: [${schedules.map(q).join(', ')}]`)
    L.push('  concurrencyPolicy: "Forbid"')
    L.push('  workflowSpec:')
    L.push('    workflowTemplateRef:')
    L.push(`      name: ${q(wfName)}`)
  }
  return L.join('\n') + '\n'
}
