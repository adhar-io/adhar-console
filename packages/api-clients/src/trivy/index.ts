import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Trivy operator API client.
 *
 * In a real cluster the Trivy Operator publishes scan reports as
 * `aquasecurity.github.io` CRDs (VulnerabilityReport, ConfigAuditReport,
 * ExposedSecretReport, RbacAssessmentReport, ClusterComplianceReport, …).
 * Here we expose a flat HTTP shape — the BFF aggregates the CRDs into
 * one feed for the console.
 */

export const SeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'])
export type Severity = z.infer<typeof SeveritySchema>

export const ScanTargetSchema = z.enum(['image', 'config', 'secret', 'rbac', 'compliance'])
export type ScanTarget = z.infer<typeof ScanTargetSchema>

export const VulnerabilitySchema = z.object({
  vulnerability_id: z.string(),
  resource: z.string(),
  installed_version: z.string().optional(),
  fixed_version: z.string().optional(),
  severity: SeveritySchema,
  title: z.string(),
  description: z.string().optional(),
  cvss_score: z.number().optional(),
  primary_link: z.string().optional(),
  published_date: z.string().optional(),
})
export type Vulnerability = z.infer<typeof VulnerabilitySchema>

export const ScanReportSchema = z.object({
  id: z.string(),
  target: ScanTargetSchema,
  /** image:tag for image scans, namespace/kind/name for config audits, etc. */
  artifact: z.string(),
  workload: z.string().optional(),
  namespace: z.string().optional(),
  scanner: z.string(),
  scanned_at: z.string(),
  summary: z.object({
    critical: z.number(),
    high: z.number(),
    medium: z.number(),
    low: z.number(),
    unknown: z.number().optional(),
  }),
  /** First N vulnerabilities — full list comes from `getReport`. */
  vulnerabilities: z.array(VulnerabilitySchema).optional(),
})
export type ScanReport = z.infer<typeof ScanReportSchema>

export interface TrivyClient {
  listReports(filter?: { target?: ScanTarget; namespace?: string }): Promise<ScanReport[]>
  getReport(id: string): Promise<ScanReport>
  rescan(id: string): Promise<void>
}

/* ─────────── trivy-operator CRDs (aquasecurity.github.io/v1alpha1) ─────────── */

const API = '/apis/aquasecurity.github.io/v1alpha1'

/** report resource → console scan target */
const FAMILIES: Array<{ resource: string; kind: string; target: ScanTarget }> = [
  { resource: 'vulnerabilityreports', kind: 'VulnerabilityReport', target: 'image' },
  { resource: 'configauditreports', kind: 'ConfigAuditReport', target: 'config' },
  { resource: 'exposedsecretreports', kind: 'ExposedSecretReport', target: 'secret' },
  { resource: 'rbacassessmentreports', kind: 'RbacAssessmentReport', target: 'rbac' },
  { resource: 'clustercompliancereports', kind: 'ClusterComplianceReport', target: 'compliance' },
]

interface RawReport {
  metadata: { name: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> }
  report?: {
    updateTimestamp?: string
    scanner?: { name?: string; vendor?: string; version?: string }
    artifact?: { repository?: string; tag?: string; digest?: string }
    registry?: { server?: string }
    summary?: Record<string, number | undefined>
    vulnerabilities?: Array<{
      vulnerabilityID?: string
      resource?: string
      installedVersion?: string
      fixedVersion?: string
      severity?: string
      title?: string
      description?: string
      score?: number
      primaryLink?: string
      publishedDate?: string
    }>
    checks?: Array<{ checkID?: string; title?: string; severity?: string; success?: boolean; description?: string; messages?: string[]; category?: string }>
    secrets?: Array<{ ruleID?: string; title?: string; severity?: string; category?: string; target?: string; match?: string }>
  }
}

function sev(s?: string): Severity {
  const u = (s ?? '').toUpperCase()
  return u === 'CRITICAL' || u === 'HIGH' || u === 'MEDIUM' || u === 'LOW' ? u : 'UNKNOWN'
}

function encodeId(ns: string | undefined, resource: string, name: string): string {
  return `${ns ?? '-'}/${resource}/${name}`
}
function decodeId(id: string): { ns?: string; resource: string; name: string } | null {
  const [ns, resource, ...rest] = id.split('/')
  if (!resource || !rest.length) return null
  return { ns: ns === '-' ? undefined : ns, resource, name: rest.join('/') }
}

function toReport(raw: RawReport, fam: (typeof FAMILIES)[number], withDetail: boolean): ScanReport {
  const r = raw.report ?? {}
  const l = raw.metadata.labels ?? {}
  const kind = l['trivy-operator.resource.kind']
  const wname = l['trivy-operator.resource.name']
  const container = l['trivy-operator.container.name']
  const workload = kind && wname ? `${kind}/${wname}${container ? ` · ${container}` : ''}` : undefined
  const artifact =
    fam.target === 'image'
      ? `${r.registry?.server ? `${r.registry.server}/` : ''}${r.artifact?.repository ?? raw.metadata.name}${r.artifact?.tag ? `:${r.artifact.tag}` : r.artifact?.digest ? `@${r.artifact.digest.slice(0, 19)}` : ''}`
      : workload
        ? `${raw.metadata.namespace ?? 'cluster'}/${workload}`
        : raw.metadata.name
  const sum = r.summary ?? {}
  const vulns: Vulnerability[] = []
  if (withDetail) {
    for (const v of r.vulnerabilities ?? []) {
      vulns.push({
        vulnerability_id: v.vulnerabilityID ?? 'unknown',
        resource: v.resource ?? '',
        installed_version: v.installedVersion,
        fixed_version: v.fixedVersion,
        severity: sev(v.severity),
        title: v.title ?? v.vulnerabilityID ?? 'Vulnerability',
        description: v.description,
        cvss_score: v.score,
        primary_link: v.primaryLink,
        published_date: v.publishedDate,
      })
    }
    for (const c of r.checks ?? []) {
      if (c.success) continue
      vulns.push({ vulnerability_id: c.checkID ?? 'check', resource: c.category ?? 'config', severity: sev(c.severity), title: c.title ?? c.checkID ?? 'Check failed', description: [c.description, ...(c.messages ?? [])].filter(Boolean).join(' ') })
    }
    for (const x of r.secrets ?? []) {
      vulns.push({ vulnerability_id: x.ruleID ?? 'secret', resource: x.target ?? x.category ?? 'secret', severity: sev(x.severity), title: x.title ?? 'Exposed secret', description: x.match })
    }
  }
  return {
    id: encodeId(raw.metadata.namespace, fam.resource, raw.metadata.name),
    target: fam.target,
    artifact,
    workload,
    namespace: raw.metadata.namespace,
    scanner: [r.scanner?.name ?? 'Trivy', r.scanner?.version].filter(Boolean).join(' '),
    scanned_at: r.updateTimestamp ?? raw.metadata.creationTimestamp ?? new Date(0).toISOString(),
    summary: {
      critical: sum.criticalCount ?? 0,
      high: sum.highCount ?? 0,
      medium: sum.mediumCount ?? 0,
      low: sum.lowCount ?? 0,
      unknown: sum.unknownCount ?? sum.noneCount ?? 0,
    },
    vulnerabilities: withDetail ? vulns.slice(0, 500) : undefined,
  }
}

function build(_http: HttpClient): TrivyClient {
  // Reports are CRDs written by trivy-operator — read them through the k8s
  // gateway (user RBAC). A missing CRD family (404) is simply skipped.
  const k8s = new HttpClient({ baseUrl: '/api/k8s', credentials: 'include' })
  return {
    listReports: async (filter) => {
      const fams = FAMILIES.filter((f) => !filter?.target || f.target === filter.target)
      const pages = await Promise.all(
        fams.map(async (fam) => {
          const ns = filter?.namespace && fam.target !== 'compliance' ? `/namespaces/${encodeURIComponent(filter.namespace)}` : ''
          try {
            const res = await k8s.get<{ items: RawReport[] }>(`${API}${ns}/${fam.resource}?limit=500`)
            return (res.items ?? []).map((r) => toReport(r, fam, false))
          } catch (e) {
            const status = (e as { status?: number }).status
            if (status === 404 || status === 403) return []
            throw e
          }
        }),
      )
      return pages.flat().sort((a, b) => b.summary.critical * 1000 + b.summary.high * 50 - (a.summary.critical * 1000 + a.summary.high * 50) || b.scanned_at.localeCompare(a.scanned_at))
    },
    getReport: async (id) => {
      const d = decodeId(id)
      if (!d) throw new Error(`invalid report id ${id}`)
      const fam = FAMILIES.find((f) => f.resource === d.resource) ?? FAMILIES[0]
      const raw = await k8s.get<RawReport>(`${API}${d.ns ? `/namespaces/${encodeURIComponent(d.ns)}` : ''}/${d.resource}/${encodeURIComponent(d.name)}`)
      return toReport(raw, fam, true)
    },
    // trivy-operator re-creates a deleted report on its next reconcile — that IS the rescan.
    rescan: async (id) => {
      const d = decodeId(id)
      if (!d) throw new Error(`invalid report id ${id}`)
      await k8s.delete<unknown>(`${API}${d.ns ? `/namespaces/${encodeURIComponent(d.ns)}` : ''}/${d.resource}/${encodeURIComponent(d.name)}`)
    },
  }
}

const ts = '2026-04-23T18:14:00Z'

const SEED_VULNS: Vulnerability[] = [
  {
    vulnerability_id: 'CVE-2024-21538',
    resource: 'cross-spawn',
    installed_version: '7.0.3',
    fixed_version: '7.0.5',
    severity: 'HIGH',
    title: 'Regular Expression Denial of Service in cross-spawn',
    description:
      'Versions of cross-spawn before 7.0.5 are vulnerable to ReDoS via crafted command arguments.',
    cvss_score: 7.5,
    primary_link: 'https://nvd.nist.gov/vuln/detail/CVE-2024-21538',
    published_date: '2024-11-08T00:00:00Z',
  },
  {
    vulnerability_id: 'CVE-2024-39338',
    resource: 'axios',
    installed_version: '1.7.2',
    fixed_version: '1.7.4',
    severity: 'HIGH',
    title: 'Axios SSRF via path-relative URL',
    cvss_score: 7.5,
  },
  {
    vulnerability_id: 'CVE-2024-4068',
    resource: 'braces',
    installed_version: '3.0.2',
    fixed_version: '3.0.3',
    severity: 'MEDIUM',
    title: 'Uncontrolled resource consumption in braces',
    cvss_score: 5.3,
  },
  {
    vulnerability_id: 'CVE-2025-1234',
    resource: 'node',
    installed_version: '20.10.0',
    fixed_version: '20.18.0',
    severity: 'CRITICAL',
    title: 'Heap overflow in Node.js TLS handshake',
    cvss_score: 9.1,
  },
]

const SEED_REPORTS: ScanReport[] = [
  {
    id: 'tr-console-prod',
    target: 'image',
    artifact: 'harbor.adhar.local/library/adhar-console:v0.4.2',
    workload: 'Deployment/adhar-console',
    namespace: 'demo-console',
    scanner: 'trivy 0.55.0',
    scanned_at: ts,
    summary: { critical: 1, high: 4, medium: 11, low: 23 },
    vulnerabilities: SEED_VULNS,
  },
  {
    id: 'tr-billing-prod',
    target: 'image',
    artifact: 'harbor.adhar.local/library/billing-service:v1.2.0',
    workload: 'Deployment/billing-service',
    namespace: 'demo-billing',
    scanner: 'trivy 0.55.0',
    scanned_at: '2026-04-22T10:30:00Z',
    summary: { critical: 0, high: 2, medium: 6, low: 18 },
    vulnerabilities: SEED_VULNS.slice(1),
  },
  {
    id: 'tr-portal-stg',
    target: 'image',
    artifact: 'harbor.adhar.local/library/customer-portal:v2.4.0',
    workload: 'Deployment/customer-portal',
    namespace: 'demo-portal-staging',
    scanner: 'trivy 0.55.0',
    scanned_at: '2026-04-23T08:11:00Z',
    summary: { critical: 0, high: 0, medium: 3, low: 9 },
  },
  {
    id: 'tr-bff-prod',
    target: 'image',
    artifact: 'harbor.adhar.local/library/platform-bff:v0.6.1',
    workload: 'Deployment/platform-bff',
    namespace: 'demo-platform',
    scanner: 'trivy 0.55.0',
    scanned_at: ts,
    summary: { critical: 2, high: 6, medium: 14, low: 31 },
    vulnerabilities: SEED_VULNS,
  },
  {
    id: 'tr-config-portal',
    target: 'config',
    artifact: 'Deployment/customer-portal',
    workload: 'Deployment/customer-portal',
    namespace: 'demo-portal',
    scanner: 'trivy 0.55.0',
    scanned_at: ts,
    summary: { critical: 0, high: 1, medium: 2, low: 4 },
    vulnerabilities: [
      {
        vulnerability_id: 'AVD-KSV-0014',
        resource: 'securityContext',
        severity: 'HIGH',
        title: 'Root file system is not read-only',
      },
      {
        vulnerability_id: 'AVD-KSV-0017',
        resource: 'securityContext',
        severity: 'MEDIUM',
        title: 'Container is privileged',
      },
    ],
  },
  {
    id: 'tr-secret-bff',
    target: 'secret',
    artifact: 'Deployment/platform-bff',
    workload: 'Deployment/platform-bff',
    namespace: 'demo-platform',
    scanner: 'trivy 0.55.0',
    scanned_at: '2026-04-22T14:22:00Z',
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
  },
  {
    id: 'tr-rbac-platform',
    target: 'rbac',
    artifact: 'ServiceAccount/platform-bff',
    namespace: 'demo-platform',
    scanner: 'trivy 0.55.0',
    scanned_at: ts,
    summary: { critical: 0, high: 1, medium: 2, low: 0 },
    vulnerabilities: [
      {
        vulnerability_id: 'AVD-RBAC-001',
        resource: 'cluster-admin',
        severity: 'HIGH',
        title: 'ServiceAccount has cluster-admin role',
      },
    ],
  },
  {
    id: 'tr-compliance-cis',
    target: 'compliance',
    artifact: 'cluster · CIS Kubernetes Benchmark v1.23',
    scanner: 'trivy 0.55.0',
    scanned_at: ts,
    summary: { critical: 0, high: 3, medium: 8, low: 12 },
  },
]

export const TrivyClient = defineClient<TrivyClient>(build, () => ({
  listReports: async (filter) => {
    let list = SEED_REPORTS
    if (filter?.target) list = list.filter((r) => r.target === filter.target)
    if (filter?.namespace) list = list.filter((r) => r.namespace === filter.namespace)
    return list
  },
  getReport: async (id) => {
    const r = SEED_REPORTS.find((x) => x.id === id)
    if (!r) throw new Error(`Stub: report ${id} not found`)
    return r
  },
  rescan: async () => {},
}))
