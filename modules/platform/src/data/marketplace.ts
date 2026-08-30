import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { k8s } from '@adhar-console/api-clients'
import { client, useActiveCluster } from './client.ts'

/**
 * Adhar Marketplace — driven by the real Adhar **ApplicationSet**.
 *
 * The list of apps/tools comes from the `helm-charts-*` ApplicationSet(s)
 * (kind `ApplicationSet`, `argoproj.io/v1alpha1`, namespace `adhar-system`):
 * each `spec.generators[].list.elements[]` entry is one marketplace app
 * (`{ name|packageName, enabled, namespace, category, manifestPath, plane? }`),
 * read live through the per-user k8s gateway and cross-referenced with the
 * matching live ArgoCD `Application` for health/sync. Enabling/disabling an app
 * is a GitOps change — the toggle flips that element's `enabled` value in the
 * ApplicationSet YAML in Gitea (via the `/api/platform/appset/toggle` BFF
 * endpoint), and ArgoCD reconciles it.
 *
 * The curated chart catalogue below is retained only as **optional enrichment**
 * (icon, publisher, provenance, description) matched to an app by name — it is
 * never the source of the list or of the enabled state.
 */

export type ChartCategory =
  | 'observability'
  | 'database'
  | 'messaging'
  | 'cicd'
  | 'security'
  | 'networking'
  | 'storage'
  | 'identity'
  | 'data'
  | 'ai-ml'
  | 'developer'

export interface ChartValueField {
  key: string
  label: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'select'
  default?: string | number | boolean
  options?: string[]
  placeholder?: string
}

/** Where a package comes from. `community` = community-contributed. */
export type ChartSource = 'core' | 'partner' | 'community'

/** Supply-chain provenance — signing + vulnerability scanning. */
export interface ChartProvenance {
  /** Chart + images carry a verifiable signature. */
  signed: boolean
  signer?: string
  signature?: 'cosign' | 'notation' | 'none'
  /** Images were vulnerability-scanned at publish time. */
  scanned: boolean
  scanner?: 'trivy'
  grade?: 'A' | 'B' | 'C' | 'D' | 'F'
  criticalCves?: number
  highCves?: number
  /** An SBOM is attached to the OCI artifact. */
  sbom?: boolean
  scannedAt?: string
}

/** Compatibility contract with the cluster and the Adhar platform. */
export interface ChartCompatibility {
  minKubeVersion?: string
  maxKubeVersion?: string
  requiredCrds?: string[]
  requiredCapabilities?: string[]
  /** Chart ids this package expects to be installed first. */
  dependsOn?: string[]
  /** Adhar platform versions the package is tested against. */
  testedOn?: string[]
}

export interface ChartPublisher {
  name: string
  url?: string
  verifiedPublisher?: boolean
}

export interface MarketplaceChart {
  id: string
  name: string
  /** Friendly title shown in cards. Defaults to `name` if absent. */
  title?: string
  publisher: ChartPublisher
  /** Where the package comes from — Adhar core, partner, or community. */
  source: ChartSource
  /** Supply-chain provenance: signing + scanning. */
  provenance: ChartProvenance
  /** Compatibility contract with the cluster + platform. */
  compatibility: ChartCompatibility
  /** Helm repository (e.g. "bitnami"). */
  repository: string
  /** Repository URL. */
  repoUrl: string
  /** Latest chart version. */
  version: string
  /** Underlying app version (e.g. "16.4.0" for postgres). */
  appVersion: string
  description: string
  longDescription?: string
  category: ChartCategory
  /** Brand icon id from `@adhar-console/shell-ui` brand icons. */
  iconId?:
    | 'argocd'
    | 'argoworkflows'
    | 'argorollouts'
    | 'kargo'
    | 'kyverno'
    | 'keycloak'
    | 'harbor'
    | 'crossplane'
    | 'plane'
    | 'grafana'
    | 'prometheus'
    | 'loki'
    | 'tempo'
    | 'minio'
    | 'airbyte'
    | 'metabase'
    | 'iceberg'
    | 'kubernetes'
    | 'otel'
    | 'gitea'
  /** Tailwind tone for the icon tile + chip. */
  tone: 'sky' | 'emerald' | 'amber' | 'violet' | 'rose' | 'fuchsia' | 'brand' | 'slate'
  /** Star count or weekly downloads — purely cosmetic. */
  popularity: number
  /** Tags for search. */
  tags: string[]
  /** Suggested namespace for installation. */
  defaultNamespace: string
  /** Custom values fields. The full values.yaml stays opaque. */
  fields: ChartValueField[]
  /** Featured on home / staff-pick. */
  featured?: boolean
  /** Mark as verified (publisher-signed). */
  verified?: boolean
  /** Documentation URL. */
  docsUrl?: string
}

export const CATEGORY_LABEL: Record<ChartCategory, string> = {
  observability: 'Observability',
  database: 'Databases',
  messaging: 'Messaging',
  cicd: 'CI/CD & GitOps',
  security: 'Security',
  networking: 'Networking',
  storage: 'Storage',
  identity: 'Identity',
  data: 'Data',
  'ai-ml': 'AI / ML',
  developer: 'Developer',
}

export const SOURCE_LABEL: Record<ChartSource, string> = {
  core: 'Core',
  partner: 'Partner',
  community: 'Community',
}

/** Signed + scanned — the bar for the trust shield in the UI. */
export function hasFullTrust(chart: MarketplaceChart): boolean {
  return chart.provenance.signed && chart.provenance.scanned
}

/**
 * Seed authoring type. `publisher` is shorthand (just the name) and the
 * trust metadata is optional — `withTrustDefaults` fills in the core-chart
 * baseline (Adhar-signed via cosign, Trivy-scanned grade A, SBOM attached)
 * so only packages with a weaker or richer story spell it out.
 */
type SeedChart = Omit<MarketplaceChart, 'publisher' | 'source' | 'provenance' | 'compatibility'> & {
  publisher: string
  publisherUrl?: string
  verifiedPublisher?: boolean
  source?: ChartSource
  provenance?: Partial<ChartProvenance>
  compatibility?: ChartCompatibility
}

const CORE_SCANNED_AT = '2026-08-11T04:30:00Z'

const CORE_PROVENANCE: ChartProvenance = {
  signed: true,
  signer: 'Adhar Release Engineering',
  signature: 'cosign',
  scanned: true,
  scanner: 'trivy',
  grade: 'A',
  criticalCves: 0,
  highCves: 0,
  sbom: true,
  scannedAt: CORE_SCANNED_AT,
}

/** Honest default for anything not vouched for: unsigned, unscanned. */
const UNVERIFIED_PROVENANCE: ChartProvenance = {
  signed: false,
  signature: 'none',
  scanned: false,
}

const CORE_COMPATIBILITY: ChartCompatibility = {
  minKubeVersion: '1.27',
  testedOn: ['adhar-1.4', 'adhar-1.5'],
}

function withTrustDefaults(seed: SeedChart): MarketplaceChart {
  const { publisher, publisherUrl, verifiedPublisher, source, provenance, compatibility, ...rest } = seed
  const resolvedSource = source ?? (seed.verified ? 'core' : 'partner')
  const baseline = resolvedSource === 'core' ? CORE_PROVENANCE : UNVERIFIED_PROVENANCE
  return {
    ...rest,
    source: resolvedSource,
    publisher: {
      name: publisher,
      url: publisherUrl,
      verifiedPublisher: verifiedPublisher ?? resolvedSource === 'core',
    },
    provenance: { ...baseline, ...provenance },
    compatibility: compatibility ?? (resolvedSource === 'core' ? { ...CORE_COMPATIBILITY } : {}),
  }
}

const SEED_CATALOG: SeedChart[] = [
  /* ──── Observability ──── */
  {
    id: 'grafana',
    name: 'grafana',
    publisher: 'Grafana Labs',
    repository: 'grafana',
    repoUrl: 'https://grafana.github.io/helm-charts',
    version: '8.5.4',
    appVersion: '11.3.0',
    description: 'Operational dashboards for every datasource — Prometheus, Loki, Tempo, more.',
    longDescription:
      'Grafana is the open-source analytics and interactive visualization web app. It provides charts, graphs, and alerts when connected to supported data sources.',
    category: 'observability',
    iconId: 'grafana',
    tone: 'amber',
    popularity: 9_245_000,
    tags: ['dashboards', 'metrics', 'logs', 'traces', 'visualization'],
    defaultNamespace: 'monitoring',
    fields: [
      { key: 'adminUser', label: 'Admin user', type: 'string', default: 'admin' },
      { key: 'adminPassword', label: 'Admin password', type: 'string', placeholder: 'auto-generate' },
      { key: 'persistence.enabled', label: 'Persistent storage', type: 'boolean', default: true },
      { key: 'persistence.size', label: 'Storage size', type: 'string', default: '10Gi' },
      { key: 'service.type', label: 'Service type', type: 'select', options: ['ClusterIP', 'NodePort', 'LoadBalancer'], default: 'ClusterIP' },
    ],
    featured: true,
    verified: true,
    docsUrl: 'https://grafana.com/docs/grafana/latest/',
  },
  {
    id: 'kube-prometheus-stack',
    name: 'kube-prometheus-stack',
    title: 'kube-prometheus-stack',
    publisher: 'Prometheus Community',
    repository: 'prometheus-community',
    repoUrl: 'https://prometheus-community.github.io/helm-charts',
    version: '67.4.0',
    appVersion: '0.79.0',
    description: 'Prometheus, Alertmanager and Grafana bundled with default cluster recordings.',
    category: 'observability',
    iconId: 'prometheus',
    tone: 'rose',
    popularity: 12_400_000,
    tags: ['prometheus', 'alertmanager', 'grafana', 'metrics', 'alerts'],
    defaultNamespace: 'monitoring',
    fields: [
      { key: 'prometheus.prometheusSpec.retention', label: 'Retention', type: 'string', default: '15d' },
      { key: 'prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage', label: 'Storage size', type: 'string', default: '50Gi' },
      { key: 'alertmanager.enabled', label: 'Enable Alertmanager', type: 'boolean', default: true },
      { key: 'grafana.enabled', label: 'Bundle Grafana', type: 'boolean', default: true },
    ],
    featured: true,
    verified: true,
    compatibility: {
      minKubeVersion: '1.28',
      requiredCapabilities: ['crd-install'],
      testedOn: ['adhar-1.4', 'adhar-1.5'],
    },
  },
  {
    id: 'loki',
    name: 'loki',
    publisher: 'Grafana Labs',
    repository: 'grafana',
    repoUrl: 'https://grafana.github.io/helm-charts',
    version: '6.18.0',
    appVersion: '3.3.0',
    description: 'Horizontally-scalable, highly-available log aggregation inspired by Prometheus.',
    category: 'observability',
    iconId: 'loki',
    tone: 'violet',
    popularity: 4_120_000,
    tags: ['logs', 'aggregation', 'search', 'logql'],
    defaultNamespace: 'monitoring',
    fields: [
      { key: 'deploymentMode', label: 'Deployment mode', type: 'select', options: ['SingleBinary', 'SimpleScalable', 'Distributed'], default: 'SingleBinary' },
      { key: 'loki.auth_enabled', label: 'Multi-tenant auth', type: 'boolean', default: false },
      { key: 'persistence.size', label: 'Storage size', type: 'string', default: '20Gi' },
    ],
    verified: true,
  },
  {
    id: 'tempo',
    name: 'tempo',
    publisher: 'Grafana Labs',
    repository: 'grafana',
    repoUrl: 'https://grafana.github.io/helm-charts',
    version: '1.16.0',
    appVersion: '2.6.1',
    description: 'High-volume distributed tracing backend — OTLP, Jaeger, Zipkin compatible.',
    category: 'observability',
    iconId: 'tempo',
    tone: 'rose',
    popularity: 1_840_000,
    tags: ['traces', 'tracing', 'otlp', 'jaeger'],
    defaultNamespace: 'monitoring',
    fields: [
      { key: 'tempo.retention', label: 'Retention', type: 'string', default: '24h' },
      { key: 'persistence.size', label: 'Storage size', type: 'string', default: '50Gi' },
    ],
    verified: true,
  },
  {
    id: 'opentelemetry-collector',
    name: 'opentelemetry-collector',
    title: 'OpenTelemetry Collector',
    publisher: 'OpenTelemetry',
    repository: 'open-telemetry',
    repoUrl: 'https://open-telemetry.github.io/opentelemetry-helm-charts',
    version: '0.108.0',
    appVersion: '0.114.0',
    description: 'Vendor-neutral collector for traces, metrics, and logs.',
    category: 'observability',
    iconId: 'otel',
    tone: 'sky',
    popularity: 3_650_000,
    tags: ['otel', 'opentelemetry', 'collector', 'pipeline'],
    defaultNamespace: 'monitoring',
    fields: [
      { key: 'mode', label: 'Mode', type: 'select', options: ['daemonset', 'deployment', 'statefulset', 'sidecar'], default: 'deployment' },
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 2 },
    ],
    verified: true,
  },

  /* ──── Databases ──── */
  {
    id: 'postgresql',
    name: 'postgresql',
    title: 'PostgreSQL',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '16.2.4',
    appVersion: '17.2.0',
    description: 'Production-ready PostgreSQL — primary, replicas, metrics, backups.',
    category: 'database',
    tone: 'sky',
    popularity: 28_000_000,
    tags: ['postgres', 'sql', 'database', 'rdbms'],
    defaultNamespace: 'data',
    fields: [
      { key: 'auth.postgresPassword', label: 'Postgres password', type: 'string', placeholder: 'auto-generate' },
      { key: 'auth.username', label: 'Application user', type: 'string', default: 'app' },
      { key: 'auth.database', label: 'Database name', type: 'string', default: 'appdb' },
      { key: 'architecture', label: 'Architecture', type: 'select', options: ['standalone', 'replication'], default: 'standalone' },
      { key: 'primary.persistence.size', label: 'Storage size', type: 'string', default: '8Gi' },
    ],
    featured: true,
    verified: true,
  },
  {
    id: 'redis',
    name: 'redis',
    title: 'Redis',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '20.5.0',
    appVersion: '7.4.1',
    description: 'In-memory data structure store — cache, queue, pub/sub.',
    category: 'database',
    tone: 'rose',
    popularity: 22_300_000,
    tags: ['cache', 'kv', 'queue', 'pubsub'],
    defaultNamespace: 'data',
    fields: [
      { key: 'auth.password', label: 'Auth password', type: 'string', placeholder: 'auto-generate' },
      { key: 'architecture', label: 'Architecture', type: 'select', options: ['standalone', 'replication'], default: 'replication' },
      { key: 'replica.replicaCount', label: 'Replicas', type: 'number', default: 3 },
    ],
    featured: true,
    verified: true,
  },
  {
    id: 'mongodb',
    name: 'mongodb',
    title: 'MongoDB',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '16.2.0',
    appVersion: '8.0.4',
    description: 'Document database with rich query language and aggregation pipeline.',
    category: 'database',
    tone: 'emerald',
    popularity: 11_500_000,
    tags: ['nosql', 'document', 'database'],
    defaultNamespace: 'data',
    fields: [
      { key: 'auth.rootPassword', label: 'Root password', type: 'string', placeholder: 'auto-generate' },
      { key: 'architecture', label: 'Architecture', type: 'select', options: ['standalone', 'replicaset'], default: 'replicaset' },
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 3 },
    ],
    verified: true,
  },
  {
    id: 'clickhouse',
    name: 'clickhouse',
    title: 'ClickHouse',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '8.0.6',
    appVersion: '24.10.1',
    description: 'Columnar OLAP database for real-time analytics on petabytes.',
    category: 'database',
    tone: 'amber',
    popularity: 980_000,
    tags: ['olap', 'analytics', 'columnar', 'sql'],
    defaultNamespace: 'data',
    fields: [
      { key: 'shards', label: 'Shards', type: 'number', default: 2 },
      { key: 'replicaCount', label: 'Replicas / shard', type: 'number', default: 2 },
    ],
    verified: true,
  },
  {
    id: 'cassandra',
    name: 'cassandra',
    title: 'Apache Cassandra',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '12.1.5',
    appVersion: '4.1.7',
    description: 'Wide-column distributed database for massive write workloads.',
    category: 'database',
    tone: 'violet',
    popularity: 540_000,
    tags: ['nosql', 'distributed', 'wide-column'],
    defaultNamespace: 'data',
    fields: [
      { key: 'cluster.replicaCount', label: 'Replicas', type: 'number', default: 3 },
      { key: 'persistence.size', label: 'Storage size', type: 'string', default: '8Gi' },
    ],
    source: 'partner',
    publisherUrl: 'https://bitnami.com',
    verifiedPublisher: true,
    provenance: {
      signed: true,
      signer: 'Bitnami (Broadcom)',
      signature: 'cosign',
      scanned: true,
      scanner: 'trivy',
      grade: 'B',
      criticalCves: 0,
      highCves: 3,
      sbom: true,
      scannedAt: '2026-08-06T09:12:00Z',
    },
    compatibility: { minKubeVersion: '1.25', testedOn: ['adhar-1.4'] },
  },

  /* ──── Messaging ──── */
  {
    id: 'kafka',
    name: 'kafka',
    title: 'Apache Kafka',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '31.1.1',
    appVersion: '3.9.0',
    description: 'Distributed streaming platform — pub/sub, log, processing.',
    category: 'messaging',
    tone: 'slate',
    popularity: 8_900_000,
    tags: ['streaming', 'queue', 'pubsub', 'kraft'],
    defaultNamespace: 'data',
    fields: [
      { key: 'controller.replicaCount', label: 'Controller replicas', type: 'number', default: 3 },
      { key: 'broker.replicaCount', label: 'Broker replicas', type: 'number', default: 3 },
      { key: 'kraft.enabled', label: 'KRaft mode', type: 'boolean', default: true },
    ],
    verified: true,
  },
  {
    id: 'rabbitmq',
    name: 'rabbitmq',
    title: 'RabbitMQ',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '14.7.0',
    appVersion: '4.0.4',
    description: 'AMQP message broker with rich routing topologies and clustering.',
    category: 'messaging',
    tone: 'amber',
    popularity: 5_200_000,
    tags: ['amqp', 'broker', 'queue'],
    defaultNamespace: 'data',
    fields: [
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 3 },
      { key: 'auth.username', label: 'Default user', type: 'string', default: 'admin' },
      { key: 'auth.password', label: 'Default password', type: 'string', placeholder: 'auto-generate' },
    ],
    verified: true,
  },
  {
    id: 'nats',
    name: 'nats',
    title: 'NATS',
    publisher: 'NATS',
    repository: 'nats',
    repoUrl: 'https://nats-io.github.io/k8s/helm/charts/',
    version: '1.2.5',
    appVersion: '2.10.22',
    description: 'High-performance pub/sub messaging with JetStream persistence.',
    category: 'messaging',
    tone: 'emerald',
    popularity: 2_400_000,
    tags: ['pubsub', 'streaming', 'jetstream', 'rpc'],
    defaultNamespace: 'data',
    fields: [
      { key: 'cluster.enabled', label: 'Cluster mode', type: 'boolean', default: true },
      { key: 'cluster.replicas', label: 'Replicas', type: 'number', default: 3 },
      { key: 'jetstream.enabled', label: 'Enable JetStream', type: 'boolean', default: true },
    ],
    verified: true,
  },

  /* ──── CI/CD & GitOps ──── */
  {
    id: 'argo-cd',
    name: 'argo-cd',
    title: 'Argo CD',
    publisher: 'Argo Project',
    repository: 'argo',
    repoUrl: 'https://argoproj.github.io/argo-helm',
    version: '7.7.6',
    appVersion: 'v2.13.1',
    description: 'GitOps continuous delivery for Kubernetes — declarative apps from Git.',
    category: 'cicd',
    iconId: 'argocd',
    tone: 'sky',
    popularity: 24_300_000,
    tags: ['gitops', 'cd', 'argo'],
    defaultNamespace: 'argocd',
    fields: [
      { key: 'configs.params.server.insecure', label: 'API server insecure', type: 'boolean', default: false },
      { key: 'server.ingress.enabled', label: 'Enable ingress', type: 'boolean', default: false },
      { key: 'controller.replicas', label: 'Controller replicas', type: 'number', default: 1 },
    ],
    featured: true,
    verified: true,
    docsUrl: 'https://argo-cd.readthedocs.io/',
  },
  {
    id: 'argo-workflows',
    name: 'argo-workflows',
    title: 'Argo Workflows',
    publisher: 'Argo Project',
    repository: 'argo',
    repoUrl: 'https://argoproj.github.io/argo-helm',
    version: '0.45.5',
    appVersion: 'v3.6.2',
    description: 'Container-native workflow engine for orchestrating jobs on Kubernetes.',
    category: 'cicd',
    iconId: 'argoworkflows',
    tone: 'amber',
    popularity: 3_120_000,
    tags: ['workflows', 'jobs', 'pipelines'],
    defaultNamespace: 'argo',
    fields: [
      { key: 'controller.workflowNamespaces', label: 'Watched namespaces', type: 'string', placeholder: 'leave blank for all' },
      { key: 'server.serviceType', label: 'Service type', type: 'select', options: ['ClusterIP', 'NodePort', 'LoadBalancer'], default: 'ClusterIP' },
    ],
    verified: true,
  },
  {
    id: 'argo-rollouts',
    name: 'argo-rollouts',
    title: 'Argo Rollouts',
    publisher: 'Argo Project',
    repository: 'argo',
    repoUrl: 'https://argoproj.github.io/argo-helm',
    version: '2.38.2',
    appVersion: 'v1.7.2',
    description: 'Progressive delivery — blue/green, canary, with traffic-shaping integrations.',
    category: 'cicd',
    iconId: 'argorollouts',
    tone: 'rose',
    popularity: 1_200_000,
    tags: ['canary', 'blue-green', 'rollouts', 'progressive-delivery'],
    defaultNamespace: 'argo-rollouts',
    fields: [
      { key: 'dashboard.enabled', label: 'Enable dashboard', type: 'boolean', default: true },
      { key: 'controller.replicas', label: 'Controller replicas', type: 'number', default: 2 },
    ],
    verified: true,
  },
  {
    id: 'kargo',
    name: 'kargo',
    title: 'Kargo',
    publisher: 'Akuity',
    repository: 'akuity',
    repoUrl: 'https://charts.kargo.io',
    version: '1.1.0',
    appVersion: 'v1.1.1',
    description: 'Multi-stage promotion across environments — built on Argo CD.',
    category: 'cicd',
    iconId: 'kargo',
    tone: 'brand',
    popularity: 240_000,
    tags: ['promotion', 'gitops', 'pipelines', 'argocd'],
    defaultNamespace: 'kargo',
    fields: [
      { key: 'api.enabled', label: 'Enable API', type: 'boolean', default: true },
      { key: 'controller.replicas', label: 'Controller replicas', type: 'number', default: 1 },
    ],
    verified: true,
    compatibility: {
      minKubeVersion: '1.29',
      requiredCrds: ['applications.argoproj.io'],
      dependsOn: ['argo-cd', 'cert-manager'],
      testedOn: ['adhar-1.5'],
    },
  },
  {
    id: 'flux',
    name: 'flux2',
    title: 'Flux',
    publisher: 'Flux CD',
    repository: 'fluxcd-community',
    repoUrl: 'https://fluxcd-community.github.io/helm-charts',
    version: '2.14.0',
    appVersion: '2.4.0',
    description: 'Toolkit of GitOps source / kustomize / helm controllers.',
    category: 'cicd',
    tone: 'fuchsia',
    popularity: 4_700_000,
    tags: ['gitops', 'flux', 'kustomize'],
    defaultNamespace: 'flux-system',
    fields: [
      { key: 'sourceController.create', label: 'Source controller', type: 'boolean', default: true },
      { key: 'kustomizeController.create', label: 'Kustomize controller', type: 'boolean', default: true },
      { key: 'helmController.create', label: 'Helm controller', type: 'boolean', default: true },
    ],
    source: 'partner',
    publisherUrl: 'https://fluxcd.io',
    verifiedPublisher: true,
    provenance: {
      signed: true,
      signer: 'Flux CD maintainers',
      signature: 'cosign',
      scanned: true,
      scanner: 'trivy',
      grade: 'A',
      criticalCves: 0,
      highCves: 1,
      sbom: true,
      scannedAt: '2026-08-04T22:41:00Z',
    },
    compatibility: {
      minKubeVersion: '1.28',
      requiredCapabilities: ['crd-install'],
      testedOn: ['adhar-1.5'],
    },
  },

  /* ──── Security ──── */
  {
    id: 'cert-manager',
    name: 'cert-manager',
    title: 'cert-manager',
    publisher: 'Jetstack',
    repository: 'jetstack',
    repoUrl: 'https://charts.jetstack.io',
    version: 'v1.16.2',
    appVersion: 'v1.16.2',
    description: 'Automatic certificate management — Let\'s Encrypt, Vault, ACME-compatible CAs.',
    category: 'security',
    tone: 'emerald',
    popularity: 18_700_000,
    tags: ['tls', 'certificates', 'letsencrypt', 'acme'],
    defaultNamespace: 'cert-manager',
    fields: [
      { key: 'crds.enabled', label: 'Install CRDs', type: 'boolean', default: true },
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 1 },
      { key: 'prometheus.enabled', label: 'Prometheus metrics', type: 'boolean', default: true },
    ],
    featured: true,
    verified: true,
    compatibility: {
      minKubeVersion: '1.27',
      requiredCapabilities: ['crd-install'],
      testedOn: ['adhar-1.4', 'adhar-1.5'],
    },
  },
  {
    id: 'kyverno',
    name: 'kyverno',
    title: 'Kyverno',
    publisher: 'Nirmata',
    repository: 'kyverno',
    repoUrl: 'https://kyverno.github.io/kyverno',
    version: '3.3.4',
    appVersion: 'v1.13.2',
    description: 'Kubernetes-native policy engine — validate, mutate, generate, verify images.',
    category: 'security',
    iconId: 'kyverno',
    tone: 'fuchsia',
    popularity: 2_950_000,
    tags: ['policy', 'admission', 'compliance'],
    defaultNamespace: 'kyverno',
    fields: [
      { key: 'admissionController.replicas', label: 'Admission replicas', type: 'number', default: 3 },
      { key: 'reportsController.enabled', label: 'Reports controller', type: 'boolean', default: true },
      { key: 'cleanupController.enabled', label: 'Cleanup controller', type: 'boolean', default: true },
    ],
    verified: true,
  },
  {
    id: 'falco',
    name: 'falco',
    title: 'Falco',
    publisher: 'Falco',
    repository: 'falcosecurity',
    repoUrl: 'https://falcosecurity.github.io/charts',
    version: '4.18.0',
    appVersion: '0.39.2',
    description: 'Runtime security — eBPF-driven detection of suspicious activity.',
    category: 'security',
    tone: 'rose',
    popularity: 1_280_000,
    tags: ['runtime-security', 'ebpf', 'threat-detection'],
    defaultNamespace: 'falco',
    fields: [
      { key: 'driver.kind', label: 'Driver', type: 'select', options: ['ebpf', 'modern_ebpf', 'kmod'], default: 'modern_ebpf' },
      { key: 'falco.json_output', label: 'JSON output', type: 'boolean', default: true },
    ],
    verified: true,
    compatibility: {
      minKubeVersion: '1.26',
      requiredCapabilities: ['ebpf', 'privileged-daemonset'],
      testedOn: ['adhar-1.4', 'adhar-1.5'],
    },
  },
  {
    id: 'vault',
    name: 'vault',
    title: 'HashiCorp Vault',
    publisher: 'HashiCorp',
    repository: 'hashicorp',
    repoUrl: 'https://helm.releases.hashicorp.com',
    version: '0.29.1',
    appVersion: '1.18.2',
    description: 'Secrets management with dynamic credentials, encryption-as-a-service.',
    category: 'security',
    tone: 'slate',
    popularity: 6_400_000,
    tags: ['secrets', 'pki', 'kv', 'transit'],
    defaultNamespace: 'vault',
    fields: [
      { key: 'server.ha.enabled', label: 'HA mode', type: 'boolean', default: false },
      { key: 'server.ha.replicas', label: 'HA replicas', type: 'number', default: 3 },
      { key: 'ui.enabled', label: 'Web UI', type: 'boolean', default: true },
    ],
    verified: true,
  },

  /* ──── Networking ──── */
  {
    id: 'ingress-nginx',
    name: 'ingress-nginx',
    title: 'NGINX Ingress Controller',
    publisher: 'Kubernetes',
    repository: 'ingress-nginx',
    repoUrl: 'https://kubernetes.github.io/ingress-nginx',
    version: '4.11.4',
    appVersion: '1.11.4',
    description: 'NGINX-based ingress controller — production reference for Kubernetes.',
    category: 'networking',
    tone: 'emerald',
    popularity: 31_400_000,
    tags: ['ingress', 'nginx', 'http', 'tls'],
    defaultNamespace: 'ingress-nginx',
    fields: [
      { key: 'controller.replicaCount', label: 'Replicas', type: 'number', default: 2 },
      { key: 'controller.service.type', label: 'Service type', type: 'select', options: ['LoadBalancer', 'NodePort', 'ClusterIP'], default: 'LoadBalancer' },
      { key: 'controller.metrics.enabled', label: 'Metrics', type: 'boolean', default: true },
    ],
    featured: true,
    verified: true,
  },
  {
    id: 'traefik',
    name: 'traefik',
    title: 'Traefik',
    publisher: 'Traefik Labs',
    repository: 'traefik',
    repoUrl: 'https://traefik.github.io/charts',
    version: '33.2.1',
    appVersion: 'v3.2.1',
    description: 'Modern reverse proxy + ingress controller with automatic TLS and middlewares.',
    category: 'networking',
    tone: 'sky',
    popularity: 7_900_000,
    tags: ['ingress', 'proxy', 'tls', 'middleware'],
    defaultNamespace: 'traefik',
    fields: [
      { key: 'deployment.replicas', label: 'Replicas', type: 'number', default: 2 },
      { key: 'service.type', label: 'Service type', type: 'select', options: ['LoadBalancer', 'NodePort', 'ClusterIP'], default: 'LoadBalancer' },
      { key: 'dashboard.enabled', label: 'Dashboard', type: 'boolean', default: true },
    ],
    verified: true,
  },
  {
    id: 'istio-base',
    name: 'istio-base',
    title: 'Istio',
    publisher: 'Istio',
    repository: 'istio',
    repoUrl: 'https://istio-release.storage.googleapis.com/charts',
    version: '1.24.1',
    appVersion: '1.24.1',
    description: 'Service mesh — traffic management, security, observability.',
    category: 'networking',
    tone: 'fuchsia',
    popularity: 9_300_000,
    tags: ['service-mesh', 'envoy', 'mtls', 'tracing'],
    defaultNamespace: 'istio-system',
    fields: [
      { key: 'profile', label: 'Profile', type: 'select', options: ['default', 'demo', 'minimal', 'ambient'], default: 'default' },
    ],
    verified: true,
  },
  {
    id: 'cilium',
    name: 'cilium',
    title: 'Cilium',
    publisher: 'Isovalent',
    repository: 'cilium',
    repoUrl: 'https://helm.cilium.io',
    version: '1.16.4',
    appVersion: '1.16.4',
    description: 'eBPF-based CNI — network policy, observability, service mesh.',
    category: 'networking',
    tone: 'amber',
    popularity: 4_120_000,
    tags: ['cni', 'ebpf', 'network-policy', 'observability'],
    defaultNamespace: 'kube-system',
    fields: [
      { key: 'kubeProxyReplacement', label: 'kube-proxy replacement', type: 'select', options: ['true', 'false', 'partial'], default: 'true' },
      { key: 'hubble.enabled', label: 'Enable Hubble', type: 'boolean', default: true },
    ],
    verified: true,
    compatibility: {
      minKubeVersion: '1.26',
      maxKubeVersion: '1.31',
      requiredCapabilities: ['ebpf', 'privileged-daemonset'],
      testedOn: ['adhar-1.4', 'adhar-1.5'],
    },
  },

  /* ──── Storage ──── */
  {
    id: 'minio',
    name: 'minio',
    title: 'MinIO',
    publisher: 'MinIO',
    repository: 'minio',
    repoUrl: 'https://charts.min.io',
    version: '5.4.0',
    appVersion: 'RELEASE.2024-12-13',
    description: 'High-performance S3-compatible object storage.',
    category: 'storage',
    iconId: 'minio',
    tone: 'rose',
    popularity: 8_400_000,
    tags: ['object-storage', 's3', 'lakehouse', 'backups'],
    defaultNamespace: 'data',
    fields: [
      { key: 'mode', label: 'Mode', type: 'select', options: ['standalone', 'distributed'], default: 'distributed' },
      { key: 'replicas', label: 'Replicas', type: 'number', default: 4 },
      { key: 'persistence.size', label: 'Per-replica storage', type: 'string', default: '50Gi' },
      { key: 'rootUser', label: 'Root user', type: 'string', default: 'admin' },
    ],
    verified: true,
  },
  {
    id: 'longhorn',
    name: 'longhorn',
    title: 'Longhorn',
    publisher: 'Longhorn',
    repository: 'longhorn',
    repoUrl: 'https://charts.longhorn.io',
    version: '1.7.2',
    appVersion: 'v1.7.2',
    description: 'Distributed block storage with snapshots, backup-to-S3, and cross-cluster restore.',
    category: 'storage',
    tone: 'sky',
    popularity: 1_980_000,
    tags: ['block-storage', 'csi', 'snapshots'],
    defaultNamespace: 'longhorn-system',
    fields: [
      { key: 'persistence.defaultClass', label: 'Default storage class', type: 'boolean', default: true },
      { key: 'persistence.defaultClassReplicaCount', label: 'Default replicas', type: 'number', default: 3 },
    ],
    verified: true,
    compatibility: {
      minKubeVersion: '1.25',
      maxKubeVersion: '1.31',
      requiredCapabilities: ['privileged-daemonset', 'iscsi'],
      testedOn: ['adhar-1.4', 'adhar-1.5'],
    },
  },

  /* ──── Identity ──── */
  {
    id: 'keycloak',
    name: 'keycloak',
    title: 'Keycloak',
    publisher: 'Bitnami',
    repository: 'bitnami',
    repoUrl: 'https://charts.bitnami.com/bitnami',
    version: '24.4.0',
    appVersion: '26.0.7',
    description: 'Open-source identity & SSO — OIDC, SAML, social login, federation.',
    category: 'identity',
    iconId: 'keycloak',
    tone: 'rose',
    popularity: 5_700_000,
    tags: ['identity', 'sso', 'oidc', 'saml'],
    defaultNamespace: 'identity',
    fields: [
      { key: 'auth.adminUser', label: 'Admin user', type: 'string', default: 'admin' },
      { key: 'auth.adminPassword', label: 'Admin password', type: 'string', placeholder: 'auto-generate' },
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 2 },
      { key: 'production', label: 'Production mode', type: 'boolean', default: true },
    ],
    featured: true,
    verified: true,
  },
  {
    id: 'dex',
    name: 'dex',
    title: 'Dex',
    publisher: 'Dex',
    repository: 'dex',
    repoUrl: 'https://charts.dexidp.io',
    version: '0.19.1',
    appVersion: '2.41.1',
    description: 'OIDC identity broker — federate any auth backend behind a single endpoint.',
    category: 'identity',
    tone: 'amber',
    popularity: 850_000,
    tags: ['oidc', 'sso', 'federation'],
    defaultNamespace: 'dex',
    fields: [
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 2 },
    ],
    source: 'community',
    publisherUrl: 'https://dexidp.io',
    provenance: {
      signed: false,
      signature: 'none',
      scanned: true,
      scanner: 'trivy',
      grade: 'C',
      criticalCves: 1,
      highCves: 4,
      sbom: false,
      scannedAt: '2026-07-19T13:05:00Z',
    },
    compatibility: { minKubeVersion: '1.24' },
  },

  /* ──── Data ──── */
  {
    id: 'airbyte',
    name: 'airbyte',
    title: 'Airbyte',
    publisher: 'Airbyte',
    repository: 'airbyte',
    repoUrl: 'https://airbytehq.github.io/helm-charts',
    version: '1.3.0',
    appVersion: '1.3.0',
    description: 'ELT data integration — 350+ source/destination connectors.',
    category: 'data',
    iconId: 'airbyte',
    tone: 'violet',
    popularity: 2_140_000,
    tags: ['elt', 'pipelines', 'connectors', 'ingestion'],
    defaultNamespace: 'data',
    fields: [
      { key: 'global.deploymentMode', label: 'Deployment mode', type: 'select', options: ['oss', 'enterprise'], default: 'oss' },
      { key: 'webapp.replicaCount', label: 'Webapp replicas', type: 'number', default: 1 },
    ],
    verified: true,
  },
  {
    id: 'metabase',
    name: 'metabase',
    title: 'Metabase',
    publisher: 'Metabase',
    repository: 'pmint93',
    repoUrl: 'https://pmint93.github.io/helm-charts',
    version: '2.13.0',
    appVersion: 'v0.51.7',
    description: 'Self-service BI — ask questions, build dashboards, share insights.',
    category: 'data',
    iconId: 'metabase',
    tone: 'sky',
    popularity: 1_290_000,
    tags: ['bi', 'analytics', 'sql', 'dashboards'],
    defaultNamespace: 'data',
    fields: [
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 1 },
      { key: 'database.type', label: 'Backing DB', type: 'select', options: ['h2', 'postgres', 'mysql'], default: 'postgres' },
    ],
    source: 'community',
    provenance: { signed: false, signature: 'none', scanned: false },
    compatibility: { dependsOn: ['postgresql'] },
  },

  /* ──── AI/ML ──── */
  {
    id: 'ollama',
    name: 'ollama',
    title: 'Ollama',
    publisher: 'Ollama',
    repository: 'otwld',
    repoUrl: 'https://otwld.github.io/ollama-helm',
    version: '0.71.1',
    appVersion: '0.5.4',
    description: 'Run open LLMs locally — Llama 3, Mistral, Phi-3, Gemma, more.',
    category: 'ai-ml',
    tone: 'violet',
    popularity: 1_650_000,
    tags: ['llm', 'inference', 'gpu', 'ai'],
    defaultNamespace: 'ai',
    fields: [
      { key: 'ollama.gpu.enabled', label: 'GPU acceleration', type: 'boolean', default: false },
      { key: 'ollama.models.pull', label: 'Models to pull', type: 'string', placeholder: 'llama3.1,phi3' },
      { key: 'persistentVolume.size', label: 'Model storage', type: 'string', default: '50Gi' },
    ],
    verified: true,
  },
  {
    id: 'kubeflow-pipelines',
    name: 'kubeflow-pipelines',
    title: 'Kubeflow Pipelines',
    publisher: 'Kubeflow',
    repository: 'kubeflow',
    repoUrl: 'https://kubeflow.github.io/kubeflow',
    version: '2.4.0',
    appVersion: '2.4.0',
    description: 'ML workflow orchestration — author, deploy, version pipelines.',
    category: 'ai-ml',
    tone: 'fuchsia',
    popularity: 720_000,
    tags: ['ml', 'pipelines', 'workflow', 'kubeflow'],
    defaultNamespace: 'kubeflow',
    fields: [
      { key: 'platform', label: 'Platform', type: 'select', options: ['standalone', 'multi-user'], default: 'standalone' },
    ],
    source: 'community',
    provenance: {
      signed: false,
      signature: 'none',
      scanned: true,
      scanner: 'trivy',
      grade: 'B',
      criticalCves: 0,
      highCves: 5,
      sbom: false,
      scannedAt: '2026-07-28T02:10:00Z',
    },
    compatibility: {
      minKubeVersion: '1.29',
      maxKubeVersion: '1.31',
      requiredCapabilities: ['crd-install'],
      dependsOn: ['argo-workflows', 'minio'],
    },
  },

  /* ──── Developer ──── */
  {
    id: 'gitea',
    name: 'gitea',
    title: 'Gitea',
    publisher: 'Gitea',
    repository: 'gitea-charts',
    repoUrl: 'https://dl.gitea.com/charts/',
    version: '10.6.0',
    appVersion: '1.22.6',
    description: 'Self-hosted Git service with code review, issues, packages, actions.',
    category: 'developer',
    iconId: 'gitea',
    tone: 'emerald',
    popularity: 2_140_000,
    tags: ['git', 'scm', 'code-review', 'actions'],
    defaultNamespace: 'devtools',
    fields: [
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 1 },
      { key: 'gitea.admin.username', label: 'Admin user', type: 'string', default: 'gitea_admin' },
      { key: 'gitea.admin.password', label: 'Admin password', type: 'string', placeholder: 'auto-generate' },
    ],
    verified: true,
  },
  {
    id: 'harbor',
    name: 'harbor',
    title: 'Harbor',
    publisher: 'Harbor',
    repository: 'harbor',
    repoUrl: 'https://helm.goharbor.io',
    version: '1.16.0',
    appVersion: '2.12.0',
    description: 'Cloud-native registry — images, charts, signing, vuln scanning, replication.',
    category: 'developer',
    iconId: 'harbor',
    tone: 'sky',
    popularity: 4_320_000,
    tags: ['registry', 'images', 'oci', 'scanning'],
    defaultNamespace: 'devtools',
    fields: [
      { key: 'expose.type', label: 'Expose type', type: 'select', options: ['ingress', 'clusterIP', 'nodePort', 'loadBalancer'], default: 'ingress' },
      { key: 'persistence.enabled', label: 'Persistent storage', type: 'boolean', default: true },
      { key: 'trivy.enabled', label: 'Trivy scanner', type: 'boolean', default: true },
    ],
    verified: true,
  },
  {
    id: 'crossplane',
    name: 'crossplane',
    title: 'Crossplane',
    publisher: 'Crossplane',
    repository: 'crossplane-stable',
    repoUrl: 'https://charts.crossplane.io/stable',
    version: '1.18.0',
    appVersion: '1.18.0',
    description: 'Universal control plane — manage cloud infrastructure as Kubernetes resources.',
    category: 'cicd',
    iconId: 'crossplane',
    tone: 'fuchsia',
    popularity: 2_960_000,
    tags: ['control-plane', 'iac', 'compositions', 'providers'],
    defaultNamespace: 'crossplane-system',
    fields: [
      { key: 'replicas', label: 'Replicas', type: 'number', default: 1 },
      { key: 'provider.packages', label: 'Provider packages', type: 'string', placeholder: 'leave blank for none' },
    ],
    verified: true,
  },

  /* ──── Partner & community packages ──── */
  {
    id: 'temporal',
    name: 'temporal',
    title: 'Temporal',
    publisher: 'Temporal Technologies',
    repository: 'temporalio',
    repoUrl: 'https://go.temporal.io/helm-charts',
    version: '0.50.0',
    appVersion: '1.25.2',
    description: 'Durable execution platform — workflows that survive any failure.',
    longDescription:
      'Temporal is a durable execution system for writing long-running, fault-tolerant workflows as ordinary code. The chart deploys the server, frontend, matching and history services.',
    category: 'developer',
    tone: 'violet',
    popularity: 890_000,
    tags: ['workflows', 'durable-execution', 'orchestration', 'saga'],
    defaultNamespace: 'temporal',
    fields: [
      { key: 'server.replicaCount', label: 'Server replicas', type: 'number', default: 1 },
      { key: 'prometheus.enabled', label: 'Prometheus metrics', type: 'boolean', default: true },
      { key: 'web.enabled', label: 'Web UI', type: 'boolean', default: true },
    ],
    docsUrl: 'https://docs.temporal.io/',
    source: 'partner',
    publisherUrl: 'https://temporal.io',
    verifiedPublisher: true,
    provenance: {
      signed: true,
      signer: 'Temporal Technologies',
      signature: 'notation',
      scanned: true,
      scanner: 'trivy',
      grade: 'B',
      criticalCves: 0,
      highCves: 2,
      sbom: true,
      scannedAt: '2026-08-08T16:20:00Z',
    },
    compatibility: {
      minKubeVersion: '1.27',
      dependsOn: ['postgresql'],
      testedOn: ['adhar-1.5'],
    },
  },
  {
    id: 'n8n',
    name: 'n8n',
    title: 'n8n',
    publisher: '8gears (community)',
    repository: 'open-8gears',
    repoUrl: 'https://8gears.container-registry.com/chartrepo/library',
    version: '0.25.2',
    appVersion: '1.64.0',
    description: 'Fair-code workflow automation — 400+ integrations, visual editor.',
    longDescription:
      'n8n is a workflow automation tool that connects APIs and services with a node-based visual editor. This community-maintained chart deploys the editor, webhook and worker processes.',
    category: 'developer',
    tone: 'rose',
    popularity: 310_000,
    tags: ['automation', 'workflows', 'integrations', 'low-code'],
    defaultNamespace: 'automation',
    fields: [
      { key: 'replicaCount', label: 'Replicas', type: 'number', default: 1 },
      { key: 'persistence.enabled', label: 'Persistent storage', type: 'boolean', default: true },
      { key: 'webhook.enabled', label: 'Separate webhook process', type: 'boolean', default: false },
    ],
    source: 'community',
    publisherUrl: 'https://github.com/8gears/n8n-helm-chart',
    provenance: {
      signed: false,
      signature: 'none',
      scanned: true,
      scanner: 'trivy',
      grade: 'C',
      criticalCves: 1,
      highCves: 6,
      sbom: false,
      scannedAt: '2026-07-31T11:47:00Z',
    },
    compatibility: {
      minKubeVersion: '1.26',
      dependsOn: ['postgresql'],
    },
  },
  {
    id: 'uptime-kuma',
    name: 'uptime-kuma',
    title: 'Uptime Kuma',
    publisher: 'dirsigler (community)',
    repository: 'uptime-kuma',
    repoUrl: 'https://helm.irsigler.cloud',
    version: '2.21.0',
    appVersion: '1.23.16',
    description: 'Self-hosted uptime monitoring with a slick status page.',
    longDescription:
      'Uptime Kuma is a self-hosted monitoring tool — HTTP(s), TCP, DNS and ping monitors, notifications to 90+ services, and shareable status pages. Community-maintained chart.',
    category: 'observability',
    tone: 'emerald',
    popularity: 145_000,
    tags: ['uptime', 'monitoring', 'status-page', 'alerts'],
    defaultNamespace: 'monitoring',
    fields: [
      { key: 'volume.storage', label: 'Storage size', type: 'string', default: '4Gi' },
      { key: 'ingress.enabled', label: 'Enable ingress', type: 'boolean', default: false },
    ],
    source: 'community',
    publisherUrl: 'https://github.com/dirsigler/uptime-kuma-helm',
    provenance: { signed: false, signature: 'none', scanned: false },
    compatibility: { minKubeVersion: '1.24' },
  },
]

export const CATALOG: MarketplaceChart[] = SEED_CATALOG.map(withTrustDefaults)

/* ─────────── enrichment: match an app to a curated chart ─────────── */

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Chart lookup by id, then by fuzzy name — used to enrich appset apps. */
export function chartByIdMap(): Map<string, MarketplaceChart> {
  const out = new Map<string, MarketplaceChart>()
  for (const c of CATALOG) out.set(c.id, c)
  return out
}

let enrichmentIndex: Map<string, MarketplaceChart> | null = null
function chartEnrichmentIndex(): Map<string, MarketplaceChart> {
  if (enrichmentIndex) return enrichmentIndex
  const idx = new Map<string, MarketplaceChart>()
  for (const c of CATALOG) {
    for (const key of [c.id, c.name, c.title ?? '', ...c.tags]) {
      const k = normalizeKey(key)
      if (k && !idx.has(k)) idx.set(k, c)
    }
  }
  enrichmentIndex = idx
  return idx
}

/** Best-effort enrichment for an app name — never fabricates, returns undefined. */
export function enrichApp(name: string): MarketplaceChart | undefined {
  const idx = chartEnrichmentIndex()
  const k = normalizeKey(name)
  if (idx.has(k)) return idx.get(k)
  // Try dropping common suffixes (e.g. "kube-prometheus" ~ "kube-prometheus-stack").
  for (const [key, chart] of idx) {
    if (key.startsWith(k) || k.startsWith(key)) return chart
  }
  return undefined
}

/** Humanize an ApplicationSet category id ("ai-ml" → "AI ML", "cicd" → "Cicd"). */
export function appCategoryLabel(cat: string): string {
  const known: Record<string, string> = {
    application: 'Application',
    security: 'Security',
    observability: 'Observability',
    ai: 'AI',
    data: 'Data',
    core: 'Core',
    infrastructure: 'Infrastructure',
    networking: 'Networking',
    storage: 'Storage',
    identity: 'Identity',
    plugins: 'Plugins',
    backup: 'Backup',
  }
  if (known[cat]) return known[cat]
  return cat.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/* ─────────── ApplicationSet-driven marketplace ─────────── */

/** Namespace the Adhar ApplicationSet(s) + generated ArgoCD Applications live in. */
export const APPSET_NAMESPACE = 'adhar-system'

const APPLICATIONSETS_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'applicationsets',
  namespaced: true,
}
const APPLICATIONS_GVR: k8s.GVR = {
  group: 'argoproj.io',
  version: 'v1alpha1',
  resource: 'applications',
  namespaced: true,
}

export type ArgoHealth =
  | 'Healthy'
  | 'Progressing'
  | 'Degraded'
  | 'Suspended'
  | 'Missing'
  | 'Unknown'
  | ''
export type ArgoSync = 'Synced' | 'OutOfSync' | 'Unknown' | ''

/** One element of an ApplicationSet list/matrix generator. */
export interface AppsetElement {
  name: string
  enabled: boolean
  namespace?: string
  category: string
  manifestPath?: string
  plane?: string
  /** Owning ApplicationSet name (e.g. `helm-charts-local`). */
  appset: string
}

/** Live ArgoCD Application status for a marketplace app. */
export interface AppLiveStatus {
  name: string
  namespace: string
  health: ArgoHealth
  sync: ArgoSync
  operationPhase?: string
  message?: string
  createdAt?: string
  repoURL?: string
  path?: string
}

export interface MarketplaceApp extends AppsetElement {
  /** Stable id — `${appset}/${name}`. */
  id: string
  /** Live ArgoCD Application status, when a matching Application exists. */
  live?: AppLiveStatus
  /** Optional curated-catalogue enrichment matched by name. */
  chart?: MarketplaceChart
}

/* raw shapes (cast from the generic gateway objects) */
interface RawElement {
  name?: string
  packageName?: string
  enabled?: string | boolean
  namespace?: string
  category?: string
  manifestPath?: string
  plane?: string
  [k: string]: unknown
}
interface RawListGen {
  list?: { elements?: RawElement[] }
  matrix?: { generators?: Array<{ list?: { elements?: RawElement[] } }> }
}
interface RawAppSet {
  metadata?: { name?: string; namespace?: string }
  spec?: { generators?: RawListGen[] }
}
interface RawApplication {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string }
  spec?: { source?: { repoURL?: string; path?: string } }
  status?: {
    health?: { status?: string; message?: string }
    sync?: { status?: string }
    operationState?: { phase?: string; message?: string }
  }
}

function elementsFromAppSet(as: RawAppSet): AppsetElement[] {
  const appset = as.metadata?.name ?? ''
  const out: AppsetElement[] = []
  const lists: RawElement[][] = []
  for (const g of as.spec?.generators ?? []) {
    if (g.list?.elements) lists.push(g.list.elements)
    for (const mg of g.matrix?.generators ?? []) {
      if (mg.list?.elements) lists.push(mg.list.elements)
    }
  }
  for (const els of lists) {
    for (const e of els) {
      const name = e.name ?? e.packageName
      if (!name) continue
      out.push({
        name,
        enabled: String(e.enabled) === 'true',
        namespace: e.namespace,
        category: e.category || 'other',
        manifestPath: e.manifestPath,
        plane: e.plane,
        appset,
      })
    }
  }
  return out
}

function liveFromApplication(app: RawApplication): AppLiveStatus {
  return {
    name: app.metadata?.name ?? '',
    namespace: app.metadata?.namespace ?? '',
    health: (app.status?.health?.status as ArgoHealth) ?? 'Unknown',
    sync: (app.status?.sync?.status as ArgoSync) ?? 'Unknown',
    operationPhase: app.status?.operationState?.phase,
    message: app.status?.health?.message ?? app.status?.operationState?.message,
    createdAt: app.metadata?.creationTimestamp,
    repoURL: app.spec?.source?.repoURL,
    path: app.spec?.source?.path,
  }
}

/** Query key for the ApplicationSet list — the toggle mutation invalidates this. */
export function appsetsQueryKey(cluster: string) {
  return ['marketplace', 'appsets', cluster] as const
}

/**
 * The marketplace, read live from the cluster: every `helm-charts-*`
 * ApplicationSet element, cross-referenced with its live ArgoCD Application and
 * enriched from the curated catalogue. Grouped/sorted in the view.
 */
export function useMarketplaceApps() {
  const { cluster } = useActiveCluster()

  const appsetsQ = useQuery({
    queryKey: appsetsQueryKey(cluster),
    queryFn: () =>
      client.listGeneric(cluster, APPLICATIONSETS_GVR, APPSET_NAMESPACE) as Promise<RawAppSet[]>,
    staleTime: 15_000,
    retry: false,
  })

  const appsQ = useQuery({
    queryKey: ['marketplace', 'argo-apps', cluster],
    queryFn: () =>
      client.listGeneric(cluster, APPLICATIONS_GVR, APPSET_NAMESPACE) as Promise<RawApplication[]>,
    refetchInterval: 10_000,
    retry: false,
  })

  const appsets = appsetsQ.data ?? []
  const argoApps = appsQ.data ?? []

  const liveByName = useMemo(() => {
    const m = new Map<string, AppLiveStatus>()
    for (const a of argoApps) {
      const n = a.metadata?.name
      if (n) m.set(n, liveFromApplication(a))
    }
    return m
  }, [argoApps])

  const apps = useMemo<MarketplaceApp[]>(() => {
    // Prefer the curated `helm-charts-*` ApplicationSets; if none are present
    // fall back to every ApplicationSet in the namespace so the list stays real.
    const helmCharts = appsets.filter((a) => (a.metadata?.name ?? '').startsWith('helm-charts'))
    const source = helmCharts.length ? helmCharts : appsets
    const seen = new Set<string>()
    const out: MarketplaceApp[] = []
    for (const as of source) {
      for (const el of elementsFromAppSet(as)) {
        const id = `${el.appset}/${el.name}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          ...el,
          id,
          live: liveByName.get(el.name),
          chart: enrichApp(el.name),
        })
      }
    }
    out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    return out
  }, [appsets, liveByName])

  const appsetNames = useMemo(
    () => appsets.map((a) => a.metadata?.name ?? '').filter(Boolean),
    [appsets],
  )

  return {
    apps,
    appsetNames,
    isLoading: appsetsQ.isLoading,
    isFetching: appsetsQ.isFetching || appsQ.isFetching,
    isError: appsetsQ.isError,
    error: appsetsQ.error as Error | null,
    /** 404 → the ApplicationSet CRD (ArgoCD) isn't installed on this cluster. */
    argoNotInstalled:
      appsetsQ.isError && (appsetsQ.error as { status?: number } | null)?.status === 404,
    dataUpdatedAt: appsetsQ.dataUpdatedAt,
    refetch: () => {
      appsetsQ.refetch()
      appsQ.refetch()
    },
  }
}

/* ─────────── GitOps enable/disable toggle ─────────── */

export interface ToggleResult {
  ok: boolean
  name: string
  enabled: boolean
  gitops: boolean
  changed?: boolean
  repo?: string
  path?: string
  commit?: string
  commitUrl?: string
  note?: string
}

/**
 * Flip an app's `enabled` state in the Adhar ApplicationSet YAML in Gitea —
 * a GitOps change applied by the `/api/platform/appset/toggle` BFF endpoint
 * (which holds the Gitea service token). Optimistically patches the
 * ApplicationSet cache, then invalidates so the reconciled state re-loads.
 */
export function useToggleApp() {
  const qc = useQueryClient()
  const { cluster } = useActiveCluster()

  return useMutation<ToggleResult, Error, { app: MarketplaceApp; enabled: boolean }>({
    mutationFn: async ({ app, enabled }) => {
      const res = await fetch('/api/platform/appset/toggle', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appset: app.appset, name: app.name, enabled }),
      })
      const body = (await res.json().catch(() => ({}))) as ToggleResult & { error?: string; detail?: string }
      if (!res.ok || !body.ok) {
        throw new Error(body.detail || body.error || `toggle failed (${res.status})`)
      }
      return body
    },
    onMutate: async ({ app, enabled }) => {
      const key = appsetsQueryKey(cluster)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<RawAppSet[]>(key)
      // Optimistically flip the element's `enabled` in the cached ApplicationSet.
      qc.setQueryData<RawAppSet[]>(key, (old) =>
        (old ?? []).map((as) => {
          if ((as.metadata?.name ?? '') !== app.appset) return as
          const patchEls = (els?: RawElement[]) =>
            (els ?? []).map((e) =>
              (e.name ?? e.packageName) === app.name ? { ...e, enabled: String(enabled) } : e,
            )
          return {
            ...as,
            spec: {
              ...as.spec,
              generators: (as.spec?.generators ?? []).map((g) => ({
                ...g,
                ...(g.list ? { list: { ...g.list, elements: patchEls(g.list.elements) } } : {}),
                ...(g.matrix
                  ? {
                      matrix: {
                        ...g.matrix,
                        generators: (g.matrix.generators ?? []).map((mg) => ({
                          ...mg,
                          ...(mg.list
                            ? { list: { ...mg.list, elements: patchEls(mg.list.elements) } }
                            : {}),
                        })),
                      },
                    }
                  : {}),
              })),
            },
          }
        }),
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      const ctx = context as { previous?: RawAppSet[] } | undefined
      if (ctx?.previous) qc.setQueryData(appsetsQueryKey(cluster), ctx.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: appsetsQueryKey(cluster) })
      qc.invalidateQueries({ queryKey: ['marketplace', 'argo-apps', cluster] })
    },
  })
}
