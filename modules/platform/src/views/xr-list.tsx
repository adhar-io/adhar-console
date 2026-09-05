import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
  type Column,
} from '@adhar-console/shell-ui'
import { k8s } from '@adhar-console/api-clients'
import { kube } from '@adhar-console/api-clients/k8s'
import { cn } from '@adhar-console/utils'
import { client, clusterParam, useActiveCluster } from '../data/client.ts'
import { useGeneric, useNamespaces } from '../data/hooks.ts'
import { GVRS } from '../data/gvr.ts'
import { age } from '../data/format.ts'
import { useHasK8sPermission } from '../data/access.ts'
import { K8sRolePill } from '../components/role-gate.tsx'

/**
 * Generic list + detail drawer + **self-service provisioning** for a
 * Crossplane Composite Resource (XR).
 *
 * Every Adhar Platform abstraction (Application, Database, DataPipeline,
 * Pipeline, Route, …) resolves to an XR/claim in the cluster with standard
 * Crossplane conventions:
 *
 *   status.conditions[type=Ready]
 *   status.conditions[type=Synced]
 *   spec.compositionRef.name     (which Composition shaped this XR)
 *   spec.compositionSelector     (label-based selector variant)
 *   status.resourceRefs[]        (all composed resources)
 *
 * This component leans on those conventions so we don't need bespoke views
 * per kind — a per-kind config map supplies kind-specific extra columns, the
 * drawer's "Spec" renderer, and (via `formFields`) a generated provisioning
 * wizard. Every mutation goes through the per-user gateway:
 *
 *   - provision / edit → `kube.apply` (server-side apply, fieldManager
 *     `adhar-console` — set by the gateway) so Crossplane reconciles a REAL
 *     claim into backing infrastructure
 *   - deprovision → `kube.delete` on the claim, which tears the
 *     infrastructure down
 *
 * All requests carry the signed-in user's identity, so RBAC and apiserver
 * audit logs reflect the actual actor.
 */

/**
 * sessionStorage key used to hand off a "open the create wizard" intent across
 * a section navigation. The catalog dashboard writes the target kind's GVR
 * `resource` here before deep-linking to `?section=<id>`; the matching
 * <XrList/> reads and clears it on mount (see the effect in `XrList`). Kept in
 * sessionStorage so it survives the full-document navigation a plain anchor
 * triggers (the federated remote does not share the host router).
 */
export const AUTO_CREATE_KEY = 'adhar:platform:autocreate'

/**
 * One field of the generated provisioning form. `key` is a spec path —
 * dot-notation expands into nested objects (`'network.public'` →
 * `spec.network.public`). Populated per kind in `xr-kinds.tsx`.
 */
export interface XrFormField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'boolean' | 'textarea'
  required?: boolean
  placeholder?: string
  help?: string
  default?: string | number | boolean
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  mono?: boolean
  pattern?: string
  group?: string
}

export interface XrKindConfig {
  /** GVR used to query the kube-apiserver. */
  gvr: k8s.GVR
  /**
   * Kubernetes `kind` for freshly provisioned claims/composites. Defaults to
   * the human `singular` with non-alphanumerics stripped, but the Adhar
   * Crossplane composites use `Composite<Domain>` kinds (e.g. a "Database"
   * surfaces the `CompositeDatabase` kind), so it's set explicitly per kind.
   */
  kind?: string
  /** Singular + plural human names. */
  singular: string
  plural: string
  /** One-line page subtitle. */
  description: string
  /**
   * Spec keys to surface in the detail drawer's "Spec" section. Drawer shows
   * `key → value` rows for each; anything not listed is folded into the YAML
   * view. Dot-notation paths are supported.
   */
  specFields?: Array<{ key: string; label: string; mono?: boolean }>
  /** Extra columns to insert between name and age. */
  extraColumns?: Column<XR>[]
  /** Upstream docs link surfaced when the XRD isn't installed. */
  docsHref?: string
  /**
   * Fields for the generated provision/edit form. When absent the wizard
   * falls back to a raw spec editor (JSON or simple `key: value` lines) —
   * still a real server-side apply.
   */
  formFields?: XrFormField[]
  /**
   * How to locate the claim's connection Secret in the claim's namespace.
   * `nameFromSpec` is a dot-path into the claim spec whose value is the
   * Secret name (e.g. `'writeConnectionSecretToRef.name'`); `nameTemplate`
   * is a literal name with `<name>` / `<namespace>` placeholders (e.g.
   * `'<name>-conn'`). Optional — the drawer stays graceful when unset or
   * when the Secret doesn't exist yet.
   */
  connectionSecret?: { nameFromSpec?: string; nameTemplate?: string }
}

export interface XR {
  apiVersion: string
  kind: string
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    deletionTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    uid?: string
  }
  spec?: Record<string, unknown>
  status?: {
    conditions?: Array<{
      type: string
      status: 'True' | 'False' | 'Unknown'
      reason?: string
      message?: string
      lastTransitionTime?: string
    }>
    resourceRefs?: Array<{
      apiVersion?: string
      kind?: string
      name?: string
      namespace?: string
    }>
    [k: string]: unknown
  }
}

/* ───── spec-path + manifest helpers ───── */

/** Read a dot-notation path out of a nested object. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Write a dot-notation path into a nested object, creating parents. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    const next = cur[p]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[p] = {}
    }
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

/**
 * Kubernetes Kind for the claim manifest, derived from the human singular —
 * `'Data Pipeline'` → `'DataPipeline'`. Edits reuse the live object's own
 * `kind` instead, so this only shapes freshly provisioned claims.
 */
function claimKind(config: XrKindConfig): string {
  return config.kind ?? config.singular.replace(/[^A-Za-z0-9]/g, '')
}

function claimApiVersion(gvr: k8s.GVR): string {
  return gvr.group ? `${gvr.group}/${gvr.version}` : gvr.version
}

/** RFC 1123 subdomain — what the apiserver accepts for object names. */
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

/**
 * Assemble a spec object from form values. Dot-keys expand into nested
 * objects; empty optional strings/numbers are omitted; booleans are always
 * sent (false is a meaningful value).
 */
function buildSpecFromValues(
  fields: XrFormField[],
  values: Record<string, string | boolean>,
): Record<string, unknown> {
  const spec: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = values[f.key]
    if (f.type === 'boolean') {
      setPath(spec, f.key, raw === true)
      continue
    }
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (!s) continue
    if (f.type === 'number') setPath(spec, f.key, Number(s))
    else setPath(spec, f.key, s)
  }
  return spec
}

function validateFieldValues(
  fields: XrFormField[],
  values: Record<string, string | boolean>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of fields) {
    if (f.type === 'boolean') continue
    const raw = values[f.key]
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (!s) {
      if (f.required) errors[f.key] = 'Required'
      continue
    }
    if (f.type === 'number') {
      const n = Number(s)
      if (!Number.isFinite(n)) errors[f.key] = 'Must be a number'
      else if (f.min !== undefined && n < f.min) errors[f.key] = `Must be ≥ ${f.min}`
      else if (f.max !== undefined && n > f.max) errors[f.key] = `Must be ≤ ${f.max}`
      continue
    }
    if (f.pattern) {
      let re: RegExp | null = null
      try {
        re = new RegExp(`^(?:${f.pattern})$`)
      } catch {
        re = null // invalid pattern in config — don't block the user
      }
      if (re && !re.test(s)) errors[f.key] = `Must match ${f.pattern}`
    }
  }
  return errors
}

/** Initial form state — live spec values (edit) over per-field defaults. */
function initialFieldValues(
  fields: XrFormField[],
  spec?: Record<string, unknown>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (const f of fields) {
    const existing = spec ? getPath(spec, f.key) : undefined
    if (f.type === 'boolean') {
      out[f.key] =
        typeof existing === 'boolean'
          ? existing
          : typeof f.default === 'boolean'
            ? f.default
            : false
      continue
    }
    const v =
      existing !== undefined && existing !== null && typeof existing !== 'object'
        ? existing
        : f.default
    out[f.key] = v === undefined || v === null ? '' : String(v)
  }
  return out
}

/**
 * Parse the raw-spec fallback editor. Accepts a JSON object, or minimal
 * `key: value` lines with two-space indentation for nesting (a hand-rolled
 * subset — no YAML dependency, no lists). Scalars are auto-typed
 * (true/false/null/numbers/quoted strings).
 */
function parseSpecText(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  if (trimmed.startsWith('{')) {
    try {
      const v = JSON.parse(trimmed) as unknown
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, error: 'Spec must be a JSON object' }
      }
      return { ok: true, value: v as Record<string, unknown> }
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }]
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^\s*\t/.test(line)) return { ok: false, error: `Line ${i + 1}: use spaces, not tabs` }
    if (/^\s*-/.test(line)) {
      return { ok: false, error: `Line ${i + 1}: lists aren't supported here — use JSON instead` }
    }
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    const colon = body.indexOf(':')
    if (colon <= 0) return { ok: false, error: `Line ${i + 1}: expected "key: value"` }
    const key = body.slice(0, colon).trim()
    const rest = body.slice(colon + 1).trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (!rest) {
      const child: Record<string, unknown> = {}
      setPath(parent, key, child)
      stack.push({ indent, obj: child })
    } else {
      setPath(parent, key, coerceScalar(rest))
    }
  }
  return { ok: true, value: root }
}

function coerceScalar(raw: string): unknown {
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1)
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/* ───── base64 (Secret values) ───── */

function b64Decode(value: string): { ok: boolean; text: string } {
  try {
    const bin = atob(value)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Control characters (except tab/newline/CR) mean binary content.
    // eslint-disable-next-line no-control-regex
    if (/[ --]/.test(text)) return { ok: false, text: value }
    return { ok: true, text }
  } catch {
    return { ok: false, text: value }
  }
}

/* ───── list ───── */

export function XrList({
  config,
  namespace,
}: {
  config: XrKindConfig
  namespace?: string
}) {
  const q = useGeneric(config.gvr, config.gvr.namespaced ? namespace : undefined)
  const qc = useQueryClient()
  const [selected, setSelected] = useState<XR | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const canProvision = useHasK8sPermission('crds.write')

  // Honour a "create" intent handed off by the catalog dashboard — open the
  // provisioning wizard once, on mount, only for the matching kind and only
  // when the user may actually provision.
  useEffect(() => {
    let intent: string | null = null
    try {
      intent = sessionStorage.getItem(AUTO_CREATE_KEY)
    } catch {
      return // storage unavailable — the deep-link to the list still works
    }
    if (intent !== config.gvr.resource) return
    // Consume the one-shot intent regardless of permission so it can't linger.
    try {
      sessionStorage.removeItem(AUTO_CREATE_KEY)
    } catch {
      /* ignore — best-effort cleanup */
    }
    if (canProvision) setProvisioning(true)
  }, [canProvision, config.gvr.resource])

  const is404 = q.isError && (q.error as { status?: number })?.status === 404

  const invalidate = () => {
    qc.invalidateQueries({
      queryKey: ['k8s', 'generic', config.gvr.group, config.gvr.version, config.gvr.resource],
    })
    qc.invalidateQueries({ queryKey: ['platform', 'xr'] })
  }

  if (is404) {
    return (
      <EmptyState
        title={`${config.plural} not installed`}
        description={
          <>
            <code className="font-mono">{config.gvr.group}/{config.gvr.version}/{config.gvr.resource}</code>{' '}
            is not registered on this cluster. Install the Adhar Platform Crossplane stack to
            provision {config.plural.toLowerCase()}.
            {config.docsHref ? (
              <>
                {' '}
                <a
                  className="text-brand-700 dark:text-brand-300 underline hover:text-brand-800"
                  target="_blank"
                  rel="noreferrer"
                  href={config.docsHref}
                >
                  Upstream docs ↗
                </a>
              </>
            ) : null}
          </>
        }
      />
    )
  }

  if (q.isError) {
    return (
      <EmptyState
        title={`Couldn't list ${config.plural.toLowerCase()}`}
        description={(q.error as Error).message}
      />
    )
  }

  const rows = (q.data ?? []) as unknown as XR[]

  const columns: Column<XR>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (r) => (
        <div>
          <div className="font-medium text-content">{r.metadata.name}</div>
          {r.metadata.namespace ? (
            <div className="text-xs text-content-muted">{r.metadata.namespace}</div>
          ) : (
            <div className="text-xs text-content-subtle">cluster-scoped</div>
          )}
        </div>
      ),
    },
    {
      key: 'ready',
      header: 'Ready',
      cell: (r) =>
        r.metadata.deletionTimestamp ? (
          <StatusBadge kind="paused">Deleting</StatusBadge>
        ) : (
          conditionBadge(r, 'Ready')
        ),
    },
    {
      key: 'synced',
      header: 'Synced',
      cell: (r) => conditionBadge(r, 'Synced'),
    },
    {
      key: 'composition',
      header: 'Composition',
      cell: (r) => {
        const name = (r.spec?.compositionRef as { name?: string } | undefined)?.name
        if (name) return <code className="text-xs text-content-muted">{name}</code>
        const sel = r.spec?.compositionSelector as
          | { matchLabels?: Record<string, string> }
          | undefined
        if (sel?.matchLabels && Object.keys(sel.matchLabels).length) {
          return (
            <code className="text-xs text-content-muted">
              selector · {Object.entries(sel.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')}
            </code>
          )
        }
        return <span className="text-content-subtle">—</span>
      },
    },
    ...(config.extraColumns ?? []),
    { key: 'age', header: 'Age', cell: (r) => age(r.metadata.creationTimestamp) },
  ]

  return (
    <>
      <div className="mb-3 flex items-center justify-end gap-2">
        {q.isFetching && !q.isLoading ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-content-subtle">
            <Spinner size={12} /> refreshing
          </span>
        ) : null}
        {canProvision ? (
          <Button size="sm" onClick={() => setProvisioning(true)}>
            Provision {config.singular}
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
            Provision <K8sRolePill perm="crds.write" />
          </span>
        )}
      </div>
      <DataTable
        loading={q.isLoading}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.metadata.uid ?? `${r.metadata.namespace ?? '-'}/${r.metadata.name}`}
        onRowClick={(r) => setSelected(r)}
        empty={
          <EmptyState
            title={`No ${config.plural.toLowerCase()} yet`}
            description={
              canProvision
                ? `Provision your first ${config.singular} with the button above — Crossplane reconciles the claim into real infrastructure.`
                : `Claim a ${config.singular} via GitOps to populate this list.`
            }
          />
        }
      />
      {provisioning ? (
        <ClaimFormModal
          config={config}
          mode="create"
          defaultNamespace={namespace}
          onClose={() => setProvisioning(false)}
          onApplied={(applied) => {
            invalidate()
            setProvisioning(false)
            setSelected(applied)
          }}
        />
      ) : null}
      {selected ? (
        <XrDrawer
          config={config}
          xr={selected}
          onClose={() => setSelected(null)}
          onMutated={invalidate}
        />
      ) : null}
    </>
  )
}

/* ───── provision / edit modal ───── */

function ClaimFormModal({
  config,
  mode,
  initial,
  defaultNamespace,
  onClose,
  onApplied,
}: {
  config: XrKindConfig
  mode: 'create' | 'edit'
  /** Live object being edited — required when mode is 'edit'. */
  initial?: XR
  defaultNamespace?: string
  onClose(): void
  onApplied(applied: XR): void
}) {
  const { cluster } = useActiveCluster()
  const cp = clusterParam(cluster)
  const fields = config.formFields
  const namespaced = config.gvr.namespaced !== false
  const namespacesQ = useNamespaces()

  const [name, setName] = useState(initial?.metadata.name ?? '')
  const [ns, setNs] = useState(initial?.metadata.namespace ?? defaultNamespace ?? 'default')
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    fields ? initialFieldValues(fields, initial?.spec) : {},
  )
  const [specText, setSpecText] = useState(() =>
    initial?.spec ? JSON.stringify(initial.spec, null, 2) : '{\n\n}',
  )
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const applyMut = useMutation({
    // Server-side apply through the per-user gateway; the gateway stamps
    // fieldManager=adhar-console on the SSA patch. Never simulated.
    mutationFn: (manifest: XR) =>
      kube.apply<XR>(manifest as unknown as Parameters<typeof kube.apply>[0], { cluster: cp }),
    onSuccess: (applied) => onApplied(applied),
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applyMut.isPending) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, applyMut.isPending])

  const grouped = useMemo(() => {
    if (!fields) return []
    const map = new Map<string, XrFormField[]>()
    for (const f of fields) {
      const g = f.group ?? ''
      const arr = map.get(g)
      if (arr) arr.push(f)
      else map.set(g, [f])
    }
    return Array.from(map.entries()).map(([label, groupFields]) => ({ label, fields: groupFields }))
  }, [fields])

  const submit = () => {
    setFormError(null)
    // ── metadata validation ──
    const errors: Record<string, string> = {}
    const trimmedName = name.trim()
    if (!trimmedName) errors.__name = 'Required'
    else if (trimmedName.length > 253 || !DNS_SUBDOMAIN.test(trimmedName)) {
      errors.__name = 'Lowercase alphanumerics, "-" and "." only (RFC 1123)'
    }
    const trimmedNs = ns.trim()
    if (namespaced) {
      if (!trimmedNs) errors.__namespace = 'Required'
      else if (trimmedNs.length > 63 || !DNS_SUBDOMAIN.test(trimmedNs)) {
        errors.__namespace = 'Must be a valid namespace name'
      }
    }
    // ── spec ──
    let spec: Record<string, unknown>
    if (fields) {
      Object.assign(errors, validateFieldValues(fields, values))
      spec = buildSpecFromValues(fields, values)
    } else {
      const parsed = parseSpecText(specText)
      if (!parsed.ok) {
        setFieldErrors(errors)
        setFormError(parsed.error)
        return
      }
      spec = parsed.value
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length) return

    const manifest: XR = {
      apiVersion: initial?.apiVersion ?? claimApiVersion(config.gvr),
      kind: initial?.kind ?? claimKind(config),
      metadata: {
        name: trimmedName,
        ...(namespaced ? { namespace: trimmedNs } : {}),
      },
      spec,
    }
    applyMut.mutate(manifest)
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]"
        onClick={() => {
          if (!applyMut.isPending) onClose()
        }}
      />
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-edge-default bg-surface-app shadow-2xl">
        <header className="border-b border-edge-default bg-surface-raised px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
            {mode === 'create' ? 'Self-service provisioning' : 'Edit claim'}
          </div>
          <h2 className="mt-0.5 text-lg font-semibold text-content">
            {mode === 'create' ? `Provision ${config.singular}` : `Edit ${initial?.metadata.name ?? ''}`}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-content-muted">
            {mode === 'create'
              ? `Creates a real ${claimKind(config)} claim via server-side apply — Crossplane reconciles it into backing infrastructure.`
              : 'Updates the claim via server-side apply — Crossplane reconciles the change into the backing infrastructure.'}
          </p>
        </header>

        <form
          className="flex-1 space-y-5 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {/* ── metadata ── */}
          <fieldset className="space-y-3" disabled={applyMut.isPending}>
            <legend className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Metadata
            </legend>
            <div>
              <label className="mb-1 block text-xs font-medium text-content" htmlFor="xr-form-name">
                Name{mode === 'edit' ? '' : ' *'}
              </label>
              <input
                id="xr-form-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                readOnly={mode === 'edit'}
                placeholder={`my-${config.gvr.resource.replace(/s$/, '')}`}
                className={cn(
                  'h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30',
                  mode === 'edit' && 'opacity-70',
                )}
                aria-invalid={Boolean(fieldErrors.__name)}
              />
              {fieldErrors.__name ? <FieldError text={fieldErrors.__name} /> : null}
            </div>
            {namespaced ? (
              <div>
                <label className="mb-1 block text-xs font-medium text-content" htmlFor="xr-form-ns">
                  Namespace{mode === 'edit' ? '' : ' *'}
                </label>
                <input
                  id="xr-form-ns"
                  value={ns}
                  onChange={(e) => setNs(e.target.value)}
                  readOnly={mode === 'edit'}
                  list={mode === 'create' ? 'xr-form-ns-options' : undefined}
                  className={cn(
                    'h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30',
                    mode === 'edit' && 'opacity-70',
                  )}
                  aria-invalid={Boolean(fieldErrors.__namespace)}
                />
                {mode === 'create' ? (
                  <datalist id="xr-form-ns-options">
                    {(namespacesQ.data ?? []).map((n) => (
                      <option key={n.metadata.name} value={n.metadata.name} />
                    ))}
                  </datalist>
                ) : null}
                {fieldErrors.__namespace ? <FieldError text={fieldErrors.__namespace} /> : null}
              </div>
            ) : null}
          </fieldset>

          {/* ── spec (generated form or raw fallback) ── */}
          {fields ? (
            grouped.map((g) => (
              <fieldset key={g.label || '__default'} className="space-y-3" disabled={applyMut.isPending}>
                <legend className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                  {g.label || 'Configuration'}
                </legend>
                {g.fields.map((f) => (
                  <FormFieldInput
                    key={f.key}
                    field={f}
                    value={values[f.key]}
                    error={fieldErrors[f.key]}
                    onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                  />
                ))}
              </fieldset>
            ))
          ) : (
            <fieldset className="space-y-2" disabled={applyMut.isPending}>
              <legend className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                Spec
              </legend>
              <p className="text-[11px] text-content-muted">
                No form is defined for this kind yet — edit the claim spec directly. JSON object or
                simple <code className="font-mono">key: value</code> lines (two-space indentation
                for nesting; no lists).
              </p>
              <textarea
                value={specText}
                onChange={(e) => setSpecText(e.target.value)}
                rows={Math.min(18, Math.max(6, specText.split('\n').length + 1))}
                spellCheck={false}
                className="w-full rounded-lg border border-edge-default bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-content outline-none focus:ring-2 focus:ring-brand-500/30"
                aria-label="Claim spec"
              />
            </fieldset>
          )}

          {formError ? (
            <p className="text-[12px] text-rose-700 dark:text-rose-300" role="alert">
              {formError}
            </p>
          ) : null}
          {applyMut.isError ? (
            <div
              className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-3 py-2 text-[12px] text-rose-800 dark:text-rose-300"
              role="alert"
            >
              <div className="font-semibold">Apply failed</div>
              {/* apiserver message verbatim — it names the exact field/reason */}
              <div className="mt-0.5 break-words font-mono text-[11px]">
                {(applyMut.error as Error).message}
              </div>
            </div>
          ) : null}
        </form>

        <footer className="flex items-center justify-between gap-3 border-t border-edge-default bg-surface-raised px-5 py-3">
          <span className="text-[10px] text-content-subtle">
            Server-side apply · field manager <code className="font-mono">adhar-console</code>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={applyMut.isPending}>
              Cancel
            </Button>
            <Button size="sm" disabled={applyMut.isPending} onClick={submit}>
              {applyMut.isPending ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner size={12} /> Applying…
                </span>
              ) : mode === 'create' ? (
                `Provision ${config.singular}`
              ) : (
                'Apply changes'
              )}
            </Button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

function FormFieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: XrFormField
  value: string | boolean | undefined
  error?: string
  onChange(v: string | boolean): void
}) {
  const id = `xr-field-${field.key.replace(/\./g, '-')}`
  const inputCls = cn(
    'w-full rounded-md border border-edge-default bg-surface-raised px-2 text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-brand-500/30',
    field.mono && 'font-mono',
    error && 'border-rose-400 dark:border-rose-500/60',
  )

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-edge-default accent-brand-600"
        />
        <div className="min-w-0">
          <label htmlFor={id} className="block text-xs font-medium text-content">
            {field.label}
          </label>
          {field.help ? <p className="mt-0.5 text-[11px] text-content-muted">{field.help}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-content" htmlFor={id}>
        {field.label}
        {field.required ? ' *' : ''}
      </label>
      {field.type === 'select' ? (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputCls, 'h-9')}
          aria-invalid={Boolean(error)}
        >
          {!field.required || (typeof value === 'string' && value === '') ? (
            <option value="">— none —</option>
          ) : null}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={4}
          spellCheck={false}
          className={cn(inputCls, 'p-2 leading-relaxed')}
          aria-invalid={Boolean(error)}
        />
      ) : (
        <input
          id={id}
          type={field.type === 'number' ? 'number' : 'text'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          className={cn(inputCls, 'h-9')}
          aria-invalid={Boolean(error)}
        />
      )}
      {error ? <FieldError text={error} /> : null}
      {!error && field.help ? (
        <p className="mt-1 text-[11px] text-content-muted">{field.help}</p>
      ) : null}
    </div>
  )
}

function FieldError({ text }: { text: string }) {
  return <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{text}</p>
}

/* ───── detail drawer ───── */

function XrDrawer({
  config,
  xr,
  onClose,
  onMutated,
}: {
  config: XrKindConfig
  xr: XR
  onClose(): void
  onMutated(): void
}) {
  const { cluster } = useActiveCluster()
  const cp = clusterParam(cluster)
  const canMutate = useHasK8sPermission('crds.write')
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteTyped, setDeleteTyped] = useState('')
  const [deleteRequested, setDeleteRequested] = useState(false)

  // Live-refresh the single resource so the drawer reflects reconcile progress.
  const live = useQuery({
    queryKey: [
      'platform',
      'xr',
      config.gvr.group,
      config.gvr.version,
      config.gvr.resource,
      xr.metadata.namespace ?? '-',
      xr.metadata.name,
    ],
    queryFn: () =>
      client.getGeneric(undefined, config.gvr, xr.metadata.namespace, xr.metadata.name),
    refetchInterval: 10_000,
    initialData: xr as unknown as k8s.Generic,
    retry: false,
  })
  const current = ((live.data as unknown) ?? xr) as XR
  const isGone = live.isError && (live.error as { status?: number })?.status === 404

  const deleteMut = useMutation({
    mutationFn: () =>
      kube.delete(config.gvr, current.metadata.namespace, current.metadata.name, { cluster: cp }),
    onSuccess: () => {
      setDeleteRequested(true)
      setConfirmDelete(false)
      setDeleteTyped('')
      onMutated()
    },
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The edit modal handles its own Escape — don't close the drawer under it.
      if (e.key === 'Escape' && !editing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, editing])

  const ready = findCondition(current, 'Ready')
  const synced = findCondition(current, 'Synced')
  const deleting = Boolean(current.metadata.deletionTimestamp) || deleteRequested

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-content-subtle">
              {config.singular} ·{' '}
              {current.metadata.namespace ? current.metadata.namespace : 'cluster'}
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-content">
              {current.metadata.name}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-mono text-content-muted">
              {current.apiVersion}/{current.kind}
              {live.isFetching ? (
                <span className="inline-flex items-center gap-1 text-content-subtle">
                  <Spinner size={12} /> refreshing
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canMutate && !deleting && !isGone ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        {isGone ? (
          <div
            className="border-b border-edge-default bg-surface-sunken px-6 py-3 text-[12px] text-content-muted"
            role="status"
          >
            This {config.singular.toLowerCase()} no longer exists on the cluster — the claim has
            been deleted and Crossplane has finished (or is finishing) tearing down its resources.
          </div>
        ) : deleting ? (
          <div
            className="border-b border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 px-6 py-3 text-[12px] text-amber-900 dark:text-amber-200"
            role="status"
          >
            <span className="font-semibold">Deprovision in progress.</span> The claim is marked for
            deletion — Crossplane is tearing down the backing infrastructure. Composed resources
            disappear from the list below as they are cleaned up.
          </div>
        ) : null}
        {deleteMut.isError ? (
          <div
            className="border-b border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 px-6 py-2 text-[12px] text-rose-800 dark:text-rose-300"
            role="alert"
          >
            Deprovision failed: {(deleteMut.error as Error).message}
          </div>
        ) : null}

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* ─── Status ─── */}
          <section className="grid grid-cols-2 gap-3">
            <StatusTile
              label="Ready"
              badge={
                ready ? (
                  <StatusBadge kind={ready.status === 'True' ? 'healthy' : 'degraded'}>
                    {ready.status === 'True' ? 'Ready' : (ready.reason ?? 'Not ready')}
                  </StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">—</StatusBadge>
                )
              }
              message={ready?.message}
            />
            <StatusTile
              label="Synced"
              badge={
                synced ? (
                  <StatusBadge kind={synced.status === 'True' ? 'healthy' : 'degraded'}>
                    {synced.status === 'True' ? 'Synced' : (synced.reason ?? 'Out of sync')}
                  </StatusBadge>
                ) : (
                  <StatusBadge kind="unknown">—</StatusBadge>
                )
              }
              message={synced?.message}
            />
          </section>

          {/* ─── Spec ─── */}
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Spec</div>
            </CardHeader>
            <CardBody className="divide-y divide-edge-subtle text-sm">
              <SpecRow
                label="Composition"
                value={
                  (current.spec?.compositionRef as { name?: string } | undefined)?.name ??
                  formatSelector(
                    current.spec?.compositionSelector as { matchLabels?: Record<string, string> } | undefined,
                  ) ??
                  '—'
                }
                mono
              />
              {(config.specFields ?? []).map((f) => (
                <SpecRow
                  key={f.key}
                  label={f.label}
                  value={formatSpecValue(getPath(current.spec, f.key))}
                  mono={f.mono}
                />
              ))}
            </CardBody>
          </Card>

          {/* ─── Connection details ─── */}
          {config.connectionSecret ? (
            <ConnectionSecretSection config={config} xr={current} cluster={cp} />
          ) : null}

          {/* ─── Composed resources ─── */}
          <ComposedResourcesSection xr={current} cluster={cp} />

          {/* ─── Events ─── */}
          <EventsSection xr={current} cluster={cp} />

          {/* ─── All conditions ─── */}
          {current.status?.conditions?.length ? (
            <Card>
              <CardHeader>
                <div className="text-sm font-semibold text-content">Conditions</div>
              </CardHeader>
              <CardBody>
                <ul className="divide-y divide-edge-subtle">
                  {current.status.conditions.map((c) => (
                    <li key={c.type} className="flex items-start gap-3 px-1 py-2 text-sm">
                      <StatusBadge
                        kind={
                          c.status === 'True' && (c.type === 'Ready' || c.type === 'Synced')
                            ? 'healthy'
                            : c.status === 'False'
                              ? 'degraded'
                              : 'info'
                        }
                      >
                        {c.type}
                      </StatusBadge>
                      <div className="min-w-0 flex-1">
                        <div className="text-content">{c.reason ?? c.status}</div>
                        {c.message ? (
                          <div className="mt-0.5 text-xs text-content-muted">{c.message}</div>
                        ) : null}
                        {c.lastTransitionTime ? (
                          <div className="mt-0.5 text-[11px] text-content-subtle">
                            {age(c.lastTransitionTime)} ago
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          ) : null}

          {/* ─── Metadata ─── */}
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Metadata</div>
            </CardHeader>
            <CardBody className="divide-y divide-edge-subtle text-sm">
              <SpecRow label="UID" value={current.metadata.uid ?? '—'} mono />
              <SpecRow label="Created" value={age(current.metadata.creationTimestamp)} />
              <SpecRow
                label="Labels"
                value={renderTags(current.metadata.labels)}
              />
              <SpecRow
                label="Annotations"
                value={renderTags(current.metadata.annotations, 3)}
              />
            </CardBody>
          </Card>

          {/* ─── Raw YAML ─── */}
          <Card>
            <CardHeader>
              <div className="text-sm font-semibold text-content">Raw object</div>
            </CardHeader>
            <CardBody>
              <pre
                className={cn(
                  'max-h-96 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-100',
                )}
              >
                {JSON.stringify(current, null, 2)}
              </pre>
            </CardBody>
          </Card>

          {/* ─── Danger zone: deprovision ─── */}
          {!isGone && !deleting ? (
            <Card>
              <CardHeader>
                <div className="text-sm font-semibold text-rose-700 dark:text-rose-300">
                  Danger zone
                </div>
              </CardHeader>
              <CardBody>
                {!confirmDelete ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-content-muted">
                      Deprovisioning deletes this claim — Crossplane then{' '}
                      <span className="font-semibold text-content">
                        tears down the real backing infrastructure
                      </span>{' '}
                      it composed ({current.status?.resourceRefs?.length ?? 0} composed resource
                      {(current.status?.resourceRefs?.length ?? 0) === 1 ? '' : 's'}). This cannot
                      be undone.
                    </p>
                    {canMutate ? (
                      <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
                        Deprovision
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-md border border-edge-default px-2 py-1 text-[11px] text-content-muted">
                        Deprovision <K8sRolePill perm="crds.write" />
                      </span>
                    )}
                  </div>
                ) : (
                  <div
                    className="rounded-lg border border-rose-200 dark:border-rose-500/25 bg-rose-50/70 dark:bg-rose-500/10 p-3"
                    role="alertdialog"
                    aria-label="Confirm deprovision"
                  >
                    <div className="text-sm font-semibold text-rose-900 dark:text-rose-300">
                      Deprovision this {config.singular.toLowerCase()}?
                    </div>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-content-muted">
                      Deletes the claim{' '}
                      <code className="font-mono">{current.metadata.name}</code>
                      {current.metadata.namespace ? (
                        <>
                          {' '}in <code className="font-mono">{current.metadata.namespace}</code>
                        </>
                      ) : null}
                      . Crossplane will delete every composed resource — databases, buckets, DNS
                      records, whatever this claim provisioned —{' '}
                      <span className="font-semibold text-rose-800 dark:text-rose-300">
                        including their data
                      </span>
                      .
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        value={deleteTyped}
                        onChange={(e) => setDeleteTyped(e.target.value)}
                        placeholder={`Type "${current.metadata.name}" to confirm`}
                        className="h-8 w-full max-w-xs rounded-md border border-edge-default bg-surface-raised px-2 font-mono text-xs text-content outline-none placeholder:text-content-subtle focus:ring-2 focus:ring-rose-500/30"
                        aria-label="Type the claim name to confirm deprovision"
                      />
                      <div className="ml-auto flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setConfirmDelete(false)
                            setDeleteTyped('')
                          }}
                          disabled={deleteMut.isPending}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={deleteTyped !== current.metadata.name || deleteMut.isPending}
                          onClick={() => deleteMut.mutate()}
                        >
                          {deleteMut.isPending ? 'Deleting…' : 'Deprovision'}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </aside>

      {editing ? (
        <ClaimFormModal
          config={config}
          mode="edit"
          initial={current}
          onClose={() => setEditing(false)}
          onApplied={() => {
            setEditing(false)
            onMutated()
            live.refetch()
          }}
        />
      ) : null}
    </div>,
    document.body,
  )
}

/* ───── connection details ───── */

interface SecretObj {
  metadata: { name: string; namespace?: string }
  type?: string
  data?: Record<string, string>
}

/** Resolve the connection Secret's name from config + the live claim. */
function resolveConnectionSecretName(config: XrKindConfig, xr: XR): string | undefined {
  const cfg = config.connectionSecret
  if (!cfg) return undefined
  if (cfg.nameFromSpec) {
    const v = getPath(xr.spec, cfg.nameFromSpec)
    if (typeof v === 'string' && v) return v
  }
  if (cfg.nameTemplate) {
    return cfg.nameTemplate
      .replaceAll('<name>', xr.metadata.name)
      .replaceAll('<namespace>', xr.metadata.namespace ?? '')
  }
  return undefined
}

function ConnectionSecretSection({
  config,
  xr,
  cluster,
}: {
  config: XrKindConfig
  xr: XR
  cluster?: string
}) {
  const canReveal = useHasK8sPermission('secrets.read')
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState<string | null>(null)

  const secretName = resolveConnectionSecretName(config, xr)
  const connRef = xr.spec?.writeConnectionSecretToRef as
    | { name?: string; namespace?: string }
    | undefined
  const secretNs = xr.metadata.namespace ?? connRef?.namespace

  const secretQ = useQuery({
    queryKey: ['platform', 'xr-conn-secret', secretNs ?? '-', secretName ?? '-', cluster ?? '-'],
    enabled: Boolean(secretName && secretNs),
    queryFn: () => kube.get<SecretObj>(GVRS.secrets, secretNs, secretName as string, { cluster }),
    refetchInterval: 15_000,
    retry: false,
  })

  const status = (secretQ.error as { status?: number } | null)?.status
  const secret = secretQ.data
  const keys = Object.keys(secret?.data ?? {}).sort((a, b) => a.localeCompare(b))

  const copyValue = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    } catch {
      /* clipboard unavailable — nothing to surface */
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-content">Connection details</div>
          {secretName ? (
            <code className="text-[11px] font-mono text-content-subtle">{secretName}</code>
          ) : null}
        </div>
      </CardHeader>
      <CardBody>
        {!secretName || !secretNs ? (
          <p className="text-[12px] text-content-muted">
            No connection secret is referenced by this claim yet.
          </p>
        ) : secretQ.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted">
            <Spinner size={14} /> Checking for connection secret…
          </div>
        ) : status === 404 ? (
          <p className="text-[12px] text-content-muted">
            No connection secret yet — Crossplane writes{' '}
            <code className="font-mono">{secretName}</code> once provisioning completes.
          </p>
        ) : status === 403 ? (
          <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-content-muted">
            You aren't permitted to read the connection secret. <K8sRolePill perm="secrets.read" />
          </p>
        ) : secretQ.isError ? (
          <p className="text-[12px] text-rose-700 dark:text-rose-300">
            Couldn't read the connection secret: {(secretQ.error as Error).message}
          </p>
        ) : keys.length === 0 ? (
          <p className="text-[12px] text-content-muted">
            The connection secret exists but has no data keys yet.
          </p>
        ) : (
          <>
            <div
              className="mb-3 rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200"
              role="note"
            >
              Sensitive material — values stay redacted until you reveal them per key. Revealed
              values are visible on screen and copied to your clipboard in plain text.
            </div>
            <ul className="divide-y divide-edge-subtle">
              {keys.map((k) => {
                const raw = secret?.data?.[k] ?? ''
                const isRevealed = Boolean(revealed[k]) && canReveal
                const decoded = isRevealed ? b64Decode(raw) : null
                return (
                  <li key={k} className="space-y-2 px-1 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="font-mono text-xs font-semibold text-content">{k}</code>
                      <div className="flex items-center gap-1.5">
                        {canReveal ? (
                          <Button
                            size="xs"
                            variant={isRevealed ? 'secondary' : 'ghost'}
                            onClick={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}
                            title={isRevealed ? 'Hide the decoded value' : 'Decode and show this value'}
                          >
                            {isRevealed ? 'Hide' : 'Reveal'}
                          </Button>
                        ) : (
                          <K8sRolePill perm="secrets.read" />
                        )}
                        {isRevealed && decoded ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => copyValue(k, decoded.ok ? decoded.text : raw)}
                            title={decoded.ok ? 'Copy decoded value' : 'Copy base64 value (binary content)'}
                          >
                            {copied === k ? 'Copied' : 'Copy'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {isRevealed && decoded ? (
                      <pre className="max-h-40 overflow-auto rounded-lg border border-amber-200/60 dark:border-amber-500/20 bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-content">
                        {decoded.ok ? decoded.text : `${raw}  (binary — showing base64)`}
                      </pre>
                    ) : (
                      <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-2 py-1.5">
                        <span className="font-mono text-xs tracking-widest text-content-subtle">
                          ••••••••••••
                        </span>
                        <span className="text-[10px] text-content-subtle">
                          {Math.ceil((raw.length * 3) / 4)} bytes
                        </span>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  )
}

/* ───── composed resources (with live health) ───── */

interface RefHealth {
  state: StatusKind
  label: string
}

function ComposedResourcesSection({ xr, cluster }: { xr: XR; cluster?: string }) {
  const refs = xr.status?.resourceRefs ?? []

  // One cached discovery pass maps each ref's apiVersion+kind to its plural
  // resource so we can GET it. Best-effort only — never blocks the list.
  const discoveryQ = useQuery({
    queryKey: ['k8s', 'discovery', cluster ?? '-'],
    queryFn: () => kube.discovery({ cluster }),
    staleTime: 300_000,
    retry: false,
    enabled: refs.length > 0,
  })

  const refsKey = refs
    .map((r) => `${r.apiVersion ?? ''}|${r.kind ?? ''}|${r.namespace ?? ''}|${r.name ?? ''}`)
    .join(',')

  const healthQ = useQuery({
    queryKey: ['platform', 'xr-refs-health', xr.metadata.uid ?? xr.metadata.name, refsKey, cluster ?? '-'],
    enabled: refs.length > 0 && Boolean(discoveryQ.data),
    refetchInterval: 15_000,
    retry: false,
    queryFn: async (): Promise<Array<RefHealth | null>> => {
      const resources = discoveryQ.data?.resources ?? []
      // Cap the fan-out so a huge composition can't hammer the apiserver.
      const capped = refs.slice(0, 25)
      const results = await Promise.all(
        capped.map(async (ref): Promise<RefHealth | null> => {
          if (!ref.apiVersion || !ref.kind || !ref.name) return null
          const match = resources.find(
            (r) => !r.subresource && r.kind === ref.kind && r.groupVersion === ref.apiVersion,
          )
          if (!match) return null
          try {
            const obj = await kube.get<XR>(
              { group: match.group, version: match.version, resource: match.name, namespaced: match.namespaced },
              match.namespaced ? (ref.namespace ?? xr.metadata.namespace) : undefined,
              ref.name,
              { cluster },
            )
            if (obj.metadata?.deletionTimestamp) return { state: 'paused', label: 'Deleting' }
            const conds = obj.status?.conditions ?? []
            const cond =
              conds.find((c) => c.type === 'Ready') ??
              conds.find((c) => c.type === 'Healthy') ??
              conds.find((c) => c.type === 'Available') ??
              conds.find((c) => c.type === 'Synced')
            if (!cond) return null // no convention to read — stay honest, show nothing
            if (cond.status === 'True') return { state: 'healthy', label: cond.type }
            if (cond.status === 'False') return { state: 'degraded', label: cond.reason ?? `Not ${cond.type.toLowerCase()}` }
            return { state: 'unknown', label: cond.reason ?? 'Unknown' }
          } catch {
            // RBAC denial / not found / transient — silently omit health.
            return null
          }
        }),
      )
      // Anything past the cap gets no health, honestly.
      return [...results, ...refs.slice(25).map(() => null)]
    },
  })

  if (!refs.length) return null
  const health = healthQ.data ?? []

  return (
    <ComposedResourcesCard
      xr={xr}
      refs={refs}
      health={health}
      fetching={healthQ.isFetching}
      discovery={discoveryQ.data?.resources ?? []}
      cluster={cluster}
    />
  )
}

interface DiscoveryResource {
  group: string
  version: string
  name: string
  kind: string
  groupVersion: string
  namespaced: boolean
  subresource?: boolean
}

/** Resolve a composed-resource ref to its GVR via the discovery map. */
function resolveRefGvr(
  ref: ResourceRef,
  discovery: DiscoveryResource[],
): { gvr: k8s.GVR; namespace?: string } | null {
  const match = discovery.find(
    (r) => !r.subresource && r.kind === ref.kind && r.groupVersion === ref.apiVersion,
  )
  if (!match) return null
  return {
    gvr: { group: match.group, version: match.version, resource: match.name, namespaced: match.namespaced },
    namespace: match.namespaced ? ref.namespace : undefined,
  }
}

/**
 * Composed-resources card with a Graph ⇄ List toggle. The graph is a live
 * composition topology (the composite → every managed resource it created,
 * coloured by real health); the list is the compact per-resource breakdown.
 * Both read the same discovered health data, so the toggle is free.
 */
function ComposedResourcesCard({
  xr,
  refs,
  health,
  fetching,
  discovery,
  cluster,
}: {
  xr: XR
  refs: ResourceRef[]
  health: Array<RefHealth | null>
  fetching: boolean
  discovery: DiscoveryResource[]
  cluster?: string
}) {
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const [selected, setSelected] = useState<number | null>(null)
  const toggle = (i: number) => setSelected((s) => (s === i ? null : i))
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-content">Composed resources</div>
            <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-subtle">
              {refs.length}
            </span>
            {fetching ? <Spinner size={11} /> : null}
          </div>
          <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-raised p-0.5 text-[11px] font-medium">
            {(['graph', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-md px-2.5 py-1 capitalize transition-colors',
                  view === v
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'text-content-muted hover:bg-surface-sunken hover:text-content',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {view === 'graph' ? (
          <CompositionGraph xr={xr} refs={refs} health={health} selected={selected} onSelect={toggle} />
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {refs.map((r, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-1.5 py-2 text-left text-sm transition-colors hover:bg-surface-sunken',
                    selected === i && 'bg-surface-sunken ring-1 ring-inset ring-brand-500/25',
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-content">
                      {r.kind}/{r.name}
                    </div>
                    <div className="text-[11px] font-mono text-content-muted">
                      {r.apiVersion}
                      {r.namespace ? ` · ${r.namespace}` : ''}
                    </div>
                  </div>
                  {health[i] ? (
                    <StatusBadge kind={health[i]!.state}>{health[i]!.label}</StatusBadge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected != null && refs[selected] ? (
          <ComposedResourceInspector
            refItem={refs[selected]}
            discovery={discovery}
            cluster={cluster}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </CardBody>
    </Card>
  )
}

/**
 * Live inspector for one composed (managed) resource — fetched on demand
 * through the per-user gateway. Shows real conditions, key status fields, age,
 * and the exact GVR. Honest states: RBAC-denied / not-found / unresolvable GVR
 * each say so rather than guessing.
 */
function ComposedResourceInspector({
  refItem,
  discovery,
  cluster,
  onClose,
}: {
  refItem: ResourceRef
  discovery: DiscoveryResource[]
  cluster?: string
  onClose(): void
}) {
  const resolved = useMemo(() => resolveRefGvr(refItem, discovery), [refItem, discovery])

  const q = useQuery({
    queryKey: [
      'platform',
      'composed-inspect',
      cluster ?? '-',
      refItem.apiVersion,
      refItem.kind,
      refItem.namespace ?? '',
      refItem.name,
    ],
    enabled: Boolean(resolved && refItem.name),
    refetchInterval: 15_000,
    retry: false,
    queryFn: () =>
      kube.get<XR>(resolved!.gvr, resolved!.namespace, refItem.name!, { cluster }) as Promise<XR>,
  })

  const obj = q.data
  const conds = obj?.status?.conditions ?? []

  return (
    <div className="mt-3 rounded-lg border border-brand-200 dark:border-brand-500/25 bg-brand-50/40 dark:bg-brand-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-content">
            {refItem.kind}/{refItem.name}
          </div>
          <div className="truncate text-[11px] font-mono text-content-subtle">
            {refItem.apiVersion}
            {refItem.namespace ? ` · ${refItem.namespace}` : ''}
            {obj?.metadata?.creationTimestamp ? ` · ${age(obj.metadata.creationTimestamp)}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="shrink-0 rounded-md p-1 text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
        >
          <IconClose />
        </button>
      </div>

      {!resolved ? (
        <p className="mt-2 text-[12px] text-content-muted">
          This resource type isn’t discoverable on the cluster (no matching served API), so it
          can’t be inspected here.
        </p>
      ) : q.isLoading ? (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-content-muted">
          <Spinner size={12} /> loading…
        </div>
      ) : q.isError ? (
        <p className="mt-2 text-[12px] text-content-muted">
          Couldn’t read this resource ({(q.error as { status?: number })?.status === 403
            ? 'not authorized'
            : (q.error as { status?: number })?.status === 404
              ? 'not found — it may still be provisioning'
              : 'unavailable'}
          ).
        </p>
      ) : conds.length ? (
        <ul className="mt-2 space-y-1.5">
          {conds.map((c, i) => (
            <li key={i} className="flex items-start justify-between gap-3 text-[12px]">
              <div className="min-w-0">
                <span className="font-medium text-content">{c.type}</span>
                {c.reason ? (
                  <span className="ml-1.5 font-mono text-[11px] text-content-subtle">{c.reason}</span>
                ) : null}
                {c.message ? (
                  <div className="truncate text-[11px] text-content-muted" title={c.message}>
                    {c.message}
                  </div>
                ) : null}
              </div>
              {conditionBadge(c)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-content-muted">
          No conditions reported yet — this resource doesn’t publish status conditions.
        </p>
      )}
    </div>
  )
}

interface ResourceRef {
  apiVersion?: string
  kind?: string
  name?: string
  namespace?: string
}

/** Health-state → a concrete colour usable in SVG (theme-agnostic, legible on both). */
function refStateColor(state: RefHealth['state'] | undefined): string {
  switch (state) {
    case 'healthy':
      return '#10b981'
    case 'degraded':
      return '#f43f5e'
    case 'unknown':
      return '#f59e0b'
    case 'paused':
      return '#64748b'
    default:
      return '#94a3b8'
  }
}

/**
 * Live composition topology. The composite sits at the left; each managed
 * resource it created fans out on the right, connected by a curved edge and
 * coloured by its real health. Nodes are theme-aware HTML (absolute-positioned)
 * over an SVG edge layer, so it reads correctly in light + dark. Horizontally
 * scrolls on narrow drawers; caps at 25 nodes like the underlying health query.
 */
function CompositionGraph({
  xr,
  refs,
  health,
  selected,
  onSelect,
}: {
  xr: XR
  refs: ResourceRef[]
  health: Array<RefHealth | null>
  selected?: number | null
  onSelect?: (i: number) => void
}) {
  const shown = refs.slice(0, 25)
  const rowH = 54
  const nodeW = 208
  const nodeH = 42
  const rootX = 4
  const childX = 272
  const width = childX + nodeW + 4
  const height = Math.max(shown.length * rowH + 12, nodeH + 24)
  const rootMidY = height / 2
  const rootReady = findCondition(xr, 'Ready')
  const rootState: RefHealth['state'] =
    rootReady?.status === 'True' ? 'healthy' : rootReady?.status === 'False' ? 'degraded' : 'unknown'

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0" width={width} height={height} aria-hidden>
          {shown.map((_, i) => {
            const cy = i * rowH + 6 + nodeH / 2
            const x1 = rootX + nodeW
            const x2 = childX
            const mx = (x1 + x2) / 2
            return (
              <path
                key={i}
                d={`M${x1},${rootMidY} C${mx},${rootMidY} ${mx},${cy} ${x2},${cy}`}
                fill="none"
                stroke={refStateColor(health[i]?.state)}
                strokeWidth={1.5}
                strokeOpacity={0.65}
              />
            )
          })}
        </svg>
        <GraphNode
          left={rootX}
          top={rootMidY - nodeH / 2}
          width={nodeW}
          kind={xr.kind}
          name={xr.metadata.name}
          state={rootState}
          label={rootReady?.status === 'True' ? 'Ready' : rootReady?.reason ?? 'Reconciling'}
          root
        />
        {shown.map((r, i) => (
          <GraphNode
            key={i}
            left={childX}
            top={i * rowH + 6}
            width={nodeW}
            kind={r.kind ?? '—'}
            name={r.name ?? '—'}
            sub={r.apiVersion}
            state={health[i]?.state}
            label={health[i]?.label}
            selected={selected === i}
            onClick={onSelect ? () => onSelect(i) : undefined}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge-subtle pt-2.5">
        {([
          ['healthy', 'Healthy'],
          ['degraded', 'Degraded'],
          ['unknown', 'Unknown'],
          ['paused', 'Deleting'],
        ] as const).map(([state, label]) => {
          const count = health.filter((h) => h?.state === state).length
          if (count === 0) return null
          return (
            <span key={state} className="inline-flex items-center gap-1.5 text-[11px] text-content-muted">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: refStateColor(state) }} />
              {count} {label.toLowerCase()}
            </span>
          )
        })}
        {refs.length > shown.length ? (
          <span className="text-[11px] text-content-subtle">+{refs.length - shown.length} more not shown</span>
        ) : null}
      </div>
    </div>
  )
}

function GraphNode({
  left,
  top,
  width,
  kind,
  name,
  sub,
  state,
  label,
  root,
  selected,
  onClick,
}: {
  left: number
  top: number
  width: number
  kind: string
  name: string
  sub?: string
  state?: RefHealth['state']
  label?: string
  root?: boolean
  selected?: boolean
  onClick?: () => void
}) {
  const color = refStateColor(state)
  const cls = cn(
    'absolute flex flex-col justify-center gap-0.5 rounded-lg border bg-surface-raised px-2.5 py-1.5 text-left shadow-sm transition-shadow',
    root ? 'border-brand-300 dark:border-brand-500/40 ring-1 ring-brand-500/20' : 'border-edge-default',
    onClick && 'cursor-pointer hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-500',
    selected && 'ring-2 ring-brand-500/50',
  )
  const style = { left, top, width, borderLeftColor: color, borderLeftWidth: 3 } as const
  const title = `${kind}/${name}${label ? ` · ${label}` : ''}`
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate text-xs font-semibold text-content">{name}</span>
      </div>
      <div className="truncate pl-3 text-[10px] font-mono text-content-subtle">
        {root ? 'composite · ' : ''}
        {kind}
        {sub ? ` · ${sub.split('/').pop()}` : ''}
      </div>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className={cls} style={style} title={title} aria-pressed={selected}>
      {inner}
    </button>
  ) : (
    <div className={cls} style={style} title={title}>
      {inner}
    </div>
  )
}

/* ───── events ───── */

interface KubeEventObj {
  metadata: { name: string; namespace?: string; uid?: string; creationTimestamp?: string }
  type?: string
  reason?: string
  message?: string
  count?: number
  firstTimestamp?: string
  lastTimestamp?: string
  eventTime?: string
  source?: { component?: string }
  reportingComponent?: string
}

function eventTime(e: KubeEventObj): string | undefined {
  return e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp
}

function EventsSection({ xr, cluster }: { xr: XR; cluster?: string }) {
  const name = xr.metadata.name
  const ns = xr.metadata.namespace
  const selector = [
    `involvedObject.name=${name}`,
    ...(xr.metadata.uid ? [`involvedObject.uid=${xr.metadata.uid}`] : []),
  ].join(',')

  const eventsQ = useQuery({
    queryKey: ['platform', 'xr-events', ns ?? '-', name, xr.metadata.uid ?? '-', cluster ?? '-'],
    // Namespaced claims → the claim's namespace. Cluster-scoped XRs → search
    // events across all namespaces (the apiserver records them in one).
    queryFn: () =>
      kube
        .list<KubeEventObj>(GVRS.events, { namespace: ns, fieldSelector: selector, cluster })
        .then((l) => l.items),
    refetchInterval: 15_000,
    retry: false,
  })

  const events = useMemo(
    () =>
      [...(eventsQ.data ?? [])].sort((a, b) => {
        const ta = eventTime(a) ?? ''
        const tb = eventTime(b) ?? ''
        return tb.localeCompare(ta) // newest first
      }),
    [eventsQ.data],
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-content">Events</div>
          {events.length ? (
            <span className="text-xs text-content-subtle">{events.length}</span>
          ) : null}
        </div>
      </CardHeader>
      <CardBody>
        {eventsQ.isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted">
            <Spinner size={14} /> Loading events…
          </div>
        ) : eventsQ.isError ? (
          <p className="text-[12px] text-content-muted">
            Couldn't load events: {(eventsQ.error as Error).message}
          </p>
        ) : !events.length ? (
          <p className="text-[12px] text-content-muted">No events recorded for this resource.</p>
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {events.map((e) => (
              <li key={e.metadata.uid ?? e.metadata.name} className="flex items-start gap-3 px-1 py-2 text-sm">
                <StatusBadge kind={e.type === 'Warning' ? 'degraded' : 'info'}>
                  {e.reason ?? e.type ?? 'Event'}
                </StatusBadge>
                <div className="min-w-0 flex-1">
                  <div className="break-words text-xs text-content">{e.message ?? '—'}</div>
                  <div className="mt-0.5 text-[11px] text-content-subtle">
                    {eventTime(e) ? `${age(eventTime(e))} ago` : ''}
                    {e.count && e.count > 1 ? ` · ×${e.count}` : ''}
                    {e.source?.component || e.reportingComponent
                      ? ` · ${e.source?.component ?? e.reportingComponent}`
                      : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  )
}

/* ───── helpers + atoms ───── */

function conditionBadge(xr: XR, type: 'Ready' | 'Synced') {
  const c = findCondition(xr, type)
  if (!c) return <StatusBadge kind="unknown">—</StatusBadge>
  const kind: StatusKind = c.status === 'True' ? 'healthy' : c.status === 'False' ? 'degraded' : 'info'
  return (
    <div title={c.message} className="inline-flex">
      <StatusBadge kind={kind}>{c.status === 'True' ? type : (c.reason ?? type)}</StatusBadge>
    </div>
  )
}

function findCondition(xr: XR, type: string) {
  return (xr.status?.conditions ?? []).find((c) => c.type === type)
}

function formatSelector(
  sel: { matchLabels?: Record<string, string> } | undefined,
): string | undefined {
  if (!sel?.matchLabels) return undefined
  const pairs = Object.entries(sel.matchLabels)
  if (!pairs.length) return undefined
  return pairs.map(([k, v]) => `${k}=${v}`).join(',')
}

function formatSpecValue(v: unknown): React.ReactNode {
  if (v === undefined || v === null) return '—'
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  return (
    <code className="font-mono text-xs">{JSON.stringify(v)}</code>
  )
}

function renderTags(map: Record<string, string> | undefined, max = 6) {
  if (!map) return <span className="text-content-subtle">—</span>
  const entries = Object.entries(map)
  if (!entries.length) return <span className="text-content-subtle">—</span>
  const shown = entries.slice(0, max)
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {shown.map(([k, v]) => (
        <code
          key={k}
          title={`${k}=${v}`}
          className="max-w-[20rem] truncate rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-content-muted"
        >
          {k}={v}
        </code>
      ))}
      {entries.length > max ? (
        <span className="text-[11px] text-content-subtle">+{entries.length - max}</span>
      ) : null}
    </div>
  )
}

function StatusTile({
  label,
  badge,
  message,
}: {
  label: string
  badge: React.ReactNode
  message?: string
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">
          {label}
        </div>
        {badge}
      </div>
      {message ? (
        <div className="mt-2 line-clamp-3 text-xs text-content-muted">{message}</div>
      ) : null}
    </div>
  )
}

function SpecRow({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-content-subtle">
        {label}
      </span>
      <span className={cn('text-right text-sm text-content', mono && 'font-mono text-xs')}>
        {value}
      </span>
    </div>
  )
}

function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
