import { useQuery } from '@tanstack/react-query'
import type { k8s } from '@adhar-console/api-clients'
import { client, useActiveCluster } from './client.ts'
import type { XrFormField } from '../views/xr-list.tsx'

/**
 * Live, schema-driven discovery of Crossplane CompositeResourceDefinitions
 * (XRDs) and their Compositions.
 *
 * This is the drift-proof source of truth for the "Adhar Resources" surface:
 * instead of hand-authoring a form per kind (which silently drifts from the
 * real XRD and makes server-side apply fail with "field not declared in
 * schema"), we read every XRD off the cluster, parse its OpenAPI schema, and
 * generate the create form + apply payload from it. The Compositions feed the
 * `spec.compositionSelector.matchLabels` variant picker.
 *
 * Two XRD shapes exist in the Adhar platform and both are handled:
 *   1. parameters-style — user inputs live under `spec.parameters.*`, and the
 *      XRD declares `spec.{compositionSelector, parameters, providerConfigRef,
 *      writeConnectionSecretToRef}` (e.g. CompositeDatabase, CompositeEnvironment).
 *   2. flat-style — user inputs live directly under `spec.*` and there is no
 *      `parameters` bag (e.g. CompositeStorage, CompositeMessaging).
 * The parser detects which by whether `spec.properties.parameters` exists, so
 * the built payload always nests values where the live schema declares them.
 */

/** GVRs for the Crossplane apiextensions objects we discover. */
export const XRD_GVR: k8s.GVR = {
  group: 'apiextensions.crossplane.io',
  version: 'v1',
  resource: 'compositeresourcedefinitions',
  namespaced: false,
}
export const COMPOSITION_GVR: k8s.GVR = {
  group: 'apiextensions.crossplane.io',
  version: 'v1',
  resource: 'compositions',
  namespaced: false,
}

/** The four Crossplane-standard spec keys — never user-authored form fields. */
const STANDARD_SPEC_KEYS = new Set([
  'compositionSelector',
  'compositionRef',
  'compositionRevisionRef',
  'compositionRevisionSelector',
  'compositionUpdatePolicy',
  'providerConfigRef',
  'writeConnectionSecretToRef',
  'publishConnectionDetailsTo',
  'resourceRefs',
  'claimRef',
])

/* ───── OpenAPI schema shapes (the subset we read) ───── */

interface JSONSchemaProp {
  type?: string
  enum?: unknown[]
  description?: string
  default?: unknown
  format?: string
  pattern?: string
  minimum?: number
  maximum?: number
  properties?: Record<string, JSONSchemaProp>
  required?: string[]
  items?: JSONSchemaProp
}

interface XrdObject {
  metadata: { name: string; labels?: Record<string, string> }
  spec: {
    group: string
    names: { kind: string; plural: string; singular?: string }
    scope?: string
    claimNames?: { kind: string; plural: string }
    versions: Array<{
      name: string
      served?: boolean
      storage?: boolean
      referenceable?: boolean
      schema?: { openAPIV3Schema?: JSONSchemaProp }
    }>
  }
}

interface CompositionObject {
  metadata: { name: string; labels?: Record<string, string> }
  spec: { compositeTypeRef?: { apiVersion?: string; kind?: string } }
}

/* ───── parsed descriptor ───── */

export interface XrdInfo {
  /** GVR for the XR itself (plural resource). Always namespaced=false handled below. */
  gvr: k8s.GVR
  group: string
  version: string
  /** XR Kubernetes kind, e.g. `CompositeDatabase`. */
  kind: string
  plural: string
  /** Human singular derived from the kind (e.g. `CompositeDatabase` → `Database`). */
  humanSingular: string
  humanPlural: string
  namespaced: boolean
  /** True when user inputs nest under `spec.parameters` (vs directly under `spec`). */
  parametersMode: boolean
  /** True when the XRD schema declares `spec.compositionSelector`. */
  supportsCompositionSelector: boolean
  /** True when `spec.required` includes `compositionSelector`. */
  compositionSelectorRequired: boolean
  /** Schema-derived form fields. `key`s are plain property names (no dots). */
  fields: XrFormField[]
}

/* ───── parsing ───── */

function pickVersion(xrd: XrdObject) {
  const vs = xrd.spec.versions ?? []
  return (
    vs.find((v) => v.storage && v.served) ??
    vs.find((v) => v.served) ??
    vs.find((v) => v.storage) ??
    vs[0]
  )
}

/** `CompositeDatabase` → `Database`; `CompositeCostTracker` → `Cost Tracker`. */
export function humanizeKind(kind: string): string {
  const stripped = kind.replace(/^Composite/, '') || kind
  return humanizeWords(stripped)
}

/** camelCase / PascalCase / kebab → "Title Case Words". */
export function humanizeWords(s: string): string {
  const spaced = s
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  return spaced
    .split(/\s+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

const MONO_HINT = /(version|image|repo|host|path|name|class|zone|region|secret|ref|id|url|arn|key|fqdn|cidr|endpoint|selector)/i

function scalarDefault(prop: JSONSchemaProp): string | number | boolean | undefined {
  const d = prop.default
  if (d === undefined || d === null) return undefined
  if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') return d
  return undefined
}

/** Convert a single OpenAPI property into a form-field descriptor. */
function propToField(name: string, prop: JSONSchemaProp, required: boolean): XrFormField {
  const label = humanizeWords(name)
  const help = prop.description || undefined
  const group = required ? 'Required' : 'Optional'
  const base = { key: name, label, required, help, group } as XrFormField

  if (Array.isArray(prop.enum) && prop.enum.length) {
    return {
      ...base,
      type: 'select',
      options: prop.enum.map((v) => ({ value: String(v), label: String(v) })),
      default: scalarDefault(prop) ?? undefined,
    }
  }
  if (prop.type === 'boolean') {
    return { ...base, type: 'boolean', default: typeof prop.default === 'boolean' ? prop.default : false }
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    const d = scalarDefault(prop)
    return {
      ...base,
      type: 'number',
      default: typeof d === 'number' ? d : undefined,
      min: prop.minimum,
      max: prop.maximum,
    }
  }
  if (prop.type === 'array' || prop.type === 'object') {
    const d = prop.default
    return {
      ...base,
      type: 'json',
      mono: true,
      placeholder: prop.type === 'array' ? '[]' : '{}',
      default: d !== undefined && d !== null ? JSON.stringify(d) : undefined,
    }
  }
  // string (and unknown → string)
  const d = scalarDefault(prop)
  return {
    ...base,
    type: 'text',
    mono: MONO_HINT.test(name),
    pattern: prop.pattern,
    default: d !== undefined ? String(d) : undefined,
  }
}

/** Order: required first (schema order), then optional (alphabetical). */
function fieldsFromProps(
  props: Record<string, JSONSchemaProp>,
  required: string[],
): XrFormField[] {
  const requiredSet = new Set(required)
  const requiredNames = required.filter((n) => props[n]) // schema-declared order
  const optionalNames = Object.keys(props)
    .filter((n) => !requiredSet.has(n))
    .sort((a, b) => a.localeCompare(b))
  const ordered = [...requiredNames, ...optionalNames]
  return ordered.map((n) => propToField(n, props[n], requiredSet.has(n)))
}

/** Parse one XRD object into an {@link XrdInfo}, or null when unusable. */
export function parseXrd(xrd: XrdObject): XrdInfo | null {
  const version = pickVersion(xrd)
  if (!version?.schema?.openAPIV3Schema) return null
  const specSchema = version.schema.openAPIV3Schema.properties?.spec
  if (!specSchema?.properties) return null

  const specProps = specSchema.properties
  const specRequired = specSchema.required ?? []
  const params = specProps.parameters
  const parametersMode = Boolean(params?.properties)

  let fields: XrFormField[]
  if (parametersMode && params) {
    fields = fieldsFromProps(params.properties ?? {}, params.required ?? [])
  } else {
    // flat-style: every spec property except the Crossplane-standard keys
    const userProps: Record<string, JSONSchemaProp> = {}
    for (const [k, v] of Object.entries(specProps)) {
      if (STANDARD_SPEC_KEYS.has(k)) continue
      userProps[k] = v
    }
    const userRequired = specRequired.filter((r) => !STANDARD_SPEC_KEYS.has(r))
    fields = fieldsFromProps(userProps, userRequired)
  }

  const namespaced = (xrd.spec.scope ?? 'Namespaced') === 'Namespaced'

  return {
    gvr: {
      group: xrd.spec.group,
      version: version.name,
      resource: xrd.spec.names.plural,
      namespaced,
    },
    group: xrd.spec.group,
    version: version.name,
    kind: xrd.spec.names.kind,
    plural: xrd.spec.names.plural,
    humanSingular: humanizeKind(xrd.spec.names.kind),
    humanPlural: `${humanizeKind(xrd.spec.names.kind)}s`.replace(/ys$/, 'ies').replace(/ss$/, 'ses'),
    namespaced,
    parametersMode,
    supportsCompositionSelector: 'compositionSelector' in specProps,
    compositionSelectorRequired: specRequired.includes('compositionSelector'),
    fields,
  }
}

/* ───── composition variant model ───── */

export interface CompositionInfo {
  name: string
  kind: string
  labels: Record<string, string>
}

/** Label keys we surface as the human "variant" dimensions, in priority order. */
export const VARIANT_LABEL_ORDER = [
  'provider',
  'engine',
  'type',
  'tool',
  'cluster.adhar.io/type',
  'cicd.adhar.io/type',
  'policy.adhar.io/engine',
]

/**
 * A selectable variant = one Composition. `matchLabels` is the composition's own
 * label set, so selecting it targets exactly that composition (no ambiguity).
 */
export interface Variant {
  name: string
  labels: Record<string, string>
  /** Human summary of the distinguishing labels, e.g. "local · postgresql". */
  summary: string
}

function variantSummary(labels: Record<string, string>): string {
  const parts: string[] = []
  for (const key of VARIANT_LABEL_ORDER) {
    if (labels[key]) parts.push(labels[key])
  }
  if (parts.length) return parts.join(' · ')
  const rest = Object.entries(labels)
    .filter(([k]) => k !== 'feature')
    .map(([, v]) => v)
  return rest.join(' · ') || 'default'
}

export function toVariants(comps: CompositionInfo[]): Variant[] {
  return comps
    .map((c) => ({ name: c.name, labels: c.labels, summary: variantSummary(c.labels) }))
    .sort((a, b) => {
      // Prefer provider=local first, then alphabetical by summary.
      const al = a.labels.provider === 'local' ? 0 : 1
      const bl = b.labels.provider === 'local' ? 0 : 1
      if (al !== bl) return al - bl
      return a.summary.localeCompare(b.summary)
    })
}

/* ───── hooks ───── */

/** All CompositeResourceDefinitions on the active cluster, parsed. */
export function useXrds() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['platform', 'xrds', cluster],
    queryFn: async (): Promise<XrdInfo[]> => {
      const items = (await client.listGeneric(cluster, XRD_GVR)) as unknown as XrdObject[]
      return items
        .map(parseXrd)
        .filter((x): x is XrdInfo => x !== null)
        .sort((a, b) => a.kind.localeCompare(b.kind))
    },
    staleTime: 60_000,
    retry: false,
  })
}

/** All Compositions on the active cluster, indexed nothing — filter by kind at call site. */
export function useCompositions() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['platform', 'compositions', cluster],
    queryFn: async (): Promise<CompositionInfo[]> => {
      const items = (await client.listGeneric(cluster, COMPOSITION_GVR)) as unknown as CompositionObject[]
      return items.map((c) => ({
        name: c.metadata.name,
        kind: c.spec.compositeTypeRef?.kind ?? '',
        labels: c.metadata.labels ?? {},
      }))
    },
    staleTime: 60_000,
    retry: false,
  })
}

/** Compositions targeting a given XR kind, as sorted variants. */
export function useVariantsForKind(kind: string) {
  const q = useCompositions()
  const variants = toVariants((q.data ?? []).filter((c) => c.kind === kind))
  return { ...q, variants }
}
