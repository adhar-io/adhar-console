import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { gitea, type k8s } from '@adhar/api-clients'
import { toPublicUrl, useGiteaOrg, usePublicBaseDomain, useToolPublicUrl } from '@adhar/shell-ui'
import { useK8sList, useK8sListSync } from './live-k8s.ts'
import { useArgoApplications } from './argo-apps.ts'
import {
  type ComponentType,
  type Entity,
  type EntityMetadata,
  entityRef,
  type EntitySpec,
  type Lifecycle,
  type Link,
} from './catalog.ts'
import { isSystemNamespace } from './catalog-system-namespaces.ts'

/**
 * Live catalog — derives Backstage-style entities from the actual cluster and
 * developer tooling instead of a hand-written seed.
 *
 *   • Kubernetes (via the console's authenticated gateway `k8s.K8sClient.auto()`
 *     → `/api/k8s`): Deployments + StatefulSets become **Components**, Services
 *     become **Resources**, Ingresses become **APIs** (with an OpenAPI shell
 *     synthesised from their routes). Owner / system / lifecycle / links are
 *     read from `adhar.io/*` or `backstage.io/*` annotations & the well-known
 *     `app.kubernetes.io/*` labels when present.
 *   • Gitea (via the BFF proxy `gitea.GiteaClient.auto({ tool: 'gitea' })` →
 *     `/api/svc/gitea`): repositories become **Components** carrying a repo link.
 *
 * Every source is an independent React-Query so one being unavailable never
 * blanks the others — the hook reports each source's state so the UI can render
 * honest empty / error banners rather than fabricate data.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })


/**
 * Background-refresh semantics for every live source: cards already on screen
 * must never be replaced by a spinner. `keepPreviousData` carries data across a
 * key change (the Gitea org resolving from `/api/config`), and the long
 * `gcTime` keeps the last result around when the user navigates away for a
 * while, so coming back paints instantly and refetches quietly.
 */
const LIVE_QUERY = {
  retry: false,
  placeholderData: keepPreviousData,
  gcTime: 24 * 60 * 60_000,
} as const

/* ─────────── annotation / label helpers ─────────── */

type Meta = k8s.ObjectMeta

function ann(meta: Meta | undefined, ...keys: string[]): string | undefined {
  const a = meta?.annotations
  if (!a) return undefined
  for (const k of keys) {
    const v = a[k]
    if (v && v.trim()) return v.trim()
  }
  return undefined
}

function lbl(meta: Meta | undefined, ...keys: string[]): string | undefined {
  const l = meta?.labels
  if (!l) return undefined
  for (const k of keys) {
    const v = l[k]
    if (v && v.trim()) return v.trim()
  }
  return undefined
}

const LIFECYCLES = new Set<Lifecycle>(['production', 'staging', 'experimental', 'deprecated'])

function coerceLifecycle(v: string | undefined): Lifecycle | undefined {
  if (!v) return undefined
  const lc = v.toLowerCase()
  return LIFECYCLES.has(lc as Lifecycle) ? (lc as Lifecycle) : undefined
}

/** Normalise an owner value into a Group ref (`group:team-x`). */
function toOwnerRef(v: string | undefined): string | undefined {
  if (!v) return undefined
  return v.includes(':') ? v : `group:${v}`
}

function toSystemRef(v: string | undefined): string | undefined {
  if (!v) return undefined
  return v.includes(':') ? v : `system:${v}`
}

function tagsFrom(meta: Meta | undefined, extra: Array<string | undefined>): string[] {
  const out = new Set<string>()
  const csv = ann(meta, 'adhar.io/tags', 'backstage.io/tags')
  if (csv) {
    for (const t of csv.split(',')) if (t.trim()) out.add(t.trim().toLowerCase())
  }
  for (const e of extra) if (e && e.trim()) out.add(e.trim().toLowerCase())
  return Array.from(out)
}

function linksFrom(meta: Meta | undefined): Link[] {
  const links: Link[] = []
  const repo = ann(meta, 'adhar.io/source-repo', 'backstage.io/source-location')
  if (repo) links.push({ url: repo.replace(/^url:\s*/, ''), title: 'Source', icon: 'repo' })
  const docs = ann(meta, 'adhar.io/docs', 'backstage.io/techdocs-ref')
  if (docs && /^https?:/.test(docs)) links.push({ url: docs, title: 'Docs', icon: 'docs' })
  const dash = ann(meta, 'adhar.io/dashboard', 'backstage.io/dashboard')
  if (dash) links.push({ url: dash, title: 'Dashboard', icon: 'dashboard' })
  const runbook = ann(meta, 'adhar.io/runbook', 'backstage.io/runbook')
  if (runbook) links.push({ url: runbook, title: 'Runbook', icon: 'runbook' })
  return links
}

function baseMeta(meta: Meta | undefined, fallbackDesc: string): EntityMetadata {
  const created = meta?.creationTimestamp
  return {
    name: meta?.name ?? 'unknown',
    namespace: meta?.namespace ?? 'default',
    title: ann(meta, 'backstage.io/title') ?? meta?.name,
    description: ann(meta, 'adhar.io/description', 'backstage.io/description') ?? fallbackDesc,
    tags: undefined,
    links: undefined,
    // Forward the raw annotation map so the catalog UI can read version /
    // techdocs (`adhar.io/version`, `backstage.io/techdocs-ref`, …) directly.
    annotations: meta?.annotations,
    createdAt: created,
    updatedAt: created,
  }
}

function baseSpec(
  meta: Meta | undefined,
): Pick<EntitySpec, 'owner' | 'system' | 'domain' | 'lifecycle'> {
  return {
    owner: toOwnerRef(
      ann(meta, 'adhar.io/owner', 'backstage.io/owner') ?? lbl(meta, 'adhar.io/owner'),
    ),
    system: toSystemRef(
      ann(meta, 'adhar.io/system', 'backstage.io/system') ?? lbl(meta, 'app.kubernetes.io/part-of'),
    ),
    domain: ann(meta, 'adhar.io/domain', 'backstage.io/domain')
      ? `domain:${ann(meta, 'adhar.io/domain', 'backstage.io/domain')}`
      : undefined,
    lifecycle: coerceLifecycle(ann(meta, 'adhar.io/lifecycle', 'backstage.io/lifecycle')),
  }
}

function live(entity: Entity): Entity {
  return { ...entity, origin: 'live' }
}

/* ─────────── workload → Component ─────────── */

function workloadToComponent(obj: k8s.Deployment | k8s.Generic, kindLabel: string): Entity {
  const meta = obj.metadata
  const compType = (ann(meta, 'adhar.io/component-type', 'backstage.io/component-type') ??
    'service') as ComponentType
  const md = baseMeta(meta, `${kindLabel} in the ${meta?.namespace ?? 'default'} namespace.`)
  md.tags = tagsFrom(meta, [
    lbl(meta, 'app.kubernetes.io/component'),
    lbl(meta, 'app.kubernetes.io/managed-by'),
  ])
  md.links = linksFrom(meta)
  return live({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: md,
    spec: {
      type: compType,
      ...baseSpec(meta),
    },
  })
}

/* ─────────── Service → Resource ─────────── */

/* ─────────── Ingress → API (with synthesised OpenAPI) ─────────── */

/* ─────────── Gitea repo → Component ─────────── */

function repoLanguageType(name?: string): ComponentType {
  const n = (name ?? '').toLowerCase()
  if (/(ui|sdk|lib|design|tokens)/.test(n)) return 'library'
  if (/(docs|handbook)/.test(n)) return 'documentation'
  if (/(web|portal|site|frontend)/.test(n)) return 'website'
  return 'service'
}

function repoToComponent(repo: gitea.Repo, publicBase: { toolUrl?: string; baseDomain?: string } = {}): Entity {
  const created = repo.updated_at
  // Gitea reports `html_url` with the host the BFF used to reach it — an
  // adhar-controlplane Service address the browser cannot open. Rewrite it to the
  // public Gitea host so "Source" links actually work.
  const sourceUrl = toPublicUrl(repo.html_url, { tool: 'gitea', toolUrl: publicBase.toolUrl, baseDomain: publicBase.baseDomain })
  return live({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: repo.name,
      namespace: 'default',
      title: repo.name,
      description: repo.description || `Repository ${repo.full_name}.`,
      tags: repo.language ? [repo.language.toLowerCase(), 'repo'] : ['repo'],
      links: [{ url: sourceUrl, title: 'Source', icon: 'repo' }],
      createdAt: created,
      updatedAt: created,
    },
    spec: {
      type: repoLanguageType(repo.name),
    },
  })
}

/* ─────────── source status ─────────── */

export type SourceState = 'ok' | 'empty' | 'error' | 'loading' | 'disabled'

export interface SourceStatus {
  id: 'k8s' | 'gitea'
  label: string
  state: SourceState
  count: number
  error?: string
}

interface QueryLike {
  isLoading: boolean
  isError: boolean
  error: unknown
}

function statusFor(
  id: SourceStatus['id'],
  label: string,
  q: QueryLike,
  count: number,
): SourceStatus {
  let state: SourceState
  if (q.isLoading) state = 'loading'
  else if (q.isError) state = 'error'
  else if (count === 0) state = 'empty'
  else state = 'ok'
  return {
    id,
    label,
    state,
    count,
    error: q.isError ? errMessage(q.error) : undefined,
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status
    if (status === 401 || status === 403) return 'Not authorised to read this source.'
    if (status === 404) return 'Source endpoint not found.'
    return err.message
  }
  return 'Request failed.'
}

/* ─────────── the hook ─────────── */

export interface LiveCatalog {
  entities: Entity[]
  sources: SourceStatus[]
  isLoading: boolean
  /** True while any source is (re)fetching — data on screen stays put. */
  isFetching: boolean
  /** True when at least one live source returned data. */
  hasLive: boolean
}

// The predicate lives in its own React-free module so its test can load it
// without the shell-ui/api-client graph this file pulls in.
export { isSystemNamespace }

/** Keep only objects living in a user namespace (drops system/platform ones). */
function inUserNamespace(obj: { metadata?: { namespace?: string } }): boolean {
  return !isSystemNamespace(obj.metadata?.namespace)
}

export { isPlatformRepo, PLATFORM_REPOS } from './catalog-platform-repos.ts'
import { APPLICATION_GVR, applicationEntities, CONTROL_PLANE_NAMESPACE, customAppNames, isCustomWorkload } from './catalog-custom-apps.ts'
export { APPLICATION_GVR, applicationEntities, CONTROL_PLANE_NAMESPACE, customAppNames, isCustomWorkload }
import { isPlatformRepo } from './catalog-platform-repos.ts'
import { applicationXRsQuery, belongsToDeletingApp, splitApplications } from './catalog-app-delete.ts'
import { withDeployedLifecycle } from './catalog-lifecycle.ts'

const DEPLOYMENTS_GVR = { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true } as const
const STATEFULSETS_GVR = { group: 'apps', version: 'v1', resource: 'statefulsets', namespaced: true } as const

export function useLiveCatalog(): LiveCatalog {
  // Org whose repos are surfaced as Components — runtime config, never hardcoded.
  const giteaOrgName = useGiteaOrg()
  // Public Gitea origin for browser-facing repo links.
  const giteaPublicUrl = useToolPublicUrl('gitea')
  const publicBaseDomain = usePublicBaseDomain()
  // Kubernetes sources: canonical live lists (one list, then watch deltas —
  // see live-k8s.ts), shared with the Overview and the status page.
  const deployments = useK8sList<k8s.Deployment>(DEPLOYMENTS_GVR, { gcTime: LIVE_QUERY.gcTime })
  const statefulSets = useK8sList<k8s.Generic>(STATEFULSETS_GVR, { gcTime: LIVE_QUERY.gcTime })
  // Gitea has no watch. The org's repository list changes when someone
  // creates or deletes an app — the console's own flows invalidate
  // ['catalog'] when they do — so it is read on mount, not on a timer.
  const repos = useQuery({
    queryKey: ['catalog', 'live', 'gitea-repos', giteaOrgName],
    queryFn: () => giteaClient.listRepos(giteaOrgName),
    ...LIVE_QUERY,
    staleTime: 2 * 60_000,
  })
  // The control plane's own record of every custom application: one
  // Application XR per app, wherever its repository lives. Kept current by
  // the watch on the XRs.
  const applications = useQuery({
    ...applicationXRsQuery,
    ...LIVE_QUERY,
    refetchInterval: useK8sListSync(applicationXRsQuery.queryKey, { ...APPLICATION_GVR, namespace: CONTROL_PLANE_NAMESPACE }),
  })
  // Every environment's Argo CD application, so an app's lifecycle can follow
  // where it is actually running (catalog-lifecycle.ts). Shared with the
  // deployment tab and the Overview. Best effort: without it the declared
  // lifecycle stands.
  const argoApps = useArgoApplications()

  return useMemo(() => {
    const gitRepos = repos.data ?? []
    const repoComponents = gitRepos
      // The org holds the platform's own repos alongside the team's; only the
      // team's are catalog entries (see PLATFORM_REPOS).
      .filter((r) => !isPlatformRepo(r.name, r))
      .map((r) => repoToComponent(r, { toolUrl: giteaPublicUrl, baseDomain: publicBaseDomain }))
    // An XR with a deletionTimestamp is on its way out (someone deleted the
    // application; Crossplane is removing what it composed). It is not listed,
    // and neither are the workloads it still owns while they are pruned — they
    // would otherwise resurface as stray "apps" for a minute or two.
    const { active: liveApps, deleting } = splitApplications(applications.data ?? [])
    const custom = customAppNames(repoComponents, liveApps)
    // The catalog lists CUSTOM applications only, one entity each. Workloads,
    // Services and Ingresses in the environment namespaces are no longer
    // entities of their own: an app runs there once per environment, and the
    // databases, caches and Kafka pools the control plane composes beside it
    // live there too — each used to show up as a separate "app" (2026-10-17).
    // A workload still contributes when it IS a custom app the repos and XRs
    // do not know (deployed from an external repository).
    const isAppWorkload = (d: { metadata?: k8s.ObjectMeta }) =>
      inUserNamespace(d) && isCustomWorkload(d, custom) && !belongsToDeletingApp(d, deleting)
    const deps = (deployments.data ?? []).filter(isAppWorkload)
    const sts = (statefulSets.data ?? []).filter(isAppWorkload)
    // Names compare case-insensitively: Gitea keeps a repo's casing (`Cart`)
    // while Kubernetes names are lowercase (`cart`), and an exact comparison
    // listed the same app twice.
    const repoNames = new Set(repoComponents.map((r) => r.metadata.name.toLowerCase()))
    const components = dedupeByName([
      ...applicationEntities(liveApps, repoComponents),
      ...deps.map((d) => workloadToComponent(d, 'Deployment')),
      ...sts.map((s) => workloadToComponent(s, 'StatefulSet')),
    ].filter((e) => !repoNames.has(e.metadata.name.toLowerCase())))
    const resources: Entity[] = []
    const apis: Entity[] = []

    // De-dupe: a k8s workload and its repo may share a name — k8s wins, but we
    // fold the repo link in so the source URL isn't lost.
    const byRef = new Map<string, Entity>()
    for (const e of [...components, ...resources, ...apis]) byRef.set(entityRef(e), e)
    for (const e of repoComponents) {
      const key = entityRef(e)
      const existing = byRef.get(key)
      if (!existing) {
        byRef.set(key, e)
      } else if (!(existing.metadata.links ?? []).some((l) => l.icon === 'repo')) {
        existing.metadata = {
          ...existing.metadata,
          links: [...(existing.metadata.links ?? []), ...(e.metadata.links ?? [])],
        }
      }
    }

    const k8sCount = components.length + resources.length + apis.length
    // Kubernetes rolls several endpoints into one source line; surface the first
    // failure, otherwise report loading/ok collectively.
    const kubeError = [deployments, statefulSets, applications].find((qq) => qq.isError)
    const kubeStatus: QueryLike = {
      isLoading:
        deployments.isLoading ||
        statefulSets.isLoading ||
        applications.isLoading,
      isError: Boolean(kubeError),
      error: kubeError?.error,
    }
    const sources: SourceStatus[] = [
      statusFor('k8s', 'Kubernetes', kubeStatus, k8sCount),
      statusFor(
        'gitea',
        'Gitea',
        { isLoading: repos.isLoading, isError: repos.isError, error: repos.error },
        repoComponents.length,
      ),
    ]

    const isLoading =
      deployments.isLoading ||
      statefulSets.isLoading ||
      applications.isLoading ||
      repos.isLoading

    const isFetching =
      deployments.isFetching ||
      statefulSets.isFetching ||
      applications.isFetching ||
      repos.isFetching

    return {
      entities: withDeployedLifecycle(Array.from(byRef.values()), argoApps.data ?? []),
      sources,
      isLoading,
      isFetching,
      hasLive: byRef.size > 0,
    }
  }, [
    giteaPublicUrl,
    publicBaseDomain,
    deployments.data,
    deployments.isError,
    deployments.isLoading,
    deployments.isFetching,
    deployments.error,
    statefulSets.isFetching,
    repos.isFetching,
    statefulSets.data,
    statefulSets.isLoading,
    statefulSets.isError,
    statefulSets.error,
    repos.data,
    repos.isError,
    repos.isLoading,
    repos.error,
    applications.data,
    applications.isError,
    applications.isLoading,
    applications.isFetching,
    argoApps.data,
  ])
}

function dedupeByName(entities: readonly Entity[]): Entity[] {
  const seen = new Set<string>()
  const out: Entity[] = []
  for (const e of entities) {
    const k = e.metadata.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

/* ─────────── OpenAPI parsing (used by the drawer) ─────────── */

export interface ParsedApiOperation {
  method: string
  path: string
  summary?: string
}

export interface ParsedApi {
  title?: string
  version?: string
  servers: string[]
  operations: ParsedApiOperation[]
  schemas: string[]
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']

/**
 * Best-effort parse of an entity's `spec.definition`. Handles inline OpenAPI as
 * JSON (what live Ingress-derived APIs carry). Returns null when the definition
 * is a plain entity ref (e.g. `component:cart`) or unparseable — callers then
 * fall back to the ref view.
 */
export function parseApiDefinition(def: string | undefined): ParsedApi | null {
  if (!def) return null
  const trimmed = def.trim()
  if (!trimmed.startsWith('{')) return null
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
  if (!doc || (!('openapi' in doc) && !('swagger' in doc) && !('paths' in doc))) return null

  const info = (doc.info ?? {}) as { title?: string; version?: string }
  const servers = Array.isArray(doc.servers)
    ? (doc.servers as Array<{ url?: string }>).map((s) => s.url ?? '').filter(Boolean)
    : []
  const operations: ParsedApiOperation[] = []
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method] as { summary?: string } | undefined
      if (op && typeof op === 'object') {
        operations.push({ method: method.toUpperCase(), path, summary: op.summary })
      }
    }
  }
  const components = (doc.components ?? {}) as { schemas?: Record<string, unknown> }
  const schemas = components.schemas ? Object.keys(components.schemas) : []

  return { title: info.title, version: info.version, servers, operations, schemas }
}
