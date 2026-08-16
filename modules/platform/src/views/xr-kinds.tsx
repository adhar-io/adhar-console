import { StatusBadge } from '@adhar-console/shell-ui'
import { XrList, type XrKindConfig, type XrFormField } from './xr-list.tsx'

/**
 * Per-kind configuration for each Adhar Platform Crossplane composite. GVR
 * values here match the CompositeResourceDefinitions shipped with the Adhar
 * Platform Helm chart — override via BFF config once real XRDs land.
 *
 * Each kind carries `formFields` — the self-service creation wizard schema
 * rendered by <XrList/>. Field `key`s are spec paths (dot-notation) applied
 * verbatim to the claim, so they must match the XRD's openAPIV3Schema.
 */

/* ───── shared form fragments ───── */

const ENVIRONMENT_FIELD: XrFormField = {
  key: 'environment',
  label: 'Environment',
  type: 'select',
  required: true,
  default: 'dev',
  options: [
    { value: 'dev', label: 'Development' },
    { value: 'staging', label: 'Staging' },
    { value: 'prod', label: 'Production' },
  ],
  help: 'Controls placement, quotas, and change-approval policy.',
  group: 'Basics',
}

/** RFC 1123 DNS subdomain — hosts, FQDNs, bucket names. */
const DNS_PATTERN = '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'
/** RFC 1123 DNS label — single segment (namespaces, service names). */
const DNS_LABEL_PATTERN = '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'

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
  formFields: [
    {
      key: 'repo',
      label: 'Source repository',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'https://github.com/acme/orders-service',
      help: 'Git URL the platform links builds, PR previews, and drift checks to.',
      group: 'Basics',
    },
    {
      key: 'image',
      label: 'Container image',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'ghcr.io/acme/orders-service:v1.4.2',
      help: 'Fully-qualified image reference. Use a digest or immutable tag in prod.',
      group: 'Basics',
    },
    ENVIRONMENT_FIELD,
    {
      key: 'replicas',
      label: 'Replicas',
      type: 'number',
      default: 2,
      min: 1,
      max: 50,
      help: 'Desired pod count. Ignored while autoscaling is enabled.',
      group: 'Sizing',
    },
    {
      key: 'autoscale',
      label: 'Autoscale',
      type: 'boolean',
      default: false,
      help: 'Attach an HPA driven by CPU + RPS. Scales between 1 and 10× replicas.',
      group: 'Sizing',
    },
    {
      key: 'cpu',
      label: 'CPU request',
      type: 'select',
      default: '250m',
      options: [
        { value: '100m', label: '100m — background jobs' },
        { value: '250m', label: '250m — typical API' },
        { value: '500m', label: '500m — busy API' },
        { value: '1', label: '1 core — compute-heavy' },
        { value: '2', label: '2 cores — hot path' },
      ],
      group: 'Sizing',
    },
    {
      key: 'memory',
      label: 'Memory request',
      type: 'select',
      default: '256Mi',
      options: [
        { value: '128Mi', label: '128 MiB' },
        { value: '256Mi', label: '256 MiB' },
        { value: '512Mi', label: '512 MiB' },
        { value: '1Gi', label: '1 GiB' },
        { value: '2Gi', label: '2 GiB' },
      ],
      group: 'Sizing',
    },
    {
      key: 'port',
      label: 'Container port',
      type: 'number',
      default: 8080,
      min: 1,
      max: 65535,
      help: 'Port the container listens on; the Service and Route target this.',
      group: 'Networking',
    },
    {
      key: 'ingress',
      label: 'Expose via ingress',
      type: 'boolean',
      default: true,
      help: 'Provision a Route on the shared gateway. Disable for internal-only services.',
      group: 'Networking',
    },
  ],
  specFields: [
    { key: 'repo', label: 'Source repo', mono: true },
    { key: 'image', label: 'Image', mono: true },
    { key: 'replicas', label: 'Desired replicas' },
    { key: 'autoscale', label: 'Autoscale' },
    { key: 'environment', label: 'Environment' },
    { key: 'cpu', label: 'CPU request', mono: true },
    { key: 'memory', label: 'Memory request', mono: true },
    { key: 'port', label: 'Container port' },
    { key: 'ingress', label: 'Ingress' },
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
  connectionSecret: { nameTemplate: '{name}-conn' },
  formFields: [
    {
      key: 'engine',
      label: 'Engine',
      type: 'select',
      required: true,
      default: 'postgres',
      options: [
        { value: 'postgres', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
        { value: 'mongodb', label: 'MongoDB' },
      ],
      group: 'Basics',
    },
    {
      key: 'version',
      label: 'Engine version',
      type: 'text',
      mono: true,
      placeholder: '16',
      help: 'Major version. Leave empty for the platform default (latest LTS).',
      group: 'Basics',
    },
    ENVIRONMENT_FIELD,
    {
      key: 'size',
      label: 'Instance size',
      type: 'select',
      required: true,
      default: 'small',
      options: [
        { value: 'small', label: 'Small — 2 vCPU / 4 GiB' },
        { value: 'medium', label: 'Medium — 4 vCPU / 16 GiB' },
        { value: 'large', label: 'Large — 8 vCPU / 32 GiB' },
      ],
      group: 'Sizing',
    },
    {
      key: 'storageGb',
      label: 'Storage (GB)',
      type: 'number',
      default: 20,
      min: 10,
      max: 4096,
      help: 'Allocated volume size. Grows online; cannot shrink.',
      group: 'Sizing',
    },
    {
      key: 'highAvailability',
      label: 'High availability',
      type: 'boolean',
      default: false,
      help: 'Adds a synchronous standby in another zone with automatic failover.',
      group: 'Resilience',
    },
    {
      key: 'backupRetentionDays',
      label: 'Backup retention (days)',
      type: 'number',
      default: 7,
      min: 0,
      max: 35,
      help: 'Daily snapshots kept this long. 0 disables backups (dev only).',
      group: 'Resilience',
    },
  ],
  specFields: [
    { key: 'engine', label: 'Engine' },
    { key: 'version', label: 'Version', mono: true },
    { key: 'environment', label: 'Environment' },
    { key: 'size', label: 'Instance size' },
    { key: 'storageGb', label: 'Storage (GB)' },
    { key: 'highAvailability', label: 'High availability' },
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
  formFields: [
    {
      key: 'source',
      label: 'Source',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'postgres://orders-db/public.orders',
      help: 'Connector URI or claim reference the pipeline reads from.',
      group: 'Basics',
    },
    {
      key: 'destination',
      label: 'Destination',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 's3://lakehouse/iceberg/orders',
      help: 'Sink URI — Iceberg table, bucket prefix, or warehouse schema.',
      group: 'Basics',
    },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      required: true,
      default: 'batch',
      options: [
        { value: 'batch', label: 'Batch — scheduled sync' },
        { value: 'streaming', label: 'Streaming — continuous CDC' },
      ],
      group: 'Basics',
    },
    {
      key: 'schedule',
      label: 'Schedule (cron)',
      type: 'text',
      mono: true,
      placeholder: '0 */6 * * *',
      help: 'Cron expression, UTC. Only used for batch mode; leave empty for manual runs.',
      group: 'Execution',
    },
    {
      key: 'concurrency',
      label: 'Concurrency',
      type: 'number',
      default: 1,
      min: 1,
      max: 16,
      help: 'Max simultaneous sync workers. Raise for large partitioned sources.',
      group: 'Execution',
    },
  ],
  specFields: [
    { key: 'source', label: 'Source' },
    { key: 'destination', label: 'Destination' },
    { key: 'schedule', label: 'Schedule', mono: true },
    { key: 'mode', label: 'Mode' },
    { key: 'concurrency', label: 'Concurrency' },
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
  formFields: [
    {
      key: 'template',
      label: 'Pipeline template',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'build-test-deploy',
      help: 'Name of a shared WorkflowTemplate published in the platform catalog.',
      group: 'Basics',
    },
    {
      key: 'trigger',
      label: 'Trigger',
      type: 'select',
      required: true,
      default: 'push',
      options: [
        { value: 'push', label: 'On push to default branch' },
        { value: 'tag', label: 'On release tag' },
        { value: 'pr', label: 'On pull request' },
        { value: 'schedule', label: 'On schedule' },
        { value: 'manual', label: 'Manual only' },
      ],
      group: 'Basics',
    },
    {
      key: 'schedule',
      label: 'Schedule (cron)',
      type: 'text',
      mono: true,
      placeholder: '30 2 * * 1-5',
      help: 'Cron expression, UTC. Only used when trigger is "schedule".',
      group: 'Execution',
    },
    {
      key: 'parallelism',
      label: 'Parallelism',
      type: 'number',
      default: 1,
      min: 1,
      max: 32,
      help: 'Max steps running at once inside a single pipeline run.',
      group: 'Execution',
    },
    {
      key: 'timeoutSeconds',
      label: 'Timeout (seconds)',
      type: 'number',
      default: 3600,
      min: 60,
      max: 86400,
      help: 'Whole-run deadline; the run is failed and cleaned up after this.',
      group: 'Execution',
    },
  ],
  specFields: [
    { key: 'trigger', label: 'Trigger' },
    { key: 'template', label: 'Template', mono: true },
    { key: 'schedule', label: 'Schedule', mono: true },
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
  formFields: [
    {
      key: 'host',
      label: 'Host',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'orders.acme.dev',
      pattern: DNS_PATTERN,
      help: 'Public hostname. Must live in a zone managed by a Domain claim.',
      group: 'Basics',
    },
    {
      key: 'path',
      label: 'Path prefix',
      type: 'text',
      mono: true,
      default: '/',
      placeholder: '/api',
      help: 'Requests matching this prefix are routed to the target service.',
      group: 'Basics',
    },
    {
      key: 'target',
      label: 'Target service',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'orders-service:8080',
      pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(:[0-9]+)?$',
      help: 'Kubernetes Service name, optionally with port (name:port).',
      group: 'Basics',
    },
    {
      key: 'tls.enabled',
      label: 'TLS',
      type: 'boolean',
      default: true,
      help: 'Terminate HTTPS at the gateway with an automatically issued certificate.',
      group: 'Networking',
    },
    {
      key: 'rateLimit',
      label: 'Rate limit (req/s)',
      type: 'number',
      default: 0,
      min: 0,
      max: 100000,
      help: 'Per-client request ceiling enforced at the gateway. 0 disables limiting.',
      group: 'Networking',
    },
  ],
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
  connectionSecret: { nameTemplate: '{name}-conn' },
  formFields: [
    {
      key: 'engine',
      label: 'Engine',
      type: 'select',
      required: true,
      default: 'redis',
      options: [
        { value: 'redis', label: 'Redis' },
        { value: 'memcached', label: 'Memcached' },
        { value: 'dragonfly', label: 'Dragonfly' },
      ],
      group: 'Basics',
    },
    {
      key: 'version',
      label: 'Engine version',
      type: 'text',
      mono: true,
      placeholder: '7.2',
      help: 'Leave empty for the platform default.',
      group: 'Basics',
    },
    {
      key: 'size',
      label: 'Instance size',
      type: 'select',
      default: 'small',
      options: [
        { value: 'small', label: 'Small — 1 vCPU' },
        { value: 'medium', label: 'Medium — 2 vCPU' },
        { value: 'large', label: 'Large — 4 vCPU' },
      ],
      group: 'Sizing',
    },
    {
      key: 'memoryMb',
      label: 'Memory (MiB)',
      type: 'number',
      default: 512,
      min: 128,
      max: 65536,
      help: 'Working-set memory. Eviction kicks in when this fills up.',
      group: 'Sizing',
    },
    {
      key: 'replicas',
      label: 'Replicas',
      type: 'number',
      default: 1,
      min: 1,
      max: 5,
      help: '1 = single node; 2+ enables replica failover (Redis/Dragonfly only).',
      group: 'Sizing',
    },
    {
      key: 'evictionPolicy',
      label: 'Eviction policy',
      type: 'select',
      default: 'allkeys-lru',
      options: [
        { value: 'allkeys-lru', label: 'allkeys-lru — evict any key, LRU' },
        { value: 'allkeys-lfu', label: 'allkeys-lfu — evict any key, LFU' },
        { value: 'volatile-lru', label: 'volatile-lru — only keys with TTL' },
        { value: 'noeviction', label: 'noeviction — error when full' },
      ],
      help: 'What happens at the memory ceiling. Use noeviction only for queues.',
      group: 'Advanced',
    },
    {
      key: 'persistence',
      label: 'Persistence',
      type: 'boolean',
      default: false,
      help: 'Snapshot to disk (AOF/RDB) so data survives restarts. Adds write latency.',
      group: 'Advanced',
    },
    {
      key: 'tls',
      label: 'TLS in transit',
      type: 'boolean',
      default: true,
      help: 'Require encrypted client connections.',
      group: 'Advanced',
    },
  ],
  specFields: [
    { key: 'engine', label: 'Engine' },
    { key: 'version', label: 'Version', mono: true },
    { key: 'size', label: 'Instance size' },
    { key: 'memoryMb', label: 'Memory (MiB)' },
    { key: 'replicas', label: 'Replicas' },
    { key: 'evictionPolicy', label: 'Eviction policy', mono: true },
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
  connectionSecret: { nameTemplate: '{name}-conn' },
  formFields: [
    {
      key: 'provider',
      label: 'Provider',
      type: 'select',
      required: true,
      default: 'minio',
      options: [
        { value: 'minio', label: 'MinIO (in-cluster)' },
        { value: 's3', label: 'AWS S3' },
        { value: 'gcs', label: 'Google Cloud Storage' },
      ],
      group: 'Basics',
    },
    {
      key: 'region',
      label: 'Region',
      type: 'text',
      mono: true,
      placeholder: 'us-east-1',
      help: 'Cloud region. Ignored for in-cluster MinIO.',
      group: 'Basics',
    },
    {
      key: 'versioning',
      label: 'Object versioning',
      type: 'boolean',
      default: true,
      help: 'Keep prior object versions so overwrites and deletes are recoverable.',
      group: 'Data protection',
    },
    {
      key: 'encryption',
      label: 'Encryption at rest',
      type: 'select',
      default: 'aes256',
      options: [
        { value: 'aes256', label: 'AES-256 (provider-managed key)' },
        { value: 'kms', label: 'KMS (customer-managed key)' },
        { value: 'none', label: 'None' },
      ],
      group: 'Data protection',
    },
    {
      key: 'lifecycleDays',
      label: 'Lifecycle expiry (days)',
      type: 'number',
      default: 0,
      min: 0,
      max: 3650,
      help: 'Auto-delete objects older than this. 0 keeps objects forever.',
      group: 'Data protection',
    },
    {
      key: 'publicRead',
      label: 'Public read access',
      type: 'boolean',
      default: false,
      help: 'Allow unauthenticated GETs — static assets only. Flagged in compliance reports.',
      group: 'Access',
    },
  ],
  specFields: [
    { key: 'provider', label: 'Provider' },
    { key: 'region', label: 'Region', mono: true },
    { key: 'publicRead', label: 'Public read' },
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
        const pub = (r.spec as { publicRead?: boolean } | undefined)?.publicRead
        if (pub === undefined) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={pub ? 'degraded' : 'healthy'}>
            {pub ? 'public' : 'private'}
          </StatusBadge>
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
  connectionSecret: { nameTemplate: '{name}-conn' },
  formFields: [
    {
      key: 'broker',
      label: 'Broker',
      type: 'select',
      required: true,
      default: 'kafka',
      options: [
        { value: 'kafka', label: 'Kafka' },
        { value: 'nats', label: 'NATS JetStream' },
        { value: 'rabbitmq', label: 'RabbitMQ (exchange)' },
      ],
      group: 'Basics',
    },
    {
      key: 'partitions',
      label: 'Partitions',
      type: 'number',
      required: true,
      default: 3,
      min: 1,
      max: 200,
      help: 'Upper bound on consumer parallelism. Cannot be reduced later.',
      group: 'Shape',
    },
    {
      key: 'replicationFactor',
      label: 'Replication factor',
      type: 'number',
      default: 3,
      min: 1,
      max: 5,
      help: 'Broker copies per partition. 3 tolerates one broker loss.',
      group: 'Shape',
    },
    {
      key: 'retentionHours',
      label: 'Retention (hours)',
      type: 'number',
      default: 168,
      min: 1,
      max: 8760,
      help: 'How long events stay readable. Default is 7 days.',
      group: 'Retention',
    },
    {
      key: 'compaction',
      label: 'Log compaction',
      type: 'boolean',
      default: false,
      help: 'Keep only the latest record per key — for changelog/table topics.',
      group: 'Retention',
    },
    {
      key: 'schema',
      label: 'Schema reference',
      type: 'text',
      mono: true,
      placeholder: 'registry:/subjects/orders-value/versions/3',
      help: 'Optional schema-registry subject enforced on producers.',
      group: 'Advanced',
    },
  ],
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
  formFields: [
    {
      key: 'runtime',
      label: 'Runtime',
      type: 'select',
      required: true,
      default: 'nodejs20',
      options: [
        { value: 'nodejs20', label: 'Node.js 20' },
        { value: 'python312', label: 'Python 3.12' },
        { value: 'go122', label: 'Go 1.22' },
        { value: 'java21', label: 'Java 21' },
        { value: 'container', label: 'Custom container' },
      ],
      group: 'Basics',
    },
    {
      key: 'image',
      label: 'Image',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'ghcr.io/acme/thumbnailer:v0.3.1',
      help: 'Function image built by the platform buildpack or your own pipeline.',
      group: 'Basics',
    },
    {
      key: 'entrypoint',
      label: 'Entrypoint',
      type: 'text',
      mono: true,
      placeholder: 'src/handler.process',
      help: 'Handler symbol (module.function). Ignored for custom containers.',
      group: 'Basics',
    },
    {
      key: 'trigger',
      label: 'Trigger',
      type: 'select',
      required: true,
      default: 'http',
      options: [
        { value: 'http', label: 'HTTP — request/response' },
        { value: 'event', label: 'Event — bus subscription' },
        { value: 'cron', label: 'Cron — scheduled' },
      ],
      group: 'Invocation',
    },
    {
      key: 'schedule',
      label: 'Schedule (cron)',
      type: 'text',
      mono: true,
      placeholder: '*/15 * * * *',
      help: 'Cron expression, UTC. Only used when trigger is "cron".',
      group: 'Invocation',
    },
    {
      key: 'eventSource',
      label: 'Event source',
      type: 'text',
      mono: true,
      placeholder: 'topic:orders-events',
      help: 'Topic or queue claim to subscribe. Only used when trigger is "event".',
      group: 'Invocation',
    },
    {
      key: 'memoryMb',
      label: 'Memory (MiB)',
      type: 'number',
      default: 256,
      min: 64,
      max: 4096,
      group: 'Sizing',
    },
    {
      key: 'timeoutSeconds',
      label: 'Timeout (seconds)',
      type: 'number',
      default: 60,
      min: 1,
      max: 900,
      help: 'Per-invocation deadline before the call is aborted.',
      group: 'Sizing',
    },
    {
      key: 'minScale',
      label: 'Min replicas',
      type: 'number',
      default: 0,
      min: 0,
      max: 10,
      help: '0 enables scale-to-zero; set 1+ to avoid cold starts.',
      group: 'Sizing',
    },
    {
      key: 'maxScale',
      label: 'Max replicas',
      type: 'number',
      default: 10,
      min: 1,
      max: 100,
      group: 'Sizing',
    },
  ],
  specFields: [
    { key: 'runtime', label: 'Runtime' },
    { key: 'image', label: 'Image', mono: true },
    { key: 'entrypoint', label: 'Entrypoint', mono: true },
    { key: 'trigger', label: 'Trigger' },
    { key: 'schedule', label: 'Schedule', mono: true },
    { key: 'eventSource', label: 'Event source', mono: true },
    { key: 'memoryMb', label: 'Memory (MiB)' },
    { key: 'minScale', label: 'Min replicas' },
    { key: 'maxScale', label: 'Max replicas' },
    { key: 'timeoutSeconds', label: 'Timeout (s)' },
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
  formFields: [
    {
      key: 'engine',
      label: 'Engine',
      type: 'select',
      required: true,
      default: 'argo',
      options: [
        { value: 'argo', label: 'Argo Workflows' },
        { value: 'temporal', label: 'Temporal' },
      ],
      group: 'Basics',
    },
    {
      key: 'template',
      label: 'Template',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'nightly-reconciliation',
      help: 'WorkflowTemplate (Argo) or workflow type name (Temporal).',
      group: 'Basics',
    },
    {
      key: 'schedule',
      label: 'Schedule (cron)',
      type: 'text',
      mono: true,
      placeholder: '0 3 * * *',
      help: 'Cron expression, UTC. Leave empty for on-demand execution only.',
      group: 'Execution',
    },
    {
      key: 'concurrency',
      label: 'Concurrency',
      type: 'number',
      default: 1,
      min: 1,
      max: 64,
      help: 'Max simultaneous runs. 1 means a new run waits for the previous.',
      group: 'Execution',
    },
    {
      key: 'retries',
      label: 'Retries',
      type: 'number',
      default: 3,
      min: 0,
      max: 10,
      help: 'Automatic retries per failed step, with exponential backoff.',
      group: 'Execution',
    },
    {
      key: 'slaSeconds',
      label: 'SLA (seconds)',
      type: 'number',
      default: 0,
      min: 0,
      max: 604800,
      help: 'Alert fires if a run exceeds this. 0 disables SLA tracking.',
      group: 'Execution',
    },
  ],
  specFields: [
    { key: 'engine', label: 'Engine' },
    { key: 'template', label: 'Template', mono: true },
    { key: 'schedule', label: 'Schedule', mono: true },
    { key: 'concurrency', label: 'Concurrency' },
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
  formFields: [
    {
      key: 'tier',
      label: 'Tier',
      type: 'select',
      required: true,
      default: 'dev',
      options: [
        { value: 'dev', label: 'Development' },
        { value: 'staging', label: 'Staging' },
        { value: 'prod', label: 'Production' },
      ],
      help: 'Drives guardrails: prod tiers get change approval and stricter NetworkPolicy.',
      group: 'Basics',
    },
    {
      key: 'namespace',
      label: 'Namespace',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'team-orders-dev',
      pattern: DNS_LABEL_PATTERN,
      help: 'Namespace created and managed by this environment.',
      group: 'Basics',
    },
    {
      key: 'tenant',
      label: 'Tenant (team)',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'team-orders',
      pattern: DNS_LABEL_PATTERN,
      help: 'Owning team — grants that team RBAC on the namespace.',
      group: 'Basics',
    },
    {
      key: 'cluster',
      label: 'Cluster',
      type: 'text',
      mono: true,
      placeholder: 'apps-eu-1',
      help: 'Target cluster. Leave empty to let the scheduler place it.',
      group: 'Placement',
    },
    {
      key: 'cpuQuota',
      label: 'CPU quota (cores)',
      type: 'number',
      default: 8,
      min: 1,
      max: 256,
      help: 'ResourceQuota ceiling on requested CPU across the namespace.',
      group: 'Quotas',
    },
    {
      key: 'memoryQuotaGb',
      label: 'Memory quota (GiB)',
      type: 'number',
      default: 16,
      min: 1,
      max: 1024,
      help: 'ResourceQuota ceiling on requested memory across the namespace.',
      group: 'Quotas',
    },
    {
      key: 'observability',
      label: 'Observability wiring',
      type: 'boolean',
      default: true,
      help: 'Ship logs, metrics, and traces to the platform observability stack.',
      group: 'Quotas',
    },
  ],
  specFields: [
    { key: 'tier', label: 'Tier' },
    { key: 'namespace', label: 'Namespace', mono: true },
    { key: 'cluster', label: 'Cluster', mono: true },
    { key: 'tenant', label: 'Tenant', mono: true },
    { key: 'cpuQuota', label: 'CPU quota' },
    { key: 'memoryQuotaGb', label: 'Memory quota (GiB)' },
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
  formFields: [
    {
      key: 'fqdn',
      label: 'FQDN',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'api.acme.io',
      pattern: DNS_PATTERN,
      help: 'Fully-qualified domain name to manage.',
      group: 'Basics',
    },
    {
      key: 'zone',
      label: 'DNS zone',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'acme.io',
      pattern: DNS_PATTERN,
      help: 'Hosted zone the record is written into. Must be delegated to the platform.',
      group: 'Basics',
    },
    {
      key: 'dnsProvider',
      label: 'DNS provider',
      type: 'select',
      default: 'cloudflare',
      options: [
        { value: 'cloudflare', label: 'Cloudflare' },
        { value: 'route53', label: 'AWS Route 53' },
        { value: 'clouddns', label: 'Google Cloud DNS' },
        { value: 'rfc2136', label: 'RFC 2136 (on-prem BIND)' },
      ],
      group: 'Basics',
    },
    {
      key: 'certIssuer',
      label: 'TLS issuer',
      type: 'select',
      default: 'letsencrypt-prod',
      options: [
        { value: 'letsencrypt-prod', label: 'Let’s Encrypt (production)' },
        { value: 'letsencrypt-staging', label: 'Let’s Encrypt (staging)' },
        { value: 'internal-ca', label: 'Internal CA' },
        { value: 'none', label: 'None — DNS record only' },
      ],
      help: 'Automatic certificate issuance and renewal for this name.',
      group: 'TLS',
    },
    {
      key: 'aliasOf',
      label: 'Alias of',
      type: 'text',
      mono: true,
      placeholder: 'gateway.acme.io',
      help: 'Optional CNAME/alias target instead of pointing at the shared gateway.',
      group: 'Advanced',
    },
    {
      key: 'geo',
      label: 'Geo policy',
      type: 'select',
      default: 'none',
      options: [
        { value: 'none', label: 'None — single record' },
        { value: 'latency', label: 'Latency-based routing' },
        { value: 'geo', label: 'Geo-fenced routing' },
      ],
      group: 'Advanced',
    },
  ],
  specFields: [
    { key: 'fqdn', label: 'FQDN', mono: true },
    { key: 'zone', label: 'Zone', mono: true },
    { key: 'dnsProvider', label: 'DNS provider' },
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
  formFields: [
    {
      key: 'kind',
      label: 'Spec kind',
      type: 'select',
      required: true,
      default: 'openapi',
      options: [
        { value: 'openapi', label: 'OpenAPI 3.x' },
        { value: 'asyncapi', label: 'AsyncAPI 2.x' },
        { value: 'graphql', label: 'GraphQL SDL' },
      ],
      group: 'Basics',
    },
    {
      key: 'specRef',
      label: 'Spec source URL',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'https://github.com/acme/orders-service/blob/main/api/openapi.yaml',
      help: 'Canonical location of the spec document — Git path or registry URL.',
      group: 'Basics',
    },
    {
      key: 'version',
      label: 'Version',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'v1.4.0',
      pattern: '^v?\\d+(\\.\\d+){0,2}(-[0-9A-Za-z.-]+)?$',
      help: 'Semantic version of the published contract.',
      group: 'Basics',
    },
    {
      key: 'owner',
      label: 'Owner',
      type: 'text',
      required: true,
      placeholder: 'team-payments',
      help: 'Team accountable for the contract; routed alerts and reviews go here.',
      group: 'Governance',
    },
    {
      key: 'visibility',
      label: 'Visibility',
      type: 'select',
      default: 'internal',
      options: [
        { value: 'internal', label: 'Internal — this org only' },
        { value: 'partner', label: 'Partner — allow-listed consumers' },
        { value: 'public', label: 'Public — anyone' },
      ],
      group: 'Governance',
    },
    {
      key: 'sloMs',
      label: 'Latency SLO (ms)',
      type: 'number',
      default: 300,
      min: 1,
      max: 30000,
      help: 'p99 latency promise consumers can hold you to.',
      group: 'Governance',
    },
  ],
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

/* ───── high-value additions ─────────────────────────────────────────── */

const QUEUE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'messagequeues',
    namespaced: true,
  },
  singular: 'Queue',
  plural: 'Queues',
  description:
    'Point-to-point work queues — RabbitMQ queues or SQS-style claims with DLQ and retry policy.',
  docsHref: 'https://docs.adhar.io/platform/queues',
  connectionSecret: { nameTemplate: '{name}-conn' },
  formFields: [
    {
      key: 'type',
      label: 'Queue type',
      type: 'select',
      required: true,
      default: 'rabbitmq',
      options: [
        { value: 'rabbitmq', label: 'RabbitMQ' },
        { value: 'sqs', label: 'AWS SQS' },
        { value: 'nats', label: 'NATS work queue' },
      ],
      group: 'Basics',
    },
    {
      key: 'durable',
      label: 'Durable',
      type: 'boolean',
      default: true,
      help: 'Persist messages to disk so they survive broker restarts.',
      group: 'Basics',
    },
    {
      key: 'maxRetries',
      label: 'Max retries',
      type: 'number',
      default: 5,
      min: 0,
      max: 100,
      help: 'Delivery attempts before a message is parked in the dead-letter queue.',
      group: 'Delivery',
    },
    {
      key: 'dlq',
      label: 'Dead-letter queue',
      type: 'boolean',
      default: true,
      help: 'Provision a companion DLQ for poison messages. Strongly recommended.',
      group: 'Delivery',
    },
    {
      key: 'visibilityTimeoutSeconds',
      label: 'Visibility timeout (s)',
      type: 'number',
      default: 30,
      min: 1,
      max: 43200,
      help: 'How long a claimed message stays hidden before redelivery.',
      group: 'Delivery',
    },
    {
      key: 'messageTtlSeconds',
      label: 'Message TTL (s)',
      type: 'number',
      default: 0,
      min: 0,
      max: 1209600,
      help: 'Unconsumed messages expire after this. 0 keeps them until consumed.',
      group: 'Delivery',
    },
  ],
  specFields: [
    { key: 'type', label: 'Queue type' },
    { key: 'durable', label: 'Durable' },
    { key: 'dlq', label: 'Dead-letter queue' },
    { key: 'maxRetries', label: 'Max retries' },
    { key: 'visibilityTimeoutSeconds', label: 'Visibility timeout (s)' },
    { key: 'messageTtlSeconds', label: 'Message TTL (s)' },
  ],
  extraColumns: [
    {
      key: 'type',
      header: 'Type',
      cell: (r) => {
        const t = (r.spec as { type?: string } | undefined)?.type
        return t ? <code className="text-xs text-content-muted">{t}</code> : <span className="text-content-subtle">—</span>
      },
    },
    {
      key: 'dlq',
      header: 'DLQ',
      cell: (r) => {
        const d = (r.spec as { dlq?: boolean } | undefined)?.dlq
        if (d === undefined) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={d ? 'healthy' : 'degraded'}>{d ? 'enabled' : 'off'}</StatusBadge>
        )
      },
    },
  ],
}

const CERTIFICATE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'certificates',
    namespaced: true,
  },
  singular: 'Certificate',
  plural: 'Certificates',
  description:
    'TLS certificates via cert-manager — ACME or internal-CA issuance with automatic renewal.',
  docsHref: 'https://docs.adhar.io/platform/certificates',
  formFields: [
    {
      key: 'dnsNames',
      label: 'DNS names',
      type: 'textarea',
      required: true,
      mono: true,
      placeholder: 'api.acme.io\n*.apps.acme.io',
      help: 'One SAN per line. Wildcards require a DNS-01-capable issuer.',
      group: 'Basics',
    },
    {
      key: 'issuer',
      label: 'Issuer',
      type: 'select',
      required: true,
      default: 'letsencrypt-prod',
      options: [
        { value: 'letsencrypt-prod', label: 'Let’s Encrypt (production)' },
        { value: 'letsencrypt-staging', label: 'Let’s Encrypt (staging)' },
        { value: 'internal-ca', label: 'Internal CA' },
      ],
      help: 'ClusterIssuer that signs the certificate.',
      group: 'Basics',
    },
    {
      key: 'duration',
      label: 'Duration',
      type: 'text',
      mono: true,
      default: '2160h',
      pattern: '^\\d+(h|m|s)$',
      help: 'Certificate lifetime (Go duration). 2160h = 90 days.',
      group: 'Renewal',
    },
    {
      key: 'renewBefore',
      label: 'Renew before expiry',
      type: 'text',
      mono: true,
      default: '360h',
      pattern: '^\\d+(h|m|s)$',
      help: 'How far before expiry cert-manager rotates the certificate.',
      group: 'Renewal',
    },
  ],
  specFields: [
    { key: 'dnsNames', label: 'DNS names', mono: true },
    { key: 'issuer', label: 'Issuer' },
    { key: 'duration', label: 'Duration', mono: true },
    { key: 'renewBefore', label: 'Renew before', mono: true },
  ],
  extraColumns: [
    {
      key: 'issuer',
      header: 'Issuer',
      cell: (r) => {
        const i = (r.spec as { issuer?: string } | undefined)?.issuer
        if (!i) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={i === 'letsencrypt-staging' ? 'progressing' : 'healthy'}>
            {i}
          </StatusBadge>
        )
      },
    },
    {
      key: 'duration',
      header: 'Duration',
      cell: (r) => {
        const d = (r.spec as { duration?: string } | undefined)?.duration
        return d ? <code className="text-xs text-content-muted">{d}</code> : <span className="text-content-subtle">—</span>
      },
    },
  ],
}

const SECRET_STORE_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'secretstores',
    namespaced: true,
  },
  singular: 'Secret Store',
  plural: 'Secret Stores',
  description:
    'External-secrets backends — Vault, AWS/GCP/Azure secret managers wired into the namespace.',
  docsHref: 'https://docs.adhar.io/platform/secret-stores',
  connectionSecret: { nameTemplate: '{name}-conn' },
  formFields: [
    {
      key: 'provider',
      label: 'Provider',
      type: 'select',
      required: true,
      default: 'vault',
      options: [
        { value: 'vault', label: 'HashiCorp Vault' },
        { value: 'aws-secrets-manager', label: 'AWS Secrets Manager' },
        { value: 'gcp-secret-manager', label: 'GCP Secret Manager' },
        { value: 'azure-key-vault', label: 'Azure Key Vault' },
      ],
      group: 'Basics',
    },
    {
      key: 'path',
      label: 'Secrets path / prefix',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'secret/data/team-orders',
      help: 'Mount path (Vault) or name prefix (cloud managers) this store may read.',
      group: 'Basics',
    },
    {
      key: 'authMethod',
      label: 'Auth method',
      type: 'select',
      required: true,
      default: 'kubernetes',
      options: [
        { value: 'kubernetes', label: 'Kubernetes ServiceAccount' },
        { value: 'irsa', label: 'IRSA / workload identity' },
        { value: 'approle', label: 'Vault AppRole' },
        { value: 'token', label: 'Static token (dev only)' },
      ],
      help: 'How the store authenticates to the backend. Prefer workload identity.',
      group: 'Auth',
    },
    {
      key: 'refreshIntervalSeconds',
      label: 'Refresh interval (s)',
      type: 'number',
      default: 3600,
      min: 60,
      max: 86400,
      help: 'How often synced secrets are re-read from the backend.',
      group: 'Sync',
    },
  ],
  specFields: [
    { key: 'provider', label: 'Provider' },
    { key: 'path', label: 'Path', mono: true },
    { key: 'authMethod', label: 'Auth method' },
    { key: 'refreshIntervalSeconds', label: 'Refresh interval (s)' },
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
      key: 'auth',
      header: 'Auth',
      cell: (r) => {
        const a = (r.spec as { authMethod?: string } | undefined)?.authMethod
        if (!a) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={a === 'token' ? 'degraded' : 'healthy'}>{a}</StatusBadge>
        )
      },
    },
  ],
}

const LOAD_BALANCER_CONFIG: XrKindConfig = {
  gvr: {
    group: 'platform.adhar.io',
    version: 'v1alpha1',
    resource: 'loadbalancers',
    namespaced: true,
  },
  singular: 'Load Balancer',
  plural: 'Load Balancers',
  description:
    'L4 load balancers — internal or internet-facing VIPs with health checks, beyond the shared HTTP gateway.',
  docsHref: 'https://docs.adhar.io/platform/load-balancers',
  formFields: [
    {
      key: 'type',
      label: 'Exposure',
      type: 'select',
      required: true,
      default: 'internal',
      options: [
        { value: 'internal', label: 'Internal — VPC/cluster only' },
        { value: 'external', label: 'External — internet-facing' },
      ],
      help: 'External VIPs are flagged for security review on prod tiers.',
      group: 'Basics',
    },
    {
      key: 'protocol',
      label: 'Protocol',
      type: 'select',
      required: true,
      default: 'tcp',
      options: [
        { value: 'tcp', label: 'TCP' },
        { value: 'udp', label: 'UDP' },
        { value: 'http', label: 'HTTP (L7 passthrough)' },
      ],
      group: 'Basics',
    },
    {
      key: 'port',
      label: 'Listener port',
      type: 'number',
      required: true,
      default: 443,
      min: 1,
      max: 65535,
      group: 'Networking',
    },
    {
      key: 'targetService',
      label: 'Target service',
      type: 'text',
      required: true,
      mono: true,
      placeholder: 'orders-grpc',
      pattern: DNS_LABEL_PATTERN,
      help: 'Kubernetes Service the VIP forwards to.',
      group: 'Networking',
    },
    {
      key: 'targetPort',
      label: 'Target port',
      type: 'number',
      default: 8080,
      min: 1,
      max: 65535,
      group: 'Networking',
    },
    {
      key: 'healthCheckPath',
      label: 'Health-check path',
      type: 'text',
      mono: true,
      default: '/healthz',
      help: 'HTTP path probed for backend health. Ignored for raw TCP/UDP checks.',
      group: 'Health',
    },
    {
      key: 'healthCheckIntervalSeconds',
      label: 'Health-check interval (s)',
      type: 'number',
      default: 10,
      min: 1,
      max: 300,
      group: 'Health',
    },
  ],
  specFields: [
    { key: 'type', label: 'Exposure' },
    { key: 'protocol', label: 'Protocol' },
    { key: 'port', label: 'Listener port' },
    { key: 'targetService', label: 'Target service', mono: true },
    { key: 'targetPort', label: 'Target port' },
    { key: 'healthCheckPath', label: 'Health-check path', mono: true },
    { key: 'healthCheckIntervalSeconds', label: 'Health-check interval (s)' },
  ],
  extraColumns: [
    {
      key: 'type',
      header: 'Exposure',
      cell: (r) => {
        const t = (r.spec as { type?: string } | undefined)?.type
        if (!t) return <span className="text-content-subtle">—</span>
        return (
          <StatusBadge kind={t === 'external' ? 'progressing' : 'info'}>{t}</StatusBadge>
        )
      },
    },
    {
      key: 'listener',
      header: 'Listener',
      cell: (r) => {
        const s = r.spec as { protocol?: string; port?: number } | undefined
        if (!s?.protocol && !s?.port) return <span className="text-content-subtle">—</span>
        return (
          <code className="text-xs text-content-muted">
            {s?.protocol ?? 'tcp'}/{s?.port ?? '—'}
          </code>
        )
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
export function QueuesView({ namespace }: { namespace?: string }) {
  return <XrList config={QUEUE_CONFIG} namespace={namespace} />
}
export function CertificatesView({ namespace }: { namespace?: string }) {
  return <XrList config={CERTIFICATE_CONFIG} namespace={namespace} />
}
export function SecretStoresView({ namespace }: { namespace?: string }) {
  return <XrList config={SECRET_STORE_CONFIG} namespace={namespace} />
}
export function LoadBalancersView({ namespace }: { namespace?: string }) {
  return <XrList config={LOAD_BALANCER_CONFIG} namespace={namespace} />
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
    | 'queues'
    | 'functions'
    | 'workflows'
    | 'environments'
    | 'domains'
    | 'certificates'
    | 'secret-stores'
    | 'load-balancers'
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
  { id: 'queues', config: QUEUE_CONFIG, family: 'data' },
  { id: 'data-pipelines', config: DATA_PIPELINE_CONFIG, family: 'data' },
  { id: 'routes', config: ROUTE_CONFIG, family: 'connectivity' },
  { id: 'domains', config: DOMAIN_CONFIG, family: 'connectivity' },
  { id: 'load-balancers', config: LOAD_BALANCER_CONFIG, family: 'connectivity' },
  { id: 'api-contracts', config: APICONTRACT_CONFIG, family: 'connectivity' },
  { id: 'environments', config: ENVIRONMENT_CONFIG, family: 'governance' },
  { id: 'certificates', config: CERTIFICATE_CONFIG, family: 'governance' },
  { id: 'secret-stores', config: SECRET_STORE_CONFIG, family: 'governance' },
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
