/**
 * The mapping shared by `dev:env` and `dev:tunnel`.
 *
 * Both need to agree, exactly, on which tools are tunnelled and on which local
 * port each one gets. If they disagree the console points at a port nothing is
 * listening on and every panel for that tool fails with a connection error that
 * names neither script. So the mapping is computed here, once, from the live
 * Deployment — never written down twice.
 *
 * ---------------------------------------------------------------------------
 * WHY TUNNEL AT ALL
 * ---------------------------------------------------------------------------
 * Most tools are reachable on the public ingress (`https://<tool>.<domain>`)
 * and need no tunnel. But several sit behind an oauth2-proxy that redirects to
 * Keycloak — measured on a live cluster: prometheus, argocd and metabase all
 * answer 302 to `keycloak.<domain>/realms/...`. A server-to-server call cannot
 * complete an interactive SSO flow, so for those the only usable address is the
 * in-cluster Service, which is exactly what the console uses in production.
 *
 * `kubectl port-forward` gives us that address from a laptop, using the
 * kubeconfig that is already set.
 */

export interface Tunnel {
  /** The console env var this fills, e.g. `PROMETHEUS_URL`. */
  varName: string
  namespace: string
  service: string
  /** Port on the Service. */
  remotePort: number
  /**
   * Path suffix from the original URL, kept verbatim.
   *
   * `AI_BASE_URL` is `http://adhar-ai-gateway…:8080/v1` — dropping the `/v1`
   * silently points the AI provider at the gateway root, which 404s every
   * completion. Most tools have no path and this is ''.
   */
  path: string
  /** Deterministic local port — see `assignPorts`. */
  localPort: number
}

/** Where the tunnelled ports start. Above the dev servers (5099–5117). */
export const PORT_BASE = 5200

/** `http://gitea-http.adhar-system.svc.cluster.local:3000` → parts, or null. */
export function parseClusterService(
  url: string,
): { namespace: string; service: string; port: number; path: string } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const m = u.hostname.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.svc(?:\.cluster\.local)?$/i)
  if (!m) return null
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
  if (!Number.isFinite(port)) return null
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
  return { service: m[1], namespace: m[2], port, path }
}

/**
 * Read the console Deployment's env and return the tools that must be
 * tunnelled.
 *
 * Driven by the Deployment rather than a hardcoded list so that a tool added
 * to the platform is picked up without touching these scripts.
 *
 * `only` narrows it to the tools that actually need a tunnel; everything else
 * resolves over the public ingress and is left alone.
 */
export function tunnelsFromEnv(
  env: Array<{ name: string; value?: string }>,
  only: ReadonlySet<string>,
): Tunnel[] {
  const found: Array<Omit<Tunnel, 'localPort'>> = []
  for (const e of env) {
    if (!e.name.endsWith('_URL') || !e.value) continue
    if (!only.has(e.name)) continue
    const svc = parseClusterService(e.value)
    if (!svc) continue
    found.push({
      varName: e.name,
      namespace: svc.namespace,
      service: svc.service,
      remotePort: svc.port,
      path: svc.path,
    })
  }
  return assignPorts(found)
}

/**
 * Assign local ports deterministically.
 *
 * Sorted by var name, then `PORT_BASE + index`. Deterministic matters: the two
 * scripts run at different times and must land on identical numbers without
 * sharing state. Sorting (rather than using the Deployment's env order) means
 * the numbers are also stable across a Deployment edit that merely reorders
 * variables.
 */
export function assignPorts(tools: Array<Omit<Tunnel, 'localPort'>>): Tunnel[] {
  return [...tools]
    .sort((a, b) => a.varName.localeCompare(b.varName))
    .map((t, i) => ({ ...t, localPort: PORT_BASE + i }))
}

/**
 * Tools whose public route is SSO-gated, so a tunnel is the only way in.
 *
 * Determined by probing the live ingress: these answered 302 to Keycloak,
 * while gitea, grafana and harbor answered 200 and need no tunnel. Listed
 * explicitly rather than probed at startup so `dev:env` and `dev:tunnel` agree
 * without either having to make network calls first.
 */
export const SSO_GATED = new Set([
  'PROMETHEUS_URL',
  'ARGOCD_URL',
  'ARGO_CD_URL',
  'METABASE_URL',
  'LOKI_URL',
  'MIMIR_URL',
  'TEMPO_URL',
  'ARGO_WORKFLOWS_URL',
  'ARGO_ROLLOUTS_URL',
  'KARGO_URL',
  'OPENCOST_URL',
  'VAULT_URL',
  'TEKTON_URL',
  'NEXUS_URL',
  'KAFKA_UI_URL',
  'AIRBYTE_URL',
  'CODER_URL',
  'JUPYTERHUB_URL',
  'OPENSEARCH_URL',
  'MINIO_URL',
  'HUBBLE_URL',
  'PENPOT_URL',
  'ADHAR_AI_URL',
  'AI_BASE_URL',
])

/** `kubectl get deploy <name> -n <ns> -o json` → its first container's env. */
export function containerEnv(deployJson: string): Array<{ name: string; value?: string }> {
  try {
    const d = JSON.parse(deployJson)
    return d?.spec?.template?.spec?.containers?.[0]?.env ?? []
  } catch {
    return []
  }
}
