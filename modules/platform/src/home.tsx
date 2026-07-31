import { useState } from 'react'
import { PageHeader } from '@adhar-console/shell-ui'
import { ConnectionGate } from './components/connection-banner.tsx'
import { NamespacePicker } from './components/namespace-picker.tsx'
import { PlatformDashboard } from './views/dashboard.tsx'
import { ClusterView } from './views/cluster-list.tsx'
import { NodesView } from './views/nodes-list.tsx'
import { WorkloadView } from './views/workload-list.tsx'
import { PodsView } from './views/pod-list.tsx'
import { NetworkingView } from './views/networking-list.tsx'
import { StorageView } from './views/storage-list.tsx'
import { ConfigView } from './views/config-list.tsx'
import { RbacView } from './views/rbac-list.tsx'
import { EventsView } from './views/events-list.tsx'
import { CrdBrowser } from './views/crd-browser.tsx'
import { ResourceBrowser } from './views/resource-browser.tsx'
import { CloudShell } from './views/cloud-shell.tsx'
import { LogsViewer } from './views/logs-viewer.tsx'
import { MetricsView } from './views/metrics-view.tsx'
import { CiRunsView } from './views/ci-runs.tsx'
import { PolicyView } from './views/policy-list.tsx'
import { ObservabilityView } from './views/observability-list.tsx'
import { MarketplaceView } from './views/marketplace.tsx'
import {
  ApiContractsView,
  ApplicationsView,
  BucketsView,
  CachesView,
  DatabasesView,
  DataPipelinesView,
  DomainsView,
  EnvironmentsView,
  FunctionsView,
  PipelinesView,
  RoutesView,
  TopicsView,
  WorkflowsView,
} from './views/xr-kinds.tsx'
import { PlatformCatalog } from './views/catalog.tsx'

type Section =
  | 'dashboard'
  | 'catalog'
  | 'clusters'
  | 'nodes'
  | 'workloads'
  | 'pods'
  | 'networking'
  | 'storage'
  | 'config'
  | 'rbac'
  | 'events'
  | 'crds'
  | 'explore'
  | 'shell'
  | 'logs'
  | 'metrics'
  | 'ci'
  | 'policy'
  | 'observability'
  | 'marketplace'
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

interface SectionDef {
  id: Section
  label: string
  description: string
  kind: 'k8s' | 'xr' | 'marketplace'
}

const SECTIONS: Record<Section, SectionDef> = {
  dashboard: {
    id: 'dashboard',
    label: 'Platform Dashboard',
    description: 'Cluster pulse — capacity, pod phases, node health, recent events at a glance.',
    kind: 'k8s',
  },
  clusters: {
    id: 'clusters',
    label: 'Clusters',
    description: 'Cluster capacity, version, and API surface.',
    kind: 'k8s',
  },
  nodes: {
    id: 'nodes',
    label: 'Nodes',
    description: 'Every worker — capacity, conditions, taints, system info.',
    kind: 'k8s',
  },
  workloads: {
    id: 'workloads',
    label: 'Workloads',
    description: 'Deployments, StatefulSets, DaemonSets, Jobs, CronJobs.',
    kind: 'k8s',
  },
  pods: {
    id: 'pods',
    label: 'Pods',
    description: 'Live pods with logs, shell, metrics, and YAML edit.',
    kind: 'k8s',
  },
  networking: {
    id: 'networking',
    label: 'Networking',
    description: 'Services + Ingresses across namespaces.',
    kind: 'k8s',
  },
  storage: {
    id: 'storage',
    label: 'Storage',
    description: 'PersistentVolumeClaims, PersistentVolumes, StorageClasses.',
    kind: 'k8s',
  },
  config: {
    id: 'config',
    label: 'Config & Secrets',
    description: 'ConfigMaps and Secrets — values always redacted.',
    kind: 'k8s',
  },
  rbac: {
    id: 'rbac',
    label: 'RBAC',
    description: 'ServiceAccounts, Roles, and their bindings.',
    kind: 'k8s',
  },
  events: {
    id: 'events',
    label: 'Events',
    description: 'Warning + normal events, newest first, auto-refreshed.',
    kind: 'k8s',
  },
  crds: {
    id: 'crds',
    label: 'Custom Resources',
    description: 'Browse CRDs from Argo, Kargo, Crossplane, Kyverno, and more.',
    kind: 'k8s',
  },
  explore: {
    id: 'explore',
    label: 'Explore',
    description: 'Discovery-driven browser for every Kubernetes kind — live tables with an inline manifest editor.',
    kind: 'k8s',
  },
  shell: {
    id: 'shell',
    label: 'Cloud Shell',
    description: 'An in-browser terminal into any pod — runs as you, with your Kubernetes RBAC.',
    kind: 'k8s',
  },
  logs: {
    id: 'logs',
    label: 'Logs',
    description: 'Live, streaming pod logs with follow, filter, and download.',
    kind: 'k8s',
  },
  metrics: {
    id: 'metrics',
    label: 'Metrics',
    description: 'Cluster CPU + memory — node capacity, usage, and the heaviest pods.',
    kind: 'k8s',
  },
  ci: {
    id: 'ci',
    label: 'CI / CD Runs',
    description: 'Live Argo Workflows + Tekton pipeline runs with status and drill-in.',
    kind: 'k8s',
  },
  policy: {
    id: 'policy',
    label: 'Policy',
    description: 'Kyverno PolicyReports aggregated across the cluster.',
    kind: 'k8s',
  },
  observability: {
    id: 'observability',
    label: 'Observability',
    description: 'Prometheus Operator health + ServiceMonitors installed here.',
    kind: 'k8s',
  },
  marketplace: {
    id: 'marketplace',
    label: 'Marketplace',
    description:
      'Curated Helm charts — install in one click with full integration into the platform.',
    kind: 'marketplace',
  },
  applications: {
    id: 'applications',
    label: 'Applications',
    description:
      'End-to-end service claims — repo, image, runtime target, observability wiring.',
    kind: 'xr',
  },
  databases: {
    id: 'databases',
    label: 'Databases',
    description: 'Managed PostgreSQL / MySQL / Mongo claims provisioned via Crossplane.',
    kind: 'xr',
  },
  'data-pipelines': {
    id: 'data-pipelines',
    label: 'Data Pipelines',
    description:
      'ELT & streaming flows — Airbyte connectors, Iceberg tables, MinIO sinks composed end-to-end.',
    kind: 'xr',
  },
  pipelines: {
    id: 'pipelines',
    label: 'Pipelines',
    description: 'CI/CD pipelines — Argo Workflows templates composed into reusable pipelines.',
    kind: 'xr',
  },
  routes: {
    id: 'routes',
    label: 'Routes',
    description: 'Ingress + TLS + rate-limit composition fronting applications.',
    kind: 'xr',
  },
  caches: {
    id: 'caches',
    label: 'Caches',
    description: 'Redis / Memcached / Dragonfly claims with HA, persistence, and TLS.',
    kind: 'xr',
  },
  buckets: {
    id: 'buckets',
    label: 'Buckets',
    description: 'Object-storage claims fronting S3 / MinIO / GCS — versioning, lifecycle, encryption.',
    kind: 'xr',
  },
  topics: {
    id: 'topics',
    label: 'Topics',
    description: 'Kafka / NATS / RabbitMQ subjects with retention, partitions, and ACL bindings.',
    kind: 'xr',
  },
  functions: {
    id: 'functions',
    label: 'Functions',
    description: 'Serverless functions on Knative / OpenFaaS — scale-to-zero with event triggers.',
    kind: 'xr',
  },
  workflows: {
    id: 'workflows',
    label: 'Workflows',
    description: 'Long-running orchestrations — Temporal namespaces and Argo Workflows templates.',
    kind: 'xr',
  },
  environments: {
    id: 'environments',
    label: 'Environments',
    description: 'Namespace blueprints — RBAC, ResourceQuota, NetworkPolicy, observability composed as one.',
    kind: 'xr',
  },
  domains: {
    id: 'domains',
    label: 'Domains',
    description: 'Managed DNS + automatic TLS issuance, alias chains, and geo policies.',
    kind: 'xr',
  },
  'api-contracts': {
    id: 'api-contracts',
    label: 'API Contracts',
    description: 'Published OpenAPI / AsyncAPI / GraphQL surfaces with version, owner, and consumer SLOs.',
    kind: 'xr',
  },
  catalog: {
    id: 'catalog',
    label: 'Platform Catalog',
    description: 'Every Adhar Platform abstraction at a glance — claim resources without hand-rolling YAML.',
    kind: 'xr',
  },
}

export default function PlatformHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section]?.id ?? 'dashboard') as Section
  const def = SECTIONS[active]
  const [namespace, setNamespace] = useState<string | undefined>(undefined)

  const ownNamespacePicker = active === 'shell' || active === 'logs' || active === 'ci'
  const showNamespacePicker =
    active !== 'marketplace' &&
    active !== 'dashboard' &&
    active !== 'catalog' &&
    active !== 'clusters' &&
    active !== 'environments' &&
    active !== 'explore' &&
    active !== 'metrics' &&
    !ownNamespacePicker

  return (
    <div className="space-y-6">
      <PageHeader
        title={def.label}
        description={def.description}
        actions={
          showNamespacePicker ? (
            <NamespacePicker value={namespace} onChange={setNamespace} />
          ) : null
        }
      />
      <ConnectionGate>
        <SectionBody active={active} namespace={namespace} />
      </ConnectionGate>
    </div>
  )
}

function SectionBody({
  active,
  namespace,
}: {
  active: Section
  namespace?: string
}) {
  switch (active) {
    case 'dashboard':
      return <PlatformDashboard />
    case 'clusters':
      return <ClusterView />
    case 'nodes':
      return <NodesView />
    case 'workloads':
      return <WorkloadView namespace={namespace} />
    case 'pods':
      return <PodsView namespace={namespace} />
    case 'networking':
      return <NetworkingView namespace={namespace} />
    case 'storage':
      return <StorageView namespace={namespace} />
    case 'config':
      return <ConfigView namespace={namespace} />
    case 'rbac':
      return <RbacView namespace={namespace} />
    case 'events':
      return <EventsView namespace={namespace} />
    case 'crds':
      return <CrdBrowser namespace={namespace} />
    case 'explore':
      return <ResourceBrowser namespace={namespace} />
    case 'shell':
      return <CloudShell namespace={namespace} />
    case 'logs':
      return <LogsViewer namespace={namespace} />
    case 'metrics':
      return <MetricsView />
    case 'ci':
      return <CiRunsView namespace={namespace} />
    case 'policy':
      return <PolicyView />
    case 'observability':
      return <ObservabilityView />
    case 'marketplace':
      return <MarketplaceView />
    case 'applications':
      return <ApplicationsView namespace={namespace} />
    case 'databases':
      return <DatabasesView namespace={namespace} />
    case 'data-pipelines':
      return <DataPipelinesView namespace={namespace} />
    case 'pipelines':
      return <PipelinesView namespace={namespace} />
    case 'routes':
      return <RoutesView namespace={namespace} />
    case 'caches':
      return <CachesView namespace={namespace} />
    case 'buckets':
      return <BucketsView namespace={namespace} />
    case 'topics':
      return <TopicsView namespace={namespace} />
    case 'functions':
      return <FunctionsView namespace={namespace} />
    case 'workflows':
      return <WorkflowsView namespace={namespace} />
    case 'environments':
      return <EnvironmentsView />
    case 'domains':
      return <DomainsView namespace={namespace} />
    case 'api-contracts':
      return <ApiContractsView namespace={namespace} />
    case 'catalog':
      return <PlatformCatalog />
  }
}

