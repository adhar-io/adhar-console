import type { harbor } from '@adhar/api-clients'

/**
 * Rolling image scans up into the numbers the Vulnerability Scans page states.
 *
 * The page used to read a BFF route backed by seeded sample reports, so it
 * showed four zeros and "Trivy hasn't generated any matching reports yet" on a
 * platform whose registry had Trivy registered as its default scanner. Harbor
 * runs that scanner and holds the results per artifact; this turns a list of
 * artifacts into the roll-up, and keeps "nobody has scanned this" distinct
 * from "scanned, nothing found", which are the same zero on a summary row and
 * mean opposite things.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type Severity = typeof SEVERITIES[number]

export interface ScannedArtifact {
  /** Harbor's full repository name, `<project>/<path>`. */
  repo: string
  project: string
  digest: string
  /** Tags, or the short digest when an artifact carries none. */
  label: string
  tags: string[]
  size: number
  pushedAt?: string
  /** Absent when this artifact has never been scanned. */
  scan?: harbor.Artifact['scan']
  counts: Record<Severity, number>
  total: number
  fixable?: number
  scanned: boolean
  /** A scan that ran and failed is not the same as one that never ran. */
  failed: boolean
  running: boolean
  worst?: Severity
}

function shortDigest(digest: string): string {
  const hex = digest.includes(':') ? digest.split(':')[1] : digest
  return hex.slice(0, 12)
}

/** Harbor's scan status vocabulary, which is not a fixed enum across versions. */
function statusOf(status?: string): { scanned: boolean; failed: boolean; running: boolean } {
  const s = (status ?? '').toLowerCase()
  if (!s) return { scanned: false, failed: false, running: false }
  if (s === 'success' || s === 'succeed' || s === 'succeeded') {
    return { scanned: true, failed: false, running: false }
  }
  if (s === 'error' || s === 'failed' || s === 'stopped') {
    return { scanned: false, failed: true, running: false }
  }
  if (s === 'running' || s === 'pending' || s === 'scheduled' || s === 'queued') {
    return { scanned: false, failed: false, running: true }
  }
  // `Not Scanned` and anything a future Harbor invents.
  return { scanned: false, failed: false, running: false }
}

export function readArtifact(repo: string, a: harbor.Artifact): ScannedArtifact {
  const v = a.vulnerabilities
  const counts: Record<Severity, number> = {
    critical: v?.critical ?? 0,
    high: v?.high ?? 0,
    medium: v?.medium ?? 0,
    low: v?.low ?? 0,
  }
  const tags = (a.tags ?? []).map((t) => t.name)
  const { scanned, failed, running } = statusOf(a.scan?.status)
  const slash = repo.indexOf('/')

  return {
    repo,
    project: slash > 0 ? repo.slice(0, slash) : repo,
    digest: a.digest,
    label: tags[0] ?? shortDigest(a.digest),
    tags,
    size: a.size ?? 0,
    pushedAt: a.push_time,
    scan: a.scan,
    counts,
    total: SEVERITIES.reduce((n, s) => n + counts[s], 0),
    fixable: a.scan?.fixable,
    scanned,
    failed,
    running,
    worst: SEVERITIES.find((s) => counts[s] > 0),
  }
}

export interface ScanSummary {
  counts: Record<Severity, number>
  total: number
  artifacts: number
  scanned: number
  unscanned: number
  failed: number
  running: number
  fixable: number
  /** Artifacts carrying at least one critical or high finding. */
  atRisk: number
  /** Scanned artifacts with nothing found — a real result, not a missing one. */
  clean: number
}

export function summariseScans(list: ScannedArtifact[]): ScanSummary {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  let scanned = 0
  let failed = 0
  let running = 0
  let fixable = 0
  let atRisk = 0
  let clean = 0

  for (const a of list) {
    if (a.failed) failed++
    if (a.running) running++
    if (!a.scanned) continue
    scanned++
    for (const s of SEVERITIES) counts[s] += a.counts[s]
    fixable += a.fixable ?? 0
    if (a.counts.critical > 0 || a.counts.high > 0) atRisk++
    if (a.total === 0) clean++
  }

  return {
    counts,
    total: SEVERITIES.reduce((n, s) => n + counts[s], 0),
    artifacts: list.length,
    scanned,
    // Never scanned: a failed or running scan is neither scanned nor waiting
    // to be, and lumping them together hides a scanner that is erroring.
    unscanned: list.filter((a) => !a.scanned && !a.failed && !a.running).length,
    failed,
    running,
    fixable,
    atRisk,
    clean,
  }
}

/** Worst first, then most findings, then by name, so the list never shuffles. */
export function byRisk(a: ScannedArtifact, b: ScannedArtifact): number {
  const rank = (x: ScannedArtifact) => (x.worst ? SEVERITIES.indexOf(x.worst) : SEVERITIES.length)
  return rank(a) - rank(b) ||
    b.total - a.total ||
    a.repo.localeCompare(b.repo) ||
    a.label.localeCompare(b.label)
}

export interface VulnFilter {
  severities?: Severity[]
  /** Only findings with a fixed version available. */
  fixableOnly?: boolean
  search?: string
}

/**
 * Harbor reports `Negligible` and `Unknown` alongside the four severities the
 * summary counts. They are real findings and must stay visible, so they are
 * bucketed as `low` for filtering rather than silently dropped.
 */
export function vulnSeverity(v: Pick<harbor.Vulnerability, 'severity'>): Severity {
  const s = (v.severity ?? '').toLowerCase()
  return s === 'critical' || s === 'high' || s === 'medium' ? s : 'low'
}

export function matchesVuln(v: harbor.Vulnerability, f: VulnFilter): boolean {
  if (f.severities?.length && !f.severities.includes(vulnSeverity(v))) return false
  if (f.fixableOnly && !v.fixVersion) return false
  const q = f.search?.trim().toLowerCase()
  if (q) {
    const hay = [v.id, v.package, v.version, v.fixVersion, v.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

/** Worst first, then by CVSS, then by package — a stable, useful reading order. */
export function byVulnRisk(a: harbor.Vulnerability, b: harbor.Vulnerability): number {
  const rank = (v: harbor.Vulnerability) => SEVERITIES.indexOf(vulnSeverity(v))
  return rank(a) - rank(b) ||
    (b.cvssScore ?? 0) - (a.cvssScore ?? 0) ||
    a.package.localeCompare(b.package) ||
    a.id.localeCompare(b.id)
}
