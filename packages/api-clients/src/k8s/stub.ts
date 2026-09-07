import type {
  Cluster,
  Deployment,
  Event,
  Generic,
  Ingress,
  Namespace,
  Node,
  Pod,
  Service,
} from './types.ts'

export const STUB_CLUSTERS: Cluster[] = [
  {
    name: 'adhar-prod',
    server: 'https://k8s.adhar.local',
    version: 'v1.31.2',
    platform: 'linux/amd64',
    nodeCount: 12,
    healthy: true,
    source: 'in-cluster',
  },
  {
    name: 'adhar-staging',
    server: 'https://k8s-staging.adhar.local',
    version: 'v1.31.2',
    platform: 'linux/amd64',
    nodeCount: 6,
    healthy: true,
    source: 'crossplane-managed',
  },
  {
    name: 'adhar-edge-eu',
    server: 'https://k8s-edge-eu.adhar.local',
    version: 'v1.30.5',
    platform: 'linux/arm64',
    nodeCount: 3,
    healthy: false,
    source: 'kubeconfig',
  },
]

export const STUB_NAMESPACES: Namespace[] = [
  {
    metadata: { name: 'demo-console', labels: { 'adhar.io/tenant': 'default' } },
    status: { phase: 'Active' },
  },
  {
    metadata: { name: 'demo-billing', labels: { 'adhar.io/tenant': 'default' } },
    status: { phase: 'Active' },
  },
  {
    metadata: { name: 'globex-api', labels: { 'adhar.io/tenant': 'globex' } },
    status: { phase: 'Active' },
  },
  { metadata: { name: 'argocd' }, status: { phase: 'Active' } },
  { metadata: { name: 'kargo' }, status: { phase: 'Active' } },
  { metadata: { name: 'kyverno' }, status: { phase: 'Active' } },
  { metadata: { name: 'monitoring' }, status: { phase: 'Active' } },
]

export const STUB_NODES: Node[] = [
  {
    metadata: { name: 'ip-10-0-1-12.ec2.internal', labels: { 'node-role.kubernetes.io/control-plane': '' } },
    spec: {},
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      nodeInfo: {
        kubeletVersion: 'v1.31.2',
        osImage: 'Ubuntu 24.04',
        architecture: 'amd64',
        containerRuntimeVersion: 'containerd://2.0.0',
      },
      capacity: { cpu: '8', memory: '32Gi', pods: '110' },
      allocatable: { cpu: '7800m', memory: '30Gi', pods: '110' },
    },
  },
  {
    metadata: { name: 'ip-10-0-2-45.ec2.internal' },
    spec: {},
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      nodeInfo: {
        kubeletVersion: 'v1.31.2',
        osImage: 'Ubuntu 24.04',
        architecture: 'amd64',
        containerRuntimeVersion: 'containerd://2.0.0',
      },
      capacity: { cpu: '16', memory: '64Gi', pods: '110' },
      allocatable: { cpu: '15800m', memory: '62Gi', pods: '110' },
    },
  },
]

export const STUB_PODS: Pod[] = [
  {
    metadata: {
      name: 'adhar-console-7f8b8d5c4-xq2ws',
      namespace: 'demo-console',
      creationTimestamp: '2026-04-19T04:55:00Z',
      labels: { app: 'adhar-console' },
    },
    spec: {
      nodeName: 'ip-10-0-2-45.ec2.internal',
      containers: [{ name: 'app', image: 'harbor.adhar.local/library/adhar-console:v0.2.0' }],
    },
    status: {
      phase: 'Running',
      podIP: '10.244.1.5',
      containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }],
    },
  },
  {
    metadata: {
      name: 'billing-service-5b4c6d8e9-k7fvr',
      namespace: 'demo-billing',
      creationTimestamp: '2026-04-18T22:10:00Z',
      labels: { app: 'billing-service' },
    },
    spec: {
      nodeName: 'ip-10-0-2-45.ec2.internal',
      containers: [{ name: 'api', image: 'harbor.adhar.local/library/billing-service:v1.4.0' }],
    },
    status: {
      phase: 'Running',
      podIP: '10.244.1.9',
      containerStatuses: [{ name: 'api', ready: true, restartCount: 3 }],
    },
  },
  {
    metadata: {
      name: 'billing-service-5b4c6d8e9-wvx4l',
      namespace: 'demo-billing',
      creationTimestamp: '2026-04-19T02:14:00Z',
      labels: { app: 'billing-service' },
    },
    spec: {
      nodeName: 'ip-10-0-2-45.ec2.internal',
      containers: [{ name: 'api', image: 'harbor.adhar.local/library/billing-service:v1.4.0' }],
    },
    status: {
      phase: 'Pending',
      containerStatuses: [{ name: 'api', ready: false, restartCount: 0 }],
    },
  },
]

export const STUB_DEPLOYMENTS: Deployment[] = [
  {
    metadata: {
      name: 'adhar-console',
      namespace: 'demo-console',
      creationTimestamp: '2026-03-02T09:00:00Z',
      labels: { app: 'adhar-console' },
    },
    spec: {
      replicas: 2,
      strategy: { type: 'RollingUpdate' },
      selector: { matchLabels: { app: 'adhar-console' } },
    },
    status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
  },
  {
    metadata: {
      name: 'billing-service',
      namespace: 'demo-billing',
      creationTimestamp: '2026-02-14T09:00:00Z',
      labels: { app: 'billing-service' },
    },
    spec: {
      replicas: 3,
      strategy: { type: 'RollingUpdate' },
      selector: { matchLabels: { app: 'billing-service' } },
    },
    status: {
      replicas: 3,
      readyReplicas: 1,
      availableReplicas: 1,
      conditions: [
        { type: 'Available', status: 'False', message: '2/3 pods not ready' },
      ],
    },
  },
]

export const STUB_SERVICES: Service[] = [
  {
    metadata: { name: 'adhar-console', namespace: 'demo-console' },
    spec: {
      type: 'ClusterIP',
      clusterIP: '10.96.32.12',
      ports: [{ port: 80, targetPort: 3000, protocol: 'TCP' }],
      selector: { app: 'adhar-console' },
    },
  },
  {
    metadata: { name: 'billing-service', namespace: 'demo-billing' },
    spec: {
      type: 'ClusterIP',
      clusterIP: '10.96.48.7',
      ports: [{ port: 8080, targetPort: 8080, protocol: 'TCP' }],
      selector: { app: 'billing-service' },
    },
  },
]

export const STUB_INGRESSES: Ingress[] = [
  {
    metadata: { name: 'adhar-console', namespace: 'demo-console' },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: 'console.adhar.local',
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'adhar-console', port: { number: 80 } } },
              },
            ],
          },
        },
      ],
    },
  },
]

export const STUB_EVENTS: Event[] = [
  {
    metadata: { name: 'billing-service.abc1', namespace: 'demo-billing' },
    type: 'Warning',
    reason: 'CrashLoopBackOff',
    message: 'Back-off restarting failed container',
    count: 4,
    lastTimestamp: '2026-04-19T06:05:00Z',
    involvedObject: { kind: 'Pod', name: 'billing-service-5b4c6d8e9-k7fvr', namespace: 'demo-billing' },
  },
  {
    metadata: { name: 'adhar-console.def2', namespace: 'demo-console' },
    type: 'Normal',
    reason: 'Scheduled',
    message: 'Successfully assigned to ip-10-0-2-45',
    count: 1,
    lastTimestamp: '2026-04-19T04:55:00Z',
    involvedObject: { kind: 'Pod', name: 'adhar-console-7f8b8d5c4-xq2ws', namespace: 'demo-console' },
  },
]

/**
 * CRD objects — keyed by `${group}/${version}/${resource}`.
 * Covers the Adhar stack: ArgoCD, Kargo, Crossplane, Kyverno, Argo Workflows, Argo Rollouts.
 */
export const STUB_CRD_OBJECTS: Record<string, Generic[]> = {
  'argoproj.io/v1alpha1/applications': [
    {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { name: 'adhar-console', namespace: 'argocd' },
      spec: { project: 'default' },
      status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } },
    },
  ],
  'kargo.akuity.io/v1alpha1/stages': [
    {
      apiVersion: 'kargo.akuity.io/v1alpha1',
      kind: 'Stage',
      metadata: { name: 'prod', namespace: 'kargo-default' },
      spec: {},
      status: { phase: 'Steady' },
    },
  ],
  'apiextensions.crossplane.io/v1/compositions': [
    {
      apiVersion: 'apiextensions.crossplane.io/v1',
      kind: 'Composition',
      metadata: { name: 'xeks-standard' },
      spec: { compositeTypeRef: { apiVersion: 'example.io/v1alpha1', kind: 'XEKS' } },
    },
  ],
  'kyverno.io/v1/clusterpolicies': [
    {
      apiVersion: 'kyverno.io/v1',
      kind: 'ClusterPolicy',
      metadata: { name: 'require-labels' },
      spec: { validationFailureAction: 'enforce' },
    },
  ],
  'argoproj.io/v1alpha1/workflows': [
    {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Workflow',
      metadata: { name: 'adhar-console-build-xyz12', namespace: 'argo' },
      spec: {},
      status: { phase: 'Succeeded' },
    },
  ],
  'argoproj.io/v1alpha1/rollouts': [
    {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Rollout',
      metadata: { name: 'adhar-console', namespace: 'demo-console' },
      spec: {},
      status: { phase: 'Healthy' },
    },
  ],
  /* ───── Adhar Platform composites ──────────────────────────────────── */
  'platform.adhar.io/v1alpha1/applications': [
    xr('Application', 'web', 'demo-console', {
      repo: 'github.com/example/web',
      image: 'ghcr.io/example/web:1.4.2',
      replicas: 3,
      environment: 'prod',
      compositionRef: { name: 'application-standard' },
    }, ['Deployment/web', 'Service/web', 'Ingress/web']),
    xr('Application', 'api', 'demo-console', {
      repo: 'github.com/example/api',
      image: 'ghcr.io/example/api:2.0.0-rc.3',
      replicas: 2,
      environment: 'staging',
      compositionRef: { name: 'application-standard' },
    }, ['Deployment/api', 'Service/api']),
  ],
  'platform.adhar.io/v1alpha1/databases': [
    xr('Database', 'orders-pg', 'demo-data', {
      engine: 'postgres',
      version: '15.4',
      size: 'db.t3.medium',
      storageGb: 200,
      backupRetentionDays: 14,
      compositionRef: { name: 'database-postgres-aws' },
    }, ['RDSInstance/orders-pg', 'SecurityGroup/orders-pg']),
    xr('Database', 'audit-mongo', 'demo-data', {
      engine: 'mongodb',
      version: '7.0',
      size: 'M30',
      storageGb: 100,
      backupRetentionDays: 30,
      compositionRef: { name: 'database-mongo-atlas' },
    }, ['MongoCluster/audit-mongo']),
  ],
  'platform.adhar.io/v1alpha1/datapipelines': [
    xr('DataPipeline', 'salesforce-to-warehouse', 'demo-data', {
      source: { type: 'airbyte', name: 'salesforce' },
      destination: { type: 'iceberg', name: 'sales-cold' },
      schedule: '0 */6 * * *',
      mode: 'batch',
      compositionRef: { name: 'datapipeline-airbyte' },
    }, ['AirbyteConnection/sf-cold', 'IcebergTable/sales']),
    xr('DataPipeline', 'events-to-lake', 'demo-data', {
      source: { type: 'kafka', name: 'events' },
      destination: { type: 'minio', name: 'lake-bronze' },
      mode: 'streaming',
      compositionRef: { name: 'datapipeline-kafka-stream' },
    }, ['KafkaConnect/events-bronze']),
  ],
  'platform.adhar.io/v1alpha1/pipelines': [
    xr('Pipeline', 'web-ci', 'demo-console', {
      trigger: 'push:main',
      template: 'argo-build-test-deploy',
      parallelism: 4,
      timeoutSeconds: 1800,
      compositionRef: { name: 'pipeline-argo-default' },
    }, ['WorkflowTemplate/web-ci']),
    xr('Pipeline', 'nightly-e2e', 'demo-console', {
      trigger: 'cron:@daily',
      template: 'argo-e2e',
      parallelism: 2,
      timeoutSeconds: 7200,
      compositionRef: { name: 'pipeline-argo-default' },
    }, ['CronWorkflow/nightly-e2e']),
  ],
  'platform.adhar.io/v1alpha1/routes': [
    xr('Route', 'web-public', 'demo-console', {
      host: 'app.example.com',
      path: '/',
      target: 'web',
      tls: { enabled: true, issuer: 'letsencrypt-prod' },
      rateLimit: '500r/s',
      compositionRef: { name: 'route-public-https' },
    }, ['Ingress/web-public', 'Certificate/app-example-com']),
    xr('Route', 'api-internal', 'demo-console', {
      host: 'api.internal.example',
      path: '/v1',
      target: 'api',
      tls: { enabled: true, issuer: 'mesh-ca' },
      rateLimit: '2000r/s',
      compositionRef: { name: 'route-internal-mtls' },
    }, ['Ingress/api-internal']),
  ],
  'platform.adhar.io/v1alpha1/caches': [
    xr('Cache', 'session-store', 'demo-console', {
      engine: 'redis',
      version: '7.2',
      size: 'cache.t3.small',
      memoryMb: 2048,
      replicas: 2,
      persistence: 'aof',
      tls: true,
      compositionRef: { name: 'cache-redis-ha' },
    }, ['ElastiCache/session-store']),
    xr('Cache', 'rate-limit', 'demo-edge', {
      engine: 'dragonfly',
      version: '1.20',
      size: 'small',
      memoryMb: 1024,
      replicas: 1,
      persistence: 'none',
      tls: false,
      compositionRef: { name: 'cache-dragonfly' },
    }, ['StatefulSet/rate-limit']),
  ],
  'platform.adhar.io/v1alpha1/buckets': [
    xr('Bucket', 'web-assets', 'demo-console', {
      provider: 'aws-s3',
      region: 'eu-west-1',
      visibility: 'private',
      versioning: true,
      encryption: 'aws:kms',
      lifecycleDays: 365,
      compositionRef: { name: 'bucket-s3' },
    }, ['Bucket/demo-web-assets']),
    xr('Bucket', 'public-downloads', 'demo-console', {
      provider: 'aws-s3',
      region: 'eu-west-1',
      visibility: 'public',
      versioning: false,
      encryption: 'aes-256',
      lifecycleDays: 30,
      compositionRef: { name: 'bucket-s3' },
    }, ['Bucket/demo-public-downloads']),
    xr('Bucket', 'lake-bronze', 'demo-data', {
      provider: 'minio',
      region: 'on-prem',
      visibility: 'private',
      versioning: true,
      encryption: 'sse-s3',
      lifecycleDays: 0,
      compositionRef: { name: 'bucket-minio' },
    }, ['MinioBucket/lake-bronze']),
  ],
  'platform.adhar.io/v1alpha1/topics': [
    xr('Topic', 'orders.events.v1', 'demo-events', {
      broker: 'kafka.platform.svc',
      partitions: 12,
      replicationFactor: 3,
      retentionHours: 168,
      compaction: false,
      schema: 'avro://schema-registry/orders-events-v1',
      compositionRef: { name: 'topic-kafka' },
    }, ['KafkaTopic/orders-events-v1']),
    xr('Topic', 'audit.events.v2', 'demo-events', {
      broker: 'kafka.platform.svc',
      partitions: 6,
      replicationFactor: 3,
      retentionHours: 720,
      compaction: true,
      schema: 'avro://schema-registry/audit-events-v2',
      compositionRef: { name: 'topic-kafka' },
    }, ['KafkaTopic/audit-events-v2']),
    xr('Topic', 'notifications', 'demo-events', {
      broker: 'nats.platform.svc',
      partitions: 4,
      replicationFactor: 2,
      retentionHours: 24,
      compaction: false,
      compositionRef: { name: 'topic-nats' },
    }, ['NatsStream/notifications']),
  ],
  'platform.adhar.io/v1alpha1/functions': [
    xr('Function', 'image-thumbnail', 'demo-console', {
      runtime: 'node20',
      image: 'ghcr.io/example/fn-thumb:1.0.3',
      minScale: 0,
      maxScale: 50,
      timeoutSeconds: 30,
      eventSource: 'bucket://web-assets/uploads/*',
      compositionRef: { name: 'function-knative' },
    }, ['Service/image-thumbnail']),
    xr('Function', 'order-webhook', 'demo-console', {
      runtime: 'go1.22',
      image: 'ghcr.io/example/fn-orders:2.4.1',
      minScale: 1,
      maxScale: 20,
      timeoutSeconds: 15,
      eventSource: 'topic://orders.events.v1',
      compositionRef: { name: 'function-knative' },
    }, ['Service/order-webhook', 'Trigger/order-webhook']),
  ],
  'platform.adhar.io/v1alpha1/workflows': [
    xr('Workflow', 'monthly-billing', 'demo-finance', {
      engine: 'temporal',
      template: 'billing/monthly',
      schedule: '0 4 1 * *',
      slaSeconds: 3600,
      retries: 3,
      compositionRef: { name: 'workflow-temporal' },
    }, ['TemporalSchedule/monthly-billing']),
    xr('Workflow', 'data-quality-scan', 'demo-data', {
      engine: 'argo-workflows',
      template: 'argo/dq-scan',
      schedule: '0 */4 * * *',
      slaSeconds: 1800,
      retries: 1,
      compositionRef: { name: 'workflow-argo' },
    }, ['CronWorkflow/data-quality-scan']),
  ],
  'platform.adhar.io/v1alpha1/environments': [
    xr('Environment', 'demo-prod', undefined, {
      tier: 'prod',
      cluster: 'eu-west-1',
      tenant: 'default',
      cpuQuota: '64',
      memoryQuota: '256Gi',
      observability: 'lgtm-tier-1',
      compositionRef: { name: 'environment-tier-1' },
    }, ['Namespace/demo-prod', 'ResourceQuota/demo-prod', 'NetworkPolicy/default-deny']),
    xr('Environment', 'demo-staging', undefined, {
      tier: 'staging',
      cluster: 'eu-west-1',
      tenant: 'default',
      cpuQuota: '32',
      memoryQuota: '128Gi',
      observability: 'lgtm-tier-2',
      compositionRef: { name: 'environment-tier-2' },
    }, ['Namespace/demo-staging']),
    xr('Environment', 'demo-dev', undefined, {
      tier: 'dev',
      cluster: 'eu-west-1',
      tenant: 'default',
      cpuQuota: '16',
      memoryQuota: '64Gi',
      observability: 'lgtm-tier-3',
      compositionRef: { name: 'environment-tier-3' },
    }, ['Namespace/demo-dev']),
  ],
  'platform.adhar.io/v1alpha1/domains': [
    xr('Domain', 'app-example-com', 'demo-console', {
      fqdn: 'app.example.com',
      zone: 'example.io',
      certIssuer: 'letsencrypt-prod',
      compositionRef: { name: 'domain-public' },
    }, ['DNSRecord/app.example.com', 'Certificate/app-example-com']),
    xr('Domain', 'api-internal-example', 'demo-console', {
      fqdn: 'api.internal.example',
      zone: 'internal.example',
      certIssuer: 'mesh-ca',
      geo: 'eu-only',
      compositionRef: { name: 'domain-internal' },
    }, ['DNSRecord/api.internal.example']),
  ],
  'platform.adhar.io/v1alpha1/apicontracts': [
    xr('APIContract', 'orders-v1', 'demo-console', {
      kind: 'OpenAPI',
      specRef: 'git://adhar/contracts/orders-v1.yaml',
      version: '1.4.0',
      owner: 'team-orders',
      visibility: 'tenant',
      sloMs: 250,
      compositionRef: { name: 'apicontract-openapi' },
    }, ['ConfigMap/orders-v1-spec']),
    xr('APIContract', 'audit-events', 'demo-console', {
      kind: 'AsyncAPI',
      specRef: 'git://adhar/contracts/audit-events.yaml',
      version: '2.0.0',
      owner: 'team-platform',
      visibility: 'public',
      sloMs: 100,
      compositionRef: { name: 'apicontract-asyncapi' },
    }, ['ConfigMap/audit-events-spec']),
  ],
}

/**
 * Build a Crossplane-shaped Composite Resource for the stub catalog. Adds the
 * standard `Ready` + `Synced` conditions plus a synthetic creation timestamp
 * so the lists feel populated.
 */
function xr(
  kind: string,
  name: string,
  namespace: string | undefined,
  spec: Record<string, unknown>,
  composedRefs: string[],
): Generic {
  const created = new Date(Date.now() - Math.floor(Math.random() * 30 + 1) * 24 * 60 * 60 * 1000).toISOString()
  return {
    apiVersion: 'platform.adhar.io/v1alpha1',
    kind,
    metadata: {
      name,
      namespace,
      uid: `${kind.toLowerCase()}-${name}`,
      creationTimestamp: created,
      labels: { 'platform.adhar.io/owner': 'team-platform' },
    },
    spec,
    status: {
      conditions: [
        { type: 'Ready', status: 'True', reason: 'Available', lastTransitionTime: created },
        { type: 'Synced', status: 'True', reason: 'ReconcileSuccess', lastTransitionTime: created },
      ],
      resourceRefs: composedRefs.map((ref) => {
        const [k, n] = ref.split('/')
        return { apiVersion: 'apps/v1', kind: k, name: n, namespace }
      }),
    },
  }
}
