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
 * gets submitted (Argo Events, the CLI, the console), a schedule becomes the
 * CronWorkflow.
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

export function slug(s: string, fallback = 'workflow'): string {
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52)
  return v || fallback
}

const q = (v: unknown) => JSON.stringify(String(v ?? ''))

function delaySeconds(cfg: Record<string, unknown>): string {
  const n = Number(cfg.delayValue ?? 5) || 5
  const unit = String(cfg.delayUnit ?? 'seconds')
  return unit.startsWith('min') ? `${n}m` : unit.startsWith('hour') ? `${n}h` : unit.startsWith('day') ? `${n * 24}h` : `${n}s`
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

  const wfName = slug(name)
  const taskName = new Map<string, string>()
  tasks.forEach((s, i) => taskName.set(s.id, `${slug(s.name, 'step')}-${i + 1}`))

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

  const schedule = steps.find((s) => s.type === 'trigger' && typeof s.config?.schedule === 'string' && CRON.test(String(s.config.schedule)))
  if (schedule) {
    L.push('---')
    L.push('apiVersion: argoproj.io/v1alpha1')
    L.push('kind: CronWorkflow')
    L.push('metadata:')
    L.push(`  name: ${q(wfName)}`)
    L.push('  labels:')
    L.push('    app.kubernetes.io/managed-by: "adhar-builder"')
    L.push('spec:')
    L.push(`  schedule: ${q(schedule.config!.schedule)}`)
    L.push('  concurrencyPolicy: "Forbid"')
    L.push('  workflowSpec:')
    L.push('    workflowTemplateRef:')
    L.push(`      name: ${q(wfName)}`)
  }
  return L.join('\n') + '\n'
}
