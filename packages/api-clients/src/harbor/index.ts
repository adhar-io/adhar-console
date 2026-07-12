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
  tags: z.array(z.object({ name: z.string() })).optional(),
  size: z.number(),
  push_time: z.string(),
  vulnerabilities: z
    .object({ critical: z.number(), high: z.number(), medium: z.number(), low: z.number() })
    .optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export interface HarborClient {
  listRepositories(project: string): Promise<Repository[]>
  listArtifacts(project: string, repo: string): Promise<Artifact[]>
}

function build(http: HttpClient): HarborClient {
  return {
    listRepositories: (p) => http.get<Repository[]>(`/api/v2.0/projects/${p}/repositories`),
    listArtifacts: (p, r) =>
      http.get<Artifact[]>(`/api/v2.0/projects/${p}/repositories/${r}/artifacts`),
  }
}

const STUB_REPOS: Repository[] = [
  {
    id: 1,
    project_id: 1,
    name: 'acme/adhar-console',
    pull_count: 142,
    artifact_count: 18,
    update_time: '2026-04-23T18:14:00Z',
  },
  {
    id: 2,
    project_id: 1,
    name: 'acme/billing-service',
    pull_count: 89,
    artifact_count: 12,
    update_time: '2026-04-22T10:30:00Z',
  },
  {
    id: 3,
    project_id: 1,
    name: 'acme/customer-portal',
    pull_count: 64,
    artifact_count: 7,
    update_time: '2026-04-23T08:11:00Z',
  },
  {
    id: 4,
    project_id: 1,
    name: 'acme/platform-bff',
    pull_count: 211,
    artifact_count: 22,
    update_time: '2026-04-23T18:14:00Z',
  },
]

const STUB_ARTIFACTS: Record<string, Artifact[]> = {
  'acme/adhar-console': [
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
  'acme/billing-service': [
    {
      digest: 'sha256:bbcc11223344556677',
      tags: [{ name: 'v1.2.0' }, { name: 'latest' }],
      size: 64_220_000,
      push_time: '2026-04-22T10:30:00Z',
      vulnerabilities: { critical: 0, high: 2, medium: 6, low: 18 },
    },
  ],
  'acme/customer-portal': [
    {
      digest: 'sha256:ccdd11223344556677',
      tags: [{ name: 'v2.4.0' }, { name: 'latest' }],
      size: 90_120_000,
      push_time: '2026-04-23T08:11:00Z',
      vulnerabilities: { critical: 0, high: 0, medium: 3, low: 9 },
    },
  ],
  'acme/platform-bff': [
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
  listRepositories: async () => STUB_REPOS,
  listArtifacts: async (_p, repo) => STUB_ARTIFACTS[repo] ?? [],
}))
