import type { GateView, ScanPolicy, ScanSummary, Waiver } from './security-types.ts'

/**
 * The security pages' model, from what the platform actually reports:
 *
 *   • runtime — trivy-operator VulnerabilityReports / SbomReports
 *     (`aquasecurity.github.io/v1alpha1`), one per workload container;
 *   • CI — the scan summary the pipeline publishes on its PipelineRun;
 *   • waivers — the console's review records.
 *
 * Pure and JSX-free so it is unit-tested. Nothing here invents a value: a
 * field the scanner did not report (EPSS, KEV, a fixed version) stays absent.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const
export type Severity = typeof SEVERITIES[number]

export function toSeverity(s: string | undefined): Severity {
  const v = (s ?? '').toLowerCase()
  return (SEVERITIES as readonly string[]).includes(v) ? v as Severity : v === 'negligible' ? 'low' : 'unknown'
}

/* ───────────────────────── trivy-operator reports ───────────────────────── */

export interface TrivyVuln {
  vulnerabilityID?: string
  resource?: string
  installedVersion?: string
  fixedVersion?: string
  severity?: string
  score?: number
  title?: string
  description?: string
  primaryLink?: string
  links?: string[]
  target?: string
  class?: string
  pkgPath?: string
  pkgIdentifier?: { purl?: string }
  publishedDate?: string
  /** Present only when the scanner was configured to add them. */
  epss?: number
  epssScore?: number
  kev?: boolean
  knownExploited?: boolean
}

export interface CdxComponent {
  'bom-ref'?: string
  type?: string
  name?: string
  group?: string
  version?: string
  purl?: string
  licenses?: Array<{ license?: { id?: string; name?: string }; expression?: string }>
}

export interface TrivyReportObj {
  kind?: string
  metadata: { name: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> }
  report?: {
    updateTimestamp?: string
    registry?: { server?: string }
    artifact?: { repository?: string; tag?: string; digest?: string }
    summary?: Record<string, number>
    vulnerabilities?: TrivyVuln[]
    components?: {
      metadata?: { component?: CdxComponent }
      components?: CdxComponent[]
      dependencies?: Array<{ ref?: string; dependsOn?: string[] }>
    }
  }
}

/** Where a namespace sits in the project / environment model. */
export interface NsPlace {
  project?: string
  env?: string
}

/**
 * Namespace → project / environment. Projects own `<project>` and their
 * environments `<project>-<env>`; the longest matching project wins so
 * `shop-api` is not read as `shop` + env `api` when both exist.
 */
export function placeNamespace(ns: string, projects: string[]): NsPlace {
  if (projects.includes(ns)) return { project: ns }
  const owner = projects.filter((p) => ns.startsWith(`${p}-`)).sort((a, b) => b.length - a.length)[0]
  return owner ? { project: owner, env: ns.slice(owner.length + 1) } : {}
}

/** Workload behind a report: a ReplicaSet's pod-template hash is dropped so every rollout is the same app. */
export function workloadOf(labels: Record<string, string> | undefined): { kind?: string; name?: string; container?: string } {
  const l = labels ?? {}
  const kind = l['trivy-operator.resource.kind']
  let name = l['trivy-operator.resource.name']
  if (name && kind === 'ReplicaSet') name = name.replace(/-[a-z0-9]{6,10}$/, '')
  return { kind, name, container: l['trivy-operator.container.name'] }
}

export interface Occurrence {
  namespace: string
  project?: string
  env?: string
  /** Workload name — the app, for a control-plane application. */
  app?: string
  workloadKind?: string
  container?: string
  image: string
  repo?: string
  tag?: string
  digest?: string
  installed?: string
  fixed?: string
  pkgPath?: string
  target?: string
  report: string
  scannedAt?: string
}

export interface Finding {
  key: string
  id: string
  pkg: string
  purl?: string
  severity: Severity
  score?: number
  title?: string
  description?: string
  links: string[]
  published?: string
  fixable: boolean
  fixedVersions: string[]
  installedVersions: string[]
  epss?: number
  kev?: boolean
  occurrences: Occurrence[]
}

export const findingKey = (id: string, pkg: string) => `${id}|${pkg}`

function imageOf(r: TrivyReportObj): { image: string; repo?: string; tag?: string; digest?: string } {
  const a = r.report?.artifact ?? {}
  const server = r.report?.registry?.server
  const repo = a.repository ? (server && !a.repository.startsWith(server) ? `${server}/${a.repository}` : a.repository) : undefined
  const image = repo ? `${repo}${a.tag ? `:${a.tag}` : ''}${a.digest ? `@${a.digest}` : ''}` : r.metadata.name
  return { image, repo, tag: a.tag, digest: a.digest }
}

/** Fold every report's vulnerabilities into findings, one per (CVE, package). */
export function buildFindings(reports: TrivyReportObj[], projects: string[]): Finding[] {
  const out = new Map<string, Finding>()
  for (const r of reports) {
    const ns = r.metadata.namespace ?? ''
    const place = placeNamespace(ns, projects)
    const wl = workloadOf(r.metadata.labels)
    const img = imageOf(r)
    for (const v of r.report?.vulnerabilities ?? []) {
      if (!v.vulnerabilityID) continue
      const pkg = v.resource ?? v.pkgIdentifier?.purl ?? 'unknown'
      const key = findingKey(v.vulnerabilityID, pkg)
      let f = out.get(key)
      if (!f) {
        f = {
          key,
          id: v.vulnerabilityID,
          pkg,
          purl: v.pkgIdentifier?.purl,
          severity: toSeverity(v.severity),
          score: typeof v.score === 'number' ? v.score : undefined,
          title: v.title,
          description: v.description,
          links: [...new Set([v.primaryLink, ...(v.links ?? [])].filter((x): x is string => typeof x === 'string' && /^https?:\/\//.test(x)))],
          published: v.publishedDate,
          fixable: false,
          fixedVersions: [],
          installedVersions: [],
          occurrences: [],
        }
        out.set(key, f)
      }
      const epss = typeof v.epss === 'number' ? v.epss : typeof v.epssScore === 'number' ? v.epssScore : undefined
      if (epss !== undefined) f.epss = Math.max(f.epss ?? 0, epss)
      if (v.kev === true || v.knownExploited === true) f.kev = true
      if (v.fixedVersion) {
        f.fixable = true
        if (!f.fixedVersions.includes(v.fixedVersion)) f.fixedVersions.push(v.fixedVersion)
      }
      if (v.installedVersion && !f.installedVersions.includes(v.installedVersion)) f.installedVersions.push(v.installedVersion)
      f.occurrences.push({
        namespace: ns,
        ...place,
        app: wl.name,
        workloadKind: wl.kind,
        container: wl.container,
        ...img,
        installed: v.installedVersion,
        fixed: v.fixedVersion,
        pkgPath: v.pkgPath,
        target: v.target,
        report: r.metadata.name,
        scannedAt: r.report?.updateTimestamp ?? r.metadata.creationTimestamp,
      })
    }
  }
  return [...out.values()].sort(byFindingRisk)
}

const sevRank = (s: Severity) => SEVERITIES.indexOf(s)

export function byFindingRisk(a: Finding, b: Finding): number {
  return sevRank(a.severity) - sevRank(b.severity) ||
    Number(Boolean(b.kev)) - Number(Boolean(a.kev)) ||
    (b.epss ?? 0) - (a.epss ?? 0) ||
    (b.score ?? 0) - (a.score ?? 0) ||
    b.occurrences.length - a.occurrences.length ||
    a.id.localeCompare(b.id) ||
    a.pkg.localeCompare(b.pkg)
}

/* ───────────────────────────── waivers ───────────────────────────── */

export const isActiveWaiver = (w: Pick<Waiver, 'status' | 'expiresAt'>, now: number) => w.status === 'approved' && Date.parse(w.expiresAt) > now

export const daysLeft = (iso: string, now: number) => Math.ceil((Date.parse(iso) - now) / 86_400_000)

export const isExpiringSoon = (w: Pick<Waiver, 'status' | 'expiresAt'>, now: number, days = 7) => isActiveWaiver(w, now) && daysLeft(w.expiresAt, now) <= days

/** Does this (active) vulnerability waiver cover this occurrence of the finding? */
export function waiverCovers(w: Waiver, f: Pick<Finding, 'id' | 'pkg'>, o: Pick<Occurrence, 'project' | 'namespace' | 'app' | 'digest'>, now: number): boolean {
  if (w.kind !== 'vuln' || w.findingId !== f.id || !isActiveWaiver(w, now)) return false
  if (w.target.package && w.target.package !== f.pkg) return false
  const project = o.project ?? o.namespace
  switch (w.scope) {
    case 'platform':
      return true
    case 'project':
      return w.target.project === project
    case 'app':
      return w.target.project === project && w.target.app === o.app
    case 'digest':
      return w.target.project === project && w.target.app === o.app && Boolean(o.digest) && w.target.digest === o.digest
  }
}

export type WaiverCoverage = 'none' | 'partial' | 'waived'

export interface FindingStatus {
  coverage: WaiverCoverage
  /** Active waivers that cover at least one occurrence. */
  active: Waiver[]
  /** Every waiver record about this finding (any status), newest first. */
  related: Waiver[]
  /** Earliest expiry among the covering waivers. */
  expiresAt?: string
  pending: boolean
}

export function findingStatus(f: Finding, waivers: Waiver[], now: number): FindingStatus {
  const related = waivers.filter((w) => w.kind === 'vuln' && w.findingId === f.id && (!w.target.package || w.target.package === f.pkg))
  const active = related.filter((w) => f.occurrences.some((o) => waiverCovers(w, f, o, now)))
  const covered = f.occurrences.filter((o) => active.some((w) => waiverCovers(w, f, o, now))).length
  const coverage: WaiverCoverage = covered === 0 ? 'none' : covered === f.occurrences.length ? 'waived' : 'partial'
  const expiresAt = active.map((w) => w.expiresAt).sort()[0]
  return { coverage, active, related: related.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)), ...(expiresAt ? { expiresAt } : {}), pending: related.some((w) => w.status === 'requested') }
}

/* ───────────────────────────── filtering ───────────────────────────── */

export interface FindingFilter {
  severities?: Severity[]
  fixableOnly?: boolean
  waived?: 'all' | 'open' | 'waived'
  project?: string
  env?: string
  search?: string
}

export function matchesFinding(f: Finding, st: FindingStatus, q: FindingFilter): boolean {
  if (q.severities?.length && !q.severities.includes(f.severity)) return false
  if (q.fixableOnly && !f.fixable) return false
  if (q.waived === 'open' && st.coverage === 'waived') return false
  if (q.waived === 'waived' && st.coverage === 'none') return false
  if (q.project && !f.occurrences.some((o) => (o.project ?? o.namespace) === q.project)) return false
  if (q.env && !f.occurrences.some((o) => o.env === q.env)) return false
  const s = q.search?.trim().toLowerCase()
  if (s) {
    const hay = [f.id, f.pkg, f.title, f.purl, ...f.occurrences.map((o) => `${o.app ?? ''} ${o.image} ${o.namespace}`)].join(' ').toLowerCase()
    if (!hay.includes(s)) return false
  }
  return true
}

export interface Rollup {
  counts: Record<Severity, number>
  open: Record<Severity, number>
  fixable: number
  waived: number
  partial: number
  pending: number
  images: number
  workloads: number
  kev: number
}

export function rollup(findings: Finding[], statuses: Map<string, FindingStatus>): Rollup {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  const open = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  let fixable = 0, waived = 0, partial = 0, pending = 0, kev = 0
  const images = new Set<string>()
  const workloads = new Set<string>()
  for (const f of findings) {
    const st = statuses.get(f.key)
    counts[f.severity]++
    if (st?.coverage !== 'waived') open[f.severity]++
    if (f.fixable) fixable++
    if (st?.coverage === 'waived') waived++
    if (st?.coverage === 'partial') partial++
    if (st?.pending) pending++
    if (f.kev) kev++
    for (const o of f.occurrences) {
      images.add(o.digest ?? o.image)
      workloads.add(`${o.namespace}/${o.app ?? o.report}`)
    }
  }
  return { counts, open, fixable, waived, partial, pending, images: images.size, workloads: workloads.size, kev }
}

/* ───────────────────────────── licenses ───────────────────────────── */

export type LicenseRisk = 'deny' | 'warn' | 'ok' | 'unknown'

/** License identifiers a CycloneDX component declares (ids, names, or the ids inside an expression). */
export function licensesOf(c: CdxComponent): string[] {
  const out: string[] = []
  for (const l of c.licenses ?? []) {
    if (l.license?.id) out.push(l.license.id)
    else if (l.license?.name) out.push(l.license.name)
    else if (l.expression) out.push(l.expression)
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))]
}

const norm = (s: string) => s.trim().toLowerCase()

/** Policy verdict for one license string; an SPDX expression is as risky as its riskiest id. */
export function licenseRisk(license: string, policy: Pick<ScanPolicy, 'licenseDeny' | 'licenseWarn'> | undefined): LicenseRisk {
  if (!license) return 'unknown'
  const ids = license.split(/\s+(?:AND|OR|WITH)\s+|[()]/i).map(norm).filter(Boolean)
  const deny = new Set((policy?.licenseDeny ?? []).map(norm))
  const warn = new Set((policy?.licenseWarn ?? []).map(norm))
  if (ids.some((i) => deny.has(i))) return 'deny'
  if (ids.some((i) => warn.has(i))) return 'warn'
  return 'ok'
}

export interface LicensePackage {
  name: string
  version?: string
  purl?: string
  apps: string[]
  /** Dependency path from the image's root component, when the SBOM records one. */
  path?: string[]
}

export interface LicenseRow {
  license: string
  risk: LicenseRisk
  packages: LicensePackage[]
  apps: string[]
}

export interface AppLicenses {
  app: string
  namespace: string
  project?: string
  env?: string
  image: string
  components: number
  byRisk: Record<LicenseRisk, number>
}

/** Path of bom-refs from the SBOM's root component to `ref` (BFS over `dependencies`). */
export function componentPath(bom: NonNullable<NonNullable<TrivyReportObj['report']>['components']>, ref: string): string[] | undefined {
  const root = bom.metadata?.component?.['bom-ref']
  if (!root || !ref) return undefined
  const edges = new Map<string, string[]>()
  for (const d of bom.dependencies ?? []) if (d.ref) edges.set(d.ref, d.dependsOn ?? [])
  const prev = new Map<string, string>()
  const queue = [root]
  const seen = new Set([root])
  while (queue.length) {
    const cur = queue.shift()!
    if (cur === ref) break
    for (const n of edges.get(cur) ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      prev.set(n, cur)
      queue.push(n)
    }
  }
  if (!seen.has(ref)) return undefined
  const path = [ref]
  while (path[0] !== root) path.unshift(prev.get(path[0])!)
  const byRef = new Map((bom.components ?? []).map((c) => [c['bom-ref'], c]))
  const label = (r: string) => {
    const c = r === root ? bom.metadata?.component : byRef.get(r)
    return c?.name ? `${c.group ? `${c.group}/` : ''}${c.name}${c.version ? `@${c.version}` : ''}` : r
  }
  return path.map(label)
}

export function buildLicenses(sboms: TrivyReportObj[], projects: string[], policy: Pick<ScanPolicy, 'licenseDeny' | 'licenseWarn'> | undefined): { rows: LicenseRow[]; apps: AppLicenses[] } {
  const rows = new Map<string, { risk: LicenseRisk; pkgs: Map<string, LicensePackage>; apps: Set<string> }>()
  const apps: AppLicenses[] = []
  for (const r of sboms) {
    const bom = r.report?.components
    if (!bom) continue
    const ns = r.metadata.namespace ?? ''
    const place = placeNamespace(ns, projects)
    const app = workloadOf(r.metadata.labels).name ?? r.metadata.name
    const appKey = `${place.project ?? ns}/${app}`
    const per: AppLicenses = { app, namespace: ns, ...place, image: imageOf(r).image, components: 0, byRisk: { deny: 0, warn: 0, ok: 0, unknown: 0 } }
    for (const c of bom.components ?? []) {
      if (c.type === 'operating-system') continue
      per.components++
      const ls = licensesOf(c)
      const list = ls.length ? ls : ['']
      for (const l of list) {
        const risk = licenseRisk(l, policy)
        per.byRisk[risk]++
        const row = rows.get(l) ?? { risk, pkgs: new Map(), apps: new Set() }
        row.apps.add(appKey)
        const pk = `${c.name}@${c.version ?? ''}`
        const p = row.pkgs.get(pk) ?? { name: `${c.group ? `${c.group}/` : ''}${c.name ?? '?'}`, version: c.version, purl: c.purl, apps: [] }
        if (!p.apps.includes(appKey)) p.apps.push(appKey)
        if (!p.path && risk !== 'ok' && c['bom-ref']) p.path = componentPath(bom, c['bom-ref'])
        row.pkgs.set(pk, p)
        rows.set(l, row)
      }
    }
    apps.push(per)
  }
  const order: Record<LicenseRisk, number> = { deny: 0, warn: 1, unknown: 2, ok: 3 }
  return {
    rows: [...rows.entries()]
      .map(([license, r]) => ({ license, risk: r.risk, packages: [...r.pkgs.values()].sort((a, b) => a.name.localeCompare(b.name)), apps: [...r.apps].sort() }))
      .sort((a, b) => order[a.risk] - order[b.risk] || b.packages.length - a.packages.length || a.license.localeCompare(b.license)),
    apps: apps.sort((a, b) => b.byRisk.deny - a.byRisk.deny || b.byRisk.warn - a.byRisk.warn || a.app.localeCompare(b.app)),
  }
}

/** Is a license finding waived for this app? */
export function licenseWaived(waivers: Waiver[], license: string, project: string | undefined, app: string | undefined, now: number): Waiver | undefined {
  return waivers.find((w) =>
    w.kind === 'license' && norm(w.findingId) === norm(license) && isActiveWaiver(w, now) &&
    (w.scope === 'platform' || (w.target.project === project && (w.scope === 'project' || w.target.app === app)))
  )
}

/* ───────────────────────────── CI ───────────────────────────── */

/** The newest run that published scan results, per app (runs arrive newest first). */
export function latestCiScans(gates: GateView[]): GateView[] {
  const seen = new Map<string, GateView>()
  for (const g of gates) {
    if (!g.summary && g.state === 'none') continue
    const k = `${g.namespace}/${g.app ?? g.pipeline ?? g.name}`
    if (!seen.has(k)) seen.set(k, g)
  }
  return [...seen.values()]
}

/** Count change between two summaries (`after − before`), only where both report the count. */
export function summaryDiff(before: ScanSummary | undefined, after: ScanSummary | undefined): Partial<Record<keyof ScanSummary, number>> {
  const out: Partial<Record<keyof ScanSummary, number>> = {}
  if (!before || !after) return out
  for (const k of Object.keys(after) as Array<keyof ScanSummary>) {
    const a = after[k]
    const b = before[k]
    if (typeof a === 'number' && typeof b === 'number' && a !== b) out[k] = a - b
  }
  return out
}

/** The run before this one for the same app, for a "what changed" diff. */
export function previousRun(gates: GateView[], g: GateView): GateView | undefined {
  const key = (x: GateView) => `${x.namespace}/${x.app ?? x.pipeline ?? ''}`
  return gates.find((x) => x !== g && key(x) === key(g) && x.summary && (x.createdAt ?? '') < (g.createdAt ?? ''))
}

/* ───────────────────────────── review & export ───────────────────────────── */

/** SLA ageing of a pending request: fresh < 2 days ≤ ageing < 5 days ≤ overdue. */
export function slaOf(requestedAt: string, now: number): { days: number; tone: 'fresh' | 'ageing' | 'overdue' } {
  const days = Math.floor((now - Date.parse(requestedAt)) / 86_400_000)
  return { days, tone: days >= 5 ? 'overdue' : days >= 2 ? 'ageing' : 'fresh' }
}

/** Pending requests that ask for the same thing — reviewable as one decision. */
export function groupIdentical(ws: Waiver[]): Array<{ key: string; items: Waiver[] }> {
  const groups = new Map<string, Waiver[]>()
  for (const w of ws) {
    const k = [w.kind, w.findingId, w.target.package ?? '', w.scope, w.vex.status, w.vex.justification ?? ''].join('|')
    groups.set(k, [...(groups.get(k) ?? []), w])
  }
  return [...groups.entries()].map(([key, items]) => ({ key, items }))
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  // Spreadsheet formula injection: a leading = + - @ is neutralised.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function waiversCsv(ws: Waiver[]): string {
  const head = ['id', 'status', 'kind', 'scope', 'finding', 'severity', 'project', 'app', 'digest', 'package', 'vex_status', 'vex_justification', 'justification', 'requested_by', 'requested_at', 'approved_by', 'approved_at', 'expires_at']
  const rows = ws.map((w) => [
    w.id, w.status, w.kind, w.scope, w.findingId, w.severity ?? '', w.target.project, w.target.app ?? '', w.target.digest ?? '', w.target.package ?? '',
    w.vex.status, w.vex.justification ?? '', w.justification, w.requestedBy.label, w.requestedAt, w.approvedBy?.label ?? '', w.approvedAt ?? '', w.expiresAt,
  ])
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

/** ISO week start (Monday, UTC) of a timestamp, `YYYY-MM-DD`. */
export function weekOf(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}
