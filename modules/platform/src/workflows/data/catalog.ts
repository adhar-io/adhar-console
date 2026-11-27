import { ANNOTATION, LABEL } from './gvr.ts'
import type { WfParam, WfSpec, Workflow } from './nodes.ts'
import { isFinished, msOf, runPhase } from './nodes.ts'

/**
 * The catalogue (design 0026 §6.9): WorkflowTemplates in scope, catalogue
 * ClusterWorkflowTemplates and CronWorkflows as one list of entries, each with
 * its parameter schema; and the run form's model — validation and the
 * `Workflow` a submit creates. Pure: `catalog_test.ts`.
 */

export type TemplateKind = 'WorkflowTemplate' | 'ClusterWorkflowTemplate' | 'CronWorkflow'

export interface TemplateObject {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: WfSpec & {
    /** CronWorkflow. */
    workflowSpec?: WfSpec
    schedules?: string[]
    schedule?: string
    timezone?: string
    suspend?: boolean
    concurrencyPolicy?: string
  }
  status?: {
    active?: unknown[]
    lastScheduledTime?: string
    conditions?: Array<{ type?: string; status?: string; message?: string }>
    failed?: number
    succeeded?: number
    phase?: string
  }
}

export type Home = 'App' | 'Project' | 'Platform' | 'Draft' | 'Unmanaged'

export interface ParamSpec {
  name: string
  /** The template's value (the default a run gets when the form leaves it). */
  value?: string
  enum?: string[]
  description?: string
  /** Read from a ConfigMap/Secret by the template: not settable from the form. */
  fromRef: boolean
  /** Its name reads as a secret: the form refuses a value (pass secrets as Secrets). */
  secretLike: boolean
  /** No value and no source: the run cannot start without one. */
  required: boolean
}

export interface CatalogEntry {
  key: string
  kind: TemplateKind
  name: string
  namespace?: string
  title: string
  description?: string
  home: Home
  source?: string
  params: ParamSpec[]
  tags: string[]
  team?: string
  hasApprovals: boolean
  catalogue: boolean
  specHash?: string
  schedules?: string[]
  suspended?: boolean
  object: TemplateObject
}

/**
 * Parameter names that read as credentials. §6.7's designer HINT is the loose
 * `(?i)pass|token|secret|key`, which only warns; the run form REFUSES a value,
 * so it matches whole name parts (split on `-`, `_`, `.` and camelCase) — a
 * substring match refused `keyspace`, `monkey` or `passes`, and a required
 * parameter it refuses can never be run from the console.
 */
const SECRET_PARTS = new Set(['pass', 'passwd', 'password', 'passphrase', 'pwd', 'token', 'secret', 'key', 'apikey', 'credential', 'credentials', 'creds'])

export function isSecretLike(name: string): boolean {
  const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[-_.\s]+/).filter(Boolean)
  return parts.some((p) => SECRET_PARTS.has(p))
}

export function paramSpecs(params: readonly WfParam[] | undefined): ParamSpec[] {
  return (params ?? []).filter((p) => p?.name).map((p) => {
    const fromRef = Boolean(p.valueFrom && Object.keys(p.valueFrom).length)
    const value = p.value ?? p.default
    return {
      name: p.name,
      value,
      enum: Array.isArray(p.enum) && p.enum.length ? p.enum.map(String) : undefined,
      description: p.description,
      fromRef,
      secretLike: isSecretLike(p.name),
      required: !fromRef && value === undefined,
    }
  })
}

/** The home a template lives in, from its provenance (`adhar.io/source`) and labels. */
export function homeOf(t: TemplateObject, kind: TemplateKind): Home {
  const l = t.metadata.labels ?? {}
  if (l[LABEL.draft] === 'true') return 'Draft'
  const src = t.metadata.annotations?.[ANNOTATION.source] ?? ''
  if (/deploy\/base\/workflows\//.test(src)) return 'App'
  if (/(^|[@/])automation\//.test(src)) return 'Project'
  if (kind === 'ClusterWorkflowTemplate' || t.metadata.namespace === 'adhar-system' || /application\/argo-workflows\//.test(src)) return 'Platform'
  return 'Unmanaged'
}

/** The spec a submit runs: the template's own, or a cron's `workflowSpec`. */
export function runnableSpec(t: TemplateObject, kind: TemplateKind): WfSpec {
  return (kind === 'CronWorkflow' ? t.spec?.workflowSpec : t.spec) ?? {}
}

export function entryOf(t: TemplateObject, kind: TemplateKind): CatalogEntry {
  const md = t.metadata
  const l = md.labels ?? {}
  const a = md.annotations ?? {}
  const spec = runnableSpec(t, kind)
  const tags = (l[LABEL.catalogTags] ?? '').split(/[,.]/).map((s) => s.trim()).filter(Boolean)
  return {
    key: `${kind}/${md.namespace ?? ''}/${md.name}`,
    kind,
    name: md.name,
    namespace: kind === 'ClusterWorkflowTemplate' ? undefined : md.namespace,
    title: a[ANNOTATION.title] || md.name,
    description: a[ANNOTATION.description],
    home: homeOf(t, kind),
    source: a[ANNOTATION.source],
    params: paramSpecs(spec.arguments?.parameters),
    tags,
    team: l[LABEL.team],
    hasApprovals: l[LABEL.hasApprovals] === 'true' || JSON.stringify(spec.templates ?? []).includes('"template":"approval"'),
    catalogue: Boolean(l[LABEL.catalog]),
    specHash: a[ANNOTATION.specHash],
    schedules: kind === 'CronWorkflow' ? (t.spec?.schedules ?? (t.spec?.schedule ? [t.spec.schedule] : [])) : undefined,
    suspended: kind === 'CronWorkflow' ? Boolean(t.spec?.suspend) : undefined,
    object: t,
  }
}

/**
 * A ClusterWorkflowTemplate with no `entrypoint` is a STEP LIBRARY: its
 * templates are called by `templateRef` from a workflow (the designer's
 * "Platform steps" palette, §5.7/§6.6), and submitting it on its own is a run
 * argo-server refuses. The platform's step libraries (`adhar-steps`,
 * `adhar-batch-steps`) carry `adhar.io/catalog` because the palette reads that
 * label too, so the label alone does not make a template runnable.
 */
export function isStepLibrary(t: TemplateObject): boolean {
  return !t.spec?.entrypoint
}

/**
 * The catalogue from the three lists. ClusterWorkflowTemplates appear only
 * when they are catalogue entries (`adhar.io/catalog`) that can run on their
 * own: a step library is not something a person runs (isStepLibrary).
 */
export function catalogEntries(wts: readonly TemplateObject[], cwts: readonly TemplateObject[], crons: readonly TemplateObject[]): CatalogEntry[] {
  return [
    ...wts.map((t) => entryOf(t, 'WorkflowTemplate')),
    ...cwts.filter((t) => t.metadata.labels?.[LABEL.catalog] && !isStepLibrary(t)).map((t) => entryOf(t, 'ClusterWorkflowTemplate')),
    ...crons.map((t) => entryOf(t, 'CronWorkflow')),
  ].sort((x, y) => x.title.localeCompare(y.title) || (x.namespace ?? '').localeCompare(y.namespace ?? '') || x.kind.localeCompare(y.kind))
}

/* ─────────────────────────── per-template run stats ─────────────────────────── */

export interface RunStats {
  /** Newest last: up to 10 finished outcomes. */
  outcomes: Array<'ok' | 'fail'>
  successRate?: number
  p50Ms?: number
  runs: number
}

/** Does this run belong to the entry? */
export function runOfEntry(e: CatalogEntry, w: Workflow): boolean {
  const l = w.metadata.labels ?? {}
  if (e.kind === 'CronWorkflow') return l[LABEL.cron] === e.name && w.metadata.namespace === e.namespace
  if (e.kind === 'ClusterWorkflowTemplate') return l[LABEL.clusterTemplate] === e.name || (w.spec?.workflowTemplateRef?.clusterScope === true && w.spec.workflowTemplateRef.name === e.name)
  return w.metadata.namespace === e.namespace && (l[LABEL.template] === e.name || (w.spec?.workflowTemplateRef?.name === e.name && !w.spec.workflowTemplateRef.clusterScope))
}

/** Last-10 sparkline, success rate and p50 duration over the window, from the runs given. */
export function runStats(e: CatalogEntry, runs: readonly Workflow[], now: number, windowMs = 7 * 86_400_000): RunStats {
  const mine = runs.filter((w) => runOfEntry(e, w) && isFinished(w))
    .map((w) => ({ w, end: msOf(w.status?.finishedAt) ?? msOf(w.metadata.creationTimestamp) ?? 0 }))
    .sort((a, b) => a.end - b.end)
  const outcomes = mine.slice(-10).map(({ w }) => (runPhase(w) === 'Succeeded' ? 'ok' as const : 'fail' as const))
  const recent = mine.filter((r) => now - r.end <= windowMs)
  const durations = recent
    .map(({ w }) => {
      const s = msOf(w.status?.startedAt), f = msOf(w.status?.finishedAt)
      return s !== undefined && f !== undefined ? f - s : undefined
    })
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b)
  return {
    outcomes,
    runs: recent.length,
    successRate: recent.length ? recent.filter(({ w }) => runPhase(w) === 'Succeeded').length / recent.length : undefined,
    p50Ms: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : undefined,
  }
}

/* ─────────────────────────── the run form ─────────────────────────── */

/** `adhar.io/*` label keys a person may add to a run from the form. */
export const ALLOWED_RUN_LABELS = ['adhar.io/application', 'adhar.io/environment', 'adhar.io/ticket', 'adhar.io/reason'] as const

export interface RunRequest {
  entry: CatalogEntry
  namespace: string
  /** Values the person entered; absent = the template's value. */
  values: Record<string, string>
  labels?: Record<string, string>
  priority?: number
}

const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/

/** Problems with a run request, by field (`''` for the form as a whole). Empty = submittable. */
export function validateRun(r: RunRequest): Record<string, string> {
  const errs: Record<string, string> = {}
  if (!r.namespace) errs[''] = 'Choose the namespace the run goes in.'
  if (r.entry.kind !== 'ClusterWorkflowTemplate' && r.entry.namespace && r.namespace !== r.entry.namespace) {
    errs[''] = `A ${r.entry.kind} runs in its own namespace (${r.entry.namespace}).`
  }
  for (const p of r.entry.params) {
    const v = r.values[p.name]
    const given = v !== undefined && v !== ''
    if (p.fromRef && given) errs[p.name] = 'This parameter is read from a ConfigMap or Secret by the template.'
    else if (p.secretLike && given) errs[p.name] = 'Secrets are not run parameters: put the value in a Kubernetes Secret the template reads.'
    else if (p.secretLike && p.required) errs[p.name] = 'This template asks for a secret as a parameter and gives it no default, so it cannot be run from the console: change the template to read a Kubernetes Secret.'
    else if (p.required && !given) errs[p.name] = 'Required.'
    else if (given && p.enum && !p.enum.includes(v)) errs[p.name] = `Choose one of: ${p.enum.join(', ')}.`
  }
  for (const [k, v] of Object.entries(r.labels ?? {})) {
    if (!(ALLOWED_RUN_LABELS as readonly string[]).includes(k)) errs[`label:${k}`] = `Label ${k} cannot be set from the console.`
    else if (v.length > 63 || !LABEL_VALUE.test(v)) errs[`label:${k}`] = 'Not a valid label value.'
  }
  if (r.priority !== undefined && (!Number.isInteger(r.priority) || Math.abs(r.priority) > 1_000_000)) errs.priority = 'A whole number.'
  return errs
}

/** A label-safe slice of a template's spec hash (sha-256 hex). */
export async function specHash(spec: unknown): Promise<string> {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(stable(spec))))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** The version a template is at: its published `adhar.io/spec-hash`, else a hash of its spec. */
export async function templateVersion(e: CatalogEntry): Promise<string> {
  const published = e.specHash?.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63)
  return published || await specHash(runnableSpec(e.object, e.kind))
}

/**
 * The Workflow a submit creates (§6.3): a reference to the template (never an
 * inline spec in a workload namespace — Kyverno #3), the arguments the person
 * gave, Argo's template label and the template version. It never names a
 * service account: the run executes as the namespace's `adhar-workflow`.
 */
export function buildRun(r: RunRequest, version: string | undefined): Workflow {
  const { entry } = r
  const labels: Record<string, string> = { ...(r.labels ?? {}) }
  if (version) labels[LABEL.templateSpecHash] = version
  const parameters = entry.params
    .filter((p) => r.values[p.name] !== undefined && r.values[p.name] !== '' && !p.fromRef && !p.secretLike)
    .map((p) => ({ name: p.name, value: r.values[p.name] }))
  let spec: WfSpec
  if (entry.kind === 'CronWorkflow') {
    labels[LABEL.cron] = entry.name
    // The cron's own spec, as Git admitted it (its service account included):
    // what "Run now" adds is only the arguments the person gave.
    const ws = runnableSpec(entry.object, entry.kind)
    spec = { ...ws, arguments: mergeArguments(ws.arguments, parameters) }
  } else {
    labels[entry.kind === 'ClusterWorkflowTemplate' ? LABEL.clusterTemplate : LABEL.template] = entry.name
    spec = {
      workflowTemplateRef: { name: entry.name, ...(entry.kind === 'ClusterWorkflowTemplate' ? { clusterScope: true } : {}) },
      ...(parameters.length ? { arguments: { parameters } } : {}),
    }
  }
  if (r.priority !== undefined) spec.priority = r.priority
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: { name: '', generateName: `${entry.name.slice(0, 50)}-`, namespace: r.namespace, labels },
    spec,
  }
}

function mergeArguments(base: WfSpec['arguments'], given: Array<{ name: string; value: string }>): WfSpec['arguments'] {
  const params = [...(base?.parameters ?? [])]
  for (const g of given) {
    const i = params.findIndex((p) => p.name === g.name)
    if (i >= 0) params[i] = { name: g.name, value: g.value }
    else params.push(g)
  }
  return { ...(base ?? {}), parameters: params }
}

/**
 * A resubmit made through the gateway (not memoized): a new Workflow from the
 * same template reference and arguments — or, for an inline run, the same spec
 * — labelled with the run it came from. Runtime fields (shutdown, suspend) are
 * not carried over; the spec's own service account is, because it is the one
 * the original was admitted with, not one the console chose.
 */
export function buildResubmit(w: Workflow, parameters?: Record<string, string>): Workflow {
  const l = w.metadata.labels ?? {}
  const keep = [LABEL.template, LABEL.clusterTemplate, LABEL.cron, LABEL.templateSpecHash, ...ALLOWED_RUN_LABELS] as string[]
  const labels: Record<string, string> = Object.fromEntries(Object.entries(l).filter(([k]) => keep.includes(k)))
  labels[LABEL.resubmittedFrom] = w.metadata.name
  const { shutdown: _s, suspend: _p, ...spec } = w.spec ?? {}
  if (parameters && Object.keys(parameters).length) {
    spec.arguments = mergeArguments(spec.arguments, Object.entries(parameters).map(([name, value]) => ({ name, value })))
  }
  const base = w.metadata.generateName || `${w.metadata.name.replace(/-[a-z0-9]{5}$/, '')}-`
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: { name: '', generateName: base, namespace: w.metadata.namespace, labels },
    spec,
  }
}
