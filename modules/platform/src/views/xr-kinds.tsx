import { StatusBadge } from '@adhar-console/shell-ui'
import { XrList, type XrKindConfig } from './xr-list.tsx'

/**
 * Per-kind configuration for each Adhar Platform Crossplane composite. GVR
 * values here match the CompositeResourceDefinitions shipped with the Adhar
 * Platform Helm chart — override via BFF config once real XRDs land.
 */

const APPLICATION_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'applications',
    namespaced: true,
  },
  singular: 'Application',
  plural: 'Applications',
  description:
    'End-to-end service claims — repo, image, runtime target, observability wiring.',
  docsHref: 'https://docs.adhar.io/platform/applications',
  specFields: [
    { key: 'repo', label: 'Source repo', mono: true },
    { key: 'image', label: 'Image', mono: true },
    { key: 'replicas', label: 'Desired replicas' },
    { key: 'environment', label: 'Environment' },
  ],
  extraColumns: [
    {
      key: 'env',
      header: 'Env',
      cell: (r) => {
        const env = (r.spec as { environment?: string } | undefined)?.environment
        if (!env) return <span className="text-content-subtle">—</span>
        return <StatusBadge kind={envKind(env)}>{env}</StatusBadge>
      },
    },
    {
      key: 'replicas',
      header: 'Replicas',
      numeric: true,
      cell: (r) => (r.spec as { replicas?: number } | undefined)?.replicas ?? '—',
    },
  ],
}

const DATABASE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'databases',
    namespaced: true,
  },
  singular: 'Database',
  plural: 'Databases',
  description:
    'Managed PostgreSQL / MySQL / Mongo claims — provisioned through Crossplane providers.',
  docsHref: 'https://docs.adhar.io/platform/databases',
  specFields: [
    { key: 'engine', label: 'Engine' },
    { key: 'version', label: 'Version', mono: true },
    { key: 'size', label: 'Instance size' },
    { key: 'storageGb', label: 'Storage (GB)' },
    { key: 'backupRetentionDays', label: 'Backup retention' },
  ],
  extraColumns: [
    {
      key: 'engine',
      header: 'Engine',
      cell: (r) => {
        const spec = r.spec as { engine?: string; version?: string } | undefined
        if (!spec?.engine) return <span className="text-content-subtle">—</span>
        return (
          <code className="text-xs text-content-muted">
            {spec.engine}
            {spec.version ? ` ${spec.version}` : ''}
          </code>
        )
      },
    },
    {
      key: 'size',
      header: 'Size',
      cell: (r) => {
        const s = r.spec as { size?: string; storageGb?: number } | undefined
        if (!s?.size && !s?.storageGb) return <span className="text-content-subtle">—</span>
        return (
          <span className="text-xs text-content-muted">
            {s.size ?? '—'}
            {s.storageGb ? ` · ${s.storageGb} GB` : ''}
          </span>
        )
      },
    },
  ],
}

const DATA_PIPELINE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'datapipelines',
    namespaced: true,
  },
  singular: 'Data Pipeline',
  plural: 'Data Pipelines',
  description:
    'ELT & streaming flows — Airbyte connectors, Iceberg tables, MinIO sinks composed end-to-end.',
  docsHref: 'https://docs.adhar.io/platform/data-pipelines',
  specFields: [
    { key: 'source', label: 'Source' },
    { key: 'destination', label: 'Destination' },
    { key: 'schedule', label: 'Schedule', mono: true },
    { key: 'mode', label: 'Mode' },
  ],
  extraColumns: [
    {
      key: 'source',
      header: 'Source → Dest',
      cell: (r) => {
        const s = r.spec as { source?: unknown; destination?: unknown } | undefined
        return (
          <code className="text-xs text-content-muted">
            {formatEndpoint(s?.source)} → {formatEndpoint(s?.destination)}
          </code>
        )
      },
    },
    {
      key: 'mode',
      header: 'Mode',
      cell: (r) => {
        const m = (r.spec as { mode?: string } | undefined)?.mode
        if (!m) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={m === 'streaming' ? 'progressing' : 'info'}>{m}</StatusBadge>
        )
      },
    },
  ],
}

const PIPELINE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'pipelines',
    namespaced: true,
  },
  singular: 'Pipeline',
  plural: 'Pipelines',
  description:
    'CI/CD pipelines — Argo Workflows templates + Tekton tasks composed into reusable pipelines.',
  docsHref: 'https://docs.adhar.io/platform/pipelines',
  specFields: [
    { key: 'trigger', label: 'Trigger' },
    { key: 'template', label: 'Template', mono: true },
    { key: 'parallelism', label: 'Parallelism' },
    { key: 'timeoutSeconds', label: 'Timeout (s)' },
  ],
  extraColumns: [
    {
      key: 'trigger',
      header: 'Trigger',
      cell: (r) => {
        const t = (r.spec as { trigger?: string } | undefined)?.trigger
        return t ? (
          <code className="text-xs text-content-muted">{t}</code>
        ) : (
          <span className="text-content-subtle">—</span>
        )
      },
    },
    {
      key: 'template',
      header: 'Template',
      cell: (r) => {
        const t = (r.spec as { template?: string } | undefined)?.template
        return t ? (
          <code className="text-xs text-content-muted">{t}</code>
        ) : (
          <span className="text-content-subtle">—</span>
        )
      },
    },
  ],
}

const ROUTE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'routes',
    namespaced: true,
  },
  singular: 'Route',
  plural: 'Routes',
  description:
    'Ingress + TLS + rate-limit composition — fronting applications on a shared gateway.',
  docsHref: 'https://docs.adhar.io/platform/routes',
  specFields: [
    { key: 'host', label: 'Host', mono: true },
    { key: 'path', label: 'Path', mono: true },
    { key: 'target', label: 'Target service' },
    { key: 'tls', label: 'TLS' },
    { key: 'rateLimit', label: 'Rate limit' },
  ],
  extraColumns: [
    {
      key: 'host',
      header: 'Host',
      cell: (r) => {
        const s = r.spec as { host?: string; path?: string } | undefined
        if (!s?.host) return <span className="text-content-subtle">—</span>
        return (
          <code className="text-xs text-content-muted">
            {s.host}
            {s.path ?? ''}
          </code>
        )
      },
    },
    {
      key: 'tls',
      header: 'TLS',
      cell: (r) => {
        const tls = (r.spec as { tls?: { enabled?: boolean } } | undefined)?.tls
        if (!tls) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={tls.enabled === false ? 'degraded' : 'healthy'}>
            {tls.enabled === false ? 'disabled' : 'enabled'}
          </StatusBadge>
        )
      },
    },
  ],
}

/* ───── new platform abstractions ───────────────────────────────────── */

const CACHE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'caches',
    namespaced: true,
  },
  singular: 'Cache',
  plural: 'Caches',
  description:
    'Managed Redis / Memcached / Dragonfly claims — provisioned with HA, persistence, and TLS.',
  docsHref: 'https://docs.adhar.io/platform/caches',
  specFields: [
    { key: 'engine', label: 'Engine' },
    { key: 'version', label: 'Version', mono: true },
    { key: 'size', label: 'Instance size' },
    { key: 'memoryMb', label: 'Memory (MiB)' },
    { key: 'replicas', label: 'Replicas' },
    { key: 'persistence', label: 'Persistence' },
    { key: 'tls', label: 'TLS' },
  ],
  extraColumns: [
    {
      key: 'engine',
      header: 'Engine',
      cell: (r) => {
        const s = r.spec as { engine?: string; version?: string } | undefined
        if (!s?.engine) return <span className="text-content-subtle">—</span>
        return (
          <code className="text-xs text-content-muted">
            {s.engine}
            {s.version ? ` ${s.version}` : ''}
          </code>
        )
      },
    },
    {
      key: 'memory',
      header: 'Memory',
      numeric: true,
      cell: (r) => {
        const m = (r.spec as { memoryMb?: number } | undefined)?.memoryMb
        return m ? <span className="text-xs">{m} MiB</span> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'replicas',
      header: 'Replicas',
      numeric: true,
      cell: (r) => (r.spec as { replicas?: number } | undefined)?.replicas ?? '—',
    },
  ],
}

const BUCKET_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'buckets',
    namespaced: true,
  },
  singular: 'Bucket',
  plural: 'Buckets',
  description:
    'Object-storage claims fronting S3 / MinIO / GCS — versioning, lifecycle, encryption, ACLs.',
  docsHref: 'https://docs.adhar.io/platform/buckets',
  specFields: [
    { key: 'provider', label: 'Provider' },
    { key: 'region', label: 'Region', mono: true },
    { key: 'visibility', label: 'Visibility' },
    { key: 'versioning', label: 'Versioning' },
    { key: 'encryption', label: 'Encryption' },
    { key: 'lifecycleDays', label: 'Lifecycle (days)' },
  ],
  extraColumns: [
    {
      key: 'provider',
      header: 'Provider',
      cell: (r) => {
        const p = (r.spec as { provider?: string } | undefined)?.provider
        return p ? <code className="text-xs text-content-muted">{p}</code> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'visibility',
      header: 'Visibility',
      cell: (r) => {
        const v = (r.spec as { visibility?: string } | undefined)?.visibility
        if (!v) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={v === 'public' ? 'degraded' : 'healthy'}>{v}</StatusBadge>
        )
      },
    },
  ],
}

const TOPIC_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'topics',
    namespaced: true,
  },
  singular: 'Topic',
  plural: 'Topics',
  description:
    'Event-bus subjects — Kafka topics, NATS subjects, RabbitMQ exchanges with retention + ACL bindings.',
  docsHref: 'https://docs.adhar.io/platform/topics',
  specFields: [
    { key: 'broker', label: 'Broker' },
    { key: 'partitions', label: 'Partitions' },
    { key: 'replicationFactor', label: 'Replication' },
    { key: 'retentionHours', label: 'Retention (h)' },
    { key: 'compaction', label: 'Compaction' },
    { key: 'schema', label: 'Schema', mono: true },
  ],
  extraColumns: [
    {
      key: 'broker',
      header: 'Broker',
      cell: (r) => {
        const b = (r.spec as { broker?: string } | undefined)?.broker
        return b ? <code className="text-xs text-content-muted">{b}</code> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'shape',
      header: 'Shape',
      cell: (r) => {
        const s = r.spec as { partitions?: number; replicationFactor?: number } | undefined
        if (!s?.partitions && !s?.replicationFactor) {
          return <span className="text-content-subtle">—</span>
        }
        return (
          <code className="text-xs text-content-muted">
            {s?.partitions ?? '—'}p × {s?.replicationFactor ?? '—'}r
          </code>
        )
      },
    },
  ],
}

const FUNCTION_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'functions',
    namespaced: true,
  },
  singular: 'Function',
  plural: 'Functions',
  description:
    'Serverless functions on Knative / OpenFaaS — scale-to-zero, autoscaling, event triggers.',
  docsHref: 'https://docs.adhar.io/platform/functions',
  specFields: [
    { key: 'runtime', label: 'Runtime' },
    { key: 'image', label: 'Image', mono: true },
    { key: 'minScale', label: 'Min replicas' },
    { key: 'maxScale', label: 'Max replicas' },
    { key: 'timeoutSeconds', label: 'Timeout (s)' },
    { key: 'eventSource', label: 'Event source', mono: true },
  ],
  extraColumns: [
    {
      key: 'runtime',
      header: 'Runtime',
      cell: (r) => {
        const rt = (r.spec as { runtime?: string } | undefined)?.runtime
        return rt ? <code className="text-xs text-content-muted">{rt}</code> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'scale',
      header: 'Scale',
      cell: (r) => {
        const s = r.spec as { minScale?: number; maxScale?: number } | undefined
        if (!s?.minScale && !s?.maxScale) {
          return <span className="text-content-subtle">—</span>
        }
        return (
          <code className="text-xs text-content-muted">
            {s?.minScale ?? 0} – {s?.maxScale ?? '∞'}
          </code>
        )
      },
    },
  ],
}

const WORKFLOW_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'workflows',
    namespaced: true,
  },
  singular: 'Workflow',
  plural: 'Workflows',
  description:
    'Long-running orchestrations — Temporal namespaces, Argo Workflows templates with schedules and SLAs.',
  docsHref: 'https://docs.adhar.io/platform/workflows',
  specFields: [
    { key: 'engine', label: 'Engine' },
    { key: 'template', label: 'Template', mono: true },
    { key: 'schedule', label: 'Schedule', mono: true },
    { key: 'slaSeconds', label: 'SLA (s)' },
    { key: 'retries', label: 'Retries' },
  ],
  extraColumns: [
    {
      key: 'engine',
      header: 'Engine',
      cell: (r) => {
        const e = (r.spec as { engine?: string } | undefined)?.engine
        if (!e) return <span className="text-content-subtle">—</span>
        return <StatusBadge kind="info">{e}</StatusBadge>
      },
    },
    {
      key: 'schedule',
      header: 'Schedule',
      cell: (r) => {
        const s = (r.spec as { schedule?: string } | undefined)?.schedule
        return s ? <code className="text-xs text-content-muted">{s}</code> : <span className="text-content-subtle">on-demand</span>
      },
    },
  ],
}

const ENVIRONMENT_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'environments',
    namespaced: false,
  },
  singular: 'Environment',
  plural: 'Environments',
  description:
    'A namespace blueprint — RBAC bindings, ResourceQuota, NetworkPolicy, observability wiring composed as one unit.',
  docsHref: 'https://docs.adhar.io/platform/environments',
  specFields: [
    { key: 'tier', label: 'Tier' },
    { key: 'cluster', label: 'Cluster', mono: true },
    { key: 'tenant', label: 'Tenant', mono: true },
    { key: 'cpuQuota', label: 'CPU quota' },
    { key: 'memoryQuota', label: 'Memory quota' },
    { key: 'observability', label: 'Observability' },
  ],
  extraColumns: [
    {
      key: 'tier',
      header: 'Tier',
      cell: (r) => {
        const tier = (r.spec as { tier?: string } | undefined)?.tier
        if (!tier) return <span className="text-content-subtle">—</span>
        return <StatusBadge kind={envKind(tier)}>{tier}</StatusBadge>
      },
    },
    {
      key: 'tenant',
      header: 'Tenant',
      cell: (r) => {
        const t = (r.spec as { tenant?: string } | undefined)?.tenant
        return t ? <code className="text-xs text-content-muted">{t}</code> : <span className="text-content-subtle">—</span>
      },
    },
  ],
}

const DOMAIN_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'domains',
    namespaced: true,
  },
  singular: 'Domain',
  plural: 'Domains',
  description:
    'Managed DNS records and TLS certificates — automatic ACME issuance, alias chains, geo policies.',
  docsHref: 'https://docs.adhar.io/platform/domains',
  specFields: [
    { key: 'fqdn', label: 'FQDN', mono: true },
    { key: 'zone', label: 'Zone', mono: true },
    { key: 'certIssuer', label: 'Cert issuer' },
    { key: 'aliasOf', label: 'Alias of', mono: true },
    { key: 'geo', label: 'Geo policy' },
  ],
  extraColumns: [
    {
      key: 'fqdn',
      header: 'FQDN',
      cell: (r) => {
        const f = (r.spec as { fqdn?: string } | undefined)?.fqdn
        return f ? <code className="text-xs text-content-muted">{f}</code> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'cert',
      header: 'TLS',
      cell: (r) => {
        const issuer = (r.spec as { certIssuer?: string } | undefined)?.certIssuer
        if (!issuer) return <StatusBadge kind="degraded">none</StatusBadge>
        return <StatusBadge kind="healthy">{issuer}</StatusBadge>
      },
    },
  ],
}

const APICONTRACT_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'apicontracts',
    namespaced: true,
  },
  singular: 'API Contract',
  plural: 'API Contracts',
  description:
    'Published API surfaces — OpenAPI / AsyncAPI / GraphQL specs with version, owner, and consumer SLOs.',
  docsHref: 'https://docs.adhar.io/platform/api-contracts',
  specFields: [
    { key: 'kind', label: 'Spec kind' },
    { key: 'specRef', label: 'Spec ref', mono: true },
    { key: 'version', label: 'Version', mono: true },
    { key: 'owner', label: 'Owner' },
    { key: 'visibility', label: 'Visibility' },
    { key: 'sloMs', label: 'SLO (ms)' },
  ],
  extraColumns: [
    {
      key: 'kind',
      header: 'Spec',
      cell: (r) => {
        const k = (r.spec as { kind?: string } | undefined)?.kind
        if (!k) return <span className="text-content-subtle">—</span>
        return <StatusBadge kind="info">{k}</StatusBadge>
      },
    },
    {
      key: 'version',
      header: 'Version',
      cell: (r) => {
        const v = (r.spec as { version?: string } | undefined)?.version
        return v ? <code className="text-xs text-content-muted">{v}</code> : <span className="text-content-subtle">—</span>
      },
    },
  ],
}

/* ───── exported views ───── */

export function ApplicationsView({ namespace }: { namespace?: string }) {
  return <XrList config={APPLICATION_CONFIG} namespace={namespace} />
}
export function DatabasesView({ namespace }: { namespace?: string }) {
  return <XrList config={DATABASE_CONFIG} namespace={namespace} />
}
export function DataPipelinesView({ namespace }: { namespace?: string }) {
  return <XrList config={DATA_PIPELINE_CONFIG} namespace={namespace} />
}
export function PipelinesView({ namespace }: { namespace?: string }) {
  return <XrList config={PIPELINE_CONFIG} namespace={namespace} />
}
export function RoutesView({ namespace }: { namespace?: string }) {
  return <XrList config={ROUTE_CONFIG} namespace={namespace} />
}
export function CachesView({ namespace }: { namespace?: string }) {
  return <XrList config={CACHE_CONFIG} namespace={namespace} />
}
export function BucketsView({ namespace }: { namespace?: string }) {
  return <XrList config={BUCKET_CONFIG} namespace={namespace} />
}
export function TopicsView({ namespace }: { namespace?: string }) {
  return <XrList config={TOPIC_CONFIG} namespace={namespace} />
}
export function FunctionsView({ namespace }: { namespace?: string }) {
  return <XrList config={FUNCTION_CONFIG} namespace={namespace} />
}
export function WorkflowsView({ namespace }: { namespace?: string }) {
  return <XrList config={WORKFLOW_CONFIG} namespace={namespace} />
}
export function EnvironmentsView() {
  return <XrList config={ENVIRONMENT_CONFIG} />
}
export function DomainsView({ namespace }: { namespace?: string }) {
  return <XrList config={DOMAIN_CONFIG} namespace={namespace} />
}
export function ApiContractsView({ namespace }: { namespace?: string }) {
  return <XrList config={APICONTRACT_CONFIG} namespace={namespace} />
}

/** Catalog of all platform abstractions — exposed so the home page can build
 * a dynamic catalog grid without re-listing each kind manually. */
export const PLATFORM_KINDS: ReadonlyArray<{
  id:
    | 'applications'
    | 'databases'
    | 'data-pipelines'
    | 'pipelines'
    | 'routes'
    | 'caches'
    | 'buckets'
    | 'topics'
    | 'functions'
    | 'workflows'
    | 'environments'
    | 'domains'
    | 'api-contracts'
  config: XrKindConfig
  family: 'compute' | 'data' | 'connectivity' | 'governance'
}> = [
  { id: 'applications', config: APPLICATION_CONFIG, family: 'compute' },
  { id: 'functions', config: FUNCTION_CONFIG, family: 'compute' },
  { id: 'workflows', config: WORKFLOW_CONFIG, family: 'compute' },
  { id: 'pipelines', config: PIPELINE_CONFIG, family: 'compute' },
  { id: 'databases', config: DATABASE_CONFIG, family: 'data' },
  { id: 'caches', config: CACHE_CONFIG, family: 'data' },
  { id: 'buckets', config: BUCKET_CONFIG, family: 'data' },
  { id: 'topics', config: TOPIC_CONFIG, family: 'data' },
  { id: 'data-pipelines', config: DATA_PIPELINE_CONFIG, family: 'data' },
  { id: 'routes', config: ROUTE_CONFIG, family: 'connectivity' },
  { id: 'domains', config: DOMAIN_CONFIG, family: 'connectivity' },
  { id: 'api-contracts', config: APICONTRACT_CONFIG, family: 'connectivity' },
  { id: 'environments', config: ENVIRONMENT_CONFIG, family: 'governance' },
]

/* ───── helpers ───── */

function envKind(env: string) {
  const e = env.toLowerCase()
  if (e === 'prod' || e === 'production') return 'failed'
  if (e === 'staging' || e === 'stage') return 'progressing'
  if (e === 'dev' || e === 'development') return 'info'
  return 'unknown' as const
}

function formatEndpoint(v: unknown): string {
  if (!v) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v && 'name' in v) {
    const name = (v as { name?: string }).name
    const type = (v as { type?: string }).type
    return type ? `${type}:${name ?? '—'}` : (name ?? '—')
  }
  return '—'
}
