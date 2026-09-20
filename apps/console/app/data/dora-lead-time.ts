/**
 * Lead time for changes — commit authored → running in the cluster.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT PR CYCLE TIME
 * ---------------------------------------------------------------------------
 * `dora-flow.ts` measures the median pull-request open→merge time, which is a
 * widely-used proxy. It is the wrong one for an Adhar platform: measured on a
 * live instance, the Gitea org had SIX repositories and ZERO merged pull
 * requests, because packages are pushed to `main` by `adhar upgrade` rather
 * than reviewed through PRs. The tile would read "—" forever on a platform
 * that deploys many times a day.
 *
 * This module measures the actual DORA definition instead — "time from code
 * committed to code successfully running in production" — which is both more
 * correct and, here, actually computable:
 *
 *   Argo CD `status.history[]`  →  a commit SHA and the time it went live
 *   Gitea commits API           →  when that SHA was authored
 *
 * ---------------------------------------------------------------------------
 * THE FIELD THAT LOOKED MISSING
 * ---------------------------------------------------------------------------
 * The console's Argo CD schema reads `history[].revision` and `spec.source`,
 * both singular, and on a real cluster all 110 history entries appeared to
 * have no revision at all. They do: multi-source applications record
 * `revisions[]` and `sources[]`, and every application on that cluster is
 * multi-source. Reading only the singular fields is why lead time looked
 * underivable from Argo CD. Both spellings are handled here.
 */

/** One deploy, as far as lead time is concerned. */
export interface DeployRevision {
  sha: string
  /** `org/repo`, resolved from the source repository URL. */
  org: string
  repo: string
  deployedAtMs: number
}

/**
 * `http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/packages` →
 * `{ org: 'adhar', repo: 'packages' }`.
 *
 * Takes the last two path segments rather than parsing a known host, because
 * the same repository is reachable by several names — the in-cluster Service
 * DNS that Argo CD stores, and the public ingress a person would paste. A
 * trailing `.git` is stripped; SSH-style `git@host:org/repo.git` is handled
 * too, since Argo CD accepts it.
 */
export function parseRepoSlug(repoURL: string): { org: string; repo: string } | null {
  if (!repoURL) return null
  const withoutScheme = repoURL.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@]+@/, '')
  const path = withoutScheme.replace(/^[^/:]+[:/]/, '')
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const repo = parts[parts.length - 1].replace(/\.git$/, '')
  const org = parts[parts.length - 2]
  if (!org || !repo) return null
  return { org, repo }
}

/** The Argo CD history shape this module reads, singular and plural spellings. */
export interface HistoryEntry {
  deployedAt?: string
  revision?: string
  revisions?: string[]
  source?: { repoURL?: string }
  sources?: Array<{ repoURL?: string }>
}

/**
 * Flatten an application's history into deploy revisions.
 *
 * A multi-source application has one revision per source, positionally
 * aligned with `sources[]`. Only the FIRST is used: lead time is a per-deploy
 * figure, and counting a three-source application as three deploys would
 * weight it triple against a single-source one.
 */
export function deployRevisions(
  history: HistoryEntry[],
  sinceMs: number,
  specSources?: Array<{ repoURL?: string }>,
): DeployRevision[] {
  const out: DeployRevision[] = []
  for (const h of history) {
    if (!h.deployedAt) continue
    const deployedAtMs = new Date(h.deployedAt).getTime()
    if (!Number.isFinite(deployedAtMs) || deployedAtMs < sinceMs) continue

    const sha = h.revisions?.[0] ?? h.revision ?? ''
    // A SHA is 40 hex chars; a branch name or a Helm chart version is not
    // something the commits API can resolve, so don't spend a request on it.
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue

    const repoURL = h.sources?.[0]?.repoURL ?? h.source?.repoURL ?? specSources?.[0]?.repoURL ?? ''
    const slug = parseRepoSlug(repoURL)
    if (!slug) continue

    out.push({ sha, org: slug.org, repo: slug.repo, deployedAtMs })
  }
  return out
}

export interface LeadTimeSummary {
  /** Median hours from commit to running, or null when nothing resolved. */
  medianHours: number | null
  /** Deploys the median is based on. */
  sampleSize: number
  /** Deploys whose commit could not be found — shown so the sample is judgeable. */
  unresolved: number
}

/**
 * Median commit→deploy time.
 *
 * Deploys whose commit is not in the map are reported as `unresolved` rather
 * than dropped silently: a SHA older than the commit window we fetched, or in
 * a repo the caller could not read, means the sample is narrower than the
 * deploy count suggests, and that is worth saying on the tile.
 *
 * A negative duration is discarded. It means the commit timestamp is after the
 * deploy — which happens with a rewritten history or a clock skew between
 * Gitea and the cluster — and a negative lead time is not a number to publish.
 */
export function leadTimeSummary(
  deploys: DeployRevision[],
  commitTimeBySha: Map<string, number>,
): LeadTimeSummary {
  const hours: number[] = []
  let unresolved = 0
  for (const d of deploys) {
    const committedAt = commitTimeBySha.get(d.sha.toLowerCase())
    if (committedAt === undefined) {
      unresolved += 1
      continue
    }
    const h = (d.deployedAtMs - committedAt) / 3_600_000
    if (h < 0) continue
    hours.push(h)
  }
  if (hours.length === 0) return { medianHours: null, sampleSize: 0, unresolved }
  hours.sort((a, b) => a - b)
  const mid = Math.floor(hours.length / 2)
  const median = hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2
  return { medianHours: median, sampleSize: hours.length, unresolved }
}

/** Distinct `org/repo` pairs to fetch commits for. */
export function repoKeys(deploys: DeployRevision[]): Array<{ org: string; repo: string }> {
  const seen = new Map<string, { org: string; repo: string }>()
  for (const d of deploys) seen.set(`${d.org}/${d.repo}`, { org: d.org, repo: d.repo })
  return [...seen.values()]
}
