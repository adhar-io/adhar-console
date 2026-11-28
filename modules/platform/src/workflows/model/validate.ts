import type { Path, TextRange, WfDoc } from './doc.ts'
import { rangeOf } from './doc.ts'
import { conjunctionTerms, dependsTerms, parseDepends } from './depends.ts'
import { TEMPLATE_TYPES } from './kinds.ts'
import type { TaskAt, TemplateAt } from './shape.ts'
import { arr, obj, RESOURCE_KINDS, shapeOf, stepGroupsOf, str, TASK_NAME, tasksOf, templateUses, uidOf } from './shape.ts'

/**
 * Level A of the validation pipeline (design 0026 §6.7): the rules the console
 * checks on every edit, before anything is sent to the cluster.
 *
 * The first group MIRRORS ARGO'S OWN CEL RULES. The platform installs the
 * minimal CRDs (D-3), which carry no `x-kubernetes-validations`, so the API
 * server no longer enforces them: a template that breaks one is admitted and
 * fails when it runs. `corpus/upstream-cel-rules.json` is the list extracted
 * from the full CRD at the pinned tag, and `validate_test.ts` holds every
 * entry in it to a rule here and every rule here to a failing fixture.
 *
 * Levels B (admission dry-run) and C (argo-server lint) run on the server and
 * report through the same `Diagnostic` shape. Pure: `validate_test.ts`.
 */

export type Level = 'error' | 'warning' | 'info'

export interface Diagnostic {
  level: Level
  code: string
  message: string
  /** Document path the diagnostic is about. */
  path: Path
  /** Where that is in the YAML (Monaco marker). Missing when the path has no node. */
  range?: TextRange
  /** The DAG task it belongs to, when it belongs to one. */
  task?: { dag: string; name: string; uid: string }
  /** The local template it belongs to, when it belongs to one (every task using it shows the badge). */
  template?: string
  source: 'client' | 'admission' | 'lint'
}

export interface Rule {
  code: string
  level: Level
  group: 'document' | 'cel' | 'v4' | 'graph' | 'platform'
  title: string
  /** `cel` rules: the upstream CRD message this mirrors (or `maxItems <path>` for a list ceiling). */
  mirrors?: string
}

export const MAX_DAG_TASKS = 200
export const MAX_TEMPLATES = 200
export const MAX_PARAMETERS = 500
export const MAX_PROMETHEUS_METRICS = 100
/** The designer warns well before Argo refuses (§13.3). */
export const LARGE_DAG = 100
/** Policy #5 (`adhar-workflows-reference-templates`): a workflow may not outlive a day. */
export const MAX_DEADLINE_SECONDS = 86_400

/** Identities reserved for the platform (Kyverno #3, INV-3). */
export const RESERVED_SERVICE_ACCOUNTS = ['adhar-resilience-gate', 'adhar-release', 'adhar-gameday'] as const

/** Registries `restrict-image-registries-enforce` admits, plus any host that starts with `harbor`. */
export const ALLOWED_REGISTRIES = ['docker.io', 'index.docker.io', 'ghcr.io', 'quay.io', 'registry.k8s.io', 'gcr.io'] as const

const ARTIFACT_LOCATIONS = ['s3', 'git', 'http', 'artifactory', 'hdfs', 'raw', 'oss', 'gcs', 'azure', 'plugin'] as const

export const RULES: readonly Rule[] = [
  { code: 'yaml/syntax', level: 'error', group: 'document', title: 'The YAML does not parse' },
  { code: 'yaml/warning', level: 'warning', group: 'document', title: 'The YAML parses with a warning' },
  { code: 'doc/not-a-workflow', level: 'error', group: 'document', title: 'Not an Argo workflow document' },

  { code: 'cel/dag-max-tasks', level: 'error', group: 'cel', title: 'A DAG holds at most 200 tasks', mirrors: 'maxItems dag.tasks' },
  { code: 'cel/max-templates', level: 'error', group: 'cel', title: 'A workflow holds at most 200 templates', mirrors: 'maxItems templates' },
  { code: 'cel/max-parameters', level: 'error', group: 'cel', title: 'A template takes at most 500 input parameters', mirrors: 'maxItems inputs.parameters' },
  { code: 'cel/max-prometheus-metrics', level: 'error', group: 'cel', title: 'At most 100 Prometheus metrics', mirrors: 'maxItems metrics.prometheus' },
  { code: 'cel/task-name-digit', level: 'error', group: 'cel', title: 'A task with dependencies cannot start with a digit', mirrors: "task name cannot begin with a digit when using 'depends' or 'dependencies'" },
  { code: 'cel/depends-and-dependencies', level: 'error', group: 'cel', title: 'depends and dependencies together', mirrors: "cannot use both 'depends' and 'dependencies'" },
  { code: 'cel/continue-on-with-depends', level: 'error', group: 'cel', title: 'continueOn with depends', mirrors: "cannot use 'continueOn' when using 'depends'" },
  { code: 'cel/one-template-type', level: 'error', group: 'cel', title: 'More than one template type', mirrors: 'template must have at most one template type' },
  { code: 'cel/timeout-on-steps-or-dag', level: 'error', group: 'cel', title: 'timeout on a steps or DAG template', mirrors: 'timeout cannot be applied to steps or dag templates' },
  { code: 'cel/active-deadline-leaf-only', level: 'error', group: 'cel', title: 'activeDeadlineSeconds on a steps or DAG template', mirrors: 'activeDeadlineSeconds is only valid for leaf templates' },
  { code: 'cel/one-artifact-location', level: 'error', group: 'cel', title: 'More than one artifact location', mirrors: 'at most one artifact location can be specified' },
  { code: 'cel/sequence-count-or-end', level: 'error', group: 'cel', title: 'withSequence count and end together', mirrors: 'only one of count or end can be defined' },
  { code: 'cel/manifest-or-manifest-from', level: 'error', group: 'cel', title: 'manifest and manifestFrom together', mirrors: 'only one of manifest or manifestFrom can be specified' },
  { code: 'cel/realtime-resources-duration', level: 'error', group: 'cel', title: 'resourcesDuration in a real-time gauge', mirrors: "'resourcesDuration.*' metrics cannot be used in real-time gauges" },

  { code: 'v4/skipped-output-default', level: 'warning', group: 'v4', title: 'An output of a task that can be skipped has no default' },
  { code: 'v4/cron-schedule', level: 'error', group: 'v4', title: 'CronWorkflow uses schedule, not schedules' },
  { code: 'v4/synchronization-singular', level: 'error', group: 'v4', title: 'synchronization uses mutex/semaphore, not the lists' },

  { code: 'depends/syntax', level: 'error', group: 'graph', title: 'depends does not parse' },
  { code: 'graph/cycle', level: 'error', group: 'graph', title: 'Tasks depend on each other in a circle' },
  { code: 'graph/unknown-dependency', level: 'error', group: 'graph', title: 'Depends on a task that does not exist' },
  { code: 'graph/dangling-task-reference', level: 'error', group: 'graph', title: 'Reads from a task that does not exist' },
  { code: 'graph/reference-without-dependency', level: 'warning', group: 'graph', title: 'Reads from a task it does not depend on' },
  { code: 'graph/unreachable-task', level: 'warning', group: 'graph', title: 'A task the DAG target never reaches' },
  { code: 'graph/unused-template', level: 'info', group: 'graph', title: 'A template nothing in this workflow uses' },
  { code: 'graph/missing-template', level: 'error', group: 'graph', title: 'Names a template that does not exist' },
  { code: 'graph/task-without-template', level: 'error', group: 'graph', title: 'A task that runs nothing' },
  { code: 'graph/duplicate-name', level: 'error', group: 'graph', title: 'Two tasks or templates share a name' },
  { code: 'graph/invalid-name', level: 'error', group: 'graph', title: 'A task name Argo refuses' },

  { code: 'platform/missing-resources', level: 'warning', group: 'platform', title: 'No CPU or memory set' },
  { code: 'platform/image-registry', level: 'warning', group: 'platform', title: 'Image from a registry the platform does not allow' },
  { code: 'platform/reserved-service-account', level: 'error', group: 'platform', title: 'Runs as an identity reserved for the platform' },
  { code: 'platform/secret-parameter', level: 'warning', group: 'platform', title: 'A parameter that looks like a secret' },
  { code: 'platform/parameter-in-script', level: 'warning', group: 'platform', title: 'A parameter spliced into a script' },
  { code: 'platform/parameter-in-args', level: 'info', group: 'platform', title: 'A parameter spliced into container arguments' },
  { code: 'platform/no-deadline', level: 'info', group: 'platform', title: 'No deadline set' },
  { code: 'platform/deadline-too-long', level: 'warning', group: 'platform', title: 'Deadline longer than a day' },
  { code: 'platform/large-dag', level: 'warning', group: 'platform', title: 'A DAG with more than 100 tasks' },
]

const RULE = new Map(RULES.map((r) => [r.code, r]))

export interface ValidateOptions {
  allowedRegistries?: readonly string[]
  reservedServiceAccounts?: readonly string[]
}

/**
 * A parameter name that reads as a secret, by WORD (`dbPassword`, `api-key`),
 * never by substring: `keyspace`, `monkey` and `passes` are not secrets. The
 * same test as the run form's (`data/catalog.ts` `isSecretLike`), kept here so
 * the model has no dependency on the data layer.
 */
const SECRET_PARTS = new Set(['pass', 'passwd', 'password', 'passphrase', 'pwd', 'token', 'secret', 'key', 'apikey', 'credential', 'credentials', 'creds'])
export function looksSecret(name: string): boolean {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[-_.\s]+/).filter(Boolean).some((p) => SECRET_PARTS.has(p))
}

/** The registry Kubernetes would pull an image from (`nginx:1.27` is docker.io). Undefined for a templated reference. */
export function registryOf(image: string): string | undefined {
  if (!image || image.includes('{{')) return undefined
  const first = image.split('/')[0]
  if (image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) return first
  return 'docker.io'
}

/** `tasks.<name>.` and `tasks['<name>']` / `tasks["<name>"]`, not preceded by another identifier character. */
const TASK_REF = /(?<![A-Za-z0-9_.-])tasks(?:\.([A-Za-z0-9_][A-Za-z0-9_-]*)(?=\.)|\[\s*['"]([^'"\]]+)['"]\s*\])/g
const PARAM_SPLICE = /\{\{\s*=?\s*(?:inputs\.parameters|workflow\.parameters|item|tasks\.|steps\.)/

/** Every task name a string reads from. */
export function taskRefs(text: string): string[] {
  return [...text.matchAll(TASK_REF)].map((m) => m[1] ?? m[2])
}

function strings(v: unknown, at: Path, out: Array<{ value: string; path: Path }> = []): Array<{ value: string; path: Path }> {
  if (typeof v === 'string') out.push({ value: v, path: at })
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, [...at, i], out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, [...at, k], out)
  return out
}

/** A cycle among `edges`, as the task names on it, or null. */
export function findCycle(nodes: readonly string[], edges: ReadonlyArray<{ source: string; target: string }>): string[] | null {
  const next = new Map<string, string[]>()
  for (const n of nodes) next.set(n, [])
  for (const e of edges) if (next.has(e.source) && next.has(e.target)) next.get(e.source)!.push(e.target)
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (n: string): string[] | null => {
    state.set(n, 1)
    stack.push(n)
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m]
      if (!state.get(m)) {
        const c = visit(m)
        if (c) return c
      }
    }
    stack.pop()
    state.set(n, 2)
    return null
  }
  for (const n of [...nodes].sort()) {
    if (!state.get(n)) {
      const c = visit(n)
      if (c) return c
    }
  }
  return null
}

/** The tasks a task depends on, from `depends` (every name in it) or `dependencies`. */
export function dependenciesOf(task: Record<string, unknown>): string[] {
  const d = str(task.depends)
  if (d !== undefined && d.trim()) return [...new Set(dependsTerms(d).map((t) => t.task))]
  return arr(task.dependencies).map(str).filter((s): s is string => Boolean(s))
}

/** Validate one document. Diagnostics come in document order within each rule group. */
export function validate(d: WfDoc, opts: ValidateOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = []
  const add = (code: string, message: string, path: Path, extra: Partial<Diagnostic> & { key?: boolean } = {}) => {
    const rule = RULE.get(code)
    if (!rule) throw new Error(`validate: no rule ${code}`)
    const { key, ...rest } = extra
    out.push({ level: rule.level, code, message, path, range: rangeOf(d, path, key ? 'key' : 'value'), source: 'client', ...rest })
  }

  if (d.errors.length) {
    for (const e of d.errors) {
      const lenient = e.code === 'MISSING_CHAR' || e.code === 'BAD_INDENT'
      out.push({
        level: 'error',
        code: 'yaml/syntax',
        message: lenient ? `${e.message} (kubectl may accept this; the designer needs continuation lines indented deeper than their key.)` : e.message,
        path: [],
        range: e.range,
        source: 'client',
      })
    }
    return out
  }
  for (const w of d.warnings) out.push({ level: 'warning', code: 'yaml/warning', message: w.message, path: [], range: w.range, source: 'client' })

  const shape = shapeOf(d)
  if (!shape.root) {
    add('doc/not-a-workflow', 'The document is empty or is not a map.', [])
    return out
  }
  if (!shape.kind) {
    add('doc/not-a-workflow', `kind is ${shape.rawKind ? `"${shape.rawKind}"` : 'missing'}; the designer opens ${RESOURCE_KINDS.join(', ')}.`, ['kind'])
    return out
  }
  const apiVersion = str(shape.root.apiVersion)
  if (apiVersion !== 'argoproj.io/v1alpha1') {
    add('doc/not-a-workflow', `apiVersion is ${apiVersion ? `"${apiVersion}"` : 'missing'}; Argo Workflows is argoproj.io/v1alpha1.`, ['apiVersion'])
  }

  const reserved = new Set<string>(opts.reservedServiceAccounts ?? RESERVED_SERVICE_ACCOUNTS)
  const registries = opts.allowedRegistries ?? ALLOWED_REGISTRIES
  const sp = shape.specPath

  /* ── workflow level ── */
  if (shape.kind === 'CronWorkflow') {
    const cronSpec = obj(shape.root.spec) ?? {}
    if (cronSpec.schedule !== undefined) {
      add('v4/cron-schedule', 'Argo 4 reads `schedules` (a list); `schedule` is ignored and the CronWorkflow never fires.', ['spec', 'schedule'], { key: true })
    }
  }
  checkSynchronization(shape.spec, sp)
  checkServiceAccount(shape.spec, sp)
  checkMetrics(shape.spec, sp)
  checkParameters(obj(shape.spec.arguments)?.parameters, [...sp, 'arguments', 'parameters'], undefined)
  if (obj(shape.spec.templateDefaults)) {
    // `templateDefaults` is a template too. The CRD's per-object rules apply inside it (the three written on the
    // `templates` LIST — one type, timeout, activeDeadlineSeconds — do not: it is not in that list).
    const td = obj(shape.spec.templateDefaults)!
    const defaults: TemplateAt = { name: 'templateDefaults', index: -1, path: [...sp, 'templateDefaults'], body: td }
    checkMetrics(td, defaults.path)
    checkMaxParameters(td, defaults.path)
    checkManifest(td, defaults.path, undefined)
    if (td.dag !== undefined) checkDag(defaults)
    for (const s of stepGroupsOf(defaults).flat()) checkSequence(s, {})
  }
  const deadline = shape.spec.activeDeadlineSeconds
  if (shape.templates.length && shape.entry) {
    if (deadline === undefined || deadline === null) {
      add('platform/no-deadline', 'No activeDeadlineSeconds: the platform default (6 hours) applies.', sp)
    }
  }
  if (typeof deadline === 'number' && deadline > MAX_DEADLINE_SECONDS) {
    add('platform/deadline-too-long', `activeDeadlineSeconds is ${deadline}; workflows in team namespaces may run for at most a day (${MAX_DEADLINE_SECONDS}).`, [...sp, 'activeDeadlineSeconds'])
  }
  checkArtifacts(shape.root, [])

  /* ── templates ── */
  if (shape.templates.length > MAX_TEMPLATES) {
    add('cel/max-templates', `${shape.templates.length} templates; Argo refuses more than ${MAX_TEMPLATES}.`, [...sp, 'templates'], { key: true })
  }
  const seenTemplates = new Map<string, number>()
  for (const t of shape.templates) {
    if (t.name) {
      if (seenTemplates.has(t.name)) add('graph/duplicate-name', `Two templates are named "${t.name}"; Argo uses the first.`, [...t.path, 'name'], { template: t.name })
      seenTemplates.set(t.name, t.index)
    }
    checkTemplate(t)
  }
  for (const [what, name] of [['entrypoint', shape.entry], ['onExit', shape.onExit]] as const) {
    if (name && shape.templates.length && !shape.byName.has(name)) {
      add('graph/missing-template', `${what} names "${name}", and there is no template of that name.`, [...sp, what])
    }
  }
  if (shape.entry && shape.templates.length) {
    const uses = templateUses(shape)
    for (const t of shape.templates) {
      if (t.name && !uses.has(t.name)) add('graph/unused-template', `Nothing in this workflow uses the template "${t.name}".`, [...t.path, 'name'], { template: t.name })
    }
  }
  return out

  /* ───────────── helpers (hoisted) ───────────── */

  function checkSynchronization(holder: Record<string, unknown>, at: Path) {
    const s = obj(holder.synchronization)
    if (!s) return
    for (const [old, now] of [['mutex', 'mutexes'], ['semaphore', 'semaphores']] as const) {
      if (s[old] !== undefined) {
        add('v4/synchronization-singular', `Argo 4 reads synchronization.${now} (a list); \`${old}\` is ignored, so nothing is locked.`, [...at, 'synchronization', old], { key: true })
      }
    }
  }

  function checkServiceAccount(holder: Record<string, unknown>, at: Path, template?: string) {
    const check = (v: unknown, p: Path) => {
      const name = str(v)
      if (name && reserved.has(name)) {
        add('platform/reserved-service-account', `"${name}" is reserved for the platform; a workflow runs as adhar-workflow or a ServiceAccount your team owns.`, p, { template })
      }
    }
    check(holder.serviceAccountName, [...at, 'serviceAccountName'])
    check(obj(holder.executor)?.serviceAccountName, [...at, 'executor', 'serviceAccountName'])
  }

  function checkMetrics(holder: Record<string, unknown>, at: Path, template?: string) {
    const list = arr(obj(holder.metrics)?.prometheus)
    if (list.length > MAX_PROMETHEUS_METRICS) {
      add('cel/max-prometheus-metrics', `${list.length} Prometheus metrics; Argo refuses more than ${MAX_PROMETHEUS_METRICS}.`, [...at, 'metrics', 'prometheus'], { key: true, template })
    }
    list.forEach((m, i) => {
      const g = obj(obj(m)?.gauge)
      if (g && g.realtime === true && (str(g.value) ?? '').includes('resourcesDuration.')) {
        add('cel/realtime-resources-duration', '`resourcesDuration.*` is known only when the step ends; it cannot feed a real-time gauge.', [...at, 'metrics', 'prometheus', i, 'gauge', 'value'], { template })
      }
    })
  }

  function checkMaxParameters(holder: Record<string, unknown>, at: Path, template?: string) {
    const n = arr(obj(holder.inputs)?.parameters).length
    if (n > MAX_PARAMETERS) add('cel/max-parameters', `${n} input parameters; Argo refuses more than ${MAX_PARAMETERS}.`, [...at, 'inputs', 'parameters'], { key: true, template })
  }

  function checkParameters(list: unknown, at: Path, template: string | undefined) {
    arr(list).forEach((p, i) => {
      const param = obj(p)
      const name = str(param?.name)
      if (!param || !name || !looksSecret(name)) return
      const from = obj(param.valueFrom)
      if (from && (from.secretKeyRef || from.configMapKeyRef)) return
      add('platform/secret-parameter', `"${name}" reads as a secret. Parameters are stored and shown in plain text; mount a Secret (env valueFrom.secretKeyRef) instead.`, [...at, i, 'name'], { template })
    })
  }

  /**
   * `at most one artifact location`, everywhere the CRD says it: every item of
   * every list named `artifacts` (inputs, outputs, arguments), a template's
   * `archiveLocation`, `data.source.artifactPaths` and
   * `resource.manifestFrom.artifact`.
   */
  function checkArtifacts(v: unknown, at: Path) {
    if (Array.isArray(v)) {
      v.forEach((x, i) => checkArtifacts(x, [...at, i]))
      return
    }
    const o = obj(v)
    if (!o) return
    const one = (a: unknown, p: Path, what: string) => {
      const art = obj(a)
      if (!art) return
      const set = ARTIFACT_LOCATIONS.filter((loc) => art[loc] !== undefined)
      if (set.length > 1) add('cel/one-artifact-location', `${what} names ${set.length} locations (${set.join(', ')}); it can have one.`, [...p, set[1]], { key: true })
    }
    for (const [k, x] of Object.entries(o)) {
      if (k === 'artifacts' && Array.isArray(x)) x.forEach((a, i) => one(a, [...at, k, i], `The artifact "${str(obj(a)?.name) ?? i}"`))
      else if (k === 'archiveLocation') one(x, [...at, k], 'archiveLocation')
      else if (k === 'artifactPaths') one(x, [...at, k], 'artifactPaths')
      else if (k === 'manifestFrom') one(obj(x)?.artifact, [...at, k, 'artifact'], 'manifestFrom.artifact')
      checkArtifacts(x, [...at, k])
    }
  }

  function checkManifest(b: Record<string, unknown>, at: Path, template: string | undefined) {
    const res = obj(b.resource)
    if (res && res.manifest !== undefined && res.manifestFrom !== undefined) {
      add('cel/manifest-or-manifest-from', 'A resource template takes `manifest` or `manifestFrom`, not both.', [...at, 'resource', 'manifestFrom'], { key: true, template })
    }
  }

  function checkSequence(c: TaskAt, extra: Partial<Diagnostic>) {
    const seq = obj(c.body.withSequence)
    if (seq && seq.count !== undefined && seq.end !== undefined) {
      add('cel/sequence-count-or-end', 'withSequence takes `count` or `end`, not both.', [...c.path, 'withSequence', 'end'], { key: true, ...extra })
    }
  }

  function checkTemplate(t: TemplateAt) {
    const b = t.body
    const template = t.name || undefined
    const types = TEMPLATE_TYPES.filter((k) => b[k] !== undefined && b[k] !== null)
    if (types.length > 1) {
      add('cel/one-template-type', `The template "${t.name}" is ${types.join(' and ')} at once; a template is one type.`, [...t.path, types[1]], { key: true, template })
    }
    const composite = b.steps !== undefined || b.dag !== undefined
    if (composite && b.timeout !== undefined && b.timeout !== '') {
      add('cel/timeout-on-steps-or-dag', `\`timeout\` does nothing on a ${b.dag !== undefined ? 'DAG' : 'steps'} template; put it on the steps it runs.`, [...t.path, 'timeout'], { key: true, template })
    }
    if (composite && b.activeDeadlineSeconds !== undefined) {
      add('cel/active-deadline-leaf-only', '`activeDeadlineSeconds` is valid only on a template that runs a pod; for the whole workflow set it on the spec.', [...t.path, 'activeDeadlineSeconds'], { key: true, template })
    }
    checkMaxParameters(b, t.path, template)
    checkMetrics(b, t.path, template)
    checkSynchronization(b, t.path)
    checkServiceAccount(b, t.path, template)
    checkParameters(obj(b.inputs)?.parameters, [...t.path, 'inputs', 'parameters'], template)

    checkManifest(b, t.path, template)

    for (const type of ['container', 'script'] as const) {
      const c = obj(b[type])
      if (!c) continue
      const r = obj(c.resources)
      if (!r || (!obj(r.requests) && !obj(r.limits))) {
        add('platform/missing-resources', `"${t.name}" sets no CPU or memory; it takes the namespace defaults and may be killed for exceeding them.`, [...t.path, type], { key: true, template })
      }
      const image = str(c.image)
      const registry = image ? registryOf(image) : undefined
      if (registry && !registries.includes(registry) && !registry.startsWith('harbor')) {
        add('platform/image-registry', `${registry} is not a registry the platform allows (Harbor, ${registries.join(', ')}); the pod will be refused in a team namespace.`, [...t.path, type, 'image'], { template })
      }
      if (type === 'script' && PARAM_SPLICE.test(str(c.source) ?? '')) {
        add('platform/parameter-in-script', 'A parameter is spliced into the script source: whoever sets it can run any command. Pass it as an environment variable and read that.', [...t.path, 'script', 'source'], { template })
      }
      if (type === 'container') {
        const spliced = strings([c.command, c.args], []).some((s) => PARAM_SPLICE.test(s.value))
        if (spliced) add('platform/parameter-in-args', 'A parameter is spliced into the command line; an environment variable is safer when a shell reads it.', [...t.path, 'container', c.args !== undefined ? 'args' : 'command'], { key: true, template })
      }
    }

    if (b.dag !== undefined) checkDag(t)
    for (const group of stepGroupsOf(t)) {
      for (const s of group) {
        checkSequence(s, { template })
        checkCallee(s, { template })
      }
    }
  }

  function checkCallee(c: TaskAt, extra: Partial<Diagnostic>) {
    const local = str(c.body.template)
    if (c.body.templateRef === undefined && c.body.inline === undefined && !local) {
      add('graph/task-without-template', `"${c.name}" names no template, templateRef or inline template, so it runs nothing.`, c.path, extra)
    } else if (local && c.body.templateRef === undefined && !shape.byName.has(local) && !local.includes('{{')) {
      add('graph/missing-template', `"${c.name}" uses the template "${local}", and there is no template of that name.`, [...c.path, 'template'], extra)
    }
  }

  function checkDag(t: TemplateAt) {
    const tasks = tasksOf(t)
    const dag = t.name
    const at = (task: TaskAt) => ({ task: { dag, name: task.name, uid: uidOf(shape.entry, dag, task.name) } })
    if (tasks.length > MAX_DAG_TASKS) {
      add('cel/dag-max-tasks', `${tasks.length} tasks in "${dag}"; Argo refuses more than ${MAX_DAG_TASKS}. Split it into sub-flows.`, [...t.path, 'dag', 'tasks'], { key: true, template: dag })
    } else if (tasks.length > LARGE_DAG) {
      add('platform/large-dag', `${tasks.length} tasks in "${dag}". Argo stops at ${MAX_DAG_TASKS}, and a graph this size is hard to read: consider sub-flows.`, [...t.path, 'dag', 'tasks'], { key: true, template: dag })
    }
    const names = new Set<string>()
    for (const task of tasks) {
      if (task.name && names.has(task.name)) add('graph/duplicate-name', `Two tasks in "${dag}" are named "${task.name}".`, [...task.path, 'name'], at(task))
      names.add(task.name)
    }
    const edges: Array<{ source: string; target: string }> = []
    for (const task of tasks) {
      const b = task.body
      const hasDepends = b.depends !== undefined
      const hasDependencies = b.dependencies !== undefined
      if (!TASK_NAME.test(task.name)) {
        add('graph/invalid-name', `"${task.name}" is not a task name Argo accepts: letters, digits and -, starting with a letter or digit.`, [...task.path, 'name'], at(task))
      }
      if (hasDepends && hasDependencies) {
        add('cel/depends-and-dependencies', `"${task.name}" has both \`depends\` and \`dependencies\`; Argo takes one.`, [...task.path, 'dependencies'], { key: true, ...at(task) })
      }
      if (hasDepends && b.continueOn !== undefined) {
        add('cel/continue-on-with-depends', `"${task.name}" has \`continueOn\` with \`depends\`. Say it in depends instead: \`a.Succeeded || a.Failed\`.`, [...task.path, 'continueOn'], { key: true, ...at(task) })
      }
      if ((hasDepends || hasDependencies) && /^[0-9]/.test(task.name)) {
        add('cel/task-name-digit', `"${task.name}" begins with a digit, which a task with dependencies may not.`, [...task.path, 'name'], at(task))
      }
      checkSequence(task, at(task))
      checkCallee(task, at(task))

      const depends = str(b.depends)
      if (depends !== undefined && depends.trim()) {
        const parsed = parseDepends(depends)
        if (!parsed.ok) add('depends/syntax', `depends of "${task.name}": ${parsed.message}`, [...task.path, 'depends'], at(task))
      }
      for (const dep of dependenciesOf(b)) {
        if (!names.has(dep)) {
          add('graph/unknown-dependency', `"${task.name}" depends on "${dep}", and "${dag}" has no task of that name.`, [...task.path, hasDepends ? 'depends' : 'dependencies'], at(task))
        } else edges.push({ source: dep, target: task.name })
      }
    }
    const cycle = findCycle([...names], edges)
    if (cycle) {
      const first = tasks.find((x) => x.name === cycle[0])!
      add('graph/cycle', `These tasks wait for each other and none can start: ${cycle.join(' → ')}.`, [...first.path, first.body.depends !== undefined ? 'depends' : 'dependencies'], at(first))
    }

    /* ancestors, for "reads from a task it does not depend on" and for skippable outputs */
    const parents = new Map<string, string[]>()
    for (const n of names) parents.set(n, [])
    for (const e of edges) parents.get(e.target)!.push(e.source)
    const ancestors = (name: string): Set<string> => {
      const seen = new Set<string>()
      const walk = (n: string) => {
        for (const p of parents.get(n) ?? []) {
          if (!seen.has(p)) {
            seen.add(p)
            walk(p)
          }
        }
      }
      walk(name)
      return seen
    }
    const byTask = new Map(tasks.map((x) => [x.name, x]))

    /* a task can be skipped when it has `when`, or anything upstream of it has */
    const conditional = new Set(tasks.filter((x) => x.body.when !== undefined && x.body.when !== '').map((x) => x.name))
    const skippable = new Set<string>()
    for (const task of tasks) {
      if (conditional.has(task.name) || [...ancestors(task.name)].some((a) => conditional.has(a))) skippable.add(task.name)
    }

    const reported = new Set<string>()
    const readsFrom = (reader: TaskAt | undefined, text: { value: string; path: Path }) => {
      // A string that names the same task twice is one finding, not two.
      for (const ref of new Set(taskRefs(text.value))) {
        const extra = reader ? at(reader) : { template: dag }
        if (!names.has(ref)) {
          add('graph/dangling-task-reference', `${reader ? `"${reader.name}"` : `The outputs of "${dag}"`} read${reader ? 's' : ''} from the task "${ref}", and "${dag}" has no task of that name.`, text.path, extra)
          continue
        }
        if (reader && ref !== reader.name && !cycle && !ancestors(reader.name).has(ref)) {
          add('graph/reference-without-dependency', `"${reader.name}" reads from "${ref}" without depending on it, so it may run before "${ref}" has anything to give.`, text.path, extra)
        }
        if (skippable.has(ref)) {
          const producer = byTask.get(ref)!
          const tmpl = shape.byName.get(str(producer.body.template) ?? '')
          if (!tmpl || producer.body.templateRef !== undefined) continue
          const re = new RegExp(`tasks(?:\\.${escapeRe(ref)}|\\[\\s*['"]${escapeRe(ref)}['"]\\s*\\])\\.outputs\\.parameters\\.([A-Za-z0-9_-]+)`, 'g')
          for (const m of text.value.matchAll(re)) {
            const params = arr(obj(tmpl.body.outputs)?.parameters)
            const i = params.findIndex((p) => str(obj(p)?.name) === m[1])
            if (i < 0) continue
            const vf = obj(obj(params[i])?.valueFrom)
            if (vf && vf.default !== undefined) continue
            const key = `${tmpl.name}/${m[1]}`
            if (reported.has(key)) continue
            reported.add(key)
            add(
              'v4/skipped-output-default',
              `"${ref}" can be skipped, and ${reader ? `"${reader.name}"` : `"${dag}"`} reads its output "${m[1]}". Argo 4 fails the reader unless the output declares valueFrom.default.`,
              [...tmpl.path, 'outputs', 'parameters', i],
              { template: tmpl.name, task: { dag, name: ref, uid: uidOf(shape.entry, dag, ref) } },
            )
          }
        }
      }
    }
    for (const task of tasks) {
      const { depends: _d, dependencies: _deps, ...rest } = task.body
      for (const s of strings(rest, task.path)) readsFrom(task, s)
    }
    for (const s of strings(t.body.outputs, [...t.path, 'outputs'])) readsFrom(undefined, s)

    /* `dag.target`: only the targets and what they need run */
    const target = str(obj(t.body.dag)?.target)
    if (target && !target.includes('{{')) {
      const wanted = new Set<string>()
      for (const name of target.split(/\s+/).filter(Boolean)) {
        if (!names.has(name)) continue
        wanted.add(name)
        for (const a of ancestors(name)) wanted.add(a)
      }
      for (const task of tasks) {
        if (!wanted.has(task.name)) add('graph/unreachable-task', `"${task.name}" never runs: the DAG's target is "${target}", which does not need it.`, [...task.path, 'name'], at(task))
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when nothing stops a publish or a test run (§6.7: errors block; warnings need a confirmation). */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((x) => x.level === 'error')
}

/** Whether `depends` of a task is a pure conjunction the canvas can edit edge by edge. */
export function isCanvasEditable(depends: string | undefined): boolean {
  return depends === undefined || conjunctionTerms(depends) !== null
}
