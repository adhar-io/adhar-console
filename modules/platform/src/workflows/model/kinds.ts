/**
 * The node-kind registry (design 0026 §6.6): what the palette offers, what
 * each entry compiles to, which fields the inspector shows for it, and how a
 * task found in somebody's YAML is recognised as one of them.
 *
 * A kind is INFERRED from the template a task references, never stored: the
 * document carries no "kind" field, so a template written by hand and one
 * dropped from the palette are the same thing to the canvas.
 *
 * The "Platform steps" section is built from the catalogue
 * ClusterWorkflowTemplates on the cluster (`adhar.io/node-kind` and Argo's
 * title/description annotations, §5.7), so a new platform step needs no
 * console release. Pure data and pure functions: `kinds_test.ts`.
 */

export type NodeKind =
  // In the palette.
  | 'container'
  | 'script'
  | 'resource'
  | 'http'
  | 'approval'
  | 'timer'
  | 'template'
  | 'platform-step'
  | 'subflow'
  | 'batch-job'
  | 'chaos'
  // Recognised in a document, never created by the palette.
  | 'suspend'
  | 'steps'
  | 'container-set'
  | 'data'
  | 'plugin'
  | 'inline'
  | 'unknown'

export interface TemplateRef {
  name: string
  template: string
  clusterScope?: boolean
}

/** The template types Argo allows exactly one of per template (its CEL rule; `validate.ts` mirrors it). */
export const TEMPLATE_TYPES = ['container', 'script', 'dag', 'steps', 'resource', 'suspend', 'containerSet', 'data', 'http', 'plugin'] as const
export type TemplateType = typeof TEMPLATE_TYPES[number]

/** The libraries the platform ships (§5.7). */
export const STEPS_LIBRARY = 'adhar-steps'
export const BATCH_STEPS_LIBRARY = 'adhar-batch-steps'
export const GAMEDAY_STEPS_LIBRARY = 'adhar-gameday-steps'
export const APPROVAL_REF: TemplateRef = { name: STEPS_LIBRARY, template: 'approval', clusterScope: true }

/** `adhar.io/node-kind` on a catalogue template → the designer's kind (the vocabulary the platform guard pins). */
export const CATALOGUE_NODE_KINDS: Readonly<Record<string, NodeKind>> = {
  approval: 'approval',
  'http-check': 'platform-step',
  'wait-healthy': 'platform-step',
  k6: 'platform-step',
  gameday: 'chaos',
  'batch-job': 'batch-job',
}

export const NODE_KIND_ANNOTATION = 'adhar.io/node-kind'
const TITLE_ANNOTATION = 'workflows.argoproj.io/title'
const DESCRIPTION_ANNOTATION = 'workflows.argoproj.io/description'
const CATALOG_LABEL = 'adhar.io/catalog'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)

/* ─────────────────────────── the catalogue ─────────────────────────── */

export interface StepInput {
  name: string
  /** The template's default; a run that passes nothing gets this. */
  default?: string
  enum?: string[]
  description?: string
  /** No default: the task must pass a value. */
  required: boolean
}

/** One callable template of a step library on the cluster. */
export interface CatalogueStep {
  ref: TemplateRef
  /** The raw `adhar.io/node-kind`. */
  nodeKind: string
  kind: NodeKind
  title: string
  description?: string
  inputs: StepInput[]
  outputs: string[]
}

function inputsOf(template: Obj): StepInput[] {
  return arr(obj(template.inputs)?.parameters).map(obj).filter((p): p is Obj => Boolean(p && str(p.name))).map((p) => {
    const def = str(p.default) ?? str(p.value)
    const en = arr(p.enum).map(str).filter((e): e is string => e !== undefined)
    return { name: str(p.name)!, default: def, enum: en.length ? en : undefined, description: str(p.description), required: def === undefined }
  })
}

/**
 * The steps a set of templates offers to other workflows.
 *
 * From ClusterWorkflowTemplates: every template of a catalogue step library
 * (labelled `adhar.io/catalog`, no entrypoint) that carries a node kind the
 * designer knows. A template with an unknown kind is left out rather than
 * guessed at — it would land on the canvas with nothing to compile to.
 */
export function catalogueSteps(clusterTemplates: readonly unknown[]): CatalogueStep[] {
  const out: CatalogueStep[] = []
  for (const raw of clusterTemplates) {
    const t = obj(raw)
    const meta = obj(t?.metadata)
    const spec = obj(t?.spec)
    const library = str(meta?.name)
    if (!t || !library || !spec) continue
    if (obj(meta?.labels)?.[CATALOG_LABEL] !== 'true' || spec.entrypoint) continue
    for (const tm of arr(spec.templates).map(obj)) {
      const name = str(tm?.name)
      const ann = obj(obj(tm?.metadata)?.annotations) ?? {}
      const nodeKind = str(ann[NODE_KIND_ANNOTATION])
      if (!tm || !name || !nodeKind) continue
      const kind = CATALOGUE_NODE_KINDS[nodeKind]
      if (!kind) continue
      out.push({
        ref: { name: library, template: name, clusterScope: true },
        nodeKind,
        kind,
        title: str(ann[TITLE_ANNOTATION]) ?? name,
        description: str(ann[DESCRIPTION_ANNOTATION])?.trim(),
        inputs: inputsOf(tm),
        outputs: arr(obj(tm.outputs)?.parameters).map((p) => str(obj(p)?.name)).filter((n): n is string => Boolean(n)),
      })
    }
  }
  return out.sort((a, b) => (a.ref.name + '/' + a.ref.template < b.ref.name + '/' + b.ref.template ? -1 : 1))
}

/* ─────────────────────────── inference ─────────────────────────── */

/** The template type a template declares (the first, when — wrongly — it declares several). */
export function templateTypeOf(template: unknown): TemplateType | undefined {
  const t = obj(template)
  if (!t) return undefined
  return TEMPLATE_TYPES.find((k) => t[k] !== undefined && t[k] !== null)
}

export function refOf(task: unknown): TemplateRef | undefined {
  const r = obj(obj(task)?.templateRef)
  const name = str(r?.name)
  const template = str(r?.template)
  if (!name || !template) return undefined
  return { name, template, ...(r?.clusterScope === true ? { clusterScope: true } : {}) }
}

/** The kind of a `templateRef`: from the catalogue when it is known, else from the platform's library names. */
export function kindOfRef(ref: TemplateRef, catalogue: readonly CatalogueStep[] = []): NodeKind {
  const known = catalogue.find((s) => s.ref.name === ref.name && s.ref.template === ref.template && Boolean(ref.clusterScope))
  if (known) return known.kind
  if (ref.clusterScope) {
    if (ref.name === STEPS_LIBRARY) return ref.template === 'approval' ? 'approval' : ref.template === 'run-gameday' ? 'chaos' : 'platform-step'
    if (ref.name === BATCH_STEPS_LIBRARY) return 'batch-job'
    if (ref.name === GAMEDAY_STEPS_LIBRARY) return 'platform-step'
  }
  return 'template'
}

/** The kind of a local template. A suspend with a duration and nothing to supply is a timer; any other suspend waits for a person. */
export function kindOfTemplate(template: unknown): NodeKind {
  const t = obj(template)
  switch (templateTypeOf(t)) {
    case 'container':
      return 'container'
    case 'script':
      return 'script'
    case 'resource':
      return 'resource'
    case 'http':
      return 'http'
    case 'dag':
      return 'subflow'
    case 'steps':
      return 'steps'
    case 'containerSet':
      return 'container-set'
    case 'data':
      return 'data'
    case 'plugin':
      return 'plugin'
    case 'suspend': {
      const duration = obj(t!.suspend)?.duration
      const supplied = arr(obj(t!.outputs)?.parameters).some((p) => obj(obj(p)?.valueFrom)?.supplied !== undefined)
      return duration !== undefined && duration !== '' && !supplied ? 'timer' : 'suspend'
    }
    default:
      return 'unknown'
  }
}

/** The kind of a DAG task or a step, given the document's local templates. */
export function inferKind(task: unknown, templates: ReadonlyMap<string, unknown>, catalogue: readonly CatalogueStep[] = []): NodeKind {
  const t = obj(task)
  if (!t) return 'unknown'
  if (t.inline !== undefined) return 'inline'
  const ref = refOf(t)
  if (ref) return kindOfRef(ref, catalogue)
  const name = str(t.template)
  if (!name || !templates.has(name)) return 'unknown'
  return kindOfTemplate(templates.get(name))
}

/* ─────────────────────────── the inspector schema ─────────────────────────── */

export type FieldControl =
  | 'text'
  | 'textarea'
  | 'code'
  | 'yaml'
  | 'select'
  | 'number'
  | 'duration'
  | 'toggle'
  | 'string-list'
  | 'env'
  | 'secret-env'
  | 'headers'
  | 'resources'
  | 'volumes'
  | 'approvers'
  | 'argument'
  | 'template-picker'
  | 'batchjob-picker'
  | 'gameday-picker'

/**
 * One inspector field. `target` says which object `path` is relative to: the
 * DAG task, the local template the task uses, or the workflow spec. An
 * `argument` field edits `arguments.parameters[name=param]` of the task
 * (`ops.ts` `setArgument`), not a path.
 */
export interface InspectorField {
  id: string
  label: string
  target: 'task' | 'template' | 'spec'
  path: readonly (string | number)[]
  control: FieldControl
  required?: boolean
  options?: readonly string[]
  /** Monaco language for `code`. */
  language?: string
  placeholder?: string
  help?: string
  /** `argument` only. */
  param?: string
}

/** Fields every task has, whatever it runs (shown under the kind's own). */
export const TASK_FIELDS: readonly InspectorField[] = [
  { id: 'when', label: 'Run only when', target: 'task', path: ['when'], control: 'text', placeholder: '{{tasks.check.outputs.result}} == ok', help: 'An expression; the task is skipped when it is false.' },
  { id: 'depends', label: 'Depends on', target: 'task', path: ['depends'], control: 'text', help: 'Edited on the canvas; type here for || and ! expressions.' },
]

/** Fields of any local leaf template (retries, deadline), shown under the kind's own. */
export const LEAF_FIELDS: readonly InspectorField[] = [
  { id: 'retries', label: 'Retries', target: 'template', path: ['retryStrategy', 'limit'], control: 'number', help: 'How many times a failed attempt is tried again.' },
  { id: 'deadline', label: 'Time limit (seconds)', target: 'template', path: ['activeDeadlineSeconds'], control: 'number', help: 'The step is stopped and fails after this long.' },
]

const RESOURCES: Obj = { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } }
const NON_ROOT: Obj = {
  runAsNonRoot: true,
  runAsUser: 65532,
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  seccompProfile: { type: 'RuntimeDefault' },
}

export const SCRIPT_PRESETS: Readonly<Record<string, { image: string; command: string[]; source: string; language: string }>> = {
  bash: { image: 'docker.io/library/bash:5.2', command: ['bash'], source: 'set -euo pipefail\necho "hello"\n', language: 'shell' },
  python: { image: 'docker.io/library/python:3.13-slim', command: ['python'], source: 'print("hello")\n', language: 'python' },
  node: { image: 'docker.io/library/node:22-slim', command: ['node'], source: 'console.log("hello")\n', language: 'javascript' },
  deno: { image: 'docker.io/denoland/deno:2.1.4', command: ['deno', 'run'], source: 'console.log("hello")\n', language: 'typescript' },
}

export type PaletteSection = 'Run something' | 'Flow control' | 'Platform steps' | 'Reuse'

export interface PaletteEntry {
  /** Stable id (`container`, `approval`, `step:adhar-steps/http-check`). */
  id: string
  kind: NodeKind
  section: PaletteSection
  title: string
  description: string
  /** Seed for the task (and local template) name; made unique on drop. */
  baseName: string
  /** What dropping it does: a local template, a reference, a sub-flow, or the exit lane. */
  action: 'local' | 'ref' | 'pick-ref' | 'exit'
  /** `local`: the body of the new template (without `name`). A fresh object every call. */
  template?: () => Obj
  /** `ref`: what the task references, and the arguments it must pass. */
  ref?: TemplateRef
  arguments?: Array<{ name: string; value: string }>
  /** Hidden unless the capability is present (`data/api.ts` Capabilities). */
  requires?: 'batch' | 'gamedays'
  /** What the inspector shows under the name. */
  guardrails: readonly string[]
  fields: readonly InspectorField[]
}

const tpl = (path: (string | number)[]) => ({ target: 'template' as const, path })

const CONTAINER_FIELDS: readonly InspectorField[] = [
  { id: 'image', label: 'Image', ...tpl(['container', 'image']), control: 'text', required: true, placeholder: 'ghcr.io/acme/tool:1.2.3', help: 'Pinned by tag. Harbor, ghcr.io, quay.io, docker.io and registry.k8s.io are allowed (restrict-image-registries-enforce).' },
  { id: 'command', label: 'Command', ...tpl(['container', 'command']), control: 'string-list' },
  { id: 'args', label: 'Arguments', ...tpl(['container', 'args']), control: 'string-list' },
  { id: 'env', label: 'Environment', ...tpl(['container', 'env']), control: 'env' },
  { id: 'secret-env', label: 'Secrets as environment', ...tpl(['container', 'env']), control: 'secret-env', help: 'Picks a Secret in the namespace by name; its value never reaches the console.' },
  { id: 'resources', label: 'Resources', ...tpl(['container', 'resources']), control: 'resources', required: true },
  { id: 'workingDir', label: 'Working directory', ...tpl(['container', 'workingDir']), control: 'text' },
  { id: 'volumes', label: 'Scratch volumes (emptyDir)', ...tpl(['volumes']), control: 'volumes' },
  { id: 'nonRoot', label: 'Run as non-root', ...tpl(['container', 'securityContext', 'runAsNonRoot']), control: 'toggle' },
]

const SCRIPT_FIELDS: readonly InspectorField[] = [
  { id: 'image', label: 'Image', ...tpl(['script', 'image']), control: 'text', required: true },
  { id: 'command', label: 'Interpreter', ...tpl(['script', 'command']), control: 'string-list' },
  { id: 'source', label: 'Source', ...tpl(['script', 'source']), control: 'code', required: true, language: 'shell' },
  { id: 'env', label: 'Environment', ...tpl(['script', 'env']), control: 'env', help: 'Pass parameters here as PARAM_<NAME>; never splice {{…}} into the source.' },
  { id: 'resources', label: 'Resources', ...tpl(['script', 'resources']), control: 'resources', required: true },
]

const RESOURCE_FIELDS: readonly InspectorField[] = [
  { id: 'action', label: 'Action', ...tpl(['resource', 'action']), control: 'select', required: true, options: ['create', 'apply', 'patch', 'delete', 'get'] },
  { id: 'manifest', label: 'Manifest', ...tpl(['resource', 'manifest']), control: 'yaml', required: true },
  { id: 'successCondition', label: 'Succeeds when', ...tpl(['resource', 'successCondition']), control: 'text', placeholder: 'status.succeeded > 0' },
  { id: 'failureCondition', label: 'Fails when', ...tpl(['resource', 'failureCondition']), control: 'text', placeholder: 'status.failed > 0' },
  { id: 'setOwnerReference', label: 'Owned by the run', ...tpl(['resource', 'setOwnerReference']), control: 'toggle', help: 'The object is deleted with the run.' },
]

const HTTP_FIELDS: readonly InspectorField[] = [
  { id: 'url', label: 'URL', ...tpl(['http', 'url']), control: 'text', required: true },
  { id: 'method', label: 'Method', ...tpl(['http', 'method']), control: 'select', options: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { id: 'headers', label: 'Headers', ...tpl(['http', 'headers']), control: 'headers', help: 'A header value can come from a Secret.' },
  { id: 'body', label: 'Body', ...tpl(['http', 'body']), control: 'textarea' },
  { id: 'successCondition', label: 'Succeeds when', ...tpl(['http', 'successCondition']), control: 'text', placeholder: 'response.statusCode == 200' },
  { id: 'timeoutSeconds', label: 'Timeout (seconds)', ...tpl(['http', 'timeoutSeconds']), control: 'number' },
]

function argumentFields(inputs: readonly StepInput[]): InspectorField[] {
  return inputs.map((p) => ({
    id: `arg:${p.name}`,
    label: p.name,
    target: 'task' as const,
    path: ['arguments', 'parameters'],
    control: 'argument' as const,
    param: p.name,
    required: p.required,
    options: p.enum,
    placeholder: p.default,
    help: p.description,
  }))
}

const APPROVAL_INPUTS: readonly StepInput[] = [
  { name: 'question', default: 'Approve this run?', description: 'What the approver is asked.', required: false },
  { name: 'approvers', default: '', description: 'Keycloak groups or users, comma-separated. Empty: anyone who may resume runs here.', required: false },
  { name: 'timeout', default: '4h', description: 'With no decision after this long the answer is REJECT.', required: false },
  { name: 'forbidSelfApproval', default: 'true', enum: ['true', 'false'], description: 'The person who started the run cannot approve it.', required: false },
]

/** The palette's own entries; platform steps are added from the catalogue by `palette()`. */
const BUILT_IN: readonly PaletteEntry[] = [
  {
    id: 'container',
    kind: 'container',
    section: 'Run something',
    title: 'Container',
    description: 'Run an image with a command.',
    baseName: 'run',
    action: 'local',
    template: () => ({
      container: {
        image: 'docker.io/library/busybox:1.37',
        command: ['sh', '-c'],
        args: ['echo hello'],
        resources: structuredClone(RESOURCES),
        securityContext: structuredClone(NON_ROOT),
      },
    }),
    guardrails: ['Pass parameters as environment variables rather than splicing them into args.'],
    fields: CONTAINER_FIELDS,
  },
  {
    id: 'script',
    kind: 'script',
    section: 'Run something',
    title: 'Script',
    description: 'Run a short bash, Python, Node or Deno script.',
    baseName: 'script',
    action: 'local',
    template: () => ({
      script: {
        image: SCRIPT_PRESETS.bash.image,
        command: [...SCRIPT_PRESETS.bash.command],
        source: SCRIPT_PRESETS.bash.source,
        resources: structuredClone(RESOURCES),
        securityContext: structuredClone(NON_ROOT),
      },
    }),
    guardrails: ['Parameters reach a script as environment variables (PARAM_<NAME>), never spliced into the source: that is shell injection.'],
    fields: SCRIPT_FIELDS,
  },
  {
    id: 'resource',
    kind: 'resource',
    section: 'Run something',
    title: 'Kubernetes resource',
    description: 'Create, apply, patch, delete or read an object.',
    baseName: 'resource',
    action: 'local',
    template: () => ({
      resource: {
        action: 'create',
        setOwnerReference: true,
        manifest: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  generateName: example-\ndata:\n  key: value\n',
      },
    }),
    guardrails: ['Runs as the workflow\'s ServiceAccount (adhar-workflow): it needs RBAC for the verb and kind in the manifest.'],
    fields: RESOURCE_FIELDS,
  },
  {
    id: 'http',
    kind: 'http',
    section: 'Run something',
    title: 'HTTP call',
    description: 'Call a URL and judge the response.',
    baseName: 'call',
    action: 'local',
    template: () => ({ http: { url: 'https://example.com/', method: 'GET', timeoutSeconds: 30, successCondition: 'response.statusCode >= 200 && response.statusCode < 300' } }),
    guardrails: ['Runs in the workflow\'s agent pod and may be retried: the call must be idempotent.'],
    fields: HTTP_FIELDS,
  },
  {
    id: 'approval',
    kind: 'approval',
    section: 'Flow control',
    title: 'Approval',
    description: 'Wait for a person to approve or reject.',
    baseName: 'approve',
    action: 'ref',
    ref: APPROVAL_REF,
    arguments: [{ name: 'question', value: 'Approve this run?' }, { name: 'approvers', value: '' }],
    guardrails: [
      'A rejection is an output, not a failure: guard the next step with `when: "{{tasks.<name>.outputs.parameters.decision}} == approve"`.',
      'With no decision before the timeout the answer is reject.',
    ],
    fields: [
      ...argumentFields(APPROVAL_INPUTS).map((f) => (f.param === 'approvers' ? { ...f, control: 'approvers' as const } : f.param === 'timeout' ? { ...f, control: 'duration' as const } : f)),
    ],
  },
  {
    id: 'timer',
    kind: 'timer',
    section: 'Flow control',
    title: 'Timer',
    description: 'Wait for a fixed time.',
    baseName: 'wait',
    action: 'local',
    template: () => ({ suspend: { duration: '5m' } }),
    guardrails: [],
    fields: [{ id: 'duration', label: 'Wait for', ...tpl(['suspend', 'duration']), control: 'duration', required: true, placeholder: '5m' }],
  },
  {
    id: 'subflow',
    kind: 'subflow',
    section: 'Flow control',
    title: 'Sub-flow',
    description: 'A group of steps with its own graph.',
    baseName: 'group',
    action: 'local',
    template: () => ({ dag: { tasks: [] } }),
    guardrails: ['Keep a DAG under 200 tasks (Argo refuses more); split a large graph into sub-flows.'],
    fields: [],
  },
  {
    id: 'exit-handler',
    kind: 'subflow',
    section: 'Flow control',
    title: 'Exit handler',
    description: 'Steps that run when the workflow ends, whatever the outcome.',
    baseName: 'on-exit',
    action: 'exit',
    guardrails: ['Runs after success and after failure; read {{workflow.status}} to tell them apart.'],
    fields: [],
  },
  {
    id: 'template',
    kind: 'template',
    section: 'Reuse',
    title: 'Template',
    description: 'Call a WorkflowTemplate in this namespace or a catalogue template.',
    baseName: 'call-template',
    action: 'pick-ref',
    guardrails: [],
    fields: [{ id: 'ref', label: 'Template', target: 'task', path: ['templateRef'], control: 'template-picker', required: true }],
  },
]

const KIND_FIELDS: Partial<Record<NodeKind, readonly InspectorField[]>> = {
  container: CONTAINER_FIELDS,
  script: SCRIPT_FIELDS,
  resource: RESOURCE_FIELDS,
  http: HTTP_FIELDS,
  timer: BUILT_IN.find((e) => e.id === 'timer')!.fields,
  suspend: [{ id: 'duration', label: 'Resume automatically after', ...tpl(['suspend', 'duration']), control: 'duration', help: 'Empty: waits until someone resumes it.' }],
}

const STEP_GUARDRAILS: Readonly<Record<string, readonly string[]>> = {
  'http-check': ['Runs in the workflow\'s agent pod and is retried until the timeout: the URL must be safe to call repeatedly.'],
  'wait-healthy': ['Waits only on workloads in the workflow\'s own namespace.'],
  k6: ['Failed thresholds are a result (thresholdsPassed), not a failure, unless failOnThresholds is true.'],
  gameday: ['Faults run only through a vetted game-day plan.'],
  'batch-job': ['Runs the BatchJob through `adhar batch run`; the queue comes from the BatchJob.'],
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step'

/** The palette entry of one catalogue step. */
export function stepEntry(s: CatalogueStep): PaletteEntry {
  const picker: InspectorField[] = s.kind === 'batch-job'
    ? [{ id: 'batchjob', label: 'Batch job', target: 'task', path: ['arguments', 'parameters'], control: 'batchjob-picker', param: 'batchJob', required: true }]
    : s.kind === 'chaos'
    ? [{ id: 'plan', label: 'Game-day plan', target: 'task', path: ['arguments', 'parameters'], control: 'gameday-picker', param: 'plan', required: true }]
    : []
  const picked = new Set(picker.map((f) => f.param))
  return {
    id: `step:${s.ref.name}/${s.ref.template}`,
    kind: s.kind,
    section: s.kind === 'approval' ? 'Flow control' : 'Platform steps',
    title: s.title,
    description: s.description ?? '',
    baseName: slug(s.ref.template),
    action: 'ref',
    ref: { ...s.ref },
    arguments: s.inputs.filter((p) => p.required).map((p) => ({ name: p.name, value: '' })),
    requires: s.kind === 'batch-job' ? 'batch' : s.kind === 'chaos' ? 'gamedays' : undefined,
    guardrails: STEP_GUARDRAILS[s.nodeKind] ?? [],
    fields: [...picker, ...argumentFields(s.inputs.filter((p) => !picked.has(p.name)))],
  }
}

/**
 * The palette: the built-in entries plus one per catalogue step, filtered by
 * what the cluster can do. The catalogue's own `approval` replaces the
 * built-in one (same reference; its inputs come from the cluster).
 */
export function palette(catalogue: readonly CatalogueStep[] = [], capabilities: { batch?: boolean; gamedays?: boolean } = {}): PaletteEntry[] {
  const fromCatalogue = catalogue.map(stepEntry)
  const approval = fromCatalogue.find((e) => e.kind === 'approval' && e.ref?.name === APPROVAL_REF.name && e.ref.template === APPROVAL_REF.template)
  const builtIn = BUILT_IN.map((e) => {
    if (e.id !== 'approval' || !approval) return e
    // Keep the built-in id, name seed and guardrails; take the cluster's title and inputs.
    return { ...e, title: approval.title, description: approval.description || e.description, fields: approval.fields.map((f) => (f.param === 'approvers' ? { ...f, control: 'approvers' as const } : f.param === 'timeout' ? { ...f, control: 'duration' as const } : f)) }
  })
  const steps = fromCatalogue.filter((e) => e !== approval)
  return [...builtIn, ...steps].filter((e) => !e.requires || capabilities[e.requires] === true)
}

export function paletteEntry(id: string, catalogue: readonly CatalogueStep[] = []): PaletteEntry | undefined {
  return palette(catalogue, { batch: true, gamedays: true }).find((e) => e.id === id)
}

/**
 * The inspector fields for a node on the canvas: the kind's own (for a
 * reference, the referenced template's inputs when the catalogue knows them),
 * then the fields every task has, then retries and deadline for a local leaf.
 */
export function fieldsFor(kind: NodeKind, ref: TemplateRef | undefined, catalogue: readonly CatalogueStep[] = [], local = false): InspectorField[] {
  let own: readonly InspectorField[] = KIND_FIELDS[kind] ?? []
  if (ref) {
    const step = catalogue.find((s) => s.ref.name === ref.name && s.ref.template === ref.template && Boolean(ref.clusterScope) === Boolean(s.ref.clusterScope))
    own = step ? stepEntry(step).fields : kind === 'approval' ? BUILT_IN.find((e) => e.id === 'approval')!.fields : []
    if (step && kind === 'approval') own = palette([step]).find((e) => e.id === 'approval')!.fields
  }
  const leaf = local && ['container', 'script', 'resource', 'http'].includes(kind) ? LEAF_FIELDS : []
  return [...own, ...TASK_FIELDS, ...leaf]
}

/** What a kind is called on a card, and whether its template can be edited here. */
export const KIND_LABELS: Readonly<Record<NodeKind, string>> = {
  container: 'Container',
  script: 'Script',
  resource: 'Kubernetes resource',
  http: 'HTTP call',
  approval: 'Approval',
  timer: 'Timer',
  template: 'Template',
  'platform-step': 'Platform step',
  subflow: 'Sub-flow',
  'batch-job': 'Batch job',
  chaos: 'Chaos experiment',
  suspend: 'Manual gate',
  steps: 'Steps',
  'container-set': 'Container set',
  data: 'Data',
  plugin: 'Plugin',
  inline: 'Inline template',
  unknown: 'Unknown',
}
