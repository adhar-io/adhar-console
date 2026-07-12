import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Backstage-style Service Catalog.
 *
 * Every asset the org cares about is an `Entity` — Components (services,
 * websites, libraries), APIs, Resources (databases, queues, buckets),
 * Systems, Domains, Groups, and Users. Entities reference each other to form
 * the full software graph: a Component owns APIs, depends on Resources,
 * belongs to a System, and is owned by a Group.
 *
 * v1 backs the catalog with a localStorage-persisted blob seeded from a rich
 * default. Once the BFF `/api/catalog/entities` endpoint lands, swap the
 * fetch / persist functions; the React-Query cache + optimistic updates stay
 * intact.
 */

export type EntityKind = 'Component' | 'API' | 'Resource' | 'System' | 'Domain' | 'Group' | 'User'

export type ComponentType =
  | 'service'
  | 'website'
  | 'library'
  | 'mobile-app'
  | 'documentation'
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

export interface Entity {
  apiVersion: 'backstage.io/v1alpha1'
  kind: EntityKind
  metadata: EntityMetadata
  spec: EntitySpec
}

export type EntityRef = `${string}:${string}` | `${string}:${string}/${string}`

/* ─────────── seed catalog ─────────── */

function entity(
  kind: EntityKind,
  name: string,
  spec: EntitySpec,
  meta: Partial<EntityMetadata> = {},
): Entity {
  const created = new Date(Date.now() - Math.floor(Math.random() * 90 + 1) * 86_400_000).toISOString()
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind,
    metadata: {
      name,
      namespace: 'default',
      createdAt: created,
      updatedAt: created,
      ...meta,
    },
    spec,
  }
}

export const SEED_CATALOG: Entity[] = [
  /* ─── Domains ─── */
  entity('Domain', 'commerce', { owner: 'group:team-commerce' }, {
    title: 'Commerce',
    description: 'Storefront, ordering, fulfilment, and payments.',
    tags: ['core'],
  }),
  entity('Domain', 'data-platform', { owner: 'group:team-data' }, {
    title: 'Data Platform',
    description: 'Lakehouse, streaming, BI, ML feature store.',
    tags: ['platform'],
  }),
  entity('Domain', 'platform', { owner: 'group:team-platform' }, {
    title: 'Internal Developer Platform',
    description: 'Cluster, CI/CD, observability, and developer-experience tooling.',
    tags: ['platform'],
  }),

  /* ─── Systems ─── */
  entity('System', 'storefront', { owner: 'group:team-commerce', domain: 'domain:commerce' }, {
    title: 'Storefront',
    description: 'The customer-facing web + mobile experience.',
  }),
  entity('System', 'orders', { owner: 'group:team-orders', domain: 'domain:commerce' }, {
    title: 'Orders',
    description: 'Order capture, payment authorisation, fulfilment hand-off.',
  }),
  entity('System', 'lakehouse', { owner: 'group:team-data', domain: 'domain:data-platform' }, {
    title: 'Lakehouse',
    description: 'Bronze / silver / gold lake plus the BI surface.',
  }),
  entity('System', 'idp', { owner: 'group:team-platform', domain: 'domain:platform' }, {
    title: 'Internal Developer Platform',
    description: 'Adhar Console, IaC, Crossplane compositions.',
  }),

  /* ─── Groups ─── */
  entity('Group', 'team-commerce', {
    members: ['user:tapas', 'user:olivia', 'user:rohan', 'user:sara'],
    parent: 'group:engineering',
  }, { title: 'Team Commerce', description: 'Owns storefront + cart.' }),
  entity('Group', 'team-orders', {
    members: ['user:olivia', 'user:nik'],
    parent: 'group:engineering',
  }, { title: 'Team Orders', description: 'Owns order + payment.' }),
  entity('Group', 'team-data', {
    members: ['user:lin', 'user:vivek'],
    parent: 'group:engineering',
  }, { title: 'Team Data', description: 'Owns the lakehouse + warehouse.' }),
  entity('Group', 'team-platform', {
    members: ['user:tapas', 'user:rohan'],
    parent: 'group:engineering',
  }, { title: 'Team Platform', description: 'Owns the IDP + CI/CD.' }),
  entity('Group', 'engineering', {
    members: [],
  }, { title: 'Engineering' }),

  /* ─── Users ─── */
  entity('User', 'tapas', { email: 'tapas@acme.com' }, { title: 'Tapas Jena' }),
  entity('User', 'olivia', { email: 'olivia@acme.com' }, { title: 'Olivia Park' }),
  entity('User', 'rohan', { email: 'rohan@acme.com' }, { title: 'Rohan Mehta' }),
  entity('User', 'sara', { email: 'sara@acme.com' }, { title: 'Sara Liu' }),
  entity('User', 'nik', { email: 'nik@acme.com' }, { title: 'Niklas Berg' }),
  entity('User', 'lin', { email: 'lin@acme.com' }, { title: 'Lin Tanaka' }),
  entity('User', 'vivek', { email: 'vivek@acme.com' }, { title: 'Vivek Rao' }),

  /* ─── Components: services / websites / libraries ─── */
  entity('Component', 'web', {
    type: 'website',
    lifecycle: 'production',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    consumesApis: ['api:catalog-api', 'api:orders-api', 'api:cart-api'],
    dependsOn: ['component:image-cdn'],
  }, {
    title: 'Storefront Web',
    description: 'Next.js 15 storefront — SSR, edge cache, fully internationalised.',
    tags: ['react', 'next', 'typescript'],
    links: [
      { url: 'https://github.com/acme/web', title: 'Source', icon: 'repo' },
      { url: 'https://app.acme.io', title: 'Production', icon: 'dashboard' },
      { url: 'https://docs.acme.io/web', title: 'Docs', icon: 'docs' },
    ],
  }),
  entity('Component', 'mobile-ios', {
    type: 'mobile-app',
    lifecycle: 'production',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    consumesApis: ['api:catalog-api', 'api:orders-api'],
  }, {
    title: 'Storefront iOS',
    description: 'SwiftUI client, share-extension support, deep-link routing.',
    tags: ['swift', 'ios'],
  }),
  entity('Component', 'cart', {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    providesApis: ['api:cart-api'],
    consumesApis: ['api:catalog-api'],
    dependsOn: ['resource:cart-redis'],
  }, {
    title: 'Cart Service',
    description: 'Stateless service backed by Redis — cart hold, coupon engine.',
    tags: ['go', 'grpc'],
    links: [
      { url: 'https://github.com/acme/cart', title: 'Source', icon: 'repo' },
      { url: 'https://runbooks.acme.io/cart', title: 'Runbook', icon: 'runbook' },
    ],
  }),
  entity('Component', 'catalog-svc', {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    providesApis: ['api:catalog-api'],
    dependsOn: ['resource:catalog-pg', 'resource:catalog-search'],
  }, {
    title: 'Catalog Service',
    description: 'Product catalog read API + search facade.',
    tags: ['rust', 'rest'],
  }),
  entity('Component', 'orders-svc', {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:team-orders',
    system: 'system:orders',
    providesApis: ['api:orders-api'],
    consumesApis: ['api:payments-api'],
    dependsOn: ['resource:orders-pg', 'resource:orders-events'],
  }, {
    title: 'Orders Service',
    description: 'Order lifecycle state machine + outbox pattern.',
    tags: ['kotlin', 'rest'],
  }),
  entity('Component', 'payments-svc', {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:team-orders',
    system: 'system:orders',
    providesApis: ['api:payments-api'],
    dependsOn: ['resource:payments-pg'],
  }, {
    title: 'Payments Service',
    description: 'PCI-segregated payment authorisation gateway.',
    tags: ['go', 'rest', 'pci'],
  }),
  entity('Component', 'image-cdn', {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:team-platform',
    system: 'system:idp',
    dependsOn: ['resource:asset-bucket'],
  }, {
    title: 'Image CDN',
    description: 'On-the-fly resizing + signed URL service.',
    tags: ['go', 'rest'],
  }),
  entity('Component', 'fraud-detection', {
    type: 'service',
    lifecycle: 'experimental',
    owner: 'group:team-data',
    system: 'system:orders',
    consumesApis: ['api:orders-api'],
    dependsOn: ['resource:fraud-features'],
  }, {
    title: 'Fraud Detection',
    description: 'Online ML scorer for transaction-level fraud risk.',
    tags: ['python', 'ml'],
  }),
  entity('Component', 'lake-ingest', {
    type: 'service',
    lifecycle: 'production',
    owner: 'group:team-data',
    system: 'system:lakehouse',
    dependsOn: ['resource:bronze-bucket', 'resource:lake-events'],
  }, {
    title: 'Lake Ingest',
    description: 'Streaming ingest into the bronze layer with schema validation.',
    tags: ['scala', 'spark', 'streaming'],
  }),
  entity('Component', 'metrics-shared', {
    type: 'library',
    lifecycle: 'production',
    owner: 'group:team-platform',
  }, {
    title: '@acme/metrics',
    description: 'Shared OpenTelemetry instrumentation library used by every service.',
    tags: ['opentelemetry', 'library'],
  }),
  entity('Component', 'auth-shared', {
    type: 'library',
    lifecycle: 'production',
    owner: 'group:team-platform',
  }, {
    title: '@acme/auth',
    description: 'OIDC client + middleware shared across all services.',
    tags: ['library', 'oidc'],
  }),
  entity('Component', 'docs-portal', {
    type: 'documentation',
    lifecycle: 'production',
    owner: 'group:team-platform',
    system: 'system:idp',
  }, {
    title: 'Engineering Docs',
    description: 'Markdown-as-code docs portal — every service publishes here.',
    tags: ['docs'],
  }),

  /* ─── APIs ─── */
  entity('API', 'cart-api', {
    type: 'grpc',
    lifecycle: 'production',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    definition: 'component:cart',
  }, { title: 'Cart API', description: 'gRPC interface for the storefront cart.' }),
  entity('API', 'catalog-api', {
    type: 'openapi',
    lifecycle: 'production',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    definition: 'component:catalog-svc',
  }, { title: 'Catalog API', description: 'REST API for product browse + search.' }),
  entity('API', 'orders-api', {
    type: 'openapi',
    lifecycle: 'production',
    owner: 'group:team-orders',
    system: 'system:orders',
    definition: 'component:orders-svc',
  }, { title: 'Orders API', description: 'Order lifecycle + retrieval REST API.' }),
  entity('API', 'payments-api', {
    type: 'openapi',
    lifecycle: 'production',
    owner: 'group:team-orders',
    system: 'system:orders',
    definition: 'component:payments-svc',
  }, { title: 'Payments API', description: 'Internal gateway for payment authorisation.' }),
  entity('API', 'order-events', {
    type: 'asyncapi',
    lifecycle: 'production',
    owner: 'group:team-orders',
    system: 'system:orders',
    definition: 'component:orders-svc',
  }, { title: 'Order Events', description: 'AsyncAPI v3 spec for the orders Kafka topic.' }),

  /* ─── Resources ─── */
  entity('Resource', 'cart-redis', {
    type: 'cache',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    provider: 'platform.adhar.io/Cache',
  }, { title: 'Cart Redis', description: 'HA Redis cluster for cart hold (TTL 30 min).' }),
  entity('Resource', 'catalog-pg', {
    type: 'database',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    provider: 'platform.adhar.io/Database',
  }, { title: 'Catalog Postgres', description: 'Source of truth for products + variants.' }),
  entity('Resource', 'catalog-search', {
    type: 'cluster',
    owner: 'group:team-commerce',
    system: 'system:storefront',
    provider: 'opensearch',
  }, { title: 'Catalog Search', description: 'OpenSearch — product search index.' }),
  entity('Resource', 'orders-pg', {
    type: 'database',
    owner: 'group:team-orders',
    system: 'system:orders',
    provider: 'platform.adhar.io/Database',
  }, { title: 'Orders Postgres', description: 'Order ledger + outbox table.' }),
  entity('Resource', 'orders-events', {
    type: 'topic',
    owner: 'group:team-orders',
    system: 'system:orders',
    provider: 'platform.adhar.io/Topic',
  }, { title: 'orders.events.v1', description: 'Kafka topic — domain events from Orders.' }),
  entity('Resource', 'payments-pg', {
    type: 'database',
    owner: 'group:team-orders',
    system: 'system:orders',
    provider: 'platform.adhar.io/Database',
  }, { title: 'Payments Postgres', description: 'PCI-segregated payment ledger.' }),
  entity('Resource', 'asset-bucket', {
    type: 'bucket',
    owner: 'group:team-platform',
    system: 'system:idp',
    provider: 'platform.adhar.io/Bucket',
  }, { title: 'Assets Bucket', description: 'S3 bucket for images + downloads.' }),
  entity('Resource', 'bronze-bucket', {
    type: 'bucket',
    owner: 'group:team-data',
    system: 'system:lakehouse',
    provider: 'platform.adhar.io/Bucket',
  }, { title: 'Bronze Bucket', description: 'Raw landing zone for the data lake.' }),
  entity('Resource', 'lake-events', {
    type: 'topic',
    owner: 'group:team-data',
    system: 'system:lakehouse',
    provider: 'platform.adhar.io/Topic',
  }, { title: 'lake.events', description: 'Kafka topic feeding the bronze layer.' }),
  entity('Resource', 'fraud-features', {
    type: 'database',
    owner: 'group:team-data',
    system: 'system:orders',
    provider: 'feast',
  }, { title: 'Feature Store', description: 'Feast online + offline store for fraud features.' }),
]

/* ─────────── persistence ─────────── */

const STORAGE_KEY = 'adhar.catalog.entities'

function readStore(): Entity[] | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Entity[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
function writeStore(entities: Entity[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entities))
  } catch {
    /* quota — ignore */
  }
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

async function fetchEntities(): Promise<Entity[]> {
  await delay(80)
  return readStore() ?? SEED_CATALOG
}

async function persistEntity(next: Entity): Promise<Entity> {
  await delay(160)
  const list = readStore() ?? SEED_CATALOG
  const idx = list.findIndex(
    (e) =>
      e.kind === next.kind &&
      (e.metadata.namespace ?? 'default') === (next.metadata.namespace ?? 'default') &&
      e.metadata.name === next.metadata.name,
  )
  const stamped: Entity = {
    ...next,
    metadata: { ...next.metadata, updatedAt: new Date().toISOString() },
  }
  const updated = idx >= 0 ? list.with(idx, stamped) : [stamped, ...list]
  writeStore(updated)
  return stamped
}

/* ─────────── React Query ─────────── */

const QUERY_KEY = ['catalog', 'entities'] as const

export function useCatalog() {
  return useQuery<Entity[]>({
    queryKey: QUERY_KEY,
    queryFn: fetchEntities,
    staleTime: 60_000,
    placeholderData: SEED_CATALOG,
  })
}

export function useRegisterEntity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: persistEntity,
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY })
      const prev = qc.getQueryData<Entity[]>(QUERY_KEY)
      const optimistic = prev ? mergeEntity(prev, next) : [next]
      qc.setQueryData<Entity[]>(QUERY_KEY, optimistic)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(QUERY_KEY, ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
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
