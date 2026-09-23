#!/usr/bin/env -S deno run -A
/**
 * Generate the root `.env` that points local dev at the cluster your kubeconfig
 * is already pointing at.
 *
 * `npm run dev` starts the BFF with `--env-file=../../.env`, so everything the
 * console reads comes from that one file. Without it the BFF has no cluster and
 * no tools, which is why a fresh clone shows "Cluster unreachable" and a wall of
 * em-dashes. This writes it from the live cluster instead of asking you to fill
 * in thirty variables by hand.
 *
 *     npm run dev:env      # writes .env from the current kubectl context
 *     npm run dev          # now talks to that cluster
 *
 * ---------------------------------------------------------------------------
 * HOW IT REACHES THINGS
 * ---------------------------------------------------------------------------
 * The apiserver is taken from the kubeconfig, so it is the same endpoint
 * kubectl uses, with the same CA.
 *
 * The TOOLS are not. In-cluster the console addresses every tool by Service DNS
 * (`http://gitea-http.adhar-system.svc.cluster.local:3000`), and none of those
 * resolve from a laptop. So this sets ONE variable — `ADHAR_DOMAIN` — and lets
 * `domain.ts` derive `https://<tool>.<domain>` for all of them, which is what
 * the public ingress actually serves. That is the same one-variable path a real
 * install uses; there is no separate local mode to drift.
 *
 * ---------------------------------------------------------------------------
 * HOW IT AUTHENTICATES
 * ---------------------------------------------------------------------------
 * As the console's own ServiceAccount, with `K8S_AUTH_MODE=service`.
 *
 * In production the console holds an SA token and IMPERSONATES the signed-in
 * user, because the apiserver has no OIDC. Locally there is no Keycloak, so the
 * dev session is a stub with no cluster identity — impersonating it would make
 * every read 403. `service` mode skips the `Impersonate-*` headers and calls as
 * the SA directly (see `apiServerAuthHeaders`), which is the one combination
 * that gives a laptop real cluster data.
 *
 * The consequence is worth stating plainly: LOCAL DEV SEES EVERYTHING THE
 * CONSOLE'S SERVICEACCOUNT CAN SEE. It does not exercise per-user RBAC. Test
 * anything permission-shaped against a real deployment.
 *
 * ---------------------------------------------------------------------------
 * SECRETS
 * ---------------------------------------------------------------------------
 * Tool passwords are copied out of cluster Secrets so the tool-backed panels
 * work. The file is written 0600 and `.env` is gitignored, but it is still
 * real production credentials sitting on your disk — delete it when you are
 * done, and never paste it anywhere.
 *
 * The SA token is short-lived (24h by default); re-run this when reads start
 * returning 401.
 */

import { containerEnv, SSO_GATED, tunnelsFromEnv } from './dev-cluster.ts'

const NS = Deno.env.get('ADHAR_NAMESPACE') ?? 'adhar-system'
const DEPLOY = Deno.env.get('ADHAR_CONSOLE_DEPLOY') ?? 'adhar-console'
const SA = Deno.env.get('ADHAR_CONSOLE_SA') ?? 'console'
const TOKEN_TTL = Deno.env.get('ADHAR_TOKEN_TTL') ?? '24h'

async function sh(cmd: string[]): Promise<string> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: 'piped',
    stderr: 'piped',
  })
  const { code, stdout, stderr } = await p.output()
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr).trim())
  return new TextDecoder().decode(stdout).trim()
}

/** Best-effort: a missing optional Secret must not abort the whole file. */
async function trySh(cmd: string[]): Promise<string | null> {
  try {
    return await sh(cmd)
  } catch {
    return null
  }
}

async function secretKey(name: string, key: string): Promise<string | null> {
  const b64 = await trySh([
    'kubectl',
    'get',
    'secret',
    name,
    '-n',
    NS,
    '-o',
    `jsonpath={.data.${key.replace(/\./g, '\\.')}}`,
  ])
  if (!b64) return null
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    )
  } catch {
    return null
  }
}

/** Every key of a Secret, decoded — for the ones the Deployment uses envFrom on. */
async function secretAll(name: string): Promise<Record<string, string>> {
  const json = await trySh(['kubectl', 'get', 'secret', name, '-n', NS, '-o', 'json'])
  if (!json) return {}
  const out: Record<string, string> = {}
  try {
    const data = (JSON.parse(json).data ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(data)) {
      out[k] = new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))
    }
  } catch {
    /* unreadable — skip */
  }
  return out
}

function fail(msg: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`)
  Deno.exit(1)
}

// ── 1. the cluster the kubeconfig already points at ─────────────────────────
const context = await trySh(['kubectl', 'config', 'current-context'])
if (!context) fail('No current kubectl context. Select a cluster with `kubectl config use-context <name>`.')

const server = await trySh([
  'kubectl',
  'config',
  'view',
  '--minify',
  '-o',
  'jsonpath={.clusters[0].cluster.server}',
])
if (!server) fail(`Context "${context}" has no server URL.`)

console.log(`\x1b[36m▸\x1b[0m context   ${context}`)
console.log(`\x1b[36m▸\x1b[0m apiserver ${server}`)

// ── 2. the console's ServiceAccount token ───────────────────────────────────
const token = await trySh([
  'kubectl',
  'create',
  'token',
  SA,
  '-n',
  NS,
  `--duration=${TOKEN_TTL}`,
])
if (!token) {
  fail(
    `Could not mint a token for ServiceAccount "${SA}" in "${NS}".\n` +
      `  Check the namespace (ADHAR_NAMESPACE) and that your kubeconfig user may create token requests.`,
  )
}
console.log(`\x1b[36m▸\x1b[0m identity  serviceaccount ${NS}/${SA} (token valid ${TOKEN_TTL})`)

// ── 3. the cluster CA, so Deno trusts the apiserver ─────────────────────────
// The kubeconfig either embeds it or points at a file; either way Deno needs a
// path. Without it an https apiserver fails with an opaque certificate error.
const caDir = `${Deno.cwd()}/.dev`
await Deno.mkdir(caDir, { recursive: true })
const caPath = `${caDir}/cluster-ca.crt`
let caWritten = false

const caData = await trySh([
  'kubectl',
  'config',
  'view',
  '--minify',
  '--raw',
  '-o',
  'jsonpath={.clusters[0].cluster.certificate-authority-data}',
])
if (caData) {
  await Deno.writeTextFile(
    caPath,
    new TextDecoder().decode(Uint8Array.from(atob(caData), (c) => c.charCodeAt(0))),
  )
  caWritten = true
} else {
  const caFile = await trySh([
    'kubectl',
    'config',
    'view',
    '--minify',
    '-o',
    'jsonpath={.clusters[0].cluster.certificate-authority}',
  ])
  if (caFile) {
    await Deno.copyFile(caFile, caPath)
    caWritten = true
  }
}
const insecure = await trySh([
  'kubectl',
  'config',
  'view',
  '--minify',
  '-o',
  'jsonpath={.clusters[0].cluster.insecure-skip-tls-verify}',
])
console.log(
  `\x1b[36m▸\x1b[0m CA        ${
    caWritten ? caPath : insecure === 'true' ? 'skipped (kubeconfig sets insecure-skip-tls-verify)' : 'none found'
  }`,
)

// ── 4. the public domain every tool URL derives from ────────────────────────
// Taken from the console's own route, so it is whatever this install actually
// serves rather than a guess.
const consoleHost =
  (await trySh([
    'kubectl',
    'get',
    'httproute',
    'console',
    '-n',
    NS,
    '-o',
    'jsonpath={.spec.hostnames[0]}',
  ])) ??
    (await trySh([
      'kubectl',
      'get',
      'ingress',
      '-n',
      NS,
      '-o',
      'jsonpath={.items[?(@.metadata.name=="console")].spec.rules[0].host}',
    ]))

const domain = Deno.env.get('ADHAR_DOMAIN') ??
  (consoleHost ? consoleHost.split('.').slice(1).join('.') : '')
if (!domain) {
  fail(
    'Could not determine the platform domain (no `console` HTTPRoute/Ingress found).\n' +
      '  Set it explicitly:  ADHAR_DOMAIN=cloud.adhar.io npm run dev:env',
  )
}
console.log(`\x1b[36m▸\x1b[0m domain    ${domain}  (tools resolve as https://<tool>.${domain})`)

// ── 5. tool credentials, mirroring what the Deployment mounts ───────────────
const [
  argocdPassword,
  grafanaUser,
  grafanaPassword,
  harborPassword,
  nexusUser,
  nexusPassword,
  metabaseUser,
  metabasePassword,
  aiModel,
] = await Promise.all([
  secretKey('argocd-credentials', 'ARGOCD_ADMIN_PASSWORD'),
  secretKey('prometheus-grafana', 'admin-user'),
  secretKey('prometheus-grafana', 'admin-password'),
  secretKey('harbor-core', 'HARBOR_ADMIN_PASSWORD'),
  secretKey('nexus-credentials', 'username'),
  secretKey('nexus-credentials', 'password'),
  secretKey('metabase-admin-credentials', 'username'),
  secretKey('metabase-admin-credentials', 'password'),
  secretKey('adhar-ai-llm', 'MODEL'),
])

// These the Deployment pulls in wholesale with envFrom, so copy every key —
// minus the ones that cannot work from a laptop.
const rawBulk: Record<string, string> = {
  ...(await secretAll('console-env-vars')),
  ...(await secretAll('gitea-credentials')),
  ...(await secretAll('coder-credentials')),
  ...(await secretAll('plane-api-token')),
}

/**
 * Keys that must NOT be copied.
 *
 * The auth pair is the important one. `console-env-vars` carries
 * AUTH_CLIENT_SECRET and AUTH_COOKIE_SECRET, and with `ADHAR_DOMAIN` set the
 * console derives `https://keycloak.<domain>` — so copying them flips the BFF
 * into real SSO ("auth: keycloak"). That cannot complete here: the Keycloak
 * client's redirect URIs are the production console's, not localhost:5100, so
 * the login just fails. Leaving them out is what keeps the one-click demo
 * session, which is the point of local dev.
 *
 * The POSTGRES keys and DATABASE_URL address an in-cluster database, and the bare
 * `username`/`password` keys are too generic to mean anything as env vars.
 */
const SKIP_KEYS = new Set([
  'AUTH_CLIENT_SECRET',
  'AUTH_COOKIE_SECRET',
  'DATABASE_URL',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_PASSWORD',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'username',
  'password',
])

/** `.svc`, `.cluster.local`, localhost — right in-cluster, useless here, and
 *  an explicit `<TOOL>_URL` always beats the derived public one, so copying
 *  such a value would actively break that tool. */
function internalUrl(v: string): boolean {
  if (!/^https?:\/\//i.test(v)) return false
  try {
    const h = new URL(v).hostname
    return /(\.svc$|\.svc\.cluster\.local$|\.cluster\.local$)|^localhost$|^127\./.test(h)
  } catch {
    return false
  }
}

const bulk: Record<string, string> = {}
const dropped: string[] = []
for (const [k, v] of Object.entries(rawBulk)) {
  if (SKIP_KEYS.has(k)) { dropped.push(k); continue }
  if (internalUrl(v)) { dropped.push(`${k} (in-cluster URL)`); continue }
  bulk[k] = v
}

const found = [
  argocdPassword && 'argocd',
  grafanaPassword && 'grafana',
  harborPassword && 'harbor',
  nexusPassword && 'nexus',
  metabasePassword && 'metabase',
  Object.keys(bulk).length ? `${Object.keys(bulk).length} keys from envFrom secrets` : null,
].filter(Boolean)
console.log(`\x1b[36m▸\x1b[0m creds     ${found.length ? found.join(', ') : 'none readable'}`)
if (dropped.length) {
  console.log(`\x1b[36m▸\x1b[0m skipped   ${dropped.join(', ')}`)
}

// ── 6. tools that only a tunnel can reach ───────────────────────────────────
// Most tools answer on the public ingress. A handful sit behind an
// oauth2-proxy that redirects to Keycloak, and a server-to-server call cannot
// complete an interactive SSO flow — for those the in-cluster Service is the
// only usable address. `dev:tunnel` forwards them; this writes the matching
// localhost URLs. Both read the mapping from dev-cluster.ts so they agree.
const deployJson = await trySh(['kubectl', 'get', 'deploy', DEPLOY, '-n', NS, '-o', 'json'])
const tunnels = deployJson ? tunnelsFromEnv(containerEnv(deployJson), SSO_GATED) : []
console.log(
  `\x1b[36m▸\x1b[0m tunnels   ${
    tunnels.length
      ? `${tunnels.length} SSO-gated tools → localhost:${tunnels[0].localPort}+  (run \x1b[1mnpm run dev:tunnel\x1b[0m)`
      : 'none needed'
  }`,
)

// ── 6. write it ─────────────────────────────────────────────────────────────
const line = (k: string, v: string | null | undefined) => (v ? `${k}=${v}\n` : '')

let out = `# Generated by \`npm run dev:env\` from kubectl context "${context}".
# Real credentials from a live cluster — gitignored, 0600, delete when done.
# The ServiceAccount token expires; re-run this when reads start 401ing.
#
# Regenerate:  npm run dev:env
# Point elsewhere:  kubectl config use-context <other> && npm run dev:env

# ── platform ────────────────────────────────────────────────────────────────
# One variable; every tool URL derives from it (apps/console/app/server/domain.ts).
ADHAR_DOMAIN=${domain}

# ── kubernetes ──────────────────────────────────────────────────────────────
K8S_API_URL=${server}
K8S_SA_TOKEN=${token}
# Call as the ServiceAccount, WITHOUT impersonation: the local dev session is a
# stub with no cluster identity, and impersonating it would 403 every read.
# This means local dev sees whatever the SA can see, not per-user RBAC.
K8S_AUTH_MODE=service
${caWritten ? `DENO_CERT=${caPath}\n` : ''}
# ── auth ────────────────────────────────────────────────────────────────────
# Deliberately NOT configured: with no KEYCLOAK_URL the login page offers the
# stub "demo user" session, which is what makes local dev one click.
AUTH_PUBLIC_URL=http://localhost:5100
AUTH_COOKIE_SECURE=false
# That stub session lives in the BROWSER only — the BFF never sees a cookie, so
# every cluster route would 401 "Not signed in". This lets the BFF answer as the
# ServiceAccount instead. It is refused unless Keycloak is unconfigured AND the
# process is not in-cluster, so it cannot engage anywhere but a laptop.
ADHAR_DEV_CLUSTER_AUTH=true

# ── tool credentials (from cluster Secrets) ────────────────────────────────
`

out += line('ARGOCD_USERNAME', argocdPassword ? 'admin' : null)
out += line('ARGOCD_PASSWORD', argocdPassword)
out += line('GRAFANA_USERNAME', grafanaUser)
out += line('GRAFANA_PASSWORD', grafanaPassword)
out += line('HARBOR_USERNAME', harborPassword ? 'admin' : null)
out += line('HARBOR_PASSWORD', harborPassword)
out += line('HARBOR_PROJECT', 'library')
out += line('NEXUS_USERNAME', nexusUser)
out += line('NEXUS_PASSWORD', nexusPassword)
out += line('METABASE_USERNAME', metabaseUser)
out += line('METABASE_PASSWORD', metabasePassword)
out += line('AI_MODEL', aiModel ?? 'default')
out += line('ARGOCD_NAMESPACE', NS)
out += line('MIMIR_TENANT', 'anonymous')

if (tunnels.length) {
  out += '\n# ── tunnelled tools (need `npm run dev:tunnel` running) ────────────────────\n'
  for (const t of tunnels) {
    out += `${t.varName}=http://127.0.0.1:${t.localPort}${t.path}\n`
  }
}

if (Object.keys(bulk).length) {
  out += '\n# ── from console-env-vars / gitea-credentials / coder / plane ──────────────\n'
  for (const [k, v] of Object.entries(bulk).sort()) {
    // Single-line values only; a multi-line cert would break the env file.
    if (v.includes('\n')) continue
    out += `${k}=${v}\n`
  }
}

const envPath = `${Deno.cwd()}/.env`
await Deno.writeTextFile(envPath, out)
await Deno.chmod(envPath, 0o600)

console.log(`\n\x1b[32m✓\x1b[0m wrote ${envPath} (0600)`)
console.log(`  run \x1b[1mnpm run dev\x1b[0m — the BFF now talks to ${context}`)
console.log(
  `  \x1b[33m!\x1b[0m contains live credentials and sees everything ${NS}/${SA} can see; per-user RBAC is not exercised locally`,
)
