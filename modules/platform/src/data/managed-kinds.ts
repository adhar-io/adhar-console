import { useQuery } from '@tanstack/react-query'
import type { k8s } from '@adhar-console/api-clients'
import { client, useActiveCluster } from './client.ts'
import type { XrdInfo } from './xrds.ts'
import type { FamilyId, GlyphId } from '../views/xr-kinds.tsx'

/**
 * Operator-managed platform resources.
 *
 * "Adhar Resources" used to list only Crossplane composites (XRDs). That is the
 * set of things you can *claim* — but on a running platform most of the real
 * data services are provisioned by their own operators, not through a claim: a
 * database is a CloudNativePG `Cluster`, a broker is a Strimzi `Kafka`, a cache
 * is a Redis-operator `Redis`. With no composite claimed anywhere, the page was
 * honestly empty while the cluster was full of exactly the resources the
 * operator expected to see.
 *
 * So the catalog has a second source: the well-known operator kinds the Adhar
 * platform installs, described here and then **filtered against the CRDs that
 * are actually present on the cluster** — nothing is assumed to exist. A kind
 * whose operator isn't installed simply never appears.
 *
 * These are surfaced read-only (browse + topology + health). Creating one is
 * the operator's own concern, and the schema-driven claim form only makes
 * sense for a composite.
 */

const CRD_GVR: k8s.GVR = {
  group: 'apiextensions.k8s.io',
  version: 'v1',
  resource: 'customresourcedefinitions',
  namespaced: false,
}

export interface ManagedKind {
  /** `<plural>.<group>` — the CRD name we check for. */
  crd: string
  group: string
  version: string
  plural: string
  kind: string
  singular: string
  pluralLabel: string
  namespaced: boolean
  family: FamilyId
  icon: GlyphId
  /** Which operator provides it — shown on the tile so the origin is obvious. */
  provider: string
  description: string
}

/**
 * The operator-backed kinds worth showing as platform resources.
 *
 * Deliberately curated rather than "every CRD on the cluster": a cluster has
 * hundreds of CRDs (every provider, every controller's internal bookkeeping),
 * and listing them all would bury the handful that represent something a team
 * actually provisioned.
 */
export const MANAGED_KINDS: ManagedKind[] = [
  /* ── data ── */
  {
    crd: 'clusters.postgresql.cnpg.io',
    group: 'postgresql.cnpg.io',
    version: 'v1',
    plural: 'clusters',
    kind: 'Cluster',
    singular: 'Database',
    pluralLabel: 'Databases',
    namespaced: true,
    family: 'data',
    icon: 'database',
    provider: 'CloudNativePG',
    description: 'PostgreSQL clusters run by CloudNativePG — replicas, primary, backups and health.',
  },
  {
    crd: 'redis.redis.redis.opstreelabs.in',
    group: 'redis.redis.opstreelabs.in',
    version: 'v1beta2',
    plural: 'redis',
    kind: 'Redis',
    singular: 'Cache',
    pluralLabel: 'Caches',
    namespaced: true,
    family: 'data',
    icon: 'zap',
    provider: 'Redis / Valkey operator',
    description: 'Standalone Redis / Valkey caches managed by the Redis operator.',
  },
  {
    crd: 'redisclusters.redis.redis.opstreelabs.in',
    group: 'redis.redis.opstreelabs.in',
    version: 'v1beta2',
    plural: 'redisclusters',
    kind: 'RedisCluster',
    singular: 'Cache cluster',
    pluralLabel: 'Cache clusters',
    namespaced: true,
    family: 'data',
    icon: 'zap',
    provider: 'Redis / Valkey operator',
    description: 'Sharded Redis / Valkey clusters — the highly available cache tier.',
  },
  {
    crd: 'redisreplications.redis.redis.opstreelabs.in',
    group: 'redis.redis.opstreelabs.in',
    version: 'v1beta2',
    plural: 'redisreplications',
    kind: 'RedisReplication',
    singular: 'Cache replication',
    pluralLabel: 'Cache replications',
    namespaced: true,
    family: 'data',
    icon: 'zap',
    provider: 'Redis / Valkey operator',
    description: 'Primary/replica Redis / Valkey sets.',
  },
  {
    crd: 'kafkas.kafka.strimzi.io',
    group: 'kafka.strimzi.io',
    version: 'v1',
    plural: 'kafkas',
    kind: 'Kafka',
    singular: 'Kafka cluster',
    pluralLabel: 'Kafka clusters',
    namespaced: true,
    family: 'data',
    icon: 'radio',
    provider: 'Strimzi',
    description: 'Kafka clusters run by Strimzi — brokers, controllers and listeners.',
  },
  {
    crd: 'kafkatopics.kafka.strimzi.io',
    group: 'kafka.strimzi.io',
    version: 'v1',
    plural: 'kafkatopics',
    kind: 'KafkaTopic',
    singular: 'Kafka topic',
    pluralLabel: 'Kafka topics',
    namespaced: true,
    family: 'data',
    icon: 'waves',
    provider: 'Strimzi',
    description: 'Topics declared against a Strimzi Kafka cluster — partitions and replication.',
  },
  {
    crd: 'kafkaconnects.kafka.strimzi.io',
    group: 'kafka.strimzi.io',
    version: 'v1',
    plural: 'kafkaconnects',
    kind: 'KafkaConnect',
    singular: 'Kafka Connect',
    pluralLabel: 'Kafka Connect clusters',
    namespaced: true,
    family: 'data',
    icon: 'waves',
    provider: 'Strimzi',
    description: 'Kafka Connect clusters and their connector plugins.',
  },
  {
    crd: 'kafkanodepools.kafka.strimzi.io',
    group: 'kafka.strimzi.io',
    version: 'v1',
    plural: 'kafkanodepools',
    kind: 'KafkaNodePool',
    singular: 'Kafka node pool',
    pluralLabel: 'Kafka node pools',
    namespaced: true,
    family: 'data',
    icon: 'layers',
    provider: 'Strimzi',
    description: 'Broker / controller node pools backing a Kafka cluster.',
  },
  {
    crd: 'tenants.minio.min.io',
    group: 'minio.min.io',
    version: 'v2',
    plural: 'tenants',
    kind: 'Tenant',
    singular: 'Object store',
    pluralLabel: 'Object stores',
    namespaced: true,
    family: 'data',
    icon: 'archive',
    provider: 'MinIO operator',
    description: 'MinIO tenants — the S3-compatible object storage backing buckets.',
  },
  {
    crd: 'objectbucketclaims.objectbucket.io',
    group: 'objectbucket.io',
    version: 'v1alpha1',
    plural: 'objectbucketclaims',
    kind: 'ObjectBucketClaim',
    singular: 'Bucket',
    pluralLabel: 'Buckets',
    namespaced: true,
    family: 'data',
    icon: 'archive',
    provider: 'Object Bucket API',
    description: 'Bucket claims — object storage requested by a workload.',
  },
  {
    crd: 'buckets.objectbucket.io',
    group: 'objectbucket.io',
    version: 'v1alpha1',
    plural: 'buckets',
    kind: 'ObjectBucket',
    singular: 'Bucket',
    pluralLabel: 'Buckets',
    namespaced: false,
    family: 'data',
    icon: 'archive',
    provider: 'Object Bucket API',
    description: 'Provisioned object buckets.',
  },
  {
    crd: 'rabbitmqclusters.rabbitmq.com',
    group: 'rabbitmq.com',
    version: 'v1beta1',
    plural: 'rabbitmqclusters',
    kind: 'RabbitmqCluster',
    singular: 'Message broker',
    pluralLabel: 'Message brokers',
    namespaced: true,
    family: 'data',
    icon: 'radio',
    provider: 'RabbitMQ operator',
    description: 'RabbitMQ clusters — queues and exchanges for asynchronous work.',
  },
  {
    crd: 'mariadbs.k8s.mariadb.com',
    group: 'k8s.mariadb.com',
    version: 'v1alpha1',
    plural: 'mariadbs',
    kind: 'MariaDB',
    singular: 'MariaDB',
    pluralLabel: 'MariaDB databases',
    namespaced: true,
    family: 'data',
    icon: 'database',
    provider: 'MariaDB operator',
    description: 'MariaDB instances managed by the MariaDB operator.',
  },
  /* ── connectivity ── */
  {
    crd: 'gateways.gateway.networking.k8s.io',
    group: 'gateway.networking.k8s.io',
    version: 'v1',
    plural: 'gateways',
    kind: 'Gateway',
    singular: 'Gateway',
    pluralLabel: 'Gateways',
    namespaced: true,
    family: 'connectivity',
    icon: 'network',
    provider: 'Gateway API',
    description: 'Cluster ingress points — listeners, addresses and attached routes.',
  },
  /* ── governance ── */
  {
    crd: 'certificates.cert-manager.io',
    group: 'cert-manager.io',
    version: 'v1',
    plural: 'certificates',
    kind: 'Certificate',
    singular: 'Certificate',
    pluralLabel: 'Certificates',
    namespaced: true,
    family: 'governance',
    icon: 'certificate',
    provider: 'cert-manager',
    description: 'TLS certificates issued and renewed by cert-manager.',
  },
]

/** An operator-managed kind, shaped like a discovered XRD so the catalog can mix them. */
export type ManagedKindInfo = XrdInfo & {
  managed: true
  provider: string
  managedDescription: string
  managedIcon: GlyphId
  managedFamily: FamilyId
}

function toInfo(m: ManagedKind): ManagedKindInfo {
  return {
    gvr: { group: m.group, version: m.version, resource: m.plural, namespaced: m.namespaced },
    group: m.group,
    version: m.version,
    kind: m.kind,
    plural: m.plural,
    humanSingular: m.singular,
    humanPlural: m.pluralLabel,
    namespaced: m.namespaced,
    parametersMode: false,
    supportsCompositionSelector: false,
    compositionSelectorRequired: false,
    // Operator CRs are not claimed through the composite form, so there are no
    // generated fields — the tile offers Browse only.
    fields: [],
    managed: true,
    provider: m.provider,
    managedDescription: m.description,
    managedIcon: m.icon,
    managedFamily: m.family,
  }
}

interface CrdObject {
  metadata: { name: string }
  spec?: { versions?: Array<{ name: string; served?: boolean; storage?: boolean }> }
}

/**
 * The managed kinds whose CRD is actually installed on the active cluster.
 * The served version is taken from the CRD rather than the table above, so a
 * cluster on a newer operator release is read at the version it really serves.
 */
export function useManagedKinds() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['platform', 'managed-kinds', cluster],
    queryFn: async (): Promise<ManagedKindInfo[]> => {
      const crds = (await client.listGeneric(cluster, CRD_GVR)) as unknown as CrdObject[]
      const byName = new Map(crds.map((c) => [c.metadata.name, c]))
      return MANAGED_KINDS.filter((m) => byName.has(m.crd)).map((m) => {
        const crd = byName.get(m.crd)
        const versions = crd?.spec?.versions ?? []
        const served =
          versions.find((v) => v.storage && v.served) ?? versions.find((v) => v.served) ?? versions[0]
        return toInfo({ ...m, version: served?.name ?? m.version })
      })
    },
    staleTime: 60_000,
    retry: false,
  })
}

export function isManaged(info: XrdInfo): info is ManagedKindInfo {
  return (info as ManagedKindInfo).managed === true
}
