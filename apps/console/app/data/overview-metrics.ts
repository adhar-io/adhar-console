import { useQuery } from '@tanstack/react-query'
import { promRange, usePromInstant } from './prom-instant.ts'

/**
 * Prometheus-backed Overview signals.
 *
 * Every query here was written against what the platform stack actually
 * exports — Cilium + Hubble (the service mesh), Tetragon and Falco (runtime
 * security), redis_exporter, CloudNativePG's built-in exporter, and kubelet
 * volume stats — and checked against a live install. A query whose exporter
 * is missing returns an empty vector and the panel says which source it needs.
 */

/* ─────────── Cilium mesh security ─────────── */

export const MESH_SECURITY_QUERIES = {
  /** 1 when Cilium's SPIFFE/SPIRE-backed mutual authentication is on. */
  mutualAuth: 'max(cilium_feature_network_policies_mutual_auth_enabled)',
  /** Endpoints per policy-enforcement mode (ingress / egress / both / none / audit-*). */
  enforcement: 'sum by (enforcement) (cilium_policy_endpoint_enforcement_status)',
  /** Flows the datapath dropped because a policy denied them. */
  policyDrops: 'sum(rate(hubble_drop_total{reason="POLICY_DENIED"}[5m]))',
} as const

export function useMeshSecurityMetrics() {
  return usePromInstant('mesh-security', MESH_SECURITY_QUERIES, 60_000)
}

/* ─────────── Hubble traffic (L3/L4 flows + L7 HTTP) ─────────── */

export const HUBBLE_QUERIES = {
  l7Rps: 'sum(rate(hubble_http_requests_total[5m]))',
  statusClass:
    'sum by (class) (label_replace(rate(hubble_http_responses_total[5m]), "class", "${1}xx", "status", "(.).."))',
  methods: 'sum by (method) (rate(hubble_http_requests_total[5m]))',
  p50: '1000 * histogram_quantile(0.5, sum by (le) (rate(hubble_http_request_duration_seconds_bucket[5m])))',
  p95: '1000 * histogram_quantile(0.95, sum by (le) (rate(hubble_http_request_duration_seconds_bucket[5m])))',
  p99: '1000 * histogram_quantile(0.99, sum by (le) (rate(hubble_http_request_duration_seconds_bucket[5m])))',
  flowsByVerdict: 'sum by (verdict) (rate(hubble_flows_processed_total[5m]))',
  dropsByReason: 'topk(6, sum by (reason) (rate(hubble_drop_total[5m])) > 0)',
} as const

export function useHubbleTraffic() {
  return usePromInstant('hubble-traffic', HUBBLE_QUERIES)
}

/** Request latency histogram over the last hour, as cumulative bucket counts. */
export function useHubbleLatencyBuckets() {
  return usePromInstant(
    'hubble-latency-buckets',
    { buckets: 'sum by (le) (increase(hubble_http_request_duration_seconds_bucket[1h]))' },
    60_000,
  )
}

/** L7 responses per status class over the last hour, one series per class. */
export function useHubbleTrafficStream() {
  return useQuery({
    queryKey: ['ov', 'hubble', 'stream'],
    queryFn: () =>
      promRange(
        'sum by (class) (label_replace(rate(hubble_http_responses_total[5m]), "class", "${1}xx", "status", "(.).."))',
        3_600_000,
        60,
      ),
    refetchInterval: 30_000,
    retry: false,
  })
}

/* ─────────── runtime security ─────────── */

export const FALCO_QUERIES = {
  byPriority: 'sum by (priority_raw) (increase(falcosecurity_falcosidekick_falco_events_total[24h]))',
  topRules: 'topk(6, sum by (rule, priority_raw) (increase(falcosecurity_falcosidekick_falco_events_total[24h])) > 0)',
  /** Falco's own liveness: present as soon as one Falco pod is scraped. */
  sensors: 'count(falcosecurity_falco_version_info)',
} as const

export function useFalcoMetrics() {
  return usePromInstant('falco', FALCO_QUERIES, 60_000)
}

export const TETRAGON_QUERIES = {
  /** Loaded TracingPolicies per state; every agent reports the same count, so `max`. */
  policies: 'max by (state) (tetragon_tracingpolicy_loaded)',
  /** Process lifecycle + kprobe events observed in the last 24h. */
  eventsByType: 'sum by (type) (increase(tetragon_events_total[24h]))',
  /** Which workloads tripped which policy — the enforcement signal. */
  topPolicyHits:
    'topk(8, sum by (policy, namespace, workload) (increase(tetragon_policy_events_total[24h])) > 0)',
  agents: 'count(tetragon_build_info)',
} as const

export function useTetragonMetrics() {
  return usePromInstant('tetragon', TETRAGON_QUERIES, 60_000)
}

/* ─────────── data services ─────────── */

export const REDIS_QUERIES = {
  hits: 'sum by (namespace, service) (rate(redis_keyspace_hits_total[5m]))',
  misses: 'sum by (namespace, service) (rate(redis_keyspace_misses_total[5m]))',
  ops: 'sum by (namespace, service) (rate(redis_commands_processed_total[5m]))',
  memUsed: 'sum by (namespace, service) (redis_memory_used_bytes)',
  memMax: 'sum by (namespace, service) (redis_memory_max_bytes)',
  clients: 'sum by (namespace, service) (redis_connected_clients)',
  evicted: 'sum by (namespace, service) (increase(redis_evicted_keys_total[1h]))',
} as const

export function useRedisMetrics() {
  return usePromInstant('redis', REDIS_QUERIES)
}

/**
 * CloudNativePG's exporter labels every series with the PodMonitor job
 * `<namespace>/<cluster>`; grouping by it gives one row per database cluster.
 */
export const CNPG_POOL_QUERIES = {
  backends: 'sum by (namespace, job) (cnpg_backends_total)',
  waiting: 'sum by (namespace, job) (cnpg_backends_waiting_total)',
  maxConnections: 'max by (namespace, job) (cnpg_pg_settings_setting{name="max_connections"})',
  lagSeconds: 'max by (namespace, job) (cnpg_pg_replication_lag)',
  replicas: 'max by (namespace, job) (cnpg_pg_replication_streaming_replicas)',
  longestTx: 'max by (namespace, job) (cnpg_backends_max_tx_duration_seconds)',
} as const

export function useCnpgPoolMetrics() {
  return usePromInstant('cnpg-pool', CNPG_POOL_QUERIES)
}

/** Cluster name from a CNPG PodMonitor job label (`ns/cluster`). */
export const cnpgCluster = (labels: Record<string, string>): string =>
  (labels.job ?? '').split('/').pop() || labels.job || 'unknown'

/* ─────────── storage ─────────── */

export const VOLUME_QUERIES = {
  used: 'sum(kubelet_volume_stats_used_bytes)',
  capacity: 'sum(kubelet_volume_stats_capacity_bytes)',
  reporting: 'count(kubelet_volume_stats_capacity_bytes)',
} as const

export function useVolumeUsage() {
  return usePromInstant('volume-usage', VOLUME_QUERIES, 60_000)
}
