import type { YamlValue } from '@adhar/utils'
import type { Entity, Lifecycle, Link } from './catalog.ts'
import type { Check, PlatformSignal, Scorecard } from './scorecard.ts'
import { toYaml } from './k8s-yaml.ts'
import { catalogInfoPath, descriptorDoc, descriptorDocIndex, overlayDescriptor } from './catalog-descriptor.ts'
import {
  addContainerResources,
  appendSeqItem,
  asArray,
  asRecord,
  getPath,
  joinDocs,
  parseDocs,
  removeKey,
  type ResourceSpec,
  setScalar,
  splitDocs,
} from './scorecard-yaml-edit.ts'

// Moved to the catalog data layer (catalog-descriptor.ts); re-exported for existing importers.
export { catalogInfoPath, descriptorDoc, descriptorDocIndex, overlayDescriptor }

/**
 * Scorecard fixes — what "Fix" does for each failing check, and the pure parts
 * of doing it (descriptor edits, Kustomize patches, score deltas).
 *
 * Three kinds of fix, each acting on the check's real source of truth:
 *
 *   • metadata  — owner / description / lifecycle / links. Written to the
 *                 entity's `catalog-info.yaml` in Gitea (as a PR by default),
 *                 or to the console's registered-entity store for entities a
 *                 user registered by hand. A live-only entity (a workload with
 *                 no descriptor anywhere) gets the annotation to set instead of
 *                 a button that cannot work.
 *   • manifest  — resource requests/limits, an HPA, a PDB. Generated into the
 *                 application's deploy manifests (the Kustomize base its Argo CD
 *                 applications render) and opened as a PR.
 *   • link      — everything that is fixed by doing something elsewhere (set up
 *                 a build, scan an image, define alerts): a deep link to the page
 *                 that does it, with one line saying what to do there.
 *
 * Honesty: nothing here marks a check as passing. A committed or merged fix is
 * "pending" until the evaluator (the catalog derivation, or the platform
 * scorer) grades the service again and says so.
 *
 * JSX-free and I/O-free so the Deno test runner covers it.
 */

/* ─────────── fix actions ─────────── */

export type MetadataField = 'owner' | 'description' | 'lifecycle' | 'docs' | 'repo' | 'runbook' | 'dashboard'
export type ManifestTarget = 'resources' | 'hpa' | 'pdb'

/** Where an entity's catalog metadata is actually stored. */
export type EntitySource = 'gitea' | 'registered' | 'live'

export type FixAction =
  | { kind: 'metadata'; field: MetadataField; source: EntitySource; explain?: string }
  | { kind: 'manifest'; target: ManifestTarget }
  | { kind: 'link'; href: string; label: string; explain: string }
  | { kind: 'explain'; explain: string }

/** Annotation a workload can carry for each metadata field (live-only entities). */
export const FIELD_ANNOTATION: Record<MetadataField, string> = {
  owner: 'adhar.io/owner',
  description: 'adhar.io/description',
  lifecycle: 'adhar.io/lifecycle',
  docs: 'adhar.io/docs',
  repo: 'adhar.io/source-repo',
  runbook: 'adhar.io/runbook',
  dashboard: 'adhar.io/dashboard',
}

export const FIELD_LABEL: Record<MetadataField, string> = {
  owner: 'Owner',
  description: 'Description',
  lifecycle: 'Lifecycle',
  docs: 'Documentation link',
  repo: 'Source repository link',
  runbook: 'Runbook link',
  dashboard: 'Dashboard link',
}

export const MANIFEST_LABEL: Record<ManifestTarget, string> = {
  resources: 'CPU/memory requests and limits',
  hpa: 'HorizontalPodAutoscaler',
  pdb: 'PodDisruptionBudget',
}

const METADATA_CHECKS: Record<string, MetadataField> = {
  'has-owner': 'owner',
  'has-description': 'description',
  'has-docs': 'docs',
  'has-repo': 'repo',
  'lifecycle-production': 'lifecycle',
  'has-runbook': 'runbook',
  'has-dashboard': 'dashboard',
}

const MANIFEST_CHECKS: Record<string, ManifestTarget> = {
  'resource-limits': 'resources',
  'has-hpa': 'hpa',
  'has-pdb': 'pdb',
}

/** Which link icon a link field writes. */
export const FIELD_LINK_ICON: Partial<Record<MetadataField, NonNullable<Link['icon']>>> = {
  docs: 'docs',
  repo: 'repo',
  runbook: 'runbook',
  dashboard: 'dashboard',
}

export function catalogDeployHref(entityRef: string): string {
  return `/catalog?entity=${encodeURIComponent(entityRef)}&tab=deploy`
}

/**
 * The fix for one catalog-derived check. `source` is where the entity's
 * metadata lives (see `entitySource`); manifest fixes need a workload.
 */
export function fixForCheck(check: Pick<Check, 'id' | 'pass'>, entityRef: string, source: EntitySource): FixAction | null {
  if (check.pass) return null
  const field = METADATA_CHECKS[check.id]
  if (field) {
    if (source === 'live') {
      return {
        kind: 'explain',
        explain:
          `This entity comes from a running workload with no catalog-info.yaml the console can edit. Set the ` +
          `${FIELD_ANNOTATION[field]} annotation on the workload's manifest (metadata.annotations), or register ` +
          `the entity in the catalog, and it is picked up on the next refresh.`,
      }
    }
    return { kind: 'metadata', field, source }
  }
  const target = MANIFEST_CHECKS[check.id]
  if (target) return { kind: 'manifest', target }
  switch (check.id) {
    case 'has-ci':
      return {
        kind: 'link',
        href: '/develop?section=builds',
        label: 'Open Builds',
        explain: 'Set up a build for the repository; once it runs in CI, stamp the workload with adhar.io/ci-pipeline.',
      }
    case 'gitops-deployed':
      return {
        kind: 'link',
        href: catalogDeployHref(entityRef),
        label: 'Open Deployment',
        explain: 'Deploy it through Argo CD — the argocd/app-name annotation on the workload surfaces here.',
      }
    case 'image-scanned':
      return {
        kind: 'link',
        href: '/deliver?section=scans',
        label: 'Open Vulnerability Scans',
        explain: 'Scan its image in the registry, then stamp the workload with adhar.io/image-scanned=true.',
      }
    case 'has-alerts':
      return {
        kind: 'link',
        href: '/discover?section=alerts',
        label: 'Open Alerts',
        explain: 'Define alert rules (or an SLO) for it, then surface them with adhar.io/alerts or adhar.io/slo.',
      }
    default:
      return null
  }
}

/** The fix for one of the platform scorer's failing signals (by signal name). */
export function fixForSignal(
  sig: Pick<PlatformSignal, 'name' | 'applicable' | 'score'>,
  service: string,
  entityRef: string,
): FixAction | null {
  if (!sig.applicable || sig.score >= 1) return null
  switch (sig.name) {
    case 'resources':
      return { kind: 'manifest', target: 'resources' }
    case 'autoscaling':
    case 'replicas_ha':
      return { kind: 'manifest', target: 'hpa' }
    case 'pod_disruption_budget':
      return { kind: 'manifest', target: 'pdb' }
    case 'argocd_healthy':
    case 'argocd_synced':
    case 'httproute_exposed':
    case 'probes':
    case 'graceful_shutdown':
    case 'restart_stability':
      return {
        kind: 'link',
        href: catalogDeployHref(entityRef),
        label: 'Open Deployment',
        explain:
          sig.name === 'probes'
            ? 'Add a readinessProbe and livenessProbe to every container in its Deployment manifest.'
            : sig.name === 'httproute_exposed'
            ? 'Expose it through an HTTPRoute in its deploy manifests.'
            : 'See what Argo CD reports for its environments and fix the manifests it renders.',
      }
    case 'image_not_latest':
      return {
        kind: 'link',
        href: '/deliver?section=stages',
        label: 'Open Kargo Stages',
        explain: 'Promote a released image (a tag or digest) instead of the :latest placeholder.',
      }
    case 'kyverno_pass_rate':
      return {
        kind: 'link',
        href: '/deliver?section=policy',
        label: 'Open Policy',
        explain: 'Resolve the failing Kyverno policy-report results for its workloads.',
      }
    case 'load_test':
    case 'latency_slo':
    case 'perf_center_gate':
      return {
        kind: 'link',
        href: `/deliver?section=performance&view=readiness&app=${encodeURIComponent(service)}`,
        label: 'Open Performance Center',
        explain: 'Look at the load-test and latency evidence and fix what misses its target.',
      }
    case 'error_budget':
      return {
        kind: 'link',
        href: '/discover?section=slos',
        label: 'Open SLOs',
        explain: 'Bring the live 5xx ratio back inside its availability SLO.',
      }
    case 'chaos_pod_delete':
    case 'chaos_network_latency':
    case 'chaos_cpu_stress':
    case 'chaos_gameday':
    case 'recovery_time':
      return {
        kind: 'link',
        href: '/deliver?section=chaos',
        label: 'Open Chaos Engineering',
        explain: 'Re-run the failing experiment and fix what it shows (replicas, probes, graceful shutdown).',
      }
    default:
      return null
  }
}

/* ─────────── where an entity's metadata lives ─────────── */

/** `registered` beats everything: that store is where the entity's data comes from. */
export function entitySource(entity: Entity, hasGiteaRepo: boolean): EntitySource {
  if (entity.origin === 'registered') return 'registered'
  if (hasGiteaRepo) return 'gitea'
  return 'live'
}

/* ─────────── catalog-info.yaml edits ─────────── */

export interface MetadataPatch {
  owner?: string
  description?: string
  lifecycle?: Lifecycle
  links?: Array<{ url: string; title: string; icon: NonNullable<Link['icon']> }>
  /** `metadata.annotations` entries to set (the stamps a manifest fix declares). */
  annotations?: Record<string, string>
}

export interface DescriptorEdit {
  content: string
  /** True when the file did not exist and was written from scratch. */
  created: boolean
  /** True when a line edit was not possible and the document was re-serialised (comments lost). */
  reserialised: boolean
}

/** `group:payments` → `payments` (descriptors conventionally use the bare name). */
export function ownerValue(owner: string): string {
  const t = owner.trim()
  return t.startsWith('group:') ? t.slice('group:'.length) : t
}

function patchSatisfied(doc: Record<string, YamlValue> | undefined, patch: MetadataPatch): boolean {
  if (!doc) return false
  if (patch.owner !== undefined && String(getPath(doc, ['spec', 'owner']) ?? '') !== ownerValue(patch.owner)) return false
  if (patch.description !== undefined && String(getPath(doc, ['metadata', 'description']) ?? '') !== patch.description) return false
  if (patch.lifecycle !== undefined && String(getPath(doc, ['spec', 'lifecycle']) ?? '') !== patch.lifecycle) return false
  for (const l of patch.links ?? []) {
    const links = asArray(getPath(doc, ['metadata', 'links']))
    if (!links.some((x) => asRecord(x)?.url === l.url && asRecord(x)?.icon === l.icon)) return false
  }
  for (const [k, v] of Object.entries(patch.annotations ?? {})) {
    if (String(asRecord(getPath(doc, ['metadata', 'annotations']))?.[k] ?? '') !== v) return false
  }
  return true
}

function patchObject(doc: Record<string, YamlValue>, patch: MetadataPatch): Record<string, YamlValue> {
  const meta = { ...(asRecord(doc.metadata) ?? {}) }
  const spec = { ...(asRecord(doc.spec) ?? {}) }
  if (patch.description !== undefined) meta.description = patch.description
  if (patch.links?.length) meta.links = [...asArray(meta.links), ...patch.links.map((l) => ({ ...l }))]
  if (patch.annotations && Object.keys(patch.annotations).length) {
    meta.annotations = { ...(asRecord(meta.annotations) ?? {}), ...patch.annotations }
  }
  if (patch.owner !== undefined) spec.owner = ownerValue(patch.owner)
  if (patch.lifecycle !== undefined) spec.lifecycle = patch.lifecycle
  return { ...doc, metadata: meta, spec }
}

/** A brand-new descriptor for an entity whose repository has none. */
export function newDescriptor(entity: Entity, patch: MetadataPatch): string {
  const base: Record<string, YamlValue> = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: entity.kind,
    metadata: {
      name: entity.metadata.name,
      ...(entity.metadata.title && entity.metadata.title !== entity.metadata.name ? { title: entity.metadata.title } : {}),
    },
    spec: {
      ...(entity.spec.type ? { type: entity.spec.type } : {}),
      lifecycle: entity.spec.lifecycle ?? 'experimental',
      ...(entity.spec.owner ? { owner: ownerValue(entity.spec.owner) } : {}),
    },
  }
  return toYaml(patchObject(base, patch))
}

/**
 * Apply a metadata patch to a descriptor, line by line where possible.
 * `text === null` means the file does not exist: a new one is written.
 * Throws when the existing file cannot be read as YAML at all — committing a
 * guess over somebody's file is worse than saying so.
 */
export function editDescriptor(text: string | null, entity: Entity, patch: MetadataPatch): DescriptorEdit {
  if (text === null || !text.trim()) return { content: newDescriptor(entity, patch), created: true, reserialised: false }
  const stream = splitDocs(text)
  const idx = descriptorDocIndex(text, entity)
  let doc: string | null = stream.docs[idx]
  if (patch.description !== undefined && doc !== null) doc = setScalar(doc, ['metadata', 'description'], patch.description)
  if (patch.owner !== undefined && doc !== null) doc = setScalar(doc, ['spec', 'owner'], ownerValue(patch.owner))
  if (patch.lifecycle !== undefined && doc !== null) doc = setScalar(doc, ['spec', 'lifecycle'], patch.lifecycle)
  for (const l of patch.links ?? []) {
    if (doc === null) break
    doc = appendSeqItem(doc, ['metadata', 'links'], { url: l.url, title: l.title, icon: l.icon })
  }
  for (const [k, v] of Object.entries(patch.annotations ?? {})) {
    if (doc === null) break
    doc = setScalar(doc, ['metadata', 'annotations', k], v)
  }
  if (doc !== null) {
    const next = joinDocs({ ...stream, docs: stream.docs.map((d, i) => (i === idx ? doc! : d)) })
    if (patchSatisfied(descriptorDoc(next, entity), patch)) return { content: next, created: false, reserialised: false }
  }
  // Fallback: a clean re-serialisation of THIS document (comments in it are
  // lost; other documents in the stream are untouched). The UI says so.
  const parsed = descriptorDoc(text, entity)
  if (!parsed) throw new Error('catalog-info.yaml could not be parsed — fix it by hand first.')
  const rewritten = toYaml(patchObject(parsed, patch)).replace(/\n$/, '')
  const next = joinDocs({ ...stream, docs: stream.docs.map((d, i) => (i === idx ? rewritten : d)) })
  return { content: next.endsWith('\n') ? next : `${next}\n`, created: false, reserialised: true }
}

/** The same patch applied to a registered entity (the console's own store). */
export function patchEntity(entity: Entity, patch: MetadataPatch): Entity {
  const links = [...(entity.metadata.links ?? []), ...(patch.links ?? [])]
  return {
    ...entity,
    metadata: {
      ...entity.metadata,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.links?.length ? { links } : {}),
    },
    spec: {
      ...entity.spec,
      ...(patch.owner !== undefined ? { owner: patch.owner.includes(':') ? patch.owner : `group:${patch.owner}` } : {}),
      ...(patch.lifecycle !== undefined ? { lifecycle: patch.lifecycle } : {}),
    },
  }
}

/* ─────────── Kustomize: deploy location ─────────── */

export interface DeploySource {
  org: string
  repo: string
  /** Path inside the repo Argo CD renders (an overlay, usually). */
  path: string
  /** Environment it serves, when the app says. */
  env?: string
  ref?: string
}

/** `http://gitea-http.adhar-system.svc:3000/acme/cart.git` → `{ org: 'acme', repo: 'cart' }`. */
export function repoFromUrl(url: string): { org: string; repo: string } | null {
  const m = /^(?:[a-z+]+:\/\/[^/]+|[^@]+@[^:]+:)\/?(.+)$/i.exec(url.trim())
  const parts = (m ? m[1] : url).replace(/\.git$/, '').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { org: parts[parts.length - 2], repo: parts[parts.length - 1] }
}

interface ArgoAppLike {
  metadata: { name: string; labels?: Record<string, string> }
  spec: { source?: { repoURL?: string; path?: string; targetRevision?: string }; sources?: Array<{ repoURL?: string; path?: string; targetRevision?: string }> }
}

const PROD = ['prod', 'production', 'live']

/**
 * Where an application's manifests live, from its Argo CD applications (one
 * per environment, labelled `adhar.io/application`) and its Application XR's
 * `spec.parameters.source`. Production first: it is what the scorer grades.
 */
export function deploySourcesFor(
  name: string,
  argoApps: readonly ArgoAppLike[],
  xr?: { spec?: { parameters?: Record<string, unknown> } },
  argoAppName?: string,
): DeploySource[] {
  const out: DeploySource[] = []
  const lower = name.toLowerCase()
  for (const a of argoApps) {
    const label = (a.metadata.labels?.['adhar.io/application'] ?? '').toLowerCase()
    const mine = label === lower || a.metadata.name.toLowerCase() === lower ||
      (argoAppName && a.metadata.name === argoAppName)
    if (!mine) continue
    const srcs = [a.spec.source, ...(a.spec.sources ?? [])].filter((s): s is NonNullable<typeof s> => !!s?.repoURL && !!s.path)
    for (const s of srcs) {
      const r = repoFromUrl(s.repoURL!)
      if (!r) continue
      const env = a.metadata.labels?.['adhar.io/environment']
      out.push({ ...r, path: s.path!.replace(/^\.?\/+|\/+$/g, ''), ...(env ? { env } : {}), ...(s.targetRevision && s.targetRevision !== 'HEAD' ? { ref: s.targetRevision } : {}) })
    }
  }
  const src = (xr?.spec?.parameters?.source ?? {}) as Record<string, unknown>
  if (typeof src.repoURL === 'string' && typeof src.path === 'string' && src.path) {
    const r = repoFromUrl(src.repoURL)
    if (r) out.push({ ...r, path: src.path.replace(/^\.?\/+|\/+$/g, '') })
  }
  const seen = new Set<string>()
  return out
    .sort((a, b) => Number(PROD.includes((b.env ?? '').toLowerCase())) - Number(PROD.includes((a.env ?? '').toLowerCase())))
    .filter((s) => {
      const k = `${s.org}/${s.repo}/${s.path}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
}

/** Join a directory and a relative path, resolving `.` and `..`. Null when it escapes the repo. */
export function resolveRel(dir: string, rel: string): string | null {
  const parts = dir.split('/').filter(Boolean)
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

export const KUSTOMIZATION_FILES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization']

/** Local entries of a kustomization's `resources` (+ legacy `bases`); remote URLs dropped. */
export function kustomizationResources(text: string): string[] {
  const doc = parseDocs(text)[0]?.value
  const r = asRecord(doc)
  return [...asArray(r?.resources), ...asArray(r?.bases)]
    .map((x) => String(x ?? '').trim())
    .filter((x) => x && !/^[a-z]+:\/\//i.test(x) && !x.startsWith('git@') && !x.includes('?ref='))
}

export interface WorkloadDoc {
  docIndex: number
  kind: 'Deployment' | 'StatefulSet'
  name: string
  namespace?: string
  matchLabels: Record<string, string>
  replicas?: number
  containers: Array<{ name: string; hasRequests: boolean; hasLimits: boolean }>
}

/** The Deployment/StatefulSet in a manifest stream for `name` (or the only one). */
export function findWorkload(text: string, name: string): WorkloadDoc | null {
  const found: WorkloadDoc[] = []
  for (const { index, value } of parseDocs(text)) {
    const r = asRecord(value)
    const kind = String(r?.kind ?? '')
    if (kind !== 'Deployment' && kind !== 'StatefulSet') continue
    const labels: Record<string, string> = {}
    for (const [k, v] of Object.entries(asRecord(getPath(r, ['spec', 'selector', 'matchLabels'])) ?? {})) labels[k] = String(v)
    const replicas = getPath(r, ['spec', 'replicas'])
    found.push({
      docIndex: index,
      kind,
      name: String(getPath(r, ['metadata', 'name']) ?? ''),
      ...(typeof getPath(r, ['metadata', 'namespace']) === 'string' ? { namespace: String(getPath(r, ['metadata', 'namespace'])) } : {}),
      matchLabels: labels,
      ...(typeof replicas === 'number' ? { replicas } : {}),
      containers: asArray(getPath(r, ['spec', 'template', 'spec', 'containers'])).map((c, i) => {
        const res = asRecord(asRecord(c)?.resources)
        // Both CPU and memory: that is what the platform scorer's `resources`
        // signal asks for, so a request for one of them is still a gap.
        const both = (v: YamlValue | undefined) => {
          const r = asRecord(v)
          return !!r && r.cpu !== undefined && r.cpu !== null && r.memory !== undefined && r.memory !== null
        }
        return {
          name: String(asRecord(c)?.name ?? `container-${i + 1}`),
          hasRequests: both(res?.requests),
          hasLimits: both(res?.limits),
        }
      }),
    })
  }
  const lower = name.toLowerCase()
  return found.find((w) => w.name.toLowerCase() === lower) ?? (found.length === 1 ? found[0] : null)
}

/** Does any document in the stream declare `kind` targeting `workload`? */
export function declaresKind(text: string, kind: string, workload: string): boolean {
  return parseDocs(text).some(({ value }) => {
    const r = asRecord(value)
    if (String(r?.kind ?? '') !== kind) return false
    const target = String(getPath(r, ['spec', 'scaleTargetRef', 'name']) ?? '')
    return kind !== 'HorizontalPodAutoscaler' || !target || target === workload
  })
}

/* ─────────── Kustomize: patch generation ─────────── */

export interface ManifestParams {
  resources: ResourceSpec
  hpa: { minReplicas: number; maxReplicas: number; cpuUtilization: number }
  pdb: { minAvailable: number }
}

export const DEFAULT_PARAMS: ManifestParams = {
  resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
  hpa: { minReplicas: 2, maxReplicas: 5, cpuUtilization: 70 },
  pdb: { minAvailable: 1 },
}

/** A file in the base directory as read from the repo. */
export interface RepoFile {
  path: string
  text: string
  sha: string
}

export interface ManifestBase {
  /** Directory holding the workload (the Kustomize base, or a plain dir). */
  dir: string
  kustomization?: RepoFile
  workloadFile: RepoFile
  workload: WorkloadDoc
  /** Every other manifest in the base, to detect an HPA/PDB that already exists. */
  others: RepoFile[]
}

export interface FileChange {
  path: string
  /** Null when the file is new. */
  before: string | null
  after: string
  /** Blob sha the change was computed from (null = must not exist yet). */
  baseSha: string | null
}

export interface ManifestPlan {
  changes: FileChange[]
  notes: string[]
  /** Targets that needed nothing (already declared) or could not be generated. */
  skipped: Array<{ target: ManifestTarget; reason: string; exists: boolean }>
  /**
   * The annotations that declare what the manifests now carry
   * (`adhar.io/resource-limits`, `adhar.io/hpa`, `adhar.io/pdb`) — the signals
   * the catalog-derived checks read. Written onto the workload, and by the
   * caller onto the entity's catalog-info.yaml, so a merged fix can be seen.
   */
  stamps: Record<string, string>
}

/** The annotation each manifest check reads (scorecard.ts CHECK_DEFS). */
export const MANIFEST_STAMP: Record<ManifestTarget, string> = {
  resources: 'adhar.io/resource-limits',
  hpa: 'adhar.io/hpa',
  pdb: 'adhar.io/pdb',
}

function uniqueName(dirFiles: Set<string>, dir: string, file: string): string {
  const [stem, ext] = [file.replace(/\.ya?ml$/, ''), file.match(/\.ya?ml$/)?.[0] ?? '.yaml']
  let candidate = file
  for (let n = 2; dirFiles.has(dir ? `${dir}/${candidate}` : candidate); n++) candidate = `${stem}-${n}${ext}`
  return candidate
}

/**
 * The file changes that add `targets` to the application's base manifests.
 *
 *   resources → requests/limits filled into every container of the base
 *               workload (containers that already declare them keep theirs).
 *   hpa       → `hpa.yaml` (autoscaling/v2, CPU utilisation) in the base, listed
 *               in its kustomization; a hard-coded `spec.replicas` is removed
 *               from the workload so Argo CD and the HPA stop fighting.
 *   pdb       → `pdb.yaml` (policy/v1, minAvailable) selecting the workload's
 *               own pod labels.
 */
export function planManifestFix(base: ManifestBase, targets: ManifestTarget[], params: ManifestParams = DEFAULT_PARAMS): ManifestPlan {
  const notes: string[] = []
  const skipped: ManifestPlan['skipped'] = []
  const w = base.workload
  let workloadText = base.workloadFile.text
  let kustomText = base.kustomization?.text
  const added: FileChange[] = []
  const existing = new Set([base.workloadFile.path, ...base.others.map((f) => f.path), ...(base.kustomization ? [base.kustomization.path] : [])])
  const all = [base.workloadFile, ...base.others]
  const join = (f: string) => (base.dir ? `${base.dir}/${f}` : f)

  const editWorkloadDoc = (fn: (doc: string) => string | null): boolean => {
    const stream = splitDocs(workloadText)
    const next = fn(stream.docs[w.docIndex])
    if (next === null) return false
    workloadText = joinDocs({ ...stream, docs: stream.docs.map((d, i) => (i === w.docIndex ? next : d)) })
    return true
  }

  const addToKustomization = (file: string) => {
    if (kustomText === undefined) return
    if (kustomizationResources(kustomText).includes(file)) return
    const stream = splitDocs(kustomText)
    const next = appendSeqItem(stream.docs[0], ['resources'], file)
    if (next === null) {
      notes.push(`Add ${file} to ${base.kustomization!.path} resources by hand — its resources list is not in block style.`)
      return
    }
    kustomText = joinDocs({ ...stream, docs: stream.docs.map((d, i) => (i === 0 ? next : d)) })
  }

  if (targets.includes('resources')) {
    if (w.containers.every((c) => c.hasRequests && c.hasLimits)) {
      skipped.push({ target: 'resources', exists: true, reason: `Every container in ${base.workloadFile.path} already declares requests and limits.` })
    } else {
      let changed: string[] = []
      const ok = editWorkloadDoc((doc) => {
        const r = addContainerResources(doc, params.resources)
        if (!r) return null
        changed = r.changed
        return r.text
      })
      const verified = ok && (() => {
        const after = findWorkload(workloadText, w.name)
        return !!after && after.containers.every((c) => c.hasRequests && c.hasLimits)
      })()
      if (!verified) {
        workloadText = base.workloadFile.text
        skipped.push({
          target: 'resources',
          exists: false,
          reason: `The containers in ${base.workloadFile.path} are not in a shape the console can edit safely — add resources.requests and resources.limits by hand.`,
        })
      } else if (changed.length) {
        notes.push(`Requests/limits added to ${changed.join(', ')} in ${base.workloadFile.path}.`)
      }
    }
  }

  if (targets.includes('hpa')) {
    if (all.some((f) => declaresKind(f.text, 'HorizontalPodAutoscaler', w.name))) {
      skipped.push({ target: 'hpa', exists: true, reason: 'The base already declares a HorizontalPodAutoscaler for this workload.' })
    } else {
      const file = uniqueName(existing, base.dir, 'hpa.yaml')
      const hpa = {
        apiVersion: 'autoscaling/v2',
        kind: 'HorizontalPodAutoscaler',
        metadata: { name: w.name, ...(w.namespace ? { namespace: w.namespace } : {}) },
        spec: {
          scaleTargetRef: { apiVersion: 'apps/v1', kind: w.kind, name: w.name },
          minReplicas: params.hpa.minReplicas,
          maxReplicas: params.hpa.maxReplicas,
          metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: params.hpa.cpuUtilization } } }],
        },
      }
      added.push({ path: join(file), before: null, after: toYaml(hpa), baseSha: null })
      existing.add(join(file))
      addToKustomization(file)
      if (typeof w.replicas === 'number') {
        if (editWorkloadDoc((doc) => removeKey(doc, ['spec', 'replicas']))) {
          notes.push(`spec.replicas (${w.replicas}) removed from ${base.workloadFile.path} so the HPA owns the replica count.`)
        }
      }
      const cpuRequests = targets.includes('resources') || w.containers.every((c) => c.hasRequests)
      if (!cpuRequests) notes.push('A CPU-utilisation HPA needs CPU requests on every container — include the requests/limits fix.')
    }
  }

  if (targets.includes('pdb')) {
    if (all.some((f) => declaresKind(f.text, 'PodDisruptionBudget', w.name))) {
      skipped.push({ target: 'pdb', exists: true, reason: 'The base already declares a PodDisruptionBudget.' })
    } else if (!Object.keys(w.matchLabels).length) {
      skipped.push({ target: 'pdb', exists: false, reason: `${w.kind} ${w.name} has no spec.selector.matchLabels to select its pods with.` })
    } else {
      const file = uniqueName(existing, base.dir, 'pdb.yaml')
      const pdb = {
        apiVersion: 'policy/v1',
        kind: 'PodDisruptionBudget',
        metadata: { name: w.name, ...(w.namespace ? { namespace: w.namespace } : {}) },
        spec: { minAvailable: params.pdb.minAvailable, selector: { matchLabels: w.matchLabels } },
      }
      added.push({ path: join(file), before: null, after: toYaml(pdb), baseSha: null })
      existing.add(join(file))
      addToKustomization(file)
      const minReplicas = targets.includes('hpa') ? params.hpa.minReplicas : w.replicas ?? 1
      if (minReplicas <= params.pdb.minAvailable) {
        notes.push(`With ${minReplicas} replica(s), minAvailable ${params.pdb.minAvailable} blocks node drains — pair it with an HPA (min 2).`)
      }
    }
  }

  // Declare what the manifests now carry, for the catalog-derived checks.
  const stamps: Record<string, string> = {}
  for (const t of targets) {
    const skip = skipped.find((x) => x.target === t)
    if (skip && !skip.exists) continue
    stamps[MANIFEST_STAMP[t]] = t === 'resources' ? 'true' : w.name
  }
  const stamped = Object.entries(stamps).filter(([k, v]) => {
    const cur = findWorkloadAnnotations(workloadText, w.docIndex)[k]
    return cur !== v
  })
  if (stamped.length) {
    const ok = editWorkloadDoc((doc) => {
      let d: string | null = doc
      for (const [k, v] of stamped) d = d === null ? null : setScalar(d, ['metadata', 'annotations', k], v)
      return d
    })
    if (!ok) notes.push(`Annotate ${w.kind} ${w.name} with ${stamped.map(([k, v]) => `${k}=${v}`).join(', ')} by hand so the catalog checks see it.`)
  }

  const changes: FileChange[] = []
  if (workloadText !== base.workloadFile.text) {
    changes.push({ path: base.workloadFile.path, before: base.workloadFile.text, after: workloadText, baseSha: base.workloadFile.sha })
  }
  if (base.kustomization && kustomText !== undefined && kustomText !== base.kustomization.text) {
    changes.push({ path: base.kustomization.path, before: base.kustomization.text, after: kustomText, baseSha: base.kustomization.sha })
  }
  changes.push(...added)
  return { changes, notes, skipped, stamps }
}

function findWorkloadAnnotations(text: string, docIndex: number): Record<string, string> {
  const doc = parseDocs(text).find((d) => d.index === docIndex)?.value
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(asRecord(getPath(doc, ['metadata', 'annotations'])) ?? {})) out[k] = String(v)
  return out
}

/* ─────────── resource suggestion from observed usage ─────────── */

function cpuQty(cores: number): string {
  const m = Math.max(10, Math.ceil((cores * 1000) / 10) * 10)
  return m >= 1000 && m % 1000 === 0 ? String(m / 1000) : `${m}m`
}

function memQty(bytes: number): string {
  const mi = Math.max(32, Math.ceil(bytes / (1024 * 1024) / 16) * 16)
  return mi >= 1024 && mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`
}

/**
 * Requests/limits from what the containers actually used: requests at 1.2×
 * the observed peak per container (never under the conservative floor),
 * limits at 2× the request for memory and 4× for CPU. Without observations the
 * conservative defaults stand — never an invented number.
 */
export function suggestResources(observed: { cpuCores?: number | null; memoryBytes?: number | null }): { spec: ResourceSpec; fromUsage: boolean } {
  const d = DEFAULT_PARAMS.resources
  const cpu = observed.cpuCores
  const mem = observed.memoryBytes
  if (!(typeof cpu === 'number' && cpu > 0) && !(typeof mem === 'number' && mem > 0)) return { spec: d, fromUsage: false }
  const reqCpuCores = typeof cpu === 'number' && cpu > 0 ? Math.max(cpu * 1.2, 0.05) : 0.1
  const reqMemBytes = typeof mem === 'number' && mem > 0 ? Math.max(mem * 1.2, 64 * 1024 * 1024) : 128 * 1024 * 1024
  return {
    spec: {
      requests: { cpu: cpuQty(reqCpuCores), memory: memQty(reqMemBytes) },
      limits: { cpu: cpuQty(reqCpuCores * 4), memory: memQty(reqMemBytes * 2) },
    },
    fromUsage: true,
  }
}

/* ─────────── re-evaluation: snapshots and deltas ─────────── */

export interface ScoreSnapshot {
  score: number
  /** Passing checks: catalog checks + the platform scorer's fully-passing applicable signals. */
  passing: number
  /** Ids of everything counted in `passing` (`check:<id>` / `signal:<name>`). */
  passed: string[]
  /** The scorer run this snapshot came from, when the platform graded it. */
  lastRun?: string
}

export function snapshotOf(card: Pick<Scorecard, 'score' | 'checks' | 'platform'>, lastRun?: string): ScoreSnapshot {
  const passed = [
    ...card.checks.filter((c) => c.pass).map((c) => `check:${c.id}`),
    ...(card.platform?.signals ?? []).filter((s) => s.applicable && s.score >= 1).map((s) => `signal:${s.name}`),
  ]
  return { score: card.score, passing: passed.length, passed, ...(lastRun ? { lastRun } : {}) }
}

export interface ScoreDelta {
  from: number
  to: number
  delta: number
  passingDelta: number
  nowPassing: string[]
  nowFailing: string[]
  message: string
}

/** "78 → 86, +2 checks passing" — what a re-evaluation changed, in one line. */
export function scoreDelta(before: ScoreSnapshot, after: ScoreSnapshot): ScoreDelta {
  const b = new Set(before.passed)
  const a = new Set(after.passed)
  const nowPassing = after.passed.filter((x) => !b.has(x))
  const nowFailing = before.passed.filter((x) => !a.has(x))
  const passingDelta = after.passing - before.passing
  const checks = (n: number) => `${n > 0 ? '+' : ''}${n} ${Math.abs(n) === 1 ? 'check' : 'checks'} passing`
  const message = before.score === after.score && passingDelta === 0
    ? `No change — still ${after.score}`
    : `${before.score} → ${after.score}${passingDelta !== 0 ? `, ${checks(passingDelta)}` : ''}`
  return { from: before.score, to: after.score, delta: after.score - before.score, passingDelta, nowPassing, nowFailing, message }
}

/* ─────────── pending fixes ─────────── */

export type PendingState = 'open' | 'committed' | 'merged'

export interface PendingFix {
  id: string
  entityRef: string
  /** The platform scorer's key for the service, when it has one. */
  service?: string
  /** `check:<id>` / `signal:<name>` this fix addresses. */
  targets: string[]
  org: string
  repo: string
  branch: string
  mode: 'pr' | 'commit'
  pr?: { number: number; url?: string }
  state: PendingState
  createdAt: string
  /** When the PR merged (or the direct commit landed). */
  landedAt?: string
}

/** A pending fix stops being shown after this long without the evaluator confirming it. */
export const PENDING_TTL_MS = 3 * 24 * 60 * 60_000

/**
 * Drop fixes the evaluator now confirms (every target passes) and fixes that
 * have been "pending" so long they are no longer honest. An OPEN PR is kept
 * regardless of age — it is still waiting for review.
 */
export function prunePending(list: PendingFix[], passedByRef: Map<string, Set<string>>, now: number): PendingFix[] {
  return list.filter((p) => {
    const passed = passedByRef.get(p.entityRef)
    if (passed && p.state !== 'open' && p.targets.every((t) => passed.has(t))) return false
    if (p.state !== 'open' && now - Date.parse(p.landedAt ?? p.createdAt) > PENDING_TTL_MS) return false
    return true
  })
}

/** The pending fix (if any) that covers a target on an entity. */
export function pendingFor(list: PendingFix[], entityRef: string, target: string): PendingFix | undefined {
  return list.find((p) => p.entityRef === entityRef && p.targets.includes(target))
}

export function pendingLabel(p: PendingFix): string {
  if (p.mode === 'pr' && p.pr) {
    return p.state === 'merged' ? `Fix merged — PR #${p.pr.number}, awaiting re-evaluation` : `Fix pending — PR #${p.pr.number}`
  }
  return 'Fix committed — awaiting re-evaluation'
}

/* ─────────── branch + commit naming ─────────── */

export function fixBranchName(entityName: string, targets: string[], now = Date.now()): string {
  const slug = entityName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'entity'
  const what = targets.length === 1 ? targets[0].replace(/^(check|signal):/, '').replace(/[^a-z0-9-]+/gi, '-').toLowerCase() : 'readiness'
  return `scorecard/${slug}-${what}-${now.toString(36)}`
}
