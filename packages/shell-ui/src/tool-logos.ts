/**
 * Official tool logos — manifest + name resolver.
 *
 * The artwork lives in `./logos/<key>.{svg,png}` (downloaded once from each
 * project's own artwork, sanitised, and bundled — never fetched at runtime;
 * provenance per file in `./logos/SOURCES.md`). This module is pure data so it
 * runs under the Deno test runner; the Vite-only glob loader is in
 * `tool-logo.tsx`.
 */

export interface ToolLogoMeta {
  /** Display name, used for the image's alt text ("<name> logo"). */
  name: string
  /** File extension of `./logos/<key>.<ext>`. */
  ext: 'svg' | 'png'
  /**
   * `light` — the artwork is dark-on-transparent (black/navy marks, or a
   * raster with an opaque white canvas), so in dark mode it sits on a light
   * tile instead of being recoloured.
   */
  onDark?: 'light'
}

const svg = (name: string, onDark?: 'light'): ToolLogoMeta => ({ name, ext: 'svg', onDark })
const png = (name: string, onDark?: 'light'): ToolLogoMeta => ({ name, ext: 'png', onDark })

/** Every bundled logo, keyed by file stem. */
export const TOOL_LOGOS: Readonly<Record<string, ToolLogoMeta>> = {
  agentgateway: svg('agentgateway'),
  airbyte: svg('Airbyte'),
  alloy: svg('Grafana Alloy'),
  argo: svg('Argo'),
  baserow: svg('Baserow'),
  beyla: png('Grafana Beyla'),
  buildpacks: svg('Cloud Native Buildpacks', 'light'),
  'cert-manager': svg('cert-manager'),
  'chaos-mesh': svg('Chaos Mesh', 'light'),
  cilium: svg('Cilium'),
  'cloudnative-pg': svg('CloudNativePG', 'light'),
  coder: svg('Coder', 'light'),
  cosign: svg('Sigstore Cosign'),
  crossplane: svg('Crossplane'),
  dagster: svg('Dagster'),
  dapr: svg('Dapr', 'light'),
  dbt: png('dbt'),
  dex: svg('Dex'),
  'external-dns': png('ExternalDNS'),
  'external-secrets': svg('External Secrets Operator', 'light'),
  falco: svg('Falco'),
  faro: png('Grafana Faro'),
  'fluent-bit': svg('Fluent Bit'),
  flux: svg('Flux'),
  gitea: svg('Gitea'),
  grafana: svg('Grafana'),
  harbor: svg('Harbor'),
  headlamp: svg('Headlamp'),
  helm: svg('Helm', 'light'),
  hubble: png('Hubble', 'light'),
  istio: svg('Istio', 'light'),
  jaeger: svg('Jaeger'),
  jupyterhub: svg('JupyterHub'),
  k6: svg('Grafana k6'),
  k8sgpt: svg('K8sGPT'),
  'kafka-ui': svg('Kafka UI'),
  kamaji: svg('Kamaji', 'light'),
  kargo: png('Kargo'),
  karmada: svg('Karmada'),
  'kata-containers': png('Kata Containers'),
  keda: svg('KEDA'),
  keycloak: svg('Keycloak'),
  knative: svg('Knative'),
  kubeflow: svg('Kubeflow'),
  'kubeflow-pipelines': svg('Kubeflow Pipelines'),
  kubernetes: svg('Kubernetes'),
  kubescape: svg('Kubescape'),
  kyverno: svg('Kyverno'),
  'libredb-studio': svg('LibreDB Studio'),
  litmus: svg('LitmusChaos'),
  'llm-d': svg('llm-d', 'light'),
  loki: svg('Grafana Loki'),
  longhorn: svg('Longhorn'),
  mariadb: svg('MariaDB', 'light'),
  metabase: svg('Metabase', 'light'),
  mimir: svg('Grafana Mimir'),
  minio: svg('MinIO'),
  mlflow: svg('MLflow'),
  mongodb: svg('MongoDB'),
  mysql: svg('MySQL', 'light'),
  n8n: svg('n8n', 'light'),
  nats: svg('NATS'),
  neo4j: png('Neo4j', 'light'),
  nexus: svg('Sonatype Nexus', 'light'),
  nvidia: svg('NVIDIA'),
  oncall: svg('Grafana OnCall'),
  'open-metadata': svg('OpenMetadata'),
  openbao: svg('OpenBao'),
  opencost: svg('OpenCost', 'light'),
  openfunction: svg('OpenFunction'),
  opensearch: svg('OpenSearch', 'light'),
  opentelemetry: svg('OpenTelemetry'),
  opentofu: svg('OpenTofu'),
  penpot: svg('Penpot', 'light'),
  pixie: svg('Pixie'),
  plane: svg('Plane', 'light'),
  posthog: svg('PostHog', 'light'),
  prefect: svg('Prefect'),
  prometheus: svg('Prometheus'),
  pyroscope: svg('Grafana Pyroscope'),
  rabbitmq: svg('RabbitMQ'),
  'redis-operator': svg('Redis Operator', 'light'),
  rustfs: png('RustFS'),
  'spark-operator': svg('Kubeflow Spark Operator'),
  strapi: svg('Strapi'),
  strimzi: svg('Strimzi', 'light'),
  tekton: svg('Tekton'),
  tempo: png('Grafana Tempo'),
  tetragon: png('Tetragon', 'light'),
  tldraw: svg('tldraw'),
  tolgee: svg('Tolgee'),
  tooljet: svg('ToolJet'),
  trino: svg('Trino'),
  trivy: png('Trivy', 'light'),
  valkey: svg('Valkey', 'light'),
  vault: svg('HashiCorp Vault', 'light'),
  vcluster: svg('vCluster'),
  velero: svg('Velero', 'light'),
  'victoria-metrics': svg('VictoriaMetrics', 'light'),
  vllm: png('vLLM', 'light'),
  webstudio: svg('Webstudio'),
}

/**
 * Package / app / tool names that differ from a logo key. Keys are
 * normalised (lower-case, `[a-z0-9-]`); values are `TOOL_LOGOS` keys.
 */
export const TOOL_LOGO_ALIASES: Readonly<Record<string, string>> = {
  // Argo family — one project mark.
  argocd: 'argo',
  'argo-cd': 'argo',
  'argo-events': 'argo',
  'argo-rollout': 'argo',
  'argo-rollouts': 'argo',
  'argo-workflows': 'argo',
  argorollouts: 'argo',
  argoworkflows: 'argo',
  // Observability
  'kube-prometheus': 'prometheus',
  'kube-prometheus-stack': 'prometheus',
  'loki-stack': 'loki',
  victoriametrics: 'victoria-metrics',
  'victoria-metrics-k8s-stack': 'victoria-metrics',
  otel: 'opentelemetry',
  'opentelemetry-collector': 'opentelemetry',
  'grafana-alloy': 'alloy',
  'grafana-oncall': 'oncall',
  'grafana-tempo': 'tempo',
  'grafana-mimir': 'mimir',
  'grafana-pyroscope': 'pyroscope',
  'grafana-faro': 'faro',
  'grafana-beyla': 'beyla',
  'fluentbit': 'fluent-bit',
  // Kubernetes SIGs without their own mark use the Kubernetes logo.
  'metrics-server': 'kubernetes',
  k8s: 'kubernetes',
  // Data
  cnpg: 'cloudnative-pg',
  cloudnativepg: 'cloudnative-pg',
  postgresql: 'cloudnative-pg',
  'kafka-operator': 'strimzi',
  kafka: 'strimzi',
  kafkaui: 'kafka-ui',
  'valkey-admin': 'valkey',
  redis: 'redis-operator',
  'mariadb-operator': 'mariadb',
  'mysql-operator': 'mysql',
  'mongodb-operator': 'mongodb',
  'mongodb-kubernetes-operator': 'mongodb',
  openmetadata: 'open-metadata',
  libredb: 'libredb-studio',
  jupyter: 'jupyterhub',
  'kubeflow-spark-operator': 'spark-operator',
  spark: 'spark-operator',
  // AI
  'llm-d-cpu': 'llm-d',
  'llm-d-gpu': 'llm-d',
  'vllm-cpu': 'vllm',
  'vllm-gpu': 'vllm',
  'gpu-operator': 'nvidia',
  // Application delivery
  buildpack: 'buildpacks',
  kpack: 'buildpacks',
  'open-function': 'openfunction',
  'chaosmesh': 'chaos-mesh',
  litmuschaos: 'litmus',
  'tekton-pipelines': 'tekton',
  sonatype: 'nexus',
  // Security
  eso: 'external-secrets',
  'external-secrets-operator': 'external-secrets',
  'policy-controller': 'cosign',
  sigstore: 'cosign',
  'trivy-operator': 'trivy',
  'policy-reporter': 'kyverno',
  'kyverno-policies': 'kyverno',
  // Infrastructure — the `terraform` package runs Flux's tofu-controller.
  terraform: 'opentofu',
  'tofu-controller': 'opentofu',
  tofu: 'opentofu',
  kata: 'kata-containers',
  externaldns: 'external-dns',
}

/** Sentinel key for Adhar-built packages (rendered with `AdharSymbol`). */
export const ADHAR_LOGO_KEY = 'adhar'

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** True for Adhar-built packages (`adhar-*`, `adhar`). */
export function isAdharPackage(name: string): boolean {
  const n = normalise(name)
  return n === 'adhar' || n.startsWith('adhar-')
}

/**
 * Resolve an app / package / tool name (as an ApplicationSet, the tool
 * registry or a chart names it) to a logo key: a `TOOL_LOGOS` key,
 * `ADHAR_LOGO_KEY` for Adhar-built packages, or `undefined` when no official
 * artwork is bundled (callers fall back to initials).
 */
export function toolLogoKey(name: string | undefined | null): string | undefined {
  if (!name) return undefined
  if (isAdharPackage(name)) return ADHAR_LOGO_KEY
  const n = normalise(name)
  if (!n) return undefined
  if (TOOL_LOGOS[n]) return n
  if (TOOL_LOGO_ALIASES[n]) return TOOL_LOGO_ALIASES[n]
  // Common packaging suffixes: "<tool>-operator", "<tool>-stack", "<tool>-cpu"…
  const stripped = n.replace(/-(operator|stack|chart|helm|server|controller|cpu|gpu)$/, '')
  if (stripped !== n) {
    if (TOOL_LOGOS[stripped]) return stripped
    if (TOOL_LOGO_ALIASES[stripped]) return TOOL_LOGO_ALIASES[stripped]
  }
  // Separator-insensitive match ("victoriametrics", "open_metadata").
  const flat = n.replace(/-/g, '')
  for (const key of Object.keys(TOOL_LOGOS)) {
    if (key.replace(/-/g, '') === flat) return key
  }
  return undefined
}

/** Manifest entry for a resolved key (undefined for the Adhar sentinel). */
export function toolLogoMeta(key: string | undefined): ToolLogoMeta | undefined {
  return key ? TOOL_LOGOS[key] : undefined
}
