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

function build(http: HttpClient): TrivyClient {
  return {
    listReports: async (filter) => {
      const qs = new URLSearchParams()
      if (filter?.target) qs.set('target', filter.target)
      if (filter?.namespace) qs.set('namespace', filter.namespace)
      const res = await http.get<{ items: ScanReport[] }>(`/api/v1/trivy/reports?${qs}`)
      return res.items
    },
    getReport: (id) => http.get<ScanReport>(`/api/v1/trivy/reports/${id}`),
    rescan: async (id) => {
      await http.post<void>(`/api/v1/trivy/reports/${id}/rescan`, {})
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
    artifact: 'harbor.adhar.local/acme/adhar-console:v0.4.2',
    workload: 'Deployment/adhar-console',
    namespace: 'acme-console',
    scanner: 'trivy 0.55.0',
    scanned_at: ts,
    summary: { critical: 1, high: 4, medium: 11, low: 23 },
    vulnerabilities: SEED_VULNS,
  },
  {
    id: 'tr-billing-prod',
    target: 'image',
    artifact: 'harbor.adhar.local/acme/billing-service:v1.2.0',
    workload: 'Deployment/billing-service',
    namespace: 'acme-billing',
    scanner: 'trivy 0.55.0',
    scanned_at: '2026-04-22T10:30:00Z',
    summary: { critical: 0, high: 2, medium: 6, low: 18 },
    vulnerabilities: SEED_VULNS.slice(1),
  },
  {
    id: 'tr-portal-stg',
    target: 'image',
    artifact: 'harbor.adhar.local/acme/customer-portal:v2.4.0',
    workload: 'Deployment/customer-portal',
    namespace: 'acme-portal-staging',
    scanner: 'trivy 0.55.0',
    scanned_at: '2026-04-23T08:11:00Z',
    summary: { critical: 0, high: 0, medium: 3, low: 9 },
  },
  {
    id: 'tr-bff-prod',
    target: 'image',
    artifact: 'harbor.adhar.local/acme/platform-bff:v0.6.1',
    workload: 'Deployment/platform-bff',
    namespace: 'acme-platform',
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
    namespace: 'acme-portal',
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
    namespace: 'acme-platform',
    scanner: 'trivy 0.55.0',
    scanned_at: '2026-04-22T14:22:00Z',
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
  },
  {
    id: 'tr-rbac-platform',
    target: 'rbac',
    artifact: 'ServiceAccount/platform-bff',
    namespace: 'acme-platform',
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
