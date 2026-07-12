import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Curated Helm-chart marketplace.
 *
 * The catalog is a compile-time array of vetted charts (Bitnami, Grafana,
 * Argo, Crossplane, Adhar). The "installed releases" set lives in
 * localStorage so the install / upgrade / uninstall flow is fully
 * functional end-to-end without a real Helm backend yet — when the BFF
 * lands, swap `loadReleases` / `saveReleases` for HTTP calls.
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

export interface MarketplaceChart {
  id: string
  name: string
  /** Friendly title shown in cards. Defaults to `name` if absent. */
  title?: string
  publisher: string
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

export const CATALOG: MarketplaceChart[] = [
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
]

/* ─────────── installed releases (in-memory + localStorage) ─────────── */

export type ReleaseStatus = 'installing' | 'deployed' | 'upgrading' | 'uninstalling' | 'failed'

export interface HelmRelease {
  /** Stable id — `${namespace}/${releaseName}`. */
  id: string
  chartId: string
  releaseName: string
  namespace: string
  chart: string
  version: string
  appVersion: string
  status: ReleaseStatus
  values: Record<string, unknown>
  createdAt: string
  updatedAt: string
  /** Increments on every upgrade. */
  revision: number
  notes?: string
}

const STORAGE_KEY = 'adhar.platform.helm.releases'

function loadReleases(): HelmRelease[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as HelmRelease[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveReleases(releases: HelmRelease[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(releases))
  } catch {
    /* ignore quota errors */
  }
}

/* ─────────── repositories ─────────── */

export interface HelmRepository {
  name: string
  url: string
  chartCount: number
  verified: boolean
  description: string
}

export const REPOSITORIES: HelmRepository[] = [
  { name: 'bitnami', url: 'https://charts.bitnami.com/bitnami', chartCount: 200, verified: true, description: 'Production-ready OSS images and Helm charts.' },
  { name: 'grafana', url: 'https://grafana.github.io/helm-charts', chartCount: 38, verified: true, description: 'Grafana, Loki, Tempo, Mimir, Pyroscope.' },
  { name: 'prometheus-community', url: 'https://prometheus-community.github.io/helm-charts', chartCount: 64, verified: true, description: 'Prometheus, Alertmanager, exporters.' },
  { name: 'argo', url: 'https://argoproj.github.io/argo-helm', chartCount: 12, verified: true, description: 'Argo CD, Workflows, Rollouts, Events.' },
  { name: 'jetstack', url: 'https://charts.jetstack.io', chartCount: 5, verified: true, description: 'cert-manager and trust-related tooling.' },
  { name: 'kyverno', url: 'https://kyverno.github.io/kyverno', chartCount: 6, verified: true, description: 'Kyverno policy engine.' },
  { name: 'crossplane-stable', url: 'https://charts.crossplane.io/stable', chartCount: 4, verified: true, description: 'Crossplane core and providers.' },
  { name: 'minio', url: 'https://charts.min.io', chartCount: 3, verified: true, description: 'MinIO server, operator, console.' },
  { name: 'open-telemetry', url: 'https://open-telemetry.github.io/opentelemetry-helm-charts', chartCount: 8, verified: true, description: 'OpenTelemetry collector and operator.' },
  { name: 'ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx', chartCount: 1, verified: true, description: 'Official NGINX ingress controller.' },
  { name: 'hashicorp', url: 'https://helm.releases.hashicorp.com', chartCount: 6, verified: true, description: 'Vault, Consul, Boundary, Waypoint.' },
  { name: 'adhar', url: 'https://charts.adhar.io', chartCount: 12, verified: true, description: 'Adhar-curated platform extensions.' },
]

/* ─────────── hooks ─────────── */

export function useCatalog() {
  return useQuery({
    queryKey: ['marketplace', 'catalog'],
    queryFn: () => Promise.resolve(CATALOG),
    staleTime: Infinity,
  })
}

export function useRepositories() {
  return useQuery({
    queryKey: ['marketplace', 'repositories'],
    queryFn: () => Promise.resolve(REPOSITORIES),
    staleTime: Infinity,
  })
}

export function useReleases() {
  return useQuery<HelmRelease[]>({
    queryKey: ['marketplace', 'releases'],
    queryFn: () => Promise.resolve(loadReleases()),
    staleTime: 1_000,
  })
}

interface InstallInput {
  chart: MarketplaceChart
  releaseName: string
  namespace: string
  values: Record<string, unknown>
}

export function useInstallChart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: InstallInput) => {
      const now = new Date().toISOString()
      const release: HelmRelease = {
        id: `${input.namespace}/${input.releaseName}`,
        chartId: input.chart.id,
        releaseName: input.releaseName,
        namespace: input.namespace,
        chart: input.chart.name,
        version: input.chart.version,
        appVersion: input.chart.appVersion,
        status: 'installing',
        values: input.values,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        notes: defaultNotes(input.chart, input.releaseName, input.namespace),
      }
      const existing = loadReleases()
      if (existing.some((r) => r.id === release.id)) {
        throw new Error(
          `Release "${input.releaseName}" already exists in namespace "${input.namespace}".`,
        )
      }
      saveReleases([...existing, release])
      // Simulate the install pulling images / running hooks.
      await delay(900)
      const next = loadReleases().map((r) =>
        r.id === release.id ? { ...r, status: 'deployed' as const, updatedAt: new Date().toISOString() } : r,
      )
      saveReleases(next)
      return next.find((r) => r.id === release.id)!
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['marketplace', 'releases'] }),
  })
}

export function useUpgradeChart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; values: Record<string, unknown>; version?: string }) => {
      const all = loadReleases()
      const next = all.map((r) =>
        r.id === input.id
          ? {
              ...r,
              status: 'upgrading' as const,
              values: input.values,
              version: input.version ?? r.version,
              revision: r.revision + 1,
              updatedAt: new Date().toISOString(),
            }
          : r,
      )
      saveReleases(next)
      await delay(700)
      const finalState = loadReleases().map((r) =>
        r.id === input.id ? { ...r, status: 'deployed' as const, updatedAt: new Date().toISOString() } : r,
      )
      saveReleases(finalState)
      return finalState.find((r) => r.id === input.id)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['marketplace', 'releases'] }),
  })
}

export function useUninstallChart() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const all = loadReleases()
      saveReleases(all.map((r) => (r.id === id ? { ...r, status: 'uninstalling' as const } : r)))
      await delay(500)
      saveReleases(loadReleases().filter((r) => r.id !== id))
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['marketplace', 'releases'] }),
  })
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function defaultNotes(chart: MarketplaceChart, releaseName: string, namespace: string): string {
  return [
    `${chart.title ?? chart.name} v${chart.version} installed.`,
    '',
    'Get the resources:',
    `  kubectl get all -n ${namespace} -l app.kubernetes.io/instance=${releaseName}`,
    '',
    'Tail the logs:',
    `  kubectl logs -n ${namespace} -l app.kubernetes.io/instance=${releaseName} -f`,
    '',
    chart.docsUrl ? `Docs: ${chart.docsUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* ─────────── small helpers used by the view ─────────── */

export function chartByIdMap(): Map<string, MarketplaceChart> {
  const out = new Map<string, MarketplaceChart>()
  for (const c of CATALOG) out.set(c.id, c)
  return out
}

export function suggestReleaseName(chart: MarketplaceChart, existing: HelmRelease[]): string {
  const base = chart.name
  if (!existing.some((r) => r.releaseName === base)) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!existing.some((r) => r.releaseName === candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}
