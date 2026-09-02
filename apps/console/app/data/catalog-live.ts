import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { gitea, k8s } from '@adhar-console/api-clients'
import {
  type ApiType,
  type ComponentType,
  type Entity,
  type EntityMetadata,
  entityRef,
  type EntitySpec,
  type Lifecycle,
  type Link,
  type ResourceType,
} from './catalog.ts'

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

const kubeClient = k8s.K8sClient.auto()
const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

const REFRESH_MS = 30_000

/** Org whose repos are surfaced as Components. Overridable at build time. */
function giteaOrg(): string {
  try {
    const raw = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GITEA_ORG
    return raw && raw.trim() ? raw.trim() : 'acme'
  } catch {
    return 'acme'
  }
}

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

function serviceToResource(svc: k8s.Service): Entity {
  const meta = svc.metadata
  const svcType = svc.spec?.type ?? 'ClusterIP'
  const ports = (svc.spec?.ports ?? []).map((p) => p.port).join(', ')
  const resType = (ann(meta, 'adhar.io/resource-type') as ResourceType | undefined) ?? 'cluster'
  const md = baseMeta(
    meta,
    `Kubernetes ${svcType} Service${ports ? ` exposing port(s) ${ports}` : ''}.`,
  )
  md.tags = tagsFrom(meta, ['service', svcType.toLowerCase()])
  md.links = linksFrom(meta)
  return live({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: md,
    spec: {
      type: resType,
      provider: `kubernetes/${svcType}`,
      ...baseSpec(meta),
    },
  })
}

/* ─────────── Ingress → API (with synthesised OpenAPI) ─────────── */

function ingressToOpenApi(ing: k8s.Ingress): string {
  const rules = ing.spec?.rules ?? []
  const paths: Record<string, unknown> = {}
  const servers: Array<{ url: string }> = []
  for (const rule of rules) {
    if (rule.host) servers.push({ url: `https://${rule.host}` })
    for (const p of rule.http?.paths ?? []) {
      const backend = p.backend?.service
      const port = backend?.port?.number ?? backend?.port?.name ?? ''
      paths[p.path || '/'] = {
        get: {
          summary: backend?.name
            ? `Routes to ${backend.name}${port ? `:${port}` : ''}`
            : 'Ingress route',
          responses: { '200': { description: 'OK' } },
        },
      }
    }
  }
  const doc = {
    openapi: '3.0.0',
    info: {
      title: ing.metadata?.name ?? 'ingress',
      version: 'live',
      description: 'Synthesised from live Ingress rules.',
    },
    servers,
    paths,
  }
  return JSON.stringify(doc, null, 2)
}

function ingressToApi(ing: k8s.Ingress): Entity {
  const meta = ing.metadata
  const apiType = (ann(meta, 'adhar.io/api-type', 'backstage.io/api-type') ?? 'openapi') as ApiType
  const hosts = (ing.spec?.rules ?? []).map((r) => r.host).filter(Boolean) as string[]
  const md = baseMeta(
    meta,
    hosts.length ? `HTTP API exposed at ${hosts.join(', ')}.` : 'Cluster-exposed HTTP API.',
  )
  md.tags = tagsFrom(meta, ['ingress', ing.spec?.ingressClassName])
  md.links = [
    ...hosts.map((h) => ({ url: `https://${h}`, title: h, icon: 'dashboard' as const })),
    ...linksFrom(meta),
  ]
  return live({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'API',
    metadata: md,
    spec: {
      type: apiType,
      definition: ingressToOpenApi(ing),
      ...baseSpec(meta),
    },
  })
}

/* ─────────── Gitea repo → Component ─────────── */

function repoLanguageType(name?: string): ComponentType {
  const n = (name ?? '').toLowerCase()
  if (/(ui|sdk|lib|design|tokens)/.test(n)) return 'library'
  if (/(docs|handbook)/.test(n)) return 'documentation'
  if (/(web|portal|site|frontend)/.test(n)) return 'website'
  return 'service'
}

function repoToComponent(repo: gitea.Repo): Entity {
  const created = repo.updated_at
  return live({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: repo.name,
      namespace: 'default',
      title: repo.name,
      description: repo.description || `Repository ${repo.full_name}.`,
      tags: repo.language ? [repo.language.toLowerCase(), 'repo'] : ['repo'],
      links: [{ url: repo.html_url, title: 'Source', icon: 'repo' }],
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
  /** True when at least one live source returned data. */
  hasLive: boolean
}

/**
 * Kubernetes namespaces that hold platform/system workloads, not user apps.
 * The Service Catalog is a developer view of *their* software, so these are
 * filtered out — only user namespaces (and `default`) surface. Covers the
 * well-known cluster namespaces plus the Adhar platform's own (everything the
 * platform installs lives in `adhar-system`).
 */
const SYSTEM_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'adhar-system',
  'local-path-storage',
  'metallb-system',
  'ingress-nginx',
  'cert-manager',
  'argocd',
  'argo',
  'crossplane-system',
  'external-secrets',
  'cnpg-system',
  'kyverno',
  'tekton-pipelines',
  'flux-system',
  'monitoring',
  'observability',
])

/** True for a platform/system namespace that should be hidden from the catalog. */
function isSystemNamespace(ns: string | undefined): boolean {
  const n = ns ?? 'default'
  if (SYSTEM_NAMESPACES.has(n)) return true
  // Conventional system namespaces: the `kube-` prefix and any `*-system`.
  return n.startsWith('kube-') || n.endsWith('-system')
}

/** Keep only objects living in a user namespace (drops system/platform ones). */
function inUserNamespace(obj: { metadata?: { namespace?: string } }): boolean {
  return !isSystemNamespace(obj.metadata?.namespace)
}

export function useLiveCatalog(): LiveCatalog {
  const deployments = useQuery({
    queryKey: ['catalog', 'live', 'deployments'],
    queryFn: () => kubeClient.listDeployments(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const statefulSets = useQuery({
    queryKey: ['catalog', 'live', 'statefulsets'],
    queryFn: () => kubeClient.listStatefulSets(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const services = useQuery({
    queryKey: ['catalog', 'live', 'services'],
    queryFn: () => kubeClient.listServices(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const ingresses = useQuery({
    queryKey: ['catalog', 'live', 'ingresses'],
    queryFn: () => kubeClient.listIngresses(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const repos = useQuery({
    queryKey: ['catalog', 'live', 'gitea-repos', giteaOrg()],
    queryFn: () => giteaClient.listRepos(giteaOrg()),
    refetchInterval: REFRESH_MS,
    retry: false,
  })

  return useMemo(() => {
    // Only surface workloads in user namespaces — hide platform/system pods
    // (adhar-system, kube-system, cert-manager, …) so the catalog shows apps.
    const deps = (deployments.data ?? []).filter(inUserNamespace)
    const sts = (statefulSets.data ?? []).filter(inUserNamespace)
    const svcs = (services.data ?? []).filter(inUserNamespace)
    const ings = (ingresses.data ?? []).filter(inUserNamespace)
    const gitRepos = repos.data ?? []

    const components = [
      ...deps.map((d) => workloadToComponent(d, 'Deployment')),
      ...sts.map((s) => workloadToComponent(s, 'StatefulSet')),
    ]
    const resources = svcs
      // Skip noisy platform-internal services (kube-system default kubernetes svc).
      .filter((s) => s.metadata?.name !== 'kubernetes')
      .map(serviceToResource)
    const apis = ings.map(ingressToApi)
    const repoComponents = gitRepos.map(repoToComponent)

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
    const kubeError = [deployments, statefulSets, services, ingresses].find((qq) => qq.isError)
    const kubeStatus: QueryLike = {
      isLoading:
        deployments.isLoading ||
        statefulSets.isLoading ||
        services.isLoading ||
        ingresses.isLoading,
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
      services.isLoading ||
      ingresses.isLoading ||
      repos.isLoading

    return {
      entities: Array.from(byRef.values()),
      sources,
      isLoading,
      hasLive: byRef.size > 0,
    }
  }, [
    deployments.data,
    deployments.isError,
    deployments.isLoading,
    deployments.error,
    statefulSets.data,
    statefulSets.isLoading,
    statefulSets.isError,
    statefulSets.error,
    services.data,
    services.isError,
    services.isLoading,
    services.error,
    ingresses.data,
    ingresses.isError,
    ingresses.isLoading,
    ingresses.error,
    repos.data,
    repos.isError,
    repos.isLoading,
    repos.error,
  ])
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
