import { parseYaml, type YamlValue } from '@adhar/utils'
import type { ScalingIntent } from '../data/catalog-scaling-model.ts'

/**
 * The GitOps half of scaling: what the console writes into an application's
 * kustomize overlay `<path>/envs/<env>/` so that a replica count or an
 * autoscaler is DECLARED, and therefore survives Argo CD's self-heal and every
 * later promotion. Pure string work, no I/O — `server/scaling.ts` reads the
 * files from Gitea and commits what this returns.
 *
 * The console owns exactly two files in the overlay and one line in its
 * kustomization:
 *
 *   scaling.yaml     strategic-merge patches — the workload's `spec.replicas`
 *                    and the HorizontalPodAutoscaler's bounds and targets (or
 *                    `$patch: delete` to remove it). Listed LAST under
 *                    `patches:`, so it wins over the template's inline
 *                    replica / minReplicas patches without editing them.
 *   autoscaler.yaml  a whole HorizontalPodAutoscaler, only when nothing the
 *                    overlay builds from has one (a template scaffolded with
 *                    `enableHpa: false`). Listed under `resources:`.
 *
 * Verified against kustomize v5 (what Kargo's `kustomize-build` step runs): a
 * multi-document SM patch file applies each document to its own target, and a
 * `$patch: delete` whose target does not exist FAILS the build — which is why
 * the delete is only written when an input actually has the autoscaler.
 */

export const PATCH_FILE = 'scaling.yaml'
export const RESOURCE_FILE = 'autoscaler.yaml'

export interface WorkloadRef {
  kind: 'Rollout' | 'Deployment'
  name: string
}

export function workloadApiVersion(kind: WorkloadRef['kind']): string {
  return kind === 'Rollout' ? 'argoproj.io/v1alpha1' : 'apps/v1'
}

/* ─────────── reading back what the console (or a person) declared ─────────── */

export interface ManagedPatch {
  replicas?: number
  /** The file removes the autoscaler. */
  hpaDeleted: boolean
  hpa?: { name: string; min?: number; max?: number; cpu?: number; memory?: number }
}

const DOC_SPLIT = /^---[ \t]*(?:#.*)?$/m

function docs(text: string): YamlValue[] {
  return text.split(DOC_SPLIT).map((d) => (d.trim() ? parseYaml(d) : null)).filter((d) => d && typeof d === 'object' && !Array.isArray(d))
}

type Obj = { [k: string]: YamlValue }
const obj = (v: YamlValue | undefined): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined)
const int = (v: YamlValue | undefined): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined)

/** What a `scaling.yaml` says about this workload. */
export function readPatchFile(text: string, workload: WorkloadRef): ManagedPatch {
  const out: ManagedPatch = { hpaDeleted: false }
  for (const d of docs(text) as Obj[]) {
    const kind = d.kind
    const name = obj(d.metadata)?.name
    if (kind === workload.kind && name === workload.name) {
      const r = int(obj(d.spec)?.replicas)
      if (r !== undefined) out.replicas = r
    } else if (kind === 'HorizontalPodAutoscaler' && typeof name === 'string') {
      if (d.$patch === 'delete') {
        out.hpaDeleted = true
        continue
      }
      const spec = obj(d.spec) ?? {}
      const hpa: NonNullable<ManagedPatch['hpa']> = { name }
      const min = int(spec.minReplicas)
      const max = int(spec.maxReplicas)
      if (min !== undefined) hpa.min = min
      if (max !== undefined) hpa.max = max
      for (const m of Array.isArray(spec.metrics) ? spec.metrics : []) {
        const res = obj(obj(m)?.resource)
        const util = int(obj(res?.target)?.averageUtilization)
        if (res?.name === 'cpu' && util !== undefined) hpa.cpu = util
        if (res?.name === 'memory' && util !== undefined) hpa.memory = util
      }
      out.hpa = hpa
    }
  }
  return out
}

/** The intent a managed patch declares, when it declares a whole one. */
export function declaredIntent(p: ManagedPatch, resourceHpa: boolean): ScalingIntent | undefined {
  if (p.hpa && !p.hpaDeleted && p.hpa.min !== undefined && p.hpa.max !== undefined) {
    return { mode: 'auto', min: p.hpa.min, max: p.hpa.max, ...(p.hpa.cpu !== undefined ? { cpu: p.hpa.cpu } : {}), ...(p.hpa.memory !== undefined ? { memory: p.hpa.memory } : {}) }
  }
  if (!resourceHpa && p.replicas !== undefined && (p.hpaDeleted || !p.hpa)) return { mode: 'fixed', replicas: p.replicas }
  return undefined
}

/**
 * The HorizontalPodAutoscaler in a manifest file that scales `workload`, by
 * name: one named for the workload, or one whose `scaleTargetRef` names it.
 * A line scan per document — manifests use flow maps (`scaleTargetRef: {…}`)
 * the YAML reader does not parse.
 */
export function findHpaName(text: string, workload: WorkloadRef): string | undefined {
  for (const d of text.split(DOC_SPLIT)) {
    if (!/^kind:[ \t]*["']?HorizontalPodAutoscaler["']?[ \t]*$/m.test(d)) continue
    const name = /^metadata:[ \t]*\n(?:(?:[ \t]+.*|[ \t]*#.*|[ \t]*)\n)*?[ \t]+name:[ \t]*["']?([^"'#\s]+)["']?/m.exec(d)?.[1]
    const target = /scaleTargetRef:[\s\S]*?\bname:[ \t]*["']?([^"',}\s]+)["']?/.exec(d)?.[1]
    if (name === workload.name || target === workload.name) return name ?? workload.name
  }
  return undefined
}

/**
 * The replica count a RENDERED manifest (`stage/<env>/manifests.yaml`, the
 * output of `kustomize build`) gives the workload. Rendered YAML is
 * normalised — two-space indents, `spec.replicas` directly under `spec:`.
 */
export function renderedReplicas(manifests: string, workload: WorkloadRef): number | undefined {
  for (const d of manifests.split(DOC_SPLIT)) {
    if (!new RegExp(`^kind:[ \\t]*${workload.kind}[ \\t]*$`, 'm').test(d)) continue
    const name = /^metadata:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]{2}name:[ \t]*["']?([^"'#\s]+)/m.exec(d)?.[1]
    if (name !== workload.name) continue
    const r = /^spec:[ \t]*\n(?:(?:[ \t]{3,}.*|[ \t]{2}(?!replicas:).*)\n)*?[ \t]{2}replicas:[ \t]*(\d+)/m.exec(d)?.[1]
    return r === undefined ? undefined : Number(r)
  }
  return undefined
}

/* ─────────── editing kustomization.yaml ─────────── */

/**
 * A top-level block (`patches:`, `resources:`) of a kustomization, as line
 * indices: the key line, and the first line after its last item. Comments
 * and blank lines sitting right before the next key belong to that key.
 */
function block(lines: readonly string[], key: string): { at: number; end: number; inline?: string } | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`)
  const at = lines.findIndex((l) => re.test(l))
  if (at < 0) return undefined
  const rest = re.exec(lines[at])![1].replace(/[ \t]+#.*$/, '').trim()
  let next = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '' || /^[ \t]/.test(l) || l.startsWith('-') || l.startsWith('#')) continue
    next = i
    break
  }
  let end = next
  while (end > at + 1 && (lines[end - 1].trim() === '' || (next < lines.length && lines[end - 1].startsWith('#')))) end--
  return { at, end, ...(rest ? { inline: rest } : {}) }
}

/** Indentation the block's items use (`  - x` → "  "); two spaces when it has none. */
function itemIndent(lines: readonly string[], b: { at: number; end: number }): string {
  for (let i = b.at + 1; i < b.end; i++) {
    const m = /^([ \t]*)-[ \t]/.exec(lines[i]) ?? /^([ \t]*)-$/.exec(lines[i])
    if (m) return m[1]
  }
  return '  '
}

function entryValue(file: string): RegExp {
  const f = file.replace(/\./g, '\\.')
  return new RegExp(`^["']?(?:\\./)?${f}["']?$`)
}

/** Line ranges of the block's items that name `file` (`- file` or `- path: file`). */
function itemsNaming(lines: readonly string[], b: { at: number; end: number }, file: string, form: 'path' | 'plain'): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const value = entryValue(file)
  const isPath = (s: string) => {
    const m = /^path:[ \t]*(.+?)[ \t]*(?:#.*)?$/.exec(s.trim())
    return Boolean(m && value.test(m[1]))
  }
  for (let i = b.at + 1; i < b.end; i++) {
    const m = /^([ \t]*)-[ \t]+(.*?)[ \t]*(?:#.*)?$/.exec(lines[i])
    if (!m) continue
    // The item runs on while lines are indented deeper than its dash.
    let j = i + 1
    while (j < b.end && (lines[j].trim() === '' || (lines[j].length - lines[j].trimStart().length) > m[1].length)) j++
    while (j > i + 1 && lines[j - 1].trim() === '') j--
    const hit = form === 'plain' ? value.test(m[2]) : isPath(m[2]) || lines.slice(i + 1, j).some(isPath)
    if (hit) out.push([i, j])
    i = j - 1
  }
  return out
}

function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return { lines, eol }
}

const join = (lines: string[], eol: string) => lines.join(eol) + eol

/**
 * `- path: scaling.yaml` as the LAST entry of `patches:` (creating the key
 * when there is none). Kustomize applies patches in order, so last is what
 * makes the console's values win over the overlay's own replica patches.
 * Idempotent: already last → the text comes back unchanged.
 */
export function ensurePatchLast(text: string, file = PATCH_FILE): string {
  const { lines, eol } = splitLines(text)
  const b = block(lines, 'patches')
  if (!b) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return join([...lines, 'patches:', `  - path: ${file}`], eol)
  }
  if (b.inline && b.inline !== '[]') throw new Error('kustomization.yaml writes `patches:` as a flow list; the console only edits block lists.')
  const indent = itemIndent(lines, b)
  const hits = itemsNaming(lines, b, file, 'path')
  // Already the last item (nothing but blank lines / comments after it).
  if (hits.length === 1 && hits[0][1] === b.end && !b.inline) return join(lines, eol)
  const out = [...lines]
  for (const [i, j] of [...hits].reverse()) out.splice(i, j - i)
  const nb = block(out, 'patches')!
  const entry = `${indent}- path: ${file}`
  if (nb.inline === '[]') out.splice(nb.at, 1, 'patches:', entry)
  else out.splice(nb.end, 0, entry)
  return join(out, eol)
}

/** Add (`present`) or remove `- <file>` under `resources:`. */
export function setResource(text: string, file: string, present: boolean): string {
  const { lines, eol } = splitLines(text)
  const b = block(lines, 'resources')
  if (!b) {
    if (!present) return text
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return join([...lines, 'resources:', `  - ${file}`], eol)
  }
  if (b.inline && b.inline !== '[]') throw new Error('kustomization.yaml writes `resources:` as a flow list; the console only edits block lists.')
  const hits = itemsNaming(lines, b, file, 'plain')
  if (present === hits.length > 0) return text
  const out = [...lines]
  if (!present) {
    for (const [i, j] of [...hits].reverse()) out.splice(i, j - i)
    return join(out, eol)
  }
  const entry = `${itemIndent(lines, b)}- ${file}`
  if (b.inline === '[]') out.splice(b.at, 1, 'resources:', entry)
  else out.splice(b.end, 0, entry)
  return join(out, eol)
}

/** `resources:` (and `components:`) entries, for finding what the overlay builds from. */
export function kustomizeInputs(text: string): { resources: string[]; components: string[]; renames: boolean; helm: boolean } {
  const k = obj(parseYaml(text) ?? undefined) ?? {}
  const list = (v: YamlValue | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    resources: list(k.resources),
    components: list(k.components),
    renames: typeof k.namePrefix === 'string' || typeof k.nameSuffix === 'string',
    helm: Array.isArray(k.helmCharts) && k.helmCharts.length > 0,
  }
}

/** `a/b` + `../c` → `a/c`; undefined when it leaves the repository or is remote. */
export function resolveRepoPath(dir: string, rel: string): string | undefined {
  if (/^[a-z]+:\/\//i.test(rel) || /^(github\.com|gitlab\.com)\//.test(rel) || rel.includes('?ref=') || rel.startsWith('/')) return undefined
  const parts = dir.split('/').filter(Boolean)
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

/* ─────────── writing the managed files ─────────── */

const HEADER = (app: string, env: string) => [
  `# Scaling of ${app} in ${env} — managed by the Adhar console`,
  '# (Catalog → service → Deployment → Scaling). Listed last under `patches:` in',
  '# kustomization.yaml, so these values win over the patches above them.',
  '# Edit here or in the console; the console reads this file back.',
]

function metricLines(intent: Extract<ScalingIntent, { mode: 'auto' }>, keep: readonly unknown[], indent: string): string[] {
  const out: string[] = [`${indent}metrics:`]
  for (const [name, util] of [['cpu', intent.cpu], ['memory', intent.memory]] as const) {
    if (util === undefined) continue
    out.push(
      `${indent}  - type: Resource`,
      `${indent}    resource:`,
      `${indent}      name: ${name}`,
      `${indent}      target:`,
      `${indent}        type: Utilization`,
      `${indent}        averageUtilization: ${util}`,
    )
  }
  // Metrics the console does not edit (pods, external, …) are kept verbatim:
  // the patch REPLACES the list, so leaving them out would delete them. JSON
  // is valid YAML flow.
  for (const m of keep) out.push(`${indent}  - ${JSON.stringify(m)}`)
  return out
}

export interface PatchInput {
  app: string
  env: string
  workload: WorkloadRef
  intent: ScalingIntent
  /** The autoscaler's name in the overlay's inputs (base or overlay), when one exists there. */
  inputHpa?: string
  /** Replica count for the workload while the autoscaler runs (its starting point). */
  replicasWhileAuto?: number
  /** Live metrics the console does not edit, to carry over. */
  keepMetrics?: readonly unknown[]
}

/** `scaling.yaml` for an intent. */
export function renderPatchFile(p: PatchInput): string {
  const { workload, intent } = p
  const lines = [
    ...HEADER(p.app, p.env),
    `apiVersion: ${workloadApiVersion(workload.kind)}`,
    `kind: ${workload.kind}`,
    'metadata:',
    `  name: ${workload.name}`,
    'spec:',
    `  replicas: ${intent.mode === 'fixed' ? intent.replicas : Math.min(intent.max, Math.max(intent.min, p.replicasWhileAuto ?? intent.min))}`,
  ]
  const hpaName = p.inputHpa ?? workload.name
  if (intent.mode === 'fixed') {
    if (p.inputHpa) {
      lines.push('---', '# Autoscaling is off: remove the autoscaler the base defines.', 'apiVersion: autoscaling/v2', 'kind: HorizontalPodAutoscaler', 'metadata:', `  name: ${hpaName}`, '$patch: delete')
    }
  } else {
    lines.push(
      '---',
      'apiVersion: autoscaling/v2',
      'kind: HorizontalPodAutoscaler',
      'metadata:',
      `  name: ${hpaName}`,
      'spec:',
      `  minReplicas: ${intent.min}`,
      `  maxReplicas: ${intent.max}`,
      ...metricLines(intent, p.keepMetrics ?? [], '  '),
    )
  }
  return lines.join('\n') + '\n'
}

/** `autoscaler.yaml` — a whole autoscaler, for an overlay whose inputs have none. */
export function renderResourceFile(p: PatchInput): string {
  if (p.intent.mode !== 'auto') throw new Error('autoscaler.yaml is only written with autoscaling on')
  return [
    `# Autoscaler of ${p.app} in ${p.env} — added by the Adhar console because nothing`,
    '# else in this overlay defines one. Its bounds and targets live in scaling.yaml.',
    'apiVersion: autoscaling/v2',
    'kind: HorizontalPodAutoscaler',
    'metadata:',
    `  name: ${p.workload.name}`,
    '  labels:',
    `    app: ${p.workload.name}`,
    'spec:',
    '  scaleTargetRef:',
    `    apiVersion: ${workloadApiVersion(p.workload.kind)}`,
    `    kind: ${p.workload.kind}`,
    `    name: ${p.workload.name}`,
    `  minReplicas: ${p.intent.min}`,
    `  maxReplicas: ${p.intent.max}`,
    ...metricLines(p.intent, p.keepMetrics ?? [], '  '),
  ].join('\n') + '\n'
}

/* ─────────── the change, as files ─────────── */

export interface OverlayFiles {
  /** `<path>/envs/<env>` — no trailing slash. */
  dir: string
  kustomization: { path: string; text: string; sha: string }
  patch?: { text: string; sha: string }
  resource?: { text: string; sha: string }
}

export interface PlannedFile {
  path: string
  /** null = the file does not exist yet. */
  before: string | null
  /** null = delete it. */
  after: string | null
  sha: string | null
}

/**
 * Every file the change touches, before and after. `inputHpa` is the
 * autoscaler the overlay's inputs define (excluding the console's own
 * `autoscaler.yaml`) — it decides between patching it and adding one.
 */
export function planFiles(o: OverlayFiles, p: PatchInput): PlannedFile[] {
  const patchPath = `${o.dir}/${PATCH_FILE}`
  const resourcePath = `${o.dir}/${RESOURCE_FILE}`
  const needResource = p.intent.mode === 'auto' && !p.inputHpa
  let kz = ensurePatchLast(o.kustomization.text)
  kz = setResource(kz, RESOURCE_FILE, needResource)
  const files: PlannedFile[] = []
  if (kz !== o.kustomization.text) files.push({ path: o.kustomization.path, before: o.kustomization.text, after: kz, sha: o.kustomization.sha })
  const patch = renderPatchFile(p)
  if (patch !== o.patch?.text) files.push({ path: patchPath, before: o.patch?.text ?? null, after: patch, sha: o.patch?.sha ?? null })
  if (needResource) {
    const res = renderResourceFile(p)
    if (res !== o.resource?.text) files.push({ path: resourcePath, before: o.resource?.text ?? null, after: res, sha: o.resource?.sha ?? null })
  } else if (o.resource) {
    files.push({ path: resourcePath, before: o.resource.text, after: null, sha: o.resource.sha })
  }
  return files
}

/** A stable fingerprint of what a plan was built on, so "apply" lands only over what the preview showed. */
export async function planFingerprint(o: OverlayFiles): Promise<string> {
  const raw = [o.kustomization.sha, o.patch?.sha ?? '-', o.resource?.sha ?? '-'].join(':')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}
