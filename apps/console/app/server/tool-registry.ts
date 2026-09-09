import { env } from '@adhar-console/utils'
import { controlPlaneUrl, subdomainUrl, toolUrl } from './domain.ts'

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
 *   - `basic`   → HTTP Basic auth from durable admin creds
 *                 (`<TOOL>_USERNAME`/`<TOOL>_PASSWORD`). Preferred over a
 *                 rotating PAT for tools whose API accepts Basic (e.g. Gitea)
 *                 so a token rotation can't break the tile.
 *   - `login`   → the BFF mints and caches a short-lived session token from
 *                 durable admin creds (`<TOOL>_USERNAME`/`<TOOL>_PASSWORD`) via
 *                 the tool's `POST /api/v1/session` endpoint, sends it as a
 *                 Bearer, and re-mints on demand (expiry or an upstream
 *                 401/403). Used for ArgoCD, whose session tokens expire.
 *   - `none`    → no auth header (e.g. anonymous Grafana embeds).
 *
 * A tool with no configured `baseUrl` is considered NOT configured; the proxy
 * returns 503 and the module's data layer falls back to stub fixtures so the
 * UI still renders.
 */
export type AuthMode = 'user' | 'service' | 'basic' | 'login' | 'none'

export interface ToolDef {
  /** Upstream base URL (no trailing slash). Empty string ⇒ not configured. */
  baseUrl: string
  authMode: AuthMode
  /** Service token (only read when authMode === 'service'). */
  serviceToken?: string
  /** Admin username (read when authMode === 'basic' | 'login'). */
  username?: string
  /** Admin password (read when authMode === 'basic' | 'login'). Never surfaced publicly. */
  password?: string
  /** Extra static headers to send upstream. */
  headers?: Record<string, string>
  /** Strip this prefix from the proxied path before forwarding. */
  stripPrefix?: string
  /**
   * How `login` mode mints its session token. Defaults to the ArgoCD shape
   * (`POST /api/v1/session` `{username,password}` → `{token}`); tools with a
   * different login endpoint (Coder: `/api/v2/users/login` `{email,password}`
   * → `{session_token}`) override it here.
   */
  login?: {
    path: string
    body(username: string, password: string): unknown
    tokenField: string
  }
}

function clean(url: string | undefined): string {
  return (url ?? '').replace(/\/$/, '')
}

/** `X-Scope-OrgID` for multi-tenant LGTM gateways; undefined when single-tenant. */
function tenantHeader(tenant: string | undefined): Record<string, string> | undefined {
  return tenant ? { 'X-Scope-OrgID': tenant } : undefined
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
 * The console's own Kubernetes service-account bearer token — used for
 * *privileged* platform operations the signed-in user may not be able to do
 * themselves (e.g. provisioning a tenant namespace + RBAC during onboarding).
 * Returns undefined when running outside a cluster with no `K8S_SA_TOKEN`.
 */
export function getK8sServiceToken(): string | undefined {
  return readK8sToken()
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
      baseUrl: clean(controlPlaneUrl()),
      authMode: 'service',
      serviceToken: env('K8S_SA_TOKEN'),
    },
    // Gitea's API accepts HTTP Basic. Prefer durable admin creds
    // (`GITEA_USERNAME`/`GITEA_PASSWORD`) in `basic` mode so a rotated PAT can't
    // break the tile; fall back to the `service`/`GITEA_TOKEN` path when only a
    // token is present. `GITEA_AUTH_MODE` still overrides.
    gitea: {
      baseUrl: toolUrl('gitea', 'GITEA_URL'),
      authMode: (env('GITEA_AUTH_MODE') as AuthMode) ??
        (env('GITEA_USERNAME') && env('GITEA_PASSWORD') ? 'basic' : 'service'),
      serviceToken: env('GITEA_TOKEN'),
      username: env('GITEA_USERNAME'),
      password: env('GITEA_PASSWORD'),
    },
    plane: {
      baseUrl: toolUrl('plane', 'PLANE_URL'),
      authMode: 'service',
      serviceToken: env('PLANE_TOKEN'),
      headers: env('PLANE_TOKEN') ? { 'x-api-key': env('PLANE_TOKEN')! } : undefined,
    },
    // ArgoCD session tokens expire (~24h). Prefer durable admin creds
    // (`ARGOCD_USERNAME`/`ARGOCD_PASSWORD`) in `login` mode so the BFF mints and
    // caches a session token (and re-mints on expiry / 401); fall back to the
    // `service`/`ARGOCD_TOKEN` path when only a token is present.
    // `ARGOCD_AUTH_MODE` still overrides.
    argocd: {
      baseUrl: toolUrl('argocd', 'ARGOCD_URL', 'ARGO_CD_URL'),
      authMode: (env('ARGOCD_AUTH_MODE') as AuthMode) ??
        (env('ARGOCD_USERNAME') && env('ARGOCD_PASSWORD') ? 'login' : 'service'),
      serviceToken: env('ARGOCD_TOKEN'),
      username: env('ARGOCD_USERNAME'),
      password: env('ARGOCD_PASSWORD'),
    },
    kargo: {
      baseUrl: toolUrl('kargo', 'KARGO_URL'),
      authMode: (env('KARGO_AUTH_MODE') as AuthMode) ?? 'user',
      serviceToken: env('KARGO_TOKEN'),
    },
    // Harbor's API accepts HTTP Basic (robot or admin creds); a bare token is
    // also accepted. Without either, only public projects list.
    harbor: {
      baseUrl: toolUrl('harbor', 'HARBOR_URL'),
      authMode: env('HARBOR_USERNAME') && env('HARBOR_PASSWORD') ? 'basic' : 'service',
      serviceToken: env('HARBOR_TOKEN'),
      username: env('HARBOR_USERNAME'),
      password: env('HARBOR_PASSWORD'),
    },
    'argo-workflows': {
      baseUrl: toolUrl('argo-workflows', 'ARGO_WORKFLOWS_URL'),
      authMode: 'service',
      serviceToken: env('ARGO_WORKFLOWS_TOKEN'),
    },
    'argo-rollouts': {
      baseUrl: toolUrl('argo-rollouts', 'ARGO_ROLLOUTS_URL'),
      authMode: 'service',
      serviceToken: env('ARGO_ROLLOUTS_TOKEN'),
    },
    // Grafana: a service token when provided, else durable admin creds
    // (`GRAFANA_USERNAME`/`GRAFANA_PASSWORD` — the chart's admin secret) as
    // HTTP Basic, so dashboards list even before an API token is minted.
    grafana: {
      baseUrl: toolUrl('grafana', 'GRAFANA_URL'),
      authMode: env('GRAFANA_TOKEN') ? 'service' : env('GRAFANA_PASSWORD') ? 'basic' : 'none',
      serviceToken: env('GRAFANA_TOKEN'),
      username: env('GRAFANA_USERNAME') ?? 'admin',
      password: env('GRAFANA_PASSWORD'),
    },
    metabase: {
      baseUrl: toolUrl('metabase', 'METABASE_URL'),
      authMode: 'service',
      serviceToken: env('METABASE_TOKEN'),
    },
    // OpenCost / Kubecost allocation API (Decide → cost/spend). The OpenCost
    // REST API needs no auth by default; run `service` mode so an optional
    // `OPENCOST_TOKEN` is forwarded when fronted by an authenticating proxy.
    // In-cluster this is usually the opencost svc, e.g.
    // http://opencost.opencost.svc:9003 (its API port).
    opencost: {
      baseUrl: toolUrl('opencost', 'OPENCOST_URL'),
      authMode: 'service',
      serviceToken: env('OPENCOST_TOKEN'),
    },
    airbyte: {
      baseUrl: toolUrl('airbyte', 'AIRBYTE_URL'),
      authMode: 'service',
      serviceToken: env('AIRBYTE_TOKEN'),
    },
    // LGTM (Discover): Grafana fronts Loki/Mimir/Tempo via its datasource proxy.
    lgtm: {
      baseUrl: toolUrl('grafana', 'GRAFANA_URL'),
      authMode: env('GRAFANA_TOKEN') ? 'service' : env('GRAFANA_PASSWORD') ? 'basic' : 'none',
      serviceToken: env('GRAFANA_TOKEN'),
      username: env('GRAFANA_USERNAME') ?? 'admin',
      password: env('GRAFANA_PASSWORD'),
    },
    posthog: {
      baseUrl: toolUrl('posthog', 'POSTHOG_URL'),
      authMode: 'service',
      serviceToken: env('POSTHOG_TOKEN'),
    },
    // Coder only accepts its own session tokens / API keys — a Keycloak access
    // token is rejected with 401 — so `user` mode can never work. Prefer a
    // long-lived API key (`CODER_TOKEN`), else sign in with the bootstrap
    // owner (`CODER_USERNAME`/`CODER_PASSWORD`, the `coder-credentials` Secret)
    // and cache the session token. `CODER_AUTH_MODE` still overrides.
    coder: {
      baseUrl: toolUrl('coder', 'CODER_URL'),
      authMode: (env('CODER_AUTH_MODE') as AuthMode) ??
        (env('CODER_TOKEN') ? 'service' : env('CODER_USERNAME') && env('CODER_PASSWORD') ? 'login' : 'user'),
      serviceToken: env('CODER_TOKEN'),
      username: env('CODER_USERNAME'),
      password: env('CODER_PASSWORD'),
      login: {
        path: '/api/v2/users/login',
        body: (email, password) => ({ email, password }),
        tokenField: 'session_token',
      },
    },
    trivy: {
      baseUrl: toolUrl('trivy', 'TRIVY_URL', 'HARBOR_URL'),
      authMode: 'service',
      serviceToken: env('TRIVY_TOKEN') ?? env('HARBOR_TOKEN'),
    },
    falco: {
      baseUrl: toolUrl('falco', 'FALCO_URL'),
      authMode: 'service',
      serviceToken: env('FALCO_TOKEN'),
    },
    // Kyverno + Crossplane are surfaced as CRDs through the kube-apiserver, so
    // their data flows through the `k8s` tool. These entries exist only so the
    // proxy returns a clear "not configured" rather than "unknown tool" if a
    // caller ever addresses them directly.
    kyverno: { baseUrl: toolUrl('kyverno', 'KYVERNO_URL'), authMode: 'service', serviceToken: env('KYVERNO_TOKEN') },
    crossplane: { baseUrl: toolUrl('crossplane', 'CROSSPLANE_URL'), authMode: 'service', serviceToken: env('CROSSPLANE_TOKEN') },
    // ── Launcher-discoverable tools ──────────────────────────────────────────
    // The entries below primarily back the app launcher's dynamic discovery:
    // `/api/config` (via publicToolInfo) reports configured + external URL so
    // the client can render a real link — or an honest "not set up" tile —
    // per environment. Addressing one through the proxy returns a clear
    // "not configured" 503 instead of "unknown tool".
    keycloak: { baseUrl: toolUrl('keycloak', 'KEYCLOAK_URL'), authMode: 'none' },
    // Hubble UI (Cilium network flows) + Kafka UI — browser UIs surfaced in the
    // app launcher. Configured when their <TOOL>_URL is set on the deployment.
    hubble: { baseUrl: toolUrl('hubble', 'HUBBLE_URL'), authMode: 'none' },
    'kafka-ui': { baseUrl: toolUrl('kafka-ui', 'KAFKA_UI_URL'), authMode: 'none' },
    jupyterhub: { baseUrl: toolUrl('jupyterhub', 'JUPYTERHUB_URL'), authMode: 'none' },
    // Browser UIs the platform deploys (set on the console Deployment) that had
    // no registry entry, so the app launcher could never discover them even
    // though they were running. `none` auth — they front their own login.
    tooljet: { baseUrl: toolUrl('tooljet', 'TOOLJET_URL'), authMode: 'none' },
    penpot: { baseUrl: toolUrl('penpot', 'PENPOT_URL'), authMode: 'none' },
    opensearch: { baseUrl: toolUrl('opensearch', 'OPENSEARCH_URL'), authMode: 'none' },
    vault: { baseUrl: toolUrl('vault', 'VAULT_URL'), authMode: 'service', serviceToken: env('VAULT_TOKEN') },
    tekton: { baseUrl: toolUrl('tekton', 'TEKTON_URL'), authMode: 'service', serviceToken: env('TEKTON_TOKEN') },
    // RustFS is the platform's S3-compatible store; MINIO_URL kept as the
    // conventional var name with RUSTFS_URL as an alias.
    minio: {
      baseUrl: toolUrl('minio', 'MINIO_URL', 'RUSTFS_URL'),
      authMode: 'service',
      serviceToken: env('MINIO_TOKEN') ?? env('RUSTFS_TOKEN'),
    },
    iceberg: { baseUrl: toolUrl('iceberg', 'ICEBERG_URL'), authMode: 'service', serviceToken: env('ICEBERG_TOKEN') },
    otel: { baseUrl: toolUrl('otel', 'OTEL_URL'), authMode: 'none' },
    // Raw LGTM endpoints (see .env.example). UI deep-links go through Grafana
    // Explore; these report the API hosts so availability is env-accurate.
    // Loki / Mimir / Tempo run multi-tenant behind their gateways and reject
    // requests without `X-Scope-OrgID`; `<TOOL>_TENANT` (default `anonymous`
    // for Mimir, unset = single-tenant for Loki/Tempo) sets it.
    loki: {
      baseUrl: toolUrl('loki', 'LOKI_URL'),
      authMode: 'service',
      serviceToken: env('LOKI_TOKEN'),
      headers: tenantHeader(env('LOKI_TENANT')),
    },
    mimir: {
      baseUrl: toolUrl('mimir', 'MIMIR_URL'),
      authMode: 'service',
      serviceToken: env('MIMIR_TOKEN'),
      headers: tenantHeader(env('MIMIR_TENANT') ?? 'anonymous'),
    },
    tempo: {
      baseUrl: toolUrl('tempo', 'TEMPO_URL'),
      authMode: 'service',
      serviceToken: env('TEMPO_TOKEN'),
      headers: tenantHeader(env('TEMPO_TENANT')),
    },
    // Prometheus-compatible query API. Falls back to Mimir's gateway, whose
    // Prometheus API is mounted under `/prometheus` and needs the tenant header.
    prometheus: env('PROMETHEUS_URL')
      ? { baseUrl: clean(env('PROMETHEUS_URL')), authMode: 'service', serviceToken: env('PROMETHEUS_TOKEN') }
      : {
          baseUrl: env('MIMIR_URL') ? `${toolUrl('mimir', 'MIMIR_URL')}/prometheus` : '',
          authMode: 'service',
          serviceToken: env('PROMETHEUS_TOKEN') ?? env('MIMIR_TOKEN'),
          headers: tenantHeader(env('MIMIR_TENANT') ?? 'anonymous'),
        },
  }
}

export function getTool(name: string): ToolDef | undefined {
  return getToolRegistry()[name]
}

/**
 * True for a URL that is only reachable from inside the cluster (a Service DNS
 * name or localhost). In production each tool's `<TOOL>_URL` is set to its
 * in-cluster Service so the server-side proxy can reach it despite split-horizon
 * DNS — but such a URL is NOT browser-linkable, so we hide it from the launcher
 * and let the client derive the public URL from the cluster's base domain.
 */
function isInClusterUrl(url: string): boolean {
  return /(^https?:\/\/)?([^/]*\.svc(\.cluster\.local)?|localhost|127\.0\.0\.1|[^/]*\.local)(:\d+)?(\/|$)/i.test(
    url,
  )
}

/** Public-safe view (no tokens) — which tools are wired + their browser URLs. */
export function publicToolInfo(): Record<string, { configured: boolean; url: string }> {
  const reg = getToolRegistry()
  const out: Record<string, { configured: boolean; url: string }> = {}
  for (const [name, def] of Object.entries(reg)) {
    // Report the URL only when it's a public, browser-openable address. The
    // k8s apiserver and any in-cluster Service URL are hidden (empty) — the
    // launcher still shows the tool as configured and derives the public link
    // from the cluster base domain.
    const external = name === 'k8s' || isInClusterUrl(def.baseUrl) ? '' : def.baseUrl
    out[name] = { configured: Boolean(def.baseUrl), url: external }
  }
  return out
}
