import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

export const RepositorySchema = z.object({
  id: z.number(),
  project_id: z.number(),
  name: z.string(),
  pull_count: z.number(),
  artifact_count: z.number(),
  update_time: z.string(),
})
export type Repository = z.infer<typeof RepositorySchema>

export const ArtifactSchema = z.object({
  digest: z.string(),
  tags: z.array(z.object({ name: z.string(), push_time: z.string().optional(), immutable: z.boolean().optional() })).optional(),
  size: z.number(),
  push_time: z.string(),
  pull_time: z.string().optional(),
  /** `IMAGE`, `CHART`, `SBOM`, … */
  type: z.string().optional(),
  media_type: z.string().optional(),
  /** From the manifest config — `linux/amd64`, `linux/arm64`, … */
  platform: z.string().optional(),
  labels: z.array(z.object({ name: z.string(), color: z.string().optional() })).optional(),
  vulnerabilities: z
    .object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number() })
    .optional(),
  /** Scanner verdict for this artifact (absent = never scanned). */
  scan: z
    .object({
      status: z.string(),
      scanner: z.string().optional(),
      endTime: z.string().optional(),
      total: z.number().optional(),
      fixable: z.number().optional(),
    })
    .optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export interface Project {
  id: number
  name: string
  public: boolean
  repoCount: number
  /** Bytes used / quota (quota -1 = unlimited). */
  storageUsed?: number
  storageQuota?: number
  createdAt?: string
}

export interface Vulnerability {
  id: string
  severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Negligible' | 'Unknown'
  package: string
  version: string
  fixVersion?: string
  description?: string
  links: string[]
  cvssScore?: number
}

export interface HarborClient {
  listProjects(): Promise<Project[]>
  listRepositories(project: string): Promise<Repository[]>
  listArtifacts(project: string, repo: string): Promise<Artifact[]>
  /** Full vulnerability report for one artifact (`ref` = digest or tag). */
  listVulnerabilities(project: string, repo: string, ref: string): Promise<Vulnerability[]>
  scanArtifact(project: string, repo: string, ref: string): Promise<void>
  deleteArtifact(project: string, repo: string, ref: string): Promise<void>
  addTag(project: string, repo: string, ref: string, tag: string): Promise<void>
  deleteTag(project: string, repo: string, ref: string, tag: string): Promise<void>
  /** External registry hostname for `docker pull` commands. */
  registryHost(): Promise<string>
}

interface RawArtifact {
  digest: string
  tags?: Array<{ name: string; push_time?: string; immutable?: boolean }>
  size: number
  push_time: string
  pull_time?: string
  type?: string
  media_type?: string
  extra_attrs?: { os?: string; architecture?: string; variant?: string }
  labels?: Array<{ name: string; color?: string }>
  scan_overview?: Record<
    string,
    {
      scan_status?: string
      scanner?: { name?: string; version?: string }
      end_time?: string
      summary?: { total?: number; fixable?: number; summary?: Record<string, number> }
    }
  >
}

function withScan(a: RawArtifact): Artifact {
  const scan = a.scan_overview ? Object.values(a.scan_overview)[0] : undefined
  const ov = scan?.summary?.summary
  const os = a.extra_attrs?.os
  const arch = a.extra_attrs?.architecture
  return {
    digest: a.digest,
    tags: a.tags,
    size: a.size,
    push_time: a.push_time,
    pull_time: a.pull_time,
    type: a.type,
    media_type: a.media_type,
    platform: os || arch ? [os, arch, a.extra_attrs?.variant].filter(Boolean).join('/') : undefined,
    labels: a.labels,
    vulnerabilities: ov
      ? { critical: ov.Critical ?? 0, high: ov.High ?? 0, medium: ov.Medium ?? 0, low: ov.Low ?? 0 }
      : undefined,
    scan: scan?.scan_status
      ? {
          status: scan.scan_status,
          scanner: scan.scanner?.name ? `${scan.scanner.name}${scan.scanner.version ? ` ${scan.scanner.version}` : ''}` : undefined,
          endTime: scan.end_time,
          total: scan.summary?.total,
          fixable: scan.summary?.fixable,
        }
      : undefined,
  }
}

interface RawProject {
  project_id: number
  name: string
  repo_count?: number
  creation_time?: string
  metadata?: { public?: string }
}

interface RawVulnReport {
  vulnerabilities?: Array<{
    id: string
    severity?: string
    package?: string
    version?: string
    fix_version?: string
    description?: string
    links?: string[]
    preferred_cvss?: { score_v3?: number; score_v2?: number }
  }>
}

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Negligible'] as const

/** Harbor wants the repo path double-encoded when it contains slashes. */
const repoRef = (p: string, r: string) => `/api/v2.0/projects/${encodeURIComponent(p)}/repositories/${encodeURIComponent(encodeURIComponent(r))}`

function build(http: HttpClient): HarborClient {
  return {
    listProjects: async () => {
      const projects = await http.get<RawProject[]>('/api/v2.0/projects?page_size=100&with_detail=true')
      // Quota + usage come from the per-project summary; missing (403 on a
      // project the credential can list but not read) is reported as unknown.
      return Promise.all(
        projects.map(async (p): Promise<Project> => {
          let storageUsed: number | undefined
          let storageQuota: number | undefined
          let repoCount = p.repo_count ?? 0
          try {
            const s = await http.get<{ repo_count?: number; quota?: { hard?: { storage?: number }; used?: { storage?: number } } }>(
              `/api/v2.0/projects/${p.project_id}/summary`,
            )
            repoCount = s.repo_count ?? repoCount
            storageUsed = s.quota?.used?.storage
            storageQuota = s.quota?.hard?.storage
          } catch {
            /* summary not readable — keep the list values */
          }
          return { id: p.project_id, name: p.name, public: p.metadata?.public === 'true', repoCount, storageUsed, storageQuota, createdAt: p.creation_time }
        }),
      )
    },
    // The configured project first; when it doesn't exist (404) or is empty,
    // list every repository the credential can see (Harbor ≥ 2.1 global
    // endpoint) so the registry page reflects the whole instance.
    listRepositories: async (p) => {
      if (p) {
        try {
          const mine = await http.get<Repository[]>(`/api/v2.0/projects/${encodeURIComponent(p)}/repositories?page_size=100&sort=-update_time`)
          if (mine.length) return mine
        } catch (e) {
          const status = (e as { status?: number }).status
          if (status !== 404 && status !== 403) throw e
        }
      }
      return http.get<Repository[]>(`/api/v2.0/repositories?page_size=100&sort=-update_time`)
    },
    listArtifacts: async (p, r) => {
      const list = await http.get<RawArtifact[]>(
        `${repoRef(p, r)}/artifacts?page_size=100&with_tag=true&with_scan_overview=true&with_label=true&sort=-push_time`,
      )
      return list.map(withScan)
    },
    listVulnerabilities: async (p, r, ref) => {
      const report = await http.get<Record<string, RawVulnReport>>(`${repoRef(p, r)}/artifacts/${encodeURIComponent(ref)}/additions/vulnerabilities`)
      const first = Object.values(report ?? {})[0]
      return (first?.vulnerabilities ?? [])
        .map((v): Vulnerability => ({
          id: v.id,
          severity: (SEVERITIES as readonly string[]).includes(v.severity ?? '') ? (v.severity as Vulnerability['severity']) : 'Unknown',
          package: v.package ?? '',
          version: v.version ?? '',
          fixVersion: v.fix_version || undefined,
          description: v.description,
          links: v.links ?? [],
          cvssScore: v.preferred_cvss?.score_v3 ?? v.preferred_cvss?.score_v2,
        }))
        .sort((a, b) => SEVERITIES.indexOf(a.severity as never) - SEVERITIES.indexOf(b.severity as never))
    },
    scanArtifact: async (p, r, ref) => {
      await http.post<void>(`${repoRef(p, r)}/artifacts/${encodeURIComponent(ref)}/scan`, {})
    },
    deleteArtifact: async (p, r, ref) => {
      await http.delete<void>(`${repoRef(p, r)}/artifacts/${encodeURIComponent(ref)}`)
    },
    addTag: async (p, r, ref, tag) => {
      await http.post<void>(`${repoRef(p, r)}/artifacts/${encodeURIComponent(ref)}/tags`, { name: tag })
    },
    deleteTag: async (p, r, ref, tag) => {
      await http.delete<void>(`${repoRef(p, r)}/artifacts/${encodeURIComponent(ref)}/tags/${encodeURIComponent(tag)}`)
    },
    registryHost: async () => {
      try {
        const info = await http.get<{ registry_url?: string; external_url?: string }>('/api/v2.0/systeminfo')
        return info.registry_url ?? info.external_url?.replace(/^https?:\/\//, '') ?? ''
      } catch {
        return ''
      }
    },
  }
}

const STUB_REPOS: Repository[] = [
  {
    id: 1,
    project_id: 1,
    name: 'adhar/adhar-console',
    pull_count: 142,
    artifact_count: 18,
    update_time: '2026-04-23T18:14:00Z',
  },
  {
    id: 2,
    project_id: 1,
    name: 'adhar/billing-service',
    pull_count: 89,
    artifact_count: 12,
    update_time: '2026-04-22T10:30:00Z',
  },
  {
    id: 3,
    project_id: 1,
    name: 'adhar/customer-portal',
    pull_count: 64,
    artifact_count: 7,
    update_time: '2026-04-23T08:11:00Z',
  },
  {
    id: 4,
    project_id: 1,
    name: 'adhar/platform-bff',
    pull_count: 211,
    artifact_count: 22,
    update_time: '2026-04-23T18:14:00Z',
  },
]

const STUB_ARTIFACTS: Record<string, Artifact[]> = {
  'adhar/adhar-console': [
    {
      digest: 'sha256:abc123def4567890',
      tags: [{ name: 'v0.4.2' }, { name: 'latest' }],
      size: 82_345_123,
      push_time: '2026-04-23T18:14:00Z',
      vulnerabilities: { critical: 1, high: 4, medium: 11, low: 23 },
    },
    {
      digest: 'sha256:def4567890abc123',
      tags: [{ name: 'v0.4.1' }],
      size: 81_120_000,
      push_time: '2026-04-21T11:00:00Z',
      vulnerabilities: { critical: 1, high: 5, medium: 12, low: 24 },
    },
    {
      digest: 'sha256:7890abc123def456',
      tags: [{ name: 'v0.4.0' }],
      size: 80_998_000,
      push_time: '2026-04-18T09:42:00Z',
      vulnerabilities: { critical: 2, high: 7, medium: 14, low: 26 },
    },
  ],
  'adhar/billing-service': [
    {
      digest: 'sha256:bbcc11223344556677',
      tags: [{ name: 'v1.2.0' }, { name: 'latest' }],
      size: 64_220_000,
      push_time: '2026-04-22T10:30:00Z',
      vulnerabilities: { critical: 0, high: 2, medium: 6, low: 18 },
    },
  ],
  'adhar/customer-portal': [
    {
      digest: 'sha256:ccdd11223344556677',
      tags: [{ name: 'v2.4.0' }, { name: 'latest' }],
      size: 90_120_000,
      push_time: '2026-04-23T08:11:00Z',
      vulnerabilities: { critical: 0, high: 0, medium: 3, low: 9 },
    },
  ],
  'adhar/platform-bff': [
    {
      digest: 'sha256:ee9988776655443322',
      tags: [{ name: 'v0.6.1' }, { name: 'latest' }],
      size: 38_440_000,
      push_time: '2026-04-23T18:14:00Z',
      vulnerabilities: { critical: 2, high: 6, medium: 14, low: 31 },
    },
  ],
}

export const HarborClient = defineClient<HarborClient>(build, () => ({
  listProjects: async () => [{ id: 1, name: 'adhar', public: false, repoCount: STUB_REPOS.length, storageUsed: 4_200_000_000, storageQuota: 53_687_091_200, createdAt: '2026-04-01T00:00:00Z' }],
  listRepositories: async () => STUB_REPOS,
  listArtifacts: async (_p, repo) => STUB_ARTIFACTS[repo] ?? [],
  listVulnerabilities: async () => [
    { id: 'CVE-2026-1001', severity: 'Critical', package: 'openssl', version: '3.0.2', fixVersion: '3.0.14', description: 'Stub finding.', links: [], cvssScore: 9.8 },
    { id: 'CVE-2026-2002', severity: 'High', package: 'zlib', version: '1.2.11', fixVersion: '1.2.13', description: 'Stub finding.', links: [], cvssScore: 7.5 },
  ],
  scanArtifact: async () => {},
  deleteArtifact: async () => {},
  addTag: async () => {},
  deleteTag: async () => {},
  registryHost: async () => 'harbor.adhar.local',
}))
