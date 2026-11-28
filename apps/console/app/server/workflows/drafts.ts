import { isMap, isScalar, parse, parseAllDocuments, Scalar, type YAMLMap } from 'yaml'
import { NAME, type Parsed, parseParameters } from './model.ts'

/**
 * Draft templates for the designer's test run (design 0026 §4.5, §6.4;
 * W2-C3). Pure: no I/O.
 *
 * A draft is the one thing that reaches a cluster without going through Git,
 * so everything that makes it a draft is written HERE, on the server, whatever
 * the browser sent:
 *
 *   • its name is `<name>-draft-<user>` — it can never be the name of the
 *     GitOps copy, so a test run cannot overwrite what Argo CD manages;
 *   • its namespace is the route's (the one that was authorised);
 *   • label `adhar.io/workflow-draft: "true"` and annotation
 *     `adhar.io/draft-expires` = now + 7 days, which Kyverno #7 requires and
 *     the janitor reads (every save renews the week).
 *
 * The template travels as YAML TEXT, never as JSON made from parsed YAML: the
 * API server reads YAML 1.1, so `mode: 0644` is 420 and `enabled: yes` is
 * true there, while a YAML 1.2 parser in between would turn them into 644 and
 * a string — a test run that behaves differently from the same file applied
 * by Argo CD. So the text is edited with a schema that resolves NOTHING
 * (failsafe, plus the null tag so an empty value stays empty): every scalar
 * keeps the spelling it was typed with, and only the four fields above are
 * written.
 */

export const DRAFT_LABEL = 'adhar.io/workflow-draft'
export const DRAFT_EXPIRES_ANNOTATION = 'adhar.io/draft-expires'
export const DRAFT_TTL_MS = 7 * 86_400_000
/** The field manager the designer's server-side apply uses. */
export const DRAFT_FIELD_MANAGER = 'adhar-console-designer'
/** etcd refuses objects much above a megabyte; a template near this is a mistake. */
export const MAX_DRAFT_BYTES = 256 * 1024
const DRAFT_INFIX = '-draft-'
/** A Workflow's pods are named after it; keep the draft's name a DNS label. */
const MAX_NAME = 63

/** When a draft saved at `nowMs` expires: seven days on, RFC 3339 to the second (the designer model's `draftExpiry`). */
export function draftExpiry(nowMs: number): string {
  return new Date(nowMs + DRAFT_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** The user part of a draft's name: the API server's user name without its prefix, as a short DNS label. */
export function draftSlug(kubeUser: string): string {
  const trim = (s: string) => s.replace(/^-+|-+$/g, '')
  return trim(trim(kubeUser.replace(/^[a-z]+:/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 24)) || 'user'
}

/** `<name>-draft-<user>`; a name that already is this user's draft is kept, not doubled. */
export function draftName(name: string, slug: string): string {
  const suffix = `${DRAFT_INFIX}${slug}`
  let base = name
  const at = base.indexOf(DRAFT_INFIX)
  if (at > 0) base = base.slice(0, at)
  base = base.slice(0, MAX_NAME - suffix.length).replace(/[-.]+$/, '')
  return `${base || 'workflow'}${suffix}`
}

export interface TestRunBody {
  yaml: string
  /** `[{name, value}]` for the run's `spec.arguments.parameters`. */
  parameters: Array<{ name: string; value: string }>
  /** Admission dry-run of the draft (validation level B): nothing is saved and nothing runs. */
  dryRun: boolean
}

export function parseTestRun(body: unknown): Parsed<TestRunBody> {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  if (!b) return { ok: false, detail: 'Expected a JSON object {yaml, parameters?, dryRun?}.' }
  if (typeof b.yaml !== 'string' || !b.yaml.trim()) return { ok: false, detail: 'yaml is required: the WorkflowTemplate as YAML text.' }
  if (new TextEncoder().encode(b.yaml).length > MAX_DRAFT_BYTES) return { ok: false, detail: `The template is larger than ${MAX_DRAFT_BYTES / 1024} KiB.` }
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return { ok: false, detail: 'dryRun must be a boolean.' }
  const params = parseParameters(b.parameters)
  if (!params.ok) return params
  const parameters = (params.value ?? []).map((s) => {
    const i = s.indexOf('=')
    return { name: s.slice(0, i), value: s.slice(i + 1) }
  })
  return { ok: true, value: { yaml: b.yaml, parameters, dryRun: b.dryRun === true } }
}

export interface StampedDraft {
  /** The text to apply. */
  yaml: string
  name: string
  /** The name the author gave the template. */
  base: string
  expires: string
}

const bad = (detail: string): Parsed<StampedDraft> => ({ ok: false, detail })

const scalarText = (n: unknown): string | undefined => (isScalar(n) && typeof n.value === 'string' ? n.value : undefined)

/** A string the API server must read as a string (`"true"`, a timestamp): always double-quoted. */
function quoted(value: string): Scalar {
  const s = new Scalar(value)
  s.type = Scalar.QUOTE_DOUBLE
  return s
}

/**
 * A name the API server must read as a string. The text is written under the
 * failsafe schema, which knows no other type and so never quotes — but a
 * namespace may be any DNS label, and `1234`, `yes`, `on` or `1e3` are DNS
 * labels that YAML 1.1 reads as a number or a boolean ("metadata.namespace:
 * expected string"). Quoted only when plain would be misread, so an ordinary
 * name stays as it was.
 */
function nameScalar(value: string): Scalar {
  let plainIsString = false
  try {
    plainIsString = typeof parse(value, { version: '1.1' }) === 'string'
  } catch {
    plainIsString = false
  }
  return plainIsString ? new Scalar(value) : quoted(value)
}

/** The map under `key`, created when absent. Null when something else is there (an alias, a scalar): the author must write it out. */
function childMap(doc: { createNode(v: unknown): unknown }, parent: YAMLMap, key: string): YAMLMap | null {
  const cur = parent.get(key, true)
  if (cur === undefined || (isScalar(cur) && (cur.value === null || cur.value === ''))) {
    const m = doc.createNode({}) as YAMLMap
    m.flow = false
    parent.set(key, m)
    return m
  }
  return isMap(cur) ? cur : null
}

/**
 * Make `text` this user's draft in `namespace`. Refuses anything that is not
 * exactly one WorkflowTemplate; never repairs YAML that does not parse.
 */
export function stampDraft(text: string, opts: { namespace: string; kubeUser: string; expires: string }): Parsed<StampedDraft> {
  const docs = parseAllDocuments(text, { schema: 'failsafe', customTags: ['null'], uniqueKeys: true, logLevel: 'silent' })
  // parseAllDocuments returns an EmptyStream (an array with `empty`) for no documents.
  const real = (docs as unknown as Array<ReturnType<typeof parseAllDocuments>[number]>).filter((d) => d.contents !== null)
  if (real.length === 0) return bad('The YAML is empty.')
  if (real.length > 1) return bad('A draft is one WorkflowTemplate; this YAML holds several documents.')
  const doc = real[0]
  if (doc.errors.length) return bad(`The YAML does not parse: ${doc.errors[0].message}`)
  const root = doc.contents
  if (!isMap(root)) return bad('The YAML is not a Kubernetes object.')
  const kind = scalarText(root.get('kind', true))
  if (kind !== 'WorkflowTemplate') return bad(`A draft is a WorkflowTemplate${kind ? `, not a ${kind}` : ''}.`)
  const apiVersion = scalarText(root.get('apiVersion', true))
  if (apiVersion !== 'argoproj.io/v1alpha1') return bad('apiVersion must be argoproj.io/v1alpha1.')
  const meta = root.get('metadata', true)
  if (!isMap(meta)) return bad('metadata must be a map with a name.')
  const base = scalarText(meta.get('name', true))
  if (!base || !NAME.test(base)) return bad('metadata.name is missing or not a valid name.')
  if (meta.has('generateName')) return bad('A draft has a name, not a generateName.')
  const ns = meta.get('namespace', true)
  if (ns !== undefined && scalarText(ns) !== opts.namespace) return bad(`metadata.namespace (${scalarText(ns) ?? '?'}) is not ${opts.namespace}.`)
  const labels = childMap(doc, meta, 'labels')
  const annotations = childMap(doc, meta, 'annotations')
  if (!labels || !annotations) return bad('metadata.labels and metadata.annotations must be written out as maps (not an alias) for a draft.')

  const name = draftName(base, draftSlug(opts.kubeUser))
  meta.set('name', nameScalar(name))
  meta.set('namespace', nameScalar(opts.namespace))
  labels.set(DRAFT_LABEL, quoted('true'))
  annotations.set(DRAFT_EXPIRES_ANNOTATION, quoted(opts.expires))
  let yaml: string
  try {
    yaml = doc.toString({ lineWidth: 0, minContentWidth: 0 })
  } catch (e) {
    return bad(`The YAML cannot be written back: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { ok: true, value: { yaml, name, base, expires: opts.expires } }
}

/** The run a test run starts: the draft, by reference, with no identity of the caller's choosing. */
export function testRunManifest(namespace: string, draft: string, parameters: TestRunBody['parameters']): Record<string, unknown> {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: {
      generateName: `${draft}-`,
      namespace,
      labels: { 'workflows.argoproj.io/workflow-template': draft },
    },
    spec: {
      workflowTemplateRef: { name: draft },
      ...(parameters.length ? { arguments: { parameters: parameters.map((p) => ({ name: p.name, value: p.value })) } } : {}),
    },
  }
}
