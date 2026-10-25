/**
 * Every Adhar Resource page — one per CompositeResourceDefinition the
 * platform's Crossplane stack ships (`platform.adhar.io/v1alpha1`).
 *
 * One registry, read by both the sidebar (nav-tree.tsx) and the Platform
 * module, so a page and its nav row can never disagree. `id` is the
 * `?section=` value; `plural` is the XRD's plural resource the page lists.
 * Ids that clash with a Kubernetes page (`clusters`, `storage`, `metrics`,
 * `releases`) get a distinct one.
 *
 * Verified against the XRDs on a live install (39 kinds, 2026-10-11). A kind
 * missing from a given cluster renders an honest "not installed" page.
 */

export type XrFamily = 'compute' | 'data' | 'messaging' | 'infrastructure' | 'observability' | 'security' | 'tenancy'

export interface XrSection {
  id: string
  plural: string
  label: string
  family: XrFamily
  description: string
}

export const XR_FAMILIES: Array<{ id: XrFamily; label: string }> = [
  { id: 'compute', label: 'Compute & delivery' },
  { id: 'data', label: 'Data' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'observability', label: 'Observability' },
  { id: 'security', label: 'Security & resilience' },
  { id: 'tenancy', label: 'Tenancy' },
]

export const XR_SECTIONS: XrSection[] = [
  // Compute & delivery
  { id: 'applications', plural: 'applications', label: 'Applications', family: 'compute', description: 'End-to-end services — image, runtime, routing and observability composed through Argo CD.' },
  { id: 'services', plural: 'services', label: 'Services', family: 'compute', description: 'Kubernetes service workloads with their Service and probes.' },
  { id: 'agent-workloads', plural: 'agentworkloads', label: 'Agent Workloads', family: 'compute', description: 'AI agent workloads — models, tools, budget and network policy, per team and project.' },
  { id: 'pipelines', plural: 'pipelines', label: 'Pipelines', family: 'compute', description: 'CI/CD pipelines on Tekton, Argo Workflows or the local runner.' },
  { id: 'gitops', plural: 'gitops', label: 'GitOps', family: 'compute', description: 'Argo CD applications and projects wiring a repository to a cluster.' },
  { id: 'release-flows', plural: 'releases', label: 'Releases', family: 'compute', description: 'Kargo promotion flows — warehouses, stages and freight for a service.' },
  { id: 'repositories', plural: 'repositories', label: 'Repositories', family: 'compute', description: 'A Gitea repository with its Harbor project and package repositories.' },
  { id: 'scaling', plural: 'scales', label: 'Scaling', family: 'compute', description: 'Autoscaling policies — HPA-backed scaling for workloads.' },
  { id: 'functions', plural: 'functions', label: 'Functions', family: 'compute', description: 'Serverless functions with Knative scale-to-zero and on-demand autoscaling.' },
  { id: 'webhooks', plural: 'webhooks', label: 'Webhooks', family: 'compute', description: 'Webhook endpoints — the events they receive, authentication and retry policy.' },
  // Data
  { id: 'databases', plural: 'databases', label: 'Databases', family: 'data', description: 'Relational databases — CloudNativePG locally, RDS, Cloud SQL or Azure SQL in the cloud.' },
  { id: 'nosql-databases', plural: 'nosqldatabases', label: 'NoSQL Databases', family: 'data', description: 'Document databases (MongoDB) with users, backups and metrics.' },
  { id: 'graph-databases', plural: 'graphdatabases', label: 'Graph Databases', family: 'data', description: 'Neo4j graph databases for relationship-heavy data.' },
  { id: 'vector-stores', plural: 'vectors', label: 'Vector Stores', family: 'data', description: 'Qdrant vector databases — collections, replicas, storage and read-only keys.' },
  { id: 'search', plural: 'searches', label: 'Search', family: 'data', description: 'OpenSearch clusters with dashboards and index policies.' },
  { id: 'caches', plural: 'caches', label: 'Caches', family: 'data', description: 'Valkey caches — operator-managed, with exporter and ServiceMonitor.' },
  { id: 'tables', plural: 'tables', label: 'Tables', family: 'data', description: 'Iceberg tables in the platform lakehouse, queryable through Trino.' },
  { id: 'buckets', plural: 'buckets', label: 'Buckets', family: 'data', description: 'S3 buckets on the platform object store — versioning, quota and lifecycle.' },
  { id: 'storage-volumes', plural: 'storages', label: 'Storage', family: 'data', description: 'Object, block and file storage — RustFS buckets and persistent volumes.' },
  // Messaging
  { id: 'topics', plural: 'topics', label: 'Topics', family: 'messaging', description: 'Kafka topics on the shared Strimzi cluster.' },
  { id: 'queues', plural: 'queues', label: 'Queues', family: 'messaging', description: 'RabbitMQ queues with exchange binding and dead-letter queue.' },
  { id: 'messaging', plural: 'messagings', label: 'Messaging Clusters', family: 'messaging', description: 'Dedicated Kafka clusters for a team or product.' },
  // Infrastructure
  { id: 'xr-clusters', plural: 'clusters', label: 'Clusters', family: 'infrastructure', description: 'Kubernetes clusters — EKS, GKE, AKS, DOKS, Civo, kind and vCluster.' },
  { id: 'networks', plural: 'networks', label: 'Networks', family: 'infrastructure', description: 'Cloud networks — AWS VPC, GCP VPC and Azure VNet with subnets.' },
  { id: 'environments', plural: 'environments', label: 'Environments', family: 'infrastructure', description: 'Namespace blueprints — RBAC, quotas, network policy and observability as one.' },
  // Observability
  { id: 'metrics-stacks', plural: 'metrics', label: 'Metrics', family: 'observability', description: 'Prometheus scraping and alerting for a set of targets.' },
  { id: 'logging', plural: 'loggings', label: 'Logging', family: 'observability', description: 'Loki log pipelines, retention and labels.' },
  { id: 'traces', plural: 'traces', label: 'Traces', family: 'observability', description: 'Distributed tracing with Jaeger.' },
  { id: 'health-checks', plural: 'healths', label: 'Health Checks', family: 'observability', description: 'Health checks — probes against the targets a service depends on.' },
  { id: 'cost-trackers', plural: 'costtrackers', label: 'Cost Trackers', family: 'observability', description: 'OpenCost allocation and budgets for a team or namespace.' },
  // Security & resilience
  { id: 'auth-stacks', plural: 'authstacks', label: 'Auth Stacks', family: 'security', description: 'Keycloak realms, clients and SSO for an application.' },
  { id: 'secret-stores', plural: 'secrets', label: 'Secrets', family: 'security', description: 'Secrets synced from Vault/OpenBao through External Secrets.' },
  { id: 'secret-rotations', plural: 'secretrotations', label: 'Secret Rotations', family: 'security', description: 'Scheduled rotation of credentials, written back to a connection secret.' },
  { id: 'compliance-policies', plural: 'compliancepolicies', label: 'Compliance Policies', family: 'security', description: 'Kyverno or OPA Gatekeeper policy sets applied to namespaces.' },
  { id: 'backup-policies', plural: 'backuppolicies', label: 'Backup Policies', family: 'security', description: 'Velero backup schedules, scope and retention.' },
  { id: 'restores', plural: 'restores', label: 'Restores', family: 'security', description: 'Velero restores from a backup into a namespace.' },
  // Tenancy
  { id: 'organisations', plural: 'organisations', label: 'Organisations', family: 'tenancy', description: 'Tenant organisations — the top of the tenancy tree.' },
  { id: 'teams', plural: 'teams', label: 'Teams', family: 'tenancy', description: 'Teams with their members, namespaces and quotas.' },
  { id: 'projects', plural: 'projects', label: 'Projects', family: 'tenancy', description: 'Projects inside a team — repositories, environments and budgets.' },
  { id: 'platform-configs', plural: 'platformconfigs', label: 'Platform Config', family: 'tenancy', description: 'Platform-wide defaults — domain, default provider and enabled features.' },
]

export const XR_SECTION_BY_ID: Record<string, XrSection> = Object.fromEntries(XR_SECTIONS.map((s) => [s.id, s]))
