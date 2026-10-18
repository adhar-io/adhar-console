import type { argocd } from '@adhar/api-clients'
import { envLabel, envOrder, type EntityDeployment, type KargoEnvironment, workloadNamespace } from './catalog-deployment.ts'

/**
 * Pure derivations behind the catalog drawer's Deployment tab.
 *
 * Everything here is a function of data already fetched (Argo CD
 * Applications, Kargo stages, HTTPRoutes, Gitea commits, Harbor artifacts) so
 * it can be tested without a cluster. The platform facts it encodes:
 *
 *   - An Application XR `<app>` composes one Argo CD Application per
 *     environment, `<project>-<app>-<env>` in `adhar-system`, labelled
 *     `adhar.io/application` + `adhar.io/environment`, deploying
 *     `deploy/envs/<env>` into the environment's namespace.
 *   - It also composes a Kargo Stage `<app>-<env>` per environment, chained
 *     dev → test → prod, whose promotion commits `promote(<env>): …` to the
 *     app repository and pins the image by DIGEST.
 *   - CI is the shared Tekton `app-ci` pipeline; it publishes
 *     `harbor…/library/<repo>:<full commit sha>`.
 *   - Each application gets a Grafana dashboard, uid `app-<app>`, with an
 *     `env` variable.
 */

/* ─────────── environments ─────────── */

export interface EnvRow {
  /** Environment key (`dev`, `test`, `prod`, …). */
  key: string
  label: string
  /** The service's Argo CD application for this environment. */
  app?: argocd.Application
  /** The Kargo stage that promotes into it, when the service has a chain. */
  kargo?: KargoEnvironment
  /** Where the workload runs (Argo CD's managed resources, else the destination). */
  namespace?: string
  /** Why the environment has no Argo CD app, when the control plane expects one. */
  missing?: string
}

/** What the control plane expects per environment (see `diagnoseDelivery`). */
export interface ExpectedEnv {
  env: string
  namespace?: string
  /** Set when the env's Argo CD app is not live: why. */
  appProblem?: string
}

/**
 * Add the environments the control plane expects but nothing deployed yet, and
 * say why each has no Argo CD app — "test: no Argo CD app yet — <reason>"
 * instead of the environment silently not being there.
 */
export function withExpectedEnvs(rows: readonly EnvRow[], expected: readonly ExpectedEnv[]): EnvRow[] {
  const out = rows.map((r) => {
    const e = expected.find((x) => x.env === r.key)
    if (!e) return r
    return { ...r, namespace: r.namespace ?? e.namespace, ...(!r.app && e.appProblem ? { missing: e.appProblem } : {}) }
  })
  for (const e of expected) {
    if (out.some((r) => r.key === e.env)) continue
    out.push({ key: e.env, label: envLabel(e.env), ...(e.namespace ? { namespace: e.namespace } : {}), missing: e.appProblem ?? 'no Argo CD app yet' })
  }
  // Project environments are dev/test/prod, whose conventional order IS the
  // chain order; the Kargo index breaks ties for custom names.
  return out.sort((a, b) => envOrder(a.key) - envOrder(b.key) || (a.kargo?.index ?? 99) - (b.kargo?.index ?? 99))
}

function stageEnvKey(k: KargoEnvironment): string {
  if (k.env) return k.env.toLowerCase()
  const declared = (k.stage.labels?.['adhar.io/environment'] ?? '').trim().toLowerCase()
  if (declared) return declared
  const appEnv = k.app?.metadata.labels?.['adhar.io/environment']
  if (appEnv) return appEnv.toLowerCase()
  // `<app>-<env>` → `<env>`; the shared chain's stages are named for the env.
  const name = k.stage.name.toLowerCase()
  const dash = name.lastIndexOf('-')
  return dash >= 0 ? name.slice(dash + 1) : name
}

/**
 * One row per environment, in promotion order.
 *
 * The Kargo chain's order is authoritative when the service has one (it is
 * the order freight actually travels); environments Argo CD knows about but
 * Kargo does not are appended by their conventional position.
 */
export function environmentRows(deployment: EntityDeployment, kenvs: readonly KargoEnvironment[]): EnvRow[] {
  const rows: EnvRow[] = []
  const seen = new Set<string>()
  for (const k of kenvs) {
    const key = stageEnvKey(k)
    if (seen.has(key)) continue
    seen.add(key)
    const app = k.app ?? deployment.environments.find((e) => e.key.toLowerCase() === key)?.app
    rows.push({ key, label: k.label || envLabel(key), app, kargo: k, namespace: app ? workloadNamespace(app) : undefined })
  }
  const rest = deployment.environments
    .filter((e) => !seen.has(e.key.toLowerCase()))
    .sort((a, b) => envOrder(a.key) - envOrder(b.key) || a.key.localeCompare(b.key))
  for (const e of rest) {
    if (seen.has(e.key.toLowerCase())) continue
    seen.add(e.key.toLowerCase())
    rows.push({ key: e.key.toLowerCase(), label: e.label, app: e.app, namespace: workloadNamespace(e.app) })
  }
  return rows
}

/** Distinct workload namespaces across the rows (where routes, alerts and runs live). */
export function envNamespaces(rows: readonly EnvRow[]): string[] {
  return [...new Set(rows.map((r) => r.namespace).filter((n): n is string => Boolean(n)))]
}

/* ─────────── sync history ─────────── */

export interface DeployEvent {
  app: string
  /** Environment key, when the app belongs to one. */
  env?: string
  envLabel: string
  id: number
  revision?: string
  repoURL?: string
  deployedAt: string
  startedAt?: string
  durationSecs?: number
  initiatedBy?: string
  automated?: boolean
  /** The entry that is live now (the newest one of its application). */
  current: boolean
  /** The revision the same application ran before this one — the rollback target. */
  previousRevision?: string
}

const SHA = /^[0-9a-f]{7,40}$/i

/** Every recorded sync across the matched apps, newest first. */
export function deployEvents(deployment: Pick<EntityDeployment, 'apps' | 'environments'>): DeployEvent[] {
  const out: DeployEvent[] = []
  for (const app of deployment.apps) {
    const env = deployment.environments.find((e) => e.app.metadata.name === app.metadata.name)
    const hist = [...app.status.history].filter((h) => h.deployedAt).sort((a, b) => a.id - b.id)
    hist.forEach((h, i) => {
      const revision = h.revision ?? h.revisions?.[0]
      const prev = hist[i - 1]
      const start = h.deployStartedAt ? Date.parse(h.deployStartedAt) : NaN
      const end = Date.parse(h.deployedAt!)
      out.push({
        app: app.metadata.name,
        env: env?.key.toLowerCase(),
        envLabel: env?.label ?? app.metadata.name,
        id: h.id,
        revision,
        repoURL: h.source?.repoURL ?? h.sources?.[0]?.repoURL,
        deployedAt: h.deployedAt!,
        ...(h.deployStartedAt ? { startedAt: h.deployStartedAt } : {}),
        ...(Number.isFinite(start) && Number.isFinite(end) && end >= start ? { durationSecs: Math.round((end - start) / 1000) } : {}),
        ...(h.initiatedBy?.username ? { initiatedBy: h.initiatedBy.username } : {}),
        ...(h.initiatedBy?.automated !== undefined ? { automated: h.initiatedBy.automated } : {}),
        current: i === hist.length - 1,
        ...(prev ? { previousRevision: prev.revision ?? prev.revisions?.[0] } : {}),
      })
    })
  }
  return out.sort((a, b) => b.deployedAt.localeCompare(a.deployedAt) || b.id - a.id)
}

export type TriggerKind = 'promotion' | 'user' | 'auto' | 'unknown'

/**
 * What caused a sync, as far as the evidence goes.
 *
 * A Kargo promotion is a commit `promote(<env>): …` that Argo CD then
 * synced; Argo CD's own record names the user for a manual sync or says
 * `automated` for auto-sync. Older Argo CD versions record neither, and the
 * answer is then honestly "unknown".
 */
export function describeTrigger(ev: Pick<DeployEvent, 'initiatedBy' | 'automated'>, commitMessage?: string): { kind: TriggerKind; label: string } {
  const msg = (commitMessage ?? '').trim()
  const promo = /^promote\(([^)]+)\)/.exec(msg)
  if (promo) return { kind: 'promotion', label: `Kargo promotion to ${promo[1]}` }
  if (ev.initiatedBy && ev.initiatedBy !== 'automation') return { kind: 'user', label: `Synced by ${ev.initiatedBy}` }
  if (ev.automated || ev.initiatedBy === 'automation') return { kind: 'auto', label: 'Auto-sync' }
  return { kind: 'unknown', label: '' }
}

/* ─────────── deployment frequency ─────────── */

export interface FrequencyDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string
  counts: Record<string, number>
  total: number
}

export interface Frequency {
  days: FrequencyDay[]
  /** Environment keys present, in promotion order; `other` for unscoped apps. */
  keys: string[]
  total: number
  /** Most recent deploy across the whole history (not just the window). */
  last?: string
}

const DAY_MS = 86_400_000

/** Deploys per day per environment over the last `days` days (UTC), oldest first. */
export function deployFrequency(events: readonly DeployEvent[], days = 14, now = Date.now()): Frequency {
  const today = Math.floor(now / DAY_MS)
  const out: FrequencyDay[] = Array.from({ length: days }, (_, i) => ({
    date: new Date((today - (days - 1 - i)) * DAY_MS).toISOString().slice(0, 10),
    counts: {},
    total: 0,
  }))
  const keys = new Set<string>()
  let total = 0
  let last: string | undefined
  for (const ev of events) {
    const t = Date.parse(ev.deployedAt)
    if (!Number.isFinite(t)) continue
    if (!last || ev.deployedAt > last) last = ev.deployedAt
    const idx = Math.floor(t / DAY_MS) - (today - (days - 1))
    if (idx < 0 || idx >= days) continue
    const key = ev.env ?? 'other'
    keys.add(key)
    out[idx].counts[key] = (out[idx].counts[key] ?? 0) + 1
    out[idx].total++
    total++
  }
  const ordered = [...keys].sort((a, b) => (a === 'other' ? 1 : b === 'other' ? -1 : envOrder(a) - envOrder(b) || a.localeCompare(b)))
  return { days: out, keys: ordered, total, ...(last ? { last } : {}) }
}

/* ─────────── endpoints ─────────── */

/**
 * The environment a route serves: the one whose workload namespace it lives
 * in (each environment has its own namespace), else an environment token in
 * its hostname (`shop-dev.example.com`, `shop.dev.example.com`).
 */
export function routeEnvironment(route: { namespace: string; host: string }, rows: readonly EnvRow[]): string | undefined {
  const inNs = rows.filter((r) => r.namespace && r.namespace === route.namespace)
  if (inNs.length === 1) return inNs[0].key
  const candidates = inNs.length ? inNs : rows
  const tokens = new Set(route.host.toLowerCase().split('.').flatMap((label) => label.split('-')))
  const byHost = candidates.filter((r) => tokens.has(r.key))
  if (byHost.length === 1) return byHost[0].key
  return undefined
}

/* ─────────── repository / registry ─────────── */

/** `{org, repo}` for a repository on the platform's Gitea, else undefined. */
export function giteaRepoRef(repoUrl: string | undefined, giteaPublicUrl = ''): { org: string; repo: string } | undefined {
  if (!repoUrl) return undefined
  let u: URL
  try {
    u = new URL(repoUrl)
  } catch {
    return undefined
  }
  let giteaHost = ''
  try {
    giteaHost = giteaPublicUrl ? new URL(giteaPublicUrl).host.toLowerCase() : ''
  } catch { /* none */ }
  const host = u.host.toLowerCase()
  if (!(host === giteaHost || host.includes('gitea') || host.startsWith('git.'))) return undefined
  const [org, repo] = u.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (!org || !repo) return undefined
  return { org, repo: repo.replace(/\.git$/, '') }
}

export interface ImageRef {
  /** `host/project/repo` without tag or digest. */
  repository: string
  host: string
  /** Path after the host (`library/my-service`). */
  path: string
  tag?: string
  digest?: string
}

export function parseImage(ref: string): ImageRef {
  let rest = ref.trim()
  let digest: string | undefined
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  let tag: string | undefined
  const colon = rest.lastIndexOf(':')
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  const slash = rest.indexOf('/')
  const first = slash >= 0 ? rest.slice(0, slash) : ''
  const hasHost = slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')
  const host = hasHost ? first : 'docker.io'
  const path = hasHost ? rest.slice(slash + 1) : rest
  return { repository: rest, host, path, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}) }
}

/**
 * The Harbor repository behind an app's images: `{project, repo}` for the
 * first image hosted on Harbor (the paved road publishes to
 * `harbor…/library/<repo>`), so its tags can be listed.
 */
export function harborRepoOf(images: readonly string[], preferName?: string): { project: string; repo: string } | undefined {
  const refs = images.map(parseImage).filter((i) => /harbor/i.test(i.host) && i.path.includes('/'))
  const pick = refs.find((r) => preferName && r.path.split('/').pop() === preferName) ?? refs[0]
  if (!pick) return undefined
  const [project, ...repo] = pick.path.split('/')
  return { project, repo: repo.join('/') }
}

/**
 * A human-readable version for an image an environment runs: its tag, or —
 * because Kargo pins images by DIGEST — the tag Harbor holds for that digest
 * (app-ci tags each build with its commit SHA).
 */
export function imageVersion(
  image: string,
  artifacts: ReadonlyArray<{ digest: string; tags?: Array<{ name: string }> }> | undefined,
): { label: string; commit?: string; digest?: string } {
  const ref = parseImage(image)
  const fromHarbor = ref.digest ? artifacts?.find((a) => a.digest === ref.digest)?.tags?.[0]?.name : undefined
  const tag = ref.tag ?? fromHarbor
  if (tag) return { label: SHA.test(tag) ? tag.slice(0, 7) : tag, ...(SHA.test(tag) ? { commit: tag } : {}), ...(ref.digest ? { digest: ref.digest } : {}) }
  if (ref.digest) return { label: ref.digest.replace(/^sha256:/, '').slice(0, 12), digest: ref.digest }
  return { label: 'latest' }
}

/* ─────────── monitoring ─────────── */

/** The control plane's per-application Grafana dashboard (`app-<name>`), at one environment. */
export function appDashboardUrl(grafanaBase: string, app: string, env?: string): string | undefined {
  if (!grafanaBase || !app) return undefined
  const p = new URLSearchParams({ refresh: '30s' })
  if (env) p.set('var-env', env)
  return `${grafanaBase.replace(/\/$/, '')}/d/app-${encodeURIComponent(app)}?${p}`
}

/** kube-prometheus' "Compute Resources / Workload" dashboard, scoped to one namespace. */
export function workloadDashboardUrl(grafanaBase: string, workload: string, namespace?: string): string | undefined {
  if (!grafanaBase || !workload) return undefined
  const p = new URLSearchParams({ 'var-workload': workload, 'var-type': 'deployment', refresh: '30s' })
  if (namespace) p.set('var-namespace', namespace)
  return `${grafanaBase.replace(/\/$/, '')}/d/a164a7f0339f99e89cea5cb47e9be617/kubernetes-compute-resources-workload?${p}`
}

/**
 * Does this alert belong to the service? Its workload labels must name it,
 * and when it carries a namespace that namespace must be one the service runs
 * in. The catalog's own `metadata.namespace` is not a Kubernetes namespace and
 * is never used here.
 */
export function alertMatches(labels: Record<string, string>, name: string, namespaces: readonly string[]): boolean {
  const n = name.toLowerCase()
  const ns = (labels.namespace ?? '').toLowerCase()
  if (namespaces.length && ns && !namespaces.some((x) => x.toLowerCase() === ns)) return false
  const direct = [labels.deployment, labels.rollout, labels.statefulset, labels.daemonset, labels.workload, labels.app, labels.service, labels['app.kubernetes.io/name'], labels.job, labels.container]
  if (direct.some((v) => (v ?? '').toLowerCase() === n)) return true
  const pod = (labels.pod ?? '').toLowerCase()
  return Boolean(pod && (pod === n || pod.startsWith(`${n}-`)))
}

/* ─────────── formatting ─────────── */

export function shortSha(rev?: string): string | undefined {
  if (!rev) return undefined
  return SHA.test(rev) ? rev.slice(0, 7) : rev
}

export function isSha(rev?: string): boolean {
  return Boolean(rev && SHA.test(rev))
}

export function fmtDuration(s?: number): string {
  if (s === undefined) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** "3m ago", "2h ago", "5d ago", else the date. Empty for an unparseable value. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)}d ago`
  return new Date(t).toISOString().slice(0, 10)
}
