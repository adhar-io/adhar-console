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
 * The Team composition derives the team's Keycloak group name and the Gitea
 * team from `spec.parameters` — the group is `ws-team-<organisation>.<name>`
 * (it was `ws-team-<name>` until the platform qualified it by organisation;
 * the console fills the group, the composition only publishes its name on
 * `status.group`) — so two XRs carrying the same parameters compose the SAME
 * external objects under two owners, whatever they are called. The platform
 * declares its own tenancy that way (the `adhar-supply-chain` package seeds
 * `Organisation/adhar` and `Team/platform`, named by the bare slug), so the
 * console must look for an existing XR by its parameters before it writes one
 * of its own.
 */
export type XrTarget =
  | { action: 'apply'; name: string; adopted: boolean }
  | { action: 'skip'; name: string; reason: string }
  /** The name is held by an XR of a DIFFERENT subject: never write or delete it. */
  | { action: 'refuse'; name: string; reason: string }

const isTenancyKind = (m: Pick<XrManifest, 'kind'>) => m.kind === 'Organisation' || m.kind === 'Team'

/**
 * A Team's object name is `<org>-<team>`, which is not unique: (acme, x-y) and
 * (acme-x, y) both make `acme-x-y`. When that name is already another team's,
 * this one is written under `<org>-<team>-<hash of (org, team)>` instead —
 * deterministic, so its next apply and its delete find the same object (they
 * look it up by parameters first anyway).
 */
export function disambiguatedTeamName(m: XrManifest): string {
  const key = `${m.spec.parameters.organisation}\u0000${m.spec.parameters.name}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const base = m.metadata.name.slice(0, 63 - 7).replace(/-+$/, '')
  return `${base}-${h.toString(16).padStart(8, '0').slice(0, 6)}`
}

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
      return await ownName(m, token)
    }
    items = ((await res.json()) as { items?: XrListItem[] }).items ?? []
  } catch {
    return await ownName(m, token)
  }
  const match = items.find((it) => sameSubject(m, it.spec?.parameters))
  if (!match?.metadata?.name) {
    // Nothing composes this subject yet. Its own name may still be taken —
    // by ANOTHER organisation's team (see disambiguatedTeamName): writing
    // there would rewrite that team's parameters under the same field manager.
    const taken = (name: string) => items.some((it) => it.metadata?.name === name)
    if (!isTenancyKind(m) || !taken(m.metadata.name)) return { action: 'apply', name: m.metadata.name, adopted: false }
    const alt = m.kind === 'Team' ? disambiguatedTeamName(m) : ''
    if (alt && !taken(alt)) return { action: 'apply', name: alt, adopted: false }
    return { action: 'refuse', name: m.metadata.name, reason: `${m.kind}/${m.metadata.name} belongs to a different ${m.kind.toLowerCase()}` }
  }
  const name = match.metadata.name
  if (match.metadata.labels?.[MANAGED_BY_LABEL] !== FIELD_MANAGER) {
    return { action: 'skip', name, reason: `${m.kind}/${name} is already declared by the platform` }
  }
  return { action: 'apply', name, adopted: name !== m.metadata.name }
}

/**
 * The manifest's own name, when the collection could not be listed (no CRD,
 * no permission). For a tenancy kind the one object at that name is still
 * read: if it composes something else, it is refused rather than overwritten
 * or deleted. Anything the read cannot settle keeps the old behaviour.
 */
async function ownName(m: XrManifest, token: string): Promise<XrTarget> {
  const own: XrTarget = { action: 'apply', name: m.metadata.name, adopted: false }
  if (!isTenancyKind(m)) return own
  try {
    const got = await apiServerFetch(token, xrPath(m))
    if (!got.ok) {
      await got.body?.cancel().catch(() => {})
      return own
    }
    const obj = (await got.json()) as XrListItem
    if (sameSubject(m, obj.spec?.parameters)) return own
    return { action: 'refuse', name: m.metadata.name, reason: `${m.kind}/${m.metadata.name} belongs to a different ${m.kind.toLowerCase()}` }
  } catch {
    return own
  }
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
  // Its name holds someone else's subject: writing would rewrite theirs.
  if (target.action === 'refuse') return { ok: false, status: 409, detail: target.reason }
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

/**
 * Delete an XR the CONSOLE declared — a team deleted in Workspace settings. An
 * XR the platform declares (or anyone else's: no `adhar.io/managed-by:
 * adhar-console`) is left in place and reported as such. An absent XR is
 * already the end state. Never throws.
 */
export async function deleteConsoleXr(m: XrManifest, token: string | undefined = getK8sServiceToken()): Promise<ApplyOutcome> {
  if (!token) return { ok: false, status: 0, detail: 'console ServiceAccount token unavailable' }
  const target = await resolveXrTarget(m, token)
  if (target.action === 'skip') return { ok: true, status: 0, detail: `${target.reason} — left in place` }
  // Nothing at our name is ours to delete.
  if (target.action === 'refuse') return { ok: true, status: 0, detail: `${target.reason} — left in place` }
  const path = xrPath({ ...m, metadata: { ...m.metadata, name: target.name } })
  try {
    const got = await apiServerFetch(token, path)
    if (got.status === 404) {
      await got.body?.cancel().catch(() => {})
      return { ok: true, status: 404, detail: `${m.kind}/${target.name} does not exist` }
    }
    if (!got.ok) {
      await got.body?.cancel().catch(() => {})
      return { ok: false, status: got.status, detail: `reading ${m.kind}/${target.name} failed (HTTP ${got.status})` }
    }
    const obj = (await got.json()) as XrListItem
    if (obj.metadata?.labels?.[MANAGED_BY_LABEL] !== FIELD_MANAGER) {
      return { ok: true, status: 0, detail: `${m.kind}/${target.name} is not declared by the console — left in place` }
    }
    // The label says the console made it — but maybe for another team whose
    // name collides with this one's. Only the subject's own XR is deleted.
    if (isTenancyKind(m) && !sameSubject(m, obj.spec?.parameters)) {
      return { ok: true, status: 0, detail: `${m.kind}/${target.name} belongs to a different ${m.kind.toLowerCase()} — left in place` }
    }
    const res = await apiServerFetch(token, path, { method: 'DELETE' })
    await res.body?.cancel().catch(() => {})
    ensured.delete(`${m.kind}/${m.metadata.name}`)
    if (res.ok || res.status === 404) return { ok: true, status: res.status, detail: `${m.kind}/${target.name} deleted` }
    return { ok: false, status: res.status, detail: `deleting ${m.kind}/${target.name} failed (HTTP ${res.status})` }
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** A Team XR as the console needs it: which team of which organisation, and its published group. */
export interface TeamXrSummary {
  organisation: string
  name: string
  /** `status.group` — the Keycloak group the platform binds for this team. */
  group?: string
}

const TEAM_XR_TTL_MS = 30_000
let teamXrCache: { at: number; items: TeamXrSummary[] } | null = null

/**
 * Every Team XR, cached briefly; null when the cluster cannot be asked (no
 * control plane, no token). The console compares `status.group` with the
 * group it fills, so a team can say whether the platform binds it yet.
 */
export async function listTeamXrs(token: string | undefined = getK8sServiceToken()): Promise<TeamXrSummary[] | null> {
  if (teamXrCache && Date.now() - teamXrCache.at < TEAM_XR_TTL_MS) return teamXrCache.items
  if (!token) return null
  try {
    const res = await apiServerFetch(
      token,
      xrCollectionPath({ apiVersion: PLATFORM_API_VERSION, kind: 'Team', metadata: { name: '', namespace: TENANCY_NAMESPACE, labels: {} } }),
    )
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const body = (await res.json()) as { items?: Array<XrListItem & { status?: { group?: unknown } }> }
    const items: TeamXrSummary[] = []
    for (const it of body.items ?? []) {
      const p = it.spec?.parameters ?? {}
      if (typeof p.organisation !== 'string' || typeof p.name !== 'string') continue
      const group = typeof it.status?.group === 'string' && it.status.group ? it.status.group : undefined
      items.push({ organisation: p.organisation, name: p.name, ...(group ? { group } : {}) })
    }
    teamXrCache = { at: Date.now(), items }
    return items
  } catch {
    return null
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

/** Test seam: forget what has been back-filled, and the Team XR listing. */
export function resetBackfillMemo(): void {
  ensured.clear()
  teamXrCache = null
}
