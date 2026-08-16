import { env } from '@adhar-console/utils'

/**
 * Backing-tool registry — the single source of truth for how the BFF reaches
 * each upstream tool and how it authenticates.
 *
 * Auth modes (see docs/architecture/auth.md):
 *   - `user`    → forward the signed-in user's Keycloak access token
 *                 (Bearer). The tool is an OIDC client in the same realm and
 *                 applies its own RBAC. Preferred.
 *   - `service` → use a service/robot token held by the console
 *                 (`<TOOL>_TOKEN` env). The console acts on the user's behalf;
 *                 the audit actor is still the user.
 *   - `none`    → no auth header (e.g. anonymous Grafana embeds).
 *
 * A tool with no configured `baseUrl` is considered NOT configured; the proxy
 * returns 503 and the module's data layer falls back to stub fixtures so the
 * UI still renders.
 */
export type AuthMode = 'user' | 'service' | 'none'

export interface ToolDef {
  /** Upstream base URL (no trailing slash). Empty string ⇒ not configured. */
  baseUrl: string
  authMode: AuthMode
  /** Service token (only read when authMode === 'service'). */
  serviceToken?: string
  /** Extra static headers to send upstream. */
  headers?: Record<string, string>
  /** Strip this prefix from the proxied path before forwarding. */
  stripPrefix?: string
}

function clean(url: string | undefined): string {
  return (url ?? '').replace(/\/$/, '')
}

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

/**
 * Resolve the Kubernetes service-account bearer token. Prefers an explicit
 * `K8S_SA_TOKEN` env (out-of-cluster / impersonation setups); otherwise reads
 * the projected in-cluster SA token file. Returns undefined when neither is
 * available (e.g. running outside a cluster with no override).
 */
function readK8sToken(): string | undefined {
  const fromEnv = env('K8S_SA_TOKEN')
  if (fromEnv) return fromEnv
  try {
    const d = (globalThis as { Deno?: { readTextFileSync(p: string): string } }).Deno
    if (d) return d.readTextFileSync(SA_TOKEN_PATH).trim()
  } catch {
    /* not in-cluster */
  }
  return undefined
}

/**
 * Build the registry from the runtime environment. Recomputed per call so a
 * Secret/ConfigMap change picked up by a pod restart takes effect without a
 * rebuild. The keys here are the `tool` path segment in `/api/svc/<tool>/…`.
 */
export function getToolRegistry(): Record<string, ToolDef> {
  return {
    // Kubernetes API. In-cluster the apiserver is reachable at the well-known
    // service host; the console SA token authorizes the call (service mode).
    // `K8S_API_URL` overrides for out-of-cluster / multi-cluster setups.
    k8s: {
      baseUrl: clean(env('K8S_API_URL') ?? 'https://kubernetes.default.svc'),
      authMode: 'service',
      serviceToken: env('K8S_SA_TOKEN'),
    },
    gitea: {
      baseUrl: clean(env('GITEA_URL')),
      authMode: (env('GITEA_AUTH_MODE') as AuthMode) ?? 'service',
      serviceToken: env('GITEA_TOKEN'),
    },
    plane: {
      baseUrl: clean(env('PLANE_URL')),
      authMode: 'service',
      serviceToken: env('PLANE_TOKEN'),
      headers: env('PLANE_TOKEN') ? { 'x-api-key': env('PLANE_TOKEN')! } : undefined,
    },
    argocd: {
      baseUrl: clean(env('ARGOCD_URL')),
      authMode: (env('ARGOCD_AUTH_MODE') as AuthMode) ?? 'service',
      serviceToken: env('ARGOCD_TOKEN'),
    },
    kargo: {
      baseUrl: clean(env('KARGO_URL')),
      authMode: (env('KARGO_AUTH_MODE') as AuthMode) ?? 'user',
      serviceToken: env('KARGO_TOKEN'),
    },
    harbor: {
      baseUrl: clean(env('HARBOR_URL')),
      authMode: 'service',
      serviceToken: env('HARBOR_TOKEN'),
    },
    'argo-workflows': {
      baseUrl: clean(env('ARGO_WORKFLOWS_URL')),
      authMode: 'service',
      serviceToken: env('ARGO_WORKFLOWS_TOKEN'),
    },
    'argo-rollouts': {
      baseUrl: clean(env('ARGO_ROLLOUTS_URL')),
      authMode: 'service',
      serviceToken: env('ARGO_ROLLOUTS_TOKEN'),
    },
    grafana: {
      baseUrl: clean(env('GRAFANA_URL')),
      authMode: 'service',
      serviceToken: env('GRAFANA_TOKEN'),
    },
    metabase: {
      baseUrl: clean(env('METABASE_URL')),
      authMode: 'service',
      serviceToken: env('METABASE_TOKEN'),
    },
    // OpenCost / Kubecost allocation API (Decide → cost/spend). The OpenCost
    // REST API needs no auth by default; run `service` mode so an optional
    // `OPENCOST_TOKEN` is forwarded when fronted by an authenticating proxy.
    // In-cluster this is usually the opencost svc, e.g.
    // http://opencost.opencost.svc:9003 (its API port).
    opencost: {
      baseUrl: clean(env('OPENCOST_URL')),
      authMode: 'service',
      serviceToken: env('OPENCOST_TOKEN'),
    },
    airbyte: {
      baseUrl: clean(env('AIRBYTE_URL')),
      authMode: 'service',
      serviceToken: env('AIRBYTE_TOKEN'),
    },
    // LGTM (Discover): Grafana fronts Loki/Mimir/Tempo via its datasource proxy.
    lgtm: {
      baseUrl: clean(env('GRAFANA_URL')),
      authMode: 'service',
      serviceToken: env('GRAFANA_TOKEN'),
    },
    posthog: {
      baseUrl: clean(env('POSTHOG_URL')),
      authMode: 'service',
      serviceToken: env('POSTHOG_TOKEN'),
    },
    coder: {
      baseUrl: clean(env('CODER_URL')),
      authMode: (env('CODER_AUTH_MODE') as AuthMode) ?? 'user',
      serviceToken: env('CODER_TOKEN'),
    },
    trivy: {
      baseUrl: clean(env('TRIVY_URL') ?? env('HARBOR_URL')),
      authMode: 'service',
      serviceToken: env('TRIVY_TOKEN') ?? env('HARBOR_TOKEN'),
    },
    falco: {
      baseUrl: clean(env('FALCO_URL')),
      authMode: 'service',
      serviceToken: env('FALCO_TOKEN'),
    },
    // Kyverno + Crossplane are surfaced as CRDs through the kube-apiserver, so
    // their data flows through the `k8s` tool. These entries exist only so the
    // proxy returns a clear "not configured" rather than "unknown tool" if a
    // caller ever addresses them directly.
    kyverno: { baseUrl: clean(env('KYVERNO_URL')), authMode: 'service', serviceToken: env('KYVERNO_TOKEN') },
    crossplane: { baseUrl: clean(env('CROSSPLANE_URL')), authMode: 'service', serviceToken: env('CROSSPLANE_TOKEN') },
    // ── Launcher-discoverable tools ──────────────────────────────────────────
    // The entries below primarily back the app launcher's dynamic discovery:
    // `/api/config` (via publicToolInfo) reports configured + external URL so
    // the client can render a real link — or an honest "not set up" tile —
    // per environment. Addressing one through the proxy returns a clear
    // "not configured" 503 instead of "unknown tool".
    keycloak: { baseUrl: clean(env('KEYCLOAK_URL')), authMode: 'none' },
    vault: { baseUrl: clean(env('VAULT_URL')), authMode: 'service', serviceToken: env('VAULT_TOKEN') },
    tekton: { baseUrl: clean(env('TEKTON_URL')), authMode: 'service', serviceToken: env('TEKTON_TOKEN') },
    // RustFS is the platform's S3-compatible store; MINIO_URL kept as the
    // conventional var name with RUSTFS_URL as an alias.
    minio: {
      baseUrl: clean(env('MINIO_URL') ?? env('RUSTFS_URL')),
      authMode: 'service',
      serviceToken: env('MINIO_TOKEN') ?? env('RUSTFS_TOKEN'),
    },
    iceberg: { baseUrl: clean(env('ICEBERG_URL')), authMode: 'service', serviceToken: env('ICEBERG_TOKEN') },
    otel: { baseUrl: clean(env('OTEL_URL')), authMode: 'none' },
    // Raw LGTM endpoints (see .env.example). UI deep-links go through Grafana
    // Explore; these report the API hosts so availability is env-accurate.
    loki: { baseUrl: clean(env('LOKI_URL')), authMode: 'service', serviceToken: env('LOKI_TOKEN') },
    mimir: { baseUrl: clean(env('MIMIR_URL')), authMode: 'service', serviceToken: env('MIMIR_TOKEN') },
    tempo: { baseUrl: clean(env('TEMPO_URL')), authMode: 'service', serviceToken: env('TEMPO_TOKEN') },
    prometheus: {
      baseUrl: clean(env('PROMETHEUS_URL') ?? env('MIMIR_URL')),
      authMode: 'service',
      serviceToken: env('PROMETHEUS_TOKEN') ?? env('MIMIR_TOKEN'),
    },
  }
}

export function getTool(name: string): ToolDef | undefined {
  return getToolRegistry()[name]
}

/** Public-safe view (no tokens) — which tools are wired + their external URLs. */
export function publicToolInfo(): Record<string, { configured: boolean; url: string }> {
  const reg = getToolRegistry()
  const out: Record<string, { configured: boolean; url: string }> = {}
  for (const [name, def] of Object.entries(reg)) {
    // Only expose externally-linkable URLs (not the in-cluster k8s host).
    const external = name === 'k8s' ? '' : def.baseUrl
    out[name] = { configured: Boolean(def.baseUrl), url: external }
  }
  return out
}
