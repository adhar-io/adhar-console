import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type SourceStatus, useLiveCatalog } from './catalog-live.ts'
import { pruneStaleScaffolded } from './catalog-app-delete-model.ts'

/**
 * Backstage-style Service Catalog.
 *
 * Every asset the org cares about is an `Entity` — Components (services,
 * websites, libraries), APIs, Resources (databases, queues, buckets),
 * Systems, Domains, Groups, and Users. Entities reference each other to form
 * the full software graph: a Component owns APIs, depends on Resources,
 * belongs to a System, and is owned by a Group.
 *
 * Entities come from live sources (cluster + Gitea, `catalog-live.ts`) merged
 * with the ones a user explicitly registered. There is no sample/seed
 * catalog: an empty platform shows an empty catalog.
 */

export type EntityKind = 'Component' | 'API' | 'Resource' | 'System' | 'Domain' | 'Group' | 'User'

export type ComponentType = 'service' | 'website' | 'library' | 'mobile-app' | 'documentation'
export type ApiType = 'openapi' | 'asyncapi' | 'graphql' | 'grpc' | 'trpc'
export type ResourceType =
  | 'database'
  | 'cache'
  | 'queue'
  | 'topic'
  | 'bucket'
  | 'cdn'
  | 'cluster'
  | 's3-bucket'

export type Lifecycle = 'production' | 'staging' | 'experimental' | 'deprecated'

export interface Link {
  url: string
  title: string
  icon?: 'docs' | 'dashboard' | 'repo' | 'runbook' | 'chat' | 'on-call'
}

export interface EntityMetadata {
  /** Stable kebab-case identifier — unique within the kind+namespace. */
  name: string
  /** Short namespace — defaults to "default". Aligns with Backstage convention. */
  namespace?: string
  /** Human title (free-form). */
  title?: string
  /** Markdown-friendly short description. */
  description?: string
  tags?: string[]
  links?: Link[]
  /**
   * Raw annotations carried through from the source (`adhar.io/*`,
   * `backstage.io/*`, `app.kubernetes.io/*`). Drives version / techdocs reads in
   * the catalog UI. Forwarded from live k8s objects and catalog-info.yaml.
   */
  annotations?: Record<string, string>
  /** ISO timestamp; bumped by the catalog on every save. */
  updatedAt?: string
  createdAt?: string
}

export interface EntitySpec {
  type?: ComponentType | ApiType | ResourceType
  lifecycle?: Lifecycle
  /** "group:platform" or just "platform" — references a Group entity. */
  owner?: string
  /** "system:billing" — references a System entity. */
  system?: string
  /** "domain:commerce" — references a Domain entity. */
  domain?: string
  /** Refs to API entities provided by this Component. */
  providesApis?: string[]
  /** Refs to API entities this Component consumes. */
  consumesApis?: string[]
  /** Refs to other Components / Resources this entity depends on. */
  dependsOn?: string[]
  /** APIs reference the Component that defines them. */
  definition?: string
  /** Resources may reference the underlying provider. */
  provider?: string
  /** Group: parent group ref. */
  parent?: string
  /** Group: list of `user:` refs. */
  members?: string[]
  /** User: full name + email. */
  email?: string
}

/** Where an entity came from — drives the source badge in the UI. */
export type EntityOrigin = 'live' | 'registered' | 'seed'

export interface Entity {
  apiVersion: 'backstage.io/v1alpha1'
  kind: EntityKind
  metadata: EntityMetadata
  spec: EntitySpec
  /** Non-schema hint: how this entity entered the catalog. Absent = seed. */
  origin?: EntityOrigin
}

export type EntityRef = `${string}:${string}` | `${string}:${string}/${string}`



/* ─────────── persistence (user-registered / manual entities only) ─────────── */

/**
 * The store now holds ONLY the entities a user explicitly registered through the
 * UI. Live entities are derived fresh from the cluster / Gitea (see
 * `catalog-live.ts`) and never persisted; there is no seed fallback. A new storage key is used so any legacy full-catalog blob under the old
 * key is ignored rather than resurrected as the primary source.
 */
const REGISTERED_KEY = 'adhar.catalog.registered'

function readStore(): Entity[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(REGISTERED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Entity[]
    return Array.isArray(parsed) ? parsed.map((e) => ({ ...e, origin: 'registered' as const })) : []
  } catch {
    return []
  }
}
function writeStore(entities: Entity[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(REGISTERED_KEY, JSON.stringify(entities))
  } catch {
    /* quota — ignore */
  }
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

async function fetchRegistered(): Promise<Entity[]> {
  await delay(40)
  return readStore()
}

async function persistEntity(next: Entity): Promise<Entity> {
  await delay(160)
  const list = readStore()
  const idx = list.findIndex(
    (e) =>
      e.kind === next.kind &&
      (e.metadata.namespace ?? 'default') === (next.metadata.namespace ?? 'default') &&
      e.metadata.name === next.metadata.name,
  )
  const stamped: Entity = {
    ...next,
    origin: 'registered',
    metadata: { ...next.metadata, updatedAt: new Date().toISOString() },
  }
  const updated = idx >= 0 ? list.with(idx, stamped) : [stamped, ...list]
  writeStore(updated)
  return stamped
}

/* ─────────── merge helpers ─────────── */

function entityKey(e: Entity): string {
  return `${e.kind}|${e.metadata.namespace ?? 'default'}|${e.metadata.name}`
}

/**
 * Merge entity lists by identity, first-writer-wins. Callers order sources by
 * precedence: registered (user intent) → live (cluster truth) → seed (fallback).
 */
export function mergeCatalogs(...lists: Entity[][]): Entity[] {
  const byKey = new Map<string, Entity>()
  for (const list of lists) {
    for (const e of list) {
      const k = entityKey(e)
      if (!byKey.has(k)) byKey.set(k, e)
    }
  }
  return Array.from(byKey.values())
}

/* ─────────── React Query ─────────── */

const REGISTERED_QUERY_KEY = ['catalog', 'registered'] as const

/** Just the user-registered entities from the local store. */
export function useRegisteredEntities() {
  return useQuery<Entity[]>({
    queryKey: REGISTERED_QUERY_KEY,
    queryFn: fetchRegistered,
    staleTime: 60_000,
    placeholderData: [],
  })
}

export function useRegisterEntity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: persistEntity,
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: REGISTERED_QUERY_KEY })
      const prev = qc.getQueryData<Entity[]>(REGISTERED_QUERY_KEY)
      const optimistic = mergeEntity(prev ?? [], { ...next, origin: 'registered' })
      qc.setQueryData<Entity[]>(REGISTERED_QUERY_KEY, optimistic)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(REGISTERED_QUERY_KEY, ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: REGISTERED_QUERY_KEY })
    },
  })
}

/** Drop a registered entity from the local store and forget it in the snapshot. */
function removeEntity(target: Pick<Entity, 'kind' | 'metadata'>): void {
  const same = (e: Entity) =>
    e.kind === target.kind &&
    (e.metadata.namespace ?? 'default') === (target.metadata.namespace ?? 'default') &&
    e.metadata.name === target.metadata.name
  writeStore(readStore().filter((e) => !same(e)))
  const snap = loadSnapshot()
  if (snap?.some(same)) saveSnapshot(snap.filter((e) => !same(e)))
}

export function useUnregisterEntity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (target: Pick<Entity, 'kind' | 'metadata'>) => {
      removeEntity(target)
    },
    onSettled: () => {
      // Registered, live and deployment queries all share the `catalog` prefix.
      qc.invalidateQueries({ queryKey: ['catalog'] })
    },
  })
}

function mergeEntity(list: Entity[], next: Entity): Entity[] {
  const idx = list.findIndex(
    (e) =>
      e.kind === next.kind &&
      (e.metadata.namespace ?? 'default') === (next.metadata.namespace ?? 'default') &&
      e.metadata.name === next.metadata.name,
  )
  return idx >= 0 ? list.with(idx, next) : [next, ...list]
}

/* ─────────── composed catalog (registered + live, seed fallback) ─────────── */

export interface CatalogResult {
  /** The merged entity list the UI renders. */
  data: Entity[]
  /** True only when there is nothing to show yet (no cache, no snapshot). */
  isLoading: boolean
  /** True while sources refresh behind data that is already on screen. */
  refreshing: boolean
  /** Per-source health so the UI can render honest banners. */
  sources: SourceStatus[]
  /** True when live cluster/tool data is present (registered-only counts too). */
  live: boolean
  /**
   * True when loading finished and there is nothing to show — no live entity
   * and nothing registered. The catalog is then empty (never sample data).
   */
  offline: boolean
}

/**
 * Primary catalog hook. Prefers live data (cluster + Gitea) merged with the
 * user's registered entities. There is no sample
 * fallback: with nothing live and nothing registered the catalog is empty and
 * `offline` is set so the page can say why.
 */
export function useCatalog(): CatalogResult {
  const registeredQ = useRegisteredEntities()
  const liveCatalog = useLiveCatalog()

  const sourcesHealthy = !liveCatalog.isLoading &&
    liveCatalog.sources.every((s) => s.state === 'ok' || s.state === 'empty')
  const registered = useMemo(
    () => pruneStaleScaffolded(registeredQ.data ?? [], liveCatalog.entities, sourcesHealthy),
    [registeredQ.data, liveCatalog.entities, sourcesHealthy],
  )
  const fetching = registeredQ.isLoading || liveCatalog.isLoading

  return useMemo(() => {
    const hasReal = liveCatalog.hasLive || registered.length > 0
    if (hasReal && liveCatalog.hasLive && !liveCatalog.isLoading) {
      // Fresh live result — remember it so the next visit / hard reload paints
      // cards immediately while the sources refresh in the background.
      saveSnapshot(liveCatalog.entities)
    }
    // Still fetching with nothing live yet → show the last snapshot (if any)
    // instead of a blocking spinner; the list swaps in place once data lands.
    const snapshot = !liveCatalog.hasLive && fetching ? loadSnapshot() : null
    const showingSnapshot = !!snapshot && snapshot.length > 0
    const isLoading = fetching && !hasReal && !showingSnapshot
    const offline = !hasReal && !fetching
    // No sample data, ever: an empty platform shows an empty catalog (the
    // page renders an empty state), and the first real app appears as soon as
    // a source reports it.
    const data = hasReal
      ? mergeCatalogs(registered, liveCatalog.entities)
      : showingSnapshot
        ? mergeCatalogs(registered, snapshot)
        : mergeCatalogs(registered, liveCatalog.entities)
    return {
      data,
      isLoading,
      refreshing: !isLoading && (liveCatalog.isFetching || registeredQ.isFetching),
      sources: liveCatalog.sources,
      live: liveCatalog.hasLive || showingSnapshot,
      offline,
    }
  }, [
    registered,
    registeredQ.isFetching,
    liveCatalog.entities,
    liveCatalog.hasLive,
    liveCatalog.isLoading,
    liveCatalog.isFetching,
    liveCatalog.sources,
    fetching,
  ])
}

/* ─────────── last-known-good snapshot (per browser) ─────────── */

const SNAPSHOT_KEY = 'adhar.catalog.snapshot.v1'
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60_000
let snapshotCache: Entity[] | null | undefined

function loadSnapshot(): Entity[] | null {
  if (snapshotCache !== undefined) return snapshotCache
  snapshotCache = null
  try {
    const raw = globalThis.localStorage?.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: number; entities?: Entity[] }
    if (!Array.isArray(parsed.entities)) return null
    if (typeof parsed.at === 'number' && Date.now() - parsed.at > SNAPSHOT_MAX_AGE_MS) return null
    snapshotCache = parsed.entities
  } catch {
    snapshotCache = null
  }
  return snapshotCache
}

let lastSaved = ''
function saveSnapshot(entities: Entity[]) {
  try {
    const body = JSON.stringify({ at: Date.now(), entities })
    if (body === lastSaved) return
    lastSaved = body
    snapshotCache = entities
    globalThis.localStorage?.setItem(SNAPSHOT_KEY, body)
  } catch {
    // Quota / private mode — the snapshot is a convenience only.
  }
}

/* ─────────── helpers used by UI ─────────── */

export function entityRef(e: Entity): EntityRef {
  const ns = e.metadata.namespace ?? 'default'
  const left = e.kind.toLowerCase()
  return ns === 'default' ? `${left}:${e.metadata.name}` : `${left}:${ns}/${e.metadata.name}`
}

export function parseRef(ref: string): { kind?: EntityKind; namespace: string; name: string } {
  const [left, right] = ref.includes(':') ? ref.split(':', 2) : ['', ref]
  const [ns, name] = right.includes('/') ? right.split('/', 2) : ['default', right]
  const kindMap: Record<string, EntityKind> = {
    component: 'Component',
    api: 'API',
    resource: 'Resource',
    system: 'System',
    domain: 'Domain',
    group: 'Group',
    user: 'User',
  }
  return { kind: kindMap[left.toLowerCase()], namespace: ns || 'default', name }
}

export function findEntity(list: Entity[], ref: string): Entity | undefined {
  const { kind, namespace, name } = parseRef(ref)
  return list.find(
    (e) =>
      (!kind || e.kind === kind) &&
      (e.metadata.namespace ?? 'default') === namespace &&
      e.metadata.name === name,
  )
}

export const KIND_LABEL: Record<EntityKind, string> = {
  Component: 'Components',
  API: 'APIs',
  Resource: 'Resources',
  System: 'Systems',
  Domain: 'Domains',
  Group: 'Groups',
  User: 'Users',
}

export const LIFECYCLE_TONE: Record<Lifecycle, 'healthy' | 'progressing' | 'info' | 'degraded'> = {
  production: 'healthy',
  staging: 'progressing',
  experimental: 'info',
  deprecated: 'degraded',
}
