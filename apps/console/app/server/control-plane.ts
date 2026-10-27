/**
 * Tenancy THROUGH the control plane.
 *
 * An organisation or team created from the console's switcher used to be a
 * row in the console's store plus a handful of imperative calls — a Keycloak
 * group, a namespace and role bindings, a Gitea organisation — made by the
 * console itself. The platform already describes exactly that as Crossplane
 * XRs: `Organisation` composes the home namespace, its quota, the role
 * bindings for the console's groups and the Gitea organisation; `Team`
 * composes the Keycloak group and the Gitea team (platform/controlplane,
 * ADR-0026). Two writers for one set of objects is drift waiting to happen, so
 * the console now declares the XR and lets the control plane do the work —
 * and every tenant it already created is back-filled as an XR the first time
 * it is listed, so "Adhar Resources" shows all of them.
 *
 * Server-side apply with the console's own ServiceAccount: idempotent, so
 * re-applying an existing tenant is a no-op, and field-managed, so a hand
 * edit elsewhere is reported as a conflict rather than silently overwritten
 * (`force` is deliberately NOT set).
 */
import { apiServerFetch } from './k8s/gateway.ts'
import { getK8sServiceToken } from './tool-registry.ts'

export const PLATFORM_API_VERSION = 'platform.adhar.io/v1alpha1'
/** Where the hierarchy XRs live — the examples and the platform agree on this. */
export const TENANCY_NAMESPACE = 'adhar-system'
const FIELD_MANAGER = 'adhar-console'
/** Marks the XRs this console declares, so it never adopts anyone else's. */
export const MANAGED_BY_LABEL = 'adhar.io/managed-by'

export interface XrManifest {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace: string; labels: Record<string, string> }
  spec: { parameters: Record<string, unknown> }
}

const slugRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function assertSlug(kind: string, slug: string): void {
  if (!slugRe.test(slug)) throw new Error(`${kind} name ${JSON.stringify(slug)} is not a DNS-1123 label`)
}

/** The Organisation XR for a console organisation. */
export function organisationManifest(org: { slug: string; name: string; description?: string }): XrManifest {
  assertSlug('Organisation', org.slug)
  const parameters: Record<string, unknown> = {
    name: org.slug,
    displayName: org.name,
    // The tenant's repositories live in Gitea under the organisation.
    createGiteaOrganisation: true,
  }
  if (org.description?.trim()) parameters.description = org.description.trim()
  return {
    apiVersion: PLATFORM_API_VERSION,
    kind: 'Organisation',
    metadata: {
      name: org.slug,
      namespace: TENANCY_NAMESPACE,
      labels: { [MANAGED_BY_LABEL]: FIELD_MANAGER, 'adhar.io/organisation': org.slug },
    },
    spec: { parameters },
  }
}

/** The Team XR for a console team, inside the organisation the caller is working in. */
export function teamManifest(
  team: { slug: string; name: string; description?: string },
  organisationSlug: string,
): XrManifest {
  assertSlug('Team', team.slug)
  assertSlug('Organisation', organisationSlug)
  const parameters: Record<string, unknown> = {
    name: team.slug,
    organisation: organisationSlug,
    displayName: team.name,
  }
  if (team.description?.trim()) parameters.description = team.description.trim()
  return {
    apiVersion: PLATFORM_API_VERSION,
    kind: 'Team',
    metadata: {
      // Team names are unique within an organisation but XRs share one
      // namespace, so the organisation prefixes the object name.
      name: `${organisationSlug}-${team.slug}`.slice(0, 63).replace(/-+$/, ''),
      namespace: TENANCY_NAMESPACE,
      labels: {
        [MANAGED_BY_LABEL]: FIELD_MANAGER,
        'adhar.io/organisation': organisationSlug,
        'adhar.io/team': team.slug,
      },
    },
    spec: { parameters },
  }
}

export interface ApplyOutcome {
  ok: boolean
  status: number
  detail: string
}

/** The REST path of an XR: `/apis/<group>/<version>/namespaces/<ns>/<plural>/<name>`. */
/** The project every scaffold lands in unless the template asks otherwise — the platform's own. */
export const DEFAULT_PROJECT = 'adhar'

/**
 * A deployable inside a project (ADR-0026). The control plane composes its
 * Argo CD Applications, Kargo Warehouse and Stages from this one object; the
 * console never writes those itself.
 */
/** Dashboard templates the Application composition knows (apps.xrd.yaml enum). */
export const DASHBOARD_TYPES = ['backend-jvm', 'backend-generic', 'frontend', 'fullstack'] as const
export type DashboardType = (typeof DASHBOARD_TYPES)[number]

/**
 * The dashboard template a Software Template declares in
 * `metadata.labels["adhar.io/dashboard-type"]`. Without it on the XR the
 * composition falls back to `backend-generic`, so every Spring Boot service
 * scaffolded from the console lost its JVM, Hikari and Kafka panels
 * (2026-10-23). Unknown values are ignored rather than passed on.
 */
export function dashboardTypeOf(templateDoc: unknown): DashboardType | undefined {
  const labels = (templateDoc as { metadata?: { labels?: Record<string, unknown> } } | null)?.metadata?.labels
  const v = labels?.['adhar.io/dashboard-type']
  return typeof v === 'string' && (DASHBOARD_TYPES as readonly string[]).includes(v) ? (v as DashboardType) : undefined
}

/**
 * The application `type` (apps.xrd.yaml) a template's dashboard type implies:
 * a browser app — a SPA (`frontend`) or TanStack Start (`fullstack`, a browser
 * app with a server of its own) — is `web`; anything else keeps the XRD's
 * default, `service`. `web` runs exactly like `service` (only `ai` changes
 * placement): it is the platform's word for "this has pages", read by the
 * composition's dashboard inference and by the Visual Designer's list of apps
 * to open. Until 2026-10-27 every console-scaffolded React app was a `service`.
 *
 * A function template's app is `function` whatever its dashboard says: the
 * Application composition then deploys a Function XR per environment from
 * `deploy/envs/<env>` (Knative, scale-to-zero) instead of a Rollout.
 */
export function applicationTypeOf(
  dashboardType: DashboardType | undefined,
  workload?: Workload,
): 'web' | 'function' | undefined {
  if (workload === 'function') return 'function'
  return dashboardType === 'frontend' || dashboardType === 'fullstack' ? 'web' : undefined
}

/** What a scaffolded application deploys, when it is not an ordinary container service. */
export type Workload = 'function'

/**
 * Says what an Application deploys (`function`), so lists — Develop →
 * Functions among them — can tell a function app apart from a service. A
 * label, like the dashboard type, so it survives a control plane whose XRD
 * still refuses `type: function` (applyApplication drops `type` there).
 */
export const WORKLOAD_LABEL = 'adhar.io/workload'

export function applicationManifest(
  app: { name: string; project: string; repoUrl: string; path?: string; dashboardType?: DashboardType; workload?: Workload },
): XrManifest {
  const type = applicationTypeOf(app.dashboardType, app.workload)
  return {
    apiVersion: PLATFORM_API_VERSION,
    kind: 'Application',
    metadata: {
      name: app.name,
      namespace: TENANCY_NAMESPACE,
      labels: {
        [MANAGED_BY_LABEL]: 'adhar-console',
        'adhar.io/project': app.project,
        'adhar.io/application': app.name,
        'adhar.io/scaffolded': 'true',
        // A label rather than spec.parameters.dashboard: it is accepted by an
        // older, strict XRD too, and the composition reads it second.
        ...(app.dashboardType ? { 'adhar.io/dashboard-type': app.dashboardType } : {}),
        ...(app.workload ? { [WORKLOAD_LABEL]: app.workload } : {}),
      },
    },
    spec: {
      parameters: {
        project: app.project,
        displayName: app.name,
        ...(type ? { type } : {}),
        source: { repoURL: app.repoUrl, path: app.path ?? 'deploy', targetRevision: 'main' },
      },
    },
  }
}

/**
 * Apply an Application XR. `spec.parameters.type` reached the XRD on
 * 2026-10-07; a control plane older than that refuses the whole object
 * (server-side apply: "failed to create typed patch object …
 * .spec.parameters.type: field not declared in schema", HTTP 500) and the app
 * would get no Application at all. So that one refusal is retried without the
 * field — the adhar.io/dashboard-type label still says what the app is.
 *
 * The same retry covers a control plane whose `type` enum predates `function`
 * ("spec.parameters.type: Unsupported value: \"function\"", HTTP 422): the app
 * is created as a default `service` and the adhar.io/workload label keeps
 * saying it is a function.
 */
export async function applyApplication(m: XrManifest, token: string | undefined = getK8sServiceToken()): Promise<ApplyOutcome> {
  const out = await applyXr(m, token)
  if (out.ok || !('type' in m.spec.parameters) || !/parameters\.type\b/.test(out.detail)) return out
  const { type: _type, ...parameters } = m.spec.parameters
  return applyXr({ ...m, spec: { ...m.spec, parameters } }, token)
}

export function xrPath(m: XrManifest): string {
  return `${xrCollectionPath(m)}/${m.metadata.name}`
}

/** The REST path of the collection an XR belongs to. */
export function xrCollectionPath(m: Pick<XrManifest, 'apiVersion' | 'kind' | 'metadata'>): string {
  const [group, version] = m.apiVersion.split('/')
  const plural = `${m.kind.toLowerCase()}s`
  return `/apis/${group}/${version}/namespaces/${m.metadata.namespace}/${plural}`
}

/* ── an XR is identified by what it composes, not by its object name ── */

/**
 * The Team composition derives the Keycloak group (`ws-team-<name>`) and the
 * Gitea team from `spec.parameters`, so two XRs carrying the same parameters
 * compose the SAME external objects under two owners — whatever they are
 * called. The platform declares its own tenancy that way (the `adhar-supply-chain`
 * package seeds `Organisation/adhar` and `Team/platform`, named by the bare
 * slug), so the console must look for an existing XR by its parameters before
 * it writes one of its own.
 */
export type XrTarget =
  | { action: 'apply'; name: string; adopted: boolean }
  | { action: 'skip'; name: string; reason: string }

/** Does this existing XR compose what the manifest asks for? */
function sameSubject(m: XrManifest, parameters: Record<string, unknown> | undefined): boolean {
  // Only tenancy kinds are identified by a `name` PARAMETER. Every other kind
  // (Application, Database, …) is identified by its object name alone: an
  // Application has no `parameters.name`, so `undefined === undefined` made
  // EVERY existing Application "the same subject", and each new scaffold was
  // written over the first one — reactapp ended up pointing at my-service's
  // repository and ngapp/my-service never got an Application (GCP, 2026-10-21).
  if (m.kind !== 'Organisation' && m.kind !== 'Team') return false
  if (!parameters) return false
  const wanted = m.spec.parameters.name
  if (typeof wanted !== 'string' || !wanted) return false
  if (parameters.name !== wanted) return false
  // A team's identity is (organisation, name); an organisation's is its name.
  if (m.kind === 'Team') return parameters.organisation === m.spec.parameters.organisation
  return true
}

interface XrListItem {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: { parameters?: Record<string, unknown> }
}

/**
 * Decide what to write. An XR someone else declares — the platform's own
 * tenancy, reconciled by Argo CD — is left alone: applying over it would
 * either fight for field ownership every ten minutes or, under a different
 * object name, stand up a duplicate owner for one Keycloak group. When the
 * lookup itself cannot be done (no CRD, no permission, no cluster) the
 * manifest's own name is used, which is what the console did before.
 */
export async function resolveXrTarget(
  m: XrManifest,
  token: string | undefined = getK8sServiceToken(),
): Promise<XrTarget> {
  if (!token) return { action: 'apply', name: m.metadata.name, adopted: false }
  let items: XrListItem[]
  try {
    const res = await apiServerFetch(token, xrCollectionPath(m))
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { action: 'apply', name: m.metadata.name, adopted: false }
    }
    items = ((await res.json()) as { items?: XrListItem[] }).items ?? []
  } catch {
    return { action: 'apply', name: m.metadata.name, adopted: false }
  }
  const match = items.find((it) => sameSubject(m, it.spec?.parameters))
  if (!match?.metadata?.name) return { action: 'apply', name: m.metadata.name, adopted: false }
  const name = match.metadata.name
  if (match.metadata.labels?.[MANAGED_BY_LABEL] !== FIELD_MANAGER) {
    return { action: 'skip', name, reason: `${m.kind}/${name} is already declared by the platform` }
  }
  return { action: 'apply', name, adopted: name !== m.metadata.name }
}

/**
 * Server-side apply the manifest as the console. Never throws: provisioning
 * reports the outcome as a step, and a backfill logs it.
 */
export async function applyXr(m: XrManifest, token: string | undefined = getK8sServiceToken()): Promise<ApplyOutcome> {
  if (!token) return { ok: false, status: 0, detail: 'console ServiceAccount token unavailable' }
  const target = await resolveXrTarget(m, token)
  // Already declared elsewhere: the subject exists, which is what the caller
  // wanted, so this is a success that wrote nothing.
  if (target.action === 'skip') return { ok: true, status: 0, detail: target.reason }
  const manifest: XrManifest = target.name === m.metadata.name ? m : { ...m, metadata: { ...m.metadata, name: target.name } }
  try {
    const res = await apiServerFetch(token, xrPath(manifest), {
      method: 'PATCH',
      search: `?fieldManager=${FIELD_MANAGER}`,
      headers: { 'content-type': 'application/apply-patch+yaml' },
      body: JSON.stringify(manifest),
    })
    const text = await res.text().catch(() => '')
    if (res.ok) return { ok: true, status: res.status, detail: `${manifest.kind}/${manifest.metadata.name} applied` }
    let reason = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { message?: string }
      if (parsed.message) reason = parsed.message.slice(0, 300)
    } catch {
      /* not JSON — keep the raw body */
    }
    return { ok: false, status: res.status, detail: reason || `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) }
  }
}

/* ── backfill: tenants that predate the control plane become XRs when listed ── */

const BACKFILL_TTL_MS = 10 * 60_000
const ensured = new Map<string, number>()

function due(key: string): boolean {
  const at = ensured.get(key)
  return at === undefined || Date.now() - at > BACKFILL_TTL_MS
}

/**
 * Apply the XRs for tenants the console already knows, at most once per
 * ten minutes per object, without holding up the request that triggered it.
 * A missing CRD (platform without the control plane) or a denied write is
 * logged once per object per window and never surfaces to the caller.
 */
export function backfillXrs(manifests: XrManifest[]): void {
  const pending = manifests.filter((m) => due(`${m.kind}/${m.metadata.name}`))
  if (pending.length === 0) return
  for (const m of pending) ensured.set(`${m.kind}/${m.metadata.name}`, Date.now())
  void (async () => {
    for (const m of pending) {
      const out = await applyXr(m)
      if (!out.ok) {
        console.warn(`[control-plane] backfill of ${m.kind}/${m.metadata.name} failed: ${out.detail}`)
      }
    }
  })()
}

/** Test seam: forget what has been back-filled. */
export function resetBackfillMemo(): void {
  ensured.clear()
}
