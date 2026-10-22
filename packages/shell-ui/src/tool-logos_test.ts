import { assert, assertEquals } from 'jsr:@std/assert@1'
import { ADHAR_LOGO_KEY, isAdharPackage, TOOL_LOGO_ALIASES, TOOL_LOGOS, toolLogoKey } from './tool-logos.ts'

const LOGO_DIR = new URL('./logos/', import.meta.url)

Deno.test('every manifest entry has its bundled file, and every file is in the manifest', () => {
  const files = new Set([...Deno.readDirSync(LOGO_DIR)].map((e) => e.name).filter((n) => /\.(svg|png)$/.test(n)))
  for (const [key, meta] of Object.entries(TOOL_LOGOS)) {
    assert(files.has(`${key}.${meta.ext}`), `missing logos/${key}.${meta.ext}`)
  }
  for (const f of files) {
    const [stem, ext] = f.split('.')
    assertEquals(TOOL_LOGOS[stem]?.ext, ext, `logos/${f} is not in TOOL_LOGOS`)
  }
})

Deno.test('every alias points at a bundled logo', () => {
  for (const [alias, key] of Object.entries(TOOL_LOGO_ALIASES)) {
    assert(TOOL_LOGOS[key], `alias ${alias} → ${key} has no logo`)
  }
})

Deno.test('bundled SVGs are sanitised and small', () => {
  for (const [key, meta] of Object.entries(TOOL_LOGOS)) {
    if (meta.ext !== 'svg') continue
    const svg = Deno.readTextFileSync(new URL(`${key}.svg`, LOGO_DIR))
    assert(svg.length < 40_000, `${key}.svg is ${svg.length} bytes`)
    assert(/viewBox=/.test(svg), `${key}.svg has no viewBox`)
    for (const bad of [/<script/i, /<foreignObject/i, /<image/i, /<!ENTITY/i, /<!DOCTYPE/i, /@import/i, /\son[a-z]+\s*=/i, /href\s*=\s*["'](?!#)/i, /javascript:/i]) {
      assert(!bad.test(svg), `${key}.svg contains ${bad}`)
    }
  }
})

Deno.test('Adhar-built packages resolve to the Adhar symbol', () => {
  for (
    const name of [
      'adhar-ai',
      'adhar-console',
      'adhar-cost-governance',
      'adhar-credential-rotation',
      'adhar-kyverno-policies',
      'adhar-libraries',
      'adhar-local-budget',
      'adhar-policy-packs',
      'adhar-policy-reporter',
      'adhar-preview-environments',
      'adhar-preview-environments-kyverno',
      'adhar-scorecards',
      'adhar-supply-chain',
      'adhar-supply-chain-kyverno',
      'adhar-supply-chain-policies',
      'adhar-supply-chain-policies-enforce',
      'adhar-templates',
      'adhar-tenant-quotas',
      'Adhar',
    ]
  ) {
    assertEquals(toolLogoKey(name), ADHAR_LOGO_KEY, name)
    assert(isAdharPackage(name))
  }
  assert(!isAdharPackage('adharsh-tool'))
})

Deno.test('every ApplicationSet package name resolves to a logo', () => {
  // The platform repo's package names (platform/stack/adhar-appset-*.yaml).
  const names = [
    'agentgateway', 'airbyte', 'alloy', 'argo-events', 'argo-rollout', 'argo-workflows', 'baserow', 'beyla',
    'buildpack', 'cert-manager', 'chaos-mesh', 'cnpg', 'coder', 'cosign', 'crossplane', 'dagster', 'dapr',
    'external-dns', 'external-secrets', 'falco', 'faro', 'fluent-bit', 'gpu-operator', 'harbor', 'headlamp',
    'hubble', 'jupyterhub', 'k6', 'k8sgpt', 'kafka-operator', 'kafka-ui', 'kamaji', 'kargo', 'karmada',
    'kata-containers', 'keda', 'keycloak', 'knative', 'kube-prometheus', 'kubeflow', 'kubescape', 'kyverno',
    'libredb-studio', 'litmus', 'llm-d', 'llm-d-cpu', 'llm-d-gpu', 'loki', 'loki-stack', 'mariadb-operator',
    'metabase', 'metrics-server', 'mimir', 'minio', 'mlflow', 'mongodb', 'mysql-operator', 'n8n', 'neo4j',
    'nexus', 'oncall', 'open-function', 'open-metadata', 'openbao', 'opencost', 'opensearch', 'penpot', 'pixie',
    'plane', 'posthog', 'prefect', 'pyroscope', 'rabbitmq', 'redis', 'rustfs', 'spark-operator', 'strapi',
    'tekton', 'tempo', 'terraform', 'tetragon', 'tldraw', 'tolgee', 'tooljet', 'trino', 'trivy', 'valkey',
    'valkey-admin', 'vault', 'vcluster', 'velero', 'victoria-metrics', 'vllm', 'vllm-cpu', 'vllm-gpu',
    'webstudio', 'dbt',
  ]
  for (const n of names) {
    const key = toolLogoKey(n)
    assert(key && TOOL_LOGOS[key], `${n} → ${key}`)
  }
})

Deno.test('aliases and normalisation', () => {
  assertEquals(toolLogoKey('argocd'), 'argo')
  assertEquals(toolLogoKey('argo-rollout'), 'argo')
  assertEquals(toolLogoKey('kube-prometheus'), 'prometheus')
  assertEquals(toolLogoKey('kube-prometheus-stack'), 'prometheus')
  assertEquals(toolLogoKey('loki-stack'), 'loki')
  assertEquals(toolLogoKey('valkey-admin'), 'valkey')
  assertEquals(toolLogoKey('kafka-ui'), 'kafka-ui')
  assertEquals(toolLogoKey('kafka-operator'), 'strimzi')
  assertEquals(toolLogoKey('cnpg'), 'cloudnative-pg')
  assertEquals(toolLogoKey('openbao'), 'openbao')
  assertEquals(toolLogoKey('rustfs'), 'rustfs')
  assertEquals(toolLogoKey('VictoriaMetrics'), 'victoria-metrics')
  assertEquals(toolLogoKey('Victoria_Metrics'), 'victoria-metrics')
  assertEquals(toolLogoKey('OpenMetadata'), 'open-metadata')
  assertEquals(toolLogoKey('vllm-gpu'), 'vllm')
  assertEquals(toolLogoKey('gpu-operator'), 'nvidia')
  assertEquals(toolLogoKey('terraform'), 'opentofu')
  assertEquals(toolLogoKey('metrics-server'), 'kubernetes')
  assertEquals(toolLogoKey('policy-reporter'), 'kyverno')
  assertEquals(toolLogoKey('  Grafana '), 'grafana')
  assertEquals(toolLogoKey('cert-manager-operator'), 'cert-manager')
})

Deno.test('unknown names resolve to undefined (callers fall back to initials)', () => {
  assertEquals(toolLogoKey('my-team-service'), undefined)
  assertEquals(toolLogoKey(''), undefined)
  assertEquals(toolLogoKey(undefined), undefined)
  assertEquals(toolLogoKey('---'), undefined)
})
